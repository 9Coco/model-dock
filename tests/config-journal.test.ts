import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverConfigJournal, transactConfigFiles } from '../src/main/config-journal';
import { replacePrivateFile } from '../src/main/private-file';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-config-journal-')); roots.push(root);
  const paths = [join(root, 'one.json'), join(root, 'two.json')], states = new Map<string, unknown>(), backups: any[] = [];
  const store = {
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn((_kind: string, value: unknown) => { backups.push(structuredClone(value)); return 'synthetic.enc'; }),
  };
  const key = 'fixture-key', before = { revision: 1 }, after = { revision: 2 };
  const validate = (value: unknown): typeof before | null => {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || !Number.isSafeInteger((value as any).revision)) throw new Error('invalid history');
    return value as typeof before;
  };
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null;
  paths.forEach((path, index) => writeFileSync(path, `before-${index}`)); states.set(key, before);
  const files = paths.map((path, index) => ({ path, before: read(path), after: `after-${index}` }));
  const run = (options = {}) => transactConfigFiles({ store, key, kind: 'fixture', before, after, files, read, write: replacePrivateFile, ...options });
  const recover = () => recoverConfigJournal(store, key, paths, validate, read, replacePrivateFile);
  return { root, paths, states, backups, store, key, before, after, read, files, run, recover };
}

describe('encrypted configuration transaction journals', () => {
  it('keeps history pending at every file commit and only publishes applied history after full validation', () => {
    const f = fixture(), seen: number[] = [];
    f.run({ afterFileCommit: (index: number) => { const journal = f.states.get(f.key) as any; expect(journal.modeldockPending).toBe(1); expect(journal.previous).toEqual(f.before); expect(journal.next).toEqual(f.after); seen.push(index); } });
    expect(seen).toEqual([0, 1]); expect(f.states.get(f.key)).toEqual(f.after);
  });
  it('recovers in reverse commit order so a restored default never references a removed profile', () => {
    const f = fixture(); f.run({ order: [1, 0] }); f.states.set(f.key, f.backups[0]);
    const order: string[] = [];
    recoverConfigJournal(f.store, f.key, f.paths, value => value as typeof f.before, f.read, (path, text) => { order.push(path); replacePrivateFile(path, text); });
    expect(order).toEqual([f.paths[0], f.paths[1]]); expect(f.paths.map(f.read)).toEqual(['before-0', 'before-1']);
  });
  it.each([0, 1])('recovers a durable interrupted transaction after file %s without treating attempted outputs as external edits', index => {
    const f = fixture(); f.run(); const journal = f.backups[0];
    f.files.forEach(file => replacePrivateFile(file.path, file.before));
    for (let committed = 0; committed <= index; committed++) replacePrivateFile(f.files[committed].path, f.files[committed].after);
    f.states.set(f.key, journal);
    expect(f.recover()).toEqual(f.before); expect(f.paths.map(f.read)).toEqual(['before-0', 'before-1']); expect(f.states.get(f.key)).toEqual(f.before);
    f.run(); expect(f.states.get(f.key)).toEqual(f.after);
  });
  it('refuses every recovery write if any interrupted file has an external modification', () => {
    const f = fixture(); f.run(); const journal = f.backups[0];
    f.states.set(f.key, journal); writeFileSync(f.paths[1], 'external');
    expect(() => f.recover()).toThrow('外部修改'); expect(f.paths.map(f.read)).toEqual(['after-0', 'external']); expect(f.states.get(f.key)).toEqual(journal);
  });
  it('retains a pending journal if final persistence mutates then throws and an external edit prevents rollback', () => {
    const f = fixture();
    f.store.setManagedState.mockImplementation((key, value) => {
      f.states.set(key, structuredClone(value));
      if ((value as any)?.revision === 2) { writeFileSync(f.paths[0], 'external'); throw new Error('final persistence failed'); }
    });
    expect(() => f.run()).toThrow('回滚遇到外部修改'); expect(f.read(f.paths[0])).toBe('external');
    expect((f.states.get(f.key) as any).modeldockPending).toBe(1); expect(() => f.recover()).toThrow('外部修改');
  });
  it('validates recorded paths and both history versions before recovering anything', () => {
    const f = fixture(); f.run(); const journal = f.backups[0]; journal.files[0].path = join(f.root, 'foreign.json'); f.states.set(f.key, journal);
    expect(() => f.recover()).toThrow('恢复记录无效'); expect(f.paths.map(f.read)).toEqual(['after-0', 'after-1']); expect(existsSync(journal.files[0].path)).toBe(false);
    journal.files[0].path = f.paths[0]; journal.next = { revision: 'invalid' }; f.states.set(f.key, journal);
    expect(() => f.recover()).toThrow('invalid history'); expect(f.paths.map(f.read)).toEqual(['after-0', 'after-1']);
  });
  it('fails before writing credentials when the complete recovery journal exceeds the encrypted-store bound', () => {
    const f = fixture(), large = 'x'.repeat(4 * 1024 * 1024);
    expect(() => f.run({ files: f.files.map(file => ({ ...file, after: large })) })).toThrow('过大');
    expect(f.paths.map(f.read)).toEqual(['before-0', 'before-1']); expect(f.backups).toHaveLength(0); expect(f.states.get(f.key)).toEqual(f.before);
  });
});
