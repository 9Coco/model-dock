import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
interface LinuxStartupFile { content: string; dev: number; ino: number }
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
    else if (key === 'gatewayPort') {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 1024 || item > 65535) throw new Error('本地服务端口必须是 1024 至 65535 之间的整数。');
    }
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
  private readonly legacyAutostartPath: string;
  private readonly spawn: NonNullable<SettingsManagerOptions['spawn']>;
  private state: StoredSettings;

  constructor(private readonly store: SettingsStore, private readonly options: SettingsManagerOptions) {
    this.platform = options.platform === 'win32' || options.platform === 'linux' ? options.platform : 'other';
    const config = options.configHome ?? join(options.homeDir, '.config');
    if (!isAbsolute(config)) throw new Error('配置目录必须是绝对路径。');
    // 修改点：与安装包启动器 desktop ID 一致，使 KDE 会话恢复能识别开机自启并去重。
    this.autostartPath = join(config, 'autostart', 'model-dock.desktop');
    this.legacyAutostartPath = join(config, 'autostart', 'modeldock.desktop');
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
  private linuxStartupFile(path: string): LinuxStartupFile | undefined {
    let info;
    try { info = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new SettingsFailure('启动项由其他程序管理，已保留。');
    // 修改点：不跟随符号链接，亦不把 dangling symlink 当作不存在的目标覆盖。
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 16_384) throw new SettingsFailure('启动项在读取期间被修改，已保留。');
      return { content: readFileSync(fd, 'utf8'), dev: opened.dev, ino: opened.ino };
    } finally { closeSync(fd); }
  }
  private linuxFile(): string | undefined { return this.linuxStartupFile(this.autostartPath)?.content; }

  /** 修改点：仅迁移旧版完整所有权记录，不在 constructor/get 中登记新的自启动。 */
  migrateLinuxAutostart(): boolean {
    const owned = this.state.linuxAutostart;
    if (this.platform !== 'linux' || this.support() || !this.state.settings.launchAtLogin || !owned || ![this.legacyAutostartPath, this.autostartPath].includes(owned.path)) return false;
    const content = this.linuxContent();
    if (owned.content !== content) return false;
    // 不以 .desktop 结尾：崩溃中间状态也不会成为第二份启用的启动项。
    const stagePath = `${this.legacyAutostartPath}.migration`;
    const same = (a: LinuxStartupFile | undefined, b: LinuxStartupFile | undefined) => a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino && a.content === b.content;
    const read = (path: string) => {
      const file = this.linuxStartupFile(path);
      if (file && file.content !== content) throw new SettingsFailure('旧版启动项或迁移目标已被修改，已保留。');
      return file;
    };
    const previous = structuredClone(this.state);
    let stage: LinuxStartupFile | undefined, mutationStarted = false, persistenceAttempted = false, committed = false;
    try {
      let old = read(this.legacyAutostartPath), target = read(this.autostartPath);
      stage = read(stagePath);
      if (old && target || old && stage && !same(old, stage) || target && stage && !same(target, stage)) throw new SettingsFailure('旧版启动项或迁移目标存在冲突，已保留。');
      if (!stage) {
        if (owned.path === this.autostartPath && !old) return false;
        if (!old || target || owned.path !== this.legacyAutostartPath) throw new SettingsFailure('旧版启动项迁移记录无法验证，已保留。');
        mutationStarted = true;
        linkSync(this.legacyAutostartPath, stagePath);
        stage = old;
        if (!same(read(stagePath), stage)) throw new SettingsFailure('旧版启动项在迁移期间被修改，已保留。');
      }
      mutationStarted = true;
      if (old) {
        if (!same(read(this.legacyAutostartPath), stage)) throw new SettingsFailure('旧版启动项在迁移期间被修改，已保留。');
        unlinkSync(this.legacyAutostartPath);
        old = undefined;
      }
      // link 的排他创建不覆盖任何现有目标；先移除旧 .desktop 再发布新入口。
      if (!target) { linkSync(stagePath, this.autostartPath); target = read(this.autostartPath); }
      if (!same(target, stage)) throw new SettingsFailure('启动项迁移目标在保存期间被修改，已保留。');
      const next = { ...structuredClone(this.state), linuxAutostart: { path: this.autostartPath, content } };
      if (owned.path !== this.autostartPath) {
        persistenceAttempted = true;
        this.store.setManagedState(KEY, next);
      }
      this.state = next;
      committed = true;
      if (!same(read(stagePath), target)) throw new SettingsFailure('启动项迁移暂存文件已被修改，已保留。');
      unlinkSync(stagePath);
      return true;
    } catch (error) {
      if (committed) throw new SettingsFailure('启动项已迁移，暂存文件未能清理；下次启动会重新检查。');
      if (!mutationStarted) {
        if (error instanceof SettingsFailure) throw error;
        throw new SettingsFailure('无法读取旧版启动项，已保留。');
      }
      let restored = true;
      try {
        if (stage) {
          const target = read(this.autostartPath);
          if (target) {
            if (!same(target, stage)) throw new Error('conflict');
            unlinkSync(this.autostartPath);
          }
          const old = read(this.legacyAutostartPath);
          if (!old) linkSync(stagePath, this.legacyAutostartPath);
          else if (!same(old, stage)) throw new Error('conflict');
        }
      } catch { restored = false; }
      let stored = !persistenceAttempted;
      if (persistenceAttempted) try { this.store.setManagedState(KEY, previous); stored = true; } catch { /* 保留暂存 ownership intent，下次可恢复。 */ }
      if (restored && stored && stage) try {
        if (!same(read(stagePath), stage)) throw new Error('conflict');
        unlinkSync(stagePath);
      } catch { restored = false; }
      if (!restored || !stored) throw new SettingsFailure('启动项迁移失败，已保留恢复记录；请检查开机自启状态。');
      if (error instanceof SettingsFailure) throw error;
      throw new SettingsFailure('启动项迁移失败，已保留原设置并恢复启动项。');
    }
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
          const owned = this.state.linuxAutostart;
          if (owned?.path === this.legacyAutostartPath) {
            const legacy = this.linuxStartupFile(this.legacyAutostartPath)?.content;
            actual = legacy !== undefined && legacy === owned.content;
            if (legacy !== undefined) reason = actual
              ? owned.content === this.linuxContent() ? '旧版开机启动项尚未完成安全迁移。' : '旧版启动项的程序路径与当前版本不同，已保留；可关闭旧启动项后重新启用。'
              : '旧版启动项已被修改，已保留。';
            try {
              if (this.linuxFile() !== undefined) reason = actual ? '旧版启动项仍启用；迁移目标存在冲突，已保留。' : '迁移目标未由 ModelDock 管理，已保留。';
            } catch { reason = actual ? '旧版启动项仍启用；无法安全读取迁移目标，已保留。' : '无法安全读取迁移目标，已保留。'; }
          } else {
            const file = this.linuxFile();
            actual = file !== undefined && owned?.path === this.autostartPath && file === owned.content;
            if (file !== undefined && !actual) reason = '同名启动项未由 ModelDock 管理或已被修改。';
          }
        }
      } catch { reason = '无法读取系统启动项状态。'; }
    }
    return { settings: { ...this.state.settings }, platform: this.platform, launchAtLoginSupported: !this.support(), actualLaunchAtLogin: actual, ...(reason ? { launchAtLoginReason: reason } : {}), terminalOptions: terminals[this.platform].map(option => ({ ...option })) };
  }

  private linuxContent(): string {
    return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=ModelDock\nComment=ModelDock local model manager\nExec=${quoteDesktopExec(this.options.execPath)} --autostart\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-ModelDock-Managed=true\n`;
  }
  private writeLinux(content: string, previous: string | undefined, path = this.autostartPath): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
      if (this.linuxStartupFile(path)?.content !== previous) throw new SettingsFailure('启动项在保存期间被修改，已保留。');
      if (previous === undefined) linkSync(temp, path);
      else renameSync(temp, path);
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
    const owned = this.state.linuxAutostart;
    // 修改点：迁移跳过或失败时，关闭仍须精确移除原来托管的旧入口，而非忽略它。
    const path = !enabled && owned?.path === this.legacyAutostartPath ? this.legacyAutostartPath : this.autostartPath;
    const old = this.linuxStartupFile(path)?.content;
    if (enabled && this.linuxStartupFile(this.legacyAutostartPath)) throw new SettingsFailure('旧版启动项未完成安全迁移，已保留。');
    if (old !== undefined && (owned?.path !== path || old !== owned.content)) throw new SettingsFailure('同名启动项未由 ModelDock 管理或已被修改，已保留。');
    const content = this.linuxContent();
    if (enabled) {
      if (old !== content) {
        mkdirSync(join(this.autostartPath, '..'), { recursive: true, mode: 0o700 });
        this.writeLinux(content, old);
      }
      next.linuxAutostart = { path: this.autostartPath, content };
    } else {
      if (old !== undefined) unlinkSync(path);
      delete next.linuxAutostart;
    }
    return () => {
      const current = this.linuxStartupFile(path)?.content;
      if (enabled && current !== content || !enabled && current !== undefined) throw new Error('启动项在保存期间被修改。');
      if (old === undefined) { if (current !== undefined) unlinkSync(path); }
      else this.writeLinux(old, current, path);
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
