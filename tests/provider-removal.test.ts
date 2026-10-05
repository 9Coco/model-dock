import { describe, expect, it, vi } from 'vitest';
import type { Store, ProviderRemovalCheckpoint } from '../src/main/store';
import { removeProviderAndSync } from '../src/main/provider-removal';
import type { ToolId } from '../src/shared/types';

function setup(affected: ToolId[] = ['vscode', 'copilot', 'dsh']) {
  const checkpoint = { affectedToolIds: affected } as ProviderRemovalCheckpoint;
  let removed = false;
  const store = {
    beginProviderRemoval: vi.fn(() => { removed = true; return checkpoint; }),
    restoreProviderRemoval: vi.fn(() => { removed = false; }),
    finishProviderRemoval: vi.fn(),
  } as unknown as Pick<Store, 'beginProviderRemoval' | 'restoreProviderRemoval' | 'finishProviderRemoval'>;
  return { store, checkpoint, removed: () => removed };
}
describe('explicit provider removal and client synchronization', () => {
  it('synchronizes affected automatic clients once and finishes after all succeed', async () => {
    const fixture = setup(), synchronized: ToolId[] = [];
    await removeProviderAndSync(fixture.store, 'source', async tool => { expect(fixture.removed()).toBe(true); synchronized.push(tool); });
    expect(synchronized).toEqual(['vscode', 'copilot', 'dsh']);
    expect(fixture.store.finishProviderRemoval).toHaveBeenCalledWith(fixture.checkpoint);
    expect(fixture.store.restoreProviderRemoval).not.toHaveBeenCalled();
  });
  it('does not require an unrelated native app for an unbound source deletion', async () => {
    const fixture = setup([]), sync = vi.fn();
    await removeProviderAndSync(fixture.store, 'empty-template', sync);
    expect(sync).not.toHaveBeenCalled(); expect(fixture.removed()).toBe(true);
  });
  it('restores and repairs DSH after a failed DSH synchronization', async () => {
    const fixture = setup(['dsh']);
    const states: boolean[] = [];
    await expect(removeProviderAndSync(fixture.store, 'source', async tool => {
      expect(tool).toBe('dsh'); states.push(fixture.removed());
      if (fixture.removed()) throw new Error('PRIVATE_DSH_ERROR');
    })).rejects.toMatchObject({ category: 'restored' });
    expect(states).toEqual([true, false]); expect(fixture.removed()).toBe(false);
  });
  it('restores provider state before repairing both completed and partially failed clients', async () => {
    const fixture = setup(), states: Array<{ tool: ToolId; removed: boolean }> = [];
    let failed = false;
    await expect(removeProviderAndSync(fixture.store, 'source', async tool => {
      states.push({ tool, removed: fixture.removed() });
      if (tool === 'copilot' && !failed) { failed = true; throw new Error('PRIVATE_NATIVE_ERROR'); }
    })).rejects.toMatchObject({ category: 'restored' });
    expect(states).toEqual([{ tool: 'vscode', removed: true }, { tool: 'copilot', removed: true }, { tool: 'vscode', removed: false }, { tool: 'copilot', removed: false }]);
    expect(fixture.removed()).toBe(false); expect(fixture.store.finishProviderRemoval).not.toHaveBeenCalled();
  });
  it('reports external repair failure without losing the restored provider or exposing native errors', async () => {
    const fixture = setup(['copilot']);
    await expect(removeProviderAndSync(fixture.store, 'source', async () => { throw new Error('PRIVATE_API_KEY'); })).rejects.toMatchObject({ category: 'external' });
    expect(fixture.removed()).toBe(false);
  });
  it('preserves recovery authority on conflicting restore and does not overwrite client state', async () => {
    const fixture = setup(['vscode']);
    vi.mocked(fixture.store.restoreProviderRemoval).mockImplementation(() => { throw new Error('PRIVATE_CONFLICT'); });
    const sync = vi.fn(async () => { throw new Error('PRIVATE_FAILURE'); });
    await expect(removeProviderAndSync(fixture.store, 'source', sync)).rejects.toMatchObject({ category: 'recovery' });
    expect(sync).toHaveBeenCalledTimes(1);
  });
  it('refuses concurrent global deletions while allowing later operations', async () => {
    const fixture = setup(['vscode']); let release!: () => void;
    const wait = new Promise<void>(done => { release = done; });
    const first = removeProviderAndSync(fixture.store, 'source', async () => wait);
    await expect(removeProviderAndSync(fixture.store, 'other', async () => {})).rejects.toMatchObject({ category: 'busy' });
    release(); await first;
    await removeProviderAndSync(fixture.store, 'later', async () => {});
    expect(fixture.store.beginProviderRemoval).toHaveBeenCalledTimes(2);
  });
  it('refuses native operations when local backup preparation fails', async () => {
    const fixture = setup(), sync = vi.fn();
    vi.mocked(fixture.store.beginProviderRemoval).mockImplementation(() => { throw new Error('PRIVATE_CODEC_ERROR'); });
    await expect(removeProviderAndSync(fixture.store, 'source', sync)).rejects.toMatchObject({ category: 'preparation' });
    expect(sync).not.toHaveBeenCalled();
  });
});
