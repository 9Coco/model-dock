import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { bindingConnectionPolicy } from '../src/shared/bindings';
import { JETBRAINS_TOOL_IDS } from '../src/shared/jetbrains';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); return JSON.parse(Buffer.concat(chunks).toString()); }
async function fixture() {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    expect(request.url).toBe('/v1/responses'); expect(request.headers.authorization).toBe('Bearer SYNTHETIC_SUB_TOKEN');
    const body = await bodyOf(request); bodies.push(body);
    const tools = body.input.some((item: any) => item.type === 'function_call_output');
    const output = tools ? [{ type: 'message', id: 'msg_mock', role: 'assistant', content: [{ type: 'output_text', text: 'Tool result received.' }] }] : [{ type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: 'read_fixture', arguments: '{"path":"fixture"}' }];
    response.setHeader('content-type', 'text/event-stream');
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_mock', object: 'response', status: 'completed', model: 'upstream-model', output, usage: { input_tokens: 9, output_tokens: 4 } } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-jb-gateway-')), store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Synthetic subscription', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(provider.id, { accessToken: 'SYNTHETIC_SUB_TOKEN', refreshToken: 'SYNTHETIC_REFRESH_TOKEN', expiresAt: Date.now() + 3600000 });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'upstream-model', alias: 'local-alias', displayName: 'Synthetic model', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true });
  const second = store.saveModel({ ...model, id: undefined, upstreamId: 'second-upstream', alias: 'second-alias' });
  for (const tool of JETBRAINS_TOOL_IDS) store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const gateway = new Gateway(store, { prepareRequest: async (_provider, secret, path, body) => ({ url: address + path, headers: { authorization: `Bearer ${secret.accessToken}` }, body: { ...body, stream: true } }) });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const root = gateway.status().baseUrl.replace(/\/v1$/, ''), headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const post = (tool: string, body: unknown) => fetch(`${root}/tool/${tool}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { store, bodies, model, second, provider, gateway, root, headers, post };
}
const input = (stream = false) => ({ model: 'local-alias', stream, messages: [{ role: 'user', content: 'Read a synthetic fixture.' }], tools: [{ type: 'function', function: { name: 'read_fixture', parameters: { type: 'object' } } }] });

describe('JetBrains tool-scoped subscription gateway', () => {
  it.each(JETBRAINS_TOOL_IDS)('%s lists only its authorized models and completes a Responses-backed Chat tool round trip', async tool => {
    const f = await fixture();
    expect(bindingConnectionPolicy(f.store.listBindings().find(binding => binding.id === tool)!, f.store.listModels(), f.store.listProviders()).groups[0]).toMatchObject({ connection: 'local-managed', providerIds: [f.provider.id] });
    const catalog = await (await fetch(`${f.root}/tool/${tool}/v1/models`, { headers: f.headers })).json(); expect(catalog.data.map((model: any) => model.id)).toEqual([f.model.alias]);
    const first = await (await f.post(tool, input())).json();
    expect(first).toMatchObject({ object: 'chat.completion', model: 'local-alias', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'call_mock', function: { name: 'read_fixture', arguments: '{"path":"fixture"}' } }] } }] });
    const result = await (await f.post(tool, { ...input(), messages: [...input().messages, first.choices[0].message, { role: 'tool', tool_call_id: 'call_mock', content: 'SYNTHETIC_RESULT' }] })).json();
    expect(result.choices[0].message.content).toBe('Tool result received.');
    expect(f.bodies[1].input).toEqual(expect.arrayContaining([{ type: 'function_call_output', call_id: 'call_mock', output: 'SYNTHETIC_RESULT' }]));
    expect(f.bodies.every(body => body.model === 'upstream-model')).toBe(true);
    expect(JSON.stringify([catalog, first, result, f.store.logs()])).not.toMatch(/SYNTHETIC_SUB_TOKEN|SYNTHETIC_REFRESH_TOKEN/);
    expect(result.usage).toEqual({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
    expect(f.store.logs()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 200, endpoint: '/v1/chat/completions' })]));
    expect((await f.post(tool, { ...input(), model: f.second.alias })).status).toBe(403);
    expect(f.bodies).toHaveLength(2);
  });
  it('keeps conversion scoped to JetBrains and returns valid Chat SSE when requested', async () => {
    const f = await fixture();
    const body = await (await f.post('webstorm', input(true))).text(); expect(body).toContain('"tool_calls"'); expect(body).toContain('data: [DONE]'); expect(body).not.toContain('message_start');
    const original = await fetch(`${f.gateway.status().baseUrl}/chat/completions`, { method: 'POST', headers: f.headers, body: JSON.stringify(input()) });
    expect(original.status).toBe(400); expect(f.bodies).toHaveLength(1);
  });
});
