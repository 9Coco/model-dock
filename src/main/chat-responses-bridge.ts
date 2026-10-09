import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;
/** 修改点：JetBrains Chat 接口连接仅支持 Responses 的来源；异常不携带正文或凭据。 */
export class ChatResponsesBridgeError extends Error {
  constructor(readonly status: 400 | 502, message: string) { super(message); this.name = 'ChatResponsesBridgeError'; }
}
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): Json => isObject(value) ? value : {};
const invalid = (message = 'Chat 请求包含无法转换的参数。'): never => { throw new ChatResponsesBridgeError(400, message); };
const failed = (message = '上游 Responses 推理失败或响应不完整。'): never => { throw new ChatResponsesBridgeError(502, message); };
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function label(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalid(message);
  return value;
}
function argumentsValid(value: unknown, upstream = false): string {
  const reject = () => upstream ? failed('上游工具参数不是有效 JSON 对象。') : invalid('历史工具参数必须是 JSON 对象字符串。');
  if (typeof value !== 'string') return reject();
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { return reject(); }
  if (!isObject(parsed)) return reject();
  return value;
}
function image(part: Json): Json {
  const data = object(part.image_url), url = data.url;
  if (typeof url !== 'string') return invalid('图片 URL 无效。');
  if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
    let parsed: URL; try { parsed = new URL(url); } catch { return invalid('图片 URL 无效。'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return invalid('图片 URL 必须使用 HTTP(S)，不能包含凭据。');
  }
  const detail = data.detail ?? 'auto';
  if (!['auto', 'low', 'high'].includes(String(detail))) return invalid('图片 detail 参数无效。');
  return { type: 'input_image', image_url: url, detail };
}
function content(value: unknown, images: boolean): string | Json[] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(part => !isObject(part))) return invalid('消息内容必须是文本或内容块数组。');
  return value.map(raw => {
    const part = object(raw);
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url' && images) return image(part);
    return invalid('此桥接支持文本和用户/工具图片，暂不支持音频或文件内容块。');
  });
}

