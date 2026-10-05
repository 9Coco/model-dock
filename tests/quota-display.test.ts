import { describe, expect, it } from 'vitest';
import type { QuotaWindow, SubscriptionUsage } from '../src/shared/auth-types';
import { QUOTA_CACHE_TTL_MS, quotaAmountLabel, quotaCacheExpired, quotaDateLabel, quotaExpiryLabel, quotaPercentLabel, quotaQueryAge, quotaRefreshDue, quotaResetLabel, quotaRetryAt, resetCreditsLabel } from '../src/shared/quota-display';

const now = Date.parse('2026-10-07T10:00:00Z');
const usage = (patch: Partial<SubscriptionUsage> = {}): SubscriptionUsage => ({ status: 'ready', windows: [], message: '', queriedAt: new Date(now).toISOString(), ...patch });
describe('truthful quota and reset display', () => {
  it('distinguishes unknown percentages, zero and unlimited without inventing an entitlement', () => {
    expect(quotaPercentLabel(undefined)).toBe('未知'); expect(quotaPercentLabel(NaN)).toBe('未知'); expect(quotaPercentLabel(0)).toBe('0%'); expect(quotaPercentLabel(68.25)).toBe('68.3%');
    expect(quotaAmountLabel({ id: 'unlimited', label: '聊天', unlimited: true })).toBe('不限量');
    expect(quotaAmountLabel({ id: 'credits', label: 'AI Credits', total: 100, remaining: 65, unit: 'AI Credits' })).toBe('65 / 100 AI Credits');
    expect(quotaAmountLabel({ id: 'unknown', label: '额度' })).toBeUndefined();
  });
  it('shows every reset expiry accurately and uses Hong Kong dates independently of host timezone', () => {
    expect(quotaResetLabel(undefined, now)).toBe('重置时间未知'); expect(quotaResetLabel('invalid', now)).toBe('重置时间未知');
    expect(quotaResetLabel(new Date(now + 3_660_000).toISOString(), now)).toBe('1 小时 1 分钟后重置');
    expect(quotaResetLabel(new Date(now - 1).toISOString(), now)).toBe('重置时间已到，请刷新');
    expect(quotaExpiryLabel(null, now)).toBe('到期时间未返回'); expect(quotaExpiryLabel(new Date(now - 60_000).toISOString(), now)).toContain('已到期');
    expect(quotaDateLabel('2026-10-07T10:00:00Z')).toContain('18:00'); expect(quotaDateLabel('invalid')).toBe('未知');
  });
  it('keeps unsupported and missing reset credit counts distinct from a measured zero', () => {
    expect(resetCreditsLabel(usage()).label).toBe('可用重置次数未知');
    expect(resetCreditsLabel(usage({ resetCreditsStatus: 'not-supported' })).label).toBe('上游未提供重置次数');
    expect(resetCreditsLabel(usage({ resetCreditsStatus: 'ready', resetCredits: { available: 0, expiresAt: [] } })).label).toBe('可用重置 0 次');
    expect(resetCreditsLabel(usage({ resetCreditsStatus: 'stale', resetCredits: { available: 2, expiresAt: [null, '2026-10-09T10:00:00Z'] } }))).toEqual({ label: '上次可用 2 次', known: true, stale: true, available: 2 });
    expect(resetCreditsLabel(usage({ resetCreditsStatus: 'unavailable', resetCredits: { available: 2, expiresAt: [] } })).known).toBe(false);
  });
  it('subtracts known expired grants only when their detail list is complete', () => {
    const expiries = ['2026-10-06T10:00:00Z', '2026-10-09T10:00:00Z', null];
    expect(resetCreditsLabel(usage({ resetCredits: { available: 3, expiresAt: expiries } }), now).available).toBe(2);
    expect(resetCreditsLabel(usage({ resetCredits: { available: 4, expiresAt: expiries } }), now).available).toBe(4);
    expect(resetCreditsLabel(usage({ resetCredits: { available: 3, expiresAt: [] } }), now).available).toBe(3);
  });
  it('refreshes a quota as its known reset deadline passes once, while respecting failure backoff', () => {
    const window: QuotaWindow = { id: 'short', label: '短窗口', remainingPercent: 20, resetAt: new Date(now + 60_000).toISOString() };
    const beforeReset = usage({ windows: [window] });
    expect(quotaRefreshDue(beforeReset, true, now + 59_000)).toBe(false);
    expect(quotaRefreshDue(beforeReset, true, now + 60_000)).toBe(true);
    expect(quotaCacheExpired(beforeReset, now + 60_000)).toBe(true);
    expect(quotaRefreshDue(beforeReset, true, now + 60_000, now + 120_000)).toBe(false);
    const freshWithOldDeadline = usage({ windows: [window], queriedAt: new Date(now + 60_001).toISOString() });
    expect(quotaRefreshDue(freshWithOldDeadline, true, now + 60_002)).toBe(false);
  });
  it('allows automatic queries once per cache TTL and backs failed requests off, never every list poll', () => {
    expect(quotaRefreshDue(usage({ status: 'not-queried', queriedAt: undefined }), true, now)).toBe(true);
    expect(quotaRefreshDue(usage(), true, now + 5000)).toBe(false); expect(quotaRefreshDue(usage(), true, now + QUOTA_CACHE_TTL_MS)).toBe(true);
    expect(quotaRefreshDue(usage({ queriedAt: undefined }), false, now)).toBe(false);
    const next = quotaRetryAt(now, 2); expect(next).toBe(now + 10 * 60_000);
    expect(quotaRefreshDue(usage({ status: 'stale', queriedAt: new Date(now - 10 * 60_000).toISOString() }), true, now + 5000, next)).toBe(false);
    expect(quotaRetryAt(now, 8)).toBe(now + 30 * 60_000);
    expect(quotaCacheExpired(usage(), now + QUOTA_CACHE_TTL_MS)).toBe(true); expect(quotaQueryAge(undefined, now)).toBe('尚未查询'); expect(quotaQueryAge(new Date(now + 60_000).toISOString(), now)).toBe('刚刚查询');
  });
});
