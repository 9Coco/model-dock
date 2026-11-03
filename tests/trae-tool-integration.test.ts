import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../src/main/store';
import { buildTraePlan, type TraeModelConfiguration, type TraePlanStore } from '../src/main/trae-config';
import { applyTraeModels, TraeNativeMutationError, traeSyncUndoKey, type TraeNativeClient, type TraeNativeModel } from '../src/main/trae-sync';
import { ToolSyncUndoManager, toolSyncUndoKey, type ToolSyncUndoStore } from '../src/main/tool-sync-undo';
import { restoreOfficialConfig } from '../src/main/tool-restore';
import { restoreToolBinding } from '../src/main/tool-restore-binding';
import { removeProviderAndSync } from '../src/main/provider-removal';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const copy = <T>(value: T): T => structuredClone(value);
function directory() { const root = mkdtempSync(join(tmpdir(), 'modeldock-trae-tools-')); roots.push(root); return root; }

/** Optional failure evidence for native Windows runs. Keep all production
 * exceptions intact; record only fixed operation names and OS error codes,
 * never state payloads, keys, paths, native responses or error messages. */
type StoreDiagnosticStage = 'fixture-setup' | 'fixture-initial-sync' | 'ready' | 'remove-first' | 'remove-last' | 'remove-rejected';
function diagnoseStore(store: Store): (stage: StoreDiagnosticStage) => void {
  if (process.env.MODELDOCK_TEST_STORE_DIAGNOSTICS !== '1') return () => {};
  let stage: StoreDiagnosticStage = 'fixture-setup';
  const methods = ['persist', 'setManagedState', 'createManagedBackup', 'saveProvider', 'saveModel', 'saveBinding', 'beginProviderRemoval', 'restoreProviderRemoval', 'finishProviderRemoval'] as const;
  const instrumented = store as unknown as Record<typeof methods[number], (...args: unknown[]) => unknown>;
  for (const operation of methods) {
    const original = instrumented[operation].bind(store);
    instrumented[operation] = (...args: unknown[]) => {
      try { return original(...args); }
      catch (error) {
        const metadata = error as { code?: unknown; syscall?: unknown; errno?: unknown };
        const code = typeof metadata?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(metadata.code) ? metadata.code : 'NO_OS_CODE';
        const syscall = typeof metadata?.syscall === 'string' && /^[a-z_]{1,40}$/.test(metadata.syscall) ? metadata.syscall : undefined;
        process.stderr.write(`[trae-store-diagnostic] ${JSON.stringify({ stage, operation, code, ...(syscall ? { syscall } : {}), ...(typeof metadata?.errno === 'number' ? { errno: metadata.errno } : {}) })}\n`);
        throw error;
      }
    };
  }
  return value => { stage = value; };
}

/** Only the native RPC boundary is faked. Revisions change even on a key-only
 * edit, and newly created native rows always receive a fresh ID. */
function fakeTraeNativeClient(targetId: string) {
  const rows = new Map<string, TraeNativeModel>();
  let sequence = 0, rejectNextDeletion = false;
  const snapshot = (id: string, configuration: TraeModelConfiguration): TraeNativeModel => ({
    id, configuration: { ...copy(configuration), ak: '' }, enabled: true,
    fingerprint: `metadata-${++sequence}`, revision: `revision-${sequence}`, credentialRevision: `key-revision-${sequence}`,
  });
  const client: TraeNativeClient = {
    targetId,
    listModels: async () => [...rows.values()].map(copy),
    addModel: async configuration => { const row = snapshot(`native-${++sequence}`, configuration); rows.set(row.id, row); return copy(row); },
    updateModel: async (id, configuration) => {
      if (!rows.has(id)) throw new TraeNativeMutationError('not-applied');
      const row = snapshot(id, configuration); rows.set(id, row); return copy(row);
    },
    deleteModel: async id => {
      if (rejectNextDeletion) { rejectNextDeletion = false; throw new TraeNativeMutationError('not-applied'); }
      rows.delete(id);
    },
    close: vi.fn(),
  };
  return { client, rows, options: { openClient: vi.fn(async () => client) }, rejectDeletion: () => { rejectNextDeletion = true; } };
}

