import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AuthAccount, SubscriptionUsage } from '../shared/auth-types';
import type { AddModelsResult, DiscoveryResult } from '../shared/catalog-types';
import type { ConnectionResult } from '../shared/connection-types';
import { JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import type { JetBrainsIdeApiPort } from './jetbrains-ide-account';
import { JetBrainsIdeApiError } from './jetbrains-ide-api';
import { JetBrainsIdeImportError, type JetBrainsIdeCredentials, type JetBrainsIdeImporter, type JetBrainsIdeImportCandidate } from './jetbrains-ide-import';
import type { Store } from './store';

const CANDIDATE_ID = 'd765c058-c4e5-4d93-9a6d-5b54fcb3c4ca';
const SECOND_CANDIDATE_ID = '8b545b7b-c40d-4d95-afb0-8fcbf33ecce8';
const OTHER_LICENSE_CANDIDATE_ID = '3cb0f2d1-5b6a-4dcb-a9c2-e8b253dba123';
const ACCOUNT_ID = 'qa-native-ide-account';
const ACCOUNT_LABEL = 'Rider 演示账号';
const GRAZIE_TOKEN = 'PRIVATE_JETBRAINS_IDE_GRAZIE_TOKEN';
const PRIVATE_ERROR = 'PRIVATE_JETBRAINS_IDE_RAW_TOKEN_PATH_BODY';
const MODEL_ID = 'qa-native-ide-profile';
const MODE_KEY = 'qa-jetbrains-ide-mode';
const OBSERVED_KEY = 'qa-jetbrains-ide-observed';
const LAST_CHAT_MODEL_KEY = 'qa-jetbrains-ide-last-chat-model';
type FixtureMode = 'empty' | 'expired' | 'failure' | 'ready' | 'cross-ide' | 'multiple' | 'slow';
type Observed = Record<'list' | 'read' | 'exchange' | 'quota' | 'models' | 'chat', number>;

/** Synthetic main-process ports only: never reads IDE files, a keychain, or an
 * installed Central client, and never makes an upstream network request. */
export function createJetBrainsIdeFixture(store: Store): { reader: Pick<JetBrainsIdeImporter, 'listCandidates' | 'readCredentials'>; api: JetBrainsIdeApiPort } {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const sourceTokenExpHint = Date.now() + 60 * 60_000;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ user_id: ACCOUNT_ID, marker: 'PRIVATE_JETBRAINS_IDE_JBA_TOKEN', exp: Math.floor(sourceTokenExpHint / 1000) })}.c3ludGhldGljLXNpZ25hdHVyZQ`;
  const credentials: JetBrainsIdeCredentials = { tokenType: 'jba-id-token', authorization: 'unverified', idToken, accountId: ACCOUNT_ID, accountLabel: ACCOUNT_LABEL, email: 'synthetic-ide@example.test', licenseId: 'synthetic-native-ide-license', product: 'rider', sourceIdentity: 'ad'.repeat(32), sourceTokenExpHint };
  const alternate: JetBrainsIdeCredentials = { ...credentials, product: 'intellij-idea', sourceIdentity: 'be'.repeat(32) };
  const otherLicense: JetBrainsIdeCredentials = { ...credentials, licenseId: 'synthetic-other-native-ide-license', product: 'pycharm', sourceIdentity: 'cf'.repeat(32) };
  const mode = () => store.getManagedState<FixtureMode>(MODE_KEY, 'empty');
  function candidates(): JetBrainsIdeImportCandidate[] {
    if (mode() === 'empty') return [];
    const candidate = (id: string, value: JetBrainsIdeCredentials, clientName: string): JetBrainsIdeImportCandidate => ({ id, client: 'jetbrains-ide', clientName, product: value.product, sourceIdentity: value.sourceIdentity,
      accountLicenseIdentity: createHash('sha256').update(JSON.stringify([value.accountId, value.licenseId])).digest('hex'), accountId: value.accountId, accountLabel: value.accountLabel, sourceTokenExpHint });
    const current = candidate(CANDIDATE_ID, credentials, 'Rider 2026.2');
    if (mode() === 'cross-ide') return [candidate(SECOND_CANDIDATE_ID, alternate, 'IntelliJ IDEA 2026.2 · 同一许可证'), current];
    if (mode() === 'multiple') return [current, candidate(OTHER_LICENSE_CANDIDATE_ID, otherLicense, 'PyCharm 2026.2 · 另一许可证')];
    return [current];
  }
  function observe(key: keyof Observed): void {
    const value = store.getManagedState<Observed>(OBSERVED_KEY, { list: 0, read: 0, exchange: 0, quota: 0, models: 0, chat: 0 });
    store.setManagedState(OBSERVED_KEY, { ...value, [key]: value[key] + 1 });
  }
  function accept(token: string): void { if (token !== GRAZIE_TOKEN || mode() === 'failure') throw new Error(PRIVATE_ERROR); }
  return {
    reader: {
      async listCandidates() {
        observe('list');
        return candidates();
      },
      async readCredentials(id: string) {
        observe('read');
        if (!candidates().some(candidate => candidate.id === id)) throw new JetBrainsIdeImportError('selection', '所选 IDE 账号已不可用，请重新扫描。');
        return { ...(id === SECOND_CANDIDATE_ID ? alternate : id === OTHER_LICENSE_CANDIDATE_ID ? otherLicense : credentials) };
      },
    },
    api: {
      async exchange(value) {
        if (mode() === 'slow') await new Promise(resolve => setTimeout(resolve, 400));
        // `expired` is an authoritative server refusal, never a local verdict
        // based on the cached JBA identity ticket's exp claim.
        if (mode() === 'expired') { observe('exchange'); throw new JetBrainsIdeApiError('authorization'); }
        observe('exchange'); if (mode() === 'failure' || value.idToken !== idToken || ![credentials.licenseId, otherLicense.licenseId].includes(value.licenseId)) throw new Error(PRIVATE_ERROR);
        return { token: GRAZIE_TOKEN, expiresAt: Date.now() + 5 * 60_000 };
      },
      async quota(token): Promise<SubscriptionUsage> {
        observe('quota'); accept(token);
        const wideAmount = store.getManagedState<boolean>('qa-unified-auth-layout', false), remaining = wideAmount ? 3_074_611.8 : 625, total = wideAmount ? 3_500_000 : 1000;
        return { status: 'ready', queriedAt: new Date().toISOString(), windows: [{ id: 'credits', label: 'JetBrains AI Credits', remaining, total, unit: 'AI Credits', remainingPercent: remaining / total * 100, usedPercent: (total - remaining) / total * 100 }], message: '已查询此 IDE 账号的官方 AI Credits（合成演示）。' };
      },
      async models(token) { observe('models'); accept(token); return { data: [{ id: MODEL_ID, object: 'model', name: 'IDE 原生演示模型', context_length: 64000 }, { id: 'qa-claude-profile', object: 'model', name: 'Claude · 原生目录演示', context_length: 200000, tools: true, vision: true }, { id: 'qa-gemini-profile', object: 'model', name: 'Gemini · 原生目录演示', context_length: 1000000, tools: true, vision: true }] }; },
      async chat(token, body, signal) {
        observe('chat'); accept(token); if (signal.aborted) throw new Error(PRIVATE_ERROR);
        store.setManagedState(LAST_CHAT_MODEL_KEY, typeof body.model === 'string' ? body.model : 'invalid-model');
        if (body.model !== MODEL_ID) throw new Error(PRIVATE_ERROR);
        const message = { role: 'assistant', content: 'SYNTHETIC_NATIVE_IDE_CHAT_OK' };
        if (body.stream === true) return new Response(`data: ${JSON.stringify({ id: 'qa-native-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'qa-native-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        return new Response(JSON.stringify({ id: 'qa-native-chat', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
      },
    },
  };
}

/** Uses explicit IDE actions and the fixture ports above. This proves the UI
 * and persistence contract with fake accounts, not a real cloud authorization. */
export async function verifyJetBrainsIdeImport(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  const owned = relative(resolve(outputDir, 'data'), resolve(store.dataDir)); assert.ok(owned && !owned.startsWith('..') && !/^[A-Za-z]:/.test(owned));
  const scope = '[data-relay-client-import="jetbrains-central"]';
  const size = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const screenshots: string[] = [], stages: { mode: string; providerCount: number }[] = [];
  const originalTheme = await evaluate<{ theme?: string; colorScheme: string }>('({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})');
  const observed = () => store.getManagedState<Observed>(OBSERVED_KEY, { list: 0, read: 0, exchange: 0, quota: 0, models: 0, chat: 0 });
  const configuration = () => ({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) });
  const persistentState = () => ({ ...configuration(), metadata: store.listProviders().map(provider => [provider.id, store.getManagedState(`auth-metadata:${provider.id}`, null)]) });
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    writeFileSync(join(outputDir, 'jetbrains-ide-import-timeout.png'), await captureUi()); throw new Error(`JetBrains IDE import UI timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`);
  }
  async function clearToasts(): Promise<void> { await evaluate('document.querySelectorAll(\'.toast-stack [aria-label="关闭提示"]\').forEach(button=>button.click())'); }
  async function close(): Promise<void> { if (await evaluate<boolean>('!!document.querySelector(\'[role="dialog"]\')')) { await click('[aria-label="关闭对话框"]'); await waitFor('!document.querySelector(\'[role="dialog"]\')', 'dialog closed'); } }
  async function privacy(): Promise<void> {
    const payload = await evaluate<string>('(async()=>JSON.stringify({body:document.body.innerText,inputs:[...document.querySelectorAll("input,textarea")].map(node=>node.value),accounts:await window.modelDock.authAccounts(),snapshot:await window.modelDock.snapshot(),diagnostics:await window.modelDock.queryDiagnostics({limit:200})}))()');
    assert.doesNotMatch(payload, /PRIVATE_JETBRAINS_IDE|PRIVATE_IDE_MANUAL_KEY|Error invoking remote method|modeldock:(?:jetBrainsIdeImportCandidates|importJetBrainsIdeAccount|beginJetBrainsIdeImport)/i, 'IDE credentials and raw errors never enter public views or diagnostics');
    for (const provider of store.listProviders()) {
      const metadata = store.getManagedState<{ nativeIde?: { idToken: string } } | null>(`auth-metadata:${provider.id}`, null);
      if (metadata?.nativeIde?.idToken) assert.equal(payload.includes(metadata.nativeIde.idToken), false, 'Raw JBA token stays inside encrypted main-process metadata');
    }
    assert.equal(payload.includes(GRAZIE_TOKEN), false);
  }
  async function capture(name: string, keepToasts = false): Promise<void> {
    if (!keepToasts) await clearToasts(); await privacy();
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    const overflow = await evaluate<{ document: boolean; main: boolean; dialog: boolean }>('(()=>{const main=document.querySelector(".main-content"),dialog=document.querySelector(\'[role="dialog"]\');return {document:document.documentElement.scrollWidth>innerWidth+1,main:main.scrollWidth>main.clientWidth+1,dialog:!!dialog&&dialog.scrollWidth>dialog.clientWidth+1}})()');
    if (overflow.document || overflow.main || overflow.dialog) {
      writeFileSync(join(outputDir, `jetbrains-ide-import-${name}-overflow.png`), await captureUi());
      writeFileSync(join(outputDir, `jetbrains-ide-import-${name}-overflow.json`), JSON.stringify(await evaluate(`({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].map(node=>({tag:node.tagName,classes:String(node.className),left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width,scrollWidth:node.scrollWidth})).filter(node=>node.right>innerWidth+1||node.left< -1).slice(0,40)})`), null, 2));
    }
    assert.deepEqual(overflow, { document: false, main: false, dialog: false }, 'Native IDE import fits narrow and wide layouts');
    const nameOnDisk = `jetbrains-ide-import-${name}.png`; writeFileSync(join(outputDir, nameOnDisk), await captureUi()); screenshots.push(nameOnDisk);
  }
  const importButton = '[data-auth-import-account="jetbrains-central"]';
  async function direct(mode: FixtureMode, repeatedClick = false): Promise<Observed> {
    store.setManagedState(MODE_KEY, mode); await clearToasts(); const before = observed();
    if (repeatedClick) await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(importButton)});button.scrollIntoView({block:'nearest'});button.click();button.click()})()`);
    else await click(importButton);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && observed().list < before.list + 1) await pause(25);
    assert.equal(observed().list, before.list + 1, 'One explicit action performs exactly one native discovery');
    if (mode === 'slow') {
      assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(importButton)}).disabled&&!!document.querySelector(${JSON.stringify(importButton)}+' .spin')`), true, 'The direct import stays disabled with a busy indicator while authorization runs');
      assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Importing never introduces a confirmation dialog');
      await capture('direct-import-busy-dark-980');
    }
    if (mode === 'multiple') await waitFor(`!!document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]')`, 'multiple licenses finish discovery');
    else await waitFor(`!document.querySelector(${JSON.stringify(importButton)}).disabled`, `${mode} direct import finishes`);
    stages.push({ mode, providerCount: store.listProviders().length });
    return before;
  }
  async function choose(id = CANDIDATE_ID): Promise<void> {
    await waitFor(`document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]')?.options.length===2`, 'different licenses require a selection');
    await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]');select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  }
  async function importedAccount(): Promise<AuthAccount> {
    const values = await evaluate<AuthAccount[]>('window.modelDock.authAccounts()'); const account = values.find(value => value.clientImport?.client === 'jetbrains-ide'); assert.ok(account); return account;
  }
  try {
    // A successful Central fixture is deliberately available. IDE failure or
    // empty discovery must not inspect or fall back to that different client.
    store.setManagedState('qa-relay-client-import-stage', 'success'); store.setManagedState(MODE_KEY, 'empty');
    const untouched = observed();
    await click('[aria-label="刷新本机配置"]'); await click('.sidebar [data-page="auth"]');
    await click('.sidebar [data-tool-id="codex"]'); await click('.sidebar [data-page="auth"]'); await pause(100);
    assert.deepEqual(observed(), untouched, 'Startup, refresh and ordinary navigation never scan or import an IDE account');
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(importButton)}).textContent`), '从客户端导入', 'JetBrains matches the native-client import wording');
    const original = configuration();
    for (const [theme, width] of [['light', 1180], ['dark', 980]] as const) {
      window.setMinimumSize(980, 680); window.setSize(width, width === 1180 ? 800 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      const emptyBefore = await direct('empty');
      assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Missing IDE authorization is explained without an import dialog');
      assert.equal(observed().exchange, emptyBefore.exchange); assert.deepEqual(configuration(), original);
      await waitFor('!!document.querySelector(".toast.error")', 'missing native account reports a safe explanation'); await capture(`empty-${theme}-${width}`, true);
      const rejectedBefore = persistentState(), exchangesBefore = observed().exchange;
      await direct('expired');
      await waitFor('!!document.querySelector(".toast.error")&&/授权/.test(document.querySelector(".toast.error").textContent)', 'official server refusal is shown by the direct import action');
      assert.equal(observed().exchange, exchangesBefore + 1); assert.deepEqual(persistentState(), rejectedBefore, 'Server rejection preserves providers, keys, models, bindings and encrypted metadata');
      assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false);
      assert.equal((await evaluate<AuthAccount[]>('window.modelDock.authAccounts()')).some(value => value.clientImport?.client === 'jetbrains-central'), false, 'IDE failures never fall back to Central');
      await capture(`server-rejected-${theme}-${width}`, true);
    }
    const failureBefore = persistentState(); await direct('failure'); await waitFor('!!document.querySelector(".toast.error")', 'raw fixture error is safely displayed');
    await privacy(); assert.deepEqual(persistentState(), failureBefore, 'A failed direct import does not create or replace an account');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false); await capture('failure-dark-980', true);
    const firstImport = await direct('slow', true);
    assert.equal(observed().exchange, firstImport.exchange + 1, 'Rapid duplicate clicks produce one authorization exchange');
    assert.equal(observed().list, firstImport.list + 1, 'Rapid duplicate clicks produce one discovery');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'A single available IDE account imports directly without a confirmation');
    const account = await importedAccount(), provider = store.getProvider(account.providerId); assert.ok(provider);
    assert.equal(account.source, 'relay'); assert.equal(account.accountId, ACCOUNT_ID); assert.equal(account.authStatus, 'ready'); assert.equal(account.canQueryUsage, true); assert.equal(account.clientImport?.upstreamVerified, true);
    assert.equal(provider.presetId, 'jetbrains-central'); assert.equal(provider.baseUrl, JETBRAINS_RELAY_BASE_URL);
    const key = store.getSecret(provider.id)?.apiKey, metadata = store.getManagedState<{ nativeIde: JetBrainsIdeCredentials }>(`auth-metadata:${provider.id}`, { nativeIde: {} as JetBrainsIdeCredentials });
    assert.ok(key && key.length >= 32 && key !== metadata.nativeIde.idToken && key !== GRAZIE_TOKEN, 'The provider receives a distinct local relay key');
    assert.deepEqual(account.usage.windows.map(value => [value.remaining, value.total, value.unit]), [[625, 1000, 'AI Credits']]);
    // Exercise IPC -> catalog/connection tester -> the main-process native
    // adapter -> synthetic API ports. No separate 18081 listener is created.
    const beforeRoundTrip = observed();
    const discovered = await evaluate<DiscoveryResult>(`window.modelDock.discoverModels(${JSON.stringify(provider.id)})`);
    assert.equal(discovered.ok, true, `The main-process native adapter returns the synthetic model directory: ${discovered.message}`);
    assert.deepEqual(discovered.models.map(value => value.upstreamId), [MODEL_ID, 'qa-claude-profile', 'qa-gemini-profile']);
    assert.ok(discovered.models.slice(1).every(value => value.tools && value.vision), 'Native vendor capabilities survive discovery and IPC');
    assert.ok(observed().models > beforeRoundTrip.models, 'Discovery reaches the native fixture through the direct main-process adapter');
    const added = await evaluate<AddModelsResult>(`window.modelDock.addDiscoveredModels(${JSON.stringify(provider.id)},[{upstreamId:${JSON.stringify(MODEL_ID)},alias:'qa-ide-local-alias-for-route-check'}])`);
    assert.equal(added.added.length, 1); const roundTripModel = added.added[0];
    assert.equal(roundTripModel.providerId, provider.id); assert.equal(roundTripModel.upstreamId, MODEL_ID); assert.notEqual(roundTripModel.alias, MODEL_ID);
    const tested = await evaluate<ConnectionResult>(`window.modelDock.testProvider(${JSON.stringify(provider.id)},{modelId:${JSON.stringify(roundTripModel.id)}})`);
    assert.equal(tested.ok, true, `The synthetic native model completes the real local connection test: ${tested.message}`);
    assert.equal(tested.outcome, 'success'); assert.equal(tested.statusCode, 200); assert.equal(tested.wireApi, 'chat-completions'); assert.equal(tested.testedModel, MODEL_ID);
    assert.ok(observed().chat > beforeRoundTrip.chat, 'Connection testing reaches the synthetic native chat adapter');
    assert.equal(store.getManagedState(LAST_CHAT_MODEL_KEY, ''), MODEL_ID, 'Native inference uses its original profile ID rather than the public local alias');
    assert.notEqual(store.getManagedState(LAST_CHAT_MODEL_KEY, ''), roundTripModel.alias);
    const publicRoundTrip = JSON.stringify({ discovered, added, tested });
    assert.doesNotMatch(publicRoundTrip, /PRIVATE_JETBRAINS_IDE|idToken|accessToken|nativeIde/);
    assert.equal(publicRoundTrip.includes(metadata.nativeIde.idToken), false); assert.equal(publicRoundTrip.includes(key), false);
    await privacy();
    await click('[aria-label="刷新本机配置"]'); await click(`[data-source-id="${provider.id}"]`); await click('[data-action="discover-models"]');
    await waitFor(`document.querySelectorAll('.discovery-model').length===3&&!document.querySelector('.discovery-loading,.discovery-error')`, 'OpenAI, Claude and Gemini coexist in native discovery');
    const vendorRows = await evaluate<string[]>(`[...document.querySelectorAll('.discovery-model')].map(row=>row.textContent)`);
    assert.equal(vendorRows.filter(text=>text.includes('qa-claude-profile')).length, 1); assert.equal(vendorRows.filter(text=>text.includes('qa-gemini-profile')).length, 1);
    for (const [theme, width] of [['dark', 980], ['light', 1180]] as const) {
      window.setSize(width, 800); await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`); await capture(`vendor-directory-${theme}-${width}`);
    }
    await close(); await click('[data-page="auth"]');
    const row = `[data-auth-account="${provider.id}"]`;
    await click(`${row} [data-action="account-menu"]`); await click(`[data-auth-account-menu="${provider.id}"] [data-action="relay-account-details"]`);
    await waitFor(`!!document.querySelector('[data-auth-account-details="${provider.id}"] [data-relay-client-source="jetbrains-ide"]')`, 'native IDE source remains visible in account details');
    await close();
    await waitFor(`(()=>{const node=document.querySelector(${JSON.stringify(row)}+' [data-quota-window-id="credits"] strong');return !!node&&/625/.test(node.textContent)&&/1,?000/.test(node.textContent)&&/AI Credits/.test(node.textContent)})()`, 'AI Credits amounts are directly visible');
    for (const [theme, width] of [['dark', 980], ['light', 1180]] as const) {
      window.setSize(width, width === 1180 ? 800 : 680); await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};document.querySelector(${JSON.stringify(row)}).scrollIntoView({block:'nearest'})`);
      await capture(`success-${theme}-${width}`);
    }
    store.saveProvider({ ...provider, name: '我的 IDE 会员连接', note: '重复导入保留的备注', enabled: false });
    const model = store.saveModel({ ...roundTripModel, providerId: provider.id, upstreamId: MODEL_ID, alias: 'qa-native-ide-preserved-alias', displayName: '重复导入保留模型', wireApi: 'chat-completions', contextWindow: 64000, enabled: true, tools: true, vision: false });
    const rider = store.listBindings().find(binding => binding.id === 'rider'); assert.ok(rider);
    store.saveBinding({ ...rider, mode: 'aggregate', enabled: false, providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
    const repeatedBefore = configuration();
    await direct('ready'); assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Re-import also completes directly');
    assert.equal((await importedAccount()).providerId, provider.id); assert.deepEqual(configuration(), repeatedBefore, 'Repeat IDE import preserves supplier identity, custom name/note, key, model and binding');
    await privacy();
    const crossBefore = configuration(); await direct('cross-ide');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'Same account and license across IDEs do not require a choice');
    const crossMetadata = store.getManagedState<{ nativeIde: JetBrainsIdeCredentials }>(`auth-metadata:${provider.id}`, { nativeIde: {} as JetBrainsIdeCredentials });
    assert.equal(crossMetadata.nativeIde.product, 'rider', 'The existing native source is preferred within one account/license identity'); assert.deepEqual(configuration(), crossBefore); await capture('cross-ide-same-license-direct');
    const multipleBefore = persistentState(), beforeChoices = observed(); await direct('multiple');
    await waitFor(`!!document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]')`, 'different native licenses open the sole required selection');
    assert.equal(observed().read, beforeChoices.read); assert.equal(observed().exchange, beforeChoices.exchange); assert.deepEqual(persistentState(), multipleBefore, 'A genuine identity choice performs no authorization or configuration write');
    assert.equal(await evaluate<boolean>('!!document.querySelector("[data-jetbrains-ide-account-boundary]")'), false, 'The necessary choice is not preceded by a connection-method guide');
    for (const [theme, width] of [['dark', 980], ['light', 1180]] as const) {
      window.setSize(width, width === 1180 ? 800 : 680); await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      await capture(`multiple-licenses-choice-${theme}-${width}`);
    }
    await choose(OTHER_LICENSE_CANDIDATE_ID); await click('[data-action="import-relay-client-account"]'); await waitFor(`!document.querySelector('[role="dialog"]')`, 'chosen native license imports');
    const selectedMetadata = store.getManagedState<{ nativeIde: JetBrainsIdeCredentials }>(`auth-metadata:${provider.id}`, { nativeIde: {} as JetBrainsIdeCredentials });
    assert.equal(selectedMetadata.nativeIde.licenseId, 'synthetic-other-native-ide-license');
    assert.deepEqual(configuration(), { providers: multipleBefore.providers, models: multipleBefore.models, bindings: multipleBefore.bindings, secrets: multipleBefore.secrets });
    await capture('multiple-licenses-selected');
    store.setManagedState(MODE_KEY, 'ready'); await clearToasts(); const requestBefore = observed(); await click('[data-auth-add-relay="jetbrains-central"]');
    const requestDeadline = Date.now() + 10_000; while (Date.now() < requestDeadline && observed().exchange <= requestBefore.exchange) await pause(25);
    await waitFor(`!document.querySelector(${JSON.stringify(importButton)}).disabled`, 'explicit App import request completes');
    assert.equal(observed().list, requestBefore.list + 1); assert.equal(observed().exchange, requestBefore.exchange + 1);
    const consumed = observed(); await click('.sidebar [data-tool-id="codex"]'); await click('.sidebar [data-page="auth"]'); await pause(200);
    assert.deepEqual(observed(), consumed, 'Returning to the authorization center does not replay the consumed explicit import request');
    const optionsBefore = observed(); await click('[data-action="jetbrains-import-options"]'); await waitFor('!!document.querySelector("[data-jetbrains-ide-account-boundary]")', 'alternate connection options open only by their explicit action');
    assert.deepEqual(observed(), optionsBefore, 'Opening alternate connection options does not inspect IDE or Central login'); await capture('explicit-other-connection-options'); await close();
    await privacy();
    writeFileSync(join(outputDir, 'jetbrains-ide-import-validation.json'), JSON.stringify({ ok: true, defaultIdeImportWithoutDialog: true, singleActionBusyAndDuplicateGuard: true, crossIdeSameLicenseAutoDeduplicated: true, ambiguousLicenseChoiceRequired: true, ordinaryNavigationDoesNotImport: true, consumedImportRequestNeverReplays: true, centralRemainsExplicitAlternative: true, emptyAndServerRejectedIdeNeverFallBackToCentral: true, serverRejectionOccursDuringDirectImport: true, privateFailuresDoNotWriteProviders: true, nativeImportUsesIndependentLocalKey: true, sourceIsJetBrainsIde: true, aiCreditsAmountsVisible: true, mockNativeDirectoryAndConnectionVerified: true, nativeTestUsesOriginalProfileId: true, mockedConnection: { model: tested.testedModel, alias: roundTripModel.alias, wireApi: tested.wireApi, statusCode: tested.statusCode, outcome: tested.outcome }, repeatedImportPreservesConfiguration: true, rendererAndDiagnosticsContainNoPrivateCredentials: true, noRealIdeFilesCentralLoginOrCloudInference: true, observed: observed(), stages, screenshots }, null, 2));
  } finally {
    store.setManagedState(MODE_KEY, 'empty'); store.setManagedState('qa-relay-client-import-stage', 'empty');
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
