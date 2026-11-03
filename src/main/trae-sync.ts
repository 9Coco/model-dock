import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TRAE_PROVIDER_IDS } from '../shared/trae';
import type { TraeModelConfiguration, TraePlan } from './trae-config';

/** Native snapshots are redacted in the bridge; no client API reads a model key. */
export interface TraeNativeModel {
  id: string;
  configuration: TraeModelConfiguration;
  fingerprint: string;
  enabled: boolean;
  revision?: string;
  credentialRevision?: string;
  /** Set only after verifying the native revision changes on key-only edits. */
  metadataRevisionCoversCredentials?: boolean;
}
export interface TraeNativeClient {
  readonly targetId: string;
  listModels(): Promise<TraeNativeModel[]>;
  addModel(configuration: TraeModelConfiguration): Promise<TraeNativeModel>;
  updateModel(id: string, configuration: TraeModelConfiguration): Promise<TraeNativeModel>;
  deleteModel(id: string): Promise<void>;
  close(): void;
}
const nativeMessages = {
  'not-running': '无法连接 Trae CN，请先打开应用并登录，再重新同步。',
  untrusted: '无法验证 Trae CN 本机连接的进程、扩展或配置目录，未发送模型凭据。',
  'unsupported-platform': 'Trae CN 原生配置连接目前仅支持 Windows。',
  'unsupported-version': '当前 Trae CN 版本尚未通过此适配器验证，未修改模型。请使用已支持的版本或等待 ModelDock 适配更新。',
  'login-required': '请先在 Trae CN 中登录，再重新同步。',
  'service-not-ready': 'Trae 模型服务尚未就绪，请打开 Trae 的模型设置后重新同步。',
  'custom-models-disabled': 'Trae 当前账号未开放自定义模型，请在 Trae 中确认账号权限后重新同步。',
  'install-failed': 'ModelDock 连接助手安装未完成，请重新打开 Trae CN 后重试。',
  'restart-required': 'ModelDock 连接助手已安装。请关闭并重新打开 Trae CN，再点击“重新同步”；当前窗口和会话未被自动重载。',
  'schema-incompatible': 'Trae 模型接口格式与此适配器不兼容，未继续同步。请更新 ModelDock 后重试。',
} as const;
export type TraeNativeErrorCode = keyof typeof nativeMessages;
export function isTraeNativeErrorCode(value: unknown): value is TraeNativeErrorCode {
  return typeof value === 'string' && Object.hasOwn(nativeMessages, value);
}
/** A closed set of local action hints, never a native or installer error string. */
export class TraeNativeConnectionError extends Error {
  readonly code: TraeNativeErrorCode;
  constructor(code: TraeNativeErrorCode) {
    const safeCode = isTraeNativeErrorCode(code) ? code : 'not-running';
    super(nativeMessages[safeCode]); this.code = safeCode; this.name = 'TraeNativeConnectionError';
  }
}
/** Only a native response proving rejection may use not-applied. Disconnects,
 * timeouts and unverified replies are unknown even if the request was sent once. */
