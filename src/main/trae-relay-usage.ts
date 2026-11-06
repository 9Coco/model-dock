import { createHash } from 'node:crypto';
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import type { QuotaWindow, SubscriptionUsage } from '../shared/auth-types';

export class TraeRelayUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'TraeRelayUsageError'; }
}
export interface TraeRelayUsageResult {
  /** The relay's active account at both ends of the query, never import provenance. */
  accountId: string;
  accountLabel?: string;
  plan?: string;
  usage: SubscriptionUsage;
}
export type TraeUsageRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export interface TraeRelayUsageOptions { send?: TraeUsageRequest; now?: () => number }
const MAX_BODY = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const identity = (value: unknown): string | undefined => { const id = text(value); return id && /^[a-zA-Z0-9_.:-]+$/.test(id) ? id : undefined; };
const failed = (message = 'TRAE 额度查询失败，请检查托管反代与当前账号授权后重试。') => new TraeRelayUsageError(message);
function amount(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) return;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : undefined;
}

/** Direct local management transport only. No fetch, system proxy, redirect,
 * diagnostics, model requests, or source-client credential access. */
async function getJson(path: string, key: string, send: TraeUsageRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let done = false, req: ClientRequest | undefined;
    const finish = (error?: TraeRelayUsageError, value?: Record<string, unknown>) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    // Native entitlement refresh has a 30s upstream deadline and may refresh
    // the relay's own expired session. A bounded timeout never retries it.
    const timer = setTimeout(() => { finish(failed('TRAE 额度查询超时，请稍后重试。')); req?.destroy(); }, 65_000);
    try {
      req = send({ hostname: '127.0.0.1', port: 18080, path, method: 'GET', agent: false,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Cache-Control': 'no-cache' } }, response => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume(); finish(failed(status >= 300 && status < 400 ? 'TRAE 托管反代返回了重定向，未向其他地址转发请求。' : `TRAE 托管反代未能返回额度（HTTP ${status || '未知'}）。`)); req?.destroy(); return;
        }
        const contentType = response.headers['content-type'];
        if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) { finish(failed('TRAE 托管反代未返回可识别的额度数据。')); req?.destroy(); return; }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY) { finish(failed('TRAE 额度响应超出支持范围。')); req?.destroy(); return; }
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          if (done) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
          if (size > MAX_BODY) { finish(failed('TRAE 额度响应超出支持范围。')); req?.destroy(); return; }
          chunks.push(bytes);
        });
        response.once('error', () => finish(failed()));
        response.once('aborted', () => finish(failed('TRAE 额度响应中断，请重新查询。')));
        response.once('end', () => {
          if (done) return;
          try {
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            finish(undefined, value as Record<string, unknown>);
          } catch { finish(failed('TRAE 托管反代的额度响应格式无法识别。')); }
        });
      });
      req.once('error', () => finish(failed())); req.end();
    } catch { finish(failed()); }
  });
}

function activeAccount(value: Record<string, unknown>): { id: string; label?: string } {
  if (value.success !== true || !Array.isArray(value.accounts) || value.accounts.length > 1000) throw failed('无法确认 TRAE 托管反代的当前活跃账号。');
  const id = identity(value.active);
  if (!id) throw failed('TRAE 托管反代尚未选择活跃账号，请先在反代账号页登录或选择账号。');
  // Older native records can use token[:24] as their account key. Never
  // promote that fallback into a renderer-safe identity or URL segment.
  if (id === 'accounts' || id === '.' || id === '..' || id.startsWith('eyJ')) throw failed('TRAE 托管反代的活跃账号标识无法安全查询。');
  const matches = value.accounts.map(object).filter(account => account.id === id);
  if (matches.length !== 1 || identity(matches[0].user_id) !== id || matches[0].has_token !== true || matches[0].is_active === false || value.accounts.map(object).some(account => account.is_active === true && account.id !== id)) throw failed('无法确认 TRAE 托管反代的当前活跃账号。');
  return { id, ...(text(matches[0].label) ? { label: text(matches[0].label) } : {}) };
}

