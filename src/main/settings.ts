import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type AppSettings, type SettingsSnapshot, type TerminalOption } from '../shared/settings-types';
import { validateProxyUrl } from './network-proxy';

export interface SettingsStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
}
export interface LoginItemAdapter {
  getLoginItemSettings(options: { path: string; args: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean; launchItems?: { path: string; args: string[]; scope: 'user' | 'machine'; enabled: boolean }[] };
  setLoginItemSettings(options: { openAtLogin: boolean; path: string; args: string[]; enabled?: boolean }): void;
}
export interface SettingsManagerOptions {
  platform: NodeJS.Platform;
  homeDir: string;
  configHome?: string;
  execPath: string;
  isPackaged: boolean;
  login?: LoginItemAdapter;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}
interface LinuxAutostart { path: string; content: string }
interface StoredSettings { version: 1; settings: AppSettings; linuxAutostart?: LinuxAutostart }
const KEY = 'app.settings';
const FLAGS = ['--autostart'];
class SettingsFailure extends Error {}
const keys = new Set(Object.keys(DEFAULT_SETTINGS));
const terminals: Record<'win32' | 'linux' | 'other', TerminalOption[]> = {
  win32: [{ id: 'system', label: '系统默认（PowerShell）' }, { id: 'powershell', label: 'Windows PowerShell' }, { id: 'cmd', label: '命令提示符' }, { id: 'windows-terminal', label: 'Windows Terminal' }],
  linux: [{ id: 'system', label: '系统默认终端' }, { id: 'x-terminal-emulator', label: 'x-terminal-emulator' }, { id: 'gnome-terminal', label: 'GNOME Terminal' }, { id: 'konsole', label: 'Konsole' }],
  other: [],
};

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function validatePatch(value: unknown, platform: 'win32' | 'linux' | 'other', fromDisk = false): Partial<AppSettings> {
  if (!object(value) || Object.keys(value).some(key => !keys.has(key))) throw new Error('设置字段无效。');
  for (const [key, item] of Object.entries(value)) {
    if (key === 'theme') { if (!['system', 'light', 'dark'].includes(item as string)) throw new Error('主题选项无效。'); }
    else if (key === 'proxyUrl') { validateProxyUrl(item); }
    else if (key === 'terminal') {
      if (typeof item !== 'string' || !Object.values(terminals).flat().some(option => option.id === item)) throw new Error('终端选项无效。');
      if (!fromDisk && item !== 'system' && !terminals[platform].some(option => option.id === item)) throw new Error('当前系统不支持这个终端选项。');
    } else if (typeof item !== 'boolean') throw new Error('设置开关必须是布尔值。');
  }
  return { ...value, ...('proxyUrl' in value ? { proxyUrl: validateProxyUrl(value.proxyUrl) } : {}) } as Partial<AppSettings>;
}

/** Desktop Entry escaping is applied before Exec argument escaping; % must not become a field code. */
export function quoteDesktopExec(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('启动程序路径无效。');
  const command = path.replace(/%/g, '%%').replace(/[\\"`$]/g, character => `\\${character}`);
  return `"${command.replace(/\\/g, '\\\\')}"`;
}

export class SettingsManager {
  private readonly platform: 'win32' | 'linux' | 'other';
  private readonly autostartPath: string;
  private readonly spawn: NonNullable<SettingsManagerOptions['spawn']>;
  private state: StoredSettings;

  constructor(private readonly store: SettingsStore, private readonly options: SettingsManagerOptions) {
    this.platform = options.platform === 'win32' || options.platform === 'linux' ? options.platform : 'other';
    const config = options.configHome ?? join(options.homeDir, '.config');
    if (!isAbsolute(config)) throw new Error('配置目录必须是绝对路径。');
    this.autostartPath = join(config, 'autostart', 'modeldock.desktop');
    this.spawn = options.spawn ?? nodeSpawn;
    const stored = store.getManagedState<unknown>(KEY, { version: 1, settings: { ...DEFAULT_SETTINGS } });
    if (!object(stored) || stored.version !== 1 || Object.keys(stored).some(key => !['version', 'settings', 'linuxAutostart'].includes(key))) throw new Error('本地设置格式无效。');
    const settings = { ...DEFAULT_SETTINGS, ...validatePatch(stored.settings, this.platform, true) };
    if (!terminals[this.platform].some(option => option.id === settings.terminal)) settings.terminal = 'system';
    let linuxAutostart: LinuxAutostart | undefined;
    if (stored.linuxAutostart !== undefined) {
      if (!object(stored.linuxAutostart) || Object.keys(stored.linuxAutostart).some(key => !['path', 'content'].includes(key)) || typeof stored.linuxAutostart.path !== 'string' || typeof stored.linuxAutostart.content !== 'string' || stored.linuxAutostart.content.length > 16_384) throw new Error('本地启动记录格式无效。');
      linuxAutostart = { path: stored.linuxAutostart.path, content: stored.linuxAutostart.content };
    }
    this.state = { version: 1, settings, ...(linuxAutostart ? { linuxAutostart } : {}) };
  }

  private support(): string | undefined {
    if (!this.options.isPackaged) return '开发运行不设置开机自启，请使用打包后的应用。';
    if (this.platform === 'other') return '当前平台尚未支持开机自启。';
    if (this.platform === 'win32' && !this.options.login) return '当前运行环境未提供开机自启接口。';
    return undefined;
  }
  private loginOptions() { return { path: this.options.execPath, args: [...FLAGS] }; }
  private actualWindowsStartup(status: ReturnType<LoginItemAdapter['getLoginItemSettings']>): boolean {
    const path = this.options.execPath.replace(/\//g, '\\').toLowerCase();
    const items = status.launchItems?.filter(item => item.scope === 'user' && item.path.replace(/\//g, '\\').toLowerCase() === path && item.args.length === FLAGS.length && item.args.every((arg, index) => arg === FLAGS[index]));
    return status.openAtLogin && (items?.length ? items.some(item => item.enabled) : status.executableWillLaunchAtLogin ?? true);
  }
  private linuxFile(): string | undefined {
    if (!existsSync(this.autostartPath)) return undefined;
    const info = lstatSync(this.autostartPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new SettingsFailure('启动项由其他程序管理，已保留。');
    return readFileSync(this.autostartPath, 'utf8');
  }
  get(): SettingsSnapshot {
    let reason = this.support(), actual = false;
    if (!reason) {
      try {
        if (this.platform === 'win32') {
          const status = this.options.login!.getLoginItemSettings(this.loginOptions());
          actual = this.actualWindowsStartup(status);
          if (status.openAtLogin && !actual) reason = '启动项已登记，但被系统禁用；请在 Windows 启动应用设置中启用。';
        }
        else {
          const file = this.linuxFile(), owned = this.state.linuxAutostart;
          actual = file !== undefined && owned?.path === this.autostartPath && file === owned.content;
          if (file !== undefined && !actual) reason = '同名启动项未由 ModelDock 管理或已被修改。';
        }
      } catch { reason = '无法读取系统启动项状态。'; }
    }
    return { settings: { ...this.state.settings }, platform: this.platform, launchAtLoginSupported: !this.support(), actualLaunchAtLogin: actual, ...(reason ? { launchAtLoginReason: reason } : {}), terminalOptions: terminals[this.platform].map(option => ({ ...option })) };
  }

  private linuxContent(): string {
    return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=ModelDock\nComment=ModelDock local model manager\nExec=${quoteDesktopExec(this.options.execPath)} --autostart\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-ModelDock-Managed=true\n`;
  }
  private writeLinux(content: string, previous: string | undefined): void {
    const temp = `${this.autostartPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
      if (this.linuxFile() !== previous) throw new SettingsFailure('启动项在保存期间被修改，已保留。');
      if (previous === undefined) linkSync(temp, this.autostartPath);
      else renameSync(temp, this.autostartPath);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private changeAutostart(enabled: boolean, next: StoredSettings): () => void {
    const unsupported = this.support();
    if (unsupported) throw new SettingsFailure(unsupported);
    if (this.platform === 'win32') {
      const adapter = this.options.login!, opts = this.loginOptions();
      const previousStatus = adapter.getLoginItemSettings(opts);
      const previous = previousStatus.openAtLogin;
      const rollback = () => { adapter.setLoginItemSettings({ ...opts, openAtLogin: previous, enabled: this.actualWindowsStartup(previousStatus) }); };
      if (previous === enabled) return () => {};
      try {
        adapter.setLoginItemSettings({ ...opts, openAtLogin: enabled });
        if (adapter.getLoginItemSettings(opts).openAtLogin !== enabled) throw new Error('启动项设置未生效。');
      } catch {
        try { rollback(); } catch { throw new SettingsFailure('开机自启设置失败，原启动状态无法恢复，请检查系统启动项。'); }
        throw new SettingsFailure('开机自启设置失败，已恢复原启动状态。');
      }
      return rollback;
    }
    const old = this.linuxFile(), owned = this.state.linuxAutostart;
    if (old !== undefined && (owned?.path !== this.autostartPath || old !== owned.content)) throw new SettingsFailure('同名启动项未由 ModelDock 管理或已被修改，已保留。');
    const content = this.linuxContent();
    if (enabled) {
      if (old !== content) {
        mkdirSync(join(this.autostartPath, '..'), { recursive: true, mode: 0o700 });
        this.writeLinux(content, old);
      }
      next.linuxAutostart = { path: this.autostartPath, content };
    } else {
      if (old !== undefined) unlinkSync(this.autostartPath);
      delete next.linuxAutostart;
    }
    return () => {
      const current = this.linuxFile();
      if (enabled && current !== content || !enabled && current !== undefined) throw new Error('启动项在保存期间被修改。');
      if (old === undefined) { if (current !== undefined) unlinkSync(this.autostartPath); }
      else this.writeLinux(old, current);
    };
  }
  save(patch: Partial<AppSettings>): SettingsSnapshot {
    const validated = validatePatch(patch, this.platform);
    const previous = structuredClone(this.state), next = { ...structuredClone(this.state), settings: { ...this.state.settings, ...validated } };
    let rollback: (() => void) | undefined;
    let persistenceAttempted = false;
    try {
      if (Object.hasOwn(validated, 'launchAtLogin')) rollback = this.changeAutostart(next.settings.launchAtLogin, next);
      persistenceAttempted = true;
      this.store.setManagedState(KEY, next);
    } catch (error) {
      let restored = true;
      try { rollback?.(); } catch { restored = false; }
      // A database implementation may commit in memory before an on-disk write fails.
      if (persistenceAttempted) try { this.store.setManagedState(KEY, previous); } catch { /* The manager continues to expose the last saved settings. */ }
      if (!restored) throw new Error('设置保存失败，系统启动项无法恢复，请检查开机自启状态。');
      if (error instanceof SettingsFailure) throw error;
      throw new Error('设置保存失败，已保留原设置并恢复启动项。');
    }
    this.state = next;
    return this.get();
  }

  async openTerminal(dataDir: string): Promise<void> {
    if (!isAbsolute(dataDir) || /[\x00-\x1f\x7f]/.test(dataDir) || !existsSync(dataDir) || !lstatSync(dataDir).isDirectory()) throw new Error('终端工作目录无效。');
    const selected = this.state.settings.terminal;
    let command: string, args: string[];
    let windowsLauncher = false;
    if (this.platform === 'win32') {
      if (selected === 'windows-terminal') { command = 'wt.exe'; args = ['-d', resolve(dataDir)]; }
      else {
        // `start` creates the interactive child with its own console handles.
        // This command text is fixed; user paths are passed only via cwd.
        command = 'cmd.exe';
        args = ['/d', '/s', '/c', selected === 'cmd' ? 'start "" cmd.exe /d /k' : 'start "" powershell.exe -NoLogo -NoExit'];
        windowsLauncher = true;
      }
    } else if (this.platform === 'linux') {
      if (selected === 'gnome-terminal') { command = 'gnome-terminal'; args = ['--working-directory', resolve(dataDir)]; }
      else if (selected === 'konsole') { command = 'konsole'; args = ['--workdir', resolve(dataDir)]; }
      else { command = 'x-terminal-emulator'; args = []; }
    } else throw new Error('当前平台尚未支持打开终端。');
    await new Promise<void>((accept, reject) => {
      try {
        const child = this.spawn(command, args, { cwd: resolve(dataDir), shell: false, detached: !windowsLauncher, stdio: 'ignore', windowsHide: windowsLauncher });
        child.once('error', () => reject(new Error('终端无法启动，请确认所选终端已安装。')));
        if (windowsLauncher) child.once('exit', code => { if (code === 0) accept(); else reject(new Error('终端无法启动，请确认所选终端已安装。')); });
        else child.once('spawn', () => { child.unref(); accept(); });
      } catch { reject(new Error('终端无法启动，请确认所选终端已安装。')); }
    });
  }
}
