import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, Copy, Info, Pencil, Power, RefreshCw } from './MaterialIcon';
import type { ModelDockApi } from '../shared/types';
import type { ProviderDuplicateGroup, ProviderMergeResult } from '../shared/provider-duplicates';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';

interface Props {
  api?: ModelDockApi;
  notify: Notify;
  gatewayRunning: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onEdit: (id: string) => void;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ProviderDuplicates({ api, notify, gatewayRunning, onClose, onChanged, onEdit }: Props) {
  const [groups, setGroups] = useState<ProviderDuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [merged, setMerged] = useState<ProviderMergeResult | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const lock = useRef(false);

  const load = useCallback(async () => {
    const revision = ++generation.current;
    setLoading(true); setError('');
    try {
      if (!api) throw new Error('桌面应用尚未连接。');
      const next = await api.listProviderDuplicates();
      if (mounted.current && revision === generation.current) setGroups(next);
    } catch (failure) {
      if (mounted.current && revision === generation.current) setError(errorText(failure));
    } finally { if (mounted.current && revision === generation.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; ++generation.current; };
  }, [load]);

  const merge = async (group: ProviderDuplicateGroup) => {
    if (lock.current || !api || !group.canMerge || gatewayRunning) return;
    lock.current = true; setBusy(group.targetProviderId); setError('');
    try {
      const result = await api.mergeProviderDuplicates(group.providerIds, group.fingerprint);
      if (!mounted.current) return;
      setMerged(result);
      await onChanged(); await load();
      notify(`已合并 ${result.removedProviderIds.length + 1} 条供应商记录，模型和别名已保留。`);
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const stopGateway = async () => {
    if (lock.current || !api) return;
    lock.current = true; setBusy('gateway'); setError('');
    try { await api.stopGateway(); await onChanged(); }
    catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };

  return <Modal wide title="整理重复供应商" subtitle="核对同名、同地址的 API 来源，再合并已有记录。" onClose={busy ? () => {} : onClose}>
    <div className="modal-body provider-duplicates-body">
      <div className="provider-duplicate-info"><Info size={17} /><span>合并前会备份数据库。保留所有模型 ID、别名、能力设置和用量历史，工具仍使用合并前可用的模型。同一上游模型的不同别名也会保留。</span></div>
      {gatewayRunning && <div className="provider-duplicate-warning"><span>请先停止本地服务，再合并供应商。</span><button type="button" className="button small secondary" disabled={!!busy} onClick={() => void stopGateway()}><BusyIcon active={busy === 'gateway'}><Power size={14} /></BusyIcon>停止服务</button></div>}
      {!!error && <div className="provider-duplicate-warning" role="alert"><span>{error}</span></div>}
      {!!merged && <div className="provider-duplicate-success" role="status"><CheckCheck size={17} /><div><strong>重复供应商已合并</strong><small>备份：{merged.backupPath}</small></div></div>}
      {loading ? <EmptyState compact icon={<RefreshCw size={23} className="spin" />} title="正在核对重复记录" description="凭据只在本机后台比较，不会显示在界面中。" /> : groups.length ? groups.map(group => <section className="provider-duplicate-group" key={group.providerIds.join('|')}>
        <div className="provider-duplicate-heading"><div><strong>{group.name}</strong><code>{group.baseUrl || '地址未设置'}</code></div><span className="badge neutral">{group.providers.length} 条记录 · {group.totalModels} 个模型</span></div>
        <ul className="provider-duplicate-members">{group.providers.map((provider, index) => <li key={provider.id}><div><strong>{provider.name} · 记录 {index + 1}</strong><span>{provider.hasSecret ? '凭据已保存' : '未配置凭据'} · {provider.modelCount} 个模型 · {provider.enabled ? '已启用' : '已停用'}</span></div>{provider.id === group.targetProviderId && <span className="badge positive">保留记录</span>}<button type="button" className="icon-button" disabled={!!busy} title="编辑这条供应商" aria-label={`编辑供应商 ${provider.id}`} onClick={() => onEdit(provider.id)}><Pencil size={15} /></button></li>)}</ul>
        <div className={`provider-duplicate-message ${group.canMerge ? '' : 'blocked'}`}>{group.message}</div>
        {!!group.affectedTools.length && <div className="provider-duplicate-tools">{group.affectedTools.map(tool => <span key={tool.id}>{tool.name}：保留 {tool.beforeModels} 个可用模型</span>)}<small>只选择部分重复来源的工具，会保留原模型范围；以后可重新选择供应商。</small></div>}
        <div className="provider-duplicate-actions"><span>合并为 1 条供应商，{group.totalModels} 个模型别名保持可用。</span><button type="button" className="button primary" data-action="merge-provider-duplicates" disabled={!!busy || loading || !group.canMerge || gatewayRunning} onClick={() => void merge(group)}><BusyIcon active={busy === group.targetProviderId}><Copy size={15} /></BusyIcon>合并这组记录</button></div>
      </section>) : !error && <EmptyState compact icon={<CheckCheck size={25} />} title={merged ? '重复供应商已整理' : '没有重复供应商'} description="不同名称的账号会分别保留。" />}
    </div>
    <div className="modal-footer"><button type="button" className="button secondary" disabled={!!busy || loading} onClick={() => void load()}><RefreshCw size={14} />重新检查</button><button type="button" className="button primary" disabled={!!busy} onClick={onClose}>关闭</button></div>
  </Modal>;
}
