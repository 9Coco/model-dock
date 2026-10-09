import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';
import { JETBRAINS_TOOL_IDS, JETBRAINS_TOOLS, type JetBrainsToolId } from '../shared/jetbrains';

/** 修改点：四 IDE 测试全部使用新建的假 profile；不操作真实 IDE、密码库或账号。 */
export async function verifyJetBrainsConnections(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  assert.ok(!relative(join(outputDir, 'data'), store.dataDir).startsWith('..'));
  const source = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!); assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.protocol, 'http:'); source.pathname = '/jetbrains/v1';
  const native = store.saveProvider({ name: 'JetBrains 模拟 API', kind: 'openai-compatible', baseUrl: source.href, enabled: true, apiKey: 'synthetic-only' });
  const responses = store.saveProvider({ name: 'Responses 模拟来源', kind: 'openai-compatible', baseUrl: source.href, enabled: true, apiKey: 'synthetic-only' });
  const chat = store.saveModel({ providerId: native.id, upstreamId: 'jb-chat-native', alias: 'jb-chat-alias', displayName: '聊天验证模型', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const responseModel = store.saveModel({ ...chat, id: undefined, providerId: responses.id, upstreamId: 'jb-responses-native', alias: 'jb-responses-alias', displayName: 'Responses 验证模型', wireApi: 'responses' });
  const home = join(store.dataDir, 'feature-home'), root = join(home, '.config', 'JetBrains'), cache = join(home, '.cache', 'JetBrains');
  const originals = new Map<JetBrainsToolId, Record<string, string>>();
  for (const tool of JETBRAINS_TOOL_IDS) {
    const selector = `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`, options = join(root, selector, 'options');
    mkdirSync(options, { recursive: true, mode: 0o700 }); mkdirSync(join(cache, selector), { recursive: true, mode: 0o700 });
    writeFileSync(join(cache, selector, '.pid'), '99999999', { mode: 0o600 });
    const files = {
      'llm.provider.openai.like.xml': '<application><!-- keep provider comment --><component name="OpenAILikeLlmProviderSettings"><option name="baseUrl" value="http://127.0.0.1:8317/v1"/><option name="httpClientVersion" value="HTTP_2"/><option name="toolEnabled" value="false"/><option name="otherSetting" value="keep"/></component></application>',
      'llm.custom.models.xml': '<application><component name="LlmCustomModelsSettings"><option name="smart_model_id" value="OpenAIAPI/old-core"/><option name="quick_model_id" value="OpenAIAPI/old-quick"/><option name="editor_model_id" value="keep-completion"/></component></application>',
      'llm.third.party.ai.providers.xml': '<application><component name="LLMThirdPartyAIProvidersSettings"><option name="enabledThirdPartyAIProviders"><option value="Anthropic"/></option></component></application>',
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(options, name), content, { mode: 0o600 });
    writeFileSync(join(root, selector, 'c.kdbx'), 'SYNTHETIC_PASSWORD_STORE_BYTES', { mode: 0o600 }); originals.set(tool, files);
  }
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(30); }
    writeFileSync(join(outputDir, 'jetbrains-timeout.png'), await captureUi()); throw new Error('JetBrains 页面验证等待超时');
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  const gateway = await evaluate<any>('window.modelDock.startGateway(0)'); assert.equal(gateway.running, true);
  await click('[aria-label="刷新本机配置"]');
  const results: unknown[] = [], layouts: unknown[] = [];
  for (const [index, tool] of JETBRAINS_TOOL_IDS.entries()) {
    await click(`[data-page="tools"][data-tool-id="${tool}"]`);
    await waitFor(`!!document.querySelector('[data-jetbrains-connection="${tool}"]')&&!document.querySelector('[data-action="apply-tool-config"]').disabled`);
    const selector = `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`, profile = join(root, selector), options = join(profile, 'options');
    await click(`article[data-provider-id="${native.id}"] input[data-action="select-tool-provider"]`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.providerIds.includes(${JSON.stringify(native.id)})&&!document.querySelector('[data-action="tool-default-model"]').disabled;})()`);
    await click(`article[data-provider-id="${responses.id}"] input[data-action="select-tool-provider"]`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.providerIds.length===2&&!document.querySelector('[data-action="tool-default-model"]').disabled;})()`);
    const model = index % 2 ? responseModel : chat;
    await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(model.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.defaultModelId===${JSON.stringify(model.id)}&&!document.querySelector('[data-action="tool-default-model"]').disabled;})()`);
    for (const [name, original] of Object.entries(originals.get(tool)!)) assert.equal(readFileSync(join(options, name), 'utf8'), original, 'Selecting a source must not write IDE settings');
    const preview = await evaluate<any>(`window.modelDock.previewConfig(${JSON.stringify(tool)})`);
    assert.equal(preview.content.includes('synthetic-only'), false); assert.equal(preview.content.includes(store.gatewayKey()), false);
    await click('[data-action="apply-tool-config"]');
    await waitFor(`document.querySelector('[data-tool-application-status]').dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]').disabled`);
    const providerXml = readFileSync(join(options, 'llm.provider.openai.like.xml'), 'utf8'), modelsXml = readFileSync(join(options, 'llm.custom.models.xml'), 'utf8');
    assert.ok(providerXml.includes(`http://127.0.0.1:${gateway.port}/tool/${tool}/v1`)); assert.ok(providerXml.includes('HTTP_1_1')); assert.ok(providerXml.includes('keep provider comment')); assert.ok(providerXml.includes('otherSetting'));
    assert.ok(modelsXml.includes(`OpenAIAPI/${model.alias}`)); assert.ok(modelsXml.includes('keep-completion'));
    assert.equal(readFileSync(join(profile, 'c.kdbx'), 'utf8'), 'SYNTHETIC_PASSWORD_STORE_BYTES');
    assert.ok(![providerXml, modelsXml].some(text => text.includes(store.gatewayKey()) || text.includes('synthetic-only')));
    const base = `http://127.0.0.1:${gateway.port}/tool/${tool}/v1`;
    const headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
    const catalog = await (await fetch(`${base}/models`, { headers })).json() as any;
    assert.deepEqual(new Set(catalog.data.map((entry: any) => entry.id)), new Set([chat.alias, responseModel.alias]));
    const reply = await (await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: model.alias, stream: false, messages: [{ role: 'user', content: 'SYNTHETIC_JB_PROMPT' }] }) })).json() as any;
    assert.equal(reply.choices[0].message.content, 'OK'); assert.equal(reply.model, model.alias);
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height);
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('[data-jetbrains-connection="${tool}"]').scrollIntoView({block:'start'});})()`);
      await pause(100);
      const layout = await evaluate<any>(`(()=>{const main=document.querySelector('.main-content'),panel=document.querySelector('[data-jetbrains-connection="${tool}"]'),rect=panel.getBoundingClientRect();return {horizontalOverflow:main.scrollWidth>main.clientWidth+1,panelInsideWidth:rect.left>=0&&rect.right<=innerWidth+1,copyKeyPresent:!!panel.querySelector('[data-action="jetbrains-copy-key"]')};})()`);
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.panelInsideWidth, true); assert.equal(layout.copyKeyPresent, true);
      layouts.push({ tool, theme, width, height, ...layout }); writeFileSync(join(outputDir, `${tool}-${theme}-${width}.png`), await captureUi());
    }
    if (tool === 'webstorm') {
      const pid = join(cache, selector, '.pid'); writeFileSync(pid, String(process.pid), { mode: 0o600 });
      await click('[data-action="jetbrains-refresh-status"]'); await waitFor(`document.querySelector('[data-jetbrains-running]').dataset.jetbrainsRunning==='running'`);
      assert.equal(await evaluate<boolean>('document.querySelector("[data-action=apply-tool-config]").disabled'), true);
      writeFileSync(pid, 'invalid', { mode: 0o600 }); await click('[data-action="jetbrains-refresh-status"]');
      await waitFor(`document.querySelector('[data-jetbrains-running]').dataset.jetbrainsRunning==='unknown'`); assert.equal(await evaluate<boolean>('document.querySelector("[data-action=apply-tool-config]").disabled'), true);
      writeFileSync(pid, '99999999', { mode: 0o600 }); await click('[data-action="jetbrains-refresh-status"]'); await waitFor(`!document.querySelector('[data-action="apply-tool-config"]').disabled`);
    }
    results.push({ tool, modelAlias: model.alias, nativeProtocol: model.wireApi, independentEndpoint: true, selectionDidNotWrite: true, profileSettingsSynced: true, passwordSafeUntouched: true, mockReply: 'OK' });
  }
  await click('[data-action="restore-official-tool-config"]'); await click('[data-action="confirm-tool-restore"]');
  await waitFor(`document.querySelector('[data-tool-application-status]').dataset.toolApplicationState==='official'`);
  const last = JETBRAINS_TOOL_IDS.at(-1)!, lastOptions = join(root, `${JETBRAINS_TOOLS[last].selectorPrefix}2026.2`, 'options');
  for (const [name, original] of Object.entries(originals.get(last)!)) assert.equal(readFileSync(join(lastOptions, name), 'utf8').replace(/>\s+</g, '><'), original.replace(/>\s+</g, '><'));
  assert.ok(readdirSync(join(store.dataDir, 'backups')).length > 0);
  writeFileSync(join(outputDir, 'jetbrains-ui-validation.json'), JSON.stringify({ ok: true, products: results, layouts, stoppedOnlySync: true, runningAndUnknownBlocked: true, restoredOriginalXmlValues: true, credentialsNeverWrittenToXml: true, rendererKeyRedacted: true }, null, 2));
}
