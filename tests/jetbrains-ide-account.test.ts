import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { JetBrainsIdeAccounts, JetBrainsIdeAccountError, type JetBrainsIdeApiPort } from '../src/main/jetbrains-ide-account';
import { JetBrainsIdeApiError } from '../src/main/jetbrains-ide-api';
import type { JetBrainsIdeCredentials, JetBrainsIdeImportCandidate } from '../src/main/jetbrains-ide-import';
import { JetBrainsIdeRelay, type JetBrainsIdeRelayAdapter } from '../src/main/jetbrains-ide-relay';
import { JetBrainsGatewayAdapter } from '../src/main/jetbrains-gateway-adapter';
import { relayAccountView } from '../src/main/relay-client-import';
import { JETBRAINS_RELAY_BASE_URL } from '../src/shared/presets';
import type { AuthAccount, SubscriptionUsage } from '../src/shared/auth-types';

const ROOT_NOW = Date.parse('2030-01-01T00:00:00Z');
const LOCAL_KEY = 'synthetic-ide-local-key-independent-32-characters';
const OTHER_KEY = 'synthetic-separate-manual-key-32-characters';
const PRIVATE_ERROR = 'PRIVATE_IDE_RAW_ERROR_TOKEN_PATH_BODY';
const GRAZIE_A = 'PRIVATE_GRAZIE_SESSION_ACCOUNT_A';
const GRAZIE_B = 'PRIVATE_GRAZIE_SESSION_ACCOUNT_B';
const directories: string[] = [], stores: Store[] = [], managers: JetBrainsIdeAccounts[] = [];

