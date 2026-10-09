import type { BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, stringify as yaml } from 'yaml';
import type { Store } from './store';
import type { Model, Provider, Snapshot, ToolBinding } from '../shared/types';
import { DSH_LEGACY_PLUGIN_ID, DSH_LEGACY_PLUGIN_SOURCE, DSH_LEGACY_SCRIPT } from './dsh-runtime';

interface DshRoute {
  displayName: string;
  baseURL: string;
  apiKeyEnv: string;
  api: 'openai-completions' | 'openai-responses';
  models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; input: string[] }>;
}
interface DshPatchRow { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown>; insert?: DshPatchRow[] }

/** Actual React -> IPC -> DSH home-overlay writes, exclusively below smoke data. */
export async function verifyDshConfiguration(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const smokeDir = process.env.MODELDOCK_SMOKE, dataDir = process.env.MODELDOCK_DATA_DIR, upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
  assert.ok(smokeDir && dataDir && upstream, 'DSH smoke requires explicit fixture isolation');
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(smokeDir)); assert.equal(resolve(store.dataDir), resolve(dataDir));
  const below = (parent: string, child: string) => { const path = relative(resolve(parent), resolve(child)); return !!path && !path.startsWith('..') && !/^[A-Za-z]:/.test(path); };
  assert.ok(below(join(smokeDir, 'data'), dataDir), 'DSH smoke must use a fixture ModelDock database');
  const home = join(dataDir, 'feature-home', '.dsh'), patchFile = join(home, 'cordis.patch.yml'), credentialFile = join(home, '.credentials.yaml');
  for (const path of [home, patchFile, credentialFile]) assert.ok(below(dataDir, path), 'All DSH fixture paths must stay below smoke data');
  const mockUrl = new URL(upstream); assert.equal(mockUrl.protocol, 'http:'); assert.equal(mockUrl.hostname, '127.0.0.1');
  assert.ok(mockUrl.port && !mockUrl.username && !mockUrl.password && !mockUrl.search && !mockUrl.hash);
  mockUrl.pathname = '/v1'; const baseUrl = mockUrl.href.replace(/\/$/, '');
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(source: string, label: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(25); }
    throw new Error(`DSH configuration smoke timed out: ${label}`);
  }
  async function click(selector: string): Promise<void> {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function binding(): Promise<ToolBinding> {
    const value = (await evaluate<Snapshot>('window.modelDock.snapshot()')).bindings.find(item => item.id === 'dsh'); assert.ok(value); return value;
  }
  async function settled(ids: string[], label: string): Promise<void> {
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(item=>item.id==='dsh'),status=document.querySelector('[data-tool-application-status]'),button=document.querySelector('[data-action="apply-tool-config"]');return JSON.stringify(b.providerIds)===${JSON.stringify(JSON.stringify(ids))}&&status?.dataset.toolApplicationState===${JSON.stringify(ids.length ? 'synced' : 'cleared')}&&button&&!button.disabled&&!document.querySelector('[data-tool-sync-error]')})()`, label);
    const location = await evaluate<string>(`document.querySelector('.tool-inline-delivery code')?.textContent??''`);
    assert.equal(resolve(location), resolve(patchFile), 'DSH automatic application must target the isolated home overlay');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('[role="dialog"]')`), false, 'DSH checkbox application must not open a dialog');
  }
  const backupDir = join(dataDir, 'backups');
  const backups = () => existsSync(backupDir) ? readdirSync(backupDir).filter(name => name.startsWith('dsh-sync-')) : [];
  const originalProviders = { 'foreign-route': { displayName: 'Foreign DSH fixture', baseURL: 'https://foreign.example.test/v1', apiKeyEnv: 'FOREIGN_DSH_FIXTURE', api: 'openai-completions', models: [{ id: 'foreign-model', name: 'Foreign', contextWindow: 64000, maxTokens: 4096, input: ['text'] }] } };
  const originalRows: DshPatchRow[] = [
    { id: 'llm-pi-ai', config: { providers: originalProviders } },
    { id: 'agent-default-model', config: { provider: 'foreign-route', model: 'foreign-model' } },
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', disabled: false, config: { apiKeyEnv: 'FOREIGN_DSH_NATIVE_FIXTURE', baseURL: 'https://foreign.example.test/v1' } },
    { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
    { id: 'deepseek-account', name: '@deepseek-ai/dsh-deepseek-account-platform' },
  ];
  const originalCredentials = { version: 1, refs: { FOREIGN_DSH_FIXTURE: 'SYNTHETIC_DSH_FOREIGN', FOREIGN_DSH_NATIVE_FIXTURE: 'SYNTHETIC_DSH_NATIVE_FOREIGN' }, records: { 'account-fixture': { opaque: 'SYNTHETIC_DSH_ACCOUNT_RECORD' } } };
  const readPatch = () => {
    assert.ok(existsSync(patchFile)); const parsed = parseYaml(readFileSync(patchFile, 'utf8'));
    assert.ok(Array.isArray(parsed), 'DSH native overlay must be a plugin-row array'); return parsed as DshPatchRow[];
  };
  const readRoutes = () => {
    const row = readPatch().find(item => item.id === 'llm-pi-ai');
    assert.ok(row?.config && typeof row.config.providers === 'object' && row.config.providers !== null && !Array.isArray(row.config.providers));
    return row.config.providers as Record<string, DshRoute>;
  };
  function ownedRoutes(): Array<[string, DshRoute]> { return Object.entries(readRoutes()).filter(([, route]) => route.apiKeyEnv.startsWith('MODELDOCK_DSH_')); }
  function assertNativeScope(selected: boolean): void {
    const rows = readPatch();
    for (const id of ['llm-deepseek', 'llm-deepseek-account']) {
      const row = rows.find(item => item.id === id), original = originalRows.find(item => item.id === id); assert.ok(row && original);
      assert.equal(rows.filter(item => item.id === id).length, 1, 'DSH native source row must not be duplicated');
      if (selected) assert.equal(row.disabled, true, 'Exclusive DSH selection must actually disable the native model plugin');
      else assert.ok(isDeepStrictEqual(row, original), 'Disabling exclusive scope must restore the native plugin row and its original flag');
    }
    assert.ok(isDeepStrictEqual(rows.find(item => item.id === 'deepseek-account'), originalRows.find(item => item.id === 'deepseek-account')), 'Model scope must retain the account authorization service');
    const credentials = parseYaml(readFileSync(credentialFile, 'utf8')) as typeof originalCredentials;
    assert.ok(isDeepStrictEqual(credentials.records, originalCredentials.records), 'Model scope must never modify account credential records');
    assert.ok(credentials.refs.FOREIGN_DSH_NATIVE_FIXTURE === originalCredentials.refs.FOREIGN_DSH_NATIVE_FIXTURE, 'Native API credential reference must remain unchanged');
  }
  function assertConfig(expectedSources: Provider[], expectedDefault: Model): void {
    const routes = readRoutes();
    assert.equal(routes['foreign-route'], undefined, 'The DSH home override must publish only the current ModelDock selection');
    const owned = ownedRoutes(), expectedNames = expectedSources.length === 1 ? ['ModelDock'] : expectedSources.map(provider => `ModelDock · ${provider.name}`);
    assert.deepEqual(new Set(owned.map(([, route]) => route.displayName)), new Set(expectedNames), 'Native DSH routes must contain exactly the selected ModelDock sources');
    const expectedModels = store.listModels().filter(model => expectedSources.some(provider => provider.id === model.providerId) && model.enabled);
    assert.deepEqual(new Set(owned.flatMap(([, route]) => route.models.map(model => model.id))), new Set(expectedModels.map(model => model.upstreamId)), 'Direct API routes must use the actual upstream model IDs');
    const defaults = readPatch().filter(row => row.id === 'agent-default-model'); assert.equal(defaults.length, 1);
    const selected = defaults[0].config; assert.ok(selected && typeof selected.provider === 'string'); assert.equal(selected.model, expectedDefault.upstreamId);
    assert.ok(routes[selected.provider].models.some(model => model.id === expectedDefault.upstreamId));
    const secretFile = parseYaml(readFileSync(credentialFile, 'utf8')) as typeof originalCredentials;
    assert.equal(secretFile.version, 1);
    assert.ok(secretFile.refs.FOREIGN_DSH_FIXTURE === originalCredentials.refs.FOREIGN_DSH_FIXTURE, 'Foreign credential reference must remain unchanged');
    const sourceReferences: string[] = [];
    for (const provider of expectedSources) {
      const name = expectedSources.length === 1 ? 'ModelDock' : `ModelDock · ${provider.name}`;
      const sourceRoutes = owned.filter(([, route]) => route.displayName === name);
      const sourceModels = expectedModels.filter(model => model.providerId === provider.id);
      assert.equal(sourceRoutes.length, new Set(sourceModels.map(model => model.wireApi)).size, 'Each source needs exactly one route per selected protocol');
      assert.deepEqual(new Set(sourceRoutes.flatMap(([, route]) => route.models.map(model => model.id))), new Set(sourceModels.map(model => model.upstreamId)), 'Every source must retain exactly its own upstream models');
      const references = new Set(sourceRoutes.map(([, route]) => route.apiKeyEnv));
      assert.equal(references.size, 1, 'A source shares its credential ref only across its own protocol routes');
      sourceReferences.push(...references);
      for (const [, route] of sourceRoutes) {
        assert.equal(route.baseURL, provider.baseUrl);
        const wireApi = route.api === 'openai-responses' ? 'responses' : 'chat-completions';
        assert.deepEqual(new Set(route.models.map(model => model.id)), new Set(sourceModels.filter(model => model.wireApi === wireApi).map(model => model.upstreamId)), 'Native route protocol and models must match their source');
        assert.ok(secretFile.refs[route.apiKeyEnv as keyof typeof secretFile.refs] === store.getSecret(provider.id)?.apiKey, 'Native credential ref must contain that source own fixture API credential');
      }
    }
    assert.equal(new Set(sourceReferences).size, expectedSources.length, 'Different sources must use distinct native credential refs');
    assert.doesNotMatch(readFileSync(patchFile, 'utf8'), /synthetic-only|SYNTHETIC_DSH_FOREIGN/, 'DSH patch uses credential references rather than raw secrets');
    assertNativeScope(true);
  }
  const providers: Provider[] = [], models: Model[] = [], operations: Array<{ action: string; backupsCreated: number; sources: number }> = [];
  async function select(provider: Provider, selected: boolean): Promise<void> {
    const before = await binding(), ids = selected ? [...new Set([...(before.providerIds ?? []), provider.id])] : (before.providerIds ?? []).filter(id => id !== provider.id);
    const count = backups().length, selector = `article[data-provider-id="${provider.id}"] [data-action="select-tool-provider"]`;
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)})?.checked`), !selected);
    await click(selector); await settled(ids, 'checkbox automatically applies DSH configuration');
    const added = backups().length - count; assert.equal(added, 1, 'One checkbox action must create one DSH application backup');
    operations.push({ action: selected ? 'select' : 'deselect', backupsCreated: added, sources: ids.length });
    if (ids.length) { const current = await binding(), preferred = store.listModels().find(model => model.id === current.defaultModelId); assert.ok(preferred); assertConfig(providers.filter(p => ids.includes(p.id)), preferred); }
  }
  for (const [index, name] of ['DSH 自动配置回归 A', 'DSH 自动配置回归 B'].entries()) {
    providers.push(await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name, kind: 'openai-compatible', presetId: 'custom', baseUrl, enabled: true, apiKey: 'synthetic-only' })})`));
    for (const [upstreamId, wireApi] of index === 0 ? [['mock-model', 'chat-completions'], ['mock-fast', 'responses']] : [['mock-model-b', 'chat-completions']]) {
      models.push(await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: providers[index].id, upstreamId, alias: `dsh-${index}-${upstreamId}`, displayName: `DSH ${upstreamId}`, wireApi, contextWindow: 64000, tools: true, vision: false, enabled: true })})`));
    }
  }
  await evaluate(`window.modelDock.saveBinding(${JSON.stringify({ ...await binding(), enabled: false, mode: 'auto', providerIds: [], modelIds: [], defaultModelId: '' })})`);
  mkdirSync(home, { recursive: true }); writeFileSync(patchFile, yaml(originalRows), { mode: 0o600 }); writeFileSync(credentialFile, yaml(originalCredentials), { mode: 0o600 });
  await click('[aria-label="刷新本机配置"]'); await click('[data-page="tools"][data-tool-id="dsh"]');
  await waitFor(`!!document.querySelector('[data-tool-binding="dsh"]')&&document.querySelector('[data-tool-binding="dsh"]').dataset.selectedProviderCount==='0'`, 'DSH empty selection');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-action="export-tool-config"]')`), false, 'DSH tool summary must expose synchronization instead of manual export');
  assert.equal(await evaluate<boolean>(`!!document.querySelector('[data-action="apply-tool-config"]')`), true);
  assert.equal((await binding()).dshSyncScope, 'selected', 'DSH must default to showing only selected sources');
  assert.equal(await evaluate<boolean>(`document.querySelector('[data-action="dsh-only-selected"]')?.checked`), true);
  await select(providers[0], true);
  assert.equal(ownedRoutes().length, 2, 'Mixed API protocols must use independent native DSH routes');
  const native = ownedRoutes().find(([, route]) => route.api === 'openai-completions'); assert.ok(native);
  const target = new URL(native[1].baseURL); assert.equal(target.origin, mockUrl.origin); assert.equal(target.pathname, '/v1');
  target.pathname = '/v1/chat/completions';
  const credentials = parseYaml(readFileSync(credentialFile, 'utf8')) as { refs: Record<string, string> };
  const reply = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.refs[native[1].apiKeyEnv]}` }, body: JSON.stringify({ model: native[1].models[0].id, messages: [{ role: 'user', content: 'OK' }] }) });
  assert.equal(reply.status, 200); const message = await reply.json() as { choices: Array<{ message: { content: string } }> }; assert.equal(message.choices[0].message.content, 'OK');
  // Scope edits must not widen a legacy model filter, change connection mode or
  // enable an otherwise disabled binding. A checkbox edit later returns to the
  // normal native multi-source mode, as intended by the product flow.
  const legacyBinding: ToolBinding = { ...await binding(), mode: 'aggregate', modelSelection: 'selected', modelIds: [models[0].id], defaultModelId: models[0].id };
  await evaluate(`window.modelDock.saveBinding(${JSON.stringify(legacyBinding)})`);
  await click('[aria-label="刷新本机配置"]');
  await waitFor(`document.querySelector('[data-tool-binding="dsh"]')?.dataset.selectedModelCount==='1'`, 'legacy explicit DSH model selection');
  for (const dshSyncScope of ['managed', 'selected'] as const) {
    const count = backups().length;
    await click('[data-action="dsh-only-selected"]');
    await waitFor(`(async()=>{return (await window.modelDock.snapshot()).bindings.find(item=>item.id==='dsh').dshSyncScope===${JSON.stringify(dshSyncScope)}})()`, 'DSH scope saved');
    await settled([providers[0].id], 'scope change automatically applies DSH configuration');
    assert.deepEqual(await binding(), { ...legacyBinding, dshSyncScope }, 'Scope-only edit must preserve model filter, mode, enabled state and default');
    assert.equal(backups().length - count, 1, 'Scope checkbox must synchronize exactly once');
    assertNativeScope(dshSyncScope === 'selected');
    assert.equal(ownedRoutes().length, 1);
    assert.deepEqual(ownedRoutes()[0][1].models.map(model => model.id), [models[0].alias], 'Scope-only edits must not widen the legacy explicit model list');
    operations.push({ action: `scope-${dshSyncScope}`, backupsCreated: 1, sources: 1 });
  }
  await select(providers[0], false);
  assert.deepEqual(Object.keys(readRoutes()), [], 'An empty exclusive selection must not reveal the original model sources');
  assertNativeScope(true);
  await select(providers[0], true);
  const defaultModel = models.find(model => model.providerId === providers[0].id && model.wireApi === 'responses'); assert.ok(defaultModel);
  const defaultCount = backups().length;
  await evaluate(`(()=>{const input=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,${JSON.stringify(defaultModel.id)});input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`(async()=>{return (await window.modelDock.snapshot()).bindings.find(item=>item.id==='dsh').defaultModelId===${JSON.stringify(defaultModel.id)}})()`, 'DSH default selection persisted');
  await settled([providers[0].id], 'default-model change automatically applies DSH configuration');
  assert.equal(backups().length - defaultCount, 1); assertConfig([providers[0]], defaultModel);
  operations.push({ action: 'default-model', backupsCreated: 1, sources: 1 });
  await select(providers[1], true); await select(providers[0], false);
  assert.equal(ownedRoutes().length, 1, 'Deselection must remove the prior source protocol routes');
  const text = await evaluate<string>('document.body.innerText'); assert.doesNotMatch(text, /synthetic-only|SYNTHETIC_DSH_FOREIGN|SYNTHETIC_DSH_NATIVE_FOREIGN|SYNTHETIC_DSH_ACCOUNT_RECORD/);
  assert.match(text, /默认模型用于新会话/);
  assert.match(text, /仅显示所选供应商/);
  const layouts: unknown[] = [], oldSize = window.getSize();
  for (const [width, height] of [[1320, 880], [980, 680]]) {
    window.setSize(width, height); await pause(100);
    const layout = await evaluate<{ width: number; height: number; overflow: boolean; applyVisible: boolean }>(`(()=>{const b=document.querySelector('[data-action="apply-tool-config"]').getBoundingClientRect();return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,applyVisible:b.width>0&&b.top>=0&&b.bottom<=innerHeight};})()`);
    assert.equal(layout.overflow, false); assert.equal(layout.applyVisible, true); layouts.push(layout);
    writeFileSync(join(outputDir, `electron-dsh-auto-config-${width}.png`), await captureUi());
  }
  window.setSize(oldSize[0], oldSize[1]);
  const clearCount = backups().length; await click('[data-action="clear-tool-providers"]'); await settled([], 'clear selection automatically removes DSH managed routes');
  assert.equal(backups().length - clearCount, 1); operations.push({ action: 'clear', backupsCreated: 1, sources: 0 });
  assert.deepEqual(Object.keys(readRoutes()), [], 'Clearing an exclusive DSH selection must keep the native model list empty');
  assertNativeScope(true);
  assert.ok(isDeepStrictEqual(parseYaml(readFileSync(credentialFile, 'utf8')), originalCredentials), 'Clearing DSH must remove only its own credential refs');
  await click('[data-action="apply-tool-config"]'); await settled([], 'empty DSH resynchronization remains available');
  assert.deepEqual(Object.keys(readRoutes()), []); assertNativeScope(true);
  const clearedBinding = await binding(); assert.equal(clearedBinding.enabled, false);
  await click('[data-action="dsh-only-selected"]');
  await waitFor(`(async()=>{return (await window.modelDock.snapshot()).bindings.find(item=>item.id==='dsh').dshSyncScope==='managed'})()`, 'disabled DSH scope persisted');
  await settled([], 'turning off exclusive scope restores original DSH sources');
  assert.deepEqual(await binding(), { ...clearedBinding, dshSyncScope: 'managed' }, 'Scope-only edit must keep a cleared binding disabled');
  assertNativeScope(false);
  assert.ok(isDeepStrictEqual(readPatch(), originalRows));
  // This source is configuration metadata only. The helper never calls the
  // public API or performs discovery for it; native continuation inference is
  // covered separately with the installed DSH loader and a loopback fixture.
  const officialProvider = await evaluate<Provider>(`window.modelDock.saveProvider(${JSON.stringify({ name: 'DSH DeepSeek 旧会话兼容配置验证', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', enabled: true, apiKey: 'SYNTHETIC_DSH_OFFICIAL_METADATA_ONLY' })})`);
  providers.push(officialProvider);
  const officialModel = await evaluate<Model>(`window.modelDock.saveModel(${JSON.stringify({ providerId: officialProvider.id, upstreamId: 'DeepSeek-V4.1-Pro', alias: 'dsh-legacy-deepseek-pro', displayName: 'DSH 同模型兼容验证', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true })})`);
  models.push(officialModel);
  await click('[aria-label="刷新本机配置"]');
  await click('[data-action="dsh-only-selected"]');
  await waitFor(`(async()=>{return (await window.modelDock.snapshot()).bindings.find(item=>item.id==='dsh').dshSyncScope==='selected'})()`, 'compatibility fixture exclusive scope');
  await settled([], 'compatibility fixture restores zero exclusive sources');
  await select(officialProvider, true);
  const compatibilityRows = () => readPatch().flatMap(row => [row, ...(row.insert ?? [])]).filter(row => row.id === DSH_LEGACY_PLUGIN_ID);
  const entries = compatibilityRows(); assert.equal(entries.length, 1, 'The legacy adapter must be inserted exactly once using the native plugin insertion syntax');
  const scriptPath = join(home, DSH_LEGACY_SCRIPT); assert.ok(below(home, scriptPath) && existsSync(scriptPath));
  assert.equal(entries[0].name, pathToFileURL(scriptPath).href, 'Native compatibility insertion must reference only the owned local script');
  assert.ok(entries[0].config && entries[0].config.version === 1 && Array.isArray(entries[0].config.mappings));
  const mappings = entries[0].config.mappings as Array<{ legacyProvider: string; model: string; targetProvider: string; targetModel: string }>;
  assert.equal(mappings.length, 2); assert.deepEqual(new Set(mappings.map(row => row.legacyProvider)), new Set(['deepseek-official', 'deepseek-account']));
  for (const row of mappings) {
    assert.equal(row.model, officialModel.upstreamId); assert.equal(row.targetModel, officialModel.upstreamId);
    assert.ok(readRoutes()[row.targetProvider]?.models.some(model => model.id === officialModel.upstreamId), 'Old DeepSeek calls may delegate only to the exact selected upstream model');
  }
  const script = readFileSync(scriptPath, 'utf8');
  assert.ok(script === DSH_LEGACY_PLUGIN_SOURCE, 'The installed runtime must be the trusted static source, never generated from model/config strings');
  assert.doesNotMatch(script, /SYNTHETIC_DSH_OFFICIAL_METADATA_ONLY|synthetic-only|SYNTHETIC_DSH_FOREIGN|DeepSeek-V4\.1-Pro/);
  assert.doesNotMatch(readFileSync(patchFile, 'utf8'), /SYNTHETIC_DSH_OFFICIAL_METADATA_ONLY/);
  const stateKey = `dsh-sync:${createHash('sha256').update(process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home)).digest('hex')}`;
  const state = store.getManagedState<Record<string, unknown>>(stateKey, {});
  assert.ok(state.runtime && !state.pending, 'The successful compatibility write must close its three-file recovery journal');
  const compatibilityText = await evaluate<string>('document.body.innerText');
  assert.match(compatibilityText, /默认模型用于新会话/); assert.match(compatibilityText, /同模型的兼容调用/); assert.match(compatibilityText, /不更改聊天内容或模型选择/);
  assert.doesNotMatch(compatibilityText, /SYNTHETIC_DSH_OFFICIAL_METADATA_ONLY/);
  writeFileSync(join(outputDir, 'electron-dsh-legacy-compatibility.png'), await captureUi());
  await click('[data-action="dsh-only-selected"]');
  await waitFor(`(async()=>{return (await window.modelDock.snapshot()).bindings.find(item=>item.id==='dsh').dshSyncScope==='managed'})()`, 'compatibility scope turned off');
  await settled([officialProvider.id], 'managed mode removes legacy runtime activation');
  assert.equal(compatibilityRows().length, 0); assertNativeScope(false);
  assert.ok(readFileSync(scriptPath, 'utf8') === script, 'Inactive keyless runtime must stay unchanged while native HMR disposes an in-flight adapter');
  await select(officialProvider, false);
  assert.ok(isDeepStrictEqual(readPatch(), originalRows));
  assert.ok(isDeepStrictEqual(parseYaml(readFileSync(credentialFile, 'utf8')), originalCredentials));
  assert.equal(compatibilityRows().length, 0);
  assert.ok(!store.getManagedState<Record<string, unknown>>(stateKey, {}).pending, 'Compatibility removal must also close the recovery journal');
  const beforeOfficialBackups = new Set(backups());
  await click('[data-action="restore-official-tool-config"]');
  await waitFor('!!document.querySelector("[data-action=confirm-tool-restore]")', 'DSH official restoration confirmation');
  await click('[data-action="confirm-tool-restore"]');
  await waitFor('!document.querySelector("[role=dialog]")&&!!document.querySelector("[data-tool-official-restored]")&&document.querySelector("[data-tool-application-status]")?.dataset.toolApplicationState==="official"', 'DSH official restoration completed');
  const officialBinding = await binding();
  assert.equal(officialBinding.enabled, false); assert.deepEqual(officialBinding.providerIds, []); assert.deepEqual(officialBinding.modelIds, []); assert.equal(officialBinding.defaultModelId, '');
  assert.equal(await evaluate<string>('document.querySelector("[data-tool-application-status]").dataset.toolApplicationState'), 'official');
  const officialRows = readPatch();
  assert.equal(officialRows.find(row => row.id === 'llm-pi-ai')?.config?.providers, undefined, 'Official restore removes custom DSH model provider overrides');
  const restoredDefault = officialRows.find(row => row.id === 'agent-default-model')?.config;
  assert.equal(restoredDefault?.provider, undefined); assert.equal(restoredDefault?.model, undefined);
  for (const id of ['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account']) assert.equal(officialRows.find(row => row.id === id)?.disabled, undefined, 'Official native adapters must inherit their shipped enabled state');
  assert.ok(isDeepStrictEqual(officialRows.find(row => row.id === 'deepseek-account'), originalRows.find(row => row.id === 'deepseek-account')), 'Official restore preserves the account authorization service');
  assert.ok(isDeepStrictEqual(parseYaml(readFileSync(credentialFile, 'utf8')), originalCredentials), 'Official restore retains original account records and other credential refs');
  assert.equal(compatibilityRows().length, 0);
  const officialBackups = backups().filter(name => !beforeOfficialBackups.has(name)); assert.equal(officialBackups.length, 1);
  const officialBackupFile = join(backupDir, officialBackups[0], 'managed-state.enc'); assert.ok(existsSync(officialBackupFile));
  assert.doesNotMatch(readFileSync(officialBackupFile, 'utf8'), /SYNTHETIC_DSH_FOREIGN|SYNTHETIC_DSH_NATIVE_FOREIGN|SYNTHETIC_DSH_ACCOUNT_RECORD/, 'DSH restoration backup must encrypt credential material');
  writeFileSync(join(outputDir, 'electron-dsh-official-restored.png'), await captureUi());
  for (const provider of providers) await evaluate(`window.modelDock.deleteProvider(${JSON.stringify(provider.id)})`);
  writeFileSync(join(outputDir, 'dsh-auto-config-validation.json'), JSON.stringify({ path: patchFile, operations, checkboxAutomaticallyApplies: true, defaultAutomaticallyApplies: true, mixedProtocolsSeparated: true, apiUsesUpstreamModelIds: true, onlySelectedSourcesPublished: true, nativeModelPluginsDisabledInExclusiveScope: true, nativeSourceFlagsRestoredOnScopeDisable: true, scopePreservesLegacyBinding: true, exactSelectionMetadata: true, officialRestoration: { userConfirmationExercised: true, modelOverridesRemoved: true, nativeAdaptersEnabled: true, accountAndOtherCredentialsPreserved: true, encryptedBackupCreated: true, bindingCleared: true, uiOfficialStatus: true }, scopeKeepsClearedBindingDisabled: true, accountServiceAndCredentialRecordsPreserved: true, exclusiveClearKeepsZeroSources: true, originalProvidersRestoredOnScopeDisable: true, foreignCredentialRefsPreserved: true, originalDefaultRestoredOnScopeDisable: true, emptyRetryAvailable: true, legacyCompatibility: { metadataOnlyOfficialSource: true, externalRequestSent: false, nativePluginInsertion: true, mappingCount: mappings.length, exactUpstreamModel: officialModel.upstreamId, keylessStaticRuntime: true, journalClosed: true, managedScopeDeactivatesPlugin: true, clearRestoresOriginalConfiguration: true, inactiveRuntimeRetained: true, sessionsReadOrChanged: false, nativeContinuationInferenceTestedHere: false }, localMockRequest: { status: reply.status, configuredNativeRoute: true, response: 'OK' }, layouts, rendererCredentialsHidden: true, realDshProfileChanged: false, nativeDshRuntimeLoaded: false, liveProviderInferenceTested: false }, null, 2));
}
