import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, type BrowserWindow } from 'electron';
import type { Store } from './store';
import { JETBRAINS_RELAY_BASE_URL, TRAE_RELAY_BASE_URL, providerCategory } from '../shared/presets';

/** Real navigation/local-connection validation with an isolated synthetic client import. */
export async function verifyNavigationConsolidation(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const profile = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(profile && !profile.startsWith('..') && !/^[A-Za-z]:/.test(profile), 'Navigation fixtures require the isolated QA profile');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const apiProvider = store.saveProvider({ name: '导航 API 验证', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://navigation-fixture.invalid/v1', enabled: true, apiKey: 'synthetic-navigation-api-key' });
  const codex = store.saveProvider({ name: '导航 Codex 订阅', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(codex.id, { accessToken: 'synthetic-navigation-access', refreshToken: 'synthetic-navigation-refresh', expiresAt: Date.now() + 7_200_000 });
  const trae = store.saveProvider({ name: '导航 TRAE 订阅', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: 'synthetic-navigation-trae-key' });
  const central = store.saveProvider({ name: '导航 JetBrains 订阅', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, enabled: true, apiKey: 'synthetic-navigation-central-key' });
  const subscriptions = [codex, trae, central];
  const models = subscriptions.map((provider, index) => store.saveModel({ providerId: provider.id, upstreamId: `private-upstream-navigation-${index}`, alias: `local-navigation-model-${index}`, displayName: `本地调用模型 ${index + 1}`, wireApi: index ? 'chat-completions' : 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true }));
  store.addLog({ id: 'synthetic-navigation-request', time: new Date().toISOString(), alias: models[0].alias, providerName: codex.name, endpoint: '/v1/responses', status: 200, durationMs: 12 });
  const original = { providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), exposure: store.gatewayExposure(), secrets: subscriptions.map(provider => store.getSecret(provider.id)) };
  const size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const screenshots: string[] = [];
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'navigation-consolidation-timeout.png'), await captureUi());
    throw new Error(`Navigation consolidation timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function copied(selector: string, expected: string): Promise<void> {
    await clipboard.clear(); await click(selector);
    const deadline = Date.now() + 5000;
    while (await clipboard.readText() !== expected && Date.now() < deadline) await pause(25);
    assert.equal(await clipboard.readText(), expected, 'Copied subscription connection values belong to ModelDock local invocation'); await clipboard.clear();
  }
  async function capture(name: string): Promise<void> {
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    assert.equal(await evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth+1||document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth+1`), false, 'Consolidated pages fit the viewport');
    assert.doesNotMatch(await evaluate<string>('document.body.innerText'), /synthetic-navigation-(?:api-key|access|refresh|trae-key|central-key)|gho_SYNTHETIC_NAVIGATION_/, 'Screenshots never expose credentials');
    const filename = `navigation-consolidation-${name}.png`; writeFileSync(join(outputDir, filename), await captureUi()); screenshots.push(filename);
  }
  try {
    window.setMinimumSize(780, 580); window.setSize(1180, 800);
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('.sidebar [data-source-id="${central.id}"]')`, 'all synthetic sources loaded');
    assert.equal(await evaluate<number>(`document.querySelectorAll('.sidebar [data-source="aggregate"],.sidebar [data-action="add-subscription-provider"]').length`), 0, 'Sidebar contains grouped sources and no separate aggregate or subscription-add destination');
    for (const category of ['api', 'subscription']) {
      const expected = original.providers.filter(provider => providerCategory(provider) === category).map(provider => provider.id);
      const shown = await evaluate<string[]>(`[...document.querySelectorAll('.sidebar [data-sidebar-provider-category="${category}"] [data-source-id]')].map(item=>item.dataset.sourceId)`);
      assert.deepEqual(new Set(shown), new Set(expected), 'Sidebar groups preserve exact API/subscription membership');
      assert.equal(await evaluate<number>(`Number(document.querySelector('.sidebar [data-provider-category="${category}"] .nav-count').textContent)`), expected.length);
    }
    const gateway = await evaluate<{ running: boolean; baseUrl: string }>('window.modelDock.startGateway(0)'); assert.equal(gateway.running, true);
    await click('[aria-label="刷新本机配置"]');
    const catalog = async () => {
      const response = await fetch(`${gateway.baseUrl}/models`, { headers: { authorization: `Bearer ${store.gatewayKey()}` } });
      assert.equal(response.status, 200); return await response.json() as { data: { id: string }[] };
    };
    for (const model of models) assert.ok((await catalog()).data.some(entry => entry.id === model.alias), 'The real shared /v1 catalog advertises each published local subscription alias');
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      await click('.sidebar [data-page="service"]'); await click('[data-service-tab="interface"]');
      await waitFor(`!!document.querySelector('[data-aggregate-management]')&&!!document.querySelector('[data-gateway-panel]')`, 'local service and interface share one page');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-action="add-subscription-provider"]').length`), 0, 'Subscription addition is absent outside the authorization center');
      for (const category of ['api', 'subscription']) {
        const expected = original.providers.filter(provider => providerCategory(provider) === category).map(provider => provider.id);
        const shown = await evaluate<string[]>(`[...document.querySelectorAll('[data-aggregate-category="${category}"] [data-aggregate-provider]')].map(item=>item.dataset.aggregateProvider)`);
        assert.deepEqual(new Set(shown), new Set(expected), 'The local interface uses matching API/subscription sections');
      }
      assert.equal(await evaluate<number>(`document.querySelectorAll('.logs-panel').length`), 0, 'Request log content belongs to its own service tab');
      await capture(`interface-${theme}`);
      await click('[data-service-tab="logs"]');
      await waitFor(`!!document.querySelector('[data-log-id="synthetic-navigation-request"]')&&!!document.querySelector('[data-gateway-panel]')`, 'service controls stay available beside request logs');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-aggregate-management]').length`), 0);
      await capture(`logs-${theme}`);
      await click('.sidebar [data-page="auth"]');
      await waitFor(`!!document.querySelector('.auth-panel [data-action="add-subscription-provider"]')`, 'authorization center owns subscription addition');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-action="add-subscription-provider"]').length`), 1);
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-auth-import-account="copilot"]').length`), 1, 'Copilot exposes explicit client import');
      await click('[data-auth-import-account="copilot"]');
      await waitFor(`!!document.querySelector('[data-copilot-import] [data-copilot-import-empty]')`, 'isolated Copilot import has no real client candidates');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-copilot-import] [data-field="copilot-import-account"] option').length`), 0, 'The synthetic QA importer does not read the user actual accounts');
      await capture(`copilot-import-empty-${theme}`); await click('[aria-label="关闭对话框"]');
      await click('.auth-panel [data-action="add-subscription-provider"]');
      await waitFor(`document.querySelector('[role="dialog"] #modal-title')?.textContent==='添加订阅供应商'`, 'the authorized subscription entry opens its picker');
      await click('[aria-label="关闭对话框"]');
      for (const [index, provider] of subscriptions.entries()) {
        const model = models[index], scope = `[data-subscription-connection="${provider.id}"]`;
        await click(`.sidebar [data-source-id="${provider.id}"]`); await waitFor(`!!document.querySelector(${JSON.stringify(scope)})`, 'subscription local invocation details');
        await copied(`${scope} [aria-label="复制本地订阅接口 URL"]`, gateway.baseUrl);
        await copied(`${scope} [data-action="copy-key"]`, store.gatewayKey());
        await copied(`${scope} [data-subscription-model="${model.id}"] [data-action="copy-value"]`, model.alias);
        const ordinary = await evaluate<string>(`document.querySelector('.main-content').innerText`);
        assert.equal(ordinary.includes(provider.baseUrl) || ordinary.includes(model.upstreamId), false, 'Subscription details expose local call information, with upstream transport details kept in the explanation');
        assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(scope)}+' [data-local-model-status]').textContent`), '已发布');
        const example = await evaluate<string>(`document.querySelector(${JSON.stringify(scope)}+' [data-subscription-curl]').textContent`);
        assert.ok(example.includes(gateway.baseUrl) && example.includes(model.alias) && example.includes('${MODELDOCK_API_KEY}'));
        assert.ok(example.includes(model.wireApi === 'responses' ? '/responses' : '/chat/completions'), 'The example uses the model actual inference protocol');
        await capture(`${provider.presetId}-${theme}`);
      }
    }
    // The importer is explicitly pinned to dataDir/test-home and has OS vault
    // and gh execution disabled in the smoke build. The only candidates below
    // come from this new synthetic file; /user and Copilot quota use the fixed
    // authQuotaFixture identity rather than real network authorization.
    const clientDirectory = join(store.dataDir, 'test-home', '.copilot'), clientFile = join(clientDirectory, 'config.json');
    const clientConfig = JSON.stringify({ copilotTokens: { 'https://github.com:unselected-demo': 'gho_SYNTHETIC_NAVIGATION_UNSELECTED', 'https://github.com:quota-demo': 'gho_SYNTHETIC_NAVIGATION_SELECTED' }, unrelated: { preserve: true } }, null, 2);
    mkdirSync(clientDirectory, { recursive: true, mode: 0o700 }); writeFileSync(clientFile, clientConfig, { flag: 'wx', mode: 0o600 });
    try {
      await click('.sidebar [data-page="auth"]'); await click('[data-auth-import-account="copilot"]');
      await waitFor(`document.querySelectorAll('[data-copilot-import] [data-field="copilot-import-account"] option').length===2`, 'only synthetic client candidates are offered');
      await evaluate(`(()=>{const select=document.querySelector('[data-copilot-import] [data-field="copilot-import-account"]'),option=[...select.options].find(option=>option.textContent==='Copilot CLI · quota-demo');if(!option)throw new Error('Synthetic account option missing');select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await click('[data-action="import-copilot-client-account"]');
      await waitFor(`!document.querySelector('[data-copilot-import]')&&!!document.querySelector('[data-auth-account="copilot:424242"]')`, 'selected client account is imported and appears in authorization center');
      const imported = await evaluate<{ source?: string; authStatus: string; usage: { status: string; windows: { remainingPercent?: number }[] } }>(`window.modelDock.authAccounts().then(accounts=>accounts.find(account=>account.providerId==='copilot:424242'))`);
      assert.equal(imported.source, 'client-import'); assert.equal(imported.authStatus, 'ready'); assert.equal(imported.usage.status, 'ready');
      assert.equal(imported.usage.windows[0].remainingPercent, 82, 'The selected synthetic account is validated against the mock Copilot entitlement endpoint');
      assert.equal(JSON.stringify(imported).includes('gho_SYNTHETIC_NAVIGATION_'), false, 'Imported tokens never enter renderer-safe account views');
      assert.equal(readFileSync(clientFile, 'utf8'), clientConfig, 'Importing preserves the original client configuration exactly');
      await click('[data-auth-account="copilot:424242"] [data-action="account-menu"]'); await click('[role="menu"] [data-action="account-details"]');
      await waitFor(`document.querySelector('[data-auth-account-details="copilot:424242"]')?.textContent.includes('客户端导入')===true`, 'account details identify client import provenance');
      await capture('copilot-import-success-dark'); await click('[aria-label="关闭对话框"]');
      await evaluate(`window.modelDock.copilotLogoutAccount('copilot:424242')`);
    } finally { unlinkSync(clientFile); }
    await evaluate(`window.modelDock.setGatewayModelEnabled(${JSON.stringify(models[0].id)},false)`);
    await click('[aria-label="刷新本机配置"]'); await click(`.sidebar [data-source-id="${codex.id}"]`);
    await waitFor(`document.querySelector('[data-subscription-model="${models[0].id}"] [data-local-model-status]')?.textContent==='模型未发布'`, 'unpublished aliases are not described as callable');
    assert.equal((await catalog()).data.some(entry => entry.id === models[0].alias), false, 'Unpublished aliases are absent from the real local catalog');
    await evaluate(`window.modelDock.setGatewayModelEnabled(${JSON.stringify(models[0].id)},true)`);
    await click('.sidebar [data-page="settings"]');
    await waitFor(`!!document.querySelector('[data-connection-principles]')`, 'upstream explanation is available in settings');
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-connection-principles]').open`), false, 'Connection principles start collapsed');
    await click('[data-connection-principles] summary');
    for (const provider of subscriptions) {
      const row = await evaluate<string>(`document.querySelector('[data-principle-provider="${provider.id}"]').textContent`);
      assert.ok(row.includes(provider.baseUrl.replace(/\/$/, '')), 'Upstream addresses appear only in the explicit explanation');
    }
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-connection-model-mapping]').open`), false, 'Upstream model mapping is an explicit collapsed explanation');
    await click('[data-connection-model-mapping] summary');
    for (const model of models) {
      const mapping = await evaluate<string>(`document.querySelector('[data-principle-model="${model.id}"]').textContent`);
      assert.ok(mapping.includes(model.alias) && mapping.includes(model.upstreamId), 'The explicit explanation retains each original upstream model mapping');
    }
    await evaluate(`document.querySelector('[data-connection-principles]').scrollIntoView({block:'start'})`); await capture('principles-dark');
    assert.ok(apiProvider.id);
    assert.deepEqual({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), exposure: store.gatewayExposure(), secrets: subscriptions.map(provider => store.getSecret(provider.id)) }, original, 'Navigation, copying and reversible publish checks preserve providers, models, credentials and tool bindings');
    writeFileSync(join(outputDir, 'navigation-consolidation-validation.json'), JSON.stringify({ ok: true, sidebarApiSubscriptionGroups: true, subscriptionAdditionOnlyInAuthCenter: true, explicitCopilotClientImportAvailable: true, syntheticCopilotClientImportSucceeded: true, clientImportSelectionAndProvenanceVerified: true, clientSourceConfigurationUnchanged: true, serviceInterfaceAndLogsConsolidated: true, subscriptionLocalUrlKeyAliasesCopied: true, localCatalogIncludesPublishedAliases: true, unpublishedAliasStatusMatchesCatalog: true, curlUsesNativeProtocolAndKeyPlaceholder: true, upstreamDetailsOnlyInPrinciples: true, credentialsAndToolBindingsPreserved: true, noRealAccountImportLoginOrRelayStartup: true, screenshots }, null, 2));
  } finally {
    await clipboard.clear(); await evaluate('window.modelDock.stopGateway()');
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
