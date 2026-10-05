import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyCopilotDesktop, CopilotSyncError, type CopilotSyncStore } from '../src/main/copilot-sync';
import { CopilotDesktopClient, CopilotDesktopError, type CopilotDesktopPlan, type CopilotDesktopSocket, type CopilotNativeProvider, type CopilotNativeModel } from '../src/main/copilot-desktop';
import type { CopilotCredentialBackup } from '../src/main/copilot-credentials';
import { restoreOfficialConfig } from '../src/main/tool-restore';

const A = '23d4bf21-4897-4e6e-9cc7-69c25b738cc0', B = '23d4bf21-4897-4e6e-9cc7-69c25b738cc1';
const MA = '23d4bf21-4897-4e6e-9cc7-69c25b738cd0', MB = '23d4bf21-4897-4e6e-9cc7-69c25b738cd1', EXTRA = '23d4bf21-4897-4e6e-9cc7-69c25b738cd2';
const FOREIGN = '73d4bf21-4897-4e6e-9cc7-69c25b738ce0', FOREIGN_MODEL = '73d4bf21-4897-4e6e-9cc7-69c25b738ce1';
const home = join(tmpdir(), 'modeldock-copilot-sync-test-home');
const canonical = process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home);
const key = `copilot-sync:${createHash('sha256').update(canonical).digest('hex')}`;
function makePlan(id = A, modelId = MA, apiKey = 'PRIVATE_OLD_KEY'): CopilotDesktopPlan {
  return { providers: [{ id, name: `Source ${id === A ? 'A' : 'B'}`, baseUrl: 'https://upstream.example.test/v1', apiKey,
    models: [{ id: modelId, modelId: 'same-model', displayName: 'Original model', wireApi: 'responses', contextWindow: 32000, maxOutputTokens: 4000 }] }] };
}
class MemoryStore implements CopilotSyncStore {
  dataDir = join(tmpdir(), 'modeldock-copilot-sync-test-data');
  encrypted = new Map<string, string>();
  backups: string[] = [];
  writes = 0;
  failWrite?: number;
  backupError = false;
  getManagedState<T>(name: string, fallback: T): T { const value = this.encrypted.get(name); return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : structuredClone(fallback); }
  setManagedState(name: string, value: unknown) { this.writes++; if (this.failWrite === this.writes) throw new Error('PRIVATE_STORAGE_EXCEPTION'); this.encrypted.set(name, Buffer.from(JSON.stringify(value)).toString('base64')); }
  createManagedBackup(_kind: string, value: unknown): string {
    if (this.backupError) throw new Error('PRIVATE_BACKUP_EXCEPTION');
    this.backups.push(Buffer.from(JSON.stringify(value)).toString('base64'));
    return join(this.dataDir, 'backups', `fixture-${this.backups.length}.enc`);
  }
  state(): any { return this.getManagedState(key, null); }
}
class NativeApp {
  providers = new Map<string, CopilotNativeProvider>([
    ['foreign', { id: 'foreign', name: 'Unmanaged', kind: 'custom', settings: { baseUrl: 'https://foreign.example.test/v1' }, hasSecret: true }],
    ['account', { id: 'account', name: 'Subscription', kind: 'github_copilot', settings: {}, hasSecret: true, accountId: 'fixture-account' }],
  ]);
  models = new Map<string, CopilotNativeModel>([['foreign-model', { id: 'foreign-model', providerId: 'foreign', modelId: 'foreign-model', displayName: 'Foreign' }]]);
  secrets = new Map<string, string>([['foreign', 'PRIVATE_FOREIGN_SECRET']]);
  mutations: Record<string, any>[] = [];
  opens = 0;
  failNext?: (body: Record<string, any>) => boolean;
  failAfterMutation = false;
  closed = 0;
  closeThrows = false;
  openGate?: Promise<void>;
  open = async (_target: string) => {
    this.opens++; if (this.openGate) await this.openGate;
    return CopilotDesktopClient.open(home, { timeoutMs: 100, readRunFile: async name => name.includes('port') ? '45670\n321\n' : 'SYNTHETIC_WS_NONCE_'.padEnd(43, 'X') + '\n321\n', socketFactory: () => new Socket(this), verifyProcess: async (pid, port) => pid === 321 && port === 45670 });
  };
  foreignState() { return structuredClone({ provider: this.providers.get('foreign'), model: this.models.get('foreign-model'), secret: this.secrets.get('foreign'), account: this.providers.get('account') }); }
}
class Socket implements CopilotDesktopSocket {
  listeners = new Map<string, Set<(event: any) => void>>();
  constructor(private app: NativeApp) { queueMicrotask(() => this.event('open', {})); }
  addEventListener(type: string, listener: (event: any) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  event(type: string, value: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(value); }
  message(value: unknown) { this.event('message', { data: JSON.stringify(value) }); }
  close() { this.app.closed++; if (this.app.closeThrows) throw new Error('PRIVATE_CLOSE_EXCEPTION'); }
  send(raw: string) {
    const body = JSON.parse(raw), mutation = ['upsert_model_provider', 'upsert_provider_model', 'delete_model_provider', 'delete_provider_model'].includes(body.type);
    const fail = mutation && this.app.failNext?.(body);
    if (fail && !this.app.failAfterMutation) { this.message({ type: 'error', message: 'PRIVATE_NATIVE_EXCEPTION' }); return; }
    if (mutation) this.app.mutations.push(structuredClone(body));
    // These unrelated broadcasts must not contaminate the native client's snapshot.
    this.message({ type: 'chat_history', body: 'PRIVATE_CHAT_BODY' });
    let result: unknown;
    switch (body.type) {
      case 'list_model_providers': result = { type: 'model_providers_list', providers: [...this.app.providers.values()] }; break;
      case 'list_provider_models': result = { type: 'provider_models_list', models: [...this.app.models.values()].filter(model => model.providerId === body.provider_id) }; break;
      case 'upsert_model_provider': {
        if (body.secret) this.app.secrets.set(body.provider.id, body.secret.value);
        const provider = { ...body.provider, hasSecret: this.app.secrets.has(body.provider.id) }; this.app.providers.set(provider.id, provider);
        result = { type: 'model_provider_upserted', provider }; break;
      }
      case 'upsert_provider_model': this.app.models.set(body.model.id, body.model); result = { type: 'provider_model_upserted', model: body.model }; break;
      case 'delete_model_provider': {
        this.app.providers.delete(body.provider_id); this.app.secrets.delete(body.provider_id);
        for (const [id, model] of this.app.models) if (model.providerId === body.provider_id) this.app.models.delete(id);
        result = { type: 'model_provider_deleted', provider_id: body.provider_id }; break;
      }
      case 'delete_provider_model': this.app.models.delete(body.model_id); result = { type: 'provider_model_deleted', model_id: body.model_id }; break;
      default: throw new Error('Unexpected mock protocol');
    }
    if (fail) this.message({ type: 'error', message: 'PRIVATE_NATIVE_EXCEPTION' }); else this.message(result);
  }
}
function fixture() { const store = new MemoryStore(), app = new NativeApp(); return { store, app, apply: (plan: CopilotDesktopPlan) => applyCopilotDesktop(store, plan, home, { openClient: app.open }) }; }
function exclusiveFixture() {
  const store = new MemoryStore(), app = new NativeApp();
  app.providers.delete('foreign'); app.models.delete('foreign-model'); app.secrets.delete('foreign');
  app.providers.set(FOREIGN, { id: FOREIGN, name: 'User-defined custom source', kind: 'custom', hasSecret: true, settings: { baseUrl: 'https://foreign.example.test/v1', authKind: 'api_key', wireApi: 'completions', headersJson: '{"X-Original":"keep"}', privateExtensionMetadata: { preserved: true } } });
  app.models.set(FOREIGN_MODEL, { id: FOREIGN_MODEL, providerId: FOREIGN, modelId: 'foreign-model', displayName: 'Custom original', wireApiOverride: 'completions', maxPromptTokens: 123000, maxOutputTokens: 5000, supportedReasoningEfforts: ['low'] });
  app.secrets.set(FOREIGN, 'PRIVATE_OPAQUE_FOREIGN_KEY');
  const calls: string[] = [];
  let captureError = false, restoreError = false;
  const captureCredentials = async (ids: readonly string[]): Promise<CopilotCredentialBackup> => {
    calls.push('capture'); if (captureError) throw new Error('PRIVATE_CREDENTIAL_CAPTURE_ERROR');
    return { version: 1, providers: ids.map(providerId => ({ providerId, entries: app.secrets.has(providerId) ? [{ kind: 'api_key', blobBase64: Buffer.from(app.secrets.get(providerId)!).toString('base64'), flags: 0, persist: 2, userName: null, comment: null, targetAlias: null, attributes: [] }] : [] })) };
  };
  const restoreCredentials = async (backup: CopilotCredentialBackup) => {
    calls.push('restore'); if (restoreError) throw new Error('PRIVATE_CREDENTIAL_RESTORE_ERROR');
    for (const provider of backup.providers) {
      const entry = provider.entries.find(entry => entry.kind === 'api_key');
      // This fake OS store interprets its own fixture bytes. The production
      // coordinator never turns opaque credential data into an API-key string.
      if (entry) app.secrets.set(provider.providerId, Buffer.from(entry.blobBase64, 'base64').toString()); else app.secrets.delete(provider.providerId);
    }
  };
  return { store, app, calls, setCaptureError: (value: boolean) => { captureError = value; }, setRestoreError: (value: boolean) => { restoreError = value; },
    apply: (desired: CopilotDesktopPlan, syncScope: 'selected' | 'managed' = 'selected') => applyCopilotDesktop(store, desired, home, { openClient: app.open, syncScope, captureCredentials, restoreCredentials }), captureCredentials, restoreCredentials };
}
async function safeFailure(operation: Promise<unknown>, category: string) {
  const error = await operation.catch(error => error as Error);
  expect(error).toBeInstanceOf(CopilotSyncError); expect((error as CopilotSyncError).category).toBe(category);
  expect(String(error)).not.toMatch(/PRIVATE_|SYNTHETIC_WS_NONCE|upstream\.example|foreign\.example/);
}

describe('running Copilot app synchronization and encrypted ownership recovery', () => {
  it('selected scope removes unselected custom sources after opaque backup, while never permanently claiming them', async () => {
    const f = exclusiveFixture(), account = structuredClone(f.app.providers.get('account'));
    await f.apply(makePlan());
    expect(f.app.providers.has(FOREIGN)).toBe(false); expect(f.app.models.has(FOREIGN_MODEL)).toBe(false); expect(f.app.secrets.has(FOREIGN)).toBe(false);
    expect(f.app.providers.get('account')).toEqual(account); expect(f.store.state().ownedProviderIds).toEqual([A]); expect(f.store.state().pending).toBeUndefined();
    const backup = JSON.parse(Buffer.from(f.store.backups[0], 'base64').toString());
    expect(new Set(backup.credentials.providers.map((provider: any) => provider.providerId))).toEqual(new Set([A, FOREIGN]));
    expect(f.store.backups[0]).not.toContain('PRIVATE_OPAQUE_FOREIGN_KEY'); expect(backup.previous.ownedProviderIds).toEqual([]);
  });
  it('selected empty scope clears only custom sources and keys, retaining GitHub account providers', async () => {
    const f = exclusiveFixture(); await f.apply({ providers: [] });
    expect([...f.app.providers.keys()]).toEqual(['account']); expect(f.app.secrets.has(FOREIGN)).toBe(false); expect(f.store.state().ownedProviderIds).toEqual([]);
  });
  it('official restore uses exclusive native clearing even when the saved sync preference was managed, and preserves GitHub account sources', async () => {
    const f = exclusiveFixture(), account = structuredClone(f.app.providers.get('account'));
    await restoreOfficialConfig(f.store, 'copilot', f.store.dataDir, join(f.store.dataDir, 'backups'), f.store.dataDir, { copilotHome: home,
      copilotOptions: { openClient: f.app.open, syncScope: 'managed', captureCredentials: f.captureCredentials, restoreCredentials: f.restoreCredentials } });
    expect([...f.app.providers.keys()]).toEqual(['account']); expect(f.app.providers.get('account')).toEqual(account);
    expect(f.app.secrets.has(FOREIGN)).toBe(false); expect(f.calls).toEqual(['capture']);
    expect(f.store.backups).toHaveLength(1); expect(f.store.state().ownedProviderIds).toEqual([]);
    expect(f.app.mutations.map(command => command.type)).toEqual(['delete_model_provider']);
  });
  it('does not delete foreign sources or claim candidate IDs when opaque capture fails before mutation', async () => {
    const f = exclusiveFixture(), before = structuredClone([...f.app.providers]); f.setCaptureError(true);
    await safeFailure(f.apply(makePlan()), 'backup');
    expect([...f.app.providers]).toEqual(before); expect(f.app.mutations).toEqual([]); expect(f.store.state()).toBeNull(); expect(f.app.opens).toBe(1);
  });
  it('restores foreign native settings/models and original opaque bytes after a partial exclusive clear', async () => {
    const f = exclusiveFixture();
    const before = structuredClone({ provider: f.app.providers.get(FOREIGN), model: f.app.models.get(FOREIGN_MODEL), key: f.app.secrets.get(FOREIGN) });
    let failed = false; f.app.failAfterMutation = true; f.app.failNext = body => { if (!failed && body.type === 'delete_model_provider' && body.provider_id === FOREIGN) { failed = true; return true; } return false; };
    await safeFailure(f.apply(makePlan()), 'restored');
    expect(f.app.providers.get(FOREIGN)).toEqual(before.provider); expect(f.app.models.get(FOREIGN_MODEL)).toEqual(before.model); expect(f.app.secrets.get(FOREIGN)).toBe(before.key);
    expect(f.app.providers.has(A)).toBe(false); expect(f.app.secrets.has(A)).toBe(false); expect(f.store.state().ownedProviderIds).toEqual([]);
    expect(f.calls).toEqual(['capture', 'restore', 'restore']);
    expect(f.app.mutations.filter(body => body.type === 'upsert_model_provider' && body.provider.id === FOREIGN).every(body => body.secret === undefined)).toBe(true);
  });
  it('preserves prior orphan credential slots of new candidate IDs as well as native foreign sources', async () => {
    const f = exclusiveFixture(); f.app.secrets.set(A, 'PRIVATE_BEFORE_ORPHAN_SLOT');
    let failed = false; f.app.failAfterMutation = true; f.app.failNext = body => { if (!failed && body.type === 'delete_model_provider') { failed = true; return true; } return false; };
    await safeFailure(f.apply(makePlan()), 'restored');
    expect(f.app.providers.has(A)).toBe(false); expect(f.app.secrets.get(A)).toBe('PRIVATE_BEFORE_ORPHAN_SLOT'); expect(f.app.providers.has(FOREIGN)).toBe(true);
  });
  it('keeps foreign authority only in pending recovery and restores it before honoring a later managed opt-out', async () => {
    const f = exclusiveFixture(); let failed = false; f.app.failAfterMutation = true; f.app.failNext = body => { if (!failed && body.type === 'delete_model_provider') { failed = true; return true; } return false; };
    f.setRestoreError(true); await safeFailure(f.apply(makePlan()), 'recovery');
    const pending = f.store.state(); expect(pending.ownedProviderIds).toEqual([A]); expect(pending.pending.recoveryMode).toBe('opaque');
    expect(new Set(pending.pending.affectedProviderIds)).toEqual(new Set([A, FOREIGN])); expect(pending.lastSuccessfulPlan.providers).toEqual([]);
    f.setRestoreError(false); f.app.failNext = undefined;
    await f.apply(makePlan(), 'managed');
    expect(f.app.providers.has(FOREIGN)).toBe(true); expect(f.app.secrets.get(FOREIGN)).toBe('PRIVATE_OPAQUE_FOREIGN_KEY'); expect(f.app.providers.has(A)).toBe(true);
    expect(f.store.state().ownedProviderIds).toEqual([A]); expect(f.store.state().pending).toBeUndefined();
  });
  it('rejects a credential backup with wrong target IDs rather than treating metadata as a recoverable secret backup', async () => {
    const f = exclusiveFixture();
    await safeFailure(applyCopilotDesktop(f.store, makePlan(), home, { openClient: f.app.open, syncScope: 'selected', captureCredentials: async () => ({ version: 1, providers: [] }), restoreCredentials: f.restoreCredentials }), 'backup');
    expect(f.app.mutations).toEqual([]); expect(f.store.state()).toBeNull(); expect(f.app.providers.has(FOREIGN)).toBe(true);
  });
  it('rejects tampered opaque recovery authority and bytes before opening the native application', async () => {
    const f = exclusiveFixture(); f.app.failNext = body => body.type === 'upsert_provider_model'; f.setRestoreError(true);
    await safeFailure(f.apply(makePlan()), 'recovery'); const pending = f.store.state(), opened = f.app.opens;
    for (const corrupted of [ { ...pending, pending: { ...pending.pending, affectedProviderIds: [A] } }, { ...pending, pending: { ...pending.pending, credentials: { version: 1, providers: [{ providerId: FOREIGN, entries: [{ kind: 'api_key', blobBase64: 'not base64' }] }] } } } ]) {
      f.store.setManagedState(key, corrupted); await safeFailure(f.apply({ providers: [] }), 'history'); expect(f.app.opens).toBe(opened);
    }
  });
  it('creates, updates and clears only its UUID sources, preserving foreign providers and account state', async () => {
    const f = fixture(), foreign = f.app.foreignState();
    expect(await f.apply(makePlan())).toBe(join(resolve(home), 'data.db'));
    expect(f.store.state().ownedProviderIds).toEqual([A]); expect(f.store.state().lastSuccessfulPlan.providers[0].apiKey).toBe('PRIVATE_OLD_KEY');
    const desired = makePlan(A, MA, 'PRIVATE_NEW_KEY'); desired.providers.push(...makePlan(B, MB, 'PRIVATE_SECOND_KEY').providers);
    await f.apply(desired); expect(f.app.providers.size).toBe(4); expect(f.app.secrets.get(A)).toBe('PRIVATE_NEW_KEY');
    await f.apply({ providers: [] });
    expect(f.app.foreignState()).toEqual(foreign); expect(f.app.providers.has(A)).toBe(false); expect(f.app.providers.has(B)).toBe(false);
    expect(f.store.state()).toMatchObject({ ownedProviderIds: [], lastSuccessfulPlan: { providers: [] } }); expect(f.store.state().pending).toBeUndefined();
    expect(f.store.backups).toHaveLength(3); expect(f.store.backups.every(backup => !backup.includes('PRIVATE_'))).toBe(true);
    expect(Buffer.from(f.store.backups[2], 'base64').toString()).not.toContain('PRIVATE_FOREIGN_SECRET');
    expect(Buffer.from(f.store.backups[2], 'base64').toString()).not.toContain('PRIVATE_CHAT_BODY');
  });
  it('accepts an initial empty selection without claiming or modifying foreign providers', async () => {
    const f = fixture(), before = f.app.foreignState(); await f.apply({ providers: [] });
    expect(f.app.mutations).toEqual([]); expect(f.app.foreignState()).toEqual(before); expect(f.store.state().ownedProviderIds).toEqual([]);
  });
  it('does not claim or roll back a foreign UUID collision rejected before beforeMutation', async () => {
    const f = fixture(); f.app.providers.set(A, { id: A, name: 'Existing external UUID', kind: 'custom', settings: {}, hasSecret: true });
    const nativeBefore = structuredClone([...f.app.providers]);
    const error = await f.apply(makePlan()).catch(error => error);
    expect(error).toBeInstanceOf(CopilotDesktopError); expect(error.category).toBe('ownership');
    expect(f.app.mutations).toEqual([]); expect([...f.app.providers]).toEqual(nativeBefore); expect(f.store.state()).toBeNull(); expect(f.store.backups).toEqual([]); expect(f.app.opens).toBe(1);
  });
  it('does not mutate or roll back when encrypted backup creation fails', async () => {
    const f = fixture(); f.store.backupError = true; await safeFailure(f.apply(makePlan()), 'backup');
    expect(f.app.mutations).toEqual([]); expect(f.store.state()).toBeNull(); expect(f.app.opens).toBe(1);
  });
  it('uses beforeSnapshot metadata and cached keys to restore edited headers, budgets and additional native models after partial writes', async () => {
    const f = fixture(); await f.apply(makePlan()); const previous = f.store.state(), foreign = f.app.foreignState();
    const old = f.app.providers.get(A)!; old.name = 'ModelDock · User-edited label'; old.settings.headersJson = JSON.stringify({ 'X-Trace': 'before-operation' });
    const original = f.app.models.get(MA)!; original.displayName = 'Edited metadata'; original.maxPromptTokens = 90000; original.maxOutputTokens = 5000; original.wireModel = 'native-wire-id'; original.supportedReasoningEfforts = ['low', 'high'];
    f.app.models.set(EXTRA, { id: EXTRA, providerId: A, modelId: 'extra-native-model', displayName: 'Extra native model', wireApiOverride: 'completions', maxPromptTokens: 20000, supportedReasoningEfforts: [] });
    const nativeBefore = structuredClone({ provider: f.app.providers.get(A), models: [...f.app.models.values()].filter(model => model.providerId === A) });
    const desired = makePlan(B, MB, 'PRIVATE_SECOND_KEY'); desired.providers.push(...makePlan(A, MA, 'PRIVATE_NEW_KEY').providers);
    let failed = false; f.app.failAfterMutation = true; f.app.failNext = body => { if (!failed && body.type === 'upsert_provider_model' && body.model.id === MA) { failed = true; return true; } return false; };
    await safeFailure(f.apply(desired), 'restored');
    expect(f.app.providers.get(A)).toEqual(nativeBefore.provider); expect([...f.app.models.values()].filter(model => model.providerId === A)).toEqual(nativeBefore.models);
    expect(f.app.secrets.get(A)).toBe('PRIVATE_OLD_KEY'); expect(f.app.providers.has(B)).toBe(false); expect(f.app.models.has(MB)).toBe(false); expect(f.app.foreignState()).toEqual(foreign); expect(f.store.state()).toEqual(previous); expect(f.app.opens).toBe(3);
  });
  it('recovers an owned provider deleted during a failed clear without re-creating unrelated providers', async () => {
    const f = fixture(); await f.apply(makePlan()); const old = f.store.state();
    let failed = false; f.app.failAfterMutation = true; f.app.failNext = body => { if (!failed && body.type === 'delete_model_provider' && body.provider_id === A) { failed = true; return true; } return false; };
    await safeFailure(f.apply({ providers: [] }), 'restored');
    expect(f.app.providers.has(A)).toBe(true); expect(f.app.models.has(MA)).toBe(true); expect(f.app.secrets.get(A)).toBe('PRIVATE_OLD_KEY'); expect(f.store.state()).toEqual(old);
  });
  it.each(['empty-models', 'first-model-chat'] as const)('restores the actual provider default protocol independently of the model list: %s', async variant => {
    const f = fixture(); await f.apply(makePlan());
    if (variant === 'empty-models') f.app.models.delete(MA); else f.app.models.get(MA)!.wireApiOverride = 'completions';
    const before = structuredClone({ provider: f.app.providers.get(A), models: [...f.app.models.values()].filter(model => model.providerId === A) });
    let failed = false; f.app.failAfterMutation = true; f.app.failNext = body => { if (!failed && body.type === 'upsert_model_provider' && body.provider.id === A) { failed = true; return true; } return false; };
    await safeFailure(f.apply(makePlan(A, MA, 'PRIVATE_NEW_KEY')), 'restored');
    expect(f.app.providers.get(A)).toEqual(before.provider); expect(f.app.providers.get(A)!.settings.wireApi).toBe('responses');
    expect([...f.app.models.values()].filter(model => model.providerId === A)).toEqual(before.models); expect(f.app.secrets.get(A)).toBe('PRIVATE_OLD_KEY');
  });
  it('keeps pending ownership and restoration data when rollback fails, then recovers before the next desired plan', async () => {
    const f = fixture(); await f.apply(makePlan());
    const desired = makePlan(B, MB, 'PRIVATE_SECOND_KEY'); desired.providers.push(...makePlan(A, MA, 'PRIVATE_NEW_KEY').providers);
    f.app.failNext = body => body.type === 'upsert_provider_model' && body.model.id === MA;
    await safeFailure(f.apply(desired), 'recovery');
    const pending = f.store.state(); expect(new Set(pending.ownedProviderIds)).toEqual(new Set([A, B])); expect(pending.pending.restorePlan.providers.map((provider: any) => provider.id)).toEqual([A]);
    expect(pending.pending.beforeOwnedProviderIds).toEqual([A]); expect(pending.lastSuccessfulPlan.providers[0].apiKey).toBe('PRIVATE_OLD_KEY');
    f.app.failNext = undefined; const retryStart = f.app.mutations.length;
    await f.apply(makePlan());
    const retry = f.app.mutations.slice(retryStart);
    expect(retry.some(command => command.type === 'delete_model_provider' && command.provider_id === B)).toBe(true);
    expect(f.app.providers.has(B)).toBe(false); expect(f.app.secrets.get(A)).toBe('PRIVATE_OLD_KEY'); expect(f.store.state().pending).toBeUndefined(); expect(f.store.state().ownedProviderIds).toEqual([A]);
  });
  it('retains the same pending journal when the next recovery attempt also fails', async () => {
    const f = fixture(); await f.apply(makePlan()); f.app.failNext = body => body.type === 'upsert_provider_model';
    await safeFailure(f.apply(makePlan(A, MA, 'PRIVATE_NEW_KEY')), 'recovery'); const pending = f.store.state();
    await safeFailure(f.apply({ providers: [] }), 'recovery'); expect(f.store.state()).toEqual(pending);
  });
  it('rolls native changes back when the last-successful journal commit fails', async () => {
    const f = fixture(); await f.apply(makePlan()); const before = f.store.state(); f.store.failWrite = f.store.writes + 2;
    await safeFailure(f.apply(makePlan(A, MA, 'PRIVATE_NEW_KEY')), 'restored');
    expect(f.app.secrets.get(A)).toBe('PRIVATE_OLD_KEY'); expect(f.store.state()).toEqual(before);
  });
  it('rejects native metadata that cannot be restored before any further mutation', async () => {
    const f = fixture(); await f.apply(makePlan()); f.app.providers.get(A)!.settings.headersJson = '{bad-json';
    const before = f.app.mutations.length; await safeFailure(f.apply(makePlan(A, MA, 'PRIVATE_NEW_KEY')), 'history'); expect(f.app.mutations).toHaveLength(before);
  });
  it('does not treat native credential availability hint as proof that a known cached key was lost', async () => {
    const f = fixture(); await f.apply(makePlan()); f.app.providers.get(A)!.hasSecret = false;
    await f.apply(makePlan(A, MA, 'PRIVATE_UPDATED_KEY'));
    expect(f.app.secrets.get(A)).toBe('PRIVATE_UPDATED_KEY');
  });
  it.each(['foreign-name', 'azure', 'unknown-wire'] as const)('rejects unrecoverable owned metadata: %s', async variant => {
    const f = fixture(); await f.apply(makePlan());
    if (variant === 'foreign-name') f.app.providers.get(A)!.name = 'Noncanonical user label';
    if (variant === 'azure') f.app.providers.get(A)!.settings.azureApiVersion = '2026-01';
    if (variant === 'unknown-wire') { f.app.models.get(MA)!.wireApiOverride = undefined; f.app.providers.get(A)!.settings.wireApi = 'unknown'; }
    const before = f.app.mutations.length; await safeFailure(f.apply(makePlan()), 'history'); expect(f.app.mutations).toHaveLength(before);
  });
  it.each(['version', 'target', 'foreign-owned-id', 'missing-key', 'extra-field'] as const)('rejects corrupt persisted ownership before opening native app: %s', async variant => {
    const f = fixture(); const old: any = { version: 1, target: canonical, ownedProviderIds: [A], lastSuccessfulPlan: makePlan() };
    if (variant === 'version') old.version = 99;
    if (variant === 'target') old.target = join(tmpdir(), 'another-profile');
    if (variant === 'foreign-owned-id') old.ownedProviderIds = [B];
    if (variant === 'missing-key') delete old.lastSuccessfulPlan.providers[0].apiKey;
    if (variant === 'extra-field') old.arbitraryOwnership = 'foreign';
    f.store.setManagedState(key, old); await safeFailure(f.apply(makePlan()), 'history'); expect(f.app.opens).toBe(0); expect(f.app.mutations).toEqual([]);
  });
  it('rejects tampered recovery snapshots and backup paths without granting pending ownership', async () => {
    const f = fixture(); await f.apply(makePlan()); f.app.failNext = body => body.type === 'upsert_provider_model';
    await safeFailure(f.apply(makePlan(A, MA, 'PRIVATE_NEW_KEY')), 'recovery');
    const saved = f.store.state(), before = f.app.opens;
    for (const corrupt of [ { ...saved, pending: { ...saved.pending, backupPath: join(tmpdir(), 'outside-backups.enc') } }, { ...saved, pending: { ...saved.pending, restorePlan: { providers: [] } } } ]) {
      f.store.setManagedState(key, corrupt); await safeFailure(f.apply(makePlan()), 'history'); expect(f.app.opens).toBe(before);
    }
  });
  it('rejects invalid desired plans and relative targets before reading native data', async () => {
    const f = fixture(), desired = makePlan(); desired.providers[0].baseUrl = 'http://remote.example.test/v1';
    await safeFailure(f.apply(desired), 'configuration');
    await safeFailure(applyCopilotDesktop(f.store, makePlan(), 'relative-profile', { openClient: f.app.open }), 'configuration');
    expect(f.app.opens).toBe(0); expect(f.store.encrypted.size).toBe(0);
  });
  it('guards concurrent same-profile writes without queuing them and detaches caller plans before asynchronous work', async () => {
    const f = fixture(); let release!: () => void; f.app.openGate = new Promise<void>(resolve => { release = resolve; });
    const desired = makePlan(), first = f.apply(desired); await Promise.resolve();
    desired.providers[0].apiKey = 'PRIVATE_MUTATED_LATE';
    await safeFailure(f.apply(makePlan()), 'busy'); release(); await first;
    expect(f.app.secrets.get(A)).toBe('PRIVATE_OLD_KEY'); expect(f.app.opens).toBe(1);
    f.app.openGate = undefined; await f.apply({ providers: [] }); expect(f.app.opens).toBe(2);
  });
  it('contains raw connection and close failures and releases the profile guard', async () => {
    const f = fixture();
    await safeFailure(applyCopilotDesktop(f.store, makePlan(), home, { openClient: async () => { throw new Error('PRIVATE_CONNECTION_EXCEPTION'); } }), 'unavailable');
    f.app.closeThrows = true; await f.apply(makePlan());
    f.app.failNext = body => body.type === 'upsert_provider_model'; await safeFailure(f.apply(makePlan(A, MA, 'PRIVATE_NEW_KEY')), 'recovery');
    f.app.failNext = undefined; f.app.closeThrows = false; await f.apply({ providers: [] });
    expect(f.store.state().ownedProviderIds).toEqual([]);
  });
});
