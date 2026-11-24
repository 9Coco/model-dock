import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { applyVsCodeFiles, discoverVsCodeProxy, recoverVsCodeConfig, vsCodeConfigTargets, vsCodeHistoryKey, vsCodeProxyInstructions, type VsCodeHistoryStore } from '../src/main/vscode-config';

// File ACL behavior has its own native tests. Keep these transaction/ownership
// cases independent of Windows ACL subprocess timing.
vi.mock('../src/main/private-file', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/private-file')>(),
  replacePrivateFile: (path: string, content: string | null) => {
    if (content === null) { if (existsSync(path)) unlinkSync(path); }
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  },
}));
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(original?: string) {
  const appData = mkdtempSync(join(tmpdir(), 'modeldock-vscode-proxy-')); roots.push(appData);
  const targets = vsCodeConfigTargets(appData), states = new Map<string, unknown>();
  const write = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  if (original !== undefined) write(targets.settingsPath, original);
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null;
  const store: VsCodeHistoryStore = {
    getManagedState: <T>(key: string, fallback: T): T => structuredClone(states.has(key) ? states.get(key) as T : fallback),
    setManagedState: vi.fn((key: string, value: unknown) => { states.set(key, structuredClone(value)); }),
    createManagedBackup: vi.fn(() => 'encrypted-test-backup'),
  };
  const proxy = { eligible: true, proxyUrl: 'http://127.0.0.1:19876' };
  const apply = (plan = proxy) => applyVsCodeFiles(store, appData, read(targets.modelsPath), '[{"models":[]}]', { proxy: plan });
  return { appData, ...targets, states, store, proxy, read, write, apply, key: vsCodeHistoryKey(targets.modelsPath) };
}
const urls = ['https://api.example.test/v1/responses'];
const env = { NO_PROXY: 'localhost,127.0.0.1,::1' };

