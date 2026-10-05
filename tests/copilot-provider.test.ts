import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotProviderManager, isCopilotUpstream, type CopilotProviderAccounts, type CopilotProviderStore } from '../src/main/copilot-provider';
import { CopilotAuthCenter, type CopilotInferenceAuthorization } from '../src/main/copilot-auth';
import type { AuthProgress, Provider, ProviderSecret } from '../src/shared/types';

const GITHUB_TOKEN = 'SYNTHETIC_PRIVATE_GITHUB_TOKEN';
const COPILOT_TOKEN = 'SYNTHETIC_PRIVATE_COPILOT_TOKEN';
const ACCOUNT = 'copilot:42';
const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const source: Provider = { id: 'copilot-source', name: 'Copilot', kind: 'copilot', presetId: 'copilot-subscription', baseUrl: 'https://api.githubcopilot.com', hasSecret: false, authStatus: 'missing', enabled: true, note: '' };
const reply = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
class MemoryStore implements CopilotProviderStore {
  providers = new Map([[source.id, structuredClone(source)]]);
  secrets = new Map<string, ProviderSecret>();
  state = new Map<string, unknown>();
  getProvider(id: string) { return this.providers.get(id); }
  listProviders() { return [...this.providers.values()]; }
  getSecret(id: string) { return structuredClone(this.secrets.get(id)); }
  setSecret(id: string, secret: ProviderSecret) { this.secrets.set(id, structuredClone(secret)); const provider = this.providers.get(id)!; provider.hasSecret = Boolean(secret.copilotAccountId); provider.authStatus = provider.hasSecret ? 'ready' : 'missing'; }
  setAuthStatus(id: string, status: Provider['authStatus']) { const provider = this.providers.get(id); if (provider) provider.authStatus = status; }
  getManagedState<T>(key: string, fallback: T): T { return structuredClone(this.state.get(key) ?? fallback) as T; }
  setManagedState(key: string, value: unknown) { this.state.set(key, structuredClone(value)); }
}
class Accounts implements CopilotProviderAccounts {
  values = new Map<string, CopilotInferenceAuthorization>([[ACCOUNT, { accessToken: GITHUB_TOKEN, revision: 0 }]]);
  status: AuthProgress | null = null;
  getInferenceAuthorization(id: string) { const value = this.values.get(id); if (!value) throw new Error(GITHUB_TOKEN); return { ...value }; }
  async beginLogin(providerId?: string): Promise<AuthProgress> { this.status = { providerId: providerId ?? 'copilot:login', state: 'pending', message: 'pending' }; return this.status; }
  progress() { return this.status; }
  cancel() { if (this.status) this.status = { ...this.status, state: 'cancelled' }; }
}
function fixture(fetcher?: typeof fetch) {
  const store = new MemoryStore(), accounts = new Accounts(); let clock = Date.parse('2026-10-07T00:00:00Z');
  const fetch = vi.fn(fetcher ?? (async () => reply({ token: COPILOT_TOKEN, expires_at: clock / 1000 + 1800, refresh_in: 900, endpoints: { api: 'https://api.individual.githubcopilot.com' } })));
  const manager = new CopilotProviderManager(store, accounts, { fetch: fetch as typeof globalThis.fetch, now: () => clock });
  manager.linkAccount(source.id, ACCOUNT);
  return { store, accounts, manager, fetch, provider: () => store.getProvider(source.id)!, advance: (ms: number) => { clock += ms; } };
}
afterEach(() => { vi.useRealTimers(); });

