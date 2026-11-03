import { describe, expect, it, vi } from 'vitest';
import { applyConfig, buildConfig, connectionKey } from '../src/main/adapters';
import { buildTraePlan, type TraePlanStore } from '../src/main/trae-config';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

function fixture() {
  const providers: Provider[] = [
    { id: 'api', name: 'Fixture API', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1/', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
    { id: 'account', name: 'Fixture account', kind: 'codex', baseUrl: 'https://account.example.test/codex', enabled: true, hasSecret: true, authStatus: 'ready', note: '' },
    { id: 'off', name: 'Disabled API', kind: 'openai-compatible', baseUrl: 'https://off.example.test/v1', enabled: false, hasSecret: true, authStatus: 'ready', note: '' },
  ];
  const base: Model = { id: 'chat', providerId: 'api', upstreamId: 'native-chat', alias: 'dock-chat', displayName: 'Chat fixture', wireApi: 'chat-completions', contextWindow: 0, tools: true, vision: false, enabled: true };
  const models: Model[] = [base,
    { ...base, id: 'responses', upstreamId: 'native-responses', alias: 'dock-responses', wireApi: 'responses' },
    { ...base, id: 'messages', upstreamId: 'native-messages', alias: 'dock-messages', wireApi: 'messages' },
    { ...base, id: 'account-model', providerId: 'account', upstreamId: 'native-account', alias: 'dock-account', wireApi: 'responses' },
    { ...base, id: 'off-model', providerId: 'off', alias: 'dock-off' },
    { ...base, id: 'disabled-model', alias: 'dock-disabled', enabled: false },
  ];
  const binding: ToolBinding = { id: 'trae', name: 'Trae CN', enabled: true, mode: 'direct', providerIds: ['api'], modelIds: [], modelSelection: 'all', defaultModelId: 'messages', note: '' };
  const getSecret = vi.fn((id: string) => ({ apiKey: id === 'api' ? 'SYNTHETIC_API_KEY' : undefined, accessToken: 'SYNTHETIC_OAUTH_ACCESS', refreshToken: 'SYNTHETIC_OAUTH_REFRESH' }));
  const gatewayKey = vi.fn(() => 'SYNTHETIC_LOCAL_KEY');
  const store: TraePlanStore = { listModels: () => models, listBindings: () => [binding], listProviders: () => providers,
    getProvider: id => providers.find(provider => provider.id === id), getSecret, gatewayKey };
  return { providers, models, binding, getSecret, gatewayKey, store };
}

describe('Trae native configuration plans', () => {
  it('previews native Chat, Responses and Messages with redacted keys and the selected default ordered first', () => {
    const f = fixture(), before = structuredClone(f.models);
    const preview = buildConfig(f.store, 'trae', 19421);
    expect(preview).toMatchObject({ filename: 'modeldock-trae.json', canApply: true });
    const plan = JSON.parse(preview.content);
    expect(plan.models.map((row: any) => row.sourceId)).toEqual(['messages', 'chat', 'responses']);
    expect(plan.models.map((row: any) => [row.configuration.provider, row.configuration.model_name, row.configuration.base_url, row.configuration.ak])).toEqual([
      ['custom_anthropic_compatible', 'native-messages', 'https://api.example.test/v1/messages', '__PROVIDER_API_KEY__'],
      ['custom_openai_compatible', 'native-chat', 'https://api.example.test/v1/chat/completions', '__PROVIDER_API_KEY__'],
      ['custom_responses_compatible', 'native-responses', 'https://api.example.test/v1/responses', '__PROVIDER_API_KEY__'],
    ]);
    expect(plan.models[0].configuration.display_name).toBe('ModelDock · Fixture API - Chat fixture');
    expect(f.getSecret).not.toHaveBeenCalled(); expect(f.gatewayKey).not.toHaveBeenCalled();
    expect(f.models).toEqual(before);
  });

  it('exports only API keys in direct mode, and never exports subscriptions or falls back to localhost', () => {
    const f = fixture();
    const content = buildConfig(f.store, 'trae', 19421, true).content;
    expect(content).toContain('SYNTHETIC_API_KEY');
    expect(content).not.toMatch(/SYNTHETIC_OAUTH|127\.0\.0\.1/);
    expect(connectionKey(f.store, 'trae')).toBe('SYNTHETIC_API_KEY');
    expect(f.gatewayKey).not.toHaveBeenCalled(); f.getSecret.mockClear();
    f.binding.providerIds = ['account']; f.binding.defaultModelId = 'account-model';
    expect(() => buildTraePlan(f.store, 19421, true)).toThrow('账号订阅');
    expect(() => connectionKey(f.store, 'trae')).toThrow('账号订阅');
    expect(f.getSecret).not.toHaveBeenCalled(); expect(f.gatewayKey).not.toHaveBeenCalled();
    f.binding.providerIds = ['api', 'account'];
    expect(() => buildTraePlan(f.store, 19421, true)).toThrow('一家');
  });

  it('publishes the exact enabled aggregate model set using aliases and one local key, without accessing upstream secrets', () => {
    const f = fixture();
    Object.assign(f.binding, { mode: 'aggregate', providerIds: ['api', 'account', 'off'], modelSelection: 'selected', modelIds: ['chat', 'messages', 'account-model', 'off-model', 'disabled-model'], defaultModelId: 'account-model' });
    const preview = buildTraePlan(f.store, 19421);
    expect(preview.models.map(row => row.sourceId)).toEqual(['account-model', 'chat', 'messages']);
    expect(preview.models.every(row => row.configuration.ak === '__MODELDOCK_LOCAL_KEY__')).toBe(true);
    expect(f.getSecret).not.toHaveBeenCalled(); expect(f.gatewayKey).not.toHaveBeenCalled();
    const actual = buildTraePlan(f.store, 19421, true);
    expect(actual.models.map(row => [row.configuration.model_name, row.configuration.base_url])).toEqual([
      ['dock-account', 'http://127.0.0.1:19421/tool/trae/v1/responses'],
      ['dock-chat', 'http://127.0.0.1:19421/tool/trae/v1/chat/completions'],
      ['dock-messages', 'http://127.0.0.1:19421/tool/trae/v1/messages'],
    ]);
    expect(actual.models.every(row => row.configuration.ak === 'SYNTHETIC_LOCAL_KEY')).toBe(true);
    expect(connectionKey(f.store, 'trae')).toBe('SYNTHETIC_LOCAL_KEY');
    expect(f.getSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(actual)).not.toMatch(/SYNTHETIC_API_KEY|SYNTHETIC_OAUTH/);
  });

  it.each(['direct', 'aggregate'] as const)('keeps disabled and explicit empty %s scopes empty without reading credentials', mode => {
    const f = fixture(); f.binding.mode = mode; f.binding.enabled = false;
    expect(buildTraePlan(f.store, 19421, true)).toEqual({ version: 1, models: [] });
    f.binding.enabled = true; f.binding.modelSelection = 'selected'; f.binding.modelIds = [];
    expect(buildTraePlan(f.store, 19421, true)).toEqual({ version: 1, models: [] });
    f.binding.providerIds = []; f.binding.modelSelection = 'all';
    expect(buildTraePlan(f.store, 19421, true)).toEqual({ version: 1, models: [] });
    expect(() => connectionKey(f.store, 'trae')).toThrow('至少一个');
    expect(f.getSecret).not.toHaveBeenCalled(); expect(f.gatewayKey).not.toHaveBeenCalled();
  });

  it('omits unknown specifications and unverified reasoning parameter paths instead of inventing capabilities', () => {
    const f = fixture();
    for (const model of f.models) { model.reasoningEfforts = ['low', 'medium', 'high']; model.reasoningEffortFormat = model.wireApi; }
    const plan = buildTraePlan(f.store, 19421);
    for (const row of plan.models) {
      expect(row.configuration.config_detail.model_hyper_params).toEqual({});
      expect(row.configuration.clearReasoningParam).toBe(true);
      expect(row.configuration).not.toHaveProperty('tool_calling');
    }
    expect(buildConfig(f.store, 'trae', 19421).instructions).toContain('思考档位参数不自动映射');
  });

  it('uses declared thinking flags and budgets without exceeding a known shared context window', () => {
    const f = fixture();
    Object.assign(f.models[0], { contextWindow: 100000, maxInputTokens: 90000, maxOutputTokens: 20000, thinking: true });
    Object.assign(f.models[1], { contextWindow: 0, maxInputTokens: 900000, maxOutputTokens: 128000, thinking: false });
    Object.assign(f.models[2], { contextWindow: 64000, maxOutputTokens: 8000, vision: true });
    const rows = Object.fromEntries(buildTraePlan(f.store, 19421).models.map(row => [row.sourceId, row.configuration]));
    expect(rows.chat.config_detail.model_hyper_params).toEqual({ max_tokens: 20000, prompt_max_tokens: 80000, thinking_enable: 1 });
    expect(rows.responses.config_detail.model_hyper_params).toEqual({ max_tokens: 128000, prompt_max_tokens: 900000, thinking_enable: 2 });
    expect(rows.messages.config_detail).toEqual({ multimodal: true, model_hyper_params: { max_tokens: 8000, prompt_max_tokens: 56000 } });
    Object.assign(f.models[0], { maxOutputTokens: 120000, maxInputTokens: 200000 });
    const oversized = buildTraePlan(f.store, 19421).models.find(row => row.sourceId === 'chat')!;
    expect(oversized.configuration.config_detail.model_hyper_params).toMatchObject({ max_tokens: 99999, prompt_max_tokens: 1 });
  });

  it('validates active endpoints and missing keys while preserving custom API prefixes', () => {
    const f = fixture(); f.providers[0].baseUrl = 'https://api.example.test/coding';
    expect(buildTraePlan(f.store, 19421).models[0].configuration.base_url).toBe('https://api.example.test/coding/v1/messages');
    f.providers[0].baseUrl = 'http://127.0.0.1:19421/v1';
    expect(() => buildTraePlan(f.store, 19421, true)).toThrow('请求循环');
    expect(f.getSecret).not.toHaveBeenCalled();
    f.providers[0].baseUrl = 'https://api.example.test/v1?credential=not-a-key';
    expect(() => buildTraePlan(f.store, 19421)).toThrow('查询');
    f.providers[0].baseUrl = 'https://api.example.test/v1'; f.getSecret.mockReturnValue({ apiKey: undefined, accessToken: 'SYNTHETIC_OAUTH_ACCESS', refreshToken: 'SYNTHETIC_OAUTH_REFRESH' });
    expect(() => buildTraePlan(f.store, 19421, true)).toThrow('API Key');
    f.binding.mode = 'aggregate';
    expect(() => buildTraePlan(f.store, 0)).toThrow('端口');
  });

  it('honors explicit and verified native Messages endpoints without redirecting Chat or Responses models', () => {
    const f = fixture(); f.providers[0].claudeBaseUrl = 'https://messages.example.test/custom';
    let rows = Object.fromEntries(buildTraePlan(f.store, 19421).models.map(row => [row.sourceId, row.configuration]));
    expect(rows.messages.base_url).toBe('https://messages.example.test/custom/v1/messages');
    expect(rows.chat.base_url).toBe('https://api.example.test/v1/chat/completions');
    expect(rows.responses.base_url).toBe('https://api.example.test/v1/responses');
    delete f.providers[0].claudeBaseUrl; f.providers[0].presetId = 'deepseek'; f.providers[0].baseUrl = 'https://api.deepseek.com/v1';
    rows = Object.fromEntries(buildTraePlan(f.store, 19421).models.map(row => [row.sourceId, row.configuration]));
    expect(rows.messages.base_url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(rows.responses.base_url).toBe('https://api.deepseek.com/v1/responses');
    f.providers[0].baseUrl = 'https://custom.example.test/v1';
    rows = Object.fromEntries(buildTraePlan(f.store, 19421).models.map(row => [row.sourceId, row.configuration]));
    expect(rows.messages.base_url).toBe('https://custom.example.test/v1/messages');
  });

  it('does not route native Trae application through an unrelated file adapter', () => {
    const f = fixture();
    expect(() => applyConfig(f.store, 'trae', 19421, 'unused-appdata', 'unused-backups', 'unused-home')).toThrow('原生接口');
    expect(f.getSecret).not.toHaveBeenCalled(); expect(f.gatewayKey).not.toHaveBeenCalled();
  });
});
