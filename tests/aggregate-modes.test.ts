import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { buildConfig, connectionKey } from '../src/main/adapters';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import { jetBrainsConnectionParameters, isJetBrainsTool } from '../src/shared/jetbrains';
import type { Model, ToolId } from '../src/shared/types';

const tools: ToolId[] = ['codex', 'claude-code', 'opencode', 'dsh', 'vscode', 'copilot', 'webstorm', 'intellij-idea', 'rider', 'pycharm'];
const stores: Store[] = [], folders: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-modes-')); folders.push(dir);
  const store = await Store.create(dir); stores.push(store);
  const a = store.saveProvider({ name: 'A', kind: 'openai-compatible', baseUrl: 'https://a.example.test/v1', enabled: true, apiKey: 'SYNTHETIC_A_KEY' });
  const b = store.saveProvider({ name: 'B', kind: 'openai-compatible', baseUrl: 'https://b.example.test/v1', enabled: true, apiKey: 'SYNTHETIC_B_KEY' });
  const catalog: Model[] = [];
  for (const provider of [a, b]) for (const wireApi of ['chat-completions', 'responses', 'messages'] as const) catalog.push(store.saveModel({ providerId: provider.id, alias: `${provider.name}-${wireApi}`, upstreamId: `${wireApi}-upstream`, displayName: wireApi, wireApi, contextWindow: 0, tools: true, vision: false, enabled: true }));
  return { store, dir, a, b, catalog };
}
describe('all-tool explicit aggregation and single-source modes', () => {
  it.each(tools)('%s publishes exactly its selected aggregate models through one local credential group', async tool => {
    const f = await fixture();
    const protocol = tool === 'codex' ? 'responses' : 'chat-completions';
    const models = f.catalog.filter(model => model.wireApi === protocol);
    f.store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'aggregate', providerIds: [f.a.id, f.b.id], modelSelection: 'selected', modelIds: models.map(model => model.id), defaultModelId: models[1].id, note: '' });
    const binding = f.store.listBindings().find(binding => binding.id === tool)!;
    expect(bindingConnectionPolicy(binding, f.store.listModels(), f.store.listProviders())).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: [f.a.id, f.b.id], modelIds: models.map(model => model.id) }] });
    const preview = buildConfig(f.store, tool, 28282);
    expect(preview.content).toContain(`127.0.0.1:28282/tool/${tool}`);
    expect(preview.content).not.toMatch(/SYNTHETIC_A_KEY|SYNTHETIC_B_KEY/);
    expect(connectionKey(f.store, tool)).toBe(f.store.gatewayKey());
    f.store.saveBinding({ ...binding, enabled: false, modelIds: [], defaultModelId: '' });
    expect(resolveBindingModels(f.store.listBindings().find(binding => binding.id === tool)!, f.store.listModels(), f.store.listProviders())).toEqual([]);
    const added = f.store.saveModel({ ...models[0], id: undefined, alias: `${tool}-later-model` });
    expect(resolveBindingModels(f.store.listBindings().find(binding => binding.id === tool)!, [...models, added], f.store.listProviders())).toEqual([]);
  });
  it.each(tools)('%s rejects multiple explicit direct sources and uses one real API identity when eligible', async tool => {
    const f = await fixture();
    const protocol = tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'messages' : 'chat-completions';
    const model = f.catalog.find(model => model.providerId === f.a.id && model.wireApi === protocol)!;
    const binding = { id: tool, name: tool, enabled: true, mode: 'direct' as const, providerIds: [f.a.id], modelSelection: 'selected' as const, modelIds: [model.id], defaultModelId: model.id, note: '' };
    expect(() => f.store.saveBinding({ ...binding, providerIds: [f.a.id, f.b.id] })).toThrow('单供应商');
    f.store.saveBinding(binding);
    expect(bindingConnectionPolicy(binding, f.store.listModels(), f.store.listProviders()).groups[0]).toMatchObject({ connection: 'direct-api', providerIds: [f.a.id], modelIds: [model.id] });
    expect(connectionKey(f.store, tool)).toBe('SYNTHETIC_A_KEY');
    const revealed = buildConfig(f.store, tool, 28282, true);
    expect(revealed.content).toContain('https://a.example.test');
    if (tool !== 'dsh') expect(revealed.content).toContain('SYNTHETIC_A_KEY');
    expect(revealed.content).not.toContain('SYNTHETIC_B_KEY');
    if (isJetBrainsTool(tool)) expect(jetBrainsConnectionParameters(binding, f.store.listModels(), f.store.listProviders(), 28282)).toMatchObject({ kind: 'direct-api', baseUrl: f.a.baseUrl, modelId: model.upstreamId });
  });
  it('migrates old multi-entry direct metadata without changing sources, models or client files', async () => {
    const f = await fixture(), chosen = f.catalog.filter(model => model.wireApi === 'chat-completions');
    f.store.saveBinding({ id: 'opencode', name: 'OpenCode', enabled: true, mode: 'auto', providerIds: [f.a.id, f.b.id], modelIds: chosen.map(model => model.id), modelSelection: 'selected', defaultModelId: chosen[1].id, note: 'legacy' });
    const before = f.store.listBindings().find(binding => binding.id === 'opencode')!;
    const filename = join(f.dir, 'client-settings.json'); writeFileSync(filename, '{"keep":"external client configuration"}');
    f.store.close();
    const SQL = await initSqlJs(), db = new SQL.Database(readFileSync(join(f.dir, 'modeldock.sqlite')));
    db.run("UPDATE bindings SET mode='direct' WHERE id='opencode'");
    writeFileSync(join(f.dir, 'modeldock.sqlite'), db.export()); db.close();
    const reopened = await Store.create(f.dir); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === 'opencode')).toEqual(before);
    expect(readFileSync(filename, 'utf8')).toBe('{"keep":"external client configuration"}');
    expect(existsSync(join(f.dir, '.config', 'opencode', 'opencode.json'))).toBe(false);
    expect(bindingConnectionPolicy(before, reopened.listModels(), reopened.listProviders()).kind).toBe('native');
  });
});
