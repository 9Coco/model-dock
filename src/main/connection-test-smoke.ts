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
  async function refreshSource(): Promise<void> {
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'fixture source refreshed');
    await click(`[data-source-id="${provider.id}"]`);
    await waitFor(`!!document.querySelector(${JSON.stringify(button)})&&!!document.querySelector(${JSON.stringify(badge)})`, 'inline connection controls');
  }
  async function verifyBadge(model: Model): Promise<{ modelId: string; text: string }> {
    await waitFor(`document.querySelector(${JSON.stringify(badge)})?.dataset.modelId===${JSON.stringify(model.id)}`, 'first model badge updated');
    const value = await evaluate<{ modelId: string; text: string }>(`(()=>{const value=document.querySelector(${JSON.stringify(badge)});return {modelId:value.dataset.modelId,text:value.textContent}})()`);
    assert.ok(value.text.includes('测试模型') && value.text.includes(model.upstreamId));
    return value;
  }
  async function counts(): Promise<{ providers: number; models: number; disabledModelIds: string[] }> {
    const value = await snapshot();
    return { providers: value.providers.filter(item => item.id === provider.id).length, models: value.models.filter(item => item.providerId === provider.id).length, disabledModelIds: value.models.filter(item => item.providerId === provider.id && !item.enabled).map(item => item.id) };
  }
  async function noDialog(): Promise<boolean> {
    const value = await evaluate<boolean>(`!document.querySelector('.modal, .connection-test-form')`);
    assert.equal(value, true, 'One-click connection test must not open a dialog'); return value;
  }
  async function run(doubleClick = false): Promise<ConnectionResult> {
    // A complete busy cycle proves retry reads the new result rather than stale success.
    const value = await evaluate<ConnectionResult>(`new Promise((resolve,reject)=>{
      const button=document.querySelector(${JSON.stringify(button)});
      if(!button||button.disabled){reject(new Error('Inline connection control unavailable'));return;}
      let busy=false;
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Inline connection test did not complete a new request'))},8000);
      const observer=new MutationObserver(()=>{
        const current=document.querySelector(${JSON.stringify(button)});if(current?.disabled)busy=true;
        const result=document.querySelector(${JSON.stringify(`${card} [data-connection-result]`)});
        if(busy&&current&&!current.disabled&&result){clearTimeout(timer);observer.disconnect();resolve({ok:result.dataset.success==='true',message:result.textContent??'',outcome:result.dataset.outcome,statusCode:result.dataset.statusCode?Number(result.dataset.statusCode):undefined,durationMs:result.dataset.durationMs?Number(result.dataset.durationMs):undefined,testedModel:result.dataset.testedModel,wireApi:result.dataset.wireApi});}
      });
      observer.observe(document.body,{subtree:true,childList:true,attributes:true});button.click();${doubleClick ? 'button.click();' : ''}
    })`);
    await noDialog(); return value;
  }
  function success(result: ConnectionResult, wire: 'chat-completions' | 'responses'): void {
    assert.equal(result.ok, true); assert.equal(result.outcome, 'success'); assert.equal(result.statusCode, 200);
    assert.equal(result.testedModel, 'no-list-model'); assert.equal(result.wireApi, wire);
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs! >= 0, 'Successful test must report actual duration');
    assert.equal('modelIds' in result, false, 'Request test must not masquerade as model discovery');
  }
  await refreshSource();
  const noModel = await evaluate<{ disabled: boolean; text: string }>(`(()=>({disabled:document.querySelector(${JSON.stringify(button)}).disabled,text:document.querySelector(${JSON.stringify(badge)}).textContent}))()`);
  assert.ok(noModel.text.includes('尚未添加模型'));
  if (!noModel.disabled) { await click(button); await waitFor(`document.querySelector(${JSON.stringify(card)})?.textContent.includes('模型')`, 'inline model-required notice'); }
  await noDialog(); assert.equal((await counts()).models, 0, 'No-model test must not silently create a model');

  const first = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: provider.id, upstreamId: 'no-list-model', alias: 'no-list-saved', displayName: '首个模型（已停用）', wireApi: 'chat-completions', contextWindow: 0, tools: false, vision: false, enabled: false })})`);
  const second = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: provider.id, upstreamId: 'no-list-model', alias: 'no-list-second', displayName: '第二个模型', wireApi: 'responses', contextWindow: 0, tools: false, vision: false, enabled: true })})`);
  const orderedModels = (await snapshot()).models.filter(item => item.providerId === provider.id);
  assert.deepEqual(orderedModels.map(item => item.id), [first.id, second.id], 'Fixture requires explicit first/second saved order');
  await refreshSource(); const firstBadge = await verifyBadge(first);
  const inlineFirst = await run(); success(inlineFirst, 'chat-completions');
  const afterFirst = await counts(); assert.equal(afterFirst.models, 2); assert.deepEqual(afterFirst.disabledModelIds, [first.id], 'Testing a disabled first model must preserve its flag');

  await click('[data-page="providers"][data-source="aggregate"]');
  await waitFor(`!!document.querySelector(${JSON.stringify(badge)})`, 'aggregate inline widget');
  const aggregateBadge = await verifyBadge(first); await noDialog();
  await click('[data-tool-id="codex"]');
  await waitFor(`!!document.querySelector(${JSON.stringify(badge)})`, 'tool-page inline widget');
  const toolBadge = await verifyBadge(first); await noDialog();
  await click(`[data-source-id="${provider.id}"]`);
  const doubleClick = await run(true); success(doubleClick, 'chat-completions');
  assert.deepEqual((await counts()).disabledModelIds, [first.id]);

  window.setSize(1320, 880); await waitFor('innerWidth>1100', 'large inline test viewport');
  writeFileSync(join(outputDir, 'electron-connection-test-inline-1320.png'), await captureUi());
  window.setSize(980, 680); await waitFor('innerWidth<1100', 'compact inline test viewport');
  const layout = await evaluate<{ overflow: boolean; badgeInside: boolean; buttonInside: boolean; resultInside: boolean; badgeBelowButton: boolean; footerVisible: boolean }>(`(()=>{
    const card=document.querySelector(${JSON.stringify(card)}),badge=document.querySelector(${JSON.stringify(badge)}),button=document.querySelector(${JSON.stringify(button)}),result=card.querySelector('[data-connection-result]'),main=document.querySelector('main'),footer=document.querySelector('.sidebar-bottom');
    const row=card.getBoundingClientRect(),chip=badge.getBoundingClientRect(),action=button.getBoundingClientRect(),output=result.getBoundingClientRect(),bottom=footer.getBoundingClientRect();
    const inside=rect=>rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1;
    return {overflow:main.scrollWidth>main.clientWidth+1,badgeInside:inside(chip)&&chip.left>=row.left&&chip.right<=row.right+1,buttonInside:inside(action),resultInside:output.left>=row.left&&output.right<=row.right+1,badgeBelowButton:chip.top>=action.bottom-1,footerVisible:inside(bottom)};
  })()`);
  assert.equal(layout.overflow, false); assert.equal(layout.badgeInside, true); assert.equal(layout.buttonInside, true); assert.equal(layout.resultInside, true); assert.equal(layout.footerVisible, true);
  writeFileSync(join(outputDir, 'electron-connection-test-inline-980.png'), await captureUi());

  const updatedFirst = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ ...first, wireApi: 'responses' })})`);
  await refreshSource(); await verifyBadge(updatedFirst);
  const responses = await run(); success(responses, 'responses'); assert.deepEqual((await counts()).disabledModelIds, [first.id]);
  await evaluate(`window.modelDock.deleteModel(${JSON.stringify(first.id)})`);
  await refreshSource(); const fallbackBadge = await verifyBadge(second);
  const deletionFallback = await run(); success(deletionFallback, 'responses');
  const afterDeletion = await counts(); assert.equal(afterDeletion.models, 1); assert.deepEqual(afterDeletion.disabledModelIds, []);
  await evaluate(`window.modelDock.saveProvider(${JSON.stringify({ id: provider.id, name: provider.name, kind: provider.kind, presetId: provider.presetId, baseUrl: upstream, enabled: true, apiKey: 'synthetic-invalid' })})`);
  await refreshSource(); await verifyBadge(second);
  const failed = await run(); assert.equal(failed.ok, false); assert.equal(failed.outcome, 'authentication'); assert.equal(failed.statusCode, 401); assert.equal(failed.testedModel, second.upstreamId);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${card} [data-connection-result][data-success="true"]`)})`), false, 'Rejected credentials must not retain a green success result');
  const retry = await run(); assert.equal(retry.ok, false); assert.equal(retry.statusCode, 401); assert.equal(retry.outcome, 'authentication');
  const finalCounts = await counts(); assert.equal(finalCounts.providers, 1); assert.equal(finalCounts.models, 1);
  const noDialogFinal = await noDialog();
  writeFileSync(join(outputDir, 'electron-connection-test-inline-auth-error-980.png'), await captureUi());
  writeFileSync(join(outputDir, 'connection-test-validation.json'), JSON.stringify({ provider: { id: provider.id, name: provider.name }, first: { id: first.id, upstreamId: first.upstreamId, alias: first.alias, enabled: first.enabled }, second: { id: second.id, upstreamId: second.upstreamId, alias: second.alias }, noModel, firstBadge, aggregateBadge, toolBadge, inlineFirst, doubleClick, responses, fallbackBadge, deletionFallback, failed, retry, providerCounts: { afterFirst, afterDeletion, final: finalCounts }, layout, noDialog: noDialogFinal, expectedConnectionPostCalls: 6 }, null, 2));
}
