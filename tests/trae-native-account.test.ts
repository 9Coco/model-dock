import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { TraeNativeAccounts, TraeNativeAccountError, type TraeNativeQuota } from '../src/main/trae-native-account';
import type { TraeClientCredentials, TraeClientImportCandidate } from '../src/main/trae-client-import';
import { relayAccountView } from '../src/main/relay-client-import';
import { TRAE_RELAY_BASE_URL } from '../src/shared/presets';
import { QUOTA_CACHE_TTL_MS } from '../src/shared/quota-display';

const NOW = Date.parse('2030-01-01T00:00:00Z'), LOCAL_KEY = 'synthetic_native_trae_local_key_32_characters';
const PRIVATE = 'SYNTHETIC_PRIVATE_SOURCE_AUTH_TOKEN_PATH';
const roots: string[] = [], stores: Store[] = [], managers: TraeNativeAccounts[] = [];
function credentials(user = 'account-a', until = NOW + 3_600_000): TraeClientCredentials {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return { host: 'https://api.trae.cn', token: `${part({ alg: 'RS256' })}.${part({ sub: user, exp: until / 1000, marker: PRIVATE })}.c3ludGhldGlj`, userId: user, screenName: '合成用户 ' + user, expiredAt: new Date(until).toISOString(), refreshToken: 'PRIVATE_SYNTHETIC_REFRESH_' + user, refreshExpiredAt: new Date(until + 86_400_000).toISOString(), region: 'CN' };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-native-trae-')); roots.push(dir);
  let clock = NOW, current = credentials(), failEncryption = false;
  const codec = { encrypt(value: string) { if (failEncryption && value.includes('"nativeClient"')) throw new Error(PRIVATE); return 'test:' + Buffer.from(value).toString('base64'); }, decrypt(value: string) { return Buffer.from(value.slice(5), 'base64').toString(); } };
  const store = await Store.create(dir, codec); stores.push(store);
  const reader = {
    listCandidates: vi.fn(async (): Promise<TraeClientImportCandidate[]> => [{ id: 'trae-cn', label: '合成 TRAE 客户端', accountId: current.userId, displayName: current.screenName, expiresAt: Date.parse(current.expiredAt!), expired: Date.parse(current.expiredAt!) <= clock }]),
    readCredentials: vi.fn(async (_client: string) => structuredClone(current)),
  };
  const quota = (plan?: string): TraeNativeQuota => ({ ...(plan ? { plan } : {}), usage: { status: 'ready', queriedAt: new Date(clock).toISOString(), windows: [{ id: 'official-credits', label: '通用积分', total: 100, remaining: 75, unit: '积分' }], message: '合成官方额度' } });
  const api = { quota: vi.fn(async (_credentials: TraeClientCredentials, _signal?: AbortSignal) => quota('Pro')) };
  const localKey = vi.fn(() => LOCAL_KEY), manager = new TraeNativeAccounts(store, reader, api, localKey, () => undefined, () => clock); managers.push(manager);
  const preview = async () => (await manager.preview()).candidates[0].id;
  const imported = async () => manager.import(await preview());
  return { dir, store, codec, manager, reader, api, localKey, quota, preview, imported,
    current: () => structuredClone(current), change: (value: TraeClientCredentials) => { current = value; }, advance: (ms: number) => { clock += ms; }, failEncryption: () => { failEncryption = true; },
    view: (id: string) => manager.decorate(relayAccountView(store, store.getProvider(id)!)),
    metadata: (id: string) => store.getManagedState<Record<string, unknown>>(`auth-metadata:${id}`, {}),
  };
}
function addReferences(store: Store, providerId: string) {
  const model = store.saveModel({ providerId, upstreamId: 'fixture-chat', alias: 'retained-alias', displayName: '保留模型', contextWindow: 64000, wireApi: 'chat-completions', enabled: true, vision: false, tools: true });
  const binding = store.listBindings().find(item => item.id === 'codex')!;
  store.saveBinding({ ...binding, mode: 'aggregate', enabled: true, providerIds: [providerId], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
}
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('explicit encrypted TRAE native account snapshots without a relay process', () => {
  it('does nothing at construction and previews only opaque metadata without credentials, keys or network', async () => {
    const f = await fixture(); expect(f.reader.listCandidates).not.toHaveBeenCalled(); expect(f.api.quota).not.toHaveBeenCalled();
    const preview = await f.manager.preview(); expect(preview).toMatchObject({ kind: 'trae-cn-relay', candidates: [{ clientName: 'TRAE 中国版', accountLabel: '合成用户 account-a' }] });
    expect(preview.candidates[0].id).toMatch(/^[a-f0-9-]{36}$/); expect(JSON.stringify(preview)).not.toMatch(/eyJ|PRIVATE|refreshToken|expiredAt/);
    expect(f.reader.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.quota).not.toHaveBeenCalled();
  });
  it('imports only on confirmation, re-reads the same client twice and keeps source credentials only in encrypted metadata', async () => {
    const f = await fixture(), account = await f.imported(), source = f.current();
    expect(f.reader.readCredentials.mock.calls).toEqual([['trae-cn'], ['trae-cn']]); expect(f.api.quota).not.toHaveBeenCalled();
    expect(account).toMatchObject({ kind: 'trae-cn-relay', source: 'relay', accountId: source.userId, displayName: source.screenName, authStatus: 'ready', canRefresh: false, canQueryUsage: true, clientImport: { client: 'trae-cn', upstreamVerified: false }, usage: { status: 'not-queried', windows: [] } });
    expect(account.plan).toBeUndefined(); expect(f.store.getSecret(account.providerId)).toEqual({ apiKey: LOCAL_KEY });
    expect(f.manager.credentials(account.providerId)).toEqual(source); expect(f.manager.isNativeProvider(account.providerId)).toBe(true);
    const payload = JSON.stringify({ account, providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings() });
    for (const secret of [source.token, source.refreshToken!, LOCAL_KEY]) expect(payload).not.toContain(secret);
    const disk = readFileSync(join(f.dir, 'modeldock.sqlite')); for (const secret of [source.token, source.refreshToken!]) expect(disk.includes(Buffer.from(secret))).toBe(false);
    const reopened = await Store.create(f.dir, f.codec); stores.push(reopened);
    const restored = new TraeNativeAccounts(reopened, f.reader, f.api, f.localKey, () => undefined, () => NOW); managers.push(restored);
    expect(restored.credentials(account.providerId)).toEqual(source); expect(f.reader.readCredentials).toHaveBeenCalledTimes(2);
  });
  it('returns defensive credential copies and strips unexpected source fields before saving', async () => {
    const f = await fixture(); f.change({ ...f.current(), unexpected: PRIVATE } as TraeClientCredentials);
    const account = await f.imported(), first = f.manager.credentials(account.providerId); first.token = 'changed-by-caller';
    expect(f.manager.credentials(account.providerId).token).not.toBe('changed-by-caller');
    expect(f.manager.credentials(account.providerId)).not.toHaveProperty('unexpected'); expect(JSON.stringify(f.metadata(account.providerId))).not.toContain('unexpected');
  });
  it('reuses a provider across repeat imports and account switches while preserving its name, note, models, bindings and local key', async () => {
    const f = await fixture(), first = await f.imported();
    addReferences(f.store, first.providerId); f.store.saveProvider({ ...f.store.getProvider(first.providerId)!, name: '用户命名', note: '用户备注', enabled: false });
    const before = { models: f.store.listModels(), bindings: f.store.listBindings(), provider: f.store.getProvider(first.providerId), secret: f.store.getSecret(first.providerId) };
    await f.manager.refreshUsage(first.providerId); const previous = f.metadata(first.providerId); f.change(credentials('account-b'));
    const second = await f.imported(); expect(second.providerId).toBe(first.providerId); expect(second.accountId).toBe('account-b'); expect(second.plan).toBeUndefined();
    expect(f.metadata(first.providerId).identity).not.toBe(previous.identity); expect(f.metadata(first.providerId).revision).not.toBe(previous.revision);
    expect(f.store.getManagedState(`auth-usage:${first.providerId}`, null)).toBeNull(); expect(second.usage.status).toBe('not-queried');
    expect({ models: f.store.listModels(), bindings: f.store.listBindings(), provider: f.store.getProvider(first.providerId), secret: f.store.getSecret(first.providerId) }).toEqual(before);
    const repeated = await f.imported(); expect(repeated.providerId).toBe(first.providerId);
  });
  it('leaves manual and historical managed providers untouched until explicit import, then adopts only the matching managed connection', async () => {
    const f = await fixture();
    const manual = f.store.saveProvider({ name: '手动配置', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: TRAE_RELAY_BASE_URL, apiKey: 'unrelated_manual_key', enabled: true });
    const legacy = f.store.saveProvider({ name: '原有托管连接', note: '保留说明', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, apiKey: LOCAL_KEY, enabled: true });
    expect(f.manager.isNativeProvider(legacy.id)).toBe(false); expect(f.store.getManagedState(`auth-metadata:${legacy.id}`, null)).toBeNull(); await f.manager.preview(); expect(f.manager.isNativeProvider(legacy.id)).toBe(false);
    const manualBefore = f.store.getProvider(manual.id), imported = await f.imported(); expect(imported.providerId).toBe(legacy.id); expect(f.store.getProvider(manual.id)).toEqual(manualBefore); expect(f.store.getProvider(legacy.id)?.note).toBe('保留说明');
  });
  it('rejects a switched account after preview or during confirmation without saving credentials', async () => {
    for (const duringRead of [false, true]) {
      const f = await fixture(), ticket = await f.preview(), before = f.store.listProviders();
      if (duringRead) f.reader.readCredentials.mockResolvedValueOnce(credentials()).mockResolvedValueOnce(credentials('account-b')); else f.change(credentials('account-b'));
      await expect(f.manager.import(ticket)).rejects.toThrow('切换'); expect(f.store.listProviders()).toEqual(before); expect(f.api.quota).not.toHaveBeenCalled();
    }
  });
  it('rejects expired or unknown tickets and serializes concurrent confirmations', async () => {
    const f = await fixture(), expired = await f.preview(); f.advance(5 * 60_000);
    await expect(f.manager.import(expired)).rejects.toThrow('过期'); await expect(f.manager.import('../../private')).rejects.toThrow('过期'); expect(f.localKey).not.toHaveBeenCalled();
    const ticket = await f.preview(), held = deferred<TraeClientCredentials>(); f.reader.readCredentials.mockReturnValueOnce(held.promise);
    const pending = f.manager.import(ticket); await expect(f.manager.import(ticket)).rejects.toThrow('正在导入'); held.resolve(f.current()); await pending;
  });
  it('rejects ambiguous managed connections, concurrent provider edits and storage failures without altering the original provider state', async () => {
    const f = await fixture();
    for (const name of ['托管 A', '托管 B']) f.store.saveProvider({ name, kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, apiKey: LOCAL_KEY, enabled: true });
    const before = f.store.listProviders(); await expect(f.imported()).rejects.toThrow('多个'); expect(f.store.listProviders()).toEqual(before);
    const g = await fixture(), account = await g.imported(), snapshot = g.store.getProvider(account.providerId), disk = readFileSync(join(g.dir, 'modeldock.sqlite'));
    g.failEncryption(); await expect(g.imported()).rejects.toThrow('未能保存'); expect(g.store.getProvider(account.providerId)).toEqual(snapshot); expect(readFileSync(join(g.dir, 'modeldock.sqlite'))).toEqual(disk);
    const h = await fixture(), pendingTicket = await h.preview(); h.reader.readCredentials.mockImplementationOnce(async () => h.current()).mockImplementationOnce(async () => {
      h.store.saveProvider({ name: '并发增加的托管连接', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, apiKey: LOCAL_KEY, enabled: true }); return h.current();
    }); await expect(h.manager.import(pendingTicket)).rejects.toThrow('导入期间已变更');
  });
  it('treats expired, malformed, foreign-host or connection-tampered credentials as unusable without leaking material or falling back to a relay', async () => {
    for (const bad of [{ ...credentials(), host: 'https://evil.invalid' }, { ...credentials(), token: PRIVATE }, credentials('account-a', NOW - 1)]) {
      const f = await fixture(); f.change(bad as TraeClientCredentials); const error = await f.imported().catch(error => error as Error); expect(error).toBeInstanceOf(TraeNativeAccountError); expect(String(error)).not.toContain(PRIVATE);
    }
    const f = await fixture(), account = await f.imported(); f.advance(3_600_000); expect(() => f.manager.credentials(account.providerId)).toThrow('已过期'); expect(f.view(account.providerId)).toMatchObject({ authStatus: 'expired', canQueryUsage: false, usage: { status: 'unavailable', windows: [] } });
    const g = await fixture(), imported = await g.imported(); g.store.saveProvider({ ...g.store.getProvider(imported.providerId)!, apiKey: 'changed_connection_key' });
    expect(g.manager.isNativeProvider(imported.providerId)).toBe(true); expect(() => g.manager.credentials(imported.providerId)).toThrow('连接已变更');
    const meta = g.metadata(imported.providerId); g.store.setManagedState(`auth-metadata:${imported.providerId}`, { ...meta, nativeClient: { version: 999 } });
    expect(g.manager.isNativeProvider(imported.providerId)).toBe(true); expect(() => g.manager.credentials(imported.providerId)).toThrow(TraeNativeAccountError);
  });
});

describe('native TRAE official quota cache', () => {
  it.each([1, 2])('requires a new quota observation for cache version %s without changing encrypted account data or bindings', async version => {
    const f = await fixture(), account = await f.imported(); addReferences(f.store, account.providerId);
    const before = { provider: f.store.getProvider(account.providerId), secret: f.store.getSecret(account.providerId), metadata: f.metadata(account.providerId),
      credentials: f.manager.credentials(account.providerId), models: f.store.listModels(), bindings: f.store.listBindings() };
    const previous = { ...f.quota('Pro'), version, revision: before.metadata.revision };
    f.store.setManagedState(`auth-usage:${account.providerId}`, previous);
    const view = f.view(account.providerId);
    expect(view).toMatchObject({ authStatus: 'ready', canQueryUsage: true, usage: { status: 'not-queried', windows: [] } }); expect(view.plan).toBeUndefined();
    expect(f.api.quota).not.toHaveBeenCalled(); expect(f.store.getManagedState(`auth-usage:${account.providerId}`, null)).toEqual(previous);
    const refreshed = await f.manager.refreshUsage(account.providerId);
    expect(refreshed).toMatchObject({ plan: 'Pro', usage: { status: 'ready', windows: [{ total: 100, remaining: 75 }] } });
    expect(f.store.getManagedState(`auth-usage:${account.providerId}`, null)).toMatchObject({ version: 3, revision: before.metadata.revision });
    expect({ provider: f.store.getProvider(account.providerId), secret: f.store.getSecret(account.providerId), metadata: f.metadata(account.providerId),
      credentials: f.manager.credentials(account.providerId), models: f.store.listModels(), bindings: f.store.listBindings() }).toEqual(before);
  });
  it('queries the saved snapshot only on action, deduplicates refreshes, and exposes a safe plan with stale observations labeled', async () => {
    const f = await fixture(), account = await f.imported(), held = deferred<TraeNativeQuota>(); f.api.quota.mockReturnValueOnce(held.promise);
    expect(f.view(account.providerId).usage.status).toBe('not-queried'); expect(f.api.quota).not.toHaveBeenCalled();
    const first = f.manager.refreshUsage(account.providerId), second = f.manager.refreshUsage(account.providerId); expect(second).toBe(first); expect(f.api.quota).toHaveBeenCalledTimes(1);
    expect(f.api.quota.mock.calls[0][0]).toEqual(f.current()); expect(f.api.quota.mock.calls[0][1]).toBeInstanceOf(AbortSignal); held.resolve(f.quota('Pro'));
    const result = await first; expect(result.plan).toBe('Pro'); expect(result.usage.status).toBe('ready'); expect(JSON.stringify(result)).not.toContain(f.current().token);
    f.advance(QUOTA_CACHE_TTL_MS); expect(f.view(account.providerId).usage.status).toBe('stale'); expect(f.api.quota).toHaveBeenCalledTimes(1);
  });
  it('clears old plan/usage on unknown-tier results and redacts upstream failures without keeping an old balance', async () => {
    const f = await fixture(), account = await f.imported(); await f.manager.refreshUsage(account.providerId);
    f.api.quota.mockResolvedValueOnce(f.quota()); const unknown = await f.manager.refreshUsage(account.providerId); expect(unknown.plan).toBeUndefined();
    f.api.quota.mockRejectedValueOnce(new Error(PRIVATE)); const failed = await f.manager.refreshUsage(account.providerId);
    expect(failed.plan).toBeUndefined(); expect(failed.usage).toMatchObject({ status: 'unavailable', windows: [] }); expect(JSON.stringify(failed)).not.toContain(PRIVATE);
    f.api.quota.mockResolvedValueOnce(f.quota('UNRECOGNIZED_PRIVATE_PLAN')); expect((await f.manager.refreshUsage(account.providerId)).plan).toBeUndefined();
  });
  it.each(['import', 'key', 'delete'] as const)('does not save an old account query after %s changes', async change => {
    const f = await fixture(), account = await f.imported(), held = deferred<TraeNativeQuota>(); f.api.quota.mockReturnValueOnce(held.promise);
    const pending = f.manager.refreshUsage(account.providerId);
    if (change === 'import') { f.change(credentials('account-b')); await f.imported(); }
    else if (change === 'key') f.store.saveProvider({ ...f.store.getProvider(account.providerId)!, apiKey: 'changed_key_during_query' });
    else { f.manager.providerRemoved(account.providerId); f.store.deleteProvider(account.providerId); }
    held.resolve(f.quota('Pro')); await expect(pending).rejects.toThrow(TraeNativeAccountError); expect(f.store.getManagedState(`auth-usage:${account.providerId}`, null)).toBeNull();
  });
  it('aborts pending official quota operations on shutdown without persisting a late result', async () => {
    const f = await fixture(), account = await f.imported(), held = deferred<TraeNativeQuota>(); f.api.quota.mockReturnValueOnce(held.promise);
    const pending = f.manager.refreshUsage(account.providerId), signal = f.api.quota.mock.calls[0][1]!; f.manager.dispose(); expect(signal.aborted).toBe(true);
    held.resolve(f.quota('Pro')); await expect(pending).rejects.toThrow('已停止'); expect(f.store.getManagedState(`auth-usage:${account.providerId}`, null)).toBeNull();
  });
});
