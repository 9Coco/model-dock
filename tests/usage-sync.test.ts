import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageSyncService } from '../src/main/usage-sync';
import type { UsageRecord } from '../src/shared/usage-types';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error('Unsafe cleanup target'); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-usage-sync-')); roots.push(root); const records = new Map<string, UsageRecord>(), state = new Map<string, unknown>();
  const store = { dataDir: join(root, 'app-data'), addClientUsage(row: UsageRecord) { if (records.has(row.id)) return false; records.set(row.id, row); return true; },
    getManagedState<T>(key: string, fallback: T): T { return structuredClone(state.get(key) ?? fallback) as T; }, setManagedState(key: string, value: unknown) { state.set(key, structuredClone(value)); } };
  const service = new UsageSyncService(store, { homeDir: root, now: () => Date.parse('2026-10-07T12:00:00Z') });
  return { root, records, state, store, service };
}
function session(root: string) {
  const folder = join(root, '.codex', 'sessions'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'rollout-test.jsonl'), [
    { timestamp: '2026-10-07T11:00:00Z', type: 'session_meta', payload: { id: 'native-session' } },
    { timestamp: '2026-10-07T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-demo' } },
    { timestamp: '2026-10-07T11:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20 } } } },
  ].map(value => JSON.stringify(value)).join('\n'));
}
describe('native usage synchronization and data sources', () => {
  it('reports the configured OpenCode data directory separately from the fixture home default', async () => {
    const f = fixture(), opencodeDataDir = join(f.root, 'custom-data', 'opencode'); mkdirSync(opencodeDataDir, { recursive: true });
    writeFileSync(join(opencodeDataDir, 'opencode.db'), 'fixture-source');
    const service = new UsageSyncService(f.store, { homeDir: f.root, opencodeDataDir });
    expect((await service.sources()).sources.find(row => row.tool === 'opencode')).toMatchObject({ status: 'ready', paths: [join(opencodeDataDir, 'opencode.db')] });
    expect((await f.service.sources()).sources.find(row => row.tool === 'opencode')).toMatchObject({ status: 'missing', paths: [join(f.root, '.local', 'share', 'opencode', 'opencode.db')] });
    expect(f.records.size).toBe(0);
  });
  it('inspects sources and persisted timestamps without importing at construction or source reads', async () => {
    const f = fixture(); session(f.root); const sources = await f.service.sources();
    expect(sources.sources).toHaveLength(6); expect(f.records.size).toBe(0); expect(f.state.size).toBe(0);
    expect(sources.sources.find(row => row.tool === 'codex')).toMatchObject({ status: 'ready', supported: true, paths: [join(f.root, '.codex', 'sessions'), join(f.root, '.codex', 'archived_sessions')] });
    expect(sources.sources.find(row => row.tool === 'opencode')?.status).toBe('missing');
    expect(sources.sources.filter(row => !row.supported).map(row => row.tool)).toEqual(['dsh', 'vscode', 'copilot']); expect(sources.privacy).toContain('不保存提示词');
  });
  it('coalesces overlap and reports each tool with real import counts and unsupported boundaries', async () => {
    const f = fixture(); session(f.root); const first = f.service.sync(), concurrent = f.service.sync(); expect(first).toBe(concurrent);
    const result = await first; expect(result).toMatchObject({ imported: 1, scannedFiles: 1, deferredFiles: 0, startedAt: '2026-10-07T12:00:00.000Z', completedAt: '2026-10-07T12:00:00.000Z' });
    expect(result.results.map(row => row.tool)).toEqual(['codex', 'opencode', 'dsh', 'vscode', 'copilot']);
    expect(result.results.find(row => row.tool === 'opencode')?.status).toBe('missing'); expect(result.results.find(row => row.tool === 'copilot')?.unsupported).toContain('临时事件');
    const later = await f.service.sync(); expect(later.imported).toBe(0); expect(f.records.size).toBe(1);
    const sources = await f.service.sources(); expect(sources.lastSync?.imported).toBe(0); expect(sources.sources.find(row => row.tool === 'codex')?.lastResult?.skipped).toBe(1);
  });
  it('retains last successful report across service restart and never displays raw store errors', async () => {
    const f = fixture(); session(f.root); await f.service.sync(); const reopened = new UsageSyncService(f.store, { homeDir: f.root });
    expect((await reopened.sources()).lastSync?.imported).toBe(1);
    const badStore = { ...f.store, setManagedState() { throw new Error('PRIVATE_STORAGE_TOKEN'); } };
    const result = await new UsageSyncService(badStore, { homeDir: f.root }).sync(); expect(result.warnings.join()).toContain('同步时间无法保存'); expect(JSON.stringify(result)).not.toContain('PRIVATE_STORAGE_TOKEN');
  });
});
