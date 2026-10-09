import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Store } from './store';
import type { JetBrainsConfigOptions } from './jetbrains-config';
import type { WindowsJetBrainsProcess, WindowsJetBrainsProcessSnapshot } from './jetbrains-windows';

function isolatedPaths(dataDir: string, outputDir = process.env.MODELDOCK_SMOKE!) {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1', 'Windows JetBrains smoke requires mocked authentication');
  assert.equal(process.env.MODELDOCK_SMOKE_JETBRAINS_WINDOWS_ONLY, '1', 'Windows profile overrides require the dedicated smoke flag');
  assert.ok(outputDir && process.env.MODELDOCK_DATA_DIR, 'An explicit smoke output and data directory are required');
  assert.equal(resolve(dataDir), resolve(process.env.MODELDOCK_DATA_DIR));
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(dataDir));
  assert.ok(!child.startsWith('..') && !isAbsolute(child), 'The fixture must stay within the smoke-owned output/data tree');
  for (let path = resolve(dataDir); ; path = dirname(path)) {
    if (existsSync(path)) assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Smoke ancestors must not redirect to a user profile');
    if (dirname(path) === path) break;
  }
  const home = join(dataDir, 'feature-home');
  return { dataDir: resolve(dataDir), home, profileRoot: join(home, '.config', 'JetBrains'), cacheRoot: join(home, '.cache', 'JetBrains'),
    installation: join(dataDir, 'feature-installations', 'Rider'), snapshot: join(dataDir, 'jetbrains-windows-processes.json') };
}

/** Main-process-only options for the dedicated isolated Windows-profile smoke.
 * A missing fixture snapshot is unknown, so startup/navigation cannot write. */
export function jetBrainsWindowsSmokeOptions(dataDir: string): JetBrainsConfigOptions {
  const paths = isolatedPaths(dataDir);
  return { platform: 'win32', profileRoot: paths.profileRoot, cacheRoot: paths.cacheRoot, installationRoots: [paths.installation],
    windowsProcessSnapshot: () => {
      if (!existsSync(paths.snapshot)) return { complete: false, processes: [] };
      const info = lstatSync(paths.snapshot);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 1024 * 1024);
      return JSON.parse(readFileSync(paths.snapshot, 'utf8')) as WindowsJetBrainsProcessSnapshot;
    } };
}

/** Native Electron renderer + preload + offline XML transaction verification.
 * All product/process identities and provider keys are synthetic. No Rider or
 * provider is started, and no upstream inference request is made. */
