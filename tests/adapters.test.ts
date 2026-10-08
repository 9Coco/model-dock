import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from '@iarna/toml';
import { parse as parseYaml } from 'yaml';
import { buildConfig, buildCopilotDesktopPlan, buildDshPlan, applyConfig, connectionKey } from '../src/main/adapters';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
function dshProviders(content: string) { return parseYaml(content).find((row: any) => row.id === 'llm-pi-ai').config.providers; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const models: Model[] = [{ id: 'model-one', providerId: 'provider-one', upstreamId: 'upstream-model', alias: 'dock-model', displayName: '测试模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true }];
const store = {
  listModels: () => models,
  listBindings: () => ['vscode', 'codex', 'copilot', 'dsh', 'opencode'].map(id => ({ id, name: id, enabled: true, modelIds: ['model-one'], defaultModelId: 'model-one', note: '', ...(id === 'vscode' ? { vscodeSyncScope: 'managed' } : {}) } as ToolBinding)),
  gatewayKey: () => 'local-test-secret',
};
function nativeFixture(ids = ['provider-a', 'provider-b', 'subscription']) {
  const providers: Provider[] = [
    { id: 'provider-a', name: 'API 套餐 A', kind: 'openai-compatible', baseUrl: 'https://api-a.test/v1/', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
    { id: 'provider-b', name: 'API 套餐 B', kind: 'openai-compatible', baseUrl: 'https://api-b.test/coding/v3', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
    { id: 'subscription', name: 'Codex 订阅', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
  ];
  const catalog: Model[] = providers.map((provider, index) => ({ ...models[0], id: `native-${index}`, providerId: provider.id, upstreamId: 'shared-upstream', alias: index === 0 ? 'shared-upstream' : `${provider.id}/shared-upstream`, displayName: '同名模型' }));
  const getSecret = vi.fn((id: string) => ({ apiKey: id === 'subscription' ? undefined : `SYNTHETIC_KEY_${id}`, accessToken: 'PRIVATE_OAUTH_ACCESS', refreshToken: 'PRIVATE_OAUTH_REFRESH' }));
  return { ...store, providers, catalog, getSecret, listModels: () => catalog, listProviders: () => providers,
    getProvider: (id: string) => providers.find(provider => provider.id === id),
    listBindings: () => store.listBindings().map(binding => ({ ...binding, enabled: ids.length > 0, mode: 'auto' as const, providerIds: ids, modelIds: [], defaultModelId: 'native-1' })),
  };
}
describe('tool adapters', () => {
  it('writes OpenCode to the explicit XDG config root and preserves the unused default configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-xdg-')); roots.push(root);
    const configHome = join(root, 'custom-config'), defaultTarget = join(root, '.config', 'opencode', 'opencode.json');
    mkdirSync(dirname(defaultTarget), { recursive: true }); writeFileSync(defaultTarget, '{"keep":"default"}');
    const target = applyConfig(store, 'opencode', 19191, root, join(root, 'backups'), root, { configHome });
    expect(target).toBe(join(configHome, 'opencode', 'opencode.json'));
    expect(parseJsonc(readFileSync(target, 'utf8')).provider.modeldock).toBeDefined();
    expect(readFileSync(defaultTarget, 'utf8')).toBe('{"keep":"default"}');
  });
  it('allows multiple direct API providers for native multi-source clients while Codex remains a single active direct endpoint', () => {
    const native = nativeFixture(['provider-a', 'provider-b']);
    const direct = { ...native, listBindings: () => native.listBindings().map(binding => ({ ...binding, mode: 'direct' as const })) };
    const vscode = JSON.parse(buildConfig(direct, 'vscode', 19191, true).content);
    expect(vscode.map((row: any) => row.apiKey)).toEqual(['SYNTHETIC_KEY_provider-a', 'SYNTHETIC_KEY_provider-b']);
    expect(vscode.map((row: any) => row.models[0].url)).toEqual(['https://api-a.test/v1/responses', 'https://api-b.test/coding/v3/responses']);
    expect(vscode.map((row: any) => row.models[0].requestHeaders)).toEqual([
      { authorization: 'Bearer SYNTHETIC_KEY_provider-a' }, { authorization: 'Bearer SYNTHETIC_KEY_provider-b' },
    ]);
    const opencode = JSON.parse(buildConfig(direct, 'opencode', 19191, true).content);
    expect(Object.keys(opencode.provider)).toEqual(['modeldock-provider-a', 'modeldock-provider-b']);
    expect(Object.values(dshProviders(buildConfig(direct, 'dsh', 19191).content))).toHaveLength(2);
    expect(JSON.parse(buildConfig(direct, 'copilot', 19191, true).content).providers).toHaveLength(2);
    expect(() => buildConfig(direct, 'codex', 19191)).toThrow('Codex 直连模式请只选择一家供应商');
  });
  it('previews hide local keys and use tool-scoped gateway paths', () => {
    for (const tool of ['vscode', 'codex', 'copilot', 'opencode'] as const) {
      const result = buildConfig(store, tool, 19191);
      expect(result.content).not.toContain('local-test-secret');
      expect(result.content).toContain(`/tool/${tool}/v1`);
    }
    const copilot = JSON.parse(buildConfig(store, 'copilot', 19191, true).content);
    expect(Array.isArray(copilot.providers)).toBe(true);
    expect(copilot.providers[0].models[0].wireApi).toBe('responses');
    expect(buildConfig(store, 'opencode', 19191).canApply).toBe(true);
  });
  it('uses nonzero client budgets for unknown contexts without changing known models or explicit tool preferences', () => {
    const catalog: Model[] = [models[0], { ...models[0], id: 'unknown', alias: 'unknown-model', upstreamId: 'unknown-upstream', contextWindow: 0, tools: false }];
    const snapshot = structuredClone(catalog);
    const unknownStore = { ...store, listModels: () => catalog,
      listBindings: () => store.listBindings().map(binding => ({ ...binding, modelIds: catalog.map(model => model.id) })),
    };
    const vscode = buildConfig(unknownStore, 'vscode', 19191);
    expect(JSON.parse(vscode.content)[0].models).toMatchObject([
      { id: 'dock-model', contextWindow: 64000, maxOutputTokens: 16000, toolCalling: true },
      { id: 'unknown-model', contextWindow: 32768, maxOutputTokens: 4096, toolCalling: false },
    ]);
    const opencode = buildConfig(unknownStore, 'opencode', 19191);
    expect(JSON.parse(opencode.content).provider.modeldock.models).toMatchObject({
      'dock-model': { limit: { context: 64000, output: 16000 }, tool_call: true },
      'unknown-model': { limit: { context: 32768, output: 4096 }, tool_call: false },
    });
    const dsh = buildConfig(unknownStore, 'dsh', 19191);
    expect(dshProviders(dsh.content).modeldock.models).toMatchObject([
      { id: 'dock-model', contextWindow: 64000, maxTokens: 16000 },
      { id: 'unknown-model', contextWindow: 32768, maxTokens: 4096 },
    ]);
    for (const preview of [vscode, opencode, dsh]) {
      expect(preview.instructions).toContain('32K（32768）上下文 / 4K（4096）输出');
      expect(preview.instructions).toContain('不是上游模型规格');
      expect(preview.instructions).toContain('模型编辑');
    }
    expect(buildConfig(store, 'vscode', 19191).instructions).not.toContain('客户端配置预算');
    expect(catalog).toEqual(snapshot);
  });
  it('omits optional unknown Codex context while keeping known context and existing settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const catalog: Model[] = [models[0], { ...models[0], id: 'unknown', alias: 'unknown-model', contextWindow: 0, tools: false }];
    const unknownStore = { ...store, listModels: () => catalog,
      listBindings: () => store.listBindings().map(binding => ({ ...binding, modelIds: catalog.map(model => model.id) })),
    };
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), 'model_context_window = 48000\n[mcp_servers.keep]\ncommand="keep"\n');
    const target = applyConfig(unknownStore, 'codex', 19191, root, join(root, 'backups'), root);
    const existing = parseToml(readFileSync(target, 'utf8')) as any;
    expect(existing.model_context_window).toBe(48000);
    expect(existing.mcp_servers.keep.command).toBe('keep');
    const exported = JSON.parse(readFileSync(join(root, '.codex', 'modeldock-models.json'), 'utf8')).models;
    expect(exported[0].context_window).toBe(64000);
    expect(exported[1]).not.toHaveProperty('context_window');
    expect(exported[1].supports_parallel_tool_calls).toBe(false);
    expect(buildConfig(unknownStore, 'codex', 19191).instructions).toContain('省略可选上下文字段');
    expect(catalog[1].contextWindow).toBe(0);
  });
  it('emits client thinking levels only for models declaring supported levels', () => {
    const catalog: Model[] = [
      { ...models[0], id: 'reasoning', alias: 'reasoning-model', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
      { ...models[0], id: 'plain', alias: 'plain-model' },
    ];
    const reasoningStore = { ...store, listModels: () => catalog,
      listBindings: () => store.listBindings().map(binding => ({ ...binding, modelIds: catalog.map(model => model.id), defaultModelId: 'reasoning' })),
    };
    const vscode = JSON.parse(buildConfig(reasoningStore, 'vscode', 19191).content)[0].models;
    expect(vscode.find((row: any) => row.id === 'reasoning-model')).toMatchObject({ supportsReasoningEffort: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' });
    expect(vscode.find((row: any) => row.id === 'plain-model')).not.toHaveProperty('supportsReasoningEffort');
    expect(vscode.find((row: any) => row.id === 'plain-model')).not.toHaveProperty('defaultReasoningEffort');
    const desktop = buildCopilotDesktopPlan(reasoningStore, 19191).providers[0].models;
    expect(desktop.find(row => row.modelId === 'reasoning-model')?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(desktop.find(row => row.modelId === 'plain-model')).not.toHaveProperty('supportedReasoningEfforts');
    const dsh = dshProviders(buildConfig(reasoningStore, 'dsh', 19191).content).modeldock.models;
    expect(dsh.find((row: any) => row.id === 'reasoning-model').reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(dsh.find((row: any) => row.id === 'plain-model')).not.toHaveProperty('reasoningEfforts');
  });
  it('writes Codex thinking levels as described effort objects with a default level', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const catalog: Model[] = [
      { ...models[0], reasoningEfforts: ['minimal', 'low', 'medium'], defaultReasoningEffort: 'low' },
      { ...models[0], id: 'plain', alias: 'plain-model' },
    ];
    const reasoningStore = { ...store, listModels: () => catalog,
      listBindings: () => store.listBindings().map(binding => ({ ...binding, modelIds: catalog.map(model => model.id) })),
    };
    mkdirSync(join(root, '.codex'));
    applyConfig(reasoningStore, 'codex', 19191, root, join(root, 'backups'), root);
    const exported = JSON.parse(readFileSync(join(root, '.codex', 'modeldock-models.json'), 'utf8')).models;
    expect(exported[0].supported_reasoning_levels).toEqual([
      { effort: 'minimal', description: 'Minimal reasoning effort' },
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth' },
    ]);
    expect(exported[0].default_reasoning_level).toBe('low');
    expect(exported[1].supported_reasoning_levels).toEqual([]);
    expect(exported[1].default_reasoning_level).toBeNull();
  });
  it('applies unknown-context client budgets while retaining comments and other provider budgets', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const unknownStore = { ...store, listModels: () => [{ ...models[0], contextWindow: 0, tools: false }] };
    const target = join(root, '.config', 'opencode', 'opencode.jsonc');
    mkdirSync(join(root, '.config', 'opencode'), { recursive: true });
    const otherProvider = { npm: 'other-sdk', models: { backup: { limit: { context: 262144, output: 8192 }, tool_call: false } } };
    writeFileSync(target, '{\n// preserve budget comment\n"provider":{"other":' + JSON.stringify(otherProvider) + '},"mcp":{"keep":{"command":["keep"]}}\n}');
    applyConfig(unknownStore, 'opencode', 19191, root, join(root, 'backups'), root);
    const content = readFileSync(target, 'utf8'); const data = parseJsonc(content);
    expect(content).toContain('preserve budget comment');
    expect(data.provider.other).toEqual(otherProvider);
    expect(data.mcp.keep.command).toEqual(['keep']);
    expect(data.provider.modeldock.models['dock-model']).toMatchObject({ limit: { context: 32768, output: 4096 }, tool_call: false });
    expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  });
  it('preserves VS Code comments and other providers, creates a backup, and avoids duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(join(root, 'Code', 'User'), { recursive: true });
    writeFileSync(target, '[\n // keep this comment\n {"name":"Other","vendor":"openai","models":[]}\n]\n');
    applyConfig(store, 'vscode', 19191, root, join(root, 'backups'), root);
    applyConfig(store, 'vscode', 19191, root, join(root, 'backups'), root);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('keep this comment');
    const values = parseJsonc(text);
    expect(values.map((v: {name: string}) => v.name)).toEqual(['Other', 'ModelDock']);
    expect(values[1].models[0].toolCalling).toBe(true);
    expect(readdirSync(join(root, 'backups')).length).toBeGreaterThan(0);
  });
  it('merges Codex settings without changing auth and MCP values', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex', 'auth.json'), 'keep-auth');
    writeFileSync(join(root, '.codex', 'config.toml'), 'model = "old"\n[mcp_servers.keep]\ncommand = "keep"\n[model_providers.other]\nname="Other"\n');
    const target = applyConfig(store, 'codex', 19191, root, join(root, 'backups'), root);
    const value = parseToml(readFileSync(target, 'utf8')) as any;
    expect(value.mcp_servers.keep.command).toBe('keep');
    expect(value.model_providers.other.name).toBe('Other');
    expect(value.model_provider).toBe('modeldock');
    expect(readFileSync(join(root, '.codex', 'auth.json'), 'utf8')).toBe('keep-auth');
    const catalog = JSON.parse(readFileSync(join(root, '.codex', 'modeldock-models.json'), 'utf8'));
    expect(catalog.models[0].shell_type).toBe('unified_exec');
    expect(catalog.models[0].base_instructions).toBeTruthy();
    expect(catalog.models[0].truncation_policy).toEqual({ mode: 'tokens', limit: 10000 });
  });
  it('refuses malformed existing configuration without changing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(join(root, 'Code', 'User'), { recursive: true });
    writeFileSync(target, '{invalid');
    expect(() => applyConfig(store, 'vscode', 19191, root, join(root, 'backups'), root)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{invalid');
  });
  it('merges OpenCode JSONC preserving other providers and MCP settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, '.config', 'opencode', 'opencode.jsonc');
    mkdirSync(join(root, '.config', 'opencode'), { recursive: true });
    writeFileSync(target, '{\n// retain me\n"provider":{"other":{"npm":"other-sdk"}},"mcp":{"keep":{"command":["keep"]}}\n}');
    applyConfig(store, 'opencode', 19191, root, join(root, 'backups'), root);
    const content = readFileSync(target, 'utf8'); const data = parseJsonc(content);
    expect(content).toContain('retain me');
    expect(data.provider.other.npm).toBe('other-sdk');
    expect(data.mcp.keep.command).toEqual(['keep']);
    expect(data.provider.modeldock.models['dock-model'].provider.npm).toBe('@ai-sdk/openai');
    expect(data.model).toBe('modeldock/dock-model');
  });
  it('exports direct API connections with real upstream IDs and exposes keys only on explicit export/apply', () => {
    const provider: Provider = { id: 'provider-one', name: 'Direct API', kind: 'openai-compatible', baseUrl: 'https://upstream.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
    const direct = { ...store, listProviders: () => [provider], getProvider: () => provider,
      getSecret: () => ({ apiKey: 'upstream-private-test-key' }),
      listBindings: () => store.listBindings().map(binding => ({ ...binding, mode: 'direct' as const, providerIds: [provider.id], modelIds: [] })),
    };
    const preview = buildConfig(direct, 'opencode', 19191);
    expect(preview.content).toContain('https://upstream.test/v1');
    expect(preview.content).toContain('upstream-model');
    expect(preview.content).not.toContain('dock-model');
    expect(preview.content).not.toContain('upstream-private-test-key');
    expect(buildConfig(direct, 'opencode', 19191, true).content).toContain('upstream-private-test-key');
    expect(connectionKey(direct, 'dsh')).toBe('upstream-private-test-key');
    const codex = parseToml(buildConfig(direct, 'codex', 19191).content) as any;
    expect(codex.model).toBe('upstream-model');
    expect(codex.model_providers.modeldock.base_url).toBe('https://upstream.test/v1');
  });
  it('keeps subscription direct mode behind the single-source local gateway without exporting OAuth tokens', () => {
    const provider: Provider = { id: 'provider-one', name: 'Codex Sub', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
    const direct = { ...store, listProviders: () => [provider], getProvider: () => provider,
      getSecret: () => ({ accessToken: 'never-export-oauth', refreshToken: 'never-export-refresh' }),
      listBindings: () => store.listBindings().map(binding => ({ ...binding, mode: 'direct' as const, providerIds: [provider.id], modelIds: [] })),
    };
    const output = buildConfig(direct, 'copilot', 19191, true);
    expect(output.content).toContain('/tool/copilot/v1');
    expect(output.content).not.toContain('never-export');
    expect(output.instructions).toContain('订阅单源');
    expect(connectionKey(direct, 'dsh')).toBe('local-test-secret');
  });

  it('exports plan-qualified display names while preserving distinct aggregate route IDs in every client', () => {
    const providers: Provider[] = [
      { id: 'provider-a', name: '火山 Agent Plan', kind: 'openai-compatible', baseUrl: 'https://agent.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
      { id: 'provider-b', name: '火山 Coding Plan', kind: 'openai-compatible', baseUrl: 'https://coding.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
    ];
    const catalog: Model[] = providers.map((provider, index) => ({ ...models[0], id: `model-${index}`, providerId: provider.id, upstreamId: 'glm-5.3', alias: index === 0 ? 'glm-5.3' : `${provider.id}/glm-5.3`, displayName: 'glm-5.3' }));
    const original = structuredClone(catalog);
    const aggregated = { ...store, listModels: () => catalog, listProviders: () => providers,
      getProvider: (id: string) => providers.find(provider => provider.id === id),
      listBindings: () => store.listBindings().map(binding => ({ ...binding, mode: 'aggregate' as const, providerIds: providers.map(provider => provider.id), modelIds: [], defaultModelId: catalog[1].id })),
    };
    const expected = catalog.map((model, index) => ({ id: model.alias, name: `${providers[index].name} - glm-5.3` }));
    expect(JSON.parse(buildConfig(aggregated, 'vscode', 19191).content)[0].models).toMatchObject(expected);
    expect(dshProviders(buildConfig(aggregated, 'dsh', 19191).content).modeldock.models).toMatchObject(expected);
    expect(JSON.parse(buildConfig(aggregated, 'copilot', 19191).content).providers[0].models).toMatchObject(expected.map(model => ({ modelId: model.id, wireModel: model.id, displayName: model.name })));
    const opencode = JSON.parse(buildConfig(aggregated, 'opencode', 19191).content);
    expect(opencode.model).toBe('modeldock/provider-b/glm-5.3');
    expect(Object.keys(opencode.provider.modeldock.models)).toEqual(catalog.map(model => model.alias));
    for (const model of expected) expect(opencode.provider.modeldock.models[model.id].name).toBe(model.name);
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = applyConfig(aggregated, 'codex', 19191, root, join(root, 'backups'), root);
    expect((parseToml(readFileSync(target, 'utf8')) as any).model).toBe(catalog[1].alias);
    const companion = JSON.parse(readFileSync(join(root, '.codex', 'modeldock-models.json'), 'utf8')).models;
    expect(companion).toMatchObject(expected.map(model => ({ slug: model.id, display_name: model.name })));
    expect(catalog).toEqual(original);
  });

  it('exports a single plan directly using the upstream ID and a qualified display name, without leaking aggregate IDs', () => {
    const providers: Provider[] = [
      { id: 'provider-a', name: '火山 Agent Plan', kind: 'openai-compatible', baseUrl: 'https://agent.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
      { id: 'provider-b', name: '火山 Coding Plan', kind: 'openai-compatible', baseUrl: 'https://coding.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
    ];
    const catalog: Model[] = providers.map((provider, index) => ({ ...models[0], id: `model-${index}`, providerId: provider.id, upstreamId: 'glm-5.3', alias: index === 0 ? 'glm-5.3' : `${provider.id}/glm-5.3`, displayName: 'glm-5.3' }));
    const direct = { ...store, listModels: () => catalog, listProviders: () => providers,
      getProvider: (id: string) => providers.find(provider => provider.id === id), getSecret: () => ({ apiKey: 'synthetic-only' }),
      listBindings: () => store.listBindings().map(binding => ({ ...binding, mode: 'direct' as const, providerIds: [providers[1].id], modelIds: [], defaultModelId: catalog[1].id })),
    };
    const expected = [{ id: 'glm-5.3', name: '火山 Coding Plan - glm-5.3' }];
    expect(JSON.parse(buildConfig(direct, 'vscode', 19191).content)[0].models).toMatchObject(expected);
    expect(dshProviders(buildConfig(direct, 'dsh', 19191).content).modeldock.models).toMatchObject(expected);
    expect(JSON.parse(buildConfig(direct, 'copilot', 19191).content).providers[0].models).toMatchObject(expected.map(model => ({ modelId: model.id, wireModel: model.id, displayName: model.name })));
    const opencode = JSON.parse(buildConfig(direct, 'opencode', 19191).content);
    expect(opencode.model).toBe('modeldock/glm-5.3');
    expect(Object.keys(opencode.provider.modeldock.models)).toEqual(['glm-5.3']);
    expect(opencode.provider.modeldock.models['glm-5.3'].name).toBe(expected[0].name);
    for (const tool of ['vscode', 'dsh', 'copilot', 'opencode', 'codex'] as const) {
      const preview = buildConfig(direct, tool, 19191);
      expect(preview.content).toContain('https://coding.test/v1');
      expect(preview.content).not.toContain(catalog[1].alias);
      expect(preview.content).not.toContain('synthetic-only');
    }
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = applyConfig(direct, 'codex', 19191, root, join(root, 'backups'), root);
    expect((parseToml(readFileSync(target, 'utf8')) as any).model).toBe('glm-5.3');
    const companion = JSON.parse(readFileSync(join(root, '.codex', 'modeldock-models.json'), 'utf8')).models;
    expect(companion).toMatchObject([{ slug: 'glm-5.3', display_name: expected[0].name }]);
  });
  it('uses VS Code Custom Endpoint groups for separate API sources and a locally managed subscription without reading preview secrets', () => {
    const native = nativeFixture();
    const preview = buildConfig(native, 'vscode', 19191);
    const rows = JSON.parse(preview.content);
    expect(rows).toHaveLength(3); expect(rows.every((row: any) => row.vendor === 'customendpoint')).toBe(true);
    expect(rows[0]).toMatchObject({ name: 'ModelDock · API 套餐 A', apiKey: '__PROVIDER_API_KEY__', models: [{ id: 'shared-upstream', name: 'API 套餐 A - 同名模型', apiType: 'responses', url: 'https://api-a.test/v1/responses', toolCalling: true, vision: false, contextWindow: 64000, maxOutputTokens: 16000 }] });
    expect(rows[1].models[0]).toMatchObject({ id: 'shared-upstream', url: 'https://api-b.test/coding/v3/responses', name: 'API 套餐 B - 同名模型' });
    expect(rows[2]).toMatchObject({ apiKey: '__MODELDOCK_LOCAL_KEY__', models: [{ id: 'subscription/shared-upstream', url: 'http://127.0.0.1:19191/tool/vscode/v1/responses' }] });
    expect(native.getSecret).not.toHaveBeenCalled();
    // VS Code 忽略 chatLanguageModels.json 里的明文 apiKey（按秘密存储引用解析为空），凭据必须经 requestHeaders 携带。
    expect(rows.map((row: any) => row.models[0].requestHeaders)).toEqual([
      { authorization: 'Bearer __PROVIDER_API_KEY__' }, { authorization: 'Bearer __PROVIDER_API_KEY__' }, { authorization: 'Bearer __MODELDOCK_LOCAL_KEY__' },
    ]);
    const revealed = JSON.parse(buildConfig(native, 'vscode', 19191, true).content);
    expect(revealed.map((row: any) => row.apiKey)).toEqual(['SYNTHETIC_KEY_provider-a', 'SYNTHETIC_KEY_provider-b', 'local-test-secret']);
    expect(revealed.map((row: any) => row.models[0].requestHeaders)).toEqual([
      { authorization: 'Bearer SYNTHETIC_KEY_provider-a' }, { authorization: 'Bearer SYNTHETIC_KEY_provider-b' }, { authorization: 'Bearer local-test-secret' },
    ]);
    expect(native.getSecret.mock.calls.map(([id]) => id)).toEqual(['provider-a', 'provider-b']);
    expect(JSON.stringify(revealed)).not.toMatch(/PRIVATE_OAUTH|accessToken|refreshToken/);
    expect(() => connectionKey(native, 'vscode')).toThrow('没有共用的单一连接密钥');
  });
  it('uses distinct OpenCode namespaces for same upstream IDs, independent API keys, protocol SDKs and selected default', () => {
    const native = nativeFixture(); native.catalog[0].wireApi = 'chat-completions';
    const preview = JSON.parse(buildConfig(native, 'opencode', 19191).content);
    expect(Object.keys(preview.provider)).toEqual(['modeldock-provider-a', 'modeldock-provider-b', 'modeldock-subscription']);
    expect(preview.model).toBe('modeldock-provider-b/shared-upstream');
    expect(preview.provider['modeldock-provider-a']).toMatchObject({ npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api-a.test/v1', apiKey: '__PROVIDER_API_KEY__' }, models: { 'shared-upstream': { provider: { npm: '@ai-sdk/openai-compatible' } } } });
    expect(preview.provider['modeldock-provider-b']).toMatchObject({ npm: '@ai-sdk/openai', options: { baseURL: 'https://api-b.test/coding/v3' }, models: { 'shared-upstream': { provider: { npm: '@ai-sdk/openai' } } } });
    expect(preview.provider['modeldock-subscription']).toMatchObject({ options: { baseURL: 'http://127.0.0.1:19191/tool/opencode/v1', apiKey: '__MODELDOCK_LOCAL_KEY__' }, models: { 'subscription/shared-upstream': { name: 'Codex 订阅 - 同名模型' } } });
    expect(native.getSecret).not.toHaveBeenCalled();
    const revealed = JSON.parse(buildConfig(native, 'opencode', 19191, true).content);
    expect(revealed.provider['modeldock-provider-a'].options.apiKey).toBe('SYNTHETIC_KEY_provider-a'); expect(revealed.provider['modeldock-provider-b'].options.apiKey).toBe('SYNTHETIC_KEY_provider-b');
    expect(JSON.stringify(revealed)).not.toContain('PRIVATE_OAUTH');
  });
  it('prepares native DSH and Copilot sources with independent keys and subscription tokens kept local', () => {
    const native = nativeFixture();
    const dsh = buildConfig(native, 'dsh', 19191), copilot = buildConfig(native, 'copilot', 19191, true);
    expect(dsh.canApply).toBe(true); expect(copilot.canApply).toBe(true);
    const dshGroups = Object.values(dshProviders(dsh.content)) as any[];
    expect(dshGroups.map(group => group.baseURL)).toEqual(['https://api-a.test/v1', 'https://api-b.test/coding/v3', 'http://127.0.0.1:19191/tool/dsh/v1']);
    expect(new Set(dshGroups.map(group => group.apiKeyEnv)).size).toBe(3);
    expect(dsh.content).not.toMatch(/SYNTHETIC_KEY|PRIVATE_OAUTH|local-test-secret/);
    const desktop = JSON.parse(copilot.content); expect(desktop.providers).toHaveLength(3);
    expect(desktop.providers.map((group: any) => group.apiKey)).toEqual(['SYNTHETIC_KEY_provider-a', 'SYNTHETIC_KEY_provider-b', 'local-test-secret']);
    expect(desktop.providers.every((group: any) => group.models.length === 1)).toBe(true);
    expect(desktop.providers.map((group: any) => group.models[0].wireModel)).toEqual(['shared-upstream', 'shared-upstream', 'subscription/shared-upstream']);
    expect(JSON.stringify(desktop)).not.toContain('PRIVATE_OAUTH');
    expect(copilot.content).not.toContain('PRIVATE_OAUTH');
  });
  it('applies all VS Code groups with backups, retaining JSONC and foreign same-name vendors, then removes only managed groups on empty selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(dirname(target), { recursive: true });
    const foreign = { name: 'ModelDock', vendor: 'openai', apiKey: 'SYNTHETIC_FOREIGN', models: [] };
    const original = '[\n// keep unmanaged comment\n' + JSON.stringify(foreign) + ',\n' + JSON.stringify({ name: 'Other', vendor: 'customendpoint', models: [] }) + ',\n' + JSON.stringify({ name: 'ModelDock', vendor: 'customendpoint', models: [{ id: 'stale' }] }) + '\n]';
    writeFileSync(target, original);
    const native = nativeFixture();
    applyConfig(native, 'vscode', 19191, root, join(root, 'backups'), root);
    applyConfig(native, 'vscode', 19191, root, join(root, 'backups'), root);
    const configuredText = readFileSync(target, 'utf8'), configured = parseJsonc(configuredText);
    expect(configuredText).toContain('keep unmanaged comment'); expect(configured[0]).toEqual(foreign); expect(configured).toHaveLength(5);
    expect(configured.filter((row: any) => row.name.startsWith('ModelDock · '))).toHaveLength(3);
    expect(configuredText).not.toContain('PRIVATE_OAUTH');
    expect(readdirSync(join(root, 'backups')).map(file => readFileSync(join(root, 'backups', file), 'utf8'))).toContain(original);
    applyConfig(nativeFixture([]), 'vscode', 19191, root, join(root, 'backups'), root);
    expect(parseJsonc(readFileSync(target, 'utf8'))).toEqual([foreign, { name: 'Other', vendor: 'customendpoint', models: [] }]);
  });
  it.each(['selected', undefined] as const)('synchronizes only the selected VS Code custom sources for scope %s with full original backup and preserves other vendors/comments', scope => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(dirname(target), { recursive: true });
    const foreign = { name: 'ModelDock', vendor: 'openai', models: [{ id: 'shared-upstream', name: 'Unrelated native model' }] };
    const legacy = [{ name: 'API 套餐 A', vendor: 'customendpoint', models: [{ id: 'shared-upstream', url: 'https://api-a.test/v1/responses' }] }, { name: '千问 Token Plan', vendor: 'customendpoint', models: [{ id: 'shared-upstream', url: 'https://qwen-legacy.test/v1/chat/completions' }] }, { name: 'Unknown custom source', vendor: 'customendpoint', models: [{ id: 'other', url: 'https://third-party.test/v1/responses' }] }];
    const original = '[\n// old custom model note stays\n' + [...legacy, foreign].map(row => JSON.stringify(row)).join(',\n') + '\n]'; writeFileSync(target, original);
    const native = nativeFixture(['provider-b']);
    const configured = { ...native, listBindings: () => native.listBindings().map(binding => binding.id === 'vscode' ? { ...binding, vscodeSyncScope: scope } : binding) };
    expect(buildConfig(configured, 'vscode', 19191).instructions).toContain('所有 customendpoint 分组');
    applyConfig(configured, 'vscode', 19191, root, join(root, 'backups'), root);
    const text = readFileSync(target, 'utf8'), values = parseJsonc(text);
    expect(values).toHaveLength(2); expect(values[0]).toEqual(foreign);
    expect(values[1]).toMatchObject({ vendor: 'customendpoint', name: 'ModelDock · API 套餐 B', models: [{ id: 'shared-upstream', url: 'https://api-b.test/coding/v3/responses' }] });
    expect(text).toContain('// old custom model note stays');
    expect(readdirSync(join(root, 'backups')).map(file => readFileSync(join(root, 'backups', file), 'utf8'))).toContain(original);
    const empty = { ...configured, listBindings: () => nativeFixture([]).listBindings().map(binding => binding.id === 'vscode' ? { ...binding, vscodeSyncScope: scope } : binding) };
    applyConfig(empty, 'vscode', 19191, root, join(root, 'backups'), root);
    expect(parseJsonc(readFileSync(target, 'utf8'))).toEqual([foreign]); expect(readFileSync(target, 'utf8')).toContain('// old custom model note stays');
  });
  it('keeps all unrelated custom endpoints under explicit managed scope and does not modify files for invalid scope or malformed source', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(dirname(target), { recursive: true });
    const legacy = { name: '千问 Token Plan', vendor: 'customendpoint', models: [{ id: 'shared-upstream', url: 'https://qwen-legacy.test/v1/chat/completions' }] };
    const native = nativeFixture(['provider-b']); writeFileSync(target, '[\n// keep external custom source\n' + JSON.stringify(legacy) + '\n]');
    expect(buildConfig(native, 'vscode', 19191).instructions).toContain('仅替换 ModelDock');
    applyConfig(native, 'vscode', 19191, root, join(root, 'backups'), root);
    expect(parseJsonc(readFileSync(target, 'utf8'))[0]).toEqual(legacy);
    const before = readFileSync(target, 'utf8');
    const invalid = { ...native, listBindings: () => native.listBindings().map(binding => binding.id === 'vscode' ? { ...binding, vscodeSyncScope: 'invalid' as any } : binding) };
    expect(() => applyConfig(invalid, 'vscode', 19191, root, join(root, 'backups'), root)).toThrow('同步范围无效'); expect(readFileSync(target, 'utf8')).toBe(before);
    writeFileSync(target, '{bad JSONC');
    const selected = { ...native, listBindings: () => native.listBindings().map(binding => binding.id === 'vscode' ? { ...binding, vscodeSyncScope: 'selected' as const } : binding) };
    expect(() => applyConfig(selected, 'vscode', 19191, root, join(root, 'backups'), root)).toThrow('文件格式有误'); expect(readFileSync(target, 'utf8')).toBe('{bad JSONC');
  });
  it('merges OpenCode groups preserving foreign models/MCP/comments and clears stale managed namespaces plus a dangling managed default on empty selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, '.config', 'opencode', 'opencode.jsonc'); mkdirSync(dirname(target), { recursive: true });
    const original = '{\n// keep unmanaged graph\n"model":"other/foreign","provider":{"other":{"name":"Foreign","models":{"foreign":{}}},"modeldock":{"name":"Old","models":{"stale":{}}},"modeldock-removed":{"models":{"gone":{}}}},"mcp":{"keep":{"command":["keep"]}}\n}';
    writeFileSync(target, original);
    applyConfig(nativeFixture(), 'opencode', 19191, root, join(root, 'backups'), root);
    const configured = parseJsonc(readFileSync(target, 'utf8'));
    expect(configured.provider.other).toEqual({ name: 'Foreign', models: { foreign: {} } }); expect(configured.mcp.keep.command).toEqual(['keep']);
    expect(configured.provider.modeldock).toBeUndefined(); expect(configured.provider['modeldock-removed']).toBeUndefined();
    expect(configured.model).toBe('modeldock-provider-b/shared-upstream');
    expect(readFileSync(target, 'utf8')).toContain('keep unmanaged graph');
    applyConfig(nativeFixture([]), 'opencode', 19191, root, join(root, 'backups'), root);
    const cleared = parseJsonc(readFileSync(target, 'utf8'));
    expect(cleared.provider).toEqual({ other: { name: 'Foreign', models: { foreign: {} } } }); expect(cleared).not.toHaveProperty('model'); expect(cleared.mcp.keep.command).toEqual(['keep']);
    expect(readdirSync(join(root, 'backups')).map(file => readFileSync(join(root, 'backups', file), 'utf8'))).toContain(original);
    writeFileSync(target, original);
    applyConfig(nativeFixture([]), 'opencode', 19191, root, join(root, 'backups'), root);
    expect(parseJsonc(readFileSync(target, 'utf8')).model).toBe('other/foreign');
  });
  it('preserves the native smoke fixture first-model comment and all JSONC notes across multi-source apply, reselect and clear', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, '.config', 'opencode', 'opencode.json'); mkdirSync(dirname(target), { recursive: true });
    const foreign = { name: 'Foreign Provider', npm: 'foreign-sdk', models: { foreign: { name: 'Foreign Model' } } };
    const mcp = { fixture: { type: 'local', command: ['synthetic-mcp-fixture'], enabled: false } };
    const comments = [
      '// foreign-opencode-comment must survive managed source updates',
      '/* keep inline model note */', '/* keep provider explanation */',
      '// keep repeated note', '// keep repeated note', '/* keep multiline\n   explanation */', '// keep mcp note',
    ];
    const original = `{
  ${comments[0]}
  "model":"foreign/foreign", ${comments[1]}
  ${comments[2]}
  "provider":{
    ${comments[3]}
    "foreign":${JSON.stringify(foreign)},
    ${comments[4]}
    "modeldock":{"name":"ModelDock","models":{}}
  },
  ${comments[5]}
  "mcp":${JSON.stringify(mcp)} ${comments[6]}
}`;
    writeFileSync(target, original);
    for (const ids of [['provider-a', 'provider-b'], ['provider-b'], []]) {
      applyConfig(nativeFixture(ids), 'opencode', 19191, root, join(root, 'backups'), root);
      const text = readFileSync(target, 'utf8'), errors: ParseError[] = [];
      const value = parseJsonc(text, errors, { allowTrailingComma: true }); expect(errors).toEqual([]);
      expect(value.provider.foreign).toEqual(foreign); expect(value.mcp).toEqual(mcp);
      for (const comment of new Set(comments)) expect(text.split(comment).length - 1).toBe(comments.filter(expected => expected === comment).length);
      if (!ids.length) { expect(value.model).toBeUndefined(); expect(Object.keys(value.provider)).toEqual(['foreign']); }
    }
    expect(readdirSync(join(root, 'backups')).map(file => readFileSync(join(root, 'backups', file), 'utf8'))).toContain(original);
  });
  it('retains leading and inline VS Code array comments while removing managed rows and leaves comment-like string values intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(dirname(target), { recursive: true });
    const foreign = { name: 'https://foreign.example/*not a comment*/', vendor: 'openai', models: [] };
    writeFileSync(target, `[
// keep first-array note
{"name":"ModelDock","vendor":"customendpoint","models":[]}, /* keep middle-array note */
${JSON.stringify(foreign)} // keep final-array note
]`);
    for (const ids of [['provider-a', 'provider-b'], ['provider-a'], []]) {
      applyConfig(nativeFixture(ids), 'vscode', 19191, root, join(root, 'backups'), root);
      const text = readFileSync(target, 'utf8'), errors: ParseError[] = [];
      const value = parseJsonc(text, errors, { allowTrailingComma: true }); expect(errors).toEqual([]);
      expect(value[0]).toEqual(foreign); expect(text).toContain('// keep first-array note'); expect(text).toContain('/* keep middle-array note */'); expect(text).toContain('// keep final-array note');
      expect(text.split('/*not a comment*/').length - 1).toBe(1);
    }
  });
  it('publishes single-API Codex auto models as upstream IDs and aggregates multiple sources while clearing legacy owned overrides on empty selection', () => {
    const single = nativeFixture(['provider-b']);
    expect(parseToml(buildConfig(single, 'codex', 19191).content).model).toBe('shared-upstream');
    expect(buildConfig(single, 'codex', 19191).content).toContain('https://api-b.test/coding/v3');
    expect(connectionKey(single, 'codex')).toBe('SYNTHETIC_KEY_provider-b');
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root);
    applyConfig(single, 'codex', 19191, root, join(root, 'backups'), root);
    expect(JSON.parse(readFileSync(join(root, '.codex', 'modeldock-models.json'), 'utf8')).models[0].slug).toBe('shared-upstream');
    const multi = nativeFixture();
    expect(buildConfig(multi, 'codex', 19191).content).toContain('http://127.0.0.1:19191/tool/codex/v1'); expect(connectionKey(multi, 'codex')).toBe('local-test-secret');
    applyConfig(nativeFixture([]), 'codex', 19191, root, join(root, 'backups'), root);
    const cleared = parseToml(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'));
    expect(cleared).not.toHaveProperty('model_provider'); expect(cleared).not.toHaveProperty('model'); expect(cleared).not.toHaveProperty('model_catalog_json');
    expect(existsSync(join(root, '.codex', 'modeldock-models.json'))).toBe(false);
  });
  it('preserves pre-ModelDock Codex selection in managed state across repeated applies and restores it on uncheck-all without touching auth/MCP/foreign providers', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root); mkdirSync(join(root, '.codex'));
    const target = join(root, '.codex', 'config.toml'), auth = join(root, '.codex', 'auth.json');
    const original = 'model="foreign-model"\nmodel_provider="foreign"\nmodel_catalog_json="foreign-catalog.json"\n[mcp_servers.keep]\ncommand="keep"\n[model_providers.foreign]\nname="Foreign"\n';
    writeFileSync(target, original); writeFileSync(auth, 'keep-auth');
    const state = new Map<string, unknown>();
    const managed = { ...nativeFixture(), getManagedState: <T>(key: string, fallback: T): T => structuredClone(state.has(key) ? state.get(key) as T : fallback), setManagedState: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    applyConfig(managed, 'codex', 19191, root, join(root, 'backups'), root);
    applyConfig(managed, 'codex', 19191, root, join(root, 'backups'), root);
    expect([...state.values()]).toMatchObject([{ version: 1, target, fields: { model: 'foreign-model', model_provider: 'foreign', model_catalog_json: 'foreign-catalog.json' } }]);
    expect(JSON.stringify([...state.values()])).not.toMatch(/SYNTHETIC_KEY|local-test-secret|PRIVATE_OAUTH|bearer/);
    const empty = { ...managed, listBindings: () => nativeFixture([]).listBindings() };
    applyConfig(empty, 'codex', 19191, root, join(root, 'backups'), root);
    const cleared = parseToml(readFileSync(target, 'utf8')) as any;
    expect(cleared).toMatchObject({ model: 'foreign-model', model_provider: 'foreign', model_catalog_json: 'foreign-catalog.json', mcp_servers: { keep: { command: 'keep' } }, model_providers: { foreign: { name: 'Foreign' } } });
    expect(cleared.model_providers.modeldock).toBeUndefined(); expect(readFileSync(auth, 'utf8')).toBe('keep-auth');
    expect(existsSync(join(root, '.codex', 'modeldock-models.json'))).toBe(false); expect([...state.values()]).toEqual([null]);
    expect(readdirSync(join(root, 'backups')).map(file => readFileSync(join(root, 'backups', file), 'utf8'))).toContain(original);
  });
  it('keeps a user-changed Codex provider/model/catalog when removing ModelDock and preserves a foreign catalog sharing its filename', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root); mkdirSync(join(root, '.codex'));
    const target = join(root, '.codex', 'config.toml');
    writeFileSync(target, 'model="original"\nmodel_provider="original-provider"\n');
    const state = new Map<string, unknown>();
    const managed = { ...nativeFixture(), getManagedState: <T>(key: string, fallback: T): T => structuredClone(state.has(key) ? state.get(key) as T : fallback), setManagedState: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    applyConfig(managed, 'codex', 19191, root, join(root, 'backups'), root);
    writeFileSync(target, 'model="new-user-model"\nmodel_provider="new-user-provider"\nmodel_catalog_json="new-user-catalog.json"\n[model_providers.modeldock]\nname="ModelDock"\n[model_providers.new-user-provider]\nname="User"\n');
    const catalogPath = join(root, '.codex', 'modeldock-models.json'), foreignCatalog = '{"models":[{"slug":"foreign","description":"Owned elsewhere"}]}';
    writeFileSync(catalogPath, foreignCatalog);
    applyConfig({ ...managed, listBindings: () => nativeFixture([]).listBindings() }, 'codex', 19191, root, join(root, 'backups'), root);
    const cleared = parseToml(readFileSync(target, 'utf8')) as any;
    expect(cleared).toMatchObject({ model: 'new-user-model', model_provider: 'new-user-provider', model_catalog_json: 'new-user-catalog.json' });
    expect(cleared.model_providers['new-user-provider'].name).toBe('User'); expect(cleared.model_providers.modeldock).toBeUndefined(); expect(readFileSync(catalogPath, 'utf8')).toBe(foreignCatalog);
  });
  it('does not change Codex files if capturing restore provenance fails and refuses corrupted restore records', () => {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-adapter-')); roots.push(root); mkdirSync(join(root, '.codex'));
    const target = join(root, '.codex', 'config.toml'), original = 'model="foreign"\nmodel_provider="foreign-provider"\n'; writeFileSync(target, original);
    const failing = { ...nativeFixture(), getManagedState: <T>(_key: string, fallback: T) => fallback, setManagedState: () => { throw new Error('synthetic storage failure'); } };
    expect(() => applyConfig(failing, 'codex', 19191, root, join(root, 'backups'), root)).toThrow('synthetic storage');
    expect(readFileSync(target, 'utf8')).toBe(original); expect(existsSync(join(root, '.codex', 'modeldock-models.json'))).toBe(false);
    const corrupt = { ...nativeFixture([]), getManagedState: <T>() => ({ version: 1, target, fields: [] }) as T };
    expect(() => applyConfig(corrupt, 'codex', 19191, root, join(root, 'backups'), root)).toThrow('恢复记录无效'); expect(readFileSync(target, 'utf8')).toBe(original);
  });
  it('splits mixed DSH protocols and configures Copilot per-model protocol in one native source', () => {
    const native = nativeFixture(['provider-a']);
    native.catalog.push({ ...native.catalog[0], id: 'mixed-chat', upstreamId: 'chat-upstream', alias: 'chat-upstream', wireApi: 'chat-completions' });
    const profiles = dshProviders(buildConfig(native, 'dsh', 19191).content);
    expect(Object.keys(profiles)).toEqual(['modeldock-provider-a-responses', 'modeldock-provider-a-chat-completions']);
    expect(profiles['modeldock-provider-a-responses'].api).toBe('openai-responses'); expect(profiles['modeldock-provider-a-chat-completions'].api).toBe('openai-completions');
    expect(profiles['modeldock-provider-a-responses'].apiKeyEnv).toBe(profiles['modeldock-provider-a-chat-completions'].apiKeyEnv);
    expect(profiles['modeldock-provider-a-responses'].models[0]).not.toHaveProperty('api');
    const config = buildConfig(native, 'copilot', 19191), manifest = JSON.parse(config.content);
    expect(config.instructions).toContain('原生接口'); expect(config.instructions).toContain('系统凭据存储');
    expect(config.canApply).toBe(true); expect(manifest.providers).toHaveLength(1);
    expect(manifest.providers[0].models).toMatchObject([{ modelId: 'shared-upstream', wireModel: 'shared-upstream', wireApi: 'responses' }, { modelId: 'chat-upstream', wireModel: 'chat-upstream', wireApi: 'chat' }]);
    expect(manifest).not.toHaveProperty('sessionExamples');
  });
  it('builds native DSH default-model references, separates credentials and keeps subscription tokens local', () => {
    const native = nativeFixture(); native.catalog[0].wireApi = 'chat-completions';
    const preview = buildDshPlan(native, 19191);
    expect(preview.defaultModel).toEqual({ provider: 'modeldock-provider-b', model: 'shared-upstream' });
    expect(Object.values(preview.providers).map(group => group.apiKeyEnv)).toEqual(Object.keys(preview.credentials));
    expect(Object.values(preview.credentials)).toEqual(['__PROVIDER_API_KEY__', '__PROVIDER_API_KEY__', '__MODELDOCK_LOCAL_KEY__']);
    expect(native.getSecret).not.toHaveBeenCalled();
    const applied = buildDshPlan(native, 19191, true);
    expect(Object.values(applied.credentials)).toEqual(['SYNTHETIC_KEY_provider-a', 'SYNTHETIC_KEY_provider-b', 'local-test-secret']);
    expect(JSON.stringify(applied)).not.toMatch(/PRIVATE_OAUTH|accessToken|refreshToken/);
    const rows = parseYaml(buildConfig(native, 'dsh', 19191, true).content);
    expect(rows.map((row: any) => row.id)).toEqual(['llm-pi-ai', 'agent-default-model', 'llm-deepseek', 'llm-deepseek-account']);
    expect(rows.slice(2).every((row: any) => row.disabled === true)).toBe(true);
    expect(rows[1].config).toEqual(applied.defaultModel);
    expect(JSON.stringify(rows)).not.toMatch(/SYNTHETIC_KEY|local-test-secret/);
    const root = mkdtempSync(join(tmpdir(), 'modeldock-dsh-adapter-')); roots.push(root);
    expect(() => applyConfig(native, 'dsh', 19191, root, join(root, 'backups'), root)).toThrow('原生插件');
    expect(existsSync(join(root, '.codex'))).toBe(false);
  });
  it('allows clearing DSH and deduplicates an upstream ID within each native protocol', () => {
    const native = nativeFixture(['provider-a']);
    native.catalog.push({ ...native.catalog[0], id: 'duplicate-alias', alias: 'another-local-name' });
    const plan = buildDshPlan(native, 19191, true);
    expect(plan.providers['modeldock-provider-a'].models).toHaveLength(1);
    expect(buildDshPlan(nativeFixture([]), 19191, true)).toEqual({ syncScope: 'selected', providers: {}, credentials: {} });
    expect(parseYaml(buildConfig(nativeFixture([]), 'dsh', 19191).content)).toEqual([
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: false, config: { providers: {} } }, { id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true },
    ]);
  });
  it('keeps an explicit managed DSH scope and rejects invalid synchronization scope without reading keys', () => {
    const native = nativeFixture(['provider-a']);
    const managed = { ...native, listBindings: () => native.listBindings().map(binding => ({ ...binding, ...(binding.id === 'dsh' ? { dshSyncScope: 'managed' as const } : {}) })) };
    expect(buildDshPlan(managed, 19191).syncScope).toBe('managed');
    expect(parseYaml(buildConfig(managed, 'dsh', 19191).content).map((row: any) => row.id)).toEqual(['llm-pi-ai', 'agent-default-model']);
    expect(buildConfig(managed, 'dsh', 19191).instructions).toContain('保留 DSH 原有模型来源');
    const invalid = { ...native, listBindings: () => native.listBindings().map(binding => ({ ...binding, ...(binding.id === 'dsh' ? { dshSyncScope: 'invalid' } : {}) })) };
    expect(() => buildDshPlan(invalid as any, 19191, true)).toThrow('同步范围无效');
    expect(native.getSecret).not.toHaveBeenCalled();
  });
  it('builds legacy dispatch only for exact raw models at the official DeepSeek API, never for similar names or other plans', () => {
    const native = nativeFixture(['provider-a']); native.providers[0].baseUrl = 'https://api.deepseek.com'; native.catalog[0].upstreamId = 'deepseek-flash';
    const configured = buildDshPlan(native, 19191);
    expect(configured.legacyDispatch?.mappings).toEqual([
      { legacyProvider: 'deepseek-official', model: 'deepseek-flash', targetProvider: 'modeldock-provider-a', targetModel: 'deepseek-flash' },
      { legacyProvider: 'deepseek-account', model: 'deepseek-flash', targetProvider: 'modeldock-provider-a', targetModel: 'deepseek-flash' },
    ]);
    expect(JSON.stringify(configured.legacyDispatch)).not.toMatch(/SYNTHETIC|PRIVATE|Key|Token/);
    for (const url of ['https://api.deepseek.com.evil.test', 'http://api.deepseek.com', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'https://api.deepseek.com/not-an-official-api-path']) {
      native.providers[0].baseUrl = url; expect(buildDshPlan(native, 19191).legacyDispatch).toBeUndefined();
    }
    native.providers[0].baseUrl = 'https://api.deepseek.com/v1/';
    const managed = { ...native, listBindings: () => native.listBindings().map(binding => ({ ...binding, dshSyncScope: 'managed' as const })) };
    expect(buildDshPlan(managed, 19191).legacyDispatch).toBeUndefined();
  });
  it('keeps native Copilot IDs stable across renames and key rotation, namespacing profiles and allowing duplicate upstream IDs as separate aliases', () => {
    const native = { ...nativeFixture(['provider-a']), dataDir: 'C:/fixtures/modeldock-a' };
    native.catalog.push({ ...native.catalog[0], id: 'variant', alias: 'variant-alias' });
    const before = buildCopilotDesktopPlan(native, 19191, true);
    native.providers[0].name = 'Renamed'; native.catalog[0].displayName = 'Renamed model';
    const after = buildCopilotDesktopPlan({ ...native, getSecret: () => ({ apiKey: 'ROTATED_SYNTHETIC_KEY' }) }, 19191, true);
    expect(after.providers[0].id).toBe(before.providers[0].id);
    expect(after.providers[0].models.map(model => model.id)).toEqual(before.providers[0].models.map(model => model.id));
    expect(before.providers[0].models.map(model => model.modelId)).toEqual(['shared-upstream', 'variant-alias']);
    expect(before.providers[0].models.map(model => model.wireModel)).toEqual(['shared-upstream', 'shared-upstream']);
    expect(buildCopilotDesktopPlan({ ...native, dataDir: 'C:/fixtures/modeldock-b' }, 19191).providers[0].id).not.toBe(before.providers[0].id);
    expect(before.providers[0].models.every(model => model.contextWindow! + model.maxOutputTokens! <= 64000)).toBe(true);
  });
  it('previews empty Copilot cleanup without reading keys and refuses the generic file adapter instead of touching Codex config', () => {
    const native = nativeFixture([]);
    const preview = buildConfig(native, 'copilot', 19191);
    expect(preview.canApply).toBe(true); expect(JSON.parse(preview.content)).toEqual({ providers: [] });
    expect(native.getSecret).not.toHaveBeenCalled();
    const root = mkdtempSync(join(tmpdir(), 'modeldock-copilot-')); roots.push(root);
    expect(() => applyConfig(native, 'copilot', 19191, root, join(root, 'backups'), root)).toThrow('原生接口');
    expect(existsSync(join(root, '.codex'))).toBe(false);
  });
});
