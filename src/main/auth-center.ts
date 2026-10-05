import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AuthAccount, QuotaWindow, SubscriptionKind, SubscriptionUsage } from '../shared/auth-types';
import type { Provider, ProviderInput, ProviderSecret } from '../shared/types';
import type { OAuthManager } from './oauth';
import { safeAccountAvatarUrl } from '../shared/auth-avatar';

// Protocol references, read 2026-10-07 (MIT-licensed CC Switch). The parsers
// below are independent TypeScript implementations of the observed protocols.
// https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/services/subscription.rs
// https://github.com/farion1231/cc-switch/blob/v4.0.3/src-tauri/src/services/subscription_grok.rs
// First-party Codex payload/reset contract:
// https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_CREDITS = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const GROK_USAGE = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const GROK_SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const MAX_RESPONSE = 512 * 1024;
const MAX_AUTH_FILE = 128 * 1024;
const NOT_QUERIED: SubscriptionUsage = { status: 'not-queried', windows: [], message: '尚未查询订阅额度' };

export interface AuthCenterStore {
  listProviders(): Provider[];
  getProvider(id: string): Provider | undefined;
  saveProvider(input: ProviderInput): Provider;
  deleteProvider(id: string): void;
  getSecret(id: string): ProviderSecret | undefined;
  setSecret(id: string, secret: ProviderSecret): void;
  setAuthStatus(id: string, status: Provider['authStatus']): void;
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
}

type Json = Record<string, unknown>;
interface AccountMetadata { accessFingerprint: string; accountId?: string; email?: string; displayName?: string; avatarUrl?: string; plan?: string; source?: 'client-import' }
interface CachedUsage { identity: string; usage: SubscriptionUsage }
interface ActiveQuery { promise: Promise<AuthAccount>; controller: AbortController }
interface ResetCreditResult {
  status: NonNullable<SubscriptionUsage['resetCreditsStatus']>;
  credits?: SubscriptionUsage['resetCredits'];
  message: string;
  transient?: boolean;
}
type AuthOAuth = Pick<OAuthManager, 'prepareRequest' | 'cancel'>;

function record(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function safeText(value: unknown, max = 160): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
}
function token(value: unknown): string | undefined { return safeText(value, 32_768); }
function claims(value: unknown): Json {
  // Decoded claims are display metadata only; not signature verification.
  try { const raw = token(value)?.split('.')[1]; return raw ? record(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))) : {}; } catch { return {}; }
}
function fingerprint(value?: string): string { return createHash('sha256').update(value ?? '').digest('hex'); }
function identity(secret: ProviderSecret): string {
  const claim = claims(secret.accessToken);
  return `${safeText(claim.sub) ?? fingerprint(secret.accessToken)}:${safeText(secret.accountId) ?? ''}`;
}
function dateIso(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 253_402_300_799) return undefined;
  return new Date(seconds * 1000).toISOString();
}
function expiryFromClaims(accessToken: string): number | undefined {
  const exp = claims(accessToken).exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 && exp < 253_402_300_799 ? exp * 1000 : undefined;
}
function accountMetadata(kind: SubscriptionKind, accessToken: string, idToken?: string, accountId?: string): AccountMetadata {
  const access = claims(accessToken), id = claims(idToken);
  const profile = record(access['https://api.openai.com/profile']);
  const idProfile = record(id.profile), accessProfile = record(access.profile);
  const auth = record(id['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth']);
  const email = safeText(id.email ?? access.email ?? profile.email);
  const plan = safeText(auth.chatgpt_plan_type, 60);
  return {
    accessFingerprint: fingerprint(accessToken),
    accountId: safeText(accountId) ?? safeText(auth.chatgpt_account_id) ?? safeText(access.chatgpt_account_id) ?? safeText(access.sub),
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined,
    displayName: safeText(id.name ?? access.name ?? access.preferred_username),
    // OpenID picture is optional display metadata. Never fetch a user-info
    // endpoint or assume a missing profile image establishes account failure.
    avatarUrl: [id.picture, id.avatar_url, id.avatarUrl, idProfile.picture, idProfile.avatar_url,
      access.picture, access.avatar_url, access.avatarUrl, profile.picture, profile.avatar_url, accessProfile.picture, accessProfile.avatar_url]
      .map(value => safeAccountAvatarUrl(kind, value)).find(value => value !== undefined),
    plan: plan && /^[a-zA-Z0-9 _-]+$/.test(plan) ? plan : undefined,
  };
}
function windowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === 18_000) return '5 小时';
  if (seconds === 604_800) return '每周';
  if (seconds === 2_592_000) return '30 天';
  if (seconds && seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds && seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  return fallback;
}