export class TraeNativeMutationError extends Error {
  readonly code?: TraeNativeErrorCode;
  constructor(readonly outcome: 'not-applied' | 'unknown', code?: TraeNativeErrorCode) {
    super(outcome === 'not-applied' ? isTraeNativeErrorCode(code) ? nativeMessages[code] : 'Trae 拒绝了本次模型操作。' : '无法确认 Trae 模型操作的结果。');
    if (isTraeNativeErrorCode(code)) this.code = code;
    this.name = 'TraeNativeMutationError';
  }
}
export interface TraeSyncStore {
  readonly dataDir: string;
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
export interface TraeSyncOptions {
  openClient?: (target: string) => Promise<TraeNativeClient>;
  recordUndo?: boolean;
}
interface OwnedModel {
  sourceId: string;
  /** The exact main-process input, including only our previously supplied key. */
  configuration: TraeModelConfiguration;
  native: TraeNativeModel;
}
interface Step {
  kind: 'add' | 'update' | 'delete';
  sourceId: string;
  before?: OwnedModel;
  requested?: TraeModelConfiguration;
  after?: OwnedModel;
  status: 'prepared' | 'confirmed' | 'not-applied' | 'uncertain' | 'reversed';
  reversing?: boolean;
}
interface Pending {
  id: string;
  before: OwnedModel[];
  desired: TraePlan;
  working: OwnedModel[];
  steps: Step[];
  phase: 'applying' | 'rolling-back' | 'uncertain';
  backupPath: string;
}
interface Journal { version: 1; target: string; models: OwnedModel[]; pending?: Pending }
interface Undo {
  version: 1; target: string; id: string; completedAt: number;
  before: Journal; complete: Journal;
}
export interface TraeSyncUndoStatus {
  available: boolean; id?: string; completedAt?: number; changed?: boolean; reason?: string;
}
const failures = {
  busy: 'Trae 模型正在同步，请等待本次操作完成。',
  configuration: 'Trae 同步计划无效，未开始修改。',
  history: 'Trae 管理或恢复记录无效，未开始修改。',
  backup: '无法保存 Trae 加密恢复记录，未开始修改。',
  unavailable: '无法连接 Trae CN，请确认应用和 ModelDock 连接扩展正在运行。',
  target: 'Trae 配置目标与已验证的连接不一致，未发送模型凭据。',
  changed: 'ModelDock 管理的 Trae 模型已被其他操作修改或移除，未覆盖新修改。',
  uncertain: 'Trae 操作结果无法确认，部分模型可能已更改；已保留加密恢复记录，未继续写入。',
  recovery: 'Trae 同步未完成且恢复未完成，已保留加密恢复记录，请检查 Trae 模型配置。',
  restored: 'Trae 同步未完成，已恢复本次操作前的托管模型配置；重新创建的模型可能具有新的内部标识。',
  undo: '尚无可撤销的 Trae 同步记录。',
  credentials: 'Trae 原生接口未提供可验证的密钥修改标记，无法安全判断外部密钥变化；已保留加密恢复记录，本次不能自动撤销。',
};
export class TraeSyncError extends Error {
  constructor(readonly category: keyof typeof failures) { super(failures[category]); this.name = 'TraeSyncError'; }
}
function fail(category: keyof typeof failures): never { throw new TraeSyncError(category); }
const activeTargets = new Set<string>();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const clone = <T>(value: T): T => structuredClone(value);
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function targetId(value: string): string { if (!text(value)) fail('configuration'); return value; }
export function traeSyncStateKey(target: string): string { return `trae-sync:${createHash('sha256').update(targetId(target)).digest('hex')}`; }
export function traeSyncUndoKey(target: string): string { return `trae-sync-undo:${createHash('sha256').update(targetId(target)).digest('hex')}`; }
function validEndpoint(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const url = new URL(value), loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    return !!url.hostname && (url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function configuration(value: unknown, redacted: boolean, category: 'configuration' | 'history' = 'history'): TraeModelConfiguration {
  if (!record(value) || !Object.values(TRAE_PROVIDER_IDS).includes(value.provider as any) || !text(value.model_name) || !text(value.display_name)
    || value.is_custom !== true || value.isAkFromServer !== false || value.auth_type !== 0 || typeof value.clearReasoningParam !== 'boolean'
    || !validEndpoint(value.base_url) || (redacted ? value.ak !== '' : !text(value.ak, 8192)) || !record(value.config_detail)
    || typeof value.config_detail.multimodal !== 'boolean' || !record(value.config_detail.model_hyper_params)) fail(category);
  const params = value.config_detail.model_hyper_params;
  for (const key of ['max_tokens', 'prompt_max_tokens']) if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || Number(params[key]) <= 0)) fail(category);
  if (params.thinking_enable !== undefined && (typeof params.thinking_enable !== 'number' || ![0, 1, 2].includes(params.thinking_enable))) fail(category);
  if (params.reasoning_param !== undefined && (!record(params.reasoning_param) || !text(params.reasoning_param.parameter, 256)
    || !Array.isArray(params.reasoning_param.values) || !params.reasoning_param.values.length || params.reasoning_param.values.length > 32
    || params.reasoning_param.values.some(value => !text(value, 128)))) fail(category);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32 * 1024) fail(category);
  return json(value) as unknown as TraeModelConfiguration;
}
function native(value: unknown): TraeNativeModel {
  if (!record(value) || !text(value.id) || !text(value.fingerprint) || typeof value.enabled !== 'boolean'
    || value.revision !== undefined && !text(value.revision) || value.credentialRevision !== undefined && !text(value.credentialRevision)
    || value.metadataRevisionCoversCredentials !== undefined && typeof value.metadataRevisionCoversCredentials !== 'boolean') fail('history');
  return { id: value.id, configuration: configuration(value.configuration, true), fingerprint: value.fingerprint, enabled: value.enabled,
    ...(value.revision !== undefined ? { revision: value.revision as string } : {}), ...(value.credentialRevision !== undefined ? { credentialRevision: value.credentialRevision as string } : {}),
    ...(value.metadataRevisionCoversCredentials !== undefined ? { metadataRevisionCoversCredentials: value.metadataRevisionCoversCredentials as boolean } : {}) };
}
function plan(value: unknown): TraePlan {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.models) || value.models.length > 1000) fail('configuration');
  const used = new Set<string>();
  const models = value.models.map(row => {
    if (!record(row) || !text(row.sourceId) || used.has(row.sourceId)) fail('configuration'); used.add(row.sourceId);
    return { sourceId: row.sourceId, configuration: configuration(row.configuration, false, 'configuration') };
  });
  return { version: 1, models };
}
function owned(value: unknown): OwnedModel[] {
  if (!Array.isArray(value) || value.length > 1000) fail('history');
  const sources = new Set<string>(), ids = new Set<string>();
  return value.map(row => {
    if (!record(row) || !text(row.sourceId) || sources.has(row.sourceId)) fail('history'); sources.add(row.sourceId);
    const snapshot = native(row.native); if (ids.has(snapshot.id)) fail('history'); ids.add(snapshot.id);
    return { sourceId: row.sourceId, configuration: configuration(row.configuration, false), native: snapshot };
  });
}
function journal(value: unknown, target: string): Journal {
  if (value === null) return { version: 1, target, models: [] };
  if (!record(value) || value.version !== 1 || value.target !== target || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024 * 1024) fail('history');
  // Pending transactions are never replayed from status, startup or a later sync.
  // In particular, a timed-out add cannot be claimed by matching its name.
  if (value.pending !== undefined) fail('uncertain');
  return { version: 1, target, models: owned(value.models) };
}
function undoRecord(value: unknown, target: string): Undo | null {
  if (value === null) return null;
  if (!record(value) || value.version !== 1 || value.target !== target || !text(value.id) || !Number.isSafeInteger(value.completedAt) || Number(value.completedAt) <= 0) fail('history');
  return { version: 1, target, id: value.id, completedAt: Number(value.completedAt), before: journal(value.before, target), complete: journal(value.complete, target) };
}
function credentialRevision(model: TraeNativeModel): string | undefined {
  return model.credentialRevision ?? (model.metadataRevisionCoversCredentials ? model.revision : undefined);
}
function sameNative(left: TraeNativeModel, right: TraeNativeModel): boolean {
  return left.id === right.id && left.fingerprint === right.fingerprint && left.enabled === right.enabled
    && isDeepStrictEqual(left.configuration, right.configuration) && left.revision === right.revision
    && credentialRevision(left) === credentialRevision(right);
}
function sameLogical(left: OwnedModel[], right: OwnedModel[]): boolean {
  return left.length === right.length && left.every(row => right.some(other => row.sourceId === other.sourceId && isDeepStrictEqual(row.configuration, other.configuration)));
}
function sameOwned(left: OwnedModel[], right: OwnedModel[]): boolean {
  return sameLogical(left, right) && left.every(row => right.some(other => row.sourceId === other.sourceId && sameNative(row.native, other.native)));
}
async function list(client: TraeNativeClient): Promise<TraeNativeModel[]> {
  const rows = await client.listModels();
  if (!Array.isArray(rows) || rows.length > 10000) fail('history');
  const result = rows.map(native);
  if (new Set(result.map(row => row.id)).size !== result.length) fail('history'); return result;
}
function assertOwned(models: OwnedModel[], current: TraeNativeModel[]): void {
  for (const row of models) {
    const found = current.find(value => value.id === row.native.id);
    if (!found || !sameNative(row.native, found)) fail('changed');
  }
}
function matchesRequest(actual: TraeNativeModel, request: TraeModelConfiguration): boolean {
  const conf = actual.configuration;
  if (conf.provider !== request.provider || conf.model_name !== request.model_name || conf.base_url !== request.base_url
    || conf.display_name !== request.display_name || conf.is_custom !== request.is_custom || conf.auth_type !== request.auth_type
    || conf.config_detail.multimodal !== request.config_detail.multimodal) return false;
  // Native defaults may add optional fields. Every explicitly supplied field
  // must nevertheless round-trip, and clearing a reasoning parameter is exact.
  const wanted = request.config_detail.model_hyper_params, returned = conf.config_detail.model_hyper_params;
  if (Object.entries(wanted).some(([key, value]) => !isDeepStrictEqual(returned[key as keyof typeof returned], value))) return false;
  return !request.clearReasoningParam || returned.reasoning_param === undefined;
}
function close(client: TraeNativeClient | undefined): void { try { client?.close(); } catch { /* Do not expose transport errors or credentials. */ } }

