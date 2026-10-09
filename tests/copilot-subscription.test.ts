import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { CopilotAuthCenter } from '../src/main/copilot-auth';
import { CopilotProviderManager } from '../src/main/copilot-provider';
import { ModelCatalog } from '../src/main/catalog';
import { ConnectionTester } from '../src/main/connection-test';
import { Gateway } from '../src/main/gateway';
import { buildConfig } from '../src/main/adapters';
import { presetById } from '../src/shared/presets';
import type { ModelInput, ToolId, WireApi } from '../src/shared/types';

const GITHUB_TOKEN = 'SYNTHETIC_GITHUB_OAUTH_ACCOUNT_TOKEN';
const COPILOT_TOKEN = 'SYNTHETIC_SHORT_LIVED_COPILOT_API_TOKEN';
const API = 'https://api.individual.githubcopilot.com';
const NOW = Date.parse('2026-10-07T12:00:00Z');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
type RemoteHandler = (url: string, init: RequestInit) => Response | Promise<Response>;
function encryptedCodec() {
  const key = randomBytes(32);
  return {
    encrypt(value: string) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64');
    },
    decrypt(value: string) {
      const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
async function fixture(handler: RemoteHandler = () => json({ data: [] })) {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-copilot-source-'));
  const codec = encryptedCodec(), store = await Store.create(dir, codec);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls: { url: string; init: RequestInit }[] = [], opened: string[] = [];
  let clock = NOW;
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url === 'https://github.com/login/device/code') return json({ device_code: 'SYNTHETIC_PRIVATE_DEVICE_CODE', user_code: 'TEST-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    if (url === 'https://github.com/login/oauth/access_token') return json({ access_token: GITHUB_TOKEN, token_type: 'bearer' });
    if (url === 'https://api.github.com/user') return json({ id: 42, login: 'synthetic-copilot-user', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' });
    if (url === 'https://api.github.com/copilot_internal/user') return json({ copilot_plan: 'individual', quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 200 } } });
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      expect(new Headers(init.headers).get('authorization')).toBe(`token ${GITHUB_TOKEN}`);
      expect(init.redirect).toBe('error');
      return json({ token: COPILOT_TOKEN, expires_at: Math.floor((clock + 3_600_000) / 1000), refresh_in: 1800, endpoints: { api: API } });
    }
    if (!url.startsWith(`${API}/`)) throw new Error('Unexpected synthetic remote URL');
    return handler(url, init);
  }) as unknown as typeof fetch;
  const accounts = new CopilotAuthCenter(store, { fetch: fetcher, now: () => clock,
    openExternal: async url => { opened.push(url); }, delay: async milliseconds => { clock += milliseconds; },
    onAuthorized: (accountId, providerId) => { if (providerId) manager.linkAccount(providerId, accountId); },
  });
  const manager = new CopilotProviderManager(store, accounts, { fetch: fetcher, now: () => clock });
  cleanups.push(() => { manager.dispose(); accounts.dispose(); });
  const provider = store.saveProvider({ name: 'Fixture Copilot', kind: 'copilot', presetId: 'copilot-subscription', baseUrl: 'https://api.githubcopilot.com', enabled: true });
  async function login() {
    await manager.beginLogin(provider.id);
    await vi.waitFor(() => expect(accounts.progress()?.state).toBe('complete'));
    await vi.waitFor(() => expect(accounts.listAccounts()[0]?.usage.status).toBe('ready'));
    expect(manager.progress(provider.id)).toMatchObject({ providerId: provider.id, state: 'complete' });
    return store.getProvider(provider.id)!;
  }
  const catalog = new ModelCatalog(store, manager, { fetch: fetcher });
  return { dir, codec, store, calls, opened, accounts, manager, provider, catalog, fetcher, login };
}
function model(providerId: string, alias: string, wireApi: WireApi): ModelInput {
  return { providerId, upstreamId: `${alias}-upstream`, alias, displayName: alias, wireApi, contextWindow: 128000, tools: true, vision: false, enabled: true };
}
function select(store: Store, tool: ToolId, providerId: string, models: { id: string }[], mode: 'auto' | 'direct' | 'aggregate' = 'auto') {
  const binding = store.listBindings().find(binding => binding.id === tool)!;
  store.saveBinding({ ...binding, enabled: true, mode, providerIds: [providerId], modelSelection: 'selected', modelIds: models.map(model => model.id), defaultModelId: models[0].id });
}
async function localGateway(f: Awaited<ReturnType<typeof fixture>>) {
  const gateway = new Gateway(f.store, { fetch: f.fetcher, prepareRequest: (provider, _secret, path, body) => f.manager.prepareRequest(provider, path, body) });
  await gateway.start(0); cleanups.push(async () => { await gateway.stop(); });
  return { gateway, url: gateway.status().baseUrl, headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' } };
}

describe('Copilot subscription source integration', () => {
  it('adds and authorizes a subscription with an encrypted account reference and exports only a local key for both protocols', async () => {
    const f = await fixture();
    expect(presetById('copilot-subscription')).toMatchObject({ category: 'subscription', kind: 'copilot', defaultWireApi: 'chat-completions' });
    expect(f.provider).toMatchObject({ hasSecret: false, authStatus: 'missing' });
    const linked = await f.login();
    expect(linked).toMatchObject({ hasSecret: true, authStatus: 'ready', copilotAccountId: 'copilot:42' });
    expect(f.store.getSecret(f.provider.id)).toEqual({ copilotAccountId: 'copilot:42' });
    expect(f.opened).toEqual(['https://github.com/login/device']);
    const chat = f.store.saveModel(model(f.provider.id, 'copilot-chat', 'chat-completions'));
    const responses = f.store.saveModel(model(f.provider.id, 'copilot-responses', 'responses'));
    select(f.store, 'vscode', f.provider.id, [chat, responses], 'direct');
    select(f.store, 'opencode', f.provider.id, [chat, responses]);
    const preview = buildConfig(f.store, 'vscode', 19191), exported = buildConfig(f.store, 'vscode', 19191, true);
    expect(preview.content).not.toContain(f.store.gatewayKey());
    const rows = JSON.parse(exported.content);
    expect(rows[0].apiKey).toBe(f.store.gatewayKey());
    expect(rows[0].models.map((entry: { apiType: string; url: string }) => [entry.apiType, entry.url])).toEqual([
      ['chat-completions', 'http://127.0.0.1:19191/tool/vscode/v1/chat/completions'],
      ['responses', 'http://127.0.0.1:19191/tool/vscode/v1/responses'],
    ]);
    const opencode = JSON.parse(buildConfig(f.store, 'opencode', 19191, true).content);
    const source = Object.values(opencode.provider)[0] as any;
    expect(source.options.apiKey).toBe(f.store.gatewayKey());
    expect(source.models[chat.alias].provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(source.models[responses.alias].provider.npm).toBe('@ai-sdk/openai');
    const publicState = JSON.stringify({ providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings(), accounts: f.accounts.listAccounts(), progress: f.accounts.progress(), preview, exported, opencode });
    expect(publicState).not.toMatch(new RegExp(`${GITHUB_TOKEN}|${COPILOT_TOKEN}|accessToken|refreshToken|ciphertext`));
    const sqlite = readFileSync(join(f.dir, 'modeldock.sqlite'));
    expect(sqlite.includes(Buffer.from(GITHUB_TOKEN))).toBe(false);
    expect(sqlite.includes(Buffer.from('copilot:42'))).toBe(false);
    const before = { models: f.store.listModels(), bindings: f.store.listBindings() };
    f.store.close();
    const reopened = await Store.create(f.dir, f.codec); cleanups.push(() => reopened.close());
    expect(reopened.getSecret(f.provider.id)).toEqual({ copilotAccountId: 'copilot:42' });
    expect(reopened.listModels()).toEqual(before.models); expect(reopened.listBindings()).toEqual(before.bindings);
    expect(reopened.getManagedState<any>('copilot-auth:v1', null).accounts[0].accessToken).toBe(GITHUB_TOKEN);
  });

  it('discovers real account models with per-model endpoint capabilities and preserves unrelated models and bindings', async () => {
    const f = await fixture(url => {
      expect(url).toBe(`${API}/models`);
      return json({ data: [
        { id: 'chat-only', name: 'Chat Only', capabilities: { supported_endpoints: ['/chat/completions'], limits: { max_context_window_tokens: 128000 }, supports: { tool_calls: true, vision: true } } },
        { id: 'response-only', supported_endpoints: ['responses'] },
        { id: 'dual', supported_endpoints: ['chat_completions', '/responses'] },
        { id: 'legacy' },
        { id: 'embedding-only', supported_endpoints: ['/embeddings'] },
      ] });
    });
    await f.login();
    const other = f.store.saveProvider({ name: 'Unrelated Fixture API', kind: 'openai-compatible', baseUrl: 'https://unrelated.example.test/v1', enabled: true, apiKey: 'SYNTHETIC_OTHER_KEY' });
    const existing = f.store.saveModel(model(other.id, 'existing-model', 'responses'));
    select(f.store, 'codex', other.id, [existing], 'aggregate');
    const beforeBindings = f.store.listBindings();
    const discovered = await f.catalog.discover(f.provider.id);
    expect(discovered.ok).toBe(true);
    expect(discovered.models.map(entry => [entry.upstreamId, entry.wireApi])).toEqual([
      ['chat-only', 'chat-completions'], ['response-only', 'responses'], ['dual', 'responses'], ['legacy', 'chat-completions'],
    ]);
    expect(discovered.models[0]).toMatchObject({ contextWindow: 128000, tools: true, vision: true, metadataSource: 'upstream' });
    const added = f.catalog.addSelected(f.provider.id, discovered.models.map(entry => ({ upstreamId: entry.upstreamId })));
    expect(added.added).toHaveLength(4);
    expect(f.store.listBindings()).toEqual(beforeBindings); expect(f.store.listModels()[0]).toEqual(existing);
    expect(f.calls.filter(call => call.url === `${API}/models`)).toHaveLength(1);
    expect(f.calls.filter(call => /\/(?:responses|chat\/completions)$/.test(call.url))).toHaveLength(0);
    const request = f.calls.find(call => call.url === `${API}/models`)!;
    expect(new Headers(request.init.headers).get('authorization')).toBe(`Bearer ${COPILOT_TOKEN}`);
    expect(request.init.method).toBe('GET');
    expect(JSON.stringify(discovered)).not.toContain(COPILOT_TOKEN);
  });

  it('routes locally configured Chat and Responses models when listing is unsupported, retaining headers, streams and protocol usage', async () => {
    const inference: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const f = await fixture((url, init) => {
      if (url.endsWith('/models')) return json({ error: 'The catalog is not provided' }, 404);
      const headers = new Headers(init.headers), body = JSON.parse(String(init.body));
      inference.push({ url, headers, body });
      if (url.endsWith('/chat/completions')) return json({ id: 'chat-fixture', model: body.model, choices: [{ message: { role: 'assistant', content: 'SYNTHETIC_PRIVATE_CHAT_ANSWER' } }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } });
      return new Response(event({ type: 'response.created', response: { id: 'response-fixture', model: body.model, output: [] } })
        + event({ type: 'response.output_text.delta', delta: 'SYNTHETIC_PRIVATE_RESPONSE_ANSWER' })
        + event({ type: 'response.function_call_arguments.delta', delta: '{"fixture":true}' })
        + event({ type: 'response.completed', response: { id: 'response-fixture', model: body.model, output: [], usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } } } }),
        { headers: { 'content-type': 'text/event-stream' } });
    });
    await f.login();
    const chat = f.store.saveModel(model(f.provider.id, 'configured-chat', 'chat-completions'));
    const responses = f.store.saveModel(model(f.provider.id, 'configured-responses', 'responses'));
    const listing = await f.catalog.discover(f.provider.id);
    expect(listing).toMatchObject({ ok: false, errorCategory: 'unsupported', statusCode: 404 });
    expect(f.store.getProvider(f.provider.id)).toMatchObject({ authStatus: 'ready' });
    const before = { models: f.store.listModels(), bindings: f.store.listBindings() };
    const local = await localGateway(f);
    expect((await fetch(`${local.url}/models`)).status).toBe(401);
    expect((await fetch(`${local.url}/models`, { headers: { authorization: `Bearer ${GITHUB_TOKEN}` } })).status).toBe(401);
    const directory = await (await fetch(`${local.url}/models`, { headers: local.headers })).json();
    expect(directory.data.map((entry: { id: string }) => entry.id)).toEqual([chat.alias, responses.alias]);
    const chatReply = await fetch(`${local.url}/chat/completions`, { method: 'POST', headers: { ...local.headers, Cookie: 'SYNTHETIC_LOCAL_COOKIE', 'X-Initiator': 'spoofed' }, body: JSON.stringify({ model: chat.alias, messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }] }) });
    expect(chatReply.status).toBe(200); expect(await chatReply.json()).toMatchObject({ model: chat.alias, usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } });
    const responseReply = await fetch(`${local.url}/responses`, { method: 'POST', headers: local.headers, body: JSON.stringify({ model: responses.alias, input: 'SYNTHETIC_PRIVATE_PROMPT', stream: true }) });
    expect(responseReply.status).toBe(200); expect(responseReply.headers.get('content-type')).toContain('text/event-stream');
    const stream = await responseReply.text();
    expect(stream).toContain(responses.alias); expect(stream).toContain('response.completed'); expect(stream).toContain('response.function_call_arguments.delta');
    expect(stream).not.toContain(responses.upstreamId);
    expect(inference.map(request => [request.url, request.body.model])).toEqual([[`${API}/chat/completions`, chat.upstreamId], [`${API}/responses`, responses.upstreamId]]);
    for (const request of inference) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${COPILOT_TOKEN}`);
      expect(request.headers.get('authorization')).not.toContain(GITHUB_TOKEN); expect(request.headers.get('authorization')).not.toContain(f.store.gatewayKey());
      expect(request.headers.get('copilot-integration-id')).toBe('code-oss');
      expect(request.headers.get('editor-version')).toBeTruthy(); expect(request.headers.get('editor-plugin-version')).toBeTruthy();
      expect(request.headers.get('x-request-id')).toBeTruthy(); expect(request.headers.get('x-initiator')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
    }
    expect(stream).toContain('"input_tokens":20');
    await vi.waitFor(() => expect(f.store.logs()).toHaveLength(2));
    const logs = JSON.stringify(f.store.logs());
    expect(logs).not.toMatch(/usage|tokens/);
    expect(logs).not.toMatch(new RegExp(`${GITHUB_TOKEN}|${COPILOT_TOKEN}|${f.store.gatewayKey()}|SYNTHETIC_PRIVATE_`));
    expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
    expect(f.calls.filter(call => call.url.endsWith('/models'))).toHaveLength(1);
    expect(f.calls.filter(call => call.url.endsWith('/copilot_internal/v2/token'))).toHaveLength(1);
  });

  it('rejects both cached and in-flight catalogs when a Copilot source changes its linked account', async () => {
    let hold = false, requested = false;
    let release!: (response: Response) => void;
    const deferred = new Promise<Response>(resolve => { release = resolve; });
    const f = await fixture(url => {
      expect(url).toBe(`${API}/models`);
      if (hold) { requested = true; return deferred; }
      return json({ data: [{ id: 'account-42-model' }] });
    });
    await f.login();
    const accountState = f.store.getManagedState<any>('copilot-auth:v1', null);
    accountState.accounts.push({ ...accountState.accounts[0], id: 'copilot:43', login: 'second-synthetic-user', accessToken: 'SYNTHETIC_SECOND_GITHUB_TOKEN' });
    f.store.setManagedState('copilot-auth:v1', accountState);
    expect((await f.catalog.discover(f.provider.id)).ok).toBe(true);
    f.manager.linkAccount(f.provider.id, 'copilot:43');
    expect(() => f.catalog.addSelected(f.provider.id, [{ upstreamId: 'account-42-model' }])).toThrow(/配置已变化/);
    f.manager.linkAccount(f.provider.id, 'copilot:42'); hold = true;
    const pending = f.catalog.discover(f.provider.id);
    try {
      await vi.waitFor(() => expect(requested).toBe(true));
      f.manager.linkAccount(f.provider.id, 'copilot:43');
    } finally { release(json({ data: [{ id: 'late-account-42-model' }] })); }
    expect(await pending).toMatchObject({ ok: false, errorCategory: 'invalid-provider', models: [] });
    expect(f.store.listModels()).toEqual([]);
    expect(f.store.getProvider(f.provider.id)).toMatchObject({ copilotAccountId: 'copilot:43', authStatus: 'ready' });
  });

  it('tests the saved Copilot model through real inference without querying a catalog or exposing generated text', async () => {
    const f = await fixture((url, init) => {
      const body = JSON.parse(String(init.body));
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${COPILOT_TOKEN}`);
      expect(new Headers(init.headers).get('copilot-integration-id')).toBe('code-oss');
      if (url.endsWith('/models')) throw new Error('Connection testing must not require model discovery');
      if (url.endsWith('/chat/completions')) return json({ id: 'chat-connectivity', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'SYNTHETIC_PRIVATE_TEST_ANSWER' }, finish_reason: 'stop' }] });
      expect(body.stream).toBe(false);
      return json({ id: 'response-connectivity', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_PRIVATE_TEST_ANSWER' }] }] });
    });
    await f.login();
    const chat = f.store.saveModel(model(f.provider.id, 'connection-chat', 'chat-completions'));
    const responses = f.store.saveModel(model(f.provider.id, 'connection-responses', 'responses'));
    const before = { models: f.store.listModels(), bindings: f.store.listBindings() };
    const tester = new ConnectionTester(f.store, f.manager, { fetch: f.fetcher });
    const defaultResult = await tester.test(f.provider.id);
    expect(defaultResult).toMatchObject({ ok: true, outcome: 'success', wireApi: 'chat-completions', testedModel: chat.upstreamId, statusCode: 200 });
    const explicitResult = await tester.test(f.provider.id, { modelId: responses.id });
    expect(explicitResult).toMatchObject({ ok: true, outcome: 'success', wireApi: 'responses', testedModel: responses.upstreamId, statusCode: 200 });
    expect(f.calls.filter(call => call.url.startsWith(`${API}/`)).map(call => call.url)).toEqual([`${API}/chat/completions`, `${API}/responses`]);
    expect(JSON.stringify({ defaultResult, explicitResult })).not.toMatch(new RegExp(`${GITHUB_TOKEN}|${COPILOT_TOKEN}|SYNTHETIC_PRIVATE_TEST_ANSWER`));
    expect(f.store.listModels()).toEqual(before.models); expect(f.store.listBindings()).toEqual(before.bindings);
  });

  it('guards the gateway against credential forwarding to a non-Copilot endpoint even if request preparation is compromised', async () => {
    const f = await fixture(() => { throw new Error('Unauthorized endpoint must never receive an inference request'); });
    await f.login();
    const saved = f.store.saveModel(model(f.provider.id, 'guarded-chat', 'chat-completions'));
    const gateway = new Gateway(f.store, { fetch: f.fetcher, prepareRequest: async (provider, _secret, path, body) => {
      const prepared = await f.manager.prepareRequest(provider, path, body);
      return { ...prepared, url: 'https://credential-sink.example.test/chat/completions' };
    } });
    await gateway.start(0); cleanups.push(async () => { await gateway.stop(); });
    const response = await fetch(`${gateway.status().baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: saved.alias, messages: [] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(new RegExp(`${GITHUB_TOKEN}|${COPILOT_TOKEN}`));
    expect(f.calls.filter(call => call.url.includes('credential-sink.example.test'))).toEqual([]);
    expect(f.calls.filter(call => call.url.startsWith(`${API}/`))).toEqual([]);
  });

  it('refuses missing or wrong account credentials before inference and prevents storing OAuth tokens in a provider reference', async () => {
    const f = await fixture(() => { throw new Error('Inference must not run without a linked ready account'); });
    const saved = f.store.saveModel(model(f.provider.id, 'unlinked-chat', 'chat-completions'));
    const local = await localGateway(f);
    const request = () => fetch(`${local.url}/chat/completions`, { method: 'POST', headers: local.headers, body: JSON.stringify({ model: saved.alias, messages: [] }) });
    expect((await request()).status).toBe(503);
    expect(() => f.manager.linkAccount(f.provider.id, 'codex-subscription')).toThrow();
    expect(() => f.manager.linkAccount(f.provider.id, 'copilot:404')).toThrow();
    expect(f.store.getProvider(f.provider.id)).toMatchObject({ hasSecret: false, authStatus: 'missing' });
    expect(() => f.store.setSecret(f.provider.id, { accessToken: GITHUB_TOKEN })).toThrow();
    expect(() => f.store.setSecret(f.provider.id, { apiKey: COPILOT_TOKEN })).toThrow();
    expect(() => f.store.setSecret('deepseek', { copilotAccountId: 'copilot:42' })).toThrow();
    await f.login(); f.accounts.logout('copilot:42'); f.manager.unlinkAccount('copilot:42');
    expect((await request()).status).toBe(503);
    expect(f.store.getSecret(f.provider.id)).toBeUndefined();
    expect(f.store.listModels()).toEqual([saved]);
    expect(f.calls.filter(call => call.url.startsWith(`${API}/`))).toEqual([]);
    expect(f.calls.filter(call => call.url.endsWith('/copilot_internal/v2/token'))).toEqual([]);
  });
});
