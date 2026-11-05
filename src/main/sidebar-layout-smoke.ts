import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';
import { providerCategory } from '../shared/presets';

interface Layout {
  viewport: number; width: number; minimum: number; maximum: number; current: number; stored: string | null;
  sidebarOverflow: boolean; documentOverflow: boolean; mainOverflow: boolean; mainWidth: number;
  visibleCategories: string[]; selectedCategory: string | null; tabsHorizontal: boolean; resizerAccessible: boolean;
}

/** Native input against the isolated QA window; never applies external client configuration. */
export async function verifySidebarLayout(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  const api = store.saveProvider({ name: '侧栏宽度验证 API · 长名称保持完整且可识别', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://sidebar-layout.invalid/v1', enabled: true, apiKey: 'synthetic-sidebar-layout-key' });
  const subscription = store.saveProvider({ name: '侧栏宽度验证订阅 · 长名称保持完整且可识别', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: false });
  const model = store.saveModel({ providerId: api.id, upstreamId: 'sidebar-layout-upstream', alias: 'sidebar-layout-model', displayName: '侧栏验证模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const codex = store.listBindings().find(binding => binding.id === 'codex'); assert.ok(codex);
  store.saveBinding({ ...codex, mode: 'aggregate', enabled: true, providerIds: [api.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  const original = { providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings() };
  const originalSize = window.getSize(), originalMinimum = window.getMinimumSize(), originalVisible = window.isVisible();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const screenshots: string[] = [], layouts: unknown[] = [];
  const read = () => evaluate<Layout>(`(()=>{const sidebar=document.querySelector('.sidebar'),separator=document.querySelector('[data-sidebar-resizer]'),main=document.querySelector('.main-content'),tabs=[...document.querySelectorAll('[data-provider-category]')].map(tab=>tab.getBoundingClientRect());return {viewport:innerWidth,width:sidebar.getBoundingClientRect().width,minimum:Number(separator.getAttribute('aria-valuemin')),maximum:Number(separator.getAttribute('aria-valuemax')),current:Number(separator.getAttribute('aria-valuenow')),stored:localStorage.getItem('modeldock.sidebar-width'),sidebarOverflow:[...sidebar.children].filter(child=>!child.hasAttribute('data-sidebar-resizer')).some(child=>child.scrollWidth>child.clientWidth+1||child.getBoundingClientRect().right>sidebar.getBoundingClientRect().right+1),documentOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,mainWidth:document.querySelector('.main-shell').getBoundingClientRect().width,visibleCategories:[...document.querySelectorAll('[data-sidebar-provider-category]')].filter(panel=>!panel.hidden&&panel.getBoundingClientRect().height>0).map(panel=>panel.dataset.sidebarProviderCategory),selectedCategory:document.querySelector('[data-provider-category][aria-selected="true"]')?.dataset.providerCategory||null,tabsHorizontal:tabs.length===2&&Math.abs(tabs[0].top-tabs[1].top)<=1&&tabs[0].right<=tabs[1].left+1,resizerAccessible:separator.getAttribute('role')==='separator'&&separator.getAttribute('aria-orientation')==='vertical'&&separator.tabIndex===0&&separator.getAttribute('aria-controls')===sidebar.id}})()`);
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'sidebar-layout-timeout.png'), await captureUi());
    throw new Error(`Sidebar layout verification timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function point(selector: string) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
    await pause(40);
    const value = await evaluate<{ x: number; y: number; hit: boolean }>(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),r=element.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+Math.min(r.height/2,220));return {x,y,hit:element.contains(document.elementFromPoint(x,y))}})()`);
    assert.ok(value.hit, `Native input reaches its visible target: ${selector}`); return value;
  }
  async function nativeClick(selector: string, count = 1): Promise<void> {
    const p = await point(selector);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: count });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: count });
    await pause(40);
  }
  async function key(selector: string, code: string, shift = false): Promise<void> {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, ...(shift ? { modifiers: ['shift'] } : {}) });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, ...(shift ? { modifiers: ['shift'] } : {}) });
    await pause(40);
  }
  async function width(expected: number, label: string): Promise<void> {
    await waitFor(`Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width-${expected})<=1`, label);
    const actual = await read(); assert.ok(Math.abs(actual.current - actual.width) <= 1, 'The separator reports its actual current width');
  }
  async function drag(targetWidth: number, cancel = false): Promise<void> {
    const before = await read(), p = await point('[data-sidebar-resizer]'), finishX = Math.round(p.x + targetWidth - before.width);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 4; step++) { window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + (finishX - p.x) * step / 4), y: p.y, button: 'left', modifiers: ['leftbuttondown'] }); await pause(20); }
    await width(Math.min(before.maximum, Math.max(200, targetWidth)), 'native pointer drag updates sidebar width');
    if (cancel) { await key('[data-sidebar-resizer]', 'Escape'); await width(before.width, 'Escape cancels the current drag'); }
    window.webContents.sendInputEvent({ type: 'mouseUp', x: finishX, y: p.y, button: 'left', clickCount: 1 });
    await pause(40);
  }
  function validate(value: Layout): void {
    assert.equal(value.minimum, 200); assert.equal(value.maximum, Math.max(200, Math.min(420, value.viewport - 620)));
    assert.ok(value.width >= 200 && value.width <= value.maximum + 1);
    assert.equal(value.sidebarOverflow || value.documentOverflow || value.mainOverflow, false, 'Sidebar and content fit all supported widths');
    assert.ok(value.resizerAccessible && value.tabsHorizontal, 'The resize separator and horizontal tabs expose their keyboard contracts');
    assert.deepEqual(value.visibleCategories, [value.selectedCategory], 'Exactly the selected provider category is visible');
  }
  try {
    window.setMinimumSize(980, 680); window.setSize(1320, 880); window.show(); window.focus(); window.webContents.focus();
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('[data-sidebar-resizer]')&&!!document.querySelector('[data-source-id="${subscription.id}"]')`, 'resizer and both source panels mounted');
    await evaluate(`(()=>{window.__sidebarLayoutInput=[];window.__sidebarLayoutHandler=event=>{const target=event.target instanceof Element?event.target:null;if(target?.closest('[data-sidebar-resizer],[data-provider-category]')||document.documentElement.classList.contains('sidebar-resizing'))window.__sidebarLayoutInput.push({type:event.type,key:event.key||'',trusted:event.isTrusted,x:event.clientX,buttons:event.buttons,pointerId:event.pointerId,captured:!!document.querySelector('[data-sidebar-resizer]')?.hasPointerCapture(event.pointerId),target:target?.className,category:target?.closest('[data-provider-category]')?.dataset.providerCategory||''});};for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture','keydown','dblclick'])document.addEventListener(type,window.__sidebarLayoutHandler,true)})()`);
    await width(216, 'fresh QA profile starts at the default sidebar width'); validate(await read());
    for (const category of ['api', 'subscription']) {
      await nativeClick(`[data-provider-category="${category}"]`);
      await waitFor(`document.querySelector('[data-provider-category="${category}"]')?.getAttribute('aria-selected')==='true'`, 'native tab click changes the visible list');
      validate(await read());
      const expected = original.providers.filter(provider => providerCategory(provider) === category).map(provider => provider.id);
      assert.deepEqual(new Set(await evaluate<string[]>(`[...document.querySelectorAll('[data-sidebar-provider-category="${category}"] [data-source-id]')].map(item=>item.dataset.sourceId)`)), new Set(expected));
      assert.equal(await evaluate<number>(`document.querySelectorAll('.sidebar [data-action="add-api-provider"]').length`), category === 'api' ? 1 : 0);
    }
    const activePage = await evaluate<string>(`document.querySelector('.sidebar [aria-current="page"]')?.outerHTML||''`);
    await key('[data-provider-category="subscription"]', 'Home'); await waitFor(`document.activeElement?.getAttribute('data-provider-category')==='api'`, 'Home activates and focuses the first provider tab');
    await key('[data-provider-category="api"]', 'Right'); await waitFor(`document.activeElement?.getAttribute('data-provider-category')==='subscription'`, 'Right arrow switches and focuses provider tab');
    await key('[data-provider-category="subscription"]', 'Left'); await waitFor(`document.activeElement?.getAttribute('data-provider-category')==='api'`, 'Left arrow switches back');
    await key('[data-provider-category="api"]', 'End'); await waitFor(`document.activeElement?.getAttribute('data-provider-category')==='subscription'`, 'End activates and focuses the final provider tab');
    assert.equal(await evaluate<string>(`document.querySelector('.sidebar [aria-current="page"]')?.outerHTML||''`), activePage, 'Category switching does not navigate away from the current page');
    await drag(330); await waitFor(`Number(localStorage.getItem('modeldock.sidebar-width'))===330`, 'pointer release persists the chosen width');
    await drag(390, true); assert.equal((await read()).stored, '330', 'Cancelled dragging preserves the last committed preference');
    await key('[data-sidebar-resizer]', 'Right'); await width(338, 'Right arrow widens by eight pixels');
    await key('[data-sidebar-resizer]', 'Right', true); await width(362, 'Shift Right uses the larger keyboard step');
    await key('[data-sidebar-resizer]', 'Left', true); await width(338, 'Shift Left shrinks by the larger step');
    await key('[data-sidebar-resizer]', 'Home'); await width(200, 'Home reaches minimum width');
    await key('[data-sidebar-resizer]', 'End'); await width(420, 'End reaches the wide-window maximum');
    window.setSize(980, 680); await width(360, 'smaller windows clamp the rendered width'); validate(await read());
    assert.equal((await read()).stored, '420', 'Viewport clamping preserves the preferred width');
    window.setSize(1320, 880); await width(420, 'wider windows restore the preferred width');
    const inputBeforeReload = await evaluate<{ type: string; trusted: boolean }[]>(`window.__sidebarLayoutInput||[]`);
    assert.ok(inputBeforeReload.some(event => event.type === 'pointerdown' && event.trusted) && inputBeforeReload.some(event => event.type === 'pointermove' && event.trusted) && inputBeforeReload.some(event => event.type === 'keydown' && event.trusted), 'Resize and tab checks receive genuine Electron pointer and keyboard events');
    assert.ok(inputBeforeReload.some(event => event.type === 'gotpointercapture' && event.trusted), 'The native drag successfully captures its pointer');
    await new Promise<void>(done => { window.webContents.once('did-finish-load', () => done()); window.webContents.reload(); });
    await waitFor(`!!document.querySelector('[data-sidebar-resizer]')`, 'reloaded sidebar mounted'); await width(420, 'renderer reload retains the saved width');
    // Select a provider from the main interface while the opposite sidebar tab is active.
    for (const provider of [subscription, api]) {
      await click('[data-page="service"]'); await click('[data-service-tab="interface"]');
      const opposite = providerCategory(provider) === 'api' ? 'subscription' : 'api'; await nativeClick(`[data-provider-category="${opposite}"]`);
      await nativeClick(`[data-aggregate-provider="${provider.id}"] [aria-label="管理 ${provider.name}"]`);
      await waitFor(`document.querySelector('[data-provider-category="${providerCategory(provider)}"]')?.getAttribute('aria-selected')==='true'&&document.querySelector('[data-source-id="${provider.id}"]')?.getAttribute('aria-current')==='page'`, 'external provider selection activates its matching sidebar category');
    }
    for (const theme of ['light', 'dark']) for (const viewport of [1320, 980]) {
      window.setSize(viewport, viewport === 1320 ? 880 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      for (const edge of ['Home', 'End']) {
        await key('[data-sidebar-resizer]', edge); const value = await read(); validate(value);
        for (const category of ['api', 'subscription']) { await nativeClick(`[data-provider-category="${category}"]`); validate(await read()); }
        for (const page of ['codex-aggregate', 'service']) {
          if (page === 'codex-aggregate') {
            await click('[data-tool-category="agent"]'); await click('.sidebar [data-tool-id="codex"]');
            await waitFor(`!!document.querySelector('[data-aggregate-internal="codex"] .tool-workspace')`, 'Codex aggregate provider/model workspace');
          } else {
            await click('[data-page="service"]'); await click('[data-service-tab="interface"]');
            await click(`[data-aggregate-provider="${api.id}"] [data-action="expand-aggregate-provider"]`);
            await waitFor(`!!document.querySelector('[data-aggregate-model="${model.id}"]')`, 'service model publishing table expanded');
          }
          const current = await read(); validate(current);
          const content = await evaluate<unknown[]>(`[...document.querySelectorAll('.main-content,[data-aggregate-internal="codex"] .tool-workspace,.tool-primary-column,.tool-model-sidebar,.gateway-panel,[data-aggregate-management],.aggregate-model-table')].map(element=>({selector:element.className,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,width:element.getBoundingClientRect().width}))`);
          layouts.push({ theme, requestedViewport: viewport, edge, page, ...current, content });
          await evaluate(`document.querySelector('.main-content').scrollTop=0;document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
          const filename = `sidebar-layout-${theme}-${viewport}-${edge.toLowerCase()}-${page}.png`; writeFileSync(join(outputDir, filename), await captureUi()); screenshots.push(filename);
        }
      }
    }
    await nativeClick('[data-sidebar-resizer]'); await nativeClick('[data-sidebar-resizer]', 2); await width(216, 'double clicking the edge restores the default width');
    assert.equal((await read()).stored, '216');
    assert.deepEqual({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings() }, original, 'Resizing, tab switches, viewport changes and reload never change managed source/model/tool data');
    writeFileSync(join(outputDir, 'sidebar-layout-validation.json'), JSON.stringify({ ok: true, nativePointerResize: true, cancelRestoresCommittedWidth: true, keyboardResizeAndBounds: true, doubleClickResetsDefault: true, preferredWidthSurvivesClampAndReload: true, horizontalProviderTabs: true, oneProviderPanelVisible: true, keyboardProviderTabs: true, externalProviderSelectionSwitchesCategory: true, noHorizontalOverflow: true, providersModelsBindingsUnchanged: true, noExternalClientConfigurationWrites: true, inputBeforeReload, layouts, screenshots }, null, 2));
  } catch (error) {
    const content = await evaluate<unknown[]>(`[...document.querySelectorAll('.app-shell,.sidebar,.main-shell,.main-content,[data-aggregate-internal="codex"] .tool-workspace,.tool-primary-column,.tool-model-sidebar,.gateway-panel,[data-aggregate-management],.aggregate-model-table')].map(element=>({selector:element.className,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,width:element.getBoundingClientRect().width}))`);
    writeFileSync(join(outputDir, 'sidebar-layout-failure.json'), JSON.stringify({ error: String(error), current: await read(), content, layouts, inputs: await evaluate('window.__sidebarLayoutInput||[]') }, null, 2));
    writeFileSync(join(outputDir, 'sidebar-layout-failure.png'), await captureUi()); throw error;
  } finally {
    await evaluate(`(()=>{for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture','keydown','dblclick'])document.removeEventListener(type,window.__sidebarLayoutHandler,true);delete window.__sidebarLayoutHandler;delete window.__sidebarLayoutInput})()`);
    window.setMinimumSize(originalMinimum[0], originalMinimum[1]); window.setSize(originalSize[0], originalSize[1]); if (!originalVisible) window.hide();
  }
}
