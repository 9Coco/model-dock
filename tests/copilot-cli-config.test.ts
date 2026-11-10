import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { applyCopilotCliConfig, buildCopilotCliConfig, copilotCliConfigDirectory, copilotCliConfigTargets, copilotCliHistoryKey, restoreCopilotCliOfficialConfig, type CopilotCliConfigOptions } from '../src/main/copilot-cli-config';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-copilot-cli-config-')); roots.push(root);
  const targets = copilotCliConfigTargets(root), states = new Map<string, unknown>(), journals: unknown[] = [];
  const provider: Provider = { id: 'api', name: 'Fixture API', kind: 'openai-compatible', enabled: true, hasSecret: true, authStatus: 'ready', baseUrl: 'https://api.fixture.invalid/v1/', note: '' };
  const model: Model = { id: 'responses', providerId: provider.id, upstreamId: 'native-responses-id', alias: 'aggregate-responses-alias', displayName: 'Selected fixture model', wireApi: 'responses', enabled: true, contextWindow: 64000, maxInputTokens: 50000, maxOutputTokens: 10000, tools: true, vision: true, reasoningEfforts: ['low', 'high'] };
  const chat: Model = { ...model, id: 'chat', upstreamId: 'native-chat-id', alias: 'aggregate-chat-alias', wireApi: 'chat-completions', vision: false, tools: false, contextWindow: 0, maxInputTokens: undefined, maxOutputTokens: undefined, reasoningEfforts: [] };
  const binding: ToolBinding = { id: 'copilot-cli', name: 'Copilot CLI', enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: [], modelSelection: 'all', defaultModelId: model.id, note: '' };
  const providers = [provider], models = [model, chat];
  const store = {
    listModels: () => models, listProviders: () => providers, listBindings: () => [binding],
    getSecret: vi.fn(() => ({ apiKey: 'SYNTHETIC_UPSTREAM_KEY', accessToken: 'SYNTHETIC_OAUTH_NEVER_EXPORT' })),
    gatewayKey: () => 'SYNTHETIC_LOCAL_KEY',
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn((kind: string, value: unknown) => { expect(kind).toBe('copilot-cli-config'); journals.push(structuredClone(value)); return 'synthetic-encrypted-backup.enc'; }),
  };
  const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const read = (path: string) => parseJsonc(readFileSync(path, 'utf8'));
  const apply = (options: CopilotCliConfigOptions = {}) => applyCopilotCliConfig(store, join(root, 'backups'), root, options);
  const restore = (options: CopilotCliConfigOptions = {}) => restoreCopilotCliOfficialConfig(store, join(root, 'backups'), root, options);
  const preview = (reveal = false) => buildCopilotCliConfig(store, reveal, 19191, root);
  const files = () => Object.values(targets).map(path => existsSync(path) ? readFileSync(path, 'utf8') : null);
  return { root, targets, states, journals, store, provider, providers, model, chat, models, binding, write, read, apply, restore, preview, files };
}

