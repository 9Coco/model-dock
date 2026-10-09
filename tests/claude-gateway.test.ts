import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import type { WireApi } from '../src/shared/types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()); }
const sse = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
async function fixture(wireApi: WireApi, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, subscription = false, timeoutMs = 5000) {
  const upstream = createServer((request, response) => { void handler(request, response); }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); });
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-claude-gateway-')); const store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const provider = store.saveProvider({ name: 'Synthetic source', kind: subscription ? 'codex' : 'openai-compatible', baseUrl: subscription ? 'https://chatgpt.com/backend-api/codex' : baseUrl + '/v1', enabled: true, ...(subscription ? {} : { apiKey: 'SYNTHETIC_API_KEY' }) });
  if (subscription) store.setSecret(provider.id, { accessToken: 'SYNTHETIC_ROTATED_OAUTH', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3600000 });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'upstream-model', alias: 'local-model', displayName: 'Synthetic model', wireApi, contextWindow: 0, tools: true, vision: false, enabled: true });
  store.saveBinding({ id: 'claude-code', name: 'Claude Code', enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: [], defaultModelId: model.id, note: '' });
  const gateway = new Gateway(store, { timeoutMs, prepareRequest: async (_provider, secret, path, body) => ({ url: baseUrl + path, headers: { Authorization: `Bearer ${subscription ? secret.accessToken : secret.apiKey}`, 'Content-Type': 'application/json' }, body: subscription ? { ...body, stream: true } : body }) });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const url = gateway.status().baseUrl.replace(/\/v1$/, '') + '/tool/claude-code/v1/messages';
  const post = (body: unknown, key = store.gatewayKey()) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { store, post, model, provider };
}
const input = (stream = false) => ({ model: 'local-model', max_tokens: 512, stream, system: 'Synthetic system', messages: [{ role: 'user', content: 'Check the fixture.' }], tools: [{ name: 'read_fixture', description: 'Read a synthetic fixture', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });

describe('Claude local gateway integration', () => {
  it('completes a real localhost Chat tool round trip without exposing source credentials', async () => {
    const requests: any[] = [];
    const f = await fixture('chat-completions', async (request, response) => {
      expect(request.url).toBe('/v1/chat/completions'); expect(request.headers.authorization).toBe('Bearer SYNTHETIC_API_KEY');
      const body = await bodyOf(request); requests.push(body);
      response.setHeader('content-type', 'application/json');
      const message = requests.length === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"fixture"}' } }] } : { role: 'assistant', content: 'Fixture complete.' };
      response.end(JSON.stringify({ id: 'chat_mock', object: 'chat.completion', model: 'upstream-model', choices: [{ message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
    });
    const first = await (await f.post(input())).json();
    expect(first).toMatchObject({ type: 'message', model: 'local-model', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_fixture', name: 'read_fixture', input: { path: 'fixture' } }] });
    const second = await (await f.post({ ...input(), messages: [...input().messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'SYNTHETIC_TOOL_RESULT' }] }] })).json();
    expect(second).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixture complete.' }] });
    expect(requests[1].messages).toEqual(expect.arrayContaining([{ role: 'tool', tool_call_id: 'call_fixture', content: 'SYNTHETIC_TOOL_RESULT' }]));
    expect(requests.every(body => body.model === 'upstream-model')).toBe(true);
    expect(JSON.stringify([first, second, f.store.logs()])).not.toMatch(/SYNTHETIC_API_KEY/);
    expect(f.store.usageRecords('2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')[0]).toMatchObject({ tool: 'claude-code', status: 200, endpoint: '/tool/claude-code/v1/messages' });
  });
  it('collects forced subscription Responses SSE for Claude nonstream requests and preserves function results', async () => {
    const requests: any[] = [];
    const f = await fixture('responses', async (request, response) => {
      expect(request.url).toBe('/v1/responses'); expect(request.headers.authorization).toBe('Bearer SYNTHETIC_ROTATED_OAUTH');
      const body = await bodyOf(request); requests.push(body); expect(body.stream).toBe(true);
      const output = requests.length === 1 ? [{ type: 'function_call', id: 'fc_mock', call_id: 'call_fixture', name: 'read_fixture', arguments: '{"path":"fixture"}', status: 'completed' }] : [{ type: 'message', id: 'msg_mock', role: 'assistant', content: [{ type: 'output_text', text: 'Subscription fixture complete.' }] }];
      response.setHeader('content-type', 'text/event-stream'); response.end(sse('response.completed', { type: 'response.completed', response: { id: 'resp_mock', object: 'response', status: 'completed', model: 'upstream-model', output, usage: { input_tokens: 8, output_tokens: 3 } } }));
    }, true);
    const first = await (await f.post(input())).json(); expect(first.stop_reason).toBe('tool_use');
    const second = await (await f.post({ ...input(), messages: [...input().messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'SYNTHETIC_RESULT' }] }] })).json();
    expect(second.content).toEqual([{ type: 'text', text: 'Subscription fixture complete.' }]);
    expect(requests[1].input).toEqual(expect.arrayContaining([{ type: 'function_call_output', call_id: 'call_fixture', output: 'SYNTHETIC_RESULT' }]));
    expect(JSON.stringify([first, second, f.store.logs()])).not.toMatch(/SYNTHETIC_ROTATED_OAUTH|SYNTHETIC_REFRESH/);
    expect(f.store.usageRecords('2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')[0].usage).toMatchObject({ inputTokens: 8, outputTokens: 3 });
  });
  it('returns proper Messages SSE and marks failed streams without a completion event', async () => {
    const f = await fixture('chat-completions', async (request, response) => {
      const body = await bodyOf(request); response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ id: 'chat_mock', choices: [{ delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] })}\n\n`);
      if (body.messages.some((message: any) => message.content === 'fail')) response.end(`data: ${JSON.stringify({ error: { message: 'SYNTHETIC_API_KEY PRIVATE_UPSTREAM_ERROR' } })}\n\n`);
      else response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
    });
    const success = await (await f.post(input(true))).text(); expect(success).toContain('event: message_start'); expect(success).toContain('event: message_stop');
    const failure = await (await f.post({ ...input(true), messages: [{ role: 'user', content: 'fail' }] })).text();
    expect(failure).toContain('event: error'); expect(failure).not.toContain('event: message_stop'); expect(failure).not.toMatch(/PRIVATE_UPSTREAM_ERROR|SYNTHETIC_API_KEY/);
    expect(f.store.logs()[0].status).toBe(502);
  });
  it('records a legitimate Responses output-budget truncation as a successful Messages reply', async () => {
    const f = await fixture('responses', async (request, response) => {
      await bodyOf(request); response.setHeader('content-type', 'text/event-stream');
      response.end(sse('response.incomplete', { type: 'response.incomplete', response: { id: 'resp_mock', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', id: 'msg_mock', role: 'assistant', content: [{ type: 'output_text', text: 'Partial text.' }] }], usage: { input_tokens: 5, output_tokens: 512 } } }));
    }, true);
    const reply = await (await f.post(input())).json();
    expect(reply).toMatchObject({ type: 'message', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial text.' }] });
    expect(f.store.logs()[0].status).toBe(200);
  });
  it('times out and cancels upstream when a streaming client does not read its body', async () => {
    let closed = false;
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.on('close', () => { closed = true; });
      response.setHeader('content-type', 'text/event-stream');
      const chunk = 'X'.repeat(128 * 1024);
      for (let index = 0; index < 80; index++) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`);
    }, false, 500);
    const client = await f.post(input(true));
    try {
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline && (!closed || !f.store.logs().length)) await new Promise(done => setTimeout(done, 20));
      expect(closed).toBe(true);
      expect(f.store.logs()[0]).toMatchObject({ status: 504 });
    } finally { try { await client.body?.cancel(); } catch { /* cancelled socket */ } }
  });
  it('rejects unsupported thinking and unauthorized client keys before contacting upstream', async () => {
    let calls = 0; const f = await fixture('chat-completions', async (_request, response) => { calls++; response.end('{}'); });
    const auth = await f.post(input(), 'wrong-key'); expect(auth.status).toBe(401); expect(await auth.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    const thinking = await f.post({ ...input(), thinking: { type: 'enabled', budget_tokens: 1000 } }); expect(thinking.status).toBe(400); expect(await thinking.json()).toMatchObject({ type: 'error' }); expect(calls).toBe(0);
  });
});
