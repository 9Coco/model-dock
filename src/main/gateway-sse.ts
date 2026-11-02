export type Json = Record<string, unknown>;
export function isObject(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

export class GatewayError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Incremental SSE framing; JSON and UTF-8 code points may cross network chunks. */
export class SseFrames {
  private decoder = new TextDecoder();
  private pending = '';
  feed(chunk: Uint8Array, last = false): string[] {
    this.pending += this.decoder.decode(chunk, { stream: !last });
    if (this.pending.length > 16 * 1024 * 1024) throw new GatewayError(502, '上游 SSE 事件过大。');
    const frames: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(this.pending))) { frames.push(this.pending.slice(0, match.index)); this.pending = this.pending.slice(match.index + match[0].length); }
    if (last && this.pending.trim()) { frames.push(this.pending); this.pending = ''; }
    return frames;
  }
}
export function sseData(frame: string): unknown {
  const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data || data === '[DONE]') return undefined;
  try { return JSON.parse(data); } catch { throw new GatewayError(502, '上游 SSE 包含无效 JSON。'); }
}

/** Aggregate only the Responses protocol, never invent a successful truncated reply. */
export class ResponsesCollector {
  private response: Json = {};
  private items = new Map<number, Json>();
  private completed = false;
  collectedItems(): ReadonlyMap<number, Json> { return this.items; }
  add(value: unknown): void {
    if (!isObject(value)) return;
    const type = String(value.type ?? '');
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') throw new GatewayError(502, '上游响应未完整完成。');
    if (type === 'response.created' && isObject(value.response)) this.response = { ...value.response };
    const index = Number(value.output_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 10000) throw new GatewayError(502, '上游输出序号无效。');
    const partIndex = Number(value.content_index ?? 0);
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex > 10000) throw new GatewayError(502, '上游内容序号无效。');
    if ((type === 'response.output_item.added' || type === 'response.output_item.done') && isObject(value.item)) this.items.set(index, structuredClone(value.item));
    else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      if (isObject(value.part)) { const item = this.message(index, value.item_id); const content = item.content as unknown[]; content[partIndex] = structuredClone(value.part); }
    } else if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const item = this.message(index, value.item_id); const content = item.content as Json[];
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
      if (!isObject(value.response)) throw new GatewayError(502, '上游完成事件缺少完整响应。');
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
