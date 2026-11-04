import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { buildConfig } from '../src/main/adapters';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });

async function fixture() {
  const calls: string[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(body.model);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'synthetic-response', model: body.model, choices: [], output: [] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); });
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-exposure-'));
  const store = await Store.create(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = store.saveProvider({ name: 'Fixture first', kind: 'openai-compatible', baseUrl: upstreamUrl, enabled: true, apiKey: 'synthetic-first' });
  const second = store.saveProvider({ name: 'Fixture second', kind: 'openai-compatible', baseUrl: upstreamUrl, enabled: true, apiKey: 'synthetic-second' });
  const chat = store.saveModel({ providerId: first.id, upstreamId: 'first-native', alias: 'first-chat', displayName: 'First chat', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const responses = store.saveModel({ ...chat, id: undefined, upstreamId: 'first-responses-native', alias: 'first-responses', wireApi: 'responses' });
  const other = store.saveModel({ ...chat, id: undefined, providerId: second.id, upstreamId: 'second-native', alias: 'second-chat' });
  const gateway = new Gateway(store); await gateway.start(0);
  cleanups.push(async () => { await gateway.stop(); });
  const url = gateway.status().baseUrl;
  const headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const catalog = async (base = url) => (await (await fetch(`${base}/models`, { headers })).json()).data.map((item: { id: string }) => item.id);
  const post = (model: string, endpoint = 'chat/completions', base = url) => fetch(`${base}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [], input: 'synthetic' }) });
  return { store, gateway, dir, first, second, chat, responses, other, calls, url, catalog, post };
}

describe('general local gateway exposure', () => {
  it('retains the existing catalog by default and blocks excluded providers and models before forwarding', async () => {
    const f = await fixture();
    expect(f.store.gatewayExposure()).toEqual({ excludedProviderIds: [], excludedModelIds: [] });
    expect(await f.catalog()).toEqual([f.chat.alias, f.responses.alias, f.other.alias]);
    const before = { providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings() };
    f.store.setGatewayProviderEnabled(f.first.id, false);
    expect(await f.catalog()).toEqual([f.other.alias]);
    expect((await f.post(f.chat.alias)).status).toBe(403);
    expect((await f.post(f.responses.alias, 'responses')).status).toBe(403);
    expect(f.calls).toEqual([]);
    const allowed = await f.post(f.other.alias); expect(allowed.status).toBe(200); await allowed.text();
    expect(f.calls).toEqual(['second-native']);
    f.store.setGatewayModelEnabled(f.other.id, false);
    expect(await f.catalog()).toEqual([]);
    expect((await f.post(f.other.alias)).status).toBe(403);
    expect(f.calls).toEqual(['second-native']);
    f.store.setGatewayProviderEnabled(f.first.id, true);
    expect(await f.catalog()).toEqual([f.chat.alias, f.responses.alias]);
    f.store.setGatewayModelEnabled(f.other.id, true);
    expect(await f.catalog()).toEqual([f.chat.alias, f.responses.alias, f.other.alias]);
    expect({ providers: f.store.listProviders(), models: f.store.listModels(), bindings: f.store.listBindings() }).toEqual(before);
  });

  it('keeps independent tool catalogs, inference and native direct configuration unchanged', async () => {
    const f = await fixture();
    const bindings = f.store.listBindings();
    const dsh = bindings.find(binding => binding.id === 'dsh')!;
    const codex = bindings.find(binding => binding.id === 'codex')!;
    const opencode = bindings.find(binding => binding.id === 'opencode')!;
    f.store.saveBinding({ ...dsh, enabled: true, mode: 'aggregate', providerIds: [f.first.id], modelSelection: 'selected', modelIds: [f.chat.id], defaultModelId: f.chat.id });
    f.store.saveBinding({ ...codex, enabled: true, mode: 'aggregate', providerIds: [f.first.id], modelSelection: 'selected', modelIds: [f.responses.id], defaultModelId: f.responses.id });
    f.store.saveBinding({ ...opencode, enabled: true, mode: 'direct', providerIds: [f.first.id], modelSelection: 'selected', modelIds: [f.chat.id], defaultModelId: f.chat.id });
    const directBefore = buildConfig(f.store, 'opencode', f.gateway.status().port, false);
    const bindingsBefore = f.store.listBindings();
    f.store.setGatewayProviderEnabled(f.first.id, false);
    f.store.setGatewayModelEnabled(f.chat.id, false);
    f.store.setGatewayModelEnabled(f.responses.id, false);
    const dshUrl = f.url.replace('/v1', '/tool/dsh/v1'), codexUrl = f.url.replace('/v1', '/tool/codex/v1');
    expect(await f.catalog()).toEqual([f.other.alias]);
    expect(await f.catalog(dshUrl)).toEqual([f.chat.alias]);
    expect(await f.catalog(codexUrl)).toEqual([f.responses.alias]);
    const dshReply = await f.post(f.chat.alias, 'chat/completions', dshUrl); expect(dshReply.status).toBe(200); await dshReply.text();
    const codexReply = await f.post(f.responses.alias, 'responses', codexUrl); expect(codexReply.status).toBe(200); await codexReply.text();
    expect(f.calls).toEqual(['first-native', 'first-responses-native']);
    expect(buildConfig(f.store, 'opencode', f.gateway.status().port, false)).toEqual(directBefore);
    expect(f.store.listBindings()).toEqual(bindingsBefore);
  });

  it('persists both exclusion lists independently across restart and provider toggles', async () => {
    const f = await fixture();
    f.store.setGatewayModelEnabled(f.chat.id, false);
    f.store.setGatewayProviderEnabled(f.first.id, false);
    f.store.setGatewayProviderEnabled(f.first.id, true);
    expect(await f.catalog()).toEqual([f.responses.alias, f.other.alias]);
    f.store.setGatewayProviderEnabled(f.second.id, false);
    const expected = { excludedProviderIds: [f.second.id], excludedModelIds: [f.chat.id] };
    await f.gateway.stop(); f.store.close();
    const reopened = await Store.create(f.dir);
    cleanups.push(() => reopened.close());
    expect(reopened.gatewayExposure()).toEqual(expected);
    const gateway = new Gateway(reopened); await gateway.start(0);
    cleanups.push(async () => { await gateway.stop(); });
    const headers = { authorization: `Bearer ${reopened.gatewayKey()}` };
    const catalog = await (await fetch(`${gateway.status().baseUrl}/models`, { headers })).json();
    expect(catalog.data.map((item: { id: string }) => item.id)).toEqual([f.responses.alias]);
  });

  it('rejects malformed, missing and nonboolean changes without creating orphan exclusions', async () => {
    const f = await fixture();
    for (const invalidId of ['', '../escape', null, {}, 'missing-provider']) {
      expect(() => f.store.setGatewayProviderEnabled(invalidId as string, false)).toThrow();
      expect(() => f.store.setGatewayModelEnabled(invalidId as string, false)).toThrow();
    }
    for (const invalid of [0, 1, 'false', undefined, null]) {
      expect(() => f.store.setGatewayProviderEnabled(f.first.id, invalid as unknown as boolean)).toThrow();
      expect(() => f.store.setGatewayModelEnabled(f.chat.id, invalid as unknown as boolean)).toThrow();
    }
    expect(f.store.gatewayExposure()).toEqual({ excludedProviderIds: [], excludedModelIds: [] });
    expect(await f.catalog()).toEqual([f.chat.alias, f.responses.alias, f.other.alias]);
  });
});
