import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { Gateway, type GatewayOptions } from '../src/main/gateway';
import type { Model, WireApi } from '../src/shared/types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}
async function fixture(url: string, wire: WireApi = 'chat-completions', options?: GatewayOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-gateway-'));
  const store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Mock Provider', kind: 'openai-compatible', baseUrl: url, enabled: true, apiKey: 'upstream-private-key' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'vendor-real-id', alias: 'friendly-alias', displayName: 'Friendly', wireApi: wire, contextWindow: 128000, tools: true, vision: false, enabled: true });
  const gateway = new Gateway(store, options); await gateway.start(0); cleanups.push(async () => { await gateway.stop(); });
  return { store, provider, model, gateway, url: gateway.status().baseUrl, headers: { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' } };
}
async function requestBody(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()); }
function event(value: unknown) { return `data: ${JSON.stringify(value)}\n\n`; }

describe('loopback gateway', () => {
  it('never advertises or forwards Messages-only models through OpenAI routes', async () => {
    let requests = 0;
    const mock = await upstream((_req, res) => { requests++; res.end('{}'); });
    const f = await fixture(mock.url, 'messages');
    expect((await (await fetch(`${f.url}/models`, { headers: f.headers })).json()).data).toEqual([]);
    for (const route of ['chat/completions', 'responses']) {
      const response = await fetch(`${f.url}/${route}`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'OK' }] }) });
      expect(response.status).toBe(400);
    }
    expect((await fetch(`${f.url}/messages`, { method: 'POST', headers: f.headers, body: '{}' })).status).toBe(400);
    expect(requests).toBe(0);
  });
  it('configures a stopped gateway without listening and starts on its configured port', async () => {
    const mock = await upstream((_req, res) => { res.end('{}'); });
    const f = await fixture(mock.url); await f.gateway.stop();
    const reserved = await upstream((_req, res) => { res.end('{}'); });
    const port = Number(new URL(reserved.url).port);
    const gateway = new Gateway(f.store, { port });
    cleanups.push(async () => { await gateway.stop(); });
    expect(gateway.status()).toMatchObject({ running: false, host: '127.0.0.1', port, baseUrl: reserved.url });
    expect(() => f.store.saveProvider({ name: 'Configured loop', kind: 'openai-compatible', baseUrl: reserved.url, enabled: true, apiKey: 'synthetic-key' })).toThrow('循环');
    await new Promise<void>(resolve => reserved.server.close(() => resolve()));
    gateway.configurePort(port);
    const idleProbe = createServer();
    cleanups.push(async () => { await new Promise<void>(resolve => idleProbe.close(() => resolve())); });
    idleProbe.listen(port, '127.0.0.1'); await once(idleProbe, 'listening');
    await new Promise<void>(resolve => idleProbe.close(() => resolve()));
    await expect(gateway.start()).resolves.toMatchObject({ running: true, port, baseUrl: reserved.url, lastError: '' });
    const catalog = await (await fetch(`${gateway.status().baseUrl}/models`, { headers: f.headers })).json();
    expect(catalog.data).toMatchObject([{ id: f.model.alias }]);
    gateway.configurePort(port);
    expect(() => gateway.configurePort(port === 65535 ? 65534 : port + 1)).toThrow('先停止');
    expect(gateway.status()).toMatchObject({ running: true, port, baseUrl: reserved.url });
    expect((await fetch(`${gateway.status().baseUrl}/models`, { headers: f.headers })).status).toBe(200);
    await gateway.stop();
    gateway.configurePort(0);
    expect(gateway.status()).toMatchObject({ running: false, port: 0, baseUrl: 'http://127.0.0.1:0/v1' });
    await expect(gateway.start()).resolves.toMatchObject({ running: true });
    expect(gateway.status().port).toBeGreaterThan(0);
  });
  it('retains a configured occupied port and safely retries after that listener closes', async () => {
    const mock = await upstream((_req, res) => { res.end('{}'); });
    const f = await fixture(mock.url); await f.gateway.stop();
    const occupied = await upstream((_req, res) => { res.end('{}'); });
    const port = Number(new URL(occupied.url).port);
    const gateway = new Gateway(f.store, { port });
    cleanups.push(async () => { await gateway.stop(); });
    await expect(gateway.start()).rejects.toThrow('端口');
    expect(gateway.status()).toMatchObject({ running: false, port, baseUrl: occupied.url, lastError: expect.stringContaining('端口') });
    expect(gateway.status().lastError).not.toContain('upstream-private-key');
    await new Promise<void>(resolve => occupied.server.close(() => resolve()));
    await expect(gateway.start()).resolves.toMatchObject({ running: true, port, lastError: '' });
    expect((await fetch(`${gateway.status().baseUrl}/models`, { headers: f.headers })).status).toBe(200);
  });
  it('records safe provider configuration failures while retaining the requested retry port', async () => {
    const mock = await upstream((_req, res) => { res.end('{}'); });
    const f = await fixture(mock.url); await f.gateway.stop();
    const port = Number(new URL(mock.url).port);
    const gateway = new Gateway(f.store, { port });
    cleanups.push(async () => { await gateway.stop(); });
    await expect(gateway.start()).rejects.toThrow('循环');
    expect(gateway.status()).toMatchObject({ running: false, port, baseUrl: mock.url, lastError: expect.stringContaining('循环') });
    expect(gateway.status().lastError).not.toContain('upstream-private-key');
    f.store.saveProvider({ ...f.provider, enabled: false, baseUrl: '' });
    await new Promise<void>(resolve => mock.server.close(() => resolve()));
    await expect(gateway.start()).resolves.toMatchObject({ running: true, port, lastError: '' });
  });
  it('forwards protocol usage in JSON, streamed Chat and collected Responses while retaining only request metadata logs', async () => {
    const mock = await upstream(async (req, res) => {
      const body = await requestBody(req);
      if (req.url?.endsWith('/responses')) {
        res.setHeader('content-type', 'text/event-stream');
        res.end(event({ type: 'response.completed', response: { id: 'response-meter', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private answer' }] }], usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 6 } } } }));
      } else if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        const usage = { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 3 } };
        res.end(event({ model: 'vendor-real-id', choices: [{ delta: { content: 'private answer' } }] }) + event({ usage }) + event({ usage }) + 'data: [DONE]\n\n');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'vendor-real-id', choices: [{ message: { content: 'private answer' } }], usage: { prompt_tokens: 10, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } } }));
      }
    });
    const f = await fixture(mock.url);
    const responseModel = f.store.saveModel({ ...f.model, id: undefined, alias: 'meter-responses', wireApi: 'responses' });
    const replies: string[] = [];
    for (const [endpoint, model, stream] of [['chat/completions', f.model.alias, false], ['chat/completions', f.model.alias, true], ['responses', responseModel.alias, false]] as const) {
      const response = await fetch(`${f.url}/${endpoint}`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'private prompt' }], input: 'private prompt' }) });
      expect(response.status).toBe(200); replies.push(await response.text());
    }
    expect(JSON.parse(replies[0]).usage).toEqual({ prompt_tokens: 10, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } });
    expect(replies[1]).toContain('"prompt_tokens":20');
    expect(JSON.parse(replies[2]).usage).toEqual({ input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 6 } });
    const records = f.store.logs();
    expect(records).toHaveLength(3);
    expect(records.every(record => record.status === 200 && record.providerName === f.provider.name)).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/private (prompt|answer)|usage|tokens/);
  });

  it('authenticates local keys, presents a standard model directory, routes aliases and hides secrets in metadata logs', async () => {
    let seen: unknown; let seenAuth = '';
    const mock = await upstream(async (req, res) => { seen = await requestBody(req); seenAuth = req.headers.authorization ?? ''; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'chat1', model: 'vendor-real-id', choices: [{ message: { content: 'OK' } }] })); });
    const f = await fixture(mock.url);
    expect((await fetch(`${f.url}/models`)).status).toBe(401);
    expect((await fetch(`${f.url}/models`, { headers: { authorization: 'Bearer wrong-key' } })).status).toBe(401);
    const catalog = await (await fetch(`${f.url}/models`, { headers: f.headers })).json();
    expect(catalog.object).toBe('list'); expect(catalog.data[0].id).toBe('friendly-alias'); expect(catalog.data[0].capabilities.tools).toBe(true);
    const response = await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: 'friendly-alias', messages: [{ role: 'user', content: 'private prompt never logged' }] }) });
    expect(response.status).toBe(200); expect((await response.json()).model).toBe('friendly-alias');
    expect(seenAuth).toBe('Bearer upstream-private-key'); expect((seen as { model: string }).model).toBe('vendor-real-id');
    await new Promise(resolve => setTimeout(resolve, 20));
    const logs = JSON.stringify(f.store.logs()); expect(logs).not.toContain('private prompt'); expect(logs).not.toContain(f.store.gatewayKey()); expect(logs).not.toContain('upstream-private-key');
  });

  it('keeps rejected requests separate from service health, preserves safe history after success and clears it on restart', async () => {
    let upstreamCalls = 0;
    const mock = await upstream((_req, res) => { upstreamCalls++; res.end('{}'); });
    const f = await fixture(mock.url);
    const began = Date.now();
    const missing = await fetch(`${f.url}/models?api_key=SYNTHETIC_PRIVATE_QUERY`);
    expect(missing.status).toBe(401); await missing.text();
    expect(f.gateway.status()).toMatchObject({ running: true, lastError: '', lastRequestError: { status: 401, message: '需要有效的 ModelDock API Key。', endpoint: '/v1/models' } });
    expect(f.gateway.status().lastSuccessfulRequestAt).toBeUndefined();
    const wrong = await fetch(`${f.url}/SYNTHETIC_PRIVATE_PATH?token=SYNTHETIC_PRIVATE_QUERY`, { headers: { authorization: 'Bearer wrong-local-key' } });
    expect(wrong.status).toBe(401); await wrong.text();
    const rejected = f.gateway.status().lastRequestError!;
    expect(rejected.status).toBe(401); expect(rejected.endpoint).toBeUndefined();
    expect(Number.isFinite(Date.parse(rejected.time))).toBe(true);
    expect(Date.parse(rejected.time)).toBeGreaterThanOrEqual(began); expect(Date.parse(rejected.time)).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(f.gateway.status())).not.toMatch(/SYNTHETIC_PRIVATE_|wrong-local-key|upstream-private-key/);
    expect(JSON.stringify(f.gateway.status())).not.toContain(f.store.gatewayKey());
    const expectedError = { ...rejected };
    rejected.message = 'caller mutation'; rejected.endpoint = 'caller mutation';
    expect(f.gateway.status().lastRequestError).toEqual(expectedError);
    const catalog = await fetch(`${f.url}/models`, { headers: f.headers });
    expect(catalog.status).toBe(200); expect((await catalog.json()).data[0].id).toBe(f.model.alias);
    const recovered = f.gateway.status();
    expect(recovered).toMatchObject({ running: true, lastError: '', lastRequestError: expectedError });
    expect(Number.isFinite(Date.parse(recovered.lastSuccessfulRequestAt!))).toBe(true);
    expect(Date.parse(recovered.lastSuccessfulRequestAt!)).toBeGreaterThanOrEqual(Date.parse(expectedError.time));
    expect(Date.parse(recovered.lastSuccessfulRequestAt!)).toBeLessThanOrEqual(Date.now());
    expect(upstreamCalls).toBe(0); expect(f.store.logs()).toEqual([]);
    expect(await f.gateway.start()).toMatchObject({ lastRequestError: expectedError, lastSuccessfulRequestAt: recovered.lastSuccessfulRequestAt });
    await f.gateway.stop(); await f.gateway.start(0);
    expect(f.gateway.status()).toMatchObject({ running: true, lastError: '' });
    expect(f.gateway.status().lastRequestError).toBeUndefined(); expect(f.gateway.status().lastSuccessfulRequestAt).toBeUndefined();
  });

  it('filters tool catalogs and routes default bindings, refusing disabled tools and unbound models', async () => {
    const mock = await upstream(async (req, res) => { const body = await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [] })); });
    const f = await fixture(mock.url);
    const other = f.store.saveModel({ ...f.model, id: undefined, alias: 'other-alias', upstreamId: 'other-upstream' });
    const binding = f.store.listBindings().find(b => b.id === 'dsh')!;
    f.store.saveBinding({ ...binding, enabled: true, providerIds: undefined, modelIds: [f.model.id], defaultModelId: f.model.id });
    const base = f.url.replace(/\/v1$/, '/tool/dsh/v1');
    const catalog = await (await fetch(`${base}/models`, { headers: f.headers })).json();
    expect(catalog.data.map((m: { id: string }) => m.id)).toEqual(['friendly-alias']);
    expect((await fetch(`${base}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: other.alias, messages: [] }) })).status).toBe(403);
    const defaultRequest = await fetch(`${base}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ messages: [] }) });
    expect(defaultRequest.status).toBe(200); expect((await defaultRequest.json()).model).toBe('friendly-alias');
    expect((await fetch(`${f.url.replace('/v1', '/tool/opencode/v1')}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias }) })).status).toBe(403);
    expect((await fetch(`${f.url.replace('/v1', '/tool/cursor/v1')}/models`, { headers: f.headers })).status).toBe(404);
  });
  it('enforces the Codex aggregate model allowlist for discovery, explicit inference and the default model', async () => {
    const seen: { model: string; authorization?: string }[] = [];
    const mock = await upstream(async (req, res) => {
      const body = await requestBody(req); seen.push({ model: body.model, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'allowlisted-response', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }));
    });
    const f = await fixture(mock.url, 'responses');
    const secondProvider = f.store.saveProvider({ name: 'Second direct source', kind: 'openai-compatible', baseUrl: mock.url, enabled: true, apiKey: 'second-provider-key' });
    const second = f.store.saveModel({ ...f.model, id: undefined, providerId: secondProvider.id, alias: 'selected-second', upstreamId: 'second-upstream' });
    const excluded = f.store.saveModel({ ...f.model, id: undefined, alias: 'not-selected', upstreamId: 'unselected-upstream' });
    const binding = f.store.listBindings().find(binding => binding.id === 'codex')!;
    const selected = { ...binding, enabled: true, mode: 'aggregate' as const, providerIds: [f.provider.id, secondProvider.id], modelSelection: 'selected' as const, modelIds: [f.model.id, second.id], defaultModelId: second.id };
    f.store.saveBinding(selected);
    const base = f.url.replace(/\/v1$/, '/tool/codex/v1');
    const catalog = await (await fetch(`${base}/models`, { headers: f.headers })).json();
    expect(catalog.data.map((model: { id: string }) => model.id)).toEqual([f.model.alias, second.alias]);
    const post = (model?: string) => fetch(`${base}/responses`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model, input: 'fixture' }) });
    expect((await post(excluded.alias)).status).toBe(403); expect(seen).toEqual([]);
    const defaultReply = await post(); expect(defaultReply.status).toBe(200); expect((await defaultReply.json()).model).toBe(second.alias);
    const firstReply = await post(f.model.alias); expect(firstReply.status).toBe(200); await firstReply.text();
    expect(seen).toEqual([{ model: 'second-upstream', authorization: 'Bearer second-provider-key' }, { model: 'vendor-real-id', authorization: 'Bearer upstream-private-key' }]);
    f.store.saveBinding({ ...selected, modelIds: [], defaultModelId: '' });
    f.store.saveModel({ ...f.model, id: undefined, alias: 'new-after-clearing', upstreamId: 'new-upstream' });
    const cleared = await (await fetch(`${base}/models`, { headers: f.headers })).json(); expect(cleared.data).toEqual([]);
    expect((await post(f.model.alias)).status).toBe(403); expect((await post()).status).toBe(403); expect(seen).toHaveLength(2);
  });

  it('rejects cross-protocol calls and oversized bodies before contacting the upstream', async () => {
    let calls = 0;
    const mock = await upstream((_req, res) => { calls++; res.end('{}'); });
    const f = await fixture(mock.url, 'responses');
    expect((await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias }) })).status).toBe(400);
    const large = JSON.stringify({ model: f.model.alias, input: 'a'.repeat(8 * 1024 * 1024) });
    expect((await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, body: large })).status).toBe(413);
    expect(calls).toBe(0);
  });

  it('rejects subscription continuation fields before preparing or calling the upstream', async () => {
    let calls = 0;
    const mock = await upstream((_req, res) => { calls++; res.end('{}'); });
    const f = await fixture(mock.url);
    f.store.setSecret('codex-subscription', { accessToken: 'native-test-token' });
    const native = f.store.saveModel({ providerId: 'codex-subscription', alias: 'native-history', upstreamId: 'native-id', displayName: 'Native History', wireApi: 'responses', contextWindow: 128000, tools: true, vision: false, enabled: true });
    for (const continuation of [{ previous_response_id: 'old-response' }, { conversation: 'old-conversation' }]) {
      const response = await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: native.alias, input: 'continue', ...continuation }) });
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('完整会话历史');
    }
    expect(calls).toBe(0);
  });

  it('preserves upstream errors and retry metadata without reflecting credential material', async () => {
    const mock = await upstream((_req, res) => { res.statusCode = 429; res.setHeader('content-type', 'application/json'); res.setHeader('retry-after', '30'); res.setHeader('set-cookie', 'upstream-private-cookie'); res.end(JSON.stringify({ error: { message: 'rejected upstream-private-key' } })); });
    const f = await fixture(mock.url);
    const response = await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, messages: [] }) });
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('30'); expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('upstream-private-key');
  });

  it('retains the upstream error status even when its error body exceeds the safety limit', async () => {
    const mock = await upstream((_req, res) => { res.statusCode = 503; res.setHeader('content-type', 'text/plain'); res.end('a'.repeat(2 * 1024 * 1024)); });
    const f = await fixture(mock.url);
    const response = await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, messages: [] }) });
    expect(response.status).toBe(503);
    expect((await response.json()).error.type).toBe('upstream_error');
  });

  it('collects forced Responses SSE into a full non-streaming reply with text, tools and usage', async () => {
    let seen: Record<string, unknown> = {};
    const mock = await upstream(async (req, res) => {
      seen = await requestBody(req);
      res.setHeader('content-type', 'text/event-stream');
      const frames = [
        { type: 'response.created', response: { id: 'resp1', object: 'response', model: 'vendor-real-id', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg1', type: 'message', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' OK' },
        { type: 'response.output_item.added', output_index: 1, item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'lookup', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q":' },
        { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"test"}' },
        { type: 'response.completed', response: { id: 'resp1', model: 'vendor-real-id', status: 'completed', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } },
      ];
      const bytes = Buffer.from(frames.map(event).join(''));
      for (let offset = 0; offset < bytes.length; offset += 17) res.write(bytes.subarray(offset, offset + 17));
      res.end();
    });
    const f = await fixture(mock.url, 'responses', { prepareRequest: async (p, secret, path, body) => ({ url: `${p.baseUrl}/responses`, headers: { Authorization: `Bearer ${secret.apiKey}` }, body: { ...body, stream: true } }) });
    const response = await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, input: 'test', stream: false }) });
    expect(response.status).toBe(200); const result = await response.json();
    expect(seen.stream).toBe(true); expect(result.model).toBe(f.model.alias); expect(result.output[0].content[0].text).toBe('你好 OK');
    expect(result.output[1]).toMatchObject({ type: 'function_call', call_id: 'call1', name: 'lookup', arguments: '{"q":"test"}' });
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 8, total_tokens: 20 });
  });

  it('does not report a truncated Responses stream as a successful empty reply', async () => {
    const mock = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(event({ type: 'response.output_text.delta', delta: 'partial' })); });
    const f = await fixture(mock.url, 'responses');
    const response = await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, input: 'x' }) });
    expect(response.status).toBe(502); expect((await response.json()).error.message).toContain('response.completed');
  });

  it('retains required native Grok headers while dropping unapproved custom headers', async () => {
    let observed: IncomingMessage['headers'] = {};
    const mock = await upstream(async (req, res) => { observed = req.headers; await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'r', object: 'response', model: 'vendor-real-id', output: [] })); });
    const f = await fixture(mock.url, 'responses', { prepareRequest: async (p, s, _path, body) => ({ url: `${p.baseUrl}/responses`, headers: { Authorization: `Bearer ${s.apiKey}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response', 'x-grok-conv-id': 'conversation1', Cookie: 'must-not-be-forwarded' }, body }) });
    const response = await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, input: 'x' }) });
    expect(response.status).toBe(200);
    expect(observed['x-xai-token-auth']).toBe('xai-grok-cli');
    expect(observed['x-authenticateresponse']).toBe('authenticate-response');
    expect(observed['x-grok-conv-id']).toBe('conversation1');
    expect(observed.cookie).toBeUndefined();
  });

  it('passes streaming events and tool arguments while restoring public model aliases', async () => {
    const mock = await upstream((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write(event({ type: 'response.created', response: { id: 'r', model: 'vendor-real-id' } })); res.write(event({ type: 'response.function_call_arguments.delta', delta: '{"q":' })); res.end(event({ type: 'response.completed', response: { id: 'r', model: 'vendor-real-id', output: [] } })); });
    const f = await fixture(mock.url, 'responses');
    const response = await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, input: 'x', stream: true }) });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await response.text(); expect(stream).toContain('friendly-alias'); expect(stream).not.toContain('vendor-real-id'); expect(stream).toContain('function_call_arguments.delta'); expect(stream).toContain('response.completed');
  });

  it('aborts upstream work when the client disconnects and enforces upstream timeouts', async () => {
    let upstreamClosed = false;
    let requestStatus: number | undefined;
    const mock = await upstream(async (req, res) => { await requestBody(req); res.once('close', () => { upstreamClosed = true; }); res.setHeader('content-type', 'text/event-stream'); res.write(event({ type: 'response.created', response: { id: 'r', model: 'vendor-real-id' } })); });
    const f = await fixture(mock.url, 'responses', { timeoutMs: 1000, diagnostics: (_level, event, context) => { if (event === 'gateway.request') requestStatus = context?.statusCode; } });
    const rejected = await fetch(`${f.url}/models`); expect(rejected.status).toBe(401); await rejected.text();
    const priorError = f.gateway.status().lastRequestError;
    const controller = new AbortController();
    const response = await fetch(`${f.url}/responses`, { method: 'POST', headers: f.headers, signal: controller.signal, body: JSON.stringify({ model: f.model.alias, stream: true }) });
    await response.body!.getReader().read(); controller.abort();
    for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(upstreamClosed).toBe(true);
    await expect.poll(() => requestStatus).toBe(499);
    expect(f.gateway.status()).toMatchObject({ running: true, lastError: '', lastRequestError: priorError });
    expect(f.gateway.status().lastSuccessfulRequestAt).toBeUndefined();
    const timeoutMock = await upstream((_req, _res) => {});
    const timed = await fixture(timeoutMock.url, 'chat-completions', { timeoutMs: 30 });
    const timeoutResponse = await fetch(`${timed.url}/chat/completions`, { method: 'POST', headers: timed.headers, body: JSON.stringify({ model: timed.model.alias, messages: [] }) });
    expect(timeoutResponse.status).toBe(504);
  });

  it('refuses a provider that resolves to this gateway and refuses an occupied startup port', async () => {
    const mock = await upstream((_req, res) => { res.end('{}'); });
    const options: GatewayOptions = {};
    const f = await fixture(mock.url, 'chat-completions', options);
    expect(() => f.store.saveProvider({ name: 'Loop', kind: 'openai-compatible', baseUrl: f.url, enabled: true, apiKey: 'test' })).toThrow(/循环/);
    // The hook's own URL must be guarded, not merely the provider's persisted URL.
    options.prepareRequest = async (_p, _s, _path, body) => ({ url: `http://localhost:${f.gateway.status().port}/v1/chat/completions`, headers: {}, body });
    const refused = await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: f.model.alias, messages: [] }) });
    expect(refused.status).toBe(502);
    const own = new Gateway(f.store);
    // Occupied listen ports must never be mistaken for a running ModelDock instance.
    await expect(own.start(f.gateway.status().port)).rejects.toThrow(/端口/);
    await expect(new Gateway(f.store).start(Number(new URL(mock.url).port))).rejects.toThrow(/循环/);
  });

  it('includes newly added models automatically for selected sources and restricts direct routes to one source', async () => {
    let callsA = 0; let callsB = 0;
    const a = await upstream(async (req, res) => { callsA++; const body = await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'A' } }] })); });
    const b = await upstream(async (req, res) => { callsB++; const body = await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'B' } }] })); });
    const f = await fixture(a.url);
    const bp = f.store.saveProvider({ name: 'B', kind: 'openai-compatible', baseUrl: b.url, enabled: true, apiKey: 'b-api-key' });
    const bm = f.store.saveModel({ ...f.model, id: undefined, providerId: bp.id, alias: 'b-alias', upstreamId: 'b-id' });
    const direct = f.store.listBindings().find(binding => binding.id === 'opencode')!;
    f.store.saveBinding({ ...direct, mode: 'direct', providerIds: [f.provider.id], modelIds: [], enabled: true, defaultModelId: f.model.id });
    const next = f.store.saveModel({ ...f.model, id: undefined, alias: 'a-new', upstreamId: 'a-new-id' });
    const directUrl = f.url.replace('/v1', '/tool/opencode/v1');
    const catalog = await (await fetch(`${directUrl}/models`, { headers: f.headers })).json();
    expect(catalog.data.map((model: { id: string }) => model.id)).toEqual([f.model.alias, next.alias]);
    const denied = await fetch(`${directUrl}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: bm.alias, messages: [] }) });
    expect(denied.status).toBe(403); expect(callsA).toBe(0); expect(callsB).toBe(0);
    const own = await fetch(`${directUrl}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: next.alias, messages: [] }) });
    expect(own.status).toBe(200); expect((await own.json()).choices[0].message.content).toBe('A'); expect(callsA).toBe(1);
  });

  it('aggregates selected providers and routes each public alias to its own upstream', async () => {
    const a = await upstream(async (req, res) => { const body = await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'A' } }] })); });
    const b = await upstream(async (req, res) => { const body = await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'B' } }] })); });
    const f = await fixture(a.url);
    const bp = f.store.saveProvider({ name: 'B', kind: 'openai-compatible', baseUrl: b.url, enabled: true, apiKey: 'b-api-key' });
    const bm = f.store.saveModel({ ...f.model, id: undefined, providerId: bp.id, alias: 'b-alias', upstreamId: 'b-id' });
    const binding = f.store.listBindings().find(item => item.id === 'dsh')!;
    f.store.saveBinding({ ...binding, mode: 'aggregate', providerIds: [f.provider.id, bp.id], modelIds: [], defaultModelId: f.model.id, enabled: true });
    const url = f.url.replace('/v1', '/tool/dsh/v1');
    const catalog = await (await fetch(`${url}/models`, { headers: f.headers })).json();
    expect(catalog.data.map((model: { id: string }) => model.id)).toEqual([f.model.alias, bm.alias]);
    for (const [model, answer] of [[f.model, 'A'], [bm, 'B']] as const) {
      const response = await fetch(`${url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: model.alias, messages: [] }) });
      expect(response.status).toBe(200); expect((await response.json()).choices[0].message.content).toBe(answer);
    }
  });

  it('keeps identically named models from two plans distinct in catalogs and routes to the selected plan', async () => {
    const observedA: string[] = []; const observedB: string[] = [];
    const a = await upstream(async (req, res) => {
      const body = await requestBody(req); observedA.push(body.model);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Agent Plan answer' } }] }));
    });
    const b = await upstream(async (req, res) => {
      const body = await requestBody(req); observedB.push(body.model);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Coding Plan answer' } }] }));
    });
    const f = await fixture(a.url);
    const ap = f.store.saveProvider({ ...f.provider, name: '火山 Agent Plan' });
    const am = f.store.saveModel({ ...f.model, upstreamId: 'glm-5.3', alias: 'glm-5.3', displayName: 'glm-5.3' });
    const bp = f.store.saveProvider({ name: '火山 Coding Plan', kind: 'openai-compatible', baseUrl: b.url, enabled: true, apiKey: 'synthetic-coding-key' });
    const bm = f.store.saveModel({ ...am, id: undefined, providerId: bp.id, alias: 'glm-5.3' });
    expect(am.alias).toBe('glm-5.3');
    expect(bm.alias).toBe(`${bp.id}/glm-5.3`);
    expect(am.displayName).toBe(bm.displayName);
    const binding = f.store.listBindings().find(item => item.id === 'dsh')!;
    f.store.saveBinding({ ...binding, mode: 'aggregate', providerIds: [ap.id, bp.id], modelIds: [], defaultModelId: bm.id, enabled: true });
    const scopedUrl = f.url.replace('/v1', '/tool/dsh/v1');
    const expected = [
      { id: am.alias, display_name: '火山 Agent Plan - glm-5.3', owned_by: ap.name },
      { id: bm.alias, display_name: '火山 Coding Plan - glm-5.3', owned_by: bp.name },
    ];
    for (const url of [f.url, scopedUrl]) {
      const catalog = await (await fetch(`${url}/models`, { headers: f.headers })).json();
      expect(catalog.data).toMatchObject(expected);
      for (const [model, answer] of [[am, 'Agent Plan answer'], [bm, 'Coding Plan answer']] as const) {
        const response = await fetch(`${url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: model.alias, messages: [] }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ model: model.alias, choices: [{ message: { content: answer } }] });
      }
    }
    expect(observedA).toEqual(['glm-5.3', 'glm-5.3']);
    expect(observedB).toEqual(['glm-5.3', 'glm-5.3']);
    const restricted = f.store.listBindings().find(item => item.id === 'vscode')!;
    f.store.saveBinding({ ...restricted, mode: 'aggregate', providerIds: [ap.id], modelIds: [], defaultModelId: am.id, enabled: true });
    const restrictedUrl = f.url.replace('/v1', '/tool/vscode/v1');
    const denied = await fetch(`${restrictedUrl}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: bm.alias, messages: [] }) });
    expect(denied.status).toBe(403);
    expect(observedB).toHaveLength(2);
  });

  it('keeps an empty preset endpoint out of the catalog and never calls its fallback endpoint', async () => {
    let calls = 0;
    const mock = await upstream((_req, res) => { calls++; res.end('{}'); });
    const f = await fixture(mock.url);
    const draft = f.store.saveProvider({ name: 'Pending Token Plan', kind: 'openai-compatible', presetId: 'volcengine-token', baseUrl: '', apiKey: 'draft-key', enabled: true });
    const dm = f.store.saveModel({ ...f.model, id: undefined, providerId: draft.id, alias: 'draft-model' });
    const models = await (await fetch(`${f.url}/models`, { headers: f.headers })).json();
    expect(models.data.some((model: { id: string }) => model.id === dm.alias)).toBe(false);
    expect((await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify({ model: dm.alias, messages: [] }) })).status).toBe(503);
    expect(() => f.store.saveProvider({ name: 'Unknown', kind: 'openai-compatible', presetId: 'unknown' as never, baseUrl: mock.url, enabled: true, apiKey: 'test' })).toThrow(/预设/);
    expect(calls).toBe(0);
    // A draft with an empty endpoint also must not block starting the other sources.
    await f.gateway.stop(); await expect(f.gateway.start(0)).resolves.toMatchObject({ running: true });
  });
});
