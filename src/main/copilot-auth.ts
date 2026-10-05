import type { AuthAccount, QuotaWindow, SubscriptionUsage } from '../shared/auth-types';
import type { AuthFailureCategory, AuthProgress } from '../shared/types';
import { safeAccountAvatarUrl } from '../shared/auth-avatar';

// Public device-flow client used by GitHub's Copilot language server. Quotas
// follow VS Code's first-party entitlement protocol, checked 2026-10-07:
// https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/proxy/providers/copilot_auth.rs
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/chat/common/chatEntitlementService.ts
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USAGE_URL = 'https://api.github.com/copilot_internal/user';
const VERIFY_URL = 'https://github.com/login/device';
const STATE_KEY = 'copilot-auth:v1';
const LOGIN_ID = 'copilot:login';
const MAX_RESPONSE = 512 * 1024;
const RESET_MESSAGE = 'GitHub 未提供可手动重置额度的次数';
// GitHub device errors follow RFC 8628 §3.5 / RFC 6749 §5.2: HTTP 400
// authorization_pending and slow_down are normal token-polling responses.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#error-codes-for-the-device-flow
// https://datatracker.ietf.org/doc/html/rfc8628#section-3.5
const DEVICE_OAUTH_ERRORS = new Set(['authorization_pending', 'slow_down', 'expired_token', 'token_expired', 'access_denied',
  'device_flow_disabled', 'incorrect_device_code', 'invalid_device_code', 'incorrect_client_credentials', 'invalid_client',
  'invalid_grant', 'invalid_request', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type']);

/** Store encrypts managed state with the same main-process credential codec. */
export interface CopilotAuthStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
}
interface StoredAccount {
  id: string;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  avatarCheckedAt?: number;
  plan?: string;
  accessToken: string;
  expiresAt?: number;
  authStatus: 'ready' | 'error' | 'expired';
  usage: SubscriptionUsage;
}
interface AccountState { version: 1; accounts: StoredAccount[] }
interface LoginSession { controller: AbortController; progress: AuthProgress }
interface ActiveQuery { controller: AbortController; promise: Promise<AuthAccount> }
export interface CopilotInferenceAuthorization {
  /** Main-process only: GitHub token stays in the encrypted account store. */
  accessToken: string;
  expiresAt?: number;
  revision: number;
}
interface CopilotAuthOptions {
  openExternal: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onAuthorized?: (accountId: string, providerId?: string) => void | Promise<void>;
}
type Json = Record<string, unknown>;

function record(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown, max = 160): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
}
function credential(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;
}
function quantity(value: unknown): number | undefined {
  // The current AI Credits response uses decimal strings for some counters.
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number') return value > 0 && value <= 253_402_300_799 ? new Date(value * 1000).toISOString() : undefined;
  const raw = text(value, 80);
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)) return undefined;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw new Error('GitHub 授权或额度查询已取消'); }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('已取消')); return; }
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new Error('已取消')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
class SafeFailure extends Error {
  constructor(message: string, readonly category: AuthFailureCategory = 'upstream', readonly statusCode?: number) { super(message); }
}
function deviceOAuthFailure(code: unknown, statusCode?: number): SafeFailure {
  switch (code) {
    case 'expired_token': case 'token_expired': return new SafeFailure('GitHub 设备码已过期，请重新登录', 'expired', statusCode);
    case 'access_denied': return new SafeFailure('GitHub 授权被拒绝', 'denied', statusCode);
    case 'device_flow_disabled': return new SafeFailure('GitHub 设备授权暂不可用，请重新尝试或检查授权应用', 'device-disabled', statusCode);
    case 'incorrect_device_code': case 'invalid_device_code': case 'invalid_grant': return new SafeFailure('GitHub 设备码无效或已失效，请重新登录', 'expired', statusCode);
    case 'incorrect_client_credentials': case 'invalid_client': case 'unauthorized_client': return new SafeFailure('GitHub 未接受授权应用的身份，请检查客户端配置后重新登录', 'upstream', statusCode);
    case 'unsupported_grant_type': case 'invalid_request': case 'invalid_scope': return new SafeFailure('GitHub 未接受设备授权请求，请重新尝试', 'invalid-response', statusCode);
    default: return new SafeFailure('GitHub 返回了无法识别的设备授权错误，请重新尝试', 'invalid-response', statusCode);
  }
}
const unqueried = (): SubscriptionUsage => ({ status: 'not-queried', windows: [], message: '尚未查询 GitHub Copilot 额度', resetCreditsStatus: 'not-supported', resetCreditsMessage: RESET_MESSAGE });
export function isCopilotAccountId(value: unknown): value is string { return typeof value === 'string' && /^copilot:[1-9]\d*$/.test(value); }

