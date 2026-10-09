import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;
export class JetBrainsChatError extends Error {
  readonly status = 502;
  constructor(message = '上游 Chat 响应失败、协议不匹配或未完整完成。') { super(message); this.name = 'JetBrainsChatError'; }
}
const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIndex = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const fail = (): never => { throw new JetBrainsChatError(); };
const finishReasons = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

/** 修改点：Koog 会回传显示用思考文字；Responses 历史只复用回答/工具，不能伪造原生推理项。 */
export function jetBrainsResponsesHistory(body: Json): Json {
  if (!Array.isArray(body.messages)) return body;
  return { ...body, messages: body.messages.map(message => {
    if (!object(message) || message.role !== 'assistant' || typeof message.reasoning_content !== 'string') return message;
    const copy = { ...message }; delete copy.reasoning_content; return copy;
  }) };
}

/** 修改点：仅 JetBrains 的成功 Chat 对象可转换为流；HTTP 200 内的错误不能伪装成功。 */
export function normalizeJetBrainsChatResponse(value: unknown, model: string): Json {
  if (!object(value) || value.error != null || value.type === 'error' || value.object !== undefined && value.object !== 'chat.completion'
    || !Array.isArray(value.choices) || !value.choices.length) return fail();
  for (const choice of value.choices) {
    if (!object(choice) || !validIndex(choice.index) || !object(choice.message) || choice.message.role !== 'assistant'
      || !finishReasons.has(String(choice.finish_reason))) return fail();
  }
  if (value.id !== undefined && (typeof value.id !== 'string' || !value.id)
    || value.created !== undefined && !validIndex(value.created)) return fail();
  return { ...value, id: value.id ?? `chatcmpl-${randomUUID()}`, created: value.created ?? Math.floor(Date.now() / 1000), object: 'chat.completion', model };
}

/**
 * 修改点：Rider 的 Koog 将每个 data JSON 当作 Chat chunk 解码，即使 event 是 error。
 * 这里校验完整信封、忽略显式心跳，并把失败作为传输错误抛出；不发虚假 stop/[DONE]。
 * 正常工具增量保持原样，不重复工具名称、ID 或参数。
 */
export function createJetBrainsChatStream(model: string, observe: (value: unknown) => void = () => {}): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let pending = '', id = '', created = 0, done = false, seenChoice = false;
  const choices = new Set<number>(), finished = new Set<number>();
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, value: Json | '[DONE]') => {
    controller.enqueue(encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`));
  };
  const frame = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = text.split(/\r\n|\n|\r/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return; // comment-only 心跳不交给 Koog JSON 解码器。
    if (done) return fail();
    if (data === '[DONE]') {
      if (!seenChoice || [...choices].some(index => !finished.has(index))) return fail();
      done = true; return; // 等上游真正结束后再发布成功哨兵，避免掩盖迟到错误。
    }
    let value: unknown;
    try { value = JSON.parse(data); } catch { return fail(); }
    observe(value);
    if (!object(value) || value.error != null || value.type === 'error') return fail();
    if (value.type === 'ping' || lines.includes('event: ping') && !Object.keys(value).length) return;
    if (!Array.isArray(value.choices) || value.object !== undefined && value.object !== 'chat.completion.chunk') return fail();
    if (value.id !== undefined && (typeof value.id !== 'string' || !value.id)
      || value.created !== undefined && !validIndex(value.created)) return fail();
    if (!id) { id = typeof value.id === 'string' ? value.id : `chatcmpl-${randomUUID()}`; created = typeof value.created === 'number' ? value.created : Math.floor(Date.now() / 1000); }
    if (!value.choices.length && (!seenChoice || !object(value.usage))) return fail();
    for (const choice of value.choices) {
      if (!object(choice) || !validIndex(choice.index) || !object(choice.delta) || finished.has(choice.index)) return fail();
      choices.add(choice.index); seenChoice = true;
      if (choice.finish_reason != null) {
        if (!finishReasons.has(String(choice.finish_reason))) return fail();
        finished.add(choice.index);
      }
    }
    emit(controller, { ...value, id, created, object: 'chat.completion.chunk', model });
  };
  const feed = (chunk: Uint8Array, last: boolean, controller: TransformStreamDefaultController<Uint8Array>) => {
    try { pending += decoder.decode(chunk, { stream: !last }); } catch { return fail(); }
    if (pending.length > 16 * 1024 * 1024) return fail();
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      frame(pending.slice(0, boundary.index), controller); pending = pending.slice(boundary.index + boundary[0].length);
    }
    if (last && pending.trim()) { frame(pending, controller); pending = ''; }
  };
  return new TransformStream({
    transform(chunk, controller) { feed(chunk, false, controller); },
    flush(controller) { feed(new Uint8Array(), true, controller); if (!done) return fail(); emit(controller, '[DONE]'); },
  });
}
