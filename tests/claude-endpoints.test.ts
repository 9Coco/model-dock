import { describe, expect, it } from 'vitest';
import { nativeClaudeBaseUrl, claudeConnectionKind } from '../src/shared/claude';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const source = (patch: Partial<Provider>): Provider => ({ id: 'source', name: 'Fixture', kind: 'openai-compatible', enabled: true, authStatus: 'ready', hasSecret: true, baseUrl: '', note: '', ...patch });
const model: Model = { id: 'model', providerId: 'source', alias: 'local-alias', upstreamId: 'upstream-real-id', displayName: 'Fixture', wireApi: 'responses', enabled: true, contextWindow: 0, tools: true, vision: false };
const binding: ToolBinding = { id: 'claude-code', name: 'Claude Code', enabled: true, mode: 'direct', providerIds: ['source'], modelIds: [], defaultModelId: model.id, note: '' };
describe('official Claude endpoint selection', () => {
  it.each([
    ['deepseek', 'https://api.deepseek.com', 'https://api.deepseek.com/anthropic'],
    ['deepseek', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/anthropic'],
    ['volcengine-agent', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'https://ark.cn-beijing.volces.com/api/plan'],
    ['volcengine-token', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'https://ark.cn-beijing.volces.com/api/coding'],
    ['qwen-token', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'],
    ['qwen-token', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic'],
    ['qwen-token', 'https://coding.dashscope.aliyuncs.com/v1', 'https://coding.dashscope.aliyuncs.com/apps/anthropic'],
    ['qwen-token', 'https://coding-intl.dashscope.aliyuncs.com/v1', 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic'],
  ])('reuses %s without changing its OpenAI address or model protocol', (presetId, baseUrl, expected) => {
    const provider = source({ presetId: presetId as Provider['presetId'], baseUrl });
    expect(nativeClaudeBaseUrl(provider)).toBe(expected);
    expect(resolveBindingModels(binding, [model], [provider])).toEqual([model]);
    expect(bindingConnectionPolicy(binding, [model], [provider]).groups[0].connection).toBe('direct-api');
    expect(provider.baseUrl).toBe(baseUrl); expect(model.wireApi).toBe('responses');
  });
  it('never redirects edited addresses by guessing from preset names', () => {
    for (const baseUrl of ['https://other.example.test/api/plan/v3', 'https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com:8443/api/plan/v3']) {
      const provider = source({ presetId: 'volcengine-agent', baseUrl });
      expect(nativeClaudeBaseUrl(provider)).toBeUndefined();
      expect(claudeConnectionKind(provider, [model])).toBe('local-managed');
    }
    expect(nativeClaudeBaseUrl(source({ presetId: 'volcengine-agent', baseUrl: 'https://custom.example.test/v1', claudeBaseUrl: 'https://custom.example.test/claude' }))).toBe('https://custom.example.test/claude');
  });
  it.each(['codex', 'copilot', 'grok'] as const)('uses the local bridge for %s account subscriptions', kind => {
    const provider = source({ kind, baseUrl: 'https://account.example.test' });
    expect(nativeClaudeBaseUrl(provider)).toBeUndefined();
    expect(resolveBindingModels(binding, [model], [provider])).toEqual([]);
    expect(bindingConnectionPolicy(binding, [model], [provider]).groups).toEqual([]);
    const aggregate = { ...binding, mode: 'aggregate' as const };
    expect(resolveBindingModels(aggregate, [model], [provider])).toEqual([model]);
    expect(bindingConnectionPolicy(aggregate, [model], [provider]).groups[0].connection).toBe('local-managed');
  });
});
