import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/main/gateway';
import { Store } from '../src/main/store';
import type { Model } from '../src/shared/types';

type Json = Record<string, any>;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
const localCall = { type: 'function_call', call_id: '8435e3ba-a537-4b89-890f-d7e5178a4081', name: 'read_bash', arguments: '{}' };
const realCall = { type: 'function_call', call_id: 'call_00_fixture', name: 'read_bash', arguments: '{}' };
const reasoning = (text: string) => ({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text }] });
const toolResult = (call: Json) => ({ type: 'function_call_output', call_id: call.call_id, output: 'SYNTHETIC_RESULT' });
const request = (input: Json[] = [], effort = 'max') => ({
  stream: true, reasoning: { effort },
  input: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }, ...input],
});
const outputReasoning = { ...reasoning('SYNTHETIC_THINKING'), id: 'rs_fixture', encrypted_content: 'SYNTHETIC_OPAQUE' };
const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'deepseek-flash', output: [outputReasoning, realCall] };
const streamEvent = (type: string, payload: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const chatPath = '/tool/vscode/v1/chat/completions';
const chatTool = (id: string, name = 'read_bash') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const chatChunk = (delta: Json, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: 'chat_fixture', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

async function fixture(wireApi: Model['wireApi'] = 'responses', thinking = true, baseUrl = 'https://api.deepseek.com/anthropic/v1') {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-vscode-deepseek-'));
  const store = await Store.create(directory);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Official fixture', kind: 'openai-compatible', presetId: 'custom', baseUrl, enabled: true, apiKey: 'SYNTHETIC_KEY' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'deepseek-flash', alias: 'local-flash', displayName: 'Flash',
    wireApi, contextWindow: 1048576, thinking, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', tools: true, vision: true, enabled: true });
  const unselected = store.saveModel({ ...model, id: undefined, alias: 'unselected', upstreamId: 'deepseek-v4-pro' });
  store.saveBinding({ id: 'vscode', name: 'VS Code', mode: 'aggregate', enabled: true, providerIds: [provider.id],
    modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const calls: { url: string; body: Json; headers: Headers }[] = [];
  const gateway = new Gateway(store, { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (new URL(String(url)).pathname.endsWith('/chat/completions')) {
      if (body.stream) return new Response(chatChunk({ role: 'assistant', reasoning_content: 'SYNTHETIC_THINKING' })
        + chatChunk({ tool_calls: [{ index: 0, ...chatTool(realCall.call_id) }] }) + chatChunk({}, 'tool_calls') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ id: 'chat_fixture', object: 'chat.completion', model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'SYNTHETIC_ANSWER' }, finish_reason: 'stop' }] });
    }
    return body.stream ? new Response(
      streamEvent('response.reasoning_text.delta', { item_id: 'rs_fixture', output_index: 0, content_index: 0, delta: 'SYNTHETIC_THINKING' })
      + streamEvent('response.output_item.done', { output_index: 0, item: outputReasoning })
      + streamEvent('response.completed', { response }), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(response);
  } });
  await gateway.start(0); cleanup.push(() => gateway.stop().then(() => undefined));
  const origin = gateway.status().baseUrl.replace(/\/v1$/, '');
  const auth = { authorization: `Bearer ${store.gatewayKey()}` };
  const post = (body: Json, path = '/tool/vscode/v1/responses', headers = auth) => fetch(origin + path, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.alias, ...body }),
  });
  return { store, provider, model, unselected, origin, auth, post, calls };
}

