import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { collectNativeMessagesStream } from '../src/main/native-messages';
import type { Model, ProviderInput } from '../src/shared/types';

type Json = Record<string, any>;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
const thinking = { type: 'thinking', thinking: 'SYNTHETIC_THINKING', signature: 'SYNTHETIC_SIGNATURE' };
const event = (type: string, value: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
function nativeAnswer(stream: boolean, truncated = false): Response {
  const result = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-flash',
    content: [thinking, { type: 'tool_use', id: 'call_fixture', name: 'read_fixture', input: { path: 'fixture' } }],
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
  if (!stream) return Response.json(result);
  let raw = event('message_start', { message: { ...result, content: [], stop_reason: null } });
  raw += event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  raw += event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thinking.thinking } });
  raw += event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: thinking.signature } });
  raw += event('content_block_stop', { index: 0 });
  raw += event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_fixture', name: 'read_fixture', input: {} } });
  raw += event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"fixture"}' } });
  raw += event('content_block_stop', { index: 1 });
  if (!truncated) raw += event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }) + event('message_stop', {});
  return new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(options: { wire?: Model['wireApi']; provider?: Partial<ProviderInput>; response?: (body: Json, count: number) => Response } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-air-gateway-'));
  const store = await Store.create(directory);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Air native fixture', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'SYNTHETIC_UPSTREAM_KEY', enabled: true, ...options.provider });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'deepseek-flash', alias: 'air-model', displayName: 'Air fixture', wireApi: options.wire ?? 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const excluded = store.saveModel({ ...model, id: undefined, alias: 'excluded-model', upstreamId: 'excluded' });
  store.saveBinding({ id: 'air', name: 'Air', airProvider: 'anthropic', mode: 'aggregate', enabled: true, providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const calls: { url: string; body: Json; headers: Headers }[] = [];
  const gateway = new Gateway(store, { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body, headers: new Headers(init?.headers) });
    return options.response?.(body, calls.length) ?? nativeAnswer(body.stream === true);
  } });
  await gateway.start(0); cleanup.push(() => gateway.stop().then(() => undefined));
  const origin = gateway.status().baseUrl.replace(/\/v1$/, '');
  const headers = { 'x-api-key': store.gatewayKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  const input = (stream = false) => ({ model: model.alias, max_tokens: 128, stream, messages: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }] });
  const post = (body: Json, path = '/tool/air/v1/messages', authorization = headers) => fetch(origin + path, { method: 'POST', headers: authorization, body: JSON.stringify(body) });
  return { store, provider, model, excluded, origin, headers, input, post, calls };
}

describe('Air native Accounts protocol routing', () => {
  it('accepts Air Anthropic model probes with scoped x-api-key and returns its authorized native model catalog', async () => {
    const f = await fixture({ wire: 'messages' });
    const result = await fetch(f.origin + '/tool/air/v1/models', { headers: f.headers });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ has_more: false, first_id: f.model.alias, last_id: f.model.alias,
      data: [{ id: f.model.alias, type: 'model', display_name: expect.any(String), created_at: '1970-01-01T00:00:00Z', wire_api: 'messages' }] });
    for (const path of ['/v1/models', '/tool/vscode/v1/models', '/tool/air/v1/responses']) expect((await fetch(f.origin + path, { headers: f.headers })).status).toBe(401);
    expect((await fetch(f.origin + '/tool/air/v1/models', { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
    expect((await f.post({ ...f.input(), model: f.excluded.alias })).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  it('streams native signed thinking and tools, preserving the exact continuation history and upstream credential', async () => {
    const f = await fixture();
    const response = await f.post(f.input(true));
    expect(response.status).toBe(200);
    const message = await collectNativeMessagesStream(response.body!, f.model.alias);
    expect(message.content).toEqual([thinking, { type: 'tool_use', id: 'call_fixture', name: 'read_fixture', input: { path: 'fixture' } }]);
    const history = [...f.input().messages, { role: 'assistant', content: message.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'SYNTHETIC_RESULT' }] }];
    expect((await f.post({ ...f.input(), messages: history })).status).toBe(200);
    expect(f.calls[1].body.messages).toEqual(history);
    expect(f.calls.every(call => call.url === 'https://api.deepseek.com/anthropic/v1/messages')).toBe(true);
    expect(f.calls[0].headers.get('authorization')).toBe('Bearer SYNTHETIC_UPSTREAM_KEY');
    expect(f.calls[0].headers.get('x-api-key')).toBeNull();
  });

  it.each(['chat-completions', 'responses'] as const)('bridges an Air Anthropic tool round trip to the selected native %s source', async wire => {
    const f = await fixture({ wire, provider: { presetId: 'custom', baseUrl: 'https://fixture.test/v1' }, response: (body, count) => {
      const tool = count === 1;
      return Response.json(wire === 'responses'
        ? { id: 'resp_fixture', object: 'response', status: 'completed', model: body.model, output: tool
          ? [{ type: 'function_call', call_id: 'call_fixture', name: 'read_fixture', arguments: '{"path":"fixture"}' }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE' }] }], usage: { input_tokens: 10, output_tokens: 4 } }
        : { id: 'chat_fixture', object: 'chat.completion', model: body.model, choices: [{ message: tool
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"fixture"}' } }] }
          : { role: 'assistant', content: 'DONE' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    } });
    const first = await (await f.post(f.input())).json();
    expect(first).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_fixture' }] });
    const second = await (await f.post({ ...f.input(), messages: [...f.input().messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'SYNTHETIC_RESULT' }] }] })).json();
    expect(second).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'DONE' }] });
    expect(f.calls[0].url).toBe('https://fixture.test/v1/' + (wire === 'responses' ? 'responses' : 'chat/completions'));
    expect(JSON.stringify(f.calls[1].body)).toContain('SYNTHETIC_RESULT');
  });

  it('retains OpenAI and other tool boundaries, and disables the aggregate route when direct is selected', async () => {
    const f = await fixture({ wire: 'messages' });
    const binding = f.store.listBindings().find(item => item.id === 'air')!;
    const bearer = { ...f.headers, authorization: `Bearer ${f.store.gatewayKey()}` };
    expect((await f.post(f.input(), '/tool/air/v1/chat/completions', bearer)).status).toBe(404);
    expect((await f.post(f.input(), '/tool/junie/v1/messages', bearer)).status).toBe(404);
    f.store.saveBinding({ ...binding, airProvider: 'openai', defaultModelId: '' });
    expect((await fetch(f.origin + '/tool/air/v1/models', { headers: f.headers })).status).toBe(401);
    expect((await (await fetch(f.origin + '/tool/air/v1/models', { headers: bearer })).json()).data).toEqual([]);
    expect((await f.post(f.input(), '/tool/air/v1/messages', bearer)).status).toBe(404);
    f.store.saveBinding({ ...binding, mode: 'direct' });
    expect((await f.post(f.input(), '/tool/air/v1/messages', bearer)).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  it('does not manufacture a successful stop after a truncated native stream', async () => {
    const f = await fixture({ response: () => nativeAnswer(true, true) });
    const response = await f.post(f.input(true));
    const output = await response.text().catch(() => 'truncated');
    expect(output).not.toContain('event: message_stop');
    expect(f.store.logs().at(0)?.status).toBe(502);
  });
});