function credentials(account: 'a' | 'b' = 'a', sourceTokenExpHint = ROOT_NOW + 60 * 60_000): JetBrainsIdeCredentials {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return { tokenType: 'jba-id-token', authorization: 'unverified',
    idToken: `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ user_id: `fixture-${account}`, marker: `PRIVATE_JBA_ID_TOKEN_${account}`, exp: Math.floor(sourceTokenExpHint / 1000) })}.c3ludGhldGljLXNpZ25hdHVyZQ`,
    accountId: `fixture-${account}`, accountLabel: `合成 IDE 账号 ${account.toUpperCase()}`, email: `fixture-${account}@example.test`,
    licenseId: `synthetic-ai-license-${account}`, product: 'rider', sourceIdentity: `fixture-rider-license-${account}`, sourceTokenExpHint };
}
function usage(used = 10, at = ROOT_NOW): SubscriptionUsage {
  return { status: 'ready', queriedAt: new Date(at).toISOString(), windows: [{ id: 'license', label: '官方 AI 积分', total: 100, remaining: 100 - used, unit: 'credits' }], message: '合成官方额度' };
}
function importSource(entries: [string, JetBrainsIdeCredentials][]) {
  const selected = new Map(entries);
  const candidates: JetBrainsIdeImportCandidate[] = entries.map(([id, value]) => ({ id, client: 'jetbrains-ide', clientName: value.product + ' 2026.2', product: value.product,
    sourceIdentity: value.sourceIdentity, accountLicenseIdentity: createHash('sha256').update(JSON.stringify([value.accountId, value.licenseId])).digest('hex'), accountId: value.accountId, accountLabel: value.accountLabel }));
  return { candidates, listCandidates: vi.fn(async () => structuredClone(candidates)), readCredentials: vi.fn(async (id: string) => {
    const value = selected.get(id); if (!value) throw new Error(PRIVATE_ERROR); return structuredClone(value);
  }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function state(store: Store) {
  return { providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(),
    secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]),
    metadata: store.listProviders().map(provider => [provider.id, store.getManagedState(`auth-metadata:${provider.id}`, null)]),
    quota: store.listProviders().map(provider => [provider.id, store.getManagedState(`auth-usage:${provider.id}`, null)]) };
}
function references(store: Store, providerId: string) {
  const model = store.saveModel({ providerId, upstreamId: 'native-profile-fixture', alias: 'preserved-local-alias', displayName: '保留模型', wireApi: 'chat-completions', contextWindow: 64000, enabled: true, vision: false, tools: true });
  const binding = store.listBindings().find(value => value.id === 'rider')!;
  store.saveBinding({ ...binding, mode: 'aggregate', enabled: false, providerIds: [providerId], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  return model;
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-ide-accounts-')); directories.push(dir);
  let failEncryption = false, clock = ROOT_NOW;
  const codec = { encrypt(value: string) { if (failEncryption && value.includes('"nativeIde"')) throw new Error(PRIVATE_ERROR); return `fixture:${Buffer.from(value).toString('base64')}`; }, decrypt(value: string) { return Buffer.from(value.slice(8), 'base64').toString(); } };
  const store = await Store.create(dir, codec); stores.push(store);
  const a = credentials(), b = credentials('b'), selected = new Map([['ticket-a', a], ['ticket-b', b]]);
  const candidates: JetBrainsIdeImportCandidate[] = [...selected].map(([id, value]) => ({ id, client: 'jetbrains-ide', clientName: 'Rider 2026.2', product: value.product, sourceIdentity: value.sourceIdentity, accountId: value.accountId, accountLabel: value.accountLabel, sourceTokenExpHint: value.sourceTokenExpHint }));
  const reader = { listCandidates: vi.fn(async () => structuredClone(candidates)), readCredentials: vi.fn(async (id: string) => {
    const value = selected.get(id); if (!value) throw new Error(PRIVATE_ERROR); return structuredClone(value);
  }) };
  const api = {
    exchange: vi.fn(async (value: { idToken: string; licenseId: string }, _signal?: AbortSignal) => ({ token: value.idToken === a.idToken ? GRAZIE_A : GRAZIE_B, expiresAt: clock + 5 * 60_000 })),
    quota: vi.fn(async (token: string, _signal?: AbortSignal) => usage(token === GRAZIE_B ? 45 : 10, clock)),
    models: vi.fn(async (_token: string, _signal?: AbortSignal) => ({ data: [{ id: 'native-profile-fixture', object: 'model' as const }] })),
    chat: vi.fn(async (_token: string, _body: Record<string, unknown>, _signal: AbortSignal) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'MOCK_NATIVE_OK' } }] }), { headers: { 'content-type': 'application/json' } })),
  } satisfies JetBrainsIdeApiPort;
  let running: { key: string; owner: string; adapter: JetBrainsIdeRelayAdapter } | undefined;
  const relay = {
    isRunning: vi.fn((key: string, owner?: string) => !!running && running.key === key && (!owner || running.owner === owner)),
    start: vi.fn(async (key: string, owner: string, adapter: JetBrainsIdeRelayAdapter) => { running = { key, owner, adapter }; }),
    stop: vi.fn(async () => { running = undefined; }),
  };
  // Transport/authentication and real loopback behavior have their own relay
  // tests. This fixture exposes the account manager's private adapter boundary.
  const localKey = vi.fn(() => LOCAL_KEY);
  function newManager(apiPort: JetBrainsIdeApiPort = api, source: ConstructorParameters<typeof JetBrainsIdeAccounts>[1] = reader) {
    const value = new JetBrainsIdeAccounts(store, source, apiPort, relay as unknown as JetBrainsIdeRelay, localKey, () => undefined, () => clock);
    managers.push(value); return value;
  }
  const manager = newManager();
  return { dir, store, codec, reader, api, relay, localKey, manager, a, b,
    newManager,
    advance(ms: number) { clock += ms; }, failMetadataEncryption() { failEncryption = true; }, repairEncryption() { failEncryption = false; },
    adapter() {
      const provider = store.listProviders().find(value => manager.isNativeProvider(value.id)); if (!provider) throw new Error('Fixture native account not imported');
      const adapter = new JetBrainsGatewayAdapter(manager, api), native = { ...provider, nativeAdapter: 'jetbrains-ide' as const };
      return { models: async (signal: AbortSignal) => { const result = await (await adapter.models(native, signal)).json() as { data: { id: string; object: 'model' }[] }; return { data: result.data }; },
        chat: async (body: Record<string, unknown>, signal: AbortSignal) => (await adapter.request(native, '/chat/completions', body, signal))! };
    },
    account(id: string) { return manager.decorate(relayAccountView(store, store.getProvider(id)!)); } };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('IDE 默认客户端导入与真实歧义', () => {
  it('仅有一个客户端时直接使用原有票据导入，私有身份指纹不进入返回值', async () => {
    const f = await setup(), source = importSource([['ticket-only', f.a]]), manager = f.newManager(f.api, source);
    const result = await manager.importDefault();
    expect(result).toMatchObject({ status: 'imported', account: { accountId: f.a.accountId, authStatus: 'ready' } });
    expect(source.listCandidates).toHaveBeenCalledTimes(1); expect(source.readCredentials.mock.calls).toEqual([['ticket-only'], ['ticket-only']]);
    expect(f.api.exchange).toHaveBeenCalledTimes(1); expect(f.localKey).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/accountLicenseIdentity|sourceIdentity|licenseId|PRIVATE|eyJ/);
  });
  it('同账号及许可证跨IDE去重，产品优先级稳定且不取决于扫描顺序', async () => {
    const f = await setup();
    const entries: [string, JetBrainsIdeCredentials][] = (['pycharm', 'rider', 'webstorm', 'intellij-idea'] as const).map(product => [`ticket-${product}`, { ...f.a, product, sourceIdentity: `fixture-source-${product}` }]);
    const source = importSource(entries), manager = f.newManager(f.api, source), result = await manager.importDefault();
    expect(result.status).toBe('imported'); expect(source.readCredentials.mock.calls).toEqual([['ticket-intellij-idea'], ['ticket-intellij-idea']]); expect(f.api.exchange).toHaveBeenCalledTimes(1);
    const preview = await manager.preview(); expect(preview.candidates).toHaveLength(4);
    expect(JSON.stringify(preview)).not.toMatch(/accountLicenseIdentity|sourceIdentity|licenseId|PRIVATE|eyJ/);
  });
  it('同一身份跨IDE时优先保留已有导入产品及原供应商、模型和工具绑定', async () => {
    const f = await setup(), source = importSource([['ticket-rider', f.a], ['ticket-idea', { ...f.a, product: 'intellij-idea', sourceIdentity: 'fixture-source-idea' }]]), manager = f.newManager(f.api, source);
    const first = await manager.import('ticket-rider'); references(f.store, first.providerId);
    f.store.saveProvider({ ...f.store.getProvider(first.providerId)!, name: '用户现有供应商', note: '保留备注' });
    const before = state(f.store); source.readCredentials.mockClear();
    const result = await manager.importDefault(); expect(result).toMatchObject({ status: 'imported', account: { providerId: first.providerId, providerName: '用户现有供应商' } });
    expect(source.readCredentials.mock.calls).toEqual([['ticket-rider'], ['ticket-rider']]); expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
    expect(f.store.getSecret(first.providerId)).toEqual({ apiKey: LOCAL_KEY });
  });
  it.each(['account', 'license'] as const)('不同%s总是要求明确选择，即使旧供应商匹配其中一个身份也不读取凭据或请求云端', async difference => {
    const f = await setup(), other = difference === 'account' ? f.b : { ...f.a, licenseId: 'synthetic-other-license', sourceIdentity: 'fixture-other-license' };
    const source = importSource([['ticket-a', f.a], ['ticket-b', other]]), manager = f.newManager(f.api, source);
    await manager.import('ticket-a'); const before = state(f.store); source.readCredentials.mockClear(); f.localKey.mockClear(); f.api.exchange.mockClear(); f.api.quota.mockClear(); f.api.models.mockClear();
    const secret = vi.spyOn(f.store, 'getSecret'), result = await manager.importDefault();
    expect(secret).not.toHaveBeenCalled(); expect(source.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.exchange).not.toHaveBeenCalled(); expect(f.api.quota).not.toHaveBeenCalled(); expect(f.api.models).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'selection-required', preview: { candidates: [{ id: 'ticket-a' }, { id: 'ticket-b' }] } });
    expect(JSON.stringify(result)).not.toMatch(/accountLicenseIdentity|sourceIdentity|licenseId|PRIVATE|eyJ/); expect(state(f.store)).toEqual(before);
  });
  it('歧义列表只折叠已证实等价的跨IDE来源，保留每个独立许可证', async () => {
    const f = await setup(), source = importSource([['ticket-rider', f.a], ['ticket-idea', { ...f.a, product: 'intellij-idea', sourceIdentity: 'fixture-idea' }], ['ticket-b', f.b]]), manager = f.newManager(f.api, source);
    const result = await manager.importDefault();
    expect(result).toMatchObject({ status: 'selection-required', preview: { candidates: [{ id: 'ticket-idea' }, { id: 'ticket-b' }] } }); expect(source.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled();
    const imported = await manager.import('ticket-b'); expect(imported.accountId).toBe(f.b.accountId);
  });
  it.each([undefined, 'unverified-fingerprint'])('多客户端存在缺失或未核实身份%s时不猜等价关系', async accountLicenseIdentity => {
    const f = await setup(), source = importSource([['ticket-a', f.a], ['ticket-a-copy', { ...f.a, product: 'intellij-idea', sourceIdentity: 'fixture-idea' }]]);
    source.listCandidates.mockResolvedValueOnce(source.candidates.map(candidate => ({ ...candidate, accountLicenseIdentity })));
    const result = await f.newManager(f.api, source).importDefault();
    expect(result).toMatchObject({ status: 'selection-required', preview: { candidates: [{ id: 'ticket-a' }, { id: 'ticket-a-copy' }] } }); expect(source.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.exchange).not.toHaveBeenCalled();
  });
  it('唯一旧版候选缺少跨IDE身份指纹时仍可按其有效票据导入', async () => {
    const f = await setup(), source = importSource([['ticket-a', f.a]]); source.listCandidates.mockResolvedValueOnce(source.candidates.map(({ accountLicenseIdentity: _private, ...candidate }) => candidate));
    expect((await f.newManager(f.api, source).importDefault()).status).toBe('imported');
  });
  it('另一IDE选中不受支持来源时不会自动使用唯一的个人许可证候选，须明确选择', async () => {
    const f = await setup(), source = importSource([['ticket-supported', f.a]]), manager = f.newManager(f.api, source); source.candidates[0].defaultRequiresSelection = true;
    const result = await manager.importDefault();
    expect(result).toMatchObject({ status: 'selection-required', preview: { candidates: [{ id: 'ticket-supported' }] } });
    if (result.status === 'selection-required') expect(result.preview.message).toContain('明确选择');
    expect(source.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.exchange).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/defaultRequiresSelection|accountLicenseIdentity|sourceIdentity|licenseId|PRIVATE|eyJ/);
    expect((await manager.import('ticket-supported')).accountId).toBe(f.a.accountId);
  });
  it('空来源及读取错误不产生密钥、网络请求或供应商写入，失败后可重新操作', async () => {
    const f = await setup(), source = importSource([['ticket-a', f.a]]), manager = f.newManager(f.api, source), before = state(f.store);
    source.listCandidates.mockResolvedValueOnce([]); await expect(manager.importDefault()).rejects.toThrow('未找到可导入');
    source.listCandidates.mockRejectedValueOnce(new Error(PRIVATE_ERROR)); const error = await manager.importDefault().catch(value => value);
    expect(error).toBeInstanceOf(JetBrainsIdeAccountError); expect(String(error)).not.toContain(PRIVATE_ERROR); expect(state(f.store)).toEqual(before);
    expect(source.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.exchange).not.toHaveBeenCalled();
    expect((await manager.importDefault()).status).toBe('imported');
  });
  it('扫描阶段也阻止并发手动及默认导入，随后复用同一操作锁完成导入', async () => {
    const f = await setup(), source = importSource([['ticket-a', f.a]]), held = deferred<JetBrainsIdeImportCandidate[]>(), manager = f.newManager(f.api, source);
    source.listCandidates.mockReturnValueOnce(held.promise); const pending = manager.importDefault();
    await expect(manager.importDefault()).rejects.toThrow('正在导入'); await expect(manager.import('ticket-a')).rejects.toThrow('正在导入');
    expect(source.listCandidates).toHaveBeenCalledTimes(1); held.resolve(source.candidates); expect((await pending).status).toBe('imported'); expect(f.api.exchange).toHaveBeenCalledTimes(1);
  });
  it('关闭时立即取消扫描，并忽略不支持取消的读取器迟到结果', async () => {
    const f = await setup(), source = importSource([['ticket-a', f.a]]), held = deferred<JetBrainsIdeImportCandidate[]>(), manager = f.newManager(f.api, source), before = state(f.store);
    source.listCandidates.mockReturnValueOnce(held.promise); const pending = manager.importDefault().catch(error => error as Error); await manager.dispose();
    expect(String(await pending)).toMatch(/取消|已停止/); held.resolve(source.candidates); await new Promise(resolve => setImmediate(resolve));
    expect(source.readCredentials).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.exchange).not.toHaveBeenCalled(); expect(state(f.store)).toEqual(before);
    await expect(manager.importDefault()).rejects.toThrow('已停止'); await expect(manager.import('ticket-a')).rejects.toThrow('已停止'); expect(source.listCandidates).toHaveBeenCalledTimes(1);
  });
  it('默认票据读取失败不会尝试同身份的下一个IDE或其他账号途径', async () => {
    const f = await setup(), source = importSource([['ticket-rider', f.a], ['ticket-idea', { ...f.a, product: 'intellij-idea', sourceIdentity: 'fixture-idea' }]]), manager = f.newManager(f.api, source), before = state(f.store);
    source.readCredentials.mockRejectedValueOnce(new Error(PRIVATE_ERROR)); const error = await manager.importDefault().catch(value => value);
    expect(String(error)).not.toContain(PRIVATE_ERROR); expect(source.readCredentials.mock.calls).toEqual([['ticket-idea']]); expect(f.api.exchange).not.toHaveBeenCalled(); expect(f.localKey).not.toHaveBeenCalled(); expect(state(f.store)).toEqual(before);
  });
  it('候选票据返回另一许可证时在生成密钥和云端授权前拒绝', async () => {
    const f = await setup(), source = importSource([['ticket-a', f.a]]), manager = f.newManager(f.api, source);
    source.readCredentials.mockResolvedValueOnce({ ...f.a, licenseId: 'switched-within-preview' });
    await expect(manager.importDefault()).rejects.toThrow('已切换'); expect(f.localKey).not.toHaveBeenCalled(); expect(f.api.exchange).not.toHaveBeenCalled();
  });
  it.each(['account', 'license', 'product', 'source'] as const)('云端校验期间%s变化时再次核对票据并拒绝迟到保存', async change => {
    const f = await setup(), source = importSource([['ticket-a', f.a]]), manager = f.newManager(f.api, source), held = deferred<SubscriptionUsage>(), before = state(f.store);
    let current = f.a; source.readCredentials.mockImplementation(async () => structuredClone(current)); f.api.quota.mockReturnValueOnce(held.promise);
    const pending = manager.importDefault(); await vi.waitFor(() => expect(f.api.quota).toHaveBeenCalledTimes(1));
    current = change === 'account' ? f.b : change === 'license' ? { ...f.a, licenseId: 'switched-license' } : change === 'product' ? { ...f.a, product: 'webstorm' } : { ...f.a, sourceIdentity: 'switched-source' };
    held.resolve(usage()); await expect(pending).rejects.toThrow('授权期间已切换'); expect(source.readCredentials).toHaveBeenCalledTimes(2); expect(f.api.exchange).toHaveBeenCalledTimes(1); expect(state(f.store)).toEqual(before);
  });
});

