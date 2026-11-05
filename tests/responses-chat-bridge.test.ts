import { describe, expect, it } from 'vitest';
import { chatToResponses, collectChatResponsesStream, createChatResponsesStream, parseResponsesChatRequest, ResponsesChatBridgeError } from '../src/main/responses-chat-bridge';

const encoder = new TextEncoder();
const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'chatcmpl_synthetic', object: 'chat.completion.chunk', created: 1, model: 'private-upstream', choices: [{ index: 0, delta, finish_reason }] });
function source(text: string, bytewise = false): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { const bytes = encoder.encode(text); if (bytewise) for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); else controller.enqueue(bytes); controller.close(); } });
}
function events(text: string): any[] { return text.split(/\n\n/).filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5))); }
async function converted(text: string, bytewise = false) { return events(await new Response(source(text, bytewise).pipeThrough(createChatResponsesStream('local-alias'))).text()); }
async function within<T>(promise: Promise<T>, milliseconds = 1500): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Incremental read timed out')), milliseconds); })]); } finally { clearTimeout(timer); } }

describe('stateless Responses requests over Chat', () => {
  it('preserves complete instructions, messages, images and a two-round function history', () => {
    const image = 'data:image/png;base64,AAAA';
    const parsed = parseResponsesChatRequest({ model: 'ExactCase', stream: true, store: false, instructions: 'SYSTEM_FIXTURE', input: [
      { role: 'user', content: [{ type: 'input_text', text: 'USER_FIXTURE' }, { type: 'input_image', image_url: image, detail: 'low' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_fixture', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'TOOL_RESULT_FIXTURE' },
      { role: 'user', content: 'Continue' },
    ], tools: [{ type: 'function', name: 'read_fixture', parameters: { type: 'object' }, strict: true }], tool_choice: { type: 'function', name: 'read_fixture' }, parallel_tool_calls: false, max_output_tokens: 256 });
    expect(parsed).toMatchObject({ model: 'ExactCase', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 256, messages: [
      { role: 'system', content: 'SYSTEM_FIXTURE' },
      { role: 'user', content: [{ type: 'text', text: 'USER_FIXTURE' }, { type: 'image_url', image_url: { url: image, detail: 'low' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_fixture', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'TOOL_RESULT_FIXTURE' }, { role: 'user', content: 'Continue' },
    ], tools: [{ type: 'function', function: { name: 'read_fixture', strict: true } }], tool_choice: { type: 'function', function: { name: 'read_fixture' } }, parallel_tool_calls: false });
  });
  it('maps bounded sampling, reasoning and structured output without mutating input', () => {
    const input = { model: 'M', input: 'Q', temperature: 0.5, top_p: 0.9, reasoning: { effort: 'high' }, text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } } };
    const original = structuredClone(input), parsed = parseResponsesChatRequest(input);
    expect(parsed).toMatchObject({ reasoning_effort: 'high', response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } }, messages: [{ role: 'user', content: 'Q' }] }); expect(input).toEqual(original);
  });
  it.each([
    { previous_response_id: 'resp_private' }, { conversation: 'private_conversation' }, { store: true }, { truncation: 'auto' }, { include: ['reasoning.encrypted_content'] },
    { input: [{ type: 'reasoning', encrypted_content: 'PRIVATE_ENCRYPTED' }] }, { input: [{ type: 'function_call_output', call_id: 'missing', output: 'PRIVATE_RESULT' }] },
    { input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: 'not-json' }] }, { tools: [{ type: 'web_search' }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://user:private@example.com/image' }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a', file_id: 'PRIVATE_FILE' }] }] },
    { reasoning: { effort: 'high', summary: 'auto' } }, { max_output_tokens: 0 }, { temperature: NaN }, { unknown_option: 'PRIVATE' },
  ])('rejects unsupported request semantics before inference: %j', patch => {
    expect(() => parseResponsesChatRequest({ model: 'M', input: 'Q', ...patch })).toThrow(ResponsesChatBridgeError);
    try { parseResponsesChatRequest({ model: 'M', input: 'Q', ...patch }); } catch (error) { expect(error).toMatchObject({ status: 400 }); expect(String(error)).not.toMatch(/PRIVATE|private@example/); }
  });
});

describe('incremental Chat to Responses bridge', () => {
  it('publishes the first content delta while upstream remains open', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>, closed = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(encoder.encode(sse(chunk({ role: 'assistant', content: 'FIRST🙂' })))); } });
    const reader = stream.pipeThrough(createChatResponsesStream('local-alias')).getReader(), seen: any[] = [];
    try {
      while (!seen.some(event => event.type === 'response.output_text.delta')) { const part = await within(reader.read()); expect(part.done).toBe(false); seen.push(...events(new TextDecoder().decode(part.value))); }
      expect(seen.find(event => event.type === 'response.output_text.delta')).toMatchObject({ delta: 'FIRST🙂' }); expect(closed).toBe(false); expect(seen.some(event => event.type === 'response.completed')).toBe(false);
      upstream.enqueue(encoder.encode(sse(chunk({ content: 'SECOND' })) + sse(chunk({}, 'stop')) + sse('[DONE]'))); upstream.close(); closed = true;
      while (true) { const part = await within(reader.read()); if (part.done) break; seen.push(...events(new TextDecoder().decode(part.value))); }
      expect(seen.at(-1)).toMatchObject({ type: 'response.completed', response: { status: 'completed', model: 'local-alias', output: [{ content: [{ text: 'FIRST🙂SECOND' }] }] } });
      expect(seen.map(event => event.sequence_number)).toEqual(seen.map((_, index) => index));
    } finally { await reader.cancel(); reader.releaseLock(); }
  });
  it('decodes UTF-8 split at every byte, preserving reasoning, refusal and usage', async () => {
    const result = await converted(': heartbeat\n\n' + sse(chunk({ role: 'assistant', reasoning_content: '想🙂' })) + sse(chunk({ content: '答🙂', refusal: '拒🙂' })) + sse(chunk({}, 'stop')) + sse({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 2 } } }) + sse('[DONE]'), true);
    expect(result.filter(event => event.type.endsWith('.delta')).map(event => event.delta)).toEqual(['想🙂', '答🙂', '拒🙂']);
    expect(result.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [{ type: 'reasoning', summary: [{ text: '想🙂' }] }, { type: 'message', content: [{ text: '答🙂' }] }, { type: 'message', content: [{ refusal: '拒🙂' }] }], usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10, output_tokens_details: { reasoning_tokens: 2 } } } });
  });
  it('streams function arguments before EOF and reconstructs exact calls without duplicate names', async () => {
    const result = await converted(sse(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_fixture', arguments: '{"path":' } }] })) + sse(chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] })) + sse(chunk({}, 'tool_calls')) + sse('[DONE]'));
    expect(result.filter(event => event.type === 'response.function_call_arguments.delta').map(event => event.delta)).toEqual(['{"path":', '"a"}']);
    expect(result.at(-1)).toMatchObject({ response: { output: [{ type: 'function_call', call_id: 'call_1', name: 'read_fixture', arguments: '{"path":"a"}', status: 'completed' }] } });
  });
  it('buffers only unidentified tool fragments until ID and name arrive', async () => {
    const result = await converted(sse(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] })) + sse(chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '1}' } }] })) + sse(chunk({}, 'tool_calls')) + sse('[DONE]'));
    expect(result.filter(event => event.type === 'response.function_call_arguments.delta').map(event => event.delta).join('')).toBe('{"a":1}');
    expect(result.at(-1)).toMatchObject({ response: { output: [{ name: 'f', arguments: '{"a":1}' }] } });
  });
  it('retains length exhaustion as incomplete with an explicit budget reason', async () => {
    const response = await collectChatResponsesStream(source(sse(chunk({ content: 'partial' }, 'length')) + sse('[DONE]')), 'alias');
    expect(response).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ content: [{ text: 'partial' }] }] });
  });
  it.each([
    sse(chunk({ content: 'partial' })),
    sse(chunk({ content: 'partial' }, 'stop')),
    sse(chunk({ content: 'partial' })) + sse('[DONE]'),
    sse(chunk({ content: 'partial' }, 'stop')) + sse('[DONE]') + sse('[DONE]'),
    sse(chunk({ content: 'partial' }, 'stop')) + sse('[DONE]') + sse(chunk({ content: 'late' })),
    sse(chunk({ content: 'partial' })) + 'data: {PRIVATE_INVALID_JSON\n\n',
    sse(chunk({ content: 'partial' })) + sse({ error: { message: 'PRIVATE_ERROR_BODY' } }),
    sse(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{' } }] }, 'tool_calls')) + sse('[DONE]'),
    sse(chunk({ content: 'partial' }, 'content_filter')) + sse('[DONE]'),
    sse({ choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: 'b' } }] }),
    sse(chunk({ content: 'a' })) + sse({ ...chunk({ content: 'b' }, 'stop'), id: 'changed-id' }) + sse('[DONE]'),
    sse(chunk({ content: 'a' })) + sse({ ...chunk({ content: 'b' }, 'stop'), model: 'changed-model' }) + sse('[DONE]'),
    sse(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] })) + sse(chunk({ tool_calls: [{ index: 0, id: 'changed', function: { name: 'f' } }] }, 'tool_calls')) + sse('[DONE]'),
  ])('never invents successful completion for malformed or truncated upstream: %#', async text => {
    const result = await converted(text); expect(result.at(-1)).toMatchObject({ type: 'response.failed', response: { status: 'failed', error: { code: 'upstream_error' } } });
    expect(result.some(event => ['response.completed', 'response.incomplete'].includes(event.type))).toBe(false); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_INVALID_JSON|PRIVATE_ERROR_BODY/);
    await expect(collectChatResponsesStream(source(text), 'alias')).rejects.toMatchObject({ status: 502 });
  });
  it('propagates cancellation to the upstream source without finishing the response', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(chunk({ content: 'first' })))); }, cancel() { canceled = true; } });
    const reader = stream.pipeThrough(createChatResponsesStream('alias')).getReader(); await within(reader.read()); await reader.cancel(); await within(new Promise<void>(resolve => setImmediate(resolve))); expect(canceled).toBe(true); reader.releaseLock();
  });
  it('aborts blocked reads through the provided signal', async () => {
    const controller = new AbortController(), stream = new ReadableStream<Uint8Array>();
    const pending = collectChatResponsesStream(stream, 'alias', { signal: controller.signal }); controller.abort(); await expect(within(pending)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('normalizes valid JSON replies through the same terminal validation', () => {
    expect(chatToResponses({ choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }, 'alias')).toMatchObject({ model: 'alias', status: 'completed', output: [{ content: [{ text: 'answer' }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
    expect(chatToResponses({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, 'alias')).toMatchObject({ output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }] });
    expect(() => chatToResponses({ choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: null }] }, 'alias')).toThrow(ResponsesChatBridgeError);
  });
});
