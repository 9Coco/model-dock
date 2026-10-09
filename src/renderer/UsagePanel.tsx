import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BarChart3, ChevronDown, Database, DollarSign, Download, Layers3, Pencil, RefreshCw, Trash2, Zap } from './MaterialIcon';
import type { Model, ModelDockApi, Provider, ToolId } from '../shared/types';
import type { ModelPrice, UsageGroup, UsageQuery, UsageSnapshot } from '../shared/usage-types';
import type { UsageSourcesSnapshot, UsageSyncResult } from '../shared/usage-import-types';
import { buildUsageExport, usageCsv, type UsageReportDimension } from '../shared/usage-report';
import { usageCount as count, usageDateRange, usageMoney as money, usageRange, usageSpeed, usageStatus, usageTime } from '../shared/usage-display';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';
import { modelDisplayLabel } from '../shared/model-names';
import { ToolIcon } from './ToolIcon';

const toolNames: Record<ToolId, string> = { codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', dsh: 'DSH', vscode: 'VS Code', copilot: 'Copilot app' };
const toolIds = Object.keys(toolNames) as ToolId[];
const dimensions = [['byProvider', '供应商', 'provider'], ['byTool', '工具', 'tool'], ['byModel', '模型', 'model']] as const;
const percent = (part: number, whole: number) => whole ? `${Number((part / whole * 100).toFixed(1))}%` : '未知';
const tokens = (value: UsageGroup | UsageSnapshot) => value.requests && !value.reportedRequests ? '未知' : count(value.totalTokens);
const costLabel = (value: UsageGroup | UsageSnapshot) => value.estimatedCostUsd === null ? '费用未知' : value.costedRequests < value.requests ? '部分费用估算' : '估算费用';
type ToolFilter = ToolId | 'unscoped' | '';
type Metric = 'requests' | 'tokens' | 'cost';
type Tab = 'logs' | 'provider' | 'models' | 'pricing';
type FilterOption = { key: string; label: string; providerKey?: string };

export function UsagePanel({ api, notify, models, providers, onSnapshot }: { api?: ModelDockApi; notify: Notify; models: Model[]; providers: Provider[]; onSnapshot?: (snapshot: UsageSnapshot, query: UsageQuery) => void }) {
  const [dates, setDates] = useState(() => usageRange(1));
  const [presetRange, setPresetRange] = useState('1');
  const [source, setSource] = useState<'gateway' | 'client'>('client');
  const [tool, setTool] = useState<ToolFilter>('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<'all' | 'success' | 'failed' | number>('all');
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const [autoRefresh, setAutoRefresh] = useState(30);
  const [initialized, setInitialized] = useState(!api);
  const [lastSync, setLastSync] = useState<UsageSyncResult | null>(null);
  const [syncError, setSyncError] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sources, setSources] = useState<UsageSourcesSnapshot | null>(null);
  const [sourcesError, setSourcesError] = useState('');
  const [importTool, setImportTool] = useState<ToolId>('codex');
  const [result, setResult] = useState<{ key: string; value: UsageSnapshot } | null>(null);
  const [rangeOptions, setRangeOptions] = useState<{ key: string; filters: UsageSnapshot['filters'] } | null>(null);
  const [tab, setTab] = useState<Tab>('logs');
  const [groupBy, setGroupBy] = useState<UsageReportDimension>('byProvider');
  const [sortBy, setSortBy] = useState<Metric>('requests');
  const [chartMetric, setChartMetric] = useState<Metric>('tokens');
  const [pendingKey, setPendingKey] = useState('');
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [price, setPrice] = useState<ModelPrice | null>(null);
  const serial = useRef(0), mounted = useRef(false), actionLocked = useRef(false), firstSync = useRef(false);
  const snapshotCallback = useRef(onSnapshot); snapshotCallback.current = onSnapshot;
  const sourcesVisible = useRef(false); sourcesVisible.current = sourcesOpen;
  const resolvedDates = useMemo(() => usageDateRange(dates.from, dates.to), [dates.from, dates.to]);
  const query = useMemo<UsageQuery | null>(() => resolvedDates ? { ...resolvedDates, source, tool: tool || undefined, providerId: provider || undefined, modelId: model || undefined, status: source === 'client' ? 'all' : status, page, pageSize, granularity: dates.from === dates.to ? 'hour' : 'day', timeZone: 'Asia/Hong_Kong' } : null, [resolvedDates, source, tool, provider, model, status, page, pageSize, dates.from, dates.to]);
  const queryKey = JSON.stringify(query ?? { invalidDates: dates });
  const rangeKey = JSON.stringify([source, dates.from, dates.to]);
  const currentQuery = useRef({ query, key: queryKey, rangeKey }); currentQuery.current = { query, key: queryKey, rangeKey };
  const snapshot = result?.key === queryKey ? result.value : null;
  const loading = !!api && !!query && (!initialized || pendingKey === queryKey || (!snapshot && failure?.key !== queryKey));
  const error = query ? failure?.key === queryKey ? failure.message : '' : '请选择有效日期范围，开始日期不能晚于结束日期，最多查询 366 天。';
  const load = useCallback(async () => {
    const scope = currentQuery.current;
    if (!api || !scope.query) return;
    const request = ++serial.current; setPendingKey(scope.key); setFailure(null);
    try {
      const value = await api.usageQuery(scope.query);
      if (mounted.current && request === serial.current && currentQuery.current.key === scope.key) { setResult({ key: scope.key, value }); setRangeOptions({ key: scope.rangeKey, filters: value.filters }); snapshotCallback.current?.(value, scope.query); }
    } catch (problem) {
      if (mounted.current && request === serial.current && currentQuery.current.key === scope.key) setFailure({ key: scope.key, message: problem instanceof Error ? problem.message : '用量读取失败' });
    } finally { if (mounted.current && request === serial.current) setPendingKey(''); }
  }, [api]);
  const loadSources = useCallback(async () => {
    if (!api) return;
    setSourcesError('');
    try { const value = await api.usageSources(); if (mounted.current) setSources(value); }
    catch (problem) { if (mounted.current) setSourcesError(problem instanceof Error ? problem.message : '数据来源读取失败'); }
  }, [api]);
  const synchronize = useCallback(async (manual = false, initial = false) => {
    if (!api || actionLocked.current) return;
    if (!manual && currentQuery.current.query?.source === 'gateway') { await load(); if (initial && mounted.current) setInitialized(true); return; }
    actionLocked.current = true; setBusy('sync'); setSyncError('');
    try {
      const value = await api.usageSyncTools();
      if (mounted.current) { setLastSync(value); if (sourcesVisible.current) await loadSources(); if (manual) notify(`已扫描 ${value.scannedFiles} 个文件，新增 ${value.imported} 条用量记录。`, value.warnings.length ? 'info' : 'success'); }
    } catch (problem) {
      if (mounted.current) { const message = problem instanceof Error ? problem.message : '本地用量同步失败'; setSyncError(message); if (manual) notify(message, 'error'); }
    } finally {
      actionLocked.current = false;
      if (mounted.current) { setBusy(''); if (initial) setInitialized(true); else await load(); }
    }
  }, [api, load, loadSources, notify]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  useEffect(() => { if (!firstSync.current && api) { firstSync.current = true; setInitialized(false); void synchronize(false, true); } }, [api, synchronize]);
  useEffect(() => { if (initialized) void load(); return () => { serial.current++; }; }, [load, queryKey, initialized]);
  useEffect(() => {
    if (!initialized || !autoRefresh || !api) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (presetRange !== 'custom') {
        const next = usageRange(Number(presetRange));
        if (next.from !== dates.from || next.to !== dates.to) { setDates(next); setPage(1); }
      }
      void synchronize();
    }, autoRefresh * 1000);
    return () => window.clearInterval(timer);
  }, [initialized, autoRefresh, api, synchronize, presetRange, dates.from, dates.to]);
  useEffect(() => { if (sourcesOpen) void loadSources(); }, [sourcesOpen, loadSources]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (!api) { notify('请在 ModelDock 桌面应用中查看实际用量。', 'info'); return; }
    if (actionLocked.current) return;
    actionLocked.current = true; setBusy(key);
    try { await action(); if (mounted.current) await load(); }
    catch (problem) { if (mounted.current) notify(problem instanceof Error ? problem.message : '操作失败', 'error'); }
    finally { actionLocked.current = false; if (mounted.current) setBusy(''); }
  };
  const available = rangeOptions?.key === rangeKey ? rangeOptions.filters : null;
  const providerOptions: FilterOption[] = available?.providers ?? providers.map(item => ({ key: item.id, label: item.name }));
  const allModelOptions: FilterOption[] = available?.models ?? models.map(item => ({ key: item.id, label: modelDisplayLabel(item, providers.find(entry => entry.id === item.providerId)), providerKey: item.providerId }));
  const toolOptions: FilterOption[] = [...toolIds.map(key => ({ key, label: toolNames[key] })), { key: 'unscoped', label: '未识别 / 通用接口' }];
  for (const option of available?.tools ?? []) if (!toolOptions.some(item => item.key === option.key)) toolOptions.push(option);
  const modelOptions = allModelOptions.filter(item => !provider || item.providerKey === provider || item.key === model);
  const label = (options: FilterOption[], key: string) => options.find(item => item.key === key)?.label ?? `${key}（历史记录）`;
  const withSelected = (options: FilterOption[], key: string): FilterOption[] => key && !options.some(item => item.key === key) ? [...options, { key, label: label(options, key) }] : options;
  const priceOptions = allModelOptions.filter(item => item.key !== 'unknown-model');
  for (const item of models) if (!priceOptions.some(option => option.key === item.id)) priceOptions.push({ key: item.id, label: modelDisplayLabel(item, providers.find(entry => entry.id === item.providerId)), providerKey: item.providerId });
  for (const entry of snapshot?.prices ?? []) if (!priceOptions.some(option => option.key === entry.modelId)) priceOptions.push({ key: entry.modelId, label: `${entry.modelId}（历史记录）` });
  const selectPrice = (id: string) => setPrice(snapshot?.prices.find(item => item.modelId === id) ?? { modelId: id, inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const clearFilters = () => { setTool(''); setProvider(''); setModel(''); setStatus('all'); setPage(1); };
  const hasFilters = !!(tool || provider || model || status !== 'all');
  const rows = [...(snapshot?.[groupBy] ?? [])].sort((left, right) => {
    const value = (item: UsageGroup) => sortBy === 'requests' ? item.requests : sortBy === 'tokens' ? item.totalTokens : item.estimatedCostUsd ?? -1;
    return value(right) - value(left) || left.label.localeCompare(right.label, 'zh-CN');
  });
  const dimensionName = dimensions.find(item => item[0] === groupBy)![1];
  const drill = (row: UsageGroup) => { setPage(1); if (groupBy === 'byProvider') { setProvider(row.key); if (model && allModelOptions.find(item => item.key === model)?.providerKey !== row.key) setModel(''); } else if (groupBy === 'byTool') setTool(row.key as ToolFilter); else setModel(row.key); setTab('logs'); };
  const trend = snapshot?.trend ?? [];
  const trendValue = (item: UsageGroup): number | null => chartMetric === 'requests' ? item.requests : chartMetric === 'tokens' ? item.requests && !item.reportedRequests ? null : item.totalTokens : item.requests && !item.costedRequests ? null : item.estimatedCostUsd ?? 0;
  const maxTrend = Math.max(0, ...trend.map(item => trendValue(item) ?? 0)) || 1;
  const trendPoint = (item: UsageGroup, index: number) => `${36 + index / Math.max(1, trend.length - 1) * 770},${140 - (trendValue(item) ?? 0) / maxTrend * 120}`;
  const segments: string[][] = []; trend.forEach((item, index) => { if (trendValue(item) === null) segments.push([]); else { if (!segments.length) segments.push([]); segments[segments.length - 1].push(trendPoint(item, index)); } });
  const changeTab = (next: Tab) => { setTab(next); if (next === 'provider') setGroupBy('byProvider'); if (next === 'models') setGroupBy('byModel'); };
  const exportData = (format: 'json' | 'csv') => {
    if (!snapshot || !query || loading || busy || result?.key !== currentQuery.current.key) return;
    const exportSnapshot = { ...snapshot, [groupBy]: rows };
    const value = format === 'csv' ? usageCsv(exportSnapshot, query, groupBy) : JSON.stringify({ ...buildUsageExport(exportSnapshot, query, groupBy), sortBy }, null, 2);
    const url = URL.createObjectURL(new Blob([value], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })), link = document.createElement('a');
    link.href = url; link.download = `modeldock-usage-${source}-${groupBy}-${dates.from}-${dates.to}.${format}`; link.click(); URL.revokeObjectURL(url);
  };

  return <section className="feature-page usage-panel usage-dashboard" data-usage-view={groupBy} data-usage-tab={tab} data-usage-query={queryKey} aria-busy={loading}>
    <div className="usage-tool-selector" aria-label="用量工具筛选快捷按钮"><span>工具</span><button className={!tool ? 'selected' : ''} data-usage-tool="all" aria-pressed={!tool} onClick={() => { setTool(''); setPage(1); }}>全部</button>{toolIds.map(id => <button className={tool === id ? 'selected' : ''} key={id} data-usage-tool={id} aria-pressed={tool === id} onClick={() => { setTool(id); setPage(1); }}><ToolIcon tool={id} />{toolNames[id]}</button>)}<button className={tool === 'unscoped' ? 'selected' : ''} data-usage-tool="unscoped" aria-pressed={tool === 'unscoped'} onClick={() => { setTool('unscoped'); setPage(1); }}>未识别</button></div>
    <div className="usage-control-row"><div className="usage-filters">
      <label>供应商<select aria-label="用量供应商筛选" value={provider} onChange={event => { const next = event.target.value; setProvider(next); setPage(1); if (next && model && allModelOptions.find(item => item.key === model)?.providerKey !== next) setModel(''); }}><option value="">所有供应商</option>{withSelected(providerOptions, provider).map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>
      <label>模型<select aria-label="用量模型筛选" value={model} onChange={event => { setModel(event.target.value); setPage(1); }}><option value="">所有模型</option>{withSelected(modelOptions, model).map(item => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>
      <label>时间<select aria-label="用量时间范围" value={presetRange} onChange={event => { const value = event.target.value; setPresetRange(value); setPage(1); if (value !== 'custom') setDates(usageRange(Number(value))); }}><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="365">最近 365 天</option><option value="custom">自定义</option></select></label>
      <select className="sr-only" aria-label="用量工具筛选" value={tool} onChange={event => { setTool(event.target.value as ToolFilter); setPage(1); }}><option value="">所有工具</option>{withSelected(toolOptions, tool).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
    </div><div className="feature-actions usage-sync-actions"><button className="button small primary" data-action="usage-sync-now" disabled={!api || !!busy} onClick={() => void synchronize(true)}><BusyIcon active={busy === 'sync'}><RefreshCw size={15} /></BusyIcon>立即同步</button><label>自动刷新<select aria-label="用量自动刷新" data-action="usage-auto-refresh" value={autoRefresh} onChange={event => setAutoRefresh(Number(event.target.value))}><option value="0">关闭</option><option value="15">15 秒</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="300">5 分钟</option></select></label><button className="button small secondary" data-action="usage-data-sources" onClick={() => setSourcesOpen(true)}><Database size={15} />数据来源</button></div></div>
    {presetRange === 'custom' && <div className="usage-filters usage-custom-dates"><label>开始日期<input aria-label="用量开始日期" type="date" value={dates.from} onChange={event => { setDates(current => ({ ...current, from: event.target.value })); setPage(1); }} /></label><label>结束日期<input aria-label="用量结束日期" type="date" value={dates.to} onChange={event => { setDates(current => ({ ...current, to: event.target.value })); setPage(1); }} /></label></div>}
    <div className="usage-source-row"><div className="log-tabs" role="tablist" aria-label="用量来源"><button role="tab" data-action="usage-source-client" aria-selected={source === 'client'} className={source === 'client' ? 'selected' : ''} onClick={() => { setSource('client'); setProvider(''); setModel(''); setStatus('all'); setPage(1); }}>客户端直连用量</button><button role="tab" data-action="usage-source-gateway" aria-selected={source === 'gateway'} className={source === 'gateway' ? 'selected' : ''} onClick={() => { setSource('gateway'); setProvider(''); setModel(''); setStatus('all'); setPage(1); }}>ModelDock 网关请求</button></div><span className="usage-sync-state" data-usage-last-sync>{busy === 'sync' ? '正在同步本地用量…' : lastSync ? `同步于 ${usageTime(lastSync.completedAt)} · 新增 ${lastSync.imported} 条` : '尚未同步'}</span></div>
    <div className="usage-scope" data-usage-scope><span>{dates.from} 至 {dates.to}（香港时间） · {source === 'client' ? '客户端用量事件' : '网关请求'}，两类记录分别统计</span>{provider && <span className="usage-scope-chip">{label(providerOptions, provider)}</span>}{tool && <span className="usage-scope-chip">{label(toolOptions, tool)}</span>}{model && <span className="usage-scope-chip">{label(allModelOptions, model)}</span>}{hasFilters && <button className="button small secondary" data-action="usage-clear-filters" onClick={clearFilters}><ArrowLeft size={14} />返回全部</button>}</div>
    {syncError && <p className="usage-attribution-note" data-usage-sync-error>{syncError}，当前显示已记录的用量。</p>}{error && <p className="feature-error" role="alert">{error}</p>}
    {!api ? <EmptyState compact icon={<BarChart3 size={25} />} title="等待桌面连接" description="统计数据来自本机实际记录，不使用演示数据。" /> : !snapshot && loading ? <div className="usage-loading" role="status"><BusyIcon active><RefreshCw size={20} /></BusyIcon>{busy === 'sync' ? '正在同步本地日志并读取用量…' : '正在读取当前筛选的用量…'}</div> : snapshot && <>
      <div className="usage-metrics" data-usage-metrics>
        <div><span className="usage-metric-title"><DollarSign size={15} />{costLabel(snapshot)} · USD</span><strong data-usage-total="cost" data-stat="cost" data-value={snapshot.estimatedCostUsd ?? 'null'}>{money(snapshot.estimatedCostUsd)}</strong><small>{count(snapshot.costedRequests)} / {count(snapshot.requests)} 条可估算；未覆盖费用未知</small></div>
        <div><span className="usage-metric-title"><Layers3 size={15} />{source === 'gateway' ? '请求数' : '用量事件数'}</span><strong data-usage-total="requests" data-stat="requests" data-value={snapshot.requests}>{count(snapshot.requests)}</strong><small>{source === 'gateway' ? `${count(snapshot.succeeded)} 成功 · ${count(snapshot.failed)} 失败` : '本地 Token 计数事件，不能据此判断请求成功率'}</small></div>
        <div><span className="usage-metric-title"><Zap size={15} />{snapshot.reportedRequests < snapshot.requests ? '已知消耗 Token' : '消耗 Token'}</span><strong data-usage-total="tokens" data-stat="tokens" data-value={snapshot.requests && !snapshot.reportedRequests ? 'null' : snapshot.totalTokens}>{tokens(snapshot)}</strong><small>含输入与输出；{count(snapshot.collection.missingUsageRecords)} 条用量未知</small></div>
        <div><span className="usage-metric-title"><Database size={15} />缓存命中率</span><strong data-stat="cache-hit" data-value={snapshot.cacheHitPercent ?? 'null'}>{snapshot.cacheHitPercent === null ? '未知' : `${Number(snapshot.cacheHitPercent.toFixed(1))}%`}</strong><small>缓存输入 / 总输入；缓存已包含在输入中</small></div>
      </div>
      <details className="usage-more-metrics"><summary>更多指标 <ChevronDown size={14} /></summary><div><span>新输入 <strong>{snapshot.reportedRequests ? count(snapshot.newInputTokens) : snapshot.requests ? '未知' : '0'}</strong></span><span>输出 <strong>{snapshot.reportedRequests ? count(snapshot.outputTokens) : snapshot.requests ? '未知' : '0'}</strong></span><span>缓存输入 <strong>{snapshot.reportedRequests ? count(snapshot.cachedInputTokens) : snapshot.requests ? '未知' : '0'}</strong></span><span>用量覆盖 <strong>{snapshot.reportedRequests} / {snapshot.requests}</strong></span>{snapshot.collection.requestMetricsAvailable && <><span>成功率 <strong data-stat="success-rate">{percent(snapshot.succeeded, snapshot.requests)}</strong></span><span>平均耗时 <strong data-stat="latency">{snapshot.latencyRecords ? `${Math.round(snapshot.averageDurationMs)} ms` : '未知'}</strong></span><span>输出速率（含等待） <strong>{usageSpeed(snapshot.averageOutputTokensPerSecond)}</strong></span></>}</div></details>
      {!!(snapshot.collection.unscopedRecords || snapshot.collection.unidentifiedProviderRecords || snapshot.collection.unidentifiedModelRecords) && <p className="usage-attribution-note">{snapshot.collection.unscopedRecords > 0 && <span>未识别工具 {count(snapshot.collection.unscopedRecords)} 条</span>}{snapshot.collection.unidentifiedProviderRecords > 0 && <span>未关联配置供应商 {count(snapshot.collection.unidentifiedProviderRecords)} 条</span>}{snapshot.collection.unidentifiedModelRecords > 0 && <span>未关联配置模型 {count(snapshot.collection.unidentifiedModelRecords)} 条</span>}<span>已包含在当前总览。</span></p>}
      <section className="panel usage-chart"><div className="section-heading"><div><h2 id="usage-trend-title">{snapshot.granularity === 'hour' ? '每小时趋势' : '每日趋势'}</h2><p className="usage-section-note">{snapshot.granularity === 'hour' ? '所选日期的 24 小时' : '当前日期范围'} · 香港时间</p></div><div className="log-tabs" role="tablist" aria-label="用量趋势指标">{([['tokens', 'Token'], ['requests', source === 'gateway' ? '请求' : '事件'], ['cost', '费用']] as const).map(([key, text]) => <button role="tab" key={key} data-action="usage-trend-metric" data-metric={key} aria-selected={chartMetric === key} className={chartMetric === key ? 'selected' : ''} onClick={() => setChartMetric(key)}>{text}</button>)}</div></div>
        <div className="usage-trend-plot"><svg viewBox="0 0 840 164" role="img" aria-labelledby="usage-trend-title" preserveAspectRatio="none"><defs><linearGradient id="usage-trend-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".24" /><stop offset="100%" stopColor="var(--accent)" stopOpacity=".02" /></linearGradient></defs>{[20, 60, 100, 140].map(y => <line key={y} x1="36" x2="806" y1={y} y2={y} className="usage-trend-grid" />)}<text x="2" y="23" className="usage-trend-max">{chartMetric === 'cost' ? money(maxTrend) : count(maxTrend)}</text>{segments.filter(segment => segment.length).map((segment, index) => <g key={index}><polygon points={`${segment[0].split(',')[0]},140 ${segment.join(' ')} ${segment[segment.length - 1].split(',')[0]},140`} fill="url(#usage-trend-fill)" /><polyline points={segment.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2" /></g>)}{trend.map((item, index) => { const [x, y] = trendPoint(item, index).split(',').map(Number); return <g key={item.key} data-day={item.key} data-day-requests={item.requests} data-usage-trend-point={item.key}><title>{item.label} · {item.requests} {source === 'gateway' ? '请求' : '事件'} · Token {tokens(item)} · {costLabel(item)} {money(item.estimatedCostUsd)}</title>{trendValue(item) === null ? <text x={x} y="132" textAnchor="middle" className="usage-trend-unknown">?</text> : <circle cx={x} cy={y} r={item.requests ? 3 : 1.5} fill="var(--accent)" />}{(index === 0 || index === trend.length - 1 || index % Math.max(1, Math.ceil(trend.length / 8)) === 0) && <text x={x} y="160" textAnchor="middle" className="usage-trend-label">{snapshot.granularity === 'hour' ? item.label.slice(-5) : item.label.slice(5)}</text>}</g>; })}</svg></div>
        {chartMetric !== 'requests' && <p className="usage-section-note">{chartMetric === 'tokens' ? '仅统计已报告 Token' : '费用为已设置单价部分的估算'}；缺少数据的时间段保留为未知。</p>}
      </section>
      <section className="panel usage-detail-panel"><div className="usage-detail-heading"><div className="route-tabs" role="tablist" aria-label="用量明细视图">{([['logs', source === 'gateway' ? '请求日志' : '用量日志'], ['provider', '供应商统计'], ['models', '模型统计'], ['pricing', '模型定价']] as const).map(([key, text]) => <button role="tab" key={key} data-action={'usage-tab-' + key} aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => changeTab(key)}>{text}</button>)}</div><div className="feature-actions"><button className="button small secondary" data-action="usage-export-csv" disabled={loading || !!busy} onClick={() => exportData('csv')}><Download size={14} />CSV</button><button className="button small secondary" data-action="usage-export-json" disabled={loading || !!busy} onClick={() => exportData('json')}><Download size={14} />JSON</button></div></div>
        {tab === 'logs' && <><div className="usage-log-controls"><span>{count(snapshot.pagination.total)} 条{source === 'client' ? '用量事件' : '请求'}</span><div>{source === 'gateway' && <label>状态<select aria-label="用量日志状态" value={status} onChange={event => { setStatus(/^\d+$/.test(event.target.value) ? Number(event.target.value) : event.target.value as typeof status); setPage(1); }}><option value="all">全部</option><option value="success">成功</option><option value="failed">失败</option>{snapshot.filters.statusCodes.map(code => <option key={code} value={code}>HTTP {code}</option>)}</select></label>}<label>每页<select aria-label="用量每页条数" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label></div></div>
          {snapshot.logs.length ? <div className="table-scroll usage-log-scroll"><table className="feature-table usage-log-table"><thead><tr><th>时间</th><th>工具</th><th>供应商</th><th>模型</th><th title="总输入减去缓存读取和缓存写入；缓存不再重复加进总 Token">新输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>估算费用</th><th>状态</th><th title="输出 Token / 完整请求耗时，包含网络及等待时间">速率（含等待）</th></tr></thead><tbody>{snapshot.logs.map(log => { const state = usageStatus(log.status, log.source); return <tr key={log.id} data-usage-log-row={log.id}><td className="usage-log-time">{usageTime(log.time)}</td><td><span className="usage-log-tool">{log.tool && <ToolIcon tool={log.tool} />}{log.toolLabel}</span></td><td title={log.providerName}>{log.providerName}</td><td title={log.alias}>{log.modelLabel}</td><td>{log.newInputTokens === undefined ? '未知' : count(log.newInputTokens)}</td><td>{log.usage ? count(log.usage.outputTokens) : '未知'}</td><td>{log.usage ? count(log.usage.cachedInputTokens) : '未知'}</td><td>{log.usage?.cacheCreationInputTokens === undefined ? '未报告' : count(log.usage.cacheCreationInputTokens)}</td><td data-log-cost>{money(log.estimatedCostUsd)}</td><td><span className={'usage-log-status ' + state.tone} data-log-status>{state.label}</span></td><td data-log-speed>{usageSpeed(log.tokensPerSecond)}</td></tr>; })}</tbody></table></div> : <EmptyState compact icon={<BarChart3 size={23} />} title="没有符合筛选的记录" description={hasFilters ? '返回全部，或调整日期和记录来源。' : source === 'client' ? '同步受支持客户端的本地日志后，用量记录会显示在这里。' : '通过 ModelDock 网关调用模型后，会记录请求用量。'} />}
          <div className="usage-pagination"><span>第 {snapshot.pagination.page} / {Math.max(1, snapshot.pagination.totalPages)} 页</span><div><button className="button small secondary" data-action="usage-page-previous" disabled={loading || snapshot.pagination.page <= 1} onClick={() => setPage(Math.max(1, snapshot.pagination.page - 1))}><ArrowLeft size={13} />上一页</button><button className="button small secondary" data-action="usage-page-next" disabled={loading || snapshot.pagination.page >= snapshot.pagination.totalPages} onClick={() => setPage(snapshot.pagination.page + 1)}>下一页<ArrowRight size={13} /></button></div></div>
        </>}
        {(tab === 'provider' || tab === 'models') && <><div className="usage-log-controls"><div className="log-tabs" role="tablist" aria-label="用量统计维度">{dimensions.map(([key, text, action]) => <button role="tab" key={key} data-action={'usage-view-' + action} aria-selected={groupBy === key} className={groupBy === key ? 'selected' : ''} onClick={() => setGroupBy(key)}>按{text}</button>)}</div><label>排序<select aria-label="用量明细排序" value={sortBy} onChange={event => setSortBy(event.target.value as Metric)}><option value="requests">{source === 'gateway' ? '请求数' : '事件数'}</option><option value="tokens">Token</option><option value="cost">估算费用</option></select></label></div>{rows.length ? <div className="table-scroll"><table className="feature-table usage-group-table"><thead><tr><th>{dimensionName}</th><th>{source === 'gateway' ? '请求 / 占比' : '事件 / 占比'}</th>{snapshot.collection.requestMetricsAvailable && <th>成功率</th>}<th>用量覆盖</th><th>Token</th><th>估算费用（USD）</th><th>操作</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.key} data-usage-group-key={row.key}><td><div className="usage-group-name"><span className="usage-rank">{index + 1}</span><strong>{groupBy === 'byTool' ? label(toolOptions, row.key) : row.label}</strong></div></td><td><strong>{count(row.requests)}</strong><small>{percent(row.requests, snapshot.requests)}</small></td>{snapshot.collection.requestMetricsAvailable && <td>{percent(row.succeeded, row.requests)}</td>}<td>{row.reportedRequests} / {row.requests}<small>{row.requests - row.reportedRequests} 条未知</small></td><td><strong>{tokens(row)}</strong><small>{row.reportedRequests ? `新输入 ${count(row.newInputTokens)} · 输出 ${count(row.outputTokens)} · 缓存读取 ${count(row.cachedInputTokens)}${row.reportedRequests < row.requests ? ' · 已知部分' : ''}` : '未报告用量'}</small></td><td><strong>{money(row.estimatedCostUsd)}</strong><small>{costLabel(row)} · {row.costedRequests} / {row.requests} 条</small></td><td><button className="button small secondary" data-action="usage-drill-row" onClick={() => drill(row)}>查看<ArrowRight size={13} /></button></td></tr>)}</tbody></table></div> : <EmptyState compact icon={<BarChart3 size={23} />} title="暂无统计记录" description="调整当前筛选或同步本地日志。" />}</>}
        {tab === 'pricing' && <><p className="usage-section-note">USD / 百万 Token。未设置价格时费用未知；历史模型也可设置单价，按当前单价估算历史记录。</p><div className="table-scroll"><table className="feature-table usage-price-table"><thead><tr><th>模型</th><th>输入</th><th>缓存读取</th><th>缓存写入</th><th>输出</th><th>操作</th></tr></thead><tbody>{priceOptions.map(item => { const current = snapshot.prices.find(entry => entry.modelId === item.key); return <tr key={item.key} data-usage-price-model={item.key}><td>{item.label}</td><td>{current?.inputUsdPerMillion ?? '未设置'}</td><td>{current?.cachedInputUsdPerMillion ?? '未设置'}</td><td>{current?.cacheCreationUsdPerMillion ?? '未设置'}</td><td>{current?.outputUsdPerMillion ?? '未设置'}</td><td><div className="row-actions"><button className="icon-button" data-action="usage-edit-price" title={'设置 ' + item.label + ' 单价'} disabled={!!busy || loading} onClick={() => selectPrice(item.key)}><Pencil size={15} /></button><button className="icon-button danger-icon" title="移除单价" disabled={!current || !!busy || loading} onClick={() => void run('remove-price', () => api!.usageDeletePrice(item.key))}><Trash2 size={15} /></button></div></td></tr>; })}</tbody></table></div>{!priceOptions.length && <EmptyState compact icon={<DollarSign size={23} />} title="暂无可定价模型" description="同步用量记录或添加模型后，可以在这里设置单价。" />}</>}
      </section>
    </>}
    <p className="feature-footnote">客户端事件与网关请求分别统计，避免重复累计同一次调用。缓存输入已包含在总输入中。费用为当前 USD 单价的估算；速率包含完整请求的等待时间，未测量的数据保留为未知。</p>
    {sourcesOpen && <Modal wide title="用量数据来源" subtitle="查看本地用量的读取位置、支持范围和同步结果。" onClose={() => setSourcesOpen(false)}><div className="modal-body usage-sources-body">{sourcesError && <p className="feature-error" role="alert">{sourcesError}</p>}{sources ? <><p className="feature-note">{sources.privacy}</p>{sources.sources.map(item => <article className="usage-source-card" key={item.id} data-usage-data-source={item.id}><div><strong>{item.tool && <ToolIcon tool={item.tool} />}{item.name}</strong><span className={'usage-source-state ' + item.status}>{({ ready: '可读取', missing: '未发现日志', unsupported: '暂不支持', error: '读取失败' })[item.status]}</span></div><p>{item.description}</p><small>{item.format}{item.lastSyncAt ? ` · 最近同步 ${usageTime(item.lastSyncAt)}` : ''}</small>{item.paths.length > 0 && <ul>{item.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>}{item.lastResult && <small>扫描 {item.lastResult.scannedFiles} 个文件 · 新增 {item.lastResult.imported} · 跳过 {item.lastResult.skipped} · 暂缓 {item.lastResult.deferredFiles}</small>}{item.lastResult?.warnings.map(warning => <small className="usage-source-warning" key={warning}>{warning}</small>)}</article>)}</> : !sourcesError && <p className="feature-note">正在读取来源信息…</p>}<div className="usage-import-row"><label>单独同步<select aria-label="导入用量的工具" value={importTool} onChange={event => setImportTool(event.target.value as ToolId)}>{toolIds.map(id => <option key={id} value={id}>{toolNames[id]}</option>)}</select></label><button className="button small secondary" disabled={!api || !!busy} onClick={() => void run('import', async () => { const value = await api!.usageImportTool(importTool); notify(`扫描 ${value.scannedFiles} 个文件，新增 ${value.imported} 条${value.unsupported ? `；${value.unsupported}` : ''}。`, value.unsupported ? 'info' : 'success'); await loadSources(); })}><BusyIcon active={busy === 'import'}><RefreshCw size={14} /></BusyIcon>导入本地用量</button></div></div><div className="modal-footer"><button className="button secondary" onClick={() => setSourcesOpen(false)}>关闭</button></div></Modal>}
    {price && <Modal title="设置模型单价" subtitle="USD / 百万 Token，按当前单价重新估算历史用量。" onClose={() => setPrice(null)}><form onSubmit={event => { event.preventDefault(); void run('save-price', async () => { await api!.usageSavePrice(price); if (mounted.current) { setPrice(null); notify('单价已保存。'); } }); }}><div className="modal-body"><p className="feature-note">{label(priceOptions, price.modelId)}</p><div className="form-columns">{([['inputUsdPerMillion', '输入'], ['cachedInputUsdPerMillion', '缓存输入'], ['outputUsdPerMillion', '输出']] as const).map(([key, text]) => <label className="form-field" key={key}>{text}<input required type="number" min="0" step="any" value={price[key]} onChange={event => setPrice(current => current ? { ...current, [key]: Number(event.target.value) } : null)} /></label>)}<label className="form-field">缓存写入（可选）<input type="number" min="0" step="any" placeholder="未设置，费用保持未知" value={price.cacheCreationUsdPerMillion ?? ''} onChange={event => setPrice(current => current ? { ...current, cacheCreationUsdPerMillion: event.target.value === '' ? undefined : Number(event.target.value) } : null)} /></label></div></div><div className="modal-footer"><button type="button" className="button secondary" onClick={() => setPrice(null)}>取消</button><button type="submit" className="button primary" disabled={!!busy || !api}><BusyIcon active={busy === 'save-price'}><DollarSign size={15} /></BusyIcon>保存单价</button></div></form></Modal>}
  </section>;
}
