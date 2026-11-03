import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

type NativeModel = Record<string, unknown>;
type Packet = { params: { method: string; data: Record<string, unknown>; user_info: Record<string, unknown>; client_info: Record<string, unknown> } };
const ownKey = 'synthetic-modeldock-key';
const foreignKey = 'synthetic-foreign-key-never-exported';
const accountToken = 'synthetic-trae-account-token';

describe('Trae extension bridge boundary', () => {
  let root: string;
  let endpoint: string;
  let token: string;
  let deactivate: () => void;
  const calls: Packet[] = [];
  let live: NativeModel[] = [];
  let cached: NativeModel[] = [];
  let nextId = 10;
  let rejectWrite = false;
  let concurrentSameName = false;
  let rejectRead = false;
  let loggedIn = true;
  let logoutAfterAddRead = false;

  const config = () => ({ provider: 'custom_openai_compatible', model_name: 'fixture-model', is_custom: true, ak: ownKey, isAkFromServer: false, auth_type: 0, base_url: 'http://127.0.0.1:18888/v1/chat/completions', display_name: 'Fixture model', clearReasoningParam: true, config_detail: { multimodal: false, model_hyper_params: { max_tokens: 2048, prompt_max_tokens: 16384, thinking_enable: 2 } } });
  const makeModel = (id: string, input: ReturnType<typeof config>) => ({ custom_model_id: id, config_source: 3, provider: input.provider, name: `${input.provider}//${input.model_name}`, base_url: input.base_url, display_name: input.display_name, auth_type: 0, status: true, multimodal: input.config_detail.multimodal, ...input.config_detail.model_hyper_params, ak: input.ak });
  async function call(body: unknown, extraHeaders: Record<string, string> = {}, nonce = randomBytes(16).toString('hex')) {
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-modeldock-time': String(Date.now()), 'x-modeldock-nonce': nonce, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'modeldock-trae-bridge-'));
    const appRoot = join(root, 'app'), storage = join(root, 'User', 'globalStorage', 'modeldock.trae-bridge');
    mkdirSync(appRoot); writeFileSync(join(appRoot, 'product.json'), JSON.stringify({ nameLong: 'Trae CN', appVersion: '3.4.14' }));
    const ipc = new EventEmitter() as EventEmitter & { send(): void; disconnect(): void };
    ipc.send = () => {}; ipc.disconnect = () => {};
    class Connection {
      onError() {}
      dispose() {}
      async sendRequest(_method: string, packet: Packet) {
        calls.push(packet);
        const { method, data } = packet.params;
        let result: unknown = {};
        if (rejectRead && method === 'model_list_by_function') return { params: { code: 503 } };
        if (method === 'model_list_by_function') cached = structuredClone(live);
        if (method === 'model_list') {
          result = { model_list: cached, disable_custom_model: false };
          if (logoutAfterAddRead && cached.length) loggedIn = false;
        }
        if (['add_custom_model', 'update_custom_model'].includes(method) && rejectWrite) return { params: { code: 503, message: `${accountToken}/${ownKey}` } };
        if (method === 'add_custom_model') {
          const input = data as ReturnType<typeof config>;
          if (concurrentSameName) live.push(makeModel('999', { ...input, display_name: 'User concurrent model', ak: foreignKey }));
          live.push(makeModel(String(nextId++), input));
        }
        if (method === 'update_custom_model') {
          const index = live.findIndex(model => model.custom_model_id === data.id);
          if (data.action === 'delete') live.splice(index, 1);
          else if (index >= 0) live[index] = makeModel(String(data.id), data as ReturnType<typeof config>);
        }
        return { params: { code: 0, data: result } };
      }
    }
    const vscode = { env: { appRoot, language: 'zh-cn' }, commands: { executeCommand: async (name: string) => name === 'icube.common.getUserInfo' ? { token: loggedIn ? accountToken : undefined, userId: 'synthetic-user', account: { scope: 'marscode', username: 'synthetic' } } : name === 'icube.common.commands.tooling.getDeviceId' ? 'synthetic-device' : {} }, window: { registerUriHandler: () => ({ dispose() {} }) } };
    const baseRequire = createRequire(import.meta.url);
    const module = { exports: {} as { activate(context: unknown): Promise<void>; deactivate(): void } };
    const loader = (name: string) => name === 'vscode' ? vscode : name === 'electron' ? { ahaIpc: { connect: () => ipc } } : /@aha-kit[\\/]rpc/.test(name) ? { Connection } : baseRequire(name);
    new Function('require', 'module', 'exports', readFileSync(resolve('assets/trae-bridge/extension.cjs'), 'utf8'))(loader, module, module.exports);
    deactivate = module.exports.deactivate;
    await module.exports.activate({ globalStorageUri: { fsPath: storage }, extensionPath: appRoot, subscriptions: [] });
    const descriptor = JSON.parse(readFileSync(join(storage, readdirSync(storage)[0]), 'utf8'));
    endpoint = `http://127.0.0.1:${descriptor.port}/v1/modeldock`; token = descriptor.token;
    expect(calls).toHaveLength(0);
  });
  beforeEach(() => { calls.length = 0; live = []; cached = []; rejectWrite = false; concurrentSameName = false; rejectRead = false; loggedIn = true; logoutAfterAddRead = false; });
  afterAll(() => { deactivate?.(); if (root) rmSync(root, { recursive: true, force: true }); });

  it('starts without native reads or writes and denies browser, bad authentication, replay and arbitrary RPC', async () => {
    expect((await call({ operation: 'health' })).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await call({ operation: 'list' }, { authorization: 'Bearer invalid' })).status).toBe(403);
    expect((await call({ operation: 'list' }, { origin: 'https://example.invalid' })).status).toBe(403);
    const nonce = randomBytes(16).toString('hex');
    expect((await call({ operation: 'health' }, {}, nonce)).status).toBe(200);
    expect((await call({ operation: 'health' }, {}, nonce)).status).toBe(409);
    expect((await call({ operation: 'request', service: 'shell', method: 'execute' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refreshes the native cache and exports only model metadata without provider or Trae credentials', async () => {
    live = [{ ...makeModel('1', { ...config(), ak: foreignKey }), reasoning_param: { parameter: 'reasoning_effort', values: ['high'], hidden_key: foreignKey }, config_detail: { ak: foreignKey }, updated_at: { ak: foreignKey } }];
    const response = await call({ operation: 'list' });
    expect(response.status).toBe(200);
    expect(calls.map(call => call.params.method)).toEqual(['model_list_by_function', 'model_list']);
    expect(calls[0].params.data.force_refresh).toBe(true);
    expect(calls[1].params.client_info.user_data_profile_id).toBe('__default__profile__');
    expect(calls[1].params.user_info.token).toBe(accountToken);
    const output = JSON.stringify(response.body);
    expect(output).not.toContain(foreignKey); expect(output).not.toContain(accountToken);
    expect(response.body.models[0].reasoning_param).toEqual({ parameter: 'reasoning_effort', values: ['high'] });
  }, 20000);

  it('owns an add using its random marker, preserves a concurrent same-name model and confirms CRUD after refresh', async () => {
    concurrentSameName = true;
    const added = await call({ operation: 'add', configuration: config() });
    expect(added.status).toBe(200);
    expect(added.body.model.custom_model_id).not.toBe('999');
    const writes = calls.filter(call => ['add_custom_model', 'update_custom_model'].includes(call.params.method));
    expect(writes[0].params.data.display_name).toMatch(/^ModelDock-[a-f0-9]{32}$/);
    expect(writes[1].params.data).toMatchObject({ ak: ownKey, base_url: config().base_url, display_name: config().display_name });
    const id = added.body.model.custom_model_id;
    const updated = await call({ operation: 'update', id, configuration: { ...config(), display_name: 'Changed' } });
    expect(updated.status).toBe(200); expect(updated.body.model.display_name).toBe('Changed');
    expect((await call({ operation: 'delete', id })).status).toBe(200);
    expect(live.map(model => model.custom_model_id)).toEqual(['999']);
  }, 20000);

  it('treats a rejected dispatched write as unknown and never exports native error contents', async () => {
    rejectWrite = true;
    const response = await call({ operation: 'add', configuration: config() });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ outcome: 'unknown', code: 'service-not-ready' });
    expect(JSON.stringify(response.body)).not.toContain(ownKey); expect(JSON.stringify(response.body)).not.toContain(accountToken);
    expect(calls.filter(call => call.params.method === 'add_custom_model')).toHaveLength(1);
  }, 20000);

  it('can safely retry a preflight read failure because no write was sent', async () => {
    rejectRead = true;
    const response = await call({ operation: 'add', configuration: config() });
    expect(response.body).toMatchObject({ outcome: 'not-applied', code: 'service-not-ready' });
    expect(calls.some(call => call.params.method === 'add_custom_model')).toBe(false);
  }, 20000);

  it('keeps the whole add unknown when login expires before its final rename', async () => {
    logoutAfterAddRead = true;
    const response = await call({ operation: 'add', configuration: config() });
    expect(response.body.outcome).toBe('unknown');
    expect(live).toHaveLength(1);
    expect(live[0].display_name).toMatch(/^ModelDock-[a-f0-9]{32}$/);
    expect(calls.filter(call => call.params.method === 'add_custom_model')).toHaveLength(1);
  }, 20000);
});
