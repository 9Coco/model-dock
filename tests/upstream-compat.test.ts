import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeUpstreamReasoning } from '../src/main/upstream-compat';
import { prepareUpstream } from '../src/main/oauth';
import { Gateway } from '../src/main/gateway';
import { Store } from '../src/main/store';
import { isJetBrainsTool } from '../src/shared/jetbrains';
import type { Provider, ToolId } from '../src/shared/types';

const grok = { kind: 'grok', baseUrl: 'https://cli-chat-proxy.grok.com/v1' } as Provider;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function bodyOf(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()); }

describe('verified upstream effort compatibility', () => {
  it('maps maximum effort only on verified Grok targets without changing caller data or other parameters', () => {
    const body = { model: 'grok-4.7', reasoning: { effort: 'max', summary: 'auto' }, max_output_tokens: 64, input: 'Keep literal max unchanged.' };
    expect(prepareUpstream(grok, { accessToken: 'SYNTHETIC_OAUTH' }, '/responses', body).body).toMatchObject({ ...body, reasoning: { effort: 'xhigh', summary: 'auto' } });
    expect(body.reasoning.effort).toBe('max');
    const api = { ...grok, kind: 'openai-compatible' as const, baseUrl: 'https://api.x.ai/v1' };
    expect(prepareUpstream(api, { apiKey: 'SYNTHETIC_API_KEY' }, '/responses', body).body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    expect(normalizeUpstreamReasoning(api, '/v1/chat/completions', { model: 'grok-4.7', reasoning_effort: 'max', max_tokens: 64 })).toEqual({ model: 'grok-4.7', reasoning_effort: 'xhigh', max_tokens: 64 });
    for (const model of ['grok-4.7-latest', 'grok-4.7-build', 'grok-4.7-build-fast']) expect(normalizeUpstreamReasoning(grok, '/responses', { ...body, model }).reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    for (const effort of ['low', 'medium', 'high', 'xhigh', undefined]) {
      const native = { ...body, reasoning: { effort, summary: 'auto' } };
      expect(normalizeUpstreamReasoning(grok, '/responses', native)).toBe(native);
    }
    const unknown = { ...body, model: 'grok-unverified' };
    expect(normalizeUpstreamReasoning(grok, '/responses', unknown)).toBe(unknown);
    for (const baseUrl of ['https://proxy.example/v1', 'https://api.deepseek.com', 'https://api.x.ai/other', 'https://api.x.ai/v1?private=marker']) {
      expect(normalizeUpstreamReasoning({ kind: 'openai-compatible', baseUrl }, '/responses', body)).toBe(body);
    }
    expect(normalizeUpstreamReasoning(api, '/responses', { ...body, model: 'deepseek-flash' }).reasoning).toEqual(body.reasoning);
    expect(normalizeUpstreamReasoning({ ...api, kind: 'copilot' }, '/responses', body)).toBe(body);
    expect(normalizeUpstreamReasoning(api, '/v1/messages', body)).toBe(body);
  });

  it('normalizes Claude, all JetBrains bridges and native tool routes before a rejecting upstream sees the request', async () => {
    const seen: string[] = [];
    const upstream = createServer(async (request, response) => {
      const body = await bodyOf(request);
      if (body.reasoning?.effort !== 'xhigh') { response.writeHead(400); response.end('{}'); return; }
      seen.push(body.model);
      response.setHeader('content-type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: body.model, output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 2, output_tokens: 1 } } })}\n\n`);
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); });
    const dir = mkdtempSync(join(tmpdir(), 'modeldock-effort-')), store = await Store.create(dir);
    cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const provider = store.saveProvider({ name: 'Synthetic Grok', kind: 'grok', baseUrl: grok.baseUrl, enabled: true });
    store.setSecret(provider.id, { accessToken: 'SYNTHETIC_OAUTH' });
    const model = store.saveModel({ providerId: provider.id, upstreamId: 'grok-4.7', alias: 'fixture-grok', displayName: 'Fixture', wireApi: 'responses', contextWindow: 0, tools: true, vision: true, enabled: true });
    const tools: ToolId[] = ['claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm', 'codex', 'opencode', 'dsh', 'vscode', 'copilot'];
    for (const tool of tools) store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
    const address = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const gateway = new Gateway(store, { prepareRequest: async (p, secret, path, body) => {
      // Exercise the common gateway boundary even with an alternate transport.
      expect(body.reasoning).toEqual({ effort: 'xhigh' });
      const prepared = prepareUpstream(p, secret, path, body);
      return { ...prepared, url: address + path };
    } });
    await gateway.start(0); cleanups.push(() => gateway.stop().then(() => undefined));
    const root = gateway.status().baseUrl.replace(/\/v1$/, '');
    for (const tool of tools) {
      const claude = tool === 'claude-code', chat = isJetBrainsTool(tool);
      const body = claude ? { model: model.alias, max_tokens: 64, output_config: { effort: 'max' }, messages: [{ role: 'user', content: 'Reply OK.' }] }
        : chat ? { model: model.alias, max_tokens: 64, reasoning_effort: 'max', messages: [{ role: 'user', content: 'Reply OK.' }] }
        : { model: model.alias, max_output_tokens: 64, reasoning: { effort: 'max' }, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }] };
      const route = claude ? 'messages' : chat ? 'chat/completions' : 'responses';
      const response = await fetch(`${root}/tool/${tool}/v1/${route}`, { method: 'POST', headers: { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status, tool).toBe(200);
      expect(await response.text(), tool).toContain('OK');
    }
    expect(seen).toHaveLength(tools.length);
  });
});
