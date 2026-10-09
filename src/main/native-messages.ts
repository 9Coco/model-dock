import type { Provider, ProviderSecret } from '../shared/types';
import { nativeClaudeBaseUrl } from '../shared/claude';
import { anthropicEndpoint } from './anthropic-endpoint';
import { normalizeApiKey } from './credentials';

type Json = Record<string, unknown>;
export class NativeMessagesError extends Error {
  constructor(message = '上游 Messages 回复无效或未完整完成。', readonly status = 502) { super(message); this.name = 'NativeMessagesError'; }
}
export interface NativeMessagesOptions { onUpstreamEvent?: (value: unknown) => void; signal?: AbortSignal }
export interface NativeMessagesProtocolHeaders { anthropicVersion?: string; anthropicBeta?: string }
function object(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function record(value: unknown): Json { return object(value) ? value : {}; }
function fail(message?: string): never { throw new NativeMessagesError(message); }
const encoder = new TextEncoder();
const event = (value: Json): Uint8Array => encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);

/** 修改点：同一来源的原生 Messages 入口只使用明确的官方映射或用户配置。
 * 凭据留在主进程；不要把 Claude 请求改投到同名模型的其他供应商。
 */
export function prepareNativeMessagesRequest(provider: Provider, secret: ProviderSecret, body: Json, protocolHeaders: NativeMessagesProtocolHeaders = {}): { url: string; headers: Record<string, string>; body: Json } {
  if (provider.kind !== 'openai-compatible' || !secret.apiKey?.trim()) return fail('原生 Messages 来源缺少 API Key。');
  let key: string; try { key = normalizeApiKey(secret.apiKey); } catch { return fail('原生 Messages API Key 格式无效。'); }
  if (!key) return fail('原生 Messages 来源缺少 API Key。');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json', 'anthropic-version': '2023-06-01' };
  // 修改点：原生协议仅保留受控版本和 beta 标记，客户端鉴权与其他头不进入上游。
  // 格式错误只返回固定消息；这些协议头不交给日志/用量观察器。
  const version = protocolHeaders.anthropicVersion;
  if (version !== undefined) {
    if (typeof version !== 'string' || version.length < 1 || version.length > 128 || /[^A-Za-z0-9._-]/.test(version)) throw new NativeMessagesError('Messages 版本协议头格式无效。', 400);
    headers['anthropic-version'] = version;
  }
  const beta = protocolHeaders.anthropicBeta;
  if (beta !== undefined) {
    if (typeof beta !== 'string' || beta.length < 1 || beta.length > 4096 || /[^A-Za-z0-9._, -]/.test(beta) || beta.split(',').some(tag => !/^[A-Za-z0-9._-]+$/.test(tag.trim()))) throw new NativeMessagesError('Messages beta 协议头格式无效。', 400);
    headers['anthropic-beta'] = beta;
  }
  if (provider.messagesAuth === 'api-key') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  return { url: anthropicEndpoint(nativeClaudeBaseUrl(provider) ?? provider.baseUrl, '/messages'), headers, body: structuredClone(body) };
}

/** Anthropic 的缓存读/写计数不在 input_tokens 中；应用内部用量采用总输入。
 * 上游回复保持原值，只给主进程的用量观察器提供合并后的累计计数。
 */
class UsageObserver {
  private usage: Json = {};
  constructor(private options: NativeMessagesOptions) {}
  observe(value: unknown): void {
    try { this.options.onUpstreamEvent?.(value); } catch { /* diagnostics cannot break inference */ }
    const data = record(value), message = record(data.message);
    const usage = object(message.usage) ? message.usage : object(data.usage) ? data.usage : undefined;
    if (!usage) return;
    this.usage = { ...this.usage, ...usage };
    const counter = (key: string): number | undefined => {
      const count = this.usage[key];
      return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
    };
    const input = counter('input_tokens'), output = counter('output_tokens');
    if (input === undefined || output === undefined) return;
    const read = counter('cache_read_input_tokens') ?? 0, write = counter('cache_creation_input_tokens') ?? 0;
    const total = input + read + write;
    if (!Number.isSafeInteger(total)) return;
    try { this.options.onUpstreamEvent?.({ usage: { ...this.usage, input_tokens: total, input_tokens_details: { cached_tokens: read, cache_write_tokens: write } } }); } catch { /* diagnostics cannot break inference */ }
  }
}