export async function verifyJetBrainsWindowsProfiles(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  const paths = isolatedPaths(store.dataDir, outputDir), current = join(paths.profileRoot, 'Rider2026.2'), old = join(paths.profileRoot, 'Rider2026.1');
  const safeWrite = (path: string, content: string | Buffer) => {
    const child = relative(paths.dataDir, resolve(path));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Every fixture write must stay inside the smoke data directory');
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      if (existsSync(parent)) assert.ok(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink());
      if (resolve(parent) === paths.dataDir) break;
    }
    if (existsSync(path)) assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && lstatSync(path).nlink === 1);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode: 0o600 });
  };
  const completionOriginal = { selectedProvider: { id: 'old-provider', kind: 'OPENAI_COMPATIBLE', name: 'Synthetic original' },
    openAiCompatible: { baseUrl: 'https://old-completion.invalid/v1', model: 'old-completion', providerId: 'OpenAIAPI', modelId: 'OpenAIAPI/old-completion', schemaId: 'fim.generic', maxTokens: '32768', maxOutputTokens: '768', apiKeyConfigured: false },
    unrelatedFixture: { retain: true } };
  const originals: Record<string, string> = {
    'llm.provider.openai.like.xml': '<application><!-- retain provider comment --><component name="OpenAILikeLlmProviderSettings"><option name="baseUrl" value="https://old-chat.invalid/v1"/><option name="httpClientVersion" value="HTTP_2"/><option name="toolEnabled" value="false"/><option name="unrelated" value="retain"/></component></application>',
    'llm.custom.models.xml': '<application><component name="LlmCustomModelsSettings"><option name="smart_model_id" value="OpenAIAPI/old-core"/><option name="quick_model_id" value="OpenAIAPI/old-quick"/><option name="editor_model_id" value="unrelated-editor"/></component></application>',
    'llm.third.party.ai.providers.xml': '<application><component name="LLMThirdPartyAIProvidersSettings"><option name="enabledThirdPartyAIProviders"><option value="Anthropic"/></option></component></application>',
    'llm.next.edit.providers.xml': `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(completionOriginal)}]]></component></application>`,
  };
  for (const profile of [old, current]) {
    for (const [name, content] of Object.entries(originals)) safeWrite(join(profile, 'options', name), content);
    safeWrite(join(profile, 'c.kdbx'), 'SYNTHETIC_PASSWORD_SAFE_UNCHANGED');
    const selector = profile === old ? 'Rider2026.1' : 'Rider2026.2';
    safeWrite(join(paths.cacheRoot, selector, '.home'), paths.installation);
    safeWrite(join(paths.cacheRoot, selector, '.pid'), '2147483646');
  }
  const launcher = join(paths.installation, 'bin', 'rider64.exe');
  safeWrite(launcher, 'SYNTHETIC_LAUNCHER_NOT_EXECUTABLE');
  safeWrite(join(paths.installation, 'product-info.json'), JSON.stringify({ name: 'JetBrains Rider', productCode: 'RD', version: '2026.2.3.1', buildNumber: '262.10968.170', dataDirectoryName: 'Rider2026.2',
    launch: [{ os: 'Windows', launcherPath: 'bin/rider64.exe', additionalJvmArguments: ['-Didea.paths.selector=Rider2026.2'] }] }));
  const fixtureProcess = (extra: Partial<WindowsJetBrainsProcess> = {}): WindowsJetBrainsProcess => ({ pid: 43210, name: 'rider64.exe', executablePath: launcher,
    startedAt: '2026-10-09T12:00:00.000Z', selector: 'Rider2026.2', customPaths: false, ideTool: 'rider', isIdeJvm: false, commandReadable: true, ...extra });
  const unrelated = fixtureProcess({ pid: 2147483646, name: 'powershell.exe', executablePath: join(paths.dataDir, 'synthetic-powershell.exe'), selector: null, ideTool: null });
  const setProcesses = (complete: boolean, processes: WindowsJetBrainsProcess[] = []) => safeWrite(paths.snapshot, JSON.stringify({ complete, processes }));
  setProcesses(true, [unrelated]);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const oldHashes = Object.fromEntries([...Object.keys(originals).map(name => `options/${name}`), 'c.kdbx'].map(name => [name, hash(join(old, name))]));
  const assertOldAndPasswordSafe = () => {
    for (const [name, expected] of Object.entries(oldHashes)) assert.equal(hash(join(old, name)), expected, 'The retained Rider2026.1 profile must never be modified');
    assert.equal(readFileSync(join(current, 'c.kdbx'), 'utf8'), 'SYNTHETIC_PASSWORD_SAFE_UNCHANGED');
  };
  const cloud = store.saveProvider({ name: '火山 Agent Plan · 隔离验证', kind: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', enabled: true, apiKey: 'synthetic-cloud-key' });
  const deepseek = store.saveProvider({ name: 'DeepSeek · 隔离验证', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', enabled: true, apiKey: 'synthetic-deepseek-key' });
  const cloudModels = Array.from({ length: 12 }, (_, index) => store.saveModel({ providerId: cloud.id, upstreamId: index === 0 ? 'glm-5.3' : `fixture-chat-${index}`, alias: index === 0 ? 'fixture/glm-5.3' : `fixture/chat-${index}`,
    displayName: index === 0 ? '火山 Agent Plan - glm-5.3' : `原生聊天验证 ${index}`, wireApi: 'chat-completions', contextWindow: 128000, tools: true, vision: false, enabled: true }));
  const fimModels = ['deepseek-flash', 'deepseek-v4-pro'].map((upstreamId, index) => store.saveModel({ providerId: deepseek.id, upstreamId, alias: `fixture/${upstreamId}`,
    displayName: index === 0 ? 'DeepSeek-V4.1-Flash' : 'DeepSeek-V4-Pro', wireApi: 'responses', contextWindow: 1000000, tools: true, vision: false, enabled: true }));
  const models = [...cloudModels, ...fimModels], glm = cloudModels[0], later = cloudModels[1];
  const seed = store.listBindings().find(binding => binding.id === 'rider')!; assert.ok(seed);
  store.saveBinding({ ...seed, enabled: false, mode: 'aggregate', providerIds: [], modelSelection: 'selected', modelIds: [], defaultModelId: '',
    connectionChoices: { direct: { providerId: '', defaultModelId: '' }, aggregate: { providerIds: [], modelIds: [], modelSelection: 'selected', defaultModelId: '', completionModelId: '' } } });
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source) as Promise<T>;
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const waitFor = async (source: string, label: string) => {
    const deadline = Date.now() + 24000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(source)) return; await pause(40); }
    writeFileSync(join(outputDir, 'rider-windows-timeout.png'), await captureUi()); throw new Error(`Windows Rider smoke timeout: ${label}`);
  };
  const click = async (selector: string) => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const chooseDefault = async (id: string) => {
    await waitFor(`!!document.querySelector('[data-action="tool-default-model"]')&&!document.querySelector('[data-action="tool-default-model"]').disabled`, 'default model ready');
    await evaluate(`(()=>{const select=document.querySelector('[data-action="tool-default-model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='rider');return b.defaultModelId===${JSON.stringify(id)}&&!document.querySelector('[data-action="tool-default-model"]').disabled;})()`, 'default choice saved');
  };
  const synced = () => waitFor(`document.querySelector('[data-tool-application-status]')?.dataset.toolApplicationState==='synced'&&!document.querySelector('[data-action="apply-tool-config"]').disabled&&!document.querySelector('[data-jetbrains-auto-sync]')`, 'offline automatic sync settled');
  const gateway = await evaluate<{ running: boolean; port: number }>('window.modelDock.startGateway(0)'); assert.equal(gateway.running, true); assert.ok(gateway.port > 0);
  await click('[aria-label="刷新本机配置"]');
  await click('[data-page="tools"][data-tool-id="rider"]');
  await waitFor(`document.querySelector('[data-jetbrains-running]')?.dataset.jetbrainsRunning==='stopped'&&!document.querySelector('[data-action="tool-use-aggregate"]').disabled`, 'correct installed profile is stopped');
  const firstStatus = await evaluate<any>(`window.modelDock.jetBrainsStatus('rider')`);
  assert.equal(resolve(firstStatus.configDir), resolve(current)); assert.equal(firstStatus.canApply, true); assert.equal(firstStatus.version, '2026.2');
  for (const provider of [cloud, deepseek]) {
    await click(`article[data-provider-id="${provider.id}"] input[data-action="select-tool-provider"]`);
    await waitFor(`(async()=>{const b=(await window.modelDock.snapshot()).bindings.find(b=>b.id==='rider');return b.providerIds.includes(${JSON.stringify(provider.id)})&&!document.querySelector('[data-action="tool-default-model"]').disabled;})()`, 'aggregate supplier selected');
    await synced();
  }
  await click('[data-action="select-all-tool-aggregate-models"]'); await synced();
  await chooseDefault(glm.id); await synced();
  const uiCounts = await evaluate<any>(`(()=>{const chat=document.querySelector('[data-action="tool-default-model"]'),completion=document.querySelector('[data-action="jetbrains-completion-model"]');return {chatOptions:chat.options.length,completionOptions:completion.options.length,candidates:document.querySelector('[data-completion-candidates]').dataset.completionCandidates,followLabel:completion.options[0].textContent,note:document.querySelector('[data-completion-sync-note]').textContent,badge:document.querySelector('[data-tool-application-status]').textContent};})()`);
  assert.equal(uiCounts.chatOptions, 14); assert.equal(uiCounts.completionOptions, 3); assert.equal(uiCounts.candidates, '2');
  assert.ok(uiCounts.followLabel.includes('未确认原生补全支持')); assert.ok(uiCounts.note.includes('原生 FIM'));
  const selected = store.listBindings().find(binding => binding.id === 'rider')!;
  assert.deepEqual(new Set(selected.modelIds), new Set(models.map(model => model.id)));
  const endpoint = `http://127.0.0.1:${gateway.port}/tool/rider/v1`;
  const xml = (name: string) => readFileSync(join(current, 'options', name), 'utf8');
  const assertSyncedModel = (alias: string) => {
    assert.ok(xml('llm.provider.openai.like.xml').includes(endpoint)); assert.ok(xml('llm.provider.openai.like.xml').includes('HTTP_1_1'));
    assert.ok(xml('llm.provider.openai.like.xml').includes('retain provider comment')); assert.ok(xml('llm.provider.openai.like.xml').includes('unrelated'));
    assert.ok(xml('llm.custom.models.xml').includes(`OpenAIAPI/${alias}`)); assert.ok(xml('llm.custom.models.xml').includes('unrelated-editor'));
    const completion = JSON.parse(xml('llm.next.edit.providers.xml').match(/<!\[CDATA\[([\s\S]*?)\]\]>/)![1]);
    assert.equal(completion.openAiCompatible.baseUrl, endpoint); assert.equal(completion.openAiCompatible.model, alias);
    assert.equal(completion.selectedProvider.kind, 'NONE'); assert.equal(completion.openAiCompatible.apiKeyConfigured, false); assert.equal(completion.unrelatedFixture.retain, true);
    for (const name of Object.keys(originals)) assert.ok(!xml(name).includes('synthetic-cloud-key') && !xml(name).includes('synthetic-deepseek-key') && !xml(name).includes(store.gatewayKey()));
    assertOldAndPasswordSafe();
  };
  assertSyncedModel(glm.alias); assert.ok(readdirSync(join(paths.dataDir, 'backups')).length > 0);
  const headers = { authorization: `Bearer ${store.gatewayKey()}` };
  const catalog = await (await fetch(`${endpoint}/models`, { headers })).json() as { data: { id: string }[] };
  assert.deepEqual(new Set(catalog.data.map(model => model.id)), new Set(models.map(model => model.alias)));
  const layouts: unknown[] = [];
  const captureLayouts = async (stage: string, region: 'top' | 'completion') => {
    await evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1320, 880], [980, 720]]) {
      window.setSize(width, height);
      await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};${region === 'top' ? "document.querySelector('.main-content').scrollTop=0;window.scrollTo(0,0);" : "document.querySelector('[data-jetbrains-completion]').scrollIntoView({block:'start'});"}})()`);
      await pause(100);
      const layout = await evaluate<any>(`(()=>{const main=document.querySelector('.main-content'),target=document.querySelector(${JSON.stringify(region === 'top' ? '[data-tool-application-status]' : '[data-action="jetbrains-completion-model"]')}),r=target.getBoundingClientRect();return {horizontalOverflow:main.scrollWidth>main.clientWidth+1,targetVisible:r.top>=0&&r.bottom<=innerHeight+1,title:document.querySelector('.main-header h1')?.textContent??document.querySelector('h1')?.textContent,badge:document.querySelector('[data-tool-application-status]').textContent,completionCandidates:document.querySelector('[data-completion-candidates]').dataset.completionCandidates,completionOptions:document.querySelector('[data-action="jetbrains-completion-model"]').options.length};})()`);
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.targetVisible, true); assert.equal(layout.completionCandidates, '2'); assert.equal(layout.completionOptions, 3);
      layouts.push({ stage, region, theme, width, height, ...layout }); writeFileSync(join(outputDir, `rider-windows-${stage}-${theme}-${width}.png`), await captureUi());
    }
  };
  await captureLayouts('synced', 'top'); await captureLayouts('completion-counts', 'completion');
  const hashes = () => Object.fromEntries(Object.keys(originals).map(name => [name, hash(join(current, 'options', name))]));
  const beforeRunning = hashes(); setProcesses(true, [fixtureProcess()]);
  await click('[data-action="jetbrains-refresh-status"]'); await waitFor(`document.querySelector('[data-jetbrains-running]').dataset.jetbrainsRunning==='running'`, 'fixture launcher running');
  await chooseDefault(later.id);
  await waitFor(`document.querySelector('[data-jetbrains-auto-sync]')?.dataset.jetbrainsAutoSync==='waiting'`, 'running choice queued');
  assert.deepEqual(hashes(), beforeRunning); assert.ok((await evaluate<string>(`document.querySelector('[data-tool-application-status]').textContent`)).includes('等待 IDE 退出'));
  setProcesses(true, [unrelated]); await click('[data-action="jetbrains-refresh-status"]'); await synced(); assertSyncedModel(later.alias);
  const beforeUnknown = hashes(); setProcesses(false);
  await click('[data-action="jetbrains-refresh-status"]'); await waitFor(`document.querySelector('[data-jetbrains-running]').dataset.jetbrainsRunning==='unknown'`, 'incomplete OS snapshot blocked');
  await chooseDefault(glm.id);
  await waitFor(`document.querySelector('[data-jetbrains-auto-sync]')?.dataset.jetbrainsAutoSync==='blocked'`, 'unknown state distinct from running');
  const blockedBadge = await evaluate<string>(`document.querySelector('[data-tool-application-status]').textContent`);
  assert.ok(blockedBadge.includes('需确认 IDE 配置')); assert.ok(!blockedBadge.includes('退出 IDE 后自动同步')); assert.deepEqual(hashes(), beforeUnknown); assertOldAndPasswordSafe();
  await captureLayouts('blocked', 'top');
  setProcesses(true); await click('[data-action="jetbrains-refresh-status"]'); await synced(); assertSyncedModel(glm.alias);
  writeFileSync(join(outputDir, 'jetbrains-windows-ui-validation.json'), JSON.stringify({ ok: true, verification: 'Native Electron UI with isolated synthetic product metadata, process snapshot and offline XML files; no actual IDE launch or provider inference',
    installedProfile: 'Rider2026.2', retainedProfile: 'Rider2026.1', version: '2026.2.3.1', stalePidReusedByUnrelatedProcess: true, correctStoppedProfileAutoSynced: true,
    chatModels: 14, supportedFimModels: 2, completionOptions: 3, unsupportedFollowingDefaultExplained: true, uiCounts,
    runningChoiceQueuedWithoutWrites: true, stoppedRefreshImmediatelySynced: true, incompleteSnapshotBlockedWithoutWrites: true, blockedBadge,
    oldProfileHashesUnchanged: true, passwordSafeBytesUnchanged: true, backupCreated: true, unrelatedXmlAndCompletionDataPreserved: true, credentialsNeverWrittenToXml: true,
    gatewayCatalogAliases: catalog.data.map(model => model.id), upstreamRequests: 0, layouts }, null, 2));
}