/** 修改点：原生转换 Chat 语义，完整历史仍由客户端维护；不会执行工具或改变来源鉴权。 */
export function parseChatResponsesRequest(value: unknown): Json {
  if (!isObject(value)) return invalid('Chat 请求必须是 JSON 对象。');
  const body = value;
  const supported = new Set(['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
    'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'response_format', 'n', 'store', 'metadata', 'service_tier', 'modalities',
    'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs', 'user', 'prompt_cache_key', 'safety_identifier']);
  if (Object.keys(body).some(key => !supported.has(key) && body[key] !== undefined)) return invalid('Chat 请求包含 Responses 无法表达的附加参数。');
  if (!Array.isArray(body.messages) || !body.messages.length) return invalid('Chat 请求需要完整的 messages 历史。');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return invalid('stream 必须是布尔值。');
  if (body.n !== undefined && body.n !== 1) return invalid('Responses 桥接仅支持单个推理结果。');
  if (body.modalities !== undefined && (!Array.isArray(body.modalities) || body.modalities.length !== 1 || body.modalities[0] !== 'text')) return invalid('Responses 桥接仅支持文本输出。');
  for (const key of ['frequency_penalty', 'presence_penalty', 'top_logprobs']) if (body[key] !== undefined && body[key] !== 0) return invalid('Responses 不支持此 Chat 采样参数。');
  if (body.logprobs !== undefined && body.logprobs !== false) return invalid('Responses 桥接暂不支持 Chat logprobs。');
  if (body.stream_options !== undefined && (!isObject(body.stream_options) || Object.keys(body.stream_options).some(key => key !== 'include_usage')
    || body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean')) return invalid('仅支持 stream_options.include_usage。');
  const result: Json = { model: label(body.model, '模型 ID 无效。'), stream: body.stream === true, store: false };
  if (body.store !== undefined) { if (typeof body.store !== 'boolean') return invalid('store 必须是布尔值。'); result.store = body.store; }
  const limit = body.max_completion_tokens ?? body.max_tokens;
  if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined && body.max_tokens !== body.max_completion_tokens) return invalid('两种输出 token 预算不能相互冲突。');
  if (limit !== undefined) { if (!Number.isSafeInteger(limit) || Number(limit) <= 0) return invalid('输出 token 预算必须是正整数。'); result.max_output_tokens = limit; }
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined) {
    const data = body[key]; if (typeof data !== 'number' || !Number.isFinite(data) || data < 0 || data > (key === 'temperature' ? 2 : 1)) return invalid('采样参数范围无效。');
    result[key] = data;
  }
  if (body.stop !== undefined && body.stop !== null) {
    if (!Array.isArray(body.stop) || body.stop.length) return invalid('Responses 不支持自定义 stop；请移除此参数。');
  }
  if (body.reasoning_effort !== undefined) {
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(body.reasoning_effort))) return invalid('reasoning_effort 无效。');
    result.reasoning = { effort: body.reasoning_effort };
  }
  if (body.metadata !== undefined) {
    if (!isObject(body.metadata) || Object.values(body.metadata).some(item => typeof item !== 'string')) return invalid('metadata 必须是字符串映射。');
    result.metadata = structuredClone(body.metadata);
  }
  if (body.service_tier !== undefined) {
    if (!['auto', 'default', 'flex', 'priority'].includes(String(body.service_tier))) return invalid('service_tier 无效。');
    result.service_tier = body.service_tier;
  }
  // 修改点：Responses 原生保留这三个标识字段（user 已弃用但仍在官方请求 schema）。
  // 不将旧 user 猜测拆成缓存/安全标识，也不在日志或异常中写出标识值。
  for (const key of ['user', 'prompt_cache_key', 'safety_identifier']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { result[key] = null; continue; }
    const identifier = label(body[key], '用户、缓存或安全标识必须是有效字符串。');
    if (key === 'safety_identifier' && Array.from(identifier).length > 128) return invalid('安全标识不能超过 128 个字符。');
    result[key] = identifier;
  }
  const input: Json[] = [], calls = new Set<string>(), outputs = new Set<string>();
  for (const raw of body.messages) {
    if (!isObject(raw) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(raw.role))) return invalid('历史消息角色不受支持。');
    if (raw.name !== undefined) return invalid('Responses 消息没有与 Chat name 等价的字段，请移除此参数。');
    if (Object.keys(raw).some(key => !['role', 'content', 'tool_calls', 'tool_call_id', 'refusal', 'reasoning_content'].includes(key))) return invalid('历史消息包含 Responses 无法表达的附加字段。');
    if (raw.reasoning_content !== undefined && raw.reasoning_content !== null && raw.reasoning_content !== '') return invalid('不能将 Chat 推理文本伪造为 Responses 的原生推理历史。');
    const role = raw.role as string;
    if (role === 'tool') {
      if (raw.tool_calls !== undefined || raw.refusal !== undefined) return invalid('工具结果消息包含无效字段。');
      const id = label(raw.tool_call_id, '工具结果 ID 无效。');
      if (!calls.has(id) || outputs.has(id)) return invalid('工具结果缺少对应调用，或重复返回结果。'); outputs.add(id);
      input.push({ type: 'function_call_output', call_id: id, output: content(raw.content, true) }); continue;
    }
    if (raw.tool_call_id !== undefined || role !== 'assistant' && (raw.tool_calls !== undefined || raw.refusal !== undefined)) return invalid('工具或拒绝字段位于无效角色。');
    if (role === 'assistant') {
      const parts: Json[] = [];
      if (raw.content != null) {
        const text = content(raw.content, false);
        if (typeof text === 'string') { if (text) parts.push({ type: 'output_text', text, annotations: [] }); }
        else for (const part of text) parts.push({ type: 'output_text', text: part.text, annotations: [] });
      }
      if (raw.refusal !== undefined && raw.refusal !== null) {
        if (typeof raw.refusal !== 'string') return invalid('refusal 必须是字符串。');
        if (raw.refusal) parts.push({ type: 'refusal', refusal: raw.refusal });
      }
      if (parts.length) input.push({ type: 'message', id: `msg_${randomUUID().replace(/-/g, '')}`, status: 'completed', role, content: parts });
      if (raw.tool_calls !== undefined) {
        if (!Array.isArray(raw.tool_calls)) return invalid('tool_calls 必须是数组。');
        for (const tool of raw.tool_calls) {
          if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) return invalid('仅支持 function 工具调用。');
          const id = label(tool.id, '工具调用 ID 无效。'); if (calls.has(id)) return invalid('工具调用 ID 重复。'); calls.add(id);
          input.push({ type: 'function_call', call_id: id, name: label(tool.function.name, '工具名称无效。'), arguments: argumentsValid(tool.function.arguments) });
        }
      }
      if (!parts.length && (!Array.isArray(raw.tool_calls) || !raw.tool_calls.length)) return invalid('assistant 历史消息为空。');
    } else input.push({ role, content: content(raw.content, role === 'user') });
  }
  result.input = input;
  const names = new Set<string>();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return invalid('tools 必须是数组。');
    const definitions = body.tools.map(raw => {
      if (!isObject(raw) || raw.type !== 'function' || !isObject(raw.function)) return invalid('仅支持客户端 function 工具。');
      const fn = raw.function, name = label(fn.name, '工具名称无效。');
      if (names.has(name)) return invalid('工具名称重复。'); names.add(name);
      if (Object.keys(fn).some(key => !['name', 'description', 'parameters', 'strict'].includes(key)) || fn.parameters !== undefined && !isObject(fn.parameters)
        || fn.description !== undefined && typeof fn.description !== 'string' || fn.strict !== undefined && typeof fn.strict !== 'boolean') return invalid('工具定义无效。');
      return { type: 'function', name, parameters: structuredClone(fn.parameters ?? { type: 'object', properties: {} }), strict: fn.strict ?? false,
        ...(fn.description !== undefined ? { description: fn.description } : {}) };
    });
    if (definitions.length) result.tools = definitions;
  }
  if (body.tool_choice !== undefined) {
    if (['auto', 'none', 'required'].includes(String(body.tool_choice))) {
      if (body.tool_choice === 'required' && !names.size) return invalid('required 工具选择需要工具定义。');
      result.tool_choice = body.tool_choice;
    } else {
      const choice = object(body.tool_choice), fn = object(choice.function);
      if (choice.type !== 'function' || typeof fn.name !== 'string' || !names.has(fn.name)) return invalid('tool_choice 必须指向已声明的 function 工具。');
      result.tool_choice = { type: 'function', name: fn.name };
    }
  }
  if (body.parallel_tool_calls !== undefined) { if (typeof body.parallel_tool_calls !== 'boolean') return invalid('parallel_tool_calls 必须是布尔值。'); result.parallel_tool_calls = body.parallel_tool_calls; }
  if (body.response_format !== undefined) {
    const format = object(body.response_format);
    if (format.type === 'text' || format.type === 'json_object') result.text = { format: { type: format.type } };
    else if (format.type === 'json_schema') {
      const schema = object(format.json_schema), name = label(schema.name, '结构化输出名称无效。');
      if (!isObject(schema.schema) || schema.strict !== undefined && typeof schema.strict !== 'boolean' || schema.description !== undefined && typeof schema.description !== 'string'
        || Object.keys(schema).some(key => !['name', 'schema', 'strict', 'description'].includes(key))) return invalid('结构化输出定义无效。');
      result.text = { format: { type: 'json_schema', name, schema: structuredClone(schema.schema), strict: schema.strict ?? false,
        ...(schema.description !== undefined ? { description: schema.description } : {}) } };
    } else return invalid('response_format 不受支持。');
  }
  return result;
}