/** Safe metadata only. Availability is rechecked against native state on undo. */
export function traeSyncUndoStatus(store: TraeSyncStore, target: string): TraeSyncUndoStatus {
  try {
    targetId(target);
    if (activeTargets.has(target)) return { available: false, reason: failures.busy };
    const current = journal(store.getManagedState(traeSyncStateKey(target), null), target);
    const saved = undoRecord(store.getManagedState(traeSyncUndoKey(target), null), target);
    if (!saved) return { available: false, reason: failures.undo };
    const metadata = { id: saved.id, completedAt: saved.completedAt, changed: !sameLogical(saved.before.models, saved.complete.models) };
    if (!sameOwned(current.models, saved.complete.models)) return { ...metadata, available: false, reason: failures.changed };
    if ([...saved.before.models, ...saved.complete.models].some(row => !credentialRevision(row.native))) return { ...metadata, available: false, reason: failures.credentials };
    return { ...metadata, available: true };
  } catch (error) { return { available: false, reason: error instanceof TraeSyncError ? error.message : failures.history }; }
}

/** Restore an older outer transaction's checkpoint after a confirmed native
 * undo. Deleted models can be re-created with different IDs/revisions, so
 * copying the old checkpoint bytes back would silently invalidate it. */
export async function restoreTraeSyncUndoCheckpoint(store: TraeSyncStore, target: string, checkpoint: unknown, options: TraeSyncOptions = {}): Promise<void> {
  targetId(target);
  if (activeTargets.has(target)) fail('busy'); activeTargets.add(target);
  let client: TraeNativeClient | undefined;
  try {
    const previous = undoRecord(checkpoint, target), undoKey = traeSyncUndoKey(target);
    if (!previous) { store.setManagedState(undoKey, null); return; }
    const current = journal(store.getManagedState(traeSyncStateKey(target), null), target);
    if (!sameLogical(current.models, previous.complete.models) || current.models.some(row => {
      const prior = previous.complete.models.find(other => other.sourceId === row.sourceId)!;
      return row.native.enabled !== prior.native.enabled || !isDeepStrictEqual(row.native.configuration, prior.native.configuration);
    })) fail('changed');
    if (!options.openClient) fail('unavailable'); client = await options.openClient(target);
    if (client.targetId !== target) fail('target');
    assertOwned(current.models, await list(client));
    store.setManagedState(undoKey, { ...previous, complete: current });
  } catch (error) {
    if (error instanceof TraeSyncError) throw error;
    fail('history');
  } finally { close(client); activeTargets.delete(target); }
}

