import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;
export class ResponsesChatBridgeError extends Error {
  constructor(readonly status: 400 | 502, message: string) { super(message); this.name = 'ResponsesChatBridgeError'; }
}
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): Json => record(value) ? value : {};
const invalid = (message = 'Responses 请求包含 Chat 无法表达的参数。'): never => { throw new ResponsesChatBridgeError(400, message); };
const failed = (): never => { throw new ResponsesChatBridgeError(502, '上游 Chat 推理失败或响应不完整。'); };
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalid('消息、模型或工具标识无效。');
  return value;
}
function args(value: unknown, upstream = false): string {
  if (typeof value !== 'string') return upstream ? failed() : invalid('工具参数必须是 JSON 对象字符串。');
  try { if (!record(JSON.parse(value))) throw new Error(); } catch { return upstream ? failed() : invalid('工具参数必须是 JSON 对象字符串。'); }
  return value;
}
function textContent(value: unknown, role: string): string | Json[] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return invalid('历史消息内容必须是文本或内容块。');
  return value.map(part => {
    if (!record(part)) return invalid();
    if (['input_text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string' && !Object.keys(part).some(key => !['type', 'text', 'annotations'].includes(key))) return { type: 'text', text: part.text };
    if (part.type === 'input_image' && role === 'user' && typeof part.image_url === 'string') {
      if (Object.keys(part).some(key => !['type', 'image_url', 'detail'].includes(key))) return invalid('此 Chat 来源仅支持图片 URL。');
      const url = part.image_url;
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
        let parsed: URL; try { parsed = new URL(url); } catch { return invalid('图片 URL 无效。'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return invalid('图片 URL 必须使用 HTTP(S)，不能包含凭据。');
      }
      if (part.detail !== undefined && !['auto', 'low', 'high'].includes(String(part.detail))) return invalid('图片 detail 参数无效。');
      return { type: 'image_url', image_url: { url, detail: part.detail ?? 'auto' } };
    }
    return invalid('此桥接仅支持文本和用户图片，不能转换加密推理、音频或文件历史。');
  });
}

/** Stateless Responses -> Chat. Unsupported semantics fail before inference. */
export function parseResponsesChatRequest(value: unknown): Json {
  if (!record(value)) return invalid('Responses 请求必须是 JSON 对象。');
  if (value.previous_response_id !== undefined || value.conversation !== undefined) return invalid('此 Chat 来源不支持服务端会话续接；请移除 previous_response_id / conversation，并在 input 中发送完整历史。');
  const supported = new Set(['model', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_output_tokens',
    'temperature', 'top_p', 'reasoning', 'text', 'store', 'metadata', 'user', 'prompt_cache_key', 'safety_identifier', 'service_tier', 'include', 'truncation']);
  if (Object.keys(value).some(key => value[key] !== undefined && !supported.has(key))) return invalid();
  if (value.stream !== undefined && typeof value.stream !== 'boolean' || value.store !== undefined && value.store !== false) return invalid('此桥接仅支持无服务端存储的请求。');
  if (value.include !== undefined && (!Array.isArray(value.include) || value.include.length)) return invalid('此 Chat 来源不支持 Responses include。');
  if (value.truncation !== undefined && value.truncation !== 'disabled') return invalid('此 Chat 来源不支持服务端历史截断。');
  const result: Json = { model: label(value.model), stream: value.stream === true, messages: [] };
  if (result.stream) result.stream_options = { include_usage: true };
  const messages = result.messages as Json[], calls = new Set<string>(), outputs = new Set<string>();
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== 'string') return invalid('instructions 必须是文本。');
    if (value.instructions) messages.push({ role: 'system', content: value.instructions });
  }
  const input = typeof value.input === 'string' ? [{ role: 'user', content: value.input }] : value.input;
  if (!Array.isArray(input) || !input.length) return invalid('请发送完整的 input 历史。');
  for (const raw of input) {
    if (!record(raw)) return invalid();
    const type = raw.type ?? 'message';
    if (type === 'function_call') {
      if (Object.keys(raw).some(key => !['type', 'id', 'status', 'call_id', 'name', 'arguments'].includes(key))) return invalid();
      const id = label(raw.call_id); if (calls.has(id)) return invalid('工具调用 ID 重复。'); calls.add(id);
      const call = { id, type: 'function', function: { name: label(raw.name), arguments: args(raw.arguments) } };
      let message = messages.at(-1);
      if (message?.role !== 'assistant') { message = { role: 'assistant', content: null, tool_calls: [] }; messages.push(message); }
      (message.tool_calls ??= [] as Json[]); (message.tool_calls as Json[]).push(call);
    } else if (type === 'function_call_output') {
      if (Object.keys(raw).some(key => !['type', 'id', 'status', 'call_id', 'output'].includes(key))) return invalid();
      const id = label(raw.call_id); if (!calls.has(id) || outputs.has(id)) return invalid('工具结果缺少对应调用，或重复返回结果。'); outputs.add(id);
      messages.push({ role: 'tool', tool_call_id: id, content: textContent(raw.output, 'tool') });
    } else if (type === 'message') {
      if (Object.keys(raw).some(key => !['type', 'id', 'status', 'role', 'content'].includes(key)) || !['user', 'assistant', 'system', 'developer'].includes(String(raw.role))) return invalid('历史消息角色或字段不受支持。');
      messages.push({ role: raw.role, content: textContent(raw.content, String(raw.role)) });
    } else return invalid('此 Chat 来源不能转换加密推理或服务端工具历史。');
  }
  for (const key of ['temperature', 'top_p']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Number(value[key]) < 0 || Number(value[key]) > (key === 'temperature' ? 2 : 1)) return invalid('采样参数范围无效。');
    result[key] = value[key];
  }
  if (value.max_output_tokens !== undefined) { if (!count(value.max_output_tokens) || value.max_output_tokens === 0) return invalid('输出预算必须是正整数。'); result.max_completion_tokens = value.max_output_tokens; }
  if (value.reasoning !== undefined) {
    const reasoning = object(value.reasoning);
    if (!record(value.reasoning) || Object.keys(reasoning).some(key => key !== 'effort') || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(reasoning.effort))) return invalid('此 Chat 来源仅支持 reasoning.effort。');
    result.reasoning_effort = reasoning.effort;
  }
  const names = new Set<string>();
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) return invalid();
    result.tools = value.tools.map(raw => {
      if (!record(raw) || raw.type !== 'function' || Object.keys(raw).some(key => !['type', 'name', 'description', 'parameters', 'strict'].includes(key))) return invalid('仅支持客户端 function 工具。');
      const name = label(raw.name); if (names.has(name)) return invalid('工具名称重复。'); names.add(name);
      if (raw.parameters !== undefined && !record(raw.parameters) || raw.description !== undefined && typeof raw.description !== 'string' || raw.strict !== undefined && typeof raw.strict !== 'boolean') return invalid();
      return { type: 'function', function: { name, parameters: structuredClone(raw.parameters ?? { type: 'object', properties: {} }), ...(raw.description !== undefined ? { description: raw.description } : {}), ...(raw.strict !== undefined ? { strict: raw.strict } : {}) } };
    });
  }
  if (value.tool_choice !== undefined) {
    if (['auto', 'none', 'required'].includes(String(value.tool_choice))) { if (value.tool_choice === 'required' && !names.size) return invalid(); result.tool_choice = value.tool_choice; }
    else { const choice = object(value.tool_choice); if (choice.type !== 'function' || Object.keys(choice).some(key => !['type', 'name'].includes(key)) || !names.has(String(choice.name))) return invalid(); result.tool_choice = { type: 'function', function: { name: choice.name } }; }
  }
  if (value.parallel_tool_calls !== undefined) { if (typeof value.parallel_tool_calls !== 'boolean') return invalid(); result.parallel_tool_calls = value.parallel_tool_calls; }
  if (value.text !== undefined) {
    const text = object(value.text), format = object(text.format);
    if (!record(value.text) || Object.keys(text).some(key => key !== 'format')) return invalid();
    if (format.type === 'text') { if (Object.keys(format).some(key => key !== 'type')) return invalid(); }
    else if (format.type === 'json_object') { if (Object.keys(format).some(key => key !== 'type')) return invalid(); result.response_format = { type: 'json_object' }; }
    else if (format.type === 'json_schema' && record(format.schema) && (format.strict === undefined || typeof format.strict === 'boolean') && (format.description === undefined || typeof format.description === 'string') && !Object.keys(format).some(key => !['type', 'name', 'schema', 'strict', 'description'].includes(key))) { const { type: _type, ...schema } = format; result.response_format = { type: 'json_schema', json_schema: { ...schema, name: label(format.name) } }; }
    else return invalid('结构化输出格式无法转换。');
  }
  for (const key of ['metadata', 'user', 'prompt_cache_key', 'safety_identifier', 'service_tier']) if (value[key] !== undefined) {
    if (key === 'metadata' ? !record(value[key]) || Object.values(value[key] as Json).some(item => typeof item !== 'string') : typeof value[key] !== 'string') return invalid();
    result[key] = structuredClone(value[key]);
  }
  return result;
}

