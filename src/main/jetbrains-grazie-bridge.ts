import { createHash, randomUUID } from 'node:crypto';
import { JetBrainsGrazieSignatures } from './jetbrains-grazie-signatures';
export { JetBrainsGrazieSignatures } from './jetbrains-grazie-signatures';
type Json = Record<string, unknown>;
export interface JetBrainsGrazieOptions { profileId?: string; maxOutputTokens?: number; reasoningEfforts?: readonly string[]; signatureNamespace?: string; signatures?: JetBrainsGrazieSignatures; history?: unknown; requireToolSignatures?: boolean; toolNames?: readonly string[]; signal?: AbortSignal }
export class JetBrainsGrazieBridgeError extends Error {
  constructor(readonly status: 400 | 502, message = status === 400 ? '此 JetBrains 连接暂不支持所请求的消息、参数或签名历史，请使用新的文本会话重试。' : 'JetBrains 返回了无法识别或未完整结束的流，本次响应未被标记为成功。') { super(message); this.name = 'JetBrainsGrazieBridgeError'; }
}
const bad = () => new JetBrainsGrazieBridgeError(400), invalid = () => new JetBrainsGrazieBridgeError(502);
const MAX_BYTES = 32 * 1024 * 1024, MAX_EVENT = 1024 * 1024, MAX_ARGS = 256 * 1024, MAX_TOOLS = 128;
const object = (value: unknown): Json | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const validUnicode = (value: string): boolean => Buffer.from(value).toString('utf8') === value;
const text = (value: unknown, max = MAX_EVENT): string => { if (typeof value !== 'string' || Buffer.byteLength(value) > max || !validUnicode(value)) throw bad(); return value; };
const name = (value: unknown): string => { const result = text(value, 256); if (!result || /[\s\x00-\x1f\x7f]/.test(result)) throw bad(); return result; };
const only = (record: Json, fields: readonly string[]): void => { if (Object.keys(record).some(key => !fields.includes(key) && record[key] !== undefined)) throw bad(); };
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); const record = object(value); return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])])) : value; }
function normalizedMessage(input: unknown): Json {
  const message = object(input); if (!message) throw bad();
  const result: Json = { role: message.role, content: message.content ?? '' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) result.tool_calls = message.tool_calls.map(value => { const call = object(value), fn = object(call?.function); return { id: call?.id, type: call?.type ?? 'function', function: { name: fn?.name, arguments: fn?.arguments } }; });
  if (message.tool_call_id != null) result.tool_call_id = message.tool_call_id;
  // Tool names are derived from the paired call; client-added names cannot
  // change the signature namespace for otherwise identical tool history.
  return result;
}
function historyNamespace(options: JetBrainsGrazieOptions, history: unknown[]): string | undefined {
  if (!options.signatureNamespace) return;
  return options.signatureNamespace + ':' + createHash('sha256').update(JSON.stringify(stable(history.map(normalizedMessage)))).digest('hex');
}
function inlineContent(value: unknown, role: string): Json[] {
  if (typeof value === 'string') return [{ type: role === 'assistant' ? 'assistant_message_text' : role === 'system' ? 'system_message' : 'user_message', content: text(value) }];
  if (!Array.isArray(value) || role !== 'user') throw bad();
  return value.map(part => {
    const item = object(part); if (!item) throw bad();
    if (item.type === 'text') { only(item, ['type', 'text']); return { type: 'user_message', content: text(item.text) }; }
    only(item, ['type', 'image_url']);
    const image = object(item.image_url);
    if (item.type !== 'image_url' || !image || image.detail !== undefined && image.detail !== 'auto') throw bad();
    only(image, ['url', 'detail']);
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(text(image.url, 8 * MAX_EVENT));
    if (!match || match[2].length % 4 !== 0 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) throw bad();
    return { type: 'media_message', mediaType: match[1], data: match[2] };
  });
}
/** Matches the installed official ChatModels.Stream.V9.Request serializer.
 * Provider differences stay inside the existing main-process gateway. */
