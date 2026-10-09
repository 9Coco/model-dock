import type { AuthFailureCategory, AuthProgress, AuthStage, Provider, ProviderSecret } from '../shared/types';
import { normalizeApiKey } from './credentials';
import { anthropicEndpoint } from './anthropic-endpoint';
import { version as appVersion } from '../../package.json';
import { safeNetworkErrorCode } from './network-diagnostic';
import type { AuthNetworkErrorCode } from '../shared/network-types';

/** This first release implements the Codex / Grok public-client compatibility
 * flows. It does not claim to register ModelDock as a separate OAuth client.
 * OpenAI's newer SIWC dynamic-registration flow is a distinct future adapter:
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * Codex device protocol: openai/codex codex-rs/login/src/device_code_auth.rs.
 * Grok device protocol is RFC 8628, discovered on the official OIDC issuer. */
export interface OAuthStore {
  getProvider(id: string): Provider | undefined;
  getSecret(id: string): ProviderSecret | undefined;
  setSecret(id: string, secret: ProviderSecret): void | Promise<void>;
  setAuthStatus(id: string, status: Provider['authStatus']): void | Promise<void>;
}

export interface PreparedUpstream {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const CODEX_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH = 'https://auth.openai.com';
const CODEX_TOKEN = `${CODEX_AUTH}/oauth/token`;
// Legacy Codex catalog protocol version, independent of ModelDock's version.
// Keep query and version header aligned (CC Switch d455dd85 / native Codex).
export const CODEX_CATALOG_CLIENT_VERSION = '0.159.0';
const GROK_CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const GROK_DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration';
// Compatibility version required by the Grok CLI inference proxy; independent
// of ModelDock's version. Update this adapter if upstream returns HTTP 426.
const GROK_COMPAT_VERSION = '1.0.44';
const REQUEST_TIMEOUT = 30_000;
const REFRESH_LEAD = 60_000;

type Json = Record<string, unknown>;
interface LoginSession {
  controller: AbortController;
  progress: AuthProgress;
  epoch: number;
  previousAuthStatus: Provider['authStatus'];
}
interface OAuthResponse { status: number; ok: boolean; payload: Json; format: 'json' | 'html' | 'other'; contentType: string }
class OAuthFailure extends Error {
  constructor(message: string, readonly category: AuthFailureCategory, readonly stage: AuthStage, readonly statusCode?: number, readonly errorCode?: AuthNetworkErrorCode) { super(message); }
}
const stageNames: Record<AuthStage, string> = { 'device-code': '申请设备码', 'device-poll': '等待设备授权', 'token-exchange': '换取授权凭据', 'account-info': '读取账号信息', refresh: '续期授权', discovery: '读取授权服务配置' };
const MAX_AUTH_RESPONSE_BYTES = 128 * 1024;
interface DeviceGrant {
  tokenEndpoint: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  deadline: number;
}

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function cancelled(): Error { return new DOMException('授权已取消', 'AbortError'); }
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

function wait(ms: number, signal: AbortSignal): Promise<void> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function oauthUrl(raw: unknown, provider: 'codex' | 'grok', verification = false): string {
  const value = text(raw);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('授权服务返回了无效地址'); }
  const host = url.hostname.toLowerCase();
  const allowed = provider === 'codex'
    ? host === 'auth.openai.com'
    : host === 'x.ai' || host.endsWith('.x.ai') || (verification && (host === 'grok.com' || host.endsWith('.grok.com')));
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('授权地址必须位于官方 HTTPS 域名');
  }
  return url.toString();
}

