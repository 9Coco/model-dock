import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyConfig, buildConfig, connectionKey } from '../src/main/adapters';
import { applyJetBrainsConfig, buildJetBrainsConfig, jetBrainsHistoryKey, jetBrainsStatus, restoreJetBrainsConfig, type JetBrainsConfigOptions } from '../src/main/jetbrains-config';
import { restoreOfficialConfig } from '../src/main/tool-restore';
import { JETBRAINS_TOOLS, type JetBrainsToolId } from '../src/shared/jetbrains';
import type { Model, Provider, ProviderSecret, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const fileNames = ['llm.provider.openai.like.xml', 'llm.custom.models.xml', 'llm.third.party.ai.providers.xml'];
function fixture(tool: JetBrainsToolId = 'webstorm') {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-jetbrains-')); roots.push(root);
  const profileRoot = join(root, '.config', 'JetBrains'), cacheRoot = join(root, '.cache', 'JetBrains'), selector = `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`;
  const target = join(profileRoot, selector), backups = join(root, 'backups'), states = new Map<string, unknown>(), journals: any[] = [];
  const write = (path: string, text: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  mkdirSync(join(target, 'options'), { recursive: true }); write(join(cacheRoot, selector, '.pid'), '2147483646');
  const provider: Provider = { id: 'fixture-provider', name: 'Fixture provider', kind: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', hasSecret: true, enabled: true, authStatus: 'ready', note: '' };
  const models: Model[] = [
    { id: 'core', providerId: provider.id, upstreamId: 'upstream-core', alias: 'local-core', displayName: 'Core fixture', wireApi: 'responses', contextWindow: 32768, tools: true, vision: false, enabled: true },
    { id: 'chat', providerId: provider.id, upstreamId: 'upstream-chat', alias: 'local-chat', displayName: 'Chat fixture', wireApi: 'chat-completions', contextWindow: 32768, tools: false, vision: false, enabled: true },
  ];
  const binding: ToolBinding = { id: tool, name: JETBRAINS_TOOLS[tool].name, note: '', enabled: true, mode: 'aggregate', providerIds: [provider.id], modelSelection: 'all', modelIds: [], defaultModelId: 'core' };
  const providers = [provider];
  const store = { listModels: () => models, listBindings: () => [binding], listProviders: () => providers, gatewayKey: vi.fn(() => 'SYNTHETIC_LOCAL_KEY'), getSecret: vi.fn((): ProviderSecret => { throw new Error('Upstream key must never be read'); }),
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn((_kind: string, value: unknown) => { journals.push(structuredClone(value)); return 'synthetic-encrypted-backup.enc'; }),
  };
  const options: JetBrainsConfigOptions = { profileRoot, cacheRoot, platform: 'linux', processProbe: () => 'stopped', port: 19876 };
  const file = (index: number) => join(target, 'options', fileNames[index]);
  const read = (index: number) => readFileSync(file(index), 'utf8');
  const apply = (extra: JetBrainsConfigOptions = {}) => applyJetBrainsConfig(store, tool, backups, root, { ...options, ...extra });
  const restore = (extra: JetBrainsConfigOptions = {}) => restoreJetBrainsConfig(store, tool, backups, root, { ...options, ...extra });
  const key = jetBrainsHistoryKey(target, tool);
  const originals = [
    `<?xml version="1.0" encoding="UTF-8"?>\n<application>\n  <!-- keep provider comment -->\n  <component name="Unrelated"><option name="keep" value="keep &amp; safe" /></component>\n  <component name="OpenAILikeLlmProviderSettings">\n    <option name='baseUrl' value='https://old.fixture/v1' />\n    <option name="httpClientVersion" value="HTTP_2" />\n    <option name="toolEnabled" value="false" />\n    <!-- keep extra option --> <option name="unrelatedSetting" value="stay" />\n  </component>\n</application>\n`,
    `<application><component name="LlmCustomModelsSettings">\n<option name="smart_model_id" value="OpenAIAPI/old-core" />\n<option name="quick_model_id" value="OpenAIAPI/old-quick" />\n<option name="editor_model_id" value="Other/editor" />\n<option name="model_context_size" value="32768" />\n</component></application>`,
    `<application><component name="LLMThirdPartyAIProvidersSettings"><option name="enabledThirdPartyAIProviders">\n<!-- keep Google --> <option value="Google" />\n</option></component></application>`,
  ];
  const seed = () => originals.forEach((text, index) => write(file(index), text));
  return { root, tool, profileRoot, cacheRoot, selector, target, backups, store, states, journals, provider, providers, models, binding, options, write, file, read, apply, restore, key, seed, originals };
}


const completionFile = (f: ReturnType<typeof fixture>) => join(f.target, 'options', 'llm.next.edit.providers.xml');
function enableNativeCompletion(f: ReturnType<typeof fixture>) {
  f.provider.presetId = 'deepseek'; f.provider.baseUrl = 'https://api.deepseek.com'; f.models[0].upstreamId = 'deepseek-flash';
}
function completionFixture(f: ReturnType<typeof fixture>) {
  const state = { selectedProvider: { id: 'manual-openai', kind: 'OPENAI_COMPATIBLE', name: 'Manual completion' },
    openAiCompatible: { baseUrl: 'https://old-completion.fixture/v1', model: 'old-completion', providerId: 'OpenAIAPI', modelId: 'OpenAIAPI/old-assignment', schemaId: 'fim.deepseek', maxTokens: '24576', maxOutputTokens: '768', apiKeyConfigured: false },
    inception: { model: 'keep-mercury' }, mistral: { model: 'keep-codestral' }, deepSeek: { model: 'keep-deepseek' }, migration: { completed: false }, unknownFutureSetting: { items: [1, 'stay'] } };
  const original = `<application>\n<!-- keep completion comment -->\n<component name="UnrelatedCompletion"><option name="keep" value="same"/></component>\n<component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(state)}]]></component>\n</application>\n`;
  f.write(completionFile(f), original);
  return { state, original };
}
function safeRestoredOriginal(original: string): string {
  const raw = original.match(/<component name="NextEditProviderSettings">([^]*?)<\/component>/)?.[1] ?? '';
  const json = [...raw.matchAll(/<!\[CDATA\[([^]*?)\]\]>/g)].map(match => match[1]).join('');
  const state = JSON.parse(json); state.selectedProvider = { ...state.selectedProvider, id: '', kind: 'NONE', name: '' };
  return original.replace(raw, `<![CDATA[${JSON.stringify(state).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`);
}
function readCompletion(f: ReturnType<typeof fixture>): any {
  const raw = readFileSync(completionFile(f), 'utf8').match(/<component name="NextEditProviderSettings">([^]*?)<\/component>/)?.[1] ?? '';
  return JSON.parse([...raw.matchAll(/<!\[CDATA\[([^]*?)\]\]>/g)].map(match => match[1]).join(''));
}

describe('JetBrains AI Assistant explicit offline configuration', () => {
  it.each(Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[])('finds the verified %s profile and exports only the local credential', tool => {
    const f = fixture(tool), status = jetBrainsStatus(tool, f.root, f.options);
    expect(status).toMatchObject({ configDir: f.target, version: '2026.2', foundProfile: true, running: 'stopped', canApply: true });
    const preview = buildConfig(f.store, tool, 19876, false, f.root, { jetBrainsOptions: f.options }), value = JSON.parse(preview.content);
    expect(value.baseUrl).toBe(`http://127.0.0.1:19876/tool/${tool}/v1`); expect(value.apiKey).toBe('__MODELDOCK_LOCAL_KEY__');
    expect(value.modelAssignment).toEqual({ core: 'OpenAIAPI/local-core', lightweight: 'OpenAIAPI/local-core' });
    expect(value.models.map((m: any) => m.id)).toEqual(['local-core', 'local-chat']); expect(value.toolCalling).toBe(true);
    expect(preview.instructions).toContain('不能作为 IDE 原生配置导入'); expect(preview.instructions).toContain('PasswordSafe');
    expect(f.store.gatewayKey).not.toHaveBeenCalled(); expect(f.store.getSecret).not.toHaveBeenCalled();
    expect(JSON.parse(buildJetBrainsConfig(f.store, tool, 19876, true, f.root, f.options).content).apiKey).toBe('SYNTHETIC_LOCAL_KEY');
    expect(readdirSync(join(f.target, 'options'))).toHaveLength(0); expect(f.states.size).toBe(0);
  });
  it('point-edits verified fields, keeps XML comments and all unrelated settings, and never writes a password store', () => {
    const f = fixture(); f.seed(); const passwordFile = join(f.target, 'c.kdbx'); f.write(passwordFile, 'SYNTHETIC_UNTOUCHED_PASSWORD_SAFE');
    expect(applyConfig(f.store, f.tool, 19876, f.root, f.backups, f.root, { jetBrainsOptions: f.options })).toBe(f.target);
    expect(f.read(0)).toContain("name='baseUrl' value='http://127.0.0.1:19876/tool/webstorm/v1'");
    expect(f.read(0)).toContain('name="httpClientVersion" value="HTTP_1_1"'); expect(f.read(0)).toContain('name="toolEnabled" value="true"');
    expect(f.read(0)).toContain('<!-- keep provider comment -->'); expect(f.read(0)).toContain('<component name="Unrelated"><option name="keep" value="keep &amp; safe" /></component>');
    expect(f.read(0)).toContain('<!-- keep extra option --> <option name="unrelatedSetting" value="stay" />');
    expect(f.read(1)).toContain('name="smart_model_id" value="OpenAIAPI/local-core"'); expect(f.read(1)).toContain('name="quick_model_id" value="OpenAIAPI/local-core"');
    expect(f.read(1)).toContain('name="editor_model_id" value="Other/editor"'); expect(f.read(1)).toContain('name="model_context_size" value="32768"');
    expect(f.read(2)).toContain('<option value="OpenAIAPI" />'); expect(f.read(2)).toContain('<!-- keep Google --> <option value="Google" />');
    expect(readFileSync(passwordFile, 'utf8')).toBe('SYNTHETIC_UNTOUCHED_PASSWORD_SAFE'); expect(f.store.gatewayKey).not.toHaveBeenCalled(); expect(f.store.getSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(f.journals)).not.toContain('SYNTHETIC_LOCAL_KEY'); expect(f.store.createManagedBackup).toHaveBeenCalledWith('jetbrains-sync', expect.any(Object));
    expect(readdirSync(f.backups)).toHaveLength(3);
    if (process.platform !== 'win32') for (const path of [...fileNames.map((_, index) => f.file(index)), ...readdirSync(f.backups).map(name => join(f.backups, name))]) expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('restores exact preexisting XML bytes after repeated model updates', async () => {
    const f = fixture(); f.seed(); f.apply(); f.models[0].alias = 'updated-core'; f.models[0].tools = false; f.apply();
    expect(f.read(1)).toContain('OpenAIAPI/updated-core'); expect(f.read(0)).toContain('name="toolEnabled" value="false"');
    await restoreOfficialConfig(f.store as any, f.tool, f.root, f.backups, f.root, { jetBrainsOptions: f.options });
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.get(f.key)).toBeNull();
  });
  it('removes newly created XML files on restoration, including after a resync', () => {
    const f = fixture(); f.apply(); f.models[0].alias = 'second'; f.apply(); f.restore();
    fileNames.forEach((_, index) => expect(existsSync(f.file(index))).toBe(false));
  });
  it('restores only managed fields while keeping later URL, model, provider and comment edits', () => {
    const f = fixture(); f.seed(); f.apply();
    f.write(f.file(0), f.read(0).replace('http://127.0.0.1:19876/tool/webstorm/v1', 'https://manual.fixture/v1').replace('name="unrelatedSetting" value="stay"', 'name="unrelatedSetting" value="manual"'));
    f.write(f.file(1), f.read(1).replace('name="smart_model_id" value="OpenAIAPI/local-core"', 'name="smart_model_id" value="OpenAIAPI/manual"'));
    f.write(f.file(2), f.read(2).replace('<option value="OpenAIAPI" />', '<option value="OpenAIAPI"><!-- added inside managed provider --></option><option value="ManualProvider" />'));
    f.restore();
    expect(f.read(0)).toContain('https://manual.fixture/v1'); expect(f.read(0)).toContain('name="unrelatedSetting" value="manual"'); expect(f.read(0)).toContain('name="httpClientVersion" value="HTTP_2"');
    expect(f.read(1)).toContain('OpenAIAPI/manual'); expect(f.read(1)).toContain('OpenAIAPI/old-quick');
    expect(f.read(2)).toContain('<option value="OpenAIAPI"><!-- added inside managed provider --></option>'); expect(f.read(2)).toContain('added inside managed provider'); expect(f.read(2)).toContain('value="Google"'); expect(f.read(2)).toContain('value="ManualProvider"');
  });
  it.each([false, true])('preserves external provider-member attributes during restoration after resync=%s', resync => {
    const f = fixture(); f.seed(); f.apply();
    const member = '<option value="OpenAIAPI" external="keep" />';
    f.write(f.file(2), f.read(2).replace('<option value="OpenAIAPI" />', member));
    if (resync) { f.models[0].alias = 'resynced-core'; f.apply(); }
    f.restore();
    expect(f.read(2)).toContain(member); expect(f.read(2)).toContain('value="Google"');
    expect(f.read(1)).toBe(f.originals[1]); expect(f.states.get(f.key)).toBeNull();
  });
  it('captures a manual managed-field change as the baseline for an explicit later sync', () => {
    const f = fixture(); f.seed(); f.apply(); f.write(f.file(1), f.read(1).replace('OpenAIAPI/local-core', 'OpenAIAPI/manual-core'));
    f.models[0].alias = 'new-core'; f.apply(); f.restore(); expect(f.read(1)).toContain('OpenAIAPI/manual-core'); expect(f.read(1)).toContain('OpenAIAPI/old-quick');
  });
  it('disabled bindings restore existing ownership but never modify unowned settings', () => {
    const f = fixture(); f.seed(); f.binding.enabled = false; f.apply(); expect(f.states.size).toBe(0); expect(existsSync(f.backups)).toBe(false);
    f.binding.enabled = true; f.apply(); f.binding.enabled = false; f.binding.providerIds = []; f.apply(); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it.each(['running', 'unknown'] as const)('blocks writing when process status is %s', status => {
    const f = fixture(); f.seed(); f.options.processProbe = () => status;
    expect(jetBrainsStatus(f.tool, f.root, f.options).canApply).toBe(false); expect(() => f.apply()).toThrow(); expect(() => f.restore()).toThrow();
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.size).toBe(0);
  });
  it('requires a valid PID and refuses to infer shutdown on Windows or macOS', () => {
    const f = fixture(), pid = join(f.cacheRoot, f.selector, '.pid');
    for (const value of ['', '0', 'bad-pid', '-1', '99999999999']) { f.write(pid, value); expect(jetBrainsStatus(f.tool, f.root, f.options).running).toBe('unknown'); expect(() => f.apply()).toThrow(); }
    rmSync(pid); expect(jetBrainsStatus(f.tool, f.root, f.options).canApply).toBe(false);
    f.write(pid, '2147483646');
    for (const platform of ['win32', 'darwin'] as const) expect(jetBrainsStatus(f.tool, f.root, { ...f.options, platform, processProbe: undefined }).canApply).toBe(false);
  });
  it('blocks legacy, future, absent and ambiguous profiles', () => {
    const f = fixture(); rmSync(f.target, { recursive: true });
    expect(jetBrainsStatus(f.tool, f.root, f.options).foundProfile).toBe(false);
    mkdirSync(join(f.profileRoot, `${JETBRAINS_TOOLS[f.tool].selectorPrefix}2025.3`));
    expect(jetBrainsStatus(f.tool, f.root, f.options).version).toBe('2025.3'); expect(() => f.apply()).toThrow('尚未验证');
    mkdirSync(f.target); expect(jetBrainsStatus(f.tool, f.root, f.options).message).toContain('多个版本');
  });
  it('requires compatible models, valid default and port', () => {
    const f = fixture();
    f.models.forEach(model => model.wireApi = 'messages'); expect(() => f.apply()).toThrow('Chat Completions'); f.models[0].wireApi = 'responses';
    f.binding.defaultModelId = 'missing'; expect(() => f.apply()).toThrow('默认模型'); f.binding.defaultModelId = 'core';
    expect(() => f.apply({ port: 65536 })).toThrow('端口'); f.models[0].alias = 'bad\nmodel'; expect(() => f.apply()).toThrow('别名'); expect(f.states.size).toBe(0);
  });
  it.each(Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[])('connects %s directly to one selected Chat API and writes upstream IDs without reading or writing the API Key during sync', tool => {
    const f = fixture(tool); f.binding.mode = 'direct'; f.binding.modelSelection = 'selected'; f.binding.modelIds = ['chat']; f.binding.defaultModelId = 'chat';
    f.store.getSecret.mockReturnValue({ apiKey: 'SYNTHETIC_PROVIDER_KEY' }); f.seed();
    const preview = buildJetBrainsConfig(f.store, tool, 19876, false, f.root, f.options), value = JSON.parse(preview.content);
    expect(value.baseUrl).toBe(f.provider.baseUrl); expect(value.apiKey).toBe('__PROVIDER_API_KEY__');
    expect(value.models).toEqual([{ id: 'upstream-chat', name: 'Chat fixture', wireApi: 'chat-completions' }]); expect(value.modelAssignment.core).toBe('OpenAIAPI/upstream-chat');
    expect(preview.instructions).toContain('直接连接'); expect(f.store.getSecret).not.toHaveBeenCalled();
    f.apply(); expect(f.read(0)).toContain(f.provider.baseUrl); expect(f.read(1)).toContain('OpenAIAPI/upstream-chat'); expect(f.store.getSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(f.journals)).not.toContain('SYNTHETIC_PROVIDER_KEY'); expect(f.store.gatewayKey).not.toHaveBeenCalled();
    expect(JSON.parse(buildJetBrainsConfig(f.store, tool, 19876, true, f.root, f.options).content).apiKey).toBe('SYNTHETIC_PROVIDER_KEY'); expect(connectionKey(f.store, tool)).toBe('SYNTHETIC_PROVIDER_KEY');
    f.restore(); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it.each(['openai-compatible', 'codex', 'copilot', 'grok'] as const)('uses one aggregate Chat bridge for %s Responses or subscription sources without exporting upstream credentials', kind => {
    const f = fixture(); f.binding.mode = 'aggregate'; f.provider.kind = kind;
    const value = JSON.parse(buildJetBrainsConfig(f.store, f.tool, 19876, true, f.root, f.options).content);
    expect(value.baseUrl).toBe('http://127.0.0.1:19876/tool/webstorm/v1'); expect(value.apiKey).toBe('SYNTHETIC_LOCAL_KEY'); expect(value.modelAssignment.core).toBe('OpenAIAPI/local-core');
    expect(value.models.every((model: any) => model.wireApi === 'chat-completions')).toBe(true); expect(connectionKey(f.store, f.tool)).toBe('SYNTHETIC_LOCAL_KEY');
    f.apply(); expect(f.read(1)).toContain('OpenAIAPI/local-core'); expect(f.store.getSecret).not.toHaveBeenCalled();
  });
  it('switches one direct API to multiple aggregate sources and back while retaining the original XML restore baseline', () => {
    const f = fixture(); f.seed(); f.binding.mode = 'direct'; f.models[0].wireApi = 'chat-completions'; f.apply(); expect(f.read(1)).toContain('OpenAIAPI/upstream-core');
    const subscription: Provider = { ...f.provider, id: 'subscription-source', kind: 'codex' }; f.providers.push(subscription);
    f.models.push({ ...f.models[0], id: 'subscription-model', providerId: subscription.id, upstreamId: 'subscription-upstream', alias: 'subscription-alias', wireApi: 'responses' });
    f.binding.mode = 'aggregate'; f.binding.providerIds!.push(subscription.id); f.binding.defaultModelId = 'subscription-model'; f.apply();
    expect(f.read(0)).toContain('http://127.0.0.1:19876/tool/webstorm/v1'); expect(f.read(1)).toContain('OpenAIAPI/subscription-alias');
    const value = JSON.parse(buildJetBrainsConfig(f.store, f.tool, 19876, true, f.root, f.options).content); expect(value.models.map((model: any) => model.id)).toEqual(['local-core', 'local-chat', 'subscription-alias']);
    expect(value.apiKey).toBe('SYNTHETIC_LOCAL_KEY'); expect(f.store.getSecret).not.toHaveBeenCalled();
    f.binding.mode = 'direct'; f.binding.providerIds = [f.provider.id]; f.binding.defaultModelId = 'core'; f.apply(); expect(f.read(1)).toContain('OpenAIAPI/upstream-core');
    f.restore(); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it('keeps legacy auto endpoints local, rejects multi-source direct configuration, and requires an API key only when explicitly revealing it', () => {
    const f = fixture(); f.models[0].wireApi = 'chat-completions'; f.binding.mode = 'auto';
    expect(JSON.parse(buildJetBrainsConfig(f.store, f.tool, 19876).content).baseUrl).toContain('127.0.0.1');
    f.binding.mode = 'direct'; f.binding.providerIds!.push('extra'); expect(() => f.apply()).toThrow('恰好一个');
    f.binding.providerIds = [f.provider.id]; f.store.getSecret.mockReturnValue({ apiKey: '' });
    expect(() => buildJetBrainsConfig(f.store, f.tool, 19876)).not.toThrow(); expect(() => buildJetBrainsConfig(f.store, f.tool, 19876, true)).toThrow('API Key');
    expect(() => f.apply()).not.toThrow(); expect(f.store.getSecret).toHaveBeenCalledTimes(1);
  });
  it('keeps native direct export compatible with stores that expose only getProvider', () => {
    const f = fixture(); f.binding.mode = 'direct'; f.models[0].wireApi = 'chat-completions'; f.store.getSecret.mockReturnValue({ apiKey: 'SYNTHETIC_PROVIDER_KEY' });
    const store = { ...f.store, listProviders: undefined, getProvider: (id: string) => f.providers.find(provider => provider.id === id) };
    const value = JSON.parse(buildJetBrainsConfig(store, f.tool, 19876, true).content);
    expect(value.baseUrl).toBe(f.provider.baseUrl); expect(value.apiKey).toBe('SYNTHETIC_PROVIDER_KEY'); expect(value.modelAssignment.core).toBe('OpenAIAPI/upstream-core');
  });
  it('escapes model aliases while preserving their original semantic identifier', () => {
    const f = fixture(); f.models[0].alias = 'fixture<&"\'model'; f.apply(); expect(f.read(1)).toContain('OpenAIAPI/fixture&lt;&amp;&quot;&apos;model'); f.restore(); expect(existsSync(f.file(1))).toBe(false);
  });
  it.each([
    '<!DOCTYPE application><application />', '<!DOCTYPE application [<!ENTITY secret SYSTEM "file:///etc/passwd">]><application />', '<application>&unknown;</application>',
    '<application><component></application>', '<application/><application/>', '<application name="a" name="b"/>', '<application><!-- bad -- comment --></application>',
    '<application><component name="OpenAILikeLlmProviderSettings"/><component name="OpenAILikeLlmProviderSettings"/></application>',
    '<application><component name="OpenAILikeLlmProviderSettings"><option name="baseUrl" value="a"/><option name="baseUrl" value="b"/></component></application>',
    '<application><component name="OpenAILikeLlmProviderSettings"><option name="baseUrl"><map/></option></component></application>',
    '<application><component name="LLMThirdPartyAIProvidersSettings"><option name="enabledThirdPartyAIProviders"><set/></option></component></application>',
    'not XML', '<application>&#0;</application>', '<application/><!ENTITY x "test">',
  ])('rejects unsafe or incompatible XML before writing any managed file: %s', xml => {
    const f = fixture(); f.seed(); f.write(xml.includes('LLMThirdPartyAIProvidersSettings') ? f.file(2) : f.file(0), xml);
    const original = fileNames.map((_, index) => f.read(index)); expect(() => f.apply()).toThrow(); original.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.size).toBe(0); expect(existsSync(f.backups)).toBe(false);
  });
  it('rejects file and parent links, hard links, invalid UTF-8 and oversized XML', () => {
    const f = fixture(), other = join(f.root, 'other.xml'); f.write(other, '<application/>'); symlinkSync(other, f.file(0)); expect(() => f.apply()).toThrow(); rmSync(f.file(0));
    linkSync(other, f.file(0)); expect(() => f.apply()).toThrow(); rmSync(f.file(0)); f.write(f.file(0), Buffer.from([0xc0, 0xaf])); expect(() => f.apply()).toThrow();
    f.write(f.file(0), ' '.repeat(512 * 1024 + 1)); expect(() => f.apply()).toThrow(); rmSync(join(f.target, 'options'), { recursive: true }); symlinkSync(join(f.root), join(f.target, 'options'), 'dir'); expect(() => f.apply()).toThrow();
    expect(f.states.size).toBe(0); expect(existsSync(f.backups)).toBe(false);
  });
  it('preserves a concurrent external edit and commits no ownership record', () => {
    const f = fixture(); f.seed(); const manual = f.originals[2].replace('Google', 'Manual');
    expect(() => f.apply({ beforeCommit: () => f.write(f.file(2), manual) })).toThrow('其他程序');
    expect(f.read(0)).toBe(f.originals[0]); expect(f.read(1)).toBe(f.originals[1]); expect(f.read(2)).toBe(manual); expect(f.states.size).toBe(0); expect(readdirSync(f.backups)).toHaveLength(3);
  });
  it('rolls back all committed files after a write failure', () => {
    const f = fixture(); f.seed(); expect(() => f.apply({ afterFileCommit: () => { throw new Error('SYNTHETIC_WRITE_FAILURE'); } })).toThrow('SYNTHETIC_WRITE_FAILURE');
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.get(f.key)).toBeNull();
  });
  it('rolls back files and encrypted state if final persistence fails after mutation', () => {
    const f = fixture(); f.seed(); f.store.setManagedState.mockImplementationOnce((key, value) => { f.states.set(key, structuredClone(value)); }).mockImplementationOnce((key, value) => { f.states.set(key, structuredClone(value)); throw new Error('SYNTHETIC_STATE_FAILURE'); });
    expect(() => f.apply()).toThrow('SYNTHETIC_STATE_FAILURE'); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.get(f.key)).toBeNull();
  });
  it('keeps external edits to an already committed file and leaves a recoverable encrypted journal', () => {
    const f = fixture(); f.seed(); const external = '<application><component name="Manual"/></application>';
    expect(() => f.apply({ afterFileCommit: () => { f.write(f.file(0), external); throw new Error('SYNTHETIC_FAILURE'); } })).toThrow('回滚遇到外部修改');
    expect(f.read(0)).toBe(external); expect((f.states.get(f.key) as any).pending).toBeDefined(); expect(() => f.restore()).toThrow('外部修改'); expect(f.read(0)).toBe(external);
  });
  it('recovers a synthetic interrupted multi-file transaction only when all files remain before or after', () => {
    const f = fixture(); f.seed(); f.apply(); const journal = f.journals[0];
    f.originals.forEach((text, index) => f.write(f.file(index), text)); f.write(f.file(0), journal.pending.changes[0].content); f.states.set(f.key, journal);
    f.restore(); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.get(f.key)).toBeNull();
  });
  it('rechecks the PID before commit and never overwrites a newly running IDE', () => {
    const f = fixture(); f.seed(); let running = false;
    expect(() => f.apply({ processProbe: () => running ? 'running' : 'stopped', beforeCommit: () => { running = true; } })).toThrow('仍在运行');
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.size).toBe(0);
  });
  it('rejects missing secure state storage and corrupt ownership records', () => {
    const f = fixture(); f.seed(); expect(() => applyJetBrainsConfig({ ...f.store, createManagedBackup: undefined }, f.tool, f.backups, f.root, f.options)).toThrow('加密');
    f.apply(); const saved = f.states.get(f.key) as any; saved.files[0].fields['unknown-field'] = { before: { present: false }, applied: { present: true, value: 'unsafe' } }; f.states.set(f.key, saved);
    const raw = fileNames.map((_, index) => f.read(index)); expect(() => f.restore()).toThrow('恢复记录'); raw.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it('restores legacy version 1 three-file ownership without claiming or modifying completion settings', () => {
    const f = fixture('rider'); f.seed(); f.apply();
    const legacy = structuredClone(f.states.get(f.key)) as any;
    legacy.version = 1; legacy.files = legacy.files.slice(0, 3); delete legacy.completionKeyIdentity;
    f.states.set(f.key, legacy);
    const completion = join(f.target, 'options', 'llm.next.edit.providers.xml');
    const manual = '<application><component name="ManualCompletionConfiguration"><option name="preserved" value="current"/></component></application>';
    f.write(completion, manual); f.restore();
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
    expect(readFileSync(completion, 'utf8')).toBe(manual); expect(f.states.get(f.key)).toBeNull();
  });
  it('recovers an interrupted legacy version 1 journal and leaves unrecorded completion bytes untouched', () => {
    const f = fixture('pycharm'); f.seed(); f.apply();
    const journal = structuredClone(f.journals[0]) as any;
    journal.version = 1; journal.pending.next.version = 1; delete journal.pending.next.completionKeyIdentity;
    journal.pending.next.files = journal.pending.next.files.slice(0, 3);
    journal.pending.changes = journal.pending.changes.filter((change: any) => fileNames.includes(change.file));
    f.originals.forEach((text, index) => f.write(f.file(index), text));
    f.write(f.file(0), journal.pending.changes[0].content); f.states.set(f.key, journal);
    const completion = join(f.target, 'options', 'llm.next.edit.providers.xml');
    const manual = '<application><component name="ManualCompletionConfiguration"/></application>';
    f.write(completion, manual); f.restore();
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
    expect(readFileSync(completion, 'utf8')).toBe(manual); expect(f.states.get(f.key)).toBeNull();
  });
  it('restores version 2 ownership by file identity independently of record ordering', () => {
    const f = fixture(); f.seed(); f.apply();
    const saved = structuredClone(f.states.get(f.key)) as any; saved.files.reverse(); f.states.set(f.key, saved);
    f.restore(); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(f.states.get(f.key)).toBeNull();
  });

  it.each(Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[])('synchronizes %s aggregate chat and independent AI completion while preserving completion budgets and other providers', tool => {
    const f = fixture(tool); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    const value = JSON.parse(buildJetBrainsConfig(f.store, tool, 19876, false, f.root, f.options).content);
    expect(value.completion).toMatchObject({ supported: true, baseUrl: `http://127.0.0.1:19876/tool/${tool}/v1`, model: 'local-core', schemaId: 'fim.generic' });
    f.apply(); const state = readCompletion(f);
    expect(state.selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' });
    expect(state.openAiCompatible).toEqual({ ...c.state.openAiCompatible, baseUrl: value.completion.baseUrl, model: value.completion.model, providerId: '', modelId: '', schemaId: 'fim.generic' });
    for (const key of ['inception', 'mistral', 'deepSeek', 'migration', 'unknownFutureSetting']) expect(state[key]).toEqual((c.state as any)[key]);
    expect(readFileSync(completionFile(f), 'utf8')).toContain('<!-- keep completion comment -->');
    expect(readFileSync(completionFile(f), 'utf8')).toContain('<component name="UnrelatedCompletion"><option name="keep" value="same"/></component>');
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.store.gatewayKey).not.toHaveBeenCalled();
    const history = f.states.get(f.key) as any; expect(history.version).toBe(2); expect(history.files).toHaveLength(4);
    expect(history.files[3].fields).not.toHaveProperty('openAiCompatible.apiKeyConfigured');
    expect(history.files[3].fields).not.toHaveProperty('openAiCompatible.maxTokens'); expect(history.files[3].fields).not.toHaveProperty('openAiCompatible.maxOutputTokens');
    f.models[0].alias = 'updated-completion'; f.apply(); expect(readCompletion(f).openAiCompatible.model).toBe('updated-completion');
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original)); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it('rolls back all four settings files when the completion file commit fails', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    expect(() => f.apply({ afterFileCommit: index => { if (index === 3) throw new Error('SYNTHETIC_COMPLETION_WRITE_FAILURE'); } })).toThrow('SYNTHETIC_COMPLETION_WRITE_FAILURE');
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(c.original); expect(f.states.get(f.key)).toBeNull();
  });
  it('removes the newly created completion settings file when restoring a new aggregate connection', () => {
    const f = fixture(); enableNativeCompletion(f); f.apply(); expect(existsSync(completionFile(f))).toBe(true); f.restore(); expect(existsSync(completionFile(f))).toBe(false);
  });
  it('preserves a later manual completion model, credential marker and budgets while restoring untouched owned fields', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); f.apply();
    const state = readCompletion(f); state.openAiCompatible.model = 'manually-selected'; state.openAiCompatible.apiKeyConfigured = true;
    state.openAiCompatible.maxTokens = '16384'; state.newUserProperty = { keep: true };
    f.write(completionFile(f), `<application><!-- added outside completion --><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(state)}]]></component></application>`);
    f.restore(); const restored = readCompletion(f);
    expect(restored.openAiCompatible).toEqual({ ...c.state.openAiCompatible, model: 'manually-selected', apiKeyConfigured: true, maxTokens: '16384' });
    expect(restored.selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' }); expect(restored.newUserProperty).toEqual({ keep: true });
    expect(readFileSync(completionFile(f), 'utf8')).toContain('<!-- added outside completion -->');
  });
  it('upgrades legacy ownership using the current unrecorded completion baseline instead of the older chat backup', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); f.apply();
    const legacy = structuredClone(f.states.get(f.key)) as any; legacy.version = 1; legacy.files = legacy.files.slice(0, 3); delete legacy.completionKeyIdentity; f.states.set(f.key, legacy);
    const current = completionFixture(f); f.models[0].alias = 'upgrade-model'; f.apply();
    const next = f.states.get(f.key) as any; expect(next.version).toBe(2); expect(next.files[3].before).toBe(current.original);
    expect(next.files[3].fields['openAiCompatible.model'].before).toEqual({ present: true, value: JSON.stringify('old-completion') });
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(current.original)); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it.each([
    '<application><component name="NextEditProviderSettings"><state><![CDATA[{}]]></state></component></application>',
    '<application><component name="NextEditProviderSettings"><![CDATA[{not-json}]]></component></application>',
    '<application><component name="NextEditProviderSettings"><![CDATA[{"openAiCompatible":[]}]]></component></application>',
    '<application><component name="NextEditProviderSettings"><![CDATA[{"selectedProvider":{"kind":{"unsafe":true}}}]]></component></application>',
  ])('rejects incompatible completion persistence before writing the chat settings: %s', xml => {
    const f = fixture(); f.seed(); f.write(completionFile(f), xml);
    expect(jetBrainsStatus(f.tool, f.root, f.options).canApply).toBe(false); expect(() => f.apply()).toThrow();
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(xml);
    expect(f.states.size).toBe(0); expect(existsSync(f.backups)).toBe(false);
  });
  it('uses safe split CDATA for an aggregate model alias containing the CDATA terminator', () => {
    const f = fixture(); enableNativeCompletion(f); f.models[0].alias = 'model]]>tail'; f.apply();
    expect(readCompletion(f).openAiCompatible.model).toBe('model]]>tail');
    expect(readFileSync(completionFile(f), 'utf8')).toContain(']]]]><![CDATA[>'); f.restore(); expect(existsSync(completionFile(f))).toBe(false);
  });

  it.each(Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[])('writes %s native completion endpoint and upstream model while requiring separate key confirmation on source change', tool => {
    const f = fixture(tool); enableNativeCompletion(f); f.binding.mode = 'direct'; f.seed(); const c = completionFixture(f);
    const preview = JSON.parse(buildJetBrainsConfig(f.store, tool, 19876, false, f.root, f.options).content);
    expect(preview.baseUrl).toBe('https://api.deepseek.com');
    expect(preview.completion).toMatchObject({ supported: true, baseUrl: 'https://api.deepseek.com/beta', model: 'deepseek-flash', schemaId: 'fim.generic' });
    expect(preview.completion.apiKey).toBe('__PROVIDER_API_KEY__');
    f.apply(); const state = readCompletion(f);
    expect(state.openAiCompatible.baseUrl).toBe('https://api.deepseek.com/beta'); expect(state.openAiCompatible.model).toBe('deepseek-flash');
    expect(state.openAiCompatible.providerId).toBe(''); expect(state.openAiCompatible.modelId).toBe(''); expect(state.openAiCompatible.schemaId).toBe('fim.generic');
    expect(state.selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' }); expect(state.openAiCompatible.apiKeyConfigured).toBe(false);
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.store.gatewayKey).not.toHaveBeenCalled();
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original));
  });
  it('keeps a separately authorized completion active for model changes at the same endpoint and identity, then closes it when switching endpoint', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); completionFixture(f); f.apply();
    const confirmed = readCompletion(f); confirmed.selectedProvider = { id: 'openai-compatible', kind: 'OPENAI_COMPATIBLE', name: 'OpenAI Compatible' };
    confirmed.openAiCompatible.apiKeyConfigured = true;
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(confirmed)}]]></component></application>`);
    f.models[0].alias = 'after-key-confirmation'; f.apply();
    expect(readCompletion(f).selectedProvider).toEqual(confirmed.selectedProvider); expect(readCompletion(f).openAiCompatible.apiKeyConfigured).toBe(true);
    f.binding.mode = 'direct'; f.apply();
    expect(readCompletion(f).selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' }); expect(readCompletion(f).openAiCompatible.baseUrl).toBe('https://api.deepseek.com/beta');
    expect(readCompletion(f).openAiCompatible.apiKeyConfigured).toBe(true); expect(f.store.getSecret).not.toHaveBeenCalled();
  });
  it('clamps only a confirmed excessive FIM output budget and restores its exact original value after resync', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    c.state.openAiCompatible.maxOutputTokens = '8192';
    c.original = `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`; f.write(completionFile(f), c.original);
    f.apply(); expect(readCompletion(f).openAiCompatible.maxOutputTokens).toBe('4096'); expect(readCompletion(f).openAiCompatible.maxTokens).toBe('24576');
    const record = (f.states.get(f.key) as any).files[3].fields['openAiCompatible.maxOutputTokens'];
    expect(record).toEqual({ before: { present: true, value: JSON.stringify('8192') }, applied: { present: true, value: JSON.stringify('4096') } });
    f.apply(); expect((f.states.get(f.key) as any).files[3].fields['openAiCompatible.maxOutputTokens']).toEqual(record);
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original));
  });
  it('leaves a later smaller manual completion budget untouched during resync and restore', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    c.state.openAiCompatible.maxOutputTokens = '8192';
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`); f.apply();
    const manual = readCompletion(f); manual.openAiCompatible.maxOutputTokens = '2048';
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(manual)}]]></component></application>`); f.apply();
    expect((f.states.get(f.key) as any).files[3].fields).not.toHaveProperty('openAiCompatible.maxOutputTokens');
    f.restore(); expect(readCompletion(f).openAiCompatible.maxOutputTokens).toBe('2048');
  });
  it.each(['unknown', '0', '-1', '1.5', 512, null])('refuses to guess an invalid confirmed completion output budget: %s', output => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); (c.state.openAiCompatible as any).maxOutputTokens = output;
    const raw = `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`; f.write(completionFile(f), raw);
    expect(() => f.apply()).toThrow();
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(raw); expect(f.states.size).toBe(0);
  });

  it.each(Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[])('updates %s completion URL and model for a different native supplier even when its completion protocol is unverified', tool => {
    const f = fixture(tool); f.binding.mode = 'direct'; f.binding.defaultModelId = 'chat'; f.binding.modelSelection = 'selected'; f.binding.modelIds = ['chat'];
    f.seed(); const c = completionFixture(f);
    const preview = JSON.parse(buildJetBrainsConfig(f.store, tool, 19876, false, f.root, f.options).content);
    expect(preview.completion).toMatchObject({ configured: true, supported: false, baseUrl: f.provider.baseUrl, model: 'upstream-chat', schemaId: 'fim.generic', apiKey: '__PROVIDER_API_KEY__' });
    expect(preview.completion.reason).toBeTruthy(); f.apply();
    const current = readCompletion(f);
    expect(current.openAiCompatible.baseUrl).toBe(f.provider.baseUrl); expect(current.openAiCompatible.model).toBe('upstream-chat');
    expect(current.openAiCompatible.providerId).toBe(''); expect(current.openAiCompatible.modelId).toBe(''); expect(current.selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' });
    expect(current.openAiCompatible.maxTokens).toBe(c.state.openAiCompatible.maxTokens); expect(current.openAiCompatible.maxOutputTokens).toBe(c.state.openAiCompatible.maxOutputTokens);
    expect(current.openAiCompatible.apiKeyConfigured).toBe(false); expect(f.store.getSecret).not.toHaveBeenCalled();
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original));
  });
  it('deactivates a completion for the same native URL when switching to another supplier account identity', () => {
    const f = fixture(); enableNativeCompletion(f); f.binding.mode = 'direct'; f.seed(); completionFixture(f); f.apply();
    const confirmed = readCompletion(f); confirmed.selectedProvider = { id: 'openai-compatible', kind: 'OPENAI_COMPATIBLE', name: 'OpenAI Compatible' }; confirmed.openAiCompatible.apiKeyConfigured = true;
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(confirmed)}]]></component></application>`); f.apply();
    expect(readCompletion(f).selectedProvider.kind).toBe('OPENAI_COMPATIBLE');
    f.provider.id = 'another-deepseek-account'; f.models.forEach(model => { model.providerId = f.provider.id; }); f.binding.providerIds = [f.provider.id]; f.apply();
    expect(readCompletion(f).openAiCompatible.baseUrl).toBe(confirmed.openAiCompatible.baseUrl); expect(readCompletion(f).selectedProvider.kind).toBe('NONE');
    expect(readCompletion(f).openAiCompatible.apiKeyConfigured).toBe(true); expect((f.states.get(f.key) as any).completionKeyIdentity).toBe('supplier:another-deepseek-account');
    expect(f.store.getSecret).not.toHaveBeenCalled();
  });
  it('keeps a first sync inactive when the current XML appears connected but its credential identity has never been recorded', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    c.state.selectedProvider = { id: 'openai-compatible', kind: 'OPENAI_COMPATIBLE', name: 'OpenAI Compatible' };
    c.state.openAiCompatible.baseUrl = 'http://127.0.0.1:19876/tool/webstorm/v1'; c.state.openAiCompatible.apiKeyConfigured = true;
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`); f.apply();
    expect(readCompletion(f).selectedProvider.kind).toBe('NONE'); expect(readCompletion(f).openAiCompatible.apiKeyConfigured).toBe(true);
    expect((f.states.get(f.key) as any).completionKeyIdentity).toBe('modeldock-local');
  });
  it('switches known completion parameters to another supplier without losing the original restoration baseline', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); f.apply();
    f.provider.presetId = undefined; f.provider.baseUrl = 'https://another-supplier.fixture/v1'; f.models[0].wireApi = 'chat-completions'; f.binding.mode = 'direct'; f.apply();
    expect(readCompletion(f).openAiCompatible.baseUrl).toBe(f.provider.baseUrl); expect(readCompletion(f).openAiCompatible.model).toBe('deepseek-flash');
    expect(readCompletion(f).selectedProvider.kind).toBe('NONE'); f.restore();
    expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original)); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
  });
  it('synchronizes an independent completion model in the selected scope while keeping the chat assignment unchanged', () => {
    const f = fixture(); enableNativeCompletion(f); f.binding.mode = 'direct';
    f.models.push({ ...f.models[0], id: 'completion-pro', upstreamId: 'deepseek-v4-pro', alias: 'completion-pro-alias' });
    f.binding.connectionChoices = { direct: { providerId: f.provider.id, defaultModelId: 'core', completionModelId: 'completion-pro' } };
    f.apply(); expect(readCompletion(f).openAiCompatible.model).toBe('deepseek-v4-pro'); expect(f.read(1)).toContain('OpenAIAPI/deepseek-flash');
    const guide = JSON.parse(buildJetBrainsConfig(f.store, f.tool, 19876, false, f.root, f.options).content).completion;
    expect(guide.model).toBe('deepseek-v4-pro');
    expect(guide).not.toHaveProperty('requestedModelId'); expect(guide).not.toHaveProperty('keyIdentity');
  });

  it.each(['absent', 'empty'] as const)('preserves the native default completion output budget when it is %s', kind => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    if (kind === 'absent') delete (c.state.openAiCompatible as any).maxOutputTokens; else c.state.openAiCompatible.maxOutputTokens = '';
    const raw = `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`; f.write(completionFile(f), raw); f.apply();
    const output = readCompletion(f).openAiCompatible;
    if (kind === 'absent') expect(output).not.toHaveProperty('maxOutputTokens'); else expect(output.maxOutputTokens).toBe('');
    expect((f.states.get(f.key) as any).files[3].fields).not.toHaveProperty('openAiCompatible.maxOutputTokens');
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(raw));
  });
  it('rolls back completion parameters, chat settings and previous ownership when encrypted final state persistence fails', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    f.store.setManagedState.mockImplementationOnce((key, value) => { f.states.set(key, structuredClone(value)); }).mockImplementationOnce((key, value) => { f.states.set(key, structuredClone(value)); throw new Error('SYNTHETIC_COMPLETION_STATE_FAILURE'); });
    expect(() => f.apply()).toThrow('SYNTHETIC_COMPLETION_STATE_FAILURE');
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(c.original); expect(f.states.get(f.key)).toBeNull();
  });
  it('does not overwrite a completion file changed concurrently between preview and the atomic transaction', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    const external = c.original.replace('old-completion', 'concurrent-completion');
    expect(() => f.apply({ beforeCommit: () => f.write(completionFile(f), external) })).toThrow('其他程序');
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(external); expect(f.states.size).toBe(0);
  });
  it('recovers an interrupted version 2 four-file transaction without leaving partially updated completion settings', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); f.apply();
    const journal = structuredClone(f.journals[0]);
    f.originals.forEach((text, index) => f.write(f.file(index), text)); f.write(completionFile(f), journal.pending.changes.find((change: any) => change.file === 'llm.next.edit.providers.xml').content); f.states.set(f.key, journal);
    f.restore(); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original)); expect(f.states.get(f.key)).toBeNull();
  });
  it('rejects a corrupt completion credential identity before attempting any restoration', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); completionFixture(f); f.apply();
    const state = structuredClone(f.states.get(f.key)) as any; state.completionKeyIdentity = { fake: 'identity' }; f.states.set(f.key, state);
    const current = readFileSync(completionFile(f), 'utf8'); expect(() => f.restore()).toThrow('密钥身份恢复记录'); expect(readFileSync(completionFile(f), 'utf8')).toBe(current);
  });

  it('validates the new completion credential identity before writing any config or history', () => {
    const f = fixture(); enableNativeCompletion(f); f.binding.mode = 'direct'; f.provider.id = 'invalid\nidentity';
    f.models.forEach(model => { model.providerId = f.provider.id; }); f.binding.providerIds = [f.provider.id]; f.seed(); const c = completionFixture(f);
    expect(() => f.apply()).toThrow('密钥身份恢复记录');
    f.originals.forEach((text, index) => expect(f.read(index)).toBe(text)); expect(readFileSync(completionFile(f), 'utf8')).toBe(c.original); expect(f.states.size).toBe(0); expect(existsSync(f.backups)).toBe(false);
  });

  it('restores the old completion parameters while deactivating a later manual OpenAI activation and preserving its new credential marker', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); f.apply();
    const manual = readCompletion(f); manual.selectedProvider = { id: 'openai-compatible', kind: 'OPENAI_COMPATIBLE', name: 'OpenAI Compatible' };
    manual.openAiCompatible.apiKeyConfigured = true; manual.unrelatedManualFlag = 'keep';
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(manual)}]]></component></application>`);
    const credential = join(f.target, 'c.kdbx'); f.write(credential, 'SYNTHETIC_NEW_COMPLETION_CREDENTIAL');
    f.restore(); const restored = readCompletion(f);
    expect(restored.selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' });
    expect(restored.openAiCompatible).toEqual({ ...c.state.openAiCompatible, apiKeyConfigured: true });
    expect(restored.unrelatedManualFlag).toBe('keep'); expect(readFileSync(credential, 'utf8')).toBe('SYNTHETIC_NEW_COMPLETION_CREDENTIAL');
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.store.gatewayKey).not.toHaveBeenCalled();
  });
  it('retains OpenAI activation when restoration changes only the model and schema at the same recorded endpoint and credential identity', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    c.state.selectedProvider = { id: 'openai-compatible', kind: 'OPENAI_COMPATIBLE', name: 'OpenAI Compatible' };
    c.state.openAiCompatible.baseUrl = 'http://127.0.0.1:19876/tool/webstorm/v1'; c.state.openAiCompatible.providerId = ''; c.state.openAiCompatible.modelId = ''; c.state.openAiCompatible.apiKeyConfigured = true;
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`); f.apply();
    const confirmed = readCompletion(f); confirmed.selectedProvider = c.state.selectedProvider;
    f.write(completionFile(f), `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(confirmed)}]]></component></application>`);
    f.models[0].alias = 'updated-same-endpoint'; f.apply(); expect(readCompletion(f).selectedProvider.kind).toBe('OPENAI_COMPATIBLE');
    f.restore(); const restored = readCompletion(f);
    expect(restored.selectedProvider).toEqual(c.state.selectedProvider); expect(restored.openAiCompatible).toEqual(c.state.openAiCompatible);
    expect(f.store.getSecret).not.toHaveBeenCalled();
  });
  it.each(['JETBRAINS', 'INCEPTION', 'MISTRAL', 'DEEPSEEK', 'ACP', 'NONE'])('does not rewrite the independently restored %s completion provider activation', kind => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f);
    c.state.selectedProvider = { id: kind === 'NONE' ? '' : `independent-${kind.toLowerCase()}`, kind, name: kind };
    c.original = `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`; f.write(completionFile(f), c.original);
    f.apply(); f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(c.original); expect(readCompletion(f).selectedProvider.kind).toBe(kind);
  });
  it.each(['restore', 'disable'] as const)('safely deactivates a completion after %s recovers an interrupted first version 2 transaction with no previous ownership', action => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); c.state.openAiCompatible.apiKeyConfigured = true;
    c.original = `<application><component name="NextEditProviderSettings"><![CDATA[${JSON.stringify(c.state)}]]></component></application>`; f.write(completionFile(f), c.original); f.apply();
    const journal = structuredClone(f.journals[0]); expect(journal.pending.previous).toBeNull(); f.states.set(f.key, journal);
    const credential = join(f.target, 'c.kdbx'); f.write(credential, 'SYNTHETIC_LATER_NEW_CREDENTIAL');
    if (action === 'restore') f.restore(); else { f.binding.enabled = false; f.apply(); }
    const restored = readCompletion(f); expect(restored.selectedProvider).toEqual({ id: '', kind: 'NONE', name: '' });
    expect(restored.openAiCompatible).toEqual(c.state.openAiCompatible); expect(restored.openAiCompatible.apiKeyConfigured).toBe(true);
    expect(readFileSync(credential, 'utf8')).toBe('SYNTHETIC_LATER_NEW_CREDENTIAL'); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
    expect(f.states.get(f.key)).toBeNull(); expect(f.store.getSecret).not.toHaveBeenCalled();
  });
  it('guards newly owned completion parameters when an interrupted version 2 update recovers to an older three-file history', () => {
    const f = fixture(); enableNativeCompletion(f); f.seed(); const c = completionFixture(f); f.apply();
    const legacy = structuredClone(f.states.get(f.key)) as any; legacy.version = 1; legacy.files = legacy.files.slice(0, 3); delete legacy.completionKeyIdentity;
    f.states.set(f.key, legacy); f.write(completionFile(f), c.original); f.models[0].alias = 'new-journal-model'; f.apply();
    const pending = structuredClone(f.journals.at(-1)); expect(pending.pending.previous.version).toBe(1); expect(pending.pending.next.version).toBe(2); f.states.set(f.key, pending);
    f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(safeRestoredOriginal(c.original)); f.originals.forEach((text, index) => expect(f.read(index)).toBe(text));
    expect(f.states.get(f.key)).toBeNull();
  });
  it('does not touch a real OpenAI completion component that is outside legacy version 1 restoration ownership', () => {
    const f = fixture(); f.seed(); f.apply();
    const legacy = structuredClone(f.states.get(f.key)) as any; legacy.version = 1; legacy.files = legacy.files.slice(0, 3); delete legacy.completionKeyIdentity; f.states.set(f.key, legacy);
    const c = completionFixture(f); f.restore(); expect(readFileSync(completionFile(f), 'utf8')).toBe(c.original);
  });

});
