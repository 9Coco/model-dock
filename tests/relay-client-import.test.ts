import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { RelayClientImportManager, relayClientImportProvenance, type NativeRelayCandidate, type RelayImportAdapter } from '../src/main/relay-client-import';
import { JETBRAINS_RELAY_BASE_URL, TRAE_RELAY_BASE_URL } from '../src/shared/presets';
import type { RelayAccountKind } from '../src/shared/auth-types';

const directories: string[] = [], stores: Store[] = [];
const PRIVATE = 'PRIVATE_RELAY_IMPORT_TOKEN_STDERR_PATH';
const KEY = 'synthetic-relay-client-import-key';
const kinds: RelayAccountKind[] = ['trae-cn-relay', 'jetbrains-central'];
const candidate = (kind: RelayAccountKind): NativeRelayCandidate => ({ sourceId: `fixture-${kind}`, client: kind === 'trae-cn-relay' ? 'trae-cn' : 'jetbrains-central', clientName: kind === 'trae-cn-relay' ? 'TRAE 中国版' : 'Central CLI', accountId: 'fixture-account', accountLabel: '合成演示账号' });
const baseUrl = (kind: RelayAccountKind) => kind === 'trae-cn-relay' ? TRAE_RELAY_BASE_URL : JETBRAINS_RELAY_BASE_URL;
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-relay-import-')); directories.push(dir);
  let encryptFails = false;
  const codec = { encrypt(value: string) { if (encryptFails && value.includes('"clientImport"')) throw new Error(PRIVATE); return `test:${Buffer.from(value).toString('base64')}`; }, decrypt(value: string) { return Buffer.from(value.slice(5), 'base64').toString(); } };
  const store = await Store.create(dir, codec); stores.push(store);
  const adapters = Object.fromEntries(kinds.map(kind => [kind, { inspect: vi.fn(async () => [candidate(kind)]), perform: vi.fn(async () => ({ upstreamVerified: kind === 'jetbrains-central' })) }])) as Record<RelayAccountKind, RelayImportAdapter & { inspect: ReturnType<typeof vi.fn>; perform: ReturnType<typeof vi.fn> }>;
  const key = vi.fn(() => KEY); let now = Date.parse('2030-01-01T00:00:00Z');
  const manager = new RelayClientImportManager(store, adapters, key, () => now);
  return { dir, store, codec, adapters, key, manager, failEncryption: () => { encryptFails = true; }, repairEncryption: () => { encryptFails = false; }, advance: (ms: number) => { now += ms; } };
}
function state(store: Store) { return { providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]), metadata: store.listProviders().map(provider => [provider.id, store.getManagedState(`auth-metadata:${provider.id}`, null)]) }; }
function seedReferences(store: Store, providerId: string) {
  const model = store.saveModel({ providerId, upstreamId: 'original-upstream', alias: 'original-alias', displayName: '保留模型', wireApi: 'chat-completions', contextWindow: 64000, enabled: true, vision: false, tools: true });
  const binding = store.listBindings().find(row => row.id === 'junie')!;
  store.saveBinding({ ...binding, mode: 'aggregate', enabled: false, providerIds: [providerId], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  return model;
}
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('relay client import tickets and safe failures', () => {
  it('previews metadata only and does not create a key or modify configuration for an empty client', async () => {
    const { store, manager, adapters, key } = await setup(), before = state(store);
    adapters['trae-cn-relay'].inspect.mockResolvedValue([]);
    expect(await manager.preview('trae-cn-relay')).toMatchObject({ kind: 'trae-cn-relay', candidates: [] });
    expect(key).not.toHaveBeenCalled(); expect(adapters['trae-cn-relay'].perform).not.toHaveBeenCalled(); expect(state(store)).toEqual(before);
  });
  it('rejects invalid kinds, mismatched, expired and consumed tickets before repeating native work', async () => {
    const { manager, adapters, key, advance } = await setup();
    await expect(manager.preview('custom-api')).rejects.toThrow('受支持');
    await expect(manager.import('custom-api', 'unknown')).rejects.toThrow('受支持');
    await expect(manager.import('trae-cn-relay', 'unknown')).rejects.toThrow('过期');
    const first = (await manager.preview('trae-cn-relay')).candidates[0];
    expect(Object.keys(first).sort()).toEqual(['accountLabel', 'clientName', 'id']);
    expect(first.id).not.toContain('fixture');
    await expect(manager.import('jetbrains-central', first.id)).rejects.toThrow('过期');
    advance(5 * 60_000 + 1);
    await expect(manager.import('trae-cn-relay', first.id)).rejects.toThrow('过期');
    expect(key).not.toHaveBeenCalled(); expect(adapters['trae-cn-relay'].perform).not.toHaveBeenCalled();
    const fresh = (await manager.preview('trae-cn-relay')).candidates[0];
    await manager.import('trae-cn-relay', fresh.id);
    await expect(manager.import('trae-cn-relay', fresh.id)).rejects.toThrow('过期');
    expect(adapters['trae-cn-relay'].perform).toHaveBeenCalledTimes(1);
  });
  it.each(kinds)('contains raw %s adapter failures and preserves providers, keys, models and selections', async kind => {
    const { store, manager, adapters, dir } = await setup();
    const manual = store.saveProvider({ name: 'Existing manual relay', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: 'http://127.0.0.1:19090/v1', apiKey: 'synthetic-existing-key', enabled: false });
    seedReferences(store, manual.id); const before = state(store), disk = readFileSync(join(dir, 'modeldock.sqlite'));
    const ticket = (await manager.preview(kind)).candidates[0]; adapters[kind].perform.mockRejectedValue(new Error(PRIVATE));
    const failure = await manager.import(kind, ticket.id).catch(error => error);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(PRIVATE); expect(state(store)).toEqual(before); expect(readFileSync(join(dir, 'modeldock.sqlite'))).toEqual(disk);
  });
  it('contains inspection errors without exposing raw client exceptions', async () => {
    const { manager, adapters } = await setup(); adapters['trae-cn-relay'].inspect.mockRejectedValue(new Error(PRIVATE));
    const failure = await manager.preview('trae-cn-relay').catch(error => error);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(PRIVATE);
  });
});

describe('relay provider reuse, provenance and local atomic save', () => {
  it.each(kinds)('reuses %s provider identity and preserves key, models, drafts, name and notes on repeat', async kind => {
    const { store, manager, dir, codec } = await setup();
    let ticket = (await manager.preview(kind)).candidates[0], account = await manager.import(kind, ticket.id);
    expect(account).toMatchObject({ source: 'relay', kind, relayKeyConfigured: true, canRefresh: false, clientImport: { client: candidate(kind).client, accountLabel: '合成演示账号', upstreamVerified: kind === 'jetbrains-central' } });
    expect(JSON.stringify(account)).not.toContain(KEY); expect(account.providerId).toBeTruthy();
    const provider = store.getProvider(account.providerId)!; store.saveProvider({ ...provider, name: '自定义供应商名称', note: '自定义备注', enabled: false }); seedReferences(store, provider.id);
    const before = state(store); ticket = (await manager.preview(kind)).candidates[0]; account = await manager.import(kind, ticket.id);
    expect(account.providerId).toBe(provider.id); expect(state(store)).toEqual(before);
    expect(store.getSecret(provider.id)).toEqual({ apiKey: KEY });
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(state(reopened)).toEqual(state(store)); expect(relayClientImportProvenance(reopened, reopened.getProvider(provider.id)!)).toMatchObject({ client: candidate(kind).client });
  });
  it('does not convert or replace manual TRAE and unrelated custom API records at the managed endpoint', async () => {
    const { store, manager } = await setup();
    const manual = store.saveProvider({ name: 'Manual TRAE', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: TRAE_RELAY_BASE_URL, enabled: false, apiKey: KEY });
    const custom = store.saveProvider({ name: 'Custom API', kind: 'openai-compatible', presetId: 'custom', baseUrl: TRAE_RELAY_BASE_URL, enabled: false, apiKey: KEY });
    seedReferences(store, manual.id); const before = state(store);
    const ticket = (await manager.preview('trae-cn-relay')).candidates[0], account = await manager.import('trae-cn-relay', ticket.id);
    expect(account.providerId).not.toBe(manual.id); expect(account.providerId).not.toBe(custom.id);
    expect(store.getProvider(manual.id)).toEqual(manual); expect(store.getProvider(custom.id)).toEqual(custom);
    expect(store.listModels()).toEqual(before.models); expect(store.listBindings()).toEqual(before.bindings);
  });
  it('does not overwrite a fixed relay whose existing local credential differs', async () => {
    const { store, manager } = await setup();
    const existing = store.saveProvider({ name: 'TRAE with separate key', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, enabled: false, apiKey: 'other-existing-relay-key' });
    const ticket = (await manager.preview('trae-cn-relay')).candidates[0], account = await manager.import('trae-cn-relay', ticket.id);
    expect(account.providerId).not.toBe(existing.id); expect(store.getProvider(existing.id)).toEqual(existing); expect(store.getSecret(existing.id)).toEqual({ apiKey: 'other-existing-relay-key' });
  });
  it('removes the displayed import origin after manual changes to the connection key or destination', async () => {
    const { store, manager } = await setup(); const ticket = (await manager.preview('trae-cn-relay')).candidates[0], account = await manager.import('trae-cn-relay', ticket.id);
    const imported = store.getProvider(account.providerId)!;
    expect(relayClientImportProvenance(store, imported)).toBeDefined();
    const changed = store.saveProvider({ ...imported, apiKey: 'edited-local-relay-key' }); expect(relayClientImportProvenance(store, changed)).toBeUndefined();
    const restored = store.saveProvider({ ...changed, apiKey: KEY }); expect(relayClientImportProvenance(store, restored)).toBeDefined();
    const manual = store.saveProvider({ ...restored, relayMode: 'manual', baseUrl: 'http://127.0.0.1:19091/v1', apiKey: KEY }); expect(relayClientImportProvenance(store, manual)).toBeUndefined();
  });
  it('revokes TRAE provenance after an auth-header edit and does not overwrite that connection', async () => {
    const { store, manager } = await setup(), kind = 'trae-cn-relay'; let ticket = (await manager.preview(kind)).candidates[0];
    const account = await manager.import(kind, ticket.id), imported = store.getProvider(account.providerId)!;
    const edited = store.saveProvider({ ...imported, messagesAuth: 'api-key' });
    expect(relayClientImportProvenance(store, edited)).toBeUndefined();
    ticket = (await manager.preview(kind)).candidates[0]; const second = await manager.import(kind, ticket.id);
    expect(second.providerId).not.toBe(edited.id); expect(store.getProvider(edited.id)).toEqual(edited); expect(store.getSecret(edited.id)).toEqual({ apiKey: KEY });
  });
  it('refuses a non-bearer Central connection edit and retains the original imported connection', async () => {
    const { store, manager } = await setup(), ticket = (await manager.preview('jetbrains-central')).candidates[0];
    const account = await manager.import('jetbrains-central', ticket.id), imported = store.getProvider(account.providerId)!, before = state(store);
    expect(() => store.saveProvider({ ...imported, messagesAuth: 'api-key' })).toThrow('固定本机 Chat 接口');
    expect(state(store)).toEqual(before); expect(relayClientImportProvenance(store, imported)).toBeDefined();
  });
  it('preserves both original in-memory and on-disk state after local persistence fails', async () => {
    const { store, manager, dir, codec } = await setup(); const before = state(store), disk = readFileSync(join(dir, 'modeldock.sqlite'));
    const ticket = (await manager.preview('trae-cn-relay')).candidates[0];
    const blocked = join(dir, 'not-a-directory'); writeFileSync(blocked, 'fixture');
    const mutable = store as unknown as { dataDir: string }; mutable.dataDir = blocked;
    try {
      const failure = await manager.import('trae-cn-relay', ticket.id).catch(error => error);
      expect(String(failure)).toContain('本地记录未能保存'); expect(String(failure)).not.toMatch(/ENOTDIR|PRIVATE_|not-a-directory/);
      expect(state(store)).toEqual(before); expect(readFileSync(join(dir, 'modeldock.sqlite'))).toEqual(disk);
    } finally { mutable.dataDir = dir; }
    const reopened = await Store.create(dir, codec); stores.push(reopened); expect(state(reopened)).toEqual(before);
  });
  it('preserves both original in-memory and on-disk state after metadata encryption fails', async () => {
    const { store, manager, dir, failEncryption, repairEncryption } = await setup(); const before = state(store), disk = readFileSync(join(dir, 'modeldock.sqlite'));
    const ticket = (await manager.preview('trae-cn-relay')).candidates[0]; failEncryption();
    try {
      const failure = await manager.import('trae-cn-relay', ticket.id).catch(error => error);
      expect(String(failure)).toContain('本地记录未能保存'); expect(String(failure)).not.toContain(PRIVATE); expect(state(store)).toEqual(before); expect(readFileSync(join(dir, 'modeldock.sqlite'))).toEqual(disk);
    } finally { repairEncryption(); }
  });
  it('refuses to overwrite an existing provider changed while native import is in progress', async () => {
    const { store, manager, adapters } = await setup();
    const existing = store.saveProvider({ name: 'Existing managed TRAE', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: KEY }); seedReferences(store, existing.id);
    let finish!: (value: { upstreamVerified: boolean }) => void;
    adapters['trae-cn-relay'].perform.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const ticket = (await manager.preview('trae-cn-relay')).candidates[0], pending = manager.import('trae-cn-relay', ticket.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    store.saveProvider({ ...existing, name: 'User changed this during import', note: 'new note', apiKey: 'new-user-key' }); const edited = state(store);
    await expect(manager.import('trae-cn-relay', ticket.id)).rejects.toThrow('正在导入');
    finish({ upstreamVerified: false }); await expect(pending).rejects.toThrow('本地记录未能保存');
    expect(state(store)).toEqual(edited); expect(adapters['trae-cn-relay'].perform).toHaveBeenCalledTimes(1);
  });
});
