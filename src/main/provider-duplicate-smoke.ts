import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Run only against the synthetic fixture supplied by smoke-electron.mjs. */
export async function verifyProviderDuplicates(window: BrowserWindow, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Provider duplicate smoke timed out: ${label}`);
  }
  const before = await evaluate<{ providerIds: string[]; models: { id: string; alias: string; providerId: string }[] }>(`(async()=>{
    const api=window.modelDock;
    await api.stopGateway();
    document.querySelector('[aria-label="关闭对话框"]')?.click();
    const snapshot=await api.snapshot();
    return {providerIds:snapshot.providers.filter(p=>p.name==='DeepSeek').map(p=>p.id),models:snapshot.models.filter(m=>m.id==='duplicate-model-a'||m.id==='duplicate-model-b').map(m=>({id:m.id,alias:m.alias,providerId:m.providerId}))};
  })()`);
  if (before.providerIds.length !== 3 || before.models.length !== 2) throw new Error('Synthetic provider duplicate fixture unavailable');
  await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click());document.querySelector('[data-source="aggregate"]').click();document.querySelector('[aria-label="刷新本机配置"]').click()`);
  await waitFor(`!!document.querySelector('[data-action="review-provider-duplicates"]')`, 'review action');
  await evaluate(`document.querySelector('[data-action="review-provider-duplicates"]').click()`);
  await waitFor(`!!document.querySelector('.provider-duplicate-group [data-action="merge-provider-duplicates"]')`, 'duplicate group');
  const readReviewLayout = () => evaluate<{ groups: number; mergeEnabled: boolean; inViewport: boolean; footerVisible: boolean; mergeVisible: boolean; bodyOverflow: boolean; bodyScrollable: boolean; bodyScrolled: boolean }>(`(()=>{
    const dialog=document.querySelector('[role="dialog"]'),rect=dialog.getBoundingClientRect(),body=dialog.querySelector('.modal-body'),bodyRect=body.getBoundingClientRect(),footer=dialog.querySelector('.modal-footer').getBoundingClientRect();
    const button=document.querySelector('.provider-duplicate-group [data-action="merge-provider-duplicates"]');
    const buttonRect=button.getBoundingClientRect();
    return {groups:document.querySelectorAll('.provider-duplicate-group').length,mergeEnabled:!button.disabled,inViewport:rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1,footerVisible:footer.top>=0&&footer.bottom<=innerHeight+1,mergeVisible:buttonRect.top>=bodyRect.top-1&&buttonRect.bottom<=footer.top+1,bodyOverflow:body.scrollWidth>body.clientWidth,bodyScrollable:body.scrollHeight>body.clientHeight,bodyScrolled:body.scrollTop>0};
  })()`);
  window.setSize(1320, 880);
  await waitFor(`innerWidth>1100`, 'large review viewport');
  const reviewLarge = await readReviewLayout();
  if (!reviewLarge.mergeEnabled || !reviewLarge.inViewport || !reviewLarge.footerVisible || reviewLarge.bodyOverflow) throw new Error('Large provider duplicate review unavailable or outside viewport');
  writeFileSync(join(outputDir, 'electron-provider-duplicates-1320.png'), await captureUi());
  window.setSize(980, 680);
  await waitFor(`innerWidth<1100`, 'compact review viewport');
  await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]'),body=dialog.querySelector('.modal-body'),button=dialog.querySelector('[data-action="merge-provider-duplicates"]'),footer=dialog.querySelector('.modal-footer');if(button.getBoundingClientRect().bottom>footer.getBoundingClientRect().top||button.getBoundingClientRect().top<body.getBoundingClientRect().top)body.scrollTop=body.scrollHeight;})()`);
  const review = await readReviewLayout();
  if (!review.mergeEnabled || !review.inViewport || !review.footerVisible || !review.mergeVisible || review.bodyOverflow) throw new Error('Compact provider duplicate merge action unavailable or outside viewport');
  writeFileSync(join(outputDir, 'electron-provider-duplicates-980.png'), await captureUi());
  await evaluate(`document.querySelector('.provider-duplicate-group [data-action="merge-provider-duplicates"]').click()`);
  await waitFor(`(async()=>{const snapshot=await window.modelDock.snapshot();return snapshot.providers.filter(p=>p.name==='DeepSeek').length===1})()`, 'merge persisted');
  const merged = await evaluate<{ keptProviderId: string; providerCount: number; models: { id: string; alias: string; providerId: string }[]; groupsRemaining: number }>(`(async()=>{
    const api=window.modelDock,snapshot=await api.snapshot(),providers=snapshot.providers.filter(p=>p.name==='DeepSeek');
    return {keptProviderId:providers[0].id,providerCount:providers.length,models:snapshot.models.filter(m=>m.id==='duplicate-model-a'||m.id==='duplicate-model-b').map(m=>({id:m.id,alias:m.alias,providerId:m.providerId})),groupsRemaining:(await api.listProviderDuplicates()).filter(group=>group.name==='DeepSeek').length};
  })()`);
  if (merged.models.length !== 2 || merged.groupsRemaining !== 0 || merged.models.some(model => model.providerId !== merged.keptProviderId || !before.models.some(previous => previous.id === model.id && previous.alias === model.alias))) throw new Error('Provider merge lost model identifiers or aliases');
  await waitFor(`!document.querySelector('.provider-duplicate-group [data-action="merge-provider-duplicates"]')`, 'review refreshed');
  await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  writeFileSync(join(outputDir, 'electron-provider-duplicates-after-980.png'), await captureUi());
  const idempotency = await evaluate<{ sequentialIds: string[]; parallelIds: string[]; differentKeyRejected: boolean; keyPreserved: boolean; providerCount: number }>(`(async()=>{
    const api=window.modelDock,input={name:'DeepSeek',kind:'openai-compatible',presetId:'deepseek',baseUrl:'https://api.deepseek.com/',enabled:true,apiKey:'synthetic-only'};
    const sequential=[];for(let index=0;index<3;index++)sequential.push((await api.saveProvider(input)).id);
    const parallel=await Promise.all(Array.from({length:3},()=>api.saveProvider(input)));
    let differentKeyRejected=false;try{await api.saveProvider({...input,apiKey:'synthetic-different'});}catch{differentKeyRejected=true;}
    let keyPreserved=false;try{keyPreserved=(await api.saveProvider(input)).id===sequential[0];}catch{}
    const snapshot=await api.snapshot();
    return {sequentialIds:sequential,parallelIds:parallel.map(p=>p.id),differentKeyRejected,keyPreserved,providerCount:snapshot.providers.filter(p=>p.name==='DeepSeek').length};
  })()`);
  if (idempotency.providerCount !== 1 || !idempotency.differentKeyRejected || !idempotency.keyPreserved || [...idempotency.sequentialIds, ...idempotency.parallelIds].some(id => id !== merged.keptProviderId)) throw new Error('Provider save idempotency or credential conflict guard failed');

  // Exercise the actual React submit flow through the local mock only. The
  // official-looking DeepSeek fixture is never used for network requests.
  const upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  if (!upstream || new URL(upstream).hostname !== '127.0.0.1') throw new Error('Provider duplicate UI smoke requires a loopback upstream');
  const local = await evaluate<{ id: string; name: string; totalProviders: number }>(`(async()=>{
    const api=window.modelDock,snapshot=await api.snapshot(),provider=snapshot.providers.find(p=>p.name==='本地验证来源'&&p.baseUrl===${JSON.stringify(upstream)});
    if(!provider)throw new Error('Local synthetic provider missing');
    await api.saveProvider({...provider,apiKey:'synthetic-only'});
    document.querySelector('[aria-label="关闭对话框"]')?.click();
    document.querySelector('[data-source="aggregate"]').click();
    return {id:provider.id,name:provider.name,totalProviders:snapshot.providers.length};
  })()`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'review closed');
  await evaluate(`document.querySelector('[data-action="add-api-provider"]').click()`);
  await waitFor(`!!document.querySelector('[role="dialog"] form input[type="password"]')`, 'provider form');
  await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] .preset-picker button')).find(button=>button.textContent.includes('自定义 API')).click()`);
  await evaluate(`(()=>{
    const dialog=document.querySelector('[role="dialog"]');
    const set=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
    const label=Array.from(dialog.querySelectorAll('label')).find(label=>label.textContent.startsWith('供应商名称'));
    set(label.querySelector('input'),${JSON.stringify(local.name)});
    set(dialog.querySelector('input[type="url"]'),${JSON.stringify(upstream)});
    set(dialog.querySelector('input[type="password"]'),'synthetic-only');
  })()`);
  await waitFor(`document.querySelector('[role="dialog"] input[type="url"]').value===${JSON.stringify(upstream)}`, 'form input settled');
  await evaluate(`(()=>{const form=document.querySelector('[role="dialog"] form');form.requestSubmit();form.requestSubmit();})()`);
  await waitFor(`document.querySelector('[role="dialog"] h2')?.textContent.includes('获取模型列表')&&document.querySelectorAll('.discovery-model').length===3`, 'discovery after double submit');
  const doubleSubmit = await evaluate<{ totalProviders: number; localProviderCount: number; localId: string; deepseekCount: number; discoveryOpen: boolean; discoveredModels: number; hasError: boolean }>(`(async()=>{
    const snapshot=await window.modelDock.snapshot(),providers=snapshot.providers.filter(p=>p.name===${JSON.stringify(local.name)}&&p.baseUrl===${JSON.stringify(upstream)}),dialog=document.querySelector('[role="dialog"]');
    return {totalProviders:snapshot.providers.length,localProviderCount:providers.length,localId:providers[0]?.id,deepseekCount:snapshot.providers.filter(p=>p.name==='DeepSeek').length,discoveryOpen:dialog?.querySelector('h2')?.textContent.includes('获取模型列表'),discoveredModels:dialog?.querySelectorAll('.discovery-model').length,hasError:!!dialog?.querySelector('[role="alert"]')};
  })()`);
  if (doubleSubmit.totalProviders !== local.totalProviders || doubleSubmit.localProviderCount !== 1 || doubleSubmit.localId !== local.id || doubleSubmit.deepseekCount !== 1 || !doubleSubmit.discoveryOpen || doubleSubmit.discoveredModels !== 3 || doubleSubmit.hasError) throw new Error('Double-submit created a duplicate provider or broke discovery');
  writeFileSync(join(outputDir, 'provider-duplicate-validation.json'), JSON.stringify({ before, reviewLarge, review, merged, idempotency, doubleSubmit }, null, 2));
}
