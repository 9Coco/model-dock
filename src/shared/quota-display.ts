import type { QuotaWindow, SubscriptionUsage } from './auth-types';

export const QUOTA_CACHE_TTL_MS = 5 * 60_000;
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function timestamp(value: string | number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : undefined;
}
export function quotaDateLabel(value: string | number | null | undefined): string {
  const time = timestamp(value); return time === undefined ? '未知' : dateFormatter.format(time);
}
export function quotaPercent(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
}
export function quotaPercentLabel(value: number | undefined): string {
  const measured = quotaPercent(value); return measured === undefined ? '未知' : `${Number(measured.toFixed(1))}%`;
}
function duration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  if (days) return `${days} 天${hours ? ` ${hours} 小时` : ''}`;
  if (hours) return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`;
  return `${minutes} 分钟`;
}
export function quotaResetLabel(value: string | undefined, now: number): string {
  const time = timestamp(value);
  if (time === undefined) return '重置时间未知';
  return time <= now ? '重置时间已到，请刷新' : `${duration(time - now)}后重置`;
}
export function quotaExpiryLabel(value: string | null, now: number): string {
  const time = timestamp(value);
  if (time === undefined) return '到期时间未返回';
  return time <= now ? `已到期 · ${quotaDateLabel(time)}` : `${duration(time - now)}后到期 · ${quotaDateLabel(time)}`;
}
export function quotaQueryAge(value: string | undefined, now: number): string {
  const time = timestamp(value);
  if (time === undefined) return '尚未查询';
  const age = Math.max(0, now - time);
  return age < 60_000 ? '刚刚查询' : `${duration(age)}前查询`;
}
export function quotaCacheExpired(usage: SubscriptionUsage, now: number): boolean {
  const time = timestamp(usage.queriedAt);
  return usage.status === 'stale' || time !== undefined && (now - time >= QUOTA_CACHE_TTL_MS || resetPassedSinceQuery(usage, time, now));
}
function resetPassedSinceQuery(usage: SubscriptionUsage, queriedAt: number, now: number): boolean {
  return usage.windows.some(window => {
    const resetAt = timestamp(window.resetAt);
    return resetAt !== undefined && resetAt > queriedAt && resetAt <= now;
  });
}
/** A five-second account cache read never implies a five-second network query. */
export function quotaRefreshDue(usage: SubscriptionUsage, authorized: boolean, now: number, retryAfter = 0): boolean {
  if (!authorized || now < retryAfter) return false;
  const time = timestamp(usage.queriedAt);
  return time === undefined || now - time >= QUOTA_CACHE_TTL_MS || resetPassedSinceQuery(usage, time, now);
}
export function quotaRetryAt(now: number, failures: number): number {
  return now + Math.min(30 * 60_000, QUOTA_CACHE_TTL_MS * 2 ** Math.max(0, failures - 1));
}
export function quotaAmountLabel(window: QuotaWindow): string | undefined {
  if (window.unlimited) return '不限量';
  const finite = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const unit = window.unit ? ` ${window.unit}` : '';
  if (finite(window.remaining) && finite(window.total)) return `${number(window.remaining!)} / ${number(window.total!)}${unit}`;
  if (finite(window.remaining)) return `剩余 ${number(window.remaining!)}${unit}`;
  if (finite(window.total)) return `总额 ${number(window.total!)}${unit}`;
  return undefined;
}
export function resetCreditsLabel(usage: SubscriptionUsage, now?: number): { label: string; known: boolean; stale: boolean; available?: number } {
  const status = usage.resetCreditsStatus ?? (usage.resetCredits ? usage.status === 'stale' ? 'stale' : 'ready' : 'unavailable');
  const available = usage.resetCredits?.available;
  const known = (status === 'ready' || status === 'stale') && typeof available === 'number' && Number.isSafeInteger(available) && available >= 0;
  if (known) {
    const expiries = usage.resetCredits!.expiresAt;
    // Only a complete grant list can establish how many known grants expired.
    // A summary count with absent/partial details remains a measured count.
    const expired = now !== undefined && expiries.length === available ? expiries.filter(value => {
      const expiry = timestamp(value); return expiry !== undefined && expiry <= now;
    }).length : 0;
    const current = available! - expired;
    return { label: `${status === 'stale' ? '上次可用' : '可用重置'} ${current} 次`, known: true, stale: status === 'stale', available: current };
  }
  return { label: status === 'not-supported' ? '上游未提供重置次数' : '可用重置次数未知', known: false, stale: status === 'stale' };
}