interface TransactionResult { complete: Journal; material: boolean }
/** Caller owns the target lock. Every mutation is preceded by an encrypted
 * journal write; only confirmed native IDs ever enter the ownership set. */
async function transact(store: TraeSyncStore, desired: TraePlan, target: string, options: TraeSyncOptions, previous: Journal,
  previousUndo: Undo | null, commit: (complete: Journal, material: boolean) => void): Promise<TransactionResult> {
  const key = traeSyncStateKey(target), undoKey = traeSyncUndoKey(target);
  let client: TraeNativeClient | undefined, pending: Pending | undefined;
  const savePending = () => store.setManagedState(key, { ...previous, pending: clone(pending!) });
  let nativeStarted = false;
  try {
    if (!options.openClient) fail('unavailable');
    client = await options.openClient(target);
    if (client.targetId !== target) fail('target');
    const initial = await list(client); assertOwned(previous.models, initial);
    const work = clone(previous.models), requested = new Map(desired.models.map(row => [row.sourceId, row.configuration]));
    const operations: Step[] = [];
    for (const row of desired.models) {
      const before = work.find(item => item.sourceId === row.sourceId);
      if (!before || !isDeepStrictEqual(before.configuration, row.configuration)) operations.push({ kind: before ? 'update' : 'add', sourceId: row.sourceId, ...(before ? { before: clone(before) } : {}), requested: clone(row.configuration), status: 'prepared' });
    }
    for (const before of work) if (!requested.has(before.sourceId)) operations.push({ kind: 'delete', sourceId: before.sourceId, before: clone(before), status: 'prepared' });
    if (!operations.length) { commit(previous, false); return { complete: previous, material: false }; }
    let backupPath: string;
    try {
      backupPath = store.createManagedBackup('trae-sync', { version: 1, target, previous, previousUndo, desired });
      pending = { id: randomUUID(), before: clone(previous.models), desired, working: work, steps: [], phase: 'applying', backupPath };
      savePending();
    } catch { fail('backup'); }
    for (const operation of operations) {
      const current = await list(client); assertOwned(pending.working, current);
      const step = clone(operation); pending.steps.push(step); savePending();
      nativeStarted = true;
      try {
        if (step.kind === 'delete') {
          await client.deleteModel(step.before!.native.id);
          step.status = 'confirmed'; pending.working = pending.working.filter(row => row.sourceId !== step.sourceId);
        } else {
          const returned = native(step.kind === 'add' ? await client.addModel(clone(step.requested!)) : await client.updateModel(step.before!.native.id, clone(step.requested!)));
          if (step.kind === 'add' ? current.some(row => row.id === returned.id) : returned.id !== step.before!.native.id) throw new TraeNativeMutationError('unknown');
          if (!matchesRequest(returned, step.requested!)) throw new TraeNativeMutationError('unknown');
          step.after = { sourceId: step.sourceId, configuration: clone(step.requested!), native: returned };
          step.status = 'confirmed'; pending.working = [...pending.working.filter(row => row.sourceId !== step.sourceId), clone(step.after)];
        }
      } catch (error) {
        step.status = error instanceof TraeNativeMutationError && error.outcome === 'not-applied' ? 'not-applied' : 'uncertain';
        if (step.status === 'uncertain') pending.phase = 'uncertain';
        savePending(); throw error;
      }
      savePending();
    }
    const final = await list(client); assertOwned(pending.working, final);
    for (const step of pending.steps) if (step.kind === 'delete' && final.some(row => row.id === step.before!.native.id)) { pending.phase = 'uncertain'; savePending(); fail('uncertain'); }
    const complete: Journal = { version: 1, target, models: clone(pending.working) };
    store.setManagedState(key, complete); commit(complete, true);
    return { complete, material: true };
  } catch (error) {
    if (!pending || !nativeStarted) {
      if (pending) try { store.setManagedState(key, previous); } catch { fail('recovery'); }
      // Reconstruct the message rather than forwarding a mutable Error.message.
      // Plain objects, forged names and arbitrary native messages remain hidden.
      if (error instanceof TraeNativeConnectionError) throw new TraeNativeConnectionError(error.code);
      if (error instanceof TraeSyncError) throw error;
      fail('unavailable');
    }
    if (pending.phase === 'uncertain' || pending.steps.some(step => step.status === 'uncertain')) {
      try { savePending(); } catch { /* The preceding prepared record remains a fail-closed barrier. */ }
      fail('uncertain');
    }
    if (!pending.steps.some(step => step.status === 'confirmed')) {
      // A verified preflight rejection changed no native model, so it does not
      // require a second bridge connection merely to preserve an actionable hint.
      try { store.setManagedState(key, previous); store.setManagedState(undoKey, previousUndo); } catch { fail('recovery'); }
      if (error instanceof TraeNativeMutationError && error.outcome === 'not-applied' && error.code) throw new TraeNativeConnectionError(error.code);
      fail('restored');
    }
    // A response was acknowledged for every applied step. Roll back only these
    // known IDs, checking fingerprints again; never guess an unacknowledged add.
    try {
      pending.phase = 'rolling-back'; savePending();
      close(client); client = await options.openClient!(target);
      if (client.targetId !== target) fail('target');
      for (const step of [...pending.steps].reverse()) {
        if (step.status !== 'confirmed') continue;
        const current = await list(client); assertOwned(pending.working, current);
        step.reversing = true; savePending();
        if (step.kind === 'add') {
          await client.deleteModel(step.after!.native.id);
          pending.working = pending.working.filter(row => row.sourceId !== step.sourceId);
        } else {
          if (step.kind === 'delete' && current.some(row => row.id === step.before!.native.id)) fail('changed');
          const before = step.before!, config = clone(before.configuration);
          const returned = native(step.kind === 'delete' ? await client.addModel(config) : await client.updateModel(before.native.id, config));
          if (step.kind === 'delete' ? current.some(row => row.id === returned.id) : returned.id !== before.native.id) fail('recovery');
          if (!matchesRequest(returned, config)) fail('recovery');
          pending.working = [...pending.working.filter(row => row.sourceId !== step.sourceId), { ...clone(before), native: returned }];
        }
        step.status = 'reversed'; delete step.reversing; savePending();
      }
      const restoredNative = await list(client); assertOwned(pending.working, restoredNative);
      if (pending.steps.some(step => step.kind === 'add' && step.status === 'reversed' && restoredNative.some(row => row.id === step.after!.native.id))) fail('recovery');
      if (!sameLogical(pending.before, pending.working)) fail('recovery');
      const restored: Journal = { version: 1, target, models: clone(pending.working) };
      // Re-created rows receive new native IDs. Keep the old checkpoint usable
      // only when it referred to exactly this logical pre-transaction state.
      const restoredUndo = previousUndo && sameOwned(previousUndo.complete.models, previous.models) ? { ...previousUndo, complete: restored } : previousUndo;
      store.setManagedState(key, restored); store.setManagedState(undoKey, restoredUndo);
    } catch {
      pending.phase = 'uncertain';
      try { savePending(); } catch { /* Keep the last durable per-step record. */ }
      fail('recovery');
    }
    fail('restored');
  } finally { close(client); }
}

