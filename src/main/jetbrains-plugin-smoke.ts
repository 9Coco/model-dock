import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, type BrowserWindow } from 'electron';
import type { Store } from './store';
import { JETBRAINS_TOOL_IDS, JETBRAINS_TOOLS, type JetBrainsToolId } from '../shared/jetbrains';

/** Synthetic offline profiles only. Air is manual setup; no Air file or password writes. */
export async function verifyJetBrainsPluginSwitch(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  assert.ok(!relative(join(outputDir, 'data'), store.dataDir).startsWith('..'));
  const source = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!);
  assert.equal(source.hostname, '127.0.0.1'); source.pathname = '/jetbrains/v1';
  const provider = store.saveProvider({ name: '插件切换验证来源', kind: 'openai-compatible', baseUrl: source.href, enabled: true, apiKey: 'synthetic-only' });
  const secondary = store.saveProvider({ name: 'Air 来源变化验证', kind: 'openai-compatible', baseUrl: source.href, enabled: true, apiKey: 'synthetic-only' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'jb-responses-native', alias: 'plugin-switch-responses', displayName: '插件切换验证模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
  store.saveModel({ ...model, id: undefined, providerId: secondary.id, alias: 'plugin-switch-secondary', displayName: '来源变化验证模型' });
  const home = join(store.dataDir, 'feature-home'), profiles = join(home, '.config', 'JetBrains'), cache = join(home, '.cache', 'JetBrains');
  const originals = new Map<JetBrainsToolId, Record<string, string>>();
  const airInitial = { entries: [{ id: '12345678-1234-4234-9234-123456789abc', type: 'openai', name: 'Existing independent provider', settings: [{ key: 'baseUrl', value: 'https://fixture.example.test/v1' }] }] };
  for (const tool of JETBRAINS_TOOL_IDS) {
    const selector = `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`, options = join(profiles, selector, 'options');
    mkdirSync(options, { recursive: true, mode: 0o700 }); mkdirSync(join(cache, selector), { recursive: true, mode: 0o700 });
    writeFileSync(join(cache, selector, '.pid'), '99999999', { mode: 0o600 });
    const files = {
      'llm.provider.openai.like.xml': '<application><!-- assistant provider --><component name="OpenAILikeLlmProviderSettings"><option name="baseUrl" value="https://assistant.example.test/v1"/><option name="httpClientVersion" value="HTTP_2"/><option name="toolEnabled" value="false"/></component></application>',
      'llm.custom.models.xml': '<application><component name="LlmCustomModelsSettings"><option name="smart_model_id" value="OpenAIAPI/original-core"/><option name="quick_model_id" value="OpenAIAPI/original-quick"/></component></application>',
      'llm.third.party.ai.providers.xml': '<application><component name="LLMThirdPartyAIProvidersSettings"><option name="enabledThirdPartyAIProviders"><option value="Anthropic"/></option></component></application>',
      'other.xml': `<application><!-- unrelated XML must survive --><component name="UnrelatedFixture"><option name="value" value="preserve"/></component><component name="AirByokConfigurations"><![CDATA[${JSON.stringify(airInitial)}]]></component></application>`,
    };
    originals.set(tool, files);
    for (const [name, value] of Object.entries(files)) writeFileSync(join(options, name), value, { mode: 0o600 });
    writeFileSync(join(profiles, selector, 'c.kdbx'), 'SYNTHETIC_PASSWORD_STORE_UNCHANGED', { mode: 0o600 });
    const binding = store.listBindings().find(row => row.id === tool)!;
    store.saveBinding({ ...binding, mode: 'aggregate', enabled: true, providerIds: [provider.id], modelIds: [], modelSelection: 'all', defaultModelId: model.id, jetBrainsPlugin: 'ai-assistant' });
  }
  const baseline = store.listBindings();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'jetbrains-plugin-timeout.png'), await captureUi());
    throw new Error(`Plugin switch UI timed out: ${label}`);
  }
  async function waitForFile(check: () => boolean, label: string): Promise<void> {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (check()) return; await pause(25); }
    throw new Error(`Plugin switch file timed out: ${label}`);
  }
  async function click(selector: string) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function open(tool: JetBrainsToolId) {
    await click('[data-tool-category="jetbrains"]'); await click(`[data-tool-id="${tool}"]`);
    await waitFor(`!!document.querySelector('[data-jetbrains-connection="${tool}"]')`, 'selected IDE');
  }
  async function select(plugin: string) {
    await waitFor(`!!document.querySelector('[data-action="jetbrains-plugin-select"]')&&!document.querySelector('[data-action="jetbrains-plugin-select"]').disabled`, 'selector enabled');
    await evaluate(`(()=>{const select=document.querySelector('[data-action="jetbrains-plugin-select"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(plugin)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('[data-jetbrains-connection]')?.dataset.jetbrainsPlugin===${JSON.stringify(plugin)}&&!document.querySelector('[data-action="jetbrains-plugin-select"]').disabled`, 'target switched');
  }
  function optionsFor(tool: JetBrainsToolId) { return join(profiles, `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`, 'options'); }
  function assertOriginal(tool: JetBrainsToolId) {
    for (const [name, value] of Object.entries(originals.get(tool)!)) assert.equal(readFileSync(join(optionsFor(tool), name), 'utf8'), value, `Air setup must not write ${tool} ${name}`);
    assert.equal(existsSync(join(optionsFor(tool), 'llm.next.edit.providers.xml')), false, 'Air never creates Assistant completion settings');
  }
  function assertPasswordSafe(tool: JetBrainsToolId) { assert.equal(readFileSync(join(profiles, `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`, 'c.kdbx'), 'utf8'), 'SYNTHETIC_PASSWORD_STORE_UNCHANGED'); }
  async function copied(selector: string, expected: string) {
    await clipboard.clear(); await click(selector);
    const end = Date.now() + 5000;
    while (await clipboard.readText() !== expected && Date.now() < end) await pause(25);
    assert.equal(await clipboard.readText(), expected, 'Native clipboard value must match the chosen parameter');
    await clipboard.clear();
  }
  const gateway = await evaluate<any>('window.modelDock.startGateway(0)'); assert.equal(gateway.running, true);
  await click('[aria-label="刷新本机配置"]');
  await waitFor(`window.modelDock.snapshot().then(value=>value.models.some(model=>model.id===${JSON.stringify(model.id)}))`, 'fixture snapshot');
  const results: { tool: JetBrainsToolId; [key: string]: unknown }[] = [], layouts: unknown[] = [];
  try {
    for (const tool of JETBRAINS_TOOL_IDS) {
      await open(tool);
      assert.equal(await evaluate<string>(`document.querySelector('[data-action="jetbrains-plugin-select"]').value`), 'ai-assistant');
      await select('air'); await pause(650); assertOriginal(tool);
      assert.equal(store.listBindings().find(row => row.id === tool)?.jetBrainsPlugin, 'air');
      for (const before of baseline.filter(row => row.id !== tool && !results.some(value => value.tool === row.id))) assert.equal(store.listBindings().find(row => row.id === before.id)?.jetBrainsPlugin ?? 'ai-assistant', before.jetBrainsPlugin ?? 'ai-assistant', 'Each IDE target is independent');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-jetbrains-completion="${tool}"],[data-jetbrains-connection="${tool}"] [data-action="apply-tool-config"]').length`), 0, 'Air must not offer Assistant completion or native sync');
      assert.ok(await evaluate<boolean>(`document.querySelector('[data-air-manual-setup]')?.textContent.includes('More Providers')`), 'Air guide must explain native manual provider creation');
      await click('[aria-label="刷新本机配置"]');
      await waitFor(`document.querySelector('[data-action="jetbrains-plugin-select"]').value==='air'`, 'target persisted after refresh');
      await open(tool === 'rider' ? 'webstorm' : 'rider'); await open(tool);
      assert.equal(await evaluate<string>(`document.querySelector('[data-action="jetbrains-plugin-select"]').value`), 'air', 'Target survives navigation'); assertOriginal(tool);
      const preview = await evaluate<any>(`window.modelDock.previewConfig(${JSON.stringify(tool)})`);
      assert.equal(preview.canApply, false, 'Air guide is never directly applicable');
      assert.ok(!preview.content.includes('synthetic-only') && !preview.content.includes(store.gatewayKey()), 'Preview redacts credentials');
      const url = `http://127.0.0.1:${gateway.port}/tool/${tool}/v1`;
      await copied('[aria-label="复制 JetBrains URL"]', url);
      await copied('[data-action="jetbrains-copy-key"]', store.gatewayKey());
      await copied('[aria-label="复制 Air 模型 ID"]', model.alias);
      await click(`article[data-provider-id="${secondary.id}"] input[data-action="select-tool-provider"]`);
      await waitFor(`window.modelDock.snapshot().then(value=>value.bindings.find(binding=>binding.id===${JSON.stringify(tool)}).providerIds.includes(${JSON.stringify(secondary.id)}))`, 'Air source selection saved');
      await pause(650); assertOriginal(tool);
      for (const method of ['applyConfig', 'restoreOfficialConfig']) assert.equal(await evaluate<boolean>(`window.modelDock.${method}(${JSON.stringify(tool)}).then(()=>false,()=>true)`), true, 'Air native writes are rejected at the bridge boundary');
      assertOriginal(tool); assertPasswordSafe(tool);
      await select('ai-assistant'); await pause(100); assertOriginal(tool);
      await click('[data-action="apply-tool-config"]');
      await waitForFile(() => readFileSync(join(optionsFor(tool), 'llm.provider.openai.like.xml'), 'utf8').includes(url), 'Assistant still synchronizes');
      assert.ok(readFileSync(join(optionsFor(tool), 'llm.custom.models.xml'), 'utf8').includes(`OpenAIAPI/${model.alias}`));
      assert.equal(readFileSync(join(optionsFor(tool), 'other.xml'), 'utf8'), originals.get(tool)!['other.xml'], 'Assistant sync preserves Air state'); assertPasswordSafe(tool);
      await evaluate(`window.modelDock.restoreOfficialConfig(${JSON.stringify(tool)})`);
      await waitForFile(() => !existsSync(join(optionsFor(tool), 'llm.next.edit.providers.xml')), 'Assistant restore completed');
      assert.equal(readFileSync(join(optionsFor(tool), 'other.xml'), 'utf8'), originals.get(tool)!['other.xml']); assertPasswordSafe(tool);
      await click('[aria-label="刷新本机配置"]'); await select('air');
      results.push({ tool, perIdeTargetPersisted: true, switchAndSourceChangesDoNotWrite: true, exactParameterClipboardCopies: true, airSetupManual: true, airApplyAndRestoreRejected: true, assistantSyncAndRestoreFunctional: true, passwordSafeUnchanged: true });
    }
    store.saveBinding({ ...baseline.find(binding => binding.id === 'rider')!, jetBrainsPlugin: 'air' });
    await click('[aria-label="刷新本机配置"]'); await open('rider');
    for (const plugin of ['air', 'ai-assistant']) {
      await select(plugin); await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
      for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
        window.setSize(width, height);
        await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0;})()`); await pause(100);
        const layout = await evaluate<{ documentOverflow: boolean; mainOverflow: boolean; completionVisible: boolean }>(`(()=>{const main=document.querySelector('.main-content');return {documentOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:main.scrollWidth>main.clientWidth,completionVisible:!!document.querySelector('[data-jetbrains-completion]')}})()`);
        assert.equal(layout.documentOverflow, false); assert.equal(layout.mainOverflow, false); assert.equal(layout.completionVisible, plugin === 'ai-assistant');
        writeFileSync(join(outputDir, `jetbrains-plugin-${plugin}-${theme}-${width}.png`), await captureUi()); layouts.push({ plugin, theme, width, height, ...layout });
      }
    }
    writeFileSync(join(outputDir, 'jetbrains-plugin-validation.json'), JSON.stringify({ ok: true, products: results, layouts, switchDoesNotApplySettings: true, airSetupManual: true, airFilesNeverWritten: true, perIdeTargetsIndependent: true, noPasswordSafeWrites: true, realProviderInferenceTested: false }, null, 2));
  } finally { await clipboard.clear(); }
}