function tokenUsage(value: unknown): Json | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) return failed('上游 token 用量无效。');
  const data = value, prompt = count(data.input_tokens), completion = count(data.output_tokens);
  if (prompt === undefined || completion === undefined) return failed('上游 token 用量无效。');
  if (data.total_tokens !== undefined && count(data.total_tokens) === undefined) return failed('上游 token 总用量无效。');
  const result: Json = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: count(data.total_tokens) ?? prompt + completion };
  for (const [upstream, downstream] of [['input_tokens_details', 'prompt_tokens_details'], ['output_tokens_details', 'completion_tokens_details']]) {
    if (data[upstream] == null) continue;
    if (!isObject(data[upstream])) return failed('上游 token 细分用量无效。');
    const details = data[upstream], converted: Json = {};
    for (const [key, item] of Object.entries(details)) { if (count(item) === undefined) return failed('上游 token 细分用量无效。'); converted[key] = item; }
    if (upstream === 'input_tokens_details' && Number(details.cached_tokens ?? 0) > prompt
      || upstream === 'output_tokens_details' && Number(details.reasoning_tokens ?? 0) > completion) return failed('上游 token 细分用量超过总用量。');
    result[downstream] = converted;
  }
  return result;
}
function finishReason(data: Json, tools: boolean): string {
  if (data.error != null) return failed();
  if (data.status === 'completed') return tools ? 'tool_calls' : 'stop';
  if (data.status === 'incomplete' && object(data.incomplete_details).reason === 'max_output_tokens') return 'length';
  return failed();
}
function reasoningParts(item: Json): { summary: string[]; content: string[] } {
  const parts = { summary: [] as string[], content: [] as string[] };
  if (item.summary !== undefined && !Array.isArray(item.summary)) return failed('上游推理摘要无效。');
  if (item.content !== undefined && !Array.isArray(item.content)) return failed('上游推理文本无效。');
  for (const raw of Array.isArray(item.summary) ? item.summary : []) {
    const part = object(raw); if (part.type !== 'summary_text' || typeof part.text !== 'string') return failed('上游推理摘要无效。'); parts.summary.push(part.text);
  }
  for (const raw of Array.isArray(item.content) ? item.content : []) {
    const part = object(raw); if (!['reasoning_text', 'output_text'].includes(String(part.type)) || typeof part.text !== 'string') return failed('上游推理文本无效。'); parts.content.push(part.text);
  }
  return parts;
}
/** 修改点：保留公开推理摘要/refusal 和真实输入、输出、缓存用量；不伪造思考签名。 */
export function responsesToChat(value: unknown, modelAlias: string): Json {
  const data = object(value);
  if (!Array.isArray(data.output) || data.error != null) return failed();
  let text = '', refusal = '', reasoning = '';
  const tools: Json[] = [], ids = new Set<string>(), annotations: unknown[] = [];
  const truncated = data.status === 'incomplete' && object(data.incomplete_details).reason === 'max_output_tokens';
  for (const raw of data.output) {
    const item = object(raw);
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return failed('上游输出消息无效。');
      for (const rawPart of item.content) {
        const part = object(rawPart);
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
          if (Array.isArray(part.annotations)) annotations.push(...part.annotations);
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
        else return failed('上游消息内容类型不受支持。');
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string' || ids.has(item.call_id)) return failed('上游工具调用 ID、名称或参数无效。');
      ids.add(item.call_id); if (!truncated) argumentsValid(item.arguments, true);
      tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'reasoning') {
      // 修改点：火山 Responses 也可通过 content 下发原始推理文本；两种载体独立校验，摘要优先，避免重复显示。
      const parts = reasoningParts(item), summary = parts.summary.join(''); reasoning += summary || parts.content.join('');
    } else return failed('上游输出类型暂不支持 Chat 转换。');
  }
  const reason = finishReason(data, tools.length > 0);
  if (!text && !refusal && !reasoning && !tools.length && reason !== 'length') return failed('上游完成回复为空。');
  const message: Json = { role: 'assistant', content: text || (tools.length || refusal || reasoning ? null : '') };
  if (refusal) message.refusal = refusal;
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.length) message.tool_calls = tools;
  if (annotations.length) message.annotations = annotations;
  const usage = tokenUsage(data.usage);
  return { id: `chatcmpl_${randomUUID().replace(/-/g, '')}`, object: 'chat.completion', created: count(data.created_at) ?? Math.floor(Date.now() / 1000),
    model: modelAlias, choices: [{ index: 0, message, finish_reason: reason }], ...(usage ? { usage } : {}) };
}

