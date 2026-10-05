import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CopilotDesktopClient, CopilotDesktopError, validateCopilotDesktopSnapshot, type CopilotDesktopPlan, type CopilotDesktopProviderInput, type CopilotDesktopSnapshot, type CopilotDesktopSyncOptions, type CopilotDesktopSyncResult } from './copilot-desktop';
import { captureCopilotCredentials, restoreCopilotCredentials, validateCopilotCredentialBackup, CopilotCredentialError, type CopilotCredentialBackup } from './copilot-credentials';

export interface CopilotSyncStore {
  readonly dataDir: string;
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
export interface CopilotSyncClient {
  sync(plan: CopilotDesktopPlan, options: CopilotDesktopSyncOptions): Promise<CopilotDesktopSyncResult>;
  restoreSnapshot?(snapshot: CopilotDesktopSnapshot, options: CopilotDesktopSyncOptions): Promise<CopilotDesktopSyncResult>;
  close(): void;
}
export interface CopilotSyncOptions {
  openClient?: (copilotHome: string) => Promise<CopilotSyncClient>;
  syncScope?: 'managed' | 'selected';
  captureCredentials?: (providerIds: readonly string[]) => Promise<CopilotCredentialBackup>;
  restoreCredentials?: (backup: CopilotCredentialBackup) => Promise<void>;
}
interface RecoveryBase {
  beforeOwnedProviderIds: string[];
  beforeSnapshot: CopilotDesktopSnapshot;
  attemptedPlan: CopilotDesktopPlan;
  backupPath: string;
}
interface PlanRecovery extends RecoveryBase { recoveryMode?: 'plan'; restorePlan: CopilotDesktopPlan }
interface OpaqueRecovery extends RecoveryBase {
  recoveryMode: 'opaque';
  affectedProviderIds: string[];
  credentials: CopilotCredentialBackup;
}
type Recovery = PlanRecovery | OpaqueRecovery;
interface Journal {
  version: 1;
  target: string;
  ownedProviderIds: string[];
  lastSuccessfulPlan: CopilotDesktopPlan;
  pending?: Recovery;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeTargets = new Set<string>();
const failures = {
  busy: '此 Copilot 配置正在同步，请等待本次操作完成后再试。',
  history: 'Copilot 配置恢复记录无效或缺少原托管凭据，未开始修改，请检查本机管理记录。',
  configuration: 'Copilot 同步计划无效，请检查来源和模型配置。',
  backup: '无法保存 Copilot 加密恢复记录，未开始修改。',
  restored: 'Copilot 同步未完成，已恢复本次操作前的托管配置。请检查后重新同步。',
  recovery: 'Copilot 同步未完成且自动恢复失败，已保留加密恢复记录；请确认应用运行后重新同步。',
  unavailable: '无法连接本机 Copilot 桌面应用，请启动应用后重新同步。',
};
export class CopilotSyncError extends Error {
  constructor(readonly category: keyof typeof failures) { super(failures[category]); this.name = 'CopilotSyncError'; }
}
function fail(category: keyof typeof failures): never { throw new CopilotSyncError(category); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const sameIds = (a: readonly string[], b: readonly string[]) => { const other = [...b].sort(); return a.length === b.length && [...a].sort().every((id, index) => id === other[index]); };
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => !text(id) || !UUID.test(id)) || new Set(value).size !== value.length) fail('history');
  return [...value];
}
function targetHome(value: string): string {
  if (!text(value, 4096) || !isAbsolute(value)) fail('configuration');
  const result = resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result;
}
function endpoint(value: unknown): value is string {
  if (!text(value, 4096)) return false;
  try {
    const url = new URL(value), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    return !!url.hostname && (url.protocol === 'https:' || url.protocol === 'http:' && local) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function plan(value: unknown, category: 'configuration' | 'history'): CopilotDesktopPlan {
  try {
    if (!record(value) || Object.keys(value).some(key => key !== 'providers') || !Array.isArray(value.providers) || value.providers.length > 1000) fail(category);
    const used = new Set<string>();
    for (const provider of value.providers) {
      if (!record(provider) || Object.keys(provider).some(key => !['id', 'name', 'baseUrl', 'apiKey', 'headers', 'models', 'wireApi'].includes(key)) || !text(provider.id) || !UUID.test(provider.id) || used.has(provider.id) || !text(provider.name, 256) || !endpoint(provider.baseUrl) || !text(provider.apiKey, 8192) || !Array.isArray(provider.models) || provider.models.length > 10000) fail(category);
      if (provider.wireApi !== undefined && provider.wireApi !== 'chat' && provider.wireApi !== 'responses') fail(category);
      used.add(provider.id);
      if (provider.headers !== undefined && (!record(provider.headers) || Object.entries(provider.headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || /^(authorization|cookie|host|connection|content-length)$/i.test(key)))) fail(category);
      const names = new Set<string>();
      for (const model of provider.models) {
        if (!record(model) || Object.keys(model).some(key => !['id', 'modelId', 'wireModel', 'displayName', 'wireApi', 'contextWindow', 'maxOutputTokens', 'supportedReasoningEfforts'].includes(key)) || !text(model.id) || !UUID.test(model.id) || used.has(model.id) || !text(model.modelId) || names.has(model.modelId) || !text(model.displayName) || !['chat', 'responses'].includes(String(model.wireApi))) fail(category);
        if (model.wireModel !== undefined && !text(model.wireModel)) fail(category);
        for (const key of ['contextWindow', 'maxOutputTokens']) if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || Number(model[key]) < (key === 'contextWindow' ? 0 : 1))) fail(category);
        if (model.supportedReasoningEfforts !== undefined && (!Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 32 || new Set(model.supportedReasoningEfforts).size !== model.supportedReasoningEfforts.length || model.supportedReasoningEfforts.some(level => !text(level, 64)))) fail(category);
        used.add(model.id); names.add(model.modelId);
      }
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 6 * 1024 * 1024) fail(category);
    return JSON.parse(encoded) as CopilotDesktopPlan;
  } catch { fail(category); }
}
function restore(snapshot: CopilotDesktopSnapshot, previous: CopilotDesktopPlan, owned: string[]): CopilotDesktopPlan {
  if (!record(snapshot) || Object.keys(snapshot).some(key => key !== 'providers') || !Array.isArray(snapshot.providers) || snapshot.providers.length > 1000) fail('history');
  const seen = new Set<string>();
  const providers: CopilotDesktopProviderInput[] = snapshot.providers.map(entry => {
    if (!record(entry) || Object.keys(entry).some(key => key !== 'provider' && key !== 'models') || !record(entry.provider) || !Array.isArray(entry.models)) fail('history');
    const native = entry.provider;
    if (Object.keys(native).some(key => !['id', 'name', 'kind', 'settings', 'hasSecret', 'accountId'].includes(key))) fail('history');
    if (!text(native.id) || !UUID.test(native.id) || !owned.includes(native.id) || seen.has(native.id) || native.kind !== 'custom' || native.accountId !== undefined || typeof native.hasSecret !== 'boolean' || !text(native.name, 256) || !native.name.startsWith('ModelDock · ') || !record(native.settings) || !endpoint(native.settings.baseUrl) || native.settings.authKind !== 'api_key' || native.settings.azureApiVersion !== undefined && native.settings.azureApiVersion !== null) fail('history');
    seen.add(native.id);
    if (Object.keys(native.settings).some(key => !['baseUrl', 'authKind', 'wireApi', 'headersJson', 'azureApiVersion'].includes(key)) || native.settings.wireApi !== 'responses' && native.settings.wireApi !== 'completions') fail('history');
    const cached = previous.providers.find(provider => provider.id === native.id);
    if (!cached || !text(cached.apiKey, 8192)) fail('history');
    let headers: Record<string, string> | undefined;
    if (native.settings.headersJson !== undefined && native.settings.headersJson !== null) {
      if (typeof native.settings.headersJson !== 'string') fail('history');
      try { headers = JSON.parse(native.settings.headersJson); } catch { fail('history'); }
    }
    const models = entry.models.map(model => {
      if (!record(model) || Object.keys(model).some(key => !['id', 'providerId', 'modelId', 'displayName', 'wireModel', 'maxPromptTokens', 'maxOutputTokens', 'wireApiOverride', 'supportedReasoningEfforts'].includes(key)) || model.providerId !== native.id) fail('history');
      const protocol = model.wireApiOverride ?? native.settings.wireApi;
      if (protocol !== 'responses' && protocol !== 'completions') fail('history');
      return { id: model.id, modelId: model.modelId, displayName: model.displayName, wireApi: protocol === 'responses' ? 'responses' as const : 'chat' as const,
        ...(model.wireModel !== undefined ? { wireModel: model.wireModel } : {}),
        ...(model.maxPromptTokens !== undefined ? { contextWindow: model.maxPromptTokens } : {}),
        ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
        ...(model.supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}) };
    });
    return { id: native.id, name: native.name, baseUrl: native.settings.baseUrl, apiKey: cached.apiKey, wireApi: native.settings.wireApi === 'responses' ? 'responses' : 'chat', ...(headers !== undefined ? { headers } : {}), models } as CopilotDesktopProviderInput;
  });
  return plan({ providers }, 'history');
}
function history(value: unknown, target: string, store: CopilotSyncStore): Journal {
  const empty: Journal = { version: 1, target, ownedProviderIds: [], lastSuccessfulPlan: { providers: [] } };
  if (value === null) return empty;
  if (!record(value) || Object.keys(value).some(key => !['version', 'target', 'ownedProviderIds', 'lastSuccessfulPlan', 'pending'].includes(key)) || value.version !== 1 || value.target !== target) fail('history');
  const ownedProviderIds = ids(value.ownedProviderIds), lastSuccessfulPlan = plan(value.lastSuccessfulPlan, 'history');
  if (value.pending === undefined) {
    if (!sameIds(ownedProviderIds, lastSuccessfulPlan.providers.map(provider => provider.id))) fail('history');
    return { version: 1, target, ownedProviderIds, lastSuccessfulPlan };
  }
  const pending = value.pending;
  if (!record(pending) || Object.keys(pending).some(key => !['beforeOwnedProviderIds', 'beforeSnapshot', 'restorePlan', 'attemptedPlan', 'backupPath', 'recoveryMode', 'affectedProviderIds', 'credentials'].includes(key)) || !text(pending.backupPath, 4096) || !isAbsolute(pending.backupPath)) fail('history');
  const inside = relative(resolve(store.dataDir, 'backups'), resolve(pending.backupPath));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) fail('history');
  const beforeOwnedProviderIds = ids(pending.beforeOwnedProviderIds), attemptedPlan = plan(pending.attemptedPlan, 'history');
  if (!sameIds(beforeOwnedProviderIds, lastSuccessfulPlan.providers.map(provider => provider.id)) || !sameIds(ownedProviderIds, [...new Set([...beforeOwnedProviderIds, ...attemptedPlan.providers.map(provider => provider.id)])])) fail('history');
  const beforeSnapshot = structuredClone(pending.beforeSnapshot) as CopilotDesktopSnapshot;
  if (pending.recoveryMode === 'opaque') {
    let snapshot: CopilotDesktopSnapshot, credentials: CopilotCredentialBackup;
    try { snapshot = validateCopilotDesktopSnapshot(beforeSnapshot); credentials = validateCopilotCredentialBackup(pending.credentials); } catch { fail('history'); }
    const affectedProviderIds = ids(pending.affectedProviderIds);
    if (pending.restorePlan !== undefined || !sameIds(affectedProviderIds, [...new Set([...beforeOwnedProviderIds, ...snapshot.providers.map(entry => entry.provider.id), ...attemptedPlan.providers.map(provider => provider.id)])]) || !sameIds(credentials.providers.map(provider => provider.providerId), affectedProviderIds)) fail('history');
    return { version: 1, target, ownedProviderIds, lastSuccessfulPlan, pending: { recoveryMode: 'opaque', beforeOwnedProviderIds, beforeSnapshot: snapshot, attemptedPlan, backupPath: pending.backupPath, affectedProviderIds, credentials } };
  }
  if (pending.recoveryMode !== undefined && pending.recoveryMode !== 'plan' || pending.affectedProviderIds !== undefined || pending.credentials !== undefined) fail('history');
  const restorePlan = plan(pending.restorePlan, 'history');
  if (!isDeepStrictEqual(restore(beforeSnapshot, lastSuccessfulPlan, beforeOwnedProviderIds), restorePlan)) fail('history');
  return { version: 1, target, ownedProviderIds, lastSuccessfulPlan, pending: { beforeOwnedProviderIds, beforeSnapshot, restorePlan, attemptedPlan, backupPath: pending.backupPath } };
}

