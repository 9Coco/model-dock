import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyJetBrainsConfig, buildJetBrainsConfig, jetBrainsStatus, restoreJetBrainsConfig, type JetBrainsConfigOptions } from '../src/main/jetbrains-config';
import { JETBRAINS_TOOLS, type JetBrainsToolId } from '../src/shared/jetbrains';
import type { Model, Provider, ToolBinding } from '../src/shared/types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(tool: JetBrainsToolId = 'rider') {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-air-guide-')); roots.push(root);
  const profileRoot = join(root, '.config', 'JetBrains'), cacheRoot = join(root, '.cache', 'JetBrains'), selector = `${JETBRAINS_TOOLS[tool].selectorPrefix}2026.2`;
  const target = join(profileRoot, selector), backups = join(root, 'backups');
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const paths = ['other.xml', 'llm.provider.openai.like.xml', 'llm.custom.models.xml', 'llm.next.edit.providers.xml'].map(name => join(target, 'options', name));
  for (const path of paths) write(path, '<application><component name="Unrelated"><option name="keep" value="yes" /></component></application>\n');
  const passwordSafe = join(target, 'c.kdbx'); write(passwordSafe, 'SYNTHETIC_PASSWORD_SAFE_BYTES'); write(join(cacheRoot, selector, '.pid'), '2147483646');
  const providers: Provider[] = [{ id: 'provider', name: 'Fixture', kind: 'openai-compatible', baseUrl: 'https://fixture.example.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' }];
  const models: Model[] = [{ id: 'chat', providerId: 'provider', upstreamId: 'native-chat', alias: 'local-chat', displayName: 'Fixture model', wireApi: 'chat-completions', enabled: true, contextWindow: 64000, tools: true, vision: false }];
  const binding: ToolBinding = { id: tool, name: JETBRAINS_TOOLS[tool].name, jetBrainsPlugin: 'air', enabled: true, mode: 'aggregate', providerIds: ['provider'], modelIds: [], modelSelection: 'all', defaultModelId: 'chat', note: '' };
  const store = { listBindings: () => [binding], listModels: () => models, listProviders: () => providers, getProvider: (id: string) => providers.find(provider => provider.id === id),
    getSecret: vi.fn(() => { throw new Error('Upstream credentials must not be read'); }), gatewayKey: vi.fn(() => 'SYNTHETIC_LOCAL_KEY'),
    getManagedState: vi.fn((): never => { throw new Error('Air must not read synchronization history'); }), setManagedState: vi.fn(), createManagedBackup: vi.fn(() => 'encrypted-backup.enc'),
  };
  const options: JetBrainsConfigOptions = { profileRoot, cacheRoot, platform: 'linux', processProbe: () => 'stopped', port: 19876 };
  const snapshot = () => [...paths, passwordSafe].map(path => readFileSync(path));
  return { root, target, tool, backups, paths, passwordSafe, store, binding, models, providers, options, snapshot };
}

describe('Air manual connection guide', () => {
  it.each(Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[])('provides a native manual setup guide for %s without creating invisible metadata or changing Assistant', tool => {
    const f = fixture(tool), before = f.snapshot();
    const status = jetBrainsStatus(tool, f.root, { ...f.options, plugin: 'air' });
    expect(status).toMatchObject({ plugin: 'air', foundProfile: true, running: 'stopped', canApply: false });
    expect(status.message).toContain('More Providers → OpenAI'); expect(status.message).toContain('未保存 Key 的账户不会显示');
    const preview = buildJetBrainsConfig(f.store, tool, 19876, false, f.root, f.options), data = JSON.parse(preview.content);
    expect(preview.canApply).toBe(false);
    expect(data).toMatchObject({ plugin: 'Air', provider: 'OpenAI', baseUrl: `http://127.0.0.1:19876/tool/${tool}/v1`, apiKey: '__MODELDOCK_LOCAL_KEY__', manualSetup: true, suggestedModel: 'local-chat' });
    expect(data).not.toHaveProperty('modelAssignment'); expect(data).not.toHaveProperty('completion'); expect(data).not.toHaveProperty('metadataOnly');
    expect(preview.instructions).toContain('More Providers → OpenAI'); expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.store.gatewayKey).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(before);
  });

  it.each(['stopped', 'running', 'unknown'] as const)('refuses Air apply and restore in %s state without touching IDE, password files, history or credentials', running => {
    const f = fixture(), before = f.snapshot(), options = { ...f.options, processProbe: () => running };
    expect(jetBrainsStatus(f.tool, f.root, { ...options, plugin: 'air' })).toMatchObject({ running, canApply: false });
    expect(() => applyJetBrainsConfig(f.store, f.tool, f.backups, f.root, options)).toThrow('不能离线同步或还原');
    expect(() => restoreJetBrainsConfig(f.store, f.tool, f.backups, f.root, options)).toThrow('不能离线同步或还原');
    expect(f.snapshot()).toEqual(before);
    expect(f.store.getManagedState).not.toHaveBeenCalled(); expect(f.store.setManagedState).not.toHaveBeenCalled(); expect(f.store.createManagedBackup).not.toHaveBeenCalled();
    expect(f.store.getSecret).not.toHaveBeenCalled(); expect(f.store.gatewayKey).not.toHaveBeenCalled();
  });

  it('does not inspect an existing account key or require Assistant XML compatibility for the Air guide', () => {
    const f = fixture(); writeFileSync(f.paths[0], '<application><component name="AirByokConfigurations"><![CDATA[{"entries":[{"id":"d4563f89-378a-45a3-b5da-13ea3c656db5","type":"openai","name":"User account","settings":[{"key":"baseUrl","value":"https://user.example.test/v1"}]}]}]]></component></application>');
    writeFileSync(f.paths[1], 'malformed Assistant XML'); const before = f.snapshot();
    expect(jetBrainsStatus(f.tool, f.root, { ...f.options, plugin: 'air' })).toMatchObject({ canApply: false, foundProfile: true });
    expect(buildJetBrainsConfig(f.store, f.tool, 19876, false, f.root, f.options).instructions).toContain('不读写该密码库');
    expect(f.snapshot()).toEqual(before); expect(f.store.getManagedState).not.toHaveBeenCalled(); expect(f.store.getSecret).not.toHaveBeenCalled();
  });

  it('shows manual instructions even before an IDE profile exists', () => {
    const f = fixture(); rmSync(f.target, { recursive: true }); const status = jetBrainsStatus(f.tool, f.root, { ...f.options, plugin: 'air' });
    expect(status).toMatchObject({ canApply: false, foundProfile: false }); expect(status.message).toContain('More Providers → OpenAI');
  });

  it('reveals the connection key only for an explicitly requested export', () => {
    const f = fixture(); expect(JSON.parse(buildJetBrainsConfig(f.store, f.tool, 19876, true, f.root, f.options).content).apiKey).toBe('SYNTHETIC_LOCAL_KEY'); expect(f.store.gatewayKey).toHaveBeenCalledTimes(1);
    f.binding.mode = 'direct'; f.store.getSecret.mockImplementation(() => ({ apiKey: 'SYNTHETIC_DIRECT_KEY' }) as never);
    const guide = JSON.parse(buildJetBrainsConfig(f.store, f.tool, 19876, true, f.root, f.options).content);
    expect(guide).toMatchObject({ baseUrl: 'https://fixture.example.test/v1', suggestedModel: 'native-chat', apiKey: 'SYNTHETIC_DIRECT_KEY', manualSetup: true });
  });
});
