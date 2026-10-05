import { describe, expect, it, vi, afterEach } from 'vitest';
import { CopilotAuthCenter, isCopilotAccountId, parseCopilotUsage, type CopilotAuthStore } from '../src/main/copilot-auth';

const TOKEN = 'SYNTHETIC_COPILOT_PRIVATE_TOKEN';
const DEVICE = 'SYNTHETIC_PRIVATE_DEVICE_CODE';
const RESET = '2026-11-01T00:00:00.000Z';
const legacyQuota = { copilot_plan: 'individual', quota_reset_date: '2026-11-01', quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 180, percent_remaining: 60, unlimited: false } } };
const creditQuota = { copilot_plan: 'individual_pro', token_based_billing: true, quota_reset_date_utc: RESET, quota_snapshots: { premium_interactions: { entitlement: '1000', quota_remaining: '820', credits_used: '180', percent_remaining: 82, unlimited: false, has_quota: false } } };
const reply = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res; }); return { promise, resolve }; }
class MemoryStore implements CopilotAuthStore {
  ciphertext = new Map<string, string>();
  failWrite = false;
  getManagedState<T>(key: string, fallback: T): T { const value = this.ciphertext.get(key); return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : structuredClone(fallback); }
  setManagedState(key: string, value: unknown) { if (this.failWrite) throw new Error(TOKEN); this.ciphertext.set(key, Buffer.from(JSON.stringify(value)).toString('base64')); }
}
type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
function fixture(options: { quota?: unknown; handler?: Handler; pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>; device?: unknown; user?: unknown; token?: unknown; openFails?: boolean } = {}) {
  const store = new MemoryStore(), opened: string[] = [], delays: number[] = [];
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    if (options.handler) return options.handler(target, init);
    if (target.endsWith('/login/device/code')) return reply(options.device ?? { device_code: DEVICE, user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    if (target.endsWith('/login/oauth/access_token')) return reply(options.token ?? { access_token: TOKEN, token_type: 'bearer' });
    if (target.endsWith('/user') && !target.includes('copilot_internal')) return reply(options.user ?? { id: 42, login: 'copilot-demo', name: 'Copilot Demo', email: 'copilot@example.test' });
    if (target.endsWith('/copilot_internal/user')) return reply(options.quota ?? legacyQuota);
    throw new Error('Unexpected test URL');
  });
  const service = new CopilotAuthCenter(store, {
    fetch: fetcher as typeof fetch, now: () => clock,
    openExternal: async url => { opened.push(url); if (options.openFails) throw new Error(TOKEN); },
    delay: options.pause ?? (async milliseconds => { delays.push(milliseconds); clock += milliseconds; }),
  });
  return { store, service, fetcher, opened, delays, advance: (milliseconds: number) => { clock += milliseconds; } };
}
async function loggedIn(f: ReturnType<typeof fixture>) {
  await f.service.beginLogin();
  await vi.waitFor(() => expect(f.service.progress()?.state).toBe('complete'));
  await vi.waitFor(() => expect(f.service.listAccounts()[0]?.usage.status).not.toBe('not-queried'));
  return f.service.listAccounts()[0];
}
afterEach(() => { vi.useRealTimers(); });

