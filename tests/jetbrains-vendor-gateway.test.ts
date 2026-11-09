import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { JetBrainsIdeApi } from '../src/main/jetbrains-ide-api';
import { JetBrainsGatewayAdapter } from '../src/main/jetbrains-gateway-adapter';
import type { Provider } from '../src/shared/types';

// Public installed V9 DTO shapes and entirely synthetic credentials. The only
// listening socket is the test Gateway on an ephemeral loopback port. Official
// origins, account files, keychains and actual inference are never contacted.
const NOW = Date.UTC(2026, 10, 6, 12);
const vendors = ['Anthropic', 'Google', 'GoogleVertexAnthropic'] as const;
const additionalVendors = ['Bedrock', 'Xai', 'vLLM'] as const;
type PrimaryVendor = typeof vendors[number];
type Vendor = PrimaryVendor | typeof additionalVendors[number];
type Account = 'a' | 'b';
type Json = Record<string, any>;
const token = (subject: string) => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: subject, exp: (NOW + 3_600_000) / 1000 })).toString('base64url'),
  Buffer.from('SYNTHETIC_SIGNATURE_NOT_A_CREDENTIAL').toString('base64url'),
].join('.');
const tokens = { a: token('synthetic-account-a'), b: token('synthetic-account-b') };
const profile = (provider: Vendor, id = `native-profile-${provider.toLowerCase()}`) => ({
  id, provider, providerModelID: `PROVIDER_MODEL_ID_MUST_NOT_BE_SENT-${provider}`, modelName: `Synthetic ${provider}`,
  features: ['Chat'], contextLimit: 128000, maxOutputTokens: 8192,
  chatDefinition: { roles: ['system', 'user', 'assistant', 'tool'], parameters: ['toolConfig.tools', 'toolConfig.toolChoice.auto', 'length'], multimediaDataDefinition: { supportedTypes: ['image/png'], maxElements: 8 } },
  lifeCycle: { deprecated: false },
});
const otherGoogle = profile('Google', 'native-profile-google-other');
const privateB = profile('Anthropic', 'native-profile-private-to-b');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
// Grazie's actual continuous-SSE terminator is the unquoted literal `end`.
// The official HTTP client consumes it before invoking the JSON DTO decoder.
const nativeEnd = () => new TextEncoder().encode('data: end\n\n');
const content = (text: string) => ({ type: 'Content', event_type: 'data', content: text, choiceIndex: 0 });
const finish = (reason = 'stop') => ({ type: 'FinishMetadata', event_type: 'data', reason, choiceIndex: 0 });
const nativeResponse = (events: unknown[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const event of events) controller.enqueue(encode(event)); controller.enqueue(nativeEnd()); controller.close(); } }), { headers: { 'content-type': 'text/event-stream', 'x-private-upstream': 'PRIVATE_HEADER' } });
const textResponse = (text = 'SYNTHETIC_NATIVE_ANSWER🙂') => nativeResponse([content(text), finish()]);
interface Seen { url: string; token: string; body?: Json; signal: AbortSignal }

