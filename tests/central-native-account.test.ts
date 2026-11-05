import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { CentralNativeAccounts, CentralNativeAccountError } from '../src/main/central-native-account';
import type { CentralCredentials, CentralTransfer } from '../src/main/central-api';
import type { SubscriptionUsage } from '../src/shared/auth-types';
import { relayAccountView } from '../src/main/relay-client-import';
import { JETBRAINS_RELAY_BASE_URL } from '../src/shared/presets';
import { QUOTA_CACHE_TTL_MS } from '../src/shared/quota-display';

const NOW = Date.parse('2030-01-01T00:00:00Z'), KEY = 'synthetic-central-local-key-independent', PRIVATE = 'SYNTHETIC_PRIVATE_CENTRAL_SOURCE_BODY';
const roots: string[] = [], stores: Store[] = [], managers: CentralNativeAccounts[] = [];
const transfer = (user = 'a'): CentralTransfer => ({ version: 1, environment: 'prod', licenseId: 'license-' + user, refreshToken: 'PRIVATE_SOURCE_REFRESH_' + user });
function credentials(user = 'a', until = NOW + 3_600_000): CentralCredentials {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return { token: `${b64({ alg: 'RS256' })}.${b64({ exp: until / 1000, sub: user, marker: PRIVATE })}.c3ludGhldGlj`, accountId: 'account-' + user, accountLabel: '合成 Central 用户 ' + user, licenseId: 'license-' + user, expiresAt: until };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-central-native-')); roots.push(dir); let source = transfer(), clock = NOW, failEncryption = false;
  const codec = { encrypt(value: string) { if (failEncryption && value.includes('"nativeCentral"')) throw new Error(PRIVATE); return 'fixture:' + Buffer.from(value).toString('base64'); }, decrypt(value: string) { return Buffer.from(value.slice(8), 'base64').toString(); } };
  const store = await Store.create(dir, codec); stores.push(store);
  const reader = { read: vi.fn(async () => structuredClone(source)) };
  const usage = (): SubscriptionUsage => ({ status: 'ready', queriedAt: new Date(clock).toISOString(), windows: [{ id: 'native-license', label: '官方 AI 额度', total: 100, remaining: 80, unit: 'AI Credits' }], message: '合成官方额度' });
  const api = { connect: vi.fn(async (value: CentralTransfer, _signal?: AbortSignal) => credentials(value.licenseId.slice(-1))), quota: vi.fn(async (_credentials: CentralCredentials, _signal?: AbortSignal) => usage()) };
  const localKey = vi.fn(() => KEY), manager = new CentralNativeAccounts(store, reader, api, localKey, () => undefined, () => clock); managers.push(manager);
  const preview = async () => (await manager.preview()).candidates[0].id, imported = async () => manager.import(await preview());
  return { dir, store, codec, reader, api, localKey, manager, usage, preview, imported, change(value: CentralTransfer) { source = value; }, advance(ms: number) { clock += ms; }, failEncryption() { failEncryption = true; },
    view(id: string) { return manager.decorate(relayAccountView(store, store.getProvider(id)!)); }, metadata(id: string) { return store.getManagedState<Record<string, unknown>>(`auth-metadata:${id}`, {}); } };
}
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Central explicit native account import without inference-time CLI or OAuth', () => {
  it('previews one opaque source ticket without networking, source tokens or a provider write', async () => {
    const f = await fixture(), before = f.store.listProviders(); expect(f.reader.read).not.toHaveBeenCalled();
    const preview = await f.manager.preview(); expect(preview.candidates).toHaveLength(1); expect(preview.candidates[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(preview)).not.toMatch(/PRIVATE|refreshToken|license-a|account-a/); expect(f.api.connect).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.store.listProviders()).toEqual(before);
  });
  it('connects explicitly once, brackets source reads, encrypts only verified credentials and keeps upstream tokens out of API Key and renderer views', async () => {
    const f = await fixture(), account = await f.imported(), auth = credentials();
    expect(f.reader.read).toHaveBeenCalledTimes(3); expect(f.api.connect).toHaveBeenCalledTimes(1); expect(f.api.connect.mock.calls[0][0]).toEqual(transfer()); expect(f.api.connect.mock.calls[0][1]).toBeInstanceOf(AbortSignal); expect(f.api.quota).not.toHaveBeenCalled();
    expect(account).toMatchObject({ accountId: 'account-a', displayName: auth.accountLabel, expiresAt: auth.expiresAt, canRefresh: false, canQueryUsage: true, clientImport: { client: 'jetbrains-central', upstreamVerified: true }, usage: { status: 'not-queried', windows: [] } }); expect(account.plan).toBeUndefined();
    expect(f.store.getSecret(account.providerId)).toEqual({ apiKey: KEY }); expect(f.manager.credentials(account.providerId)).toEqual(auth);
    const metadata = JSON.stringify(f.metadata(account.providerId)); expect(metadata).not.toContain(transfer().refreshToken); expect(metadata).not.toHaveProperty('refreshToken');
    const publicView = JSON.stringify({ account, providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings() });
    for (const value of [auth.token, transfer().refreshToken, KEY]) expect(publicView).not.toContain(value);
    const disk = readFileSync(join(f.dir, 'modeldock.sqlite')); expect(disk.includes(Buffer.from(auth.token))).toBe(false);
    const reopened = await Store.create(f.dir, f.codec); stores.push(reopened); const restored = new CentralNativeAccounts(reopened, f.reader, f.api, f.localKey, () => undefined, () => NOW); managers.push(restored);
    const copy = restored.credentials(account.providerId); copy.token = 'caller-mutation'; expect(restored.credentials(account.providerId)).toEqual(auth); expect(f.reader.read).toHaveBeenCalledTimes(3); expect(f.api.connect).toHaveBeenCalledTimes(1);
  });
  it('reuses the explicit same-key provider on account switches and retains user details, models and bindings while invalidating the old quota', async () => {
    const f = await fixture(), first = await f.imported(), provider = f.store.getProvider(first.providerId)!;
    const model = f.store.saveModel({ providerId: provider.id, upstreamId: 'fixture-native-model', alias: 'retained-alias', displayName: '保留模型', wireApi: 'chat-completions', contextWindow: 64000, enabled: true, vision: false, tools: true });
    const binding = f.store.listBindings().find(value => value.id === 'opencode')!; f.store.saveBinding({ ...binding, enabled: true, providerIds: [provider.id], modelIds: [model.id], defaultModelId: model.id, modelSelection: 'selected' });
    f.store.saveProvider({ ...provider, name: '用户改名', note: '用户备注', enabled: false }); const before = { provider: f.store.getProvider(provider.id), models: f.store.listModels(), bindings: f.store.listBindings(), secret: f.store.getSecret(provider.id) };
    await f.manager.refreshUsage(provider.id); const meta = f.metadata(provider.id); f.change(transfer('b')); const second = await f.imported();
    expect(second.providerId).toBe(provider.id); expect(second.accountId).toBe('account-b'); expect(second.usage.status).toBe('not-queried'); expect(f.metadata(provider.id).revision).not.toBe(meta.revision); expect(f.metadata(provider.id).identity).not.toBe(meta.identity);
    expect(f.store.getManagedState(`auth-usage:${provider.id}`, null)).toBeNull(); expect({ provider: f.store.getProvider(provider.id), models: f.store.listModels(), bindings: f.store.listBindings(), secret: f.store.getSecret(provider.id) }).toEqual(before);
  });
  it('does not adopt historical sources on construction or preview and only replaces them on an explicit successful import', async () => {
    const f = await fixture(); const legacy = f.store.saveProvider({ name: '旧 Central Pi 配置', note: '保留', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, apiKey: KEY, enabled: true });
    expect(f.manager.isNativeProvider(legacy.id)).toBe(false); expect(() => f.manager.credentials(legacy.id)).toThrow('连接已变更'); await f.manager.preview(); expect(f.manager.isNativeProvider(legacy.id)).toBe(false);
    const imported = await f.imported(); expect(imported.providerId).toBe(legacy.id); expect(f.manager.isNativeProvider(legacy.id)).toBe(true); expect(f.store.getProvider(legacy.id)?.note).toBe('保留');
  });
  it.each(['before', 'during'] as const)('rejects a source-account/selected-license switch %s OAuth verification without storing it', async when => {
    const f = await fixture(), ticket = await f.preview(), before = f.store.listProviders();
    if (when === 'before') f.change(transfer('b')); else f.api.connect.mockImplementationOnce(async () => { f.change(transfer('b')); return credentials(); });
    await expect(f.manager.import(ticket)).rejects.toThrow('切换'); expect(f.store.listProviders()).toEqual(before); if (when === 'before') expect(f.api.connect).not.toHaveBeenCalled();
  });
  it('rejects stale tickets and concurrent confirmations, and cancels import on shutdown', async () => {
    const f = await fixture(), ticket = await f.preview(); f.advance(5 * 60_000); await expect(f.manager.import(ticket)).rejects.toThrow('过期'); expect(f.api.connect).not.toHaveBeenCalled();
    const g = await fixture(), current = await g.preview(), held = deferred<CentralCredentials>(); g.api.connect.mockReturnValueOnce(held.promise);
    const pending = g.manager.import(current); await vi.waitFor(() => expect(g.api.connect).toHaveBeenCalledTimes(1)); await expect(g.manager.import(current)).rejects.toThrow('正在连接');
    const signal = g.api.connect.mock.calls[0][1]!; g.manager.dispose(); expect(signal.aborted).toBe(true); held.resolve(credentials()); await expect(pending).rejects.toThrow('已停止');
  });
  it('preserves disk and provider state on OAuth rejection, mismatched verified license or failed encrypted persistence', async () => {
    const f = await fixture(), first = await f.imported(), before = f.store.listProviders(), disk = readFileSync(join(f.dir, 'modeldock.sqlite'));
    f.api.connect.mockRejectedValueOnce(new Error(PRIVATE)); const failed = await f.imported().catch(error => error as Error); expect(failed).toBeInstanceOf(CentralNativeAccountError); expect(String(failed)).not.toContain(PRIVATE); expect(f.store.listProviders()).toEqual(before);
    f.api.connect.mockResolvedValueOnce({ ...credentials(), licenseId: 'different-license' }); await expect(f.imported()).rejects.toThrow('许可证');
    f.failEncryption(); await expect(f.imported()).rejects.toThrow('未能保存'); expect(f.store.listProviders()).toEqual(before); expect(readFileSync(join(f.dir, 'modeldock.sqlite'))).toEqual(disk); expect(f.manager.credentials(first.providerId)).toEqual(credentials());
  });
  it('refuses expired/tampered snapshots, retains the native marker and never reconnects automatically', async () => {
    const f = await fixture(), first = await f.imported(); f.advance(3_600_000); expect(() => f.manager.credentials(first.providerId)).toThrow('已过期'); expect(f.view(first.providerId)).toMatchObject({ authStatus: 'expired', canQueryUsage: false }); expect(f.api.connect).toHaveBeenCalledTimes(1);
    const g = await fixture(), imported = await g.imported(), metadata = g.metadata(imported.providerId); g.store.setManagedState(`auth-metadata:${imported.providerId}`, { ...metadata, nativeCentral: { version: 999 } });
    expect(g.manager.isNativeProvider(imported.providerId)).toBe(true); expect(() => g.manager.credentials(imported.providerId)).toThrow(CentralNativeAccountError);
  });
});

