import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { JETBRAINS_TOOLS, type JetBrainsToolId } from '../shared/jetbrains';

export interface WindowsJetBrainsProcess {
  pid: number; name: string; executablePath: string | null; startedAt: string | null;
  /** Only these public IDE flags leave the OS helper; command lines are never returned. */
  selector: string | null; customPaths: boolean;
  ideTool: JetBrainsToolId | null; isIdeJvm: boolean; commandReadable: boolean;
}
export interface WindowsJetBrainsProcessSnapshot { complete: boolean; processes: WindowsJetBrainsProcess[] }
interface Installation { root: string; selector: string; compatible: boolean; launcher: string; vmOptions: string | null; customPaths: boolean }
interface DetectionOptions {
  profileRoot: string; cacheRoot: string; candidates: string[]; home: string;
  installationRoots?: readonly string[];
  snapshot?: () => WindowsJetBrainsProcessSnapshot;
  refresh?: boolean;
}
interface Detection { selector?: string; running: 'running' | 'stopped' | 'unknown'; compatible: boolean; message?: string }
const launchers: Record<JetBrainsToolId, readonly string[]> = {
  webstorm: ['webstorm64.exe', 'webstorm.exe'], 'intellij-idea': ['idea64.exe', 'idea.exe'],
  rider: ['rider64.exe', 'rider.exe'], pycharm: ['pycharm64.exe', 'pycharm.exe'],
};
const codes: Record<JetBrainsToolId, readonly string[]> = { webstorm: ['WS'], 'intellij-idea': ['IU', 'IC'], rider: ['RD'], pycharm: ['PY', 'PC'] };
const environmentPrefixes: Record<JetBrainsToolId, readonly string[]> = { webstorm: ['WEBSTORM', 'WEBIDE'], 'intellij-idea': ['IDEA'], rider: ['RIDER'], pycharm: ['PYCHARM'] };
const normalized = (path: string) => resolve(path).replace(/[\\/]+$/, '').toLowerCase();
const inside = (path: string, root: string) => normalized(path).startsWith(normalized(root) + sep);
const knownSelector = (value: unknown): value is string => typeof value === 'string' && /^(?:WebStorm|IntelliJIdea|Rider|PyCharm)\d{4}\.\d+(?:\.\d+)?$/.test(value);
const maximumProcesses = 4096;

