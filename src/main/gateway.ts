import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Store, validateUpstreamUrl } from './store';
import { isCopilotUpstream } from './copilot-provider';
import { resolveBindingModels } from '../shared/bindings';
import { modelDisplayLabel } from '../shared/model-names';
import type { Provider, ProviderSecret, Model, ToolId, GatewayStatus } from '../shared/types';
import { reportedUsage } from './usage';
import type { TokenUsage } from '../shared/usage-types';
import { DEFAULT_SETTINGS } from '../shared/settings-types';
import type { DiagnosticContext, DiagnosticEvent, DiagnosticLevel } from '../shared/diagnostic-types';
import { describeError } from './diagnostic-log';
import { AnthropicBridgeError, parseAnthropicRequest, toAnthropicResponse, createAnthropicStream, collectAnthropicStream, anthropicMessageToSse } from './anthropic-bridge';
import { ChatResponsesBridgeError, parseChatResponsesRequest, responsesToChat, createResponsesChatStream, collectResponsesChatStream, chatResponseToSse } from './chat-responses-bridge';
import { isJetBrainsTool } from '../shared/jetbrains';
import { JetBrainsChatError, createJetBrainsChatStream, normalizeJetBrainsChatResponse, jetBrainsResponsesHistory } from './jetbrains-chat-stream';
import { nativeClaudeBaseUrl } from '../shared/claude';
import { NativeMessagesError, prepareNativeMessagesRequest, toNativeMessagesResponse, createNativeMessagesStream, collectNativeMessagesStream, nativeMessagesToSse } from './native-messages';

type Json = Record<string, unknown>;
export interface PreparedRequest { url: string; headers: Record<string, string>; body: Json }
export interface GatewayOptions {
  port?: number;
  fetch?: typeof fetch;
  prepareRequest?: (provider: Provider, secret: ProviderSecret, path: string, body: Json) => Promise<PreparedRequest>;
  timeoutMs?: number;
  diagnostics?: (level: DiagnosticLevel, event: DiagnosticEvent, context?: DiagnosticContext) => void;
  runWithDiagnostics?: (context: DiagnosticContext, action: () => Promise<void>) => Promise<void>;
}
const BODY_LIMIT = 8 * 1024 * 1024;
const toolIds = new Set(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm']);
const upstreamHeaderNames = new Set(['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'user-agent', 'originator', 'version', 'chatgpt-account-id', 'openai-beta', 'openai-organization', 'openai-project', 'session_id', 'conversation_id', 'x-request-id', 'x-grok-cli-version', 'x-grok-client-version', 'x-grok-client-identifier', 'x-grok-client-mode', 'x-xai-token-auth', 'x-authenticateresponse', 'x-grok-conv-id', 'copilot-integration-id', 'editor-version', 'editor-plugin-version', 'x-github-api-version', 'x-initiator']);
const responseHeaderNames = new Set(['content-type', 'x-request-id', 'retry-after']);
const nativeErrorTypes = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error', 'timeout_error']);
class GatewayError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}
function errorResponse(response: ServerResponse, status: number, message: string): void { jsonResponse(response, status, { error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error' } }); }
function isObject(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function redact(value: string, secrets: string[]): string { let result = value; for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join('[REDACTED]'); return result; }
function aliasResponse(value: unknown, alias: string): unknown {
  if (!isObject(value)) return value;
  const result: Json = { ...value };
  if (typeof result.model === 'string') result.model = alias;
  if (isObject(result.response)) result.response = aliasResponse(result.response, alias);
  return result;
}
function readBody(request: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let size = 0; let settled = false; const chunks: Buffer[] = [];
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { chunks.length = 0; fail(new GatewayError(413, '请求体超过 8 MiB。')); return; }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      try { const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!isObject(result)) throw new Error(); resolve(result); } catch { reject(new GatewayError(400, '请求体必须是 JSON 对象。')); }
    });
    request.once('aborted', () => fail(new GatewayError(499, '客户端已断开。')));
    request.once('error', () => fail(new GatewayError(400, '无法读取请求体。')));
  });
}

/** Incremental SSE framing; JSON and UTF-8 code points may cross network chunks. */
class SseFrames {
  private decoder = new TextDecoder();
  private pending = '';
  feed(chunk: Uint8Array, last = false): string[] {
    this.pending += this.decoder.decode(chunk, { stream: !last });
    if (this.pending.length > 16 * 1024 * 1024) throw new GatewayError(502, '上游 SSE 事件过大。');
    const frames: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) { frames.push(this.pending.slice(0, match.index)); this.pending = this.pending.slice(match.index + match[0].length); }
    if (last && this.pending.trim()) { frames.push(this.pending); this.pending = ''; }
    return frames;
  }
}
function sseData(frame: string): unknown {
  const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data || data === '[DONE]') return undefined;
  try { return JSON.parse(data); } catch { throw new GatewayError(502, '上游 SSE 包含无效 JSON。'); }
}
function mappedSse(frame: string, alias: string): string {
  try {
    const data = sseData(frame);
    if (!isObject(data) || !(typeof data.model === 'string' || isObject(data.response) && typeof data.response.model === 'string')) return `${frame}\n\n`;
    const other = frame.split(/\r\n|\n|\r/).filter(line => !line.startsWith('data:'));
    return [...other, `data: ${JSON.stringify(aliasResponse(data, alias))}`, '', ''].join('\n');
  } catch { return `${frame}\n\n`; } // Streaming preserves upstream events, including errors.
}

