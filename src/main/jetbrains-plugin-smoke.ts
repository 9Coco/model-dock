import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, ClipboardItem, type BrowserWindow } from 'electron';
import { JETBRAINS_TOOL_IDS, JETBRAINS_TOOLS } from '../shared/jetbrains';
import type { ConfigPreview, Snapshot } from '../shared/types';
import type { Store } from './store';

/** Air owns its Accounts and PasswordSafe; this smoke only changes an isolated binding. */
export async function verifyJetBrainsPluginSwitch(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  const isolated = relative(join(outputDir, 'data'), store.dataDir); assert.ok(isolated && !isolated.startsWith('..'));
  const originalFiles = new Map<string, string>();
  for (const tool of JETBRAINS_TOOL_IDS) {
    const profile = join(store.dataDir, 'feature-home', '.config', 'JetBrains', `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.3`);
    mkdirSync(join(profile, 'options'), { recursive: true, mode: 0o700 });
    originalFiles.set(join(profile, 'options', 'other.xml'), '<application><!-- Existing Air accounts --></application>');
    originalFiles.set(join(profile, 'options', 'llm.provider.openai.like.xml'), '<application><!-- Existing Assistant --></application>');
    originalFiles.set(join(profile, 'c.kdbx'), 'SYNTHETIC_PASSWORD_SAFE');
  }
  for (const [file, contents] of originalFiles) writeFileSync(file, contents, { mode: 0o600 });
  const provider = store.saveProvider({ name: 'Air 验证来源', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', presetId: 'deepseek', enabled: true, apiKey: 'SYNTHETIC_AIR_BYOK_KEY' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'deepseek-flash', alias: 'air-flash', displayName: 'DeepSeek Flash', wireApi: 'chat-completions', contextWindow: 1000000, tools: true, vision: false, enabled: true });
  const beforeBindings = store.listBindings().filter(b => b.id !== 'air');
  const original = { providers: store.listProviders(), models: store.listModels() };
  store.saveBinding({ ...store.listBindings().find(b => b.id === 'air')!, id: 'air', name: 'Air', enabled: true, mode: 'direct', airProvider: 'openai', providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id, note: '' });
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'air-byok-timeout.png'), await captureUi()); throw new Error(`Air BYOK timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    const query = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(`!!${query} && !${query}.disabled`, selector); await evaluate(`${query}.click()`);
  }
  async function selectType(type: 'openai' | 'anthropic'): Promise<void> {
    await evaluate(`(()=>{const s=document.querySelector('[data-action="air-provider-type"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(type)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='air');return b.airProvider===${JSON.stringify(type)}&&!document.querySelector('[data-action="air-provider-type"]').disabled;})()`, `${type} saved`);
  }
  async function copy(selector: string, expected: string): Promise<void> {
    await click(selector); const end = Date.now() + 5000;
    while (await clipboard.readText() !== expected && Date.now() < end) await pause(25);
    assert.equal(await clipboard.readText(), expected, `Exact copy from ${selector}`);
  }
  const size = window.getSize();
  const appearance = await evaluate<{ theme?: string; colorScheme: string }>('({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})');
  const savedClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  const layouts: unknown[] = [];
  try {
    await click('[aria-label="刷新本机配置"]'); await click('[data-tool-category="desktop"]'); await click('.sidebar [data-tool-id="air"]');
    await waitFor(`!!document.querySelector('[data-air-connection="air"]')`, 'Air Accounts panel');
    const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()'); assert.ok(snapshot.bindings.some(b => b.id === 'air'));
    for (const tool of JETBRAINS_TOOL_IDS) assert.equal(snapshot.bindings.some(b => b.id === tool), false);
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-tool-category]')].map(tab=>tab.dataset.toolCategory)`), ['tui', 'desktop']);
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('.tool-category-panel:not([hidden]) [data-tool-id]')].map(b=>b.dataset.toolId)`), ['codex', 'opencode-desktop', 'dsh', 'vscode', 'copilot', 'air']);
    const preview = () => evaluate<ConfigPreview>('window.modelDock.previewConfig("air")');
    const direct = await preview(); assert.equal(direct.canApply, false);
    assert.ok(direct.content.includes('deepseek-flash') && !direct.content.includes('SYNTHETIC_AIR_BYOK_KEY'));
    await copy('[data-action="air-copy-key"]', 'SYNTHETIC_AIR_BYOK_KEY'); await copy('[data-action="air-copy-model"]', 'deepseek-flash');
    await selectType('anthropic'); const anthropic = await preview();
    assert.ok(anthropic.content.includes('https://api.deepseek.com/anthropic') && !anthropic.content.includes('/anthropic/v1'));
    await copy('[data-action="air-copy-url"]', 'https://api.deepseek.com/anthropic');
    await click('[data-action="tool-use-aggregate"]');
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='air');return b.mode==='aggregate'&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled;})()`, 'Aggregate saved');
    const source = `article[data-provider-id="${provider.id}"] input[data-action="select-tool-provider"]`;
    if (!await evaluate<boolean>(`document.querySelector(${JSON.stringify(source)})?.checked`)) await click(source);
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='air');return b.providerIds.includes(${JSON.stringify(provider.id)})&&b.enabled&&!document.querySelector('[data-action="air-provider-type"]').disabled;})()`, 'Aggregate source');
    const aggregate = await preview(), port = (await evaluate<Snapshot>('window.modelDock.snapshot()')).gateway.port;
    assert.ok(aggregate.content.includes('/tool/air') && !aggregate.content.includes('/tool/air/v1'));
    await copy('[data-action="air-copy-url"]', `http://127.0.0.1:${port}/tool/air`); await copy('[data-action="air-copy-key"]', store.gatewayKey());
    for (const operation of ['applyConfig("air")', 'undoToolSync("air")', 'restoreOfficialConfig("air")']) {
      const error = await evaluate<string | null>(`window.modelDock.${operation}.then(()=>null,e=>String(e))`); assert.ok(error?.includes('Air'));
    }
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-action="apply-tool-config"],[data-action="undo-tool-sync"],[data-action="restore-official-tool-config"]').length`), 0);
    assert.equal(await evaluate<string>(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState`), 'manual');
    assert.equal(await evaluate<boolean>(`document.body.innerText.includes('SYNTHETIC_AIR_BYOK_KEY')`), false);
    for (const type of ['openai', 'anthropic'] as const) {
      await selectType(type);
      for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
        window.setSize(width, height);
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0;document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(b=>b.click())`); await pause(120);
        assert.equal(await evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth||document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth+1`), false);
        const screenshot = `air-byok-${type}-${theme}-${width}.png`; writeFileSync(join(outputDir, screenshot), await captureUi()); layouts.push({ type, theme, width, height, screenshot });
      }
    }
    for (const [file, contents] of originalFiles) assert.equal(readFileSync(file, 'utf8'), contents);
    assert.deepEqual(store.listBindings().filter(b => b.id !== 'air'), beforeBindings);
    assert.deepEqual({ providers: store.listProviders(), models: store.listModels() }, original);
    writeFileSync(join(outputDir, 'jetbrains-plugin-validation.json'), JSON.stringify({ ok: true, airInDesktop: true, editorCategoryAbsent: true, vscodeInDesktop: true, manualSaveOnly: true, openaiAndAnthropic: true, exactClipboardCopies: true, previewRedacted: true, nativeSettingsUnchanged: true, otherToolBindingsUnchanged: true, liveAirAccountSaved: false, liveProviderInferenceTested: false, layouts }, null, 2));
  } finally {
    await clipboard.write(savedClipboard); window.setSize(size[0], size[1]);
    await evaluate(`(()=>{const o=${JSON.stringify(appearance)};if(o.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=o.theme;document.documentElement.style.colorScheme=o.colorScheme;})()`);
  }
}
