import { expect, it } from 'vitest';
import { measureProxySpeed, measureSiteLatency } from '../src/main/proxy-speed-test';
import { NETWORK_SITES, NETWORK_SITE_URLS } from '../src/shared/flowbridge-types';

it('times each fixed official origin, including restricted and redirect replies, and isolates unreachable sites', async () => {
  const results = await Promise.all(NETWORK_SITES.map(site => {
    let clock = 0;
    return measureSiteLatency(site, async (url, init) => {
      expect(url).toBe(NETWORK_SITE_URLS[site]);
      expect(init).toMatchObject({ method: 'HEAD', credentials: 'omit', redirect: 'manual', cache: 'no-store' });
      clock = 123;
      if (site === 'GitHub') throw new Error('Connection refused');
      const status = { Google: 200, YouTube: 204, X: 302, ChatGPT: 403, Cloudflare: 407 }[site];
      return new Response(null, { status });
    }, () => clock);
  }));
  expect(results).toEqual([
    { site: 'Google', state: 'response', ms: 123, httpStatus: 200 },
    { site: 'YouTube', state: 'response', ms: 123, httpStatus: 204 },
    { site: 'X', state: 'response', ms: 123, httpStatus: 302 },
    { site: 'ChatGPT', state: 'response', ms: 123, httpStatus: 403 },
    { site: 'GitHub', state: 'unreachable' }, { site: 'Cloudflare', state: 'unreachable' },
  ]);
});

it('reports the median HTTPS round trip without treating warm-up as steady-state latency', async () => {
  const samples = [450, 41, 38]; let clock = 0;
  const result = await measureProxySpeed('latency', async (url, init) => {
    expect(url).toBe('https://speed.cloudflare.com/__down?bytes=0');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' });
    clock += samples.shift()!; return new Response(null);
  }, () => clock);
  expect(samples).toHaveLength(0); expect(result).toBe(41);
});

it('measures complete transfers in decimal megabits per second', async () => {
  let clock = 0;
  for (const metric of ['download', 'upload'] as const) {
    const bytes = metric === 'upload' ? 1024 ** 2 : 4 * 1024 ** 2;
    const result = await measureProxySpeed(metric, async (url, init) => {
      clock += 250;
      if (metric === 'upload') {
        expect(url.endsWith('/__up')).toBe(true); expect(init.method).toBe('POST');
        expect((init.body as Uint8Array).byteLength).toBe(bytes); return new Response('ok');
      }
      expect(url.endsWith('bytes='+bytes)).toBe(true); return new Response(new Uint8Array(bytes));
    }, () => clock);
    expect(result).toBe(bytes * 8 / 250_000);
  }
});

it('rejects blocked, short or oversized downloads instead of reporting a successful speed', async () => {
  await expect(measureProxySpeed('download', async () => new Response(null, { status: 403 }))).rejects.toThrow(/403/);
  await expect(measureProxySpeed('download', async () => new Response('proxy landing page'))).rejects.toThrow(/未完成/);
  await expect(measureProxySpeed('latency', async () => new Response('proxy landing page'))).rejects.toThrow(/大小/);
});