describe('IDE 账号导入校验与凭据边界', () => {
  it('套餐未由已核实的原生协议提供时保持未知，并清除旧视图的套餐标签', async () => {
    const { manager } = await setup(), account = await manager.import('ticket-a');
    expect(account.plan).toBeUndefined();
    const decorated = manager.decorate({ ...account, plan: '之前账号的 AI Ultimate' });
    expect(decorated.plan).toBeUndefined(); expect(decorated.usage.windows[0].total).toBe(100);
  });

  it('预览仅返回展示字段；空来源或读取失败均不写供应商、不生成本机密钥', async () => {
    const { manager, reader, store, localKey, api, a } = await setup(), before = state(store);
    const preview = await manager.preview();
    expect(preview.candidates[0]).toEqual({ id: 'ticket-a', clientName: 'Rider 2026.2', accountLabel: a.accountLabel });
    expect(JSON.stringify(preview)).not.toContain(a.idToken);
    reader.listCandidates.mockResolvedValueOnce([]); expect((await manager.preview()).candidates).toEqual([]);
    reader.listCandidates.mockRejectedValueOnce(new Error(PRIVATE_ERROR));
    const error = await manager.preview().catch(value => value);
    expect(error).toBeInstanceOf(JetBrainsIdeAccountError); expect(String(error)).not.toContain(PRIVATE_ERROR);
    expect(state(store)).toEqual(before); expect(localKey).not.toHaveBeenCalled(); expect(api.exchange).not.toHaveBeenCalled(); expect(reader.readCredentials).not.toHaveBeenCalled();
  });

  it.each(['reader', 'exchange', 'quota', 'models'] as const)('%s 校验失败时保留内存和磁盘中的原始记录，隐藏原始异常', async stage => {
    const { manager, reader, api, store, dir, relay } = await setup();
    const existing = store.saveProvider({ name: '手动 API', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://example.test/v1', apiKey: OTHER_KEY, enabled: false }); references(store, existing.id);
    const before = state(store), disk = readFileSync(join(dir, 'modeldock.sqlite'));
    if (stage === 'reader') reader.readCredentials.mockRejectedValueOnce(new Error(PRIVATE_ERROR));
    else api[stage].mockRejectedValueOnce(new Error(PRIVATE_ERROR));
    const failure = await manager.import('ticket-a').catch(value => value);
    expect(failure).toBeInstanceOf(JetBrainsIdeAccountError); expect(String(failure)).not.toContain(PRIVATE_ERROR);
    expect(state(store)).toEqual(before); expect(readFileSync(join(dir, 'modeldock.sqlite'))).toEqual(disk);
    expect(relay.start).not.toHaveBeenCalled(); expect(relay.stop).not.toHaveBeenCalled();
  });

  it('交换成功后才保存；JBA/Grazie 留在主进程，供应商 Key 为独立本机密钥', async () => {
    const { manager, api, store, dir, codec, a } = await setup();
    const account = await manager.import('ticket-a'), provider = store.getProvider(account.providerId)!;
    expect(account).toMatchObject({ kind: 'jetbrains-central', source: 'relay', accountId: a.accountId, displayName: a.accountLabel, authStatus: 'ready', canQueryUsage: true, clientImport: { client: 'jetbrains-ide', upstreamVerified: true }, usage: usage() });
    expect(api.exchange).toHaveBeenCalledWith({ idToken: a.idToken, licenseId: a.licenseId }, expect.any(AbortSignal)); expect(api.quota).toHaveBeenCalledWith(GRAZIE_A, expect.any(AbortSignal)); expect(api.models).toHaveBeenCalledWith(GRAZIE_A, expect.any(AbortSignal));
    expect(provider.baseUrl).toBe(JETBRAINS_RELAY_BASE_URL); expect(store.getSecret(provider.id)).toEqual({ apiKey: LOCAL_KEY });
    const rendererPayload = JSON.stringify({ account, providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), logs: store.logs(100) });
    for (const privateValue of [a.idToken, GRAZIE_A, LOCAL_KEY]) expect(rendererPayload).not.toContain(privateValue);
    expect(rendererPayload).not.toMatch(/idToken|access_token|refresh_token|ai_token|nativeIde/);
    const disk = readFileSync(join(dir, 'modeldock.sqlite'));
    expect(disk.includes(Buffer.from(a.idToken))).toBe(false); expect(disk.includes(Buffer.from(GRAZIE_A))).toBe(false);
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(reopened.getSecret(provider.id)).toEqual({ apiKey: LOCAL_KEY });
    expect(reopened.getManagedState<{ nativeIde: { idToken: string } }>(`auth-metadata:${provider.id}`, { nativeIde: { idToken: '' } }).nativeIde.idToken).toBe(a.idToken);
  });

  it('初始额度随导入原子保存，不因独立额度缓存写入不可用而出现已导入后报失败', async () => {
    const { manager, store } = await setup();
    const independentWrite = vi.spyOn(store, 'setManagedState').mockImplementation(() => { throw new Error(PRIVATE_ERROR); });
    const account = await manager.import('ticket-a');
    expect(account.usage).toEqual(usage()); expect(independentWrite).not.toHaveBeenCalled();
    expect(store.getManagedState(`auth-usage:${account.providerId}`, null)).toBeNull();
    expect(store.getManagedState<{ initialUsage: SubscriptionUsage }>(`auth-metadata:${account.providerId}`, { initialUsage: usage(100) }).initialUsage).toEqual(usage());
  });
});

describe('同账号官方个人 AI 许可证目录批量导入', () => {
  async function catalogFixture() {
    const f = await setup(), source = importSource([['selected-source', f.a]]);
    const rows = [
      { id: f.a.licenseId, plan: 'AI Pro' }, { id: 'synthetic-ultimate-license', plan: 'AI Ultimate' },
      ...[1, 2, 3].map(index => ({ id: `synthetic-free-license-${index}`, plan: 'AI Free' })),
    ].map(row => ({ ...row, expiresAt: '2031-02-03T04:05:06Z' }));
    const licenses = vi.fn(async () => structuredClone(rows));
    f.api.exchange.mockImplementation(async value => ({ token: `PRIVATE_LICENSE_TOKEN_${rows.findIndex(row => row.id === value.licenseId)}`, expiresAt: ROOT_NOW + 300_000 }));
    f.api.quota.mockImplementation(async token => usage(Number(token.split('_').at(-1)) * 10));
    const manager = f.newManager({ ...f.api, licenses }, source);
    return { ...f, source, rows, licenses, manager };
  }
  it('一次导入全部五个个人许可证，保持已有精确来源和模型绑定，三个Free独立且不合并额度', async () => {
    const f = await catalogFixture(), first = await f.manager.import('selected-source'); references(f.store, first.providerId);
    f.store.saveProvider({ ...f.store.getProvider(first.providerId)!, name: '用户指定的 Pro 来源', note: '保留备注' }); const before = state(f.store);
    const result = await f.manager.importDefault(); expect(result.status).toBe('imported'); if (result.status !== 'imported') return;
    expect(result.accounts).toHaveLength(5); expect(result.account.providerId).toBe(first.providerId); expect(result.account.providerName).toBe('用户指定的 Pro 来源');
    expect(result.accounts!.map(account => account.plan)).toEqual(['AI Pro', 'AI Ultimate', 'AI Free', 'AI Free', 'AI Free']);
    expect(new Set(result.accounts!.map(account => account.providerId)).size).toBe(5);
    expect(new Set(result.accounts!.map(account => account.license!.label)).size).toBe(5);
    expect(result.accounts![1].license!.label).toContain('••••' + f.rows[1].id.slice(-4));
    expect(result.accounts!.map(account => account.usage.windows[0].remaining)).toEqual([100, 90, 80, 70, 60]);
    expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
    const publicView = JSON.stringify(result); for (const row of f.rows) expect(publicView).not.toContain(row.id);
    expect(publicView).not.toMatch(/PRIVATE|idToken|accessToken|sourceLicenseId|nativeIde/); expect(f.api.chat).not.toHaveBeenCalled();
    const restored = f.newManager({ ...f.api, licenses: f.licenses }, f.source);
    expect(restored.decorate(relayAccountView(f.store, f.store.getProvider(result.accounts![1].providerId)!)).plan).toBe('AI Ultimate');
    const repeated = await f.manager.importDefault(); expect(repeated.status).toBe('imported');
    if (repeated.status === 'imported') expect(repeated.accounts!.map(account => account.providerId)).toEqual(result.accounts!.map(account => account.providerId));
  });
  it('同账号跨IDE选择不同license也只取一个已确认账号来源，无需弹选择框', async () => {
    const f = await catalogFixture(), source = importSource([['rider-source', f.a], ['idea-source', { ...f.a, product: 'intellij-idea', sourceIdentity: 'fixture-idea-selected-other-license', licenseId: f.rows[1].id }]]);
    const manager = f.newManager({ ...f.api, licenses: f.licenses }, source), result = await manager.importDefault();
    expect(result.status).toBe('imported'); if (result.status === 'imported') expect(result.accounts).toHaveLength(5);
    expect(f.licenses).toHaveBeenCalledTimes(1); expect(source.readCredentials.mock.calls.every(call => call[0] === 'idea-source')).toBe(true);
  });
  it('明确选择复用原始opaque票据，不重扫改变票据或触及另一账号', async () => {
    const f = await catalogFixture(), source = importSource([['account-a', f.a], ['account-b', f.b]]), manager = f.newManager({ ...f.api, licenses: f.licenses }, source);
    const preview = await manager.importDefault(); expect(preview.status).toBe('selection-required'); expect(f.licenses).not.toHaveBeenCalled();
    source.listCandidates.mockRejectedValue(new Error('A source rescan would invalidate opaque tickets'));
    const result = await manager.importDefault('account-a'); expect(result.status).toBe('imported');
    expect(source.listCandidates).toHaveBeenCalledTimes(1); expect(source.readCredentials.mock.calls.every(call => call[0] === 'account-a')).toBe(true);
    expect(f.licenses).toHaveBeenCalledWith(expect.objectContaining({ accountId: f.a.accountId, idToken: f.a.idToken }), expect.any(AbortSignal));
    await expect(manager.importDefault('invented-choice')).rejects.toThrow('已过期');
  });
  it('部分许可交换失败只报告该许可，成功来源独立保留而没有推理重试', async () => {
    const f = await catalogFixture(), original = f.api.exchange.getMockImplementation()!;
    f.api.exchange.mockImplementation(async (input, signal) => { if (input.licenseId === f.rows[1].id) throw new Error(PRIVATE_ERROR); return original(input, signal); });
    const result = await f.manager.importDefault(); expect(result.status).toBe('imported'); if (result.status !== 'imported') return;
    expect(result.accounts).toHaveLength(4); expect(result.failures).toHaveLength(1); expect(result.failures![0].label).toContain('AI Ultimate');
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ERROR); expect(f.api.exchange).toHaveBeenCalledTimes(5); expect(f.api.quota).toHaveBeenCalledTimes(4); expect(f.api.chat).not.toHaveBeenCalled();
  });
  it('目录等待期间本机来源切换则拒绝全部派生许可证，不使用迟到目录发起交换', async () => {
    const f = await catalogFixture(), held = deferred<typeof f.rows>(), before = state(f.store); f.licenses.mockReturnValueOnce(held.promise);
    const pending = f.manager.importDefault(); await vi.waitFor(() => expect(f.licenses).toHaveBeenCalledTimes(1));
    f.source.readCredentials.mockResolvedValue(f.b); held.resolve(f.rows);
    await expect(pending).rejects.toThrow('来源已切换'); expect(f.api.exchange).not.toHaveBeenCalled(); expect(state(f.store)).toEqual(before);
  });
  it('关闭时取消官方目录读取，忽略非协作端口迟到结果且不写入任何来源', async () => {
    const f = await catalogFixture(), held = deferred<typeof f.rows>(), before = state(f.store); f.licenses.mockReturnValueOnce(held.promise);
    const pending = f.manager.importDefault().catch(error => error as Error); await vi.waitFor(() => expect(f.licenses).toHaveBeenCalledTimes(1));
    await f.manager.dispose(); expect(String(await pending)).toMatch(/取消|已停止/); held.resolve(f.rows); await new Promise(resolve => setImmediate(resolve));
    expect(f.api.exchange).not.toHaveBeenCalled(); expect(state(f.store)).toEqual(before);
  });
  it('空目录、目录超限及所选来源license缺席不使用另一许可、不交换也不写入', async () => {
    for (const mode of ['empty', 'oversize', 'missing-source'] as const) {
      const f = await catalogFixture(), before = state(f.store);
      f.licenses.mockResolvedValue(mode === 'empty' ? [] : mode === 'oversize' ? Array.from({ length: 129 }, (_, index) => ({ ...f.rows[0], id: 'oversize-' + index })) : [f.rows[1]]);
      await expect(f.manager.importDefault()).rejects.toThrow(); expect(state(f.store)).toEqual(before); expect(f.api.exchange).not.toHaveBeenCalled();
    }
  });
  it('刷新为已有未知套餐补精确官方名称，失败保留旧核验日期，成功目录缺席则清除名称', async () => {
    const f = await catalogFixture(), legacy = f.newManager(f.api, f.source), imported = await legacy.import('selected-source');
    expect(imported.plan).toBeUndefined(); const before = state(f.store);
    const refreshed = await f.manager.refreshUsage(imported.providerId); expect(refreshed.plan).toBe('AI Pro'); expect(refreshed.license?.verifiedAt).toBe(new Date(ROOT_NOW).toISOString());
    expect(f.store.listProviders()).toEqual(before.providers); expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
    f.advance(1000); f.licenses.mockRejectedValueOnce(new Error(PRIVATE_ERROR)); const cached = await f.manager.refreshUsage(imported.providerId);
    expect(cached.plan).toBe('AI Pro'); expect(cached.license?.verifiedAt).toBe(refreshed.license?.verifiedAt);
    f.licenses.mockResolvedValueOnce([f.rows[1]]); const removed = await f.manager.refreshUsage(imported.providerId);
    expect(removed.plan).toBeUndefined(); expect(removed.license).toBeUndefined(); expect(f.store.listProviders()).toEqual(before.providers);
  });
  it('重新导入产生新修订后，迟到的旧套餐目录不会覆盖新套餐或额度', async () => {
    const f = await catalogFixture(), imported = await f.manager.import('selected-source'), held = deferred<typeof f.rows>();
    f.licenses.mockReturnValueOnce(held.promise);
    const pending = f.manager.refreshUsage(imported.providerId).catch(error => error as Error); await vi.waitFor(() => expect(f.licenses).toHaveBeenCalledTimes(2));
    f.rows[0].plan = 'AI Pro 官方新名称'; const refreshed = await f.manager.import('selected-source'); expect(refreshed.providerId).toBe(imported.providerId);
    held.resolve([{ ...f.rows[0], plan: '迟到旧名称' }]); expect(String(await pending)).toMatch(/取消|已变更/);
    expect(f.manager.decorate(relayAccountView(f.store, f.store.getProvider(imported.providerId)!)).plan).toBe('AI Pro 官方新名称');
  });
  it('JCP续期始终核对本机source license，而派生交换仍使用各自target license', async () => {
    const f = await catalogFixture(), { idToken: _private, ...identity } = f.a;
    const initial = { ...identity, tokenType: 'jcp-global-access-token', accessToken: 'PRIVATE_SDK_BASE_ACCESS', expiresAt: ROOT_NOW + 3600_000 } as unknown as JetBrainsIdeCredentials;
    const renewCredentials = vi.fn(async () => initial), source = { ...f.source, readCredentials: vi.fn(async () => initial), renewCredentials };
    const exchangeJcp = vi.fn(async (input: { accessToken: string; licenseId: string }) => ({ token: `PRIVATE_LICENSE_TOKEN_${f.rows.findIndex(row => row.id === input.licenseId)}`, expiresAt: ROOT_NOW + 300_000 }));
    const manager = f.newManager({ ...f.api, licenses: f.licenses, exchangeJcp }, source), result = await manager.importDefault();
    expect(result.status).toBe('imported'); if (result.status !== 'imported') return;
    const ultimate = result.accounts!.find(account => account.plan === 'AI Ultimate')!; f.advance(300_001);
    await manager.credentials(ultimate.providerId);
    expect(renewCredentials).toHaveBeenCalledWith({ product: f.a.product, accountId: f.a.accountId, licenseId: f.a.licenseId, sourceIdentity: f.a.sourceIdentity });
    expect(exchangeJcp.mock.calls.at(-1)![0].licenseId).toBe(f.rows[1].id);
    const stored = f.store.getManagedState<{ nativeIde: { sourceLicenseId: string; licenseId: string } }>(`auth-metadata:${ultimate.providerId}`, { nativeIde: { sourceLicenseId: '', licenseId: '' } });
    expect(stored.nativeIde).toMatchObject({ sourceLicenseId: f.a.licenseId, licenseId: f.rows[1].id });
  });
});

