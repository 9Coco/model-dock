/** Synthetic responses used only by the isolated Electron verification. */
function fixtureCounter(key: string): void {
  process.env[key] = String(Number(process.env[key] ?? 0) + 1);
}
function tokenCounter(name: string): void { fixtureCounter(`MODELDOCK_SMOKE_COPILOT_TOKEN_${name}`); }
export function copilotPollingFixtureStats() {
  const count = (name: string) => Number(process.env[`MODELDOCK_SMOKE_COPILOT_TOKEN_${name}`] ?? 0);
  const slowedAt = Number(process.env.MODELDOCK_SMOKE_COPILOT_TOKEN_SLOWED_AT ?? 0), succeededAt = Number(process.env.MODELDOCK_SMOKE_COPILOT_TOKEN_SUCCEEDED_AT ?? 0);
  return { polls: Number(process.env.MODELDOCK_SMOKE_COPILOT_AUTH_POLLS ?? 0), http400Responses: count('HTTP_400'), http200Responses: count('HTTP_200'),
    authorizationPending400: count('PENDING_400'), slowDown400: count('SLOW_DOWN_400'), success200: count('SUCCESS_200'), slowDownGapMs: slowedAt && succeededAt ? succeededAt - slowedAt : null,
    githubUserApiVersion: process.env.MODELDOCK_SMOKE_GITHUB_USER_API_VERSION ?? null, githubUserHttp200: Number(process.env.MODELDOCK_SMOKE_GITHUB_USER_HTTP_200 ?? 0), githubUserHttp400: Number(process.env.MODELDOCK_SMOKE_GITHUB_USER_HTTP_400 ?? 0),
    copilotUsageApiVersion: process.env.MODELDOCK_SMOKE_COPILOT_USAGE_API_VERSION ?? null, copilotUsageWrongVersion400: Number(process.env.MODELDOCK_SMOKE_COPILOT_USAGE_WRONG_VERSION_400 ?? 0) };
}
export async function authQuotaFixture(url: URL, init?: RequestInit): Promise<Response | undefined> {
  if (!process.env.MODELDOCK_SMOKE || process.env.MODELDOCK_SMOKE_AUTH_MOCK !== '1') return undefined;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const seconds = Math.floor(Date.now() / 1000);
  const kind = url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/wham/usage' ? 'codex'
    : url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/wham/rate-limit-reset-credits' ? 'credits'
      : url.origin === 'https://grok.com' && url.pathname === '/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig' ? 'grok'
        : url.origin === 'https://api.github.com' && url.pathname === '/copilot_internal/user' ? 'copilot' : undefined;
  if (kind === 'copilot') {
    const version = new Headers(init?.headers).get('X-GitHub-Api-Version');
    process.env.MODELDOCK_SMOKE_COPILOT_USAGE_API_VERSION = version ?? 'missing';
    if (version !== '2025-10-01') {
      fixtureCounter('MODELDOCK_SMOKE_COPILOT_USAGE_WRONG_VERSION_400');
      return json({ message: 'PRIVATE_SYNTHETIC_COPILOT_USAGE_VERSION_ERROR' }, 400);
    }
  }
  if (kind) {
    // Preserve realistic overlap across separate Electron IPC deliveries.
    await new Promise(resolve => setTimeout(resolve, 150));
    const counter = `MODELDOCK_SMOKE_QUOTA_${kind.toUpperCase()}_CALLS`;
    process.env[counter] = String(Number(process.env[counter] ?? 0) + 1);
    if (process.env.MODELDOCK_SMOKE_QUOTA_MODE === 'network-error') throw new TypeError('Synthetic quota network failure');
    if (process.env.MODELDOCK_SMOKE_QUOTA_MODE === 'unauthorized') return json({}, 401);
    if (process.env.MODELDOCK_SMOKE_QUOTA_MODE === 'unknown') return json({});
  }
  if (kind === 'codex') return json({ plan_type: 'plus', rate_limit: {
    primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: seconds + 3 * 3600 },
    secondary_window: { used_percent: 36, limit_window_seconds: 604800, reset_at: seconds + 3 * 86400 + 10 * 3600 },
  }, rate_limit_reset_credits: { available_count: 2 } });
  if (kind === 'credits') return json({ credits: [16, 30].map(days => ({ status: 'available', expires_at: new Date(Date.now() + days * 86400_000).toISOString() })) });
  if (kind === 'grok') {
    const varint = (value: number): number[] => { const result: number[] = []; do { const byte = value % 128; value = Math.floor(value / 128); result.push(byte | (value ? 128 : 0)); } while (value); return result; };
    const used = new Uint8Array(5); used[0] = 13; new DataView(used.buffer).setFloat32(1, 22, true);
    const reset = [8, ...varint(seconds + 5 * 86400 + 8 * 3600)], inner = [...used, 42, reset.length, ...reset], message = [10, inner.length, ...inner];
    const frame = new Uint8Array(message.length + 5); new DataView(frame.buffer).setUint32(1, message.length, false); frame.set(message, 5);
    return new Response(frame, { headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '0' } });
  }
  if (kind === 'copilot') return json({ copilot_plan: 'individual', token_based_billing: true,
    quota_reset_date_utc: new Date(Date.now() + 25 * 86400_000 + 2 * 3600_000).toISOString(),
    quota_snapshots: { premium_interactions: { entitlement: '1000', quota_remaining: '820', credits_used: '180', percent_remaining: 82, unlimited: false } },
  });
  if (url.origin === 'https://github.com' && url.pathname === '/login/device/code') {
    process.env.MODELDOCK_SMOKE_COPILOT_AUTH_POLLS = '0';
    for (const name of ['HTTP_400', 'HTTP_200', 'PENDING_400', 'SLOW_DOWN_400', 'SUCCESS_200']) process.env[`MODELDOCK_SMOKE_COPILOT_TOKEN_${name}`] = '0';
    for (const key of ['MODELDOCK_SMOKE_GITHUB_USER_HTTP_200', 'MODELDOCK_SMOKE_GITHUB_USER_HTTP_400', 'MODELDOCK_SMOKE_COPILOT_USAGE_WRONG_VERSION_400']) process.env[key] = '0';
    delete process.env.MODELDOCK_SMOKE_GITHUB_USER_API_VERSION; delete process.env.MODELDOCK_SMOKE_COPILOT_USAGE_API_VERSION;
    delete process.env.MODELDOCK_SMOKE_COPILOT_TOKEN_SLOWED_AT; delete process.env.MODELDOCK_SMOKE_COPILOT_TOKEN_SUCCEEDED_AT;
    return json({ device_code: 'SYNTHETIC_COPILOT_DEVICE', user_code: 'DEMO-1234', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 });
  }
  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
    const poll = Number(process.env.MODELDOCK_SMOKE_COPILOT_AUTH_POLLS ?? 0) + 1;
    process.env.MODELDOCK_SMOKE_COPILOT_AUTH_POLLS = String(poll);
    if (process.env.MODELDOCK_SMOKE_COPILOT_AUTH_PENDING === '1' || process.env.MODELDOCK_SMOKE_COPILOT_AUTH_FLOW === 'http400-polling' && poll === 1) {
      tokenCounter('HTTP_400'); tokenCounter('PENDING_400');
      return json({ error: 'authorization_pending', error_description: 'PRIVATE_SYNTHETIC_PENDING_BODY' }, 400);
    }
    if (process.env.MODELDOCK_SMOKE_COPILOT_AUTH_FLOW === 'http400-polling' && poll === 2) {
      tokenCounter('HTTP_400'); tokenCounter('SLOW_DOWN_400'); process.env.MODELDOCK_SMOKE_COPILOT_TOKEN_SLOWED_AT = String(Date.now());
      return json({ error: 'slow_down', interval: 1, error_description: 'PRIVATE_SYNTHETIC_SLOW_DOWN_BODY' }, 400);
    }
    tokenCounter('HTTP_200'); tokenCounter('SUCCESS_200'); process.env.MODELDOCK_SMOKE_COPILOT_TOKEN_SUCCEEDED_AT = String(Date.now());
    return json({ access_token: 'SYNTHETIC_COPILOT_QUOTA_TOKEN', token_type: 'bearer', scope: 'read:user' });
  }
  if (url.origin === 'https://api.github.com' && url.pathname === '/user') {
    const version = new Headers(init?.headers).get('X-GitHub-Api-Version');
    process.env.MODELDOCK_SMOKE_GITHUB_USER_API_VERSION = version ?? 'missing';
    // Enforce the reviewed, pinned public REST contract independently of the
    // private Copilot quota header. This synthetic HTTP 400 regression guard
    // does not claim an authenticated live reproduction of the user's failure.
    if (version !== '2022-11-28') { fixtureCounter('MODELDOCK_SMOKE_GITHUB_USER_HTTP_400'); return json({ message: 'PRIVATE_SYNTHETIC_GITHUB_USER_VERSION_ERROR' }, 400); }
    fixtureCounter('MODELDOCK_SMOKE_GITHUB_USER_HTTP_200');
    return json({ id: 424242, login: 'quota-demo', name: 'GitHub 演示账号', email: 'copilot-demo@example.test',
      ...(process.env.MODELDOCK_SMOKE_AVATAR_FIXTURE === '1' ? { avatar_url: 'https://avatars.githubusercontent.com/u/424242?v=4' } : {}) });
  }
  return undefined;
}