export function parseCodexUsage(payload: unknown, nowSeconds = Date.now() / 1000): QuotaWindow[] {
  const body = record(payload);
  const parseWindows = (rate: Json, prefix = '', name?: string): QuotaWindow[] => ['primary_window', 'secondary_window'].flatMap((id, index) => {
    const w = record(rate[id]), used = w.used_percent;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return [];
    const duration = typeof w.limit_window_seconds === 'number' && Number.isSafeInteger(w.limit_window_seconds) && w.limit_window_seconds > 0 ? w.limit_window_seconds : undefined;
    const after = w.reset_after_seconds;
    const resetAt = dateIso(w.reset_at) ?? (typeof after === 'number' && Number.isSafeInteger(after) && after >= 0 ? dateIso(nowSeconds + after) : undefined);
    const label = windowLabel(duration, index === 0 ? '主要额度' : '次要额度');
    return [{ id: `${prefix}${id}`, label: name ? `${name} · ${label}` : label, usedPercent: used, remainingPercent: 100 - used, resetAt, windowSeconds: duration }];
  });
  const windows = parseWindows(record(body.rate_limit));
  // First-party Codex also returns independently metered model buckets. Do not
  // merge them into the account-wide percentage or use a model label as an ID.
  if (Array.isArray(body.additional_rate_limits)) body.additional_rate_limits.slice(0, 24).forEach((value, index) => {
    const entry = record(value), name = safeText(entry.limit_name, 80) ?? safeText(entry.metered_feature, 80);
    if (name) windows.push(...parseWindows(record(entry.rate_limit), `additional-${index}:`, name));
  });
  return windows;
}

function parseResetCredits(payload: unknown, now = Date.now()): SubscriptionUsage['resetCredits'] {
  const entries = record(payload).credits;
  if (!Array.isArray(entries)) return undefined;
  const expiresAt: (string | null)[] = [];
  const ids = new Set<string>();
  for (const item of entries) {
    const entry = record(item);
    if (!safeText(entry.status, 40)) return undefined;
    if (entry.status !== 'available' || entry.reset_type != null && entry.reset_type !== 'codex_rate_limits') continue;
    const id = safeText(entry.id);
    if (id && ids.has(id)) continue;
    if (id) ids.add(id);
    if (entry.expires_at == null) { expiresAt.push(null); continue; }
    // An unknown expiry cannot establish either zero credits or no expiry.
    if (typeof entry.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(entry.expires_at)) return undefined;
    const expiry = Date.parse(entry.expires_at);
    if (!Number.isFinite(expiry)) return undefined;
    if (expiry > now) expiresAt.push(new Date(expiry).toISOString());
  }
  expiresAt.sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b));
  return { available: expiresAt.length, expiresAt };
}

function resetCreditsSummary(payload: unknown): SubscriptionUsage['resetCredits'] {
  const count = record(record(payload).rate_limit_reset_credits).available_count;
  // Official usage summary remains useful if expiration details are unavailable.
  // An empty expiry array here means unknown details, not nonexpiring credits.
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? { available: count, expiresAt: [] } : undefined;
}

class QuotaServiceError extends Error {
  constructor(message: string, readonly authentication = false, readonly transient = false) { super(message); }
}
function grpcFailure(status: number, rawMessage = ''): QuotaServiceError {
  let message = rawMessage;
  try { message = decodeURIComponent(rawMessage); } catch { /* classification only */ }
  const lower = message.toLowerCase();
  const authentication = status === 16 || status === 7 && (lower.includes('bad-credentials') || lower.includes('unauthenticated') || lower.includes('oauth2') && lower.includes('could not be validated') || lower.includes('access token') && /invalid|expired|could not be validated/.test(lower));
  if (status === 9 && /^no personal team\.?$/i.test(message.trim())) return new QuotaServiceError('xAI 暂未提供团队账户额度查询');
  return new QuotaServiceError(`账单服务返回 gRPC ${status}`, authentication, [4, 14].includes(status) || status === 1 && /timeout|deadline|expired/.test(lower));
}

