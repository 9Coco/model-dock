import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AuthAccount } from '../shared/auth-types';
import { TRAE_RELAY_BASE_URL } from '../shared/presets';
import { relayConnectionFingerprint } from './relay-client-import';
import type { Store } from './store';

interface AuthRowRect { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface UnifiedAuthLayout {
  viewport: { width: number; height: number };
  overflow: boolean;
  rows: { id: string; kind: string; grid: string; columns: string[]; box: AuthRowRect; identity: AuthRowRect; quotas: AuthRowRect; actions: AuthRowRect; avatar: AuthRowRect; refresh: AuthRowRect; menu: AuthRowRect; quotaCount: number; summary: boolean; details: boolean; fonts: number[]; queryAge: string; refreshDisabled: boolean; windows: { id: string; grid: string; label: AuthRowRect; bar: AuthRowRect; value: AuthRowRect; timing: AuthRowRect; timingText: string; timingTitle: string; timingHidden: boolean; text: string; title: string; clipped: boolean }[] }[];
}

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
  let original = unchanged(); const size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const row = `[data-auth-account="${managed.id}"]`, manualRow = `[data-auth-account="${manual.id}"]`;
  const screenshots: string[] = [], stages: unknown[] = [];
  const unifiedLayouts: { theme: string; requestedWidth: number; layout: UnifiedAuthLayout }[] = [];
  let unifiedIds: string[] = [];
  const oauthFixtureTokens: string[] = [];
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
  async function openDetails(id: string): Promise<void> {
    await click(`[data-auth-account="${id}"] [data-action="account-menu"]`);
    const action = (await accounts()).find(account => account.providerId === id)?.source === 'relay' ? 'relay-account-details' : 'account-details';
    await click(`[data-auth-account-menu="${id}"] [data-action="${action}"]`);
    await waitFor(`!!document.querySelector('[data-auth-account-details="${id}"]')`, 'account details from the common menu');
  }
  async function addUnifiedFixtures(): Promise<void> {
    const ids: string[] = [];
    for (const [kind, email] of [['codex', 'codex.unified.long.account@example.test'], ['grok', 'grok.unified.account@example.test']] as const) {
      const provider = store.saveProvider({ name: kind === 'codex' ? 'Codex 统一布局演示' : 'Grok 统一布局演示', kind, baseUrl: kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://cli-chat-proxy.grok.com/v1', enabled: true });
      const accessToken = `UNIFIED_PRIVATE_ACCESS.${Buffer.from(JSON.stringify({ sub: `unified-${kind}`, email, exp: Math.floor(Date.now() / 1000) + 7200, 'https://api.openai.com/auth': { chatgpt_account_id: `unified-workspace-${kind}`, ...(kind === 'codex' ? { chatgpt_plan_type: 'plus' } : {}) } })).toString('base64url')}.mock`;
      store.setSecret(provider.id, { accessToken, accountId: `unified-workspace-${kind}`, expiresAt: Date.now() + 7200_000 });
      oauthFixtureTokens.push(accessToken); ids.push(provider.id);
    }
    await click('[aria-label="刷新本机配置"]'); await click('[data-action="reload-auth-accounts"]');
    await waitFor(`(async()=>{const values=await window.modelDock.authAccounts();return ${JSON.stringify(ids)}.every(id=>values.find(item=>item.providerId===id)?.usage.status==='ready')})()`, 'synthetic Grok and Codex quota rows');
    await click('[data-action="copilot-login"]');
    await waitFor(`(async()=>{const values=await window.modelDock.authAccounts();return values.some(item=>item.kind==='copilot'&&item.usage.status==='ready')})()`, 'synthetic Copilot account row');
    if (await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`)) await closeDialog();
    store.setManagedState('qa-unified-auth-layout', true); store.setManagedState('qa-jetbrains-ide-mode', 'ready');
    await click('[data-auth-import-account="jetbrains-central"]');
    await waitFor(`(async()=>{const values=await window.modelDock.authAccounts();return values.some(item=>item.clientImport?.client==='jetbrains-ide'&&item.usage.status==='ready')})()`, 'synthetic native JetBrains row');
    const values = await accounts();
    const representative = ['copilot', 'codex', 'grok', 'trae-cn-relay', 'jetbrains-central'].map(kind => values.find(account => account.kind === kind && (kind === 'trae-cn-relay' ? account.providerId === managed.id : kind === 'jetbrains-central' ? account.clientImport?.client === 'jetbrains-ide' : kind === 'codex' || kind === 'grok' ? ids.includes(account.providerId) : account.usage.status === 'ready')));
    assert.ok(representative.every(Boolean), 'Every supported account family has a synthetic row');
    unifiedIds = representative.map(account => account!.providerId);
    original = unchanged();
  }
  async function inspectUnifiedRows(): Promise<void> {
    const quotaAccounts = new Map((await accounts()).map(account => [account.providerId, account]));
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1920, 1080], [1180, 920], [980, 860]]) {
      window.setSize(width, height);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector('.main-content').scrollTop=0`);
      await clearToasts(); await pause(140);
      const layout = await evaluate<UnifiedAuthLayout>(`(()=>{
        const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        return{viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth+1||document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth+1,
          rows:${JSON.stringify(unifiedIds)}.map(id=>{const row=document.querySelector('[data-auth-account="'+id+'"]'),identity=row.querySelector(':scope > .account-identity'),quotas=row.querySelector(':scope > .account-quotas'),actions=row.querySelector(':scope > .account-actions');return{
            id,kind:row.closest('[data-auth-kind]').dataset.authKind,grid:getComputedStyle(row).display,columns:[...row.children].map(item=>item.className),box:rect(row),identity:rect(identity),quotas:rect(quotas),actions:rect(actions),avatar:rect(identity.querySelector('[data-account-avatar]')),refresh:rect(actions.querySelector('[data-action="refresh-account-quota"]')),menu:rect(actions.querySelector('[data-action="account-menu"]')),quotaCount:quotas.querySelectorAll('[data-quota-window-id]').length,summary:!!quotas.querySelector('[data-quota-summary-amount]'),details:!!quotas.querySelector('[data-action="show-all-quotas"]'),fonts:[...row.querySelectorAll('strong,small,span,button')].filter(item=>item.getBoundingClientRect().height>0).map(item=>parseFloat(getComputedStyle(item).fontSize)),queryAge:actions.querySelector('.auth-row-age').textContent,refreshDisabled:actions.querySelector('[data-action="refresh-account-quota"]').disabled,
            windows:[...quotas.querySelectorAll('[data-quota-window-id]')].map(item=>{const value=item.querySelector('strong'),timing=item.querySelector('.auth-window-reset');return{id:item.dataset.quotaWindowId,grid:getComputedStyle(item).display,label:rect(item.querySelector('.auth-window-label')),bar:rect(item.querySelector('progress,.auth-window-unlimited')),value:rect(value),timing:rect(timing),timingText:timing.textContent,timingTitle:timing.title,timingHidden:timing.getAttribute('aria-hidden')==='true',text:value.textContent,title:value.title,clipped:value.scrollWidth>value.clientWidth+1}})
          }} )};
      })()`);
      assert.equal(layout.overflow, false, `Unified account layout has no horizontal overflow: ${theme}/${width}`);
      assert.equal(layout.rows.length, 5);
      const first = layout.rows[0], center = (rect: AuthRowRect) => (rect.top + rect.bottom) / 2;
      for (const item of layout.rows) {
        assert.equal(item.grid, 'grid', `Every family shares the account grid: ${item.kind}`);
        assert.deepEqual(item.columns, ['account-identity', 'account-quotas', 'account-actions'], `Every account has the same three structural columns: ${item.kind}`);
        assert.ok(Math.abs(item.identity.left - first.identity.left) <= 1 && Math.abs(item.quotas.left - first.quotas.left) <= 1 && Math.abs(item.actions.right - first.actions.right) <= 1, `Identity/quota/action anchors align across account families: ${item.kind}/${width}`);
        assert.ok(item.identity.right <= item.quotas.left + 1 && item.quotas.right <= item.actions.left + 1, `Account columns do not overlap: ${item.kind}/${width}`);
        assert.ok(Math.abs(item.avatar.width - 32) < 1 && Math.abs(item.avatar.height - 32) < 1, 'All account avatars use the same compact size');
        assert.ok(Math.abs(item.refresh.width - item.menu.width) < 1 && Math.abs(item.refresh.height - item.menu.height) < 1 && Math.abs(center(item.refresh) - center(item.menu)) < 1, `Refresh and ellipsis share one compact action line: ${item.kind}`);
        assert.ok(Math.abs(item.menu.right - first.menu.right) < 1, `Ellipsis buttons share the same trailing anchor: ${item.kind}`);
        const limit = 64 + Math.max(0, item.quotaCount - 1) * 30 + (item.summary ? 24 : 0) + (item.details ? 20 : 0);
        assert.ok(item.box.height <= limit, `Row height follows the visible quota count instead of a relay card: ${item.kind} ${item.box.height}px > ${limit}px`);
        assert.ok(item.fonts.every(font => font >= 12), `Compact account rows retain readable text: ${item.kind}`);
        assert.ok(item.queryAge.trim(), `The last quota query age remains visible: ${item.kind}`);
        assert.equal(item.refreshDisabled, false, `Manual quota querying remains available: ${item.kind}`);
        const account = quotaAccounts.get(item.id); assert.ok(account);
        for (const quota of item.windows) {
          assert.equal(quota.grid, 'grid', 'Percent and amount quotas share the same layout primitive');
          assert.ok(quota.label.right <= quota.bar.left + 1 && quota.bar.right <= quota.value.left + 1 && quota.value.right <= quota.timing.left + 1, `Quota label/progress/value/timing columns never overlap: ${item.kind}/${width} ${quota.text}`);
          assert.ok(quota.value.right <= item.quotas.right + 1 && quota.timing.right <= item.quotas.right + 1, 'Long credit amounts remain inside their shared quota column');
          if (item.kind === 'codex' || item.kind === 'grok') {
            assert.equal(quota.timingHidden, false, `Reset timing remains visible for ${item.kind}`);
            assert.match(quota.timingText, /重置/, `Existing reset timing is preserved for ${item.kind}`);
          } else {
            assert.doesNotMatch(quota.timingText + quota.timingTitle, /重置|刷新次数/, `Other subscriptions do not display reset timing or a reset tooltip: ${item.kind}`);
            const nativeWindow = account.usage.windows.find(window => window.id === quota.id); assert.ok(nativeWindow);
            if (nativeWindow.expiresAt || account.usage.summary) assert.match(quota.timingText, /到期/, 'Independent grant expiry remains visible');
            else { assert.equal(quota.timingText, ''); assert.equal(quota.timingTitle, ''); assert.equal(quota.timingHidden, true, 'An empty timing cell preserves layout without an accessible unknown reset label'); }
          }
          if (item.kind === 'jetbrains-central') {
            assert.equal(quota.text, '3,074,611.8 / 3,500,000 AI Credits', 'The large official-style JetBrains balance retains its exact visible amount');
            if (width >= 1400) assert.equal(quota.clipped, false, 'Wide layouts show the full large JetBrains amount without ellipsis');
            else assert.equal(quota.title, quota.text, 'Narrow layouts retain the full large amount in the native title and account details');
          }
        }
      }
      unifiedLayouts.push({ theme, requestedWidth: width, layout });
      await capture(`unified-all-five-${theme}-${width}`);
    }
    for (const id of unifiedIds) {
      await click(`[data-auth-account="${id}"] [data-action="account-menu"]`);
      await waitFor(`!!document.querySelector('[data-auth-account-menu="${id}"]')`, 'common ellipsis menu opens');
      const account = (await accounts()).find(item => item.providerId === id)!;
      const action = account.source === 'relay' ? 'relay-account-details' : 'account-details';
      assert.ok(await evaluate<boolean>(`!!document.querySelector('[data-auth-account-menu="${id}"] [data-action="${action}"]')`), 'Every account keeps its details action reachable');
      await click(`[data-auth-account-menu="${id}"] [data-action="${action}"]`);
      const detailsText = await evaluate<string>(`document.querySelector('[data-auth-account-details="${id}"]').textContent`);
      if (account.kind === 'codex' || account.kind === 'grok') assert.match(detailsText, /重置/, 'The supported subscriptions retain reset timing in details');
      else {
        assert.doesNotMatch(detailsText, /重置|刷新次数/, 'Unsupported reset labels and counts remain absent in account details');
        assert.equal(await evaluate<number>(`document.querySelectorAll('[data-auth-account="${id}"] [data-reset-credits],[data-auth-account="${id}"] [data-reset-expiries]').length`), 0, 'No reset-count controls are added to other subscriptions');
        if (account.kind === 'jetbrains-central') assert.ok(detailsText.includes('许可证有效期') && detailsText.includes(account.license!.expiresAt!), 'License expiry remains distinct and readable');
      }
      await closeDialog();
      if (account.source === 'relay') {
        await click(`[data-auth-account="${id}"] [data-action="account-menu"]`);
        await click(`[data-auth-account-menu="${id}"] [data-action="manage-auth-relay"]`);
        await waitFor(`document.querySelector('[role="dialog"] #modal-title')?.textContent==='编辑供应商'`, 'relay settings remain reachable through the common menu');
        assert.equal(await evaluate<string>(`document.querySelector('[role="dialog"] input[placeholder="给这个服务或账号取一个名称"]').value`), store.getProvider(id)!.name, 'Account settings open the exact selected provider');
        await capture(`unified-settings-${account.kind}`); await closeDialog();
      }
    }
  }
  async function privacy(): Promise<void> {
    const view = await evaluate<string>(`(async()=>JSON.stringify({body:document.body.innerText,inputs:[...document.querySelectorAll('input,textarea')].map(input=>input.value),accounts:await window.modelDock.authAccounts(),snapshot:await window.modelDock.snapshot(),diagnostics:await window.modelDock.queryDiagnostics({limit:200})}))()`);
    for (const secret of [managedKey, manualKey, 'PRIVATE_RELAY_QUOTA_TOKEN_RAW_BODY', 'PRIVATE_JETBRAINS_IDE', 'SYNTHETIC_COPILOT_QUOTA_TOKEN', ...oauthFixtureTokens]) assert.equal(view.includes(secret), false, 'Private account credentials and raw quota bodies never enter renderer views or diagnostics');
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
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(row)}+' [data-relay-quota-account]').textContent.includes('反代当前账号 A')`), true, 'The row shows the verified current account identity');
    await openDetails(managed.id);
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-auth-account-details="${managed.id}"]').textContent.includes('反代当前账号 A')&&document.querySelector('[data-auth-account-details="${managed.id}"] [data-relay-client-source]').textContent.includes('最初导入账号 X')`), true, 'Current identity and import provenance remain distinct and accessible in details');
    await closeDialog();
    const manualAccount = (await accounts()).find(item => item.providerId === manual.id); assert.ok(manualAccount); assert.equal(manualAccount.canQueryUsage, false);
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(manualRow)}+' [data-action="refresh-account-quota"]')?.disabled`), true, 'Manual relays keep the common action anchor disabled');
    await evaluate(`document.querySelector(${JSON.stringify(manualRow)}+' [data-action="refresh-account-quota"]').click()`);
    assert.equal(store.getManagedState(`auth-usage:${manual.id}`, null), null, 'A disabled manual refresh never starts a quota query');
    const rejected = await evaluate<string>(`window.modelDock.refreshAccountUsage(${JSON.stringify(manual.id)}).then(()=>'',error=>error.message)`);
    assert.ok(rejected); assert.doesNotMatch(rejected, /PRIVATE_/); assert.equal(rejected.includes(managedKey), false); assert.equal(store.getManagedState(`auth-usage:${manual.id}`, null), null);
    await addUnifiedFixtures();
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
    assert.equal(many.usage.windows.filter(window => window.resetAt).length, 20, 'Presentation does not remove the original upstream reset timestamps');
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
        assert.doesNotMatch(item.text, /重置|刷新次数/, 'TRAE quota details omit both known and unknown reset labels');
      }
      assert.ok(values[0].text.includes('0 / 1,000 积分')); assert.ok(values[1].text.includes('未知')); assert.ok(!values[1].text.includes('0%')); assert.ok(values[2].text.includes('不限量'));
      assert.ok(values[39].text.includes('664 / 1,039 次'), 'The final independent amount is preserved');
      assert.equal(await evaluate<number>(`document.querySelectorAll(${JSON.stringify(details)}+' [data-quota-detail-timing]').length`), 0, 'TRAE detail rows without expiry omit empty timing separators');
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
    await inspectUnifiedRows();
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
    await openDetails(managed.id);
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
    await openDetails(managed.id);
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
    writeFileSync(join(outputDir, 'relay-quota-validation.json'), JSON.stringify({ ok: true, themes: ['light', 'dark'], widths: [1920, 1180, 980], allFiveAccountFamiliesShareColumns: true, resetTimingOnlyForCodexAndGrok: true, otherSubscriptionResetLabelsAndCountsHidden: true, quotaQueryActionsAndAgePreserved: true, upstreamResetDataUnchanged: true, grantAndLicenseExpiryPreserved: true, percentAndAmountQuotaColumnsAlign: true, allFiveCommonActionMenusWork: true, relaySettingsRemainAccessibleFromMenu: true, unifiedLayouts, knownProAndUnknownPlanBadgesVerified: true, managedTraeAutoRefresh: true, managedTraeManualRefresh: true, manualRelayNotQueried: true, officialAmountsAndUnitsShown: true, manyQuotasStayCollapsedAndBounded: true, allFortyIndependentQuotaDetailsAccessible: true, zeroUnknownAndUnlimitedRemainDistinct: true, detailsScrollWithoutHorizontalOverflow: true, shrinkingResultsRemoveExpandAction: true, officialRawGrantParserMatches1813_80: true, officialSourceGroupsPreserve19CheckinsAndMonthly500: true, allTwentyCreditGrantsPreserved: true, grantExpiryNeverPresentedAsReset: true, officialDefaultUsageExplained: true, existingDetailsActionUsesGrants: true, unknownGrantPropagatesWithoutMislabelingKnownLimits: true, currentAccountSeparateFromImportProvenance: true, accountSwitchClearsPreviousIdentity: true, unknownQuotaHasNoInventedPercent: true, failuresClearPreviousBalances: true, jetBrainsGuideDoesNotQueryCentralUntilExplicitCheck: true, privacyVerified: true, configurationsUnchanged: true, noRealRelayOrClientAccess: true, stages, screenshots }, null, 2));
  } finally {
    store.setManagedState('qa-relay-quota-mode', 'unavailable'); store.setManagedState('qa-relay-client-import-stage', 'empty');
    store.setManagedState('qa-jetbrains-ide-mode', 'empty');
    store.setManagedState('qa-unified-auth-layout', false);
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
