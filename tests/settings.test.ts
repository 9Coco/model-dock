import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { SettingsManager, quoteDesktopExec, type LoginItemAdapter, type SettingsStore } from '../src/main/settings';
import { DEFAULT_SETTINGS } from '../src/shared/settings-types';
import { Store } from '../src/main/store';

class MemoryStore implements SettingsStore {
  values = new Map<string, unknown>();
  writes = 0;
  fail = false;
  getManagedState<T>(key: string, fallback: T): T { return structuredClone(this.values.get(key) ?? fallback) as T; }
  setManagedState(key: string, value: unknown): void { this.writes++; if (this.fail) throw new Error('secret-should-never-surface'); this.values.set(key, structuredClone(value)); }
}
let fixture: string, store: MemoryStore;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'modeldock-settings-test-')); store = new MemoryStore(); });
afterEach(() => {
  const path = resolve(fixture), rel = relative(resolve(tmpdir()), path);
  if (!isAbsolute(rel) && !rel.startsWith('..' + sep) && rel !== '..' && path !== resolve(tmpdir()) && path.includes('modeldock-settings-test-')) rmSync(path, { recursive: true, force: true });
});
const linux = () => new SettingsManager(store, { platform: 'linux', homeDir: fixture, configHome: join(fixture, 'config'), execPath: join(fixture, 'My ModelDock.AppImage'), isPackaged: true });
const autostart = () => join(fixture, 'config', 'autostart', 'modeldock.desktop');
function windows(login: LoginItemAdapter, packaged = true) { return new SettingsManager(store, { platform: 'win32', homeDir: fixture, execPath: join(fixture, 'ModelDock.exe'), isPackaged: packaged, login }); }
function loginFixture() {
  let enabled = false;
  const adapter = { getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled })), setLoginItemSettings: vi.fn((options: { openAtLogin: boolean }) => { enabled = options.openAtLogin; }) };
  return adapter;
}

