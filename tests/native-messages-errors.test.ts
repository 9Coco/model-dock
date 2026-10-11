import { describe, expect, it } from 'vitest';
import { collectNativeMessagesStream, createNativeMessagesStream, toNativeMessagesResponse } from '../src/main/native-messages';
import { normalizeNativeMessagesError } from '../src/main/native-messages-errors';

const sse = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const start = sse('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'upstream-model', content: [], stop_reason: null } });
const tool = sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_fixture', name: 'WebFetch', input: {} } });
const complete = start + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + sse('message_stop', { type: 'message_stop' });
// Captured provider event shape with synthetic values; no real request/credential fixtures.
const rejection = { type: 'error', error: { type: 'BadRequest', code: 'InvalidParameter', param: 'messages.tool_calls.type', message: 'The parameter `messages.tool_calls.type` is empty and must be function. SYNTHETIC_API_KEY PRIVATE_REQUEST_ECHO', request: { messages: 'PRIVATE_REQUEST_BODY' }, debug: 'PRIVATE_UPSTREAM_DEBUG' }, request_id: 'PRIVATE_REQUEST_ID', debug: 'PRIVATE_TOP_LEVEL_DEBUG' };

function chunks(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
}
async function transformed(text: string, observed: unknown[] = []) {
  return new Response(chunks(text).pipeThrough(createNativeMessagesStream('local-alias', { onUpstreamEvent: value => observed.push(value) }))).text();
}

describe('Closed native Messages error normalization', () => {
  it('classifies the captured tool-call rejection without exposing provider text or request metadata', () => {
    const error = normalizeNativeMessagesError(rejection);
    expect(error).toEqual({ type: 'invalid_request_error', status: 400, message: '上游 Messages 兼容接口拒绝工具调用参数（messages.tool_calls.type）：工具调用类型必须为 function。' });
    expect(JSON.stringify(error)).not.toMatch(/SYNTHETIC_API_KEY|PRIVATE_|The parameter|request_id|debug/);
    expect(normalizeNativeMessagesError({ type: 'error', error: { type: error.type, message: error.message } })).toEqual(error);
  });
  it.each([
    ['invalid_request_error', 400], ['authentication_error', 401], ['permission_error', 403], ['not_found_error', 404],
    ['request_too_large', 413], ['rate_limit_error', 429], ['api_error', 502], ['overloaded_error', 529], ['timeout_error', 504],
  ])('preserves the native category %s and its status while discarding arbitrary text', (type, status) => {
    const result = normalizeNativeMessagesError({ type: 'error', error: { type, message: 'PRIVATE_REQUEST_BODY SYNTHETIC_API_KEY', debug: 'PRIVATE_DEBUG' } });
    expect(result).toMatchObject({ type, status });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|SYNTHETIC_API_KEY|debug/);
  });
  it('uses transport authentication/rate-limit semantics for an unreadable HTTP error body', () => {
    expect(normalizeNativeMessagesError(undefined, 401)).toMatchObject({ type: 'authentication_error', status: 401 });
    expect(normalizeNativeMessagesError('PRIVATE_NOT_JSON', 429)).toMatchObject({ type: 'rate_limit_error', status: 429 });
  });
  it('uses the fixed generic request message when a parameter name is outside the exact allowlist', () => {
    const value = { ...rejection, error: { ...rejection.error, param: 'messages.tool_calls.type.PRIVATE_REQUEST_BODY' } };
    const error = normalizeNativeMessagesError(value);
    expect(error).toEqual({ type: 'invalid_request_error', status: 400, message: '上游拒绝 Messages 请求参数，请检查模型、历史消息和工具定义。' });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|messages.tool_calls/);
  });
  it.each([
    { type: 'error', error: { type: 'unknown_error', message: 'BadRequest InvalidParameter messages.tool_calls.type PRIVATE_ECHO' } },
    { type: 'error', error: { type: 'BadRequest', code: 'DifferentError', param: 'messages.tool_calls.type', message: 'PRIVATE_ECHO' } },
    { type: 'error', error: { type: 'BadRequest', code: 'InvalidParameter', message: 42 } },
    { type: 'error', error: { type: 'invalid_request_error' } },
    { type: 'error', error: { type: 'constructor', message: 'PRIVATE_ECHO' } },
    { type: 'content_block_delta', error: { type: 'invalid_request_error', message: 'PRIVATE_ECHO' } },
    { type: 'error', error: ['invalid_request_error', 'PRIVATE_ECHO'] },
  ])('keeps unknown and malformed error bodies as api_error without guessing from text: %j', value => {
    const error = normalizeNativeMessagesError(value);
    expect(error).toMatchObject({ type: 'api_error', status: 502 });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|InvalidParameter|constructor|messages.tool_calls/);
  });
});

