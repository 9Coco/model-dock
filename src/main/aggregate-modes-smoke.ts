import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';
import type { Model, ToolBinding, ToolId } from '../shared/types';
import { bindingConnectionPolicy } from '../shared/bindings';
import { isJetBrainsTool } from '../shared/jetbrains';

const tools: ToolId[] = ['codex', 'claude-code', 'opencode', 'dsh', 'vscode', 'copilot', 'webstorm', 'intellij-idea', 'rider', 'pycharm'];
/** 修改点：验证真实React切换与IPC保存，外部客户端写入仅限隔离的假home。 */
export async function verifyAggregateModes(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!)); assert.equal(resolve(store.dataDir), resolve(process.env.MODELDOCK_DATA_DIR!));
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const upstream = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!); assert.equal(upstream.hostname, '127.0.0.1'); assert.equal(upstream.protocol, 'http:');
  const providers = ['a', 'b'].map(side => store.saveProvider({ name: `聚合验证 ${side.toUpperCase()}`, kind: 'openai-compatible', baseUrl: `${upstream.origin}/aggregate/${side}/v1`, claudeBaseUrl: `${upstream.origin}/aggregate/native-${side}`, messagesAuth: side === 'a' ? 'api-key' : 'bearer', enabled: true, apiKey: `synthetic-${side}` }));
  const models: Model[] = [];
  for (const [index, provider] of providers.entries()) for (const wireApi of ['chat-completions', 'responses', 'messages'] as const) models.push(store.saveModel({ providerId: provider.id, upstreamId: 'shared-model', alias: `aggregate-${index}-${wireApi}`, displayName: `${index ? 'B' : 'A'}验证模型`, wireApi, contextWindow: 64000, tools: true, vision: false, enabled: true }));
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, name: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(30); }
    writeFileSync(join(outputDir, 'aggregate-timeout.png'), await captureUi());
    writeFileSync(join(outputDir, 'aggregate-timeout.json'), JSON.stringify({ name, text: await evaluate<string>('document.body.innerText') }, null, 2));
    throw new Error(`Aggregate UI verification timed out: ${name}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  const stored = (tool: ToolId) => store.listBindings().find(binding => binding.id === tool)!;
  async function idle(tool: ToolId): Promise<void> {
    await waitFor(`!!document.querySelector('[data-tool-binding="${tool}"]')&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled&&!document.querySelector('[data-action="tool-default-model"]').disabled`, `${tool} saved`);
  }
  const gateway = await evaluate<any>('window.modelDock.startGateway(0)'); assert.equal(gateway.running, true);
  await click('[aria-label="刷新本机配置"]');
  const results: unknown[] = [], layouts: unknown[] = [];
  for (const tool of tools) {
    await click(`[data-page="tools"][data-tool-id="${tool}"]`);
    await waitFor(`!!document.querySelector('[data-action="tool-use-aggregate"]')&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled`, `${tool} toggle`);
    if (!await evaluate<boolean>('document.querySelector("[data-action=tool-use-aggregate]").checked')) await click('[data-action="tool-use-aggregate"]');
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.mode==='aggregate'&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled;})()`, `${tool} aggregate mode`);
    for (const provider of providers) {
      await click(`article[data-provider-id="${provider.id}"] input[data-action="select-tool-provider"]`);
      await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.providerIds.includes(${JSON.stringify(provider.id)})&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled;})()`, `${tool} source`);
    }
    const protocol = tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'messages' : 'chat-completions';
    const chosen = models.filter(model => model.wireApi === protocol);
    const action = tool === 'codex' ? 'select-codex-aggregate-model' : 'select-tool-aggregate-model';
    for (const model of models.filter(model => model.wireApi !== protocol && (tool === 'claude-code' || model.wireApi !== 'messages') && (tool !== 'codex' || model.wireApi === 'responses'))) {
      const selector = `input[data-action="${action}"][data-model-id="${model.id}"]`;
      if (await evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)})?.checked===true`)) { await click(selector); await idle(tool); }
    }
    await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(chosen[1].id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.defaultModelId===${JSON.stringify(chosen[1].id)}&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled;})()`, `${tool} default B`);
    assert.deepEqual(new Set(stored(tool).providerIds), new Set(providers.map(provider => provider.id)));
    assert.deepEqual(new Set(stored(tool).modelIds), new Set(chosen.map(model => model.id)));
    assert.equal(bindingConnectionPolicy(stored(tool), store.listModels(), store.listProviders()).groups.length, 1);
    assert.equal(bindingConnectionPolicy(stored(tool), store.listModels(), store.listProviders()).groups[0].connection, 'local-managed');
    const preview = await evaluate<any>(`window.modelDock.previewConfig(${JSON.stringify(tool)})`);
    assert.ok(preview.content.includes(`/tool/${tool}`)); assert.ok(!preview.content.includes('synthetic-a') && !preview.content.includes('synthetic-b'));
    if (tool === 'claude-code') { const config = JSON.parse(preview.content); assert.equal(config.modelPicker.options.length, 2); assert.deepEqual(new Set(config.availableModels), new Set(chosen.map(model => model.alias))); }
    const headers = { authorization: `Bearer ${store.gatewayKey()}`, 'content-type': 'application/json' };
    const path = tool === 'claude-code' ? 'messages' : tool === 'codex' ? 'responses' : 'chat/completions';
    for (const [index, model] of chosen.entries()) {
      const body = tool === 'claude-code' ? { model: model.alias, max_tokens: 64, messages: [{ role: 'user', content: 'SYNTHETIC_AGGREGATE_PROMPT' }] } : tool === 'codex' ? { model: model.alias, input: 'SYNTHETIC_AGGREGATE_PROMPT' } : { model: model.alias, messages: [{ role: 'user', content: 'SYNTHETIC_AGGREGATE_PROMPT' }] };
      const response = await fetch(`http://127.0.0.1:${gateway.port}/tool/${tool}/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200);
      const value = await response.json() as any;
      assert.equal(value.model, model.alias);
      const text = tool === 'claude-code' ? value.content[0].text : tool === 'codex' ? value.output[0].content[0].text : value.choices[0].message.content;
      assert.equal(text, `MOCK_${index ? 'B' : 'A'}`);
    }
    // 各页截图前通过真实关闭按钮清理已验收的通知，避免未运行的Copilot提示遮挡其他页面。
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    await pause(40);
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height);
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0;window.scrollTo(0,0);})()`); await pause(80);
      const layout = await evaluate<any>(`(()=>{const main=document.querySelector('.main-content'),rect=document.querySelector('[data-action="tool-use-aggregate"]').getBoundingClientRect();return {horizontalOverflow:main.scrollWidth>main.clientWidth+1,toggleVisible:rect.top>=0&&rect.bottom<=innerHeight+1,checked:document.querySelector('[data-action="tool-use-aggregate"]').checked};})()`);
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.toggleVisible, true); assert.equal(layout.checked, true);
      layouts.push({ tool, theme, width, height, ...layout });
      if (['claude-code', 'webstorm', 'opencode', 'codex'].includes(tool)) writeFileSync(join(outputDir, `${tool}-aggregate-${theme}-${width}.png`), await captureUi());
    }
    await click('[data-action="tool-use-aggregate"]');
    await waitFor(`(async()=>{const binding=(await window.modelDock.snapshot()).bindings.find(b=>b.id===${JSON.stringify(tool)});return binding.mode==='direct'&&binding.providerIds.length===1&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled;})()`, `${tool} direct mode`);
    assert.deepEqual(stored(tool).providerIds, [providers[1].id]); assert.equal(stored(tool).defaultModelId, chosen[1].id);
    const direct = await evaluate<any>(`window.modelDock.previewConfig(${JSON.stringify(tool)})`);
    assert.ok(!direct.content.includes(`/tool/${tool}`));
    if (isJetBrainsTool(tool)) assert.equal(JSON.parse(direct.content).modelAssignment.core, `OpenAIAPI/${chosen[1].upstreamId}`);
    const singleRequest = await fetch(`http://127.0.0.1:${gateway.port}/tool/${tool}/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(tool === 'codex' ? { model: chosen[0].alias, input: 'SYNTHETIC' } : { model: chosen[0].alias, max_tokens: 64, messages: [{ role: 'user', content: 'SYNTHETIC' }] }) }); assert.equal(singleRequest.status, 403);
    results.push({ tool, twoSourceAggregate: true, oneEndpoint: true, exactModels: true, routedAAndB: true, defaultProviderRetainedOnDirect: true, directUsesNativeApi: true, excludedSourceRejected: true, externalSync: tool === 'copilot' ? 'serialization-only-no-running-client' : isJetBrainsTool(tool) ? 'manual-offline-boundary' : 'isolated-fixture' });
  }
  writeFileSync(join(outputDir, 'aggregate-modes-validation.json'), JSON.stringify({ ok: true, tools: results, layouts, allTenToggles: true, mockInferenceRequests: 20, noActualClientProfiles: true }, null, 2));
}
