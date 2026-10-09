import { randomUUID } from 'node:crypto';
import type { WireApi } from '../shared/types';

type Json = Record<string, unknown>;
type BridgeWire = 'chat-completions' | 'responses';
/** 修改点：跨协议失败仅返回固定错误，不把请求、上游正文或密钥放入异常。 */
export class AnthropicBridgeError extends Error {
  constructor(readonly status: 400 | 502, message: string) { super(message); this.name = 'AnthropicBridgeError'; }
}
const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message = 'Messages 请求包含无法转换的参数。'): never => { throw new AnthropicBridgeError(400, message); };
const failed = (message = '上游没有返回可转换的完整推理结果。'): never => { throw new AnthropicBridgeError(502, message); };
function wire(value: WireApi): BridgeWire { if (value === 'messages') return invalid('原生 Messages 不需要跨协议转换。'); return value; }
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalid(`${label}无效。`);
  return value;
}
function blocks(value: unknown): Json[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value) || value.some(item => !isObject(item))) return invalid('Messages 内容必须是文本或内容块数组。');
  return value as Json[];
}
function image(block: Json, api: BridgeWire): Json {
  const source = object(block.source);
  let url: string;
  if (source.type === 'base64' && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(source.media_type))
    && typeof source.data === 'string' && /^[a-zA-Z0-9+/]+={0,2}$/.test(source.data)) url = `data:${source.media_type};base64,${source.data}`;
  else if (source.type === 'url' && typeof source.url === 'string') {
    let parsed: URL; try { parsed = new URL(source.url); } catch { return invalid('图片 URL 无效。'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return invalid('图片 URL 必须使用 HTTP(S)，不能包含凭据。');
    url = source.url;
  } else return invalid('仅支持 base64 或 URL 图片内容。');
  return api === 'responses' ? { type: 'input_image', image_url: url, detail: 'auto' } : { type: 'image_url', image_url: { url, detail: 'auto' } };
}
function plain(block: Json, api: BridgeWire, role: 'user' | 'assistant'): Json {
  if (block.type === 'text' && typeof block.text === 'string') return { type: api === 'responses' ? role === 'assistant' ? 'output_text' : 'input_text' : 'text', text: block.text };
  if (block.type === 'image' && role === 'user') return image(block, api);
  return invalid('此桥接支持文本、用户图片和工具调用；文档、音频、签名思考及服务端工具内容暂不支持。');
}
function toolOutput(value: unknown, api: BridgeWire, isError: boolean): unknown {
  if (typeof value === 'string') return isError ? `[Tool error]\n${value}` : value;
  const parts = blocks(value ?? '').map(block => plain(block, api, 'user'));
  if (isError) parts.unshift({ type: api === 'responses' ? 'input_text' : 'text', text: '[Tool error]' });
  return parts.every(part => ['text', 'input_text'].includes(String(part.type))) ? parts.map(part => part.text).join('\n') : parts;
}

/** 修改点：只映射可表达的 Messages 语义；不修改鉴权、选择供应商或执行工具。
 * 缓存提示/cache_control 是优化提示，不跨供应商传递。完整工具结果仍由 Claude 执行后回传。
 */
export function parseAnthropicRequest(value: unknown, modelWireApi: WireApi): Json {
  const api = wire(modelWireApi);
  if (!isObject(value)) return invalid('Messages 请求必须是 JSON 对象。');
  const body = value;
  if (!Array.isArray(body.messages) || !body.messages.length) return invalid('Messages 请求需要完整的 messages 历史。');
  if (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) <= 0) return invalid('max_tokens 必须是正整数。');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return invalid('stream 必须是布尔值。');
  const thinking = object(body.thinking);
  if (body.thinking !== undefined && thinking.type !== 'disabled') return invalid('跨协议桥接不支持 Anthropic 的签名思考和 token 思考预算，请关闭 Claude 扩展思考后重试。');
  for (const field of ['context_management', 'container', 'mcp_servers', 'service_tier']) if (body[field] !== undefined) return invalid(`跨协议桥接暂不支持 ${field}。`);
  if (body.top_k !== undefined) return invalid('上游 Chat/Responses 不支持 Anthropic top_k。');
  if (body.output_config !== undefined) {
    const config = object(body.output_config);
    if (!isObject(body.output_config) || Object.keys(config).some(key => key !== 'effort') || !['low', 'medium', 'high', 'max'].includes(String(config.effort)))
      return invalid('跨协议桥接只支持 output_config.effort；结构化输出格式暂不支持。');
  }
  const result: Json = { model: string(body.model, '模型 ID'), stream: body.stream === true,
    ...(api === 'responses' ? { max_output_tokens: body.max_tokens, store: false } : { max_tokens: body.max_tokens }) };
  if (api === 'chat-completions' && body.stream === true) result.stream_options = { include_usage: true };
  if (body.output_config !== undefined) {
    const effort = object(body.output_config).effort;
    if (api === 'responses') result.reasoning = { effort };
    else result.reasoning_effort = effort;
  }
  for (const field of ['temperature', 'top_p'] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > (field === 'temperature' ? 2 : 1)) return invalid(`${field} 参数无效。`);
      result[field] = body[field];
    }
  }
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences) || body.stop_sequences.some(item => typeof item !== 'string')) return invalid('stop_sequences 必须是字符串数组。');
    if (api === 'responses' && body.stop_sequences.length) return invalid('Responses 桥接暂不支持自定义 stop_sequences。');
    if (api === 'chat-completions') result.stop = body.stop_sequences;
  }
  const messages: Json[] = [], calls = new Set<string>(), outputs = new Set<string>();
  if (body.system !== undefined) {
    const system = blocks(body.system);
    if (system.some(block => block.type !== 'text' || typeof block.text !== 'string')) return invalid('system 只支持文本内容。');
    const text = system.map(block => block.text).join('\n');
    if (api === 'responses') result.instructions = text;
    else messages.push({ role: 'system', content: text });
  }
  for (const raw of body.messages) {
    if (!isObject(raw) || !['user', 'assistant'].includes(String(raw.role))) return invalid('历史消息角色只允许 user 或 assistant。');
    const role = raw.role as 'user' | 'assistant', parts = blocks(raw.content);
    let content: Json[] = [], toolCalls: Json[] = [];
    const toolImages: Json[] = [];
    const flush = () => {
      if (!content.length && !toolCalls.length) return;
      // 修改点：Responses EasyInputMessage 的 assistant 历史使用文本，
      // 不生成缺少 id/status 的 ResponseOutputMessage 形状。
      if (api === 'responses') messages.push({ role, content: role === 'assistant' ? content.map(part => part.text).join('') : content });
      else messages.push({ role, content: content.length ? content.every(part => part.type === 'text') ? content.map(part => part.text).join('') : content : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      content = []; toolCalls = [];
    };
    for (const block of parts) {
      if (block.type === 'tool_use') {
        if (role !== 'assistant' || !isObject(block.input)) return invalid('tool_use 必须位于 assistant 消息且 input 为 JSON 对象。');
        const callId = string(block.id, '工具调用 ID'), name = string(block.name, '工具名称');
        if (calls.has(callId)) return invalid('历史工具调用 ID 重复。'); calls.add(callId);
        const args = JSON.stringify(block.input);
        if (api === 'responses') { flush(); messages.push({ type: 'function_call', call_id: callId, name, arguments: args }); }
        else toolCalls.push({ id: callId, type: 'function', function: { name, arguments: args } });
      } else if (block.type === 'tool_result') {
        if (role !== 'user') return invalid('tool_result 必须位于 user 消息。');
        const callId = string(block.tool_use_id, '工具结果 ID');
        if (!calls.has(callId) || outputs.has(callId)) return invalid('工具结果没有对应调用，或同一调用重复返回结果。'); outputs.add(callId);
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') return invalid('工具结果 is_error 必须是布尔值。');
        flush(); const output = toolOutput(block.content, api, block.is_error === true);
        if (api === 'chat-completions' && Array.isArray(output)) {
          // 修改点：Chat 的 tool 消息仅支持文本；图片在全部工具结果后作为 user 图像传递。
          // 不把无效 image_url 写入 role:tool，也不删除截图内容。
          const parts = output as Json[], images = parts.filter(part => part.type === 'image_url');
          messages.push({ role: 'tool', tool_call_id: callId, content: parts.filter(part => part.type === 'text').map(part => part.text).join('\n') + `\n[Images from tool ${callId} follow.]` });
          toolImages.push({ type: 'text', text: `Images from tool ${callId}:` }, ...images);
        } else messages.push(api === 'responses' ? { type: 'function_call_output', call_id: callId, output } : { role: 'tool', tool_call_id: callId, content: output });
      } else content.push(plain(block, api, role));
    }
    if (toolImages.length) content.unshift(...toolImages);
    flush();
  }
  result[api === 'responses' ? 'input' : 'messages'] = messages;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return invalid('tools 必须是数组。');
    const names = new Set<string>();
    result.tools = body.tools.map(raw => {
      if (!isObject(raw) || raw.type !== undefined && raw.type !== 'custom' || !isObject(raw.input_schema)) return invalid('只支持具有 input_schema 的客户端自定义工具。');
      const name = string(raw.name, '工具名称'); if (names.has(name)) return invalid('工具名称重复。'); names.add(name);
      if (raw.description !== undefined && typeof raw.description !== 'string') return invalid('工具描述必须是字符串。');
      const definition = { name, parameters: structuredClone(raw.input_schema), ...(raw.description !== undefined ? { description: raw.description } : {}) };
      return api === 'responses' ? { type: 'function', ...definition } : { type: 'function', function: definition };
    });
  }
  if (body.tool_choice !== undefined) {
    const choice = object(body.tool_choice);
    if (!['auto', 'any', 'tool', 'none'].includes(String(choice.type))) return invalid('tool_choice 类型不受支持。');
    if (choice.type === 'tool') {
      const name = string(choice.name, '指定工具名称');
      if (!Array.isArray(body.tools) || !body.tools.some(tool => object(tool).name === name)) return invalid('tool_choice 指向未声明的工具。');
      result.tool_choice = api === 'responses' ? { type: 'function', name } : { type: 'function', function: { name } };
    } else result.tool_choice = choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== 'boolean') return invalid('disable_parallel_tool_use 必须是布尔值。');
      result.parallel_tool_calls = !choice.disable_parallel_tool_use;
    }
  }
  return result;
}