describe('VS Code official DeepSeek gateway', () => {
  it.each(['responses', 'chat-completions', 'messages'] as const)('routes native Chat for saved %s and replays tool calls and thinking', async wireApi => {
    const f = await fixture(wireApi);
    const user = { role: 'user', content: 'SYNTHETIC_PROMPT' };
    const first = await f.post({ messages: [user], stream: true, reasoning_effort: 'max' }, chatPath);
    expect(first.status).toBe(200);
    const stream = await first.text();
    expect(stream).toContain('"reasoning_content":"SYNTHETIC_THINKING"');
    expect(stream).toContain('"model":"local-flash"');
    expect(stream).toContain('"finish_reason":"tool_calls"');
    expect(stream).toContain('data: [DONE]');
    const real = { role: 'assistant', content: null, reasoning_content: 'SYNTHETIC_THINKING', tool_calls: [chatTool(realCall.call_id)] };
    const synthetic = { role: 'assistant', content: null, tool_calls: [chatTool(localCall.call_id)] };
    const result = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'SYNTHETIC_RESULT' });
    const messages = [user, real, result(realCall.call_id), synthetic, result(localCall.call_id)];
    const second = await f.post({ messages, reasoning_effort: 'low' }, chatPath);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ object: 'chat.completion', model: f.model.alias, choices: [{ message: { content: 'SYNTHETIC_ANSWER' } }] });
    expect(f.calls.map(call => call.url)).toEqual(Array(2).fill('https://api.deepseek.com/chat/completions'));
    expect(f.calls[0].body).toEqual({ model: 'deepseek-flash', messages: [user], stream: true, reasoning_effort: 'max' });
    expect(f.calls[1].body).toEqual({ model: 'deepseek-flash', messages: [user, real, result(realCall.call_id),
      { ...synthetic, reasoning_content: ' ' }, result(localCall.call_id)], reasoning_effort: 'low' });
    expect(f.calls[1].headers.get('authorization')).toBe('Bearer SYNTHETIC_KEY');
    expect(f.store.listModels().find(model => model.id === f.model.id)).toEqual(f.model);
  });

  it('uses the model Chat effort by default and respects its explicit off setting', async () => {
    const enabled = await fixture();
    const messages = [{ role: 'user', content: 'Hi' }];
    await (await enabled.post({ messages }, chatPath)).json();
    expect(enabled.calls[0].body).toEqual({ messages, model: 'deepseek-flash', reasoning_effort: 'high' });
    const disabled = await fixture('messages', false);
    await (await disabled.post({ messages, reasoning_effort: 'max', thinking: { type: 'enabled' } }, chatPath)).json();
    expect(disabled.calls[0].body).toEqual({ messages, model: 'deepseek-flash', reasoning_effort: 'none', thinking: { type: 'disabled' } });
  });

  it.each(['responses', 'chat-completions', 'messages'] as const)('retains thinking and resumes a local background callback for saved %s', async wireApi => {
    const f = await fixture(wireApi);
    const first = await f.post(request());
    expect(first.status).toBe(200);
    const stream = await first.text();
    expect(stream).toContain('event: response.reasoning_summary_text.delta');
    expect(stream).toContain('SYNTHETIC_OPAQUE');
    expect(stream).toContain('event: response.completed');

    const history = [outputReasoning, realCall, toolResult(realCall), { role: 'user', content: 'Shell completed.' }, localCall, toolResult(localCall)];
    const next = request(history, 'high');
    expect((await f.post(next)).status).toBe(200);
    expect(f.calls[1].body).toEqual({ ...next, model: f.model.upstreamId, input: [...next.input.slice(0, -2), reasoning(' '), ...next.input.slice(-2)] });
    expect(f.calls[0].body.reasoning).toEqual({ effort: 'max' });
    expect(f.calls.every(call => call.url === 'https://api.deepseek.com/responses')).toBe(true);
    expect(f.calls[1].headers.get('authorization')).toBe('Bearer SYNTHETIC_KEY');
    expect(f.store.listModels().find(model => model.id === f.model.id)).toEqual(f.model);
    expect(f.store.getProvider(f.provider.id)).toEqual(f.provider);
    expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_(?:PROMPT|THINKING|OPAQUE|KEY)/);
  });

  it('preserves real reasoning and leaves genuine calls and unmatched callbacks alone', async () => {
    const f = await fixture();
    const next = { ...request([realCall, toolResult(realCall), { role: 'user', content: 'Shell completed.' },
      reasoning('existing thought'), localCall, toolResult(localCall), { ...localCall, call_id: '1435e3ba-a537-4b89-890f-d7e5178a4081' }]), stream: false };
    expect((await f.post(next)).status).toBe(200);
    expect(f.calls[0].body.input).toEqual(next.input);
  });

  it('uses the configured default and preserves explicit non-thinking configurations', async () => {
    const enabled = await fixture();
    await (await enabled.post({ input: 'Hello' })).json();
    expect(enabled.calls[0].body.reasoning).toEqual({ effort: 'high' });
    const disabled = await fixture('responses', false);
    const next = { ...request([localCall, toolResult(localCall)]), stream: false };
    await (await disabled.post(next)).json();
    expect(disabled.calls[0].body).toEqual({ ...next, model: 'deepseek-flash', reasoning: { effort: 'none' } });
  });

  it('restricts model access and limits Messages to Claude Code', async () => {
    const f = await fixture();
    expect((await f.post(request(), '/tool/vscode/v1/responses', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await f.post({ ...request(), model: f.unselected.alias })).status).toBe(403);
    for (const path of ['/tool/vscode/v1/messages', '/tool/air/v1/messages', '/v1/messages']) {
      expect((await f.post(request(), path)).status).toBe(404);
    }
    const catalog = await (await fetch(f.origin + '/tool/vscode/v1/models', { headers: f.auth })).json();
    expect(catalog.data).toMatchObject([{ id: f.model.alias, wire_api: 'chat-completions' }]);
    expect(catalog.data).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });

  it('does not rewrite DeepSeek-shaped models on an unverified provider', async () => {
    const f = await fixture('responses', true, 'https://api.deepseek.com.example/v1');
    const next = { ...request([localCall, toolResult(localCall)]), stream: false };
    expect((await f.post(next)).status).toBe(200);
    expect(f.calls[0].body).toEqual({ ...next, model: 'deepseek-flash' });
  });
});
