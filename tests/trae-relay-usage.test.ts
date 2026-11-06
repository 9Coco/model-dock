import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTraeCreditWindows, parseTraeQuota, parseTraePlan, queryTraeRelayUsage, TraeRelayUsageError, type TraeUsageRequest } from '../src/main/trae-relay-usage';

const key = 'k'.repeat(64), privateValue = 'SYNTHETIC_PRIVATE_TRAE_USAGE_TOKEN';
const now = () => Date.parse('2026-11-05T10:00:00Z');
const account = (id = 'active-user', label = '当前活跃账号') => ({ success: true, active: id, accounts: [{ id, user_id: id, label, has_token: true, is_active: true }, { id: 'recent-import', user_id: 'recent-import', label: '最近导入但未激活', has_token: true, is_active: false }] });
const pack = (quota: Record<string, unknown> = { credits_limit: 100 }, usage: Record<string, unknown> = { credits_amount: 25 }) => ({ entitlement_base_info: { entitlement_id: 'fixture-entitlement', product_type: 1, quota, end_time: 2000000000 }, usage, status: 1, expire_time: 2000000000 });
const nativeCredits = (raw: unknown = { code: 0, user_entitlement_pack_list: [pack()] }) => ({ success: true, id: 'active-user', credits: { remaining: 3, official_remaining: 75, official_used: 25, local_debit: 72 }, raw });
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
  const planPack = (type: unknown, changes: Record<string, unknown> = {}) => ({ ...pack(), ...changes, entitlement_base_info: { ...pack().entitlement_base_info, product_type: type, ...((changes.entitlement_base_info ?? {}) as Record<string, unknown>) } });
  it.each([[0, 'Free'], [1, 'Pro'], [4, 'Pro+'], [6, 'Ultra'], [8, 'Lite'], [100, 'Express']])('maps the official base product type %s to %s without estimating from the balance', (type, plan) => {
    for (const credits_limit of [0, 100, 999999]) expect(parseTraePlan({ user_entitlement_pack_list: [planPack(type, { entitlement_base_info: { quota: { credits_limit } } })] }, now())).toBe(plan);
  });
  it('keeps paid-plan priority independent of free and add-on packs, including canceled but unexpired subscriptions', () => {
    const packs = [planPack(0), planPack(2), planPack(1, { status: 3 }), planPack(5), planPack(7), planPack(4)];
    expect(parseTraePlan({ user_entitlement_pack_list: packs }, now())).toBe('Pro+');
    expect(parseTraePlan({ user_entitlement_pack_list: [...packs, planPack(6)] }, now())).toBe('Ultra');
    expect(parseTraePlan({ user_entitlement_pack_list: [...packs, planPack(100)] }, now())).toBe('Express');
  });
  it('keeps unsupported identities, add-ons, failed, pending, expired and future packs unknown', () => {
    for (const type of [2, 3, 5, 7, 9, 999, '1', undefined, null]) expect(parseTraePlan({ user_pay_identity_str: 'Ultra', userPayIdentityText: 'Pro', user_entitlement_pack_list: [planPack(type)] }, now())).toBeUndefined();
    for (const status of [0, 4, 5, 'active', undefined]) expect(parseTraePlan({ user_entitlement_pack_list: [planPack(1, { status })] }, now())).toBeUndefined();
    for (const changes of [{ expire_time: now() / 1000 }, { entitlement_base_info: { start_time: now() / 1000 + 60 } }, { entitlement_base_info: { start_time: 'invalid' } }, { expire_time: 'invalid' }]) expect(parseTraePlan({ user_entitlement_pack_list: [planPack(1, changes)] }, now())).toBeUndefined();
    for (const raw of [undefined, {}, { code: 1, user_entitlement_pack_list: [planPack(1)] }, { user_entitlement_pack_list: Array.from({ length: 101 }, () => planPack(1)) }]) expect(parseTraePlan(raw, now())).toBeUndefined();
  });
  it.each([0, 2, 4, 5, 'active', 'canceled', '1', '3', undefined, null])('does not treat unverified entitlement status %s as current quota', status => {
    const raw = { user_entitlement_pack_list: [planPack(1, { status })] };
    expect(parseTraeCreditWindows(raw, now())).toEqual([]);
    expect(parseTraePlan(raw, now())).toBeUndefined();
  });
  it('filters future, expired and malformed periods before numbering while retaining exhausted and unknown active balances', () => {
    const second = now() / 1000;
    const raw = { code: 0, user_entitlement_pack_list: [
      planPack(6, { expire_time: second, usage: { credits_amount: 0 } }),
      planPack(4, { entitlement_base_info: { start_time: second + 1 } }),
      planPack(1, { usage: { credits_amount: 100 }, entitlement_base_info: { start_time: second } }),
      planPack(6, { expire_time: undefined, entitlement_base_info: { end_time: second - 1 } }),
      planPack(6, { expire_time: 'invalid' }),
      planPack(6, { entitlement_base_info: { start_time: 'invalid' } }),
      planPack(0, { status: 3, usage: null, expire_time: second + 1 }),
    ] };
    const windows = parseTraeCreditWindows(raw, now());
    expect(windows).toMatchObject([{ label: '通用积分 1', total: 100, remaining: 0, remainingPercent: 0 }, { label: '通用积分 2', total: 100 }]);
    expect(windows).toHaveLength(2); expect(windows[1].remaining).toBeUndefined(); expect(windows[1].remainingPercent).toBeUndefined();
    expect(windows.every(window => window.resetAt === undefined && window.windowSeconds === undefined)).toBe(true);
    expect(parseTraePlan(raw, now())).toBe('Pro');
    expect(parseTraeCreditWindows(raw, now() + 1000)).toMatchObject([{ label: '通用积分 1' }, { label: '通用积分 2' }]);
    const single = { user_entitlement_pack_list: [planPack(6, { expire_time: second }), planPack(1)] };
    expect(parseTraeCreditWindows(single, now())).toMatchObject([{ label: '通用积分', total: 100, remaining: 75 }]);
  });
  it('shows official per-pack credits independently of relay-local debit and model history', async () => {
    const io = transport(), result = await queryTraeRelayUsage(key, { send: io.send, now });
    expect(result).toMatchObject({ accountId: 'active-user', accountLabel: '当前活跃账号', plan: 'Pro', usage: { status: 'ready', queriedAt: '2026-11-05T10:00:00.000Z', windows: [{ label: '通用积分', total: 100, remaining: 75, unit: '积分', remainingPercent: 75, usedPercent: 25, measurement: 'reported' }] } });
    expect(JSON.stringify(result)).not.toMatch(/recent-import|local_debit|official_used|entitlement|raw|SYNTHETIC_PRIVATE/);
    expect(result.usage.windows[0].resetAt).toBeUndefined();
  });
  it('keeps credits and fast-request counts separate and labels only the verified omitted credits usage default', () => {
    const windows = parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: '100.5', premium_model_fast_request_limit: 8 }, { credits_amount: '25.25', premium_model_fast_amount: 3 }), pack({ credits_limit: 50 }, {})] });
    expect(windows).toMatchObject([{ label: '通用积分 1', total: 100.5, remaining: 75.25, unit: '积分' }, { label: '高级模型快速请求 1', total: 8, remaining: 5, unit: '次' }, { label: '通用积分 2', total: 50, unit: '积分' }]);
    expect(windows[2]).toMatchObject({ remaining: 50, remainingPercent: 100, measurement: 'official-default' });
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
    for (const limit of [null, true, 'NaN', 'Infinity', -2, -.5, Number.MAX_SAFE_INTEGER + 1, {}, '']) {
      const windows = parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: limit })] });
      expect(windows).toHaveLength(1); expect(windows[0].total).toBeUndefined(); expect(windows[0].remaining).toBeUndefined();
    }
    for (const used of [null, true, 'NaN', -1, {}, '']) {
      const windows = parseTraeCreditWindows({ user_entitlement_pack_list: [pack({ credits_limit: 100 }, { credits_amount: used })] });
      expect(windows[0]).toMatchObject({ total: 100 }); expect(windows[0].remaining).toBeUndefined();
    }
    const io = transport([{ body: account() }, { body: nativeCredits({}) }, { body: account() }]);
    const result = await queryTraeRelayUsage(key, { send: io.send, now });
    expect(result.usage).toMatchObject({ status: 'unavailable', windows: [] }); expect(result.usage.message).toContain('未知');
  });
  it('accepts only current native statuses and preserves the subscription quota wrapper', () => {
    const active = { ...pack(), entitlement_base_info: { entitlement_id: 'subscription', product_extra: { subscription_extra: { quota: { credits_limit: 40 } } } }, usage: { credits_amount: 2 }, status: 3 };
    expect(parseTraeCreditWindows({ user_entitlement_pack_list: [{ ...pack(), status: 5 }, { ...pack(), status: 'terminated' }, active] })).toMatchObject([{ total: 40, remaining: 38 }]);
    expect(parseTraeCreditWindows({ user_entitlement_pack_list: Array.from({ length: 101 }, () => pack()) })).toEqual([]);
  });
});

