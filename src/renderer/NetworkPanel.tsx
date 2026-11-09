// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { ModelDockApi } from '../shared/types';
import { type FlowBridgeSnapshot, type NetworkMode, type NetworkSample } from '../shared/flowbridge-types';
import { Toggle, type Notify } from './components';
import { Activity } from './MaterialIcon';
import { ProxySpeedPanel } from './ProxySpeedPanel';
import './network.css';
export const networkBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${Math.round(value)} B`;
export function NetworkChart({ samples }: { samples: NetworkSample[] }) {
  const max = Math.max(1, ...samples.flatMap(s => [s.uploadRate, s.downloadRate]));
  const points = (key: 'uploadRate' | 'downloadRate') => samples.map((s, i) => `${i * 600 / Math.max(1, samples.length - 1)},${94 - s[key] / max * 86}`).join(' ');
  return <svg className="network-chart" viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="网络上传与下载速率曲线">
    <path d="M0 94H600 M0 50H600 M0 8H600" stroke="var(--line)" strokeWidth="1" fill="none" />
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

function useNetworkAction(notify: Notify) {
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const action = async (name: string, run: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    try { await run(); }
    catch (e) { notify(e instanceof Error ? e.message : '网络操作失败。', 'error'); }
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
    <div className="settings-row"><div className="settings-row-copy"><strong>随 ModelDock 自动连接</strong><small>默认关闭。上游未就绪时最多等待两分钟；登录启动沿用上方 ModelDock 开关。</small></div><Toggle label="随 ModelDock 自动连接网络" checked={snapshot.settings.autoConnect} disabled={!!busy} onChange={autoConnect => void save({ autoConnect })} /></div>
    <div className="settings-row"><div className="settings-row-copy"><strong>启动时显示网速小窗</strong><small>使用同一个 ModelDock 进程和网络会话。</small></div><Toggle label="启动时显示网速小窗" checked={snapshot.settings.showMiniOnStart} disabled={!!busy} onChange={showMiniOnStart => void save({ showMiniOnStart })} /></div>
    {snapshot.platform === 'win32' && <div className="settings-row"><div className="settings-row-copy"><strong>全局模式解析</strong><small>快速解析保留虚拟地址映射；兼容解析经同一代理使用 DoH。保存后，已连接会话会先断开再重连。</small></div><select aria-label="全局模式解析" value={snapshot.settings.dnsMode} disabled={!!busy} onChange={e => void save({ dnsMode: e.target.value as 'fast' | 'compatible' })}><option value="fast">快速解析</option><option value="compatible">兼容解析</option></select></div>}
  </div></section>;
}
function NetworkControls({ api, snapshot, onChanged, notify }: Required<NetworkControlProps>) {
  const [address, setAddress] = useState(snapshot.settings.address);
  const [mode, setMode] = useState<NetworkMode>(snapshot.settings.mode);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const windows = snapshot.platform === 'win32';
  const { busy, action } = useNetworkAction(notify);
  useEffect(() => {
    setAddress(snapshot.settings.address);
    setMode(snapshot.settings.mode);
    setCandidates(null);
  }, [snapshot.settings.address, snapshot.settings.mode]);
  const connecting = snapshot.state === 'connecting' || snapshot.state === 'disconnecting';
  const dirty = address !== snapshot.settings.address || mode !== snapshot.settings.mode;
  const global = mode === 'global';
  const canDiscover = !busy && !connecting && (!windows || snapshot.status.cleanupConfirmed);
  const discover = () => action('discover', async () => {
    setCandidates(null);
    const values = windows ? await api.networkLocalProxies() : await api.networkHotspotCandidates();
    setCandidates(values);
  });
  const stateLabel = { idle: '未连接', connecting: '连接中', connected: '已连接', disconnecting: '恢复中', error: '需要处理' }[snapshot.state];
  const change = (name: string, run: () => Promise<unknown>) => action(name, async () => {
    try { await run(); }
    finally { await onChanged(); }
  });
  const applyAddress = (value: string, selectedMode: NetworkMode) => change('apply', async () => {
    const { settings } = await api.saveNetworkSettings({ address: value, mode: selectedMode });
    setAddress(settings.address);
    setMode(settings.mode);
    setCandidates(null);
  });
  const chooseCandidate = (value: string) => {
    if (windows) return applyAddress(value, value.startsWith('socks5://') ? 'global' : 'http');
    setAddress(`${global ? 'socks5' : 'http'}://${value.includes(':') ? `[${value}]` : value}:38473`);
  };
  const editAddress = (value: string) => {
    setAddress(value);
    if (windows && value.startsWith('socks5://')) setMode('global');
    if (windows && value.startsWith('http://')) setMode('http');
  };
  const selectMode = (option: NetworkMode) => {
    if (windows && dirty) {
      setMode(option);
      setAddress(address.replace(/^(?:http|socks5):\/\//, option === 'global' ? 'socks5://' : 'http://'));
      return;
    }
    return change('mode', () => api.saveNetworkSettings({ mode: option }));
  };
  const connect = () => change('connect', async () => {
    const { settings } = await api.connectNetwork(windows && dirty ? { address, mode } : undefined);
    setAddress(settings.address);
    setMode(settings.mode);
  });
  const disconnect = async () => {
    try { await api.disconnectNetwork(); }
    catch (e) { notify(e instanceof Error ? e.message : '网络恢复失败。', 'error'); }
    finally { await onChanged(); }
  };
  return <section className="service-network-card" data-network-panel>
    <div className="gateway-top"><span className={`gateway-icon ${snapshot.state === 'connected' ? 'on' : ''}`}><Activity size={26} /></span><div><h2>网络接管</h2><p>{global ? '通过 SOCKS5 转发 TCP、UDP 和 DNS。' : '为桌面应用设置 HTTP / HTTPS 代理。'}</p></div><span className={`badge ${snapshot.state === 'connected' ? 'positive' : 'neutral'}`} data-network-service-status={snapshot.state} role="status"><span className="status-dot" />{stateLabel}</span></div>
    <div className="service-network-body">
      <div className="network-mode" role="group" aria-label="网络连接模式">{(['http', 'global'] as const).map(option => <button key={option} aria-pressed={mode === option} disabled={!!busy || connecting || (!windows && dirty)} onClick={() => void selectMode(option)}>{option === 'http' ? 'HTTP 代理' : '全局流量'}</button>)}</div>
      <label className="network-address-label" htmlFor="network-address">上游代理</label>
      <div className="network-address">
        <input id="network-address" value={address} placeholder={`${global ? 'socks5' : 'http'}://${windows ? '127.0.0.1:端口' : '手机IP:38473'}`} disabled={!!busy || connecting} onChange={e => editAddress(e.target.value)} />
        {!windows && <button className="button small secondary" data-action="save-network-address" disabled={!!busy || connecting || !dirty} onClick={() => void applyAddress(address, mode)}>保存</button>}
        {windows && dirty && <button className="button small secondary" disabled={!!busy || connecting || (snapshot.state === 'connected' && !address)} onClick={() => void applyAddress(address, mode)}>{!address ? '清除地址' : snapshot.state === 'connected' ? '应用并重连' : '应用'}</button>}
      </div>
      <div className="network-actions"><button className="button primary" data-action="connect-network" disabled={!!busy || snapshot.state === 'connected' || connecting || (!windows && dirty) || !address.trim()} onClick={() => void connect()}>连接</button>
        <button className="button secondary" data-action="disconnect-network" disabled={snapshot.state === 'disconnecting' || (snapshot.state === 'idle' && busy !== 'connect')} onClick={() => void disconnect()}>{connecting ? '取消并恢复' : '断开 / 恢复'}</button>
        <button className="text-button" onClick={() => void action('mini', () => api.showNetworkMini())} data-action="show-network-mini">网速小窗</button></div>
      <button className="text-button network-hotspot" data-action="discover-network-proxy" disabled={!canDiscover} onClick={() => void discover()}>{busy === 'discover' ? '正在查找…' : windows ? '查找本机代理' : '查询热点地址'}</button>
      {candidates && canDiscover && <div className="network-candidates" role="status">
        {candidates.length ? (windows ? '选择代理' : '网关候选') : (windows ? '未发现可用的本机代理。可手动填写代理软件显示的地址和端口。' : '未找到默认网关，请手动填写手机地址。')}
        {candidates.map(value => <button className="button small secondary" key={value} onClick={() => void chooseCandidate(value)}>{windows ? `应用 ${value}` : value}</button>)}
      </div>}
      {dirty && windows && <button className="text-button" onClick={() => { setAddress(snapshot.settings.address); setMode(snapshot.settings.mode); }}>还原输入</button>}
      <p className="network-hint" role="status">{dirty && !windows ? '地址尚未保存。请先保存，再连接或切换模式。' : snapshot.message || (global ? snapshot.platform === 'linux' ? 'Linux deb 版包含全局模式。首次连接需系统授权，上游请填写远端 IP。' : 'Windows 全局模式需要以管理员身份运行。' : windows ? '填写或应用代理地址后，点击连接。' : '保存上游地址，然后点击连接。')}</p>
    </div>
  </section>;
}

function NetworkTools({ api, snapshot, notify }: Required<NetworkProps>) {
  const { action } = useNetworkAction(notify);
  const [range, setRange] = useState<'minute' | 'day'>('minute');
  const connected = snapshot.state === 'connected';
  const latest = snapshot.history.at(-1);
  const samples = snapshot.history.filter(s => s.time >= Date.now() - (range === 'minute' ? 60_000 : 86_400_000)).sort((a, b) => a.time - b.time);
  return <>
    <div className="panel"><div className="section-heading"><h2>网络流量</h2><select aria-label="流量时间范围" value={range} onChange={e => setRange(e.target.value as 'minute' | 'day')}><option value="minute">最近 60 秒</option><option value="day">最近 24 小时</option></select></div>
      <div className="network-metrics"><div data-direction="upload"><small>↑ 上传</small><strong>{networkBytes(connected ? latest?.uploadRate ?? 0 : 0)}/s</strong><span>本次 {networkBytes(snapshot.status.uploadBytes)}</span></div><div data-direction="download"><small>↓ 下载</small><strong>{networkBytes(connected ? latest?.downloadRate ?? 0 : 0)}/s</strong><span>本次 {networkBytes(snapshot.status.downloadBytes)}</span></div><div><small>活动连接</small><strong>{snapshot.status.connections}</strong><span>统计当前代理会话</span></div></div>
      <NetworkChart samples={samples} /><p className="network-hint">24 小时历史按分钟采样。</p>
    </div>
    <ProxySpeedPanel key={snapshot.settings.address} api={api} address={snapshot.settings.address} networkState={snapshot.state} />
    {snapshot.platform !== 'win32' && <div className="panel"><div className="section-heading"><div><h2>手机热点代理</h2><p>导出 FlowBridge Termux 安装器，在手机 Termux 手动执行；默认端口 38473，支持 HTTP、SOCKS5 与 UDP。</p></div><button className="button secondary" onClick={() => void action('export', async () => { const path = await api.exportPhoneProxy(); if (path) notify('手机脚本已导出，请在手机 Termux 中执行。', 'success'); })}>导出手机脚本</button></div><p className="network-hint">手机 VPN 须允许 Termux 联网。仅导出文件，不会连接手机或修改其配置。</p></div>}
  </>;
}

export function NetworkWorkspace({ api, snapshot, onChanged, notify, error }: NetworkControlProps & { error: string }) {
  return <div className="network-workspace" data-network-workspace>
    {error && <p className="bridge-banner" role="alert">{error}</p>}
    {snapshot && api ? <div className="network-tools">
      <NetworkControls api={api} snapshot={snapshot} onChanged={onChanged} notify={notify} />
      <NetworkTools api={api} snapshot={snapshot} notify={notify} />
    </div> : !error && <p className="settings-note" role="status">{api ? '正在读取网络状态…' : '等待桌面连接'}</p>}
  </div>;
}
