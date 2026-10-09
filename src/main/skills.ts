import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { ToolId } from '../shared/types';
import type { ManagedSkill, SkillDeployment, SkillFilePreview, SkillImportResult, SkillMetadata, SkillRemovePreview, SkillRepositoryInput, SkillSnapshot, SkillSource, SkillTarget } from '../shared/skill-types';
import { openCodeConfigDirectory } from './opencode-paths';

export interface SkillStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
}
export interface SkillManagerOptions {
  homeDir: string;
  appDataDir: string;
  libraryDir?: string;
  backupDir?: string;
  /** Overrides are explicit application configuration, never renderer-provided paths. */
  codexHome?: string;
  /** 修改点：由主进程解析 CLAUDE_CONFIG_DIR，显式路径保持测试资料隔离。 */
  claudeConfigDir?: string;
  dshHome?: string;
  agentsHome?: string;
  openCodeConfigDir?: string;
  configHome?: string;
  fetch?: typeof globalThis.fetch;
}
interface FileEntry { path: string; hash: string; size: number; mode: number; directory?: boolean }
interface StoredDeployment { path: string; manifest: FileEntry[] }
interface StoredSkill extends Omit<ManagedSkill, 'deployments' | 'files'> {
  manifest: FileEntry[];
  deployed: Partial<Record<ToolId, StoredDeployment>>;
}
interface GitTree { sha: string; tree: { path: string; type: string; mode: string; size?: number }[]; truncated?: boolean }
const KEY = 'skills-library-v1';
const MAX_FILES = 500;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function existsSync(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
const isWithin = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};
function child(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('文件路径无效，不能越出技能目录。');
  const target = resolve(root, ...path.split('/'));
  if (!isWithin(root, target) || target === resolve(root)) throw new Error('文件路径越出技能目录。');
  return target;
}
/** Reject aliases before writing or deleting, including junctions on Windows. */
function ensureNoSymlinkPath(path: string) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('目标路径包含符号链接或目录联接，未修改文件。');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function safeRemove(root: string, path: string) {
  if (!isWithin(root, path) || resolve(root) === resolve(path)) throw new Error('拒绝删除管理目录之外的路径。');
  ensureNoSymlinkPath(path);
  rmSync(path, { recursive: true, force: true });
}
function checkedName(name: unknown): string {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new Error('Skill name 须为 1–64 位小写字母、数字和单个连字符，且不能使用系统保留名。');
  return name;
}
export function parseSkillMetadata(content: string): SkillMetadata {
  if (Buffer.byteLength(content) > MAX_PREVIEW_BYTES) throw new Error('SKILL.md 超过 256 KiB。');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('SKILL.md 必须以 YAML frontmatter 开头。');
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length) throw new Error('SKILL.md 的 YAML frontmatter 格式有误。');
  const data = document.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('SKILL.md frontmatter 必须是对象。');
  const name = checkedName(data.name);
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1024) throw new Error('Skill description 须为 1–1024 位文字。');
  return { name, description: data.description.trim(), ...(typeof data.license === 'string' ? { license: data.license.slice(0, 1024) } : {}), ...(typeof data.compatibility === 'string' ? { compatibility: data.compatibility.slice(0, 1024) } : {}) };
}
function readSkillMetadata(path: string): SkillMetadata {
  ensureNoSymlinkPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) throw new Error('SKILL.md 必须是 256 KiB 以内的普通文件。');
  return parseSkillMetadata(readFileSync(path, 'utf8'));
}
function manifest(directory: string, ignoreGit = false): FileEntry[] {
  ensureNoSymlinkPath(directory);
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw new Error('技能目录不存在。');
  const root = realpathSync(directory);
  const files: FileEntry[] = [];
  let size = 0;
  let nodes = 0;
  function visit(path: string, depth: number) {
    if (depth > 16 || ++nodes > 2000) throw new Error('技能目录层级或文件数超过限额。');
    for (const name of readdirSync(path).sort()) {
      if (name === '.git' && ignoreGit) continue;
      const full = join(path, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('技能目录含符号链接，导入或替换已停止。请导入自包含的普通目录。');
      if (!isWithin(root, realpathSync(full))) throw new Error('技能文件越出源目录。');
      if (stat.isDirectory()) {
        if (files.length >= MAX_FILES) throw new Error('技能目录项目数超过 500。');
        files.push({ path: relative(root, full).split(sep).join('/'), hash: '', size: 0, mode: stat.mode & 0o777, directory: true });
        visit(full, depth + 1);
      }
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES || (size += stat.size) > MAX_BYTES || files.length >= MAX_FILES) throw new Error('技能超过限额：500 文件、单文件 5 MiB、总计 25 MiB。');
        const rel = relative(root, full).split(sep).join('/');
        child(root, rel);
        files.push({ path: rel, hash: hash(readFileSync(full)), size: stat.size, mode: stat.mode & 0o777 });
      } else throw new Error('技能目录含特殊文件，无法导入。');
    }
  }
  visit(root, 0);
  if (!files.some(f => f.path === 'SKILL.md')) throw new Error('所选目录中没有 SKILL.md。');
  return files;
}
function sameManifest(a: FileEntry[], b: FileEntry[]) {
  return a.length === b.length && a.every((file, i) => file.path === b[i].path && file.hash === b[i].hash && file.mode === b[i].mode && !!file.directory === !!b[i].directory);
}
function copyChecked(source: string, target: string, expected: FileEntry[]) {
  ensureNoSymlinkPath(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of expected) {
    const from = child(source, file.path);
    ensureNoSymlinkPath(from);
    const to = child(target, file.path);
    if (file.directory) { mkdirSync(to, { recursive: true, mode: 0o700 }); continue; }
    const bytes = readFileSync(from);
    if (hash(bytes) !== file.hash) throw new Error('源技能在操作期间被修改，请重试。');
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, bytes, { mode: file.mode || 0o600, flag: 'wx' });
    chmodSync(to, file.mode);
  }
  for (const directory of expected.filter(f => f.directory).reverse()) chmodSync(child(target, directory.path), directory.mode);
}

