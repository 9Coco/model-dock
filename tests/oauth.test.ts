import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthManager, prepareUpstream, upstreamEndpoint, type OAuthStore } from '../src/main/oauth';
import type { Provider, ProviderSecret } from '../src/shared/types';
import { version as appVersion } from '../package.json';

const codex: Provider = { id: 'gpt', name: 'GPT', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true, hasSecret: false, authStatus: 'missing', note: '' };
const grok: Provider = { ...codex, id: 'grok', name: 'Grok', kind: 'grok', baseUrl: 'https://cli-chat-proxy.grok.com/v1' };
const api: Provider = { ...codex, id: 'api', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };
const jwt = (payload: object) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

class MemoryStore implements OAuthStore {
  providers = new Map<string, Provider>([codex, grok, api].map((p) => [p.id, { ...p }]));
  secrets = new Map<string, ProviderSecret>();
  writes = 0;
  getProvider(id: string) { return this.providers.get(id); }
  getSecret(id: string) { const value = this.secrets.get(id); return value ? { ...value } : undefined; }
  setSecret(id: string, secret: ProviderSecret) { this.writes++; this.secrets.set(id, { ...secret }); }
  setAuthStatus(id: string, status: Provider['authStatus']) { const p = this.providers.get(id); if (p) p.authStatus = status; }
}

