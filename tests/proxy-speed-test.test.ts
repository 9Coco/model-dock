import { expect, it } from 'vitest';
import { measureSiteLatency } from '../src/main/proxy-speed-test';
import { NETWORK_SITES, NETWORK_SITE_URLS } from '../src/shared/flowbridge-types';

it('times the twelve fixed HTTPS origins with headers only and isolates blocked or unreachable sites', async () => {
  const results = await Promise.all(NETWORK_SITES.map(site => {
    let clock = 0;
    return measureSiteLatency(site, async (url, init) => {
      expect(url).toBe(NETWORK_SITE_URLS[site]);
      expect(init).toMatchObject({ method: 'HEAD', credentials: 'omit', redirect: 'manual', cache: 'no-store' });
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
    { site: 'GitHub', state: 'unreachable' }, { site: 'Cloudflare', state: 'unreachable' },
  ]);
  expect(results.slice(6)).toEqual(NETWORK_SITES.slice(6).map(site => ({ site, state: 'response', ms: 123, httpStatus: 200 })));
});
