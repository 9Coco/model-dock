import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/main/gateway';
import { collectNativeMessagesStream } from '../src/main/native-messages';
import { Store } from '../src/main/store';
import type { Model } from '../src/shared/types';

type Json = Record<string, any>;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const event = (type: string, payload: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const thinking = (round: number) => ({ type: 'thinking', thinking: `SYNTHETIC_THINKING_${round}`, signature: `SYNTHETIC_SIGNATURE_${round}` });
function answer(round: number, tool: boolean): Json {
  return { id: `msg_fixture_${round}`, type: 'message', role: 'assistant', model: 'deepseek-flash',
    content: [thinking(round), tool
      ? { type: 'tool_use', id: `call_fixture_${round}`, name: 'read_fixture', input: { path: `fixture_${round}` } }
      : { type: 'text', text: `SYNTHETIC_ANSWER_${round}` }],
    stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } };
}
function streamingAnswer(round: number, tool: boolean, truncated = false): Response {
  const result = answer(round, tool);
  let raw = event('message_start', { message: { ...result, content: [], stop_reason: null, usage: { ...result.usage, output_tokens: 0 } } });
  raw += event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  raw += event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thinking(round).thinking } });
  raw += event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: thinking(round).signature } });
  raw += event('content_block_stop', { index: 0 });
  const content = result.content[1];
  raw += event('content_block_start', { index: 1, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } });
  raw += event('content_block_delta', { index: 1, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
    : { type: 'text_delta', text: content.text } });
  raw += event('content_block_stop', { index: 1 });
  if (!truncated) raw += event('message_delta', { delta: { stop_reason: result.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } }) + event('message_stop', {});
  const bytes = new TextEncoder().encode(raw);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 31) controller.enqueue(bytes.slice(offset, offset + 31));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(options: {
  provider?: Partial<Parameters<Store['saveProvider']>[0]>;
  wireApi?: Model['wireApi']; upstreamId?: string;
  model?: Partial<Parameters<Store['saveModel']>[0]>;
  upstream?: (body: Json, count: number) => Response;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-vscode-deepseek-'));
  const store = await Store.create(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  // A custom preset at the exact official host must not require preset metadata.
  const provider = store.saveProvider({ name: 'DeepSeek fixture', kind: 'openai-compatible', presetId: 'custom',
    baseUrl: 'https://api.deepseek.com/v1', enabled: true, apiKey: 'SYNTHETIC_DEEPSEEK_KEY', ...options.provider });
  const model = store.saveModel({ providerId: provider.id, upstreamId: options.upstreamId ?? 'deepseek-flash', alias: 'deepseek-local',
    displayName: 'Fixture model', wireApi: options.wireApi ?? 'responses', contextWindow: 1048576,
    thinking: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
    tools: true, vision: true, enabled: true, ...options.model });
  const unselected = store.saveModel({ ...model, id: undefined, upstreamId: 'deepseek-v4-pro', alias: 'deepseek-unselected' });
  store.saveBinding({ id: 'vscode', name: 'VS Code', enabled: true, mode: 'aggregate', providerIds: [provider.id],
    modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const requests: { url: string; headers: Headers; body: Json }[] = [];
  const gateway = new Gateway(store, { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), headers: new Headers(init?.headers), body });
    return options.upstream?.(body, requests.length) ?? streamingAnswer(requests.length, requests.length % 2 === 1);
  } });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const base = gateway.status().baseUrl.replace(/\/v1$/, '');
  const post = (body: Json, route = '/tool/vscode/v1/messages', key = store.gatewayKey()) => fetch(base + route, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'x-api-key': 'SYNTHETIC_CLIENT_KEY', 'x-private-client': 'PRIVATE_CLIENT_VALUE' }, body: JSON.stringify(body),
  });
  return { store, provider, model, unselected, gateway, base, post, requests };
}
const input = () => ({ model: 'deepseek-local', stream: true, max_tokens: 4096,
  thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
  tools: [{ name: 'read_fixture', description: 'Read the synthetic fixture.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  messages: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }] as Json[] });

describe('VS Code official DeepSeek native Messages gateway', () => {
  it.each(['responses', 'chat-completions'] as const)('preserves signed thinking across streamed tool continuation and a new user turn for a saved %s model', async wireApi => {
    const f = await fixture({ wireApi });
    const request = input();
    for (let round = 1; round <= 4; round++) {
      const response = await f.post(request); expect(response.status).toBe(200);
      const result = await collectNativeMessagesStream(response.body!, f.model.alias);
      expect(result).toMatchObject({ model: f.model.alias, content: answer(round, round % 2 === 1).content });
      const sent = f.requests[round - 1];
      expect(sent.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
      expect(sent.body).toEqual({ ...request, model: 'deepseek-flash' });
      expect(sent.headers.get('authorization')).toBe('Bearer SYNTHETIC_DEEPSEEK_KEY');
      expect(sent.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(sent.headers.has('x-api-key')).toBe(false); expect(sent.headers.has('x-private-client')).toBe(false);
      request.messages.push({ role: 'assistant', content: result.content });
      if (round % 2 === 1) request.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_fixture_${round}`, content: `SYNTHETIC_RESULT_${round}` }] });
      else if (round < 4) request.messages.push({ role: 'user', content: 'SYNTHETIC_SECOND_TURN' });
    }
    expect(f.requests[3].body.messages.filter((message: Json) => message.role === 'assistant').map((message: Json) => message.content[0]))
      .toEqual([thinking(1), thinking(2), thinking(3)]);
    expect(f.store.listModels().find(model => model.id === f.model.id)?.wireApi).toBe(wireApi);
    expect(f.store.getProvider(f.provider.id)).toEqual(f.provider);
    const catalog = await (await fetch(f.base + '/tool/vscode/v1/models', { headers: { authorization: `Bearer ${f.store.gatewayKey()}` } })).json();
    expect(catalog.data).toMatchObject([{ id: f.model.alias, wire_api: 'messages' }]);
    expect(catalog.data).toHaveLength(1);
    expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_(?:PROMPT|THINKING|SIGNATURE|DEEPSEEK_KEY)|PRIVATE_CLIENT_VALUE/);
  });

  it('uses the same native route for JSON output without changing the stored provider configuration', async () => {
    const f = await fixture({ provider: { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', messagesAuth: 'api-key' }, upstream: () => Response.json(answer(1, true)) });
    const response = await f.post({ ...input(), stream: false }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: f.model.alias, content: answer(1, true).content });
    expect(f.requests[0].headers.get('authorization')).toBe('Bearer SYNTHETIC_DEEPSEEK_KEY');
    expect(f.requests[0].headers.has('x-api-key')).toBe(false);
    expect(f.store.getProvider(f.provider.id)?.messagesAuth).toBe('api-key');
  });

  it.each([
    { provider: { baseUrl: 'https://proxy.example/v1', presetId: 'deepseek' as const } },
    { provider: { baseUrl: 'https://api.deepseek.com.evil.example/v1' } },
    { provider: { baseUrl: 'https://api.deepseek.com/not-a-supported-path' } },
    { provider: { claudeBaseUrl: 'https://another.example/anthropic' } },
    { upstreamId: 'deepseek-similar-unknown' },
  ])('does not enable the VS Code Messages exception for an unverified endpoint/model: %j', async options => {
    const f = await fixture(options);
    const response = await f.post(input()); expect(response.status).toBe(404);
    expect(f.requests).toHaveLength(0);
  });

  it('retains local authentication, exact model selection, and other tools protocol boundaries', async () => {
    const f = await fixture();
    expect((await f.post(input(), '/tool/vscode/v1/messages', 'INVALID_LOCAL_KEY')).status).toBe(401);
    expect((await f.post({ ...input(), model: f.unselected.alias })).status).toBe(403);
    expect((await f.post(input(), '/tool/opencode/v1/messages')).status).toBe(404);
    expect(f.requests).toHaveLength(0);
  });

  it('keeps existing Responses requests on their saved native protocol', async () => {
    const f = await fixture({ upstream: () => Response.json({ id: 'resp_fixture', object: 'response', status: 'completed', model: 'deepseek-flash',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_RESPONSE' }] }] }) });
    const response = await f.post({ model: f.model.alias, input: 'SYNTHETIC_RESPONSE_INPUT', stream: false }, '/tool/vscode/v1/responses');
    expect(response.status).toBe(200); await response.json();
    expect(f.requests[0].url).toBe('https://api.deepseek.com/v1/responses');
    expect(f.requests[0].body).toEqual({ model: 'deepseek-flash', input: 'SYNTHETIC_RESPONSE_INPUT', stream: false });
  });

  it.each([
    { wireApi: 'chat-completions' as const, baseUrl: 'https://api.deepseek.com', model: { thinking: false } },
    { wireApi: 'messages' as const, baseUrl: 'https://api.deepseek.com/v1', model: { thinking: false } },
    { wireApi: 'chat-completions' as const, baseUrl: 'https://api.deepseek.com/anthropic', model: { reasoningEfforts: ['none', 'low', 'high', 'max'] as Model['reasoningEfforts'], defaultReasoningEffort: 'none' as const } },
    { wireApi: 'messages' as const, baseUrl: 'https://api.deepseek.com/anthropic/v1', model: { reasoningEfforts: ['none', 'low', 'high', 'max'] as Model['reasoningEfforts'], defaultReasoningEffort: 'none' as const } },
  ])('honors explicit thinking off through native Responses without changing saved %s metadata', async ({ wireApi, baseUrl, model }) => {
    const f = await fixture({ wireApi, provider: { baseUrl }, model,
      upstream: () => Response.json({ id: 'resp_off', object: 'response', status: 'completed', model: 'deepseek-flash',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_OFF_RESPONSE' }] }] }) });
    const request = { model: f.model.alias, input: 'SYNTHETIC_OFF_INPUT', reasoning: { effort: 'none' }, stream: false };
    const response = await f.post(request, '/tool/vscode/v1/responses');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ model: f.model.alias, status: 'completed' });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].url).toBe('https://api.deepseek.com/responses');
    expect(f.requests[0].headers.get('authorization')).toBe('Bearer SYNTHETIC_DEEPSEEK_KEY');
    expect(f.requests[0].body).toEqual({ ...request, model: 'deepseek-flash' });
    expect(f.requests[0].body).not.toHaveProperty('thinking');
    expect(f.store.listModels().find(value => value.id === f.model.id)).toEqual(f.model);
    expect(f.store.getProvider(f.provider.id)).toEqual(f.provider);
    const catalog = await (await fetch(f.base + '/tool/vscode/v1/models', { headers: { authorization: `Bearer ${f.store.gatewayKey()}` } })).json();
    expect(catalog.data).toMatchObject([{ id: f.model.alias, wire_api: 'responses' }]); expect(catalog.data).toHaveLength(1);
    expect((await f.post(input())).status).toBe(404);
    expect(f.requests).toHaveLength(1);
  });

  it('does not report a successful message_stop after a truncated native stream', async () => {
    const f = await fixture({ upstream: () => streamingAnswer(1, true, true) });
    const response = await f.post(input()); expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).toContain('thinking_delta'); expect(raw).toContain('signature_delta');
    expect(raw).toContain('event: error'); expect(raw).not.toContain('event: message_stop');
    expect(f.requests).toHaveLength(1);
  });
});