describe('subscription OAuth lifecycle (mock HTTP only)', () => {
  let store: MemoryStore;
  let manager: OAuthManager;
  const openExternal = vi.fn<(url: string) => Promise<void>>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
    store = new MemoryStore();
    openExternal.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { manager?.dispose(); vi.useRealTimers(); });
  it('reports only a controlled native network code when discovery fails before any device request', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('PRIVATE_REQUEST_URL PRIVATE_CREDENTIAL net::ERR_PROXY_CONNECTION_FAILED'); });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const progress = await manager.beginLogin('grok');
    expect(progress).toMatchObject({ state: 'error', stage: 'discovery', category: 'network', errorCode: 'ERR_PROXY_CONNECTION_FAILED' });
    expect(JSON.stringify(progress)).not.toContain('PRIVATE_');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(openExternal).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
  });

  it('polls a Codex pending device grant, exchanges PKCE, saves credentials and shows no token', async () => {
    let polls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/deviceauth/usercode')) return json({ device_auth_id: 'device', user_code: 'ABC-DEF', interval: '1' });
      if (path.endsWith('/deviceauth/token')) return ++polls === 1 ? json({}, 403) : json({ authorization_code: 'authcode', code_verifier: 'pkce-verifier', code_challenge: 'challenge' });
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
      expect(form.get('code_verifier')).toBe('pkce-verifier');
      return json({ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }), refresh_token: 'PRIVATE_REFRESH', expires_in: 3600 });
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const progress = await manager.beginLogin('gpt');
    expect(progress.userCode).toBe('ABC-DEF');
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    expect(store.getProvider('gpt')?.authStatus).toBe('signing-in');
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.progress('gpt')?.state).toBe('complete');
    expect(store.getSecret('gpt')?.accountId).toBe('acct');
    expect(store.getSecret('gpt')?.refreshToken).toBe('PRIVATE_REFRESH');
    expect(JSON.stringify(manager.progress('gpt'))).not.toContain('PRIVATE_REFRESH');
    expect(store.getProvider('gpt')?.authStatus).toBe('ready');
  });

  it('discovers Grok endpoints, applies slow_down and rotates a device grant into credentials', async () => {
    let polls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('openid-configuration')) return json({ issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai/device', token_endpoint: 'https://auth.x.ai/token' });
      if (path.endsWith('/device')) return json({ device_code: 'grok-device', user_code: 'GROK', verification_uri_complete: 'https://auth.x.ai/activate?user_code=GROK', interval: 1, expires_in: 30 });
      return ++polls === 1 ? json({ error: 'slow_down' }, 400) : json({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600, token_type: 'Bearer' });
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    await manager.beginLogin('grok');
    await vi.advanceTimersByTimeAsync(5999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.progress('grok')?.state).toBe('complete');
    expect(store.getSecret('grok')?.tokenEndpoint).toBe('https://auth.x.ai/token');
  });

  it('rejects malicious discovery endpoints before sending a device request or opening a browser', async () => {
    const fetcher = vi.fn(async () => json({ issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai.attacker.test/device', token_endpoint: 'https://auth.x.ai/token' }));
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const progress = await manager.beginLogin('grok');
    expect(progress.state).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('expires pending device grants without polling after expiry', async () => {
    let polls = 0;
    manager = new OAuthManager(store, { openExternal, fetch: (async (url) => String(url).endsWith('/usercode')
      ? json({ device_auth_id: 'device', user_code: 'CODE', interval: 1, expires_in: 2 })
      : (polls++, json({}, 404))) as typeof fetch });
    await manager.beginLogin('gpt');
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.progress('gpt')?.state).toBe('error');
    expect(manager.progress('gpt')?.message).toContain('过期');
    const count = polls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls).toBe(count);
    expect(store.writes).toBe(0);
  });

  it('cancels an active token request and does not persist credentials', async () => {
    let requestSignal: AbortSignal | undefined;
    manager = new OAuthManager(store, { openExternal, fetch: (async (url, init) => {
      if (String(url).endsWith('/usercode')) return json({ device_auth_id: 'device', user_code: 'CODE', interval: 1 });
      requestSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }) as typeof fetch });
    await manager.beginLogin('gpt');
    expect(requestSignal?.aborted).toBe(false);
    manager.cancel('gpt');
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSignal?.aborted).toBe(true);
    expect(manager.progress('gpt')?.state).toBe('cancelled');
    expect(store.writes).toBe(0);
    expect(store.getProvider('gpt')?.authStatus).toBe('missing');
  });

  it('bounds a device-code network request with a timeout', async () => {
    let signal: AbortSignal | undefined;
    manager = new OAuthManager(store, { openExternal, fetch: (async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }) as typeof fetch });
    const login = manager.beginLogin('gpt');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await login).state).toBe('error');
    expect(manager.progress('gpt')?.message).toContain('超时');
    expect(signal?.aborted).toBe(true);
    expect(store.writes).toBe(0);
  });

  it('aborts an in-flight token request at device expiry instead of exceeding the device lifetime', async () => {
    let signal: AbortSignal | undefined;
    manager = new OAuthManager(store, { openExternal, fetch: (async (url, init) => {
      if (String(url).endsWith('/usercode')) return json({ device_auth_id: 'device', user_code: 'CODE', expires_in: 2 });
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }) as typeof fetch });
    await manager.beginLogin('gpt');
    await vi.advanceTimersByTimeAsync(2000);
    expect(signal?.aborted).toBe(true);
    expect(manager.progress('gpt')?.state).toBe('error');
    expect(manager.progress('gpt')?.message).toContain('过期');
    expect(store.writes).toBe(0);
  });

  it('reports an authorization denial without forwarding raw token-bearing error descriptions', async () => {
    manager = new OAuthManager(store, { openExternal, fetch: (async (url) => String(url).endsWith('/usercode')
      ? json({ device_auth_id: 'device', user_code: 'CODE' })
      : json({ error: 'access_denied', error_description: 'PRIVATE_ACCESS PRIVATE_REFRESH' }, 400)) as typeof fetch });
    await manager.beginLogin('gpt');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('gpt')?.state).toBe('error');
    expect(manager.progress('gpt')?.message).toContain('拒绝');
    expect(JSON.stringify(manager.progress('gpt'))).not.toContain('PRIVATE_');
    expect(store.writes).toBe(0);
  });

  it('uses a single refresh for concurrent requests and preserves rotated refresh tokens', async () => {
    store.setSecret('gpt', { accessToken: 'OLD_ACCESS', refreshToken: 'OLD_REFRESH', expiresAt: Date.now() - 1, accountId: 'acct' });
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(async () => await new Promise<Response>((done) => { resolve = done; }));
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const a = manager.prepareRequest(codex, '/v1/responses', { model: 'gpt', input: 'hello' });
    const b = manager.prepareRequest(codex, '/v1/responses', { model: 'gpt', input: 'hello' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(json({ access_token: 'NEW_ACCESS', refresh_token: 'ROTATED_REFRESH', expires_in: 3600 }));
    const requests = await Promise.all([a, b]);
    expect(requests.every((r) => r.headers.Authorization === 'Bearer NEW_ACCESS')).toBe(true);
    expect(store.getSecret('gpt')?.refreshToken).toBe('ROTATED_REFRESH');
    expect(store.getSecret('gpt')?.accountId).toBe('acct');
    expect(store.writes).toBe(2);
  });

  it('keeps existing credential records and marks error when refresh is rejected', async () => {
    const old = { accessToken: 'OLD_ACCESS', refreshToken: 'OLD_REFRESH', expiresAt: Date.now() - 1 };
    store.setSecret('gpt', old);
    manager = new OAuthManager(store, { openExternal, fetch: (async () => json({ error: 'invalid_grant', error_description: 'OLD_REFRESH' }, 400)) as typeof fetch });
    await expect(manager.prepareRequest(codex, '/responses', { input: 'hello' })).rejects.toThrow('失效');
    expect(store.getSecret('gpt')).toEqual(old);
    expect(store.getProvider('gpt')?.authStatus).toBe('error');
    expect(store.writes).toBe(1);
  });

  it('aborts refresh on cancel and rejects late replies without overwriting the old token', async () => {
    store.setSecret('gpt', { accessToken: 'OLD_ACCESS', refreshToken: 'OLD_REFRESH', expiresAt: Date.now() - 1 });
    let resolve!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    manager = new OAuthManager(store, { openExternal, fetch: (async (_url, init) => { signal = init?.signal as AbortSignal; return await new Promise<Response>((done) => { resolve = done; }); }) as typeof fetch });
    const request = manager.prepareRequest(codex, '/responses', { input: 'hello' });
    const rejection = expect(request).rejects.toThrow('取消');
    manager.cancel('gpt');
    expect(signal?.aborted).toBe(true);
    resolve(json({ access_token: 'LATE_ACCESS', refresh_token: 'LATE_REFRESH', expires_in: 3600 }));
    await rejection;
    expect(store.getSecret('gpt')?.accessToken).toBe('OLD_ACCESS');
    expect(store.writes).toBe(1);
  });

  it('uses transparent product UA, native-compatible fetch options and reports nested region rejection safely at device-code stage', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('User-Agent')).toBe(`ModelDock/${appVersion}`);
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error');
      return json({ error: { code: 'unsupported_country_region_territory', message: 'PRIVATE_ACCESS PRIVATE_REFRESH', type: 'request_forbidden' } }, 403);
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const progress = await manager.beginLogin('gpt');
    expect(progress).toMatchObject({ state: 'error', stage: 'device-code', category: 'region', statusCode: 403 });
    expect(progress.message).toContain('网络出口'); expect(JSON.stringify(progress)).not.toContain('PRIVATE_');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(openExternal).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
  });

  it.each([
    [{ error: 'device_auth_disabled' }, 'device-disabled'],
    [{ error: { type: 'access_denied', message: 'PRIVATE_ACCESS' } }, 'denied'],
    [{ error: { code: 'unknown_private_error', message: 'PRIVATE_ACCESS' } }, 'upstream'],
    [{}, 'upstream'],
  ] as const)('classifies declared errors without inferring pending from device-code HTTP 403 (%j)', async (body, category) => {
    const fetcher = vi.fn(async () => json(body, 403));
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const progress = await manager.beginLogin('gpt');
    expect(progress).toMatchObject({ state: 'error', stage: 'device-code', category, statusCode: 403 });
    expect(JSON.stringify(progress)).not.toMatch(/PRIVATE_|unknown_private_error/);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps JSON 403/404 token polling pending but rejects HTML or nested explicit errors without repeatedly polling', async () => {
    const pollingResponses = [
      { response: json({}, 403), category: undefined },
      { response: json({}, 404), category: undefined },
      { response: new Response('<html>PRIVATE_ACCESS challenge</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }), category: 'blocked' },
      { response: new Response('PRIVATE_ACCESS not JSON', { status: 404 }), category: 'blocked' },
      { response: json({ error: { code: 'unsupported_country_region_territory' } }, 403), category: 'region' },
      { response: json({ error: { code: 'access_denied' } }, 403), category: 'denied' },
      { response: json({ error: { code: 'device_auth_disabled' } }, 403), category: 'device-disabled' },
      { response: json({ error: { code: 'expired_token' } }, 403), category: 'expired' },
      { response: json({ error: { code: 'unknown', message: 'PRIVATE_ACCESS' } }, 403), category: 'upstream' },
    ];
    for (const { response, category } of pollingResponses) {
      let polls = 0;
      manager = new OAuthManager(store, { openExternal, fetch: (async (url) => String(url).endsWith('/usercode') ? json({ device_auth_id: 'device', user_code: 'CODE', interval: 1 }) : (polls++, response)) as typeof fetch });
      await manager.beginLogin('gpt'); await vi.advanceTimersByTimeAsync(0);
      expect(manager.progress('gpt')).toMatchObject(category ? { state: 'error', stage: 'device-poll', category, statusCode: response.status } : { state: 'pending', stage: 'device-poll' });
      expect(polls).toBe(1); expect(JSON.stringify(manager.progress('gpt'))).not.toContain('PRIVATE_');
      manager.dispose();
    }
  });

  it.each([403, 404])('preserves device code and verification URL through repeated observed Codex pending HTTP %s responses and then completes PKCE', async status => {
    let polls = 0, exchanges = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/usercode')) return json({ device_auth_id: 'synthetic-device', user_code: 'ABC-DEF', interval: 1 });
      if (String(url).endsWith('/deviceauth/token')) {
        expect(JSON.parse(String(init?.body))).toEqual({ device_auth_id: 'synthetic-device', user_code: 'ABC-DEF' });
        return ++polls <= 2 ? json({ error: { code: 'deviceauth_authorization_pending', type: 'invalid_request_error', message: 'PRIVATE_PENDING_BODY' } }, status)
          : json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
      }
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('authorization_code'); expect(form.get('code_verifier')).toBe('synthetic-verifier');
      expect(form.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback'); exchanges++;
      return json({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600 });
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    await manager.beginLogin('gpt');
    for (const delay of [0, 1000]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(manager.progress('gpt')).toMatchObject({ state: 'pending', stage: 'device-poll', userCode: 'ABC-DEF', verificationUri: 'https://auth.openai.com/codex/device' });
      expect(manager.progress('gpt')?.category).toBeUndefined(); expect(store.getProvider('gpt')?.authStatus).toBe('signing-in');
      expect(store.writes).toBe(0); expect(JSON.stringify(manager.progress('gpt'))).not.toContain('PRIVATE_');
    }
    expect(polls).toBe(2); expect(exchanges).toBe(0); expect(openExternal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toBe(3); expect(exchanges).toBe(1); expect(manager.progress('gpt')?.state).toBe('complete');
    expect(store.getProvider('gpt')?.authStatus).toBe('ready'); expect(store.writes).toBe(1);
  });

  it('does not accept the Codex-specific pending code on device-code creation, successful-error responses, or Grok polling', async () => {
    const body = { error: { code: 'deviceauth_authorization_pending', type: 'invalid_request_error', message: 'PRIVATE_PENDING_BODY' } };
    const creation = vi.fn(async () => json(body, 403));
    manager = new OAuthManager(store, { openExternal, fetch: creation as typeof fetch });
    expect(await manager.beginLogin('gpt')).toMatchObject({ state: 'error', stage: 'device-code', statusCode: 403, category: 'upstream' });
    expect(creation).toHaveBeenCalledTimes(1); expect(openExternal).not.toHaveBeenCalled(); manager.dispose();

    manager = new OAuthManager(store, { openExternal, fetch: (async url => String(url).endsWith('/usercode') ? json({ device_auth_id: 'synthetic-device', user_code: 'CODE' }) : json(body, 200)) as typeof fetch });
    await manager.beginLogin('gpt'); await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('gpt')).toMatchObject({ state: 'error', stage: 'device-poll', statusCode: 200, category: 'upstream' }); manager.dispose();

    manager = new OAuthManager(store, { openExternal, fetch: (async url => String(url).includes('openid-configuration')
      ? json({ issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai/device', token_endpoint: 'https://auth.x.ai/token' })
      : String(url).endsWith('/device') ? json({ device_code: 'synthetic-device', user_code: 'CODE', verification_uri: 'https://auth.x.ai/activate' }) : json(body, 403)) as typeof fetch });
    await manager.beginLogin('grok'); await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('grok')).toMatchObject({ state: 'error', stage: 'device-poll', statusCode: 403, category: 'upstream' });
    expect(JSON.stringify(manager.progress('grok'))).not.toContain('PRIVATE_'); expect(store.writes).toBe(0);
  });

  it('reports a token exchange failure with its own phase and leaves all response text private', async () => {
    manager = new OAuthManager(store, { openExternal, fetch: (async (url) => String(url).endsWith('/usercode')
      ? json({ device_auth_id: 'device', user_code: 'CODE' })
      : String(url).endsWith('/deviceauth/token') ? json({ authorization_code: 'code', code_verifier: 'verifier' })
        : json({ error: { code: 'unsupported_country_region_territory', message: 'PRIVATE_ACCESS' } }, 403)) as typeof fetch });
    await manager.beginLogin('gpt'); await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('gpt')).toMatchObject({ state: 'error', stage: 'token-exchange', category: 'region', statusCode: 403 });
    expect(JSON.stringify(manager.progress('gpt'))).not.toContain('PRIVATE_'); expect(store.writes).toBe(0);
  });

  it('reports HTTP 410 as expired during device polling, including an empty response body', async () => {
    manager = new OAuthManager(store, { openExternal, fetch: (async (url) => String(url).endsWith('/usercode') ? json({ device_auth_id: 'device', user_code: 'CODE' }) : new Response(null, { status: 410 })) as typeof fetch });
    await manager.beginLogin('gpt'); await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('gpt')).toMatchObject({ state: 'error', stage: 'device-poll', category: 'expired', statusCode: 410 });
    expect(manager.progress('gpt')?.message).toContain('过期'); expect(store.writes).toBe(0);
  });

  it.each([
    ['ready', 3600_000, 'ready'],
    ['ready', -1, 'error'],
    ['error', 3600_000, 'error'],
  ] as const)('preserves old secrets and correctly restores %s on login failure (expiry %+d)', async (oldStatus, expiry, expectedStatus) => {
    const old = { accessToken: 'OLD_PRIVATE_ACCESS', refreshToken: 'OLD_PRIVATE_REFRESH', expiresAt: Date.now() + expiry };
    store.setSecret('gpt', old); store.setAuthStatus('gpt', oldStatus);
    manager = new OAuthManager(store, { openExternal, fetch: (async () => json({ error: { code: 'unsupported_country_region_territory' } }, 403)) as typeof fetch });
    const progress = await manager.beginLogin('gpt');
    expect(progress).toMatchObject({ state: 'error', category: 'region' });
    expect(store.getProvider('gpt')?.authStatus).toBe(expectedStatus); expect(store.getSecret('gpt')).toEqual(old); expect(store.writes).toBe(1);
    expect(JSON.stringify(progress)).not.toContain('OLD_PRIVATE_');
  });

  it('also preserves a valid ready account when re-login is cancelled, while leaving an existing error account in error', async () => {
    for (const oldStatus of ['ready', 'error'] as const) {
      store.setSecret('gpt', { accessToken: 'OLD_PRIVATE_ACCESS', expiresAt: Date.now() + 3_600_000 }); store.setAuthStatus('gpt', oldStatus);
      manager = new OAuthManager(store, { openExternal, fetch: (async (url) => String(url).endsWith('/usercode') ? json({ device_auth_id: 'device', user_code: 'CODE' }) : json({}, 403)) as typeof fetch });
      await manager.beginLogin('gpt'); manager.cancel('gpt'); await vi.advanceTimersByTimeAsync(0);
      expect(manager.progress('gpt')?.state).toBe('cancelled'); expect(store.getProvider('gpt')?.authStatus).toBe(oldStatus);
      manager.dispose();
    }
  });

  it('bounds declared/streamed authorization bodies and never exposes them in failures', async () => {
    for (const response of [json({}, 403), new Response('x'.repeat(128 * 1024 + 1), { status: 403, headers: { 'Content-Type': 'text/html' } })]) {
      if (response.headers.get('content-type') === 'application/json') response.headers.set('content-length', '200000');
      manager = new OAuthManager(store, { openExternal, fetch: (async () => response) as typeof fetch });
      const progress = await manager.beginLogin('gpt');
      expect(progress).toMatchObject({ state: 'error', stage: 'device-code', category: 'invalid-response', statusCode: 403 });
      expect(progress.message).toContain('内容过大'); expect(store.writes).toBe(0);
      manager.dispose();
    }
  });

  it('times out non-cooperative fetches and stalled response streams with safe stage diagnostics', async () => {
    manager = new OAuthManager(store, { openExternal, fetch: (() => new Promise<Response>(() => {})) as typeof fetch });
    let pending = manager.beginLogin('gpt'); await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ state: 'error', stage: 'device-code', category: 'timeout' }); manager.dispose();
    let cancelled = false;
    manager = new OAuthManager(store, { openExternal, fetch: (async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch });
    pending = manager.beginLogin('gpt'); await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ state: 'error', stage: 'device-code', category: 'timeout' }); expect(cancelled).toBe(true); expect(store.writes).toBe(0);
  });
});

