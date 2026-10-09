import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Model, ModelInput, Provider } from '../src/shared/types';
import { ModelCatalog, type CatalogStore } from '../src/main/catalog';
import { modelCatalogEndpoint, prepareUpstream } from '../src/main/oauth';
import { lookupModelMetadata } from '../src/shared/model-metadata';
import { version as appVersion } from '../package.json';

const provider: Provider = { id: 'api', name: 'Example', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://api.example.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
class MemoryStore implements CatalogStore {
  provider = { ...provider };
  models: Model[] = [];
  batches: ModelInput[][] = [];
  getProvider(id: string) { return id === this.provider.id ? { ...this.provider } : undefined; }
  listModels() { return this.models.map(model => ({ ...model })); }
  saveModels(inputs: ModelInput[]) {
    this.batches.push(inputs);
    const added = inputs.map((input, index) => ({ ...input, id: `new-${this.models.length + index}` }));
    this.models.push(...added);
    return added;
  }
}
function fixture(fetcher: typeof fetch = vi.fn(async () => json({ data: [{ id: 'real-model' }] })) as typeof fetch) {
  const store = new MemoryStore();
  const prepareRequest = vi.fn(async (p: Provider, path: string, body: Record<string, unknown>) => prepareUpstream(p, p.kind === 'openai-compatible' ? { apiKey: 'SYNTHETIC_ONLY' } : { accessToken: 'SYNTHETIC_ONLY' }, path, body));
  return { store, prepareRequest, catalog: new ModelCatalog(store, { prepareRequest }, { fetch: fetcher }) };
}
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

describe('real model catalog discovery and batch selection', () => {
  it('discovers Anthropic native models with version/auth headers, preserving /anthropic and native after_id pagination', async () => {
    const seen: unknown[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, method: req.method, key: req.headers['x-api-key'], auth: req.headers.authorization, version: req.headers['anthropic-version'] });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.includes('after_id=')
        ? { data: [{ id: 'claude-second', type: 'model', display_name: 'Second' }], has_more: false, last_id: 'claude-second' }
        : { data: [{ id: 'claude-first', type: 'model', display_name: 'First', max_input_tokens: 100000, capabilities: { image_input: { supported: true } } }], has_more: true, last_id: 'claude-first' }));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.presetId = 'anthropic';
    f.store.provider.messagesAuth = 'api-key';
    f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic/v1`;
    const result = await f.catalog.discover('api');
    expect(result).toMatchObject({ ok: true });
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ upstreamId: 'claude-first', displayName: 'First', wireApi: 'messages', contextWindow: 100000, vision: true });
    expect(result.models[1]).toMatchObject({ upstreamId: 'claude-second', wireApi: 'messages' });
    expect(seen).toEqual(['/anthropic/v1/models', '/anthropic/v1/models?after_id=claude-first'].map(url => ({ url, method: 'GET', key: 'SYNTHETIC_ONLY', auth: undefined, version: '2023-06-01' })));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ONLY');
    expect(f.catalog.addSelected('api', [{ upstreamId: 'claude-first' }]).added[0]).toMatchObject({ wireApi: 'messages', upstreamId: 'claude-first' });
  });
  it.each(['api-key', 'bearer'] as const)('uses native catalog semantics and selected %s auth for custom Messages models', async messagesAuth => {
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe('https://gateway.example.test/anthropic/v1/models');
      expect(new Headers(init?.headers).get('x-api-key')).toBe(messagesAuth === 'api-key' ? 'SYNTHETIC_ONLY' : null);
      expect(new Headers(init?.headers).get('authorization')).toBe(messagesAuth === 'bearer' ? 'Bearer SYNTHETIC_ONLY' : null);
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
      return json({ data: [{ id: 'saved-native', type: 'model' }, { id: 'new-native', type: 'model' }] });
    });
    const f = fixture(fetcher as typeof fetch); f.store.provider.baseUrl = 'https://gateway.example.test/anthropic';
    f.store.provider.messagesAuth = messagesAuth;
    f.store.models = [{ id: 'native', providerId: 'api', upstreamId: 'saved-native', alias: 'existing', displayName: 'Existing Name', wireApi: 'messages', contextWindow: 12345, tools: true, vision: false, enabled: true }];
    const result = await f.catalog.discover('api');
    expect(result).toMatchObject({ ok: true });
    expect(result.models[0]).toMatchObject({ existingModelId: 'native', wireApi: 'messages', contextWindow: 12345, tools: true, displayName: 'Existing Name' });
    expect(result.models[1]).toMatchObject({ upstreamId: 'new-native', wireApi: 'messages' });
    expect(f.catalog.addSelected('api', [{ upstreamId: 'new-native', wireApi: 'messages' }]).added[0].wireApi).toBe('messages');
  });
  it.each(['api-key', 'bearer'] as const)('sends only selected %s auth to the native model directory (local upstream)', async messagesAuth => {
    const seen: unknown[] = [];
    const server = createServer((req, res) => {
      seen.push({ key: req.headers['x-api-key'], auth: req.headers.authorization });
      const valid = messagesAuth === 'api-key' ? req.headers['x-api-key'] === 'SYNTHETIC_ONLY' && !req.headers.authorization
        : req.headers.authorization === 'Bearer SYNTHETIC_ONLY' && !req.headers['x-api-key'];
      res.setHeader('Content-Type', 'application/json');
      if (!valid) { res.statusCode = 401; res.end('{}'); return; }
      res.end(JSON.stringify({ data: [{ id: 'claude-native' }], has_more: false }));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.presetId = 'anthropic'; f.store.provider.messagesAuth = messagesAuth;
    f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic`;
    expect(await f.catalog.discover('api')).toMatchObject({ ok: true, models: [expect.objectContaining({ wireApi: 'messages', upstreamId: 'claude-native' })] });
    expect(seen).toEqual([{ key: messagesAuth === 'api-key' ? 'SYNTHETIC_ONLY' : undefined, auth: messagesAuth === 'bearer' ? 'Bearer SYNTHETIC_ONLY' : undefined }]);
  });
  it('invalidates a discovery selection when its Messages auth mode changes', async () => {
    const f = fixture(); f.store.provider.presetId = 'anthropic'; f.store.provider.messagesAuth = 'bearer';
    expect((await f.catalog.discover('api')).ok).toBe(true);
    f.store.provider.messagesAuth = 'api-key';
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'real-model' }])).toThrow('供应商配置');
  });
  it('refuses a forged prepared endpoint before normalizing custom Messages catalog URLs', async () => {
    const fetcher = vi.fn(async () => json({ data: [] })); const f = fixture(fetcher as typeof fetch);
    f.store.models = [{ id: 'native', providerId: 'api', upstreamId: 'saved-native', alias: 'existing', displayName: 'Existing', wireApi: 'messages', contextWindow: 0, tools: true, vision: false, enabled: true }];
    f.prepareRequest.mockImplementation(async (p, path, body) => ({ ...prepareUpstream(p, { apiKey: 'SYNTHETIC_ONLY' }, path, body), url: 'https://attacker.example.test/v1/models' }));
    expect(await f.catalog.discover('api')).toMatchObject({ ok: false, errorCategory: 'invalid-provider' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not treat a Messages completion or native error as a model directory', async () => {
    for (const payload of [{ id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_RESPONSE' }] },
      { type: 'error', error: { message: 'PRIVATE_ERROR_BODY SYNTHETIC_ONLY' } }]) {
      const f = fixture(vi.fn(async () => json(payload)) as typeof fetch); f.store.provider.presetId = 'anthropic';
      const result = await f.catalog.discover('api');
      expect(result).toMatchObject({ ok: false, errorCategory: 'invalid-response', models: [] });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_RESPONSE|PRIVATE_ERROR_BODY|SYNTHETIC_ONLY/);
    }
  });
  it('uses the actual configured base path, authenticated GET and refuses redirects (local mock server)', async () => {
    const seen: { url: string; method: string; auth: string | undefined }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url!, method: req.method!, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'served-model' }] }));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${port}/api/coding/v3`;
    expect((await f.catalog.discover('api')).models.map(model => model.upstreamId)).toEqual(['served-model']);
    expect(seen).toEqual([{ url: '/api/coding/v3/models', method: 'GET', auth: 'Bearer SYNTHETIC_ONLY' }]);
  });
  it('preserves real DeepSeek metadata and current preset protocol, deduplicating IDs', async () => {
    const f = fixture(vi.fn(async () => json({ data: [
      { id: 'discovered-flash', name: 'Upstream Display', context_window: 1048576, input_modalities: ['text', 'image'] },
      { id: 'discovered-flash', name: 'Duplicate' }, { id: 'plain-model' },
    ] })) as typeof fetch);
    f.store.provider.presetId = 'deepseek';
    const result = await f.catalog.discover('api');
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ upstreamId: 'discovered-flash', displayName: 'Upstream Display', contextWindow: 1048576, wireApi: 'responses', vision: true, tools: false, metadataSource: 'upstream', metadataDefaults: ['tools'] });
    expect(result.models[1]).toMatchObject({ contextWindow: 0, vision: false, tools: false, metadataSource: 'defaults', metadataDefaults: ['contextWindow', 'tools', 'vision'] });
  });
  it('distinguishes missing capability fields from explicit false even with partial upstream metadata', async () => {
    const f = fixture(vi.fn(async () => json({ data: [
      { id: 'context-only', context_window: 100000 },
      { id: 'explicit-false', tools: false, vision: false },
      { id: 'text-only', input_modalities: ['text'], supports_tools: true },
      { id: 'zero-context', context_window: 0, capabilities: { tools: false, vision: true } },
      { id: 'explicit-vision-false', vision: false, input_modalities: ['text', 'image'] },
      { id: 'bad-modalities', input_modalities: [false, null, {}] },
    ] })) as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result.models[0]).toMatchObject({ tools: false, vision: false, metadataSource: 'upstream', metadataDefaults: ['tools', 'vision'] });
    expect(result.models[1]).toMatchObject({ tools: false, vision: false, metadataDefaults: ['contextWindow'] });
    expect(result.models[2]).toMatchObject({ tools: true, vision: false, metadataDefaults: ['contextWindow'] });
    expect(result.models[3]).toMatchObject({ contextWindow: 0, tools: false, vision: true, metadataDefaults: ['contextWindow'] });
    expect(result.models[4]).toMatchObject({ vision: false, metadataDefaults: ['contextWindow', 'tools'] });
    expect(result.models[5]).toMatchObject({ vision: false, metadataDefaults: ['contextWindow', 'tools', 'vision'] });
  });
  it('fills only absent metadata from a known model while keeping tool and protocol defaults', async () => {
    const known = lookupModelMetadata('gpt-4o')!;
    expect(known).toMatchObject({ vision: true });
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'gpt-4o' }] })) as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result.models[0]).toMatchObject({ contextWindow: known.contextWindow, vision: true, tools: false, wireApi: 'chat-completions',
      metadataSource: 'defaults', metadataDefaults: ['tools'], metadataInferred: ['contextWindow', 'vision'],
      metadataReference: { sourceUrl: known.sourceUrl, verifiedAt: known.verifiedAt } });
    expect(f.catalog.addSelected('api', [{ upstreamId: 'gpt-4o' }]).added[0]).toMatchObject({ contextWindow: known.contextWindow, vision: true, tools: false, wireApi: 'chat-completions' });
  });
  it.each([
    [{ context_window: 32000 }, { contextWindow: 32000, vision: true }, ['vision']],
    [{ vision: false }, { vision: false }, ['contextWindow']],
    [{ input_modalities: ['text'] }, { vision: false }, ['contextWindow']],
    [{ vision: false, input_modalities: ['text', 'image'] }, { vision: false }, ['contextWindow']],
  ])('respects usable upstream declarations and infers each missing field separately (%j)', async (upstream, expected, inferred) => {
    const known = lookupModelMetadata('gpt-4o')!;
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'gpt-4o', ...upstream }] })) as typeof fetch);
    const model = (await f.catalog.discover('api')).models[0];
    expect(model).toMatchObject({ contextWindow: known.contextWindow, metadataSource: 'upstream', metadataDefaults: ['tools'], metadataInferred: inferred, ...expected });
    expect(model.metadataReference).toEqual({ sourceUrl: known.sourceUrl, verifiedAt: known.verifiedAt });
  });
  it('keeps fully declared upstream metadata authoritative and omits dictionary attribution', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'gpt-4o', context_window: 16000, tools: false, vision: false }] })) as typeof fetch);
    const model = (await f.catalog.discover('api')).models[0];
    expect(model).toMatchObject({ contextWindow: 16000, tools: false, vision: false, metadataSource: 'upstream', metadataDefaults: [] });
    expect(model).not.toHaveProperty('metadataInferred');
    expect(model).not.toHaveProperty('metadataReference');
  });
  it('does not let malformed metadata mask valid alternatives, including OpenRouter input modalities', async () => {
    const f = fixture(vi.fn(async () => json({ data: [
      { id: 'gpt-4o', context_window: 'invalid', contextWindow: -1, context_length: 64000, vision: 'false', supports_vision: false },
      { id: 'router-model', context_window: 0, context_length: 200000, input_modalities: [null, false, 'invalid'], architecture: { input_modalities: ['text', 'image'] } },
      { id: 'capability-model', context_window: -1, capabilities: { limits: { max_context_window_tokens: 128000 }, input_modalities: ['text'] } },
    ] })) as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result.models[0]).toMatchObject({ contextWindow: 64000, vision: false, metadataSource: 'upstream', metadataDefaults: ['tools'] });
    expect(result.models[0]).not.toHaveProperty('metadataInferred');
    expect(result.models[1]).toMatchObject({ contextWindow: 200000, vision: true, metadataSource: 'upstream', metadataDefaults: ['tools'] });
    expect(result.models[2]).toMatchObject({ contextWindow: 128000, vision: false, metadataSource: 'upstream', metadataDefaults: ['tools'] });
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '128000'])('fills invalid upstream context (%j) while ignoring unusable input metadata', async contextWindow => {
    const known = lookupModelMetadata('gpt-4o')!;
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'gpt-4o', context_window: contextWindow, vision: 'yes', input_modalities: [false, null, {}, 'invalid'] }] })) as typeof fetch);
    expect((await f.catalog.discover('api')).models[0]).toMatchObject({ contextWindow: known.contextWindow, vision: true,
      metadataSource: 'defaults', metadataDefaults: ['tools'], metadataInferred: ['contextWindow', 'vision'] });
  });
  it('keeps unknown and near-collision IDs unset instead of inferring from their display names', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'gpt-4o-not-a-release' }, { id: 'custom-model', display_name: 'gpt-4o' }] })) as typeof fetch);
    for (const model of (await f.catalog.discover('api')).models) {
      expect(model).toMatchObject({ contextWindow: 0, vision: false, tools: false, metadataSource: 'defaults', metadataDefaults: ['contextWindow', 'tools', 'vision'] });
      expect(model).not.toHaveProperty('metadataInferred');
      expect(model).not.toHaveProperty('metadataReference');
    }
  });
  it('persists explicit user zero and false overrides and displays saved settings after rediscovery', async () => {
    const fetcher = vi.fn(async () => json({ data: [{ id: 'gpt-4o' }] }));
    const f = fixture(fetcher as typeof fetch);
    await f.catalog.discover('api');
    expect(f.catalog.addSelected('api', [{ upstreamId: 'gpt-4o', alias: 'my-model', displayName: 'My Model', contextWindow: 0,
      vision: false, tools: true, wireApi: 'responses', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }]).added[0])
      .toMatchObject({ contextWindow: 0, vision: false, tools: true });
    f.store.models[0].enabled = false;
    const saved = structuredClone(f.store.models[0]);
    fetcher.mockImplementation(async () => json({ data: [{ id: 'gpt-4o', context_window: 32000, vision: true, tools: false,
      supported_reasoning_levels: ['high'], default_reasoning_level: 'high' }] }));
    const model = (await f.catalog.discover('api')).models[0];
    expect(model).toMatchObject({ existingModelId: saved.id, alias: 'my-model', displayName: 'My Model', contextWindow: 0,
      vision: false, tools: true, wireApi: 'responses', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' });
    expect(model).not.toHaveProperty('metadataDefaults');
    expect(model).not.toHaveProperty('metadataInferred');
    expect(model).not.toHaveProperty('metadataReference');
    expect(f.catalog.addSelected('api', [{ upstreamId: 'gpt-4o', contextWindow: 32000, vision: true }])).toEqual({ added: [], skipped: ['gpt-4o'] });
    expect(f.store.models).toEqual([saved]);
    expect(f.store.batches).toHaveLength(1);
  });
  it('accepts native subscription strings and objects but always keeps Responses', async () => {
    const f = fixture(vi.fn(async () => json({ models: ['native-model', { slug: 'native-other', display_name: 'Native Display', contextWindow: 250000 }] })) as typeof fetch);
    f.store.provider = { ...provider, kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex' };
    const result = await f.catalog.discover('api');
    expect(result.models.map(model => model.upstreamId)).toEqual(['native-model', 'native-other']);
    expect(result.models.every(model => model.wireApi === 'responses')).toBe(true);
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'native-model', wireApi: 'chat-completions' }])).toThrow('Responses');
    expect(f.store.models).toEqual([]);
  });
  it('follows only same model route pagination and handles has_more cursors', async () => {
    const urls: string[] = [];
    const f = fixture(vi.fn(async url => {
      urls.push(String(url));
      return urls.length === 1 ? json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }) : json({ data: [{ id: 'a' }, { id: 'b' }], has_more: false });
    }) as typeof fetch);
    expect((await f.catalog.discover('api')).models.map(model => model.upstreamId)).toEqual(['a', 'b']);
    expect(urls).toEqual(['https://api.example.test/v1/models', 'https://api.example.test/v1/models?after=a']);
  });
  it.each(['https://attacker.test/v1/models', '/v1/chat/completions', '/v1/models?token=private', '/v1/models#redirect'])('rejects unsafe pagination %s before sending credentials', async next => {
    const fetcher = vi.fn(async () => json({ data: [{ id: 'a' }], next }));
    const f = fixture(fetcher as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result).toMatchObject({ ok: false, errorCategory: 'invalid-response', models: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a' }])).toThrow('目录已过期');
  });
  it('rejects repeated pages and excessive page counts without caching partial models', async () => {
    const looping = fixture(vi.fn(async () => json({ data: [{ id: 'a' }], next: '?page=1' })) as typeof fetch);
    expect((await looping.catalog.discover('api')).ok).toBe(false);
    const fetcher = vi.fn(async () => json({ data: [{ id: 'a' }], next_page: fetcher.mock.calls.length + 1 }));
    const bounded = fixture(fetcher as typeof fetch);
    expect((await bounded.catalog.discover('api')).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(() => bounded.catalog.addSelected('api', [{ upstreamId: 'a' }])).toThrow();
  });
  it.each([[401, 'authentication'], [402, 'upstream'], [403, 'permission'], [404, 'unsupported'], [405, 'unsupported'], [429, 'rate-limit'], [503, 'upstream']] as const)('classifies HTTP %s and never exposes upstream error text', async (status, category) => {
    const f = fixture(vi.fn(async () => json({ error: 'SYNTHETIC_ONLY SECRET_ECHO' }, status)) as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result).toMatchObject({ ok: false, statusCode: status, errorCategory: category, models: [] });
    expect(JSON.stringify(result)).not.toContain('SECRET_ECHO');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ONLY');
    if (status === 402) expect(result.message).toContain('余额不足');
  });
  it('does not invent a catalog on 404, non-JSON, malformed JSON, or non-list payloads', async () => {
    for (const response of [new Response('<html>LOGIN SECRET_ECHO</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('not-json'), json({ error: 'SECRET_ECHO' })]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      expect(await f.catalog.discover('api')).toMatchObject({ ok: false, errorCategory: 'invalid-response', models: [] });
      expect(f.store.models).toEqual([]);
    }
  });
  it('bounds declared and streamed response sizes', async () => {
    for (const response of [new Response('{}', { headers: { 'Content-Length': '3000000' } }), new Response(' '.repeat(2 * 1024 * 1024 + 1))]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      expect(await f.catalog.discover('api')).toMatchObject({ ok: false, errorCategory: 'invalid-response', models: [] });
    }
  });
  it('returns safe network failures and bounds stalled body reads', async () => {
    const failed = fixture(vi.fn(async () => { throw new Error('SYNTHETIC_ONLY in error'); }) as typeof fetch);
    expect(await failed.catalog.discover('api')).toMatchObject({ ok: false, errorCategory: 'network' });
    // A controlled signal exercises a stalled stream's cancellation without
    // a wall-clock delay or dependence on Node's native timeout timer.
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const timed = fixture(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))) as typeof fetch);
    const timedPending = timed.catalog.discover('api');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); timeout.abort();
    expect(await timedPending).toMatchObject({ ok: false, errorCategory: 'timeout' });
    timeoutSpy.mockRestore();
  });
  it('accepts an empty successful catalog without treating any model as authorized', async () => {
    const f = fixture(vi.fn(async () => json({ data: [] })) as typeof fetch);
    expect(await f.catalog.discover('api')).toMatchObject({ ok: true, models: [] });
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'invented' }])).toThrow('最近读取');
  });
  it('requires credentials and never calls the network for missing providers or keys', async () => {
    const fetcher = vi.fn(async () => json({ data: [] }));
    const f = fixture(fetcher as typeof fetch);
    expect(await f.catalog.discover('missing')).toMatchObject({ ok: false, errorCategory: 'invalid-provider' });
    f.store.provider.hasSecret = false;
    expect(await f.catalog.discover('api')).toMatchObject({ ok: false, errorCategory: 'missing-credentials' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves existing custom aliases, suggests unique aliases, and saves one validated batch', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'old' }, { id: 'new' }, { id: 'third' }] })) as typeof fetch);
    f.store.models = [ { id: 'existing', providerId: 'api', upstreamId: 'old', alias: 'my-custom-name', displayName: 'Custom Display', wireApi: 'chat-completions', contextWindow: 100, tools: true, vision: false, enabled: false },
      { id: 'other', providerId: 'other', upstreamId: 'same', alias: 'new', displayName: 'Other', wireApi: 'responses', contextWindow: 0, tools: false, vision: false, enabled: true } ];
    const result = await f.catalog.discover('api');
    expect(result.models[0]).toMatchObject({ alias: 'my-custom-name', existingModelId: 'existing' });
    expect(result.models[1].alias).toBe('api/new');
    const added = f.catalog.addSelected('api', [{ upstreamId: 'old', alias: 'change-me' }, { upstreamId: 'new' }, { upstreamId: 'third', alias: 'chosen', tools: true }, { upstreamId: 'third' }]);
    expect(added.skipped).toEqual(['old']);
    expect(added.added.map(model => model.alias)).toEqual(['api/new', 'chosen']);
    expect(f.store.batches).toHaveLength(1);
    expect(f.store.models[0]).toMatchObject({ alias: 'my-custom-name', enabled: false });
    expect(f.catalog.addSelected('api', [{ upstreamId: 'new' }])).toEqual({ added: [], skipped: ['new'] });
    expect(f.store.batches).toHaveLength(1);
  });
  it('validates the whole selection before saving and rejects forged IDs or alias collisions', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'a' }, { id: 'b' }] })) as typeof fetch);
    await f.catalog.discover('api');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a' }, { upstreamId: 'fake' }])).toThrow('最近读取');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a', alias: 'shared' }, { upstreamId: 'b', alias: 'shared' }])).toThrow('已被使用');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a', contextWindow: -1 }])).toThrow('能力参数');
    expect(f.store.batches).toEqual([]);
    expect(f.store.models).toEqual([]);
  });
  it('imports a user-chosen name already used by another source without altering display or upstream names', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'glm-5.3', name: 'GLM 5.3' }] })) as typeof fetch);
    f.store.models = [{ id: 'other', providerId: 'other', upstreamId: 'glm-5.3', alias: 'glm-5.3', displayName: 'GLM 5.3', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true }];
    expect((await f.catalog.discover('api')).models[0].alias).toBe('api/glm-5.3');
    expect(f.catalog.addSelected('api', [{ upstreamId: 'glm-5.3', alias: 'glm-5.3' }]).added[0]).toMatchObject({ alias: 'api/glm-5.3', displayName: 'GLM 5.3', upstreamId: 'glm-5.3' });
    expect(f.store.models[0].alias).toBe('glm-5.3');
  });
  it('rejects collisions with an existing same-source qualified route before committing any batch', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'new' }, { id: 'valid' }] })) as typeof fetch);
    f.store.models = [{ id: 'old', providerId: 'api', upstreamId: 'old', alias: 'api/shared', displayName: 'Existing', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true }];
    await f.catalog.discover('api');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'valid' }, { upstreamId: 'new', alias: 'shared' }])).toThrow('同一供应商');
    expect(f.store.batches).toEqual([]);
    expect(f.store.models).toHaveLength(1);
  });
  it('suggests distinct local names when different upstream IDs sanitize to the same name', async () => {
    const f = fixture(vi.fn(async () => json({ data: [{ id: 'same model' }, { id: 'same?model' }] })) as typeof fetch);
    expect((await f.catalog.discover('api')).models.map(model => model.alias)).toEqual(['same-model', 'same-model-2']);
    expect(f.catalog.addSelected('api', [{ upstreamId: 'same model' }, { upstreamId: 'same?model' }]).added).toHaveLength(2);
  });
  it('expires and invalidates discoveries on changed config, new failed fetch, or explicit credential change', async () => {
    const fetcher = vi.fn(async () => json({ data: [{ id: 'a' }] }));
    const f = fixture(fetcher as typeof fetch);
    await f.catalog.discover('api'); f.catalog.invalidate('api');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a' }])).toThrow('目录已过期');
    await f.catalog.discover('api'); f.store.provider.baseUrl = 'https://other.test/v1';
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a' }])).toThrow('配置已变化');
    await f.catalog.discover('api'); fetcher.mockImplementation(async () => json({}, 401));
    await f.catalog.discover('api');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a' }])).toThrow();
    fetcher.mockImplementation(async () => json({ data: [{ id: 'a' }] }));
    await f.catalog.discover('api'); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'a' }])).toThrow('目录已过期');
  });
  it('keeps the main-process catalog independent of mutations to returned candidates', async () => {
    const f = fixture(); const result = await f.catalog.discover('api');
    result.models[0].upstreamId = 'forged'; result.models[0].displayName = 'Changed Renderer';
    expect(f.catalog.addSelected('api', [{ upstreamId: 'real-model' }]).added[0].displayName).toBe('real-model');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'forged' }])).toThrow('最近读取');
  });
  it('discovers declared thinking levels from upstream metadata and keeps only known levels', async () => {
    const f = fixture(vi.fn(async () => json({ data: [
      { id: 'string-levels', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium' },
      { id: 'object-levels', supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'xhigh', description: 'Deep' }], default_reasoning_level: 'low' },
      { id: 'capability-levels', capabilities: { supports: { reasoning_effort: ['minimal', 'max'] } } },
      { id: 'unknown-levels', supported_reasoning_levels: ['low', 'ultra', 'medium'], default_reasoning_level: 'ultra' },
      { id: 'no-levels' },
    ] })) as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result.models[0]).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' });
    expect(result.models[1]).toMatchObject({ reasoningEfforts: ['low', 'xhigh'], defaultReasoningEffort: 'low' });
    expect(result.models[2].reasoningEfforts).toEqual(['minimal', 'max']);
    expect(result.models[3].reasoningEfforts).toEqual(['low', 'medium']);
    expect(result.models[3]).not.toHaveProperty('defaultReasoningEffort');
    expect(result.models[4]).not.toHaveProperty('reasoningEfforts');
  });
  it('carries discovered thinking levels into saved models and honors selection overrides', async () => {
    const f = fixture(vi.fn(async () => json({ data: [
      { id: 'declared', supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'low' },
      { id: 'override', supported_reasoning_levels: ['low', 'high'] },
      { id: 'invalid-default', supported_reasoning_levels: ['low'] },
    ] })) as typeof fetch);
    await f.catalog.discover('api');
    const added = f.catalog.addSelected('api', [{ upstreamId: 'declared' }, { upstreamId: 'override', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' }]);
    expect(added.added[0]).toMatchObject({ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' });
    expect(added.added[1]).toMatchObject({ reasoningEfforts: ['high'], defaultReasoningEffort: 'high' });
    expect(f.store.batches[0][0]).toMatchObject({ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' });
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'invalid-default', defaultReasoningEffort: 'high' }])).toThrow('默认思考强度');
    expect(f.store.batches).toHaveLength(1);
  });
});

describe('Codex native model directory compatibility and immutable pagination', () => {
  const clientVersion = '0.159.0';
  const initialUrl = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`;
  function codexFixture(fetcher: typeof fetch, accountId = 'synthetic-codex-account') {
    const store = new MemoryStore();
    store.provider = { ...provider, kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex' };
    const prepareRequest = vi.fn(async (p: Provider, path: string, body: Record<string, unknown>) => prepareUpstream(p, { accessToken: 'SYNTHETIC_ONLY', ...(accountId ? { accountId } : {}) }, path, body));
    return { store, prepareRequest, catalog: new ModelCatalog(store, { prepareRequest }, { fetch: fetcher }) };
  }

  it('reproduces a missing client_version HTTP 400 and sends the fixed canonical URL and headers through a loopback fixture', async () => {
    const seen: { url: string; method: string; auth?: string; originator?: string; version?: string; userAgent?: string; account?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url!, method: req.method!, auth: req.headers.authorization, originator: String(req.headers.originator ?? ''), version: String(req.headers.version ?? ''), userAgent: req.headers['user-agent'], account: String(req.headers['chatgpt-account-id'] ?? '') });
      const requestUrl = new URL(req.url!, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      if (requestUrl.searchParams.getAll('client_version').join(',') !== clientVersion) { res.statusCode = 400; res.end(JSON.stringify({ error: 'missing client_version PRIVATE_ERROR_BODY' })); return; }
      res.end(JSON.stringify({ models: [{ slug: 'synthetic-codex-model', display_name: '目录模型', context_window: 200000 }] }));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const loopback = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const baseline = await fetch(`${loopback}/backend-api/codex/models`, { headers: { Authorization: 'Bearer SYNTHETIC_ONLY' } });
    expect(baseline.status).toBe(400); await baseline.text();
    const nativeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(initialUrl);
      const upstream = new URL(String(input));
      // Canonical public URLs are never contacted; only this local fixture is used.
      return fetch(`${loopback}${upstream.pathname}${upstream.search}`, init);
    });
    const f = codexFixture(nativeFetch as typeof fetch);
    expect(modelCatalogEndpoint(f.store.provider)).toBe(initialUrl);
    const result = await f.catalog.discover('api');
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(result.models[0]).toMatchObject({ upstreamId: 'synthetic-codex-model', displayName: '目录模型', contextWindow: 200000, wireApi: 'responses' });
    expect(seen[0].url).toBe('/backend-api/codex/models');
    expect(seen[1]).toEqual({ url: `/backend-api/codex/models?client_version=${clientVersion}`, method: 'GET', auth: 'Bearer SYNTHETIC_ONLY', originator: 'codex_cli_rs', version: clientVersion, userAgent: `ModelDock/${appVersion}`, account: 'synthetic-codex-account' });
    expect(nativeFetch).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_ONLY|PRIVATE_ERROR_BODY/);
  });

  it('parses native slugs and metadata, excludes explicitly hidden models, and keeps subscription models that are not public API models', async () => {
    const f = codexFixture(vi.fn(async () => json({ models: [
      { id: 'catalog-entry-id', slug: 'native-visible', display_name: 'Native Visible', context_window: 272000, input_modalities: ['text', 'image'], supports_parallel_tool_calls: true },
      { slug: 'hidden-flag', hidden: true }, { slug: 'hidden-native', is_hidden: true },
      { slug: 'visibility-hide', visibility: 'hide' }, { slug: 'visibility-hidden', visibility: 'hidden' }, { slug: 'visibility-none', visibility: 'none' },
      { slug: 'subscription-only', supported_in_api: false, visibility: 'list' },
      { slug: 'parallel-false', supports_parallel_tool_calls: false },
      { slug: 'explicit-tools-false', tools: false, supports_parallel_tool_calls: true },
    ] })) as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result.ok).toBe(true);
    expect(result.models.map(model => model.upstreamId)).toEqual(['native-visible', 'subscription-only', 'parallel-false', 'explicit-tools-false']);
    expect(result.models[0]).toMatchObject({ displayName: 'Native Visible', contextWindow: 272000, tools: true, vision: true, metadataSource: 'upstream', metadataDefaults: [] });
    expect(result.models[2]).toMatchObject({ tools: false, metadataDefaults: expect.arrayContaining(['tools']) });
    expect(result.models[3]).toMatchObject({ tools: false }); expect(result.models[3].metadataDefaults).not.toContain('tools');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'hidden-flag' }])).toThrow('最近读取');
    expect(f.catalog.addSelected('api', [{ upstreamId: 'subscription-only' }]).added[0].upstreamId).toBe('subscription-only');
  });

  it('accepts native model maps with missing explicit slugs and an intentionally empty visible directory', async () => {
    const mapped = codexFixture(vi.fn(async () => json({ models: {
      'mapped-native': { display_name: 'Mapped Display', context_window: 128000 },
      ignored: { slug: 'hidden-mapped', visibility: 'hide' },
    } })) as typeof fetch);
    expect((await mapped.catalog.discover('api')).models).toMatchObject([{ upstreamId: 'mapped-native', displayName: 'Mapped Display', contextWindow: 128000 }]);
    const hidden = codexFixture(vi.fn(async () => json({ models: [{ slug: 'hidden-a', hidden: true }, { slug: 'hidden-b', visibility: 'hide' }] })) as typeof fetch);
    expect(await hidden.catalog.discover('api')).toMatchObject({ ok: true, models: [] });
    expect(() => hidden.catalog.addSelected('api', [{ upstreamId: 'hidden-a' }])).toThrow('最近读取');
  });

  it('preserves the immutable version through numeric pages, cursors and explicit safe links', async () => {
    const urls: string[] = [];
    const f = codexFixture(vi.fn(async input => {
      urls.push(String(input));
      if (urls.length === 1) return json({ models: [{ slug: 'page-a' }], next_page: 2 });
      if (urls.length === 2) return json({ models: [{ slug: 'page-b' }], has_more: true, last_id: 'page-b' });
      return json({ models: [{ slug: 'page-c' }] });
    }) as typeof fetch);
    expect((await f.catalog.discover('api')).models.map(model => model.upstreamId)).toEqual(['page-a', 'page-b', 'page-c']);
    expect(urls).toEqual([initialUrl, `${initialUrl}&page=2`, `${initialUrl}&page=2&after=page-b`]);
    for (const input of urls) expect(new URL(input).searchParams.getAll('client_version')).toEqual([clientVersion]);
    let linkedFetchCount = 0;
    const linked = codexFixture(vi.fn(async () => linkedFetchCount++ === 0 ? json({ models: [{ slug: 'link-a' }], next: `?client_version=${clientVersion}&page=2` }) : json({ models: [{ slug: 'link-b' }] })) as typeof fetch);
    expect((await linked.catalog.discover('api')).models.map(model => model.upstreamId)).toEqual(['link-a', 'link-b']);
    expect(linkedFetchCount).toBe(2);
  });

  it.each([
    '?page=2', `?client_version=old-version&page=2`,
    `?client_version=${clientVersion}&client_version=${clientVersion}&page=2`,
    `?client_version=${clientVersion}&client_version=old-version&page=2`,
    `?client_version=${clientVersion}&page=2&access_token=SYNTHETIC_ONLY`,
    `https://attacker.example.test/backend-api/codex/models?client_version=${clientVersion}&page=2`,
    `/backend-api/codex/responses?client_version=${clientVersion}&page=2`,
  ])('rejects lost, duplicated, changed or unsafe Codex pagination before another credential-bearing request (%s)', async next => {
    const fetcher = vi.fn(async () => json({ models: [{ slug: 'partial-native' }], next }));
    const f = codexFixture(fetcher as typeof fetch);
    const result = await f.catalog.discover('api');
    expect(result).toMatchObject({ ok: false, errorCategory: 'invalid-response', models: [] });
    expect(fetcher).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ONLY');
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'partial-native' }])).toThrow('目录已过期');
    expect(f.store.batches).toEqual([]);
  });

  it('keeps API and Grok directories and Codex inference free of directory-only compatibility parameters', async () => {
    for (const kind of ['openai-compatible', 'grok'] as const) {
      const fetcher = vi.fn(async () => json({ data: [{ id: 'non-codex-model' }] }));
      const f = fixture(fetcher as typeof fetch);
      f.store.provider = kind === 'grok' ? { ...provider, kind, presetId: 'grok-build', baseUrl: 'https://api.x.ai/v1' } : { ...provider };
      expect((await f.catalog.discover('api')).ok).toBe(true);
      const [input, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(input).toBe(`${f.store.provider.baseUrl}/models`);
      expect(new URL(input).searchParams.has('client_version')).toBe(false);
      expect(new Headers(init.headers).get('version')).toBeNull();
      expect(new Headers(init.headers).get('Originator')).not.toBe('codex_cli_rs');
      expect(modelCatalogEndpoint(f.store.provider)).toBe(input);
    }
    const f = codexFixture(vi.fn() as typeof fetch, '');
    const inference = prepareUpstream(f.store.provider, { accessToken: 'SYNTHETIC_ONLY' }, '/responses', { input: 'synthetic input' });
    expect(inference.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(new URL(inference.url).searchParams.has('client_version')).toBe(false);
    const withoutAccount = prepareUpstream(f.store.provider, { accessToken: 'SYNTHETIC_ONLY' }, '/models', {});
    expect(withoutAccount.url).toBe(initialUrl); expect(withoutAccount.headers['ChatGPT-Account-Id']).toBeUndefined();
  });

  it('invalidates the previous successful Codex directory after HTTP 400 and never imports stale or partial entries', async () => {
    const fetcher = vi.fn(async () => json({ models: [{ slug: 'old-native' }] }));
    const f = codexFixture(fetcher as typeof fetch);
    expect((await f.catalog.discover('api')).ok).toBe(true);
    fetcher.mockImplementation(async () => json({ error: 'PRIVATE_ERROR_BODY SYNTHETIC_ONLY' }, 400));
    const failed = await f.catalog.discover('api');
    expect(failed).toMatchObject({ ok: false, statusCode: 400, models: [] });
    expect(JSON.stringify(failed)).not.toMatch(/PRIVATE_ERROR_BODY|SYNTHETIC_ONLY/);
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'old-native' }])).toThrow('目录已过期');
    fetcher.mockImplementation(async () => json({ models: [{ slug: 'new-native' }] }));
    expect((await f.catalog.discover('api')).models.map(model => model.upstreamId)).toEqual(['new-native']);
    expect(() => f.catalog.addSelected('api', [{ upstreamId: 'old-native' }])).toThrow('最近读取');
    expect(f.catalog.addSelected('api', [{ upstreamId: 'new-native' }]).added[0].upstreamId).toBe('new-native');
  });
});