/** No account plan, date or missing field implies an allowance of 100%. */
export function parseCopilotUsage(payload: unknown): QuotaWindow[] {
  const body = record(payload), snapshots = record(body.quota_snapshots), aiCredits = body.token_based_billing === true;
  const resetAt = timestamp(body.quota_reset_date_utc) ?? timestamp(body.quota_reset_date) ?? timestamp(body.limited_user_reset_date);
  const windows: QuotaWindow[] = [];
  for (const id of ['premium_interactions', 'chat', 'completions']) {
    const snapshot = record(snapshots[id]);
    if (Object.keys(snapshot).length) {
      const unlimited = snapshot.unlimited === true, total = quantity(snapshot.entitlement);
      // Zero allocation is not an available request/credit allowance.
      if (!unlimited && total === 0) continue;
      const rawRemaining = aiCredits ? snapshot.quota_remaining ?? snapshot.remaining : snapshot.remaining ?? snapshot.quota_remaining;
      const remaining = quantity(rawRemaining);
      const percentage = quantity(snapshot.percent_remaining);
      const remainingPercent = !unlimited && percentage !== undefined && percentage <= 100 ? percentage
        : !unlimited && percentage === undefined && total !== undefined && total > 0 && remaining !== undefined && remaining <= total ? remaining / total * 100 : undefined;
      if (!unlimited && remainingPercent === undefined && remaining === undefined) continue;
      // Shared organization pools marked unlimited have no denominator.
      if (unlimited && snapshot.has_quota === false && !aiCredits) continue;
      windows.push({
        id, label: id === 'premium_interactions' ? aiCredits ? 'AI Credits' : '高级请求' : id === 'chat' ? '聊天' : '代码补全',
        ...(remainingPercent === undefined ? {} : { remainingPercent, usedPercent: 100 - remainingPercent }),
        resetAt: timestamp(snapshot.quota_reset_at) ?? resetAt,
        total, remaining, unit: aiCredits ? 'credits' : '次', unlimited,
      });
    } else if (id !== 'premium_interactions') {
      const total = quantity(record(body.monthly_quotas)[id]), remaining = quantity(record(body.limited_user_quotas)[id]);
      if (total !== undefined && total > 0 && remaining !== undefined && remaining <= total) windows.push({ id, label: id === 'chat' ? '聊天' : '代码补全', total, remaining, remainingPercent: remaining / total * 100, usedPercent: (1 - remaining / total) * 100, unit: '次', resetAt });
    }
  }
  return windows;
}

