import { createHash } from 'node:crypto';
import type { SubscriptionUsage } from '../shared/auth-types';
import { version } from '../../package.json';
import { JetBrainsIdeApi } from './jetbrains-ide-api';

// First-party Central CLI 2.2.0, af7b8a704ca53f1754d6a77ddf5f0cc0e1651de0:
// auth.TokenTransfer / RefreshJBA and oauth.Client.RefreshTokens. The native
// proxy contract is also documented at
// https://www.jetbrains.com/help/central-cli/cli-in-depth.html .
// License requests target /user/v5/llm and use Grazie-Authenticate-JWT.
// Workspace and Enterprise need their own audience and governance contracts;
// they must never fall back to a personal license or a resident CLI proxy.
const ORIGIN = 'https://api.jetbrains.ai';
const OAUTH = 'https://oauth.account.jetbrains.com/oauth2/token';
const MAX_JSON = 4 * 1024 * 1024, MAX_STREAM = 32 * 1024 * 1024;
type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown, maximum = 256): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const identifier = (value: unknown): string | undefined => { const result = text(value); return result && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(result) ? result : undefined; };
export type CentralApiErrorCode = 'format' | 'unsupported' | 'authorization' | 'network' | 'response' | 'cancelled' | 'model' | 'request' | 'limit';
const messages: Record<CentralApiErrorCode, string> = {
  format: 'Central 当前会话的导出格式无法识别，请更新客户端并重新连接。',
  unsupported: '此 Central 登录使用工作区、企业或未核实的访问方式；当前原生连接仅支持个人 AI 许可证，请明确选择受支持的 IDE 许可证重新导入。',
  authorization: 'Central 账号授权已失效，请在 Central CLI 登录后重新连接。',
  network: 'JetBrains 官方服务暂时无法连接，请检查应用网络后重试。',
  response: 'JetBrains 官方服务返回了无法识别的数据，本次请求未被标记为成功。',
  cancelled: 'JetBrains 请求已取消或超时。',
  model: '所选模型不在此 Central 许可证的原生目录中，请刷新模型列表。',
  request: '当前 Central 模型不支持此接口，请选择对应的 OpenAI 或 Anthropic 原生协议。',
  limit: 'JetBrains 请求或响应超过支持范围。',
};
export class CentralApiError extends Error {
  constructor(readonly code: CentralApiErrorCode, readonly status?: number) { super(messages[code]); this.name = 'CentralApiError'; }
}
const fail = (code: CentralApiErrorCode, status?: number) => new CentralApiError(code, status);
export interface CentralTransfer { version: 1; environment: 'prod'; refreshToken: string; licenseId: string }
export interface CentralCredentials { token: string; accountId: string; accountLabel: string; licenseId: string; expiresAt: number }
export interface CentralModel { id: string; object: 'model'; owned_by: 'jetbrains'; name?: string; wire_api: 'chat-completions' | 'messages' }
interface NativeApi {
  exchange(input: { idToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }>;
  quota(token: string, signal?: AbortSignal): Promise<SubscriptionUsage>;
}
export interface CentralApiOptions { fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number; nativeApi?: NativeApi }

/** Parse the official bounded central- transfer envelope, never accept an
 * arbitrary endpoint or silently change the selected AI access source. */
export function parseCentralTransfer(input: string): CentralTransfer {
  if (typeof input !== 'string' || input.length > 65536) throw fail('format');
  const compact = input.replace(/\s/g, '');
  if (!/^central-[A-Za-z0-9_-]+$/.test(compact)) throw fail('format');
  const encoded = compact.slice(8);
  let raw: Json | undefined;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw fail('format');
    raw = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw fail('format'); }
  if (!raw || raw.version !== 1 || typeof raw.refresh_token !== 'string' || !raw.refresh_token || raw.refresh_token.length > 32768 || /[\s\x00-\x1f\x7f]/.test(raw.refresh_token)) throw fail('format');
  const access = object(raw.ai_access);
  if (raw.environment !== 'prod' || raw.server_url || access?.type !== 'license' || access.org_id || access.workspace_id) throw fail('unsupported');
  const licenseId = identifier(access.license_id);
  // A previous CLI consent is required. Import never accepts EAP terms for users.
  if (!licenseId || raw.eap_tos_accepted !== true) throw fail('format');
  return { version: 1, environment: 'prod', refreshToken: raw.refresh_token, licenseId };
}
function claims(token: unknown, now: number): Json {
  if (typeof token !== 'string' || token.length > 65536 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw fail('authorization');
  try {
    const [a, b] = token.split('.'), header = object(JSON.parse(Buffer.from(a, 'base64url').toString('utf8'))), result = object(JSON.parse(Buffer.from(b, 'base64url').toString('utf8')));
    if (!header || !text(header.alg) || String(header.alg).toLowerCase() === 'none' || !result || typeof result.exp !== 'number' || !Number.isSafeInteger(result.exp) || result.exp * 1000 <= now) throw fail('authorization');
    return result;
  } catch { throw fail('authorization'); }
}
function operation(parent: AbortSignal | undefined, timeout: number) {
  const controller = new AbortController(), abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout); timer.unref?.();
  return { signal: controller.signal, abort, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
async function json(response: Response, signal: AbortSignal): Promise<Json> {
  if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw fail('cancelled'); }
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel().catch(() => {}); throw fail('response'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) { const next = await reader.read(); if (signal.aborted) throw fail('cancelled'); if (next.done) break; size += next.value.length; if (size > MAX_JSON) throw fail('limit'); chunks.push(next.value); }
    const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); if (!value) throw fail('response'); return value;
  } catch (error) { throw error instanceof CentralApiError ? error : fail(signal.aborted ? 'cancelled' : 'response'); }
  finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
}