function fixture() {
  const root = directory(), target = join(root, 'appdata', 'Trae CN'), native = fakeTraeNativeClient(target);
  const states = new Map<string, unknown>();
  const original: ToolBinding = { id: 'trae', name: 'Trae CN', note: 'Original note', enabled: false, mode: 'direct', providerIds: [], modelIds: [], defaultModelId: '' };
  let binding = copy(original), backupNumber = 0;
  const provider: Provider = { id: 'source', name: 'Synthetic API', kind: 'openai-compatible', baseUrl: 'https://provider.example.test/v1', enabled: true, authStatus: 'ready', hasSecret: true, note: '' };
  const models: Model[] = ['first', 'second'].map(id => ({ id, providerId: provider.id, upstreamId: `upstream-${id}`, alias: `alias-${id}`, displayName: id,
    wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true }));
  const store: ToolSyncUndoStore & TraePlanStore & { saveBinding(value: ToolBinding): void } = {
    dataDir: root,
    getManagedState: <T>(key: string, fallback: T): T => copy(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, copy(value)); }),
    createManagedBackup: vi.fn(() => join(root, 'backups', `synthetic-${++backupNumber}.enc`)),
    listBindings: () => [copy(binding)], saveBinding: value => { binding = copy(value); },
    restoreBindingSelection: vi.fn(value => { binding = { ...copy(value), name: binding.name, note: binding.note }; }),
    listModels: () => copy(models), listProviders: () => [copy(provider)],
    gatewayKey: () => 'SYNTHETIC_GATEWAY_KEY', getSecret: () => ({ apiKey: 'SYNTHETIC_PROVIDER_KEY' }),
  };
  const manager = new ToolSyncUndoManager(store, { appData: join(root, 'appdata'), homeDirectory: root, traeTarget: target, traeOptions: native.options });
  const select = (ids: string[]) => {
    const before = copy(binding);
    binding = { ...binding, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: ids, modelSelection: 'selected', defaultModelId: ids[0] ?? '' };
    return before;
  };
  const sync = (before?: ToolBinding) => manager.run('trae', before, () => applyTraeModels(store, buildTraePlan(store, 18181, true), target, native.options));
  const names = () => [...native.rows.values()].map(row => row.configuration.model_name).sort();
  const codexPath = join(root, '.codex', 'config.toml'), codexContents = 'model_provider="unrelated"\nmodel="leave-me-alone"\n';
  mkdirSync(dirname(codexPath), { recursive: true }); writeFileSync(codexPath, codexContents);
  const restore = () => restoreToolBinding(store, 'trae', () => restoreOfficialConfig(store, 'trae', join(root, 'appdata'), join(root, 'backups'), root,
    { traeTarget: target, traeOptions: native.options }));
  return { root, target, native, states, original, store, manager, models, select, sync, names, codexPath, codexContents, restore, binding: () => copy(binding) };
}

