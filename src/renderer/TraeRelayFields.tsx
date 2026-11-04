import type { Provider, ProviderInput } from '../shared/types';
import { TRAE_RELAY_BASE_URL } from '../shared/presets';
import { ArrowUpRight, Power, Server } from './MaterialIcon';

export type TraeRelayDraft = Pick<ProviderInput, 'id' | 'baseUrl' | 'claudeBaseUrl' | 'relayMode'> & {
  apiKey: string;
  relayKeyFilled?: boolean;
};
const manualDefaultUrl = 'http://127.0.0.1:8000/v1';
export function managedRelayMode(draft: TraeRelayDraft) {
  return draft.relayMode === 'managed';
}

export function TraeRelayFields({ draft, saved, pending, onChange, onStart, onLogin, onStop }: {
  draft: TraeRelayDraft;
  saved?: Provider;
  pending: boolean;
  onChange: (patch: Partial<TraeRelayDraft>) => void;
  onStart: () => void;
  onLogin: () => void;
  onStop: () => void;
}) {
  const managed = managedRelayMode(draft);
  const switchingEndpoint = draft.baseUrl !== TRAE_RELAY_BASE_URL || !!draft.claudeBaseUrl;
  const switchMode = (mode: 'managed' | 'manual') => {
    if (mode === 'manual') {
      onChange({ relayMode: mode, relayKeyFilled: false, apiKey: draft.relayKeyFilled ? '' : draft.apiKey,
        baseUrl: !saved && !switchingEndpoint && (!draft.apiKey || draft.relayKeyFilled) ? manualDefaultUrl : draft.baseUrl });
    } else onChange({ relayMode: mode });
  };
  return <div data-trae-relay-mode={managed ? 'managed' : 'manual'}>
    <label className="form-field">反代连接方式
      <select value={managed ? 'managed' : 'manual'} onChange={event => switchMode(event.target.value as 'managed' | 'manual')}>
        <option value="managed">由 ModelDock 启动本机反代</option>
        <option value="manual">连接已有反代</option>
      </select>
    </label>
    {managed ? <section className="form-info trae-relay-guide" aria-label="本机反代">
      <Server size={18} /><div><strong>在这台电脑上使用 TRAE 中国版账号</strong>
        <p>先启动本机 Docker 的 Linux 容器引擎，再启动反代。首次启动需要下载镜像，成功后会将 <code>{TRAE_RELAY_BASE_URL}</code> 和反代密钥填入当前表单。</p>
        <p>打开 TRAE 授权页，在「账号与签到」中选择网页授权。首次使用时，按页面提示下载并运行本机授权助手（需要 Python 3），保持助手窗口打开，再登录一个自己的 TRAE 中国版账号。</p>
        {(saved?.hasSecret || Boolean(draft.apiKey)) && !draft.relayKeyFilled && <p>点击启动会填入托管实例的密钥，保存供应商后才会替换当前密钥。</p>}
        {switchingEndpoint && <p>当前连接指向其他地址。点击启动会将表单切换到上方的本机地址。</p>}
        <div className="row-actions">
          <button type="button" className="button small primary" data-action="start-trae-relay" disabled={pending} onClick={onStart}><Power size={14} />{switchingEndpoint ? '启动并改用本机反代' : '启动本机反代'}</button>
          <button type="button" className="button small secondary" data-action="login-trae-relay" disabled={pending || switchingEndpoint} onClick={onLogin}><ArrowUpRight size={14} />打开 TRAE 授权页</button>
          <button type="button" className="text-button" data-action="stop-trae-relay" disabled={pending || switchingEndpoint} onClick={onStop}>停止本机反代</button>
        </div>
        <p>完成授权后保存供应商，获取模型列表，再选一个模型测试连接。</p>
        <p role="status">{pending ? '正在操作本机反代…' : draft.relayKeyFilled ? '本机地址和反代密钥已填入。' : !switchingEndpoint && saved?.hasSecret ? '已保存反代密钥。' : '等待启动并填入反代密钥。'}</p>
      </div>
    </section> : <>
      <div className="preset-help"><Server size={16} /><p>在已有反代的管理页授权一个自己的 TRAE 中国版账号，然后填写它的本机回环地址和反代密钥。例如 <code>{manualDefaultUrl}</code>。</p></div>
      <label className="form-field">反代 API 地址<input type="url" placeholder={manualDefaultUrl} value={draft.baseUrl} onChange={event => onChange({ baseUrl: event.target.value, apiKey: '' })} /></label>
      <label className="form-field">反代 API Key<input type="password" autoComplete="new-password" placeholder={saved?.hasSecret && saved.baseUrl === draft.baseUrl ? '留空保留已保存的反代密钥' : '填写该反代的 API Key'} value={draft.apiKey} onChange={event => onChange({ apiKey: event.target.value })} />
        <small>反代服务签发此密钥。TRAE 账号只在授权页登录。</small>
      </label>
    </>}
  </div>;
}

export function TraeRelayDetails({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
  return <section className="form-info trae-relay-guide"><Server size={18} /><div><strong>TRAE 账号与反代</strong>
    <p>{provider.relayMode === 'managed' ? '此反代由 ModelDock 在本机管理。打开反代设置可启动、停止服务或打开授权页。' : '此连接使用手动配置的本机反代。请在该反代自己的管理页完成 TRAE 中国版账号授权。'}{provider.hasSecret ? '授权后获取模型列表，选择模型并测试连接。' : '请在反代设置中填入并保存反代密钥。'}</p>
    <div className="row-actions"><button type="button" className="button small secondary" data-action="configure-trae-relay" onClick={onEdit}>反代设置</button></div>
  </div></section>;
}