interface ProtoField { path: number[]; wire: number; value: number | Uint8Array }
function readVarint(data: Uint8Array, offset: number): [number, number] {
  let value = 0, scale = 1;
  for (let i = 0; i < 10 && offset < data.length; i++) {
    const next = data[offset++]; value += (next & 127) * scale;
    if (!Number.isSafeInteger(value)) throw new Error('账单数值超出范围');
    if (!(next & 128)) return [value, offset];
    scale *= 128;
  }
  throw new Error('账单数据不完整');
}
function protoFields(data: Uint8Array, parent: number[] = []): ProtoField[] {
  if (parent.length >= 5) return [];
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [key, next] = readVarint(data, offset); offset = next;
    const field = Math.floor(key / 8), wire = key % 8;
    if (field < 1) throw new Error('账单字段无效');
    const path = [...parent, field];
    if (wire === 0) { const [value, end] = readVarint(data, offset); offset = end; fields.push({ path, wire, value }); }
    else if (wire === 1 || wire === 5) {
      const bytes = wire === 1 ? 8 : 4;
      if (offset + bytes > data.length) throw new Error('账单数据不完整');
      fields.push({ path, wire, value: wire === 5 ? new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, true) : new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, true) });
      offset += bytes;
    } else if (wire === 2) {
      const [length, start] = readVarint(data, offset), end = start + length;
      if (end > data.length) throw new Error('账单数据不完整');
      const nested = data.subarray(start, end);
      fields.push({ path, wire, value: nested });
      // A length-delimited field can also be a string/bytes; only valid nested
      // messages contribute fields. Never resynchronise arbitrary garbage.
      try { fields.push(...protoFields(nested, path)); } catch { /* opaque field */ }
      offset = end;
    } else throw new Error('账单字段类型暂不支持');
  }
  return fields;
}
function grpcPayload(data: Uint8Array): { messages: Uint8Array[]; status?: number; message?: string } {
  const messages: Uint8Array[] = [];
  let offset = 0, status: number | undefined, message: string | undefined;
  while (offset < data.length) {
    if (offset + 5 > data.length) throw new Error('账单响应帧不完整');
    const flags = data[offset], length = new DataView(data.buffer, data.byteOffset + offset + 1, 4).getUint32(0, false);
    if (![0, 128].includes(flags) || offset + 5 + length > data.length) throw new Error('账单响应帧无效');
    const frame = data.subarray(offset + 5, offset + 5 + length);
    if (flags === 0) messages.push(frame);
    else {
      const trailer = new TextDecoder().decode(frame);
      const match = trailer.match(/(?:^|\r?\n)grpc-status:\s*(\d+)(?:\r?\n|$)/i);
      if (match) status = Number(match[1]);
      message = trailer.match(/(?:^|\r?\n)grpc-message:\s*([^\r\n]*)/i)?.[1] ?? message;
    }
    offset += 5 + length;
  }
  return { messages, status, message };
}

/** Fixed observed field paths are used; unknown protobuf changes are unavailable. */
export function parseGrokUsage(data: Uint8Array, nowSeconds = Date.now() / 1000): QuotaWindow[] {
  let messages: Uint8Array[];
  if (data[0] === 0 || data[0] === 128) {
    const framed = grpcPayload(data);
    if (framed.status !== undefined && framed.status !== 0) throw grpcFailure(framed.status, framed.message);
    messages = framed.messages;
  } else messages = [data];
  const fields = messages.flatMap(message => protoFields(message));
  const percent = fields.find(f => f.wire === 5 && f.path.join('.') === '1.1');
  const reset = fields.find(f => f.wire === 0 && f.path.join('.') === '1.5.1');
  const resetSeconds = typeof reset?.value === 'number' && reset.value >= 1_700_000_000 && reset.value <= 2_100_000_000 && reset.value > nowSeconds ? reset.value : undefined;
  // CC Switch 4.0 has a tested proto3 zero-value compatibility shape. Keep that
  // behavior for the observed period markers only, with an explicit source tag:
  // no public .proto lets us describe an omitted percentage as directly reported.
  const period = fields.some(f => f.wire === 0 && (f.path.join('.') === '1.6.1' && f.value === 3 || f.path.join('.') === '1.8.1' && [1, 2].includes(Number(f.value))));
  const protobufDefault = messages.length === 1 && resetSeconds !== undefined && period && !fields.some(f => [1, 5].includes(f.wire) || f.path.join('.') === '1.1');
  const used = typeof percent?.value === 'number' ? percent.value : protobufDefault ? 0 : undefined;
  if (used === undefined || !Number.isFinite(used) || used < 0 || used > 100) return [];
  // Grok Build's documented allowance is shared weekly. Near-end-of-week
  // countdowns must not rename the same weekly allowance to a generic credit.
  return [{ id: 'grok-credits', label: '每周', usedPercent: used, remainingPercent: 100 - used, resetAt: dateIso(resetSeconds), windowSeconds: 604_800, measurement: protobufDefault ? 'protobuf-default' : 'reported' }];
}