/** 修改点：原生内容块（包括 thinking/signature）原样保留，仅替换客户端别名。 */
export function toNativeMessagesResponse(value: unknown, alias: string, options: NativeMessagesOptions = {}): Json {
  if (!object(value) || object(value.error) || value.type !== 'message' || value.role !== 'assistant' || typeof value.id !== 'string' || !Array.isArray(value.content)
    || typeof value.stop_reason !== 'string' || !value.stop_reason || value.content.some(block => !object(block) || typeof block.type !== 'string')) return fail();
  new UsageObserver(options).observe(value);
  return { ...value, model: alias };
}

class Frames {
  private decoder = new TextDecoder();
  private pending = '';
  feed(chunk: Uint8Array, last = false): string[] {
    this.pending += this.decoder.decode(chunk, { stream: !last });
    if (this.pending.length > 8 * 1024 * 1024) return fail('上游 Messages SSE 事件过大。');
    const frames: string[] = []; let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) { frames.push(this.pending.slice(0, separator.index)); this.pending = this.pending.slice(separator.index + separator[0].length); }
    if (last && this.pending.trim()) { frames.push(this.pending); this.pending = ''; }
    return frames;
  }
}
function frameData(frame: string): Json | undefined {
  const lines = frame.split(/\r\n|\n|\r/);
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return undefined;
  let value: unknown; try { value = JSON.parse(data); } catch { return fail('上游 Messages SSE 包含无效 JSON。'); }
  if (!object(value) || typeof value.type !== 'string') return fail();
  const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  if (name && name !== value.type) return fail('上游 Messages SSE 事件类型不一致。');
  return value;
}
function indexOf(value: Json): number {
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0 || value.index > 10000) return fail('上游 Messages 内容序号无效。');
  return value.index;
}

/** 原生流直接保留内容事件；错误正文永不透传，截断不会伪造 message_stop。
 * 最终 stop 等连接正常结束才发出，以免同一流随后出现错误仍表现为完成。
 */
export function createNativeMessagesStream(alias: string, options: NativeMessagesOptions = {}): TransformStream<Uint8Array, Uint8Array> {
  const frames = new Frames(), observer = new UsageObserver(options), openBlocks = new Set<number>(), seenBlocks = new Set<number>();
  let started = false, finished = false, errored = false, stopReason: string | undefined;
  const failure = (controller: TransformStreamDefaultController<Uint8Array>) => {
    errored = true;
    const value = { type: 'error', error: { type: 'api_error', message: '上游 Messages 推理失败或响应不完整，请检查模型和供应商状态。' } };
    observer.observe(value); controller.enqueue(event(value)); controller.terminate();
  };
  const add = (value: Json | undefined, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!value) return;
    if (value.type === 'error' || object(value.error)) return fail();
    if (value.type === 'message_start') {
      if (started || finished || !object(value.message) || value.message.type !== 'message' || value.message.role !== 'assistant' || typeof value.message.id !== 'string' || !Array.isArray(value.message.content)) return fail();
      started = true;
      value = { ...value, message: { ...value.message, model: alias } };
    } else if (value.type === 'content_block_start') {
      if (!started || finished || !object(value.content_block) || typeof value.content_block.type !== 'string') return fail();
      const index = indexOf(value); if (seenBlocks.has(index)) return fail(); seenBlocks.add(index); openBlocks.add(index);
    } else if (value.type === 'content_block_delta') {
      if (!started || finished || !openBlocks.has(indexOf(value)) || !object(value.delta)) return fail();
    } else if (value.type === 'content_block_stop') {
      if (!started || finished || !openBlocks.delete(indexOf(value))) return fail();
    } else if (value.type === 'message_delta') {
      if (!started || finished || !object(value.delta)) return fail();
      if (typeof value.delta.stop_reason === 'string') stopReason = value.delta.stop_reason;
    } else if (value.type === 'message_stop') {
      if (!started || finished || openBlocks.size || !stopReason || [...seenBlocks].some(index => index >= seenBlocks.size)) return fail();
      finished = true; observer.observe(value); return;
    }
    if (typeof value.model === 'string') value = { ...value, model: alias };
    if (object(value.delta) && typeof value.delta.model === 'string') value = { ...value, delta: { ...value.delta, model: alias } };
    observer.observe(value);
    // 未知事件按官方版本策略保留；仅模型标识是本机别名。
    controller.enqueue(event(value));
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (errored) return;
      try { for (const frame of frames.feed(chunk)) add(frameData(frame), controller); } catch { failure(controller); }
    },
    flush(controller) {
      if (errored) return;
      try { for (const frame of frames.feed(new Uint8Array(), true)) add(frameData(frame), controller); if (!finished) return fail(); controller.enqueue(event({ type: 'message_stop' })); }
      catch { failure(controller); }
    },
  });
}

