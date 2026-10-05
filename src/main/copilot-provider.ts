import { createHash, randomUUID } from 'node:crypto';
import type { AuthProgress, Provider, ProviderSecret } from '../shared/types';
import type { PreparedUpstream } from './oauth';
import { isCopilotAccountId, type CopilotInferenceAuthorization } from './copilot-auth';

const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const COPILOT_API_BASE = 'https://api.githubcopilot.com';
const MAX_TOKEN_RESPONSE = 512 * 1024;
const TIMEOUT_MS = 15_000;
const REFRESH_LEAD_MS = 60_000;
const routes = new Set(['/models', '/chat/completions', '/responses']);

export interface CopilotProviderStore {
  getProvider(id: string): Provider | undefined;
  listProviders(): Provider[];
  getSecret(id: string): ProviderSecret | undefined;
  setSecret(id: string, secret: ProviderSecret): void;
  setAuthStatus(id: string, status: Provider['authStatus']): void;
}
export interface CopilotProviderAccounts {
  /** Main-process only: never expose this method through preload. */
  getInferenceAuthorization(id: string): CopilotInferenceAuthorization;
  beginLogin(providerId?: string): Promise<AuthProgress>;
  progress(): AuthProgress | null;
  cancel(): void;
}
interface ApiToken { token: string; baseUrl: string; refreshAt: number; identity: string }
interface Exchange { identity: string; controller: AbortController; promise: Promise<ApiToken> }
class CopilotProviderFailure extends Error {}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function route(path: string): string { return path.replace(/^\/v1\//, '/'); }

/** 修改点：Copilot 的账户端点由官方 token 返回，不能使用供应商自填的任意域名。 */
export function isCopilotUpstream(value: string, path: string): boolean {
  try {
    const url = new URL(value), expected = route(path), host = url.hostname.toLowerCase();
    return routes.has(expected) && url.protocol === 'https:' && (host === 'githubcopilot.com' || host.endsWith('.githubcopilot.com'))
      && !url.username && !url.password && (!url.port || url.port === '443') && !url.search && !url.hash && url.pathname === expected;
  } catch { return false; }
}
function apiBase(value: unknown): string {
  if (value === undefined) return COPILOT_API_BASE;
  if (typeof value !== 'string' || !value || value.length > 500) throw new CopilotProviderFailure('Copilot 返回了无效的模型服务地址，已停止发送凭据。');
  const base = value.replace(/\/$/, '');
  if (!isCopilotUpstream(`${base}/models`, '/models')) throw new CopilotProviderFailure('Copilot 模型服务地址必须位于官方 HTTPS 域名，已停止发送凭据。');
  return base;
}
function authorizationIdentity(auth: CopilotInferenceAuthorization): string {
  return createHash('sha256').update(auth.accessToken).update(`:${auth.revision}:${auth.expiresAt ?? ''}`).digest('hex');
}
function inferenceHeaders(): Record<string, string> {
  // Public compatibility contract from Microsoft's @vscode/copilot-api 0.5.2.
  // vscode-chat is reserved for the signed official extension; third-party
  // integrations use the package's code-oss fallback, without impersonation.
  return { 'User-Agent': 'ModelDock', 'Copilot-Integration-Id': 'code-oss', 'Editor-Version': 'vscode/1.110.1',
    'Editor-Plugin-Version': 'copilot-chat/0.38.2', 'X-GitHub-Api-Version': '2026-08-01' };
}

/** Copilot is a global subscription source, independently of desktop config sync. */
export class CopilotProviderManager {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, ApiToken>();
  private readonly exchanges = new Map<string, Exchange>();
  private readonly loginStatuses = new Map<string, Provider['authStatus']>();
  private disposed = false;
  constructor(private readonly store: CopilotProviderStore, private readonly accounts: CopilotProviderAccounts, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
  }
  private provider(id: string): Provider {
    if (this.disposed) throw new CopilotProviderFailure('Copilot 订阅服务已经关闭。');
    const provider = this.store.getProvider(id);
    if (!provider || provider.kind !== 'copilot') throw new CopilotProviderFailure('请选择 GitHub Copilot 订阅供应商。');
    apiBase(provider.baseUrl || COPILOT_API_BASE);
    return provider;
  }
  linkAccount(providerId: string, accountId: string): Provider {
    this.provider(providerId);
    if (!isCopilotAccountId(accountId)) throw new CopilotProviderFailure('请选择已登录的 GitHub Copilot 账户。');
    this.authorization(accountId);
    // 修改点：来源仅保存账户引用，GitHub 长期授权凭据始终留在原加密账户中。
    this.store.setSecret(providerId, { copilotAccountId: accountId });
    this.loginStatuses.delete(providerId);
    return this.store.getProvider(providerId)!;
  }
  async beginLogin(providerId: string): Promise<AuthProgress> {
    const provider = this.provider(providerId);
    for (const other of [...this.loginStatuses.keys()]) if (other !== providerId) this.cancel(other);
    this.loginStatuses.set(providerId, provider.authStatus === 'signing-in' ? provider.hasSecret ? 'ready' : 'missing' : provider.authStatus);
    this.store.setAuthStatus(providerId, 'signing-in');
    try {
      const progress = await this.accounts.beginLogin(providerId);
      this.finishLogin(providerId, progress);
      return progress;
    } catch { this.finishLogin(providerId, { providerId, state: 'error', message: '无法开始 GitHub 授权，请重新尝试。' }); throw new CopilotProviderFailure('无法开始 GitHub 授权，请重新尝试。'); }
  }
  private finishLogin(providerId: string, progress: AuthProgress): void {
    if (progress.state === 'pending' || !this.loginStatuses.has(providerId)) return;
    const oldStatus = this.loginStatuses.get(providerId)!;
    this.loginStatuses.delete(providerId);
    const provider = this.store.getProvider(providerId);
    if (!provider || provider.kind !== 'copilot') return;
    if (progress.state === 'error') this.store.setAuthStatus(providerId, 'error');
    else if (progress.state === 'cancelled') this.store.setAuthStatus(providerId, oldStatus);
  }
  progress(providerId: string): AuthProgress | null {
    const progress = this.accounts.progress();
    if (!progress || progress.providerId !== providerId) return null;
    this.finishLogin(providerId, progress);
    return progress;
  }
  cancel(providerId: string): void {
    const progress = this.accounts.progress();
    if (progress?.providerId === providerId) this.accounts.cancel();
    const oldStatus = this.loginStatuses.get(providerId);
    this.loginStatuses.delete(providerId);
    const provider = this.store.getProvider(providerId);
    if (oldStatus !== undefined && provider?.kind === 'copilot') this.store.setAuthStatus(providerId, oldStatus);
  }
  private invalidate(accountId: string): void {
    this.cache.delete(accountId);
    this.exchanges.get(accountId)?.controller.abort();
    this.exchanges.delete(accountId);
  }
  unlinkAccount(accountId: string): void {
    this.invalidate(accountId);
    for (const provider of this.store.listProviders()) if (provider.kind === 'copilot' && this.store.getSecret(provider.id)?.copilotAccountId === accountId) {
      this.cancel(provider.id); this.store.setSecret(provider.id, {});
    }
  }
  unlinkProvider(providerId: string): void {
    this.cancel(providerId);
    const accountId = this.store.getSecret(providerId)?.copilotAccountId;
    if (accountId) this.invalidate(accountId);
    if (this.store.getProvider(providerId)?.kind === 'copilot') this.store.setSecret(providerId, {});
  }
  dispose(): void {
    this.disposed = true;
    for (const exchange of this.exchanges.values()) exchange.controller.abort();
    this.cache.clear(); this.exchanges.clear(); this.loginStatuses.clear();
  }
  private authorization(accountId: string): CopilotInferenceAuthorization {
    try { return this.accounts.getInferenceAuthorization(accountId); }
    catch { throw new CopilotProviderFailure('GitHub 账户不可用或授权已失效，请选择账户或重新登录。'); }
  }
  private currentAccount(accountId: string, identity: string): boolean {
    if (this.disposed) return false;
    try { return authorizationIdentity(this.accounts.getInferenceAuthorization(accountId)) === identity; } catch { return false; }
  }
  private async readToken(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE) { void response.body?.cancel().catch(() => {}); throw new CopilotProviderFailure('Copilot 授权响应过大，已停止读取。'); }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mime && mime !== 'application/json' && !mime.endsWith('+json')) { void response.body?.cancel().catch(() => {}); throw new CopilotProviderFailure('Copilot 未返回有效的授权结果。'); }
    const reader = response.body?.getReader();
    if (!reader) throw new CopilotProviderFailure('Copilot 未返回有效的授权结果。');
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        if (signal.aborted) throw new CopilotProviderFailure('Copilot 授权请求已取消或超时。');
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_TOKEN_RESPONSE) { await reader.cancel(); throw new CopilotProviderFailure('Copilot 授权响应过大，已停止读取。'); }
        chunks.push(item.value);
      }
      if (signal.aborted) throw new CopilotProviderFailure('Copilot 授权请求已取消或超时。');
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CopilotProviderFailure('invalid');
      return value as Record<string, unknown>;
    } catch { throw new CopilotProviderFailure(signal.aborted ? 'Copilot 授权请求已取消或超时。' : 'Copilot 未返回有效的授权结果。'); }
    finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  }
  private async exchange(accountId: string, auth: CopilotInferenceAuthorization, identity: string, controller: AbortController): Promise<ApiToken> {
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new CopilotProviderFailure('Copilot 授权请求已取消或超时。'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await Promise.race([(async () => {
      const response = await this.fetcher(TOKEN_URL, { method: 'GET', headers: { ...inferenceHeaders(), Accept: 'application/json',
        Authorization: `token ${auth.accessToken}`, 'X-GitHub-Api-Version': '2025-04-01' }, redirect: 'error', signal: controller.signal });
      if (controller.signal.aborted || !this.currentAccount(accountId, identity)) { void response.body?.cancel().catch(() => {}); throw new CopilotProviderFailure('Copilot 账户授权已变化，请重新尝试。'); }
      if (response.redirected || response.url && response.url !== TOKEN_URL) { void response.body?.cancel().catch(() => {}); throw new CopilotProviderFailure('Copilot 授权服务发生重定向，已停止发送凭据。'); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new CopilotProviderFailure(response.status === 401 ? 'GitHub 授权已失效，请重新登录。' : response.status === 403 ? '当前 GitHub 账户没有可用的 Copilot 权限，请检查订阅或组织策略。'
          : response.status === 429 ? 'Copilot 授权请求过于频繁，请稍后重试。' : `Copilot 授权服务返回 HTTP ${response.status}，请稍后重试。`);
      }
      const payload = await this.readToken(response, controller.signal), token = payload.token;
      const expiresAt = typeof payload.expires_at === 'number' && Number.isFinite(payload.expires_at) ? payload.expires_at * 1000 : NaN;
      if (typeof token !== 'string' || !token || token.length > 32_768 || /[\s\x00-\x1f\x7f]/.test(token) || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 86_400_000) throw new CopilotProviderFailure('Copilot 返回的模型授权凭据无效，请重新登录。');
      const baseUrl = apiBase(object(payload.endpoints).api);
      const refreshIn = typeof payload.refresh_in === 'number' && Number.isFinite(payload.refresh_in) && payload.refresh_in > 0 ? payload.refresh_in * 1000 : Infinity;
      const result: ApiToken = { token, baseUrl, refreshAt: Math.min(expiresAt - REFRESH_LEAD_MS, this.now() + refreshIn), identity };
      if (controller.signal.aborted || !this.currentAccount(accountId, identity)) throw new CopilotProviderFailure('Copilot 账户授权已变化，请重新尝试。');
      this.cache.set(accountId, result);
      return result;
      })(), aborted]);
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); }
  }
  private async apiToken(accountId: string): Promise<ApiToken> {
    const auth = this.authorization(accountId), identity = authorizationIdentity(auth);
    const cached = this.cache.get(accountId);
    if (cached?.identity === identity && cached.refreshAt > this.now()) return cached;
    this.cache.delete(accountId);
    const pending = this.exchanges.get(accountId);
    if (pending?.identity === identity) return pending.promise;
    pending?.controller.abort();
    const controller = new AbortController();
    const promise = this.exchange(accountId, auth, identity, controller).catch(error => {
      // Fetch/body errors can contain credentials. Only our controlled messages
      // escape; arbitrary transport exceptions are never forwarded.
      const controlled = error instanceof CopilotProviderFailure;
      throw new CopilotProviderFailure(controlled ? error.message : '无法换取 Copilot 模型授权，请检查网络或重新登录。');
    });
    this.exchanges.set(accountId, { identity, controller, promise });
    void promise.finally(() => { if (this.exchanges.get(accountId)?.promise === promise) this.exchanges.delete(accountId); }).catch(() => {});
    return promise;
  }
  async prepareRequest(provider: Provider, path: string, input: Record<string, unknown>): Promise<PreparedUpstream> {
    const current = this.provider(provider.id), targetRoute = route(path);
    if (!routes.has(targetRoute)) throw new CopilotProviderFailure('Copilot 订阅仅支持模型目录、Chat Completions 和 Responses 原生接口。');
    if (current.baseUrl !== provider.baseUrl || current.kind !== provider.kind) throw new CopilotProviderFailure('Copilot 供应商配置已变化，请重新尝试。');
    const accountId = this.store.getSecret(provider.id)?.copilotAccountId;
    if (!accountId || !isCopilotAccountId(accountId)) throw new CopilotProviderFailure('请先为 Copilot 供应商选择账户或登录 GitHub。');
    const token = await this.apiToken(accountId);
    const latest = this.store.getProvider(provider.id);
    if (!latest || latest.kind !== 'copilot' || latest.baseUrl !== current.baseUrl || this.store.getSecret(provider.id)?.copilotAccountId !== accountId || !this.currentAccount(accountId, token.identity)) throw new CopilotProviderFailure('Copilot 来源或账户已变化，请重新尝试。');
    const url = `${token.baseUrl}${targetRoute}`;
    if (!isCopilotUpstream(url, targetRoute)) throw new CopilotProviderFailure('Copilot 模型服务地址无效，已停止发送凭据。');
    const body = structuredClone(input);
    const headers: Record<string, string> = { ...inferenceHeaders(), Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json', 'X-Request-Id': randomUUID() };
    return { url, headers, body };
  }
}
