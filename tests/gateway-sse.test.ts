import { describe, expect, it } from 'vitest';
import { ResponsesCollector, SseFrames, SseCompletion, sseData } from '../src/main/gateway-sse';

const encode = (text: string) => new TextEncoder().encode(text);

describe('bounded incremental gateway SSE', () => {
  it('limits individual frames after splitting a network chunk larger than 16 MiB', () => {
    const value = { delta: 'x'.repeat(4096) };
    const frame = 'data: ' + JSON.stringify(value);
    const frames = new SseFrames().feed(encode((frame + '\n\n').repeat(4097)), true);
    expect(frames).toHaveLength(4097);
    expect(sseData(frames.at(-1)!)).toEqual(value);
  });

  it('rejects one oversized event even when it arrives in small network fragments', () => {
    const frames = new SseFrames(), chunk = encode('x'.repeat(1024 * 1024));
    frames.feed(encode('data: '));
    for (let i = 0; i < 15; i++) frames.feed(chunk);
    expect(() => frames.feed(chunk)).toThrow('事件过大');
  });

  it('keeps Unicode and mixed SSE line endings intact across single-byte chunks', () => {
    const source = 'event: item\r\ndata: {"text":"你好 🐋"}\r\n\r\ndata: {"next":true}\n\rdata: {"last":1}\r\r';
    const decoder = new SseFrames();
    const frames = [...encode(source)].flatMap(byte => decoder.feed(new Uint8Array([byte])));
    frames.push(...decoder.feed(new Uint8Array(), true));
    expect(frames.map(sseData)).toEqual([{ text: '你好 🐋' }, { next: true }, { last: 1 }]);
    expect(() => new SseFrames().feed(new Uint8Array([0xff]), true)).toThrow('UTF-8');
  });

  it('requires every Chat choice to finish before DONE and still forwards other choices immediately', () => {
    const stream = new SseCompletion('chat-completions');
    const delta = (index: number) => 'data: ' + JSON.stringify({ choices: [{ index, delta: { content: 'live' } }] });
    const finish = (index: number) => 'data: ' + JSON.stringify({ choices: [{ index, delta: {}, finish_reason: 'stop' }] });
    expect(stream.add(delta(0))).toEqual([delta(0)]);
    expect(stream.add(finish(0))).toEqual([]);
    expect(stream.add(delta(1))).toEqual([delta(1)]);
    expect(() => stream.add('data: [DONE]')).toThrow('未完成');
    stream.add(finish(1)); stream.add('data: [DONE]');
    expect(stream.finish()).toEqual([finish(0), finish(1), 'data: [DONE]']);
  });

  it('bounds cumulative Responses text, argument, and item snapshots before retaining 32 MiB', () => {
    for (const type of ['response.output_text.delta', 'response.function_call_arguments.delta', 'response.output_item.added']) {
      const collector = new ResponsesCollector();
      const payload = 'x'.repeat(1024 * 1024);
      const event = (index: number) => type.endsWith('added')
        ? { type, output_index: index, item: { type: 'function_call', arguments: payload } }
        : { type, output_index: index, delta: payload };
      for (let i = 0; i < 31; i++) collector.add(event(i));
      expect(() => collector.add(event(31))).toThrow('32 MiB');
    }
  });

  it('accounts for sparse content slots rather than allowing tiny events to expand without a bound', () => {
    const collector = new ResponsesCollector();
    expect(() => {
      for (let output_index = 0; output_index < 1000; output_index++) collector.add({ type: 'response.output_text.delta', output_index, content_index: 10000, delta: 'x' });
    }).toThrow('32 MiB');
  });
});
