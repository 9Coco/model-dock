import { ModelListViewport } from './ModelListViewport';
import { useState } from 'react';
import type { Model, ModelDockApi, Provider, Snapshot } from '../shared/types';
import { providerCategory } from '../shared/presets';
import { isPublishedGatewayModel, localGatewayBaseUrl, localModelStatus } from '../shared/local-connection';
import { Copy, ChevronDown, Layers3, Pencil, Search, Settings2, Waypoints } from './MaterialIcon';
import { CopyValue, SecretField } from './ConnectionFields';
import { EmptyState, Toggle, type Notify } from './components';
import './aggregate-panel.css';

export function AggregatePanel({ secretRevision, data, api, search, onSearch, onChanged, onProvider, onService, copy, notify, showServiceSummary = true }: {
  secretRevision: number; data: Snapshot; api: ModelDockApi | undefined; search: string; onSearch: (value: string) => void;
  onChanged: () => Promise<void>; onProvider: (id: string) => void; onService: () => void;
  copy: (value: string, message: string) => Promise<void>; notify: Notify; showServiceSummary?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const exposure = data.gatewayExposure ?? { excludedProviderIds: [], excludedModelIds: [] };
  const baseUrl = localGatewayBaseUrl(data);
  const published = (provider: Provider, model: Model) => isPublishedGatewayModel(data, provider, model);
  const activeModels = data.models.filter(model => { const provider = data.providers.find(item => item.id === model.providerId); return provider && published(provider, model); });
  const providers = data.providers.filter(provider => `${provider.name} ${providerCategory(provider) === 'api' ? provider.baseUrl : ''} ${data.models.filter(model => model.providerId === provider.id).map(model => `${model.alias} ${providerCategory(provider) === 'api' ? model.upstreamId : ''}`).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  async function save(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); await onChanged(); }
    catch (error) { notify(error instanceof Error ? error.message : '保存失败，请重试。', 'error'); }
    finally { setBusy(false); }
  }
  return <section className="aggregate-management" data-aggregate-management>
    {showServiceSummary && <div className="aggregate-strip"><Waypoints size={22} /><div><strong>本地聚合接口</strong><span>{exposure.excludedProviderIds.length ? data.providers.filter(provider => !exposure.excludedProviderIds.includes(provider.id)).length : data.providers.length} 家已加入 · {activeModels.length} 个已发布模型</span></div><span className={`badge ${data.gateway.running ? 'positive' : 'neutral'}`}>{data.gateway.running ? '运行中' : '未启动'}</span><button className="button small secondary" onClick={onService}><Settings2 size={14} />管理服务</button></div>}
    <div className="connection-fields" data-aggregate-connection><div><h3>URL</h3><CopyValue value={baseUrl} label="本地接口 URL" onCopy={copy} /></div><div><h3>API Key</h3><SecretField key={secretRevision} label="本地 API Key" available={!!api} reveal={() => api!.revealGatewayKey()} copy={() => api!.copyGatewayKey()} notify={notify} /></div></div>
    <div className="section-heading aggregate-heading"><h2>接口内的供应商<span className="count-tag">{data.providers.length}</span></h2><button type="button" className="button small secondary" disabled={!activeModels.length} data-action="copy-local-models" onClick={() => void copy(activeModels.map(model => model.alias).join('\n'), '本地接口模型名称已复制。')}><Copy size={14} />复制模型列表</button><label className="search-box"><Search size={15} /><input aria-label="搜索本地接口供应商或模型" placeholder="搜索供应商或模型" value={search} onChange={event => onSearch(event.target.value)} /></label></div>
    <p className="aggregate-scope-note">开关控制上方通用入口的供应商和模型。各工具专用入口的选择在对应工具中管理；直连配置不受影响。</p>
    <div className="aggregate-provider-groups">{(['api', 'subscription'] as const).map(category => <section className="aggregate-provider-group" key={category} data-aggregate-category={category}><h3>{category === 'api' ? 'API 供应商' : '订阅供应商'}<span className="count-tag">{providers.filter(provider => providerCategory(provider) === category).length}</span></h3><div className="aggregate-provider-list">{providers.filter(provider => providerCategory(provider) === category).map(provider => {
      const models = data.models.filter(model => model.providerId === provider.id);
      const included = !exposure.excludedProviderIds.includes(provider.id);
      const count = models.filter(model => published(provider, model)).length;
      const reason = !provider.enabled ? '供应商已停用' : !provider.hasSecret || provider.authStatus !== 'ready' ? category === 'api' ? '待配置 API Key' : '待授权或连接' : !provider.baseUrl ? '连接尚未配置' : !models.length ? '待添加模型' : !count ? '暂无已发布模型' : `${count} 个已发布模型`;
      return <article key={provider.id} className={`aggregate-provider-card ${included ? 'included' : ''}`} data-aggregate-provider={provider.id}>
        <div className="aggregate-provider-heading"><button type="button" className="aggregate-provider-expand" data-action="expand-aggregate-provider" aria-expanded={!!expanded[provider.id]} onClick={() => setExpanded(previous => ({ ...previous, [provider.id]: !previous[provider.id] }))}><ChevronDown size={16} className={expanded[provider.id] ? 'expanded' : ''} /><span><strong>{provider.name}</strong><small>{models.length} 个模型 · {category === 'api' ? 'API 供应商' : '订阅供应商'}</small></span></button><span className={`badge ${included && count ? 'positive' : 'neutral'}`} data-aggregate-provider-status>{included ? `已加入 · ${reason}` : '未加入'}</span><button type="button" className="icon-button" title={`管理 ${provider.name}`} aria-label={`管理 ${provider.name}`} onClick={() => onProvider(provider.id)}><Pencil size={15} /></button><Toggle checked={included} label={`在本地接口中使用 ${provider.name}`} disabled={!api || busy} onChange={enabled => void save(() => api!.setGatewayProviderEnabled(provider.id, enabled))} /></div>
        {expanded[provider.id] && <div className="aggregate-provider-models">{models.length ? <ModelListViewport key={provider.id} models={models}>{visible => <table className="aggregate-model-table"><thead><tr><th>发布</th><th>本地模型名称（调用时使用）</th><th>{category === 'api' ? '上游模型' : '接口'}</th><th>状态</th></tr></thead><tbody>{visible.map(model => <tr key={model.id} data-aggregate-model={model.id}><td><input type="checkbox" aria-label={`在本地接口中发布 ${model.alias}`} checked={!exposure.excludedModelIds.includes(model.id)} disabled={!api || busy} onChange={event => { const enabled = event.target.checked; void save(() => api!.setGatewayModelEnabled(model.id, enabled)); }} /></td><td><CopyValue value={model.alias} label={`本地模型名称 ${model.alias}`} onCopy={copy} /></td><td>{category === 'api' ? <CopyValue value={model.upstreamId} label={`上游模型名称 ${model.upstreamId}`} onCopy={copy} /> : ({ responses: 'Responses', 'chat-completions': 'Chat Completions', messages: 'Messages' })[model.wireApi]}</td><td><span className={`badge ${data.gateway.running && published(provider, model) ? 'positive' : 'neutral'}`}>{localModelStatus(data, provider, model)}</span></td></tr>)}</tbody></table>}</ModelListViewport> : <EmptyState compact icon={<Layers3 size={22} />} title="还没有模型" description="进入供应商管理，获取模型列表或手动添加。" action={<button className="button small secondary" onClick={() => onProvider(provider.id)}>管理供应商</button>} />}</div>}
      </article>;
    })}</div>{!providers.some(provider => providerCategory(provider) === category) && <p className="aggregate-empty-category">{search ? '此分类没有匹配项。' : category === 'api' ? '还没有 API 供应商。' : '还没有订阅供应商。'}</p>}</section>)}</div>
    {!providers.length && <EmptyState compact icon={<Search size={24} />} title={data.providers.length ? '没有匹配的供应商或模型' : '还没有供应商'} description={data.providers.length ? '试试其他名称。' : '从左侧添加 API 或订阅供应商。'} />}
  </section>;
}
