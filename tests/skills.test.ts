import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SkillManager, parseSkillMetadata, type SkillStore } from '../src/main/skills';

class MemoryStore implements SkillStore {
  values = new Map<string, unknown>();
  fail = false;
  getManagedState<T>(key: string, fallback: T): T { return structuredClone((this.values.get(key) ?? fallback) as T); }
  setManagedState(key: string, value: unknown) { if (this.fail) throw new Error('store unavailable'); this.values.set(key, structuredClone(value)); }
}
let fixture: string;
let manager: SkillManager;
let store: MemoryStore;
function skill(path: string, name = 'example', body = 'Use this workflow.') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: A useful ${name} workflow.\nlicense: MIT\n---\n${body}\n`);
  return path;
}
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'modeldock-skills-test-'));
  store = new MemoryStore();
  manager = new SkillManager(store, { homeDir: join(fixture, 'home'), appDataDir: join(fixture, 'data') });
});
afterEach(() => {
  const path = resolve(fixture);
  const rel = relative(resolve(tmpdir()), path);
  if (!isAbsolute(rel) && !rel.startsWith('..' + sep) && rel !== '..' && path !== resolve(tmpdir()) && path.includes('modeldock-skills-test-')) rmSync(path, { recursive: true, force: true });
});

describe('managed skills', () => {
  it('deploys Claude Code skills to its explicit config directory and preserves changed files', () => {
    const home = join(fixture, 'home'), claudeConfigDir = join(fixture, 'custom-claude');
    const custom = new SkillManager(store, { homeDir: home, appDataDir: join(fixture, 'data'), claudeConfigDir });
    const imported = custom.importLocal(skill(join(fixture, 'source'))), deployed = custom.deploy(imported.id, 'claude-code', true);
    const path = deployed.deployments.find(d => d.tool === 'claude-code')!.path;
    expect(path).toBe(join(claudeConfigDir, 'skills', 'example'));
    expect(existsSync(join(home, '.claude'))).toBe(false);
    writeFileSync(join(path, 'SKILL.md'), 'user changed skill');
    expect(() => custom.deploy(imported.id, 'claude-code', false)).toThrow('修改');
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('user changed skill');
  });
  it('deploys OpenCode skills under the configured XDG root without creating default-profile files', () => {
    const home = join(fixture, 'home'), configHome = join(fixture, 'custom-config');
    const custom = new SkillManager(store, { homeDir: home, appDataDir: join(fixture, 'data'), configHome });
    const imported = custom.importLocal(skill(join(fixture, 'source'))), deployed = custom.deploy(imported.id, 'opencode', true);
    const path = deployed.deployments.find(d => d.tool === 'opencode')!.path;
    expect(path).toBe(join(configHome, 'opencode', 'skills', 'example'));
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toContain('example');
    expect(existsSync(join(home, '.config', 'opencode'))).toBe(false);
  });
  it('parses metadata as data and rejects malformed or unsafe names', () => {
    expect(parseSkillMetadata('---\nname: useful-skill\ndescription: |\n  Line one.\n  Line two.\n---\nbody').description).toBe('Line one.\nLine two.');
    for (const name of ['../escape', 'CON', 'con', 'bad--name', 'a/b', '']) expect(() => parseSkillMetadata(`---\nname: "${name}"\ndescription: test\n---\n`)).toThrow();
    expect(() => parseSkillMetadata('---\nname: one\nname: two\ndescription: text\n---')).toThrow();
  });
  it('imports a self-contained bundle without running script resources and reads only listed text', () => {
    const source = skill(join(fixture, 'source'));
    mkdirSync(join(source, 'scripts'));
    writeFileSync(join(source, 'scripts', 'install.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(fixture, 'executed'))},'bad')`);
    const imported = manager.importLocal(source);
    expect(imported.files).toContain('scripts/install.js');
    expect(existsSync(join(fixture, 'executed'))).toBe(false);
    expect(manager.readFile(imported.id).content).toContain('name: example');
    expect(() => manager.readFile(imported.id, '../source/SKILL.md')).toThrow();
    expect(() => manager.importLocal(source)).toThrow('已在管理库');
    expect(new SkillManager(store, { homeDir: join(fixture, 'home'), appDataDir: join(fixture, 'data') }).list().skills).toHaveLength(1);
  });
  it('deploys separate copies and disables only owned unchanged files with backups', () => {
    const imported = manager.importLocal(skill(join(fixture, 'source')));
    const deployed = manager.deploy(imported.id, 'codex', true);
    const path = deployed.deployments.find(d => d.tool === 'codex')!.path;
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toContain('example');
    expect(path).toContain(join('.codex', 'skills'));
    const unrelated = skill(join(dirname(path), 'unrelated'), 'unrelated');
    manager.deploy(imported.id, 'codex', false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(readdirSync(manager.backupDir)).toHaveLength(1);
    expect(manager.list().skills[0].deployments.find(d => d.tool === 'codex')!.state).toBe('disabled');
  });
  it('keeps VS Code and Copilot switches consistent for their shared official directory', () => {
    const imported = manager.importLocal(skill(join(fixture, 'source')));
    const deployed = manager.deploy(imported.id, 'vscode', true);
    expect(deployed.deployments.filter(d => d.state === 'deployed').map(d => d.tool)).toEqual(['vscode', 'copilot']);
    manager.deploy(imported.id, 'copilot', false);
    expect(manager.list().skills[0].deployments.every(d => d.state !== 'deployed')).toBe(true);
  });
  it('refuses replacement of existing unmanaged names, even when content matches', () => {
    const imported = manager.importLocal(skill(join(fixture, 'source')));
    const target = manager.targets.find(t => t.tool === 'opencode')!;
    const original = skill(join(target.directory, 'example'));
    expect(() => manager.deploy(imported.id, 'opencode', true)).toThrow('未接管');
    expect(() => manager.deploy(imported.id, 'opencode', false)).toThrow('未接管');
    manager.remove(imported.id);
    expect(existsSync(join(original, 'SKILL.md'))).toBe(true);
  });
  it('adopts an identical installed bundle explicitly without changing its files', () => {
    const target = manager.targets.find(t => t.tool === 'codex')!;
    const original = skill(join(target.directory, 'example'));
    const originalText = readFileSync(join(original, 'SKILL.md'), 'utf8');
    const imported = manager.scanFromTool('codex').imported[0];
    expect(imported.deployments.find(d => d.tool === 'codex')).toMatchObject({ state: 'conflict', canAdopt: true });
    const adopted = manager.adopt(imported.id, 'codex');
    expect(adopted.deployments.find(d => d.tool === 'codex')!.state).toBe('deployed');
    expect(readFileSync(join(original, 'SKILL.md'), 'utf8')).toBe(originalText);
    manager.deploy(imported.id, 'codex', false);
    expect(existsSync(original)).toBe(false);
    const backup = join(manager.backupDir, readdirSync(manager.backupDir)[0], 'skill', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe(originalText);
  });
  it('refuses adoption of different content and later changes to an already adopted bundle', () => {
    const target = manager.targets.find(t => t.tool === 'opencode')!;
    const original = skill(join(target.directory, 'example'));
    const imported = manager.scanFromTool('opencode').imported[0];
    writeFileSync(join(original, 'mine.txt'), 'external change');
    expect(manager.list().skills[0].deployments.find(d => d.tool === 'opencode')!.canAdopt).toBe(false);
    expect(() => manager.adopt(imported.id, 'opencode')).toThrow('不同');
    rmSync(join(original, 'mine.txt'));
    manager.adopt(imported.id, 'opencode');
    writeFileSync(join(original, 'mine.txt'), 'later user change');
    expect(() => manager.adopt(imported.id, 'opencode')).toThrow('已有受管记录');
    expect(() => manager.deploy(imported.id, 'opencode', false)).toThrow('修改');
    expect(readFileSync(join(original, 'mine.txt'), 'utf8')).toBe('later user change');
  });
  it('keeps Git metadata outside imported bundles and never adopts or deletes external Git directories', () => {
    const source = skill(join(fixture, 'source'));
    mkdirSync(join(source, '.git'));
    writeFileSync(join(source, '.git', 'config'), 'repository metadata');
    const imported = manager.importLocal(source);
    expect(imported.files).not.toContain('.git/config');
    const target = manager.targets.find(t => t.tool === 'codex')!;
    const original = skill(join(target.directory, 'example'));
    mkdirSync(join(original, '.git'));
    writeFileSync(join(original, '.git', 'config'), 'user repository metadata');
    expect(() => manager.adopt(imported.id, 'codex')).toThrow('不同');
    manager.remove(imported.id);
    expect(readFileSync(join(original, '.git', 'config'), 'utf8')).toBe('user repository metadata');
  });
  it('adopts VS Code and Copilot together for their shared directory', () => {
    const target = manager.targets.find(t => t.tool === 'vscode')!;
    skill(join(target.directory, 'example'));
    const imported = manager.scanFromTool('vscode').imported[0];
    const adopted = manager.adopt(imported.id, 'copilot');
    expect(adopted.deployments.filter(d => d.state === 'deployed').map(d => d.tool)).toEqual(['vscode', 'copilot']);
    manager.deploy(imported.id, 'vscode', false);
    expect(manager.list().skills[0].deployments.every(d => d.state !== 'deployed')).toBe(true);
  });
  it('cannot adopt linked directories or create ownership records on save failure', () => {
    const source = skill(join(fixture, 'source'));
    const imported = manager.importLocal(source);
    const target = manager.targets.find(t => t.tool === 'dsh')!;
    mkdirSync(target.directory, { recursive: true });
    const installed = join(target.directory, 'example');
    symlinkSync(source, installed, process.platform === 'win32' ? 'junction' : 'dir');
    expect(manager.list().skills[0].deployments.find(d => d.tool === 'dsh')!.canAdopt).toBe(false);
    expect(() => manager.adopt(imported.id, 'dsh')).toThrow('符号链接');
    rmSync(installed);
    skill(installed);
    store.fail = true;
    expect(() => manager.adopt(imported.id, 'dsh')).toThrow('store unavailable');
    expect(manager.list().skills[0].deployments.find(d => d.tool === 'dsh')!.state).toBe('conflict');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('example');
  });
  it('preserves modifications and added files in deployment rather than overwriting or removing', () => {
    const imported = manager.importLocal(skill(join(fixture, 'source')));
    const deployed = manager.deploy(imported.id, 'dsh', true);
    const target = deployed.deployments.find(d => d.tool === 'dsh')!.path;
    writeFileSync(join(target, 'mine.md'), 'user addition');
    expect(manager.list().skills[0].deployments.find(d => d.tool === 'dsh')!.state).toBe('modified');
    expect(manager.previewRemove(imported.id).canRemove).toBe(false);
    expect(() => manager.deploy(imported.id, 'dsh', false)).toThrow('修改');
    expect(() => manager.deploy(imported.id, 'dsh', true)).toThrow('修改');
    expect(() => manager.remove(imported.id)).toThrow('修改');
    expect(readFileSync(join(target, 'mine.md'), 'utf8')).toBe('user addition');
  });
  it('preserves empty resources and detects an added empty directory as a user modification', () => {
    const source = skill(join(fixture, 'source'));
    mkdirSync(join(source, 'empty-resource'));
    const imported = manager.importLocal(source);
    const deployed = manager.deploy(imported.id, 'codex', true);
    const path = deployed.deployments.find(d => d.tool === 'codex')!.path;
    expect(existsSync(join(path, 'empty-resource'))).toBe(true);
    mkdirSync(join(path, 'user-empty'));
    expect(() => manager.deploy(imported.id, 'codex', false)).toThrow('修改');
    expect(existsSync(join(path, 'user-empty'))).toBe(true);
  });
  it('rejects symlink imports and aliased tool roots without modifying their targets', () => {
    const source = skill(join(fixture, 'source'));
    const outside = join(fixture, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => manager.importLocal(source)).toThrow('符号链接');
    const imported = manager.importLocal(skill(join(fixture, 'ordinary'), 'ordinary'));
    const target = manager.targets.find(t => t.tool === 'dsh')!;
    mkdirSync(dirname(target.directory), { recursive: true });
    symlinkSync(outside, target.directory, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => manager.deploy(imported.id, 'dsh', true)).toThrow('符号链接');
    expect(readdirSync(outside)).toEqual([]);
  });
  it('scans existing tool skills read-only and leaves the originals unmanaged', () => {
    const target = manager.targets.find(t => t.tool === 'codex')!;
    const original = skill(join(target.directory, 'existing'), 'existing');
    skill(join(target.directory, '.system', 'bundled'), 'bundled');
    const result = manager.scanFromTool('codex');
    expect(result.imported.map(s => s.name)).toEqual(['existing']);
    expect(result.imported[0].source.tool).toBe('codex');
    manager.remove(result.imported[0].id);
    expect(existsSync(original)).toBe(true);
  });
  it('materializes a tool link only when its complete bundle stays inside the user directory', () => {
    const target = manager.targets.find(t => t.tool === 'codex')!;
    mkdirSync(target.directory, { recursive: true });
    const safe = skill(join(fixture, 'home', '.cc-switch', 'skills', 'shared'), 'shared');
    const outside = skill(join(fixture, 'outside'), 'outside');
    symlinkSync(safe, join(target.directory, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(outside, join(target.directory, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = manager.scanFromTool('codex');
    expect(result.imported.map(s => s.name)).toEqual(['shared']);
    expect(result.skipped.some(s => s.includes('越出'))).toBe(true);
    manager.remove(result.imported[0].id);
    expect(existsSync(join(safe, 'SKILL.md'))).toBe(true);
  });
  it('rolls back filesystem mutations when encrypted metadata cannot be saved', () => {
    const imported = manager.importLocal(skill(join(fixture, 'source')));
    const target = join(manager.targets.find(t => t.tool === 'codex')!.directory, 'example');
    store.fail = true;
    expect(() => manager.deploy(imported.id, 'codex', true)).toThrow('store unavailable');
    expect(existsSync(target)).toBe(false);
    store.fail = false;
    manager.deploy(imported.id, 'codex', true);
    store.fail = true;
    expect(() => manager.deploy(imported.id, 'codex', false)).toThrow('store unavailable');
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(() => manager.remove(imported.id)).toThrow('store unavailable');
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(manager.readFile(imported.id).content).toContain('example');
  });
  it('removes only owned deployment and library copies after backup and can export bundles', () => {
    const imported = manager.importLocal(skill(join(fixture, 'source')));
    const target = manager.deploy(imported.id, 'codex', true).deployments.find(d => d.tool === 'codex')!.path;
    const exported = manager.exportTo(imported.id, join(fixture, 'export'));
    expect(existsSync(join(exported, 'SKILL.md'))).toBe(true);
    expect(() => manager.exportTo(imported.id, join(fixture, 'export'))).toThrow('未覆盖');
    manager.remove(imported.id);
    expect(manager.list().skills).toEqual([]);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(exported)).toBe(true);
    expect(existsSync(join(fixture, 'source', 'SKILL.md'))).toBe(true);
  });
});

describe('public GitHub repository imports', () => {
  const sha = 'a'.repeat(40);
  const readme = '---\nname: repo-skill\ndescription: From a repository.\n---\nInstructions.';
  function repositoryFetcher(symlink = false): typeof fetch {
    return (async (url: string | URL | Request) => {
      const path = String(url);
      if (path === 'https://api.github.com/repos/org/skills') return Response.json({ default_branch: 'main' });
      if (path.includes('/commits/')) return Response.json({ sha });
      if (path.includes('/git/trees/')) return Response.json({ sha, tree: [{ path: 'skills/repo-skill/SKILL.md', type: 'blob', mode: '100644', size: readme.length }, { path: 'skills/repo-skill/resource.txt', type: 'blob', mode: symlink ? '120000' : '100644', size: 4 }, { path: 'unrelated/big.bin', type: 'blob', mode: '100644', size: 100000000 }] });
      return new Response(path.endsWith('SKILL.md') ? readme : 'text');
    }) as typeof fetch;
  }
  it('pins imports to the resolved commit and downloads only selected skill files', async () => {
    const repo = new SkillManager(store, { homeDir: join(fixture, 'home'), appDataDir: join(fixture, 'data'), fetch: repositoryFetcher() });
    const result = await repo.importRepository({ url: 'https://github.com/org/skills', ref: 'version/one', subpath: 'skills' });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].source.commit).toBe(sha);
    expect(result.imported[0].source.ref).toBe('version/one');
    expect(result.imported[0].files).toEqual(['SKILL.md', 'resource.txt']);
    expect(readdirSync(join(repo.libraryDir, '.downloads'))).toEqual([]);
  });
  it('rejects arbitrary hosts, traversal, and repository symlinks before import', async () => {
    const repo = new SkillManager(store, { homeDir: join(fixture, 'home'), appDataDir: join(fixture, 'data'), fetch: repositoryFetcher(true) });
    await expect(repo.importRepository({ url: 'https://github.com/org/skills', subpath: '../escape' })).rejects.toThrow('路径');
    await expect(repo.importRepository({ url: 'https://example.com/org/skills' })).rejects.toThrow('仅支持');
    await expect(repo.importRepository({ url: 'https://github.com/org/skills', subpath: 'skills' })).rejects.toThrow('符号链接');
    expect(repo.list().skills).toEqual([]);
  });
});
