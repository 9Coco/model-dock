import { describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { JetBrainsIdeApi, JetBrainsIdeApiError } from '../src/main/jetbrains-ide-api';

// Entirely synthetic credentials and public native DTO shapes. No installed
// account files, keychain, real service, IDE process or Central executable.
const NOW = Date.UTC(2026, 10, 5, 12);
const token = (subject = 'fixture', expires = NOW + 3_600_000) => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: subject, exp: expires / 1000 })).toString('base64url'),
  Buffer.from('SYNTHETIC_SIGNATURE_NOT_A_CREDENTIAL').toString('base64url'),
].join('.');
const ID = token('fixture-jba'), AI = token('fixture-grazie');
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const nativeProfile = (id = 'openai-gpt-fixture') => ({ id, features: ['Chat', 'Responses'], provider: 'OpenAI', providerModelID: 'gpt-native-fixture', modelName: 'Fixture GPT', contextLimit: 128000, maxOutputTokens: 16000, chatDefinition: { roles: ['system', 'user', 'assistant', 'tool'], parameters: {} }, lifeCycle: { deprecated: false, experimental: false, preview: false } });
function mockTransport(handle: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (url, init) => handle(String(url), init ?? {}));
}
const signal = () => new AbortController().signal;

describe('JetBrains native IDE API', () => {
  it('exchanges an ID JWT plus selected license and verifies the derived JWT with the exact native paths', async () => {
    const fetch = mockTransport((url, init) => {
      expect(url.startsWith('https://api.jetbrains.ai/')).toBe(true);
      expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit'); expect(init.cache).toBe('no-store');
      if (url.endsWith('/auth/jetbrains-jwt/provide-access/license/v2')) {
        expect(init.method).toBe('POST'); expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${ID}`);
        expect(JSON.parse(String(init.body))).toEqual({ licenseId: 'fixture-license-42' });
        return reply({ state: 'Registered', token: AI });
      }
      expect(url).toBe('https://api.jetbrains.ai/user/v5/auth/jwt/verify/v3');
      expect(init.method).toBe('POST'); expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).get('Grazie-Authenticate-JWT')).toBe(AI);
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      expect(JSON.parse(new Headers(init.headers).get('Grazie-Agent')!)).toEqual({ name: 'modeldock', version });
      return reply({ expires: NOW + 120_000 });
    });
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    expect(await api.exchange({ idToken: ID, licenseId: 'fixture-license-42' })).toEqual({ token: AI, expiresAt: NOW + 120_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { idToken: 'not-a-jwt', licenseId: 'fixture' },
    { idToken: ID, licenseId: '' },
    { idToken: ID, licenseId: 'fixture\r\nX-Header:secret' },
  ])('rejects invalid source credentials without a request', async input => {
    const fetch = mockTransport(() => { throw new Error('must not run'); });
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).exchange(input)).rejects.toBeInstanceOf(JetBrainsIdeApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not accept a merely parseable token without a successful native verification', async () => {
    const fetch = mockTransport(url => url.includes('provide-access') ? reply({ state: 'Registered', token: AI }) : reply({ error: 'PRIVATE_JBA_TOKEN_RAW_BODY' }, 401));
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).exchange({ idToken: ID, licenseId: 'fixture' })).rejects.toMatchObject({ code: 'authorization' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('lets the native server validate the unchanged identity ticket despite an old source exp and NONE state', async () => {
    const oldIdentity = token('fixture-jba-long-lived-identity', NOW - 86_400_000);
    const fetch = mockTransport((url, init) => {
      if (url.endsWith('/auth/jetbrains-jwt/provide-access/license/v2')) {
        expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${oldIdentity}`);
        expect(JSON.parse(String(init.body))).toEqual({ licenseId: 'fixture-license' });
        return reply({ state: 'NONE', token: AI });
      }
      expect(url).toBe('https://api.jetbrains.ai/user/v5/auth/jwt/verify/v3');
      expect(new Headers(init.headers).get('Grazie-Authenticate-JWT')).toBe(AI);
      return reply({ expires: NOW + 90_000 });
    });
    expect(await new JetBrainsIdeApi({ fetch, now: () => NOW }).exchange({ idToken: oldIdentity, licenseId: 'fixture-license' })).toEqual({ token: AI, expiresAt: NOW + 90_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => !String(url).endsWith('/register'))).toBe(true);
  });

  it('respects a server rejection of an old identity ticket without retrying or registering', async () => {
    const fetch = mockTransport(() => reply({ state: 'NONE', error: 'PRIVATE_OLD_IDENTITY_FAILURE' }, 401));
    const error = await new JetBrainsIdeApi({ fetch, now: () => NOW }).exchange({ idToken: token('old-identity', NOW - 1000), licenseId: 'fixture' }).catch(value => value);
    expect(error).toMatchObject({ code: 'authorization' }); expect(String(error)).not.toContain('PRIVATE_'); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('still rejects an expired derived access JWT even when the source identity exp is only a hint', async () => {
    const fetch = mockTransport(() => reply({ state: 'NONE', token: token('expired-derived-access', NOW - 1000) }));
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).exchange({ idToken: token('old-source-identity', NOW - 1000), licenseId: 'fixture' })).rejects.toMatchObject({ code: 'authorization' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps native JCP access tokens distinct from ID JWTs and uses the proven JCP exchange', async () => {
    const accessToken = 'SDK_ACCESS_TOKEN_SYNTHETIC_NOT_A_JWT';
    const fetch = mockTransport((url, init) => {
      if (url.includes('provide-access')) {
        expect(url).toBe('https://api.jetbrains.ai/auth/jcp/provide-access/global-access-token');
        expect(init.method).toBe('POST'); expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${accessToken}`);
        expect(JSON.parse(String(init.body))).toEqual({ licenseId: 'fixture-jcp-license' });
        return reply({ token: AI });
      }
      expect(url).toBe('https://api.jetbrains.ai/user/v5/auth/jwt/verify/v3');
      expect(new Headers(init.headers).get('Grazie-Authenticate-JWT')).toBe(AI);
      return reply({ expires: NOW + 90_000 });
    });
    expect(await new JetBrainsIdeApi({ fetch, now: () => NOW }).exchangeJcp({ accessToken, licenseId: 'fixture-jcp-license' })).toEqual({ token: AI, expiresAt: NOW + 90_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['', 'short', 'SDK_ACCESS_TOKEN\r\nPRIVATE_HEADER', 'x'.repeat(65_537)])('rejects invalid JCP bearer material without forwarding it', async accessToken => {
    const fetch = mockTransport(() => reply({}));
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).exchangeJcp({ accessToken, licenseId: 'fixture' })).rejects.toMatchObject({ code: 'credentials' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not return JCP source credentials or raw SDK exchange failures', async () => {
    const accessToken = 'SDK_ACCESS_TOKEN_SYNTHETIC_NOT_A_JWT';
    const fetch = mockTransport(() => reply({ error: `PRIVATE_SDK_FAILURE ${accessToken}` }, 403));
    const error = await new JetBrainsIdeApi({ fetch, now: () => NOW }).exchangeJcp({ accessToken, licenseId: 'fixture' }).catch(value => value);
    expect(error).toMatchObject({ code: 'entitlement' }); expect(String(error)).not.toMatch(/PRIVATE_|SDK_ACCESS/); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([NOW - 1, '2026-11-05T12:10:00Z', null])('requires a future native millisecond verification expiry (%s)', async expires => {
    const fetch = mockTransport(url => url.includes('provide-access') ? reply({ token: AI }) : reply({ expires }));
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).exchange({ idToken: ID, licenseId: 'fixture' })).rejects.toBeInstanceOf(JetBrainsIdeApiError);
  });

  it('does not invent a subscription tier from credit amounts, license IDs or undocumented extra plan fields', async () => {
    for (const maximum of ['0', '10', '1000']) {
      const fetch = mockTransport(() => reply({ plan: 'AI Ultimate', current: { current: '0', maximum, license: 'fixture-AIPU-license', productType: 'AIPU', tariffName: 'AI Pro' } }));
      const usage = await new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI);
      expect(usage.status).toBe('ready'); expect(usage).not.toHaveProperty('plan'); expect(JSON.stringify(usage)).not.toMatch(/Ultimate|AI Pro|AIPU/);
    }
  });

  it('projects native scalar/object credit DTOs as spent and remaining amounts, with millisecond reset time', async () => {
    const fetch = mockTransport((url, init) => {
      expect(url).toBe('https://api.jetbrains.ai/user/v5/quota/get'); expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined(); expect(new Headers(init.headers).get('Grazie-Authenticate-JWT')).toBe(AI);
      return reply({ current: { license: 'fixture-license', current: { amount: '5.000000000000' }, maximum: { amount: '20.000000000000' }, until: NOW + 86_400_000, quotaID: 'quota-fixture', tariffQuota: { current: '2', maximum: '10', available: '8' }, topUpQuota: { current: { amount: '3' }, maximum: { amount: '10' }, available: { amount: '7' } } } });
    });
    const usage = await new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI);
    expect(usage).toMatchObject({ status: 'ready', queriedAt: new Date(NOW).toISOString(), windows: [
      { id: 'jetbrains-tariff', total: 10, remaining: 8, usedPercent: 20, remainingPercent: 80, resetAt: new Date(NOW + 86_400_000).toISOString(), unit: 'AI Credits' },
      { id: 'jetbrains-top-up', total: 10, remaining: 7, usedPercent: 30, remainingPercent: 70, unit: 'AI Credits' },
    ] });
    expect(usage.windows[1].resetAt).toBeUndefined(); expect(JSON.stringify(usage)).not.toContain('fixture-license');
  });

  it('keeps incomplete and conflicting quota observations unknown instead of inventing percentages', async () => {
    const fetch = mockTransport(() => reply({ current: { maximum: '20', tariffQuota: { maximum: '20' }, topUpQuota: { current: '5', maximum: '20', available: '1' } } }));
    const usage = await new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI);
    expect(usage.windows[0]).toMatchObject({ total: 20 });
    expect(usage.windows[0].remaining).toBeUndefined(); expect(usage.windows[0].usedPercent).toBeUndefined();
    expect(usage.windows[1]).toMatchObject({ total: 20, remaining: 1 }); expect(usage.windows[1].usedPercent).toBeUndefined();
  });

  it('supports the original total-credit shape without double-counting tariff and top-up', async () => {
    const fetch = mockTransport(() => reply({ current: { current: { amount: '3.5' }, maximum: '20' } }));
    const usage = await new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI);
    expect(usage.windows).toHaveLength(1); expect(usage.windows[0]).toMatchObject({ id: 'jetbrains-total', total: 20, remaining: 16.5, usedPercent: 17.5 });
  });

  it('publishes verified vendor Chat profiles while retaining strict native OpenAI IDs', async () => {
    const profile = nativeProfile();
    const fetch = mockTransport((url, init) => {
      expect(url).toBe('https://api.jetbrains.ai/user/v5/llm/profiles/v9'); expect(init.method).toBe('GET');
      return reply({ profiles: [profile, { ...profile, id: 'anthropic', provider: 'Anthropic' }, { ...profile, id: 'gemini', provider: 'Google', providerModelID: null }, { ...profile, id: 'vertex-claude', provider: 'GoogleVertexAnthropic' }, { ...profile, id: 'bedrock', provider: 'Bedrock' }, { ...profile, id: 'xai', provider: 'Xai' }, { ...profile, id: 'vllm', provider: 'vLLM' }, { ...profile, id: 'unknown', provider: null }, { ...profile, id: 'old', lifeCycle: { deprecated: true } }, { ...profile, id: 'no-native-id', providerModelID: null }, { ...profile, id: 'fim-only', features: ['Completion'] }, { ...profile, id: 'no-chat', chatDefinition: null }, { ...profile, id: 'azure-fixture', provider: 'AzureOpenAI', providerModelID: 'deployment-fixture' }] });
    });
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    const models = await api.models(AI);
    expect(models.data.map(value => value.id)).toEqual(['openai-gpt-fixture', 'anthropic', 'gemini', 'vertex-claude', 'bedrock', 'xai', 'vllm', 'azure-fixture']);
    expect(models.data[0]).toEqual({ id: profile.id, object: 'model', owned_by: 'jetbrains', name: 'Fixture GPT', context_length: 128000, max_output_tokens: 16000 });
    expect(JSON.stringify(models)).not.toContain('gpt-native-fixture');
    models.data[0].id = 'mutated-outside';
    await expect(api.chat(AI, { model: 'mutated-outside', messages: [{ role: 'user', content: 'fixture' }] }, signal())).rejects.toMatchObject({ code: 'model' });
  });

  it('drops ambiguous duplicate profile IDs instead of selecting an arbitrary upstream', async () => {
    const fetch = mockTransport(() => reply({ profiles: [nativeProfile(), { ...nativeProfile(), providerModelID: 'other-fixture' }, nativeProfile()] }));
    expect(await new JetBrainsIdeApi({ fetch, now: () => NOW }).models(AI)).toEqual({ data: [] });
  });

  it.each([['OpenAI', 'llm/openai/v1'], ['AzureOpenAI', 'llm/azure/openai/v1']])('forwards native %s chat exactly once and preserves tools, images and stream fields', async (provider, prefix) => {
    const body = { model: 'openai-gpt-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic image question' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,SYNTHETIC' } }] }], tools: [{ type: 'function', function: { name: 'fixture', parameters: { type: 'object' } } }], tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, reasoning_effort: 'low' };
    const fetch = mockTransport((url, init) => {
      if (url.endsWith('profiles/v9')) return reply({ profiles: [{ ...nativeProfile(), provider }] });
      expect(url).toBe(`https://api.jetbrains.ai/user/v5/${prefix}/chat/completions`);
      expect(init.method).toBe('POST'); expect(JSON.parse(String(init.body))).toEqual({ ...body, model: 'gpt-native-fixture' });
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      return new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-private-upstream': 'not-forwarded' } });
    });
    const response = await new JetBrainsIdeApi({ fetch, now: () => NOW }).chat(AI, body, signal());
    expect(response.headers.has('x-private-upstream')).toBe(false); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('[DONE]'); expect(fetch).toHaveBeenCalledTimes(2); expect(body.model).toBe('openai-gpt-fixture');
  });

  it('uses an account-specific expiring directory and removes stale authorization after a refresh failure', async () => {
    let now = NOW, deny = false;
    const fetch = mockTransport((url, init) => {
      if (url.endsWith('profiles/v9')) return deny ? reply({ error: 'PRIVATE_ENTITLEMENT_BODY' }, 403) : reply({ profiles: [nativeProfile()] });
      expect(JSON.parse(String(init.body)).model).toBe('gpt-native-fixture'); return reply({ choices: [] });
    });
    const api = new JetBrainsIdeApi({ fetch, now: () => now });
    await api.models(AI); deny = true;
    await expect(api.chat(token('different-account'), { model: nativeProfile().id, messages: [{}] }, signal())).rejects.toMatchObject({ code: 'entitlement' });
    now += 5 * 60_000;
    await expect(api.chat(AI, { model: nativeProfile().id, messages: [{}] }, signal())).rejects.toMatchObject({ code: 'entitlement' });
    expect(fetch.mock.calls.filter(([url]) => !String(url).endsWith('profiles/v9'))).toHaveLength(0);
  });

  it('never retries an upstream inference or exposes its error body', async () => {
    const fetch = mockTransport(url => url.endsWith('profiles/v9') ? reply({ profiles: [nativeProfile()] }) : reply({ error: `PRIVATE_NATIVE_TOKEN_RAW_BODY ${AI}` }, 429));
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    const error = await api.chat(AI, { model: nativeProfile().id, messages: [{}] }, signal()).catch(value => value);
    expect(error).toMatchObject({ name: 'JetBrainsIdeApiError', code: 'network' }); expect(String(error)).not.toMatch(/PRIVATE_|eyJ/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects caller URL injection, invalid models and oversized requests before inference', async () => {
    const fetch = mockTransport(url => { expect(url.endsWith('profiles/v9')).toBe(true); return reply({ profiles: [nativeProfile()] }); });
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    await expect(api.chat(AI, { model: 'https://attacker.invalid', messages: [] }, signal())).rejects.toMatchObject({ code: 'request' });
    await expect(api.chat(AI, { model: 'not-authorized', messages: [{}] }, signal())).rejects.toMatchObject({ code: 'model' });
    await expect(api.chat(AI, { model: nativeProfile().id, messages: [{ content: 'x'.repeat(2 * 1024 * 1024) }] }, signal())).rejects.toMatchObject({ code: 'limit' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates pre-request cancellation without network or exposing transport exceptions', async () => {
    const fetch = mockTransport(() => { throw new Error(`PRIVATE_NETWORK ${ID}`); });
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW }); const controller = new AbortController(); controller.abort();
    await expect(api.models(AI, controller.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(fetch).not.toHaveBeenCalled();
    const error = await api.quota(AI).catch(value => value);
    expect(error.code).toBe('network'); expect(String(error)).not.toMatch(/PRIVATE_|eyJ/);
  });

  it('cancels native chat streaming when its local caller disconnects', async () => {
    let cancelled = false;
    const fetch = mockTransport(url => url.endsWith('profiles/v9') ? reply({ profiles: [nativeProfile()] }) : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: fixture\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
    const controller = new AbortController();
    const response = await new JetBrainsIdeApi({ fetch, now: () => NOW }).chat(AI, { model: nativeProfile().id, messages: [{}], stream: true }, controller.signal);
    const reader = response.body!.getReader(); await reader.read(); controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ code: 'cancelled' }); expect(cancelled).toBe(true);
  });

  it('cancels an in-progress quota body without relying on transport-specific abort handling', async () => {
    let cancelled = false;
    const fetch = mockTransport(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
    const controller = new AbortController();
    const pending = new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' }); expect(cancelled).toBe(true);
  });

  it('bounds quota streaming even when no content length is supplied', async () => {
    let cancelled = false;
    const fetch = mockTransport(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI)).rejects.toMatchObject({ code: 'limit' }); expect(cancelled).toBe(true);
  });

  it('bounds chat streaming and sanitizes a native reader failure', async () => {
    const fetch = mockTransport(url => url.endsWith('profiles/v9') ? reply({ profiles: [nativeProfile()] }) : new Response(new ReadableStream({ start(controller) { controller.error(new Error(`PRIVATE_READER_FAILURE ${AI}`)); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const response = await new JetBrainsIdeApi({ fetch, now: () => NOW }).chat(AI, { model: nativeProfile().id, messages: [{}], stream: true }, signal());
    const error = await response.text().catch(value => value);
    expect(error).toMatchObject({ code: 'network' }); expect(String(error)).not.toMatch(/PRIVATE_|eyJ/);
    const oversizedFetch = mockTransport(url => url.endsWith('profiles/v9') ? reply({ profiles: [nativeProfile()] }) : new Response(new Uint8Array(32 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/event-stream' } }));
    const oversized = await new JetBrainsIdeApi({ fetch: oversizedFetch, now: () => NOW }).chat(AI, { model: nativeProfile().id, messages: [{}], stream: true }, signal());
    await expect(oversized.text()).rejects.toMatchObject({ code: 'limit' });
  });

  it.each([
    () => new Response('{"current":{}}', { headers: { 'content-type': 'text/html' } }),
    () => new Response('PRIVATE_INVALID_JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } }),
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } }),
  ])('rejects malformed, oversized or redirected quota responses safely', async response => {
    const fetch = mockTransport(response); const error = await new JetBrainsIdeApi({ fetch, now: () => NOW }).quota(AI).catch(value => value);
    expect(error).toBeInstanceOf(JetBrainsIdeApiError); expect(String(error)).not.toMatch(/PRIVATE_|attacker/); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('JetBrains native multi-vendor V9 routing', () => {
  const sse = (content = 'vendor answer') => new Response(`data: ${JSON.stringify({ type: 'Content', event_type: 'data', content, choiceIndex: 0 })}\n\ndata: ${JSON.stringify({ type: 'FinishMetadata', event_type: 'data', reason: 'stop', choiceIndex: 0 })}\n\ndata: end\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  it.each(['Anthropic', 'Google', 'GoogleVertexAnthropic', 'Bedrock', 'Xai', 'vLLM'])('calls %s by its exact authorized profile ID through the official V9 endpoint once', async provider => {
    const profile = { ...nativeProfile('native-vendor-profile'), provider, providerModelID: 'different-private-native-id' };
    const fetch = mockTransport((url, init) => {
      if (url.endsWith('profiles/v9')) return reply({ profiles: [profile] });
      expect(url).toBe('https://api.jetbrains.ai/user/v5/llm/chat/stream/v9');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('Grazie-Authenticate-JWT')).toBe(AI);
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
      expect(JSON.parse(String(init.body))).toMatchObject({ prompt: 'modeldock', profile: profile.id, chat: { messages: [{ type: 'user_message', content: 'q' }] } });
      expect(String(init.body)).not.toContain(profile.providerModelID);
      return sse();
    });
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    const response = await api.chat(AI, { model: profile.id, messages: [{ role: 'user', content: 'q' }], stream: false }, signal());
    expect(response.headers.get('content-type')).toContain('application/json');
    const answer = await response.json();
    expect(answer).toMatchObject({ model: profile.id, choices: [{ message: { role: 'assistant', content: 'vendor answer' }, finish_reason: 'stop' }] });
    expect(JSON.stringify(answer)).not.toContain('PRIVATE'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('projects only official V9 tool/media descriptors and retains unknown capability fields', async () => {
    const profiles = [
      { ...nativeProfile('claude'), provider: 'Anthropic', chatDefinition: { roles: ['user', 'assistant', 'tool'], parameters: ['toolConfig.tools'], multimediaDataDefinition: { supportedTypes: ['image/png', 'image/jpeg'] } } },
      { ...nativeProfile('gemini'), provider: 'Google', chatDefinition: { roles: ['user', 'assistant'], parameters: ['toolConfig.tools'], multimediaDataDefinition: { supportedTypes: ['text/plain'] } } },
      { ...nativeProfile('unknown-capabilities'), provider: 'Anthropic' },
    ];
    const api = new JetBrainsIdeApi({ fetch: mockTransport(() => reply({ profiles })), now: () => NOW });
    const result = await api.models(AI);
    expect(result.data[0]).toMatchObject({ id: 'claude', tools: true, vision: true, context_length: 128000, max_output_tokens: 16000 });
    expect(result.data[1]).toMatchObject({ id: 'gemini', tools: false, vision: false });
    expect(result.data[2]).not.toHaveProperty('tools'); expect(result.data[2]).not.toHaveProperty('vision');
  });
  it('rejects unsupported reasoning before any inference POST and does not retry', async () => {
    const fetch = mockTransport(url => { expect(url.endsWith('profiles/v9')).toBe(true); return reply({ profiles: [{ ...nativeProfile('claude'), provider: 'Anthropic' }] }); });
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    await expect(api.chat(AI, { model: 'claude', messages: [{ role: 'user', content: 'q' }], reasoning_effort: 'high' }, signal())).rejects.toMatchObject({ code: 'capability' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects an HTTP 200 JSON error instead of presenting it as a successful native vendor answer', async () => {
    const fetch = mockTransport(url => url.endsWith('profiles/v9') ? reply({ profiles: [{ ...nativeProfile('gemini'), provider: 'Google' }] }) : reply({ error: 'PRIVATE_NATIVE_ERROR' }));
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    const error = await api.chat(AI, { model: 'gemini', messages: [{ role: 'user', content: 'q' }] }, signal()).catch(error => error);
    expect(error).toMatchObject({ code: 'response' }); expect(String(error)).not.toContain('PRIVATE'); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
