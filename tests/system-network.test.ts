import { describe, expect, it, vi } from 'vitest';
import { createSystemNetworkFetch } from '../src/main/system-network';

describe('desktop system-network transport (injected native fetch only)', () => {
  it('preserves an OAuth POST and caller headers while disabling ambient cookies and automatic redirects', async () => {
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    const transport = createSystemNetworkFetch(nativeFetch);
    const headers = { Authorization: 'Bearer SYNTHETIC_ONLY', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const body = 'grant_type=refresh_token&refresh_token=SYNTHETIC_REFRESH';
    const result = await transport('https://auth.example.test/oauth/token', { method: 'POST', headers, body, credentials: 'include', redirect: 'error' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const [input, init] = nativeFetch.mock.calls[0];
    expect(input).toBe('https://auth.example.test/oauth/token');
    expect(init).toMatchObject({ method: 'POST', body, credentials: 'omit', redirect: 'manual' });
    expect(init?.headers).toBe(headers);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer SYNTHETIC_ONLY');
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(await result.json()).toEqual({ ok: true });
  });

  it('rejects a redirect once, cancels its unread body, and exposes only a safe error', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response(body, { status: 307, headers: { Location: 'https://redirect.example.test/?token=SYNTHETIC_ONLY' } }));
    const transport = createSystemNetworkFetch(nativeFetch);
    const failure = await transport('https://upstream.example.test/responses', { method: 'POST', headers: { Authorization: 'Bearer SYNTHETIC_ONLY' }, body: '{}' }).catch(error => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain('重定向');
    expect(String(failure)).not.toMatch(/SYNTHETIC|redirect\.example/);
    expect(nativeFetch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('returns an explicitly manual redirect for the caller to classify without following or discarding it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('moved')); controller.close(); }, cancel });
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response(body, { status: 302, statusText: 'Found', headers: { Location: 'https://other.example.test/models', 'X-Fixture': 'manual' } }));
    const result = await createSystemNetworkFetch(nativeFetch)('https://upstream.example.test/models', { redirect: 'manual' });
    expect(result.status).toBe(302); expect(result.statusText).toBe('Found');
    expect(result.headers.get('Location')).toBe('https://other.example.test/models');
    expect(result.headers.get('X-Fixture')).toBe('manual');
    expect(await result.text()).toBe('moved');
    expect(nativeFetch).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled();
  });

  it('supports Request inputs and honors an explicit init redirect policy over the Request default', async () => {
    const request = new Request('https://upstream.example.test/responses', { method: 'POST', headers: { Authorization: 'Bearer SYNTHETIC_REQUEST' }, body: 'synthetic input', credentials: 'include', redirect: 'manual' });
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response('redirect', { status: 302, headers: { Location: 'https://other.example.test/' } }));
    const transport = createSystemNetworkFetch(nativeFetch);
    const manual = await transport(request);
    expect(manual.status).toBe(302); expect(nativeFetch.mock.calls[0][0]).toBe(request);
    expect(nativeFetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' });
    expect(request.headers.get('Authorization')).toBe('Bearer SYNTHETIC_REQUEST');
    expect(await request.clone().text()).toBe('synthetic input');
    await expect(transport(request, { redirect: 'error' })).rejects.toThrow('重定向');
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('passes URL inputs and the exact abort signal through the injected system transport', async () => {
    const controller = new AbortController();
    const url = new URL('https://upstream.example.test/responses');
    const nativeFetch = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = createSystemNetworkFetch(nativeFetch)(url, { signal: controller.signal });
    expect(nativeFetch.mock.calls[0][0]).toBe(url);
    expect(nativeFetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes unreliable native URL metadata without losing HTTP 403 or the JSON error payload', async () => {
    const payload = { error: { code: 'unsupported_country_region_territory', message: 'fixture diagnostic' } };
    const native = new Response(JSON.stringify(payload), { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json', 'X-Fixture': 'region' } });
    Object.defineProperty(native, 'url', { value: 'https://unrelated-native-metadata.invalid/', configurable: true });
    const nativeFetch = vi.fn<typeof fetch>(async () => native);
    const result = await createSystemNetworkFetch(nativeFetch)('https://auth.example.test/device');
    expect(result).not.toBe(native); expect(result.url).toBe('');
    expect(result.status).toBe(403); expect(result.statusText).toBe('Forbidden');
    expect(result.headers.get('Content-Type')).toBe('application/json'); expect(result.headers.get('X-Fixture')).toBe('region');
    expect(await result.json()).toEqual(payload);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves an SSE body as independently readable chunks before EOF instead of buffering it', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    const native = new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    Object.defineProperty(native, 'url', { value: 'electron-native-fixture-metadata', configurable: true });
    const nativeFetch = vi.fn<typeof fetch>(async () => native);
    const result = await createSystemNetworkFetch(nativeFetch)('https://upstream.example.test/responses');
    expect(result.body).toBe(stream); expect(result.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = result.body!.getReader(), decoder = new TextDecoder();
    upstream.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"OK"}\n\n'));
    const first = await reader.read(); expect(first.done).toBe(false); expect(decoder.decode(first.value)).toContain('"delta":"OK"');
    upstream.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"status":"completed"}\n\n'));
    const second = await reader.read(); expect(second.done).toBe(false); expect(decoder.decode(second.value)).toContain('response.completed');
    upstream.close(); expect((await reader.read()).done).toBe(true); reader.releaseLock();
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});
