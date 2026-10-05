import { usageDateRange as resolveUsageDateRange, USAGE_TIME_ZONE } from './usage-report';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const usageCount = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
export const usageMoney = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '未知' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
export const usageSpeed = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '未知' : `${Number(value.toFixed(1))} tok/s`;
export function usageTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : '未知'; }
export function usageRange(days: number, now = new Date()): { from: string; to: string } {
  const to = dayFormatter.format(now), start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to };
}
export function usageDateRange(from: string, to: string): { from: string; to: string } | null {
  try { return resolveUsageDateRange(from, to, USAGE_TIME_ZONE); } catch { return null; }
}
export function usageStatus(status: number | null, source: 'gateway' | 'client'): { label: string; tone: 'success' | 'error' | 'neutral' } {
  if (source === 'client') return { label: '用量事件', tone: 'neutral' };
  if (status === null || !Number.isInteger(status) || status < 100 || status > 599) return { label: '状态未知', tone: 'neutral' };
  return { label: String(status), tone: status >= 200 && status < 400 ? 'success' : 'error' };
}
