import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ToolBinding, ToolId } from '../shared/types';
import { isJetBrainsTool } from '../shared/jetbrains';
import { codexHistoryKey } from './adapters';
import { claudeConfigDirectory, claudeHistoryKey } from './claude-config';
import { openCodeConfigDirectory } from './opencode-paths';
import { DSH_LEGACY_SCRIPT } from './dsh-runtime';
import { copilotSyncUndoKey, copilotSyncUndoStatus, undoCopilotDesktop, type CopilotSyncOptions } from './copilot-sync';

/** All contents and ownership snapshots remain in the encrypted main-process
 * managed store. Only status()'s safe metadata is suitable for an IPC response. */
export interface ToolSyncUndoStore {
  dataDir: string;
  listBindings(): ToolBinding[];
  restoreBindingSelection(binding: ToolBinding): void;
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
export interface ToolSyncUndoOptions {
  appData: string; homeDirectory?: string; codexHome?: string; configHome?: string;
  claudeConfigDir?: string; dshHome?: string; copilotHome?: string;
  copilotOptions?: CopilotSyncOptions;
  /** Private failure-injection seam, never accepted from a renderer. */
  replaceFile?: (path: string, content: string | null, mode: number) => void;
}
export interface ToolSyncUndoStatus { available: boolean; reason?: string; syncedAt?: number }
interface SnapshotFile { path: string; content: string | null; mode: number }
interface SnapshotState { key: string; value: unknown }
interface FileRecord {
  version: 1; kind: 'files'; tool: ToolId; syncedAt: number;
  beforeBinding: ToolBinding; appliedBinding: ToolBinding;
  beforeFiles: SnapshotFile[]; appliedFiles: SnapshotFile[];
  beforeStates: SnapshotState[]; appliedStates: SnapshotState[];
}
interface CopilotRecord {
  version: 1; kind: 'copilot'; tool: 'copilot'; syncedAt: number;
  beforeBinding: ToolBinding; appliedBinding: ToolBinding; nativeCheckpointId: string;
}
type UndoRecord = FileRecord | CopilotRecord;
const bindingFields = ['enabled', 'mode', 'providerIds', 'modelIds', 'modelSelection', 'defaultModelId', 'connectionChoices', 'vscodeSyncScope', 'copilotSyncScope', 'dshSyncScope', 'claudeDisableTelemetry'] as const;
const maximumFileSize = 2 * 1024 * 1024, maximumRecordSize = 8 * 1024 * 1024;
const errors = {
  busy: '此工具配置正在更新，请稍后再撤销。',
  missing: '尚无可撤销的同步记录。',
  changed: '工具配置或来源选择已被其他操作修改，未覆盖新修改；请重新同步。',
  invalid: '同步撤销记录或配置目标无效，未修改外部配置。',
  storage: '无法保存同步撤销记录，尚未修改外部配置。',
  rollback: '撤销未完成，已恢复撤销前的配置；撤销记录仍然保留。',
  recovery: '配置操作未完成且恢复未完成，已保留加密备份与撤销记录，请检查本地配置。',
};
function fail(kind: keyof typeof errors): never { throw new Error(errors[kind]); }
function clone<T>(value: T): T { return structuredClone(value); }
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function selection(binding: ToolBinding): unknown { return json(Object.fromEntries(bindingFields.map(field => [field, binding[field]]))); }
function mergeSelection(current: ToolBinding, saved: ToolBinding): ToolBinding {
  return { ...current, ...Object.fromEntries(bindingFields.map(field => [field, clone(saved[field])])) };
}
function safeDirectory(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) fail('invalid'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
function read(path: string): SnapshotFile {
  safeDirectory(dirname(path));
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, content: null, mode: 0o600 }; throw error; }
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximumFileSize) fail('invalid');
  return { path, content: readFileSync(path, 'utf8'), mode: info.mode & 0o777 };
}
function matches(file: SnapshotFile): boolean { return read(file.path).content === file.content; }
function replaceFile(path: string, content: string | null, mode: number): void {
  safeDirectory(dirname(path));
  if (content === null) { if (read(path).content !== null) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.modeldock-undo-${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { mode, flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
export function toolSyncUndoKey(tool: ToolId): string { return `tool-sync-undo:${tool}`; }

/** Creates checkpoints only when run() is explicitly invoked. Construction,
 * status lookup and application startup never replay or create file writes. */
export class ToolSyncUndoManager {
  private readonly active = new Set<ToolId>();
  constructor(private readonly store: ToolSyncUndoStore, private readonly options: ToolSyncUndoOptions) {}
  private binding(tool: ToolId): ToolBinding {
    const binding = this.store.listBindings().find(value => value.id === tool);
    if (!binding) fail('invalid'); return clone(binding);
  }
  private targets(tool: ToolId): { paths: string[]; stateKeys: string[]; target: string } {
    const home = this.options.homeDirectory ?? homedir();
    if (tool === 'codex') {
      const target = join(this.options.codexHome ?? join(home, '.codex'), 'config.toml');
      return { target, paths: [target, join(dirname(target), 'modeldock-models.json')], stateKeys: [codexHistoryKey(target)] };
    }
    if (tool === 'claude-code') {
      const target = join(claudeConfigDirectory(home, this.options.claudeConfigDir), 'settings.json');
      return { target, paths: [target], stateKeys: [claudeHistoryKey(target)] };
    }
    if (tool === 'opencode') {
      const directory = openCodeConfigDirectory(home, this.options.configHome), jsoncPath = join(directory, 'opencode.jsonc'), jsonPath = join(directory, 'opencode.json');
      return { target: read(jsoncPath).content !== null ? jsoncPath : jsonPath, paths: [jsoncPath, jsonPath], stateKeys: [] };
    }
    if (tool === 'vscode') {
      const target = join(this.options.appData, 'Code', 'User', 'chatLanguageModels.json');
      return { target, paths: [target], stateKeys: [] };
    }
    if (tool === 'dsh') {
      const target = resolve(this.options.dshHome ?? join(home, '.dsh'));
      const normalized = process.platform === 'win32' ? target.toLowerCase() : target;
      return { target: join(target, 'cordis.patch.yml'), paths: [join(target, 'cordis.patch.yml'), join(target, '.credentials.yaml'), join(target, DSH_LEGACY_SCRIPT)], stateKeys: [`dsh-sync:${createHash('sha256').update(normalized).digest('hex')}`] };
    }
    fail('invalid');
  }
  private copilotHome(): string { return this.options.copilotHome ?? join(this.options.homeDirectory ?? homedir(), '.copilot'); }
  private states(keys: string[]): SnapshotState[] { return keys.map(key => ({ key, value: this.store.getManagedState<unknown>(key, null) })); }
  private readRecord(tool: ToolId): UndoRecord | null {
    const value = this.store.getManagedState<UndoRecord | null>(toolSyncUndoKey(tool), null);
    if (!value) return null;
    if (value.version !== 1 || value.tool !== tool || !Number.isSafeInteger(value.syncedAt) || value.syncedAt < 1
      || !value.beforeBinding || value.beforeBinding.id !== tool || !value.appliedBinding || value.appliedBinding.id !== tool
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumRecordSize) fail('invalid');
    if (value.kind === 'copilot') {
      if (tool !== 'copilot' || typeof value.nativeCheckpointId !== 'string') fail('invalid');
      return value;
    }
    if (value.kind !== 'files') fail('invalid');
    const targets = this.targets(tool);
    const validFiles = (files: SnapshotFile[]) => Array.isArray(files) && files.length === targets.paths.length && files.every((file, index) => file.path === targets.paths[index]
      && (file.content === null || typeof file.content === 'string' && Buffer.byteLength(file.content, 'utf8') <= maximumFileSize) && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777);
    const validStates = (states: SnapshotState[]) => Array.isArray(states) && states.length === targets.stateKeys.length && states.every((state, index) => state.key === targets.stateKeys[index]);
    if (!validFiles(value.beforeFiles) || !validFiles(value.appliedFiles) || !validStates(value.beforeStates) || !validStates(value.appliedStates)) fail('invalid');
    return value;
  }
  private assertApplied(saved: UndoRecord): void {
    if (!isDeepStrictEqual(selection(this.binding(saved.tool)), selection(saved.appliedBinding))) fail('changed');
    if (saved.kind === 'files' && (saved.appliedFiles.some(file => !matches(file))
      || !isDeepStrictEqual(this.states(saved.appliedStates.map(state => state.key)), saved.appliedStates))) fail('changed');
    if (saved.kind === 'copilot' && copilotSyncUndoStatus(this.store, this.copilotHome()).id !== saved.nativeCheckpointId) fail('changed');
  }
  status(tool: ToolId): ToolSyncUndoStatus {
    if (isJetBrainsTool(tool)) return { available: false, reason: 'JetBrains 使用现有配置备份与还原入口。' };
    if (this.active.has(tool)) return { available: false, reason: errors.busy };
    try {
      const saved = this.readRecord(tool); if (!saved) return { available: false, reason: errors.missing };
      this.assertApplied(saved); return { available: true, syncedAt: saved.syncedAt };
    } catch (error) { return { available: false, reason: error instanceof Error && Object.values(errors).includes(error.message) ? error.message : errors.invalid }; }
  }
  clear(tool: ToolId): void {
    if (this.active.has(tool)) fail('busy');
    this.store.setManagedState(toolSyncUndoKey(tool), null);
    if (tool === 'copilot') this.store.setManagedState(copilotSyncUndoKey(this.copilotHome()), null);
  }
  async run<T>(tool: ToolId, beforeBinding: ToolBinding | undefined, operation: () => T | Promise<T>): Promise<T> {
    if (isJetBrainsTool(tool)) return await operation();
    if (this.active.has(tool)) fail('busy');
    this.active.add(tool);
    try {
      const appliedBinding = this.binding(tool), before = clone(beforeBinding ?? appliedBinding);
      if (before.id !== tool) fail('invalid');
      const previousRecord = this.store.getManagedState<unknown>(toolSyncUndoKey(tool), null);
      if (tool === 'copilot') {
        const nativeKey = copilotSyncUndoKey(this.copilotHome()), previousNative = this.store.getManagedState<unknown>(nativeKey, null);
        this.store.createManagedBackup('tool-sync-selection', { version: 1, tool, beforeBinding: before });
        const result = await operation(), native = copilotSyncUndoStatus(this.store, this.copilotHome());
        if (!native.available || !native.id) fail('invalid');
        if (!native.changed) { this.store.setManagedState(nativeKey, previousNative); return result; }
        const saved: CopilotRecord = { version: 1, kind: 'copilot', tool, syncedAt: native.completedAt!, beforeBinding: before, appliedBinding, nativeCheckpointId: native.id };
        try { this.store.setManagedState(toolSyncUndoKey(tool), saved); }
        catch {
          try {
            await undoCopilotDesktop(this.store, this.copilotHome(), this.options.copilotOptions, () => {
              try { this.store.restoreBindingSelection(mergeSelection(this.binding(tool), before)); }
              catch (error) {
                if (isDeepStrictEqual(selection(this.binding(tool)), selection(before))) this.store.restoreBindingSelection(mergeSelection(this.binding(tool), appliedBinding));
                throw error;
              }
            });
            this.store.setManagedState(nativeKey, previousNative); this.store.setManagedState(toolSyncUndoKey(tool), previousRecord);
          } catch { fail('recovery'); }
          fail('rollback');
        }
        return result;
      }
      const targets = this.targets(tool), beforeFiles = targets.paths.map(read), beforeStates = this.states(targets.stateKeys);
      try { this.store.createManagedBackup('tool-sync-undo', { version: 1, tool, beforeBinding: before, beforeFiles, beforeStates }); }
      catch { fail('storage'); }
      const requested = operation();
      // File adapters commit synchronously. Capture their output in the same
      // turn instead of yielding before taking the last-applied checkpoint.
      const result = requested instanceof Promise ? await requested : requested;
      const saved: FileRecord = { version: 1, kind: 'files', tool, syncedAt: Date.now(), beforeBinding: before, appliedBinding,
        beforeFiles, appliedFiles: targets.paths.map(read), beforeStates, appliedStates: this.states(targets.stateKeys) };
      // A repeated explicit sync with no actual file, state or selection change
      // keeps the previous useful checkpoint instead of consuming it with a no-op.
      if (beforeFiles.every((file, index) => file.content === saved.appliedFiles[index].content)
        && isDeepStrictEqual(beforeStates, saved.appliedStates)) return result;
      try {
        if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > maximumRecordSize) fail('storage');
        this.store.setManagedState(toolSyncUndoKey(tool), saved);
      } catch {
        try { this.restoreFiles(saved, false); this.store.setManagedState(toolSyncUndoKey(tool), previousRecord); }
        catch { fail('recovery'); }
        fail('rollback');
      }
      return result;
    } finally { this.active.delete(tool); }
  }
  private restoreFiles(saved: FileRecord, consume: boolean): void {
    this.assertApplied(saved);
    const writtenFiles: number[] = [], writtenStates: number[] = [];
    const writer = this.options.replaceFile ?? replaceFile;
    let bindingAttempted = false;
    try {
      for (const [index, before] of saved.beforeFiles.entries()) if (before.content !== saved.appliedFiles[index].content) {
        if (!matches(saved.appliedFiles[index])) fail('changed');
        writtenFiles.push(index); writer(before.path, before.content, before.mode);
      }
      if (saved.beforeFiles.some(file => !matches(file))) fail('changed');
      for (const [index, before] of saved.beforeStates.entries()) {
        if (!isDeepStrictEqual(this.store.getManagedState(before.key, null), saved.appliedStates[index].value)) fail('changed');
        writtenStates.push(index); this.store.setManagedState(before.key, before.value);
      }
      if (!isDeepStrictEqual(selection(this.binding(saved.tool)), selection(saved.appliedBinding))) fail('changed');
      bindingAttempted = true; this.store.restoreBindingSelection(mergeSelection(this.binding(saved.tool), saved.beforeBinding));
      if (consume) this.store.setManagedState(toolSyncUndoKey(saved.tool), null);
    } catch (error) {
      try {
        if (bindingAttempted && !isDeepStrictEqual(selection(this.binding(saved.tool)), selection(saved.appliedBinding))) {
          if (!isDeepStrictEqual(selection(this.binding(saved.tool)), selection(saved.beforeBinding))) fail('changed');
          this.store.restoreBindingSelection(mergeSelection(this.binding(saved.tool), saved.appliedBinding));
        }
        for (const index of writtenStates.reverse()) {
          const before = saved.beforeStates[index], applied = saved.appliedStates[index];
          const current = this.store.getManagedState(before.key, null);
          if (isDeepStrictEqual(current, applied.value)) continue;
          if (!isDeepStrictEqual(current, before.value)) fail('changed');
          this.store.setManagedState(applied.key, applied.value);
        }
        for (const index of writtenFiles.reverse()) {
          const applied = saved.appliedFiles[index]; if (matches(applied)) continue;
          if (!matches(saved.beforeFiles[index])) fail('changed');
          writer(applied.path, applied.content, applied.mode);
        }
        if (consume && this.store.getManagedState(toolSyncUndoKey(saved.tool), null) === null) this.store.setManagedState(toolSyncUndoKey(saved.tool), saved);
      } catch { fail('recovery'); }
      throw error;
    }
  }
  async undo(tool: ToolId): Promise<string> {
    if (this.active.has(tool)) fail('busy');
    const saved = this.readRecord(tool); if (!saved) fail('missing');
    this.assertApplied(saved); this.active.add(tool);
    try {
      this.store.createManagedBackup('tool-sync-undo-restore', saved);
      if (saved.kind === 'copilot') return await undoCopilotDesktop(this.store, this.copilotHome(), this.options.copilotOptions, () => {
        let bindingAttempted = false;
        try {
          if (!isDeepStrictEqual(selection(this.binding(tool)), selection(saved.appliedBinding))) fail('changed');
          bindingAttempted = true; this.store.restoreBindingSelection(mergeSelection(this.binding(tool), saved.beforeBinding));
          this.store.setManagedState(toolSyncUndoKey(tool), null);
        } catch (error) {
          if (bindingAttempted && isDeepStrictEqual(selection(this.binding(tool)), selection(saved.beforeBinding))) this.store.restoreBindingSelection(mergeSelection(this.binding(tool), saved.appliedBinding));
          this.store.setManagedState(toolSyncUndoKey(tool), saved); throw error;
        }
      });
      try { this.restoreFiles(saved, true); }
      catch (error) { if ((error as Error).message === errors.recovery) throw error; fail('rollback'); }
      return this.targets(tool).target;
    } finally { this.active.delete(tool); }
  }
}