export interface ResponsesChatStreamOptions { onUpstreamEvent?: (value: unknown) => void; signal?: AbortSignal }
const encoder = new TextEncoder();
const event = (value: Json | '[DONE]'): Uint8Array => encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
class Frames {
  private decoder = new TextDecoder('utf-8', { fatal: true }); private pending = '';
  feed(bytes: Uint8Array, last = false): string[] {
    this.pending += this.decoder.decode(bytes, { stream: !last });
    if (this.pending.length > 8 * 1024 * 1024) return failed('上游 SSE 事件过大。');
    const frames: string[] = []; let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) { frames.push(this.pending.slice(0, separator.index)); this.pending = this.pending.slice(separator.index + separator[0].length); }
    if (last && this.pending.trim()) { frames.push(this.pending); this.pending = ''; }
    return frames;
  }
}
function frameData(frame: string): unknown {
  const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
  if (!data) return undefined;
  if (data === '[DONE]') return data;
  try { return JSON.parse(data); } catch { return failed('上游 SSE 不是有效 JSON。'); }
}
interface Block { output: number; part: number; kind: 'text' | 'refusal' | 'reasoning' | 'reasoning-text' | 'tool'; text: string; id?: string; name?: string; toolIndex?: number; opened: boolean }
class Mapper {
  readonly id = `chatcmpl_${randomUUID().replace(/-/g, '')}`;
  private created = Math.floor(Date.now() / 1000); private started = false; private terminal = false; private done = false;
  private response: Json = {}; private blocks = new Map<string, Block>(); private toolCount = 0;
  private itemKinds = new Map<number, string>(); private reasoningCarriers = new Map<number, 'reasoning' | 'reasoning-text'>();
  constructor(private model: string, private emit: (value: Json | '[DONE]') => void) {}
  private chunk(delta: Json, reason: unknown = null): void {
    this.emit({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: reason }] });
  }
  private start(): void { if (!this.started) { this.started = true; this.chunk({ role: 'assistant', content: '' }); } }
  private itemKind(output: unknown, kind: string): void {
    if (count(output) === undefined || Number(output) > 10000) return failed('Responses 输出序号无效。');
    const previous = this.itemKinds.get(Number(output));
    if (previous && previous !== kind) return failed('上游同一输出的条目类型改变。');
    this.itemKinds.set(Number(output), kind);
  }
  private block(output: unknown, part: unknown, kind: Block['kind'], id?: unknown, name?: unknown): Block {
    if (count(output) === undefined || Number(output) > 10000 || count(part) === undefined || Number(part) > 10000) return failed('Responses 输出序号无效。');
    const key = `${kind}:${output}:${part}`;
    let block = this.blocks.get(key);
    if (!block) { block = { output: Number(output), part: Number(part), kind, text: '', opened: false }; if (kind === 'tool') block.toolIndex = this.toolCount++; this.blocks.set(key, block); }
    if (id !== undefined) { if (typeof id !== 'string' || !id || block.id && block.id !== id) return failed('流式工具调用 ID 无效或改变。'); block.id = id; }
    if (name !== undefined) { if (typeof name !== 'string' || !name || block.name && block.name !== name) return failed('流式工具名称无效或改变。'); block.name = name; }
    this.start();
    if (!block.opened && (kind !== 'tool' || block.id && block.name)) {
      block.opened = true;
      if (kind === 'tool') this.chunk({ tool_calls: [{ index: block.toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: block.text } }] });
    }
    return block;
  }
  private append(block: Block, value: unknown, final: boolean): void {
    if (typeof value !== 'string') return failed('上游流式文本或参数无效。');
    let delta = value;
    if (final) { if (!value.startsWith(block.text)) return failed('上游最终内容与流式内容不一致。'); delta = value.slice(block.text.length); }
    block.text += delta;
    if (block.text.length > 16 * 1024 * 1024) return failed('上游流式内容过大。');
    if (!delta || !block.opened) return;
    // 修改点：summary_index/content_index 属于两个索引域。每项选择首个非空推理载体，后续另一载体仍校验但不重复输出。
    if (block.kind === 'reasoning' || block.kind === 'reasoning-text') {
      const carrier = this.reasoningCarriers.get(block.output) ?? block.kind; this.reasoningCarriers.set(block.output, carrier);
      if (carrier !== block.kind) return;
    }
    if (block.kind === 'tool') this.chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta } }] });
    else this.chunk({ [block.kind === 'text' ? 'content' : block.kind === 'refusal' ? 'refusal' : 'reasoning_content']: delta });
  }
  private item(raw: unknown, output: unknown, final: boolean): void {
    const item = object(raw);
    this.itemKind(output, String(item.type ?? ''));
    if (item.type === 'function_call') {
      const block = this.block(output, 0, 'tool', item.call_id, item.name);
      if (item.arguments !== undefined) this.append(block, item.arguments, final);
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return failed('流式输出消息无效。');
      item.content.forEach((part, index) => this.part(part, output, index, final));
    } else if (item.type === 'reasoning') {
      reasoningParts(item);
      if (Array.isArray(item.summary)) item.summary.forEach((part, index) => this.part(part, output, index, final));
      if (Array.isArray(item.content)) item.content.forEach((part, index) => this.part(part, output, index, final, true));
    } else return failed('上游流式输出类型暂不支持。');
  }
  private part(raw: unknown, output: unknown, index: unknown, final: boolean, rawReasoning = false): void {
    const part = object(raw);
    // Ark may open a content/summary part with only its type. Only .added
    // initializes absent text; explicit invalid values and .done stay strict.
    const text = (key: string): unknown => part[key] === undefined && !final ? '' : part[key];
    if (part.type === 'reasoning_text' || part.type === 'output_text' && (rawReasoning || this.itemKinds.get(Number(output)) === 'reasoning')) {
      this.itemKind(output, 'reasoning'); this.append(this.block(output, index, 'reasoning-text'), text('text'), final);
    } else if (part.type === 'output_text') this.append(this.block(output, index, 'text'), text('text'), final);
    else if (part.type === 'refusal') this.append(this.block(output, index, 'refusal'), text('refusal'), final);
    else if (part.type === 'summary_text') { this.itemKind(output, 'reasoning'); this.append(this.block(output, index, 'reasoning'), text('text'), final); }
    else return failed('上游流式内容类型暂不支持。');
  }
  add(value: unknown): void {
    if (value === undefined) return;
    if (value === '[DONE]') { if (this.done) return failed('上游重复返回结束标记。'); this.done = true; return; }
    const data = object(value), type = String(data.type ?? '');
    if (data.error != null || ['error', 'response.failed', 'response.error', 'response.cancelled'].includes(type)) return failed();
    if (type === 'ping') return;
    if (this.terminal || this.done) return failed('上游完成后继续返回事件。');
    if (['response.created', 'response.in_progress', 'response.queued'].includes(type)) {
      if (!isObject(data.response)) return failed('Responses 开始事件无效。');
      this.response = { ...this.response, ...data.response }; if (!this.started) this.created = count(data.response.created_at) ?? this.created; this.start(); return;
    }
    if (['response.output_item.added', 'response.output_item.done'].includes(type)) { this.item(data.item, data.output_index, type.endsWith('.done')); return; }
    if (['response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done'].includes(type)) {
      this.part(data.part, data.output_index, data.content_index ?? data.summary_index, type.endsWith('.done')); return;
    }
    if (['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done',
      'response.reasoning_raw_text.delta', 'response.reasoning_raw_text.done'].includes(type)) {
      const kind = type.startsWith('response.refusal') ? 'refusal' : type.startsWith('response.reasoning_summary') ? 'reasoning'
        : type.startsWith('response.reasoning_text') || type.startsWith('response.reasoning_raw_text') || this.itemKinds.get(Number(data.output_index)) === 'reasoning' ? 'reasoning-text' : 'text';
      if (kind === 'reasoning' || kind === 'reasoning-text') this.itemKind(data.output_index, 'reasoning');
      this.append(this.block(data.output_index, data.content_index ?? data.summary_index, kind), type.endsWith('.done') ? kind === 'refusal' ? data.refusal : data.text : data.delta, type.endsWith('.done')); return;
    }
    if (['response.function_call_arguments.delta', 'response.function_call_arguments.done'].includes(type)) {
      const block = this.blocks.get(`tool:${data.output_index}:0`); if (!block) return failed('流式工具参数缺少调用开始事件。');
      this.append(block, type.endsWith('.done') ? data.arguments : data.delta, type.endsWith('.done')); return;
    }
    if (['response.completed', 'response.incomplete'].includes(type)) {
      if (!isObject(data.response)) return failed('Responses 完成事件缺少响应。');
      this.response = { ...this.response, ...data.response };
      // 最终对象先完整校验，JSON-only 失败不向客户端发送无效工具参数。
      // output 为空时仍允许已有 output_item.done/delta 提供完整内容。
      if (Array.isArray(data.response.output) && data.response.output.length) responsesToChat(this.response, this.model);
      if (Array.isArray(data.response.output)) data.response.output.forEach((item, index) => this.item(item, index, true));
      finishReason(this.response, this.toolCount > 0); this.terminal = true; return;
    }
    if (type === 'response.output_text.annotation.added') return;
    return failed('上游不是受支持的 Responses 事件流。');
  }
  finish(): void {
    if (!this.terminal) return failed('上游流结束但没有正常完成事件。');
    const output: Json[] = [], all = [...this.blocks.values()].sort((a, b) => a.output - b.output || a.part - b.part);
    const groups = new Map<number, Block[]>();
    for (const block of all) { if (!block.opened) return failed('上游工具调用不完整。'); const group = groups.get(block.output) ?? []; group.push(block); groups.set(block.output, group); }
    for (const blocks of groups.values()) {
      if (blocks[0].kind === 'tool') {
        if (blocks.length !== 1) return failed('上游同一输出包含不一致的内容类型。');
        const block = blocks[0]; output.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.text });
      } else if (blocks[0].kind === 'reasoning' || blocks[0].kind === 'reasoning-text') {
        if (blocks.some(block => block.kind !== 'reasoning' && block.kind !== 'reasoning-text')) return failed('上游同一输出包含不一致的内容类型。');
        const carrier = this.reasoningCarriers.get(blocks[0].output) ?? 'reasoning', chosen = blocks.filter(block => block.kind === carrier);
        output.push(carrier === 'reasoning' ? { type: 'reasoning', summary: chosen.map(block => ({ type: 'summary_text', text: block.text })) }
          : { type: 'reasoning', summary: [], content: chosen.map(block => ({ type: 'reasoning_text', text: block.text })) });
      } else {
        if (blocks.some(block => !['text', 'refusal'].includes(block.kind))) return failed('上游同一输出包含不一致的内容类型。');
        output.push({ type: 'message', role: 'assistant', content: blocks.map(block => block.kind === 'text' ? { type: 'output_text', text: block.text } : { type: 'refusal', refusal: block.text }) });
      }
    }
    const final = responsesToChat({ ...this.response, output }, this.model), choice = object((final.choices as Json[])[0]);
    this.start(); this.chunk({}, choice.finish_reason);
    if (final.usage) this.emit({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: final.usage });
    this.emit('[DONE]');
  }
}

