import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { JetBrainsIdeRelay, type JetBrainsIdeRelayAdapter } from '../src/main/jetbrains-ide-relay';

const KEY = 'synthetic-native-jetbrains-loopback-key';
const PRIVATE = 'PRIVATE_JETBRAINS_ID_TOKEN';
const relays: JetBrainsIdeRelay[] = [];
const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
function adapter(): JetBrainsIdeRelayAdapter & { models: ReturnType<typeof vi.fn>; chat: ReturnType<typeof vi.fn> } {
  return { models: vi.fn(async () => ({ data: [{ id: 'native-model', object: 'model' as const }] })), chat: vi.fn(async () => new Response(JSON.stringify({ id: 'chat_fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_OK' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })) };
}
async function setup() {
  const relay = new JetBrainsIdeRelay(0), api = adapter(); relays.push(relay); await relay.start(KEY, 'fixture-ide-owner', api);
  return { relay, api, url: relay.baseUrl()! };
}
afterEach(async () => { for (const relay of relays.splice(0)) await relay.stop(); });

describe('owned native JetBrains loopback facade', () => {
  it('binds only loopback and requires its independent local key before any native adapter call', async () => {
    const { relay, api, url } = await setup(); expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    for (const authorization of [undefined, 'Bearer bad', `Basic ${KEY}`]) {
      const result = await fetch(url + '/models', { headers: authorization ? { authorization } : {} });
      expect(result.status).toBe(401); expect(await result.text()).not.toContain(KEY);
    }
    expect(api.models).not.toHaveBeenCalled(); expect(api.chat).not.toHaveBeenCalled();
    expect(relay.isRunning(KEY, 'fixture-ide-owner')).toBe(true); expect(relay.isRunning(KEY, 'other-owner')).toBe(false);
    const models = await fetch(url + '/models', { headers: auth }); expect(await models.json()).toEqual({ object: 'list', data: [{ id: 'native-model', object: 'model' }] });
  });
  it('keeps native credentials inside the adapter and forwards its normalized chat contract', async () => {
    const { api, url } = await setup();
    const result = await fetch(url + '/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'native-model', messages: [{ role: 'user', content: 'Hello' }], stream: false }) });
    expect(result.status).toBe(200); expect(await result.text()).toContain('MOCK_OK');
    expect(api.chat.mock.calls[0][0]).toMatchObject({ model: 'native-model', messages: [{ role: 'user', content: 'Hello' }] });
    expect(api.chat.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });
  it('contains raw native errors and rejects unsupported routes or malformed request envelopes', async () => {
    const { api, url } = await setup(); api.chat.mockRejectedValue(new Error(PRIVATE));
    const failed = await fetch(url + '/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'native-model' }) });
    expect(failed.status).toBe(502); expect(await failed.text()).not.toContain(PRIVATE);
    for (const path of ['/responses', '/completions', '/models?redirect=https://example.com']) expect((await fetch(url + path, { headers: auth })).status).toBe(404);
    expect((await fetch(url + '/chat/completions', { method: 'POST', headers: auth, body: '{invalid' })).status).toBe(400);
    expect((await fetch(url + '/chat/completions', { method: 'POST', headers: auth, body: '[]' })).status).toBe(400);
    expect((await fetch(url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: '{}' })).status).toBe(415);
  });
  it('does not forward upstream error bodies or unrelated content as successful model output', async () => {
    const { api, url } = await setup();
    for (const response of [new Response(PRIVATE, { status: 403 }), new Response(PRIVATE, { headers: { 'content-type': 'text/html' } })]) {
      api.chat.mockResolvedValueOnce(response);
      const result = await fetch(url + '/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'native-model' }) });
      expect(result.status).toBeGreaterThanOrEqual(400); expect(await result.text()).not.toContain(PRIVATE);
    }
  });
  it('aborts native streaming when the client disconnects and when this owned service stops', async () => {
    const { relay, api, url } = await setup(); let nativeSignal: AbortSignal | undefined; const cancelled = vi.fn();
    api.chat.mockImplementation(async (_body: unknown, signal: AbortSignal) => { nativeSignal = signal; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n')); }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } }); });
    const controller = new AbortController(), response = await fetch(url + '/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ model: 'native-model', stream: true }), signal: controller.signal });
    const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false); controller.abort();
    await vi.waitFor(() => { expect(nativeSignal?.aborted).toBe(true); expect(cancelled).toHaveBeenCalled(); });
    await relay.stop(); expect(relay.isRunning(KEY)).toBe(false); expect(relay.baseUrl()).toBeUndefined();
  });
  it('never adopts or terminates a foreign listener when the configured port is busy', async () => {
    const foreign = createServer((_request, response) => response.end('FOREIGN'));
    await new Promise<void>(done => foreign.listen(0, '127.0.0.1', done)); const address = foreign.address(); if (!address || typeof address === 'string') throw new Error('fixture');
    const relay = new JetBrainsIdeRelay(address.port); relays.push(relay);
    try {
      await expect(relay.start(KEY, 'fixture', adapter())).rejects.toThrow('端口'); await relay.stop();
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('FOREIGN');
    } finally { await new Promise<void>(done => foreign.close(() => done())); }
  });
});
