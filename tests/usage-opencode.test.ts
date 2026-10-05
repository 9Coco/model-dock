import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { importToolUsage, type ClientUsageStore } from '../src/main/usage-import';
import { sqliteUsageSnapshot } from '../src/main/usage-opencode';
import type { UsageRecord } from '../src/shared/usage-types';
const fixtures: { root: string; db: DatabaseSync }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); if (!resolve(f.root).startsWith(resolve(tmpdir()))) throw new Error('Unsafe cleanup target'); rmSync(f.root, { recursive: true, force: true }); } });
const at = Date.parse('2026-10-07T03:00:00.000Z');
function setup(v2 = false) {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-opencode-usage-')), directory = join(root, '.local', 'share', 'opencode'); mkdirSync(directory, { recursive: true });
  const filename = join(directory, 'opencode.db'), db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  const session = v2 ? 'session_v2' : 'session', message = v2 ? 'session_message' : 'message';
  db.exec(`CREATE TABLE ${session}(id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER); CREATE TABLE ${message}(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT${v2 ? ',type TEXT' : ''});`);
  db.prepare(`INSERT INTO ${session} VALUES(?,?,?)`).run('session1', at, at);
  const records = new Map<string, UsageRecord>(); const store: ClientUsageStore = { addClientUsage(row) { if (records.has(row.id)) return false; records.set(row.id, row); return true; } };
  const insert = (id: string, changes: Record<string, unknown> = {}, type = 'assistant') => {
    const data = { role: 'assistant', modelID: 'model-demo', providerID: 'openai', time: { created: at, completed: at + 1000 }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 60, write: 40 } }, content: 'PRIVATE_ASSISTANT_CONTENT', ...changes };
    db.prepare(`INSERT INTO ${message} VALUES(${v2 ? '?,?,?,?,?,?' : '?,?,?,?,?'})`).run(id, 'session1', at, at, JSON.stringify(data), ...(v2 ? [type] : []));
  };
  fixtures.push({ root, db }); return { root, directory, filename, db, session, message, records, store, insert, options: { homeDir: root } };
}
const hashes = (folder: string) => Object.fromEntries(readdirSync(folder).map(name => [name, createHash('sha256').update(readFileSync(join(folder, name))).digest('hex')]));
describe('OpenCode V1 / V2 read-only metadata synchronization', () => {
  it('reads committed live WAL metadata and never changes the original DB, WAL, SHM or directory', async () => {
    const f = setup(); f.insert('msg1'); const before = hashes(f.directory);
    const result = await importToolUsage('opencode', f.store, f.options);
    expect(result).toMatchObject({ status: 'ready', scannedFiles: 1, imported: 1 }); expect(hashes(f.directory)).toEqual(before);
    const row = [...f.records.values()][0]; expect(row).toMatchObject({ source: 'client', tool: 'opencode', alias: 'model-demo', providerName: 'openai', status: 0, durationMs: 0, usage: { inputTokens: 200, outputTokens: 25, cachedInputTokens: 60, cacheCreationInputTokens: 40 } });
    expect(JSON.stringify([...f.records.values()]) + JSON.stringify(result)).not.toMatch(/PRIVATE_ASSISTANT_CONTENT|accessToken|apiKey/); expect(JSON.stringify(result)).not.toContain(f.root);
  });
  it('is idempotent on repeated reads and finds WAL-only newly committed events', async () => {
    const f = setup(); f.insert('msg1'); expect((await importToolUsage('opencode', f.store, f.options)).imported).toBe(1);
    expect((await importToolUsage('opencode', f.store, f.options)).imported).toBe(0); const main = readFileSync(f.filename);
    f.insert('msg2', { modelID: 'model-new' }); expect(readFileSync(f.filename)).toEqual(main);
    expect((await importToolUsage('opencode', f.store, f.options)).imported).toBe(1); expect(f.records.size).toBe(2);
  });
  it('prefers V2 current tables over retained frozen V1 history', async () => {
    const f = setup(true); f.db.exec('CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);');
    f.db.prepare('INSERT INTO session VALUES(?)').run('old'); f.db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('old-msg', 'old', at, JSON.stringify({ role: 'assistant', time: { created: at, completed: at }, tokens: { input: 999, output: 999 } }));
    f.insert('v2-msg', { role: undefined, modelID: undefined, providerID: undefined, model: { id: 'gpt-current', providerID: 'azure' } });
    const result = await importToolUsage('opencode', f.store, f.options); expect(result.imported).toBe(1); expect([...f.records.values()][0]).toMatchObject({ alias: 'gpt-current', providerName: 'azure' });
  });
  it('imports terminal V2 compaction counters and waits for unfinished assistant messages', async () => {
    const f = setup(true); f.insert('partial', { time: { created: at }, tokens: { input: 5, output: 1 } });
    f.insert('compaction', { role: undefined, status: 'completed', time: { created: at } }, 'compaction');
    const first = await importToolUsage('opencode', f.store, f.options); expect(first.imported).toBe(1); expect(first.deferredFiles).toBe(1);
    f.db.prepare(`UPDATE ${f.message} SET data=? WHERE id=?`).run(JSON.stringify({ role: 'assistant', modelID: 'final', time: { created: at, completed: at + 10 }, tokens: { input: 10, output: 5 } }), 'partial');
    expect((await importToolUsage('opencode', f.store, f.options)).imported).toBe(1); expect(f.records.size).toBe(2);
  });
  it('does not import user messages, zero allocations, invalid counters or missing final usage', async () => {
    const f = setup(); f.insert('user', { role: 'user', prompt: 'PRIVATE_USER_PROMPT' }); f.insert('zero', { tokens: { input: 0, output: 0 } });
    f.insert('bad', { tokens: { input: -1, output: 5 } }); f.insert('partial', { time: { created: at } });
    const result = await importToolUsage('opencode', f.store, f.options); expect(result.imported).toBe(0); expect(result.deferredFiles).toBe(1); expect(result.skipped).toBe(2); expect(f.records.size).toBe(0);
  });
  it('avoids double-counting after SQLite checkpoints and WAL resets', async () => {
    const f = setup(); f.insert('first'); await importToolUsage('opencode', f.store, f.options); f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    f.insert('second'); expect((await importToolUsage('opencode', f.store, f.options)).imported).toBe(1); expect(f.records.size).toBe(2);
  });
  it('ignores an uncommitted WAL suffix but rejects checksum-corrupted data', async () => {
    const f = setup(); f.insert('first'); const base = readFileSync(f.filename), wal = readFileSync(`${f.filename}-wal`);
    appendFileSync(`${f.filename}-wal`, Buffer.from('PARTIAL_UNCOMMITTED_WRITER_TAIL'));
    expect((await importToolUsage('opencode', f.store, f.options)).imported).toBe(1);
    const damaged = Buffer.from(wal); damaged[damaged.length - 17] ^= 1;
    expect(() => sqliteUsageSnapshot(base, damaged, 64 * 1024 * 1024)).toThrow('校验失败');
  });
  it('reports missing and unknown native layouts explicitly', async () => {
    const f = setup(); const missing = await importToolUsage('opencode', f.store, { ...f.options, opencodeDataDir: join(f.root, 'missing') }); expect(missing.status).toBe('missing');
    f.db.exec(`DROP TABLE ${f.message}`); const unknown = await importToolUsage('opencode', f.store, f.options); expect(unknown.status).toBe('unsupported'); expect(unknown.unsupported).toContain('布局');
  });
  it('enforces bounded files, line metadata and stable paths without creating native sidecars', async () => {
    const f = setup(); f.insert('first'); expect((await importToolUsage('opencode', f.store, { ...f.options, maxFileBytes: 10 })).status).toBe('error');
    const link = join(f.root, 'linked-opencode'); symlinkSync(f.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await importToolUsage('opencode', f.store, { ...f.options, opencodeDataDir: link })).status).toBe('error');
    const journal = `${f.filename}-journal`; writeFileSync(journal, 'pending'); expect((await importToolUsage('opencode', f.store, f.options)).warnings.join()).toContain('事务日志');
  });
});
