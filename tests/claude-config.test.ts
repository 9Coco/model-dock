import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyConfig, buildConfig } from '../src/main/adapters';
import { applyClaudeConfig, buildClaudeConfig, claudeHistoryKey, restoreClaudeOfficialConfig, type ClaudeConfigStore } from '../src/main/claude-config';
import { restoreOfficialConfig, type ToolRestoreStore } from '../src/main/tool-restore';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-claude-config-')); roots.push(root);
  const target = join(root, '.claude', 'settings.json'), backups = join(root, 'backups'), states = new Map<string, unknown>();
  const provider: Provider = { id: 'api-source', name: 'Fixture Messages', kind: 'openai-compatible', baseUrl: 'https://messages.fixture/anthropic/v1/', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
  const model: Model = { id: 'model', providerId: provider.id, upstreamId: 'real-upstream-id', alias: 'local-alias-never-export', displayName: 'Fixture model', wireApi: 'messages', contextWindow: 32000, tools: true, vision: true, enabled: true };
  const binding: ToolBinding = { id: 'claude-code', name: 'Claude Code', note: '', enabled: true, mode: 'direct', providerIds: [provider.id], modelSelection: 'all', modelIds: [], defaultModelId: model.id };
  const models = [model], providers = [provider];
  const store = {
    dataDir: root,
    listModels: () => models,
    listBindings: () => [binding],
    listProviders: () => providers,
    getProvider: (id: string) => providers.find(item => item.id === id),
    getSecret: () => ({ apiKey: 'SYNTHETIC_SECRET_API_KEY' }),
    gatewayKey: () => 'SYNTHETIC_GATEWAY_KEY',
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: () => join(backups, 'synthetic-private.enc'),
  };
  const write = (path: string, value: string | object) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const apply = (options = {}) => applyClaudeConfig(store, backups, root, options);
  const read = (path = target) => JSON.parse(readFileSync(path, 'utf8')) as any;
  return { root, target, backups, states, store, model, models, binding, provider, providers, write, apply, read };
}

