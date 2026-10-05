import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { Store } from './store';
import type { Model, Provider, Snapshot, ToolBinding } from '../shared/types';
import { buildCopilotDesktopPlan } from './adapters';
import { CopilotDesktopClient, type CopilotDesktopPlan, type CopilotNativeModel, type CopilotNativeProvider } from './copilot-desktop';

/** Actual React -> IPC -> running Copilot, restricted to an explicit fake profile. */
export async function verifyCopilotDesktop(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>, copilotHome: string): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream, 'Copilot smoke requires explicit fixture isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const below = (root: string, file: string) => { const value = relative(resolve(root), resolve(file)); return value && !value.startsWith('..') && !/^[A-Za-z]:/.test(value); };
  assert.ok(below(join(smokeDir, 'data'), dataDir), 'ModelDock database must stay below the smoke data directory');
  const home = realpathSync(copilotHome), work = dirname(home);
  assert.equal(basename(work).toLowerCase(), 'work'); assert.equal(basename(dirname(work)).toLowerCase(), 'model-dock');
  assert.match(basename(home), /^copilot-native-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.ok(below(work, realpathSync(outputDir)), 'Copilot native fixture and smoke artifacts must share the repository work directory');
  assert.ok(below(realpathSync(join(smokeDir, 'data')), realpathSync(dataDir)), 'ModelDock database must not escape through a directory link');
  const markerFile = join(home, 'modeldock-isolation.json'); assert.ok(statSync(markerFile).size < 1024);
  let marker: { version: number; pid: number };
  try { marker = JSON.parse(readFileSync(markerFile, 'utf8')) as typeof marker; } catch { throw new Error('Copilot isolation marker is malformed'); }
  assert.ok(marker && typeof marker === 'object' && !Array.isArray(marker));
  assert.ok(isDeepStrictEqual(Object.keys(marker).sort(), ['pid', 'version']) && marker.version === 1, 'Copilot isolation marker has an unsupported shape');
  assert.ok(Number.isSafeInteger(marker.pid) && marker.pid > 0 && marker.pid !== process.pid, 'Marker must designate the isolated Copilot process');
  const portFile = join(home, 'run', 'ws.release.port'), tokenFile = join(home, 'run', 'ws.release.token');
  assert.ok(below(home, realpathSync(portFile)) && below(home, realpathSync(tokenFile)), 'Native metadata must stay inside the isolated profile');
  assert.ok(statSync(portFile).size < 128 && statSync(tokenFile).size < 1024);
  const port = /^(\d{1,5})\r?\n(\d+)\r?\n?$/.exec(readFileSync(portFile, 'utf8'));
  assert.ok(port && Number(port[2]) === marker.pid, 'Native metadata PID must match the isolation marker');
  // The client validates the private token's PID and shape internally. The
  // smoke helper never reads credential values or the WebSocket token itself.
  const mockUrl = new URL(upstream); assert.equal(mockUrl.protocol, 'http:'); assert.equal(mockUrl.hostname, '127.0.0.1');
  assert.ok(mockUrl.port && !mockUrl.username && !mockUrl.password && !mockUrl.search && !mockUrl.hash); mockUrl.pathname = '/v1';
  const baseUrl = mockUrl.href.replace(/\/$/, '');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    throw new Error(`Copilot native smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function binding(): Promise<ToolBinding> {
    const value = (await evaluate<Snapshot>('window.modelDock.snapshot()')).bindings.find(item => item.id === 'copilot'); assert.ok(value); return value;
  }
  async function setSearch(value: string): Promise<void> {
    await evaluate(`(()=>{const input=document.querySelector('[aria-label="搜索供应商"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('[aria-label="搜索供应商"]')?.value===${JSON.stringify(value)}`, 'native source search settled');
  }
  const copilotBackups = () => readdirSync(join(dataDir, 'backups')).filter(name => name.startsWith('copilot-sync-'));
  async function assertBindingSources(expected: string[], label: string): Promise<void> {
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='copilot');return JSON.stringify(b.providerIds)===${JSON.stringify(JSON.stringify(expected))}&&!document.querySelector('[data-action="apply-tool-config"]').disabled})()`, label);
  }
  async function settled(label: string): Promise<void> {
    await waitFor(`(()=>{const summary=document.querySelector('[data-tool-binding="copilot"]'),status=document.querySelector('[data-tool-application-status]'),button=document.querySelector('[data-action="apply-tool-config"]');return !!summary&&status?.dataset.toolApplicationState===(summary.dataset.selectedModelCount==='0'?'cleared':'synced')&&button&&!button.disabled&&!document.querySelector('[data-tool-sync-error]')})()`, label);
    const location = await evaluate<string>(`document.querySelector('.tool-inline-delivery code')?.textContent??''`);
    assert.ok(resolve(location).toLowerCase() === resolve(home, 'data.db').toLowerCase(), 'Copilot apply must target the isolated native database');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false);
  }
  const native = await CopilotDesktopClient.open(home, { verifyProcess: async pid => pid === marker.pid });
  const protectedProviders = (await native.listProviders()).filter(provider => provider.kind !== 'custom' || provider.accountId);
  // A fresh isolated profile is intentionally signed out and may contain no
  // account-linked provider. Existing protected rows are checked unchanged;
  // creating or importing an account is outside this native UI fixture.
  const protectedEntries = await Promise.all(protectedProviders.map(async provider => ({ provider, models: await native.listModels(provider.id) })));
  const sentinelId = randomUUID(), sentinelModel = randomUUID();
  const sentinel: CopilotDesktopPlan = { providers: [{ id: sentinelId, name: 'Unmanaged sentinel', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'SYNTHETIC_COPILOT_SENTINEL', models: [{ id: sentinelModel, modelId: 'foreign-copilot-model', displayName: 'Foreign sentinel', wireApi: 'chat' }] }] };
  const observedOwned = new Set<string>(), checks: Array<{ label: string; sources: number; models: number }> = [];
  const apiProviders: Provider[] = [], apiModels: Model[] = [];
  let foreignProvider: CopilotNativeProvider | undefined, foreignModels: CopilotNativeModel[] = [];
  let sentinelCreated = false;
  let foreignExpected = true;
  const layouts: unknown[] = [];
  let validation: Record<string, unknown> | undefined;
  async function assertProtected(client: CopilotDesktopClient): Promise<void> {
    const providers = await client.listProviders();
    for (const before of protectedEntries) {
      assert.ok(isDeepStrictEqual(providers.find(provider => provider.id === before.provider.id), before.provider), 'GitHub/account provider metadata must remain unchanged');
      assert.ok(isDeepStrictEqual(await client.listModels(before.provider.id), before.models), 'GitHub/account models must remain unchanged');
    }
  }
  async function assertNative(expectedSources: string[], label: string): Promise<void> {
    const snapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
    const actualBinding = snapshot.bindings.find(item => item.id === 'copilot'); assert.ok(actualBinding);
    assert.deepEqual(actualBinding.providerIds, expectedSources); assert.equal(actualBinding.mode, 'direct'); assert.equal(actualBinding.modelSelection, 'all'); assert.deepEqual(actualBinding.modelIds, []);
    const plan = buildCopilotDesktopPlan(store, snapshot.gateway.port, false);
    for (const p of plan.providers) observedOwned.add(p.id);
    assert.equal(plan.providers.length, expectedSources.length);
    const providers = await native.listProviders(), foreign = providers.find(p => p.id === sentinelId);
    if (foreignExpected) {
      assert.ok(isDeepStrictEqual(foreign, foreignProvider), 'Managed scope must preserve unmanaged native supplier metadata');
      assert.ok(isDeepStrictEqual(await native.listModels(sentinelId), foreignModels), 'Managed scope must preserve unmanaged native models');
    } else assert.equal(foreign, undefined, 'Selected scope must remove the old unmanaged custom source');
    await assertProtected(native);
    const expectedIds = plan.providers.map(p => p.id), ownedPresent = providers.filter(p => observedOwned.has(p.id));
    assert.deepEqual(new Set(ownedPresent.map(p => p.id)), new Set(expectedIds), 'Native registry must reflect exactly the selected ModelDock sources');
    if (actualBinding.copilotSyncScope === 'selected') assert.deepEqual(new Set(providers.filter(provider => provider.kind === 'custom' && !provider.accountId).map(provider => provider.id)), new Set(expectedIds), 'Selected scope must retain only selected unlinked custom providers');
    for (const wanted of plan.providers) {
      const saved = ownedPresent.find(p => p.id === wanted.id); assert.ok(saved);
      assert.equal(saved.kind, 'custom'); assert.equal(saved.name, wanted.name); assert.equal(saved.hasSecret, true);
      assert.equal(saved.settings.baseUrl, wanted.baseUrl); assert.equal(saved.settings.authKind, 'api_key');
      assert.ok(!/synthetic-copilot-one|synthetic-copilot-two|synthetic-copilot-delete|synthetic-only|SYNTHETIC_COPILOT_SENTINEL|SYNTHETIC_FOREIGN|MOCK_ACCESS|MOCK_REFRESH/.test(JSON.stringify(saved)), 'Native supplier metadata must not contain credential values');
      const models = await native.listModels(saved.id); assert.equal(models.length, wanted.models.length);
      for (const model of wanted.models) {
        const stored = models.find(m => m.id === model.id); assert.ok(stored);
        assert.equal(stored.modelId, model.modelId); assert.equal(stored.wireModel, model.wireModel); assert.equal(stored.displayName, model.displayName);
        assert.equal(stored.wireApiOverride, model.wireApi === 'responses' ? 'responses' : 'completions');
        assert.equal(stored.maxPromptTokens, model.contextWindow || undefined); assert.equal(stored.maxOutputTokens, model.maxOutputTokens);
      }
    }
    const renderer = await evaluate<string>('document.body.innerText');
    assert.ok(!/synthetic-copilot-one|synthetic-copilot-two|synthetic-copilot-delete|synthetic-only|SYNTHETIC_COPILOT_SENTINEL|SYNTHETIC_FOREIGN|MOCK_ACCESS|MOCK_REFRESH/.test(renderer), 'Renderer must hide fixture credentials');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false);
    checks.push({ label, sources: expectedSources.length, models: plan.providers.reduce((n, p) => n + p.models.length, 0) });
  }
  async function select(providerId: string, checked: boolean): Promise<void> {
    const before = await binding(), expected = checked ? [...(before.providerIds ?? []), providerId] : (before.providerIds ?? []).filter(id => id !== providerId);
    const selector = `article[data-provider-id="${providerId}"] [data-action="select-tool-provider"]`;
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)})?.checked`), !checked);
    await click(selector);
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='copilot'),c=document.querySelector(${JSON.stringify(selector)});return JSON.stringify(b.providerIds)===${JSON.stringify(JSON.stringify(expected))}&&c?.checked===${checked}&&!c.disabled})()`, 'native checkbox persisted');
    for (const provider of buildCopilotDesktopPlan(store, (await evaluate<Snapshot>('window.modelDock.snapshot()')).gateway.port, false).providers) observedOwned.add(provider.id);
    await settled('checkbox automatically applied native registry'); await assertNative(expected, checked ? 'select' : 'deselect');
  }
  async function rememberOwnedSources(providerIds: string[]): Promise<void> {
    const projected = { dataDir: store.dataDir, listModels: () => store.listModels(), listProviders: () => store.listProviders(), getProvider: (id: string) => store.getProvider(id), gatewayKey: () => '', listBindings: () => store.listBindings().map(b => b.id === 'copilot' ? { ...b, mode: 'direct' as const, modelSelection: 'all' as const, enabled: providerIds.length > 0, providerIds, modelIds: [], defaultModelId: '' } : b) };
    for (const provider of buildCopilotDesktopPlan(projected, (await evaluate<Snapshot>('window.modelDock.snapshot()')).gateway.port, false).providers) observedOwned.add(provider.id);
  }
  async function deleteInUi(providerId: string, name: string): Promise<void> {
    const selector = `article[data-provider-id="${providerId}"] [data-action="delete-provider"]`;
    assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`), true, 'Every tool source card must expose global deletion');
    await click(selector);
    await waitFor(`document.querySelector('[role="dialog"] .confirm-description')?.textContent.includes('全部工具')&&document.querySelector('[role="dialog"] #modal-title')?.textContent.includes(${JSON.stringify(name)})`, 'global source deletion is explicitly confirmed');
    await click('[role="dialog"] .modal-footer .button.danger');
    await waitFor(`(async()=>{const s=await window.modelDock.snapshot();return !s.providers.some(p=>p.id===${JSON.stringify(providerId)})&&!s.models.some(m=>m.providerId===${JSON.stringify(providerId)})&&!document.querySelector('[role="dialog"]')})()`, 'global deletion completed through the real dialog handler');
  }
  function readVscodeGroups(): { name: string; modelIds: string[] }[] {
    const file = join(dataDir!, 'feature-appdata', 'Code', 'User', 'chatLanguageModels.json');
    assert.ok(below(dataDir!, file) && existsSync(file), 'VS Code deletion readback must use the isolated fixture profile');
    const errors: ParseError[] = [], rows = parseJsonc(readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
    assert.equal(errors.length, 0); assert.ok(Array.isArray(rows));
    // Only source/model identifiers are projected. Credential fields are never
    // read, compared or emitted by this helper.
    return rows.filter((row: any) => row.vendor === 'customendpoint' && typeof row.name === 'string' && row.name.startsWith('ModelDock')).map((row: any) => ({ name: row.name, modelIds: row.models.map((model: any) => model.id) }));
  }
  try {
    assert.equal(resolve((await evaluate<Snapshot>('window.modelDock.snapshot()')).dataDir), resolve(dataDir));
    sentinelCreated = true; await native.sync(sentinel, { ownedProviderIds: [sentinelId] });
    foreignProvider = (await native.listProviders()).find(p => p.id === sentinelId); assert.ok(foreignProvider); foreignModels = await native.listModels(sentinelId);
    const prefix = '等待授权回归测试';
    for (const [index, suffix] of ['Copilot A', 'Copilot B'].entries()) {
      const provider = store.saveProvider({ name: `${prefix} · ${suffix}`, kind: 'openai-compatible', presetId: 'custom', baseUrl, enabled: true, apiKey: index ? 'synthetic-copilot-two' : 'synthetic-copilot-one' }); apiProviders.push(provider);
      for (const [upstreamId, displayName, wireApi] of [['copilot-shared', '同名 Chat 模型', 'chat-completions'], ['copilot-responses', 'Responses 模型', 'responses']] as const) apiModels.push(store.saveModel({ providerId: provider.id, upstreamId, alias: upstreamId, displayName, wireApi, contextWindow: 64000, tools: true, vision: false, enabled: true }));
    }
    const subscription = store.listProviders().find(p => p.kind === 'codex' && p.name === prefix);
    assert.ok(subscription?.hasSecret && subscription.authStatus === 'ready', 'Native mocked Codex authorization must run first');
    // MOCK_AUTH plus fixture-directory isolation is the provenance boundary;
    // this helper does not decrypt or inspect OAuth/OS credential material.
    const subscriptionModels = store.listModels().filter(m => m.providerId === subscription.id && m.enabled); assert.equal(subscriptionModels.length, 1);
    assert.equal(new Set(apiModels.map(m => m.alias)).size, 4);
    await evaluate(`document.querySelector('[aria-label="关闭对话框"]')?.click();document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    const before = await binding();
    assert.equal(before.copilotSyncScope ?? 'selected', 'selected', 'A new Copilot binding must default to selected-only synchronization');
    await click('[aria-label="刷新本机配置"]'); await click('[data-page="tools"][data-tool-id="copilot"]');
    await waitFor(`document.querySelector('[data-action="copilot-only-selected"]')?.checked===true`, 'new selected-only option defaults to checked');
    const selected = [...apiProviders.map(p => p.id), subscription.id];
    // Derive the stable cleanup IDs before clicking anything, including an
    // interrupted first write. This projection never mutates a binding.
    const projected = { dataDir: store.dataDir, listModels: () => store.listModels(), listProviders: () => store.listProviders(), getProvider: (id: string) => store.getProvider(id), gatewayKey: () => '', listBindings: () => store.listBindings().map(b => b.id === 'copilot' ? { ...b, mode: 'direct' as const, modelSelection: 'all' as const, enabled: true, providerIds: selected, modelIds: [], defaultModelId: apiModels[0].id } : b) };
    for (const p of buildCopilotDesktopPlan(projected, (await evaluate<Snapshot>('window.modelDock.snapshot()')).gateway.port, false).providers) observedOwned.add(p.id);
    await evaluate(`window.modelDock.saveBinding(${JSON.stringify({ ...before, mode: 'direct', modelSelection: 'all', enabled: false, providerIds: [], modelIds: [], defaultModelId: '', copilotSyncScope: 'managed' })})`);
    await click('[aria-label="刷新本机配置"]'); await click('[data-page="settings"]'); await click('[data-theme-choice="dark"]');
    await waitFor(`document.documentElement.dataset.theme==='dark'`, 'native tool dark theme');
    await click('[data-page="tools"][data-tool-id="copilot"]'); await waitFor(`!!document.querySelector('[data-tool-binding="copilot"]')`, 'native Copilot tool selected');
    assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="copilot-only-selected"]').checked`), false, 'Preserve-foreign baseline must explicitly opt into managed-only scope');
    await setSearch(prefix);
    await waitFor(`document.querySelectorAll('[data-action="select-tool-provider"]').length===3`, 'three fixture sources shown');
    await click('[data-action="apply-tool-config"]'); await settled('empty native binding initially cleared'); await assertNative([], 'initial-empty');
    for (const providerId of selected) await select(providerId, true);
    const complete = buildCopilotDesktopPlan(store, (await evaluate<Snapshot>('window.modelDock.snapshot()')).gateway.port, false);
    assert.equal(complete.providers.length, 3); assert.equal(complete.providers.reduce((n, p) => n + p.models.length, 0), 5);
    assert.equal(complete.providers[0].models[0].modelId, complete.providers[1].models[0].modelId, 'Independent native sources may publish identical local model IDs');
    assert.equal(complete.providers[0].models[0].wireModel, 'copilot-shared'); assert.equal(complete.providers[1].models[0].wireModel, 'copilot-shared');
    assert.equal(complete.providers[2].models[0].wireModel, subscriptionModels[0].alias, 'Subscription must keep its globally routed local model ID');
    assert.ok(complete.providers[2].baseUrl.includes('/tool/copilot/v1'));
    const preferred = apiModels.find(m => m.providerId === apiProviders[1].id && m.wireApi === 'responses'); assert.ok(preferred);
    await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(preferred.id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='copilot');return b.defaultModelId===${JSON.stringify(preferred.id)}&&!document.querySelector('[data-action="tool-default-model"]').disabled})()`, 'Copilot preferred model stored');
    await settled('preferred model resynchronized'); await assertNative(selected, 'preferred-model');
    assert.ok(isDeepStrictEqual(complete, buildCopilotDesktopPlan(store, (await evaluate<Snapshot>('window.modelDock.snapshot()')).gateway.port, false)), 'Preferred model changes binding, not the native provider/model registry contents');
    await click('[data-action="preview-tool-config"]'); await waitFor(`!!document.querySelector('.config-code')`, 'native config preview');
    const preview = await evaluate<string>(`document.querySelector('.config-code').textContent`); assert.ok(!/synthetic-copilot-one|synthetic-copilot-two|MOCK_ACCESS|MOCK_REFRESH/.test(preview), 'Config preview must redact credential values'); assert.equal(JSON.parse(preview).providers.length, 3);
    await click('[aria-label="关闭对话框"]'); await click('[data-action="apply-tool-config"]'); await settled('native manual retry completed'); await assertNative(selected, 'manual-retry');
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await pause(150);
      await evaluate(`document.querySelector('.main-content').scrollTop=0`);
      const layout = await evaluate<{ documentOverflow: boolean; mainOverflow: boolean; controlsVisible: boolean; allCheckboxesVisible: boolean; firstSelectedCheckboxVisible: boolean; deleteIcons: number; checkboxes: number; dark: boolean }>(`(()=>{const main=document.querySelector('.main-content'),sidebar=document.querySelector('.sidebar'),inside=c=>{const r=c.getBoundingClientRect();return r.left>=sidebar.getBoundingClientRect().right-1&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;},controls=Array.from(document.querySelectorAll('.tool-inline-summary button,.tool-inline-summary select,[data-action="copilot-only-selected"],[data-action="select-all-tool-providers"],[data-action="clear-tool-providers"]')),checkboxes=Array.from(document.querySelectorAll('[data-action="select-tool-provider"]'));return {documentOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,controlsVisible:controls.length>=6&&controls.every(inside),allCheckboxesVisible:checkboxes.every(inside),firstSelectedCheckboxVisible:!!checkboxes.find(c=>c.checked&&inside(c)),deleteIcons:document.querySelectorAll('[data-action="delete-provider"]').length,checkboxes:checkboxes.length,dark:document.documentElement.dataset.theme==='dark'}})()`);
      assert.equal(layout.documentOverflow, false); assert.equal(layout.mainOverflow, false); assert.equal(layout.controlsVisible, true); assert.equal(layout.checkboxes, 3); assert.equal(layout.deleteIcons, 3); assert.equal(layout.dark, true);
      if (width === 1320) assert.equal(layout.allCheckboxesVisible, true, 'All three source checkboxes must fit the large fixture viewport');
      else assert.equal(layout.firstSelectedCheckboxVisible, true, 'Small viewports must retain the primary controls and first selected checkbox while the list scrolls');
      layouts.push({ width, height, ...layout });
      writeFileSync(join(outputDir, `electron-copilot-native-dark-${width}.png`), await captureUi());
    }
    await select(apiProviders[1].id, false); await select(subscription.id, false);
    const beforeScope = await binding(); assert.deepEqual(beforeScope.providerIds, [apiProviders[0].id]);
    const scopeBackupsBefore = copilotBackups().length;
    await click('[data-action="copilot-only-selected"]'); foreignExpected = false;
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='copilot');return b.copilotSyncScope==='selected'&&document.querySelector('[data-action="copilot-only-selected"]')?.checked&&!document.querySelector('[data-action="copilot-only-selected"]').disabled})()`, 'selected-only scope automatically persisted');
    await settled('selected-only scope automatically removes previous custom source');
    const afterScope = await binding();
    assert.deepEqual(afterScope.providerIds, beforeScope.providerIds); assert.deepEqual(afterScope.modelIds, beforeScope.modelIds); assert.equal(afterScope.mode, beforeScope.mode); assert.equal(afterScope.enabled, beforeScope.enabled); assert.equal(afterScope.defaultModelId, beforeScope.defaultModelId);
    assert.equal(copilotBackups().length, scopeBackupsBefore + 1, 'Scope change must produce one native synchronization backup');
    await assertNative([apiProviders[0].id], 'selected-only-removes-unmanaged-source');

    await setSearch(apiProviders[0].name);
    await waitFor(`document.querySelectorAll('[data-action="select-tool-provider"]').length===1`, 'bulk test search hides other eligible sources');
    const bulkSnapshot = await evaluate<Snapshot>('window.modelDock.snapshot()');
    const eligibleSources = bulkSnapshot.providers.filter(provider => provider.enabled && provider.hasSecret && (provider.kind !== 'openai-compatible' || !!provider.baseUrl) && bulkSnapshot.models.some(model => model.providerId === provider.id && model.enabled)).map(provider => provider.id);
    assert.ok(eligibleSources.includes(apiProviders[0].id) && eligibleSources.includes(apiProviders[1].id) && eligibleSources.includes(subscription.id));
    assert.ok(eligibleSources.length > 1, 'Bulk selection must exercise hidden eligible sources');
    await rememberOwnedSources(eligibleSources);
    const bulkBackupsBefore = copilotBackups().length;
    await click('[data-action="select-all-tool-providers"]'); await assertBindingSources(eligibleSources, 'bulk click selected eligible sources outside search');
    await settled('one bulk click automatically registers every eligible source'); await assertNative(eligibleSources, 'bulk-all-eligible-outside-search');
    assert.equal(copilotBackups().length, bulkBackupsBefore + 1, 'Bulk selection must perform a single native apply, not one apply per row');
    const clearBackupsBefore = copilotBackups().length;
    await click('[data-action="clear-tool-providers"]'); await assertBindingSources([], 'bulk clear includes sources outside search');
    await settled('bulk clear removed every custom source'); await assertNative([], 'bulk-clear-selected-scope');
    assert.equal(copilotBackups().length, clearBackupsBefore + 1, 'Bulk clear must perform one native apply');
    const retryBackupsBefore = copilotBackups().length;
    await click('[data-action="clear-tool-providers"]'); await settled('zero-selection clear button can retry cleanup'); await assertNative([], 'zero-clear-retry');
    assert.equal(copilotBackups().length, retryBackupsBefore + 1, 'A zero-selection cleanup retry remains one explicit synchronization');

    const unauthenticated = store.saveProvider({ name: `${prefix} · 千问未授权删除回归`, kind: 'openai-compatible', presetId: 'qwen-token', baseUrl, enabled: true });
    assert.equal(unauthenticated.hasSecret, false); assert.equal(store.listModels().some(model => model.providerId === unauthenticated.id), false);
    await click('[aria-label="刷新本机配置"]'); await setSearch(unauthenticated.name);
    await waitFor(`!!document.querySelector('article[data-provider-id="${unauthenticated.id}"] [data-action="delete-provider"]')&&document.querySelector('article[data-provider-id="${unauthenticated.id}"] [data-action="select-tool-provider"]')?.disabled`, 'unconfigured source can be deleted even when it cannot be selected');
    const unusedDeleteBackupsBefore = copilotBackups().length;
    await deleteInUi(unauthenticated.id, unauthenticated.name);
    assert.equal(copilotBackups().length, unusedDeleteBackupsBefore, 'Deleting a globally unused unauthenticated source must not require a native synchronization');
    await assertNative([], 'delete-unused-unauthenticated-source');

    const deletionProvider = store.saveProvider({ name: `${prefix} · 已绑定删除回归`, kind: 'openai-compatible', presetId: 'custom', baseUrl, enabled: true, apiKey: 'synthetic-copilot-delete' });
    const deletionModel = store.saveModel({ providerId: deletionProvider.id, upstreamId: 'copilot-delete-model', alias: 'copilot-delete-model', displayName: '删除回归模型', wireApi: 'responses', contextWindow: 64000, tools: true, vision: false, enabled: true });
    await click('[aria-label="刷新本机配置"]'); await setSearch(prefix);
    await waitFor(`!!document.querySelector('article[data-provider-id="${deletionProvider.id}"]')`, 'cross-tool deletion source visible');
    await select(apiProviders[0].id, true); await rememberOwnedSources([apiProviders[0].id, deletionProvider.id]); await select(deletionProvider.id, true);
    const beforeCrossDelete = await evaluate<Snapshot>('window.modelDock.snapshot()');
    const vscodeBinding = beforeCrossDelete.bindings.find(item => item.id === 'vscode'); assert.ok(vscodeBinding);
    await evaluate(`window.modelDock.saveBinding(${JSON.stringify({ ...vscodeBinding, mode: 'auto', modelSelection: 'all', enabled: true, providerIds: [apiProviders[0].id, deletionProvider.id], modelIds: [], defaultModelId: deletionModel.id, vscodeSyncScope: 'managed' })})`);
    const vscodeTarget = await evaluate<string>('window.modelDock.applyConfig("vscode")');
    assert.equal(resolve(vscodeTarget), resolve(dataDir, 'feature-appdata', 'Code', 'User', 'chatLanguageModels.json'));
    assert.deepEqual(new Set(readVscodeGroups().map(group => group.name)), new Set([`ModelDock · ${apiProviders[0].name}`, `ModelDock · ${deletionProvider.name}`]), 'The deleted global source must first be present in both client registries');
    await setSearch(deletionProvider.name); await deleteInUi(deletionProvider.id, deletionProvider.name);
    const afterCrossDelete = await evaluate<Snapshot>('window.modelDock.snapshot()');
    assert.deepEqual(afterCrossDelete.bindings.find(item => item.id === 'copilot')?.providerIds, [apiProviders[0].id]);
    assert.deepEqual(afterCrossDelete.bindings.find(item => item.id === 'vscode')?.providerIds, [apiProviders[0].id]);
    assert.equal(afterCrossDelete.models.some(model => model.id === deletionModel.id || model.providerId === deletionProvider.id), false);
    assert.ok(afterCrossDelete.models.some(model => model.id === apiModels[0].id), 'Global deletion must preserve unrelated models');
    assert.deepEqual(readVscodeGroups().map(group => group.name), [`ModelDock · ${apiProviders[0].name}`], 'Global deletion must remove the source from the VS Code file as well as bindings');
    await assertNative([apiProviders[0].id], 'global-delete-updates-native-and-vscode');
    await setSearch(prefix); await click('[data-action="clear-tool-providers"]'); await settled('post-deletion native cleanup completed'); await assertNative([], 'post-delete-clear');
    await click('[data-action="apply-tool-config"]'); await settled('empty native retry completed'); await assertNative([], 'empty-retry');
    const cleared = await binding(); assert.equal(cleared.enabled, false); assert.equal(cleared.defaultModelId, '');
    assert.ok(readdirSync(join(dataDir, 'backups')).some(name => name.startsWith('copilot-sync-')), 'Native configuration recovery backups must be created');
    validation = { nativeProcess: { isolated: true, pid: marker.pid, realProfileChanged: false }, selectedSources: 3, selectedModels: 5, duplicateLocalModelIdsAcrossSources: true, modelProtocols: ['completions', 'responses'], checkboxAutomaticallyApplies: true, preferredModelAutomaticallyResynchronizes: true, currentChatSelectionApiInvoked: false, nativeRegistryReadbackVerified: true, independentCredentialsStoredByNative: true, subscriptionOAuthTokensPublishedToNative: false, previewCredentialsRedacted: true, managedScopePreservesUnrelatedProvider: true, selectedScope: { defaultChecked: true, onlyOneSourceAfterToggle: true, unmanagedCustomRemoved: true, githubAccountProvidersPreserved: protectedEntries.length, existingAccountMetadataExercised: protectedEntries.length > 0, signedOutFixtureCreatesNoAccount: true, scopeChangePreservesBindingFields: true, allDeselectedClearsCustom: true, zeroSelectionClearRetry: true }, bulkSingleSync: { includesSearchHiddenSources: true, eligibleSources: eligibleSources.length, selectionApplyCount: 1, clearApplyCount: 1, backupCountVerified: true }, deletion: { unusedUnauthenticatedSourceDeleted: true, unusedDeleteNativeSyncCount: 0, selectedSourceDeletedGlobally: true, affectedTools: ['copilot', 'vscode'], nativeAndFileReadbackVerified: true, unrelatedSourceAndModelsPreserved: true, userConfirmationExercised: true }, manualRetryIdempotent: true, backupsCreated: true, inferenceRequestsSent: false, checks, layouts };
  } finally {
    // This connection is locked to the marker's synthetic process. Even a
    // failed UI assertion cannot leave our fake credentials in the OS store.
    native.close();
    const cleanup = await CopilotDesktopClient.open(home, { verifyProcess: async pid => pid === marker.pid });
    try {
      const cleanupIds = [...observedOwned, ...(sentinelCreated ? [sentinelId] : [])];
      await cleanup.sync({ providers: [] }, { ownedProviderIds: cleanupIds });
      assert.equal((await cleanup.listProviders()).some(p => cleanupIds.includes(p.id)), false, 'Every test-owned provider must be removed before success');
      await assertProtected(cleanup);
    }
    finally { cleanup.close(); }
  }
  assert.ok(validation);
  writeFileSync(join(outputDir, 'copilot-native-sync-validation.json'), JSON.stringify({ ...validation, testOwnedProvidersCleaned: true }, null, 2));
}
