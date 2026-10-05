import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { UsageManager } from '../src/main/usage';
import { buildUsageExport, usageCsv, usageDateRange } from '../src/shared/usage-report';
import type { UsageQuery } from '../src/shared/usage-types';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'modeldock-usage-report-'));
  const store = await Store.create(folder);
  cleanups.push(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const a = store.saveProvider({ name: '=HYPERLINK("https://example.invalid","click")', kind: 'openai-compatible', baseUrl: 'https://a.fixture.test/v1', enabled: true });
  const b = store.saveProvider({ name: 'Another provider', kind: 'openai-compatible', baseUrl: 'https://b.fixture.test/v1', enabled: true });
  const model = (providerId: string) => store.saveModel({ providerId, upstreamId: 'shared', alias: 'shared', displayName: 'Shared', wireApi: 'chat-completions', contextWindow: 0, tools: true, vision: false, enabled: true });
  const ma = model(a.id), mb = model(b.id), manager = new UsageManager(store);
  const time = new Date(2026, 9, 5, 12).toISOString();
  const query: UsageQuery = { from: new Date(2026, 9, 5).toISOString(), to: new Date(2026, 9, 7).toISOString(), source: 'gateway' };
  store.addLog({ id: 'report-a', time, providerId: a.id, providerName: a.name, modelId: ma.id, alias: ma.alias, tool: 'codex', endpoint: '/tool/codex/v1/chat/completions', status: 200, durationMs: 100, usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 } });
  store.addLog({ id: 'report-a-unknown', time, providerId: a.id, providerName: a.name, modelId: ma.id, alias: ma.alias, tool: 'dsh', endpoint: '/tool/dsh/v1/chat/completions', status: 500, durationMs: 200 });
  store.addLog({ id: 'report-b', time, providerId: b.id, providerName: b.name, modelId: mb.id, alias: mb.alias, tool: 'codex', endpoint: '/tool/codex/v1/chat/completions', status: 200, durationMs: 150, usage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 30 } });
  manager.savePrice({ modelId: ma.id, inputUsdPerMillion: 10, cachedInputUsdPerMillion: 2, outputUsdPerMillion: 20 });
  return { store, manager, query, time, a, b, ma };
}