describe('IDE 导入保留已有连接与并发编辑', () => {
  it('同一账号不同许可证分别保存，重导入只更新精确许可证并保留另一来源模型与绑定', async () => {
    const f = await setup(), secondLicense = { ...f.a, licenseId: 'synthetic-second-personal-license', sourceIdentity: 'fixture-second-license' };
    const source = importSource([['license-a', f.a], ['license-b', secondLicense]]), manager = f.newManager(f.api, source);
    f.api.exchange.mockImplementation(async value => ({ token: value.licenseId === secondLicense.licenseId ? GRAZIE_B : GRAZIE_A, expiresAt: ROOT_NOW + 300_000 }));
    const first = await manager.import('license-a'); references(f.store, first.providerId); const before = state(f.store);
    const second = await manager.import('license-b'); expect(second.providerId).not.toBe(first.providerId);
    expect(second.providerName).not.toBe(first.providerName); expect(second.usage).toEqual(usage(45));
    expect(f.account(first.providerId)).toMatchObject({ accountId: f.a.accountId, usage: usage(10) });
    expect(f.store.getProvider(first.providerId)).toEqual(before.providers.find(item => item.id === first.providerId));
    expect(f.store.getManagedState(`auth-metadata:${first.providerId}`, null)).toEqual(before.metadata.find(([id]) => id === first.providerId)![1]);
    const again = await manager.import('license-b'); expect(again.providerId).toBe(second.providerId);
    expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
    const nativeIds = f.store.listProviders().filter(item => manager.isNativeProvider(item.id)).map(item => item.id);
    expect(nativeIds).toEqual([first.providerId, second.providerId]);
  });
  it('唯一空订阅来源可承接首个导入，存在任一已导入账号后不再把空来源改绑', async () => {
    const f = await setup(), empty = f.store.saveProvider({ name: '空的 IDE 来源', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, enabled: true });
    const first = await f.manager.import('ticket-a'); expect(first.providerId).toBe(empty.id);
    const spare = f.store.saveProvider({ name: '用户留待配置的空来源', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, enabled: false });
    const second = await f.manager.import('ticket-b'); expect(second.providerId).not.toBe(first.providerId); expect(second.providerId).not.toBe(spare.id);
    expect(f.store.getProvider(spare.id)).toEqual(spare); expect(f.store.getSecret(spare.id)).toBeUndefined();
  });
  it('已连接的 Central 来源即使用同一本机 Key 也不会被 IDE 导入覆盖', async () => {
    const f = await setup(), central = f.store.saveProvider({ name: '既有 Central', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, apiKey: LOCAL_KEY, enabled: true });
    f.store.setManagedState(`auth-metadata:${central.id}`, { clientImport: { client: 'jetbrains-central' }, nativeCentral: { fixture: true } });
    references(f.store, central.id); const before = state(f.store), imported = await f.manager.import('ticket-a');
    expect(imported.providerId).not.toBe(central.id); expect(f.store.getProvider(central.id)).toEqual(central);
    expect(f.store.getManagedState(`auth-metadata:${central.id}`, null)).toEqual(before.metadata.find(([id]) => id === central.id)![1]);
    expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
  });
  it('同源再次导入保留供应商 ID、名称、备注、Key、模型和工具选择', async () => {
    const { manager, store, advance } = await setup();
    const first = await manager.import('ticket-a'), provider = store.getProvider(first.providerId)!;
    store.saveProvider({ ...provider, name: '我的 IDE 会员', note: '用户保留的用途', enabled: false }); references(store, provider.id);
    const before = state(store), previousRevision = store.getManagedState<{ revision: string }>(`auth-metadata:${provider.id}`, { revision: '' }).revision;
    advance(1000); const second = await manager.import('ticket-a'), after = state(store);
    expect(second.providerId).toBe(first.providerId); expect(after.providers).toEqual(before.providers); expect(after.models).toEqual(before.models); expect(after.bindings).toEqual(before.bindings); expect(after.secrets).toEqual(before.secrets);
    expect(store.listProviders()).toHaveLength(before.providers.length); expect(store.getManagedState<{ revision: string }>(`auth-metadata:${provider.id}`, { revision: '' }).revision).not.toBe(previousRevision);
  });

  it('不覆盖手动其他 URL、同端点自定义 API 或不同 Key 的既有连接', async () => {
    const { manager, store } = await setup();
    const manual = store.saveProvider({ name: '手动中转', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'http://127.0.0.1:19090/v1', apiKey: OTHER_KEY, enabled: false, note: '保留手动来源' });
    const custom = store.saveProvider({ name: '其他自定义 API', kind: 'openai-compatible', presetId: 'custom', baseUrl: JETBRAINS_RELAY_BASE_URL, apiKey: LOCAL_KEY, enabled: false });
    const separate = store.saveProvider({ name: '独立 Key 的 Central 连接', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, apiKey: OTHER_KEY, enabled: false });
    references(store, manual.id); const before = state(store), account = await manager.import('ticket-a');
    expect([manual.id, custom.id, separate.id]).not.toContain(account.providerId);
    for (const provider of [manual, custom, separate]) expect(store.getProvider(provider.id)).toEqual(provider);
    expect(store.getSecret(manual.id)).toEqual({ apiKey: OTHER_KEY }); expect(store.getSecret(custom.id)).toEqual({ apiKey: LOCAL_KEY }); expect(store.getSecret(separate.id)).toEqual({ apiKey: OTHER_KEY });
    expect(store.listModels()).toEqual(before.models); expect(store.listBindings()).toEqual(before.bindings);
  });

  it('云端确认期间用户修改连接时 CAS 拒绝导入，保留用户的新值', async () => {
    const { manager, api, store } = await setup();
    const imported = await manager.import('ticket-a'), existing = store.getProvider(imported.providerId)!; references(store, existing.id); api.exchange.mockClear();
    const exchange = deferred<{ token: string; expiresAt: number }>(); api.exchange.mockImplementationOnce(() => exchange.promise);
    const pending = manager.import('ticket-a'); await vi.waitFor(() => expect(api.exchange).toHaveBeenCalledTimes(1));
    store.saveProvider({ ...existing, name: '用户刚修改的名称', note: '用户刚修改的备注', apiKey: OTHER_KEY }); const edited = state(store);
    await expect(manager.import('ticket-b')).rejects.toThrow('正在导入');
    exchange.resolve({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 });
    await expect(pending).rejects.toThrow('本地记录未能保存'); expect(state(store)).toEqual(edited);
  });

  it('加密保存失败时保留旧账号、额度、配置和正在可用的旧授权会话', async () => {
    const { manager, api, store, dir, failMetadataEncryption, repairEncryption, account, adapter } = await setup();
    const first = await manager.import('ticket-a'); references(store, first.providerId);
    const before = state(store), disk = readFileSync(join(dir, 'modeldock.sqlite')); failMetadataEncryption();
    try {
      const failure = await manager.import('ticket-b').catch(value => value);
      expect(String(failure)).toContain('本地记录未能保存'); expect(String(failure)).not.toContain(PRIVATE_ERROR);
      expect(state(store)).toEqual(before); expect(readFileSync(join(dir, 'modeldock.sqlite'))).toEqual(disk); expect(account(first.providerId).accountId).toBe('fixture-a');
    } finally { repairEncryption(); }
    await manager.startRelay(first.providerId); await adapter().models(new AbortController().signal);
    expect(api.exchange).toHaveBeenCalledTimes(2); expect(api.models.mock.calls.at(-1)?.[0]).toBe(GRAZIE_A);
  });
});

