import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Model, Provider, Snapshot } from '../shared/types';
import type { ConnectionResult } from '../shared/connection-types';

/** Uses only the smoke runner's isolated database and synthetic loopback credentials. */
export async function verifyConnectionTest(window: BrowserWindow, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_NO_CATALOG;
  assert.ok(smokeDir && dataDir && upstream, 'Connection test smoke requires explicit fixture isolation');
  assert.equal(resolve(outputDir), resolve(smokeDir));
  const fixturePath = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !/^[A-Za-z]:/.test(fixturePath), 'Connection smoke database must be below its fixture directory');
  const fixtureUrl = new URL(upstream);
  assert.equal(fixtureUrl.protocol, 'http:'); assert.equal(fixtureUrl.hostname, '127.0.0.1'); assert.equal(fixtureUrl.pathname, '/no-catalog/v1');
  assert.ok(fixtureUrl.port && !fixtureUrl.username && !fixtureUrl.password && !fixtureUrl.search && !fixtureUrl.hash);
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Connection test smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(button.disabled)throw new Error('Connection control disabled: '+${JSON.stringify(selector)});button.click()})()`);
  }
  async function snapshot(): Promise<Snapshot> { return evaluate('window.modelDock.snapshot()'); }
  const initial = await snapshot(); assert.equal(resolve(initial.dataDir), resolve(dataDir), 'Preload bridge must use the isolated database');
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await waitFor(`!document.querySelector('.modal')`, 'prior dialogs closed');
  const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '无模型目录测试套餐', kind: 'openai-compatible', presetId: 'custom', baseUrl: upstream, enabled: true, apiKey: 'synthetic-only' })})`);
  const card = `article[data-provider-id="${provider.id}"]`;
  const badge = `${card} [data-default-test-model]`;
  const button = `${card} [data-action="test-provider"]`;
  const selector = `${card} select[data-action="select-test-model"]`;
  const busyChecks: Array<{ selectedModelId: string; selectorDisabled: boolean; testingText: string }> = [];
  async function refreshSource(): Promise<void> {
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'fixture source refreshed');
    await click(`[data-source-id="${provider.id}"]`);
    await waitFor(`!!document.querySelector(${JSON.stringify(button)})&&!!document.querySelector(${JSON.stringify(selector)})`, 'inline connection controls');
  }
  async function verifyBadge(model: Model): Promise<{ modelId: string; text: string; selectedModelId: string; selectedText: string }> {
    const target = `article[data-provider-id="${model.providerId}"] [data-default-test-model]`;
    await waitFor(`document.querySelector(${JSON.stringify(target)})?.dataset.modelId===${JSON.stringify(model.id)}&&document.querySelector(${JSON.stringify(`${target} select`)})?.value===${JSON.stringify(model.id)}`, 'selected test model updated');
    const value = await evaluate<{ modelId: string; text: string; selectedModelId: string; selectedText: string }>(`(()=>{const value=document.querySelector(${JSON.stringify(target)}),select=value.querySelector('select');return {modelId:value.dataset.modelId,text:value.textContent,selectedModelId:select.value,selectedText:select.selectedOptions[0]?.textContent??''}})()`);
    assert.ok(value.text.includes('测试模型') && value.selectedText.includes(model.upstreamId));
    return value;
  }
  async function choose(model: Model): Promise<void> {
    const target = `article[data-provider-id="${model.providerId}"] select[data-action="select-test-model"]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(target)})&&!document.querySelector(${JSON.stringify(target)}).disabled`, 'test model selection available');
    await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(target)});if(!Array.from(select.options).some(option=>option.value===${JSON.stringify(model.id)}&&!option.disabled))throw new Error('Test model option unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(model.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await verifyBadge(model); await noDialog();
  }
  async function counts(): Promise<{ providers: number; models: number; disabledModelIds: string[] }> {
    const value = await snapshot();
    return { providers: value.providers.filter(item => item.id === provider.id).length, models: value.models.filter(item => item.providerId === provider.id).length, disabledModelIds: value.models.filter(item => item.providerId === provider.id && !item.enabled).map(item => item.id) };
  }
  async function noDialog(): Promise<boolean> {
    const value = await evaluate<boolean>(`!document.querySelector('.modal, .connection-test-form')`);
    assert.equal(value, true, 'One-click connection test must not open a dialog'); return value;
  }
  async function run(model: Model, doubleClick = false): Promise<ConnectionResult> {
    // A complete busy cycle proves retry reads the new result rather than stale success.
    const value = await evaluate<{ result: ConnectionResult; busy: { selectedModelId: string; selectorDisabled: boolean; testingText: string } }>(`new Promise((resolve,reject)=>{
      const button=document.querySelector(${JSON.stringify(button)});
      if(!button||button.disabled){reject(new Error('Inline connection control unavailable'));return;}
      let busy=false,busyState;
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Inline connection test did not complete a new request'))},8000);
      const observer=new MutationObserver(()=>{
        const current=document.querySelector(${JSON.stringify(button)});if(current?.disabled){
          busy=true;const select=document.querySelector(${JSON.stringify(selector)});
          busyState={selectedModelId:select?.value,selectorDisabled:select?.disabled===true,testingText:document.querySelector(${JSON.stringify(`${card} .test-result.testing`)})?.textContent??''};
          if(!busyState.selectorDisabled||busyState.selectedModelId!==${JSON.stringify(model.id)}||!busyState.testingText.includes(${JSON.stringify(model.upstreamId)})){clearTimeout(timer);observer.disconnect();reject(new Error('Busy test must lock the selected model and display its upstream ID'));return;}
        }
        const result=document.querySelector(${JSON.stringify(`${card} [data-connection-result]`)});
        if(busy&&current&&!current.disabled&&result){clearTimeout(timer);observer.disconnect();resolve({result:{ok:result.dataset.success==='true',message:result.textContent??'',outcome:result.dataset.outcome,statusCode:result.dataset.statusCode?Number(result.dataset.statusCode):undefined,durationMs:result.dataset.durationMs?Number(result.dataset.durationMs):undefined,testedModel:result.dataset.testedModel,wireApi:result.dataset.wireApi},busy:busyState});}
      });
      observer.observe(document.body,{subtree:true,childList:true,attributes:true});button.click();${doubleClick ? 'button.click();' : ''}
    })`);
    assert.equal(value.busy.selectorDisabled, true); assert.equal(value.busy.selectedModelId, model.id);
    busyChecks.push(value.busy); await noDialog(); return value.result;
  }
  function success(result: ConnectionResult, model: Model): void {
    assert.equal(result.ok, true); assert.equal(result.outcome, 'success'); assert.equal(result.statusCode, 200);
    assert.equal(result.testedModel, model.upstreamId); assert.equal(result.wireApi, model.wireApi);
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs! >= 0, 'Successful test must report actual duration');
    assert.equal('modelIds' in result, false, 'Request test must not masquerade as model discovery');
  }
  await refreshSource();
  const noModel = await evaluate<{ disabled: boolean; selectorDisabled: boolean; text: string }>(`(()=>({disabled:document.querySelector(${JSON.stringify(button)}).disabled,selectorDisabled:document.querySelector(${JSON.stringify(selector)}).disabled,text:document.querySelector(${JSON.stringify(badge)}).textContent}))()`);
  assert.ok(noModel.text.includes('尚未添加模型'));
  assert.equal(noModel.disabled, true); assert.equal(noModel.selectorDisabled, true);
  await noDialog(); assert.equal((await counts()).models, 0, 'No-model test must not silently create a model');

  const first = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: provider.id, upstreamId: 'no-list-model', alias: 'no-list-saved', displayName: '首个模型（已停用）', wireApi: 'chat-completions', contextWindow: 0, tools: false, vision: false, enabled: false })})`);
  const second = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: provider.id, upstreamId: 'no-list-second-model', alias: 'no-list-second', displayName: '第二个模型', wireApi: 'responses', contextWindow: 0, tools: false, vision: false, enabled: true })})`);
  const orderedModels = (await snapshot()).models.filter(item => item.providerId === provider.id);
  assert.deepEqual(orderedModels.map(item => item.id), [first.id, second.id], 'Fixture requires explicit first/second saved order');
  await refreshSource(); const firstBadge = await verifyBadge(first);
  const options = await evaluate<Array<{ id: string; text: string; disabled: boolean }>>(`Array.from(document.querySelector(${JSON.stringify(selector)}).options,option=>({id:option.value,text:option.textContent,disabled:option.disabled}))`);
  assert.deepEqual(options.map(option => option.id), [first.id, second.id]);
  assert.equal(options[0].disabled, false, 'A disabled model remains available for explicit inference testing');
  assert.ok(options[0].text.includes('已停用'));
  const inlineFirst = await run(first); success(inlineFirst, first);
  const afterFirst = await counts(); assert.equal(afterFirst.models, 2); assert.deepEqual(afterFirst.disabledModelIds, [first.id], 'Testing a disabled first model must preserve its flag');

  await click('[data-page="providers"][data-source="aggregate"]');
  await waitFor(`!!document.querySelector(${JSON.stringify(badge)})`, 'aggregate inline widget');
  const aggregateBadge = await verifyBadge(first); await noDialog();
  await click('[data-tool-id="codex"]');
  await waitFor(`!!document.querySelector(${JSON.stringify(badge)})`, 'tool-page inline widget');
  const toolBadge = await verifyBadge(first); await noDialog();
  await click(`[data-source-id="${provider.id}"]`);
  const doubleClick = await run(first, true); success(doubleClick, first);
  assert.deepEqual((await counts()).disabledModelIds, [first.id]);

  await choose(second); const secondBadge = await verifyBadge(second);
  const selectedSecond = await run(second); success(selectedSecond, second);
  const otherProvider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '测试模型独立选择', kind: 'openai-compatible', presetId: 'custom', baseUrl: upstream, enabled: true, apiKey: 'synthetic-only' })})`);
  const otherFirst = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: otherProvider.id, upstreamId: 'other-first-model', alias: 'other-first-test', displayName: '其他供应商首项', wireApi: 'chat-completions', contextWindow: 0, tools: false, vision: false, enabled: true })})`);
  const otherSecond = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ ...otherFirst, id: undefined, upstreamId: 'other-second-model', alias: 'other-second-test', displayName: '其他供应商第二项' })})`);
  await refreshSource(); await click(`[data-source-id="${otherProvider.id}"]`);
  const otherDefaultBadge = await verifyBadge(otherFirst);
  const otherOptions = await evaluate<string[]>(`Array.from(document.querySelector('article[data-provider-id="${otherProvider.id}"] select[data-action="select-test-model"]').options,option=>option.value)`);
  assert.deepEqual(otherOptions, [otherFirst.id, otherSecond.id], 'Only the current supplier models may be selected');
  await choose(otherSecond);
  await click(`[data-source-id="${provider.id}"]`); const supplierReturnBadge = await verifyBadge(second);
  await click('[data-page="providers"][data-source="aggregate"]'); const selectedAggregateBadge = await verifyBadge(second);
  await click('[data-tool-id="codex"]'); const selectedToolBadge = await verifyBadge(second);
  await click(`[data-source-id="${otherProvider.id}"]`); const otherReturnBadge = await verifyBadge(otherSecond);
  await noDialog();
  await evaluate(`window.modelDock.saveSettings({theme:'dark'})`);
  await new Promise<void>(done => { window.webContents.once('did-finish-load', () => done()); window.webContents.reload(); });
  await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'renderer reload source list');
  await waitFor(`document.documentElement.dataset.theme==='dark'`, 'dark theme restored for connection layout capture');
  await click(`[data-source-id="${provider.id}"]`); const reloadBadge = await verifyBadge(second);
  await click(`[data-source-id="${otherProvider.id}"]`); const otherReloadBadge = await verifyBadge(otherSecond);
  await noDialog();
  await evaluate(`window.modelDock.deleteProvider(${JSON.stringify(otherProvider.id)})`);
  await refreshSource(); await verifyBadge(second);
  // Removing a user-selected second model must choose the remaining first item.
  await evaluate(`window.modelDock.deleteModel(${JSON.stringify(second.id)})`);
  await refreshSource(); const selectedDeletionFallbackBadge = await verifyBadge(first);
  await evaluate(`window.modelDock.saveModel(${JSON.stringify(second)})`);
  await refreshSource(); await choose(first);
  // Reload clears old result state, so produce a first-model result for layout QA below.
  const restoredFirst = await run(first); success(restoredFirst, first);

  window.setSize(1320, 880); await waitFor('innerWidth>1100', 'large inline test viewport');
  writeFileSync(join(outputDir, 'electron-connection-test-inline-1320.png'), await captureUi());
  window.setSize(980, 680); await waitFor('innerWidth<1100', 'compact inline test viewport');
  const layout = await evaluate<{ overflow: boolean; badgeInside: boolean; buttonInside: boolean; resultInside: boolean; badgeBelowButton: boolean; footerVisible: boolean; selectCoversLabel: boolean; labelCenterTargetsSelect: boolean; resolvedTheme: string }>(`(()=>{
    const card=document.querySelector(${JSON.stringify(card)}),badge=document.querySelector(${JSON.stringify(badge)}),select=document.querySelector(${JSON.stringify(selector)}),button=document.querySelector(${JSON.stringify(button)}),result=card.querySelector('[data-connection-result]'),main=document.querySelector('main'),footer=document.querySelector('.sidebar-bottom');
    const row=card.getBoundingClientRect(),chip=badge.getBoundingClientRect(),control=select.getBoundingClientRect(),action=button.getBoundingClientRect(),output=result.getBoundingClientRect(),bottom=footer.getBoundingClientRect();
    const inside=rect=>rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1;
    return {overflow:main.scrollWidth>main.clientWidth+1,badgeInside:inside(chip)&&chip.left>=row.left&&chip.right<=row.right+1,buttonInside:inside(action),resultInside:output.left>=row.left&&output.right<=row.right+1,badgeBelowButton:chip.top>=action.bottom-1,footerVisible:inside(bottom),selectCoversLabel:['left','right','top','bottom'].every(edge=>Math.abs(control[edge]-chip[edge])<=1),labelCenterTargetsSelect:document.elementFromPoint((chip.left+chip.right)/2,(chip.top+chip.bottom)/2)===select,resolvedTheme:document.documentElement.dataset.theme};
  })()`);
  assert.equal(layout.overflow, false); assert.equal(layout.badgeInside, true); assert.equal(layout.buttonInside, true); assert.equal(layout.resultInside, true); assert.equal(layout.footerVisible, true);
  assert.equal(layout.selectCoversLabel, true); assert.equal(layout.labelCenterTargetsSelect, true); assert.equal(layout.resolvedTheme, 'dark');
  writeFileSync(join(outputDir, 'electron-connection-test-inline-980.png'), await captureUi());

  const updatedFirst = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ ...first, wireApi: 'responses' })})`);
  await refreshSource(); await verifyBadge(updatedFirst);
  const responses = await run(updatedFirst); success(responses, updatedFirst); assert.deepEqual((await counts()).disabledModelIds, [first.id]);
  await evaluate(`window.modelDock.deleteModel(${JSON.stringify(first.id)})`);
  await refreshSource(); const fallbackBadge = await verifyBadge(second);
  const deletionFallback = await run(second); success(deletionFallback, second);
  const afterDeletion = await counts(); assert.equal(afterDeletion.models, 1); assert.deepEqual(afterDeletion.disabledModelIds, []);
  await evaluate(`window.modelDock.saveProvider(${JSON.stringify({ id: provider.id, name: provider.name, kind: provider.kind, presetId: provider.presetId, baseUrl: upstream, enabled: true, apiKey: 'synthetic-invalid' })})`);
  await refreshSource(); await verifyBadge(second);
  const failed = await run(second); assert.equal(failed.ok, false); assert.equal(failed.outcome, 'authentication'); assert.equal(failed.statusCode, 401); assert.equal(failed.testedModel, second.upstreamId);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${card} [data-connection-result][data-success="true"]`)})`), false, 'Rejected credentials must not retain a green success result');
  const retry = await run(second); assert.equal(retry.ok, false); assert.equal(retry.statusCode, 401); assert.equal(retry.outcome, 'authentication');
  const finalCounts = await counts(); assert.equal(finalCounts.providers, 1); assert.equal(finalCounts.models, 1);
  const noDialogFinal = await noDialog();
  writeFileSync(join(outputDir, 'electron-connection-test-inline-auth-error-980.png'), await captureUi());
  writeFileSync(join(outputDir, 'connection-test-validation.json'), JSON.stringify({ provider: { id: provider.id, name: provider.name }, first: { id: first.id, upstreamId: first.upstreamId, alias: first.alias, enabled: first.enabled }, second: { id: second.id, upstreamId: second.upstreamId, alias: second.alias }, noModel, options, firstBadge, aggregateBadge, toolBadge, inlineFirst, doubleClick, secondBadge, selectedSecond, selectionPersistence: { supplierReturnBadge, selectedAggregateBadge, selectedToolBadge, reloadBadge, otherDefaultBadge, otherReturnBadge, otherReloadBadge, otherOptions }, selectedDeletionFallbackBadge, restoredFirst, responses, fallbackBadge, deletionFallback, failed, retry, busyChecks, providerCounts: { afterFirst, afterDeletion, final: finalCounts }, layout, noDialog: noDialogFinal, expectedConnectionPostCalls: 8, expectedConnectionRequests: [
    { model: first.upstreamId, wireApi: 'chat-completions', statusCode: 200 },
    { model: first.upstreamId, wireApi: 'chat-completions', statusCode: 200 },
    { model: second.upstreamId, wireApi: 'responses', statusCode: 200 },
    { model: first.upstreamId, wireApi: 'chat-completions', statusCode: 200 },
    { model: first.upstreamId, wireApi: 'responses', statusCode: 200 },
    { model: second.upstreamId, wireApi: 'responses', statusCode: 200 },
    { model: second.upstreamId, wireApi: 'responses', statusCode: 401 },
    { model: second.upstreamId, wireApi: 'responses', statusCode: 401 },
  ] }, null, 2));
}
