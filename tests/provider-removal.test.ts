import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type ProviderRemovalCheckpoint } from '../src/main/store';
import { buildConfig } from '../src/main/adapters';
import { removeProviderAndSync } from '../src/main/provider-removal';
import type { ToolBinding, ToolId } from '../src/shared/types';

function setup(affected: ToolId[] = ['vscode', 'copilot', 'dsh']) {
  const beforeBindings: ToolBinding[] = affected.map(id => ({ id, name: id, enabled: true, mode: 'aggregate', providerIds: ['source'], modelIds: ['source-model'], modelSelection: 'selected', defaultModelId: 'source-model', note: '' }));
  const checkpoint: ProviderRemovalCheckpoint = { id: 'removal', providerId: 'source', backupPath: 'encrypted-backup', affectedToolIds: affected, beforeBindings,
    afterBindings: beforeBindings.map(binding => ({ ...binding, enabled: false, providerIds: [], modelIds: [], defaultModelId: '' })) };
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
    const failure = await removeProviderAndSync(fixture.store, 'source', async () => { throw new Error('PRIVATE_API_KEY'); }).catch(error => error);
    expect(failure).toMatchObject({ category: 'external', toolId: 'copilot' });
    expect(failure.message).toContain('GitHub Copilot');
    expect(failure.message).not.toContain('PRIVATE_API_KEY');
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
  it.each(['beforeBindings', 'afterBindings'] as const)('restores instead of applying when the checkpoint lacks %s', async field => {
    const fixture = setup(['copilot']), sync = vi.fn();
    fixture.checkpoint[field] = [];
    await expect(removeProviderAndSync(fixture.store, 'source', sync)).rejects.toMatchObject({ category: 'restored' });
    expect(sync).not.toHaveBeenCalled(); expect(fixture.removed()).toBe(false);
    expect(fixture.store.finishProviderRemoval).not.toHaveBeenCalled();
  });
});

