import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyJunieConfig, buildJunieConfig, junieConfigDirectory, junieConfigTargets, junieHistoryKey, restoreJunieOfficialConfig, type JunieConfigOptions } from '../src/main/junie-config';
import { JUNIE_ACP_NAME } from '../src/main/junie-acp';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-junie-config-')); roots.push(root);
  const targets = junieConfigTargets(root), backups = join(root, 'backups'), states = new Map<string, unknown>(), journals: unknown[] = [];
  const provider: Provider = { id: 'api', name: 'Fixture API', kind: 'openai-compatible', enabled: true, hasSecret: true, authStatus: 'ready', baseUrl: 'https://api.fixture.invalid/v1', note: '' };
  const model: Model = { id: 'model', providerId: provider.id, upstreamId: 'native-model-id', alias: 'aggregate-model-alias', displayName: 'Selected fixture model', wireApi: 'responses', enabled: true, contextWindow: 64000, tools: true, vision: true };
  const binding: ToolBinding = { id: 'junie', name: 'Junie', enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: [], modelSelection: 'all', defaultModelId: model.id, note: '' };
  const providers = [provider], models = [model];
  const store = {
    listModels: () => models, listProviders: () => providers, listBindings: () => [binding],
    getSecret: vi.fn(() => ({ apiKey: 'SYNTHETIC_UPSTREAM_KEY', accessToken: 'SYNTHETIC_OAUTH_NEVER_EXPORT' })),
    gatewayKey: () => 'SYNTHETIC_LOCAL_KEY',
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn((kind: string, value: unknown) => { expect(kind).toBe('junie-config'); journals.push(structuredClone(value)); return 'synthetic-encrypted-backup.enc'; }),
  };
  const options: JunieConfigOptions = { junieCommand: { command: process.execPath, args: [] } };
  const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const apply = (extra: JunieConfigOptions = {}) => applyJunieConfig(store, backups, root, { ...options, ...extra });
  const restore = (extra: JunieConfigOptions = {}) => restoreJunieOfficialConfig(store, backups, root, { ...options, ...extra });
  const preview = (reveal = false) => buildJunieConfig(store, reveal, 19191, root, options);
  const files = () => Object.values(targets).map(path => existsSync(path) ? readFileSync(path, 'utf8') : null);
  return { root, targets, backups, states, journals, store, provider, providers, model, models, binding, options, write, read, apply, restore, preview, files };
}

