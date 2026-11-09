import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { importOpenCodeGo } from '../src/main/opencode-go-import';
import { Store } from '../src/main/store';

let home: string, data: string, store: Store;
const draft = { name: '我的 Go', enabled: true, note: '工作区' };
const legacy = JSON.stringify({ 'opencode-go': { type: 'api', key: 'synthetic-old-go' }, opencode: { type: 'api', key: 'synthetic-other' } });
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'modeldock-go-import-')); data = join(home, '.local', 'share', 'opencode');
  mkdirSync(data, { recursive: true }); store = await Store.create(join(home, 'modeldock'));
  writeFileSync(join(data, 'auth.json'), legacy);
});
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }); });

it('imports only the Go entry, preserving the original file, the existing source and its models on repeat import', () => {
  const source = importOpenCodeGo(store, draft, home, {});
  const models = store.listModels();
  expect(store.getSecret(source.id)?.apiKey).toBe('synthetic-old-go');
  expect(JSON.stringify(source)).not.toContain('synthetic-');
  expect(importOpenCodeGo(store, { ...draft, name: 'different' }, home, {})).toEqual(source);
  expect(store.listModels()).toEqual(models);
  expect(readFileSync(join(data, 'auth.json'), 'utf8')).toBe(legacy);
});

it.each(['integration_id', 'connector_id'])('prefers the active Go workspace in the client database (%s) and does not resurrect deleted credentials', column => {
  const file = join(data, 'opencode.db'), database = new DatabaseSync(file);
  try {
    database.exec('CREATE TABLE credential(id TEXT PRIMARY KEY, '+column+' TEXT, value TEXT, active INTEGER, time_created INTEGER)');
    const add = database.prepare('INSERT INTO credential VALUES (?,?,?,?,?)');
    for (const [id, provider, active, created] of [['newer', 'opencode-go', 0, 100], ['chosen', 'opencode-go', 1, 10], ['other', 'opencode', 1, 200]] as const)
      add.run(id, provider, JSON.stringify({ type: 'key', key: 'synthetic-' + id }), active, created);
    const source = importOpenCodeGo(store, draft, home, {});
    expect(store.getSecret(source.id)?.apiKey).toBe('synthetic-chosen');
    database.prepare('DELETE FROM credential WHERE '+column+'=?').run('opencode-go');
    expect(() => importOpenCodeGo(store, { ...draft, id: source.id }, home, {})).toThrow(/未找到/);
    expect(store.getSecret(source.id)?.apiKey).toBe('synthetic-chosen');
  } finally { database.close(); }
});
