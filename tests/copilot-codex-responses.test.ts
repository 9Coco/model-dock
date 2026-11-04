import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gateway } from '../src/main/gateway';
import { prepareUpstream } from '../src/main/oauth';
import type { Store } from '../src/main/store';
import type { Model, Provider, RequestLog, ToolBinding } from '../src/shared/types';

type Event = { type: string; [key: string]: unknown };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(source: (signal: AbortSignal) => BodyInit, contentType = 'text/event-stream') {
  const provider: Provider = { id: 'codex-subscription', name: 'Synthetic Codex', kind: 'codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
  const model: Model = { id: 'fixture-model', providerId: provider.id, upstreamId: 'gpt-6.1-sol', alias: 'fixture-sol',
    displayName: 'Sol', wireApi: 'responses', contextWindow: 128000, tools: true, vision: false, enabled: true };
  const binding: ToolBinding = { id: 'copilot', name: 'Copilot', enabled: true, mode: 'aggregate', providerIds: [provider.id],
    modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' };
  const logs: Pick<RequestLog, 'status'>[] = [];
  const store = {
    listProviders: () => [provider], getProvider: (id: string) => id === provider.id ? provider : undefined,
    listModels: () => [model], listBindings: () => [binding], gatewayKey: () => 'local-fixture-key', setGatewayPort: () => {},
    gatewayExposure: () => ({ excludedProviderIds: [], excludedModelIds: [] }),
    getSecret: () => ({ accessToken: 'synthetic-upstream-token' }), addLog: (log: Pick<RequestLog, 'status'>) => { logs.unshift(log); },
  } satisfies Pick<Store, 'listProviders' | 'getProvider' | 'listModels' | 'listBindings' | 'gatewayKey' | 'setGatewayPort' | 'getSecret' | 'addLog' | 'gatewayExposure'>;
  const gateway = new Gateway(store as unknown as Store, {
    prepareRequest: async (...args) => prepareUpstream(...args),
    fetch: async (url, options) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-upstream-token');
      expect(JSON.parse(String(options?.body))).toMatchObject({ model: model.upstreamId, stream: true, store: false });
      return new Response(source(options!.signal!), { headers: { 'content-type': contentType } });
    },
  });
  cleanup.push(async () => { await gateway.stop(); });
  await gateway.start(0);
  const url = gateway.status().baseUrl.replace(/\/v1$/, '/tool/copilot/v1/responses');
  const post = (stream = true, signal?: AbortSignal, route = url) => fetch(route, {
    method: 'POST', signal, headers: { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.alias, stream, input: [{ role: 'user', content: 'synthetic fixture' }] }),
  });
  return { post, logs, unscoped: gateway.status().baseUrl + '/responses' };
}

const response = { id: 'resp_fixture', object: 'response', model: 'gpt-6.1-sol', created_at: 1793527600 };
const created = { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } };
const usage = { input_tokens: 19, output_tokens: 12, total_tokens: 31 };
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { ...response, status: 'completed', output, usage } });
const privateMetadata = { type: 'response.metadata', metadata: { internal: 'fixture-private-value' } };
const reasoning = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'fixture summary' }], encrypted_content: 'synthetic-opaque' };
const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
  content: [{ type: 'output_text', text: 'Checking fixture. 🙂', annotations: [] }] };
const tool = { id: 'fc_1', type: 'function_call', status: 'completed', name: 'read_fixture', call_id: 'call_1', arguments: '{"path":"fixture"}' };
const itemDone = (item: unknown, index: number) => ({ type: 'response.output_item.done', output_index: index, item });
function frame(event: Event, sequence: number) {
  return `event: ${event.type}\r\ndata: ${JSON.stringify({ sequence_number: sequence, ...event })}\r\n\r\n`;
}
function encoded(events: Event[]) { return events.map((event, index) => frame(event, index)).join(''); }
function eventsFrom(text: string): any[] {
  return text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart()).join('\n')).filter(data => data && data !== '[DONE]').map(data => JSON.parse(data));
}

