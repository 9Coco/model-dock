import { describe, expect, it, vi } from 'vitest';
import { TraeApi, TraeApiError } from '../src/main/trae-api';
import type { TraeClientCredentials } from '../src/main/trae-client-import';

const credential: TraeClientCredentials = { token: 'SYNTHETIC_TRAE_ACCESS', userId: 'fixture-user', host: 'https://api.trae.cn' };
// Native function-scoped descriptor and SSE shapes from the fixed primary
// raw_client / test_traecode_raw_client / test_ide_native_tool_deltas fixtures.
const directory = { code: 0, config_info_list: [{ config_name: 'glm-5.3', usage: 'chat_completion', config_source: 1,
  display_config: { display_name: 'GLM 5.3' }, model_detail_list: [{ model_name: 'glm-5__max' }, { model_name: 'glm-5__dev' }] }] };
const catalog = () => Response.json(directory);
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const finished = frame('done', { finish_reason: 'stop' });
function sse(text: string) { return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } }); }
const body = { model: 'glm-5.3', messages: [{ role: 'user', content: '你好' }] };
const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
const fetchMock = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => vi.fn<typeof fetch>(async (url, init) => respond(String(url), init!));

describe('direct TraeCode CN native Raw v2 protocol', () => {
  it('uses the exact function-scoped catalog and accurate provider id without Work aliases or guessed models', async () => {
    const fetch = fetchMock(() => catalog()), api = new TraeApi({ fetch });
    const models = await api.models(credential);
    expect(models).toMatchObject({ object: 'list', data: [{ id: 'glm-5.3', object: 'model', owned_by: 'trae', name: 'GLM 5.3' }],
      modeldock_history: { source: 'trae-client', currentVerified: false } });
    const [url, init] = fetch.mock.calls[0]; expect(String(url)).toBe('https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param?function=chat_v3&need_prompt=false&poly_prompt=true');
    expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('x-uid')).toBe(credential.userId);
    await expect(api.chat(credential, { ...body, model: 'imaginary-model' })).rejects.toMatchObject({ code: 'model' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps only usable chat configs and refuses duplicate native identifiers', async () => {
    const invalid = [{ config_name: 'unknown-provider' }, { config_name: 'fim', usage: 'code_completion', model_name: 'fim' }, { config_name: 'other-function', raw_chat_function: 'solo_agent', model_name: 'other' }];
    const api = new TraeApi({ fetch: fetchMock(() => Response.json({ config_info_list: [...directory.config_info_list, ...invalid] })) });
    expect((await api.models(credential)).data).toHaveLength(1);
    await expect(new TraeApi({ fetch: fetchMock(() => Response.json({ config_info_list: [...directory.config_info_list, ...directory.config_info_list] })) }).models(credential)).rejects.toMatchObject({ code: 'response' });
  });
  it('encodes native function histories, correlated tool results and function schemas in the current Raw v2 body', async () => {
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(frame('text_delta', { text: '文件内容已收到' }) + finished));
    const history = [{ role: 'developer', content: 'Use tools' }, { role: 'user', content: 'Read README' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'File contents' }];
    const response = await new TraeApi({ fetch }).chat(credential, { ...body, messages: history, tools: [tool], tool_choice: 'auto', parallel_tool_calls: false, reasoning_effort: 'high' });
    expect((await response.json()).choices[0].message.content).toBe('文件内容已收到');
    const [url, init] = fetch.mock.calls[1]; expect(url).toBe('https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat');
    const sent = JSON.parse(String(init?.body)); expect(sent).toMatchObject({ config_name: 'glm-5.3', model_name: 'glm-5__dev', config_source: 1, raw_chat_function: 'chat_v3', stream: true,
      tools: [{ type: 'function', function: { ...tool.function, parameters: JSON.stringify(tool.function.parameters) } }], tool_choice: 'auto', parallel_tool_calls: false, reasoning_effort: 'high' });
    expect(sent.conversation_id).toBe(sent.session_id); expect(sent.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(sent.messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Use tools' }] });
    expect(sent.messages[2].tool_calls[0]).toEqual({ id: 'call_1', type: 'function', function_call: history[2].tool_calls?.[0].function });
    expect(sent.messages[3]).toEqual({ role: 'tool', content: [{ type: 'text', text: 'File contents' }], tool_call_id: 'call_1', name: 'read_file' });
    expect(new Headers(init?.headers).has('Extra')).toBe(false); expect(new Headers(init?.headers).get('Authorization')).toBe('Cloud-IDE-JWT ' + credential.token);
  });
  it('preserves complex Unicode schemas and exact tool argument text without mutating the caller', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { entry: { type: 'object', properties: { 路径: { type: 'string', description: '目录/说明.txt\n第二行', enum: ['资料/一.txt', '资料/二.txt'] } }, required: ['路径'], additionalProperties: false } },
      type: 'object', properties: { files: { type: 'array', items: { $ref: '#/$defs/entry' }, minItems: 1 }, mode: { anyOf: [{ const: '读取' }, { type: 'null' }] } },
      required: ['files', 'mode'], additionalProperties: false,
    };
    const unicodeTool = { type: 'function', function: { name: 'read_file', description: '读取文件，保留中文与转义', parameters: schema, strict: true } };
    const argumentsText = ' {"files":[{"路径":"资料/一.txt"}], "mode":"读取"} ';
    const request = { ...body, tools: [unicodeTool], messages: [
      { role: 'user', content: '读取资料' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_unicode', type: 'function', function: { name: 'read_file', arguments: argumentsText } }] },
      { role: 'tool', tool_call_id: 'call_unicode', content: '文件内容：你好' },
    ] };
    const snapshot = structuredClone(request);
    const fetch = fetchMock((url, init) => {
      if (new URL(url).pathname.endsWith('get_detail_param')) return catalog();
      const native = JSON.parse(String(init.body)), definition = native.tools[0].function;
      expect(typeof definition.parameters).toBe('string'); expect(JSON.parse(definition.parameters)).toEqual(schema);
      expect(definition).toMatchObject({ name: 'read_file', description: unicodeTool.function.description, strict: true });
      expect(native.messages[1].tool_calls[0]).toEqual({ id: 'call_unicode', type: 'function', function_call: { name: 'read_file', arguments: argumentsText } });
      expect(native.messages[2]).toMatchObject({ role: 'tool', name: 'read_file', tool_call_id: 'call_unicode', content: [{ type: 'text', text: '文件内容：你好' }] });
      return sse(frame('text_delta', { text: 'OK' }) + finished);
    });
    await new TraeApi({ fetch }).chat(credential, request);
    expect(request).toEqual(snapshot);
  });
  it.each(['xhigh', 'max'])('preserves the native legacy %s reasoning level instead of rejecting or renaming it', async reasoning_effort => {
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(frame('text_delta', { text: 'OK' }) + finished));
    await new TraeApi({ fetch }).chat(credential, { ...body, reasoning_effort });
    const sent = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(sent.reasoning_effort).toBe(reasoning_effort); expect(sent).not.toHaveProperty('reasoning_effort_level');
  });
  it.each(['object', 'json-string'])('uses exact modern reasoning levels and the current native field from a %s declaration', async format => {
    const config = { support_thinking: true, options: ['low', 'high', 'ultra'], default_level: 'high' };
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param')
      ? Response.json({ config_info_list: [{ ...directory.config_info_list[0], reasoning_effort_config: format === 'json-string' ? JSON.stringify(config) : config }] })
      : sse(frame('text_delta', { text: 'OK' }) + finished));
    const api = new TraeApi({ fetch });
    expect((await api.models(credential)).data[0]).toMatchObject({ reasoning_efforts: config.options, default_reasoning_effort: 'high' });
    await api.chat(credential, { ...body, reasoning_effort: 'ultra' });
    const sent = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(sent.reasoning_effort_level).toBe('ultra'); expect(sent).not.toHaveProperty('reasoning_effort');
    await expect(api.chat(credential, { ...body, reasoning_effort: 'max' })).rejects.toMatchObject({ code: 'capability', parameter: 'reasoning_effort' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { support_thinking: false, options: ['high'], default_level: 'high' },
    { support_thinking: true, options: ['high', 'high'], default_level: 'high' },
    { support_thinking: true, options: ['high'], default_level: 'unlisted' },
    'invalid-json',
    JSON.stringify(['not-a-config-object']),
  ])('does not invent usable levels from an unsupported or invalid modern config: %j', async reasoning_effort_config => {
    const fetch = fetchMock(() => Response.json({ config_info_list: [{ ...directory.config_info_list[0], reasoning_effort_config }] }));
    const api = new TraeApi({ fetch });
    expect((await api.models(credential)).data[0].reasoning_efforts).toEqual([]);
    await expect(api.chat(credential, { ...body, reasoning_effort: 'high' })).rejects.toMatchObject({ code: 'capability', parameter: 'reasoning_effort' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('honors a restrictive legacy directory instead of accepting every recognized level', async () => {
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param')
      ? Response.json({ config_info_list: [{ ...directory.config_info_list[0], reasoning_effort_options: ['HIGH', 'high', 'max', 'unrecognized'], default_reasoning_effort: 'MAX' }] })
      : sse(frame('text_delta', { text: 'OK' }) + finished));
    const api = new TraeApi({ fetch });
    expect((await api.models(credential)).data[0]).toMatchObject({ reasoning_efforts: ['high', 'max'], default_reasoning_effort: 'max' });
    await api.chat(credential, { ...body, reasoning_effort: 'max' });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).reasoning_effort).toBe('max');
    await expect(api.chat(credential, { ...body, reasoning_effort: 'xhigh' })).rejects.toMatchObject({ code: 'capability' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['max_tokens', 'max_completion_tokens', 'temperature', 'top_p'])('identifies unsupported explicit %s controls without silently dropping them', async field => {
    const fetch = fetchMock(() => catalog());
    const error = await new TraeApi({ fetch }).chat(credential, { ...body, [field]: 1 }).catch(error => error);
    expect(error).toMatchObject({ code: 'capability', parameter: field }); expect(error.message).toContain(field);
    expect(error.message).not.toContain(credential.token); expect(fetch).not.toHaveBeenCalled();
  });
  it('delivers the first visible delta before the upstream finishes, across split UTF-8 and SSE frames', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>; let cancelled = false;
    const native = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel() { cancelled = true; } });
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : new Response(native, { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await new TraeApi({ fetch }).chat(credential, { ...body, stream: true }), reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"role":"assistant"');
    const bytes = new TextEncoder().encode(frame('text_delta', { text: '早到中文' }));
    source.enqueue(bytes.subarray(0, bytes.length - 4)); const first = reader.read(); source.enqueue(bytes.subarray(bytes.length - 4));
    expect(new TextDecoder().decode((await first).value)).toContain('早到中文');
    expect(cancelled).toBe(false); source.enqueue(new TextEncoder().encode(finished)); source.close();
    let rest = ''; for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    expect(rest).toContain('"finish_reason":"stop"'); expect(rest.match(/\[DONE\]/g)).toHaveLength(1);
  });
  it('streams native indexed function-call argument fragments and preserves protocol usage without collecting local statistics', async () => {
    const frames = [frame('output', { tool_calls: [{ index: 0, id: 'call_native', function_call: { name: 'read_file', arguments: '' } }] }),
      ...['{', '"path":', '"README"', '}'].map(arguments_ => frame('output', { tool_calls: [{ index: 0, function_call: { arguments: arguments_ } }] })),
      frame('token_usage', { input_token: 3, output_token: 5 }), frame('done', { finish_reason: 'tool_calls' })].join('');
    const api = new TraeApi({ fetch: fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(frames)) });
    const response = await api.chat(credential, { ...body, tools: [tool] }); const result = await response.json();
    expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_native', type: 'function', function: { name: 'read_file', arguments: '{"path":"README"}' } }] } });
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });
  it('refuses a successful finish when the upstream violates the requested required tool choice', async () => {
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(frame('text_delta', { text: 'No tool' }) + finished));
    await expect(new TraeApi({ fetch }).chat(credential, { ...body, tools: [tool], tool_choice: 'required' })).rejects.toMatchObject({ code: 'response' });
  });
  it('preserves repeated tokens and null text channels in native output events', async () => {
    const raw = [
      frame('metadata', {}), frame('timing_cost', {}),
      frame('output', { response: '', reasoning_content: 'Think', tool_calls: null }),
      frame('output', { response: '', reasoning_content: ' again', tool_calls: null }),
      frame('output', { response: null, reasoning_content: ' again', tool_calls: null }),
      frame('output', { response: 'OK', reasoning_content: null, tool_calls: null, phase: null, multimodal_contents: [] }),
      frame('output', { response: 'OK', reasoning_content: null, tool_calls: null }),
      frame('extra_info', {}), frame('token_usage', { input_token: 8, output_token: 5 }), finished,
    ].join('');
    const api = new TraeApi({ fetch: fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(raw)) });
    const result = await (await api.chat(credential, body)).json();
    expect(result.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'OKOK', reasoning_content: 'Think again again' } });
    expect(result.usage).toEqual({ prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 });
  });
  it('does not turn duplicate cumulative text snapshots into repeated text', async () => {
    const raw = frame('output', { response: 'Hello' }) + frame('output', { response: 'Hello' }) + frame('output', { response: 'Hello world' }) + finished;
    const api = new TraeApi({ fetch: fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(raw)) });
    expect((await (await api.chat(credential, body)).json()).choices[0].message.content).toBe('Hello world');
  });
  it('accepts native adjacent event/data pairs and normalizes the terminal event spelling', async () => {
    const raw = 'event: text_delta\ndata: {"text":"first"}\nevent: text_delta\ndata: {"delta":"second"}\nevent: ResponseDone\ndata: {}\n';
    const api = new TraeApi({ fetch: fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(raw)) });
    expect((await (await api.chat(credential, body)).json()).choices[0].message.content).toBe('firstsecond');
  });
  it('cancels the transport body before the consumer reads a native frame', async () => {
    let cancelled = false;
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await new TraeApi({ fetch }).chat(credential, { ...body, stream: true });
    await response.body!.cancel(); expect(cancelled).toBe(true);
  });
  it('deduplicates reordered complete native arguments without executing the same tool twice', async () => {
    const raw = frame('output', { tool_calls: [{ id: 'call_1', function_call: { name: 'read_file', arguments: '{"path":"x","line":1}' } }] })
      + frame('output', { tool_calls: [{ id: 'call_1', function_call: { name: 'read_file', arguments: ' {"line":1,"path":"x"}' } }] }) + frame('done', {});
    const api = new TraeApi({ fetch: fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(raw)) });
    expect((await (await api.chat(credential, { ...body, tools: [tool] })).json()).choices[0].message.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x","line":1}' } }]);
  });
  it.each([['truncated', frame('text_delta', { text: 'partial' })], ['native error', frame('error', { message: 'SYNTHETIC_PRIVATE_UPSTREAM', code: 4023 })],
    ['malformed', 'event: output\ndata: broken\n\n'], ['empty', finished], ['unknown tool', frame('output', { tool_calls: [{ id: 'x', function_call: { name: 'unrequested', arguments: '{}' } }] }) + finished]])('rejects %s without fabricated successful termination or diagnostic leakage', async (_name, data) => {
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(data));
    const api = new TraeApi({ fetch }); const failure = await api.chat(credential, body).catch(error => error);
    expect(failure).toBeInstanceOf(TraeApiError); expect(String(failure)).not.toMatch(/SYNTHETIC_PRIVATE|SYNTHETIC_TRAE_ACCESS/); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates stream truncation after a visible chunk as a failed stream, never a terminal success', async () => {
    const api = new TraeApi({ fetch: fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : sse(frame('text_delta', { text: 'partial' }))) });
    const response = await api.chat(credential, { ...body, stream: true }); await expect(response.text()).rejects.toMatchObject({ code: 'response' });
  });
  it('cancels the actual upstream reader and injected fetch signal when the caller aborts', async () => {
    let cancelled = false, requestSignal: AbortSignal | undefined;
    const fetch = fetchMock((url, init) => {
      if (new URL(url).pathname.endsWith('get_detail_param')) return catalog(); requestSignal = init.signal as AbortSignal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const abort = new AbortController(), response = await new TraeApi({ fetch }).chat(credential, { ...body, stream: true }, abort.signal);
    const reader = response.body!.getReader(); await reader.read(); const pending = reader.read(); abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' }); expect(requestSignal?.aborted).toBe(true); expect(cancelled).toBe(true);
  });
  it('times out a stalled SSE body and rejects HTTP auth errors without retries or legacy fallback', async () => {
    const fetch = fetchMock(url => new URL(url).pathname.endsWith('get_detail_param') ? catalog() : new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }));
    const api = new TraeApi({ fetch, timeoutMs: 30 }); const response = await api.chat(credential, { ...body, stream: true });
    await expect(response.text()).rejects.toMatchObject({ code: 'cancelled' });
    const denied = fetchMock(() => new Response('SYNTHETIC_PRIVATE_ERROR', { status: 401 }));
    await expect(new TraeApi({ fetch: denied }).models(credential)).rejects.toMatchObject({ code: 'authorization', status: 401 }); expect(denied).toHaveBeenCalledTimes(1);
  });
  it('uses only fixed CN quota endpoints, native profile authentication and exact immutable account identity', async () => {
    const fetch = fetchMock(url => url.includes('GetUserInfo') ? Response.json({ Result: { UserID: credential.userId } }) : Response.json({ code: 0, user_entitlement_pack_list: [{ status: 1, entitlement_base_info: { product_type: 4, quota: { credits_limit: 100 } }, usage: { credits_amount: 12 } }] }));
    const result = await new TraeApi({ fetch }).quota(credential); expect(result.plan).toBe('Pro+'); expect(result.usage.status).toBe('ready'); expect(result.usage.windows[0]).toMatchObject({ total: 100, usedPercent: 12, remaining: 88 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.trae.cn/cloudide/api/v3/trae/GetUserInfo', 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage']);
    const profileHeaders = new Headers(fetch.mock.calls[0][1]?.headers); expect(profileHeaders.get('x-cloudide-token')).toBe(credential.token); expect(profileHeaders.has('Authorization')).toBe(false);
    const mismatch = fetchMock(() => Response.json({ Result: { UserID: 'another-user' } })); await expect(new TraeApi({ fetch: mismatch }).quota(credential)).rejects.toMatchObject({ code: 'authorization' }); expect(mismatch).toHaveBeenCalledTimes(1);
  });
  it('projects only current native entitlement packs against the same injected observation time as the plan', async () => {
    const timestamp = Date.parse('2040-01-01T00:00:00Z'), second = timestamp / 1000, clock = vi.fn(() => timestamp);
    const pack = (status: unknown, product_type: number, start_time: number, expire_time: number, usage: Record<string, unknown> = {}) => ({ status, expire_time,
      entitlement_base_info: { product_type, start_time, end_time: expire_time, quota: { credits_limit: 100 } }, usage });
    const raw = { code: 0, user_entitlement_pack_list: [
      pack(1, 6, second - 60, second), pack(1, 4, second + 1, second + 60), pack(0, 6, second - 60, second + 60),
      pack('active', 6, second - 60, second + 60), pack(1, 1, second, second + 60, { credits_amount: 100 }), pack(3, 0, second - 60, second + 60, { credits_amount: null }),
    ] };
    const fetch = fetchMock(url => url.includes('GetUserInfo') ? Response.json({ Result: { UserID: credential.userId } }) : Response.json(raw));
    const result = await new TraeApi({ fetch, now: clock }).quota(credential);
    expect(result.plan).toBe('Pro'); expect(result.usage.queriedAt).toBe('2040-01-01T00:00:00.000Z'); expect(clock).toHaveBeenCalledTimes(1);
    expect(result.usage.windows).toMatchObject([{ label: '通用积分', total: 100, remaining: 0 }, { label: '通用积分', total: 100 }]);
    expect(result.usage.windows).toHaveLength(2); expect(result.usage.windows[1].remaining).toBeUndefined();
    expect(result.usage.details).toHaveLength(2); expect(result.usage.summary!.total).toBe(200); expect(result.usage.summary!.remaining).toBeUndefined();
  });
  it('rejects unsupported media, sampling controls, malformed tool correlation and arbitrary origins before inference', async () => {
    const fetch = fetchMock(() => catalog()), api = new TraeApi({ fetch });
    for (const change of [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.example' } }] }] }, { temperature: 0.1 }, { messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'value' }] }]) await expect(api.chat(credential, { ...body, ...change })).rejects.toBeInstanceOf(TraeApiError);
    await expect(api.models({ ...credential, host: 'https://private.example' } as never)).rejects.toMatchObject({ code: 'credentials' }); expect(fetch).not.toHaveBeenCalled();
  });
});