/** 修改点：只在 EOF 校验后发送 finish/DONE，避免完成事件之后的错误被当作成功。 */
export function createResponsesChatStream(modelAlias: string, options: ResponsesChatStreamOptions = {}): TransformStream<Uint8Array, Uint8Array> {
  const frames = new Frames(); let mapper: Mapper, errored = false, abort: (() => void) | undefined;
  const cleanup = () => { if (abort) options.signal?.removeEventListener('abort', abort); };
  const observe = (value: unknown) => { try { options.onUpstreamEvent?.(value); } catch { /* 诊断失败不影响推理。 */ } };
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    errored = true; cleanup(); const error = { type: 'error', error: { type: 'upstream_error', code: 'responses_bridge_error', message: '上游推理失败或响应不完整，请检查模型协议和供应商状态。' } };
    observe(error); controller.enqueue(event(error)); controller.terminate();
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      mapper = new Mapper(modelAlias, data => controller.enqueue(event(data)));
      abort = () => { errored = true; cleanup(); controller.error(new DOMException('推理已取消。', 'AbortError')); };
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    },
    transform(bytes, controller) {
      if (errored) return;
      try { for (const frame of frames.feed(bytes)) { const data = frameData(frame); if (data !== undefined && data !== '[DONE]') observe(data); mapper.add(data); } }
      catch { fail(controller); }
    },
    flush(controller) {
      if (errored) return;
      try { for (const frame of frames.feed(new Uint8Array(), true)) { const data = frameData(frame); if (data !== undefined && data !== '[DONE]') observe(data); mapper.add(data); } mapper.finish(); cleanup(); }
      catch { fail(controller); }
    },
  });
}

