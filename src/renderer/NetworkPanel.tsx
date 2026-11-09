// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { ModelDockApi } from '../shared/types';
import { NETWORK_SITES, type FlowBridgeSnapshot, type NetworkCheck, type NetworkSample, type NetworkSite } from '../shared/flowbridge-types';
import { Toggle, type Notify } from './components';
import './network.css';
export const networkBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${Math.round(value)} B`;
export function NetworkChart({ samples }: { samples: NetworkSample[] }) {
  const max = Math.max(1, ...samples.flatMap(s => [s.uploadRate, s.downloadRate]));
  const points = (key: 'uploadRate' | 'downloadRate') => samples.map((s, i) => `${i * 600 / Math.max(1, samples.length - 1)},${94 - s[key] / max * 86}`).join(' ');
  return <svg className="network-chart" viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="网络上传与下载速率曲线"><path d="M0 94H600 M0 50H600 M0 8H600" stroke="var(--border)" strokeWidth="1" fill="none" /><polyline points={points('downloadRate')} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" /><polyline points={points('uploadRate')} fill="none" stroke="var(--success)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}
function useNetwork(api?: ModelDockApi) {
  const [snapshot, setSnapshot] = useState<FlowBridgeSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api?.networkSnapshot) return;
    let mounted = true, pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const value = await api.networkSnapshot(); if (mounted) { setSnapshot(value); setError(''); } } catch { if (mounted) setError('无法读取网络状态。'); } finally { pending = false; } };
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => { mounted = false; clearInterval(timer); };
  }, [api]);
  return { snapshot, setSnapshot, error };
}
export function NetworkPreferences({ api, notify }: { api?: ModelDockApi; notify: Notify }) {
  const { snapshot, setSnapshot, error } = useNetwork(api);
  const [busy, setBusy] = useState(false);
  if (!snapshot) return <p className="settings-note">{error || '正在读取网络设置…'}</p>;
  const save = async (patch: Parameters<ModelDockApi['saveNetworkSettings']>[0]) => { setBusy(true); try { setSnapshot(await api!.saveNetworkSettings(patch)); } catch (e) { notify(e instanceof Error ? e.message : '保存失败。', 'error'); } finally { setBusy(false); } };
  return <section className="settings-section"><h2 className="settings-heading">网络接管 · FlowBridge</h2><div className="panel">
    <div className="settings-row"><div className="settings-row-copy"><strong>随 ModelDock 自动连接</strong><small>默认关闭。上游未就绪时最多等待两分钟；登录启动沿用上方 ModelDock 开关。</small></div><Toggle label="随 ModelDock 自动连接网络" checked={snapshot.settings.autoConnect} disabled={busy} onChange={autoConnect => void save({ autoConnect })} /></div>
    <div className="settings-row"><div className="settings-row-copy"><strong>启动时显示网速小窗</strong><small>使用同一个 ModelDock 进程和网络会话。</small></div><Toggle label="启动时显示网速小窗" checked={snapshot.settings.showMiniOnStart} disabled={busy} onChange={showMiniOnStart => void save({ showMiniOnStart })} /></div>
    {snapshot.platform === 'win32' && <div className="settings-row"><div className="settings-row-copy"><strong>全局模式解析</strong><small>快速解析保留虚拟地址映射；兼容解析经同一代理使用 DoH。保存后，已连接会话会先断开再重连。</small></div><select aria-label="全局模式解析" value={snapshot.settings.dnsMode} disabled={busy} onChange={e => void save({ dnsMode: e.target.value as 'fast' | 'compatible' })}><option value="fast">快速解析</option><option value="compatible">兼容解析</option></select></div>}
  </div></section>;
}
export function NetworkPanel({ api, notify }: { api?: ModelDockApi; notify: Notify }) {
  const { snapshot, setSnapshot, error } = useNetwork(api);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const [site, setSite] = useState<NetworkSite>('ChatGPT');
  const [checks, setChecks] = useState<NetworkCheck | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [range, setRange] = useState<'minute' | 'day'>('minute');
  useEffect(() => setAddress(snapshot?.settings.address ?? ''), [snapshot?.settings.address]);
  if (!snapshot) return <section className="panel"><p>{error || '正在读取网络组件…'}</p></section>;
  const connecting = snapshot.state === 'connecting' || snapshot.state === 'disconnecting';
  const connected = snapshot.state === 'connected';
  const dirty = address !== snapshot.settings.address;
  const action = async (name: string, run: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setBusy(name);
    try { await run(); setSnapshot(await api!.networkSnapshot()); }
    catch (e) { notify(e instanceof Error ? e.message : '网络操作失败。', 'error'); }
    finally { lock.current = false; setBusy(''); }
  };
  const latest = snapshot.history.at(-1);
  const samples = snapshot.history.filter(s => s.time >= Date.now() - (range === 'minute' ? 60_000 : 86_400_000)).sort((a, b) => a.time - b.time);
  return <section className="network-panel" data-network-panel>
    <div className="panel network-connection"><div className="section-heading"><div><h2>网络连接</h2><p>通过手机、局域网或本机代理连接网络。</p></div><span className={`network-state ${connected ? 'connected' : ''}`} role="status">{({ idle: '未连接', connecting: '连接中', connected: '已连接', disconnecting: '恢复中', error: '需要处理' })[snapshot.state]}</span></div>
      <div className="network-mode" role="group" aria-label="网络连接模式">{(['http', 'global'] as const).map(mode => <button key={mode} aria-pressed={snapshot.settings.mode === mode} disabled={!!busy || connecting || dirty} onClick={() => void action('mode', async () => { setChecks(null); await api!.saveNetworkSettings({ mode }); })}>{mode === 'http' ? 'HTTP 代理' : '全局流量'}</button>)}</div>
      <p className="network-hint">{snapshot.settings.mode === 'global' ? '接管普通 TCP / UDP / DNS；连接前验证 SOCKS5 TCP 与真实 UDP/DNS 往返。' : '设置桌面 HTTP / HTTPS 代理，仅统计经过本机回环转发的流量。'}</p>
      <div className="network-address"><label htmlFor="network-address">上游代理</label><input id="network-address" value={address} placeholder={snapshot.settings.mode === 'http' ? 'http://192.168.43.1:38473' : 'socks5://192.168.43.1:38473'} disabled={connecting || !!busy} onChange={e => setAddress(e.target.value)} /><button className="button secondary" disabled={!!busy || connecting} onClick={() => void action('save', () => api!.saveNetworkSettings({ address }))}>保存</button></div>
      {dirty && <p className="network-hint">地址尚未保存；连接和切换模式前请保存。</p>}
      <div className="network-actions"><button className="button primary" data-action="connect-network" disabled={!!busy || connected || connecting || dirty || !address} onClick={() => void action('connect', () => api!.connectNetwork())}>连接</button>
        <button className="button secondary" data-action="disconnect-network" disabled={snapshot.state === 'idle' && !busy} onClick={() => { void api!.disconnectNetwork().then(setSnapshot).catch(e => notify(String(e.message), 'error')); }}> {connecting ? '取消并恢复' : '断开 / 恢复'}</button>
        <button className="button secondary" disabled={!!busy || connecting} onClick={() => void action('hotspot', async () => { const values = await api!.networkHotspotCandidates(); setCandidates(values); if (!values.length) notify('未找到默认网关，请手动填写手机地址。', 'info'); })}>查询热点地址</button>
        <button className="button secondary" onClick={() => void action('mini', () => api!.showNetworkMini())}>网速小窗</button></div>
      {!!candidates.length && <div className="network-candidates">网关候选（不代表代理服务已启动）：{candidates.map(ip => <button className="button small secondary" key={ip} onClick={() => setAddress(`${snapshot.settings.mode === 'http' ? 'http' : 'socks5'}://${ip.includes(':') ? `[${ip}]` : ip}:38473`)}>{ip}</button>)}</div>}
      <p className="network-hint" role="status">{snapshot.message || '保存配置不会修改系统网络；点击连接后生效。'}</p>
      {snapshot.settings.mode === 'global' && <p className="network-hint">{snapshot.platform === 'linux' ? 'Linux 需安装 ModelDock 网络权限包，首次连接由系统授权；暂不支持本机回环上游。' : 'Windows 全局接管需要管理员权限、sing-box 和 Wintun。普通启动仍可使用 HTTP 模式。'} 回环、局域网链路、ICMP、独立网络空间及第三方 VPN 不保证接管。</p>}
    </div>
    <div className="panel"><div className="section-heading"><h2>网络流量</h2><select aria-label="流量时间范围" value={range} onChange={e => setRange(e.target.value as 'minute' | 'day')}><option value="minute">最近 60 秒</option><option value="day">最近 24 小时</option></select></div>
      <div className="network-metrics"><div><small>↑ 上传</small><strong>{networkBytes(connected ? latest?.uploadRate ?? 0 : 0)}/s</strong><span>本次 {networkBytes(snapshot.status.uploadBytes)}</span></div><div><small>↓ 下载</small><strong>{networkBytes(connected ? latest?.downloadRate ?? 0 : 0)}/s</strong><span>本次 {networkBytes(snapshot.status.downloadBytes)}</span></div><div><small>活动连接</small><strong>{snapshot.status.connections}</strong><span>只统计经过此网络会话的字节</span></div></div>
      <NetworkChart samples={samples} /><p className="network-hint">蓝色下载 · 绿色上传。24 小时历史按分钟采样，不是模型 Token 用量或运营商计费。</p>
    </div>
    <div className="panel"><div className="section-heading"><h2>网站检测</h2><div className="network-actions"><select aria-label="检测网站" value={site} onChange={e => { setSite(e.target.value as NetworkSite); setChecks(null); }}>{NETWORK_SITES.map(name => <option key={name}>{name}</option>)}</select><button className="button secondary" disabled={!!busy || connecting} onClick={() => void action('check', async () => setChecks(await api!.checkNetworkSite(site)))}>{busy === 'check' ? '检测中…' : '检测'}</button><button className="button secondary" onClick={() => void action('browser', () => api!.openNetworkSite(site))}>浏览器验证</button></div></div>
      <p className="network-hint">系统网络使用本机 DNS 与普通 TCP/TLS；代理出口通过当前连接。出口成功不代表全局接管正常，也不代表账号或对话可用。</p>
      {checks && <div className="network-checks">{(['system', 'proxy'] as const).map(path => { const result = checks[path]; return <div key={path}><strong>{path === 'system' ? '系统网络' : '代理出口'}</strong><span>{result ? result.browser_verification ? '需浏览器验证' : result.ok ? '检测通过' : '自动检测未确认' : '请先连接代理'}</span>{result && <small>{result.detail} · {result.elapsed_ms} ms{result.status_code ? ` · HTTP ${result.status_code}` : ''}</small>}</div>; })}</div>}
    </div>
    <div className="panel"><div className="section-heading"><div><h2>手机热点代理</h2><p>导出 FlowBridge Termux 安装器，在手机 Termux 手动执行；默认端口 38473，支持 HTTP、SOCKS5 与 UDP。</p></div><button className="button secondary" onClick={() => void action('export', async () => { const path = await api!.exportPhoneProxy(); if (path) notify('手机脚本已导出，请在手机 Termux 中执行。', 'success'); })}>导出手机脚本</button></div><p className="network-hint">手机 VPN 须允许 Termux 联网。仅导出文件，不会连接手机或修改其配置。</p></div>
  </section>;
}
