import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DshProfileModelPlugin { id: string; name: string }
export interface DshProfileMetadata {
  version: 1;
  profileName: 'desktop' | 'web' | 'acp';
  runtimeVersion: string;
  modelPlugins: DshProfileModelPlugin[];
  /** Lower bundle and profile layers only; home overrides are owned by dsh-config. */
  baselineProviders: Record<string, unknown>;
}
export interface DshProfileWorkerRequest { home: string; profileName: DshProfileMetadata['profileName']; installAnchor: string }
export interface DshProfileResolveOptions {
  /** Private test seams; no renderer can select a native executable or module. */
  runWorker?: (request: DshProfileWorkerRequest) => Promise<unknown>;
  installationAnchors?: string[];
  desktopExecutables?: string[];
  platform?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  workerPath?: string;
}
type Failure = 'home' | 'profile' | 'runtime' | 'worker' | 'timeout' | 'protocol' | 'unsafe-baseline';
const messages: Record<Failure, string> = {
  home: 'DSH 数据目录无效，未修改配置。',
  profile: '无法完整解析 DSH 原生 profile 的模型来源，未修改配置；请先启动一次 DSH 后重试。',
  runtime: '未找到可读取的 DSH 原生运行时，未修改配置；请安装或启动 DSH 后重试。',
  worker: '读取 DSH 原生模型来源失败，未修改配置。',
  timeout: '读取 DSH 原生模型来源超时，未修改配置。',
  protocol: 'DSH 原生模型来源信息格式无效，未修改配置。',
  'unsafe-baseline': 'DSH 原模型配置包含无法安全保留的内联认证或动态配置，未修改配置。',
};
export class DshProfileError extends Error {
  constructor(readonly category: Failure) { super(messages[category]); this.name = 'DshProfileError'; }
}
const allowedPluginNames = new Set([
  '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account',
]);
const maxBytes = 1024 * 1024;
const text = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function fail(category: Failure): never { throw new DshProfileError(category); }
const providerFields = new Set(['apiKeyEnv', 'displayName', 'api', 'baseURL', 'models', 'modelOverrides', 'compat', 'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'headers', 'reasoning', 'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes', 'retryPolicy']);
const modelFields = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']);

function safeJson(value: unknown, depth = 0): unknown {
  if (depth > 12) fail('unsafe-baseline');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('unsafe-baseline'); return value; }
  if (typeof value === 'string') {
    if (value.length > 4096 || /[\x00\r\n]/.test(value) || /\bBearer\s+\S|\bsk-[A-Za-z0-9_-]{16,}/i.test(value)) fail('unsafe-baseline');
    return value;
  }
  if (Array.isArray(value)) { if (value.length > 2000) fail('unsafe-baseline'); return value.map((entry) => safeJson(entry, depth + 1)); }
  if (!object(value) || Object.keys(value).length > 2000) fail('unsafe-baseline');
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!text(key) || ['__proto__', 'prototype', 'constructor'].includes(key)
      || /secret|password|authorization|cookie|credential|^(?:api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)) fail('unsafe-baseline');
    result[key] = safeJson(entry, depth + 1);
  }
  return result;
}

