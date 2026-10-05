import type { UsageGroup, UsageQuery, UsageSnapshot, UsageTotals } from './usage-types';

export type UsageReportDimension = 'byProvider' | 'byTool' | 'byModel';
const dimensionLabels: Record<UsageReportDimension, string> = { byProvider: '供应商', byTool: '工具', byModel: '模型' };
const note = '网关请求与客户端会话分开统计。Token 来自已报告的 usage；缺失保持未知。费用仅按当前手填 USD 单价估算，部分计价不代表全部费用或真实账单。';

export const USAGE_TIME_ZONE = 'Asia/Hong_Kong';
const calendars = new Map<string, Intl.DateTimeFormat>();
export function usageTimeZone(value: unknown = USAGE_TIME_ZONE): string {
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error('用量统计时区无效。');
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: value }).resolvedOptions().timeZone; } catch { throw new Error('用量统计时区无效。'); }
}
export function usageCalendarParts(millis: number, timeZone = USAGE_TIME_ZONE): { day: string; hour: number; minute: number; second: number } {
  let formatter = calendars.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (calendars.size >= 16) calendars.clear();
    calendars.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(millis)).map(part => [part.type, part.value]));
  return { day: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
function calendarMillis(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的日历日期。');
  const [year, month, day] = value.split('-').map(Number), date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || date.toISOString().slice(0, 10) !== value) throw new Error('请选择有效的日历日期。');
  return date.getTime();
}
function midnight(day: string, timeZone: string): number {
  const civil = calendarMillis(day);
  let instant = civil;
  // Resolve a calendar midnight by its zone offset, rather than the host's zone.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = usageCalendarParts(instant, timeZone);
    const observed = calendarMillis(parts.day) + parts.hour * 3600_000 + parts.minute * 60_000 + parts.second * 1000;
    const next = instant + civil - observed;
    if (next === instant) return instant;
    instant = next;
  }
  if (usageCalendarParts(instant, timeZone).day !== day) throw new Error('该时区不存在所选日期。');
  return instant;
}
/** Inclusive calendar date controls become a canonical UTC half-open range. */
export function usageDateRange(fromDay: string, toDay: string, timeZone = USAGE_TIME_ZONE): { from: string; to: string } {
  const zone = usageTimeZone(timeZone), first = calendarMillis(fromDay), last = calendarMillis(toDay);
  if (first > last || (last - first) / 86400_000 >= 366) throw new Error('请选择一年以内的有效时间范围。');
  const following = new Date(last + 86400_000).toISOString().slice(0, 10);
  return { from: new Date(midnight(fromDay, zone)).toISOString(), to: new Date(midnight(following, zone)).toISOString() };
}

function verifyScope(snapshot: UsageSnapshot, query: UsageQuery) {
  if (snapshot.source !== (query.source ?? 'gateway') || Date.parse(snapshot.from) !== Date.parse(query.from) || Date.parse(snapshot.to) !== Date.parse(query.to)
    || snapshot.timeZone !== usageTimeZone(query.timeZone) || snapshot.appliedFilters.tool !== (query.tool || undefined)
    || snapshot.appliedFilters.providerId !== (query.providerId || undefined) || snapshot.appliedFilters.modelId !== (query.modelId || undefined)
    || snapshot.appliedFilters.status !== (query.status ?? 'all') || query.granularity !== undefined && snapshot.granularity !== query.granularity
    || snapshot.pagination.pageSize !== (query.pageSize ?? 25) || snapshot.pagination.page !== Math.min(query.page ?? 1, snapshot.pagination.totalPages)) throw new Error('统计范围已变化，请等待刷新完成后再导出。');
}
function totals(value: UsageTotals, requestMetricsAvailable: boolean) {
  const known = value.reportedRequests > 0 || value.requests === 0;
  return {
    records: value.requests,
    succeeded: requestMetricsAvailable ? value.succeeded : null,
    failed: requestMetricsAvailable ? value.failed : null,
    reportedRecords: value.reportedRequests,
    missingUsageRecords: value.requests - value.reportedRequests,
    inputTokens: known ? value.inputTokens : null,
    cachedInputTokens: known ? value.cachedInputTokens : null,
    cacheCreationInputTokens: known ? value.cacheCreationInputTokens : null,
    newInputTokens: known ? value.newInputTokens : null,
    totalTokens: known ? value.totalTokens : null,
    cacheHitPercent: value.cacheHitPercent,
    outputTokens: known ? value.outputTokens : null,
    pricedRecords: value.costedRequests,
    estimatedCostUsd: value.estimatedCostUsd,
    costCoverage: value.requests ? value.costedRequests / value.requests : null,
    averageDurationMs: requestMetricsAvailable && value.latencyRecords ? value.averageDurationMs : null,
    averageOutputTokensPerSecond: requestMetricsAvailable ? value.averageOutputTokensPerSecond : null,
  };
}