function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function usage(value: unknown): Json {
  const data = object(value), details = object(data.input_tokens_details ?? data.prompt_tokens_details);
  const gross = count(data.input_tokens ?? data.prompt_tokens) ?? 0;
  const cached = Math.min(gross, count(details.cached_tokens ?? data.prompt_cache_hit_tokens) ?? 0);
  const creation = Math.min(gross - cached, count(details.cache_write_tokens ?? data.cache_creation_input_tokens) ?? 0);
  return { input_tokens: gross - cached - creation, output_tokens: count(data.output_tokens ?? data.completion_tokens) ?? 0,
    cache_read_input_tokens: cached, cache_creation_input_tokens: creation };
}
function argumentsObject(value: unknown): Json {
  if (typeof value !== 'string') return failed('上游工具参数不是有效 JSON 对象。');
  let parsed: unknown; try { parsed = JSON.parse(value || '{}'); } catch { return failed('上游工具参数不是有效 JSON 对象。'); }
  if (!isObject(parsed)) return failed('上游工具参数不是有效 JSON 对象。');
  return parsed;
}
function toolBlock(id: unknown, name: unknown, args: unknown): Json {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return failed('上游工具调用缺少 ID 或名称。');
  return { type: 'tool_use', id, name, input: argumentsObject(args) };
}
function textContent(value: unknown): Json[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (value == null) return [];
  if (!Array.isArray(value)) return failed();
  return value.flatMap(part => {
    const block = object(part);
    if (block.type === 'refusal' || block.refusal) return failed('上游拒绝了本次推理请求。');
    if (!['text', 'output_text'].includes(String(block.type)) || typeof block.text !== 'string') return failed('上游返回不受支持的消息内容。');
    return block.text ? [{ type: 'text', text: block.text }] : [];
  });
}
function envelope(content: Json[], stopReason: string, model: string, tokenUsage: Json, id = `msg_${randomUUID().replace(/-/g, '')}`): Json {
  const toolIds = content.filter(block => block.type === 'tool_use').map(block => block.id);
  if (!content.length || new Set(toolIds).size !== toolIds.length) return failed('上游回复为空或工具调用 ID 重复。');
  return { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage: tokenUsage };
}
function chatStop(reason: unknown, hasTools: boolean): string {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return failed('上游推理被内容过滤。');
  if (reason === 'tool_calls' || reason === 'function_call') { if (!hasTools) return failed('上游声称调用工具但没有返回工具调用。'); return 'tool_use'; }
  if (reason === 'stop') return hasTools ? 'tool_use' : 'end_turn';
  return failed('上游推理未正常完成。');
}
function responsesStop(data: Json, hasTools: boolean): string {
  if (data.status === 'completed') return hasTools ? 'tool_use' : 'end_turn';
  if (data.status === 'incomplete' && object(data.incomplete_details).reason === 'max_output_tokens') return 'max_tokens';
  return failed('上游 Responses 推理失败或未正常完成。');
}
export function toAnthropicResponse(value: unknown, modelWireApi: WireApi, clientModel: string): Json {
  const api = wire(modelWireApi), data = object(value);
  if (data.error != null || data.type === 'error') return failed('上游返回推理错误。');
  const content: Json[] = [];
  if (api === 'chat-completions') {
    if (!Array.isArray(data.choices) || data.choices.length !== 1) return failed('上游必须返回一个 Chat 推理结果。');
    const choice = object(data.choices[0]), message = object(choice.message);
    if (message.role !== 'assistant' || message.refusal) return failed('上游没有返回有效的 assistant 回复。');
    content.push(...textContent(message.content));
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) return failed();
      for (const value of message.tool_calls) { const call = object(value), fn = object(call.function); if (call.type !== 'function') return failed('只支持 function 工具调用。'); content.push(toolBlock(call.id, fn.name, fn.arguments)); }
    }
    return envelope(content, chatStop(choice.finish_reason, content.some(block => block.type === 'tool_use')), clientModel, usage(data.usage));
  }
  if (!Array.isArray(data.output)) return failed('上游 Responses 缺少 output。');
  for (const value of data.output) {
    const item = object(value);
    if (item.type === 'message' && item.role === 'assistant') content.push(...textContent(item.content));
    else if (item.type === 'function_call') content.push(toolBlock(item.call_id, item.name, item.arguments));
    else if (item.type !== 'reasoning') return failed('上游返回不受支持的输出类型。');
  }
  return envelope(content, responsesStop(data, content.some(block => block.type === 'tool_use')), clientModel, usage(data.usage));
}

