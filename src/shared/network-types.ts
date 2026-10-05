export type AuthNetworkRoute = 'direct' | 'proxy' | 'unknown';
export type AuthNetworkErrorCode = 'ERR_TIMED_OUT' | 'ERR_CONNECTION_TIMED_OUT' | 'ERR_PROXY_CONNECTION_FAILED' | 'ERR_TUNNEL_CONNECTION_FAILED' | 'ERR_NAME_NOT_RESOLVED' | 'ERR_CONNECTION_REFUSED' | 'ERR_CONNECTION_CLOSED' | 'ERR_CONNECTION_RESET' | 'ERR_CERT_AUTHORITY_INVALID' | 'ERR_CERT_DATE_INVALID' | 'ERR_CERT_COMMON_NAME_INVALID' | 'ERR_NETWORK_CHANGED' | 'ERR_INTERNET_DISCONNECTED' | 'ERR_ABORTED' | 'ERR_BLOCKED_BY_CLIENT' | 'ERR_FAILED' | 'ERR_INVALID_RESPONSE' | 'ERR_UNSAFE_REDIRECT' | 'ERR_UNEXPECTED_PROXY_AUTH' | 'ERR_PROXY_AUTH_UNSUPPORTED' | 'ERR_NO_SUPPORTED_PROXIES' | 'ERR_ADDRESS_UNREACHABLE';

/** Public discovery diagnostics only: no account tokens, response bodies or raw errors. */
export interface AuthNetworkDiagnostic {
  configuredProxyUrl: string;
  /** The first resolved routing rule; not proof of a proxy fallback's final hop. */
  route: AuthNetworkRoute;
  ok: boolean;
  durationMs: number;
  validDiscovery: boolean;
  statusCode?: number;
  errorCode?: AuthNetworkErrorCode;
  message: string;
}