/** Parse CSV as an external consumer does, including quoted commas and doubled quotes. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let value = '', quoted = false;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if (char === '\r' && text[i + 1] === '\n' && !quoted) { row.push(value); rows.push([...row]); row.length = 0; value = ''; i++; }
    else value += char;
  }
  return rows;
}

describe('usage reports share the selected supplier and tool scope', () => {
  it('exports only the filtered totals, chosen dimension and daily counts with partial cost coverage', async () => {
    const f = await fixture(), query = { ...f.query, providerId: f.a.id };
    const report = buildUsageExport(f.manager.query(query), query, 'byTool');
    expect(report.scope.provider).toEqual({ key: f.a.id, label: f.a.name });
    expect(report.totals).toMatchObject({ records: 2, succeeded: 1, failed: 1, reportedRecords: 1, missingUsageRecords: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, pricedRecords: 1, costCoverage: 0.5 });
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.00108);
    expect(report.groups.map(group => group.label).sort()).toEqual(['Codex', 'DSH']);
    expect(report.groups.find(group => group.key === 'dsh')?.inputTokens).toBeNull();
    expect(report.daily.map(day => day.records)).toEqual([2, 0]);
    expect(JSON.stringify(report)).not.toContain(f.b.name);
    const narrowed = { ...query, tool: 'codex' as const };
    expect(buildUsageExport(f.manager.query(narrowed), narrowed, 'byProvider').totals.records).toBe(1);
  });

  it('writes Chinese UTF-8 CSV, escapes names safely and keeps unknown counters/cost blank', async () => {
    const f = await fixture(), query = { ...f.query, providerId: f.a.id };
    const csv = usageCsv(f.manager.query(query), query, 'byTool');
    expect(csv.startsWith('\ufeff')).toBe(true);
    const rows = csvRows(csv), header = rows[0];
    expect(header).toContain('供应商筛选');
    const tool = rows.find(row => row[0] === '工具' && row[1] === 'DSH')!;
    expect(tool.slice(6, 9)).toEqual(['', '', '']);
    expect(tool[10]).toBe('');
    expect(rows[1][10]).toBe('0.00108');
    expect(rows.every(row => row.length === header.length)).toBe(true);
    expect(rows[1][17]).toBe(`'${f.a.name}`);
    expect(csv).not.toContain(f.b.name);
  });

  it('exports client counter events without claiming request success/failure or latency', async () => {
    const f = await fixture();
    f.store.addClientUsage({ id: 'client:report', time: f.time, providerName: 'Client history', alias: 'gpt-history', tool: 'codex', endpoint: 'codex-session', status: 200, durationMs: 999, source: 'client', usage: { inputTokens: 7, cachedInputTokens: 3, outputTokens: 1 } });
    const query = { ...f.query, source: 'client' as const };
    const snapshot = f.manager.query(query), report = buildUsageExport(snapshot, query, 'byTool');
    expect(report.unit).toBe('usage-event');
    expect(report.totals).toMatchObject({ records: 1, succeeded: null, failed: null, averageDurationMs: null, inputTokens: 7, outputTokens: 1 });
    expect(csvRows(usageCsv(snapshot, query, 'byTool'))[1].slice(3, 5)).toEqual(['', '']);
    expect(csvRows(usageCsv(snapshot, query, 'byTool'))[1][11]).toBe('');
  });

  it('rejects a stale snapshot when the date or source changes', async () => {
    const f = await fixture(), snapshot = f.manager.query(f.query);
    expect(() => usageCsv(snapshot, { ...f.query, source: 'client' }, 'byProvider')).toThrow(/刷新/);
    expect(() => buildUsageExport(snapshot, { ...f.query, to: new Date(2026, 9, 8).toISOString() }, 'byProvider')).toThrow(/刷新/);
    expect(() => buildUsageExport(snapshot, { ...f.query, providerId: f.a.id }, 'byProvider')).toThrow(/刷新/);
    expect(() => buildUsageExport(snapshot, { ...f.query, status: 'failed' }, 'byProvider')).toThrow(/刷新/);
    expect(() => buildUsageExport(snapshot, { ...f.query, timeZone: 'UTC' }, 'byProvider')).toThrow(/刷新/);
  });

  it('converts inclusive HK calendar dates into UTC exclusive boundaries independently of the host zone', () => {
    expect(usageDateRange('2026-10-07', '2026-10-07')).toEqual({ from: '2026-10-06T16:00:00.000Z', to: '2026-10-07T16:00:00.000Z' });
    expect(usageDateRange('2026-11-01', '2026-11-01', 'America/New_York')).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
    expect(() => usageDateRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => usageDateRange('2026-10-08', '2026-10-07')).toThrow();
    expect(() => usageDateRange('2026-10-07', '2026-10-07', 'Not/AZone')).toThrow();
  });

  it('exports exactly the visible status-filtered totals, hourly trend and bounded log page with token semantics', async () => {
    const f = await fixture(), query = { ...f.query, status: 'success' as const, pageSize: 1 };
    const snapshot = f.manager.query(query), report = buildUsageExport(snapshot, query, 'byProvider');
    expect(report.scope).toMatchObject({ timeZone: 'Asia/Hong_Kong', status: 'success' });
    expect(report.totals).toMatchObject({ records: 2, inputTokens: 300, cachedInputTokens: 140, newInputTokens: 160, totalTokens: 350 });
    expect(report.totals.cacheHitPercent).toBeCloseTo(140 / 300 * 100);
    expect(report.logsPage).toMatchObject({ total: 2, page: 1, pageSize: 1, totalPages: 2 });
    expect(report.logsPage.items).toHaveLength(1);
    expect(report.groups.reduce((sum, row) => sum + row.records, 0)).toBe(2);
  });
});
