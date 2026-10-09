import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canStartToolSync, ToolAutoSync, type ToolAutoSyncState } from '../src/renderer/tool-auto-sync';
import type { ToolBinding, ToolId } from '../src/shared/types';

const binding = (name: string, id: ToolId = 'codex'): ToolBinding => ({ id, name: 'Synthetic tool', enabled: true, mode: 'direct',
  providerIds: [`provider-${name}`], modelIds: [`model-${name}`], defaultModelId: `model-${name}`, note: '' });
const deferred = () => { let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture(debounceMs = 400) {
  const writes: { tool: ToolId; binding: ToolBinding; automatic: boolean }[] = [];
  const states: { tool: ToolId; state?: ToolAutoSyncState }[] = [];
  const options = { debounceMs, apply: vi.fn(async (tool: ToolId, selection: ToolBinding, automatic: boolean) => {
    writes.push({ tool, binding: selection, automatic });
  }), state: (tool: ToolId, state?: ToolAutoSyncState) => { states.push({ tool, state }); } };
  return { coordinator: new ToolAutoSync(options), options, writes, states };
}

describe('interaction-triggered tool config debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not schedule writes on construction, navigation, or an empty flush', async () => {
    const f = fixture(); await f.coordinator.flush('codex'); await vi.advanceTimersByTimeAsync(5000);
    expect(f.writes).toEqual([]); expect(f.states).toEqual([]); expect(f.coordinator.pending()).toEqual([]);
  });

  it('applies the first explicit selection only after the debounce interval', async () => {
    const f = fixture(); f.coordinator.request('codex', binding('A'));
    await vi.advanceTimersByTimeAsync(399); expect(f.options.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.writes).toEqual([{ tool: 'codex', binding: binding('A'), automatic: true }]);
    expect(f.coordinator.pending()).toEqual([]); expect(f.states.at(-1)?.state).toBeUndefined();
  });

  it('combines rapid source, mode, default-model, and aggregate-selection changes into the last selection', async () => {
    const f = fixture(); f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(100);
    f.coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(100);
    const latest: ToolBinding = { ...binding('C'), mode: 'aggregate', modelSelection: 'selected', modelIds: ['model-C', 'model-D'], defaultModelId: 'model-D' };
    f.coordinator.request('codex', latest); await vi.advanceTimersByTimeAsync(399);
    expect(f.options.apply).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.map(write => write.binding)).toEqual([latest]);
  });

  it('keeps independent timers and writes for each tool', async () => {
    const f = fixture(), first = deferred(); f.options.apply.mockImplementationOnce(() => first.promise);
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(100);
    f.coordinator.request('vscode', binding('B', 'vscode')); await vi.advanceTimersByTimeAsync(300);
    expect(f.options.apply).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(100);
    expect(f.options.apply).toHaveBeenCalledTimes(2); expect(f.writes[0]?.tool).toBe('vscode'); first.resolve(); await Promise.resolve();
  });

  it('serializes an in-flight write and applies only the newest subsequent selection', async () => {
    const f = fixture(), first = deferred(); let running = 0, maxRunning = 0;
    f.options.apply.mockImplementation(async (tool, selection, automatic) => {
      running++; maxRunning = Math.max(maxRunning, running); f.writes.push({ tool, binding: selection, automatic });
      if (selection.defaultModelId === 'model-A') await first.promise;
      running--;
    });
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400);
    f.coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(100);
    f.coordinator.request('codex', binding('C')); await vi.advanceTimersByTimeAsync(500);
    expect(f.writes.map(write => write.binding.defaultModelId)).toEqual(['model-A']);
    first.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.writes.map(write => write.binding.defaultModelId)).toEqual(['model-A', 'model-C']); expect(maxRunning).toBe(1);
  });

  it('honors the remaining debounce time for a new choice when the prior write finishes early', async () => {
    const f = fixture(), first = deferred(); f.options.apply.mockImplementationOnce(() => first.promise);
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400);
    f.coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(100); first.resolve(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(299); expect(f.options.apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.options.apply).toHaveBeenLastCalledWith('codex', binding('B'), true);
  });

  it('flushes the newest selection immediately without a later duplicate write', async () => {
    const f = fixture(); f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(100);
    await f.coordinator.flush('codex', binding('B')); expect(f.writes).toEqual([{ tool: 'codex', binding: binding('B'), automatic: false }]);
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).toHaveBeenCalledTimes(1);
  });

  it('shares an identical in-flight write with manual flush and cancels a superseded deferred choice', async () => {
    const f = fixture(), first = deferred(); f.options.apply.mockImplementationOnce(() => first.promise);
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400);
    f.coordinator.request('codex', binding('B'));
    const manual = f.coordinator.flush('codex', binding('A'));
    expect(f.states.at(-1)?.state).toMatchObject({ phase: 'applying', signature: JSON.stringify(binding('A')) });
    first.resolve(); await manual;
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight write before immediately flushing the newer manual selection', async () => {
    const f = fixture(), first = deferred(); f.options.apply.mockImplementationOnce(() => first.promise);
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400);
    const manual = f.coordinator.flush('codex', binding('B')); expect(f.options.apply).toHaveBeenCalledTimes(1);
    first.resolve(); await manual; expect(f.options.apply).toHaveBeenLastCalledWith('codex', binding('B'), false);
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).toHaveBeenCalledTimes(2);
  });

  it('cancels deferred writes for undo or restoration and waits for any in-flight write', async () => {
    const f = fixture(), first = deferred(); f.coordinator.request('codex', binding('A'));
    await f.coordinator.cancel('codex'); await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).not.toHaveBeenCalled();
    f.options.apply.mockImplementationOnce(() => first.promise); f.coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(400);
    f.coordinator.request('codex', binding('C')); let cancelled = false;
    const cancellation = f.coordinator.cancel('codex').then(() => { cancelled = true; }); await Promise.resolve(); expect(cancelled).toBe(false);
    first.resolve(); await cancellation; await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).toHaveBeenCalledTimes(1);
    expect(f.coordinator.pending()).toEqual([]);
  });

  it('does not retry a failure until a new explicit interaction, and reports manual failures', async () => {
    const f = fixture(); f.options.apply.mockRejectedValueOnce(new Error('Synthetic write conflict'));
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400); await vi.advanceTimersByTimeAsync(2000);
    expect(f.options.apply).toHaveBeenCalledTimes(1); expect(f.states.at(-1)?.state).toMatchObject({ phase: 'error', message: expect.stringContaining('Synthetic write conflict') });
    f.coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(400); expect(f.options.apply).toHaveBeenCalledTimes(2);
    f.options.apply.mockRejectedValueOnce(new Error('Manual failure')); await expect(f.coordinator.flush('codex', binding('C'))).rejects.toThrow('Manual failure');
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).toHaveBeenCalledTimes(3);
  });

  it('waits outside the in-flight slot while another tool operation holds the lock', async () => {
    const f = fixture(); let available = false;
    const options = { ...f.options, available: vi.fn((_tool: ToolId, automatic: boolean) => !automatic || available) };
    const coordinator = new ToolAutoSync(options); coordinator.request('codex', binding('A'));
    await vi.advanceTimersByTimeAsync(500); expect(f.options.apply).not.toHaveBeenCalled(); expect(f.states.at(-1)?.state?.phase).toBe('waiting');
    available = true; await vi.advanceTimersByTimeAsync(25); expect(f.options.apply).toHaveBeenCalledExactlyOnceWith('codex', binding('A'), true);
    available = false; coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(500);
    await coordinator.cancel('codex'); await vi.advanceTimersByTimeAsync(500);
    expect(f.options.apply).toHaveBeenCalledTimes(1); expect(coordinator.pending()).toEqual([]);
  });

  it('can manually flush a waiting automatic request through the caller-owned manual lock', async () => {
    const f = fixture(), coordinator = new ToolAutoSync({ ...f.options, available: (_tool, automatic) => !automatic });
    coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(500);
    await coordinator.flush('codex'); await vi.advanceTimersByTimeAsync(500);
    expect(f.options.apply).toHaveBeenCalledExactlyOnceWith('codex', binding('A'), false);
  });

  it('serializes nearly simultaneous tool timers against the actual global write lock without losing either request', async () => {
    const f = fixture(), pendingActions = new Set<string>(), first = deferred();
    const coordinator = new ToolAutoSync({ ...f.options, available: (tool, automatic) => canStartToolSync(tool, automatic, pendingActions) });
    f.options.apply.mockImplementation(async (tool, selection, automatic) => {
      const key = `apply-tool-${tool}`; expect(pendingActions.size).toBe(0); pendingActions.add(key);
      f.writes.push({ tool, binding: selection, automatic });
      try { if (tool === 'codex') await first.promise; } finally { pendingActions.delete(key); }
    });
    coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(1);
    coordinator.request('claude-code', binding('B', 'claude-code')); await vi.advanceTimersByTimeAsync(400);
    expect(f.writes.map(write => write.tool)).toEqual(['codex']); expect(coordinator.pending()).toEqual(['codex', 'claude-code']);
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.apply).toHaveBeenCalledTimes(1);
    first.resolve(); await vi.advanceTimersByTimeAsync(25);
    expect(f.writes.map(write => write.tool)).toEqual(['codex', 'claude-code']); expect(coordinator.pending()).toEqual([]);
    expect(f.states.some(value => value.state?.phase === 'error')).toBe(false);
  });

  it('flushes through its own manual apply lock, but cancellation immediately releases a request waiting for another write', async () => {
    const f = fixture(), pendingActions = new Set(['apply-tool-codex']);
    const coordinator = new ToolAutoSync({ ...f.options, available: (tool, automatic) => canStartToolSync(tool, automatic, pendingActions) });
    coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(500);
    expect(f.options.apply).not.toHaveBeenCalled(); await coordinator.flush('codex');
    expect(f.options.apply).toHaveBeenCalledExactlyOnceWith('codex', binding('A'), false);
    pendingActions.add('restore-tool-rider'); coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(500);
    const manual = coordinator.flush('codex'); await coordinator.cancel('codex'); await manual;
    await vi.advanceTimersByTimeAsync(500); expect(f.options.apply).toHaveBeenCalledTimes(1); expect(coordinator.pending()).toEqual([]);
  });

  it('still applies a new explicit selection after an older in-flight selection fails', async () => {
    const f = fixture(), first = deferred(); f.options.apply.mockImplementationOnce(() => first.promise);
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400);
    f.coordinator.request('codex', binding('B')); await vi.advanceTimersByTimeAsync(500); first.reject(new Error('Old write failed')); await vi.advanceTimersByTimeAsync(0);
    expect(f.options.apply).toHaveBeenLastCalledWith('codex', binding('B'), true); expect(f.states.at(-1)?.state).toBeUndefined();
  });

  it('cancels pending work on unmount and never writes from a disposed coordinator', async () => {
    const f = fixture(); f.coordinator.request('codex', binding('A')); f.coordinator.dispose();
    f.coordinator.request('codex', binding('B')); await f.coordinator.flush('codex', binding('C')); await vi.advanceTimersByTimeAsync(1000);
    expect(f.options.apply).not.toHaveBeenCalled(); expect(f.coordinator.pending()).toEqual([]);
  });

  it('does not replay deferred work or publish state after an in-flight write finishes during unmount', async () => {
    const f = fixture(), first = deferred(); f.options.apply.mockImplementationOnce(() => first.promise);
    f.coordinator.request('codex', binding('A')); await vi.advanceTimersByTimeAsync(400);
    f.coordinator.request('codex', binding('B')); f.coordinator.dispose(); const statesBeforeFinish = f.states.length;
    first.resolve(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.options.apply).toHaveBeenCalledTimes(1); expect(f.states).toHaveLength(statesBeforeFinish); expect(f.coordinator.pending()).toEqual([]);
  });

  it('snapshots each selection rather than observing later caller mutation', async () => {
    const f = fixture(), value = binding('A'); f.coordinator.request('codex', value);
    value.defaultModelId = 'mutated'; value.modelIds.push('mutated'); await vi.advanceTimersByTimeAsync(400);
    expect(f.writes[0]?.binding).toEqual(binding('A'));
  });
});

