import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { collectNativeMessagesStream, createNativeMessagesStream, nativeMessagesToSse, prepareNativeMessagesRequest, toNativeMessagesResponse } from '../src/main/native-messages';
import { reportedUsage } from '../src/main/usage';
import type { Provider } from '../src/shared/types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sse = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()); }
const usage = { input_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 3 };
const message = (content: unknown[], stop = 'end_turn') => ({ id: 'msg_native', type: 'message', role: 'assistant', model: 'shared-upstream-id', content, stop_reason: stop, stop_sequence: null, usage });
const input = (model = 'native-a', stream = false) => ({ model, max_tokens: 256, stream, messages: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }], tools: [{ name: 'read_fixture', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
function nativeStream(options: { error?: boolean; truncated?: boolean } = {}) {
  const start = sse('message_start', { type: 'message_start', message: { ...message([]), stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
  const content = sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SYNTHETIC_THINKING' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SYNTHETIC_SIGNATURE' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('ping', { type: 'ping' })
    + sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_fixture', name: 'read_fixture', input: {} } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"测试"}' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 1 });
  if (options.error) return start + content + sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'SYNTHETIC_API_KEY_A PRIVATE_UPSTREAM_ERROR' } });
  if (options.truncated) return start + content;
  return start + content + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }) + sse('message_stop', { type: 'message_stop' });
}
async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response).catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function fixture(options: { handlerA?: (body: any, response: ServerResponse) => Promise<void>; handlerSubscription?: (body: any, response: ServerResponse) => Promise<void>; timeoutMs?: number; expectedProtocolHeaders?: { version: string; beta: string } } = {}) {
  const requests: { source: string; body: any }[] = [];
  const native = async (source: string, request: IncomingMessage, response: ServerResponse) => {
    expect(request.url).toBe(`/native-${source}/v1/messages`);
    expect(request.headers['anthropic-version']).toBe(options.expectedProtocolHeaders?.version ?? '2023-06-01');
    expect(request.headers['anthropic-beta']).toBe(options.expectedProtocolHeaders?.beta);
    expect(request.headers['x-private-client']).toBeUndefined();
    expect(request.headers['x-modeldock-test']).toBeUndefined();
    expect(request.headers['user-agent']).not.toBe('PRIVATE_CLIENT_USER_AGENT');
    if (source === 'a') { expect(request.headers['x-api-key']).toBe('SYNTHETIC_API_KEY_A'); expect(request.headers.authorization).toBeUndefined(); }
    else { expect(request.headers.authorization).toBe('Bearer SYNTHETIC_API_KEY_B'); expect(request.headers['x-api-key']).toBeUndefined(); }
    const body = await bodyOf(request); requests.push({ source, body }); expect(body.model).toBe('shared-upstream-id');
    if (source === 'a' && options.handlerA) return options.handlerA(body, response);
    response.setHeader('content-type', 'application/json');
    const content = requests.filter(item => item.source === source).length === 1
      ? [{ type: 'tool_use', id: 'tool_fixture', name: 'read_fixture', input: { path: 'fixture' } }]
      : [{ type: 'text', text: `Native ${source} completed.` }];
    response.end(JSON.stringify(message(content, content[0].type === 'tool_use' ? 'tool_use' : 'end_turn')));
  };
  const a = await upstream((request, response) => native('a', request, response));
  const b = await upstream((request, response) => native('b', request, response));
  const subscription = await upstream(async (request, response) => {
    expect(request.url).toBe('/v1/responses'); expect(request.headers.authorization).toBe('Bearer SYNTHETIC_SUBSCRIPTION_ACCESS');
    expect(request.headers['anthropic-version']).toBeUndefined(); expect(request.headers['anthropic-beta']).toBeUndefined();
    const body = await bodyOf(request); requests.push({ source: 'subscription', body }); expect(body.model).toBe('subscription-upstream');
    if (options.handlerSubscription) return options.handlerSubscription(body, response);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'resp_fixture', object: 'response', status: 'completed', model: 'subscription-upstream', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Subscription completed.' }] }], usage: { input_tokens: 6, output_tokens: 2 } }));
  });
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-native-messages-')); const store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const providerA = store.saveProvider({ name: 'Native A', kind: 'openai-compatible', baseUrl: a.baseUrl + '/chat/v1', claudeBaseUrl: a.baseUrl + '/native-a', messagesAuth: 'api-key', enabled: true, apiKey: 'SYNTHETIC_API_KEY_A' });
  const providerB = store.saveProvider({ name: 'Native B', kind: 'openai-compatible', baseUrl: b.baseUrl + '/native-b/v1', enabled: true, apiKey: 'SYNTHETIC_API_KEY_B' });
  const providerSubscription = store.saveProvider({ name: 'Subscription', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(providerSubscription.id, { accessToken: 'SYNTHETIC_SUBSCRIPTION_ACCESS', refreshToken: 'SYNTHETIC_SUBSCRIPTION_REFRESH', expiresAt: Date.now() + 3600000 });
  const modelA = store.saveModel({ providerId: providerA.id, upstreamId: 'shared-upstream-id', alias: 'native-a', displayName: 'Native A', wireApi: 'chat-completions', contextWindow: 0, tools: true, vision: false, enabled: true });
  const modelB = store.saveModel({ providerId: providerB.id, upstreamId: 'shared-upstream-id', alias: 'native-b', displayName: 'Native B', wireApi: 'messages', contextWindow: 0, tools: true, vision: false, enabled: true });
  const subscriptionModel = store.saveModel({ providerId: providerSubscription.id, upstreamId: 'subscription-upstream', alias: 'subscription', displayName: 'Subscription', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true });
  store.saveBinding({ id: 'claude-code', name: 'Claude Code', enabled: true, mode: 'aggregate', providerIds: [providerA.id, providerB.id, providerSubscription.id], modelIds: [], defaultModelId: modelA.id, note: '' });
  const gateway = new Gateway(store, { timeoutMs: options.timeoutMs ?? 5000, prepareRequest: async (provider, secret, path, body) => {
    expect(provider.id).toBe(providerSubscription.id);
    return { url: subscription.baseUrl + path, headers: { authorization: `Bearer ${secret.accessToken}` }, body };
  } });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const base = gateway.status().baseUrl.replace(/\/v1$/, '');
  const post = (body: unknown, key = store.gatewayKey(), protocolHeaders: Record<string, string> = {}) => fetch(base + '/tool/claude-code/v1/messages', { method: 'POST', headers: { ...protocolHeaders, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-api-key': 'MALICIOUS_CLIENT_SECRET' }, body: JSON.stringify(body) });
  return { store, gateway, base, post, requests, providerA, providerB, providerSubscription, modelA, modelB, subscriptionModel };
}
function byteChunks(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } });
}
const records = (store: Store) => store.usageRecords('2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');

describe('Native Messages response handling', () => {
  it('uses strict official dual-protocol endpoints and exactly one source auth header', () => {
    const provider: Provider = { id: 'p', name: 'DeepSeek', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '', messagesAuth: 'api-key' };
    const prepared = prepareNativeMessagesRequest(provider, { apiKey: 'SYNTHETIC_KEY' }, input());
    expect(prepared.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(prepared.headers).toMatchObject({ 'x-api-key': 'SYNTHETIC_KEY', 'anthropic-version': '2023-06-01' });
    expect(prepared.headers.authorization).toBeUndefined();
    const custom = prepareNativeMessagesRequest({ ...provider, baseUrl: 'https://custom.example/prefix/v1', messagesAuth: 'bearer' }, { apiKey: 'SYNTHETIC_KEY' }, input());
    expect(custom.url).toBe('https://custom.example/prefix/v1/messages');
    expect(custom.headers.authorization).toBe('Bearer SYNTHETIC_KEY');
    expect(custom.headers['x-api-key']).toBeUndefined();
  });
  it('accepts a future native version and valid beta tags without forwarding extra client headers', () => {
    const provider: Provider = { id: 'p', name: 'Native', kind: 'openai-compatible', baseUrl: 'https://native.example/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
    const headers = { anthropicVersion: '2027-04-15', anthropicBeta: 'claude-code-20250219, interleaved-thinking-2025-05-14, feature.tag_1', authorization: 'PRIVATE_CLIENT_AUTH', 'x-api-key': 'PRIVATE_CLIENT_KEY', 'x-private-client': 'PRIVATE_CLIENT_DATA' };
    const prepared = prepareNativeMessagesRequest(provider, { apiKey: 'SYNTHETIC_SOURCE_KEY' }, input(), headers);
    expect(prepared.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json', 'anthropic-version': headers.anthropicVersion, 'anthropic-beta': headers.anthropicBeta, authorization: 'Bearer SYNTHETIC_SOURCE_KEY' });
    expect(JSON.stringify(prepared)).not.toMatch(/PRIVATE_CLIENT_(?:AUTH|KEY|DATA)/);
  });
  it.each([
    { anthropicVersion: '2023-06-01\r\nx-private: injected' },
    { anthropicVersion: '2023-06-01\n' },
    { anthropicVersion: 'v'.repeat(129) },
    { anthropicVersion: '版本-2026' },
    { anthropicVersion: '2026 10 09' },
    { anthropicBeta: 'feature-2026\nprivate: injected' },
    { anthropicBeta: 'feature-2026\n' },
    { anthropicBeta: 'b'.repeat(4097) },
    { anthropicBeta: 'feature-2026, ' },
    { anthropicBeta: 'feature-2026,,another-feature' },
    { anthropicBeta: 'feature-2026\t' },
    { anthropicBeta: 'feature-2026, 私人标记' },
    { anthropicBeta: 'feature-2026;invalid' },
  ])('blocks malformed protocol headers before preparing any request: %j', headers => {
    const provider: Provider = { id: 'p', name: 'Native', kind: 'openai-compatible', baseUrl: 'https://native.example/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
    let error: unknown; try { prepareNativeMessagesRequest(provider, { apiKey: 'SYNTHETIC_SOURCE_KEY' }, input(), headers); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 400 });
    expect(String(error)).not.toMatch(/injected|PRIVATE_CLIENT|SYNTHETIC_SOURCE_KEY|私人标记/);
  });
  it('collects split UTF-8, thinking signatures, tool inputs and cumulative native cache usage', async () => {
    const observed: unknown[] = [];
    const result = await collectNativeMessagesStream(byteChunks(nativeStream()), 'local-alias', { onUpstreamEvent: value => observed.push(value) });
    expect(result).toMatchObject({ model: 'local-alias', stop_reason: 'tool_use', usage });
    expect(result.content).toEqual([{ type: 'thinking', thinking: 'SYNTHETIC_THINKING', signature: 'SYNTHETIC_SIGNATURE' }, { type: 'tool_use', id: 'tool_fixture', name: 'read_fixture', input: { path: '测试' } }]);
    expect(observed.map(reportedUsage).filter(Boolean).at(-1)).toEqual({ inputTokens: 14, outputTokens: 3, cachedInputTokens: 4, cacheCreationInputTokens: 2 });
  });
  it('preserves native thinking and opaque server-tool blocks when a JSON reply is requested as a stream', async () => {
    const content = [{ type: 'thinking', thinking: 'SYNTHETIC_THINKING', signature: 'SYNTHETIC_SIGNATURE' }, { type: 'web_search_tool_result', tool_use_id: 'server_fixture', content: [{ type: 'web_search_result', title: 'Synthetic result', url: 'https://example.com', encrypted_content: 'SYNTHETIC_OPAQUE_PAYLOAD' }] }];
    const mapped = toNativeMessagesResponse(message(content), 'local-alias');
    const bytes = nativeMessagesToSse(mapped);
    const collected = await collectNativeMessagesStream(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), 'local-alias');
    expect(collected).toMatchObject({ model: 'local-alias', content });
  });
  it.each([{ error: true }, { truncated: true }])('never emits completion for a failed stream: %j', async options => {
    const stream = byteChunks(nativeStream(options)).pipeThrough(createNativeMessagesStream('local-alias'));
    const output = await new Response(stream).text();
    expect(output).toContain('event: error'); expect(output).not.toContain('event: message_stop');
    expect(output).not.toMatch(/PRIVATE_UPSTREAM_ERROR|SYNTHETIC_API_KEY_A/);
    await expect(collectNativeMessagesStream(byteChunks(nativeStream(options)), 'local-alias')).rejects.toThrow();
  });
});

describe('Claude aggregate gateway with native Messages and subscriptions', () => {
  it('forwards only native protocol headers to the selected native supplier and replaces client authentication', async () => {
    const version = '2027-04-15', beta = 'claude-code-20250219, interleaved-thinking-2025-05-14';
    const f = await fixture({ expectedProtocolHeaders: { version, beta } });
    const headers = { 'anthropic-version': version, 'anthropic-beta': beta, 'x-private-client': 'PRIVATE_CLIENT_DATA', 'x-modeldock-test': 'PRIVATE_MODELDOCK_DATA', 'user-agent': 'PRIVATE_CLIENT_USER_AGENT' };
    const a = await f.post(input(), f.store.gatewayKey(), headers); expect(a.status).toBe(200);
    const b = await f.post(input('native-b'), f.store.gatewayKey(), headers); expect(b.status).toBe(200);
    const subscription = await f.post(input('subscription'), f.store.gatewayKey(), headers); expect(subscription.status).toBe(200);
    expect(f.requests.map(item => item.source)).toEqual(['a', 'b', 'subscription']);
    expect(JSON.stringify(f.store.logs())).not.toMatch(/claude-code-20250219|2027-04-15|PRIVATE_CLIENT|PRIVATE_MODELDOCK/);
  });
  it('rejects an invalid beta header before sending a native inference request', async () => {
    const f = await fixture();
    const response = await f.post(input(), f.store.gatewayKey(), { 'anthropic-beta': 'valid-tag,,invalid-tag' });
    expect(response.status).toBe(400); expect(f.requests).toEqual([]);
    expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(JSON.stringify(f.store.logs())).not.toMatch(/valid-tag|invalid-tag/);
  });
  it('routes duplicate upstream IDs by aliases, preserves native tool history, and bridges a selected subscription', async () => {
    const f = await fixture();
    const models = await (await fetch(f.base + '/tool/claude-code/v1/models', { headers: { authorization: `Bearer ${f.store.gatewayKey()}` } })).json();
    expect(models.data.map((value: any) => value.id)).toEqual(expect.arrayContaining(['native-a', 'native-b', 'subscription']));
    const a = await (await f.post({ ...input(), thinking: { type: 'enabled', budget_tokens: 128 } })).json();
    const b = await (await f.post(input('native-b'))).json();
    expect(a).toMatchObject({ model: 'native-a', stop_reason: 'tool_use' }); expect(b.model).toBe('native-b');
    const history = { ...input(), messages: [...input().messages, { role: 'assistant', content: a.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: 'SYNTHETIC_RESULT' }] }] };
    const done = await (await f.post(history)).json(); expect(done.content).toEqual([{ type: 'text', text: 'Native a completed.' }]);
    const subscription = await (await f.post(input('subscription'))).json(); expect(subscription.content).toEqual([{ type: 'text', text: 'Subscription completed.' }]);
    expect(f.requests.map(item => item.source)).toEqual(['a', 'b', 'a', 'subscription']);
    expect(f.requests[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 128 });
    expect(f.requests[2].body.messages).toEqual(history.messages);
    expect(JSON.stringify([a, b, done, subscription, f.store.logs()])).not.toMatch(/SYNTHETIC_API_KEY|SYNTHETIC_SUBSCRIPTION_(?:ACCESS|REFRESH)|MALICIOUS_CLIENT_SECRET/);
    expect(records(f.store).find(value => value.alias === 'native-b')).toMatchObject({ status: 200, tool: 'claude-code', usage: { inputTokens: 14, outputTokens: 3, cachedInputTokens: 4, cacheCreationInputTokens: 2 } });
  });
  it('maps native SSE nested model aliases, preserves thinking, and collects forced SSE for nonstream clients', async () => {
    const f = await fixture({ handlerA: async (_body, response) => { response.setHeader('content-type', 'text/event-stream'); response.end(nativeStream()); } });
    const streamed = await (await f.post(input('native-a', true))).text();
    expect(streamed).toContain('event: message_stop'); expect(streamed).toContain('"model":"native-a"'); expect(streamed).not.toContain('shared-upstream-id');
    expect(streamed).toContain('SYNTHETIC_SIGNATURE');
    const collected = await (await f.post(input())).json(); expect(collected.content[1].input).toEqual({ path: '测试' }); expect(collected.stop_reason).toBe('tool_use');
    expect(records(f.store).every(value => value.status === 200 && value.usage?.inputTokens === 14 && value.usage.outputTokens === 3)).toBe(true);
  });
  it.each([{ error: true }, { truncated: true }])('records native SSE failure without exposing private errors or claiming completion: %j', async options => {
    const f = await fixture({ handlerA: async (_body, response) => { response.setHeader('content-type', 'text/event-stream'); response.end(nativeStream(options)); } });
    const streamed = await (await f.post(input('native-a', true))).text();
    expect(streamed).toContain('event: error'); expect(streamed).not.toContain('event: message_stop'); expect(streamed).not.toMatch(/PRIVATE_UPSTREAM_ERROR|SYNTHETIC_API_KEY_A/);
    expect(f.store.logs()[0].status).toBe(502);
    const nonstream = await f.post(input()); expect(nonstream.status).toBe(502); expect(await nonstream.json()).toMatchObject({ type: 'error' });
  });
  it('returns native HTTP rejection safely and never retries a different source', async () => {
    const f = await fixture({ handlerA: async (_body, response) => { response.statusCode = 429; response.setHeader('retry-after', '7'); response.end(JSON.stringify({ type: 'error', error: { message: 'SYNTHETIC_API_KEY_A PRIVATE_UPSTREAM_ERROR' } })); } });
    const response = await f.post(input()); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('7');
    const output = await response.text(); expect(output).toContain('rate_limit_error'); expect(output).not.toMatch(/PRIVATE_UPSTREAM_ERROR|SYNTHETIC_API_KEY_A/);
    expect(f.requests.map(item => item.source)).toEqual(['a']);
  });
  it('preserves native retry error semantics while redacting credentials and dropping upstream debug fields', async () => {
    const f = await fixture({ handlerA: async (_body, response) => {
      response.statusCode = 400; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking block is bound to a different conversation SYNTHETIC_API_KEY_A', debug: 'PRIVATE_UPSTREAM_DEBUG', signature: 'PRIVATE_SIGNATURE_DATA' }, debug: 'PRIVATE_TOP_LEVEL_DEBUG', metadata: { token: 'SYNTHETIC_API_KEY_A' } }));
    } });
    const response = await f.post(input()); expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking block is bound to a different conversation [REDACTED]' } });
    expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC_API_KEY_A|PRIVATE_UPSTREAM_DEBUG|PRIVATE_SIGNATURE_DATA|PRIVATE_TOP_LEVEL_DEBUG|"(?:debug|metadata|signature)"/);
    expect(f.requests.map(item => item.source)).toEqual(['a']);
    expect(f.store.logs()[0].status).toBe(400);
    expect(JSON.stringify(f.store.logs())).not.toMatch(/thinking block|different conversation|SYNTHETIC_API_KEY_A|PRIVATE_/);
  });
  it('rejects a malformed HTTP-success body without exposing source errors as a valid Message', async () => {
    const f = await fixture({ handlerA: async (_body, response) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ type: 'error', error: { message: 'SYNTHETIC_API_KEY_A PRIVATE_UPSTREAM_ERROR' } }));
    } });
    const response = await f.post(input()); expect(response.status).toBe(502);
    const output = await response.text(); expect(output).toContain('"type":"error"'); expect(output).not.toMatch(/PRIVATE_UPSTREAM_ERROR|SYNTHETIC_API_KEY_A/);
    expect(f.store.logs()[0].status).toBe(502); expect(f.requests.map(item => item.source)).toEqual(['a']);
  });
  it('enforces tool model scope and localhost credentials before contacting a native supplier', async () => {
    const f = await fixture();
    const binding = f.store.listBindings().find(item => item.id === 'claude-code')!;
    f.store.saveBinding({ ...binding, providerIds: [f.providerA.id], defaultModelId: f.modelA.id });
    const unauthorized = await f.post(input(), 'wrong-local-key'); expect(unauthorized.status).toBe(401);
    const denied = await f.post(input('native-b')); expect(denied.status).toBe(403);
    const unknown = await f.post(input('shared-upstream-id')); expect(unknown.status).toBe(404);
    const listing = await (await fetch(f.base + '/v1/models', { headers: { authorization: `Bearer ${f.store.gatewayKey()}` } })).json();
    expect(listing.data.map((value: any) => value.id)).not.toContain('native-b');
    expect(f.requests).toEqual([]);
  });
  it('cancels the upstream native stream when its client disconnects', async () => {
    let closed = false;
    const f = await fixture({ handlerA: async (_body, response) => {
      response.on('close', () => { closed = true; }); response.setHeader('content-type', 'text/event-stream');
      response.write(sse('message_start', { type: 'message_start', message: { ...message([]), stop_reason: null } }));
    } });
    const abort = new AbortController();
    const client = await fetch(f.base + '/tool/claude-code/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify(input('native-a', true)), signal: abort.signal });
    const reader = client.body!.getReader(); await reader.read(); abort.abort();
    try {
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline && (!closed || !f.store.logs().length)) await new Promise(done => setTimeout(done, 20));
      expect(closed).toBe(true); expect(f.store.logs()[0].status).toBe(499);
    } finally { try { await reader.cancel(); } catch { /* deliberately aborted client */ } reader.releaseLock(); }
  });
});