function quotaWindow(id: string, label: string, limitValue: unknown, usedValue: unknown, unit: string, officialDefault = false): QuotaWindow | undefined {
  const limit = amount(limitValue), used = amount(usedValue);
  if (limit === undefined || limit < 0 && limit !== -1) return;
  const measurement = officialDefault ? 'official-default' as const : 'reported' as const;
  if (limit === -1) return { id, label, unit, unlimited: true, measurement };
  const result: QuotaWindow = { id, label, total: limit, unit, measurement };
  // Only the verified CN credits omission rule supplies a zero below. Explicit
  // malformed values and unverified fast-request omissions remain unknown.
  if (used !== undefined && used >= 0) {
    result.remaining = Math.max(limit - used, 0);
    if (limit > 0) { result.remainingPercent = Math.min(100, result.remaining / limit * 100); result.usedPercent = 100 - result.remainingPercent; }
  }
  return result;
}

function currentEntitlementPacks(rawValue: unknown, now: number): Record<string, unknown>[] {
  const raw = object(rawValue);
  if (raw.code !== undefined && raw.code !== 0 || !Array.isArray(raw.user_entitlement_pack_list) || raw.user_entitlement_pack_list.length > 100) return [];
  return raw.user_entitlement_pack_list.map(object).filter(pack => {
    // Official status enum: Init=0, Active=1, Canceled=3, Terminated=4, Expired=5.
    // A canceled subscription remains usable until its reported expiry.
    if (pack.status !== 1 && pack.status !== 3) return false;
    const base = object(pack.entitlement_base_info), start = base.start_time, end = pack.expire_time ?? base.end_time;
    const validTime = (time: unknown) => time === undefined || typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 && time <= 253402300799;
    return validTime(start) && validTime(end) && !(typeof start === 'number' && start > now / 1000) && !(typeof end === 'number' && end > 0 && end <= now / 1000);
  });
}

type QuotaMetric = 'credits' | 'fast';
interface TraeQuotaGrant { window: QuotaWindow; metric: QuotaMetric; groupKey: string; groupLabel: string }
export interface TraeQuotaProjection { windows: QuotaWindow[]; summary?: QuotaWindow; details: QuotaWindow[] }

function quotaGroupName(value: unknown): string | undefined {
  const label = text(value, 120);
  return label && !/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(label) ? label : undefined;
}
function quotaGroupType(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}
function creditsUsage(pack: Record<string, unknown>): { value: unknown; defaulted: boolean } {
  const usage = pack.usage;
  const record = usage !== null && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : undefined;
  // Installed official CN ICubeUsageService.pRr and CNCommercialService both
  // use pack.usage?.credits_amount ?? 0 for successful require_usage responses.
  // This is an explicit client convention, not a claimed protobuf default.
  if (usage === undefined || record && record.credits_amount === undefined) return { value: 0, defaulted: true };
  return { value: record?.credits_amount, defaulted: false };
}
function totalAmount(values: (number | undefined)[]): number | undefined {
  if (values.some(value => value === undefined)) return;
  // Preserve native fractional credits through aggregation; formatting belongs
  // at the display boundary. Compensation avoids accumulating small errors.
  let total = 0, correction = 0;
  for (const value of values as number[]) { const part = value - correction, next = total + part; correction = next - total - part; total = next; }
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : undefined;
}
function aggregateQuota(id: string, label: string, grants: QuotaWindow[]): QuotaWindow {
  const result: QuotaWindow = { id, label, unit: grants[0].unit, grantCount: grants.length,
    measurement: grants.some(grant => grant.measurement === 'official-default') ? 'official-default' : 'reported' };
  const expiresAt = grants[0].expiresAt;
  if (expiresAt && grants.every(grant => grant.expiresAt === expiresAt)) result.expiresAt = expiresAt;
  if (grants.some(grant => grant.unlimited)) { result.unlimited = true; return result; }
  result.total = totalAmount(grants.map(grant => grant.total));
  result.remaining = totalAmount(grants.map(grant => grant.remaining));
  if (result.total !== undefined && result.total > 0 && result.remaining !== undefined) {
    result.remainingPercent = Math.min(100, result.remaining / result.total * 100); result.usedPercent = 100 - result.remainingPercent;
  }
  return result;
}

