import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { JetBrainsIdeAccounts, JetBrainsIdeAccountError, type JetBrainsIdeApiPort } from '../src/main/jetbrains-ide-account';
import { JetBrainsIdeApiError } from '../src/main/jetbrains-ide-api';
import type { JetBrainsIdeCredentials, JetBrainsIdeImportCandidate } from '../src/main/jetbrains-ide-import';
import { JetBrainsIdeRelay, JetBrainsIdeRelayFailure, type JetBrainsIdeRelayAdapter } from '../src/main/jetbrains-ide-relay';
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
    exchange: vi.fn(async (value: { idToken: string; licenseId: string }) => ({ token: value.idToken === a.idToken ? GRAZIE_A : GRAZIE_B, expiresAt: clock + 5 * 60_000 })),
    quota: vi.fn(async (token: string) => usage(token === GRAZIE_B ? 45 : 10, clock)),
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
    adapter() { if (!running) throw new Error('Fixture relay not started'); return running.adapter; },
    account(id: string) { return manager.decorate(relayAccountView(store, store.getProvider(id)!)); } };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('IDE 账号导入校验与凭据边界', () => {
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
    expect(api.exchange).toHaveBeenCalledWith({ idToken: a.idToken, licenseId: a.licenseId }); expect(api.quota).toHaveBeenCalledWith(GRAZIE_A); expect(api.models).toHaveBeenCalledWith(GRAZIE_A);
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
    delayed.resolve(usage(90)); await expect(pending).rejects.toThrow('查询期间已变更');
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

  it('目录和模型请求经独立本机Key启动的adapter，原始模型故障只返回安全错误', async () => {
    const { manager, api, relay, adapter } = await setup(), first = await manager.import('ticket-a');
    await manager.startRelay(first.providerId); await manager.startRelay(first.providerId);
    expect(relay.start).toHaveBeenCalledTimes(1); expect(relay.start.mock.calls[0][0]).toBe(LOCAL_KEY);
    const controller = new AbortController(), body = { model: 'native-profile-fixture', messages: [{ role: 'user', content: 'Synthetic prompt' }], stream: false };
    expect(await adapter().models(controller.signal)).toEqual({ data: [{ id: 'native-profile-fixture', object: 'model' }] });
    const result = await adapter().chat(body, controller.signal); expect(await result.text()).toContain('MOCK_NATIVE_OK'); expect(api.chat).toHaveBeenCalledWith(GRAZIE_A, body, controller.signal);
    api.chat.mockRejectedValueOnce(new Error(PRIVATE_ERROR)); const error = await adapter().chat(body, controller.signal).catch(value => value);
    expect(error).toBeInstanceOf(JetBrainsIdeRelayFailure); expect(String(error)).not.toContain(PRIVATE_ERROR);
  });

  it('旧 JBA source exp 仅作提示，仍交服务端验证；公开到期时间仅来自已验证的派生会话', async () => {
    const { manager, api, reader, store, newManager } = await setup(), old = credentials('a', ROOT_NOW - 24 * 60 * 60_000);
    reader.readCredentials.mockResolvedValueOnce(old);
    api.exchange.mockResolvedValue({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 });
    const first = await manager.import('ticket-a');
    expect(api.exchange).toHaveBeenCalledWith({ idToken: old.idToken, licenseId: old.licenseId });
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
    expect(api.exchange).toHaveBeenCalledWith({ idToken: old.idToken, licenseId: old.licenseId });
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

describe('可选 OS Integration SDK 凭据的身份与保密边界', () => {
  function sdkCredentials(value: JetBrainsIdeCredentials, accessToken: string): JetBrainsIdeCredentials {
    const { idToken: _idToken, sourceTokenExpHint: _sourceHint, ...identity } = value;
    // The reader's SDK result is a distinct credential variant. This bridge
    // fixture remains explicit while the legacy reader type is kept separate.
    return { ...identity, tokenType: 'jcp-global-access-token', accessToken, expiresAt: ROOT_NOW + 60 * 60_000 } as unknown as JetBrainsIdeCredentials;
  }

  it('SDK token 仅走显式 JCP 交换，不冒充 ID token 或公开账号身份', async () => {
    const { api, reader, store, a, newManager } = await setup(), sdkToken = 'PRIVATE_OS_SDK_EXACT_AUDIENCE_ACCESS_TOKEN';
    reader.readCredentials.mockResolvedValueOnce(sdkCredentials(a, sdkToken));
    const exchangeJcp = vi.fn(async (_value: { accessToken: string; licenseId: string }) => ({ token: GRAZIE_A, expiresAt: ROOT_NOW + 5 * 60_000 }));
    const manager = newManager({ ...api, exchangeJcp }), imported = await manager.import('ticket-a');
    expect(api.exchange).not.toHaveBeenCalled(); expect(exchangeJcp).toHaveBeenCalledWith({ accessToken: sdkToken, licenseId: a.licenseId });
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
