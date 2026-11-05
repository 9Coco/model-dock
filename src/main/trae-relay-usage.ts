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

function quotaWindow(id: string, label: string, limitValue: unknown, usedValue: unknown, unit: string): QuotaWindow | undefined {
  const limit = amount(limitValue), used = amount(usedValue);
  if (limit === undefined || limit < 0 && limit !== -1) return;
  if (limit === -1) return { id, label, unit, unlimited: true, measurement: 'reported' };
  const result: QuotaWindow = { id, label, total: limit, unit, measurement: 'reported' };
  // Missing or malformed usage is unknown, not the native parser's zero default.
  if (used !== undefined && used >= 0) {
    result.remaining = Math.max(limit - used, 0);
    if (limit > 0) { result.remainingPercent = Math.min(100, result.remaining / limit * 100); result.usedPercent = 100 - result.remainingPercent; }
  }
  return result;
}

/** Native sources: pinned Trae2api-cn v1.0.10 main.py /api/checkin/credits/{id}
 * and trae_client.py fetch_account_credits; installed Trae CN 3.4.15's
 * cnCreditsUsage.js and ICubeUsageService independently confirm the v2
 * entitlement path, credits_limit/credits_amount and fast-request fields.
 * Parse the fresh raw entitlement only: credits.remaining includes relay-local
 * projected debits, and its parser invents zero for absent usage/packs.
 */
export function parseTraeCreditWindows(rawValue: unknown): QuotaWindow[] {
  const raw = object(rawValue);
  if (raw.code !== undefined && raw.code !== 0 || !Array.isArray(raw.user_entitlement_pack_list) || raw.user_entitlement_pack_list.length > 100) return [];
  const windows: QuotaWindow[] = [];
  for (const [index, value] of raw.user_entitlement_pack_list.entries()) {
    const pack = object(value), base = object(pack.entitlement_base_info), usage = object(pack.usage);
    if (['expired', 'terminated', 'inactive', '4', '5'].includes(String(pack.status ?? '').toLowerCase())) continue;
    const directQuota = object(base.quota), extraQuota = object(object(object(base.product_extra).subscription_extra).quota);
    const quota = Object.keys(directQuota).length ? directQuota : extraQuota;
    const suffix = raw.user_entitlement_pack_list.length > 1 ? ` ${index + 1}` : '';
    const packId = createHash('sha256').update(JSON.stringify([base.entitlement_id ?? '', pack.source_id ?? '', index])).digest('hex').slice(0, 12);
    const credits = quotaWindow(`trae-credits-${packId}`, '通用积分' + suffix, quota.credits_limit, usage.credits_amount, '积分');
    if (credits) windows.push(credits);
    const fast = quotaWindow(`trae-fast-${packId}`, '高级模型快速请求' + suffix, quota.premium_model_fast_request_limit, usage.premium_model_fast_amount ?? usage.premium_model_fast_request_usage, '次');
    if (fast) windows.push(fast);
  }
  // expire_time/end_time describe entitlement expiry, not reliably a quota
  // reset. Never turn those into a guessed rolling window or reset timestamp.
  return windows;
}

/** Installed official Trae CN 3.4.15 ICubeUsageService / cnCreditsUsage:
 * entitlement_base_info.product_type is the subscription identity. Its enum
 * is separate from user_pay_identity (ProPlus is 4 here, not identity's 2).
 * Package, PromoCode, ProPlusPack, PayGo and SoloInvite are not base plans.
 * Use the official CN priority and labels; no quota amounts or display text
 * can establish a plan. Init/future/expired packs cannot establish one either.
 */
export function parseTraePlan(rawValue: unknown, now = Date.now()): string | undefined {
  const raw = object(rawValue);
  if (raw.code !== undefined && raw.code !== 0 || !Array.isArray(raw.user_entitlement_pack_list) || raw.user_entitlement_pack_list.length > 100) return;
  const current = new Set<number>();
  for (const value of raw.user_entitlement_pack_list) {
    const pack = object(value), base = object(pack.entitlement_base_info);
    // Native status enum: Init=0, Active=1, Canceled=3, Terminated=4, Expired=5.
    // Canceled subscriptions remain valid until their reported expiry.
    if (pack.status !== 1 && pack.status !== 3) continue;
    const start = base.start_time, end = pack.expire_time ?? base.end_time;
    const validTime = (time: unknown) => time === undefined || typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 && time <= 253402300799;
    if (!validTime(start) || !validTime(end) || typeof start === 'number' && start > now / 1000 || typeof end === 'number' && end > 0 && end <= now / 1000) continue;
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
  const raw = object(native.raw), windows = parseTraeCreditWindows(raw);
  const plan = parseTraePlan(raw, now());
  return { accountId: after.id, ...(after.label ? { accountLabel: after.label } : {}), ...(plan ? { plan } : {}),
    usage: { status: windows.length ? 'ready' : 'unavailable', windows, queriedAt: new Date(now()).toISOString(),
      message: windows.length ? '当前反代活跃账号的官方额度；各额度包分开显示，未返回的余额或重置时间保持未知。' : '当前反代活跃账号未返回可识别的积分或快速请求额度，余额未知。' } };
}