export function prepareJetBrainsGrazieChat(body: Json, options: JetBrainsGrazieOptions): Json {
  const allowed = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'seed', 'stop', 'n', 'stream_options', 'reasoning_effort']);
  if (Object.keys(body).some(key => !allowed.has(key) && body[key] !== undefined) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 4096 || body.stream !== undefined && typeof body.stream !== 'boolean') throw bad();
  if (body.stream_options !== undefined) { const value = object(body.stream_options); if (!value || Object.keys(value).some(key => key !== 'include_usage') || value.include_usage !== undefined && typeof value.include_usage !== 'boolean') throw bad(); }
  const parameters: Json = {}, tools: Json[] = [], toolNames = new Set<string>();
  if (body.reasoning_effort !== undefined) {
    if (typeof body.reasoning_effort !== 'string' || !options.reasoningEfforts?.includes(body.reasoning_effort)) throw bad();
    parameters.reasoningEffort = body.reasoning_effort;
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) throw bad();
    for (const input of body.tools) {
      const tool = object(input), fn = object(tool?.function); if (tool?.type !== 'function' || !fn) throw bad();
      only(tool, ['type', 'function']); only(fn, ['name', 'description', 'parameters', 'strict']);
      const toolName = name(fn.name); if (toolNames.has(toolName) || fn.strict !== undefined && fn.strict !== false) throw bad(); toolNames.add(toolName);
      const schema = object(fn.parameters); if (!schema) throw bad();
      tools.push({ name: toolName, ...(fn.description === undefined ? {} : { description: text(fn.description) }), parameters: { schema } });
    }
  }
  if (tools.length || body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) {
    const config: Json = { tools };
    if (body.parallel_tool_calls !== undefined) { if (typeof body.parallel_tool_calls !== 'boolean') throw bad(); config.parallelToolCalls = body.parallel_tool_calls; }
    if (body.tool_choice !== undefined) {
      if (typeof body.tool_choice === 'string' && ['auto', 'required', 'none'].includes(body.tool_choice)) { if (body.tool_choice === 'required' && !tools.length) throw bad(); config.toolChoice = { [body.tool_choice]: true }; }
      else { const choice = object(body.tool_choice), fn = object(choice?.function); if (choice?.type !== 'function' || !fn || !toolNames.has(String(fn.name))) throw bad(); only(choice, ['type', 'function']); only(fn, ['name']); config.toolChoice = { named: fn.name }; }
    }
    parameters.toolConfig = config;
  }
  const limits = [body.max_tokens, body.max_completion_tokens].filter(value => value !== undefined);
  if (limits.length > 1 && limits[0] !== limits[1]) throw bad();
  if (limits.length) { const value = limits[0]; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || options.maxOutputTokens !== undefined && value > options.maxOutputTokens) throw bad(); parameters.length = value; }
  for (const [source, target, min, max] of [['temperature', 'temperature', 0, 2], ['top_p', 'topP', 0, 1]] as const) if (body[source] !== undefined) { const value = body[source]; if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw bad(); parameters[target] = value; }
  if (body.seed !== undefined) { if (typeof body.seed !== 'number' || !Number.isSafeInteger(body.seed)) throw bad(); parameters.seed = body.seed; }
  if (body.n !== undefined && body.n !== 1) throw bad();
  if (body.stop !== undefined) { const stop = Array.isArray(body.stop) && body.stop.length === 1 ? body.stop[0] : body.stop; parameters.stopToken = text(stop); }
  const native: Json[] = [], prefix: unknown[] = [], pending = new Map<string, string>();
  for (const input of body.messages) {
    const original = object(input); if (!original) throw bad();
    const message = { ...original };
    // Standard Chat SDKs serialize absent optional fields as null. These are
    // semantically absent; preserve rejection of every non-null unsupported field.
    for (const field of ['tool_calls', 'tool_call_id', 'name', 'reasoning_content', 'refusal', 'function_call', 'audio', 'reasoning', 'thoughtSignature']) if (message[field] === null) delete message[field];
    if (Array.isArray(message.tool_calls) && !message.tool_calls.length) delete message.tool_calls;
    if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role)) || message.reasoning_content !== undefined && message.reasoning_content !== '' || message.reasoning !== undefined || message.thoughtSignature !== undefined) throw bad();
    only(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'reasoning_content']);
    const role = String(message.role);
    if (role !== 'assistant' && (message.tool_calls !== undefined || message.reasoning_content !== undefined) || role !== 'tool' && (message.tool_call_id !== undefined || message.name !== undefined)) throw bad();
    if (role === 'tool') {
      const id = name(message.tool_call_id), toolName = pending.get(id); if (!toolName || message.name !== undefined && message.name !== toolName) throw bad();
      native.push({ type: 'tool_message', id, toolName, result: text(message.content) }); pending.delete(id);
    } else {
      if (pending.size) throw bad();
      const content = message.content ?? ''; const parts = inlineContent(content, role);
      const ns = historyNamespace(options, prefix);
      for (const part of parts) { if (role === 'assistant' && part.content) { const signature = ns && options.signatures?.lookupText(ns, String(part.content)); if (signature) part.thoughtSignature = signature; } if (part.content !== '' || role !== 'assistant') native.push(part); }
      if (message.tool_calls !== undefined) {
        if (role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > MAX_TOOLS) throw bad();
        for (const inputCall of message.tool_calls) {
          const call = object(inputCall), fn = object(call?.function); if (call?.type !== 'function' || !fn) throw bad();
          only(call, ['id', 'type', 'function']); only(fn, ['name', 'arguments']);
          const id = name(call.id), toolName = name(fn.name), args = text(fn.arguments, MAX_ARGS); if (pending.has(id)) throw bad();
          try { if (!object(JSON.parse(args))) throw bad(); } catch { throw bad(); }
          const receipt = ns ? options.signatures?.lookupToolRecord(ns, { id, name: toolName, arguments: args }) : undefined;
          const signature = receipt?.signature;
          if (options.requireToolSignatures && !receipt) throw bad();
          native.push({ type: 'assistant_message_tool', id, toolName, content: args, ...(signature ? { thoughtSignature: signature } : {}) }); pending.set(id, toolName);
        }
      }
    }
    prefix.push(input);
  }
  if (pending.size || !native.length) throw bad();
  const request = { prompt: 'modeldock', profile: name(options.profileId), chat: { messages: native }, parameters };
  if (Buffer.byteLength(JSON.stringify(request)) > 8 * MAX_EVENT) throw bad();
  return request;
}

