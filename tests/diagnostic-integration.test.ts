import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { Gateway, type GatewayOptions } from '../src/main/gateway';
import { ConnectionTester } from '../src/main/connection-test';
import { prepareUpstream } from '../src/main/oauth';
import type { DiagnosticContext, DiagnosticEvent, DiagnosticLevel } from '../src/shared/diagnostic-types';
import type { Model, Provider } from '../src/shared/types';

type Captured = { level: DiagnosticLevel; event: DiagnosticEvent; context?: DiagnosticContext };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}
async function requestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function fixture(url: string, options: GatewayOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-diagnostic-integration-'));
  const store = await Store.create(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'PRIVATE_PROVIDER_NAME', kind: 'openai-compatible', baseUrl: url, enabled: true, apiKey: 'PRIVATE_UPSTREAM_TOKEN' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'PRIVATE_UPSTREAM_MODEL', alias: 'private-alias', displayName: 'PRIVATE_MODEL_NAME', wireApi: 'chat-completions', contextWindow: 0, tools: true, vision: false, enabled: true });
  const gateway = new Gateway(store, options);
  cleanups.push(async () => { await gateway.stop(); });
  return { store, gateway, provider, model };
}
const privateContent = /PRIVATE_[A-Z_]+|private-alias|Reply OK\./;
const chat = { choices: [{ message: { role: 'assistant', content: 'PRIVATE_RESPONSE_TEXT' }, finish_reason: 'stop' }] };

