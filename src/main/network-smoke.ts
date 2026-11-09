// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type { Store } from './store';
export async function verifyNetworkUi(window: BrowserWindow, store: Store, output: string, capture: () => Promise<Buffer>) {
  const before = JSON.stringify({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings() });
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script);
  const wait = async (expression: string) => {
    for (let i = 0; i < 100; i++) { if (await evaluate<boolean>(expression)) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error(`Network UI condition failed: ${expression}`);
  };
  await evaluate(`document.querySelector('[data-page="network"]').click()`);
  await wait(`!!document.querySelector('[data-network-panel]')`);
  assert.equal(await evaluate(`document.querySelector('[data-action="connect-network"]').disabled`), true);
  await evaluate(`window.modelDock.saveNetworkSettings({address:'192.0.2.30:38473'})`);
  await wait(`document.querySelector('#network-address').value==='http://192.0.2.30:38473'`);
  await evaluate(`document.querySelector('[aria-label="网络连接模式"] button:nth-child(2)').click()`);
  await wait(`document.querySelector('#network-address').value==='socks5://192.0.2.30:38473'`);
  assert.equal(await evaluate(`document.querySelector('[data-action="connect-network"]').disabled`), false);
  const layout = await evaluate<{overflow: boolean; labels: string[]}>(`({overflow:document.documentElement.scrollWidth>innerWidth,labels:[...document.querySelectorAll('.network-panel h2')].map(e=>e.textContent)})`);
  assert.equal(layout.overflow, false); assert.equal(layout.labels.length, 4);
  writeFileSync(join(output, 'network-light.png'), await capture());
  await evaluate(`document.querySelector('[data-page="settings"]').click()`);
  await wait(`!!document.querySelector('[aria-label="随 ModelDock 自动连接网络"]')`);
  await evaluate(`document.querySelector('[data-theme-choice="dark"]').click()`);
  await wait(`document.querySelector('[data-theme-choice="dark"]').getAttribute('aria-pressed')==='true'`);
  await evaluate(`document.querySelector('[data-page="network"]').click()`);
  await wait(`!!document.querySelector('[data-network-panel]')`);
  writeFileSync(join(output, 'network-dark.png'), await capture());
  await evaluate(`window.modelDock.showNetworkMini()`);
  const mini = BrowserWindow.getAllWindows().find(w => w !== window)!;
  assert.ok(mini);
  assert.equal(await mini.webContents.executeJavaScript(`typeof window.modelDock`), 'undefined');
  assert.equal(await mini.webContents.executeJavaScript(`typeof window.networkMonitor.snapshot`), 'function');
  writeFileSync(join(output, 'network-mini.png'), (await mini.webContents.capturePage()).toPNG());
  await mini.webContents.executeJavaScript(`window.networkMonitor.action('hide')`);
  assert.equal(JSON.stringify({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings() }), before);
  assert.equal(store.getManagedState('network.flowbridge.lease', false), false);
  writeFileSync(join(output, 'network-validation.json'), JSON.stringify({ ok:true, modeSwitchSaved:true, osNetworkUntouched:true, existingDataPreserved:true, miniPreloadIsolated:true, layout, screenshots:['network-light.png','network-dark.png','network-mini.png'] }, null, 2));
  if (process.env.MODELDOCK_SMOKE_NETWORK_HOLD === '1') { window.show(); await new Promise(r => setTimeout(r, 60_000)); }
}
