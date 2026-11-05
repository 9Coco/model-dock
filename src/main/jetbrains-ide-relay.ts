import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface JetBrainsIdeRelayAdapter {
  models(signal: AbortSignal): Promise<{ data: { id: string; object: 'model' }[] }>;
  chat(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}
export class JetBrainsIdeRelayFailure extends Error {}
interface RelaySession { owner: string; key: string; server: Server; controllers: Set<AbortController>; started: Promise<void> }
const safeKey = (key: string) => /^[\x21-\x7e]{32,512}$/.test(key);
function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function failure(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: { message, type: 'jetbrains_relay_error' } });
}

/** Owns only this process's loopback listener. Native JBA/Grazie credentials
 * remain behind the adapter; callers authenticate with a separate local key. */
export class JetBrainsIdeRelay {
  private current?: RelaySession;
  constructor(private readonly port = 18081) {}
  baseUrl(): string | undefined {
    const address = this.current?.server.address();
    return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}/v1` : undefined;
  }
  isRunning(key: string, owner?: string): boolean {
    const state = this.current;
    return !!state?.server.listening && same(state.key, key) && (!owner || state.owner === owner);
  }
  start(key: string, owner: string, adapter: JetBrainsIdeRelayAdapter): Promise<void> {
    if (!safeKey(key) || !owner || owner.length > 160) return Promise.reject(new JetBrainsIdeRelayFailure('JetBrains 本机中转参数无效。'));
    if (this.current) return same(this.current.key, key) && this.current.owner === owner ? this.current.started : Promise.reject(new JetBrainsIdeRelayFailure('JetBrains 本机中转正在连接另一个账号，请先停止中转。'));
    const server = createServer(), state: RelaySession = { key, owner, server, controllers: new Set(), started: Promise.resolve() };
    this.current = state;
    server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 64;
    server.on('request', (request, response) => { void this.handle(state, adapter, request, response).catch(() => failure(response, 502, 'JetBrains 本机中转请求未能完成。')); });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('close', () => { if (this.current === state) this.current = undefined; });
    state.started = new Promise<void>((resolve, reject) => {
      const error = () => { if (this.current === state) this.current = undefined; reject(new JetBrainsIdeRelayFailure('JetBrains 本机中转端口被占用或无法监听，请停止冲突服务后重试。')); };
      server.once('error', error);
      server.listen({ host: '127.0.0.1', port: this.port, exclusive: true }, () => { server.off('error', error); server.on('error', () => { void this.stop(); }); resolve(); });
    });
    return state.started;
  }
  async stop(): Promise<void> {
    const state = this.current; if (!state) return;
    await state.started.catch(() => {});
    if (this.current !== state) return;
    this.current = undefined;
    for (const controller of state.controllers) controller.abort();
    if (!state.server.listening) return;
    await new Promise<void>(resolve => { state.server.close(() => resolve()); state.server.closeAllConnections(); });
  }
  private async handle(state: RelaySession, adapter: JetBrainsIdeRelayAdapter, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !same(authorization.slice(7), state.key)) { failure(response, 401, '本机中转密钥无效。'); return; }
    if (this.current !== state) { failure(response, 503, 'JetBrains 本机中转已停止。'); return; }
    const controller = new AbortController(); state.controllers.add(controller);
    const abort = () => controller.abort();
    request.once('aborted', abort); response.once('close', abort);
    const timeout = setTimeout(abort, 180_000); timeout.unref();
    try {
      if (request.method === 'GET' && request.url === '/v1/models') { json(response, 200, { object: 'list', ...await adapter.models(controller.signal) }); return; }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { failure(response, 404, '此中转仅支持已声明的模型目录与 Chat Completions 接口。'); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { failure(response, 415, '请求格式必须为 JSON。'); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const part of request) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { failure(response, 413, '请求内容超出支持范围。'); return; }
        if (controller.signal.aborted) return;
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { failure(response, 400, '请求 JSON 无效。'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).model !== 'string') { failure(response, 400, '请选择有效的模型。'); return; }
      const result = await adapter.chat(body as Record<string, unknown>, controller.signal);
      if (!result.ok) { await result.body?.cancel(); failure(response, result.status >= 400 && result.status <= 599 ? result.status : 502, 'JetBrains 未接受模型请求，请检查会员权限与账号授权。'); return; }
      const type = result.headers.get('content-type') ?? '';
      if (!/^(?:application\/json|text\/event-stream)(?:\s*;|$)/i.test(type) || !result.body) { await result.body?.cancel(); failure(response, 502, 'JetBrains 返回了无法识别的模型结果。'); return; }
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      const reader = result.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read(); if (done) break;
          if (!response.write(value)) await new Promise<void>(resolve => {
            const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
            response.once('drain', done); response.once('close', done);
          });
        }
        if (controller.signal.aborted) response.destroy(); else response.end();
      } finally { controller.signal.removeEventListener('abort', cancel); if (controller.signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (response.headersSent) response.destroy();
      else failure(response, controller.signal.aborted ? 504 : 502, error instanceof JetBrainsIdeRelayFailure ? error.message : 'JetBrains 模型服务暂不可用，请检查授权与连接后重试。');
    } finally { clearTimeout(timeout); state.controllers.delete(controller); request.off('aborted', abort); response.off('close', abort); }
  }
}