describe('VS Code no-proxy-only system proxy discovery', () => {
  it('uses all exact inference URLs and accepts one consistent dynamic loopback proxy', async () => {
    const f = fixture(), resolve = vi.fn(async (_url: string) => 'PROXY 127.0.0.1:19876');
    const targets = [...urls, 'https://api.example.test/v1/chat/completions'];
    expect(await discoverVsCodeProxy(f.appData, targets, 18181, env, resolve)).toEqual(f.proxy);
    expect(resolve.mock.calls.map(call => call[0])).toEqual(targets);
    expect(f.read(f.settingsPath)).toBeNull(); expect(f.store.setManagedState).not.toHaveBeenCalled();
  });
  it('honors a nonempty settings bypass list and recognizes ALL_PROXY does not configure VS Code Electron', async () => {
    const f = fixture('{"http.noProxy":[" localhost ","127.0.0.1"]}');
    expect(await discoverVsCodeProxy(f.appData, urls, 18181, { ALL_PROXY: 'socks5://127.0.0.1:1080' }, async () => 'PROXY 127.0.0.1:19876')).toEqual(f.proxy);
    expect(await discoverVsCodeProxy(f.appData, urls, 18181, { ...env, all_proxy: 'socks5://127.0.0.1:1080' }, async () => 'PROXY 127.0.0.1:19876')).toEqual(f.proxy);
  });
  it.each(['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'])('leaves configured %s networking alone', async name => {
    const f = fixture(), resolve = vi.fn();
    expect(await discoverVsCodeProxy(f.appData, urls, 18181, { ...env, [name]: 'http://127.0.0.1:19000' }, resolve)).toEqual({ eligible: false });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('matches upstream environment precedence before trimming the chosen value', async () => {
    const f = fixture();
    expect(await discoverVsCodeProxy(f.appData, urls, 18181, { ...env, https_proxy: ' ', HTTP_PROXY: 'http://127.0.0.1:19000' },
      async () => 'PROXY 127.0.0.1:19876')).toEqual(f.proxy);
  });
  it.each([undefined, '{"http.proxySupport":"off"}'])('does not add a workaround without its trigger or when explicitly disabled', async original => {
    const f = fixture(original), resolve = vi.fn();
    expect(await discoverVsCodeProxy(f.appData, urls, 18181, original ? env : {}, resolve)).toEqual({ eligible: false });
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each(['DIRECT', 'PROXY 127.0.0.1:19876; DIRECT', 'PROXY 127.0.0.1:19876; PROXY 127.0.0.1:19877', 'SOCKS5 127.0.0.1:1080',
    'PROXY remote.example:19876', 'PROXY user:password@127.0.0.1:19876', 'PROXY 127.0.0.1:18181'])('does not flatten unsupported or unsafe system policy %s', async rules => {
    const f = fixture();
    expect(await discoverVsCodeProxy(f.appData, urls, 18181, env, async () => rules)).toEqual({ eligible: true });
  });
  it('preserves path-sensitive PAC results instead of picking a proxy for a different route', async () => {
    const f = fixture();
    expect(await discoverVsCodeProxy(f.appData, [...urls, 'https://api.example.test/v1/chat/completions'], 18181, env,
      async url => url.endsWith('responses') ? 'PROXY 127.0.0.1:19876' : 'DIRECT')).toEqual({ eligible: true });
  });
  it('bounds slow system PAC discovery without changing settings', async () => {
    vi.useFakeTimers(); const f = fixture();
    const task = discoverVsCodeProxy(f.appData, urls, 18181, env, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await task).toEqual({ eligible: true }); expect(f.read(f.settingsPath)).toBeNull();
  });
  it('rejects duplicate or invalid proxy fields without changing settings', async () => {
    for (const original of ['{"http.proxy":"","http.proxy":"other"}', '{"http.noProxy":false}', '[1,2]']) {
      const f = fixture(original);
      await expect(discoverVsCodeProxy(f.appData, urls, 18181, env, async () => '')).rejects.toThrow('VS Code');
      expect(f.read(f.settingsPath)).toBe(original);
    }
  });
});

describe('VS Code proxy field ownership and shared file transaction', () => {
  it('preserves existing user proxy, explicit off, TLS and bypass settings', () => {
    for (const original of ['{"http.proxy":"http://user-proxy.test:8080","http.proxyStrictSSL":false}', '{"http.proxySupport":"off","http.noProxy":["localhost"]}']) {
      const f = fixture(original); f.apply(); expect(f.read(f.settingsPath)).toBe(original);
      expect(f.store.getManagedState(f.key, null)).toBeNull();
    }
  });
  it('restores an originally empty field while preserving all comments and unrelated settings', () => {
    const f = fixture('{\n// keep global note\n"editor.fontSize":14,\n// keep proxy note\n"http.proxy":"",\n"http.noProxy":["localhost"]\n}');
    f.apply();
    expect(parseJsonc(f.read(f.settingsPath)!)).toMatchObject({ 'http.proxy': f.proxy.proxyUrl, 'http.noProxy': ['localhost'], 'editor.fontSize': 14 });
    f.apply({ eligible: false, proxyUrl: '' });
    const restored = f.read(f.settingsPath)!;
    expect(restored).toContain('// keep global note'); expect(restored).toContain('// keep proxy note');
    expect(parseJsonc(restored)['http.proxy']).toBe('');
  });
  it('retains comments added next to a managed field during official removal', () => {
    const f = fixture('{"other":1}'); f.apply();
    f.write(f.settingsPath, `{\n"other":1,\n// keep user proxy note\n"http.proxy":"${f.proxy.proxyUrl}"\n}`);
    applyVsCodeFiles(f.store, f.appData, f.read(f.modelsPath), '[]', { release: true });
    expect(f.read(f.settingsPath)).toContain('// keep user proxy note');
    expect(parseJsonc(f.read(f.settingsPath)!)).toEqual({ other: 1 });
  });
  it.each(['deleted', 'empty', 'different'])('respects %s user override across repeated syncs, then releases history on restore', mode => {
    const f = fixture('{}'); f.apply();
    const changed = mode === 'deleted' ? '{"keep":true}' : JSON.stringify({ keep: true, 'http.proxy': mode === 'empty' ? '' : 'http://127.0.0.1:19000' });
    f.write(f.settingsPath, changed); f.apply(); f.apply();
    expect(f.read(f.settingsPath)).toBe(changed);
    expect(f.store.getManagedState(f.key, null)).toMatchObject({ proxyOverride: true });
    applyVsCodeFiles(f.store, f.appData, f.read(f.modelsPath), '[]', { release: true });
    expect(f.read(f.settingsPath)).toBe(changed); expect(f.store.getManagedState(f.key, null)).toBeNull();
  });
  it('does not create settings when unnecessary, and removes its own empty newly created settings on release', () => {
    const f = fixture(); f.apply({ eligible: false, proxyUrl: '' }); expect(f.read(f.settingsPath)).toBeNull();
    f.apply(); expect(f.read(f.settingsPath)).toContain('http.proxy');
    f.apply({ eligible: false, proxyUrl: '' }); expect(f.read(f.settingsPath)).toBeNull();
  });
  it('rolls back both files and ownership if the second file commit fails', () => {
    const f = fixture('{"keep":true}'); f.write(f.modelsPath, '[]');
    expect(() => applyVsCodeFiles(f.store, f.appData, '[]', '[{"models":[]}]', {
      proxy: f.proxy, afterFileCommit: index => { if (index === 1) throw new Error('injected failure'); },
    })).toThrow('injected failure');
    expect(f.read(f.modelsPath)).toBe('[]'); expect(f.read(f.settingsPath)).toBe('{"keep":true}');
    expect(f.store.getManagedState(f.key, null)).toBeNull();
  });
  it('recovers a crash journal only on an explicit recovery call, never on preview', () => {
    const f = fixture('{"keep":true}'); f.write(f.modelsPath, '[{"partiallyWritten":true}]');
    const pending = { modeldockPending: 1, previous: null, next: null, order: [0, 1], files: [
      { path: f.modelsPath, before: '[]', after: '[{"partiallyWritten":true}]' },
      { path: f.settingsPath, before: '{"keep":true}', after: '{"keep":true}' },
    ] };
    f.states.set(f.key, pending);
    expect(vsCodeProxyInstructions(f.store, f.appData, f.proxy)).toContain('未完成');
    expect(f.read(f.modelsPath)).toContain('partiallyWritten'); expect(f.store.setManagedState).not.toHaveBeenCalled();
    recoverVsCodeConfig(f.store, f.appData);
    expect(f.read(f.modelsPath)).toBe('[]'); expect(f.store.getManagedState(f.key, null)).toBeNull();
  });
  it('refuses concurrent external writes before committing model or proxy settings', () => {
    const f = fixture('{}'); f.write(f.modelsPath, '[]');
    expect(() => applyVsCodeFiles(f.store, f.appData, '[]', '[{"models":[]}]', { proxy: f.proxy, beforeCommit: () => f.write(f.settingsPath, '{"external":true}') })).toThrow('其他程序修改');
    expect(f.read(f.modelsPath)).toBe('[]'); expect(f.read(f.settingsPath)).toBe('{"external":true}');
  });
});
