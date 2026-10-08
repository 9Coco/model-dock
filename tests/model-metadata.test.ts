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
    ['gemini-2.5-pro', 1_048_576, true],
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
    expect(metadata).toMatchObject({ contextWindow, vision, verifiedAt: '2026-10-08' });
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
});