describe('IDE 授权会话缓存、额度修订与原生 adapter', () => {
  it('另一账号导入成为独立来源，旧账号额度晚返回只更新原账号', async () => {
    const { manager, api, store, account } = await setup();
    const first = await manager.import('ticket-a'), delayed = deferred<SubscriptionUsage>();
    api.quota.mockImplementationOnce(() => delayed.promise);
    const pending = manager.refreshUsage(first.providerId); await vi.waitFor(() => expect(api.quota).toHaveBeenCalledTimes(2));
    const replacement = await manager.import('ticket-b'); expect(replacement.providerId).not.toBe(first.providerId); expect(replacement.accountId).toBe('fixture-b'); expect(replacement.usage).toEqual(usage(45));
    delayed.resolve(usage(90)); await expect(pending).resolves.toMatchObject({ accountId: 'fixture-a', usage: usage(90) });
    expect(account(first.providerId)).toMatchObject({ accountId: 'fixture-a', usage: usage(90) });
    expect(account(replacement.providerId)).toMatchObject({ accountId: 'fixture-b', usage: usage(45) });
    expect(store.getManagedState(`auth-usage:${replacement.providerId}`, null)).toBeNull();
  });

  it('缓存 Grazie 会话；即将到期时并发目录和额度只交换一次，并使用新授权', async () => {
    const { manager, api, advance, adapter } = await setup(), first = await manager.import('ticket-a');
    await manager.startRelay(first.providerId); await adapter().models(new AbortController().signal); await manager.refreshUsage(first.providerId);
    expect(api.exchange).toHaveBeenCalledTimes(1);
    advance(4 * 60_000 + 31_000);
    const renewed = deferred<{ token: string; expiresAt: number }>(); api.exchange.mockImplementationOnce(() => renewed.promise);
    const queries = [manager.refreshUsage(first.providerId), adapter().models(new AbortController().signal), adapter().models(new AbortController().signal)];
    await vi.waitFor(() => expect(api.exchange).toHaveBeenCalledTimes(2));
    renewed.resolve({ token: 'PRIVATE_GRAZIE_RENEWED_SESSION', expiresAt: ROOT_NOW + 10 * 60_000 }); await Promise.all(queries);
    expect(api.exchange).toHaveBeenCalledTimes(2); expect(api.quota.mock.calls.at(-1)?.[0]).toBe('PRIVATE_GRAZIE_RENEWED_SESSION'); expect(api.models.mock.calls.at(-1)?.[0]).toBe('PRIVATE_GRAZIE_RENEWED_SESSION');
  });

  it('目录和模型请求经原生Gateway adapter且不启动独立监听，原始模型故障只返回安全错误', async () => {
    const { manager, api, relay, adapter } = await setup(), first = await manager.import('ticket-a');
    await manager.startRelay(first.providerId); await manager.startRelay(first.providerId);
    expect(relay.start).not.toHaveBeenCalled(); expect(relay.stop).not.toHaveBeenCalled();
    const controller = new AbortController(), body = { model: 'native-profile-fixture', messages: [{ role: 'user', content: 'Synthetic prompt' }], stream: false };
    expect(await adapter().models(controller.signal)).toEqual({ data: [{ id: 'native-profile-fixture', object: 'model' }] });
    const result = await adapter().chat(body, controller.signal); expect(await result.text()).toContain('MOCK_NATIVE_OK'); expect(api.chat).toHaveBeenCalledWith(GRAZIE_A, body, controller.signal);
    api.chat.mockRejectedValueOnce(new Error(PRIVATE_ERROR)); const error = await adapter().chat(body, controller.signal).catch(value => value);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(PRIVATE_ERROR);
  });

  it('旧 JBA source exp 仅作提示，仍交服务端验证；公开到期时间仅来自已验证的派生会话', async () => {
    const { manager, api, reader, store, newManager } = await setup(), old = credentials('a', ROOT_NOW - 24 * 60 * 60_000);
    reader.readCredentials.mockResolvedValueOnce(old);
    api.exchange.mockResolvedValue({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 });
    const first = await manager.import('ticket-a');
    expect(api.exchange).toHaveBeenCalledWith({ idToken: old.idToken, licenseId: old.licenseId }, expect.any(AbortSignal));
    expect(first).toMatchObject({ authStatus: 'ready', expiresAt: ROOT_NOW + 5 * 60_000, usage: usage() });
    expect(first.expiresAt).not.toBe(old.sourceTokenExpHint);
    const persisted = store.getManagedState<{ nativeIde: Record<string, unknown> }>(`auth-metadata:${first.providerId}`, { nativeIde: {} }).nativeIde;
    expect(persisted.sourceTokenExpHint).toBe(old.sourceTokenExpHint); expect(persisted).not.toHaveProperty('expiresAt');
    // Simulate reopening the coordinator: source metadata persists, but no
    // derived authorization has been verified in this new process yet.
    const restored = newManager(), beforeVerification = restored.decorate(relayAccountView(store, store.getProvider(first.providerId)!));
    expect(beforeVerification.expiresAt).toBeUndefined();
    const verified = await restored.refreshUsage(first.providerId);
    expect(api.exchange).toHaveBeenCalledTimes(2); expect(verified.expiresAt).toBe(ROOT_NOW + 5 * 60_000);
  });

  it('旧 source 票据被官方交换拒绝时不写入供应商，不凭本地 exp 猜测成功或失败', async () => {
    const { manager, api, reader, store } = await setup(), old = credentials('a', ROOT_NOW - 60_000), before = state(store);
    reader.readCredentials.mockResolvedValueOnce(old); api.exchange.mockRejectedValueOnce(new JetBrainsIdeApiError('authorization'));
    const failure = await manager.import('ticket-a').catch(value => value);
    expect(failure).toBeInstanceOf(JetBrainsIdeAccountError); expect(String(failure)).not.toContain(PRIVATE_ERROR);
    expect(api.exchange).toHaveBeenCalledWith({ idToken: old.idToken, licenseId: old.licenseId }, expect.any(AbortSignal));
    expect(api.quota).not.toHaveBeenCalled(); expect(api.models).not.toHaveBeenCalled(); expect(state(store)).toEqual(before);
  });

  it('额度刷新失败清除导入时的旧余额，避免 initialUsage 再次显示为当前额度', async () => {
    const { manager, api, store, account } = await setup(), first = await manager.import('ticket-a');
    expect(first.usage).toEqual(usage());
    api.quota.mockRejectedValueOnce(new Error(PRIVATE_ERROR));
    const failed = await manager.refreshUsage(first.providerId);
    expect(failed.usage).toMatchObject({ status: 'unavailable', windows: [] }); expect(JSON.stringify(failed)).not.toContain(PRIVATE_ERROR);
    expect(account(first.providerId).usage).toEqual(failed.usage);
    expect(store.getManagedState<{ usage: SubscriptionUsage }>(`auth-usage:${first.providerId}`, { usage: usage() }).usage).toEqual(failed.usage);
    api.quota.mockResolvedValueOnce(usage(55));
    expect((await manager.refreshUsage(first.providerId)).usage).toEqual(usage(55));
  });

  it('派生会话续换被服务端拒绝后移除旧额度且不能启动推理中转', async () => {
    const { manager, api, reader, relay, advance, account } = await setup(), old = credentials('a', ROOT_NOW - 60_000);
    reader.readCredentials.mockResolvedValueOnce(old); api.exchange.mockResolvedValueOnce({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 });
    const first = await manager.import('ticket-a'); advance(5 * 60_000 + 1);
    api.exchange.mockRejectedValue(new JetBrainsIdeApiError('authorization'));
    const failed = await manager.refreshUsage(first.providerId);
    expect(api.exchange).toHaveBeenCalledTimes(2); expect(failed.usage).toMatchObject({ status: 'unavailable', windows: [] });
    expect(account(first.providerId).usage.windows).toEqual([]); expect(account(first.providerId).expiresAt).toBeUndefined();
    await expect(manager.startRelay(first.providerId)).rejects.toThrow(JetBrainsIdeAccountError);
    expect(relay.start).not.toHaveBeenCalled(); expect(JSON.stringify(account(first.providerId))).not.toMatch(/PRIVATE_|idToken|accessToken/);
  });
});

