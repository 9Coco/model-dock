import { describe, expect, it, vi } from 'vitest';
import { TraeApi } from '../src/main/trae-api';

const credential = { token: 'SYNTHETIC_TRAE_QUEUE_ACCESS', userId: 'fixture-user', host: 'https://api.trae.cn' as const };
const body = { model: 'fixture-model', messages: [{ role: 'user', content: 'Synthetic request' }] };
const frame = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;
function fixture(raw: string) {
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).includes('get_detail_param')
    ? Response.json({ config_info_list: [{ config_name: body.model, usage: 'chat_completion', model_name: 'fixture-native' }] })
    : new Response(raw, { headers: { 'content-type': 'text/event-stream' } }));
  return { api: new TraeApi({ fetch }), fetch };
}

describe('TRAE native queue progress', () => {
  it.each(['Waiting for a slot', '"Waiting for a slot"', '{"status":"queued"}'])('accepts an informational queue notice before real output: %s', async notice => {
    const f = fixture(frame('progress_notice', notice) + frame('output', '{"response":"OK","reasoning_content":null,"tool_calls":null}') + frame('done', '{}'));
    const response = await f.api.chat(credential, body);
    expect((await response.json()).choices[0].message.content).toBe('OK');
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([frame('progress_notice', 'Waiting'), frame('progress_notice', 'Waiting') + frame('done', '{}')])('never counts queue notices as a successful answer', async raw => {
    await expect(fixture(raw).api.chat(credential, body)).rejects.toMatchObject({ code: 'response' });
  });
  it('retains upstream error handling for structured progress errors', async () => {
    const f = fixture(frame('progress_notice', '{"code":4023}') + frame('output', '{"response":"OK"}') + frame('done', '{}'));
    await expect(f.api.chat(credential, body)).rejects.toMatchObject({ code: 'upstream' });
  });
  it('still rejects non-JSON output frames and cannot mistake their done event for success', async () => {
    await expect(fixture(frame('output', 'invalid') + frame('done', '{}')).api.chat(credential, body)).rejects.toMatchObject({ code: 'response' });
  });
});