/** Copy only native non-secret provider fields. Reject lossy or dynamic preservation. */
export function sanitizeDshBaselineProviders(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!object(value) || Object.keys(value).length > 1000) fail('unsafe-baseline');
  const result: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(value)) {
    if (!text(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || !object(provider)) fail('unsafe-baseline');
    for (const [key, field] of Object.entries(provider)) {
      if (!providerFields.has(key)) fail('unsafe-baseline');
      if (key === 'headers' && field !== null && (!object(field) || Object.keys(field).length > 0)) fail('unsafe-baseline');
      if (key === 'apiKeyEnv' && field !== null && (typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) fail('unsafe-baseline');
      if (key === 'baseURL' && field !== null) {
        if (!text(field, 2048)) fail('unsafe-baseline');
        let url: URL; try { url = new URL(field); } catch { fail('unsafe-baseline'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('unsafe-baseline');
      }
      if (key === 'models' && field !== null) {
        if (!Array.isArray(field) || field.some((model) => !object(model) || Object.keys(model).some((name) => !modelFields.has(name)))) fail('unsafe-baseline');
      }
      if (key === 'modelOverrides' && field !== null) {
        if (!object(field) || Object.values(field).some((model) => !object(model) || Object.keys(model).some((name) => !modelFields.has(name)))) fail('unsafe-baseline');
      }
    }
    result[id] = safeJson(provider);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('unsafe-baseline');
  return result;
}

export function validateDshProfileMetadata(value: unknown): DshProfileMetadata {
  if (!object(value) || value.version !== 1 || !['desktop', 'web', 'acp'].includes(String(value.profileName))
    || !text(value.runtimeVersion, 80) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.runtimeVersion)
    || !Array.isArray(value.modelPlugins) || value.modelPlugins.length > 2000
    || Object.keys(value).some((key) => !['version', 'profileName', 'runtimeVersion', 'modelPlugins', 'baselineProviders'].includes(key))) fail('protocol');
  const ids = new Set<string>();
  const modelPlugins = value.modelPlugins.map((entry) => {
    if (!object(entry) || Object.keys(entry).some((key) => !['id', 'name'].includes(key)) || !text(entry.id, 160) || !text(entry.name)
      || ['__proto__', 'prototype', 'constructor'].includes(entry.id) || !allowedPluginNames.has(entry.name) || ids.has(entry.id)) fail('protocol');
    ids.add(entry.id); return { id: entry.id, name: entry.name };
  });
  if (!modelPlugins.some(({ id, name }) => id === 'llm-pi-ai' && name === '@deepseek-ai/dsh-llm-pi-ai')) fail('profile');
  const baselineProviders = sanitizeDshBaselineProviders(value.baselineProviders);
  const result = { version: 1 as const, profileName: value.profileName as DshProfileMetadata['profileName'], runtimeVersion: value.runtimeVersion, modelPlugins, baselineProviders };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('protocol'); return result;
}

function readManifest(path: string): Record<string, unknown> | undefined {
  try { if (!statSync(path).isFile() || statSync(path).size > 2 * maxBytes) return; const value = JSON.parse(readFileSync(path, 'utf8')); return object(value) ? value : undefined; } catch { return; }
}
function nativeAnchor(path: string): boolean {
  const manifest = readManifest(path); return manifest?.name === '@deepseek-ai/dsh' && text(manifest.version, 80);
}
function selectedProfile(home: string): DshProfileMetadata['profileName'] {
  for (const name of ['desktop', 'web', 'acp'] as const) {
    const filename = join(home, 'profiles', name, 'package.json');
    const manifest = readManifest(filename);
    if (manifest && object(manifest.dsh) && object(manifest.dsh.profile) && Array.isArray(manifest.dsh.profile.bundles)) return name;
    if (existsSync(filename)) fail('profile');
  }
  fail('profile');
}

async function desktopExecutables(): Promise<string[]> {
  const command = String.raw`$ErrorActionPreference='SilentlyContinue'; $paths=@(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select-Object -ExpandProperty ExecutablePath); foreach($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) { foreach($key in Get-ChildItem -LiteralPath $root) { $app=Get-ItemProperty -LiteralPath $key.PSPath; if($app.DisplayName -eq 'DeepSeek Harness') { if($app.InstallLocation) {$paths+=Join-Path $app.InstallLocation 'DeepSeek Harness.exe'}; if($app.DisplayIcon) {$paths+=[regex]::Replace([string]$app.DisplayIcon,'^"?(.*?)"?(,\d+)?$','$1')} } } }; ConvertTo-Json -InputObject @($paths | Where-Object {$_} | Select-Object -Unique) -Compress`;
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 3000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error) { done([]); return; }
      try { const value = JSON.parse(stdout.trim()); done(Array.isArray(value) ? value.filter((entry): entry is string => text(entry, 4096) && isAbsolute(entry)) : []); } catch { done([]); }
    });
  });
}