async function fixture(handler: (request: Seen) => Response | Promise<Response> = () => textResponse()) {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-jb-vendors-')), store = await Store.create(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const providers = {} as Record<Account, Provider>;
  const models = {} as Record<Account, Record<PrimaryVendor, ReturnType<Store['saveModel']>>>;
  const profiles = new Map<string, Json[]>([[tokens.a, [...vendors.map(vendor => profile(vendor)), otherGoogle]], [tokens.b, [...vendors.map(vendor => profile(vendor)), privateB]]]);
  for (const account of ['a', 'b'] as const) {
    const imported = await store.saveRelayClientImport({ kind: 'openai-compatible', presetId: 'jetbrains-central', name: `Synthetic IDE account ${account}`, baseUrl: 'http://127.0.0.1:18081/v1', apiKey: 'SYNTHETIC_HISTORICAL_PLACEHOLDER', enabled: true }, { nativeIde: { version: 1 }, clientImport: { client: 'jetbrains-ide' } });
    providers[account] = store.getProvider(imported.id)!;
    models[account] = {} as Record<PrimaryVendor, ReturnType<Store['saveModel']>>;
    for (const vendor of vendors) models[account][vendor] = store.saveModel({ providerId: imported.id, upstreamId: profile(vendor).id, alias: `local-${account}-${vendor.toLowerCase()}`, displayName: `Synthetic ${vendor}`, wireApi: 'chat-completions', contextWindow: 128000, maxOutputTokens: 8192, tools: true, vision: true, enabled: true });
  }
  const extraModel = (account: Account, id: string, alias: string) => store.saveModel({ providerId: providers[account].id, upstreamId: id, alias, displayName: alias, wireApi: 'chat-completions', contextWindow: 128000, tools: true, vision: true, enabled: true });
  const otherGoogleModel = extraModel('a', otherGoogle.id, 'local-a-google-other');
  const privateBModel = extraModel('b', privateB.id, 'local-b-private');
  const staleAModel = extraModel('a', privateB.id, 'local-a-stale-b-profile');
  for (const tool of ['rider', 'claude-code'] as const) store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'aggregate', providerIds: Object.values(providers).map(value => value.id), modelIds: store.listModels().map(value => value.id), modelSelection: 'selected', defaultModelId: models.a.Anthropic.id, note: '' });
  const seen: Seen[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const input = init ?? {}, headers = new Headers(input.headers), nativeToken = headers.get('Grazie-Authenticate-JWT')!;
    expect(String(url).startsWith('https://api.jetbrains.ai/')).toBe(true);
    expect(input.redirect).toBe('error'); expect(input.credentials).toBe('omit'); expect(input.cache).toBe('no-store');
    expect(headers.has('authorization')).toBe(false); expect([tokens.a, tokens.b]).toContain(nativeToken);
    const row = { url: String(url), token: nativeToken, body: input.body === undefined ? undefined : JSON.parse(String(input.body)), signal: input.signal as AbortSignal };
    seen.push(row);
    if (row.url.endsWith('/user/v5/llm/profiles/v9')) { expect(input.method).toBe('GET'); return Response.json({ profiles: profiles.get(nativeToken) }); }
    expect(row.url).toBe('https://api.jetbrains.ai/user/v5/llm/chat/stream/v9'); expect(input.method).toBe('POST');
    expect(headers.get('accept')).toBe('text/event-stream');
    return handler(row);
  });
  const api = new JetBrainsIdeApi({ fetch: fetcher, now: () => NOW });
  const accounts = {
    isNativeProvider: vi.fn((id: string) => Object.values(providers).some(value => value.id === id)),
    credentials: vi.fn(async (id: string, signal?: AbortSignal) => { expect(signal?.aborted).not.toBe(true); const account = (Object.keys(providers) as Account[]).find(key => providers[key].id === id); if (!account) throw new Error('Synthetic account missing'); return { token: tokens[account] }; }),
  };
  const adapter = new JetBrainsGatewayAdapter(accounts, api);
  const forbiddenFetch = vi.fn(async () => { throw new Error('Must not contact a historical relay or external provider'); });
  const forbiddenPrepare = vi.fn(async () => { throw new Error('Managed native credentials must remain main-only'); });
  const nativeRequest = vi.fn((provider: Provider, path: string, body: Record<string, unknown>, signal: AbortSignal) => adapter.request(provider, path, body, signal));
  const gateway = new Gateway(store, { nativeRequest, fetch: forbiddenFetch, prepareRequest: forbiddenPrepare, timeoutMs: 10_000 });
  await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
  const headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const url = `${gateway.status().baseUrl.replace(/\/v1$/, '')}/tool/rider/v1/chat/completions`;
  const messagesUrl = `${gateway.status().baseUrl.replace(/\/v1$/, '')}/tool/claude-code/v1/messages`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const postMessages = (body: unknown) => fetch(messagesUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  const inferences = () => seen.filter(row => row.url.endsWith('/chat/stream/v9'));
  return { store, providers, models, profiles, otherGoogleModel, privateBModel, staleAModel, api, accounts, adapter, gateway, seen, inferences, fetcher, nativeRequest, forbiddenFetch, forbiddenPrepare, headers, url, messagesUrl, post, postMessages };
}
const requestBody = (model: string, stream: boolean, messages: Json[] = [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }]) => ({ model, stream, messages,
  tools: [{ type: 'function', function: { name: 'lookup', description: 'Synthetic local tool', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }], tool_choice: 'auto', max_tokens: 64 });
function chunksOf(text: string): Json[] {
  return text.split(/\r\n\r\n|\n\n/).filter(Boolean).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(value => value && value !== '[DONE]').map(value => JSON.parse(value));
}
function reconstruct(chunks: Json[]): Json {
  const message: Json = { role: 'assistant', content: '' }, calls = new Map<number, Json>();
  for (const chunk of chunks) for (const choice of chunk.choices ?? []) {
    message.content += choice.delta?.content ?? '';
    for (const delta of choice.delta?.tool_calls ?? []) {
      const call = calls.get(delta.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      call.id += delta.id ?? ''; call.function.name += delta.function?.name ?? ''; call.function.arguments += delta.function?.arguments ?? ''; calls.set(delta.index, call);
    }
  }
  if (calls.size) message.tool_calls = [...calls.values()]; return message;
}
function reconstructMessages(chunks: Json[]): Json {
  const message: Json = { role: 'assistant', content: [] }, blocks = new Map<number, Json>(), argumentsByIndex = new Map<number, string>();
  for (const chunk of chunks) {
    if (chunk.type === 'message_start') { message.model = chunk.message.model; message.id = chunk.message.id; }
    if (chunk.type === 'content_block_start') blocks.set(chunk.index, { ...chunk.content_block });
    if (chunk.type === 'content_block_delta') {
      const block = blocks.get(chunk.index)!;
      if (chunk.delta.type === 'text_delta') block.text = (block.text ?? '') + chunk.delta.text;
      if (chunk.delta.type === 'input_json_delta') argumentsByIndex.set(chunk.index, (argumentsByIndex.get(chunk.index) ?? '') + chunk.delta.partial_json);
    }
    if (chunk.type === 'message_delta') message.stop_reason = chunk.delta.stop_reason;
  }
  for (const [index, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    if (argumentsByIndex.has(index)) block.input = JSON.parse(argumentsByIndex.get(index)!); message.content.push(block);
  }
  return message;
}
const messagesBody = (model: string, stream: boolean, messages: Json[] = [{ role: 'user', content: 'SYNTHETIC_PRIVATE_PROMPT' }]) => ({ model, stream, messages, max_tokens: 64,
  tools: [{ name: 'lookup', description: 'Synthetic local tool', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }], tool_choice: { type: 'auto' } });
interface HttpResult { status: number; text: string; complete: boolean; aborted: boolean; errors: string[]; contentType: string }
async function readHttp(url: string, headers: Record<string, string>, body: unknown, onData?: (text: string) => void): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, response => {
      const chunks: Buffer[] = [], errors: string[] = [];
      response.on('error', error => errors.push((error as NodeJS.ErrnoException).code ?? error.name));
      void (async () => {
        try { for await (const part of response) { chunks.push(Buffer.from(part)); onData?.(Buffer.concat(chunks).toString('utf8')); } }
        catch (error) { errors.push((error as NodeJS.ErrnoException).code ?? (error as Error).name); }
        resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8'), complete: response.complete, aborted: response.aborted, errors, contentType: String(response.headers['content-type'] ?? '') });
      })();
    });
    request.once('error', reject); request.end(JSON.stringify(body));
  });
}
function assertPrivate(f: Awaited<ReturnType<typeof fixture>>, text = '') {
  expect(text).not.toMatch(/PRIVATE_UPSTREAM_ERROR|PRIVATE_HEADER|SYNTHETIC_HISTORICAL_PLACEHOLDER|OPAQUE_TOOL_SIGNATURE|SYNTHETIC_PRIVATE_PROMPT|eyJ/);
  expect(JSON.stringify(f.store.logs())).not.toMatch(/SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_NATIVE_ANSWER|SYNTHETIC_HISTORICAL_PLACEHOLDER|OPAQUE_TOOL_SIGNATURE|eyJ/);
  expect(f.forbiddenFetch).not.toHaveBeenCalled(); expect(f.forbiddenPrepare).not.toHaveBeenCalled();
}

