import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { protectPrivateFile, retryPrivateFileOperation } from './private-file';

interface JournalStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
export interface ConfigFileChange { path: string; before: string | null; after: string | null }
interface Pending<H> { modeldockPending: 1; previous: H | null; next: H | null; files: ConfigFileChange[]; order: number[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const maxJournalSize = 7 * 1024 * 1024;
/** Upgrade only recognizable historical plaintext backups during explicit sync. */
export function migrateLegacyConfigBackups(store: JournalStore, directory: string, matches: RegExp, kind: string): void {
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('旧配置备份目录无效，未修改原文件。');
  for (const filename of readdirSync(directory)) {
    if (!matches.test(filename)) continue;
    const path = join(directory, filename), metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 2 * 1024 * 1024) throw new Error('旧配置备份类型或大小无效，未修改原文件。');
    protectPrivateFile(path);
    const content = readFileSync(path, 'utf8');
    store.createManagedBackup(kind, { version: 1, filename, content });
    if (readFileSync(path, 'utf8') !== content) throw new Error('旧配置备份被其他程序修改，已保留原文件和加密备份。');
    retryPrivateFileOperation(() => unlinkSync(path));
  }
}
function pending<H>(value: unknown, paths: string[], validate: (value: unknown) => H | null): Pending<H> | null {
  if (!object(value) || !Object.hasOwn(value, 'modeldockPending')) return null;
  if (value.modeldockPending !== 1 || !Array.isArray(value.files) || value.files.length !== paths.length
    || !Array.isArray(value.order) || value.order.length !== paths.length || new Set(value.order).size !== paths.length
    || value.order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= paths.length)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > maxJournalSize) throw new Error('配置事务恢复记录无效，未修改原文件。');
  validate(value.previous); validate(value.next);
  if (value.files.some((file, index) => !object(file) || file.path !== paths[index]
    || ![file.before, file.after].every(text => text === null || typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 2 * 1024 * 1024))) throw new Error('配置事务恢复记录无效，未修改原文件。');
  return value as unknown as Pending<H>;
}
function rollback<H>(store: JournalStore, key: string, journal: Pending<H>, read: (path: string) => string | null, write: (path: string, text: string | null) => void, files = journal.order.map(index => journal.files[index])): H | null {
  // Check the complete set before touching anything, then recheck each write.
  if (files.some(file => { const text = read(file.path); return text !== file.before && text !== file.after; })) throw new Error('未完成配置事务遇到外部修改，已保留加密恢复记录。');
  for (const file of [...files].reverse()) {
    const text = read(file.path);
    if (text !== file.before && text !== file.after) throw new Error('配置事务恢复期间文件被其他程序修改，已保留加密恢复记录。');
    if (text !== file.before) write(file.path, file.before);
    if (read(file.path) !== file.before) throw new Error('配置事务恢复验证失败，已保留加密恢复记录。');
  }
  store.setManagedState(key, journal.previous);
  return journal.previous;
}
/** Only explicit apply/restore/undo operations invoke recovery; never startup or preview. */
export function recoverConfigJournal<H>(store: JournalStore, key: string, paths: string[], validate: (value: unknown) => H | null,
  read: (path: string) => string | null, write: (path: string, text: string | null) => void): H | null {
  const value = store.getManagedState<unknown>(key, null), journal = pending(value, paths, validate);
  return journal ? rollback(store, key, journal, read, write) : validate(value);
}
export function transactConfigFiles<H>(options: {
  store: JournalStore; key: string; kind: string; before: H | null; after: H | null; files: ConfigFileChange[];
  read: (path: string) => string | null; write: (path: string, text: string | null) => void;
  order?: number[]; beforeCommit?: () => void; afterFileCommit?: (index: number, path: string) => void;
}): void {
  const { store, key, before, after, files, read, write } = options;
  if (files.every(file => file.before === file.after) && isDeepStrictEqual(before, after)) return;
  if (files.some(file => [file.before, file.after].some(text => text !== null && Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024))) throw new Error('配置文件过大，未修改原文件。');
  const order = options.order ?? files.map((_, index) => index);
  if (order.length !== files.length || new Set(order).size !== files.length || order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= files.length)) throw new Error('配置事务写入顺序无效，未修改原文件。');
  const journal: Pending<H> = { modeldockPending: 1, previous: before, next: after, files, order };
  if (Buffer.byteLength(JSON.stringify(journal), 'utf8') > maxJournalSize) throw new Error('配置事务记录过大，未修改原文件。');
  store.createManagedBackup(options.kind, journal);
  let journalAttempted = false; const attempted: ConfigFileChange[] = [];
  try {
    options.beforeCommit?.();
    if (files.some(file => read(file.path) !== file.before) || !isDeepStrictEqual(store.getManagedState(key, null), before)) throw new Error('配置刚被其他程序修改，请重新预览后同步。');
    journalAttempted = true; store.setManagedState(key, journal);
    for (const index of order) {
      const file = files[index];
      if (file.before === file.after) continue;
      if (read(file.path) !== file.before) throw new Error('配置刚被其他程序修改，请重新同步。');
      attempted.push(file); write(file.path, file.after);
      if (read(file.path) !== file.after) throw new Error('配置写入验证失败。');
      options.afterFileCommit?.(index, file.path);
    }
    if (files.some(file => read(file.path) !== file.after)) throw new Error('配置写入后被外部修改。');
    store.setManagedState(key, after);
  } catch (error) {
    if (journalAttempted) try {
      // A storage adapter may commit the final history and then throw. Restore
      // the journal before rollback so a second crash still has exact inputs.
      if (!isDeepStrictEqual(store.getManagedState(key, null), journal)) store.setManagedState(key, journal);
      rollback(store, key, journal, read, write, attempted);
    } catch {
      try { store.setManagedState(key, journal); } catch { /* The encrypted backup remains available. */ }
      throw new Error('配置同步未完成，回滚遇到外部修改或存储错误；已保留加密备份与事务恢复记录。');
    }
    throw error;
  }
}
