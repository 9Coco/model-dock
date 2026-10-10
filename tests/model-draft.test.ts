import { describe, expect, it } from 'vitest';
import { applyOfficialModelParameters, autoFillModelDraft, freshModelDraft, reasoningSelectionPatch, withReasoningWireApi, type ModelDraftParameterField } from '../src/shared/model-draft';
import { lookupModelMetadata, lookupModelReasoningDefaults, type ModelMetadata } from '../src/shared/model-metadata';

const spec = (changes: Partial<ModelMetadata> = {}): ModelMetadata => ({
  contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 250_000,
  defaultOutputTokens: 64_000, vision: true, tools: true, thinking: true,
  reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', reasoningEffortFormat: 'chat-completions',
  adaptiveThinking: false, verifiedAt: '2026-10-10', sourceUrl: 'https://example.invalid/official-model', sourceUrls: ['https://example.invalid/official-model'], ...changes,
});
const untouched = () => new Set<ModelDraftParameterField>();

describe('manual model parameter drafts', () => {
  it('starts an unknown model with unset lengths and unclaimed capabilities', () => {
    expect(freshModelDraft('supplier', 'chat-completions')).toMatchObject({
      providerId: 'supplier', wireApi: 'chat-completions', contextWindow: 0,
      maxInputTokens: 0, maxOutputTokens: 0, thinking: false, tools: false, vision: false,
      reasoningEfforts: [],
    });
  });

  it('fills a documented ID without rewriting its identity or protocol', () => {
    const draft = { ...freshModelDraft('supplier', 'chat-completions'), upstreamId: 'exact-id', alias: 'local-name', displayName: '我的模型' };
    const result = autoFillModelDraft(draft, spec(), untouched());
    expect(result).toMatchObject({ providerId: 'supplier', upstreamId: 'exact-id', alias: 'local-name', displayName: '我的模型', wireApi: 'chat-completions', contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 64_000, vision: true, thinking: true, tools: true });
    expect(draft.contextWindow).toBe(0);
  });

  it('updates automatic fields when switching known IDs', () => {
    const first = autoFillModelDraft(freshModelDraft(), spec(), untouched());
    const next = autoFillModelDraft({ ...first, upstreamId: 'other-id' }, spec({ contextWindow: 200_000, maxInputTokens: 150_000, maxOutputTokens: 16_000, defaultOutputTokens: 8_000, vision: false, reasoningEfforts: [], defaultReasoningEffort: undefined }), untouched());
    expect(next).toMatchObject({ contextWindow: 200_000, maxInputTokens: 150_000, maxOutputTokens: 8_000, vision: false, reasoningEfforts: [] });
    expect(next.defaultReasoningEffort).toBeUndefined();
    expect(next.reasoningEffortFormat).toBeUndefined();
  });

  it('clears previously inferred fields when a new ID or supplier becomes unknown', () => {
    const first = autoFillModelDraft(freshModelDraft(), spec(), untouched());
    const next = autoFillModelDraft({ ...first, upstreamId: 'unknown-experimental' }, undefined, untouched());
    expect(next).toMatchObject({ contextWindow: 0, maxInputTokens: 0, maxOutputTokens: 0, tools: false, vision: false, thinking: false, reasoningEfforts: [] });
    expect(next.defaultReasoningEffort).toBeUndefined();
    expect(next.reasoningEffortFormat).toBeUndefined();
  });

  it('preserves manually chosen zero and explicit false across ID changes', () => {
    const draft = { ...autoFillModelDraft(freshModelDraft(), spec(), untouched()), contextWindow: 0, maxInputTokens: 0, vision: false, tools: false };
    const touched = new Set<ModelDraftParameterField>(['contextWindow', 'maxInputTokens', 'vision', 'tools']);
    const result = autoFillModelDraft(draft, spec({ contextWindow: 200_000, maxOutputTokens: 12_000, defaultOutputTokens: 4_000 }), touched);
    expect(result).toMatchObject({ contextWindow: 0, maxInputTokens: 0, vision: false, tools: false, maxOutputTokens: 4_000 });
    expect(autoFillModelDraft(result, undefined, touched)).toMatchObject({ contextWindow: 0, maxInputTokens: 0, vision: false, tools: false, maxOutputTokens: 0 });
  });

  it('preserves a manually selected output budget and thinking level set', () => {
    const draft = { ...freshModelDraft(), maxOutputTokens: 1234, reasoningEfforts: ['low' as const], defaultReasoningEffort: 'low' as const, reasoningEffortFormat: 'responses' as const };
    const touched = new Set<ModelDraftParameterField>(['maxOutputTokens', 'reasoningEfforts', 'defaultReasoningEffort', 'reasoningEffortFormat']);
    expect(autoFillModelDraft(draft, spec(), touched)).toMatchObject({ maxOutputTokens: 1234, reasoningEfforts: ['low'], defaultReasoningEffort: 'low', reasoningEffortFormat: 'responses' });
  });

  it('never overwrites an existing model automatically, even after identity edits', () => {
    const old = { ...freshModelDraft(), id: 'existing', upstreamId: 'known-id', contextWindow: 128_000, maxOutputTokens: 4096, vision: false, thinking: false };
    expect(autoFillModelDraft(old, spec(), untouched())).toBe(old);
    expect(autoFillModelDraft(old, undefined, untouched())).toBe(old);
  });

  it('explicit official apply updates old 128K parameters while preserving names and enabled state', () => {
    const old = { ...freshModelDraft('supplier', 'chat-completions'), id: 'existing', upstreamId: 'known-id', contextWindow: 128_000, alias: 'old-alias', displayName: '旧显示名称', enabled: false };
    expect(applyOfficialModelParameters(old, spec())).toMatchObject({ id: 'existing', providerId: 'supplier', upstreamId: 'known-id', wireApi: 'chat-completions', contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 64_000, alias: 'old-alias', displayName: '旧显示名称', enabled: false });
    expect(old.contextWindow).toBe(128_000);
  });

  it('explicit apply changes verified false values but leaves undocumented limits alone', () => {
    const old = { ...freshModelDraft(), maxInputTokens: 9876, maxOutputTokens: 3456, tools: true, vision: true, thinking: true, adaptiveThinking: true, minThinkingBudget: 1024, maxThinkingBudget: 4096, reasoningEfforts: ['high' as const], defaultReasoningEffort: 'high' as const };
    const partial = spec({ maxInputTokens: undefined, maxOutputTokens: undefined, tools: false, vision: false, thinking: false, reasoningEfforts: undefined, defaultReasoningEffort: undefined });
    expect(applyOfficialModelParameters(old, partial)).toMatchObject({ maxInputTokens: 9876, maxOutputTokens: 3456, tools: false, vision: false, thinking: false, reasoningEfforts: [] });
    expect(applyOfficialModelParameters(old, partial)).toMatchObject({ adaptiveThinking: false });
    expect(applyOfficialModelParameters(old, partial).minThinkingBudget).toBeUndefined();
    expect(applyOfficialModelParameters(old, partial).maxThinkingBudget).toBeUndefined();
    expect(applyOfficialModelParameters(old, partial).defaultReasoningEffort).toBeUndefined();
  });

  it('represents native thinking with no effort enum honestly', () => {
    const result = applyOfficialModelParameters(freshModelDraft('native', 'messages'), spec({ thinking: true, reasoningEfforts: [], defaultReasoningEffort: undefined, reasoningEffortFormat: undefined, adaptiveThinking: false, minThinkingBudget: 1024, maxThinkingBudget: 63_999 }));
    expect(result).toMatchObject({ thinking: true, reasoningEfforts: [], minThinkingBudget: 1024, maxThinkingBudget: 63_999 });
    expect(result.defaultReasoningEffort).toBeUndefined();
  });

  it('caps the proposed output budget at the normal API ceiling and context', () => {
    const result = applyOfficialModelParameters(freshModelDraft(), spec({ contextWindow: 32_000, maxOutputTokens: 64_000, defaultOutputTokens: 300_000 }));
    expect(result.maxOutputTokens).toBe(32_000);
  });

  it('uses the Agent Plan Kimi limits instead of the original model limits', () => {
    const provider = { kind: 'openai-compatible' as const, presetId: 'volcengine-agent' as const, baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3' };
    const draft = { ...freshModelDraft('agent', 'responses'), upstreamId: 'kimi-k3' };
    const result = autoFillModelDraft(draft, lookupModelMetadata(draft.upstreamId, provider, draft.wireApi), untouched());
    expect(result).toMatchObject({ contextWindow: 1_024_000, maxInputTokens: 0, maxOutputTokens: 131_072, thinking: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max', reasoningEffortFormat: 'responses' });
  });

  it('keeps Gemini input and combined context as different limits', () => {
    const provider = { kind: 'openai-compatible' as const, presetId: 'custom' as const, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
    const draft = { ...freshModelDraft('google', 'chat-completions'), upstreamId: 'gemini-3.8-flash' };
    const result = autoFillModelDraft(draft, lookupModelMetadata(draft.upstreamId, provider, draft.wireApi), untouched());
    expect(result).toMatchObject({ contextWindow: 1_114_112, maxInputTokens: 1_048_576, maxOutputTokens: 65_536, thinking: true });
    expect(result.reasoningEfforts).not.toContain('minimal');
  });

  it('uses maintained thinking grades when the endpoint has no declared grades', () => {
    const provider = { kind: 'openai-compatible' as const, presetId: 'custom' as const, baseUrl: 'https://proxy.example.invalid/v1' };
    const draft = { ...freshModelDraft('proxy', 'chat-completions'), upstreamId: 'gemini-3.8-flash' };
    const result = autoFillModelDraft(draft, lookupModelMetadata(draft.upstreamId, provider, draft.wireApi), untouched());
    expect(result).toMatchObject({ thinking: true, reasoningEfforts: ['low', 'medium', 'high'], reasoningEffortFormat: 'chat-completions' });
  });

  it('fills only subscription thinking defaults without importing public limits or image capabilities', () => {
    const provider = { kind: 'copilot' as const, presetId: 'copilot-subscription' as const, baseUrl: '' };
    const draft = { ...freshModelDraft('account', 'chat-completions'), upstreamId: 'gemini-3.8-flash' };
    const result = autoFillModelDraft(draft, lookupModelMetadata(draft.upstreamId, provider, draft.wireApi), untouched(), lookupModelReasoningDefaults(draft.upstreamId, provider, draft.wireApi));
    expect(result).toMatchObject({ contextWindow: 0, maxInputTokens: 0, maxOutputTokens: 0, tools: false, vision: false, thinking: true, reasoningEfforts: ['low', 'medium', 'high'], reasoningEffortFormat: 'chat-completions' });
  });

  it('does nothing on explicit apply if no verified model parameters exist', () => {
    const old = { ...freshModelDraft(), id: 'existing', contextWindow: 123_000, tools: true };
    expect(applyOfficialModelParameters(old, undefined)).toBe(old);
  });

  it('allows adding all legal grades without losing custom choices', () => {
    const draft = { ...freshModelDraft('supplier', 'chat-completions'), thinking: true, reasoningEfforts: ['low', 'high'] as const, defaultReasoningEffort: 'high' as const };
    expect(reasoningSelectionPatch({ ...draft, reasoningEfforts: [...draft.reasoningEfforts] }, 'xhigh', true)).toEqual({ reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high', reasoningEffortFormat: 'chat-completions' });
    expect(reasoningSelectionPatch(freshModelDraft('supplier', 'responses'), 'medium', true)).toEqual({ reasoningEfforts: ['medium'], defaultReasoningEffort: undefined, reasoningEffortFormat: 'responses' });
  });

  it('clears a removed default and allows disabling the last grade', () => {
    const draft = { ...freshModelDraft(), reasoningEfforts: ['low', 'high'] as ('low' | 'high')[], defaultReasoningEffort: 'high' as const };
    const removed = reasoningSelectionPatch(draft, 'high', false);
    expect(removed).toEqual({ reasoningEfforts: ['low'], defaultReasoningEffort: undefined, reasoningEffortFormat: 'responses' });
    expect(reasoningSelectionPatch({ ...draft, ...removed }, 'low', false)).toEqual({ reasoningEfforts: [], defaultReasoningEffort: undefined, reasoningEffortFormat: undefined });
  });

  it('retains chosen grades while switching their export format with the protocol', () => {
    const draft = { ...freshModelDraft('supplier', 'chat-completions'), id: 'existing', reasoningEfforts: ['medium', 'xhigh'] as ('medium' | 'xhigh')[], defaultReasoningEffort: 'xhigh' as const, reasoningEffortFormat: 'chat-completions' as const };
    expect(withReasoningWireApi(draft, 'responses')).toMatchObject({ id: 'existing', wireApi: 'responses', reasoningEfforts: ['medium', 'xhigh'], defaultReasoningEffort: 'xhigh', reasoningEffortFormat: 'responses' });
    expect(withReasoningWireApi(freshModelDraft(), 'messages').reasoningEffortFormat).toBeUndefined();
  });

  it('explicit subscription thinking apply leaves all saved directory capabilities unchanged', () => {
    const provider = { kind: 'copilot' as const, presetId: 'copilot-subscription' as const, baseUrl: '' };
    const draft = { ...freshModelDraft('account', 'chat-completions'), id: 'existing', upstreamId: 'gemini-3.8-flash', contextWindow: 200_000, maxInputTokens: 120_000, maxOutputTokens: 8_000, vision: false, tools: true };
    const result = applyOfficialModelParameters(draft, undefined, lookupModelReasoningDefaults(draft.upstreamId, provider, draft.wireApi));
    expect(result).toMatchObject({ contextWindow: 200_000, maxInputTokens: 120_000, maxOutputTokens: 8_000, vision: false, tools: true, thinking: true, reasoningEfforts: ['low', 'medium', 'high'], reasoningEffortFormat: 'chat-completions' });
  });
});
