import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Check, FileText, FolderOpen, Repository, Info, RefreshCw, ScrollText, Search, Trash2 } from './MaterialIcon';
import type { ModelDockApi, ToolId } from '../shared/types';
import type { ManagedSkill, SkillFilePreview, SkillImportResult, SkillRemovePreview, SkillRepositoryInput, SkillSnapshot } from '../shared/skill-types';
import { BusyIcon, EmptyState, Modal, type Notify } from './components';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const sourceLabel = (skill: ManagedSkill) => skill.source.kind === 'repository' ? skill.source.label : skill.source.kind === 'tool' ? skill.source.label : '本地目录';

export default function SkillsPanel({ api, notify }: { api?: ModelDockApi; notify: Notify }) {
  const [snapshot, setSnapshot] = useState<SkillSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [scanTool, setScanTool] = useState<ToolId>('codex');
  const [repository, setRepository] = useState<SkillRepositoryInput | null>(null);
  const [reading, setReading] = useState<ManagedSkill | null>(null);
  const [file, setFile] = useState<SkillFilePreview | null>(null);
  const [filePath, setFilePath] = useState('SKILL.md');
  const [remove, setRemove] = useState<SkillRemovePreview | null>(null);
  const [adoption, setAdoption] = useState<{ skill: ManagedSkill; tool: ToolId; name: string; path: string; shared: boolean } | null>(null);
  const [showTargets, setShowTargets] = useState(false);
  const available = !!api?.skillsList;
  const refresh = useCallback(async () => {
    if (!api?.skillsList) return;
    try { setSnapshot(await api.skillsList()); setLoadError(''); }
    catch (error) { setLoadError(errorText(error)); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (!available) { notify('请在 ModelDock 桌面应用中管理技能。', 'info'); return; }
    setBusy(key);
    try { await action(); await refresh(); }
    catch (error) { notify(errorText(error), 'error'); }
    finally { setBusy(''); }
  };
  const importMessage = (result: SkillImportResult) => {
    notify(`已导入 ${result.imported.length} 个技能${result.skipped.length ? `，跳过 ${result.skipped.length} 个：${result.skipped.slice(0, 2).join('；')}` : '。'} 原工具文件保留。`, result.imported.length ? 'success' : 'info');
  };
  const skills = useMemo(() => (snapshot?.skills ?? []).filter(skill => {
    const text = `${skill.name} ${skill.description} ${skill.source.label} ${skill.source.url ?? ''} ${skill.source.subpath ?? ''}`.toLowerCase();
    return text.includes(search.toLowerCase().trim()) && (sourceFilter === 'all' || skill.source.kind === sourceFilter);
  }), [snapshot, search, sourceFilter]);
  const openFile = (skill: ManagedSkill, path = 'SKILL.md') => {
    setReading(skill); setFilePath(path); setFile(null);
    void run('read-file', async () => { setFile(await api!.skillsReadFile(skill.id, path)); });
  };

  return <div className="feature-page skills-page">
    <div className="feature-toolbar">
      <label className="input-with-icon feature-search"><Search size={16} /><input aria-label="搜索技能" placeholder="搜索名称、描述或仓库" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label="筛选技能来源" value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}><option value="all">全部来源</option><option value="local">本地目录</option><option value="repository">GitHub 仓库</option><option value="tool">从工具导入</option></select>
      <span className="feature-count">{snapshot?.skills.length ?? 0} 个技能</span>
      <div className="feature-actions"><button className="button small secondary" disabled={!available || !!busy} onClick={() => void run('import-local', async () => { const imported = await api!.skillsImportLocal(); if (imported) notify(`已导入 ${imported.name}，可勾选工具部署。`); })}><BusyIcon active={busy === 'import-local'}><FolderOpen size={15} /></BusyIcon>本地导入</button><button className="button small primary" disabled={!available || !!busy} onClick={() => setRepository({ url: '', ref: '', subpath: '' })}><Repository size={15} />仓库导入</button></div>
    </div>
    <div className="feature-toolbar secondary-toolbar">
      <select aria-label="选择扫描技能的工具" value={scanTool} onChange={event => setScanTool(event.target.value as ToolId)}>{(snapshot?.targets ?? [{ tool: 'codex', name: 'Codex' }]).map(target => <option key={target.tool} value={target.tool}>{target.name}</option>)}</select>
      <button className="button small secondary" disabled={!available || !!busy} onClick={() => void run('scan', async () => importMessage(await api!.skillsScan(scanTool)))}><BusyIcon active={busy === 'scan'}><ArrowDownToLine size={15} /></BusyIcon>从工具导入</button>
      <span className="feature-note">导入只复制到管理库。勾选工具即部署，取消勾选即备份并移除管理副本。</span>
      <button className="icon-button" title="技能目录与适配说明" aria-label="技能目录与适配说明" onClick={() => setShowTargets(true)}><Info size={16} /></button>
      <button className="icon-button" title="刷新部署状态" aria-label="刷新技能部署状态" disabled={!available || !!busy} onClick={() => void run('refresh', refresh)}><BusyIcon active={busy === 'refresh'}><RefreshCw size={16} /></BusyIcon></button>
    </div>
    {!available && <div className="feature-notice">技能管理需要桌面连接。打开 ModelDock 桌面应用后，可扫描、导入并部署真实技能目录。</div>}
    {loadError && <div className="gateway-error">{loadError}</div>}
    {skills.length ? <div className="table-scroll"><table className="feature-table skills-table"><thead><tr><th>技能 / 描述</th><th>来源</th>{snapshot?.targets.map(target => <th className="tool-column" key={target.tool} title={target.note}>{target.name}</th>)}<th><span className="sr-only">操作</span></th></tr></thead><tbody>{skills.map(skill => <tr key={skill.id}>
      <td><strong>{skill.name}</strong><p className="feature-description" title={skill.description}>{skill.description}</p><small>{skill.files.length} 个文件 · {Math.ceil(skill.sizeBytes / 1024)} KiB{skill.license ? ` · ${skill.license}` : ''}</small></td>
      <td><span className="source-badge" title={skill.source.path ?? skill.source.url}>{sourceLabel(skill)}</span>{skill.source.commit && <small className="source-ref" title={skill.source.commit}>{skill.source.ref} · {skill.source.commit.slice(0, 7)}</small>}</td>
      {snapshot?.targets.map(target => {
        const deployment = skill.deployments.find(d => d.tool === target.tool);
        const changed = deployment?.state === 'modified' || deployment?.state === 'conflict';
        const checked = deployment?.state === 'deployed' || deployment?.state === 'modified';
        return <td className="tool-column" key={target.tool}><label className={`tool-check ${changed ? 'has-conflict' : ''}`} title={`${deployment?.message ?? target.note}\n${deployment?.path ?? target.directory}`}><input type="checkbox" checked={checked} disabled={!available || !!busy || changed || !target.canDeploy} aria-label={`${skill.name} ${target.name} 部署${target.sharedWith.length ? '（与另一个 Copilot 工具同步）' : ''}`} onChange={event => { const enabled = event.target.checked; void run(`deploy-${skill.id}-${target.tool}`, async () => { await api!.skillsDeploy(skill.id, target.tool, enabled); notify(`${skill.name} ${enabled ? '已部署' : '已停用'}${target.sharedWith.length ? '，VS Code 与 Copilot app 同步更新' : ''}。`); }); }} />{changed && <span className="deployment-label">{deployment?.state === 'modified' ? '已修改' : '同名'}</span>}</label>{deployment?.canAdopt && <button className="text-button" disabled={!available || !!busy} aria-label={`接管 ${skill.name} 在 ${target.name} 的现有技能`} onClick={() => setAdoption({ skill, tool: target.tool, name: target.name, path: deployment.path, shared: !!target.sharedWith.length })}>接管</button>}</td>;
      })}
      <td><div className="row-actions"><button className="icon-button" aria-label={`查看 ${skill.name} 文件`} title="查看技能文件" disabled={!available || !!busy} onClick={() => openFile(skill)}><FileText size={16} /></button><button className="icon-button danger-icon" title="删除管理技能" aria-label={`删除 ${skill.name}`} disabled={!available || !!busy} onClick={() => void run('preview-remove', async () => setRemove(await api!.skillsPreviewRemove(skill.id)))}><Trash2 size={15} /></button></div></td>
    </tr>)}</tbody></table></div> : <EmptyState compact icon={<ScrollText size={27} />} title={search || sourceFilter !== 'all' ? '没有匹配的技能' : '管理你的常用 Skills'} description="从工具读取已有技能，或导入含 SKILL.md 的本地目录、GitHub 仓库，再选择部署到哪些工具。" />}
    <div className="panel-footnote"><Info size={14} /><span>VS Code 与 Copilot app 共用官方技能目录，开关同步。已有同名技能或手动修改的文件会保留；工具扫描可能包含共享技能目录。</span></div>

    {repository && <Modal title="从 GitHub 导入 Skills" subtitle="只下载选定技能文件，保存来源与提交版本；不会运行任何安装脚本。" onClose={() => { if (!busy) setRepository(null); }}>
      <form onSubmit={event => { event.preventDefault(); void run('import-repository', async () => { importMessage(await api!.skillsImportRepository(repository)); setRepository(null); }); }}>
        <label className="form-field">公开仓库地址<input required type="url" placeholder="https://github.com/owner/repository" value={repository.url} onChange={event => setRepository({ ...repository, url: event.target.value })} /><small>填写仓库根地址；如需选择技能目录，请在下面填写。</small></label>
        <label className="form-field">分支、标签或提交<input placeholder="留空使用仓库默认分支" value={repository.ref ?? ''} onChange={event => setRepository({ ...repository, ref: event.target.value })} /></label>
        <label className="form-field">技能子目录<input placeholder="例如 skills/code-review，留空扫描仓库" value={repository.subpath ?? ''} onChange={event => setRepository({ ...repository, subpath: event.target.value })} /><small>最多 100 个技能、500 个文件、25 MiB。不支持仓库内符号链接。</small></label>
        <div className="modal-footer"><button type="button" className="button secondary" disabled={!!busy} onClick={() => setRepository(null)}>取消</button><button type="submit" className="button primary" disabled={!available || !!busy}><BusyIcon active={busy === 'import-repository'}><ArrowDownToLine size={16} /></BusyIcon>导入管理库</button></div>
      </form>
    </Modal>}
    {reading && <Modal title={reading.name} subtitle={`${reading.description} · ${sourceLabel(reading)}`} wide onClose={() => setReading(null)}>
      <label className="form-field">技能文件<select value={filePath} disabled={!!busy} onChange={event => openFile(reading, event.target.value)}>{reading.files.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      {file ? <pre className="config-preview feature-code">{file.content}</pre> : <p className="feature-note">{busy === 'read-file' ? '读取文件中…' : '无法预览此文件；支持 256 KiB 以内 UTF-8 文本。'}</p>}
      <div className="modal-footer"><span className="feature-note">文件内容作为技能资料展示，不会在此执行。</span><button className="button secondary" onClick={() => setReading(null)}>关闭</button></div>
    </Modal>}
    {remove && <Modal title={`删除「${remove.name}」？`} subtitle={remove.message} onClose={() => { if (!busy) setRemove(null); }}>
      <div className="form-info"><Trash2 size={18} /><div><strong>将影响以下管理副本</strong><p>{remove.paths.length} 个目录。删除前会备份，最初导入的本地目录与仓库文件保留。</p></div></div>
      <ul className="feature-path-list">{remove.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
      <div className="modal-footer"><button className="button secondary" disabled={!!busy} onClick={() => setRemove(null)}>取消</button><button className="button danger" disabled={!remove.canRemove || !!busy} onClick={() => void run('delete', async () => { await api!.skillsDelete(remove.id); notify('管理技能与部署副本已删除，备份已保留。', 'info'); setRemove(null); })}><BusyIcon active={busy === 'delete'}><Trash2 size={15} /></BusyIcon>备份并删除</button></div>
    </Modal>}
    {adoption && <Modal title={`接管 ${adoption.name} 的「${adoption.skill.name}」？`} subtitle="现有技能与管理库完全一致。确认后由 ModelDock 管理该目录，不会覆盖当前文件。" onClose={() => { if (!busy) setAdoption(null); }}>
      <div className="form-info"><Info size={18} /><div><strong>接管后的停用与删除会影响这个目录</strong><p>以后取消勾选或删除技能时，ModelDock 会先备份再移除该工具中的副本；检测到手动修改会停止操作并保留文件。{adoption.shared ? ' VS Code 与 Copilot app 共用该目录，接管状态同步。' : ''}</p></div></div>
      <p className="feature-note"><code>{adoption.path}</code></p>
      <div className="modal-footer"><button className="button secondary" disabled={!!busy} onClick={() => setAdoption(null)}>取消</button><button className="button primary" disabled={!available || !!busy} onClick={() => void run('adopt', async () => { await api!.skillsAdopt(adoption.skill.id, adoption.tool); notify('已接管现有技能，文件内容保留。'); setAdoption(null); })}><BusyIcon active={busy === 'adopt'}><Check size={15} /></BusyIcon>确认接管</button></div>
    </Modal>}
    {showTargets && <Modal title="技能目录与适配说明" wide onClose={() => setShowTargets(false)}><div className="feature-targets">{snapshot?.targets.map(target => <div className="feature-target" key={target.tool}><strong>{target.name}</strong><code>{target.directory}</code><p>{target.note}</p><a href={target.docsUrl} target="_blank" rel="noreferrer">官方目录说明</a></div>)}</div><div className="modal-footer"><button className="button secondary" onClick={() => setShowTargets(false)}><Check size={16} />关闭</button></div></Modal>}
  </div>;
}
