import { useEffect, useRef, useState } from 'react';
import { Activity, FolderOpen, Monitor, Moon, RefreshCw, Sun, Terminal } from './MaterialIcon';
import type { ModelDockApi } from '../shared/types';
import type { AppSettings, SettingsSnapshot } from '../shared/settings-types';
import type { AuthNetworkDiagnostic } from '../shared/network-types';
import { BusyIcon, EmptyState, Toggle, type Notify } from './components';

export function SettingsPanel({ api, snapshot, onSave, notify, dataDir, version }: { api?: ModelDockApi; snapshot: SettingsSnapshot | null; onSave: (patch: Partial<AppSettings>) => Promise<void>; notify: Notify; dataDir: string; version: string }) {
  const [busy, setBusy] = useState('');
  const [proxyDraft, setProxyDraft] = useState(snapshot?.settings.proxyUrl ?? '');
  const [networkDiagnostic, setNetworkDiagnostic] = useState<AuthNetworkDiagnostic | null>(null);
  const [networkError, setNetworkError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const networkRevision = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++networkRevision.current; }; }, []);
  useEffect(() => { setProxyDraft(snapshot?.settings.proxyUrl ?? ''); ++networkRevision.current; setNetworkDiagnostic(null); setNetworkError(''); }, [snapshot?.settings.proxyUrl]);
  const change = async (key: string, patch: Partial<AppSettings>) => {
    if (!api || lock.current) return;
    lock.current = true;
    setBusy(key);
    if (key === 'network-proxy') { ++networkRevision.current; setNetworkDiagnostic(null); setNetworkError(''); }
    try { await onSave(patch); }
    catch (error) { notify(error instanceof Error ? error.message : '设置保存失败。', 'error'); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const action = async (key: string, run: () => Promise<void>) => {
    if (!api || lock.current) return;
    lock.current = true;
    setBusy(key);
    try { await run(); }
    catch (error) { notify(error instanceof Error ? error.message : '操作失败。', 'error'); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  const probeNetwork = async () => {
    if (!api || lock.current) return;
    if (proxyDraft.trim() !== (snapshot?.settings.proxyUrl ?? '')) { setNetworkError('代理地址尚未保存，请先保存后检测。'); return; }
    if (!api.probeAuthNetwork) { setNetworkError('当前桌面程序还不支持网络诊断，请重启最新版本。'); return; }
    const revision = ++networkRevision.current;
    lock.current = true; setBusy('probe-auth-network'); setNetworkDiagnostic(null); setNetworkError('');
    try {
      const result = await api.probeAuthNetwork();
      if (mounted.current && revision === networkRevision.current) setNetworkDiagnostic(result);
    } catch {
      if (mounted.current && revision === networkRevision.current) setNetworkError('无法读取网络诊断结果，请稍后重试。');
    } finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  if (!snapshot) return <EmptyState compact icon={<Monitor size={25} />} title={api?.getSettings ? '正在读取设置' : '等待桌面设置连接'} description="设置由桌面应用保存到本机。升级后请退出旧版，再打开新版程序。" />;
  const settings = snapshot.settings;
  const proxyDirty = proxyDraft.trim() !== settings.proxyUrl;
  return <section className="settings-panel">
    <section className="settings-section"><h2 className="settings-heading">外观</h2><div className="panel">
      <div className="settings-row"><div className="settings-row-copy"><strong>主题</strong><small>立即应用到全部页面和弹窗。</small></div><div className="settings-control theme-picker" role="group" aria-label="选择主题">{([{ id: 'system', label: '跟随系统', icon: Monitor }, { id: 'light', label: '浅色', icon: Sun }, { id: 'dark', label: '深色', icon: Moon }] as const).map(theme => <button key={theme.id} data-theme-choice={theme.id} className={settings.theme === theme.id ? 'selected' : ''} aria-pressed={settings.theme === theme.id} disabled={!api || !!busy} onClick={() => void change('theme', { theme: theme.id })}><theme.icon size={17} /><strong>{theme.label}</strong></button>)}</div></div>
    </div></section>
    <section className="settings-section"><h2 className="settings-heading">窗口与启动</h2><div className="panel">
      <div className="settings-row"><div className="settings-row-copy"><strong>开机自启</strong><small>{snapshot.launchAtLoginSupported ? settings.launchAtLogin && !snapshot.actualLaunchAtLogin ? snapshot.launchAtLoginReason || '系统登记未生效；关闭后重新开启可重新登记。' : snapshot.actualLaunchAtLogin ? '已登记在系统启动项中。' : '登录系统后自动启动 ModelDock。' : snapshot.launchAtLoginReason || '当前环境不支持设置开机启动。'}</small></div><div className="settings-control"><Toggle checked={settings.launchAtLogin} disabled={!api || !!busy || !snapshot.launchAtLoginSupported} label="开机自启" onChange={launchAtLogin => void change('startup', { launchAtLogin })} /></div></div>
      <div className="settings-row"><div className="settings-row-copy"><strong>静默启动</strong><small>下次启动时留在托盘；点击托盘图标或再次打开程序显示窗口。</small></div><div className="settings-control"><Toggle checked={settings.startHidden} disabled={!api || !!busy} label="静默启动" onChange={startHidden => void change('hidden', { startHidden })} /></div></div>
      <div className="settings-row"><div className="settings-row-copy"><strong>关闭时留在托盘</strong><small>开启后关闭窗口仍可使用本地服务；关闭此项后，关闭窗口会退出应用。</small></div><div className="settings-control"><Toggle checked={settings.closeToTray} disabled={!api || !!busy} label="关闭时留在托盘" onChange={closeToTray => void change('tray', { closeToTray })} /></div></div>
    </div></section>
    <section className="settings-section"><h2 className="settings-heading">终端</h2><div className="panel">
      <div className="settings-row"><div className="settings-row-copy"><strong>首选终端</strong><small>用于从 ModelDock 打开本地工作目录。</small></div><div className="settings-control"><select aria-label="首选终端" disabled={!api || !!busy} value={settings.terminal} onChange={event => void change('terminal', { terminal: event.target.value as AppSettings['terminal'] })}>{snapshot.terminalOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select><button className="button small secondary" disabled={!api || !!busy} onClick={() => void action('open-terminal', () => api!.openTerminal())}><BusyIcon active={busy === 'open-terminal'}><Terminal size={15} /></BusyIcon>打开终端</button></div></div>
    </div></section>
    <section className="settings-section"><h2 className="settings-heading">网络</h2><div className="panel">
      <div className="settings-row"><div className="settings-row-copy"><strong>应用网络代理</strong><small>用于账号授权、模型目录和聚合请求。留空跟随系统；支持本机 HTTP、HTTPS 或 SOCKS5 代理。</small><small>地址已保存时，再次保存可重新应用代理设置。</small></div><div className="settings-control" style={{ flexWrap: 'wrap' }}><input aria-label="应用网络代理地址" placeholder="http://127.0.0.1:端口" value={proxyDraft} disabled={!api || !!busy} onChange={event => { setProxyDraft(event.target.value); setNetworkError(''); }} style={{ width: 'min(280px, 100%)' }} /><button className="button small secondary" data-action="save-network-proxy" disabled={!api || !!busy} onClick={() => void change('network-proxy', { proxyUrl: proxyDraft })}><BusyIcon active={busy === 'network-proxy'}><RefreshCw size={15} /></BusyIcon>保存代理</button></div></div>
      <div className="settings-row"><div className="settings-row-copy"><strong>授权服务连接检测</strong><small>读取 Grok 公开授权服务信息，检查应用当前使用的网络路线；不登录账号。</small>{proxyDirty && <small style={{ color: 'var(--warning)' }}>代理地址尚未保存，请先保存后检测。</small>}</div><div className="settings-control"><button className="button small secondary" data-action="probe-auth-network" disabled={!api || !!busy || proxyDirty} onClick={() => void probeNetwork()}><BusyIcon active={busy === 'probe-auth-network'}><Activity size={15} /></BusyIcon>{busy === 'probe-auth-network' ? '检测中…' : '检测连接'}</button></div></div>
      {networkDiagnostic && <div className="settings-row" data-network-diagnostic data-ok={networkDiagnostic.ok} data-network-route={networkDiagnostic.route} data-error-code={networkDiagnostic.errorCode} data-status-code={networkDiagnostic.statusCode} data-duration-ms={networkDiagnostic.durationMs} role={networkDiagnostic.ok ? 'status' : 'alert'}><div className="settings-row-copy"><strong style={{ color: networkDiagnostic.ok ? 'var(--success)' : 'var(--danger)' }}>{networkDiagnostic.ok ? '授权服务连接正常' : '授权服务连接未通过'}</strong><small>{networkDiagnostic.message}</small><small>路线：{({ direct: '直连', proxy: '代理', unknown: '未确认' })[networkDiagnostic.route]} · {networkDiagnostic.statusCode === undefined ? '未收到 HTTP 响应' : `HTTP ${networkDiagnostic.statusCode}`}{networkDiagnostic.errorCode ? ` · ${networkDiagnostic.errorCode}` : ''} · 耗时 {Math.round(networkDiagnostic.durationMs).toLocaleString('zh-CN')} ms</small><small className="settings-meta">当前代理：<code>{networkDiagnostic.configuredProxyUrl || '跟随系统'}</code>{proxyDirty ? '（此诊断对应已保存的设置）' : ''}</small></div></div>}
      {networkError && <div className="settings-row"><div className="settings-row-copy"><small style={{ color: 'var(--danger)' }} role="alert">{networkError}</small></div></div>}
    </div></section>
    <section className="settings-section"><h2 className="settings-heading">本地数据</h2><div className="panel">
      <div className="settings-row"><div className="settings-row-copy"><strong>数据目录</strong><small className="settings-meta"><code>{dataDir || '正在读取目录'}</code></small></div><div className="settings-control"><button className="button small secondary" disabled={!api || !!busy || !dataDir} onClick={() => void action('data-dir', () => api!.openDataDir())}><FolderOpen size={15} />打开目录</button></div></div>
      <div className="settings-row"><div className="settings-row-copy"><strong>ModelDock</strong><small>{version ? `v${version}` : '开发版'} · 设置保存在本机 SQLite 中</small></div><span className="settings-note">自动保存</span></div>
    </div></section>
    {busy && <div className="settings-note" role="status"><RefreshCw size={13} className="spin" />{busy === 'open-terminal' ? '正在打开终端…' : busy === 'probe-auth-network' ? '正在检测应用网络…' : '正在应用设置…'}</div>}
  </section>;
}