interface Block { index: number; id: string; kind: 'text' | 'refusal' | 'reasoning' | 'tool'; text: string; callId?: string; name?: string; opened: boolean }
class Mapper {
  private id = `resp_${randomUUID().replace(/-/g, '')}`; private created = Math.floor(Date.now() / 1000); private started = false;
  private terminal?: string; private done = false; private sequence = 0; private bytes = 0; private usage: Json | null = null;
  private upstreamId?: string; private upstreamModel?: string; private upstreamCreated?: number;
  private blocks = new Map<string, Block>();
  constructor(private alias: string, private emit: (value: Json) => void) {}
  private event(value: Json): void { this.emit({ ...value, sequence_number: this.sequence++ }); }
  private envelope(status: string, output: Json[]): Json { return { id: this.id, object: 'response', created_at: this.created, model: this.alias, status, output, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, usage: this.usage }; }
  private start(): void { if (!this.started) { this.started = true; this.event({ type: 'response.created', response: this.envelope('in_progress', []) }); } }
  private item(block: Block, status: string): Json {
    if (block.kind === 'tool') return { type: 'function_call', id: block.id, call_id: block.callId, name: block.name, arguments: status === 'in_progress' ? '' : block.text, status };
    if (block.kind === 'reasoning') return { type: 'reasoning', id: block.id, summary: status === 'in_progress' ? [] : [{ type: 'summary_text', text: block.text }] };
    return { type: 'message', id: block.id, role: 'assistant', status, content: status === 'in_progress' ? [] : [this.part(block)] };
  }
  private part(block: Block): Json { return block.kind === 'refusal' ? { type: 'refusal', refusal: block.text } : { type: 'output_text', text: block.text, annotations: [] }; }
  private block(key: string, kind: Block['kind'], callId?: unknown, name?: unknown): Block {
    this.start(); let block = this.blocks.get(key);
    if (!block) { block = { index: this.blocks.size, id: `${kind === 'tool' ? 'fc' : kind === 'reasoning' ? 'rs' : 'msg'}_${randomUUID().replace(/-/g, '')}`, kind, text: '', opened: false }; this.blocks.set(key, block); }
    if (block.kind !== kind) return failed();
    if (callId !== undefined) { if (typeof callId !== 'string' || !callId || block.callId && block.callId !== callId || [...this.blocks.values()].some(other => other !== block && other.callId === callId)) return failed(); block.callId = callId; }
    if (name !== undefined) { if (typeof name !== 'string' || !name || block.name && block.name !== name) return failed(); block.name = name; }
    if (!block.opened && (kind !== 'tool' || block.callId && block.name)) {
      block.opened = true; this.event({ type: 'response.output_item.added', output_index: block.index, item: this.item(block, 'in_progress') });
      if (kind === 'reasoning') this.event({ type: 'response.reasoning_summary_part.added', output_index: block.index, item_id: block.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
      else if (kind !== 'tool') this.event({ type: 'response.content_part.added', output_index: block.index, item_id: block.id, content_index: 0, part: kind === 'refusal' ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] } });
      if (block.text) this.delta(block, block.text);
    }
    return block;
  }
  private delta(block: Block, delta: string): void {
    const type = block.kind === 'tool' ? 'response.function_call_arguments.delta' : block.kind === 'reasoning' ? 'response.reasoning_summary_text.delta' : block.kind === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta';
    this.event({ type, output_index: block.index, item_id: block.id, ...(block.kind === 'tool' ? {} : block.kind === 'reasoning' ? { summary_index: 0 } : { content_index: 0 }), delta });
  }
  private append(block: Block, value: unknown): void {
    if (typeof value !== 'string') return failed(); this.bytes += Buffer.byteLength(value); if (this.bytes > 32 * 1024 * 1024) return failed();
    block.text += value; if (value && block.opened) this.delta(block, value);
  }
  add(value: unknown): void {
    if (value === undefined) return;
    if (value === '[DONE]') { if (this.done || !this.terminal) return failed(); this.done = true; return; }
    if (this.done || !record(value) || value.error != null || value.object !== undefined && value.object !== 'chat.completion.chunk' || !Array.isArray(value.choices)) return failed();
    for (const [field, previous] of [['id', this.upstreamId], ['model', this.upstreamModel]] as const) if (value[field] !== undefined) {
      if (typeof value[field] !== 'string' || !value[field] || previous !== undefined && previous !== value[field]) return failed();
      if (field === 'id') this.upstreamId = value[field]; else this.upstreamModel = value[field];
    }
    if (value.created !== undefined) { if (!count(value.created) || this.upstreamCreated !== undefined && this.upstreamCreated !== value.created) return failed(); this.upstreamCreated = value.created; }
    if (value.usage != null) {
      const usage = object(value.usage); if (!count(usage.prompt_tokens) || !count(usage.completion_tokens) || usage.total_tokens !== undefined && !count(usage.total_tokens)) return failed();
      this.usage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens };
      for (const [from, to] of [['prompt_tokens_details', 'input_tokens_details'], ['completion_tokens_details', 'output_tokens_details']]) if (usage[from] != null) { const details = usage[from]; if (!record(details) || Object.values(details).some(item => !count(item))) return failed(); this.usage[to] = structuredClone(details); }
    }
    if (!value.choices.length) { if (value.usage == null) return failed(); return; }
    if (value.choices.length !== 1) return failed();
    const choice = object(value.choices[0]), delta = object(choice.delta);
    if (!record(choice.delta) || choice.index !== undefined && choice.index !== 0 || delta.role !== undefined && delta.role !== 'assistant' || this.terminal) return failed();
    if (Object.keys(delta).some(key => !['role', 'content', 'refusal', 'reasoning_content', 'tool_calls'].includes(key))) return failed();
    this.start();
    for (const [field, kind] of [['content', 'text'], ['refusal', 'refusal'], ['reasoning_content', 'reasoning']] as const) if (delta[field] != null) { if (typeof delta[field] !== 'string') return failed(); if (delta[field]) this.append(this.block(kind, kind), delta[field]); }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) return failed();
      for (const raw of delta.tool_calls) {
        const call = object(raw), fn = object(call.function);
        if (!count(call.index) || call.index > 128 || call.type !== undefined && call.type !== 'function' || call.function !== undefined && !record(call.function) || Object.keys(fn).some(key => !['name', 'arguments'].includes(key))) return failed();
        const block = this.block(`tool:${call.index}`, 'tool', call.id, fn.name); if (fn.arguments !== undefined) this.append(block, fn.arguments);
      }
    }
    if (choice.finish_reason != null) { if (!['stop', 'tool_calls', 'length'].includes(String(choice.finish_reason))) return failed(); this.terminal = String(choice.finish_reason); }
  }
  finish(): Json {
    if (!this.terminal || !this.done || !this.blocks.size || [...this.blocks.values()].some(block => !block.opened)) return failed();
    const tools = [...this.blocks.values()].filter(block => block.kind === 'tool');
    if (this.terminal === 'tool_calls' && !tools.length || this.terminal === 'stop' && tools.length) return failed();
    for (const block of tools) args(block.text, true);
    const output: Json[] = [];
    for (const block of this.blocks.values()) {
      const common = { output_index: block.index, item_id: block.id };
      if (block.kind === 'tool') this.event({ type: 'response.function_call_arguments.done', ...common, arguments: block.text, name: block.name });
      else if (block.kind === 'reasoning') { this.event({ type: 'response.reasoning_summary_text.done', ...common, summary_index: 0, text: block.text }); this.event({ type: 'response.reasoning_summary_part.done', ...common, summary_index: 0, part: { type: 'summary_text', text: block.text } }); }
      else { this.event({ type: block.kind === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', ...common, content_index: 0, ...(block.kind === 'refusal' ? { refusal: block.text } : { text: block.text }) }); this.event({ type: 'response.content_part.done', ...common, content_index: 0, part: this.part(block) }); }
      const item = this.item(block, 'completed'); output.push(item); this.event({ type: 'response.output_item.done', output_index: block.index, item });
    }
    const response = this.envelope(this.terminal === 'length' ? 'incomplete' : 'completed', output);
    this.event({ type: this.terminal === 'length' ? 'response.incomplete' : 'response.completed', response }); return response;
  }
  failure(): Json { return { type: 'response.failed', sequence_number: this.sequence++, response: { ...this.envelope('failed', []), error: { code: 'upstream_error', message: '上游推理失败或响应不完整，请检查模型协议和供应商状态。' } } }; }
}

export function chatToResponses(value: unknown, alias: string): Json {
  if (!record(value) || value.error != null || value.object !== undefined && value.object !== 'chat.completion'
    || value.id !== undefined && (typeof value.id !== 'string' || !value.id) || value.created !== undefined && !count(value.created)
    || !Array.isArray(value.choices) || value.choices.length !== 1) return failed();
  const choice = object(value.choices[0]), message = object(choice.message);
  if (message.role !== 'assistant' || choice.index !== undefined && choice.index !== 0) return failed();
  const mapper = new Mapper(alias, () => {}), delta = { ...message }; delete delta.role;
  if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...object(call), index }));
  mapper.add({ choices: [{ index: 0, delta: { ...delta, role: 'assistant' }, finish_reason: choice.finish_reason }], ...(value.usage != null ? { usage: value.usage } : {}) }); mapper.add('[DONE]'); return mapper.finish();
}

