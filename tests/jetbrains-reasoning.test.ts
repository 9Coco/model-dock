import { describe, expect, it } from 'vitest';
import { jetBrainsReasoning } from '../src/main/jetbrains-reasoning';
import { prepareJetBrainsGrazieChat } from '../src/main/jetbrains-grazie-bridge';

describe('verified native JetBrains reasoning', () => {
  it.each([
    ['anthropic-claude-opus-5-5', 'Anthropic', ['low', 'medium', 'high', 'xhigh', 'max'], 'low'],
    ['anthropic-claude-haiku-5-5', 'Anthropic', ['low', 'medium', 'high', 'xhigh'], 'high'],
    ['google-gemini-3-8-flash', 'Google', ['minimal', 'low', 'medium', 'high'], 'medium'],
    ['openai-gpt-6-1-sol', 'OpenAI', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'low'],
    ['openai-gpt-6-astra', 'OpenAI', ['low', 'medium', 'high', 'xhigh', 'max'], 'low'],
    ['xai-grok-4-7', 'Xai', ['low', 'medium', 'high', 'xhigh'], 'low'],
  ])('keeps %s native levels/default and writes each selected value to the V9 wire', (id, provider, levels, defaultLevel) => {
    const reasoning = jetBrainsReasoning(String(id), String(provider), ['reasoningEffort'])!;
    expect(reasoning).toEqual({ levels, defaultLevel });
    for (const level of reasoning.levels) {
      const request = prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: 'fixture' }], reasoning_effort: level }, { profileId: String(id), reasoningEfforts: reasoning.levels });
      expect(request.parameters).toEqual({ reasoningEffort: level });
      expect(request).not.toHaveProperty('reasoning_effort');
    }
    reasoning.levels.push('minimal');
    expect(jetBrainsReasoning(String(id), String(provider), ['reasoningEffort'])?.levels).toEqual(levels);
  });
  it.each([
    ['anthropic-claude-opus-5-5', 'Anthropic', []],
    ['anthropic-claude-opus-5-5', 'Anthropic', ['thinkingBudget']],
    ['anthropic-claude-opus-5-5', 'Anthropic', { reasoningEffort: true }],
    ['anthropic-claude-opus-5-5', 'Google', ['reasoningEffort']],
    ['claude-opus-5-5', 'Anthropic', ['reasoningEffort']],
    ['bedrock-anthropic-claude-opus-5-5', 'Bedrock', ['reasoningEffort']],
    ['future-unknown', 'Anthropic', ['reasoningEffort']],
  ])('does not invent capability for an unverified profile/descriptor: %s', (id, provider, parameters) => {
    expect(jetBrainsReasoning(String(id), String(provider), parameters)).toBeUndefined();
  });
  it.each([null, 42, {}, '', 'HIGH', 'ultra', 'none'])('rejects malformed/unsupported requested effort %j', reasoning_effort => {
    expect(() => prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: 'q' }], reasoning_effort }, { profileId: 'claude', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] })).toThrow();
  });
  it('leaves omitted controls to the upstream instead of enabling a costlier default', () => {
    expect(prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: 'q' }] }, { profileId: 'claude', reasoningEfforts: ['low', 'max'] }).parameters).toEqual({});
  });
});