describe('independent Copilot CLI model registry configuration', () => {
  it('previews both native protocols and a qualified default without reading credentials or writing files', () => {
    const f = fixture(), value = JSON.parse(f.preview().content);
    expect(value.providers).toEqual([
      { name: 'modeldock-responses', type: 'openai', baseUrl: 'https://api.fixture.invalid/v1', wireApi: 'responses', apiKey: '__PROVIDER_API_KEY__' },
      { name: 'modeldock-chat', type: 'openai', baseUrl: 'https://api.fixture.invalid/v1', wireApi: 'completions', apiKey: '__PROVIDER_API_KEY__' },
    ]);
    expect(value.models[0]).toMatchObject({ id: f.model.upstreamId, provider: 'modeldock-responses', wireModel: f.model.upstreamId, modelId: f.model.upstreamId, maxPromptTokens: 50000, maxContextWindowTokens: 64000, maxOutputTokens: 10000, capabilities: { supports: { vision: true, toolCalls: true, streaming: true, reasoning_effort: ['low', 'high'] } } });
    expect(value.models[1]).toMatchObject({ id: f.chat.upstreamId, provider: 'modeldock-chat', maxPromptTokens: 28672, maxContextWindowTokens: 32768, maxOutputTokens: 4096, capabilities: { supports: { vision: false, toolCalls: false } } });
    expect(value.models[1].capabilities.supports).not.toHaveProperty('reasoning_effort');
    expect(value.settings).toEqual({ model: 'modeldock-responses/native-responses-id' });
    expect(f.preview().instructions).toContain('客户端预算');
    expect(f.preview().filename).toBe('modeldock-copilot-cli.json');
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.files()).toEqual([null, null]); expect(f.states.size).toBe(0);
    expect(f.preview().content).not.toMatch(/SYNTHETIC_/);
  });

  it('uses selected aggregate aliases, tool-scoped URL and local key without reading subscription tokens', () => {
    const f = fixture(); f.binding.mode = 'aggregate'; f.provider.kind = 'codex';
    f.store.getSecret.mockImplementation(() => { throw new Error('Must not read subscription secrets'); });
    const value = JSON.parse(f.preview(true).content);
    expect(value.providers.every((provider: any) => provider.baseUrl === 'http://127.0.0.1:19191/tool/copilot-cli/v1' && provider.apiKey === 'SYNTHETIC_LOCAL_KEY')).toBe(true);
    expect(value.models[0]).toMatchObject({ id: f.model.alias, wireModel: f.model.alias, modelId: f.model.upstreamId });
    expect(value.settings.model).toBe(`modeldock-responses/${f.model.alias}`);
    f.binding.modelSelection = 'selected'; f.binding.modelIds = [f.chat.id]; f.binding.defaultModelId = f.chat.id;
    expect(JSON.parse(f.preview().content).models).toHaveLength(1);
    f.binding.modelIds = []; expect(f.preview().content).toBe(''); expect(f.store.getSecret).not.toHaveBeenCalled();
  });

  it('does not silently use local bridges for direct subscriptions, multiple sources or unsupported protocols', () => {
    const f = fixture(); f.binding.providerIds!.push('other');
    expect(() => f.preview()).toThrow(/恰好一个/);
    f.binding.providerIds = [f.provider.id]; f.provider.kind = 'codex';
    expect(f.preview().content).toBe('');
    f.provider.kind = 'openai-compatible'; f.provider.authStatus = 'missing';
    expect(() => f.preview()).toThrow(/凭据/);
    f.provider.authStatus = 'ready'; f.models.splice(1); f.model.wireApi = 'messages';
    expect(f.preview().content).toBe('');
  });

  it('keeps request budgets positive and within CLI uint32 limits without changing stored model metadata', () => {
    const f = fixture(); f.model.contextWindow = 1;
    expect(() => f.preview()).toThrow(/至少需要 2/);
    f.model.contextWindow = Number.MAX_SAFE_INTEGER; f.model.maxInputTokens = Number.MAX_SAFE_INTEGER; f.model.maxOutputTokens = Number.MAX_SAFE_INTEGER;
    const model = JSON.parse(f.preview().content).models[0];
    expect(model.maxContextWindowTokens).toBe(0xffffffff); expect(model.maxOutputTokens).toBe(0xfffffffe); expect(model.maxPromptTokens).toBe(1);
    expect(f.model.contextWindow).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('merges both files without touching foreign providers, models, state, permissions, MCP, or JSONC comments', () => {
    const f = fixture();
    const registry = { providers: [{ name: 'user', baseUrl: 'https://user.invalid/v1', apiKey: 'SYNTHETIC_EXISTING_KEY' }], models: [{ id: 'other', provider: 'user', metadata: { keep: true } }], future: true };
    const settings = '// keep opening comment\n{\n  // keep model comment\n  "model": "old-provider/old-model",\n  "theme": "dark", // keep inline\n}\n';
    f.write(f.targets.providersPath, registry); f.write(f.targets.settingsPath, settings);
    const untouched = join(f.root, '.copilot', 'config.json'); f.write(untouched, { trusted_folders: ['keep'], user: 'keep' });
    const mcp = join(f.root, '.copilot', 'mcp-config.json'); f.write(mcp, { mcpServers: { keep: {} } });
    expect(f.apply()).toBe(f.targets.providersPath);
    expect(f.read(f.targets.providersPath).providers[0]).toEqual(registry.providers[0]); expect(f.read(f.targets.providersPath).models[0]).toEqual(registry.models[0]);
    expect(f.read(f.targets.providersPath).future).toBe(true);
    expect(f.read(f.targets.settingsPath)).toEqual({ model: 'modeldock-responses/native-responses-id', theme: 'dark' });
    for (const comment of ['// keep opening comment', '// keep model comment', '// keep inline']) expect(readFileSync(f.targets.settingsPath, 'utf8')).toContain(comment);
    expect(f.read(untouched)).toEqual({ trusted_folders: ['keep'], user: 'keep' }); expect(f.read(mcp)).toEqual({ mcpServers: { keep: {} } });
    expect(f.journals).toHaveLength(1); f.apply(); expect(f.journals).toHaveLength(1);
    f.binding.mode = 'aggregate'; f.apply(); f.restore();
    expect(f.read(f.targets.providersPath)).toEqual(registry); expect(f.read(f.targets.settingsPath)).toEqual({ model: 'old-provider/old-model', theme: 'dark' });
    expect(f.store.getManagedState(copilotCliHistoryKey(f.targets.providersPath), null)).toBeNull();
  });

  it('restores absent model fields without discarding comments attached to the new model', () => {
    const f = fixture(); f.write(f.targets.settingsPath, '{\n // original settings comment\n "theme":"dark"\n}\n'); f.apply();
    const content = readFileSync(f.targets.settingsPath, 'utf8').replace('"model"', '// keep this model comment\n "model"'); f.write(f.targets.settingsPath, content);
    f.restore(); expect(f.read(f.targets.settingsPath)).toEqual({ theme: 'dark' });
    expect(readFileSync(f.targets.settingsPath, 'utf8')).toContain('// keep this model comment'); expect(readFileSync(f.targets.settingsPath, 'utf8')).toContain('// original settings comment');
  });

  it('removes only files created by ModelDock and preserves originally absent, empty and null registry fields', () => {
    const fresh = fixture(); fresh.apply(); fresh.restore(); expect(fresh.files()).toEqual([null, null]);
    for (const registry of [{ future: true }, { providers: null, models: null }, { providers: [], models: [] }]) {
      const f = fixture(); f.write(f.targets.providersPath, registry); f.write(f.targets.settingsPath, '\uFEFF{"theme":"dark"}'); f.apply(); f.restore();
      expect(f.read(f.targets.providersPath)).toEqual(registry); expect(f.read(f.targets.settingsPath)).toEqual({ theme: 'dark' });
    }
  });

  it('preserves externally changed defaults and foreign registry additions when clearing managed models', () => {
    const f = fixture(); f.apply();
    const registry = f.read(f.targets.providersPath); registry.providers.push({ name: 'new-user', baseUrl: 'https://new-user.invalid' }); registry.models.push({ id: 'new', provider: 'new-user' }); f.write(f.targets.providersPath, registry);
    f.write(f.targets.settingsPath, { model: 'new-user/new', theme: 'system' }); f.binding.enabled = false; f.apply();
    expect(f.read(f.targets.providersPath)).toEqual({ providers: [{ name: 'new-user', baseUrl: 'https://new-user.invalid' }], models: [{ id: 'new', provider: 'new-user' }] });
    expect(f.read(f.targets.settingsPath)).toEqual({ model: 'new-user/new', theme: 'system' });
  });

  it.each(['providers', 'models'] as const)('refuses a pre-existing foreign managed %s entry', kind => {
    const f = fixture(); f.write(f.targets.providersPath, { [kind]: [kind === 'providers' ? { name: 'modeldock-responses', baseUrl: 'https://foreign.invalid' } : { id: 'foreign', provider: 'modeldock-chat' }] });
    const before = f.files(); expect(() => f.apply()).toThrow(/不属于 ModelDock/); expect(f.files()).toEqual(before); expect(f.states.size).toBe(0);
  });

  it.each(['providers', 'models'] as const)('refuses externally changed owned %s on apply and restore', kind => {
    const f = fixture(); f.apply(); const registry = f.read(f.targets.providersPath); registry[kind][0].future = 'external change'; f.write(f.targets.providersPath, registry);
    const before = f.files(); expect(() => f.apply()).toThrow(/外部修改/); expect(() => f.restore()).toThrow(/外部修改/); expect(f.files()).toEqual(before);
  });

  it.each([0, 1])('rolls back files and ownership when committing file %s fails', index => {
    const f = fixture(); f.write(f.targets.providersPath, { future: true }); f.write(f.targets.settingsPath, '// keep\n{"model":"previous"}'); const before = f.files();
    expect(() => f.apply({ afterFileCommit: committed => { if (committed === index) throw new Error('synthetic commit failure'); } })).toThrow('synthetic commit failure');
    expect(f.files()).toEqual(before); expect(f.store.getManagedState(copilotCliHistoryKey(f.targets.providersPath), null)).toBeNull();
  });

  it('checks files immediately before commit and preserves external races', () => {
    const f = fixture(); f.write(f.targets.settingsPath, { model: 'previous' });
    expect(() => f.apply({ beforeCommit: () => f.write(f.targets.settingsPath, { model: 'external-new' }) })).toThrow(/刚被其他程序修改/);
    expect(f.read(f.targets.settingsPath)).toEqual({ model: 'external-new' }); expect(existsSync(f.targets.providersPath)).toBe(false); expect(f.states.size).toBe(0);
    expect(() => f.apply({ afterFileCommit: index => { if (index === 0) f.write(f.targets.settingsPath, { model: 'external-next' }); } })).toThrow(/刚被其他程序修改/);
    expect(f.read(f.targets.settingsPath)).toEqual({ model: 'external-next' }); expect(existsSync(f.targets.providersPath)).toBe(false); expect(f.store.getManagedState(copilotCliHistoryKey(f.targets.providersPath), null)).toBeNull();
  });

  it('fails before writing when encrypted backup or state persistence fails', () => {
    const f = fixture(); f.store.createManagedBackup.mockImplementationOnce(() => { throw new Error('synthetic backup failure'); });
    expect(() => f.apply()).toThrow('synthetic backup failure'); expect(f.files()).toEqual([null, null]);
    f.store.setManagedState.mockImplementationOnce(() => { throw new Error('synthetic state failure'); });
    expect(() => f.apply()).toThrow('synthetic state failure'); expect(f.files()).toEqual([null, null]); expect(f.store.getManagedState(copilotCliHistoryKey(f.targets.providersPath), null)).toBeNull();
  });

  it.each([0, 1])('recovers an interrupted transaction at file %s before reading the next restore baseline', index => {
    const f = fixture(); f.write(f.targets.settingsPath, '// user comment\n{"model":"original"}'); f.apply();
    const journal = structuredClone(f.journals[0]) as any;
    journal.files.forEach((file: any) => { if (file.before === null) rmSync(file.path, { force: true }); else f.write(file.path, file.before); });
    for (let committed = 0; committed <= index; committed++) f.write(journal.files[committed].path, journal.files[committed].after);
    f.states.set(copilotCliHistoryKey(f.targets.providersPath), journal); f.restore();
    expect(existsSync(f.targets.providersPath)).toBe(false); expect(readFileSync(f.targets.settingsPath, 'utf8')).toBe('// user comment\n{"model":"original"}');
    expect(f.store.getManagedState(copilotCliHistoryKey(f.targets.providersPath), null)).toBeNull();
  });

  it('keeps interrupted ownership pending when a target has an external edit', () => {
    const f = fixture(); f.apply(); const journal = structuredClone(f.journals[0]) as any;
    f.states.set(copilotCliHistoryKey(f.targets.providersPath), journal); f.write(f.targets.settingsPath, { model: 'external' });
    const before = f.files(); expect(() => f.restore()).toThrow('外部修改'); expect(f.files()).toEqual(before);
    expect(f.store.getManagedState(copilotCliHistoryKey(f.targets.providersPath), null)).toEqual(journal);
  });

  it('honors independent absolute home and registry overrides while isolating fixture homes from environment', () => {
    const f = fixture(); vi.stubEnv('COPILOT_HOME', join(f.root, 'environment-home')); vi.stubEnv('COPILOT_PROVIDERS_CONFIG', join(f.root, 'environment-registry.json'));
    expect(copilotCliConfigDirectory(f.root)).toBe(join(f.root, '.copilot'));
    expect(copilotCliConfigTargets(f.root)).toEqual(f.targets);
    const options = { copilotHome: join(f.root, '中文 CLI home'), providersConfig: join(f.root, 'registry & path', 'custom.json') };
    const targets = copilotCliConfigTargets(f.root, options); f.apply(options);
    expect(f.read(targets.providersPath).providers).toHaveLength(2); expect(f.read(targets.settingsPath).model).toContain('modeldock-responses/');
    expect(() => copilotCliConfigTargets(f.root, { providersConfig: 'relative' })).toThrow(/绝对路径/);
    expect(() => copilotCliConfigTargets(f.root, { copilotHome: ' ' })).toThrow(/绝对路径/);
    expect(() => copilotCliConfigTargets(f.root, { providersConfig: f.targets.settingsPath })).toThrow(/同一个文件/);
    f.restore(options); expect(existsSync(targets.providersPath)).toBe(false); expect(existsSync(targets.settingsPath)).toBe(false);
  });

  it('rejects malformed files, directory links and hard-linked credential targets', () => {
    const f = fixture(); f.write(f.targets.providersPath, '{"providers":{}}'); expect(() => f.apply()).toThrow(/格式无效/);
    f.write(f.targets.providersPath, '{ /* no registry comments */ }'); expect(() => f.apply()).toThrow(/格式无效/);
    f.write(f.targets.providersPath, '{}'); f.write(f.targets.settingsPath, '{"theme":'); expect(() => f.apply()).toThrow(/格式无效/);
    const linked = fixture(), outside = join(linked.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(linked.root, '.copilot'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => linked.apply()).toThrow(/链接/); expect(existsSync(join(outside, 'providers.json'))).toBe(false);
    const hard = fixture(), original = join(hard.root, 'original.json'); hard.write(original, '{}'); mkdirSync(dirname(hard.targets.providersPath)); linkSync(original, hard.targets.providersPath);
    expect(() => hard.apply()).toThrow(/类型或大小/); expect(readFileSync(original, 'utf8')).toBe('{}');
    const invalid = fixture(); mkdirSync(dirname(invalid.targets.providersPath)); writeFileSync(invalid.targets.providersPath, Buffer.from([0xff, 0xfe, 0x00])); expect(() => invalid.apply()).toThrow(/UTF-8/);
    invalid.write(invalid.targets.providersPath, ' '.repeat(2 * 1024 * 1024 + 1)); expect(() => invalid.apply()).toThrow(/类型或大小/);
  });

  it.runIf(process.platform === 'win32')('writes private current-user/SYSTEM ACLs on every credential replacement', () => {
    const f = fixture(); f.apply(); f.binding.mode = 'aggregate'; f.apply();
    for (const path of Object.values(f.targets)) {
      const script = `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[IO.File]::GetAccessControl('${path.replace(/'/g, "''")}'); $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(!$acl.AreAccessRulesProtected -or $rules.Count -ne 2 -or @($rules | Where-Object {$_.IdentityReference.Value -notin @($sid,"S-1-5-18") -or $_.AccessControlType -ne "Allow" -or $_.FileSystemRights -ne "FullControl"}).Count){throw "Unexpected Copilot CLI profile ACL"}; "private"`;
      expect(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim()).toBe('private');
    }
  });
});
