import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Model, Provider, Snapshot } from '../shared/types';
import type { DiscoveryResult } from '../shared/catalog-types';
import { TRAE_RELAY_BASE_URL, JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import type { Store } from './store';

const IDS_KEY = 'qa-model-history-provider-ids', MODE_KEY = 'qa-model-history-mode', CALLS_KEY = 'qa-model-history-calls';
const PRIVATE_KEY = 'SYNTHETIC_PRIVATE_MODEL_HISTORY_KEY';
const CATALOG_CLOCK_OFFSET_KEY = 'qa-model-history-clock-offset';
// Public names and picker shape only; this is never a live account response.
const TRAE_PUBLIC_SCOPE = "按本机同账号 TRAE 客户端最近缓存的 Chat 模型清单显示，共 18 项。当前账号可添加 17 项，有 1 项受账号权限限制。清单变化时请先在 TRAE 刷新，再重新获取；历史选项仅控制显示。";
const TRAE_PUBLIC_DIRECTORY = [
  {
    "id": "Doubao-Seed-2.1-Turbo",
    "name": "Seed-2.1-Turbo",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "Doubao-Seed-2.1-Pro",
    "name": "Seed-2.1-Pro-0915",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "Doubao-Seed-Evolving",
    "name": "Seed-Evolving",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "Doubao-Seed-Code",
    "name": "Seed-Code",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "glm-5.3-flash",
    "name": "GLM-5.3-Flash",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "glm-5.3-flashx",
    "name": "GLM-5.3-FlashX",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "glm-5.3",
    "name": "GLM-5.3",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "DeepSeek-V4.1-Flash",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "DeepSeek-V4-Pro-Official",
    "name": "DeepSeek-V4-Pro",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "kimi-k3.1-pro",
    "name": "Kimi-K3.1-Pro",
    "visibility": "current",
    "importable": false
  },
  {
    "id": "kimi-k3",
    "name": "Kimi-K3",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "mimo-v2.6-flash",
    "name": "MiMo-V2.6-Flash",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "mimo-v2.6-pro",
    "name": "MiMo-V2.6-Pro",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "minimax-m3.1-flash",
    "name": "MiniMax-M3.1-Flash",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "minimax-m3",
    "name": "MiniMax-M3",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "step-5-preview",
    "name": "Step-5-Preview",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "qwen3.8-flash",
    "name": "Qwen3.8-Flash",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "qwen3.8-max",
    "name": "Qwen3.8-Max",
    "visibility": "current",
    "importable": true
  },
  {
    "id": "Doubao_1_6",
    "name": "Seed-Code",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-5.2_advisor_doubao",
    "name": "GLM-5.2",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-5.1",
    "name": "GLM-5.1",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-5",
    "name": "GLM-5",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "DeepSeek-V4-Flash",
    "name": "DeepSeek-V4-Flash",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-4.7",
    "name": "GLM-4.7",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-4.6",
    "name": "GLM-4.6",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "DeepSeek-V4-Flash-Official",
    "name": "DeepSeek-V4-Flash",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "DeepSeek-V4-Pro",
    "name": "DeepSeek-V4-Pro",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "doubao-for-auto",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "kimi-k2",
    "name": "Kimi-K2-0905",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-5.1_advisor",
    "name": "GLM-5.1",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "glm-4.7-auto",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "minimax-m2.1",
    "name": "MiniMax-M2.1",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "minimax-m2",
    "name": "MiniMax-M2",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "qwen-3.7-plus",
    "name": "Qwen3.7-Plus",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "qwen-3.5",
    "name": "Qwen3.5-Plus",
    "visibility": "historical",
    "importable": true
  },
  {
    "id": "qwen3-coder",
    "name": "Qwen3-Coder-Next",
    "visibility": "historical",
    "importable": true
  }
] as const;
type Family = 'codex' | 'grok' | 'copilot' | 'trae' | 'jetbrains' | 'api';
const families: Family[] = ['codex', 'grok', 'copilot', 'trae', 'jetbrains', 'api'];
const id = (family: Family, suffix: string) => `qa-${family}-${suffix}`;
const source = (family: Family) => family === 'jetbrains' ? 'jetbrains-client' : family + '-client';

/** Main-process fixture only. It supplies the real Catalog's native model port
 * with synthetic data; no renderer API, DOM or real account is replaced. */
export function createHistoryModelsFixture(store: Store): { now(): number; models(provider: Provider, signal: AbortSignal): Response | undefined } {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true); assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1'); assert.equal(process.env.MODELDOCK_SMOKE_MODEL_HISTORY_ONLY, '1');
  const ids: Partial<Record<Family, string>> = {}, oldModels: Model[] = [];
  for (const family of families) {
    const kind = family === 'codex' || family === 'grok' || family === 'copilot' ? family : 'openai-compatible';
    const presetId = family === 'codex' ? 'codex-subscription' : family === 'grok' ? 'grok-build' : family === 'copilot' ? 'copilot-subscription' : family === 'trae' ? 'trae-cn-relay' : family === 'jetbrains' ? 'jetbrains-central' : 'custom';
    const baseUrl = family === 'codex' ? 'https://chatgpt.com/backend-api/codex' : family === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : family === 'copilot' ? 'https://api.githubcopilot.com' : family === 'trae' ? TRAE_RELAY_BASE_URL : family === 'jetbrains' ? JETBRAINS_RELAY_BASE_URL : process.env.MODELDOCK_SMOKE_UPSTREAM!;
    const provider = store.saveProvider({ name: `${family} · 历史模型界面演示`, kind, presetId, baseUrl, enabled: true, ...(family === 'trae' ? { relayMode: 'managed' as const } : {}), ...(kind === 'openai-compatible' ? { apiKey: PRIVATE_KEY + ':' + family } : {}) });
    if (kind === 'copilot') store.setSecret(provider.id, { copilotAccountId: 'copilot:99887766' });
    else if (kind !== 'openai-compatible') store.setSecret(provider.id, { accessToken: PRIVATE_KEY + ':' + family, expiresAt: Date.now() + 7_200_000 });
    if (family === 'jetbrains') store.setManagedState(`auth-metadata:${provider.id}`, { clientImport: { client: 'jetbrains-ide' } });
    ids[family] = provider.id;
    oldModels.push(store.saveModel({ providerId: provider.id, upstreamId: id(family, 'history-kept'), alias: `my-preserved-${family}-history`, displayName: '已保存的历史模型自定义名称', wireApi: kind === 'codex' || kind === 'grok' ? 'responses' : 'chat-completions', contextWindow: 12345, maxOutputTokens: 777, tools: false, vision: false, enabled: true }));
  }
  const binding = store.listBindings().find(value => value.id === 'dsh'); assert.ok(binding);
  store.saveBinding({ ...binding, mode: 'aggregate', enabled: false, providerIds: Object.values(ids), modelIds: oldModels.map(value => value.id), modelSelection: 'selected', defaultModelId: oldModels[0].id });
  store.setManagedState(IDS_KEY, ids); store.setManagedState(MODE_KEY, 'verified'); store.setManagedState(CALLS_KEY, 0);
  return { now: () => Date.now() + store.getManagedState(CATALOG_CLOCK_OFFSET_KEY, 0), models(provider, signal) {
    const family = families.find(value => ids[value] === provider.id); if (!family) return;
    if (signal.aborted) throw new Error('Synthetic catalog canceled');
    store.setManagedState(CALLS_KEY, store.getManagedState(CALLS_KEY, 0) + 1);
    const mode = store.getManagedState<'verified' | 'unverified' | 'no-current' | 'limited-current' | 'public-shape'>(MODE_KEY, 'verified');
    if (family === 'trae' && mode === 'public-shape') return new Response(JSON.stringify({ data: TRAE_PUBLIC_DIRECTORY.map(model => ({ id: model.id, name: 'name' in model ? model.name : model.id, modeldock_catalog_visibility: model.visibility, ...(model.importable ? {} : { modeldock_catalog_importable: false, modeldock_catalog_blocked_reason: 'account-access' }) })), modeldock_history: { source: 'trae-client', currentVerified: true, message: TRAE_PUBLIC_SCOPE } }), { headers: { 'content-type': 'application/json' } });
    const entries = ['current-a', 'current-b', 'history-new', 'history-kept'].map(suffix => ({ id: id(family, suffix), name: `合成 ${suffix}`, context_length: 32768, tools: false, vision: false, supported_endpoints: ['chat_completions'], ...(family !== 'api' && !(mode === 'unverified' && suffix.startsWith('current-')) ? { modeldock_catalog_visibility: suffix.startsWith('current-') ? 'current' : 'historical' } : {}), ...(mode === 'limited-current' && suffix === 'current-b' ? { modeldock_catalog_importable: false } : {}) }));
    if (mode === 'unverified') entries.push({ id: id(family, 'visibility-unknown'), name: '合成显示状态未核实的模型', context_length: 32768, tools: false, vision: false, supported_endpoints: ['chat_completions'] });
    return new Response(JSON.stringify({ data: mode === 'no-current' ? entries.slice(2) : entries, ...(family === 'api' ? {} : { modeldock_history: { source: source(family), currentVerified: mode !== 'unverified', message: mode === 'unverified' ? '合成客户端当前清单未核实；默认仅显示已确认的当前模型。' : mode === 'limited-current' ? '合成客户端当前清单有 2 项；其中 1 项官方直连配置尚未核实，暂不可添加。' : '已按合成客户端当前清单筛选；可勾选查看历史模型。' } }) }), { headers: { 'content-type': 'application/json' } });
  } };
}

