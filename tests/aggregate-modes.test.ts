import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { buildConfig, connectionKey } from '../src/main/adapters';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import { jetBrainsConnectionParameters, isJetBrainsTool } from '../src/shared/jetbrains';
import { supportsMultipleSources } from '../src/shared/tool-capabilities';
import type { Model, ToolId } from '../src/shared/types';

const tools: ToolId[] = ['codex', 'claude-code', 'junie', 'copilot-cli', 'opencode', 'opencode-desktop', 'dsh', 'vscode', 'copilot', 'webstorm', 'intellij-idea', 'rider', 'pycharm'];
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
describe('product-specific source capabilities and explicit aggregation', () => {
  it.each(['junie', 'copilot-cli'] as const)('preserves %s legacy inactive drafts during edits and prunes them on global deletion', async tool => {
    const f = await fixture(), models = f.catalog.filter(model => model.wireApi === 'chat-completions');
    const choices = { direct: { providerId: f.a.id, defaultModelId: models[0].id }, aggregate: { providerIds: [f.b.id], modelIds: [models[1].id], modelSelection: 'selected' as const, defaultModelId: models[1].id } };
    const binding = { id: tool, name: tool, enabled: true, mode: 'direct' as const, providerIds: [f.a.id], modelIds: [models[0].id], modelSelection: 'selected' as const, defaultModelId: models[0].id, note: '', connectionChoices: choices };
    f.store.restoreBindingSelection(binding);
    const { connectionChoices: _choices, ...edited } = binding;
    f.store.saveBinding({ ...edited, note: 'unrelated edit' });
    expect(f.store.listBindings().find(row => row.id === tool)!.connectionChoices).toEqual(choices);
    f.store.deleteProvider(f.b.id);
    const after = f.store.listBindings().find(row => row.id === tool)!;
    expect(after.connectionChoices?.aggregate).toEqual({ providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '' });
    expect(after.providerIds).toEqual([f.a.id]); expect(after.enabled).toBe(true);
  });
  it.each(['opencode', 'opencode-desktop', 'vscode', 'dsh', 'copilot', 'copilot-cli', 'junie'] as const)('%s retains native source groups, independent keys and exact model scope when one source is removed', async tool => {
    const f = await fixture(), selected = f.catalog.filter(model => model.wireApi === 'chat-completions');
    const binding = { id: tool, name: tool, enabled: true, mode: 'direct' as const, providerIds: [f.a.id, f.b.id], modelSelection: 'selected' as const, modelIds: selected.map(model => model.id), defaultModelId: selected[1].id, note: '' };
    f.store.saveBinding(binding);
    const saved = f.store.listBindings().find(row => row.id === tool)!;
    expect(saved.providerIds).toEqual([f.a.id, f.b.id]);
    expect(bindingConnectionPolicy(saved, f.catalog, f.store.listProviders())).toEqual({ kind: 'native', groups: [
      { connection: 'direct-api', providerIds: [f.a.id], modelIds: [selected[0].id] },
      { connection: 'direct-api', providerIds: [f.b.id], modelIds: [selected[1].id] },
    ] });
    const preview = buildConfig(f.store, tool, 28282).content, exported = buildConfig(f.store, tool, 28282, true).content;
    for (const url of [f.a.baseUrl, f.b.baseUrl]) expect(preview).toContain(url);
    expect(preview).not.toMatch(/SYNTHETIC_[AB]_KEY/);
    if (tool !== 'dsh') for (const key of ['SYNTHETIC_A_KEY', 'SYNTHETIC_B_KEY']) expect(exported).toContain(key);
    expect(exported).not.toContain('127.0.0.1:28282');
    expect(() => connectionKey(f.store, tool)).toThrow();
    f.store.saveBinding({ ...saved, providerIds: [f.b.id], modelIds: [selected[1].id] });
    const remaining = buildConfig(f.store, tool, 28282, true).content;
    expect(remaining).toContain(f.b.baseUrl); expect(remaining).not.toContain(f.a.baseUrl);
    expect(f.store.listModels()).toHaveLength(f.catalog.length);
    f.store.saveBinding({ ...saved, modelIds: [], defaultModelId: '' });
    expect(resolveBindingModels(f.store.listBindings().find(row => row.id === tool)!, f.catalog, f.store.listProviders())).toEqual([]);
  });
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
  it.each(tools)('%s uses the selected real API identity and respects its source-count capability', async tool => {
    const f = await fixture();
    const protocol = tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'messages' : 'chat-completions';
    const model = f.catalog.find(model => model.providerId === f.a.id && model.wireApi === protocol)!;
    const binding = { id: tool, name: tool, enabled: true, mode: 'direct' as const, providerIds: [f.a.id], modelSelection: 'selected' as const, modelIds: [model.id], defaultModelId: model.id, note: '' };
    if (supportsMultipleSources(tool)) expect(() => f.store.saveBinding({ ...binding, providerIds: [f.a.id, f.b.id] })).not.toThrow();
    else expect(() => f.store.saveBinding({ ...binding, providerIds: [f.a.id, f.b.id] })).toThrow('单供应商');
    f.store.saveBinding(binding);
    expect(bindingConnectionPolicy(binding, f.store.listModels(), f.store.listProviders()).groups[0]).toMatchObject({ connection: 'direct-api', providerIds: [f.a.id], modelIds: [model.id] });
    expect(connectionKey(f.store, tool)).toBe('SYNTHETIC_A_KEY');
    const revealed = buildConfig(f.store, tool, 28282, true);
    expect(revealed.content).toContain('https://a.example.test');
    if (tool !== 'dsh') expect(revealed.content).toContain('SYNTHETIC_A_KEY');
    expect(revealed.content).not.toContain('SYNTHETIC_B_KEY');
    if (isJetBrainsTool(tool)) expect(jetBrainsConnectionParameters(binding, f.store.listModels(), f.store.listProviders(), 28282)).toMatchObject({ kind: 'direct-api', baseUrl: f.a.baseUrl, modelId: model.upstreamId });
  });
  it.each(['opencode', 'opencode-desktop', 'vscode', 'dsh', 'copilot', 'copilot-cli', 'junie'] as const)('reopens %s multi-entry metadata without changing sources, models or client files', async tool => {
    const f = await fixture(), chosen = f.catalog.filter(model => model.wireApi === 'chat-completions');
    f.store.saveBinding({ id: tool, name: tool, enabled: true, mode: 'auto', providerIds: [f.a.id, f.b.id], modelIds: chosen.map(model => model.id), modelSelection: 'selected', defaultModelId: chosen[1].id, note: 'legacy' });
    const before = f.store.listBindings().find(binding => binding.id === tool)!;
    const filename = join(f.dir, 'client-settings.json'); writeFileSync(filename, '{"keep":"external client configuration"}');
    f.store.close();
    const SQL = await initSqlJs(), db = new SQL.Database(readFileSync(join(f.dir, 'modeldock.sqlite')));
    db.run("UPDATE bindings SET mode='direct' WHERE id=?", [tool]);
    writeFileSync(join(f.dir, 'modeldock.sqlite'), db.export()); db.close();
    const reopened = await Store.create(f.dir); stores.push(reopened);
    expect(reopened.listBindings().find(binding => binding.id === tool)).toEqual({ ...before, mode: supportsMultipleSources(tool) ? 'direct' : 'auto' });
    expect(readFileSync(filename, 'utf8')).toBe('{"keep":"external client configuration"}');
    expect(existsSync(join(f.dir, '.config', 'opencode', 'opencode.json'))).toBe(false);
    expect(bindingConnectionPolicy(before, reopened.listModels(), reopened.listProviders()).kind).toBe('native');
  });
});
