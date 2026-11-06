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
  const rowHeights = new Map<number, number>();
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
      rowHeights.set(width, await evaluate<number>(`document.querySelector(${JSON.stringify(row)}).getBoundingClientRect().height`));
      // Even when a synthetic Central account is available, opening this guide
      // must first explain IDE/Air support instead of querying another client.
      store.setManagedState('qa-relay-client-import-stage', 'success');
      await click('[data-action="jetbrains-import-options"]');
      await waitFor(`!!document.querySelector('[data-jetbrains-ide-account-boundary]')`, 'JetBrains native account guide opens');
      assert.equal(await evaluate<string>(`document.querySelector('[role="dialog"] #modal-title').textContent`), '连接JetBrains账号');
      assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-jetbrains-ide-account-boundary]')&&!document.querySelector('[role="dialog"] [data-field="relay-import-candidate"]')&&!document.querySelector('[role="dialog"] [role="alert"]')&&document.querySelector('[data-action="import-relay-client-account"]').disabled`), true, 'IDE/Air guidance does not silently inspect or import Central login');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[role="dialog"] [data-action^="jetbrains-account-help-"]').length`), 2);
      await capture(`jetbrains-guide-${theme}-${width}`); await closeDialog();
    }
    const many = await refresh('many'); assert.equal(many.usage.windows.length, 40);
    assert.equal(many.usage.windows[0].remaining, 0); assert.equal(many.usage.windows[1].remaining, undefined); assert.equal(many.usage.windows[2].unlimited, true);
    for (const theme of ['light', 'dark']) for (const width of [1180, 980]) {
      window.setSize(width, width === 1180 ? 800 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(row)}).scrollIntoView({block:'nearest'})`);
      await waitFor(`document.querySelectorAll(${JSON.stringify(row)}+' [data-quota-window-id]').length===2&&document.querySelector(${JSON.stringify(row)}+' [data-action="show-all-quotas"]')?.textContent==='查看全部 40 项额度'`, 'many independent quotas stay collapsed with an exact total');
      const height = await evaluate<number>(`document.querySelector(${JSON.stringify(row)}).getBoundingClientRect().height`);
      assert.ok(height <= (rowHeights.get(width) ?? 0) + 52 && height <= 260, `Account row remains bounded with 40 quota windows (${height}px)`);
      assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="many-1"] strong').textContent`), '0 / 1,000 积分', 'Measured zero remains distinct from unknown');
      assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="many-2"] strong').textContent`), '未知', 'Unknown quota is never displayed as zero');
      await clearToasts(); await capture(`many-collapsed-${theme}-${width}`);
      await click(`${row} [data-action="show-all-quotas"]`);
      const details = `[data-auth-account-details="${managed.id}"]`;
      await waitFor(`document.querySelectorAll(${JSON.stringify(details)}+' [data-quota-detail-id]').length===40`, 'all independent quotas remain accessible in details');
      const values = await evaluate<{ id: string; text: string }[]>(`[...document.querySelectorAll(${JSON.stringify(details)}+' [data-quota-detail-id]')].map(item=>({id:item.dataset.quotaDetailId,text:item.textContent}))`);
      assert.deepEqual(values.map(item => item.id), many.usage.windows.map(item => item.id));
      for (const [index, item] of values.entries()) {
        assert.ok(item.text.includes(many.usage.windows[index].label), 'The complete independent quota label remains readable');
        assert.ok(item.text.includes(index % 2 ? '后重置' : '重置时间未知'), 'Known and unknown reset times remain distinct');
      }
      assert.ok(values[0].text.includes('0 / 1,000 积分')); assert.ok(values[1].text.includes('未知')); assert.ok(!values[1].text.includes('0%')); assert.ok(values[2].text.includes('不限量'));
      assert.ok(values[39].text.includes('664 / 1,039 次'), 'The final independent amount is preserved');
      const scrollable = await evaluate<boolean>(`(()=>{const body=document.querySelector(${JSON.stringify(details)});return body.scrollHeight>body.clientHeight+1&&body.scrollWidth<=body.clientWidth+1})()`);
      assert.equal(scrollable, true, 'Quota details scroll vertically without horizontal overflow');
      await capture(`many-details-${theme}-${width}`);
      await evaluate(`document.querySelector(${JSON.stringify(details)}+' [data-quota-detail-id="many-40"]').scrollIntoView({block:'nearest'})`);
      await waitFor(`(()=>{const body=document.querySelector(${JSON.stringify(details)}),last=body.querySelector('[data-quota-detail-id="many-40"]');return body.scrollTop>0&&last.getBoundingClientRect().bottom<=body.getBoundingClientRect().bottom+1})()`, 'the last quota is reachable by scrolling');
      await capture(`many-details-last-${theme}-${width}`); await closeDialog();
    }
    const reduced = await refresh('ready'); assert.equal(reduced.usage.windows.length, 2);
    await waitFor(`document.querySelectorAll(${JSON.stringify(row)}+' [data-quota-window-id]').length===2&&!document.querySelector(${JSON.stringify(row)}+' [data-action="show-all-quotas"]')`, 'shrinking quota results removes the obsolete expand action');
    await capture('many-reduced-to-two');
    const official = await refresh('official-balance');
    assert.ok(official.usage.summary); assert.ok(Math.abs(official.usage.summary.remaining! - 1813.8036) < 0.000001);
    assert.equal(official.usage.summary.total, 2400); assert.equal(official.usage.summary.grantCount, 20);
    assert.equal(official.usage.windows.length, 2); assert.equal(official.usage.details?.length, 20);
    const checkin = official.usage.windows.find(item => item.label === '每日签到'), monthly = official.usage.windows.find(item => item.label === '每月登录赠送');
    assert.ok(checkin); assert.ok(monthly);
    assert.equal(checkin.total, 1900); assert.equal(checkin.grantCount, 19); assert.ok(Math.abs(checkin.remaining! - 1313.8036) < 0.000001);
    assert.equal(monthly.total, 500); assert.equal(monthly.remaining, 500); assert.equal(monthly.grantCount, 1); assert.equal(monthly.measurement, 'official-default');
    assert.equal(new Set(official.usage.details!.map(item => item.expiresAt)).size, 20, 'Every independent grant retains its own expiry');
    assert.ok(official.usage.details!.every(item => !!item.expiresAt && item.resetAt === undefined), 'Grant expiry is never reinterpreted as quota reset');
    for (const theme of ['light', 'dark']) for (const width of [1180, 980]) {
      window.setSize(width, width === 1180 ? 800 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(row)}).scrollIntoView({block:'nearest'})`);
      await waitFor(`document.querySelector(${JSON.stringify(row)}+' [data-quota-summary-amount]')?.textContent==='1,813.80 积分'`, 'official credit total is prominent and retains two decimal places');
      assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="${checkin.id}"] strong').textContent`), '1,313.80 / 1,900.00 积分');
      assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="${monthly.id}"] strong').textContent`), '500.00 / 500.00 积分');
      assert.match(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="${checkin.id}"] .auth-window-label').textContent`), /每日签到 · 19 笔/);
      assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-action="show-all-quotas"]').textContent`), '查看全部 20 项额度');
      assert.ok(await evaluate<boolean>(`document.querySelector(${JSON.stringify(row)}).getBoundingClientRect().height<=330`), 'Grouped official credits remain bounded in the account row');
      assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(row)}+' .account-quotas').textContent.includes('后重置')`), false, 'Grouped grant expiry is never described as reset');
      await capture(`official-balance-${theme}-${width}`);
      await click(`${row} [data-action="show-all-quotas"]`);
      const details = `[data-auth-account-details="${managed.id}"]`;
      await waitFor(`document.querySelectorAll(${JSON.stringify(details)}+' [data-quota-detail-id]').length===20`, 'grouped balance opens all twenty grant details');
      const detailState = await evaluate<{ summary: string; ids: string[]; text: string; timings: string[] }>(`(()=>{const body=document.querySelector(${JSON.stringify(details)});return{summary:body.querySelector('[data-quota-summary-amount]').textContent,ids:[...body.querySelectorAll('[data-quota-detail-id]')].map(item=>item.dataset.quotaDetailId),text:body.textContent,timings:[...body.querySelectorAll('[data-quota-detail-timing]')].map(item=>item.textContent)}})()`);
      assert.equal(detailState.summary, '1,813.80 积分'); assert.deepEqual(detailState.ids, official.usage.details!.map(item => item.id));
      assert.ok(detailState.text.includes('按官方客户端规则')); assert.ok(!detailState.text.includes('按协议默认值')); assert.ok(detailState.text.includes('500.00 / 500.00 积分'));
      assert.ok(detailState.timings.every(value => value.includes('到期') && !value.includes('重置')));
      assert.ok(new Set(detailState.timings).size > 1, 'Distinct grant expiries remain visible');
      await capture(`official-details-${theme}-${width}`);
      await evaluate(`document.querySelector(${JSON.stringify(details)}+' [data-quota-detail-id="${official.usage.details!.at(-1)!.id}"]').scrollIntoView({block:'nearest'})`);
      await waitFor(`document.querySelector(${JSON.stringify(details)}).scrollTop>0`, 'official grant details remain scrollable to the final grant');
      await capture(`official-details-last-${theme}-${width}`); await closeDialog();
    }
    await click(`${row} [data-action="relay-account-details"]`);
    await waitFor(`document.querySelectorAll('[data-auth-account-details="${managed.id}"] [data-quota-detail-id]').length===20`, 'existing account detail action also shows the independent grant list');
    await closeDialog();
    const partialOfficial = await refresh('official-unknown');
    assert.equal(partialOfficial.usage.summary?.remaining, undefined, 'One malformed grant balance makes the grand total unknown');
    const unknownMonthly = partialOfficial.usage.windows.find(item => item.label === '每月登录赠送'), knownCheckin = partialOfficial.usage.windows.find(item => item.label === '每日签到');
    assert.ok(unknownMonthly); assert.ok(knownCheckin); assert.equal(unknownMonthly.remaining, undefined); assert.equal(unknownMonthly.total, 500); assert.ok(Math.abs(knownCheckin.remaining! - 1313.8036) < 0.000001);
    await waitFor(`document.querySelector(${JSON.stringify(row)}+' [data-quota-summary-amount]')?.textContent==='未知'`, 'partial known groups never become a false complete total');
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="${unknownMonthly.id}"] strong').textContent`), '剩余未知 / 总额 500.00 积分', 'A known limit is never presented as a known balance');
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="${knownCheckin.id}"] strong').textContent`), '1,313.80 / 1,900.00 积分');
    await capture('official-partial-unknown-dark-980');
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
    writeFileSync(join(outputDir, 'relay-quota-validation.json'), JSON.stringify({ ok: true, themes: ['light', 'dark'], widths: [1180, 980], knownProAndUnknownPlanBadgesVerified: true, managedTraeAutoRefresh: true, managedTraeManualRefresh: true, manualRelayNotQueried: true, officialAmountsAndUnitsShown: true, manyQuotasStayCollapsedAndBounded: true, allFortyIndependentQuotaDetailsAccessible: true, zeroUnknownAndUnlimitedRemainDistinct: true, detailsScrollWithoutHorizontalOverflow: true, shrinkingResultsRemoveExpandAction: true, officialRawGrantParserMatches1813_80: true, officialSourceGroupsPreserve19CheckinsAndMonthly500: true, allTwentyCreditGrantsPreserved: true, grantExpiryNeverPresentedAsReset: true, officialDefaultUsageExplained: true, existingDetailsActionUsesGrants: true, unknownGrantPropagatesWithoutMislabelingKnownLimits: true, currentAccountSeparateFromImportProvenance: true, accountSwitchClearsPreviousIdentity: true, unknownQuotaHasNoInventedPercent: true, failuresClearPreviousBalances: true, jetBrainsGuideDoesNotQueryCentralUntilExplicitCheck: true, privacyVerified: true, configurationsUnchanged: true, noRealRelayOrClientAccess: true, stages, screenshots }, null, 2));
  } finally {
    store.setManagedState('qa-relay-quota-mode', 'unavailable'); store.setManagedState('qa-relay-client-import-stage', 'empty');
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
