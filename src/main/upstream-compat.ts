import type { Provider } from '../shared/types';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const grok47Models = new Set(['grok-4.7', 'grok-4.7-latest', 'grok-4.7-build', 'grok-4.7-build-fast']);

/** Claude's maximum effort is xhigh on Grok 4.7; other models keep their native values. */
export function normalizeUpstreamReasoning(provider: Pick<Provider, 'kind' | 'baseUrl'>, path: string, body: Json): Json {
  const route = path.replace(/^\/v1\//, '/');
  if (!['/responses', '/chat/completions'].includes(route) || !grok47Models.has(String(body.model))) return body;
  let target: URL;
  try { target = new URL(provider.baseUrl || (provider.kind === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : '')); }
  catch { return body; }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname.replace(/\/+$/, '') !== '/v1') return body;
  const official = provider.kind === 'grok' && ['https://cli-chat-proxy.grok.com', 'https://api.x.ai'].includes(target.origin)
    || provider.kind === 'openai-compatible' && ['https://api.x.ai', 'https://us.api.x.ai'].includes(target.origin);
  if (!official) return body;
  if (route === '/responses' && object(body.reasoning) && body.reasoning.effort === 'max') {
    return { ...body, reasoning: { ...body.reasoning, effort: 'xhigh' } };
  }
  if (route === '/chat/completions' && body.reasoning_effort === 'max') return { ...body, reasoning_effort: 'xhigh' };
  return body;
}
