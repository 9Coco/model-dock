import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolId } from '../shared/types';
import type { TokenUsage, UsageRecord } from '../shared/usage-types';
import type { ToolUsageImportResult } from '../shared/usage-import-types';
import { importOpenCodeUsage } from './usage-opencode';
import { openCodeDataDirectory } from './opencode-paths';

export interface ClientUsageStore {
  /** INSERT OR IGNORE on record.id: returns true only for newly inserted metadata. */
  addClientUsage(record: UsageRecord): boolean;
  addClientUsages?(records: UsageRecord[]): number;
  getManagedState?<T>(key: string, fallback: T): T;
  setManagedState?(key: string, value: unknown): void;
}
export interface UsageImportOptions {
  homeDir?: string;
  codexHome?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxLineBytes?: number;
  opencodeDataDir?: string;
  dshHome?: string;
  copilotHome?: string;
  appDataDir?: string;
}
interface Limits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxLineBytes: number }
interface UsageEvent { signature: string; timestamp: string; millis: number; usage: TokenUsage; model: string; ordinal: number; turnId: string; cumulative?: TokenUsage; exact: boolean }
interface ParsedSession { id: string; parentId: string; created: number; maxTimestamp: number; events: UsageEvent[]; warnings: string[]; malformed: boolean }
interface CodexCheckpoints { version: 1; events: Record<string, string>; totals: Record<string, TokenUsage> }
const CHECKPOINT_KEY = 'usage-import:codex:v1';
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : '';
const validModel = (value: unknown): string => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9_./:-]+$/.test(value) ? value : '';
function usage(value: unknown): TokenUsage | undefined {
  const record = object(value); if (!record) return undefined;
  const inputTokens = count(record.input_tokens); const outputTokens = count(record.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = count(record.cached_input_tokens ?? record.cache_read_input_tokens) ?? 0;
  const creation = count(record.cache_creation_input_tokens ?? record.cache_write_input_tokens) ?? 0;
  return { inputTokens, outputTokens, cachedInputTokens: Math.min(cachedInputTokens, inputTokens), ...(creation ? { cacheCreationInputTokens: Math.min(creation, Math.max(0, inputTokens - cachedInputTokens)) } : {}) };
}
function counterSignature(value: unknown): unknown {
  const record = object(value); if (!record) return null;
  return [count(record.input_tokens) ?? null, count(record.cached_input_tokens ?? record.cache_read_input_tokens) ?? null,
    count(record.output_tokens) ?? null, count(record.reasoning_output_tokens) ?? null, count(record.total_tokens) ?? null];
}
const within = (root: string, candidate: string): boolean => { const rel = relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const unsupported: Partial<Record<ToolId, string>> = {
  'claude-code': 'Claude Code 原生用量记录解析暂未实现；本版不读取或导入其会话记录。通过本机服务的请求可统计，官方 API 直连用量请查看供应商账单。',
  dsh: 'DSH 的会话位置和用量布局随 profile/版本变化，尚未核实本机兼容格式，本版不导入。',
  vscode: 'VS Code Copilot Chat 尚无已核实的稳定本地逐请求 Token 用量格式，本版不导入。',
  copilot: 'Copilot 官方 SDK 的 assistant.usage 是不写入会话日志的临时事件，无法从原生历史日志恢复逐请求 Token 用量。',
};
function limits(options: UsageImportOptions): Limits {
  const result = { maxFiles: options.maxFiles ?? 1000, maxFileBytes: options.maxFileBytes ?? 64 * 1024 * 1024,
    maxTotalBytes: options.maxTotalBytes ?? 256 * 1024 * 1024, maxLineBytes: options.maxLineBytes ?? 1024 * 1024 };
  for (const value of Object.values(result)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('会话扫描限制必须是正整数。');
  if (result.maxFiles > 10000 || result.maxTotalBytes > 1024 * 1024 * 1024 || result.maxFileBytes > 256 * 1024 * 1024 || result.maxLineBytes > 8 * 1024 * 1024) throw new Error('会话扫描限制超出允许范围。');
  return result;
}
/** Read only the three metadata event kinds; response_item/user content never becomes persisted data. */
async function parseSession(filename: string, root: string, maxLineBytes: number, maxFileBytes: number): Promise<ParsedSession | undefined> {
  if (!within(root, await realpath(filename))) return undefined;
  const stat = await lstat(filename); if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let opened;
  try {
    opened = await file.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maxFileBytes || !within(root, await realpath(filename))) { await file.close(); return undefined; }
  } catch (failure) { await file.close(); throw failure; }
  const result: ParsedSession = { id: '', parentId: '', created: 0, maxTimestamp: 0, events: [], warnings: [], malformed: false };
  let totalHighWater: TokenUsage | undefined; let model = 'unknown'; let turnId = ''; let ordinal = 0;
  const signaturesBySource = new Map<string, string>(); let previousSignature = '';
  let pending: Buffer[] = []; let pendingSize = 0; let discard = false;
  const observe = (bytes: Buffer): void => {
    const line = bytes.toString('utf8'); if (!line.trim()) return;
    const head = line.slice(0, 768); const beforePayload = head.split(/"payload"\s*:/, 1)[0];
    const kind = beforePayload.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
    if (!['session_meta', 'turn_context', 'event_msg'].includes(kind ?? '')) return;
    let body: Record<string, unknown> | undefined;
    try { body = object(JSON.parse(line)); } catch { result.warnings.push('部分会话尾行或元数据尚未完整写入，已跳过；后续可重试。'); return; }
    if (!body || body.type !== kind) return;
    const payload = object(body.payload); if (!payload) return;
    const timestamp = typeof body.timestamp === 'string' ? body.timestamp : '';
    const millis = Date.parse(timestamp); if (Number.isFinite(millis)) result.maxTimestamp = Math.max(result.maxTimestamp, millis);
    if (kind === 'session_meta' && !result.id) {
      result.id = validId(payload.id ?? payload.thread_id ?? payload.threadId);
      result.created = Number.isFinite(millis) ? millis : 0;
      const source = object(payload.source); const subagent = object(source?.subagent); const spawn = object(subagent?.thread_spawn);
      const forked = validId(payload.forked_from_id); const spawned = validId(spawn?.parent_thread_id);
      if (forked && spawned && forked !== spawned) { result.malformed = true; result.warnings.push('分支父会话标识不一致，该会话已跳过。'); }
      result.parentId = forked || spawned;
      return;
    }
    if (kind === 'turn_context') {
      model = validModel(payload.model ?? object(payload.info)?.model) || model;
      turnId = validId(payload.turn_id ?? payload.turnId ?? payload.id); return;
    }
    if (payload.type !== 'token_count') return;
    const info = object(payload.info); if (!info) return;
    const total = usage(info.total_token_usage); const last = usage(info.last_token_usage); if (!total && !last) return;
    model = validModel(info.model ?? info.model_name ?? payload.model) || model;
    const signature = hash([counterSignature(info.total_token_usage), counterSignature(info.last_token_usage)]);
    const source = validId(object(payload.rate_limits)?.limit_id) || 'default';
    const repeated = Boolean(total) && (signaturesBySource.get(source) === signature || previousSignature === signature);
    if (total) signaturesBySource.set(source, signature); previousSignature = signature;
    let delta = last ?? (total && { inputTokens: Math.max(0, total.inputTokens - (totalHighWater?.inputTokens ?? 0)),
      outputTokens: Math.max(0, total.outputTokens - (totalHighWater?.outputTokens ?? 0)),
      cachedInputTokens: Math.max(0, total.cachedInputTokens - (totalHighWater?.cachedInputTokens ?? 0)),
      ...(total.cacheCreationInputTokens ? { cacheCreationInputTokens: Math.max(0, total.cacheCreationInputTokens - (totalHighWater?.cacheCreationInputTokens ?? 0)) } : {}) });
    if (total) totalHighWater = { inputTokens: Math.max(totalHighWater?.inputTokens ?? 0, total.inputTokens),
      outputTokens: Math.max(totalHighWater?.outputTokens ?? 0, total.outputTokens), cachedInputTokens: Math.max(totalHighWater?.cachedInputTokens ?? 0, total.cachedInputTokens),
      ...(total.cacheCreationInputTokens ? { cacheCreationInputTokens: Math.max(totalHighWater?.cacheCreationInputTokens ?? 0, total.cacheCreationInputTokens) } : {}) };
    if (!delta) return;
    delta = { ...delta, cachedInputTokens: Math.min(delta.cachedInputTokens, delta.inputTokens) };
    const nonzero = !repeated && (delta.inputTokens > 0 || delta.outputTokens > 0 || delta.cachedInputTokens > 0);
    if (nonzero) ordinal++;
    if (!Number.isFinite(millis)) { if (nonzero) result.warnings.push('部分用量事件缺少有效时间，已跳过。'); return; }
    // Keep zero/replay events in the private timeline to resolve fork replay prefixes reliably.
    result.events.push({ signature, timestamp: new Date(millis).toISOString(), millis, usage: nonzero ? delta : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, model, ordinal, turnId, cumulative: total, exact: Boolean(last) });
  };
  try {
    const buffer = Buffer.alloc(64 * 1024); let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, opened.size - position), position); if (!bytesRead) break; position += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const chunk = buffer.subarray(start, index);
        if (!discard && pendingSize + chunk.length <= maxLineBytes) { pending.push(Buffer.from(chunk)); observe(Buffer.concat(pending)); }
        else { result.warnings.push('部分会话行超过大小限制，已跳过。'); }
        pending = []; pendingSize = 0; discard = false; start = index + 1;
      }
      if (start < bytesRead && !discard) {
        const suffix = buffer.subarray(start, bytesRead); pendingSize += suffix.length;
        if (pendingSize > maxLineBytes) { pending = []; discard = true; }
        else pending.push(Buffer.from(suffix));
      }
    }
    // A complete last JSON line is supported; a partial writer tail is retried on the next import.
    if (pendingSize && !discard) observe(Buffer.concat(pending));
    const after = await file.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('会话文件在读取中发生变化，后续可重试。');
  } finally { await file.close(); }
  return result;
}

