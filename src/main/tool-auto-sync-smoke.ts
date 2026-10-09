import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Model, Provider, ToolBinding } from '../shared/types';
import type { Store } from './store';

/** Exercises the renderer, preload and real native-file backup/undo path in a test-owned Claude profile. */
export async function verifyToolAutoSync(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR;
  assert.ok(smokeDir && dataDir, 'Tool debounce smoke requires an explicit isolated profile');
  assert.equal(process.env.MODELDOCK_SMOKE_TOOL_SYNC_ONLY, '1');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(smokeDir));
  assert.equal(resolve(store.dataDir), resolve(dataDir));
  const fixturePath = relative(resolve(outputDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !isAbsolute(fixturePath), 'The smoke database must be below its test-owned output directory');
  const markerPath = join(dataDir, 'modeldock-smoke-profile.json');
  assert.ok(existsSync(markerPath), 'A smoke-runner-owned profile marker is required');
  assert.ok(lstatSync(markerPath).isFile() && !lstatSync(markerPath).isSymbolicLink());
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { outputDir: string; dataDir: string };
  assert.equal(resolve(marker.outputDir), resolve(outputDir)); assert.equal(resolve(marker.dataDir), resolve(dataDir));
  for (let path = resolve(dataDir); ; path = dirname(path)) {
    const info = lstatSync(path); assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Fixture directory ancestors must not redirect to user profiles');
    if (dirname(path) === path) break;
  }

  const target = join(dataDir, 'feature-home', '.claude', 'settings.json'), backupDir = join(dataDir, 'backups');
  for (const path of [target, backupDir]) {
    const child = relative(resolve(dataDir), resolve(path));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Every file operation must stay inside the isolated fixture');
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      if (existsSync(parent)) { const info = lstatSync(parent); assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Fixture subdirectories must not redirect to user profiles'); }
      if (resolve(parent) === resolve(dataDir)) break;
    }
  }
  if (existsSync(target)) assert.ok(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink());
  if (existsSync(backupDir)) assert.ok(lstatSync(backupDir).isDirectory() && !lstatSync(backupDir).isSymbolicLink());
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const preserved = { permissions: { defaultMode: 'default', allow: ['Read'] }, hooks: { SessionStart: [] },
    env: { USER_SENTINEL: 'retain-unrelated-env', ANTHROPIC_API_KEY: 'synthetic-original-key', ANTHROPIC_MODEL: 'pre-sync-native-id' }, model: 'pre-sync-native-id' };
  const originalRaw = `${JSON.stringify(preserved, null, 2)}\n`;
  writeFileSync(target, originalRaw, { mode: 0o600 });
  const seedBinding = store.listBindings().find(binding => binding.id === 'claude-code');
  assert.ok(seedBinding);
  store.saveBinding({ ...seedBinding, enabled: false, mode: 'direct', providerIds: [], modelIds: [], modelSelection: 'all', defaultModelId: '',
    connectionChoices: { direct: { providerId: '', defaultModelId: '' }, aggregate: { providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '' } } });
  const beforeBinding = structuredClone(store.listBindings().find(binding => binding.id === 'claude-code')!);

  const fixtureUrl = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!);
  assert.equal(fixtureUrl.protocol, 'http:'); assert.equal(fixtureUrl.hostname, '127.0.0.1');
  assert.ok(fixtureUrl.port && !fixtureUrl.username && !fixtureUrl.password && !fixtureUrl.search && !fixtureUrl.hash);
  const sources: { provider: Provider; model: Model; key: string; baseUrl: string }[] = [];
  for (const suffix of ['A', 'B', 'C', 'D']) {
    fixtureUrl.pathname = `/tool-sync-${suffix}`;
    const baseUrl = fixtureUrl.href.replace(/\/$/, ''), key = `synthetic-tool-sync-key-${suffix}`;
    const provider = store.saveProvider({ name: `防抖来源 ${suffix}`, kind: 'openai-compatible', presetId: 'anthropic', messagesAuth: 'bearer', baseUrl, enabled: true, apiKey: key });
    const model = store.saveModel({ providerId: provider.id, upstreamId: `native-tool-sync-${suffix.toLowerCase()}`, alias: `local-tool-sync-${suffix.toLowerCase()}`,
      displayName: `原生模型 ${suffix}`, wireApi: 'messages', contextWindow: 128000, tools: true, vision: false, enabled: true });
    sources.push({ provider, model, key, baseUrl });
  }

  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const raw = () => readFileSync(target, 'utf8');
  const config = () => JSON.parse(raw());
  const backups = () => existsSync(backupDir) ? readdirSync(backupDir).filter(name => /^claude-code-.*\.bak$/.test(name)).sort() : [];
  const initialBackups = backups();
  const selector = '[data-action="single-entry-direct-provider"]';
  const status = '[data-tool-application-status]';
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(20); }
    writeFileSync(join(outputDir, 'tool-auto-sync-timeout.png'), await captureUi());
    const ui = await evaluate(`(()=>({label:${JSON.stringify(label)},status:document.querySelector('${status}')?.dataset.toolApplicationState,text:document.querySelector('${status}')?.textContent,error:document.querySelector('[data-tool-sync-error]')?.textContent,directDisabled:document.querySelector('${selector}')?.disabled,applyDisabled:document.querySelector('[data-action="apply-tool-config"]')?.disabled,undoDisabled:document.querySelector('[data-action="undo-tool-sync"]')?.disabled}))()`);
    writeFileSync(join(outputDir, 'tool-auto-sync-timeout.json'), JSON.stringify(ui, null, 2));
    throw new Error(`Tool auto-sync smoke timed out: ${label}`);
  }
  async function click(control: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(control)})&&!document.querySelector(${JSON.stringify(control)}).disabled`, control);
    await evaluate(`document.querySelector(${JSON.stringify(control)}).click()`);
  }
  async function choose(source: typeof sources[number], unchangedRaw = originalRaw): Promise<number> {
    await waitFor(`(()=>{const select=document.querySelector('${selector}');return !!select&&!select.disabled&&Array.from(select.options).some(option=>option.value===${JSON.stringify(source.provider.id)}&&!option.disabled);})()`, 'source selector enabled between saves');
    const clickedAt = await evaluate<number>(`(()=>{const select=document.querySelector('${selector}');if(!Array.from(select.options).some(option=>option.value===${JSON.stringify(source.provider.id)}&&!option.disabled))throw new Error('Synthetic Messages source unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(source.provider.id)});select.dispatchEvent(new Event('change',{bubbles:true}));return Date.now();})()`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='claude-code');return binding?.providerIds?.[0]===${JSON.stringify(source.provider.id)}&&binding.defaultModelId===${JSON.stringify(source.model.id)}&&!document.querySelector('${selector}')?.disabled&&document.querySelector('${status}')?.dataset.toolApplicationState==='waiting';})()`, 'selection saved while debounce controls remain enabled');
    assert.equal(raw(), unchangedRaw, 'Debounce must leave the current native file untouched before the quiet interval');
    return clickedAt;
  }
  async function waitSynced(source: typeof sources[number]): Promise<void> {
    await waitFor(`document.querySelector('${status}')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled`, 'latest selection synced');
    const value = config();
    assert.equal(value.env.ANTHROPIC_BASE_URL, source.baseUrl); assert.equal(value.env.ANTHROPIC_MODEL, source.model.upstreamId);
    assert.equal(value.env.ANTHROPIC_AUTH_TOKEN, source.key); assert.equal(value.env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(value.availableModels, [source.model.upstreamId]);
    assert.deepEqual(value.permissions, preserved.permissions); assert.deepEqual(value.hooks, preserved.hooks); assert.equal(value.env.USER_SENTINEL, preserved.env.USER_SENTINEL);
    const displayedTarget = await evaluate<string>(`document.querySelector('.tool-inline-delivery code')?.textContent??''`);
    assert.equal(resolve(displayedTarget), resolve(target), 'The native configuration write must use the isolated Claude fixture');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-action="undo-tool-sync"]')&&!document.querySelector('[data-action="undo-tool-sync"]').disabled`), true);
    const undoStatus = await evaluate<{ available: boolean }>(`window.modelDock.toolSyncUndoStatus('claude-code')`);
    assert.equal(undoStatus.available, true, 'A completed native write must expose its undo checkpoint through preload');
  }
  async function undo(): Promise<void> {
    await click('[data-action="undo-tool-sync"]');
    await waitFor(`document.querySelector('${status}')?.dataset.toolApplicationState==='undone'&&!document.querySelector('[data-action="apply-tool-config"]')?.disabled`, 'undo completed');
    assert.equal(raw(), originalRaw, 'Undo must restore the exact pre-sync Claude settings');
    assert.deepEqual(store.listBindings().find(binding => binding.id === 'claude-code'), beforeBinding, 'Undo must restore the selection from before the whole debounce group');
    const undoStatus = await evaluate<{ available: boolean }>(`window.modelDock.toolSyncUndoStatus('claude-code')`);
    assert.equal(undoStatus.available, false, 'Undo must consume the last checkpoint');
    await pause(650); assert.equal(raw(), originalRaw, 'Undo must cancel any deferred writes');
  }

  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await click('[aria-label="刷新本机配置"]');
  await click('[data-page="tools"][data-tool-id="claude-code"]');
  await waitFor(`!!document.querySelector('[data-tool-binding="claude-code"]')`, 'Claude tool page');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-page="usage"],[data-page="models"]')`), false, 'Removed statistics and global catalogue pages must not appear in the sidebar');
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="tool-use-aggregate"]').checked`), false);
  const timings: number[] = [];
  for (const source of sources.slice(0, 3)) { timings.push(await choose(source)); assert.deepEqual(backups(), initialBackups, 'Rapid choices must not each create a backup'); }
  const intervals = timings.slice(1).map((time, index) => time - timings[index]);
  assert.ok(intervals.every(ms => ms >= 0 && ms < 400), `Source choices must overlap the 400ms debounce window: ${intervals.join(', ')}`);
  await waitSynced(sources[2]);
  const afterAutomatic = backups();
  assert.equal(afterAutomatic.length - initialBackups.length, 1, 'Three rapid selections must produce exactly one native write/backup');
  assert.equal(readFileSync(join(backupDir, afterAutomatic.find(name => !initialBackups.includes(name))!), 'utf8'), originalRaw, 'The coalesced backup must retain the original settings');
  await pause(650); assert.deepEqual(backups(), afterAutomatic, 'There must be no trailing extra write after automatic synchronization');

  const layouts = [];
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
    window.setSize(width, height);
    await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0;document.querySelector('[data-action="undo-tool-sync"]').scrollIntoView({block:'nearest'});})()`);
    await pause(120);
    const layout = await evaluate<{ horizontalOverflow: boolean; undoVisible: boolean; theme: string }>(`(()=>{const main=document.querySelector('.main-content'),button=document.querySelector('[data-action="undo-tool-sync"]').getBoundingClientRect();return {horizontalOverflow:main.scrollWidth>main.clientWidth+1,undoVisible:button.left>=0&&button.right<=innerWidth+1&&button.top>=0&&button.bottom<=innerHeight+1,theme:document.documentElement.dataset.theme};})()`);
    assert.equal(layout.horizontalOverflow, false); assert.equal(layout.undoVisible, true); assert.equal(layout.theme, theme);
    layouts.push({ width, height, ...layout });
    writeFileSync(join(outputDir, `tool-auto-sync-${theme}-${width}.png`), await captureUi());
  }
  // Undo while a newer selection is still waiting must cancel that draft, then revert the last completed write.
  const syncedRaw = raw();
  await choose(sources[3], syncedRaw);
  assert.deepEqual(backups(), afterAutomatic, 'A pending newer choice must not create its own native backup before undo');
  await undo();
  assert.deepEqual(backups(), afterAutomatic, 'Undo from the waiting state must not let the cancelled draft write later');
  const beforeManualBackups = backups();
  const manualTimings = [await choose(sources[0]), await choose(sources[3])];
  assert.ok(manualTimings[1] - manualTimings[0] < 400, 'Manual flush choices must still be inside the debounce interval');
  await click('[data-action="apply-tool-config"]'); await waitSynced(sources[3]);
  const afterManual = backups();
  assert.equal(afterManual.length - beforeManualBackups.length, 1, 'Manual sync must consume the pending group in one native write');
  await pause(650); assert.deepEqual(backups(), afterManual, 'Manual flush must not leave a second deferred write');
  await undo();

  // Provider-local model management remains available after removing the standalone catalogue page.
  await click(`[data-source-id="${sources[3].provider.id}"]`);
  await waitFor(`!!document.querySelector('.provider-models [data-action="manual-add-model"]')&&!!document.querySelector('.provider-models tr[data-model-id="${sources[3].model.id}"]')`, 'supplier model management retained');
  const providerModelsText = await evaluate<string>(`document.querySelector('.provider-models').textContent`);
  assert.ok(providerModelsText.includes(sources[3].model.upstreamId));
  await click('.provider-models [data-action="manual-add-model"]');
  await waitFor(`!!document.querySelector('.modal')&&document.querySelector('.modal')?.textContent.includes('添加模型')`, 'supplier add-model form usable');
  await click('[aria-label="关闭对话框"]');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-page="usage"],[data-page="models"]')`), false);
  window.setSize(1320, 880); await pause(120);
  writeFileSync(join(outputDir, 'tool-auto-sync-supplier-models.png'), await captureUi());
  writeFileSync(join(outputDir, 'tool-auto-sync-validation.json'), JSON.stringify({ ok: true, nativeTarget: target, syntheticCredentialsOnly: true,
    sourceChanges: timings.length, selectionIntervalsMs: intervals, automaticWritesAndBackups: 1, manualWritesAndBackups: 1,
    manualFlushNoTrailingWrite: true, exactSettingsAndBindingRestored: true, undoCancelledDeferredWrites: true, undoCancelledWaitingSelection: true,
    removedSidebarPages: ['usage', 'models'], providerModelManagementRetained: true, layouts,
    verification: 'Native Electron renderer + preload + isolated file serialization/backups/undo; no real Claude or upstream inference.' }, null, 2));
}
