import { useEffect, useState, type FormEvent } from 'react';
import { Download, Eye, Pencil, Plus, Search, Server, Trash2, Upload } from './MaterialIcon';
import type { ModelDockApi, ToolId } from '../shared/types';
import type { McpServer, McpServerInput, McpConfigPreview } from '../shared/mcp-types';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';

const TOOLS: { id: ToolId; name: string }[] = [
  { id: 'codex', name: 'Codex' }, { id: 'claude-code', name: 'Claude Code（暂不支持）' }, { id: 'opencode', name: 'OpenCode' }, { id: 'dsh', name: 'DSH' },
  { id: 'vscode', name: 'VS Code' }, { id: 'copilot', name: 'Copilot' },
];
const parseStringMap = (value: string, label: string): Record<string, string> => {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(entry => typeof entry !== 'string')) throw new Error(`${label}请填写字符串键值 JSON 对象。`);
  return parsed as Record<string, string>;
};

function McpEditor({ server, onClose, onSave, busy }: { server?: McpServer; onClose: () => void; onSave: (input: McpServerInput) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState(JSON.stringify(server?.args ?? [], null, 2));
  const [cwd, setCwd] = useState(server?.cwd ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [env, setEnv] = useState(JSON.stringify(server?.env ?? {}, null, 2));
  const [headers, setHeaders] = useState(JSON.stringify(server?.headers ?? {}, null, 2));
  const [description, setDescription] = useState(server?.description ?? '');
  const [enabledTools, setEnabledTools] = useState<ToolId[]>((server?.enabledTools ?? []).filter(id => id !== 'claude-code'));
  const [removeEnv, setRemoveEnv] = useState<string[]>([]);
  const [removeHeaders, setRemoveHeaders] = useState<string[]>([]);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const parsedArgs: unknown = JSON.parse(args || '[]');
      if (!Array.isArray(parsedArgs) || parsedArgs.some(entry => typeof entry !== 'string')) throw new Error('参数请填写字符串 JSON 数组。');
      await onSave({ id: server?.id, name, transport, command, args: parsedArgs as string[], cwd, url,
        env: parseStringMap(env, '环境变量'), headers: parseStringMap(headers, 'Headers'),
        deleteEnvKeys: removeEnv, deleteHeaderKeys: removeHeaders, enabledTools, description });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败。'); }
  };
  const toggleDelete = (key: string, list: string[], set: (value: string[]) => void) => set(list.includes(key) ? list.filter(value => value !== key) : [...list, key]);
  return <Modal title={server ? '编辑 MCP' : '添加 MCP'} subtitle="统一保存配置，然后显式应用到选中的工具。" onClose={onClose} wide>
    <form className="feature-form" onSubmit={submit}>
      <div className="form-grid">
        <label>名称<input value={name} required maxLength={100} onChange={event => setName(event.target.value)} placeholder="例如 blender-mcp" /></label>
        <label>传输方式<select value={transport} onChange={event => setTransport(event.target.value as McpServer['transport'])}>
          <option value="stdio">stdio · 本地命令</option><option value="http">HTTP · Streamable HTTP</option><option value="sse">SSE · 旧版远程传输</option>
        </select></label>
      </div>
      {transport === 'stdio' ? <>
        <label>启动命令<input value={command} required onChange={event => setCommand(event.target.value)} placeholder="npx / uvx / 可执行文件完整路径" /></label>
        <label>参数 · JSON 数组<textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} spellCheck={false} placeholder={'["-y", "@example/mcp"]'} /></label>
        <p className="form-note">敏感参数值已隐藏为 __MODELDOCK_REDACTED__；保留占位符会保留同名原参数的凭据，替换请输入新值。</p>
        <label>工作目录 · 可选<input value={cwd} onChange={event => setCwd(event.target.value)} /></label>
        <label>环境变量 · JSON 对象<textarea rows={4} value={env} onChange={event => setEnv(event.target.value)} spellCheck={false} placeholder={'{"API_KEY":"..."}'} /></label>
        {Boolean(server?.redactedEnvKeys.length) && <div className="feature-secret-keys"><p>已保存的值不会显示；空值保留原值。需要删除时勾选：</p>{server!.redactedEnvKeys.map(key => <label key={key}><input type="checkbox" checked={removeEnv.includes(key)} onChange={() => toggleDelete(key, removeEnv, setRemoveEnv)} />删除 {key}</label>)}</div>}
      </> : <>
        <label>服务器地址<input value={url} type="url" required onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></label>
        <p className="form-note">URL 查询中的凭据已隐藏；同一地址保留占位符会保留原值，替换或更换地址请输入新值。</p>
        <label>HTTP Headers · JSON 对象<textarea rows={5} value={headers} onChange={event => setHeaders(event.target.value)} spellCheck={false} placeholder={'{"Authorization":"Bearer ..."}'} /></label>
        {Boolean(server?.redactedHeaderKeys.length) && <div className="feature-secret-keys"><p>已保存的值不会显示；空值保留原值。需要删除时勾选：</p>{server!.redactedHeaderKeys.map(key => <label key={key}><input type="checkbox" checked={removeHeaders.includes(key)} onChange={() => toggleDelete(key, removeHeaders, setRemoveHeaders)} />删除 {key}</label>)}</div>}
      </>}
      <fieldset className="feature-tool-options"><legend>可使用此 MCP 的工具</legend>{TOOLS.map(tool => <label key={tool.id}><input type="checkbox" checked={enabledTools.includes(tool.id)} disabled={tool.id === 'claude-code'} onChange={event => setEnabledTools(event.target.checked ? [...enabledTools, tool.id] : enabledTools.filter(id => id !== tool.id))} />{tool.name}</label>)}</fieldset>
      <label>备注 · 可选<input value={description} onChange={event => setDescription(event.target.value)} /></label>
      {transport === 'sse' && <p className="form-note">Codex 原生配置不支持 SSE；OpenCode 使用 remote 自动协商。DSH 暂仅提供通用配置片段。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button className="primary" type="submit" disabled={busy}><BusyIcon active={busy}><Plus size={16} /></BusyIcon>保存到目录</button></div>
    </form>
  </Modal>;
}

export function McpPanel({ api, notify }: { api?: ModelDockApi; notify: Notify }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [search, setSearch] = useState('');
  const [tool, setTool] = useState<ToolId>('codex');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<McpServer | 'new' | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [preview, setPreview] = useState<McpConfigPreview | null>(null);
  const refresh = async () => { if (api) setServers(await api.mcpList()); };
  useEffect(() => { let active = true; setLoading(true); if (!api) { setLoading(false); return; }
    api.mcpList().then(rows => { if (active) setServers(rows); }).catch(error => notify(String(error), 'error')).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, notify]);
  const run = async (action: () => Promise<void>) => { setBusy(true); try { await action(); } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); } finally { setBusy(false); } };
  const filtered = servers.filter(server => `${server.name} ${server.command} ${server.url} ${server.description}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="feature-page">
    <div className="feature-toolbar">
      <div className="search-box"><Search size={17} /><input aria-label="搜索 MCP" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、命令或地址" /></div>
      <span className="muted">{servers.length} 个 MCP</span>
      <div className="feature-toolbar-actions"><select value={tool} aria-label="MCP 目标工具" onChange={event => setTool(event.target.value as ToolId)}>{TOOLS.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
        <button className="secondary small" disabled={!api || busy || tool === 'dsh' || tool === 'claude-code'} onClick={() => void run(async () => { const result = await api!.mcpImport(tool); await refresh(); notify(`已导入 ${result.imported} 个 MCP，跳过 ${result.skipped} 个。${result.warnings.join(' ')}`, result.warnings.length ? 'info' : 'success'); })}><Download size={16} />从工具导入</button>
        <button className="secondary small" disabled={!api || busy || tool === 'claude-code'} onClick={() => void run(async () => { setPreview(await api!.mcpPreview(tool)); })}><Eye size={16} />预览 / 应用</button>
        <button className="primary small" disabled={!api || busy} onClick={() => setEditor('new')}><Plus size={16} />添加 MCP</button>
      </div>
    </div>
    {tool === 'claude-code' && <p className="form-note" role="status">Claude Code MCP 导入、预览和应用暂不支持。请在 Claude Code 中独立配置；ModelDock 不会修改其 MCP 设置。</p>}
    <p className="form-note">勾选仅保存目录中的工具选择。点击“预览 / 应用”才会备份并同步工具配置；MCP 命令由工具启动。</p>
    <div className="panel table-scroll"><table className="feature-table"><thead><tr><th>名称 / 配置</th>{TOOLS.map(entry => <th key={entry.id} className="feature-tool-column" title={entry.id === 'claude-code' ? 'Claude Code MCP 暂不支持，不读取或写入配置' : entry.id === 'dsh' ? '尚无已核实的统一配置路径，仅提供导出片段' : entry.id === 'copilot' ? 'GitHub Copilot CLI 用户配置，桌面应用加载待验证' : entry.name}>{entry.name}<span>{servers.filter(server => server.enabledTools.includes(entry.id)).length}</span></th>)}<th>操作</th></tr></thead>
      <tbody>{filtered.map(server => <tr key={server.id}><td><div className="feature-item-title"><strong>{server.name}</strong><span className="badge">{server.transport}</span>{server.importedFrom && <span className="muted">已导入</span>}</div><div className="feature-item-detail" title={server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}>{server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}</div>{server.description && <div className="muted">{server.description}</div>}</td>
        {TOOLS.map(entry => <td key={entry.id} className="feature-tool-column"><input type="checkbox" aria-label={`${server.name} 用于 ${entry.name}`} checked={entry.id !== 'claude-code' && server.enabledTools.includes(entry.id)} disabled={!api || busy || entry.id === 'claude-code'} onChange={event => { const enabled = event.target.checked; void run(async () => { await api!.mcpSetTool(server.id, entry.id, enabled); await refresh(); }); }} /></td>)}
        <td><div className="row-actions"><button className="icon-button" aria-label={`编辑 ${server.name}`} title="编辑" disabled={!api || busy} onClick={() => setEditor(server)}><Pencil size={16} /></button><button className="icon-button" aria-label={`删除 ${server.name}`} title="删除" disabled={!api || busy} onClick={() => setDeleting(server)}><Trash2 size={16} /></button></div></td>
      </tr>)}</tbody></table>
      {!filtered.length && <EmptyState compact icon={<Server size={24} />} title={loading ? '正在读取 MCP 目录' : search ? '没有匹配的 MCP' : '尚未添加 MCP'} description={search ? '试试其他名称、命令或地址。' : '从工具导入已有配置，或添加本地及远程 MCP。'} />}
    </div>
    {!api && <p className="form-note">当前为界面预览，请在 ModelDock 桌面应用中管理配置。</p>}
    {editor && <McpEditor server={editor === 'new' ? undefined : editor} busy={busy} onClose={() => setEditor(null)} onSave={async input => { setBusy(true); try { await api!.mcpSave(input); await refresh(); setEditor(null); notify('MCP 已保存；应用到工具后生效。', 'success'); } finally { setBusy(false); } }} />}
    {deleting && <Modal title="删除 MCP" subtitle={deleting.name} onClose={() => setDeleting(null)}><p>从全局目录删除此 MCP。已同步到工具的项会在下次显式应用时移除；手动改过的项会保留并提示冲突。</p><div className="modal-actions"><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="primary" disabled={busy} onClick={() => void run(async () => { await api!.mcpDelete(deleting.id); await refresh(); setDeleting(null); notify('已从目录删除。请预览并应用到相关工具。', 'success'); })}>删除</button></div></Modal>}
    {preview && <Modal title={`${TOOLS.find(entry => entry.id === preview.tool)?.name} · MCP 配置预览`} subtitle={preview.filename} onClose={() => setPreview(null)} wide>
      <p>{preview.instructions}</p>
      <div className="feature-change-summary"><span>新增 {preview.additions.length}</span><span>更新 {preview.updates.length}</span><span>删除 {preview.removals.length}</span></div>
      {preview.removals.length > 0 && <p>将移除：{preview.removals.join('、')}</p>}
      {preview.warnings.map(message => <p className="form-note" key={message}>{message}</p>)}
      {preview.conflicts.map(message => <p className="form-error" role="alert" key={message}>{message}</p>)}
      <pre className="config-preview">{preview.content}</pre>
      <div className="modal-actions"><button className="secondary" onClick={() => setPreview(null)}>关闭</button><button className="secondary" onClick={() => { const blob = new Blob([preview.content], { type: 'text/plain;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `modeldock-${preview.tool}-mcp.${preview.tool === 'codex' ? 'toml' : 'json'}`; link.click(); URL.revokeObjectURL(link.href); notify('已导出脱敏片段；请补充凭据后在客户端合并。', 'info'); }}><Download size={16} />导出脱敏片段</button><button className="primary" disabled={!api || busy || !preview.canApply} onClick={() => void run(async () => { const result = await api!.mcpApply(preview.tool, preview.fingerprint); setPreview(null); notify(result.changed ? `已应用并保存到 ${result.filename}${result.backupPath ? '，原文件已备份' : ''}。` : '配置已一致，无需改写。', 'success'); })}><BusyIcon active={busy}><Upload size={16} /></BusyIcon>确认应用</button></div>
    </Modal>}
  </section>;
}
