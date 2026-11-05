import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { RelayQuotaCenter, RelayQuotaFailure, type RelayQuotaResult } from '../src/main/relay-quota';
import { RelayClientImportManager, relayAccountView, type RelayImportAdapter } from '../src/main/relay-client-import';
import { JETBRAINS_RELAY_BASE_URL, TRAE_RELAY_BASE_URL } from '../src/shared/presets';
import { QUOTA_CACHE_TTL_MS } from '../src/shared/quota-display';
import type { ProviderInput } from '../src/shared/types';
import type { RelayAccountKind } from '../src/shared/auth-types';

const folders: string[] = [], stores: Store[] = [];
const KEY = 'synthetic-relay-quota-key', PRIVATE = 'SYNTHETIC_PRIVATE_QUOTA_TOKEN_STDERR_PATH';
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-relay-quota-')); folders.push(dir);
  let failMetadata = false;
  const codec = { encrypt(value: string) { if (failMetadata && value.includes('"clientImport"')) throw new Error(PRIVATE); return `test:${Buffer.from(value).toString('base64')}`; }, decrypt(value: string) { return Buffer.from(value.slice(5), 'base64').toString(); } };
  const store = await Store.create(dir, codec); stores.push(store);
  const provider = store.saveProvider({ name: '托管 TRAE', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, apiKey: KEY, enabled: true });
  let clock = Date.parse('2030-01-01T00:00:00Z');
  const result = (accountId = 'currently-active', accountLabel = '当前反代账号'): RelayQuotaResult => ({ accountId, accountLabel, plan: 'Pro', usage: { status: 'ready', queriedAt: new Date(clock).toISOString(), windows: [{ id: 'official-credits', label: '通用积分', total: 100, remaining: 75, remainingPercent: 75, unit: '积分' }], message: '当前活跃账号的官方额度' } });
  const query = vi.fn(async (_key: string) => result());
  const center = new RelayQuotaCenter(store, query, () => clock);
  const adapter = (kind: RelayAccountKind) => ({ inspect: vi.fn(async () => [{ sourceId: 'fixture-client', client: kind === 'trae-cn-relay' ? 'trae-cn' as const : 'jetbrains-central' as const, clientName: '合成客户端', accountId: 'historically-imported', accountLabel: '之前导入的另一个账号' }]), perform: vi.fn(async () => ({ upstreamVerified: false })) });
  const adapters = { 'trae-cn-relay': adapter('trae-cn-relay'), 'jetbrains-central': adapter('jetbrains-central') } satisfies Record<RelayAccountKind, RelayImportAdapter>;
  const importer = new RelayClientImportManager(store, adapters, () => KEY, () => clock);
  const importAccount = async () => importer.import('trae-cn-relay', (await importer.preview('trae-cn-relay')).candidates[0].id);
  return { dir, codec, store, provider, result, query, center, adapters, importer, importAccount,
    advance: (ms: number) => { clock += ms; }, failMetadata: (value: boolean) => { failMetadata = value; },
    cache: () => store.getManagedState(`auth-usage:${provider.id}`, null),
    view: () => center.decorate(relayAccountView(store, store.getProvider(provider.id)!)),
  };
}
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('TRAE quota coordinator with a real private Store', () => {
  it('uses the queried active account identity while preserving independent historical import provenance', async () => {
    const f = await fixture(); const imported = await f.importAccount(); expect(imported.providerId).toBe(f.provider.id);
    const before = { providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings() };
    const result = await f.center.refresh(f.provider.id);
    expect(f.query).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(result).toMatchObject({ source: 'relay', canQueryUsage: true, accountId: 'currently-active', displayName: '当前反代账号', plan: 'Pro', clientImport: { accountLabel: '之前导入的另一个账号' }, usage: { status: 'ready', windows: [{ remaining: 75, unit: '积分' }] } });
    expect(JSON.stringify(result)).not.toContain(KEY); expect(JSON.stringify(result)).not.toContain('historically-imported');
    expect({ providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings() }).toEqual(before);
    const reopened = await Store.create(f.dir, f.codec); stores.push(reopened);
    const restored = new RelayQuotaCenter(reopened, f.query).decorate(relayAccountView(reopened, reopened.getProvider(f.provider.id)!));
    expect(restored.accountId).toBe('currently-active'); expect(restored.clientImport?.accountLabel).toBe('之前导入的另一个账号');
  });
  it('deduplicates concurrent refreshes for one connection without querying on account-list decoration', async () => {
    const f = await fixture(), held = deferred<RelayQuotaResult>(); f.query.mockReturnValueOnce(held.promise);
    expect(f.view().usage).toMatchObject({ status: 'not-queried', windows: [] }); expect(f.query).not.toHaveBeenCalled();
    const first = f.center.refresh(f.provider.id), second = f.center.refresh(f.provider.id);
    expect(second).toBe(first); expect(f.query).toHaveBeenCalledTimes(1);
    held.resolve(f.result()); expect(await first).toEqual(await second);
    await f.center.refresh(f.provider.id); expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('never queries manual, custom, noncanonical, Central or keyless sources', async () => {
    const f = await fixture();
    const inputs: ProviderInput[] = [
      { name: '手动相同地址', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: KEY },
      { name: '手动其他地址', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: 'http://localhost:19090/v1', enabled: true, apiKey: KEY },
      { name: '自定义相同地址', kind: 'openai-compatible', presetId: 'custom', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: KEY },
      { name: 'Central', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, enabled: true, apiKey: KEY },
      { name: '没有密钥', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, enabled: true },
    ];
    for (const input of inputs) { const provider = f.store.saveProvider(input); await expect(f.center.refresh(provider.id)).rejects.toBeInstanceOf(RelayQuotaFailure); }
    // Retained pre-validation data can still describe a managed noncanonical
    // endpoint; capability must reject it before the query boundary too.
    const get = f.store.getProvider.bind(f.store);
    vi.spyOn(f.store, 'getProvider').mockImplementation(id => { const value = get(id); return id === f.provider.id && value ? { ...value, baseUrl: 'http://127.0.0.1:18081/v1' } : value; });
    await expect(f.center.refresh(f.provider.id)).rejects.toBeInstanceOf(RelayQuotaFailure); expect(f.query).not.toHaveBeenCalled();
  });
  it('replaces an old balance and identity with a safe empty failure view, and can recover on the next action', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); f.query.mockRejectedValueOnce(new Error(PRIVATE));
    const failed = await f.center.refresh(f.provider.id);
    expect(failed.usage).toMatchObject({ status: 'unavailable', windows: [], queriedAt: '2030-01-01T00:00:00.000Z' });
    expect(failed.accountId).toBeUndefined(); expect(failed.displayName).toBeUndefined(); expect(failed.plan).toBeUndefined();
    expect(JSON.stringify([failed, f.cache(), f.view()])).not.toMatch(/SYNTHETIC_PRIVATE|currently-active|official-credits/);
    expect((await f.center.refresh(f.provider.id)).usage.status).toBe('ready');
  });
  it('clears an old known plan after a successful unknown-tier result and never decorates a stale account plan onto a missing cache', async () => {
    const f = await fixture(); const previous = await f.center.refresh(f.provider.id); expect(previous.plan).toBe('Pro');
    const unknown = f.result(); delete unknown.plan; f.query.mockResolvedValueOnce(unknown);
    expect((await f.center.refresh(f.provider.id)).plan).toBeUndefined(); expect(f.center.decorate(previous).plan).toBeUndefined();
    f.store.saveProvider({ ...f.store.getProvider(f.provider.id)!, apiKey: 'changed-key' });
    const invalidated = f.center.decorate(previous); expect(invalidated.plan).toBeUndefined(); expect(invalidated.accountId).toBeUndefined(); expect(invalidated.displayName).toBeUndefined();
  });
  it('preserves only a controlled native failure message and does not restore an old account balance', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); f.query.mockRejectedValueOnce(new RelayQuotaFailure('反代活跃账号已切换，请刷新。'));
    const failed = await f.center.refresh(f.provider.id); expect(failed.usage.message).toBe('反代活跃账号已切换，请刷新。'); expect(failed.usage.windows).toEqual([]); expect(failed.accountId).toBeUndefined();
  });
  it.each(['key', 'destination', 'delete'] as const)('does not save a completed query after %s changes while it is pending', async change => {
    const f = await fixture(), held = deferred<RelayQuotaResult>(); f.query.mockReturnValueOnce(held.promise);
    const pending = f.center.refresh(f.provider.id);
    if (change === 'key') f.store.saveProvider({ ...f.provider, apiKey: 'new-user-key' });
    else if (change === 'destination') f.store.saveProvider({ ...f.provider, relayMode: 'manual', baseUrl: 'http://127.0.0.1:19092/v1', apiKey: 'changed-destination-key' });
    else f.store.deleteProvider(f.provider.id);
    if (change === 'key') await expect(f.center.refresh(f.provider.id)).rejects.toThrow('连接已更改');
    held.resolve(f.result()); await expect(pending).rejects.toBeInstanceOf(RelayQuotaFailure); expect(f.cache()).toBeNull();
    if (change === 'key') { expect(f.view().usage.windows).toEqual([]); await f.center.refresh(f.provider.id); expect(f.query).toHaveBeenLastCalledWith('new-user-key'); }
  });
  it('marks a five-minute-old balance stale without querying in decorate or mutating its persisted observation', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); const observed = f.cache();
    f.advance(QUOTA_CACHE_TTL_MS - 1); expect(f.view().usage.status).toBe('ready');
    f.advance(1); const stale = f.view(); expect(stale.usage.status).toBe('stale'); expect(stale.usage.message).toContain('上次查询'); expect(stale.usage.windows[0].remaining).toBe(75);
    expect(f.cache()).toEqual(observed); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('hides a cached balance after a key edit and treats malformed cached shapes as not queried', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); f.store.saveProvider({ ...f.provider, apiKey: 'edited-key' });
    expect(f.view().usage).toMatchObject({ status: 'not-queried', windows: [] });
    f.store.setManagedState(`auth-usage:${f.provider.id}`, { version: 1, connection: 'invalid', usage: { windows: PRIVATE } });
    expect(f.view().usage).toMatchObject({ status: 'not-queried', windows: [] }); expect(f.query).toHaveBeenCalledTimes(1);
  });
});

