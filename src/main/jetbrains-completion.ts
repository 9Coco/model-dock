type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const index = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const finishReasons = new Set(['stop', 'length', 'content_filter']);

export class JetBrainsCompletionError extends Error {
  constructor(readonly status: 400 | 502, message = 'AI 补全响应失败、协议不匹配或未完整完成。') { super(message); this.name = 'JetBrainsCompletionError'; }
}
const fail = (): never => { throw new JetBrainsCompletionError(502); };
const invalid = (): never => { throw new JetBrainsCompletionError(400, 'AI 补全请求需要原生 FIM 的 prompt / suffix；此入口不将聊天模型转换为补全模型。'); };

/** 修改点：保留 IDE Generic FIM 的原始前后文，不把源码伪装为聊天或执行工具。 */
export function parseJetBrainsCompletionRequest(body: Json, model: string, maxOutputTokens = 4096): Json {
  const fields = new Set(['model', 'prompt', 'suffix', 'stream', 'stream_options', 'max_tokens', 'temperature', 'top_p', 'stop', 'echo', 'logprobs', 'n']);
  if (Object.keys(body).some(key => !fields.has(key)) || body.model !== undefined && typeof body.model !== 'string' || typeof body.prompt !== 'string'
    || body.suffix != null && typeof body.suffix !== 'string' || body.stream !== undefined && typeof body.stream !== 'boolean'
    || body.n !== undefined && body.n !== 1 || body.echo !== undefined && body.echo !== false) return invalid();
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1 || Number(body.max_tokens) > maxOutputTokens)) return invalid();
  for (const [key, upper] of [['temperature', 2], ['top_p', 1]] as const) {
    if (body[key] != null && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || Number(body[key]) < 0 || Number(body[key]) > upper || key === 'top_p' && body[key] === 0)) return invalid();
  }
  if (body.logprobs != null && (!Number.isSafeInteger(body.logprobs) || Number(body.logprobs) < 0 || Number(body.logprobs) > 20)) return invalid();
  if (body.stop != null && typeof body.stop !== 'string' && (!Array.isArray(body.stop) || body.stop.length > 16 || body.stop.some(item => typeof item !== 'string'))) return invalid();
  if (body.stream_options !== undefined && (body.stream !== true || !object(body.stream_options)
    || Object.keys(body.stream_options).some(key => key !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) return invalid();
  const result: Json = { ...body, model };
  delete result.n;
  delete result.echo;
  return result;
}

/** 原生 text_completion 信封完整校验；错误、Chat 回复与中断不能当成代码补全成功。 */
export function normalizeJetBrainsCompletionResponse(value: unknown, model: string): Json {
  if (!object(value) || value.error != null || value.type === 'error' || value.object !== 'text_completion'
    || typeof value.id !== 'string' || !value.id || !index(value.created) || typeof value.model !== 'string' || !value.model
    || !Array.isArray(value.choices) || !value.choices.length) return fail();
  const seen = new Set<number>();
  for (const choice of value.choices) {
    if (!object(choice) || !index(choice.index) || seen.has(choice.index) || typeof choice.text !== 'string' || !finishReasons.has(String(choice.finish_reason))) return fail();
    seen.add(choice.index);
  }
  return { ...value, model };
}

export function jetBrainsCompletionToSse(value: Json): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`);
}

/** 修改点：先校验真正的结束信号，且保持 FIM 文本、logprobs 和 usage 原样。 */
export function createJetBrainsCompletionStream(model: string, observe: (value: unknown) => void = () => {}): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let pending = '', done = false, id = '', created: number | undefined;
  const choices = new Set<number>(), finished = new Set<number>();
  const frame = (raw: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = raw.split(/\r\n|\n|\r/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (done) return fail();
    if (data === '[DONE]') { if (!choices.size || [...choices].some(choice => !finished.has(choice))) return fail(); done = true; return; }
    let value: unknown; try { value = JSON.parse(data); } catch { return fail(); }
    observe(value);
    if (!object(value) || value.error != null || value.type === 'error') return fail();
    if (value.type === 'ping' || lines.includes('event: ping') && !Object.keys(value).length) return;
    if (value.object !== 'text_completion' || typeof value.id !== 'string' || !value.id || !index(value.created)
      || typeof value.model !== 'string' || !value.model || !Array.isArray(value.choices) || !value.choices.length) return fail();
    if (id && value.id !== id || created !== undefined && value.created !== created) return fail();
    id = value.id; created = value.created;
    const seen = new Set<number>();
    for (const choice of value.choices) {
      if (!object(choice) || !index(choice.index) || seen.has(choice.index) || finished.has(choice.index) || typeof choice.text !== 'string') return fail();
      seen.add(choice.index); choices.add(choice.index);
      if (choice.finish_reason != null) { if (!finishReasons.has(String(choice.finish_reason))) return fail(); finished.add(choice.index); }
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...value, model })}\n\n`));
  };
  const feed = (chunk: Uint8Array, last: boolean, controller: TransformStreamDefaultController<Uint8Array>) => {
    try { pending += decoder.decode(chunk, { stream: !last }); } catch { return fail(); }
    if (pending.length > 16 * 1024 * 1024) return fail();
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) { frame(pending.slice(0, boundary.index), controller); pending = pending.slice(boundary.index + boundary[0].length); }
    if (last && pending.trim()) { frame(pending, controller); pending = ''; }
  };
  return new TransformStream({
    transform(chunk, controller) { feed(chunk, false, controller); },
    flush(controller) { feed(new Uint8Array(), true, controller); if (!done) return fail(); controller.enqueue(encoder.encode('data: [DONE]\n\n')); },
  });
}
