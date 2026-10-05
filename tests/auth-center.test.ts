import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthCenter, parseCodexUsage, parseGrokUsage, type AuthCenterStore } from '../src/main/auth-center';
import type { Provider, ProviderInput, ProviderSecret } from '../src/shared/types';
import { OAuthManager, prepareUpstream } from '../src/main/oauth';

const jwt = (body: object) => `header.${Buffer.from(JSON.stringify(body)).toString('base64url')}.signature`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const codex: Provider = { id: 'codex', name: 'Codex 本人', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
const grok: Provider = { ...codex, id: 'grok', name: 'Grok 本人', kind: 'grok', baseUrl: 'https://cli-chat-proxy.grok.com/v1' };
class MemoryStore implements AuthCenterStore {
  providers = new Map<string, Provider>([codex, grok].map(p => [p.id, { ...p }]));
  secrets = new Map<string, ProviderSecret>([['codex', { accessToken: 'PRIVATE_ACCESS', refreshToken: 'PRIVATE_REFRESH', accountId: 'account-codex' }], ['grok', { accessToken: 'PRIVATE_GROK' }]]);
  state = new Map<string, unknown>();
  listProviders() { return [...this.providers.values()]; }
  getProvider(id: string) { return this.providers.get(id); }
  saveProvider(input: ProviderInput): Provider { const p = { ...input, id: input.id ?? randomUUID(), hasSecret: false, authStatus: 'missing' as const, note: input.note ?? '' }; this.providers.set(p.id, p); return p; }
  deleteProvider(id: string) { this.providers.delete(id); this.secrets.delete(id); }
  getSecret(id: string) { const value = this.secrets.get(id); return value ? { ...value } : undefined; }
  setSecret(id: string, secret: ProviderSecret) { if (secret.accessToken || secret.refreshToken || secret.apiKey) this.secrets.set(id, { ...secret }); else this.secrets.delete(id); const p = this.providers.get(id)!; p.authStatus = this.secrets.has(id) ? 'ready' : 'missing'; p.hasSecret = this.secrets.has(id); }
  setAuthStatus(id: string, status: Provider['authStatus']) { this.providers.get(id)!.authStatus = status; }
  getManagedState<T>(key: string, fallback: T): T { return structuredClone(this.state.has(key) ? this.state.get(key) as T : fallback); }
  setManagedState(key: string, value: unknown) { this.state.set(key, structuredClone(value)); }
}
const oauthFor = (store: MemoryStore) => ({ cancel: vi.fn(), prepareRequest: vi.fn(async (provider: Provider, path: string, body: Record<string, unknown>) => prepareUpstream(provider, store.getSecret(provider.id) ?? {}, path, body)) });
const dirs: string[] = [];
const managers: OAuthManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function varint(value: number): number[] { const bytes: number[] = []; do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value); return bytes; }
function message(field: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> { return Uint8Array.from([...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]); }
function percentField(percent: number): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(5); bytes[0] = 13; new DataView(bytes.buffer).setFloat32(1, percent, true); return bytes; }
function grpcFrame(payload: Uint8Array, flags = 0): Uint8Array<ArrayBuffer> { const frame = new Uint8Array(payload.length + 5); frame[0] = flags; new DataView(frame.buffer).setUint32(1, payload.length, false); frame.set(payload, 5); return frame; }
function grokPayload(percent?: number, reset?: number, period = false): Uint8Array<ArrayBuffer> {
  const parts: number[] = percent === undefined ? [] : [...percentField(percent)];
  if (reset) parts.push(...message(5, Uint8Array.from([8, ...varint(reset)])));
  if (period) parts.push(...message(6, Uint8Array.of(8, 3)));
  return grpcFrame(message(1, Uint8Array.from(parts)));
}

