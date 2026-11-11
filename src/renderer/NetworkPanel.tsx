// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { ModelDockApi } from '../shared/types';
import { MAX_NETWORK_BYPASS_ADDRESSES, type FlowBridgeSnapshot, type NetworkMode, type NetworkSample } from '../shared/flowbridge-types';
import { BusyIcon, Toggle, type Notify } from './components';
import { Activity, Check, ChevronDown, Download, Monitor, Plug2, RefreshCw, RotateCcw, Search, Unplug, X } from './MaterialIcon';
import { ProxySpeedPanel } from './ProxySpeedPanel';
import './network.css';
export const networkBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${Math.round(value)} B`;
type ChartWindow = { start: number; end: number };
export function NetworkChart({ samples, timeWindow }: { samples: NetworkSample[]; timeWindow?: ChartWindow }) {
  const max = Math.max(1, ...samples.flatMap(s => [s.uploadRate, s.downloadRate]));
  const points = (key: 'uploadRate' | 'downloadRate') => samples.map((sample, index) => {
    const offset = timeWindow ? (sample.time - timeWindow.start) / (timeWindow.end - timeWindow.start) : index / Math.max(1, samples.length - 1);
    return `${offset * 600},${94 - sample[key] / max * 86}`;
  }).join(' ');
  return <svg className="network-chart" viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="网络上传与下载速率曲线">
    <path d="M0 94H600 M0 50H600 M0 8H600" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" />
    <polyline points={points('downloadRate')} data-direction="download" fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <polyline points={points('uploadRate')} data-direction="upload" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
  </svg>;
}
interface NetworkProps {
  api?: ModelDockApi;
  snapshot?: FlowBridgeSnapshot;
  notify: Notify;
}
type NetworkControlProps = NetworkProps & { onChanged: () => Promise<void> };

function networkError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method 'modeldock:[^']+': (?:Error: )?/, '') : fallback;
}

function useNetworkAction(notify: Notify) {
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const action = async (name: string, run: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    try { await run(); }
    catch (e) { notify(networkError(e, '网络操作失败。'), 'error'); }
    finally { lock.current = false; setBusy(''); }
  };
  return { busy, action };
}

export function NetworkPreferences({ api, snapshot, onChanged, notify }: NetworkControlProps) {
  const { busy, action } = useNetworkAction(notify);
  if (!snapshot || !api) return <p className="settings-note">正在读取网络设置…</p>;
  const save = (patch: Parameters<ModelDockApi['saveNetworkSettings']>[0]) => action('save', async () => {
    await api.saveNetworkSettings(patch);
    await onChanged();
  });
  return <section className="settings-section"><h2 className="settings-heading">网络接管</h2><div className="panel">
    <div className="settings-row"><div className="settings-row-copy"><strong>随 ModelDock 自动连接</strong><small>上游未就绪时最多等待两分钟；手动断开会取消本次自动重试。登录启动沿用上方 ModelDock 开关。</small></div><Toggle label="随 ModelDock 自动连接网络" checked={snapshot.settings.autoConnect} disabled={!!busy} onChange={autoConnect => void save({ autoConnect })} /></div>
    <div className="settings-row"><div className="settings-row-copy"><strong>启动时自动查找代理</strong><small>先查找当前热点或本机代理，再按已选模式连接；保留现有端口，地址为空时使用 38473。查找失败时重试已保存的地址。</small></div><Toggle label="启动时自动查找代理" checked={snapshot.settings.autoDiscover} disabled={!!busy} onChange={autoDiscover => void save({ autoDiscover })} /></div>
    <div className="settings-row"><div className="settings-row-copy"><strong>启动时显示网速小窗</strong><small>使用同一个 ModelDock 进程和网络会话。</small></div><Toggle label="启动时显示网速小窗" checked={snapshot.settings.showMiniOnStart} disabled={!!busy} onChange={showMiniOnStart => void save({ showMiniOnStart })} /></div>
    {snapshot.platform === 'win32' && <div className="settings-row"><div className="settings-row-copy"><strong>全局模式解析</strong><small>快速解析保留虚拟地址映射；兼容解析经同一代理使用 DoH。保存后，已连接会话会先断开再重连。</small></div><select aria-label="全局模式解析" value={snapshot.settings.dnsMode} disabled={!!busy} onChange={e => void save({ dnsMode: e.target.value as 'fast' | 'compatible' })}><option value="fast">快速解析</option><option value="compatible">兼容解析</option></select></div>}
  </div></section>;
}
function NetworkTools({ api, snapshot, onChanged, notify }: Required<NetworkControlProps>) {
  const [draft, setDraft] = useState<{ address: string; mode: NetworkMode } | null>(null);
  const { address, mode } = draft ?? snapshot.settings;
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [bypassOpen, setBypassOpen] = useState(false);
  const [bypassDraft, setBypassDraft] = useState<string | null>(null);
  const bypassToggle = useRef<HTMLButtonElement>(null);
  const bypassInput = useRef<HTMLTextAreaElement>(null);
  const savedBypassText = snapshot.settings.bypassAddresses.join('\n');
  const bypassText = bypassDraft ?? savedBypassText;
  const windows = snapshot.platform === 'win32';
  const { busy, action } = useNetworkAction(notify);
  useEffect(() => {
    setCandidates(null);
  }, [snapshot.settings.address, snapshot.settings.mode]);
  useEffect(() => {
    if (bypassOpen) bypassInput.current?.focus();
  }, [bypassOpen]);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectLock = useRef(false);
  const connected = snapshot.state === 'connected';
  const starting = snapshot.state === 'connecting' || busy === 'connect' || busy === 'reconnect';
  const restoring = disconnecting || (snapshot.state === 'disconnecting' && !starting);
  const needsRecovery = snapshot.state === 'error' && !snapshot.status.cleanupConfirmed;
  const changing = restoring || starting;
  const dirty = address !== snapshot.settings.address || mode !== snapshot.settings.mode;
  const global = mode === 'global';
  const editingDisabled = !!busy || changing || needsRecovery;
  const canDiscover = !editingDisabled && (!windows || (!connected && snapshot.status.cleanupConfirmed));
  const canConnect = !editingDisabled && !!address.trim() && (!connected || dirty);
  const candidateAddress = (value: string) => windows ? value
    : `${global ? 'socks5' : 'http'}://${value.includes(':') ? `[${value}]` : value}:38473`;
  const discover = () => action('discover', async () => {
    setCandidates(null);
    const values = windows ? await api.networkLocalProxies() : await api.networkHotspotCandidates();
    setCandidates(values);
  });
  const stateLabel = { idle: '未连接', connecting: '连接中', connected: '已连接', disconnecting: '恢复中', error: '需要处理' }[snapshot.state];
  const change = (name: string, run: () => Promise<unknown>) => action(name, async () => {
    try { await run(); }
    finally { await onChanged(); }
    setDraft(current => current === draft ? null : current);
  });
  const rememberOffline = async (value: string, selectedMode: NetworkMode) => {
    const { settings } = await api.saveNetworkSettings({ address: value, mode: selectedMode }, { offlineOnly: true });
    await onChanged();
    setDraft(current => current === draft ? null : current);
    return settings.address;
  };
  const chooseCandidate = (value: string) => {
    if (windows) return action('candidate', () => rememberOffline(value, value.startsWith('socks5://') ? 'global' : 'http'));
    setDraft({ address: candidateAddress(value), mode });
  };
  const editAddress = (value: string) => {
    let nextMode = mode;
    if (windows && value.startsWith('socks5://')) nextMode = 'global';
    if (windows && value.startsWith('http://')) nextMode = 'http';
    setDraft({ address: value, mode: nextMode });
  };
  const selectMode = (option: NetworkMode) => {
    if (option === mode) return;
    if (dirty) {
      setDraft({ mode: option, address: address.replace(/^(?:http|socks5):\/\//, option === 'global' ? 'socks5://' : 'http://') });
      return;
    }
    return change(connected ? 'reconnect' : 'mode', () => api.saveNetworkSettings({ mode: option }));
  };
  const connect = () => change(connected ? 'reconnect' : 'connect', () =>
    connected ? api.saveNetworkSettings({ address, mode }) : api.connectNetwork({ address, mode }));
  const bypassReconnect = connected && snapshot.settings.mode === 'global';
  const saveBypass = () => action(bypassReconnect ? 'reconnect' : 'save-bypass', async () => {
    const bypassAddresses = bypassText.split('\n').map(address => address.trim()).filter(Boolean);
    try { await api.saveNetworkSettings({ bypassAddresses }); }
    finally { await onChanged(); }
    setBypassDraft(null);
    notify('直连白名单已保存。', 'success');
  });
  // Cancellation must reach the manager while its connection request is pending.
  const disconnect = async () => {
    if (disconnectLock.current) return;
    disconnectLock.current = true;
    setDisconnecting(true);
    try { await api.disconnectNetwork(); }
    catch (e) { notify(networkError(e, '网络恢复失败。'), 'error'); }
    finally {
      try { await onChanged(); }
      finally { disconnectLock.current = false; setDisconnecting(false); }
    }
  };
  const showConnect = !changing && !needsRecovery && (!connected || (dirty && !!address.trim()));
  const showDisconnect = changing || connected || needsRecovery;
  const disconnectLabel = restoring ? '正在恢复' : starting ? '取消连接' : needsRecovery ? '恢复网络' : '断开连接';
  const hint = snapshot.state === 'error' || snapshot.state === 'connecting' || snapshot.state === 'disconnecting' ? snapshot.message
    : dirty && connected ? '当前连接仍使用原地址。' : '';
  const offline = !connected && !changing && !needsRecovery;
  return <div className="network-tools">
    <section className="service-network-card" data-network-panel>
      <div className="gateway-top"><span className={`gateway-icon ${snapshot.state === 'connected' ? 'on' : ''}`}><Activity size={26} /></span><div><h2>网络接管</h2><p>{global ? '通过 SOCKS5 转发 TCP、UDP 和 DNS。' : '为桌面应用设置 HTTP / HTTPS 代理。'}</p></div><span className={`badge ${snapshot.state === 'connected' ? 'positive' : 'neutral'}`} data-network-service-status={snapshot.state} role="status"><span className="status-dot" />{stateLabel}</span></div>
      <div className="service-network-body">
        <div className="network-mode" role="group" aria-label="网络连接模式">{(['http', 'global'] as const).map(option => <button key={option} aria-pressed={mode === option} disabled={editingDisabled} onClick={() => void selectMode(option)}>{option === 'http' ? 'HTTP 代理' : '全局流量'}</button>)}</div>
        {global && <div className="network-bypass">
          <button ref={bypassToggle} type="button" className="network-bypass-toggle" data-action="toggle-network-bypass"
            aria-expanded={bypassOpen} aria-controls="network-bypass-editor" disabled={editingDisabled}
            onClick={() => setBypassOpen(open => !open)}>
            直连白名单<span>{snapshot.settings.bypassAddresses.length} 个地址</span><ChevronDown size={16} />
          </button>
          {bypassOpen && <div id="network-bypass-editor" className="network-bypass-editor">
            <p id="network-bypass-hint">每行一个 IPv4 或 IPv6 地址，最多 {MAX_NETWORK_BYPASS_ADDRESSES} 个。名单内地址的所有端口都走系统原有路由。{bypassReconnect && ' 保存时会重新连接全局代理。'}</p>
            <label className="sr-only" htmlFor="network-bypass-addresses">直连 IP 地址</label>
            <textarea ref={bypassInput} id="network-bypass-addresses" value={bypassText} rows={3} placeholder="192.168.1.20"
              disabled={editingDisabled} aria-describedby="network-bypass-hint" spellCheck={false} autoComplete="off"
              onChange={event => setBypassDraft(event.target.value)} />
            <div className="network-bypass-actions">
              <button type="button" className="button small secondary" disabled={editingDisabled} onClick={() => {
                setBypassDraft(null); setBypassOpen(false); bypassToggle.current?.focus();
              }}>取消</button>
              <button type="button" className="button small primary" data-action="save-network-bypass"
                disabled={editingDisabled || bypassText === savedBypassText} onClick={() => void saveBypass()}>保存白名单</button>
            </div>
          </div>}
        </div>}
        <div className="network-address-heading">
          <label htmlFor="network-address">上游代理</label>
          <button type="button" className="network-lookup" data-action="discover-network-proxy" disabled={!canDiscover}
            title={windows && connected ? '断开后可查找本机代理' : undefined} onClick={() => void discover()}>
            <BusyIcon active={busy === 'discover'}><Search size={15} /></BusyIcon>{busy === 'discover' ? '正在查找…' : windows ? '查找本机代理' : '查询热点地址'}
          </button>
        </div>
        <div className="network-address">
          <input id="network-address" value={address} placeholder={`${global ? 'socks5' : 'http'}://${windows ? '127.0.0.1:端口' : '手机IP:38473'}`}
            disabled={editingDisabled} spellCheck={false} autoComplete="off" onChange={e => editAddress(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && canConnect) void connect(); }} />
          {dirty && <button type="button" className="network-revert" title="还原输入" aria-label="还原输入" disabled={editingDisabled}
            onClick={() => setDraft(null)}><RotateCcw size={15} /></button>}
        </div>
        {offline && dirty && !address && snapshot.settings.address && <button className="text-button network-clear" disabled={editingDisabled}
          onClick={() => void action('clear', () => rememberOffline('', mode))}>清除已记住的地址</button>}
        {candidates && canDiscover && <div className="network-candidates" role="status">
          <span>{candidates.length ? (windows ? '本机代理' : '热点候选') : (windows ? '未发现本机代理，请手动填写地址和端口。' : '未找到热点网关，请手动填写手机地址。')}</span>
          {candidates.map(value => <button key={value} type="button" className="network-candidate" aria-pressed={address === candidateAddress(value)}
            title={windows ? `使用 ${value}` : `填入 ${candidateAddress(value)}`} onClick={() => void chooseCandidate(value)}>
            {address === candidateAddress(value) && <Check size={14} />}{value}
          </button>)}
        </div>}
        {hint && <p className="network-hint" role="status">{hint}</p>}
        <div className="network-control-footer">
          <div className="network-session-actions">
            {showConnect && <button className="button primary" data-action="connect-network" disabled={!canConnect} onClick={() => void connect()}>
              {connected ? <RefreshCw size={16} /> : <Plug2 size={16} />}{connected ? '重新连接' : '连接'}
            </button>}
            {showDisconnect && <button className={`button ${needsRecovery ? 'primary' : 'secondary'}`} data-action="disconnect-network" disabled={restoring} onClick={() => void disconnect()}>
              <BusyIcon active={restoring}>{starting ? <X size={16} /> : needsRecovery ? <RotateCcw size={16} /> : <Unplug size={16} />}</BusyIcon>{disconnectLabel}
            </button>}
          </div>
          <button className="button secondary network-mini-launch" data-action="show-network-mini" onClick={() => void api.showNetworkMini().catch(e => notify(networkError(e, '无法打开网速小窗。'), 'error'))}>
            <Monitor size={16} />网速小窗
          </button>
        </div>
      </div>
    </section>
    <ProxySpeedPanel api={api} address={offline ? address : snapshot.settings.address} mode={offline ? mode : snapshot.settings.mode}
      networkState={restoring ? 'disconnecting' : starting ? 'connecting' : snapshot.state} needsRecovery={needsRecovery}
      prepareAddress={offline && dirty ? () => rememberOffline(address, mode) : undefined} />
    <TrafficPanel snapshot={snapshot} />
    {!windows && <PhoneProxyPanel api={api} notify={notify} />}
  </div>;
}

function TrafficPanel({ snapshot }: { snapshot: FlowBridgeSnapshot }) {
  const [range, setRange] = useState<1 | 5 | 15 | 60>(1);
  const end = Date.now();
  const start = end - range * 60_000;
  const samples = snapshot.history.filter(s => s.time >= start && s.time <= end).sort((a, b) => a.time - b.time);
  const latest = snapshot.state === 'connected' ? snapshot.history.at(-1) : undefined;
  const peak = Math.max(0, ...samples.flatMap(s => [s.uploadRate, s.downloadRate]));
  return <section className="panel traffic-panel" aria-label="网络流量">
    <div className="section-heading">
      <h2>网络流量</h2>
      <select className="traffic-range" aria-label="流量时间范围" value={range} onChange={event => setRange(Number(event.target.value) as 1 | 5 | 15 | 60)}>
        {([1, 5, 15, 60] as const).map(minutes => <option key={minutes} value={minutes}>最近{minutes === 60 ? '1小时' : minutes + '分钟'}</option>)}
      </select>
    </div>
    <div className="network-metrics">
      <div data-direction="upload"><small>↑ 上传</small><strong>{networkBytes(latest?.uploadRate ?? 0)}/s</strong><span>本次 {networkBytes(snapshot.status.uploadBytes)}</span></div>
      <div data-direction="download"><small>↓ 下载</small><strong>{networkBytes(latest?.downloadRate ?? 0)}/s</strong><span>本次 {networkBytes(snapshot.status.downloadBytes)}</span></div>
    </div>
    <figure className="traffic-history">
      <div className="traffic-graph">
        <div className="traffic-y-axis" aria-label="速率刻度">
          {[1, .5, 0].map(scale => <span key={scale}>{networkBytes(Math.max(1, peak) * scale)}/s</span>)}
        </div>
        <div className="traffic-plot">
          <NetworkChart samples={samples} timeWindow={{ start, end }} />
          {!samples.length && <span className="traffic-empty">暂无流量样本</span>}
        </div>
      </div>
      <figcaption>
        {[0, 1 / 3, 2 / 3, 1].map(position => <time key={position} dateTime={new Date(start + (end - start) * position).toISOString()}>{new Date(start + (end - start) * position).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(range === 1 ? { second: '2-digit' } : {}), hour12: false })}</time>)}
      </figcaption>
    </figure>
    <div className="traffic-footer">
      <div className="traffic-legend"><span data-direction="upload">上传</span><span data-direction="download">下载</span></div>
      <span>活动连接 {snapshot.status.connections}</span>
    </div>
  </section>;
}