describe('IDE shared authorization cancellation and lifecycle', () => {
  it('cancels one authorization waiter promptly without aborting another waiter sharing the exchange', async () => {
    const f = await setup(), imported = await f.manager.import('ticket-a'), restored = f.newManager();
    const held = deferred<{ token: string; expiresAt: number }>(); f.api.exchange.mockReturnValueOnce(held.promise);
    const one = new AbortController(), two = new AbortController();
    const first = restored.credentials(imported.providerId, one.signal).catch(error => error as Error), second = restored.credentials(imported.providerId, two.signal);
    expect(f.api.exchange).toHaveBeenCalledTimes(2); const upstream = f.api.exchange.mock.calls[1][1]!;
    one.abort(); expect(String(await first)).toContain('取消'); expect(upstream.aborted).toBe(false);
    held.resolve({ token: 'PRIVATE_SHARED_SESSION', expiresAt: ROOT_NOW + 300_000 }); expect((await second).token).toBe('PRIVATE_SHARED_SESSION'); expect(f.api.exchange).toHaveBeenCalledTimes(2);
  });
  it('aborts upstream when the last waiter cancels and does not cache a late result', async () => {
    const f = await setup(), imported = await f.manager.import('ticket-a'), restored = f.newManager();
    const held = deferred<{ token: string; expiresAt: number }>(); f.api.exchange.mockReturnValueOnce(held.promise); const controller = new AbortController();
    const pending = restored.credentials(imported.providerId, controller.signal).catch(error => error as Error); const upstream = f.api.exchange.mock.calls[1][1]!;
    controller.abort(); expect(String(await pending)).toContain('取消'); expect(upstream.aborted).toBe(true);
    held.resolve({ token: 'PRIVATE_LATE_CANCELED_SESSION', expiresAt: ROOT_NOW + 300_000 }); await new Promise(resolve => setImmediate(resolve));
    expect((await restored.credentials(imported.providerId)).token).toBe(GRAZIE_A); expect(f.api.exchange).toHaveBeenCalledTimes(3);
  });
  it('disposes an in-flight import immediately, propagates abort and refuses late provider/usage writes', async () => {
    const f = await setup(), before = state(f.store), held = deferred<{ token: string; expiresAt: number }>(); f.api.exchange.mockReturnValueOnce(held.promise);
    const pending = f.manager.import('ticket-a').catch(error => error as Error); await vi.waitFor(() => expect(f.api.exchange).toHaveBeenCalledTimes(1)); const upstream = f.api.exchange.mock.calls[0][1]!;
    await f.manager.dispose(); expect(String(await pending)).toContain('取消'); expect(upstream.aborted).toBe(true);
    held.resolve({ token: GRAZIE_A, expiresAt: ROOT_NOW + 300_000 }); await new Promise(resolve => setImmediate(resolve)); expect(state(f.store)).toEqual(before); expect(f.api.quota).not.toHaveBeenCalled(); expect(f.api.models).not.toHaveBeenCalled();
    await expect(f.manager.preview()).rejects.toThrow('已停止');
  });
  it.each(['remove', 'dispose'] as const)('cancels pending quota on %s even when the injected service ignores AbortSignal', async action => {
    const f = await setup(), imported = await f.manager.import('ticket-a'), held = deferred<SubscriptionUsage>(); f.api.quota.mockReturnValueOnce(held.promise);
    const pending = f.manager.refreshUsage(imported.providerId).catch(error => error as Error); await vi.waitFor(() => expect(f.api.quota).toHaveBeenCalledTimes(2)); const upstream = f.api.quota.mock.calls[1][1]!;
    if (action === 'remove') await f.manager.providerRemoved(imported.providerId); else await f.manager.dispose();
    expect(String(await pending)).toMatch(/取消|已停止/); expect(upstream.aborted).toBe(true); held.resolve(usage(99)); await new Promise(resolve => setImmediate(resolve)); expect(f.store.getManagedState(`auth-usage:${imported.providerId}`, null)).toBeNull();
  });
  it('aborts a shared exchange on provider removal and rejects a late native credential result', async () => {
    const f = await setup(), imported = await f.manager.import('ticket-a'), restored = f.newManager(), held = deferred<{ token: string; expiresAt: number }>(); f.api.exchange.mockReturnValueOnce(held.promise);
    const pending = restored.credentials(imported.providerId).catch(error => error as Error), upstream = f.api.exchange.mock.calls[1][1]!;
    await restored.providerRemoved(imported.providerId); expect(String(await pending)).toContain('取消'); expect(upstream.aborted).toBe(true); held.resolve({ token: 'PRIVATE_REMOVED_LATE_SESSION', expiresAt: ROOT_NOW + 300_000 }); await new Promise(resolve => setImmediate(resolve));
    expect((await restored.credentials(imported.providerId)).token).toBe(GRAZIE_A); expect(f.api.exchange).toHaveBeenCalledTimes(3);
  });
  it.each(['quota', 'models'] as const)('aborts pending import %s and preserves the previous account when the provider is removed', async stage => {
    const f = await setup(), first = await f.manager.import('ticket-a'), before = state(f.store), held = deferred<SubscriptionUsage | { data: { id: string; object: 'model' }[] }>();
    if (stage === 'quota') f.api.quota.mockReturnValueOnce(held.promise as Promise<SubscriptionUsage>); else f.api.models.mockReturnValueOnce(held.promise as Promise<{ data: { id: string; object: 'model' }[] }>);
    const pending = f.manager.import('ticket-a').catch(error => error as Error); await vi.waitFor(() => expect(f.api[stage]).toHaveBeenCalledTimes(2)); const upstream = f.api[stage].mock.calls[1][1]!;
    await f.manager.providerRemoved(first.providerId); expect(String(await pending)).toContain('取消'); expect(upstream.aborted).toBe(true);
    held.resolve(stage === 'quota' ? usage(99) : { data: [] }); await new Promise(resolve => setImmediate(resolve)); expect(state(f.store)).toEqual(before);
  });
});