interface ToolState { id?: string; name?: string; args: string; pending: string; signature?: string; started: boolean }
/** Native continuous SSE -> OpenAI Chat SSE. Only terminal frames are held;
 * text is hashed incrementally and tool JSON is retained under a strict bound. */
export function createJetBrainsGrazieChatStream(alias: string, options: JetBrainsGrazieOptions = {}): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true }), id = 'chatcmpl_' + randomUUID();
  const created = Math.floor(Date.now() / 1000), tools = new Map<number, ToolState>(), textHash = createHash('sha256');
  const ns = historyNamespace(options, Array.isArray(options.history) ? options.history : []);
  let buffered = '', pendingCR = false, bytes = 0, started = false, hasText = false, finish: string | undefined, nativeDone = false, textSignature: string | undefined, aborted = false;
  let streamController: TransformStreamDefaultController<Uint8Array> | undefined;
  const abort = () => { aborted = true; try { streamController?.error(invalid()); } catch { /* already closed */ } };
  const cleanup = () => options.signal?.removeEventListener('abort', abort);
  const ensure = () => { if (aborted || options.signal?.aborted) throw invalid(); };
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, delta: Json, reason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: alias, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`));
  const begin = (controller: TransformStreamDefaultController<Uint8Array>) => { if (!started) { emit(controller, { role: 'assistant' }); started = true; } };
  const signature = (old: string | undefined, value: unknown): string | undefined => {
    if (value === undefined || value === null) return old;
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 32768 || !validUnicode(value) || /[\x00-\x1f\x7f]/.test(value) || old !== undefined && old !== value) throw invalid(); return value;
  };
  // SSE permits CRLF, LF and CR line endings. Keep a trailing CR across byte
  // chunks rather than allowing a split delimiter to change frame boundaries.
  const appendDecoded = (value: string, final = false) => {
    if (pendingCR && (value.length || final)) { buffered += '\n'; if (value.startsWith('\n')) value = value.slice(1); pendingCR = false; }
    if (value.endsWith('\r')) { pendingCR = true; value = value.slice(0, -1); }
    buffered += value.replace(/\r\n|\r/g, '\n');
    if (final && pendingCR) { buffered += '\n'; pendingCR = false; }
  };
  const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let boundary;
    while ((boundary = buffered.indexOf('\n\n')) >= 0) { const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2); event(frame, controller); }
    if (buffered.length > MAX_EVENT) throw invalid();
  };
  function event(frame: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    ensure(); if (frame.length > MAX_EVENT) throw invalid();
    let eventName = ''; const data: string[] = [];
    for (const line of frame.split('\n')) { if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, '')); else if (line.startsWith('event:')) eventName = line.slice(6).trim(); }
    if (['error', 'timeout', 'cancel', 'premature_end'].includes(eventName.toLowerCase())) throw invalid();
    const payload = data.join('\n'); if (!payload) return;
    if (payload === 'end' || payload === '[DONE]') { if (!finish || nativeDone) throw invalid(); nativeDone = true; return; }
    if (nativeDone) throw invalid();
    let row: Json | undefined; try { row = object(JSON.parse(payload)); } catch { throw invalid(); }
    if (!row || row.event_type !== undefined && row.event_type !== 'data' || typeof row.type !== 'string' || !row.type || row.type.length > 128 || row.error != null || /(?:error|exception|fail|cancel|timeout|premature)/i.test(row.type)) throw invalid();
    if (row.choiceIndex !== undefined && row.choiceIndex !== null && row.choiceIndex !== 0) throw invalid();
    if (row.type === 'QuotaMetadata' || row.type === 'UnknownMetadata') return;
    if (row.type === 'FinishMetadata') {
      if (finish || !['stop', 'length', 'tool_call', 'function_call'].includes(String(row.reason))) throw invalid();
      finish = row.reason === 'tool_call' || row.reason === 'function_call' ? 'tool_calls' : String(row.reason); return;
    }
    if (finish) throw invalid();
    if (row.type === 'Content') {
      if (typeof row.content !== 'string' || !validUnicode(row.content)) throw invalid();
      textSignature = signature(textSignature, row.thoughtSignature);
      if (row.content) { hasText = true; textHash.update(row.content); begin(controller); emit(controller, { content: row.content }); }
      return;
    }
    if (row.type === 'ToolCall') {
      const index = row.parallelToolIndex ?? 0, fragment = row.content === undefined ? '' : row.content;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOLS || typeof fragment !== 'string' || !validUnicode(fragment)) throw invalid();
      const tool = tools.get(index) ?? { args: '', pending: '', started: false };
      for (const field of ['id', 'name'] as const) if (row[field] !== undefined && row[field] !== null && row[field] !== '') { const value = row[field]; if (typeof value !== 'string' || Buffer.byteLength(value) > 256 || !validUnicode(value) || /[\s\x00-\x1f\x7f]/.test(value) || tool[field] !== undefined && tool[field] !== value) throw invalid(); tool[field] = value; }
      if (tool.id && [...tools.entries()].some(([otherIndex, other]) => otherIndex !== index && other.id === tool.id)) throw invalid();
      if (tool.name && options.toolNames && !options.toolNames.includes(tool.name)) throw invalid();
      tool.signature = signature(tool.signature, row.thoughtSignature); tool.args += fragment; tool.pending += fragment;
      if (Buffer.byteLength(tool.args) > MAX_ARGS || [...tools.values()].reduce((sum, value) => sum + Buffer.byteLength(value.args), 0) + (tools.has(index) ? 0 : Buffer.byteLength(tool.args)) > MAX_EVENT) throw invalid();
      tools.set(index, tool);
      if (tool.id && tool.name) { begin(controller); emit(controller, { tool_calls: [{ index, ...(!tool.started ? { id: tool.id, type: 'function' } : {}), function: { ...(!tool.started ? { name: tool.name } : {}), arguments: tool.pending } }] }); tool.pending = ''; tool.started = true; }
      return;
    }
    // Official V9 LLMDataSerializer maps unrecognized data discriminators to
    // UnknownMetadata. Ignore only that forward-compatible metadata fallback;
    // errors were rejected above, and valid content + finish remain mandatory.
    return;
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { streamController = controller; options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort(); },
    transform(chunk, controller) {
      try { ensure(); bytes += chunk.byteLength; if (bytes > MAX_BYTES) throw invalid(); appendDecoded(decoder.decode(chunk, { stream: true })); drain(controller);
      } catch { cleanup(); throw invalid(); }
    },
    flush(controller) {
      try {
        ensure(); appendDecoded(decoder.decode(), true); drain(controller);
        // A length stop with tool deltas is truncated tool output, even if the
        // partial arguments happen to parse; never advertise it as executable.
        if (buffered.trim() || !finish || !started || finish === 'tool_calls' && !tools.size || finish !== 'tool_calls' && tools.size) throw invalid();
        for (const tool of tools.values()) { if (!tool.started || !tool.id || !tool.name || tool.pending) throw invalid(); try { if (!object(JSON.parse(tool.args))) throw invalid(); } catch { throw invalid(); } }
        if (!hasText && !tools.size) throw invalid();
        // The opaque signatures never cross the renderer/client boundary.
        // Commit only after native success and EOF have both been validated.
        if (ns && options.signatures) options.signatures.rememberBatch(ns, {
          ...(textSignature && hasText ? { text: { digest: textHash.digest('hex'), signature: textSignature } } : {}),
          tools: [...tools.values()].map(tool => ({ tool: { id: tool.id!, name: tool.name!, arguments: tool.args }, signature: tool.signature })),
        });
        emit(controller, {}, finish); controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch { throw invalid(); } finally { cleanup(); }
    },
  });
}
/** Nonstream requests use the same verified stream path and explicit size
 * bound; no second inference or retry is performed. */
export async function collectJetBrainsGrazieChat(source: ReadableStream<Uint8Array>, alias: string, options: JetBrainsGrazieOptions = {}): Promise<Json> {
  const reader = source.pipeThrough(createJetBrainsGrazieChatStream(alias, options)).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true }); let buffered = '', count = 0, content = '', final: string | undefined, id = '', created = 0;
  const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; count += value.byteLength; if (count > MAX_BYTES) throw invalid(); buffered += decoder.decode(value, { stream: true }); let boundary;
      while ((boundary = buffered.indexOf('\n\n')) >= 0) { const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2); const data = frame.slice(6); if (data === '[DONE]') continue; const row = JSON.parse(data); id = row.id; created = row.created; const choice = row.choices[0]; final = choice.finish_reason ?? final; content += choice.delta.content ?? '';
        for (const call of choice.delta.tool_calls ?? []) { const current = calls.get(call.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }; current.id = call.id ?? current.id; current.function.name = call.function?.name ?? current.function.name; current.function.arguments += call.function?.arguments ?? ''; calls.set(call.index, current); }
      }
    }
    buffered += decoder.decode(); if (buffered || !final) throw invalid();
    return { id, object: 'chat.completion', created, model: alias, choices: [{ index: 0, message: { role: 'assistant', content: content || (calls.size ? null : ''), ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) }, finish_reason: final }] };
  } catch { await reader.cancel().catch(() => {}); throw invalid(); } finally { reader.releaseLock(); }
}
