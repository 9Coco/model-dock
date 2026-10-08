import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Copy, Download, FileText, FolderOpen, RefreshCw, Search, ShieldCheck } from './MaterialIcon';
import type { ModelDockApi } from '../shared/types';
import type { DiagnosticEntry, DiagnosticLevel, DiagnosticQuery, DiagnosticSnapshot } from '../shared/diagnostic-types';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';

const levelNames: Record<DiagnosticLevel, string> = { info: '信息', warn: '警告', error: '错误' };
const levels = ['all', 'info', 'warn', 'error'] as const;
const time = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const bytes = (value: number) => `${Number((value / 1024 / 1024).toFixed(1))} MB`;

export function DiagnosticsPanel({ api, notify }: { api?: ModelDockApi; notify: Notify }) {
  const [level, setLevel] = useState<DiagnosticLevel | 'all'>('all');
  const [search, setSearch] = useState(''), [filteredSearch, setFilteredSearch] = useState('');
  const [limit, setLimit] = useState(200);
  const [result, setResult] = useState<{ key: string; snapshot: DiagnosticSnapshot } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pendingKey, setPendingKey] = useState(''), [busy, setBusy] = useState('');
  const [selected, setSelected] = useState<DiagnosticEntry | null>(null);
  const mounted = useRef(false), serial = useRef(0), actionLocked = useRef(false);
  const query = useMemo<DiagnosticQuery>(() => ({ level: level === 'all' ? undefined : level, search: filteredSearch || undefined, limit }), [level, filteredSearch, limit]);
  const queryKey = JSON.stringify(query);
  const scope = useRef({ query, key: queryKey }); scope.current = { query, key: queryKey };
  const snapshot = result?.key === queryKey ? result.snapshot : null;
  const error = failure?.key === queryKey ? failure.message : '';
  const loading = !!api && (pendingKey === queryKey || (!snapshot && !error));
  const waitingForSearch = search !== filteredSearch;
  const entries = snapshot?.entries ?? [];

  const load = useCallback(async () => {
    if (!api) return;
    const request = ++serial.current, current = scope.current;
    setPendingKey(current.key); setFailure(null);
    try {
      const value = await api.queryDiagnostics(current.query);
      if (mounted.current && request === serial.current && current.key === scope.current.key) setResult({ key: current.key, snapshot: value });
    } catch (problem) {
      if (mounted.current && request === serial.current && current.key === scope.current.key) setFailure({ key: current.key, message: problem instanceof Error ? problem.message : '诊断日志读取失败，请打开日志目录查看。' });
    } finally { if (mounted.current && request === serial.current) setPendingKey(''); }
  }, [api]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilteredSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  // 修改点：诊断日志仅在进入页面、改变筛选或手动刷新时读取，避免轮询和读日志产生递归。
  useEffect(() => { void load(); return () => { serial.current++; }; }, [load, queryKey]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (!api || actionLocked.current) return;
    actionLocked.current = true; setBusy(key);
    try { await action(); }
    catch (problem) { if (mounted.current) notify(problem instanceof Error ? problem.message : '诊断日志操作失败。', 'error'); }
    finally { actionLocked.current = false; if (mounted.current) setBusy(''); }
  };
  const noLogs = !api ? { title: '请在桌面应用中查看诊断日志', description: '诊断记录保存在本机，便于查看启动、授权、连接测试和配置同步问题。' }
    : !snapshot?.available ? { title: '诊断日志暂不可用', description: snapshot?.message || error || '请稍后刷新，或打开日志目录检查。' }
      : { title: search || level !== 'all' ? '没有符合筛选的诊断记录' : '还没有诊断记录', description: search || level !== 'all' ? '调整级别或搜索关键词后再查看。' : '应用运行时会记录关键操作的结果；点击刷新读取最新记录。' };
  const actionDisabled = !api || !!busy || loading || waitingForSearch || !snapshot?.available || !entries.length;

  return <section className="panel diagnostics-panel" data-panel="diagnostics">
    <div className="diagnostics-heading">
      <div><h2>诊断日志<span className="count-tag" data-diagnostics-count>{entries.length}</span></h2><p>查看应用启动、授权、连接测试和配置同步的结果。</p></div>
      <div className="diagnostics-actions">
        <button type="button" className="button small secondary" data-action="diagnostics-refresh" disabled={!api || !!busy || loading || waitingForSearch} onClick={() => void load()}><BusyIcon active={loading}><RefreshCw size={15} /></BusyIcon>刷新</button>
        <button type="button" className="button small secondary" data-action="diagnostics-copy" disabled={actionDisabled} onClick={() => void run('copy', async () => { await api!.copyText(await api!.diagnosticsText(query)); if (mounted.current) notify('筛选后的诊断日志已复制。'); })}><BusyIcon active={busy === 'copy'}><Copy size={15} /></BusyIcon>复制日志</button>
        <button type="button" className="button small secondary" data-action="diagnostics-export" disabled={actionDisabled} onClick={() => void run('export', async () => { const path = await api!.exportDiagnostics(query); if (path && mounted.current) notify(`诊断日志已保存到 ${path}`); })}><BusyIcon active={busy === 'export'}><Download size={15} /></BusyIcon>导出日志</button>
        <button type="button" className="button small secondary" data-action="diagnostics-open-directory" disabled={!api || !!busy} onClick={() => void run('directory', () => api!.openDiagnosticsDir())}><BusyIcon active={busy === 'directory'}><FolderOpen size={15} /></BusyIcon>日志目录</button>
      </div>
    </div>
    <div className="diagnostics-controls">
      <div className="log-tabs" role="group" aria-label="诊断日志级别">{levels.map(value => <button type="button" key={value} data-action={`diagnostics-level-${value}`} aria-pressed={level === value} className={level === value ? 'selected' : ''} disabled={!!busy} onClick={() => setLevel(value)}>{value === 'all' ? '全部' : levelNames[value]}</button>)}</div>
      <label className="search-box"><Search size={15} /><input aria-label="搜索诊断日志" placeholder="搜索事件、说明或元数据" value={search} maxLength={200} disabled={!!busy} onChange={event => setSearch(event.target.value)} /></label>
      <label className="diagnostics-limit">最近<select aria-label="诊断日志最近条数" value={limit} disabled={!!busy} onChange={event => setLimit(Number(event.target.value))}>{[100, 200, 500].map(value => <option key={value} value={value}>{value} 条</option>)}</select></label>
    </div>
    {error && <p className="diagnostics-error" role="alert">{error}</p>}
    <div className="diagnostics-content" aria-busy={loading || waitingForSearch}>
      {loading ? <div className="diagnostics-loading" role="status"><BusyIcon active><FileText size={18} /></BusyIcon>正在读取诊断日志…</div> : entries.length ? <ul className="diagnostics-list" aria-label="诊断日志记录">{entries.map(entry => <li key={entry.entryId}><button type="button" className="diagnostics-row" data-action="diagnostics-detail" data-diagnostic-id={entry.entryId} onClick={() => setSelected(entry)} aria-label={`查看${levelNames[entry.level]}日志：${entry.message}`}><time dateTime={entry.timestamp} title={entry.timestamp}>{time(entry.timestamp)}</time><span className={`diagnostic-level ${entry.level}`}>{levelNames[entry.level]}</span><span className="diagnostics-message"><strong>{entry.message}</strong><code>{entry.event}</code></span><ChevronDown size={15} /></button></li>)}</ul> : <EmptyState compact icon={<FileText size={23} />} {...noLogs} />}
    </div>
    <div className="diagnostics-footer">
      <p><ShieldCheck size={13} /><span>仅记录诊断元数据，不包含密钥、令牌或聊天正文。</span></p>
      {snapshot && <><p className="diagnostics-retention">最多保留 {snapshot.retention} 个日志文件 · 每个 {bytes(snapshot.maxFileBytes)} · 达到上限自动轮转</p><p className="diagnostics-directory" title={snapshot.directory}>{snapshot.directory}</p></>}
    </div>
    {selected && <Modal title="诊断日志详情" subtitle={new Date(selected.timestamp).toLocaleString('zh-CN', { hour12: false })} onClose={() => setSelected(null)} wide>
      <div className="modal-body diagnostics-detail">
        <p className="diagnostics-detail-message"><span className={`diagnostic-level ${selected.level}`}>{levelNames[selected.level]}</span><strong>{selected.message}</strong></p>
        <dl><dt>事件</dt><dd><code>{selected.event}</code></dd><dt>启动会话</dt><dd><code>{selected.sessionId}</code></dd><dt>记录 ID</dt><dd><code>{selected.entryId}</code></dd></dl>
        <h3>诊断元数据</h3><pre tabIndex={0} data-diagnostics-context>{JSON.stringify(selected.context, null, 2)}</pre>
      </div>
      <div className="modal-footer diagnostics-detail-footer"><span>仅包含已脱敏的诊断信息。</span><button type="button" className="button secondary" onClick={() => setSelected(null)}>关闭</button></div>
    </Modal>}
  </section>;
}