describe('Grok OAuth alignment and credential replacement safety (mock HTTP only)', () => {
  const grokClient = 'b1a00492-073a-47ea-816f-4c329264a828';
  const grokScope = 'openid profile email offline_access grok-cli:access api:access';
  let store: MemoryStore;
  let manager: OAuthManager;
  const openExternal = vi.fn<(url: string) => Promise<void>>();
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
    store = new MemoryStore(); openExternal.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { manager?.dispose(); vi.useRealTimers(); });
  const discovery = (issuer: unknown = 'https://auth.x.ai') => json({ issuer, device_authorization_endpoint: 'https://auth.x.ai/device', token_endpoint: 'https://auth.x.ai/token' });
  const deviceGrant = () => json({ device_code: 'synthetic-device', user_code: 'MOCK-GROK', verification_uri: 'https://auth.x.ai/activate', interval: 1, expires_in: 30 });
  function ready(secret: ProviderSecret) { store.setSecret('grok', secret); store.setAuthStatus('grok', 'ready'); }

  it('sends Grok device and polling forms, accepts trailing-slash issuer, and saves ID-token identity without exposing tokens', async () => {
    const idToken = jwt({ sub: 'stable-grok-subject', email: 'synthetic@example.test', exp: Date.now() / 1000 + 7200 });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('openid-configuration')) return discovery('https://auth.x.ai/');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe(grokClient);
      if (String(url).endsWith('/device')) {
        expect(Object.fromEntries(form)).toEqual({ client_id: grokClient, scope: grokScope });
        return deviceGrant();
      }
      expect(Object.fromEntries(form)).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'synthetic-device', client_id: grokClient });
      return json({ access_token: 'PRIVATE_OPAQUE_ACCESS', refresh_token: 'PRIVATE_REFRESH', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const initial = await manager.beginLogin('grok');
    expect(initial).toMatchObject({ state: 'pending', userCode: 'MOCK-GROK', verificationUri: 'https://auth.x.ai/activate' });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('grok')?.state).toBe('complete');
    expect(store.getSecret('grok')).toMatchObject({ accountId: 'stable-grok-subject', idToken, accessToken: 'PRIVATE_OPAQUE_ACCESS', refreshToken: 'PRIVATE_REFRESH', expiresAt: Date.now() + 3_600_000 });
    expect(JSON.stringify([initial, manager.progress('grok')])).not.toMatch(/PRIVATE_|idToken|accessToken|refreshToken/);
    expect(JSON.stringify(manager.progress('grok'))).not.toContain(idToken);
    expect(openExternal).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null, '', 'https://accounts.x.ai', 'https://auth.x.ai/other'])('rejects absent or mismatched Grok issuer before requesting a code (%j)', async issuer => {
    const fetcher = vi.fn(async () => json({ ...(issuer === undefined ? {} : { issuer }), device_authorization_endpoint: 'https://auth.x.ai/device', token_endpoint: 'https://auth.x.ai/token' }));
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const progress = await manager.beginLogin('grok');
    expect(progress).toMatchObject({ state: 'error', stage: 'discovery' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(openExternal).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
    expect(progress.userCode).toBeUndefined();
  });

  it.each([
    ['id-token', 'id-subject'],
    ['access-token', 'access-subject'],
  ] as const)('uses a stable Grok subject from %s claims', async (source, expected) => {
    const accessToken = jwt({ sub: 'access-subject', exp: Date.now() / 1000 + 3600 });
    const idToken = source === 'id-token' ? jwt({ sub: 'id-subject', email: 'synthetic@example.test' }) : undefined;
    manager = new OAuthManager(store, { openExternal, fetch: (async url => String(url).includes('openid-configuration') ? discovery() : String(url).endsWith('/device') ? deviceGrant() : json({ access_token: accessToken, refresh_token: 'PRIVATE_REFRESH', ...(idToken ? { id_token: idToken } : {}), expires_in: 3600 })) as typeof fetch });
    await manager.beginLogin('grok'); await vi.advanceTimersByTimeAsync(0);
    expect(store.getSecret('grok')?.accountId).toBe(expected);
    expect(manager.progress('grok')?.state).toBe('complete');
    expect(JSON.stringify(manager.progress('grok'))).not.toContain(accessToken);
    if (idToken) expect(JSON.stringify(manager.progress('grok'))).not.toContain(idToken);
  });

  it('refreshes Grok with the original scope and preserves or replaces ID tokens through rotation', async () => {
    const oldId = jwt({ sub: 'same-grok-account', email: 'old@example.test' });
    const newId = jwt({ sub: 'same-grok-account', email: 'new@example.test' });
    ready({ accessToken: 'OLD_PRIVATE_ACCESS', refreshToken: 'OLD_PRIVATE_REFRESH', idToken: oldId, accountId: 'same-grok-account', expiresAt: Date.now() - 1, tokenEndpoint: 'https://auth.x.ai/token' });
    let refreshes = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://auth.x.ai/token');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('refresh_token'); expect(form.get('client_id')).toBe(grokClient); expect(form.get('scope')).toBe(grokScope);
      if (++refreshes === 1) { expect(form.get('refresh_token')).toBe('OLD_PRIVATE_REFRESH'); return json({ access_token: 'NEW_PRIVATE_ACCESS', refresh_token: 'ROTATED_PRIVATE_REFRESH', expires_in: 3600 }); }
      expect(form.get('refresh_token')).toBe('ROTATED_PRIVATE_REFRESH');
      return json({ access_token: 'LATEST_PRIVATE_ACCESS', refresh_token: 'LATEST_PRIVATE_REFRESH', id_token: newId, expires_in: 3600 });
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const first = await manager.prepareRequest(grok, '/responses', { input: 'synthetic input' });
    expect(first.headers.Authorization).toBe('Bearer NEW_PRIVATE_ACCESS');
    expect(store.getSecret('grok')).toMatchObject({ idToken: oldId, refreshToken: 'ROTATED_PRIVATE_REFRESH', accountId: 'same-grok-account' });
    expect(JSON.stringify(first)).not.toContain(oldId);
    store.setSecret('grok', { ...store.getSecret('grok')!, expiresAt: Date.now() - 1 });
    const second = await manager.prepareRequest(grok, '/responses', { input: 'synthetic input' });
    expect(second.headers.Authorization).toBe('Bearer LATEST_PRIVATE_ACCESS');
    expect(store.getSecret('grok')).toMatchObject({ idToken: newId, refreshToken: 'LATEST_PRIVATE_REFRESH', accountId: 'same-grok-account' });
    expect(JSON.stringify(second)).not.toContain(newId); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['access', 'refresh'] as const)('rejects a late successful refresh when the current %s token has changed without touching new authorization', async changed => {
    const old: ProviderSecret = { accessToken: 'OLD_PRIVATE_ACCESS', refreshToken: 'OLD_PRIVATE_REFRESH', idToken: jwt({ sub: 'grok-account' }), accountId: 'grok-account', expiresAt: Date.now() - 1, tokenEndpoint: 'https://auth.x.ai/token' };
    ready(old);
    let release!: (response: Response) => void;
    const fetcher = vi.fn(async () => await new Promise<Response>(resolve => { release = resolve; }));
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const request = manager.prepareRequest(grok, '/responses', {});
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const replacement = { ...old, ...(changed === 'access' ? { accessToken: 'NEW_ACCOUNT_ACCESS' } : { refreshToken: 'NEW_ACCOUNT_REFRESH' }), expiresAt: Date.now() + 3_600_000 };
    store.setSecret('grok', replacement);
    release(json({ access_token: 'STALE_ACCESS_REPLY', refresh_token: 'STALE_REFRESH_REPLY', id_token: jwt({ sub: 'stale-reply' }), expires_in: 3600 }));
    await rejected;
    expect(store.getSecret('grok')).toEqual(replacement); expect(store.getProvider('grok')?.authStatus).toBe('ready');
    expect(store.writes).toBe(2); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not let an old rejected refresh mark newly replaced credentials as needing reauthorization', async () => {
    const old: ProviderSecret = { accessToken: 'OLD_PRIVATE_ACCESS', refreshToken: 'OLD_PRIVATE_REFRESH', expiresAt: Date.now() - 1, tokenEndpoint: 'https://auth.x.ai/token' };
    ready(old);
    let release!: (response: Response) => void;
    manager = new OAuthManager(store, { openExternal, fetch: (async () => await new Promise<Response>(resolve => { release = resolve; })) as typeof fetch });
    const request = manager.prepareRequest(grok, '/responses', {});
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const replacement: ProviderSecret = { ...old, accessToken: 'REPLACED_PRIVATE_ACCESS', refreshToken: 'REPLACED_PRIVATE_REFRESH', expiresAt: Date.now() + 3_600_000 };
    store.setSecret('grok', replacement);
    release(json({ error: 'invalid_grant', error_description: 'PRIVATE_REJECTED_REFRESH' }, 401));
    await rejected;
    expect(store.getSecret('grok')).toEqual(replacement); expect(store.getProvider('grok')?.authStatus).toBe('ready'); expect(store.writes).toBe(2);
  });

  it.each(['network', 'timeout', '429', '503'] as const)('keeps the existing ready authorization and its secrets after a transient %s refresh failure', async scenario => {
    const old: ProviderSecret = { accessToken: 'OLD_PRIVATE_ACCESS', refreshToken: 'OLD_PRIVATE_REFRESH', idToken: jwt({ sub: 'grok-account' }), expiresAt: Date.now() + 30_000, tokenEndpoint: 'https://auth.x.ai/token' };
    ready(old);
    const fetcher = vi.fn(async () => {
      if (scenario === 'network') throw new Error('PRIVATE_TRANSPORT_DETAILS');
      if (scenario === 'timeout') return await new Promise<Response>(() => {});
      return json({ error: scenario === '429' ? 'slow_down' : 'server_error', error_description: 'PRIVATE_ERROR_BODY' }, Number(scenario));
    });
    manager = new OAuthManager(store, { openExternal, fetch: fetcher as typeof fetch });
    const failure = manager.prepareRequest(grok, '/responses', {}).then(() => '', error => String(error));
    if (scenario === 'timeout') await vi.advanceTimersByTimeAsync(30_000);
    const message = await failure;
    expect(message).not.toBe(''); expect(message).not.toMatch(/PRIVATE_|idToken|accessToken|refreshToken/);
    expect(store.getProvider('grok')?.authStatus).toBe('ready'); expect(store.getSecret('grok')).toEqual(old); expect(store.writes).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[401, 'invalid_token'], [400, 'invalid_grant']] as const)('marks explicit Grok credential rejection HTTP %s as an authorization error while preserving the stored records', async (status, error) => {
    const old: ProviderSecret = { accessToken: 'OLD_PRIVATE_ACCESS', refreshToken: 'OLD_PRIVATE_REFRESH', expiresAt: Date.now() - 1, tokenEndpoint: 'https://auth.x.ai/token' };
    ready(old);
    manager = new OAuthManager(store, { openExternal, fetch: (async () => json({ error, error_description: 'PRIVATE_ERROR_BODY' }, status)) as typeof fetch });
    await expect(manager.prepareRequest(grok, '/responses', {})).rejects.toThrow();
    expect(store.getProvider('grok')?.authStatus).toBe('error'); expect(store.getSecret('grok')).toEqual(old); expect(store.writes).toBe(1);
  });

  it.each([
    ['access_denied', 'denied'], ['expired_token', 'expired'], ['invalid_grant', 'expired'], ['invalid_token', 'expired'],
    ['device_auth_disabled', 'device-disabled'], ['unsupported_country_region_territory', 'region'],
  ] as const)('stops Grok device polling immediately on terminal %s carried by HTTP 503', async (code, category) => {
    let polls = 0;
    manager = new OAuthManager(store, { openExternal, fetch: (async url => String(url).includes('openid-configuration') ? discovery() : String(url).endsWith('/device') ? deviceGrant() : (polls++, json({ error: { code, message: 'PRIVATE_TERMINAL_BODY' } }, 503))) as typeof fetch });
    await manager.beginLogin('grok'); await vi.advanceTimersByTimeAsync(0);
    expect(manager.progress('grok')).toMatchObject({ state: 'error', stage: 'device-poll', category, statusCode: 503 });
    expect(polls).toBe(1); expect(store.writes).toBe(0);
    expect(JSON.stringify(manager.progress('grok'))).not.toContain('PRIVATE_');
    await vi.advanceTimersByTimeAsync(10_000); expect(polls).toBe(1);
  });
});

describe('native upstream request preparation', () => {
  it('preserves tool call IDs, structured inputs and tool results while normalizing Codex fields', () => {
    const input = { model: 'gpt', store: true, stream: false, temperature: 0.3, max_output_tokens: 500,
      input: [{ role: 'system', content: [{ type: 'input_text', text: 'instructions', prompt_cache_breakpoint: true }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' }],
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }] };
    const result = prepareUpstream(codex, { accessToken: 'ACCESS', accountId: 'acct' }, '/v1/responses', input);
    expect(result.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(result.headers['ChatGPT-Account-Id']).toBe('acct');
    expect(result.body).toMatchObject({ store: false, stream: true, input: [{ role: 'developer' }, input.input[1], input.input[2]], tools: input.tools });
    expect(result.body).not.toHaveProperty('temperature');
    expect(result.body).not.toHaveProperty('max_output_tokens');
    expect((result.body.input as any[])[0].content[0]).not.toHaveProperty('prompt_cache_breakpoint');
    expect(input.input[0].role).toBe('system');
    expect(input.store).toBe(true);
  });

  it('never sends subscription tokens to arbitrary endpoints or fabricates protocol conversion', () => {
    expect(() => prepareUpstream({ ...codex, baseUrl: 'https://example.com/v1' }, { accessToken: 'ACCESS' }, '/responses', {})).toThrow('官方');
    expect(() => prepareUpstream(grok, { accessToken: 'ACCESS' }, '/chat/completions', {})).toThrow('Responses');
  });

  it('accepts HTTPS and loopback API servers but rejects insecure remote servers and URL credentials', () => {
    expect(upstreamEndpoint('http://127.0.0.1:8000/v1', '/v1/chat/completions')).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(upstreamEndpoint('https://ark.example.com/api/coding/v3', '/responses')).toBe('https://ark.example.com/api/coding/v3/responses');
    expect(() => upstreamEndpoint('http://example.com/v1', '/models')).toThrow('HTTPS');
    expect(() => upstreamEndpoint('https://key:secret@example.com/v1', '/models')).toThrow('凭据');
    expect(prepareUpstream(api, { apiKey: 'KEY' }, '/chat/completions', { stream: false }).headers.Authorization).toBe('Bearer KEY');
  });
});
