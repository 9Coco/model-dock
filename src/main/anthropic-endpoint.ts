/** 修改点：Claude Code 与 Anthropic SDK 会在基址后追加 /v1/messages。
 * 接受常见的 /v1 基址输入，但保留中转的 /anthropic 等自定义前缀。
 * https://code.claude.com/docs/en/llm-gateway-connect
 */
export function anthropicBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('请填写有效的 Anthropic API 地址'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash || url.search) {
    throw new Error('API 地址必须使用 HTTPS，或本机 HTTP 回环地址，且不能包含凭据、查询或片段');
  }
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  url.pathname = prefix || '/';
  return url.toString().replace(/\/$/, '');
}

export function anthropicEndpoint(baseUrl: string, route: '/messages' | '/models'): string {
  if (route !== '/messages' && route !== '/models') throw new Error('此版本不支持该 Anthropic API 路由');
  return `${anthropicBaseUrl(baseUrl)}/v1${route}`;
}
