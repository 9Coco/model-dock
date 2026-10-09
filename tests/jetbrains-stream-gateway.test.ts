import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { JETBRAINS_TOOL_IDS } from '../src/shared/jetbrains';
import type { WireApi } from '../src/shared/types';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sse = (value: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part)); return JSON.parse(Buffer.concat(chunks).toString('utf8')); }

async function fixture(wire: WireApi, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, timeoutMs = 3000) {
  const upstream = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(error => response.destroy(error)); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); });
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-jb-stream-')), store = await Store.create(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Synthetic upstream', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKey: 'SYNTHETIC_PRIVATE_KEY', enabled: true });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'synthetic-upstream-model', alias: 'synthetic-local-model', displayName: 'Synthetic model', wireApi: wire, contextWindow: 0, tools: true, vision: false, enabled: true });
  for (const tool of [...JETBRAINS_TOOL_IDS, 'vscode'] as const) store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const gateway = new Gateway(store, { timeoutMs }); await gateway.start(0);
  cleanups.push(() => gateway.stop().then(() => undefined));
  const root = gateway.status().baseUrl.replace(/\/v1$/, ''), headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const url = (tool?: string) => tool ? `${root}/tool/${tool}/v1/chat/completions` : `${root}/v1/chat/completions`;
  return { store, model, headers, url };
}

