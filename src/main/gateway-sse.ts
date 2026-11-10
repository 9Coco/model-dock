export type Json = Record<string, unknown>;
export function isObject(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

export class GatewayError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const FRAME_LIMIT = 16 * 1024 * 1024;
const RESPONSE_LIMIT = 32 * 1024 * 1024;

/** Keep fragments until one frame ends, scanning each decoded chunk only once. */
export class SseFrames {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private parts: string[] = [];
  private bytes = 0;
  private carriage = '';
  private lineEnding = '';
  private lineHasContent = false;
  private append(text: string): void {
    if (!text) return;
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > FRAME_LIMIT) throw new GatewayError(502, '上游 SSE 事件过大。');
    const last = this.parts.length - 1;
    // Coalesce tiny network fragments in bounded blocks, never the whole frame.
    if (last >= 0 && this.parts[last].length + text.length <= 4096) this.parts[last] += text;
    else this.parts.push(text);
  }
  private content(text: string): void {
    if (!text) return;
    this.append(this.lineEnding); this.lineEnding = '';
    this.append(text); this.lineHasContent = true;
  }
  private take(): string {
    const frame = this.parts.join('');
    this.parts = []; this.bytes = 0; this.lineEnding = ''; this.lineHasContent = false;
    return frame;
  }
  feed(chunk: Uint8Array, last = false): string[] {
    let text: string;
    try { text = this.carriage + this.decoder.decode(chunk, { stream: !last }); }
    catch { throw new GatewayError(502, '上游 SSE 包含无效 UTF-8。'); }
    this.carriage = '';
    if (!last && text.endsWith('\r')) { this.carriage = '\r'; text = text.slice(0, -1); }
    const frames: string[] = [], lines = /\r\n|\n|\r/g;
    let start = 0, match: RegExpExecArray | null;
    while ((match = lines.exec(text))) {
      this.content(text.slice(start, match.index));
      if (this.lineHasContent) { this.lineEnding = match[0]; this.lineHasContent = false; }
      else frames.push(this.take());
      start = match.index + match[0].length;
    }
    this.content(text.slice(start));
    if (last) { const frame = this.take(); if (frame.trim()) frames.push(frame); }
    return frames;
  }
}
function payload(frame: string): string {
  return frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
}
export function sseEventType(frame: string): string | undefined {
  return frame.split(/\r\n|\n|\r/).find(line => line.startsWith('event:'))?.slice(6).trim();
}
export function sseData(frame: string): unknown {
  const data = payload(frame);
  if (!data || data === '[DONE]') return undefined;
  try { return JSON.parse(data); } catch { throw new GatewayError(502, '上游 SSE 包含无效 JSON。'); }
}

export function assertSuccessEvent(value: Json, type = String(value.type ?? '')): void {
  const response = isObject(value.response) ? value.response : undefined;
  if (type === 'error' || type === 'response.failed' || type === 'response.incomplete'
    || value.error != null || response?.error != null
    || ['failed', 'incomplete', 'cancelled'].includes(String(value.status ?? ''))
    || ['failed', 'incomplete', 'cancelled'].includes(String(response?.status ?? ''))) {
    throw new GatewayError(502, '上游响应未完整完成。');
  }
}

/** Validate ordinary passthrough SSE, retaining only bounded terminal frames. */
export class SseCompletion {
  private completed = false;
  private finishing = false;
  private terminal: string[] = [];
  private terminalBytes = 0;
  private sentinel = false;
  private choices = new Set<number>();
  private finishedChoices = new Set<number>();
  constructor(private protocol: 'responses' | 'chat-completions') {}
  add(frame: string): string[] {
    const data = payload(frame);
    const event = sseEventType(frame);
    if (event === 'error' || event === 'response.failed' || event === 'response.incomplete') throw new GatewayError(502, '上游响应未完整完成。');
    if (!data) return []; // Heartbeats count as activity, never commit HTTP success.
    let liveChatDelta = false;
    if (data === '[DONE]') {
      if (this.sentinel) throw new GatewayError(502, '上游重复发送了终止事件。');
      if (this.protocol === 'chat-completions' && (!this.choices.size || this.choices.size !== this.finishedChoices.size)) throw new GatewayError(502, '上游 Chat 流尚有未完成的 choice。');
      this.sentinel = true;
      if (this.protocol === 'responses' && !this.completed) throw new GatewayError(502, '上游流缺少 response.completed。');
      this.completed = true;
      this.finishing = true;
    } else {
      const value = sseData(frame);
      if (!isObject(value)) throw new GatewayError(502, '上游 SSE 事件不是 JSON 对象。');
      const type = String(value.type ?? event ?? '');
      assertSuccessEvent(value, type);
      if (this.completed) throw new GatewayError(502, '上游终止事件之后仍有响应数据。');
      if (this.protocol === 'responses' && type === 'response.completed') {
        if (!isObject(value.response) || value.response.status !== undefined && value.response.status !== 'completed') throw new GatewayError(502, '上游完成事件缺少完整响应。');
        this.completed = true; this.finishing = true;
      } else if (this.protocol === 'chat-completions' && Array.isArray(value.choices)) {
        let terminal = false;
        for (const choice of value.choices) {
          if (!isObject(choice)) throw new GatewayError(502, '上游 Chat choice 无效。');
          const index = choice.index ?? 0;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 10000 || this.finishedChoices.has(index)) throw new GatewayError(502, '上游 Chat choice 序号或结束顺序无效。');
          this.choices.add(index);
          if (choice.finish_reason != null) {
            if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw new GatewayError(502, '上游 Chat 结束原因无效。');
            this.finishedChoices.add(index); terminal = true;
          }
        }
        if (terminal) this.finishing = true;
        else liveChatDelta = value.choices.length > 0;
      }
    }
    if (!this.finishing || liveChatDelta) return [frame];
    this.terminalBytes += Buffer.byteLength(frame) + 64;
    if (this.terminalBytes > RESPONSE_LIMIT) throw new GatewayError(502, '上游终止事件超过 32 MiB。');
    this.terminal.push(frame);
    return [];
  }
  finish(): string[] {
    if (!this.completed) throw new GatewayError(502, this.protocol === 'responses' ? '上游流已终止，但未收到 response.completed。' : '上游流已终止，但未收到 [DONE]。');
    return this.terminal;
  }
}

