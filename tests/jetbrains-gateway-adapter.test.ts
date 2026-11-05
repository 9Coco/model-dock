import { describe, expect, it, vi } from 'vitest';
import { JetBrainsGatewayAdapter } from '../src/main/jetbrains-gateway-adapter';
import type { Provider } from '../src/shared/types';

const provider = { id: 'native-ide', kind: 'openai-compatible', presetId: 'jetbrains-central', nativeAdapter: 'jetbrains-ide' } as Provider;
const signal = () => new AbortController().signal;
const completion = { id: 'chat-fixture', object: 'chat.completion', model: 'native-profile', choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }] };
function fixture(response: () => Response = () => Response.json(completion)) {
  const accounts = { isNativeProvider: vi.fn(() => true), credentials: vi.fn(async () => ({ token: 'PRIVATE_DERIVED_TOKEN' })) };
  const api = { models: vi.fn(async () => ({ data: [{ id: 'native-profile', object: 'model' }] })), chat: vi.fn(async (_token: string, _body: Record<string, unknown>, _signal: AbortSignal) => response()) };
  return { accounts, api, adapter: new JetBrainsGatewayAdapter(accounts, api) };
}
describe('JetBrains IDE dispatch through the existing gateway', () => {
  it('passes native profile IDs and credentials only to the main-process API', async () => {
    const f = fixture(), abort = signal(); const directory = await (await f.adapter.models(provider, abort)).json();
    expect(directory).toEqual({ object: 'list', data: [{ id: 'native-profile', object: 'model' }] }); expect(JSON.stringify(directory)).not.toContain('PRIVATE');
    const body = { model: 'native-profile', messages: [{ role: 'user', content: 'synthetic prompt' }], stream: false };
    expect(await (await f.adapter.request(provider, '/v1/chat/completions', body, abort))!.json()).toEqual(completion); expect(f.api.chat).toHaveBeenCalledWith('PRIVATE_DERIVED_TOKEN', body, abort);
    f.accounts.isNativeProvider.mockReturnValue(false); await expect(f.adapter.models(provider, abort)).rejects.toThrow('配置已变化');
  });
  it.each(['/responses', '/messages'])('converts %s requests and results with the actual profile ID', async path => {
    const f = fixture(), body = path === '/responses' ? { model: 'native-profile', input: 'synthetic question', stream: false } : { model: 'native-profile', messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 10, stream: false };
    const result = await f.adapter.request(provider, path, body, signal()); expect(await result!.text()).toContain('synthetic answer');
    expect(f.api.chat.mock.calls[0][1]).toMatchObject({ model: 'native-profile', messages: [{ role: 'user', content: 'synthetic question' }] });
  });
  it('rejects unsupported protocol semantics before authorization and never falls back to a relay URL', async () => {
    const f = fixture(); await expect(f.adapter.request(provider, '/responses', { model: 'native-profile', input: 'q', previous_response_id: 'unsupported' }, signal())).rejects.toMatchObject({ status: 400 });
    expect(f.accounts.credentials).not.toHaveBeenCalled(); expect(f.api.chat).not.toHaveBeenCalled(); expect((await f.adapter.request(provider, '/completions', {}, signal()))?.status).toBe(400);
  });
  it.each(['/chat/completions', '/responses', '/messages'])('forwards the first %s SSE event before upstream completion and propagates cancellation', async path => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>; const canceled = vi.fn();
    const f = fixture(() => new Response(new ReadableStream({ start(controller) { upstream = controller; }, cancel: canceled }), { headers: { 'content-type': 'text/event-stream' } }));
    const controller = new AbortController();
    const body = path === '/responses' ? { model: 'native-profile', input: 'q', stream: true } : { model: 'native-profile', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, stream: true };
    const response = await f.adapter.request(provider, path, body, controller.signal), reader = response!.body!.getReader();
    const pending = reader.read(); upstream.enqueue(new TextEncoder().encode('data: {"id":"chat-fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}\n\n'));
    const first = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('First event was buffered')), 500))]);
    expect(first.done).toBe(false); expect(first.value!.length).toBeGreaterThan(0); await reader.cancel(); await vi.waitFor(() => expect(canceled).toHaveBeenCalled());
    expect(f.api.chat.mock.calls[0][2]).toBe(controller.signal);
  });
});
