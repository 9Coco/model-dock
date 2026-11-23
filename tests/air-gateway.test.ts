import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/main/gateway';
import { Store } from '../src/main/store';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });

it.each(['chat-completions', 'responses'] as const)('uses OpenAI %s with a legacy Anthropic Air binding', async wireApi => {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-air-gateway-'));
  const store = await Store.create(dir);
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const provider = store.saveProvider({ name: 'Air fixture', kind: 'openai-compatible', presetId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic', enabled: true, apiKey: 'SYNTHETIC_UPSTREAM_KEY' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'deepseek-flash', alias: 'air-flash', displayName: 'Flash',
    wireApi, contextWindow: 64000, tools: true, vision: false, enabled: true });
  store.saveModel({ ...model, id: undefined, wireApi: 'messages', alias: 'messages-only', upstreamId: 'messages-only' });
  store.saveBinding({ id: 'air', name: 'Air', mode: 'aggregate', enabled: true, airProvider: 'anthropic', providerIds: [provider.id],
    modelIds: [], modelSelection: 'all', defaultModelId: model.id, note: '' });
  const calls: { url: string; authorization: string | null; model: string }[] = [];
  const gateway = new Gateway(store, { fetch: async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), model: JSON.parse(String(init?.body)).model });
    return Response.json({ model: 'deepseek-flash' });
  } });
  await gateway.start(0); cleanup.push(() => gateway.stop().then(() => undefined));
  const root = gateway.status().baseUrl.replace(/\/v1$/, '') + '/tool/air/v1';
  const auth = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
  const body = JSON.stringify({ model: model.alias });
  expect((await fetch(root + '/models', { headers: { 'x-api-key': store.gatewayKey() } })).status).toBe(401);
  const catalog = await (await fetch(root + '/models', { headers: auth })).json();
  expect(catalog.data.map((entry: { id: string }) => entry.id)).toEqual([model.alias]);
  expect(catalog.data[0].wire_api).toBe(wireApi);
  expect((await fetch(root + '/messages', { method: 'POST', body, headers: auth })).status).toBe(404);
  const path = wireApi === 'responses' ? '/responses' : '/chat/completions';
  expect((await fetch(root + path, { method: 'POST', body, headers: auth })).status).toBe(200);
  expect(calls).toEqual([{ url: 'https://api.deepseek.com' + path, authorization: 'Bearer SYNTHETIC_UPSTREAM_KEY', model: 'deepseek-flash' }]);
});
