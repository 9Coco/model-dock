import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Model, Provider, Snapshot } from '../shared/types';
import type { DiscoveryResult } from '../shared/catalog-types';

/** Native renderer verification with synthetic credentials and an isolated profile. */
export async function verifyModelMetadata(window: BrowserWindow, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_METADATA_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream);
  assert.equal(resolve(outputDir), resolve(smokeDir));
  const path = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(path && !path.startsWith('..') && !/^[A-Za-z]:/.test(path));
  const url = new URL(upstream);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/metadata/v1');
  assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash);
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Model metadata smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(button.disabled)throw new Error('Metadata control disabled');button.click()})()`);
  }
  const initial = await evaluate<Snapshot>('window.modelDock.snapshot()');
  assert.equal(resolve(initial.dataDir), resolve(dataDir));
  const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '模型测试套餐', kind: 'openai-compatible', presetId: 'custom', baseUrl: upstream, enabled: true, apiKey: 'synthetic-only' })})`);
  const discovered = await evaluate<DiscoveryResult>(`window.modelDock.discoverModels(${JSON.stringify(provider.id)})`);
  assert.equal(discovered.ok, true);
  const gpt4o = discovered.models.find(model => model.upstreamId === 'gpt-4o')!;
  assert.equal(gpt4o.contextWindow, 128000); assert.equal(gpt4o.vision, true);
  assert.ok(gpt4o.metadataInferred?.includes('contextWindow')); assert.ok(gpt4o.metadataInferred?.includes('vision'));
  const upstreamModel = discovered.models.find(model => model.upstreamId === 'gpt-4o-mini')!;
  assert.equal(upstreamModel.contextWindow, 4096); assert.equal(upstreamModel.vision, false);
  assert.ok(!upstreamModel.metadataInferred?.includes('contextWindow')); assert.ok(!upstreamModel.metadataInferred?.includes('vision'));
  const unknown = discovered.models.find(model => model.upstreamId === 'unknown-fixture-model')!;
  assert.equal(unknown.contextWindow, 0); assert.equal(unknown.vision, false); assert.equal(unknown.tools, false);
  await click('[aria-label="刷新本机配置"]');
  await click(`[data-source-id="${provider.id}"]`);
  await click('[data-action="discover-models"]');
  const catalogCount = discovered.models.length;
  assert.equal(catalogCount, 68);
  await waitFor(`document.querySelectorAll('.discovery-model').length===5`, 'the first GPT series opens by default');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model-select input:checked').length`), 0);
  assert.equal(await evaluate<boolean>(`document.querySelector('.discovery-footer .button.primary').disabled`), true);
  const series = await evaluate<{ label: string; ids: string[] }[]>(`
    [...document.querySelectorAll('[data-model-series]')].map(section => ({
      label: section.getAttribute('aria-label'),
      ids: [...section.querySelectorAll('.discovery-model-select strong')].map(row => row.title),
    }))`);
  assert.equal(series[0].label, 'GPT');
  assert.deepEqual(series[0].ids.slice(0, 2), ['gpt-5.4-nano-2026-03-17', 'gpt-5.2']);
  assert.deepEqual(new Set(series[0].ids), new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-5.2', 'gpt-4.1', 'gpt-5.4-nano-2026-03-17']));
  const displayRows = await evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('.discovery-model-select strong')].map(name => [name.title, name.textContent]))`);
  for (const model of discovered.models.filter(model => model.upstreamId.startsWith('gpt-'))) assert.equal(displayRows[model.upstreamId], `${provider.name} - ${model.displayName}`);
  assert.equal(displayRows['gpt-5.2'], '模型测试套餐 - GPT-5.2');
  const compact = await evaluate<boolean>(`[...document.querySelectorAll('.discovery-model')].every(row => {
    const box = row.getBoundingClientRect(), name = row.querySelector('strong').getBoundingClientRect();
    const button = row.querySelector('button[aria-expanded="false"]')?.getBoundingClientRect();
    return button && !row.querySelector('.discovery-model-settings,input[type="text"]') && name.right <= button.left
      && button.top < name.bottom && name.top < button.bottom && box.height < button.height * 2;
  })`);
  assert.ok(compact, 'Collapsed candidates fit the checkbox, name and disclosure on one compact line');
  function press(keyCode: string) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  const tab = (key: string) => `[role="tablist"][aria-label="模型系列"] [role="tab"][data-discovery-series-tab="${key}"]`;
  async function switchSeries(key: string, count: number) {
    await click(tab(key));
    await waitFor(`document.querySelector(${JSON.stringify(tab(key))}).getAttribute('aria-selected')==='true'
      && document.querySelectorAll('.discovery-model').length===${count}`, 'selected series and row count');
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-model-series]')].map(group=>group.dataset.modelSeries)`), [key]);
  }
  assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(tab(''))})`), false);
  assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(tab('gpt'))}).getAttribute('aria-selected')`), 'true');
  async function verifyTabPresentation() {
    const presentation = await evaluate<{ labels: string[]; selected: string; visibleNames: string[]; icons: number; missingNames: boolean }>(`(() => {
      const tabs = [...document.querySelectorAll('.discovery-series-tabs button')];
      return { labels: tabs.map(tab => tab.getAttribute('aria-label')),
        selected: tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label'),
        visibleNames: tabs.flatMap(tab => [...tab.querySelectorAll('.discovery-series-name')].filter(node => node.checkVisibility()).map(node => node.textContent)),
        icons: tabs.filter(tab => tab.querySelector('[data-model-series-icon]')).length,
        missingNames: tabs.some(tab => !tab.getAttribute('aria-label') || tab.title !== tab.getAttribute('aria-label')) };
    })()`);
    assert.equal(presentation.missingNames, false);
    assert.equal(presentation.icons, presentation.labels.length);
    assert.deepEqual(presentation.visibleNames, [presentation.selected]);
  }
  await verifyTabPresentation();
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await evaluate(`document.querySelector(${JSON.stringify(tab('gpt'))}).focus()`);
  for (const [key, seriesKey] of [['Right', 'gemini'], ['Home', 'gpt']]) {
    press(key);
    await waitFor(`document.activeElement.matches(${JSON.stringify(tab(seriesKey) + '[aria-selected="true"]')})`, 'keyboard selects series tab');
  }
  await evaluate(`document.querySelector('input[aria-label="搜索模型"]').focus()`);
  const first = '选择模型 gpt-5.4-nano-2026-03-17', second = '选择模型 gpt-5.2';
  for (const [key, label] of [['Down', first], ['Down', second]]) {
    press(key);
    await waitFor(`document.activeElement.getAttribute('aria-label') === ${JSON.stringify(label)}`, 'arrow key focuses the expected candidate');
  }
  const visibleContexts = `[...document.querySelectorAll('.discovery-context')]
    .filter(node => node.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) && node.getBoundingClientRect().width > 0)`;
  const visibleDetails = () => evaluate<string[]>(`${visibleContexts}.map(node => node.innerText.trim())`);
  async function expectOnlySummary(id: string) {
    await waitFor(`${visibleContexts}.map(node => node.closest('.discovery-option').querySelector('strong').title).join(',') === ${JSON.stringify(id)}`, `only ${id} shows a summary`);
  }
  await expectOnlySummary('gpt-5.2');
  const point = await evaluate<{ x: number; y: number }>(`(() => {
    const box = document.querySelector('[aria-label="选择模型 gpt-4o"]').closest('.discovery-option').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await expectOnlySummary('gpt-4o');
  assert.equal(await evaluate<string>(`document.activeElement.getAttribute('aria-label')`), second);
  press('Up');
  await expectOnlySummary('gpt-5.4-nano-2026-03-17');
  press('Down');
  await expectOnlySummary('gpt-5.2');
  const focusedText = await evaluate<string>(`document.activeElement.closest('.discovery-option').innerText`);
  assert.match(focusedText, /Max 400K/); assert.match(focusedText, /high|高/i);
  const startingTheme = await evaluate<string | undefined>('document.documentElement.dataset.theme');
  await evaluate("document.documentElement.dataset.theme='dark'");
  await switchSeries('gpt', 5);
  await evaluate(`document.querySelector('[aria-label="选择模型 gpt-5.2"]').focus()`);
  writeFileSync(join(outputDir, 'discovery-series.png'), await captureUi());
  await evaluate(startingTheme ? `document.documentElement.dataset.theme=${JSON.stringify(startingTheme)}` : 'delete document.documentElement.dataset.theme');
  press('Return');
  await waitFor(`!!document.querySelector('input[aria-label="gpt-5.2 显示名称"]')`, 'Enter opens the focused model editor');
  assert.equal(await evaluate<string>(`document.querySelector('input[aria-label="gpt-5.2 显示名称"]').value`), 'GPT-5.2');
  await click('button[aria-label="gpt-5.2 参数设置"][aria-expanded="true"]');
  await switchSeries('gemini', 2);
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('.discovery-model-select strong')].map(row => row.title)`), ['gemini-2.10-flash', 'gemini-2.9-flash']);
  await evaluate(`document.querySelector('[aria-label="选择模型 gemini-2.9-flash"]').focus()`);
  const noDefault = await visibleDetails();
  assert.deepEqual(noDefault, ['Max 64K'], 'A known context without a default effort only shows its context limit');
  await switchSeries('gpt', 5);
  await evaluate(`document.querySelector('[aria-label="选择模型 gpt-5.2"]').focus()`);
  press('Up');
  await waitFor(`document.activeElement.getAttribute('aria-label') === ${JSON.stringify(first)}`, 'Up focuses the previous model');
  for (const checked of [true, false]) {
    press('Space');
    await waitFor(`document.activeElement.checked === ${checked}`, 'Space toggles the focused candidate');
  }
  press('Up');
  await waitFor(`document.activeElement.getAttribute('aria-label')==='搜索模型'`, 'Up on the first candidate returns to search');

  async function searchModels(query: string, count: number) {
    await evaluate(`(() => {
      const input = document.querySelector('[aria-label="搜索模型"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(`document.querySelectorAll('.discovery-model').length===${count}
      && [...document.querySelectorAll('.discovery-model-select strong')].every(row => row.title.includes(${JSON.stringify(query)}))`, 'filtered model IDs');
  }
  const fixedHeightLayouts: unknown[] = [];
  const initialTheme = await evaluate<string | undefined>('document.documentElement.dataset.theme');
  window.setMinimumSize(780, 580);
  async function geometry() {
    return evaluate<{ modal: number[]; tabs: number[]; tabButtons: { key: string; box: number[] }[]; footer: number[]; scrollTop: number; scrollable: boolean; inside: boolean }>(`(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      const modal = box('.modal'), tabs = box('.discovery-series-tabs'), footer = box('.discovery-footer');
      const content = document.querySelector('.discovery-content');
      const tabButtons = [...document.querySelectorAll('.discovery-series-tabs button')].map(button => {
        const r = button.getBoundingClientRect();
        return { key: button.dataset.discoverySeriesTab, box: [r.x, r.y, r.width, r.height] };
      });
      return { modal, tabs, tabButtons, footer, scrollTop: content.scrollTop, scrollable: content.scrollHeight > content.clientHeight,
        inside: modal[0] >= 0 && modal[1] >= 0 && modal[0] + modal[2] <= innerWidth + 1 && modal[1] + modal[3] <= innerHeight + 1
          && footer[1] + footer[3] <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1 };
    })()`);
  }
  function assertStable(base: Awaited<ReturnType<typeof geometry>>, next: Awaited<ReturnType<typeof geometry>>, state: string) {
    for (const key of ['modal', 'tabs', 'footer'] as const) {
      base[key].forEach((value, index) => assert.ok(Math.abs(value - next[key][index]) < 1, `${state}: ${key}[${index}] moved`));
    }
    assert.deepEqual(next.tabButtons.map(button => button.key), base.tabButtons.map(button => button.key));
    next.tabButtons.forEach(button => {
      assert.ok(button.box[2] >= 24 && button.box[3] >= 24, `${state}: tab ${button.key} remains a usable click target`);
    });
    assert.ok(next.inside, `${state}: dialog and footer fit the viewport`);
  }
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const [width, height] of [[1320, 880], [980, 680], [780, 580]]) {
      window.setContentSize(width, height);
      await waitFor(`innerWidth===${width} && innerHeight===${height}`, 'fixed-height viewport');
      await switchSeries('scroll-fixture', 60);
      await searchModels('', 60);
      const baseline = await geometry();
      assert.ok(baseline.inside); assert.ok(baseline.scrollable, 'The long model list scrolls internally');
      await evaluate(`document.querySelector('.discovery-content').scrollTop=document.querySelector('.discovery-content').scrollHeight`);
      await waitFor(`document.querySelector('.discovery-content').scrollTop>0`, 'model list scrolled');
      assertStable(baseline, await geometry(), 'long list scrolling');
      if (theme === 'dark' && width === 980) {
        writeFileSync(join(outputDir, 'discovery-fixed-height-scroll.png'), await captureUi());
        await evaluate(`document.querySelector('.discovery-content').scrollTop=0`);
        writeFileSync(join(outputDir, 'discovery-fixed-height-long.png'), await captureUi());
      }
      await switchSeries('#other', 1);
      const single = await geometry();
      assertStable(baseline, single, 'single-model series');
      assert.equal(single.scrollTop, 0, 'Switching series returns its internal list to the top');
      await searchModels('height-query-without-any-match', 0);
      assertStable(baseline, await geometry(), 'zero search results');
      await searchModels('', 1);
      if (theme === 'dark' && width === 980) writeFileSync(join(outputDir, 'discovery-fixed-height-single.png'), await captureUi());
      await click('[aria-label="unknown-fixture-model 参数设置"][aria-expanded="false"]');
      assertStable(baseline, await geometry(), 'expanded model settings');
      await click('.discovery-toolbar button');
      await waitFor(`!!document.querySelector('.discovery-advanced')`, 'advanced settings opened');
      assertStable(baseline, await geometry(), 'advanced and model settings');
      await evaluate(`document.querySelector('.discovery-content').scrollTop=document.querySelector('.discovery-content').scrollHeight`);
      assertStable(baseline, await geometry(), 'expanded settings scrolling');
      await click('.discovery-toolbar button');
      await waitFor(`!document.querySelector('.discovery-advanced')`, 'advanced settings closed');
      await click('[aria-label="unknown-fixture-model 参数设置"][aria-expanded="true"]');
      await verifyTabPresentation();
      fixedHeightLayouts.push({ theme, width, height, ...baseline, single });
    }
  }
  window.setContentSize(1080, 720);
  await waitFor('innerWidth===1080 && innerHeight===720', 'metadata viewport restored');
  await evaluate(initialTheme ? `document.documentElement.dataset.theme=${JSON.stringify(initialTheme)}` : 'delete document.documentElement.dataset.theme');
  await switchSeries('gpt', 5);
  assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model-select input:checked').length`), 0);
  await searchModels('gemini-', 0);
  await searchModels('gpt-5.', 2);
  assert.equal(await evaluate<boolean>(`document.querySelector('.discovery-list-header input[type="checkbox"]').checked`), false);
  await click('.discovery-list-header input[type="checkbox"]');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model-select input:checked').length`), 2);
  await click('.discovery-list-header input[type="checkbox"]');
  await searchModels('', 5);
  await switchSeries('gemini', 2);
  assert.equal(await evaluate<boolean>(`document.querySelector('.discovery-list-header input[type="checkbox"]').checked`), false);
  await click('.discovery-list-header input[type="checkbox"]');
  assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model-select input:checked').length`), 2);
  await switchSeries('gpt', 5);
  assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').innerText`), /已选择 2 个待添加模型/);
  await switchSeries('gemini', 2);
  await click('.discovery-list-header input[type="checkbox"]');
  await switchSeries('gpt', 5);
  assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model-select input:checked').length`), 0);
  const expectedSelection = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'unknown-fixture-model']);
  for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1']) await click(`[aria-label="选择模型 ${id}"]`);
  await switchSeries('#other', 1);
  assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(tab('#other'))}+' [data-model-series-icon]').dataset.modelSeriesIcon`), 'default');
  await click('[aria-label="选择模型 unknown-fixture-model"]');
  await verifyTabPresentation();
  assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').innerText`), /已选择 4 个待添加模型/);
  await switchSeries('gpt', 5);
  const checkedIds = await evaluate<string[]>(`[...document.querySelectorAll('.discovery-model-select:has(input:checked) strong')].map(row => row.title)`);
  assert.deepEqual(new Set(checkedIds), new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1']));
  const row = '.discovery-model:has(input[aria-label="选择模型 gpt-4o"])';
  await click('[aria-label="gpt-4o 参数设置"][aria-expanded="false"]');
  assert.ok((await evaluate<string>(`document.querySelector(${JSON.stringify(row)}).innerText`)).includes('字典补全'));
  await waitFor(`!!document.querySelector('input[aria-label="gpt-4o 上下文长度"]')`, 'individual context editor');
  const editedName = 'GPT-4o 参数测试';
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="gpt-4o 显示名称"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(editedName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await switchSeries('#other', 1);
  const directoryUnknown = '.discovery-model:has(input[aria-label="选择模型 unknown-fixture-model"])';
  await click('[aria-label="unknown-fixture-model 参数设置"][aria-expanded="false"]');
  await waitFor(`document.querySelectorAll('.discovery-model-settings').length === 1 &&
    !document.querySelector('input[aria-label="gpt-4o 上下文长度"]')`, 'only the latest row remains expanded');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="unknown-fixture-model 思考能力"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'yes');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelectorAll('${directoryUnknown} input[aria-label*="思考等级"]').length===7`, 'directory all legal reasoning grades');
  await click('input[aria-label="unknown-fixture-model 思考等级 medium"]');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="unknown-fixture-model 默认思考强度"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'medium');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('select[aria-label="unknown-fixture-model 默认思考强度"]').value==='medium'`, 'directory fixed reasoning default');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="unknown-fixture-model 默认思考强度"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('select[aria-label="unknown-fixture-model 默认思考强度"]').value===''`, 'directory default cleared to tool choice');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="unknown-fixture-model 调用接口"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'responses');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('select[aria-label="unknown-fixture-model 调用接口"]').value==='responses'`, 'directory reasoning protocol switch');

  const layouts: unknown[] = [];
  for (const [width, height] of [[1320, 880], [980, 680]]) {
    window.setContentSize(width, height);
    await new Promise(done => setTimeout(done, 180));
    const layout = await evaluate<{ noOverflow: boolean; footerVisible: boolean; editorVisible: boolean }>(`(()=>{const modal=document.querySelector('.modal'),footer=modal.querySelector('.modal-footer').getBoundingClientRect(),editor=document.querySelector('input[aria-label="unknown-fixture-model 上下文长度"]');return {noOverflow:document.documentElement.scrollWidth<=innerWidth+1&&modal.scrollWidth<=modal.clientWidth+1,footerVisible:footer.bottom<=innerHeight+1&&footer.top>=0,editorVisible:!!editor&&!editor.disabled}})()`);
    assert.equal(layout.noOverflow, true); assert.equal(layout.footerVisible, true); assert.equal(layout.editorVisible, true);
    layouts.push({ width, height, ...layout });
    writeFileSync(join(outputDir, `model-metadata-${width}.png`), await captureUi());
    await evaluate(`document.querySelector('.discovery-content').scrollTop=document.querySelector('.discovery-content').scrollHeight`);
    await new Promise(done => setTimeout(done, 100));
    writeFileSync(join(outputDir, `directory-reasoning-${width}.png`), await captureUi());
  }
  await switchSeries('gpt', 5);
  await click('[aria-label="gpt-4o 参数设置"][aria-expanded="false"]');
  assert.equal(await evaluate<string>(`document.querySelector('input[aria-label="gpt-4o 显示名称"]').value`), editedName);
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="gpt-4o 上下文长度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('input[aria-label="gpt-4o 上下文长度"]').value==='0'`, 'zero context override');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="gpt-4o 图片输入"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'no');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('select[aria-label="gpt-4o 图片输入"]').value==='no'`, 'false image override');
  await click('.discovery-footer .button.primary');
  await waitFor(`!!document.querySelector('.discovery-success')`, 'batch imported');
  const saved = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.filter(model => model.providerId === provider.id);
  assert.equal(saved.length, 4);
  assert.deepEqual(new Set(saved.map(model => model.upstreamId)), expectedSelection);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4o')!.displayName, editedName);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4o')!.vision, false);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4.1')!.contextWindow, discovered.models.find(model => model.upstreamId === 'gpt-4.1')!.contextWindow);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4.1')!.vision, true);
  assert.equal(saved.find(model => model.upstreamId === 'unknown-fixture-model')!.tools, false);
  assert.deepEqual(saved.find(model => model.upstreamId === 'unknown-fixture-model')!.reasoningEfforts, ['medium']);
  assert.equal(saved.find(model => model.upstreamId === 'unknown-fixture-model')!.defaultReasoningEffort, undefined, 'Explicit tool choice survives the renderer selection object and IPC import');
  assert.equal(saved.find(model => model.upstreamId === 'unknown-fixture-model')!.reasoningEffortFormat, 'responses');
  await click('.discovery-footer .footer-actions .button.secondary:nth-last-child(2)');
  await click('[data-action="discover-models"]');
  await waitFor(`document.querySelectorAll('.discovery-model.existing').length===3`, 'existing GPT candidates');
  assert.deepEqual(new Set(await evaluate<string[]>(`
    [...document.querySelectorAll('.discovery-model.existing .discovery-model-select:has(input:disabled:not(:checked)) strong')].map(row => row.title)
  `)), new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1']));
  await switchSeries('#other', 1);
  assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model.existing').length`), 1);
  const rediscovered = await evaluate<DiscoveryResult>(`window.modelDock.discoverModels(${JSON.stringify(provider.id)})`);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'gpt-4o')!.vision, false);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'unknown-fixture-model')!.defaultReasoningEffort, undefined);
  assert.equal((await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.providerId === provider.id && model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  await click('[aria-label="关闭对话框"]');
  // 修改点：只保存合成供应商，不调用官方地址；核对新增/编辑模型的实际 React 表单。
  const official = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '火山参数界面测试', kind: 'openai-compatible', presetId: 'volcengine-agent', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', enabled: true, apiKey: 'synthetic-only' })})`);
  await click('[aria-label="刷新本机配置"]');
  await click(`[data-source-id="${official.id}"]`);
  await click('[data-action="manual-add-model"]');
  const field = (name: string) => `[data-field="${name}"]`;
  async function input(name: string, value: string): Promise<void> {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(field(name))});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector(${JSON.stringify(field(name))}).value===${JSON.stringify(value)}`, name);
  }
  assert.equal(await evaluate<string>(`document.querySelector('${field('context-window')}').value`), '0');
  await input('upstream-id', 'kimi-k3');
  await waitFor(`document.querySelector('${field('context-window')}').value==='1024000'`, 'Kimi scoped context');
  assert.equal(await evaluate<string>(`document.querySelector('${field('max-output-tokens')}').value`), '131072');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-thinking')}').checked`), true);
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]').length`), 7);
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-field^="reasoning-effort-"]:checked')].map(input=>input.dataset.field.replace('reasoning-effort-',''))`), ['low', 'high', 'max']);
  assert.equal(await evaluate<string>(`document.querySelector('${field('default-reasoning-effort')}').value`), 'max');
  await input('context-window', '0');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), true);
  await click(field('model-vision'));
  await input('upstream-id', 'unknown-experimental-model');
  await waitFor(`document.querySelector('${field('max-output-tokens')}').value==='0'`, 'unknown output clears');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="apply-official-model-parameters"]').disabled`), true);
  await click(field('model-thinking'));
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]').length`), 7);
  await click(field('reasoning-effort-medium'));
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('reasoning-effort-medium')}').checked`), true);
  await click(field('model-thinking'));

  await input('upstream-id', 'kimi-k3');
  await waitFor(`document.querySelector('${field('max-output-tokens')}').value==='131072'`, 'known output restores');
  assert.equal(await evaluate<string>(`document.querySelector('${field('context-window')}').value`), '0');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-thinking')}').checked`), false);
  await click('[data-action="apply-official-model-parameters"]');
  await waitFor(`document.querySelector('${field('context-window')}').value==='1024000'`, 'explicit apply overrides manual zero');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-field="official-parameters-applied"]')`), true);
  assert.ok((await evaluate<string>(`document.querySelector('[data-action="apply-official-model-parameters"]').innerText`)).includes('已填入草稿'));
  await input('max-output-tokens', '65536');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-field="official-parameters-applied"]')`), false);
  await click('[data-action="apply-official-model-parameters"]');
  await waitFor(`document.querySelector('${field('max-output-tokens')}').value==='131072'`, 'inline feedback reapplies parameters');
  await click(field('reasoning-effort-medium'));
  await click(field('reasoning-effort-max'));
  await evaluate(`(()=>{const select=document.querySelector('${field('default-reasoning-effort')}');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'high');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate(`(()=>{const select=document.querySelector('${field('wire-api')}');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'chat-completions');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('${field('wire-api')}').value==='chat-completions'`, 'manual reasoning protocol switch');
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-field^="reasoning-effort-"]:checked')].map(input=>input.dataset.field.replace('reasoning-effort-',''))`), ['low', 'medium', 'high']);

  // 等旧通知自行过期；不修改 DOM 或隐藏通知来制造无覆盖截图。
  await waitFor(`document.querySelectorAll('.toast').length===0`, 'previous notifications expire');
  const manualLayouts: unknown[] = [];
  for (const [width, height] of [[1320, 880], [980, 680]]) {
    window.setContentSize(width, height);
    await new Promise(done => setTimeout(done, 180));
    const layout = await evaluate<{ noOverflow: boolean; footerVisible: boolean; sourceVisible: boolean }>(`(()=>{const modal=document.querySelector('.modal'),footer=modal.querySelector('.modal-footer').getBoundingClientRect();return {noOverflow:document.documentElement.scrollWidth<=innerWidth+1&&modal.scrollWidth<=modal.clientWidth+1,footerVisible:footer.bottom<=innerHeight+1&&footer.top>=0,sourceVisible:!!document.querySelector('[data-field="official-parameters"] a')}})()`);
    assert.equal(layout.noOverflow, true); assert.equal(layout.footerVisible, true); assert.equal(layout.sourceVisible, true);
    manualLayouts.push({ width, height, ...layout });
    await evaluate(`document.querySelector('.modal-body').scrollTop=0`);
    writeFileSync(join(outputDir, `manual-model-parameters-${width}.png`), await captureUi());
    await evaluate(`(()=>{const body=document.querySelector('.modal-body'),reference=document.querySelector('[data-field="official-parameters"]');body.scrollTop+=reference.getBoundingClientRect().top-body.getBoundingClientRect().top-8;})()`);
    await new Promise(done => setTimeout(done, 100));
    writeFileSync(join(outputDir, `manual-model-parameters-${width}-details.png`), await captureUi());
    await evaluate(`document.querySelector('.modal-body').scrollTop=document.querySelector('.modal-body').scrollHeight`);
    await new Promise(done => setTimeout(done, 100));
    writeFileSync(join(outputDir, `manual-reasoning-${width}.png`), await captureUi());
  }
  await click('.modal-footer button[type="submit"]');
  await waitFor(`!document.querySelector('.modal')`, 'manual model saved');
  const manual = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.providerId === official.id && model.upstreamId === 'kimi-k3')!;
  assert.equal(manual.contextWindow, 1024000); assert.equal(manual.maxOutputTokens, 131072); assert.equal(manual.thinking, true);
  assert.deepEqual(manual.reasoningEfforts, ['low', 'medium', 'high']); assert.equal(manual.defaultReasoningEffort, 'high'); assert.equal(manual.reasoningEffortFormat, 'chat-completions');
  // 修改点：通过真实主题设置切换，截图后恢复原偏好；不改 DOM 或隐藏通知。
  const originalTheme = await evaluate<string>(`(async()=> (await window.modelDock.getSettings()).settings.theme)()`);
  const originalResolvedTheme = await evaluate<string>(`document.documentElement.dataset.theme`);
  await click('[data-page="settings"]');
  await click('[data-theme-choice="dark"]');
  await waitFor(`document.documentElement.dataset.theme==='dark'`, 'native dark theme for manual reasoning');
  await click(`[data-source-id="${official.id}"]`);
  await click(`[data-model-id="${manual.id}"] [data-action="edit-model"]`);
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-field^="reasoning-effort-"]:checked')].map(input=>input.dataset.field.replace('reasoning-effort-',''))`), ['low', 'medium', 'high']);
  assert.equal(await evaluate<string>(`document.querySelector('${field('default-reasoning-effort')}').value`), 'high');
  window.setContentSize(980, 680);
  await waitFor(`document.querySelectorAll('.toast').length===0`, 'notifications expire before dark reasoning capture');
  await evaluate(`document.querySelector('.modal-body').scrollTop=document.querySelector('.modal-body').scrollHeight`);
  await new Promise(done => setTimeout(done, 150));
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]').length`), 7);
  writeFileSync(join(outputDir, 'manual-reasoning-dark-980.png'), await captureUi());
  await click('[aria-label="关闭对话框"]');
  await click('[data-page="settings"]');
  await click(`[data-theme-choice="${originalTheme}"]`);
  await waitFor(`document.documentElement.dataset.theme===${JSON.stringify(originalResolvedTheme)}`, 'original theme restored');
  assert.equal(await evaluate<string>(`(async()=> (await window.modelDock.getSettings()).settings.theme)()`), originalTheme);
  await click(`[data-source-id="${official.id}"]`);

  const legacy = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ ...manual, contextWindow: 128000, maxOutputTokens: 4096, vision: false, thinking: true, reasoningEfforts: [], defaultReasoningEffort: undefined, reasoningEffortFormat: undefined })})`);
  await click('[aria-label="刷新本机配置"]');
  await click(`[data-model-id="${legacy.id}"] [data-action="edit-model"]`);
  assert.equal(await evaluate<string>(`document.querySelector('${field('context-window')}').value`), '128000');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]').length`), 7);
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]:checked').length`), 0);
  await click('[data-action="apply-official-model-parameters"]');
  await waitFor(`document.querySelector('${field('context-window')}').value==='1024000'`, 'existing Kimi applies official parameters');
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-field^="reasoning-effort-"]:checked')].map(input=>input.dataset.field.replace('reasoning-effort-',''))`), ['low', 'high', 'max']);
  await click(field('reasoning-effort-max'));
  await evaluate(`(()=>{const select=document.querySelector('${field('default-reasoning-effort')}');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'high');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);

  await click('.modal-footer button[type="submit"]');
  await waitFor(`!document.querySelector('.modal')`, 'updated model saved');
  const updated = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.id === legacy.id)!;
  assert.equal(updated.contextWindow, 1024000); assert.equal(updated.maxOutputTokens, 131072); assert.equal(updated.vision, true); assert.equal(updated.thinking, true);
  assert.deepEqual(updated.reasoningEfforts, ['low', 'high']); assert.equal(updated.defaultReasoningEffort, 'high'); assert.equal(updated.reasoningEffortFormat, 'chat-completions');

  // 订阅模型只应用思考默认，保留其独立目录给出的上下文/图片设置。
  const subscription = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '订阅思考参数界面测试', kind: 'copilot', presetId: 'copilot-subscription', baseUrl: 'https://api.githubcopilot.com', enabled: true })})`);
  const subscriptionModel = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: subscription.id, upstreamId: 'gemini-3.8-flash', alias: 'gemini-3.8-flash', displayName: '订阅 Gemini', wireApi: 'chat-completions', enabled: true, contextWindow: 200_000, maxInputTokens: 120_000, maxOutputTokens: 8_000, tools: true, vision: false, thinking: true, reasoningEfforts: [] })})`);
  await click('[aria-label="刷新本机配置"]');
  await click(`[data-source-id="${subscription.id}"]`);
  await click(`[data-model-id="${subscriptionModel.id}"] [data-action="edit-model"]`);
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="apply-official-model-parameters"]').disabled`), false);
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]').length`), 7);
  await click('[data-action="apply-official-model-parameters"]');
  assert.equal(await evaluate<string>(`document.querySelector('${field('context-window')}').value`), '200000');
  assert.equal(await evaluate<string>(`document.querySelector('${field('max-input-tokens')}').value`), '120000');
  assert.equal(await evaluate<string>(`document.querySelector('${field('max-output-tokens')}').value`), '8000');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('[data-field^="reasoning-effort-"]:checked')].map(input=>input.dataset.field.replace('reasoning-effort-',''))`), ['low', 'medium', 'high']);
  await click('.modal-footer button[type="submit"]');
  await waitFor(`!document.querySelector('.modal')`, 'subscription thinking defaults saved');
  const subscriptionSaved = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.id === subscriptionModel.id)!;
  assert.equal(subscriptionSaved.contextWindow, 200_000); assert.equal(subscriptionSaved.vision, false);
  assert.deepEqual(subscriptionSaved.reasoningEfforts, ['low', 'medium', 'high']);
  writeFileSync(join(outputDir, 'model-metadata-validation.json'), JSON.stringify({ ok: true, dictionaryFilled: true, upstreamPrecedence: true, unknownRetained: true, manualZeroAndFalseSaved: true, rediscoveryPreserved: true, seriesOrderVerified: true, seriesTabsVerified: true, seriesIconsVerified: true, firstSeriesOnlyByDefault: true, focusedSummaryVerified: true, keyboardEditingVerified: true, filteredSelectionPreserved: true, initialSelectionEmpty: true, fixedHeightAndPinnedControls: true, fixedHeightLayouts, modelsAdded: saved.length, layouts, manualLayouts, newModelDefaults: true, unknownIdCleared: true, manualOverridesPreserved: true, explicitApplyUpdatedExisting: true, sevenReasoningGradesEditable: true, builtinKimiDefaults: true, customReasoningSavedAndReopened: true, protocolFormatUpdated: true, directoryReasoningSaved: true, directoryToolChoicePreservedThroughIpc: true, darkReasoning980CapturedAndThemeRestored: true, oldEmptyGradesApplied: true, unknownThinkingEditable: true, subscriptionReasoningOnlyDefaults: true, syntheticOnly: true }, null, 2));
}
