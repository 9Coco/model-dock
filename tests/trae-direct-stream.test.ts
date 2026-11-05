import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/main/gateway';
import { Store } from '../src/main/store';
import { TraeApi } from '../src/main/trae-api';
import { TraeGatewayAdapter } from '../src/main/trae-gateway-adapter';
import type { TraeClientCredentials } from '../src/main/trae-client-import';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const encoder = new TextEncoder();
const rawEvent = (event: string, value: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
const credentials: TraeClientCredentials = { host: 'https://api.trae.cn', userId: 'fixture-user', token: 'SYNTHETIC_TRAE_PRIVATE_TOKEN' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Incremental mock pipeline timed out')), milliseconds); })]); } finally { clearTimeout(timer); } }
interface RawRequest { body: Record<string, unknown>; signal: AbortSignal; stream: ReadableStreamDefaultController<Uint8Array>; closed: boolean; canceled: ReturnType<typeof deferred<void>> }
async function fixture(onRaw?: (request: RawRequest) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-trae-direct-stream-')), store = await Store.create(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const imported = await store.saveRelayClientImport({ kind: 'openai-compatible', presetId: 'trae-cn-relay', name: 'Synthetic TRAE native account', baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'SYNTHETIC_OLD_RELAY_KEY', enabled: true }, { nativeClient: { version: 1, client: 'trae-cn', credentials } });
  const provider = store.getProvider(imported.id)!;
  expect(provider.nativeAdapter).toBe('trae'); expect(JSON.stringify(provider)).not.toContain(credentials.token);
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'ExactCase-fixture', alias: 'local-trae-alias', displayName: 'Synthetic native TRAE', wireApi: 'chat-completions', enabled: true, contextWindow: 0, tools: true, vision: false });
  for (const tool of ['codex', 'claude-code', 'vscode', 'rider'] as const) {
    const binding = store.listBindings().find(row => row.id === tool)!;
    store.saveBinding({ ...binding, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  }
  const requests: RawRequest[] = [], routes: string[] = [], rawStarted = deferred<RawRequest>();
  const api = new TraeApi({ timeoutMs: 5000, fetch: (async (input, init) => {
    const url = new URL(String(input)); routes.push(url.pathname);
    expect(url.origin).toBe('https://trae-api-cn.mchost.guru'); expect(init?.redirect).toBe('error');
    if (url.pathname === '/api/ide/v1/get_detail_param') return Response.json({ config_info_list: [{ config_name: model.upstreamId, usage: 'chat_completion', model_detail_list: [{ model_name: model.upstreamId + '__dev' }] }] });
    if (url.pathname !== '/api/ide/v2/llm_raw_chat') throw new Error('Unexpected synthetic upstream route');
    let request!: RawRequest;
    const body = new ReadableStream<Uint8Array>({ start(stream) { request = { body: JSON.parse(String(init?.body)), signal: init!.signal!, stream, closed: false, canceled: deferred<void>() }; }, cancel() { request.canceled.resolve(); } });
    requests.push(request); rawStarted.resolve(request); onRaw?.(request);
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch });
  const adapter = new TraeGatewayAdapter({ isNativeProvider: id => id === provider.id, credentials: () => credentials }, api);
  const fallbackFetch = vi.fn(async () => { throw new Error('Native TRAE must not fetch its historical 18080 URL'); });
  const prepareRequest = vi.fn(async () => { throw new Error('Native TRAE must not prepare its historical relay credentials'); });
  const gateway = new Gateway(store, { nativeRequest: (source, path, body, signal) => adapter.request(source, path, body, signal), fetch: fallbackFetch, prepareRequest, timeoutMs: 5000 });
  await gateway.start(0); cleanups.push(async () => { await gateway.stop(); });
  const origin = new URL(gateway.status().baseUrl).origin, headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const post = (path: string, body: object, signal?: AbortSignal) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ model: model.alias, ...body }), signal });
  return { store, requests, routes, model, provider, post, rawStarted, fallbackFetch, prepareRequest };
}
const paths = [
  { name: 'Chat', path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }] }, delta: '"content":"FIRST🙂"', terminal: '[DONE]' },
  { name: 'JetBrains Chat', path: '/tool/rider/v1/chat/completions', body: { messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }] }, delta: '"content":"FIRST🙂"', terminal: '[DONE]' },
  { name: 'Responses', path: '/tool/codex/v1/responses', body: { input: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }], store: false }, delta: '"type":"response.output_text.delta"', terminal: 'response.completed' },
] as const;
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder(); let text = '';
  while (!text.includes(marker)) { const part = await within(reader.read()); if (part.done) throw new Error('Pipeline closed before the expected first delta'); text += decoder.decode(part.value, { stream: true }); }
  return text;
}
async function rest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> { const decoder = new TextDecoder(); let text = ''; while (true) { const part = await within(reader.read()); if (part.done) return text + decoder.decode(); text += decoder.decode(part.value, { stream: true }); } }
function finish(request: RawRequest, answer = 'SECOND') { request.stream.enqueue(rawEvent('text_delta', { text: answer })); request.stream.enqueue(rawEvent('token_usage', { input_token: 3, output_token: 5 })); request.stream.enqueue(rawEvent('done', { finish_reason: 'stop' })); request.stream.close(); request.closed = true; }

