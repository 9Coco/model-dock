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
  const tuiBefore = store.listBindings().find(binding => binding.id === 'opencode');
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script);
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function wait(script: string) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(script)) return; await pause(50); }
    throw new Error(`OpenCode Desktop smoke timed out: ${script}`);
  }
  async function click(selector: string) {
    await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
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
  await click(`input[data-action="select-tool-provider"][data-provider-id="${provider.id}"]`);
  await wait(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'`);
  assert.equal(parse(readFileSync(target, 'utf8')).model, `modeldock/${model.upstreamId}`);
  assert.deepEqual(store.listBindings().find(binding => binding.id === 'opencode'), tuiBefore);
  await click('[data-action="preview-tool-config"]');
  await wait(`!!document.querySelector('.config-code')`);
  assert.equal(await evaluate<boolean>(`document.querySelector('.config-code').textContent.includes('synthetic-desktop-smoke-key')`), false);
  assert.ok(await evaluate<boolean>(`document.querySelector('.config-instructions').textContent.includes(${JSON.stringify(target)})`));
  await click('[aria-label="关闭对话框"]');
  assert.ok(await evaluate<boolean>('window.modelDock.startGateway(0).then(status => status.running)'));
  await click('[data-action="tool-use-aggregate"]');
  await wait(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced' && document.querySelector('[data-action="tool-use-aggregate"]')?.checked`);
  const config = parse(readFileSync(target, 'utf8'));
  assert.ok(config.provider.modeldock.options.baseURL.includes('/tool/opencode-desktop/v1'));
  assert.equal(config.provider.foreign.name, 'Keep'); assert.deepEqual(config.mcp, parse(original).mcp);
  assert.ok(readFileSync(target, 'utf8').includes('// OpenCode Desktop smoke comment'));
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
  assert.equal(parse(readFileSync(target, 'utf8')).provider.modeldock.options.baseURL, provider.baseUrl);
  assert.ok(existsSync(target));
  writeFileSync(join(outputDir, 'opencode-desktop-validation.json'), JSON.stringify({ ok: true, categories, keyboardTabs: true, independentSelections: true, automaticSync: true, previewRedacted: true, directAndAggregate: true, backupsAndUndo: true, commentsAndMcpPreserved: true, screenshots, realClientProfilesChanged: false, liveProviderInferenceTested: false }, null, 2));
}
