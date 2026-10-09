import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Download, Info, Layers3, RefreshCw, Search, Settings2 } from './MaterialIcon';
import type { ModelDockApi, Provider, WireApi } from '../shared/types';
import type { AddModelsResult, DiscoveredModel, DiscoveryResult, ModelSelection } from '../shared/catalog-types';
import { modelDisplayLabel, modelLocalAlias } from '../shared/model-names';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';

type MetadataField = 'contextWindow' | 'tools' | 'vision';
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
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const protocolLabel = (wireApi: WireApi) => wireApi === 'messages' ? 'Anthropic Messages' : wireApi === 'responses' ? 'Responses' : 'Chat Completions';
const candidateDraft = (model: DiscoveredModel, providerId: string): CandidateDraft => ({ ...model, alias: modelLocalAlias({ providerId, alias: model.alias }), tools: !model.existingModelId && model.metadataDefaults?.includes('tools') ? true : model.tools, selected: !model.existingModelId });
const metadataLabels: Record<MetadataField, string> = { contextWindow: '上下文', tools: '工具调用', vision: '图片输入' };
const activeMetadataFields = (model: CandidateDraft, fields: readonly MetadataField[] | undefined) => (fields ?? []).filter(field => !model.editedFields?.includes(field));
const metadataFieldLabels = (fields: readonly MetadataField[]) => fields.map(field => metadataLabels[field]).join('、');
const metadataOrigin = (model: CandidateDraft, field: MetadataField) => model.existingModelId ? '已保存设置' : model.editedFields?.includes(field) ? '用户设置' : model.metadataInferred?.some(inferred => inferred === field) ? '内置字典' : model.metadataDefaults?.includes(field) ? '本地默认' : '供应商';
const patchedCandidate = (model: CandidateDraft, patch: Partial<CandidateDraft>): CandidateDraft => ({ ...model, ...patch, editedFields: [...new Set([...(model.editedFields ?? []), ...(['contextWindow', 'tools', 'vision'] as const).filter(field => Object.prototype.hasOwnProperty.call(patch, field))])] });

