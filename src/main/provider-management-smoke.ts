import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, type BrowserWindow } from 'electron';
import type { Store } from './store';
import { revealSmokeNavigationTarget } from './smoke-navigation';
import { providerCategory } from '../shared/presets';

/** Real React/preload/clipboard validation, restricted to a fresh synthetic smoke profile. */
export async function verifyProviderManagement(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child), 'Provider UI fixtures require an isolated output/data profile');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  // The shared runner seeds empty preset cards for other smoke suites. Remove
  // only those synthetic, model-free rows before this suite records its baseline.
  const seededModels = store.listModels();
  const emptySeedProviders = store.listProviders().filter(source => !seededModels.some(item => item.providerId === source.id));
  for (const source of emptySeedProviders) store.deleteProvider(source.id);
  const provider = store.saveProvider({ name: '界面验证 API', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://ui-fixture.example.test/v1', enabled: true, apiKey: 'synthetic-provider-copy-key' });
  const other = store.saveProvider({ name: '界面验证备用 API', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://ui-second.example.test/v1', enabled: true, apiKey: 'synthetic-second-key' });
  const subscription = store.saveProvider({ name: '界面验证订阅', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(subscription.id, { accessToken: 'synthetic-subscription-access', refreshToken: 'synthetic-subscription-refresh' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'native-ui-model', alias: 'visible-ui-alias', displayName: '界面验证模型', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  store.saveModel({ providerId: other.id, upstreamId: 'native-ui-second', alias: 'visible-ui-second', displayName: '备用验证模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  store.saveModel({ providerId: subscription.id, upstreamId: 'native-ui-subscription', alias: 'visible-ui-subscription', displayName: '订阅验证模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const originalBindings = store.listBindings();
  const originalSize = window.getSize(), originalMinimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const layouts: unknown[] = [];
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(30); }
    // Plaintext fields are cleared before even a failure screenshot is taken.
    await evaluate(`document.querySelectorAll('[data-secret-field] input').forEach(input=>{input.type='password';input.value='************'})`);
    writeFileSync(join(outputDir, 'provider-management-timeout.png'), await captureUi());
    throw new Error(`Provider management UI timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await revealSmokeNavigationTarget(window, selector);
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function refresh(): Promise<void> {
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('.sidebar [data-source-id="${provider.id}"]')`, 'synthetic providers loaded');
  }
  async function selectProvider(id: string): Promise<void> {
    await click(`.sidebar [data-source-id="${id}"]`);
    await waitFor(`!!document.querySelector('.provider-list [data-provider-id="${id}"]')&&!!document.querySelector('.provider-models')`, 'provider detail selected');
  }
  async function assertClipboard(selector: string, expected: string): Promise<void> {
    await clipboard.clear();
    await click(selector);
    const deadline = Date.now() + 5000;
    while (await clipboard.readText() !== expected && Date.now() < deadline) await pause(25);
    assert.equal(await clipboard.readText(), expected, 'Native clipboard must contain the exact selected connection value');
    await clipboard.clear();
  }
  async function masked(scope = '.connection-fields'): Promise<void> {
    const selector = `${scope} [data-secret-field] input`;
    await waitFor(`document.querySelector(${JSON.stringify(selector)})?.type==='password'`, 'key masked');
    assert.notEqual(await evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).value`), 'synthetic-provider-copy-key');
  }
  async function revealAndHide(scope: string, expected: string): Promise<void> {
    await masked(scope);
    await click(`${scope} [data-action="reveal-key"]`);
    await waitFor(`(()=>{const input=document.querySelector(${JSON.stringify(`${scope} [data-secret-field] input`)});return input?.type==='text'&&input.value===${JSON.stringify(expected)}})()`, 'eye reveals saved key');
    await click(`${scope} [data-action="reveal-key"]`);
    await masked(scope);
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(`${scope} [data-secret-field] input`)}).value===${JSON.stringify(expected)}`), false, 'Hiding must discard plaintext from the field value');
  }
  async function inspectLayout(page: string, name: string): Promise<void> {
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1180, 800], [980, 680]]) {
      window.setMinimumSize(780, 580); window.setSize(width, height);
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0;window.scrollTo(0,0)})()`);
      await pause(100);
      const layout = await evaluate<{ documentOverflow: boolean; mainOverflow: boolean; keysMasked: boolean; inaccessibleButtons: number }>(`(()=>{const main=document.querySelector('.main-content');return {documentOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,keysMasked:[...document.querySelectorAll('[data-secret-field] input')].every(input=>input.type==='password'),inaccessibleButtons:[...main.querySelectorAll('button.icon-button')].filter(button=>!(button.getAttribute('aria-label')||button.title||button.textContent.trim())).length}})()`);
      assert.equal(layout.documentOverflow, false, `${page} document fits ${width}px`);
      assert.equal(layout.mainOverflow, false, `${page} content fits ${width}px`);
      assert.equal(layout.keysMasked, true, 'All screenshot credentials must remain masked');
      assert.equal(layout.inaccessibleButtons, 0, 'Icon actions must have an accessible name');
      layouts.push({ page, theme, width, height, ...layout });
      writeFileSync(join(outputDir, `provider-management-${name}-${theme}-${width}.png`), await captureUi());
    }
  }
  async function inspectRequestLogs(): Promise<void> {
    for (let index = 0; index < 100; index++) store.addLog({ id: `synthetic-scroll-log-${index}`, time: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), alias: `synthetic-model-${index}`, providerName: '界面验证订阅', endpoint: '/v1/responses', status: index % 4 ? 200 : 429, durationMs: index + 10 });
    await refresh(); await click('[data-page="service"]'); await click('[data-service-tab="logs"]');
    await waitFor(`document.querySelectorAll('.logs-table tbody tr').length===100`, 'one hundred synthetic request logs');
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1180, 800], [980, 680]]) {
      window.setSize(width, height);
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.logs-panel').scrollIntoView({block:'start'});document.querySelector('.logs-panel > .table-scroll').scrollTop=0;document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click());})()`);
      await pause(150);
      const before = await evaluate<{ mainTop: number; headerTop: number; x: number; y: number }>(`(()=>{const scroll=document.querySelector('.logs-panel > .table-scroll'),r=scroll.getBoundingClientRect();return {mainTop:document.querySelector('.main-content').scrollTop,headerTop:scroll.querySelector('th').getBoundingClientRect().top,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: before.x, y: before.y });
      window.webContents.sendInputEvent({ type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: -120, canScroll: true });
      await waitFor(`document.querySelector('.logs-panel > .table-scroll').scrollTop>0`, 'native wheel scrolls request log region');
      const wheel = await evaluate<{ mainTop: number; logTop: number }>(`({mainTop:document.querySelector('.main-content').scrollTop,logTop:document.querySelector('.logs-panel > .table-scroll').scrollTop})`);
      assert.equal(wheel.mainTop, before.mainTop, 'Scrolling request logs does not move the surrounding service page');
      await evaluate(`(()=>{const scroll=document.querySelector('.logs-panel > .table-scroll');scroll.scrollTop=scroll.scrollHeight})()`);
      await pause(75);
      const layout = await evaluate<{ height: number; scrollHeight: number; scrollTop: number; headerTop: number; sticky: string; rows: number; lastRowVisible: boolean; accessible: boolean; diagnosticsDistance: number; horizontalOverflow: boolean }>(`(()=>{const scroll=document.querySelector('.logs-panel > .table-scroll'),r=scroll.getBoundingClientRect(),last=scroll.querySelector('tbody tr:last-child').getBoundingClientRect(),panel=document.querySelector('.logs-panel').getBoundingClientRect();return {height:scroll.clientHeight,scrollHeight:scroll.scrollHeight,scrollTop:scroll.scrollTop,headerTop:scroll.querySelector('th').getBoundingClientRect().top,sticky:getComputedStyle(scroll.querySelector('th')).position,rows:scroll.querySelectorAll('tbody tr').length,lastRowVisible:last.bottom<=r.bottom+1&&last.top>=r.top,accessible:scroll.tabIndex===0&&scroll.getAttribute('role')==='region'&&!!scroll.getAttribute('aria-label'),diagnosticsDistance:document.querySelector('.diagnostics-panel').getBoundingClientRect().top-panel.top,horizontalOverflow:document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth+1}})()`);
      assert.ok(layout.height > 0 && layout.height <= 420 && layout.scrollHeight > layout.height, 'Request logs use a bounded independent scroll viewport');
      assert.ok(Math.abs(layout.headerTop - before.headerTop) <= 1 && layout.sticky === 'sticky', 'Request log column headers stay fixed while scrolling');
      assert.ok(layout.lastRowVisible && layout.accessible && !layout.horizontalOverflow, 'All logs remain reachable by keyboard and scrolling without page overflow');
      assert.ok(layout.diagnosticsDistance < 600, 'Following diagnostics are no longer pushed down by all request rows');
      layouts.push({ page: 'request-logs', theme, width, viewportHeight: height, wheel, ...layout });
      writeFileSync(join(outputDir, `provider-management-request-logs-${theme}-${width}.png`), await captureUi());
    }
  }
  try {
    await refresh();
    assert.equal(await evaluate<number>(`document.querySelectorAll('.sidebar [data-page="mcp"],.sidebar [data-page="skills"]').length`), 0, 'MCP and Skills destinations are removed');
    assert.equal(await evaluate<number>(`document.querySelectorAll('.sidebar [data-tool-id="trae"]').length`), 0, 'Removed client is absent from tool navigation');
    const categories = await evaluate<string[]>(`[...document.querySelectorAll('[data-tool-category]')].map(item=>item.dataset.toolCategory)`);
    assert.deepEqual(categories, ['agent', 'jetbrains'], 'The requested regular Agent and JetBrains categories are available');
    const categoryTools: Record<string, string[]> = {};
    for (const category of categories) {
      await click(`[data-tool-category="${category}"]`);
      categoryTools[category] = await evaluate<string[]>(`[...document.querySelectorAll('.sidebar [role="tabpanel"]:not([hidden]) [data-page="tools"][data-tool-id]')].map(item=>item.dataset.toolId)`);
      assert.deepEqual(store.listBindings(), originalBindings, 'Category switching never writes tool bindings');
    }
    assert.equal(new Set(Object.values(categoryTools).flat()).size, originalBindings.length, 'Every supported tool appears in one category');
    assert.equal(Object.values(categoryTools).flat().length, originalBindings.length, 'Tool categories do not duplicate entries');
    assert.equal(categoryTools.agent.length, originalBindings.length - 5, 'Regular Agent tools exclude the JetBrains tools');
    assert.deepEqual(new Set(categoryTools.jetbrains), new Set(['junie', 'webstorm', 'intellij-idea', 'rider', 'pycharm']), 'Junie and all four JetBrains IDEs share the JetBrains category');
    await selectProvider(provider.id);
    await masked();
    await assertClipboard('.connection-fields [aria-label="复制供应商 URL"]', provider.baseUrl);
    await assertClipboard(`tr[data-model-id="${model.id}"] .table-provider [data-action="copy-value"]`, model.upstreamId);
    await assertClipboard(`tr[data-model-id="${model.id}"] .model-name [data-action="copy-value"]`, model.alias);
    await assertClipboard('.connection-fields [data-action="copy-key"]', 'synthetic-provider-copy-key');
    await revealAndHide('.connection-fields', 'synthetic-provider-copy-key');
    await click('.connection-fields [data-action="reveal-key"]');
    await waitFor(`document.querySelector('.connection-fields [data-secret-field] input')?.type==='text'`, 'key shown before navigation');
    await selectProvider(other.id); await masked();
    await selectProvider(provider.id); await masked();
    await click('.connection-fields [data-action="reveal-key"]');
    await waitFor(`document.querySelector('.connection-fields [data-secret-field] input')?.type==='text'`, 'key shown before refresh');
    await pause(5300);
    assert.equal(await evaluate<boolean>(`(()=>{const input=document.querySelector('.connection-fields [data-secret-field] input');return input?.type==='text'&&input.value==='synthetic-provider-copy-key'})()`), true, 'Background snapshot polling must preserve the explicit reveal state');
    await refresh(); await masked();
    await inspectLayout('provider', 'source');
    await selectProvider(subscription.id);
    await waitFor(`!!document.querySelector('[data-subscription-connection="${subscription.id}"]')`, 'subscription local connection');
    await assertClipboard(`[data-subscription-connection="${subscription.id}"] [data-action="copy-key"]`, store.gatewayKey());
    await revealAndHide(`[data-subscription-connection="${subscription.id}"]`, store.gatewayKey());
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-subscription-connection="${subscription.id}"]').textContent.includes(${JSON.stringify(subscription.baseUrl)})`), false, 'Subscription connection shows local invocation parameters');
    const denied = await evaluate<boolean>(`window.modelDock.revealProviderKey(${JSON.stringify(subscription.id)}).then(()=>false,()=>true)`);
    assert.equal(denied, true, 'Subscription authorization is rejected at the main-process boundary');
    // Aggregate selectors are independent of provider detail and native tool bindings.
    await click('.sidebar [data-page="service"]'); await click('[data-service-tab="interface"]');
    await waitFor(`!!document.querySelector('[data-aggregate-management]')`, 'local aggregate panel');
    const sourceCategories: Record<string, string[]> = {};
    for (const category of ['api', 'subscription']) {
      sourceCategories[category] = await evaluate<string[]>(`[...document.querySelectorAll('.sidebar [data-sidebar-provider-category="${category}"] [data-source-id]')].map(item=>item.dataset.sourceId)`);
      assert.deepEqual(new Set(sourceCategories[category]), new Set(store.listProviders().filter(source => providerCategory(source) === category).map(source => source.id)), 'Sidebar groups show exactly their respective sources');
      assert.deepEqual(store.listBindings(), originalBindings, 'Provider groups never write tool bindings');
    }
    sourceCategories.local = await evaluate<string[]>(`[...document.querySelectorAll('[data-aggregate-provider]')].map(item=>item.dataset.aggregateProvider)`);
    assert.equal(sourceCategories.local.length, store.listProviders().length, 'Local interface management lists both source kinds');
    await revealAndHide('[data-aggregate-connection]', store.gatewayKey());
    await assertClipboard('[data-aggregate-connection] [data-action="copy-key"]', store.gatewayKey());
    await assertClipboard('[data-aggregate-connection] [aria-label="复制本地接口 URL"]', (await evaluate<any>('window.modelDock.snapshot()')).gateway.baseUrl || `http://127.0.0.1:18181/v1`);
    await click('[data-aggregate-connection] [data-action="reveal-key"]');
    await waitFor(`document.querySelector('[data-aggregate-connection] [data-secret-field] input')?.type==='text'`, 'local key shown before navigation');
    await selectProvider(provider.id);
    await click('.sidebar [data-page="service"]'); await click('[data-service-tab="interface"]');
    await masked('[data-aggregate-connection]');
    await click(`[data-aggregate-provider="${provider.id}"] [data-action="expand-aggregate-provider"]`);
    await assertClipboard(`[data-aggregate-model="${model.id}"] [aria-label="复制本地模型名称 ${model.alias}"]`, model.alias);
    const providerToggle = `[data-aggregate-provider="${provider.id}"] [role="switch"]`;
    const modelToggle = `[data-aggregate-model="${model.id}"] input[type="checkbox"]`;
    await click(providerToggle);
    await waitFor(`window.modelDock.snapshot().then(snapshot=>snapshot.gatewayExposure.excludedProviderIds.includes(${JSON.stringify(provider.id)}))`, 'provider removed from local aggregate');
    assert.equal(store.getProvider(provider.id)?.enabled, true, 'Aggregate membership does not disable the provider globally');
    await refresh();
    await waitFor(`document.querySelector(${JSON.stringify(providerToggle)})?.getAttribute('aria-checked')==='false'`, 'provider exclusion survives refresh');
    await click(providerToggle);
    await waitFor(`window.modelDock.snapshot().then(snapshot=>!snapshot.gatewayExposure.excludedProviderIds.includes(${JSON.stringify(provider.id)}))`, 'provider added back to local aggregate');
    await click(modelToggle);
    await waitFor(`window.modelDock.snapshot().then(snapshot=>snapshot.gatewayExposure.excludedModelIds.includes(${JSON.stringify(model.id)}))`, 'model removed from local aggregate');
    assert.equal(store.listModels().find(item => item.id === model.id)?.enabled, true, 'Aggregate membership does not disable the model globally');
    await refresh();
    await waitFor(`document.querySelector(${JSON.stringify(modelToggle)})?.checked===false`, 'model exclusion survives refresh');
    await click(modelToggle);
    await waitFor(`window.modelDock.snapshot().then(snapshot=>!snapshot.gatewayExposure.excludedModelIds.includes(${JSON.stringify(model.id)}))`, 'model added back to local aggregate');
    // Keep the expanded model and its controls visible in both screenshot sizes.
    // The other two duplicate-provider fixtures belong to the shared runner.
    await evaluate(`(()=>{const input=document.querySelector('[aria-label="搜索本地接口供应商或模型"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'界面验证');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await waitFor(`document.querySelectorAll('[data-aggregate-provider]').length===3&&document.querySelector('[data-aggregate-provider]')?.dataset.aggregateProvider===${JSON.stringify(provider.id)}`, 'aggregate search keeps fixture model in view');
    await inspectLayout('aggregate', 'aggregate');
    await inspectRequestLogs();
    assert.deepEqual(store.listBindings(), originalBindings, 'Provider management never writes tool bindings');
    writeFileSync(join(outputDir, 'provider-management-validation.json'), JSON.stringify({ ok: true, categories: categoryTools, sourceCategories: Object.fromEntries(Object.entries(sourceCategories).map(([category, ids]) => [category, ids.length])), removedEmptySeedProviders: emptySeedProviders.length, removedMcpSkillsNavigation: true, exactNativeClipboardCopies: true, nativeModelAndAggregateAliasDistinct: true, keysMaskedUntilExplicitReveal: true, hideDiscardsPlaintext: true, backgroundPollingPreservesReveal: true, providerNavigationAndRefreshResetKey: true, gatewayNavigationResetsKey: true, subscriptionTokensRejected: true, aggregateProviderModelMembershipPersists: true, globalProviderAndModelRemainEnabled: true, toolBindingsUnchanged: true, noActualClientProfiles: true, layouts }, null, 2));
  } finally {
    await clipboard.clear();
    await evaluate(`document.querySelectorAll('[data-secret-field] input').forEach(input=>{input.type='password';input.value='************'})`);
    window.setMinimumSize(originalMinimum[0], originalMinimum[1]); window.setSize(originalSize[0], originalSize[1]);
  }
}
