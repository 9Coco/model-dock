import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isDeepStrictEqual } from 'node:util';
import type { Store } from './store';
import type { Model, Provider, Snapshot, ToolBinding, ToolId } from '../shared/types';

/** Inline selections and explicit client writes in isolated fixture profiles only. */
export async function verifyToolSelection(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream, 'Tool selection smoke requires explicit fixture isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const fixturePath = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !/^[A-Za-z]:/.test(fixturePath), 'Tool smoke data must be below the fixture directory');
  const mockUrl = new URL(upstream); assert.equal(mockUrl.protocol, 'http:'); assert.equal(mockUrl.hostname, '127.0.0.1');
  assert.ok(mockUrl.port && !mockUrl.username && !mockUrl.password && !mockUrl.search && !mockUrl.hash);
  mockUrl.pathname = '/v1';
  const baseUrl = mockUrl.href.replace(/\/$/, '');
  const featureHome = join(dataDir, 'feature-home'), featureAppData = join(dataDir, 'feature-appdata');
  const vscodeFile = join(featureAppData, 'Code', 'User', 'chatLanguageModels.json');
  const openCodeFile = join(featureHome, '.config', 'opencode', 'opencode.json');
  const codexFile = join(featureHome, '.codex', 'config.toml');
  const codexCatalog = join(featureHome, '.codex', 'modeldock-models.json');
  const foreignCodexCatalog = join(featureHome, '.codex', 'foreign-models.json');
  const backupDir = join(dataDir, 'backups');
  for (const path of [vscodeFile, openCodeFile, codexFile, codexCatalog, foreignCodexCatalog, backupDir]) {
    const child = relative(resolve(dataDir), resolve(path));
    assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child), 'Every applied fixture path must stay below the isolated database');
  }
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'electron-tool-selection-timeout.png'), await captureUi());
    const state = await evaluate(`(()=>{const summary=document.querySelector('[data-tool-binding]'),status=document.querySelector('[data-tool-application-status]');return {label:${JSON.stringify(label)},tool:summary?.dataset.toolBinding,providerCount:summary?.dataset.selectedProviderCount,modelCount:summary?.dataset.selectedModelCount,state:status?.dataset.toolApplicationState,status:status?.textContent,error:document.querySelector('[data-tool-sync-error]')?.textContent,applyDisabled:document.querySelector('[data-action="apply-tool-config"]')?.disabled};})()`);
    writeFileSync(join(outputDir, 'tool-selection-timeout.json'), JSON.stringify(state, null, 2));
    throw new Error(`Inline tool smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function navigate(tool: ToolId): Promise<void> {
    await click(`[data-page="tools"][data-tool-id="${tool}"]`);
    await waitFor(`!!document.querySelector('[data-tool-binding="${tool}"]')`, `${tool} inline selection summary`);
  }
  async function setSearch(value: string): Promise<void> {
    await evaluate(`(()=>{const input=document.querySelector('[aria-label="搜索供应商"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('[aria-label="搜索供应商"]')?.value===${JSON.stringify(value)}`, 'source search settled');
  }
  async function storedBinding(tool: ToolId): Promise<ToolBinding> {
    const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
    const binding = snapshot.bindings.find(item => item.id === tool); assert.ok(binding); return binding;
  }
  function appliedPath(tool: ToolId): string {
    if (tool === 'vscode') return vscodeFile;
    if (tool === 'opencode') return openCodeFile;
    if (tool === 'codex') return codexFile;
    throw new Error('Automatic fixture writes are restricted to supported tools');
  }
  async function waitApplied(tool: ToolId, expectedPath: string, label: string): Promise<void> {
    await waitFor(`(()=>{const summary=document.querySelector('[data-tool-binding="${tool}"]'),status=document.querySelector('[data-tool-application-status]');return status?.dataset.toolApplicationState===(summary?.dataset.selectedModelCount==='0'?'cleared':'synced')&&!document.querySelector('[data-action="apply-tool-config"]').disabled;})()`, label);
    const displayed = await evaluate<string>(`document.querySelector('.tool-inline-delivery code')?.textContent??''`);
    assert.equal(resolve(displayed), resolve(expectedPath), 'Native write must target the isolated feature profile');
    assert.ok(existsSync(expectedPath));
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Automatic write must finish on the tool page');
  }
  function assertAutomaticGroups(tool: ToolId, expectedIds: string[]): void {
    if (tool === 'vscode') {
      const rows = readJsonc(vscodeFile) as any[];
      const actualNames = rows.filter(row => row.vendor === 'customendpoint' && typeof row.name === 'string' && (row.name === 'ModelDock' || row.name.startsWith('ModelDock · '))).map(row => row.name);
      const expectedNames = expectedIds.length === 1 ? ['ModelDock'] : expectedIds.map(id => `ModelDock · ${store.getProvider(id)!.name}`);
      assert.deepEqual(new Set(actualNames), new Set(expectedNames), 'Checkbox change must immediately write precisely its selected provider groups');
    } else if (tool === 'opencode') {
      const providers = readJsonc(openCodeFile).provider;
      assert.deepEqual(new Set(Object.keys(providers).filter(id => id === 'modeldock' || id.startsWith('modeldock-'))), new Set(expectedIds.length === 1 ? ['modeldock'] : expectedIds.map(id => `modeldock-${encodeURIComponent(id)}`)), 'OpenCode checkbox change must immediately update selected provider endpoints');
    } else if (tool === 'codex') {
      const config = parseToml(readFileSync(codexFile, 'utf8')) as any;
      if (expectedIds.length === 0) {
        assert.equal(config.model_provider, 'foreign'); assert.equal(config.model, 'foreign-original');
        assert.equal(resolve(config.model_catalog_json), resolve(foreignCodexCatalog));
        assert.equal(config.model_providers?.modeldock, undefined); assert.equal(existsSync(codexCatalog), false);
        return;
      }
      assert.equal(config.model_provider, 'modeldock');
      const base = new URL(config.model_providers.modeldock.base_url);
      assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:');
      assert.equal(base.pathname, store.listBindings().find(binding => binding.id === 'codex')?.mode !== 'aggregate' && expectedIds.length === 1 && store.getProvider(expectedIds[0])?.kind === 'openai-compatible' ? '/v1' : '/tool/codex/v1');
    }
  }
  async function resetBinding(tool: ToolId): Promise<void> {
    const current = await storedBinding(tool);
    await evaluate(`window.modelDock.saveBinding(${JSON.stringify({ ...current, mode: 'auto', modelSelection: undefined, enabled: false, providerIds: [], modelIds: [], defaultModelId: '' })})`);
    await click('[aria-label="刷新本机配置"]');
    await navigate(tool);
    await waitFor(`document.querySelector('[data-tool-binding="${tool}"]')?.dataset.selectedProviderCount==='0'`, 'empty inline binding refreshed');
  }
  async function selectProvider(tool: ToolId, providerId: string, selected: boolean): Promise<void> {
    const before = await storedBinding(tool);
    const expectedMode = tool === 'codex' && before.mode === 'aggregate' ? 'aggregate' : 'direct';
    const expected = selected ? tool === 'codex' && expectedMode === 'direct' ? [providerId] : [...new Set([...(before.providerIds ?? []), providerId])] : (before.providerIds ?? []).filter(id => id !== providerId);
    const selector = `article[data-provider-id="${providerId}"] input[data-action="select-tool-provider"]`;
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)})?.checked`), !selected, 'Fixture must exercise an actual checkbox change');
    await click(selector);
    await waitFor(`(async()=>{
      const snapshot=await window.modelDock.snapshot(),binding=snapshot.bindings.find(item=>item.id==='${tool}'),checkbox=document.querySelector(${JSON.stringify(selector)});
      return binding.mode==='${expectedMode}'&&JSON.stringify(binding.providerIds)===${JSON.stringify(JSON.stringify(expected))}&&(binding.modelSelection==='selected'||binding.modelIds.length===0)&&checkbox?.checked===${selected}&&!checkbox.disabled&&document.querySelector('[data-tool-binding="${tool}"]')?.dataset.selectedProviderCount==='${expected.length}';
    })()`, `${tool} checkbox persisted provider selection`);
    await waitApplied(tool, appliedPath(tool), `${tool} checkbox automatically writes its tool configuration`);
    assertAutomaticGroups(tool, expected);
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Checkbox selection must not require a framework dialog');
  }
  async function chooseDefault(tool: ToolId, modelId: string): Promise<void> {
    await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(modelId)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='${tool}');return binding.defaultModelId===${JSON.stringify(modelId)}&&document.querySelector('[data-action="tool-default-model"]')?.value===${JSON.stringify(modelId)}&&!document.querySelector('[data-action="tool-default-model"]').disabled;})()`, 'inline default model persisted');
    await waitApplied(tool, appliedPath(tool), `${tool} default selection automatically writes its configuration`);
    if (tool === 'opencode') {
      const chosen = store.listModels().find(model => model.id === modelId); assert.ok(chosen);
      assert.equal(readJsonc(openCodeFile).model, `modeldock-${encodeURIComponent(chosen.providerId)}/${chosen.upstreamId}`);
    } else if (tool === 'codex') {
      const chosen = store.listModels().find(model => model.id === modelId); assert.ok(chosen);
      const current = await storedBinding(tool);
      assert.equal((parseToml(readFileSync(codexFile, 'utf8')) as any).model, current.mode !== 'aggregate' && current.providerIds?.length === 1 && store.getProvider(chosen.providerId)?.kind === 'openai-compatible' ? chosen.upstreamId : chosen.alias);
    }
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false);
  }
  async function preview(tool: ToolId): Promise<string> {
    await click('[data-action="preview-tool-config"]');
    await waitFor(`!!document.querySelector('[role="dialog"] .config-code')`, `${tool} explicit preview`);
    const content = await evaluate<string>(`document.querySelector('[role="dialog"] .config-code').textContent`);
    assert.doesNotMatch(content, /synthetic-tool-one|synthetic-tool-two|MOCK_ACCESS|MOCK_REFRESH|SYNTHETIC_FOREIGN/);
    await click('[aria-label="关闭对话框"]'); await waitFor(`!document.querySelector('[role="dialog"]')`, 'config preview closed');
    return content;
  }
  async function apply(tool: ToolId, expectedPath: string): Promise<void> {
    assert.ok(existsSync(expectedPath), 'Checkbox/default selection must have applied configuration before any manual retry');
    const before = tool === 'codex' ? parseToml(readFileSync(expectedPath, 'utf8')) : readJsonc(expectedPath);
    await click('[data-action="apply-tool-config"]');
    await pause(75); await waitApplied(tool, expectedPath, `${tool} manual resynchronization`);
    const after = tool === 'codex' ? parseToml(readFileSync(expectedPath, 'utf8')) : readJsonc(expectedPath);
    assert.ok(isDeepStrictEqual(before, after), 'Manual retry must preserve the already applied configuration semantics');
  }
  function readJsonc(path: string): any {
    const errors: ParseError[] = [], parsed = parseJsonc(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
    assert.equal(errors.length, 0, 'Applied fixture must remain valid JSONC'); return parsed;
  }
  function assertForeignPreserved(actual: unknown, expected: unknown): void {
    // Keep fixture credentials out of assertion diffs as well as artifacts.
    assert.ok(isDeepStrictEqual(actual, expected), 'Unmanaged fixture configuration must remain intact');
  }
  async function assertNoRendererCredentials(): Promise<void> {
    const text = await evaluate<string>('document.body.innerText');
    assert.doesNotMatch(text, /synthetic-tool-one|synthetic-tool-two|MOCK_ACCESS|MOCK_REFRESH|SYNTHETIC_FOREIGN/);
  }
  const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()'); assert.equal(resolve(snapshot.dataDir), resolve(dataDir));
  assert.equal(snapshot.bindings.find(binding => binding.id === 'vscode')?.vscodeSyncScope, 'selected', 'VS Code must default to publishing only selected custom suppliers');
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'earlier authorization dialog closed');
  const apiProviders: Provider[] = [], fixtureModels: Model[] = [];
  for (const [index, name] of ['工具勾选回归 A', '工具勾选回归 B'].entries()) {
    const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name, kind: 'openai-compatible', presetId: 'custom', baseUrl, enabled: true, apiKey: index === 0 ? 'synthetic-tool-one' : 'synthetic-tool-two' })})`);
    assert.ok(provider.hasSecret); apiProviders.push(provider);
    for (const [upstreamId, displayName] of [['mock-tool-first', '第一个模型'], ['mock-tool-second', '第二个模型']]) {
      fixtureModels.push(await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: provider.id, upstreamId, alias: upstreamId, displayName, wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true })})`));
    }
  }
  assert.equal(new Set(fixtureModels.map(model => model.alias)).size, 4, 'Identical upstream names across sources need distinct gateway aliases');
  const secondDefault = fixtureModels.find(model => model.providerId === apiProviders[1].id && model.upstreamId === 'mock-tool-second'); assert.ok(secondDefault);
  await click('[aria-label="刷新本机配置"]');

  mkdirSync(dirname(vscodeFile), { recursive: true });
  const foreignVsCode = { name: 'Foreign fixture', vendor: 'customendpoint', apiKey: 'SYNTHETIC_FOREIGN', models: [{ id: 'foreign-model', name: 'Foreign', apiType: 'responses', url: 'https://foreign.example.test/v1/responses' }], keep: { enabled: true } };
  writeFileSync(vscodeFile, `[
  // foreign-vscode-comment must survive managed source updates
  ${JSON.stringify(foreignVsCode)},
]`, { mode: 0o600 });
  const legacyDefaultModels = [fixtureModels[0], secondDefault];
  const legacyModelIds = legacyDefaultModels.map(model => model.id);
  const legacySourceIds = apiProviders.map(provider => provider.id);
  const legacyBinding = { ...await storedBinding('vscode'), mode: 'aggregate', enabled: true, providerIds: legacySourceIds, modelIds: legacyModelIds, defaultModelId: legacyDefaultModels[0].id, vscodeSyncScope: 'managed' };
  await evaluate(`window.modelDock.saveBinding(${JSON.stringify(legacyBinding)})`);
  await click('[aria-label="刷新本机配置"]'); await navigate('vscode'); await setSearch('工具勾选回归');
  await waitFor(`document.querySelector('[data-tool-binding="vscode"]')?.dataset.selectedModelCount==='2'&&document.querySelector('[data-action="tool-default-model"]')?.value===${JSON.stringify(legacyDefaultModels[0].id)}`, 'legacy partial model selection visible');
  await chooseDefault('vscode', secondDefault.id);
  const legacyAfterDefault = await storedBinding('vscode');
  assert.equal(legacyAfterDefault.mode, 'aggregate', 'Changing only the default must retain the legacy connection mode');
  assert.deepEqual(legacyAfterDefault.providerIds, legacySourceIds, 'Changing only the default must retain selected sources');
  assert.deepEqual(legacyAfterDefault.modelIds, legacyModelIds, 'Changing only the default must not widen the legacy explicit model filter');
  const legacyRows = readJsonc(vscodeFile) as any[];
  const legacyManaged = legacyRows.filter(row => row.vendor === 'customendpoint' && row.name === 'ModelDock');
  assert.equal(legacyManaged.length, 1, 'Legacy aggregate mode must keep one managed endpoint until a provider checkbox edit');
  assert.deepEqual(new Set(legacyManaged[0].models.map((model: any) => model.id)), new Set(legacyDefaultModels.map(model => model.alias)), 'Default-only automatic write must publish exactly the legacy selected model aliases');
  assert.equal(legacyManaged[0].models.length, 2, 'The unselected models from those providers must remain absent');
  assertForeignPreserved(legacyRows.find(row => row.name === foreignVsCode.name), foreignVsCode);
  const legacyDefaultValidation = { mode: legacyAfterDefault.mode, explicitModelIds: legacyAfterDefault.modelIds, selectedModels: legacyManaged[0].models.length, defaultModelId: legacyAfterDefault.defaultModelId, modelFilterPreserved: true, providerSelectionPreserved: true, automaticDefaultWrite: true };
  const temporaryLegacyModel = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: apiProviders[0].id, upstreamId: 'mock-legacy-temporary', alias: 'mock-legacy-temporary', displayName: '待删除的旧范围模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true })})`);
  await evaluate(`window.modelDock.saveBinding(${JSON.stringify({ ...legacyAfterDefault, enabled: true, providerIds: [apiProviders[0].id], modelIds: [temporaryLegacyModel.id], defaultModelId: temporaryLegacyModel.id })})`);
  await evaluate(`window.modelDock.deleteModel(${JSON.stringify(temporaryLegacyModel.id)})`);
  const disabledLegacy = await storedBinding('vscode');
  assert.equal(disabledLegacy.enabled, false); assert.deepEqual(disabledLegacy.providerIds, [apiProviders[0].id]); assert.deepEqual(disabledLegacy.modelIds, []); assert.equal(disabledLegacy.defaultModelId, '');
  assert.equal(store.listModels().filter(model => model.providerId === apiProviders[0].id && model.enabled).length, 2, 'Other unselected models must remain available to expose accidental widening');
  await click('[aria-label="刷新本机配置"]'); await navigate('vscode'); await setSearch('工具勾选回归');
  await waitFor(`document.querySelector('[data-tool-binding="vscode"]')?.dataset.selectedModelCount==='0'&&document.querySelector('[data-action="tool-default-model"]')?.disabled`, 'deleted legacy scope must stay unavailable');
  const beforeDisabledPreview = readFileSync(vscodeFile, 'utf8');
  assert.deepEqual(JSON.parse(await preview('vscode')), [], 'Disabled legacy scope preview must not publish the other provider models');
  assert.ok(readFileSync(vscodeFile, 'utf8') === beforeDisabledPreview, 'Preview must not change the existing native configuration');
  const afterDisabledPreview = await storedBinding('vscode');
  assert.deepEqual(afterDisabledPreview, disabledLegacy, 'Preview must not reactivate a legacy binding whose last scoped model was deleted');
  await click('[data-action="apply-tool-config"]');
  await waitApplied('vscode', vscodeFile, 'disabled legacy retry must not expand its source scope');
  assert.deepEqual(await storedBinding('vscode'), disabledLegacy, 'Manual retry must keep the disabled legacy binding intact');
  assertForeignPreserved(readJsonc(vscodeFile), [foreignVsCode]);
  const legacyDisabledValidation = { lastScopedModelDeleted: true, remainingUnselectedModels: 2, disabledBindingPreserved: true, previewPublishedModels: 0, previewDidNotWrite: true, manualRetryDidNotExpand: true };
  await resetBinding('vscode'); await setSearch('工具勾选回归');
  await selectProvider('vscode', apiProviders[0].id, true); await selectProvider('vscode', apiProviders[1].id, true); await chooseDefault('vscode', secondDefault.id);
  const vscodePreview = JSON.parse(await preview('vscode'));
  assert.equal(vscodePreview.length, 2); assert.ok(vscodePreview.every((row: any) => row.vendor === 'customendpoint'));
  await apply('vscode', vscodeFile);
  const vscodeBoth = readJsonc(vscodeFile) as any[];
  assert.equal(vscodeBoth.length, 3); assertForeignPreserved(vscodeBoth.find(row => row.name === foreignVsCode.name), foreignVsCode);
  assert.ok(readFileSync(vscodeFile, 'utf8').includes('foreign-vscode-comment'));
  for (const [index, provider] of apiProviders.entries()) {
    const group = vscodeBoth.find(row => row.name === `ModelDock · ${provider.name}`); assert.ok(group);
    assert.ok(group.apiKey === (index === 0 ? 'synthetic-tool-one' : 'synthetic-tool-two'), 'Each native group must retain its own fixture API credential');
    assert.deepEqual(group.models.map((model: any) => model.id), ['mock-tool-first', 'mock-tool-second']);
    assert.ok(group.models.every((model: any) => model.url === `${baseUrl}/responses`));
  }
  const appliedVscodeBinding = await storedBinding('vscode');
  assert.deepEqual(appliedVscodeBinding.providerIds, apiProviders.map(provider => provider.id)); assert.equal(appliedVscodeBinding.defaultModelId, secondDefault.id);
  await assertNoRendererCredentials();
  const layouts: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    await click('[data-page="settings"]'); await click(`[data-theme-choice="${theme}"]`);
    await waitFor(`document.documentElement.dataset.theme==='${theme}'`, 'native theme applied');
    await navigate('vscode'); await setSearch('工具勾选回归');
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await waitFor(width > 1100 ? 'innerWidth>1100' : 'innerWidth<1100', 'inline selection viewport');
      await evaluate(`document.querySelector('.main-content').scrollTop=0`); await pause(75);
      const layout = await evaluate<{ controlsVisible: boolean; checkboxesVisible: boolean; mainOverflow: boolean; modal: boolean; selectedCount: number; modelCount: number }>(`(()=>{
        const summary=document.querySelector('[data-tool-binding="vscode"]'),main=document.querySelector('.main-content'),controls=summary.querySelector('.tool-inline-controls');
        const inside=element=>{const bounds=element.getBoundingClientRect();return bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth+1&&bounds.bottom<=innerHeight+1;};
        const checkboxes=Array.from(document.querySelectorAll('article[data-provider-id] input[data-action="select-tool-provider"]'));
        return {controlsVisible:inside(controls),checkboxesVisible:checkboxes.length===2&&checkboxes.every(input=>inside(input)&&input.checked),mainOverflow:main.scrollWidth>main.clientWidth+1,modal:!!document.querySelector('[role="dialog"]'),selectedCount:Number(summary.dataset.selectedProviderCount),modelCount:Number(summary.dataset.selectedModelCount)};
      })()`);
      assert.equal(layout.controlsVisible, true); assert.equal(layout.checkboxesVisible, true); assert.equal(layout.mainOverflow, false); assert.equal(layout.modal, false); assert.equal(layout.selectedCount, 2); assert.equal(layout.modelCount, 4);
      layouts.push({ theme, width, ...layout });
      writeFileSync(join(outputDir, `electron-tool-inline-vscode-${theme}-${width}.png`), await captureUi());
    }
  }
  await selectProvider('vscode', apiProviders[0].id, false);
  assert.equal(await evaluate<string>(`document.querySelector('[data-tool-application-status]').textContent`), '本次选择已同步');
  await apply('vscode', vscodeFile);
  const vscodeRemaining = readJsonc(vscodeFile) as any[];
  assert.equal(vscodeRemaining.length, 2); assert.ok(vscodeRemaining.some(row => row.name === 'ModelDock')); assertForeignPreserved(vscodeRemaining.find(row => row.name === foreignVsCode.name), foreignVsCode);
  await selectProvider('vscode', apiProviders[1].id, false); await apply('vscode', vscodeFile);
  assertForeignPreserved(readJsonc(vscodeFile), [foreignVsCode]); assert.ok(readFileSync(vscodeFile, 'utf8').includes('foreign-vscode-comment'));

  const builtInVendor = { name: 'ModelDock', vendor: 'openai', models: [{ id: 'built-in-fixture', name: 'Built-in vendor fixture' }], keep: true };
  const staleCustomGroups = ['千问 Token Plan', '火山方舟 Coding Plan', '火山引擎agent plan', 'OpenAI / CLIProxyAPI'].map((name, index) => ({ name, vendor: 'customendpoint', apiKey: 'SYNTHETIC_FOREIGN', models: [{ id: 'shared-legacy-id', name: `${name} legacy fixture`, url: `https://foreign-${index}.example.test/v1/chat/completions` }] }));
  writeFileSync(vscodeFile, `[
  // exclusive-scope-comment must survive old group cleanup
  ${JSON.stringify(builtInVendor)},
  ${staleCustomGroups.map(group => JSON.stringify(group)).join(',\n')},
]`, { mode: 0o600 });
  await selectProvider('vscode', apiProviders[0].id, true);
  const beforeScopeChange = await storedBinding('vscode');
  assert.equal(beforeScopeChange.vscodeSyncScope, 'managed');
  assert.equal((readJsonc(vscodeFile) as any[]).length, 6, 'Explicit managed scope must preserve all legacy custom sources');
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="vscode-only-selected"]')?.checked`), false);
  await click('[data-action="vscode-only-selected"]');
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='vscode');return binding.vscodeSyncScope==='selected'&&document.querySelector('[data-action="vscode-only-selected"]')?.checked&&!document.querySelector('[data-action="vscode-only-selected"]').disabled;})()`, 'exclusive source scope saved');
  await waitApplied('vscode', vscodeFile, 'exclusive source scope automatically cleans old client groups');
  const afterScopeChange = await storedBinding('vscode');
  assert.deepEqual({ ...afterScopeChange, vscodeSyncScope: 'managed' }, beforeScopeChange, 'Scope toggle must preserve providers, model filters, mode, default and enabled state');
  const exclusiveRows = readJsonc(vscodeFile) as any[];
  assert.equal(exclusiveRows.length, 2); assertForeignPreserved(exclusiveRows.find(row => row.vendor === 'openai'), builtInVendor);
  const exclusiveCustom = exclusiveRows.filter(row => row.vendor === 'customendpoint');
  assert.equal(exclusiveCustom.length, 1); assert.equal(exclusiveCustom[0].name, 'ModelDock');
  assert.deepEqual(exclusiveCustom[0].models.map((model: any) => model.id), ['mock-tool-first', 'mock-tool-second']);
  assert.ok(exclusiveCustom[0].apiKey === 'synthetic-tool-one', 'The selected source must keep its own credential');
  assert.ok(readFileSync(vscodeFile, 'utf8').includes('exclusive-scope-comment'));
  await apply('vscode', vscodeFile);
  writeFileSync(join(outputDir, 'electron-tool-vscode-only-selected-dark-980.png'), await captureUi());
  await selectProvider('vscode', apiProviders[0].id, false);
  assertForeignPreserved(readJsonc(vscodeFile), [builtInVendor]);
  assert.ok(readFileSync(vscodeFile, 'utf8').includes('exclusive-scope-comment'));
  const vscodeExclusiveValidation = { defaultScope: 'selected', explicitManagedScopePreservedLegacyGroups: true, toggleAutomaticallyApplies: true, scopeChangePreservedBinding: true, legacyCustomGroupsRemoved: staleCustomGroups.length, selectedCustomGroups: exclusiveCustom.length, selectedModels: exclusiveCustom[0].models.length, otherVendorPreserved: true, commentsPreserved: true, manualRetryIdempotent: true, emptySelectionClearedCustomGroups: true };
  writeFileSync(join(outputDir, 'vscode-exclusive-validation.json'), JSON.stringify(vscodeExclusiveValidation, null, 2));

  mkdirSync(dirname(openCodeFile), { recursive: true });
  const foreignOpenCode = { name: 'Foreign fixture', npm: '@ai-sdk/openai', options: { apiKey: 'SYNTHETIC_FOREIGN', baseURL: 'https://foreign.example.test/v1' }, models: { foreign: { name: 'Foreign' } } };
  const foreignMcp = { fixture: { type: 'local', command: ['synthetic-mcp-fixture'], enabled: false } };
  writeFileSync(openCodeFile, `{
  // foreign-opencode-comment must survive managed source updates
  "model":"foreign/foreign",
  "provider":{"foreign":${JSON.stringify(foreignOpenCode)}},
  "mcp":${JSON.stringify(foreignMcp)},
}`, { mode: 0o600 });
  await resetBinding('opencode'); await setSearch('工具勾选回归');
  await selectProvider('opencode', apiProviders[0].id, true); await selectProvider('opencode', apiProviders[1].id, true); await chooseDefault('opencode', secondDefault.id);
  const openCodePreview = JSON.parse(await preview('opencode')); assert.equal(Object.keys(openCodePreview.provider).length, 2);
  await apply('opencode', openCodeFile);
  const openCodeBoth = readJsonc(openCodeFile);
  assertForeignPreserved(openCodeBoth.provider.foreign, foreignOpenCode); assert.deepEqual(openCodeBoth.mcp, foreignMcp);
  for (const [index, provider] of apiProviders.entries()) {
    const group = openCodeBoth.provider[`modeldock-${encodeURIComponent(provider.id)}`]; assert.ok(group);
    assert.ok(group.options.apiKey === (index === 0 ? 'synthetic-tool-one' : 'synthetic-tool-two'), 'OpenCode groups must retain independent fixture credentials');
    assert.equal(group.options.baseURL, baseUrl); assert.deepEqual(Object.keys(group.models), ['mock-tool-first', 'mock-tool-second']);
  }
  assert.equal(openCodeBoth.model, `modeldock-${encodeURIComponent(apiProviders[1].id)}/mock-tool-second`);
  await selectProvider('opencode', apiProviders[0].id, false); await selectProvider('opencode', apiProviders[1].id, false); await apply('opencode', openCodeFile);
  const openCodeCleared = readJsonc(openCodeFile);
  assertForeignPreserved(openCodeCleared.provider, { foreign: foreignOpenCode }); assert.deepEqual(openCodeCleared.mcp, foreignMcp); assert.equal(openCodeCleared.model, undefined);
  assert.ok(readFileSync(openCodeFile, 'utf8').includes('foreign-opencode-comment'));

  const mockSubscription = store.listProviders().find(provider => provider.name === '等待授权回归测试' && provider.kind === 'codex');
  assert.ok(mockSubscription?.hasSecret && mockSubscription.authStatus === 'ready', 'Native mock Codex authorization must run before tool selection');
  const subscriptionModels = store.listModels().filter(model => model.providerId === mockSubscription.id && model.enabled);
  assert.equal(subscriptionModels.length, 1);
  mkdirSync(dirname(codexFile), { recursive: true });
  const originalCodexCatalog = JSON.stringify({ models: [{ slug: 'foreign-original', display_name: 'Original native fixture', visibility: 'list', context_window: 64000 }] }, null, 2);
  writeFileSync(foreignCodexCatalog, originalCodexCatalog, { mode: 0o600 });
  writeFileSync(codexFile, `model = "foreign-original"