/** Explicit, read-only importer based on CC Switch session_usage_codex.rs.
 * Uses exact last_token_usage once; falls back to cumulative high-water deltas.
 * File paths, prompts, replies and tool output are never stored or returned.
 */
export async function importToolUsage(tool: ToolId, store: ClientUsageStore, options: UsageImportOptions = {}): Promise<ToolUsageImportResult> {
  if (!['codex', 'claude-code', 'opencode', 'dsh', 'vscode', 'copilot'].includes(tool)) throw new Error('未知工具。');
  const result: ToolUsageImportResult = { tool, scannedFiles: 0, imported: 0, skipped: 0, deferredFiles: 0, warnings: [], status: 'ready' };
  if (tool === 'opencode') return importOpenCodeUsage(openCodeDataDirectory(options.homeDir, options.opencodeDataDir), store, limits(options));
  if (tool !== 'codex') { result.unsupported = unsupported[tool]; result.status = 'unsupported'; return result; }
  const cap = limits(options);
  const home = resolve(options.codexHome ?? (options.homeDir ? join(options.homeDir, '.codex') : process.env.CODEX_HOME ?? join(homedir(), '.codex')));
  try { const metadata = await lstat(home); if (metadata.isSymbolicLink() || !metadata.isDirectory()) { result.status = 'error'; result.warnings.push('Codex 会话目录为链接或不是目录，已跳过。'); return result; } }
  catch { result.status = 'missing'; result.warnings.push('未找到可读取的 Codex 会话目录。'); return result; }
  const canonicalRoot = await realpath(home); const files: string[] = []; let totalBytes = 0; let examined = 0; let traversalStopped = false;
  const warning = (message: string) => { if (!result.warnings.includes(message)) result.warnings.push(message); };
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (traversalStopped) return;
    if (depth > 10) { warning('部分目录超过扫描深度，已跳过。'); return; }
    let metadata; try { metadata = await lstat(directory); } catch { return; }
    let canonicalDirectory; try { canonicalDirectory = await realpath(directory); } catch { warning('部分会话目录在扫描中发生变化，已跳过。'); return; }
    if (metadata.isSymbolicLink() || !within(canonicalRoot, canonicalDirectory)) { warning('已跳过会话目录中的符号链接或目录逃逸。'); return; }
    if (!metadata.isDirectory()) return;
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { warning('部分会话目录无法读取，请检查权限。'); return; }
    // Date-organized session directories and rollout names sort newest first,
    // so a bounded scan still includes current activity in a large archive.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (traversalStopped) break;
      if (++examined > cap.maxFiles * 20) { warning('目录项数量超过扫描限制，其余项未扫描。'); traversalStopped = true; break; }
      const filename = join(directory, entry.name);
      if (entry.isSymbolicLink()) { warning('已跳过会话目录中的符号链接或目录逃逸。'); continue; }
      if (entry.isDirectory()) { await walk(filename, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      if (files.length >= cap.maxFiles) { warning('会话文件数超过扫描限制，其余文件未扫描。'); traversalStopped = true; break; }
      let fileMetadata; try { fileMetadata = await lstat(filename); } catch { warning('部分会话文件在扫描中发生变化，已跳过。'); continue; }
      if (fileMetadata.size > cap.maxFileBytes) { result.skipped++; warning('部分会话文件超过单文件大小限制，已跳过。'); continue; }
      if (totalBytes + fileMetadata.size > cap.maxTotalBytes) { warning('会话文件总大小超过扫描限制，其余文件未扫描。'); traversalStopped = true; break; }
      totalBytes += fileMetadata.size; files.push(filename);
    }
  };
  await walk(join(home, 'sessions'), 0); await walk(join(home, 'archived_sessions'), 0);
  const sessions: ParsedSession[] = [];
  for (const filename of files) {
    result.scannedFiles++;
    try {
      const parsed = await parseSession(filename, canonicalRoot, cap.maxLineBytes, cap.maxFileBytes);
      if (!parsed || !parsed.id || parsed.malformed) { result.deferredFiles++; warning('部分会话包含不完整/不支持的元数据或超限内容，本次未导入，后续可重试。'); continue; }
      sessions.push(parsed); parsed.warnings.forEach(warning);
    } catch { result.deferredFiles++; warning('部分会话文件无法安全读取，本次已跳过。'); }
  }
  const byId = new Map<string, ParsedSession[]>();
  for (const session of sessions) { const same = byId.get(session.id) ?? []; same.push(session); byId.set(session.id, same); }
  let checkpoints: CodexCheckpoints = { version: 1, events: {}, totals: {} };
  const useCheckpoints = Boolean(store.getManagedState && store.setManagedState);
  if (useCheckpoints) {
    try {
      const saved = store.getManagedState!<CodexCheckpoints>(CHECKPOINT_KEY, checkpoints);
      if (saved?.version === 1 && object(saved.events) && object(saved.totals)) checkpoints = saved;
    } catch { warning('历史用量检查点无法读取；本次仍按记录标识去重。'); }
  }
  const observedIds = new Set<string>(); const records: UsageRecord[] = [];
  for (const session of sessions) {
    let prefix = 0;
    if (session.parentId) {
      const parents = byId.get(session.parentId);
      if (!parents?.length || session.parentId === session.id || !session.created) { result.deferredFiles++; warning('部分分支会话缺少可靠父会话，已暂缓导入以避免回放双计。'); continue; }
      const parent = parents.slice().sort((a, b) => b.maxTimestamp - a.maxTimestamp)[0];
      if (parent.maxTimestamp < session.created) { result.deferredFiles++; warning('部分父会话尚未写到分支时刻，已暂缓该分支以避免回放双计。'); continue; }
      const timeline = parent.events.filter(event => event.millis <= session.created); let offset = 0;
      for (const childEvent of session.events) {
        const matched = timeline.findIndex((event, index) => index >= offset && event.signature === childEvent.signature);
        if (matched < 0) break; prefix++; offset = matched + 1;
      }
    }
    for (let index = 0; index < session.events.length; index++) {
      const event = session.events[index];
      if (index < prefix || event.usage.inputTokens + event.usage.outputTokens + event.usage.cachedInputTokens === 0) { result.skipped++; continue; }
      const eventKey = hash([session.id, event.turnId, event.timestamp, event.signature]);
      const previousId = useCheckpoints ? checkpoints.events[eventKey] : undefined;
      const id = previousId && /^client:codex:[a-f0-9]{64}$/.test(previousId) ? previousId : 'client:codex:' + hash([session.id, event.turnId, event.ordinal, event.signature]);
      if (observedIds.has(id)) { result.skipped++; continue; } observedIds.add(id);
      let measured = event.usage;
      if (useCheckpoints && event.cumulative) {
        const previous = checkpoints.totals[session.id];
        // A rewritten/truncated file may begin at a later cumulative snapshot.
        // Known events retain their original IDs; new cumulative events are
        // measured above the persisted session high-water mark, never from zero.
        if (!previousId && !event.exact && previous) {
          if (event.cumulative.inputTokens < previous.inputTokens || event.cumulative.outputTokens < previous.outputTokens || event.cumulative.cachedInputTokens < previous.cachedInputTokens) {
            result.skipped++; warning('部分累计用量发生回退且没有单次计数，已暂缓以避免跨计数范围重复统计。'); continue;
          }
          measured = { inputTokens: event.cumulative.inputTokens - previous.inputTokens, outputTokens: event.cumulative.outputTokens - previous.outputTokens,
            cachedInputTokens: Math.min(event.cumulative.cachedInputTokens - previous.cachedInputTokens, event.cumulative.inputTokens - previous.inputTokens),
            ...(event.cumulative.cacheCreationInputTokens ? { cacheCreationInputTokens: Math.max(0, event.cumulative.cacheCreationInputTokens - (previous.cacheCreationInputTokens ?? 0)) } : {}) };
          if (measured.inputTokens + measured.outputTokens === 0) { result.skipped++; continue; }
        }
        checkpoints.totals[session.id] = { inputTokens: Math.max(previous?.inputTokens ?? 0, event.cumulative.inputTokens),
          outputTokens: Math.max(previous?.outputTokens ?? 0, event.cumulative.outputTokens), cachedInputTokens: Math.max(previous?.cachedInputTokens ?? 0, event.cumulative.cachedInputTokens),
          ...(event.cumulative.cacheCreationInputTokens ? { cacheCreationInputTokens: Math.max(previous?.cacheCreationInputTokens ?? 0, event.cumulative.cacheCreationInputTokens) } : {}) };
      }
      if (useCheckpoints) checkpoints.events[eventKey] = id;
      const record: UsageRecord = { id, source: 'client', sessionId: session.id, time: event.timestamp, tool: 'codex', alias: event.model,
        providerName: 'Codex 本地会话', endpoint: 'codex-session', status: 0, durationMs: 0, usage: measured };
      records.push(record);
    }
  }
  if (store.addClientUsages) {
    const imported = store.addClientUsages(records); result.imported += imported; result.skipped += records.length - imported;
  } else for (const record of records) { if (store.addClientUsage(record)) result.imported++; else result.skipped++; }
  if (useCheckpoints) {
    checkpoints.events = Object.fromEntries(Object.entries(checkpoints.events).slice(-20_000));
    checkpoints.totals = Object.fromEntries(Object.entries(checkpoints.totals).slice(-5_000));
    try { store.setManagedState!(CHECKPOINT_KEY, checkpoints); }
    catch { warning('用量已按唯一标识写入，但检查点无法保存；下次可重试。'); }
  }
  return result;
}
