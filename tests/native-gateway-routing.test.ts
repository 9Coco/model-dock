import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelCatalog } from '../src/main/catalog';
import { ConnectionTester } from '../src/main/connection-test';
import { Gateway } from '../src/main/gateway';
import { Store } from '../src/main/store';
import { buildConfig } from '../src/main/adapters';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import { directModelsForProvider, nativeDirectBaseUrl } from '../src/shared/single-entry';
import { nativeClaudeBaseUrl } from '../src/shared/claude';
import type { Provider, ToolId } from '../src/shared/types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const adapters = ['trae', 'jetbrains-ide', 'jetbrains-central'] as const;
type Adapter = typeof adapters[number];
const placeholder = 'SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY', sessionToken = 'SYNTHETIC_NATIVE_SESSION_TOKEN';
async function fixture(adapter: Adapter = 'trae') {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-native-routing-')), store = await Store.create(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const trae = adapter === 'trae';
  const metadata = trae ? { nativeClient: { version: 1, client: 'trae-cn', credentials: { token: sessionToken, userId: 'fixture-user', host: 'https://api.trae.cn' } } }
    : adapter === 'jetbrains-ide' ? { nativeIde: { version: 1 }, clientImport: { client: 'jetbrains-ide' } } : { nativeCentral: { version: 1 } };
  const imported = await store.saveRelayClientImport({ kind: 'openai-compatible', presetId: trae ? 'trae-cn-relay' : 'jetbrains-central', relayMode: trae ? 'managed' : undefined, name: `Synthetic ${adapter}`, baseUrl: `http://127.0.0.1:${trae ? 18080 : 18081}/v1`, apiKey: placeholder, enabled: true }, metadata);
  const provider = store.getProvider(imported.id)!;
  expect(provider.nativeAdapter).toBe(adapter); expect(JSON.stringify(provider)).not.toMatch(/SYNTHETIC_NATIVE_SESSION_TOKEN|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY/);
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'SameCase-MODEL', alias: 'friendly-local-alias', displayName: 'Saved display', wireApi: 'chat-completions', contextWindow: 0, tools: true, vision: false, enabled: true });
  const oauth = { prepareRequest: vi.fn(async () => { throw new Error('Native accounts must not prepare historical relay requests'); }) };
  const fetcher = vi.fn(async () => { throw new Error('Native accounts must not fetch historical 18080/18081 listeners'); });
  return { directory, store, provider, model, oauth, fetcher };
}
const chat = (model: string) => ({ id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PRIVATE_GENERATED_ANSWER' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native lifecycle operation timed out')), 2000); })]); } finally { clearTimeout(timer); } }
async function availableRandomPort(): Promise<number> {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve())); return port;
}

