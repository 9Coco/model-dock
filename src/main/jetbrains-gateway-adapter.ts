import type { Provider } from '../shared/types';
import { JetBrainsIdeApiError } from './jetbrains-ide-api';
import { JetBrainsIdeAccountError } from './jetbrains-ide-account';
import { parseResponsesChatRequest, chatToResponses, createChatResponsesStream, collectChatResponsesStream } from './responses-chat-bridge';
import { parseAnthropicRequest, toAnthropicResponse, createAnthropicStream, collectAnthropicStream } from './anthropic-bridge';

type Json = Record<string, unknown>;
interface Accounts { isNativeProvider(id: string): boolean; credentials(id: string, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }> }
interface Api { chat(token: string, body: Json, signal: AbortSignal): Promise<Response>; models(token: string, signal?: AbortSignal): Promise<unknown> }
const headers = (sse = false) => ({ 'content-type': sse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store' });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: headers() });
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('JetBrains 模型响应为空。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32 * 1024 * 1024) throw new Error('JetBrains 非流式模型响应超出限制。'); chunks.push(next.value); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { await reader.cancel().catch(() => {}); throw new Error('JetBrains 非流式模型响应无效。'); }
  finally { reader.releaseLock(); }
}

/** Native main-process protocol dispatch. SSE bytes are forwarded as they
 * arrive; the existing gateway owns local auth, allowlists and backpressure. */
export class JetBrainsGatewayAdapter {
  constructor(private readonly accounts: Accounts, private readonly api: Api) {}
  private check(provider: Provider): void {
    if (provider.nativeAdapter !== 'jetbrains-ide' || !this.accounts.isNativeProvider(provider.id)) throw new JetBrainsIdeAccountError('JetBrains IDE 原生账号配置已变化，请重新导入。');
  }
  async models(provider: Provider, signal: AbortSignal): Promise<Response> {
    this.check(provider);
    const auth = await this.accounts.credentials(provider.id, signal);
    try { return json({ object: 'list', ...(await this.api.models(auth.token, signal) as Json) }); }
    catch (error) { throw error instanceof JetBrainsIdeApiError ? error : new Error('JetBrains 官方模型目录暂不可用。'); }
  }
  async request(provider: Provider, path: string, body: Json, signal: AbortSignal): Promise<Response | undefined> {
    if (provider.nativeAdapter !== 'jetbrains-ide') return;
    this.check(provider);
    const route = path.replace(/^\/v1\//, '/');
    if (!['/chat/completions', '/responses', '/messages'].includes(route)) return json({ error: { message: 'JetBrains IDE 原生适配器不支持此接口。' } }, 400);
    const responseMode = route === '/responses', messagesMode = route === '/messages';
    // Parse unsupported cross-protocol semantics before authorization/network.
    const chat = responseMode ? parseResponsesChatRequest(body) : messagesMode ? parseAnthropicRequest(body, 'chat-completions') : body;
    const auth = await this.accounts.credentials(provider.id, signal);
    let upstream: Response;
    try { upstream = await this.api.chat(auth.token, { ...chat, model: body.model }, signal); }
    catch (error) { throw error instanceof JetBrainsIdeApiError ? error : new Error('JetBrains 官方模型请求未能完成。'); }
    if (!upstream.ok || !responseMode && !messagesMode) return upstream;
    const model = String(body.model ?? ''), sse = upstream.headers.get('content-type')?.includes('text/event-stream');
    if (body.stream === true) {
      if (!sse || !upstream.body) { await upstream.body?.cancel(); throw new Error('JetBrains 上游未返回有效流式响应。'); }
      const transform = responseMode ? createChatResponsesStream(model, { signal }) : createAnthropicStream('chat-completions', model);
      return new Response(upstream.body.pipeThrough(transform, { signal }), { headers: headers(true) });
    }
    const result = sse ? responseMode ? await collectChatResponsesStream(upstream.body!, model, { signal }) : await collectAnthropicStream(upstream.body!, 'chat-completions', model)
      : responseMode ? chatToResponses(await boundedJson(upstream), model) : toAnthropicResponse(await boundedJson(upstream), 'chat-completions', model);
    return json(result);
  }
}
