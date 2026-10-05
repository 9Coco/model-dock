import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { UsageManager, reportedUsage } from '../src/main/usage';
import type { RequestLog } from '../src/shared/types';
import type { UsageQuery } from '../src/shared/usage-types';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-usage-'));
  const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };
  const store = await Store.create(dir, codec);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const model = store.saveModel({ providerId: 'deepseek', upstreamId: 'test-upstream', alias: 'test-model', displayName: 'Test', wireApi: 'chat-completions', contextWindow: 128000, tools: true, vision: false, enabled: true });
  return { store, model, dir, usage: new UsageManager(store), query: { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' } };
}
function add(store: Store, entry: Partial<RequestLog> & { id: string }) {
  store.addLog({ time: '2026-10-05T12:00:00Z', alias: 'shared-model', providerName: 'History', endpoint: '/v1/responses', status: 200, durationMs: 100, ...entry });
}
describe('measured usage and durable totals', () => {
  it('reads Chat and Responses counters without adding reasoning or counting cache twice', () => {
    expect(reportedUsage({ usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 20 } } })).toEqual({ inputTokens: 100, outputTokens: 30, cachedInputTokens: 40 });
    expect(reportedUsage({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 0, input_tokens_details: { cached_tokens: 200 } } } })).toEqual({ inputTokens: 12, outputTokens: 0, cachedInputTokens: 12 });
    expect(reportedUsage({ usage: { total_tokens: 50 } })).toBeUndefined();
    expect(reportedUsage({ usage: { input_tokens: -1, output_tokens: 2 } })).toBeUndefined();
    expect(reportedUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(reportedUsage({ usage: { prompt_tokens: 50, completion_tokens: 4, prompt_cache_hit_tokens: 32, prompt_cache_miss_tokens: 18 } })).toEqual({ inputTokens: 50, outputTokens: 4, cachedInputTokens: 32 });
  });
  it('keeps unknown counters and prices distinct from known zero, filters calls and estimates using uncached input', async () => {
    const f = await fixture();
    f.store.addLog({ id: 'one', time: '2026-10-05T12:00:00Z', alias: f.model.alias, modelId: f.model.id, providerId: 'deepseek', providerName: 'DeepSeek', endpoint: '/tool/dsh/v1/chat/completions', tool: 'dsh', status: 200, durationMs: 100, usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 30 } });
    f.store.addLog({ id: 'two', time: '2026-10-05T13:00:00Z', alias: f.model.alias, modelId: f.model.id, providerId: 'deepseek', providerName: 'DeepSeek', endpoint: '/v1/chat/completions', status: 429, durationMs: 200 });
    expect(f.usage.query(f.query)).toMatchObject({ requests: 2, succeeded: 1, failed: 1, reportedRequests: 1, inputTokens: 100, outputTokens: 30, cachedInputTokens: 40, estimatedCostUsd: null, costedRequests: 0, averageDurationMs: 150 });
    f.usage.savePrice({ modelId: f.model.id, inputUsdPerMillion: 10, cachedInputUsdPerMillion: 2, outputUsdPerMillion: 20 });
    expect(f.usage.query(f.query).estimatedCostUsd).toBeCloseTo(0.00128);
    expect(f.usage.query({ ...f.query, tool: 'dsh' }).requests).toBe(1);
    f.usage.removePrice(f.model.id);
    expect(f.usage.query(f.query).estimatedCostUsd).toBeNull();
  });
  it('repeated request IDs update one event and database reopening retains totals', async () => {
    const f = await fixture();
    const call = { id: 'repeat', time: '2026-10-05T12:00:00Z', alias: f.model.alias, providerName: 'DeepSeek', endpoint: '/v1/responses', status: 200, durationMs: 100 };
    f.store.addLog(call); f.store.addLog(call);
    f.store.close();
    const reopened = await Store.create(f.dir, { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() });
    try { expect(new UsageManager(reopened).query(f.query).requests).toBe(1); } finally { reopened.close(); }
  });
  it('stores management credentials in the encrypted namespace without allowing gateway settings replacement', async () => {
    const f = await fixture(), originalKey = f.store.gatewayKey();
    f.store.setManagedState('gateway_key', { token: 'private-managed-secret' });
    expect(f.store.gatewayKey()).toBe(originalKey);
    expect(f.store.getManagedState('gateway_key', {})).toEqual({ token: 'private-managed-secret' });
    expect(readFileSync(join(f.dir, 'modeldock.sqlite')).includes(Buffer.from('private-managed-secret'))).toBe(false);
    expect(() => f.store.setManagedState('../bad', {})).toThrow();
  });
  it('cross-filters providers, tools and same-name models while every grouping reconciles to the selected totals', async () => {
    const f = await fixture();
    const second = f.store.saveModel({ ...f.model, id: undefined, providerId: 'volcengine-agent', alias: 'test-model' });
    const measured = (inputTokens: number) => ({ inputTokens, outputTokens: inputTokens / 10, cachedInputTokens: inputTokens / 5 });
    for (const [id, model, tool, input] of [
      ['a-codex', f.model, 'codex', 100], ['a-dsh', f.model, 'dsh', 200], ['a-generic', f.model, undefined, undefined],
      ['b-codex', second, 'codex', 300], ['b-vscode', second, 'vscode', 400], ['b-copilot', second, 'copilot', 500],
    ] as const) add(f.store, { id, modelId: model.id, providerId: model.providerId, alias: model.alias, providerName: 'Old Name', tool, usage: input === undefined ? undefined : measured(input) });
    const all = f.usage.query(f.query);
    expect(all).toMatchObject({ requests: 6, reportedRequests: 5, inputTokens: 1500, outputTokens: 150, collection: { missingUsageRecords: 1, unscopedRecords: 1, requestMetricsAvailable: true } });
    expect(all.byModel.map(group => group.label).sort()).toEqual(['DeepSeek - Test', '火山 Agent Plan - Test'].sort());
    for (const groups of [all.byProvider, all.byTool, all.byModel]) {
      expect(groups.reduce((sum, group) => sum + group.requests, 0)).toBe(all.requests);
      expect(groups.reduce((sum, group) => sum + group.inputTokens, 0)).toBe(all.inputTokens);
    }
    expect(all.byTool.find(group => group.key === 'codex')).toMatchObject({ label: 'Codex', requests: 2, inputTokens: 400 });
    const selected = f.usage.query({ ...f.query, providerId: 'deepseek', tool: 'codex', modelId: f.model.id });
    expect(selected).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 10 });
    expect(selected.filters).toEqual(all.filters);
    expect(f.usage.query({ ...f.query, providerId: 'deepseek', modelId: second.id }).requests).toBe(0);
    expect(f.usage.query({ ...f.query, providerId: 'deepseek', tool: 'unscoped' })).toMatchObject({ requests: 1, reportedRequests: 0, estimatedCostUsd: null });
  });
  it('retains deleted provider/model IDs as selectable historical groups without guessing their replacement', async () => {
    const f = await fixture();
    add(f.store, { id: 'before-delete', providerId: 'deepseek', providerName: 'DeepSeek Historical', modelId: f.model.id, alias: f.model.alias, usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 } });
    f.usage.savePrice({ modelId: f.model.id, inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 2 });
    f.store.deleteProvider('deepseek');
    const result = f.usage.query({ ...f.query, providerId: 'deepseek', modelId: f.model.id });
    expect(result.requests).toBe(1);
    expect(result.byProvider).toMatchObject([{ key: 'deepseek', label: 'DeepSeek Historical（已移除）' }]);
    expect(result.byModel[0]).toMatchObject({ key: f.model.id, label: 'DeepSeek Historical - test-model（已移除）' });
    expect(result.filters.providers[0].key).toBe('deepseek');
    expect(result.filters.models[0].key).toBe(f.model.id);
    expect(result.estimatedCostUsd).toBeCloseTo(0.000014);
    expect(result.collection).toMatchObject({ unidentifiedProviderRecords: 0, unidentifiedModelRecords: 0 });
  });
  it('separates legacy names from current accounts and separates identical legacy model names by supplier', async () => {
    const f = await fixture();
    add(f.store, { id: 'legacy-a', providerName: 'DeepSeek', alias: 'same-name' });
    add(f.store, { id: 'legacy-b', providerName: 'Supply B', alias: 'same-name' });
    add(f.store, { id: 'current-a', providerId: 'deepseek', providerName: 'DeepSeek', modelId: f.model.id, alias: 'same-name' });
    const all = f.usage.query(f.query);
    expect(all.byProvider).toHaveLength(3);
    expect(all.byModel).toHaveLength(3);
    const legacy = all.filters.providers.find(option => option.key.startsWith('legacy-provider:') && option.label.includes('DeepSeek'))!;
    expect(legacy.label).toBe('DeepSeek（历史记录）');
    expect(f.usage.query({ ...f.query, providerId: legacy.key }).requests).toBe(1);
    expect(f.usage.query({ ...f.query, providerId: 'deepseek' }).requests).toBe(1);
    const historicalModels = all.filters.models.filter(option => option.key.startsWith('legacy-model:'));
    expect(historicalModels).toHaveLength(2);
    expect(historicalModels[0].key).not.toBe(historicalModels[1].key);
    for (const option of historicalModels) expect(f.usage.query({ ...f.query, modelId: option.key }).requests).toBe(1);
    expect(all.collection).toMatchObject({ unidentifiedProviderRecords: 2, unidentifiedModelRecords: 2 });
  });
  it('exposes explicit unknown and unscoped filters without inferring current model aliases or tool bindings', async () => {
    const f = await fixture();
    add(f.store, { id: 'unknown', providerName: '', alias: 'unknown' });
    add(f.store, { id: 'no-id-current-alias', providerName: '', alias: f.model.alias });
    const all = f.usage.query(f.query);
    expect(all.filters.providers).toEqual([{ key: 'unknown-provider', label: '无法归属供应商' }]);
    expect(all.filters.tools).toEqual([{ key: 'unscoped', label: '未识别工具 / 通用接口' }]);
    expect(all.filters.models.some(option => option.key === f.model.id)).toBe(false);
    expect(f.usage.query({ ...f.query, modelId: 'unknown-model', providerId: 'unknown-provider', tool: 'unscoped' }).requests).toBe(1);
    expect(f.usage.query({ ...f.query, tool: 'codex' }).requests).toBe(0);
  });
  it('distinguishes removed accounts with identical historical names while unnamed models span sources safely', async () => {
    const f = await fixture();
    add(f.store, { id: 'removed-one', providerId: 'account-one', providerName: 'Same plan', modelId: 'removed-model-one', alias: 'same-model' });
    add(f.store, { id: 'removed-two', providerId: 'account-two', providerName: 'Same plan', modelId: 'removed-model-two', alias: 'same-model' });
    add(f.store, { id: 'unknown-one', providerId: 'account-one', providerName: 'Same plan', alias: 'unknown' });
    add(f.store, { id: 'unknown-two', providerId: 'account-two', providerName: 'Same plan', alias: 'unknown' });
    const all = f.usage.query(f.query);
    expect(all.byProvider).toHaveLength(2);
    expect(new Set(all.filters.providers.map(option => option.label)).size).toBe(2);
    expect(new Set(all.filters.models.filter(option => option.key !== 'unknown-model').map(option => option.label)).size).toBe(2);
    expect(all.filters.models.find(option => option.key === 'unknown-model')?.providerKey).toBeUndefined();
    expect(f.usage.query({ ...f.query, providerId: 'account-one' }).requests).toBe(2);
    expect(f.usage.query({ ...f.query, modelId: 'removed-model-two' }).requests).toBe(1);
  });
  it('isolates client counters from gateway records and does not invent client HTTP success or latency', async () => {
    const f = await fixture();
    add(f.store, { id: 'gateway', tool: 'codex', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 }, modelId: f.model.id, providerId: 'deepseek' });
    f.store.addClientUsage({ id: 'client:synthetic', time: '2026-10-05T13:00:00Z', alias: 'client-model', providerName: 'Codex 本地会话', endpoint: 'codex-session', tool: 'codex', source: 'client', status: 200, durationMs: 999, usage: { inputTokens: 300, outputTokens: 30, cachedInputTokens: 40 } });
    expect(f.usage.query(f.query)).toMatchObject({ source: 'gateway', requests: 1, inputTokens: 100, succeeded: 1, averageDurationMs: 100 });
    const client = f.usage.query({ ...f.query, source: 'client' });
    expect(client).toMatchObject({ source: 'client', requests: 1, inputTokens: 300, succeeded: 0, failed: 0, averageDurationMs: 0, collection: { unit: 'usage-event', requestMetricsAvailable: false } });
    expect(client.byTool[0]).toMatchObject({ key: 'codex', succeeded: 0, failed: 0, averageDurationMs: 0 });
    expect(client.filters.models[0].label).toContain('client-model');
    expect(client.filters.providers.some(option => option.key === 'deepseek')).toBe(false);
    expect(f.usage.query({ ...f.query, source: 'client', providerId: client.filters.providers[0].key }).requests).toBe(1);
  });
  it('fills local calendar days including empty days and excludes the upper date boundary', async () => {
    const f = await fixture();
    const start = new Date(2026, 9, 4), end = new Date(2026, 9, 7);
    add(f.store, { id: 'middle-day', time: new Date(2026, 9, 5, 12).toISOString() });
    add(f.store, { id: 'exclusive-end', time: end.toISOString() });
    const result = f.usage.query({ from: start.toISOString(), to: end.toISOString() });
    expect(result.daily.map(group => [group.key, group.requests])).toEqual([['2026-10-04', 0], ['2026-10-05', 1], ['2026-10-06', 0]]);
    expect(result.requests).toBe(1);
    expect(result.daily[0].estimatedCostUsd).toBeNull();
  });
  it('steps through DST calendar dates rather than adding fixed 24-hour intervals', async () => {
    const previous = process.env.TZ; process.env.TZ = 'America/New_York';
    try {
      const f = await fixture();
      const result = f.usage.query({ from: '2026-11-01T00:00:00-04:00', to: '2026-11-03T00:00:00-05:00', timeZone: 'America/New_York' });
      expect(result.daily.map(group => group.key)).toEqual(['2026-11-01', '2026-11-02']);
      // This 366-day calendar period is 366 * 24 hours + 1 hour due to the offset change.
      const maximum = { from: '2025-11-02T00:00:00-04:00', to: '2026-11-03T00:00:00-05:00', timeZone: 'America/New_York' };
      expect(Date.parse(maximum.to) - Date.parse(maximum.from)).toBe(366 * 86400_000 + 3600_000);
      expect(f.usage.query(maximum).daily).toHaveLength(366);
      expect(() => f.usage.query({ ...maximum, to: '2026-11-04T00:00:00-05:00' })).toThrow();
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('keeps a deliberately zero price distinct from missing pricing and never prices unknown counters', async () => {
    const f = await fixture();
    add(f.store, { id: 'reported-zero', modelId: f.model.id, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } });
    add(f.store, { id: 'missing', modelId: f.model.id });
    expect(f.usage.query(f.query)).toMatchObject({ reportedRequests: 1, costedRequests: 0, estimatedCostUsd: null });
    f.usage.savePrice({ modelId: f.model.id, inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 });
    expect(f.usage.query(f.query)).toMatchObject({ requests: 2, reportedRequests: 1, costedRequests: 1, estimatedCostUsd: 0, collection: { missingUsageRecords: 1 } });
  });
  it('rejects malformed filter/source values while an unknown historical ID simply matches no rows', async () => {
    const f = await fixture();
    for (const patch of [{ source: 'all' }, { source: null }, { tool: 'constructor' }, { tool: 'invalid' }, { providerId: null }, { modelId: 0 }]) {
      expect(() => f.usage.query({ ...f.query, ...patch } as unknown as UsageQuery)).toThrow();
    }
    expect(f.usage.query({ ...f.query, providerId: 'deleted-id-from-history' }).requests).toBe(0);
  });

  it('derives consumed tokens and weighted cache hit percentage without adding cache twice', async () => {
    const f = await fixture();
    add(f.store, { id: 'large', modelId: f.model.id, providerId: 'deepseek', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 90 }, durationMs: 1000 });
    add(f.store, { id: 'small', modelId: f.model.id, providerId: 'deepseek', usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, durationMs: 3000 });
    add(f.store, { id: 'missing', modelId: f.model.id, providerId: 'deepseek' });
    const result = f.usage.query(f.query);
    expect(result).toMatchObject({ inputTokens: 110, cachedInputTokens: 90, newInputTokens: 20, outputTokens: 20, totalTokens: 130, reportedRequests: 2, speedRecords: 2, averageOutputTokensPerSecond: 5 });
    expect(result.cacheHitPercent).toBeCloseTo(90 / 110 * 100);
    expect(result.byProvider[0].cacheHitPercent).toBeCloseTo(result.cacheHitPercent!);
    expect(result.logs.find(row => row.id === 'missing')).toMatchObject({ estimatedCostUsd: null, tokensPerSecond: null, cacheHitPercent: null });
    expect(result.logs.find(row => row.id === 'missing')?.totalTokens).toBeUndefined();
  });

  it('shows metadata-only paginated logs in stable newest-first order and applies status to all totals and groups', async () => {
    const f = await fixture();
    for (let index = 0; index < 9; index++) add(f.store, { id: `paged-${index}`, time: `2026-10-05T12:0${index}:00Z`, providerId: 'deepseek', modelId: f.model.id, tool: 'dsh', status: index % 2 ? 429 : 200, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 1 } });
    const result = f.usage.query({ ...f.query, status: 'failed', page: 2, pageSize: 2 });
    expect(result).toMatchObject({ requests: 4, succeeded: 0, failed: 4, inputTokens: 40, pagination: { page: 2, pageSize: 2, total: 4, totalPages: 2 } });
    expect(result.logs.map(row => row.id)).toEqual(['paged-3', 'paged-1']);
    expect(result.filters.statusCodes).toEqual([200, 429]);
    expect(result.byProvider[0].requests).toBe(4); expect(result.daily.reduce((sum, row) => sum + row.requests, 0)).toBe(4);
    expect(f.usage.query({ ...f.query, status: 429 }).requests).toBe(4);
    expect(f.usage.query({ ...f.query, status: 'success' }).requests).toBe(5);
    expect(f.usage.query({ ...f.query, page: 999, pageSize: 2 }).pagination).toMatchObject({ page: 5, totalPages: 5 });
    expect(Object.keys(result.logs[0]).sort()).not.toContain('body');
    for (const patch of [{ pageSize: 101 }, { page: 0 }, { page: 1.5 }, { status: '200' }, { status: 0 }, { status: 600 }, { timeZone: 'Not/AZone' }, { granularity: 'minute' }]) expect(() => f.usage.query({ ...f.query, ...patch } as unknown as UsageQuery)).toThrow();
  });

  it('creates 24 hourly HK buckets independent of the host zone and keeps the upper boundary exclusive', async () => {
    const f = await fixture(), query = { from: '2026-10-06T16:00:00.000Z', to: '2026-10-07T16:00:00.000Z' };
    add(f.store, { id: 'before', time: '2026-10-06T15:59:59.999Z' });
    add(f.store, { id: 'start', time: query.from });
    add(f.store, { id: 'middle', time: '2026-10-07T04:15:00.000Z' });
    add(f.store, { id: 'upper', time: query.to });
    const result = f.usage.query(query);
    expect(result).toMatchObject({ timeZone: 'Asia/Hong_Kong', granularity: 'hour', requests: 2 });
    expect(result.hourly).toHaveLength(24); expect(result.trend).toEqual(result.hourly);
    expect(result.hourly[0]).toMatchObject({ label: '2026-10-07 00:00', requests: 1 });
    expect(result.hourly[12]).toMatchObject({ label: '2026-10-07 12:00', requests: 1 });
    expect(result.daily.map(row => [row.key, row.requests])).toEqual([['2026-10-07', 2]]);
    expect(result.logs.map(row => row.id)).toEqual(['middle', 'start']);
  });

  it('uses 25 distinct hourly buckets across a fallback DST day without merging the repeated hour', async () => {
    const f = await fixture(), query = { from: '2026-11-01T00:00:00-04:00', to: '2026-11-02T00:00:00-05:00', timeZone: 'America/New_York' };
    add(f.store, { id: 'first-1am', time: new Date('2026-11-01T01:15:00-04:00').toISOString() });
    add(f.store, { id: 'second-1am', time: new Date('2026-11-01T01:15:00-05:00').toISOString() });
    const result = f.usage.query(query), repeated = result.hourly.filter(row => row.label === '2026-11-01 01:00');
    expect(result.hourly).toHaveLength(25); expect(repeated).toHaveLength(2);
    expect(repeated.map(row => row.requests)).toEqual([1, 1]); expect(repeated[0].key).not.toBe(repeated[1].key);
  });

  it('allows explicit exact historical model prices without pricing same-named current accounts or unknown models', async () => {
    const f = await fixture();
    add(f.store, { id: 'legacy-a', alias: 'same-model', providerName: 'Historical A', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 } });
    add(f.store, { id: 'legacy-b', alias: 'same-model', providerName: 'Historical B', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 } });
    add(f.store, { id: 'current', alias: 'same-model', providerId: 'deepseek', modelId: f.model.id, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 } });
    add(f.store, { id: 'unknown', alias: 'unknown', providerName: 'Historical A', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 } });
    const observed = f.usage.query(f.query), key = observed.filters.models.find(item => item.label.includes('Historical A - same-model'))!.key;
    f.usage.savePrice({ modelId: key, inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 4 });
    const result = f.usage.query(f.query);
    expect(result.costedRequests).toBe(1); expect(result.estimatedCostUsd).toBeCloseTo(0.000262);
    expect(result.logs.find(row => row.id === 'legacy-a')?.estimatedCostUsd).toBeCloseTo(0.000262);
    expect(result.logs.filter(row => row.id !== 'legacy-a').every(row => row.estimatedCostUsd === null)).toBe(true);
    expect(() => f.usage.savePrice({ modelId: 'unknown-model', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 1 })).toThrow();
    expect(() => f.usage.savePrice({ modelId: 'unobserved-alias', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 1 })).toThrow();
  });

  it('treats cache writes as a subset and keeps write costs unknown until their explicit price is available', async () => {
    const f = await fixture();
    const measured = reportedUsage({ usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } } })!;
    expect(measured).toEqual({ inputTokens: 100, cachedInputTokens: 40, cacheCreationInputTokens: 20, outputTokens: 10 });
    // Store's root-owned migration preserves the optional cache-write counter.
    add(f.store, { id: 'write', modelId: f.model.id, usage: measured });
    f.usage.savePrice({ modelId: f.model.id, inputUsdPerMillion: 10, cachedInputUsdPerMillion: 2, outputUsdPerMillion: 20 });
    expect(f.usage.query(f.query)).toMatchObject({ newInputTokens: 40, cacheCreationInputTokens: 20, totalTokens: 110, estimatedCostUsd: null, costedRequests: 0 });
    f.usage.savePrice({ modelId: f.model.id, inputUsdPerMillion: 10, cachedInputUsdPerMillion: 2, outputUsdPerMillion: 20, cacheCreationUsdPerMillion: 12.5 });
    expect(f.usage.query(f.query)).toMatchObject({ newInputTokens: 40, estimatedCostUsd: 0.00093, costedRequests: 1 });
    expect(() => f.usage.savePrice({ modelId: f.model.id, inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 1, cacheCreationUsdPerMillion: -1 })).toThrow();
  });

  it('never turns client placeholders or unknown output timing into real HTTP metrics', async () => {
    const f = await fixture();
    f.store.addClientUsage({ id: 'client:no-http', time: '2026-10-05T13:00:00Z', alias: 'Client model', providerName: 'Client history', endpoint: 'local-session', source: 'client', tool: 'codex', status: 200, durationMs: 999, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } });
    const result = f.usage.query({ ...f.query, source: 'client' });
    expect(result).toMatchObject({ succeeded: 0, failed: 0, averageDurationMs: 0, averageOutputTokensPerSecond: null, latencyRecords: 0, speedRecords: 0 });
    expect(result.logs[0]).toMatchObject({ status: null, durationMs: null, tokensPerSecond: null, estimatedCostUsd: null });
    expect(result.filters.statusCodes).toEqual([]);
    expect(() => f.usage.query({ ...f.query, source: 'client', status: 'success' })).toThrow(/HTTP/);
    add(f.store, { id: 'zero-duration', modelId: f.model.id, durationMs: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } });
    const gateway = f.usage.query(f.query);
    expect(gateway.logs[0].tokensPerSecond).toBeNull(); expect(gateway.averageOutputTokensPerSecond).toBeNull();
  });
});