describe('Copilot native Responses from a Codex subscription', () => {
  it.each([true, false])('fills missing terminal output from native done items (stream=%s)', async stream => {
    for (const snapshot of [[], [reasoning], [reasoning, tool]]) {
      const events = [created, itemDone(reasoning, 0), itemDone(message, 1), itemDone(tool, 2), completed(snapshot)];
      const f = await fixture(() => encoded(events), 'application/octet-stream');
      const reply = await f.post(stream);
      expect(reply.status).toBe(200);
      expect(reply.headers.get('content-type')).toContain(stream ? 'text/event-stream' : 'application/json');
      const delivered = stream ? eventsFrom(await reply.text()) : undefined;
      if (delivered) {
        const finishedItems = delivered.filter(event => event.type === 'response.output_item.done');
        expect(finishedItems.map(event => [event.output_index, event.item.id])).toEqual([[0, reasoning.id], [1, message.id], [2, tool.id]]);
      }
      const result = delivered ? delivered.find(event => event.type === 'response.completed')?.response : await reply.json();
      expect(result).toMatchObject({ model: 'fixture-sol', output: [reasoning, message, tool], usage });
      expect(f.logs[0]?.status).toBe(200);
    }
  });

  it.each([true, false])('completes partially populated same-ID items from their done events (stream=%s)', async stream => {
    const partial = [{ ...message, content: [] }, { ...tool, arguments: '' }];
    const f = await fixture(() => encoded([created, itemDone(message, 0), itemDone(tool, 1), completed(partial)]));
    const reply = await f.post(stream);
    expect(reply.status).toBe(200);
    const value = stream ? eventsFrom(await reply.text()).at(-1)?.response : await reply.json();
    expect(value.output).toEqual([message, tool]);
  });

  it.each([true, false])('retains output delivered only as partial text (stream=%s)', async stream => {
    const start = { ...message, status: 'in_progress', phase: 'final_answer', content: [] };
    const events = [created, { type: 'response.output_item.added', output_index: 0, item: start },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: start.id, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: start.id, delta: 'Split ' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: start.id, delta: 'text.' }, completed([])];
    const f = await fixture(() => encoded(events), 'application/octet-stream');
    const reply = await f.post(stream);
    expect(reply.status).toBe(200);
    const value = stream ? eventsFrom(await reply.text()).at(-1)?.response : await reply.json();
    expect(value.output).toMatchObject([{ id: message.id, type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'Split text.' }] }]);
  });

  it('passes a complete terminal-only response including final text and a refusal exactly once', async () => {
    const final = { ...message, phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixture.' }, { type: 'refusal', refusal: 'Fixture refusal.' }] };
    const f = await fixture(() => encoded([privateMetadata, created, completed([final])]));
    const reply = await f.post();
    const data = eventsFrom(await reply.text());
    expect(data.map(event => event.type)).not.toContain('response.metadata');
    expect(data.filter(event => event.type === 'response.completed')).toHaveLength(1);
    expect(data.at(-1)?.response).toMatchObject({ model: 'fixture-sol', output: [final], usage });
    const sequence = data.map(event => event.sequence_number);
    expect(sequence.every((n, index) => Number.isInteger(n) && (index === 0 || n > sequence[index - 1]))).toBe(true);
  });

  it.each([
    ['tool', tool],
    ['refusal', { ...message, phase: 'final_answer', content: [{ type: 'refusal', refusal: 'Fixture refusal.' }] }],
  ])('permits a %s as the only visible output', async (_kind, item) => {
    const f = await fixture(() => encoded([created, itemDone(item, 0), completed([])]));
    const reply = await f.post();
    expect(reply.status).toBe(200);
    const data = eventsFrom(await reply.text());
    expect(data.at(-1)?.response.output).toEqual([item]);
  });

  it('keeps the scope local to the Copilot client', async () => {
    const original = encoded([privateMetadata, created, itemDone(message, 0), completed([])]);
    const f = await fixture(() => original);
    const reply = await f.post(true, undefined, f.unscoped);
    expect(reply.status).toBe(200);
    const events = eventsFrom(await reply.text());
    expect(events.map(event => event.type)).toContain('response.metadata');
    expect(events.at(-1)?.response.output).toEqual([]);
  });
  it('preserves complete authoritative snapshots including order and updated fields', async () => {
    const final = { ...message, phase: 'final_answer', content: [{ type: 'output_text', text: 'Verified.', annotations: [] }] };
    const f = await fixture(() => encoded([created, itemDone(message, 0), itemDone(tool, 1), completed([final, tool])]));
    const reply = await f.post();
    const terminal = eventsFrom(await reply.text()).find(event => event.type === 'response.completed');
    expect(terminal?.response.output).toEqual([final, tool]);
  });

  it('rejects a reasoning-only result for a client that requests JSON', async () => {
    const f = await fixture(() => encoded([created, itemDone(reasoning, 0), completed([reasoning])]), 'application/octet-stream');
    const reply = await f.post(false);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect((await reply.json()).error.message).toEqual(expect.any(String));
    expect(f.logs[0]?.status).toBeGreaterThanOrEqual(400);
  });

  it('never restores an unfinished tool from argument deltas for JSON callers', async () => {
    const f = await fixture(() => encoded([created, itemDone(reasoning, 0),
      { type: 'response.output_item.added', output_index: 1, item: { ...tool, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: tool.id, delta: '{}' },
      completed([reasoning])]));
    const reply = await f.post(false);
    expect(reply.status).toBe(502);
    expect(await reply.json()).toHaveProperty('error.message');
  });

  it.each([
    ['private metadata and EOF', encoded([privateMetadata])],
    ['private metadata and DONE', encoded([privateMetadata]) + 'data: [DONE]\n\n'],
    ['reasoning-only completion', encoded([created, itemDone(reasoning, 0), completed([reasoning])])],
    ['missing terminal after a message', encoded([created, itemDone(message, 0)])],
    ['DONE after a message without a Responses terminal', encoded([created, itemDone(message, 0)]) + 'data: [DONE]\n\n'],
    ['malformed event', encoded([created]) + 'event: response.output_item.done\ndata: {invalid}\n\n'],
    ['invalid content index', encoded([created, { type: 'response.output_text.delta', output_index: 0, content_index: 10001,
      item_id: message.id, delta: 'fixture' }, completed([message])])],
    ['unfinished tool arguments', encoded([created, { type: 'response.output_item.added', output_index: 0,
      item: { ...tool, status: 'in_progress', arguments: '' } }, { type: 'response.function_call_arguments.delta', output_index: 0,
      item_id: tool.id, delta: '{"path":' }, completed([])])],
    ['incomplete response', encoded([created, { type: 'response.incomplete', response: { ...response,
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [reasoning] } }])],
    ['upstream failure after a message', encoded([created, itemDone(message, 0), { type: 'response.failed',
      response: { ...response, status: 'failed', error: { code: 'server_is_overloaded', message: 'Fixture busy.' } } }])],
  ])('reports %s as a failure to the client and request log', async (_name, body) => {
    const f = await fixture(() => body);
    const reply = await f.post();
    const text = await reply.text();
    expect(text).not.toContain('fixture-private-value');
    if (reply.ok) {
      const events = eventsFrom(text);
      expect(events.map(event => event.type)).not.toContain('response.completed');
      expect(events.some(event => ['response.failed', 'response.incomplete', 'error'].includes(event.type))).toBe(true);
    } else {
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(text).error.message).toEqual(expect.any(String));
    }
    await vi.waitFor(() => expect(f.logs[0]?.status).toBeGreaterThanOrEqual(400));
  });

  it('delivers a partial answer promptly and cancels the upstream reader when Copilot disconnects', async () => {
    let cancelled = false;
    const partial = encoded([created, { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'live fixture' }]);
    const f = await fixture(signal => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partial));
        signal.addEventListener('abort', () => { cancelled = true; controller.error(signal.reason); }, { once: true });
      },
      cancel() { cancelled = true; },
    }));
    const abort = new AbortController();
    try {
      const reply = await f.post(true, AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]));
      const reader = reply.body!.getReader();
      let visible = '';
      while (!visible.includes('live fixture')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        visible += new TextDecoder().decode(chunk.value);
      }
    } finally { abort.abort(); }
    await vi.waitFor(() => expect(cancelled).toBe(true));
    await vi.waitFor(() => expect(f.logs[0]?.status).toBe(499));
  });
});
