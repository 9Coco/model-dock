import { clipboard, ClipboardItem, type BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Store } from './store';
import type { AuthProgress, Provider, Snapshot } from '../shared/types';

async function preserveClipboardItems(): Promise<ClipboardItem[]> {
  try {
    const detached: ClipboardItem[] = [];
    for (const item of await clipboard.read()) {
      const entries: Record<string, Blob | Electron.ClipboardBookmark> = {};
      for (const type of item.types) {
        const value = await item.getType(type);
        // Materialize before any write, including custom raw formats, so later
        // restoration never tries to lazily reread the changed OS clipboard.
        entries[type] = value instanceof Blob ? new Blob([await value.arrayBuffer()], { type: value.type }) : { title: value.title, url: value.url };
      }
      if (Object.keys(entries).length) detached.push(new ClipboardItem(entries));
    }
    return detached;
  } catch { throw new Error('原剪贴板内容无法完整读取，已停止复制测试。'); }
}

/** Explicit mock-only authorization UI validation; never imports client files. */
export async function verifyAuthNetwork(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream, 'Auth network smoke requires explicit fixture isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1', 'Auth network smoke must never start without the mock-only OAuth transport');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const fixturePath = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !/^[A-Za-z]:/.test(fixturePath), 'Auth smoke database must be below its fixture directory');
  const url = new URL(upstream);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash);
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Auth network smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(button.disabled)throw new Error('Auth control disabled: '+${JSON.stringify(selector)});button.click()})()`);
  }
  const initial = await evaluate<Snapshot>('window.modelDock.snapshot()');
  assert.equal(resolve(initial.dataDir), resolve(dataDir), 'Renderer must use the isolated database');
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await waitFor(`!document.querySelector('.modal')`, 'previous dialogs closed');
  const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '授权网络诊断测试', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true })})`);
  assert.equal(provider.hasSecret, false); assert.equal(provider.authStatus, 'missing');
  await click('[aria-label="刷新本机配置"]');
  await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'synthetic subscription source refreshed');
  await click(`[data-source-id="${provider.id}"]`);
  await click(`article[data-provider-id="${provider.id}"] [aria-label="登录 ${provider.name}"]`);
  await waitFor(`document.querySelector('[data-auth-stage]')?.dataset.authStage==='device-code'&&document.querySelector('[data-auth-category]')?.dataset.authCategory==='region'`, 'safe region diagnosis shown');
  const diagnostic = await evaluate<{ stage: string; category: string; statusCode: number; text: string; hasDeviceCode: boolean; hasWait: boolean }>(`(()=>{const body=document.querySelector('.auth-body');return {stage:body.dataset.authStage,category:body.dataset.authCategory,statusCode:Number(body.dataset.authStatus),text:body.textContent??'',hasDeviceCode:!!body.querySelector('.auth-code'),hasWait:!!body.querySelector('.auth-wait')}})()`);
  assert.equal(diagnostic.stage, 'device-code'); assert.equal(diagnostic.category, 'region'); assert.equal(diagnostic.statusCode, 403);
  assert.match(diagnostic.text, /地区|地域/); assert.equal(diagnostic.hasDeviceCode, false); assert.equal(diagnostic.hasWait, false);
  assert.doesNotMatch(diagnostic.text, /PRIVATE_|access_token|refresh_token|error_description|synthetic-only|synthetic-invalid/);
  const progress = await evaluate<AuthProgress | null>(`window.modelDock.authProgress(${JSON.stringify(provider.id)})`);
  assert.ok(progress); assert.equal(progress.state, 'error'); assert.equal(progress.stage, 'device-code'); assert.equal(progress.category, 'region'); assert.equal(progress.statusCode, 403);
  assert.equal(progress.userCode, undefined); assert.equal(progress.verificationUri, undefined);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|accessToken|refreshToken|access_token|refresh_token|error_description/);
  const stored = store.getProvider(provider.id);
  assert.ok(stored); assert.equal(stored.hasSecret, false); assert.equal(stored.authStatus, 'error');
  assert.equal(store.listModels().filter(model => model.providerId === provider.id).length, 0, 'Failed authorization must not add models');

  window.setSize(1320, 880); await waitFor('innerWidth>1100', 'large auth diagnosis viewport');
  writeFileSync(join(outputDir, 'electron-auth-403-diagnostic-1320.png'), await captureUi());
  window.setSize(980, 680); await waitFor('innerWidth<1100', 'compact auth diagnosis viewport');
  const layout = await evaluate<{ dialogInside: boolean; footerVisible: boolean; overflow: boolean; diagnosticVisible: boolean }>(`(()=>{
    const dialog=document.querySelector('.modal'),body=dialog.querySelector('.auth-body'),footer=dialog.querySelector('.modal-footer'),bounds=dialog.getBoundingClientRect(),end=footer.getBoundingClientRect();
    return {dialogInside:bounds.top>=0&&bounds.bottom<=innerHeight+1&&bounds.left>=0&&bounds.right<=innerWidth+1,footerVisible:end.top>=0&&end.bottom<=innerHeight+1,overflow:body.scrollWidth>body.clientWidth+1,diagnosticVisible:!!body.dataset.authStage&&body.textContent.includes('403')};
  })()`);
  assert.equal(layout.dialogInside, true); assert.equal(layout.footerVisible, true); assert.equal(layout.overflow, false); assert.equal(layout.diagnosticVisible, true);
  writeFileSync(join(outputDir, 'electron-auth-403-diagnostic-980.png'), await captureUi());
  await click('[data-action="auth-open-center"]');
  await waitFor(`!document.querySelector('.modal')&&!!document.querySelector('.auth-panel')&&document.querySelector('[data-page="auth"]')?.getAttribute('aria-current')==='page'`, 'explicit authorization center navigation');
  const center = await evaluate<{ visible: boolean; hasExplicitImportButton: boolean }>(`(()=>({visible:!!document.querySelector('.auth-panel'),hasExplicitImportButton:Array.from(document.querySelectorAll('.auth-panel .account-group-header button')).some(button=>button.textContent.includes('从客户端导入'))}))()`);
  assert.equal(center.visible, true); assert.equal(center.hasExplicitImportButton, true);
  // Only inspect navigation: clicking import would read a credential file.
  const afterNavigation = store.getProvider(provider.id);
  assert.equal(afterNavigation?.hasSecret, false); assert.equal(afterNavigation?.authStatus, 'error');
  writeFileSync(join(outputDir, 'auth-network-validation.json'), JSON.stringify({ provider: { id: provider.id, name: provider.name, hasSecret: afterNavigation?.hasSecret, authStatus: afterNavigation?.authStatus }, progress, diagnostic, layout, center, importedClientFiles: false }, null, 2));
}