describe('TRAE TypeScript adapter through the existing loopback gateway', () => {
  it.each([true, false])('rejects unsupported Messages token budgets before inference (stream=%s)', async stream => {
    const f = await fixture();
    const response = await f.post('/tool/claude-code/v1/messages', { messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }], max_tokens: 32, stream });
    expect(response.status).toBe(400); const value = await response.json(); expect(value).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: expect.any(String) } });
    expect(JSON.stringify(value)).not.toMatch(/SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_TRAE_PRIVATE_TOKEN/); expect(f.requests).toHaveLength(0); expect(f.routes).toEqual([]); expect(f.fallbackFetch).not.toHaveBeenCalled();
  });
  it.each([{ previous_response_id: 'resp_private' }, { conversation: 'private' }, { tools: [{ type: 'web_search' }] }, { max_output_tokens: 32 }])('returns a controlled request error for unsupported Responses semantics: %j', async patch => {
    const f = await fixture(); const response = await f.post('/tool/codex/v1/responses', { input: 'SYNTHETIC_PRIVATE_PROMPT', stream: true, store: false, ...patch });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { message: expect.any(String) } }); expect(f.requests).toHaveLength(0); expect(f.routes).toEqual([]); expect(f.fallbackFetch).not.toHaveBeenCalled();
  });
  it.each(paths)('$name exposes its first real delta before the upstream terminal event', async route => {
    const f = await fixture(request => { request.stream.enqueue(rawEvent('text_delta', { text: 'FIRST🙂' })); });
    const response = await within(f.post(route.path, { ...route.body, stream: true }));
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    try {
      const first = await readUntil(reader, route.delta), upstream = await within(f.rawStarted.promise);
      expect(first).toContain('FIRST🙂'); expect(first).not.toContain(route.terminal); expect(upstream.closed).toBe(false);
      finish(upstream); const all = first + await rest(reader);
      expect(all).toContain('SECOND'); expect(all).toContain(route.terminal); expect(all).toContain('local-trae-alias');
      expect(f.requests).toHaveLength(1); expect(f.routes).toEqual(['/api/ide/v1/get_detail_param', '/api/ide/v2/llm_raw_chat']);
      expect(f.prepareRequest).not.toHaveBeenCalled(); expect(f.fallbackFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_TRAE_PRIVATE_TOKEN|FIRST|SECOND/);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  });
  it.each(paths)('$name cancellation aborts the exact upstream request without a replacement', async route => {
    const f = await fixture(request => { request.stream.enqueue(rawEvent('text_delta', { text: 'FIRST🙂' })); });
    const response = await within(f.post(route.path, { ...route.body, stream: true })); expect(response.status).toBe(200);
    const reader = response.body!.getReader(); await readUntil(reader, route.delta); const upstream = await within(f.rawStarted.promise);
    await reader.cancel(); reader.releaseLock(); await within(upstream.canceled.promise);
    expect(upstream.signal.aborted).toBe(true); expect(f.requests).toHaveLength(1); expect(f.fallbackFetch).not.toHaveBeenCalled();
  });
  it.each(paths)('$name rejects a truncated nonstream answer instead of returning partial success', async route => {
    const f = await fixture(request => { request.stream.enqueue(rawEvent('text_delta', { text: 'PARTIAL_PRIVATE_ANSWER' })); request.stream.close(); request.closed = true; });
    const response = await within(f.post(route.path, { ...route.body, stream: false }));
    expect(response.status).toBe(502); const text = await response.text(); expect(text).toContain('error'); expect(text).not.toMatch(/PARTIAL_PRIVATE_ANSWER|SYNTHETIC_TRAE_PRIVATE_TOKEN|choices|response.completed|message_stop/); expect(f.requests).toHaveLength(1); expect(f.fallbackFetch).not.toHaveBeenCalled();
  });
  it.each(['truncated', 'malformed', 'upstream-error'] as const)('fails explicitly after a visible delta on %s, without replaying inference', async failure => {
    const f = await fixture(request => { request.stream.enqueue(rawEvent('text_delta', { text: 'FIRST🙂' })); });
    const response = await within(f.post('/tool/codex/v1/responses', { input: 'SYNTHETIC_PRIVATE_PROMPT', stream: true, store: false })); expect(response.status).toBe(200);
    const reader = response.body!.getReader(); const first = await readUntil(reader, 'response.output_text.delta'), upstream = await within(f.rawStarted.promise);
    if (failure === 'malformed') upstream.stream.enqueue(encoder.encode('event: text_delta\ndata: {PRIVATE_INVALID_JSON\n\n'));
    if (failure === 'upstream-error') upstream.stream.enqueue(rawEvent('error', { message: 'PRIVATE_UPSTREAM_ERROR', token: credentials.token }));
    upstream.stream.close(); upstream.closed = true;
    let after = '', rejected = false; try { after = await rest(reader); } catch { rejected = true; } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    expect(rejected || after.includes('response.failed')).toBe(true); expect(first + after).not.toMatch(/response.completed|PRIVATE_INVALID_JSON|PRIVATE_UPSTREAM_ERROR|SYNTHETIC_TRAE_PRIVATE_TOKEN/);
    expect(f.requests).toHaveLength(1); expect(f.fallbackFetch).not.toHaveBeenCalled();
  });
  it('preserves a complete two-round function history and exact model identity over Responses', async () => {
    const f = await fixture(request => {
      request.stream.enqueue(rawEvent('text_delta', { text: 'RESULT' })); request.stream.enqueue(rawEvent('done', { finish_reason: 'stop' })); request.stream.close(); request.closed = true;
    });
    const response = await f.post('/tool/codex/v1/responses', { stream: false, store: false, instructions: 'SYSTEM_FIXTURE', input: [
      { role: 'user', content: 'USER_FIXTURE' }, { type: 'function_call', call_id: 'call_1', name: 'read_fixture', arguments: '{"path":"a"}' }, { type: 'function_call_output', call_id: 'call_1', output: 'TOOL_RESULT_FIXTURE' },
    ], tools: [{ type: 'function', name: 'read_fixture', parameters: { type: 'object' } }] });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ model: 'local-trae-alias', status: 'completed', output: [{ content: [{ text: 'RESULT' }] }] });
    expect(f.requests[0].body).toMatchObject({ config_name: 'ExactCase-fixture', model_name: 'ExactCase-fixture__dev', messages: [
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM_FIXTURE' }] }, { role: 'user', content: [{ type: 'text', text: 'USER_FIXTURE' }] },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read_fixture', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'TOOL_RESULT_FIXTURE' }] },
    ] }); expect(f.requests).toHaveLength(1); expect(f.fallbackFetch).not.toHaveBeenCalled();
  });
});
