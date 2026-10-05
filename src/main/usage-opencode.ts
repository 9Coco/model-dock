import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import type { UsageRecord, TokenUsage } from '../shared/usage-types';
import type { ToolUsageImportResult } from '../shared/usage-import-types';
import type { ClientUsageStore } from './usage-import';

// Metadata schema reference: CC Switch 4.0, independent implementation.
// https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/services/session_usage_opencode.rs
// SQLite WAL snapshot format: https://sqlite.org/walformat.html
let sql: Promise<SqlJsStatic> | undefined;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const identity = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : '';
const modelName = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,180}$/.test(value) ? value : '';
const same = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function checksum(bytes: Uint8Array, little: boolean, initial: [number, number] = [0, 0]): [number, number] {
  if (bytes.byteLength % 8) throw new Error('SQLite WAL 数据长度无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [first, second] = initial;
  for (let index = 0; index < bytes.length; index += 8) {
    first = (first + view.getUint32(index, little) + second) >>> 0;
    second = (second + view.getUint32(index + 4, little) + first) >>> 0;
  }
  return [first, second];
}

/** Apply only the last checksum-verified committed WAL prefix, entirely in RAM.
 * No SQLite connection touches native files or creates native -shm sidecars.
 */
export function sqliteUsageSnapshot(database: Uint8Array, wal: Uint8Array | undefined, maxBytes: number): Uint8Array {
  if (database.length < 100 || Buffer.from(database.subarray(0, 16)).toString('ascii') !== 'SQLite format 3\0') throw new Error('OpenCode 数据库格式不受支持');
  const base = new DataView(database.buffer, database.byteOffset, database.byteLength);
  const basePageSize = base.getUint16(16, false) === 1 ? 65_536 : base.getUint16(16, false);
  if (basePageSize < 512 || basePageSize > 65_536 || basePageSize & basePageSize - 1 || database.length % basePageSize !== 0) throw new Error('SQLite 数据页格式无效');
  let final = new Uint8Array(database);
  if (wal?.length) {
    if (wal.length < 32) throw new Error('SQLite WAL 尚未完整写入');
    const header = new DataView(wal.buffer, wal.byteOffset, wal.byteLength), magic = header.getUint32(0, false);
    if (![0x377f0682, 0x377f0683].includes(magic) || header.getUint32(4, false) !== 3_007_000 || header.getUint32(8, false) !== basePageSize) throw new Error('SQLite WAL 头格式无效');
    const little = magic === 0x377f0682, salt1 = header.getUint32(16, false), salt2 = header.getUint32(20, false);
    let rolling = checksum(wal.subarray(0, 24), little);
    if (rolling[0] !== header.getUint32(24, false) || rolling[1] !== header.getUint32(28, false)) throw new Error('SQLite WAL 头校验失败');
    const frames: { page: number; offset: number }[] = [];
    let committed = 0, pageCount = 0;
    for (let offset = 32; offset + 24 + basePageSize <= wal.length; offset += 24 + basePageSize) {
      const page = header.getUint32(offset, false), pages = header.getUint32(offset + 4, false);
      // A writer may leave an old or uncommitted suffix. It is not a commit.
      if (!page || header.getUint32(offset + 8, false) !== salt1 || header.getUint32(offset + 12, false) !== salt2) break;
      rolling = checksum(wal.subarray(offset, offset + 8), little, rolling);
      rolling = checksum(wal.subarray(offset + 24, offset + 24 + basePageSize), little, rolling);
      if (rolling[0] !== header.getUint32(offset + 16, false) || rolling[1] !== header.getUint32(offset + 20, false)) throw new Error('SQLite WAL 数据校验失败');
      if (page * basePageSize > maxBytes || pages * basePageSize > maxBytes) throw new Error('OpenCode 数据快照超过大小限制');
      frames.push({ page, offset: offset + 24 });
      if (pages) { committed = frames.length; pageCount = pages; }
    }
    if (committed) {
      final = new Uint8Array(pageCount * basePageSize); final.set(database.subarray(0, final.length));
      for (const frame of frames.slice(0, committed)) if (frame.page <= pageCount) final.set(wal.subarray(frame.offset, frame.offset + basePageSize), (frame.page - 1) * basePageSize);
    }
  }
  // This is a private in-memory image, with all committed WAL pages merged.
  // sql.js never sees or accesses the original database or its directory.
  final[18] = 1; final[19] = 1;
  return final;
}

async function boundedFile(filename: string, root: string, maxBytes: number): Promise<{ bytes: Uint8Array; stat: Awaited<ReturnType<typeof lstat>> } | undefined> {
  let before; try { before = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('OpenCode 数据文件为链接、非文件或超过大小限制');
  const target = await realpath(filename), path = relative(root, target);
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('OpenCode 数据目录逃逸，已跳过');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(); if (!same(before, opened)) throw new Error('OpenCode 数据正在变化，请稍后重试');
    const bytes = new Uint8Array(opened.size);
    let offset = 0; while (offset < bytes.length) { const result = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset !== bytes.length || !same(opened, await handle.stat())) throw new Error('OpenCode 数据正在变化，请稍后重试');
    return { bytes, stat: opened };
  } finally { await handle.close(); }
}
function normalizedCounters(tokens: Record<string, unknown>): TokenUsage | undefined {
  const input = count(tokens.input), output = count(tokens.output), cache = object(tokens.cache);
  if (input === undefined || output === undefined) return undefined;
  const read = count(cache.read) ?? 0, write = count(cache.write) ?? 0, reasoning = count(tokens.reasoning) ?? 0;
  if (!Number.isSafeInteger(input + read + write) || !Number.isSafeInteger(output + reasoning)) return undefined;
  return { inputTokens: input + read + write, outputTokens: output + reasoning, cachedInputTokens: read, ...(write ? { cacheCreationInputTokens: write } : {}) };
}

export async function importOpenCodeUsage(directory: string, store: ClientUsageStore, limits: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number; maxLineBytes: number }): Promise<ToolUsageImportResult> {
  const result: ToolUsageImportResult = { tool: 'opencode', scannedFiles: 0, imported: 0, skipped: 0, deferredFiles: 0, warnings: [], status: 'ready' };
  let database: { bytes: Uint8Array; stat: Awaited<ReturnType<typeof lstat>> } | undefined, wal: typeof database;
  const filename = join(directory, 'opencode.db');
  try {
    const directoryStat = await lstat(directory); if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('OpenCode 数据目录为链接或不是目录');
    const root = await realpath(directory);
    database = await boundedFile(filename, root, limits.maxFileBytes);
    if (!database) { result.status = 'missing'; result.warnings.push('未找到可读取的 OpenCode 会话数据库。'); return result; }
    result.scannedFiles = 1;
    const journal = await lstat(`${filename}-journal`).catch(() => undefined);
    if (journal?.size) throw new Error('OpenCode 数据库存在待恢复的事务日志，暂缓读取');
    wal = await boundedFile(`${filename}-wal`, root, Math.min(limits.maxFileBytes, limits.maxTotalBytes - database.bytes.length));
    if (!same(database.stat, await lstat(filename))) throw new Error('OpenCode 数据库在读取 WAL 时发生变化，请重试');
    const walAfter = await lstat(`${filename}-wal`).catch(() => undefined);
    if (Boolean(wal) !== Boolean(walAfter) || wal && walAfter && !same(wal.stat, walAfter)) throw new Error('OpenCode WAL 在扫描中发生变化，请重试');
    const snapshot = sqliteUsageSnapshot(database.bytes, wal?.bytes, limits.maxFileBytes);
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    sql ??= initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
    const SQL = await sql, db = new SQL.Database(snapshot);
    try {
      db.run('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const tables = new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map(row => String(row[0])));
      const v2 = tables.has('session_v2') && tables.has('session_message'), session = v2 ? 'session_v2' : 'session', message = v2 ? 'session_message' : 'message';
      if (!tables.has(session) || !tables.has(message)) { result.status = 'unsupported'; result.unsupported = 'OpenCode 数据库没有已核实的 V1/V2 会话表布局。'; return result; }
      // Project metadata in SQLite. Raw JSON messages and contents never leave
      // the database; no session title, user message, part or prompt is read.
      const query = db.prepare(`SELECT m.id,m.session_id,m.time_created,
        json_extract(m.data,'$.tokens'),json_extract(m.data,'$.time.created'),json_extract(m.data,'$.time.completed'),
        json_extract(m.data,'$.modelID'),json_extract(m.data,'$.model'),json_extract(m.data,'$.providerID'),
        ${v2 ? 'm.type' : "json_extract(m.data,'$.role')"},json_extract(m.data,'$.status')
        FROM ${message} m JOIN ${session} s ON s.id=m.session_id
        WHERE json_valid(m.data) AND ${v2 ? "m.type IN ('assistant','compaction')" : "json_extract(m.data,'$.role')='assistant'"}
        ORDER BY m.time_created,m.id LIMIT ?`);
      query.bind([limits.maxFiles * 100 + 1]);
      const records: UsageRecord[] = []; let rows = 0;
      try { while (query.step()) {
        if (++rows > limits.maxFiles * 100) { result.warnings.push('OpenCode 用量事件数超过扫描限制，其余事件未扫描。'); break; }
        const row = query.get(), messageId = identity(row[0]), sessionId = identity(row[1]);
        if (!messageId || !sessionId || typeof row[3] !== 'string' || Buffer.byteLength(row[3]) > limits.maxLineBytes) { result.skipped++; continue; }
        const done = row[9] === 'compaction' ? row[10] === 'completed' || row[10] === 'failed' : count(row[5]) !== undefined;
        if (!done) { result.deferredFiles++; continue; }
        let tokens; try { tokens = object(JSON.parse(row[3])); } catch { result.skipped++; continue; }
        const usage = normalizedCounters(tokens); if (!usage || usage.inputTokens + usage.outputTokens === 0) { result.skipped++; continue; }
        const time = count(row[4]) ?? count(row[2]); if (!time || time > 8_640_000_000_000_000) { result.skipped++; continue; }
        let model: Record<string, unknown> = {}; let modelString = '';
        if (typeof row[7] === 'string') { try { model = object(JSON.parse(row[7])); } catch { modelString = modelName(row[7]); } }
        const alias = modelName(row[6]) || modelName(model.id) || modelString || 'unknown';
        const provider = modelName(row[8]) || modelName(model.providerID);
        records.push({ id: 'client:opencode:' + createHash('sha256').update(JSON.stringify([sessionId, messageId])).digest('hex'),
          source: 'client', sessionId, time: new Date(time).toISOString(), tool: 'opencode', alias, providerName: provider || 'OpenCode 本地会话', endpoint: 'opencode-session', status: 0, durationMs: 0, usage });
      } } finally { query.free(); }
      if (result.deferredFiles) result.warnings.push('OpenCode 仍有未完成的消息用量，终态写入后可再次同步。');
      if (store.addClientUsages) { result.imported = store.addClientUsages(records); result.skipped += records.length - result.imported; }
      else for (const row of records) { if (store.addClientUsage(row)) result.imported++; else result.skipped++; }
    } finally { db.close(); }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { result.status = 'missing'; result.warnings.push('未找到可读取的 OpenCode 会话数据库。'); }
    else { result.status = 'error'; result.deferredFiles++; result.warnings.push(error instanceof Error && /^(OpenCode|SQLite) /.test(error.message) ? error.message : 'OpenCode 会话数据库无法安全读取；未导入，后续可重试。'); }
    return result;
  }
}
