import { useEffect, useState } from 'react';
import type { ModelDockApi, Provider } from '../shared/types';
import type { ModelMetadataField, ParameterPreview, ParameterValue } from '../shared/catalog-types';
import { BusyIcon, Modal, type Notify } from './components';
import { Check, RefreshCw } from './MaterialIcon';

export const parameterLabels: Record<ModelMetadataField, string> = {
  contextWindow: '上下文', maxInputTokens: '输入上限', maxOutputTokens: '输出预算', tools: '工具调用', vision: '图片输入',
  thinking: '思考能力', reasoningEfforts: '思考等级', defaultReasoningEffort: '默认强度', reasoningEffortFormat: '思考格式',
  adaptiveThinking: '自适应思考', minThinkingBudget: '最低思考预算', maxThinkingBudget: '最高思考预算',
};
function display(value: ParameterValue): string {
  if (value === null || value === 0 || Array.isArray(value) && !value.length) return '未设置';
  if (Array.isArray(value)) return value.join(' / ');
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : value;
}

export function ModelParameters({ api, provider, notify, onClose, onChanged }: {
  api?: ModelDockApi; provider: Provider; notify: Notify; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<ParameterPreview>();
  const [replace, setReplace] = useState(false);
  const [includeManufacturer, setIncludeManufacturer] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [request, reload] = useState(0), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(undefined); setError(''); setExcluded(new Set());
    if (!api) { setError('桌面应用尚未连接。'); return; }
    api.previewModelParameters(provider.id, includeManufacturer).then(value => { if (active) setPreview(value); })
      .catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [api, provider.id, request, includeManufacturer]);
  const mode = replace ? 'all' : 'missing';
  const rows = preview?.rows.filter(row => row[mode].length) ?? [];
  const selected = rows.filter(row => !excluded.has(row.id));
  async function apply() {
    if (!api || !preview || saving || !selected.length) return;
    setSaving(true); setError('');
    try {
      const count = await api.applyModelParameters(provider.id, preview.token, selected.map(row => row.id), replace);
      notify(`已更新 ${count} 个模型的参数。请在使用这些模型的工具中点击「重新同步」。`);
      await onChanged(); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '应用失败，请重新检查。'); }
    finally { setSaving(false); }
  }
  return <Modal wide title="补全模型参数" subtitle={provider.name} onClose={() => { if (!saving) onClose(); }}>
    <div className="modal-body parameter-preview">
      {provider.kind === 'openai-compatible' && provider.presetId === 'custom' && !provider.nativeAdapter && <label className="parameter-mode"><input type="checkbox" checked={includeManufacturer} disabled={saving} onChange={event => setIncludeManufacturer(event.target.checked)} />目录缺少参数时，参考同名模型的原厂规格</label>}
      {preview?.catalogError && <p role="status">本次使用本地字典。{preview.catalogError}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!preview && !error && <p role="status">正在核对供应商目录与本地参数字典…</p>}
      {preview && <>
        <label className="parameter-mode"><input type="checkbox" checked={replace} disabled={saving} onChange={event => setReplace(event.target.checked)} />同时校准已填写的参数和能力开关</label>
        <p>{`已检查 ${preview.total} 个模型，${rows.length} 个有可应用的参数。`}{!replace && !rows.length && preview.rows.some(row => row.all.length) && ' 勾选校准可查看已填写参数的差异。'}</p>
        {rows.map(row => <section key={row.id} className="parameter-row">
          <label><input type="checkbox" checked={!excluded.has(row.id)} disabled={saving} onChange={() => setExcluded(old => {
            const next = new Set(old); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next;
          })} />{row.name}{row.name !== row.upstreamId && <small>{row.upstreamId}</small>}</label>
          <table><thead><tr><th>参数</th><th>当前值</th><th>应用后</th><th>来源</th></tr></thead><tbody>
            {row[mode].map(change => <tr key={change.field}><td>{parameterLabels[change.field]}</td><td>{display(change.before)}</td><td>{display(change.after)}</td>
              <td title={change.source === 'dictionary' ? row.reference?.url : undefined}>{change.source === 'catalog' ? '供应商目录' : change.source === 'protocol' ? '当前接口' : `${row.reference?.manufacturer ? '原厂参考' : '内置字典'} · ${row.reference?.checked ?? ''}`}</td></tr>)}
          </tbody></table>
        </section>)}
      </>}
    </div>
    <div className="modal-footer"><button className="button secondary" disabled={saving || !preview && !error} onClick={() => reload(n => n + 1)}><RefreshCw size={14}/>重新检查</button>
      <button className="button primary" data-action="apply-model-parameters" disabled={!selected.length || saving} onClick={() => void apply()}><BusyIcon active={saving}><Check size={14}/></BusyIcon>应用到 {selected.length} 个模型</button></div>
  </Modal>;
}
