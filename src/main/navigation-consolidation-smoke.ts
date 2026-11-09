import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clipboard, ClipboardItem, type BrowserWindow } from 'electron';
import type { Store } from './store';
import { revealSmokeNavigationTarget } from './smoke-navigation';
import { JETBRAINS_RELAY_BASE_URL, TRAE_RELAY_BASE_URL, providerCategory } from '../shared/presets';
import { SUBSCRIPTION_NAMES } from '../shared/subscription-names';

/** Real navigation/local-connection validation with an isolated synthetic client import. */
export async function verifyNavigationConsolidation(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const profile = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(profile && !profile.startsWith('..') && !/^[A-Za-z]:/.test(profile), 'Navigation fixtures require the isolated QA profile');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const previousClipboard: ClipboardItem[] = [];
  for (const item of await clipboard.read()) {
    const entries: Record<string, Blob | Electron.ClipboardBookmark> = {};
    for (const type of item.types) {
      const value = await item.getType(type);
      entries[type] = value instanceof Blob ? new Blob([await value.arrayBuffer()], { type: value.type }) : { title: value.title, url: value.url };
    }
    if (Object.keys(entries).length) previousClipboard.push(new ClipboardItem(entries));
  }
  const apiProvider = store.saveProvider({ name: 'Grok Build 订阅', kind: 'openai-compatible', presetId: 'custom', baseUrl: 'https://navigation-fixture.invalid/v1', enabled: true, apiKey: 'synthetic-navigation-api-key' });
  const codex = store.saveProvider({ name: 'Codex · 客户端导入', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
  store.setSecret(codex.id, { accessToken: 'synthetic-navigation-access', refreshToken: 'synthetic-navigation-refresh', expiresAt: Date.now() + 7_200_000 });
  const trae = store.saveProvider({ name: 'TRAE 中国版 · 客户端导入', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: 'synthetic-navigation-trae-key' });
  const central = store.saveProvider({ name: 'JetBrains AI · IDE 导入', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, enabled: true, apiKey: 'synthetic-navigation-central-key' });
  const grok = store.saveProvider({ name: 'xAI / Grok 账号', kind: 'grok', presetId: 'grok-build', baseUrl: 'https://cli-chat-proxy.grok.com/v1', enabled: false });
  const copilot = store.saveProvider({ name: 'GitHub Copilot', kind: 'copilot', presetId: 'copilot-subscription', baseUrl: 'https://api.githubcopilot.com', enabled: false });
  const numbered = store.saveProvider({ name: 'ChatGPT / OpenAI 账号 2', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: false });
  const custom = store.saveProvider({ name: '我的 TRAE 中国版 · 客户端导入', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: 'http://127.0.0.1:19093/v1', enabled: false });
  const namingCases = [
    { provider: grok, expected: SUBSCRIPTION_NAMES.grok }, { provider: copilot, expected: SUBSCRIPTION_NAMES.copilot },
    { provider: codex, expected: SUBSCRIPTION_NAMES.codex }, { provider: trae, expected: SUBSCRIPTION_NAMES['trae-cn-relay'] },
    { provider: central, expected: SUBSCRIPTION_NAMES['jetbrains-central'] }, { provider: numbered, expected: SUBSCRIPTION_NAMES.codex + ' 2' },
    { provider: custom, expected: custom.name },
  ];
  const subscriptions = [codex, trae, central];
  const models = subscriptions.map((provider, index) => store.saveModel({ providerId: provider.id, upstreamId: `private-upstream-navigation-${index}`, alias: `local-navigation-model-${index}`, displayName: `本地调用模型 ${index + 1}`, wireApi: index ? 'chat-completions' : 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true }));
  store.addLog({ id: 'synthetic-navigation-request', time: new Date().toISOString(), alias: models[0].alias, providerName: codex.name, endpoint: '/v1/responses', status: 200, durationMs: 12 });
  const original = { providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), exposure: store.gatewayExposure(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) };
  const size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const screenshots: string[] = [];
  let observedAuthTitles: Record<string, string> = {};
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'navigation-consolidation-timeout.png'), await captureUi());
    throw new Error(`Navigation consolidation timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await revealSmokeNavigationTarget(window, selector);
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
    for (const { provider, expected } of namingCases) {
      const source = `.sidebar [data-source-id="${provider.id}"]`;
      const nav = await evaluate<{ title: string; label: string }>(`(()=>{const button=document.querySelector(${JSON.stringify(source)});return{title:button.title,label:button.querySelectorAll(':scope > span')[1].textContent}})()`);
      assert.deepEqual(nav, { title: expected, label: expected }, 'Exact historical defaults use the current display name; custom names remain unchanged');
      await click(source);
      await waitFor(`document.querySelector(${JSON.stringify(source)})?.getAttribute('aria-current')==='page'`, 'display alias keeps its original selected provider ID');
      assert.equal(await evaluate<string>(`document.querySelector('.breadcrumbs strong').textContent`), expected);
      assert.equal(await evaluate<string>(`document.querySelector('[data-provider-id="${provider.id}"] .provider-row-title h3').textContent`), expected);
      assert.equal(await evaluate<boolean>(`document.querySelector('[data-subscription-connection="${provider.id}"] .subscription-connection-note').textContent.includes(${JSON.stringify(expected)})`), true, 'Selected-provider explanation uses the same visible name');
      assert.deepEqual(store.getProvider(provider.id), original.providers.find(item => item.id === provider.id), 'Showing a modern name never mutates the stored provider');
    }
    assert.equal(await evaluate<string>(`document.querySelector('.sidebar [data-source-id="${apiProvider.id}"]').title`), apiProvider.name, 'An API supplier with a legacy subscription-like name remains unchanged');
    await capture('standard-subscription-names');
    window.setSize(980, 680);
    await evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'");
    await click(`.sidebar [data-source-id="${trae.id}"]`); await capture('standard-subscription-names-trae-dark-980');
    await click(`.sidebar [data-source-id="${custom.id}"]`); await capture('custom-subscription-name-dark-980');
    window.setSize(1180, 800);
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
      observedAuthTitles = await evaluate<Record<string, string>>(`Object.fromEntries(${JSON.stringify(Object.keys(SUBSCRIPTION_NAMES))}.map(kind=>{const heading=document.querySelector('[data-auth-kind="'+kind+'"] .account-group-header h2');return[kind,[...heading.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim()]}))`);
      assert.deepEqual(observedAuthTitles, SUBSCRIPTION_NAMES, 'Authorization-center title text matches all five standard names independently of decorative icons and counts');
      assert.equal(await evaluate<string>(`document.querySelector('[data-auth-account="${grok.id}"] .account-identity strong').textContent`), SUBSCRIPTION_NAMES.grok, 'The legacy Grok account default label is updated without changing its identity');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-action="add-subscription-provider"]').length`), 1);
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-auth-import-account="copilot"]').length`), 1, 'Copilot exposes explicit client import');
      await click('[data-auth-import-account="copilot"]');
      await waitFor(`!!document.querySelector('[data-copilot-import] [data-copilot-import-empty]')`, 'isolated Copilot import has no real client candidates');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-copilot-import] [data-field="copilot-import-account"] option').length`), 0, 'The synthetic QA importer does not read the user actual accounts');
      await capture(`copilot-import-empty-${theme}`); await click('[aria-label="关闭对话框"]');
      await click('.auth-panel [data-action="add-subscription-provider"]');
      await waitFor(`document.querySelector('[role="dialog"] #modal-title')?.textContent==='添加订阅供应商'`, 'the authorized subscription entry opens its picker');
      for (const { provider, expected } of namingCases.slice(0, 5)) assert.equal(await evaluate<string>(`document.querySelector('[role="dialog"] [data-preset-id="${provider.presetId}"] strong').textContent`), expected, 'New subscription preset labels match the existing source display names');
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
    assert.deepEqual({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), exposure: store.gatewayExposure(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) }, original, 'Navigation, copying and reversible publish checks preserve providers, models, credentials and tool bindings');
    await click('.sidebar [data-page="auth"]');
    for (const source of store.listProviders().filter(provider => provider.kind === 'grok')) {
      await click('[data-auth-account="' + source.id + '"] [data-action="account-menu"]');
      await click('[data-auth-account-menu="' + source.id + '"] [data-action="account-delete"]');
      await click('[role="dialog"] .modal-footer .primary');
      await waitFor(`!document.querySelector('[role="dialog"]') && !document.querySelector('.sidebar [data-source-id="${source.id}"]')`, 'confirmed removal clears the selected source');
      assert.equal(store.getProvider(source.id), undefined);
    }
    await waitFor(`!document.querySelector('[data-auth-kind="grok"]')`, 'the empty Grok group disappears');
    for (const preset of ['grok-build', 'opencode-go']) {
      await click('[data-action="add-subscription-provider"]');
      await click('[data-preset-id="' + preset + '"]');
      if (preset === 'opencode-go') {
        await capture('opencode-go-picker');
        await evaluate(`(()=>{const input=document.querySelector('[data-field="opencode-go-key"]');if(input.type!=='password')throw new Error('Unmasked key field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'synthetic-navigation-go-key');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      }
      await click('[role="dialog"] button[type="submit"]');
      await waitFor('!document.querySelector(\'[role="dialog"]\') && !!document.querySelector(\'[data-subscription-connection]\')', 'new subscription opens');
      const source = store.listProviders().find(provider => provider.presetId === preset); assert.ok(source);
      await click('.sidebar [data-page="auth"]');
      await waitFor('!!document.querySelector(\'[data-auth-kind="' + source.kind + '"]\')', 'added source appears in authorization center');
      if (preset === 'opencode-go') {
        await click('[data-auth-source="' + source.id + '"] [data-action="remove-local-source"]');
        await click('[data-action="confirm-delete"]');
        await waitFor('!document.querySelector(\'[data-auth-kind="opencode-go"]\') && !document.querySelector(\'.sidebar [data-source-id="' + source.id + '"]\')', 'OpenCode Go removal clears both views');
      } else assert.notEqual(source.id, grok.id);
    }
    writeFileSync(join(outputDir, 'navigation-consolidation-validation.json'), JSON.stringify({ ok: true, subscriptionRemovalAndReaddition: true, opencodeGoPickerAndRemoval: true, sidebarApiSubscriptionGroups: true, legacySubscriptionNamesStandardizedForDisplay: true, observedAuthTitles, numberedLegacyNamesRetainTheirSuffix: true, customAndApiNamesPreserved: true, selectedProviderHeaderAndDescriptionMatchSidebar: true, authGroupAndPresetNamesConsistent: true, rawProviderNamesAndRoutingIdsUnchanged: true, subscriptionAdditionOnlyInAuthCenter: true, explicitCopilotClientImportAvailable: true, syntheticCopilotClientImportSucceeded: true, clientImportSelectionAndProvenanceVerified: true, clientSourceConfigurationUnchanged: true, serviceInterfaceAndLogsConsolidated: true, subscriptionLocalUrlKeyAliasesCopied: true, localCatalogIncludesPublishedAliases: true, unpublishedAliasStatusMatchesCatalog: true, curlUsesNativeProtocolAndKeyPlaceholder: true, upstreamDetailsOnlyInPrinciples: true, credentialsAndToolBindingsPreserved: true, noRealAccountImportLoginOrRelayStartup: true, screenshots }, null, 2));
  } finally {
    clipboard.clear();
    if (previousClipboard.length) await clipboard.write(previousClipboard);
    await evaluate('window.modelDock.stopGateway()');
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
