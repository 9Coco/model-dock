import { describe, expect, it } from 'vitest';
import { collectJetBrainsGrazieChat, createJetBrainsGrazieChatStream, JetBrainsGrazieBridgeError, JetBrainsGrazieSignatures, prepareJetBrainsGrazieChat } from '../src/main/jetbrains-grazie-bridge';
const user = { role: 'user', content: 'USER' }, options = { profileId: 'profile-native', signatureNamespace: 'account-sha:profile-native' };
const tool = { type: 'function', function: { name: 'lookup', description: 'look', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } };
const frame = (row: unknown) => `data: ${JSON.stringify(row)}\n\n`;
const content = (text = 'OK', extra = {}) => frame({ type: 'Content', event_type: 'data', content: text, choiceIndex: 0, ...extra });
const finish = (reason = 'stop') => frame({ type: 'FinishMetadata', event_type: 'data', reason, choiceIndex: 0 });
const toolFrame = (args = '{"q":"x"}', extra = {}) => frame({ type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'call-1', name: 'lookup', content: args, ...extra });
const stream = (text: string): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
const response = (text: string, patch = {}) => new Response(stream(text).pipeThrough(createJetBrainsGrazieChatStream('local-alias', { ...options, ...patch }))).text();

describe('official JetBrains Grazie V9 request serialization', () => {
  it('matches the installed official Request and LLMConfig serializer golden without substituting provider or public model IDs', () => {
    expect(prepareJetBrainsGrazieChat({ model: 'public-alias', messages: [{ role: 'system', content: 'SYS' }, user], tools: [tool], tool_choice: 'auto', parallel_tool_calls: true, max_tokens: 64, temperature: 0.2, top_p: 0.8, seed: 42, stop: ['STOP'], n: 1 }, options)).toEqual({
      prompt: 'modeldock', profile: 'profile-native', chat: { messages: [{ type: 'system_message', content: 'SYS' }, { type: 'user_message', content: 'USER' }] },
      parameters: { toolConfig: { tools: [{ name: 'lookup', description: 'look', parameters: { schema: tool.function.parameters } }], toolChoice: { auto: true }, parallelToolCalls: true }, length: 64, temperature: 0.2, topP: 0.8, seed: 42, stopToken: 'STOP' },
    });
  });
  it('uses official inline media messages without fetching or forwarding remote image URLs', () => {
    expect(prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] }] }, options)).toMatchObject({ chat: { messages: [{ type: 'user_message', content: 'see' }, { type: 'media_message', mediaType: 'image/png', data: 'AQID' }] } });
    expect(() => prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.example/image.png' } }] }] }, options)).toThrow(JetBrainsGrazieBridgeError);
  });
  it.each([{ reasoning_effort: 'high' }, { thinking_budget: 1024 }, { max_tokens: 100, max_completion_tokens: 200 }, { stop: ['one', 'two'] }, { n: 2 }, { response_format: { type: 'json_object' } }, { tools: [{ ...tool, function: { ...tool.function, strict: true } }] }])('rejects unverified controls before any network request: %j', change => {
    expect(() => prepareJetBrainsGrazieChat({ messages: [user], ...change }, options)).toThrow(JetBrainsGrazieBridgeError);
  });
  it('rejects unmatched tools, incomplete history and nonempty display-only reasoning instead of inventing native context', () => {
    for (const messages of [[{ role: 'tool', tool_call_id: 'missing', content: 'x' }], [{ role: 'assistant', reasoning_content: 'hidden', content: 'answer' }], [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, user]]) expect(() => prepareJetBrainsGrazieChat({ messages }, options)).toThrow(JetBrainsGrazieBridgeError);
  });
  it.each([
    { role: 'assistant', content: 'answer', function_call: { name: 'lookup', arguments: '{}' } },
    { role: 'assistant', content: 'answer', audio: { id: 'audio-1' } },
    { role: 'assistant', content: 'answer', refusal: 'refused' },
    { role: 'user', content: 'question', name: 'named-user' },
    { role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', mime_type: 'image/png' } }] },
    { role: 'user', content: '\ud800' },
  ])('rejects unsupported message semantics before any network request: %j', message => {
    expect(() => prepareJetBrainsGrazieChat({ messages: [message] }, options)).toThrow(JetBrainsGrazieBridgeError);
  });
  it('rejects unrecognized tool, function, choice and call fields rather than silently dropping them', () => {
    for (const change of [
      { tools: [{ ...tool, server_tool: true }] },
      { tools: [{ ...tool, function: { ...tool.function, cache_control: { type: 'ephemeral' } } }] },
      { tools: [tool], tool_choice: { type: 'function', function: { name: 'lookup', force: true } } },
      { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}', thought_signature: 'PRIVATE' } }] }] },
    ]) expect(() => prepareJetBrainsGrazieChat({ messages: [user], ...change }, options)).toThrow(JetBrainsGrazieBridgeError);
    expect(() => prepareJetBrainsGrazieChat({ messages: [{ role: 'assistant', content: 'answer', reasoning_content: '' }, user] }, options)).not.toThrow();
  });
});

