import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { Store } from '../src/main/store';
import { applyConfig } from '../src/main/adapters';
import { ToolSyncUndoManager, toolSyncUndoKey } from '../src/main/tool-sync-undo';
import { restoreOfficialConfig } from '../src/main/tool-restore';
import { vsCodeConfigTargets, vsCodeHistoryKey, type VsCodeProxyPlan } from '../src/main/vscode-config';
import * as privateFiles from '../src/main/private-file';
import { switchSingleEntryMode } from '../src/shared/single-entry';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) action();
});
const proxy: VsCodeProxyPlan = { eligible: true, proxyUrl: 'http://127.0.0.1:20081' };
const originalModels = '[\n  // Keep the built-in source\n  {"vendor":"copilot","name":"Built-in"},\n  {"vendor":"customendpoint","name":"Original custom source","models":[]}\n]\n';
const originalSettings = '{\n  // Keep the user network and editor preferences\n  "http.noProxy": ["localhost", "127.0.0.1", "::1"],\n  "workbench.colorTheme": "Dark Modern"\n}\n';
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'modeldock-vscode-proxy-integration-'));
  const store = await Store.create(join(home, 'data'), {
    encrypt: value => Buffer.from(value).toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString(),
  });
  cleanup.push(() => { store.close(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const source = store.saveProvider({ name: 'VS Code fixture', kind: 'openai-compatible', baseUrl: 'https://vscode-fixture.invalid/v1', enabled: true, apiKey: 'synthetic-vscode-upstream-key' });
  const model = store.saveModel({ providerId: source.id, upstreamId: 'native-model', alias: 'vscode-local-model', displayName: 'VS Code fixture', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const other = store.saveModel({ ...model, id: undefined, upstreamId: 'native-other', alias: 'vscode-other-model' });
  const before = store.listBindings().find(binding => binding.id === 'vscode')!;
  store.saveBinding({ ...before, enabled: true, vscodeProxyEnabled: true, mode: 'direct', providerIds: [source.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  const appData = join(home, 'appdata'), backups = join(home, 'backups'), targets = vsCodeConfigTargets(appData);
  const historyKey = vsCodeHistoryKey(targets.modelsPath);
  const manager = new ToolSyncUndoManager(store, { appData, homeDirectory: home });
  const apply = (plan: VsCodeProxyPlan = proxy) => applyConfig(store, 'vscode', 18181, appData, backups, home, { vscodeProxy: plan });
  const binding = () => store.listBindings().find(item => item.id === 'vscode')!;
  const history = () => store.getManagedState<unknown>(historyKey, null);
  const checkpoint = () => store.getManagedState<unknown>(toolSyncUndoKey('vscode'), null);
  const readModels = () => readFileSync(targets.modelsPath, 'utf8');
  const readSettings = () => readFileSync(targets.settingsPath, 'utf8');
  const restore = () => restoreOfficialConfig(store, 'vscode', appData, backups, home);
  return { home, store, source, model, other, before, appData, backups, targets, manager, apply, binding, history, checkpoint, readModels, readSettings, restore };
}

describe('VS Code proxy synchronization through public tool entry points', () => {
  it('undoes the model file, settings file, ownership and source selection as one operation', async () => {
    const f = await fixture();
    write(f.targets.modelsPath, originalModels); write(f.targets.settingsPath, originalSettings);
    const unrelatedBindings = f.store.listBindings().filter(binding => binding.id !== 'vscode');
    await f.manager.run('vscode', f.before, () => f.apply());
    const models = parseJsonc(f.readModels()), settings = parseJsonc(f.readSettings());
    expect(models[0]).toMatchObject({ vendor: 'copilot', name: 'Built-in' });
    expect(JSON.stringify(models)).toContain('https://vscode-fixture.invalid/v1/responses');
    expect(JSON.stringify(models)).not.toContain('127.0.0.1:18181');
    expect(settings).toEqual({ ...parseJsonc(originalSettings), 'http.proxy': proxy.proxyUrl });
    expect(f.readSettings()).toContain('// Keep the user network and editor preferences');
    expect(f.history()).not.toBeNull(); expect(f.manager.status('vscode').available).toBe(true);
    expect(await f.manager.undo('vscode')).toBe(f.targets.modelsPath);
    expect(f.readModels()).toBe(originalModels); expect(f.readSettings()).toBe(originalSettings);
    expect(f.binding()).toEqual(f.before); expect(f.history()).toBeNull(); expect(f.checkpoint()).toBeNull();
    expect(f.store.listBindings().filter(binding => binding.id !== 'vscode')).toEqual(unrelatedBindings);
  }, 30000);

  it('removes both newly created files on undo and reads the checkpoint after reopening the manager', async () => {
    const f = await fixture();
    await f.manager.run('vscode', f.before, () => f.apply());
    expect(existsSync(f.targets.modelsPath)).toBe(true); expect(existsSync(f.targets.settingsPath)).toBe(true);
    const reopened = new ToolSyncUndoManager(f.store, { appData: f.appData, homeDirectory: f.home });
    expect(reopened.status('vscode').available).toBe(true);
    await reopened.undo('vscode');
    expect(existsSync(f.targets.modelsPath)).toBe(false); expect(existsSync(f.targets.settingsPath)).toBe(false);
    expect(f.history()).toBeNull(); expect(f.binding()).toEqual(f.before);
  }, 30000);

  it('accepts a legacy model-only checkpoint without inspecting or changing newer user settings', async () => {
    const f = await fixture();
    write(f.targets.modelsPath, originalModels); write(f.targets.settingsPath, originalSettings);
    await f.manager.run('vscode', f.before, () => f.apply({ eligible: false }));
    const saved = f.checkpoint() as { beforeFiles: { path: string }[]; appliedFiles: { path: string }[]; beforeStates: unknown[]; appliedStates: unknown[] };
    f.store.setManagedState(toolSyncUndoKey('vscode'), { ...saved,
      beforeFiles: saved.beforeFiles.filter(file => file.path === f.targets.modelsPath),
      appliedFiles: saved.appliedFiles.filter(file => file.path === f.targets.modelsPath),
      beforeStates: [], appliedStates: [],
    });
    const userSettings = '{"http.proxy":"http://127.0.0.1:20999","editor.fontSize":17}\n';
    write(f.targets.settingsPath, userSettings);
    expect(f.manager.status('vscode').available).toBe(true);
    await f.manager.undo('vscode');
    expect(f.readModels()).toBe(originalModels); expect(f.readSettings()).toBe(userSettings);
    expect(f.binding()).toEqual(f.before); expect(f.checkpoint()).toBeNull();
  }, 30000);

  it('undoes its proxy field after an unrelated editor save without reverting the user edit', async () => {
    const f = await fixture();
    write(f.targets.modelsPath, originalModels); write(f.targets.settingsPath, originalSettings);
    await f.manager.run('vscode', f.before, () => f.apply());
    const userSettings = f.readSettings().replace('Dark Modern', 'Light Modern');
    write(f.targets.settingsPath, userSettings);
    expect(f.manager.status('vscode').available).toBe(true);
    await f.manager.undo('vscode');
    expect(f.readModels()).toBe(originalModels);
    expect(parseJsonc(f.readSettings())).toEqual({ ...parseJsonc(originalSettings), 'workbench.colorTheme': 'Light Modern' });
    expect(f.binding()).toEqual(f.before); expect(f.history()).toBeNull(); expect(f.checkpoint()).toBeNull();
  }, 30000);

  it('ignores even a stale eligible plan once opted out and releases its old value once', async () => {
    const f = await fixture();
    expect(f.before.vscodeProxyEnabled).not.toBe(true);
    write(f.targets.settingsPath, originalSettings); f.apply();
    f.store.saveBinding({ ...f.binding(), vscodeProxyEnabled: false });
    f.apply(proxy);
    expect(parseJsonc(f.readSettings())).toEqual(parseJsonc(originalSettings));
    expect(f.history()).toBeNull();
    write(f.targets.settingsPath, '{draft');
    f.apply(proxy); await f.restore();
    expect(f.readSettings()).toBe('{draft');
  }, 30000);

  it.each(['remove', 'aggregate'] as const)('restores an owned proxy when switching to %s, even with a stale eligible plan', async action => {
    const f = await fixture();
    write(f.targets.settingsPath, originalSettings); f.apply();
    if (action === 'remove') f.store.saveBinding({ ...f.binding(), enabled: false, providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '' });
    else f.store.saveBinding({ ...switchSingleEntryMode(f.binding(), 'aggregate', f.store.listModels(), f.store.listProviders()), enabled: true, providerIds: [f.source.id], modelIds: [f.model.id], modelSelection: 'selected', defaultModelId: f.model.id });
    f.apply(proxy);
    expect(parseJsonc(f.readSettings())).toEqual(parseJsonc(originalSettings));
    expect(f.readSettings()).toContain('// Keep the user network and editor preferences');
    expect(f.history()).toBeNull();
    if (action === 'remove') expect(parseJsonc(f.readModels())).toEqual([]);
    else {
      expect(f.readModels()).toContain('http://127.0.0.1:18181/tool/vscode/v1/responses');
      expect(f.readModels()).not.toContain('https://vscode-fixture.invalid');
    }
  }, 30000);

  it('restores an explicitly empty original proxy through official restore while preserving later editor edits', async () => {
    const f = await fixture();
    write(f.targets.modelsPath, originalModels);
    write(f.targets.settingsPath, '{\n  // An explicit empty value differs from an absent setting\n  "http.proxy": "",\n  "editor.fontSize": 14\n}\n');
    f.apply();
    write(f.targets.settingsPath, f.readSettings().replace('"editor.fontSize": 14', '"editor.fontSize": 17'));
    expect(await f.restore()).toBe(f.targets.modelsPath);
    expect(parseJsonc(f.readModels())).toEqual([{ vendor: 'copilot', name: 'Built-in' }]);
    expect(parseJsonc(f.readSettings())).toEqual({ 'http.proxy': '', 'editor.fontSize': 17 });
    expect(f.readSettings()).toContain('// An explicit empty value differs from an absent setting');
    expect(f.history()).toBeNull();
  }, 30000);

  it.each(['existing', 'edited', 'cleared', 'deleted'] as const)('preserves a user-owned %s proxy through repeated sync and official restore', async kind => {
    const f = await fixture();
    const userProxy = 'http://127.0.0.1:20999';
    if (kind === 'existing') write(f.targets.settingsPath, JSON.stringify({ 'http.proxy': userProxy, 'editor.fontSize': 17 }));
    else {
      write(f.targets.settingsPath, originalSettings); f.apply();
      if (kind === 'deleted') {
        const settings = parseJsonc(f.readSettings()); delete settings['http.proxy'];
        write(f.targets.settingsPath, JSON.stringify(settings));
      } else write(f.targets.settingsPath, f.readSettings().replace(proxy.proxyUrl!, kind === 'cleared' ? '' : userProxy));
    }
    const userSettings = f.readSettings();
    f.apply(); f.apply(); expect(f.readSettings()).toBe(userSettings);
    if (kind === 'existing') expect(f.history()).toBeNull();
    else { expect(f.history()).toMatchObject({ proxyOverride: true }); expect(f.history()).not.toHaveProperty('proxy'); }
    await f.restore();
    expect(f.readSettings()).toBe(userSettings); expect(f.history()).toBeNull();
  }, 30000);

  it('rolls the first file back if writing the second file fails during public apply', async () => {
    const f = await fixture();
    write(f.targets.modelsPath, originalModels); write(f.targets.settingsPath, originalSettings);
    const replace = privateFiles.replacePrivateFile;
    let failOnce = true, sawCommittedModels = false;
    vi.spyOn(privateFiles, 'replacePrivateFile').mockImplementation((path, content) => {
      if (path === f.targets.settingsPath && failOnce) {
        failOnce = false; sawCommittedModels = f.readModels() !== originalModels;
        throw new Error('Synthetic VS Code settings write failure');
      }
      replace(path, content);
    });
    await expect(f.manager.run('vscode', f.before, () => f.apply())).rejects.toThrow('Synthetic VS Code settings write failure');
    expect(sawCommittedModels).toBe(true);
    expect(f.readModels()).toBe(originalModels); expect(f.readSettings()).toBe(originalSettings);
    expect(f.history()).toBeNull(); expect(f.checkpoint()).toBeNull();
    await f.manager.run('vscode', f.before, () => f.apply());
    expect(f.manager.status('vscode').available).toBe(true); expect(parseJsonc(f.readSettings())['http.proxy']).toBe(proxy.proxyUrl);
  }, 30000);

  it('rolls a partial undo back after a settings write failure and retains a usable retry', async () => {
    const f = await fixture();
    write(f.targets.modelsPath, originalModels); write(f.targets.settingsPath, originalSettings);
    await f.manager.run('vscode', f.before, () => f.apply());
    const models = f.readModels(), settings = f.readSettings(), ownership = f.history(), checkpoint = f.checkpoint(), binding = f.binding();
    let failOnce = true, sawRestoredModels = false;
    const failing = new ToolSyncUndoManager(f.store, { appData: f.appData, homeDirectory: f.home, replaceFile: (path, content) => {
      if (path === f.targets.settingsPath && failOnce) {
        failOnce = false; sawRestoredModels = f.readModels() === originalModels;
        throw new Error('Synthetic VS Code undo settings write failure');
      }
      privateFiles.replacePrivateFile(path, content);
    } });
    await expect(failing.undo('vscode')).rejects.toThrow('撤销未完成');
    expect(sawRestoredModels).toBe(true);
    expect(f.readModels()).toBe(models); expect(f.readSettings()).toBe(settings);
    expect(f.history()).toEqual(ownership); expect(f.checkpoint()).toEqual(checkpoint); expect(f.binding()).toEqual(binding);
    expect(failing.status('vscode').available).toBe(true);
    await failing.undo('vscode');
    expect(f.readModels()).toBe(originalModels); expect(f.readSettings()).toBe(originalSettings);
    expect(f.history()).toBeNull(); expect(f.checkpoint()).toBeNull(); expect(f.binding()).toEqual(f.before);
  }, 30000);
});