describe('可选 OS Integration SDK 凭据的身份与保密边界', () => {
  function sdkCredentials(value: JetBrainsIdeCredentials, accessToken: string): JetBrainsIdeCredentials {
    const { idToken: _idToken, sourceTokenExpHint: _sourceHint, ...identity } = value;
    // The reader's SDK result is a distinct credential variant. This bridge
    // fixture remains explicit while the legacy reader type is kept separate.
    return { ...identity, tokenType: 'jcp-global-access-token', accessToken, expiresAt: ROOT_NOW + 60 * 60_000 } as unknown as JetBrainsIdeCredentials;
  }
  it('cancels an SDK renewal wait without allowing a late noncancellable reader result to exchange or write', async () => {
    const f = await setup(), sourceToken = 'PRIVATE_SDK_SOURCE_ACCESS', held = deferred<JetBrainsIdeCredentials>();
    const initial = sdkCredentials(f.a, sourceToken), reader = { ...f.reader, renewCredentials: vi.fn(async () => held.promise) }; reader.readCredentials.mockResolvedValue(initial);
    const exchangeJcp = vi.fn(async (_input: { accessToken: string; licenseId: string }, _signal?: AbortSignal) => ({ token: GRAZIE_A, expiresAt: ROOT_NOW + 300_000 }));
    const manager = f.newManager({ ...f.api, exchangeJcp }, reader), imported = await manager.import('ticket-a'), before = state(f.store); f.advance(300_001);
    const pending = manager.credentials(imported.providerId).catch(error => error as Error); expect(reader.renewCredentials).toHaveBeenCalledTimes(1); await manager.dispose(); expect(String(await pending)).toContain('取消');
    held.resolve(sdkCredentials(f.a, 'PRIVATE_LATE_SDK_ACCESS')); await new Promise(resolve => setImmediate(resolve)); expect(exchangeJcp).toHaveBeenCalledTimes(1); expect(state(f.store)).toEqual(before);
  });

  it('SDK token 仅走显式 JCP 交换，不冒充 ID token 或公开账号身份', async () => {
    const { api, reader, store, a, newManager } = await setup(), sdkToken = 'PRIVATE_OS_SDK_EXACT_AUDIENCE_ACCESS_TOKEN';
    reader.readCredentials.mockResolvedValueOnce(sdkCredentials(a, sdkToken));
    const exchangeJcp = vi.fn(async (_value: { accessToken: string; licenseId: string }) => ({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 }));
    const manager = newManager({ ...api, exchangeJcp }), imported = await manager.import('ticket-a');
    expect(api.exchange).not.toHaveBeenCalled(); expect(exchangeJcp).toHaveBeenCalledWith({ accessToken: sdkToken, licenseId: a.licenseId }, expect.any(AbortSignal));
    expect(imported).toMatchObject({ accountId: a.accountId, displayName: a.accountLabel, clientImport: { client: 'jetbrains-ide' } });
    const metadata = store.getManagedState<{ nativeIde: Record<string, unknown> }>(`auth-metadata:${imported.providerId}`, { nativeIde: {} });
    expect(metadata.nativeIde.tokenType).toBe('jcp-global-access-token'); expect(metadata.nativeIde.accessToken).toBe(sdkToken); expect(metadata.nativeIde).not.toHaveProperty('idToken');
    expect(store.getSecret(imported.providerId)).toEqual({ apiKey: LOCAL_KEY });
    const publicViews = JSON.stringify({ imported, providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings() });
    for (const secret of [sdkToken, a.idToken, GRAZIE_A, LOCAL_KEY]) expect(publicViews).not.toContain(secret);
    expect(publicViews).not.toMatch(/idToken|accessToken|nativeIde/);
  });

  it('没有可选 JCP 交换能力时安全拒绝 SDK 凭据，不回落到 legacy ID-token 接口', async () => {
    const { manager, api, reader, store, a } = await setup(), before = state(store);
    reader.readCredentials.mockResolvedValueOnce(sdkCredentials(a, 'PRIVATE_OS_SDK_ACCESS_TOKEN'));
    await expect(manager.import('ticket-a')).rejects.toThrow('尚未接入');
    expect(api.exchange).not.toHaveBeenCalled(); expect(api.quota).not.toHaveBeenCalled(); expect(api.models).not.toHaveBeenCalled(); expect(state(store)).toEqual(before);
  });

  it('SDK 续换若切换账号或许可证则拒绝采用新身份，保留原账号及其本机 Key', async () => {
    const { api, reader, store, a, b, newManager, advance } = await setup();
    const initial = sdkCredentials(a, 'PRIVATE_OS_SDK_ACCOUNT_A'), switched = sdkCredentials(b, 'PRIVATE_OS_SDK_ACCOUNT_B');
    const source = { ...reader, readCredentials: vi.fn(async () => initial), renewCredentials: vi.fn(async () => switched) };
    const exchangeJcp = vi.fn(async (_value: { accessToken: string; licenseId: string }) => ({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 }));
    const manager = newManager({ ...api, exchangeJcp }, source), first = await manager.import('ticket-a'); advance(4 * 60_000 + 31_000);
    const failed = await manager.refreshUsage(first.providerId);
    expect(source.renewCredentials).toHaveBeenCalledWith({ product: a.product, accountId: a.accountId, licenseId: a.licenseId, sourceIdentity: a.sourceIdentity });
    expect(exchangeJcp).toHaveBeenCalledTimes(1); expect(api.exchange).not.toHaveBeenCalled();
    expect(failed).toMatchObject({ accountId: a.accountId, displayName: a.accountLabel, usage: { status: 'unavailable', windows: [] } });
    expect(store.getSecret(first.providerId)).toEqual({ apiKey: LOCAL_KEY }); expect(JSON.stringify(failed)).not.toMatch(/PRIVATE_OS_SDK|fixture-b|合成 IDE 账号 B/);
  });
});