function PhoneProxyPanel({ api, notify }: { api: ModelDockApi; notify: Notify }) {
  const { busy, action } = useNetworkAction(notify);
  const exportScript = () => action('export', async () => {
    if (await api.exportPhoneProxy()) notify('手机脚本已导出，请在手机 Termux 中执行。', 'success');
  });
  return <section className="panel phone-proxy-panel" aria-label="手机热点代理">
    <div className="section-heading">
      <div className="phone-proxy-copy">
        <h2>手机热点代理</h2>
        <p>在手机 Termux 中运行导出的脚本。使用手机 VPN 时，请允许 Termux 联网。</p>
        <p>默认端口 38473，支持 HTTP、SOCKS5 和 UDP。</p>
      </div>
      <button className="button secondary" disabled={!!busy} onClick={() => void exportScript()}><Download size={15} />导出手机脚本</button>
    </div>
  </section>;
}

export function NetworkWorkspace({ api, snapshot, onChanged, notify, error }: NetworkControlProps & { error: string }) {
  return <div className="network-workspace" data-network-workspace>
    {error && <p className="bridge-banner" role="alert">{error}</p>}
    {snapshot && api ? <NetworkTools api={api} snapshot={snapshot} onChanged={onChanged} notify={notify} /> : !error && <p className="settings-note" role="status">{api ? '正在读取网络状态…' : '等待桌面连接'}</p>}
  </div>;
}