/** JSON-only Responses 也能给 JetBrains 返回标准 Chat SSE。 */
export function chatResponseToSse(value: unknown): Uint8Array {
  const data = object(value), choices = data.choices;
  if (data.object !== 'chat.completion' || !Array.isArray(choices) || choices.length !== 1 || typeof data.id !== 'string' || typeof data.model !== 'string') return failed('无法将无效 Chat 回复转换为 SSE。');
  const choice = object(choices[0]), message = object(choice.message);
  if (message.role !== 'assistant' || !['stop', 'tool_calls', 'length'].includes(String(choice.finish_reason))) return failed('无法将无效 Chat 回复转换为 SSE。');
  const base = { id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model };
  const chunk = (delta: Json, reason: unknown = null): Json => ({ ...base, choices: [{ index: 0, delta, finish_reason: reason }] });
  const events: (Json | '[DONE]')[] = [chunk({ role: 'assistant', content: '' })];
  for (const key of ['content', 'refusal', 'reasoning_content']) {
    if (message[key] != null && typeof message[key] !== 'string') return failed('Chat 回复文本无效。');
    if (message[key]) events.push(chunk({ [key]: message[key] }));
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) return failed('Chat 工具调用无效。');
    message.tool_calls.forEach((raw, index) => { const call = object(raw), fn = object(call.function);
      if (call.type !== 'function' || typeof call.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') return failed('Chat 工具调用无效。');
      events.push(chunk({ tool_calls: [{ ...call, index }] }));
    });
  }
  events.push(chunk({}, choice.finish_reason));
  if (data.usage) events.push({ ...base, choices: [], usage: data.usage });
  events.push('[DONE]');
  return encoder.encode(events.map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join(''));
}

