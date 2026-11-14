import { createHash } from 'node:crypto';
import { toolCategories, toolCategoryFor } from '../shared/tool-categories';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { ConfigPreview, Snapshot, ToolBinding, ToolId } from '../shared/types';

const toolIds = ['codex', 'claude-code', 'junie', 'opencode', 'opencode-desktop', 'dsh', 'vscode', 'copilot', 'copilot-cli', 'webstorm', 'intellij-idea', 'rider', 'pycharm'] as const;
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
  allToolsVisibleInCategory: boolean;
  categories: { category: string; tools: string[]; allVisible: boolean }[];
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
  await waitFor(`!!document.querySelector('.app-shell')&&document.querySelectorAll('.sidebar [data-page="tools"][data-tool-id]').length===${toolIds.length}`, 'tool navigation');
  const size = window.getSize();
  const uiSnapshot = `(async()=>{
    const root=document.documentElement,active=document.querySelector('.sidebar [aria-current="page"]');
    return {theme:root.dataset.theme,colorScheme:root.style.colorScheme,navigation:active?Object.fromEntries([...active.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value])):{},settings:await window.modelDock.getSettings(),bindings:(await window.modelDock.snapshot()).bindings,toolCategory:document.querySelector('[data-tool-category][aria-selected="true"]')?.dataset.toolCategory,scroll:Object.fromEntries([...document.querySelectorAll('[data-sidebar-scroll]')].map(el=>[el.dataset.sidebarScroll,el.scrollTop]))};
  })()`;
  const original = await evaluate<{ theme?: string; colorScheme: string; navigation: Record<string, string>; toolCategory?: string; settings: unknown; bindings: ToolBinding[]; scroll: Record<string, number> }>(uiSnapshot);
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
  let junieBindingToRestore: ToolBinding | undefined;
  let juniePreview: { canApply: boolean; keyRedacted: boolean; fullEndpoint: boolean; ideEntryExplained: boolean; externalSyncInvoked: false } | undefined;
  let copilotCliBindingToRestore: ToolBinding | undefined;
  let copilotCliPreview: { canApply: boolean; keyRedacted: boolean; nativeEndpoint: boolean; qualifiedDefault: boolean; externalSyncInvoked: false } | undefined;
  let restoredSize: number[] | undefined;
  const sizeTolerance = process.platform === 'win32' ? 1 : 0;
  async function selectTool(tool: ToolId): Promise<void> {
    const category = toolCategoryFor(tool);
    await evaluate(`document.querySelector('[data-tool-category="${category}"]').click()`);
    await waitFor(`document.querySelector('[data-tool-category="${category}"]')?.getAttribute('aria-selected')==='true'`, `${category} tool category`);
    await evaluate(`document.querySelector('.sidebar [data-page="tools"][data-tool-id=${JSON.stringify(tool)}]').click()`);
    await waitFor(`!!document.querySelector('[data-tool-binding=${JSON.stringify(tool)}] .tool-logo[data-tool-icon=${JSON.stringify(tool)}]')`, `${tool} summary icon`);
  }
  function assertIcon(icon: IconReadback): void {
    assert.ok(icon.ariaHidden && icon.emptyAlt && icon.visible && icon.complete && icon.decoded && icon.localResource, `Tool logo must be visible, decorative and locally decoded: ${icon.tool}`);
    assert.ok(icon.width > 0 && icon.height > 0 && icon.markWidth > 0 && icon.markHeight > 0, `Tool logo must have visible dimensions: ${icon.tool}`);
    const asset = decodeURIComponent(new URL(icon.source).pathname).split('/').pop()!;
    const identity = icon.tool === 'copilot-cli' ? 'copilot' : icon.tool === 'opencode-desktop' ? 'opencode' : icon.tool;
    assert.ok(asset.startsWith(`${identity}.`) || asset.startsWith(`${identity}-`), `Tool logo source must match its official product identity: ${icon.tool}`);
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
      // The tall view proves all tools fit within each category. The ordinary
      // viewports prove both tabs and all twelve tool identities remain reachable.
      for (const [width, height] of [[1320, 1440], [1320, 880], [980, 680]]) {
        window.setSize(width, height);
        await pause(100);
        const value = await evaluate<{ viewport: { width: number; height: number }; sidebar: IconReadback[]; allToolsVisibleInCategory: boolean;
  categories: { category: string; tools: string[]; allVisible: boolean }[]; documentOverflow: boolean }>(`(async()=>{
          const read=${readIcon},sidebar=[],categories=[];
          for(const tab of document.querySelectorAll('[data-tool-category]')){
            tab.click();await new Promise(resolve=>requestAnimationFrame(resolve));
            const buttons=[...document.querySelectorAll('.tool-category-panel:not([hidden]) [data-page="tools"][data-tool-id]')];
            for(const button of buttons){button.scrollIntoView({block:'nearest',inline:'nearest'});sidebar.push(await read(button.querySelector('.tool-logo')));}
            document.querySelector('[data-sidebar-scroll="tools"]').scrollTop=0;
            const together=await Promise.all(buttons.map(button=>read(button.querySelector('.tool-logo'))));
            categories.push({category:tab.dataset.toolCategory,tools:buttons.map(button=>button.dataset.toolId),allVisible:together.every(icon=>icon.visible)});
          }
          return {viewport:{width:innerWidth,height:innerHeight},sidebar,categories,allToolsVisibleInCategory:categories.every(value=>value.allVisible),documentOverflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        assert.deepEqual(value.sidebar.map(icon => icon.tool), toolCategories.flatMap(category => toolIds.filter(tool => toolCategoryFor(tool) === category.id)), 'Thirteen tool navigation buttons must show their matching logos in category order');
        value.sidebar.forEach(assertIcon);
        assert.equal(new Set(value.sidebar.map(icon => icon.source)).size, toolIds.length - 2, 'OpenCode and Copilot share their respective Desktop/TUI logos');
        assert.equal(value.sidebar.find(icon => icon.tool === 'copilot-cli')?.source, value.sidebar.find(icon => icon.tool === 'copilot')?.source, 'Both Copilot tools use the same official product logo');
        assert.equal(value.documentOverflow, false, 'Tool logos must not introduce horizontal document overflow');
        assert.deepEqual(value.categories.map(category => category.category), ['editor', 'tui', 'desktop'], 'Three product categories remain available');
        assert.deepEqual(value.categories.map(category => category.tools.length), [5, 4, 4], 'Product category counts match their tools');
        if (height === 1440) assert.ok(value.allToolsVisibleInCategory, 'Tall overview must display all tools together within each category');
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
          if (tool === 'junie') {
            const entries = await evaluate<{ cli: boolean; ide: boolean; mode: boolean; preview: boolean; restore: boolean }>(`(()=>{const guide=document.querySelector('[data-junie-entry-guide]');return {cli:guide?.textContent.includes('junie --model custom:modeldock')===true,ide:guide?.textContent.includes('Junie · ModelDock')===true,mode:!!document.querySelector('[data-tool-binding="junie"] [data-action="tool-use-aggregate"]'),preview:!!document.querySelector('[data-tool-binding="junie"] [data-action="preview-tool-config"]'),restore:!!document.querySelector('[data-tool-binding="junie"] [data-action="restore-official-tool-config"]')}})()`);
            assert.deepEqual(entries, { cli: true, ide: true, mode: true, preview: true, restore: true }, 'Junie exposes its terminal and separate IDE ACP entry with the shared connection controls');
          }
          if (tool === 'copilot-cli') {
            const entries = await evaluate<{ cli: boolean; independent: boolean; mode: boolean; preview: boolean; apply: boolean; restore: boolean }>(`(()=>{const guide=document.querySelector('[data-copilot-cli-entry-guide]');return {cli:guide?.textContent.includes('/model')===true,independent:guide?.textContent.includes('无需打开 Copilot app')===true,mode:!!document.querySelector('[data-tool-binding="copilot-cli"] [data-action="tool-use-aggregate"]'),preview:!!document.querySelector('[data-tool-binding="copilot-cli"] [data-action="preview-tool-config"]'),apply:!!document.querySelector('[data-tool-binding="copilot-cli"] [data-action="apply-tool-config"]'),restore:!!document.querySelector('[data-tool-binding="copilot-cli"] [data-action="restore-official-tool-config"]')}})()`);
            assert.deepEqual(entries, { cli: true, independent: true, mode: true, preview: true, apply: true, restore: true }, 'Copilot CLI has an independent terminal guide and shared configuration controls');
          }
          if (height === 880 && ((jetBrainsIds as readonly string[]).includes(tool) || tool === 'junie' || tool === 'copilot-cli' || tool === 'opencode-desktop')) {
            const screenshot = `electron-tool-icons-${theme}-${tool}-detail.png`;
            writeFileSync(join(outputDir, screenshot), await captureUi());
            screenshots.push(screenshot);
          }
        }
        const brandedHeaders = headers.filter(icon => (jetBrainsIds as readonly string[]).includes(icon.tool));
        assert.ok(brandedHeaders.every(icon => Math.abs(icon.scale - brandedHeaders[0].scale) < 0.01), 'Four JetBrains logos must have the same relative size');
        for (const category of ['editor', 'tui', 'desktop']) {
          await selectTool(category === 'desktop' ? 'opencode-desktop' : category === 'tui' ? 'opencode' : 'webstorm');
          if (height === 1440) await evaluate(`document.querySelector('[data-sidebar-scroll="tools"]').scrollTop=0`);
          const screenshot = `electron-tool-icons-${theme}-${category}-${width}-${height}.png`;
          writeFileSync(join(outputDir, screenshot), await captureUi());
          screenshots.push(screenshot);
        }
        layouts.push({ theme, width, height, ...value, headers, screenshots });
      }
    }
    // Preview only: the temporary binding lives in this fresh synthetic profile.
    // No apply/export action or external configuration write is invoked.
    const fixture = await evaluate<Snapshot>('window.modelDock.snapshot()');
    const model = fixture.models.find(item => item.enabled && ['responses', 'chat-completions'].includes(item.wireApi)
      && fixture.providers.some(provider => provider.id === item.providerId && provider.enabled && provider.kind === 'openai-compatible' && provider.hasSecret && provider.authStatus === 'ready'));
    assert.ok(model, 'Junie preview requires an existing synthetic API fixture');
    junieBindingToRestore = fixture.bindings.find(binding => binding.id === 'junie');
    assert.ok(junieBindingToRestore, 'Junie is present in the isolated bindings');
    const temporary = { ...junieBindingToRestore, enabled: true, mode: 'direct', providerIds: [model.providerId], modelIds: [], defaultModelId: model.id };
    await evaluate(`window.modelDock.saveBinding(${JSON.stringify(temporary)})`);
    await evaluate(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
    await selectTool('junie');
    await waitFor(`document.querySelector('[data-tool-binding="junie"] [data-action="tool-default-model"]')?.value===${JSON.stringify(model.id)}`, 'Junie synthetic selection rendered');
    const preview = await evaluate<ConfigPreview>(`window.modelDock.previewConfig('junie')`);
    const content = JSON.parse(preview.content);
    assert.equal(content.profile.id, model.upstreamId);
    assert.equal(content.profile.apiKey, '__PROVIDER_API_KEY__');
    assert.equal(content.profile.apiType, model.wireApi === 'responses' ? 'OpenAIResponses' : 'OpenAICompletion');
    assert.ok(content.profile.baseUrl.endsWith(model.wireApi === 'responses' ? '/responses' : '/chat/completions'));
    assert.ok(preview.instructions.includes('Junie · ModelDock'));
    await evaluate(`document.querySelector('[data-tool-binding="junie"] [data-action="preview-tool-config"]').click()`);
    await waitFor(`document.querySelector('[role="dialog"] .config-code')?.textContent.includes('__PROVIDER_API_KEY__')===true`, 'Junie React preview redacts credentials');
    writeFileSync(join(outputDir, 'electron-junie-config-preview.png'), await captureUi());
    await evaluate(`document.querySelector('[aria-label="关闭对话框"]').click()`);
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'Junie preview closed');
    juniePreview = { canApply: preview.canApply, keyRedacted: true, fullEndpoint: true, ideEntryExplained: true, externalSyncInvoked: false };

    copilotCliBindingToRestore = fixture.bindings.find(binding => binding.id === 'copilot-cli');
    assert.ok(copilotCliBindingToRestore, 'Copilot CLI has its own isolated binding');
    await evaluate(`window.modelDock.saveBinding(${JSON.stringify({ ...copilotCliBindingToRestore, enabled: true, mode: 'direct', providerIds: [model.providerId], modelIds: [], defaultModelId: model.id })})`);
    await evaluate(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
    await selectTool('copilot-cli');
    await waitFor(`document.querySelector('[data-tool-binding="copilot-cli"] [data-action="tool-default-model"]')?.value===${JSON.stringify(model.id)}`, 'Copilot CLI synthetic selection rendered');
    const cliPreview = await evaluate<ConfigPreview>(`window.modelDock.previewConfig('copilot-cli')`);
    const cliContent = JSON.parse(cliPreview.content) as { providers: { name: string; type: string; baseUrl: string; wireApi: string; apiKey: string }[]; models: { id: string; provider: string; wireModel: string }[]; settings: { model: string } };
    const providerName = `modeldock-${createHash('sha256').update(model.providerId).digest('hex').slice(0, 24)}-${model.wireApi === 'responses' ? 'responses' : 'chat'}`;
    const nativeProvider = cliContent.providers.find(provider => provider.name === providerName);
    assert.ok(nativeProvider, 'Copilot CLI preview includes the default model protocol');
    assert.equal(nativeProvider.type, 'openai');
    assert.equal(nativeProvider.apiKey, '__PROVIDER_API_KEY__');
    assert.equal(nativeProvider.wireApi, model.wireApi === 'responses' ? 'responses' : 'completions');
    assert.equal(nativeProvider.baseUrl, fixture.providers.find(provider => provider.id === model.providerId)!.baseUrl.replace(/\/+$/, ''));
    assert.ok(cliContent.models.some(entry => entry.id === model.upstreamId && entry.wireModel === model.upstreamId && entry.provider === providerName));
    assert.equal(cliContent.settings.model, `${providerName}/${model.upstreamId}`);
    assert.equal(cliPreview.filename, 'modeldock-copilot-cli.json');
    assert.ok(cliPreview.instructions.includes(`copilot --model ${cliContent.settings.model}`));
    await evaluate(`document.querySelector('[data-tool-binding="copilot-cli"] [data-action="preview-tool-config"]').click()`);
    await waitFor(`document.querySelector('[role="dialog"] .config-code')?.textContent.includes('__PROVIDER_API_KEY__')===true&&document.querySelector('[role="dialog"] .config-code')?.textContent.includes(${JSON.stringify(cliContent.settings.model)})===true`, 'Copilot CLI React preview shows a redacted key and qualified default');
    writeFileSync(join(outputDir, 'electron-copilot-cli-config-preview.png'), await captureUi());
    await evaluate(`document.querySelector('[aria-label="关闭对话框"]').click()`);
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'Copilot CLI preview closed');
    copilotCliPreview = { canApply: cliPreview.canApply, keyRedacted: true, nativeEndpoint: true, qualifiedDefault: true, externalSyncInvoked: false };
  } finally {
    if (junieBindingToRestore || copilotCliBindingToRestore) {
      for (const binding of [junieBindingToRestore, copilotCliBindingToRestore]) if (binding) await evaluate(`window.modelDock.saveBinding(${JSON.stringify(binding)})`);
      await evaluate(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
      await pause(80);
    }
    window.setSize(size[0], size[1]);
    await evaluate(`(()=>{
      const original=${JSON.stringify({ theme: original.theme, colorScheme: original.colorScheme, navigation: original.navigation, scroll: original.scroll })};
      if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;
      document.documentElement.style.colorScheme=original.colorScheme;
      const entries=Object.entries(original.navigation);
      if(entries.length){const nav=[...document.querySelectorAll('.sidebar [aria-current],.sidebar [data-page]')].find(el=>entries.every(([name,value])=>el.getAttribute(name)===value));if(nav)nav.click();}
    })()`);
    await pause(50);
    await evaluate(`(()=>{const category=${JSON.stringify(original.toolCategory)};if(category)document.querySelector('[data-tool-category="'+category+'"]')?.click();})()`);
    await pause(25);
    await evaluate(`(()=>{const scroll=${JSON.stringify(original.scroll)};for(const [name,top] of Object.entries(scroll)){const list=document.querySelector('[data-sidebar-scroll="'+name+'"]');if(list)list.scrollTop=top;}})()`);
    const after = await evaluate<typeof original>(uiSnapshot);
    assert.deepEqual(after, original, 'Icon validation must restore theme/navigation without saving settings or changing tool selections');
    restoredSize = window.getSize();
    assert.ok(restoredSize.every((value, index) => Math.abs(value - size[index]) <= sizeTolerance), 'Icon validation must restore the window size within Win32 DPI rounding');
    restored = true;
  }
  writeFileSync(join(outputDir, 'tool-icons-validation.json'), JSON.stringify({ tools: [...toolIds], jetBrainsTools: [...jetBrainsIds], layouts, juniePreview, copilotCliPreview, originalUiRestored: restored, windowSize: { before: size, after: restoredSize, tolerancePixels: sizeTolerance }, savedSettingsUnchanged: true, toolSelectionsUnchanged: true, configurationSyncInvoked: false }, null, 2));
}
