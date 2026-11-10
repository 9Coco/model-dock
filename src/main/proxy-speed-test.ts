import { performance } from 'node:perf_hooks';
import { NETWORK_SITE_URLS, type NetworkSite, type SiteLatency } from '../shared/flowbridge-types';

/** Time the first HTTPS response from the named origin, including redirects and access restrictions. */
export async function measureSiteLatency(site: NetworkSite, fetcher: (url: string, init: RequestInit) => Promise<Response>, now = () => performance.now()): Promise<SiteLatency> {
  const signal = AbortSignal.timeout(10_000);
  const start = now();
  try {
    const reply = await fetcher(NETWORK_SITE_URLS[site], {
      method: 'HEAD', signal, credentials: 'omit', cache: 'no-store', redirect: 'manual',
    });
    if (reply.status === 407 || (reply.status === 0 && reply.type !== 'opaqueredirect')) return { site, state: 'unreachable' };
    return { site, state: 'response', ms: Math.round(now() - start), httpStatus: reply.status || null };
  } catch {
    return { site, state: signal.aborted ? 'timeout' : 'unreachable' };
  }
}
