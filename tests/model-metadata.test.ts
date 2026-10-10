import { describe, expect, it } from 'vitest';
import { lookupModelMetadata } from '../src/shared/model-metadata';

describe('documented model metadata defaults', () => {
  it.each([
    ['gpt-4o', 128_000, true],
    ['gpt-4.1', 1_047_576, true],
    ['gpt-5.4-mini', 400_000, true],
    ['o3-mini', 200_000, false],
    ['claude-sonnet-5-5', 1_000_000, true],
    ['claude-sonnet-4-5-20250929', 200_000, true],
    ['claude-opus-4-6', 1_000_000, true],
    ['gemini-2.5-pro', 1_114_112, true],
    ['deepseek-flash', 1_048_576, true],
    ['deepseek-v4-pro', 1_048_576, false],
    ['qwen3.6-plus', 1_000_000, true],
    ['glm-4.7', 200_000, false],
    ['glm-4.6v', 128_000, true],
    ['glm-5.3', 1_000_000, false],
    ['glm-5.3-flash', 1_000_000, true],
    ['kimi-k2.6', 256_000, true],
    ['grok-4.7', 500_000, true],
  ])('returns source-backed metadata for %s', (id, contextWindow, vision) => {
    const metadata = lookupModelMetadata(id as string);
    expect(metadata).toMatchObject({ contextWindow, vision, verifiedAt: '2026-10-10' });
    expect(metadata?.sourceUrl).toMatch(/^https:\/\//);
  });

  it('recognizes only published snapshots and explicit aliases', () => {
    expect(lookupModelMetadata('gpt-4o-2024-08-06')).toEqual(lookupModelMetadata('gpt-4o'));
    expect(lookupModelMetadata('gpt-5.6')).toEqual(lookupModelMetadata('gpt-5.6-sol'));
    expect(lookupModelMetadata('qwen3.6-plus-2026-04-02')).toEqual(lookupModelMetadata('qwen3.6-plus'));
    expect(lookupModelMetadata('gpt-4o-2026-09-01')).toBeUndefined();
  });

  it('recognizes vetted namespaces only for models from that vendor', () => {
    expect(lookupModelMetadata('openai/gpt-4o')).toEqual(lookupModelMetadata('gpt-4o'));
    expect(lookupModelMetadata('models/gemini-2.5-pro')).toEqual(lookupModelMetadata('gemini-2.5-pro'));
    expect(lookupModelMetadata('anthropic/claude-sonnet-5-5')).toEqual(lookupModelMetadata('claude-sonnet-5-5'));
    expect(lookupModelMetadata('anthropic/gpt-4o')).toBeUndefined();
    expect(lookupModelMetadata('my-gateway/gpt-4o')).toBeUndefined();
    expect(lookupModelMetadata('openai/custom/gpt-4o')).toBeUndefined();
  });

  it.each(['', 'my-vision-model', 'gpt-4o-latest', 'gpt-4o-thinking', 'gpt-4o-preview',
    'gpt-4o-audio-preview', 'gpt-4o-mini-realtime-preview', 'gpt-5.4-turbo',
    'claude-sonnet-5-5-thinking', 'gemini-2.5-pro-preview', 'qwen3.6-plus-latest', 'glm-5-vision'])
  ('does not guess capabilities for %s', id => {
    expect(lookupModelMetadata(id)).toBeUndefined();
  });

  it('normalizes outer whitespace and casing without broadening names', () => {
    expect(lookupModelMetadata(' GLM-4.6V ')).toEqual(lookupModelMetadata('glm-4.6v'));
    expect(lookupModelMetadata('gpt 4o')).toBeUndefined();
  });

  it('returns independent copies so one caller cannot change later defaults', () => {
    const first = lookupModelMetadata('gpt-4o')!;
    first.contextWindow = 1;
    first.vision = false;
    expect(lookupModelMetadata('gpt-4o')).toMatchObject({ contextWindow: 128_000, vision: true });
  });
  it('keeps native and official Ark Kimi limits and parameter contracts separate', () => {
    const native = lookupModelMetadata('kimi-k3', { kind: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1' }, 'chat-completions')!;
    expect(native).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 1048576, defaultOutputTokens: 131072,
      thinking: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', reasoningEffortFormat: 'chat-completions' });
    for (const path of ['plan', 'coding']) {
      const ark = lookupModelMetadata('kimi-k3', { kind: 'openai-compatible', baseUrl: `https://ark.cn-beijing.volces.com/api/${path}/v3/` }, 'responses')!;
      expect(ark).toMatchObject({ contextWindow: 1024000, maxOutputTokens: 131072, thinking: true, vision: true, reasoningEfforts: [] });
      expect(ark).not.toHaveProperty('defaultReasoningEffort');
      expect(ark).not.toHaveProperty('reasoningEffortFormat');
      expect(ark.sourceUrl).toContain('docs.volcengine.com');
    }
  });
  it.each([
    'https://ark.cn-beijing.volces.com.evil.test/api/plan/v3',
    'https://custom.example.test/api/plan/v3',
    'http://ark.cn-beijing.volces.com/api/plan/v3',
    'https://ark.cn-beijing.volces.com/api/plan/v3?scope=custom',
    'https://name:password@ark.cn-beijing.volces.com/api/plan/v3',
  ])('does not trust a copied preset ID on a different endpoint %s', baseUrl => {
    const value = lookupModelMetadata('kimi-k3', { kind: 'openai-compatible', presetId: 'volcengine-agent', baseUrl }, 'responses')!;
    expect(value.contextWindow).toBe(1000000);
    expect(value.reasoningEfforts).toEqual([]);
    expect(value).not.toHaveProperty('reasoningEffortFormat');
    expect(value.sourceUrl).toContain('platform.kimi.ai');
  });
  it('does not apply public API maxima to account subscriptions', () => {
    for (const kind of ['codex', 'grok', 'copilot'] as const) expect(lookupModelMetadata('gpt-6.1-sol', { kind, baseUrl: 'https://api.openai.com/v1' }, 'responses')).toBeUndefined();
  });
  it('preserves separate Google input/output limits and excludes unsupported thinking levels', () => {
    const google = { kind: 'openai-compatible' as const, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
    const flash = lookupModelMetadata('gemini-3.8-flash', google, 'chat-completions')!;
    expect(flash).toMatchObject({ contextWindow: 1114112, maxInputTokens: 1048576, maxOutputTokens: 65536,
      reasoningEfforts: ['low', 'medium', 'high'], thinking: true });
    expect(flash.reasoningEfforts).not.toContain('minimal');
    expect(lookupModelMetadata('gemini-3.5-flash-lite', google, 'chat-completions')?.reasoningEfforts).toContain('minimal');
  });
  it('matches vision snapshots exactly instead of applying family capabilities', () => {
    expect(lookupModelMetadata('qwen3.7-max')?.vision).toBe(false);
    expect(lookupModelMetadata('qwen3.7-max-2026-06-08')?.vision).toBe(true);
    expect(lookupModelMetadata('qwen3.7-max-future')).toBeUndefined();
  });
  it('projects only compatible API efforts and protocol-specific tool support', () => {
    const openai = { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1' };
    expect(lookupModelMetadata('gpt-6.1-sol', openai, 'responses')).toMatchObject({ tools: true, maxInputTokens: 922000, maxOutputTokens: 128000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(lookupModelMetadata('gpt-6.1-sol', openai, 'chat-completions')?.tools).toBe(false);
    expect(lookupModelMetadata('o1-mini')?.tools).toBe(false);
    const qwen = lookupModelMetadata('qwen3.8-max', { kind: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, 'chat-completions')!;
    expect(qwen.reasoningEfforts).toEqual(['low', 'medium', 'xhigh']);
    expect(qwen.reasoningEfforts).not.toContain('high');
    expect(qwen.reasoningEfforts).not.toContain('max');
    expect(qwen.maxInputTokens).toBe(991808);
    expect(qwen.defaultInputTokens).toBe(983616);
  });
  it('separates thinking capability from effort levels and caps the initial output allocation', () => {
    expect(lookupModelMetadata('kimi-k2.7-code')).toMatchObject({ thinking: true, reasoningEfforts: [] });
    expect(lookupModelMetadata('claude-sonnet-4-5')).toMatchObject({ thinking: true, reasoningEfforts: [], minThinkingBudget: 1024, maxThinkingBudget: 63999 });
    const preview = lookupModelMetadata('kimi-k2.8-preview', { kind: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3' }, 'responses')!;
    expect(preview.maxOutputTokens).toBe(1024000);
    expect(preview.defaultOutputTokens).toBeLessThan(preview.contextWindow);
  });
  it('copies nested metadata arrays as well as scalar limits', () => {
    const first = lookupModelMetadata('gpt-6.1-sol')!;
    first.reasoningEfforts!.splice(0);
    first.sourceUrls!.push('https://wrong.example.test');
    const fresh = lookupModelMetadata('gpt-6.1-sol')!;
    expect(fresh.reasoningEfforts?.length).toBeGreaterThan(0);
    expect(fresh.sourceUrls).not.toContain('https://wrong.example.test');
  });
  it('does not fill protocol-specific capabilities for Responses-only Codex models on Chat', () => {
    const native = { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/v1' };
    for (const id of ['gpt-5.2-codex', 'gpt-5.3-codex']) {
      expect(lookupModelMetadata(id, native, 'responses')).toMatchObject({ tools: true, reasoningEffortFormat: 'responses' });
      const unsupported = lookupModelMetadata(id, native, 'chat-completions')!;
      expect(unsupported).toMatchObject({ tools: false, reasoningEfforts: [] });
      expect(unsupported).not.toHaveProperty('reasoningEffortFormat');
      expect(unsupported).not.toHaveProperty('defaultReasoningEffort');
      expect(unsupported.notes).toContain('所选接口不在');
    }
  });
  it('keeps MiniMax protocol evidence and its plan override separate', () => {
    const native = { kind: 'openai-compatible' as const, baseUrl: 'https://api.minimax.io/v1' };
    expect(lookupModelMetadata('MiniMax-M3', native, 'messages')).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 524288, defaultOutputTokens: 131072, thinking: true, reasoningEfforts: [] });
    expect(lookupModelMetadata('MiniMax-M3', native, 'responses')).not.toHaveProperty('maxOutputTokens');
    expect(lookupModelMetadata('MiniMax-M3', native)).not.toHaveProperty('maxOutputTokens');
    expect(lookupModelMetadata('minimax-m3', { kind: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3' }, 'responses')).toMatchObject({ contextWindow: 1024000, maxOutputTokens: 131072 });
  });
});
