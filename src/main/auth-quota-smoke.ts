import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Store } from './store';
import type { AuthAccount } from '../shared/auth-types';
import type { AuthProgress } from '../shared/types';
import { copilotPollingFixtureStats } from './auth-quota-fixtures';

/** Real renderer, preload and encrypted store; only synthetic account servers. */
export async function verifyAuthQuotas(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child));
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(code: string, label: string) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(code)) return; await pause(40); }
    writeFileSync(join(outputDir, 'electron-auth-quota-timeout.png'), await captureUi());
    throw new Error(`Auth quota verification timed out: ${label}`);
  }
  async function click(selector: string) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function waitForPollingResponse(kind: 'pending' | 'slow-down') {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const stats = copilotPollingFixtureStats();
      if ((kind === 'pending' ? stats.authorizationPending400 : stats.slowDown400) > 0) return;
      await pause(35);
    }
    throw new Error(`Copilot polling fixture did not send HTTP 400 ${kind}`);
  }
  const accounts = () => evaluate<AuthAccount[]>('window.modelDock.authAccounts()');
  const calls = () => Object.fromEntries(['codex', 'credits', 'grok', 'copilot'].map(kind => [kind, Number(process.env[`MODELDOCK_SMOKE_QUOTA_${kind.toUpperCase()}_CALLS`] ?? 0)]));
  for (const provider of store.listProviders().filter(provider => ['codex', 'grok'].includes(provider.kind) && !provider.hasSecret)) store.deleteProvider(provider.id);
  const fixtureIds: string[] = [];
  for (const [kind, email] of [['codex', 'chatgpt-quota@example.test'], ['grok', 'xai-quota@example.test']] as const) {
    const provider = store.saveProvider({ name: kind === 'codex' ? 'ChatGPT 额度验证' : 'xAI 额度验证', kind,
      baseUrl: kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://cli-chat-proxy.grok.com/v1', enabled: true });
    const access = `mock.${Buffer.from(JSON.stringify({ sub: `quota-${kind}`, email, exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: `quota-workspace-${kind}`, chatgpt_plan_type: kind === 'codex' ? 'plus' : undefined } })).toString('base64url')}.mock`;
    store.setSecret(provider.id, { accessToken: access, accountId: `quota-workspace-${kind}`, expiresAt: Date.now() + 3600_000 });
    fixtureIds.push(provider.id);
  }
  await click('[data-page="auth"]');
  await waitFor(`(async()=>{const accounts=await window.modelDock.authAccounts();return ${JSON.stringify(fixtureIds)}.every(id=>accounts.find(a=>a.providerId===id)?.usage.status==='ready')})()`, 'automatic subscription usage after authorization');
  const beforeCopilot = calls();
  assert.equal(beforeCopilot.codex, 1); assert.equal(beforeCopilot.credits, 1); assert.equal(beforeCopilot.grok, 1);
  process.env.MODELDOCK_SMOKE_COPILOT_AUTH_FLOW = 'http400-polling';
  delete process.env.MODELDOCK_SMOKE_COPILOT_AUTH_PENDING;
  await click('[data-action="copilot-login"]');
  const waitingReadbacks: unknown[] = [];
  for (const kind of ['pending', 'slow-down'] as const) {
    await waitForPollingResponse(kind);
    const progress = await evaluate<AuthProgress>('window.modelDock.copilotAuthProgress()');
    assert.equal(progress.state, 'pending', `HTTP 400 ${kind} must keep device polling active`);
    assert.equal(progress.stage, 'device-poll');
    assert.equal((await accounts()).some(account => account.kind === 'copilot'), false, 'Pending responses must not create a logged-in account');
    await waitFor('document.querySelector("[data-auth-state=pending]")?.dataset.authStage==="device-poll"', `visible pending dialog after HTTP 400 ${kind}`);
    const body = await evaluate<string>('document.querySelector("[role=dialog]").textContent');
    assert.doesNotMatch(body, /HTTP 400|PRIVATE_SYNTHETIC|SYNTHETIC_COPILOT_QUOTA_TOKEN/);
    assert.match(body, /等待授权结果/);
    writeFileSync(join(outputDir, `electron-copilot-http400-${kind}.png`), await captureUi());
    waitingReadbacks.push({ response: kind, state: progress.state, stage: progress.stage, accountNotStoredYet: true });
  }
  await waitFor(`(async()=>{const progress=await window.modelDock.copilotAuthProgress();return progress?.state==='complete'&&progress.providerId==='copilot:login'})()`, 'Copilot device authorization');
  delete process.env.MODELDOCK_SMOKE_COPILOT_AUTH_FLOW;
  const polling = copilotPollingFixtureStats();
  assert.deepEqual({ polls: polling.polls, http400: polling.http400Responses, http200: polling.http200Responses, pending: polling.authorizationPending400, slowDown: polling.slowDown400, success: polling.success200 },
    { polls: 3, http400: 2, http200: 1, pending: 1, slowDown: 1, success: 1 });
  assert.ok(polling.slowDownGapMs !== null && polling.slowDownGapMs >= 5900, 'HTTP 400 slow_down must delay the next poll by the existing six-second backoff');
  await waitFor(`(async()=>{const accounts=await window.modelDock.authAccounts();return accounts.find(a=>a.kind==='copilot')?.usage.status==='ready'&&!!document.querySelector('[data-auth-account="copilot:424242"]')})()`, 'Copilot account and automatic quota');
  const restProtocol = copilotPollingFixtureStats();
  assert.equal(restProtocol.githubUserApiVersion, '2022-11-28', 'Public GitHub /user must use its supported REST version');
  assert.equal(restProtocol.githubUserHttp200, 1); assert.equal(restProtocol.githubUserHttp400, 0);
  assert.equal(restProtocol.copilotUsageApiVersion, '2025-10-01', 'Private Copilot quota must retain its separate entitlement version');
  assert.equal(restProtocol.copilotUsageWrongVersion400, 0);
  await waitFor(`!document.querySelector('[role="dialog"]')||document.querySelector('[role="dialog"]')?.textContent.includes('已登录')`, 'shared authorization dialog completed');
  if (await evaluate<boolean>('!!document.querySelector("[role=dialog]")')) await click('[aria-label="关闭对话框"]');
  const measured = await accounts();
  assert.equal(measured.length, 3);
  const codex = measured.find(account => account.kind === 'codex')!, grok = measured.find(account => account.kind === 'grok')!, copilot = measured.find(account => account.kind === 'copilot')!;
  assert.deepEqual(codex.usage.windows.map(window => window.remainingPercent), [58, 64]);
  assert.equal(codex.usage.resetCredits?.available, 2); assert.equal(codex.usage.resetCredits?.expiresAt.length, 2);
  assert.equal(grok.usage.windows[0].remainingPercent, 78);
  assert.equal(copilot.usage.windows[0].label, 'AI Credits'); assert.equal(copilot.usage.windows[0].remainingPercent, 82);
  assert.equal(copilot.usage.windows[0].remaining, 820); assert.equal(copilot.usage.windows[0].total, 1000);
  assert.equal(calls().copilot, 1);
  assert.equal(readFileSync(join(store.dataDir, 'modeldock.sqlite')).includes(Buffer.from('SYNTHETIC_COPILOT_QUOTA_TOKEN')), false, 'Stored Copilot token must be encrypted');
  await waitFor('document.querySelectorAll("[data-auth-account] progress").length===4', 'four measured quota progress bars');
  assert.doesNotMatch(JSON.stringify(measured), /SYNTHETIC_COPILOT_QUOTA_TOKEN|accessToken|refreshToken/);
  const body = await evaluate<string>('document.body.innerText');
  for (const text of ['GitHub Copilot', 'ChatGPT', 'xAI', '58%', '64%', '78%', '82%']) assert.ok(body.includes(text), `Quota UI must show ${text}`);
  assert.ok(body.includes('2 次')); assert.ok(body.includes('刚刚'));
  const expiryContainer = `[data-auth-account="${codex.providerId}"] [data-reset-expiries]`;
  if (await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(expiryContainer)})?.querySelector('summary')`)) await click(`${expiryContainer} summary`);
  const layouts: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    await click('[data-page="settings"]'); await click(`[data-theme-choice="${theme}"]`);
    await click('[data-page="auth"]');
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    if (await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(expiryContainer)})?.querySelector('summary')&&!document.querySelector(${JSON.stringify(expiryContainer)}).open`)) await click(`${expiryContainer} summary`);
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await pause(180);
      const layout = await evaluate<{ horizontalOverflow: boolean; groups: number; progress: number }>(`({horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,groups:document.querySelectorAll('[data-auth-kind]').length,progress:document.querySelectorAll('[data-auth-account] progress').length})`);
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.groups, 3); assert.equal(layout.progress, 4);
      layouts.push({ theme, width, ...layout }); writeFileSync(join(outputDir, `electron-auth-quotas-${theme}-${width}.png`), await captureUi());
    }
  }
  // Both layers deduplicate simultaneous quota requests for the same account.
  const beforeRefresh = calls();
  await evaluate(`Promise.all([window.modelDock.refreshAccountUsage(${JSON.stringify(codex.providerId)}),window.modelDock.refreshAccountUsage(${JSON.stringify(codex.providerId)})])`);
  assert.equal(calls().codex, beforeRefresh.codex + 1); assert.equal(calls().credits, beforeRefresh.credits + 1);
  const stableCalls = calls(); await pause(5300); assert.deepEqual(calls(), stableCalls, 'Cache-only list polling must not query upstream every five seconds');
  process.env.MODELDOCK_SMOKE_QUOTA_MODE = 'network-error';
  for (const account of measured) await evaluate(`window.modelDock.refreshAccountUsage(${JSON.stringify(account.providerId)})`);
  const stale = await accounts(); assert.ok(stale.every(account => account.usage.status === 'stale'));
  assert.equal(stale.find(account => account.kind === 'codex')?.usage.resetCreditsStatus, 'stale');
  await pause(5200); const staleCalls = calls(); await pause(5200); assert.deepEqual(calls(), staleCalls, 'Failures must not cause a five-second refresh loop');
  process.env.MODELDOCK_SMOKE_QUOTA_MODE = 'unknown';
  await evaluate(`window.modelDock.refreshAccountUsage(${JSON.stringify(codex.providerId)})`);
  const unknown = (await accounts()).find(account => account.kind === 'codex')!;
  assert.equal(unknown.usage.status, 'unavailable'); assert.equal(unknown.usage.windows.length, 0); assert.equal(unknown.usage.resetCredits, undefined);
  assert.equal(unknown.usage.resetCreditsStatus, 'unavailable');
  delete process.env.MODELDOCK_SMOKE_QUOTA_MODE;
  for (const account of measured) await evaluate(`window.modelDock.refreshAccountUsage(${JSON.stringify(account.providerId)})`);
  await evaluate('window.modelDock.copilotLogoutAccount("copilot:424242")');
  assert.equal((await accounts()).some(account => account.kind === 'copilot'), false);
  assert.equal((await accounts()).filter(account => account.kind !== 'copilot').length, 2);
  const safeText = await evaluate<string>('document.body.innerText'); assert.doesNotMatch(safeText, /SYNTHETIC_COPILOT_QUOTA_TOKEN|accessToken|refreshToken/);
  writeFileSync(join(outputDir, 'auth-quota-validation.json'), JSON.stringify({ ok: true, accountKinds: ['copilot', 'codex', 'grok'], autoQueryAfterLogin: true,
    copilotHttp400Polling: { ...polling, waitingReadbacks, authorizationPendingPreservesWaiting: true, slowDownPreservesWaiting: true, retryEventuallySucceeds: true, upstreamErrorBodiesNotInRenderer: true },
    githubRestVersionSeparation: { publicUserApiVersion: restProtocol.githubUserApiVersion, publicUserHttp200: restProtocol.githubUserHttp200, publicUserHttp400: restProtocol.githubUserHttp400,
      privateCopilotUsageApiVersion: restProtocol.copilotUsageApiVersion, wrongQuotaVersion400: restProtocol.copilotUsageWrongVersion400, profileAfterTokenExchangeSucceeded: true },
    progressBars: 4, measuredRemainingPercents: [82, 58, 64, 78], resetCredits: 2, resetExpirations: 2, quotaAndResetCountdown: true, encryptedCopilotAccount: true, sourceTokensNotInRenderer: true, duplicateQueriesDeduplicated: true, cacheListDoesNotQueryEveryFiveSeconds: true, staleResultsPreserved: true, unknownNeverMeansZero: true, logoutPreservesOtherPlatforms: true, layouts, realClientProfilesChanged: false, realAccountsQueried: false, liveProviderInferenceTested: false }, null, 2));
}