export class AuthCenter {
  private readonly fetcher: typeof fetch;
  private readonly home: string;
  private readonly active = new Map<string, ActiveQuery>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly store: AuthCenterStore, private readonly oauth: AuthOAuth, private readonly options: { homeDir?: string; codexHome?: string; fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.home = options.homeDir ?? homedir();
  }

  listAccounts(): AuthAccount[] {
    return this.store.listProviders().filter((p): p is Provider & { kind: SubscriptionKind } => p.kind === 'codex' || p.kind === 'grok').map(provider => this.account(provider));
  }

  private subscription(providerId: string): Provider & { kind: SubscriptionKind } {
    const provider = this.store.getProvider(providerId);
    if (!provider || (provider.kind !== 'codex' && provider.kind !== 'grok')) throw new Error('请选择 Codex 或 Grok 订阅账户');
    return provider as Provider & { kind: SubscriptionKind };
  }

  private account(provider: Provider & { kind: SubscriptionKind }): AuthAccount {
    const secret = this.store.getSecret(provider.id), decoded = secret?.accessToken ? accountMetadata(provider.kind, secret.accessToken, secret.idToken, secret.accountId) : undefined;
    const stored = this.store.getManagedState<AccountMetadata | null>(`auth-metadata:${provider.id}`, null);
    const metadata = stored && decoded?.accessFingerprint === stored.accessFingerprint ? { ...stored, ...Object.fromEntries(Object.entries(decoded).filter(([, value]) => value !== undefined)) } : decoded;
    const cached = this.store.getManagedState<CachedUsage | null>(`auth-usage:${provider.id}`, null);
    const usage = secret?.accessToken && cached?.identity === identity(secret) ? structuredClone(cached.usage) : structuredClone(NOT_QUERIED);
    const expired = secret?.expiresAt !== undefined && secret.expiresAt <= Date.now();
    return {
      providerId: provider.id, providerName: provider.name, kind: provider.kind,
      accountId: safeText(metadata?.accountId), email: safeText(metadata?.email), displayName: safeText(metadata?.displayName), avatarUrl: safeAccountAvatarUrl(provider.kind, metadata?.avatarUrl), plan: safeText(metadata?.plan),
      authStatus: provider.authStatus === 'signing-in' ? 'signing-in' : expired && !secret?.refreshToken ? 'expired' : provider.authStatus,
      expiresAt: secret?.expiresAt, canRefresh: Boolean(secret?.refreshToken), source: metadata?.source,
      usage: secret?.accessToken ? usage : { ...NOT_QUERIED, message: '尚未授权，请登录或从客户端导入' },
    };
  }

  refreshUsage(providerId: string): Promise<AuthAccount> {
    const current = this.active.get(providerId);
    if (current) return current.promise;
    const provider = this.subscription(providerId), epoch = this.epochs.get(providerId) ?? 0, controller = new AbortController();
    const promise = this.queryUsage(provider, epoch, controller);
    this.active.set(providerId, { promise, controller });
    void promise.finally(() => { if (this.active.get(providerId)?.promise === promise) this.active.delete(providerId); }).catch(() => {});
    return promise;
  }