/** Custom API endpoints use HTTPS, or HTTP only on the local loopback. */
export function upstreamEndpoint(baseUrl: string, path: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('请填写有效的 API 地址'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash || url.search) {
    throw new Error('API 地址必须使用 HTTPS，或本机 HTTP 回环地址，且不能包含凭据、查询或片段');
  }
  const route = path.replace(/^\/v1\//, '/');
  if (!['/models', '/responses', '/chat/completions'].includes(route)) throw new Error('此版本不支持该 API 路由');
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}${route}`;
  return url.toString();
}

/** Preserve the configured route while adding the native Codex catalog contract. */
export function modelCatalogEndpoint(provider: Provider): string {
  if (provider.kind === 'openai-compatible' && provider.presetId === 'anthropic') return anthropicEndpoint(provider.baseUrl, '/models');
  const url = new URL(upstreamEndpoint(provider.baseUrl, '/models'));
  if (provider.kind === 'codex') url.searchParams.set('client_version', CODEX_CATALOG_CLIENT_VERSION);
  return url.toString();
}

function claims(token: unknown): Json {
  // Only decode metadata delivered by the HTTPS token endpoint. This is not
  // ID-token signature validation or a substitute for a SIWC account identity.
  try { return record(JSON.parse(Buffer.from(text(token).split('.')[1], 'base64url').toString('utf8'))); }
  catch { return {}; }
}

function tokenSecret(payload: Json, previous: ProviderSecret, tokenEndpoint: string, kind: Provider['kind']): ProviderSecret {
  const accessToken = text(payload.access_token);
  if (!accessToken) throw new Error('授权服务未返回有效访问凭据');
  if (payload.token_type && text(payload.token_type).toLowerCase() !== 'bearer') throw new Error('授权服务返回了不支持的凭据类型');
  const accessClaims = claims(accessToken);
  const idClaims = claims(payload.id_token);
  const authClaims = record(idClaims['https://api.openai.com/auth'] ?? accessClaims['https://api.openai.com/auth']);
  const jwtExpiry = Number(accessClaims.exp) * 1000;
  const lifetime = Number(payload.expires_in);
  const expiresAt = Number.isFinite(lifetime) && lifetime > 0 ? Date.now() + lifetime * 1000
    : Number.isFinite(jwtExpiry) && jwtExpiry > Date.now() ? jwtExpiry : Date.now() + 3_600_000;
  return {
    accessToken,
    idToken: text(payload.id_token) || previous.idToken,
    refreshToken: text(payload.refresh_token) || previous.refreshToken,
    expiresAt,
    accountId: kind === 'grok' ? text(idClaims.sub) || text(accessClaims.sub) || previous.accountId
      : text(authClaims.chatgpt_account_id) || text(accessClaims.chatgpt_account_id) || previous.accountId,
    tokenEndpoint,
  };
}

function errorCode(payload: Json): string {
  const error = record(payload.error);
  return text(typeof payload.error === 'string' ? payload.error : error.code ?? error.type ?? payload.code).toLowerCase();
}
function declaresError(payload: Json): boolean { return payload.error != null || typeof payload.code === 'string' && payload.code.length > 0; }
function safeOAuthFailure(response: OAuthResponse, stage: AuthStage): OAuthFailure {
  // Error bodies may echo tokens. Recognize a small semantic set internally;
  // only controlled categories, stage and HTTP status cross the preload bridge.
  const { status, payload, format } = response;
  const code = errorCode(payload);
  const http = `（HTTP ${status}）`;
  if (code === 'unsupported_country_region_territory') return new OAuthFailure(`${stageNames[stage]}失败${http}：授权请求的网络出口所在地区未受支持，请检查系统代理与网络出口。`, 'region', stage, status);
  if (['device_auth_disabled', 'device_code_disabled', 'device_authorization_disabled'].includes(code)) return new OAuthFailure(`${stageNames[stage]}失败${http}：账号尚未启用设备码授权，请在 ChatGPT 安全设置中启用后重试。`, 'device-disabled', stage, status);
  if (code === 'access_denied') return new OAuthFailure(`你拒绝了授权${http}，请重新登录。`, 'denied', stage, status);
  if (code === 'invalid_grant' || code === 'invalid_token') return new OAuthFailure(`${stageNames[stage]}失败${http}：授权凭据已失效，请重新登录。`, 'expired', stage, status);
  if (code === 'expired_token' || status === 410 && ['device-code', 'device-poll'].includes(stage)) return new OAuthFailure(`设备码已过期${http}，请重新登录。`, 'expired', stage, status);
  if (code === 'invalid_grant') return new OAuthFailure(`授权凭据已失效${http}，请重新登录。`, 'expired', stage, status);
  if (status === 429 || code === 'slow_down') return new OAuthFailure(`${stageNames[stage]}请求过于频繁${http}，请稍后再试。`, 'rate-limit', stage, status);
  if (format !== 'json' && [403, 404].includes(status)) return new OAuthFailure(`${stageNames[stage]}收到非 JSON 的拒绝响应${http}，授权请求被拦截。请检查系统代理或稍后重试。`, 'blocked', stage, status);
  return new OAuthFailure(`${stageNames[stage]}失败${http}，上游未接受此授权请求。请检查网络或稍后重试。`, 'upstream', stage, status);
}

/** Native Responses forwarding preserves tool calls and tool result history.
 * Chat Completions -> Responses conversion is deliberately not implemented. */
export function prepareUpstream(provider: Provider, secret: ProviderSecret, path: string, input: Record<string, unknown>): PreparedUpstream {
  const route = path.replace(/^\/v1\//, '/');
  const body = structuredClone(input);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' };
  if (provider.kind === 'openai-compatible') {
    if (!secret.apiKey) throw new Error('该来源还没有配置 API Key');
    // 修改点：原生 Messages 不经 OpenAI 协议转换，使用独立路径和鉴权头。
    if (route === '/messages' || route === '/models' && (provider.presetId === 'anthropic' || path === '/v1/models')) {
      // 修改点：测试和 Claude 配置使用相同的鉴权方式，不用双头请求掩盖兼容错误。
      if (provider.messagesAuth === 'api-key') headers['x-api-key'] = normalizeApiKey(secret.apiKey);
      else headers.Authorization = `Bearer ${normalizeApiKey(secret.apiKey)}`;
      headers['anthropic-version'] = '2023-06-01';
      return { url: anthropicEndpoint(provider.baseUrl, route), headers, body };
    }
    headers.Authorization = `Bearer ${normalizeApiKey(secret.apiKey)}`;
    return { url: upstreamEndpoint(provider.baseUrl, route), headers, body };
  }
  if (provider.kind === 'copilot') throw new Error('Copilot 订阅请求必须通过本机账号管理器准备。');
  if (!secret.accessToken) throw new Error('该来源还没有完成订阅授权');
  if (!['/responses', '/models'].includes(route)) throw new Error('订阅来源仅支持原生 Responses 协议，请选择 Responses 模型');
  headers.Authorization = `Bearer ${secret.accessToken}`;
  if (provider.kind === 'codex') {
    const base = provider.baseUrl || 'https://chatgpt.com/backend-api/codex';
    const url = new URL(upstreamEndpoint(base, route));
    if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/codex/')) {
      throw new Error('Codex 订阅凭据只能发送到官方 Codex 后端');
    }
    headers['User-Agent'] = `ModelDock/${appVersion}`;
    headers.Originator = 'modeldock';
    if (secret.accountId) headers['ChatGPT-Account-Id'] = secret.accountId;
    if (route === '/models') {
      url.searchParams.set('client_version', CODEX_CATALOG_CLIENT_VERSION);
      headers.Originator = 'codex_cli_rs';
      headers.version = CODEX_CATALOG_CLIENT_VERSION;
      headers.Accept = 'application/json';
    }
    if (route === '/responses') {
      body.store = false;
      body.stream = true;
      body.parallel_tool_calls = body.parallel_tool_calls ?? true;
      body.instructions = body.instructions ?? '';
      body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), 'reasoning.encrypted_content'])];
      for (const field of ['max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'truncation', 'user', 'context_management', 'prompt_cache_options', 'prompt_cache_retention']) delete body[field];
      if (typeof body.input === 'string') body.input = [{ role: 'user', type: 'message', content: [{ type: 'input_text', text: body.input }] }];
      if (Array.isArray(body.input)) body.input = body.input.map((value) => {
        const item = record(value);
        const next = { ...item };
        if (next.role === 'system') next.role = 'developer';
        if (next.type === 'function_call' && typeof next.arguments === 'string' && !next.arguments.trim()) next.arguments = '{}';
        delete next.prompt_cache_breakpoint;
        for (const field of ['content', 'output']) {
          if (Array.isArray(next[field])) next[field] = (next[field] as unknown[]).map((part) => {
            if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
            const clean = { ...record(part) }; delete clean.prompt_cache_breakpoint; return clean;
          });
        }
        return next;
      });
      headers.Accept = 'text/event-stream';
    }
    return { url: url.toString(), headers, body };
  }
  const base = provider.baseUrl || 'https://cli-chat-proxy.grok.com/v1';
  const url = new URL(upstreamEndpoint(base, route));
  if (!['https://cli-chat-proxy.grok.com', 'https://api.x.ai'].includes(url.origin)) throw new Error('Grok 订阅凭据只能发送到官方后端');
  if (route === '/responses') { body.stream = true; headers.Accept = 'text/event-stream'; }
  if (url.origin === 'https://cli-chat-proxy.grok.com') {
    headers['X-XAI-Token-Auth'] = 'xai-grok-cli';
    headers['x-grok-client-version'] = GROK_COMPAT_VERSION;
    headers['x-grok-client-identifier'] = 'grok-shell';
    headers['x-authenticateresponse'] = 'authenticate-response';
    headers['User-Agent'] = `xai-grok-workspace/${GROK_COMPAT_VERSION}`;
    if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length < 200) headers['x-grok-conv-id'] = body.prompt_cache_key;
  }
  return { url: url.toString(), headers, body };
}

export class OAuthManager {
  private readonly fetcher: typeof fetch;
  private readonly sessions = new Map<string, LoginSession>();
  private readonly epochs = new Map<string, number>();
  private readonly refreshes = new Map<string, { promise: Promise<ProviderSecret>; controller: AbortController }>();
  private disposed = false;

  constructor(private readonly store: OAuthStore, private readonly options: { openExternal: (url: string) => Promise<void>; fetch?: typeof fetch }) {
    this.fetcher = options.fetch ?? fetch;
  }

  progress(id: string): AuthProgress | null { const p = this.sessions.get(id)?.progress; return p ? { ...p } : null; }

  cancel(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const session = this.sessions.get(id);
    if (session) {
      session.controller.abort();
      if (session.progress.state === 'pending') session.progress = { providerId: id, state: 'cancelled', message: '授权已取消' };
    }
    this.refreshes.get(id)?.controller.abort();
    if (session?.progress.state === 'cancelled' && this.store.getProvider(id)) {
      const secret = this.store.getSecret(id);
      const restored = session.previousAuthStatus === 'ready' && secret?.accessToken && (!secret.expiresAt || secret.expiresAt > Date.now()) ? 'ready'
        : session.previousAuthStatus === 'error' || secret?.accessToken ? 'error' : 'missing';
      void this.store.setAuthStatus(id, restored);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of new Set([...this.sessions.keys(), ...this.refreshes.keys()])) this.cancel(id);
  }

  async beginLogin(id: string): Promise<AuthProgress> {
    if (this.disposed) throw new Error('授权服务已经关闭');
    const provider = this.store.getProvider(id);
    if (!provider || (provider.kind !== 'codex' && provider.kind !== 'grok')) throw new Error('请选择 Codex 或 Grok 订阅来源；Copilot 使用 GitHub 授权入口。');
    const previousAuthStatus = provider.authStatus === 'signing-in' ? this.sessions.get(id)?.previousAuthStatus ?? provider.authStatus : provider.authStatus;
    this.cancel(id);
    const session: LoginSession = { controller: new AbortController(), epoch: this.epochs.get(id) ?? 0, previousAuthStatus, progress: { providerId: id, state: 'pending', stage: provider.kind === 'codex' ? 'device-code' : 'discovery', message: '正在申请设备码…' } };
    this.sessions.set(id, session);
    await this.store.setAuthStatus(id, 'signing-in');
    try {
      const device = await this.requestDevice(provider, session.controller.signal);
      assertActive(session.controller.signal);
      const compat = provider.kind === 'codex' ? 'Codex 兼容授权' : 'Grok CLI 兼容授权';
      session.progress = { providerId: id, state: 'pending', stage: 'device-poll', userCode: device.userCode, verificationUri: device.verificationUri, message: `请在浏览器完成 ${compat}；仅输入由你自己发起的设备码。` };
      try { await this.options.openExternal(device.verificationUri); }
      catch { session.progress.message = `浏览器未能自动打开，请手动访问上方地址并输入设备码（${compat}）。`; }
      assertActive(session.controller.signal);
      void this.poll(provider, session, device);
    } catch (error) {
      await this.failSession(id, session, error);
    }
    return { ...session.progress };
  }

  async prepareRequest(provider: Provider, path: string, body: Record<string, unknown>): Promise<PreparedUpstream> {
    if (this.disposed) throw new Error('授权服务已经关闭');
    let secret = this.store.getSecret(provider.id);
    if (!secret) throw new Error('该来源尚未配置凭据');
    if (provider.kind !== 'openai-compatible' && secret.expiresAt && secret.expiresAt <= Date.now() + REFRESH_LEAD) {
      if (secret.refreshToken) secret = await this.refresh(provider);
      else if (secret.expiresAt <= Date.now()) { await this.store.setAuthStatus(provider.id, 'error'); throw new Error('订阅凭据已过期，请重新登录'); }
    }
    return prepareUpstream(provider, secret, path, body);
  }

  private async request(url: string, init: RequestInit, parent: AbortSignal, maxMs = REQUEST_TIMEOUT, stage: AuthStage = 'discovery'): Promise<OAuthResponse> {
    assertActive(parent);
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const stop = () => rejectAbort(parent.aborted ? cancelled() : new OAuthFailure(`${stageNames[stage]}超时，请稍后重试。`, 'timeout', stage));
    controller.signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(abort, Math.max(1, Math.min(REQUEST_TIMEOUT, maxMs)));
    let statusCode: number | undefined;
    try {
      const send = async (): Promise<OAuthResponse> => {
        const headers = new Headers(init.headers);
        headers.set('User-Agent', `ModelDock/${appVersion}`);
        // Desktop injects Electron's native network transport to use the system
        // proxy. Pure/mock usage retains fetch injection and never needs Electron.
        const response = await this.fetcher(url, { ...init, headers, credentials: 'omit', signal: controller.signal, redirect: 'error' });
        statusCode = response.status;
        assertActive(controller.signal);
        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_AUTH_RESPONSE_BYTES) { void response.body?.cancel().catch(() => undefined); throw new OAuthFailure('授权服务返回内容过大，已停止读取。', 'invalid-response', stage, response.status); }
        const reader = response.body?.getReader();
        if (!reader) {
          if (!response.ok) return { status: response.status, ok: false, payload: {}, format: contentType === 'text/html' ? 'html' : 'other', contentType };
          throw new OAuthFailure('授权服务返回了空响应。', 'invalid-response', stage, response.status);
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const cancelReader = () => { void reader.cancel().catch(() => undefined); };
        controller.signal.addEventListener('abort', cancelReader, { once: true });
        try {
          while (true) {
            assertActive(controller.signal);
            const part = await reader.read();
            assertActive(controller.signal);
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > MAX_AUTH_RESPONSE_BYTES) { cancelReader(); throw new OAuthFailure('授权服务返回内容过大，已停止读取。', 'invalid-response', stage, response.status); }
            chunks.push(part.value);
          }
        } finally { controller.signal.removeEventListener('abort', cancelReader); reader.releaseLock(); }
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload: Json = {}, format: OAuthResponse['format'] = contentType === 'text/html' || /^\s*</.test(raw) ? 'html' : 'other';
        try {
          const value: unknown = JSON.parse(raw);
          if (value !== null && typeof value === 'object' && !Array.isArray(value) && (!contentType || contentType === 'application/json' || contentType.endsWith('+json'))) { payload = record(value); format = 'json'; }
        } catch { /* Failure bodies are classified without exposing their text. */ }
        if (response.ok && format !== 'json') throw new OAuthFailure('授权服务返回了无效的 JSON 响应。', 'invalid-response', stage, response.status);
        assertActive(controller.signal);
        return { status: response.status, ok: response.ok, payload, format, contentType };
      };
      return await Promise.race([send(), aborted]);
    } catch (error) {
      if (parent.aborted) throw cancelled();
      // Network exception details can contain request URLs or credential data.
      if (error instanceof OAuthFailure) throw error;
      throw new OAuthFailure(controller.signal.aborted ? `${stageNames[stage]}超时，请稍后重试。` : `无法连接授权服务，请检查系统代理与网络后重试（${stageNames[stage]}）。`, controller.signal.aborted ? 'timeout' : 'network', stage, statusCode, controller.signal.aborted ? 'ERR_TIMED_OUT' : safeNetworkErrorCode(error));
    } finally { clearTimeout(timeout); parent.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', stop); controller.abort(); }
  }

  private post(url: string, values: Record<string, string>, signal: AbortSignal, json = false, maxMs = REQUEST_TIMEOUT, stage: AuthStage = 'discovery') {
    return this.request(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(values) : new URLSearchParams(values).toString() }, signal, maxMs, stage);
  }

  private async discover(signal: AbortSignal): Promise<{ device: string; token: string }> {
    const res = await this.request(GROK_DISCOVERY, { headers: { Accept: 'application/json' } }, signal, REQUEST_TIMEOUT, 'discovery');
    if (!res.ok || declaresError(res.payload)) throw safeOAuthFailure(res, 'discovery');
    if (text(res.payload.issuer).replace(/\/$/, '') !== 'https://auth.x.ai') throw new Error('Grok 授权发行者不匹配');
    return { device: oauthUrl(res.payload.device_authorization_endpoint, 'grok'), token: oauthUrl(res.payload.token_endpoint, 'grok') };
  }

  private async requestDevice(provider: Provider, signal: AbortSignal): Promise<DeviceGrant> {
    const codex = provider.kind === 'codex';
    const endpoints = codex ? { device: `${CODEX_AUTH}/api/accounts/deviceauth/usercode`, token: CODEX_TOKEN } : await this.discover(signal);
    const res = await this.post(endpoints.device, codex ? { client_id: CODEX_CLIENT } : { client_id: GROK_CLIENT, scope: GROK_SCOPE }, signal, codex, REQUEST_TIMEOUT, 'device-code');
    if (!res.ok || declaresError(res.payload)) throw safeOAuthFailure(res, 'device-code');
    const deviceCode = text(codex ? res.payload.device_auth_id : res.payload.device_code);
    const userCode = text(res.payload.user_code ?? res.payload.usercode);
    if (!deviceCode || !userCode) throw new OAuthFailure('授权服务没有返回设备码。', 'invalid-response', 'device-code', res.status);
    const verificationUri = oauthUrl(codex ? `${CODEX_AUTH}/codex/device` : res.payload.verification_uri_complete || res.payload.verification_uri, codex ? 'codex' : 'grok', true);
    const maxExpiry = codex ? 900 : 1800;
    return { tokenEndpoint: endpoints.token, deviceCode, userCode, verificationUri, intervalMs: Math.min(maxExpiry, positive(res.payload.interval, 5)) * 1000, deadline: Date.now() + Math.min(maxExpiry, positive(res.payload.expires_in, maxExpiry)) * 1000 };
  }

  private async poll(provider: Provider, session: LoginSession, device: DeviceGrant): Promise<void> {
    const signal = session.controller.signal;
    let interval = device.intervalMs;
    try {
      while (true) {
        assertActive(signal);
        if (Date.now() >= device.deadline) throw new OAuthFailure('设备码已过期，请重新登录。', 'expired', 'device-poll');
        const codex = provider.kind === 'codex';
        const res = await this.post(codex ? `${CODEX_AUTH}/api/accounts/deviceauth/token` : device.tokenEndpoint,
          codex ? { device_auth_id: device.deviceCode, user_code: device.userCode } : { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.deviceCode, client_id: GROK_CLIENT }, signal, codex, device.deadline - Date.now(), 'device-poll');
        if (Date.now() >= device.deadline) throw new OAuthFailure('设备码已过期，请重新登录。', 'expired', 'device-poll', res.status);
        const code = errorCode(res.payload);
        // A terminal OAuth error takes precedence over a retryable HTTP status.
        // Never keep polling after explicit denial or expired/invalid credentials.
        if (['access_denied', 'expired_token', 'invalid_grant', 'invalid_token', 'unsupported_country_region_territory', 'device_auth_disabled', 'device_code_disabled', 'device_authorization_disabled'].includes(code)) throw safeOAuthFailure(res, 'device-poll');
        // Codex's device token endpoint reports normal waiting with its own
        // nested error code. Recognize it only on the JSON 403/404 poll route;
        // device-code requests and real denial/block errors remain failures.
        const pending = code === 'authorization_pending' || (codex && [403, 404].includes(res.status) && res.format === 'json' && (code === 'deviceauth_authorization_pending' || !declaresError(res.payload)));
        if (pending || code === 'slow_down' || res.status === 429 || res.status >= 500) {
          if (code === 'slow_down' || res.status === 429) interval += 5000;
          if (res.status >= 500) interval *= 2;
          await wait(Math.min(interval, Math.max(1, device.deadline - Date.now())), signal);
          continue;
        }
        if (!res.ok || declaresError(res.payload)) throw safeOAuthFailure(res, 'device-poll');
        let payload = res.payload;
        if (codex) {
          const code = text(payload.authorization_code), verifier = text(payload.code_verifier);
          if (!code || !verifier) throw new OAuthFailure('授权服务没有返回有效授权码。', 'invalid-response', 'device-poll', res.status);
          session.progress = { ...session.progress, stage: 'token-exchange' };
          const exchange = await this.post(CODEX_TOKEN, { grant_type: 'authorization_code', client_id: CODEX_CLIENT, code, code_verifier: verifier, redirect_uri: `${CODEX_AUTH}/deviceauth/callback` }, signal, false, device.deadline - Date.now(), 'token-exchange');
          if (!exchange.ok || declaresError(exchange.payload)) throw safeOAuthFailure(exchange, 'token-exchange');
          payload = exchange.payload;
        }
        assertActive(signal);
        if (session.epoch !== this.epochs.get(provider.id) || !this.store.getProvider(provider.id)) throw cancelled();
        const secret = tokenSecret(payload, {}, device.tokenEndpoint, provider.kind);
        await this.store.setSecret(provider.id, secret);
        assertActive(signal);
        await this.store.setAuthStatus(provider.id, 'ready');
        session.progress = { providerId: provider.id, state: 'complete', message: '订阅授权已保存。模型权限仍需实际请求验证。' };
        return;
      }
    } catch (error) {
      await this.failSession(provider.id, session, Date.now() >= device.deadline ? new OAuthFailure('设备码已过期，请重新登录。', 'expired', session.progress.stage ?? 'device-poll') : error);
    }
  }

  private async failSession(id: string, session: LoginSession, error: unknown): Promise<void> {
    if (session.controller.signal.aborted || session.epoch !== this.epochs.get(id)) return;
    const failure = error instanceof OAuthFailure ? error : new OAuthFailure('授权服务返回了无效信息，请重新登录。', 'invalid-response', session.progress.stage ?? 'device-code');
    session.progress = { providerId: id, state: 'error', message: failure.message, stage: failure.stage, category: failure.category, ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }), ...(failure.errorCode ? { errorCode: failure.errorCode } : {}) };
    if (this.store.getProvider(id)) {
      const secret = this.store.getSecret(id);
      const keepReady = session.previousAuthStatus === 'ready' && !!secret?.accessToken && (!secret.expiresAt || secret.expiresAt > Date.now());
      await this.store.setAuthStatus(id, keepReady ? 'ready' : 'error');
    }
  }

  private refresh(provider: Provider): Promise<ProviderSecret> {
    const active = this.refreshes.get(provider.id);
    if (active) return active.promise;
    const controller = new AbortController(), epoch = this.epochs.get(provider.id) ?? 0;
    let expected: ProviderSecret | undefined;
    const unchanged = () => {
      const current = this.store.getSecret(provider.id);
      return !!expected && !!current && current.accessToken === expected.accessToken && current.refreshToken === expected.refreshToken;
    };
    const promise = (async () => {
      try {
        const old = this.store.getSecret(provider.id);
        expected = old;
        if (!old?.refreshToken) throw new Error('订阅凭据无法刷新，请重新登录');
        const endpoint = provider.kind === 'codex' ? CODEX_TOKEN
          : old.tokenEndpoint ? oauthUrl(old.tokenEndpoint, 'grok') : (await this.discover(controller.signal)).token;
        const res = await this.post(endpoint, { grant_type: 'refresh_token', client_id: provider.kind === 'codex' ? CODEX_CLIENT : GROK_CLIENT, refresh_token: old.refreshToken, ...(provider.kind === 'grok' ? { scope: GROK_SCOPE } : {}) }, controller.signal, false, REQUEST_TIMEOUT, 'refresh');
        assertActive(controller.signal);
        if (epoch !== (this.epochs.get(provider.id) ?? 0) || !this.store.getProvider(provider.id) || !unchanged()) throw cancelled();
        if (!res.ok || declaresError(res.payload)) throw safeOAuthFailure(res, 'refresh');
        const secret = tokenSecret(res.payload, old, endpoint, provider.kind);
        await this.store.setSecret(provider.id, secret);
        assertActive(controller.signal);
        await this.store.setAuthStatus(provider.id, 'ready');
        return secret;
      } catch (error) {
        const definitive = error instanceof OAuthFailure && ['region', 'device-disabled', 'denied', 'expired'].includes(error.category);
        const transient = !definitive && error instanceof OAuthFailure && (['network', 'timeout', 'rate-limit'].includes(error.category) || error.statusCode === 408 || (error.statusCode ?? 0) >= 500);
        if (!transient && !controller.signal.aborted && epoch === (this.epochs.get(provider.id) ?? 0) && this.store.getProvider(provider.id) && unchanged()) await this.store.setAuthStatus(provider.id, 'error');
        throw error;
      }
    })();
    this.refreshes.set(provider.id, { promise, controller });
    void promise.finally(() => { if (this.refreshes.get(provider.id)?.promise === promise) this.refreshes.delete(provider.id); }).catch(() => {});
    return promise;
  }
}