export class SkillManager {
  readonly libraryDir: string;
  readonly backupDir: string;
  readonly targets: SkillTarget[];
  private readonly fetcher: typeof globalThis.fetch;
  private readonly scanBoundary: string;
  constructor(private readonly store: SkillStore, options: SkillManagerOptions) {
    const home = resolve(options.homeDir);
    this.scanBoundary = existsSync(home) ? realpathSync(home) : home;
    const agents = join(resolve(options.agentsHome ?? join(home, '.agents')), 'skills');
    const codex = join(resolve(options.codexHome ?? join(home, '.codex')), 'skills');
    const claude = join(resolve(options.claudeConfigDir ?? join(home, '.claude')), 'skills');
    const copilot = join(home, '.copilot', 'skills');
    const openCode = join(resolve(options.openCodeConfigDir ?? openCodeConfigDirectory(home, options.configHome)), 'skills');
    const dsh = join(resolve(options.dshHome ?? join(home, '.dsh')), 'skills');
    this.libraryDir = resolve(options.libraryDir ?? join(options.appDataDir, 'skill-library'));
    this.backupDir = resolve(options.backupDir ?? join(options.appDataDir, 'backups', 'skills'));
    if (isWithin(this.libraryDir, this.backupDir) || isWithin(this.backupDir, this.libraryDir)) throw new Error('技能库与备份目录不可嵌套。');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.targets = [
      { tool: 'codex', name: 'Codex', directory: codex, scanDirectories: [codex, agents], canDeploy: true, sharedWith: [], note: '使用仍兼容的 CODEX_HOME/skills 独立目录；当前官方推荐的 .agents/skills 为多工具共用，仅扫描。重启或刷新技能后生效。', docsUrl: 'https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs' },
      { tool: 'claude-code', name: 'Claude Code', directory: claude, scanDirectories: [claude], canDeploy: true, sharedWith: [], note: '写入 CLAUDE_CONFIG_DIR/skills（默认 ~/.claude/skills）。仅部署技能文件；权限、执行及联网由 Claude Code 控制。', docsUrl: 'https://code.claude.com/docs/en/skills' },
      { tool: 'opencode', name: 'OpenCode', directory: openCode, scanDirectories: [openCode, join(home, '.claude', 'skills'), agents], canDeploy: true, sharedWith: [], note: '写入 OpenCode 全局 skills 目录。现有项目级和权限规则可能改变实际可用技能。', docsUrl: 'https://opencode.ai/docs/skills/' },
      { tool: 'dsh', name: 'DSH', directory: dsh, scanDirectories: [dsh, agents], canDeploy: true, sharedWith: [], note: '适用于官方 dsh-skill-filesystem 插件的用户目录；需已启用 skill registry、filesystem 和 tool-skill。自定义 profile 覆盖目录时使用导出。', docsUrl: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md' },
      { tool: 'vscode', name: 'VS Code', directory: copilot, scanDirectories: [copilot, join(home, '.claude', 'skills'), agents], canDeploy: true, sharedWith: ['copilot'], note: 'VS Code Copilot 与 Copilot app/CLI 共用 .copilot/skills；两列部署开关同步。', docsUrl: 'https://code.visualstudio.com/docs/agent-customization/agent-skills' },
      { tool: 'copilot', name: 'Copilot app', directory: copilot, scanDirectories: [copilot, agents], canDeploy: true, sharedWith: ['vscode'], note: '官方 Copilot app/CLI 技能目录，与 VS Code Copilot 共用；SDK 宿主自行覆盖技能位置时须在宿主设置。', docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills' },
    ];
    for (const target of this.targets) if (isWithin(this.libraryDir, target.directory) || isWithin(target.directory, this.libraryDir)) throw new Error('技能库不可与工具目录重叠。');
  }
  private state() { return this.store.getManagedState<StoredSkill[]>(KEY, []); }
  private persist(skills: StoredSkill[]) { this.store.setManagedState(KEY, skills); }
  private get(id: string) {
    const item = this.state().find(s => s.id === id);
    if (!item) throw new Error('技能不存在。');
    checkedName(item.directory);
    if (!/^[\da-f-]{36}$/.test(item.id)) throw new Error('技能记录 ID 无效。');
    return item;
  }
  private libraryPath(item: StoredSkill) { return child(this.libraryDir, item.id); }
  private target(tool: ToolId) {
    const target = this.targets.find(t => t.tool === tool);
    if (!target) throw new Error('不支持的工具。');
    return target;
  }
  private deployment(item: StoredSkill, target: SkillTarget): SkillDeployment {
    const path = join(target.directory, item.directory);
    const record = item.deployed[target.tool];
    if (!record) {
      if (existsSync(path)) {
        let canAdopt = false;
        try {
          canAdopt = sameManifest(item.manifest, manifest(this.libraryPath(item))) && sameManifest(item.manifest, manifest(path));
        } catch { /* External directories and aliases remain untouched. */ }
        return { tool: target.tool, path, state: 'conflict', canAdopt, message: canAdopt ? '已有同名技能，ModelDock 未接管。内容与管理库一致，可明确确认接管后管理。' : '已有同名技能，ModelDock 未接管；内容不同或路径为链接，保留原项。' };
      }
      return { tool: target.tool, path, state: 'disabled', message: target.note };
    }
    if (resolve(record.path) !== resolve(path)) return { tool: target.tool, path, state: 'conflict', message: '部署目录已改变，保留原文件。' };
    if (!existsSync(path)) return { tool: target.tool, path, state: 'missing', message: '已部署文件被外部移除。' };
    try {
      return sameManifest(record.manifest, manifest(path)) ? { tool: target.tool, path, state: 'deployed', message: target.note }
        : { tool: target.tool, path, state: 'modified', message: '工具中的技能已有修改，保留文件并拒绝覆盖或删除。' };
    } catch { return { tool: target.tool, path, state: 'modified', message: '部署文件或路径已改变，保留文件并拒绝覆盖或删除。' }; }
  }
  private publicSkill(item: StoredSkill): ManagedSkill {
    const { manifest: files, deployed: _deployed, ...metadata } = item;
    return { ...metadata, files: files.filter(f => !f.directory).map(f => f.path), deployments: this.targets.map(t => this.deployment(item, t)) };
  }
  list(): SkillSnapshot {
    return { skills: this.state().map(s => this.publicSkill(s)), targets: this.targets, libraryDir: this.libraryDir };
  }
  private importDirectory(sourcePath: string, source: SkillSource): ManagedSkill {
    const entries = manifest(sourcePath, true);
    const metadata = readSkillMetadata(join(sourcePath, 'SKILL.md'));
    const all = this.state();
    if (all.some(s => s.name === metadata.name)) throw new Error(`技能 ${metadata.name} 已在管理库中，请先删除旧版本或更改 name。`);
    const id = randomUUID();
    const path = child(this.libraryDir, id);
    try {
      copyChecked(sourcePath, path, entries);
      const item: StoredSkill = { ...metadata, id, directory: metadata.name, source, importedAt: new Date().toISOString(), manifest: entries, sizeBytes: entries.reduce((n, f) => n + f.size, 0), deployed: {} };
      this.persist([...all, item]);
      return this.publicSkill(item);
    } catch (error) { if (existsSync(path)) safeRemove(this.libraryDir, path); throw error; }
  }
  importLocal(path: string): ManagedSkill {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('请选择技能目录的绝对路径。');
    return this.importDirectory(resolve(path), { kind: 'local', label: '本地目录', path: resolve(path) });
  }
  scanFromTool(tool: ToolId): SkillImportResult {
    const imported: ManagedSkill[] = [];
    const skipped: string[] = [];
    const target = this.target(tool);
    const seen = new Set<string>();
    const seenDirectories = new Set<string>();
    let count = 0;
    const scan = (path: string, depth: number) => {
      if (depth > 6 || ++count > 2000) { skipped.push('扫描目录超过限额。'); return; }
      try {
        ensureNoSymlinkPath(path);
        const real = realpathSync(path);
        if (seenDirectories.has(real)) return;
        seenDirectories.add(real);
        if (existsSync(join(path, 'SKILL.md'))) {
          const name = readSkillMetadata(join(path, 'SKILL.md')).name;
          if (seen.has(name) || this.state().some(s => s.name === name)) { skipped.push(`${name} 已在管理库中。`); return; }
          seen.add(name);
          imported.push(this.importDirectory(path, { kind: 'tool', label: `从 ${target.name} 导入`, tool, path }));
          return;
        }
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isSymbolicLink()) {
            const linked = join(path, entry.name);
            try {
              const physical = realpathSync(linked);
              if (isWithin(this.scanBoundary, physical) && lstatSync(physical).isDirectory() && existsSync(join(physical, 'SKILL.md'))) scan(physical, depth + 1);
              else skipped.push(`${entry.name} 链接越出用户目录或不是独立技能，未导入。`);
            } catch { skipped.push(`${entry.name} 链接不可读取，未导入。`); }
            continue;
          }
          if (entry.isDirectory()) scan(join(path, entry.name), depth + 1);
        }
      } catch (error) { skipped.push(`${basename(path)}：${error instanceof Error ? error.message : '无法读取。'}`); }
    };
    for (const root of target.scanDirectories) if (existsSync(root)) scan(root, 0);
    return { imported, skipped };
  }
  readFile(id: string, relativePath = 'SKILL.md'): SkillFilePreview {
    const item = this.get(id);
    if (!item.manifest.some(f => !f.directory && f.path === relativePath)) throw new Error('该文件不在技能清单中。');
    const path = child(this.libraryPath(item), relativePath);
    ensureNoSymlinkPath(path);
    if (statSync(path).size > MAX_PREVIEW_BYTES) throw new Error('预览只支持 256 KiB 以内的文本。');
    const data = readFileSync(path);
    const content = data.toString('utf8');
    if (data.includes(0) || !Buffer.from(content, 'utf8').equals(data)) throw new Error('该文件为二进制，不能显示为文本。');
    return { path: relativePath, content, sizeBytes: data.length };
  }
  /** Explicit adoption changes ownership metadata only, never copies over an external bundle. */
  adopt(id: string, tool: ToolId): ManagedSkill {
    const item = this.get(id);
    const target = this.target(tool);
    const tools = [tool, ...target.sharedWith];
    if (tools.some(current => item.deployed[current])) throw new Error('该技能已有受管记录，不能通过接管覆盖外部改动。');
    const path = join(target.directory, item.directory);
    ensureNoSymlinkPath(path);
    if (!existsSync(path)) throw new Error('工具中没有可接管的同名技能。');
    const source = this.libraryPath(item);
    if (!sameManifest(item.manifest, manifest(source))) throw new Error('管理库中的技能已被外部修改，请重新导入。');
    const current = manifest(path);
    if (!sameManifest(item.manifest, current)) throw new Error('同名技能内容或权限与管理库不同，未接管也未覆盖。');
    for (const currentTool of tools) item.deployed[currentTool] = { path, manifest: current };
    // Recheck after creating the metadata object in case another application edited the bundle.
    if (!sameManifest(current, manifest(path))) throw new Error('技能在接管期间被修改，未接管。');
    this.persist(this.state().map(skill => skill.id === id ? item : skill));
    return this.publicSkill(item);
  }
  deploy(id: string, tool: ToolId, enabled: boolean): ManagedSkill {
    if (typeof enabled !== 'boolean') throw new Error('部署状态无效。');
    const item = this.get(id);
    const target = this.target(tool);
    const path = join(target.directory, item.directory);
    ensureNoSymlinkPath(path);
    const status = this.deployment(item, target);
    if (status.state === 'modified' || status.state === 'conflict') throw new Error(status.message);
    const tools = [tool, ...target.sharedWith];
    let quarantine: string | undefined;
    let newlyCreated = false;
    if (!enabled) {
      const record = item.deployed[tool];
      if (record && existsSync(path)) {
        this.backup(item, path, record.manifest, 'disable');
        if (!sameManifest(record.manifest, manifest(path))) throw new Error('技能在备份期间被修改，未删除。');
        quarantine = join(target.directory, `.modeldock-remove-${randomUUID()}`);
        renameSync(path, quarantine);
      }
      for (const current of tools) delete item.deployed[current];
    } else if (status.state !== 'deployed') {
      const source = this.libraryPath(item);
      if (!sameManifest(item.manifest, manifest(source))) throw new Error('管理库中的技能已被外部修改，请重新导入。');
      mkdirSync(target.directory, { recursive: true, mode: 0o700 });
      const staging = join(target.directory, `.modeldock-skill-${randomUUID()}`);
      try {
        copyChecked(source, staging, item.manifest);
        if (existsSync(path)) throw new Error('同名目录在部署期间被创建，未覆盖。');
        renameSync(staging, path);
        newlyCreated = true;
      } finally { if (existsSync(staging)) safeRemove(target.directory, staging); }
      for (const current of tools) item.deployed[current] = { path, manifest: item.manifest };
    }
    try { this.persist(this.state().map(s => s.id === id ? item : s)); }
    catch (error) {
      if (quarantine && !existsSync(path)) renameSync(quarantine, path);
      if (newlyCreated && sameManifest(item.manifest, manifest(path))) safeRemove(target.directory, path);
      throw error;
    }
    if (quarantine) safeRemove(target.directory, quarantine);
    return this.publicSkill(item);
  }
  private backup(item: StoredSkill, path: string, entries: FileEntry[], reason: string) {
    ensureNoSymlinkPath(this.backupDir);
    const destination = child(this.backupDir, `${Date.now()}-${item.id}-${randomUUID().slice(0, 8)}`);
    try {
      copyChecked(path, join(destination, 'skill'), entries);
      writeFileSync(join(destination, 'metadata.json'), JSON.stringify({ name: item.name, sourcePath: path, reason, time: new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch (error) { if (existsSync(destination)) safeRemove(this.backupDir, destination); throw error; }
    return destination;
  }
  previewRemove(id: string): SkillRemovePreview {
    const item = this.get(id);
    const deployments = this.targets.map(t => this.deployment(item, t));
    const active = deployments.filter(d => item.deployed[d.tool]);
    const changed = active.find(d => d.state === 'modified' || d.state === 'conflict');
    return { id, name: item.name, paths: [...new Set([this.libraryPath(item), ...active.filter(d => d.state === 'deployed').map(d => d.path)])], canRemove: !changed, message: changed ? changed.message : '移除本管理库与 ModelDock 部署副本，删除前保留备份；从工具导入的原始技能不会被删除。' };
  }
  remove(id: string): void {
    const item = this.get(id);
    const preview = this.previewRemove(id);
    if (!preview.canRemove) throw new Error(preview.message);
    const library = this.libraryPath(item);
    const operations: { root: string; path: string; entries: FileEntry[] }[] = [];
    const seen = new Set<string>();
    for (const target of this.targets) {
      const record = item.deployed[target.tool];
      if (!record || !existsSync(record.path) || seen.has(record.path)) continue;
      const path = join(target.directory, item.directory);
      if (resolve(record.path) !== resolve(path)) throw new Error('部署记录与当前目录不一致。');
      if (!sameManifest(record.manifest, manifest(path))) throw new Error('部署技能已有外部修改，未删除。');
      operations.push({ root: target.directory, path, entries: record.manifest });
      seen.add(path);
    }
    if (existsSync(library)) operations.push({ root: this.libraryDir, path: library, entries: manifest(library) });
    for (const op of operations) this.backup(item, op.path, op.entries, 'remove');
    for (const op of operations) if (!sameManifest(op.entries, manifest(op.path))) throw new Error('技能在备份期间被修改，未删除。');
    const staged: { root: string; original: string; temporary: string }[] = [];
    try {
      for (const op of operations) {
        ensureNoSymlinkPath(op.path);
        const temporary = join(dirname(op.path), `.modeldock-remove-${randomUUID()}`);
        renameSync(op.path, temporary);
        staged.push({ root: op.root, original: op.path, temporary });
      }
      this.persist(this.state().filter(s => s.id !== id));
    } catch (error) {
      for (const entry of staged.reverse()) if (!existsSync(entry.original)) renameSync(entry.temporary, entry.original);
      throw error;
    }
    for (const entry of staged) safeRemove(entry.root, entry.temporary);
  }
  /** Exporting copies a bundle without changing any tool's discovery configuration. */
  exportTo(id: string, destination: string): string {
    if (!isAbsolute(destination)) throw new Error('导出目录必须是绝对路径。');
    const item = this.get(id);
    const path = join(resolve(destination), item.directory);
    ensureNoSymlinkPath(path);
    if (existsSync(path)) throw new Error('导出位置已有同名技能，未覆盖。');
    try { copyChecked(this.libraryPath(item), path, item.manifest); }
    catch (error) { if (existsSync(path)) safeRemove(destination, path); throw error; }
    return path;
  }
  private async download(url: string, maxBytes: number): Promise<Buffer> {
    const response = await this.fetcher(url, { headers: { 'User-Agent': 'ModelDock', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok) throw new Error(`GitHub 下载失败 (${response.status})。仅支持公开仓库，或稍后重试 API 限额。`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > maxBytes) { await response.body?.cancel(); throw new Error('GitHub 文件超过下载限额。'); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (!response.body) throw new Error('GitHub 返回了空内容。');
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error('GitHub 文件超过下载限额。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  async importRepository(input: SkillRepositoryInput): Promise<SkillImportResult> {
    const url = new URL(input.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('仅支持 https://github.com/owner/repo 的公开仓库。');
    const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length !== 2 || !parts.every(p => /^[\w.-]+$/.test(p)) || parts.some(p => p === '.' || p === '..')) throw new Error('请输入 GitHub 仓库根地址，并单独填写 ref 与技能子目录。');
    const [owner, rawRepo] = parts;
    const repo = rawRepo.replace(/\.git$/, '');
    const ref = input.ref?.trim();
    if (ref && (ref.length > 256 || /[\x00-\x1f\x7f]/.test(ref))) throw new Error('GitHub ref 无效。');
    const subpath = input.subpath?.replace(/\/$/, '') ?? '';
    if (subpath) child(this.libraryDir, subpath);
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const repoInfo = JSON.parse((await this.download(base, 1024 * 1024)).toString('utf8')) as { default_branch: string };
    const chosenRef = ref || repoInfo.default_branch;
    const commitInfo = JSON.parse((await this.download(`${base}/commits/${encodeURIComponent(chosenRef)}`, 2 * 1024 * 1024)).toString('utf8')) as { sha: string };
    if (!/^[\da-f]{40}$/i.test(commitInfo.sha)) throw new Error('GitHub 返回的提交 ID 无效。');
    const tree = JSON.parse((await this.download(`${base}/git/trees/${commitInfo.sha}?recursive=1`, 8 * 1024 * 1024)).toString('utf8')) as GitTree;
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('仓库目录清单过大或不完整，请使用更小的技能仓库。');
    const candidates = tree.tree.filter(f => f.type === 'blob' && basename(f.path) === 'SKILL.md' && (!subpath || f.path.startsWith(subpath + '/')));
    if (!candidates.length || candidates.length > 100) throw new Error('选定目录未发现技能，或技能数超过 100 个；请缩小子目录范围。');
    const roots = [...new Set(candidates.map(f => f.path === 'SKILL.md' ? '' : dirname(f.path).split(sep).join('/')))];
    const selectedFiles = tree.tree.filter(f => f.type === 'blob' && roots.some(root => !root || f.path.startsWith(root + '/')));
    if (selectedFiles.length > MAX_FILES || selectedFiles.reduce((n, f) => n + (f.size ?? 0), 0) > MAX_BYTES || selectedFiles.some(f => (f.size ?? 0) > MAX_FILE_BYTES || f.mode === '120000')) throw new Error('仓库技能包含符号链接或超过下载限额：500 文件、单文件 5 MiB、总计 25 MiB。');
    const temporaryRoot = join(this.libraryDir, '.downloads');
    const staging = child(temporaryRoot, randomUUID());
    const imported: ManagedSkill[] = [];
    const skipped: string[] = [];
    try {
      ensureNoSymlinkPath(staging);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      let total = 0;
      for (const file of selectedFiles) {
        const path = child(staging, file.path);
        const data = await this.download(`https://raw.githubusercontent.com/${owner}/${repo}/${commitInfo.sha}/${file.path.split('/').map(encodeURIComponent).join('/')}`, Math.min(MAX_FILE_BYTES, MAX_BYTES - total));
        total += data.length;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, data, { mode: file.mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
      }
      for (const root of roots) {
        try {
          imported.push(this.importDirectory(root ? child(staging, root) : staging, { kind: 'repository', label: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}`, ref: chosenRef, commit: commitInfo.sha, subpath: root }));
        } catch (error) { skipped.push(`${root || repo}：${error instanceof Error ? error.message : '导入失败。'}`); }
      }
    } finally { if (existsSync(staging)) safeRemove(temporaryRoot, staging); }
    return { imported, skipped };
  }
}
