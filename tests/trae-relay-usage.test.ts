import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTraeCreditWindows, queryTraeRelayUsage, TraeRelayUsageError, type TraeUsageRequest } from '../src/main/trae-relay-usage';

const key = 'k'.repeat(64), privateValue = 'SYNTHETIC_PRIVATE_TRAE_USAGE_TOKEN';
const now = () => Date.parse('2026-11-05T10:00:00Z');
const account = (id = 'active-user', label = '当前活跃账号') => ({ success: true, active: id, accounts: [{ id, user_id: id, label, has_token: true, is_active: true }, { id: 'recent-import', user_id: 'recent-import', label: '最近导入但未激活', has_token: true, is_active: false }] });
const pack = (quota: Record<string, unknown> = { credits_limit: 100 }, usage: Record<string, unknown> = { credits_amount: 25 }) => ({ entitlement_base_info: { entitlement_id: 'fixture-entitlement', product_type: 2, quota, end_time: 2000000000 }, usage, status: 1, expire_time: 2000000000 });
const nativeCredits = (raw: unknown = { code: 0, user_pay_identity_str: 'Pro', user_entitlement_pack_list: [pack()] }) => ({ success: true, id: 'active-user', credits: { remaining: 3, official_remaining: 75, official_used: 25, local_debit: 72 }, raw });
interface Reply { status?: number; body?: unknown; literal?: string; contentType?: string; declared?: string; fail?: boolean; hang?: boolean; abort?: boolean }
function transport(replies: Reply[] = [{ body: account() }, { body: nativeCredits() }, { body: account() }]) {
  const calls: RequestOptions[] = [], bodies: unknown[] = [];
  const send: TraeUsageRequest = (options, callback) => {
    const index = calls.length; calls.push(options);
    const reply = replies[index];
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => { queueMicrotask(() => req.emit('error', new Error(privateValue))); return req; }) as ClientRequest['destroy'];
    req.end = ((body?: unknown) => {
      bodies.push(body);
      queueMicrotask(() => {
        if (!reply || reply.fail) { req.emit('error', new Error(privateValue)); return; }
        if (reply.hang) return;
        const stream = new PassThrough(), response = stream as unknown as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = { 'content-type': reply.contentType ?? 'application/json', ...(reply.declared ? { 'content-length': reply.declared } : {}) };
        callback(response);
        if (reply.abort) { stream.emit('aborted'); return; }
        stream.end(reply.literal ?? JSON.stringify(reply.body));
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { send, calls, bodies };
}
afterEach(() => vi.useRealTimers());

describe('TRAE native entitlement projection', () => {
  it('shows official per-pack credits independently of relay-local debit and model history', async () => {
    const io = transport(), result = await queryTraeRelayUsage(key, { send: io.send, now });
    expect(result).toMatchObject({ accountId: 'active-user', accountLabel: '当前活跃账号', plan: 'Pro', usage: { status: 'ready', queriedAt: '2026-11-05T10:00:00.000Z', windows: [{ label: '通用积分', total: 100, remaining: 75, unit: '积分', remainingPercent: 75, usedPercent: 25, measurement: 'reported' }] } });
    expect(JSON.stringify(result)).not.toMatch(/recent-import|local_debit|official_used|entitlement|raw|SYNTHETIC_PRIVATE/);
    expect(result.usage.windows[0].resetAt).toBeUndefined();
  });
  it('keeps credits and fast-request counts in separate windows without guessing missing usage or resets', () => {
    const windows = parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: '100.5', premium_model_fast_request_limit: 8 }, { credits_amount: '25.25', premium_model_fast_amount: 3 }), pack({ credits_limit: 50 }, {})] });
    expect(windows).toMatchObject([{ label: '通用积分 1', total: 100.5, remaining: 75.25, unit: '积分' }, { label: '高级模型快速请求 1', total: 8, remaining: 5, unit: '次' }, { label: '通用积分 2', total: 50, unit: '积分' }]);
    expect(windows[2].remaining).toBeUndefined(); expect(windows[2].remainingPercent).toBeUndefined();
    expect(windows.every(window => window.resetAt === undefined && window.windowSeconds === undefined)).toBe(true);
    expect(new Set(windows.map(window => window.id)).size).toBe(3);
  });
  it('supports explicit unlimited, explicit zero and known fast usage aliases, but never invents zero', () => {
    const windows = parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: -1 }), pack({ credits_limit: 0 }, { credits_amount: 0 }), pack({ premium_model_fast_request_limit: 5 }, { premium_model_fast_request_usage: 9 })] });
    expect(windows).toMatchObject([{ unlimited: true, unit: '积分' }, { total: 0, remaining: 0, unit: '积分' }, { total: 5, remaining: 0, remainingPercent: 0, unit: '次' }]);
    expect(windows[0].total).toBeUndefined(); expect(windows[0].remaining).toBeUndefined(); expect(windows[1].remainingPercent).toBeUndefined();
  });
  it('does not turn empty/default summary, feature-only packs or malformed values into exhausted credits', async () => {
    for (const raw of [undefined, {}, { user_entitlement_pack_list: [] }, { code: 1001, message: privateValue, user_entitlement_pack_list: [pack()] }, { user_entitlement_pack_list: [pack({}, {})] }]) {
      expect(parseTraeCreditWindows(raw)).toEqual([]);
    }
    for (const limit of [null, true, 'NaN', 'Infinity', -2, -.5, Number.MAX_SAFE_INTEGER + 1, {}, '']) expect(parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: limit })] })).toEqual([]);
    for (const used of [null, true, 'NaN', -1, {}, '']) {
      const windows = parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: 100 }, { credits_amount: used })] });
      expect(windows[0]).toMatchObject({ total: 100 }); expect(windows[0].remaining).toBeUndefined();
    }
    const io = transport([{ body: account() }, { body: nativeCredits({}) }, { body: account() }]);
    const result = await queryTraeRelayUsage(key, { send: io.send, now });
    expect(result.usage).toMatchObject({ status: 'unavailable', windows: [] }); expect(result.usage.message).toContain('未知');
  });
  it('ignores terminal packs and accepts the pinned native subscription quota wrapper', () => {
    const active = { ...pack(), entitlement_base_info: { entitlement_id: 'subscription', product_extra: { subscription_extra: { quota: { credits_limit: 40 } } } }, usage: { credits_amount: 2 }, status: 3 };
    expect(parseTraeCreditWindows({ user_entitlement_pack_list: [{ ...pack(), status: 5 }, { ...pack(), status: 'terminated' }, active] })).toMatchObject([{ total: 40, remaining: 38 }]);
    expect(parseTraeCreditWindows({ user_entitlement_pack_list: Array.from({ length: 101 }, () => pack()) })).toEqual([]);
  });
});

