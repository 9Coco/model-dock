import { describe, expect, it } from 'vitest';
import { CentralApi, type CentralCredentials } from '../src/main/central-api';
import { CentralGatewayAdapter } from '../src/main/central-gateway-adapter';
import { createCentralResponsesStream } from '../src/main/central-stream';
import type { Provider } from '../src/shared/types';

const now = 1900000000000, encoder = new TextEncoder();
const token = [Buffer.from('{"alg":"RS256"}').toString('base64url'), Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString('base64url'), 'SYNTHETIC'].join('.');
const credentials: CentralCredentials = { token, accountId: 'account', accountLabel: 'Synthetic', licenseId: 'license', expiresAt: now + 3600000 };
const event = (value: Record<string, unknown>) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const responseCreated = event({ type: 'response.created', response: { id: 'resp_native', object: 'response', status: 'in_progress', output: [] } });
const responseDelta = event({ type: 'response.output_text.delta', response_id: 'resp_native', item_id: 'msg_native', output_index: 0, content_index: 0, delta: 'FIRST🙂' });
const responseDone = (status = 'completed') => event({ type: `response.${status}`, response: { id: 'resp_native', object: 'response', status, output: [{ id: 'msg_native', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIRST🙂', annotations: [] }] }], ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), ...(status === 'failed' ? { error: { code: 'server_error', message: 'Synthetic failure' } } : {}) } });
const chat = (delta: object, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ id: 'chat_native', object: 'chat.completion.chunk', created: 1, model: 'gpt-native', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
async function bounded<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No incremental response')), 1000); })]); } finally { clearTimeout(timer); } }
async function fixture(path: string) {
  let source!: ReadableStreamDefaultController<Uint8Array>, cancelled = false, signal: AbortSignal | undefined;
  const api = new CentralApi({ now: () => now, fetch: (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: url.pathname.includes('/anthropic/') ? 'claude-native' : 'gpt-native' }] });
    signal = init?.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch });
  const adapter = new CentralGatewayAdapter({ isNativeProvider: () => true, credentials: () => credentials }, api);
  const response = await adapter.request({ id: 'native', nativeAdapter: 'jetbrains-central' } as Provider, path, { model: 'openai/gpt-native', stream: true }, new AbortController().signal);
  return { response: response!, source, get cancelled() { return cancelled; }, get signal() { return signal; } };
}

describe('Central native incremental stream integrity', () => {
  it.each(['/v1/chat/completions', '/v1/responses'])('forwards %s first delta before close and defers its terminal tail', async path => {
    const context = await fixture(path), reader = context.response.body!.getReader(), responses = path.endsWith('/responses');
    const prefix = responses ? responseCreated + responseDelta : chat({ role: 'assistant', content: 'FIRST🙂' });
    context.source.enqueue(encoder.encode(prefix)); let visible = '';
    while (!visible.includes('FIRST🙂')) visible += new TextDecoder().decode((await bounded(reader.read())).value);
    expect(visible).not.toContain(responses ? 'response.completed' : '[DONE]'); expect(context.cancelled).toBe(false);
    context.source.enqueue(encoder.encode(responses ? responseDone() : chat({}, 'stop') + 'data: [DONE]\n\n'));
    let settled = false; const terminal = reader.read().then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
    context.source.close(); let rest = new TextDecoder().decode((await terminal).value);
    for (;;) { const next = await bounded(reader.read()); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    expect(rest).toContain(responses ? 'response.completed' : '[DONE]');
    if (responses) expect(rest).toContain('"id":"msg_native"');
  });
  it.each(['/v1/chat/completions', '/v1/responses'])('rejects truncated %s after exposing a real early delta', async path => {
    const context = await fixture(path), reader = context.response.body!.getReader();
    context.source.enqueue(encoder.encode(path.endsWith('/responses') ? responseCreated + responseDelta : chat({ content: 'FIRST🙂' })));
    let visible = ''; while (!visible.includes('FIRST🙂')) visible += new TextDecoder().decode((await bounded(reader.read())).value);
    context.source.close(); await expect(reader.read()).rejects.toThrow();
  });
  it.each(['/v1/chat/completions', '/v1/responses'])('rejects a late error after %s native terminal without publishing success', async path => {
    const context = await fixture(path), isResponses = path.endsWith('/responses');
    const content = isResponses ? responseCreated + responseDelta + responseDone() : chat({ content: 'FIRST🙂' }) + chat({}, 'stop') + 'data: [DONE]\n\n';
    context.source.enqueue(encoder.encode(content + 'event: error\ndata: {"type":"error","error":{"message":"SYNTHETIC_PRIVATE_ERROR"}}\n\n'));
    context.source.close(); await expect(context.response.text()).rejects.toThrow();
  });
  it('propagates consumer cancellation through the integrity transform into the actual transport', async () => {
    const context = await fixture('/v1/responses'), reader = context.response.body!.getReader();
    context.source.enqueue(encoder.encode(responseCreated)); await reader.read(); await reader.cancel();
    // pipeThrough cancellation reaches its source asynchronously.
    for (let index = 0; index < 10 && !context.cancelled; index++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(context.cancelled).toBe(true); expect(context.signal?.aborted).toBe(true);
  });
  it.each(['completed', 'incomplete', 'failed'])('preserves the authentic %s terminal status and native item IDs', async status => {
    const result = await new Response(new Response(responseCreated + responseDelta + responseDone(status)).body!.pipeThrough(createCentralResponsesStream())).text();
    expect(result).toContain(`"type":"response.${status}"`); expect(result).toContain('"item_id":"msg_native"'); expect(result).not.toContain('[DONE]');
  });
  it.each([
    responseCreated + responseDelta + event({ type: 'response.completed', response: { id: 'resp_native', status: 'in_progress', output: [] } }),
    responseCreated + responseDelta + event({ type: 'response.completed', response: { id: 'another_response', status: 'completed', output: [] } }),
    responseCreated + responseDelta + responseDone() + responseDelta,
    responseCreated + responseDelta + responseDone() + 'data: [DONE]\n\ndata: [DONE]\n\n',
  ])('refuses inconsistent terminal identity, status, event order or duplicate sentinels', async source => {
    await expect(new Response(new Response(source).body!.pipeThrough(createCentralResponsesStream())).text()).rejects.toThrow();
  });
});
