import { describe, expect, it } from 'vitest';
import { createJetBrainsChatStream, JetBrainsChatError, normalizeJetBrainsChatResponse, jetBrainsResponsesHistory } from '../src/main/jetbrains-chat-stream';

const event = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: unknown, finish_reason: unknown = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
async function convert(raw: string, size = 512) {
  const bytes = new TextEncoder().encode(raw);
  const source = new ReadableStream<Uint8Array>({ start(controller) { for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size)); controller.close(); } });
  return new Response(source.pipeThrough(createJetBrainsChatStream('local-model'))).text();
}
const valid = () => event(chunk({ role: 'assistant', content: '' })) + event(chunk({ content: '你🙂' })) + event(chunk({}, 'stop')) + event('[DONE]');
const parse = (raw: string) => raw.split('\n\n').filter(Boolean).map(item => { const data = item.slice(6); return data === '[DONE]' ? data : JSON.parse(data); });

describe('JetBrains 严格 Chat 流接口', () => {
  it('Responses 次轮保留回答与工具，仅省略显示字段；不改变原对象或用户内容', () => {
    const body = { messages: [{ role: 'assistant', content: 'Answer', reasoning_content: 'Displayed thought', tool_calls: [{ id: 'call_mock', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'user', content: 'Follow up', reasoning_content: 'User field' }] };
    expect(jetBrainsResponsesHistory(body)).toEqual({ messages: [{ role: 'assistant', content: 'Answer', tool_calls: body.messages[0].tool_calls }, body.messages[1]] });
    expect(body.messages[0].reasoning_content).toBe('Displayed thought');
  });
  it('UTF-8/逐字节数据与显式心跳保留真实增量，并给每个成功块完整信封', async () => {
    const events = parse(await convert(': heartbeat\r\n\r\n' + event({ type: 'ping' }) + valid(), 1));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1);
    expect(chunks.map(item => item.choices[0].delta.content ?? '').join('')).toBe('你🙂');
    expect(new Set(chunks.map(item => item.id)).size).toBe(1);
    for (const item of chunks) expect(item).toMatchObject({ id: expect.any(String), created: expect.any(Number), object: 'chat.completion.chunk', model: 'local-model', choices: expect.any(Array) });
  });

  it('合法 sparse 工具参数增量保持原样，usage 空 choices 保持完整信封', async () => {
    const call = { index: 0, id: 'call_mock', type: 'function', function: { name: 'read_file', arguments: '{"path":' } };
    const delta = { index: 0, function: { arguments: '"a.ts"}' } };
    const events = parse(await convert(event(chunk({ tool_calls: [call] })) + event(chunk({ tool_calls: [delta] })) + event(chunk({}, 'tool_calls'))
      + event({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + event('[DONE]')));
    expect(events[0].choices[0].delta.tool_calls).toEqual([call]);
    expect(events[1].choices[0].delta.tool_calls).toEqual([delta]);
    expect(events.at(-2)).toMatchObject({ choices: [], usage: { total_tokens: 7 }, model: 'local-model', object: 'chat.completion.chunk' });
  });

  it.each([
    event({ error: { message: 'PRIVATE_KEY PRIVATE_REQUEST' } }),
    event({ type: 'error', error: { message: 'PRIVATE_KEY' } }),
    event({ type: 'response.output_text.delta', delta: 'PRIVATE_REQUEST' }),
    event({}), event({ choices: null }), event('[DONE]'),
    event({ choices: [{ index: 0, delta: null }] }),
    event({ id: null, ...chunk({ content: 'x' }) }),
    valid().replace(event('[DONE]'), ''),
    event(chunk({ content: 'partial' })) + event('[DONE]'),
    valid() + event({ type: 'error', error: { message: 'PRIVATE_KEY' } }),
  ])('拒绝失败或不完整流，并只给受控错误：%s', async raw => {
    await expect(convert(raw)).rejects.toThrow(JetBrainsChatError);
    try { await convert(raw); } catch (error) { expect(String(error)).not.toMatch(/PRIVATE_KEY|PRIVATE_REQUEST/); }
  });

  it('普通 HTTP JSON 完成对象保留内容，补 metadata；JSON 内错误不伪造成功', () => {
    const value = normalizeJetBrainsChatResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic reply.' }, finish_reason: 'stop' }] }, 'friendly');
    expect(value).toMatchObject({ object: 'chat.completion', id: expect.any(String), created: expect.any(Number), model: 'friendly', choices: [{ message: { content: 'Synthetic reply.' } }] });
    expect(() => normalizeJetBrainsChatResponse({ error: { message: 'PRIVATE_REQUEST' } }, 'friendly')).toThrow(JetBrainsChatError);
    expect(() => normalizeJetBrainsChatResponse({ choices: [] }, 'friendly')).toThrow(JetBrainsChatError);
  });
});
