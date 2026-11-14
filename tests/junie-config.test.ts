import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyJunieConfig, buildJunieConfig, junieConfigDirectory, junieConfigTargets, junieHistoryKey, restoreJunieOfficialConfig, type JunieConfigOptions } from '../src/main/junie-config';
import { JUNIE_ACP_NAME } from '../src/main/junie-acp';
import * as privateFiles from '../src/main/private-file';
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
  it('registers all sources with stable profile IDs, independent keys and a separate default shortcut', () => {
    const f = fixture();
    f.providers.push({ ...f.provider, id: 'second', baseUrl: 'https://second.invalid/v1', name: 'Second' }, { ...f.provider, id: 'subscription', kind: 'codex' });
    f.models.push({ ...f.model, id: 'second-model', providerId: 'second', alias: 'second-alias' }, { ...f.model, id: 'subscription-model', providerId: 'subscription', alias: 'subscription-alias' });
    f.binding.providerIds = f.providers.map(provider => provider.id);
    f.store.getSecret.mockImplementation((...args: unknown[]) => {
      expect(args[0]).not.toBe('subscription');
      return { apiKey: args[0] === 'second' ? 'SYNTHETIC_SECOND_KEY' : 'SYNTHETIC_UPSTREAM_KEY', accessToken: 'NEVER_EXPORT' };
    });
    const first = JSON.parse(f.preview(true).content);
    expect(Object.values(first.profiles)).toHaveLength(3);
    expect(Object.values(first.profiles)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.model.upstreamId, apiKey: 'SYNTHETIC_UPSTREAM_KEY', baseUrl: 'https://api.fixture.invalid/v1/responses' }),
      expect.objectContaining({ id: f.model.upstreamId, apiKey: 'SYNTHETIC_SECOND_KEY', baseUrl: 'https://second.invalid/v1/responses' }),
      expect.objectContaining({ id: 'subscription-alias', apiKey: 'SYNTHETIC_LOCAL_KEY' }),
    ]));
    expect(JSON.stringify(first)).not.toContain('NEVER_EXPORT');
    f.apply();
    const paths = Object.keys(first.profiles).map(name => join(dirname(f.targets.profilePath), name));
    expect(paths.every(existsSync)).toBe(true);
    f.binding.defaultModelId = 'second-model'; f.apply();
    expect(Object.keys(JSON.parse(f.preview().content).profiles)).toEqual(Object.keys(first.profiles));
    expect(f.read(f.targets.profilePath).apiKey).toBe('SYNTHETIC_SECOND_KEY');
    f.binding.providerIds = ['second']; f.apply();
    expect(paths.filter(existsSync)).toHaveLength(1);
    expect(f.read(paths.find(existsSync)!).apiKey).toBe('SYNTHETIC_SECOND_KEY');
    f.restore(); expect(paths.some(existsSync)).toBe(false);
  });

  it.each(['before', 'after'] as const)('rolls back every model profile on %s-write failure and protects external profile edits', failure => {
    const f = fixture(); f.models.push({ ...f.model, id: 'second-model', alias: 'second-alias' });
    const paths = Object.keys(JSON.parse(f.preview().content).profiles).map(name => join(dirname(f.targets.profilePath), name));
    if (failure === 'after') expect(() => f.apply({ afterFileCommit: index => { if (index === 3) throw new Error('PROFILE_FAILURE'); } })).toThrow('PROFILE_FAILURE');
    else { f.write(paths[0], { id: 'user-owned' }); expect(() => f.apply()).toThrow('不属于'); expect(f.read(paths[0])).toEqual({ id: 'user-owned' }); rmSync(paths[0]); }
    expect([...paths, ...Object.values(f.targets)].some(existsSync)).toBe(false);
    f.apply(); f.write(paths[0], { id: 'external-edit' });
    const files = [...paths, ...Object.values(f.targets)].map(path => readFileSync(path, 'utf8'));
    expect(() => f.restore()).toThrow('外部修改');
    expect([...paths, ...Object.values(f.targets)].map(path => readFileSync(path, 'utf8'))).toEqual(files);
  });

  it('upgrades and restores the original three-file ownership history without inventing model baselines', () => {
    const f = fixture(); f.apply();
    const key = junieHistoryKey(f.targets.configPath), previous = f.store.getManagedState<any>(key, null);
    for (const file of previous.profiles) rmSync(file.path);
    delete previous.profiles; previous.version = 1; f.states.set(key, previous);
    f.models.push({ ...f.model, id: 'new-model', alias: 'new-alias' }); f.apply();
    const next = f.store.getManagedState<any>(key, null);
    expect(next.version).toBe(2); expect(next.beforeModel).toEqual(previous.beforeModel);
    expect(next.profiles).toHaveLength(2); expect(next.profiles.every((file: any) => file.before === null)).toBe(true);
    f.restore(); expect(f.files()).toEqual([null, null, null]); expect(next.profiles.some((file: any) => existsSync(file.path))).toBe(false);
  });
  it('previews native Responses and a separate IDE ACP entry without reading credentials or writing files', () => {
    const f = fixture(), preview = f.preview(), value = JSON.parse(preview.content);
    expect(value.config).toEqual({ model: 'custom:modeldock' });
    expect(value.profile).toEqual({ id: 'native-model-id', baseUrl: 'https://api.fixture.invalid/v1/responses', apiType: 'OpenAIResponses', apiKey: '__PROVIDER_API_KEY__', displayName: 'Selected fixture model · ModelDock 默认', providerName: 'Fixture API', maxContextLength: 64000 });
    expect(value.acp).toEqual({ command: process.execPath, args: ['--acp', 'true', '--model', 'custom:modeldock'], env: { JUNIE_HOME: join(f.root, '.junie') } });
    expect(preview.canApply).toBe(true); expect(preview.instructions).toContain('全部所选模型分别写入');
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.files()).toEqual([null, null, null]); expect(f.states.size).toBe(0);
    expect(preview.content).not.toMatch(/SYNTHETIC_|aggregate-model-alias/);
  });

  it('uses full Chat endpoint URLs and omits an unknown context instead of inventing a budget', () => {
    const f = fixture(); f.model.wireApi = 'chat-completions'; f.model.contextWindow = 0;
    expect(JSON.parse(f.preview(true).content).profile).toEqual({ id: f.model.upstreamId, baseUrl: 'https://api.fixture.invalid/v1/chat/completions', apiType: 'OpenAICompletion', apiKey: 'SYNTHETIC_UPSTREAM_KEY', displayName: `${f.model.displayName} · ModelDock 默认`, providerName: f.provider.name });
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
    expect(JSON.parse(f.preview().content).profiles).toHaveProperty(Object.keys(JSON.parse(f.preview().content).profiles)[0]);
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

  it.each([1, 2, 3, 0])('rolls back files and ownership when committing file %s fails', index => {
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

  it.each([1, 2, 3, 0])('recovers an interrupted first transaction at file %s before reading the next restore baseline', index => {
    const f = fixture(); f.write(f.targets.configPath, { model: 'original', future: true }); f.apply();
    const journal = structuredClone(f.journals[0]) as any;
    journal.files.forEach((file: any) => { if (file.before === null) rmSync(file.path, { force: true }); else f.write(file.path, file.before); });
    for (const committed of journal.order) {
      f.write(journal.files[committed].path, journal.files[committed].after);
      if (committed === index) break;
    }
    f.states.set(junieHistoryKey(f.targets.configPath), journal); f.restore();
    expect(f.read(f.targets.configPath)).toEqual({ model: 'original', future: true });
    expect(existsSync(f.targets.profilePath)).toBe(false); expect(existsSync(f.targets.acpPath)).toBe(false);
    expect(f.store.getManagedState(junieHistoryKey(f.targets.configPath), null)).toBeNull();
  });

  it('keeps interrupted ownership pending and preserves every file if one target has an external edit', () => {
    const f = fixture(); f.apply(); const journal = structuredClone(f.journals[0]) as any;
    f.states.set(junieHistoryKey(f.targets.configPath), journal); f.write(f.targets.configPath, { model: 'external' });
    const before = f.files(); expect(() => f.restore()).toThrow('外部修改'); expect(f.files()).toEqual(before);
    expect(f.store.getManagedState(junieHistoryKey(f.targets.configPath), null)).toEqual(journal);
  });

  it.each(['before', 'after'] as const)('keeps a valid default/profile pair when the first crash-recovery write fails %s replacement', failure => {
    const f = fixture(); f.write(f.targets.configPath, { model: 'original', future: true }); f.apply();
    const journal = structuredClone(f.journals[0]) as any;
    expect(journal.order).toEqual([1, 2, 3, 0]); f.states.set(junieHistoryKey(f.targets.configPath), journal);
    const replace = privateFiles.replacePrivateFile, attempted: string[] = [];
    const spy = vi.spyOn(privateFiles, 'replacePrivateFile').mockImplementation((path, content) => {
      attempted.push(path);
      if (failure === 'after') replace(path, content);
      throw new Error('SYNTHETIC_FIRST_RECOVERY_WRITE_FAILURE');
    });
    try {
      expect(() => f.restore()).toThrow('SYNTHETIC_FIRST_RECOVERY_WRITE_FAILURE');
      expect(attempted).toEqual([f.targets.configPath]);
      expect(f.read(f.targets.configPath).model).toBe(failure === 'before' ? 'custom:modeldock' : 'original');
      expect(existsSync(f.targets.profilePath)).toBe(true); expect(existsSync(f.targets.acpPath)).toBe(true);
      expect(f.states.get(junieHistoryKey(f.targets.configPath))).toEqual(journal);
    } finally { spy.mockRestore(); }
    f.restore(); expect(f.read(f.targets.configPath)).toEqual({ model: 'original', future: true });
    expect(existsSync(f.targets.profilePath)).toBe(false); expect(existsSync(f.targets.acpPath)).toBe(false);
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