describe('Junie CLI and IDE custom profile configuration', () => {
  it('previews native Responses and a separate IDE ACP entry without reading credentials or writing files', () => {
    const f = fixture(), preview = f.preview(), value = JSON.parse(preview.content);
    expect(value.config).toEqual({ model: 'custom:modeldock' });
    expect(value.profile).toEqual({ id: 'native-model-id', baseUrl: 'https://api.fixture.invalid/v1/responses', apiType: 'OpenAIResponses', apiKey: '__PROVIDER_API_KEY__', displayName: 'Selected fixture model', providerName: 'Fixture API', maxContextLength: 64000 });
    expect(value.acp).toEqual({ command: process.execPath, args: ['--acp', 'true', '--model', 'custom:modeldock'], env: { JUNIE_HOME: join(f.root, '.junie') } });
    expect(preview.canApply).toBe(true); expect(preview.instructions).toContain('当前仅同步默认模型');
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.files()).toEqual([null, null, null]); expect(f.states.size).toBe(0);
    expect(preview.content).not.toMatch(/SYNTHETIC_|aggregate-model-alias/);
  });

  it('uses full Chat endpoint URLs and omits an unknown context instead of inventing a budget', () => {
    const f = fixture(); f.model.wireApi = 'chat-completions'; f.model.contextWindow = 0;
    expect(JSON.parse(f.preview(true).content).profile).toEqual({ id: f.model.upstreamId, baseUrl: 'https://api.fixture.invalid/v1/chat/completions', apiType: 'OpenAICompletion', apiKey: 'SYNTHETIC_UPSTREAM_KEY', displayName: f.model.displayName, providerName: f.provider.name });
    expect(f.preview(true).content).not.toContain('SYNTHETIC_OAUTH');
  });

  it('keeps subscription credentials in ModelDock and uses exact selected aliases and protocols for aggregation', () => {
    const f = fixture(); f.binding.mode = 'aggregate'; f.provider.kind = 'codex';
    f.store.getSecret.mockImplementation(() => { throw new Error('Subscription secrets must not be read'); });
    expect(JSON.parse(f.preview(true).content).profile).toMatchObject({ id: f.model.alias, apiType: 'OpenAIResponses', baseUrl: 'http://127.0.0.1:19191/tool/junie/v1/responses', apiKey: 'SYNTHETIC_LOCAL_KEY' });
    f.model.wireApi = 'chat-completions';
    expect(JSON.parse(f.preview(true).content).profile).toMatchObject({ apiType: 'OpenAICompletion', baseUrl: 'http://127.0.0.1:19191/tool/junie/v1/chat/completions' });
    expect(f.store.getSecret).not.toHaveBeenCalled();
    f.binding.modelSelection = 'selected'; f.binding.modelIds = [];
    expect(f.preview().content).toBe('');
  });

  it('does not silently bridge an unavailable direct source or invent a Messages profile', () => {
    const f = fixture(); f.providers.push({ ...f.provider, id: 'second' }); f.binding.providerIds!.push('second');
    expect(() => f.preview()).toThrow(/恰好一个/);
    f.binding.providerIds = [f.provider.id]; f.model.wireApi = 'messages';
    expect(f.preview().content).toBe('');
    f.model.wireApi = 'responses'; f.provider.authStatus = 'missing';
    expect(() => f.preview()).toThrow(/凭据/);
  });

  it('applies three files together, preserves unrelated settings and agents, and restores the original selection', () => {
    const f = fixture();
    const config = { model: 'previous-native', provider: 'openai', hooks: { SessionStart: [] }, byok: { openai: 'SYNTHETIC_EXISTING_BYOK' }, brave: false };
    const acp = { agent_servers: { Other: { command: '/keep', args: ['--same'] } }, default_mcp_settings: { use_idea_mcp: false }, future: true };
    f.write(f.targets.configPath, config); f.write(f.targets.acpPath, acp);
    const userProfile = join(f.root, '.junie', 'models', 'user-model.json'); f.write(userProfile, { id: 'keep-user-model' });
    expect(f.apply()).toBe(f.targets.configPath);
    expect(f.read(f.targets.configPath)).toEqual({ ...config, model: 'custom:modeldock' });
    expect(f.read(f.targets.profilePath)).toMatchObject({ id: f.model.upstreamId, apiKey: 'SYNTHETIC_UPSTREAM_KEY' });
    expect(f.read(f.targets.acpPath)).toEqual({ ...acp, agent_servers: { ...acp.agent_servers, [JUNIE_ACP_NAME]: JSON.parse(f.preview(true).content).acp } });
    expect(f.read(userProfile)).toEqual({ id: 'keep-user-model' });
    expect(f.journals).toHaveLength(1);
    const history = f.store.getManagedState<any>(junieHistoryKey(f.targets.configPath), null);
    expect(history.beforeModel).toEqual({ present: true, value: 'previous-native' });
    f.apply(); expect(f.journals).toHaveLength(1);
    f.binding.mode = 'aggregate'; f.apply();
    expect(f.read(f.targets.profilePath)).toMatchObject({ id: f.model.alias, apiKey: 'SYNTHETIC_LOCAL_KEY' });
    expect(f.read(f.targets.acpPath).agent_servers[JUNIE_ACP_NAME].env).not.toHaveProperty('API_KEY');
    f.restore();
    expect(f.read(f.targets.configPath)).toEqual(config);
    expect(f.read(f.targets.acpPath)).toEqual(acp);
    expect(existsSync(f.targets.profilePath)).toBe(false);
    expect(f.store.getManagedState(junieHistoryKey(f.targets.configPath), null)).toBeNull();
  });

  it('preserves an externally chosen default and unrelated ACP changes when removing its own configuration', () => {
    const f = fixture(); f.apply();
    f.write(f.targets.configPath, { model: 'user-chosen-after-sync', brave: false });
    const acp = f.read(f.targets.acpPath); acp.agent_servers.Other = { command: '/new-user-agent', args: [] }; acp.default_mcp_settings = { keep: true }; f.write(f.targets.acpPath, acp);
    f.binding.enabled = false; f.apply();
    expect(f.read(f.targets.configPath)).toEqual({ model: 'user-chosen-after-sync', brave: false });
    expect(f.read(f.targets.acpPath)).toEqual({ agent_servers: { Other: { command: '/new-user-agent', args: [] } }, default_mcp_settings: { keep: true } });
    expect(existsSync(f.targets.profilePath)).toBe(false);
  });

  it('removes only files it originally created and preserves a pre-existing empty ACP agents object', () => {
    const fresh = fixture(); fresh.apply(); fresh.restore();
    expect(fresh.files()).toEqual([null, null, null]);
    const existing = fixture(); existing.write(existing.targets.acpPath, '\uFEFF{"agent_servers":{},"future":true}');
    existing.write(existing.targets.configPath, '\uFEFF{"brave":false}');
    existing.apply(); existing.restore();
    expect(existing.read(existing.targets.configPath)).toEqual({ brave: false });
    expect(existing.read(existing.targets.acpPath)).toEqual({ agent_servers: {}, future: true });
    expect(existsSync(existing.targets.profilePath)).toBe(false);
  });

  it.each(['profile', 'acp'] as const)('refuses a foreign %s target and does not modify any other file', kind => {
    const f = fixture(); f.write(f.targets.configPath, { model: 'untouched' });
    if (kind === 'profile') f.write(f.targets.profilePath, { id: 'foreign' });
    else f.write(f.targets.acpPath, { agent_servers: { [JUNIE_ACP_NAME]: { command: '/foreign', args: [] } } });
    const before = f.files();
    expect(() => f.apply()).toThrow(/不属于 ModelDock/);
    expect(f.files()).toEqual(before); expect(f.states.size).toBe(0); expect(f.journals).toHaveLength(0);
  });

  it.each(['profile', 'acp'] as const)('refuses to overwrite an externally edited managed %s on apply or restore', kind => {
    const f = fixture(); f.apply();
    if (kind === 'profile') f.write(f.targets.profilePath, { id: 'changed-by-user' });
    else { const acp = f.read(f.targets.acpPath); acp.agent_servers[JUNIE_ACP_NAME].args.push('--user-change'); f.write(f.targets.acpPath, acp); }
    const before = f.files();
    expect(() => f.apply()).toThrow(/外部修改/); expect(() => f.restore()).toThrow(/外部修改/);
    expect(f.files()).toEqual(before);
  });

  it.each([1, 2, 0])('rolls back files and ownership when committing file %s fails', index => {
    const f = fixture(); f.write(f.targets.configPath, { model: 'before', hooks: { keep: [] } }); f.write(f.targets.acpPath, { agent_servers: { Other: { command: '/keep' } } });
    const before = f.files();
    expect(() => f.apply({ afterFileCommit: committed => { if (committed === index) throw new Error('synthetic file failure'); } })).toThrow('synthetic file failure');
    expect(f.files()).toEqual(before); expect(f.store.getManagedState(junieHistoryKey(f.targets.configPath), null)).toBeNull(); expect(f.journals).toHaveLength(1);
  });

  it('checks all files again immediately before committing and preserves a raced external edit', () => {
    const f = fixture(); f.write(f.targets.configPath, { model: 'before' });
    expect(() => f.apply({ beforeCommit: () => f.write(f.targets.acpPath, { future: 'external edit' }) })).toThrow(/刚被其他程序修改/);
    expect(f.read(f.targets.configPath)).toEqual({ model: 'before' }); expect(existsSync(f.targets.profilePath)).toBe(false);
    expect(f.read(f.targets.acpPath)).toEqual({ future: 'external edit' }); expect(f.states.size).toBe(0);
  });

  it('fails before file writes if encrypted backup or ownership persistence is unavailable', () => {
    const f = fixture(); f.store.createManagedBackup.mockImplementationOnce(() => { throw new Error('synthetic backup failure'); });
    expect(() => f.apply()).toThrow('synthetic backup failure'); expect(f.files()).toEqual([null, null, null]);
    f.store.setManagedState.mockImplementationOnce(() => { throw new Error('synthetic state failure'); });
    expect(() => f.apply()).toThrow('synthetic state failure'); expect(f.files()).toEqual([null, null, null]);
    expect(f.store.getManagedState(junieHistoryKey(f.targets.configPath), null)).toBeNull();
  });

  it('honors an explicit JUNIE_HOME without borrowing the real home and rejects directory links', () => {
    const f = fixture(); vi.stubEnv('JUNIE_HOME', join(f.root, 'real-env-must-not-be-used'));
    expect(junieConfigDirectory(f.root)).toBe(join(f.root, '.junie'));
    expect(junieConfigDirectory(f.root, join(f.root, 'chosen home'))).toBe(join(f.root, 'chosen home'));
    expect(() => junieConfigDirectory(f.root, 'relative')).toThrow(/绝对目录/);
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(f.root, '.junie'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => f.apply()).toThrow(/链接/); expect(existsSync(join(outside, 'config.json'))).toBe(false);
  });
});
