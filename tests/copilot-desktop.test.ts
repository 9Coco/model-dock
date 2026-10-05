import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CopilotDesktopClient, CopilotDesktopError, type CopilotDesktopPlan, type CopilotDesktopSocket, type CopilotNativeModel, type CopilotNativeProvider } from '../src/main/copilot-desktop';
import * as processVerifier from '../src/main/copilot-process';

const sourceA = '23d4bf21-4897-4e6e-9cc7-69c25b738cc0', sourceB = '23d4bf21-4897-4e6e-9cc7-69c25b738cc1';
const modelA = '23d4bf21-4897-4e6e-9cc7-69c25b738cd0', modelB = '23d4bf21-4897-4e6e-9cc7-69c25b738cd1', modelC = '23d4bf21-4897-4e6e-9cc7-69c25b738cd2';
const privateToken = 'PRIVATE_WS_TOKEN_'.padEnd(43, 'X');
const dirs: string[] = [];
const clients: CopilotDesktopClient[] = [];
afterEach(async () => { for (const c of clients.splice(0)) c.close(); vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) { const inside = relative(resolve(tmpdir()), resolve(d)); if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe fixture cleanup target'); await rm(d, { recursive: true, force: true }); } });

class NativeFixture implements CopilotDesktopSocket {
  listeners = new Map<string, Set<(event: any) => void>>();
  providers: CopilotNativeProvider[] = [{ id: 'github-account', name: 'GitHub Copilot', kind: 'github_copilot', settings: {}, hasSecret: true, accountId: 'fixture-account' }, { id: 'foreign', name: 'Other source', kind: 'custom', settings: { baseUrl: 'https://foreign.test/v1' }, hasSecret: true }];
  models: CopilotNativeModel[] = [{ id: 'foreign-model', providerId: 'foreign', modelId: 'same-model', displayName: 'Foreign model' }];
  secrets = new Map<string, string>();
  commands: Record<string, any>[] = [];
  closed = false;
  intercept?: (body: Record<string, any>) => boolean;
  addEventListener(type: string, listener: (event: any) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  event(type: string, event: unknown = {}) { for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
  message(value: unknown) { this.event('message', { data: JSON.stringify(value) }); }
  send(raw: string) {
    const body = JSON.parse(raw); this.commands.push(body);
    // Actual app broadcasts can contain unrelated sensitive state. They must
    // never become a config acknowledgement or an exported client DTO.
    this.message({ type: 'session_history', session: 'PRIVATE_CHAT_HISTORY' });
    if (this.intercept?.(body)) return;
    switch (body.type) {
      case 'list_model_providers': this.message({ type: 'model_providers_list', providers: this.providers.map(p => ({ ...p, accessToken: 'PRIVATE_SERVER_TOKEN' })) }); break;
      case 'list_provider_models': this.message({ type: 'provider_models_list', models: this.models.filter(m => m.providerId === body.provider_id) }); break;
      case 'upsert_model_provider': {
        const existing = this.providers.findIndex(p => p.id === body.provider.id);
        const provider = { ...body.provider, hasSecret: body.secret ? true : this.secrets.has(body.provider.id) };
        if (existing >= 0) this.providers[existing] = provider; else this.providers.push(provider);
        if (body.secret) { expect(body.secret.kind).toBe('api_key'); this.secrets.set(provider.id, body.secret.value); }
        this.message({ type: 'model_provider_upserted', provider }); break;
      }
      case 'upsert_provider_model': {
        const existing = this.models.findIndex(m => m.id === body.model.id);
        if (existing >= 0) this.models[existing] = body.model; else this.models.push(body.model);
        this.message({ type: 'provider_model_upserted', model: body.model }); break;
      }
      case 'delete_provider_model': this.models = this.models.filter(m => m.id !== body.model_id); this.message({ type: 'provider_model_deleted', model_id: body.model_id }); break;
      case 'delete_model_provider': this.providers = this.providers.filter(p => p.id !== body.provider_id); this.models = this.models.filter(m => m.providerId !== body.provider_id); this.secrets.delete(body.provider_id); this.message({ type: 'model_provider_deleted', provider_id: body.provider_id }); break;
      default: this.message({ type: 'error', message: 'PRIVATE_RAW_NATIVE_ERROR' });
    }
  }
  close() { this.closed = true; }
}
const readRunFile = async (name: string) => name.endsWith('.port') ? '63354\n37440\n' : `${privateToken}\n37440\n`;
async function connect(fixture = new NativeFixture(), extra: Record<string, unknown> = {}) {
  const socketFactory = vi.fn((url: string) => { expect(url).toBe(`ws://127.0.0.1:63354/?token=${privateToken}`); queueMicrotask(() => fixture.event('open')); return fixture; });
  const client = await CopilotDesktopClient.open('synthetic-home', { readRunFile, socketFactory, verifyProcess: async () => true, ...extra }); clients.push(client); return { client, fixture, socketFactory };
}
function plan(): CopilotDesktopPlan {
  return { providers: [
    { id: sourceA, name: 'API source', baseUrl: 'https://api.test/v1', apiKey: 'PRIVATE_API_KEY', headers: { 'X-App': 'ModelDock' }, models: [{ id: modelA, modelId: 'same-model', wireModel: 'upstream-chat', displayName: 'API source-same-model', wireApi: 'chat', contextWindow: 128000 }, { id: modelB, modelId: 'response-model', displayName: 'Responses', wireApi: 'responses', contextWindow: 0, maxOutputTokens: 4096 }] },
    { id: sourceB, name: 'Subscription source', baseUrl: 'http://127.0.0.1:18181/tool/copilot-app/v1', apiKey: 'PRIVATE_LOCAL_GATEWAY_KEY', models: [{ id: modelC, modelId: 'same-model', wireModel: 'subscription-qualified-model', displayName: 'Subscription source-same-model', wireApi: 'responses' }] },
  ] };
}
const owned = [sourceA, sourceB];
const writes = (fixture: NativeFixture) => fixture.commands.filter(c => /^(upsert|delete)_/.test(c.type));

describe('Copilot desktop native configuration bridge', () => {
  it('uses the mandatory OS verifier even when only a test reader and socket transport are injected', async () => {
    const verify = vi.spyOn(processVerifier, 'verifyCopilotDesktopProcess').mockResolvedValue(false), factory = vi.fn();
    await expect(CopilotDesktopClient.open('synthetic-home', { readRunFile, socketFactory: factory })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(verify).toHaveBeenCalledWith(37440, 63354); expect(factory).not.toHaveBeenCalled();
  });
  it('rejects runtime metadata changes during identity verification before creating a socket', async () => {
    let changed = false; const factory = vi.fn();
    const read = async (name: string) => name.endsWith('.port') ? '63354\n37440\n' : `${changed ? 'CHANGED_NONCE_'.padEnd(43, 'Y') : privateToken}\n37440\n`;
    await expect(CopilotDesktopClient.open('synthetic-home', { readRunFile: read, socketFactory: factory, verifyProcess: async () => { changed = true; return true; } })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects a partial release descriptor instead of using an older complete metadata pair', async () => {
    const factory = vi.fn(), verify = vi.fn(async () => true);
    const read = async (name: string) => { if (name === 'ws.release.token') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return readRunFile(name); };
    await expect(CopilotDesktopClient.open('synthetic-home', { readRunFile: read, socketFactory: factory, verifyProcess: verify })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(verify).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
  });
  it('closes a connected socket if its process/port identity no longer verifies', async () => {
    const fixture = new NativeFixture(); let checks = 0;
    await expect(connect(fixture, { verifyProcess: async () => ++checks === 1 })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(fixture.closed).toBe(true); expect(fixture.commands).toEqual([]);
  });
  it('stops before backup and before configuration credentials when a verified instance changes', async () => {
    let valid = true; const { fixture, client } = await connect(undefined, { verifyProcess: async () => valid }); const backup = vi.fn();
    valid = false; await expect(client.sync(plan(), { ownedProviderIds: owned, beforeMutation: backup })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(backup).not.toHaveBeenCalled(); expect(writes(fixture)).toEqual([]); expect(fixture.closed).toBe(true);
  });
  it('rechecks identity after backup before transmitting any mutation or API key', async () => {
    let valid = true; const { fixture, client } = await connect(undefined, { verifyProcess: async () => valid });
    await expect(client.sync(plan(), { ownedProviderIds: owned, beforeMutation: () => { valid = false; } })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(writes(fixture)).toEqual([]); expect(fixture.closed).toBe(true); expect(fixture.secrets.size).toBe(0);
  });
  it('rejects directory/file links without reading token values or invoking a verifier', async () => {
    const home = await mkdtemp(join(tmpdir(), 'modeldock-copilot-link-')); dirs.push(home);
    const target = join(home, 'original'); await mkdir(target); await writeFile(join(target, 'ws.release.port'), '63354\n37440\n', { mode: 0o600 }); await writeFile(join(target, 'ws.release.token'), `${privateToken}\n37440\n`, { mode: 0o600 });
    await symlink(target, join(home, 'run'), process.platform === 'win32' ? 'junction' : 'dir');
    const factory = vi.fn(), verify = vi.fn(async () => true);
    await expect(CopilotDesktopClient.open(home, { socketFactory: factory, verifyProcess: verify })).rejects.toMatchObject({ category: 'invalid-metadata' });
    expect(verify).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
    const second = await mkdtemp(join(tmpdir(), 'modeldock-copilot-hardlink-')); dirs.push(second); await mkdir(join(second, 'run'));
    await link(join(target, 'ws.release.port'), join(second, 'run', 'ws.release.port')); await writeFile(join(second, 'run', 'ws.release.token'), `${privateToken}\n37440\n`, { mode: 0o600 });
    await expect(CopilotDesktopClient.open(second, { socketFactory: factory, verifyProcess: verify })).rejects.toMatchObject({ category: 'invalid-metadata' }); expect(factory).not.toHaveBeenCalled();
  });
  it('reports unsupported identity platforms without implying that reopening the app is sufficient', async () => {
    const factory = vi.fn();
    const error = await CopilotDesktopClient.open('synthetic-home', { readRunFile, socketFactory: factory, verifyProcess: async () => { throw new processVerifier.CopilotProcessVerificationError('unsupported-platform'); } }).catch(error => error);
    expect(error).toMatchObject({ category: 'unsupported-platform' }); expect(error.message).toContain('当前系统'); expect(error.message).not.toContain('重新打开'); expect(factory).not.toHaveBeenCalled();
  });
  it('parses the published two-line port/token descriptor, uses loopback and never forwards the PID as a token', async () => {
    const verifyProcess = vi.fn(async (pid, port) => { expect(pid).toBe(37440); expect(port).toBe(63354); return true; });
    const { client, fixture, socketFactory } = await connect(undefined, { verifyProcess });
    expect(verifyProcess).toHaveBeenCalledTimes(2); expect(socketFactory).toHaveBeenCalledOnce();
    const list = await client.listProviders();
    expect(list).toHaveLength(2); expect(fixture.commands).toEqual([{ type: 'list_model_providers' }]);
    expect(JSON.stringify(list)).not.toMatch(/PRIVATE_|accessToken|session_history/);
  });

  it('can load descriptor files from an isolated home and falls back to ws.port only when release metadata is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'modeldock-copilot-')); dirs.push(home); const run = join(home, 'run'); await mkdir(run, { recursive: true });
    await writeFile(join(run, 'ws.port'), '63354\n37440\n', { mode: 0o600 }); await writeFile(join(run, 'ws.token'), `${privateToken}\n37440\n`, { mode: 0o600 });
    const fixture = new NativeFixture(), factory = vi.fn(() => { queueMicrotask(() => fixture.event('open')); return fixture; });
    const client = await CopilotDesktopClient.open(home, { socketFactory: factory, verifyProcess: async () => true }); clients.push(client);
    expect(await client.listProviders()).toHaveLength(2);
    const tooLargeHome = await mkdtemp(join(tmpdir(), 'modeldock-copilot-')); dirs.push(tooLargeHome); const tooLargeRun = join(tooLargeHome, 'run'); await mkdir(tooLargeRun, { recursive: true });
    await writeFile(join(tooLargeRun, 'ws.release.port'), 'X'.repeat(4097)); await writeFile(join(tooLargeRun, 'ws.release.token'), `${privateToken}\n37440\n`);
    await expect(CopilotDesktopClient.open(tooLargeHome, { socketFactory: factory })).rejects.toMatchObject({ category: 'invalid-metadata' }); expect(factory).toHaveBeenCalledOnce();
  });

  it.each(['0\n37440\n', '65536\n37440\n', 'https://remote.test\n37440\n', '63354\n999\n', '63354\n37440\nextra'])('rejects invalid or mismatched connection metadata before creating a socket', async invalid => {
    const factory = vi.fn();
    await expect(CopilotDesktopClient.open('fixture', { readRunFile: async name => name.endsWith('.port') ? invalid : `${privateToken}\n37440\n`, socketFactory: factory })).rejects.toMatchObject({ category: 'invalid-metadata' }); expect(factory).not.toHaveBeenCalled();
  });

  it('checks executable provenance before sending an OS credential or WS auth token', async () => {
    const factory = vi.fn();
    await expect(CopilotDesktopClient.open('fixture', { readRunFile, socketFactory: factory, verifyProcess: async () => false })).rejects.toMatchObject({ category: 'invalid-metadata' }); expect(factory).not.toHaveBeenCalled();
  });

  it('reports missing native metadata without leaking filesystem details or attempting any connection', async () => {
    const factory = vi.fn();
    const error = await CopilotDesktopClient.open('fixture', { socketFactory: factory, readRunFile: async () => { throw Object.assign(new Error('PRIVATE_PATH_DETAILS'), { code: 'ENOENT' }); } }).catch(e => e);
    expect(error).toMatchObject({ category: 'not-running' }); expect(String(error)).not.toContain('PRIVATE_'); expect(factory).not.toHaveBeenCalled();
  });

  it('bounds metadata/provenance reads and never opens a late socket after timeout', async () => {
    vi.useFakeTimers(); let release!: (value: boolean) => void; const factory = vi.fn();
    const result = CopilotDesktopClient.open('fixture', { readRunFile, socketFactory: factory, timeoutMs: 10, verifyProcess: () => new Promise(resolve => { release = resolve; }) }).catch(e => e);
    await vi.advanceTimersByTimeAsync(10); expect(await result).toMatchObject({ category: 'timeout' }); release(true); await Promise.resolve(); expect(factory).not.toHaveBeenCalled();
  });

  it('synchronizes multiple providers with native credential storage and per-model protocols, preserving GitHub and unrelated sources', async () => {
    const { client, fixture } = await connect(); const original = structuredClone(fixture.providers);
    const backup = vi.fn(async snapshot => { expect(writes(fixture)).toEqual([]); expect(snapshot.providers).toEqual([]); });
    const result = await client.sync(plan(), { ownedProviderIds: owned, beforeMutation: backup });
    expect(result).toEqual({ providerCount: 2, modelCount: 3, removedProviderCount: 0, removedModelCount: 0 }); expect(backup).toHaveBeenCalledOnce();
    expect(fixture.providers.slice(0, 2)).toEqual(original); expect(fixture.models.find(m => m.id === 'foreign-model')).toBeDefined();
    const providers = fixture.providers.filter(p => owned.includes(p.id));
    expect(providers.map(p => p.name)).toEqual(['ModelDock · API source', 'ModelDock · Subscription source']);
    expect(providers[0].settings).toEqual({ baseUrl: 'https://api.test/v1', authKind: 'api_key', wireApi: 'completions', headersJson: '{"X-App":"ModelDock"}' });
    expect(JSON.stringify(providers)).not.toContain('PRIVATE_'); expect(fixture.secrets.get(sourceA)).toBe('PRIVATE_API_KEY'); expect(fixture.secrets.get(sourceB)).toBe('PRIVATE_LOCAL_GATEWAY_KEY');
    expect(fixture.models.filter(m => m.modelId === 'same-model')).toHaveLength(3);
    expect(fixture.models.find(m => m.id === modelA)).toMatchObject({ providerId: sourceA, wireModel: 'upstream-chat', wireApiOverride: 'completions', maxPromptTokens: 128000 });
    expect(fixture.models.find(m => m.id === modelB)).toMatchObject({ wireApiOverride: 'responses', maxOutputTokens: 4096 }); expect(fixture.models.find(m => m.id === modelB)).not.toHaveProperty('maxPromptTokens');
    expect(writes(fixture).map(c => c.type)).toEqual(['upsert_model_provider', 'upsert_provider_model', 'upsert_provider_model', 'upsert_model_provider', 'upsert_provider_model']);
    expect(fixture.commands.filter(c => c.type === 'list_model_providers')).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('takes the backup before changing owned rows, prunes only old owned models, and clears only owned providers on uncheck-all', async () => {
    const { client, fixture } = await connect(); await client.sync(plan(), { ownedProviderIds: owned }); fixture.commands = [];
    const next = plan(); next.providers.pop(); next.providers[0].models.pop();
    const backup = vi.fn(snapshot => { expect(snapshot.providers).toHaveLength(2); expect(snapshot.providers[0].models).toHaveLength(2); expect(writes(fixture)).toEqual([]); });
    expect(await client.sync(next, { ownedProviderIds: owned, beforeMutation: backup })).toMatchObject({ removedProviderCount: 1, removedModelCount: 1 });
    expect(fixture.providers.map(p => p.id)).toEqual(['github-account', 'foreign', sourceA]); expect(fixture.models.map(m => m.id)).toEqual(['foreign-model', modelA]);
    expect(await client.sync({ providers: [] }, { ownedProviderIds: owned })).toMatchObject({ providerCount: 0, modelCount: 0, removedProviderCount: 1 });
    expect(fixture.providers.map(p => p.id)).toEqual(['github-account', 'foreign']); expect(fixture.models.map(m => m.id)).toEqual(['foreign-model']);
    expect(fixture.commands.some(c => /session|account|mcp|restart/.test(c.type))).toBe(false);
  });

  it('exclusively publishes selected custom sources only after backup, preserving account-linked sources even with custom kind', async () => {
    const { client, fixture } = await connect(); const oldId = '23d4bf21-4897-4e6e-9cc7-69c25b738cce';
    fixture.providers[1].id = oldId; fixture.models[0].providerId = oldId; fixture.models[0].id = '23d4bf21-4897-4e6e-9cc7-69c25b738ccf';
    fixture.providers[1].settings.extraVendorMetadata = { preserve: true };
    fixture.providers.push({ id: '23d4bf21-4897-4e6e-9cc7-69c25b738cca', name: 'Linked custom account', kind: 'custom', accountId: 'native-account', settings: {}, hasSecret: true });
    const linked = structuredClone(fixture.providers[2]);
    await expect(client.sync(plan(), { ownedProviderIds: [], syncScope: 'selected' })).rejects.toMatchObject({ category: 'backup' }); expect(writes(fixture)).toEqual([]);
    const backup = vi.fn(snapshot => {
      expect(writes(fixture)).toEqual([]); expect(snapshot.providers).toHaveLength(1);
      expect(snapshot.providers[0].provider.id).toBe(oldId); expect(snapshot.providers[0].provider.settings.extraVendorMetadata).toEqual({ preserve: true });
    });
    const result = await client.sync(plan(), { ownedProviderIds: [], syncScope: 'selected', beforeMutation: backup });
    expect(result).toMatchObject({ removedProviderCount: 1, providerCount: 2 }); expect(backup).toHaveBeenCalledOnce();
    expect(fixture.providers.find(p => p.id === oldId)).toBeUndefined(); expect(fixture.providers.find(p => p.id === linked.id)).toEqual(linked); expect(fixture.providers[0].accountId).toBe('fixture-account');
  });

  it('does not clear exclusive sources if exact credential/metadata backup fails', async () => {
    const { client, fixture } = await connect(); fixture.providers[1].id = sourceA; fixture.models[0].providerId = sourceA;
    await expect(client.sync({ providers: [] }, { ownedProviderIds: [], syncScope: 'selected', beforeMutation: () => { throw new Error('PRIVATE_CREDENTIAL_READ_FAILURE'); } })).rejects.toMatchObject({ category: 'backup' });
    expect(writes(fixture)).toEqual([]); expect(fixture.providers.find(p => p.id === sourceA)).toBeDefined();
  });

  it('keeps an unbacked concurrently added source but never falsely reports exclusive synchronization complete', async () => {
    const { client, fixture } = await connect(); fixture.providers[1].id = sourceA; fixture.models[0].providerId = sourceA;
    const concurrent = '23d4bf21-4897-4e6e-9cc7-69c25b738ccb'; let calls = 0;
    fixture.intercept = body => { if (body.type === 'list_model_providers' && ++calls === 2) fixture.providers.push({ id: concurrent, name: 'Concurrent native source', kind: 'custom', settings: {}, hasSecret: false }); return false; };
    await expect(client.sync({ providers: [] }, { ownedProviderIds: [], syncScope: 'selected', beforeMutation: () => {} })).rejects.toMatchObject({ category: 'protocol' });
    expect(fixture.providers.find(p => p.id === concurrent)).toBeDefined(); expect(writes(fixture).some(c => c.provider_id === concurrent)).toBe(false);
  });

  it('restores private native metadata without rewriting secrets after the caller restores its opaque OS credential backup', async () => {
    const { client, fixture } = await connect(); let snapshot: any;
    await client.sync(plan(), { ownedProviderIds: owned });
    fixture.providers.find(p => p.id === sourceA)!.name = 'Original manual source';
    fixture.providers.find(p => p.id === sourceA)!.settings = { baseUrl: 'https://manual.test/v1', authKind: 'bearer_token', wireApi: 'responses', headersJson: '{"X-Vendor":"private-metadata"}', azureApiVersion: null, customNested: { keep: true } };
    fixture.models.find(m => m.id === modelA)!.supportedReasoningEfforts = ['low', 'high'];
    await client.sync({ providers: [] }, { ownedProviderIds: owned, beforeMutation: value => { snapshot = value; } });
    // Represents CredWrite restoring opaque bytes, not deriving an old key
    // from a new plan or reading a secret through the native RPC.
    fixture.secrets.set(sourceA, 'PRIVATE_OPAQUE_RESTORED'); fixture.secrets.set(sourceB, 'PRIVATE_OPAQUE_RESTORED_B'); fixture.commands = [];
    const result = await client.restoreSnapshot(snapshot, { ownedProviderIds: owned }); expect(result).toMatchObject({ providerCount: 2, modelCount: 3 });
    expect(fixture.providers.find(p => p.id === sourceA)!.name).toBe('Original manual source'); expect(fixture.providers.find(p => p.id === sourceA)!.settings).toEqual(snapshot.providers[0].provider.settings);
    expect(fixture.models.find(m => m.id === modelA)!.supportedReasoningEfforts).toEqual(['low', 'high']);
    expect(fixture.secrets.get(sourceA)).toBe('PRIVATE_OPAQUE_RESTORED'); expect(writes(fixture).filter(c => c.type === 'upsert_model_provider').every(c => !Object.hasOwn(c, 'secret'))).toBe(true);
    expect(fixture.commands.filter(c => c.type === 'list_model_providers')).toHaveLength(2);
  });

  it('treats successful native credential writes independently of a delayed hasSecret availability hint', async () => {
    const { client, fixture } = await connect();
    const originalMessage = fixture.message.bind(fixture);
    fixture.message = value => { if (value && typeof value === 'object' && 'type' in value && value.type === 'model_provider_upserted') (value as any).provider.hasSecret = false; originalMessage(value); };
    await expect(client.sync(plan(), { ownedProviderIds: owned })).resolves.toMatchObject({ providerCount: 2 }); expect(fixture.secrets.size).toBe(2);
  });

  it('preserves native reasoning effort metadata in Chat and Responses models for rollback', async () => {
    const { client, fixture } = await connect(); const input = plan();
    input.providers[0].models[0].supportedReasoningEfforts = ['low', 'medium', 'high'];
    input.providers[0].models[1].supportedReasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    await client.sync(input, { ownedProviderIds: owned });
    expect(fixture.models.find(m => m.id === modelA)).toMatchObject({ wireApiOverride: 'completions', supportedReasoningEfforts: ['low', 'medium', 'high'] });
    expect(fixture.models.find(m => m.id === modelB)).toMatchObject({ wireApiOverride: 'responses', supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] });
    const beforeMutation = vi.fn(snapshot => expect(snapshot.providers[0].models[0].supportedReasoningEfforts).toEqual(['low', 'medium', 'high']));
    await client.sync(input, { ownedProviderIds: owned, beforeMutation }); expect(beforeMutation).toHaveBeenCalledOnce();
    input.providers[0].models[0].supportedReasoningEfforts = [];
    await client.sync(input, { ownedProviderIds: owned }); expect(fixture.models.find(m => m.id === modelA)?.supportedReasoningEfforts).toEqual([]);
  });

  it('retains an explicit native provider default protocol independently of its first model or empty model list', async () => {
    const { client, fixture } = await connect(); const input = plan(); input.providers[0].wireApi = 'responses';
    await client.sync(input, { ownedProviderIds: owned }); expect(fixture.providers.find(p => p.id === sourceA)?.settings.wireApi).toBe('responses');
    expect(fixture.models.find(m => m.id === modelA)?.wireApiOverride).toBe('completions');
    input.providers[0].models = []; await client.sync(input, { ownedProviderIds: owned }); expect(fixture.providers.find(p => p.id === sourceA)?.settings.wireApi).toBe('responses');
    input.providers[0].wireApi = 'invalid' as 'chat';
    await expect(client.sync(input, { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'configuration' });
  });

  it('rejects oversized or malformed reasoning effort metadata before any native request', async () => {
    const { client, fixture } = await connect();
    for (const efforts of [Array.from({ length: 33 }, (_, i) => `effort${i}`), ['X'.repeat(65)], ['low', 'low'], ['high\nPRIVATE'], [7], 'high']) {
      const input = plan(); input.providers[0].models[0].supportedReasoningEfforts = efforts as string[];
      await expect(client.sync(input, { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'configuration' });
    }
    expect(fixture.commands).toEqual([]);
  });

  it.each(['http://localhost:9/v1', 'http://127.0.0.1:9/v1', 'http://[::1]:9/v1', 'https://remote.test/v1'])('allows HTTPS or loopback HTTP endpoint %s', async baseUrl => {
    const { client } = await connect(); const input = plan(); input.providers[0].baseUrl = baseUrl;
    await expect(client.sync(input, { ownedProviderIds: owned })).resolves.toMatchObject({ providerCount: 2 });
  });

  it.each(['http://remote.test/v1', 'http://192.168.1.2:9/v1', 'http://localhost.remote.test/v1'])('rejects remote cleartext endpoint %s before native I/O', async baseUrl => {
    const { client, fixture } = await connect(); const input = plan(); input.providers[0].baseUrl = baseUrl;
    await expect(client.sync(input, { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'configuration' }); expect(fixture.commands).toEqual([]);
  });

  it.each(['missing-provenance', 'account-linked', 'managed-kind'])('refuses a conflicting existing provider (%s) without any native mutation', async reason => {
    const { client, fixture } = await connect(); fixture.providers.push({ id: sourceA, name: 'Foreign same ID', kind: reason === 'managed-kind' ? 'github_copilot' : 'custom', settings: {}, hasSecret: true, ...(reason === 'account-linked' ? { accountId: 'private-account' } : {}) });
    await expect(client.sync(plan(), { ownedProviderIds: reason === 'missing-provenance' ? [] : owned })).rejects.toMatchObject({ category: 'ownership' }); expect(writes(fixture)).toEqual([]);
  });

  it('refuses a model UUID already belonging to an unrelated source even when its provider ID differs', async () => {
    const { client, fixture } = await connect(); fixture.models[0].id = modelA;
    await expect(client.sync(plan(), { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'ownership' }); expect(writes(fixture)).toEqual([]);
  });

  it('does not mutate configuration if its encrypted backup cannot be saved, and redacts backup errors', async () => {
    const { client, fixture } = await connect();
    const error = await client.sync(plan(), { ownedProviderIds: owned, beforeMutation: () => { throw new Error('PRIVATE_BACKUP_ERROR'); } }).catch(e => e);
    expect(error).toMatchObject({ category: 'backup' }); expect(String(error)).not.toContain('PRIVATE_'); expect(writes(fixture)).toEqual([]);
  });

  it('validates the complete plan before native I/O, including a bad second source, duplicate IDs and secret-bearing URLs/headers', async () => {
    const invalid: CopilotDesktopPlan[] = [];
    let p = plan(); p.providers[1].apiKey = ''; invalid.push(p);
    p = plan(); p.providers[1].baseUrl = 'https://user:PRIVATE_PASSWORD@api.test/v1'; invalid.push(p);
    p = plan(); p.providers[1].headers = { Authorization: 'PRIVATE_AUTH_HEADER' }; invalid.push(p);
    p = plan(); p.providers[1].models[0].id = modelA; invalid.push(p);
    p = plan(); p.providers[0].models[1].modelId = 'same-model'; invalid.push(p);
    p = plan(); p.providers[0].models[0].contextWindow = -1; invalid.push(p);
    const { client, fixture } = await connect();
    for (const value of invalid) await expect(client.sync(value, { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'configuration' });
    expect(fixture.commands).toEqual([]);
  });

  it('does not continue after a refused native operation or leak native error text, tokens or authenticated URLs', async () => {
    const { client, fixture } = await connect(); fixture.intercept = body => { if (body.type !== 'upsert_model_provider') return false; fixture.message({ type: 'error', message: `PRIVATE_RAW_ERROR ${privateToken}`, url: `ws://127.0.0.1:63354/?token=${privateToken}` }); return true; };
    const error = await client.sync(plan(), { ownedProviderIds: owned }).catch(e => e);
    expect(error).toBeInstanceOf(CopilotDesktopError); expect(error.category).toBe('native-error'); expect(String(error)).not.toMatch(/PRIVATE_|token=|ws:\/\//); expect(writes(fixture)).toHaveLength(1);
  });

  it('retries only a precise native keychain busy read and never returns an empty or secretless provider list on failure', async () => {
    const { client, fixture } = await connect(); vi.useFakeTimers(); let count = 0;
    fixture.intercept = body => {
      if (body.type !== 'list_model_providers' || ++count > 2) return false;
      fixture.message({ type: 'error', message: 'get rejected: all 4 native-worker slots are occupied PRIVATE_NATIVE_DETAIL' }); return true;
    };
    const pending = client.listProviders(); await vi.advanceTimersByTimeAsync(480);
    await expect(pending).resolves.toHaveLength(2); expect(count).toBe(3); expect(writes(fixture)).toEqual([]);
    fixture.intercept = body => { if (body.type !== 'list_model_providers') return false; fixture.message({ type: 'error', message: 'get rejected: all 4 native worker slots are occupied PRIVATE_ERROR' }); return true; };
    const failed = client.sync(plan(), { ownedProviderIds: owned }).catch(e => e); await vi.advanceTimersByTimeAsync(480);
    const error = await failed; expect(error).toMatchObject({ category: 'busy' }); expect(String(error)).not.toContain('PRIVATE_'); expect(writes(fixture)).toEqual([]);
  });

  it('does not repeat an ambiguous keychain-busy mutation or continue to any removal', async () => {
    const { client, fixture } = await connect();
    fixture.intercept = body => { if (body.type !== 'upsert_model_provider') return false; fixture.message({ type: 'error', message: 'set rejected: all 4 native-worker slots are occupied PRIVATE_ERROR' }); return true; };
    await expect(client.sync(plan(), { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'busy' }); expect(writes(fixture)).toHaveLength(1); expect(fixture.commands.some(c => c.type.startsWith('delete_'))).toBe(false);
  });

  it('rejects credential failure indicators instead of treating hasSecret false as a usable empty credential state', async () => {
    const { client, fixture } = await connect(); fixture.providers[1] = { ...fixture.providers[1], hasSecret: false, secretError: 'get rejected: all 4 native-worker slots are occupied' } as CopilotNativeProvider;
    await expect(client.sync({ providers: [] }, { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'busy' }); expect(writes(fixture)).toEqual([]);
  });

  it('serializes simultaneous requests since the native list protocol has no request ID', async () => {
    const { client, fixture } = await connect(); let release!: () => void;
    fixture.intercept = body => { if (body.type !== 'list_model_providers') return false; release = () => fixture.message({ type: 'model_providers_list', providers: fixture.providers }); return true; };
    const list = client.listProviders(), models = client.listModels('foreign'); await Promise.resolve();
    expect(fixture.commands).toHaveLength(1); release(); await expect(list).resolves.toHaveLength(2); await expect(models).resolves.toHaveLength(1);
    expect(fixture.commands.map(c => c.type)).toEqual(['list_model_providers', 'list_provider_models']);
  });

  it('discards large unrelated session broadcasts before parsing/bounding a config response', async () => {
    const { client, fixture } = await connect();
    fixture.intercept = body => { if (body.type === 'list_model_providers') fixture.event('message', { data: '{"type":"session_history","privateContent":"' + 'X'.repeat(2 * 1024 * 1024) }); return false; };
    await expect(client.listProviders()).resolves.toHaveLength(2); expect(fixture.closed).toBe(false);
  });

  it('ignores unrelated write acknowledgements and closes on timeout so a late response cannot start another mutation', async () => {
    const { client, fixture } = await connect(undefined, { timeoutMs: 10 }); vi.useFakeTimers();
    fixture.intercept = body => { if (body.type !== 'upsert_model_provider') return false; fixture.message({ type: 'model_provider_upserted', provider: { id: 'wrong-id', secret: 'PRIVATE_ACK' } }); return true; };
    const pending = client.sync(plan(), { ownedProviderIds: owned }).catch(e => e); await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ category: 'timeout' }); expect(fixture.closed).toBe(true); expect(writes(fixture)).toHaveLength(1);
    fixture.message({ type: 'model_provider_upserted', provider: { id: sourceA } }); await expect(client.listProviders()).rejects.toMatchObject({ category: 'closed' }); expect(writes(fixture)).toHaveLength(1);
  });

  it('verifies readback rather than treating a matching acknowledgement as proof of persistence', async () => {
    const { client, fixture } = await connect(); fixture.intercept = body => { if (body.type !== 'upsert_model_provider') return false; fixture.message({ type: 'model_provider_upserted', provider: { ...body.provider, hasSecret: true } }); return true; };
    await expect(client.sync(plan(), { ownedProviderIds: owned })).rejects.toMatchObject({ category: 'protocol' }); expect(fixture.commands.filter(c => c.type === 'list_model_providers')).toHaveLength(2);
  });

  it('bounds frames and rejects invalid provider/model ownership shapes without returning unknown sensitive fields', async () => {
    const { client, fixture } = await connect(); fixture.intercept = body => { if (body.type !== 'list_provider_models') return false; fixture.message({ type: 'provider_models_list', models: [{ ...fixture.models[0], providerId: 'other-provider' }] }); return true; };
    await expect(client.listModels('foreign')).rejects.toMatchObject({ category: 'protocol' });
    fixture.intercept = () => { fixture.event('message', { data: JSON.stringify({ type: 'model_providers_list', padding: 'PRIVATE'.repeat(200000) }) }); return true; };
    await expect(client.listProviders()).rejects.toMatchObject({ category: 'protocol' }); expect(fixture.closed).toBe(true);
  });
});