describe('TRAE source-grouped credits with official CN client defaults', () => {
  const named = (group_name: unknown, group_type: unknown, quota: Record<string, unknown>, usage: unknown = {}) => ({ ...pack(quota), group_name, group_type, usage });
  it('matches the synthetic official 19 check-in plus monthly grant example without rounding or dropping exhausted grants', () => {
    const monthlyExpiry = Date.parse('2026-11-30T15:59:59Z') / 1000, second = now() / 1000;
    const raw = { code: 0, is_credits_billing: true, user_entitlement_pack_list: [
      { ...pack({ enable_solo_agent: true }, {}), entitlement_base_info: { ...pack().entitlement_base_info, product_type: 0, quota: { enable_solo_agent: true } } },
      { ...named('每月登录赠送', 'monthly-login', { credits_limit: 500 }), expire_time: monthlyExpiry },
      ...Array.from({ length: 19 }, (_, index) => ({
        ...named('每日签到', 'checkin', { credits_limit: 100 }, index < 5 ? { credits_amount: 100 } : index === 5 ? { credits_amount: 86.1964 } : {}),
        source_id: `synthetic-grant-${index}`, expire_time: second + (index + 1) * 86400,
      })),
    ] };
    const quota = parseTraeQuota(raw, now());
    expect(quota.summary).toMatchObject({ id: 'trae-credits-total', label: '总可用积分', total: 2400, remaining: 1813.8036, grantCount: 20, unit: '积分', measurement: 'official-default' });
    expect(quota.summary!.remaining).toBe(1813.8036);
    expect(quota.windows).toHaveLength(2);
    expect(quota.windows).toMatchObject([
      { label: '每月登录赠送', total: 500, remaining: 500, grantCount: 1, expiresAt: '2026-11-30T15:59:59.000Z', measurement: 'official-default' },
      { label: '每日签到', total: 1900, remaining: 1313.8036, grantCount: 19, measurement: 'official-default' },
    ]);
    expect(quota.windows[1].remaining).toBe(1313.8036); expect(quota.windows[1].expiresAt).toBeUndefined(); expect(quota.summary!.expiresAt).toBeUndefined();
    expect(quota.details).toHaveLength(20); expect(quota.details.filter(window => window.remaining === 0)).toHaveLength(5);
    expect(quota.details.filter(window => window.measurement === 'official-default')).toHaveLength(14);
    expect(quota.details.every(window => !!window.expiresAt && window.resetAt === undefined && window.windowSeconds === undefined)).toBe(true);
    expect(parseTraeCreditWindows(raw, now())).toEqual(quota.details);
    expect(JSON.stringify(quota)).not.toMatch(/source_id|synthetic-grant|entitlement_base_info|checkin|monthly-login/);
  });
  it.each([undefined, {}])('uses the official zero default only for omitted or empty usage (%s)', usage => {
    const quota = parseTraeQuota({ user_entitlement_pack_list: [named('月赠', 1, { credits_limit: 500 }, usage)] }, now());
    expect(quota.summary).toMatchObject({ total: 500, remaining: 500, measurement: 'official-default' });
    expect(quota.details[0]).toMatchObject({ remaining: 500, measurement: 'official-default' });
  });
  it.each([null, 'invalid', false, [], { credits_amount: null }, { credits_amount: false }, { credits_amount: 'NaN' }, { credits_amount: -1 }])('propagates genuinely invalid usage to group and total rather than claiming a partial balance: %j', usage => {
    const quota = parseTraeQuota({ user_entitlement_pack_list: [named('积分包', 1, { credits_limit: 100 }, { credits_amount: 25 }), named('积分包', 1, { credits_limit: 100 }, usage)] }, now());
    expect(quota.windows).toHaveLength(1); expect(quota.windows[0].total).toBe(200); expect(quota.windows[0].remaining).toBeUndefined(); expect(quota.windows[0].remainingPercent).toBeUndefined();
    expect(quota.summary!.total).toBe(200); expect(quota.summary!.remaining).toBeUndefined(); expect(quota.summary!.remainingPercent).toBeUndefined();
    expect(quota.details).toHaveLength(2); expect(quota.details[0].remaining).toBe(75); expect(quota.details[1].remaining).toBeUndefined();
  });
  it('does not silently discard a malformed credit quota and then present the other grants as a complete balance', () => {
    const quota = parseTraeQuota({ user_entitlement_pack_list: [named('赠送积分', 1, { credits_limit: 100 }, { credits_amount: 25 }), named('赠送积分', 1, { credits_limit: null })] }, now());
    expect(quota.details).toHaveLength(2); expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0].total).toBeUndefined(); expect(quota.windows[0].remaining).toBeUndefined();
    expect(quota.summary!.total).toBeUndefined(); expect(quota.summary!.remaining).toBeUndefined(); expect(quota.summary!.grantCount).toBe(2);
  });
  it('keeps metrics and distinct server source types separate and weights percentages by credit amount', () => {
    const raw = { user_entitlement_pack_list: [
      named('同名来源', 1, { credits_limit: 100, premium_model_fast_request_limit: 10 }, { credits_amount: 100, premium_model_fast_amount: 1 }),
      named('同名来源', 1, { credits_limit: 900 }, { credits_amount: 0 }),
      named('同名来源', 2, { credits_limit: 50 }, { credits_amount: 10 }),
    ] };
    const quota = parseTraeQuota(raw, now());
    expect(quota.windows).toMatchObject([{ label: '同名来源', unit: '积分', total: 1000, remaining: 900, remainingPercent: 90, grantCount: 2 },
      { label: '同名来源 · 高级模型快速请求', unit: '次', total: 10, remaining: 9, grantCount: 1 }, { label: '同名来源', unit: '积分', total: 50, remaining: 40, grantCount: 1 }]);
    expect(quota.summary).toMatchObject({ total: 1050, remaining: 940, grantCount: 3 }); expect(quota.details).toHaveLength(4);
    expect(new Set(quota.windows.map(window => window.id)).size).toBe(3);
  });
  it('does not default absent fast usage, add unlimited as -1, or invent a source from grant size', () => {
    const raw = { user_entitlement_pack_list: [named(undefined, undefined, { credits_limit: -1 }), named(undefined, undefined, { credits_limit: 500, premium_model_fast_request_limit: 5 })] };
    const quota = parseTraeQuota(raw, now());
    expect(quota.summary).toMatchObject({ unlimited: true, grantCount: 2 }); expect(quota.summary!.total).toBeUndefined(); expect(quota.summary!.remaining).toBeUndefined();
    expect(quota.windows.map(window => window.label)).toEqual(['通用积分', '通用积分', '高级模型快速请求']);
    expect(quota.details[2].remaining).toBeUndefined(); expect(quota.details[2].measurement).toBe('reported');
    expect(parseTraeQuota({ user_entitlement_pack_list: [named('次数包', 'requests', { premium_model_fast_request_limit: 5 }, { premium_model_fast_amount: 1 })] }, now()).summary).toBeUndefined();
  });
  it('uses a common grant expiry only when every grouped grant has the same known expiry, without treating it as a reset', () => {
    const first = named('来源', 1, { credits_limit: 100 }), second = named('来源', 1, { credits_limit: 100 });
    const same = parseTraeQuota({ user_entitlement_pack_list: [first, second] }, now());
    expect(same.windows[0].expiresAt).toBe(new Date(2000000000 * 1000).toISOString()); expect(same.summary!.expiresAt).toBe(same.windows[0].expiresAt); expect(same.windows[0].resetAt).toBeUndefined();
    const mixed = parseTraeQuota({ user_entitlement_pack_list: [first, { ...second, expire_time: 2000000001 }] }, now());
    expect(mixed.windows[0].expiresAt).toBeUndefined(); expect(mixed.details.map(window => window.expiresAt)).toEqual(['2033-05-18T03:33:20.000Z', '2033-05-18T03:33:21.000Z']);
  });
  it('ignores no grants based on unverified hide/last-period flags and rejects unsafe group metadata', () => {
    const quota = parseTraeQuota({ user_entitlement_pack_list: [{ ...named('不隐藏', 1, { credits_limit: 100 }), is_hide: true, is_last_period: true },
      named('每日\n签到', { unsafe: 'group' }, { credits_limit: 500 })] }, now());
    expect(quota.summary).toMatchObject({ total: 600, remaining: 600, grantCount: 2 });
    expect(quota.windows.map(window => window.label)).toEqual(['不隐藏', '通用积分']); expect(JSON.stringify(quota)).not.toMatch(/unsafe|每日|签到/);
  });
  it('projects per-field subscription quota fallbacks without hiding explicitly invalid direct fields', () => {
    const first = { ...named('订阅', 1, { enable_solo_agent: true }), entitlement_base_info: { ...pack().entitlement_base_info, quota: { enable_solo_agent: true }, product_extra: { subscription_extra: { quota: { credits_limit: 40, premium_model_fast_request_limit: 5 } } } } };
    const result = parseTraeQuota({ user_entitlement_pack_list: [first] }, now());
    expect(result.summary).toMatchObject({ total: 40, remaining: 40 }); expect(result.windows[1]).toMatchObject({ total: 5, unit: '次' });
    const overridden = { ...first, entitlement_base_info: { ...first.entitlement_base_info, quota: { credits_limit: null, premium_model_fast_request_limit: 2 } } };
    const unknown = parseTraeQuota({ user_entitlement_pack_list: [overridden] }, now());
    expect(unknown.summary!.total).toBeUndefined(); expect(unknown.summary!.remaining).toBeUndefined(); expect(unknown.windows[1].total).toBe(2);
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
  it('uses one injected observation time for validity, plan and the reported quota timestamp', async () => {
    const timestamp = Date.parse('2040-01-01T00:00:00Z'), clock = vi.fn(() => timestamp);
    const raw = { user_entitlement_pack_list: [
      { ...pack(), expire_time: timestamp / 1000 - 1 },
      { ...pack(), expire_time: timestamp / 1000 + 60, entitlement_base_info: { ...pack().entitlement_base_info, product_type: 0 } },
    ] };
    const io = transport([{ body: account() }, { body: nativeCredits(raw) }, { body: account() }]);
    const result = await queryTraeRelayUsage(key, { send: io.send, now: clock });
    expect(result.plan).toBe('Free'); expect(result.usage.windows).toHaveLength(1); expect(result.usage.windows[0].label).toBe('通用积分');
    expect(result.usage.queriedAt).toBe('2040-01-01T00:00:00.000Z'); expect(clock).toHaveBeenCalledTimes(1);
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
