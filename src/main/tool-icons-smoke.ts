import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

const toolIds = ['codex', 'claude-code', 'opencode', 'dsh', 'vscode', 'copilot', 'webstorm', 'intellij-idea', 'rider', 'pycharm'] as const;

interface IconReadback {
  tool: string;
  ariaHidden: boolean;
  visible: boolean;
  width: number;
  height: number;
  markWidth: number;
  markHeight: number;
  localResource: boolean;
  decoded: boolean;
  source: string;
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
  const original = await evaluate<{ theme?: string; colorScheme: string; navigation: Record<string, string>; settings: unknown; scroll: Record<string, number> }>(`(async()=>{
    const root=document.documentElement,active=document.querySelector('.sidebar [aria-current="page"]');
    return {theme:root.dataset.theme,colorScheme:root.style.colorScheme,navigation:active?Object.fromEntries([...active.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value])):{},settings:await window.modelDock.getSettings(),scroll:Object.fromEntries([...document.querySelectorAll('[data-sidebar-scroll]')].map(el=>[el.dataset.sidebarScroll,el.scrollTop]))};
  })()`);
  const layouts: Array<{ theme: string; width: number; height: number; viewport: { width: number; height: number }; sidebar: IconReadback[]; header: IconReadback; documentOverflow: boolean }> = [];
  let restored = false;
  let restoredSize: number[] | undefined;
  const sizeTolerance = process.platform === 'win32' ? 1 : 0;
  try {
    await evaluate(`document.querySelector('.sidebar [data-page="tools"][data-tool-id="copilot"]').click()`);
    await waitFor(`!!document.querySelector('[data-tool-binding="copilot"] .tool-logo[data-tool-icon="copilot"]')`, 'Copilot summary icon');
    for (const theme of ['light', 'dark']) {
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};})()`);
      for (const [width, height] of [[1320, 880], [980, 680]]) {
        window.setSize(width, height);
        await pause(100);
        const value = await evaluate<{ viewport: { width: number; height: number }; sidebar: IconReadback[]; header: IconReadback; documentOverflow: boolean }>(`(async()=>{
          const read=async(icon)=>{
            if(!icon)throw new Error('Tool logo container is missing');
            const mark=icon.querySelector('.tool-logo-mark');
            if(!mark)throw new Error('Tool logo mark is missing');
            const box=icon.getBoundingClientRect(),markBox=mark.getBoundingClientRect(),css=getComputedStyle(mark);
            const mask=css.maskImage||css.webkitMaskImage;
            const match=/^url\\((?:"([^\"]+)"|'([^']+)'|([^)]*))\\)$/.exec(mask);
            if(!match)throw new Error('Tool logo does not have a URL mask');
            const url=new URL(match[1]||match[2]||match[3],document.baseURI),base=new URL(document.baseURI);
            const localResource=url.protocol==='file:'&&base.protocol==='file:'||url.origin===base.origin&&url.protocol==='http:'&&url.hostname==='127.0.0.1';
            if(!localResource)throw new Error('Tool logo resource must be packaged locally');
            const image=new Image();image.src=url.href;
            let timer;
            try{await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Tool logo resource could not be decoded')),3000);})]);}finally{clearTimeout(timer);}
            const decoded=image.naturalWidth>0&&image.naturalHeight>0;
            let withinClip=true;
            for(let parent=icon.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(/^(?:auto|scroll|hidden|clip)$/.test(style.overflowY)){const clip=parent.getBoundingClientRect();if(box.top<clip.top-1||box.bottom>clip.bottom+1)withinClip=false;}}
            return {tool:icon.dataset.toolIcon,ariaHidden:icon.getAttribute('aria-hidden')==='true',visible:withinClip&&css.display!=='none'&&css.visibility==='visible'&&Number(css.opacity)>0&&box.top>=0&&box.bottom<=innerHeight+1&&box.left>=0&&box.right<=innerWidth+1,width:box.width,height:box.height,markWidth:markBox.width,markHeight:markBox.height,localResource,decoded,source:url.pathname.split('/').pop()};
          };
          const buttons=[...document.querySelectorAll('.sidebar [data-page="tools"][data-tool-id]')];
          // Each brand must decode and be reachable within its own list. A
          // compact viewport may legitimately require scrolling to the fifth
          // tool; reading every logo at the same scroll position hides clipping.
          const sidebar=[];
          for(const button of buttons){button.scrollIntoView({block:'nearest',inline:'nearest'});sidebar.push(await read(button.querySelector('.tool-logo')));}
          const header=await read(document.querySelector('[data-tool-binding="copilot"] .tool-logo[data-tool-icon="copilot"]'));
          return {viewport:{width:innerWidth,height:innerHeight},sidebar,header,documentOverflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        assert.deepEqual(value.sidebar.map(icon => icon.tool), [...toolIds], 'Five tool navigation buttons must show the matching logos');
        for (const icon of [...value.sidebar, value.header]) {
          assert.ok(icon.ariaHidden && icon.visible && icon.decoded && icon.localResource, `Tool logo must be visible, decorative and locally decoded: ${icon.tool}`);
          assert.ok(icon.width > 0 && icon.height > 0 && icon.markWidth > 0 && icon.markHeight > 0, `Tool logo must have visible dimensions: ${icon.tool}`);
        }
        assert.equal(value.header.tool, 'copilot');
        assert.equal(value.documentOverflow, false, 'Tool logos must not introduce horizontal document overflow');
        layouts.push({ theme, width, height, ...value });
        writeFileSync(join(outputDir, `electron-tool-icons-${theme}-${width}.png`), await captureUi());
      }
    }
  } finally {
    window.setSize(size[0], size[1]);
    await evaluate(`(()=>{
      const original=${JSON.stringify(original)};
      if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;
      document.documentElement.style.colorScheme=original.colorScheme;
      const entries=Object.entries(original.navigation);
      if(entries.length){const nav=[...document.querySelectorAll('.sidebar [aria-current],.sidebar [data-page]')].find(el=>entries.every(([name,value])=>el.getAttribute(name)===value));if(nav)nav.click();}
      for(const [name,top] of Object.entries(original.scroll)){const list=document.querySelector('[data-sidebar-scroll="'+name+'"]');if(list)list.scrollTop=top;}
    })()`);
    await pause(50);
    const after = await evaluate<{ theme?: string; colorScheme: string; navigation: Record<string, string>; settings: unknown; scroll: Record<string, number> }>(`(async()=>{
      const root=document.documentElement,active=document.querySelector('.sidebar [aria-current="page"]');
      return {theme:root.dataset.theme,colorScheme:root.style.colorScheme,navigation:active?Object.fromEntries([...active.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value])):{},settings:await window.modelDock.getSettings(),scroll:Object.fromEntries([...document.querySelectorAll('[data-sidebar-scroll]')].map(el=>[el.dataset.sidebarScroll,el.scrollTop]))};
    })()`);
    assert.deepEqual(after, original, 'Icon validation must restore theme/navigation without saving settings');
    restoredSize = window.getSize();
    assert.ok(restoredSize.every((value, index) => Math.abs(value - size[index]) <= sizeTolerance), 'Icon validation must restore the window size within Win32 DPI rounding');
    restored = true;
  }
  writeFileSync(join(outputDir, 'tool-icons-validation.json'), JSON.stringify({ tools: [...toolIds], layouts, originalUiRestored: restored, windowSize: { before: size, after: restoredSize, tolerancePixels: sizeTolerance }, savedSettingsUnchanged: true, configurationSyncInvoked: false }, null, 2));
}