/** Aggregate only the Responses protocol, never invent a successful truncated reply. */
class ResponsesCollector {
  private response: Json = {};
  private items = new Map<number, Json>();
  private completed = false;
  add(value: unknown): void {
    if (!isObject(value)) return;
    const type = String(value.type ?? '');
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') throw new GatewayError(502, '上游响应未完整完成。');
    if (type === 'response.created' && isObject(value.response)) this.response = { ...value.response };
    const index = Number(value.output_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 10000) throw new GatewayError(502, '上游输出序号无效。');
    if ((type === 'response.output_item.added' || type === 'response.output_item.done') && isObject(value.item)) this.items.set(index, structuredClone(value.item));
    else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      if (isObject(value.part)) { const item = this.message(index, value.item_id); const content = item.content as unknown[]; content[Number(value.content_index ?? 0)] = structuredClone(value.part); }
    } else if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const item = this.message(index, value.item_id); const content = item.content as Json[];
      const partIndex = Number(value.content_index ?? 0);
      const part = isObject(content[partIndex]) ? content[partIndex] : { type: 'output_text', text: '', annotations: [] };
      part.text = type.endsWith('.done') ? String(value.text ?? '') : String(part.text ?? '') + String(value.delta ?? '');
      content[partIndex] = part;
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const item = this.items.get(index) ?? { id: value.item_id, type: 'function_call', arguments: '' };
      item.arguments = type.endsWith('.done') ? String(value.arguments ?? '') : String(item.arguments ?? '') + String(value.delta ?? '');
      this.items.set(index, item);
    } else if (type === 'response.custom_tool_call_input.delta' || type === 'response.custom_tool_call_input.done') {
      const item = this.items.get(index) ?? { id: value.item_id, type: 'custom_tool_call', input: '' };
      item.input = type.endsWith('.done') ? String(value.input ?? '') : String(item.input ?? '') + String(value.delta ?? '');
      this.items.set(index, item);
    } else if (type === 'response.completed') {
      if (!isObject(value.response)) throw new GatewayError(502, '上游完成事件缺少完整响应。');
      this.response = { ...this.response, ...value.response };
      this.completed = true;
    }
  }
  private message(index: number, itemId: unknown): Json {
    const item = this.items.get(index) ?? { id: itemId, type: 'message', role: 'assistant', content: [] };
    if (!Array.isArray(item.content)) item.content = [];
    this.items.set(index, item);
    return item;
  }
  result(alias: string): Json {
    if (!this.completed) throw new GatewayError(502, '上游流已终止，但未收到 response.completed。');
    const output = Array.isArray(this.response.output) && this.response.output.length ? this.response.output : [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (!output.length) throw new GatewayError(502, '上游完成事件没有输出内容。');
    return { ...this.response, object: 'response', status: 'completed', model: alias, output };
  }
}

