import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface SavedFixtureModel { id: string; providerId: string; upstreamId: string; alias: string; displayName: string }

/** Exercise same-name models through React forms using isolated smoke data only. */
export async function verifyModelNames(window: BrowserWindow, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  if (!upstream || new URL(upstream).hostname !== '127.0.0.1') throw new Error('Model names smoke requires a loopback upstream');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Model names smoke timed out: ${label}`);
  }
  async function setInput(field: string, value: string): Promise<void> {
    await evaluate(`(()=>{
      const input=document.querySelector('[role="dialog"] [data-field="${field}"]');
      if(!input)throw new Error('Model form field missing: ${field}');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await waitFor(`document.querySelector('[role="dialog"] [data-field="${field}"]')?.value===${JSON.stringify(value)}`, `${field} settled`);
  }
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'discovery closed');
  const providers = await evaluate<{ id: string; name: string }[]>(`(async()=>{
    const api=window.modelDock,providers=[];
    for(const name of ['测试套餐 A','测试套餐 B']){
      const provider=await api.saveProvider({name,kind:'openai-compatible',presetId:'custom',baseUrl:${JSON.stringify(upstream)},enabled:true,apiKey:'synthetic-only'});
      providers.push({id:provider.id,name:provider.name});
    }
    document.querySelector('[aria-label="刷新本机配置"]').click();
    return providers;
  })()`);
  if (providers.length !== 2 || providers[0].id === providers[1].id) throw new Error('Model names synthetic providers unavailable');
  await waitFor(`!!document.querySelector('[data-source-id="${providers[1].id}"]')`, 'sources refreshed');

  const saved: SavedFixtureModel[] = [];
  for (const provider of providers) {
    await evaluate(`document.querySelector('[data-source-id="${provider.id}"]').click()`);
    await waitFor(`document.querySelector('.breadcrumbs')?.textContent.includes(${JSON.stringify(provider.name)})&&!!document.querySelector('[data-action="manual-add-model"]')`, 'supplier detail');
    await evaluate(`document.querySelector('[data-action="manual-add-model"]').click()`);
    await waitFor(`!!document.querySelector('[role="dialog"] [data-field="model-local-alias"]')`, 'manual model form');
    await setInput('upstream-id', 'mock-shared');
    await setInput('model-local-alias', 'mock-shared');
    await setInput('model-display-name', '同名模型');
    await setInput('context-window', '0');
    await evaluate(`(()=>{
      const select=document.querySelector('[role="dialog"] [data-field="wire-api"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'chat-completions');
      select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(`document.querySelector('[role="dialog"] [data-field="wire-api"]')?.value==='chat-completions'`, 'wire API settled');
    if (provider.id === providers[1].id) {
      await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
      writeFileSync(join(outputDir, 'electron-model-same-name-form-980.png'), await captureUi());
    }
    await evaluate(`document.querySelector('[role="dialog"] form').requestSubmit()`);
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'same-name model saved');
    const model = await evaluate<SavedFixtureModel | undefined>(`(async()=>{
      const snapshot=await window.modelDock.snapshot(),model=snapshot.models.find(m=>m.providerId==='${provider.id}'&&m.upstreamId==='mock-shared');
      return model?{id:model.id,providerId:model.providerId,upstreamId:model.upstreamId,alias:model.alias,displayName:model.displayName}:undefined;
    })()`);
    if (!model || model.displayName !== '同名模型') throw new Error('UI failed to save same model name across suppliers');
    saved.push(model);
  }
  if (saved[0].alias !== 'mock-shared' || saved[1].alias === saved[0].alias || !saved[1].alias.startsWith(`${providers[1].id}/`)) throw new Error('Same-name models did not receive distinct stable routes');

  await waitFor(`!!document.querySelector('[data-model-id="${saved[1].id}"] [data-action="edit-model"]')`, 'model edit button');
  await evaluate(`document.querySelector('[data-model-id="${saved[1].id}"] [data-action="edit-model"]').click()`);
  await waitFor(`document.querySelector('[role="dialog"] [data-field="model-local-alias"]')?.value==='mock-shared'`, 'short name shown while editing');
  const edit = await evaluate<{ localAlias: string; displayName: string; noNamespace: boolean }>(`(()=>{
    const dialog=document.querySelector('[role="dialog"]'),alias=dialog.querySelector('[data-field="model-local-alias"]').value;
    return {localAlias:alias,displayName:dialog.querySelector('[data-field="model-display-name"]').value,noNamespace:!alias.includes('${providers[1].id}/')};
  })()`);
  if (!edit.noNamespace || edit.displayName !== '同名模型') throw new Error('Edit model form exposed internal routing namespace');
  await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  writeFileSync(join(outputDir, 'electron-model-same-name-edit-980.png'), await captureUi());
  await evaluate(`document.querySelector('[role="dialog"] form').requestSubmit()`);
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'edit saved');
  const editedAlias = await evaluate<string>(`(async()=>{const snapshot=await window.modelDock.snapshot();return snapshot.models.find(m=>m.id==='${saved[1].id}')?.alias})()`);
  if (editedAlias !== saved[1].alias) throw new Error('Editing a local same-name model changed its stable route ID');

  const providerModels: { providerId: string; labels: string[]; routes: string[]; modelIds: string[] }[] = [];
  const layouts: { providerId: string; width: number; inViewport: boolean; rowCount: number; tableScrollable: boolean }[] = [];
  for (const [index, provider] of providers.entries()) {
    const model = saved[index];
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click());document.querySelector('[data-source-id="${provider.id}"]').click()`);
    await waitFor(`document.querySelector('.breadcrumbs')?.textContent.includes(${JSON.stringify(provider.name)})&&!!document.querySelector('.provider-models [data-model-id="${model.id}"]')`, 'same-name supplier model table');
    const table = await evaluate<{ labels: string[]; routes: string[]; modelIds: string[] }>(`(()=>{
      const rows=Array.from(document.querySelectorAll('.provider-models .models-table tbody tr'));
      return {labels:rows.map(row=>row.querySelector('.model-name strong').textContent),routes:rows.map(row=>row.querySelector('.model-name code').textContent),modelIds:rows.map(row=>row.dataset.modelId)};
    })()`);
    if (table.modelIds.length !== 1 || table.modelIds[0] !== model.id || table.labels[0] !== `${provider.name} - 同名模型` || table.routes[0] !== model.alias) throw new Error('Supplier model table lost same-name source identity or stable route');
    providerModels.push({ providerId: provider.id, ...table });
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height);
      await waitFor(width > 1100 ? `innerWidth>1100` : `innerWidth<1100`, 'supplier model viewport');
      const layout = await evaluate<{ inViewport: boolean; rowCount: number; tableScrollable: boolean }>(`(()=>{
        const panel=document.querySelector('.provider-models'),rect=panel.getBoundingClientRect(),scroll=panel.querySelector('.table-scroll');
        return {inViewport:rect.left>=0&&rect.right<=innerWidth+1,rowCount:panel.querySelectorAll('tbody tr').length,tableScrollable:scroll.scrollWidth>scroll.clientWidth};
      })()`);
      if (!layout.inViewport || layout.rowCount !== 1) throw new Error('Supplier model table overflows or lost its same-name model');
      layouts.push({ providerId: provider.id, width, ...layout });
      writeFileSync(join(outputDir, `electron-provider-same-name-${index + 1}-${width}.png`), await captureUi());
    }
  }
  if (new Set(providerModels.flatMap(table => table.routes)).size !== 2 || providerModels.flatMap(table => table.labels).length !== 2) throw new Error('Same-name supplier model tables did not retain distinct routes');
  writeFileSync(join(outputDir, 'model-names-validation.json'), JSON.stringify({ providers, saved, edit, editedAlias, providerModels, layouts }, null, 2));
}