/** Aggregate only the Responses protocol, never invent a successful truncated reply. */
export class ResponsesCollector {
  private response: Json = {};
  private items = new Map<number, Json>();
  private completed = false;
  private bytes = 0;
  private reserve(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > RESPONSE_LIMIT) throw new GatewayError(502, '上游聚合响应超过 32 MiB。');
  }
  collectedItems(): ReadonlyMap<number, Json> { return this.items; }
  add(value: unknown): void {
    if (value === undefined) return;
    if (!isObject(value)) throw new GatewayError(502, '上游 SSE 事件不是 JSON 对象。');
    const type = String(value.type ?? '');
    assertSuccessEvent(value, type);
    if (this.completed) throw new GatewayError(502, '上游终止事件之后仍有响应数据。');
    // Count each incoming event once; avoid serializing a growing aggregate.
    // This conservative budget also covers replacement and final snapshots.
    this.reserve(Buffer.byteLength(JSON.stringify(value)) + 64);
    if (type === 'response.created' && isObject(value.response)) this.response = { ...value.response };
    const index = Number(value.output_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 10000) throw new GatewayError(502, '上游输出序号无效。');
    const partIndex = Number(value.content_index ?? 0);
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex > 10000) throw new GatewayError(502, '上游内容序号无效。');
    if ((type === 'response.output_item.added' || type === 'response.output_item.done') && isObject(value.item)) this.items.set(index, structuredClone(value.item));
    else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      if (isObject(value.part)) { const item = this.message(index, value.item_id); const content = item.content as unknown[]; this.reserve(Math.max(0, partIndex - content.length) * 5); content[partIndex] = structuredClone(value.part); }
    } else if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const item = this.message(index, value.item_id); const content = item.content as Json[];
      this.reserve(Math.max(0, partIndex - content.length) * 5);
      const part = isObject(content[partIndex]) ? content[partIndex] : { type: 'output_text', text: '', annotations: [] };
      part.text = type.endsWith('.done') ? String(value.text ?? '') : String(part.text ?? '') + String(value.delta ?? '');
      content[partIndex] = part;
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const item = this.items.get(index) ?? { id: value.item_id, type: 'function_call', arguments: '' };
      item.arguments = type.endsWith('.done') ? String(value.arguments ?? '') : String(item.arguments ?? '') + String(value.delta ?? '');
      this.items.set(index, item);
    } else if (type === 'response.custom_tool_call_input.delta' || type === 'response.custom_tool_call_input.done') {
      const item = this.items.get(index) ?? { id: value.item_id, type: 'custom_tool_call', input: '' };
      item.input = type.endsWith('.done') ? String(value.input ?? '') : String(item.input ?? '') + String(value.delta ?? '');
      this.items.set(index, item);
    } else if (type === 'response.completed') {
      if (!isObject(value.response) || value.response.status !== undefined && value.response.status !== 'completed') throw new GatewayError(502, '上游完成事件缺少完整响应。');
      this.response = { ...this.response, ...value.response };
      this.completed = true;
    }
  }
  private message(index: number, itemId: unknown): Json {
    const item = this.items.get(index) ?? { id: itemId, type: 'message', role: 'assistant', content: [] };
    if (!Array.isArray(item.content)) item.content = [];
    this.items.set(index, item);
    return item;
  }
  result(alias: string): Json {
    if (!this.completed) throw new GatewayError(502, '上游流已终止，但未收到 response.completed。');
    const output = Array.isArray(this.response.output) && this.response.output.length ? this.response.output : [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (!output.length) throw new GatewayError(502, '上游完成事件没有输出内容。');
    return { ...this.response, object: 'response', status: 'completed', model: alias, output };
  }
}
