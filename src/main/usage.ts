import type { Store } from './store';
import type { ModelPrice, TokenUsage, UsageDetail, UsageFilterOption, UsageGroup, UsageModelFilterOption, UsageQuery, UsageRecord, UsageSnapshot, UsageTotals } from '../shared/usage-types';
import type { Model, Provider, ToolId } from '../shared/types';
import { modelDisplayLabel } from '../shared/model-names';
import { usageCalendarParts, usageTimeZone } from '../shared/usage-report';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** One final upstream counter per request. Reasoning tokens are already included in output. */
export function reportedUsage(value: unknown): TokenUsage | undefined {
  const body = record(value);
  if (!body) return undefined;
  const response = record(body.response);
  const usage = record(response?.usage) ?? record(body.usage);
  if (!usage) return undefined;
  const inputTokens = tokens(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = tokens(usage.output_tokens ?? usage.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = record(usage.input_tokens_details) ?? record(usage.prompt_tokens_details);
  const cachedInputTokens = Math.min(inputTokens, tokens(details?.cached_tokens) ?? tokens(usage.prompt_cache_hit_tokens) ?? 0);
  const creation = details?.cache_write_tokens ?? usage.cache_creation_input_tokens;
  if (creation !== undefined && creation !== null && tokens(creation) === undefined) return undefined;
  return { inputTokens, outputTokens, cachedInputTokens, ...(creation == null ? {} : { cacheCreationInputTokens: Math.min(inputTokens - cachedInputTokens, tokens(creation)!) }) };
}
const fresh = (): UsageTotals => ({ requests: 0, succeeded: 0, failed: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, newInputTokens: 0, totalTokens: 0, cacheHitPercent: null, costedRequests: 0, estimatedCostUsd: null, averageDurationMs: 0, latencyRecords: 0, averageOutputTokensPerSecond: null, speedRecords: 0 });
function cost(usage: TokenUsage | undefined, price?: ModelPrice): number | null {
  if (!usage || !price || (usage.cacheCreationInputTokens ?? 0) > 0 && price.cacheCreationUsdPerMillion === undefined) return null;
  return ((usage.inputTokens - usage.cachedInputTokens - (usage.cacheCreationInputTokens ?? 0)) * price.inputUsdPerMillion
    + usage.cachedInputTokens * price.cachedInputUsdPerMillion + (usage.cacheCreationInputTokens ?? 0) * (price.cacheCreationUsdPerMillion ?? 0)
    + usage.outputTokens * price.outputUsdPerMillion) / 1_000_000;
}
function duration(value: UsageRecord): number | null { return typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : null; }
const speedSums = new WeakMap<UsageTotals, { output: number; durationMs: number }>();
// CC Switch 4.0 derives a weighted hit rate from cache-normalized categories:
// https://github.com/farion1231/cc-switch/blob/v4.0.0/src/components/usage/UsageHero.tsx
// Our storage keeps gross input, so cache read/write are subtracted for fresh
// input but are never added again to the headline consumed-token total.
function accumulate(total: UsageTotals, value: UsageRecord, price?: ModelPrice, requestMetrics = true): void {
  if (requestMetrics) {
    const elapsed = duration(value);
    if (elapsed !== null) {
      total.averageDurationMs = (total.averageDurationMs * total.latencyRecords + elapsed) / (total.latencyRecords + 1);
      total.latencyRecords++;
    }
    if (value.status >= 200 && value.status < 400) total.succeeded++; else total.failed++;
    if (value.usage && elapsed !== null && elapsed > 0) {
      const sum = speedSums.get(total) ?? { output: 0, durationMs: 0 };
      sum.output += value.usage.outputTokens; sum.durationMs += elapsed; speedSums.set(total, sum);
      total.averageOutputTokensPerSecond = sum.output / (sum.durationMs / 1000); total.speedRecords++;
    }
  }
  total.requests++;
  if (!value.usage) return;
  total.reportedRequests++;
  total.inputTokens += value.usage.inputTokens;
  total.outputTokens += value.usage.outputTokens;
  total.cachedInputTokens += value.usage.cachedInputTokens;
  total.cacheCreationInputTokens += value.usage.cacheCreationInputTokens ?? 0;
  total.newInputTokens = total.inputTokens - total.cachedInputTokens - total.cacheCreationInputTokens;
  total.totalTokens = total.inputTokens + total.outputTokens;
  total.cacheHitPercent = total.inputTokens > 0 ? total.cachedInputTokens / total.inputTokens * 100 : null;
  const estimated = cost(value.usage, price);
  if (estimated !== null) {
    total.costedRequests++;
    total.estimatedCostUsd = (total.estimatedCostUsd ?? 0) + estimated;
  }
}
const toolNames: Record<ToolId, string> = { codex: 'Codex', opencode: 'OpenCode', dsh: 'DSH', vscode: 'VS Code', copilot: 'Copilot app', 'claude-code': 'Claude Code' };
function toolKey(value: unknown): ToolId | 'unscoped' { return typeof value === 'string' && Object.hasOwn(toolNames, value) ? value as ToolId : 'unscoped'; }
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86400_000;
function hourBucket(time: number, timeZone: string): { key: string; label: string; time: number } {
  const parts = usageCalendarParts(time, timeZone), start = time - parts.minute * 60_000 - parts.second * 1000 - ((time % 1000) + 1000) % 1000;
  return { key: new Date(start).toISOString(), label: `${parts.day} ${String(parts.hour).padStart(2, '0')}:00`, time: start };
}
function dimensionFilter(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2000 || !value.trim()) throw new Error('用量筛选标识无效。');
  return value;
}
function matchesStatus(status: number, filter: NonNullable<UsageQuery['status']>): boolean {
  if (filter === 'all') return true;
  if (typeof filter === 'number') return status === filter;
  const success = status >= 200 && status < 400;
  return filter === 'success' ? success : !success;
}
interface Dimensions { provider: UsageFilterOption; model: UsageModelFilterOption; tool: UsageFilterOption }
function dimensions(row: UsageRecord, providers: Map<string, Provider>, models: Map<string, Model>): Dimensions {
  const providerId = row.providerId || undefined;
  const providerName = row.providerName.trim();
  const currentProvider = providerId ? providers.get(providerId) : undefined;
  const provider: UsageFilterOption = providerId
    ? { key: providerId, label: currentProvider?.name ?? `${providerName || '供应商'}（已移除）` }
    : providerName && providerName !== 'unknown'
      ? { key: `legacy-provider:${encodeURIComponent(providerName)}`, label: `${providerName}（历史记录）` }
      : { key: 'unknown-provider', label: '无法归属供应商' };
  const currentModel = row.modelId ? models.get(row.modelId) : undefined;
  const alias = row.alias.trim();
  const sourceName = currentProvider?.name || providerName || '来源未识别';
  const model: UsageModelFilterOption = row.modelId
    ? { key: row.modelId, label: currentModel
      ? modelDisplayLabel(currentModel, providers.get(currentModel.providerId))
      : `${sourceName} - ${alias || '模型'}（已移除）`, providerKey: provider.key }
    : alias && alias !== 'unknown'
      ? { key: `legacy-model:${encodeURIComponent(JSON.stringify([provider.key, alias]))}`, label: `${sourceName} - ${alias}（历史记录）`, providerKey: provider.key }
      : { key: 'unknown-model', label: '无法归属模型', providerKey: provider.key };
  const key = toolKey(row.tool);
  return { provider, model, tool: { key, label: key === 'unscoped' ? '未识别工具 / 通用接口' : toolNames[key] } };
}
/** Keep separately recorded account/model IDs visibly distinguishable even if names match. */
function distinguishLabels<T extends UsageFilterOption>(values: T[]): T[] {
  const labels = new Map<string, T[]>();
  for (const value of values) { const group = labels.get(value.label) ?? []; group.push(value); labels.set(value.label, group); }
  for (const same of labels.values()) {
    if (same.length < 2) continue;
    let length = 6;
    while (new Set(same.map(value => value.key.slice(-length))).size < same.length) length++;
    for (const value of same) value.label += ` · ${value.key.slice(-length)}`;
  }
  return values.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.key.localeCompare(b.key));
}
export class UsageManager {
  private readonly observedModelKeys = new Set<string>();
  constructor(private store: Store) {}
  prices(): ModelPrice[] { return this.store.getManagedState<ModelPrice[]>('usage.prices', []); }
  savePrice(price: ModelPrice): void {
    if (!price || typeof price.modelId !== 'string' || price.modelId === 'unknown-model' || !this.store.listModels().some(model => model.id === price.modelId) && !this.observedModelKeys.has(price.modelId)) throw new Error('请选择已有模型或已观察到的历史模型。');
    for (const key of ['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion'] as const) {
      if (typeof price[key] !== 'number' || !Number.isFinite(price[key]) || price[key] < 0 || price[key] > 1_000_000) throw new Error('单价必须是有效的非负数。');
    }
    if (price.cacheCreationUsdPerMillion !== undefined && (typeof price.cacheCreationUsdPerMillion !== 'number' || !Number.isFinite(price.cacheCreationUsdPerMillion) || price.cacheCreationUsdPerMillion < 0 || price.cacheCreationUsdPerMillion > 1_000_000)) throw new Error('缓存写入单价必须是有效的非负数。');
    this.store.setManagedState('usage.prices', [...this.prices().filter(item => item.modelId !== price.modelId), { modelId: price.modelId, inputUsdPerMillion: price.inputUsdPerMillion, cachedInputUsdPerMillion: price.cachedInputUsdPerMillion, outputUsdPerMillion: price.outputUsdPerMillion, ...(price.cacheCreationUsdPerMillion === undefined ? {} : { cacheCreationUsdPerMillion: price.cacheCreationUsdPerMillion }) }]);
  }
  removePrice(modelId: string): void { this.store.setManagedState('usage.prices', this.prices().filter(item => item.modelId !== modelId)); }
  query(query: UsageQuery): UsageSnapshot {
    if (!query || typeof query.from !== 'string' || typeof query.to !== 'string') throw new Error('请选择一年以内的有效时间范围。');
    const from = Date.parse(query?.from), to = Date.parse(query?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('请选择一年以内的有效时间范围。');
    const timeZone = usageTimeZone(query.timeZone), firstDay = usageCalendarParts(from, timeZone).day, lastDay = usageCalendarParts(to - 1, timeZone).day;
    const calendarDays = dayNumber(lastDay) - dayNumber(firstDay) + 1;
    if (calendarDays > 366) throw new Error('请选择一年以内的有效时间范围。');
    if (query.source !== undefined && query.source !== 'gateway' && query.source !== 'client') throw new Error('未知用量来源。');
    if (query.tool !== undefined && query.tool !== 'unscoped' && toolKey(query.tool) === 'unscoped') throw new Error('未知用量工具。');
    const source = query.source ?? 'gateway', providerFilter = dimensionFilter(query.providerId), modelFilter = dimensionFilter(query.modelId), statusFilter = query.status === undefined ? 'all' : query.status;
    if (!['all', 'success', 'failed'].includes(String(statusFilter)) && !(typeof statusFilter === 'number' && Number.isInteger(statusFilter) && statusFilter >= 100 && statusFilter <= 599)) throw new Error('未知用量状态筛选。');
    if (source === 'client' && statusFilter !== 'all') throw new Error('客户端用量事件没有可筛选的 HTTP 状态。');
    const pageSize = query.pageSize === undefined ? 25 : query.pageSize, requestedPage = query.page === undefined ? 1 : query.page, granularity = query.granularity === undefined ? (calendarDays === 1 ? 'hour' : 'day') : query.granularity;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new Error('用量日志分页参数无效（每页最多 100 条）。');
    if (granularity !== 'hour' && granularity !== 'day') throw new Error('未知用量趋势粒度。');
    if (granularity === 'hour' && calendarDays > 31) throw new Error('小时趋势最多显示 31 天，请切换每日趋势。');
    const prices = this.prices();
    const priceMap = new Map(prices.map(price => [price.modelId, price]));
    const providers = new Map(this.store.listProviders().map(provider => [provider.id, provider]));
    const models = new Map(this.store.listModels().map(model => [model.id, model]));
    const scope = this.store.usageRecords(new Date(from).toISOString(), new Date(to).toISOString())
      .filter(row => (row.source ?? 'gateway') === source).map(row => ({ row, dimensions: dimensions(row, providers, models) }));
    const providerOptions = new Map<string, UsageFilterOption>(), modelOptions = new Map<string, UsageModelFilterOption>(), toolOptions = new Map<string, UsageFilterOption>(), statusCodes = new Set<number>();
    for (const { row, dimensions: item } of scope) {
      providerOptions.set(item.provider.key, item.provider); toolOptions.set(item.tool.key, item.tool);
      const previousModel = modelOptions.get(item.model.key);
      // An unknown/malformed historical model may occur under more than one source.
      modelOptions.set(item.model.key, { ...item.model, providerKey: previousModel && previousModel.providerKey !== item.model.providerKey ? undefined : item.model.providerKey });
      if (item.model.key !== 'unknown-model') this.observedModelKeys.add(item.model.key);
      if (source === 'gateway' && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599) statusCodes.add(row.status);
    }
    const rows = scope.filter(({ row, dimensions: item }) => (!query.tool || item.tool.key === query.tool) && (!providerFilter || item.provider.key === providerFilter) && (!modelFilter || item.model.key === modelFilter)
      && matchesStatus(row.status, statusFilter));
    const requestMetrics = source === 'gateway';
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize)), page = Math.min(requestedPage, totalPages);
    const result: UsageSnapshot = { ...fresh(), source, from: new Date(from).toISOString(), to: new Date(to).toISOString(), timeZone, granularity, byModel: [], byProvider: [], byTool: [], daily: [], hourly: [], trend: [], prices, logs: [], pagination: { page, pageSize, total: rows.length, totalPages },
      appliedFilters: { tool: query.tool || undefined, providerId: providerFilter, modelId: modelFilter, status: statusFilter },
      filters: { providers: distinguishLabels([...providerOptions.values()]), models: distinguishLabels([...modelOptions.values()]), tools: distinguishLabels([...toolOptions.values()]), statusCodes: [...statusCodes].sort((a, b) => a - b) },
      collection: { unit: requestMetrics ? 'request' : 'usage-event', requestMetricsAvailable: requestMetrics, missingUsageRecords: 0, unscopedRecords: 0, unidentifiedProviderRecords: 0, unidentifiedModelRecords: 0 } };
    const groups = [new Map<string, UsageGroup>(), new Map<string, UsageGroup>(), new Map<string, UsageGroup>(), new Map<string, UsageGroup>(), new Map<string, UsageGroup>()];
    // Civil date keys are stepped independently of the host's zone or DST.
    for (let date = dayNumber(firstDay); date <= dayNumber(lastDay); date++) {
      const day = new Date(date * 86400_000).toISOString().slice(0, 10); groups[3].set(day, { ...fresh(), key: day, label: day });
    }
    if (granularity === 'hour') for (let time = hourBucket(from, timeZone).time; time < to; time += 3600_000) {
      const bucket = hourBucket(time, timeZone); groups[4].set(bucket.key, { ...fresh(), key: bucket.key, label: bucket.label });
    }
    for (const { row, dimensions: item } of rows) {
      const price = item.model.key === 'unknown-model' ? undefined : priceMap.get(item.model.key);
      accumulate(result, row, price, requestMetrics);
      if (!row.usage) result.collection.missingUsageRecords++;
      if (item.tool.key === 'unscoped') result.collection.unscopedRecords++;
      if (!row.providerId) result.collection.unidentifiedProviderRecords++;
      if (!row.modelId) result.collection.unidentifiedModelRecords++;
      const day = usageCalendarParts(Date.parse(row.time), timeZone).day;
      const buckets: [number, string, string][] = [[0, item.model.key, modelOptions.get(item.model.key)!.label], [1, item.provider.key, providerOptions.get(item.provider.key)!.label], [2, item.tool.key, item.tool.label], [3, day, day]];
      if (granularity === 'hour') { const hour = hourBucket(Date.parse(row.time), timeZone); buckets.push([4, hour.key, hour.label]); }
      for (const [index, key, label] of buckets) {
        let group = groups[index].get(key);
        if (!group) { group = { ...fresh(), key, label }; groups[index].set(key, group); }
        accumulate(group, row, price, requestMetrics);
      }
    }
    const sorted = (values: Map<string, UsageGroup>) => [...values.values()].sort((a, b) => b.requests - a.requests || a.label.localeCompare(b.label, 'zh-CN') || a.key.localeCompare(b.key));
    result.byModel = sorted(groups[0]); result.byProvider = sorted(groups[1]); result.byTool = sorted(groups[2]);
    result.daily = [...groups[3].values()].sort((a, b) => a.key.localeCompare(b.key));
    result.hourly = [...groups[4].values()].sort((a, b) => a.key.localeCompare(b.key));
    result.trend = granularity === 'hour' ? result.hourly : result.daily;
    const ordered = [...rows].sort((a, b) => Date.parse(b.row.time) - Date.parse(a.row.time) || b.row.id.localeCompare(a.row.id));
    result.logs = ordered.slice((page - 1) * pageSize, page * pageSize).map(({ row, dimensions: item }): UsageDetail => {
      const elapsed = requestMetrics ? duration(row) : null, measured = row.usage;
      return { id: row.id, time: row.time, source, tool: toolKey(row.tool) === 'unscoped' ? undefined : row.tool, toolKey: item.tool.key, toolLabel: item.tool.label,
        providerId: row.providerId, providerKey: item.provider.key, providerName: providerOptions.get(item.provider.key)!.label,
        modelId: row.modelId, modelKey: item.model.key, alias: row.alias, modelLabel: modelOptions.get(item.model.key)!.label, endpoint: row.endpoint,
        status: requestMetrics && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? row.status : null, durationMs: elapsed,
        usage: measured, newInputTokens: measured ? measured.inputTokens - measured.cachedInputTokens - (measured.cacheCreationInputTokens ?? 0) : undefined,
        totalTokens: measured ? measured.inputTokens + measured.outputTokens : undefined, cacheHitPercent: measured && measured.inputTokens > 0 ? measured.cachedInputTokens / measured.inputTokens * 100 : null,
        estimatedCostUsd: item.model.key === 'unknown-model' ? null : cost(measured, priceMap.get(item.model.key)), tokensPerSecond: measured && elapsed !== null && elapsed > 0 ? measured.outputTokens / (elapsed / 1000) : null };
    });
    return result;
  }
}
