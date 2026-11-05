import { GatewayError, SseFrames, isObject, sseData } from './gateway-sse';

const fail = (): never => { throw new GatewayError(502, 'Central Responses 事件流失败、终态不一致或未完整结束。'); };
/** Validate native Responses without converting items, rebuilding tool calls,
 * dropping reasoning, or inventing completed output. Deltas retain their native
 * event envelopes and flow immediately; only the small terminal tail is held. */
export function createCentralResponsesStream(): TransformStream<Uint8Array, Uint8Array> {
  const frames = new SseFrames(), decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let responseId = '', terminal: string | undefined, sentinel = false, terminalBytes = 0;
  const tail: Uint8Array[] = [];
  const frame = (source: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const encoded = encoder.encode(source + '\n\n'), event = source.split(/\r\n|\n|\r/).find(line => line.startsWith('event:'))?.slice(6).trim();
    const hasData = /^data:/m.test(source);
    const done = /^data: ?\[DONE\]\s*$/m.test(source);
    if (done) { if (!terminal || sentinel) return fail(); sentinel = true; tail.push(encoded); return; }
    const value = sseData(source);
    if (value === undefined) { if (hasData) return fail(); controller.enqueue(encoded); return; }
    if (!isObject(value) || value.error != null || value.type === 'error' || event === 'error' || sentinel) return fail();
    if (event === 'ping' && (value.type === 'ping' || !Object.keys(value).length)) { controller.enqueue(encoded); return; }
    const type = value.type;
    if (typeof type !== 'string' || !/^response\.[a-z0-9_.]+$/.test(type) || event && event !== type) return fail();
    if (terminal) return fail();
    if (isObject(value.response)) {
      const id = value.response.id;
      if (typeof id !== 'string' || !id || responseId && responseId !== id) return fail();
      responseId = id;
    }
    if (value.response_id !== undefined && (typeof value.response_id !== 'string' || !value.response_id || responseId && responseId !== value.response_id)) return fail();
    if (typeof value.response_id === 'string' && !responseId) responseId = value.response_id;
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      const status = type.slice(9), response = value.response;
      if (!isObject(response) || response.status !== status || status === 'completed' && (response.error != null || response.incomplete_details != null)) return fail();
      terminal = type; terminalBytes += encoded.length; if (terminalBytes > 4 * 1024 * 1024) return fail(); tail.push(encoded); return;
    }
    controller.enqueue(encoded);
  };
  return new TransformStream({
    transform(chunk, controller) { try { decoder.decode(chunk, { stream: true }); } catch { return fail(); } for (const item of frames.feed(chunk)) frame(item, controller); },
    flush(controller) {
      try { decoder.decode(); } catch { return fail(); }
      for (const item of frames.feed(new Uint8Array(), true)) frame(item, controller);
      if (!terminal) return fail();
      for (const item of tail) controller.enqueue(item);
    },
  });
}
