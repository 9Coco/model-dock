import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { JETBRAINS_TOOL_IDS, JETBRAINS_TOOLS } from '../shared/jetbrains';
import type { Snapshot } from '../shared/types';
import type { Store } from './store';

/** Retired Air navigation stays absent without changing existing IDE files. */
export async function verifyJetBrainsPluginSwitch(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  const relativeData = relative(join(outputDir, 'data'), store.dataDir);
  assert.ok(relativeData && !relativeData.startsWith('..'));
  const originalFiles = new Map<string, string>();
  for (const tool of JETBRAINS_TOOL_IDS) {
    const profile = join(store.dataDir, 'feature-home', '.config', 'JetBrains', `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`);
    mkdirSync(join(profile, 'options'), { recursive: true, mode: 0o700 });
    originalFiles.set(join(profile, 'options', 'other.xml'), '<application><!-- Air account fixture --></application>');
    originalFiles.set(join(profile, 'options', 'llm.provider.openai.like.xml'), '<application><!-- Assistant profile fixture --></application>');
    originalFiles.set(join(profile, 'c.kdbx'), 'SYNTHETIC_PASSWORD_SAFE');
  }
  for (const [file, contents] of originalFiles) writeFileSync(file, contents, { mode: 0o600 });
  const original = { bindings: store.listBindings(), providers: store.listProviders(), models: store.listModels() };
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'air-retirement-timeout.png'), await captureUi());
    throw new Error(`Retired Air navigation verification timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    const query = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(`!!${query} && !${query}.disabled`, selector);
    await evaluate(`${query}.click()`);
  }
  const size = window.getSize();
  const appearance = await evaluate<{ theme?: string; colorScheme: string }>('({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})');
  const layouts: unknown[] = [];
  try {
    await click('[aria-label="刷新本机配置"]');
    const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
    for (const tool of ['air', ...JETBRAINS_TOOL_IDS]) {
      assert.equal(await evaluate<boolean>(`!!document.querySelector('.sidebar [data-tool-id="${tool}"]')`), false, 'Retired tools have no navigation entry');
      assert.equal(snapshot.bindings.some(binding => binding.id === tool), false, 'Retired bindings stay outside the renderer snapshot');
    }
    const retiredBinding = { id: 'air', name: 'Air', enabled: false, mode: 'aggregate', providerIds: [], modelIds: [], defaultModelId: '', note: 'synthetic retired UI request' };
    for (const operation of [`saveBinding(${JSON.stringify(retiredBinding)})`, 'previewConfig("air")', 'copyConnectionKey("air")']) {
      const error = await evaluate<string | null>(`window.modelDock.${operation}.then(()=>null,error=>String(error))`);
      assert.ok(error?.includes('无法识别的工具'), `Retired Air is rejected at the IPC tool gate: ${operation.split('(')[0]}`);
    }
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-tool-category]')].map(tab=>tab.dataset.toolCategory)`), ['tui', 'desktop']);
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      for (const [category, tool] of [['tui', 'junie'], ['desktop', 'vscode']]) {
        await click(`[data-tool-category="${category}"]`);
        await waitFor(`document.querySelector('[data-tool-category="${category}"]')?.getAttribute('aria-selected')==='true'`, `${category} category`);
        const ids = await evaluate<string[]>(`[...document.querySelectorAll('.tool-category-panel:not([hidden]) [data-tool-id]')].map(button=>button.dataset.toolId)`);
        assert.deepEqual(ids, category === 'tui' ? ['claude-code', 'junie', 'opencode', 'copilot-cli'] : ['codex', 'opencode-desktop', 'dsh', 'vscode', 'copilot']);
        await click(`.sidebar [data-tool-id="${tool}"]`);
        await waitFor(`!!document.querySelector('[data-tool-binding="${tool}"]')`, `${tool} detail`);
        if (tool === 'junie') assert.equal(await evaluate<boolean>(`document.querySelector('[data-junie-entry-guide]')?.textContent.includes('Junie · ModelDock')`), true, 'Junie IDE ACP instructions remain available');
        await pause(100);
        const overflow = await evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth||document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth+1`);
        assert.equal(overflow, false);
        const screenshot = `air-retired-${category}-${theme}-${width}.png`;
        writeFileSync(join(outputDir, screenshot), await captureUi());
        layouts.push({ theme, width, height, category, tool, screenshot });
      }
    }
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-tool-category="editor"],[data-air-manual-setup],[data-air-connection],[data-action^="air-copy-"]').length`), 0);
    for (const [file, contents] of originalFiles) assert.equal(readFileSync(file, 'utf8'), contents, 'Navigation preserves existing IDE configuration and PasswordSafe files');
    assert.deepEqual({ bindings: store.listBindings(), providers: store.listProviders(), models: store.listModels() }, original, 'Navigation never changes stored tool bindings or model sources');
    writeFileSync(join(outputDir, 'jetbrains-plugin-validation.json'), JSON.stringify({ ok: true, airEntryAbsent: true, editorCategoryAbsent: true, vscodeInDesktop: true, retiredAirIpcRejected: true, junieAcpGuideRetained: true, nativeSettingsUnchanged: true, toolBindingsUnchanged: true, layouts }, null, 2));
  } finally {
    window.setSize(size[0], size[1]);
    await evaluate(`(()=>{const original=${JSON.stringify(appearance)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme;})()`);
  }
}