export interface AnthropicStreamOptions {
  /** Only observe upstream metadata for existing main-process usage logging. */
  onUpstreamEvent?: (value: unknown) => void;
  signal?: AbortSignal;
}
class Frames {
  private decoder = new TextDecoder(); private pending = '';
  feed(chunk: Uint8Array, last = false): string[] {
    this.pending += this.decoder.decode(chunk, { stream: !last });
    if (this.pending.length > 8 * 1024 * 1024) return failed('上游 SSE 事件过大。');
    const result: string[] = []; let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) { result.push(this.pending.slice(0, separator.index)); this.pending = this.pending.slice(separator.index + separator[0].length); }
    if (last && this.pending.trim()) { result.push(this.pending); this.pending = ''; }
    return result;
  }
}
function frameData(frame: string): unknown {
  const text = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
  if (!text) return undefined;
  if (text === '[DONE]') return '[DONE]';
  try { return JSON.parse(text); } catch { return failed('上游 SSE 不是有效 JSON。'); }
}
const encoder = new TextEncoder();
function event(value: Json): Uint8Array { return encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`); }
interface StreamBlock { index: number; type: 'text' | 'tool_use'; text: string; id?: string; name?: string; opened: boolean }
class StreamMapper {
  readonly id = `msg_${randomUUID().replace(/-/g, '')}`;
  private started = false; private terminal = false; private done = false; private tokenUsage: Json = usage({});
  private finishReason: unknown; private response: Json = {};
  private blocks = new Map<string, StreamBlock>();
  constructor(private api: BridgeWire, private model: string, private emit: (value: Json) => void) {}
  private start(): void {
    if (this.started) return; this.started = true;
    this.emit({ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: this.tokenUsage } });
  }
  private block(key: string, type: 'text' | 'tool_use', id?: unknown, name?: unknown): StreamBlock {
    this.start(); let block = this.blocks.get(key);
    if (!block) { block = { index: this.blocks.size, type, text: '', opened: false }; this.blocks.set(key, block); }
    if (block.type !== type) return failed('上游流式内容类型改变。');
    if (typeof id === 'string' && id) { if (block.id && block.id !== id) return failed('上游工具调用 ID 改变。'); block.id = id; }
    if (typeof name === 'string' && name) { if (block.name && block.name !== name) return failed('上游工具名称在流中改变。'); block.name = name; }
    if (!block.opened && (type === 'text' || block.id && block.name)) {
      block.opened = true;
      this.emit({ type: 'content_block_start', index: block.index, content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      if (block.text) this.emit({ type: 'content_block_delta', index: block.index, delta: type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: block.text } });
    }
    return block;
  }
  private append(block: StreamBlock, text: unknown, final = false): void {
    if (typeof text !== 'string') return failed('上游流式文本或工具参数类型无效。');
    if (final) { if (!text.startsWith(block.text)) return failed('上游完成内容与已发送流不一致。'); text = text.slice(block.text.length); }
    block.text += text;
    if (block.text.length > 16 * 1024 * 1024) return failed('上游流式内容过大。');
    if (text && block.opened) this.emit({ type: 'content_block_delta', index: block.index, delta: block.type === 'text' ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: text } });
  }
  add(value: unknown): void {
    if (value === undefined) return;
    if (value === '[DONE]') { if (this.api === 'chat-completions') this.done = true; return; }
    const data = object(value), type = String(data.type ?? '');
    if (data.error != null || ['error', 'response.failed', 'response.error', 'response.cancelled', 'response.refusal.delta', 'response.refusal.done'].includes(type)) return failed('上游流式推理返回错误或拒绝。');
    if (this.done) return failed('上游在结束标记后继续返回内容。');
    if (this.api === 'chat-completions') {
      if (data.usage != null) this.tokenUsage = usage(data.usage);
      if (!Array.isArray(data.choices)) return failed('上游 SSE 不是 Chat Completions 协议。');
      if (!data.choices.length) return;
      if (data.choices.length !== 1) return failed('上游流式响应包含多个 Chat 结果。');
      const choice = object(data.choices[0]), delta = object(choice.delta);
      if (choice.index !== undefined && choice.index !== 0 || delta.role !== undefined && delta.role !== 'assistant' || delta.refusal) return failed('上游流式 assistant 消息无效。');
      if (this.terminal && (delta.content || Array.isArray(delta.tool_calls) && delta.tool_calls.length)) return failed('上游完成后继续返回内容。');
      this.start();
      if (delta.content != null) for (const part of textContent(delta.content)) this.append(this.block('text', 'text'), part.text);
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) return failed();
        for (const raw of delta.tool_calls) {
          const call = object(raw), fn = object(call.function);
          if (!Number.isSafeInteger(call.index) || Number(call.index) < 0 || Number(call.index) > 128 || call.type !== undefined && call.type !== 'function') return failed('上游工具调用序号或类型无效。');
          const block = this.block(`tool:${call.index}`, 'tool_use', call.id, fn.name);
          if (fn.arguments !== undefined) this.append(block, fn.arguments);
        }
      }
      if (choice.finish_reason != null) { if (this.terminal) return failed('上游重复返回完成事件。'); this.finishReason = choice.finish_reason; this.terminal = true; }
      return;
    }
    if (type === 'response.created' || type === 'response.in_progress') {
      if (!isObject(data.response) || this.terminal) return failed('Responses 开始事件无效。');
      this.response = { ...this.response, ...data.response }; if (data.response.usage != null) this.tokenUsage = usage(data.response.usage); this.start(); return;
    }
    if (this.terminal) { if (type === 'ping') return; return failed('Responses 完成后继续返回事件。'); }
    const output = data.output_index, content = data.content_index;
    const index = () => { if (!Number.isSafeInteger(output) || Number(output) < 0 || Number(output) > 10000) return failed('Responses 输出序号无效。'); return Number(output); };
    const textKey = () => { if (!Number.isSafeInteger(content) || Number(content) < 0 || Number(content) > 10000) return failed('Responses 内容序号无效。'); return `text:${index()}:${content}`; };
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = object(data.item);
      if (item.type === 'function_call') { const block = this.block(`tool:${index()}`, 'tool_use', item.call_id, item.name); if (typeof item.arguments === 'string' && item.arguments) this.append(block, item.arguments, type.endsWith('.done')); }
      else if (item.type === 'message') {
        if (item.role !== 'assistant') return failed('Responses 输出消息角色无效。');
        if (Array.isArray(item.content)) item.content.forEach((raw, contentIndex) => {
          const part = object(raw);
          if (part.type === 'refusal') return failed('上游拒绝了本次推理请求。');
          if (part.type === 'output_text' && part.text) this.append(this.block(`text:${index()}:${contentIndex}`, 'text'), part.text, type.endsWith('.done'));
        });
      }
      else if (!['message', 'reasoning'].includes(String(item.type))) return failed('Responses 流式输出类型不受支持。');
      return;
    }
    if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      const part = object(data.part);
      if (part.type === 'refusal') return failed('上游拒绝了本次推理请求。');
      if (part.type === 'output_text') { const block = this.block(textKey(), 'text'); if (part.text) this.append(block, part.text, type.endsWith('.done')); }
      return;
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done') { this.append(this.block(textKey(), 'text'), type.endsWith('.done') ? data.text : data.delta, type.endsWith('.done')); return; }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const key = `tool:${index()}`, block = this.blocks.get(key); if (!block) return failed('Responses 工具参数缺少调用开始事件。');
      this.append(block, type.endsWith('.done') ? data.arguments : data.delta, type.endsWith('.done')); return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      if (!isObject(data.response)) return failed('Responses 完成事件缺少响应。');
      this.response = { ...this.response, ...data.response };
      if (data.response.usage != null) this.tokenUsage = usage(data.response.usage);
      // 修改点：部分订阅只在完成事件返回内容；已有 delta 不重复发送，缺失的最终内容补齐。
      if (Array.isArray(data.response.output)) {
        data.response.output.forEach((raw, outputIndex) => {
          const item = object(raw);
          if (item.type === 'function_call') this.append(this.block(`tool:${outputIndex}`, 'tool_use', item.call_id, item.name), item.arguments, true);
          else if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) item.content.forEach((rawPart, contentIndex) => {
            const part = object(rawPart); if (part.type === 'refusal') return failed('上游拒绝了本次推理请求。');
            if (part.type === 'output_text') this.append(this.block(`text:${outputIndex}:${contentIndex}`, 'text'), part.text, true);
          });
          else if (item.type !== 'reasoning') return failed('Responses 完成输出类型不受支持。');
        });
      }
      this.finishReason = responsesStop(this.response, [...this.blocks.values()].some(block => block.type === 'tool_use'));
      this.terminal = true; return;
    }
    if (!type.startsWith('response.reasoning') && !['response.output_item.done', 'response.output_item.added', 'ping', 'response.output_text.annotation.added'].includes(type)) return failed('上游 SSE 不是受支持的 Responses 事件。');
  }
  finish(): void {
    if (!this.terminal) return failed('上游流终止但没有正常完成事件。');
    const all = [...this.blocks.values()];
    if (!all.length || all.some(block => !block.opened) || !all.some(block => block.type === 'tool_use' || block.text.length)) return failed('上游流式回复为空或工具调用不完整。');
    const callIds = all.filter(block => block.type === 'tool_use').map(block => block.id);
    if (new Set(callIds).size !== callIds.length) return failed('上游工具调用 ID 重复。');
    for (const block of all) if (block.type === 'tool_use') argumentsObject(block.text);
    const stop = this.api === 'chat-completions' ? chatStop(this.finishReason, callIds.length > 0) : this.finishReason;
    for (const block of all) this.emit({ type: 'content_block_stop', index: block.index });
    this.emit({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: this.tokenUsage });
    this.emit({ type: 'message_stop' });
  }
}

/** Incremental UTF-8/SSE mapping. Cancel the returned reader to cancel its upstream.
 * Errors emit an Anthropic error and terminate; failure never emits message_stop.
 */
export function createAnthropicStream(modelWireApi: WireApi, clientModel: string, options: AnthropicStreamOptions = {}): TransformStream<Uint8Array, Uint8Array> {
  const api = wire(modelWireApi), frames = new Frames(); let mapper: StreamMapper, errored = false;
  const observe = (value: unknown) => { try { options.onUpstreamEvent?.(value); } catch { /* diagnostics cannot break inference */ } };
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    errored = true; const error = { type: 'error', error: { type: 'api_error', message: '上游推理失败或响应不完整，请检查模型协议和供应商状态。' } };
    observe(error); controller.enqueue(event(error)); controller.terminate();
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { mapper = new StreamMapper(api, clientModel, value => controller.enqueue(event(value))); },
    transform(chunk, controller) {
      if (errored) return;
      try { for (const frame of frames.feed(chunk)) { const value = frameData(frame); if (value !== undefined && value !== '[DONE]') observe(value); mapper.add(value); } }
      catch { fail(controller); }
    },
    flush(controller) {
      if (errored) return;
      try { for (const frame of frames.feed(new Uint8Array(), true)) { const value = frameData(frame); if (value !== undefined && value !== '[DONE]') observe(value); mapper.add(value); } mapper.finish(); }
      catch { fail(controller); }
    },
  });
}

/** A JSON-only upstream can still satisfy a Claude stream request with standard events. */
export function anthropicMessageToSse(value: unknown): Uint8Array {
  const message = object(value);
  if (message.type !== 'message' || message.role !== 'assistant' || typeof message.id !== 'string' || !Array.isArray(message.content)
    || !['end_turn', 'tool_use', 'max_tokens'].includes(String(message.stop_reason))) return failed('无法把无效回复转换为 Messages 事件流。');
  const events: Json[] = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...object(message.usage), output_tokens: 0 } } }];
  message.content.forEach((raw, index) => {
    const block = object(raw);
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && isObject(block.input)) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else return failed('回复包含不受支持的 Messages 内容。');
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null }, usage: message.usage }, { type: 'message_stop' });
  return encoder.encode(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
}

/** 修改点：订阅上游可强制 SSE；Claude stream:false 时收集同一映射，不能把失败流伪装成完成。 */
export async function collectAnthropicStream(source: ReadableStream<Uint8Array>, modelWireApi: WireApi, clientModel: string, options: AnthropicStreamOptions = {}): Promise<Json> {
  const reader = source.pipeThrough(createAnthropicStream(modelWireApi, clientModel, options), { signal: options.signal }).getReader();
  const frames = new Frames(), content: Json[] = [], argumentsText = new Map<number, string>(); let result: Json | undefined, finished = false, bytes = 0;
  const add = (value: unknown) => {
    const data = object(value);
    if (data.type === 'error') return failed('上游流式推理失败，未返回完整回复。');
    if (data.type === 'message_start') result = { ...object(data.message) };
    if (data.type === 'content_block_start') { const index = Number(data.index); content[index] = { ...object(data.content_block) }; if (content[index].type === 'tool_use') argumentsText.set(index, ''); }
    if (data.type === 'content_block_delta') {
      const index = Number(data.index), delta = object(data.delta), block = content[index]; if (!block) return failed();
      if (delta.type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '');
      if (delta.type === 'input_json_delta') argumentsText.set(index, (argumentsText.get(index) ?? '') + String(delta.partial_json ?? ''));
    }
    if (data.type === 'message_delta' && result) { Object.assign(result, object(data.delta)); result.usage = { ...object(result.usage), ...object(data.usage) }; }
    if (data.type === 'message_stop') finished = true;
  };
  try {
    while (true) {
      const part = await reader.read(); bytes += part.value?.byteLength ?? 0; if (bytes > 32 * 1024 * 1024) return failed('上游回复过大。');
      for (const frame of frames.feed(part.value ?? new Uint8Array(), part.done)) add(frameData(frame));
      if (part.done) break;
    }
    if (!result || !finished) return failed('上游流式响应没有正常完成。');
    for (const [index, text] of argumentsText) content[index].input = argumentsObject(text);
    return { ...result, content };
  } finally { try { await reader.cancel(); } catch { /* already closed/aborted */ } reader.releaseLock(); }
}
