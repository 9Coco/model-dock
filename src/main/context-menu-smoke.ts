import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, type BrowserWindow } from 'electron';
import type { Store } from './store';

/** Real renderer menus and clipboard, restricted to a fresh synthetic profile. */
export async function verifyContextMenus(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const beforeBindings = store.listBindings();
  const beforePlugin = store.getJetBrainsPlugin('webstorm');
  const originalSize = window.getSize(), originalMinimum = window.getMinimumSize();
  const provider = store.saveProvider({name:'右键验证 API',kind:'openai-compatible',presetId:'custom',baseUrl:'https://context-fixture.invalid/v1',enabled:true,apiKey:'synthetic-context-menu-key'});
  const subscription = store.saveProvider({name:'右键验证订阅',kind:'codex',presetId:'codex-subscription',baseUrl:'https://chatgpt.com/backend-api/codex',enabled:true});
  store.setSecret(subscription.id,{accessToken:'synthetic-context-access',refreshToken:'synthetic-context-refresh'});
  const model = store.saveModel({providerId:provider.id,upstreamId:'context-native-model',alias:'context-local-model',displayName:'右键验证模型',wireApi:'responses',contextWindow:64000,tools:true,vision:false,enabled:true});
  const log = {id:'context-menu-log-fixture',time:'2026-11-04T12:00:00.000Z',alias:model.alias,providerName:provider.name,endpoint:'/v1/responses',status:200,durationMs:42};
  store.addLog(log);
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done=>setTimeout(done,ms));
  const action = (id: string) => `[role="menu"] [data-context-menu-action="${id}"]`;
  const layouts: unknown[] = [];
  async function waitFor(source: string, label: string) {
    const deadline = Date.now()+10000;
    while (Date.now()<deadline) { if(await evaluate<boolean>(source)) return; await pause(25); }
    await evaluate(`document.querySelectorAll('[data-secret-field] input').forEach(input=>{input.type='password';input.value='************'})`);
    writeFileSync(join(outputDir,'context-menu-timeout.png'),await captureUi());
    writeFileSync(join(outputDir,'context-menu-timeout.json'),JSON.stringify({label,menu:await evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [data-context-menu-action]')].map(item=>item.dataset.contextMenuAction)`)}));
    throw new Error(`Context menu verification timed out: ${label}`);
  }
  async function click(selector: string) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`,selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function dismiss() {
    await evaluate(`document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await waitFor(`!document.querySelector('[role="menu"]')`,'menu dismissed');
  }
  async function context(selector: string, edge = false) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`,selector);
    // Real users right-click visible objects. Settle fixture scrolling before
    // opening: scrolling the surrounding page intentionally dismisses menus.
    await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'nearest'});target.focus?.({preventScroll:true});})()`);
    await pause(60);
    const prevented = await evaluate<boolean>(`(()=>{getSelection()?.removeAllRanges();const target=document.querySelector(${JSON.stringify(selector)}),rect=target.getBoundingClientRect();return !target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:${edge?'innerWidth-2':'Math.max(10,Math.min(innerWidth-10,rect.left+Math.min(rect.width/2,120)))'},clientY:${edge?'innerHeight-2':'Math.max(10,Math.min(innerHeight-10,rect.top+Math.min(rect.height/2,20)))'}}));})()`);
    assert.equal(prevented,true,'Semantic context menus consume only their own right click');
    await waitFor(`!!document.querySelector('[role="menu"]')`,`menu opened for ${selector}`);
    return await evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [data-context-menu-action]')].map(item=>item.dataset.contextMenuAction)`);
  }
  async function copyExact(selector: string, id: string, expected: string) {
    await clipboard.clear(); await context(selector); await click(action(id));
    await waitFor(`!document.querySelector('[role="menu"]')`,'copy closes menu');
    for(let i=0;i<100 && await clipboard.readText()!==expected;i++) await pause(20);
    const copied = await clipboard.readText();
    assert.equal(copied,expected,'Clipboard holds exactly the chosen value'); await clipboard.clear();
    return copied;
  }
  async function selectProvider(id: string) {
    await click(`.sidebar [data-source-id="${id}"]`);
    await waitFor(`!!document.querySelector('.provider-list article[data-provider-id="${id}"]')&&!!document.querySelector('.provider-models')`,'provider detail');
  }
  try {
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('.sidebar [data-source-id="${provider.id}"]')`,'synthetic sources loaded');
    const sidebar = `.sidebar [data-source-id="${provider.id}"]`;
    const openingBefore = {providers:store.listProviders(),models:store.listModels(),bindings:store.listBindings()};
    const providerIds = await context(sidebar);
    assert.ok(providerIds.includes('provider-edit')&&providerIds.includes('provider-delete'));
    await pause(5300);
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="menu"] [data-context-menu-action="provider-edit"]')`),true,'Background snapshot polling does not dismiss an unchanged menu');
    assert.deepEqual({providers:store.listProviders(),models:store.listModels(),bindings:store.listBindings()},openingBefore,'Opening a menu performs no configuration mutation');
    await dismiss();
    await copyExact(sidebar,'provider-copy-url',provider.baseUrl);
    await copyExact(sidebar,'provider-copy-key','synthetic-context-menu-key');
    const subscriptionIds = await context(`.sidebar [data-source-id="${subscription.id}"]`);
    assert.equal(subscriptionIds.includes('provider-copy-key'),false,'Subscription tokens never become copy actions'); await dismiss();
    await context(sidebar); await click(action('provider-edit'));
    await waitFor(`document.querySelector('[role="dialog"] h2')?.textContent==='编辑供应商'`,'provider editor');
    const inputSelector = '[role="dialog"] input[autocomplete="new-password"]';
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(inputSelector)}).value`),'','Editing does not populate saved API keys');
    await evaluate(`document.querySelector(${JSON.stringify(inputSelector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))`);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[role="menu"]').length`),0,'Input editing remains native');
    await click('[aria-label="关闭对话框"]');
    await context(sidebar); await click(action('provider-delete'));
    await waitFor(`!!document.querySelector('[data-action="confirm-delete"]')`,'provider delete confirmation');
    assert.ok(store.getProvider(provider.id),'Opening delete confirmation never deletes immediately');
    await click('[data-action="cancel-tool-restore"]');
    await selectProvider(provider.id);
    await copyExact(`.provider-list article[data-provider-id="${provider.id}"]`,'provider-copy-url',provider.baseUrl);
    const row = `tr[data-model-id="${model.id}"]`;
    await copyExact(row,'model-copy-id',model.upstreamId); await copyExact(row,'model-copy-alias',model.alias);
    await context(row); await click(action('model-edit'));
    await waitFor(`!!document.querySelector('[role="dialog"] [data-field="upstream-id"]')`,'model editor'); await click('[aria-label="关闭对话框"]');
    await context(row); await click(action('model-delete'));
    await waitFor(`!!document.querySelector('[data-action="confirm-delete"]')`,'model delete confirmation');
    assert.ok(store.listModels().some(item=>item.id===model.id)); await click('[data-action="cancel-tool-restore"]');
    // Browser text selections must keep the standard native copy menu.
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(row)}).querySelector('.model-name strong'),range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));})()`);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[role="menu"]').length`),0,'Selected text is not replaced by object actions');
    await evaluate(`getSelection()?.removeAllRanges()`);
    // Keyboard opening and navigation use the same semantic row.
    await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(row)});target.focus();target.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));})()`);
    await waitFor(`!!document.querySelector('[role="menu"]')`,'Shift F10 opens menu');
    await evaluate(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))`);
    const lastEnabled = await evaluate<boolean>(`(()=>{const items=[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].filter(item=>!item.disabled&&item.getAttribute('aria-disabled')!=='true');return document.activeElement===items.at(-1)})()`);
    assert.equal(lastEnabled,true,'End reaches the last enabled menu action'); await dismiss();
    assert.equal(await evaluate<boolean>(`document.activeElement===document.querySelector(${JSON.stringify(row)})`),true,'Escape restores focus to the model that opened the menu');
    for(const theme of ['light','dark']) {
      window.setMinimumSize(780,580); window.setSize(980,680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`); await pause(80);
      await context(row,true); await pause(50);
      const layout = await evaluate<{fits:boolean;horizontalOverflow:boolean}>(`(()=>{const rect=document.querySelector('[role="menu"]').getBoundingClientRect();return {fits:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
      assert.equal(layout.fits,true,'Menus clamp to viewport edges'); assert.equal(layout.horizontalOverflow,false);
      layouts.push({theme,width:980,height:680,...layout}); writeFileSync(join(outputDir,`context-menu-${theme}-980.png`),await captureUi());
      await evaluate(`document.body.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}))`);
      await waitFor(`!document.querySelector('[role="menu"]')`,'outside click closes menu');
    }
    await click('.sidebar [data-page="service"]');
    await waitFor(`!!document.querySelector('[data-log-id="${log.id}"]')`,'synthetic request log');
    await copyExact(`[data-log-id="${log.id}"]`,'log-copy',[log.time,log.alias,log.providerName,log.endpoint,log.status,`${log.durationMs} ms`].join('\t'));
    await copyExact('.gateway-panel','gateway-copy-key',store.gatewayKey());
    const pageIds = await context('.main-content'); assert.ok(pageIds.includes('page-refresh')&&pageIds.includes('page-add-api')); await dismiss();
    // Diagnostics copy only the renderer's already-sanitized entry; no raw
    // network body, selected text or account credentials are introduced here.
    await waitFor(`!!document.querySelector('[data-diagnostic-id]')&&!document.querySelector('[data-action="diagnostics-refresh"]').disabled`,'diagnostic records loaded');
    const diagnosticId = await evaluate<string>(`document.querySelector('[data-diagnostic-id]').dataset.diagnosticId`);
    const diagnostic = await evaluate<{entryId:string;event:string;context:Record<string,unknown>}>(`(async()=>{const snapshot=await window.modelDock.queryDiagnostics({limit:200});return snapshot.entries.find(entry=>entry.entryId===${JSON.stringify(diagnosticId)});})()`);
    assert.ok(diagnostic?.event,'Displayed diagnostic came from the safe diagnostics API');
    const diagnosticRow = `[data-diagnostic-id="${diagnosticId}"]`;
    await copyExact(diagnosticRow,'diagnostic-copy-event',diagnostic.event);
    const copiedDiagnostic = await copyExact(diagnosticRow,'diagnostic-copy',JSON.stringify(diagnostic,null,2));
    assert.deepEqual(JSON.parse(copiedDiagnostic),diagnostic);
    for(const forbidden of ['synthetic-context-menu-key','synthetic-context-access','synthetic-context-refresh']) assert.equal(copiedDiagnostic.includes(forbidden),false,'Diagnostic context never copies credentials');
    await context(diagnosticRow); await pause(250); writeFileSync(join(outputDir,'context-menu-diagnostics-dark-980.png'),await captureUi());
    await click(action('diagnostic-details'));
    await waitFor(`document.querySelector('[role="dialog"] h2')?.textContent==='诊断日志详情'`,'diagnostic details');
    await click('[aria-label="关闭对话框"]');
    await context(diagnosticRow);
    assert.equal(await evaluate<boolean>(`(()=>{const main=document.querySelector('.main-content'),before=main.scrollTop;main.scrollTop=before>0?before-1:before+1;return main.scrollTop!==before;})()`),true,'Fixture produces an actual page scroll');
    // Hidden Electron windows may defer scroll dispatch until their next frame.
    await captureUi();
    await waitFor(`!document.querySelector('[role="menu"]')`,'actual page scrolling closes menu');
    await click('.sidebar [data-page="auth"]');
    const accountRow = `[data-auth-account="${subscription.id}"]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(accountRow)})`,'synthetic subscription account');
    const accountSecretBefore = store.getSecret(subscription.id);
    const accountIds = await context(accountRow);
    assert.ok(accountIds.includes('account-details')&&accountIds.includes('account-refresh-quota')&&accountIds.includes('account-reauth'));
    assert.equal(accountIds.some(id=>id.includes('copy')),false,'Account menus never expose token copy');
    writeFileSync(join(outputDir,'context-menu-account-dark-980.png'),await captureUi());
    await click(action('account-details'));
    await waitFor(`!!document.querySelector('[data-auth-account-details="${subscription.id}"]')`,'account details');
    assert.equal(await evaluate<boolean>(`document.querySelector('[role="dialog"]').textContent.includes('synthetic-context-access')||document.querySelector('[role="dialog"]').textContent.includes('synthetic-context-refresh')`),false);
    await click('[aria-label="关闭对话框"]');
    for(const id of ['account-logout','account-delete']) {
      await context(accountRow); await click(action(id));
      await waitFor(`!!document.querySelector('[role="dialog"] .modal-footer .danger')`,`account ${id} confirmation`);
      assert.deepEqual(store.getSecret(subscription.id),accountSecretBefore,'Opening account confirmation preserves authorization');
      assert.ok(store.getProvider(subscription.id),'Opening account confirmation preserves the source');
      await click('[role="dialog"] .modal-footer .secondary');
    }
    assert.deepEqual(store.getSecret(subscription.id),accountSecretBefore,'Cancelling account actions preserves authorization');
    await click('[data-tool-category="agent"]');
    for (const tool of ['junie', 'copilot-cli']) {
      const toolIds = await context(`.sidebar [data-tool-id="${tool}"]`);
      assert.ok(toolIds.includes('tool-open')&&toolIds.includes('tool-preview')); await click(action('tool-open'));
      await waitFor(`!!document.querySelector('[data-tool-binding="${tool}"]')`,`tool menu opens the clicked ${tool} tool`);
    }
    store.setJetBrainsPlugin('webstorm','air'); await click('[aria-label="刷新本机配置"]'); await click('[data-tool-category="jetbrains"]');
    const airIds = await context('.sidebar [data-tool-id="webstorm"]');
    for(const forbidden of ['tool-apply','tool-restore','tool-undo']) assert.equal(airIds.includes(forbidden),false,`Air cannot ${forbidden}`); await dismiss();
    assert.deepEqual(store.listBindings(),beforeBindings.map(binding=>binding.id==='webstorm'?{...binding,jetBrainsPlugin:'air'}:binding),'Menus do not synchronize external tools');
    writeFileSync(join(outputDir,'context-menu-validation.json'),JSON.stringify({ok:true,providerSidebarAndCards:true,openingHasNoMutation:true,backgroundPollingPreservesMenu:true,exactNativeClipboard:true,subscriptionTokensNotCopyable:true,editAndDeleteConfirmation:true,modelActions:true,logAndGatewayActions:true,pageActions:true,diagnosticDetailsAndSafeClipboard:true,accountDetailsAndCancelledManagement:true,accountTokensNotExposed:true,keyboardNavigation:true,nativeInputAndTextSelectionPreserved:true,viewportClamping:true,outsideDismissal:true,actualScrollingDismissal:true,toolNavigation:true,airWriteActionsAbsent:true,externalConfigurationWrites:false,layouts},null,2));
  } finally {
    await clipboard.clear(); store.setJetBrainsPlugin('webstorm',beforePlugin);
    await evaluate(`getSelection()?.removeAllRanges();document.querySelectorAll('[data-secret-field] input').forEach(input=>{input.type='password';input.value='************'})`);
    window.setMinimumSize(originalMinimum[0],originalMinimum[1]); window.setSize(originalSize[0],originalSize[1]);
  }
}
