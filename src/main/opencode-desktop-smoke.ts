import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';

export async function verifyOpenCodeDesktop(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_OPENCODE_DESKTOP_ONLY, '1');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..'));
  const target = join(store.dataDir, 'feature-home', '.config', 'opencode', 'opencode.jsonc');
  const original = '// OpenCode Desktop smoke comment\n{"provider":{"foreign":{"name":"Keep"}},"mcp":{"keep":{"type":"local","command":["fixture"]}}}';
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, original);
  const provider = store.saveProvider({ name: 'OpenCode 桌面测试来源', kind: 'openai-compatible', baseUrl: `${process.env.MODELDOCK_SMOKE_UPSTREAM}/v1`, apiKey: 'synthetic-desktop-smoke-key', enabled: true });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'mock-desktop', alias: 'desktop-smoke', displayName: '桌面测试模型', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: true, enabled: true });
  const second = store.saveProvider({ name: 'OpenCode 第二家 API', kind: 'openai-compatible', baseUrl: `${process.env.MODELDOCK_SMOKE_UPSTREAM}/second/v1`, apiKey: 'synthetic-second-smoke-key', enabled: true });
  const secondModel = store.saveModel({ ...model, id: undefined, providerId: second.id, alias: 'second-smoke', displayName: '第二家同名模型' });
  const subscription = store.saveProvider({ name: 'OpenCode 订阅来源', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(subscription.id, { accessToken: 'synthetic-never-export-access', refreshToken: 'synthetic-never-export-refresh' });
  const subscriptionModel = store.saveModel({ ...model, id: undefined, providerId: subscription.id, upstreamId: 'mock-subscription', alias: 'subscription-smoke', displayName: '订阅测试模型', wireApi: 'responses' });
  const sources = [provider, second, subscription], nativeIds = sources.map(source => `modeldock-${source.id}`);
  const tuiBefore = store.listBindings().find(binding => binding.id === 'opencode');
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script);
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function wait(script: string) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(script)) return; await pause(50); }
    writeFileSync(join(outputDir, 'opencode-timeout.png'), await captureUi());
    throw new Error(`OpenCode Desktop smoke timed out: ${script}`);
  }
  async function click(selector: string) {
    await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  const binding = (tool: 'opencode' | 'opencode-desktop') => store.listBindings().find(value => value.id === tool)!;
  async function synced() { await wait(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced' && !document.querySelector('[data-action="tool-use-aggregate"]')?.disabled`); }
  function assertNative(tool: 'opencode' | 'opencode-desktop') {
    const config = parse(readFileSync(target, 'utf8'));
    assert.deepEqual(config.enabled_providers, nativeIds);
    assert.equal(config.provider[nativeIds[0]].options.baseURL, provider.baseUrl);
    assert.equal(config.provider[nativeIds[1]].options.baseURL, second.baseUrl);
    assert.ok(config.provider[nativeIds[2]].options.baseURL.includes(`/tool/${tool}/v1`));
    assert.ok(config.provider[nativeIds[2]].models[subscriptionModel.alias]);
    assert.equal(config.provider.foreign.name, 'Keep');
    assert.deepEqual(config.mcp, parse(original).mcp);
    assert.ok(!readFileSync(target, 'utf8').includes('synthetic-never-export'));
    assert.deepEqual(binding(tool).providerIds, sources.map(source => source.id));
  }
  await click('[aria-label="刷新本机配置"]');
  await click('[data-tool-category="desktop"]');
  await click('[data-tool-id="opencode-desktop"][data-page="tools"]');
  await wait(`!!document.querySelector('[data-tool-binding="opencode-desktop"]')`);
  const categories = await evaluate<{ id: string; count: number; label: string }[]>(`[...document.querySelectorAll('[data-tool-category]')].map(el=>({id:el.dataset.toolCategory,count:Number(el.querySelector('span').textContent),label:el.textContent}))`);
  assert.deepEqual(categories.map(c => [c.id, c.count]), [['editor', 5], ['tui', 4], ['desktop', 4]]);
  assert.equal(readFileSync(target, 'utf8'), original, 'Navigation never writes client configuration');
  // Actual Electron key events exercise the tablist's roving focus and wrapping.
  await evaluate(`document.querySelector('[data-tool-category="desktop"]').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await wait(`document.activeElement?.dataset.toolCategory==='editor' && document.activeElement.getAttribute('aria-selected')==='true'`);
  await click('[data-tool-category="desktop"]');
  assert.ok(await evaluate<boolean>('window.modelDock.startGateway(0).then(status => status.running)'));
  await click(`input[data-action="select-tool-provider"][data-provider-id="${provider.id}"]`);
  await wait(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'`);
  assert.equal(parse(readFileSync(target, 'utf8')).model, `${nativeIds[0]}/${model.upstreamId}`);
  for (const source of sources.slice(1)) {
    await click(`input[data-action="select-tool-provider"][data-provider-id="${source.id}"]`); await synced();
    assert.ok(await evaluate<boolean>(`document.querySelector('input[data-action="select-tool-provider"][data-provider-id="${provider.id}"]').checked`), 'Adding another provider keeps the first checkbox selected');
  }
  assertNative('opencode-desktop');
  await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(secondModel.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await synced();
  assert.equal(parse(readFileSync(target, 'utf8')).model, `${nativeIds[1]}/${secondModel.upstreamId}`);
  assert.deepEqual(store.listBindings().find(binding => binding.id === 'opencode'), tuiBefore);
  await click('[data-action="preview-tool-config"]');
  await wait(`!!document.querySelector('.config-code')`);
  assert.equal(await evaluate<boolean>(`/synthetic-/.test(document.querySelector('.config-code').textContent)`), false);
  assert.ok(await evaluate<boolean>(`document.querySelector('.config-instructions').textContent.includes(${JSON.stringify(target)})`));
  await click('[aria-label="关闭对话框"]');
  await click('[data-action="tool-use-aggregate"]');
  await wait(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced' && document.querySelector('[data-action="tool-use-aggregate"]')?.checked`);
  const config = parse(readFileSync(target, 'utf8'));
  assert.ok(config.provider.modeldock.options.baseURL.includes('/tool/opencode-desktop/v1'));
  assert.equal(config.provider.foreign.name, 'Keep'); assert.deepEqual(config.mcp, parse(original).mcp);
  assert.ok(readFileSync(target, 'utf8').includes('// OpenCode Desktop smoke comment'));
  const aggregateSelection = structuredClone(binding('opencode-desktop'));
  await click('[data-action="tool-use-aggregate"]'); await synced();
  assertNative('opencode-desktop');
  assert.deepEqual(binding('opencode-desktop').modelIds, aggregateSelection.modelIds);
  assert.equal(binding('opencode-desktop').defaultModelId, secondModel.id);
  assert.ok(await evaluate<boolean>(`document.querySelector('.tool-source-selection-note').textContent.includes('无需开启聚合即可多选')`));
  const screenshots: string[] = [];
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await pause(180);
      const layout = await evaluate<{ overflow: boolean; fits: boolean }>(`(()=>{const tabs=[...document.querySelectorAll('[data-tool-category]')];return {overflow:document.documentElement.scrollWidth>innerWidth,fits:tabs.every(el=>el.scrollWidth<=el.clientWidth+1)}})()`);
      assert.equal(layout.overflow, false); assert.equal(layout.fits, true);
      const name = `electron-opencode-desktop-${theme}-${width}.png`; screenshots.push(name);
      writeFileSync(join(outputDir, name), await captureUi());
    }
  }
  await click('[data-action="undo-tool-sync"]');
  await wait(`document.querySelector('[data-tool-application-status]')?.textContent.includes('已撤销')`);
  assert.ok(parse(readFileSync(target, 'utf8')).provider.modeldock.options.baseURL.includes('/tool/opencode-desktop/v1'));
  assert.deepEqual(binding('opencode-desktop'), aggregateSelection);
  const desktopAfter = structuredClone(binding('opencode-desktop')), beforeNavigation = readFileSync(target, 'utf8');
  await click('[data-tool-category="tui"]');
  await click('[data-tool-id="opencode"][data-page="tools"]');
  await wait(`!!document.querySelector('[data-tool-binding="opencode"]')`);
  assert.equal(readFileSync(target, 'utf8'), beforeNavigation);
  for (const source of sources) { await click(`input[data-action="select-tool-provider"][data-provider-id="${source.id}"]`); await synced(); }
  assertNative('opencode');
  const tuiSelection = structuredClone(binding('opencode'));
  for (let toggle = 0; toggle < 2; toggle++) { await click('[data-action="tool-use-aggregate"]'); await synced(); }
  assertNative('opencode');
  assert.equal(binding('opencode').defaultModelId, tuiSelection.defaultModelId);
  assert.deepEqual(binding('opencode-desktop'), desktopAfter, 'Shared client file does not overwrite the other tool selection');
  await click(`input[data-action="select-tool-provider"][data-provider-id="${second.id}"]`); await synced();
  assert.deepEqual(binding('opencode').providerIds, [provider.id, subscription.id]);
  assert.deepEqual(parse(readFileSync(target, 'utf8')).enabled_providers, [nativeIds[0], nativeIds[2]]);
  assert.ok(existsSync(target));
  writeFileSync(join(outputDir, 'opencode-desktop-validation.json'), JSON.stringify({ ok: true, categories, keyboardTabs: true, independentSelections: true, automaticSync: true, previewRedacted: true, directAndAggregate: true, nativeMultiProvider: ['opencode', 'opencode-desktop'], modeSwitchRetainsSourcesAndDefault: true, deselectOnlyRemovesOneSource: true, backupsAndUndo: true, commentsAndMcpPreserved: true, screenshots, realClientProfilesChanged: false, liveProviderInferenceTested: false }, null, 2));
}
