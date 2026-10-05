import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { importToolUsage, type ClientUsageStore } from '../src/main/usage-import';
import type { UsageRecord } from '../src/shared/usage-types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error('Unsafe cleanup target'); rmSync(root, { recursive: true, force: true }); } });
const stamp = (seconds: number) => `2026-10-05T10:00:${String(seconds).padStart(2, '0')}.000Z`;
const meta = (id: string, seconds = 0, parent?: string) => ({ timestamp: stamp(seconds), type: 'session_meta', payload: { id, ...(parent ? { forked_from_id: parent } : {}), base_instructions: 'PRIVATE_INSTRUCTIONS' } });
const context = (model = 'gpt-test', seconds = 1, turn = 'turn-1') => ({ timestamp: stamp(seconds), type: 'turn_context', payload: { model, turn_id: turn } });
const counters = (input: number, output: number, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: output, total_tokens: input + output });
const token = (total: ReturnType<typeof counters> | undefined, last: ReturnType<typeof counters> | undefined, seconds: number, source = 'codex') => ({ timestamp: stamp(seconds), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last }, rate_limits: { limit_id: source } } });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-client-usage-')); roots.push(root); const codex = join(root, '.codex'); mkdirSync(join(codex, 'sessions'), { recursive: true });
  const records = new Map<string, UsageRecord>(); const store: ClientUsageStore = { addClientUsage(record) { if (records.has(record.id)) return false; records.set(record.id, record); return true; } };
  const file = (name: string, entries: unknown[], archived = false) => { const folder = join(codex, archived ? 'archived_sessions' : 'sessions'); mkdirSync(folder, { recursive: true }); const filename = join(folder, `rollout-${name}.jsonl`); writeFileSync(filename, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'); return filename; };
  return { root, codex, records, store, file, options: { homeDir: root } };
}
const sum = (rows: Map<string, UsageRecord>, key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens') => [...rows.values()].reduce((total, row) => total + (row.usage?.[key] ?? 0), 0);
describe('read-only Codex client usage import', () => {
  it('prefers exact per-request counters and never adds both cumulative and last counts', async () => {
    const { file, store, options, records } = setup(); const path = file('s1', [meta('s1'), context(), token(counters(1000, 100, 900), counters(100, 10, 90), 2), token(counters(2500, 500, 1500), counters(200, 20, 500), 3)]); const before = readFileSync(path, 'utf8');
    const result = await importToolUsage('codex', store, options); expect(result.imported).toBe(2); expect(sum(records, 'inputTokens')).toBe(300); expect(sum(records, 'outputTokens')).toBe(30); expect(sum(records, 'cachedInputTokens')).toBe(290);
    expect([...records.values()].every(row => row.source === 'client' && row.tool === 'codex' && row.sessionId === 's1')).toBe(true); expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('uses cumulative high-water deltas without double-counting duplicate snapshots or resets', async () => {
    const { file, store, options, records } = setup(); file('s1', [meta('s1'), context(), token(counters(100, 10, 50), undefined, 2), token(counters(100, 10, 50), undefined, 3), token(counters(250, 30, 100), undefined, 4), token(counters(50, 5, 10), undefined, 5), token(counters(300, 35, 150), undefined, 6)]);
    await importToolUsage('codex', store, options); expect(records.size).toBe(3); expect(sum(records, 'inputTokens')).toBe(300); expect(sum(records, 'outputTokens')).toBe(35); expect(sum(records, 'cachedInputTokens')).toBe(150);
  });
  it('deduplicates cross-source adjacent replay and same-source stale replay while allowing genuine reset last usage', async () => {
    const { file, store, options, records } = setup(); file('s1', [meta('s1'), context(), token(counters(1000, 10), counters(100, 10), 2, 'a'), token(counters(1000, 10), counters(100, 10), 3, 'b'), token(counters(2000, 20), counters(100, 10), 4, 'b'), token(counters(1000, 10), counters(100, 10), 5, 'a'), token(counters(500, 5), counters(50, 5), 7, 'a')]);
    await importToolUsage('codex', store, options); expect(records.size).toBe(3); expect(sum(records, 'inputTokens')).toBe(250);
  });
  it('keeps identical independent per-request usage when no cumulative snapshot exists', async () => {
    const { file, store, options, records } = setup(); file('s1', [meta('s1'), context(), token(undefined, counters(10, 1), 2), token(undefined, counters(10, 1), 3)]);
    const result = await importToolUsage('codex', store, options); expect(result.imported).toBe(2); expect(sum(records, 'inputTokens')).toBe(20);
  });
  it('is idempotent across repeated imports, copied archives, moves and appended events', async () => {
    const { file, store, options, records, codex } = setup(); const rows = [meta('s1'), context(), token(counters(100, 10), counters(100, 10), 2)]; const first = file('s1', rows); file('copy-s1', rows, true);
    expect((await importToolUsage('codex', store, options)).imported).toBe(1); expect((await importToolUsage('codex', store, options)).imported).toBe(0);
    renameSync(first, join(codex, 'archived_sessions', 'rollout-moved-s1.jsonl')); appendFileSync(join(codex, 'archived_sessions', 'rollout-moved-s1.jsonl'), JSON.stringify(token(counters(200, 20), counters(100, 10), 3)) + '\n');
    expect((await importToolUsage('codex', store, options)).imported).toBe(1); expect(records.size).toBe(2);
  });
  it('imports completed metadata before a partially written tail and retries that tail after append', async () => {
    const { file, store, options, records } = setup(); const path = file('s1', [meta('s1'), context(), token(counters(100, 10), counters(100, 10), 2)]); const next = JSON.stringify(token(counters(200, 20), counters(100, 10), 3)); appendFileSync(path, next.slice(0, 70));
    expect((await importToolUsage('codex', store, options)).imported).toBe(1); appendFileSync(path, next.slice(70)); expect((await importToolUsage('codex', store, options)).imported).toBe(1); expect(records.size).toBe(2);
  });
  it('strips fork replay prefix against parent before fork time and keeps fresh child usage', async () => {
    const { file, store, options, records } = setup(); file('parent', [meta('parent'), context(), token(counters(1000, 100, 900), undefined, 2), context('gpt-parent', 10), token(counters(2000, 200, 1800), undefined, 11)]);
    file('child', [meta('child', 5, 'parent'), context('gpt-child', 6), token(counters(1000, 100, 900), undefined, 7), token(counters(1300, 150, 1050), undefined, 8)]);
    const result = await importToolUsage('codex', store, options); expect(result.imported).toBe(3); const child = [...records.values()].filter(row => row.sessionId === 'child'); expect(child).toHaveLength(1); expect(child[0].usage?.inputTokens).toBe(300); expect(child[0].alias).toBe('gpt-child');
  });
  it('defers forks with missing or insufficient parent timeline rather than guessing and double counting', async () => {
    const { file, store, options, records } = setup(); file('child', [meta('child', 5, 'missing'), context(), token(counters(100, 10), undefined, 7)]); const result = await importToolUsage('codex', store, options); expect(result.deferredFiles).toBe(1); expect(records.size).toBe(0); expect(result.warnings.join(' ')).toContain('父会话');
  });
  it('enforces file count/size limits and skips linked directories outside the intended root', async () => {
    const { root, file, codex, store, options } = setup(); file('s1', [meta('s1'), context(), token(counters(100, 10), undefined, 2)]); file('s2', [meta('s2'), context(), token(counters(100, 10), undefined, 2)]);
    expect((await importToolUsage('codex', store, { ...options, maxFiles: 1 })).scannedFiles).toBe(1);
    const external = join(root, 'external'); mkdirSync(external); writeFileSync(join(external, 'rollout-external.jsonl'), JSON.stringify(meta('external')) + '\n'); symlinkSync(external, join(codex, 'sessions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await importToolUsage('codex', store, options); expect(linked.warnings.join(' ')).toContain('链接');
    const tooLarge = await importToolUsage('codex', store, { ...options, maxFileBytes: 1 }); expect(tooLarge.scannedFiles).toBe(0); expect(tooLarge.warnings.join(' ')).toContain('大小限制');
  });
  it('never persists or returns prompts, responses, instructions, tool output or native paths', async () => {
    const { file, store, options, records, root } = setup(); file('s1', [meta('s1'), context(), { timestamp: stamp(1), type: 'response_item', payload: { type: 'message', role: 'user', content: 'PRIVATE_USER_PROMPT' } }, { timestamp: stamp(1), type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'PRIVATE_REPLY' } }, token(counters(100, 10), undefined, 2)]);
    const result = await importToolUsage('codex', store, options); const persisted = JSON.stringify([...records.values()]) + JSON.stringify(result);
    for (const secret of ['PRIVATE_USER_PROMPT', 'PRIVATE_REPLY', 'PRIVATE_INSTRUCTIONS', root]) expect(persisted).not.toContain(secret);
  });
  it('uses optional batch insertion and reports exact repeated-import counts', async () => {
    const { file, store, options, records } = setup(); file('s1', [meta('s1'), context(), token(counters(100, 10), undefined, 2), token(counters(200, 20), undefined, 3)]);
    let batches = 0; const batched: ClientUsageStore = { addClientUsage() { throw new Error('single path must not run'); }, addClientUsages(rows) { batches++; return rows.filter(row => store.addClientUsage(row)).length; } };
    expect((await importToolUsage('codex', batched, options)).imported).toBe(2); expect((await importToolUsage('codex', batched, options)).imported).toBe(0); expect(records.size).toBe(2); expect(batches).toBe(2);
  });
  it('explicitly reports unsupported tools and does not invent unverified schemas', async () => {
    const { store, options } = setup(); for (const tool of ['dsh', 'vscode', 'copilot'] as const) { const result = await importToolUsage(tool, store, options); expect(result.unsupported).toBeTruthy(); expect(result.status).toBe('unsupported'); expect(result.scannedFiles).toBe(0); expect(result.imported).toBe(0); }
    expect((await importToolUsage('opencode', store, options)).status).toBe('missing');
  });
  it('uses metadata checkpoints to avoid recounting cumulative history after file truncation and reorder', async () => {
    const f = setup(), state = new Map<string, unknown>();
    const store: ClientUsageStore = { ...f.store, getManagedState<T>(key: string, fallback: T): T { return structuredClone(state.get(key) ?? fallback) as T; }, setManagedState(key, value) { state.set(key, structuredClone(value)); } };
    const path = f.file('s1', [meta('s1'), context(), token(counters(100, 10, 50), undefined, 2), token(counters(200, 20, 100), undefined, 3)]);
    expect((await importToolUsage('codex', store, f.options)).imported).toBe(2);
    // The writer compacts the prefix. Its first event is already known, but
    // now has a different ordinal; next cumulative snapshot is new metadata.
    writeFileSync(path, [meta('s1'), context(), token(counters(200, 20, 100), undefined, 3), token(counters(350, 30, 180), undefined, 4)].map(value => JSON.stringify(value)).join('\n'));
    expect((await importToolUsage('codex', store, f.options)).imported).toBe(1); expect(sum(f.records, 'inputTokens')).toBe(350);
    expect((await importToolUsage('codex', store, f.options)).imported).toBe(0);
    writeFileSync(path, [meta('s1'), context(), token(counters(400, 40, 200), undefined, 5)].map(value => JSON.stringify(value)).join('\n'));
    expect((await importToolUsage('codex', store, f.options)).imported).toBe(1); expect(sum(f.records, 'inputTokens')).toBe(400); expect(sum(f.records, 'cachedInputTokens')).toBe(200);
    expect(JSON.stringify([...state.values()])).not.toMatch(/PRIVATE_INSTRUCTIONS|PRIVATE_USER_PROMPT|rollout-/);
  });
  it('preserves explicitly reported cache creation and never supplies a fake HTTP success', async () => {
    const f = setup(), perRequest = { ...counters(100, 10, 30), cache_creation_input_tokens: 20 };
    f.file('s1', [meta('s1'), context(), token(perRequest, perRequest, 2)]);
    await importToolUsage('codex', f.store, f.options); expect([...f.records.values()][0]).toMatchObject({ status: 0, usage: { inputTokens: 100, cachedInputTokens: 30, cacheCreationInputTokens: 20 } });
  });
  it('includes recent date-organized sessions before old archives when the scan budget is bounded', async () => {
    const f = setup();
    for (const date of ['2026-09-01', '2026-10-07']) { const directory = join(f.codex, 'sessions', date); mkdirSync(directory); writeFileSync(join(directory, `rollout-${date}.jsonl`), [meta(`s-${date}`), context(), token(counters(100, 10), undefined, 2)].map(value => JSON.stringify(value)).join('\n')); }
    const result = await importToolUsage('codex', f.store, { ...f.options, maxFiles: 1 }); expect(result.imported).toBe(1); expect([...f.records.values()][0].sessionId).toBe('s-2026-10-07'); expect(result.warnings.join()).toContain('超过扫描限制');
  });
});
