import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AuthAccount, RelayAccountKind } from '../shared/auth-types';
import type { Store } from './store';

/** Exercises only QA adapters and an isolated database, never real client credentials or relay processes. */
export async function verifyRelayClientImport(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const manualKey = 'synthetic-relay-import-manual-key';
  const manual = store.saveProvider({ name: '既有手动 TRAE · 导入时保留', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: 'http://127.0.0.1:19090/v1', enabled: false, apiKey: manualKey, note: 'manual relay preservation fixture' });
  const manualModel = store.saveModel({ providerId: manual.id, upstreamId: 'manual-import-preserved', alias: 'manual-import-preserved', displayName: '手动反代保留模型', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const originalProviders = store.listProviders(), originalModels = store.listModels(), originalBindings = store.listBindings();
  const originalSecrets = originalProviders.map(provider => [provider.id, store.getSecret(provider.id)]);
  const size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const kinds: RelayAccountKind[] = ['trae-cn-relay', 'jetbrains-central'];
  const screenshots: string[] = [], results: unknown[] = [];
  const originalTheme = await evaluate<{ theme?: string; colorScheme: string }>(`({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})`);
  const privatePattern = /PRIVATE_RELAY_IMPORT|SYNTHETIC_RELAY_IMPORT_(?:ACCESS|REFRESH|TOKEN|SECRET)|synthetic-relay-import-manual-key|qa-private-relay-(?:token|stderr|path)/i;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'relay-client-import-timeout.png'), await captureUi());
    throw new Error(`Relay client import timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});button.scrollIntoView({block:'nearest'});button.click()})()`);
  }
  async function clearToasts(): Promise<void> { await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`); }
  async function closeDialog(): Promise<void> { if (await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`)) { await click('[aria-label="关闭对话框"]'); await waitFor(`!document.querySelector('[role="dialog"]')`, 'import dialog closed'); } }
  async function privacy(): Promise<void> {
    const safeViews = await evaluate<string>(`(async()=>JSON.stringify({body:document.body.innerText,inputs:[...document.querySelectorAll('input,textarea')].map(input=>input.value),accounts:await window.modelDock.authAccounts(),snapshot:await window.modelDock.snapshot(),diagnostics:await window.modelDock.queryDiagnostics({limit:200})}))()`);
    assert.doesNotMatch(safeViews, privatePattern, 'Client authorization and raw private failures never reach renderer views or diagnostics');
    assert.doesNotMatch(safeViews, /Error invoking remote method|modeldock:(?:importRelayClientAccount|relayClientImportCandidates)/i, 'Native client import errors show their safe explanation without internal Electron transport names');
  }
  async function capture(name: string, keepToasts = false): Promise<void> {
    if (!keepToasts) await clearToasts(); await privacy();
    const layout = await evaluate<{ documentOverflow: boolean; mainOverflow: boolean; dialogOverflow: boolean }>(`(()=>{const main=document.querySelector('.main-content'),dialog=document.querySelector('[role="dialog"]');return {documentOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,dialogOverflow:!!dialog&&dialog.scrollWidth>dialog.clientWidth+1}})()`);
    assert.deepEqual(layout, { documentOverflow: false, mainOverflow: false, dialogOverflow: false }, 'Relay import controls fit both themes and viewport sizes');
    const filename = `relay-client-import-${name}.png`; writeFileSync(join(outputDir, filename), await captureUi()); screenshots.push(filename);
  }
  async function open(kind: RelayAccountKind): Promise<string> {
    await clearToasts(); await click(kind === 'jetbrains-central' ? '[data-action="jetbrains-import-options"]' : `[data-auth-import-account="${kind}"]`);
    const scope = `[data-relay-client-import="${kind}"]`;
    if (kind === 'jetbrains-central') {
      await waitFor(`!!document.querySelector(${JSON.stringify(scope)}+' [data-jetbrains-ide-account-boundary]')`, 'JetBrains explains the IDE and Air session boundary before checking Central');
      assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(scope)}+' [role="alert"]')||!!document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]')`), false, 'Opening the JetBrains guide does not implicitly query a Central login');
      await click('[role="dialog"] [data-action="check-central-login"]');
    }
    await waitFor(`document.querySelector(${JSON.stringify(scope)})?.getAttribute('aria-busy')==='false'`, 'relay import choices finished loading');
    assert.equal(await evaluate<boolean>(`[...document.querySelectorAll('[role="dialog"] button')].some(button=>/启动反代|停止反代/.test(button.textContent))`), false, 'Import has no separate relay startup requirement');
    return scope;
  }
  async function choose(scope: string): Promise<void> {
    await waitFor(`document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]')?.options.length>0`, 'synthetic native account candidate');
    await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]');select.value=select.options[0].value;select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  }
  try {
    window.setMinimumSize(980, 680); window.setSize(1180, 800);
    await click('[aria-label="刷新本机配置"]'); await click('[data-page="auth"]');
    for (const kind of kinds) assert.equal(await evaluate<number>(`document.querySelectorAll('[data-auth-kind="${kind}"] [data-auth-import-account="${kind}"]').length`), 1, 'Both relay groups offer native client import');
    for (const theme of ['light', 'dark']) for (const viewport of [1180, 980]) {
      window.setSize(viewport, viewport === 1180 ? 800 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      store.setManagedState('qa-relay-client-import-stage', 'empty');
      for (const kind of kinds) {
        const scope = await open(kind);
        assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(scope)}+' [data-relay-import-message]')&&!document.querySelector(${JSON.stringify(scope)}+' [role="alert"]')`), true, 'An empty client preview completes normally with its missing-account explanation');
        assert.equal(await evaluate<number>(`document.querySelectorAll(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"] option').length`), 0, 'Empty fixtures offer no user accounts');
        assert.equal(await evaluate<boolean>(`document.querySelector('[role="dialog"] [data-action="import-relay-client-account"]').disabled`), true, 'Import requires an available candidate');
        await capture(`${kind}-empty-${theme}-${viewport}`); await closeDialog();
      }
    }
    for (const kind of kinds) {
      store.setManagedState('qa-relay-client-import-stage', 'failure');
      const scope = await open(kind); await choose(scope);
      const before = { providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) };
      await click('[role="dialog"] [data-action="import-relay-client-account"]');
      await waitFor(`!!document.querySelector('.toast.error')`, 'synthetic import failure reports a safe error');
      await privacy();
      assert.deepEqual({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) }, before, 'Failed imports preserve every existing source, model, binding and credential');
      await capture(`${kind}-failure-dark`, true); await closeDialog();
    }
    for (const kind of kinds) {
      store.setManagedState('qa-relay-client-import-stage', 'success');
      let scope = await open(kind); await choose(scope);
      const began = Date.now(); await click('[role="dialog"] [data-action="import-relay-client-account"]');
      await waitFor(`!document.querySelector('[role="dialog"]')`, 'synthetic import succeeds');
      const imported = (await evaluate<AuthAccount[]>('window.modelDock.authAccounts()')).find(account => account.kind === kind && !!account.clientImport);
      assert.ok(imported, 'Successful native import creates a renderer-safe relay account with provenance');
      assert.equal(imported.source, 'relay', 'Client import keeps the relay authorization contract');
      assert.ok(imported.clientImport?.importedAt && Number.isFinite(Date.parse(imported.clientImport.importedAt)));
      const provider = store.getProvider(imported.providerId); assert.ok(provider?.hasSecret);
      assert.equal(provider.presetId, kind); if (kind === 'trae-cn-relay') assert.equal(provider.relayMode, 'managed', 'Client import never converts the existing manual connection');
      await waitFor(`!!document.querySelector('[data-auth-account="${provider.id}"]')`, 'new account is refreshed in its authorization-center group');
      assert.ok(Date.now() - began < 5000, 'Imported account appears without waiting for the background account poll');
      await click(`[data-auth-account="${provider.id}"] [data-action="account-menu"]`); await click(`[data-auth-account-menu="${provider.id}"] [data-action="relay-account-details"]`);
      assert.equal(await evaluate<string>(`document.querySelector('[data-auth-account-details="${provider.id}"] [data-relay-client-source]')?.getAttribute('data-relay-client-source')`), imported.clientImport!.client, 'Imported source remains visible in account details');
      await closeDialog();
      await evaluate(`document.querySelector('[data-auth-account="${provider.id}"]').scrollIntoView({block:'nearest'})`);
      for (const theme of ['light', 'dark']) for (const width of [1180, 980]) {
        window.setSize(width, width === 1180 ? 800 : 680);
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('[data-auth-account="${provider.id}"]').scrollIntoView({block:'nearest'})`);
        await capture(`${kind}-success-${theme}-${width}`);
      }
      const model = store.saveModel({ providerId: provider.id, upstreamId: `import-preserve-${kind}`, alias: `import-preserve-${kind}`, displayName: '再次导入保留模型', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
      const junie = store.listBindings().find(binding => binding.id === 'junie'); assert.ok(junie);
      store.saveBinding({ ...junie, mode: 'aggregate', enabled: false, providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
      const customName = kind === 'trae-cn-relay' ? '我的 TRAE · 重新导入保留名称' : '我的 JetBrains · 重新连接保留名称';
      store.saveProvider({ ...store.getProvider(provider.id)!, name: customName });
      const repeatedBefore = { provider: store.getProvider(provider.id), secret: store.getSecret(provider.id), providers: store.listProviders().length, models: store.listModels(), bindings: store.listBindings() };
      scope = await open(kind); await choose(scope); await click('[role="dialog"] [data-action="import-relay-client-account"]'); await waitFor(`!document.querySelector('[role="dialog"]')`, 're-import succeeds');
      const repeated = (await evaluate<AuthAccount[]>('window.modelDock.authAccounts()')).find(account => account.kind === kind && !!account.clientImport);
      assert.equal(repeated?.providerId, provider.id, 'Re-import reuses the same strict relay provider');
      assert.deepEqual({ provider: store.getProvider(provider.id), secret: store.getSecret(provider.id), providers: store.listProviders().length, models: store.listModels(), bindings: store.listBindings() }, repeatedBefore, 'Re-import preserves connection identity, key, source count, models and tool references');
      await waitFor(`document.querySelector('[data-auth-account="${provider.id}"] .account-identity strong')?.textContent===${JSON.stringify(customName)}`, 're-import preserves and refreshes the customized account name');
      await capture(`${kind}-reimport-name-dark-980`);
      await privacy(); results.push({ kind, providerReused: true, source: imported.source, client: imported.clientImport!.client });
    }
    assert.deepEqual(store.getProvider(manual.id), manual); assert.deepEqual(store.getSecret(manual.id), { apiKey: manualKey });
    assert.ok(store.listModels().some(model => model.id === manualModel.id));
    for (const provider of originalProviders) assert.deepEqual(store.getProvider(provider.id), provider, 'Unrelated existing providers remain unchanged');
    assert.deepEqual(originalProviders.map(provider => [provider.id, store.getSecret(provider.id)]), originalSecrets);
    assert.ok(originalModels.every(model => store.listModels().some(current => JSON.stringify(current) === JSON.stringify(model))));
    assert.deepEqual(store.listBindings().filter(binding => binding.id !== 'junie'), originalBindings.filter(binding => binding.id !== 'junie'));
    writeFileSync(join(outputDir, 'relay-client-import-validation.json'), JSON.stringify({ ok: true, themes: ['light', 'dark'], widths: [1180, 980], relayGroupsExposeImport: true, noSeparateRelayStartup: true, emptyFixturesDoNotOfferRealAccounts: true, failuresPreserveExistingConfiguration: true, syntheticImportsAndProvenanceVerified: true, repeatedImportReusesProviders: true, customizedAccountNamesPreserved: true, manualTraePreserved: true, modelsAndBindingReferencesPreserved: true, rendererAndDiagnosticsDoNotContainSecrets: true, noRealClientCredentialsOrRelayProcesses: true, results, screenshots }, null, 2));
  } finally {
    store.setManagedState('qa-relay-client-import-stage', 'empty');
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
