import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { buildConfig } from '../src/main/adapters';
import { jetBrainsConnectionParameters } from '../src/shared/jetbrains';
import { ModelCatalog } from '../src/main/catalog';
import { ConnectionTester } from '../src/main/connection-test';
import { Gateway } from '../src/main/gateway';
import { OAuthManager } from '../src/main/oauth';
import { Store } from '../src/main/store';
import { presetById } from '../src/shared/presets';

const relayKey = 'synthetic-local-relay-key';
const liveModel = 'Fixture-Trae-Account-Model';
const secondModel = 'another-account-model';
const fallbackModel = 'offline-built-in-fixture';
const call = { id: 'call_trae_fixture', type: 'function', function: { name: 'read_label', arguments: '{"id":1}' } };
const definition = { type: 'function', function: { name: 'read_label', parameters: { type: 'object', properties: { id: { type: 'integer' } } } } };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function directoryItem(id: string, endpoints: string[]) {
  return { id, object: 'model', owned_by: 'trae', endpoint: endpoints[0], endpoints };
}

async function fixture() {
  const state = { directory: [directoryItem(liveModel, ['remote', 'fallback']), directoryItem(secondModel, ['solo']), directoryItem(fallbackModel, ['fallback'])] };
  const requests: { method: string; route: string; authorization?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: req.method!, route: req.url!, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    // v1.0.10 publicly exposes discovery, including fallback rows when no account is online.
    if (req.method === 'GET' && req.url === '/v1/models') { res.end(JSON.stringify({ object: 'list', data: state.directory })); return; }
    if (req.headers.authorization !== `Bearer ${relayKey}`) { res.writeHead(401); res.end('{"error":{"message":"Private upstream error"}}'); return; }
    if (req.method !== 'POST' || body?.model !== liveModel) { res.writeHead(404); res.end('{}'); return; }
    if (req.url === '/v1/messages') {
      res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: liveModel, content: [{ type: 'text', text: 'Native Messages.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 2 } })); return;
    }
    if (req.url === '/v1/responses') {
      const response = { id: 'resp_fixture', object: 'response', model: liveModel, status: 'completed', output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Native Responses.' }] }] };
      // Exercise forced SSE from a relay even when the aggregate caller requested JSON.
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`); return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: liveModel, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, ...call, function: { name: call.function.name, arguments: '{"id":' } }] }, null));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, null));
      res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    const answer = body.messages.at(-1)?.role === 'tool' ? 'Label resolved.' : 'OK';
    res.end(JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: liveModel, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const folder = mkdtempSync(join(tmpdir(), 'modeldock-trae-relay-'));
  const store = await Store.create(folder);
  cleanups.push(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  const preset = presetById('trae-cn-relay')!;
  const provider = store.saveProvider({ presetId: preset.id, kind: preset.kind, name: preset.name, baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true, apiKey: relayKey });
  const oauth = new OAuthManager(store, { openExternal: async () => { throw new Error('Unexpected external login'); } });
  cleanups.push(() => oauth.dispose());
  return { store, provider, state, requests, oauth, catalog: new ModelCatalog(store, oauth), tester: new ConnectionTester(store, oauth) };
}

describe('TRAE CN relay provider', () => {
  it('discovers only live relay rows, preserving exact case, selection and the preset protocol', async () => {
    const f = await fixture();
    expect(presetById('trae-cn-relay')).toMatchObject({ baseUrl: 'http://127.0.0.1:18080/v1', defaultWireApi: 'chat-completions' });
    expect(f.store.listModels()).toHaveLength(0);
    const directory = await f.catalog.discover(f.provider.id);
    expect(directory.ok).toBe(true);
    expect(directory.models.map(row => row.upstreamId)).toEqual([liveModel, secondModel]);
    expect(f.store.listModels()).toHaveLength(0);
    expect(() => f.catalog.addSelected(f.provider.id, [{ upstreamId: fallbackModel }])).toThrow();
    const { added } = f.catalog.addSelected(f.provider.id, [{ upstreamId: secondModel, wireApi: 'messages' }]);
    expect(added).toHaveLength(1);
    // An explicitly edited row keeps its saved wire, but must not change discovery for other rows.
    const refreshed = await f.catalog.discover(f.provider.id);
    expect(refreshed.models.find(row => row.upstreamId === secondModel)?.wireApi).toBe('messages');
    expect(refreshed.models.find(row => row.upstreamId === liveModel)?.wireApi).toBe('chat-completions');
    f.state.directory = [directoryItem(fallbackModel, ['fallback'])];
    expect((await f.catalog.discover(f.provider.id)).models).toEqual([]);
    expect(() => f.catalog.addSelected(f.provider.id, [{ upstreamId: liveModel }])).toThrow();
    expect(f.store.listModels().map(row => row.upstreamId)).toEqual([secondModel]);
    expect(f.requests.every(req => req.route === '/v1/models' && req.method === 'GET' && req.authorization === `Bearer ${relayKey}`)).toBe(true);
  });

  it('checks authentication by inference even when the public model directory succeeds', async () => {
    const f = await fixture();
    f.store.saveProvider({ ...f.provider, apiKey: 'wrong-relay-key' });
    expect((await f.catalog.discover(f.provider.id)).ok).toBe(true);
    const result = await f.tester.test(f.provider.id, { upstreamId: liveModel, wireApi: 'chat-completions' });
    expect(result).toMatchObject({ ok: false, outcome: 'authentication', statusCode: 401 });
    expect(JSON.stringify(result)).not.toMatch(/wrong-relay-key|Private upstream error/);
    f.store.saveProvider({ ...f.provider, apiKey: relayKey });
    expect(await f.tester.test(f.provider.id, { upstreamId: liveModel, wireApi: 'chat-completions' })).toMatchObject({ ok: true, outcome: 'success', testedModel: liveModel });
    expect(f.requests.map(req => [req.route, req.authorization])).toEqual([
      ['/v1/models', 'Bearer wrong-relay-key'], ['/v1/chat/completions', 'Bearer wrong-relay-key'], ['/v1/chat/completions', `Bearer ${relayKey}`],
    ]);
  });

  it('uses the native client protocol for one shared model in both direct and aggregate modes', async () => {
    const f = await fixture();
    await f.catalog.discover(f.provider.id);
    const { added: [model] } = f.catalog.addSelected(f.provider.id, [{ upstreamId: liveModel, alias: 'shared-relay-alias' }]);
    const bindings = f.store.listBindings().filter(binding => ['codex', 'rider', 'claude-code'].includes(binding.id));
    const saveMode = (mode: 'direct' | 'aggregate') => {
      for (const binding of bindings) f.store.saveBinding({ ...binding, mode, enabled: true, providerIds: [f.provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
    };
    saveMode('direct');
    expect(parseToml(buildConfig(f.store, 'codex', 12345, true).content)).toMatchObject({ model: liveModel, model_providers: { modeldock: { base_url: f.provider.baseUrl, wire_api: 'responses', experimental_bearer_token: relayKey } } });
    expect(JSON.parse(buildConfig(f.store, 'claude-code', 12345, true).content).env).toMatchObject({ ANTHROPIC_BASE_URL: f.provider.baseUrl.replace(/\/v1$/, ''), ANTHROPIC_MODEL: liveModel, ANTHROPIC_AUTH_TOKEN: relayKey });
    const rider = f.store.listBindings().find(binding => binding.id === 'rider')!;
    expect(jetBrainsConnectionParameters(rider, f.store.listModels(), f.store.listProviders(), 12345)).toMatchObject({ kind: 'direct-api', baseUrl: f.provider.baseUrl, modelId: liveModel });
    saveMode('aggregate');
    const gateway = new Gateway(f.store);
    await gateway.start(0); cleanups.push(async () => { await gateway.stop(); });
    const origin = new URL(gateway.status().baseUrl).origin;
    const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    const post = (path: string, body: object) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ ...body, model: model.alias, stream: false }) });
    const input = [{ role: 'user', content: 'Explicit Responses input.' }];
    for (const prefix of ['', '/tool/codex']) {
      const response = await post(`${prefix}/v1/responses`, { input, previous_response_id: 'resp_previous' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ model: model.alias, output: [{ content: [{ text: 'Native Responses.' }] }] });
    }
    const messages = [{ role: 'user', content: 'Explicit Chat or Messages input.' }];
    const chat = await post('/tool/rider/v1/chat/completions', { messages });
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ model: model.alias, choices: [{ message: { content: 'OK' } }] });
    const claude = await post('/tool/claude-code/v1/messages', { messages, max_tokens: 32 });
    expect(claude.status).toBe(200);
    expect(await claude.json()).toMatchObject({ type: 'message', model: model.alias, content: [{ text: 'Native Messages.' }] });
    expect(f.requests.slice(1).map(req => [req.route, req.body.model, req.authorization])).toEqual(['/v1/responses', '/v1/responses', '/v1/chat/completions', '/v1/messages'].map(route => [route, liveModel, `Bearer ${relayKey}`]));
    expect(f.requests[1].body).toMatchObject({ input, previous_response_id: 'resp_previous' });
    expect(f.requests[3].body.messages).toEqual(messages);
    expect(f.store.listModels()).toMatchObject([{ id: model.id, wireApi: 'chat-completions' }]);
  });

  it('routes an aggregate client to the selected relay model, including streamed tool calls and tool results', async () => {
    const f = await fixture();
    await f.catalog.discover(f.provider.id);
    const { added: [model] } = f.catalog.addSelected(f.provider.id, [{ upstreamId: liveModel, alias: 'local-trae', tools: true }]);
    const binding = f.store.listBindings().find(row => row.id === 'opencode')!;
    f.store.saveBinding({ ...binding, enabled: true, mode: 'aggregate', providerIds: [f.provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
    const gateway = new Gateway(f.store, { prepareRequest: (provider, _secret, path, body) => f.oauth.prepareRequest(provider, path, body) });
    await gateway.start(0); cleanups.push(async () => { await gateway.stop(); });
    const base = gateway.status().baseUrl.replace(/\/v1$/, '/tool/opencode/v1');
    const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    const messages = [{ role: 'user', content: 'Resolve label 1.' }];
    const input = { model: model.alias, messages, tools: [definition], stream: true };
    const post = (body: object, authorization = headers.authorization) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { ...headers, authorization }, body: JSON.stringify(body) });
    const listed = await (await fetch(`${base}/models`, { headers })).json();
    expect(listed.data.map((row: { id: string }) => row.id)).toEqual([model.alias]);
    expect((await post(input, `Bearer ${relayKey}`)).status).toBe(401);
    expect((await post({ ...input, model: secondModel })).ok).toBe(false);
    expect(f.requests).toHaveLength(1);
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    expect(frames.pop()).toBe('[DONE]');
    const choices = frames.map(frame => JSON.parse(frame).choices[0]);
    expect(choices.at(-1).finish_reason).toBe('tool_calls');
    const deltas = choices.flatMap(choice => choice.delta.tool_calls ?? []);
    const streamedCall = { id: deltas[0].id, type: deltas[0].type, function: { name: deltas[0].function.name, arguments: deltas.map(delta => delta.function.arguments).join('') } };
    expect(streamedCall).toEqual(call);
    const history = [...messages, { role: 'assistant', content: null, tool_calls: [streamedCall] }, { role: 'tool', tool_call_id: streamedCall.id, content: 'fixture-label' }];
    const done = await post({ ...input, messages: history, stream: false });
    expect(done.status).toBe(200);
    expect((await done.json()).choices[0].message.content).toBe('Label resolved.');
    expect(f.requests.slice(1).map(req => [req.route, req.authorization, req.body.model])).toEqual([
      ['/v1/chat/completions', `Bearer ${relayKey}`, liveModel], ['/v1/chat/completions', `Bearer ${relayKey}`, liveModel],
    ]);
    expect(f.requests[1].body.tools).toEqual([definition]);
    expect(f.requests[2].body.messages).toEqual(history);
    expect(JSON.stringify(f.store.logs())).not.toMatch(/synthetic-local-relay-key|fixture-label|Resolve label/);
  });
});
