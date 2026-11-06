import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { CentralApi, CentralApiError, parseCentralTransfer, type CentralCredentials } from '../src/main/central-api';
import { CentralClientSessionReader } from '../src/main/central-client-session';
import { CentralGatewayAdapter } from '../src/main/central-gateway-adapter';
import type { Provider } from '../src/shared/types';

const now = 1900000000000;
const jwt = (claims: Record<string, unknown>) => [Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'SYNTHETIC'].join('.');
const token = jwt({ sub: 'native-account', exp: now / 1000 + 3600 });
const credential: CentralCredentials = { token, accountId: 'native-account', accountLabel: 'Synthetic account', licenseId: 'license-1', expiresAt: now + 3600000 };
const transfer = { version: 1 as const, environment: 'prod' as const, refreshToken: 'SYNTHETIC_REFRESH', licenseId: 'license-1' };
const envelope = (override: Record<string, unknown> = {}) => 'central-' + Buffer.from(JSON.stringify({ version: 1, refresh_token: 'SYNTHETIC_REFRESH', environment: 'prod', ai_access: { type: 'license', license_id: 'license-1' }, eap_tos_accepted: true, google_analytics_accepted: false, ...override })).toString('base64url');
const mockFetch = (callback: (url: string, init: RequestInit) => Response | Promise<Response>) => vi.fn<typeof fetch>(async (url, init) => callback(String(url), init!));
const catalog = (url: string) => Response.json({ data: [{ id: url.includes('/anthropic/') ? 'claude-native' : 'gpt-native' }] });
const nativeApi = () => ({ exchange: vi.fn(async () => ({ token, expiresAt: credential.expiresAt })), quota: vi.fn(async () => ({ status: 'ready' as const, windows: [{ id: 'fixture', label: 'Credits', total: 20, remaining: 15, unit: 'AI Credits' }], message: 'Synthetic official quota' })) });