const stores: Store[] = [], directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function storedSelection() {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-removal-')); directories.push(directory);
  const codec = { encrypt: (value: string) => `test:${Buffer.from(value).toString('base64')}`, decrypt: (value: string) => Buffer.from(value.slice(5), 'base64').toString() };
  const store = await Store.create(directory, codec); stores.push(store);
  const source = store.saveProvider({ name: 'Expired client import', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(source.id, { accessToken: 'synthetic-expired-access', expiresAt: 1 });
  const keeper = store.saveProvider({ name: 'Current source', kind: 'openai-compatible', baseUrl: 'https://keeper.example.test/v1', enabled: true, apiKey: 'synthetic-api-key' });
  const model = (providerId: string, alias: string) => store.saveModel({ providerId, alias, upstreamId: alias, displayName: alias, wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const oldModel = model(source.id, 'expired-model'), keptModel = model(keeper.id, 'kept-model');
  const binding = (id: ToolId) => store.listBindings().find(binding => binding.id === id)!;
  return { store, source, keeper, oldModel, keptModel, binding };
}
describe('provider removal with stored active and inactive tool selections', () => {
  it('prunes a disabled native-client selection without requiring the native app', async () => {
    const { store, source, oldModel, binding } = await storedSelection();
    store.saveBinding({ ...binding('copilot'), enabled: false, mode: 'aggregate', providerIds: [source.id], modelIds: [oldModel.id], modelSelection: 'selected', defaultModelId: oldModel.id });
    const checkpoint = vi.spyOn(store, 'beginProviderRemoval'), sync = vi.fn(async () => { throw new Error('Native client must not be opened'); });
    await removeProviderAndSync(store, source.id, sync);
    expect(sync).not.toHaveBeenCalled(); expect(store.getProvider(source.id)).toBeUndefined();
    expect(binding('copilot')).toMatchObject({ enabled: false, providerIds: [], modelIds: [], defaultModelId: '' });
    expect(checkpoint.mock.results[0].value).toMatchObject({ affectedToolIds: ['copilot'], beforeBindings: [{ id: 'copilot', providerIds: [source.id] }], afterBindings: [{ id: 'copilot', providerIds: [] }] });
  });
  it('clears only an inactive draft while preserving the active Codex connection without syncing it', async () => {
    const { store, source, keeper, oldModel, keptModel, binding } = await storedSelection();
    store.saveBinding({ ...binding('codex'), enabled: true, mode: 'direct', providerIds: [keeper.id], modelIds: [], modelSelection: 'all', defaultModelId: keptModel.id,
      connectionChoices: { aggregate: { providerIds: [source.id], modelIds: [oldModel.id], modelSelection: 'selected', defaultModelId: oldModel.id } } });
    const before = binding('codex'), previewBefore = buildConfig(store, 'codex', 18181).content;
    const checkpoint = vi.spyOn(store, 'beginProviderRemoval'), sync = vi.fn(async () => { throw new Error('Active connection must not be reapplied'); });
    await removeProviderAndSync(store, source.id, sync);
    expect(sync).not.toHaveBeenCalled(); expect(store.getProvider(source.id)).toBeUndefined();
    expect(binding('codex')).toEqual({ ...before, connectionChoices: { ...before.connectionChoices, aggregate: { providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '' } } });
    expect(buildConfig(store, 'codex', 18181).content).toBe(previewBefore);
    expect(checkpoint.mock.results[0].value.affectedToolIds).toEqual(['codex']);
  });
  it('synchronizes cleanup when removing the only source disables an enabled native client', async () => {
    const { store, source, oldModel, binding } = await storedSelection();
    store.saveBinding({ ...binding('copilot'), enabled: true, mode: 'aggregate', providerIds: [source.id], modelIds: [oldModel.id], modelSelection: 'selected', defaultModelId: oldModel.id });
    expect(JSON.parse(buildConfig(store, 'copilot', 18181).content).providers).toHaveLength(1);
    const sync = vi.fn(async (tool: ToolId) => {
      expect(tool).toBe('copilot'); expect(store.getProvider(source.id)).toBeUndefined();
      expect(binding(tool).enabled).toBe(false);
      expect(JSON.parse(buildConfig(store, tool, 18181).content).providers).toEqual([]);
    });
    await removeProviderAndSync(store, source.id, sync);
    expect(sync).toHaveBeenCalledExactlyOnceWith('copilot');
  });
  it('synchronizes a remaining active source after removing the expired selection', async () => {
    const { store, source, keeper, oldModel, keptModel, binding } = await storedSelection();
    store.saveBinding({ ...binding('codex'), enabled: true, mode: 'aggregate', providerIds: [source.id, keeper.id], modelIds: [oldModel.id, keptModel.id], modelSelection: 'selected', defaultModelId: oldModel.id });
    const sync = vi.fn(async (tool: ToolId) => {
      expect(binding(tool)).toMatchObject({ enabled: true, providerIds: [keeper.id], modelIds: [keptModel.id] });
      const preview = buildConfig(store, tool, 18181).content;
      expect(preview).toContain('kept-model'); expect(preview).not.toContain('expired-model');
    });
    await removeProviderAndSync(store, source.id, sync);
    expect(sync).toHaveBeenCalledExactlyOnceWith('codex'); expect(store.getProvider(source.id)).toBeUndefined();
  });
  it('restores disabled selections as well as active selections after active-client synchronization fails', async () => {
    const { store, source, oldModel, binding } = await storedSelection();
    for (const id of ['copilot', 'opencode'] as const) store.saveBinding({ ...binding(id), enabled: id === 'opencode', mode: 'aggregate', providerIds: [source.id], modelIds: [oldModel.id], modelSelection: 'selected', defaultModelId: oldModel.id });
    const before = store.listBindings();
    const sync = vi.fn(async (tool: ToolId) => {
      expect(tool).toBe('opencode');
      if (!store.getProvider(source.id)) throw new Error('Synthetic active-client failure');
    });
    await expect(removeProviderAndSync(store, source.id, sync)).rejects.toMatchObject({ category: 'restored' });
    expect(sync.mock.calls).toEqual([['opencode'], ['opencode']]);
    expect(store.getProvider(source.id)).toBeDefined(); expect(store.listBindings()).toEqual(before);
  });
});
