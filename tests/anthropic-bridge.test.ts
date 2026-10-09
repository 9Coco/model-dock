import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AnthropicBridgeError, anthropicMessageToSse, collectAnthropicStream, createAnthropicStream, parseAnthropicRequest, toAnthropicResponse } from '../src/main/anthropic-bridge';
import type { WireApi } from '../src/shared/types';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
const request = { model: 'friendly', max_tokens: 64, messages: [{ role: 'user', content: 'Read the file.' }],
  tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], tool_choice: { type: 'auto' } };
const chat = (text = 'OK', tools: unknown[] = [], reason = tools.length ? 'tool_calls' : 'stop') => ({ id: 'c1', model: 'PRIVATE_UPSTREAM', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: text, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } });
const responses = (output: unknown[] = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], status = 'completed') => ({
  id: 'r1', model: 'PRIVATE_UPSTREAM', object: 'response', status, output, usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
});
const call = { id: 'call_synthetic', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };
const responseCall = { type: 'function_call', id: 'fc1', call_id: 'call_synthetic', name: 'read_file', arguments: '{"path":"a.ts"}' };
const encode = new TextEncoder();
const event = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
function source(text: string, split = 3): ReadableStream<Uint8Array> {
  const bytes = encode.encode(text); let offset = 0;
  return new ReadableStream({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(offset, offset += split)); } });
}
async function streamEvents(text: string, api: WireApi): Promise<Record<string, any>[]> {
  const mapped = await new Response(source(text).pipeThrough(createAnthropicStream(api, 'friendly'))).text();
  return mapped.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)));
}
const chatStream = (tools = false) => [
  { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: tools ? null : '你🙂' }, finish_reason: null }] },
  ...(tools ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_synthetic', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: null }] }] : []),
  { choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }, '[DONE]',
].map(event).join('');
const responseStream = (tools = false) => [
  { type: 'response.created', response: { id: 'r1', status: 'in_progress', usage: { input_tokens: 10, output_tokens: 0 } } },
  ...(tools ? [{ type: 'response.output_item.added', output_index: 0, item: { ...responseCall, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"a.ts"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: responseCall.arguments },
    { type: 'response.output_item.done', output_index: 0, item: responseCall }]
    : [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你🙂' },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '你🙂' }]),
  { type: 'response.completed', response: responses(tools ? [responseCall] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你🙂' }] }]) },
].map(event).join('');

describe('Anthropic request and final response conversion', () => {
  it.each(['chat-completions', 'responses'] as const)('preserves system, image and complete tool history for %s', api => {
    const result = parseAnthropicRequest({ ...request, system: [{ type: 'text', text: 'System one', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'System two' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'call_synthetic', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_synthetic', content: 'File content' }, { type: 'text', text: 'Explain' }] }],
      tool_choice: { type: 'tool', name: 'read_file', disable_parallel_tool_use: true }, stream: true }, api);
    expect(result).toMatchObject({ stream: true, parallel_tool_calls: false, model: 'friendly' });
    if (api === 'responses') {
      expect(result).toMatchObject({ instructions: 'System one\nSystem two', max_output_tokens: 64, store: false,
        tool_choice: { type: 'function', name: 'read_file' }, tools: [{ type: 'function', name: 'read_file', parameters: request.tools[0].input_schema }] });
      expect(result.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'auto' }] },
        { role: 'assistant', content: 'Reading' },
        { type: 'function_call', call_id: 'call_synthetic', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'function_call_output', call_id: 'call_synthetic', output: 'File content' }, { role: 'user', content: [{ type: 'input_text', text: 'Explain' }] },
      ]);
    } else {
      expect(result).toMatchObject({ max_tokens: 64, stream_options: { include_usage: true }, tool_choice: { type: 'function', function: { name: 'read_file' } } });
      expect(result.messages).toEqual([{ role: 'system', content: 'System one\nSystem two' },
        { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'auto' } }] },
        { role: 'assistant', content: 'Reading', tool_calls: [call] }, { role: 'tool', tool_call_id: 'call_synthetic', content: 'File content' }, { role: 'user', content: 'Explain' }]);
    }
  });
  it.each(['chat-completions', 'responses'] as const)('completes two real local tool-loop requests using %s and preserves call IDs', async api => {
    const seen: any[] = [];
    const server = createServer((req, res) => {
      let raw = ''; req.on('data', bytes => { raw += bytes; }); req.on('end', () => {
        const body = JSON.parse(raw); seen.push(body); res.setHeader('content-type', 'application/json');
        const history = api === 'responses' ? body.input : body.messages;
        const returned = history.some((item: any) => api === 'responses' ? item.type === 'function_call_output' && item.call_id === 'call_synthetic' && item.output === 'SYNTHETIC_FILE_CONTENT'
          : item.role === 'tool' && item.tool_call_id === 'call_synthetic' && item.content === 'SYNTHETIC_FILE_CONTENT');
        res.end(JSON.stringify(api === 'responses' ? responses(returned ? undefined : [responseCall]) : chat(returned ? 'OK' : '', returned ? [] : [call])));
      });
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${api === 'responses' ? 'responses' : 'chat/completions'}`;
    const first = toAnthropicResponse(await (await fetch(url, { method: 'POST', body: JSON.stringify(parseAnthropicRequest(request, api)) })).json(), api, 'friendly');
    expect(first).toMatchObject({ model: 'friendly', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_synthetic', name: 'read_file', input: { path: 'a.ts' } }] });
    const followup = { ...request, messages: [...request.messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_synthetic', content: 'SYNTHETIC_FILE_CONTENT' }] }] };
    const final = toAnthropicResponse(await (await fetch(url, { method: 'POST', body: JSON.stringify(parseAnthropicRequest(followup, api)) })).json(), api, 'friendly');
    expect(final).toMatchObject({ stop_reason: 'end_turn', model: 'friendly', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 4 } });
    expect(seen).toHaveLength(2); expect(JSON.stringify(final)).not.toContain('PRIVATE_UPSTREAM');
  });
  it('rejects unsupported semantics and mismatched tool results with fixed errors', () => {
    const rejected = [
      { ...request, thinking: { type: 'enabled', budget_tokens: 1024 } }, { ...request, thinking: { type: 'adaptive' } },
      { ...request, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }] }] },
      { ...request, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'PRIVATE_RESULT' }] }] },
      { ...request, tools: [{ type: 'web_search_20250305', name: 'search' }] }, { ...request, output_config: { format: { type: 'json_schema', schema: {} } } },
      { ...request, max_tokens: 0 }, { ...request, top_k: 3 },
    ];
    for (const value of rejected) {
      let error: unknown; try { parseAnthropicRequest(value, 'responses'); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AnthropicBridgeError); expect(error).toMatchObject({ status: 400 });
      expect(String(error)).not.toMatch(/PRIVATE_THINKING|PRIVATE_SIGNATURE|PRIVATE_RESULT/);
    }
    expect(parseAnthropicRequest({ ...request, thinking: { type: 'disabled' } }, 'responses')).not.toHaveProperty('thinking');
  });
  it.each(['chat-completions', 'responses'] as const)('maps explicit effort and tool screenshots using valid %s history types', api => {
    const value = parseAnthropicRequest({ ...request, output_config: { effort: 'high' }, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_synthetic', name: 'read_file', input: { path: 'image.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_synthetic', is_error: true, content: [{ type: 'text', text: 'Screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] }] },
    ] }, api);
    if (api === 'responses') expect(value).toMatchObject({ reasoning: { effort: 'high' }, input: [expect.any(Object), { type: 'function_call_output', call_id: 'call_synthetic',
      output: [{ type: 'input_text', text: '[Tool error]' }, { type: 'input_text', text: 'Screenshot' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'auto' }] }] });
    else expect(value).toMatchObject({ reasoning_effort: 'high', messages: [expect.any(Object), { role: 'tool', tool_call_id: 'call_synthetic', content: expect.stringContaining('Screenshot') },
      { role: 'user', content: [{ type: 'text', text: 'Images from tool call_synthetic:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'auto' } }] }] });
  });
  it('maps valid truncation and rejects malformed tools, filtered replies and failed Responses', () => {
    expect(toAnthropicResponse(chat('Partial', [], 'length'), 'chat-completions', 'friendly').stop_reason).toBe('max_tokens');
    expect(toAnthropicResponse({ ...responses(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'responses', 'friendly').stop_reason).toBe('max_tokens');
    for (const [payload, api] of [[chat('OK', [], 'content_filter'), 'chat-completions'], [chat('', [{ ...call, function: { ...call.function, arguments: '{PRIVATE_BAD_JSON' } }]), 'chat-completions'],
      [responses(undefined, 'failed'), 'responses'], [responses([responseCall, responseCall]), 'responses'], [responses([], 'completed'), 'responses']] as const) {
      expect(() => toAnthropicResponse(payload, api, 'friendly')).toThrow(AnthropicBridgeError);
    }
  });
});

describe('Anthropic streaming bridge', () => {
  it('converts a JSON-only upstream tool response into standard Anthropic events', () => {
    const message = toAnthropicResponse(chat('', [call]), 'chat-completions', 'friendly');
    const raw = new TextDecoder().decode(anthropicMessageToSse(message));
    const events = raw.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)));
    expect(events[0]).toMatchObject({ type: 'message_start', message: { model: 'friendly', usage: { output_tokens: 0 } } });
    expect(events[1]).toMatchObject({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_synthetic', input: {} } });
    expect(events[2]).toMatchObject({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } });
    expect(events.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });
  it.each(['chat-completions', 'responses'] as const)('maps split UTF-8 frames and usage without duplicate final text for %s', async api => {
    const text = api === 'responses' ? responseStream() : chatStream();
    const events = await streamEvents(text, api);
    expect(events[0]).toMatchObject({ type: 'message_start', message: { role: 'assistant', model: 'friendly' } });
    expect(events.filter(item => item.type === 'content_block_delta').map(item => item.delta.text).join('')).toBe('你🙂');
    expect(events.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_UPSTREAM');
    const final = await collectAnthropicStream(source(text, 1), api, 'friendly');
    expect(final).toMatchObject({ content: [{ type: 'text', text: '你🙂' }], stop_reason: 'end_turn', usage: { output_tokens: api === 'responses' ? 3 : 5 } });
  });
  it.each(['chat-completions', 'responses'] as const)('maps partial JSON tool arguments to native tool blocks and back to followup history for %s', async api => {
    const raw = api === 'responses' ? responseStream(true) : chatStream(true);
    const events = await streamEvents(raw, api);
    expect(events.find(item => item.type === 'content_block_start')).toMatchObject({ content_block: { type: 'tool_use', id: 'call_synthetic', name: 'read_file', input: {} } });
    expect(events.filter(item => item.type === 'content_block_delta').map(item => item.delta.partial_json).join('')).toBe('{"path":"a.ts"}');
    expect(events.at(-2)).toMatchObject({ delta: { stop_reason: 'tool_use' } });
    const final = await collectAnthropicStream(source(raw), api, 'friendly');
    const next = parseAnthropicRequest({ ...request, messages: [{ role: 'assistant', content: final.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_synthetic', content: 'OK' }] }] }, api);
    const history = (api === 'responses' ? next.input : next.messages) as any[];
    expect(history.some(item => api === 'responses' ? item.type === 'function_call_output' && item.call_id === 'call_synthetic' : item.role === 'tool' && item.tool_call_id === 'call_synthetic')).toBe(true);
  });
  it('supports Responses that return final content only, including a final tool call', async () => {
    for (const [output, hasTool] of [[responses(), false], [responses([responseCall]), true]] as const) {
      const final = await collectAnthropicStream(source(event({ type: 'response.completed', response: output })), 'responses', 'friendly');
      expect(final.content).toEqual(hasTool ? [{ type: 'tool_use', id: 'call_synthetic', name: 'read_file', input: { path: 'a.ts' } }] : [{ type: 'text', text: 'OK' }]);
      expect(final.stop_reason).toBe(hasTool ? 'tool_use' : 'end_turn');
    }
  });
  it('collects typed final output items when the terminal Responses envelope omits them', async () => {
    const raw = event({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final only' }] } })
      + event({ type: 'response.completed', response: responses([]) });
    expect(await collectAnthropicStream(source(raw), 'responses', 'friendly')).toMatchObject({ content: [{ type: 'text', text: 'Final only' }], stop_reason: 'end_turn' });
  });
  it('never emits message_stop for partial, invalid, late-error, or failed terminal streams', async () => {
    const cases: [string, WireApi][] = [
      [event({ choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }] }), 'chat-completions'],
      [chatStream().replace(event('[DONE]'), '') + event({ error: { message: 'PRIVATE_ERROR SYNTHETIC_KEY' } }), 'chat-completions'],
      [responseStream() + event({ type: 'error', error: { message: 'PRIVATE_ERROR' } }), 'responses'],
      [event({ type: 'response.created', response: { id: 'r' } }) + event({ type: 'response.failed', response: { status: 'failed' } }), 'responses'],
      ['data: {PRIVATE_BAD_JSON\n\n', 'responses'],
      [chatStream(true).replace('a.ts', 'a.ts\\'), 'chat-completions'],
    ];
    for (const [raw, api] of cases) {
      const events = await streamEvents(raw, api);
      expect(events.some(item => item.type === 'error')).toBe(true);
      expect(events.some(item => item.type === 'message_stop')).toBe(false);
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_ERROR|SYNTHETIC_KEY|PRIVATE_BAD_JSON/);
      await expect(collectAnthropicStream(source(raw), api, 'friendly')).rejects.toBeInstanceOf(AnthropicBridgeError);
    }
  });
  it('propagates downstream cancellation to the actual local upstream socket', async () => {
    let closed!: () => void; const closedPromise = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer((_req, res) => {
      res.on('close', closed); res.setHeader('content-type', 'text/event-stream');
      res.write(event({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial' }, finish_reason: null }] }));
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const reader = upstream.body!.pipeThrough(createAnthropicStream('chat-completions', 'friendly')).getReader();
    const first = await reader.read(); expect(first.done).toBe(false);
    await reader.cancel(); reader.releaseLock(); await closedPromise;
  });
  it('observes raw usage and a fixed error marker without treating failed output as success', async () => {
    const observed: unknown[] = [];
    const raw = event({ type: 'response.created', response: { id: 'r' } }) + event({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 5, output_tokens: 2 } } });
    const text = await new Response(source(raw).pipeThrough(createAnthropicStream('responses', 'friendly', { onUpstreamEvent: value => { observed.push(value); } }))).text();
    expect(text).toContain('event: error'); expect(text).not.toContain('event: message_stop');
    expect(observed.some(value => (value as any).response?.usage?.output_tokens === 2)).toBe(true);
    expect(observed.at(-1)).toMatchObject({ type: 'error', error: { type: 'api_error' } });
  });
});
