import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager, type McpStore } from '../src/main/mcp';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), linkSync: vi.fn(fs.linkSync), renameSync: vi.fn(fs.renameSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(fsyncSync).mockReset(); vi.mocked(linkSync).mockReset(); vi.mocked(renameSync).mockReset(); vi.mocked(unlinkSync).mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-mcp-lock-')); directories.push(root); mkdirSync(join(root, '.copilot'));
  const states = new Map<string, unknown>();
  const store: McpStore = { getManagedState: <T>(key: string, fallback: T) => (states.get(key) ?? fallback) as T, setManagedState: (key, value) => { states.set(key, structuredClone(value)); } };
  const manager = new McpManager(store, { homeDir: root, appDataDir: root });
  manager.save({ name: 'fixture', transport: 'stdio', command: 'synthetic-command', enabledTools: ['copilot'] });
  const filename = join(root, '.copilot', 'mcp-config.json'), lock = filename + '.modeldock.lock';
  return { root, manager, filename, lock };
}
function owner(pid: number) { return JSON.stringify({ version: 1, pid, host: hostname(), token: randomUUID(), createdAt: Date.now() - 60_000 }); }
function successor(lock: string, contents: string) { return lock + '.' + createHash('sha256').update(contents).digest('hex').slice(0, 32); }
function absentOwner() {
  const original = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 2147483647) throw Object.assign(new Error('Synthetic absent owner'), { code: 'ESRCH' });
    return original(pid, signal);
  });
}
describe('MCP configuration lock ownership', () => {
  it('takes over a confirmed dead owner and compacts a crash chain after successful apply', () => {
    const { root, manager, filename, lock } = setup(); absentOwner();
    const first = owner(2147483647), second = owner(2147483647);
    writeFileSync(lock, first); writeFileSync(successor(lock, first), second);
    expect(manager.apply('copilot').changed).toBe(true);
    expect(JSON.parse(readFileSync(filename, 'utf8')).mcpServers.fixture.command).toBe('synthetic-command');
    expect(readdirSync(join(root, '.copilot'))).toEqual(['mcp-config.json']);
  });
  it('never expires a live owner and conservatively retains unknown legacy locks', () => {
    const { manager, filename, lock } = setup(); writeFileSync(filename, '{}');
    const active = owner(process.pid); writeFileSync(lock, active); utimesSync(lock, new Date(0), new Date(0));
    expect(() => manager.apply('copilot')).toThrow('其他 ModelDock'); expect(readFileSync(lock, 'utf8')).toBe(active);
    writeFileSync(lock, ''); utimesSync(lock, new Date(0), new Date(0));
    expect(() => manager.apply('copilot')).toThrow('旧锁'); expect(readFileSync(filename, 'utf8')).toBe('{}');
  });
  it('does not let a competing takeover steal the successor or the published live root', () => {
    const { root, manager, lock } = setup(); absentOwner(); const stale = owner(2147483647); writeFileSync(lock, stale);
    const link = vi.mocked(linkSync).getMockImplementation()!, rename = vi.mocked(renameSync).getMockImplementation()!;
    let successorBlocked = false, rootBlocked = false;
    vi.mocked(linkSync).mockImplementation((source, target) => {
      link(source, target);
      if (String(target) === successor(lock, stale)) {
        expect(() => manager.apply('copilot')).toThrow('其他 ModelDock'); successorBlocked = true;
      }
    });
    vi.mocked(renameSync).mockImplementation((source, target) => {
      rename(source, target);
      if (String(target) === lock) { expect(() => manager.apply('copilot')).toThrow('其他 ModelDock'); rootBlocked = true; }
    });
    expect(manager.apply('copilot').changed).toBe(true); expect(successorBlocked && rootBlocked).toBe(true);
    expect(readdirSync(join(root, '.copilot'))).toEqual(['mcp-config.json']);
  });
  it('preserves the dead record and cleans its own claim when root replacement fails', () => {
    const { root, manager, lock } = setup(); absentOwner(); const stale = owner(2147483647); writeFileSync(lock, stale);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('Synthetic replacement failure'), { code: 'EACCES' }); });
    expect(() => manager.apply('copilot')).toThrow(); expect(readFileSync(lock, 'utf8')).toBe(stale);
    expect(readdirSync(join(root, '.copilot'))).toEqual(['mcp-config.json.modeldock.lock']);
    expect(manager.apply('copilot').changed).toBe(true);
  });
  it('restarts a stale traversal when another writer finishes promotion before it claims the successor', () => {
    const { root, manager, lock } = setup(); absentOwner(); const stale = owner(2147483647); writeFileSync(lock, stale);
    const link = vi.mocked(linkSync).getMockImplementation()!; let competingWrite = false;
    vi.mocked(linkSync).mockImplementation((source, target) => {
      if (String(target) === successor(lock, stale) && !competingWrite) {
        competingWrite = true; expect(manager.apply('copilot').changed).toBe(true);
      }
      link(source, target);
    });
    expect(manager.apply('copilot').changed).toBe(false); expect(competingWrite).toBe(true);
    expect(readdirSync(join(root, '.copilot'))).toEqual(['mcp-config.json']);
  });
  it('bounds traversal of repeated crash records and leaves an unknown lock owner untouched', () => {
    const { manager, filename, lock } = setup(); absentOwner(); let path = lock;
    for (let depth = 0; depth < 34; depth++) { const contents = owner(2147483647); writeFileSync(path, contents); path = successor(lock, contents); }
    expect(() => manager.apply('copilot')).toThrow('其他 ModelDock');
    expect(() => readFileSync(filename)).toThrow();
  });
  it.each(['owner-flush', 'claim', 'promotion', 'apply'] as const)('preserves the original %s failure when lock cleanup also fails', phase => {
    const { manager, filename, lock } = setup(), primary = new Error(`Synthetic ${phase} primary failure`);
    const unlink = vi.mocked(unlinkSync).getMockImplementation()!;
    if (phase === 'promotion') { absentOwner(); writeFileSync(lock, owner(2147483647)); }
    vi.mocked(unlinkSync).mockImplementation(path => {
      // Let ordinary owner temp cleanup finish before the tested failure.
      if (phase === 'owner-flush' || phase === 'claim' || (phase === 'promotion' || phase === 'apply') && vi.mocked(renameSync).mock.calls.length > 0) throw new Error('Synthetic unlink cleanup failure');
      unlink(path);
    });
    if (phase === 'owner-flush') vi.mocked(fsyncSync).mockImplementationOnce(() => { throw primary; });
    else if (phase === 'claim') vi.mocked(linkSync).mockImplementationOnce(() => { throw primary; });
    else vi.mocked(renameSync).mockImplementationOnce(() => { throw primary; });
    let failure: unknown;
    try { manager.apply('copilot'); } catch (error) { failure = error; }
    expect(failure).toBe(primary); expect(() => readFileSync(filename)).toThrow();
  });
});