async function write(response: ServerResponse, data: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  if (response.destroyed) throw new GatewayError(499, '客户端已断开。');
  if (signal?.aborted) throw new GatewayError(504, '请求已取消或超时。');
  if (response.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { response.removeListener('drain', onDrain); response.removeListener('close', onClose); response.removeListener('error', onClose); signal?.removeEventListener('abort', onAbort); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new GatewayError(499, '客户端已断开。')); };
    // 修改点：客户端暂停读取时也必须响应超时，不能永远等待 drain。
    const onAbort = () => { cleanup(); reject(new GatewayError(response.destroyed ? 499 : 504, '请求已取消或超时。')); };
    response.once('drain', onDrain); response.once('close', onClose); response.once('error', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
async function limitedText(response: Response, max = 32 * 1024 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > max) throw new GatewayError(502, '上游响应过大。'); chunks.push(item.value); } }
  catch (error) { try { await reader.cancel(); } catch { /* aborted upstream */ } throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** 修改点：当前 Koog SSE 会将中途 EOF/RST 当成功；JetBrains 先有界校验完整回复再发 200。 */
async function completeJetBrainsStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) return chunks;
    size += item.value.byteLength;
    if (size > 32 * 1024 * 1024) throw new JetBrainsChatError('上游 Chat 响应超过 32 MiB，请缩小输出后重试。');
    chunks.push(item.value);
  }
}

