'use strict';

// This extension intentionally exposes only model-management operations. Trae
// account credentials remain inside the extension host and never cross HTTP.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const VERSION = '0.2.1';
const MAX_BODY = 1024 * 1024;
const ERROR_CODES = new Set(['unsupported-version', 'login-required', 'service-not-ready', 'custom-models-disabled', 'schema-incompatible']);
const emptyLogger = { info() {}, debug() {}, warn() {}, error() {}, trace() {} };
let disposal;

function canonical(value) { const full = fs.realpathSync(value); return process.platform === 'win32' ? full.toLowerCase() : full; }
function fail(message, outcome = 'not-applied', code) { return Object.assign(new Error(message), { outcome, code }); }
function deadline(promise, ms = 20000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Trae 响应超时；操作结果尚未确认。', 'unknown')), ms); })]).finally(() => clearTimeout(timer));
}

function safeModel(model) {
  // Never copy unknown fields: current/future backend replies may contain keys.
  const output = {};
  for (const name of ['custom_model_id', 'config_source', 'name', 'model_name', 'provider', 'is_custom', 'auth_type', 'base_url', 'display_name', 'status', 'multimodal', 'max_tokens', 'prompt_max_tokens', 'thinking_enable', 'reasoning_param', 'temperature', 'top_p', 'top_k', 'max_turn', 'updated_at', 'update_time', 'revision']) {
    if (['string', 'number', 'boolean'].includes(typeof model[name])) output[name] = model[name];
  }
  if (model.reasoning_param && typeof model.reasoning_param.parameter === 'string' && Array.isArray(model.reasoning_param.values) && model.reasoning_param.values.every(value => typeof value === 'string')) output.reasoning_param = { parameter: model.reasoning_param.parameter, values: model.reasoning_param.values };
  return output;
}

