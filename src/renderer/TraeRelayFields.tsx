import type { Provider, ProviderInput } from '../shared/types';
import type { SettingsSnapshot } from '../shared/settings-types';
import { ArrowDownToLine, Server } from './MaterialIcon';

export type TraeRelayDraft = Pick<ProviderInput, 'id' | 'baseUrl' | 'claudeBaseUrl' | 'relayMode'> & {
  apiKey: string;
  relayKeyFilled?: boolean;
};
export function managedRelayMode(draft: TraeRelayDraft) { return draft.relayMode === 'managed'; }

export function TraeRelayFields({ draft, saved, pending, onChange, onImport }: {
  draft: TraeRelayDraft; saved?: Provider; pending: boolean;
  platform?: SettingsSnapshot['platform'];
  onChange: (patch: Partial<TraeRelayDraft>) => void;
  onImport: () => void;
}) {
  const external = saved?.relayMode === 'manual' && draft.relayMode === 'manual';
  return <div data-trae-relay-mode={external ? 'manual' : 'managed'}>
    <section className="form-info trae-relay-guide" aria-label="TRAE 账号接入"><Server size={18} /><div>
      <strong>使用本机 TRAE 中国版账号</strong>
      <p>在 TRAE 中国版或 TRAE SOLO 中国版登录，再从授权中心导入。账号由 ModelDock 网关直接转发，生成内容会及时返回。</p>
      <p>导入后获取账号可用模型，再选择模型测试连接。使用时保持 ModelDock 和本地网关运行。</p>
      <p>当前已核实文本与函数工具调用。Claude Code 必需的输出预算暂不兼容；其他客户端传入尚未支持的图片或生成参数时会明确提示。</p>
      <button type="button" className="button small primary" data-action="import-trae-account" disabled={pending} onClick={onImport}><ArrowDownToLine size={14} />从客户端导入</button>
      <p role="status">{saved?.nativeAdapter === 'trae' ? '已接入内置适配器，可重新导入更新登录状态。' : external ? '当前保留已有外部接口。重新导入账号后使用内置适配器。' : '导入账号后自动保存连接，无需单独启动反代。'}</p>
    </div></section>
    {external && <>
      <label className="form-field">已有外部接口地址<input type="url" value={draft.baseUrl} onChange={event => onChange({ baseUrl: event.target.value, apiKey: '' })} /></label>
      <label className="form-field">已有接口 API Key<input type="password" autoComplete="new-password" placeholder="留空保留已保存的密钥" value={draft.apiKey} onChange={event => onChange({ apiKey: event.target.value })} /></label>
    </>}
  </div>;
}

export function TraeRelayDetails({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
  return <section className="form-info trae-relay-guide"><Server size={18} /><div><strong>TRAE 账号接入</strong>
    <p>{provider.nativeAdapter === 'trae' ? '此账号通过内置适配器接入 ModelDock 网关。登录过期时请从客户端重新导入。' : '请在授权中心从客户端重新导入，使用内置适配器接入网关。'}</p>
    <button type="button" className="button small secondary" data-action="configure-trae-relay" onClick={onEdit}>账号设置</button>
  </div></section>;
}