/** Update the running native app; never launch it or write its SQLite directly. */
export async function applyCopilotDesktop(store: CopilotSyncStore, rawPlan: CopilotDesktopPlan, copilotHome: string, options: CopilotSyncOptions = {}): Promise<string> {
  const target = targetHome(copilotHome), desired = plan(rawPlan, 'configuration');
  const syncScope = options.syncScope ?? 'managed';
  if (syncScope !== 'managed' && syncScope !== 'selected') fail('configuration');
  if (activeTargets.has(target)) fail('busy');
  activeTargets.add(target);
  const key = `copilot-sync:${createHash('sha256').update(target).digest('hex')}`;
  const openClient = options.openClient ?? (home => CopilotDesktopClient.open(home));
  const captureCredentials = options.captureCredentials ?? captureCopilotCredentials;
  const restoreCredentials = options.restoreCredentials ?? restoreCopilotCredentials;
  let client: CopilotSyncClient | undefined;
  const closeClient = () => { try { client?.close(); } catch { /* Native close details never escape. */ } client = undefined; };
  async function restorePending(pending: Recovery, ownedProviderIds: string[], backupHistory?: Journal): Promise<void> {
    if (pending.recoveryMode === 'opaque') {
      if (!client?.restoreSnapshot) fail('recovery');
      await client.restoreSnapshot(pending.beforeSnapshot, { ownedProviderIds: pending.affectedProviderIds, beforeMutation: async snapshot => {
        // Native ownership is checked before this callback and before any OS
        // blob is restored. Credentials are opaque bytes, never API-key strings.
        if (backupHistory) store.createManagedBackup('copilot-recovery', { version: 1, target, history: backupHistory, snapshot });
        await restoreCredentials(pending.credentials);
      } });
      // Delete-provider can clear a key slot whose pre-operation state was an
      // orphan credential. Reassert all captured slots, including prior absence.
      await restoreCredentials(pending.credentials);
    } else {
      await client!.sync(pending.restorePlan, { ownedProviderIds, beforeMutation: backupHistory ? snapshot => { store.createManagedBackup('copilot-recovery', { version: 1, target, history: backupHistory, snapshot }); } : undefined });
    }
  }
  try {
    let current: Journal;
    try { current = history(store.getManagedState<unknown>(key, null), target, store); } catch { fail('history'); }
    if (current.pending) {
      const pending = current.pending;
      try {
        client = await openClient(copilotHome);
        await restorePending(pending, current.ownedProviderIds, current);
        current = { version: 1, target, ownedProviderIds: pending.beforeOwnedProviderIds, lastSuccessfulPlan: current.lastSuccessfulPlan };
        store.setManagedState(key, current);
      } catch { fail('recovery'); }
      finally { closeClient(); }
    }
    const previous = structuredClone(current);
    let mutationStarted = false, callbackFailure: CopilotSyncError | CopilotCredentialError | undefined;
    let pendingState: Journal | undefined;
    try {
      client = await openClient(copilotHome);
      await client.sync(desired, { ownedProviderIds: previous.ownedProviderIds, syncScope, beforeMutation: async snapshot => {
        try {
          const ownedProviderIds = [...new Set([...previous.ownedProviderIds, ...desired.providers.map(provider => provider.id)])];
          if (syncScope === 'selected') {
            if (!client?.restoreSnapshot) fail('backup');
            const beforeSnapshot = validateCopilotDesktopSnapshot(snapshot);
            const affectedProviderIds = [...new Set([...ownedProviderIds, ...beforeSnapshot.providers.map(entry => entry.provider.id)])];
            const credentials = validateCopilotCredentialBackup(await captureCredentials(affectedProviderIds));
            if (!sameIds(credentials.providers.map(provider => provider.providerId), affectedProviderIds)) fail('backup');
            const backupPath = store.createManagedBackup('copilot-sync', { version: 1, target, previous, beforeSnapshot, attemptedPlan: desired, credentials, affectedProviderIds });
            pendingState = { ...previous, ownedProviderIds, pending: { recoveryMode: 'opaque', beforeOwnedProviderIds: previous.ownedProviderIds, beforeSnapshot, attemptedPlan: desired, backupPath, affectedProviderIds, credentials } };
          } else {
            const restorePlan = restore(snapshot, previous.lastSuccessfulPlan, previous.ownedProviderIds);
            const backupPath = store.createManagedBackup('copilot-sync', { version: 1, target, previous, beforeSnapshot: snapshot, attemptedPlan: desired });
            pendingState = { ...previous, ownedProviderIds, pending: { beforeOwnedProviderIds: previous.ownedProviderIds, beforeSnapshot: structuredClone(snapshot), restorePlan, attemptedPlan: desired, backupPath } };
          }
          store.setManagedState(key, pendingState);
          mutationStarted = true;
        } catch (error) {
          callbackFailure = error instanceof CopilotSyncError || error instanceof CopilotCredentialError ? error : new CopilotSyncError('backup');
          if (pendingState) try { store.setManagedState(key, previous); } catch { /* A recovery journal is retained if storage is unavailable. */ }
          throw callbackFailure;
        }
      } });
      const complete: Journal = { version: 1, target, ownedProviderIds: desired.providers.map(provider => provider.id), lastSuccessfulPlan: desired };
      store.setManagedState(key, complete);
      return join(resolve(copilotHome), 'data.db');
    } catch (error) {
      if (!mutationStarted || !pendingState?.pending) {
        if (callbackFailure) throw callbackFailure;
        if (error instanceof CopilotDesktopError) throw error;
        fail('unavailable');
      }
      closeClient();
      try {
        client = await openClient(copilotHome);
        await restorePending(pendingState.pending, pendingState.ownedProviderIds);
        store.setManagedState(key, previous);
      } catch {
        try { store.setManagedState(key, pendingState); } catch { /* The already persisted pending journal remains the recovery authority. */ }
        fail('recovery');
      }
      fail('restored');
    }
  } finally { closeClient(); activeTargets.delete(target); }
  fail('unavailable');
}