describe('Native Messages SSE error semantics', () => {
  it('emits a nonretryable invalid_request_error after tool-use starts and never claims completion', async () => {
    const observed: unknown[] = [];
    const output = await transformed(start + tool + sse('error', rejection) + sse('message_stop', { type: 'message_stop' }), observed);
    expect(output).toContain('event: content_block_start');
    expect(output).toContain('"type":"invalid_request_error"');
    expect(output).toContain('messages.tool_calls.type');
    expect(output).not.toContain('"type":"api_error"');
    expect(output).not.toContain('event: message_stop');
    expect(observed.at(-1)).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(JSON.stringify([output, observed])).not.toMatch(/PRIVATE_|SYNTHETIC_API_KEY|InvalidParameter|BadRequest|request_id|debug/);
  });
  it('preserves invalid request semantics when collecting a forced SSE response', async () => {
    await expect(collectNativeMessagesStream(chunks(start + tool + sse('error', rejection)), 'local-alias')).rejects.toMatchObject({
      name: 'NativeMessagesError', status: 400, errorType: 'invalid_request_error', message: expect.stringContaining('messages.tool_calls.type'),
    });
  });
  it.each(['authentication_error', 'permission_error', 'rate_limit_error', 'overloaded_error', 'timeout_error'])('keeps %s as a safe native error event', async type => {
    const output = await transformed(start + sse('error', { type: 'error', error: { type, message: 'PRIVATE_ERROR_BODY SYNTHETIC_API_KEY' } }));
    expect(output).toContain(`"type":"${type}"`);
    expect(output).not.toContain('event: message_stop');
    expect(output).not.toMatch(/PRIVATE_ERROR_BODY|SYNTHETIC_API_KEY/);
  });
  it.each([
    start + tool,
    start + sse('error', { type: 'error', error: { type: 'unknown_error', message: 'PRIVATE_ERROR_BODY' } }),
    start + sse('error', { type: 'error', error: { type: 'BadRequest', code: 'InvalidParameter', message: [] } }),
    start + 'event: error\ndata: {"type":"error","error":\n\n',
    start + sse('ping', rejection),
    start + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE_INVALID_BLOCK' } }),
  ])('keeps malformed or truncated streams strict without emitting completion: %s', async text => {
    const output = await transformed(text);
    expect(output).toContain('"type":"api_error"');
    expect(output).not.toContain('event: message_stop');
    expect(output).not.toMatch(/PRIVATE_|BadRequest|InvalidParameter/);
    await expect(collectNativeMessagesStream(chunks(text), 'local-alias')).rejects.toMatchObject({ status: 502, errorType: 'api_error' });
  });
  it('withholds a prior message_stop when an error arrives before transport completion', async () => {
    const output = await transformed(complete + sse('error', rejection));
    expect(output).toContain('"type":"invalid_request_error"');
    expect(output).not.toContain('event: message_stop');
  });
  it('normalizes HTTP-success JSON errors before observing or returning them as a Message', () => {
    const observed: unknown[] = [];
    let caught: unknown;
    try { toNativeMessagesResponse(rejection, 'local-alias', { onUpstreamEvent: value => observed.push(value) }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status: 400, errorType: 'invalid_request_error' });
    expect(observed).toEqual([{ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('messages.tool_calls.type') } }]);
    expect(JSON.stringify(observed) + String(caught)).not.toMatch(/PRIVATE_|SYNTHETIC_API_KEY|BadRequest|InvalidParameter/);
  });
});
