import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';
import { revealSmokeNavigationTarget } from './smoke-navigation';
import { JETBRAINS_RELAY_BASE_URL, TRAE_RELAY_BASE_URL, providerCategory } from '../shared/presets';

/** Subscription-relay presentation checks use only this fresh synthetic QA profile. */
export async function verifyRelaySubscriptions(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const profile = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(profile && !profile.startsWith('..') && !/^[A-Za-z]:/.test(profile), 'Relay UI fixtures require the isolated smoke profile');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const traeKey = 'synthetic-trae-relay-key', jetBrainsKey = 'synthetic-jetbrains-relay-key';
  // These retain the existing persisted protocol kind. No account migration,
  // relay startup, account login, or external client configuration is involved.
  const trae = store.saveProvider({ name: '旧 TRAE 中国版反代', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: TRAE_RELAY_BASE_URL, enabled: true, apiKey: traeKey });
  const jetBrains = store.saveProvider({ name: '旧 JetBrains AI 会员反代', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, enabled: true, apiKey: jetBrainsKey });
  const relays = [trae, jetBrains];
  const relayModel = store.saveModel({ providerId: trae.id, upstreamId: 'synthetic-trae-model', alias: 'synthetic-trae-model', displayName: '反代模型保存验证', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
  const junie = store.listBindings().find(binding => binding.id === 'junie');
  assert.ok(junie, 'Junie binding is available in the synthetic fixture');
  store.saveBinding({ ...junie, enabled: true, mode: 'aggregate', providerIds: [trae.id], modelIds: [relayModel.id], modelSelection: 'selected', defaultModelId: relayModel.id });
  const originalProviders = store.listProviders(), originalModels = store.listModels(), originalBindings = store.listBindings(), originalSecrets = relays.map(provider => store.getSecret(provider.id));
  const size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const originalTheme = await evaluate<{ theme?: string; colorScheme: string }>(`({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})`);
  const screenshots: string[] = [], categories: Record<string, string[]> = {}, accountRefreshMs: number[] = [];
  async function waitFor(source: string, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(30); }
    writeFileSync(join(outputDir, 'relay-subscriptions-timeout.png'), await captureUi());
    throw new Error(`Relay subscriptions UI timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await revealSmokeNavigationTarget(window, selector);
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function closeDialog(): Promise<void> {
    await click('[aria-label="关闭对话框"]');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'dialog closed');
  }
  async function capture(name: string): Promise<void> {
    const privacy = await evaluate<boolean>(`(()=>{const secrets=${JSON.stringify([traeKey, jetBrainsKey])};return !secrets.some(secret=>document.body.innerText.includes(secret))&&[...document.querySelectorAll('input[type="text"],input:not([type])')].every(input=>!secrets.includes(input.value))})()`);
    assert.equal(privacy, true, 'No relay credentials appear in UI screenshots');
    const layout = await evaluate<{ overflow: boolean; dialogOverflow: boolean }>(`(()=>{const modal=document.querySelector('[role="dialog"]');return {overflow:document.documentElement.scrollWidth>innerWidth+1,dialogOverflow:!!modal&&modal.scrollWidth>modal.clientWidth+1}})()`);
    assert.deepEqual(layout, { overflow: false, dialogOverflow: false }, 'Relay presentation fits the viewport');
    const filename = `relay-subscriptions-${name}.png`;
    writeFileSync(join(outputDir, filename), await captureUi()); screenshots.push(filename);
  }
  try {
    window.setMinimumSize(780, 580); window.setSize(1100, 800);
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('.sidebar [data-source-id="${jetBrains.id}"]')`, 'old relay records loaded');
    for (const theme of ['light', 'dark']) {
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}})()`);
      await click('[data-action="add-api-provider"]');
      await waitFor(`document.querySelector('[role="dialog"] #modal-title')?.textContent==='添加 API 供应商'`, 'API dialog');
      const apiPresets = await evaluate<string[]>(`[...document.querySelectorAll('[role="dialog"] [data-preset-id]')].map(item=>item.dataset.presetId)`);
      for (const relay of relays) assert.equal(apiPresets.includes(relay.presetId!), false, 'API dialog excludes subscription relays');
      assert.ok(apiPresets.includes('custom') && apiPresets.includes('deepseek'), 'Normal API presets remain available');
      await capture(`api-${theme}`); await closeDialog();
      await click('.sidebar [data-page="auth"]');
      await click('[data-action="add-subscription-provider"]');
      await waitFor(`document.querySelector('[role="dialog"] #modal-title')?.textContent==='添加订阅供应商'`, 'subscription dialog');
      const subscriptionPresets = await evaluate<string[]>(`[...document.querySelectorAll('[role="dialog"] [data-preset-id]')].map(item=>item.dataset.presetId)`);
      for (const relay of relays) {
        assert.equal(subscriptionPresets.includes(relay.presetId!), true, 'Subscription dialog includes both relay choices');
        await click(`[role="dialog"] [data-preset-id="${relay.presetId}"]`);
        await waitFor(`document.querySelector('[role="dialog"] [data-preset-id="${relay.presetId}"]')?.classList.contains('selected')===true`, 'relay preset selected');
        assert.equal(await evaluate<string>(`document.querySelector('[role="dialog"] #modal-title').textContent`), '添加订阅供应商', 'Selecting an OpenAI-compatible relay preserves the subscription dialog');
        assert.equal(await evaluate<boolean>(`document.querySelector('[role="dialog"] .preset-picker')?.classList.contains('subscription-presets')===true`), true);
        await capture(`${relay.presetId}-${theme}`);
      }
      await closeDialog();
      await click('.sidebar [data-page="auth"]');
      for (const relay of relays) await waitFor(`!!document.querySelector('[data-auth-kind="${relay.presetId}"] [data-auth-account="${relay.id}"][data-auth-relay="${relay.presetId}"]')`, 'relay visible in its authorization center group');
      const accounts = await evaluate<unknown>('window.modelDock.authAccounts()');
      assert.equal([traeKey, jetBrainsKey].some(key => JSON.stringify(accounts).includes(key)), false, 'Account views never expose relay credentials');
      for (const relay of relays) assert.equal(await evaluate<boolean>(`document.querySelector('[data-auth-account="${relay.id}"]').textContent.includes('已授权')`), false, 'Saved local relay keys do not imply upstream authorization');
      await capture(`auth-${theme}`);
      for (const relay of relays) {
        await click(`[data-auth-account="${relay.id}"] [data-action="manage-auth-relay"]`);
        await waitFor(`document.querySelector('[role="dialog"] #modal-title')?.textContent==='编辑供应商'&&document.querySelector('[role="dialog"] [data-preset-id="${relay.presetId}"]')?.classList.contains('selected')===true`, 'authorization center opens matching relay settings');
        assert.equal(await evaluate<boolean>(`document.querySelector('[role="dialog"] .preset-picker')?.classList.contains('subscription-presets')===true`), true);
        await closeDialog();
      }
    }
    // Save an existing manual relay from the authorization center itself. The
    // new name must appear while that page stays mounted, without its 5s global
    // polling interval or a navigation round-trip. Restore the original name
    // through the same UI so later preservation comparisons remain exact.
    const renamed = 'TRAE 反代 · 保存后即时刷新';
    for (const name of [renamed, trae.name]) {
      await click(`[data-auth-account="${trae.id}"] [data-action="manage-auth-relay"]`);
      await waitFor(`!!document.querySelector('[role="dialog"] [data-trae-relay-mode="manual"]')`, 'existing manual TRAE relay editor');
      await evaluate(`(()=>{const input=document.querySelector('[role="dialog"] input[required][maxlength="80"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      const savedAt = Date.now();
      await click('[role="dialog"] button[type="submit"]');
      await waitFor(`!document.querySelector('[role="dialog"]')&&document.querySelector('[data-auth-account="${trae.id}"] .account-identity strong')?.textContent===${JSON.stringify(name)}&&document.querySelector('.sidebar [data-page="auth"]')?.getAttribute('aria-current')==='page'`, 'saved relay is immediately refreshed in the open authorization center', 2000);
      const elapsed = Date.now() - savedAt;
      assert.ok(elapsed < 2000, 'Authorization center updates within 2 seconds of saving its relay'); accountRefreshMs.push(elapsed);
      assert.deepEqual(relays.map(provider => store.getSecret(provider.id)), originalSecrets, 'Saving the name preserves existing relay credentials');
      assert.deepEqual(store.listModels(), originalModels, 'Saving the relay preserves its existing model');
      assert.deepEqual(store.listBindings(), originalBindings, 'Saving the relay preserves the Junie model binding');
      if (name === renamed) await capture('auth-saved-refresh-dark');
    }
    for (const category of ['api', 'subscription']) {
      const expected = originalProviders.filter(provider => providerCategory(provider) === category).map(provider => provider.id);
      await waitFor(`document.querySelectorAll('.sidebar [data-sidebar-provider-category="${category}"] [data-source-id]').length===${expected.length}`, `${category} sidebar group rendered`);
      categories[category] = await evaluate<string[]>(`[...document.querySelectorAll('.sidebar [data-sidebar-provider-category="${category}"] [data-source-id]')].map(item=>item.dataset.sourceId)`);
      assert.deepEqual(new Set(categories[category]), new Set(expected), 'Provider categories include existing records without rewriting their kind');
      for (const relay of relays) assert.equal(categories[category].includes(relay.id), category === 'subscription', 'Existing relays appear only under subscriptions');
    }
    assert.deepEqual(store.listProviders(), originalProviders, 'UI navigation and draft selection leave old providers unchanged');
    assert.deepEqual(store.listModels(), originalModels, 'Relay models remain unchanged');
    assert.deepEqual(store.listBindings(), originalBindings, 'No client bindings are written');
    assert.deepEqual(relays.map(provider => store.getSecret(provider.id)), originalSecrets, 'Opening relay management preserves credentials');
    writeFileSync(join(outputDir, 'relay-subscriptions-validation.json'), JSON.stringify({ ok: true, relays: relays.map(provider => provider.presetId), apiPresetsExcludeRelays: true, subscriptionPresetsIncludeRelays: true, subscriptionTitlePreserved: true, legacyRelaysClassifiedAsSubscriptions: true, authorizationCenterListsBothRelays: true, authorizationCenterManagementOpensMatchingEditor: true, authorizationCenterRefreshesAfterSaveWithoutNavigation: true, accountRefreshMs, localCredentialStateDoesNotClaimUpstreamAuthorization: true, relayKeysNotInAccountViews: true, noRelayStartupOrAccountLogin: true, providersUnchanged: true, relayModelsUnchanged: true, toolBindingsUnchanged: true, categories: Object.fromEntries(Object.entries(categories).map(([category, values]) => [category, values.length])), screenshots }, null, 2));
  } finally {
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