describe('safe runtime diagnostic integration', () => {
  it('separates two concurrent HTTP request traces from the listener startup scope and correlates each upstream response', async () => {
    const scope = new AsyncLocalStorage<DiagnosticContext>();
    const records: Captured[] = [];
    const diagnostics = (level: DiagnosticLevel, event: DiagnosticEvent, context?: DiagnosticContext) => records.push({ level, event, context: { ...scope.getStore(), ...context } });
    let calls = 0;
    const mock = await upstream(async (req, res) => { await requestBody(req); calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chat)); });
    const f = await fixture(mock.url, {
      diagnostics,
      runWithDiagnostics: (context, action) => scope.run(context, action),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        diagnostics('info', 'network.response', { statusCode: response.status });
        return response;
      },
    });
    const startupTrace = randomUUID();
    const status = await scope.run({ traceId: startupTrace, operation: 'startGateway' }, () => f.gateway.start(0));
    await Promise.all([1, 2].map(async () => {
      const response = await fetch(`${status.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT_TEXT' }] }) });
      expect(response.status).toBe(200); await response.text();
    }));
    const completed = records.filter(record => record.event === 'gateway.request');
    const upstreamResponses = records.filter(record => record.event === 'network.response');
    expect(calls).toBe(2); expect(completed).toHaveLength(2); expect(upstreamResponses).toHaveLength(2);
    expect(records.find(record => record.event === 'gateway.started')?.context?.traceId).toBe(startupTrace);
    const requestTraces = completed.map(record => record.context?.traceId);
    expect(new Set(requestTraces).size).toBe(2);
    for (const traceId of requestTraces) {
      expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(traceId).not.toBe(startupTrace);
      expect(upstreamResponses.filter(record => record.context?.traceId === traceId)).toHaveLength(1);
    }
    for (const record of [...completed, ...upstreamResponses]) expect(record.context?.operation).toBe('request');
    expect(JSON.stringify(records)).not.toMatch(privateContent);
  });

  it('never retries inference if a diagnostic scope throws before or after action, or invokes action twice', async () => {
    for (const mode of ['before', 'after', 'twice'] as const) {
      let calls = 0;
      const mock = await upstream(async (req, res) => { await requestBody(req); calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chat)); });
      const scope = new AsyncLocalStorage<DiagnosticContext>();
      const f = await fixture(mock.url, {
        runWithDiagnostics: (context, action) => {
          if (mode === 'before') throw new Error('PRIVATE_SCOPE_FAILURE');
          const first = scope.run(context, action);
          if (mode === 'after') throw new Error('PRIVATE_SCOPE_FAILURE');
          expect(scope.run(context, action)).toBe(first);
          return first;
        },
      });
      const status = await f.gateway.start(0);
      const response = await fetch(`${status.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT_TEXT' }] }) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject(chat);
      expect(calls).toBe(1);
    }
  });

  it('records real gateway lifecycle, success and upstream rejection without copying credentials or conversation content', async () => {
    const upstreamBodies: unknown[] = [];
    const mock = await upstream(async (req, res) => {
      const body = await requestBody(req); upstreamBodies.push(body);
      res.setHeader('content-type', 'application/json');
      if (body.messages[0].content === 'PRIVATE_REJECTED_PROMPT') {
        res.statusCode = 429; res.end(JSON.stringify({ error: { message: 'PRIVATE_ERROR_BODY PRIVATE_UPSTREAM_TOKEN' } }));
      } else res.end(JSON.stringify(chat));
    });
    const records: Captured[] = [];
    const f = await fixture(mock.url, { diagnostics: (level, event, context) => records.push({ level, event, context }) });
    const status = await f.gateway.start(0);
    const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    const baseBody = { model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT_TEXT' }] };
    const success = await fetch(`${status.baseUrl}/chat/completions?api_key=PRIVATE_QUERY_TOKEN`, { method: 'POST', headers, body: JSON.stringify(baseBody) });
    expect(success.status).toBe(200); expect(await success.json()).toMatchObject(chat);
    const denied = await fetch(`${status.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...baseBody, messages: [{ role: 'user', content: 'PRIVATE_REJECTED_PROMPT' }] }) });
    expect(denied.status).toBe(429); await denied.text();
    const unknown = await fetch(`${status.baseUrl}/PRIVATE_PATH_TOKEN?code=PRIVATE_QUERY_TOKEN`, { headers });
    expect(unknown.status).toBe(404); await unknown.text();
    await f.gateway.stop(); await f.gateway.stop();
    expect(records.filter(record => record.event === 'gateway.started')).toHaveLength(1);
    expect(records.filter(record => record.event === 'gateway.stopped')).toHaveLength(1);
    const requests = records.filter(record => record.event === 'gateway.request');
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ level: 'info', context: { statusCode: 200, outcome: 'success', endpoint: '/v1/chat/completions', providerId: f.provider.id, modelId: f.model.id } });
    expect(requests[1]).toMatchObject({ level: 'warn', context: { statusCode: 429, outcome: 'rate-limit' } });
    expect(requests[2].context?.endpoint).toBeUndefined();
    expect(upstreamBodies).toHaveLength(2);
    expect(JSON.stringify(records)).not.toMatch(privateContent);
    expect(JSON.stringify(records)).not.toContain(f.store.gatewayKey());
  });

  it('preserves an occupied-port failure code and still supports a safe retry', async () => {
    const mock = await upstream((_req, res) => { res.end('{}'); });
    const occupied = await upstream((_req, res) => { res.end('{}'); });
    const port = Number(new URL(occupied.url).port);
    const records: Captured[] = [];
    const f = await fixture(mock.url, { port, diagnostics: (level, event, context) => records.push({ level, event, context }) });
    await expect(f.gateway.start()).rejects.toThrow('端口');
    expect(records).toContainEqual(expect.objectContaining({ event: 'gateway.start_failed', level: 'error', context: expect.objectContaining({ port, networkCode: 'EADDRINUSE', outcome: 'failure' }) }));
    await new Promise<void>(resolve => occupied.server.close(() => resolve()));
    expect(await f.gateway.start()).toMatchObject({ running: true, port });
    expect(JSON.stringify(records)).not.toMatch(privateContent);
  });

  it('keeps callback failures out of lifecycle and inference results', async () => {
    const mock = await upstream(async (req, res) => { await requestBody(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chat)); });
    const diagnostics = () => { throw new Error('PRIVATE_LOGGER_FAILURE PRIVATE_UPSTREAM_TOKEN'); };
    const f = await fixture(mock.url, { diagnostics });
    const status = await f.gateway.start(0);
    const response = await fetch(`${status.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'PRIVATE_PROMPT_TEXT' }] }) });
    expect(response.status).toBe(200); await response.text();
    await expect(f.gateway.stop()).resolves.toMatchObject({ running: false });
    const tester = new ConnectionTester(f.store, { prepareRequest: async (provider, route, body) => prepareUpstream(provider, f.store.getSecret(provider.id)!, route, body) }, { diagnostics });
    await expect(tester.test(f.provider.id, { modelId: f.model.id })).resolves.toMatchObject({ ok: true, statusCode: 200 });
  });

  it('records Responses shape before validation and maps arbitrary status/reason values to fixed categories', async () => {
    const provider: Provider = { id: 'api', name: 'PRIVATE_PROVIDER_NAME', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
    const model: Model = { id: 'model', providerId: provider.id, alias: 'private-alias', upstreamId: 'PRIVATE_UPSTREAM_MODEL', displayName: 'PRIVATE_MODEL_NAME', wireApi: 'responses', contextWindow: 0, tools: true, vision: false, enabled: true };
    const records: Captured[] = [];
    const payloads = [
      { id: 'PRIVATE_RESPONSE_ID', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING_TEXT' }] }], usage: { output_tokens: 64, output_tokens_details: { reasoning_tokens: 64 } } },
      { id: 'PRIVATE_RESPONSE_ID', object: 'response', status: 'PRIVATE_STATUS_TOKEN', incomplete_details: { reason: 'PRIVATE_REASON_TOKEN' }, error: { message: 'PRIVATE_ERROR_BODY' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_RESPONSE_TEXT' }] }], usage: { output_tokens: 'PRIVATE_USAGE_TOKEN', output_tokens_details: { reasoning_tokens: -1 } } },
    ];
    const tester = new ConnectionTester({ getProvider: () => provider, listModels: () => [model] }, { prepareRequest: async (p, route, body) => prepareUpstream(p, { apiKey: 'PRIVATE_UPSTREAM_TOKEN' }, route, body) }, {
      fetch: async () => new Response(JSON.stringify(payloads.shift()), { headers: { 'content-type': 'application/json' } }),
      diagnostics: (level, event, context) => records.push({ level, event, context }),
    });
    expect(await tester.test(provider.id, { modelId: model.id })).toMatchObject({ ok: true, message: expect.stringContaining('输出上限') });
    expect(await tester.test(provider.id, { modelId: model.id })).toMatchObject({ ok: false, outcome: 'upstream' });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: 'connection.response', context: { wireApi: 'responses', statusCode: 200, contentType: 'json', responseStatus: 'incomplete', incompleteReason: 'max_output_tokens', outputItems: 1, outputTokens: 64, reasoningTokens: 64, hasOutputText: false, hasReasoning: true } });
    expect(records[1]).toMatchObject({ context: { responseStatus: 'unknown', incompleteReason: 'unknown', hasOutputText: true, hasReasoning: false } });
    expect(records[1].context?.outputTokens).toBeUndefined();
    expect(records[1].context?.reasoningTokens).toBeUndefined();
    expect(records[0].context?.responseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toMatch(privateContent);
  });

  it('retains Chat shape and a single bounded SSE metadata entry without copying streamed text', async () => {
    const provider: Provider = { id: 'api', name: 'PRIVATE_PROVIDER_NAME', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
    const records: Captured[] = [];
    const bodies: Response[] = [
      new Response(JSON.stringify({ ...chat, usage: { completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 4 } } }), { headers: { 'content-type': 'application/json' } }),
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'PRIVATE_STREAM_TEXT' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    ];
    const tester = new ConnectionTester({ getProvider: () => provider, listModels: () => [] }, { prepareRequest: async (p, route, body) => prepareUpstream(p, { apiKey: 'PRIVATE_UPSTREAM_TOKEN' }, route, body) }, { fetch: async () => bodies.shift()!, diagnostics: (level, event, context) => records.push({ level, event, context }) });
    for (let call = 0; call < 2; call++) expect(await tester.test(provider.id, { upstreamId: 'PRIVATE_UPSTREAM_MODEL', wireApi: 'chat-completions' })).toMatchObject({ ok: true });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ context: { wireApi: 'chat-completions', outputTokens: 7, reasoningTokens: 4, hasOutputText: true, hasReasoning: false, outputItems: 1 } });
    expect(records[1]).toMatchObject({ context: { contentType: 'sse', responseBytes: expect.any(Number), wireApi: 'chat-completions' } });
    expect(records[1].context?.outputItems).toBeUndefined();
    expect(JSON.stringify(records)).not.toMatch(privateContent);
  });
});
