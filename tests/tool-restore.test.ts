import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { applyConfig, codexHistoryKey } from '../src/main/adapters';
import { restoreOfficialConfig, type ToolRestoreStore } from '../src/main/tool-restore';
import type { Model, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-official-restore-')); roots.push(root);
  const states = new Map<string, unknown>();
  const store: ToolRestoreStore = {
    dataDir: root,
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn(() => join(root, 'backups', 'synthetic-private.enc')),
  };
  const backups = join(root, 'backups');
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, states, store, backups, write };
}
describe('official tool model-source restoration', () => {
  it('restores OpenCode in a configured XDG root while leaving the default profile intact', async () => {
    const f = fixture(), configHome = join(f.root, 'custom-config'), target = join(configHome, 'opencode', 'opencode.jsonc');
    const defaultFile = join(f.root, '.config', 'opencode', 'opencode.json'), originalDefault = '{"provider":{"default-profile":{}}}';
    f.write(defaultFile, originalDefault); f.write(target, '{\n// custom XDG\n"model":"foreign/model","provider":{"foreign":{}},"mcp":{"keep":{}}\n}');
    expect(await restoreOfficialConfig(f.store, 'opencode', f.root, f.backups, f.root, { configHome })).toBe(target);
    const output = readFileSync(target, 'utf8'); expect(parseJsonc(output)).toEqual({ mcp: { keep: {} } }); expect(output).toContain('custom XDG');
    expect(readFileSync(defaultFile, 'utf8')).toBe(originalDefault);
  });
  it('returns Codex to official active defaults instead of restoring a prior third-party selection, preserving native auth and unrelated configuration', async () => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml');
    const original = 'model = "prior-thirdparty-model"\nmodel_provider = "thirdparty"\nmodel_catalog_json = "/prior/catalog.json"\nopenai_base_url = "https://custom-openai.fixture/v1"\nchatgpt_base_url = "https://custom-chatgpt.fixture"\n[model_providers.thirdparty]\nbase_url="https://prior.fixture/v1"\n[model_providers.openai]\nbase_url="https://override-openai.fixture/v1"\n[mcp_servers.keep]\ncommand="keep-mcp"\n[skills]\nkeep=true\n';
    f.write(target, original); const auth = join(dirname(target), 'auth.json'); f.write(auth, '{"tokens":"SYNTHETIC_NATIVE_ACCOUNT"}');
    const model: Model = { id: 'fixture-model', providerId: 'fixture-provider', upstreamId: 'fixture-upstream', alias: 'fixture-alias', displayName: 'Fixture', wireApi: 'responses', contextWindow: 32000, tools: true, vision: false, enabled: true };
    const adapterStore = { ...f.store, listModels: () => [model], listBindings: () => [{ id: 'codex', name: 'Codex', note: '', enabled: true, modelIds: [model.id], defaultModelId: model.id } as ToolBinding], gatewayKey: () => 'SYNTHETIC_GATEWAY_KEY' };
    applyConfig(adapterStore, 'codex', 18181, f.root, f.backups, f.root);
    const configured = readFileSync(target, 'utf8'); const catalog = join(dirname(target), 'modeldock-models.json'); const originalCatalog = readFileSync(catalog, 'utf8');
    expect(f.store.getManagedState<any>(codexHistoryKey(target), null).fields.model_provider).toBe('thirdparty');
    expect(await restoreOfficialConfig(f.store, 'codex', f.root, f.backups, f.root)).toBe(target);
    const restored = parseToml(readFileSync(target, 'utf8')) as any;
    for (const key of ['model', 'model_provider', 'model_catalog_json', 'openai_base_url', 'chatgpt_base_url']) expect(restored).not.toHaveProperty(key);
    expect(restored.model_providers).toEqual({ thirdparty: { base_url: 'https://prior.fixture/v1' } });
    expect(restored.mcp_servers.keep.command).toBe('keep-mcp'); expect(restored.skills.keep).toBe(true);
    expect(readFileSync(auth, 'utf8')).toBe('{"tokens":"SYNTHETIC_NATIVE_ACCOUNT"}'); expect(existsSync(catalog)).toBe(false);
    expect(f.store.getManagedState(codexHistoryKey(target), null)).toBeNull();
    const backedUp = readdirSync(f.backups).map(name => readFileSync(join(f.backups, name), 'utf8'));
    expect(backedUp).toContain(configured); expect(backedUp).toContain(originalCatalog);
  });
  it('honors a configured Codex home for sync and restore and clears only the active profile model overrides', async () => {
    const f = fixture(), codexHome = join(f.root, 'isolated-codex'), target = join(codexHome, 'config.toml');
    f.write(target, 'profile="work"\nmodel_provider="modeldock"\nmodel="stale"\n[profiles.work]\nmodel_provider="thirdparty"\nmodel="profile-model"\nopenai_base_url="https://override.fixture/v1"\nchatgpt_base_url="https://override.fixture"\nmodel_catalog_json="/custom/catalog.json"\napproval_policy="on-request"\n[profiles.other]\nmodel_provider="other"\nmodel="other-model"\n');
    const authPath = join(codexHome, 'auth.json'); f.write(authPath, 'SYNTHETIC_CUSTOM_HOME_AUTH');
    const adapterStore = { ...f.store, listModels: () => [], listBindings: () => [{ id: 'codex', name: 'Codex', note: '', defaultModelId: '', enabled: true, modelIds: [] } as ToolBinding], gatewayKey: () => 'SYNTHETIC_ONLY' };
    expect(applyConfig(adapterStore, 'codex', 18181, f.root, f.backups, f.root, { codexHome })).toBe(target);
    await restoreOfficialConfig(f.store, 'codex', f.root, f.backups, f.root, { codexHome });
    const value = parseToml(readFileSync(target, 'utf8')) as any;
    expect(value.profile).toBe('work'); expect(value.profiles.work).toEqual({ approval_policy: 'on-request' });
    expect(value.profiles.other).toEqual({ model_provider: 'other', model: 'other-model' });
    expect(readFileSync(authPath, 'utf8')).toBe('SYNTHETIC_CUSTOM_HOME_AUTH'); expect(existsSync(join(f.root, '.codex'))).toBe(false);
  });
  it('clears all OpenCode custom model sources and selectors while preserving JSONC comments, MCP, agents, plugins and authorization files', async () => {
    const f = fixture(), target = join(f.root, '.config', 'opencode', 'opencode.jsonc');
    const original = '{\n// custom sources comment must survive\n"provider":{"foreign":{"options":{"apiKey":"SYNTHETIC_OLD_KEY"}},"modeldock":{}},\n"model":"foreign/model","small_model":"foreign/small","enabled_providers":["foreign"],"disabled_providers":["anthropic"],\n"mcp":{"keep":{"command":["mcp"]}},"agent":{"build":{"model":"foreign/agent-model","prompt":"keep"}},"command":{"custom":{"model":"foreign/command-model","template":"keep command"}},"plugin":["keep-plugin"]\n}';
    f.write(target, original); const auth = join(dirname(target), 'auth.json'); f.write(auth, 'SYNTHETIC_OPENCODE_AUTH');
    await restoreOfficialConfig(f.store, 'opencode', f.root, f.backups, f.root);
    const output = readFileSync(target, 'utf8'), value = parseJsonc(output);
    expect(output).toContain('custom sources comment must survive');
    expect(value).toEqual({ mcp: { keep: { command: ['mcp'] } }, agent: { build: { prompt: 'keep' } }, command: { custom: { template: 'keep command' } }, plugin: ['keep-plugin'] });
    expect(readFileSync(auth, 'utf8')).toBe('SYNTHETIC_OPENCODE_AUTH'); expect(readFileSync(join(f.backups, readdirSync(f.backups)[0]), 'utf8')).toBe(original);
  });
  it('removes every VS Code custom endpoint while retaining built-in/account-backed vendors and all JSONC comments', async () => {
    const f = fixture(), target = join(f.root, 'Code', 'User', 'chatLanguageModels.json');
    const official = { name: 'Official account source', vendor: 'copilot', models: [{ id: 'official' }] };
    const original = '[\n// native account comment\n' + JSON.stringify(official) + ',\n// foreign custom comment\n{"name":"Foreign","vendor":"customendpoint","apiKey":"SYNTHETIC_FOREIGN","models":[]},\n// managed comment\n{"name":"ModelDock","vendor":"customendpoint","models":[]}\n]';
    f.write(target, original); const settings = join(dirname(target), 'settings.json'); f.write(settings, '{"mcp":"keep","editor.fontSize":16}');
    await restoreOfficialConfig(f.store, 'vscode', f.root, f.backups, f.root);
    const output = readFileSync(target, 'utf8'); expect(parseJsonc(output)).toEqual([official]);
    for (const comment of ['native account comment', 'foreign custom comment', 'managed comment']) expect(output).toContain(comment);
    expect(readFileSync(settings, 'utf8')).toBe('{"mcp":"keep","editor.fontSize":16}');
    expect(readFileSync(join(f.backups, readdirSync(f.backups)[0]), 'utf8')).toBe(original);
  });
  it.each(['codex', 'opencode', 'vscode'] as const)('refuses invalid %s config before backups, journal changes or file mutation', async tool => {
    const f = fixture(); const target = tool === 'codex' ? join(f.root, '.codex', 'config.toml') : tool === 'opencode' ? join(f.root, '.config', 'opencode', 'opencode.json') : join(f.root, 'Code', 'User', 'chatLanguageModels.json');
    const invalid = tool === 'codex' ? 'model = [' : '{INVALID'; f.write(target, invalid);
    await expect(restoreOfficialConfig(f.store, tool, f.root, f.backups, f.root)).rejects.toThrow('格式有误');
    expect(readFileSync(target, 'utf8')).toBe(invalid); expect(existsSync(f.backups)).toBe(false); expect(f.store.setManagedState).not.toHaveBeenCalled();
  });
  it('preserves a concurrent save after backup and does not clear Codex recovery history', async () => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'); f.write(target, 'model_provider="modeldock"\nmodel="old"\n');
    const history = { version: 1, target, fields: { model_provider: 'original' } }; f.states.set(codexHistoryKey(target), history);
    const external = 'model_provider="concurrently-saved"\n';
    await expect(restoreOfficialConfig(f.store, 'codex', f.root, f.backups, f.root, { beforeCommit: () => writeFileSync(target, external) })).rejects.toThrow('其他程序修改');
    expect(readFileSync(target, 'utf8')).toBe(external); expect(f.store.getManagedState(codexHistoryKey(target), null)).toEqual(history); expect(f.store.setManagedState).not.toHaveBeenCalled();
  });
  it('does not write files when the Codex history reset fails and leaves a complete original backup', async () => {
    const f = fixture(), target = join(f.root, '.codex', 'config.toml'), original = 'model_provider="modeldock"\nmodel="old"\n'; f.write(target, original);
    vi.mocked(f.store.setManagedState).mockImplementation(() => { throw new Error('SYNTHETIC_STORAGE_FAILURE'); });
    await expect(restoreOfficialConfig(f.store, 'codex', f.root, f.backups, f.root)).rejects.toThrow('SYNTHETIC_STORAGE_FAILURE');
    expect(readFileSync(target, 'utf8')).toBe(original); expect(readFileSync(join(f.backups, readdirSync(f.backups)[0]), 'utf8')).toBe(original);
  });
  it('does not create missing config files and keeps user-owned companion catalogs intact', async () => {
    const f = fixture(), catalog = join(f.root, '.codex', 'modeldock-models.json'); const userCatalog = '{"models":[{"description":"User-managed catalog"}]}'; f.write(catalog, userCatalog);
    for (const tool of ['codex', 'opencode', 'vscode'] as const) await restoreOfficialConfig(f.store, tool, f.root, f.backups, f.root);
    expect(readFileSync(catalog, 'utf8')).toBe(userCatalog); expect(existsSync(join(f.root, '.codex', 'config.toml'))).toBe(false); expect(existsSync(f.backups)).toBe(false);
  });
});