/** A mock grant stays visible across rejected-looking pending polls, then completes. */
export async function verifyPendingAuth(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR;
  assert.ok(smokeDir && dataDir, 'Pending authorization smoke requires explicit isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1', 'Pending auth smoke requires the mock-only transport');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_PENDING, '1', 'Pending auth smoke requires the pending fixture mode');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const fixturePath = relative(resolve(smokeDir, 'data'), resolve(dataDir));
  assert.ok(fixturePath && !fixturePath.startsWith('..') && !/^[A-Za-z]:/.test(fixturePath), 'Pending smoke database must be inside the fixture directory');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(source)) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Pending authorization smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(button.disabled)throw new Error('Pending auth control disabled');button.click()})()`);
  }
  const textFixture = '中文配置\nmodel = "synthetic-only"\nprovider = "本机测试"';
  const originalClipboard = await preserveClipboardItems();
  try {
  await evaluate(`window.modelDock.copyText(${JSON.stringify(textFixture)})`);
  assert.ok(await clipboard.readText() === textFixture, 'Native copy must preserve multiline Chinese configuration exactly');
  const rejectedInputs: boolean[] = [];
  for (const input of ['null', '123', 'true', '{}', "['text']", "'invalid\\u0000text'", "'x'.repeat(1024*1024+1)", "'你'.repeat(Math.floor(1024*1024/3)+1)"]) {
    const rejected = await evaluate<boolean>(`(async()=>{try{await window.modelDock.copyText(${input});return false}catch{return true}})()`);
    rejectedInputs.push(rejected);
    assert.ok(rejected, 'Invalid clipboard input must reject before a native write');
    assert.ok(await clipboard.readText() === textFixture, 'Each rejected copy must preserve the preceding clipboard fixture');
  }
  assert.equal(rejectedInputs.length, 8); assert.ok(rejectedInputs.every(Boolean), 'Invalid type, NUL and over-limit UTF-8 inputs must reject');
  assert.ok(await clipboard.readText() === textFixture, 'Rejected native copies must not change the clipboard');
  const clipboardValidation = { multilineChineseCopied: true, rejectedInvalidInputs: rejectedInputs.length, rejectedInputsPreservedClipboard: true, deviceCodeCopied: false };
  const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
  assert.equal(resolve(snapshot.dataDir), resolve(dataDir), 'Pending auth renderer must use isolated data');
  await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  await waitFor(`!document.querySelector('.modal')`, 'prior modal closed');
  const provider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '等待授权回归测试', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true })})`);
  assert.equal(provider.hasSecret, false); assert.equal(provider.authStatus, 'missing');
  await click('[aria-label="刷新本机配置"]');
  await waitFor(`!!document.querySelector('[data-source-id="${provider.id}"]')`, 'pending fixture source refreshed');
  await click(`[data-source-id="${provider.id}"]`);
  window.setSize(1320, 880); await waitFor('innerWidth>1100', 'large pending viewport');
  const started = Date.now();
  await click(`article[data-provider-id="${provider.id}"] [aria-label="登录 ${provider.name}"]`);
  await waitFor(`document.querySelector('[data-auth-code]')?.dataset.value==='MOCK-00000'&&!!document.querySelector('.auth-wait')`, 'synthetic code visible while waiting');
  await click('[data-action="auth-copy-code"]');
  const copyDeadline = Date.now() + 2000;
  while (await clipboard.readText() !== 'MOCK-00000' && Date.now() < copyDeadline) await new Promise(done => setTimeout(done, 25));
  assert.ok(await clipboard.readText() === 'MOCK-00000', 'Code copy button must write the actual synthetic device code through native clipboard');
  clipboardValidation.deviceCodeCopied = true;
  const backdropPoint = await evaluate<{ x: number; y: number; backdrop: boolean }>(`(()=>{const box=document.querySelector('.modal').getBoundingClientRect(),x=Math.max(1,Math.floor(box.left/2)),y=Math.max(1,Math.floor(box.top/2));return {x,y,backdrop:document.elementFromPoint(x,y)?.classList.contains('modal-backdrop')??false}})()`);
  assert.equal(backdropPoint.backdrop, true, 'Native regression click must hit the backdrop outside the dialog');
  const pollsBeforeBackdrop = Number(process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS ?? 0);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: backdropPoint.x, y: backdropPoint.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: backdropPoint.x, y: backdropPoint.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: backdropPoint.x, y: backdropPoint.y, button: 'left', clickCount: 1 });
  await new Promise(done => setTimeout(done, 50));
  await waitFor(`document.querySelector('[data-auth-code]')?.dataset.value==='MOCK-00000'&&!!document.querySelector('.auth-wait')`, 'pending dialog survives native backdrop click');
  interface PendingObservation {
    elapsedMs: number; mockPolls: number | null; progress: AuthProgress;
    code: string; copyAvailable: boolean; officialLinkAvailable: boolean; officialHref: string; waiting: boolean; errorVisible: boolean;
    hasSecret: boolean; authStatus: Provider['authStatus'];
  }
  async function observe(afterMs: number): Promise<PendingObservation> {
    const remaining = started + afterMs - Date.now();
    if (remaining > 0) await new Promise(done => setTimeout(done, remaining));
    const progress = await evaluate<AuthProgress | null>(`window.modelDock.authProgress(${JSON.stringify(provider.id)})`);
    assert.ok(progress); assert.equal(progress.state, 'pending'); assert.equal(progress.userCode, 'MOCK-00000');
    assert.ok(progress.verificationUri);
    const verification = new URL(progress.verificationUri);
    assert.equal(verification.protocol, 'https:'); assert.equal(verification.hostname, 'auth.openai.com'); assert.equal(verification.pathname, '/codex/device');
    const ui = await evaluate<{ code: string; copyAvailable: boolean; officialLinkAvailable: boolean; officialHref: string; waiting: boolean; errorVisible: boolean }>(`(()=>{
      const body=document.querySelector('.auth-body'),code=body?.querySelector('[data-auth-code]'),link=body?.querySelector('[data-action="auth-open-verification"]');
      return {code:code?.dataset.value??'',copyAvailable:Array.from(code?.querySelectorAll('button')??[]).some(button=>!button.disabled&&button.textContent.includes('复制')),officialLinkAvailable:!!link&&!link.disabled,officialHref:link?.href??'',waiting:!!body?.querySelector('.auth-wait'),errorVisible:!!body?.querySelector('[role="alert"], .auth-failure-details')};
    })()`);
    assert.equal(ui.code, 'MOCK-00000'); assert.equal(ui.copyAvailable, true); assert.equal(ui.officialLinkAvailable, true); assert.equal(ui.officialHref, 'https://auth.openai.com/codex/device'); assert.equal(ui.waiting, true); assert.equal(ui.errorVisible, false);
    const stored = store.getProvider(provider.id); assert.ok(stored);
    assert.equal(stored.hasSecret, false, 'Pending device polls must never save credentials'); assert.equal(stored.authStatus, 'signing-in');
    const rawPollCount = process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS;
    const mockPolls = rawPollCount === undefined ? null : Number(rawPollCount);
    if (mockPolls !== null) assert.ok(Number.isInteger(mockPolls) && mockPolls >= 2, 'At least two pending polls must have completed');
    assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|accessToken|refreshToken|access_token|refresh_token|error_description/);
    return { elapsedMs: Date.now() - started, mockPolls, progress, ...ui, hasSecret: stored.hasSecret, authStatus: stored.authStatus };
  }
  const firstPending = await observe(1050);
  writeFileSync(join(outputDir, 'electron-auth-pending-1320.png'), await captureUi());
  window.setSize(980, 680); await waitFor('innerWidth<1100', 'compact pending viewport');
  const secondPending = await observe(2150);
  const layout = await evaluate<{ dialogInside: boolean; footerVisible: boolean; overflow: boolean; codeInside: boolean; linkInside: boolean }>(`(()=>{
    const dialog=document.querySelector('.modal'),body=dialog.querySelector('.auth-body'),footer=dialog.querySelector('.modal-footer'),code=body.querySelector('[data-auth-code]'),link=body.querySelector('[data-action="auth-open-verification"]');
    const inside=element=>{const bounds=element.getBoundingClientRect();return bounds.top>=0&&bounds.bottom<=innerHeight+1&&bounds.left>=0&&bounds.right<=innerWidth+1;};
    return {dialogInside:inside(dialog),footerVisible:inside(footer),overflow:body.scrollWidth>body.clientWidth+1,codeInside:inside(code),linkInside:inside(link)};
  })()`);
  assert.equal(layout.dialogInside, true); assert.equal(layout.footerVisible, true); assert.equal(layout.overflow, false); assert.equal(layout.codeInside, true); assert.equal(layout.linkInside, true);
  writeFileSync(join(outputDir, 'electron-auth-pending-980.png'), await captureUi());
  await waitFor(`!!document.querySelector('.auth-symbol.complete')&&!document.querySelector('.auth-wait')`, 'synthetic grant completed in UI');
  const completed = await evaluate<AuthProgress | null>(`window.modelDock.authProgress(${JSON.stringify(provider.id)})`);
  assert.ok(completed); assert.equal(completed.state, 'complete');
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE_|accessToken|refreshToken|access_token|refresh_token|error_description/);
  const stored = store.getProvider(provider.id); assert.ok(stored); assert.equal(stored.authStatus, 'ready'); assert.equal(stored.hasSecret, true);
  assert.ok(store.getSecret(provider.id)?.idToken, 'Real credential storage must retain the synthetic ID token in the main process');
  const managedIdentity = await evaluate<{ accountId?: string; email?: string }>(`window.modelDock.authAccounts().then(accounts=>accounts.find(account=>account.providerId===${JSON.stringify(provider.id)}))`);
  assert.equal(managedIdentity.accountId, 'mock-auth-workspace'); assert.equal(managedIdentity.email, 'mock-auth@example.test');
  assert.doesNotMatch(JSON.stringify(managedIdentity), /idToken|accessToken|refreshToken|MOCK_ACCESS|MOCK_REFRESH|\.mock/);
  assert.equal(Number(process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS), 4, 'Fourth mock poll must complete the grant after three pending responses');
  assert.equal(store.listModels().filter(model => model.providerId === provider.id).length, 0, 'Successful authorization must not auto-add models');
  const completedState = { authStatus: stored.authStatus, hasSecret: stored.hasSecret, mockPolls: Number(process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS) };
  const backdrop = { retainedCode: true, pollsBefore: pollsBeforeBackdrop, pollsAfter: secondPending.mockPolls };
  assert.ok((backdrop.pollsAfter ?? 0) > backdrop.pollsBefore, 'Polling must continue after the native backdrop click');
  await click('.modal-footer .button.secondary');
  await waitFor(`!document.querySelector('.modal')`, 'completed fixture dialog closed');
  const cancelProvider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: '等待授权取消回归测试', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true })})`);
  await click('[aria-label="刷新本机配置"]');
  await waitFor(`!!document.querySelector('[data-source-id="${cancelProvider.id}"]')`, 'cancel fixture source refreshed');
  await click(`[data-source-id="${cancelProvider.id}"]`);
  await click(`article[data-provider-id="${cancelProvider.id}"] [aria-label="登录 ${cancelProvider.name}"]`);
  await waitFor(`document.querySelector('[data-auth-code]')?.dataset.value==='MOCK-00000'&&!!document.querySelector('.auth-wait')`, 'second grant pending before explicit cancel');
  assert.equal(store.getProvider(cancelProvider.id)?.hasSecret, false);
  const cancelPoint = await evaluate<{ x: number; y: number; label: string }>(`(()=>{const button=document.querySelector('.modal-footer .button.secondary'),box=button.getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2),label:button.textContent}})()`);
  assert.ok(cancelPoint.label.includes('取消登录'));
  window.webContents.sendInputEvent({ type: 'mouseMove', x: cancelPoint.x, y: cancelPoint.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: cancelPoint.x, y: cancelPoint.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: cancelPoint.x, y: cancelPoint.y, button: 'left', clickCount: 1 });
  await waitFor(`!document.querySelector('.modal')`, 'native explicit cancellation closes pending dialog');
  const cancelled = await evaluate<AuthProgress | null>(`window.modelDock.authProgress(${JSON.stringify(cancelProvider.id)})`);
  assert.equal(cancelled?.state, 'cancelled'); assert.equal(store.getProvider(cancelProvider.id)?.hasSecret, false); assert.equal(store.getProvider(cancelProvider.id)?.authStatus, 'missing');
  const cancelPolls = Number(process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS);
  await new Promise(done => setTimeout(done, 1100));
  assert.equal(Number(process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS), cancelPolls, 'Cancelled grant must stop polling');
  assert.equal(store.getProvider(cancelProvider.id)?.hasSecret, false, 'Cancelled grant must not restore late credentials');
  writeFileSync(join(outputDir, 'auth-pending-validation.json'), JSON.stringify({ provider: { id: provider.id, name: provider.name }, firstPending, secondPending, layout, completed, final: completedState, clipboard: clipboardValidation, backdrop, explicitCancel: { providerId: cancelProvider.id, state: cancelled?.state, hasSecret: false, pollingStopped: true }, importedClientFiles: false }, null, 2));
  } finally {
    // Restore every readable format atomically; no original contents leave memory.
    try {
      const current = await clipboard.readText();
      // An external clipboard update during the smoke belongs to the user.
      if (current === textFixture || current === 'MOCK-00000') {
        if (originalClipboard.length) await clipboard.write(originalClipboard); else clipboard.clear();
      }
    }
    catch { throw new Error('原剪贴板内容恢复失败。'); }
  }
}