describe('Trae public tool lifecycle integration', () => {
  it('applies and undoes native models and the source selection without treating Trae as a Codex file adapter', async () => {
    const f = fixture(), before = f.select(['first']);
    expect(f.manager.status('trae').available).toBe(false);
    expect(f.native.options.openClient).not.toHaveBeenCalled();
    expect(await f.sync(before)).toBe(f.target);
    expect(f.names()).toEqual(['alias-first']); expect(f.manager.status('trae').available).toBe(true);
    f.store.saveBinding({ ...f.binding(), note: 'User changed note after sync' });
    expect(await f.manager.undo('trae')).toBe(f.target);
    expect(f.names()).toEqual([]);
    expect(f.binding()).toEqual({ ...f.original, note: 'User changed note after sync' });
    expect(f.manager.status('trae').available).toBe(false);
    expect(readFileSync(f.codexPath, 'utf8')).toBe(f.codexContents);
  });

  it('preserves the last material undo through repeated synchronization, including an explicitly empty selection', async () => {
    const f = fixture();
    await f.sync(); // A first empty sync must succeed without inventing an undo.
    expect(f.manager.status('trae').available).toBe(false);
    await f.sync(f.select(['first']));
    const firstCheckpoint = copy(f.states.get(toolSyncUndoKey('trae')));
    await f.sync(); expect(f.states.get(toolSyncUndoKey('trae'))).toEqual(firstCheckpoint);
    const selected = f.select([]); await f.sync(selected);
    expect(f.names()).toEqual([]); expect(f.manager.status('trae').available).toBe(true);
    const removalCheckpoint = copy(f.states.get(toolSyncUndoKey('trae')));
    await f.sync(); expect(f.states.get(toolSyncUndoKey('trae'))).toEqual(removalCheckpoint);
    await f.manager.undo('trae');
    expect(f.names()).toEqual(['alias-first']); expect(f.binding()).toEqual(selected);
  });

  it('rolls back native undo if restoring the ModelDock selection fails and leaves that undo usable', async () => {
    const f = fixture(); await f.sync(f.select(['first']));
    const first = f.select(['second']); await f.sync(first);
    const selected = f.binding();
    vi.mocked(f.store.restoreBindingSelection).mockImplementationOnce(() => { throw new Error('Synthetic binding persistence failure'); });
    await expect(f.manager.undo('trae')).rejects.toMatchObject({ category: 'restored' });
    expect(f.names()).toEqual(['alias-second']); expect(f.binding()).toEqual(selected);
    expect(f.manager.status('trae').available).toBe(true);
    await f.manager.undo('trae');
    expect(f.names()).toEqual(['alias-first']); expect(f.binding()).toEqual(first);
  });

  it('keeps the preceding material checkpoint usable when saving the new tool checkpoint fails after native commit', async () => {
    const f = fixture(); await f.sync(f.select(['first']));
    const before = f.select(['second']);
    let failOnce = true;
    vi.mocked(f.store.setManagedState).mockImplementation((key, value) => {
      if (key === toolSyncUndoKey('trae') && failOnce) { failOnce = false; throw new Error('Synthetic checkpoint failure'); }
      f.states.set(key, copy(value));
    });
    await expect(f.sync(before)).rejects.toThrow('已恢复撤销前的配置');
    expect(f.names()).toEqual(['alias-first']); expect(f.binding()).toEqual(before);
    expect(f.manager.status('trae').available).toBe(true);
    await f.manager.undo('trae');
    expect(f.names()).toEqual([]); expect(f.binding()).toEqual(f.original);
  });

  it('refuses native undo after a key-only external edit without changing the selection or unrelated files', async () => {
    const f = fixture(); await f.sync(f.select(['first'])); const selected = f.binding();
    const row = [...f.native.rows.values()][0]; f.native.rows.set(row.id, { ...row, credentialRevision: 'externally-replaced-key' });
    await expect(f.manager.undo('trae')).rejects.toMatchObject({ category: 'changed' });
    expect(f.binding()).toEqual(selected); expect(f.names()).toEqual(['alias-first']);
    expect(readFileSync(f.codexPath, 'utf8')).toBe(f.codexContents);
  });

  it('restores only ModelDock-owned native models and disables the binding, preserving a manually added model', async () => {
    const f = fixture(); await f.sync(f.select(['first']));
    const config = buildTraePlan(f.store, 18181, true).models[0].configuration;
    const manual = await f.native.client.addModel({ ...config, model_name: 'manual-model', display_name: 'Personal model' });
    expect(await f.restore()).toBe(f.target);
    f.manager.clear('trae');
    expect(f.names()).toEqual(['manual-model']); expect(f.native.rows.has(manual.id)).toBe(true);
    expect(f.binding()).toMatchObject({ enabled: false, providerIds: [], modelIds: [], defaultModelId: '' });
    expect(f.manager.status('trae').available).toBe(false);
    expect(readFileSync(f.codexPath, 'utf8')).toBe(f.codexContents);
  });

  it('restores the active binding and native models when official restoration is rejected', async () => {
    const f = fixture(); await f.sync(f.select(['first'])); const selected = f.binding();
    f.native.rejectDeletion();
    await expect(f.restore()).rejects.toMatchObject({ category: 'restored' });
    expect(f.binding()).toEqual(selected); expect(f.names()).toEqual(['alias-first']);
    expect(f.manager.status('trae').available).toBe(true);
  });
});