describe('Copilot quota response protocol', () => {
  it('shows measured legacy premium requests and actual reset dates', () => {
    expect(parseCopilotUsage(legacyQuota)).toEqual([{ id: 'premium_interactions', label: '高级请求', usedPercent: 40, remainingPercent: 60, resetAt: RESET, total: 300, remaining: 180, unit: '次', unlimited: false }]);
  });
  it('supports current AI Credits counters as decimal strings without treating has_quota false as zero', () => {
    expect(parseCopilotUsage(creditQuota)[0]).toMatchObject({ label: 'AI Credits', total: 1000, remaining: 820, remainingPercent: 82, usedPercent: 18, unit: 'credits' });
  });
  it('prefers each snapshot reset over the coarse account reset', () => {
    const quota = structuredClone(creditQuota) as any; quota.quota_snapshots.premium_interactions.quota_reset_at = Date.parse('2026-10-08T12:00:00Z') / 1000;
    expect(parseCopilotUsage(quota)[0].resetAt).toBe('2026-10-08T12:00:00.000Z');
  });
  it('does not invent a reset date, weekly window or 100% from missing data', () => {
    expect(parseCopilotUsage({ copilot_plan: 'individual', quota_reset_date: RESET })).toEqual([]);
    const snapshot = parseCopilotUsage({ quota_snapshots: { premium_interactions: { remaining: 12 } } })[0];
    expect(snapshot.remaining).toBe(12); expect(snapshot.remainingPercent).toBeUndefined(); expect(snapshot.resetAt).toBeUndefined(); expect(snapshot.windowSeconds).toBeUndefined();
  });
  it('derives percentages only from complete valid measured counts', () => {
    const snapshots = { premium_interactions: { entitlement: 300, remaining: 120 } };
    expect(parseCopilotUsage({ quota_snapshots: snapshots })[0].remainingPercent).toBe(40);
    expect(parseCopilotUsage({ quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0 } } })).toEqual([]);
    expect(parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: NaN, remaining: -1, entitlement: Infinity } } })).toEqual([]);
  });
  it('does not give unlimited organization pools a fabricated percentage', () => {
    const quota = { ...creditQuota, quota_snapshots: { premium_interactions: { unlimited: true, has_quota: false, percent_remaining: 100 } } };
    const window = parseCopilotUsage(quota)[0];
    expect(window.unlimited).toBe(true); expect(window.remainingPercent).toBeUndefined(); expect(window.usedPercent).toBeUndefined(); expect(window.total).toBeUndefined();
  });
  it('supports free legacy chat and completions and drops unsupported counters', () => {
    const windows = parseCopilotUsage({ monthly_quotas: { chat: 50, completions: 2000 }, limited_user_quotas: { chat: 25, completions: 1500 } });
    expect(windows.map(window => [window.label, window.remainingPercent])).toEqual([['聊天', 50], ['代码补全', 75]]);
    expect(parseCopilotUsage({ quota_snapshots: { premium_interactions: { entitlement: 'secret', remaining: false, percent_remaining: 101 } } })).toEqual([]);
  });
});

