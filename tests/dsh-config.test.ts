import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as yaml, parseDocument, stringify } from 'yaml';
import { applyDshConfig, restoreDshOfficialConfig, validateDshPlan, type DshConfigStore, type DshPlan } from '../src/main/dsh-config';
import { DSH_LEGACY_PLUGIN_ID, DSH_LEGACY_PLUGIN_SOURCE, DSH_LEGACY_SCRIPT } from '../src/main/dsh-runtime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const refA = 'MODELDOCK_DSH_0123456789ABCDEF0123_API_KEY', refB = 'MODELDOCK_DSH_ABCDEF0123456789ABCD_API_KEY';
function plan(ids: ('a' | 'b')[] = ['a', 'b'], syncScope: 'managed' | 'selected' = 'managed'): DshPlan {
  return { syncScope, providers: Object.fromEntries(ids.map(id => [`modeldock-${id}`, {
    displayName: `ModelDock · 来源 ${id}`, baseURL: id === 'a' ? 'https://api.fixture.test/v1' : 'http://127.0.0.1:18181/tool/dsh/v1',
    apiKeyEnv: id === 'a' ? refA : refB, api: id === 'a' ? 'openai-completions' : 'openai-responses',
    models: [{ id: id === 'a' ? 'same-id' : 'subscription/same-id', name: `来源 ${id} - 同名`, contextWindow: 32768, maxTokens: 4096, input: ['text'] }],
  }])), credentials: Object.fromEntries(ids.map(id => [id === 'a' ? refA : refB, `SYNTHETIC_${id}_KEY`])),
  ...(ids.length ? { defaultModel: { provider: `modeldock-${ids.at(-1)!}`, model: ids.at(-1) === 'a' ? 'same-id' : 'subscription/same-id' } } : {}),
  } as DshPlan;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-dsh-')); roots.push(root);
  const home = join(root, '.dsh'); mkdirSync(home);
  const states = new Map<string, any>();
  const store: DshConfigStore = {
    dataDir: root,
    getManagedState: <T>(key: string, fallback: T) => structuredClone(states.get(key) ?? fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn(() => join(root, 'backups', 'synthetic-private.enc')),
  };
  const patchPath = join(home, 'cordis.patch.yml'), credentialsPath = join(home, '.credentials.yaml');
  const patchText = '# Home plugins must survive\n- id: unrelated-plugin\n  config:\n    keep: true # native unrelated setting\n- id: llm-pi-ai\n  config:\n    providers:\n      original:\n        displayName: Original home route\n        api: openai-completions\n        baseURL: https://original.fixture.test/v1\n        apiKeyEnv: ORIGINAL_REF\n        models: [{ id: original-model, name: Original }]\n- id: agent-default-model\n  config:\n    provider: original\n    model: original-model\n    reasoningEffort: high\n';
  const credentialsText = '# Native credentials\nversion: 1\nrefs:\n  ORIGINAL_REF: SYNTHETIC_ORIGINAL_KEY # preserve unrelated ref\nrecords:\n  original-account:\n    provider: original\n    token: SYNTHETIC_ACCOUNT_TOKEN\n';
  writeFileSync(patchPath, patchText); writeFileSync(credentialsPath, credentialsText);
  return { root, home, states, store, patchPath, credentialsPath, patchText, credentialsText };
}
function rows(path: string) { return parseDocument(readFileSync(path, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }).toJS() as any[]; }
function nativeProviders(path: string) { return rows(path).find(row => row.id === 'llm-pi-ai').config.providers; }
function compatiblePlan(): DshPlan {
  const selected = plan(['a'], 'selected');
  selected.legacyDispatch = { version: 1, mappings: [{ legacyProvider: 'deepseek-official', model: 'same-id', targetProvider: 'modeldock-a', targetModel: 'same-id' }] };
  return selected;
}
describe('DSH native configuration synchronization', () => {
  it('official restore clears custom home model sources instead of resurrecting previous routes and preserves native account credentials and unrelated plugins', () => {
    const f = fixture(); writeFileSync(f.patchPath, f.patchText.replace('- id: agent-default-model\n', '- id: agent-default-model\n  disabled: true\n'));
    applyDshConfig(f.store, plan(['a'], 'selected'), f.home);
    const before = readFileSync(f.patchPath, 'utf8');
    expect(restoreDshOfficialConfig(f.store, f.home)).toBe(f.patchPath);
    const restored = rows(f.patchPath), piai = restored.find(row => row.id === 'llm-pi-ai'), preferred = restored.find(row => row.id === 'agent-default-model');
    expect(piai.config?.providers).toBeUndefined(); expect(piai.disabled).toBeUndefined();
    expect(preferred.config).toEqual({ reasoningEffort: 'high' }); expect(preferred.disabled).toBeUndefined();
    expect(restored.find(row => row.id === 'unrelated-plugin').config).toEqual({ keep: true });
    expect(restored.filter(row => ['llm-deepseek', 'llm-deepseek-account'].includes(row.id)).every(row => row.disabled === undefined)).toBe(true);
    const credentials = parseDocument(readFileSync(f.credentialsPath, 'utf8')).toJS();
    expect(credentials.refs).toEqual({ ORIGINAL_REF: 'SYNTHETIC_ORIGINAL_KEY' });
    expect(credentials.records).toEqual({ 'original-account': { provider: 'original', token: 'SYNTHETIC_ACCOUNT_TOKEN' } });
    const backup = vi.mocked(f.store.createManagedBackup).mock.calls.at(-1)!;
    expect((backup[1] as any).files.find((file: any) => file.path === f.patchPath).before).toBe(before);
    expect(readFileSync(f.patchPath, 'utf8')).toContain('Home plugins must survive');
  });
  it('official restore validates untracked native files and preserves all data when the private backup fails', () => {
    const f = fixture(); writeFileSync(f.patchPath, '- id: llm-pi-ai\n  config: [broken\n');
    expect(() => restoreDshOfficialConfig(f.store, f.home)).toThrow('格式有误');
    expect(f.store.createManagedBackup).not.toHaveBeenCalled();
    writeFileSync(f.patchPath, f.patchText); vi.mocked(f.store.createManagedBackup).mockImplementation(() => { throw new Error('SYNTHETIC_BACKUP_FAILURE'); });
    expect(() => restoreDshOfficialConfig(f.store, f.home)).toThrow('加密备份');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
  });
  it('installs trusted compatibility bytes through a native insertion, remains idempotent and withdraws dispatch on clear without editing session files', () => {
    const f = fixture(), script = join(f.home, DSH_LEGACY_SCRIPT);
    applyDshConfig(f.store, compatiblePlan(), f.home);
    expect(readFileSync(script, 'utf8')).toBe(DSH_LEGACY_PLUGIN_SOURCE);
    const wrapper = rows(f.patchPath).find(row => row.insert?.some((child: any) => child.id === DSH_LEGACY_PLUGIN_ID));
    expect(wrapper.insert[0].name).toContain('file:'); expect(wrapper.insert[0].config).toEqual(compatiblePlan().legacyDispatch);
    expect([...f.states.values()][0].version).toBe(3);
    const backupCount = vi.mocked(f.store.createManagedBackup).mock.calls.length;
    applyDshConfig(f.store, compatiblePlan(), f.home); expect(f.store.createManagedBackup).toHaveBeenCalledTimes(backupCount);
    applyDshConfig(f.store, plan([], 'selected'), f.home);
    expect(rows(f.patchPath).some(row => row.insert?.some((child: any) => child.id === DSH_LEGACY_PLUGIN_ID))).toBe(false);
    expect(nativeProviders(f.patchPath)).toEqual({});
    expect(readFileSync(script, 'utf8')).toBe(DSH_LEGACY_PLUGIN_SOURCE);
    expect([...f.states.values()][0].runtime.installedPlugin).toBeUndefined();
    expect(existsSync(join(f.home, 'sessions'))).toBe(false);
  });
  it('removes compatibility before returning to managed providers and preserves unrelated insertions', () => {
    const f = fixture(); applyDshConfig(f.store, compatiblePlan(), f.home);
    const changed = rows(f.patchPath), wrapper = changed.find(row => row.insert?.some((child: any) => child.id === DSH_LEGACY_PLUGIN_ID));
    wrapper.insert.push({ id: 'user-added-plugin', name: 'user-fixture' }); writeFileSync(f.patchPath, stringify(changed));
    applyDshConfig(f.store, plan(['a'], 'managed'), f.home);
    expect(rows(f.patchPath).find(row => row.insert).insert).toEqual([{ id: 'user-added-plugin', name: 'user-fixture' }]);
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek')).toBeUndefined();
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['original', 'modeldock-a']);
  });
  it('never overwrites external changes to the installed compatibility code or native plugin mapping', () => {
    const f = fixture(), script = join(f.home, DSH_LEGACY_SCRIPT); applyDshConfig(f.store, compatiblePlan(), f.home);
    const before = readFileSync(f.patchPath, 'utf8'), credentials = readFileSync(f.credentialsPath, 'utf8');
    writeFileSync(script, '// externally edited code\n');
    expect(() => applyDshConfig(f.store, compatiblePlan(), f.home)).toThrow('脚本已被其他程序修改');
    expect(readFileSync(script, 'utf8')).toBe('// externally edited code\n'); expect(readFileSync(f.patchPath, 'utf8')).toBe(before); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(credentials);
    writeFileSync(script, DSH_LEGACY_PLUGIN_SOURCE);
    const altered = rows(f.patchPath), entry = altered.find(row => row.insert).insert[0]; entry.config.mappings[0].targetProvider = 'user-changed'; writeFileSync(f.patchPath, stringify(altered));
    const edited = readFileSync(f.patchPath, 'utf8');
    expect(() => applyDshConfig(f.store, plan([], 'managed'), f.home)).toThrow('插件刚被其他程序修改');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(edited);
  });
  it('rolls all three files back when the native patch cannot commit after the static script was installed', () => {
    const f = fixture(), script = join(f.home, DSH_LEGACY_SCRIPT);
    expect(() => applyDshConfig(f.store, compatiblePlan(), f.home, { replaceFile: (path, content) => {
      if (path === f.patchPath) throw new Error('private-error-must-not-escape');
      mkdirSync(join(f.home, '.modeldock'), { recursive: true }); writeFileSync(path, content!);
    } })).toThrow('已恢复原配置与凭据');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText); expect(existsSync(script)).toBe(false);
    expect([...f.states.values()][0].pending).toBeUndefined();
  });
  it('publishes only selected sources, suppresses renamed nested model adapters, preserves the account service and restores exact native disabled flags in managed scope', () => {
    const f = fixture();
    const apiName = '@deepseek-ai/dsh-llm-deepseek-api-key', accountName = '@deepseek-ai/dsh-llm-deepseek-account', piaiName = '@deepseek-ai/dsh-llm-pi-ai';
    const extra = '\n- id: nested-sources\n  name: group-fixture\n  group: true\n  config:\n    - id: renamed-api\n      name: "' + apiName + '"\n      disabled: false\n      config: {keep: true}\n    - id: already-disabled\n      name: "' + apiName + '"\n      disabled: true\n    - id: expression-disabled\n      name: "' + apiName + '"\n      disabled: !!js "globalThis.__MODELDOCK_EVALUATED = true"\n    - id: extra-piai\n      name: "' + piaiName + '"\n      disabled: true\n- id: deepseek-account\n  name: "@deepseek-ai/dsh-deepseek-account-platform"\n  config: {keepAccount: true}\n';
    writeFileSync(f.patchPath, f.patchText + extra);
    const original = rows(f.patchPath), account = original.find(row => row.id === 'deepseek-account');
    const options = { modelPlugins: [
      { id: 'llm-pi-ai', name: piaiName },
      { id: 'renamed-api', name: apiName }, { id: 'already-disabled', name: apiName }, { id: 'expression-disabled', name: apiName }, { id: 'extra-piai', name: piaiName }, { id: 'llm-deepseek-account', name: accountName },
    ], baselineProviders: { 'profile-source': { models: [{ id: 'profile-only' }] } } };
    applyDshConfig(f.store, plan(['a'], 'selected'), f.home, options);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['modeldock-a']);
    const nested = rows(f.patchPath).find(row => row.id === 'nested-sources').config;
    expect(nested.every((row: any) => row.disabled === true)).toBe(true);
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek-account').disabled).toBe(true);
    expect(rows(f.patchPath).find(row => row.id === 'deepseek-account')).toEqual(account);
    expect(yaml(readFileSync(f.credentialsPath, 'utf8')).records).toEqual(yaml(f.credentialsText).records);
    expect((globalThis as any).__MODELDOCK_EVALUATED).toBeUndefined();
    const calls = vi.mocked(f.store.createManagedBackup).mock.calls.length;
    applyDshConfig(f.store, plan(['a'], 'selected'), f.home, options); expect(f.store.createManagedBackup).toHaveBeenCalledTimes(calls);
    applyDshConfig(f.store, plan([], 'selected'), f.home, options);
    expect(nativeProviders(f.patchPath)).toEqual({});
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek-account').disabled).toBe(true);
    expect(rows(f.patchPath).find(row => row.id === 'agent-default-model').config).toEqual({ provider: 'original', model: 'original-model', reasoningEffort: 'high' });
    applyDshConfig(f.store, plan(['a'], 'managed'), f.home, options);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['profile-source', 'original', 'modeldock-a']);
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek-account')).toBeUndefined();
    expect(rows(f.patchPath).find(row => row.id === 'nested-sources').config).toEqual(original.find(row => row.id === 'nested-sources').config);
    expect(readFileSync(f.patchPath, 'utf8')).toContain('!!js');
    expect((globalThis as any).__MODELDOCK_EVALUATED).toBeUndefined();
    applyDshConfig(f.store, plan([], 'managed'), f.home, options);
    expect(rows(f.patchPath)).toEqual(original);
    expect(yaml(readFileSync(f.credentialsPath, 'utf8'))).toEqual(yaml(f.credentialsText));
  });
  it('keeps an empty selected scope exclusive until managed is chosen, including the default scope for old callers', () => {
    const f = fixture(), empty = plan([]); delete empty.syncScope;
    applyDshConfig(f.store, empty, f.home);
    expect(nativeProviders(f.patchPath)).toEqual({});
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek').disabled).toBe(true);
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek-account').disabled).toBe(true);
    expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
    applyDshConfig(f.store, plan([], 'managed'), f.home);
    expect(rows(f.patchPath)).toEqual(yaml(f.patchText));
    expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
  });
  it('preserves user changes to source flags and settings when selected-only mode is switched off', () => {
    const f = fixture(); writeFileSync(f.patchPath, f.patchText + '- id: llm-deepseek\n  disabled: false\n  config: {keep: old}\n');
    applyDshConfig(f.store, plan(['a'], 'selected'), f.home);
    const edited = rows(f.patchPath); edited.find(row => row.id === 'llm-deepseek').disabled = false; edited.find(row => row.id === 'llm-deepseek').config.keep = 'user-edited';
    edited.find(row => row.id === 'llm-deepseek-account').config = { newlyAddedByUser: true };
    writeFileSync(f.patchPath, stringify(edited));
    applyDshConfig(f.store, plan([], 'managed'), f.home);
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek')).toEqual({ id: 'llm-deepseek', disabled: false, config: { keep: 'user-edited' } });
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek-account')).toEqual({ id: 'llm-deepseek-account', config: { newlyAddedByUser: true } });
  });
  it('upgrades version-one history without losing the original overlay, credentials or default-model restoration', () => {
    const f = fixture(); applyDshConfig(f.store, plan(['a']), f.home);
    const [key, state] = [...f.states.entries()][0];
    delete state.syncScope; delete state.suppressedRows; delete state.baselineProviders; state.version = 1;
    f.states.set(key, state);
    applyDshConfig(f.store, plan([], 'selected'), f.home);
    expect(nativeProviders(f.patchPath)).toEqual({});
    expect([...f.states.values()][0].version).toBe(3);
    expect([...f.states.values()][0].suppressedRows['llm-deepseek']).toBeDefined();
    applyDshConfig(f.store, plan([], 'managed'), f.home);
    expect(rows(f.patchPath)).toEqual(yaml(f.patchText));
    expect(yaml(readFileSync(f.credentialsPath, 'utf8'))).toEqual(yaml(f.credentialsText));
  });
  it('recovers an incomplete version-one multi-file transaction before applying selected-only source flags', () => {
    const f = fixture();
    expect(() => applyDshConfig(f.store, plan(['a']), f.home, { replaceFile: (path, contents) => {
      if (path === f.patchPath) { writeFileSync(f.patchPath, '# concurrent native change\n' + f.patchText); throw new Error('fixture stop'); }
      writeFileSync(path, contents!);
    } })).toThrow('自动恢复未完成');
    const [key, state] = [...f.states.entries()][0];
    for (const item of [state, state.pending.previous, state.pending.complete]) { item.version = 1; delete item.syncScope; delete item.suppressedRows; delete item.baselineProviders; }
    f.states.set(key, state); writeFileSync(f.patchPath, f.patchText);
    applyDshConfig(f.store, plan(['b'], 'selected'), f.home);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['modeldock-b']);
    expect(rows(f.patchPath).find(row => row.id === 'llm-deepseek').disabled).toBe(true);
    expect([...f.states.values()][0].version).toBe(3); expect([...f.states.values()][0].pending).toBeUndefined();
    expect(yaml(readFileSync(f.credentialsPath, 'utf8')).refs).toEqual({ ORIGINAL_REF: 'SYNTHETIC_ORIGINAL_KEY', [refB]: 'SYNTHETIC_b_KEY' });
  });
  it('protects account-service entries from misleading model metadata and handles prototype-like native IDs safely', () => {
    const f = fixture();
    expect(() => applyDshConfig(f.store, plan(['a'], 'selected'), f.home, { modelPlugins: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }, { id: 'deepseek-account', name: '@deepseek-ai/dsh-deepseek-account-platform' }] })).toThrow('本机模型来源解析无效');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText);
    const options = { modelPlugins: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }, { id: '__proto__', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }] };
    applyDshConfig(f.store, plan(['a'], 'selected'), f.home, options);
    expect(rows(f.patchPath).find(row => row.id === '__proto__').disabled).toBe(true);
    expect(Object.hasOwn([...f.states.values()][0].suppressedRows, '__proto__')).toBe(true);
    expect((Object.prototype as any).installed).toBeUndefined();
    applyDshConfig(f.store, plan([], 'managed'), f.home, options);
    expect(rows(f.patchPath).find(row => row.id === '__proto__')).toBeUndefined();
    expect((Object.prototype as any).installed).toBeUndefined();
  });
  it('writes selected native routes/default/credential refs while preserving unrelated plugin settings, records and untouched profile files', () => {
    const f = fixture(), profile = join(f.home, 'profiles', 'desktop'); mkdirSync(profile, { recursive: true });
    const profileText = '- id: llm-pi-ai\n  config:\n    providers: {profile-only: {api: openai-completions}}\n';
    writeFileSync(join(profile, 'cordis.patch.yml'), profileText);
    expect(applyDshConfig(f.store, plan(), f.home)).toBe(f.patchPath);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['original', 'modeldock-a', 'modeldock-b']);
    expect(rows(f.patchPath).find(row => row.id === 'agent-default-model').config).toEqual({ provider: 'modeldock-b', model: 'subscription/same-id' });
    expect(rows(f.patchPath).find(row => row.id === 'unrelated-plugin').config).toEqual({ keep: true });
    expect(readFileSync(f.patchPath, 'utf8')).toContain('# native unrelated setting');
    expect(readFileSync(f.patchPath, 'utf8')).not.toContain('SYNTHETIC_');
    const credentials = yaml(readFileSync(f.credentialsPath, 'utf8'));
    expect(credentials).toMatchObject({ version: 1, refs: { ORIGINAL_REF: 'SYNTHETIC_ORIGINAL_KEY', [refA]: 'SYNTHETIC_a_KEY', [refB]: 'SYNTHETIC_b_KEY' }, records: { 'original-account': { token: 'SYNTHETIC_ACCOUNT_TOKEN' } } });
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(profileText);
    expect(f.store.createManagedBackup).toHaveBeenCalledOnce();
    expect(vi.mocked(f.store.createManagedBackup).mock.calls[0][0]).toBe('dsh-sync');
  });
  it('is idempotent, prunes only deselected ModelDock references, rotates credentials and restores previous home overlays on clear', () => {
    const f = fixture(); applyDshConfig(f.store, plan(), f.home);
    const first = readFileSync(f.patchPath, 'utf8'), firstCredentials = readFileSync(f.credentialsPath, 'utf8');
    applyDshConfig(f.store, plan(), f.home);
    expect(readFileSync(f.patchPath, 'utf8')).toBe(first); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(firstCredentials);
    expect(f.store.createManagedBackup).toHaveBeenCalledOnce();
    const selected = plan(['a']); selected.credentials[refA] = 'SYNTHETIC_ROTATED_KEY'; applyDshConfig(f.store, selected, f.home);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['original', 'modeldock-a']);
    expect(yaml(readFileSync(f.credentialsPath, 'utf8')).refs).toEqual({ ORIGINAL_REF: 'SYNTHETIC_ORIGINAL_KEY', [refA]: 'SYNTHETIC_ROTATED_KEY' });
    applyDshConfig(f.store, plan([]), f.home);
    expect(rows(f.patchPath)).toEqual(yaml(f.patchText));
    expect(yaml(readFileSync(f.credentialsPath, 'utf8'))).toEqual(yaml(f.credentialsText));
    expect(readFileSync(f.credentialsPath, 'utf8')).toContain('# preserve unrelated ref');
    const calls = vi.mocked(f.store.createManagedBackup).mock.calls.length;
    applyDshConfig(f.store, plan([]), f.home); expect(f.store.createManagedBackup).toHaveBeenCalledTimes(calls);
  });
  it('creates valid native files on a new home and removes only newly inserted plugin rows on clear', () => {
    const f = fixture(); rmSync(f.home, { recursive: true });
    applyDshConfig(f.store, plan(['a']), f.home);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['modeldock-a']);
    expect(rows(f.patchPath).find(row => row.id === 'llm-pi-ai').name).toBe('@deepseek-ai/dsh-llm-pi-ai');
    expect(rows(f.patchPath).find(row => row.id === 'agent-default-model').name).toBe('@deepseek-ai/dsh-agent-default-model');
    applyDshConfig(f.store, plan([]), f.home);
    expect(rows(f.patchPath)).toEqual([]);
    expect(yaml(readFileSync(f.credentialsPath, 'utf8'))).toEqual({ version: 1, refs: {}, records: {} });
  });
  it('safely refuses a profile with only a renamed pi-ai target and names valid canonical overlays while protecting conflicting plugin names', () => {
    const f = fixture();
    const renamed = '- id: renamed-piai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config: {providers: {original: {models: []}}}\n';
    writeFileSync(f.patchPath, renamed);
    expect(() => applyDshConfig(f.store, plan(['a'], 'selected'), f.home, { modelPlugins: [{ id: 'renamed-piai', name: '@deepseek-ai/dsh-llm-pi-ai' }] })).toThrow('缺少标准模型插件');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(renamed);
    expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
    expect(f.store.createManagedBackup).not.toHaveBeenCalled();
    expect(f.store.setManagedState).not.toHaveBeenCalled();
    const legacy = fixture();
    applyDshConfig(legacy.store, plan(['a'], 'selected'), legacy.home);
    expect(rows(legacy.patchPath).find(row => row.id === 'llm-pi-ai').name).toBe('@deepseek-ai/dsh-llm-pi-ai');
    expect(rows(legacy.patchPath).find(row => row.id === 'agent-default-model').name).toBe('@deepseek-ai/dsh-agent-default-model');
    const conflict = fixture();
    for (const id of ['llm-pi-ai', 'agent-default-model']) {
      const conflictingText = stringify([{ id, name: '@deepseek-ai/dsh-deepseek-account-platform', config: { protected: true } }]);
      writeFileSync(conflict.patchPath, conflictingText);
      expect(() => applyDshConfig(conflict.store, plan(['a'], 'selected'), conflict.home)).toThrow('插件 ID 与其他插件冲突');
      expect(readFileSync(conflict.patchPath, 'utf8')).toBe(conflictingText);
      expect(conflict.store.createManagedBackup).not.toHaveBeenCalled();
    }
  });
  it('preserves a user-edited default and foreign routes added after synchronization when clearing', () => {
    const f = fixture(); applyDshConfig(f.store, plan(), f.home);
    const current = rows(f.patchPath);
    current.find(row => row.id === 'agent-default-model').config = { provider: 'user-choice', model: 'user-model' };
    current.find(row => row.id === 'llm-pi-ai').config.providers['user-choice'] = { displayName: 'User changed', models: [{ id: 'user-model' }] };
    writeFileSync(f.patchPath, stringify(current));
    applyDshConfig(f.store, plan([]), f.home);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['original', 'user-choice']);
    expect(rows(f.patchPath).find(row => row.id === 'agent-default-model').config).toEqual({ provider: 'user-choice', model: 'user-model' });
  });
  it('restores a pre-existing credential slot rather than deleting it and keeps changed external credential slots', () => {
    const f = fixture(); const original = yaml(f.credentialsText); original.refs[refA] = 'SYNTHETIC_OLD_SLOT'; writeFileSync(f.credentialsPath, stringify(original));
    applyDshConfig(f.store, plan(), f.home);
    const edited = yaml(readFileSync(f.credentialsPath, 'utf8')); edited.refs[refB] = 'SYNTHETIC_EXTERNAL_EDIT'; writeFileSync(f.credentialsPath, stringify(edited));
    applyDshConfig(f.store, plan([]), f.home);
    expect(yaml(readFileSync(f.credentialsPath, 'utf8')).refs).toEqual({ ORIGINAL_REF: 'SYNTHETIC_ORIGINAL_KEY', [refA]: 'SYNTHETIC_OLD_SLOT', [refB]: 'SYNTHETIC_EXTERNAL_EDIT' });
  });
  it('refuses malformed native credentials, duplicate managed plugin rows and unsupported plan fields before mutation', () => {
    const f = fixture(); writeFileSync(f.credentialsPath, 'version: 2\nrefs: {}\nrecords: {}\n');
    expect(() => applyDshConfig(f.store, plan(), f.home)).toThrow('凭据配置格式'); expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText);
    writeFileSync(f.credentialsPath, f.credentialsText); writeFileSync(f.patchPath, '- id: llm-pi-ai\n- id: llm-pi-ai\n');
    expect(() => applyDshConfig(f.store, plan(), f.home)).toThrow('重复');
    const invalid = plan(); (invalid.providers['modeldock-a'].models[0] as any).wireModel = 'unsupported';
    expect(() => validateDshPlan(invalid)).toThrow('同步模型');
    expect(f.store.createManagedBackup).not.toHaveBeenCalled();
  });
  it('accepts declared model thinking levels and rejects malformed ones before any mutation', () => {
    const valid = plan(); valid.providers['modeldock-a'].models[0].reasoningEfforts = ['low', 'high'];
    expect(() => validateDshPlan(valid)).not.toThrow();
    for (const bad of [['ultra'], ['low', 'low'], [], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'low']]) {
      const invalid = plan(); invalid.providers['modeldock-a'].models[0].reasoningEfforts = bad;
      expect(() => validateDshPlan(invalid)).toThrow('同步模型');
    }
  });
  it('does not touch files when encrypted backup or recovery-journal persistence fails', () => {
    const f = fixture(); vi.mocked(f.store.createManagedBackup).mockImplementationOnce(() => { throw new Error('private detail'); });
    expect(() => applyDshConfig(f.store, plan(), f.home)).toThrow('加密备份');
    vi.mocked(f.store.setManagedState).mockImplementationOnce(() => { throw new Error('private storage detail'); });
    expect(() => applyDshConfig(f.store, plan(), f.home)).toThrow('恢复记录');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
  });
  it('rolls both native files back byte-for-byte if the second file cannot commit', () => {
    const f = fixture();
    expect(() => applyDshConfig(f.store, plan(), f.home, { replaceFile: (path, value) => {
      if (path === f.patchPath) throw new Error('SYNTHETIC_SECRET_ERROR_DO_NOT_RELAY');
      writeFileSync(path, value!);
    } })).toThrow('已恢复原配置与凭据');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
    expect([...f.states.values()][0].pending).toBeUndefined();
  });
  it('rolls back native writes if storing the completed synchronization state fails', () => {
    const f = fixture(); const setter = f.store.setManagedState;
    vi.mocked(f.store.setManagedState).mockImplementation((key, value: any) => {
      if (!value.pending && Object.keys(value.installedRefs).length) throw new Error('synthetic final storage fault');
      f.states.set(key, structuredClone(value));
    });
    expect(() => applyDshConfig(f.store, plan(), f.home)).toThrow('已恢复原配置与凭据');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
    f.store.setManagedState = setter;
  });
  it('detects a concurrent edit before writing, preserving it and not exposing credential contents in the error', () => {
    const f = fixture(), external = '# External saved change\n' + f.patchText;
    expect(() => applyDshConfig(f.store, plan(), f.home, { beforeCommit: () => writeFileSync(f.patchPath, external) })).toThrow('同步未执行');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(external); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
    expect([...f.states.values()][0].pending).toBeUndefined();
  });
  it('retains a recovery journal rather than overwriting a concurrent mid-commit change, then safely recovers on retry', () => {
    const f = fixture();
    expect(() => applyDshConfig(f.store, plan(), f.home, { replaceFile: (path, value) => {
      if (path === f.patchPath) { writeFileSync(f.credentialsPath, '# External\n' + f.credentialsText); throw new Error('synthetic collision'); }
      writeFileSync(path, value!);
    } })).toThrow('自动恢复未完成');
    expect(readFileSync(f.credentialsPath, 'utf8')).toBe('# External\n' + f.credentialsText);
    expect([...f.states.values()][0].pending).toBeDefined();
    expect(() => applyDshConfig(f.store, plan(), f.home)).toThrow('恢复尚未完成');
    writeFileSync(f.credentialsPath, f.credentialsText);
    applyDshConfig(f.store, plan(['a']), f.home);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['original', 'modeldock-a']);
    expect([...f.states.values()][0].pending).toBeUndefined();
  });
  it('rechecks the second file after committing credentials and never overwrites a newly saved native patch', () => {
    const f = fixture(), externalPatch = '# External saved between commits\n' + f.patchText;
    const replacement = vi.fn((path: string, contents: string | null) => {
      writeFileSync(path, contents!);
      if (path === f.credentialsPath) writeFileSync(f.patchPath, externalPatch);
    });
    let error: unknown;
    try { applyDshConfig(f.store, plan(), f.home, { replaceFile: replacement }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain('自动恢复未完成');
    expect((error as Error).message).not.toMatch(/SYNTHETIC_|PRIVATE_|ORIGINAL_REF/);
    expect(replacement).toHaveBeenCalledOnce(); expect(replacement.mock.calls[0][0]).toBe(f.credentialsPath);
    expect(readFileSync(f.patchPath, 'utf8')).toBe(externalPatch);
    expect([...f.states.values()][0].pending).toBeDefined();
    expect(() => applyDshConfig(f.store, plan(['a']), f.home)).toThrow('恢复尚未完成');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(externalPatch);
    writeFileSync(f.patchPath, f.patchText);
    applyDshConfig(f.store, plan(['a']), f.home);
    expect(Object.keys(nativeProviders(f.patchPath))).toEqual(['original', 'modeldock-a']);
    expect([...f.states.values()][0].pending).toBeUndefined();
  });
  it('rejects a forged recovery file path and never attempts to mutate another application', () => {
    const f = fixture(); applyDshConfig(f.store, plan(), f.home);
    const [key, current] = [...f.states.entries()][0];
    current.pending = { files: [{ path: join(f.root, 'unrelated'), before: null, after: 'forged' }, { path: f.patchPath, before: null, after: 'forged' }], backupPath: '/private.enc', previous: current, complete: current };
    f.states.set(key, current);
    expect(() => applyDshConfig(f.store, plan([]), f.home)).toThrow('恢复记录无效');
    expect(existsSync(join(f.root, 'unrelated'))).toBe(false);
  });
  it('refuses a linked DSH home or linked ancestor, keeping the actual target untouched', () => {
    const f = fixture(), link = join(f.root, 'home-alias');
    symlinkSync(f.home, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => applyDshConfig(f.store, plan(), link)).toThrow('父目录是链接');
    expect(() => applyDshConfig(f.store, plan(), join(link, 'child-home'))).toThrow('父目录是链接');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText); expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credentialsText);
    expect(f.store.createManagedBackup).not.toHaveBeenCalled();
  });
  it('reports multi-document YAML failure without relaying sensitive parser excerpts', () => {
    const f = fixture();
    writeFileSync(f.credentialsPath, 'version: 1\nrefs: {ORIGINAL_REF: SYNTHETIC_PRIVATE_PARSER_TEXT}\nrecords: {}\n---\nextra: true\n');
    let error: unknown;
    try { applyDshConfig(f.store, plan(), f.home); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('YAML 格式有误');
    expect((error as Error).message).not.toContain('SYNTHETIC_PRIVATE_PARSER_TEXT');
    expect(readFileSync(f.patchPath, 'utf8')).toBe(f.patchText);
    expect(f.store.createManagedBackup).not.toHaveBeenCalled();
  });
});
