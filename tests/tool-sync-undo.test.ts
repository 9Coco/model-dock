import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyConfig, codexHistoryKey } from '../src/main/adapters';
import { applyClaudeConfig, claudeHistoryKey } from '../src/main/claude-config';
import { applyDshConfig, type DshPlan } from '../src/main/dsh-config';
import { ToolSyncUndoManager, toolSyncUndoKey, type ToolSyncUndoStore } from '../src/main/tool-sync-undo';
import type { Model, Provider, ToolBinding, ToolId } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(tool: ToolId = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-sync-undo-')); roots.push(root);
  const states = new Map<string, unknown>(), backups: string[] = [];
  const oldBinding: ToolBinding = { id: tool, name: 'Original label', note: 'Original note', enabled: false, mode: 'direct', providerIds: [], modelIds: [], defaultModelId: '' };
  let binding = structuredClone(oldBinding);
  const provider: Provider = { id: 'fixture-source', name: 'Fixture', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', enabled: true, authStatus: 'ready', hasSecret: true, note: '' };
  const model: Model = { id: 'fixture-model', providerId: provider.id, upstreamId: 'deepseek-chat', alias: 'fixture-model', displayName: 'Fixture model', wireApi: 'responses', contextWindow: 128000, tools: true, vision: false, enabled: true };
  const store: ToolSyncUndoStore & { listModels(): Model[]; listProviders(): Provider[]; getProvider(): Provider; gatewayKey(): string; getSecret(): { apiKey: string } } = {
    dataDir: root,
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn((_kind: string, value: unknown) => { backups.push(Buffer.from(JSON.stringify(value)).toString('base64')); return join(root, 'backups', `fixture-${backups.length}.enc`); }),
    listBindings: () => [structuredClone(binding)],
    restoreBindingSelection: vi.fn((value: ToolBinding) => { binding = { ...structuredClone(value), name: binding.name, note: binding.note }; }),
    listModels: () => [model], listProviders: () => [provider], getProvider: () => provider,
    gatewayKey: () => 'SYNTHETIC_PRIVATE_GATEWAY_KEY', getSecret: () => ({ apiKey: 'SYNTHETIC_PRIVATE_SOURCE_KEY' }),
  };
  const manager = new ToolSyncUndoManager(store, { appData: join(root, 'appdata'), homeDirectory: root });
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const activate = () => { binding = { ...binding, enabled: true, mode: 'aggregate', providerIds: [provider.id], modelIds: [model.id], defaultModelId: model.id }; return structuredClone(binding); };
  const setBinding = (value: ToolBinding) => { binding = structuredClone(value); };
  return { root, states, backups, store, manager, write, oldBinding, activate, setBinding, model, provider };
}

describe('explicit single-step tool synchronization undo', () => {
  it('restores both Codex files, ownership history and the pre-burst source selection, preserving unrelated metadata', async () => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'), catalog = join(dirname(target), 'modeldock-models.json');
    const original = 'model_provider="foreign"\nmodel="foreign-model"\n[mcp_servers.keep]\ncommand="keep-mcp"\n';
    const originalCatalog = '{"models":[{"description":"User-owned original catalog"}]}';
    f.write(target, original); f.write(catalog, originalCatalog);
    const auth = join(dirname(target), 'auth.json'); f.write(auth, 'SYNTHETIC_ACCOUNT_AUTH_UNTOUCHED');
    f.activate();
    await f.manager.run('codex', f.oldBinding, () => applyConfig(f.store, 'codex', 18181, join(f.root, 'appdata'), join(f.root, 'backups'), f.root));
    expect(readFileSync(target, 'utf8')).toContain('modeldock'); expect(f.manager.status('codex').available).toBe(true);
    const statusText = JSON.stringify(f.manager.status('codex')); expect(statusText).not.toContain('PRIVATE'); expect(statusText).not.toContain(original);
    const active = f.store.listBindings()[0]; f.setBinding({ ...active, name: 'New independent label', note: 'New independent note' });
    expect(await f.manager.undo('codex')).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(original); expect(readFileSync(catalog, 'utf8')).toBe(originalCatalog);
    expect(readFileSync(auth, 'utf8')).toBe('SYNTHETIC_ACCOUNT_AUTH_UNTOUCHED'); expect(f.store.getManagedState(codexHistoryKey(target), null)).toBeNull();
    expect(f.store.listBindings()[0]).toMatchObject({ enabled: false, providerIds: [], modelIds: [], defaultModelId: '', name: 'New independent label', note: 'New independent note' });
    expect(f.manager.status('codex').available).toBe(false); await expect(f.manager.undo('codex')).rejects.toThrow('尚无');
    expect(f.backups.every(backup => !backup.includes('SYNTHETIC_PRIVATE'))).toBe(true);
  });
  it('removes only newly created configuration files on undo and never replays writes when reopened', async () => {
    const f = fixture('vscode'), target = join(f.root, 'appdata', 'Code', 'User', 'chatLanguageModels.json');
    f.activate(); await f.manager.run('vscode', f.oldBinding, () => applyConfig(f.store, 'vscode', 18181, join(f.root, 'appdata'), join(f.root, 'backups'), f.root));
    expect(existsSync(target)).toBe(true);
    const writes = vi.mocked(f.store.setManagedState).mock.calls.length;
    const reopened = new ToolSyncUndoManager(f.store, { appData: join(f.root, 'appdata'), homeDirectory: f.root });
    expect(reopened.status('vscode').available).toBe(true); expect(vi.mocked(f.store.setManagedState)).toHaveBeenCalledTimes(writes);
    await reopened.undo('vscode'); expect(existsSync(target)).toBe(false); expect(existsSync(dirname(target))).toBe(true);
  });
  it.each(['file', 'catalog', 'binding', 'ownership'] as const)('rejects external %s edits before changing any part of a Codex checkpoint', async changed => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'), catalog = join(dirname(target), 'modeldock-models.json');
    f.write(target, 'model="original"\n'); f.activate();
    await f.manager.run('codex', f.oldBinding, () => applyConfig(f.store, 'codex', 18181, join(f.root, 'appdata'), join(f.root, 'backups'), f.root));
    if (changed === 'file') f.write(target, 'model="external"\n');
    if (changed === 'catalog') f.write(catalog, '{"models":[],"external":true}');
    if (changed === 'binding') f.setBinding({ ...f.store.listBindings()[0], defaultModelId: '' });
    if (changed === 'ownership') f.states.set(codexHistoryKey(target), { external: true });
    const configured = readFileSync(target, 'utf8'), currentCatalog = readFileSync(catalog, 'utf8'), binding = f.store.listBindings()[0], state = f.store.getManagedState(codexHistoryKey(target), null);
    expect(f.manager.status('codex').available).toBe(false); await expect(f.manager.undo('codex')).rejects.toThrow('其他操作修改');
    expect(readFileSync(target, 'utf8')).toBe(configured); expect(readFileSync(catalog, 'utf8')).toBe(currentCatalog);
    expect(f.store.listBindings()[0]).toEqual(binding); expect(f.store.getManagedState(codexHistoryKey(target), null)).toEqual(state);
    expect(f.store.getManagedState(toolSyncUndoKey('codex'), null)).not.toBeNull();
  });
  it('does not register a failed native apply and retains the last successful checkpoint', async () => {
    const f = fixture('opencode'), target = join(f.root, '.config', 'opencode', 'opencode.jsonc');
    f.write(target, '{\n// original comment\n"mcp":{"keep":{}}\n}'); f.activate();
    await f.manager.run('opencode', f.oldBinding, () => applyConfig(f.store, 'opencode', 18181, f.root, join(f.root, 'backups'), f.root));
    const saved = f.store.getManagedState(toolSyncUndoKey('opencode'), null), configured = readFileSync(target, 'utf8');
    await expect(f.manager.run('opencode', f.store.listBindings()[0], async () => { throw new Error('synthetic apply rolled back'); })).rejects.toThrow('synthetic');
    expect(f.store.getManagedState(toolSyncUndoKey('opencode'), null)).toEqual(saved); expect(readFileSync(target, 'utf8')).toBe(configured);
  });
  it('keeps the last useful checkpoint for an explicit no-op resync', async () => {
    const f = fixture('opencode'), target = join(f.root, '.config', 'opencode', 'opencode.json');
    f.write(target, '{"mcp":{"keep":{}}}'); f.activate();
    const apply = () => applyConfig(f.store, 'opencode', 18181, f.root, join(f.root, 'backups'), f.root);
    await f.manager.run('opencode', f.oldBinding, apply); const saved = f.store.getManagedState(toolSyncUndoKey('opencode'), null);
    await f.manager.run('opencode', undefined, () => target);
    expect(f.store.getManagedState(toolSyncUndoKey('opencode'), null)).toEqual(saved);
    await f.manager.undo('opencode'); expect(readFileSync(target, 'utf8')).toBe('{"mcp":{"keep":{}}}');
  });
  it('rolls a completed sync back when the encrypted undo record cannot be committed', async () => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'), original = 'model="original"\n'; f.write(target, original); f.activate();
    vi.mocked(f.store.setManagedState).mockImplementation((key, value) => { if (key === toolSyncUndoKey('codex') && value !== null) throw new Error('synthetic encrypted storage failure'); f.states.set(key, structuredClone(value)); });
    await expect(f.manager.run('codex', f.oldBinding, () => applyConfig(f.store, 'codex', 18181, f.root, join(f.root, 'backups'), f.root))).rejects.toThrow('已恢复撤销前');
    expect(readFileSync(target, 'utf8')).toBe(original); expect(existsSync(join(dirname(target), 'modeldock-models.json'))).toBe(false);
    expect(f.store.getManagedState(codexHistoryKey(target), null)).toBeNull(); expect(f.store.listBindings()[0].enabled).toBe(false);
  });
  it('rolls partial undo back when a later file replacement fails and allows a retry', async () => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'); f.write(target, 'model="original"\n'); f.activate();
    await f.manager.run('codex', f.oldBinding, () => applyConfig(f.store, 'codex', 18181, f.root, join(f.root, 'backups'), f.root));
    const configured = readFileSync(target, 'utf8'), catalog = readFileSync(join(dirname(target), 'modeldock-models.json'), 'utf8');
    let failOnce = true;
    const failing = new ToolSyncUndoManager(f.store, { appData: join(f.root, 'appdata'), homeDirectory: f.root, replaceFile: (path, content) => {
      if (path.endsWith('modeldock-models.json') && failOnce) { failOnce = false; throw new Error('synthetic replacement failure'); }
      if (content === null) rmSync(path); else writeFileSync(path, content);
    } });
    await expect(failing.undo('codex')).rejects.toThrow('已恢复撤销前');
    expect(readFileSync(target, 'utf8')).toBe(configured); expect(readFileSync(join(dirname(target), 'modeldock-models.json'), 'utf8')).toBe(catalog);
    expect(f.manager.status('codex').available).toBe(true); await f.manager.undo('codex');
  });
  it.each(['ownership', 'binding', 'consume'] as const)('rolls undo back if committing its %s phase fails and preserves the original checkpoint', async phase => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'); f.write(target, 'model="original"\n'); f.activate();
    await f.manager.run('codex', f.oldBinding, () => applyConfig(f.store, 'codex', 18181, f.root, join(f.root, 'backups'), f.root));
    const configured = readFileSync(target, 'utf8'), oldRecord = f.store.getManagedState(toolSyncUndoKey('codex'), null), binding = f.store.listBindings()[0];
    let failOnce = true;
    if (phase === 'binding') vi.mocked(f.store.restoreBindingSelection).mockImplementation(value => {
      f.setBinding(value); if (failOnce) { failOnce = false; throw new Error('synthetic post-write binding failure'); }
    });
    else vi.mocked(f.store.setManagedState).mockImplementation((key, value) => {
      f.states.set(key, structuredClone(value));
      if (failOnce && (phase === 'ownership' ? key === codexHistoryKey(target) : key === toolSyncUndoKey('codex') && value === null)) { failOnce = false; throw new Error('synthetic post-write state failure'); }
    });
    await expect(f.manager.undo('codex')).rejects.toThrow('已恢复撤销前');
    expect(readFileSync(target, 'utf8')).toBe(configured); expect(f.store.listBindings()[0]).toEqual(binding); expect(f.store.getManagedState(toolSyncUndoKey('codex'), null)).toEqual(oldRecord);
    expect(f.manager.status('codex').available).toBe(true); await f.manager.undo('codex'); expect(readFileSync(target, 'utf8')).toBe('model="original"\n');
  });
  it('restores Claude settings and its ownership journal together, including original unrelated privacy and MCP settings', async () => {
    const f = fixture('claude-code'), target = join(f.root, '.claude', 'settings.json');
    const original = '{"env":{"ANTHROPIC_BASE_URL":"https://original.fixture","PRIVATE_USER_ENV":"keep"},"mcpServers":{"keep":{}},"model":"original"}'; f.write(target, original);
    f.activate(); await f.manager.run('claude-code', f.oldBinding, () => applyClaudeConfig(f.store, join(f.root, 'backups'), f.root));
    expect(readFileSync(target, 'utf8')).toContain('127.0.0.1'); expect(f.store.getManagedState(claudeHistoryKey(target), null)).not.toBeNull();
    await f.manager.undo('claude-code'); expect(readFileSync(target, 'utf8')).toBe(original); expect(f.store.getManagedState(claudeHistoryKey(target), null)).toBeNull();
  });
  it('restores DSH patch and opaque credential references without touching sessions or account authorization', async () => {
    const f = fixture('dsh'), dshHome = join(f.root, '.dsh'), patch = join(dshHome, 'cordis.patch.yml'), credentials = join(dshHome, '.credentials.yaml');
    const originalPatch = '# original\n- id: unrelated\n  config: { keep: true }\n', originalCredentials = 'version: 1\nrefs:\n  USER_KEEP: SYNTHETIC_USER_KEY\nrecords: {}\n';
    f.write(patch, originalPatch); f.write(credentials, originalCredentials); const session = join(dshHome, 'sessions', 'keep.json'); f.write(session, 'SYNTHETIC_SESSION_UNTOUCHED');
    const plan: DshPlan = { providers: { modeldock: { displayName: 'Fixture', baseURL: 'http://127.0.0.1:18181/v1', apiKeyEnv: 'MODELDOCK_DSH_AAAAAAAAAAAAAAAAAAAA_API_KEY', api: 'openai-responses', models: [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 4000, input: ['text'] }] } }, credentials: { MODELDOCK_DSH_AAAAAAAAAAAAAAAAAAAA_API_KEY: 'SYNTHETIC_PRIVATE_DSH_KEY' }, defaultModel: { provider: 'modeldock', model: 'fixture' } };
    f.activate(); await f.manager.run('dsh', f.oldBinding, () => applyDshConfig(f.store, plan, dshHome));
    await f.manager.undo('dsh'); expect(readFileSync(patch, 'utf8')).toBe(originalPatch); expect(readFileSync(credentials, 'utf8')).toBe(originalCredentials); expect(readFileSync(session, 'utf8')).toBe('SYNTHETIC_SESSION_UNTOUCHED');
  });
  it('passes JetBrains operations through without creating a second checkpoint workflow', async () => {
    const f = fixture('webstorm'), operation = vi.fn(() => 'JetBrains existing native sync');
    expect(await f.manager.run('webstorm', f.oldBinding, operation)).toBe('JetBrains existing native sync');
    expect(f.store.createManagedBackup).not.toHaveBeenCalled(); expect(f.store.setManagedState).not.toHaveBeenCalled(); expect(f.manager.status('webstorm').available).toBe(false);
  });
});
