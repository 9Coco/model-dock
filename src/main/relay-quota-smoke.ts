import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AuthAccount } from '../shared/auth-types';
import { TRAE_RELAY_BASE_URL } from '../shared/presets';
import { relayConnectionFingerprint } from './relay-client-import';
import type { Store } from './store';

/** Only synthetic native-relay quota adapters and the isolated QA database are used. */
export async function verifyRelayQuota(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const managedKey = 'a3'.repeat(32), manualKey = 'PRIVATE_RELAY_QUOTA_MANUAL_KEY';
  const managed = store.saveProvider({ name: 'TRAE 托管额度演示', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: managedKey });
  const manual = store.saveProvider({ name: '手动 TRAE · 不查询额度', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: 'http://127.0.0.1:19092/v1', enabled: false, apiKey: manualKey });
  const provenance = { client: 'trae-cn', accountLabel: '最初导入账号 X', importedAt: new Date().toISOString(), upstreamVerified: false };
  store.setManagedState(`auth-metadata:${managed.id}`, { version: 1, connection: relayConnectionFingerprint(managed, managedKey), identity: 'synthetic-quota-import-identity', clientImport: provenance });
  const model = store.saveModel({ providerId: managed.id, upstreamId: 'relay-quota-preserved', alias: 'relay-quota-preserved', displayName: '额度查询保留模型', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const junie = store.listBindings().find(binding => binding.id === 'junie'); assert.ok(junie);
  store.saveBinding({ ...junie, mode: 'aggregate', enabled: false, providerIds: [managed.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  const unchanged = () => ({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), keys: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) });
  const original = unchanged(), size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const row = `[data-auth-account="${managed.id}"]`, manualRow = `[data-auth-account="${manual.id}"]`;
  const screenshots: string[] = [], stages: unknown[] = [];
  const originalTheme = await evaluate<{ theme?: string; colorScheme: string }>(`({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})`);
  async function waitFor(source: string, label: string): Promise<void> {
    const end = Date.now() + 10_000;
    while (Date.now() < end) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'relay-quota-timeout.png'), await captureUi()); throw new Error(`Relay quota UI timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});button.scrollIntoView({block:'nearest'});button.click()})()`);
  }
  async function clearToasts(): Promise<void> { await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`); }
  async function closeDialog(): Promise<void> { await click('[aria-label="关闭对话框"]'); await waitFor(`!document.querySelector('[role="dialog"]')`, 'dialog closed'); }
  async function accounts(): Promise<AuthAccount[]> { return evaluate<AuthAccount[]>('window.modelDock.authAccounts()'); }
  async function current(): Promise<AuthAccount> { const account = (await accounts()).find(item => item.providerId === managed.id); assert.ok(account); return account; }
  async function privacy(): Promise<void> {
    const view = await evaluate<string>(`(async()=>JSON.stringify({body:document.body.innerText,inputs:[...document.querySelectorAll('input,textarea')].map(input=>input.value),accounts:await window.modelDock.authAccounts(),snapshot:await window.modelDock.snapshot(),diagnostics:await window.modelDock.queryDiagnostics({limit:200})}))()`);
    for (const secret of [managedKey, manualKey, 'PRIVATE_RELAY_QUOTA_TOKEN_RAW_BODY']) assert.equal(view.includes(secret), false, 'Private relay credentials and raw quota bodies never enter renderer views or diagnostics');
    assert.doesNotMatch(view, /Error invoking remote method|modeldock:(?:relayClientImportCandidates|importRelayClientAccount)/i);
  }
  async function capture(name: string): Promise<void> {
    await privacy();
    const overflow = await evaluate<{ document: boolean; main: boolean; dialog: boolean }>(`(()=>{const main=document.querySelector('.main-content'),dialog=document.querySelector('[role="dialog"]');return {document:document.documentElement.scrollWidth>innerWidth+1,main:main.scrollWidth>main.clientWidth+1,dialog:!!dialog&&dialog.scrollWidth>dialog.clientWidth+1}})()`);
    assert.deepEqual(overflow, { document: false, main: false, dialog: false });
    const file = `relay-quota-${name}.png`; writeFileSync(join(outputDir, file), await captureUi()); screenshots.push(file);
  }
  async function refresh(mode: string): Promise<AuthAccount> {
    await clearToasts(); const previousQuery = (await current()).usage.queriedAt; store.setManagedState('qa-relay-quota-mode', mode);
    await click(`${row} [data-action="refresh-account-quota"]`);
    await waitFor(`(async()=>{const account=(await window.modelDock.authAccounts()).find(item=>item.providerId===${JSON.stringify(managed.id)});return !!account?.usage.queriedAt&&account.usage.queriedAt!==${JSON.stringify(previousQuery)}&&!document.querySelector(${JSON.stringify(row)}+' [data-action="refresh-account-quota"]').disabled})()`, 'manual quota query finished');
    const result = await current(); stages.push({ mode, accountId: result.accountId ?? null, status: result.usage.status, windows: result.usage.windows.length }); return result;
  }
  try {
    window.setMinimumSize(980, 680); window.setSize(1180, 800);
    store.setManagedState('qa-relay-quota-mode', 'ready');
    assert.equal(store.getManagedState(`auth-usage:${managed.id}`, null), null, 'Quota has not been queried by the fixture itself');
    await click('[aria-label="刷新本机配置"]'); await click('.sidebar [data-page="auth"]');
    await waitFor(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="credits"]')?.dataset.remainingPercent==='62.5'`, 'managed TRAE automatically queries official quota');
    assert.ok(store.getManagedState(`auth-usage:${managed.id}`, null), 'The authorization center performs its initial automatic quota query');
    const ready = await current();
    assert.equal(ready.canQueryUsage, true); assert.equal(ready.accountId, 'qa-active-a'); assert.equal(ready.displayName, '反代当前账号 A'); assert.equal(ready.clientImport?.accountLabel, provenance.accountLabel);
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-account-plan]')?.textContent`), 'Pro', 'Verified relay plan is visible beside its identity');
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(manualRow)}+' [data-account-plan]')?.textContent`), '套餐未知', 'Manual relays never infer a plan from their label or key');
    assert.deepEqual(ready.usage.windows.map(item => [item.remaining, item.total, item.unit]), [[625, 1000, '积分'], [300, 500, '次']]);
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="credits"] strong').textContent`), '625 / 1,000 积分', 'Official credits and units are directly visible rather than available only in a tooltip');
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="fast"] strong').textContent`), '300 / 500 次', 'Official request counts and units are directly visible');
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(row)}+' [data-relay-quota-account]').textContent.includes('反代当前账号 A')&&document.querySelector(${JSON.stringify(row)}+' [data-relay-client-source]').textContent.includes('最初导入账号 X')`), true, 'Quota identity is distinct from the last imported account');
    const manualAccount = (await accounts()).find(item => item.providerId === manual.id); assert.ok(manualAccount); assert.equal(manualAccount.canQueryUsage, false);
    assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(manualRow)}+' [data-action="refresh-account-quota"]')`), false, 'Manual relays never offer the managed quota action');
    const rejected = await evaluate<string>(`window.modelDock.refreshAccountUsage(${JSON.stringify(manual.id)}).then(()=>'',error=>error.message)`);
    assert.ok(rejected); assert.doesNotMatch(rejected, /PRIVATE_/); assert.equal(rejected.includes(managedKey), false); assert.equal(store.getManagedState(`auth-usage:${manual.id}`, null), null);
    for (const theme of ['light', 'dark']) for (const width of [1180, 980]) {
      window.setSize(width, width === 1180 ? 800 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(row)}).scrollIntoView({block:'nearest'})`);
      await clearToasts(); await capture(`ready-${theme}-${width}`);
      // Even when a synthetic Central account is available, opening this guide
      // must first explain IDE/Air support instead of querying another client.
      store.setManagedState('qa-relay-client-import-stage', 'success');
      await click('[data-auth-import-account="jetbrains-central"]');
      await waitFor(`!!document.querySelector('[data-jetbrains-ide-account-boundary]')`, 'JetBrains native account guide opens');
      assert.equal(await evaluate<string>(`document.querySelector('[role="dialog"] #modal-title').textContent`), '连接JetBrains账号');
      assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-jetbrains-ide-account-boundary]')&&!document.querySelector('[role="dialog"] [data-field="relay-import-candidate"]')&&!document.querySelector('[role="dialog"] [role="alert"]')&&document.querySelector('[data-action="import-relay-client-account"]').disabled`), true, 'IDE/Air guidance does not silently inspect or import Central login');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[role="dialog"] [data-action^="jetbrains-account-help-"]').length`), 2);
      await capture(`jetbrains-guide-${theme}-${width}`); await closeDialog();
    }
    const switched = await refresh('switched'); assert.equal(switched.accountId, 'qa-active-b'); assert.equal(switched.displayName, '反代当前账号 B'); assert.equal(switched.clientImport?.accountLabel, provenance.accountLabel);
    await waitFor(`document.querySelector(${JSON.stringify(row)}+' [data-relay-quota-account]').textContent.includes('反代当前账号 B')`, 'current relay account changes without replacing import provenance'); await capture('switched-dark');
    await click(`${row} [data-action="relay-account-details"]`);
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-auth-account-details="${managed.id}"]').textContent.includes('反代当前账号 B')&&document.querySelector('[data-auth-account-details="${managed.id}"]').textContent.includes('最初导入账号 X')`), true);
    await capture('account-details-dark'); await closeDialog();
    const unknown = await refresh('unknown'); assert.equal(unknown.usage.windows[0].remainingPercent, undefined);
    await waitFor(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="credits"]')?.dataset.remainingPercent===''`, 'unknown quota has no invented percentage');
    assert.equal(await evaluate<boolean>(`!document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="credits"]').textContent.includes('%')&&document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="credits"] strong').textContent==='未知'`), true); await capture('unknown-dark');
    for (const mode of ['failure', 'unavailable']) {
      const failed = await refresh(mode); assert.equal(failed.usage.status, 'unavailable'); assert.equal(failed.accountId, undefined); assert.equal(failed.displayName, undefined); assert.deepEqual(failed.usage.windows, []);
      assert.equal(failed.plan, undefined);
      await waitFor(`document.querySelectorAll(${JSON.stringify(row)}+' [data-quota-window-id]').length===0`, 'failed quota removes stale account balances');
      assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-account-plan]')?.textContent`), '套餐未知', 'A failed or switched account never keeps the previous plan badge');
      assert.equal(await evaluate<boolean>(`!document.querySelector(${JSON.stringify(row)}+' [data-relay-quota-account]').textContent.includes('反代当前账号 A')&&!document.querySelector(${JSON.stringify(row)}+' [data-relay-quota-account]').textContent.includes('反代当前账号 B')`), true);
      for (const theme of ['light', 'dark']) for (const width of [1180, 980]) {
        window.setSize(width, width === 1180 ? 800 : 680);
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(row)}).scrollIntoView({block:'nearest'})`);
        assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-account-plan]')?.textContent`), '套餐未知');
        await capture(`${mode}-plan-unknown-${theme}-${width}`);
      }
    }
    assert.deepEqual(unchanged(), original, 'Quota reads and guidance preserve every supplier, credential, model and tool binding');
    assert.deepEqual(store.getManagedState<{ clientImport: unknown }>(`auth-metadata:${managed.id}`, { clientImport: null }).clientImport, provenance);
    writeFileSync(join(outputDir, 'relay-quota-validation.json'), JSON.stringify({ ok: true, themes: ['light', 'dark'], widths: [1180, 980], knownProAndUnknownPlanBadgesVerified: true, managedTraeAutoRefresh: true, managedTraeManualRefresh: true, manualRelayNotQueried: true, officialAmountsAndUnitsShown: true, currentAccountSeparateFromImportProvenance: true, accountSwitchClearsPreviousIdentity: true, unknownQuotaHasNoInventedPercent: true, failuresClearPreviousBalances: true, jetBrainsGuideDoesNotQueryCentralUntilExplicitCheck: true, privacyVerified: true, configurationsUnchanged: true, noRealRelayOrClientAccess: true, stages, screenshots }, null, 2));
  } finally {
    store.setManagedState('qa-relay-quota-mode', 'unavailable'); store.setManagedState('qa-relay-client-import-stage', 'empty');
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