class Frames {
  private decoder = new TextDecoder('utf-8', { fatal: true }); private pending = '';
  feed(bytes: Uint8Array, last = false): unknown[] {
    this.pending += this.decoder.decode(bytes, { stream: !last }); if (this.pending.length > 8 * 1024 * 1024) return failed();
    const frames: string[] = []; let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) { frames.push(this.pending.slice(0, separator.index)); this.pending = this.pending.slice(separator.index + separator[0].length); }
    if (last && this.pending.trim()) { frames.push(this.pending); this.pending = ''; }
    return frames.map(frame => { const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n').trim(); if (!data) return undefined; if (data === '[DONE]') return data; try { return JSON.parse(data); } catch { return failed(); } });
  }
}
export interface ChatResponsesStreamOptions { signal?: AbortSignal; onUpstreamEvent?: (value: unknown) => void }
const encoder = new TextEncoder();
const event = (value: Json) => encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);

/** Delta events are emitted immediately. Terminal success waits for validated EOF. */
export function createChatResponsesStream(alias: string, options: ChatResponsesStreamOptions = {}): TransformStream<Uint8Array, Uint8Array> {
  const frames = new Frames(); let mapper: Mapper, errored = false, abort: (() => void) | undefined;
  const cleanup = () => { if (abort) options.signal?.removeEventListener('abort', abort); };
  const observe = (value: unknown) => { try { options.onUpstreamEvent?.(value); } catch { /* Diagnostics cannot break inference. */ } };
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    errored = true; cleanup(); const value = mapper.failure(); observe(value); controller.enqueue(event(value)); controller.terminate();
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { mapper = new Mapper(alias, value => controller.enqueue(event(value))); abort = () => { errored = true; cleanup(); controller.error(new DOMException('推理已取消。', 'AbortError')); }; if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true }); },
    transform(bytes, controller) { if (errored) return; try { for (const value of frames.feed(bytes)) { if (value !== undefined && value !== '[DONE]') observe(value); mapper.add(value); } } catch { fail(controller); } },
    flush(controller) { if (errored) return; try { for (const value of frames.feed(new Uint8Array(), true)) { if (value !== undefined && value !== '[DONE]') observe(value); mapper.add(value); } mapper.finish(); cleanup(); } catch { fail(controller); } },
  });
}

export async function collectChatResponsesStream(source: ReadableStream<Uint8Array>, alias: string, options: ChatResponsesStreamOptions = {}): Promise<Json> {
  const reader = source.pipeThrough(createChatResponsesStream(alias, options), { signal: options.signal }).getReader(), frames = new Frames(); let result: Json | undefined;
  try { while (true) { const part = await reader.read(); for (const value of frames.feed(part.value ?? new Uint8Array(), part.done)) { const data = object(value); if (data.type === 'response.failed') return failed(); if (['response.completed', 'response.incomplete'].includes(String(data.type))) { if (result || !record(data.response)) return failed(); result = data.response; } } if (part.done) break; } if (!result) return failed(); return result; }
  catch (error) { if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw new DOMException('推理已取消。', 'AbortError'); if (error instanceof ResponsesChatBridgeError) throw error; return failed(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