describe('Claude Code native BYOK configuration', () => {
  it('previews a single Messages endpoint without credentials or local aliases', () => {
    const f = fixture(), preview = buildConfig(f.store, 'claude-code', 18181), value = JSON.parse(preview.content);
    expect(value.model).toBe(f.model.upstreamId);
    expect(value.env.ANTHROPIC_BASE_URL).toBe('https://messages.fixture/anthropic');
    expect(value.env.ANTHROPIC_AUTH_TOKEN).toBe('__PROVIDER_API_KEY__');
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) expect(value.env[key]).toBe(f.model.upstreamId);
    expect(value.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(preview.content).not.toMatch(/SYNTHETIC_SECRET|SYNTHETIC_GATEWAY|127\.0\.0\.1|local-alias/);
    expect(preview.instructions).toContain('WebFetch'); expect(preview.instructions).toContain('VS Code');
    expect(existsSync(f.target)).toBe(false); expect(f.states.size).toBe(0);
    expect(JSON.parse(buildClaudeConfig(f.store, true).content).env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_SECRET_API_KEY');
  });
  it.each(['https://messages.fixture', 'https://messages.fixture/v1', 'https://messages.fixture/v1/'])('normalizes the native SDK root for %s', baseUrl => {
    const f = fixture(); f.provider.baseUrl = baseUrl;
    expect(JSON.parse(buildClaudeConfig(f.store).content).env.ANTHROPIC_BASE_URL).toBe('https://messages.fixture');
  });
  it.each(['api-key', 'bearer'] as const)('matches %s authentication in preview, application and cancellation without dual credentials', messagesAuth => {
    const f = fixture(); f.provider.messagesAuth = messagesAuth;
    const credential = messagesAuth === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    const competing = messagesAuth === 'api-key' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
    const preview = buildClaudeConfig(f.store), value = JSON.parse(preview.content);
    expect(value.env[credential]).toBe('__PROVIDER_API_KEY__'); expect(value.env).not.toHaveProperty(competing);
    expect(preview.instructions).toContain(messagesAuth === 'api-key' ? 'x-api-key' : 'Authorization: Bearer');
    const original = { env: { ANTHROPIC_API_KEY: 'SYNTHETIC_PREVIOUS_KEY', ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_PREVIOUS_TOKEN', KEEP: 'keep' } };
    f.write(f.target, original); f.apply();
    expect(f.read().env[credential]).toBe('SYNTHETIC_SECRET_API_KEY'); expect(f.read().env).not.toHaveProperty(competing);
    f.binding.enabled = false; f.binding.providerIds = []; f.apply();
    expect(f.read()).toEqual({ env: { ...original.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  });
  it('switching the selected auth header retains the original restoration baseline and official restore clears both headers', () => {
    const f = fixture(); f.write(f.target, { env: { ANTHROPIC_API_KEY: 'SYNTHETIC_ORIGINAL_KEY', ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_ORIGINAL_TOKEN' } });
    f.apply(); expect(f.read().env).not.toHaveProperty('ANTHROPIC_API_KEY');
    f.provider.messagesAuth = 'api-key'; f.apply();
    expect(f.read().env.ANTHROPIC_API_KEY).toBe('SYNTHETIC_SECRET_API_KEY'); expect(f.read().env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    const history = f.store.getManagedState<any>(claudeHistoryKey(f.target), null);
    expect(history.fields['env.ANTHROPIC_API_KEY'].before.value).toBe('SYNTHETIC_ORIGINAL_KEY'); expect(history.fields['env.ANTHROPIC_AUTH_TOKEN'].before.value).toBe('SYNTHETIC_ORIGINAL_TOKEN');
    restoreClaudeOfficialConfig(f.store, f.backups, f.root);
    expect(f.read()).toEqual({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  });
  it.each([
    ['deepseek', 'https://api.deepseek.com', 'https://api.deepseek.com/anthropic', 'deepseek-flash'],
    ['volcengine-agent', 'https://ark.cn-beijing.volces.com/api/plan/v3', 'https://ark.cn-beijing.volces.com/api/plan', 'ark-code-latest'],
    ['volcengine-token', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'https://ark.cn-beijing.volces.com/api/coding', 'ark-code-latest'],
    ['qwen-token', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', 'qwen3.8-max'],
  ] as const)('reuses existing %s API models and keys through the official Claude endpoint while retaining its OpenAI address', (presetId, baseUrl, claudeUrl, upstreamId) => {
    const f = fixture(); f.provider.presetId = presetId; f.provider.baseUrl = baseUrl; f.model.wireApi = 'responses'; f.model.upstreamId = upstreamId;
    const preview = JSON.parse(buildConfig(f.store, 'claude-code', 19876).content);
    expect(preview.env.ANTHROPIC_BASE_URL).toBe(claudeUrl); expect(preview.model).toBe(upstreamId); expect(preview.env.ANTHROPIC_AUTH_TOKEN).toBe('__PROVIDER_API_KEY__');
    expect(preview.env).not.toHaveProperty('MAX_THINKING_TOKENS'); expect(preview.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_THINKING');
    f.write(f.target, { env: { MAX_THINKING_TOKENS: '8192', CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '0' } }); f.apply();
    const value = f.read(); expect(value.env.ANTHROPIC_BASE_URL).toBe(claudeUrl); expect(value.env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_SECRET_API_KEY'); expect(value.model).toBe(upstreamId);
    expect(value.env.MAX_THINKING_TOKENS).toBe('8192'); expect(value.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe('0');
    expect(f.provider.baseUrl).toBe(baseUrl); expect(f.model.wireApi).toBe('responses'); expect(f.models).toHaveLength(1);
  });
  it.each(['codex', 'grok', 'copilot'] as const)('uses only a fixed local key and model alias for the %s subscription bridge, then safely restores user settings', kind => {
    const f = fixture(); f.provider.kind = kind; f.model.wireApi = 'responses'; f.provider.messagesAuth = 'api-key';
    f.store.getSecret = vi.fn(() => { throw new Error('Subscription credentials must stay in the main process.'); });
    const preview = buildConfig(f.store, 'claude-code', 19876), value = JSON.parse(preview.content);
    expect(value.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:19876/tool/claude-code'); expect(value.env.ANTHROPIC_AUTH_TOKEN).toBe('__MODELDOCK_LOCAL_KEY__'); expect(value.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(value.model).toBe(f.model.alias); expect(value.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(f.model.alias);
    expect(value.env.MAX_THINKING_TOKENS).toBe('0'); expect(value.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe('1'); expect(value.env.CLAUDE_CODE_DISABLE_THINKING).toBe('1');
    expect(preview.instructions).toContain('主进程'); expect(preview.content).not.toContain('SYNTHETIC_GATEWAY_KEY');
    const original = { env: { MAX_THINKING_TOKENS: '8192', CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '0', CLAUDE_CODE_DISABLE_THINKING: '0', ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_PREVIOUS_TOKEN' }, permissions: { allow: ['Read'] } }; f.write(f.target, original);
    applyConfig(f.store, 'claude-code', 19876, f.root, f.backups, f.root); expect(f.read().env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_GATEWAY_KEY'); expect(f.read().model).toBe(f.model.alias); expect(f.store.getSecret).not.toHaveBeenCalled();
    f.binding.enabled = false; f.binding.providerIds = []; f.apply();
    expect(f.read()).toEqual({ ...original, env: { ...original.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  });
  it('bridges a custom OpenAI API without exporting its upstream key and restores thinking settings when switched to an official native endpoint', () => {
    const f = fixture(); f.model.wireApi = 'chat-completions';
    const original = { env: { MAX_THINKING_TOKENS: '4096', CLAUDE_CODE_DISABLE_THINKING: '0' } }; f.write(f.target, original);
    f.apply(); expect(f.read().env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_GATEWAY_KEY'); expect(f.read().model).toBe(f.model.alias); expect(f.read().env.MAX_THINKING_TOKENS).toBe('0');
    f.provider.presetId = 'deepseek'; f.provider.baseUrl = 'https://api.deepseek.com'; f.apply();
    expect(f.read().env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic'); expect(f.read().env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_SECRET_API_KEY'); expect(f.read().model).toBe(f.model.upstreamId);
    expect(f.read().env.MAX_THINKING_TOKENS).toBe('4096'); expect(f.read().env.CLAUDE_CODE_DISABLE_THINKING).toBe('0'); expect(f.read().env).not.toHaveProperty('CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING');
    expect(f.store.getManagedState<any>(claudeHistoryKey(f.target), null).fields).not.toHaveProperty('env.MAX_THINKING_TOKENS');
  });
  it('uses an explicit Claude endpoint override for an existing OpenAI model without rewriting its normal API address', () => {
    const f = fixture(); f.model.wireApi = 'responses'; f.provider.claudeBaseUrl = 'https://native.fixture/anthropic/v1/';
    f.apply(); expect(f.read().env.ANTHROPIC_BASE_URL).toBe('https://native.fixture/anthropic'); expect(f.read().env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_SECRET_API_KEY'); expect(f.read().model).toBe(f.model.upstreamId);
    expect(f.provider.baseUrl).toBe('https://messages.fixture/anthropic/v1/');
  });
  it('refuses an invalid local gateway port before exporting or applying credentials', () => {
    const f = fixture(); f.model.wireApi = 'responses';
    expect(() => buildConfig(f.store, 'claude-code', 0)).toThrow('端口'); expect(() => f.apply({ port: 65536 })).toThrow('端口'); expect(existsSync(f.target)).toBe(false);
  });
  it.each(['missing', 'signing-in', 'error'] as const)('does not publish a bridge for a source whose auth is %s', authStatus => {
    const f = fixture(); f.provider.kind = 'codex'; f.model.wireApi = 'responses'; f.provider.authStatus = authStatus;
    expect(() => buildClaudeConfig(f.store)).toThrow('尚未就绪'); expect(() => f.apply()).toThrow('尚未就绪'); expect(existsSync(f.target)).toBe(false);
  });
  it('does not publish a bridge for a provider with no stored credentials', () => {
    const f = fixture(); f.model.wireApi = 'chat-completions'; f.provider.hasSecret = false;
    expect(() => f.apply()).toThrow('尚未就绪'); expect(existsSync(f.target)).toBe(false);
  });
  it('rejects invalid Messages auth configuration before changing settings', () => {
    const f = fixture(); Object.assign(f.provider, { messagesAuth: 'invalid-auth-mode' }); f.write(f.target, '{}');
    expect(() => f.apply()).toThrow('鉴权方式'); expect(readFileSync(f.target, 'utf8')).toBe('{}'); expect(f.states.size).toBe(0);
  });
  it('preserves unrelated settings and login data, neutralizes competing settings and privately backs up exact originals', () => {
    const f = fixture();
    const original = { model: 'previous-model', apiKeyHelper: 'keep-restorable-helper', permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'keep-hook' }] }] }, mcpServers: { keep: { command: 'mcp' } }, plugins: ['keep'], skipWebFetchPreflight: false,
      env: { KEEP: 'original', ANTHROPIC_API_KEY: 'SYNTHETIC_OLD_KEY', ANTHROPIC_BASE_URL: 'https://old.fixture', CLAUDE_CODE_OAUTH_TOKEN: 'SYNTHETIC_OLD_OAUTH', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: old', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' } };
    f.write(f.target, original); chmodSync(f.target, 0o644);
    const originalRaw = readFileSync(f.target, 'utf8'), login = join(f.root, '.claude.json'); f.write(login, 'SYNTHETIC_NATIVE_LOGIN');
    expect(applyConfig(f.store, 'claude-code', 18181, f.root, f.backups, f.root)).toBe(f.target);
    const value = f.read();
    expect(value.permissions).toEqual(original.permissions); expect(value.hooks).toEqual(original.hooks); expect(value.mcpServers).toEqual(original.mcpServers); expect(value.plugins).toEqual(original.plugins); expect(value.skipWebFetchPreflight).toBe(false);
    expect(value.env.KEEP).toBe('original'); expect(value.env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_SECRET_API_KEY');
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) expect(value.env).not.toHaveProperty(key);
    expect(value).not.toHaveProperty('apiKeyHelper'); expect(readFileSync(login, 'utf8')).toBe('SYNTHETIC_NATIVE_LOGIN');
    const backup = join(f.backups, readdirSync(f.backups)[0]); expect(readFileSync(backup, 'utf8')).toBe(originalRaw);
    if (process.platform !== 'win32') { expect(statSync(f.target).mode & 0o777).toBe(0o600); expect(statSync(backup).mode & 0o777).toBe(0o600); }
    const history = f.store.getManagedState<any>(claudeHistoryKey(f.target), null);
    expect(history.fields['env.ANTHROPIC_API_KEY'].before.value).toBe('SYNTHETIC_OLD_KEY'); expect(history.fields['env.ANTHROPIC_AUTH_TOKEN'].applied.value).toBe('SYNTHETIC_SECRET_API_KEY');
  });
  it('supports CLAUDE_CONFIG_DIR overrides without touching the default user profile', async () => {
    const f = fixture(), claudeConfigDir = join(f.root, 'custom-claude');
    f.write(f.target, { env: { KEEP: 'default profile' } });
    const target = join(claudeConfigDir, 'settings.json');
    expect(applyConfig(f.store, 'claude-code', 18181, f.root, f.backups, f.root, { claudeConfigDir })).toBe(target);
    expect(f.read(target).env.ANTHROPIC_AUTH_TOKEN).toBe('SYNTHETIC_SECRET_API_KEY');
    await restoreOfficialConfig(f.store as ToolRestoreStore, 'claude-code', f.root, f.backups, f.root, { claudeConfigDir });
    expect(f.read(target)).toEqual({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    expect(f.read()).toEqual({ env: { KEEP: 'default profile' } });
  });
  it('changes the privacy switch only by explicit active configuration and retains its choice on removal', () => {
    const f = fixture(); f.binding.claudeDisableTelemetry = false;
    f.write(f.target, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' } });
    expect(JSON.parse(buildClaudeConfig(f.store).content).env).not.toHaveProperty('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
    f.apply(); expect(f.read().env).not.toHaveProperty('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
    f.binding.enabled = false; f.binding.providerIds = []; f.apply();
    expect(f.read()).toEqual({ env: { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' } });
  });
  it('cancelling a source restores preexisting managed fields while preserving later edits and privacy', () => {
    const f = fixture(), original = { model: 'old-model', apiKeyHelper: 'old-helper', env: { ANTHROPIC_BASE_URL: 'https://old.fixture', ANTHROPIC_API_KEY: 'SYNTHETIC_OLD_KEY', KEEP: 'keep', CLAUDE_CODE_USE_VERTEX: '1' } };
    f.write(f.target, original); f.apply();
    const manual = f.read(); manual.env.ANTHROPIC_MODEL = 'manual-model'; manual.env.KEEP = 'manual-keep'; manual.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 'manual-privacy'; f.write(f.target, manual);
    f.binding.enabled = false; f.binding.providerIds = []; f.apply();
    expect(f.read()).toEqual({ ...original, env: { ...original.env, KEEP: 'manual-keep', ANTHROPIC_MODEL: 'manual-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'manual-privacy' } });
    expect(f.store.getManagedState(claudeHistoryKey(f.target), null)).toBeNull();
  });
  it('resynchronization retains the first baseline, and captures an explicit external change as a new restoration baseline', () => {
    const f = fixture(); f.write(f.target, { env: { ANTHROPIC_MODEL: 'original' } }); f.apply();
    f.model.upstreamId = 'upstream-second'; f.apply();
    expect(f.store.getManagedState<any>(claudeHistoryKey(f.target), null).fields['env.ANTHROPIC_MODEL'].before.value).toBe('original');
    const manual = f.read(); manual.env.ANTHROPIC_MODEL = 'manual-choice'; f.write(f.target, manual); f.apply();
    f.binding.enabled = false; f.binding.providerIds = []; f.apply();
    expect(f.read().env.ANTHROPIC_MODEL).toBe('manual-choice');
  });
  it('official restoration clears still-managed routes instead of restoring previous third-party credentials', () => {
    const f = fixture(); f.write(f.target, { apiKeyHelper: 'old-third-party-helper', model: 'old-third-party-model', env: { ANTHROPIC_API_KEY: 'SYNTHETIC_OLD_KEY', ANTHROPIC_BASE_URL: 'https://old.fixture', CLAUDE_CODE_USE_VERTEX: '1', KEEP: 'keep' }, permissions: { allow: ['Read'] } }); f.apply();
    const manual = f.read(); manual.env.ANTHROPIC_AUTH_TOKEN = 'SYNTHETIC_MANUAL_TOKEN'; manual.model = 'manual-model'; f.write(f.target, manual);
    restoreClaudeOfficialConfig(f.store, f.backups, f.root);
    expect(f.read()).toEqual({ model: 'manual-model', permissions: { allow: ['Read'] }, env: { KEEP: 'keep', ANTHROPIC_AUTH_TOKEN: 'SYNTHETIC_MANUAL_TOKEN', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    expect(f.store.getManagedState(claudeHistoryKey(f.target), null)).toBeNull(); expect(readdirSync(f.backups).some(name => name.startsWith('claude-code-official-'))).toBe(true);
  });
  it('does not create files or alter unrelated existing settings when no source/history is active', () => {
    const f = fixture(); f.binding.enabled = false; f.binding.providerIds = [];
    expect(f.apply()).toBe(f.target); expect(existsSync(f.target)).toBe(false);
    f.write(f.target, { env: { ANTHROPIC_BASE_URL: 'https://manual.fixture', KEEP: 'keep' } }); const original = readFileSync(f.target, 'utf8');
    f.apply(); restoreClaudeOfficialConfig(f.store, f.backups, f.root);
    expect(readFileSync(f.target, 'utf8')).toBe(original); expect(existsSync(f.backups)).toBe(false);
  });
  it('refuses aggregate mode, multiple sources, disabled providers and incompatible defaults', () => {
    const f = fixture(); f.binding.mode = 'aggregate'; expect(() => f.apply()).toThrow('聚合');
    f.binding.mode = 'direct'; f.binding.providerIds!.push('second'); expect(() => f.apply()).toThrow('恰好一个');
    f.binding.providerIds = [f.provider.id]; f.provider.enabled = false; expect(() => f.apply()).toThrow('已启用');
    f.provider.enabled = true; f.binding.defaultModelId = 'missing'; expect(() => f.apply()).toThrow('默认模型');
    expect(existsSync(f.target)).toBe(false); expect(f.states.size).toBe(0);
  });
  it('requires a real key for explicit export/apply while keeping preview usable', () => {
    const f = fixture(); f.store.getSecret = () => ({ apiKey: '' });
    expect(() => buildClaudeConfig(f.store)).not.toThrow(); expect(() => buildClaudeConfig(f.store, true)).toThrow('API Key'); expect(() => f.apply()).toThrow('API Key');
    expect(existsSync(f.target)).toBe(false);
  });
  it.each(['{invalid', '[]', '{"env":[]}', '{"env":{"KEY":42}}', '{"apiKeyHelper":{}}'])('refuses invalid JSON/settings without modifying original %s', original => {
    const f = fixture(); f.write(f.target, original);
    expect(() => f.apply()).toThrow(); expect(readFileSync(f.target, 'utf8')).toBe(original); expect(f.states.size).toBe(0); expect(existsSync(f.backups)).toBe(false);
  });
  it('refuses symlink files/directories and oversized settings', () => {
    const f = fixture(), outside = join(f.root, 'outside.json'); f.write(outside, '{}'); mkdirSync(dirname(f.target), { recursive: true }); symlinkSync(outside, f.target);
    expect(() => f.apply()).toThrow('类型'); expect(readFileSync(outside, 'utf8')).toBe('{}'); rmSync(f.target); rmSync(dirname(f.target), { recursive: true });
    const outsideDir = join(f.root, 'outside-dir'); mkdirSync(outsideDir); symlinkSync(outsideDir, dirname(f.target), 'dir'); expect(() => f.apply()).toThrow('目录'); rmSync(dirname(f.target));
    f.write(f.target, ' '.repeat(2 * 1024 * 1024 + 1)); expect(() => f.apply()).toThrow('大小'); expect(f.states.size).toBe(0);
  });
  it('refuses corrupt ownership records and preserves exact native settings', () => {
    const f = fixture(); f.write(f.target, '{}'); f.states.set(claudeHistoryKey(f.target), { version: 1, target: f.target, envWasPresent: false, fields: { permissions: { before: { present: false }, applied: { present: false } } } });
    expect(() => f.apply()).toThrow('恢复记录'); expect(readFileSync(f.target, 'utf8')).toBe('{}'); expect(existsSync(f.backups)).toBe(false);
  });
  it('preserves concurrent external modifications and does not commit an ownership record', () => {
    const f = fixture(); f.write(f.target, { env: { KEEP: 'original' } });
    expect(() => f.apply({ beforeCommit: () => f.write(f.target, { env: { KEEP: 'external' } }) })).toThrow('其他程序');
    expect(f.read()).toEqual({ env: { KEEP: 'external' } }); expect(f.states.size).toBe(0);
    expect(JSON.parse(readFileSync(join(f.backups, readdirSync(f.backups)[0]), 'utf8')).env.KEEP).toBe('original');
  });
  it('rolls the ownership record back when state persistence fails after mutation', () => {
    const f = fixture(); f.write(f.target, { env: { KEEP: 'original' } }); const original = readFileSync(f.target, 'utf8');
    f.store.setManagedState.mockImplementationOnce((key, value) => { f.states.set(key, structuredClone(value)); throw new Error('SYNTHETIC_STATE_FAILURE'); });
    expect(() => f.apply()).toThrow('SYNTHETIC_STATE_FAILURE'); expect(readFileSync(f.target, 'utf8')).toBe(original); expect(f.store.getManagedState(claudeHistoryKey(f.target), null)).toBeNull();
    expect(readdirSync(f.backups)).toHaveLength(1);
  });
  it('rejects an adapter without secure restoration-state storage before writing a key', () => {
    const f = fixture(), store: ClaudeConfigStore = { listModels: f.store.listModels, listBindings: f.store.listBindings, listProviders: f.store.listProviders, getSecret: f.store.getSecret, gatewayKey: f.store.gatewayKey };
    expect(() => applyClaudeConfig(store, f.backups, f.root)).toThrow('恢复记录'); expect(existsSync(f.target)).toBe(false);
  });
});