export class Gateway {
  private server?: Server;
  private sockets = new Set<Socket>();
  private controllers = new Set<AbortController>();
  private state: GatewayStatus = { running: false, host: '127.0.0.1', port: 18181, baseUrl: 'http://127.0.0.1:18181/v1', requests: 0, lastError: '' };
  constructor(private store: Store, private options: GatewayOptions = {}) { this.configurePort(options.port ?? DEFAULT_SETTINGS.gatewayPort); }
  // 修改点：诊断只记录固定事件和安全元数据；写日志失败不得影响本地 API。
  private diagnostic(level: DiagnosticLevel, event: DiagnosticEvent, context: DiagnosticContext): void {
    try { this.options.diagnostics?.(level, event, context); } catch { /* Logging cannot affect service lifecycle or requests. */ }
  }
  status(): GatewayStatus { return { ...this.state }; }
  configurePort(port: number): void {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('网关端口无效。');
    if (this.server?.listening && port !== this.state.port) throw new Error('请先停止本地服务，再修改端口。');
    this.store.setGatewayPort(port);
    this.state = { ...this.state, port, baseUrl: `http://127.0.0.1:${port}/v1` };
  }
  async start(port = this.state.port): Promise<GatewayStatus> {
    if (this.server?.listening) return this.status();
    try { this.configurePort(port); }
    catch (error) {
      this.diagnostic('error', 'gateway.start_failed', { operation: 'start', stage: 'gateway', outcome: 'configuration', ...describeError(error) });
      this.state.lastError = '网关端口无效。'; throw new Error(this.state.lastError);
    }
    for (const provider of this.store.listProviders()) {
      if (!provider.enabled || !provider.baseUrl.trim()) continue;
      try { validateUpstreamUrl(provider.baseUrl, port); }
      catch (error) {
        // This validator emits fixed messages and never includes the supplied URL or credentials.
        this.diagnostic('error', 'gateway.start_failed', { operation: 'start', stage: 'gateway', outcome: 'configuration', port, providerId: provider.id, ...describeError(error) });
        this.state.lastError = error instanceof Error ? error.message : '供应商配置无效，无法启动本地网关。';
        throw new Error(this.state.lastError);
      }
    }
    const server = createServer((request, response) => { this.handleWithDiagnostics(request, response); });
    server.requestTimeout = 30_000; server.headersTimeout = 15_000;
    server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    } catch (error) {
      this.diagnostic('error', 'gateway.start_failed', { operation: 'start', stage: 'gateway', outcome: 'failure', port, ...describeError(error) });
      this.state.lastError = '无法启动本地网关，端口可能已被占用。'; server.close(); throw new Error(this.state.lastError);
    }
    this.server = server;
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    this.store.setGatewayPort(actualPort);
    this.state = { ...this.state, running: true, port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}/v1`, lastError: '' };
    server.on('error', error => {
      this.state.lastError = '本地网关发生错误。';
      this.diagnostic('error', 'gateway.runtime_error', { stage: 'gateway', outcome: 'failure', port: this.state.port, ...describeError(error) });
    });
    this.diagnostic('info', 'gateway.started', { operation: 'start', stage: 'gateway', outcome: 'success', port: actualPort });
    return this.status();
  }
  async stop(): Promise<GatewayStatus> {
    const server = this.server;
    const wasRunning = this.state.running;
    this.server = undefined;
    for (const controller of this.controllers) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    this.state.running = false;
    if (server || wasRunning) this.diagnostic('info', 'gateway.stopped', { operation: 'stop', stage: 'gateway', outcome: 'success', port: this.state.port });
    return this.status();
  }
  private authenticated(request: IncomingMessage): boolean {
    const key = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!key) return false;
    const actual = Buffer.from(key); const expected = Buffer.from(this.store.gatewayKey());
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  private route(path: string): { endpoint: string; tool?: ToolId } {
    if (path.startsWith('/tool/')) {
      const match = /^\/tool\/([^/]+)(\/v1\/[^/]+(?:\/[^/]+)?)$/.exec(path);
      if (!match || !toolIds.has(match[1])) throw new GatewayError(404, '工具入口不存在。');
      return { endpoint: match[2], tool: match[1] as ToolId };
    }
    return { endpoint: path };
  }
  private available(model: Model, nativeMessages = false): boolean {
    const provider = this.store.getProvider(model.providerId);
    if (model.wireApi === 'messages' && !nativeMessages || !model.enabled || !provider?.enabled || !provider.hasSecret || provider.authStatus !== 'ready' || !provider.baseUrl.trim()) return false;
    try { validateUpstreamUrl(nativeMessages && provider.kind === 'openai-compatible' ? nativeClaudeBaseUrl(provider) ?? provider.baseUrl : provider.baseUrl, this.state.port); return true; } catch { return false; }
  }
  private allowedModels(tool?: ToolId): Model[] {
    const models = this.store.listModels().filter(model => this.available(model, tool === 'claude-code'));
    if (!tool) return models;
    const binding = this.store.listBindings().find(item => item.id === tool);
    return binding ? resolveBindingModels(binding, models, this.store.listProviders()) : [];
  }
  /** 修改点：每次 HTTP 请求建立独立关联，不继承启动监听器时的 IPC 关联。 */
  private handleWithDiagnostics(request: IncomingMessage, response: ServerResponse): void {
    const context: DiagnosticContext = { traceId: randomUUID(), operation: 'request', stage: 'gateway' };
    let task: Promise<void> | undefined;
    let reported = false;
    const report = (error: unknown) => {
      if (reported) return;
      reported = true;
      this.diagnostic('error', 'gateway.runtime_error', { ...context, outcome: 'failure', ...describeError(error) });
    };
    // The scope hook may fail before or after invoking action. Cache the first
    // task so a repeated call, exception or fallback cannot send inference twice.
    const action = (): Promise<void> => {
      if (!task) {
        task = this.handle(request, response);
        void task.catch(error => { report(error); if (!response.writableEnded) response.destroy(); });
      }
      return task;
    };
    const scopeFailed = (error: unknown): void => {
      report(error);
      // A diagnostic failure before action is the sole safe fallback: it has
      // not sent a request. A task that already started is never retried.
      if (!task) void action();
    };
    try {
      void (this.options.runWithDiagnostics ? this.options.runWithDiagnostics(context, action) : action()).catch(scopeFailed);
    } catch (error) { scopeFailed(error); }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const began = Date.now(); let alias = ''; let providerName = ''; let endpoint = '/'; let logStatus = 200;
    let tool: ToolId | undefined, providerId: string | undefined, modelId: string | undefined;
    let usage: TokenUsage | undefined, upstreamFailed = false, anthropic = false, chatResponses = false;
    let diagnosticEndpoint: string | undefined;
    let diagnosticError: Pick<DiagnosticContext, 'errorName' | 'networkCode' | 'projectFrames'> | undefined;
    const observe = (value: unknown) => {
      usage = reportedUsage(value) ?? usage;
      if (isObject(value) && ['error', 'response.failed', 'response.incomplete'].includes(String(value.type ?? ''))) {
        // 修改点：合法预算截断会映射为 Messages max_tokens，不能把成功回复记录成 502。
        const details = isObject(value.response) && isObject(value.response.incomplete_details) ? value.response.incomplete_details : undefined;
        if (!((anthropic || chatResponses) && value.type === 'response.incomplete' && details?.reason === 'max_output_tokens')) upstreamFailed = true;
      }
    };
    this.state.requests++;
    try {
      endpoint = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      anthropic = endpoint.endsWith('/v1/messages');
      // Unknown paths and query parameters can contain secrets; only known route names are retained.
      const knownRoute = endpoint.replace(/^\/tool\/(?:codex|opencode|dsh|vscode|copilot|claude-code|webstorm|intellij-idea|rider|pycharm)/, '');
      if (['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(knownRoute)) diagnosticEndpoint = knownRoute;
      if (!this.authenticated(request)) throw new GatewayError(401, '需要有效的 ModelDock API Key。');
      const route = this.route(endpoint);
      tool = route.tool;
      if (request.method === 'GET' && route.endpoint === '/v1/models') {
        const data = this.allowedModels(route.tool).map(model => {
          const provider = this.store.getProvider(model.providerId)!;
          return { id: model.alias, object: 'model', created: 0, owned_by: provider.name, display_name: modelDisplayLabel(model, provider), context_window: model.contextWindow, wire_api: model.wireApi, capabilities: { tools: model.tools, vision: model.vision } };
        });
        jsonResponse(response, 200, { object: 'list', data }); return;
      }
      if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(route.endpoint)) throw new GatewayError(404, '接口不存在。');
      if (anthropic && route.tool && route.tool !== 'claude-code' || route.tool === 'claude-code' && !anthropic) throw new GatewayError(404, '此工具不使用该协议入口。');
      const body = await readBody(request);
      if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new GatewayError(400, 'stream 必须是布尔值。');
      const binding = route.tool ? this.store.listBindings().find(item => item.id === route.tool) : undefined;
      if (route.tool && !binding?.enabled) throw new GatewayError(403, '此工具尚未启用。');
      const selectedModels = binding ? resolveBindingModels(binding, this.store.listModels(), this.store.listProviders()) : undefined;
      if (selectedModels && !selectedModels.length) throw new GatewayError(403, '此工具尚未启用任何模型。');
      const defaultModel = binding?.defaultModelId ? selectedModels?.find(model => model.id === binding.defaultModelId) : undefined;
      const requested = typeof body.model === 'string' ? body.model : defaultModel?.alias;
      if (!requested) throw new GatewayError(400, '请指定模型别名。');
      const model = this.store.listModels().find(item => item.alias === requested);
      if (!model || !model.enabled) throw new GatewayError(404, '模型别名不存在或未启用。');
      alias = model.alias;
      modelId = model.id;
      if (selectedModels && !selectedModels.some(item => item.id === model.id)) throw new GatewayError(403, '此模型未授权给该工具。');
      const expectedWire = route.endpoint === '/v1/responses' ? 'responses' : 'chat-completions';
      // 修改点：JetBrains AI Assistant 使用 Chat，Responses 来源在本机显式转换。
      chatResponses = isJetBrainsTool(route.tool) && route.endpoint === '/v1/chat/completions' && model.wireApi === 'responses';
      if (!anthropic && !chatResponses && model.wireApi !== expectedWire) throw new GatewayError(400, '该模型使用不同协议，请选择对应的接口；本版本不进行跨协议转换。');
      const provider = this.store.getProvider(model.providerId);
      const nativeMessages = anthropic && provider?.kind === 'openai-compatible' && (model.wireApi === 'messages' || Boolean(nativeClaudeBaseUrl(provider)));
      if (provider && provider.kind !== 'openai-compatible' && ('previous_response_id' in body || 'conversation' in body)) {
        throw new GatewayError(400, '订阅来源不支持服务端会话续接；请移除 previous_response_id / conversation，并在 input 中发送完整会话历史。');
      }
      if (!provider || !this.available(model, nativeMessages)) throw new GatewayError(503, '供应商未启用或凭据尚未就绪。');
      providerName = provider.name;
      providerId = provider.id;
      // 修改点：Claude Messages 在本机转换成来源原生协议，订阅凭据继续由主进程续期。
      const upstreamBody = nativeMessages ? { ...body, model: model.upstreamId } : anthropic ? { ...parseAnthropicRequest(body, model.wireApi), model: model.upstreamId } : chatResponses ? { ...parseChatResponsesRequest(jetBrainsResponsesHistory(body)), model: model.upstreamId } : { ...body, model: model.upstreamId };
      const upstreamPath = nativeMessages ? '/v1/messages' : chatResponses ? '/v1/responses' : anthropic ? model.wireApi === 'responses' ? '/v1/responses' : '/v1/chat/completions' : route.endpoint;
      await this.forward(request, response, provider, model, upstreamPath, upstreamBody, observe, anthropic || chatResponses ? { stream: body.stream === true, kind: nativeMessages ? 'native-messages' : chatResponses ? 'chat-responses' : 'anthropic' } : undefined, isJetBrainsTool(route.tool));
      logStatus = upstreamFailed ? 502 : response.statusCode;
    } catch (error) {
      diagnosticError = describeError(error);
      logStatus = error instanceof GatewayError || error instanceof AnthropicBridgeError || error instanceof ChatResponsesBridgeError || error instanceof NativeMessagesError || error instanceof JetBrainsChatError ? error.status : 502;
      const message = error instanceof GatewayError || error instanceof AnthropicBridgeError || error instanceof ChatResponsesBridgeError || error instanceof NativeMessagesError || error instanceof JetBrainsChatError ? error.message : '上游请求失败，请检查连接和供应商状态。';
      if (logStatus !== 499) this.state.lastError = message;
      if (!response.destroyed && !response.headersSent) {
        if (anthropic) jsonResponse(response, logStatus === 499 ? 400 : logStatus, { type: 'error', error: { type: logStatus === 401 ? 'authentication_error' : logStatus >= 500 ? 'api_error' : 'invalid_request_error', message } });
        else errorResponse(response, logStatus === 499 ? 400 : logStatus, message);
      }
      else if (!response.writableEnded) response.destroy();
    } finally {
      const successful = logStatus >= 200 && logStatus < 300;
      const outcome = successful ? 'success' : logStatus === 499 ? 'cancelled' : logStatus === 401 ? 'authentication'
        : logStatus === 403 ? 'permission' : logStatus === 429 ? 'rate-limit' : logStatus === 408 || logStatus === 504 ? 'timeout'
        : logStatus >= 500 ? 'upstream' : 'configuration';
      this.diagnostic(successful ? 'info' : logStatus < 500 || logStatus === 499 ? 'warn' : 'error', 'gateway.request', {
        operation: 'request', stage: 'gateway', outcome, statusCode: logStatus, durationMs: Date.now() - began,
        endpoint: diagnosticEndpoint, toolId: tool, providerId, modelId, ...diagnosticError,
      });
      if (request.method === 'POST') {
        try { this.store.addLog({ alias, providerName, endpoint, status: logStatus, durationMs: Date.now() - began, tool, providerId, modelId, usage }); } catch { /* logging must not break a completed response */ }
      }
    }
  }
  private async forward(request: IncomingMessage, response: ServerResponse, provider: Provider, model: Model, path: string, body: Json, observe: (value: unknown) => void, bridge?: { stream: boolean; kind: 'anthropic' | 'chat-responses' | 'native-messages' }, jetBrains = false): Promise<void> {
    const secret = this.store.getSecret(provider.id);
    if (!secret) throw new GatewayError(503, '供应商缺少凭据。');
    const stream = body.stream === true;
    const controller = new AbortController();
    this.controllers.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 600_000);
    timeout.unref();
    let upstream: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const prepared = bridge?.kind === 'native-messages' ? prepareNativeMessagesRequest(provider, secret, body, { anthropicVersion: typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : undefined, anthropicBeta: typeof request.headers['anthropic-beta'] === 'string' ? request.headers['anthropic-beta'] : undefined }) : this.options.prepareRequest ? await this.options.prepareRequest(provider, secret, path, body) : this.prepareApiKey(provider, secret, path, body);
      if (controller.signal.aborted) throw new GatewayError(response.destroyed ? 499 : 504, '请求已取消或超时。');
      validateUpstreamUrl(prepared.url, this.state.port);
      if (provider.kind === 'copilot' && !isCopilotUpstream(prepared.url, path.replace(/^\/v1/, ''))) throw new GatewayError(502, 'Copilot 请求只能发送到官方模型服务。');
      const headers = new Headers();
      for (const [name, value] of Object.entries(prepared.headers)) if (upstreamHeaderNames.has(name.toLowerCase()) && !/[\r\n]/.test(value)) headers.set(name, value);
      headers.set('content-type', 'application/json');
      upstream = await (this.options.fetch ?? fetch)(prepared.url, { method: 'POST', headers, body: JSON.stringify(prepared.body), signal: controller.signal, redirect: 'manual' });
      const secrets = [secret.apiKey, secret.accessToken, secret.refreshToken, headers.get('authorization')?.replace(/^Bearer /i, ''), headers.get('x-api-key')].filter((item): item is string => Boolean(item));
      if (!upstream.ok) {
        if (bridge?.kind === 'native-messages') {
          // 修改点：Claude 根据原生错误文案恢复 thinking/effort 等能力；保留受控错误消息并脱敏，不返回 debug、请求正文或任意附加字段。
          let message = `上游拒绝模型请求（HTTP ${upstream.status}）。`, type = upstream.status === 401 ? 'authentication_error' : upstream.status === 429 ? 'rate_limit_error' : 'api_error';
          try {
            const raw = JSON.parse(await limitedText(upstream, 1024 * 1024));
            if (isObject(raw) && (raw.type === undefined || raw.type === 'error') && isObject(raw.error)
              && typeof raw.error.type === 'string' && nativeErrorTypes.has(raw.error.type) && typeof raw.error.message === 'string') {
              message = redact(raw.error.message, secrets).slice(0, 4096);
              type = raw.error.type;
            }
          } catch { /* 非 JSON 或超大错误正文只返回固定安全文案。 */ }
          const retry = upstream.headers.get('retry-after'); if (retry) response.setHeader('retry-after', retry);
          jsonResponse(response, upstream.status, { type: 'error', error: { type, message } });
          return;
        }
        if (bridge) {
          if (upstream.body) await upstream.body.cancel();
          const retry = upstream.headers.get('retry-after'); if (retry) response.setHeader('retry-after', retry);
          jsonResponse(response, upstream.status, { ...(bridge.kind !== 'chat-responses' ? { type: 'error' } : {}), error: { type: upstream.status === 401 ? 'authentication_error' : upstream.status === 429 ? 'rate_limit_error' : 'api_error', message: `上游拒绝模型请求（HTTP ${upstream.status}）。` } });
          return;
        }
        response.statusCode = upstream.status;
        for (const name of responseHeaderNames) { const value = upstream.headers.get(name); if (value) response.setHeader(name, value); }
        response.setHeader('cache-control', 'no-store');
        let errorBody: string;
        try { errorBody = await limitedText(upstream, 1024 * 1024); }
        catch {
          // An unreadable/oversized error body must not turn a real 401/429/5xx
          // into an unrelated gateway status. Do not expose transport details.
          response.setHeader('content-type', 'application/json; charset=utf-8');
          errorBody = JSON.stringify({ error: { message: '上游返回错误，响应正文无法安全读取。', type: 'upstream_error' } });
        }
        response.end(redact(errorBody, secrets));
        return;
      }
      const sse = upstream.headers.get('content-type')?.includes('text/event-stream');
      if (bridge) {
        if (sse && !upstream.body) throw new GatewayError(502, '上游流式响应为空。');
        if (bridge.stream && sse) {
          const transform = bridge.kind === 'native-messages' ? createNativeMessagesStream(model.alias, { onUpstreamEvent: observe, signal: controller.signal }) : bridge.kind === 'chat-responses' ? createResponsesChatStream(model.alias, { onUpstreamEvent: observe, signal: controller.signal }) : createAnthropicStream(model.wireApi, model.alias, { onUpstreamEvent: observe });
          let source = upstream.body!.pipeThrough(transform, { signal: controller.signal });
          if (jetBrains) source = source.pipeThrough(createJetBrainsChatStream(model.alias), { signal: controller.signal });
          reader = source.getReader();
          // 修改点：Koog 会吞掉中途断流；只向 JetBrains 发布已完整校验的 SSE。
          const complete = jetBrains ? await completeJetBrainsStream(reader) : undefined;
          response.statusCode = upstream.status;
          response.setHeader('content-type', 'text/event-stream; charset=utf-8'); response.setHeader('cache-control', 'no-cache'); response.setHeader('x-accel-buffering', 'no');
          response.flushHeaders();
          if (complete) for (const chunk of complete) await write(response, chunk, controller.signal);
          else while (true) { const item = await reader.read(); if (item.value) await write(response, item.value, controller.signal); if (item.done) break; }
          response.end();
        } else {
          let message: Json;
          if (sse) message = bridge.kind === 'native-messages' ? await collectNativeMessagesStream(upstream.body!, model.alias, { onUpstreamEvent: observe, signal: controller.signal }) : bridge.kind === 'chat-responses' ? await collectResponsesChatStream(upstream.body!, model.alias, { onUpstreamEvent: observe, signal: controller.signal }) : await collectAnthropicStream(upstream.body!, model.wireApi, model.alias, { onUpstreamEvent: observe, signal: controller.signal });
          else {
            const raw = await limitedText(upstream);
            let value: unknown; try { value = JSON.parse(raw); } catch { throw new GatewayError(502, '上游成功响应不是有效 JSON。'); }
            if (bridge.kind === 'native-messages') message = toNativeMessagesResponse(value, model.alias, { onUpstreamEvent: observe });
            else { observe(value); message = bridge.kind === 'chat-responses' ? responsesToChat(value, model.alias) : toAnthropicResponse(value, model.wireApi, model.alias); }
          }
          if (bridge.stream) {
            response.statusCode = upstream.status; response.setHeader('content-type', 'text/event-stream; charset=utf-8'); response.setHeader('cache-control', 'no-cache');
            response.end(bridge.kind === 'native-messages' ? nativeMessagesToSse(message) : bridge.kind === 'chat-responses' ? chatResponseToSse(message) : anthropicMessageToSse(message));
          } else jsonResponse(response, upstream.status, message);
        }
      } else if (sse && !stream) {
        if (model.wireApi !== 'responses') throw new GatewayError(502, '上游返回流式 Chat 响应，无法作为非流式结果返回。');
        if (!upstream.body) throw new GatewayError(502, '上游流式响应为空。');
        reader = upstream.body.getReader();
        const frames = new SseFrames(); const collector = new ResponsesCollector();
        while (true) { const item = await reader.read(); for (const frame of frames.feed(item.value ?? new Uint8Array(), item.done)) { const value = sseData(frame); observe(value); collector.add(value); } if (item.done) break; }
        jsonResponse(response, upstream.status, collector.result(model.alias));
      } else if (stream) {
        if (jetBrains) {
          let source: ReadableStream<Uint8Array>;
          if (sse) { if (!upstream.body) throw new JetBrainsChatError(); source = upstream.body; }
          else {
            let value: unknown; try { value = JSON.parse(await limitedText(upstream)); } catch { throw new JetBrainsChatError(); }
            observe(value);
            const payload = chatResponseToSse(normalizeJetBrainsChatResponse(value, model.alias));
            source = new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } });
          }
          reader = source.pipeThrough(createJetBrainsChatStream(model.alias, sse ? observe : undefined), { signal: controller.signal }).getReader();
          const complete = await completeJetBrainsStream(reader);
          response.statusCode = upstream.status; response.setHeader('content-type', 'text/event-stream; charset=utf-8');
          response.setHeader('cache-control', 'no-cache'); response.setHeader('x-accel-buffering', 'no'); response.flushHeaders();
          for (const chunk of complete) await write(response, chunk, controller.signal);
          response.end(); return;
        }
        response.statusCode = upstream.status;
        response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
        response.setHeader('cache-control', 'no-cache');
        if (sse) response.setHeader('x-accel-buffering', 'no');
        response.flushHeaders();
        if (upstream.body) {
          reader = upstream.body.getReader(); const frames = new SseFrames();
          while (true) {
            const item = await reader.read();
            if (sse) for (const frame of frames.feed(item.value ?? new Uint8Array(), item.done)) { try { observe(sseData(frame)); } catch { /* invalid frames still pass through unchanged */ } await write(response, mappedSse(frame, model.alias), controller.signal); }
            else if (item.value) await write(response, item.value, controller.signal);
            if (item.done) break;
          }
        }
        response.end();
      } else {
        const raw = await limitedText(upstream);
        let value: unknown;
        try { value = JSON.parse(raw); } catch { throw new GatewayError(502, '上游成功响应不是有效 JSON。'); }
        if (!isObject(value)) throw new GatewayError(502, '上游成功响应不是 JSON 对象。');
        observe(value);
        jsonResponse(response, upstream.status, jetBrains ? normalizeJetBrainsChatResponse(value, model.alias) : aliasResponse(value, model.alias));
      }
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof GatewayError)) throw new GatewayError(response.destroyed ? 499 : 504, '请求已取消或超时。');
      throw error;
    } finally {
      clearTimeout(timeout); response.removeListener('close', disconnect); this.controllers.delete(controller);
      if (reader) { try { await reader.cancel(); } catch { /* disconnected */ } reader.releaseLock(); }
      else if (upstream?.body && !upstream.bodyUsed) { try { await upstream.body.cancel(); } catch { /* already closed */ } }
    }
  }
  private prepareApiKey(provider: Provider, secret: ProviderSecret, path: string, body: Json): PreparedRequest {
    if (provider.kind !== 'openai-compatible' || !secret.apiKey) throw new GatewayError(503, '此供应商需要完成订阅 OAuth 登录。');
    return { url: `${provider.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/v1\//, '')}`, headers: { authorization: `Bearer ${secret.apiKey}` }, body };
  }
}
