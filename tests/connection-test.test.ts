import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ConnectionTester, type ConnectionStore } from '../src/main/connection-test';
import { OAuthManager, prepareUpstream, type OAuthStore, type PreparedUpstream } from '../src/main/oauth';
import type { Model, Provider, ProviderSecret } from '../src/shared/types';
import { firstConnectionModel } from '../src/shared/connection-types';
import { anthropicBaseUrl, anthropicEndpoint } from '../src/main/anthropic-endpoint';

const provider: Provider = { id: 'api', name: 'Test Plan', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://api.example.test/coding/v3', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
const saved: Model = { id: 'saved', providerId: 'api', upstreamId: 'actual-model', alias: 'local-name', displayName: 'Model', wireApi: 'chat-completions', contextWindow: 0, tools: true, vision: false, enabled: true };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const chat = (text = 'PRIVATE_GENERATION') => ({ id: 'completion', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const nativeResponse = (status = 'completed', output: unknown[] = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_GENERATION' }] }]) => ({ id: 'resp_test', object: 'response', status, output });
const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

class MemoryStore implements ConnectionStore, OAuthStore {
  provider = { ...provider };
  models: Model[] = [{ ...saved }];
  secret: ProviderSecret = { apiKey: 'SYNTHETIC_ONLY' };
  getProvider(id: string) { return id === this.provider.id ? { ...this.provider } : undefined; }
  listModels() { return this.models.map(model => ({ ...model })); }
  getSecret() { return { ...this.secret }; }
  setSecret(_id: string, value: ProviderSecret) { this.secret = { ...value }; }
  setAuthStatus(_id: string, value: Provider['authStatus']) { this.provider.authStatus = value; }
}
function fixture(fetcher: typeof fetch = vi.fn(async () => json(chat())) as typeof fetch) {
  const store = new MemoryStore();
  const prepareRequest = vi.fn(async (p: Provider, route: string, body: Record<string, unknown>) => prepareUpstream(p, store.secret, route, body));
  return { store, prepareRequest, tester: new ConnectionTester(store, { prepareRequest }, { fetch: fetcher }) };
}
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

const nativeMessage = (stopReason = 'end_turn', content: unknown[] = [{ type: 'text', text: 'PRIVATE_GENERATION' }], outputTokens = 2) => ({
  id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason: stopReason,
  stop_sequence: null, usage: { input_tokens: 3, output_tokens: outputTokens },
});
const messageEvents = (stopReason = 'end_turn') => [
  { type: 'message_start', message: { ...nativeMessage(), content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE_GENERATION' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];
const messageStream = (events: unknown[]) => events.map(value => {
  const event = value as { type: string };
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}).join('');

describe('Anthropic Messages inference uses its native contract', () => {
  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/v1/', 'https://api.anthropic.com'],
    ['https://gateway.example.test/anthropic', 'https://gateway.example.test/anthropic'],
    ['https://gateway.example.test/anthropic/v1', 'https://gateway.example.test/anthropic'],
  ])('normalizes the API base %s without losing a custom prefix', (input, base) => {
    expect(anthropicBaseUrl(input)).toBe(base);
    expect(anthropicEndpoint(input, '/messages')).toBe(`${base}/v1/messages`);
  });
  it.each(['http://remote.example.test', 'https://user:secret@gateway.example.test', 'https://gateway.example.test?key=secret', 'https://gateway.example.test/#fragment'])('rejects unsafe base %s', base => {
    expect(() => anthropicEndpoint(base, '/messages')).toThrow();
  });
  it.each(['api-key', 'bearer'] as const)('sends only the selected %s auth header to a native upstream and records only usage/shape diagnostics', async messagesAuth => {
    const seen: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        seen.push({ route: req.url, method: req.method, key: req.headers['x-api-key'], auth: req.headers.authorization, version: req.headers['anthropic-version'], body: JSON.parse(raw) });
        const valid = messagesAuth === 'api-key' ? req.headers['x-api-key'] === 'SYNTHETIC_ONLY' && !req.headers.authorization
          : req.headers.authorization === 'Bearer SYNTHETIC_ONLY' && !req.headers['x-api-key'];
        if (!valid) { res.statusCode = 401; res.end('{}'); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(nativeMessage()));
      });
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic/v1`;
    f.store.provider.messagesAuth = messagesAuth;
    f.store.models[0].wireApi = 'messages';
    const diagnostics = vi.fn();
    const tester = new ConnectionTester(f.store, { prepareRequest: f.prepareRequest }, { fetch, diagnostics });
    const result = await tester.test('api');
    expect(result).toMatchObject({ ok: true, wireApi: 'messages', testedModel: 'actual-model', statusCode: 200 });
    expect(seen).toEqual([{ route: '/anthropic/v1/messages', method: 'POST', key: messagesAuth === 'api-key' ? 'SYNTHETIC_ONLY' : undefined, auth: messagesAuth === 'bearer' ? 'Bearer SYNTHETIC_ONLY' : undefined, version: '2023-06-01',
      body: { model: 'actual-model', messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, max_tokens: 16 } }]);
    expect(diagnostics).toHaveBeenCalledWith('info', 'connection.response', expect.objectContaining({ wireApi: 'messages', outputItems: 1, outputTokens: 2, hasOutputText: true }));
    expect(JSON.stringify([result, diagnostics.mock.calls])).not.toMatch(/PRIVATE_GENERATION|SYNTHETIC_ONLY|Reply OK/);
  });
  it.each(['end_turn', 'max_tokens'])('validates actual native stream events and %s completion (local mock upstream)', async stopReason => {
    const server = createServer((req, res) => {
      expect(req.url).toBe('/anthropic/v1/messages'); expect(req.headers['anthropic-version']).toBe('2023-06-01');
      res.setHeader('Content-Type', 'text/event-stream'); res.end(messageStream(messageEvents(stopReason)));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic`;
    const result = await f.tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' });
    expect(result).toMatchObject({ ok: true, wireApi: 'messages' });
    expect(result.message).toContain(stopReason === 'max_tokens' ? '输出上限' : '成功完成');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_GENERATION');
  });
  it('supports Anthropic API Key authentication without requiring a Bearer header and rejects missing API version', async () => {
    const fetcher = vi.fn(async () => json(nativeMessage())); const f = fixture(fetcher as typeof fetch);
    f.store.provider.messagesAuth = 'api-key';
    f.prepareRequest.mockImplementation(async (p, route, body) => ({ ...prepareUpstream(p, f.store.secret, route, body), headers: { 'x-api-key': 'SYNTHETIC_ONLY', 'anthropic-version': '2023-06-01' } }));
    expect(await f.tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' })).toMatchObject({ ok: true });
    f.prepareRequest.mockImplementation(async (p, route, body) => ({ ...prepareUpstream(p, f.store.secret, route, body), headers: { 'x-api-key': 'SYNTHETIC_ONLY' } }));
    expect(await f.tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' })).toMatchObject({ ok: false, outcome: 'configuration' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['api-key', 'bearer'] as const)('refuses opposite or extra credential headers for configured %s auth before sending a key', async messagesAuth => {
    const fetcher = vi.fn(async () => json(nativeMessage())); const f = fixture(fetcher as typeof fetch);
    f.store.provider.messagesAuth = messagesAuth;
    for (const headers of [
      { 'anthropic-version': '2023-06-01', ...(messagesAuth === 'api-key' ? { Authorization: 'Bearer SYNTHETIC_ONLY' } : { 'x-api-key': 'SYNTHETIC_ONLY' }) },
      { 'anthropic-version': '2023-06-01', Authorization: 'Bearer SYNTHETIC_ONLY', 'x-api-key': 'SYNTHETIC_ONLY' },
    ] as Record<string, string>[]) {
      f.prepareRequest.mockImplementation(async (p, route, body) => ({ ...prepareUpstream(p, f.store.secret, route, body), headers }));
      expect(await f.tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' })).toMatchObject({ ok: false, outcome: 'configuration' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports genuine JSON output truncation and reasoning usage without claiming a final answer', async () => {
    for (const response of [nativeMessage('max_tokens', [], 16), nativeMessage('max_tokens', [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }], 0)]) {
      const result = await fixture(vi.fn(async () => json(response)) as typeof fetch).tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' });
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
    }
  });
  it('does not accept Chat/Responses/model-list payloads or unfinished Messages as native inference', async () => {
    const responses = [json(chat()), json(nativeResponse()), json({ data: [{ id: 'claude-test' }] }), json({ ...nativeMessage(), role: 'user' }),
      json({ ...nativeMessage(), stop_reason: null }), json(nativeMessage('max_tokens', [], 0)),
      new Response(messageStream(messageEvents().slice(0, -1)), { headers: { 'Content-Type': 'text/event-stream' } }),
      new Response(messageStream([{ type: 'message_stop' }]), { headers: { 'Content-Type': 'text/event-stream' } }),
      new Response(messageStream([messageEvents()[0], messageEvents()[2], messageEvents()[4], messageEvents()[5]]), { headers: { 'Content-Type': 'text/event-stream' } }),
    ];
    for (const response of responses) expect(await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' })).toMatchObject({ ok: false, outcome: 'invalid-response' });
  });
  it('rejects JSON and late native SSE errors and never returns upstream error bodies', async () => {
    const responses = [json({ type: 'error', error: { type: 'overloaded_error', message: 'PRIVATE_ERROR_BODY SYNTHETIC_ONLY' } }),
      json({ ...nativeMessage(), stop_details: { type: 'refusal', explanation: 'PRIVATE_ERROR_BODY' } }),
      new Response(messageStream([...messageEvents(), { type: 'error', error: { type: 'overloaded_error', message: 'PRIVATE_ERROR_BODY' } }]), { headers: { 'Content-Type': 'text/event-stream' } }),
    ];
    for (const response of responses) {
      const result = await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' });
      expect(result).toMatchObject({ ok: false, outcome: 'upstream' }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ERROR_BODY|SYNTHETIC_ONLY/);
    }
  });
  it('aborts a stalled native upstream stream at the test deadline (local mock upstream)', async () => {
    let started!: () => void, closed!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const closedPromise = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer((req, res) => {
      expect(req.url).toBe('/v1/messages');
      res.on('close', closed); res.setHeader('Content-Type', 'text/event-stream');
      res.write(messageStream([messageEvents()[0]])); started();
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const pending = f.tester.test('api', { upstreamId: 'claude-test', wireApi: 'messages' });
    await startedPromise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ ok: false, outcome: 'timeout', wireApi: 'messages' });
    vi.useRealTimers();
    await closedPromise;
  });
});

describe('connection testing sends one actual inference request without model directory access', () => {
  it('works against a local plan that does not provide /models and sends the actual authenticated chat route', async () => {
    const calls: { route: string; method: string; auth?: string; body: unknown }[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.on('data', data => { body += data; });
      req.on('end', () => {
        calls.push({ route: req.url!, method: req.method!, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.endsWith('/models')) { res.statusCode = 404; res.end('{}'); }
        else res.end(JSON.stringify(chat()));
      });
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/coding/v3`;
    const result = await f.tester.test('api', { modelId: 'saved' });
    expect(result).toMatchObject({ ok: true, outcome: 'success', testedModel: 'actual-model', wireApi: 'chat-completions', statusCode: 200 });
    expect(calls).toEqual([{ route: '/coding/v3/chat/completions', method: 'POST', auth: 'Bearer SYNTHETIC_ONLY', body: { model: 'actual-model', messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, max_tokens: 16 } }]);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_ONLY|PRIVATE_GENERATION|Reply OK/);
  });
  it('uses manual model ID and chosen Responses without requiring discovery or saved model entries', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'plan-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }], stream: false, store: false, max_output_tokens: 64 });
      return json(nativeResponse());
    });
    const f = fixture(fetcher as typeof fetch); f.store.models = [];
    expect(await f.tester.test('api', { upstreamId: 'plan-model', wireApi: 'responses' })).toMatchObject({ ok: true, testedModel: 'plan-model', wireApi: 'responses' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/coding/v3/responses');
  });
  it('tests a saved Responses model against a plan without /models and recognizes Ark reasoning content', async () => {
    const calls: { route: string; method: string; body: unknown }[] = [];
    const server = createServer((req, res) => {
      let body = ''; req.on('data', data => { body += data; });
      req.on('end', () => {
        calls.push({ route: req.url!, method: req.method!, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.endsWith('/models')) { res.statusCode = 404; res.end('{}'); }
        else res.end(JSON.stringify({ ...nativeResponse('incomplete', [{ type: 'reasoning', status: 'incomplete', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }]), incomplete_details: { reason: 'max_output_tokens' } }));
      });
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/plan/v3`;
    f.store.models[0].wireApi = 'responses';
    const result = await f.tester.test('api');
    expect(result).toMatchObject({ ok: true, outcome: 'success', testedModel: 'actual-model', wireApi: 'responses', statusCode: 200, message: expect.stringContaining('输出上限') });
    expect(calls).toEqual([{ route: '/plan/v3/responses', method: 'POST', body: { model: 'actual-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }], stream: false, store: false, max_output_tokens: 64 } }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
  });
  it('trusts saved upstream ID/protocol over contradictory manual fields, and permits explicitly testing disabled entries', async () => {
    const fetcher = vi.fn(async (_url, init) => { expect(JSON.parse(String(init?.body)).model).toBe('actual-model'); return json(chat()); });
    const f = fixture(fetcher as typeof fetch); f.store.provider.enabled = false; f.store.models[0].enabled = false;
    expect(await f.tester.test('api', { modelId: 'saved', upstreamId: 'forged-model', wireApi: 'responses' })).toMatchObject({ ok: true, testedModel: 'actual-model', wireApi: 'chat-completions' });
    expect(f.store.models[0].enabled).toBe(false); expect(f.store.provider.enabled).toBe(false);
  });
  it('requires a model, validates saved-model ownership, and never invents a default or touches the network', async () => {
    const fetcher = vi.fn(async () => json(chat())); const f = fixture(fetcher as typeof fetch);
    f.store.models = [];
    expect(await f.tester.test('api')).toMatchObject({ ok: false, outcome: 'model-required' });
    expect(await f.tester.test('api', { upstreamId: '\ninvalid' })).toMatchObject({ ok: false, outcome: 'model-required' });
    expect(await f.tester.test('api', { modelId: 'expired' })).toMatchObject({ ok: false, outcome: 'model' });
    f.store.models = [{ ...saved }];
    f.store.models[0].providerId = 'other';
    expect(await f.tester.test('api', { modelId: 'saved', upstreamId: 'fallback' })).toMatchObject({ ok: false, outcome: 'model' });
    expect(fetcher).not.toHaveBeenCalled(); expect(f.prepareRequest).not.toHaveBeenCalled();
  });
  it('defaults to the first saved supplier model in list order, even when disabled and followed by an enabled model', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).model).toBe('first-disabled');
      return json(nativeResponse());
    }); const f = fixture(fetcher as typeof fetch);
    f.store.models = [
      { ...saved, id: 'other-source', providerId: 'other', upstreamId: 'other-first' },
      { ...saved, id: 'first', upstreamId: 'first-disabled', wireApi: 'responses', enabled: false },
      { ...saved, id: 'second', upstreamId: 'second-enabled', enabled: true },
    ];
    expect(firstConnectionModel('api', f.store.models)?.id).toBe('first');
    for (const input of [undefined, {}]) {
      expect(await f.tester.test('api', input)).toMatchObject({ ok: true, testedModel: 'first-disabled', wireApi: 'responses' });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => String(call[0]).endsWith('/responses'))).toBe(true);
    expect(f.store.models[1].enabled).toBe(false);
  });
  it('does not use another supplier model when the selected source has no models and sends no directory or inference requests', async () => {
    const fetcher = vi.fn(async () => json(chat())); const f = fixture(fetcher as typeof fetch);
    f.store.models = [{ ...saved, providerId: 'other' }];
    expect(firstConnectionModel('api', f.store.models)).toBeUndefined();
    for (const input of [undefined, {}]) expect(await f.tester.test('api', input)).toMatchObject({ ok: false, outcome: 'model-required' });
    expect(fetcher).not.toHaveBeenCalled(); expect(f.prepareRequest).not.toHaveBeenCalled();
  });
  it('checks missing provider/key and invalid address/protocol before OAuth or HTTP', async () => {
    const fetcher = vi.fn(async () => json(chat())); const f = fixture(fetcher as typeof fetch);
    expect(await f.tester.test('missing', { modelId: 'saved' })).toMatchObject({ outcome: 'configuration' });
    f.store.provider.hasSecret = false;
    expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ outcome: 'configuration', message: expect.stringContaining('API Key') });
    f.store.provider.hasSecret = true;
    for (const address of ['', 'http://api.example.test', 'https://api.example.test?key=SYNTHETIC_ONLY', 'https://user:pass@api.example.test']) {
      f.store.provider.baseUrl = address;
      expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ outcome: 'configuration' });
    }
    f.store.provider.baseUrl = provider.baseUrl;
    expect(await f.tester.test('api', { upstreamId: 'real', wireApi: 'fake' as never })).toMatchObject({ outcome: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled(); expect(f.prepareRequest).not.toHaveBeenCalled();
  });
  it('reuses Codex compatibility preparation and forces subscriptions to native Responses', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'codex-model', stream: true, store: false, instructions: '' });
      expect(body).not.toHaveProperty('max_output_tokens');
      expect(new Headers(init?.headers).get('ChatGPT-Account-Id')).toBe('synthetic-account');
      expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
      return sse({ type: 'response.completed', response: nativeResponse() }, '[DONE]');
    });
    const f = fixture(fetcher as typeof fetch);
    f.store.provider = { ...provider, kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex' };
    f.store.secret = { accessToken: 'SYNTHETIC_ONLY', accountId: 'synthetic-account' };
    expect(await f.tester.test('api', { upstreamId: 'codex-model', wireApi: 'chat-completions' })).toMatchObject({ ok: true, wireApi: 'responses' });
    expect(fetcher.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses');
  });
  it('reuses expired subscription refresh before inference (synthetic token endpoints only)', async () => {
    const store = new MemoryStore(); store.provider = { ...provider, kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex' }; store.secret = { accessToken: 'EXPIRED_SYNTHETIC', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() - 1 };
    const oauthFetch = vi.fn(async () => json({ access_token: 'ROTATED_SYNTHETIC', refresh_token: 'ROTATED_REFRESH', expires_in: 3600 }));
    const oauth = new OAuthManager(store, { openExternal: async () => {}, fetch: oauthFetch as typeof fetch });
    const inference = vi.fn(async (_url, init) => { expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ROTATED_SYNTHETIC'); return sse({ type: 'response.completed', response: nativeResponse() }); });
    const tester = new ConnectionTester(store, oauth, { fetch: inference as typeof fetch });
    expect(await tester.test('api', { upstreamId: 'codex-model' })).toMatchObject({ ok: true });
    expect(oauthFetch).toHaveBeenCalledTimes(1); expect(inference).toHaveBeenCalledTimes(1); oauth.dispose();
  });
  it('preserves Grok required native request headers without requesting its model directory', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('x-xai-token-auth')).toBe('xai-grok-cli');
      expect(JSON.parse(String(init?.body)).stream).toBe(true);
      return sse({ type: 'response.completed', response: nativeResponse() });
    }); const f = fixture(fetcher as typeof fetch);
    f.store.provider = { ...provider, kind: 'grok', baseUrl: 'https://cli-chat-proxy.grok.com/v1' }; f.store.secret = { accessToken: 'SYNTHETIC_ONLY' };
    expect(await f.tester.test('api', { upstreamId: 'grok-model' })).toMatchObject({ ok: true });
    expect(fetcher.mock.calls[0][0]).toBe('https://cli-chat-proxy.grok.com/v1/responses');
  });
  it.each(['chat-completions', 'responses'] as const)('uses a saved Copilot %s model and official account endpoint without forcing the other protocol', async wireApi => {
    const route = wireApi === 'responses' ? '/responses' : '/chat/completions';
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`https://api.individual.githubcopilot.com${route}`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('actual-model');
      expect(wireApi === 'responses' ? body.input : body.messages).toHaveLength(1);
      expect(new Headers(init?.headers).get('Copilot-Integration-Id')).toBe('code-oss');
      return json(wireApi === 'responses' ? nativeResponse() : chat());
    });
    const f = fixture(fetcher as typeof fetch);
    f.store.provider = { ...provider, kind: 'copilot', baseUrl: 'https://api.githubcopilot.com' };
    f.store.models[0].wireApi = wireApi;
    f.prepareRequest.mockImplementation(async (_provider, path, body) => ({
      url: `https://api.individual.githubcopilot.com${path}`,
      headers: { Authorization: 'Bearer SYNTHETIC_ONLY', 'Content-Type': 'application/json', 'Copilot-Integration-Id': 'code-oss',
        'Editor-Version': 'vscode/1.110.1', 'Editor-Plugin-Version': 'copilot-chat/0.38.2', 'X-GitHub-Api-Version': '2026-08-01', 'X-Request-Id': 'synthetic-request' },
      body,
    }));
    const result = await f.tester.test('api', { modelId: 'saved' });
    expect(result).toMatchObject({ ok: true, testedModel: 'actual-model', wireApi, statusCode: 200 });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(f.prepareRequest.mock.calls[0][1]).toBe(route);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ONLY');
  });
  it('rejects a Copilot prepared address outside the official inference domain or selected route before sending credentials', async () => {
    for (const url of [
      'https://api.githubcopilot.com.evil.test/chat/completions', 'https://evil.test/chat/completions', 'http://api.githubcopilot.com/chat/completions',
      'https://user:pass@api.githubcopilot.com/chat/completions', 'https://api.githubcopilot.com:444/chat/completions',
      'https://api.githubcopilot.com/chat/completions?key=SYNTHETIC_ONLY', 'https://api.githubcopilot.com/chat/completions#secret',
      'https://api.githubcopilot.com/models', 'https://api.githubcopilot.com/responses',
    ]) {
      const fetcher = vi.fn(async () => json(chat())); const f = fixture(fetcher as typeof fetch);
      f.store.provider = { ...provider, kind: 'copilot', baseUrl: 'https://api.githubcopilot.com' };
      f.prepareRequest.mockImplementation(async (_provider, _path, body) => ({ url, headers: { Authorization: 'Bearer SYNTHETIC_ONLY' }, body }));
      const result = await f.tester.test('api', { modelId: 'saved' });
      expect(result).toMatchObject({ ok: false, outcome: 'configuration' }); expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ONLY');
    }
  });
  it('rejects Copilot redirected or mismatched response addresses even when they contain valid inference JSON', async () => {
    for (const value of [
      { url: 'https://evil.test/chat/completions', redirected: false },
      { url: 'https://api.githubcopilot.com.evil.test/chat/completions', redirected: false },
      { url: 'https://api.githubcopilot.com/models', redirected: false },
      { url: 'https://api.githubcopilot.com/chat/completions?key=SYNTHETIC_ONLY', redirected: false },
      { url: 'https://api.githubcopilot.com/chat/completions', redirected: true },
    ]) {
      const response = json(chat()); Object.defineProperties(response, { url: { value: value.url }, redirected: { value: value.redirected } });
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      f.store.provider = { ...provider, kind: 'copilot', baseUrl: 'https://api.githubcopilot.com' };
      f.prepareRequest.mockImplementation(async (_provider, path, body) => ({ url: `https://api.githubcopilot.com${path}`, headers: { Authorization: 'Bearer SYNTHETIC_ONLY' }, body }));
      const result = await f.tester.test('api', { modelId: 'saved' });
      expect(result).toMatchObject({ ok: false, outcome: 'configuration' }); expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ONLY');
    }
  });
  it.each([[400, 'model'], [401, 'authentication'], [402, 'permission'], [403, 'permission'], [404, 'model'], [405, 'model'], [422, 'model'], [426, 'upstream'], [429, 'rate-limit'], [503, 'upstream']] as const)('reports HTTP %s safely and never retries inference or a model-directory route', async (status, outcome) => {
    const fetcher = vi.fn(async () => json({ error: { message: 'SYNTHETIC_ONLY PRIVATE_ERROR_BODY' } }, status)); const f = fixture(fetcher as typeof fetch);
    const result = await f.tester.test('api', { modelId: 'saved' });
    expect(result).toMatchObject({ ok: false, outcome, statusCode: status }); expect(result.message).toContain(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ERROR_BODY|SYNTHETIC_ONLY/);
  });
  it('rejects 200 HTML, malformed/empty JSON, model-directory payloads and empty assistant outputs', async () => {
    for (const response of [new Response('<html>PRIVATE_ERROR_BODY</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('not JSON'), json({ data: [{ id: 'model' }] }), json(chat('')), json({ choices: [{ message: { role: 'user', content: 'hello' } }] }), json({ status: 'completed' })]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ ok: false, outcome: 'invalid-response' });
    }
  });
  it('rejects HTTP 200 error payloads, failed Responses JSON and SSE error events including errors after output', async () => {
    const responses = [json({ error: { message: 'PRIVATE_ERROR_BODY' } }), json(nativeResponse('failed')), sse({ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.failed', response: { status: 'failed', error: { message: 'PRIVATE_ERROR_BODY' } } }), new Response('event: error\ndata: {"message":"PRIVATE_ERROR_BODY"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })];
    for (const response of responses) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      const result = await f.tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
      expect(result).toMatchObject({ ok: false, outcome: 'upstream' }); expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR_BODY');
    }
  });
  it('requires terminal native stream events and actual Chat stream output rather than DONE alone', async () => {
    const cases = [
      { response: sse({ type: 'response.output_text.delta', delta: 'OK' }), wireApi: 'responses' as const },
      { response: sse({ type: 'response.completed' }), wireApi: 'responses' as const },
      { response: sse('[DONE]'), wireApi: 'chat-completions' as const },
      { response: sse({ choices: [{ delta: { content: 'OK' } }] }), wireApi: 'chat-completions' as const },
      { response: sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }), wireApi: 'responses' as const },
    ];
    for (const item of cases) {
      const f = fixture(vi.fn(async () => item.response) as typeof fetch);
      expect(await f.tester.test('api', { upstreamId: 'test', wireApi: item.wireApi })).toMatchObject({ ok: false, outcome: 'invalid-response' });
    }
    const f = fixture(vi.fn(async () => sse({ choices: [{ delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]')) as typeof fetch);
    expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ ok: true });
  });
  it('accepts actual output truncated by the tiny limit with a warning, but refuses other incomplete responses', async () => {
    const limited = { ...nativeResponse('incomplete'), incomplete_details: { reason: 'max_output_tokens' } };
    for (const response of [json(limited), sse({ type: 'response.incomplete', response: limited })]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      expect(await f.tester.test('api', { upstreamId: 'native', wireApi: 'responses' })).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
    }
    const chatLimited = chat(); chatLimited.choices[0].finish_reason = 'length';
    expect(await fixture(vi.fn(async () => json(chatLimited)) as typeof fetch).tester.test('api', { modelId: 'saved' })).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
    const f = fixture(vi.fn(async () => json({ ...nativeResponse('incomplete'), incomplete_details: { reason: 'content_filter' } })) as typeof fetch);
    expect(await f.tester.test('api', { upstreamId: 'native', wireApi: 'responses' })).toMatchObject({ ok: false });
  });
  it('recognizes genuine reasoning-only output budget exhaustion without claiming a completed answer', async () => {
    for (const output of [
      { ...nativeResponse('incomplete', []), usage: { input_tokens: 8, output_tokens: 64 } },
      nativeResponse('incomplete', [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE_REASONING' }] }]),
    ]) {
      const limited = { ...output, incomplete_details: { reason: 'max_output_tokens' } };
      for (const response of [json(limited), sse({ type: 'response.incomplete', response: limited })]) {
        const f = fixture(vi.fn(async () => response) as typeof fetch);
        const result = await f.tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
        expect(result).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
        expect(result.message).not.toContain('成功完成'); expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
      }
    }
  });
  it('recognizes Ark typed reasoning content in JSON and terminal streams without treating it as a final answer', async () => {
    for (const item of [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] },
    ]) {
      const limited = { ...nativeResponse('incomplete', [item]), incomplete_details: { reason: 'max_output_tokens' } };
      for (const response of [json(limited), sse({ type: 'response.incomplete', response: limited }), sse({ type: 'response.completed', response: limited })]) {
        const result = await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
        expect(result).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
        expect(result.message).not.toContain('成功完成'); expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
      }
    }
  });
  it('recognizes omitted truncation reason only when a complete response reaches the actual request budget', async () => {
    for (const incomplete_details of [undefined, null, {}, { reason: null }, { reason: '' }]) {
      const limited = { ...nativeResponse('incomplete', []), incomplete_details, usage: { output_tokens: 64 } };
      for (const response of [json(limited), sse({ type: 'response.incomplete', response: limited }), sse({ type: 'response.completed', response: limited })]) {
        const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response);
        const result = await fixture(fetcher as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
        expect(result).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/coding/v3/responses');
      }
    }
    for (const outputTokens of [31, 32]) {
      const f = fixture(vi.fn(async () => json({ ...nativeResponse('incomplete', []), usage: { output_tokens: outputTokens } })) as typeof fetch);
      f.prepareRequest.mockImplementation(async (p, route, body) => prepareUpstream(p, f.store.secret, route, { ...body, max_output_tokens: 32 }));
      expect((await f.tester.test('api', { upstreamId: 'native', wireApi: 'responses' })).ok).toBe(outputTokens === 32);
    }
    const subscription = fixture(vi.fn(async () => sse({ type: 'response.incomplete', response: { ...nativeResponse('incomplete', []), usage: { output_tokens: 64 } } })) as typeof fetch);
    subscription.store.provider = { ...provider, kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex' };
    subscription.store.secret = { accessToken: 'SYNTHETIC_ONLY' };
    expect(await subscription.tester.test('api', { upstreamId: 'native' })).toMatchObject({ ok: false, outcome: 'invalid-response' });
  });
  it('does not infer budget exhaustion from arbitrary JSON, insufficient usage, unknown causes or untyped text', async () => {
    const envelope = { ...nativeResponse('incomplete', []), usage: { output_tokens: 64 } };
    const invalid = [
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 64 } },
      { ...envelope, object: 'list' }, { ...envelope, id: '' }, { ...envelope, id: '   ' }, { ...envelope, output: undefined },
      ...[undefined, 0, 1, 63, -1, 63.5, '64'].map(output_tokens => ({ ...envelope, usage: { output_tokens } })),
      ...['content_filter', 'upstream_error', 'max_tokens', 'length', 'unknown'].map(reason => ({ ...envelope, incomplete_details: { reason } })),
      { ...nativeResponse('incomplete', [{ type: 'reasoning', content: [{ text: 'PRIVATE_REASONING' }] }]), incomplete_details: { reason: 'max_output_tokens' } },
      { ...nativeResponse('incomplete', [{ type: 'unknown', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }]), incomplete_details: { reason: 'max_output_tokens' } },
      { ...nativeResponse('incomplete', [{ type: 'message', role: 'user', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }]), incomplete_details: { reason: 'max_output_tokens' } },
    ];
    for (const payload of invalid) {
      for (const response of [json(payload), sse({ type: 'response.incomplete', response: payload })]) {
        const result = await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
        expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
      }
    }
  });
  it('rejects filter and failed results even with enough usage or valid reasoning', async () => {
    const envelope = { ...nativeResponse('incomplete', [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }]), usage: { output_tokens: 64 } };
    for (const payload of [
      { ...envelope, incomplete_details: { reason: 'content_filter' } },
      { ...envelope, incomplete_details: { reason: 'max_output_tokens', content_filter: { type: 'safety' } } },
      { ...envelope, incomplete_details: { content_filter: { type: 'safety' } } },
      { ...envelope, status: 'failed' },
      { ...envelope, error: { message: 'PRIVATE_ERROR_BODY' } },
      { ...envelope, output: [{ type: 'reasoning', status: 'failed', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }] },
    ]) {
      for (const response of [json(payload), sse({ type: 'response.incomplete', response: payload })]) {
        const result = await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
        expect(result).toMatchObject({ ok: false, outcome: 'upstream' });
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_REASONING|PRIVATE_ERROR_BODY/);
      }
    }
  });
  it('requires inference evidence in completed Responses and distinguishes processing from a final answer', async () => {
    for (const payload of [nativeResponse('completed', []), { status: 'completed', usage: { output_tokens: 64 } }, { ...nativeResponse(), id: undefined }]) {
      for (const response of [json(payload), sse({ type: 'response.completed', response: payload })]) {
        expect(await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' })).toMatchObject({ ok: false, outcome: 'invalid-response' });
      }
    }
    for (const payload of [
      nativeResponse('completed', [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }]),
      { ...nativeResponse('completed', []), usage: { output_tokens: 4 } },
    ]) {
      for (const response of [json(payload), sse({ type: 'response.completed', response: payload })]) {
        const result = await fixture(vi.fn(async () => response) as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
        expect(result).toMatchObject({ ok: true, message: expect.stringContaining('未返回最终回答') });
        expect(result.message).not.toMatch(/成功完成|输出上限/); expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
      }
    }
    const stream = sse({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_REASONING' }, { type: 'response.completed', response: nativeResponse('completed', []) });
    const result = await fixture(vi.fn(async () => stream) as typeof fetch).tester.test('api', { upstreamId: 'native', wireApi: 'responses' });
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('未返回最终回答') });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
  });
  it('accepts length-truncated Chat reasoning or positive completion usage without falsely claiming a completed answer', async () => {
    const partial = { id: 'chat_partial', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'PRIVATE_REASONING' }, finish_reason: 'length' }] };
    const counted = { ...partial, choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 8, completion_tokens: 16 } };
    const streamed = sse({ choices: [{ delta: { role: 'assistant', reasoning_content: 'PRIVATE_REASONING' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }, '[DONE]');
    const streamedCounted = sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'length' }] }, { choices: [], usage: { completion_tokens: 16 } }, '[DONE]');
    for (const response of [json(partial), json(counted), streamed, streamedCounted]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      const result = await f.tester.test('api', { modelId: 'saved' });
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
      expect(result.message).not.toContain('成功完成'); expect(JSON.stringify(result)).not.toContain('PRIVATE_REASONING');
    }
  });
  it('rejects empty length-truncated Chat responses without reasoning or positive output usage evidence', async () => {
    for (const response of [
      json({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 0 } }),
      sse({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: 'length' }] }, '[DONE]'),
      json({ choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'reasoning' }, finish_reason: 'stop' }] }),
      sse({ choices: [{ delta: { role: 'assistant', reasoning_content: 'reasoning' }, finish_reason: 'stop' }] }, '[DONE]'),
    ]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ ok: false, outcome: 'invalid-response' });
    }
  });
  it('rejects redirected URLs and unapproved prepared endpoints/headers before forwarding secrets', async () => {
    const fetcher = vi.fn(async () => json(chat())); const f = fixture(fetcher as typeof fetch);
    f.prepareRequest.mockImplementation(async (p, path, body) => ({ ...prepareUpstream(p, f.store.secret, path, body), url: 'https://attacker.test/chat/completions' }));
    expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ outcome: 'configuration' }); expect(fetcher).not.toHaveBeenCalled();
    f.prepareRequest.mockImplementation(async (p, path, body) => ({ ...prepareUpstream(p, f.store.secret, path, body), headers: { Authorization: 'Bearer SYNTHETIC_ONLY', 'X-Unapproved': 'SYNTHETIC_ONLY' } }));
    expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ outcome: 'configuration' }); expect(fetcher).not.toHaveBeenCalled();
    const redirected = json(chat()); Object.defineProperties(redirected, { redirected: { value: true }, url: { value: 'https://attacker.test/login' } });
    const g = fixture(vi.fn(async () => redirected) as typeof fetch);
    expect(await g.tester.test('api', { modelId: 'saved' })).toMatchObject({ outcome: 'configuration' });
  });
  it('refuses real HTTP redirects without sending a credential to another local route', async () => {
    const routes: string[] = [];
    const server = createServer((req, res) => { routes.push(req.url!); if (req.url === '/v1/chat/completions') { res.writeHead(307, { Location: '/steal' }); res.end(); } else { res.end(JSON.stringify(chat())); } }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.store.provider.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ ok: false, outcome: 'configuration', statusCode: 307 });
    expect(routes).toEqual(['/v1/chat/completions']);
  });
  it('bounds declared and streamed bodies and never returns their content', async () => {
    for (const response of [json(chat(), 200, { 'Content-Length': '600000' }), new Response(' '.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) {
      const f = fixture(vi.fn(async () => response) as typeof fetch);
      expect(await f.tester.test('api', { modelId: 'saved' })).toMatchObject({ ok: false, outcome: 'invalid-response', message: expect.stringContaining('响应过大') });
    }
  });
  it('bounds the entire stalled credential preparation and never sends a late inference request', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(async () => json(chat())); const f = fixture(fetcher as typeof fetch);
    let resolve!: (request: PreparedUpstream) => void;
    f.prepareRequest.mockImplementation(() => new Promise<PreparedUpstream>(done => { resolve = done; }));
    const pending = f.tester.test('api', { modelId: 'saved' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ outcome: 'timeout', durationMs: 30000 });
    resolve(prepareUpstream(f.store.provider, f.store.secret, '/chat/completions', {}));
    await Promise.resolve(); await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds both a non-cooperative fetch and a stalled response body without waiting indefinitely', async () => {
    vi.useFakeTimers();
    const stalledFetch = fixture(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
    const pendingFetch = stalledFetch.tester.test('api', { modelId: 'saved' });
    await vi.advanceTimersByTimeAsync(30_000); expect(await pendingFetch).toMatchObject({ outcome: 'timeout' });
    let cancelled = false;
    const f = fixture(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
    const pendingBody = f.tester.test('api', { modelId: 'saved' });
    await vi.advanceTimersByTimeAsync(30_000); expect(await pendingBody).toMatchObject({ outcome: 'timeout', statusCode: 200 }); expect(cancelled).toBe(true);
  });
  it('keeps OAuth and network exception text private', async () => {
    const f = fixture(); f.prepareRequest.mockRejectedValue(new Error('SYNTHETIC_ONLY PRIVATE_AUTH_BODY'));
    const authResult = await f.tester.test('api', { modelId: 'saved' }); expect(authResult).toMatchObject({ outcome: 'authentication' }); expect(JSON.stringify(authResult)).not.toContain('PRIVATE_AUTH_BODY');
    const g = fixture(vi.fn(async () => { throw new Error('https://site/?key=SYNTHETIC_ONLY'); }) as typeof fetch);
    const networkResult = await g.tester.test('api', { modelId: 'saved' }); expect(networkResult).toMatchObject({ outcome: 'network' }); expect(JSON.stringify(networkResult)).not.toContain('SYNTHETIC_ONLY');
  });
});