/** The same filtered snapshot drives the visible report and both export formats. */
export function buildUsageExport(snapshot: UsageSnapshot, query: UsageQuery, dimension: UsageReportDimension) {
  verifyScope(snapshot, query);
  const option = (kind: 'providers' | 'tools' | 'models', key?: string) => key ? snapshot.filters[kind].find(item => item.key === key) ?? { key, label: key } : null;
  const metricsAvailable = snapshot.collection.requestMetricsAvailable;
  return {
    version: 1,
    scope: {
      from: snapshot.from, toExclusive: snapshot.to,
      timeZone: snapshot.timeZone,
      source: snapshot.source,
      provider: option('providers', query.providerId),
      tool: option('tools', query.tool), model: option('models', query.modelId),
      status: snapshot.appliedFilters.status,
    },
    dimension: dimensionLabels[dimension], unit: snapshot.collection.unit,
    collection: snapshot.collection,
    totals: totals(snapshot, metricsAvailable),
    groups: snapshot[dimension].map(group => ({ key: group.key, label: group.label, ...totals(group, metricsAvailable) })),
    daily: snapshot.daily.map(day => ({ date: day.key, ...totals(day, metricsAvailable) })),
    trend: snapshot.trend.map(bucket => ({ key: bucket.key, label: bucket.label, ...totals(bucket, metricsAvailable) })),
    trendGranularity: snapshot.granularity,
    logsPage: { ...snapshot.pagination, items: snapshot.logs },
    note,
  };
}

function cell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '';
  // Names can originate in client metadata; prevent spreadsheet formula execution.
  const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function usageCsv(snapshot: UsageSnapshot, query: UsageQuery, dimension: UsageReportDimension): string {
  const report = buildUsageExport(snapshot, query, dimension);
  const headers = ['行类型', '名称', '记录数', '成功', '失败', '已报告用量', '输入 Token', '缓存输入 Token', '输出 Token', '已计价记录', '估算费用 USD（仅已计价记录）', '平均耗时 ms', '范围开始', '范围结束（不含）', '时区', '来源', '统计单位', '供应商筛选', '工具筛选', '模型筛选', '新增输入 Token', '缓存写入 Token', '真实消耗 Token', '缓存命中率 %', '平均输出速率 Token/s（含等待）', '状态筛选'];
  const render = (kind: string, label: string, value: UsageTotals) => {
    const total = totals(value, snapshot.collection.requestMetricsAvailable);
    return [kind, label, total.records, total.succeeded, total.failed, total.reportedRecords,
      total.inputTokens, total.cachedInputTokens, total.outputTokens, total.pricedRecords,
      total.estimatedCostUsd, total.averageDurationMs, report.scope.from, report.scope.toExclusive,
      report.scope.timeZone, report.scope.source, report.unit, report.scope.provider?.label ?? '',
      report.scope.tool?.label ?? '', report.scope.model?.label ?? '', total.newInputTokens, total.cacheCreationInputTokens,
      total.totalTokens, total.cacheHitPercent, total.averageOutputTokensPerSecond, report.scope.status].map(cell).join(',');
  };
  const rows = [headers.map(cell).join(','), render('合计', '当前筛选合计', snapshot),
    ...snapshot[dimension].map((group: UsageGroup) => render(dimensionLabels[dimension], group.label, group)),
    ...snapshot.daily.map(day => render('每日', day.key, day))];
  // UTF-8 BOM keeps Chinese headings readable in Windows spreadsheet applications.
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}
