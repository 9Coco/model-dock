import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyTraeModels, traeSyncStateKey, traeSyncUndoKey, traeSyncUndoStatus, undoTraeModels, restoreTraeSyncUndoCheckpoint, TraeNativeMutationError, TraeNativeConnectionError, TraeSyncError,
  type TraeNativeClient, type TraeNativeModel, type TraeSyncStore } from '../src/main/trae-sync';
import type { TraeModelConfiguration, TraePlan } from '../src/main/trae-config';

const target = 'fixture-trae-profile';
function config(name: string, key = 'SYNTHETIC_OWN_KEY'): TraeModelConfiguration {
  return { provider: 'custom_responses_compatible', model_name: name, is_custom: true, ak: key, isAkFromServer: false, auth_type: 0,
    base_url: 'https://fixture.example.test/v1/responses', display_name: `ModelDock · ${name}`, clearReasoningParam: true,
    config_detail: { multimodal: false, model_hyper_params: { max_tokens: 4096, prompt_max_tokens: 28000 } } };
}
function plan(...names: string[]): TraePlan { return { version: 1, models: names.map(sourceId => ({ sourceId, configuration: config(sourceId) })) }; }
class MemoryStore implements TraeSyncStore {
  dataDir = 'fixture-data';
  encrypted = new Map<string, string>();
  backups: string[] = [];
  backupError = false;
  rejectWrite?: (name: string, value: any) => boolean;
  getManagedState<T>(name: string, fallback: T): T { const value = this.encrypted.get(name); return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : structuredClone(fallback); }
  setManagedState(name: string, value: unknown) {
    if (this.rejectWrite?.(name, value)) throw new Error('PRIVATE_STORAGE_EXCEPTION');
    this.encrypted.set(name, Buffer.from(JSON.stringify(value)).toString('base64'));
  }
  createManagedBackup(_kind: string, value: unknown): string {
    if (this.backupError) throw new Error('PRIVATE_BACKUP_EXCEPTION');
    this.backups.push(Buffer.from(JSON.stringify(value)).toString('base64'));
    return `fixture-data/backups/${this.backups.length}.enc`;
  }
  state(): any { return this.getManagedState(traeSyncStateKey(target), null); }
  undo(): any { return this.getManagedState(traeSyncUndoKey(target), null); }
}
type Mutation = { kind: 'add' | 'update' | 'delete'; id?: string; configuration?: TraeModelConfiguration };
class NativeApp {
  models = new Map<string, TraeNativeModel>();
  secrets = new Map<string, string>();
  mutations: Mutation[] = [];
  hasCredentialRevision = true;
  generation = 0;
  nextId = 0;
  closed = 0;
  openCount = 0;
  targetId = target;
  beforeMutation?: (operation: Mutation, count: number) => void;
  afterMutation?: (operation: Mutation, count: number) => void;
  onOpen?: () => void | Promise<void>;
  addReturnsExistingId?: string;
  constructor(readonly store: MemoryStore) {
    this.put('foreign', config('A', 'SYNTHETIC_FOREIGN_KEY'));
  }
  put(id: string, value: TraeModelConfiguration): TraeNativeModel {
    this.generation++;
    const configuration = structuredClone({ ...value, ak: '' });
    const snapshot: TraeNativeModel = { id, configuration, enabled: true,
      fingerprint: createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),
      ...(this.hasCredentialRevision ? { credentialRevision: String(this.generation) } : {}) };
    this.models.set(id, snapshot); this.secrets.set(id, value.ak); return structuredClone(snapshot);
  }
  begin(operation: Mutation) {
    // The coordinator must durably record the requested mutation before the
    // native API receives any key or model deletion.
    expect(this.store.state()?.pending).toBeDefined();
    this.mutations.push(structuredClone(operation)); this.beforeMutation?.(operation, this.mutations.length);
  }
  done(operation: Mutation) { this.afterMutation?.(operation, this.mutations.length); }
  open = async (_target: string): Promise<TraeNativeClient> => {
    this.openCount++; await this.onOpen?.();
    return { targetId: this.targetId,
      listModels: async () => structuredClone([...this.models.values()]),
      addModel: async configuration => {
        const operation: Mutation = { kind: 'add', configuration }; this.begin(operation);
        const id = this.addReturnsExistingId ?? `generated-${++this.nextId}`;
        const result = this.put(id, configuration); this.done(operation); return result;
      },
      updateModel: async (id, configuration) => {
        const operation: Mutation = { kind: 'update', id, configuration }; this.begin(operation);
        if (!this.models.has(id)) throw new TraeNativeMutationError('not-applied');
        const result = this.put(id, configuration); this.done(operation); return result;
      },
      deleteModel: async id => {
        const operation: Mutation = { kind: 'delete', id }; this.begin(operation);
        this.models.delete(id); this.secrets.delete(id); this.done(operation);
      },
      close: () => { this.closed++; },
    };
  };
  foreign() { return structuredClone({ model: this.models.get('foreign'), secret: this.secrets.get('foreign') }); }
  owned() { return [...this.models.values()].filter(row => row.id !== 'foreign'); }
}
function fixture() {
  const store = new MemoryStore(), app = new NativeApp(store), options = { openClient: app.open, recordUndo: true };
  return { store, app, options, apply: (value: TraePlan) => applyTraeModels(store, value, target, options), undo: (commit?: () => void) => undoTraeModels(store, target, options, commit) };
}
async function failure(operation: Promise<unknown>, category: string) {
  const error = await operation.catch(error => error);
  expect(error).toBeInstanceOf(TraeSyncError); expect((error as TraeSyncError).category).toBe(category);
  expect(String(error)).not.toMatch(/SYNTHETIC_|PRIVATE_|fixture\.example/);
}

