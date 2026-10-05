import { describe, expect, it } from 'vitest';
import { usageDateRange, usageMoney, usageRange, usageSpeed, usageStatus, usageTime } from '../src/shared/usage-display';
describe('usage display evidence boundaries', () => {
  it('does not fabricate zero cost, speed or HTTP success for unavailable data and client counters', () => {
    expect(usageMoney(null)).toBe('未知'); expect(usageMoney(0)).not.toBe('未知');
    expect(usageSpeed(null)).toBe('未知'); expect(usageSpeed(0)).toBe('0 tok/s'); expect(usageSpeed(12.25)).toBe('12.3 tok/s');
    expect(usageStatus(200, 'client')).toEqual({ label: '用量事件', tone: 'neutral' });
    expect(usageStatus(null, 'gateway')).toEqual({ label: '状态未知', tone: 'neutral' });
    expect(usageStatus(429, 'gateway')).toEqual({ label: '429', tone: 'error' });
  });
  it('uses Hong Kong calendar boundaries even when the UTC day differs', () => {
    expect(usageRange(1, new Date('2026-10-06T17:30:00Z'))).toEqual({ from: '2026-10-07', to: '2026-10-07' });
    expect(usageRange(7, new Date('2026-10-06T17:30:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(usageDateRange('2026-10-07', '2026-10-07')).toEqual({ from: '2026-10-06T16:00:00.000Z', to: '2026-10-07T16:00:00.000Z' });
    expect(usageTime('2026-10-06T17:30:00Z')).toContain('01:30');
  });
  it('rejects invalid dates, reversed ranges and ranges beyond a year', () => {
    expect(usageDateRange('2026-02-30', '2026-03-01')).toBeNull(); expect(usageDateRange('2026-10-07', '2026-10-06')).toBeNull(); expect(usageDateRange('2025-01-01', '2026-10-07')).toBeNull();
  });
});