/** 非流式请求遇到强制 SSE 时收集原生内容，未知增量明确拒绝，避免丢内容。 */
export async function collectNativeMessagesStream(source: ReadableStream<Uint8Array>, alias: string, options: NativeMessagesOptions = {}): Promise<Json> {
  const reader = source.pipeThrough(createNativeMessagesStream(alias, options), { signal: options.signal }).getReader();
  const frames = new Frames(), content: Json[] = [], argumentsText = new Map<number, string>();
  let result: Json | undefined, finished = false, bytes = 0;
  const add = (value: Json | undefined) => {
    if (!value) return;
    if (value.type === 'error') return fail();
    if (value.type === 'message_start') { result = { ...record(value.message) }; }
    else if (value.type === 'content_block_start') content[indexOf(value)] = structuredClone(record(value.content_block));
    else if (value.type === 'content_block_delta') {
      const index = indexOf(value), block = content[index], delta = record(value.delta);
      if (!block) return fail();
      if (delta.type === 'text_delta' && typeof delta.text === 'string') block.text = String(block.text ?? '') + delta.text;
      else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking = String(block.thinking ?? '') + delta.thinking;
      else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = String(block.signature ?? '') + delta.signature;
      else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') argumentsText.set(index, (argumentsText.get(index) ?? '') + delta.partial_json);
      else if (delta.type === 'citations_delta' && object(delta.citation)) block.citations = [...(Array.isArray(block.citations) ? block.citations : []), structuredClone(delta.citation)];
      else return fail('无法收集上游新的 Messages 增量类型，请使用流式请求。');
    } else if (value.type === 'message_delta' && result) { result = { ...result, ...record(value.delta), model: alias, usage: { ...record(result.usage), ...record(value.usage) } }; }
    else if (value.type === 'message_stop') finished = true;
  };
  try {
    while (true) {
      const item = await reader.read(); bytes += item.value?.byteLength ?? 0;
      if (bytes > 32 * 1024 * 1024) return fail('上游 Messages 回复过大。');
      for (const frame of frames.feed(item.value ?? new Uint8Array(), item.done)) add(frameData(frame));
      if (item.done) break;
    }
    if (!result || !finished) return fail();
    for (const [index, text] of argumentsText) {
      if (!text.trim()) continue;
      let input: unknown; try { input = JSON.parse(text); } catch { return fail('上游 Messages 工具参数不是有效 JSON。'); }
      if (!object(input)) return fail('上游 Messages 工具参数必须是对象。');
      content[index].input = input;
    }
    return { ...result, content };
  } finally { try { await reader.cancel(); } catch { /* already closed/aborted */ } reader.releaseLock(); }
}

/** JSON 上游仍可回应流式客户端；常见内容用标准增量，保留不透明原生块。 */
export function nativeMessagesToSse(value: Json): Uint8Array {
  const content = value.content;
  if (!Array.isArray(content)) return fail();
  const events: Json[] = [{ type: 'message_start', message: { ...value, content: [], stop_reason: null, stop_sequence: null, usage: { ...record(value.usage), output_tokens: 0 } } }];
  content.forEach((raw, index) => {
    const block = record(raw);
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && object(block.input)) {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, thinking: '', signature: '' } }, { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }, { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else events.push({ type: 'content_block_start', index, content_block: block });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: value.stop_reason, stop_sequence: value.stop_sequence ?? null }, usage: value.usage }, { type: 'message_stop' });
  return encoder.encode(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
}