/** Native sources: pinned Trae2api-cn v1.0.10 main.py /api/checkin/credits/{id}
 * and trae_client.py fetch_account_credits; installed Trae CN 3.4.15's
 * cnCreditsUsage.js and ICubeUsageService independently confirm the v2
 * entitlement path, credits_limit/credits_amount and fast-request fields.
 * Parse the fresh raw entitlement only: credits.remaining includes relay-local
 * projected debits. Never use its empty-summary defaults or local balance.
 */
function projectTraeQuotaGrants(rawValue: unknown, now: number): TraeQuotaGrant[] {
  const packs = currentEntitlementPacks(rawValue, now);
  const grants: TraeQuotaGrant[] = [];
  for (const [index, pack] of packs.entries()) {
    const base = object(pack.entitlement_base_info), usage = object(pack.usage);
    const directQuota = object(base.quota), extraQuota = object(object(object(base.product_extra).subscription_extra).quota);
    const quota: Record<string, unknown> = {};
    for (const field of ['credits_limit', 'premium_model_fast_request_limit']) {
      if (Object.hasOwn(directQuota, field)) quota[field] = directQuota[field];
      else if (Object.hasOwn(extraQuota, field)) quota[field] = extraQuota[field];
    }
    const suffix = packs.length > 1 ? ` ${index + 1}` : '';
    const packId = createHash('sha256').update(JSON.stringify([base.entitlement_id ?? '', pack.source_id ?? '', index])).digest('hex').slice(0, 12);
    const groupName = quotaGroupName(pack.group_name), groupType = quotaGroupType(pack.group_type);
    const expiry = pack.expire_time ?? base.end_time;
    const expiresAt = typeof expiry === 'number' && expiry > 0 ? new Date(expiry * 1000).toISOString() : undefined;
    const append = (window: QuotaWindow | undefined, metric: QuotaMetric, groupLabel: string) => {
      if (!window) return;
      if (expiresAt) window.expiresAt = expiresAt;
      // Source/product IDs are not assumed to identify a category or a grant.
      // Only the server's bounded group metadata determines display grouping.
      grants.push({ window, metric, groupLabel, groupKey: JSON.stringify([metric, groupType ?? null, groupName ?? null, groupName || groupType !== undefined ? null : packId]) });
    };
    const credits = creditsUsage(pack), creditsLabel = groupName ?? '通用积分';
    const creditId = `trae-credits-${packId}`, creditLabel = creditsLabel + suffix;
    const creditWindow = quotaWindow(creditId, creditLabel, quota.credits_limit, credits.value, '积分', credits.defaulted);
    // An explicitly malformed quota is still evidence of an unknown grant.
    // Dropping it would turn a partial aggregate into a claimed full balance.
    append(creditWindow ?? (Object.hasOwn(quota, 'credits_limit') ? { id: creditId, label: creditLabel, unit: '积分', measurement: 'reported' } : undefined), 'credits', creditsLabel);
    const fastLabel = groupName ? groupName + ' · 高级模型快速请求' : '高级模型快速请求';
    const fastId = `trae-fast-${packId}`, fastDetailLabel = fastLabel + suffix;
    const fastWindow = quotaWindow(fastId, fastDetailLabel, quota.premium_model_fast_request_limit, usage.premium_model_fast_amount ?? usage.premium_model_fast_request_usage, '次');
    append(fastWindow ?? (Object.hasOwn(quota, 'premium_model_fast_request_limit') ? { id: fastId, label: fastDetailLabel, unit: '次', measurement: 'reported' } : undefined), 'fast', fastLabel);
  }
  // expire_time/end_time describe entitlement expiry, not reliably a quota
  // reset. Never turn those into a guessed rolling window or reset timestamp.
  return grants;
}