async function removalFixture() {
  const root = directory(), store = await Store.create(root); stores.push(store);
  const diagnosticStage = diagnoseStore(store);
  const source = store.saveProvider({ name: 'Removed API', kind: 'openai-compatible', baseUrl: 'https://removed.example.test/v1', enabled: true, apiKey: 'SYNTHETIC_REMOVED_KEY' });
  const keeper = store.saveProvider({ name: 'Kept API', kind: 'openai-compatible', baseUrl: 'https://kept.example.test/v1', enabled: true, apiKey: 'SYNTHETIC_KEPT_KEY' });
  const model = (providerId: string, alias: string) => store.saveModel({ providerId, alias, upstreamId: alias, displayName: alias, wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const removed = model(source.id, 'removed-model'), kept = model(keeper.id, 'kept-model');
  const original = store.listBindings().find(row => row.id === 'trae')!;
  store.saveBinding({ ...original, enabled: true, mode: 'aggregate', providerIds: [source.id, keeper.id], modelIds: [removed.id, kept.id], modelSelection: 'selected', defaultModelId: removed.id });
  const target = join(root, 'Trae CN'), native = fakeTraeNativeClient(target);
  const manager = new ToolSyncUndoManager(store, { appData: root, homeDirectory: root, traeTarget: target, traeOptions: native.options });
  diagnosticStage('fixture-initial-sync');
  await manager.run('trae', original, () => applyTraeModels(store, buildTraePlan(store, 18181, true), target, native.options));
  diagnosticStage('ready');
  const synchronize = vi.fn(async () => {
    await applyTraeModels(store, buildTraePlan(store, 18181, true), target, { ...native.options, recordUndo: false });
    manager.clear('trae');
  });
  return { store, source, keeper, removed, kept, native, manager, synchronize, target, diagnosticStage };
}

describe('Trae provider removal integration with the real Store', () => {
  it('removes an affected native model, keeps the remaining source and prevents tool undo from reviving a deleted provider', async () => {
    const f = await removalFixture();
    f.diagnosticStage('remove-first');
    await removeProviderAndSync(f.store, f.source.id, f.synchronize);
    expect(f.synchronize).toHaveBeenCalledExactlyOnceWith('trae');
    expect(f.store.getProvider(f.source.id)).toBeUndefined();
    expect([...f.native.rows.values()].map(row => row.configuration.model_name)).toEqual(['kept-model']);
    expect(f.store.listBindings().find(row => row.id === 'trae')).toMatchObject({ enabled: true, providerIds: [f.keeper.id], modelIds: [f.kept.id] });
    expect(f.manager.status('trae').available).toBe(false);
    expect(f.store.getManagedState(traeSyncUndoKey(f.target), null)).toBeNull();
  });

  it('restores the removed provider and selection when native removal fails, then repairs Trae through the public sync path', async () => {
    const f = await removalFixture(), before = f.store.listBindings().find(row => row.id === 'trae');
    f.diagnosticStage('remove-rejected');
    f.native.rejectDeletion();
    await expect(removeProviderAndSync(f.store, f.source.id, f.synchronize)).rejects.toMatchObject({ category: 'restored', toolId: 'trae' });
    expect(f.synchronize.mock.calls).toEqual([['trae'], ['trae']]);
    expect(f.store.getProvider(f.source.id)).toBeDefined();
    expect(f.store.listBindings().find(row => row.id === 'trae')).toEqual(before);
    expect([...f.native.rows.values()].map(row => row.configuration.model_name).sort()).toEqual(['kept-model', 'removed-model']);
  });

  it('still synchronizes an empty native plan after removing the last source disables Trae', async () => {
    const f = await removalFixture();
    f.diagnosticStage('remove-first');
    await removeProviderAndSync(f.store, f.source.id, f.synchronize);
    f.synchronize.mockClear();
    f.diagnosticStage('remove-last');
    await removeProviderAndSync(f.store, f.keeper.id, f.synchronize);
    expect(f.synchronize).toHaveBeenCalledExactlyOnceWith('trae');
    expect([...f.native.rows.values()]).toEqual([]);
    expect(f.store.listBindings().find(row => row.id === 'trae')).toMatchObject({ enabled: false, providerIds: [], modelIds: [], defaultModelId: '' });
    expect(f.manager.status('trae').available).toBe(false);
  });
});
