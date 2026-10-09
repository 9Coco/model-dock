import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

const toolIds = ['codex', 'claude-code', 'opencode', 'dsh', 'vscode', 'copilot', 'webstorm', 'intellij-idea', 'rider', 'pycharm'] as const;
const jetBrainsIds = ['webstorm', 'intellij-idea', 'rider', 'pycharm'] as const;

interface IconReadback {
  tool: string;
  renderMode: 'image' | 'mask';
  ariaHidden: boolean;
  emptyAlt: boolean;
  visible: boolean;
  width: number;
  height: number;
  markWidth: number;
  markHeight: number;
  scale: number;
  localResource: boolean;
  complete: boolean;
  decoded: boolean;
  naturalWidth: number;
  naturalHeight: number;
  filter: string;
  containerFilter: string;
  source: string;
}

interface LayoutReadback {
  theme: string;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  sidebar: IconReadback[];
  headers: IconReadback[];
  allToolsVisibleTogether: boolean;
  documentOverflow: boolean;
  screenshots: string[];
}

/** Read-only visual validation; temporary DOM theme changes never save settings. */
export async function verifyToolIcons(window: BrowserWindow, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.ok(process.env.MODELDOCK_SMOKE, 'Tool icon validation is restricted to a smoke window');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    throw new Error(`Tool icon validation timed out: ${label}`);
  }
  await waitFor(`!!document.querySelector('.app-shell')&&document.querySelectorAll('.sidebar [data-page="tools"][data-tool-id]').length===10`, 'tool navigation');
  const size = window.getSize();
  const uiSnapshot = `(async()=>{
    const root=document.documentElement,active=document.querySelector('.sidebar [aria-current="page"]');
    return {theme:root.dataset.theme,colorScheme:root.style.colorScheme,navigation:active?Object.fromEntries([...active.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value])):{},settings:await window.modelDock.getSettings(),bindings:(await window.modelDock.snapshot()).bindings,scroll:Object.fromEntries([...document.querySelectorAll('[data-sidebar-scroll]')].map(el=>[el.dataset.sidebarScroll,el.scrollTop]))};
  })()`;
  const original = await evaluate<{ theme?: string; colorScheme: string; navigation: Record<string, string>; settings: unknown; bindings: unknown; scroll: Record<string, number> }>(uiSnapshot);
  // Read the actual <img> for color logos and independently decode a mask's local
  // asset. This catches successful mask loading that would hide an image error.
  const readIcon = `async(icon)=>{
    if(!icon)throw new Error('Tool logo container is missing');
    const element=icon.querySelector('.tool-logo-image'),mark=element||icon.querySelector('.tool-logo-mark');
    if(!mark)throw new Error('Tool logo render source is missing');
    const box=icon.getBoundingClientRect(),markBox=mark.getBoundingClientRect(),css=getComputedStyle(mark);
    const mask=css.maskImage||css.webkitMaskImage,match=/^url\\((?:"([^\"]+)"|'([^']+)'|([^)]*))\\)$/.exec(mask);
    if(!element&&!match)throw new Error('Tool logo does not have a URL mask');
    const url=new URL(element?(element.currentSrc||element.src):(match[1]||match[2]||match[3]),document.baseURI),base=new URL(document.baseURI);
    const localResource=url.protocol==='file:'&&base.protocol==='file:'||url.origin===base.origin&&url.protocol==='http:'&&url.hostname==='127.0.0.1';
    if(!localResource)throw new Error('Tool logo resource must be packaged locally');
    const image=element||new Image();if(!element)image.src=url.href;
    let timer;
    try{await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Tool logo resource could not be decoded')),3000);})]);}finally{clearTimeout(timer);}
    const decoded=image.naturalWidth>0&&image.naturalHeight>0;
    let withinClip=true;
    for(let parent=icon.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(/^(?:auto|scroll|hidden|clip)$/.test(style.overflowY)){const clip=parent.getBoundingClientRect();if(box.top<clip.top-1||box.bottom>clip.bottom+1)withinClip=false;}}
    return {tool:icon.dataset.toolIcon,renderMode:element?'image':'mask',ariaHidden:icon.getAttribute('aria-hidden')==='true',emptyAlt:!element||element.getAttribute('alt')==='',visible:withinClip&&css.display!=='none'&&css.visibility==='visible'&&Number(css.opacity)>0&&box.top>=0&&box.bottom<=innerHeight+1&&box.left>=0&&box.right<=innerWidth+1,width:box.width,height:box.height,markWidth:markBox.width,markHeight:markBox.height,scale:markBox.width/box.width,localResource,complete:image.complete,decoded,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,filter:css.filter,containerFilter:getComputedStyle(icon).filter,source:url.href};
  }`;
  const layouts: LayoutReadback[] = [];
  let restored = false;
  let restoredSize: number[] | undefined;
  const sizeTolerance = process.platform === 'win32' ? 1 : 0;
  async function selectTool(tool: string): Promise<void> {
    await evaluate(`document.querySelector('.sidebar [data-page="tools"][data-tool-id=${JSON.stringify(tool)}]').click()`);
    await waitFor(`!!document.querySelector('[data-tool-binding=${JSON.stringify(tool)}] .tool-logo[data-tool-icon=${JSON.stringify(tool)}]')`, `${tool} summary icon`);
  }
  function assertIcon(icon: IconReadback): void {
    assert.ok(icon.ariaHidden && icon.emptyAlt && icon.visible && icon.complete && icon.decoded && icon.localResource, `Tool logo must be visible, decorative and locally decoded: ${icon.tool}`);
    assert.ok(icon.width > 0 && icon.height > 0 && icon.markWidth > 0 && icon.markHeight > 0, `Tool logo must have visible dimensions: ${icon.tool}`);
    const asset = decodeURIComponent(new URL(icon.source).pathname).split('/').pop()!;
    assert.ok(asset.startsWith(`${icon.tool}.`) || asset.startsWith(`${icon.tool}-`), `Tool logo source must belong to its ToolId: ${icon.tool}`);
    const isJetBrains = (jetBrainsIds as readonly string[]).includes(icon.tool);
    assert.equal(icon.renderMode, isJetBrains ? 'image' : 'mask', `Tool logo must use its intended color/mask source: ${icon.tool}`);
    if (isJetBrains) {
      assert.equal(icon.filter, 'none', `JetBrains logo must preserve its original colors: ${icon.tool}`);
      assert.equal(icon.containerFilter, 'none', `JetBrains container must preserve its original colors: ${icon.tool}`);
      assert.ok(Math.abs(icon.markWidth - icon.markHeight) < 0.1, `JetBrains logo must retain square proportions: ${icon.tool}`);
      assert.equal(icon.naturalWidth, icon.naturalHeight, `JetBrains source must retain square proportions: ${icon.tool}`);
    }
  }
  try {
    for (const theme of ['light', 'dark']) {
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};})()`);
      // The tall view proves all ten navigation logos can be shown together.
      // The two ordinary viewports also prove every logo remains reachable.
      for (const [width, height] of [[1320, 1440], [1320, 880], [980, 680]]) {
        window.setSize(width, height);
        await pause(100);
        const value = await evaluate<{ viewport: { width: number; height: number }; sidebar: IconReadback[]; allToolsVisibleTogether: boolean; documentOverflow: boolean }>(`(async()=>{
          const read=${readIcon},buttons=[...document.querySelectorAll('.sidebar [data-page="tools"][data-tool-id]')],sidebar=[];
          for(const button of buttons){button.scrollIntoView({block:'nearest',inline:'nearest'});sidebar.push(await read(button.querySelector('.tool-logo')));}
          document.querySelector('[data-sidebar-scroll="tools"]').scrollTop=0;
          const together=await Promise.all(buttons.map(button=>read(button.querySelector('.tool-logo'))));
          return {viewport:{width:innerWidth,height:innerHeight},sidebar,allToolsVisibleTogether:together.every(icon=>icon.visible),documentOverflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        assert.deepEqual(value.sidebar.map(icon => icon.tool), [...toolIds], 'Ten tool navigation buttons must show their matching logos');
        value.sidebar.forEach(assertIcon);
        assert.equal(new Set(value.sidebar.map(icon => icon.source)).size, toolIds.length, 'Every tool must use its own logo resource');
        assert.equal(value.documentOverflow, false, 'Tool logos must not introduce horizontal document overflow');
        if (height === 1440) assert.ok(value.allToolsVisibleTogether, 'Tall overview must display all ten tools together');
        const headers: IconReadback[] = [];
        const screenshots: string[] = [];
        for (const tool of toolIds) {
          await selectTool(tool);
          const header = await evaluate<IconReadback>(`(${readIcon})(document.querySelector('[data-tool-binding=${JSON.stringify(tool)}] .tool-logo[data-tool-icon=${JSON.stringify(tool)}]'))`);
          assertIcon(header);
          assert.equal(header.tool, tool, 'Detail header must show the selected tool logo');
          const sidebar = value.sidebar.find(icon => icon.tool === tool)!;
          assert.equal(header.source, sidebar.source, `Header and sidebar must use the same logo resource: ${tool}`);
          if ((jetBrainsIds as readonly string[]).includes(tool)) assert.ok(Math.abs(header.scale - sidebar.scale) < 0.01, `JetBrains header/sidebar logo proportions must match: ${tool}`);
          headers.push(header);
          if (height === 880 && (jetBrainsIds as readonly string[]).includes(tool)) {
            const screenshot = `electron-tool-icons-${theme}-${tool}-detail.png`;
            writeFileSync(join(outputDir, screenshot), await captureUi());
            screenshots.push(screenshot);
          }
        }
        const brandedHeaders = headers.filter(icon => (jetBrainsIds as readonly string[]).includes(icon.tool));
        assert.ok(brandedHeaders.every(icon => Math.abs(icon.scale - brandedHeaders[0].scale) < 0.01), 'Four JetBrains logos must have the same relative size');
        await selectTool('webstorm');
        if (height === 1440) await evaluate(`document.querySelector('[data-sidebar-scroll="tools"]').scrollTop=0`);
        const screenshot = height === 1440 ? `electron-tool-icons-${theme}-all-ten.png` : `electron-tool-icons-${theme}-${width}.png`;
        writeFileSync(join(outputDir, screenshot), await captureUi());
        screenshots.push(screenshot);
        layouts.push({ theme, width, height, ...value, headers, screenshots });
      }
    }
  } finally {
    window.setSize(size[0], size[1]);
    await evaluate(`(()=>{
      const original=${JSON.stringify({ theme: original.theme, colorScheme: original.colorScheme, navigation: original.navigation, scroll: original.scroll })};
      if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;
      document.documentElement.style.colorScheme=original.colorScheme;
      const entries=Object.entries(original.navigation);
      if(entries.length){const nav=[...document.querySelectorAll('.sidebar [aria-current],.sidebar [data-page]')].find(el=>entries.every(([name,value])=>el.getAttribute(name)===value));if(nav)nav.click();}
      for(const [name,top] of Object.entries(original.scroll)){const list=document.querySelector('[data-sidebar-scroll="'+name+'"]');if(list)list.scrollTop=top;}
    })()`);
    await pause(50);
    const after = await evaluate<typeof original>(uiSnapshot);
    assert.deepEqual(after, original, 'Icon validation must restore theme/navigation without saving settings or changing tool selections');
    restoredSize = window.getSize();
    assert.ok(restoredSize.every((value, index) => Math.abs(value - size[index]) <= sizeTolerance), 'Icon validation must restore the window size within Win32 DPI rounding');
    restored = true;
  }
  writeFileSync(join(outputDir, 'tool-icons-validation.json'), JSON.stringify({ tools: [...toolIds], jetBrainsTools: [...jetBrainsIds], layouts, originalUiRestored: restored, windowSize: { before: size, after: restoredSize, tolerancePixels: sizeTolerance }, savedSettingsUnchanged: true, toolSelectionsUnchanged: true, configurationSyncInvoked: false }, null, 2));
}
