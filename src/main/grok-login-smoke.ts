import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Store } from './store';
import type { AuthProgress, Provider, Snapshot } from '../shared/types';
import type { AuthAccount } from '../shared/auth-types';
import type { SettingsSnapshot } from '../shared/settings-types';

/** Mock-only native Grok UI lifecycle regression. No client files or tokens are read. */
export async function verifyGrokLogin(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream, 'Grok login smoke requires explicit fixture isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1', 'Grok login smoke must use only the synthetic authorization transport');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const fixturePath = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !/^[A-Za-z]:/.test(fixturePath), 'Grok smoke database must be below the fixture directory');
  const loopback = new URL(upstream);
  assert.equal(loopback.protocol, 'http:'); assert.equal(loopback.hostname, '127.0.0.1');
  assert.ok(loopback.port && !loopback.username && !loopback.password && !loopback.search && !loopback.hash);
  const originalMode = process.env.MODELDOCK_SMOKE_GROK_MODE;
  const originalPolls = process.env.MODELDOCK_SMOKE_GROK_POLLS;
  const providers: Provider[] = [];
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string, timeoutMs = 7000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await pause(25);
    }
    throw new Error(`Grok login smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(button.disabled)throw new Error('Grok login control disabled');button.click()})()`);
  }
  async function newProvider(name: string): Promise<Provider> {
    const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name, kind: 'grok', presetId: 'grok-build', baseUrl: 'https://cli-chat-proxy.grok.com/v1', enabled: true })})`);
    assert.equal(provider.hasSecret, false); assert.equal(provider.authStatus, 'missing'); providers.push(provider);
    await click('[aria-label="刷新本机配置"]');
    await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'synthetic Grok source refreshed');
    await click(`[data-source-id="${provider.id}"]`);
    return provider;
  }
  async function begin(provider: Provider): Promise<void> {
    await click(`article[data-provider-id="${provider.id}"] [aria-label="登录 ${provider.name}"]`);
  }
  async function progress(provider: Provider): Promise<AuthProgress> {
    const result = await evaluate<AuthProgress | null>(`window.modelDock.authProgress(${JSON.stringify(provider.id)})`);
    assert.ok(result, 'Mock login must have a progress record');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|accessToken|refreshToken|access_token|refresh_token|error_description|MOCK_ACCESS|MOCK_REFRESH/);
    return result;
  }
  async function modalLayout() {
    return evaluate<{ dialogInside: boolean; footerVisible: boolean; horizontalOverflow: boolean }>(`(()=>{
      const dialog=document.querySelector('[role="dialog"]'),body=dialog.querySelector('.auth-body'),footer=dialog.querySelector('.modal-footer'),bounds=dialog.getBoundingClientRect(),end=footer.getBoundingClientRect();
      return {dialogInside:bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth+1&&bounds.bottom<=innerHeight+1,footerVisible:end.top>=0&&end.bottom<=innerHeight+1,horizontalOverflow:body.scrollWidth>body.clientWidth+1};
    })()`);
  }
  async function assertLayout() {
    const result = await modalLayout();
    assert.equal(result.dialogInside, true); assert.equal(result.footerVisible, true); assert.equal(result.horizontalOverflow, false);
    return result;
  }
  async function assertNoCredentials(provider: Provider, authStatus: Provider['authStatus']): Promise<void> {
    const stored = store.getProvider(provider.id); assert.ok(stored);
    assert.equal(stored.hasSecret, false); assert.equal(stored.authStatus, authStatus);
    assert.equal(store.listModels().filter(model => model.providerId === provider.id).length, 0);
    const account = await evaluate<AuthAccount | undefined>(`window.modelDock.authAccounts().then(accounts=>accounts.find(account=>account.providerId===${JSON.stringify(provider.id)}))`);
    // The authorization center lists unconfigured subscription sources too;
    // their rows must remain uncredentialed rather than disappear entirely.
    assert.ok(account); assert.equal(account.authStatus, authStatus); assert.equal(account.canRefresh, false);
    assert.equal(account.accountId, undefined); assert.equal(account.email, undefined); assert.equal(account.expiresAt, undefined);
  }
  function nativeClick(x: number, y: number): void {
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }
  async function verifyNetworkSettings(): Promise<void> {
    const proxySelector = '[aria-label="应用网络代理地址"]';
    const saveSelector = '[data-action="save-network-proxy"]';
    const probeSelector = '[data-action="probe-auth-network"]';
    await click('[data-page="settings"]');
    await waitFor(`!!document.querySelector(${JSON.stringify(proxySelector)})`, 'application proxy setting available');
    async function setProxyDraft(value: string): Promise<void> {
      await evaluate(`(()=>{
        const input=document.querySelector(${JSON.stringify(proxySelector)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await waitFor(`document.querySelector(${JSON.stringify(proxySelector)})?.value===${JSON.stringify(value)}&&!document.querySelector(${JSON.stringify(saveSelector)}).disabled`, 'edited proxy can be saved');
    }
    async function waitForSaved(value: string, label: string): Promise<SettingsSnapshot> {
      // Let the click's React updates commit before inspecting enabled controls.
      // Persistence and cleared pending state, rather than a disabled same-value
      // button, establish that the UI completed its native save operation.
      await pause(75);
      await waitFor(`(async()=>{
        const saved=await window.modelDock.getSettings(),input=document.querySelector(${JSON.stringify(proxySelector)}),button=document.querySelector(${JSON.stringify(saveSelector)});
        return saved.settings.proxyUrl===${JSON.stringify(value)}&&input?.value===${JSON.stringify(value)}&&!input.disabled&&!button.disabled&&!document.querySelector('.settings-panel .settings-note[role="status"]');
      })()`, label);
      return evaluate<SettingsSnapshot>('window.modelDock.getSettings()');
    }
    async function observeProbe() {
      return evaluate<{ ok: boolean; route: string; errorCode: string; statusCode: number | undefined; durationMs: number; text: string }>(`(()=>{
        const diagnostic=document.querySelector('[data-network-diagnostic]');
        return {ok:diagnostic.dataset.ok==='true',route:diagnostic.dataset.networkRoute??'',errorCode:diagnostic.dataset.errorCode??'',statusCode:diagnostic.dataset.statusCode?Number(diagnostic.dataset.statusCode):undefined,durationMs:Number(diagnostic.dataset.durationMs),text:diagnostic.textContent??''};
      })()`);
    }
    const initial = await evaluate<SettingsSnapshot>('window.modelDock.getSettings()');
    assert.equal(initial.settings.proxyUrl, '', 'Fresh smoke settings must use the system network by default');
    const syntheticProxy = 'http://127.0.0.1:19999';
    await setProxyDraft(syntheticProxy); await click(saveSelector);
    const saved = await waitForSaved(syntheticProxy, 'loopback proxy saved to native settings');
    assert.equal(saved.settings.proxyUrl, syntheticProxy);
    // Reapplying the saved value is an intentional recovery operation.
    assert.equal(await evaluate<boolean>(`!document.querySelector(${JSON.stringify(saveSelector)}).disabled`), true, 'Saved proxy must remain available for explicit reapplication');
    await click(saveSelector);
    const reapplied = await waitForSaved(syntheticProxy, 'same-value proxy successfully reapplied');
    assert.equal(reapplied.settings.proxyUrl, syntheticProxy);
    await click(probeSelector);
    await waitFor(`document.querySelector('[data-network-diagnostic]')?.dataset.ok==='true'&&document.querySelector('[data-network-diagnostic]')?.dataset.networkRoute==='proxy'&&!document.querySelector(${JSON.stringify(probeSelector)}).disabled`, 'safe authorization network diagnostic uses the application proxy');
    const successfulProbe = await observeProbe();
    assert.equal(successfulProbe.ok, true); assert.equal(successfulProbe.route, 'proxy'); assert.equal(successfulProbe.statusCode, 200);
    assert.equal(successfulProbe.errorCode, ''); assert.ok(Number.isFinite(successfulProbe.durationMs) && successfulProbe.durationMs >= 0);
    assert.doesNotMatch(successfulProbe.text, /PRIVATE_|access_token|refresh_token|error_description|MOCK_ACCESS|MOCK_REFRESH/);
    const layouts: unknown[] = [];
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await waitFor(width > 1100 ? 'innerWidth>1100' : 'innerWidth<1100', 'application proxy setting viewport');
      await evaluate(`document.querySelector(${JSON.stringify(proxySelector)}).closest('.settings-section').scrollIntoView({block:'center',behavior:'instant'})`);
      await pause(100);
      const layout = await evaluate<{ headingVisible: boolean; inputVisible: boolean; saveVisible: boolean; probeVisible: boolean; diagnosticVisible: boolean; sectionOverflow: boolean; mainOverflow: boolean; documentOverflow: boolean; value: string }>(`(()=>{
        const input=document.querySelector(${JSON.stringify(proxySelector)}),button=document.querySelector(${JSON.stringify(saveSelector)}),probe=document.querySelector(${JSON.stringify(probeSelector)}),diagnostic=document.querySelector('[data-network-diagnostic]'),section=input.closest('.settings-section'),heading=section.querySelector('.settings-heading'),main=document.querySelector('.main-content');
        const inside=element=>{const bounds=element.getBoundingClientRect();return bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth+1&&bounds.bottom<=innerHeight+1;};
        return {headingVisible:inside(heading),inputVisible:inside(input),saveVisible:inside(button),probeVisible:inside(probe),diagnosticVisible:inside(diagnostic),sectionOverflow:section.scrollWidth>section.clientWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,value:input.value};
      })()`);
      assert.equal(layout.headingVisible, true); assert.equal(layout.inputVisible, true); assert.equal(layout.saveVisible, true);
      assert.equal(layout.probeVisible, true); assert.equal(layout.diagnosticVisible, true);
      assert.equal(layout.sectionOverflow, false); assert.equal(layout.mainOverflow, false); assert.equal(layout.documentOverflow, false); assert.equal(layout.value, syntheticProxy);
      layouts.push({ width, ...layout });
      writeFileSync(join(outputDir, `electron-settings-network-proxy-${width}.png`), await captureUi());
    }
    // The transport is still synthetic. Only the known Chromium error code may
    // reach the diagnostic; neither a real OAuth request nor a secret is used.
    process.env.MODELDOCK_SMOKE_GROK_MODE = 'network-error';
    await click(probeSelector);
    await waitFor(`document.querySelector('[data-network-diagnostic]')?.dataset.ok==='false'&&document.querySelector('[data-network-diagnostic]')?.dataset.errorCode==='ERR_CONNECTION_RESET'&&!document.querySelector(${JSON.stringify(probeSelector)}).disabled`, 'safe reset diagnostic replaces the preceding success');
    const failedProbe = await observeProbe();
    assert.equal(failedProbe.ok, false); assert.equal(failedProbe.route, 'proxy'); assert.equal(failedProbe.errorCode, 'ERR_CONNECTION_RESET');
    assert.ok(Number.isFinite(failedProbe.durationMs) && failedProbe.durationMs >= 0);
    assert.doesNotMatch(failedProbe.text, /PRIVATE_|access_token|refresh_token|error_description|MOCK_ACCESS|MOCK_REFRESH/);
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await waitFor(width > 1100 ? 'innerWidth>1100' : 'innerWidth<1100', 'network failure diagnostic viewport');
      await evaluate(`document.querySelector('[data-network-diagnostic]').closest('.settings-section').scrollIntoView({block:'center',behavior:'instant'})`);
      await pause(75);
      const visible = await evaluate<boolean>(`(()=>{
        const diagnostic=document.querySelector('[data-network-diagnostic]'),bounds=diagnostic.getBoundingClientRect(),main=document.querySelector('.main-content');
        return bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth+1&&bounds.bottom<=innerHeight+1&&diagnostic.scrollWidth<=diagnostic.clientWidth+1&&main.scrollWidth<=main.clientWidth+1;
      })()`);
      assert.equal(visible, true, 'Failed network diagnostic must remain visible without horizontal overflow');
      writeFileSync(join(outputDir, `electron-settings-network-error-${width}.png`), await captureUi());
    }
    if (originalMode === undefined) delete process.env.MODELDOCK_SMOKE_GROK_MODE; else process.env.MODELDOCK_SMOKE_GROK_MODE = originalMode;
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    await setProxyDraft('http://example.test:19999'); await click(saveSelector);
    await waitFor(`Array.from(document.querySelectorAll('.toast.error')).some(toast=>toast.textContent.includes('代理地址格式无效'))`, 'non-loopback proxy rejected in settings UI');
    const afterRejected = await evaluate<SettingsSnapshot>('window.modelDock.getSettings()');
    assert.equal(afterRejected.settings.proxyUrl, syntheticProxy, 'Rejected proxy must preserve the previous saved setting');
    await waitFor(`!document.querySelector(${JSON.stringify(proxySelector)}).disabled`, 'invalid-save pending state cleared');
    await setProxyDraft(''); await click(saveSelector);
    const reset = await waitForSaved('', 'empty setting restores system networking');
    assert.equal(reset.settings.proxyUrl, '', 'Mock authorization must start only after the application proxy has been reset to system mode');
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    writeFileSync(join(outputDir, 'network-settings-ui-validation.json'), JSON.stringify({ savedProxy: saved.settings.proxyUrl, sameValueReapplied: reapplied.settings.proxyUrl === syntheticProxy, successfulProbe, failedProbe, remoteProxyRejected: true, savedProxyAfterRejected: afterRejected.settings.proxyUrl, restoredSystem: reset.settings.proxyUrl === '', layouts, changedSystemProxy: false, readRealProxyConfiguration: false, checkedRealProxyConnectivity: false, probeTransport: 'mock-only' }, null, 2));
  }
  try {
    const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
    assert.equal(resolve(snapshot.dataDir), resolve(dataDir), 'Grok renderer must use the fixture database');
    await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'previous dialogs closed');
    await verifyNetworkSettings();
    const preparingProvider = await newProvider('Grok 连接准备回归测试');
    const preparing: unknown[] = [];
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      process.env.MODELDOCK_SMOKE_GROK_MODE = 'delayed'; process.env.MODELDOCK_SMOKE_GROK_POLLS = '0';
      window.setSize(width, height); await waitFor(width > 1100 ? 'innerWidth>1100' : 'innerWidth<1100', 'preparing login viewport');
      const started = Date.now(); await begin(preparingProvider); await pause(100);
      const firstFrame = await evaluate<{ visible: boolean; stage: string; code: boolean; link: boolean; cancelEnabled: boolean; text: string }>(`(()=>{
        const body=document.querySelector('.auth-body'),button=document.querySelector('.modal-footer .button.secondary');
        return {visible:!!body,stage:body?.dataset.authStage??'',code:!!body?.querySelector('[data-auth-code]'),link:!!body?.querySelector('[data-action="auth-open-verification"]'),cancelEnabled:!!button&&!button.disabled&&button.textContent.includes('取消登录'),text:body?.textContent??''};
      })()`);
      const firstFrameElapsedMs = Date.now() - started;
      assert.equal(firstFrame.visible, true, 'Preparing login must render before discovery finishes');
      assert.equal(firstFrame.stage, 'discovery'); assert.equal(firstFrame.code, false); assert.equal(firstFrame.link, false); assert.equal(firstFrame.cancelEnabled, true);
      assert.match(firstFrame.text, /连接|获取|申请|准备/);
      assert.doesNotMatch(firstFrame.text, /PRIVATE_|MOCK_ACCESS|MOCK_REFRESH|access_token|refresh_token/);
      const prepared = await progress(preparingProvider);
      assert.equal(prepared.state, 'pending'); assert.equal(prepared.stage, 'discovery'); assert.equal(prepared.userCode, undefined); assert.equal(prepared.verificationUri, undefined);
      await assertNoCredentials(preparingProvider, 'signing-in');
      const layout = await assertLayout();
      writeFileSync(join(outputDir, `electron-grok-login-preparing-${width}.png`), await captureUi());
      const beforeCancel = await progress(preparingProvider);
      assert.equal(beforeCancel.state, 'pending'); assert.equal(beforeCancel.stage, 'discovery');
      assert.equal(beforeCancel.userCode, undefined); assert.equal(beforeCancel.verificationUri, undefined);
      const stillPreparing = await evaluate<boolean>(`document.querySelector('.auth-body')?.dataset.authState==='pending'&&document.querySelector('.auth-body')?.dataset.authStage==='discovery'&&!document.querySelector('[data-auth-code]')`);
      assert.equal(stillPreparing, true, 'Preparing cancellation must run before mock discovery finishes; a slow capture must not silently test device polling instead');
      assert.equal(Number(process.env.MODELDOCK_SMOKE_GROK_POLLS), 0, 'The discovery-only fixture must not have reached token polling before cancellation');
      await click('.modal-footer .button.secondary');
      await waitFor(`!document.querySelector('[role="dialog"]')`, 'preparing login explicit cancellation');
      assert.equal((await progress(preparingProvider)).state, 'cancelled');
      await assertNoCredentials(preparingProvider, 'missing');
      // The mock's delayed response intentionally arrives after cancellation.
      await pause(3700);
      assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Late discovery must not reopen a cancelled login');
      assert.equal((await progress(preparingProvider)).state, 'cancelled');
      assert.equal(Number(process.env.MODELDOCK_SMOKE_GROK_POLLS), 0, 'Discovery cancellation must never reach token polling');
      await assertNoCredentials(preparingProvider, 'missing');
      preparing.push({ width, firstFrame, firstFrameElapsedMs, layout, cancelled: true, lateResponseIgnored: true, noCredentialsSaved: true });
      await waitFor(`!document.querySelector('article[data-provider-id="${preparingProvider.id}"] [aria-label="登录 ${preparingProvider.name}"]').disabled`, 'cancelled login can be started again');
    }

    process.env.MODELDOCK_SMOKE_GROK_MODE = 'network-error'; process.env.MODELDOCK_SMOKE_GROK_POLLS = '0';
    const errorProvider = await newProvider('Grok 授权网络错误回归测试');
    await begin(errorProvider);
    await waitFor(`document.querySelector('.auth-body')?.dataset.authStage==='discovery'&&document.querySelector('.auth-body')?.dataset.authCategory==='network'&&!!document.querySelector('.auth-body [role="alert"]')`, 'safe discovery network error visible');
    const failed = await progress(errorProvider);
    assert.equal(failed.state, 'error'); assert.equal(failed.stage, 'discovery'); assert.equal(failed.category, 'network'); assert.equal(failed.userCode, undefined); assert.equal(failed.verificationUri, undefined);
    const diagnostic = await evaluate<{ text: string; deviceCode: boolean; link: boolean; waiting: boolean }>(`(()=>{
      const body=document.querySelector('.auth-body');return {text:body.textContent??'',deviceCode:!!body.querySelector('[data-auth-code]'),link:!!body.querySelector('[data-action="auth-open-verification"]'),waiting:!!body.querySelector('.auth-wait')};
    })()`);
    assert.match(diagnostic.text, /网络|连接/); assert.match(diagnostic.text, /获取授权服务信息/);
    assert.equal(diagnostic.deviceCode, false); assert.equal(diagnostic.link, false); assert.equal(diagnostic.waiting, false);
    assert.doesNotMatch(diagnostic.text, /PRIVATE_|error_description|MOCK_ACCESS|MOCK_REFRESH|access_token|refresh_token/);
    await assertNoCredentials(errorProvider, 'error');
    const errorLayouts: unknown[] = [];
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await waitFor(width > 1100 ? 'innerWidth>1100' : 'innerWidth<1100', 'network-error login viewport');
      errorLayouts.push({ width, ...await assertLayout() });
      writeFileSync(join(outputDir, `electron-grok-login-network-error-${width}.png`), await captureUi());
    }
    await click('.modal-footer .button.secondary'); await waitFor(`!document.querySelector('[role="dialog"]')`, 'network error dialog closed');

    process.env.MODELDOCK_SMOKE_GROK_MODE = 'pending'; process.env.MODELDOCK_SMOKE_GROK_POLLS = '0';
    const pendingProvider = await newProvider('Grok 等待授权取消回归测试');
    await begin(pendingProvider);
    await waitFor(`document.querySelector('[data-auth-code]')?.dataset.value==='MOCK-GROK'&&!!document.querySelector('.auth-wait')`, 'mock Grok device code visible');
    const pending = await progress(pendingProvider);
    assert.equal(pending.state, 'pending'); assert.equal(pending.stage, 'device-poll'); assert.equal(pending.userCode, 'MOCK-GROK'); assert.ok(pending.verificationUri);
    const official = new URL(pending.verificationUri);
    assert.equal(official.protocol, 'https:');
    assert.ok(official.hostname === 'x.ai' || official.hostname.endsWith('.x.ai') || official.hostname === 'grok.com' || official.hostname.endsWith('.grok.com'), 'Mock device link must still satisfy the official issuer allowlist');
    const codeControls = await evaluate<{ code: string; copyEnabled: boolean; linkEnabled: boolean; href: string; error: boolean }>(`(()=>{
      const body=document.querySelector('.auth-body'),copy=body.querySelector('[data-action="auth-copy-code"]'),link=body.querySelector('[data-action="auth-open-verification"]');
      return {code:body.querySelector('[data-auth-code]').dataset.value,copyEnabled:!!copy&&!copy.disabled,linkEnabled:!!link,href:link?.href??'',error:!!body.querySelector('[role="alert"]')};
    })()`);
    assert.equal(codeControls.code, 'MOCK-GROK'); assert.equal(codeControls.copyEnabled, true); assert.equal(codeControls.linkEnabled, true); assert.equal(codeControls.href, pending.verificationUri); assert.equal(codeControls.error, false);
    // Do not click the link or clipboard control: no real browser or user clipboard is involved.
    await assertNoCredentials(pendingProvider, 'signing-in');
    const backdrop = await evaluate<{ x: number; y: number; isBackdrop: boolean }>(`(()=>{
      const box=document.querySelector('.modal').getBoundingClientRect(),x=Math.max(1,Math.floor(box.left/2)),y=Math.max(1,Math.floor(box.top/2));
      return {x,y,isBackdrop:document.elementFromPoint(x,y)?.classList.contains('modal-backdrop')??false};
    })()`);
    assert.equal(backdrop.isBackdrop, true);
    const pollsBeforeBackdrop = Number(process.env.MODELDOCK_SMOKE_GROK_POLLS);
    nativeClick(backdrop.x, backdrop.y); await pause(50);
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-auth-code]')?.dataset.value==='MOCK-GROK'`), true, 'Backdrop click must retain the pending authorization');
    const pollDeadline = Date.now() + 4500;
    while (Number(process.env.MODELDOCK_SMOKE_GROK_POLLS) < Math.max(2, pollsBeforeBackdrop + 1) && Date.now() < pollDeadline) await pause(25);
    const pollsAfterBackdrop = Number(process.env.MODELDOCK_SMOKE_GROK_POLLS);
    assert.ok(pollsAfterBackdrop >= 2 && pollsAfterBackdrop > pollsBeforeBackdrop, 'Polling must continue after a native backdrop click');
    assert.equal((await progress(pendingProvider)).state, 'pending');
    await assertNoCredentials(pendingProvider, 'signing-in');
    const pendingLayout = await assertLayout();
    writeFileSync(join(outputDir, 'electron-grok-login-pending-980.png'), await captureUi());
    const cancelPoint = await evaluate<{ x: number; y: number; enabled: boolean; label: string }>(`(()=>{
      const button=document.querySelector('.modal-footer .button.secondary'),box=button.getBoundingClientRect();
      return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2),enabled:!button.disabled,label:button.textContent};
    })()`);
    assert.equal(cancelPoint.enabled, true); assert.match(cancelPoint.label, /取消登录/);
    nativeClick(cancelPoint.x, cancelPoint.y);
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'native explicit Grok cancellation');
    const cancelled = await progress(pendingProvider); assert.equal(cancelled.state, 'cancelled');
    const stoppedPolls = Number(process.env.MODELDOCK_SMOKE_GROK_POLLS);
    await pause(1200);
    assert.equal(Number(process.env.MODELDOCK_SMOKE_GROK_POLLS), stoppedPolls, 'Explicit cancellation must stop the pending device polls');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Cancelled pending login must remain closed');
    await assertNoCredentials(pendingProvider, 'missing');
    writeFileSync(join(outputDir, 'grok-login-validation.json'), JSON.stringify({ preparing, networkError: { providerId: errorProvider.id, progress: failed, diagnostic, layouts: errorLayouts }, pending: { providerId: pendingProvider.id, progress: pending, controls: codeControls, layout: pendingLayout, backdropRetainedDialog: true, pollsBeforeBackdrop, pollsAfterBackdrop }, explicitCancel: { state: cancelled.state, stoppedPolls, pollingStopped: true, noCredentialsSaved: true }, importedClientFiles: false, openedRealBrowser: false, clipboardChanged: false }, null, 2));
  } finally {
    for (const provider of providers) {
      const current = await evaluate<AuthProgress | null>(`window.modelDock.authProgress(${JSON.stringify(provider.id)})`).catch(() => null);
      if (current?.state === 'pending') await evaluate(`window.modelDock.cancelLogin(${JSON.stringify(provider.id)})`).catch(() => undefined);
    }
    // Also restore the isolated application's session if an assertion failed
    // after saving the synthetic, intentionally unreachable proxy address.
    await evaluate(`window.modelDock.saveSettings({proxyUrl:''})`).catch(() => undefined);
    if (originalMode === undefined) delete process.env.MODELDOCK_SMOKE_GROK_MODE; else process.env.MODELDOCK_SMOKE_GROK_MODE = originalMode;
    if (originalPolls === undefined) delete process.env.MODELDOCK_SMOKE_GROK_POLLS; else process.env.MODELDOCK_SMOKE_GROK_POLLS = originalPolls;
  }
}
