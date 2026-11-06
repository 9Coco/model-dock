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

describe('IDE 导入保留已有连接与并发编辑', () => {
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
    const existing = store.saveProvider({ name: '原有本机连接', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, apiKey: LOCAL_KEY, enabled: true }); references(store, existing.id);
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
  it('旧账号额度晚返回时不覆盖新导入账号的初始额度', async () => {
    const { manager, api, store, account } = await setup();
    const first = await manager.import('ticket-a'), delayed = deferred<SubscriptionUsage>();
    api.quota.mockImplementationOnce(() => delayed.promise);
    const pending = manager.refreshUsage(first.providerId); await vi.waitFor(() => expect(api.quota).toHaveBeenCalledTimes(2));
    const replacement = await manager.import('ticket-b'); expect(replacement.providerId).toBe(first.providerId); expect(replacement.accountId).toBe('fixture-b'); expect(replacement.usage).toEqual(usage(45));
    delayed.resolve(usage(90)); await expect(pending).rejects.toThrow(/查询期间已变更|取消/);
    expect(account(first.providerId)).toMatchObject({ accountId: 'fixture-b', usage: usage(45) });
    expect(store.getManagedState(`auth-usage:${first.providerId}`, null)).toBeNull();
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
    const pending = f.manager.import('ticket-b').catch(error => error as Error); await vi.waitFor(() => expect(f.api[stage]).toHaveBeenCalledTimes(2)); const upstream = f.api[stage].mock.calls[1][1]!;
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
