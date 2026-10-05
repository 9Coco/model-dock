import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';

interface Box { top: number; bottom: number; left: number; right: number; width: number; height: number }
interface ListReadback {
  name: string; box: Box; top: number; clientHeight: number; scrollHeight: number; overflowY: string;
  horizontalOverflow: boolean; label: Box; labelVisible: boolean; lastVisible: boolean;
  rows: { height: number; font: number; lineHeight: string }[];
}
interface SidebarReadback {
  viewport: { width: number; height: number; dpr: number }; lists: ListReadback[];
  fixed: { name: string; visible: boolean; box: Box }[]; documentOverflow: boolean; sidebarOverflow: boolean;
}
type UiState = { theme?: string; colorScheme: string; navigation: Record<string, string>; scroll: Record<string, number> };
interface WheelEventReadback { section: string; deltaX: number; deltaY: number; mode: number; trusted: boolean; targetTag: string }
interface WheelReadback { section: string; moved: boolean; otherUnchanged: boolean; overflow: boolean; beforeTop: number; afterTop: number; events: WheelEventReadback[] }

/** Real renderer input, synthetic providers and the already-guarded smoke store.
 * Sidebar navigation never selects models, applies config or starts a login. */
export async function verifySidebarScroll(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true, 'Sidebar fixtures require the separately compiled smoke entry');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child), 'Sidebar fixtures require an isolated output/data profile');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(30); }
    writeFileSync(join(outputDir, 'electron-sidebar-timeout.png'), await captureUi());
    throw new Error(`Sidebar scroll verification timed out: ${label}`);
  }
  const stateScript = `(()=>{const root=document.documentElement,active=document.querySelector('.sidebar [aria-current="page"]');return {
    theme:root.dataset.theme,colorScheme:root.style.colorScheme,navigation:active?Object.fromEntries([...active.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value])):{},
    scroll:Object.fromEntries([...document.querySelectorAll('[data-sidebar-scroll]')].map(el=>[el.dataset.sidebarScroll,el.scrollTop]))};})()`;
  const readScript = `(()=>{
    const box=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
    const visible=element=>{if(!element)return false;const r=box(element),css=getComputedStyle(element);return css.display!=='none'&&css.visibility==='visible'&&r.width>0&&r.height>0&&r.top>=-1&&r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1;};
    const lists=[...document.querySelectorAll('[data-sidebar-scroll]')].map(list=>{
      const r=box(list),label=document.querySelector('[data-sidebar-label="'+list.dataset.sidebarScroll+'"]'),last=[...list.querySelectorAll('button.nav-item')].at(-1),lastBox=last?box(last):null;
      return {name:list.dataset.sidebarScroll,box:r,top:list.scrollTop,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,overflowY:getComputedStyle(list).overflowY,horizontalOverflow:list.scrollWidth>list.clientWidth+1,
        label:box(label),labelVisible:visible(label),lastVisible:!!lastBox&&visible(last)&&lastBox.top>=r.top-1&&lastBox.bottom<=r.bottom+1,
        rows:[...list.querySelectorAll('button.nav-item')].map(row=>({height:box(row).height,font:parseFloat(getComputedStyle(row).fontSize),lineHeight:getComputedStyle(row).lineHeight}))};
    });
    const fixed=[['brand','.sidebar .brand'],['functions','.sidebar-functions'],['footer','.sidebar-bottom'],['settings','.sidebar-bottom [data-page="settings"]']].map(([name,selector])=>{const element=document.querySelector(selector);return {name,visible:visible(element),box:element?box(element):{top:0,bottom:0,left:0,right:0,width:0,height:0}};});
    const sidebar=document.querySelector('.sidebar');return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},lists,fixed,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,sidebarOverflow:sidebar.scrollWidth>sidebar.clientWidth+1};
  })()`;
  const config = () => ({ providers: store.listProviders(), bindings: store.listBindings(), models: store.listModels() });
  const originalConfig = config(), originalSize = window.getSize(), originalMinimum = window.getMinimumSize();
  await waitFor(`document.querySelectorAll('[data-sidebar-scroll]').length===2`, 'two independent sidebar lists');
  const originalUi = await evaluate<UiState>(stateScript);
  const created: { id: string; name: string }[] = [];
  const layouts: { theme: string; requestedSize: number[]; start: SidebarReadback; bottom: SidebarReadback; wheels: WheelReadback[] }[] = [];
  const wheelInputs: unknown[] = [];
  await evaluate(`(()=>{window.__modeldockSidebarWheelEvents=[];window.__modeldockSidebarWheelHandler=event=>{const target=event.target instanceof Element?event.target:null;window.__modeldockSidebarWheelEvents.push({section:target?.closest('[data-sidebar-scroll]')?.dataset.sidebarScroll||'',deltaX:event.deltaX,deltaY:event.deltaY,mode:event.deltaMode,trusted:event.isTrusted,targetTag:target?.tagName||''});};document.addEventListener('wheel',window.__modeldockSidebarWheelHandler,{capture:true,passive:true});})()`);
  const restoreUi = async () => {
    await evaluate(`(()=>{const original=${JSON.stringify(originalUi)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme;
      const entries=Object.entries(original.navigation),target=[...document.querySelectorAll('.sidebar button')].find(el=>entries.length&&entries.every(([name,value])=>el.getAttribute(name)===value));target?.click();
      for(const [name,top] of Object.entries(original.scroll)){const list=document.querySelector('[data-sidebar-scroll="'+name+'"]');if(list)list.scrollTop=top;}})()`);
  };
  async function clickVisible(selector: string): Promise<void> {
    const point = await evaluate<{ x: number; y: number; hittable: boolean }>(`(()=>{const button=document.querySelector(${JSON.stringify(selector)}),r=button.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);return {x,y,hittable:button.contains(document.elementFromPoint(x,y))};})()`);
    assert.ok(point.hittable, `Visible navigation must accept a pointer: ${selector}`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  function validate(value: SidebarReadback): void {
    assert.deepEqual(value.lists.map(list => list.name), ['tools', 'providers']);
    assert.ok(value.fixed.every(item => item.visible), 'Brand, functional destinations and footer must remain in the viewport');
    assert.equal(value.documentOverflow || value.sidebarOverflow, false, 'Sidebar must not introduce horizontal overflow');
    for (const list of value.lists) {
      assert.ok(['auto', 'scroll'].includes(list.overflowY) && list.clientHeight > 0, `Each sidebar list has its own scroll viewport: ${list.name}`);
      assert.equal(list.horizontalOverflow, false); assert.equal(list.labelVisible, true);
      assert.ok(list.rows.every(row => row.font >= 12 && row.height >= 28), `Navigation text and click rows retain readable dimensions: ${list.name}`);
    }
    assert.ok(value.lists[0].box.bottom <= value.lists[1].label.top + 1, 'Tools must not cover the provider group');
    assert.ok(value.lists[1].box.bottom <= value.fixed.find(item => item.name === 'functions')!.box.top + 1, 'Provider viewport must leave the functional navigation visible');
  }
  try {
    // These sources deliberately have no credentials or models. Navigating to
    // them cannot invoke an upstream or cause external config synchronization.
    for (let index = 1; index <= 24; index++) {
      const provider = store.saveProvider({ name: `侧栏验证供应商 ${String(index).padStart(2, '0')}`, kind: 'openai-compatible', presetId: 'custom', baseUrl: 'http://127.0.0.1:19991/v1', enabled: false, note: 'synthetic sidebar layout fixture' });
      created.push({ id: provider.id, name: provider.name });
    }
    await evaluate(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
    const last = created[created.length - 1];
    await waitFor(`!!document.querySelector('.sidebar [data-source-id="${last.id}"]')`, 'synthetic provider list refreshed');
    for (const theme of ['dark', 'light']) for (const requestedSize of [[1320, 880], [980, 680]]) {
      window.setSize(requestedSize[0], requestedSize[1]);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelectorAll('[data-sidebar-scroll]').forEach(list=>list.scrollTop=0)`);
      await pause(100);
      const start = await evaluate<SidebarReadback>(readScript); validate(start);
      assert.ok(start.lists[1].scrollHeight > start.lists[1].clientHeight, 'Many synthetic providers must exercise provider scrolling');
      await evaluate(`document.querySelector('[data-sidebar-scroll="tools"]').scrollTop=1e6`);
      const toolsBottom = await evaluate<SidebarReadback>(readScript);
      assert.equal(toolsBottom.lists[1].top, start.lists[1].top, 'Scrolling tools must not move providers');
      assert.ok(toolsBottom.lists[0].lastVisible, 'The last tool is reachable inside the tool viewport');
      await clickVisible('.sidebar [data-tool-id="copilot"]');
      await waitFor(`!!document.querySelector('[data-tool-binding="copilot"]')`, 'Copilot tool navigation');
      await evaluate(`document.querySelector('[data-sidebar-scroll="providers"]').scrollTop=1e6`);
      const bottom = await evaluate<SidebarReadback>(readScript); validate(bottom);
      assert.equal(bottom.lists[0].top, toolsBottom.lists[0].top, 'Scrolling providers must not move tools');
      assert.ok(bottom.lists[1].lastVisible, 'The last provider is reachable inside the provider viewport');
      for (let index = 0; index < 2; index++) assert.ok(Math.abs(bottom.lists[index].label.top - start.lists[index].label.top) <= 1, 'Group labels remain fixed while their content scrolls');
      await clickVisible(`.sidebar [data-source-id="${last.id}"]`);
      await waitFor(`document.querySelector('.breadcrumbs')?.textContent.includes(${JSON.stringify(last.name)})`, 'last provider navigation');
      writeFileSync(join(outputDir, `electron-sidebar-scroll-${theme}-${requestedSize[0]}.png`), await captureUi());
      const wheels: WheelReadback[] = [];
      for (const section of ['tools', 'providers']) {
        // End the preceding native wheel gesture and let compositor hit-testing
        // observe both the changed viewport and the programmatic midpoint. The
        // synthetic events remain genuine Electron input, not DOM dispatches.
        await pause(600);
        await evaluate(`(()=>{const list=document.querySelector('[data-sidebar-scroll="${section}"]');list.scrollTop=(list.scrollHeight-list.clientHeight)/2;})()`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        await pause(100);
        const before = await evaluate<SidebarReadback>(readScript), index = section === 'tools' ? 0 : 1, list = before.lists[index], overflow = list.scrollHeight > list.clientHeight;
        const eventStart = await evaluate<number>('window.__modeldockSidebarWheelEvents.length');
        if (overflow) {
          const x = Math.round(list.box.left + list.box.width / 2), y = Math.round(list.box.top + list.box.height / 2);
          window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await pause(100);
          const hit = await evaluate<{ section: string; tag: string }>(`(()=>{const hit=document.elementFromPoint(${x},${y});return {section:hit?.closest('[data-sidebar-scroll]')?.dataset.sidebarScroll||'',tag:hit?.tagName||''};})()`);
          wheelInputs.push({ theme, requestedSize, section, point: { x, y, ...hit }, before, webContentsFocused: window.webContents.isFocused(), windowVisible: window.isVisible() });
          assert.equal(hit.section, section, 'Native wheel point must hit the intended list');
          window.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, canScroll: true });
          await waitFor(`Math.abs(document.querySelector('[data-sidebar-scroll="${section}"]').scrollTop-${list.top})>0.5`, `${section} receives native mouse wheel`);
        }
        const after = await evaluate<SidebarReadback>(readScript), moved = after.lists[index].top !== list.top, otherUnchanged = after.lists[1 - index].top === before.lists[1 - index].top;
        const events = await evaluate<WheelEventReadback[]>(`window.__modeldockSidebarWheelEvents.slice(${eventStart})`);
        assert.ok(otherUnchanged && (!overflow || moved), 'Native wheel scroll stays within the targeted list');
        if (overflow) assert.ok(events.some(event => event.section === section && event.deltaY !== 0 && event.trusted), 'Renderer receives a trusted native wheel event in the correct section');
        wheels.push({ section, moved, otherUnchanged, overflow, beforeTop: list.top, afterTop: after.lists[index].top, events });
      }
      layouts.push({ theme, requestedSize, start, bottom, wheels });
      assert.deepEqual(store.listBindings(), originalConfig.bindings, 'Sidebar navigation must not select sources or apply tools');
      assert.deepEqual(store.listModels(), originalConfig.models);
    }
  } catch (error) {
    writeFileSync(join(outputDir, 'sidebar-scroll-diagnostics.json'), JSON.stringify({ layouts, wheelInputs, events: await evaluate('window.__modeldockSidebarWheelEvents'), current: await evaluate(readScript) }, null, 2));
    writeFileSync(join(outputDir, 'electron-sidebar-scroll-failure.png'), await captureUi());
    throw error;
  } finally {
    await evaluate(`document.removeEventListener('wheel',window.__modeldockSidebarWheelHandler,{capture:true});delete window.__modeldockSidebarWheelHandler;delete window.__modeldockSidebarWheelEvents`);
    for (const provider of created) store.deleteProvider(provider.id);
    window.setMinimumSize(originalMinimum[0], originalMinimum[1]); window.setSize(originalSize[0], originalSize[1]);
    await evaluate(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
    await waitFor(`!document.querySelector('.sidebar [data-source-id="${created.at(-1)?.id ?? 'not-created'}"]')`, 'synthetic providers removed');
    await restoreUi(); await pause(75);
    assert.deepEqual(config(), originalConfig, 'All synthetic fixture rows must be removed without changing the original managed configuration');
    assert.deepEqual(await evaluate<UiState>(stateScript), originalUi, 'Sidebar verification restores theme, navigation and scroll position');
    const afterSize = window.getSize(), tolerance = process.platform === 'win32' ? 1 : 0;
    assert.ok(afterSize.every((value, index) => Math.abs(value - originalSize[index]) <= tolerance), 'Window size is restored within native DPI rounding');
  }
  writeFileSync(join(outputDir, 'sidebar-scroll-validation.json'), JSON.stringify({ ok: true, independentScroll: true, configurationUnchanged: true, syntheticProviders: created.length, layouts, originalUiRestored: true, configApplyInvoked: false }, null, 2));
}