describe('authorization center quota protocols and safe account views', () => {
  it('reads optional public pictures from existing ID/access token claims without a profile request', () => {
    const store = new MemoryStore();
    store.setSecret('codex', { accessToken: jwt({ sub: 'codex-id' }), idToken: jwt({ name: 'Codex Profile', picture: 'https://avatars.githubusercontent.com/u/42?v=4' }) });
    store.setSecret('grok', { accessToken: jwt({ sub: 'grok-id', profile: { avatar_url: 'https://pbs.twimg.com/profile_images/123/photo_normal.jpg' } }) });
    const fetcher = vi.fn(), oauth = oauthFor(store), center = new AuthCenter(store, oauth, { fetch: fetcher });
    expect(center.listAccounts().find(account => account.kind === 'codex')?.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42?v=4');
    expect(center.listAccounts().find(account => account.kind === 'grok')?.avatarUrl).toBe('https://pbs.twimg.com/profile_images/123/photo_normal.jpg');
    expect(fetcher).not.toHaveBeenCalled(); expect(oauth.prepareRequest).not.toHaveBeenCalled();
  });
  it('omits unsafe and missing profile pictures while preserving the existing identity', () => {
    const store = new MemoryStore();
    store.setSecret('codex', { accessToken: jwt({ name: 'Existing User', picture: 'https://avatars.githubusercontent.com/u/42?access_token=PRIVATE_AVATAR_TOKEN', 'https://api.openai.com/profile': { avatar_url: 'https://cdn.auth0.com/avatars/cc.png' } }) });
    store.setSecret('grok', { accessToken: jwt({ name: 'No Picture', picture: 'https://evil.example/PRIVATE_PROFILE.png' }) });
    const accounts = new AuthCenter(store, oauthFor(store)).listAccounts();
    expect(accounts[0]).toMatchObject({ displayName: 'Existing User', avatarUrl: 'https://cdn.auth0.com/avatars/cc.png' });
    expect(accounts[1]).toMatchObject({ displayName: 'No Picture' }); expect(accounts[1].avatarUrl).toBeUndefined();
    expect(JSON.stringify(accounts)).not.toMatch(/PRIVATE_AVATAR_TOKEN|PRIVATE_PROFILE/);
  });
  it('lists subscription accounts without tokens and reflects expiry and refreshability', () => {
    const store = new MemoryStore();
    store.setSecret('codex', { accessToken: jwt({ email: 'example@example.test', exp: Date.now() / 1000 - 10 }), refreshToken: 'PRIVATE_REFRESH', accountId: 'account-codex', expiresAt: Date.now() - 10 });
    store.setSecret('grok', { accessToken: 'PRIVATE_GROK', expiresAt: Date.now() - 10 });
    const center = new AuthCenter(store, oauthFor(store));
    const accounts = center.listAccounts();
    expect(accounts[0]).toMatchObject({ email: 'example@example.test', canRefresh: true, authStatus: 'ready' });
    expect(accounts[1]).toMatchObject({ canRefresh: false, authStatus: 'expired' });
    expect(accounts[0].usage.windows).toEqual([]);
    expect(JSON.stringify(accounts)).not.toMatch(/PRIVATE|accessToken|refreshToken|tokenEndpoint/);
  });

  it('shows ID-token profile metadata saved by an actual OAuth login without exposing tokens or confusing user subject with workspace', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore(); store.setSecret('codex', {});
    const accessToken = jwt({ sub: 'access-user', exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-codex' } });
    const idToken = jwt({ sub: 'stable-id-user', email: 'id-profile@example.test', name: 'ID Token Profile', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-codex', chatgpt_plan_type: 'plus' } });
    const oauth = new OAuthManager(store, { openExternal: async () => {}, fetch: (async url => String(url).endsWith('/usercode')
      ? json({ device_auth_id: 'synthetic-device', user_code: 'SYNTHETIC_CODE', interval: 1 })
      : String(url).endsWith('/deviceauth/token') ? json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' })
        : json({ access_token: accessToken, id_token: idToken, refresh_token: 'PRIVATE_LOGIN_REFRESH', expires_in: 3600 })) as typeof fetch }); managers.push(oauth);
    await oauth.beginLogin('codex'); await vi.advanceTimersByTimeAsync(0);
    expect(oauth.progress('codex')?.state).toBe('complete');
    expect(store.getSecret('codex')?.idToken).toBe(idToken);
    const account = new AuthCenter(store, oauth).listAccounts().find(value => value.providerId === 'codex');
    expect(account).toMatchObject({ accountId: 'workspace-codex', email: 'id-profile@example.test', displayName: 'ID Token Profile', plan: 'plus', authStatus: 'ready', canRefresh: true });
    expect(account?.accountId).not.toBe('stable-id-user');
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain(accessToken); expect(serialized).not.toContain(idToken); expect(serialized).not.toContain('PRIVATE_LOGIN_REFRESH');
    expect(serialized).not.toMatch(/accessToken|refreshToken|idToken|tokenEndpoint|access_token|refresh_token|id_token/);
  });

  it('queries only the fixed Codex usage domain, parses measured windows and filters reset credits', async () => {
    const store = new MemoryStore(), oauth = oauthFor(store);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer PRIVATE_ACCESS');
      expect(new Headers(init?.headers).get('ChatGPT-Account-Id')).toBe('account-codex');
      if (String(url).endsWith('reset-credits')) return json({ available_count: 99, credits: [{ status: 'available', expires_at: new Date(Date.now() + 86400_000).toISOString() }, { status: 'available', expires_at: '2020-01-01T00:00:00Z' }, { status: 'used' }, { status: 'available' }] });
      return json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: Date.now() / 1000 + 3600 }, secondary_window: { used_percent: 40, limit_window_seconds: 604800 } } });
    });
    const center = new AuthCenter(store, oauth, { fetch: fetcher as typeof fetch });
    const account = await center.refreshUsage('codex');
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits']);
    expect(oauth.prepareRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }), '/models', {});
    expect(account.usage.windows.map(w => [w.label, w.remainingPercent])).toEqual([['5 小时', 75], ['每周', 60]]);
    expect(account.usage.resetCredits?.available).toBe(2);
    expect(account.usage.resetCreditsStatus).toBe('ready');
    expect(JSON.stringify(account)).not.toContain('PRIVATE_ACCESS');
  });

  it('does not invent quota for absent/null/out of range Codex fields', () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: null }, secondary_window: { used_percent: -1 } } })).toEqual([]);
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 100.01 } } })).toEqual([]);
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0 } } })[0].remainingPercent).toBe(100);
  });

  it('includes independently metered Codex buckets and measured relative reset times', () => {
    const now = Date.parse('2026-10-07T00:00:00Z') / 1000;
    const windows = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 3600 } },
      additional_rate_limits: [
        { limit_name: 'Codex Spark', metered_feature: 'codex_spark', rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 0 } } },
        { limit_name: 'Invalid', rate_limit: { primary_window: { used_percent: '0' } } },
      ],
    }, now);
    expect(windows).toEqual([
      { id: 'primary_window', label: '每周', usedPercent: 0, remainingPercent: 100, resetAt: '2026-10-07T01:00:00.000Z', windowSeconds: 604800 },
      { id: 'additional-0:primary_window', label: 'Codex Spark · 5 小时', usedPercent: 100, remainingPercent: 0, resetAt: '2026-10-07T00:00:00.000Z', windowSeconds: 18000 },
    ]);
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: null } } }, now)[0].resetAt).toBeUndefined();
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: -1 } } }, now)[0].resetAt).toBeUndefined();
  });

  it('shows measured reset counts even when Codex quota fields are missing or unsupported', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('reset-credits') ? json({ credits: [{ status: 'available', expires_at: null }] }) : json({ rate_limit: null }));
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('codex');
    expect(account.usage).toMatchObject({ status: 'unavailable', windows: [], resetCreditsStatus: 'ready', resetCredits: { available: 1, expiresAt: [null] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps optional Codex reset queries independent of a quota HTTP failure', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('reset-credits') ? json({ credits: [] }) : json({ error: 'PRIVATE_FAILURE_BODY' }, 503));
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('codex');
    expect(account.usage).toMatchObject({ status: 'unavailable', windows: [], resetCreditsStatus: 'ready', resetCredits: { available: 0, expiresAt: [] } });
    expect(JSON.stringify(account)).not.toContain('PRIVATE_FAILURE_BODY');
  });

  it.each([0, 3])('uses official Codex usage reset summary %s if the detail endpoint fails, without inventing expiry entries', async count => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('reset-credits') ? json({ error: 'PRIVATE_RESET_BODY' }, 503) : json({ rate_limit_reset_credits: { available_count: count }, rate_limit: { primary_window: { used_percent: 42 } } }));
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('codex');
    expect(account.usage).toMatchObject({ status: 'ready', resetCreditsStatus: 'ready', resetCredits: { available: count, expiresAt: [] } });
    expect(account.usage.resetCreditsMessage).toContain('到期明细');
    expect(JSON.stringify(account)).not.toContain('PRIVATE_RESET_BODY');
  });

  it.each([null, -1, 1.5, '2'])('does not fabricate Codex reset counts from malformed summary %s', async count => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('reset-credits') ? json({ error: 'PRIVATE_RESET_BODY' }, 404) : json({ rate_limit_reset_credits: { available_count: count }, rate_limit: { primary_window: { used_percent: 42 } } }));
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('codex');
    expect(account.usage).toMatchObject({ status: 'ready', resetCreditsStatus: 'not-supported' });
    expect(account.usage.resetCredits).toBeUndefined();
  });

  it('filters expired and duplicate reset credits and refuses malformed expiry rather than reporting zero', async () => {
    const now = Date.parse('2026-10-07T00:00:00Z'); vi.useFakeTimers(); vi.setSystemTime(now);
    const store = new MemoryStore(); let malformed = false;
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('reset-credits') ? json({ available_count: 999, credits: malformed ? [{ status: 'available', expires_at: 'unknown' }] : [
      { id: 'later', status: 'available', expires_at: '2026-10-10T00:00:00Z' },
      { id: 'later', status: 'available', expires_at: '2026-10-10T00:00:00Z' },
      { status: 'available', expires_at: '2026-10-07T00:00:00Z' },
      { status: 'used', expires_at: null },
      { status: 'available', reset_type: 'other_product', expires_at: null },
      { status: 'available', expires_at: '2026-10-09T00:00:00Z' },
      { status: 'available', expires_at: null },
    ] }) : json({ rate_limit: { primary_window: { used_percent: 42 } } }));
    const center = new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch });
    expect((await center.refreshUsage('codex')).usage.resetCredits).toEqual({ available: 3, expiresAt: ['2026-10-09T00:00:00.000Z', '2026-10-10T00:00:00.000Z', null] });
    malformed = true;
    expect((await center.refreshUsage('codex')).usage).toMatchObject({ status: 'ready', resetCreditsStatus: 'unavailable' });
    expect(center.listAccounts()[0].usage.resetCredits).toBeUndefined();
  });

  it('marks optional reset credits stale after transient failure and excludes credits whose expiry passed', async () => {
    const now = Date.parse('2026-10-07T00:00:00Z'); vi.useFakeTimers(); vi.setSystemTime(now);
    const store = new MemoryStore(); let fail = false;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith('reset-credits')) return json({ rate_limit: { primary_window: { used_percent: 42 } } });
      if (fail) throw new Error('PRIVATE_NETWORK_ERROR');
      return json({ credits: [{ status: 'available', expires_at: new Date(now + 1000).toISOString() }, { status: 'available', expires_at: null }] });
    });
    const center = new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch });
    expect((await center.refreshUsage('codex')).usage.resetCredits?.available).toBe(2);
    fail = true; vi.setSystemTime(now + 2000);
    const account = await center.refreshUsage('codex');
    expect(account.usage).toMatchObject({ status: 'ready', resetCreditsStatus: 'stale', resetCredits: { available: 1, expiresAt: [null] } });
    expect(JSON.stringify(account)).not.toContain('PRIVATE_NETWORK_ERROR');
  });

  it('queries Grok with a grpc-web frame and parses the observed billing fields', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig');
      expect(init?.method).toBe('POST');
      expect([...init!.body as Uint8Array]).toEqual([0, 0, 0, 0, 0]);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/grpc-web+proto');
      expect(new Headers(init?.headers).get('origin')).toBe('https://grok.com');
      return new Response(grokPayload(37.5, Math.floor(Date.now() / 1000) + 7 * 86400));
    });
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('grok');
    expect(account.usage.status).toBe('ready');
    expect(account.usage.windows[0]).toMatchObject({ label: '每周', remainingPercent: 62.5 });
    expect(account.usage.resetCreditsStatus).toBe('not-supported');
    expect(account.usage.resetCredits).toBeUndefined();
  });

  it('preserves the recognized CC Switch 4.0 proto3 zero shape with a compatibility source tag', () => {
    const reset = Math.floor(Date.now() / 1000) + 7 * 86400;
    expect(parseGrokUsage(grokPayload(0, reset, true))[0]).toMatchObject({ usedPercent: 0, remainingPercent: 100, measurement: 'reported' });
    expect(parseGrokUsage(grokPayload(undefined, reset, true))[0]).toMatchObject({ usedPercent: 0, remainingPercent: 100, measurement: 'protobuf-default' });
    expect(parseGrokUsage(grokPayload(undefined, reset))).toEqual([]);
    expect(parseGrokUsage(grpcFrame(message(9, percentField(10))))).toEqual([]);
    expect(() => parseGrokUsage(Uint8Array.of(0, 0, 0, 0, 20))).toThrow();
    const good = grokPayload(20);
    const trailer = grpcFrame(new TextEncoder().encode('grpc-status: 16\r\n'), 128);
    expect(() => parseGrokUsage(Uint8Array.from([...good, ...trailer]))).toThrow('gRPC 16');
  });

  it('does not apply Grok compatibility zero to unknown periods, past reset, competing fields or split messages', () => {
    const now = Date.parse('2026-10-07T00:00:00Z') / 1000, reset = now + 7 * 86400;
    const resetField = message(5, Uint8Array.from([8, ...varint(reset)]));
    const knownPeriod = message(6, Uint8Array.of(8, 3));
    const unknownPeriod = message(6, Uint8Array.of(8, 99));
    expect(parseGrokUsage(grpcFrame(message(1, Uint8Array.from([...resetField, ...unknownPeriod]))), now)).toEqual([]);
    expect(parseGrokUsage(grokPayload(undefined, now - 1, true), now)).toEqual([]);
    expect(parseGrokUsage(grpcFrame(message(1, Uint8Array.from([...resetField, ...knownPeriod, ...message(9, percentField(10))]))), now)).toEqual([]);
    expect(parseGrokUsage(grpcFrame(message(1, Uint8Array.from([...resetField, ...knownPeriod, 8, 0]))), now)).toEqual([]); // percentage in an unsupported wire type
    const resetFrame = grpcFrame(message(1, resetField)), periodFrame = grpcFrame(message(1, knownPeriod));
    expect(parseGrokUsage(Uint8Array.from([...resetFrame, ...periodFrame]), now)).toEqual([]);
    const alternatePeriod = message(8, Uint8Array.of(8, 2));
    expect(parseGrokUsage(grpcFrame(message(1, Uint8Array.from([...resetField, ...alternatePeriod]))), now)[0]).toMatchObject({ measurement: 'protobuf-default', remainingPercent: 100 });
  });

  it('explains a compatible omitted-zero Grok percentage without claiming it was directly reported', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async () => new Response(grokPayload(undefined, Math.floor(Date.now() / 1000) + 7 * 86400, true)));
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('grok');
    expect(account.usage).toMatchObject({ status: 'ready', windows: [expect.objectContaining({ measurement: 'protobuf-default', remainingPercent: 100 })] });
    expect(account.usage.message).toContain('按兼容协议默认零值解析');
  });

  it('keeps the Grok weekly label near reset and does not advertise a past timestamp as the next reset', () => {
    const now = Date.parse('2026-10-07T00:00:00Z') / 1000;
    expect(parseGrokUsage(grokPayload(20, now + 3600), now)[0]).toMatchObject({ label: '每周', resetAt: '2026-10-07T01:00:00.000Z', windowSeconds: 604800 });
    expect(parseGrokUsage(grokPayload(20, now - 1), now)[0].resetAt).toBeUndefined();
    expect(parseGrokUsage(grokPayload(20), now)[0].resetAt).toBeUndefined();
  });

  it.each(['header', 'trailer'])('classifies Grok rejected credentials in %s gRPC metadata without echoing a secret message', async place => {
    const store = new MemoryStore(), rawMessage = 'oauth2%20access%20token%20PRIVATE_GROK%20could%20not%20be%20validated';
    const fetcher = vi.fn(async () => place === 'header' ? new Response(null, { headers: { 'grpc-status': '7', 'grpc-message': rawMessage } }) : new Response(grpcFrame(new TextEncoder().encode(`grpc-status: 7\r\ngrpc-message: ${rawMessage}\r\n`), 128)));
    const account = await new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch }).refreshUsage('grok');
    expect(account.authStatus).toBe('error'); expect(account.usage.windows).toEqual([]);
    expect(account.usage.message).toContain('请重新登录'); expect(JSON.stringify(account)).not.toContain('PRIVATE_GROK');
  });

  it('preserves measured Grok quota as stale on a service gRPC failure and reports unsupported team usage safely', async () => {
    const store = new MemoryStore(); let status = 0;
    const fetcher = vi.fn(async () => status === 0 ? new Response(grokPayload(20)) : new Response(grpcFrame(new TextEncoder().encode(`grpc-status: ${status}\r\ngrpc-message: ${status === 9 ? 'no%20personal%20team' : 'PRIVATE_GRPC_FAILURE'}\r\n`), 128)));
    const center = new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch });
    const measured = await center.refreshUsage('grok'); status = 14;
    const stale = await center.refreshUsage('grok');
    expect(stale.usage).toMatchObject({ status: 'stale', queriedAt: measured.usage.queriedAt });
    expect(stale.usage.windows[0].remainingPercent).toBe(80); expect(JSON.stringify(stale)).not.toContain('PRIVATE_GRPC_FAILURE');
    status = 9;
    const team = await center.refreshUsage('grok');
    expect(team.usage).toMatchObject({ status: 'unavailable', windows: [], message: 'xAI 暂未提供团队账户额度查询' });
    expect(team.authStatus).toBe('ready');
  });

  it('reports upstream auth failure safely without echoing bodies and clears old quota', async () => {
    const store = new MemoryStore();
    let fail = false;
    const center = new AuthCenter(store, oauthFor(store), { fetch: (async () => fail ? json({ error: 'PRIVATE_ACCESS echoed' }, 401) : json({ rate_limit: { primary_window: { used_percent: 12 } } })) as typeof fetch });
    await center.refreshUsage('codex'); fail = true;
    const account = await center.refreshUsage('codex');
    expect(account.authStatus).toBe('error');
    expect(account.usage.status).toBe('unavailable');
    expect(account.usage.windows).toEqual([]);
    expect(account.usage.message).toContain('请重新登录');
    expect(JSON.stringify(account)).not.toContain('PRIVATE_ACCESS');
  });

  it('keeps the last measured quota marked stale after a transport failure', async () => {
    const store = new MemoryStore(); let fail = false;
    const center = new AuthCenter(store, oauthFor(store), { fetch: (async () => { if (fail) throw new Error('PRIVATE_REFRESH network echo'); return json({ rate_limit: { primary_window: { used_percent: 20 } } }); }) as typeof fetch });
    const first = await center.refreshUsage('codex'); fail = true;
    const second = await center.refreshUsage('codex');
    expect(second.usage.status).toBe('stale');
    expect(second.usage.queriedAt).toBe(first.usage.queriedAt);
    expect(second.usage.windows[0].remainingPercent).toBe(80);
    expect(second.usage.message).not.toContain('PRIVATE_REFRESH');
  });

  it('coalesces quota queries and prevents an in-flight result from restoring logged-out data', async () => {
    const store = new MemoryStore(), oauth = oauthFor(store);
    let release: ((response: Response) => void) | undefined;
    const center = new AuthCenter(store, oauth, { fetch: vi.fn(async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch });
    const first = center.refreshUsage('grok'), second = center.refreshUsage('grok');
    expect(first).toBe(second);
    await Promise.resolve();
    center.logout('grok');
    release!(new Response(grokPayload(10)));
    await first;
    expect(oauth.cancel).toHaveBeenCalledWith('grok');
    expect(store.getSecret('grok')).toBeUndefined();
    expect(store.state.get('auth-usage:grok')).toBeNull();
    expect(center.listAccounts().find(a => a.providerId === 'grok')?.usage.windows).toEqual([]);
  });

  it('does not carry cached quota to a newly authorized identity on the same provider', async () => {
    const store = new MemoryStore();
    const center = new AuthCenter(store, oauthFor(store), { fetch: (async () => json({ rate_limit: { primary_window: { used_percent: 30 } } })) as typeof fetch });
    await center.refreshUsage('codex');
    store.setSecret('codex', { accessToken: 'DIFFERENT_ACCOUNT', accountId: 'another-account' });
    expect(center.listAccounts()[0].usage.status).toBe('not-queried');
  });

  it('does not apply a late quota auth refusal or reset result to a different newly authorized identity', async () => {
    const store = new MemoryStore();
    store.setSecret('codex', { accessToken: jwt({ sub: 'old-user' }), accountId: 'old-workspace' });
    let release!: (response: Response) => void;
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('reset-credits') ? json({ credits: [{ status: 'available', expires_at: null }] }) : await new Promise<Response>(done => { release = done; }));
    const center = new AuthCenter(store, oauthFor(store), { fetch: fetcher as typeof fetch });
    const pending = center.refreshUsage('codex'); await Promise.resolve();
    store.setSecret('codex', { accessToken: jwt({ sub: 'new-user' }), accountId: 'new-workspace' });
    release(json({ error: 'PRIVATE_OLD_AUTH_FAILURE' }, 401));
    const account = await pending;
    expect(account).toMatchObject({ accountId: 'new-workspace', authStatus: 'ready', usage: { status: 'not-queried', windows: [] } });
    expect(store.state.get('auth-usage:codex')).toBeUndefined();
    expect(JSON.stringify(account)).not.toContain('PRIVATE_OLD_AUTH_FAILURE');
  });

  it('keeps its request deadline active when an upstream stalls after response headers', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore(), cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const center = new AuthCenter(store, oauthFor(store), { fetch: (async () => new Response(stream)) as typeof fetch });
    const result = center.refreshUsage('grok');
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await result).usage).toMatchObject({ status: 'unavailable', windows: [], message: '额度查询网络失败或超时' });
    expect(cancelled).toHaveBeenCalled();
  });

  it('does not send quota credentials when the provider uses an untrusted subscription upstream', async () => {
    const store = new MemoryStore(), fetcher = vi.fn();
    store.providers.get('codex')!.baseUrl = 'https://attacker.example';
    const center = new AuthCenter(store, oauthFor(store), { fetch: fetcher });
    const result = await center.refreshUsage('codex');
    expect(result.usage.status).toBe('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('imports native Codex tokens only on explicit action without changing the client file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'modeldock-auth-')); dirs.push(dir);
    await mkdir(join(dir, '.codex'));
    const file = join(dir, '.codex', 'auth.json');
    const input = { auth_mode: 'chatgpt', tokens: { access_token: jwt({ sub: 'codex-user', exp: Date.now() / 1000 + 7200 }), refresh_token: 'PRIVATE_IMPORTED', account_id: 'native-account', id_token: jwt({ email: 'native@example.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }) } };
    await writeFile(file, JSON.stringify(input));
    const store = new MemoryStore(), center = new AuthCenter(store, oauthFor(store), { homeDir: dir });
    expect(store.listProviders()).toHaveLength(2);
    const result = await center.importAccount('codex');
    expect(result).toMatchObject({ email: 'native@example.test', plan: 'plus', accountId: 'native-account', source: 'client-import', authStatus: 'ready' });
    expect(store.getSecret(result.providerId)?.refreshToken).toBe('PRIVATE_IMPORTED');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(input);
    const repeated = await center.importAccount('codex');
    expect(repeated.providerId).toBe(result.providerId);
    expect(store.listProviders()).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_IMPORTED');
  });

  it('cancels an old real OAuth refresh before importing same-access newer credentials and ignores its late reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'modeldock-auth-race-')); dirs.push(dir);
    await mkdir(join(dir, '.codex'));
    const file = join(dir, '.codex', 'auth.json');
    const accessToken = jwt({ sub: 'same-access-user', exp: Math.floor(Date.now() / 1000) + 7200, 'https://api.openai.com/auth': { chatgpt_account_id: 'same-workspace' } });
    const idToken = jwt({ sub: 'same-id-user', email: 'imported@example.test' });
    const input = { auth_mode: 'chatgpt', tokens: { access_token: accessToken, id_token: idToken, refresh_token: 'PRIVATE_IMPORTED_REFRESH', account_id: 'same-workspace' } };
    const contents = JSON.stringify(input); await writeFile(file, contents);
    const store = new MemoryStore();
    store.setSecret('codex', { accessToken, accountId: 'same-workspace', refreshToken: 'PRIVATE_OLD_REFRESH', expiresAt: Date.now() - 1 });
    let release!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://auth.openai.com/oauth/token');
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('PRIVATE_OLD_REFRESH');
      requestSignal = init?.signal as AbortSignal;
      return await new Promise<Response>(done => { release = done; });
    });
    const oauth = new OAuthManager(store, { openExternal: async () => {}, fetch: fetcher as typeof fetch }); managers.push(oauth);
    const cancel = vi.spyOn(oauth, 'cancel'), write = vi.spyOn(store, 'setSecret');
    const oldRefresh = oauth.prepareRequest({ ...codex }, '/responses', { model: 'synthetic-model' });
    const rejected = expect(oldRefresh).rejects.toThrow(/取消|变化/);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(requestSignal?.aborted).toBe(false);
    const center = new AuthCenter(store, oauth, { homeDir: dir });
    const imported = await center.importAccount('codex');
    expect(imported.providerId).toBe('codex'); expect(store.listProviders()).toHaveLength(2);
    expect(cancel).toHaveBeenCalledWith('codex'); expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    expect(requestSignal?.aborted).toBe(true);
    const newSecret = store.getSecret('codex');
    expect(newSecret).toMatchObject({ accessToken, idToken, refreshToken: 'PRIVATE_IMPORTED_REFRESH', accountId: 'same-workspace' });
    expect(imported).toMatchObject({ email: 'imported@example.test', source: 'client-import', authStatus: 'ready' });
    release(json({ access_token: 'PRIVATE_LATE_ACCESS', refresh_token: 'PRIVATE_LATE_REFRESH', id_token: 'PRIVATE_LATE_ID', expires_in: 3600 }));
    await rejected; await Promise.resolve(); await Promise.resolve();
    expect(store.getSecret('codex')).toEqual(newSecret); expect(store.getProvider('codex')?.authStatus).toBe('ready');
    expect(write).toHaveBeenCalledTimes(1); expect(await readFile(file, 'utf8')).toBe(contents);
    expect(JSON.stringify(center.listAccounts())).not.toMatch(/PRIVATE_IMPORTED_REFRESH|PRIVATE_LATE_|idToken|accessToken|refreshToken/);
  });

  it.each([200, 403])('invalidates same-identity quota work on explicit import so its late HTTP %s reply cannot restore stale usage or an auth error', async status => {
    const dir = await mkdtemp(join(tmpdir(), 'modeldock-auth-quota-race-')); dirs.push(dir);
    await mkdir(join(dir, '.codex'));
    const file = join(dir, '.codex', 'auth.json');
    const accessToken = jwt({ sub: 'same-quota-user', exp: Math.floor(Date.now() / 1000) + 7200 });
    const input = { auth_mode: 'chatgpt', tokens: { access_token: accessToken, refresh_token: 'PRIVATE_NEW_QUOTA_REFRESH', account_id: 'same-quota-workspace' } };
    const contents = JSON.stringify(input); await writeFile(file, contents);
    const store = new MemoryStore(); store.setSecret('codex', { accessToken, refreshToken: 'PRIVATE_OLD_QUOTA_REFRESH', accountId: 'same-quota-workspace' });
    const oauth = oauthFor(store);
    const releases: ((response: Response) => void)[] = [];
    const requestSignals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      requestSignals.push(init?.signal as AbortSignal);
      return await new Promise<Response>(done => { releases.push(done); });
    });
    const center = new AuthCenter(store, oauth, { homeDir: dir, fetch: fetcher as typeof fetch });
    const oldQuery = center.refreshUsage('codex'); await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(requestSignals.every(signal => !signal.aborted)).toBe(true);
    const imported = await center.importAccount('codex');
    expect(imported.providerId).toBe('codex'); expect(imported.authStatus).toBe('ready'); expect(requestSignals.every(signal => signal.aborted)).toBe(true);
    const newSecret = store.getSecret('codex'); expect(newSecret?.refreshToken).toBe('PRIVATE_NEW_QUOTA_REFRESH');
    releases[0](status === 200 ? json({ rate_limit: { primary_window: { used_percent: 77 } } }) : json({ error: 'PRIVATE_LATE_QUOTA_FAILURE' }, status));
    releases[1](json({ credits: [{ status: 'available', expires_at: null }] }));
    const result = await oldQuery;
    expect(result.usage).toMatchObject({ status: 'not-queried', windows: [] });
    expect(store.state.get('auth-usage:codex')).toBeNull(); expect(store.getSecret('codex')).toEqual(newSecret); expect(store.getProvider('codex')?.authStatus).toBe('ready');
    expect(await readFile(file, 'utf8')).toBe(contents); expect(JSON.stringify(result)).not.toContain('PRIVATE_'); center.dispose();
  });

  it('imports only Grok credentials for the compatible OIDC client, not legacy sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'modeldock-auth-')); dirs.push(dir);
    await mkdir(join(dir, '.grok'));
    const file = join(dir, '.grok', 'auth.json'), store = new MemoryStore(), center = new AuthCenter(store, oauthFor(store), { homeDir: dir });
    await writeFile(file, JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'LEGACY_PRIVATE' }, 'https://auth.x.ai::different-client': { key: 'WRONG_CLIENT' } }));
    await expect(center.importAccount('grok')).rejects.toThrow('兼容的 OIDC');
    const native = { 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': { key: jwt({ sub: 'grok-user', email: 'grok@example.test' }), refresh_token: 'PRIVATE_GROK_REFRESH', expires_at: new Date(Date.now() + 7200_000).toISOString() } };
    await writeFile(file, JSON.stringify(native));
    const result = await center.importAccount('grok');
    expect(result).toMatchObject({ accountId: 'grok-user', email: 'grok@example.test', canRefresh: true });
    expect(store.getSecret(result.providerId)?.tokenEndpoint).toBeUndefined(); // OAuthManager performs trusted discovery when renewal is needed.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(native);
  });
});