describe('Trae encrypted ownership, native synchronization and recovery', () => {
  it.each(['restart-required', 'install-failed', 'unsupported-version', 'unsupported-platform', 'login-required', 'service-not-ready', 'custom-models-disabled', 'schema-incompatible', 'untrusted', 'not-running'] as const)('preserves the closed %s action hint before any native mutation', async code => {
    const f = fixture();
    f.app.onOpen = () => { const error = new TraeNativeConnectionError(code); error.message = 'PRIVATE_INSTALLER_OUTPUT_AND_KEY'; throw error; };
    const error = await f.apply(plan('A')).catch(error => error);
    expect(error).toBeInstanceOf(TraeNativeConnectionError);
    expect(error).toMatchObject({ code, message: new TraeNativeConnectionError(code).message });
    expect(String(error)).not.toContain('PRIVATE_');
    expect(f.app.mutations).toEqual([]); expect(f.store.state()).toBeNull(); expect(f.store.undo()).toBeNull();
  });

  it('does not trust a plain Error with a forged connection-error name or code', async () => {
    const f = fixture();
    f.app.onOpen = () => { throw Object.assign(new Error('PRIVATE_KEY_IN_NATIVE_ERROR'), { name: 'TraeNativeConnectionError', code: 'restart-required' }); };
    await failure(f.apply(plan('A')), 'unavailable'); expect(f.app.mutations).toEqual([]);
  });

  it('retains actionable list errors and closes the bridge without creating a mutation journal', async () => {
    const f = fixture(), open = f.options.openClient;
    f.options.openClient = async target => ({ ...await open(target), listModels: async () => { throw new TraeNativeConnectionError('login-required'); } });
    await expect(f.apply(plan('A'))).rejects.toMatchObject({ name: 'TraeNativeConnectionError', code: 'login-required' });
    expect(f.app.closed).toBe(1); expect(f.app.mutations).toEqual([]); expect(f.store.state()).toBeNull();
  });

  it('preserves a proven preflight rejection hint but never lets a hint hide an unknown mutation result', async () => {
    const rejected = fixture();
    rejected.app.beforeMutation = () => { throw new TraeNativeMutationError('not-applied', 'login-required'); };
    await expect(rejected.apply(plan('A'))).rejects.toMatchObject({ name: 'TraeNativeConnectionError', code: 'login-required' });
    expect(rejected.app.owned()).toEqual([]); expect(rejected.store.state().pending).toBeUndefined();
    const uncertain = fixture();
    uncertain.app.afterMutation = () => { throw new TraeNativeMutationError('unknown', 'login-required'); };
    await failure(uncertain.apply(plan('A')), 'uncertain');
    expect(uncertain.app.owned()).toHaveLength(1); expect(uncertain.store.state().pending.phase).toBe('uncertain');
  });

  it('owns only confirmed native IDs, preserves same-named foreign models and stores only its own keys', async () => {
    const f = fixture(), foreign = f.app.foreign();
    await f.apply(plan('A', 'B'));
    expect(f.app.foreign()).toEqual(foreign);
    expect(f.store.state().models.map((row: any) => row.native.id)).toEqual(['generated-1', 'generated-2']);
    expect(f.app.mutations.every(row => row.id !== 'foreign')).toBe(true);
    const serialized = [...f.store.encrypted.values(), ...f.store.backups].map(value => Buffer.from(value, 'base64').toString()).join('');
    expect(serialized).toContain('SYNTHETIC_OWN_KEY'); expect(serialized).not.toContain('SYNTHETIC_FOREIGN_KEY');
    expect(f.store.state().models.every((row: any) => row.native.configuration.ak === '')).toBe(true);
    expect(traeSyncUndoStatus(f.store, target)).toMatchObject({ available: true, changed: true });
    await f.undo();
    expect(f.app.owned()).toEqual([]); expect(f.app.foreign()).toEqual(foreign);
    expect(f.store.undo()).toBeNull(); expect(traeSyncUndoStatus(f.store, target).available).toBe(false);
  });

  it('preserves the last material undo checkpoint during a repeated no-op sync', async () => {
    const f = fixture(); await f.apply(plan('A')); const checkpoint = f.store.undo(), mutations = f.app.mutations.length, backups = f.store.backups.length;
    await f.apply(plan('A'));
    expect(f.app.mutations).toHaveLength(mutations); expect(f.store.undo()).toEqual(checkpoint); expect(f.store.backups).toHaveLength(backups);
    await f.undo(); expect(f.app.owned()).toEqual([]);
  });

  it('updates tracked rows in place, cleans only omitted owned models and restores removed logical models with new IDs', async () => {
    const f = fixture(); await f.apply(plan('A', 'B')); const foreign = f.app.foreign();
    const changed = plan('A'); changed.models[0].configuration.ak = 'SYNTHETIC_NEW_KEY'; changed.models[0].configuration.display_name = 'Changed A';
    await f.apply(changed);
    expect(f.app.owned().map(row => row.id)).toEqual(['generated-1']); expect(f.app.secrets.get('generated-1')).toBe('SYNTHETIC_NEW_KEY');
    await f.undo();
    expect(f.app.owned().map(row => row.configuration.model_name).sort()).toEqual(['A', 'B']);
    expect(f.app.secrets.get('generated-1')).toBe('SYNTHETIC_OWN_KEY');
    expect(f.app.owned().find(row => row.configuration.model_name === 'B')!.id).not.toBe('generated-2');
    expect(f.app.foreign()).toEqual(foreign);
  });

  it.each(['metadata', 'credential', 'missing'] as const)('refuses to overwrite an externally changed owned %s state', async kind => {
    const f = fixture(); await f.apply(plan('A')); const count = f.app.mutations.length, saved = f.store.undo();
    if (kind === 'missing') f.app.models.delete('generated-1');
    else {
      const value = config('A', kind === 'credential' ? 'SYNTHETIC_EXTERNAL_KEY' : 'SYNTHETIC_OWN_KEY');
      if (kind === 'metadata') value.display_name = 'External name'; f.app.put('generated-1', value);
    }
    await failure(f.undo(), 'changed'); await failure(f.apply(plan('B')), 'changed');
    expect(f.app.mutations).toHaveLength(count); expect(f.store.undo()).toEqual(saved);
  });

  it('retains an encrypted checkpoint but disables undo when key-only edits cannot be detected', async () => {
    const f = fixture(); f.app.hasCredentialRevision = false; await f.apply(plan('A'));
    const status = traeSyncUndoStatus(f.store, target);
    expect(status).toMatchObject({ available: false, changed: true }); expect(status.reason).toContain('密钥修改标记');
    expect(f.store.undo()).not.toBeNull(); const count = f.app.mutations.length;
    await failure(f.undo(), 'credentials'); expect(f.app.mutations).toHaveLength(count);
    const next = plan('A'); next.models[0].configuration.display_name = 'Explicitly changed by user';
    await f.apply(next); expect(f.app.owned()[0].configuration.display_name).toBe('Explicitly changed by user');
  });

  it('accepts an explicitly verified metadata revision that also covers credential changes', async () => {
    const f = fixture();
    const open = f.options.openClient;
    f.options.openClient = async value => {
      const client = await open(value);
      const stamp = (row: TraeNativeModel) => { const { credentialRevision, ...rest } = row; return { ...rest, revision: credentialRevision, metadataRevisionCoversCredentials: true }; };
      return { ...client, listModels: async () => (await client.listModels()).map(stamp), addModel: async cfg => stamp(await client.addModel(cfg)), updateModel: async (id, cfg) => stamp(await client.updateModel(id, cfg)) };
    };
    await f.apply(plan('A')); expect(traeSyncUndoStatus(f.store, target).available).toBe(true);
    await f.undo(); expect(f.app.owned()).toEqual([]);
  });

  it('rolls back confirmed add and update operations after a proven rejection, preserving the old undo', async () => {
    const f = fixture(); await f.apply(plan('A')); const oldUndo = f.store.undo();
    const next = plan('A', 'B', 'C'); next.models[0].configuration.ak = 'SYNTHETIC_NEW_KEY';
    f.app.beforeMutation = operation => { if (operation.configuration?.model_name === 'C') throw new TraeNativeMutationError('not-applied'); };
    await failure(f.apply(next), 'restored');
    expect(f.app.owned().map(row => row.configuration.model_name)).toEqual(['A']);
    expect(f.app.secrets.get('generated-1')).toBe('SYNTHETIC_OWN_KEY');
    expect(f.store.state().pending).toBeUndefined(); expect(f.store.undo().id).toBe(oldUndo.id);
    expect(traeSyncUndoStatus(f.store, target).available).toBe(true);
    f.app.beforeMutation = undefined; await f.undo(); expect(f.app.owned()).toEqual([]);
  });

  it('re-creates a confirmed deletion on a later rejection, records the new ID, and keeps the previous undo usable', async () => {
    const f = fixture(); await f.apply(plan('A', 'B')); const undoId = f.store.undo().id;
    f.app.beforeMutation = operation => { if (operation.kind === 'delete' && operation.id === 'generated-2') throw new TraeNativeMutationError('not-applied'); };
    await failure(f.apply(plan()), 'restored');
    expect(f.app.owned().map(row => row.configuration.model_name).sort()).toEqual(['A', 'B']);
    expect(f.store.state().models.find((row: any) => row.sourceId === 'A').native.id).toBe('generated-3');
    expect(f.store.undo().id).toBe(undoId); expect(traeSyncUndoStatus(f.store, target).available).toBe(true);
    f.app.beforeMutation = undefined; await f.undo(); expect(f.app.owned()).toEqual([]);
  });

  it('freezes unknown results instead of claiming a timed-out add by name or reporting successful rollback', async () => {
    const f = fixture();
    f.app.afterMutation = () => { throw new TraeNativeMutationError('unknown'); };
    await failure(f.apply(plan('A')), 'uncertain');
    expect(f.app.owned()).toHaveLength(1); expect(f.store.state().models).toEqual([]);
    expect(f.store.state().pending.steps[0].status).toBe('uncertain');
    const count = f.app.mutations.length;
    await failure(f.apply(plan('A')), 'uncertain'); await failure(f.undo(), 'uncertain');
    expect(f.app.mutations).toHaveLength(count); expect(traeSyncUndoStatus(f.store, target).available).toBe(false);
  });

  it('does not adopt a returned pre-existing native ID, even when it has a ModelDock-looking name', async () => {
    const f = fixture(); f.app.addReturnsExistingId = 'foreign';
    await failure(f.apply(plan('A')), 'uncertain');
    expect(f.store.state().models).toEqual([]);
    expect(f.app.mutations).toHaveLength(1); // No automatic deletion of the foreign ID.
  });

  it('retains the journal if rollback itself fails and does not expose private transport messages', async () => {
    const f = fixture();
    f.app.beforeMutation = operation => {
      if (operation.configuration?.model_name === 'B') throw new TraeNativeMutationError('not-applied');
      if (operation.kind === 'delete') throw new Error('PRIVATE_TRANSPORT_EXCEPTION');
    };
    await failure(f.apply(plan('A', 'B')), 'recovery');
    expect(f.store.state().pending.phase).toBe('uncertain'); expect(f.app.owned()).toHaveLength(1);
    await failure(f.apply(plan()), 'uncertain');
  });

  it('refuses all native writes if encrypted backups cannot be made', async () => {
    const f = fixture(); f.store.backupError = true;
    await failure(f.apply(plan('A')), 'backup');
    expect(f.app.mutations).toEqual([]); expect(f.app.owned()).toEqual([]); expect(f.store.undo()).toBeNull();
  });

  it('rolls native changes back if the final encrypted undo checkpoint cannot be committed', async () => {
    const f = fixture(); let rejected = false;
    f.store.rejectWrite = (name, value) => name === traeSyncUndoKey(target) && value !== null && !rejected && (rejected = true);
    await failure(f.apply(plan('A')), 'restored');
    expect(f.app.owned()).toEqual([]); expect(f.store.state().pending).toBeUndefined(); expect(f.store.undo()).toBeNull();
  });

  it('rolls back a failed local undo commit and retains a retryable original checkpoint', async () => {
    const f = fixture(); await f.apply(plan('A')); const id = f.store.undo().id;
    await failure(f.undo(() => { throw new Error('PRIVATE_LOCAL_COMMIT_FAILURE'); }), 'restored');
    expect(f.app.owned()).toHaveLength(1); expect(f.store.undo().id).toBe(id); expect(traeSyncUndoStatus(f.store, target).available).toBe(true);
    const commit = vi.fn(); await f.undo(commit); expect(commit).toHaveBeenCalledOnce(); expect(f.app.owned()).toEqual([]);
  });

  it('rebases an earlier checkpoint after native undo re-created its owned IDs, without weakening external-change guards', async () => {
    const f = fixture(); await f.apply(plan('A')); const original = f.store.undo();
    await f.apply(plan('B')); await f.undo();
    expect(f.store.state().models[0].native.id).not.toBe(original.complete.models[0].native.id);
    await restoreTraeSyncUndoCheckpoint(f.store, target, original, f.options);
    expect(f.store.undo().id).toBe(original.id); expect(traeSyncUndoStatus(f.store, target).available).toBe(true);
    const restoredId = f.store.state().models[0].native.id;
    const changed = config('A'); changed.display_name = 'External edit'; f.app.put(restoredId, changed);
    const checkpoint = f.store.undo();
    await failure(restoreTraeSyncUndoCheckpoint(f.store, target, original, f.options), 'changed');
    expect(f.store.undo()).toEqual(checkpoint);
  });

  it('checks target identity before sending credentials and rejects duplicate or invalid plans before opening the bridge', async () => {
    const f = fixture(); f.app.targetId = 'different-profile';
    await failure(f.apply(plan('A')), 'target'); expect(f.app.mutations).toEqual([]);
    const opens = f.app.openCount;
    await failure(f.apply(plan('A', 'A')), 'configuration');
    const invalid = plan('A'); invalid.models[0].configuration.base_url = 'https://example.test/?key=PRIVATE_KEY';
    await failure(f.apply(invalid), 'configuration'); expect(f.app.openCount).toBe(opens);
  });

  it('serializes one profile and clones the requested plan before awaiting the bridge', async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); f.app.onOpen = () => gate;
    const desired = plan('A'), pending = f.apply(desired);
    desired.models[0].configuration.ak = 'SYNTHETIC_MUTATED_KEY';
    await failure(f.apply(plan('B')), 'busy');
    expect(traeSyncUndoStatus(f.store, target).available).toBe(false);
    release(); await pending;
    expect(f.app.secrets.get('generated-1')).toBe('SYNTHETIC_OWN_KEY');
  });
});