describe('native continuous SSE semantics and main-only signatures', () => {
  it('forwards the first real text delta before upstream finish while withholding success until EOF', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const native = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    const reader = native.pipeThrough(createJetBrainsGrazieChatStream('local-alias', options)).getReader();
    upstream.enqueue(new TextEncoder().encode(content('HELLO')));
    const first = new TextDecoder().decode((await reader.read()).value); expect(first).toContain('"role":"assistant"');
    const second = new TextDecoder().decode((await reader.read()).value); expect(second).toContain('HELLO'); expect(second).not.toContain('[DONE]');
    upstream.enqueue(new TextEncoder().encode(finish())); const waiting = reader.read();
    expect(await Promise.race([waiting.then(() => 'early'), new Promise(resolve => setTimeout(() => resolve('waiting'), 20))])).toBe('waiting');
    upstream.close(); expect(new TextDecoder().decode((await waiting).value)).toContain('"finish_reason":"stop"');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('[DONE]'); expect((await reader.read()).done).toBe(true);
  });
  it('collects nonstream answers through the same native stream validation and preserves the public alias', async () => {
    const result = await collectJetBrainsGrazieChat(stream(content('A') + content('B') + finish()), 'alias', options);
    expect(result).toMatchObject({ model: 'alias', choices: [{ message: { role: 'assistant', content: 'AB' }, finish_reason: 'stop' }] });
  });
  it('preserves arguments incrementally and restores opaque signatures only for exact account/model/history/tool identity', async () => {
    const signatures = new JetBrainsGrazieSignatures(), history = [user];
    const normalized = await response(toolFrame('{"q":', { thoughtSignature: 'OPAQUE_TOOL_SIG' }) + frame({ type: 'ToolCall', event_type: 'data', content: '"x"}', parallelToolIndex: 0 }) + finish('tool_call'), { signatures, history, toolNames: ['lookup'] });
    expect(normalized).toContain('"arguments":"{\\"q\\":"'); expect(normalized).not.toContain('OPAQUE_TOOL_SIG');
    const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] };
    const body = { messages: [user, assistant, { role: 'tool', tool_call_id: 'call-1', content: 'result' }, { role: 'user', content: 'continue' }] };
    const prepared = prepareJetBrainsGrazieChat(body, { ...options, signatures, requireToolSignatures: true });
    expect(prepared).toMatchObject({ chat: { messages: [{ type: 'user_message' }, { type: 'assistant_message_tool', id: 'call-1', toolName: 'lookup', content: '{"q":"x"}', thoughtSignature: 'OPAQUE_TOOL_SIG' }, { type: 'tool_message', id: 'call-1', result: 'result' }, { type: 'user_message' }] } });
    expect(() => prepareJetBrainsGrazieChat(body, { ...options, signatures, signatureNamespace: 'other-account:profile-native', requireToolSignatures: true })).toThrow(JetBrainsGrazieBridgeError);
    expect(() => prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: 'different-prefix' }, ...body.messages.slice(1)] }, { ...options, signatures, requireToolSignatures: true })).toThrow(JetBrainsGrazieBridgeError);
  });
  it('scopes identical text signatures to preceding history and keeps them out of responses', async () => {
    const signatures = new JetBrainsGrazieSignatures();
    expect(await response(content('OK', { thoughtSignature: 'OPAQUE_TEXT_SIG' }) + finish(), { signatures, history: [user] })).not.toContain('OPAQUE_TEXT_SIG');
    const same = prepareJetBrainsGrazieChat({ messages: [user, { role: 'assistant', content: 'OK' }, user] }, { ...options, signatures });
    expect(same).toMatchObject({ chat: { messages: [{ type: 'user_message' }, { type: 'assistant_message_text', thoughtSignature: 'OPAQUE_TEXT_SIG' }, { type: 'user_message' }] } });
    const different = prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: 'other' }, { role: 'assistant', content: 'OK' }, user] }, { ...options, signatures });
    expect(JSON.stringify(different)).not.toContain('OPAQUE_TEXT_SIG');
  });
  it.each([content() + finish() + frame({ type: 'Error', event_type: 'error', message: 'PRIVATE_RAW_ERROR' }), content(), content() + finish() + content('late'), toolFrame('{bad') + finish('tool_call'), content() + finish('unknown'), frame({ type: 'Reasoning', event_type: 'data', content: 'unsupported' }), frame({ type: 'Content', event_type: 'data', content: 3 }), '[DONE]\n\n'])('rejects malformed/truncated/late failure without exposing a successful terminal: %j', async value => {
    await expect(response(value)).rejects.toMatchObject({ status: 502 });
    await expect(collectJetBrainsGrazieChat(stream(value), 'alias', options)).rejects.toMatchObject({ status: 502 });
  });
  it('does not commit signatures from truncated streams or streams canceled before terminal EOF', async () => {
    const signatures = new JetBrainsGrazieSignatures();
    await expect(response(toolFrame('{}', { thoughtSignature: 'FAILED_SIG' }), { signatures, history: [user] })).rejects.toMatchObject({ status: 502 }); expect(signatures.stats().entries).toBe(0);
    const controller = new AbortController(); const native = new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode(content('partial', { thoughtSignature: 'CANCEL_SIG' }))); } });
    const reader = native.pipeThrough(createJetBrainsGrazieChatStream('alias', { ...options, signatures, history: [user], signal: controller.signal })).getReader(); await reader.read(); controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ status: 502 }); expect(signatures.stats().entries).toBe(0);
  });
  it('commits no partial receipts if a later completed tool exceeds the cache bounds', async () => {
    const signatures = new JetBrainsGrazieSignatures({ maxSignatureBytes: 8 });
    const value = content('text', { thoughtSignature: 'small' }) + toolFrame('{}', { thoughtSignature: 'TOO_LONG_SIGNATURE' }) + finish('tool_call');
    await expect(response(value, { signatures, history: [user] })).rejects.toMatchObject({ status: 502 });
    expect(signatures.stats().entries).toBe(0);
  });
  it('bounds tool arguments and refuses unauthorized upstream function names', async () => {
    await expect(response(toolFrame('x'.repeat(256 * 1024 + 1)) + finish('tool_call'))).rejects.toMatchObject({ status: 502 });
    await expect(response(toolFrame('{}') + finish('tool_call'), { toolNames: ['other'] })).rejects.toMatchObject({ status: 502 });
  });
  it('accepts official default Data events and missing default tool content while retaining nullable continuation identities', async () => {
    const signatures = new JetBrainsGrazieSignatures();
    const value = frame({ type: 'ToolCall', choiceIndex: null, parallelToolIndex: null, id: 'call-1', name: 'lookup' })
      + frame({ type: 'ToolCall', choiceIndex: null, parallelToolIndex: null, id: null, name: null, content: '{}' })
      + frame({ type: 'FinishMetadata', reason: 'tool_call' });
    expect(await response(value, { signatures, history: [user] })).toContain('"finish_reason":"tool_calls"');
    const body = { messages: [user, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', name: 'lookup', content: 'result' }, user] };
    expect(JSON.stringify(prepareJetBrainsGrazieChat(body, { ...options, signatures, requireToolSignatures: true }))).not.toContain('thoughtSignature');
    signatures.clear();
    expect(() => prepareJetBrainsGrazieChat(body, { ...options, signatures, requireToolSignatures: true })).toThrow(JetBrainsGrazieBridgeError);
    await expect(response(frame({ type: 'Content', event_type: null, content: 'invalid' }) + finish())).rejects.toMatchObject({ status: 502 });
    await expect(response(toolFrame('{}', { content: null }) + finish('tool_call'))).rejects.toMatchObject({ status: 502 });
  });
  it('handles every byte boundary in CRLF including multibyte content and a final trailing frame', async () => {
    const bytes = new TextEncoder().encode((content('中文') + finish()).replace(/\n/g, '\r\n'));
    let position = 0;
    const fragmented = new ReadableStream<Uint8Array>({ pull(controller) { if (position < bytes.length) controller.enqueue(bytes.slice(position, ++position)); else controller.close(); } });
    expect(await collectJetBrainsGrazieChat(fragmented, 'alias', options)).toMatchObject({ choices: [{ message: { content: '中文' }, finish_reason: 'stop' }] });
    await expect(response((content() + finish()).replace(/\n/g, '\r\n') + 'data: {"type":"Content"}')).rejects.toMatchObject({ status: 502 });
  });
  it.each([
    toolFrame('{}') + toolFrame('{}', { parallelToolIndex: 1 }) + finish('tool_call'),
    toolFrame('{}', { id: '\ud800' }) + finish('tool_call'),
    toolFrame('{}', { name: '\ud800' }) + finish('tool_call'),
    toolFrame('{"q":"\ud800"}') + finish('tool_call'),
    toolFrame('{}') + finish('length'),
  ])('rejects duplicate tool identities, malformed Unicode and budget-truncated tool calls: %j', async value => {
    await expect(response(value)).rejects.toMatchObject({ status: 502 });
  });
});


