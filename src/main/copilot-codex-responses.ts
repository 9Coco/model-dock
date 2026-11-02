import { GatewayError, ResponsesCollector, SseFrames, isObject, sseData, type Json } from './gateway-sse';

function identities(item: Json): string[] {
  const keys: string[] = [];
  if (typeof item.id === 'string' && item.id) keys.push(`id:${item.id}`);
  if (typeof item.call_id === 'string' && item.call_id) keys.push(`${item.type}:${item.call_id}`);
  return keys;
}

function usable(item: Json): boolean {
  if (item.type === 'message' && Array.isArray(item.content)) return item.content.some(part => isObject(part)
    && ((part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0)
      || (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0)));
  return (item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.call_id === 'string'
    && item.call_id.length > 0 && typeof item.name === 'string' && item.name.length > 0;
}

function fillSparseItem(snapshot: Json, item: Json): void {
  if (snapshot.type !== item.type) throw new GatewayError(502, 'Codex 完成事件中的输出项类型与事件流不一致。');
  for (const key of Object.keys(item)) if (snapshot[key] == null) snapshot[key] = item[key];
  if (item.type === 'message' && !usable(snapshot) && usable(item)) snapshot.content = item.content;
  const field = item.type === 'function_call' ? 'arguments' : item.type === 'custom_tool_call' ? 'input' : undefined;
  if (field && snapshot[field] === '' && typeof item[field] === 'string') snapshot[field] = item[field];
}

// Copilot builds its next turn from completed.response.output. Codex can omit
// some or all of that array even after sending authoritative output_item.done events.
function complete(event: Json, done: ReadonlyMap<number, Json>): Json {
  const response = event.response;
  if (!isObject(response) || response.status != null && response.status !== 'completed'
    || response.output != null && (!Array.isArray(response.output) || !response.output.every(isObject))) {
    throw new GatewayError(502, 'Codex 的完成事件包含无效的响应。');
  }
  const snapshot: Json[] = Array.isArray(response.output) ? response.output : [];
  const original = snapshot.map(item => ({ ...item }));
  const present = new Map<string, Json>();
  for (const item of original) for (const key of identities(item)) present.set(key, item);
  const output = original.slice();
  for (const [index, item] of [...done].sort(([a], [b]) => a - b)) {
    const keys = identities(item);
    const existing = keys.map(key => present.get(key)).find(Boolean)
      ?? (!keys.length && original[index]?.type === item.type ? original[index] : undefined);
    if (existing) fillSparseItem(existing, item);
    else output.splice(Math.min(index, output.length), 0, item);
    for (const key of keys) present.set(key, existing ?? item);
  }
  if (!output.some(usable)) throw new GatewayError(502, 'Codex 已结束响应，但没有返回可供 Copilot 使用的正文、拒绝说明或工具调用。');
  return { ...event, response: { ...response, output } };
}

export function copilotCodexJson(response: unknown): Json {
  if (!isObject(response)) throw new GatewayError(502, 'Codex 返回了无效的 Responses 对象。');
  if (response.status === 'failed' || response.status === 'incomplete') return { type: `response.${response.status}`, response };
  return complete({ type: 'response.completed', response }, new Map());
}

/** Keep streaming live. Only finalize missing items when the upstream itself completes. */
export async function* copilotCodexEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Json> {
  const frames = new SseFrames();
  const collector = new ResponsesCollector();
  const finalized = new Set<number>();
  const truncated = 'Codex 事件流已结束，但未收到完整的 Responses 终态事件。';
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    for (const frame of frames.feed(chunk.value ?? new Uint8Array(), chunk.done)) {
      const data = sseData(frame);
      if (data === undefined) {
        if (/^data: ?\[DONE\]\s*$/m.test(frame)) throw new GatewayError(502, truncated);
        continue;
      }
      if (!isObject(data) || typeof data.type !== 'string' || !/^[\w.]+$/.test(data.type)) throw new GatewayError(502, 'Codex 返回了无效的 Responses 事件。');
      if (data.type === 'response.metadata') continue;
      if (data.type === 'response.completed') {
        // Recover visible text from delta-only replies. Tool calls may have side
        // effects, so only restore them from a finalized output item.
        const recoverable = new Map([...collector.collectedItems()].filter(([index, item]) => finalized.has(index) || item.type === 'message'));
        yield complete(data, recoverable);
        return;
      }
      if (['response.failed', 'response.incomplete', 'error'].includes(data.type)) { yield data; return; }
      if (typeof data.delta === 'string') bytes += Buffer.byteLength(data.delta);
      else if (data.item || data.part || data.text || data.arguments || data.input) bytes += Buffer.byteLength(frame);
      if (bytes > 32 * 1024 * 1024) throw new GatewayError(502, 'Codex 响应超过了 32 MiB 的收集上限。');
      if (data.type === 'response.output_item.done') {
        const index = data.output_index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 10000 || !isObject(data.item)) {
          throw new GatewayError(502, 'Codex 返回了无效的已完成输出项。');
        }
        finalized.add(index);
      }
      collector.add(data);
      yield data;
    }
    if (chunk.done) throw new GatewayError(502, truncated);
  }
}