/** Explicit synchronization only; construction/status never applies a plan. */
export async function applyTraeModels(store: TraeSyncStore, rawPlan: TraePlan, target: string, options: TraeSyncOptions = {}): Promise<string> {
  targetId(target); const desired = plan(rawPlan);
  if (activeTargets.has(target)) fail('busy'); activeTargets.add(target);
  try {
    const key = traeSyncStateKey(target), undoKey = traeSyncUndoKey(target);
    const previous = journal(store.getManagedState(key, null), target), previousUndo = undoRecord(store.getManagedState(undoKey, null), target);
    await transact(store, desired, target, options, previous, previousUndo, (complete, material) => {
      if (!material) return; // Preserve the last material checkpoint on no-op sync.
      const saved: Undo = { version: 1, target, id: randomUUID(), completedAt: Date.now(), before: previous, complete };
      store.setManagedState(undoKey, options.recordUndo === false ? null : saved);
    });
    return target;
  } finally { activeTargets.delete(target); }
}

export async function undoTraeModels(store: TraeSyncStore, target: string, options: TraeSyncOptions = {}, onCommit?: () => void): Promise<string> {
  targetId(target);
  if (activeTargets.has(target)) fail('busy');
  const status = traeSyncUndoStatus(store, target);
  if (!status.available) {
    if (status.reason === failures.credentials) fail('credentials');
    if (status.reason === failures.uncertain) fail('uncertain');
    if (status.reason === failures.changed) fail('changed');
    fail('undo');
  }
  activeTargets.add(target);
  try {
    const key = traeSyncStateKey(target), undoKey = traeSyncUndoKey(target);
    const current = journal(store.getManagedState(key, null), target), saved = undoRecord(store.getManagedState(undoKey, null), target)!;
    if (!sameOwned(current.models, saved.complete.models)) fail('changed');
    const desired: TraePlan = { version: 1, models: saved.before.models.map(row => ({ sourceId: row.sourceId, configuration: clone(row.configuration) })) };
    await transact(store, desired, target, options, current, saved, (_complete, material) => {
      if (!material) fail('undo');
      store.setManagedState(undoKey, null); onCommit?.();
    });
    return target;
  } finally { activeTargets.delete(target); }
}