async function installationAnchors(profile: DshProfileMetadata['profileName'], options: DshProfileResolveOptions): Promise<string[]> {
  if (options.installationAnchors) return [...new Set(options.installationAnchors)].filter((path) => isAbsolute(path) && nativeAnchor(path));
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const candidates: string[] = [];
  if (platform === 'win32') {
    const executableRoots = (options.desktopExecutables ?? (profile === 'desktop' ? await desktopExecutables() : [])).map(dirname);
    if (env.LOCALAPPDATA) executableRoots.push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
    if (env.ProgramFiles) executableRoots.push(join(env.ProgramFiles, 'DeepSeek Harness'));
    if (env['ProgramFiles(x86)']) executableRoots.push(join(env['ProgramFiles(x86)'], 'DeepSeek Harness'));
    const desktopAnchors = [...new Set(executableRoots)].flatMap((root) => [
      join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      join(root, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ]);
    const npmAnchors = env.APPDATA ? [join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')] : [];
    candidates.push(...(profile === 'desktop' ? [...desktopAnchors, ...npmAnchors] : [...npmAnchors, ...desktopAnchors]));
  } else {
    candidates.push(...['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.local', 'lib', 'node_modules'), join(homedir(), '.npm-global', 'lib', 'node_modules')].map((root) => join(root, '@deepseek-ai', 'dsh', 'package.json')));
  }
  return [...new Set(candidates)].filter(nativeAnchor);
}

function runWorker(request: DshProfileWorkerRequest, options: DshProfileResolveOptions): Promise<unknown> {
  const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const workerPath = options.workerPath ?? join(here, 'dsh-profile-worker.cjs');
  if (!existsSync(workerPath)) fail('runtime');
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', DSH_HOME: request.home, NODE_NO_WARNINGS: '1' };
  for (const key of Object.keys(env)) if (/token|password|secret|api[_-]?key|auth|cookie|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)) delete env[key];
  return new Promise((done, reject) => {
    const child = execFile(options.execPath ?? process.execPath, ['--max-old-space-size=192', workerPath], { windowsHide: true, timeout: 10000, maxBuffer: maxBytes, encoding: 'utf8', env }, (error, stdout) => {
      if (error) { reject(new DshProfileError(error.killed ? 'timeout' : 'worker')); return; }
      try { done(JSON.parse(stdout.trim())); } catch { reject(new DshProfileError('protocol')); }
    });
    child.stdin?.on('error', () => { /* The exit callback returns controlled failure. */ });
    child.stdin?.end(JSON.stringify(request));
  });
}

/** Resolve the existing native model-plugin tree without mounting any plugins. */
export async function resolveDshProfile(home: string, options: DshProfileResolveOptions = {}): Promise<DshProfileMetadata> {
  if (!text(home, 4096) || !isAbsolute(home)) fail('home');
  const target = resolve(home), profileName = selectedProfile(target);
  const anchors = await installationAnchors(profileName, options);
  if (!anchors.length) fail('runtime');
  let last: DshProfileError | undefined;
  for (const installAnchor of anchors) {
    try {
      const request = { home: target, profileName, installAnchor };
      const raw = await (options.runWorker ? options.runWorker(request) : runWorker(request, options));
      if (!object(raw) || typeof raw.ok !== 'boolean') fail('protocol');
      if (!raw.ok) {
        const category = typeof raw.category === 'string' && Object.hasOwn(messages, raw.category) ? raw.category as Failure : 'worker';
        fail(category);
      }
      const result = validateDshProfileMetadata(raw.metadata);
      if (result.profileName !== profileName) fail('protocol'); return result;
    } catch (error) { last = error instanceof DshProfileError ? error : new DshProfileError('worker'); }
  }
  throw last ?? new DshProfileError('runtime');
}
