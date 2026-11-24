import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from '@iarna/toml';
import { applyConfig, buildConfig, vsCodeModelConfig } from '../src/main/adapters';
import { resolveBindingModels } from '../src/shared/bindings';
import type { Model, Provider, ToolBinding, ToolId, WireApi } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(wireApi: WireApi = 'responses') {
  const provider: Provider = { id: 'official-deepseek', name: 'DeepSeek', kind: 'openai-compatible', presetId: 'deepseek',
    baseUrl: 'https://api.deepseek.com', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
  const model: Model = { id: 'flash-model', providerId: provider.id, upstreamId: 'deepseek-flash', alias: 'local-flash',
    displayName: 'DeepSeek-V4.1-Flash', wireApi, contextWindow: 1048576, maxOutputTokens: 393216,
    tools: true, vision: true, enabled: true, thinking: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' };
  const bindings = (['vscode', 'codex', 'opencode'] as ToolId[]).map(id => ({ id, name: id, enabled: true, mode: 'auto',
    providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '',
    ...(id === 'vscode' ? { vscodeSyncScope: 'managed' } : {}) } as ToolBinding));
  const getSecret = vi.fn(() => ({ apiKey: 'SYNTHETIC_DEEPSEEK_KEY' }));
  return { provider, model, bindings, getSecret, createManagedBackup: () => 'fixture.enc', listProviders: () => [provider], getProvider: () => provider,
    listModels: () => [model], listBindings: () => bindings, gatewayKey: () => 'SYNTHETIC_GATEWAY_KEY' };
}

const thinkingConfig = { apiType: 'responses', thinking: true, statefulResponses: false,
  supportsReasoningEffort: ['low', 'high', 'max'], defaultReasoningEffort: 'high', reasoningEffortFormat: 'responses' };

describe('VS Code native DeepSeek Responses configuration', () => {
  it.each(['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/',
    'https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/v1/'])
    ('uses the official OpenAI endpoint from %s with original thinking levels', base => {
      const f = fixture(); f.provider.baseUrl = base;
      const generated = JSON.parse(buildConfig(f, 'vscode', 18181, true).content)[0].models[0];
      expect(generated).toMatchObject({ ...thinkingConfig, id: 'deepseek-flash', url: base.startsWith('https://api.deepseek.com/v1') ? 'https://api.deepseek.com/v1/responses' : 'https://api.deepseek.com/responses',
        toolCalling: true, vision: true, contextWindow: 1048576, maxOutputTokens: 393216,
        requestHeaders: { authorization: 'Bearer SYNTHETIC_DEEPSEEK_KEY' } });
      for (const obsolete of ['adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget']) expect(generated).not.toHaveProperty(obsolete);
    });

  it.each(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
    ('recognizes official API ID %s independently of provider display name and preset', upstreamId => {
      const f = fixture(); f.provider.name = 'My API account'; f.provider.presetId = 'custom'; f.model.upstreamId = upstreamId;
      expect(vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider))
        .toMatchObject({ ...thinkingConfig, url: 'https://api.deepseek.com/responses' });
    });

  it.each(['responses', 'chat-completions', 'messages'] as const)
    ('projects the saved %s model only into the VS Code client copy', wireApi => {
      const f = fixture(wireApi);
      f.model.reasoningEffortFormat = wireApi; f.model.adaptiveThinking = false;
      f.model.minThinkingBudget = 1024; f.model.maxThinkingBudget = 12000;
      const original = structuredClone(f.model);
      expect(JSON.parse(buildConfig(f, 'vscode', 18181).content)[0].models[0]).toMatchObject(thinkingConfig);
      expect(f.model).toEqual(original);
    });

  it('preserves native Responses configuration for Codex and OpenCode', () => {
    const f = fixture(); const original = structuredClone(f.model);
    buildConfig(f, 'vscode', 18181);
    const codex = parseToml(buildConfig(f, 'codex', 18181).content) as any;
    const openCode = JSON.parse(buildConfig(f, 'opencode', 18181).content);
    expect(codex.model).toBe('deepseek-flash');
    expect(codex.model_providers.modeldock).toMatchObject({ base_url: 'https://api.deepseek.com', wire_api: 'responses' });
    expect(openCode.provider['modeldock-official-deepseek'].models['deepseek-flash'].provider.npm).toBe('@ai-sdk/openai');
    expect(f.model).toEqual(original);
  });

  it('keeps aggregate calls on the existing tool-scoped gateway without exporting the provider key', () => {
    const f = fixture(); f.bindings[0].mode = 'aggregate';
    const row = JSON.parse(buildConfig(f, 'vscode', 18181, true).content)[0];
    expect(row.models[0]).toMatchObject({ ...thinkingConfig, id: 'local-flash', url: 'http://127.0.0.1:18181/tool/vscode/v1/responses',
      requestHeaders: { authorization: 'Bearer SYNTHETIC_GATEWAY_KEY' } });
    expect(JSON.stringify(row)).not.toContain('SYNTHETIC_DEEPSEEK_KEY');
    expect(f.getSecret).not.toHaveBeenCalled();
  });

  it.each(['thinking flag', 'None default'])('preserves an explicit disabled-thinking choice from %s', choice => {
    const f = fixture();
    if (choice === 'thinking flag') f.model.thinking = false; else f.model.defaultReasoningEffort = 'none';
    const row = vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider);
    expect(row).toMatchObject({ apiType: 'responses', thinking: true, statefulResponses: false,
      url: 'https://api.deepseek.com/responses', supportsReasoningEffort: ['none'],
      defaultReasoningEffort: 'none', reasoningEffortFormat: 'responses' });
    expect(row).not.toHaveProperty('adaptiveThinking');
    expect(row).not.toHaveProperty('modelOptions');
  });

  it('admits saved Messages models only for verified DeepSeek VS Code connections', () => {
    const f = fixture('messages');
    const foreign = { ...f.provider, id: 'foreign-source', baseUrl: 'https://synthetic.example' };
    const catalog = [f.model, { ...f.model, id: 'foreign-model', providerId: foreign.id },
      { ...f.model, id: 'unknown-model', upstreamId: 'unverified-model' }];
    const binding: ToolBinding = { ...f.bindings[0], providerIds: [f.provider.id, foreign.id], modelSelection: 'all', modelIds: [] };
    expect(resolveBindingModels(binding, catalog, [f.provider, foreign]).map(model => model.id)).toEqual([f.model.id]);
    expect(resolveBindingModels({ ...binding, id: 'opencode' }, catalog, [f.provider, foreign])).toEqual([]);
    expect(resolveBindingModels({ ...binding, modelSelection: 'selected', modelIds: [] }, catalog, [f.provider, foreign])).toEqual([]);
    expect(resolveBindingModels(binding, catalog, [{ ...f.provider, enabled: false }, foreign])).toEqual([]);
  });

  it.each([
    'https://api.deepseek.com.evil.example', 'https://api.deepseek.com@evil.example', 'http://api.deepseek.com',
    'https://api.deepseek.com/not-official', 'https://api.deepseek.com/v2', 'https://api.deepseek.com?route=other',
    'https://api.deepseek.com#fragment', 'https://synthetic.example/v1',
  ])('does not redirect an unverified source %s', base => {
    const f = fixture(); f.provider.baseUrl = base;
    const row = vsCodeModelConfig(f.model, base, 'SYNTHETIC_KEY', f.provider);
    expect(row).toMatchObject({ apiType: 'responses', supportsReasoningEffort: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high', reasoningEffortFormat: 'responses' });
    expect(row).not.toHaveProperty('adaptiveThinking');
    expect(row.url).not.toContain('/anthropic/');
  });

  it.each(['deepseek-v4.1-flash', 'DeepSeek-Flash', 'unverified-model'])
    ('does not infer protocol capability from a familiar display name for %s', upstreamId => {
      const f = fixture(); f.model.upstreamId = upstreamId;
      expect(vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider)).toMatchObject({ apiType: 'responses' });
    });

  it('does not apply API compatibility to a subscription or a native account adapter', () => {
    const f = fixture(); f.provider.kind = 'codex';
    expect(vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider)).toMatchObject({ apiType: 'responses' });
    f.provider.kind = 'openai-compatible'; f.provider.nativeAdapter = 'jetbrains-central';
    expect(vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider)).toMatchObject({ apiType: 'responses' });
  });

  it.each(['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/v1/'])
    ('accepts the explicit official Anthropic override %s', claudeBaseUrl => {
      const f = fixture(); f.provider.claudeBaseUrl = claudeBaseUrl;
      expect(vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider))
        .toMatchObject({ ...thinkingConfig, url: 'https://api.deepseek.com/responses' });
    });

  it('uses the original OpenAI base regardless of a Claude-only endpoint override', () => {
    const f = fixture(); f.provider.claudeBaseUrl = 'https://synthetic.example/anthropic';
    expect(vsCodeModelConfig(f.model, f.provider.baseUrl, 'SYNTHETIC_KEY', f.provider))
      .toMatchObject({ apiType: 'responses', url: 'https://api.deepseek.com/responses' });
  });

  it('resyncs an old None-only entry while preserving unrelated providers and JSONC comments', () => {
    const f = fixture(); const root = mkdtempSync(join(tmpdir(), 'modeldock-vscode-deepseek-config-')); roots.push(root);
    const target = join(root, 'Code', 'User', 'chatLanguageModels.json'); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `[
      // keep this user's comment
      {"vendor":"customendpoint","name":"Personal","models":[{"id":"personal-model"}]},
      {"vendor":"customendpoint","name":"ModelDock · DeepSeek","models":[{"id":"deepseek-flash","apiType":"responses","thinking":true,"supportsReasoningEffort":["none"],"defaultReasoningEffort":"none","statefulResponses":false}]},
    ]`);
    applyConfig(f, 'vscode', 18181, root, join(root, 'backups'), root);
    const text = readFileSync(target, 'utf8'), rows = parseJsonc(text);
    expect(text).toContain("keep this user's comment");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Personal', models: [{ id: 'personal-model' }] });
    expect(rows[1].models[0]).toMatchObject(thinkingConfig);
    expect(rows[1].models[0]).not.toHaveProperty('adaptiveThinking');
    expect(rows[1].models[0].supportsReasoningEffort).not.toContain('none');
  });
});