describe('Central native quota observations', () => {
  it('queries only the saved credential snapshot, deduplicates refreshes, keeps the named plan unknown and marks old observations stale', async () => {
    const f = await fixture(), account = await f.imported(), held = deferred<SubscriptionUsage>(); f.api.quota.mockReturnValueOnce(held.promise);
    const first = f.manager.refreshUsage(account.providerId), second = f.manager.refreshUsage(account.providerId); expect(second).toBe(first); expect(f.api.quota).toHaveBeenCalledTimes(1); expect(f.api.quota.mock.calls[0][0]).toEqual(credentials()); held.resolve(f.usage());
    const result = await first; expect(result.usage.status).toBe('ready'); expect(result.plan).toBeUndefined(); f.advance(QUOTA_CACHE_TTL_MS); expect(f.view(account.providerId).usage.status).toBe('stale'); expect(f.reader.read).toHaveBeenCalledTimes(3); expect(f.api.connect).toHaveBeenCalledTimes(1);
  });
  it('clears old quota/plan on a safe query failure', async () => {
    const f = await fixture(), first = await f.imported(); await f.manager.refreshUsage(first.providerId); f.api.quota.mockRejectedValueOnce(new Error(PRIVATE));
    const failed = await f.manager.refreshUsage(first.providerId); expect(failed.usage).toMatchObject({ status: 'unavailable', windows: [] }); expect(failed.plan).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain(PRIVATE);
  });
  it.each(['import', 'key', 'delete'] as const)('does not save a late quota response after %s changes', async change => {
    const f = await fixture(), first = await f.imported(), held = deferred<SubscriptionUsage>(); f.api.quota.mockReturnValueOnce(held.promise); const pending = f.manager.refreshUsage(first.providerId);
    if (change === 'import') { f.change(transfer('b')); await f.imported(); }
    else if (change === 'key') f.store.saveProvider({ ...f.store.getProvider(first.providerId)!, apiKey: 'changed_local_key' });
    else { f.manager.providerRemoved(first.providerId); f.store.deleteProvider(first.providerId); }
    held.resolve(f.usage()); await expect(pending).rejects.toThrow(CentralNativeAccountError); expect(f.store.getManagedState(`auth-usage:${first.providerId}`, null)).toBeNull();
  });
});
