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
  const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '模型参数字典测试', kind: 'openai-compatible', presetId: 'custom', baseUrl: upstream, enabled: true, apiKey: 'synthetic-only' })})`);
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
  await waitFor(`document.querySelectorAll('.discovery-model').length===4`, 'four fixture candidates');
  const row = '.discovery-model:has(input[aria-label="选择模型 gpt-4o"])';
  assert.ok((await evaluate<string>(`document.querySelector(${JSON.stringify(row)}).innerText`)).includes('字典补全'));
  await click(`${row} summary`);
  await waitFor(`!!document.querySelector('input[aria-label="gpt-4o 上下文长度"]')`, 'individual context editor');
  const layouts: unknown[] = [];
  for (const [width, height] of [[1320, 880], [980, 680]]) {
    window.setContentSize(width, height);
    await new Promise(done => setTimeout(done, 180));
    const layout = await evaluate<{ noOverflow: boolean; footerVisible: boolean; editorVisible: boolean }>(`(()=>{const modal=document.querySelector('.modal'),footer=modal.querySelector('.modal-footer').getBoundingClientRect(),editor=document.querySelector('input[aria-label="gpt-4o 上下文长度"]');return {noOverflow:document.documentElement.scrollWidth<=innerWidth+1&&modal.scrollWidth<=modal.clientWidth+1,footerVisible:footer.bottom<=innerHeight+1&&footer.top>=0,editorVisible:!!editor&&!editor.disabled}})()`);
    assert.equal(layout.noOverflow, true); assert.equal(layout.footerVisible, true); assert.equal(layout.editorVisible, true);
    layouts.push({ width, height, ...layout });
    writeFileSync(join(outputDir, `model-metadata-${width}.png`), await captureUi());
  }
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="gpt-4o 上下文长度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('input[aria-label="gpt-4o 上下文长度"]').value==='0'`, 'zero context override');
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="gpt-4o 图片输入"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'no');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.querySelector('select[aria-label="gpt-4o 图片输入"]').value==='no'`, 'false image override');
  await click('.discovery-footer .button.primary');
  await waitFor(`!!document.querySelector('.discovery-success')`, 'batch imported');
  const saved = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.filter(model => model.providerId === provider.id);
  assert.equal(saved.length, 4);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4o')!.vision, false);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4.1')!.contextWindow, discovered.models.find(model => model.upstreamId === 'gpt-4.1')!.contextWindow);
  assert.equal(saved.find(model => model.upstreamId === 'gpt-4.1')!.vision, true);
  assert.equal(saved.find(model => model.upstreamId === 'unknown-fixture-model')!.tools, false);
  await click('.discovery-footer .footer-actions .button.secondary:nth-last-child(2)');
  await click('[data-action="discover-models"]');
  await waitFor(`document.querySelectorAll('.discovery-model.existing').length===4`, 'existing candidates');
  const rediscovered = await evaluate<DiscoveryResult>(`window.modelDock.discoverModels(${JSON.stringify(provider.id)})`);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'gpt-4o')!.vision, false);
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
  assert.equal(await evaluate<number>(`document.querySelectorAll('[data-field^="reasoning-effort-"]').length`), 0);
  await input('context-window', '0');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), true);
  await click(field('model-vision'));
  await input('upstream-id', 'unknown-experimental-model');
  await waitFor(`document.querySelector('${field('max-output-tokens')}').value==='0'`, 'unknown output clears');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="apply-official-model-parameters"]').disabled`), true);
  await input('upstream-id', 'kimi-k3');
  await waitFor(`document.querySelector('${field('max-output-tokens')}').value==='131072'`, 'known output restores');
  assert.equal(await evaluate<string>(`document.querySelector('${field('context-window')}').value`), '0');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  await click('[data-action="apply-official-model-parameters"]');
  await waitFor(`document.querySelector('${field('context-window')}').value==='1024000'`, 'explicit apply overrides manual zero');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-field="official-parameters-applied"]')`), true);
  assert.ok((await evaluate<string>(`document.querySelector('[data-action="apply-official-model-parameters"]').innerText`)).includes('已填入草稿'));
  await input('max-output-tokens', '65536');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-field="official-parameters-applied"]')`), false);
  await click('[data-action="apply-official-model-parameters"]');
  await waitFor(`document.querySelector('${field('max-output-tokens')}').value==='131072'`, 'inline feedback reapplies parameters');
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
  }
  await click('.modal-footer button[type="submit"]');
  await waitFor(`!document.querySelector('.modal')`, 'manual model saved');
  const manual = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.providerId === official.id && model.upstreamId === 'kimi-k3')!;
  assert.equal(manual.contextWindow, 1024000); assert.equal(manual.maxOutputTokens, 131072); assert.equal(manual.thinking, true);
  const legacy = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ ...manual, contextWindow: 128000, maxOutputTokens: 4096, vision: false, thinking: false })})`);
  await click('[aria-label="刷新本机配置"]');
  await click(`[data-model-id="${legacy.id}"] [data-action="edit-model"]`);
  assert.equal(await evaluate<string>(`document.querySelector('${field('context-window')}').value`), '128000');
  assert.equal(await evaluate<boolean>(`document.querySelector('${field('model-vision')}').checked`), false);
  await click('[data-action="apply-official-model-parameters"]');
  await waitFor(`document.querySelector('${field('context-window')}').value==='1024000'`, 'existing Kimi applies official parameters');
  await click('.modal-footer button[type="submit"]');
  await waitFor(`!document.querySelector('.modal')`, 'updated model saved');
  const updated = (await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.id === legacy.id)!;
  assert.equal(updated.contextWindow, 1024000); assert.equal(updated.maxOutputTokens, 131072); assert.equal(updated.vision, true); assert.equal(updated.thinking, true);
  writeFileSync(join(outputDir, 'model-metadata-validation.json'), JSON.stringify({ ok: true, dictionaryFilled: true, upstreamPrecedence: true, unknownRetained: true, manualZeroAndFalseSaved: true, rediscoveryPreserved: true, modelsAdded: saved.length, layouts, manualLayouts, newModelDefaults: true, unknownIdCleared: true, manualOverridesPreserved: true, explicitApplyUpdatedExisting: true, syntheticOnly: true }, null, 2));
}
