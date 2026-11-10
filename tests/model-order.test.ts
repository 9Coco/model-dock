import { describe, expect, it } from 'vitest';
import { groupModelsBySeries } from '../src/shared/model-order';

const grouped = (...ids: string[]) => groupModelsBySeries(ids.map(upstreamId => ({ upstreamId })))
  .map(({ key, models }) => [key, models.map(m => m.upstreamId)]);

describe('model discovery order', () => {
  it('keeps the GPT family first and compares multi-part versions numerically', () => {
    expect(grouped('tts-1', 'gpt-4o-mini-tts-2025-03-20', 'o3-mini', 'gpt-5.2', 'gpt-4o',
      'gpt-5.4-nano-2026-03-17', 'gpt-5.10', 'gpt-4', 'o4-mini', 'gpt-image-1')).toEqual([
      ['gpt', ['gpt-5.10', 'gpt-5.4-nano-2026-03-17', 'gpt-5.2', 'gpt-4o', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4']],
      ['openai-o', ['o4-mini', 'o3-mini']], ['gpt-image', ['gpt-image-1']], ['tts', ['tts-1']],
    ]);
  });

  it('places undated IDs ahead of explicit snapshots of the same generation, then sorts snapshots newest first', () => {
    expect(grouped('anthropic/claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-4-5-sonnet-2026-09-01',
      'claude-sonnet-4-10', 'claude-sonnet-4-6-20251001')).toEqual([
      ['claude', ['claude-sonnet-4-10', 'claude-sonnet-4-6-20251001', 'claude-sonnet-4-5',
        'claude-4-5-sonnet-2026-09-01', 'anthropic/claude-sonnet-4-5-20250929']],
    ]);
    expect(grouped('gpt-4-1106-preview', 'gpt-4.1')).toEqual([['gpt', ['gpt-4.1', 'gpt-4-1106-preview']]]);
  });

  it('recognizes namespaced IDs, family-specific version markers and parameter counts', () => {
    expect(grouped('Qwen/Qwen3-32B', 'qwen3.5-7b', 'Qwen3-8B', 'DeepSeek-V4.1-flash', 'deepseek-ai/DeepSeek-R1',
      'Kimi-K2.7-code', 'moonshotai/kimi-k3', 'minimax-m3', 'MiniMax-M2.5', 'models/gemini-2.5-flash', 'gemini-3.1-pro')).toEqual([
      ['deepseek', ['DeepSeek-V4.1-flash', 'deepseek-ai/DeepSeek-R1']],
      ['gemini', ['gemini-3.1-pro', 'models/gemini-2.5-flash']],
      ['kimi', ['moonshotai/kimi-k3', 'Kimi-K2.7-code']], ['minimax', ['minimax-m3', 'MiniMax-M2.5']],
      ['qwen', ['qwen3.5-7b', 'Qwen3-8B', 'Qwen/Qwen3-32B']],
    ]);
  });

  it('sorts custom series and preserves opaque IDs, even when the upstream order changes', () => {
    const ids = ['acme/sonic-v2', 'other/sonic-v9', 'acme/sonic-v12', 'acme/sonic-latest', 'acme/sonic', 'orbit2', 'orbit10', 'constructor'];
    const expected = [
      ['acme/sonic', ['acme/sonic-v12', 'acme/sonic-v2', 'acme/sonic', 'acme/sonic-latest']],
      ['orbit', ['orbit10', 'orbit2']], ['other/sonic', ['other/sonic-v9']], ['#other', ['constructor']],
    ];
    expect(grouped(...ids)).toEqual(expected);
    expect(grouped(...ids.reverse())).toEqual(expected);
    for (const id of ['constructor', 'prototype']) {
      expect(groupModelsBySeries([{ upstreamId: id + '-v1' }])[0].label).toBe(id);
    }
  });

  it('offers the actual families in a mixed TRAE directory, independent of editable names', () => {
    const ids = [
      'Doubao-Seed-2.1-Turbo', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-Evolving', 'Doubao-Seed-Code', 'Doubao_1_6',
      'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'deepseek-v4.1-flash', 'DeepSeek-V4-Pro-Official',
      'kimi-k3', 'mimo-v2.6-flash', 'minimax-m3.1-fast', 'qwen3.8-max', 'step-3.5-preview',
    ];
    const groups = groupModelsBySeries(ids.map(upstreamId => ({ upstreamId, displayName: 'edited' })), 'trae-client');
    expect(groups.map(group => group.label)).toEqual(['DeepSeek', 'GLM', 'Kimi', 'MiMo', 'MiniMax', 'Qwen', 'Seed', 'Step']);
    expect(groups.find(g => g.label === 'Seed')?.models.map(m => m.upstreamId)).toEqual([
      'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Turbo', 'Doubao_1_6', 'Doubao-Seed-Code', 'Doubao-Seed-Evolving',
    ]);
    expect(grouped('Seed-Evolving', 'Seed-2.1-Pro-0915', 'Seed-Code')).toEqual([
      ['seed', ['Seed-2.1-Pro-0915', 'Seed-Code', 'Seed-Evolving']],
    ]);
    expect(grouped('Doubao_1_6')[0][0]).not.toBe('seed');
  });

  it('collects opaque IDs in a single final group', () => {
    const ids = ['unknown-fixture-model', 'abcdef12-ffff-aefb-904e-123456789abc', '__proto__', 'seed-code'];
    const groups = groupModelsBySeries(ids.map(upstreamId => ({ upstreamId })));
    expect(groups.map(group => group.label)).toEqual(['Seed', '其他']);
    expect(groups[1].models.map(m => m.upstreamId).sort()).toEqual(ids.slice(0, 3).sort());
  });

  it('uses only the upstream ID and retains editable rows and input order by reference', () => {
    const old = Object.freeze({ upstreamId: 'gpt-5.1', alias: 'newest', displayName: 'Z', selected: true });
    const newer = Object.freeze({ upstreamId: 'gpt-5.5', alias: 'old', displayName: 'A', selected: false });
    const input = Object.freeze([old, newer]);
    const [group] = groupModelsBySeries(input);
    expect(group.models[0]).toBe(newer);
    expect(group.models[1]).toBe(old);
    expect(input[0]).toBe(old);
  });
});
