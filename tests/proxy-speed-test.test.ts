import { expect, it } from 'vitest';
import { measureSiteLatency } from '../src/main/proxy-speed-test';
import { NETWORK_SITES, NETWORK_SITE_URLS, NETWORK_PROBE_URLS } from '../src/shared/flowbridge-types';

it('times the twelve fixed HTTPS origins with headers only and isolates blocked or unreachable sites', async () => {
  const results = await Promise.all(NETWORK_SITES.map(site => {
    let clock = 0;
    return measureSiteLatency(site, async (url, init) => {
      expect(url).toBe(NETWORK_PROBE_URLS[site]);
      expect(init).toMatchObject({ method: 'HEAD', credentials: 'omit', redirect: 'follow', cache: 'no-store' });
      expect(init.body).toBeUndefined();
      expect(new URL(url).protocol).toBe('https:');
      clock = 123;
      if (site === 'GitHub') throw new Error('Connection refused');
      const status = ({ Google: 200, YouTube: 204, X: 302, ChatGPT: 403, Cloudflare: 407 } as Partial<Record<typeof site, number>>)[site] ?? 200;
      return new Response(null, { status });
    }, () => clock);
  }));
  expect(results).toHaveLength(12);
  expect(results.slice(0, 6)).toEqual([
    { site: 'Google', state: 'response', ms: 123, httpStatus: 200 },
    { site: 'YouTube', state: 'response', ms: 123, httpStatus: 204 },
    { site: 'X', state: 'response', ms: 123, httpStatus: 302 },
    { site: 'ChatGPT', state: 'response', ms: 123, httpStatus: 403 },
    { site: 'GitHub', state: 'unreachable', failure: 'connection' }, { site: 'Cloudflare', state: 'unreachable', failure: 'proxy' },
  ]);
  expect(results.slice(6)).toEqual(NETWORK_SITES.slice(6).map(site => ({ site, state: 'response', ms: 123, httpStatus: 200 })));
});

it('checks the anonymous JetBrains AI service while keeping its browser destination separate', async () => {
  expect(NETWORK_SITE_URLS['JetBrains AI']).toBe('https://www.jetbrains.com/ai/');
  for (const status of [401, 404, 405]) {
    const result = await measureSiteLatency('JetBrains AI', async (url, init) => {
      expect(url).toBe('https://api.jetbrains.ai/');
      expect(init.credentials).toBe('omit');
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeUndefined();
      return new Response(null, { status });
    }, () => 15);
    expect(result).toEqual({ site: 'JetBrains AI', state: 'response', ms: 0, httpStatus: status });
  }
});

it('reports bounded transport categories without exposing raw exception messages', async () => {
  const cases = [
    [new Error('net::ERR_NAME_NOT_RESOLVED private-token'), 'dns'],
    [new Error('net::ERR_SSL_PROTOCOL_ERROR private-token'), 'tls'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), 'tls'],
    [new Error('net::ERR_SOCKS_CONNECTION_FAILED private-token'), 'proxy'],
    [new Error('Redirect was cancelled private-token'), 'redirect'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }), 'timeout'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'connection'],
  ] as const;
  for (const [error, failure] of cases) {
    const result = await measureSiteLatency('JetBrains AI', async () => { throw error; });
    expect(result).toEqual({ site: 'JetBrains AI', state: failure === 'timeout' ? 'timeout' : 'unreachable', failure });
    expect(JSON.stringify(result)).not.toContain('private-token');
  }
});

it('releases an unexpected response body after recording response latency', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel: () => { cancelled = true; } });
  expect(await measureSiteLatency('Google', async () => new Response(stream), () => 0))
    .toEqual({ site: 'Google', state: 'response', httpStatus: 200, ms: 0 });
  expect(cancelled).toBe(true);
});
