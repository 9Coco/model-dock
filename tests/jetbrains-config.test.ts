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
});