describe('Copilot native subscription endpoints', () => {
  it.each(['/models', '/chat/completions', '/responses'])('allows the exact native route %s on official account hosts', path => {
    expect(isCopilotUpstream(`https://api.individual.githubcopilot.com${path}`, path)).toBe(true);
    expect(isCopilotUpstream(`https://api.githubcopilot.com${path}`, `/v1${path}`)).toBe(true);
  });
  it.each(['http://api.githubcopilot.com/models', 'https://api.githubcopilot.com.attacker.test/models', 'https://api.githubcopilot.com:444/models',
    'https://secret@api.githubcopilot.com/models', 'https://api.githubcopilot.com/models?token=secret', 'https://api.githubcopilot.com/models#secret',
    'https://api.githubcopilot.com/v1/models', 'https://api.githubcopilot.com/chat/completions', 'https://api.githubcopilot.com/embeddings', 'https://api.githubcopilot.com//models'])('rejects unsafe/mismatched endpoint %s', url => {
    expect(isCopilotUpstream(url, '/models')).toBe(false);
  });
  it('stores an account reference without copying GitHub token material', () => {
    const f = fixture(); expect(f.store.getSecret(source.id)).toEqual({ copilotAccountId: ACCOUNT });
    expect(JSON.stringify(f.store.getSecret(source.id))).not.toContain(GITHUB_TOKEN); expect(f.fetch).not.toHaveBeenCalled(); f.manager.dispose();
  });
  it('does not link missing/expired accounts or an API source', () => {
    const f = fixture(); expect(() => f.manager.linkAccount(source.id, 'copilot:99')).toThrow('账户不可用');
    f.store.providers.set('api-source', { ...source, id: 'api-source', kind: 'openai-compatible' });
    expect(() => f.manager.linkAccount('api-source', ACCOUNT)).toThrow('订阅供应商');
    expect(f.store.getSecret(source.id)).toEqual({ copilotAccountId: ACCOUNT }); f.manager.dispose();
  });
  it('exchanges only on the fixed GitHub endpoint and forwards native tool history unchanged', async () => {
    const f = fixture();
    const body = { model: 'real-model', stream: true, messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'foo', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'result' }], tools: [{ type: 'function', function: { name: 'foo', parameters: { type: 'object' } } }] };
    const request = await f.manager.prepareRequest(f.provider(), '/v1/chat/completions', body);
    expect(request.url).toBe('https://api.individual.githubcopilot.com/chat/completions'); expect(request.body).toEqual(body); expect(request.body).not.toBe(body);
    expect(request.headers.Authorization).toBe(`Bearer ${COPILOT_TOKEN}`); expect(request.headers['Copilot-Integration-Id']).toBe('code-oss');
    expect(request.headers.Accept).toBe('text/event-stream'); expect(request.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    const [url, init] = f.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_URL); expect(init.redirect).toBe('error'); expect(new Headers(init.headers).get('authorization')).toBe(`token ${GITHUB_TOKEN}`);
    expect(new Headers(init.headers).get('copilot-integration-id')).toBe('code-oss'); f.manager.dispose();
  });
  it('preserves Responses parameters without imposing Codex-only body changes', async () => {
    const f = fixture(); const body = { model: 'responses-model', stream: false, input: 'hello', instructions: 'system', max_output_tokens: 20, temperature: 0.5, store: true };
    const request = await f.manager.prepareRequest(f.provider(), '/responses', body);
    expect(request.body).toEqual(body); expect(request.headers.Accept).toBe('application/json'); f.manager.dispose();
  });
  it('rejects unrelated routes and user-supplied nonofficial base URLs before token exchange', async () => {
    const f = fixture(); await expect(f.manager.prepareRequest(f.provider(), '/embeddings', {})).rejects.toThrow('原生接口');
    f.provider().baseUrl = 'https://attacker.test'; await expect(f.manager.prepareRequest(f.provider(), '/models', {})).rejects.toThrow('官方 HTTPS');
    expect(f.fetch).not.toHaveBeenCalled(); f.manager.dispose();
  });
});

