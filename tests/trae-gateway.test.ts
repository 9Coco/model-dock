import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Gateway, type GatewayOptions } from '../src/main/gateway';
import { Store } from '../src/main/store';
import { TRAE_PROVIDER_IDS, traeBaseUrl, traeModelProtocol, traeModelsForProvider } from '../src/shared/trae';
import type { WireApi } from '../src/shared/types';

type Body = Record<string, any>;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function readBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
const event = (value: Body) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const chatInput = (stream = false) => ({ model: 'trae-model', stream, messages: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }] });
const messagesInput = (stream = false) => ({ ...chatInput(stream), max_tokens: 512 });
const responseInput = (stream = false) => ({ model: 'trae-model', stream, input: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }] });
const nativeMessage = (content: unknown[], stopReason = 'end_turn') => ({ id: 'msg_trae', type: 'message', role: 'assistant', model: 'real-upstream-model', content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 3 } });

async function fixture(wireApi: WireApi, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, options: { subscription?: boolean; gateway?: GatewayOptions; claudeOverride?: boolean } = {}) {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => { response.statusCode = 500; response.end('Synthetic handler failed'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-trae-gateway-'));
  const store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Synthetic Trae source', kind: options.subscription ? 'codex' : 'openai-compatible',
    baseUrl: options.subscription ? 'https://chatgpt.com/backend-api/codex' : upstream + '/v1', enabled: true,
    ...(options.subscription ? {} : { apiKey: 'SYNTHETIC_UPSTREAM_KEY', messagesAuth: 'api-key' as const }),
    ...(options.claudeOverride ? { claudeBaseUrl: upstream + '/do-not-use-for-responses' } : {}) });
  if (options.subscription) store.setSecret(provider.id, { accessToken: 'SYNTHETIC_OAUTH_ACCESS', refreshToken: 'SYNTHETIC_OAUTH_REFRESH', expiresAt: Date.now() + 3600000 });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'real-upstream-model', alias: 'trae-model', displayName: 'Trae fixture', wireApi, contextWindow: 128000, tools: true, vision: false, enabled: true });
  store.saveBinding({ id: 'trae', name: 'Trae CN', mode: 'aggregate', enabled: true, providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const gateway = new Gateway(store, { timeoutMs: 5000, ...options.gateway,
    ...(options.subscription ? { prepareRequest: async (_provider, secret, path, body) => ({ url: upstream + path, headers: { authorization: `Bearer ${secret.accessToken}` }, body: { ...body, stream: true } }) } satisfies GatewayOptions : {}) });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const base = traeBaseUrl(gateway.status().port);
  const headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const post = (route: string, body: unknown, auth: Record<string, string> = headers, signal?: AbortSignal) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body), signal });
  return { store, provider, model, gateway, base, headers, post };
}