export class CentralApi {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly native: NativeApi;
  private readonly directories = new Map<string, { at: number; models: CentralModel[] }>();
  constructor(options: CentralApiOptions = {}) { this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now; this.timeout = options.timeoutMs ?? 300000; this.native = options.nativeApi ?? new JetBrainsIdeApi({ fetch: this.fetcher, now: this.now }); }
  private credentials(value: CentralCredentials): void {
    if (!value || !identifier(value.accountId) || !identifier(value.licenseId) || !text(value.accountLabel, 160) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) throw fail('authorization');
    claims(value.token, this.now());
  }
  private key(value: CentralCredentials): string { return createHash('sha256').update(value.token).digest('hex'); }
  private async send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw fail('cancelled');
    try {
      const response = await this.fetcher(url, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== new URL(url).origin) {
        await response.body?.cancel().catch(() => {}); throw fail(response.status === 401 || response.status === 403 ? 'authorization' : 'network', response.status);
      }
      return response;
    } catch (error) { throw error instanceof CentralApiError ? error : fail(signal.aborted ? 'cancelled' : 'network'); }
  }
  /** Explicit import only. Do not call at startup, inference, or quota refresh.
   * No refresh token is retained after deriving this bounded AI access session. */
  async connect(value: CentralTransfer, signal?: AbortSignal): Promise<CentralCredentials> {
    if (value?.version !== 1 || value.environment !== 'prod' || !identifier(value.licenseId) || !text(value.refreshToken, 32768) || /\s/.test(value.refreshToken)) throw fail('format');
    const op = operation(signal, Math.min(this.timeout, 30000));
    try {
      const response = await this.send(OAUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'central-cli', refresh_token: value.refreshToken }).toString() }, op.signal);
      const result = await json(response, op.signal), identity = claims(result.id_token, this.now()), accountId = identifier(identity.sub);
      if (!accountId) throw fail('authorization');
      const session = await this.native.exchange({ idToken: String(result.id_token), licenseId: value.licenseId }, op.signal);
      const access = claims(session.token, this.now()), expiry = typeof session.expiresAt === 'number' ? Math.min(session.expiresAt, Number(access.exp) * 1000) : Number(access.exp) * 1000;
      return { token: session.token, accountId, accountLabel: text(identity.email, 160) ?? text(identity.name, 160) ?? accountId, licenseId: value.licenseId, expiresAt: expiry };
    } catch (error) { throw error instanceof CentralApiError ? error : fail(op.signal.aborted ? 'cancelled' : 'authorization'); }
    finally { op.close(); }
  }
  async quota(value: CentralCredentials, signal?: AbortSignal): Promise<SubscriptionUsage> {
    this.credentials(value);
    try { return { ...await this.native.quota(value.token, signal), message: '当前 Central 个人 AI 许可证的官方额度。' }; } catch { throw fail(signal?.aborted ? 'cancelled' : 'network'); }
  }
  private auth(value: CentralCredentials): Record<string, string> { return { 'Grazie-Authenticate-JWT': value.token, 'Grazie-Agent': JSON.stringify({ name: 'modeldock', version }), 'X-Client-Feature-ID': 'modeldock' }; }
  async models(value: CentralCredentials, signal?: AbortSignal): Promise<{ object: 'list'; data: CentralModel[] }> {
    this.credentials(value); const key = this.key(value); this.directories.delete(key);
    const op = operation(signal, Math.min(this.timeout, 30000));
    try {
      const found: CentralModel[] = [];
      for (const provider of ['openai', 'anthropic'] as const) {
        const response = await this.send(`${ORIGIN}/user/v5/llm/${provider}/v1/models`, { method: 'GET', headers: { ...this.auth(value), Accept: 'application/json', ...(provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) } }, op.signal);
        const raw = await json(response, op.signal); if (!Array.isArray(raw.data) || raw.data.length > 10000) throw fail('response');
        const seen = new Set<string>();
        for (const row of raw.data) {
          const item = object(row), id = identifier(item?.id); if (!id || seen.has(id)) throw fail('response'); seen.add(id);
          found.push({ id: `${provider}/${id}`, object: 'model', owned_by: 'jetbrains', wire_api: provider === 'anthropic' ? 'messages' : 'chat-completions', ...(text(item?.display_name ?? item?.name, 160) ? { name: text(item?.display_name ?? item?.name, 160) } : {}) });
        }
      }
      this.directories.set(key, { at: this.now(), models: found }); if (this.directories.size > 16) this.directories.delete(this.directories.keys().next().value!);
      return { object: 'list', data: structuredClone(found) };
    } finally { op.close(); }
  }
  /** Native JSON or SSE bytes are pulled and forwarded immediately. The existing
   * Gateway validates client protocol termination and owns alias rewriting. */
  async request(value: CentralCredentials, path: string, body: Json, signal?: AbortSignal): Promise<Response> {
    this.credentials(value);
    const model = identifier(body.model), match = model && /^(openai|anthropic)\/(.+)$/.exec(model), route = path.replace(/^\/v1\//, '/');
    if (!match || body.stream !== undefined && typeof body.stream !== 'boolean') throw fail('request');
    const [, provider, nativeModel] = match;
    if (!['/chat/completions', '/responses', '/messages'].includes(route) || provider === 'anthropic' && route !== '/messages' || provider === 'openai' && route === '/messages') throw fail('request');
    const key = this.key(value); let directory = this.directories.get(key);
    if (!directory || this.now() - directory.at >= 300000) { await this.models(value, signal); directory = this.directories.get(key); }
    if (!directory?.models.some(row => row.id === model)) throw fail('model');
    let encoded: string; try { encoded = JSON.stringify({ ...body, model: nativeModel }); } catch { throw fail('request'); }
    if (Buffer.byteLength(encoded) > MAX_JSON) throw fail('limit');
    const op = operation(signal, this.timeout);
    try {
      const response = await this.send(`${ORIGIN}/user/v5/llm/${provider}/v1${route}`, { method: 'POST', headers: { ...this.auth(value), 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json', ...(provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) }, body: encoded }, op.signal);
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.body || !/^(?:text\/event-stream|application\/json)(?:\s*;|$)/i.test(contentType)) { await response.body?.cancel().catch(() => {}); throw fail('response'); }
      const reader = response.body.getReader(); let total = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); }; op.signal.addEventListener('abort', cancel, { once: true });
      const cleanup = () => { op.signal.removeEventListener('abort', cancel); op.close(); };
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const next = await reader.read(); if (op.signal.aborted) throw fail('cancelled'); if (next.done) { cleanup(); controller.close(); return; } total += next.value.length; if (total > MAX_STREAM) throw fail('limit'); controller.enqueue(next.value); }
          catch (error) { op.abort(); await reader.cancel().catch(() => {}); cleanup(); controller.error(error instanceof CentralApiError ? error : fail('network')); }
        },
        async cancel() { op.abort(); await reader.cancel().catch(() => {}); cleanup(); },
      }), { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' } });
    } catch (error) { op.abort(); op.close(); throw error instanceof CentralApiError ? error : fail('network'); }
  }
}
