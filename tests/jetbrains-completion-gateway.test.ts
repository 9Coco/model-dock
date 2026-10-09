import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { JETBRAINS_TOOL_IDS } from '../src/shared/jetbrains';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); return JSON.parse(Buffer.concat(chunks).toString()); }
const completion = (text = 'SYNTHETIC_CODE') => ({ id: 'fim_fixture', object: 'text_completion', created: 123, model: 'deepseek-flash', choices: [{ index: 0, text, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } });
const frame = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
// Native completion request-spec supports an optional suffix; all code here is synthetic.
const request = (stream = false) => ({ model: 'mapped-fim', prompt: 'function synthetic() {\n  return ', suffix: ';\n}', max_tokens: 512, stop: [], temperature: 0.2, top_p: 1, stream });

async function fixture(handler?: (request: IncomingMessage, response: ServerResponse, body: any) => void | Promise<void>, timeoutMs = 10000) {
  const upstreams: { url: string; body: any; auth: string | undefined }[] = [];
  const server = createServer(async (incoming, response) => {
    const body = await bodyOf(incoming); upstreams.push({ url: incoming.url!, body, auth: incoming.headers.authorization });
    if (handler) await handler(incoming, response, body);
    else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(completion())); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-jb-fim-')), store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Synthetic native FIM', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', enabled: true, apiKey: 'SYNTHETIC_NATIVE_FIM_KEY' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'deepseek-flash', alias: 'mapped-fim', displayName: 'Synthetic FIM', wireApi: 'responses', contextWindow: 10000, tools: false, vision: false, enabled: true });
  const other = store.saveModel({ ...model, id: undefined, upstreamId: 'deepseek-v4-pro', alias: 'not-mapped-fim' });
  const unsupported = store.saveModel({ ...model, id: undefined, upstreamId: 'synthetic-chat', alias: 'mapped-chat' });
  for (const tool of JETBRAINS_TOOL_IDS) store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`, targets: string[] = [];
  const gateway = new Gateway(store, { timeoutMs, fetch: (async (url, init) => { targets.push(String(url)); return fetch(address + '/beta/completions', init); }) as typeof fetch });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const root = gateway.status().baseUrl.replace(/\/v1$/, ''), headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const post = (tool: string, body: unknown, customHeaders = headers) => fetch(`${root}/tool/${tool}/v1/completions`, { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
  return { store, provider, model, other, unsupported, upstreams, targets, gateway, root, headers, post };
}

describe('JetBrains aggregate native FIM endpoint', () => {
  it('accepts the actual prefix-only Rider Generic FIM body without inventing suffix or chat messages', async () => {
    const f = await fixture();
    const actual = { model: f.model.alias, prompt: 'class Synthetic {\nvoid Test() {\n', stream: false, max_tokens: 128, temperature: 0, stop: ['\n\n'] };
    const result = await f.post('rider', actual); expect(result.status).toBe(200); expect((await result.json()).choices[0].text).toBe('SYNTHETIC_CODE');
    expect(f.upstreams[0].body).toEqual({ ...actual, model: f.model.upstreamId });
  });
  it.each(JETBRAINS_TOOL_IDS)('%s preserves actual Generic FIM prefix and suffix while routing exact alias to native beta URL', async tool => {
    const f = await fixture(), result = await f.post(tool, request()); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ...completion(), model: f.model.alias });
    expect(f.targets).toEqual(['https://api.deepseek.com/beta/completions']);
    expect(f.upstreams).toEqual([{ url: '/beta/completions', auth: 'Bearer SYNTHETIC_NATIVE_FIM_KEY', body: { ...request(), model: 'deepseek-flash' } }]);
    expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_NATIVE_FIM_KEY|function synthetic|return /);
    expect(f.store.logs()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 200, endpoint: '/v1/completions' })]));
    expect((await f.post(tool, { ...request(), model: f.other.alias })).status).toBe(403);
    expect(f.upstreams).toHaveLength(1);
  });
  it('rejects root and non-JetBrains completion routes, invalid local key and direct mode without inference', async () => {
    const f = await fixture();
    expect((await fetch(`${f.root}/v1/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify(request()) })).status).toBe(404);
    expect((await f.post('vscode', request())).status).toBe(404);
    expect((await f.post('rider', request(), { ...f.headers, authorization: 'Bearer WRONG_SYNTHETIC_KEY' })).status).toBe(401);
    f.store.saveBinding({ ...f.store.listBindings().find(item => item.id === 'rider')!, mode: 'direct' });
    expect((await f.post('rider', request())).status).toBe(403);
    expect(f.upstreams).toHaveLength(0);
  });
  it('does not turn a selected generic Chat model or an empty aggregate mapping into FIM', async () => {
    const f = await fixture(); let binding = f.store.listBindings().find(item => item.id === 'rider')!;
    f.store.saveBinding({ ...binding, modelIds: [f.unsupported.id], defaultModelId: f.unsupported.id, modelSelection: 'selected' });
    expect((await f.post('rider', { ...request(), model: f.unsupported.alias })).status).toBe(400);
    binding = f.store.listBindings().find(item => item.id === 'rider')!;
    f.store.saveBinding({ ...binding, modelIds: [], defaultModelId: '', modelSelection: 'selected' });
    expect((await f.post('rider', request())).status).toBe(403); expect(f.upstreams).toHaveLength(0);
  });
  it.each([{ model: {} }, { suffix: [] }, { max_tokens: 4097 }, { n: 2 }, { echo: true }, { tools: [{ type: 'function' }] }, { prompt: [123] }, { stream_options: { include_usage: true } }])('fails closed on nonrepresentable native completion request %j', async change => {
    const f = await fixture(); expect((await f.post('rider', { ...request(), ...change })).status).toBe(400); expect(f.upstreams).toHaveLength(0);
  });
  it('keeps disabled tools and providers unavailable', async () => {
    const f = await fixture(); const binding = f.store.listBindings().find(item => item.id === 'rider')!;
    f.store.saveBinding({ ...binding, enabled: false }); expect((await f.post('rider', request())).status).toBe(403);
    f.store.saveBinding({ ...binding, enabled: true }); f.store.saveProvider({ ...f.provider, enabled: false }); expect((await f.post('rider', request())).status).toBe(403);
    expect(f.upstreams).toHaveLength(0);
  });
  it('never sends the native FIM API key to a lookalike or unverified completion endpoint', async () => {
    const f = await fixture(); f.store.saveProvider({ ...f.provider, baseUrl: 'https://api.deepseek.com.synthetic.invalid/v1' });
    expect((await f.post('rider', request())).status).toBe(400); expect(f.targets).toEqual([]); expect(f.upstreams).toEqual([]);
  });
  it('preserves upstream rejection status and retry-after without echoing code or credentials', async () => {
    const f = await fixture((_request, response) => { response.statusCode = 429; response.setHeader('retry-after', '3'); response.end('SYNTHETIC_NATIVE_FIM_KEY function synthetic'); });
    const result = await f.post('rider', request()); expect(result.status).toBe(429); expect(result.headers.get('retry-after')).toBe('3');
    expect(await result.text()).not.toMatch(/SYNTHETIC_NATIVE_FIM_KEY|function synthetic/);
  });
  it.each(['chat', 'error', 'aborted', 'malformed'] as const)('rejects HTTP 200 %s payload instead of inventing completion success', async scenario => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); const value = scenario === 'chat' ? { ...completion(), object: 'chat.completion', choices: [{ index: 0, message: { content: 'SYNTHETIC_BAD' }, finish_reason: 'stop' }] } : scenario === 'error' ? { error: { message: 'SYNTHETIC_BAD' } } : { ...completion(), choices: [{ index: 0, text: 'SYNTHETIC_BAD', finish_reason: 'aborted' }] }; response.end(scenario === 'malformed' ? '{' : JSON.stringify(value)); });
    const result = await f.post('rider', request()); expect(result.status).toBe(502); expect(await result.text()).not.toContain('SYNTHETIC_BAD');
  });
  it('buffers and validates a complete native FIM SSE with split UTF-8 and mapped model', async () => {
    const f = await fixture((_request, response) => {
      response.setHeader('content-type', 'text/event-stream'); const payload = Buffer.from(frame({ ...completion('合成代码'), choices: [{ index: 0, text: '合成代码', logprobs: null, finish_reason: null }], usage: undefined }) + frame({ ...completion(''), choices: [{ index: 0, text: '', logprobs: null, finish_reason: 'stop' }] }) + frame('[DONE]'));
      for (let start = 0; start < payload.length; start += 3) response.write(payload.subarray(start, start + 3)); response.end();
    });
    const result = await f.post('rider', request(true)); expect(result.status).toBe(200); const text = await result.text(); expect(text).toContain('合成代码'); expect(text).toContain('"model":"mapped-fim"'); expect(text).toContain('data: [DONE]');
  });
  it.each(['missing-done', 'missing-finish', 'late-error', 'bad-shape'] as const)('returns HTTP 502 before publishing invalid native FIM stream %s', async scenario => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/event-stream'); response.end(scenario === 'bad-shape' ? frame({ choices: [{ text: 'SYNTHETIC_BAD' }] }) + frame('[DONE]') : frame({ ...completion('SYNTHETIC_BAD'), choices: [{ index: 0, text: 'SYNTHETIC_BAD', logprobs: null, finish_reason: scenario === 'missing-finish' ? null : 'stop' }] }) + (scenario === 'missing-done' ? '' : frame('[DONE]')) + (scenario === 'late-error' ? frame({ type: 'error' }) : '')); });
    const result = await f.post('rider', request(true)); expect(result.status).toBe(502); expect(await result.text()).not.toContain('SYNTHETIC_BAD');
  });
  it('rejects SSE for the actual non-streaming Rider contract and enforces timeout', async () => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'text/event-stream'); response.end(frame(completion()) + frame('[DONE]')); });
    expect((await f.post('rider', request())).status).toBe(502);
    const slow = await fixture(() => {}, 100); expect((await slow.post('rider', request())).status).toBe(504);
  });
  it('aborts native completion upstream when the IDE cancels the pending HTTP request', async () => {
    let began!: () => void, closed!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; }), disconnected = new Promise<void>(resolve => { closed = resolve; });
    const f = await fixture((_request, response) => { response.once('close', closed); began(); });
    const controller = new AbortController();
    const result = fetch(`${f.root}/tool/rider/v1/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify(request()), signal: controller.signal }).then(() => 'success', () => 'cancelled');
    await started; controller.abort(); expect(await result).toBe('cancelled'); await disconnected;
    expect(f.upstreams).toHaveLength(1);
  });
});
