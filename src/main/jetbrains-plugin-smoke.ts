import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, type BrowserWindow } from 'electron';
import { JETBRAINS_TOOL_IDS, JETBRAINS_TOOLS } from '../shared/jetbrains';
import type { ConfigPreview } from '../shared/types';
import type { Store } from './store';

/** Air connection parameters, clipboard and routing controls in an isolated Electron profile. */
export async function verifyJetBrainsPluginSwitch(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  const relativeData = relative(join(outputDir, 'data'), store.dataDir);
  assert.ok(relativeData && !relativeData.startsWith('..'));
  const source = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!);
  assert.equal(source.hostname, '127.0.0.1');
  const provider = store.saveProvider({ name: 'Air 验证来源', kind: 'openai-compatible',
    baseUrl: source.href, enabled: true, apiKey: 'synthetic-air-key' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'air-responses-native', alias: 'air-smoke-alias',
    displayName: 'Air 验证模型', wireApi: 'responses', contextWindow: 64_000, tools: true, vision: false, enabled: true });
  const originalFiles = new Map<string, string>();
  for (const tool of JETBRAINS_TOOL_IDS) {
    const profile = join(store.dataDir, 'feature-home', '.config', 'JetBrains', `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`);
    mkdirSync(join(profile, 'options'), { recursive: true, mode: 0o700 });
    originalFiles.set(join(profile, 'options', 'other.xml'), '<application><!-- Air account fixture --></application>');
    originalFiles.set(join(profile, 'options', 'llm.provider.openai.like.xml'), '<application><!-- Assistant profile fixture --></application>');
    originalFiles.set(join(profile, 'c.kdbx'), 'SYNTHETIC_PASSWORD_SAFE');
  }
  for (const [file, contents] of originalFiles) writeFileSync(file, contents, { mode: 0o600 });
  const existingBindings = store.listBindings().filter(binding => binding.id !== 'air');

  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'air-timeout.png'), await captureUi());
    throw new Error(`Air UI timed out: ${label}`);
  }
  async function click(selector: string) {
    const query = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(`!!${query} && !${query}.disabled`, selector);
    await evaluate(`${query}.click()`);
  }
  async function copied(selector: string, expected: string) {
    await clipboard.clear(); await click(selector);
    const end = Date.now() + 5000;
    while (await clipboard.readText() !== expected && Date.now() < end) await pause(25);
    assert.equal(await clipboard.readText(), expected, 'Air copies the exact parameter');
    await clipboard.clear();
  }
  const snapshotAir = '(await window.modelDock.snapshot()).bindings.find(binding=>binding.id==="air")';
  const layouts: unknown[] = [];
  try {
    await click('[aria-label="刷新本机配置"]');
    await click('[data-tool-category="editor"]');
    const ids = await evaluate<string[]>(`[...document.querySelectorAll('#tool-category-panel-editor [data-tool-id]')].map(button=>button.dataset.toolId)`);
    assert.deepEqual(ids, ['vscode', 'air'], 'Editors show exactly VS Code and one Air entry');
    for (const tool of JETBRAINS_TOOL_IDS) {
      assert.equal(await evaluate<boolean>(`!!document.querySelector('.sidebar [data-tool-id="${tool}"]')`), false);
      assert.equal(await evaluate<boolean>(`window.modelDock.snapshot().then(state=>state.bindings.some(binding=>binding.id==="${tool}"))`), false);
    }

    await click('.sidebar [data-tool-id="air"]');
    await waitFor(`!!document.querySelector('[data-air-manual-setup]')?.textContent.includes('More Providers')`, 'manual setup');
    const forbidden = '[data-action="jetbrains-plugin-select"],[data-jetbrains-completion],[data-action="apply-tool-config"],[data-action="undo-tool-sync"],[data-action="restore-official-tool-config"]';
    assert.equal(await evaluate<number>(`document.querySelectorAll(${JSON.stringify(forbidden)}).length`), 0);

    await waitFor(`!!document.querySelector('[data-action="single-entry-direct-provider"] option[value="${provider.id}"]:not(:disabled)')`, 'direct API option');
    await evaluate(`(()=>{
      const select=document.querySelector('[data-action="single-entry-direct-provider"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(provider.id)});
      select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(`(async()=>${snapshotAir}?.defaultModelId===${JSON.stringify(model.id)})()`, 'direct binding saved');
    await copied('[data-action="air-copy-url"]', provider.baseUrl);
    await copied('[data-action="air-copy-key"]', 'synthetic-air-key');
    await copied('[data-action="air-copy-model"]', model.upstreamId);

    await click('[data-action="tool-use-aggregate"]');
    await waitFor(`(async()=>${snapshotAir}?.mode==='aggregate'&&${snapshotAir}?.defaultModelId===${JSON.stringify(model.id)})()`, 'aggregate binding saved');
    const status = await evaluate<{ port: number; running: boolean }>('window.modelDock.startGateway(0)');
    assert.equal(status.running, true);
    await click('[aria-label="刷新本机配置"]');
    const aggregateBase = `http://127.0.0.1:${status.port}/tool/air/v1`;
    await waitFor(`document.querySelector('[data-air-connection]')?.textContent.includes(${JSON.stringify(aggregateBase)})`, 'Air aggregate URL');
    await copied('[data-action="air-copy-url"]', aggregateBase);
    await copied('[data-action="air-copy-key"]', store.gatewayKey());
    await copied('[data-action="air-copy-model"]', model.alias);

    const preview = await evaluate<ConfigPreview>('window.modelDock.previewConfig("air")');
    assert.equal(preview.canApply, false);
    assert.ok(preview.content.includes(aggregateBase) && preview.content.includes(model.alias));
    assert.ok(!preview.content.includes(store.gatewayKey()) && !preview.content.includes('synthetic-air-key'));
    await click('[data-action="preview-tool-config"]');
    await waitFor(`document.querySelector('[role="dialog"] .config-code')?.textContent.includes(${JSON.stringify(aggregateBase)})`, 'visible Air preview');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"] [data-action="apply-tool-config"]')`), false);
    await click('[aria-label="关闭对话框"]');

    await click('.sidebar [data-tool-id="vscode"]'); await click('.sidebar [data-tool-id="air"]');
    await waitFor(`document.querySelector('[data-action="tool-use-aggregate"]').checked`, 'binding survives navigation');
    await click('[data-action="tool-use-aggregate"]');
    await waitFor(`(async()=>${snapshotAir}?.mode==='direct'&&${snapshotAir}?.defaultModelId===${JSON.stringify(model.id)})()`, 'separate direct draft restored');
    for (const method of ['applyConfig', 'restoreOfficialConfig', 'undoToolSync']) {
      assert.equal(await evaluate<boolean>(`window.modelDock.${method}("air").then(()=>false,()=>true)`), true, 'Air never applies native IDE writes');
    }
    assert.deepEqual(store.listBindings().filter(binding => binding.id !== 'air'), existingBindings);
    for (const [file, contents] of originalFiles) assert.equal(readFileSync(file, 'utf8'), contents);

    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.style.colorScheme=${JSON.stringify(theme)}; document.querySelector('.main-content').scrollTop=0`);
      await pause(100);
      const overflow = await evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth||document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth+1`);
      assert.equal(overflow, false);
      const screenshot = `air-${theme}-${width}.png`;
      writeFileSync(join(outputDir, screenshot), await captureUi());
      layouts.push({ theme, width, height, screenshot });
    }
    writeFileSync(join(outputDir, 'jetbrains-plugin-validation.json'), JSON.stringify({ ok: true, airOnly: true,
      modelsAndClipboardVerified: true, previewRedactsKey: true, nativeSettingsUnchanged: true, layouts }, null, 2));
  } finally { await clipboard.clear(); }
}