export class CopilotAuthCenter {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly pause: CopilotAuthOptions['delay'];
  private session?: LoginSession;
  private disposed = false;
  private readonly active = new Map<string, ActiveQuery>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly store: CopilotAuthStore, private readonly options: CopilotAuthOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.pause = options.delay ?? delay;
  }

  private state(): AccountState {
    try {
      const state = this.store.getManagedState<AccountState>(STATE_KEY, { version: 1, accounts: [] });
      if (state.version !== 1 || !Array.isArray(state.accounts) || state.accounts.length > 100 || state.accounts.some(account => !isCopilotAccountId(account.id) || !text(account.login) || !credential(account.accessToken))) throw new Error('invalid');
      return state;
    } catch { throw new Error('GitHub 账户加密配置无法读取，请检查本地存储'); }
  }
  private put(state: AccountState): void {
    try { this.store.setManagedState(STATE_KEY, state); }
    catch { throw new Error('GitHub 账户加密配置保存失败'); }
  }
  private account(id: string): StoredAccount {
    if (!isCopilotAccountId(id)) throw new Error('请选择 GitHub Copilot 账户');
    const account = this.state().accounts.find(item => item.id === id);
    if (!account) throw new Error('GitHub Copilot 账户不存在');
    return account;
  }
  private view(account: StoredAccount): AuthAccount {
    return {
      providerId: account.id, providerName: 'GitHub Copilot', kind: 'copilot', accountId: account.id.slice(8),
      displayName: text(account.name) ?? text(account.login), email: text(account.email), avatarUrl: safeAccountAvatarUrl('copilot', account.avatarUrl), plan: text(account.plan),
      authStatus: account.expiresAt !== undefined && account.expiresAt <= this.now() ? 'expired' : account.authStatus,
      expiresAt: account.expiresAt, canRefresh: false, usage: structuredClone(account.usage),
    };
  }
  listAccounts(): AuthAccount[] { return this.state().accounts.map(account => this.view(account)); }
  /** 修改点：只给主进程订阅适配器读取授权，preload/账户快照始终不返回凭据。 */
  getInferenceAuthorization(id: string): CopilotInferenceAuthorization {
    if (this.disposed) throw new Error('GitHub 授权服务已关闭');
    const account = this.account(id);
    if (account.authStatus !== 'ready' || account.expiresAt !== undefined && account.expiresAt <= this.now()) throw new Error('GitHub 登录已失效，请重新登录');
    return { accessToken: account.accessToken, expiresAt: account.expiresAt, revision: this.epochs.get(id) ?? 0 };
  }
  progress(): AuthProgress | null { return this.session ? { ...this.session.progress } : null; }
  cancel(): void {
    if (!this.session) return;
    this.session.controller.abort();
    if (this.session.progress.state === 'pending') this.session.progress = { providerId: this.session.progress.providerId, state: 'cancelled', message: 'GitHub 授权已取消' };
  }
  dispose(): void {
    this.disposed = true; this.cancel();
    for (const query of this.active.values()) query.controller.abort();
  }

  private async request(url: string, init: RequestInit, parent: AbortSignal, purpose?: 'device-poll'): Promise<Json> {
    assertActive(parent);
    if (![DEVICE_URL, TOKEN_URL, USER_URL, USAGE_URL].includes(url)) throw new SafeFailure('GitHub 服务地址无效', 'invalid-response');
    const controller = new AbortController(), abort = () => controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      assertActive(controller.signal);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE) { void response.body?.cancel().catch(() => {}); throw new SafeFailure('GitHub 响应过大，已停止读取', 'invalid-response'); }
      const devicePoll = purpose === 'device-poll' && url === TOKEN_URL && init.method === 'POST' && typeof init.body === 'string'
        && new URLSearchParams(init.body).get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code';
      const oauthBadRequest = devicePoll && response.status === 400;
      if (!response.ok && !oauthBadRequest) { void response.body?.cancel().catch(() => {}); throw new SafeFailure(response.status === 401 ? 'GitHub 登录已失效，请重新登录' : response.status === 403 ? 'GitHub 暂不允许读取该账户的 Copilot 额度，请检查订阅或组织权限' : `GitHub 服务返回 HTTP ${response.status}`, response.status === 401 ? 'expired' : response.status === 429 ? 'rate-limit' : response.status === 403 ? 'blocked' : 'upstream', response.status); }
      if (oauthBadRequest && !/^application\/(?:[a-z0-9.+-]+\+)?json$/.test((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase())) {
        void response.body?.cancel().catch(() => {}); throw new SafeFailure('GitHub 设备授权返回了非 JSON 响应（HTTP 400）', 'invalid-response', 400);
      }
      reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) while (true) {
        const item = await reader.read(); assertActive(controller.signal);
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new SafeFailure('GitHub 响应过大，已停止读取', 'invalid-response'); }
        chunks.push(item.value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: Json;
      try { const value = JSON.parse(body); if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected'); parsed = value as Json; }
      catch { throw new SafeFailure('GitHub 返回了无法识别的响应', 'invalid-response', response.status); }
      if (oauthBadRequest) {
        if (typeof parsed.error !== 'string' || !DEVICE_OAUTH_ERRORS.has(parsed.error) || Object.hasOwn(parsed, 'access_token')) throw deviceOAuthFailure(undefined, 400);
        if (parsed.error !== 'authorization_pending' && parsed.error !== 'slow_down') throw deviceOAuthFailure(parsed.error, 400);
      }
      return parsed;
    } catch (error) {
      if (error instanceof SafeFailure) throw error;
      throw new SafeFailure(parent.aborted ? 'GitHub 授权或额度查询已取消' : 'GitHub 网络请求失败或超时', parent.aborted ? 'denied' : 'network');
    } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelReader); reader?.releaseLock(); }
  }
  private form(body: Record<string, string>): RequestInit {
    return { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ModelDock' }, body: new URLSearchParams(body).toString() };
  }
  private userHeaders(accessToken: string): Record<string, string> {
    // Public GitHub REST versions differ from the private Copilot protocol.
    // Unknown public REST versions are rejected with HTTP 400, after OAuth
    // has succeeded. https://docs.github.com/en/rest/about-the-rest-api/api-versions
    return { Accept: 'application/vnd.github+json', Authorization: `token ${accessToken}`, 'User-Agent': 'ModelDock', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  private quotaHeaders(accessToken: string): Record<string, string> {
    return { Accept: 'application/json', Authorization: `token ${accessToken}`, 'User-Agent': 'ModelDock', 'X-GitHub-Api-Version': '2025-10-01', 'Editor-Version': 'vscode/1.110.1', 'Editor-Plugin-Version': 'copilot-chat/0.38.2' };
  }
  async beginLogin(providerId?: string): Promise<AuthProgress> {
    if (this.disposed) throw new Error('GitHub 授权服务已关闭');
    if (providerId !== undefined && (typeof providerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(providerId))) throw new Error('Copilot 供应商标识无效');
    this.cancel();
    const session: LoginSession = { controller: new AbortController(), progress: { providerId: providerId ?? LOGIN_ID, state: 'pending', stage: 'device-code', message: '正在申请 GitHub 设备码…' } };
    this.session = session;
    try {
      const device = await this.request(DEVICE_URL, this.form({ client_id: CLIENT_ID, scope: 'read:user' }), session.controller.signal);
      assertActive(session.controller.signal);
      const deviceCode = credential(device.device_code), userCode = text(device.user_code, 32), expires = quantity(device.expires_in), interval = quantity(device.interval) ?? 5;
      if (!deviceCode || !userCode || !/^[A-Za-z0-9-]{6,32}$/.test(userCode) || device.verification_uri !== VERIFY_URL || expires === undefined || expires < 1 || expires > 3600 || interval < 1 || interval > 120) throw new SafeFailure('GitHub 设备码响应无效', 'invalid-response');
      session.progress = { providerId: session.progress.providerId, state: 'pending', stage: 'device-poll', userCode, verificationUri: VERIFY_URL, message: '请在 GitHub 页面输入设备码并完成授权；仅输入由你自己发起的设备码。' };
      try { await this.options.openExternal(VERIFY_URL); }
      catch { session.progress.message = '请手动打开上方 GitHub 地址并输入设备码完成授权。'; }
      assertActive(session.controller.signal);
      void this.poll(session, deviceCode, this.now() + expires * 1000, interval * 1000);
    } catch (error) { this.failLogin(session, error); }
    return { ...session.progress };
  }
  private failLogin(session: LoginSession, error: unknown): void {
    if (session.controller.signal.aborted || this.session !== session) return;
    const safe = error instanceof SafeFailure ? error : new SafeFailure(error instanceof Error && error.message === 'GitHub 账户加密配置保存失败' ? error.message : 'GitHub 授权失败，请重新尝试');
    session.progress = { providerId: session.progress.providerId, state: 'error', stage: session.progress.stage, message: safe.message, category: safe.category, statusCode: safe.statusCode };
  }
  private async poll(session: LoginSession, deviceCode: string, deadline: number, interval: number): Promise<void> {
    try {
      while (this.now() < deadline) {
        await this.pause!(Math.min(interval, Math.max(0, deadline - this.now())), session.controller.signal);
        assertActive(session.controller.signal);
        if (this.now() >= deadline) break;
        const result = await this.request(TOKEN_URL, this.form({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), session.controller.signal, 'device-poll');
        assertActive(session.controller.signal);
        if (result.error === 'authorization_pending') continue;
        if (result.error === 'slow_down') { interval = Math.max(interval + 5000, (quantity(result.interval) ?? 0) * 1000); continue; }
        if (Object.hasOwn(result, 'error')) throw deviceOAuthFailure(result.error);
        const accessToken = credential(result.access_token);
        if (!accessToken) throw new SafeFailure('GitHub 授权响应缺少有效凭据', 'invalid-response');
        session.progress.stage = 'account-info';
        const user = await this.request(USER_URL, { headers: this.userHeaders(accessToken) }, session.controller.signal);
        assertActive(session.controller.signal);
        const numericId = quantity(user.id), login = text(user.login);
        if (!numericId || !Number.isSafeInteger(numericId) || !login || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new SafeFailure('GitHub 账户身份响应无效', 'invalid-response');
        const id = `copilot:${numericId}`;
        this.invalidate(id);
        const state = this.state(), expires = quantity(result.expires_in);
        const account: StoredAccount = { id, login, name: text(user.name), email: text(user.email), avatarUrl: safeAccountAvatarUrl('copilot', user.avatar_url), avatarCheckedAt: this.now(), accessToken, expiresAt: expires !== undefined && expires > 0 && expires < 31_536_000 ? this.now() + expires * 1000 : undefined, authStatus: 'ready', usage: unqueried() };
        this.put({ version: 1, accounts: [...state.accounts.filter(item => item.id !== id), account] });
        assertActive(session.controller.signal);
        await this.options.onAuthorized?.(id, session.progress.providerId === LOGIN_ID ? undefined : session.progress.providerId);
        assertActive(session.controller.signal);
        if (this.session !== session) return;
        session.progress = { providerId: session.progress.providerId, state: 'complete', message: 'GitHub 账户已登录，正在查询 Copilot 额度' };
        void this.refreshUsage(id).catch(() => {});
        return;
      }
      throw new SafeFailure('GitHub 设备码已过期，请重新登录', 'expired');
    } catch (error) { this.failLogin(session, error); }
  }
  private invalidate(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.active.get(id)?.controller.abort();
    this.active.delete(id);
  }
  logout(id: string): void {
    this.account(id);
    this.cancel(); this.invalidate(id);
    const state = this.state();
    this.put({ version: 1, accounts: state.accounts.filter(account => account.id !== id) });
  }
  refreshUsage(id: string): Promise<AuthAccount> {
    if (this.disposed) return Promise.reject(new Error('GitHub 授权服务已关闭'));
    const existing = this.active.get(id);
    if (existing) return existing.promise;
    const account = this.account(id), epoch = this.epochs.get(id) ?? 0, controller = new AbortController();
    const promise = this.queryUsage(account, epoch, controller);
    this.active.set(id, { controller, promise });
    void promise.finally(() => { if (this.active.get(id)?.promise === promise) this.active.delete(id); }).catch(() => {});
    return promise;
  }
  private current(account: StoredAccount, epoch: number, signal: AbortSignal): StoredAccount | undefined {
    if (signal.aborted || this.disposed || epoch !== (this.epochs.get(account.id) ?? 0)) return undefined;
    return this.state().accounts.find(item => item.id === account.id && item.accessToken === account.accessToken);
  }
  private async queryUsage(account: StoredAccount, epoch: number, controller: AbortController): Promise<AuthAccount> {
    let usage: SubscriptionUsage, authStatus = account.authStatus, plan = account.plan;
    let avatarUrl = safeAccountAvatarUrl('copilot', account.avatarUrl), avatarCheckedAt = account.avatarCheckedAt;
    try {
      if (account.expiresAt !== undefined && account.expiresAt <= this.now()) throw new SafeFailure('GitHub 登录已过期，请重新登录', 'expired', 401);
      const body = await this.request(USAGE_URL, { headers: this.quotaHeaders(account.accessToken) }, controller.signal);
      const windows = parseCopilotUsage(body);
      plan = text(body.copilot_plan) ?? plan;
      authStatus = 'ready';
      usage = { status: windows.length ? 'ready' : 'unavailable', windows, queriedAt: new Date(this.now()).toISOString(), message: windows.length ? '来自 GitHub 账户的 Copilot 额度' : 'GitHub 未返回可显示的 Copilot 额度，订阅或组织额度可能暂不可用', resetCreditsStatus: 'not-supported', resetCreditsMessage: RESET_MESSAGE };
    } catch (error) {
      const safe = error instanceof SafeFailure ? error : new SafeFailure('GitHub 额度查询失败，请重试');
      if (safe.statusCode === 401) authStatus = 'expired';
      const cached = account.usage;
      usage = cached.windows.length ? { ...cached, status: 'stale', message: `${safe.message}；显示上次查询的数据` }
        : { status: 'error', windows: [], queriedAt: new Date(this.now()).toISOString(), message: safe.message, resetCreditsStatus: 'not-supported', resetCreditsMessage: RESET_MESSAGE };
    }
    // Existing accounts predate avatar metadata. An explicit quota refresh may
    // backfill public profile metadata once, with the same account/epoch guard.
    // Image/profile failures never downgrade a successful quota/auth result.
    if (!avatarUrl && avatarCheckedAt === undefined && authStatus === 'ready' && !controller.signal.aborted) {
      try {
        const user = await this.request(USER_URL, { headers: this.userHeaders(account.accessToken) }, controller.signal);
        const userId = quantity(user.id);
        if (userId && Number.isSafeInteger(userId) && `copilot:${userId}` === account.id && this.current(account, epoch, controller.signal)) {
          avatarUrl = safeAccountAvatarUrl('copilot', user.avatar_url);
          avatarCheckedAt = this.now();
        }
      } catch { /* Keep the existing account and quota; a later refresh may retry. */ }
    }
    const current = this.current(account, epoch, controller.signal);
    if (!current) throw new Error('GitHub 额度查询已取消，账户状态已变化');
    const updated: StoredAccount = { ...current, authStatus, plan, usage, avatarUrl, avatarCheckedAt }, state = this.state();
    this.put({ version: 1, accounts: state.accounts.map(item => item.id === updated.id ? updated : item) });
    return this.view(updated);
  }
}
