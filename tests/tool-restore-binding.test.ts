import { describe, expect, it } from 'vitest';
import type { ToolBinding } from '../src/shared/types';
import { restoreToolBinding } from '../src/main/tool-restore-binding';

function fixture() {
  let binding: ToolBinding = { id: 'codex', name: 'Codex', enabled: true, mode: 'aggregate', providerIds: ['source'], modelIds: ['model'], modelSelection: 'selected', defaultModelId: 'model', note: 'retain' };
  const backups: unknown[] = [];
  const store = {
    listBindings: () => [structuredClone(binding)],
    saveBinding: (value: ToolBinding) => { binding = structuredClone(value); },
    createManagedBackup: (_kind: string, value: unknown) => { backups.push(structuredClone(value)); return 'private-backup'; },
  };
  return { store, backups };
}

describe('official restoration selection transaction', () => {
  it('backs up and disables the tool route before native restoration, then retains an empty selection', async () => {
    const { store, backups } = fixture();
    await expect(restoreToolBinding(store, 'codex', async () => {
      expect(backups).toHaveLength(1);
      expect(store.listBindings()[0]).toMatchObject({ enabled: false, providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '' });
      return 'config.toml';
    })).resolves.toBe('config.toml');
    expect(store.listBindings()[0]).toMatchObject({ mode: 'direct', enabled: false, note: 'retain' });
  });
  it('returns the prior exact model scope if native restoration fails', async () => {
    const { store } = fixture(), previous = store.listBindings()[0];
    await expect(restoreToolBinding(store, 'codex', async () => { throw new Error('native rejected'); })).rejects.toThrow('native rejected');
    expect(store.listBindings()[0]).toEqual(previous);
  });
  it('does not alter binding or invoke native writes if backup cannot be saved', async () => {
    const { store } = fixture(), previous = store.listBindings()[0];
    let called = false;
    store.createManagedBackup = () => { throw new Error('backup failed'); };
    await expect(restoreToolBinding(store, 'codex', async () => { called = true; return ''; })).rejects.toThrow('backup failed');
    expect(called).toBe(false); expect(store.listBindings()[0]).toEqual(previous);
  });
});
