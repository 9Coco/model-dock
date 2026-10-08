import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Provider, Snapshot } from '../shared/types';
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
  assert.deepEqual(gpt4o.metadataInferred, ['contextWindow', 'vision']);
  const upstreamModel = discovered.models.find(model => model.upstreamId === 'gpt-4o-mini')!;
  assert.equal(upstreamModel.contextWindow, 4096); assert.equal(upstreamModel.vision, false);
  assert.ok(!upstreamModel.metadataInferred?.length);
  const unknown = discovered.models.find(model => model.upstreamId === 'unknown-fixture-model')!;
  assert.equal(unknown.contextWindow, 0); assert.equal(unknown.vision, false);
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
  await click('.discovery-footer .footer-actions .button.secondary:nth-last-child(2)');
  await click('[data-action="discover-models"]');
  await waitFor(`document.querySelectorAll('.discovery-model.existing').length===4`, 'existing candidates');
  const rediscovered = await evaluate<DiscoveryResult>(`window.modelDock.discoverModels(${JSON.stringify(provider.id)})`);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  assert.equal(rediscovered.models.find(model => model.upstreamId === 'gpt-4o')!.vision, false);
  assert.equal((await evaluate<Snapshot>('window.modelDock.snapshot()')).models.find(model => model.providerId === provider.id && model.upstreamId === 'gpt-4o')!.contextWindow, 0);
  writeFileSync(join(outputDir, 'model-metadata-validation.json'), JSON.stringify({ ok: true, dictionaryFilled: true, upstreamPrecedence: true, unknownRetained: true, manualZeroAndFalseSaved: true, rediscoveryPreserved: true, modelsAdded: saved.length, layouts }, null, 2));
}
