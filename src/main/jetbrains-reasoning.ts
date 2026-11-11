import type { ReasoningEffort } from '../shared/types';

/** Public IDE 2026.2 / ej-262.2144.130.jar:
 * LLM.jbaiId + EffortLevel.availableForModel/defaultForModel/getWireId.
 * The V9 directory declares parameter names, not the allowed effort values.
 * Intersect this exact-ID snapshot with the current account's reasoningEffort
 * descriptor. Never infer support from a vendor, display name or UI slider.
 * LLMConfig's verified V9 field is parameters.reasoningEffort (a string).
 */
export interface JetBrainsReasoning { levels: ReasoningEffort[]; defaultLevel: ReasoningEffort }
type Family = 'openai' | 'anthropic' | 'google' | 'xai';
const profiles = new Map<string, JetBrainsReasoning & { family: Family }>();
function add(family: Family, ids: string[], levels: ReasoningEffort[], defaultLevel: ReasoningEffort) {
  for (const id of ids) profiles.set(id, { family, levels, defaultLevel });
}
add('anthropic', ['anthropic-claude-4-5-opus', 'anthropic-claude-4-6-opus', 'anthropic-claude-4-6-sonnet'], ['low', 'medium', 'high', 'max'], 'low');
add('anthropic', ['anthropic-claude-4-7-opus', 'anthropic-claude-4-8-opus', 'claude-opus-5', 'anthropic-claude-opus-5-5',
  'anthropic-claude-sonnet-5', 'anthropic-claude-sonnet-5-5', 'anthropic-claude-fable-5', 'anthropic-claude-fable-5-1'], ['low', 'medium', 'high', 'xhigh', 'max'], 'low');
add('anthropic', ['anthropic-claude-haiku-5-5'], ['low', 'medium', 'high', 'xhigh'], 'high');
add('openai', ['openai-gpt-5'], ['minimal', 'low', 'medium', 'high'], 'low');
add('openai', ['openai-gpt-5-1', 'openai-gpt-5-2-codex', 'openai-gpt-5-4-mini', 'openai-gpt-5-4-nano', 'openai-gpt-5-mini', 'openai-gpt-5-nano',
  'openai-gpt-5-1-codex', 'openai-gpt-5-1-codex-mini', 'openai-gpt-5-1-codex-max'], ['low', 'medium', 'high'], 'low');
add('openai', ['openai-gpt-5-2', 'openai-gpt-5-3-codex', 'openai-gpt-5-4', 'openai-gpt-5-5'], ['low', 'medium', 'high', 'xhigh'], 'low');
add('openai', ['openai-gpt-5-6-sol', 'openai-gpt-5-6-terra', 'openai-gpt-5-6-luna', 'openai-gpt-6-sol', 'openai-gpt-6-1-sol', 'openai-gpt-6-luna'], ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'low');
add('openai', ['openai-gpt-6-astra'], ['low', 'medium', 'high', 'xhigh', 'max'], 'low');
add('google', ['google-gemini-3-0-pro', 'google-gemini-3-1-pro', 'google-gemini-3-0-flash', 'google-gemini-3-5-flash'], ['low', 'medium', 'high'], 'high');
add('google', ['google-gemini-3-6-flash', 'google-gemini-3-1-flash-lite', 'google-gemini-3-5-flash-lite'], ['minimal', 'low', 'medium', 'high'], 'high');
add('google', ['google-gemini-3-7-flash', 'google-gemini-3-8-flash'], ['minimal', 'low', 'medium', 'high'], 'medium');
add('google', ['google-gemini-4-argon'], ['low', 'medium', 'high'], 'medium');
add('xai', ['xai-grok-4-6', 'xai-grok-4-7'], ['low', 'medium', 'high', 'xhigh'], 'low');

const families: Record<string, Family | undefined> = { OpenAI: 'openai', AzureOpenAI: 'openai', Anthropic: 'anthropic', GoogleVertexAnthropic: 'anthropic', Bedrock: 'anthropic', Google: 'google', Xai: 'xai' };
export function jetBrainsReasoning(profileId: string, provider: string, parameters: unknown): JetBrainsReasoning | undefined {
  const known = profiles.get(profileId);
  if (!known || families[provider] !== known.family || !Array.isArray(parameters) || !parameters.includes('reasoningEffort')) return;
  return { levels: [...known.levels], defaultLevel: known.defaultLevel };
}