describe('owned TRAE quota management transport', () => {
  it('queries the actual active account, verifies it again, and sends only authenticated literal-loopback GETs', async () => {
    const io = transport(); await queryTraeRelayUsage(key, { send: io.send, now });
    expect(io.calls.map(call => call.path)).toEqual(['/api/accounts', '/api/checkin/credits/active-user', '/api/accounts']);
    for (const call of io.calls) expect(call).toMatchObject({ hostname: '127.0.0.1', port: 18080, method: 'GET', agent: false, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    expect(io.bodies).toEqual([undefined, undefined, undefined]);
    expect(JSON.stringify(io.calls)).not.toMatch(/claim|overview|usage\/records|completions|responses|recent-import/);
  });
  it('refuses an active-account switch or mismatched credit response instead of attributing it to an imported account', async () => {
    for (const replies of [[{ body: account() }, { body: nativeCredits() }, { body: account('new-active') }], [{ body: account() }, { body: { ...nativeCredits(), id: 'recent-import' } }]]) {
      const io = transport(replies); await expect(queryTraeRelayUsage(key, { send: io.send })).rejects.toBeInstanceOf(TraeRelayUsageError);
    }
  });
  it('rejects missing, ambiguous, unsafe or reserved active IDs before a credit lookup', async () => {
    for (const value of [{ success: false, error: privateValue }, account(''), account('foreign/path'), account('accounts'), account('..'), account('eyJhbGciOiJIUzI1NiJ9'), { ...account(), accounts: [] }, { ...account(), accounts: [{ id: 'active-user', has_token: false }] }, { ...account(), accounts: [{ id: 'active-user', user_id: '', has_token: true }] }, { ...account(), accounts: [...account().accounts, { id: 'active-user', has_token: true }] }]) {
      const io = transport([{ body: value }]);
      const error = await queryTraeRelayUsage(key, { send: io.send }).catch(error => error as Error);
      expect(error).toBeInstanceOf(TraeRelayUsageError); expect(String(error)).not.toContain(privateValue); expect(io.calls).toHaveLength(1);
    }
    const io = transport(); await expect(queryTraeRelayUsage('invalid', { send: io.send })).rejects.toThrow('密钥无效'); expect(io.calls).toHaveLength(0);
  });
  it.each([301, 302, 307, 308, 401, 403, 500])('does not follow redirects or expose HTTP %s response material', async status => {
    const io = transport([{ status, literal: privateValue }]); const error = await queryTraeRelayUsage(key, { send: io.send }).catch(error => error as Error);
    expect(error).toBeInstanceOf(TraeRelayUsageError); expect(String(error)).not.toContain(privateValue); expect(String(error)).not.toContain(key); expect(io.calls).toHaveLength(1);
  });
  it.each(['json', 'type', 'declared-size', 'stream-size', 'abort', 'transport'])('bounds and safely reports malformed %s responses', async kind => {
    const reply: Reply = kind === 'json' ? { literal: '{' + privateValue } : kind === 'type' ? { literal: privateValue, contentType: 'text/html' } : kind === 'declared-size' ? { declared: '1048577', literal: privateValue } : kind === 'stream-size' ? { literal: 'x'.repeat(1048577) + privateValue } : kind === 'abort' ? { abort: true } : { fail: true };
    const io = transport([reply]); const error = await queryTraeRelayUsage(key, { send: io.send }).catch(error => error as Error);
    expect(error).toBeInstanceOf(TraeRelayUsageError); expect(String(error)).not.toContain(privateValue); expect(String(error)).not.toContain(key);
  });
  it('has a hard deadline and performs no automatic retry', async () => {
    vi.useFakeTimers(); const io = transport([{ hang: true }]);
    const pending = queryTraeRelayUsage(key, { send: io.send }).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(65000); expect(String(await pending)).toContain('超时'); expect(io.calls).toHaveLength(1);
  });
});
