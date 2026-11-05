import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AuthAccount, SubscriptionUsage } from '../shared/auth-types';
import type { AddModelsResult, DiscoveryResult } from '../shared/catalog-types';
import type { ConnectionResult } from '../shared/connection-types';
import { JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import type { JetBrainsIdeApiPort } from './jetbrains-ide-account';
import { JetBrainsIdeApiError } from './jetbrains-ide-api';
import { JetBrainsIdeImportError, type JetBrainsIdeCredentials, type JetBrainsIdeImporter } from './jetbrains-ide-import';
import type { Store } from './store';

const CANDIDATE_ID = 'd765c058-c4e5-4d93-9a6d-5b54fcb3c4ca';
const ACCOUNT_ID = 'qa-native-ide-account';
const ACCOUNT_LABEL = 'Rider 演示账号';
const GRAZIE_TOKEN = 'PRIVATE_JETBRAINS_IDE_GRAZIE_TOKEN';
const PRIVATE_ERROR = 'PRIVATE_JETBRAINS_IDE_RAW_TOKEN_PATH_BODY';
const MODEL_ID = 'qa-native-ide-profile';
const MODE_KEY = 'qa-jetbrains-ide-mode';
const OBSERVED_KEY = 'qa-jetbrains-ide-observed';
const LAST_CHAT_MODEL_KEY = 'qa-jetbrains-ide-last-chat-model';
type FixtureMode = 'empty' | 'expired' | 'failure' | 'ready';
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
  const mode = () => store.getManagedState<FixtureMode>(MODE_KEY, 'empty');
  function observe(key: keyof Observed): void {
    const value = store.getManagedState<Observed>(OBSERVED_KEY, { list: 0, read: 0, exchange: 0, quota: 0, models: 0, chat: 0 });
    store.setManagedState(OBSERVED_KEY, { ...value, [key]: value[key] + 1 });
  }
  function accept(token: string): void { if (token !== GRAZIE_TOKEN || mode() === 'failure') throw new Error(PRIVATE_ERROR); }
  return {
    reader: {
      async listCandidates() {
        observe('list');
        if (mode() === 'empty') return [];
        return [{ id: CANDIDATE_ID, client: 'jetbrains-ide', clientName: 'Rider 2026.2', product: credentials.product, sourceIdentity: credentials.sourceIdentity, accountId: credentials.accountId, accountLabel: credentials.accountLabel, sourceTokenExpHint }];
      },
      async readCredentials(id: string) {
        observe('read');
        if (mode() === 'empty' || id !== CANDIDATE_ID) throw new JetBrainsIdeImportError('selection', '所选 IDE 账号已不可用，请重新扫描。');
        return { ...credentials };
      },
    },
    api: {
      async exchange(value) {
        // `expired` is an authoritative server refusal, never a local verdict
        // based on the cached JBA identity ticket's exp claim.
        if (mode() === 'expired') { observe('exchange'); throw new JetBrainsIdeApiError('authorization'); }
        observe('exchange'); if (mode() === 'failure' || value.idToken !== idToken || value.licenseId !== credentials.licenseId) throw new Error(PRIVATE_ERROR);
        return { token: GRAZIE_TOKEN, expiresAt: Date.now() + 5 * 60_000 };
      },
      async quota(token): Promise<SubscriptionUsage> {
        observe('quota'); accept(token);
        return { status: 'ready', queriedAt: new Date().toISOString(), windows: [{ id: 'credits', label: 'JetBrains AI Credits', remaining: 625, total: 1000, unit: 'AI Credits', remainingPercent: 62.5, usedPercent: 37.5 }], message: '已查询此 IDE 账号的官方 AI Credits（合成演示）。' };
      },
      async models(token) { observe('models'); accept(token); return { data: [{ id: MODEL_ID, object: 'model', name: 'IDE 原生演示模型', context_length: 64000 }] }; },
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
    assert.doesNotMatch(payload, /PRIVATE_JETBRAINS_IDE|PRIVATE_IDE_MANUAL_KEY|Error invoking remote method|modeldock:(?:jetBrainsIdeImportCandidates|importJetBrainsIdeAccount)/i, 'IDE credentials and raw errors never enter public views or diagnostics');
    for (const provider of store.listProviders()) {
      const metadata = store.getManagedState<{ nativeIde?: { idToken: string } } | null>(`auth-metadata:${provider.id}`, null);
      if (metadata?.nativeIde?.idToken) assert.equal(payload.includes(metadata.nativeIde.idToken), false, 'Raw JBA token stays inside encrypted main-process metadata');
    }
    assert.equal(payload.includes(GRAZIE_TOKEN), false);
  }
  async function capture(name: string, keepToasts = false): Promise<void> {
    if (!keepToasts) await clearToasts(); await privacy();
    const overflow = await evaluate<{ document: boolean; main: boolean; dialog: boolean }>('(()=>{const main=document.querySelector(".main-content"),dialog=document.querySelector(\'[role="dialog"]\');return {document:document.documentElement.scrollWidth>innerWidth+1,main:main.scrollWidth>main.clientWidth+1,dialog:!!dialog&&dialog.scrollWidth>dialog.clientWidth+1}})()');
    assert.deepEqual(overflow, { document: false, main: false, dialog: false }, 'Native IDE import fits narrow and wide layouts');
    const nameOnDisk = `jetbrains-ide-import-${name}.png`; writeFileSync(join(outputDir, nameOnDisk), await captureUi()); screenshots.push(nameOnDisk);
  }
  async function open(): Promise<void> {
    await clearToasts(); const before = observed(); await click('[data-auth-import-account="jetbrains-central"]');
    await waitFor(`!!document.querySelector(${JSON.stringify(scope)}+' [data-action="scan-jetbrains-ide"]')`, 'explicit IDE scan action');
    assert.equal(observed().list, before.list, 'Opening the connection choices does not read IDE credentials');
    assert.equal(await evaluate<number>(`document.querySelectorAll(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"] option').length`), 0, 'The guide does not silently select a Central or IDE account');
  }
  async function scan(mode: FixtureMode): Promise<void> {
    store.setManagedState(MODE_KEY, mode); const before = observed().list; await click(`${scope} [data-action="scan-jetbrains-ide"]`);
    await waitFor(`document.querySelector(${JSON.stringify(scope)})?.getAttribute('aria-busy')==='false'`, `${mode} scan finishes`);
    assert.equal(observed().list, before + 1, 'The explicit scan uses the native IDE reader');
    stages.push({ mode, providerCount: store.listProviders().length });
  }
  async function choose(): Promise<void> {
    await waitFor(`document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]')?.options.length===1`, 'one synthetic IDE account');
    const option = await evaluate<{ value: string; label: string }>(`(()=>{const option=document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"] option');return {value:option.value,label:option.textContent}})()`);
    assert.equal(option.value, CANDIDATE_ID); assert.ok(option.label.includes('Rider') && option.label.includes(ACCOUNT_LABEL));
    await evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"]');select.value=${JSON.stringify(CANDIDATE_ID)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  }
  async function importedAccount(): Promise<AuthAccount> {
    const values = await evaluate<AuthAccount[]>('window.modelDock.authAccounts()'); const account = values.find(value => value.clientImport?.client === 'jetbrains-ide'); assert.ok(account); return account;
  }
  try {
    // A successful Central fixture is deliberately available. Empty discovery
    // or a server-refused IDE login must not fall back to that other client.
    store.setManagedState('qa-relay-client-import-stage', 'success');
    store.setManagedState(MODE_KEY, 'empty');
    await click('[aria-label="刷新本机配置"]'); await click('.sidebar [data-page="auth"]');
    const original = configuration();
    for (const [theme, width] of [['light', 1180], ['dark', 980]] as const) {
      window.setMinimumSize(980, 680); window.setSize(width, width === 1180 ? 800 : 680);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
      await open(); await capture(`entry-${theme}-${width}`);
      await scan('empty');
      assert.equal(await evaluate<number>(`document.querySelectorAll(${JSON.stringify(scope)}+' [data-field="relay-import-candidate"] option').length`), 0);
      assert.equal(await evaluate<boolean>('document.querySelector(\'[data-action="import-relay-client-account"]\').disabled'), true);
      await capture(`empty-${theme}-${width}`); await close();
      await open(); await scan('expired');
      await choose();
      const rejectedBefore = persistentState(), exchangesBefore = observed().exchange;
      assert.equal(await evaluate<boolean>('document.querySelector(\'[data-action="import-relay-client-account"]\').disabled'), false, 'A discovered IDE choice remains actionable until the server checks its authorization');
      await click('[data-action="import-relay-client-account"]');
      await waitFor(`!!document.querySelector('.toast.error')&&/授权/.test(document.querySelector('.toast.error').textContent)`, 'official server refusal is shown after import confirmation');
      assert.equal(observed().exchange, exchangesBefore + 1, 'The selected identity reaches the authoritative exchange before rejection');
      assert.deepEqual(persistentState(), rejectedBefore, 'Server rejection leaves providers, keys, models, bindings and encrypted metadata unchanged');
      assert.equal((await evaluate<AuthAccount[]>('window.modelDock.authAccounts()')).some(value => value.clientImport?.client === 'jetbrains-central'), false, 'Rejected IDE credentials do not fall back to Central');
      await capture(`server-rejected-${theme}-${width}`, true); await close();
      await open(); await scan('ready'); await choose(); await capture(`preview-${theme}-${width}`); await close();
    }
    assert.deepEqual(configuration(), original, 'Scanning never writes providers, keys, models, or tool choices');
    await evaluate("document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light'");
    await open(); await scan('ready'); await choose(); await capture('preview-light-980'); await close();
    await evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'");
    await open(); await scan('failure'); await choose(); const failureBefore = persistentState();
    await click('[data-action="import-relay-client-account"]'); await waitFor('!!document.querySelector(".toast.error")', 'raw fixture error is safely displayed');
    await privacy(); assert.deepEqual(persistentState(), failureBefore, 'An upstream authorization failure does not create or replace a supplier or its encrypted metadata');
    assert.equal((await evaluate<AuthAccount[]>('window.modelDock.authAccounts()')).some(value => value.clientImport?.client === 'jetbrains-central'), false, 'Failed native IDE import does not fall back to Central');
    await capture('failure-dark-980', true); await close();
    await open(); await scan('ready'); await choose(); await click('[data-action="import-relay-client-account"]'); await waitFor('!document.querySelector(\'[role="dialog"]\')', 'native import succeeds');
    const account = await importedAccount(), provider = store.getProvider(account.providerId); assert.ok(provider);
    assert.equal(account.source, 'relay'); assert.equal(account.accountId, ACCOUNT_ID); assert.equal(account.authStatus, 'ready'); assert.equal(account.canQueryUsage, true); assert.equal(account.clientImport?.upstreamVerified, true);
    assert.equal(provider.presetId, 'jetbrains-central'); assert.equal(provider.baseUrl, JETBRAINS_RELAY_BASE_URL);
    const key = store.getSecret(provider.id)?.apiKey, metadata = store.getManagedState<{ nativeIde: JetBrainsIdeCredentials }>(`auth-metadata:${provider.id}`, { nativeIde: {} as JetBrainsIdeCredentials });
    assert.ok(key && key.length >= 32 && key !== metadata.nativeIde.idToken && key !== GRAZIE_TOKEN, 'The provider receives a distinct local relay key');
    assert.deepEqual(account.usage.windows.map(value => [value.remaining, value.total, value.unit]), [[625, 1000, 'AI Credits']]);
    // Exercise IPC -> catalog/connection tester -> account preparation -> the
    // owned real loopback facade -> synthetic native API ports. QA rewrites
    // only the fixed 18081 destination to this process's ephemeral listener.
    const beforeRoundTrip = observed();
    const discovered = await evaluate<DiscoveryResult>(`window.modelDock.discoverModels(${JSON.stringify(provider.id)})`);
    assert.equal(discovered.ok, true, `The owned native facade returns the synthetic model directory: ${discovered.message}`);
    assert.deepEqual(discovered.models.map(value => value.upstreamId), [MODEL_ID]);
    assert.ok(observed().models > beforeRoundTrip.models, 'Discovery reaches the native fixture through the real local facade');
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
    const row = `[data-auth-account="${provider.id}"]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(row)}+' [data-relay-client-source="jetbrains-ide"]')`, 'native IDE source is visible immediately');
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
    await open(); await scan('ready'); await choose(); await click('[data-action="import-relay-client-account"]'); await waitFor('!document.querySelector(\'[role="dialog"]\')', 'native re-import succeeds');
    assert.equal((await importedAccount()).providerId, provider.id); assert.deepEqual(configuration(), repeatedBefore, 'Repeat IDE import preserves supplier identity, custom name/note, key, model and binding');
    await privacy();
    writeFileSync(join(outputDir, 'jetbrains-ide-import-validation.json'), JSON.stringify({ ok: true, explicitIdeScanRequired: true, emptyAndServerRejectedIdeNeverFallBackToCentral: true, serverRejectionOccursAfterExplicitImport: true, privateFailuresDoNotWriteProviders: true, nativeImportUsesIndependentLocalKey: true, sourceIsJetBrainsIde: true, aiCreditsAmountsVisible: true, mockNativeDirectoryAndConnectionVerified: true, nativeTestUsesOriginalProfileId: true, mockedConnection: { model: tested.testedModel, alias: roundTripModel.alias, wireApi: tested.wireApi, statusCode: tested.statusCode, outcome: tested.outcome }, repeatedImportPreservesConfiguration: true, rendererAndDiagnosticsContainNoPrivateCredentials: true, noRealIdeFilesCentralLoginOrCloudInference: true, observed: observed(), stages, screenshots }, null, 2));
  } finally {
    store.setManagedState(MODE_KEY, 'empty'); store.setManagedState('qa-relay-client-import-stage', 'empty');
    await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`);
    window.setMinimumSize(minimum[0], minimum[1]); window.setSize(size[0], size[1]);
  }
}