describe('native account catalog and inference routing', () => {
  it.each(adapters)('%s gateway maps local aliases to exact native IDs without preparing or fetching relay URLs', async adapter => {
    const f = await fixture(adapter), nativeRequest = vi.fn(async (provider: Provider, path: string, body: Record<string, unknown>, signal: AbortSignal) => {
      expect(provider).toMatchObject({ id: f.provider.id, nativeAdapter: adapter }); expect(path).toBe('/v1/chat/completions'); expect(body.model).toBe(f.model.upstreamId); expect(signal.aborted).toBe(false);
      return Response.json(chat(f.model.upstreamId));
    });
    const gateway = new Gateway(f.store, { nativeRequest, prepareRequest: () => f.oauth.prepareRequest(), fetch: f.fetcher }); await gateway.start(0);
    try {
      const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
      expect(await (await fetch(`${gateway.status().baseUrl}/models`, { headers })).json()).toMatchObject({ data: [{ id: f.model.alias }] });
      const result = await fetch(`${gateway.status().baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], stream: false }) });
      expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ model: f.model.alias, choices: [{ message: { content: 'PRIVATE_GENERATED_ANSWER' } }] });
      expect(nativeRequest).toHaveBeenCalledTimes(1); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.listModels()).toMatchObject([{ id: f.model.id, wireApi: 'chat-completions', upstreamId: f.model.upstreamId, alias: f.model.alias }]);
      expect(JSON.stringify(f.store.logs())).not.toMatch(/PRIVATE_PROMPT|PRIVATE_GENERATED_ANSWER|SYNTHETIC_NATIVE_SESSION_TOKEN|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY/);
    } finally { await gateway.stop(); }
  });
  it.each(adapters)('%s discovers native models once, retaining exact identity and saved aliases', async adapter => {
    const f = await fixture(adapter), nativeModels = vi.fn(async (provider: Provider, signal: AbortSignal) => {
      expect(provider).toMatchObject({ id: f.provider.id, nativeAdapter: adapter }); expect(signal.aborted).toBe(false);
      return Response.json({ object: 'list', data: [{ id: f.model.upstreamId, object: 'model' }, { id: 'Fresh+Case/Model', object: 'model' }] });
    });
    const catalog = new ModelCatalog(f.store, f.oauth, { fetch: f.fetcher, nativeModels }), discovery = await catalog.discover(f.provider.id);
    expect(discovery.ok).toBe(true); expect(discovery.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ upstreamId: f.model.upstreamId, alias: f.model.alias, existingModelId: f.model.id, displayName: f.model.displayName }), expect.objectContaining({ upstreamId: 'Fresh+Case/Model' }),
    ]));
    const { added } = catalog.addSelected(f.provider.id, [{ upstreamId: 'Fresh+Case/Model', alias: 'fresh-local-alias' }]);
    expect(added).toMatchObject([{ providerId: f.provider.id, upstreamId: 'Fresh+Case/Model', alias: 'fresh-local-alias' }]);
    expect(nativeModels).toHaveBeenCalledTimes(1); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.getProvider(f.provider.id)).toMatchObject({ nativeAdapter: adapter, baseUrl: f.provider.baseUrl });
    expect(JSON.stringify(discovery)).not.toMatch(/SYNTHETIC_NATIVE_SESSION_TOKEN|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY/);
  });
  it('discovers and saves Central native protocol declarations without turning Messages into Chat', async () => {
    const f = await fixture('jetbrains-central');
    const entries = [{ id: 'anthropic/NativeMessagesFixture', wire_api: 'messages' }, { id: 'openai/NativeResponsesFixture', wire_api: 'responses' }, { id: 'openai/NativeChatFixture', wire_api: 'chat-completions' }];
    const nativeModels = vi.fn(async () => Response.json({ object: 'list', data: entries }));
    const catalog = new ModelCatalog(f.store, f.oauth, { fetch: f.fetcher, nativeModels }), result = await catalog.discover(f.provider.id);
    expect(result.ok).toBe(true); expect(result.models.map(model => [model.upstreamId, model.wireApi])).toEqual(entries.map(model => [model.id, model.wire_api]));
    const { added } = catalog.addSelected(f.provider.id, entries.map((entry, index) => ({ upstreamId: entry.id, alias: `central-native-${index}` })));
    expect(added.map(model => [model.upstreamId, model.wireApi])).toEqual(entries.map(model => [model.id, model.wire_api]));
    for (const model of added) expect(f.store.listModels().find(saved => saved.id === model.id)).toMatchObject({ upstreamId: model.upstreamId, wireApi: model.wireApi });
    expect(nativeModels).toHaveBeenCalledTimes(1); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not promote a generic Central Chat model into Responses support', async () => {
    const f = await fixture('jetbrains-central'), nativeRequest = vi.fn(async () => Response.json({}));
    const gateway = new Gateway(f.store, { nativeRequest, prepareRequest: () => f.oauth.prepareRequest(), fetch: f.fetcher }); await gateway.start(0);
    try {
      const result = await fetch(`${gateway.status().baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: f.model.alias, input: 'PRIVATE_PROMPT', stream: false }) });
      expect(result.status).toBe(400); expect(nativeRequest).not.toHaveBeenCalled(); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await gateway.stop(); }
  });
  it.each(adapters)('%s connection tests use the selected upstream ID and keep output private', async adapter => {
    const f = await fixture(adapter), nativeRequest = vi.fn(async (provider: Provider, route: string, body: Record<string, unknown>, signal: AbortSignal) => {
      expect(provider.nativeAdapter).toBe(adapter); expect(route).toBe('/chat/completions'); expect(body.model).toBe(f.model.upstreamId); expect(body.model).not.toBe(f.model.alias); expect(signal.aborted).toBe(false);
      if (adapter === 'trae') expect(body).not.toHaveProperty('max_tokens');
      else expect(body.max_tokens).toBe(adapter === 'jetbrains-ide' ? 256 : 16);
      return Response.json(chat(f.model.upstreamId));
    });
    const tester = new ConnectionTester(f.store, f.oauth, { fetch: f.fetcher, nativeRequest }), result = await tester.test(f.provider.id, { modelId: f.model.id });
    expect(result).toMatchObject({ ok: true, outcome: 'success', testedModel: f.model.upstreamId, wireApi: 'chat-completions', statusCode: 200 });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_GENERATED_ANSWER|SYNTHETIC_NATIVE_SESSION_TOKEN|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY/);
    expect(nativeRequest).toHaveBeenCalledTimes(1); expect(nativeRequest.mock.calls[0][3].aborted).toBe(true); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(adapters)('%s inference keeps native Responses and Messages routes in the callback', async adapter => {
    const f = await fixture(adapter), seen: { route: string; body: Record<string, unknown> }[] = [];
    const tester = new ConnectionTester(f.store, f.oauth, { fetch: f.fetcher, nativeRequest: async (_provider, route, body) => {
      seen.push({ route, body });
      return route === '/responses' ? Response.json({ id: 'resp_fixture', object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_GENERATED_ANSWER' }] }] })
        : Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'PRIVATE_GENERATED_ANSWER' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } });
    } });
    for (const wireApi of ['responses', 'messages'] as const) expect(await tester.test(f.provider.id, { upstreamId: 'Exact/Selected-ID', wireApi })).toMatchObject({ ok: true, testedModel: 'Exact/Selected-ID', wireApi });
    expect(seen.map(row => [row.route, row.body.model])).toEqual([['/responses', 'Exact/Selected-ID'], ['/v1/messages', 'Exact/Selected-ID']]);
    expect(seen[0].body.max_output_tokens).toBe(adapter === 'jetbrains-ide' ? 256 : 64); expect(seen[1].body.max_tokens).toBe(adapter === 'jetbrains-ide' ? 256 : 16); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(adapters)('%s fails closed when native callbacks are absent or decline the account', async adapter => {
    const f = await fixture(adapter);
    for (const declined of [false, true]) {
      const catalog = new ModelCatalog(f.store, f.oauth, { fetch: f.fetcher, ...(declined ? { nativeModels: async () => undefined } : {}) });
      expect(await catalog.discover(f.provider.id)).toMatchObject({ ok: false, errorCategory: 'invalid-provider', models: [] });
      const tester = new ConnectionTester(f.store, f.oauth, { fetch: f.fetcher, ...(declined ? { nativeRequest: async () => undefined } : {}) });
      expect(await tester.test(f.provider.id, { modelId: f.model.id })).toMatchObject({ ok: false, outcome: 'configuration' });
      const gateway = new Gateway(f.store, { prepareRequest: () => f.oauth.prepareRequest(), fetch: f.fetcher, ...(declined ? { nativeRequest: async () => undefined } : {}) });
      await gateway.start(0); try {
        const result = await fetch(`${gateway.status().baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }) });
        expect(result.status).toBe(503); expect(await result.text()).not.toMatch(/PRIVATE_PROMPT|SYNTHETIC_NATIVE_SESSION_TOKEN|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY/);
      } finally { await gateway.stop(); }
    }
    expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(adapters)('%s refuses native catalog pagination and never fetches a next page', async adapter => {
    const f = await fixture(adapter);
    for (const paging of [{ next: '?page=2' }, { has_more: true, next_cursor: 'PRIVATE_CURSOR' }, { links: { next: 'https://foreign.example/models' } }]) {
      const nativeModels = vi.fn(async () => Response.json({ object: 'list', data: [{ id: 'PartialNativeModel' }], ...paging }));
      const catalog = new ModelCatalog(f.store, f.oauth, { fetch: f.fetcher, nativeModels });
      expect(await catalog.discover(f.provider.id)).toMatchObject({ ok: false, errorCategory: 'invalid-response', models: [] });
      expect(nativeModels).toHaveBeenCalledTimes(1); expect(() => catalog.addSelected(f.provider.id, [{ upstreamId: 'PartialNativeModel' }])).toThrow();
    }
    expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(adapters)('%s never exposes raw native callback errors or HTTP failure bodies', async adapter => {
    const f = await fixture(adapter);
    const catalog = new ModelCatalog(f.store, f.oauth, { fetch: f.fetcher, nativeModels: async () => { throw new Error(sessionToken + ' PRIVATE_ERROR_BODY'); } });
    const discovery = await catalog.discover(f.provider.id); expect(discovery.ok).toBe(false); expect(JSON.stringify(discovery)).not.toMatch(/SYNTHETIC_NATIVE_SESSION_TOKEN|PRIVATE_ERROR_BODY/);
    const tester = new ConnectionTester(f.store, f.oauth, { fetch: f.fetcher, nativeRequest: async () => new Response(sessionToken + ' PRIVATE_ERROR_BODY', { status: 401 }) });
    const result = await tester.test(f.provider.id, { modelId: f.model.id }); expect(result).toMatchObject({ ok: false, outcome: 'authentication', statusCode: 401 }); expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_NATIVE_SESSION_TOKEN|PRIVATE_ERROR_BODY/);
    expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('native accounts cannot export historical relay endpoints as supplier direct APIs', () => {
  const strictTools: ToolId[] = ['codex', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm'];
  it.each(adapters)('%s is ineligible for every single-entry direct mode', async adapter => {
    const f = await fixture(adapter), providers = f.store.listProviders(), models = f.store.listModels();
    expect(nativeClaudeBaseUrl(f.provider)).toBeUndefined();
    for (const tool of strictTools) {
      const base = f.store.listBindings().find(row => row.id === tool)!;
      const binding = { ...base, enabled: true, mode: 'direct' as const, providerIds: [f.provider.id], modelIds: [f.model.id], modelSelection: 'selected' as const, defaultModelId: f.model.id };
      expect(directModelsForProvider(tool, f.provider, models)).toEqual([]); expect(nativeDirectBaseUrl(tool, f.provider, models)).toBeUndefined(); expect(resolveBindingModels(binding, models, providers)).toEqual([]);
      expect(bindingConnectionPolicy(binding, models, providers).groups).toEqual([]); expect(() => f.store.saveBinding(binding)).toThrow();
      // Also protect exports from an old saved direct draft that predates the
      // stricter Store guard; do not mutate the real persisted binding.
      const view = { listBindings: () => f.store.listBindings().map(row => row.id === tool ? binding : row), listModels: () => models, listProviders: () => providers, getProvider: (id: string) => f.store.getProvider(id), getSecret: (id: string) => f.store.getSecret(id), gatewayKey: () => f.store.gatewayKey() };
      let exported = ''; try { exported = buildConfig(view, tool, 32123, true, f.directory).content; } catch (error) { expect(String(error)).not.toContain(placeholder); }
      expect(exported).not.toMatch(/18080|18081|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY|SYNTHETIC_NATIVE_SESSION_TOKEN/);
    }
  });
  it.each(adapters)('%s aggregate exports use the existing gateway key and local alias', async adapter => {
    const f = await fixture(adapter);
    const centralModels = adapter === 'jetbrains-central' ? {
      chat: f.store.saveModel({ ...f.model, id: undefined, upstreamId: 'openai/NativeChatFixture', alias: 'central-chat-alias', wireApi: 'chat-completions' }),
      responses: f.store.saveModel({ ...f.model, id: undefined, upstreamId: 'openai/NativeResponsesFixture', alias: 'central-responses-alias', wireApi: 'responses' }),
      messages: f.store.saveModel({ ...f.model, id: undefined, upstreamId: 'anthropic/NativeMessagesFixture', alias: 'central-messages-alias', wireApi: 'messages' }),
    } : undefined;
    for (const tool of ['codex', 'claude-code', 'junie', 'copilot-cli', 'vscode', 'opencode', 'rider'] as const) {
      const base = f.store.listBindings().find(row => row.id === tool)!;
      const selected = centralModels ? tool === 'codex' ? centralModels.responses : tool === 'claude-code' ? centralModels.messages : centralModels.chat : f.model;
      f.store.saveBinding({ ...base, enabled: true, mode: 'aggregate', providerIds: [f.provider.id], modelIds: [selected.id], modelSelection: 'selected', defaultModelId: selected.id });
      const exported = buildConfig(f.store, tool, 32123, true, f.directory).content;
      expect(exported).toContain('32123'); expect(exported).toContain(selected.alias); expect(exported).toContain(f.store.gatewayKey());
      expect(exported).not.toMatch(/18080|18081|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY|SYNTHETIC_NATIVE_SESSION_TOKEN/);
    }
    expect(f.store.listModels().find(model => model.id === f.model.id)).toMatchObject({ wireApi: 'chat-completions', upstreamId: f.model.upstreamId, alias: f.model.alias });
    if (centralModels) expect(Object.values(centralModels).map(model => f.store.listModels().find(saved => saved.id === model.id)?.wireApi)).toEqual(['chat-completions', 'responses', 'messages']);
  });
  it.each(adapters)('%s legacy direct groups remain locally managed and never export the historical placeholder key', async adapter => {
    const f = await fixture(adapter);
    for (const tool of ['vscode', 'opencode', 'copilot', 'junie', 'copilot-cli'] as const) {
      const base = f.store.listBindings().find(row => row.id === tool)!;
      f.store.saveBinding({ ...base, enabled: true, mode: 'direct', providerIds: [f.provider.id], modelIds: [f.model.id], modelSelection: 'selected', defaultModelId: f.model.id });
      const binding = f.store.listBindings().find(row => row.id === tool)!;
      expect(bindingConnectionPolicy(binding, f.store.listModels(), f.store.listProviders()).groups).toMatchObject([{ connection: 'local-managed' }]);
      const content = buildConfig(f.store, tool, 32123, true, f.directory).content;
      expect(content).toContain('32123'); expect(content).toContain(f.model.alias); expect(content).toContain(f.store.gatewayKey()); expect(content).not.toMatch(/18080|18081|SYNTHETIC_OLD_LOCAL_PLACEHOLDER_KEY|SYNTHETIC_NATIVE_SESSION_TOKEN/);
    }
  });
});

describe('native gateway lifecycle', () => {
  it.each(adapters)('%s historical placeholder may match the only gateway listener without causing a self-loop rejection', async adapter => {
    const f = await fixture(adapter), port = await availableRandomPort(), placeholderUrl = `http://127.0.0.1:${port}/v1`;
    // Real Store presets retain their fixed historical identities. Substitute
    // only returned provider copies so this test never binds 18080 or 18081.
    const getProvider = f.store.getProvider.bind(f.store), listProviders = f.store.listProviders.bind(f.store);
    const project = (provider: Provider) => provider.id === f.provider.id ? { ...provider, baseUrl: placeholderUrl } : provider;
    const get = vi.spyOn(f.store, 'getProvider').mockImplementation(id => { const provider = getProvider(id); return provider && project(provider); });
    const list = vi.spyOn(f.store, 'listProviders').mockImplementation(() => listProviders().map(project));
    const nativeRequest = vi.fn(async (_provider: Provider, _path: string, body: Record<string, unknown>) => Response.json(chat(String(body.model))));
    const gateway = new Gateway(f.store, { port, nativeRequest, fetch: f.fetcher, prepareRequest: () => f.oauth.prepareRequest() });
    try {
      await expect(gateway.start()).resolves.toMatchObject({ running: true, port });
      const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
      expect(await (await fetch(`${gateway.status().baseUrl}/models`, { headers })).json()).toMatchObject({ data: [{ id: f.model.alias }] });
      const result = await fetch(`${gateway.status().baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], stream: false }) });
      expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ model: f.model.alias });
      expect(nativeRequest).toHaveBeenCalledTimes(1); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await gateway.stop(); get.mockRestore(); list.mockRestore(); }
  });
  it('still rejects an ordinary API URL that points back to the chosen gateway port', async () => {
    const f = await fixture(), port = await availableRandomPort();
    f.store.saveProvider({ kind: 'openai-compatible', presetId: 'custom', name: 'Synthetic real API self-loop', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'PRIVATE_API_KEY', enabled: true });
    const gateway = new Gateway(f.store, { port, fetch: f.fetcher });
    try { await expect(gateway.start()).rejects.toThrow('请求循环'); expect(gateway.status().running).toBe(false); expect(f.fetcher).not.toHaveBeenCalled(); }
    finally { await gateway.stop(); }
  });
  it('cancelProvider aborts all matching active streams, preserves another provider, and stop aborts the remainder without retry', async () => {
    const f = await fixture();
    const other = await f.store.saveRelayClientImport({ kind: 'openai-compatible', presetId: 'jetbrains-central', name: 'Other native account', baseUrl: 'http://127.0.0.1:18081/v1', apiKey: placeholder, enabled: true }, { nativeCentral: { version: 1 } });
    const otherModel = f.store.saveModel({ ...f.model, id: undefined, providerId: other.id, upstreamId: 'openai/OtherNativeFixture', alias: 'other-native-alias' });
    interface Active { providerId: string; signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array>; aborted: ReturnType<typeof deferred>; model: string }
    const active: Active[] = [], encoder = new TextEncoder();
    const chunk = (request: Active, text: string) => encoder.encode(`data: ${JSON.stringify({ id: 'chatcmpl_native_fixture', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    const nativeRequest = vi.fn(async (provider: Provider, _path: string, body: Record<string, unknown>, signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      const request: Active = { providerId: provider.id, signal, controller, aborted: deferred(), model: String(body.model) }; active.push(request);
      signal.addEventListener('abort', () => { request.aborted.resolve(); controller.error(new DOMException('Synthetic upstream aborted', 'AbortError')); }, { once: true });
      controller.enqueue(chunk(request, provider.id === f.provider.id ? 'FIRST_A' : 'FIRST_B'));
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    const gateway = new Gateway(f.store, { nativeRequest, fetch: f.fetcher, prepareRequest: () => f.oauth.prepareRequest(), timeoutMs: 10000 }); await gateway.start(0);
    const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    const post = (alias: string) => fetch(`${gateway.status().baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], stream: true }) });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const responses = await within(Promise.all([post(f.model.alias), post(f.model.alias), post(otherModel.alias)]));
      for (const [index, response] of responses.entries()) { expect(response.status).toBe(200); const reader = response.body!.getReader(); readers.push(reader); expect(new TextDecoder().decode((await within(reader.read())).value)).toContain(index === 2 ? 'FIRST_B' : 'FIRST_A'); }
      const selected = active.filter(request => request.providerId === f.provider.id), remaining = active.find(request => request.providerId === other.id)!;
      expect(selected).toHaveLength(2); expect(nativeRequest).toHaveBeenCalledTimes(3);
      gateway.cancelProvider(f.provider.id); await within(Promise.all(selected.map(request => request.aborted.promise)));
      expect(selected.every(request => request.signal.aborted)).toBe(true); expect(remaining.signal.aborted).toBe(false);
      for (const reader of readers.slice(0, 2)) await expect(within(reader.read())).rejects.toBeDefined();
      gateway.cancelProvider('unknown-provider'); expect(remaining.signal.aborted).toBe(false);
      remaining.controller.enqueue(chunk(remaining, 'SECOND_B'));
      expect(new TextDecoder().decode((await within(readers[2].read())).value)).toContain('SECOND_B'); expect(remaining.signal.aborted).toBe(false);
      await gateway.stop(); await within(remaining.aborted.promise); expect(remaining.signal.aborted).toBe(true); await expect(within(readers[2].read())).rejects.toBeDefined();
      expect(nativeRequest).toHaveBeenCalledTimes(3); expect(f.oauth.prepareRequest).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await gateway.stop(); for (const reader of readers) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
  });
});
