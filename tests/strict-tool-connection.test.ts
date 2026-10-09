import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { applyConfig, buildConfig, connectionKey } from '../src/main/adapters';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import { JETBRAINS_TOOLS, isJetBrainsTool, jetBrainsConnectionParameters } from '../src/shared/jetbrains';
import { switchSingleEntryMode, updateSingleEntryBinding } from '../src/shared/single-entry';
import type { Provider, ToolBinding, ToolId } from '../src/shared/types';

const tools: ToolId[] = ['codex', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm'];
const folders: string[] = [], stores: Store[] = [];
const gateways: Gateway[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) rmSync(folder, { force: true, recursive: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-strict-connection-')); folders.push(root);
  const data = join(root, 'data'), home = join(root, 'home');
  const store = await Store.create(data); stores.push(store);
  for (const provider of store.listProviders()) store.deleteProvider(provider.id);
  const a = store.saveProvider({ name: 'Native DeepSeek fixture', presetId: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', enabled: true, apiKey: 'SYNTHETIC_NATIVE_API_KEY' });
  const b = store.saveProvider({ name: 'Unrelated fixture', kind: 'openai-compatible', baseUrl: 'https://unrelated.fixture.invalid/v1', enabled: true, apiKey: 'SYNTHETIC_OTHER_API_KEY' });
  const model = (provider: Provider, upstreamId: string, alias: string) => store.saveModel({ providerId: provider.id, upstreamId, alias, displayName: upstreamId, wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const flash = model(a, 'deepseek-flash', 'dock/flash'), pro = model(a, 'deepseek-v4-pro', 'dock/pro'), other = model(b, 'other-native-model', 'dock/other');
  const binding = (tool: ToolId, mode: 'direct' | 'aggregate' = 'direct'): ToolBinding => ({ id: tool, name: tool, enabled: true, mode, providerIds: [a.id], modelIds: [], modelSelection: 'all', defaultModelId: flash.id, note: '' });
  const current = (tool: ToolId) => store.listBindings().find(binding => binding.id === tool)!;
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, data, home, store, a, b, flash, pro, other, binding, current, write };
}

describe('single-entry native connection contract', () => {
  it.each(tools)('%s exports and applies one DeepSeek native URL without changing Responses metadata', async tool => {
    const f = await fixture(), before = f.store.listModels();
    f.store.saveBinding(f.binding(tool));
    const selected = f.current(tool);
    expect(bindingConnectionPolicy(selected, before, f.store.listProviders())).toEqual({ kind: 'direct', groups: [{ connection: 'direct-api', providerIds: [f.a.id], modelIds: [f.flash.id, f.pro.id] }] });
    expect(connectionKey(f.store, tool)).toBe('SYNTHETIC_NATIVE_API_KEY');
    const preview = buildConfig(f.store, tool, 28282, false, f.home);
    const exported = buildConfig(f.store, tool, 28282, true, f.home);
    expect(preview.content).not.toMatch(/SYNTHETIC_NATIVE_API_KEY|SYNTHETIC_OTHER_API_KEY/);
    expect(exported.content).toContain('SYNTHETIC_NATIVE_API_KEY');
    expect(exported.content).not.toMatch(/127\.0\.0\.1|SYNTHETIC_OTHER_API_KEY|dock\/other/);
    const backups = join(f.root, 'backups');
    if (isJetBrainsTool(tool)) {
      const params = jetBrainsConnectionParameters(selected, before, f.store.listProviders(), 28282);
      expect(params).toMatchObject({ kind: 'direct-api', baseUrl: f.a.baseUrl, modelId: f.flash.upstreamId });
      const profileRoot = join(f.home, '.config', 'JetBrains'), cacheRoot = join(f.home, '.cache', 'JetBrains');
      const selector = `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`, target = join(profileRoot, selector);
      f.write(join(target, 'options', 'llm.provider.openai.like.xml'), '<application><component name="Unrelated"><option name="keep" value="stay"/></component></application>');
      f.write(join(cacheRoot, selector, '.pid'), '2147483646');
      const options = { platform: 'linux' as const, profileRoot, cacheRoot, processProbe: () => 'stopped' as const };
      expect(applyConfig(f.store, tool, 28282, f.data, backups, f.home, { jetBrainsOptions: options })).toBe(target);
      const xml = readFileSync(join(target, 'options', 'llm.provider.openai.like.xml'), 'utf8');
      expect(xml).toContain(`value="${f.a.baseUrl}"`); expect(xml).toContain('name="keep" value="stay"');
      expect(xml).not.toContain('SYNTHETIC_NATIVE_API_KEY');
      expect(readFileSync(join(target, 'options', 'llm.custom.models.xml'), 'utf8')).toContain('OpenAIAPI/deepseek-flash');
    } else if (tool === 'codex') {
      f.write(join(f.home, '.codex', 'config.toml'), '[mcp_servers.keep]\ncommand="unchanged"\n');
      const target = applyConfig(f.store, tool, 28282, f.data, backups, f.home);
      const applied = parseToml(readFileSync(target, 'utf8')) as any;
      expect(applied.model).toBe(f.flash.upstreamId); expect(applied.mcp_servers.keep.command).toBe('unchanged');
      expect(applied.model_providers.modeldock).toMatchObject({ base_url: f.a.baseUrl, wire_api: 'responses', experimental_bearer_token: 'SYNTHETIC_NATIVE_API_KEY' });
    } else {
      f.write(join(f.home, '.claude', 'settings.json'), '{"permissions":{"defaultMode":"plan"}}');
      const target = applyConfig(f.store, tool, 28282, f.data, backups, f.home);
      const applied = JSON.parse(readFileSync(target, 'utf8'));
      expect(applied.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: f.flash.upstreamId, ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_NATIVE_API_KEY' });
      expect(applied.permissions.defaultMode).toBe('plan');
    }
    expect(f.store.listModels()).toEqual(before);
  });

  it.each(tools)('%s preserves independent native and exact aggregate choices across changes and restart', async tool => {
    const f = await fixture(), catalog = f.store.listModels();
    const aggregate: ToolBinding = { ...f.binding(tool, 'aggregate'), providerIds: [f.a.id, f.b.id], modelSelection: 'selected', modelIds: [f.flash.id, f.other.id] };
    f.store.saveBinding(aggregate);
    const native = switchSingleEntryMode(f.current(tool), 'direct', catalog, f.store.listProviders());
    f.store.saveBinding(updateSingleEntryBinding(native, { enabled: true, providerIds: [f.a.id], defaultModelId: f.pro.id }, catalog, f.store.listProviders()));
    expect(f.current(tool)).toMatchObject({ mode: 'direct', providerIds: [f.a.id], defaultModelId: f.pro.id });
    const restored = switchSingleEntryMode(f.current(tool), 'aggregate', catalog, f.store.listProviders());
    f.store.saveBinding(restored);
    expect(f.current(tool)).toMatchObject({ mode: 'aggregate', providerIds: [f.a.id, f.b.id], modelIds: [f.flash.id, f.other.id], modelSelection: 'selected', defaultModelId: f.flash.id });
    expect(bindingConnectionPolicy(f.current(tool), catalog, f.store.listProviders())).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: [f.a.id, f.b.id], modelIds: [f.flash.id, f.other.id] }] });
    const exported = buildConfig(f.store, tool, 28282, true, f.home);
    expect(exported.content).toContain(`127.0.0.1:28282/tool/${tool}`);
    expect(exported.content).not.toMatch(/SYNTHETIC_NATIVE_API_KEY|SYNTHETIC_OTHER_API_KEY|deepseek-v4-pro/);
    const added = f.store.saveModel({ ...f.flash, id: undefined, alias: 'dock/newly-discovered', upstreamId: 'newly-discovered' });
    expect(resolveBindingModels(f.current(tool), f.store.listModels(), f.store.listProviders()).map(model => model.id)).toEqual([f.flash.id, f.other.id]);
    f.store.close(); const reopened = await Store.create(f.data); stores.push(reopened);
    const saved = reopened.listBindings().find(binding => binding.id === tool)!;
    expect(saved.connectionChoices?.direct).toEqual({ providerId: f.a.id, defaultModelId: f.pro.id });
    const directAgain = switchSingleEntryMode(saved, 'direct', reopened.listModels(), reopened.listProviders());
    expect(directAgain).toMatchObject({ mode: 'direct', providerIds: [f.a.id], defaultModelId: f.pro.id });
    expect(saved.connectionChoices?.aggregate?.modelIds).not.toContain(added.id);
    expect(JSON.stringify(saved.connectionChoices)).not.toMatch(/SYNTHETIC|apiKey|accessToken/);
  });

  it.each(tools)('%s rejects a subscription as native without silently exporting localhost', async tool => {
    const f = await fixture();
    const subscription = f.store.saveProvider({ name: 'Fixture subscription', kind: 'codex', enabled: true, baseUrl: 'https://chatgpt.com/backend-api/codex' });
    f.store.setSecret(subscription.id, { accessToken: 'SYNTHETIC_ACCESS_TOKEN', refreshToken: 'SYNTHETIC_REFRESH_TOKEN' });
    const model = f.store.saveModel({ ...f.flash, id: undefined, providerId: subscription.id, alias: 'subscription/synthetic' });
    const unsafe = { ...f.binding(tool), providerIds: [subscription.id], defaultModelId: model.id };
    const original = f.current(tool);
    expect(() => f.store.saveBinding(unsafe)).toThrow();
    expect(f.current(tool)).toEqual(original);
    const mockStore = { ...f.store, listModels: () => f.store.listModels(), listProviders: () => f.store.listProviders(), getProvider: (id: string) => f.store.getProvider(id), listBindings: () => [unsafe], getSecret: (id: string) => f.store.getSecret(id), gatewayKey: () => 'MUST_NOT_EXPORT_LOCAL_KEY' };
    expect(() => buildConfig(mockStore, tool, 28282, true, f.home)).toThrow();
    expect(bindingConnectionPolicy(unsafe, f.store.listModels(), f.store.listProviders()).groups).toEqual([]);
  });

  it('closes every stale local tool entry in direct mode and opens only exact aggregate mappings', async () => {
    const f = await fixture();
    const forward = vi.fn(async (url: string | URL | Request) => {
      const nativeMessages = String(url).includes('/anthropic/');
      const body = nativeMessages ? { id: 'msg_synthetic', type: 'message', role: 'assistant', model: f.flash.upstreamId, content: [{ type: 'text', text: 'MOCK_MAPPING_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: 'resp_synthetic', object: 'response', status: 'completed', model: f.flash.upstreamId, output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MOCK_MAPPING_OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    const gateway = new Gateway(f.store, { fetch: forward }); gateways.push(gateway); await gateway.start(0);
    const base = gateway.status().baseUrl.replace(/\/v1$/, ''), headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    const post = (tool: ToolId, model: string) => fetch(`${base}/tool/${tool}/v1/${tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'messages' : 'chat/completions'}`, { method: 'POST', headers, body: JSON.stringify({ model, stream: false, max_tokens: 16, ...(tool === 'codex' ? { input: 'SYNTHETIC_PROMPT' } : { messages: [{ role: 'user', content: 'SYNTHETIC_PROMPT' }] }) }) });
    for (const tool of tools) {
      f.store.saveBinding(f.binding(tool));
      expect((await fetch(`${base}/tool/${tool}/v1/models`, { headers })).status).toBe(403);
      expect((await post(tool, f.flash.alias)).status).toBe(403);
    }
    expect(forward).not.toHaveBeenCalled();
    for (const tool of tools) {
      f.store.saveBinding({ ...f.current(tool), mode: 'aggregate', providerIds: [f.a.id, f.b.id], modelSelection: 'selected', modelIds: [f.flash.id, f.other.id], defaultModelId: f.flash.id });
      const listing = await (await fetch(`${base}/tool/${tool}/v1/models`, { headers })).json();
      expect(listing.data.map((model: { id: string }) => model.id)).toEqual([f.flash.alias, f.other.alias]);
      expect((await post(tool, f.pro.alias)).status).toBe(403);
      const accepted = await post(tool, f.flash.alias);
      expect(accepted.status).toBe(200); expect(await accepted.text()).toContain('MOCK_MAPPING_OK');
    }
    expect(forward).toHaveBeenCalledTimes(tools.length);
  });

  it('removes deleted inactive native and aggregate references before another mode is restored', async () => {
    const f = await fixture(), tool = 'rider';
    f.store.saveBinding({ ...f.binding(tool, 'aggregate'), providerIds: [f.a.id, f.b.id], modelSelection: 'selected', modelIds: [f.flash.id, f.other.id] });
    f.store.saveBinding(switchSingleEntryMode(f.current(tool), 'direct', f.store.listModels(), f.store.listProviders()));
    f.store.deleteProvider(f.b.id);
    const active = f.current(tool), restore = switchSingleEntryMode(active, 'aggregate', f.store.listModels(), f.store.listProviders());
    expect(restore.providerIds).toEqual([f.a.id]); expect(restore.modelIds).toEqual([f.flash.id]);
    f.store.saveBinding(restore);
    f.store.deleteProvider(f.a.id);
    expect(switchSingleEntryMode(f.current(tool), 'direct', f.store.listModels(), f.store.listProviders())).toMatchObject({ enabled: false, providerIds: [], defaultModelId: '' });
    expect(JSON.stringify(f.current(tool).connectionChoices)).not.toMatch(new RegExp(`${f.a.id}|${f.b.id}|${f.flash.id}|${f.other.id}`));
  });

  it('restores an explicitly empty aggregate mapping without enabling or publishing models', async () => {
    const f = await fixture(), tool = 'rider';
    f.store.saveBinding(f.binding(tool));
    const native = f.current(tool);
    f.store.saveBinding({ ...native, mode: 'aggregate', enabled: false, providerIds: [f.a.id, f.b.id], modelSelection: 'selected', modelIds: [], defaultModelId: '' });
    f.store.saveBinding(switchSingleEntryMode(f.current(tool), 'direct', f.store.listModels(), f.store.listProviders()));
    const restored = switchSingleEntryMode(f.current(tool), 'aggregate', f.store.listModels(), f.store.listProviders());
    expect(restored).toMatchObject({ enabled: false, providerIds: [f.a.id, f.b.id], modelSelection: 'selected', modelIds: [], defaultModelId: '' });
    expect(() => f.store.saveBinding(restored)).not.toThrow();
    expect(resolveBindingModels(f.current(tool), f.store.listModels(), f.store.listProviders())).toEqual([]);
    expect(buildConfig(f.store, tool, 28282, true, f.home).content).toBe('{}');
  });

  it('allows mode changes when the remembered native supplier has since been disabled', async () => {
    const f = await fixture(), tool = 'rider';
    f.store.saveBinding(f.binding(tool));
    f.store.saveBinding({ ...f.current(tool), mode: 'aggregate', providerIds: [f.b.id], modelSelection: 'selected', modelIds: [f.other.id], defaultModelId: f.other.id });
    f.store.saveProvider({ ...f.a, enabled: false });
    const restored = switchSingleEntryMode(f.current(tool), 'direct', f.store.listModels(), f.store.listProviders());
    expect(restored.enabled).toBe(false);
    expect(() => f.store.saveBinding(restored)).not.toThrow();
    expect(bindingConnectionPolicy(f.current(tool), f.store.listModels(), f.store.listProviders()).groups).toEqual([]);
  });

  it('rewrites inactive native identity during a duplicate merge without expanding aggregate permissions', async () => {
    const f = await fixture(), tool = 'rider';
    const duplicate = f.store.saveProvider({ name: 'Duplicate native fixture', presetId: 'deepseek', kind: 'openai-compatible', baseUrl: f.a.baseUrl, enabled: true, apiKey: 'SYNTHETIC_NATIVE_API_KEY' });
    const duplicateModel = f.store.saveModel({ ...f.flash, id: undefined, providerId: duplicate.id, alias: 'dock/duplicate', upstreamId: 'duplicate-native' });
    const aggregate = { ...f.binding(tool, 'aggregate'), modelSelection: 'selected' as const, modelIds: [f.flash.id], connectionChoices: { direct: { providerId: duplicate.id, defaultModelId: duplicateModel.id } } };
    f.store.saveBinding(aggregate);
    // Existing duplicate rows are a migration scenario; new input rejects duplicates.
    f.store.close();
    const SQL = await initSqlJs(), database = new SQL.Database(readFileSync(join(f.data, 'modeldock.sqlite')));
    database.run('UPDATE providers SET name=? WHERE id=?', [f.a.name, duplicate.id]);
    writeFileSync(join(f.data, 'modeldock.sqlite'), database.export()); database.close();
    const reopened = await Store.create(f.data); stores.push(reopened);
    const group = reopened.listProviderDuplicates().find(group => group.providerIds.includes(duplicate.id))!;
    expect(group.canMerge).toBe(true);
    const merged = reopened.mergeProviderDuplicates(group.providerIds, group.fingerprint);
    const selected = reopened.listBindings().find(binding => binding.id === tool)!;
    expect(selected.modelIds).toEqual([f.flash.id]);
    expect(selected.connectionChoices?.direct).toEqual({ providerId: merged.keptProviderId, defaultModelId: duplicateModel.id });
    const native = switchSingleEntryMode(selected, 'direct', reopened.listModels(), reopened.listProviders());
    expect(native.providerIds).toEqual([merged.keptProviderId]); expect(native.defaultModelId).toBe(duplicateModel.id);
    reopened.saveBinding(native);
    const restored = switchSingleEntryMode(reopened.listBindings().find(binding => binding.id === tool)!, 'aggregate', reopened.listModels(), reopened.listProviders());
    expect(resolveBindingModels(restored, reopened.listModels(), reopened.listProviders()).map(model => model.id)).toEqual([f.flash.id]);
  });
});
