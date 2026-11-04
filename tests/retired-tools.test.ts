import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { removeProviderAndSync } from '../src/main/provider-removal';
import type { ToolId } from '../src/shared/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function database(filename: string) {
  const SQL = await initSqlJs({ locateFile: file => join(process.cwd(), 'node_modules/sql.js/dist', file) });
  return new SQL.Database(readFileSync(filename));
}
async function fixture(legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-retired-tool-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let store = await Store.create(dir);
  const provider = store.saveProvider({ name: 'Retirement fixture', kind: 'openai-compatible', baseUrl: 'https://fixture.example.test/v1', enabled: true, apiKey: 'synthetic-retirement-key' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'fixture-native', alias: 'fixture-local', displayName: 'Fixture model', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  if (legacy) {
    store.close();
    const db = await database(join(dir, 'modeldock.sqlite'));
    // Historical unsupported drafts must remain inert even when their old JSON
    // format cannot be parsed by the active adapters.
    db.run('INSERT INTO bindings(id,name,enabled,model_ids,default_model_id,note,mode,provider_ids,model_selection,connection_choices) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ['trae', 'Trae CN', 1, JSON.stringify([model.id]), model.id, 'preserve old metadata', 'aggregate', JSON.stringify([provider.id]), 'selected', 'legacy-unparsed-draft']);
    writeFileSync(join(dir, 'modeldock.sqlite'), Buffer.from(db.export())); db.close();
    store = await Store.create(dir);
  }
  cleanup.push(() => store.close());
  return { store, provider, model, dir };
}

describe('removed Trae integration', () => {
  it('does not create a Trae tool in a new store', async () => {
    const f = await fixture();
    expect(f.store.listBindings()).toHaveLength(11);
    expect(f.store.listBindings().some(binding => String(binding.id) === 'trae')).toBe(false);
    f.store.close();
    const db = await database(join(f.dir, 'modeldock.sqlite'));
    expect(db.exec("SELECT id FROM bindings WHERE id='trae'")).toEqual([]); db.close();
  });

  it('preserves but excludes historical drafts and never synchronizes them on source removal', async () => {
    const f = await fixture(true);
    expect(f.store.listBindings()).toHaveLength(11);
    expect(f.store.listBindings().some(binding => String(binding.id) === 'trae')).toBe(false);
    const normal = f.store.listBindings().find(binding => binding.id === 'opencode')!;
    expect(() => f.store.saveBinding({ ...normal, id: 'trae' as ToolId })).toThrow('工具绑定无效');
    expect(() => f.store.restoreBindingSelection({ ...normal, id: 'trae' as ToolId })).toThrow('工具绑定无效');
    const sync = vi.fn(async () => {});
    await removeProviderAndSync(f.store, f.provider.id, sync);
    expect(sync).not.toHaveBeenCalled();
    f.store.close();
    const db = await database(join(f.dir, 'modeldock.sqlite'));
    const row = db.exec("SELECT enabled,model_ids,default_model_id,note,mode,provider_ids,connection_choices FROM bindings WHERE id='trae'")[0].values[0];
    expect(row).toEqual([1, JSON.stringify([f.model.id]), f.model.id, 'preserve old metadata', 'aggregate', JSON.stringify([f.provider.id]), 'legacy-unparsed-draft']); db.close();
  });

  it('rejects all old tool routes while another tool still lists and forwards its model', async () => {
    const f = await fixture(true);
    const current = f.store.listBindings().find(binding => binding.id === 'opencode')!;
    f.store.saveBinding({ ...current, enabled: true, mode: 'aggregate', providerIds: [f.provider.id], modelSelection: 'selected', modelIds: [f.model.id], defaultModelId: f.model.id });
    const upstream = vi.fn(async () => new Response(JSON.stringify({ id: 'fixture-reply', model: 'fixture-native', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }));
    const gateway = new Gateway(f.store, { fetch: upstream });
    await gateway.start(0); cleanup.push(async () => { await gateway.stop(); });
    const origin = new URL(gateway.status().baseUrl).origin;
    const headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    for (const endpoint of ['models', 'responses', 'chat/completions', 'messages']) {
      const reply = await fetch(`${origin}/tool/trae/v1/${endpoint}`, endpoint === 'models' ? { headers } : { method: 'POST', headers, body: JSON.stringify({ model: f.model.alias, messages: [] }) });
      expect(reply.status).toBe(404); await reply.text();
    }
    expect(upstream).not.toHaveBeenCalled();
    const catalog = await fetch(`${origin}/tool/opencode/v1/models`, { headers });
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).data.map((model: { id: string }) => model.id)).toEqual([f.model.alias]);
    const reply = await fetch(`${origin}/tool/opencode/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: f.model.alias, messages: [{ role: 'user', content: 'synthetic fixture' }] }) });
    expect(reply.status).toBe(200); expect((await reply.json()).choices[0].message.content).toBe('OK');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
