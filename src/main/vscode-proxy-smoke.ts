import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';

export async function verifyVsCodeProxyToggle(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const dataDir = store.dataDir;
  assert.equal(dirname(dataDir), resolve(outputDir, 'data'));
  assert.equal(process.env.MODELDOCK_SMOKE_VSCODE_PROXY_ONLY, '1');
  const evaluate = (code: string) => window.webContents.executeJavaScript(code);
  const status = '[data-tool-application-status]';
  async function waitFor(code: string, label: string) {
    const end = Date.now() + 15000;
    do {
      if (await evaluate(code)) return;
      await new Promise(resolve => setTimeout(resolve, 65));
    } while (Date.now() < end);
    const visibleStatus = await evaluate(`document.querySelector('${status}')?.textContent`);
    throw new Error(`Timed out waiting for ${label}: ${visibleStatus}`);
  }
  async function click(selector: string) {
    const node = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(`${node} && !${node}.disabled`, selector);
    await evaluate(`${node}.click()`);
  }
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click()`);
  const vsBinding = store.listBindings().find(binding => binding.id === 'vscode')!;
  assert.notEqual(vsBinding.vscodeProxyEnabled, true);
  const provider = store.saveProvider({ name: '系统代理验证', kind: 'openai-compatible',
    baseUrl: 'https://modeldock-smoke.invalid/v1', enabled: true, apiKey: 'synthetic-proxy-toggle' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'test-model', alias: 'test-proxy-model',
    displayName: '代理开关验证', wireApi: 'responses', contextWindow: 32000, tools: true, vision: false, enabled: true });
  store.saveBinding({ ...vsBinding, enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: [model.id], defaultModelId: model.id });
  const vsSettings = join(dataDir, 'feature-appdata', 'Code', 'User', 'settings.json');
  const vsModels = join(dirname(vsSettings), 'chatLanguageModels.json');
  const userModels = '// User-managed model list\n[{"name":"Private endpoint","vendor":"customendpoint","models":[]}]\n';
  mkdirSync(dirname(vsSettings), { recursive: true });
  writeFileSync(vsSettings, '{"editor.fontSize":17}\n');
  writeFileSync(vsModels, userModels);
  await click('[aria-label="刷新本机配置"]');
  await click('[data-page="tools"][data-tool-id="vscode"]');
  const proxyToggle = '[data-action="vscode-system-proxy"]';
  await waitFor(`!!document.querySelector('${proxyToggle}')`, 'VS Code proxy switch');
  assert.equal(await evaluate(`document.querySelector('${proxyToggle}').checked`), false);
  for (const enabled of [true, false]) {
    await click(proxyToggle);
    await waitFor(`(async()=>{const saved=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='vscode');return saved.vscodeProxyEnabled===${enabled} && document.querySelector('${proxyToggle}').checked===${enabled} && document.querySelector('${status}').dataset.toolApplicationState==='synced'})()`, 'VS Code switch saved and synced');
    const settings = JSON.parse(readFileSync(vsSettings, 'utf8'));
    assert.deepEqual(settings, enabled ? { 'editor.fontSize': 17, 'http.proxy': 'http://127.0.0.1:19451' } : { 'editor.fontSize': 17 });
    assert.equal(readFileSync(vsModels, 'utf8'), userModels);
  }
  await evaluate(`document.querySelector('${proxyToggle}').scrollIntoView({block:'center'})`);
  writeFileSync(join(outputDir, 'vscode-proxy-toggle.png'), await captureUi());
  writeFileSync(join(outputDir, 'vscode-proxy-toggle.json'), JSON.stringify({ defaultOff: true, systemProxyApplied: true, proxyRemoved: true, originalModelsPreserved: true }));
}
