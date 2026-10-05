import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Store } from './store';
import type { Snapshot } from '../shared/types';

/** Native directory UI verification against the mock-auth source and loopback catalog. */
export async function verifyCodexCatalog(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream, 'Codex catalog smoke requires explicit fixture isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1', 'Codex catalog smoke requires the synthetic authorization transport');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const fixturePath = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !/^[A-Za-z]:/.test(fixturePath), 'Codex catalog data must stay below the smoke fixture directory');
  const loopback = new URL(upstream);
  assert.equal(loopback.protocol, 'http:'); assert.equal(loopback.hostname, '127.0.0.1');
  assert.ok(loopback.port && !loopback.username && !loopback.password && !loopback.search && !loopback.hash);
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Codex catalog smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(button.disabled)throw new Error('Codex catalog control disabled');button.click()})()`);
  }
  const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
  assert.equal(resolve(snapshot.dataDir), resolve(dataDir), 'Catalog renderer must use the isolated database');
  const provider = store.listProviders().find(item => item.name === '等待授权回归测试' && item.kind === 'codex');
  assert.ok(provider, 'Mock authorization lifecycle must run before the native catalog test');
  assert.equal(provider.authStatus, 'ready'); assert.equal(provider.hasSecret, true);
  assert.equal(store.listModels().filter(model => model.providerId === provider.id).length, 0, 'Mock Codex source must start without models');
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'previous dialog closed');
  await click('[aria-label="刷新本机配置"]');
  await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'mock authorized source refreshed');
  await click(`[data-source-id="${provider.id}"]`);
  await click('[data-action="discover-models"]');
  await waitFor(`document.querySelectorAll('.discovery-model').length===1&&!document.querySelector('.discovery-loading, .discovery-error')`, 'native visible model loaded');
  const candidate = await evaluate<{ count: number; upstreamId: string; displayName: string; alias: string; selected: boolean; disabled: boolean; details: string; hiddenShown: boolean; hasError: boolean }>(`(()=>{
    const dialog=document.querySelector('[role="dialog"]'),rows=dialog.querySelectorAll('.discovery-model'),row=rows[0],checkbox=row.querySelector('input[type="checkbox"]');
    return {count:rows.length,upstreamId:row.querySelector('.discovery-model-select strong').textContent,displayName:row.querySelector('[aria-label="mock-codex 显示名称"]').value,alias:row.querySelector('[aria-label="mock-codex 模型简称"]').value,selected:checkbox.checked,disabled:checkbox.disabled,details:row.textContent,hiddenShown:dialog.textContent.includes('mock-codex-hidden')||dialog.textContent.includes('mock-codex-none'),hasError:!!dialog.querySelector('[role="alert"]')};
  })()`);
  assert.equal(candidate.count, 1); assert.equal(candidate.upstreamId, 'mock-codex'); assert.equal(candidate.displayName, 'Native Codex');
  assert.equal(candidate.selected, true); assert.equal(candidate.disabled, false); assert.equal(candidate.hiddenShown, false); assert.equal(candidate.hasError, false);
  assert.match(candidate.details, /Responses/); assert.match(candidate.details, /272,000/); assert.match(candidate.details, /工具调用/); assert.match(candidate.details, /图片输入/);

  async function layout() {
    return evaluate<{ dialogInside: boolean; footerVisible: boolean; horizontalOverflow: boolean; mainOverflow: boolean }>(`(()=>{
      const dialog=document.querySelector('[role="dialog"]'),body=dialog.querySelector('.discovery-body'),footer=dialog.querySelector('.discovery-footer'),main=document.querySelector('main'),bounds=dialog.getBoundingClientRect(),end=footer.getBoundingClientRect();
      return {dialogInside:bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth+1&&bounds.bottom<=innerHeight+1,footerVisible:end.top>=0&&end.bottom<=innerHeight+1,horizontalOverflow:body.scrollWidth>body.clientWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1};
    })()`);
  }
  window.setSize(1320, 880); await waitFor('innerWidth>1100', 'large native directory viewport');
  const largeLayout = await layout();
  assert.equal(largeLayout.dialogInside, true); assert.equal(largeLayout.footerVisible, true); assert.equal(largeLayout.horizontalOverflow, false); assert.equal(largeLayout.mainOverflow, false);
  writeFileSync(join(outputDir, 'electron-codex-catalog-native-1320.png'), await captureUi());
  window.setSize(980, 680); await waitFor('innerWidth<1100', 'compact native directory viewport');
  const compactLayout = await layout();
  assert.equal(compactLayout.dialogInside, true); assert.equal(compactLayout.footerVisible, true); assert.equal(compactLayout.horizontalOverflow, false); assert.equal(compactLayout.mainOverflow, false);
  writeFileSync(join(outputDir, 'electron-codex-catalog-native-980.png'), await captureUi());
  await click('.discovery-footer button.primary');
  await waitFor(`!!document.querySelector('.discovery-success')&&document.querySelectorAll('.discovery-model.existing').length===1`, 'native selected model saved');
  const saved = store.listModels().filter(model => model.providerId === provider.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].upstreamId, 'mock-codex'); assert.equal(saved[0].displayName, 'Native Codex');
  assert.equal(saved[0].contextWindow, 272000); assert.equal(saved[0].wireApi, 'responses'); assert.equal(saved[0].tools, true); assert.equal(saved[0].vision, true); assert.equal(saved[0].enabled, true);
  await click('.discovery-footer button.secondary');
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'saved directory dialog closed');
  await click('[data-action="discover-models"]');
  await waitFor(`document.querySelectorAll('.discovery-model.existing').length===1&&!document.querySelector('.discovery-loading, .discovery-error')`, 'repeat directory recognizes existing model');
  const repeated = await evaluate<{ rows: number; checkboxDisabled: boolean; checked: boolean; addDisabled: boolean; hiddenShown: boolean }>(`(()=>{
    const dialog=document.querySelector('[role="dialog"]'),checkbox=dialog.querySelector('.discovery-model input[type="checkbox"]');
    return {rows:dialog.querySelectorAll('.discovery-model').length,checkboxDisabled:checkbox.disabled,checked:checkbox.checked,addDisabled:dialog.querySelector('.discovery-footer button.primary').disabled,hiddenShown:dialog.textContent.includes('mock-codex-hidden')||dialog.textContent.includes('mock-codex-none')};
  })()`);
  assert.equal(repeated.rows, 1); assert.equal(repeated.checkboxDisabled, true); assert.equal(repeated.checked, false); assert.equal(repeated.addDisabled, true); assert.equal(repeated.hiddenShown, false);
  // Disabled HTML buttons ignore clicks; no second save should be possible.
  await evaluate(`document.querySelector('.discovery-footer button.primary').click()`);
  const afterRepeat = store.listModels().filter(model => model.providerId === provider.id);
  assert.equal(afterRepeat.length, 1); assert.equal(afterRepeat[0].id, saved[0].id);
  writeFileSync(join(outputDir, 'codex-catalog-validation.json'), JSON.stringify({ provider: { id: provider.id, name: provider.name, authStatus: provider.authStatus }, candidate, largeLayout, compactLayout, saved: saved.map(model => ({ id: model.id, upstreamId: model.upstreamId, displayName: model.displayName, contextWindow: model.contextWindow, wireApi: model.wireApi, tools: model.tools, vision: model.vision })), repeated, finalModelCount: afterRepeat.length }, null, 2));
  await click('.discovery-footer button.secondary');
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'repeat directory closed');
}