describe('Central first-party native session and direct provider protocol', () => {
  it('parses the official central- envelope without retaining ambient settings or analytics consent', () => {
    expect(parseCentralTransfer(envelope())).toEqual(transfer);
    expect(parseCentralTransfer(envelope().replace('central-', 'central-\r\n'))).toEqual(transfer);
    for (const raw of ['broken', envelope({ version: 2 }), envelope({ refresh_token: '' }), envelope({ eap_tos_accepted: false })]) expect(() => parseCentralTransfer(raw)).toThrow(CentralApiError);
  });
  it.each([{ environment: 'staging' }, { environment: 'ides', server_url: 'https://enterprise.example' }, { ai_access: { type: 'workspace', org_id: 'org', workspace_id: 'workspace' } }, { ai_access: { type: 'license', license_id: 'license-1', org_id: 'unexpected-org' } }])('rejects unsupported identity scope before any auth or inference request: %j', override => {
    expect(() => parseCentralTransfer(envelope(override))).toThrowError(expect.objectContaining({ code: 'unsupported' }));
  });
  it('performs one explicit official OAuth refresh and exchanges only the exact chosen license', async () => {
    const idToken = jwt({ sub: 'jba-account', email: 'synthetic@example.invalid', exp: now / 1000 + 1800 });
    const fetch = mockFetch(() => Response.json({ id_token: idToken, refresh_token: 'SYNTHETIC_ROTATED_REFRESH', access_token: 'SYNTHETIC_ACCESS' })), native = nativeApi();
    const api = new CentralApi({ fetch, now: () => now, nativeApi: native });
    const session = await api.connect(transfer);
    expect(session).toEqual({ ...credential, accountId: 'jba-account', accountLabel: 'synthetic@example.invalid' });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://oauth.account.jetbrains.com/oauth2/token');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', client_id: 'central-cli', refresh_token: transfer.refreshToken });
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    expect(native.exchange).toHaveBeenCalledWith({ idToken, licenseId: 'license-1' }, expect.any(AbortSignal));
    expect(JSON.stringify(session)).not.toContain('REFRESH'); expect(fetch).toHaveBeenCalledTimes(1);
    await api.quota(session); expect(native.quota).toHaveBeenCalledWith(token, undefined);
  });
  it('refuses failed/redirected OAuth and suppresses secret error bodies without retry', async () => {
    const fetch = mockFetch(() => new Response('SYNTHETIC_PRIVATE_ERROR', { status: 401 })), native = nativeApi();
    const error = await new CentralApi({ fetch, nativeApi: native, now: () => now }).connect(transfer).catch(value => value);
    expect(error).toMatchObject({ code: 'authorization', status: 401 }); expect(String(error)).not.toContain('SYNTHETIC_PRIVATE'); expect(native.exchange).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('lists actual official OpenAI/Anthropic identifiers with independent native protocol markers', async () => {
    const fetch = mockFetch(catalog), api = new CentralApi({ fetch, now: () => now });
    expect((await api.models(credential)).data).toEqual([{ id: 'openai/gpt-native', object: 'model', owned_by: 'jetbrains', wire_api: 'chat-completions' }, { id: 'anthropic/claude-native', object: 'model', owned_by: 'jetbrains', wire_api: 'messages' }]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.jetbrains.ai/user/v5/llm/openai/v1/models', 'https://api.jetbrains.ai/user/v5/llm/anthropic/v1/models']);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get('Grazie-Authenticate-JWT')).toBe(token);
  });
  it.each([['/chat/completions', 'openai/gpt-native', '/openai/v1/chat/completions'], ['/v1/responses', 'openai/gpt-native', '/openai/v1/responses'], ['/v1/messages', 'anthropic/claude-native', '/anthropic/v1/messages']])('streams %s immediately through the official selected provider path', async (path, model, suffix) => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const fetch = mockFetch(url => url.endsWith('/models') ? catalog(url) : new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    const api = new CentralApi({ fetch, now: () => now }), body = { model, stream: true, max_tokens: 37, messages: [{ role: 'user', content: 'hello' }] };
    const response = await api.request(credential, path, body), reader = response.body!.getReader();
    const first = reader.read(); source.enqueue(new TextEncoder().encode('data: {"first":"delta"}\n\n'));
    expect(new TextDecoder().decode((await first).value)).toContain('"first":"delta"');
    const [, init] = fetch.mock.calls[2]; expect(String(fetch.mock.calls[2][0])).toBe('https://api.jetbrains.ai/user/v5/llm' + suffix); expect(JSON.parse(String(init?.body))).toEqual({ ...body, model: model.split('/')[1] });
    source.close(); expect((await reader.read()).done).toBe(true);
  });
  it('refuses unmatched provider protocols and unlisted models without fallback', async () => {
    const fetch = mockFetch(catalog), api = new CentralApi({ fetch, now: () => now });
    await expect(api.request(credential, '/messages', { model: 'openai/gpt-native' })).rejects.toMatchObject({ code: 'request' });
    await expect(api.request(credential, '/responses', { model: 'anthropic/claude-native' })).rejects.toMatchObject({ code: 'request' });
    await expect(api.request(credential, '/responses', { model: 'openai/invented' })).rejects.toMatchObject({ code: 'model' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('cancels its upstream stream and fetch signal when the client disconnects', async () => {
    let cancelled = false, signal: AbortSignal | undefined;
    const fetch = mockFetch((url, init) => { if (url.endsWith('/models')) return catalog(url); signal = init.signal as AbortSignal; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }); });
    const abort = new AbortController(), api = new CentralApi({ fetch, now: () => now });
    const response = await api.request(credential, '/responses', { model: 'openai/gpt-native', stream: true }, abort.signal), reading = response.text(); abort.abort();
    await expect(reading).rejects.toMatchObject({ code: 'cancelled' }); expect(signal?.aborted).toBe(true); expect(cancelled).toBe(true);
  });
  it('uses only the one-shot export command with a bounded private runner contract', async () => {
    const home = resolve('synthetic-home'), executable = join(resolve('synthetic-bin'), process.platform === 'win32' ? 'central.exe' : 'central');
    const run = vi.fn(async () => ({ exitCode: 0, stdout: envelope(), stderr: '' }));
    const reader = new CentralClientSessionReader({ homeDir: home, resolveExecutable: async () => executable, run });
    expect(await reader.read()).toEqual(transfer);
    expect(run.mock.calls[0]).toEqual([executable, ['login', 'export'], expect.objectContaining({ cwd: home, timeoutMs: 10000, maxOutputBytes: 65536 })]);
    const failedRun = vi.fn(async () => ({ exitCode: 1, stdout: 'SYNTHETIC_SECRET', stderr: 'SYNTHETIC_PRIVATE_PATH' }));
    const error = new CentralClientSessionReader({ resolveExecutable: async () => executable, run: failedRun });
    await expect(error.read()).rejects.not.toThrow(/SYNTHETIC/);
    expect(failedRun).toHaveBeenCalledOnce();
  });
  it('refuses a legacy Central provider at the Gateway adapter instead of invoking old Pi/Central', async () => {
    const api = new CentralApi({ now: () => now }), adapter = new CentralGatewayAdapter({ isNativeProvider: () => false, credentials: () => credential }, api);
    const provider = { id: 'legacy', nativeAdapter: 'jetbrains-central' } as Provider;
    await expect(adapter.models(provider, new AbortController().signal)).rejects.toThrow('重新连接');
    await expect(adapter.request(provider, '/responses', {}, new AbortController().signal)).rejects.toThrow('重新连接');
  });
});