describe('Copilot token lifecycle and safe cancellation', () => {
  it('coalesces concurrent exchanges and reuses tokens until refresh_in', async () => {
    const held = deferred<Response>(), f = fixture((async () => held.promise) as typeof fetch);
    const requests = [f.manager.prepareRequest(f.provider(), '/models', {}), f.manager.prepareRequest(f.provider(), '/responses', { model: 'm' })];
    expect(f.fetch).toHaveBeenCalledTimes(1); held.resolve(reply({ token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000, refresh_in: 60 }));
    await Promise.all(requests); await f.manager.prepareRequest(f.provider(), '/models', {}); expect(f.fetch).toHaveBeenCalledTimes(1);
    f.fetch.mockImplementation(async () => reply({ token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000, refresh_in: 60 }));
    f.advance(60_001); await f.manager.prepareRequest(f.provider(), '/models', {}); expect(f.fetch).toHaveBeenCalledTimes(2); f.manager.dispose();
  });
  it('never reuses a token after the GitHub account authorization changes', async () => {
    const f = fixture(); await f.manager.prepareRequest(f.provider(), '/models', {});
    f.accounts.values.set(ACCOUNT, { accessToken: 'SYNTHETIC_ROTATED_GITHUB_TOKEN', revision: 1 });
    await f.manager.prepareRequest(f.provider(), '/models', {}); expect(f.fetch).toHaveBeenCalledTimes(2); f.manager.dispose();
  });
  it('rejects a late token response after logout and clears every source reference', async () => {
    const held = deferred<Response>(), f = fixture((async () => held.promise) as typeof fetch);
    f.store.providers.set('second-source', { ...source, id: 'second-source' }); f.manager.linkAccount('second-source', ACCOUNT);
    const pending = f.manager.prepareRequest(f.provider(), '/models', {}); const failed = expect(pending).rejects.toThrow('取消');
    f.accounts.values.delete(ACCOUNT); f.manager.unlinkAccount(ACCOUNT); await failed;
    held.resolve(reply({ token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000 })); await Promise.resolve();
    expect(f.store.getSecret(source.id)).toEqual({}); expect(f.store.getSecret('second-source')).toEqual({});
    await expect(f.manager.prepareRequest(f.provider(), '/models', {})).rejects.toThrow('选择账户'); f.manager.dispose();
  });
  it('rejects a source that is deleted or relinked while its token is pending', async () => {
    const held = deferred<Response>(), f = fixture((async () => held.promise) as typeof fetch);
    const pending = f.manager.prepareRequest(f.provider(), '/models', {});
    f.accounts.values.set('copilot:99', { accessToken: 'SYNTHETIC_OTHER_ACCOUNT_TOKEN', revision: 0 }); f.manager.linkAccount(source.id, 'copilot:99');
    held.resolve(reply({ token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000 }));
    await expect(pending).rejects.toThrow('来源或账户已变化'); f.manager.dispose();
  });
  it('times out even when an injected transport ignores AbortSignal', async () => {
    vi.useFakeTimers(); const f = fixture((async () => new Promise<Response>(() => {})) as typeof fetch);
    const pending = f.manager.prepareRequest(f.provider(), '/models', {}); const failed = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(15_000); await failed; f.manager.dispose();
  });
  it('rejects pending work and further links after disposal', async () => {
    const held = deferred<Response>(), f = fixture((async () => held.promise) as typeof fetch);
    const pending = f.manager.prepareRequest(f.provider(), '/models', {}); const failed = expect(pending).rejects.toThrow('取消');
    f.manager.dispose(); await failed; expect(() => f.manager.linkAccount(source.id, ACCOUNT)).toThrow('关闭');
    held.resolve(reply({ token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000 }));
  });
  it.each([401, 403, 429, 500, 302])('does not expose error bodies or credentials for HTTP %s', async status => {
    const f = fixture((async () => reply({ error: GITHUB_TOKEN, token: COPILOT_TOKEN }, status)) as typeof fetch);
    let message = ''; try { await f.manager.prepareRequest(f.provider(), '/models', {}); } catch (error) { message = String(error); }
    expect(message).not.toContain(GITHUB_TOKEN); expect(message).not.toContain(COPILOT_TOKEN); expect(message).toBeTruthy(); f.manager.dispose();
  });
  it('never trusts the message of an arbitrary transport exception', async () => {
    const f = fixture((async () => { throw new Error(`Copilot ${GITHUB_TOKEN}`); }) as typeof fetch);
    await expect(f.manager.prepareRequest(f.provider(), '/models', {})).rejects.toThrow('无法换取'); f.manager.dispose();
  });
  it.each([{ token: 'bad token', expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000 }, { token: COPILOT_TOKEN, expires_at: 1 },
    { token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000, endpoints: { api: 'https://api.githubcopilot.com.attacker.test' } },
    { token: COPILOT_TOKEN, expires_at: Date.parse('2026-10-07T00:30:00Z') / 1000, endpoints: { api: 'https://api.githubcopilot.com/responses' } }])('rejects invalid token contracts and malicious returned hosts', async payload => {
    const f = fixture((async () => reply(payload)) as typeof fetch);
    await expect(f.manager.prepareRequest(f.provider(), '/models', {})).rejects.toThrow(); f.manager.dispose();
  });
  it('preserves a source login context and restores previous state on cancellation', async () => {
    const f = fixture(); const progress = await f.manager.beginLogin(source.id);
    expect(progress.providerId).toBe(source.id); expect(f.provider().authStatus).toBe('signing-in');
    f.manager.cancel('other-source'); expect(f.accounts.progress()?.state).toBe('pending');
    f.manager.cancel(source.id); expect(f.accounts.progress()?.state).toBe('cancelled'); expect(f.provider().authStatus).toBe('ready'); f.manager.dispose();
  });
});