model_provider = "foreign"
model_catalog_json = ${JSON.stringify(foreignCodexCatalog)}
[model_providers.foreign]
name = "Foreign fixture"
base_url = "https://foreign.example.test/v1"
wire_api = "responses"
[mcp_servers.fixture]
command = "synthetic-mcp-fixture"
`, { mode: 0o600 });
  await resetBinding('codex');
  await click('[data-action="tool-use-aggregate"]');
  await waitFor(`document.querySelector('[data-tool-binding="codex"]')?.dataset.connectionMode==='aggregate'&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled`, 'explicit Codex aggregate mode persisted');
  await selectProvider('codex', apiProviders[0].id, true); await selectProvider('codex', apiProviders[1].id, true); await selectProvider('codex', mockSubscription.id, true); await chooseDefault('codex', secondDefault.id);
  const codexPreview = parseToml(await preview('codex'));
  assert.equal(codexPreview.model_provider, 'modeldock'); assert.equal(codexPreview.model, secondDefault.alias);
  await apply('codex', codexFile);
  const codexApplied = parseToml(readFileSync(codexFile, 'utf8')) as any;
  const after = await evaluate<Snapshot>('window.modelDock.snapshot()'); assert.ok(after.gateway.running);
  assert.equal(codexApplied.model_provider, 'modeldock'); assert.equal(codexApplied.model, secondDefault.alias);
  assert.equal(codexApplied.model_providers.modeldock.base_url, `http://127.0.0.1:${after.gateway.port}/tool/codex/v1`);
  assert.equal(codexApplied.model_providers.modeldock.wire_api, 'responses'); assert.equal(codexApplied.model_providers.modeldock.requires_openai_auth, false);
  assert.ok(typeof codexApplied.model_providers.modeldock.experimental_bearer_token === 'string');
  assert.doesNotMatch(codexApplied.model_providers.modeldock.experimental_bearer_token, /synthetic-tool-one|synthetic-tool-two|MOCK_ACCESS|MOCK_REFRESH/);
  assert.equal(codexApplied.model_providers.foreign.name, 'Foreign fixture'); assert.equal(codexApplied.mcp_servers.fixture.command, 'synthetic-mcp-fixture');
  assert.equal(resolve(codexApplied.model_catalog_json), resolve(codexCatalog));
  const catalog = JSON.parse(readFileSync(codexCatalog, 'utf8'));
  assert.deepEqual(new Set(catalog.models.map((model: any) => model.slug)), new Set([...fixtureModels, ...subscriptionModels].map(model => model.alias)));
  assert.equal(catalog.models.length, 5, 'Codex publishes all selected Responses aliases through its single endpoint');
  const finalCodexBinding = await storedBinding('codex'); assert.equal(finalCodexBinding.mode, 'aggregate'); assert.equal(finalCodexBinding.modelSelection, 'selected'); assert.deepEqual(finalCodexBinding.providerIds, [...apiProviders.map(provider => provider.id), mockSubscription.id]);
  await assertNoRendererCredentials(); await setSearch('工具勾选回归');
  writeFileSync(join(outputDir, 'electron-tool-inline-codex-dark-980.png'), await captureUi());
  await setSearch('');
  // Exercise aggregate -> single aggregate source -> empty without overwriting the original
  // selection history with one of ModelDock's intermediate configurations.
  await selectProvider('codex', mockSubscription.id, false);
  await selectProvider('codex', apiProviders[0].id, false);
  await selectProvider('codex', apiProviders[1].id, false);
  const codexCleared = parseToml(readFileSync(codexFile, 'utf8')) as any;
  assert.equal(codexCleared.model, 'foreign-original'); assert.equal(codexCleared.model_provider, 'foreign');
  assert.equal(resolve(codexCleared.model_catalog_json), resolve(foreignCodexCatalog));
  assert.deepEqual(Object.keys(codexCleared.model_providers), ['foreign']);
  assert.equal(codexCleared.model_providers.foreign.name, 'Foreign fixture'); assert.equal(codexCleared.mcp_servers.fixture.command, 'synthetic-mcp-fixture');
  assert.equal(existsSync(codexCatalog), false, 'Last unchecked Codex source must remove its generated owned catalog');
  assert.ok(readFileSync(foreignCodexCatalog, 'utf8') === originalCodexCatalog, 'Original native catalog must remain unchanged');
  const clearedCodexBinding = await storedBinding('codex');
  assert.equal(clearedCodexBinding.enabled, false); assert.deepEqual(clearedCodexBinding.providerIds, []); assert.deepEqual(clearedCodexBinding.modelIds, []); assert.equal(clearedCodexBinding.defaultModelId, '');
  await apply('codex', codexFile); // A manual zero-selection retry is idempotent.
  await assertNoRendererCredentials();
  assert.ok(readdirSync(backupDir).some(name => name.startsWith('vscode-'))); assert.ok(readdirSync(backupDir).some(name => name.startsWith('opencode-'))); assert.ok(readdirSync(backupDir).some(name => name.startsWith('codex-')));
  writeFileSync(join(outputDir, 'tool-selection-validation.json'), JSON.stringify({ sources: apiProviders.map(provider => ({ id: provider.id, name: provider.name })), fixtureModels: fixtureModels.map(model => ({ id: model.id, providerId: model.providerId, upstreamId: model.upstreamId, alias: model.alias })), legacyDefaultSelection: legacyDefaultValidation, legacyDisabledSelection: legacyDisabledValidation, inlineSelection: { mode: 'direct', dialogRequired: false, sources: 2, models: 4, defaultModelId: secondDefault.id, checkboxAutomaticallyApplies: true, defaultAutomaticallyApplies: true, manualRetryIdempotent: true }, layouts, vscode: { nativeGroups: 2, realUpstreamIds: true, independentCredentials: true, foreignGroupPreserved: true, commentsPreserved: true, deselectedGroupRemoved: true, allDeselectedManagedGroupsCleared: true, path: vscodeFile }, opencode: { nativeGroups: 2, independentCredentials: true, foreignProviderPreserved: true, mcpPreserved: true, commentsPreserved: true, allDeselectedManagedGroupsCleared: true, path: openCodeFile }, codex: { selectedSources: 3, activeEndpoint: 'modeldock', gatewayRunning: true, publishedAliases: catalog.models.map((model: any) => model.slug), defaultModel: codexApplied.model, foreignProviderPreserved: true, mcpPreserved: true, path: codexFile, allDeselectedManagedProviderRemoved: true, originalSelectionRestored: { model: codexCleared.model, modelProvider: codexCleared.model_provider, catalog: foreignCodexCatalog }, originalCatalogPreserved: true, generatedCatalogRemoved: true, zeroSelectionRetryIdempotent: true }, backupFilesCreated: true, rendererCredentialsHidden: true, realClientProfilesChanged: false, nativeClientsLoaded: false, liveProviderInferenceTested: false }, null, 2));
}
