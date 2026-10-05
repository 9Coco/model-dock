import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { parse as parseJsonc } from 'jsonc-parser';
import type { Store } from './store';
import type { Model, Snapshot, ToolBinding, ToolId } from '../shared/types';

/** Exercise native renderer actions against the smoke's isolated client homes. */
export async function verifyToolRestoreAndConnections(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.ok(process.env.MODELDOCK_SMOKE && process.env.MODELDOCK_DATA_DIR && process.env.MODELDOCK_SMOKE_UPSTREAM);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  const fixtureHome = join(store.dataDir, 'feature-home');
  const paths = {
    codex: join(fixtureHome, '.codex', 'config.toml'),
    opencode: join(fixtureHome, '.config', 'opencode', 'opencode.json'),
    vscode: join(store.dataDir, 'feature-appdata', 'Code', 'User', 'chatLanguageModels.json'),
  };
  const catalogPath = join(fixtureHome, '.codex', 'modeldock-models.json');
  const backupsPath = join(store.dataDir, 'backups');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string) {
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    throw new Error(`Tool restore smoke timed out: ${label}`);
  }
  async function click(selector: string) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function navigate(tool: ToolId) {
    await click(`[data-page="tools"][data-tool-id="${tool}"]`);
    await waitFor(`!!document.querySelector('[data-tool-binding="${tool}"]')`, `${tool} tool page`);
  }
  async function idle() {
    await waitFor(`!document.querySelector('[data-action="apply-tool-config"]')?.disabled&&!document.querySelector('[data-action="restore-official-tool-config"]')?.disabled`, 'configuration action finished');
    assert.equal(await evaluate<boolean>('!!document.querySelector("[data-tool-sync-error]")'), false, 'Fixture synchronization must succeed');
  }
  async function binding(tool: ToolId): Promise<ToolBinding> {
    const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
    const found = snapshot.bindings.find(item => item.id === tool); assert.ok(found); return found;
  }
  async function selectProvider(providerId: string) {
    const current = await binding('codex');
    const expected = current.mode === 'aggregate' ? [...new Set([...(current.providerIds ?? []), providerId])] : [providerId];
    await click(`article[data-provider-id="${providerId}"] input[data-action="select-tool-provider"]`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='codex');return JSON.stringify(binding.providerIds)===${JSON.stringify(JSON.stringify(expected))}&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`, 'provider connection selection saved');
    await idle();
  }
  async function switchMode(mode: 'direct' | 'aggregate') {
    await click(`[data-action="codex-${mode}-mode"]`);
    await waitFor(`document.querySelector('[data-tool-binding="codex"]')?.dataset.connectionMode==='${mode}'&&!document.querySelector('[data-action="codex-${mode}-mode"]')?.disabled`, `${mode} connection mode saved`);
    await idle();
  }
  async function setDefault(modelId: string) {
    await evaluate(`(()=>{const input=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(modelId)});input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='codex');return binding.defaultModelId===${JSON.stringify(modelId)}&&!document.querySelector('[data-action="tool-default-model"]')?.disabled;})()`, 'aggregate default saved');
    await idle();
  }
  function catalogModels(): string[] { return JSON.parse(readFileSync(catalogPath, 'utf8')).models.map((model: any) => model.slug); }
  async function modelCheck(model: Model) {
    const selected = !(await binding('codex')).modelIds.includes(model.id);
    await click(`input[data-action="select-codex-aggregate-model"][data-model-id="${model.id}"]`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='codex');return binding.modelIds.includes('${model.id}')===${selected}&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`, 'aggregate model selection saved');
    await idle();
  }
  async function refresh() { await click('[aria-label="刷新本机配置"]'); await pause(70); }
  const initial = await evaluate<Snapshot>('window.modelDock.snapshot()');
  const providers = ['工具勾选回归 A', '工具勾选回归 B'].map(name => initial.providers.find(provider => provider.name === name));
  assert.ok(providers[0] && providers[1], 'Earlier tool smoke must create synthetic providers');
  const sourceA = providers[0], sourceB = providers[1];
  const models = initial.models.filter(model => [sourceA.id, sourceB.id].includes(model.providerId));
  assert.equal(models.length, 4);
  const modelA = models.find(model => model.providerId === sourceA.id)!;
  const modelB = models.find(model => model.providerId === sourceB.id)!;
  await navigate('codex');
  await switchMode('direct');
  assert.equal(await evaluate<boolean>('!!document.querySelector("[data-action=select-all-tool-providers]")'), false, 'Codex direct mode must not offer all-provider selection');
  await selectProvider(sourceA.id);
  assert.deepEqual((await binding('codex')).providerIds, [sourceA.id]);
  await selectProvider(sourceB.id);
  const direct = await binding('codex');
  assert.equal(direct.mode, 'direct'); assert.deepEqual(direct.providerIds, [sourceB.id]);
  assert.equal(await evaluate<number>('document.querySelectorAll("input[data-action=select-tool-provider]:checked").length'), 1);
  const directConfig = parseToml(readFileSync(paths.codex, 'utf8')) as any;
  assert.equal(directConfig.model_providers.modeldock.base_url, sourceB.baseUrl);
  assert.equal(directConfig.model, modelB.upstreamId);
  assert.deepEqual(new Set(catalogModels()), new Set(models.filter(model => model.providerId === sourceB.id).map(model => model.upstreamId)));
  await switchMode('aggregate');
  await selectProvider(sourceA.id);
  const aggregate = await binding('codex');
  assert.equal(aggregate.mode, 'aggregate'); assert.equal(aggregate.modelSelection, 'selected');
  assert.deepEqual(new Set(aggregate.providerIds), new Set([sourceA.id, sourceB.id])); assert.equal(aggregate.modelIds.length, 4);
  await setDefault(modelB.id); await modelCheck(modelB);
  const subset = await binding('codex');
  assert.equal(subset.modelIds.length, 3); assert.equal(subset.modelIds.includes(modelB.id), false);
  assert.ok(subset.modelIds.includes(subset.defaultModelId), 'Removing the default must select another enabled model');
  assert.deepEqual(new Set(catalogModels()), new Set(models.filter(model => model.id !== modelB.id).map(model => model.alias)));
  const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
  const gatewayUrl = `http://127.0.0.1:${snapshot.gateway.port}/tool/codex/v1`;
  const listed = await fetch(`${gatewayUrl}/models`, { headers: { authorization: `Bearer ${store.gatewayKey()}` } });
  assert.equal(listed.status, 200);
  const listedModels = await listed.json() as { data: { id: string }[] };
  assert.deepEqual(new Set(listedModels.data.map(model => model.id)), new Set(models.filter(model => model.id !== modelB.id).map(model => model.alias)));
  const rejected = await fetch(`${gatewayUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: modelB.alias, input: 'Synthetic disabled-model fixture' }) });
  assert.equal(rejected.status, 403, 'Unselected aggregate model must be rejected before forwarding'); await rejected.arrayBuffer();
  const layouts: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    await click('[data-page="settings"]'); await click(`[data-theme-choice="${theme}"]`);
    await waitFor(`document.documentElement.dataset.theme==='${theme}'`, 'theme applied'); await navigate('codex');
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await pause(80);
      await evaluate('document.querySelector(".main-content").scrollTop=0');
      const layout = await evaluate<{ horizontalOverflow: boolean; visibleModes: boolean; visibleRestore: boolean; modelChoices: number }>(`(()=>{const main=document.querySelector('.main-content');const inside=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return b.left>=0&&b.top>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1;};return {horizontalOverflow:main.scrollWidth>main.clientWidth+1,visibleModes:inside('.connection-mode-controls'),visibleRestore:inside('[data-action="restore-official-tool-config"]'),modelChoices:document.querySelectorAll('[data-action="select-codex-aggregate-model"]').length};})()`);
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.visibleModes, true); assert.equal(layout.visibleRestore, true); assert.equal(layout.modelChoices, 4);
      layouts.push({ theme, width, ...layout });
      writeFileSync(join(outputDir, `electron-codex-aggregate-${theme}-${width}.png`), await captureUi());
    }
  }
  await click('[data-action="clear-codex-aggregate-models"]');
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='codex');return !binding.enabled&&binding.modelIds.length===0&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`, 'all aggregate models disabled');
  await idle();
  const empty = await binding('codex');
  assert.equal(empty.enabled, false); assert.equal(empty.modelSelection, 'selected'); assert.deepEqual(empty.modelIds, []); assert.equal(empty.defaultModelId, '');
  assert.equal(existsSync(catalogPath), false);
  await refresh();
  assert.equal(await evaluate<number>('document.querySelectorAll("input[data-action=select-codex-aggregate-model]:checked").length'), 0, 'Refreshing empty selection must not enable models');
  await modelCheck(modelA);
  assert.deepEqual((await binding('codex')).modelIds, [modelA.id]);
  const added = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: sourceA.id, upstreamId: 'mock-unselected-new', alias: 'mock-unselected-new', displayName: '新增模型不会自动启用', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true })})`);
  await refresh();
  await waitFor(`!!document.querySelector('input[data-model-id="${added.id}"]')`, 'new model candidate appears');
  assert.equal(await evaluate<boolean>(`document.querySelector('input[data-model-id="${added.id}"]').checked`), false);
  assert.deepEqual((await binding('codex')).modelIds, [modelA.id]);
  assert.deepEqual(catalogModels(), [modelA.alias]);
  await click('[data-action="select-all-codex-aggregate-models"]');
  await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='codex');return binding.modelIds.length===5&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`, 'all aggregate models explicitly enabled');
  await idle();
  assert.equal((await binding('codex')).modelIds.length, 5);
  await evaluate(`window.modelDock.deleteModel(${JSON.stringify(added.id)})`); await refresh();
  const cancelled: ToolId[] = [];
  for (const tool of ['codex', 'opencode', 'dsh', 'vscode', 'copilot'] as ToolId[]) {
    await navigate(tool);
    const before = await binding(tool);
    const file = tool in paths ? paths[tool as keyof typeof paths] : undefined;
    const contents = file && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    await click('[data-action="restore-official-tool-config"]');
    await waitFor('!!document.querySelector("[data-action=confirm-tool-restore]")', 'restore confirmation opened');
    const description = await evaluate<string>('document.querySelector(".confirm-description").textContent');
    assert.match(description, /备份/); assert.match(description, /MCP/); assert.match(description, /Skills/); assert.match(description, /账号/);
    if (tool === 'codex') writeFileSync(join(outputDir, 'electron-restore-official-confirm-dark-980.png'), await captureUi());
    await click('[data-action="cancel-tool-restore"]');
    assert.deepEqual(await binding(tool), before, 'Cancelling restore must preserve the binding');
    if (file && contents !== undefined) assert.ok(readFileSync(file, 'utf8') === contents, 'Opening and cancelling restore must not write client files');
    cancelled.push(tool);
  }
  const restored: ToolId[] = [];
  for (const tool of ['codex', 'opencode', 'vscode'] as const) {
    await navigate(tool);
    if (tool === 'vscode') {
      // Earlier smoke already cleared this client to a native-only profile.
      // Restore an actual custom source here so its backup is meaningful.
      await click(`article[data-provider-id="${sourceA.id}"] input[data-action="select-tool-provider"]`);
      await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='vscode');return binding.providerIds.includes('${sourceA.id}')&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled;})()`, 'VS Code custom source fixture written');
      await idle();
    }
    const before = readFileSync(paths[tool], 'utf8');
    await click('[data-action="restore-official-tool-config"]'); await click('[data-action="confirm-tool-restore"]');
    await waitFor('!document.querySelector("[role=dialog]")&&!!document.querySelector("[data-tool-official-restored]")', `${tool} restored UI state`);
    const cleared = await binding(tool);
    assert.equal(cleared.enabled, false); assert.deepEqual(cleared.providerIds, []); assert.deepEqual(cleared.modelIds, []); assert.equal(cleared.defaultModelId, '');
    assert.equal(await evaluate<string>('document.querySelector("[data-tool-application-status]").dataset.toolApplicationState'), 'official');
    assert.ok(readdirSync(backupsPath).filter(name => name.startsWith(`${tool}-official-`)).some(name => readFileSync(join(backupsPath, name), 'utf8') === before), 'Restoration must back up the exact original fixture');
    if (tool === 'codex') {
      const config = parseToml(readFileSync(paths.codex, 'utf8')) as any;
      assert.equal(config.model_provider, undefined); assert.equal(config.model, undefined); assert.equal(config.model_catalog_json, undefined);
      assert.equal(config.model_providers?.modeldock, undefined); assert.equal(config.mcp_servers.fixture.command, 'synthetic-mcp-fixture'); assert.equal(existsSync(catalogPath), false);
    } else if (tool === 'opencode') {
      const config = parseJsonc(readFileSync(paths.opencode, 'utf8'));
      assert.equal(config.provider, undefined); assert.equal(config.model, undefined); assert.equal(config.mcp.fixture.command[0], 'synthetic-mcp-fixture');
    } else {
      const rows = parseJsonc(readFileSync(paths.vscode, 'utf8')) as any[];
      assert.equal(rows.some(row => row.vendor === 'customendpoint'), false); assert.equal(rows.some(row => row.vendor === 'openai'), true);
    }
    restored.push(tool);
  }
  const final = await evaluate<Snapshot>('window.modelDock.snapshot()');
  assert.equal(final.providers.length, initial.providers.length); assert.equal(final.models.length, initial.models.length);
  assert.doesNotMatch(await evaluate<string>('document.body.innerText'), /synthetic-tool-one|synthetic-tool-two|MOCK_ACCESS|MOCK_REFRESH|SYNTHETIC_FOREIGN/);
  writeFileSync(join(outputDir, 'tool-restore-connection-validation.json'), JSON.stringify({ codexDirectSingleSource: true, selectingAnotherProviderReplacesSource: true, directUsesUpstreamUrl: true, aggregateExplicitMode: true, aggregateExactModelSelection: true, aggregateCatalogAndRouteWhitelist: true, excludedModelRejected: true, emptyDoesNotEnableAll: true, newModelsRemainDisabled: true, enableAllExplicit: true, defaultAlwaysEnabled: true, cancelledRestoreTools: cancelled, restoredFileTools: restored, originalFilesBackedUp: true, mcpPreserved: true, globalProvidersAndModelsPreserved: true, layouts, realClientProfilesChanged: false, nativeClientsLoaded: false, liveProviderInferenceTested: false }, null, 2));
}