describe('JetBrains native vendors through the real local Gateway', () => {
  it('returns an upstream regional HTTP 451 without changing it into an authentication failure', async () => {
    const f = await fixture(() => new Response('PRIVATE_UPSTREAM_ERROR', { status: 451 }));
    const response = await f.post(requestBody(f.models.a.Anthropic.alias, false));
    expect(response.status).toBe(451);
    const text = await response.text(); expect(text).toContain('HTTP 451'); expect(text).not.toContain('重新登录');
    expect(f.inferences()).toHaveLength(1); assertPrivate(f, text);
  });

  it.each(vendors.flatMap(vendor => [false, true].map(stream => ({ vendor, stream }))))('$vendor converts native V9 text and tools with stream=$stream exactly once', async ({ vendor, stream }) => {
    const f = await fixture(() => nativeResponse([
      content('SYNTHETIC_NATIVE_ANSWER🙂'),
      { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'call-synthetic', name: 'lookup', content: '{"q":', thoughtSignature: 'OPAQUE_TOOL_SIGNATURE' },
      { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: null, name: null, content: '"fixture"}' },
      finish('tool_call'),
    ]));
    const directory = await (await f.adapter.models(f.providers.a, new AbortController().signal)).json();
    expect(directory.data.map((value: Json) => value.id)).toEqual([...vendors.map(value => profile(value).id), otherGoogle.id]);
    expect(directory.data.find((value: Json) => value.id === profile(vendor).id)).toMatchObject({ tools: true, vision: true, context_length: 128000, max_output_tokens: 8192 });
    expect(JSON.stringify(directory)).not.toContain('PROVIDER_MODEL_ID_MUST_NOT_BE_SENT');
    const response = await f.post(requestBody(f.models.a[vendor].alias, stream)); expect(response.status).toBe(200); expect(response.headers.has('x-private-upstream')).toBe(false);
    const text = await response.text(), data = stream ? chunksOf(text) : undefined;
    const message = stream ? reconstruct(data!) : JSON.parse(text).choices[0].message;
    expect(message).toMatchObject({ content: 'SYNTHETIC_NATIVE_ANSWER🙂', tool_calls: [{ id: 'call-synthetic', type: 'function', function: { name: 'lookup', arguments: '{"q":"fixture"}' } }] });
    if (stream) {
      expect(text.match(/data: \[DONE\]/g)).toHaveLength(1); expect(data!.every(value => value.model === f.models.a[vendor].alias)).toBe(true);
      expect(data!.flatMap(value => value.choices ?? []).filter(value => value.finish_reason != null)).toMatchObject([{ finish_reason: 'tool_calls' }]);
    } else expect(JSON.parse(text)).toMatchObject({ model: f.models.a[vendor].alias, choices: [{ finish_reason: 'tool_calls' }] });
    expect(f.inferences()).toHaveLength(1);
    const inference = f.inferences()[0]; expect(inference.token).toBe(tokens.a);
    expect(inference.body).toMatchObject({ profile: profile(vendor).id, chat: { messages: [{ type: 'user_message', content: 'SYNTHETIC_PRIVATE_PROMPT' }] } });
    expect(JSON.stringify(inference.body)).not.toMatch(/PROVIDER_MODEL_ID_MUST_NOT_BE_SENT|local-a-|local-b-/);
    assertPrivate(f, text);
  });

  it.each(additionalVendors)('uses the same official profile-based V9 protocol for valid %s Chat profiles', async vendor => {
    const f = await fixture(); f.profiles.set(tokens.a, [profile(vendor)]);
    const directory = await (await f.adapter.models(f.providers.a, new AbortController().signal)).json();
    expect(directory.data).toMatchObject([{ id: profile(vendor).id, tools: true, vision: true }]);
    const response = await f.adapter.request(f.providers.a, '/chat/completions', requestBody(profile(vendor).id, true), new AbortController().signal);
    expect(response?.status).toBe(200); const text = await response!.text();
    expect(reconstruct(chunksOf(text)).content).toBe('SYNTHETIC_NATIVE_ANSWER🙂'); expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(f.inferences()).toHaveLength(1); expect(f.inferences()[0].body?.profile).toBe(profile(vendor).id);
    expect(JSON.stringify(f.inferences()[0].body)).not.toMatch(/PROVIDER_MODEL_ID_MUST_NOT_BE_SENT|local-a-|local-b-/); assertPrivate(f, text);
  });

  it.each(vendors.flatMap(vendor => [false, true].map(stream => ({ vendor, stream }))))('Claude Code Messages uses $vendor with stream=$stream and preserves Google tool history', async ({ vendor, stream }) => {
    const f = await fixture(row => row.body?.chat.messages.some((value: Json) => value.type === 'tool_message') ? textResponse('SYNTHETIC_TOOL_RESULT_ACCEPTED') : nativeResponse([
      content('SYNTHETIC_NATIVE_ANSWER🙂'),
      { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'call-synthetic', name: 'lookup', content: '{"q":"fixture"}', thoughtSignature: 'OPAQUE_TOOL_SIGNATURE' }, finish('tool_call'),
    ]));
    const first = await f.postMessages(messagesBody(f.models.a[vendor].alias, stream)); expect(first.status).toBe(200);
    const firstText = await first.text(), message = stream ? reconstructMessages(chunksOf(firstText)) : JSON.parse(firstText);
    expect(message).toMatchObject({ model: f.models.a[vendor].alias, role: 'assistant', stop_reason: 'tool_use' });
    expect(message.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'SYNTHETIC_NATIVE_ANSWER🙂' }, { type: 'tool_use', id: 'call-synthetic', name: 'lookup', input: { q: 'fixture' } }]));
    if (stream) expect(chunksOf(firstText).filter(value => value.type === 'message_stop')).toHaveLength(1);
    expect(f.inferences()).toHaveLength(1); expect(f.inferences()[0].body).toMatchObject({ profile: profile(vendor).id, chat: { messages: [{ type: 'user_message', content: 'SYNTHETIC_PRIVATE_PROMPT' }] } });
    expect(JSON.stringify(f.inferences()[0].body)).not.toMatch(/local-a-|PROVIDER_MODEL_ID_MUST_NOT_BE_SENT/);
    assertPrivate(f, firstText);
    if (vendor === 'Google') {
      const history = [...messagesBody('', stream).messages, { role: 'assistant', content: message.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-synthetic', content: 'SYNTHETIC_TOOL_RESULT' }] }];
      const second = await f.postMessages(messagesBody(f.models.a[vendor].alias, stream, history)); expect(second.status).toBe(200);
      const secondText = await second.text(), result = stream ? reconstructMessages(chunksOf(secondText)) : JSON.parse(secondText);
      expect(result).toMatchObject({ model: f.models.a[vendor].alias, stop_reason: 'end_turn', content: [{ type: 'text', text: 'SYNTHETIC_TOOL_RESULT_ACCEPTED' }] });
      expect(f.inferences()).toHaveLength(2);
      expect(f.inferences()[1].body?.chat.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'assistant_message_tool', id: 'call-synthetic', toolName: 'lookup', content: '{"q":"fixture"}', thoughtSignature: 'OPAQUE_TOOL_SIGNATURE' }),
        { type: 'tool_message', id: 'call-synthetic', toolName: 'lookup', result: 'SYNTHETIC_TOOL_RESULT' },
      ]));
      expect(JSON.stringify(f.inferences()[1].body)).not.toMatch(/local-a-|PROVIDER_MODEL_ID_MUST_NOT_BE_SENT/); assertPrivate(f, secondText);
    }
  });

  it.each(vendors.flatMap(vendor => [false, true].map(stream => ({ vendor, stream }))))('actual adapter converts /responses for $vendor with stream=$stream using native V9', async ({ vendor, stream }) => {
    const f = await fixture(() => nativeResponse([
      content('SYNTHETIC_NATIVE_ANSWER🙂'),
      { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'call-synthetic', name: 'lookup', content: '{"q":"fixture"}', thoughtSignature: 'OPAQUE_TOOL_SIGNATURE' }, finish('tool_call'),
    ]));
    const response = await f.adapter.request(f.providers.a, '/responses', {
      model: profile(vendor).id, input: 'SYNTHETIC_PRIVATE_PROMPT', stream, max_output_tokens: 64,
      tools: [{ type: 'function', name: 'lookup', description: 'Synthetic local tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } }], tool_choice: 'auto',
    }, new AbortController().signal);
    expect(response?.status).toBe(200); const text = await response!.text();
    const completed = stream ? chunksOf(text).find(value => value.type === 'response.completed')?.response : JSON.parse(text);
    expect(completed).toMatchObject({ model: profile(vendor).id, status: 'completed' });
    expect(completed.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_NATIVE_ANSWER🙂', annotations: [] }] }),
      expect.objectContaining({ type: 'function_call', call_id: 'call-synthetic', name: 'lookup', arguments: '{"q":"fixture"}' }),
    ]));
    if (stream) expect(chunksOf(text).filter(value => value.type === 'response.completed')).toHaveLength(1);
    expect(f.inferences()).toHaveLength(1); expect(f.inferences()[0].body?.profile).toBe(profile(vendor).id);
    expect(JSON.stringify(f.inferences()[0].body)).not.toMatch(/local-a-|PROVIDER_MODEL_ID_MUST_NOT_BE_SENT/); assertPrivate(f, text);
  });

  it('keeps token-specific model directories and rejects stale cross-account selections before inference', async () => {
    const f = await fixture(); f.profiles.set(tokens.b, [privateB]);
    expect((await f.post(requestBody(f.models.a.Anthropic.alias, false))).status).toBe(200);
    expect((await f.post(requestBody(f.models.b.Anthropic.alias, false))).status).toBe(400);
    expect((await f.post(requestBody(f.staleAModel.alias, false))).status).toBe(400);
    const validB = await f.post(requestBody(f.privateBModel.alias, false)); expect(validB.status).toBe(200);
    expect(f.inferences().map(value => [value.token, value.body?.profile])).toEqual([[tokens.a, profile('Anthropic').id], [tokens.b, privateB.id]]);
    expect(f.seen.filter(value => value.url.endsWith('/profiles/v9')).map(value => value.token)).toEqual([tokens.a, tokens.b]);
    assertPrivate(f, await validB.text());
  });

  it('restores Google tool signatures only to the same account and exact native profile', async () => {
    const f = await fixture(row => row.body?.chat.messages.some((value: Json) => value.type === 'tool_message') ? textResponse('tool result accepted') : nativeResponse([
      { type: 'ToolCall', event_type: 'data', choiceIndex: 0, parallelToolIndex: 0, id: 'call-synthetic', name: 'lookup', content: '{"q":"fixture"}', thoughtSignature: 'OPAQUE_TOOL_SIGNATURE' }, finish('tool_call'),
    ]));
    const first = await f.post(requestBody(f.models.a.Google.alias, false)), completion = await first.json(); expect(first.status).toBe(200);
    const history = [...requestBody('', false).messages, completion.choices[0].message, { role: 'tool', tool_call_id: 'call-synthetic', content: 'SYNTHETIC_TOOL_RESULT' }];
    const same = await f.post(requestBody(f.models.a.Google.alias, false, history)); expect(same.status).toBe(200);
    expect(f.inferences()[1].body?.chat.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'assistant_message_tool', id: 'call-synthetic', toolName: 'lookup', content: '{"q":"fixture"}', thoughtSignature: 'OPAQUE_TOOL_SIGNATURE' })]));
    expect((await f.post(requestBody(f.models.b.Google.alias, false, history))).status).toBe(400);
    expect((await f.post(requestBody(f.otherGoogleModel.alias, false, history))).status).toBe(400);
    expect(f.inferences()).toHaveLength(2); assertPrivate(f, JSON.stringify(completion) + await same.text());
  });

  it.each(['empty', 'malformed', 'event-error', 'http-error'] as const)('returns a sanitized native %s failure before any output without retry', async mode => {
    const f = await fixture(() => mode === 'http-error' ? Response.json({ error: `PRIVATE_UPSTREAM_ERROR ${tokens.a}` }, { status: 429 })
      : mode === 'empty' ? nativeResponse([]) : mode === 'malformed' ? nativeResponse([{ type: 'Content', event_type: 'data', content: 42 }])
        : nativeResponse([{ type: 'Content', event_type: 'error', message: `PRIVATE_UPSTREAM_ERROR ${tokens.a}` }]));
    const result = await readHttp(f.url, f.headers, requestBody(f.models.a.Anthropic.alias, true));
    expect(result).toMatchObject({ status: mode === 'http-error' ? 429 : 502, complete: true, aborted: false, errors: [] }); expect(result.contentType).toContain('application/json');
    expect(JSON.parse(result.text)).toMatchObject({ error: { message: expect.any(String) } }); expect(result.text).not.toMatch(/data:|\[DONE\]|"choices"/);
    expect(f.inferences()).toHaveLength(1); assertPrivate(f, result.text);
  });

  it('forwards the first delta immediately then interrupts a late failure without success or DONE', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>, released = false;
    const f = await fixture(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(encode(content('VISIBLE_BEFORE_NATIVE_FINISH'))); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const result = await readHttp(f.url, f.headers, requestBody(f.models.a.GoogleVertexAnthropic.alias, true), text => {
      if (!released && text.includes('VISIBLE_BEFORE_NATIVE_FINISH')) { released = true; upstream.enqueue(encode({ type: 'Content', event_type: 'error', message: `PRIVATE_UPSTREAM_ERROR ${tokens.a}` })); upstream.close(); }
    });
    expect(released).toBe(true); expect(result).toMatchObject({ status: 200, complete: false, aborted: true }); expect(result.errors.length).toBeGreaterThan(0);
    expect(result.text).toContain('VISIBLE_BEFORE_NATIVE_FINISH'); expect(result.text).not.toMatch(/\[DONE\]|"finish_reason":"(?:stop|length|tool_calls)"/);
    expect(f.inferences()).toHaveLength(1); assertPrivate(f, result.text);
  });

  it.each(['duplicate-end', 'data-after-end'] as const)('does not let native %s turn a partial reply into terminal success', async mode => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>, released = false;
    const f = await fixture(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; controller.enqueue(encode(content('VISIBLE_BEFORE_NATIVE_END'))); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const result = await readHttp(f.url, f.headers, requestBody(f.models.a.Anthropic.alias, true), text => {
      if (!released && text.includes('VISIBLE_BEFORE_NATIVE_END')) {
        released = true; upstream.enqueue(encode(finish())); upstream.enqueue(nativeEnd());
        upstream.enqueue(mode === 'duplicate-end' ? nativeEnd() : encode(content('AFTER_NATIVE_END'))); upstream.close();
      }
    });
    expect(released).toBe(true); expect(result).toMatchObject({ status: 200, complete: false, aborted: true });
    expect(result.text).toContain('VISIBLE_BEFORE_NATIVE_END'); expect(result.text).not.toMatch(/AFTER_NATIVE_END|\[DONE\]|"finish_reason":"(?:stop|length|tool_calls)"/);
    expect(f.inferences()).toHaveLength(1); assertPrivate(f, result.text);
  });

  it('cancels one actual client stream upstream without aborting a different native account or retrying', async () => {
    const active: { row: Seen; controller: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean }[] = [];
    const f = await fixture(row => new Response(new ReadableStream<Uint8Array>({ start(controller) { active.push({ row, controller, cancelled: false }); controller.enqueue(encode(content(row.token === tokens.a ? 'FIRST_ACCOUNT_A' : 'FIRST_ACCOUNT_B'))); }, cancel() { active.find(value => value.row === row)!.cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
    const responses = await Promise.all([f.post(requestBody(f.models.a.Anthropic.alias, true)), f.post(requestBody(f.models.b.GoogleVertexAnthropic.alias, true))]);
    const readers = responses.map(value => value.body!.getReader());
    try {
      expect(new TextDecoder().decode((await readers[0].read()).value)).toContain('FIRST_ACCOUNT_A');
      expect(new TextDecoder().decode((await readers[1].read()).value)).toContain('FIRST_ACCOUNT_B');
      await readers[0].cancel(); await vi.waitFor(() => expect(active.find(value => value.row.token === tokens.a)?.cancelled).toBe(true));
      const b = active.find(value => value.row.token === tokens.b)!; expect(b.cancelled).toBe(false); expect(b.row.signal.aborted).toBe(false);
      b.controller.enqueue(encode(content('SECOND_ACCOUNT_B'))); b.controller.enqueue(encode(finish())); b.controller.enqueue(nativeEnd()); b.controller.close();
      let text = ''; for (;;) { const next = await readers[1].read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
      expect(text).toContain('SECOND_ACCOUNT_B'); expect(text.match(/data: \[DONE\]/g)).toHaveLength(1); expect(f.inferences()).toHaveLength(2); assertPrivate(f, text);
    } finally { for (const reader of readers) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
  });

  it('rejects invalid local authorization and models outside the saved binding before account access', async () => {
    const f = await fixture();
    const unauthorized = await fetch(f.url, { method: 'POST', headers: { ...f.headers, authorization: 'Bearer SYNTHETIC_WRONG_LOCAL_KEY' }, body: JSON.stringify(requestBody(f.models.a.Anthropic.alias, false)) });
    expect(unauthorized.status).toBe(401);
    expect((await f.post(requestBody('unselected-private-alias', false))).status).toBe(404);
    expect(f.accounts.credentials).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.nativeRequest).not.toHaveBeenCalled(); assertPrivate(f);
  });
});
