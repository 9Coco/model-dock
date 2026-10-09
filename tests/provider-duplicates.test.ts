import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { Store, type SecretCodec } from '../src/main/store';
import type { ModelInput, Provider } from '../src/shared/types';
import { canonicalProviderUrl, providerIdentity } from '../src/shared/provider-duplicates';
import { resolveBindingModels } from '../src/shared/bindings';

const folders: string[] = [], stores: Store[] = [];
const codec: SecretCodec = {
  encrypt: value => `fixture:${Buffer.from(value).toString('base64')}`,
  decrypt: value => {
    if (!value.startsWith('fixture:')) throw new Error('Synthetic decryption failure');
    return Buffer.from(value.slice(8), 'base64').toString();
  },
};
async function setup(customCodec = codec) {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-duplicates-')); folders.push(dir);
  const store = await Store.create(dir, customCodec); stores.push(store);
  return { dir, store };
}
function db(store: Store): Database { return (store as unknown as { db: Database }).db; }
/** Deliberately recreate pre-fix rows in an isolated fixture, never a user's database. */
function duplicate(store: Store, provider: Provider, providerId: string, key?: string, patch: Partial<Provider> = {}) {
  const value = { ...provider, ...patch, id: providerId };
  db(store).run('INSERT INTO providers(id,name,kind,base_url,enabled,auth_status,note,preset_id) VALUES(?,?,?,?,?,?,?,?)', [value.id, value.name, value.kind, value.baseUrl, Number(value.enabled), key ? 'ready' : 'missing', value.note, value.presetId ?? 'custom']);
  if (key !== undefined) db(store).run('INSERT INTO secrets(provider_id,ciphertext) VALUES(?,?)', [providerId, codec.encrypt(JSON.stringify({ apiKey: key }))]);
  return store.getProvider(providerId)!;
}
function source(store: Store, name = 'Fixture account', key = 'synthetic-key') {
  return store.saveProvider({ name, kind: 'openai-compatible', baseUrl: 'https://api.fixture.test/v1', enabled: true, apiKey: key, note: 'original note' });
}
function model(store: Store, providerId: string, alias: string, patch: Partial<ModelInput> = {}) {
  return store.saveModel({ providerId, upstreamId: 'shared-upstream', alias, displayName: `Display ${alias}`, wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true, ...patch });
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('API provider identity and repeat-save protection', () => {
  it('normalizes name casing and trailing slash while retaining distinct names and API paths', () => {
    expect(canonicalProviderUrl(' HTTPS://Example.test:443/v1/// ')).toBe('https://example.test/v1');
    const first = { name: ' My Account ', kind: 'openai-compatible' as const, baseUrl: 'https://EXAMPLE.test:443/v1/' };
    expect(providerIdentity(first)).toBe(providerIdentity({ ...first, name: 'my account', baseUrl: 'https://example.test/v1' }));
    expect(providerIdentity(first)).not.toBe(providerIdentity({ ...first, name: 'Other account' }));
    expect(providerIdentity(first)).not.toBe(providerIdentity({ ...first, baseUrl: 'https://example.test' }));
    expect(providerIdentity(first)).not.toBe(providerIdentity({ ...first, baseUrl: 'https://example.test/V1' }));
    expect(providerIdentity(first)).not.toBe(providerIdentity({ ...first, kind: 'grok' }));
  });

  it('fills the existing empty DeepSeek template instead of adding another supplier', async () => {
    const { store } = await setup();
    const original = store.getProvider('deepseek')!;
    const result = store.saveProvider({ name: ' deepseek ', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://API.DEEPSEEK.com:443/', enabled: true, apiKey: 'Bearer synthetic-deepseek', note: 'configured' });
    expect(result.id).toBe(original.id);
    expect(result.hasSecret).toBe(true);
    expect(store.listProviders()).toHaveLength(7);
    expect(store.getSecret(result.id)?.apiKey).toBe('synthetic-deepseek');
  });

  it('returns the same configured record for a normalized same key without overwriting any metadata or bindings', async () => {
    const { store } = await setup();
    const original = source(store);
    const selected = model(store, original.id, 'kept-alias');
    store.saveBinding({ ...store.listBindings()[0], providerIds: [original.id], modelIds: [selected.id], defaultModelId: selected.id, enabled: true });
    const beforeBindings = store.listBindings(), beforeModels = store.listModels();
    const result = store.saveProvider({ name: ' FIXTURE ACCOUNT ', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://API.fixture.test:443/v1/', enabled: false, apiKey: '"Authorization: Bearer synthetic-key"', note: 'must not overwrite' });
    expect(result).toEqual(original);
    expect(store.listBindings()).toEqual(beforeBindings);
    expect(store.listModels()).toEqual(beforeModels);
    expect(store.listProviders()).toHaveLength(8);
  });

  it('a repeated no-key submission preserves the existing credential, enabled status and notes', async () => {
    const { store } = await setup(); const original = source(store);
    expect(store.saveProvider({ name: original.name, kind: original.kind, baseUrl: original.baseUrl, enabled: false, note: 'changed' })).toEqual(original);
    expect(store.getSecret(original.id)?.apiKey).toBe('synthetic-key');
    expect(store.listProviders()).toHaveLength(8);
  });

  it('rejects a different key instead of silently adding or replacing an account', async () => {
    const { store } = await setup(); const original = source(store);
    const providers = store.listProviders();
    expect(() => store.saveProvider({ name: original.name, kind: original.kind, baseUrl: original.baseUrl, enabled: false, apiKey: 'different-synthetic-key' })).toThrow(/不同账号使用不同名称/);
    expect(store.listProviders()).toEqual(providers);
    expect(store.getSecret(original.id)?.apiKey).toBe('synthetic-key');
  });

  it('will not auto-fill a model-bearing keyless record or replace an unreadable credential', async () => {
    const { store } = await setup();
    const keyless = source(store, 'With models', ''); model(store, keyless.id, 'has-model');
    expect(() => store.saveProvider({ name: keyless.name, kind: keyless.kind, baseUrl: keyless.baseUrl, enabled: true, apiKey: 'new-key' })).toThrow(/已存在/);
    const unreadable = source(store, 'Unreadable');
    db(store).run('UPDATE secrets SET ciphertext=? WHERE provider_id=?', ['broken-fixture', unreadable.id]);
    expect(() => store.saveProvider({ name: unreadable.name, kind: unreadable.kind, baseUrl: unreadable.baseUrl, enabled: true, apiKey: 'new-key' })).toThrow(/已存在/);
    expect(store.getProvider(unreadable.id)?.hasSecret).toBe(true);
  });

  it('allows named accounts on a shared endpoint and genuinely different endpoint paths', async () => {
    const { store } = await setup(); const first = source(store);
    const second = source(store, 'Another account', 'another-key');
    const alternate = store.saveProvider({ name: first.name, kind: first.kind, baseUrl: 'https://api.fixture.test', enabled: true, apiKey: 'third-key' });
    expect(new Set([first.id, second.id, alternate.id]).size).toBe(3);
    expect(store.listProviderDuplicates()).toEqual([]);
  });

  it('allows explicit key replacement while preventing an edit from creating another identity collision', async () => {
    const { store } = await setup(); const first = source(store), second = source(store, 'Second');
    store.saveProvider({ ...first, apiKey: 'replacement-key' });
    expect(store.getSecret(first.id)?.apiKey).toBe('replacement-key');
    expect(() => store.saveProvider({ ...second, name: first.name })).toThrow(/已存在/);
    expect(() => store.saveProvider({ ...first, id: 'new-id' })).toThrow(/供应商不存在/);
    const old = duplicate(store, first, 'legacy-duplicate', 'replacement-key');
    expect(store.saveProvider({ ...old, note: 'editable legacy duplicate' }).note).toBe('editable legacy duplicate');
  });

  it('rejects stale explicit edit IDs even when their identity is otherwise unique', async () => {
    const { store } = await setup(); const before = store.listProviders();
    expect(() => store.saveProvider({ id: 'gone-provider', name: 'Unique', kind: 'openai-compatible', baseUrl: 'https://unique.fixture.test', enabled: true, apiKey: 'synthetic' })).toThrow(/供应商不存在.*刷新/);
    expect(store.listProviders()).toEqual(before);
  });
});

describe('explicit legacy duplicate preview and safe merge', () => {
  it('previews without deleting records and keeps the key-bearing account with the most models', async () => {
    const { store } = await setup(); const first = source(store);
    const second = duplicate(store, first, 'second', 'synthetic-key');
    const empty = duplicate(store, first, 'empty', undefined);
    model(store, first.id, 'a'); model(store, second.id, 'b'); model(store, second.id, 'c');
    model(store, empty.id, 'template-model-1'); model(store, empty.id, 'template-model-2'); model(store, empty.id, 'template-model-3');
    const before = store.listProviders(); const [group] = store.listProviderDuplicates();
    expect(store.listProviders()).toEqual(before);
    expect(group).toMatchObject({ targetProviderId: second.id, totalModels: 6, canMerge: true });
    expect(group.providerIds).toEqual([first.id, second.id, empty.id].sort());
    expect(group.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(group)).not.toContain('synthetic-key');
  });

  it('moves every model intact, preserves tool scopes/defaults, updates usage references, and backs up original ciphertext and logs', async () => {
    const { store } = await setup(); const first = source(store), second = duplicate(store, first, 'second', 'synthetic-key', { note: 'second note' });
    const a = model(store, first.id, 'a'), b = model(store, second.id, 'b'), c = model(store, second.id, 'c', { contextWindow: 128000, vision: true });
    const independent = source(store, 'Independent', 'independent-key'), d = model(store, independent.id, 'd');
    const bindings = store.listBindings();
    store.saveBinding({ ...bindings[0], enabled: true, mode: 'direct', providerIds: [first.id], modelIds: [], defaultModelId: a.id });
    store.saveBinding({ ...bindings[1], mode: 'auto', enabled: true, providerIds: [first.id, second.id], modelIds: [], defaultModelId: c.id });
    store.saveBinding({ ...bindings[2], mode: 'auto', enabled: true, providerIds: [first.id, independent.id], modelIds: [a.id, d.id], defaultModelId: d.id });
    store.saveBinding({ ...bindings[3], enabled: false, providerIds: [second.id], modelIds: [b.id], defaultModelId: b.id });
    store.addLog({ alias: a.alias, providerName: first.name, endpoint: '/v1/responses', status: 200, durationMs: 10, providerId: first.id, modelId: a.id, usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } });
    const beforeProviders = store.listProviders(), beforeModels = store.listModels(), beforeBindings = store.listBindings(), beforeLogs = store.logs();
    const beforeScopes = beforeBindings.map(binding => resolveBindingModels(binding, beforeModels, beforeProviders).map(value => value.id).sort());
    const [group] = store.listProviderDuplicates(), result = store.mergeProviderDuplicates(group.providerIds, group.fingerprint);
    expect(result).toMatchObject({ keptProviderId: second.id, removedProviderIds: [first.id], movedModels: 1 });
    expect(store.listModels()).toEqual(beforeModels.map(value => value.providerId === first.id ? { ...value, providerId: second.id } : value));
    expect(store.listBindings().map(binding => resolveBindingModels(binding, store.listModels(), store.listProviders()).map(value => value.id).sort())).toEqual(beforeScopes);
    expect(store.listBindings().map(binding => binding.defaultModelId)).toEqual(beforeBindings.map(binding => binding.defaultModelId));
    expect(store.listBindings().map(binding => binding.modelIds)).toEqual([[a.id], [], [a.id, d.id], [b.id], [], [], [], [], [], []]);
    expect(store.getProvider(second.id)?.note).toBe('second note\n\noriginal note');
    expect(store.logs()).toEqual(beforeLogs);
    expect(store.usageRecords('2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')[0]).toMatchObject({ providerId: second.id, modelId: a.id, usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } });
    expect(store.getSecret(second.id)?.apiKey).toBe('synthetic-key');
    const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const backup = new SQL.Database(readFileSync(result.backupPath));
    expect(backup.exec('SELECT COUNT(*) FROM providers')[0].values[0][0]).toBe(beforeProviders.length);
    expect(backup.exec('SELECT COUNT(*) FROM models')[0].values[0][0]).toBe(beforeModels.length);
    expect(backup.exec(`SELECT ciphertext FROM secrets WHERE provider_id='${first.id}'`)[0].values[0][0]).toBe(codec.encrypt(JSON.stringify({ apiKey: 'synthetic-key' })));
    backup.close();
    if (process.platform !== 'win32') {
      expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(result.backupPath)).mode & 0o777).toBe(0o700);
    }
    expect(store.listProviderDuplicates()).toEqual([]);
  });

  it('keeps a previously empty tool source disabled when the merge introduces models', async () => {
    const { store } = await setup(); const empty = source(store), populated = duplicate(store, empty, 'populated', 'synthetic-key');
    model(store, populated.id, 'other-model');
    const binding = store.listBindings()[0];
    store.saveBinding({ ...binding, enabled: true, mode: 'direct', providerIds: [empty.id], modelIds: [], defaultModelId: '' });
    const [group] = store.listProviderDuplicates(); store.mergeProviderDuplicates(group.providerIds, group.fingerprint);
    const after = store.listBindings()[0];
    expect(after.enabled).toBe(false);
    expect(resolveBindingModels(after, store.listModels(), store.listProviders())).toEqual([]);
  });

  it('preserves selected disabled models for later reactivation without adding models from the unselected duplicate', async () => {
    const { store } = await setup(); const first = source(store), second = duplicate(store, first, 'second', 'synthetic-key');
    const a = model(store, first.id, 'a'), inactive = model(store, first.id, 'inactive', { enabled: false });
    const foreign = model(store, second.id, 'foreign');
    store.saveBinding({ ...store.listBindings()[0], enabled: true, providerIds: [first.id], modelIds: [], defaultModelId: a.id });
    const [group] = store.listProviderDuplicates(); store.mergeProviderDuplicates(group.providerIds, group.fingerprint);
    const binding = store.listBindings()[0];
    expect(binding.modelIds).toEqual([a.id, inactive.id]);
    expect(resolveBindingModels(binding, store.listModels(), store.listProviders()).map(value => value.id)).toEqual([a.id]);
    store.saveModel({ ...store.listModels().find(value => value.id === inactive.id)!, enabled: true });
    expect(resolveBindingModels(store.listBindings()[0], store.listModels(), store.listProviders()).map(value => value.id)).toEqual([a.id, inactive.id]);
    expect(store.listBindings()[0].modelIds).not.toContain(foreign.id);
  });

  it('keeps a tool enabled when its original selected models are all disabled and its explicit merged filter remains safe', async () => {
    const { store } = await setup(); const first = source(store), second = duplicate(store, first, 'second', 'synthetic-key');
    const inactive = model(store, first.id, 'inactive', { enabled: false }); model(store, second.id, 'foreign');
    store.saveBinding({ ...store.listBindings()[0], enabled: true, providerIds: [first.id], modelIds: [] });
    const [group] = store.listProviderDuplicates(); store.mergeProviderDuplicates(group.providerIds, group.fingerprint);
    expect(store.listBindings()[0]).toMatchObject({ enabled: true, modelIds: [inactive.id] });
    expect(resolveBindingModels(store.listBindings()[0], store.listModels(), store.listProviders())).toEqual([]);
    store.saveModel({ ...store.listModels().find(value => value.id === inactive.id)!, enabled: true });
    expect(resolveBindingModels(store.listBindings()[0], store.listModels(), store.listProviders()).map(value => value.id)).toEqual([inactive.id]);
  });

  it('merges empty credential templates without leaving a misleading credential-saved status', async () => {
    const { store } = await setup(); const first = source(store, 'Empty keys', '');
    duplicate(store, first, 'second', '');
    const [group] = store.listProviderDuplicates(); expect(group.canMerge).toBe(true);
    const result = store.mergeProviderDuplicates(group.providerIds, group.fingerprint);
    expect(store.getProvider(result.keptProviderId)).toMatchObject({ hasSecret: false, authStatus: 'missing' });
    expect(store.getSecret(result.keptProviderId)).toBeUndefined();
  });

  it('rolls back model moves, references, notes and deletions together if a transaction fails', async () => {
    const { store } = await setup(); const first = source(store), second = duplicate(store, first, 'second', 'synthetic-key', { note: 'keep second' });
    const a = model(store, first.id, 'a'); model(store, second.id, 'b'); model(store, second.id, 'c');
    store.saveBinding({ ...store.listBindings()[0], enabled: true, providerIds: [first.id], defaultModelId: a.id });
    const providers = store.listProviders(), models = store.listModels(), bindings = store.listBindings();
    db(store).run("CREATE TRIGGER fail_provider_merge BEFORE DELETE ON providers BEGIN SELECT RAISE(ABORT, 'synthetic rollback trigger'); END");
    const [group] = store.listProviderDuplicates();
    expect(() => store.mergeProviderDuplicates(group.providerIds, group.fingerprint)).toThrow(/synthetic rollback/);
    expect(store.listProviders()).toEqual(providers);
    expect(store.listModels()).toEqual(models);
    expect(store.listBindings()).toEqual(bindings);
    expect(store.getSecret(first.id)?.apiKey).toBe('synthetic-key');
    expect(store.getSecret(second.id)?.apiKey).toBe('synthetic-key');
  });

  it('does not merge subscription providers or separate named accounts', async () => {
    const { store } = await setup();
    const subscription = store.getProvider('grok-build')!;
    duplicate(store, subscription, 'another-grok');
    source(store, 'One'); source(store, 'Two');
    expect(store.listProviderDuplicates()).toEqual([]);
  });

  it.each(['different-key', 'unreadable', 'malformed', 'different-enabled', 'different-preset', 'long-notes'] as const)('rejects %s groups without changing the database', async reason => {
    const { store } = await setup(); const first = source(store), second = duplicate(store, first, 'second', reason === 'different-key' ? 'other-key' : 'synthetic-key');
    if (reason === 'unreadable') db(store).run('UPDATE secrets SET ciphertext=? WHERE provider_id=?', ['broken-fixture', second.id]);
    if (reason === 'malformed') db(store).run('UPDATE secrets SET ciphertext=? WHERE provider_id=?', [codec.encrypt(JSON.stringify({ apiKey: 'synthetic-key', accessToken: 'unexpected' })), second.id]);
    if (reason === 'different-enabled') db(store).run('UPDATE providers SET enabled=0 WHERE id=?', [second.id]);
    if (reason === 'different-preset') db(store).run('UPDATE providers SET preset_id=? WHERE id=?', ['deepseek', second.id]);
    if (reason === 'long-notes') { db(store).run('UPDATE providers SET note=? WHERE id=?', ['a'.repeat(700), first.id]); db(store).run('UPDATE providers SET note=? WHERE id=?', ['b'.repeat(700), second.id]); }
    const before = store.listProviders(), [group] = store.listProviderDuplicates();
    expect(group.canMerge).toBe(false); expect(group.message).not.toContain('synthetic-key');
    expect(() => store.mergeProviderDuplicates(group.providerIds, group.fingerprint)).toThrow();
    expect(store.listProviders()).toEqual(before);
  });

  it.each(['model', 'binding', 'secret', 'added-member', 'other-provider'] as const)('requires a new preview after %s changes', async change => {
    const { store } = await setup(); const first = source(store), second = duplicate(store, first, 'second', 'synthetic-key');
    const a = model(store, first.id, 'a'); const [group] = store.listProviderDuplicates();
    if (change === 'model') store.saveModel({ ...a, displayName: 'Changed' });
    if (change === 'binding') store.saveBinding({ ...store.listBindings()[0], providerIds: [second.id], enabled: true });
    if (change === 'secret') store.setSecret(second.id, { apiKey: 'changed-key' });
    if (change === 'added-member') duplicate(store, first, 'third', 'synthetic-key');
    if (change === 'other-provider') store.saveProvider({ ...store.getProvider('deepseek')!, enabled: false });
    expect(() => store.mergeProviderDuplicates(group.providerIds, group.fingerprint)).toThrow(/已变化/);
    expect(store.getProvider(first.id)).toBeDefined(); expect(store.getProvider(second.id)).toBeDefined();
  });

  it('requires the complete group and valid distinct member IDs', async () => {
    const { store } = await setup(); const first = source(store);
    duplicate(store, first, 'second', 'synthetic-key'); duplicate(store, first, 'third', 'synthetic-key');
    const [group] = store.listProviderDuplicates();
    expect(() => store.mergeProviderDuplicates(group.providerIds.slice(0, 2), group.fingerprint)).toThrow(/已变化/);
    expect(() => store.mergeProviderDuplicates([first.id, first.id], group.fingerprint)).toThrow(/参数/);
    expect(() => store.mergeProviderDuplicates(['missing', first.id], group.fingerprint)).toThrow(/已变化/);
  });
});