  private async request(url: string, init: RequestInit, parent: AbortSignal): Promise<Response> {
    const controller = new AbortController(), abort = () => controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    const timer = setTimeout(abort, 15_000);
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
      // Keep the deadline and cancellation active through body consumption,
      // rather than stopping the clock when only the headers have arrived.
      const bytes = await this.bytes(response, controller.signal);
      if (controller.signal.aborted) throw new Error('额度查询网络失败或超时');
      return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(bytes).buffer, { status: response.status, headers: response.headers });
    } catch (error) {
      if (error instanceof Error && error.message === '额度响应过大') throw error;
      throw new Error(parent.aborted ? '额度查询已取消' : '额度查询网络失败或超时');
    }
    finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
  }

  private async bytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('额度响应过大'); }
        chunks.push(value);
      }
    } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  private async json(response: Response): Promise<unknown> { return JSON.parse(new TextDecoder().decode(await this.bytes(response))); }

  private async queryResetCredits(headers: Record<string, string>, signal: AbortSignal): Promise<ResetCreditResult> {
    try {
      const response = await this.request(CODEX_CREDITS, { headers: { ...headers, 'OpenAI-Beta': 'codex-1' } }, signal);
      if (!response.ok) return {
        status: [404, 405].includes(response.status) ? 'not-supported' : 'unavailable',
        message: [404, 405].includes(response.status) ? '该账户暂未提供重置次数接口' : `重置次数暂不可查询（HTTP ${response.status}）`,
        transient: [408, 429].includes(response.status) || response.status >= 500,
      };
      const credits = parseResetCredits(await this.json(response));
      return credits ? { status: 'ready', credits, message: '已排除过期和已使用的重置次数' } : { status: 'unavailable', message: '上游未返回可识别的重置次数' };
    } catch (error) {
      return { status: 'unavailable', message: '重置次数查询失败或接口暂不可用', transient: error instanceof Error && error.message === '额度查询网络失败或超时' };
    }
  }

  private async queryUsage(provider: Provider & { kind: SubscriptionKind }, epoch: number, controller: AbortController): Promise<AuthAccount> {
    let usage: SubscriptionUsage, queryIdentity: string | undefined, authenticated = false;
    let resetQuery: Promise<ResetCreditResult> | undefined, summaryCredits: SubscriptionUsage['resetCredits'];
    try {
      if (!this.store.getSecret(provider.id)?.accessToken) throw new Error('请先登录订阅账户');
      const prepared = await this.oauth.prepareRequest(provider, '/models', {});
      if (controller.signal.aborted) throw new Error('额度查询已取消');
      const secret = this.store.getSecret(provider.id);
      if (!secret?.accessToken) throw new Error('请先登录订阅账户');
      queryIdentity = identity(secret);
      const headers: Record<string, string> = { Authorization: prepared.headers.Authorization, Accept: 'application/json', 'User-Agent': 'ModelDock' };
      if (!headers.Authorization) throw new Error('请先登录订阅账户');
      if (provider.kind === 'codex' && prepared.headers['ChatGPT-Account-Id']) headers['ChatGPT-Account-Id'] = prepared.headers['ChatGPT-Account-Id'];
      const responseQuery = provider.kind === 'codex'
        ? this.request(CODEX_USAGE, { headers }, controller.signal)
        : this.request(GROK_USAGE, { method: 'POST', headers: { ...headers, Origin: 'https://grok.com', Referer: 'https://grok.com/?_s=usage', Accept: '*/*', 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'x-user-agent': 'connect-es/2.1.1' }, body: new Uint8Array(5) }, controller.signal);
      // The read-only reset query has its own result. Missing usage windows or
      // a quota service failure must not hide a successful reset-count read.
      if (provider.kind === 'codex') resetQuery = this.queryResetCredits(headers, controller.signal);
      const response = await responseQuery;
      if (response.status === 401 || response.status === 403) { authenticated = true; throw new Error('订阅授权被拒绝，请重新登录'); }
      if (!response.ok) throw new Error(`额度服务暂不可用（HTTP ${response.status}）`);
      const grpcStatus = response.headers.get('grpc-status');
      if (grpcStatus !== null && grpcStatus !== '0') {
        if (/^\d+$/.test(grpcStatus)) throw grpcFailure(Number(grpcStatus), response.headers.get('grpc-message') ?? '');
        throw new Error(`账单服务暂不可用（gRPC ${/^\d+$/.test(grpcStatus) ? grpcStatus : '未知'}）`);
      }
      const payload = provider.kind === 'codex' ? await this.json(response) : undefined;
      if (provider.kind === 'codex') summaryCredits = resetCreditsSummary(payload);
      const windows = provider.kind === 'codex' ? parseCodexUsage(payload) : parseGrokUsage(await this.bytes(response));
      usage = { status: windows.length ? 'ready' : 'unavailable', windows, queriedAt: new Date().toISOString(), message: windows.length ? '订阅上游返回的额度；包含该账户在其他客户端的使用' : '上游未返回可识别的额度，无法确定剩余量' };
      if (windows.some(window => window.measurement === 'protobuf-default')) usage.message += '；上游未单独发送百分比，按兼容协议默认零值解析';
    } catch (error) {
      if (error instanceof QuotaServiceError && error.authentication) authenticated = true;
      const old = this.store.getManagedState<CachedUsage | null>(`auth-usage:${provider.id}`, null);
      const currentSecret = this.store.getSecret(provider.id);
      const message = authenticated ? '订阅授权被拒绝，请重新登录' : error instanceof Error && /^(额度查询网络失败或超时|订阅授权被拒绝，请重新登录|请先登录订阅账户|额度服务暂不可用（HTTP \d+）|账单服务暂不可用（gRPC (\d+|未知)）|账单服务返回 gRPC \d+|xAI 暂未提供团队账户额度查询)$/.test(error.message) ? error.message : '额度查询失败或响应格式暂不支持';
      const transient = message === '额度查询网络失败或超时' || error instanceof QuotaServiceError && error.transient || /^额度服务暂不可用（HTTP (408|429|5\d\d)）$/.test(message);
      const retain = !authenticated && transient && currentSecret && old?.identity === identity(currentSecret) && old.usage.windows.length > 0;
      usage = retain ? { ...old!.usage, status: 'stale', message: `${message}；显示上次查询结果` } : { status: 'unavailable', windows: [], queriedAt: new Date().toISOString(), message };
      if (authenticated && !controller.signal.aborted && epoch === (this.epochs.get(provider.id) ?? 0) && (!queryIdentity || currentSecret && queryIdentity === identity(currentSecret))) this.store.setAuthStatus(provider.id, 'error');
    }
    if (provider.kind === 'codex') {
      const reset = resetQuery ? await resetQuery : undefined;
      const old = this.store.getManagedState<CachedUsage | null>(`auth-usage:${provider.id}`, null), currentSecret = this.store.getSecret(provider.id);
      const oldCredits = currentSecret && old?.identity === identity(currentSecret) ? old.usage.resetCredits : undefined;
      // Always replace an inherited cached reset count explicitly: a successful
      // quota read does not make an earlier reset-credit read current.
      delete usage.resetCredits;
      if (authenticated) {
        usage.resetCreditsStatus = 'unavailable'; usage.resetCreditsMessage = '请重新登录后查询重置次数';
      } else if (reset?.credits) {
        usage.resetCredits = reset.credits; usage.resetCreditsStatus = 'ready'; usage.resetCreditsMessage = reset.message;
      } else if (summaryCredits) {
        usage.resetCredits = summaryCredits; usage.resetCreditsStatus = 'ready'; usage.resetCreditsMessage = '上游返回剩余重置次数；到期明细暂不可查询';
      } else if ((reset?.transient || !reset && usage.status === 'stale') && oldCredits) {
        const expiresAt = oldCredits.expiresAt.filter(value => value === null || Date.parse(value) > Date.now());
        // Summary-only counts have no expiry list; preserve their measured count
        // and label them stale without assigning invented nonexpiry entries.
        usage.resetCredits = { available: oldCredits.expiresAt.length ? expiresAt.length : oldCredits.available, expiresAt };
        usage.resetCreditsStatus = 'stale'; usage.resetCreditsMessage = '重置次数暂不可查询；显示上次结果，已排除已知过期次数';
      } else {
        usage.resetCreditsStatus = reset?.status ?? 'unavailable'; usage.resetCreditsMessage = reset?.message ?? '重置次数尚不可查询';
      }
    } else {
      usage.resetCreditsStatus = 'not-supported'; usage.resetCreditsMessage = 'xAI 未提供剩余手动重置次数；每周额度按上游时间恢复';
    }
    const fresh = this.subscription(provider.id), secret = this.store.getSecret(provider.id);
    if (!controller.signal.aborted && epoch === (this.epochs.get(provider.id) ?? 0) && secret?.accessToken && (!queryIdentity || queryIdentity === identity(secret))) this.store.setManagedState(`auth-usage:${provider.id}`, { identity: identity(secret), usage } satisfies CachedUsage);
    return this.account(fresh);
  }

  /** Stop late account queries before a reversible provider removal. */
  cancelProviderOperations(providerId: string): void {
    this.epochs.set(providerId, (this.epochs.get(providerId) ?? 0) + 1);
    this.active.get(providerId)?.controller.abort();
    this.active.delete(providerId);
    this.oauth.cancel(providerId);
  }

  logout(providerId: string): void {
    this.subscription(providerId);
    this.cancelProviderOperations(providerId);
    this.store.setSecret(providerId, {});
    this.store.setManagedState(`auth-metadata:${providerId}`, null);
    this.store.setManagedState(`auth-usage:${providerId}`, null);
  }

  /** Explicit UI action only: read the client's file once; never write it. */
  async importAccount(kind: SubscriptionKind): Promise<AuthAccount> {
    if (kind !== 'codex' && kind !== 'grok') throw new Error('不支持此订阅类型');
    const codexHome = this.options.codexHome ?? (this.options.homeDir ? join(this.home, '.codex') : process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(this.home, '.codex'));
    const filename = join(kind === 'codex' ? codexHome : join(this.home, '.grok'), 'auth.json');
    let payload: Json;
    try {
      if ((await stat(filename)).size > MAX_AUTH_FILE) throw new Error();
      payload = record(JSON.parse(await readFile(filename, 'utf8')));
    } catch { throw new Error(`无法读取 ${kind === 'codex' ? 'Codex' : 'Grok'} 客户端授权文件；请确认已登录且使用文件凭据存储`); }
    let secret: ProviderSecret, idToken: string | undefined;
    if (kind === 'codex') {
      if (payload.auth_mode !== 'chatgpt') throw new Error('Codex 客户端未使用 ChatGPT 订阅登录');
      const tokens = record(payload.tokens), accessToken = token(tokens.access_token);
      if (!accessToken) throw new Error('Codex 授权文件没有可导入的访问凭据');
      idToken = token(tokens.id_token);
      secret = { accessToken, idToken, refreshToken: token(tokens.refresh_token), accountId: safeText(tokens.account_id), expiresAt: expiryFromClaims(accessToken), tokenEndpoint: 'https://auth.openai.com/oauth/token' };
    } else {
      // Only the same OAuth public client can safely reuse this refresh token.
      // Legacy session credentials and other client IDs are intentionally excluded.
      const entry = record(payload[GROK_SCOPE]), accessToken = token(entry.key);
      if (!accessToken) throw new Error('Grok 授权文件没有兼容的 OIDC 登录；请重新运行 grok login');
      idToken = token(entry.id_token);
      const expiry = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
      secret = { accessToken, idToken, refreshToken: token(entry.refresh_token), expiresAt: Number.isFinite(expiry) ? expiry : expiryFromClaims(accessToken) };
    }
    if (secret.expiresAt !== undefined && secret.expiresAt <= Date.now() && !secret.refreshToken) throw new Error('客户端授权已过期且无法续期，请在客户端重新登录');
    const metadata = { ...accountMetadata(kind, secret.accessToken!, idToken, secret.accountId), source: 'client-import' as const };
    if (kind === 'codex' && !secret.accountId) secret.accountId = metadata.accountId;
    const exact = this.store.listProviders().find(p => p.kind === kind && this.store.getSecret(p.id)?.accessToken === secret.accessToken);
    const provider = exact ?? this.store.saveProvider({ name: `${kind === 'codex' ? 'Codex' : 'Grok Build'} · 客户端导入`, kind, presetId: kind === 'codex' ? 'codex-subscription' : 'grok-build', baseUrl: kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://cli-chat-proxy.grok.com/v1', enabled: true, note: '通过授权中心显式导入本机客户端授权；原客户端文件未改动。' });
    this.epochs.set(provider.id, (this.epochs.get(provider.id) ?? 0) + 1);
    this.active.get(provider.id)?.controller.abort();
    this.active.delete(provider.id);
    this.oauth.cancel(provider.id);
    try {
      this.store.setSecret(provider.id, secret);
      this.store.setManagedState(`auth-metadata:${provider.id}`, metadata);
      this.store.setManagedState(`auth-usage:${provider.id}`, null);
    } catch {
      if (!exact) this.store.deleteProvider(provider.id);
      throw new Error('导入授权无法保存，请检查本地存储');
    }
    return this.account(this.subscription(provider.id));
  }

  dispose(): void { for (const query of this.active.values()) query.controller.abort(); this.active.clear(); }
}