describe('existing managed GitHub login as a global subscription source', () => {
  it('binds only the source reference after official device authorization and keeps renderer account views safe', async () => {
    const store = new MemoryStore(); let clock = Date.parse('2026-10-07T00:00:00Z'); let manager!: CopilotProviderManager;
    const auth = new CopilotAuthCenter(store, { now: () => clock, openExternal: async () => {}, delay: async ms => { clock += ms; },
      onAuthorized: (accountId, providerId) => { if (providerId) manager.linkAccount(providerId, accountId); },
      fetch: (async url => {
        const target = String(url);
        if (target.endsWith('/login/device/code')) return reply({ device_code: 'SYNTHETIC_DEVICE_CODE', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 });
        if (target.endsWith('/login/oauth/access_token')) return reply({ access_token: GITHUB_TOKEN });
        if (target === 'https://api.github.com/user') return reply({ id: 42, login: 'source-demo' });
        if (target.endsWith('/copilot_internal/user')) return reply({ copilot_plan: 'individual' });
        throw new Error('Unexpected fixture URL');
      }) as typeof fetch });
    manager = new CopilotProviderManager(store, auth, { fetch: (async () => { throw new Error('Token exchange must be explicit'); }) as typeof fetch });
    await manager.beginLogin(source.id); await vi.waitFor(() => expect(manager.progress(source.id)?.state).toBe('complete'));
    expect(store.getSecret(source.id)).toEqual({ copilotAccountId: ACCOUNT }); expect(store.getProvider(source.id)?.authStatus).toBe('ready');
    expect(auth.getInferenceAuthorization(ACCOUNT).accessToken).toBe(GITHUB_TOKEN);
    expect(JSON.stringify(auth.listAccounts())).not.toMatch(/accessToken|SYNTHETIC_PRIVATE/);
    auth.logout(ACCOUNT); manager.unlinkAccount(ACCOUNT);
    expect(() => auth.getInferenceAuthorization(ACCOUNT)).toThrow('不存在'); expect(store.getProvider(source.id)?.authStatus).toBe('missing');
    manager.dispose(); auth.dispose();
  });
});
