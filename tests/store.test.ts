import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Store } from '../src/main/store';
import { resolveBindingModels } from '../src/shared/bindings';
import { restoreToolBinding } from '../src/main/tool-restore-binding';
import initSqlJs from 'sql.js';
import type { ModelInput } from '../src/shared/types';

const folders: string[] = [];
const stores: Store[] = [];
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-store-')); folders.push(dir);
  const codec = { encrypt: (value: string) => `test:${Buffer.from(value).toString('base64')}`, decrypt: (value: string) => Buffer.from(value.slice(5), 'base64').toString() };
  const store = await Store.create(dir, codec); stores.push(store); return { store, dir, codec };
}
describe('request logs without local usage storage', () => {
  it('keeps request metadata without creating usage tables in a fresh store', async () => {
    const { store, dir, codec } = await setup();
    const item = { id: 'request-only', time: '2026-10-07T01:00:00Z', alias: 'test', providerName: 'Native', endpoint: '/v1/responses', status: 200, durationMs: 12 };
    store.addLog(item);
    store.close(); const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.logs()).toEqual([item]);
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const raw = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    try { expect(raw.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'")).toEqual([]); }
    finally { raw.close(); }
  });
  it('preserves legacy usage tables and values without updating or accumulating records', async () => {
    const { store, dir, codec } = await setup(); store.close();
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const filename = join(dir, 'modeldock.sqlite'), legacy = new SQL.Database(readFileSync(filename));
    legacy.run('CREATE TABLE usage_events(id TEXT PRIMARY KEY, provider_id TEXT, input_tokens INTEGER)');
    legacy.run('INSERT INTO usage_events VALUES(?, ?, ?)', ['historical', 'historical-provider', 13]);
    const before = legacy.exec('SELECT * FROM usage_events');
    writeFileSync(filename, legacy.export()); legacy.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    reopened.addLog({ alias: 'new', providerName: 'Native', endpoint: '/v1/responses', status: 200, durationMs: 1 }); reopened.close();
    const raw = new SQL.Database(readFileSync(filename));
    try { expect(raw.exec('SELECT * FROM usage_events')).toEqual(before); expect(raw.exec('PRAGMA table_info(usage_events)')[0].values.map(row => row[1])).toEqual(['id', 'provider_id', 'input_tokens']); }
    finally { raw.close(); }
  });
});
function model(providerId: string, alias = 'test/model'): ModelInput { return { providerId, alias, upstreamId: 'upstream-id', displayName: 'Test Model', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true }; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('restoring a captured tool selection', () => {
  it('clears optional selection fields while preserving current unrelated metadata', async () => {
    const { store } = await setup();
    const provider = store.saveProvider({ name: 'Restore source', kind: 'openai-compatible', baseUrl: 'https://restore.example/v1', enabled: true, apiKey: 'synthetic' });
    const first = store.saveModel(model(provider.id, 'restore-first')), second = store.saveModel(model(provider.id, 'restore-second'));
    const binding = store.listBindings().find(row => row.id === 'dsh')!;
    store.saveBinding({ ...binding, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [first.id], defaultModelId: first.id, dshSyncScope: 'selected', note: 'original note' });
    const captured = store.listBindings().find(row => row.id === 'dsh')!;
    store.saveBinding({ ...captured, modelIds: [second.id], defaultModelId: second.id, modelSelection: 'selected', dshSyncScope: 'managed', note: 'current note' });
    store.restoreBindingSelection({ ...captured, providerIds: undefined, modelSelection: undefined, connectionChoices: undefined });
    expect(store.listBindings().find(row => row.id === 'dsh')).toEqual({ ...captured, providerIds: undefined, note: 'current note' });
  });
  it('restores both single-entry connection drafts and refuses removed references before writing', async () => {
    const { store } = await setup();
    const provider = store.saveProvider({ name: 'Restore source', kind: 'openai-compatible', baseUrl: 'https://restore.example/v1', enabled: true, apiKey: 'synthetic' });
    const savedModel = store.saveModel({ ...model(provider.id, 'restore-codex'), wireApi: 'responses' });
    const binding = store.listBindings().find(row => row.id === 'codex')!;
    store.saveBinding({ ...binding, enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: [], defaultModelId: savedModel.id });
    const captured = store.listBindings().find(row => row.id === 'codex')!;
    store.saveBinding({ ...captured, mode: 'aggregate', modelIds: [savedModel.id], modelSelection: 'selected' });
    store.restoreBindingSelection(captured);
    expect(store.listBindings().find(row => row.id === 'codex')).toEqual(captured);
    store.restoreBindingSelection({ ...captured, modelSelection: undefined, connectionChoices: undefined });
    expect(store.listBindings().find(row => row.id === 'codex')?.connectionChoices).toBeUndefined();
    store.deleteProvider(provider.id);
    const afterRemoval = store.listBindings();
    expect(() => store.restoreBindingSelection(captured)).toThrow('来源已不存在');
    expect(store.listBindings()).toEqual(afterRemoval);
  });
});

describe('model reasoning effort persistence', () => {
  it('round-trips supported levels and the default level through reopen', async () => {
    const { store, dir, codec } = await setup();
    const source = store.listProviders()[0];
    const saved = store.saveModel({ ...model(source.id, 'reasoning/model'), reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' });
    expect(saved.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(saved.defaultReasoningEffort).toBe('medium');
    store.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    const loaded = reopened.listModels().find(item => item.alias === 'reasoning/model')!;
    expect(loaded.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(loaded.defaultReasoningEffort).toBe('medium');
  });
  it('rejects unknown or duplicate levels and a default outside the supported list', async () => {
    const { store } = await setup();
    const source = store.listProviders()[0];
    expect(() => store.saveModel({ ...model(source.id, 'unknown-level'), reasoningEfforts: ['ultra' as never] })).toThrow('思考强度级别无效');
    expect(() => store.saveModel({ ...model(source.id, 'duplicate-level'), reasoningEfforts: ['low', 'low'] })).toThrow('思考强度级别无效');
    expect(() => store.saveModel({ ...model(source.id, 'foreign-default'), reasoningEfforts: ['low'], defaultReasoningEffort: 'high' })).toThrow('默认思考强度');
    expect(() => store.saveModel({ ...model(source.id, 'empty-default'), reasoningEfforts: [], defaultReasoningEffort: 'low' })).toThrow('默认思考强度');
    expect(store.listModels()).toEqual([]);
  });
  it('normalizes models without reasoning metadata to empty levels and no default', async () => {
    const { store } = await setup();
    const source = store.listProviders()[0];
    const saved = store.saveModel(model(source.id, 'plain/model'));
    expect(saved.reasoningEfforts).toEqual([]);
    expect(saved.defaultReasoningEffort).toBeUndefined();
    expect(store.listModels()[0].reasoningEfforts).toEqual([]);
  });
  it('migrates a pre-reasoning models table without losing existing rows', async () => {
    const { store, dir, codec } = await setup();
    const source = store.listProviders()[0];
    store.saveModel(model(source.id, 'legacy/model')); store.close();
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const legacy = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    legacy.run('ALTER TABLE models DROP COLUMN reasoning_efforts');
    legacy.run('ALTER TABLE models DROP COLUMN default_reasoning_effort');
    writeFileSync(join(dir, 'modeldock.sqlite'), legacy.export()); legacy.close();
    const migrated = await Store.create(dir, codec); stores.push(migrated);
    const loaded = migrated.listModels().find(item => item.alias === 'legacy/model')!;
    expect(loaded.reasoningEfforts).toEqual([]);
    expect(loaded.defaultReasoningEffort).toBeUndefined();
  });
});

describe('separate model specifications persistence and migration', () => {
  it('round-trips high input/output limits and explicit false capabilities without adding unknown fields', async () => {
    const { store, dir, codec } = await setup();
    const source = store.listProviders()[0];
    const saved = store.saveModel({ ...model(source.id, 'high-budget'), contextWindow: 1050000,
      maxInputTokens: 922000, maxOutputTokens: 128000, thinking: true, reasoningEffortFormat: 'responses',
      adaptiveThinking: false, minThinkingBudget: 1024, maxThinkingBudget: 32768 });
    const plain = store.saveModel({ ...model(source.id, 'no-new-specs'), maxInputTokens: undefined });
    expect(plain).not.toHaveProperty('maxInputTokens');
    store.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listModels()).toEqual([saved, plain]);
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const raw = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    try {
      expect(JSON.parse(String(raw.exec('SELECT specs_json FROM models WHERE id=?', [saved.id])[0].values[0][0]))).toEqual({
        maxInputTokens: 922000, maxOutputTokens: 128000, thinking: true, reasoningEffortFormat: 'responses',
        adaptiveThinking: false, minThinkingBudget: 1024, maxThinkingBudget: 32768,
      });
      expect(raw.exec('SELECT specs_json FROM models WHERE id=?', [plain.id])[0].values[0][0]).toBe('{}');
    } finally { raw.close(); }
  });
  it('migrates only the new specification container and preserves old model values and object shape', async () => {
    const { store, dir, codec } = await setup();
    const saved = store.saveModel({ ...model(store.listProviders()[0].id, 'old-model'), contextWindow: 128000, tools: false,
      reasoningEfforts: [], enabled: false }); store.close();
    const filename = join(dir, 'modeldock.sqlite');
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const old = new SQL.Database(readFileSync(filename)); old.run('ALTER TABLE models DROP COLUMN specs_json');
    writeFileSync(filename, old.export()); old.close();
    const clientDir = join(dir, 'client'); mkdirSync(clientDir); const client = join(clientDir, 'settings.json'); writeFileSync(client, '{"keep":"old-client"}');
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listModels()).toEqual([saved]);
    expect(readFileSync(client, 'utf8')).toBe('{"keep":"old-client"}');
    reopened.close(); const raw = new SQL.Database(readFileSync(filename));
    try {
      const columns = raw.exec('PRAGMA table_info(models)')[0].values;
      expect(columns.filter(row => row[1] === 'specs_json')).toHaveLength(1);
      expect(raw.exec('SELECT specs_json FROM models')[0].values).toEqual([['{}']]);
    } finally { raw.close(); }
  });
  it.each([
    { maxOutputTokens: -1 }, { maxInputTokens: 1.5 }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { thinking: 'true' }, { adaptiveThinking: 1 }, { reasoningEffortFormat: 'unknown' },
    { minThinkingBudget: 2048, maxThinkingBudget: 1024 },
  ])('rejects malformed specifications and rolls back the complete batch (%j)', async invalid => {
    const { store } = await setup(); const source = store.listProviders()[0];
    expect(() => store.saveModels([model(source.id, 'valid-first'), { ...model(source.id, 'invalid-second'), ...invalid } as ModelInput])).toThrow();
    expect(store.listModels()).toEqual([]);
  });
  it('retains explicit zero/false and ignores invalid or unrelated keys when reading stored JSON', async () => {
    const { store, dir, codec } = await setup(); const source = store.listProviders()[0];
    const saved = store.saveModel({ ...model(source.id, 'zero-false'), maxOutputTokens: 0, maxInputTokens: 0, thinking: false, adaptiveThinking: false });
    store.close(); const filename = join(dir, 'modeldock.sqlite');
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const raw = new SQL.Database(readFileSync(filename));
    raw.run('UPDATE models SET specs_json=? WHERE id=?', [JSON.stringify({ maxOutputTokens: 0, maxInputTokens: 0, thinking: false,
      adaptiveThinking: false, unrelated: 'ignored', alias: 'forged', minThinkingBudget: -1, reasoningEffortFormat: 1 }), saved.id]);
    writeFileSync(filename, raw.export()); raw.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened); expect(reopened.listModels()).toEqual([saved]);
  });
});

describe('real SQLite storage', () => {
  it('encrypts private managed backups through the existing codec without copying unrelated SQLite contents', async () => {
    const { store, dir, codec } = await setup();
    const source = store.listProviders().find(provider => provider.kind === 'openai-compatible')!;
    store.setSecret(source.id, { apiKey: 'PRIVATE_UNRELATED_ACCOUNT_KEY' });
    const payload = { version: 1, target: 'synthetic-profile', previous: { apiKey: 'PRIVATE_MANAGED_OLD_KEY' }, models: [{ id: 'managed-model' }] };
    const first = store.createManagedBackup('copilot-sync', payload), second = store.createManagedBackup('copilot-sync', payload);
    expect(first).not.toBe(second); expect(relative(join(dir, 'backups'), first).startsWith('..')).toBe(false);
    const bytes = readFileSync(first, 'utf8');
    expect(bytes.startsWith('test:')).toBe(true); expect(bytes).not.toContain('PRIVATE_MANAGED_OLD_KEY'); expect(bytes).not.toContain('PRIVATE_UNRELATED_ACCOUNT_KEY');
    expect(JSON.parse(codec.decrypt(bytes))).toEqual(payload);
    expect(codec.decrypt(bytes)).not.toContain('PRIVATE_UNRELATED_ACCOUNT_KEY');
    expect(bytes.startsWith('SQLite format 3')).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(first).mode & 0o777).toBe(0o600); expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
    }
  });
  it('rejects invalid managed backup names and payloads before creating any backup files', async () => {
    const { store, dir } = await setup();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const kind of ['../outside', '', 'with/slash', 'invalid\nkind']) expect(() => store.createManagedBackup(kind, { id: 'fixture' })).toThrow('类型无效');
    expect(() => store.createManagedBackup('copilot-sync', undefined)).toThrow('加密管理备份');
    expect(() => store.createManagedBackup('copilot-sync', circular)).toThrow('加密管理备份');
    expect(() => store.createManagedBackup('copilot-sync', 'x'.repeat(8 * 1024 * 1024 + 1))).toThrow('加密管理备份');
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });
  it('contains secret-bearing codec failures and never writes a plaintext fallback backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeldock-managed-backup-')); folders.push(dir);
    let broken = false;
    const codec = { encrypt(value: string) { if (broken) throw new Error('PRIVATE_CODEC_FAILURE'); return `test:${Buffer.from(value).toString('base64')}`; }, decrypt(value: string) { return Buffer.from(value.slice(5), 'base64').toString(); } };
    const store = await Store.create(dir, codec); stores.push(store); broken = true;
    let failure: unknown; try { store.createManagedBackup('copilot-sync', { apiKey: 'PRIVATE_MANAGED_KEY' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain('无法创建加密管理备份'); expect(String(failure)).not.toMatch(/PRIVATE_|apiKey/);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });
  it('retains main-only ID tokens through the credential codec and reopen without exposing provider snapshots', async () => {
    const { store, dir, codec } = await setup();
    const source = store.listProviders().find(provider => provider.kind === 'codex')!;
    const secret = { accessToken: 'PRIVATE_SQL_ACCESS', idToken: 'PRIVATE_SQL_ID_TOKEN', refreshToken: 'PRIVATE_SQL_REFRESH', accountId: 'synthetic-workspace' };
    store.setSecret(source.id, secret);
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.getSecret(source.id)).toEqual(secret);
    const snapshot = JSON.stringify(reopened.listProviders());
    expect(snapshot).not.toContain('PRIVATE_SQL_');
    expect(snapshot).not.toContain('idToken');
    expect(readFileSync(join(dir, 'modeldock.sqlite')).includes(Buffer.from(secret.idToken))).toBe(false);
    expect(() => reopened.setSecret(source.id, { ...secret, idToken: 'invalid\nidentity-token' })).toThrow('凭据字段无效');
    expect(reopened.getSecret(source.id)).toEqual(secret);
  });

  it('seeds unconfigured sources, no invented usable models, and ten disabled tool bindings', async () => {
    const { store, dir } = await setup();
    expect(store.listProviders()).toHaveLength(7);
    expect(store.listProviders().map(provider => provider.presetId)).toEqual(['anthropic', 'deepseek', 'volcengine-agent', 'volcengine-token', 'qwen-token', 'codex-subscription', 'grok-build']);
    expect(store.listProviders().every(p => !p.hasSecret && p.authStatus === 'missing')).toBe(true);
    expect(store.listModels()).toEqual([]);
    expect(store.listBindings()).toHaveLength(10);
    expect(store.listBindings().map(binding => binding.id)).toEqual(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm']);
    expect(store.listBindings().every(b => !b.enabled && b.modelIds.length === 0 && !b.defaultModelId)).toBe(true);
    expect(readFileSync(join(dir, 'modeldock.sqlite')).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  });

  it('persists models, bindings, keys and encoded secrets across process-like reopen without exposing snapshots', async () => {
    const { store, dir, codec } = await setup();
    const p = store.saveProvider({ name: 'Mock', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1', enabled: true, apiKey: 'private-api-key-test' });
    const m = store.saveModel(model(p.id));
    const binding = store.listBindings().find(b => b.id === 'dsh')!;
    store.saveBinding({ ...binding, enabled: true, providerIds: undefined, modelIds: [m.id], defaultModelId: m.id });
    const localKey = store.gatewayKey();
    store.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.getSecret(p.id)?.apiKey).toBe('private-api-key-test');
    expect(reopened.gatewayKey()).toBe(localKey);
    expect(reopened.listModels()[0].alias).toBe(m.alias);
    expect(reopened.listBindings().find(b => b.id === 'dsh')?.defaultModelId).toBe(m.id);
    expect(JSON.stringify(reopened.listProviders())).not.toContain('private-api-key-test');
    expect(readFileSync(join(dir, 'modeldock.sqlite')).toString()).not.toContain('private-api-key-test');
    const rotated = reopened.rotateGatewayKey();
    expect(rotated).not.toBe(localKey);
    expect(rotated).toMatch(/^md_[a-f0-9]{64}$/);
  });

  it('enforces aliases, provider references and binding model existence, then cascades deletion safely', async () => {
    const { store } = await setup();
    const p = store.saveProvider({ name: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.test', enabled: true });
    const first = store.saveModel(model(p.id));
    expect(() => store.saveModel(model(p.id))).toThrow(/别名/);
    expect(() => store.saveModel(model('missing', 'other'))).toThrow(/供应商/);
    const binding = store.listBindings()[0];
    expect(() => store.saveBinding({ ...binding, modelIds: ['missing'] })).toThrow(/不存在/);
    expect(() => store.saveBinding({ ...binding, defaultModelId: first.id })).toThrow(/默认/);
    store.saveBinding({ ...binding, mode: 'aggregate', enabled: true, providerIds: undefined, modelIds: [first.id], defaultModelId: first.id });
    store.setSecret(p.id, { apiKey: 'test-token' });
    store.deleteProvider(p.id);
    expect(store.listModels()).toEqual([]);
    expect(store.getSecret(p.id)).toBeUndefined();
    expect(store.listBindings()[0].modelIds).toEqual([]);
    expect(store.listBindings()[0].defaultModelId).toBe('');
  });

  it('does not resurrect providers deliberately deleted by the user', async () => {
    const { store, dir, codec } = await setup();
    for (const p of store.listProviders()) store.deleteProvider(p.id);
    store.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listProviders()).toEqual([]);
  });

  it('stores same-named models from different sources with stable distinct routes and duplicate display names', async () => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'First Plan', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true });
    const b = store.saveProvider({ name: 'Second Plan', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    const first = store.saveModel({ ...model(a.id, 'glm-5.3'), upstreamId: 'glm-5.3', displayName: 'glm-5.3' });
    const second = store.saveModel({ ...model(b.id, 'glm-5.3'), upstreamId: 'glm-5.3', displayName: 'glm-5.3' });
    expect(first.alias).toBe('glm-5.3');
    expect(second.alias).toBe(`${b.id}/glm-5.3`);
    expect(store.listModels().map(value => value.displayName)).toEqual(['glm-5.3', 'glm-5.3']);
    store.saveProvider({ ...b, name: 'Renamed Plan' });
    expect(store.listModels().find(value => value.id === second.id)?.alias).toBe(second.alias);
    expect(() => store.saveModel(model(b.id, 'glm-5.3'))).toThrow('同一供应商');
    expect(() => store.saveModel(model(b.id, second.alias))).toThrow('同一供应商');
  });

  it('preserves an old qualified route on local-name edit after removal of the bare route', async () => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'First', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true });
    const b = store.saveProvider({ name: 'Second', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    store.saveModel(model(a.id, 'glm'));
    const second = store.saveModel(model(b.id, 'glm'));
    const binding = store.listBindings()[0];
    store.saveBinding({ ...binding, mode: 'aggregate', enabled: true, providerIds: [b.id], defaultModelId: second.id });
    store.deleteProvider(a.id);
    const edited = store.saveModel({ ...second, alias: 'glm', displayName: 'Edited name' });
    expect(edited.alias).toBe(second.alias);
    expect(store.listBindings()[0].defaultModelId).toBe(second.id);
  });

  it('rolls back a batch whose repeated local name resolves to a same-source duplicate', async () => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'First', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true });
    const b = store.saveProvider({ name: 'Second', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    const existing = store.saveModel(model(a.id, 'glm'));
    expect(() => store.saveModels([model(b.id, 'glm'), { ...model(b.id, 'glm'), upstreamId: 'different-upstream' }])).toThrow('同一供应商');
    expect(store.listModels()).toEqual([existing]);
  });

  it('handles a namespace already occupied by a different source without allowing a repeated same-source save', async () => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'First', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true });
    const b = store.saveProvider({ name: 'Second', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    store.saveModel(model(a.id, 'glm'));
    store.saveModel(model(a.id, `${b.id}/glm`));
    expect(store.saveModel(model(b.id, 'glm')).alias).toBe(`${b.id}/glm-2`);
    expect(() => store.saveModel(model(b.id, 'glm'))).toThrow('同一供应商');
  });

  it('can persist and edit long namespaced routes without renaming existing models during reopen', async () => {
    const { store, dir, codec } = await setup();
    const a = store.saveProvider({ name: 'First', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true });
    const b = store.saveProvider({ name: 'Second', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    const name = 'a'.repeat(200);
    store.saveModel(model(a.id, name));
    const namespaced = store.saveModel(model(b.id, name));
    expect(namespaced.alias).toBe(`${b.id}/${name}`);
    store.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listModels().find(value => value.id === namespaced.id)?.alias).toBe(namespaced.alias);
    expect(reopened.saveModel({ ...namespaced, alias: name, displayName: 'Edited' }).alias).toBe(namespaced.alias);
  });

  it('rejects credential URLs, insecure remote URLs and gateway self-loops', async () => {
    const { store } = await setup();
    const input = { name: 'Unsafe', kind: 'openai-compatible' as const, enabled: true };
    for (const baseUrl of ['http://remote.example/v1', 'https://user:secret@example.test', 'http://localhost:18181/v1', 'http://127.0.0.1:18181', 'https://example.test?key=secret']) expect(() => store.saveProvider({ ...input, baseUrl })).toThrow();
    expect(store.saveProvider({ ...input, baseUrl: 'http://127.0.0.1:28282/v1' }).baseUrl).toBe('http://127.0.0.1:28282/v1');
    store.setGatewayPort(28282);
    expect(() => store.saveProvider({ ...input, baseUrl: 'http://localhost:28282/v1' })).toThrow(/循环/);
  });

  it('allows incomplete preset/custom drafts, but rejects unknown presets and kind mismatches', async () => {
    const { store } = await setup();
    const draft = store.saveProvider({ name: 'Token draft', kind: 'openai-compatible', presetId: 'volcengine-token', baseUrl: '', enabled: true, apiKey: 'draft-key' });
    expect(draft.baseUrl).toBe(''); expect(draft.presetId).toBe('volcengine-token');
    expect(store.saveProvider({ name: 'Custom draft', kind: 'openai-compatible', presetId: 'custom', baseUrl: '', enabled: false }).presetId).toBe('custom');
    expect(() => store.saveProvider({ name: 'Wrong', kind: 'codex', presetId: 'deepseek', baseUrl: '', enabled: true })).toThrow(/预设/);
    expect(() => store.saveProvider({ name: 'Unknown', kind: 'openai-compatible', presetId: 'unknown' as never, baseUrl: '', enabled: true })).toThrow(/预设/);
  });

  it('validates source-based modes and clears deleted direct sources without silently choosing another', async () => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'A', kind: 'openai-compatible', baseUrl: 'https://a.example.test/v1', enabled: true });
    const b = store.saveProvider({ name: 'B', kind: 'openai-compatible', baseUrl: 'https://b.example.test/v1', enabled: true });
    const am = store.saveModel({ ...model(a.id, 'a'), wireApi: 'responses' }); const bm = store.saveModel({ ...model(b.id, 'b'), wireApi: 'responses' });
    const direct = store.listBindings().find(binding => binding.id === 'codex')!;
    expect(() => store.saveBinding({ ...direct, mode: 'direct', enabled: true, providerIds: [a.id, b.id] })).toThrow(/恰好/);
    expect(() => store.saveBinding({ ...direct, mode: 'aggregate', enabled: true, providerIds: [] })).toThrow(/至少/);
    expect(() => store.saveBinding({ ...direct, enabled: true, providerIds: ['missing'] })).toThrow(/来源/);
    expect(() => store.saveBinding({ ...direct, mode: 'direct', enabled: true, providerIds: [a.id], defaultModelId: bm.id })).toThrow(/默认/);
    store.saveBinding({ ...direct, mode: 'direct', enabled: true, providerIds: [a.id], modelIds: [], defaultModelId: am.id });
    const aggregate = store.listBindings().find(binding => binding.id === 'opencode')!;
    store.saveBinding({ ...aggregate, mode: 'aggregate', enabled: true, providerIds: [a.id, b.id], modelIds: [], defaultModelId: am.id });
    store.deleteProvider(a.id);
    const remainingDirect = store.listBindings().find(binding => binding.id === 'codex')!;
    expect(remainingDirect.providerIds).toEqual([]); expect(remainingDirect.enabled).toBe(false); expect(remainingDirect.defaultModelId).toBe('');
    const remainingAggregate = store.listBindings().find(binding => binding.id === 'opencode')!;
    expect(remainingAggregate.providerIds).toEqual([b.id]); expect(remainingAggregate.enabled).toBe(true); expect(remainingAggregate.defaultModelId).toBe('');
  });
  it.each(['opencode', 'dsh', 'vscode', 'copilot'] as const)('preserves legacy auto multi-entry providers for %s on removal', async tool => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'Direct A', kind: 'openai-compatible', baseUrl: 'https://a.example.test/v1', enabled: true });
    const b = store.saveProvider({ name: 'Direct B', kind: 'openai-compatible', baseUrl: 'https://b.example.test/v1', enabled: true });
    const am = store.saveModel(model(a.id, 'direct-a')), bm = store.saveModel(model(b.id, 'direct-b'));
    const binding = store.listBindings().find(binding => binding.id === tool)!;
    store.saveBinding({ ...binding, mode: 'auto', enabled: true, providerIds: [a.id, b.id], modelSelection: 'selected', modelIds: [am.id, bm.id], defaultModelId: am.id });
    const saved = store.listBindings().find(binding => binding.id === tool)!;
    expect(resolveBindingModels(saved, store.listModels(), store.listProviders()).map(model => model.id)).toEqual([am.id, bm.id]);
    store.deleteProvider(a.id);
    expect(store.listBindings().find(binding => binding.id === tool)).toMatchObject({ enabled: true, providerIds: [b.id], modelIds: [bm.id], defaultModelId: '' });
  });
  it('persists exact empty aggregation selections and rejects defaults outside the enabled selection', async () => {
    const { store, dir, codec } = await setup();
    const source = store.saveProvider({ name: 'Selected aggregate', kind: 'openai-compatible', baseUrl: 'https://selected.example.test/v1', enabled: true });
    const chosen = store.saveModel(model(source.id, 'chosen')), excluded = store.saveModel(model(source.id, 'excluded'));
    const binding = store.listBindings().find(binding => binding.id === 'codex')!;
    const selected = { ...binding, mode: 'aggregate' as const, enabled: true, providerIds: [source.id], modelSelection: 'selected' as const, modelIds: [chosen.id], defaultModelId: chosen.id };
    expect(() => store.saveBinding({ ...selected, defaultModelId: excluded.id })).toThrow('默认模型');
    expect(() => store.saveBinding({ ...selected, modelIds: [], defaultModelId: chosen.id })).toThrow('默认模型');
    for (const value of ['unknown', null]) expect(() => store.saveBinding({ ...selected, modelSelection: value as any })).toThrow('模型选择方式');
    store.saveBinding(selected);
    store.deleteModel(chosen.id);
    expect(store.listBindings().find(binding => binding.id === 'codex')).toMatchObject({ enabled: true, modelSelection: 'selected', modelIds: [], defaultModelId: '' });
    store.saveModel(model(source.id, 'subsequently-added'));
    store.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    const empty = reopened.listBindings().find(binding => binding.id === 'codex')!;
    expect(empty).toMatchObject({ enabled: true, modelSelection: 'selected', modelIds: [], defaultModelId: '' });
    expect(resolveBindingModels(empty, reopened.listModels(), reopened.listProviders())).toEqual([]);
    // A caller that omits the new optional metadata must not widen an already
    // exact selection; an explicit all change is required to opt back in.
    const { modelSelection: _selection, ...omitted } = empty;
    reopened.saveBinding(omitted);
    expect(reopened.listBindings().find(binding => binding.id === 'codex')?.modelSelection).toBe('selected');
    reopened.saveBinding({ ...empty, modelSelection: 'all', defaultModelId: excluded.id });
    expect(resolveBindingModels(reopened.listBindings().find(binding => binding.id === 'codex')!, reopened.listModels(), reopened.listProviders())).toHaveLength(2);
  });
  it('does not expand an exact aggregate selection after its only selected provider is removed and restores that selection on rollback', async () => {
    const { store } = await setup();
    const a = store.saveProvider({ name: 'Selected A', kind: 'openai-compatible', baseUrl: 'https://selected-a.example.test/v1', enabled: true });
    const b = store.saveProvider({ name: 'Excluded B', kind: 'openai-compatible', baseUrl: 'https://excluded-b.example.test/v1', enabled: true });
    const chosen = store.saveModel(model(a.id, 'selected-a')); store.saveModel(model(b.id, 'excluded-b'));
    const binding = store.listBindings().find(binding => binding.id === 'codex')!;
    store.saveBinding({ ...binding, mode: 'aggregate', enabled: true, providerIds: [a.id, b.id], modelSelection: 'selected', modelIds: [chosen.id], defaultModelId: chosen.id });
    const before = store.listBindings().find(binding => binding.id === 'codex')!;
    const checkpoint = store.beginProviderRemoval(a.id);
    const after = store.listBindings().find(binding => binding.id === 'codex')!;
    expect(after).toMatchObject({ enabled: true, providerIds: [b.id], modelSelection: 'selected', modelIds: [], defaultModelId: '' });
    const added = store.saveModel(model(b.id, 'excluded-new-b'));
    expect(resolveBindingModels(store.listBindings().find(binding => binding.id === 'codex')!, store.listModels(), store.listProviders())).toEqual([]);
    store.restoreProviderRemoval(checkpoint);
    expect(store.listBindings().find(binding => binding.id === 'codex')).toEqual(before);
    expect(resolveBindingModels(before, store.listModels(), store.listProviders()).map(model => model.id)).toEqual([chosen.id]);
    expect(store.listModels().some(model => model.id === added.id)).toBe(true);
  });
  it('rolls back a failed official restoration without converting a legacy all-model binding into an exact empty selection', async () => {
    const { store } = await setup();
    const source = store.saveProvider({ name: 'Legacy restoration', kind: 'openai-compatible', baseUrl: 'https://legacy-restore.example.test/v1', enabled: true });
    const first = store.saveModel(model(source.id, 'legacy-first'));
    const binding = store.listBindings().find(binding => binding.id === 'codex')!;
    store.saveBinding({ ...binding, mode: 'aggregate', enabled: true, providerIds: [source.id], modelIds: [], defaultModelId: first.id });
    const previous = store.listBindings().find(binding => binding.id === 'codex')!;
    expect(previous.modelSelection).toBeUndefined();
    await expect(restoreToolBinding(store, 'codex', async () => {
      const disabled = store.listBindings().find(binding => binding.id === 'codex')!;
      expect(disabled.enabled).toBe(false); expect(disabled.modelSelection).toBeUndefined();
      throw new Error('native restoration rejected');
    })).rejects.toThrow('native restoration rejected');
    expect(store.listBindings().find(binding => binding.id === 'codex')).toEqual(previous);
    const added = store.saveModel(model(source.id, 'legacy-later'));
    expect(resolveBindingModels(store.listBindings().find(binding => binding.id === 'codex')!, store.listModels(), store.listProviders()).map(model => model.id)).toEqual([first.id, added.id]);
  });
  it('migrates legacy single API auto to direct without touching client files or expanding its model filter', async () => {
    const { store, dir, codec } = await setup();
    const source = store.saveProvider({ name: 'Legacy auto', kind: 'openai-compatible', baseUrl: 'https://legacy.example.test/v1', enabled: true });
    const selected = store.saveModel({ ...model(source.id, 'legacy-selected'), wireApi: 'responses' }); store.saveModel({ ...model(source.id, 'legacy-excluded'), wireApi: 'responses' });
    const binding = store.listBindings().find(binding => binding.id === 'codex')!;
    store.saveBinding({ ...binding, mode: 'direct', enabled: true, providerIds: [source.id], modelIds: [selected.id], defaultModelId: selected.id });
    const before = store.listBindings(); store.close();
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const legacy = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    legacy.run("UPDATE bindings SET mode='auto', connection_choices=NULL WHERE id='codex'"); legacy.run('ALTER TABLE bindings DROP COLUMN model_selection'); writeFileSync(join(dir, 'modeldock.sqlite'), legacy.export()); legacy.close();
    const codexDir = join(dir, '.codex'); mkdirSync(codexDir);
    const clientFile = join(codexDir, 'config.toml'), original = 'model = "official-model"\n'; writeFileSync(clientFile, original);
    const migrated = await Store.create(dir, codec); stores.push(migrated);
    expect(migrated.listBindings()).toEqual(before);
    expect(resolveBindingModels(migrated.listBindings().find(binding => binding.id === 'codex')!, migrated.listModels(), migrated.listProviders()).map(model => model.id)).toEqual([selected.id]);
    expect(readFileSync(clientFile, 'utf8')).toBe(original);
  });
  it('persists automatic multi-source selections and supports clearing them without silently losing an enabled source', async () => {
    const { store, dir, codec } = await setup();
    const a = store.saveProvider({ name: 'Auto A', kind: 'openai-compatible', baseUrl: 'https://a.example.test/v1', enabled: true });
    const b = store.saveProvider({ name: 'Auto B', kind: 'openai-compatible', baseUrl: 'https://b.example.test/v1', enabled: true });
    const am = store.saveModel(model(a.id, 'auto-a')), bm = store.saveModel(model(b.id, 'auto-b'));
    const binding = store.listBindings().find(binding => binding.id === 'vscode')!;
    expect(binding.mode).toBe('direct');
    store.saveBinding({ ...binding, mode: 'auto', providerIds: [a.id, b.id], modelIds: [], defaultModelId: bm.id, enabled: true });
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'vscode')).toMatchObject({ mode: 'auto', providerIds: [a.id, b.id], modelIds: [], defaultModelId: bm.id });
    const current = reopened.listBindings().find(binding => binding.id === 'vscode')!;
    expect(() => reopened.saveBinding({ ...current, providerIds: [], defaultModelId: '', enabled: true })).toThrow(/至少/);
    reopened.saveBinding({ ...current, providerIds: [], modelIds: [], defaultModelId: '', enabled: false });
    expect(reopened.listBindings().find(binding => binding.id === 'vscode')).toMatchObject({ mode: 'auto', providerIds: [], enabled: false });
    expect(reopened.listModels().map(model => model.id)).toEqual([am.id, bm.id]);
  });

  it('defaults VS Code to selected custom endpoints, persists explicit managed opt-out and validates synchronization scope', async () => {
    const { store, dir, codec } = await setup();
    const binding = store.listBindings().find(binding => binding.id === 'vscode')!;
    expect(binding.vscodeSyncScope).toBe('selected');
    expect(store.listBindings().filter(binding => binding.id !== 'vscode').every(binding => binding.vscodeSyncScope === undefined)).toBe(true);
    store.saveBinding({ ...binding, vscodeSyncScope: 'managed' });
    const { vscodeSyncScope: _scope, ...omittedScope } = store.listBindings().find(binding => binding.id === 'vscode')!;
    store.saveBinding(omittedScope);
    expect(store.listBindings().find(binding => binding.id === 'vscode')?.vscodeSyncScope).toBe('managed');
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'vscode')?.vscodeSyncScope).toBe('managed');
    const current = reopened.listBindings().find(binding => binding.id === 'vscode')!;
    expect(() => reopened.saveBinding({ ...current, vscodeSyncScope: 'everything' as any })).toThrow('同步范围无效');
    expect(() => reopened.saveBinding({ ...current, vscodeSyncScope: null as any })).toThrow('同步范围无效');
    const codexBinding = reopened.listBindings().find(binding => binding.id === 'codex')!;
    expect(() => reopened.saveBinding({ ...codexBinding, vscodeSyncScope: 'selected' })).toThrow('仅适用于 VS Code');
    reopened.saveBinding({ ...current, vscodeSyncScope: 'selected' });
    expect(reopened.listBindings().find(binding => binding.id === 'vscode')?.vscodeSyncScope).toBe('selected');
  });

  it('migrates a missing VS Code scope once without writing external client files, changing secrets or resetting later opt-out', async () => {
    const { store, dir, codec } = await setup();
    const source = store.listProviders().find(provider => provider.kind === 'codex')!;
    const secret = { accessToken: 'SYNTHETIC_MIGRATION_ACCESS', refreshToken: 'SYNTHETIC_MIGRATION_REFRESH' }; store.setSecret(source.id, secret);
    const oldBindings = store.listBindings(), oldSources = store.listProviders(); store.close();
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const oldDb = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    oldDb.run('ALTER TABLE bindings DROP COLUMN vscode_sync_scope');
    writeFileSync(join(dir, 'modeldock.sqlite'), oldDb.export()); oldDb.close();
    const clientDir = join(dir, 'Code', 'User'); mkdirSync(clientDir, { recursive: true });
    const clientFile = join(clientDir, 'chatLanguageModels.json'), clientText = '[{"name":"Old package","vendor":"customendpoint","models":[]}]'; writeFileSync(clientFile, clientText);
    const migrated = await Store.create(dir, codec); stores.push(migrated);
    expect(migrated.listBindings().find(binding => binding.id === 'vscode')?.vscodeSyncScope).toBe('selected');
    expect(migrated.getSecret(source.id)).toEqual(secret); expect(migrated.listProviders()).toEqual(oldSources);
    expect(migrated.listBindings().map(({ vscodeSyncScope: _scope, ...binding }) => binding)).toEqual(oldBindings.map(({ vscodeSyncScope: _scope, ...binding }) => binding));
    expect(readFileSync(clientFile, 'utf8')).toBe(clientText);
    migrated.saveBinding({ ...migrated.listBindings().find(binding => binding.id === 'vscode')!, vscodeSyncScope: 'managed' }); migrated.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'vscode')?.vscodeSyncScope).toBe('managed'); expect(readFileSync(clientFile, 'utf8')).toBe(clientText);
    const raw = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    expect(raw.exec("SELECT DISTINCT vscode_sync_scope FROM bindings WHERE id!='vscode'")[0].values).toEqual([['managed']]); raw.close();
  });

  it('defaults Copilot to selected custom sources and persists explicit managed scope without changing other tools', async () => {
    const { store, dir, codec } = await setup();
    const current = store.listBindings().find(binding => binding.id === 'copilot')!;
    expect(current.copilotSyncScope).toBe('selected');
    expect(store.listBindings().filter(binding => binding.id !== 'copilot').every(binding => binding.copilotSyncScope === undefined)).toBe(true);
    store.saveBinding({ ...current, copilotSyncScope: 'managed' });
    const { copilotSyncScope: _scope, ...omitted } = store.listBindings().find(binding => binding.id === 'copilot')!;
    store.saveBinding(omitted);
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'copilot')?.copilotSyncScope).toBe('managed');
    expect(() => reopened.saveBinding({ ...current, copilotSyncScope: 'invalid' as any })).toThrow('Copilot 同步范围无效');
    expect(() => reopened.saveBinding({ ...current, copilotSyncScope: null as any })).toThrow('Copilot 同步范围无效');
    expect(() => reopened.saveBinding({ ...store.listBindings().find(binding => binding.id === 'vscode')!, copilotSyncScope: 'selected' })).toThrow('仅适用于 Copilot');
  });
  it('defaults DSH to selected sources and keeps explicit opt-out without widening a binding', async () => {
    const { store, dir, codec } = await setup();
    const current = store.listBindings().find(binding => binding.id === 'dsh')!;
    expect(current.dshSyncScope).toBe('selected');
    expect(store.listBindings().filter(binding => binding.id !== 'dsh').every(binding => binding.dshSyncScope === undefined)).toBe(true);
    store.saveBinding({ ...current, dshSyncScope: 'managed' });
    const { dshSyncScope: _scope, ...omitted } = store.listBindings().find(binding => binding.id === 'dsh')!;
    store.saveBinding(omitted);
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'dsh')).toEqual({ ...current, dshSyncScope: 'managed' });
    expect(() => reopened.saveBinding({ ...current, dshSyncScope: 'invalid' as any })).toThrow('DSH 同步范围无效');
    expect(() => reopened.saveBinding({ ...current, dshSyncScope: null as any })).toThrow('DSH 同步范围无效');
    expect(() => reopened.saveBinding({ ...current, id: 'codex', dshSyncScope: 'managed' })).toThrow('仅适用于 DSH');
  });
  it('migrates a legacy DSH binding scope without writing native client files', async () => {
    const { store, dir, codec } = await setup();
    const before = store.listBindings(); store.close();
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const legacy = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    legacy.run('ALTER TABLE bindings DROP COLUMN dsh_sync_scope');
    writeFileSync(join(dir, 'modeldock.sqlite'), legacy.export()); legacy.close();
    const home = join(dir, '.dsh'); mkdirSync(home);
    const original = '- id: llm-deepseek\n  disabled: false\n';
    writeFileSync(join(home, 'cordis.patch.yml'), original);
    const migrated = await Store.create(dir, codec); stores.push(migrated);
    expect(migrated.listBindings().find(binding => binding.id === 'dsh')?.dshSyncScope).toBe('selected');
    expect(migrated.listBindings().map(({ dshSyncScope: _scope, ...binding }) => binding)).toEqual(before.map(({ dshSyncScope: _scope, ...binding }) => binding));
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe(original);
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false);
  });
  it('removes a provider atomically then restores its exact encrypted secret, models, auth metadata and affected bindings', async () => {
    const { store, codec } = await setup();
    const source = store.saveProvider({ name: 'Remove fixture', kind: 'openai-compatible', baseUrl: 'https://remove.example.test/v1', apiKey: 'PRIVATE_REMOVE_KEY', enabled: true });
    const other = store.saveProvider({ name: 'Keep fixture', kind: 'openai-compatible', baseUrl: 'https://keep.example.test/v1', enabled: true });
    const selected = store.saveModel(model(source.id, 'remove/a')), second = store.saveModel(model(source.id, 'remove/b')), kept = store.saveModel(model(other.id, 'keep/a'));
    const claudeModel = store.saveModel({ ...model(source.id, 'remove/claude'), wireApi: 'messages' });
    for (const binding of store.listBindings()) store.saveBinding({ ...binding, enabled: true, mode: binding.id === 'codex' || binding.id === 'claude-code' || ['webstorm','intellij-idea','rider','pycharm'].includes(binding.id) ? 'aggregate' : 'auto', providerIds: binding.id === 'claude-code' ? [source.id] : [source.id, other.id], modelIds: binding.id === 'dsh' ? [selected.id] : [], defaultModelId: binding.id === 'claude-code' ? claudeModel.id : selected.id, note: 'original binding metadata' });
    store.setManagedState(`auth-metadata:${source.id}`, { identity: 'SYNTHETIC_ACCOUNT_ID' }); store.setManagedState(`auth-usage:${source.id}`, { status: 'ready', remaining: 72 });
    const beforeProvider = store.getProvider(source.id), beforeModels = store.listModels(), beforeBindings = store.listBindings(), beforeSecret = store.getSecret(source.id);
    const checkpoint = store.beginProviderRemoval(source.id);
    expect(new Set(checkpoint.affectedToolIds)).toEqual(new Set(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm']));
    expect(checkpoint.beforeBindings).toEqual(beforeBindings); expect(checkpoint.afterBindings.every(binding => !binding.providerIds?.includes(source.id))).toBe(true);
    expect(store.getProvider(source.id)).toBeUndefined(); expect(store.getSecret(source.id)).toBeUndefined(); expect(store.listModels().map(model => model.id)).toEqual([kept.id]);
    expect(store.getManagedState(`auth-metadata:${source.id}`, null)).toBeNull(); expect(store.getManagedState(`auth-usage:${source.id}`, null)).toBeNull();
    expect(JSON.stringify(checkpoint)).not.toContain('PRIVATE_REMOVE_KEY'); expect(readFileSync(checkpoint.backupPath, 'utf8')).not.toContain('PRIVATE_REMOVE_KEY');
    const backup = JSON.parse(codec.decrypt(readFileSync(checkpoint.backupPath, 'utf8'))); expect(backup.secret.ciphertext.startsWith('test:')).toBe(true); expect(backup.models.map((entry: any) => entry.id).sort()).toEqual([selected.id, second.id, claudeModel.id].sort());
    // These writes complete while an orchestrator could be awaiting a client;
    // they demonstrate no transaction is held across that asynchronous phase.
    store.addLog({ id: 'during-delete', time: '2026-10-06T09:00:00Z', alias: 'keep/a', providerName: other.name, providerId: other.id, endpoint: '/responses', status: 200, durationMs: 3 });
    store.saveProvider({ ...other, name: 'Kept and edited' });
    store.restoreProviderRemoval(checkpoint);
    expect(store.getProvider(source.id)).toEqual(beforeProvider); expect(store.getSecret(source.id)).toEqual(beforeSecret); expect(store.listModels()).toEqual(beforeModels);
    expect(store.listBindings()).toEqual(beforeBindings); expect(store.getManagedState(`auth-metadata:${source.id}`, null)).toEqual({ identity: 'SYNTHETIC_ACCOUNT_ID' }); expect(store.getManagedState(`auth-usage:${source.id}`, null)).toEqual({ status: 'ready', remaining: 72 });
    expect(store.getProvider(other.id)?.name).toBe('Kept and edited'); expect(store.logs().some(log => log.id === 'during-delete')).toBe(true);
    expect(() => store.restoreProviderRemoval(checkpoint)).toThrow('记录无效或已结束');
  });
  it('rejects restoring over a newly edited affected binding instead of overwriting it', async () => {
    const { store } = await setup();
    const source = store.saveProvider({ name: 'A', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true });
    const other = store.saveProvider({ name: 'B', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    const a = store.saveModel(model(source.id, 'checkpoint-a')), b = store.saveModel(model(other.id, 'checkpoint-b'));
    const current = store.listBindings().find(binding => binding.id === 'vscode')!;
    store.saveBinding({ ...current, mode: 'auto', enabled: true, providerIds: [source.id, other.id], defaultModelId: a.id });
    const checkpoint = store.beginProviderRemoval(source.id), changed = { ...store.listBindings().find(binding => binding.id === 'vscode')!, defaultModelId: b.id, note: 'new user choice' };
    store.saveBinding(changed);
    expect(() => store.restoreProviderRemoval(checkpoint)).toThrow('工具的选择已变化');
    expect(store.listBindings().find(binding => binding.id === 'vscode')).toEqual(changed); expect(store.getProvider(source.id)).toBeUndefined(); expect(existsSync(checkpoint.backupPath)).toBe(true);
  });
  it('rejects new alias occupancy and late auth metadata without clobbering either', async () => {
    const { store } = await setup();
    const source = store.saveProvider({ name: 'A', kind: 'openai-compatible', baseUrl: 'https://a.example.test', enabled: true }), other = store.saveProvider({ name: 'B', kind: 'openai-compatible', baseUrl: 'https://b.example.test', enabled: true });
    const a = store.saveModel(model(source.id, 'checkpoint-reused-alias'));
    const checkpoint = store.beginProviderRemoval(source.id);
    const added = store.saveModel(model(other.id, a.alias));
    expect(() => store.restoreProviderRemoval(checkpoint)).toThrow('其他来源使用'); expect(store.listModels()).toEqual([added]);
    store.deleteModel(added.id); store.setManagedState(`auth-usage:${source.id}`, { late: true });
    expect(() => store.restoreProviderRemoval(checkpoint)).toThrow('数据已变化'); expect(store.getManagedState(`auth-usage:${source.id}`, null)).toEqual({ late: true });
  });
  it('does not expose raw rows and rejects forged or finished removal handles', async () => {
    const { store } = await setup();
    const source = store.saveProvider({ name: 'A', kind: 'openai-compatible', baseUrl: 'https://a.example.test', apiKey: 'PRIVATE_REMOVAL_HANDLE_KEY', enabled: true });
    const checkpoint = store.beginProviderRemoval(source.id);
    expect(Object.keys(checkpoint).sort()).toEqual(['affectedToolIds', 'afterBindings', 'backupPath', 'beforeBindings', 'id', 'providerId']);
    expect(() => store.restoreProviderRemoval({ ...checkpoint, providerId: 'other-source' })).toThrow('记录无效');
    store.finishProviderRemoval(checkpoint); expect(() => store.restoreProviderRemoval(checkpoint)).toThrow('记录无效或已结束'); expect(existsSync(checkpoint.backupPath)).toBe(true);
  });
  it('migrates missing Copilot scope only in SQLite, retaining client bytes and later explicit opt-out', async () => {
    const { store, dir, codec } = await setup();
    const before = store.listBindings(), providers = store.listProviders(); store.close();
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const legacy = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    legacy.run('ALTER TABLE bindings DROP COLUMN copilot_sync_scope'); writeFileSync(join(dir, 'modeldock.sqlite'), legacy.export()); legacy.close();
    const copilotDir = join(dir, '.copilot'); mkdirSync(copilotDir); const clientFile = join(copilotDir, 'data.db');
    const beforeBytes = Buffer.from('SYNTHETIC_NATIVE_DATABASE_NOT_TO_BE_READ_OR_CHANGED'); writeFileSync(clientFile, beforeBytes);
    const migrated = await Store.create(dir, codec); stores.push(migrated);
    expect(migrated.listBindings().find(binding => binding.id === 'copilot')?.copilotSyncScope).toBe('selected');
    expect(migrated.listBindings().map(({ copilotSyncScope: _scope, ...binding }) => binding)).toEqual(before.map(({ copilotSyncScope: _scope, ...binding }) => binding));
    expect(migrated.listProviders()).toEqual(providers); expect(readFileSync(clientFile)).toEqual(beforeBytes);
    migrated.saveBinding({ ...migrated.listBindings().find(binding => binding.id === 'copilot')!, copilotSyncScope: 'managed' }); migrated.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'copilot')?.copilotSyncScope).toBe('managed'); expect(readFileSync(clientFile)).toEqual(beforeBytes);
  });
  it('does not widen a legacy explicit model filter when its last model is removed', async () => {
    const { store } = await setup();
    const p = store.saveProvider({ name: 'P', kind: 'openai-compatible', baseUrl: 'https://p.example.test', enabled: true });
    const selected = store.saveModel(model(p.id, 'selected')); store.saveModel(model(p.id, 'unselected'));
    const binding = store.listBindings().find(b => b.id === 'dsh')!;
    store.saveBinding({ ...binding, enabled: true, providerIds: undefined, modelIds: [selected.id], defaultModelId: selected.id });
    store.deleteModel(selected.id);
    const cleaned = store.listBindings().find(b => b.id === 'dsh')!;
    expect(cleaned.enabled).toBe(false); expect(cleaned.modelIds).toEqual([]); expect(cleaned.defaultModelId).toBe('');
  });

  it('migrates old SQLite schemas without changing credentials, endpoints or explicit legacy filters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeldock-legacy-')); folders.push(dir);
    const codec = { encrypt: (value: string) => `test:${Buffer.from(value).toString('base64')}`, decrypt: (value: string) => Buffer.from(value.slice(5), 'base64').toString() };
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,base_url TEXT NOT NULL,enabled INTEGER NOT NULL,auth_status TEXT NOT NULL,note TEXT NOT NULL);
      CREATE TABLE secrets(provider_id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL);
      CREATE TABLE models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,upstream_id TEXT NOT NULL,alias TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,wire_api TEXT NOT NULL,context_window INTEGER NOT NULL,tools INTEGER NOT NULL,vision INTEGER NOT NULL,enabled INTEGER NOT NULL);
      CREATE TABLE bindings(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,model_ids TEXT NOT NULL,default_model_id TEXT NOT NULL,note TEXT NOT NULL);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    legacy.run('INSERT INTO providers VALUES(?,?,?,?,?,?,?)', ['old-gpt', 'My GPT', 'codex', 'https://chatgpt.com/backend-api/codex', 1, 'ready', 'keep note']);
    const oldUrl = 'https://ark.cn-beijing.volces.com/api/coding/v3';
    legacy.run('INSERT INTO providers VALUES(?,?,?,?,?,?,?)', ['old-vol', 'Old Coding Plan', 'openai-compatible', oldUrl, 1, 'ready', 'legacy']);
    legacy.run('INSERT INTO secrets VALUES(?,?)', ['old-gpt', codec.encrypt(JSON.stringify({ accessToken: 'legacy-access', refreshToken: 'legacy-refresh' }))]);
    legacy.run('INSERT INTO secrets VALUES(?,?)', ['old-vol', codec.encrypt(JSON.stringify({ apiKey: 'legacy-vol-key' }))]);
    legacy.run('INSERT INTO models VALUES(?,?,?,?,?,?,?,?,?,?)', ['old-model', 'old-gpt', 'old-upstream', 'old-alias', 'Old Model', 'responses', 64000, 1, 0, 1]);
    legacy.run('INSERT INTO bindings VALUES(?,?,?,?,?,?)', ['dsh', 'DeepSeek Harness', 1, '["old-model"]', 'old-model', 'keep binding']);
    legacy.run('INSERT INTO bindings VALUES(?,?,?,?,?,?)', ['cursor', 'Cursor', 1, '["old-model"]', 'old-model', 'legacy cursor']);
    legacy.run('INSERT INTO settings VALUES(?,?)', ['gateway_key', codec.encrypt('legacy-local-key')]);
    writeFileSync(join(dir, 'modeldock.sqlite'), legacy.export()); legacy.close();
    const migrated = await Store.create(dir, codec); stores.push(migrated);
    expect(migrated.listProviders()).toHaveLength(2);
    expect(migrated.getProvider('old-vol')?.baseUrl).toBe(oldUrl); expect(migrated.getProvider('old-vol')?.presetId).toBe('volcengine-token');
    expect(migrated.getSecret('old-gpt')).toEqual({ accessToken: 'legacy-access', refreshToken: 'legacy-refresh' });
    expect(migrated.getSecret('old-vol')?.apiKey).toBe('legacy-vol-key'); expect(migrated.gatewayKey()).toBe('legacy-local-key');
    const binding = migrated.listBindings().find(item => item.id === 'dsh')!;
    expect(binding).toMatchObject({ mode: 'aggregate', providerIds: ['old-gpt'], modelIds: ['old-model'], defaultModelId: 'old-model', note: 'keep binding' });
    expect(migrated.listBindings().map(item => item.id)).toEqual(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm']);
    migrated.saveProvider({ ...migrated.getProvider('old-vol')!, name: 'Updated legacy name' });
    migrated.close();
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.getSecret('old-vol')?.apiKey).toBe('legacy-vol-key');
    const raw = new SQL.Database(readFileSync(join(dir, 'modeldock.sqlite')));
    expect(raw.exec("SELECT id FROM bindings WHERE id='cursor'")[0].values).toEqual([['cursor']]); raw.close();
  });
});