describe('relay import quota cache invalidation transaction', () => {
  it('clears the old active-account cache on a successful same-key import, including after reopen', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); expect(f.cache()).not.toBeNull();
    const provider = f.store.getProvider(f.provider.id)!, secret = f.store.getSecret(f.provider.id);
    const imported = await f.importAccount(); expect(imported.providerId).toBe(provider.id); expect(f.cache()).toBeNull(); expect(f.view().usage).toMatchObject({ status: 'not-queried', windows: [] });
    expect(f.store.getProvider(provider.id)).toEqual(provider); expect(f.store.getSecret(provider.id)).toEqual(secret);
    const reopened = await Store.create(f.dir, f.codec); stores.push(reopened); expect(reopened.getManagedState(`auth-usage:${provider.id}`, null)).toBeNull();
  });
  it('preserves the old cache and disk when native import or metadata encryption fails', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); const before = f.cache(), disk = readFileSync(join(f.dir, 'modeldock.sqlite'));
    f.adapters['trae-cn-relay'].perform.mockRejectedValueOnce(new Error(PRIVATE));
    const nativeFailure = await f.importAccount().catch(error => error as Error); expect(String(nativeFailure)).not.toContain(PRIVATE); expect(f.cache()).toEqual(before); expect(readFileSync(join(f.dir, 'modeldock.sqlite'))).toEqual(disk);
    f.failMetadata(true);
    try { const localFailure = await f.importAccount().catch(error => error as Error); expect(String(localFailure)).not.toContain(PRIVATE); expect(f.cache()).toEqual(before); expect(readFileSync(join(f.dir, 'modeldock.sqlite'))).toEqual(disk); }
    finally { f.failMetadata(false); }
  });
  it('restores the original cache after persistence fails after its staged DELETE', async () => {
    const f = await fixture(); await f.center.refresh(f.provider.id); const before = f.cache(), provider = f.store.getProvider(f.provider.id), disk = readFileSync(join(f.dir, 'modeldock.sqlite'));
    const blocker = join(f.dir, 'not-a-directory'); writeFileSync(blocker, 'fixture');
    const mutable = f.store as unknown as { dataDir: string }; mutable.dataDir = blocker;
    try {
      const failure = await f.importAccount().catch(error => error as Error); expect(String(failure)).not.toMatch(/ENOTDIR|not-a-directory|SYNTHETIC_PRIVATE/);
      expect(f.cache()).toEqual(before); expect(f.store.getProvider(f.provider.id)).toEqual(provider); expect(readFileSync(join(f.dir, 'modeldock.sqlite'))).toEqual(disk);
    } finally { mutable.dataDir = f.dir; }
    const reopened = await Store.create(f.dir, f.codec); stores.push(reopened); expect(reopened.getManagedState(`auth-usage:${f.provider.id}`, null)).toEqual(before);
  });
  it('does not repopulate a cleared old-account cache when a same-connection import finishes during a pending quota read', async () => {
    const f = await fixture(), held = deferred<RelayQuotaResult>(); f.query.mockReturnValueOnce(held.promise);
    const pending = f.center.refresh(f.provider.id); f.advance(1); await f.importAccount(); expect(f.cache()).toBeNull();
    held.resolve(f.result('previous-active-account', '导入前的旧活跃账号'));
    await expect(pending).rejects.toBeInstanceOf(RelayQuotaFailure); expect(f.cache()).toBeNull(); expect(f.view().usage.windows).toEqual([]);
  });
  it('also invalidates an old pending query on a repeat import in the same millisecond', async () => {
    const f = await fixture(), firstImport = await f.importAccount(), held = deferred<RelayQuotaResult>(); f.query.mockReturnValueOnce(held.promise);
    const pending = f.center.refresh(f.provider.id), repeated = await f.importAccount();
    expect(repeated.providerId).toBe(firstImport.providerId);
    expect(repeated.clientImport?.importedAt).toBe(firstImport.clientImport?.importedAt);
    held.resolve(f.result('before-repeat-import'));
    await expect(pending).rejects.toBeInstanceOf(RelayQuotaFailure); expect(f.cache()).toBeNull(); expect(f.view().usage.windows).toEqual([]);
  });
});
