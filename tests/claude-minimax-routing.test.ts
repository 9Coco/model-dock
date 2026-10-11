import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
const frame = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const input = (stream = false) => ({ model: 'fixture-minimax', max_tokens: 256, stream, system: 'Keep this instruction.', output_config: { effort: 'high' },
  messages: [{ role: 'user', content: 'Read the fixture.' }], tools: [{ name: 'read_fixture', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] });
async function fixture(presetId: 'volcengine-agent' | 'volcengine-token', modelPatch: Record<string, unknown> = {}, providerPatch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-m3-routing-'));
  const store = await Store.create(dir);
  cleanups.push(() => { store.close(); if (!dir.startsWith(join(tmpdir(), 'modeldock-m3-routing-'))) throw new Error('Invalid fixture cleanup'); rmSync(dir, { recursive: true, force: true }); });
  const base = presetId === 'volcengine-token' ? 'coding' : 'plan';
  const provider = store.saveProvider({ name: 'Fixture Ark', presetId, kind: 'openai-compatible', enabled: true, baseUrl: `https://ark.cn-beijing.volces.com/api/${base}/v3`, apiKey: 'SYNTHETIC_ARK_KEY', ...providerPatch });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'minimax-m3', alias: 'fixture-minimax', displayName: 'Fixture MiniMax', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true, ...modelPatch });
  store.saveBinding({ id: 'claude-code', name: 'Claude', enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], defaultModelId: model.id, note: '' });
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const gateway = new Gateway(store, { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)); const headers = new Headers(init?.headers); calls.push({ url: String(url), body, headers });
    if (String(url).endsWith('/messages')) return new Response(JSON.stringify({ id: 'msg_native', type: 'message', role: 'assistant', model: model.upstreamId,
      content: [{ type: 'text', text: 'Native completed.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    const output = calls.length === 1
      ? [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'read_fixture', arguments: '{"value":"fixture"}', status: 'completed' }]
      : [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture title.' }] }];
    const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: model.upstreamId, output, usage: { input_tokens: 2, output_tokens: 3 } };
    return new Response(body.stream ? frame('response.completed', { type: 'response.completed', response }) : JSON.stringify(response), { headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' } });
  } });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const post = (body: unknown, route = '/tool/claude-code/v1/messages') => fetch(gateway.status().baseUrl.replace(/\/v1$/, '') + route,
    { method: 'POST', headers: { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json', 'anthropic-beta': 'SYNTHETIC_BETA' }, body: JSON.stringify(body) });
  return { store, provider, model, gateway, calls, post, base };
}

describe('Claude MiniMax M3 verified Responses route', () => {
  it.each(['volcengine-agent', 'volcengine-token'] as const)('preserves a two-turn tool round trip for %s without changing global metadata', async preset => {
    const f = await fixture(preset); const first = await (await f.post(input())).json();
    expect(first).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_fixture', name: 'read_fixture', input: { value: 'fixture' } }] });
    const second = await (await f.post({ ...input(), messages: [...input().messages, { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'Actual fixture result.' }] }] })).json();
    expect(second).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixture title.' }] });
    expect(f.calls.every(c => c.url === `https://ark.cn-beijing.volces.com/api/${f.base}/v3/responses` && c.body.model === 'minimax-m3')).toBe(true);
    expect(f.calls[0].body).toMatchObject({ instructions: 'Keep this instruction.', reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'read_fixture' }] });
    expect(f.calls[1].body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_fixture', output: 'Actual fixture result.' });
    expect(f.calls[0].headers.get('authorization')).toBe('Bearer SYNTHETIC_ARK_KEY'); expect(f.calls[0].headers.has('anthropic-beta')).toBe(false);
    expect(f.store.listModels()[0].wireApi).toBe('responses'); expect(f.store.getProvider(f.provider.id)?.baseUrl).toBe(f.provider.baseUrl);
    expect(JSON.stringify([first, second, f.store.logs()])).not.toContain('SYNTHETIC_ARK_KEY');
  });
  it('converts completed Responses SSE into a complete Claude tool-use stream', async () => {
    const f = await fixture('volcengine-token'); const raw = await (await f.post(input(true))).text();
    expect(raw).toContain('"type":"tool_use"'); expect(raw).toContain('"partial_json":"{\\"value\\":\\"fixture\\"}"');
    expect(raw).toContain('event: message_stop'); expect(raw).not.toContain('event: error');
    expect(f.store.logs()[0].status).toBe(200);
  });
  it.each(['thinking', 'redacted_thinking', 'server_tool_use', 'web_fetch_tool_result'])('refuses %s history without dropping it or sending it upstream', async type => {
    const f = await fixture('volcengine-token'); const response = await f.post({ ...input(), messages: [input().messages[0],
      { role: 'assistant', content: [{ type, thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE', text: 'PRIVATE_SERVER_CONTENT' }] }, { role: 'user', content: 'Continue.' }] });
    expect(response.status).toBe(400); const error = await response.json(); expect(error.error.message).toContain('新建聊天');
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_THINKING|PRIVATE_SIGNATURE|PRIVATE_SERVER_CONTENT/); expect(f.calls).toHaveLength(0);
  });
  it.each([{ upstreamId: 'glm-5.3' }, { upstreamId: 'kimi-k3' }, { wireApi: 'messages' }])('keeps other native choices on the official Messages endpoint', async modelPatch => {
    const f = await fixture('volcengine-token', modelPatch); const reply = await (await f.post(input())).json();
    expect(reply.stop_reason).toBe('end_turn'); expect(f.calls[0].url).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages');
  });
  it('preserves an explicit native override and global Messages endpoint behavior', async () => {
    const f = await fixture('volcengine-token', {}, { claudeBaseUrl: 'https://custom.example.test/native' });
    await f.post(input()); expect(f.calls[0].url).toBe('https://custom.example.test/native/v1/messages');
    const global = await fixture('volcengine-token'); await global.post(input(), '/v1/messages');
    expect(global.calls[0].url).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages');
  });
  it('does not turn direct mode into a local forwarding mode', async () => {
    const f = await fixture('volcengine-token'); const previous = f.store.listBindings().find(b => b.id === 'claude-code')!;
    f.store.saveBinding({ ...previous, mode: 'direct' }); const response = await f.post(input());
    expect(response.status).toBe(403); expect(f.calls).toHaveLength(0);
  });
});