function configuration(input) {
  const providers = ['custom_openai_compatible', 'custom_anthropic_compatible', 'custom_responses_compatible'];
  if (!input || !providers.includes(input.provider) || typeof input.model_name !== 'string' || !input.model_name || input.model_name.length > 256 || typeof input.ak !== 'string' || input.ak.length > 32768 || typeof input.base_url !== 'string' || typeof input.display_name !== 'string' || input.display_name.length > 256) throw fail('模型配置格式无效。');
  let url;
  try { url = new URL(input.base_url); } catch { throw fail('模型地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw fail('模型地址格式不受支持。');
  const params = input.config_detail?.model_hyper_params || {};
  const hyper = {};
  for (const name of ['max_tokens', 'prompt_max_tokens', 'thinking_enable', 'temperature', 'top_p', 'top_k']) {
    if (params[name] !== undefined) {
      if (typeof params[name] !== 'number' || !Number.isFinite(params[name])) throw fail('模型参数无效。');
      hyper[name] = params[name];
    }
  }
  if (params.reasoning_param !== undefined) {
    const value = params.reasoning_param;
    if (typeof value.parameter !== 'string' || !Array.isArray(value.values) || value.values.some(item => typeof item !== 'string')) throw fail('推理参数无效。');
    hyper.reasoning_param = { parameter: value.parameter, values: value.values };
  }
  return { provider: input.provider, model_name: input.model_name, is_custom: true, ak: input.ak, isAkFromServer: false, auth_type: 0, base_url: input.base_url, display_name: input.display_name, clearReasoningParam: input.clearReasoningParam === true, config_detail: { multimodal: input.config_detail?.multimodal === true, model_hyper_params: hyper } };
}

function matches(model, config) {
  if (model.provider !== config.provider || model.name !== `${config.provider}//${config.model_name}` || model.base_url !== config.base_url || model.display_name !== config.display_name || model.auth_type !== config.auth_type || model.multimodal !== config.config_detail.multimodal || model.status !== true) return false;
  return Object.entries(config.config_detail.model_hyper_params).every(([key, value]) => JSON.stringify(model[key]) === JSON.stringify(value));
}

exports.activate = async context => {
  const storage = context.globalStorageUri.fsPath;
  const userMarker = `${path.sep}User${path.sep}`;
  const markerAt = storage.toLowerCase().lastIndexOf(userMarker.toLowerCase());
  if (markerAt < 0) return;
  const userDataPath = canonical(storage.slice(0, markerAt));
  // Custom profiles cannot silently alias the default profile.
  if (storage.slice(markerAt + userMarker.length).toLowerCase().startsWith('profiles' + path.sep)) return;
  const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
  if (!/trae/i.test(product.nameLong || product.nameShort || '')) return;
  const token = crypto.randomBytes(32).toString('hex');
  const nonces = new Map();
  const sessionId = crypto.randomUUID();
  let rpc, ipc, connectedAt = 0;
  async function connect() {
    if (rpc) return;
    const { ahaIpc } = require('electron');
    if (typeof ahaIpc?.connect !== 'function') throw fail('此 Trae 版本没有可用的本机模型连接接口。', 'not-applied', 'unsupported-version');
    const { Connection } = require(path.join(vscode.env.appRoot, 'node_modules/@aha-kit/rpc/dist/index.cjs'));
    ipc = ahaIpc.connect('ai-agent');
    rpc = new Connection({ send: data => ipc.send(data), onData: listener => { ipc.on('message', listener); return { dispose: () => ipc.off('message', listener) }; } }, { logger: emptyLogger });
    rpc.onError(() => {});
    connectedAt = Date.now();
  }
  async function invoke(service, method, data) {
    await connect();
    const wait = 1500 - (Date.now() - connectedAt);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    const info = await vscode.commands.executeCommand('icube.common.getUserInfo');
    if (service === 'model' && !info?.token) throw fail('请先在 Trae 中登录，再重新同步。', 'not-applied', 'login-required');
    const account = info?.account;
    const user = { name: account?.username || '', token: info?.token || '', is_internal: account?.scope === 'bytedance', user_id: info?.userId || '', scope: account?.scope || '', loginScope: account?.loginScope, tenant_id: account?.tenant_id, email: account?.email };
    const [deviceId, common, profile] = await Promise.all([
      vscode.commands.executeCommand('icube.common.commands.tooling.getDeviceId'),
      vscode.commands.executeCommand('icube.common.getReportCommonParams'),
      vscode.commands.executeCommand('icube:user-profile-data-get')
    ]);
    if (profile?.saasProductType !== undefined) user.enterprise_info = { product_type: profile.saasProductType };
    const result = await deadline(rpc.sendRequest('request', {
      packet_type: 'request', channel_id: crypto.randomUUID(), session_id: sessionId,
      params: { service, method, data, user_info: user, common_params: common || {}, streamlined_common_params: {}, client_info: { connect_session_id: sessionId, user_data_profile_id: '__default__profile__', client_type: 'ide', window_type: 'IDE', device_id: deviceId, icube_language: vscode.env.language } }
    }));
    const reply = result?.params;
    if (!reply || typeof reply.code !== 'number') throw fail('Trae 返回了无法识别的模型操作结果。', 'unknown', 'schema-incompatible');
    if (reply.code !== 0) {
      // Only static messages are returned; native error details could contain a submitted key.
      throw fail(reply.code === 503 ? 'Trae 模型服务尚未就绪，请打开模型设置后重试。' : `Trae 拒绝了模型操作（代码 ${reply.code}）。`, 'unknown', reply.code === 503 ? 'service-not-ready' : undefined);
    }
    return reply.data;
  }
  async function list() {
    // model_list alone returns a cached snapshot even after a successful write.
    // This is the same explicit refresh used by Trae's model-settings UI.
    await invoke('model', 'model_list_by_function', { functions: ['builder', 'builder_v3', 'chat_v3', 'code_reviewer', 'code_review_summary', 'refactor', 'solo_agent'], force_refresh: true });
    const data = await invoke('model', 'model_list', {});
    if (!Array.isArray(data?.model_list)) throw fail('Trae 模型列表格式不兼容。', 'not-applied', 'schema-incompatible');
    return { models: data.model_list.map(safeModel), disableCustomModel: data.disable_custom_model === true };
  }
  let mutationQueue = Promise.resolve();
  async function mutate(input) {
    let before;
    try { before = await list(); }
    catch (error) { throw fail(error.outcome ? error.message : '暂时无法读取 Trae 模型列表，尚未修改配置。', 'not-applied', ERROR_CODES.has(error.code) ? error.code : undefined); }
    if (before.disableCustomModel) throw fail('Trae 当前账号不允许添加自定义模型。', 'not-applied', 'custom-models-disabled');
    const config = input.operation === 'delete' ? undefined : configuration(input.configuration);
    const id = input.id;
    if (input.operation !== 'add' && (typeof id !== 'string' || !/^\d{1,32}$/.test(id) || !before.models.some(model => String(model.custom_model_id) === id))) throw fail('目标自定义模型不存在，请重新读取配置。');
    // Do not retry writes: a lost reply does not prove the mutation failed.
    const marker = `ModelDock-${crypto.randomBytes(16).toString('hex')}`;
    let receipt;
    if (input.operation === 'add') receipt = await invoke('model', 'add_custom_model', { ...config, display_name: marker });
    else receipt = await invoke('model', 'update_custom_model', input.operation === 'delete' ? { action: 'delete', id } : { ...config, action: 'update', id, status: true });
    let after;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { after = await list(); } catch { throw fail('Trae 操作已提交，但暂时无法核对结果。', 'unknown'); }
      if (input.operation === 'delete') {
        if (!after.models.some(model => String(model.custom_model_id) === id)) return {};
      } else {
        const previous = new Set(before.models.map(model => String(model.custom_model_id)));
        const returnedId = receipt?.custom_model_id ?? receipt?.id;
        const candidates = after.models.filter(model => input.operation === 'add' ? model.custom_model_id && !previous.has(String(model.custom_model_id)) && model.provider === config.provider && model.name === `${config.provider}//${config.model_name}` && (returnedId !== undefined ? String(model.custom_model_id) === String(returnedId) : model.display_name === marker) : String(model.custom_model_id) === id);
        if (candidates.length === 1) {
          if (input.operation !== 'add') {
            if (matches(candidates[0], config)) return { model: candidates[0] };
            await new Promise(resolve => setTimeout(resolve, 400));
            continue;
          }
          const createdId = String(candidates[0].custom_model_id);
          try {
            await invoke('model', 'update_custom_model', { ...config, action: 'update', id: createdId, status: true });
            for (let renameAttempt = 0; renameAttempt < 5; renameAttempt++) {
              const renamed = (await list()).models.find(model => String(model.custom_model_id) === createdId);
              if (renamed && matches(renamed, config)) return { model: renamed };
              await new Promise(resolve => setTimeout(resolve, 400));
            }
          } catch { /* Creation may have succeeded; never classify the entire add as unapplied. */ }
          throw fail('Trae 已创建模型，但暂时无法确认最终配置。', 'unknown');
        }
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw fail('Trae 操作已提交，但模型列表尚未确认结果。', 'unknown');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const respond = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    const authorization = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.url !== '/v1/modeldock' || req.headers.origin || authorization.length !== expected.length || !crypto.timingSafeEqual(authorization, expected)) return respond(403, { error: '连接认证失败。', outcome: 'not-applied' });
    const timestamp = Number(req.headers['x-modeldock-time']);
    const nonce = req.headers['x-modeldock-nonce'];
    const now = Date.now();
    for (const [key, time] of nonces) if (now - time > 60000) nonces.delete(key);
    if (Math.abs(now - timestamp) > 30000 || !Number.isFinite(timestamp) || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || nonces.has(nonce)) return respond(409, { error: '连接请求已过期或已使用。', outcome: 'not-applied' });
    nonces.set(nonce, now);
    let length = 0;
    const parts = [];
    try {
      for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) throw fail('配置内容过大。'); parts.push(chunk); }
      const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (input.operation === 'health') return respond(200, { version: VERSION, productVersion: product.appVersion, userDataPath, pid: process.pid, executable: canonical(process.execPath) });
      if (input.operation === 'list') return respond(200, await list());
      if (['add', 'update', 'delete'].includes(input.operation)) {
        const task = mutationQueue.then(() => mutate(input));
        mutationQueue = task.catch(() => {});
        return respond(200, await task);
      }
      throw fail('不支持此模型操作。');
    } catch (error) {
      respond(400, { error: error.outcome ? error.message : '本机连接失败，请重新打开 Trae 后重试。', outcome: error.outcome || 'unknown', code: ERROR_CODES.has(error.code) ? error.code : undefined });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  fs.mkdirSync(storage, { recursive: true });
  const descriptorPath = path.join(storage, `bridge-${process.pid}.json`);
  fs.writeFileSync(descriptorPath, JSON.stringify({ version: VERSION, pid: process.pid, port: server.address().port, token, userDataPath, executable: canonical(process.execPath), appRoot: canonical(vscode.env.appRoot), extensionPath: canonical(context.extensionPath) }), { mode: 0o600 });
  disposal = () => { server.close(); try { rpc?.dispose(); } catch {} try { ipc?.disconnect(); } catch {} try { fs.unlinkSync(descriptorPath); } catch {} };
  context.subscriptions.push({ dispose: disposal }, vscode.window.registerUriHandler({ handleUri() {} }));
};

exports.deactivate = () => disposal?.();