describe('application settings', () => {
  it('normalizes and persists a local proxy while retaining unrelated settings and OS startup state', () => {
    const login = loginFixture(), manager = windows(login);
    manager.save({ theme: 'dark', startHidden: true });
    const saved = manager.save({ proxyUrl: ' HTTP://LOCALHOST:20081/ ' });
    expect(saved.settings).toMatchObject({ proxyUrl: 'http://localhost:20081', theme: 'dark', startHidden: true });
    expect(windows(login).get().settings).toEqual(saved.settings);
    expect(login.setLoginItemSettings).not.toHaveBeenCalled();
    const writes = store.writes;
    expect(() => manager.save({ proxyUrl: 'http://remote.example:8080' })).toThrow('代理地址');
    expect(store.writes).toBe(writes);
    expect(manager.get().settings).toEqual(saved.settings);
    expect(manager.save({ proxyUrl: '' }).settings.proxyUrl).toBe('');
  });
  it('loads older settings as system networking without silently saving a new proxy', () => {
    const { proxyUrl: _proxy, ...older } = DEFAULT_SETTINGS;
    store.values.set('app.settings', { version: 1, settings: { ...older, theme: 'dark' } });
    expect(linux().get().settings).toMatchObject({ proxyUrl: '', theme: 'dark' });
    expect(store.writes).toBe(0);
  });
  it('keeps legacy startup behavior while merging gateway defaults without writing or changing OS startup', () => {
    const { autoStartGateway: _autoStartGateway, gatewayPort: _gatewayPort, ...older } = DEFAULT_SETTINGS;
    const legacy = { version: 1, settings: { ...older, theme: 'dark', launchAtLogin: true } };
    store.values.set('app.settings', legacy);
    const login = loginFixture();
    expect(windows(login).get().settings).toMatchObject({ theme: 'dark', launchAtLogin: true, autoStartGateway: false, gatewayPort: 18181 });
    expect(store.values.get('app.settings')).toEqual(legacy);
    expect(store.writes).toBe(0);
    expect(login.setLoginItemSettings).not.toHaveBeenCalled();
    expect(existsSync(autostart())).toBe(false);
  });
  it('persists gateway preferences independently of Windows and Linux login startup', () => {
    const login = loginFixture(), manager = windows(login);
    const saved = manager.save({ autoStartGateway: true, gatewayPort: 25000 });
    expect(windows(login).get().settings).toEqual(saved.settings);
    expect(saved.settings).toMatchObject({ autoStartGateway: true, gatewayPort: 25000, launchAtLogin: false });
    expect(login.setLoginItemSettings).not.toHaveBeenCalled();
    mkdirSync(join(autostart(), '..'), { recursive: true });
    writeFileSync(autostart(), 'foreign startup');
    expect(linux().save({ autoStartGateway: false, gatewayPort: 25001 }).settings).toMatchObject({ autoStartGateway: false, gatewayPort: 25001 });
    expect(readFileSync(autostart(), 'utf8')).toBe('foreign startup');
  });
  it('rejects invalid gateway ports and switches before persistence or OS startup changes', () => {
    const login = loginFixture(), manager = windows(login);
    for (const gatewayPort of [0, 1023, 65536, 18181.5, NaN, Infinity, '18181', null, undefined]) {
      expect(() => manager.save({ gatewayPort } as never)).toThrow('端口');
    }
    expect(() => manager.save({ autoStartGateway: 'true' } as never)).toThrow('布尔值');
    expect(store.writes).toBe(0);
    expect(login.setLoginItemSettings).not.toHaveBeenCalled();
    expect(manager.save({ gatewayPort: 1024 }).settings.gatewayPort).toBe(1024);
    expect(manager.save({ gatewayPort: 65535 }).settings.gatewayPort).toBe(65535);
    store.values.set('app.settings', { version: 1, settings: { ...DEFAULT_SETTINGS, gatewayPort: 1023 } });
    expect(() => windows(login)).toThrow('端口');
  });
  it('reads defaults without registering startup or creating OS files', () => {
    const login = loginFixture(), manager = windows(login);
    expect(manager.get().settings).toEqual(DEFAULT_SETTINGS);
    expect(login.setLoginItemSettings).not.toHaveBeenCalled();
    expect(store.writes).toBe(0);
    expect(linux().get().actualLaunchAtLogin).toBe(false);
    expect(existsSync(autostart())).toBe(false);
  });
  it('persists preferences and returns detached snapshots', () => {
    const manager = linux(), saved = manager.save({ theme: 'dark', startHidden: true, closeToTray: false, terminal: 'konsole' });
    expect(linux().get().settings).toEqual(saved.settings);
    saved.settings.theme = 'light'; saved.terminalOptions.splice(0);
    expect(manager.get().settings.theme).toBe('dark');
    expect(manager.get().terminalOptions.length).toBeGreaterThan(1);
    expect(existsSync(autostart())).toBe(false);
  });
  it('strictly rejects malformed, unknown and wrong-platform fields before side effects', () => {
    const manager = linux();
    for (const patch of [{ theme: 'blue' }, { startHidden: 'true' }, { launchAtLogin: 1 }, { closeToTray: null }, { terminal: 'cmd' }, { terminal: 'arbitrary-shell' }, { language: 'en' }, ['dark'], null]) expect(() => manager.save(patch as never)).toThrow();
    expect(store.writes).toBe(0);
    expect(existsSync(autostart())).toBe(false);
  });
  it('rejects corrupt persisted schema and resets a terminal moved across platforms', () => {
    store.values.set('app.settings', { version: 1, settings: { ...DEFAULT_SETTINGS, terminal: 'powershell' } });
    expect(linux().get().settings.terminal).toBe('system');
    store.values.set('app.settings', { version: 1, settings: { ...DEFAULT_SETTINGS, launchAtLogin: 'yes' } });
    expect(() => linux()).toThrow('布尔值');
  });
  it('reports development startup as unsupported while allowing appearance preferences', () => {
    const login = loginFixture(), manager = windows(login, false);
    expect(manager.get().launchAtLoginSupported).toBe(false);
    expect(manager.get().launchAtLoginReason).toContain('打包');
    expect(manager.save({ theme: 'system' }).settings.theme).toBe('system');
    expect(() => manager.save({ launchAtLogin: true })).toThrow('打包');
    expect(login.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('uses the stable Windows executable and fixed autostart arguments only on explicit changes', () => {
    const login = loginFixture(), manager = windows(login);
    manager.save({ launchAtLogin: true });
    expect(login.setLoginItemSettings).toHaveBeenCalledWith({ path: join(fixture, 'ModelDock.exe'), args: ['--autostart'], openAtLogin: true });
    const count = login.setLoginItemSettings.mock.calls.length;
    manager.save({ startHidden: true, theme: 'dark' });
    expect(login.setLoginItemSettings.mock.calls).toHaveLength(count);
    expect(manager.get().actualLaunchAtLogin).toBe(true);
    manager.save({ launchAtLogin: false });
    expect(manager.get().actualLaunchAtLogin).toBe(false);
  });
  it('reports a Task Manager disabled Windows startup item as inactive', () => {
    const login = loginFixture();
    login.getLoginItemSettings.mockImplementation(() => ({ openAtLogin: true, executableWillLaunchAtLogin: false }));
    expect(windows(login).get().actualLaunchAtLogin).toBe(false);
    expect(windows(login).get().launchAtLoginReason).toContain('禁用');
  });
  it('uses exact user-scope launch items instead of another enabled command line', () => {
    const login: LoginItemAdapter = {
      getLoginItemSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [
        { path: join(fixture, 'ModelDock.exe'), args: ['--autostart'], scope: 'user', enabled: false },
        { path: join(fixture, 'ModelDock.exe'), args: [], scope: 'user', enabled: true },
        { path: join(fixture, 'ModelDock.exe'), args: ['--autostart'], scope: 'machine', enabled: true },
      ] }), setLoginItemSettings: vi.fn(),
    };
    expect(windows(login).get().actualLaunchAtLogin).toBe(false);
  });
  it('rolls Windows startup back when persistence or registration fails without surfacing internal text', () => {
    const login = loginFixture(), manager = windows(login);
    store.fail = true;
    expect(() => manager.save({ launchAtLogin: true })).toThrow('恢复');
    expect(manager.get().settings.launchAtLogin).toBe(false);
    expect(manager.get().actualLaunchAtLogin).toBe(false);
    store.fail = false;
    let enabled = false;
    const broken: LoginItemAdapter = { getLoginItemSettings: () => ({ openAtLogin: enabled }), setLoginItemSettings: options => { enabled = options.openAtLogin; if (enabled) throw new Error('secret-should-never-surface'); } };
    expect(() => windows(broken).save({ launchAtLogin: true })).toThrow('恢复');
    expect(enabled).toBe(false);
  });
  it('does not re-enable a Task Manager disabled startup item during failure rollback', () => {
    let registered = true, approved = false;
    const login: LoginItemAdapter = {
      getLoginItemSettings: () => ({ openAtLogin: registered, executableWillLaunchAtLogin: approved }),
      setLoginItemSettings: value => { registered = value.openAtLogin; approved = value.enabled ?? value.openAtLogin; },
    };
    const manager = windows(login);
    store.fail = true;
    expect(() => manager.save({ launchAtLogin: false })).toThrow('恢复');
    expect(registered).toBe(true);
    expect(approved).toBe(false);
  });
  it('writes an owned Linux desktop entry and removes only that unchanged entry', () => {
    const manager = linux();
    manager.save({ launchAtLogin: true, startHidden: true });
    const content = readFileSync(autostart(), 'utf8');
    expect(content).toContain(' --autostart\n');
    expect(content).toContain('X-ModelDock-Managed=true');
    expect(manager.get().actualLaunchAtLogin).toBe(true);
    expect(linux().get().actualLaunchAtLogin).toBe(true);
    manager.save({ launchAtLogin: false });
    expect(existsSync(autostart())).toBe(false);
  });
  it('preserves unmanaged and modified Linux startup entries on enable and disable', () => {
    mkdirSync(join(autostart(), '..'), { recursive: true });
    writeFileSync(autostart(), 'foreign startup');
    const manager = linux();
    for (const launchAtLogin of [true, false]) expect(() => manager.save({ launchAtLogin })).toThrow('已保留');
    expect(readFileSync(autostart(), 'utf8')).toBe('foreign startup');
    rmSync(autostart()); manager.save({ launchAtLogin: true });
    writeFileSync(autostart(), 'modified startup');
    expect(() => manager.save({ launchAtLogin: false })).toThrow('已保留');
    expect(readFileSync(autostart(), 'utf8')).toBe('modified startup');
    expect(manager.get().actualLaunchAtLogin).toBe(false);
  });
  it('restores Linux startup after failed persistence on both enable and disable', () => {
    const manager = linux();
    store.fail = true;
    expect(() => manager.save({ launchAtLogin: true })).toThrow('恢复');
    expect(existsSync(autostart())).toBe(false);
    store.fail = false; manager.save({ launchAtLogin: true });
    const original = readFileSync(autostart(), 'utf8');
    store.fail = true;
    expect(() => manager.save({ launchAtLogin: false })).toThrow('恢复');
    expect(readFileSync(autostart(), 'utf8')).toBe(original);
    expect(manager.get().settings.launchAtLogin).toBe(true);
  });
  it('quotes desktop exec paths as one literal argument with percent field codes escaped', () => {
    const quoted = quoteDesktopExec('/opt/Model Dock/100%/a$`"\\file');
    expect(quoted).toBe('"/opt/Model Dock/100%%/a\\\\$\\\\`\\\\"\\\\\\\\file"');
    expect(() => quoteDesktopExec('/opt/evil\nExec=other')).toThrow();
    expect(() => quoteDesktopExec('relative')).toThrow();
  });
  it('opens terminals with argument arrays and a literal cwd, without a command shell', async () => {
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess; child.unref = vi.fn();
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); });
      return child;
    };
    const dataDir = join(fixture, 'data & $()'); mkdirSync(dataDir);
    const manager = new SettingsManager(store, { platform: 'win32', homeDir: fixture, execPath: 'C:\\ModelDock.exe', isPackaged: true, login: loginFixture(), spawn });
    manager.save({ terminal: 'cmd' }); await manager.openTerminal(dataDir);
    expect(calls[0]).toMatchObject({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" cmd.exe /d /k'], options: { cwd: resolve(dataDir), shell: false, detached: false, windowsHide: true } });
    manager.save({ terminal: 'powershell' }); await manager.openTerminal(dataDir);
    expect(calls[1].args).toEqual(['/d', '/s', '/c', 'start "" powershell.exe -NoLogo -NoExit']);
    manager.save({ terminal: 'windows-terminal' }); await manager.openTerminal(dataDir);
    expect(calls[2].args).toEqual(['-d', resolve(dataDir)]);
    expect(calls[2].options).toMatchObject({ shell: false, detached: true, windowsHide: false });
    expect(() => manager.save({ terminal: 'gnome-terminal' })).toThrow();
  });
  it('waits for the hidden Windows terminal launcher and rejects a failed exit', async () => {
    const child = new EventEmitter() as ChildProcess; child.unref = vi.fn();
    const manager = new SettingsManager(store, { platform: 'win32', homeDir: fixture, execPath: 'C:\\ModelDock.exe', isPackaged: true, login: loginFixture(), spawn: () => child });
    let settled = false;
    const opened = manager.openTerminal(fixture);
    void opened.then(() => { settled = true; }, () => { settled = true; });
    child.emit('spawn'); await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('exit', 1);
    await expect(opened).rejects.toThrow('终端无法启动');
  });
  it('normalizes terminal spawn failures without exposing child process details', async () => {
    const spawn = () => { const child = new EventEmitter() as ChildProcess; queueMicrotask(() => child.emit('error', new Error('credential-should-never-surface'))); return child; };
    const manager = new SettingsManager(store, { platform: 'linux', homeDir: fixture, execPath: '/opt/ModelDock', isPackaged: true, spawn });
    await expect(manager.openTerminal(fixture)).rejects.toThrow('终端无法启动');
    await expect(manager.openTerminal('relative')).rejects.toThrow('工作目录');
  });
  it('stores settings using the encrypted managed-state codec and survives reopening SQLite', async () => {
    const directory = join(fixture, 'sqlite');
    const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };
    const database = await Store.create(directory, codec);
    const options = { platform: 'linux' as const, homeDir: fixture, execPath: '/opt/ModelDock', isPackaged: true };
    new SettingsManager(database, options).save({ theme: 'dark', startHidden: true, autoStartGateway: true, gatewayPort: 25000 });
    database.close();
    expect(readFileSync(join(directory, 'modeldock.sqlite')).includes(Buffer.from('"theme":"dark"'))).toBe(false);
    const reopened = await Store.create(directory, codec);
    expect(new SettingsManager(reopened, options).get().settings).toMatchObject({ theme: 'dark', startHidden: true, autoStartGateway: true, gatewayPort: 25000 });
    expect(existsSync(join(fixture, '.config', 'autostart', 'modeldock.desktop'))).toBe(false);
    reopened.close();
  });
});