describe('official continuous SSE end and Chat SDK compatibility', () => {
  it('accepts the official end sentinel only after validated content and finish', async () => {
    const reply = await response(content() + finish() + 'data: end\n\n');
    expect(reply).toContain('OK'); expect(reply.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
  it.each([
    'data: end\n\n', content() + 'data: end\n\n',
    content() + finish() + 'data: end\n\ndata: end\n\n',
    content() + finish() + 'data: end\n\n' + content('late'),
    content() + finish() + frame({ event_type: 'error', type: 'Error' }) + 'data: end\n\n',
  ])('never turns premature, repeated, late or failed terminal input into success: %j', async source => {
    await expect(response(source)).rejects.toMatchObject({ status: 502 });
  });
  it('uses the official unknown-metadata fallback without swallowing explicit failure', async () => {
    expect(await response(content() + frame({ event_type: 'data', type: 'FutureMetadata', content: '' }) + finish() + 'data: end\n\n')).toContain('[DONE]');
    for (const row of [{ event_type: 'data', type: 'FutureMetadata', error: {} }, { event_type: 'data', type: 'response.failed' }]) await expect(response(content() + frame(row) + finish() + 'data: end\n\n')).rejects.toMatchObject({ status: 502 });
  });
  it('treats standard null or empty optional Chat fields as absent without changing history signatures', async () => {
    const signatures = new JetBrainsGrazieSignatures();
    const original = { role: 'assistant', content: 'prior', tool_calls: null, reasoning_content: null, refusal: null, function_call: null, audio: null, name: null, tool_call_id: null };
    const history = [user, original, user];
    await response(toolFrame('{}', { thoughtSignature: 'SDK_SIG' }) + finish('tool_call') + 'data: end\n\n', { signatures, history });
    const normalized = [user, { role: 'assistant', content: 'prior', tool_calls: [] }, user, { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'result' }];
    const request = prepareJetBrainsGrazieChat({ messages: normalized }, { ...options, signatures, requireToolSignatures: true });
    expect(request.chat).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ type: 'assistant_message_tool', thoughtSignature: 'SDK_SIG' })]) });
    expect(() => prepareJetBrainsGrazieChat({ messages: [original, user] }, options)).not.toThrow();
  });
});