/** 订阅可强制 SSE；stream:false 收集同一映射，不将部分失败流伪装为完成回复。 */
export async function collectResponsesChatStream(source: ReadableStream<Uint8Array>, modelAlias: string, options: ResponsesChatStreamOptions = {}): Promise<Json> {
  const reader = source.pipeThrough(createResponsesChatStream(modelAlias, options), { signal: options.signal }).getReader(), frames = new Frames();
  const message: Json = { role: 'assistant', content: '' }, tools = new Map<number, Json>();
  let envelope: Json | undefined, finish: unknown, usage: unknown, done = false, bytes = 0;
  const add = (value: unknown) => {
    if (value === undefined) return;
    if (value === '[DONE]') { done = true; return; }
    const data = object(value); if (data.error != null) return failed();
    if (!envelope) envelope = { id: data.id, object: 'chat.completion', created: data.created, model: data.model };
    if (data.usage !== undefined) usage = data.usage;
    const choice = object(Array.isArray(data.choices) ? data.choices[0] : undefined), delta = object(choice.delta);
    for (const key of ['content', 'refusal', 'reasoning_content']) if (typeof delta[key] === 'string') message[key] = String(message[key] ?? '') + delta[key];
    if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
      const call = object(raw), index = count(call.index); if (index === undefined) return failed();
      const previous = tools.get(index) ?? { type: 'function', function: { name: '', arguments: '' } }, fn = object(call.function), old = object(previous.function);
      if (call.id !== undefined) previous.id = call.id;
      previous.function = { name: String(old.name) + String(fn.name ?? ''), arguments: String(old.arguments) + String(fn.arguments ?? '') }; tools.set(index, previous);
    }
    if (choice.finish_reason != null) finish = choice.finish_reason;
  };
  try {
    while (true) {
      const part = await reader.read(); bytes += part.value?.byteLength ?? 0; if (bytes > 32 * 1024 * 1024) return failed('上游回复过大。');
      for (const frame of frames.feed(part.value ?? new Uint8Array(), part.done)) add(frameData(frame));
      if (part.done) break;
    }
    if (!done || !envelope || !['stop', 'tool_calls', 'length'].includes(String(finish))) return failed();
    if (tools.size) message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    if (!message.content && (tools.size || message.refusal || message.reasoning_content)) message.content = null;
    return { ...envelope, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) };
  } catch (error) {
    if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw new DOMException('推理已取消。', 'AbortError');
    if (error instanceof ChatResponsesBridgeError) throw error;
    return failed();
  } finally { try { await reader.cancel(); } catch { /* 已关闭/取消。 */ } reader.releaseLock(); }
}