describe('managed GitHub Copilot device login and encrypted account state', () => {
  it('keeps a safe public GitHub avatar from login metadata without an extra user request', async () => {
    const f = fixture({ user: { id: 42, login: 'copilot-demo', name: 'Avatar User', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' } });
    const account = await loggedIn(f); expect(account.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42?v=4');
    expect(f.fetcher.mock.calls.filter(call => String(call[0]) === 'https://api.github.com/user')).toHaveLength(1);
    expect(JSON.stringify(account)).not.toMatch(/accessToken|refreshToken/); f.service.dispose();
  });
  it('ignores unsafe avatar URLs without turning successful GitHub login into a failure', async () => {
    const f = fixture({ user: { id: 42, login: 'copilot-demo', avatar_url: `https://avatars.githubusercontent.com/u/42?access_token=${TOKEN}` } });
    const account = await loggedIn(f); expect(account.avatarUrl).toBeUndefined(); expect(account.authStatus).toBe('ready'); expect(f.service.progress()?.state).toBe('complete'); f.service.dispose();
  });
  it('uses official hosts with public client, stores privately and keeps constant progress identity', async () => {
    const f = fixture(), account = await loggedIn(f);
    expect(f.service.progress()).toMatchObject({ providerId: 'copilot:login', state: 'complete' });
    expect(account).toMatchObject({ providerId: 'copilot:42', kind: 'copilot', accountId: '42', email: 'copilot@example.test', plan: 'individual', canRefresh: false });
    expect(account.usage).toMatchObject({ status: 'ready', resetCreditsStatus: 'not-supported' });
    expect(account.usage.resetCredits).toBeUndefined();
    expect(f.opened).toEqual(['https://github.com/login/device']);
    const device = new URLSearchParams(String(f.fetcher.mock.calls[0][1]?.body));
    expect(device.get('client_id')).toBe('Iv1.b507a08c87ecfe98'); expect(device.get('scope')).toBe('read:user');
    const poll = new URLSearchParams(String(f.fetcher.mock.calls[1][1]?.body));
    expect(poll.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    const quotaInit = f.fetcher.mock.calls.find(call => String(call[0]).includes('copilot_internal'))?.[1];
    expect(new Headers(quotaInit?.headers).get('Authorization')).toBe(`token ${TOKEN}`);
    expect(f.fetcher.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
    expect([...f.store.ciphertext.values()].join()).not.toContain(TOKEN);
    expect(JSON.stringify({ account, progress: f.service.progress(), list: f.service.listAccounts() })).not.toMatch(new RegExp(`${TOKEN}|${DEVICE}|accessToken|refreshToken`));
    f.service.dispose();
  });
  it('replaces the same GitHub account once while retaining distinct accounts', async () => {
    const f = fixture(); await loggedIn(f); await loggedIn(f);
    expect(f.service.listAccounts()).toHaveLength(1);
    const original = f.store.getManagedState<any>('copilot-auth:v1', null); original.accounts.push({ ...original.accounts[0], id: 'copilot:43', login: 'second-user' }); f.store.setManagedState('copilot-auth:v1', original);
    await loggedIn(f); expect(f.service.listAccounts().map(account => account.providerId).sort()).toEqual(['copilot:42', 'copilot:43']);
    f.service.logout('copilot:42'); expect(f.service.listAccounts().map(account => account.providerId)).toEqual(['copilot:43']);
    f.service.dispose();
  });
  it('opens no upstream supplied verification hosts or redirect URLs', async () => {
    for (const verification_uri of ['https://evil.example/login/device', 'https://github.com@login.evil.example/device', 'https://github.com/login/device?return_to=https://evil.example', 'http://github.com/login/device']) {
      const f = fixture({ device: { device_code: DEVICE, user_code: 'ABCD-1234', verification_uri, expires_in: 900, interval: 1 } });
      expect(await f.service.beginLogin()).toMatchObject({ state: 'error', category: 'invalid-response' }); expect(f.opened).toEqual([]); expect(f.service.listAccounts()).toEqual([]);
    }
  });
  it('keeps manual browser fallback usable without exposing browser error details', async () => {
    const hold = deferred<void>(), f = fixture({ openFails: true, pause: async () => hold.promise });
    const progress = await f.service.beginLogin(); expect(progress.message).toContain('手动打开'); expect(JSON.stringify(progress)).not.toContain(TOKEN);
    f.service.cancel(); hold.resolve(); expect(f.service.progress()?.state).toBe('cancelled');
  });
  it('rejects invalid and unsafe GitHub account IDs', async () => {
    for (const id of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1, 'not-an-id']) {
      const f = fixture({ user: { id, login: 'copilot-demo' } }); await f.service.beginLogin();
      await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error')); expect(f.service.listAccounts()).toEqual([]);
    }
    expect(isCopilotAccountId('copilot:42')).toBe(true); expect(isCopilotAccountId('copilot:login')).toBe(false); expect(isCopilotAccountId('copilot:0')).toBe(false);
  });
  it('does not save an account when storage fails, and redacts the error', async () => {
    const f = fixture(); f.store.failWrite = true; await f.service.beginLogin();
    await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error'));
    expect(f.service.progress()?.message).toContain('加密配置保存失败'); expect(JSON.stringify(f.service.progress())).not.toContain(TOKEN); expect(f.service.listAccounts()).toEqual([]);
  });
  it('waits the minimum polling interval and honours slow_down', async () => {
    const f = fixture(); let calls = 0;
    const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init = {}) => String(url).endsWith('/login/oauth/access_token') && calls++ < 2 ? reply({ error: calls === 1 ? 'slow_down' : 'authorization_pending', interval: 8 }) : base(url, init));
    await loggedIn(f); expect(f.delays.slice(0, 3)).toEqual([1000, 8000, 8000]); f.service.dispose();
  });
  it('continues HTTP 400 authorization_pending and slow_down until GitHub grants the token', async () => {
    const f = fixture(); let polls = 0; const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init = {}) => {
      if (String(url) === 'https://github.com/login/oauth/access_token') {
        polls++;
        if (polls === 1) return reply({ error: 'authorization_pending', error_description: TOKEN }, 400);
        if (polls === 2) return reply({ error: 'slow_down', interval: 8, error_description: TOKEN }, 400);
      }
      return base(url, init);
    });
    const account = await loggedIn(f);
    expect(f.delays.slice(0, 3)).toEqual([1000, 1000, 8000]); expect(polls).toBe(3);
    expect(account.providerId).toBe('copilot:42'); expect(f.service.progress()).toMatchObject({ providerId: 'copilot:login', state: 'complete' });
    expect(JSON.stringify({ account, progress: f.service.progress() })).not.toContain(TOKEN); f.service.dispose();
  });
  it('uses a supported public REST version for user discovery and keeps Copilot quota headers separate', async () => {
    const f = fixture(), base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init = {}) => {
      if (String(url) === 'https://api.github.com/user' && new Headers(init.headers).get('X-GitHub-Api-Version') !== '2022-11-28') return reply({ message: 'Not a supported version' }, 400);
      return base(url, init);
    });
    const account = await loggedIn(f); expect(account.providerId).toBe('copilot:42');
    const user = new Headers(f.fetcher.mock.calls.find(call => String(call[0]) === 'https://api.github.com/user')?.[1]?.headers);
    expect(user.get('X-GitHub-Api-Version')).toBe('2022-11-28'); expect(user.get('Editor-Version')).toBeNull(); expect(user.get('Editor-Plugin-Version')).toBeNull();
    const quota = new Headers(f.fetcher.mock.calls.find(call => String(call[0]) === 'https://api.github.com/copilot_internal/user')?.[1]?.headers);
    expect(quota.get('X-GitHub-Api-Version')).toBe('2025-10-01'); expect(quota.get('Editor-Version')).toBe('vscode/1.110.1');
    f.service.dispose();
  });
  it('maps known terminal HTTP 400 device errors without exposing upstream descriptions', async () => {
    for (const [error, category] of [['expired_token', 'expired'], ['access_denied', 'denied'], ['device_flow_disabled', 'device-disabled'], ['incorrect_device_code', 'expired'], ['invalid_device_code', 'expired'], ['incorrect_client_credentials', 'upstream'], ['unsupported_grant_type', 'invalid-response'], ['invalid_scope', 'invalid-response']]) {
      const f = fixture(), base = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://github.com/login/oauth/access_token' ? reply({ error, error_description: TOKEN, error_uri: `https://example.invalid/${DEVICE}` }, 400) : base(url, init));
      await f.service.beginLogin(); await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error'));
      expect(f.service.progress()).toMatchObject({ providerId: 'copilot:login', category, statusCode: 400 });
      expect(f.service.listAccounts()).toEqual([]); expect(JSON.stringify(f.service.progress())).not.toMatch(new RegExp(`${TOKEN}|${DEVICE}|example.invalid`));
      expect(f.fetcher.mock.calls.filter(call => String(call[0]) === 'https://github.com/login/oauth/access_token')).toHaveLength(1);
    }
  });
  it('rejects HTML, malformed, unknown and contradictory HTTP 400 bodies instead of waiting', async () => {
    const invalid = [
      () => new Response(`<html>${TOKEN}</html>`, { status: 400, headers: { 'Content-Type': 'text/html' } }),
      () => new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400, headers: { 'Content-Type': 'text/html' } }),
      () => new Response(`{"error":"authorization_pending",${TOKEN}`, { status: 400, headers: { 'Content-Type': 'application/json' } }),
      () => reply({ error: 'unknown_provider_error', error_description: TOKEN }, 400),
      () => reply({ error: { code: 'authorization_pending' } }, 400),
      () => reply({ access_token: TOKEN }, 400),
      () => reply({ error: 'authorization_pending', access_token: TOKEN }, 400),
    ];
    for (const response of invalid) {
      const f = fixture(), base = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://github.com/login/oauth/access_token' ? response() : base(url, init));
      await f.service.beginLogin(); await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error'));
      expect(f.service.progress()).toMatchObject({ category: 'invalid-response', statusCode: 400 }); expect(f.service.listAccounts()).toEqual([]);
      expect(f.fetcher.mock.calls.filter(call => String(call[0]) === 'https://github.com/login/oauth/access_token')).toHaveLength(1);
      expect(JSON.stringify(f.service.progress())).not.toContain(TOKEN);
    }
  });
  it('keeps non-token endpoints and non-400 token HTTP failures terminal even for pending-shaped JSON', async () => {
    for (const endpoint of ['https://github.com/login/device/code', 'https://api.github.com/user']) {
      const f = fixture(), base = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init = {}) => String(url) === endpoint ? reply({ error: 'authorization_pending', error_description: TOKEN }, 400) : base(url, init));
      await f.service.beginLogin(); await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error'));
      expect(f.service.progress()).toMatchObject({ statusCode: 400, stage: endpoint === 'https://api.github.com/user' ? 'account-info' : 'device-code' }); expect(f.service.listAccounts()).toEqual([]); expect(JSON.stringify(f.service.progress())).not.toContain(TOKEN);
    }
    const quota = fixture(); await loggedIn(quota); quota.fetcher.mockResolvedValue(reply({ error: 'authorization_pending', error_description: TOKEN }, 400));
    expect((await quota.service.refreshUsage('copilot:42')).usage).toMatchObject({ status: 'stale' }); quota.service.dispose();
    for (const status of [401, 403, 429, 500]) {
      const f = fixture(), base = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://github.com/login/oauth/access_token' ? reply({ error: 'authorization_pending' }, status) : base(url, init));
      await f.service.beginLogin(); await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error'));
      expect(f.service.progress()?.statusCode).toBe(status); expect(f.fetcher.mock.calls.filter(call => String(call[0]) === 'https://github.com/login/oauth/access_token')).toHaveLength(1);
    }
  });
  it('cancels after an HTTP 400 pending response and ignores a late token response', async () => {
    const hold = deferred<Response>(), f = fixture(), base = f.fetcher.getMockImplementation()!; let polls = 0;
    f.fetcher.mockImplementation(async (url, init = {}) => {
      if (String(url) === 'https://github.com/login/oauth/access_token') return ++polls === 1 ? reply({ error: 'authorization_pending' }, 400) : hold.promise;
      return base(url, init);
    });
    await f.service.beginLogin(); await vi.waitFor(() => expect(polls).toBe(2)); expect(f.service.progress()?.state).toBe('pending');
    f.service.cancel(); hold.resolve(reply({ access_token: TOKEN })); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.service.progress()).toMatchObject({ providerId: 'copilot:login', state: 'cancelled' }); expect(f.service.listAccounts()).toEqual([]);
  });
  it('keeps device polling HTTP 400 body reads bounded and subject to the network deadline', async () => {
    const oversized = fixture(), base = oversized.fetcher.getMockImplementation()!;
    oversized.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://github.com/login/oauth/access_token' ? new Response('x'.repeat(512 * 1024 + 1), { status: 400, headers: { 'Content-Type': 'application/json' } }) : base(url, init));
    await oversized.service.beginLogin(); await vi.waitFor(() => expect(oversized.service.progress()?.state).toBe('error'));
    expect(oversized.service.progress()?.message).toContain('响应过大'); expect(oversized.service.listAccounts()).toEqual([]);
    const stalled = fixture(), normal = stalled.fetcher.getMockImplementation()!, cancelled = vi.fn();
    stalled.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://github.com/login/oauth/access_token' ? new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { status: 400, headers: { 'Content-Type': 'application/json' } }) : normal(url, init));
    vi.useFakeTimers(); await stalled.service.beginLogin(); await vi.advanceTimersByTimeAsync(15_001);
    expect(cancelled).toHaveBeenCalled(); expect(stalled.service.progress()).toMatchObject({ state: 'error', category: 'network' }); expect(stalled.service.progress()?.message).toContain('超时'); stalled.service.dispose();
  });
  it('reports denied and expired device authorization without using raw descriptions', async () => {
    for (const [error, category] of [['access_denied', 'denied'], ['expired_token', 'expired'], ['device_flow_disabled', 'device-disabled']]) {
      const f = fixture({ token: { error, error_description: TOKEN } }); await f.service.beginLogin();
      await vi.waitFor(() => expect(f.service.progress()?.state).toBe('error')); expect(f.service.progress()?.category).toBe(category); expect(JSON.stringify(f.service.progress())).not.toContain(TOKEN);
    }
  });
  it('cancels while requesting a device code and ignores a late response', async () => {
    const late = deferred<Response>(), f = fixture({ handler: async () => late.promise });
    const started = f.service.beginLogin(); f.service.cancel();
    late.resolve(reply({ device_code: DEVICE, user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }));
    expect(await started).toMatchObject({ providerId: 'copilot:login', state: 'cancelled' }); expect(f.opened).toEqual([]); expect(f.service.listAccounts()).toEqual([]);
  });
  it('cancels a pending delay and does not poll or recreate the account', async () => {
    const hold = deferred<void>(), f = fixture({ pause: async () => hold.promise }); await f.service.beginLogin(); f.service.cancel(); hold.resolve();
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.service.listAccounts()).toEqual([]); expect(f.service.progress()?.state).toBe('cancelled');
  });
  it('prevents logout during a late reauthentication from resurrecting the removed account', async () => {
    const f = fixture(); await loggedIn(f); const lateUser = deferred<Response>(), base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://api.github.com/user' ? lateUser.promise : base(url, init));
    await f.service.beginLogin(); await vi.waitFor(() => expect(f.service.progress()?.stage).toBe('account-info'));
    f.service.logout('copilot:42'); lateUser.resolve(reply({ id: 42, login: 'copilot-demo' }));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.service.listAccounts()).toEqual([]); expect(f.service.progress()?.state).toBe('cancelled');
  });
});