describe('tool sync operation availability', () => {
  it('allows a clear lock and ignores unrelated read/save operations', () => {
    expect(canStartToolSync('codex', true, new Set())).toBe(true);
    expect(canStartToolSync('codex', true, new Set(['preview-vscode', 'export-tool-opencode', 'tool-binding-claude-code', 'refresh']))).toBe(true);
  });
  it.each(['delete', 'apply-tool-claude-code', 'restore-tool-opencode', 'undo-tool-vscode', 'apply-tool-rider', 'restore-tool-webstorm'])('waits for the global started operation %s', key => {
    expect(canStartToolSync('codex', true, new Set([key]))).toBe(false);
    expect(canStartToolSync('codex', false, new Set([key]))).toBe(false);
  });
  it.each(['tool-binding-codex', 'preview-codex', 'export-tool-codex'])('waits for its own pending operation %s', key => {
    expect(canStartToolSync('codex', true, new Set([key]))).toBe(false);
    expect(canStartToolSync('codex', false, new Set([key]))).toBe(false);
  });
  it('ignores only the caller-owned manual apply lock', () => {
    expect(canStartToolSync('codex', true, new Set(['apply-tool-codex']))).toBe(false);
    expect(canStartToolSync('codex', false, new Set(['apply-tool-codex']))).toBe(true);
    expect(canStartToolSync('codex', false, new Set(['apply-tool-codex', 'undo-tool-claude-code']))).toBe(false);
    expect(canStartToolSync('codex', false, new Set(['restore-tool-codex']))).toBe(false);
  });
});