export function ModelDiscovery({ api, provider, notify, onClose, onAdded, onManualAdd, initialResult }: Props) {
  const [result, setResult] = useState<DiscoveryResult | null>(initialResult ?? null);
  const [models, setModels] = useState<CandidateDraft[]>(() => (initialResult?.models ?? []).map(model => candidateDraft(model, provider.id)));
  const [loading, setLoading] = useState(!initialResult);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [added, setAdded] = useState<AddModelsResult | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [bulkWireApi, setBulkWireApi] = useState<WireApi | ''>('');
  const [bulkContext, setBulkContext] = useState('');
  const [bulkTools, setBulkTools] = useState('');
  const [bulkVision, setBulkVision] = useState('');
  const request = useRef(0);
  const mounted = useRef(true);
  const selectionBox = useRef<HTMLInputElement>(null);

  const fetchModels = useCallback(async () => {
    const current = ++request.current;
    setLoading(true); setError(''); setResult(null); setModels([]); setAdded(null);
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
    if (initialResult?.providerId === provider.id) {
      setResult(initialResult);
      setModels(initialResult.ok ? initialResult.models.map(model => candidateDraft(model, provider.id)) : []);
      setLoading(false);
    } else void fetchModels();
    return () => { mounted.current = false; ++request.current; };
  }, [fetchModels, initialResult, provider.id]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter(model => !query || [model.upstreamId, model.alias, model.displayName].some(value => value.toLowerCase().includes(query)));
  }, [models, search]);
  const available = visible.filter(model => !model.existingModelId);
  const selected = models.filter(model => model.selected && !model.existingModelId);
  const allSelected = available.length > 0 && available.every(model => model.selected);
  const someSelected = available.some(model => model.selected);
  useEffect(() => { if (selectionBox.current) selectionBox.current.indeterminate = someSelected && !allSelected; }, [someSelected, allSelected]);

  const updateModel = (upstreamId: string, patch: Partial<CandidateDraft>) => {
    setModels(previous => previous.map(model => model.upstreamId === upstreamId && !model.existingModelId ? patchedCandidate(model, patch) : model));
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
    setModels(previous => previous.map(model => model.selected && !model.existingModelId ? patchedCandidate(model, patch) : model));
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
      if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 0) { setError(`「${model.upstreamId}」的上下文长度请填写大于或等于 0 的整数。0 表示未设置。`); return; }
      aliases.add(alias);
    }
    const selections: ModelSelection[] = selected.map(({ upstreamId, alias, displayName, wireApi, contextWindow, tools, vision, reasoningEfforts, defaultReasoningEffort }) => ({ upstreamId, alias: alias.trim(), displayName: displayName.trim(), wireApi, contextWindow, tools, vision, reasoningEfforts, defaultReasoningEffort }));
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
      notify(`已添加 ${next.added.length} 个模型${next.skipped.length ? `，跳过 ${next.skipped.length} 个已存在模型` : ''}。`);
      try { await onAdded(); } catch (failure) { notify(`模型已保存，但页面刷新失败：${errorText(failure)}`, 'info'); }
    } catch (failure) {
      if (mounted.current) setError(errorText(failure));
    } finally { if (mounted.current) setAdding(false); }
  };

  return <Modal wide title="获取模型列表" subtitle={provider.name} onClose={() => { if (!adding) onClose(); }}>
    <div className="discovery-body">
      <div className="discovery-source"><span>模型来源</span><code title={provider.baseUrl}>{provider.baseUrl}</code><button className="button secondary small" disabled={loading || adding} onClick={() => void fetchModels()}><BusyIcon active={loading}><RefreshCw size={14} /></BusyIcon>{loading ? '获取中' : '重新获取'}</button></div>
      {loading ? <div className="discovery-loading" role="status"><BusyIcon active><Download size={24} /></BusyIcon><strong>正在获取供应商模型列表…</strong><span>使用已保存的凭据连接上游服务。</span></div> : <>
        {(error || result && !result.ok) && <div className="discovery-error" role="alert"><strong>{result && !result.ok ? result.errorCategory === 'unsupported' ? '此供应商没有模型列表接口' : result.statusCode ? `获取失败 · HTTP ${result.statusCode}` : '获取失败' : result?.ok ? '添加未完成' : '获取失败'}</strong><span>{error || result?.message}</span>{result && !result.ok && <small>模型列表不可用不代表模型无法调用；可以手动添加模型后测试连接。</small>}</div>}
        {result?.ok && <>
          <div className="discovery-toolbar"><label className="search-box"><Search size={15} /><input aria-label="搜索模型" placeholder="搜索模型 ID 或名称" value={search} disabled={adding} onChange={event => setSearch(event.target.value)} /></label><span>{models.length} 个模型{models.some(model => model.existingModelId) ? ` · ${models.filter(model => model.existingModelId).length} 个已添加` : ''}</span><button className={`button secondary small ${advanced ? 'selected' : ''}`} aria-expanded={advanced} disabled={adding} onClick={() => setAdvanced(value => !value)}><Settings2 size={14} />高级设置<ChevronDown size={13} className={advanced ? 'discovery-chevron-open' : ''} /></button></div>
          {advanced && <div className="discovery-advanced">
            <div className="discovery-advanced-copy"><strong>批量配置所选模型</strong><small>优先使用供应商返回的参数；缺少上下文或图片能力时，按内置字典补全。可逐个展开「参数设置」或在这里批量修正，手动设置会覆盖补全值。未声明工具能力时默认允许客户端尝试调用。</small></div>
            <div className="discovery-advanced-grid">
              <label>调用接口<select value={bulkWireApi} disabled={adding} onChange={event => setBulkWireApi(event.target.value as WireApi | '')}><option value="">保留列表设置</option>{(provider.kind === 'openai-compatible' || provider.kind === 'copilot') && <option value="chat-completions">Chat Completions</option>}<option value="responses">Responses</option>{provider.kind === 'openai-compatible' && <option value="messages">Anthropic Messages</option>}</select></label>
              <label>上下文长度<input type="number" min="0" step="1" value={bulkContext} disabled={adding} placeholder="留空保留，0 为未设置" onChange={event => setBulkContext(event.target.value)} /></label>
              <label>工具调用<select value={bulkTools} disabled={adding} onChange={event => setBulkTools(event.target.value)}><option value="">保留列表设置</option><option value="yes">启用</option><option value="no">关闭</option></select></label>
              <label>图片输入<select value={bulkVision} disabled={adding} onChange={event => setBulkVision(event.target.value)}><option value="">保留列表设置</option><option value="yes">启用</option><option value="no">关闭</option></select></label>
            </div>
            <button className="button secondary small" disabled={adding || !selected.length || (!bulkWireApi && !bulkContext.trim() && !bulkTools && !bulkVision)} onClick={applyAdvanced}>应用到所选 {selected.length} 个模型</button>
          </div>}
          {visible.length ? <div className="discovery-list">
            <div className="discovery-list-header"><label><input ref={selectionBox} type="checkbox" aria-label={search.trim() ? '全选筛选结果' : '全选可添加模型'} checked={allSelected} disabled={adding || !available.length} onChange={event => selectVisible(event.target.checked)} />{search.trim() ? '全选筛选结果' : '全选可添加模型'}</label><span>显示名称 / 模型简称</span></div>
            {visible.map(model => {
              const inferredFields = activeMetadataFields(model, model.metadataInferred);
              const defaultFields = activeMetadataFields(model, model.metadataDefaults);
              const locked = adding || !!model.existingModelId;
              return <div className={`discovery-model ${model.selected ? 'selected' : ''} ${model.existingModelId ? 'existing' : ''}`} key={model.upstreamId}>
                <label className="discovery-model-select"><input type="checkbox" checked={model.selected} disabled={locked} aria-label={`选择模型 ${model.upstreamId}`} onChange={event => updateModel(model.upstreamId, { selected: event.target.checked })} /><span>
                  <strong title={model.upstreamId}>{model.upstreamId}</strong>
                  <small title={modelDisplayLabel(model, provider)}>展示：{modelDisplayLabel(model, provider)}</small>
                  <small>{protocolLabel(model.wireApi)} · {model.contextWindow ? `${model.contextWindow.toLocaleString('zh-CN')} 上下文` : '上下文未设置'}{model.tools ? defaultFields.includes('tools') ? ' · 可尝试工具调用' : ' · 工具调用' : ' · 工具调用关闭'}{model.vision ? ' · 图片输入' : ' · 图片输入关闭'}{model.reasoningEfforts?.length ? ' · 思考强度' : ''}</small>
                  {model.existingModelId ? <span className="badge positive"><Check size={11} />已添加 · 保留已保存参数</span> : <>
                    {!!inferredFields.length && <small className="discovery-defaults">字典补全：{metadataFieldLabels(inferredFields)}</small>}
                    {!!defaultFields.length && <small className="discovery-defaults">缺少规格，使用本地默认：{metadataFieldLabels(defaultFields)}</small>}
                    {!!model.editedFields?.length && <small className="discovery-defaults">用户设置：{metadataFieldLabels(model.editedFields)}</small>}
                  </>}
                </span></label>
                <div className="discovery-model-fields"><label><span className="sr-only">{model.upstreamId} 显示名称</span><input aria-label={`${model.upstreamId} 显示名称`} placeholder="显示名称" value={model.displayName} disabled={locked} onChange={event => updateModel(model.upstreamId, { displayName: event.target.value })} /></label><label><span className="sr-only">{model.upstreamId} 模型简称</span><input aria-label={`${model.upstreamId} 模型简称`} placeholder="模型简称" value={model.alias} disabled={locked} onChange={event => updateModel(model.upstreamId, { alias: event.target.value })} /></label></div>
                <details className="discovery-model-settings">
                  <summary aria-label={`${model.upstreamId} 参数设置`}>参数设置{model.existingModelId ? ' · 已保存' : ''}</summary>
                  <div className="discovery-advanced-grid">
                    <label>调用接口<select aria-label={`${model.upstreamId} 调用接口`} value={model.wireApi} disabled={locked} onChange={event => updateModel(model.upstreamId, { wireApi: event.target.value as WireApi })}>{(provider.kind === 'openai-compatible' || provider.kind === 'copilot') && <option value="chat-completions">Chat Completions</option>}<option value="responses">Responses</option>{provider.kind === 'openai-compatible' && <option value="messages">Anthropic Messages</option>}</select></label>
                    <label><span>上下文长度 <small>{metadataOrigin(model, 'contextWindow')}</small></span><input aria-label={`${model.upstreamId} 上下文长度`} type="number" min="0" step="1" value={model.contextWindow} disabled={locked} onChange={event => updateModel(model.upstreamId, { contextWindow: event.target.value === '' ? 0 : Number(event.target.value) })} /></label>
                    <label><span>工具调用 <small>{metadataOrigin(model, 'tools')}</small></span><select aria-label={`${model.upstreamId} 工具调用`} value={model.tools ? 'yes' : 'no'} disabled={locked} onChange={event => updateModel(model.upstreamId, { tools: event.target.value === 'yes' })}><option value="yes">启用</option><option value="no">关闭</option></select></label>
                    <label><span>图片输入 <small>{metadataOrigin(model, 'vision')}</small></span><select aria-label={`${model.upstreamId} 图片输入`} value={model.vision ? 'yes' : 'no'} disabled={locked} onChange={event => updateModel(model.upstreamId, { vision: event.target.value === 'yes' })}><option value="yes">启用</option><option value="no">关闭</option></select></label>
                  </div>
                  <p className="discovery-settings-note">{model.existingModelId ? '这些参数已保存，可在模型目录中修改。' : '0 表示上下文未设置；手动修改会覆盖供应商或字典值，添加后保存。'}{!!inferredFields.length && model.metadataReference && <> <a href={model.metadataReference.sourceUrl} target="_blank" rel="noopener noreferrer">字典参考文档</a> · 核对日期 {model.metadataReference.verifiedAt}</>}</p>
                </details>
              </div>;
            })}
          </div> : <EmptyState compact icon={<Layers3 size={24} />} title={search.trim() ? '没有匹配的模型' : '供应商返回了空列表'} description={search.trim() ? '修改搜索内容后继续选择。' : '该地址暂未返回模型，请检查供应商地址与账号权限，也可以手动添加。'} />}
          <div className="discovery-note"><Info size={14} /><span>上下文和图片能力优先采用供应商参数，缺少时按内置字典补全，可展开「参数设置」手动修正。不同供应商可以添加同名模型；目录和工具中按「套餐名 - 模型名」展示。模型可见和字典规格不代表实际调用权限，仍需推理验证。未声明工具能力时允许客户端尝试；上下文未设置时，工具配置使用 32K 上下文 / 4K 输出的保守预算，以上预算并非上游规格。</span></div>
        </>}
        {!result && !error && <EmptyState compact icon={<Layers3 size={24} />} title="尚未获取模型" description="点击重新获取，从供应商读取真实模型列表。" />}
        {added && <div className="discovery-success" role="status"><Check size={15} /><span>已添加 {added.added.length} 个模型{added.skipped.length ? `，跳过 ${added.skipped.length} 个已存在模型` : ''}，可在模型目录和工具配置中使用。</span></div>}
      </>}
    </div>
    <div className="modal-footer discovery-footer"><span>{loading ? '正在读取模型列表' : result?.ok ? `已选择 ${selected.length} 个待添加模型` : '可手动添加模型并测试连接'}</span><div className="footer-actions">{onManualAdd && <button type="button" className="button secondary" disabled={loading || adding} onClick={onManualAdd}>手动添加</button>}<button className="button secondary" disabled={adding} onClick={onClose}>{added ? '完成' : '取消'}</button><button className="button primary" disabled={loading || adding || !api || !result?.ok || !selected.length} onClick={() => void addSelected()}><BusyIcon active={adding}><Download size={15} /></BusyIcon>{adding ? '添加中…' : `添加所选 ${selected.length} 个模型`}</button></div></div>
  </Modal>;
}

export default ModelDiscovery;
