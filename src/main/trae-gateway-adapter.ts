import type { Provider } from '../shared/types';
import type { TraeClientCredentials } from './trae-client-import';
import { TraeNativeAccountError } from './trae-native-account';
import { parseResponsesChatRequest, chatToResponses, createChatResponsesStream, collectChatResponsesStream } from './responses-chat-bridge';
import { parseAnthropicRequest, toAnthropicResponse, createAnthropicStream, collectAnthropicStream } from './anthropic-bridge';

type Json = Record<string, unknown>;
interface Accounts { isNativeProvider(id: string): boolean; credentials(id: string): TraeClientCredentials }
interface Api {
  chat(credentials: TraeClientCredentials, body: Json, signal?: AbortSignal): Promise<Response>;
  models(credentials: TraeClientCredentials, signal?: AbortSignal): Promise<unknown>;
}
const headers = (sse = false) => ({ 'content-type': sse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store' });
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: headers() }); }
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('TRAE 模型响应为空。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 32 * 1024 * 1024) throw new Error('TRAE 非流式模型响应超出限制。');
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** A main-process protocol adapter, not an additional listener. The existing
 * gateway retains client auth, model allowlists, cancellation and backpressure. */
export class TraeGatewayAdapter {
  constructor(private readonly accounts: Accounts, private readonly api: Api) {}
  async models(provider: Provider, signal: AbortSignal): Promise<Response> {
    if (provider.nativeAdapter !== 'trae' || !this.accounts.isNativeProvider(provider.id)) throw new TraeNativeAccountError('TRAE 原生账号配置已变化，请重新导入。');
    return json(await this.api.models(this.accounts.credentials(provider.id), signal));
  }
  async request(provider: Provider, path: string, body: Json, signal: AbortSignal): Promise<Response | undefined> {
    if (provider.nativeAdapter !== 'trae') return;
    if (!this.accounts.isNativeProvider(provider.id)) throw new TraeNativeAccountError('TRAE 原生账号配置已变化，请重新导入。');
    const route = path.replace(/^\/v1\//, '/');
    const credentials = this.accounts.credentials(provider.id);
    if (route === '/chat/completions') return this.api.chat(credentials, body, signal);
    if (route !== '/responses' && route !== '/messages') return json({ error: { message: 'TRAE 原生适配器不支持此接口。' } }, 400);
    const responseMode = route === '/responses';
    const chat = responseMode ? parseResponsesChatRequest(body) : parseAnthropicRequest(body, 'chat-completions');
    const model = String(body.model ?? '');
    const upstream = await this.api.chat(credentials, { ...chat, model }, signal);
    if (!upstream.ok) return upstream;
    const sse = upstream.headers.get('content-type')?.includes('text/event-stream');
    if (body.stream === true) {
      if (!sse || !upstream.body) { await upstream.body?.cancel(); throw new Error('TRAE 上游未返回有效流式响应。'); }
      const transform = responseMode ? createChatResponsesStream(model, { signal }) : createAnthropicStream('chat-completions', model);
      return new Response(upstream.body.pipeThrough(transform, { signal }), { headers: headers(true) });
    }
    const result = sse ? responseMode
      ? await collectChatResponsesStream(upstream.body!, model, { signal })
      : await collectAnthropicStream(upstream.body!, 'chat-completions', model)
      : responseMode ? chatToResponses(await boundedJson(upstream), model) : toAnthropicResponse(await boundedJson(upstream), 'chat-completions', model);
    return json(result);
  }
}