export async function verifyHistoryModels(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true); assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1'); assert.equal(process.env.MODELDOCK_SMOKE_MODEL_HISTORY_ONLY, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const owned = relative(resolve(outputDir, 'data'), resolve(store.dataDir)); assert.ok(owned && !owned.startsWith('..'));
  const ids = store.getManagedState<Record<Family, string>>(IDS_KEY, {} as Record<Family, string>);
  const initialModels = store.listModels(), initialBindings = store.listBindings(), screenshots: string[] = [], checked: Family[] = [];
  const initialSize = window.getSize(), minimum = window.getMinimumSize();
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>;
  const originalTheme = await evaluate<{ theme?: string; colorScheme: string }>('({theme:document.documentElement.dataset.theme,colorScheme:document.documentElement.style.colorScheme})');
  async function waitFor(code: string, label: string) { const end = Date.now() + 10_000; while (Date.now() < end) { if (await evaluate<boolean>(code)) return; await new Promise(resolve => setTimeout(resolve, 25)); } writeFileSync(join(outputDir, 'history-models-timeout.png'), await captureUi()); throw new Error(`History model UI timed out: ${label}`); }
  async function click(selector: string) { await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector); await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`); }
  async function textInput(selector: string, value: string) { await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))})()`); }
  const row = (family: Family, suffix: string) => `.discovery-model:has(input[aria-label="选择模型 ${id(family, suffix)}"])`;
  const expandModel = (upstreamId: string) => click(`button[aria-expanded="false"][aria-label="${upstreamId} 参数设置"]`);
  const toggle = '[data-action="show-history-models"]', selectAll = '.discovery-list-header input[type="checkbox"]';
  async function open(family: Family) { await click('[aria-label="刷新本机配置"]'); await click(`[data-source-id="${ids[family]}"]`); await click('[data-action="discover-models"]'); await waitFor(`!document.querySelector('.discovery-loading,.discovery-error')&&!!document.querySelector('.discovery-footer')`, `${family} native catalog`); }
  async function close() { await click('[aria-label="关闭对话框"]'); await waitFor(`!document.querySelector('[role="dialog"]')`, 'directory closed'); }
  async function capture(name: string) { await evaluate('document.querySelectorAll(\'.toast-stack [aria-label="关闭提示"]\').forEach(button=>button.click())'); await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); const overflow = await evaluate<boolean>(`document.documentElement.scrollWidth>innerWidth+1||document.querySelector('.modal').scrollWidth>document.querySelector('.modal').clientWidth+1`); assert.equal(overflow, false); const file = `history-models-${name}.png`; writeFileSync(join(outputDir, file), await captureUi()); screenshots.push(file); }
  try {
    window.setMinimumSize(980, 680);
    store.setManagedState(MODE_KEY, 'limited-current'); await open('trae');
    await waitFor(`document.querySelectorAll('.discovery-model').length===2`, 'all current client rows include a nonimportable model');
    const blocked = row('trae', 'current-b');
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(blocked)}+' input[type="checkbox"]').disabled`), true);
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(blocked)}+' input[type="checkbox"]').checked`), false);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-unimportable]').length`), 1);
    await expandModel(id('trae', 'current-b'));
    assert.match(await evaluate<string>(`document.querySelector(${JSON.stringify(blocked)}).textContent`), /客户端中可见，官方直连配置尚未核实/);
    assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').textContent`), /已选择 1 个待添加模型/); await capture('current-visible-unimportable-route');
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(blocked)}+' input[type="checkbox"]');node.checked=true;node.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await click(selectAll); await waitFor(`document.querySelector('.discovery-footer .button.primary').disabled`, 'a forged disabled checkbox cannot make a nonimportable row submittable');
    await evaluate(`document.querySelector('.discovery-footer .button.primary').click()`);
    const rejected = await evaluate<boolean>(`window.modelDock.addDiscoveredModels(${JSON.stringify(ids.trae)},[{upstreamId:${JSON.stringify(id('trae', 'current-b'))}}]).then(()=>false,()=>true)`);
    assert.equal(rejected, true, 'The main-process catalog rejects a nonimportable client-only entry');
    assert.deepEqual(store.listModels(), initialModels); assert.deepEqual(store.listBindings(), initialBindings); await close(); store.setManagedState(MODE_KEY, 'verified');
    for (const family of families.filter(value => value !== 'api')) {
      await open(family);
      assert.equal(await evaluate<boolean>(`document.querySelector('${toggle}').checked`), false, 'Every subscription opens with history hidden');
      assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model').length`), 2);
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-historical]').length`), 0);
      assert.match(await evaluate<string>(`document.querySelector('[data-discovery-count]').textContent`), /^2 个模型/);
      assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').textContent`), /已选择 2 个待添加模型/);
      const calls = store.getManagedState(CALLS_KEY, 0);
      await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===4`, 'history becomes visible');
      assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-historical]').length`), 2);
      assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(row(family, 'history-kept'))}+' input[type="checkbox"]').disabled`), true);
      assert.match(await evaluate<string>(`document.querySelector('[data-discovery-count]').textContent`), /^4 个模型 · 1 个已添加/);
      await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===2`, 'history is hidden again');
      assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').textContent`), /已选择 2 个待添加模型/);
      await click('.discovery-toolbar button[aria-expanded]');
      await textInput('.discovery-advanced-grid input[type="number"]', '64000');
      await click('.discovery-advanced > .button');
      await click(toggle);
      await expandModel(id(family, 'history-new'));
      assert.equal(await evaluate<string>(`document.querySelector('input[aria-label="${id(family, 'history-new')} 上下文长度"]').value`), '32768', 'Bulk edits exclude history hidden by the history filter');
      await expandModel(id(family, 'current-b'));
      assert.equal(await evaluate<string>(`document.querySelector('input[aria-label="${id(family, 'current-b')} 上下文长度"]').value`), '64000');
      await click(selectAll); // All visible pending candidates become unselected.
      await textInput('input[aria-label="搜索模型"]', 'history-new');
      await waitFor(`document.querySelectorAll('.discovery-model').length===1`, 'history search'); await click(selectAll);
      await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===0`, 'hidden history stays hidden under search');
      assert.equal(await evaluate<boolean>(`document.querySelector('.discovery-footer .button.primary').disabled`), true, 'Hidden historical selection cannot be submitted');
      await textInput('input[aria-label="搜索模型"]', ''); await waitFor(`document.querySelectorAll('.discovery-model').length===2`, 'current rows restored');
      await click(selectAll);
      await textInput('input[aria-label="搜索模型"]', 'current-a'); await waitFor(`document.querySelectorAll('.discovery-model').length===1`, 'current search');
      assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').textContent`), /已选择 2 个待添加模型/, 'Existing search selection semantics remain unchanged');
      await textInput('input[aria-label="搜索模型"]', '');
      assert.equal(store.getManagedState(CALLS_KEY, 0), calls, 'History and search toggles do not refetch the catalog');
      if (family === 'trae') for (const [theme, width] of [['light', 1180], ['dark', 980]] as const) {
        window.setSize(width, 800); await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`);
        await capture(`current-${theme}-${width}`); await click(toggle); await capture(`all-${theme}-${width}`);
        await evaluate(`document.querySelector(${JSON.stringify(row(family, 'history-new'))}).scrollIntoView({block:'center'})`); await capture(`non-client-rows-${theme}-${width}`);
        await click(toggle);
      }
      await click('.discovery-footer .button.primary'); await waitFor(`!!document.querySelector('.discovery-success')`, 'only current models are added');
      const saved = store.listModels().filter(model => model.providerId === ids[family]);
      assert.equal(saved.length, 3); assert.ok(saved.every(model => model.upstreamId !== id(family, 'history-new')));
      assert.deepEqual(saved.find(model => model.upstreamId === id(family, 'history-kept')), initialModels.find(model => model.providerId === ids[family]));
      assert.deepEqual(store.listBindings(), initialBindings, 'Historical filtering and adding current models preserve tool bindings');
      await close(); await open(family);
      assert.equal(await evaluate<boolean>(`document.querySelector('${toggle}').checked`), false); assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model.existing').length`), 2);
      await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model.existing').length===3`, 'saved history is still present after reopening'); await close(); checked.push(family);
    }
    store.setManagedState(MODE_KEY, 'unverified'); await open('trae');
    assert.match(await evaluate<string>(`document.querySelector('[data-discovery-history-message]').textContent`), /当前清单未核实/);
    assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model').length`), 0, 'Unknown visibility is not shown as a confirmed current model');
    assert.match(await evaluate<string>(`document.querySelector('.discovery-body').textContent`), /尚未核实当前客户端清单/);
    assert.equal(await evaluate<boolean>(`document.querySelector('.discovery-footer .button.primary').disabled`), true); await capture('unverified-current-message');
    await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===5`, 'explicitly reveal unverified and non-client entries');
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-visibility-unknown]').length`), 3);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-historical]').length`), 2, 'Unknown entries are not mislabeled as proven non-client entries');
    await click(toggle); await click('.discovery-toolbar button[aria-expanded]'); await textInput('.discovery-advanced-grid input[type="number"]', '96000');
    assert.equal(await evaluate<boolean>(`document.querySelector('.discovery-advanced > .button').disabled`), true, 'Unverified entries hidden by the history filter cannot receive bulk edits');
    await click(toggle); await expandModel(id('trae', 'visibility-unknown'));
    assert.equal(await evaluate<string>(`document.querySelector('input[aria-label="${id('trae', 'visibility-unknown')} 上下文长度"]').value`), '32768');
    await evaluate(`document.querySelector(${JSON.stringify(row('trae', 'visibility-unknown'))}).scrollIntoView({block:'center'})`); await capture('unverified-other-entries'); await close();
    store.setManagedState(MODE_KEY, 'no-current'); await open('trae');
    assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model').length`), 0); assert.match(await evaluate<string>(`document.querySelector('.discovery-body').textContent`), /没有已确认的当前模型/); await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===2`, 'explicitly reveal an all-history catalog'); await close();
    store.setManagedState(MODE_KEY, 'verified'); await open('api');
    assert.equal(await evaluate<boolean>(`!!document.querySelector('${toggle}')`), false, 'A generic API without client catalog semantics has no history checkbox'); assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model').length`), 4); await capture('generic-api-no-history-filter'); await close();
    const publicHistory = TRAE_PUBLIC_DIRECTORY.find(model => model.visibility === 'historical'); assert.ok(publicHistory);
    const keptPublicHistory = store.saveModel({ providerId: ids.trae, upstreamId: publicHistory.id, alias: 'qa-public-history-preserved', displayName: '保留已有历史模型的自定义名称', wireApi: 'chat-completions', contextWindow: 65536, maxOutputTokens: 2048, tools: false, vision: false, enabled: true });
    const historyBinding = store.listBindings().find(binding => binding.id === 'dsh'); assert.ok(historyBinding);
    store.saveBinding({ ...historyBinding, modelIds: [...historyBinding.modelIds, keptPublicHistory.id], defaultModelId: keptPublicHistory.id });
    const publicModelsBefore = store.listModels(), publicBindingsBefore = store.listBindings();
    store.setManagedState(MODE_KEY, 'public-shape'); window.setSize(980, 800); await evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'"); await open('trae');
    await waitFor(`document.querySelectorAll('.discovery-model').length===18`, 'all eighteen client-current public model names are displayed');
    assert.equal(await evaluate<boolean>(`document.querySelector('${toggle}').checked`), false);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-unimportable]').length`), 1);
    assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model-select > input:not(:disabled):checked').length`), 17);
    assert.match(await evaluate<string>(`document.querySelector('[data-discovery-count]').textContent`), /^18 个模型/);
    assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').textContent`), /已选择 17 个待添加模型/);
    assert.equal(await evaluate<boolean>(`(()=>{const note=document.querySelector('[data-discovery-history-message]');return note.textContent===${JSON.stringify(TRAE_PUBLIC_SCOPE)}&&note.scrollWidth<=note.clientWidth+1})()`), true, 'The complete account-cache scope and account-access explanation wraps without overflow');
    const lockedKimi = '.discovery-model:has([data-model-unimportable="account-access"])';
    assert.equal(await evaluate<string>(`document.querySelector(${JSON.stringify(lockedKimi)}+' strong').title`), 'kimi-k3.1-pro');
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(lockedKimi)}+' input[type="checkbox"]').disabled`), true);
    const publicCalls = store.getManagedState(CALLS_KEY, 0); await capture('public-shape-current-top-dark-980');
    await expandModel('kimi-k3.1-pro');
    assert.match(await evaluate<string>(`document.querySelector(${JSON.stringify(lockedKimi)}).textContent`), /当前 TRAE 账号没有此模型的使用权限/);
    await evaluate(`document.querySelector(${JSON.stringify(lockedKimi)}).scrollIntoView({block:'center'})`);
    await capture('public-shape-account-restriction-dark-980');
    const lastCurrent = TRAE_PUBLIC_DIRECTORY.filter(model => model.visibility === 'current').at(-1)!;
    await evaluate(`document.querySelector(${JSON.stringify(`.discovery-model:has(input[aria-label="选择模型 ${lastCurrent.id}"])`)}).scrollIntoView({block:'center'})`); await capture('public-shape-current-last-dark-980');
    await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===37`, 'history reveals thirty-seven eligible subscription entries without personal BYOK');
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-historical]').length`), 19);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-model-unimportable]').length`), 1);
    assert.equal(await evaluate<number>(`document.querySelectorAll('.discovery-model.existing').length`), 1);
    assert.match(await evaluate<string>(`document.querySelector('[data-discovery-count]').textContent`), /^37 个模型 · 1 个已添加/);
    const publicHistoryRow = `.discovery-model:has(input[aria-label="选择模型 ${publicHistory.id}"])`;
    assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(publicHistoryRow)}+' input[type="checkbox"]').disabled`), true);
    await evaluate(`document.querySelector(${JSON.stringify(publicHistoryRow)}).scrollIntoView({block:'center'})`); await capture('public-shape-history-dark-980');
    await click(toggle); await waitFor(`document.querySelectorAll('.discovery-model').length===18`, 'default current inventory is restored');
    assert.match(await evaluate<string>(`document.querySelector('.discovery-footer').textContent`), /已选择 17 个待添加模型/);
    assert.equal(store.getManagedState(CALLS_KEY, 0), publicCalls);
    assert.deepEqual(store.listModels(), publicModelsBefore);
    const eight = TRAE_PUBLIC_DIRECTORY.filter(model => model.visibility === 'current' && model.importable).slice(-8);
    await click(selectAll);
    for (const { id: modelId } of eight) await click(`input[aria-label="选择模型 ${modelId}"]`);
    const last = eight[eight.length - 1].id, aliasField = `input[aria-label="${last} 模型简称"]`, submit = '.discovery-footer .button.primary';
    await expandModel(last);
    await textInput(aliasField, 'invalid alias');
    await evaluate("document.querySelector('.discovery-body').scrollTop=document.querySelector('.discovery-body').scrollHeight");
    await click(submit);
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('简称')`, 'invalid edit explains the refusal');
    assert.equal(await evaluate<boolean>(`(()=>{const alert=document.querySelector('[role="alert"]').getBoundingClientRect();const bounds=document.querySelector('.modal').getBoundingClientRect();return alert.top>=bounds.top && alert.bottom<=bounds.bottom && document.elementFromPoint(alert.left+6,alert.top+6)?.closest('[role="alert"]')!==null})()`),true);
    assert.deepEqual(store.listModels(), publicModelsBefore);
    await capture('add-error-at-list-bottom');
    await textInput(aliasField, 'qa-edited-qwen-max');
    await textInput(`input[aria-label="${last} 显示名称"]`, 'Qwen 已编辑');
    store.setManagedState(CATALOG_CLOCK_OFFSET_KEY, 11 * 60_000);
    await click(submit);
    await waitFor(`document.querySelector('.discovery-success')?.textContent.includes('已添加 8 个模型')`, 'one click after 11 minutes saves the eight edited choices');
    assert.equal(store.getManagedState(CALLS_KEY, 0), publicCalls + 1);
    const newlySaved = store.listModels().filter(model => !publicModelsBefore.some(old => old.id === model.id));
    assert.deepEqual(newlySaved.map(model => model.upstreamId).sort(), eight.map(model => model.id).sort());
    const edited = newlySaved.find(model => model.upstreamId === last);
    assert.equal(edited?.alias, 'qa-edited-qwen-max'); assert.equal(edited.displayName, 'Qwen 已编辑');
    assert.deepEqual(store.listBindings(), publicBindingsBefore);
    await capture('added-eight-after-expiry');
    await close();
    await open('trae'); await waitFor(`document.querySelectorAll('.discovery-model.existing').length === 8`, 'saved choices survive reopening'); await close();
    const publicView = await evaluate<string>('(async()=>JSON.stringify({snapshot:await window.modelDock.snapshot(),body:document.body.innerText,diagnostics:await window.modelDock.queryDiagnostics({limit:200})}))()'); assert.equal(publicView.includes(PRIVATE_KEY), false);
    writeFileSync(join(outputDir, 'history-models-validation.json'), JSON.stringify({ ok: true, families: checked, defaultHistoryHidden: true, toggleDoesNotRefetch: true, hiddenHistoryNeverSubmittedOrBulkEdited: true, currentUnroutableVisibleButNotImportable: true, forgedCheckboxCannotSubmitUnroutable: true, backendRejectsUnroutableModel: true, searchSelectionSemanticsPreserved: true, existingHistoricalModelsAndBindingsPreserved: true, reopenDefaultsToCurrent: true, unknownVisibilityNotInvented: true, unknownHiddenByDefault: true, unverifiedCurrentMessageVisible: true, emptyCurrentRequiresExplicitHistory: true, genericApiNoHistoryCheckbox: true, expiredSelection: { minutesOpen: 11, saved: 8, refreshes: 1, editsPreserved: true }, publicTraeShape: { current: 18, historical: 19, total: 37, currentImportable: 17, currentReadOnly: 1, longScopeFits: true, historicalModelAndBindingPreserved: true }, noRealAccountsOrNetwork: true, screenshots }, null, 2));
  } finally { store.setManagedState(MODE_KEY, 'verified'); await evaluate(`(()=>{const original=${JSON.stringify(originalTheme)};if(original.theme===undefined)delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.colorScheme})()`); window.setMinimumSize(minimum[0], minimum[1]); window.setSize(initialSize[0], initialSize[1]); }
}
