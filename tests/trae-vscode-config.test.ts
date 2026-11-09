import { describe, expect, it } from 'vitest';
import { buildConfig, vsCodeModelConfig } from '../src/main/adapters';
import { traeRelayClientModel } from '../src/shared/trae-relay-models';
import type { Model, Provider, ToolBinding, ToolId } from '../src/shared/types';

const provider: Provider = {
  id: 'native-trae', name: 'TRAE CN', kind: 'openai-compatible', presetId: 'trae-cn-relay', nativeAdapter: 'trae',
  baseUrl: 'http://127.0.0.1:18181', enabled: true, hasSecret: true, authStatus: 'ready', note: '',
};
const model: Model = {
  id: 'trae-kimi', providerId: provider.id, upstreamId: 'Kimi-K3', alias: 'trae-kimi', displayName: 'Kimi K3',
  wireApi: 'chat-completions', contextWindow: 1000000, maxOutputTokens: 32000,
  tools: true, vision: false, enabled: true, thinking: true,
  reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', reasoningEffortFormat: 'chat-completions',
};

describe('TRAE native VS Code request defaults', () => {
  it('avoids Copilot automatic budget and sampling controls while keeping native reasoning effort options', () => {
    const original = structuredClone(model), originalProvider = structuredClone(provider);
    const projected = traeRelayClientModel('vscode', model, provider);
    expect(projected).not.toBe(model);
    expect(projected).toMatchObject({ thinking: false, maxOutputTokens: 32000, reasoningEfforts: ['low', 'high', 'max'] });
    const output = vsCodeModelConfig(model, 'http://127.0.0.1:19191/tool/vscode/v1', 'SYNTHETIC_ONLY', provider);
    expect(output).toMatchObject({ apiType: 'chat-completions', thinking: false, maxOutputTokens: 32000,
      modelOptions: { temperature: null, top_p: null }, supportsReasoningEffort: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high', reasoningEffortFormat: 'chat-completions' });
    expect(model).toEqual(original);
    expect(provider).toEqual(originalProvider);
  });

  it.each(['auto', 'aggregate'] as const)('projects each selected model independently in %s mode', mode => {
    const others: Provider[] = [
      { ...provider, id: 'ordinary-api', name: 'Ordinary API', nativeAdapter: undefined, presetId: undefined, baseUrl: 'https://ordinary.example/v1' },
      { ...provider, id: 'external-relay', name: 'External TRAE Relay', nativeAdapter: undefined, baseUrl: 'https://relay.example/v1' },
      { ...provider, id: 'other-account', name: 'Other Native Account', nativeAdapter: 'jetbrains-ide', presetId: undefined },
    ];
    for (const providers of [[...others, provider], [provider, ...others]]) {
      const catalog: Model[] = providers.map(source => ({ ...model, id: `${source.id}-model`, providerId: source.id, alias: `${source.id}-kimi` }));
      const originalModels = structuredClone(catalog), originalProviders = structuredClone(providers);
      const bindings: ToolBinding[] = [{ id: 'vscode', name: 'VS Code', enabled: true, mode,
        providerIds: providers.map(source => source.id), modelIds: [], defaultModelId: catalog[0].id, note: '' }];
      const originalBindings = structuredClone(bindings);
      const store = { listModels: () => catalog, listProviders: () => providers, listBindings: () => bindings,
        gatewayKey: () => 'SYNTHETIC_LOCAL_ONLY' };
      const preview = buildConfig(store, 'vscode', 19191);
      const rows = JSON.parse(preview.content).flatMap((group: { models: Record<string, unknown>[] }) => group.models);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        const native = row.id === 'native-trae-kimi';
        expect(row.thinking).toBe(!native);
        expect(row.supportsReasoningEffort).toEqual(['low', 'high', 'max']);
        if (native) expect(row.modelOptions).toEqual({ temperature: null, top_p: null });
        else expect(row).not.toHaveProperty('modelOptions');
      }
      expect(preview.instructions).toContain('输出预算与采样使用上游原生默认值');
      expect(preview.instructions).toContain('思考仍由上游生成');
      expect(preview.instructions).toContain('推理强度选项保留');
      expect(preview.instructions).toContain('请重新同步 VS Code 配置');
      expect(catalog).toEqual(originalModels);
      expect(providers).toEqual(originalProviders);
      expect(bindings).toEqual(originalBindings);
      expect(preview.content).not.toContain('SYNTHETIC_LOCAL_ONLY');
    }
  });

  it('preserves other tools, external relays and non-Chat models', () => {
    for (const tool of ['codex', 'claude-code', 'opencode', 'copilot', 'dsh', 'rider'] as ToolId[]) {
      expect(traeRelayClientModel(tool, model, provider).thinking).toBe(true);
    }
    const external: Provider = { ...provider, nativeAdapter: undefined, baseUrl: 'https://relay.example/v1' };
    const ordinary: Provider = { ...external, presetId: undefined };
    for (const source of [external, ordinary, undefined]) {
      const output = vsCodeModelConfig(model, 'https://relay.example/v1', 'SYNTHETIC_ONLY', source);
      expect(output.thinking).toBe(true);
      expect(output).not.toHaveProperty('modelOptions');
    }
    const responses: Model = { ...model, wireApi: 'responses', reasoningEffortFormat: 'responses' };
    const output = vsCodeModelConfig(responses, 'http://127.0.0.1:19191/tool/vscode/v1', 'SYNTHETIC_ONLY', provider);
    expect(output).toMatchObject({ apiType: 'responses', thinking: true });
    expect(output).not.toHaveProperty('modelOptions');
    expect(model.thinking).toBe(true);
  });

  it('does not show the native TRAE guidance for other selected sources', () => {
    const external: Provider = { ...provider, nativeAdapter: undefined, baseUrl: 'https://relay.example/v1' };
    const store = { listModels: () => [model], listProviders: () => [external],
      listBindings: (): ToolBinding[] => [{ id: 'vscode', name: 'VS Code', enabled: true, mode: 'aggregate', providerIds: [external.id], modelIds: [], defaultModelId: model.id, note: '' }],
      gatewayKey: () => 'SYNTHETIC_LOCAL_ONLY' };
    const preview = buildConfig(store, 'vscode', 19191);
    expect(preview.instructions).not.toContain('TRAE 原生连接');
    expect(JSON.parse(preview.content)[0].models[0]).not.toHaveProperty('modelOptions');
  });
});
