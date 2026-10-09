import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ChatResponsesBridgeError, chatResponseToSse, collectResponsesChatStream, createResponsesChatStream, parseChatResponsesRequest, responsesToChat } from '../src/main/chat-responses-bridge';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
const encoder = new TextEncoder();
const event = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const responseCall = { type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'read_file', arguments: '{"path":"a.ts"}' };
const chatCall = { id: 'call_synthetic', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };
const request = { model: 'friendly', messages: [{ role: 'user', content: 'Read file' }], max_tokens: 100, stream: true,
  tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] };
const responses = (output: unknown[] = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你🙂' }] }], extra = {}) => ({
  id: 'resp_synthetic', created_at: 1760000000, object: 'response', model: 'PRIVATE_UPSTREAM', status: 'completed', output,
  usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } }, ...extra,
});
function source(text: string, split = 3): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text); let offset = 0;
  return new ReadableStream({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset += split)); } });
}
function stream(output: unknown[] = responses().output): string {
  return [
    { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress', created_at: 1760000000 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Public summary' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'Public summary' },
    ...(output.some((item: any) => item.type === 'function_call') ? [
      { type: 'response.output_item.added', output_index: 1, item: { ...responseCall, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"a.ts"}' },
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: responseCall.arguments },
      { type: 'response.output_item.done', output_index: 1, item: responseCall },
    ] : [
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '你' },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '🙂' },
      { type: 'response.output_text.done', output_index: 1, content_index: 0, text: '你🙂' },
    ]),
    { type: 'response.completed', response: responses([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Public summary' }] }, ...output]) },
  ].map(event).join('');
}
function parsedSse(text: string): any[] {
  return text.split('\n\n').filter(Boolean).map(frame => { const data = frame.split('\n').find(line => line.startsWith('data: '))!.slice(6); return data === '[DONE]' ? data : JSON.parse(data); });
}
async function listen(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
}

describe('native Chat to Responses request conversion', () => {
  it('preserves ordered roles, images, complete tool history, sampling and structured output', () => {
    const converted = parseChatResponsesRequest({ ...request, messages: [
      { role: 'system', content: 'System 1' }, { role: 'developer', content: 'Developer 1' }, { role: 'system', content: 'System 2' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'high' } }] },
      { role: 'assistant', content: 'Reading', tool_calls: [chatCall] },
      { role: 'tool', tool_call_id: 'call_synthetic', content: 'SYNTHETIC_FILE' }, { role: 'user', content: 'Explain' },
    ], max_completion_tokens: 100, reasoning_effort: 'high', temperature: 0.3, top_p: 0.8, parallel_tool_calls: false,
    tool_choice: { type: 'function', function: { name: 'read_file' } }, response_format: { type: 'json_schema', json_schema: { name: 'Result', schema: { type: 'object' }, strict: true } } });
    expect(converted).toMatchObject({ model: 'friendly', stream: true, store: false, max_output_tokens: 100, reasoning: { effort: 'high' }, temperature: 0.3, top_p: 0.8,
      parallel_tool_calls: false, tool_choice: { type: 'function', name: 'read_file' }, tools: [{ type: 'function', name: 'read_file', strict: false, parameters: request.tools[0].function.parameters }],
      text: { format: { type: 'json_schema', name: 'Result', schema: { type: 'object' }, strict: true } } });
    expect(converted.input).toEqual([
      { role: 'system', content: 'System 1' }, { role: 'developer', content: 'Developer 1' }, { role: 'system', content: 'System 2' },
      { role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'high' }] },
      { type: 'message', id: expect.stringMatching(/^msg_/), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Reading', annotations: [] }] },
      { type: 'function_call', call_id: 'call_synthetic', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_synthetic', output: 'SYNTHETIC_FILE' }, { role: 'user', content: 'Explain' },
    ]);
    expect(converted).not.toHaveProperty('messages'); expect(converted).not.toHaveProperty('max_tokens');
  });
  it('preserves historical refusal, empty-tools behavior and optional budget', () => {
    const converted = parseChatResponsesRequest({ model: 'friendly', messages: [{ role: 'assistant', content: null, refusal: 'Cannot comply' }, { role: 'user', content: 'Different question' }], tools: [], stop: [], stream_options: { include_usage: true } });
    expect(converted).not.toHaveProperty('tools'); expect(converted).not.toHaveProperty('max_output_tokens');
    expect(converted.input).toMatchObject([{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply' }] }, { role: 'user' }]);
  });
  it('preserves officially shared user/cache/safety identifiers without inventing new identifiers', () => {
    const converted = parseChatResponsesRequest({ ...request, user: 'SYNTHETIC_USER', prompt_cache_key: 'SYNTHETIC_CACHE', safety_identifier: 'SYNTHETIC_HASH' });
    expect(converted).toMatchObject({ user: 'SYNTHETIC_USER', prompt_cache_key: 'SYNTHETIC_CACHE', safety_identifier: 'SYNTHETIC_HASH' });
    expect(parseChatResponsesRequest({ ...request, user: 'SYNTHETIC_USER' })).not.toHaveProperty('safety_identifier');
    expect(parseChatResponsesRequest({ ...request, user: null, prompt_cache_key: null, safety_identifier: null })).toMatchObject({ user: null, prompt_cache_key: null, safety_identifier: null });
  });
  it.each([
    { stop: ['PRIVATE_STOP'] }, { n: 2 }, { max_completion_tokens: 99 }, { frequency_penalty: 0.5 }, { logprobs: true }, { seed: 5 },
    { response_format: { type: 'unknown' } }, { tools: [{ type: 'web_search' }] }, { tool_choice: { type: 'function', function: { name: 'unknown' } } },
    { user: 5 }, { prompt_cache_key: 'PRIVATE_CACHE\nHEADER' }, { safety_identifier: 'x'.repeat(129) },
    { messages: [{ role: 'user', name: 'PRIVATE_NAME', content: 'Hello' }] },
    { messages: [{ role: 'tool', tool_call_id: 'PRIVATE_CALL', content: 'PRIVATE_BODY' }] },
    { messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'PRIVATE_THINKING' }] },
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ ...chatCall, function: { ...chatCall.function, arguments: 'PRIVATE_JSON' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://PRIVATE_KEY@example.test/a.png' } }] }] },
  ])('rejects unrepresentable semantics using fixed errors: %j', extra => {
    let caught: unknown; try { parseChatResponsesRequest({ ...request, ...extra }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ChatResponsesBridgeError); expect(caught).toMatchObject({ status: 400 });
    expect(String(caught)).not.toMatch(/PRIVATE_/);
  });
});

describe('Responses to native Chat reply conversion', () => {
  it('preserves text, refusal, public reasoning summaries, tool IDs and real gross/cache usage', () => {
    const converted = responsesToChat(responses([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Public summary' }], encrypted_content: 'PRIVATE_SIGNATURE' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }, { type: 'refusal', refusal: 'Limited response' }] }, responseCall,
    ]), 'friendly');
    expect(converted).toMatchObject({ object: 'chat.completion', created: 1760000000, model: 'friendly', choices: [{ index: 0, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: 'Hello', reasoning_content: 'Public summary', refusal: 'Limited response', tool_calls: [chatCall] } }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } });
    expect(JSON.stringify(converted)).not.toMatch(/PRIVATE_UPSTREAM|PRIVATE_SIGNATURE/);
    const raw = new TextDecoder().decode(chatResponseToSse(converted));
    expect(parsedSse(raw).at(-1)).toBe('[DONE]'); expect(raw).toContain('"reasoning_content":"Public summary"');
  });
  it('does not fabricate zero token usage when upstream omitted usage', () => {
    expect(responsesToChat({ ...responses(), usage: undefined }, 'friendly')).not.toHaveProperty('usage');
  });
  it('preserves valid token-budget truncation, including partial tool JSON and empty content', () => {
    const extra = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    expect(responsesToChat(responses([{ ...responseCall, arguments: '{"path":' }], extra), 'friendly')).toMatchObject({ choices: [{ finish_reason: 'length', message: { tool_calls: [{ function: { arguments: '{"path":' } }] } }] });
    expect(responsesToChat(responses([], extra), 'friendly')).toMatchObject({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
  });
  it.each([
    responses([], { status: 'failed', error: { message: 'PRIVATE_ERROR' } }), responses([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
    responses([]), responses([responseCall, responseCall]), responses([{ ...responseCall, arguments: '{PRIVATE_JSON' }]), responses([{ type: 'computer_call' }]),
    responses(undefined, { usage: { input_tokens: 5 } }),
    responses(undefined, { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 'PRIVATE_TOKEN_COUNT' } }),
    responses(undefined, { usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 6 } } }),
  ])('rejects failed and malformed results without leaking upstream details', payload => {
    let caught: unknown; try { responsesToChat(payload, 'friendly'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ChatResponsesBridgeError); expect(caught).toMatchObject({ status: 502 }); expect(String(caught)).not.toMatch(/PRIVATE_/);
  });
});

describe('Responses to Chat streaming bridge', () => {
  it('maps byte-split UTF-8 and CRLF frames without duplicate final text or summary', async () => {
    const raw = stream().replaceAll('\n', '\r\n');
    const events = parsedSse(await new Response(source(raw, 1).pipeThrough(createResponsesChatStream('friendly'))).text());
    expect(events[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'friendly', choices: [{ delta: { role: 'assistant' } }] });
    expect(events.flatMap(item => item.choices ?? []).map(item => item.delta?.content ?? '').join('')).toBe('你🙂');
    expect(events.flatMap(item => item.choices ?? []).map(item => item.delta?.reasoning_content ?? '').join('')).toBe('Public summary');
    expect(events.at(-1)).toBe('[DONE]'); expect(events.at(-2)).toMatchObject({ choices: [], usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } } });
    expect(await collectResponsesChatStream(source(raw, 1), 'friendly')).toMatchObject({ model: 'friendly', choices: [{ finish_reason: 'stop', message: { content: '你🙂', reasoning_content: 'Public summary' } }] });
  });
  it('preserves incremental JSON tool arguments and call IDs', async () => {
    const events = parsedSse(await new Response(source(stream([responseCall]), 1).pipeThrough(createResponsesChatStream('friendly'))).text());
    const calls = events.flatMap(item => item.choices ?? []).flatMap(item => item.delta?.tool_calls ?? []);
    expect(calls[0]).toMatchObject({ id: 'call_synthetic', index: 0, type: 'function', function: { name: 'read_file' } });
    expect(calls.map(item => item.function.arguments).join('')).toBe('{"path":"a.ts"}');
    expect(await collectResponsesChatStream(source(stream([responseCall]), 1), 'friendly')).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [chatCall] } }] });
  });
  it('preserves separate call IDs/indices when parallel tool arguments arrive interleaved', async () => {
    const second = { ...responseCall, call_id: 'call_second', name: 'write_file', arguments: '{"content":"OK"}' };
    const raw = [
      { type: 'response.output_item.added', output_index: 0, item: { ...responseCall, arguments: '' } },
      { type: 'response.output_item.added', output_index: 1, item: { ...second, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"content":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"OK"}' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"a.ts"}' },
      { type: 'response.completed', response: responses([responseCall, second]) },
    ].map(event).join('');
    const converted = await collectResponsesChatStream(source(raw, 1), 'friendly');
    expect(converted).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [chatCall, { id: 'call_second', function: { name: 'write_file', arguments: second.arguments } }] } }] });
  });
  it('preserves incremental refusal and rejects a final text inconsistent with already emitted text', async () => {
    const raw = [
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } },
      { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Cannot comply' },
      { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'Cannot comply' },
      { type: 'response.completed', response: responses([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot comply' }] }]) },
    ].map(event).join('');
    expect(await collectResponsesChatStream(source(raw, 1), 'friendly')).toMatchObject({ choices: [{ message: { content: null, refusal: 'Cannot comply' }, finish_reason: 'stop' }] });
    const inconsistent = event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'First' })
      + event({ type: 'response.completed', response: responses([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Different' }] }]) });
    const failed = await new Response(source(inconsistent).pipeThrough(createResponsesChatStream('friendly'))).text();
    expect(failed).toContain('responses_bridge_error'); expect(failed).not.toContain('[DONE]');
  });
  it('supports final-only output, refusal and typed output-item fallback when terminal output is omitted', async () => {
    for (const payload of [responses(), responses([responseCall]), responses([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot comply' }] }])]) {
      const result = await collectResponsesChatStream(source(event({ type: 'response.completed', response: payload })), 'friendly');
      expect(result.choices).toEqual(responsesToChat(payload, 'friendly').choices);
    }
    const raw = event({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final only' }] } })
      + event({ type: 'response.completed', response: { ...responses(), output: undefined } });
    expect(await collectResponsesChatStream(source(raw), 'friendly')).toMatchObject({ choices: [{ message: { content: 'Final only' } }] });
  });
  it('handles valid max_output_tokens truncation without pretending incomplete JSON is complete', async () => {
    const payload = responses([{ ...responseCall, arguments: '{"path":' }], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    const raw = event({ type: 'response.incomplete', response: payload });
    expect(await collectResponsesChatStream(source(raw), 'friendly')).toMatchObject({ choices: [{ finish_reason: 'length', message: { tool_calls: [{ function: { arguments: '{"path":' } }] } }] });
  });
  it.each([
    event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial' }),
    stream() + event({ type: 'error', error: { message: 'PRIVATE_ERROR PRIVATE_KEY' } }),
    stream() + event('[DONE]') + event({ type: 'response.failed', response: { error: { message: 'PRIVATE_ERROR' } } }),
    event({ type: 'response.failed', response: { status: 'failed' } }), 'data: {PRIVATE_JSON\n\n',
    event({ type: 'response.completed', response: responses([{ ...responseCall, arguments: '{PRIVATE_JSON' }]) }),
  ])('never emits finish/DONE for partial or late-error streams', async raw => {
    const mapped = await new Response(source(raw).pipeThrough(createResponsesChatStream('friendly'))).text();
    expect(mapped).toContain('"responses_bridge_error"'); expect(mapped).not.toContain('[DONE]'); expect(mapped).not.toMatch(/"finish_reason":"|PRIVATE_/);
    await expect(collectResponsesChatStream(source(raw), 'friendly')).rejects.toMatchObject({ status: 502 });
  });
  it('observes true upstream usage and a fixed error marker while ignoring observer failure', async () => {
    const observed: unknown[] = [];
    await new Response(source(stream()).pipeThrough(createResponsesChatStream('friendly', { onUpstreamEvent(value) { observed.push(value); throw new Error('diagnostic failure'); } }))).text();
    expect(observed.some((item: any) => item.response?.usage?.input_tokens === 12)).toBe(true);
    observed.length = 0;
    await new Response(source(stream() + event({ type: 'error', error: { message: 'PRIVATE' } })).pipeThrough(createResponsesChatStream('friendly', { onUpstreamEvent(value) { observed.push(value); } }))).text();
    expect(observed.at(-1)).toMatchObject({ type: 'error', error: { code: 'responses_bridge_error' } });
  });
  it('completes a real localhost two-turn tool roundtrip through streaming Responses', async () => {
    const seen: any[] = [];
    const url = await listen(createServer((req, res) => {
      let raw = ''; req.on('data', part => { raw += part; }); req.on('end', () => {
        const body = JSON.parse(raw); seen.push({ path: req.url, body }); res.setHeader('content-type', 'text/event-stream');
        const returned = body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_synthetic' && item.output === 'SYNTHETIC_FILE_CONTENT');
        res.end(returned ? stream() : stream([responseCall]));
      });
    }));
    const firstUpstream = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer SYNTHETIC_KEY', 'content-type': 'application/json' }, body: JSON.stringify(parseChatResponsesRequest(request)) });
    const first = await collectResponsesChatStream(firstUpstream.body!, 'friendly');
    expect(first).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [chatCall] } }] });
    // Chat 的 reasoning_content 是扩展显示字段；原生推理签名不会伪造回传。
    const firstMessage = { ...(first.choices as any[])[0].message }; delete firstMessage.reasoning_content;
    const followup = parseChatResponsesRequest({ ...request, messages: [...request.messages, firstMessage, { role: 'tool', tool_call_id: 'call_synthetic', content: 'SYNTHETIC_FILE_CONTENT' }] });
    const finalUpstream = await fetch(url, { method: 'POST', body: JSON.stringify(followup) });
    expect(await collectResponsesChatStream(finalUpstream.body!, 'friendly')).toMatchObject({ choices: [{ finish_reason: 'stop', message: { content: '你🙂' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    expect(seen).toHaveLength(2); expect(seen.every(item => item.path === '/v1/responses')).toBe(true);
    expect(seen[1].body.input).toContainEqual({ type: 'function_call', call_id: 'call_synthetic', name: 'read_file', arguments: '{"path":"a.ts"}' });
  });
  it('withholds finish/DONE until actual EOF even after response.completed', async () => {
    let finish!: () => void;
    const url = await listen(createServer((_req, res) => {
      res.setHeader('content-type', 'text/event-stream'); res.write(stream()); finish = () => res.end(event({ type: 'error', error: { message: 'PRIVATE_LATE_ERROR' } }));
    }));
    const upstream = await fetch(url), reader = upstream.body!.pipeThrough(createResponsesChatStream('friendly')).getReader();
    let partial = '';
    while (!partial.includes('"content":"🙂"')) { const chunk = await reader.read(); partial += new TextDecoder().decode(chunk.value); }
    expect(partial).not.toContain('[DONE]'); expect(partial).not.toMatch(/"finish_reason":"/); finish();
    while (true) { const chunk = await reader.read(); if (chunk.done) break; partial += new TextDecoder().decode(chunk.value); }
    expect(partial).toContain('responses_bridge_error'); expect(partial).not.toContain('[DONE]'); reader.releaseLock();
  });
  it.each(['reader', 'signal'] as const)('propagates %s cancellation to the real local upstream socket', async method => {
    let closed!: () => void; const closedPromise = new Promise<void>(resolve => { closed = resolve; });
    const url = await listen(createServer((_req, res) => { res.on('close', closed); res.setHeader('content-type', 'text/event-stream'); res.write(event({ type: 'response.created', response: { status: 'in_progress' } })); }));
    const upstream = await fetch(url), controller = new AbortController();
    const reader = upstream.body!.pipeThrough(createResponsesChatStream('friendly', { signal: controller.signal })).getReader();
    expect((await reader.read()).done).toBe(false);
    if (method === 'reader') await reader.cancel();
    else { controller.abort(); await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' }); }
    reader.releaseLock(); await closedPromise;
  });
});