interface HttpResult { status: number; text: string; complete: boolean; aborted: boolean; errors: string[]; contentType: string }
// Rider's real Ktor/Koog client can swallow premature EOF/RST after a valid
// chunk. Failure therefore has to remain an HTTP error before any success data.
async function readHttp(url: string, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, response => {
      const chunks: Buffer[] = [], errors: string[] = [];
      response.on('error', error => errors.push((error as NodeJS.ErrnoException).code ?? error.name));
      void (async () => {
        try { for await (const part of response) chunks.push(Buffer.from(part)); }
        catch (error) { errors.push((error as NodeJS.ErrnoException).code ?? (error as Error).name); }
        resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8'), complete: response.complete, aborted: response.aborted, errors, contentType: String(response.headers['content-type'] ?? '') });
      })();
    });
    request.once('error', reject); request.end(JSON.stringify(body));
  });
}
const input = (messages: unknown[] = [{ role: 'user', content: 'SYNTHETIC_PROMPT' }]) => ({ model: 'synthetic-local-model', stream: true, messages,
  tools: [{ type: 'function', function: { name: 'read_fixture', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] });
function chunksOf(text: string): any[] {
  return text.split(/\r\n\r\n|\n\n|\r\r/).filter(Boolean).map(frame => {
    const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}
function assertValidStream(result: HttpResult) {
  expect(result).toMatchObject({ status: 200, complete: true, aborted: false, errors: [] });
  expect(result.contentType).toContain('text/event-stream');
  const chunks = chunksOf(result.text);
  expect(chunks.at(-1)).toBe('[DONE]'); expect(chunks.filter(chunk => chunk === '[DONE]')).toHaveLength(1);
  const data = chunks.slice(0, -1);
  for (const chunk of data) {
    // These fields are required by Rider's Koog OpenAIChatCompletionStreamResponse.
    expect(chunk).toMatchObject({ id: expect.any(String), created: expect.any(Number), object: 'chat.completion.chunk', model: 'synthetic-local-model', choices: expect.any(Array) });
    expect(chunk.id).not.toBe('');
  }
  expect(data.some(chunk => chunk.choices.some((choice: any) => choice.finish_reason != null))).toBe(true);
  return data;
}
function saveSyntheticFixture(name: string, result: HttpResult) {
  const directory = process.env.MODELDOCK_JETBRAINS_FIXTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, name), result.text, { mode: 0o600 });
}
function assertHttpFailure(result: HttpResult, status = 502) {
  expect(result).toMatchObject({ status, complete: true, aborted: false, errors: [] });
  expect(result.contentType).toContain('application/json');
  expect(JSON.parse(result.text)).toMatchObject({ error: { message: expect.any(String) } });
  expect(result.text).not.toMatch(/PRIVATE_ERROR_BODY|SYNTHETIC_PRIVATE_KEY|PARTIAL_SYNTHETIC|data:|\[DONE\]|"choices"/);
}
function reconstruct(data: any[]) {
  const message: any = { role: 'assistant', content: '', reasoning_content: '' }, tools = new Map<number, any>();
  for (const chunk of data) for (const choice of chunk.choices) {
    const delta = choice.delta;
    message.content += delta.content ?? ''; message.reasoning_content += delta.reasoning_content ?? '';
    for (const call of delta.tool_calls ?? []) {
      const tool = tools.get(call.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      tool.id += call.id ?? ''; tool.function.name += call.function?.name ?? ''; tool.function.arguments += call.function?.arguments ?? ''; tools.set(call.index, tool);
    }
  }
  if (tools.size) message.tool_calls = [...tools.values()];
  return message;
}
async function splitBytes(response: ServerResponse, text: string) {
  const bytes = Buffer.from(text);
  for (let index = 0; index < bytes.length; index++) { response.write(bytes.subarray(index, index + 1)); if (index % 23 === 0) await immediate(); }
  response.end();
}

describe('JetBrains Chat streaming HTTP contract', () => {
  it.each(JETBRAINS_TOOL_IDS)('%s accepts type-only Responses part.added through the full buffered HTTP pipeline', async tool => {
    const summary = { type: 'reasoning', summary: [{ type: 'summary_text', text: '摘要🙂' }] };
    const thought = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '原始🙂' }] };
    const output = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答🙂' }, { type: 'refusal', refusal: '拒绝🙂' }] };
    const f = await fixture('responses', async (request, response) => {
      expect(request.url).toBe('/v1/responses');
      expect(await bodyOf(request)).toMatchObject({ model: 'synthetic-upstream-model', stream: true });
      response.setHeader('content-type', 'text/event-stream');
      const events = [
        { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress', created_at: 1760000000 } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', status: 'in_progress' } },
        { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text' } },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '摘要🙂' },
        { type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0, part: summary.summary[0] },
        { type: 'response.output_item.done', output_index: 0, item: summary },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', summary: [], content: [] } },
        { type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'reasoning_text' } },
        { type: 'response.reasoning_raw_text.delta', output_index: 1, content_index: 0, delta: '原始🙂' },
        { type: 'response.reasoning_raw_text.done', output_index: 1, content_index: 0, text: '原始🙂' },
        { type: 'response.content_part.done', output_index: 1, content_index: 0, part: thought.content[0] },
        { type: 'response.output_item.done', output_index: 1, item: thought },
        { type: 'response.output_item.added', output_index: 2, item: { type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 2, content_index: 0, part: { type: 'output_text' } },
        { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '答🙂' },
        { type: 'response.output_text.done', output_index: 2, content_index: 0, text: '答🙂' },
        { type: 'response.content_part.done', output_index: 2, content_index: 0, part: output.content[0] },
        { type: 'response.content_part.added', output_index: 2, content_index: 1, part: { type: 'refusal' } },
        { type: 'response.refusal.delta', output_index: 2, content_index: 1, delta: '拒绝🙂' },
        { type: 'response.refusal.done', output_index: 2, content_index: 1, refusal: '拒绝🙂' },
        { type: 'response.content_part.done', output_index: 2, content_index: 1, part: output.content[1] },
        { type: 'response.output_item.done', output_index: 2, item: output },
        { type: 'response.completed', response: { status: 'completed', output: [summary, thought, output], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } } },
      ];
      await splitBytes(response, ': heartbeat\n\n' + events.map(value => sse(value)).join('') + sse('[DONE]'));
    });
    const result = await readHttp(f.url(tool), f.headers, input()), chunks = assertValidStream(result);
    if (tool === 'rider') saveSyntheticFixture('sparse-added-reasoning-answer-refusal.sse', result);
    expect(reconstruct(chunks)).toMatchObject({ content: '答🙂', reasoning_content: '摘要🙂原始🙂' });
    expect(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.refusal ?? '').join('')).toBe('拒绝🙂');
    expect(chunks.find(chunk => chunk.choices.some((choice: any) => choice.finish_reason != null)).choices[0].finish_reason).toBe('stop');
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
    expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_PROMPT|SYNTHETIC_PRIVATE_KEY|摘要|原始|答|拒绝/);
  });
  it.each(JETBRAINS_TOOL_IDS)('%s decodes raw Responses reasoning and a two-round tool call without duplicating names or arguments', async tool => {
    const bodies: any[] = [];
    const f = await fixture('responses', async (request, response) => {
      expect(request.url).toBe('/v1/responses'); expect(request.headers.authorization).toBe('Bearer SYNTHETIC_PRIVATE_KEY');
      const body = await bodyOf(request); bodies.push(body); response.setHeader('content-type', 'text/event-stream');
      const second = body.input.some((item: any) => item.type === 'function_call_output');
      const reasoning = { type: 'reasoning', id: 'rs_synthetic', summary: [], content: [{ type: 'reasoning_text', text: '检查夹具' }] };
      const toolOutput = { type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'read_fixture', arguments: '{"path":"夹具"}' };
      const finalOutput = { type: 'message', id: 'msg_synthetic', role: 'assistant', content: [{ type: 'output_text', text: '已读取夹具。' }] };
      const events = second ? [sse({ type: 'response.output_item.added', output_index: 0, item: { ...finalOutput, content: [] } }),
        sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '已读取夹具。' })] : [
        sse({ type: 'response.output_item.added', output_index: 0, item: { ...reasoning, content: [] } }),
        sse({ type: 'response.reasoning_raw_text.delta', output_index: 0, content_index: 0, delta: '检查' }),
        sse({ type: 'response.reasoning_raw_text.delta', output_index: 0, content_index: 0, delta: '夹具' }),
        sse({ type: 'response.reasoning_raw_text.done', output_index: 0, content_index: 0, text: '检查夹具' }),
        sse({ type: 'response.output_item.done', output_index: 0, item: reasoning }),
        sse({ type: 'response.output_item.added', output_index: 1, item: { ...toolOutput, arguments: '' } }),
        sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' }),
        sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"夹具"}' }),
        sse({ type: 'response.function_call_arguments.done', output_index: 1, arguments: toolOutput.arguments }),
        sse({ type: 'response.output_item.done', output_index: 1, item: toolOutput }),
      ];
      events.push(sse({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: second ? [finalOutput] : [reasoning, toolOutput], usage: { input_tokens: 12, output_tokens: 6, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } }));
      await splitBytes(response, ': heartbeat\n\n' + events.join(''));
    });
    const firstResult = await readHttp(f.url(tool), f.headers, input()), first = assertValidStream(firstResult), message = reconstruct(first);
    if (tool === 'rider') saveSyntheticFixture('raw-reasoning-tool-first.sse', firstResult);
    expect(message).toMatchObject({ content: '', reasoning_content: '检查夹具', tool_calls: [{ id: 'call_synthetic', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"夹具"}' } }] });
    expect(first.find(chunk => chunk.choices.some((choice: any) => choice.finish_reason != null)).choices[0].finish_reason).toBe('tool_calls');
    expect(first.find(chunk => chunk.usage)?.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } });
    // Koog's real request encoder returns the displayed reasoning_content on
    // the next turn; it must not become a fabricated native reasoning item.
    const secondResult = await readHttp(f.url(tool), f.headers, input([...input().messages, message, { role: 'tool', tool_call_id: 'call_synthetic', content: 'SYNTHETIC_RESULT' }])), second = assertValidStream(secondResult);
    if (tool === 'rider') saveSyntheticFixture('tool-loop-final.sse', secondResult);
    expect(reconstruct(second).content).toBe('已读取夹具。');
    expect(bodies[1].input).toEqual(expect.arrayContaining([{ type: 'function_call_output', call_id: 'call_synthetic', output: 'SYNTHETIC_RESULT' }]));
    expect(bodies[1].input).toEqual(expect.arrayContaining([{ type: 'function_call', call_id: 'call_synthetic', name: 'read_fixture', arguments: '{"path":"夹具"}' }]));
    expect(bodies[1].input.every((item: any) => item.type !== 'reasoning' && item.role !== 'developer' && item.reasoning_content === undefined)).toBe(true);
    expect(JSON.stringify(bodies[1].input)).not.toContain('检查夹具');
    expect(bodies.every(body => body.model === 'synthetic-upstream-model' && body.stream)).toBe(true);
    expect(JSON.stringify([f.store.logs(), first, second])).not.toMatch(/SYNTHETIC_PRIVATE_KEY|SYNTHETIC_PROMPT|SYNTHETIC_RESULT/);
  });

  it('normalizes sparse native Chat envelopes, skips heartbeats and preserves byte-split UTF-8, tool deltas and usage', async () => {
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.setHeader('content-type', 'text/event-stream');
      await splitBytes(response, ': heartbeat\r\n\r\n' + sse({}, 'ping') + sse({ type: 'ping' }) + [
        { choices: [{ index: 0, delta: { role: 'assistant', content: '你好🙂' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_utf8', type: 'function', function: { name: 'read_fixture', arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"夹具"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
      ].map(chunk => sse(chunk)).join('') + sse('[DONE]'));
    });
    const result = await readHttp(f.url('rider'), f.headers, input()), chunks = assertValidStream(result), message = reconstruct(chunks);
    saveSyntheticFixture('sparse-native-tool.sse', result);
    expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(1); expect(new Set(chunks.map(chunk => chunk.created)).size).toBe(1);
    expect(message.content).toBe('你好🙂'); expect(message.tool_calls).toEqual([{ id: 'call_utf8', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"夹具"}' } }]);
    expect(chunks.at(-1).choices).toEqual([]); expect(chunks.at(-1).usage.total_tokens).toBe(18);
  });

  it.each(['native-error', 'native-empty', 'native-invalid', 'responses-error', 'responses-empty'] as const)('returns HTTP 502 before streaming when the first upstream result is %s', async scenario => {
    const f = await fixture(scenario.startsWith('responses') ? 'responses' : 'chat-completions', async (request, response) => {
      await bodyOf(request); response.setHeader('content-type', 'text/event-stream');
      response.end(scenario.endsWith('error') ? sse({ type: 'error', error: { message: 'SYNTHETIC_PRIVATE_KEY PRIVATE_ERROR_BODY' } }, 'error') : scenario.endsWith('invalid') ? sse({ type: 'unsupported' }) : ': empty heartbeat\n\n');
    });
    const result = await readHttp(f.url('rider'), f.headers, input());
    assertHttpFailure(result);
  });

  it.each(['error', 'no-finish', 'done-before-finish', 'late-error'] as const)('returns HTTP 502 without publishing partial native Chat on %s', async scenario => {
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.setHeader('content-type', 'text/event-stream'); response.write(sse({ choices: [{ index: 0, delta: { content: 'PARTIAL_SYNTHETIC' }, finish_reason: null }] }));
      await delay(40);
      if (scenario === 'error') response.end(sse({ error: { message: 'SYNTHETIC_PRIVATE_KEY PRIVATE_ERROR_BODY' } }, 'error'));
      else if (scenario === 'done-before-finish') response.end(sse('[DONE]'));
      else if (scenario === 'late-error') response.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse('[DONE]') + sse({ error: { message: 'PRIVATE_ERROR_BODY' } }));
      else response.end();
    });
    const result = await readHttp(f.url('rider'), f.headers, input());
    assertHttpFailure(result);
  });

  it.each(['error', 'no-completion', 'late-error'] as const)('returns HTTP 502 without publishing partial Responses output on %s', async scenario => {
    const f = await fixture('responses', async (request, response) => {
      await bodyOf(request); response.setHeader('content-type', 'text/event-stream'); response.write(sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'PARTIAL_SYNTHETIC' }));
      await delay(40);
      if (scenario === 'error') response.end(sse({ type: 'error', error: { message: 'PRIVATE_ERROR_BODY' } }));
      else if (scenario === 'late-error') response.end(sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PARTIAL_SYNTHETIC' }] }] } }) + sse({ type: 'error', error: { message: 'PRIVATE_ERROR_BODY' } }));
      else response.end();
    });
    const result = await readHttp(f.url('rider'), f.headers, input());
    assertHttpFailure(result);
  });

  it('converts a successful JSON Chat reply into complete SSE when an upstream ignores stream:true', async () => {
    const f = await fixture('chat-completions', async (request, response) => {
      expect((await bodyOf(request)).stream).toBe(true); response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'JSON_SYNTHETIC' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
    });
    const result = await readHttp(f.url('rider'), f.headers, input()), chunks = assertValidStream(result);
    saveSyntheticFixture('fake-good-json-fallback.sse', result); expect(reconstruct(chunks).content).toBe('JSON_SYNTHETIC'); expect(chunks.at(-1).usage.total_tokens).toBe(9);
  });

  it.each(['chat-completions', 'responses'] as const)('fails closed on HTTP 200 JSON errors from %s', async wire => {
    const f = await fixture(wire, async (request, response) => { await bodyOf(request); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { message: 'SYNTHETIC_PRIVATE_KEY PRIVATE_ERROR_BODY' } })); });
    const result = await readHttp(f.url('rider'), f.headers, input()); assertHttpFailure(result);
  });

  it('leaves ordinary and VS Code scoped Chat passthrough unchanged', async () => {
    const f = await fixture('chat-completions', async (request, response) => { await bodyOf(request); response.setHeader('content-type', 'text/event-stream'); response.end(sse({ model: 'synthetic-upstream-model', choices: [{ delta: { content: 'LEGACY_SYNTHETIC' } }] }) + sse('[DONE]')); });
    for (const tool of [undefined, 'vscode']) {
      const result = await readHttp(f.url(tool), f.headers, input()); expect(result).toMatchObject({ status: 200, complete: true, aborted: false, errors: [] });
      expect(chunksOf(result.text)).toEqual([{ model: 'synthetic-local-model', choices: [{ delta: { content: 'LEGACY_SYNTHETIC' } }] }, '[DONE]']);
    }
  });

  it('preserves native Chat reasoning history rather than applying the Responses-only omission', async () => {
    let history: any[] = [];
    const f = await fixture('chat-completions', async (request, response) => {
      history = (await bodyOf(request)).messages; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'JSON_SYNTHETIC' }, finish_reason: 'stop' }] }));
    });
    const messages = [{ role: 'user', content: 'SYNTHETIC_PROMPT' }, { role: 'assistant', content: 'NATIVE_SYNTHETIC_HISTORY', reasoning_content: 'NATIVE_SYNTHETIC_REASONING' }, { role: 'user', content: 'NEXT_SYNTHETIC_PROMPT' }];
    assertValidStream(await readHttp(f.url('rider'), f.headers, input(messages)));
    expect(history).toEqual(messages);
  });

  it.each([
    { role: 'assistant', content: 'SYNTHETIC_HISTORY', reasoning_content: { unsupported: true } },
    { role: 'user', content: 'SYNTHETIC_PROMPT', reasoning_content: 'UNSUPPORTED_USER_REASONING' },
  ])('rejects non-display reasoning history before contacting a Responses upstream', async message => {
    let requests = 0;
    const f = await fixture('responses', (_request, response) => { requests++; response.end('{}'); });
    const result = await readHttp(f.url('rider'), f.headers, input([message]));
    expect(result.status).toBe(400); expect(result.complete).toBe(true); expect(requests).toBe(0);
  });

  it('returns HTTP 504 for a heartbeat-only first-block timeout and closes the upstream', async () => {
    let closed = false;
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.once('close', () => { closed = true; }); response.setHeader('content-type', 'text/event-stream'); response.write(': waiting\n\n');
    }, 100);
    const result = await readHttp(f.url('rider'), f.headers, input()); assertHttpFailure(result, 504);
    await delay(25); expect(closed).toBe(true);
  });

  it('returns HTTP 504 without publishing partial output when completion times out', async () => {
    let closed = false;
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.once('close', () => { closed = true; }); response.setHeader('content-type', 'text/event-stream');
      response.write(sse({ choices: [{ index: 0, delta: { content: 'PARTIAL_SYNTHETIC' }, finish_reason: null }] }));
    }, 100);
    const result = await readHttp(f.url('rider'), f.headers, input());
    assertHttpFailure(result, 504);
    await delay(25); expect(closed).toBe(true);
  });

  it('cancels upstream when a JetBrains client abandons an unfinished buffered response', async () => {
    let closed = false;
    let upstreamStarted!: () => void;
    const started = new Promise<void>(resolve => { upstreamStarted = resolve; });
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.once('close', () => { closed = true; }); response.setHeader('content-type', 'text/event-stream'); response.write(sse({ choices: [{ index: 0, delta: { content: 'PARTIAL_SYNTHETIC' }, finish_reason: null }] }));
      upstreamStarted();
    });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(f.url('rider'), { method: 'POST', headers: f.headers }, response => {
        response.resume(); reject(new Error('Unfinished upstream output must not publish response headers.'));
      });
      request.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(); else reject(error); });
      request.end(JSON.stringify(input()));
      void started.then(() => request.destroy());
    });
    for (let attempt = 0; attempt < 40 && !closed; attempt++) await delay(10);
    expect(closed).toBe(true);
  });

  it('returns HTTP 502 when otherwise valid native Chat output exceeds the 32 MiB buffer limit', async () => {
    let closed = false;
    const f = await fixture('chat-completions', async (request, response) => {
      await bodyOf(request); response.once('close', () => { closed = true; }); response.setHeader('content-type', 'text/event-stream');
      // Each frame is well below the SSE parser's individual-frame limit, so
      // this specifically checks the bounded total JetBrains response buffer.
      const frame = sse({ choices: [{ index: 0, delta: { content: 'x'.repeat(512 * 1024) }, finish_reason: null }] });
      for (let index = 0; index < 68 && !response.destroyed; index++) {
        if (!response.write(frame)) {
          await new Promise<void>(resolve => {
            const cleanup = () => { response.off('drain', cleanup); response.off('close', cleanup); resolve(); };
            response.once('drain', cleanup); response.once('close', cleanup);
          });
        }
      }
      if (!response.destroyed) response.end(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse('[DONE]'));
    }, 10_000);
    assertHttpFailure(await readHttp(f.url('rider'), f.headers, input()));
    for (let attempt = 0; attempt < 40 && !closed; attempt++) await delay(10);
    expect(closed).toBe(true);
  }, 15_000);
});