/** Independent grant details remain available to existing parser consumers. */
export function parseTraeCreditWindows(rawValue: unknown, now = Date.now()): QuotaWindow[] {
  return projectTraeQuotaGrants(rawValue, now).map(grant => grant.window);
}

/** CN official credits add each grant's max(limit - used, 0). Keep fast
 * request counts separate, and never average percentages across grants. */
export function parseTraeQuota(rawValue: unknown, now = Date.now()): TraeQuotaProjection {
  const grants = projectTraeQuotaGrants(rawValue, now), groups = new Map<string, TraeQuotaGrant[]>();
  for (const grant of grants) { const group = groups.get(grant.groupKey) ?? []; group.push(grant); groups.set(grant.groupKey, group); }
  const windows = [...groups.entries()].map(([key, group]) => aggregateQuota(`trae-${group[0].metric}-group-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`, group[0].groupLabel, group.map(grant => grant.window)));
  const credits = grants.filter(grant => grant.metric === 'credits').map(grant => grant.window);
  return { windows, ...(credits.length ? { summary: aggregateQuota('trae-credits-total', '总可用积分', credits) } : {}), details: grants.map(grant => grant.window) };
}

/** Installed official Trae CN 3.4.15 ICubeUsageService / cnCreditsUsage:
 * entitlement_base_info.product_type is the subscription identity. Its enum
 * is separate from user_pay_identity (ProPlus is 4 here, not identity's 2).
 * Package, PromoCode, ProPlusPack, PayGo and SoloInvite are not base plans.
 * Use the official CN priority and labels; no quota amounts or display text
 * can establish a plan. Init/future/expired packs cannot establish one either.
 */
export function parseTraePlan(rawValue: unknown, now = Date.now()): string | undefined {
  const current = new Set<number>();
  for (const pack of currentEntitlementPacks(rawValue, now)) {
    const base = object(pack.entitlement_base_info);
    if (typeof base.product_type === 'number') current.add(base.product_type);
  }
  const plans = [[100, 'Express'], [6, 'Ultra'], [4, 'Pro+'], [1, 'Pro'], [8, 'Lite'], [0, 'Free']] as const;
  return plans.find(([type]) => current.has(type))?.[1];
}

/** Call only after TraeRelayManager has verified ownership and the local
 * listener. No account ID supplied by a renderer or import record is accepted. */
export async function queryTraeRelayUsage(apiKey: string, options: TraeRelayUsageOptions = {}): Promise<TraeRelayUsageResult> {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(apiKey)) throw failed('TRAE 托管反代密钥无效，未查询额度。');
  const send = options.send ?? request, now = options.now ?? Date.now;
  const before = activeAccount(await getJson('/api/accounts', apiKey, send));
  const native = await getJson('/api/checkin/credits/' + encodeURIComponent(before.id), apiKey, send);
  if (native.success !== true || native.id !== before.id) throw failed('TRAE 反代未返回当前活跃账号的额度，请重新查询。');
  const after = activeAccount(await getJson('/api/accounts', apiKey, send));
  if (before.id !== after.id) throw failed('TRAE 反代的活跃账号在查询期间已切换，请重新查询。');
  const raw = object(native.raw), queriedAt = now(), quota = parseTraeQuota(raw, queriedAt);
  const plan = parseTraePlan(raw, queriedAt);
  return { accountId: after.id, ...(after.label ? { accountLabel: after.label } : {}), ...(plan ? { plan } : {}),
    usage: { status: quota.windows.length ? 'ready' : 'unavailable', ...quota, queriedAt: new Date(queriedAt).toISOString(),
      message: quota.windows.length ? '当前反代活跃账号的官方额度；省略的积分用量按官方客户端默认值计算，未识别值保持未知。' : '当前反代活跃账号未返回可识别的积分或快速请求额度，余额未知。' } };
}
