import type { Provider, ProviderInput } from '../shared/types';
import type { SettingsSnapshot } from '../shared/settings-types';
import { KeyRound, Server } from './MaterialIcon';

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
    <section className="form-info" aria-label="TRAE 账号接入"><KeyRound size={19} /><div>
      <strong>TRAE CN 订阅</strong>
      <p>{external ? '当前使用已有外部接口。可从本机 TRAE 或 TRAE SOLO 中国版重新导入已登录的账号。' : '从本机已登录的 TRAE 或 TRAE SOLO 中国版导入订阅账号。'}</p>
      <p>支持文本与工具调用；暂不支持 Claude Code 所需的输出预算。</p>
      <div className="subscription-import-actions"><button type="button" className="button small secondary" data-action="import-trae-account" disabled={pending} onClick={onImport}>从客户端导入</button></div>
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
