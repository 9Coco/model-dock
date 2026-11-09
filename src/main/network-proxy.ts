export interface NetworkProxyConfig {
  mode: 'system' | 'fixed_servers';
  proxyRules?: string;
  proxyBypassRules?: string;
}

/** This changes only the injected application's networking session. */
export interface NetworkProxySession {
  setProxy(config: NetworkProxyConfig): void | Promise<void>;
}

const invalidProxy = () => new Error('代理地址格式无效：请填写本机 HTTP、HTTPS 或 SOCKS5 地址及端口。');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Empty text follows system settings; explicit proxies must stay on loopback. */
export function validateProxyUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f\u200b-\u200d\u2060\ufeff]/.test(value)) throw invalidProxy();
  const text = value.trim();
  if (!text) return '';
  // Inspect the literal authority before URL normalization. The URL parser
  // otherwise accepts alternate IPv4 spellings and hides explicit default ports.
  const parts = /^(https?|socks5):\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(text);
  if (!parts) throw invalidProxy();
  const protocol = parts[1].toLowerCase(), host = parts[2].toLowerCase(), port = Number(parts[3]);
  if (!localHosts.has(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw invalidProxy();
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw invalidProxy(); }
  if (parsed.protocol !== `${protocol}:` || parsed.hostname.toLowerCase() !== host || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw invalidProxy();
  return `${protocol}://${host}:${port}`;
}

/** Do not close active connections or modify operating-system proxy settings. */
export async function applyNetworkProxy(session: NetworkProxySession, url: unknown): Promise<void> {
  const validated = validateProxyUrl(url);
  const config: NetworkProxyConfig = validated
    ? { mode: 'fixed_servers', proxyRules: validated, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' }
    : { mode: 'system' };
  try { await session.setProxy(config); }
  catch { throw new Error('无法应用应用内代理设置，请检查本机代理服务和端口后重试。'); }
}

/** Model requests and authorization use the same session as the active HTTP relay.
 * The relay is ephemeral. Only the user's explicit override is persisted.
 */
export class ApplicationNetworkSession {
  private configured = '';
  private relayPort: number | null = null;
  private relayInterrupted = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private session: NetworkProxySession & { fetch: typeof fetch }) {}

  setConfiguredProxy(url: string): Promise<void> {
    this.configured = validateProxyUrl(url);
    return this.apply();
  }

  setHttpRelay(port: number | null): Promise<void> {
    if (port !== null && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
      throw new Error('网络组件返回了无效的本机代理端口。');
    }
    this.relayPort = port;
    this.relayInterrupted = false;
    return this.configured ? this.pending : this.apply();
  }

  suspendHttpRelay(): void {
    // A closed listener's port can be reused by a different process before OS cleanup finishes.
    if (this.relayPort !== null) this.relayInterrupted = true;
  }

  private apply(): Promise<void> {
    const effective = this.configured || (this.relayPort && !this.relayInterrupted ? `http://127.0.0.1:${this.relayPort}` : '');
    this.pending = this.pending.catch(() => {}).then(() => applyNetworkProxy(this.session, effective));
    return this.pending;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let ready: Promise<void>;
    do {
      ready = this.pending;
      await ready;
    } while (ready !== this.pending);
    if (this.relayInterrupted && !this.configured) throw new Error('网络连接正在恢复，请在服务工作台确认连接后重试。');
    return this.session.fetch(input, init);
  }
}