describe('Copilot quota refresh preserves verification boundaries', () => {
  it('backfills an older account avatar once during quota refresh without requiring login', async () => {
    const f = fixture({ user: { id: 42, login: 'copilot-demo', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' } }); await loggedIn(f);
    const state = f.store.getManagedState<any>('copilot-auth:v1', null); delete state.accounts[0].avatarUrl; delete state.accounts[0].avatarCheckedAt; f.store.setManagedState('copilot-auth:v1', state);
    const initial = f.fetcher.mock.calls.filter(call => String(call[0]) === 'https://api.github.com/user').length;
    expect((await f.service.refreshUsage('copilot:42')).avatarUrl).toBe('https://avatars.githubusercontent.com/u/42?v=4');
    await f.service.refreshUsage('copilot:42'); expect(f.fetcher.mock.calls.filter(call => String(call[0]) === 'https://api.github.com/user')).toHaveLength(initial + 1);
    expect(f.service.listAccounts()).toHaveLength(1); f.service.dispose();
  });
  it('keeps existing quota and account metadata when avatar lookup fails or returns another identity', async () => {
    for (const response of [() => reply({ message: TOKEN }, 401), () => reply({ id: 43, login: 'other-user', avatar_url: 'https://avatars.githubusercontent.com/u/43?v=4' })]) {
      const f = fixture(); const before = await loggedIn(f), state = f.store.getManagedState<any>('copilot-auth:v1', null); delete state.accounts[0].avatarCheckedAt; f.store.setManagedState('copilot-auth:v1', state);
      const base = f.fetcher.getMockImplementation()!; f.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://api.github.com/user' ? response() : base(url, init));
      const account = await f.service.refreshUsage('copilot:42'); expect(account).toMatchObject({ providerId: before.providerId, displayName: before.displayName, email: before.email, authStatus: 'ready', usage: { status: 'ready' } }); expect(account.avatarUrl).toBeUndefined(); expect(JSON.stringify(account)).not.toContain(TOKEN); f.service.dispose();
    }
  });
  it('does not recreate a logged out account when an older avatar response arrives', async () => {
    const f = fixture(); await loggedIn(f); const state = f.store.getManagedState<any>('copilot-auth:v1', null); delete state.accounts[0].avatarCheckedAt; f.store.setManagedState('copilot-auth:v1', state);
    const held = deferred<Response>(), base = f.fetcher.getMockImplementation()!; let profiles = 0;
    f.fetcher.mockImplementation(async (url, init = {}) => String(url) === 'https://api.github.com/user' ? (profiles++, held.promise) : base(url, init));
    const refresh = f.service.refreshUsage('copilot:42'), rejected = expect(refresh).rejects.toThrow('取消'); await vi.waitFor(() => expect(profiles).toBe(1));
    f.service.logout('copilot:42'); held.resolve(reply({ id: 42, login: 'copilot-demo', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' })); await rejected; expect(f.service.listAccounts()).toEqual([]);
  });
  it('does not overwrite a reauthenticated account avatar with a late old query', async () => {
    const f = fixture(); await loggedIn(f); const state = f.store.getManagedState<any>('copilot-auth:v1', null); delete state.accounts[0].avatarCheckedAt; f.store.setManagedState('copilot-auth:v1', state);
    const held = deferred<Response>(), base = f.fetcher.getMockImplementation()!; let profiles = 0;
    f.fetcher.mockImplementation(async (url, init = {}) => {
      if (String(url) === 'https://api.github.com/user') return ++profiles === 1 ? held.promise : reply({ id: 42, login: 'copilot-demo', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=5' });
      return base(url, init);
    });
    const refresh = f.service.refreshUsage('copilot:42'), rejected = expect(refresh).rejects.toThrow('取消'); await vi.waitFor(() => expect(profiles).toBe(1));
    await loggedIn(f); held.resolve(reply({ id: 42, login: 'copilot-demo', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4' })); await rejected;
    expect(f.service.listAccounts()[0].avatarUrl).toBe('https://avatars.githubusercontent.com/u/42?v=5'); f.service.dispose();
  });
  it('coalesces in-flight reads and rejects late usage after logout', async () => {
    const f = fixture(); await loggedIn(f); const late = deferred<Response>();
    f.fetcher.mockImplementation(async () => late.promise);
    const first = f.service.refreshUsage('copilot:42'), second = f.service.refreshUsage('copilot:42'); expect(first).toBe(second);
    const rejected = expect(first).rejects.toThrow('取消'); f.service.logout('copilot:42'); late.resolve(reply(creditQuota)); await rejected; expect(f.service.listAccounts()).toEqual([]);
  });
  it('shows cached measurements as stale on network failures without leaking credentials', async () => {
    const f = fixture(); await loggedIn(f); const original = f.service.listAccounts()[0].usage;
    f.fetcher.mockRejectedValue(new Error(`unsafe-request ${TOKEN}`));
    const account = await f.service.refreshUsage('copilot:42'); expect(account.usage.status).toBe('stale'); expect(account.usage.windows).toEqual(original.windows); expect(account.usage.queriedAt).toBe(original.queriedAt); expect(JSON.stringify(account)).not.toContain(TOKEN);
  });
  it('distinguishes invalid OAuth from missing subscription or organization permissions', async () => {
    const f = fixture(); await loggedIn(f);
    f.fetcher.mockResolvedValue(reply({ message: TOKEN }, 403)); const denied = await f.service.refreshUsage('copilot:42'); expect(denied.authStatus).toBe('ready'); expect(denied.usage.message).toContain('订阅或组织权限');
    f.fetcher.mockResolvedValue(reply({ message: TOKEN }, 401)); const expired = await f.service.refreshUsage('copilot:42'); expect(expired.authStatus).toBe('expired'); expect(expired.canRefresh).toBe(false); expect(expired.usage.message).toContain('重新登录'); expect(JSON.stringify(expired)).not.toContain(TOKEN);
  });
  it('retains unknown quota as unavailable and does not invent reset credits', async () => {
    const f = fixture({ quota: { copilot_plan: 'individual' } }); const account = await loggedIn(f);
    expect(account.usage).toMatchObject({ status: 'unavailable', windows: [], resetCreditsStatus: 'not-supported' }); expect(account.usage.resetCredits).toBeUndefined(); f.service.dispose();
  });
  it('marks known expired credentials expired without claiming automatic renewal', async () => {
    const f = fixture({ token: { access_token: TOKEN, expires_in: 60, refresh_token: 'SYNTHETIC_REFRESH_SECRET' } }); await loggedIn(f); f.advance(61_000);
    expect(f.service.listAccounts()[0]).toMatchObject({ authStatus: 'expired', canRefresh: false }); const before = f.fetcher.mock.calls.length;
    const account = await f.service.refreshUsage('copilot:42'); expect(account.authStatus).toBe('expired'); expect(f.fetcher.mock.calls).toHaveLength(before); expect(JSON.stringify(f.service.listAccounts())).not.toContain('SYNTHETIC_REFRESH_SECRET');
  });
  it('limits response sizes and redacts malformed or raw error bodies', async () => {
    const f = fixture(); await loggedIn(f);
    f.fetcher.mockResolvedValue(new Response(TOKEN, { headers: { 'Content-Length': String(1024 * 1024) } }));
    expect((await f.service.refreshUsage('copilot:42')).usage.message).toContain('响应过大');
    f.fetcher.mockResolvedValue(new Response(TOKEN)); const malformed = await f.service.refreshUsage('copilot:42'); expect(malformed.usage.message).toContain('无法识别'); expect(JSON.stringify(malformed)).not.toContain(TOKEN);
    f.fetcher.mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1))); expect((await f.service.refreshUsage('copilot:42')).usage.message).toContain('响应过大');
  });
  it('keeps a network deadline active through stalled body consumption', async () => {
    const f = fixture(); await loggedIn(f); vi.useFakeTimers();
    const cancelled = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    f.fetcher.mockResolvedValue(new Response(stream)); const pending = f.service.refreshUsage('copilot:42');
    await vi.advanceTimersByTimeAsync(15_001); const result = await pending;
    expect(cancelled).toHaveBeenCalled(); expect(result.usage.status).toBe('stale'); expect(result.usage.message).toContain('超时'); f.service.dispose();
  });
  it('does not issue login or quota requests after disposal', async () => {
    const f = fixture(); f.service.dispose(); await expect(f.service.beginLogin()).rejects.toThrow('已关闭'); await expect(f.service.refreshUsage('copilot:42')).rejects.toThrow('已关闭'); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
