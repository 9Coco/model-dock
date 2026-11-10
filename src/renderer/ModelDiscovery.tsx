import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Download, Layers3, RefreshCw, Search, Settings2 } from './MaterialIcon';
import type { ModelDockApi, Provider, ReasoningEffort, WireApi } from '../shared/types';
import type { AddModelsResult, DiscoveredModel, DiscoveryResult, ModelMetadataField, ModelSelection } from '../shared/catalog-types';
import { catalogAccessMessages } from '../shared/catalog-types';
import { MODEL_SPEC_FIELDS, REASONING_EFFORTS, modelSpecs } from '../shared/types';
import { lookupModelMetadata, lookupModelReasoningDefaults } from '../shared/model-metadata';
import { applyOfficialModelParameters, officialModelParameterFields, reasoningSelectionPatch, withReasoningWireApi } from '../shared/model-draft';
import { modelDisplayLabel, modelLocalAlias } from '../shared/model-names';
import { groupModelsBySeries } from '../shared/model-order';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';

type MetadataField = ModelMetadataField;
type CandidateDraft = DiscoveredModel & { selected: boolean; editedFields?: MetadataField[] };
interface Props {
  api?: ModelDockApi;
  provider: Provider;
  notify: Notify;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
  onManualAdd?: () => void;
  initialResult?: DiscoveryResult;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^(?:Error:\s*)?Error invoking remote method ['"]modeldock:(?:discoverModels|addDiscoveredModels)['"]:\s*(?:Error:\s*)?/, '');
const protocolLabel = (wireApi: WireApi) => wireApi === 'messages' ? 'Anthropic Messages' : wireApi === 'responses' ? 'Responses' : 'Chat Completions';
const reasoningEffortLabels: Record<ReasoningEffort, string> = { none: '无', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
const candidateDraft = (model: DiscoveredModel, providerId: string): CandidateDraft => ({ ...model, alias: modelLocalAlias({ providerId, alias: model.alias }), selected: !model.existingModelId && model.catalogImportable !== false });
const metadataLabels: Record<MetadataField, string> = { contextWindow: '上下文', tools: '工具调用', vision: '图片输入', maxInputTokens: '输入上限', maxOutputTokens: '输出预算', thinking: '思考能力', reasoningEfforts: '思考等级', defaultReasoningEffort: '默认强度', reasoningEffortFormat: '思考格式', adaptiveThinking: '自适应思考', minThinkingBudget: '最低思考预算', maxThinkingBudget: '最高思考预算' };
const activeMetadataFields = (model: CandidateDraft, fields: readonly MetadataField[] | undefined) => (fields ?? []).filter(field => !model.editedFields?.includes(field));
const metadataFieldLabels = (fields: readonly MetadataField[]) => fields.map(field => metadataLabels[field]).join('、');
const metadataOrigin = (model: CandidateDraft, field: MetadataField) => model.existingModelId ? '已保存设置' : model.editedFields?.includes(field) ? '用户设置' : model[field] === undefined ? '未声明' : model.metadataInferred?.some(inferred => inferred === field) ? '内置字典' : model.metadataDefaults?.includes(field) ? '本地默认' : '供应商';
const patchedCandidate = (model: CandidateDraft, patch: Partial<CandidateDraft>): CandidateDraft => {
  const merged = { ...model, ...patch };
  const next = patch.wireApi ? withReasoningWireApi(merged, patch.wireApi) : merged;
  const edited = (['contextWindow', 'tools', 'vision', 'reasoningEfforts', 'defaultReasoningEffort', ...MODEL_SPEC_FIELDS] as const).filter(field => Object.prototype.hasOwnProperty.call(patch, field) || field === 'reasoningEffortFormat' && !!patch.wireApi);
  return { ...next, editedFields: [...new Set([...(model.editedFields ?? []), ...edited])] };
};

function CandidateSettings({ id, model, provider, locked, onUpdate }: {
  id: string;
  model: CandidateDraft;
  provider: Provider;
  locked: boolean;
  onUpdate: (patch: Partial<CandidateDraft>) => void;
}) {
  const inferredFields = activeMetadataFields(model, model.metadataInferred);
  const defaultFields = activeMetadataFields(model, model.metadataDefaults);
  const metadata = lookupModelMetadata(model.upstreamId, provider, model.wireApi);
  const reasoningMetadata = lookupModelReasoningDefaults(model.upstreamId, provider, model.wireApi);
  const thinking = model.thinking ?? !!model.reasoningEfforts?.length;
  const chatOnly = provider.nativeAdapter === 'jetbrains-ide';
  return <div id={id} className="discovery-model-settings">
    <div className="discovery-model-meta">
      <code>模型 ID · {model.upstreamId}</code>
      <small>展示：{modelDisplayLabel(model, provider)}</small>
      <small>{protocolLabel(model.wireApi)} · {model.contextWindow ? `${model.contextWindow.toLocaleString('zh-CN')} 上下文` : '上下文未设置'}{model.tools ? defaultFields.includes('tools') ? ' · 可尝试工具调用' : ' · 工具调用' : ' · 工具调用关闭'}{model.vision ? ' · 图片输入' : ' · 图片输入关闭'}{model.thinking || model.reasoningEfforts?.length ? ' · 支持思考' : ''}{model.reasoningEfforts?.length ? ' · 可选思考等级' : ''}</small>
      {model.catalogImportable === false && <small>{model.catalogBlockedReason ? catalogAccessMessages[model.catalogBlockedReason] : '客户端中可见，官方直连配置尚未核实。'}</small>}
      {!model.existingModelId && <>
        {!!inferredFields.length && <small>字典补全：{metadataFieldLabels(inferredFields)}</small>}
        {!!defaultFields.length && <small>缺少规格，使用本地默认：{metadataFieldLabels(defaultFields)}</small>}
        {!!model.editedFields?.length && <small>用户设置：{metadataFieldLabels(model.editedFields)}</small>}
      </>}
    </div>
    <div className="discovery-model-fields">
      <label>显示名称<input aria-label={`${model.upstreamId} 显示名称`} value={model.displayName} disabled={locked} onChange={event => onUpdate({ displayName: event.target.value })} /></label>
      <label>模型简称<input aria-label={`${model.upstreamId} 模型简称`} value={model.alias} disabled={locked} onChange={event => onUpdate({ alias: event.target.value })} /></label>
    </div>
    <div className="discovery-advanced-grid">
      <label>调用接口<select aria-label={`${model.upstreamId} 调用接口`} value={model.wireApi} disabled={locked || chatOnly} onChange={event => onUpdate({ wireApi: event.target.value as WireApi })}>{(provider.kind === 'openai-compatible' || provider.kind === 'copilot' || provider.kind === 'opencode-go') && <option value="chat-completions">Chat Completions</option>}<option value="responses">Responses</option>{provider.kind === 'openai-compatible' && <option value="messages">Anthropic Messages</option>}</select></label>
      <label><span>上下文长度 <small>{metadataOrigin(model, 'contextWindow')}</small></span><input aria-label={`${model.upstreamId} 上下文长度`} type="number" min="0" step="1" value={model.contextWindow} disabled={locked} onChange={event => onUpdate({ contextWindow: event.target.value === '' ? 0 : Number(event.target.value) })} /></label>
      <label><span>输入上限 <small>{metadataOrigin(model, 'maxInputTokens')}</small></span><input aria-label={`${model.upstreamId} 输入上限`} type="number" min="0" step="1" value={model.maxInputTokens ?? 0} disabled={locked} onChange={event => onUpdate({ maxInputTokens: event.target.value === '' ? 0 : Number(event.target.value) })} /></label>
      <label><span>输出预算 <small>{metadataOrigin(model, 'maxOutputTokens')}</small></span><input aria-label={`${model.upstreamId} 输出预算`} type="number" min="0" step="1" value={model.maxOutputTokens ?? 0} disabled={locked} onChange={event => onUpdate({ maxOutputTokens: event.target.value === '' ? 0 : Number(event.target.value) })} /></label>
      <label><span>思考能力 <small>{metadataOrigin(model, 'thinking')}</small></span><select aria-label={`${model.upstreamId} 思考能力`} value={model.thinking === undefined ? 'unknown' : model.thinking ? 'yes' : 'no'} disabled={locked} onChange={event => onUpdate(event.target.value === 'no' ? { thinking: false, reasoningEfforts: [], defaultReasoningEffort: undefined, reasoningEffortFormat: undefined, adaptiveThinking: false, minThinkingBudget: undefined, maxThinkingBudget: undefined } : { thinking: event.target.value === 'yes' ? true : undefined })}><option value="unknown">未核实</option><option value="yes">支持</option><option value="no">不支持</option></select></label>
      <label><span>工具调用 <small>{metadataOrigin(model, 'tools')}</small></span><select aria-label={`${model.upstreamId} 工具调用`} value={model.tools ? 'yes' : 'no'} disabled={locked} onChange={event => onUpdate({ tools: event.target.value === 'yes' })}><option value="yes">启用</option><option value="no">关闭</option></select></label>
      <label><span>图片输入 <small>{metadataOrigin(model, 'vision')}</small></span><select aria-label={`${model.upstreamId} 图片输入`} value={model.vision ? 'yes' : 'no'} disabled={locked} onChange={event => onUpdate({ vision: event.target.value === 'yes' })}><option value="yes">启用</option><option value="no">关闭</option></select></label>
    </div>
    {thinking && <>
      <div className="discovery-reasoning-heading"><span>可选思考等级 <small>{metadataOrigin(model, 'reasoningEfforts')}{reasoningMetadata?.reasoningDefaultsSource === 'builtin' ? ' · 内置默认' : ''}</small></span><button type="button" className="button secondary small" disabled={locked || (!metadata && !reasoningMetadata)} aria-label={`${model.upstreamId} 应用维护参数`} onClick={() => {
        if (!metadata && !reasoningMetadata) return;
        const maintained = applyOfficialModelParameters(model, metadata, reasoningMetadata);
        onUpdate(Object.fromEntries(officialModelParameterFields(metadata, reasoningMetadata).map(field => [field, maintained[field]])) as Partial<CandidateDraft>);
      }}>应用维护参数</button></div>
      <div className="capability-field reasoning-field discovery-reasoning-field">{REASONING_EFFORTS.map(level => <label key={level}><input type="checkbox" aria-label={`${model.upstreamId} 思考等级 ${level}`} checked={(model.reasoningEfforts ?? []).includes(level)} disabled={locked} onChange={event => onUpdate(reasoningSelectionPatch(model, level, event.target.checked))} />{reasoningEffortLabels[level]}</label>)}</div>
      {!!model.reasoningEfforts?.length && <label className="discovery-reasoning-default">默认思考强度<select aria-label={`${model.upstreamId} 默认思考强度`} value={model.defaultReasoningEffort ?? ''} disabled={locked} onChange={event => onUpdate({ defaultReasoningEffort: (event.target.value || undefined) as ReasoningEffort | undefined, reasoningEffortFormat: model.wireApi })}><option value="">由工具选择</option>{model.reasoningEfforts.map(level => <option key={level} value={level}>{reasoningEffortLabels[level]}（{level}）</option>)}</select></label>}
    </>}
    <p className="discovery-settings-note">{model.existingModelId ? '这些参数已保存，可在供应商模型列表中修改。' : '0 表示长度未设置或自动；输出预算可以小于支持上限。已勾选的思考等级会提供给工具选择，添加后保存。'}{!!inferredFields.length && model.metadataReference && <> <a href={model.metadataReference.sourceUrl} target="_blank" rel="noopener noreferrer">字典参考文档</a> · 核对日期 {model.metadataReference.verifiedAt}</>}</p>
  </div>;
}

const compactContext = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function navigatePicker(event: KeyboardEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  if (event.key === 'Enter' && target.matches('.discovery-model-select input')) {
    event.preventDefault();
    target.closest('.discovery-option')?.querySelector<HTMLButtonElement>('.discovery-toggle')?.click();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const row = target.closest<HTMLElement>('.discovery-option');
  const search = event.currentTarget.querySelector<HTMLInputElement>('.discovery-toolbar input[type="search"]');
  if (!row && target !== search) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.discovery-option'));
  if (!rows.length) return;
  event.preventDefault();
  const index = row ? rows.indexOf(row) : -1;
  if (index <= 0 && event.key === 'ArrowUp') {
    search?.focus();
    return;
  }
  const next = rows[Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))];
  const checkbox = next.querySelector<HTMLInputElement>('input:not(:disabled)');
  const toggle = next.querySelector<HTMLButtonElement>('.discovery-toggle');
  (target.closest('.discovery-toggle') ? toggle : checkbox ?? toggle)?.focus();
}

export function ModelDiscovery({ api, provider, notify, onClose, onAdded, onManualAdd, initialResult }: Props) {
  const chatOnly = provider.nativeAdapter === 'jetbrains-ide';
  const [result, setResult] = useState<DiscoveryResult | null>(initialResult ?? null);
  const [models, setModels] = useState<CandidateDraft[]>(() => (initialResult?.models ?? []).map(model => candidateDraft(model, provider.id)));
  const [loading, setLoading] = useState(!initialResult);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [seriesKey, setSeriesKey] = useState('');
  const seriesPanelId = useId();
  const [showHistorical, setShowHistorical] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<AddModelsResult | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pointerNavigation, setPointerNavigation] = useState(false);
  const editorId = useId();
  const [advanced, setAdvanced] = useState(false);
  const [bulkWireApi, setBulkWireApi] = useState<WireApi | ''>('');
  const [bulkContext, setBulkContext] = useState('');
  const [bulkTools, setBulkTools] = useState('');
  const [bulkVision, setBulkVision] = useState('');
  const request = useRef(0);
  const mounted = useRef(true);
  const listBody = useRef<HTMLDivElement>(null);
  const selectionBox = useRef<HTMLInputElement>(null);
  const historySupported = !!result?.history;
  useEffect(() => { setShowHistorical(false); }, [provider.id]);

  const fetchModels = useCallback(async () => {
    const current = ++request.current;
    setLoading(true); setError(''); setResult(null); setExpandedId(null); setModels([]); setAdded(null);
    try {
      if (!api) throw new Error('桌面应用尚未连接，请在 ModelDock 桌面程序中获取模型列表。');
      const next = await api.discoverModels(provider.id);
      if (!mounted.current || current !== request.current) return;
      setResult(next);
      setModels(next.ok ? next.models.map(model => candidateDraft(model, provider.id)) : []);
    } catch (failure) {
      if (mounted.current && current === request.current) setError(errorText(failure));
    } finally {
      if (mounted.current && current === request.current) setLoading(false);
    }
  }, [api, provider.id]);

  useEffect(() => {
    mounted.current = true;
    setExpandedId(null);
    if (initialResult?.providerId === provider.id) {
      setResult(initialResult);
      setModels(initialResult.ok ? initialResult.models.map(model => candidateDraft(model, provider.id)) : []);
      setLoading(false);
    } else void fetchModels();
    return () => { mounted.current = false; ++request.current; };
  }, [fetchModels, initialResult, provider.id]);

  const eligible = useMemo(() => models.filter(model => !historySupported || showHistorical || model.catalogVisibility === 'current'), [models, historySupported, showHistorical]);
  const catalogSource = result?.history?.source;
  const catalogSeries = useMemo(() => groupModelsBySeries(eligible, catalogSource), [eligible, catalogSource]);
  const currentSeries = catalogSeries.find(group => group.key === seriesKey);
  const tabs = [{ key: '', label: '全部' }, ...catalogSeries];
  const currentTab = currentSeries?.key ?? '';
  const series = useMemo(() => {
    const scope = currentSeries ? [currentSeries] : catalogSeries;
    const query = search.trim().toLowerCase();
    if (!query) return scope;
    return scope.map(group => ({
      ...group,
      models: group.models.filter(model => [model.upstreamId, model.alias, modelDisplayLabel(model, provider)].some(value => value.toLowerCase().includes(query))),
    })).filter(group => group.models.length);
  }, [currentSeries, catalogSeries, search, provider]);
  const visible = series.flatMap(group => group.models);
  const scopeSize = currentSeries?.models.length ?? eligible.length;
  const selectAllLabel = search.trim() ? '全选筛选结果' : currentSeries ? '全选当前系列' : '全选可添加模型';
  const available = visible.filter(model => !model.existingModelId && model.catalogImportable !== false);
  const selected = eligible.filter(model => model.selected && !model.existingModelId && model.catalogImportable !== false);
  const allSelected = available.length > 0 && available.every(model => model.selected);
  const someSelected = available.some(model => model.selected);
  useEffect(() => { if (selectionBox.current) selectionBox.current.indeterminate = someSelected && !allSelected; }, [someSelected, allSelected]);

  function navigateSeries(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const button = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    button?.focus();
    button?.click();
  }

  const updateModel = (upstreamId: string, patch: Partial<CandidateDraft>) => {
    setModels(previous => previous.map(model => model.upstreamId === upstreamId && !model.existingModelId && model.catalogImportable !== false ? patchedCandidate(model, patch) : model));
    setError(''); setAdded(null);
  };
  const selectVisible = (checked: boolean) => {
    const ids = new Set(available.map(model => model.upstreamId));
    setModels(previous => previous.map(model => ids.has(model.upstreamId) ? { ...model, selected: checked } : model));
    setError(''); setAdded(null);
  };
  const applyAdvanced = () => {
    if (!selected.length) return;
    const contextWindow = bulkContext.trim() === '' ? undefined : Number(bulkContext);
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 0)) { setError('上下文长度请填写大于或等于 0 的整数。0 表示未设置。'); return; }
    const patch: Partial<CandidateDraft> = {
      ...(bulkWireApi ? { wireApi: bulkWireApi } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(bulkTools ? { tools: bulkTools === 'yes' } : {}),
      ...(bulkVision ? { vision: bulkVision === 'yes' } : {}),
    };
    const selectedIds = new Set(selected.map(model => model.upstreamId));
    setModels(previous => previous.map(model => selectedIds.has(model.upstreamId) ? patchedCandidate(model, patch) : model));
    setError(''); setAdded(null);
    notify(`已为 ${selected.length} 个所选模型应用本地设置，添加后生效。`, 'info');
  };
  const addSelected = async () => {
    if (!api || !selected.length || adding) return;
    setError(''); setAdded(null);
    const aliases = new Set<string>();
    for (const model of selected) {
      const alias = model.alias.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(alias)) { setError(`「${model.upstreamId}」的模型简称需以字母或数字开头，只能包含字母、数字和 . _ : / -。`); return; }
      if (aliases.has(alias)) { setError(`本次选择中的模型简称「${alias}」重复，请修改后再添加。不同供应商可以使用相同简称。`); return; }
      if (!model.displayName.trim()) { setError(`请为「${model.upstreamId}」填写显示名称。`); return; }
      if ([model.contextWindow, model.maxInputTokens ?? 0, model.maxOutputTokens ?? 0].some(value => !Number.isSafeInteger(value) || value < 0)) { setError(`「${model.upstreamId}」的上下文、输入上限和输出预算请填写非负整数。0 表示未设置或自动。`); return; }
      aliases.add(alias);
    }
    const selections: ModelSelection[] = selected.map(model => ({ upstreamId: model.upstreamId, alias: model.alias.trim(), displayName: model.displayName.trim(), wireApi: model.wireApi, contextWindow: model.contextWindow, tools: model.tools, vision: model.vision, reasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort, ...modelSpecs(model), reasoningEffortFormat: model.reasoningEfforts?.length ? model.wireApi : undefined }));
    setAdding(true);
    try {
      const next = await api.addDiscoveredModels(provider.id, selections);
      if (!mounted.current) return;
      setAdded(next);
      const imported = new Map(next.added.map(model => [model.upstreamId, model]));
      const skipped = new Set(next.skipped);
      setModels(previous => previous.map(model => {
        const saved = imported.get(model.upstreamId);
        return saved ? { ...model, alias: modelLocalAlias(saved), displayName: saved.displayName, existingModelId: saved.id, selected: false } : skipped.has(model.upstreamId) ? { ...model, existingModelId: model.existingModelId ?? 'existing', selected: false } : model;
      }));
      notify(`已添加 ${next.added.length} 个模型${next.skipped.length ? `，跳过 ${next.skipped.length} 个已存在模型` : ''}，请重新同步所用工具。`);
      try { await onAdded(); } catch (failure) { notify(`模型已保存，但页面刷新失败：${errorText(failure)}`, 'info'); }
    } catch (failure) {
      if (mounted.current) setError(errorText(failure));
    } finally { if (mounted.current) setAdding(false); }
  };

  return <Modal wide title="获取模型列表" subtitle={provider.name} onClose={() => { if (!adding) onClose(); }}>
    <div className="discovery-body" ref={listBody} onKeyDown={navigatePicker}>
      <div className="discovery-source"><span>模型来源</span><code title={provider.baseUrl}>{provider.baseUrl}</code><button className="button secondary small" disabled={loading || adding} onClick={() => void fetchModels()}><BusyIcon active={loading}><RefreshCw size={14} /></BusyIcon>{loading ? '获取中' : '重新获取'}</button></div>
      {loading ? <div className="discovery-loading" role="status"><BusyIcon active><Download size={24} /></BusyIcon><strong>正在获取供应商模型列表…</strong><span>使用已保存的凭据连接上游服务。</span></div> : <>
        {!result?.ok && (error || result) && <div className="discovery-error" role="alert"><strong>{result?.errorCategory === 'unsupported' ? '此供应商没有模型列表接口' : result?.statusCode ? `获取失败 · HTTP ${result.statusCode}` : '获取失败'}</strong><span>{error || result?.message}</span>{result && <small>模型列表不可用不代表模型无法调用；可以手动添加模型后测试连接。</small>}</div>}
        {result?.ok && <>
          <div className="discovery-picker-header">
            {catalogSeries.length > 0 && <div className="discovery-series-tabs" role="tablist" aria-label="模型系列">
              {tabs.map((tab, index) => <button type="button" key={tab.key} role="tab" id={`${seriesPanelId}-tab-${index}`}
                data-discovery-series-tab={tab.key} aria-controls={seriesPanelId} aria-selected={currentTab === tab.key}
                tabIndex={currentTab === tab.key ? 0 : -1} disabled={adding} title={tab.label}
                onKeyDown={event => navigateSeries(event, index)} onClick={() => { setSeriesKey(tab.key); setExpandedId(null); listBody.current?.scrollTo({ top: 0 }); }}>
                {tab.label}
              </button>)}
            </div>}
            <div className="discovery-toolbar"><label className="search-box"><Search size={15} /><input autoFocus type="search" aria-label="搜索模型" placeholder={currentSeries ? `搜索 ${currentSeries.label} 模型` : '搜索模型 ID 或名称'} value={search} disabled={adding} onChange={event => { setSearch(event.target.value); setExpandedId(null); listBody.current?.scrollTo({ top: 0 }); }} /></label>{historySupported && <label className="discovery-history-toggle"><input type="checkbox" aria-label="显示历史模型" data-action="show-history-models" checked={showHistorical} disabled={loading || adding} onChange={event => { setShowHistorical(event.target.checked); setError(''); setAdded(null); }} />显示历史模型</label>}<span data-discovery-count>{search.trim() ? `${visible.length} / ${scopeSize}` : scopeSize} 个模型{visible.some(model => model.existingModelId) ? ` · ${visible.filter(model => model.existingModelId).length} 个已添加` : ''}</span><button className={`button secondary small ${advanced ? 'selected' : ''}`} aria-expanded={advanced} disabled={adding} onClick={() => setAdvanced(value => !value)}><Settings2 size={14} />高级设置<ChevronDown size={13} className={advanced ? 'discovery-chevron-open' : ''} /></button></div>
          </div>
          {historySupported && <p className="discovery-history-note" data-discovery-history-message>{result.history?.message || (result.history?.currentVerified ? '默认仅显示已确认的当前模型；勾选后可查看客户端未展示或显示状态未核实的条目。已添加的模型保持不变。' : '尚未核实完整的当前客户端清单；默认仅显示已确认的当前模型，勾选可查看其他已识别条目。')}</p>}
          {advanced && <div className="discovery-advanced">
            <div className="discovery-advanced-copy"><strong>批量配置所选模型</strong><small>优先使用供应商返回的参数；缺少时按内置字典补全。可逐个展开「参数设置」或在这里批量修正，手动设置会覆盖补全值。无法核实的工具和图片能力默认关闭，可自行启用。</small></div>
            <div className="discovery-advanced-grid">
              <label>调用接口<select value={bulkWireApi} disabled={adding || chatOnly} onChange={event => setBulkWireApi(event.target.value as WireApi | '')}><option value="">保留列表设置</option>{(provider.kind === 'openai-compatible' || provider.kind === 'copilot' || provider.kind === 'opencode-go') && <option value="chat-completions">Chat Completions</option>}<option value="responses">Responses</option>{provider.kind === 'openai-compatible' && <option value="messages">Anthropic Messages</option>}</select></label>
              <label>上下文长度<input type="number" min="0" step="1" value={bulkContext} disabled={adding} placeholder="留空保留，0 为未设置" onChange={event => setBulkContext(event.target.value)} /></label>
              <label>工具调用<select value={bulkTools} disabled={adding} onChange={event => setBulkTools(event.target.value)}><option value="">保留列表设置</option><option value="yes">启用</option><option value="no">关闭</option></select></label>
              <label>图片输入<select value={bulkVision} disabled={adding} onChange={event => setBulkVision(event.target.value)}><option value="">保留列表设置</option><option value="yes">启用</option><option value="no">关闭</option></select></label>
            </div>
            <button className="button secondary small" disabled={adding || !selected.length || (!bulkWireApi && !bulkContext.trim() && !bulkTools && !bulkVision)} onClick={applyAdvanced}>应用到所选 {selected.length} 个模型</button>
          </div>}
          <div id={seriesPanelId} role={catalogSeries.length ? 'tabpanel' : undefined} aria-labelledby={catalogSeries.length ? `${seriesPanelId}-tab-${tabs.findIndex(tab => tab.key === currentTab)}` : undefined}>
            {visible.length ? <div className="discovery-list" data-mixed-selection={someSelected && !allSelected || undefined} data-pointer-navigation={pointerNavigation || undefined}
              onPointerMove={() => { if (!pointerNavigation) setPointerNavigation(true); }} onPointerLeave={() => setPointerNavigation(false)}
              onFocusCapture={() => setPointerNavigation(false)} onKeyDownCapture={() => setPointerNavigation(false)}>
              <div className="discovery-list-header"><label><input ref={selectionBox} type="checkbox" aria-label={selectAllLabel} checked={allSelected} disabled={adding || !available.length} onChange={event => selectVisible(event.target.checked)} />{selectAllLabel}</label></div>
              {series.map(group => <section key={group.key} data-model-series={group.key} aria-label={group.label}>
                {!currentSeries && <h3 className="discovery-series-title">{group.label}</h3>}
                {group.models.map(model => {
                  const locked = adding || !!model.existingModelId || model.catalogImportable === false;
                  const open = expandedId === model.upstreamId;
                  return <div className={`discovery-model ${open ? 'open' : ''} ${model.existingModelId ? 'existing' : ''} ${model.catalogImportable === false ? 'unavailable' : ''}`} key={model.upstreamId}>
                    <div className="discovery-option">
                      <label className="discovery-model-select">
                        <input type="checkbox" checked={model.selected} disabled={locked} aria-label={`选择模型 ${model.upstreamId}`} onChange={event => updateModel(model.upstreamId, { selected: event.target.checked })} />
                        <strong title={model.upstreamId}>{modelDisplayLabel(model, provider)}</strong>
                      </label>
                      {historySupported && model.catalogVisibility === 'historical' && <span className="badge" data-model-historical>客户端未展示</span>}
                      {historySupported && model.catalogVisibility === undefined && <span className="badge" data-model-visibility-unknown>显示状态未核实</span>}
                      {model.catalogImportable === false && <span className="badge" data-model-unimportable={model.catalogBlockedReason ?? ''} title={model.catalogBlockedReason ? catalogAccessMessages[model.catalogBlockedReason] : undefined}>暂不支持添加</span>}
                      {model.existingModelId && <span className="badge positive"><Check size={11} />已添加</span>}
                      <span className="discovery-context" title={model.contextWindow ? `上下文长度：${model.contextWindow.toLocaleString('zh-CN')} tokens` : '上下文未设置'}>
                        {model.defaultReasoningEffort && <span>{reasoningEffortLabels[model.defaultReasoningEffort]}</span>}
                        {model.contextWindow > 0 && <span>Max {compactContext.format(model.contextWindow)}</span>}
                      </span>
                      <button type="button" className="discovery-toggle" aria-label={`${model.upstreamId} 参数设置`} aria-expanded={open} aria-controls={open ? editorId : undefined} title={open ? '收起参数' : '查看和编辑模型参数'} onClick={() => setExpandedId(open ? null : model.upstreamId)}><ChevronDown size={14} /></button>
                    </div>
                    {open && <CandidateSettings id={editorId} model={model} provider={provider} locked={locked} onUpdate={patch => updateModel(model.upstreamId, patch)} />}
                  </div>;
                })}
              </section>)}
            </div> : <EmptyState compact icon={<Layers3 size={24} />} title={search.trim() ? '没有匹配的模型' : historySupported && !showHistorical ? result.history?.currentVerified ? '没有已确认的当前模型' : '尚未核实当前客户端清单' : '供应商返回了空列表'} description={search.trim() ? '修改搜索内容后继续选择。' : historySupported && !showHistorical ? '可刷新客户端清单后重试，或勾选“显示历史模型”查看其他已识别条目。已添加的模型保持不变。' : '该地址暂未返回模型，请检查供应商地址与账号权限，也可以手动添加。'} />}
          </div>
          <details className="discovery-note"><summary>参数来源与默认值</summary><p>参数优先采用供应商声明，缺少时按内置字典补全，可展开「参数设置」手动修正。不同供应商可以添加同名模型；目录和工具中按「套餐名 - 模型名」展示。无法核实的工具和图片能力默认关闭，可自行启用。模型可见和字典规格不代表实际调用权限，仍需推理验证。上下文未设置时，工具配置使用 32K 上下文 / 4K 输出的保守预算，以上预算并非上游规格。</p></details>
        </>}
        {!result && !error && <EmptyState compact icon={<Layers3 size={24} />} title="尚未获取模型" description="点击重新获取，从供应商读取真实模型列表。" />}
      </>}
    </div>
    {result?.ok && error && <div className="discovery-feedback discovery-error" role="alert"><strong>添加未完成</strong><span>{error}</span></div>}
    {added && <div className="discovery-feedback discovery-success" role="status"><Check size={15} /><span>已添加 {added.added.length} 个模型{added.skipped.length ? `，跳过 ${added.skipped.length} 个已存在模型` : ''}。</span></div>}
    <div className="modal-footer discovery-footer"><span>{loading ? '正在读取模型列表' : result?.ok ? `已选择 ${selected.length} 个待添加模型` : '可手动添加模型并测试连接'}</span><div className="footer-actions">{onManualAdd && <button type="button" className="button secondary" disabled={loading || adding} onClick={onManualAdd}>手动添加</button>}<button className="button secondary" disabled={adding} onClick={onClose}>{added ? '完成' : '取消'}</button><button className="button primary" disabled={loading || adding || !api || !result?.ok || !selected.length} onClick={() => void addSelected()}><BusyIcon active={adding}><Download size={15} /></BusyIcon>{adding ? '添加中…' : `添加所选 ${selected.length} 个模型`}</button></div></div>
  </Modal>;
}

export default ModelDiscovery;