describe('TRAE native protocol gateway', () => {
  it('publishes only selected models, includes native Messages, and closes aggregate routes in direct mode', async () => {
    let calls = 0;
    const f = await fixture('messages', async (_request, response) => { calls++; response.end(JSON.stringify(nativeMessage([{ type: 'text', text: 'OK' }]))); });
    const excluded = f.store.saveModel({ ...f.model, id: undefined, alias: 'not-selected', upstreamId: 'other-upstream' });
    const catalog = await (await fetch(f.base + '/models', { headers: f.headers })).json();
    expect(catalog.data).toMatchObject([{ id: f.model.alias, wire_api: 'messages' }]);
    expect(catalog.data).toHaveLength(1);
    expect((await f.post('/messages', { ...messagesInput(), model: excluded.alias })).status).toBe(403);
    const binding = f.store.listBindings().find(item => item.id === 'trae')!;
    f.store.saveBinding({ ...binding, enabled: false });
    expect((await f.post('/messages', messagesInput())).status).toBe(403);
    f.store.saveBinding({ ...binding, mode: 'direct' });
    expect((await f.post('/messages', messagesInput())).status).toBe(403);
    expect(calls).toBe(0);
  });

  it('keeps all native API protocols eligible while never exporting subscription credentials in direct mode', async () => {
    const f = await fixture('responses', async (_request, response) => { response.end('{}'); });
    const messages = f.store.saveModel({ ...f.model, id: undefined, alias: 'native-messages', wireApi: 'messages' });
    const chat = f.store.saveModel({ ...f.model, id: undefined, alias: 'native-chat', wireApi: 'chat-completions' });
    const models = [f.model, messages, chat];
    expect(traeModelsForProvider(f.provider, models, false)).toEqual(models);
    expect(models.map(model => TRAE_PROVIDER_IDS[traeModelProtocol(model)])).toEqual(['custom_responses_compatible', 'custom_anthropic_compatible', 'custom_openai_compatible']);
    expect(traeModelsForProvider({ ...f.provider, kind: 'codex' }, models, false)).toEqual([]);
    expect(traeModelsForProvider({ ...f.provider, kind: 'codex' }, models, true)).toEqual(models);
    expect(traeModelsForProvider({ ...f.provider, enabled: false }, models, true)).toEqual([]);
  });

  it('streams Chat increments before upstream completion and routes a complete tool-result round trip', async () => {
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    const requests: Body[] = [];
    const f = await fixture('chat-completions', async (request, response) => {
      const body = await readBody(request); requests.push(body);
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBe('Bearer SYNTHETIC_UPSTREAM_KEY');
      expect(request.headers['x-api-key']).toBeUndefined();
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream');
        response.write(`data: ${JSON.stringify({ model: 'real-upstream-model', choices: [{ delta: { content: 'Before completion' }, finish_reason: null }] })}\n\n`);
        await pending;
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'Tool result received.' }, finish_reason: 'stop' }] }));
      }
    });
    try {
      const streaming = await f.post('/chat/completions', chatInput(true), f.headers, AbortSignal.timeout(2000));
      const reader = streaming.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('Before completion');
      release(); while (!(await reader.read()).done) { /* drain the completed stream */ }
      const history = [...chatInput().messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"fixture"}' } }] }, { role: 'tool', tool_call_id: 'call_fixture', content: 'SYNTHETIC_TOOL_RESULT' }];
      const reply = await (await f.post('/chat/completions', { ...chatInput(), messages: history })).json();
      expect(reply).toMatchObject({ model: f.model.alias, choices: [{ message: { content: 'Tool result received.' } }] });
      expect(requests[1]).toMatchObject({ model: f.model.upstreamId, messages: history });
      expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_PROMPT|SYNTHETIC_TOOL_RESULT|SYNTHETIC_UPSTREAM_KEY/);
    } finally { release(); }
  });

  it('accepts native Messages x-api-key only on the TRAE Messages route and rejects conflicting credentials', async () => {
    let calls = 0;
    const f = await fixture('messages', async (_request, response) => { calls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(nativeMessage([{ type: 'text', text: 'OK' }]))); });
    const api = { 'x-api-key': f.store.gatewayKey() };
    expect((await f.post('/messages', messagesInput(), api)).status).toBe(200);
    for (const auth of [
      { 'x-api-key': 'wrong' },
      { ...api, authorization: 'Bearer wrong' },
      { ...api, authorization: 'Basic wrong' },
      { ...f.headers, 'x-api-key': 'wrong' },
    ]) expect((await f.post('/messages', messagesInput(), auth)).status).toBe(401);
    expect((await f.post('/chat/completions', chatInput(), api)).status).toBe(401);
    expect((await f.post('/responses', responseInput(), api)).status).toBe(401);
    for (const path of ['/v1/messages', '/tool/claude-code/v1/messages']) {
      expect((await fetch(new URL(path, f.base), { method: 'POST', headers: { ...api, 'content-type': 'application/json' }, body: JSON.stringify(messagesInput()) })).status).toBe(401);
    }
    expect(calls).toBe(1);
  });

  it('preserves native Messages thinking, tool use and results while keeping local authentication out of upstream', async () => {
    const requests: Body[] = [];
    const blocks = [{ type: 'thinking', thinking: 'SYNTHETIC_THINKING', signature: 'SYNTHETIC_SIGNATURE' }, { type: 'tool_use', id: 'call_fixture', name: 'read_fixture', input: { path: 'fixture' } }];
    const f = await fixture('messages', async (request, response) => {
      const body = await readBody(request); requests.push(body);
      expect(request.url).toBe('/v1/messages');
      expect(request.headers['x-api-key']).toBe('SYNTHETIC_UPSTREAM_KEY');
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(nativeMessage(requests.length === 1 ? blocks : [{ type: 'text', text: 'Finished.' }], requests.length === 1 ? 'tool_use' : 'end_turn')));
    });
    const first = await (await f.post('/messages', messagesInput(), { 'x-api-key': f.store.gatewayKey() })).json();
    expect(first).toMatchObject({ model: f.model.alias, content: blocks, stop_reason: 'tool_use' });
    const history = [...messagesInput().messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'SYNTHETIC_TOOL_RESULT' }] }];
    const second = await (await f.post('/messages', { ...messagesInput(), messages: history })).json();
    expect(second).toMatchObject({ content: [{ type: 'text', text: 'Finished.' }], stop_reason: 'end_turn' });
    expect(requests[1]).toMatchObject({ model: f.model.upstreamId, messages: history });
    expect(JSON.stringify([first, second, f.store.logs()])).not.toContain('SYNTHETIC_UPSTREAM_KEY');
  });

  it('routes native Responses unchanged even when the provider has a separate Claude URL', async () => {
    let requestBody: Body | undefined;
    const f = await fixture('responses', async (request, response) => {
      requestBody = await readBody(request);
      expect(request.url).toBe('/v1/responses');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'response_fixture', object: 'response', status: 'completed', model: 'real-upstream-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native Responses.' }] }] }));
    }, { claudeOverride: true });
    const body = { ...responseInput(), input: [{ type: 'function_call', call_id: 'call_fixture', name: 'read_fixture', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_fixture', output: 'SYNTHETIC_RESULT' }] };
    const reply = await (await f.post('/responses', body)).json();
    expect(reply).toMatchObject({ model: f.model.alias, output: [{ content: [{ text: 'Native Responses.' }] }] });
    expect(requestBody).toEqual({ ...body, model: f.model.upstreamId });
    expect((await f.post('/chat/completions', chatInput())).status).toBe(400);
    expect((await f.post('/messages', messagesInput())).status).toBe(400);
  });

  it.each([true, false])('normalizes Codex octet-stream Responses without losing completed tools (stream=%s)', async stream => {
    const item = { id: 'fc_trae', type: 'function_call', status: 'completed', call_id: 'call_trae', name: 'read_fixture', arguments: '{"path":"fixture"}' };
    const f = await fixture('responses', async (request, response) => {
      const body = await readBody(request);
      expect(request.url).toBe('/v1/responses'); expect(body.stream).toBe(true);
      expect(request.headers.authorization).toBe('Bearer SYNTHETIC_OAUTH_ACCESS');
      response.setHeader('content-type', 'application/octet-stream');
      response.end(event({ type: 'response.created', response: { id: 'resp_trae', object: 'response', model: 'real-upstream-model', status: 'in_progress', output: [] } })
        + event({ type: 'response.output_item.done', output_index: 0, item })
        + event({ type: 'response.completed', response: { id: 'resp_trae', object: 'response', model: 'real-upstream-model', status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 4 } } }));
    }, { subscription: true });
    const response = await f.post('/responses', responseInput(stream)); expect(response.status).toBe(200);
    const raw = await response.text();
    const result = stream ? raw.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(item => item.type === 'response.completed').response : JSON.parse(raw);
    expect(result).toMatchObject({ model: f.model.alias, output: [item], usage: { input_tokens: 8, output_tokens: 4 } });
    expect(raw).not.toMatch(/SYNTHETIC_OAUTH_ACCESS|SYNTHETIC_OAUTH_REFRESH/);
    expect(f.store.logs()[0]).toMatchObject({ status: 200, endpoint: '/v1/responses' });
  });

  it('cancels an in-flight upstream when the TRAE client disconnects', async () => {
    let cancelled!: () => void;
    const closed = new Promise<void>(done => { cancelled = done; });
    const f = await fixture('chat-completions', async (request, response) => {
      await readBody(request); response.on('close', cancelled);
      response.setHeader('content-type', 'text/event-stream');
      response.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
    });
    const abort = new AbortController();
    const response = await f.post('/chat/completions', chatInput(true), f.headers, abort.signal);
    await response.body!.getReader().read(); abort.abort();
    await closed;
  });
});
