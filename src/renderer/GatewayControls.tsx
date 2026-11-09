import type { GatewayStatus } from '../shared/types';
import { Activity, Clock3, Copy, KeyRound, Power, Server, ShieldCheck } from './MaterialIcon';
import { BusyIcon, Toggle } from './components';

interface Props {
  gateway: GatewayStatus;
  port: string;
  setPort: (next: string) => void;
  savedPort?: number;
  autoStart?: boolean;
  setAutoStart: (next: boolean) => Promise<void>;
  toggle: () => Promise<void>;
  copyKey: () => Promise<void>;
  copyUrl: () => Promise<void>;
  busy: boolean;
  available: boolean;
  enabledModels: number;
}

const number = new Intl.NumberFormat('zh-CN');

export function GatewayControls({ gateway, port, setPort, savedPort, autoStart, setAutoStart, toggle, copyKey, copyUrl, busy, available, enabledModels }: Props) {
  const lastRequestError = gateway.lastRequestError;
  const requestSucceededAfterError = !!lastRequestError && Date.parse(gateway.lastSuccessfulRequestAt ?? '') > Date.parse(lastRequestError.time);
  return <section className="gateway-panel" data-gateway-panel>
    <div className="gateway-top"><span className={`gateway-icon ${gateway.running ? 'on' : ''}`}><Server size={26} /></span><div><h2>本地模型服务</h2><p>为工具提供本机模型 API。</p></div><span className={`badge ${gateway.running ? 'positive' : 'neutral'}`} data-gateway-service-status={gateway.running ? 'running' : 'stopped'}><span className="status-dot" />{gateway.running ? '正在运行' : '已停止'}</span></div>
    <div className="gateway-body">
      <div className="gateway-entry"><label>本机 API 入口</label><div className="endpoint-field"><code>{gateway.baseUrl || '启动服务后显示入口'}</code><button className="icon-button" disabled={!gateway.baseUrl} title="复制 API 入口" aria-label="复制 API 入口" onClick={() => void copyUrl()}><Copy size={16} /></button></div><div className="entry-meta"><span><ShieldCheck size={13} />仅监听 127.0.0.1</span><span><KeyRound size={13} />使用本地密钥验证</span><button className="text-button" onClick={() => void copyKey()} disabled={!available}>复制本地密钥<Copy size={12} /></button></div></div>
      <div className="gateway-control"><label htmlFor="service-port">服务端口</label><div className="port-control"><input id="service-port" aria-label="服务端口" type="number" min="1024" max="65535" disabled={gateway.running || busy} value={port} onChange={event => setPort(event.target.value)} /><button className={`button ${gateway.running ? 'secondary' : 'primary'}`} disabled={!available || busy} onClick={() => void toggle()} data-action="toggle-gateway"><BusyIcon active={busy}><Power size={16} /></BusyIcon>{gateway.running ? '停止服务' : '启动服务'}</button></div></div>
    </div>
    <div className="gateway-autostart settings-row" data-action="gateway-autostart"><div className="settings-row-copy"><strong>随应用启动本地服务</strong><small>下次启动时使用端口 {savedPort ?? gateway.port}。</small></div><div className="settings-control"><Toggle label="随应用启动本地服务" checked={autoStart ?? false} disabled={!available || autoStart === undefined || busy} onChange={value => void setAutoStart(value)} /></div></div>
    {gateway.lastError && <div className="gateway-error" data-gateway-service-error><Activity size={15} /><div><strong>服务错误</strong><p>{gateway.lastError}</p></div></div>}
    {lastRequestError && <div className="gateway-request-error" data-gateway-request-error data-request-error-status={lastRequestError.status} data-request-error-time={lastRequestError.time} data-success-after-error={requestSucceededAfterError}><Clock3 size={15} /><div><div className="gateway-request-error-heading"><strong>最近一次请求错误</strong><span className="badge neutral">HTTP {lastRequestError.status}</span></div><div className="gateway-request-error-meta"><time dateTime={lastRequestError.time}>{new Date(lastRequestError.time).toLocaleString('zh-CN', { hour12: false })}</time>{lastRequestError.endpoint && <code data-request-error-endpoint>{lastRequestError.endpoint}</code>}</div><p>{lastRequestError.message}</p><small>此错误只影响该次请求。{requestSucceededAfterError && <span data-gateway-request-success-after-error>此后已有请求成功。</span>}</small></div></div>}
    <div className="gateway-footer"><span>{number.format(gateway.requests)} 次服务请求</span><span><span className="tiny-dot" />{enabledModels} 个已启用模型</span></div>
  </section>;
}
