import type { AuthNetworkDiagnostic, AuthNetworkErrorCode, AuthNetworkRoute } from '../shared/network-types';
import { validateProxyUrl } from './network-proxy';
import { version as appVersion } from '../../package.json';

export interface AuthNetworkSession { resolveProxy(url: string): Promise<string> | string }
const DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const safeCodes = new Set<AuthNetworkErrorCode>(['ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_ABORTED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_FAILED', 'ERR_INVALID_RESPONSE', 'ERR_UNSAFE_REDIRECT', 'ERR_UNEXPECTED_PROXY_AUTH', 'ERR_PROXY_AUTH_UNSUPPORTED', 'ERR_NO_SUPPORTED_PROXIES', 'ERR_ADDRESS_UNREACHABLE']);
class DiagnosticFailure extends Error {
  constructor(message: string, readonly errorCode?: AuthNetworkErrorCode) { super(message); }
}
export function safeNetworkErrorCode(error: unknown): AuthNetworkErrorCode | undefined {
  let value = error;
  for (let depth = 0; value && typeof value === 'object' && depth < 3; depth++) {
    try {
      const record = value as Record<string, unknown>;
      for (const text of [record.code, record.message]) {
        if (typeof text !== 'string') continue;
        const matches = text.slice(0, 16_384).match(/\bERR_[A-Z0-9_]+\b/g) ?? [];
        for (const match of matches) if (safeCodes.has(match as AuthNetworkErrorCode)) return match as AuthNetworkErrorCode;
      }
      value = record.cause;
    } catch { return undefined; }
  }
  return undefined;
}
function routeFrom(value: unknown): AuthNetworkRoute {
  if (typeof value !== 'string') return 'unknown';
  const first = value.split(';', 1)[0].trim();
  if (/^DIRECT$/i.test(first)) return 'direct';
  return /^(?:PROXY|HTTPS?|SOCKS[45]?)\s+\S+$/i.test(first) ? 'proxy' : 'unknown';
}
function successMessage(route: AuthNetworkRoute): string {
  return route === 'direct' ? '公开授权发现文档读取成功；当前解析路径为直连。' : route === 'proxy' ? '公开授权发现文档读取成功；当前解析路径为代理。' : '公开授权发现文档读取成功；无法确定当前代理解析路径。';
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DiagnosticFailure('授权网络检测超时（10 秒）。请检查应用代理和网络后重试。', 'ERR_TIMED_OUT');
}
function endpoint(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://auth.x.ai' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
async function discoveryBody(response: Response, signal: AbortSignal): Promise<boolean> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) { void response.body?.cancel().catch(() => undefined); throw new DiagnosticFailure('公开发现响应超过 64 KiB，已停止读取。', 'ERR_INVALID_RESPONSE'); }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) { void response.body?.cancel().catch(() => undefined); throw new DiagnosticFailure('公开发现服务没有返回 JSON 文档。', 'ERR_INVALID_RESPONSE'); }
  const reader = response.body?.getReader();
  if (!reader) throw new DiagnosticFailure('公开发现服务返回了空响应。', 'ERR_INVALID_RESPONSE');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      assertActive(signal);
      const part = await reader.read();
      assertActive(signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) { cancel(); throw new DiagnosticFailure('公开发现响应超过 64 KiB，已停止读取。', 'ERR_INVALID_RESPONSE'); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    document = parsed as Record<string, unknown>;
  } catch { throw new DiagnosticFailure('公开发现响应不是有效的 JSON 对象。', 'ERR_INVALID_RESPONSE'); }
  return !document.error && typeof document.issuer === 'string' && ['https://auth.x.ai', 'https://auth.x.ai/'].includes(document.issuer) && endpoint(document.device_authorization_endpoint) && endpoint(document.token_endpoint);
}

/** Inspect the running application's public auth route without touching accounts or settings. */
export async function inspectAuthNetwork(session: AuthNetworkSession, configuredProxyUrl: string, fetcher: typeof fetch): Promise<AuthNetworkDiagnostic> {
  const start = Date.now();
  let configured = '', route: AuthNetworkRoute = 'unknown', statusCode: number | undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (ok: boolean, message: string, code?: AuthNetworkErrorCode): AuthNetworkDiagnostic => ({ configuredProxyUrl: configured, route, ok, validDiscovery: ok, durationMs: Date.now() - start, ...(statusCode === undefined ? {} : { statusCode }), ...(code ? { errorCode: code } : {}), message });
  try {
    try { configured = validateProxyUrl(configuredProxyUrl); }
    catch { throw new DiagnosticFailure('应用代理地址配置无效，请检查网络设置后重试。'); }
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DiagnosticFailure('授权网络检测超时（10 秒）。请检查应用代理和网络后重试。', 'ERR_TIMED_OUT')); }, TIMEOUT_MS); });
    const inspect = async () => {
      try { route = routeFrom(await session.resolveProxy(DISCOVERY_URL)); }
      catch { route = 'unknown'; }
      assertActive(controller.signal);
      const response = await fetcher(DISCOVERY_URL, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': `ModelDock/${appVersion}` }, credentials: 'omit', redirect: 'error', signal: controller.signal });
      statusCode = response.status;
      assertActive(controller.signal);
      if (response.redirected || response.url && response.url !== DISCOVERY_URL || response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined); throw new DiagnosticFailure('公开发现请求发生重定向，已停止检测。', 'ERR_UNSAFE_REDIRECT');
      }
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new DiagnosticFailure(`公开发现服务返回 HTTP ${response.status}。此次检测没有发送账号凭据。`); }
      if (!await discoveryBody(response, controller.signal)) throw new DiagnosticFailure('发现文档的发行者或认证端点无效，已拒绝使用。', 'ERR_INVALID_RESPONSE');
      return true;
    };
    await Promise.race([inspect(), timeout]);
    return result(true, successMessage(route));
  } catch (error) {
    if (error instanceof DiagnosticFailure) return result(false, error.message, error.errorCode);
    return result(false, '公开授权网络请求失败，请检查应用代理和网络后重试。', safeNetworkErrorCode(error));
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
