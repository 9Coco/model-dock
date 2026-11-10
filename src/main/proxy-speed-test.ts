import { performance } from 'node:perf_hooks';
import { NETWORK_PROBE_URLS, type NetworkFailure, type NetworkSite, type SiteLatency } from '../shared/flowbridge-types';

/** Inspect transport codes locally and expose only a fixed category to the renderer. */
function transportFailure(error: unknown, timedOut: boolean): NetworkFailure {
  const evidence: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    for (const part of [value.name, value.code, value.message]) if (typeof part === 'string') evidence.push(part);
    current = value.cause;
  }
  const text = evidence.join(' ');
  if (timedOut || /TimeoutError|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|UND_ERR_(?:CONNECT|HEADERS)_TIMEOUT/i.test(text)) return 'timeout';
  if (/Redirect was cancelled|ERR_TOO_MANY_REDIRECTS|ERR_UNSAFE_REDIRECT/i.test(text)) return 'redirect';
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_DNS_/i.test(text)) return 'dns';
  if (/ERR_CERT_|ERR_SSL_|ERR_TLS_|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(text)) return 'tls';
  if (/ERR_PROXY_|ERR_SOCKS_|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED/i.test(text)) return 'proxy';
  return 'connection';
}

/** Electron rejects manual redirects; follow anonymous HEAD requests within the total deadline. */
export async function measureSiteLatency(site: NetworkSite, fetcher: (url: string, init: RequestInit) => Promise<Response>, now = () => performance.now()): Promise<SiteLatency> {
  const signal = AbortSignal.timeout(10_000);
  const start = now();
  try {
    const reply = await fetcher(NETWORK_PROBE_URLS[site], {
      method: 'HEAD', signal, credentials: 'omit', cache: 'no-store', redirect: 'follow',
    });
    const ms = Math.round(now() - start);
    void reply.body?.cancel().catch(() => {});
    if (reply.status === 407) return { site, state: 'unreachable', failure: 'proxy' };
    if (reply.status === 0 && reply.type !== 'opaqueredirect') return { site, state: 'unreachable', failure: 'connection' };
    return { site, state: 'response', ms, httpStatus: reply.status || null };
  } catch (error) {
    const failure = transportFailure(error, signal.aborted);
    return { site, state: failure === 'timeout' ? 'timeout' : 'unreachable', failure };
  }
}
