import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectAuthNetwork } from '../src/main/network-diagnostic';
import { version as appVersion } from '../package.json';

const url = 'https://auth.x.ai/.well-known/openid-configuration';
const document = { issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code', token_endpoint: 'https://auth.x.ai/oauth2/token' };
const json = (body: unknown = document, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
afterEach(() => { vi.useRealTimers(); });

describe('public authentication networking diagnostics', () => {
  it('inspects the running session and reads only the fixed public discovery URL without account credentials or cookies', async () => {
    const order: string[] = [];
    const resolveProxy = vi.fn(async target => { order.push('route'); expect(target).toBe(url); return 'DIRECT'; });
    const setProxy = vi.fn(), closeAllConnections = vi.fn(), writeSystemSettings = vi.fn();
    const fetcher = vi.fn(async (target, init) => {
      order.push('fetch'); expect(target).toBe(url);
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' }); expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get('Accept')).toBe('application/json'); expect(headers.get('User-Agent')).toBe(`ModelDock/${appVersion}`);
      expect(headers.get('Authorization')).toBeNull(); expect(headers.get('Cookie')).toBeNull(); expect(headers.get('ChatGPT-Account-Id')).toBeNull();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return json();
    });
    const session = { resolveProxy, setProxy, closeAllConnections, writeSystemSettings };
    const result = await inspectAuthNetwork(session, '', fetcher as typeof fetch);
    expect(result).toMatchObject({ ok: true, configuredProxyUrl: '', route: 'direct', statusCode: 200, validDiscovery: true }); expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(order).toEqual(['route', 'fetch']); expect(resolveProxy).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    expect(setProxy).not.toHaveBeenCalled(); expect(closeAllConnections).not.toHaveBeenCalled(); expect(writeSystemSettings).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('body'); expect(result).not.toHaveProperty('headers');
  });

  it.each(['PROXY 127.0.0.1:20081', 'HTTPS localhost:20081', 'SOCKS5 [::1]:20081', 'PROXY user:PRIVATE_PASSWORD@proxy.invalid:1234; DIRECT'])('reports a proxy rule without exposing its address or fallback details (%s)', async rule => {
    const result = await inspectAuthNetwork({ resolveProxy: async () => rule }, ' HTTP://LOCALHOST:20081/ ', (async () => json()) as typeof fetch);
    expect(result).toMatchObject({ ok: true, route: 'proxy', configuredProxyUrl: 'http://localhost:20081', validDiscovery: true });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PASSWORD|proxy.invalid|user:/);
  });

  it('reports the first routing choice independently of the saved address', async () => {
    const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT; PROXY synthetic.invalid:1234' }, 'http://127.0.0.1:20081', (async () => json()) as typeof fetch);
    expect(result).toMatchObject({ ok: true, route: 'direct', configuredProxyUrl: 'http://127.0.0.1:20081' }); expect(JSON.stringify(result)).not.toContain('synthetic.invalid');
  });

  it('can still verify public access when proxy introspection fails or produces unknown rules', async () => {
    for (const resolveProxy of [async () => { throw new Error('PRIVATE_ROUTING_ERROR'); }, async () => 'PRIVATE_UNRECOGNIZED_RULE']) {
      const result = await inspectAuthNetwork({ resolveProxy }, '', (async () => json()) as typeof fetch);
      expect(result).toMatchObject({ ok: true, route: 'unknown', validDiscovery: true }); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    }
  });

  it('rejects invalid saved proxy addresses before probing and never returns their text', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT'), fetcher = vi.fn(async () => json());
    const result = await inspectAuthNetwork({ resolveProxy }, 'http://user:PRIVATE_PASSWORD@remote.invalid:1234', fetcher as typeof fetch);
    expect(result).toMatchObject({ ok: false, configuredProxyUrl: '', route: 'unknown', validDiscovery: false });
    expect(resolveProxy).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|remote.invalid|user:/);
  });

  it.each([401, 403, 429, 500])('reports public HTTP %s without echoing the body or blaming account credentials', async status => {
    const fetcher = vi.fn(async () => json({ error: 'PRIVATE_ERROR_BODY PRIVATE_ACCESS_TOKEN' }, status));
    const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', fetcher as typeof fetch);
    expect(result).toMatchObject({ ok: false, route: 'direct', statusCode: status, validDiscovery: false }); expect(result.message).toContain(`HTTP ${status}`); expect(result.message).toContain('没有发送账号凭据');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_CERT_AUTHORITY_INVALID'])('extracts only safe native error code %s and excludes URLs, credentials and exception text', async code => {
    const exception = new TypeError(`PRIVATE_EXCEPTION proxy://private-user:PRIVATE_PASSWORD@synthetic.invalid net::${code}`);
    const result = await inspectAuthNetwork({ resolveProxy: async () => 'PROXY 127.0.0.1:20081' }, 'http://127.0.0.1:20081', (async () => { throw exception; }) as typeof fetch);
    expect(result).toMatchObject({ ok: false, route: 'proxy', validDiscovery: false, errorCode: code }); expect(result.statusCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|synthetic.invalid|private-user|proxy:\/\//);
  });

  it('recognizes safe codes in native causes but never forwards unrecognized codes or primitive errors', async () => {
    const caused = new Error('PRIVATE_OUTER', { cause: { code: 'ERR_CONNECTION_RESET', message: 'PRIVATE_INNER' } });
    expect(await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', (async () => { throw caused; }) as typeof fetch)).toMatchObject({ errorCode: 'ERR_CONNECTION_RESET', ok: false });
    for (const error of [new Error('PRIVATE_UNKNOWN ERR_PRIVATE_CREDENTIAL'), 'PRIVATE_PRIMITIVE']) {
      const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', (async () => { throw error; }) as typeof fetch);
      expect(result.errorCode).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    }
  });

  it('refuses redirect statuses and unexpected returned origins without making another request', async () => {
    for (const response of [new Response(null, { status: 302, headers: { Location: 'https://synthetic.invalid/PRIVATE_LOCATION' } }), json()]) {
      if (response.status === 200) Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://synthetic.invalid/PRIVATE_LOCATION' } });
      const fetcher = vi.fn(async () => response);
      const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', fetcher as typeof fetch);
      expect(result).toMatchObject({ ok: false, validDiscovery: false, errorCode: 'ERR_UNSAFE_REDIRECT' }); expect(fetcher).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toMatch(/synthetic.invalid|PRIVATE_LOCATION/);
    }
  });

  it('rejects malformed/non-JSON discoveries and wrong issuers or credential-bearing endpoints', async () => {
    const responses = [
      new Response('<html>PRIVATE_BODY</html>', { headers: { 'Content-Type': 'text/html' } }),
      new Response('{PRIVATE_JSON', { headers: { 'Content-Type': 'application/json' } }),
      json([]), json({}), json({ ...document, error: 'PRIVATE_ERROR' }),
      json({ ...document, issuer: 'https://synthetic.invalid' }),
      json({ ...document, device_authorization_endpoint: 'https://synthetic.invalid/PRIVATE_ENDPOINT' }),
      json({ ...document, token_endpoint: 'http://auth.x.ai/oauth2/token' }),
      json({ ...document, token_endpoint: 'https://auth.x.ai:8443/oauth2/token' }),
      json({ ...document, token_endpoint: 'https://PRIVATE_USER:PRIVATE_PASS@auth.x.ai/oauth2/token' }),
      json({ ...document, token_endpoint: 'https://auth.x.ai/oauth2/token#PRIVATE_FRAGMENT' }),
    ];
    for (const response of responses) {
      const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', (async () => response) as typeof fetch);
      expect(result).toMatchObject({ ok: false, statusCode: 200, validDiscovery: false, errorCode: 'ERR_INVALID_RESPONSE' }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|synthetic.invalid/);
    }
  });

  it('accepts a valid official document with trailing issuer slash and future same-origin endpoint paths', async () => {
    const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', (async () => json({ issuer: 'https://auth.x.ai/', device_authorization_endpoint: 'https://auth.x.ai/future/device/authorize', token_endpoint: 'https://auth.x.ai:443/future/token' })) as typeof fetch);
    expect(result).toMatchObject({ ok: true, validDiscovery: true });
  });

  it('bounds declared and actual streamed response bytes', async () => {
    for (const response of [json(document, 200, { 'Content-Length': '100000' }), json({ ...document, padding: 'x'.repeat(64 * 1024) })]) {
      const result = await inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', (async () => response) as typeof fetch);
      expect(result).toMatchObject({ ok: false, statusCode: 200, validDiscovery: false, errorCode: 'ERR_INVALID_RESPONSE' }); expect(result.message).toContain('64 KiB');
    }
  });

  it('bounds stalled proxy resolution and never sends a late GET after the complete deadline', async () => {
    vi.useFakeTimers(); let resolve!: (value: string) => void;
    const session = { resolveProxy: () => new Promise<string>(done => { resolve = done; }) }, fetcher = vi.fn(async () => json());
    const pending = inspectAuthNetwork(session, '', fetcher as typeof fetch);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, route: 'unknown', validDiscovery: false, errorCode: 'ERR_TIMED_OUT', durationMs: 10000 });
    resolve('DIRECT'); await Promise.resolve(); await Promise.resolve(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds non-cooperative fetches and aborts stalled response-body reads without leaking incomplete content', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const stalled = inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', ((_, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); }) as typeof fetch);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stalled).toMatchObject({ ok: false, route: 'direct', errorCode: 'ERR_TIMED_OUT', durationMs: 10000 }); expect(signal?.aborted).toBe(true);
    let cancelled = false;
    const streaming = inspectAuthNetwork({ resolveProxy: async () => 'DIRECT' }, '', (async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"PRIVATE_PARTIAL":')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await streaming;
    expect(result).toMatchObject({ ok: false, statusCode: 200, errorCode: 'ERR_TIMED_OUT', durationMs: 10000 }); expect(cancelled).toBe(true); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
});