// One complete query covers all four products. Toolbox, backend and ETW services
// are deliberately excluded: their lifetime does not indicate an open IDE.
const processScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
try {
  $rows=@(Get-CimInstance -ClassName Win32_Process -Filter "Name='webstorm64.exe' OR Name='webstorm.exe' OR Name='idea64.exe' OR Name='idea.exe' OR Name='rider64.exe' OR Name='rider.exe' OR Name='pycharm64.exe' OR Name='pycharm.exe' OR Name='java.exe' OR Name='javaw.exe'" -Property ProcessId,Name,ExecutablePath,CreationDate,CommandLine)
  $public=@($rows | ForEach-Object {
    $selector=$null
    if ([string]$_.CommandLine -match '-Didea.paths.selector=(?:"([A-Za-z]+\d{4}\.\d+(?:\.\d+)?)"|([A-Za-z]+\d{4}\.\d+(?:\.\d+)?))') { $selector=if($Matches[1]){$Matches[1]}else{$Matches[2]} }
    $custom=[string]$_.CommandLine -match '(?:-D)?idea\.(?:config|system)\.path\s*='
    $ideTool=$null
    if ([string]$_.CommandLine -match '-Didea.platform.prefix=(?:"([^"\s]+)"|([^\s]+))') {
      $prefix=if($Matches[1]){$Matches[1]}else{$Matches[2]}
      $tools=@{Rider='rider';WebStorm='webstorm';Idea='intellij-idea';IdeaCommunity='intellij-idea';PyCharm='pycharm';PyCharmCore='pycharm'}
      if($tools.ContainsKey($prefix)){$ideTool=$tools[$prefix]}
    }
    $ideJvm=[string]$_.CommandLine -match '-Didea\.(?:paths.selector|platform.prefix|config.path|system.path)=|com\.intellij\.idea\.Main'
    $readable=-not [string]::IsNullOrWhiteSpace([string]$_.CommandLine)
    $started=if($null -eq $_.CreationDate){$null}else{$_.CreationDate.ToUniversalTime().ToString('o')}
    @{pid=[int64]$_.ProcessId;name=[string]$_.Name;executablePath=$_.ExecutablePath;startedAt=$started;selector=$selector;customPaths=[bool]$custom;ideTool=$ideTool;isIdeJvm=[bool]$ideJvm;commandReadable=[bool]$readable}
  })
  [Console]::Out.Write((@{complete=$true;processes=$public} | ConvertTo-Json -Depth 4 -Compress))
} catch { [Console]::Out.Write('{"complete":false,"processes":[]}'); exit 1 }
`;
let lastSnapshot: { at: number; value: WindowsJetBrainsProcessSnapshot } | undefined;

/** Read-only public process identity. A PID file is neither a running process
 * nor proof of shutdown, and stale PIDs may have been reused by another app. */
export function collectWindowsJetBrainsProcesses(refresh = false): WindowsJetBrainsProcessSnapshot {
  if (!refresh && lastSnapshot && Date.now() - lastSnapshot.at < 1500) return lastSnapshot.value;
  let value: WindowsJetBrainsProcessSnapshot = { complete: false, processes: [] };
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const raw = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processScript], {
      windowsHide: true, timeout: 4500, maxBuffer: 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (validSnapshot(parsed)) value = parsed;
  } catch { /* A failed/denied query must never imply shutdown. */ }
  lastSnapshot = { at: Date.now(), value }; return value;
}
function validSnapshot(value: unknown): value is WindowsJetBrainsProcessSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as WindowsJetBrainsProcessSnapshot;
  return snapshot.complete === true && Array.isArray(snapshot.processes) && snapshot.processes.length <= maximumProcesses
    && snapshot.processes.every(p => p && Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid <= 0xffffffff
      && typeof p.name === 'string' && (p.executablePath === null || typeof p.executablePath === 'string' && isAbsolute(p.executablePath))
      && (p.startedAt === null || typeof p.startedAt === 'string' && Number.isFinite(Date.parse(p.startedAt)))
      && (p.selector === null || knownSelector(p.selector)) && typeof p.customPaths === 'boolean'
      && (p.ideTool === null || Object.hasOwn(JETBRAINS_TOOLS, p.ideTool)) && typeof p.isIdeJvm === 'boolean' && typeof p.commandReadable === 'boolean');
}
function localChild(root: string, relative: unknown): string | null {
  if (typeof relative !== 'string' || !relative || isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(relative)) return null;
  const path = resolve(root, relative); return inside(path, root) ? path : null;
}
function installation(root: string, tool: JetBrainsToolId, read: (path: string) => string | null): Installation | null {
  const raw = read(join(root, 'product-info.json')); if (!raw) return null;
  const data: unknown = JSON.parse(raw); if (!data || typeof data !== 'object') return null;
  const info = data as Record<string, unknown>, prefix = JETBRAINS_TOOLS[tool].selectorPrefix;
  if (!codes[tool].includes(String(info.productCode)) || !knownSelector(info.dataDirectoryName) || !info.dataDirectoryName.startsWith(prefix) || !Array.isArray(info.launch)) return null;
  const launches = info.launch.filter(row => row && typeof row === 'object' && row.os === 'Windows');
  if (launches.length !== 1) return null;
  const launcher = localChild(root, launches[0].launcherPath); if (!launcher || !launchers[tool].includes(basename(launcher).toLowerCase()) || !existsSync(launcher)) return null;
  const vmOptions = localChild(root, launches[0].vmOptionsFilePath);
  return { root, selector: info.dataDirectoryName, launcher, vmOptions,
    customPaths: Array.isArray(launches[0].additionalJvmArguments) && launches[0].additionalJvmArguments.some((argument: unknown) => typeof argument === 'string' && hasOverride(argument, info.dataDirectoryName as string)),
    compatible: info.dataDirectoryName === `${prefix}2026.2` && typeof info.version === 'string' && /^2026\.2(?:\.|$)/.test(info.version)
      && typeof info.buildNumber === 'string' && /^(?:[A-Z]+-)?262\./.test(info.buildNumber) };
}
function children(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
  return readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory() && !row.isSymbolicLink()).map(row => join(root, row.name));
}
function discoverRoots(options: DetectionOptions, read: (path: string) => string | null): string[] {
  if (options.installationRoots) return [...options.installationRoots];
  const found: string[] = [];
  // .home is a public installation pointer. The product metadata, rather than
  // the old cache folder name or mtime, identifies the installation's profile.
  for (const selector of options.candidates) { const home = read(join(options.cacheRoot, selector, '.home'))?.trim(); if (home && isAbsolute(home)) found.push(home); }
  const local = options.home === process.env.USERPROFILE && process.env.LOCALAPPDATA || join(options.home, 'AppData', 'Local');
  const programRoots = [join(local, 'Programs'), ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((p): p is string => !!p).map(p => join(p, 'JetBrains'))];
  for (const root of programRoots) for (const child of children(root)) if (/^(?:WebStorm|IntelliJ IDEA|Rider|PyCharm)(?:\b|\d)/i.test(basename(child))) found.push(child);
  // Legacy Toolbox installs are apps/<product>/<channel>/<version>. Bound the
  // walk to that topology; never scan the drive or account/keystore files.
  const toolbox = join(local, 'JetBrains', 'Toolbox', 'apps');
  for (const product of children(toolbox)) if (/^(?:WebStorm|IDEA|Rider|PyCharm)/i.test(basename(product))) {
    found.push(product); for (const channel of children(product)) { found.push(channel); found.push(...children(channel)); }
  }
  return [...new Map(found.map(root => [normalized(root), root])).values()];
}
function hasOverride(text: string | null, selector: string) {
  if (!text) return false;
  if (/^\s*(?:-D)?idea\.(?:config|system)\.path(?:\s*[=:]|\s+\S)/m.test(text)) return true;
  return [...text.matchAll(/^\s*(?:-D)?idea\.paths\.selector\s*(?:[=:]\s*|\s+)([^\r\n]+)/gm)]
    .some(match => match[1].trim().replace(/^(["'])(.*)\1$/, '$2') !== selector);
}

/** Resolve an installed product's exact selector, then verify no matching
 * launcher/JBR process exists. Old profiles and stale PID files are harmless. */
export function detectWindowsJetBrainsProfile(tool: JetBrainsToolId, options: DetectionOptions, read: (path: string) => string | null): Detection {
  const base: Detection = { running: 'unknown', compatible: false };
  const installs: Installation[] = [];
  for (const root of discoverRoots(options, read)) {
    try { const item = installation(root, tool, read); if (item) installs.push(item); } catch { /* Ignore unrelated or malformed installation metadata. */ }
  }
  const selectors = [...new Set(installs.map(item => item.selector))];
  if (selectors.length !== 1) return { ...base, message: selectors.length ? '发现多个已安装版本使用不同配置，无法确认同步目标；请使用复制接入参数。' : '无法从已安装 IDE 的 product-info.json 确认当前配置；请使用复制接入参数。' };
  const selector = selectors[0], selected = installs.filter(item => item.selector === selector);
  if (!options.candidates.includes(selector)) return { ...base, message: '已安装 IDE 对应的用户配置尚未发现；请先启动该 IDE，再检查状态。' };
  const status = { ...base, selector, compatible: selected.every(item => item.compatible) };
  if (!status.compatible) return { ...status, message: '当前安装版本的配置结构尚未验证；请复制参数，在 IDE 设置中配置。' };
  try {
    const profile = join(options.profileRoot, selector);
    const externalStartupSettings = environmentPrefixes[tool].some(prefix => ['PROPERTIES', 'VM_OPTIONS'].some(suffix => !!process.env[`${prefix}_${suffix}`]?.trim()));
    if (externalStartupSettings || hasOverride(read(join(profile, 'idea.properties')), selector) || selected.some(item => item.customPaths || hasOverride(read(join(item.root, 'bin', 'idea.properties')), selector)
      || hasOverride(item.vmOptions ? read(item.vmOptions) : null, selector) || hasOverride(read(join(profile, `${basename(item.launcher)}.vmoptions`)), selector))) {
      return { ...status, message: 'IDE 使用自定义配置或缓存目录，无法安全确认同步路径；请使用复制接入参数。' };
    }
    const snapshot = options.snapshot?.() ?? collectWindowsJetBrainsProcesses(options.refresh);
    if (!validSnapshot(snapshot)) return { ...status, message: 'Windows 进程检测失败或权限不足，无法确认 IDE 已退出；请检查 IDE 状态或复制接入参数。' };
    let uncertain = false;
    for (const process of snapshot.processes) {
      const name = process.name.toLowerCase();
      const named = launchers[tool].includes(name), scopedSelector = process.selector?.startsWith(JETBRAINS_TOOLS[tool].selectorPrefix);
      const scopedJava = ['java.exe', 'javaw.exe'].includes(name) && process.executablePath && installs.some(item => inside(process.executablePath!, item.root));
      // Gradle/compiler daemons can keep using an installation's JBR after the
      // GUI exits. Its directory alone does not identify an IDE process.
      if (named || scopedSelector || scopedJava && process.isIdeJvm || process.ideTool === tool) return { ...status, running: 'running', message: 'IDE 进程仍在运行，请先自行退出 IDE 后刷新，再离线同步设置。' };
      // A Java process with hidden identity could own the profile. Access denied
      // is unavailable evidence, not evidence of absence.
      if (['java.exe', 'javaw.exe'].includes(name) && (!process.executablePath || !process.startedAt || !process.commandReadable || process.isIdeJvm && !process.ideTool && !process.selector)) uncertain = true;
    }
    return uncertain ? { ...status, message: '存在身份无法确认的 Java 进程，无法确认 IDE 已退出；请使用复制接入参数。' }
      : { ...status, running: 'stopped' };
  } catch { return { ...status, message: '配置路径或 Windows 进程检测不安全，离线同步已禁用；请使用复制接入参数。' }; }
}
