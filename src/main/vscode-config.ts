import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { parseTree, getNodeValue, modify, type ParseError } from 'jsonc-parser';
import { editJsonc } from './jsonc-edit';
import { recoverConfigJournal, transactConfigFiles, type ConfigFileChange } from './config-journal';
import { privatePathIdentity, replacePrivateFile } from './private-file';
import { writeVsCodeModelFile } from './vscode-model-file';

export interface VsCodeHistoryStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
export interface VsCodeProxyPlan {
  eligible: boolean;
  proxyUrl?: string;
  reason?: 'no-remote-source' | 'environment-proxy' | 'proxy-support-off';
}
export interface VsCodeConfigOptions {
  proxy?: VsCodeProxyPlan;
  /** Official restoration releases ownership without changing later user edits. */
  release?: boolean;
  /** Private transaction seams; never accepted from the renderer. */
  beforeCommit?: () => void;
  afterFileCommit?: (index: number, path: string) => void;
}
export interface VsCodeProxyValue { present: boolean; value?: string }
type Value = VsCodeProxyValue;
interface History { version: 1; modelsPath: string; settingsPath: string; settingsCreated?: boolean; proxyOverride?: true; proxy?: { before: Value; applied: Value } }
const formattingOptions = { insertSpaces: true, tabSize: 2 };
const maximumFileSize = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function vsCodeConfigTargets(appData: string) {
  const directory = join(appData, 'Code', 'User');
  return { modelsPath: join(directory, 'chatLanguageModels.json'), settingsPath: join(directory, 'settings.json') };
}
export function vsCodeHistoryKey(modelsPath: string): string {
  return `tool-config:vscode:${createHash('sha256').update(privatePathIdentity(modelsPath)).digest('hex')}`;
}
function read(path: string): string | null {
  for (let current = dirname(resolve(path)); ; current = dirname(current)) {
    try { const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('VS Code 配置目录含链接或不是目录。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumFileSize) throw new Error('VS Code 配置文件类型或大小不受支持。');
    return readFileSync(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function settings(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const errors: ParseError[] = [], tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== 'object') throw new Error('VS Code settings.json 格式无效，未修改配置。');
  const names = (tree.children ?? []).map(node => node.children?.[0]?.value);
  for (const key of ['http.proxy', 'http.proxySupport']) {
    if (names.filter(name => name === key).length > 1) throw new Error('VS Code 代理设置包含重复字段，未修改配置。');
  }
  const value = getNodeValue(tree) as Record<string, unknown>;
  if (value['http.proxy'] !== undefined && typeof value['http.proxy'] !== 'string'
    || value['http.proxySupport'] !== undefined && typeof value['http.proxySupport'] !== 'string') {
    throw new Error('VS Code 代理设置格式无效，未修改配置。');
  }
  return value;
}
function proxyValue(value: Record<string, unknown>): Value {
  return Object.hasOwn(value, 'http.proxy') ? { present: true, value: value['http.proxy'] as string } : { present: false };
}
function equal(a: Value, b: Value): boolean { return a.present === b.present && a.value === b.value; }
export function readVsCodeProxyValue(text: string | null): VsCodeProxyValue {
  return proxyValue(settings(text));
}
export function setVsCodeProxyValue(text: string | null, next: VsCodeProxyValue, removeEmptyFile = false): string | null {
  const input = text ?? '{}';
  if (equal(readVsCodeProxyValue(text), next)) return text;
  const output = editJsonc(input, modify(input, ['http.proxy'], next.present ? next.value : undefined, {
    formattingOptions: { ...formattingOptions, eol: input.includes('\r\n') ? '\r\n' : '\n' },
  }));
  return removeEmptyFile && /^\s*\{\s*\}\s*$/.test(output) ? null : output;
}
function validValue(value: unknown): value is Value {
  return object(value) && typeof value.present === 'boolean' && Object.keys(value).every(key => ['present', 'value'].includes(key))
    && (value.present ? typeof value.value === 'string' : value.value === undefined);
}
function history(value: unknown, modelsPath: string, settingsPath: string): History | null {
  if (value === null) return null;
  if (!object(value) || value.version !== 1 || value.modelsPath !== modelsPath || value.settingsPath !== settingsPath
    || value.settingsCreated !== undefined && typeof value.settingsCreated !== 'boolean'
    || value.proxyOverride !== undefined && value.proxyOverride !== true
    || value.proxy !== undefined && (!object(value.proxy) || !validValue(value.proxy.before) || !validValue(value.proxy.applied)
      || !value.proxy.applied.present || !localHttpProxy(value.proxy.applied.value!, -1))) {
    throw new Error('VS Code 配置恢复记录无效，未修改配置。');
  }
  return value as unknown as History;
}
export { history as validateVsCodeHistory };
/** Normalize only credential-free loopback HTTP(S) proxies; never publish a gateway as a proxy. */
function localHttpProxy(text: string, gatewayPort: number): string | undefined {
  try {
    const url = new URL(text), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !['localhost', '::1'].includes(host) && !(isIP(host) === 4 && host.startsWith('127.'))
      || port < 1 || port > 65535 || port === gatewayPort) return;
    return `${url.protocol}//${url.hostname}:${port}`;
  } catch { return; }
}
function singleSystemProxy(rules: string, gatewayPort: number): string | undefined {
  const entries = rules.split(';').map(value => value.trim()).filter(Boolean);
  if (entries.length !== 1) return;
  const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(entries[0]);
  return match ? localHttpProxy(`${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`, gatewayPort) : undefined;
}
export function isRemoteVsCodeUrl(value: string): boolean {
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !['localhost', '::1'].includes(host) && !(isIP(host) === 4 && host.startsWith('127.'));
  } catch { return false; }
}
/** The caller supplies the operating system's proxy resolver for the selected direct inference URLs. */
export async function discoverVsCodeProxy(appData: string, remoteUrls: string[], gatewayPort: number,
  env: NodeJS.ProcessEnv, resolveSystemProxy: (url: string) => Promise<string>): Promise<VsCodeProxyPlan> {
  // Match VS Code's actual precedence, including a whitespace higher-priority
  // variable masking a lower-priority value. ALL_PROXY is not read there.
  const environmentProxy = (env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '').trim();
  if (!remoteUrls.length || !remoteUrls.every(isRemoteVsCodeUrl)) return { eligible: false, reason: 'no-remote-source' };
  if (environmentProxy) return { eligible: false, reason: 'environment-proxy' };
  const current = settings(read(vsCodeConfigTargets(appData).settingsPath));
  if (current['http.proxySupport'] === 'off') return { eligible: false, reason: 'proxy-support-off' };
  const urls = [...new Set(remoteUrls)];
  if (urls.length > 32) return { eligible: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      Promise.all(urls.map(async url => singleSystemProxy(await resolveSystemProxy(url), gatewayPort))),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 3000); }),
    ]);
    const proxyUrl = resolved?.[0];
    return { eligible: true, ...(proxyUrl && resolved?.every(value => value === proxyUrl) ? { proxyUrl } : {}) };
  } catch { return { eligible: true }; }
  finally { if (timer) clearTimeout(timer); }
}
function updateProxy(original: string | null, saved: History | null, plan?: VsCodeProxyPlan): { output: string | null; proxy?: History['proxy']; overridden?: true; action: string } {
  const current = settings(original), value = proxyValue(current), owned = saved?.proxy;
  const stillOwned = !!owned && equal(value, owned.applied);
  const desired = plan?.eligible && current['http.proxySupport'] !== 'off' && plan.proxyUrl ? localHttpProxy(plan.proxyUrl, -1) : undefined;
  // Existing nonempty user settings and edits after our last sync always win.
  if (saved?.proxyOverride || owned && !stillOwned) return { output: original, overridden: true,
    action: value.value?.trim() ? '保留你手动修改的 VS Code 代理。' : '保留你手动清空的 VS Code 代理。' };
  if (!owned && value.value?.trim()) return { output: original, action: '保留用户已有的 http.proxy。' };
  let next: Value = value;
  let proxy: History['proxy'];
  if (desired) {
    next = { present: true, value: desired };
    proxy = { before: stillOwned ? owned!.before : value, applied: next };
  } else if (stillOwned) next = owned!.before;
  const output = setVsCodeProxyValue(original, next, !proxy && stillOwned && saved?.settingsCreated);
  return { output, ...(proxy ? { proxy } : {}), action: desired
    ? `将 VS Code 全局 http.proxy 设为系统代理 ${desired}。`
    : stillOwned ? '撤回 ModelDock 写入的代理，恢复原有的 VS Code 代理设置。'
      : plan?.eligible ? '未检测到所有直连来源共用的单一本机 HTTP(S) 系统代理，保留 VS Code 网络设置。' : '无需补充 VS Code 代理设置。' };
}
export function vsCodeProxyInstructions(store: Pick<VsCodeHistoryStore, 'getManagedState'> | undefined, appData: string, plan?: VsCodeProxyPlan): string {
  const targets = vsCodeConfigTargets(appData), value = store?.getManagedState<unknown>(vsCodeHistoryKey(targets.modelsPath), null) ?? null;
  if (object(value) && Object.hasOwn(value, 'modeldockPending')) return '存在未完成的 VS Code 配置事务；下次显式同步会先恢复，预览不会改写文件。';
  const saved = history(value, targets.modelsPath, targets.settingsPath);
  if (saved?.proxyOverride) return '保留你此前手动修改或清空的 VS Code 代理设置。';
  if (!saved?.proxy && !plan) return 'VS Code 代理开关已关闭。';
  if (!saved?.proxy && plan?.reason) {
    switch (plan.reason) {
      case 'no-remote-source': return '代理开关已开启，当前没有选中的远程直连模型。';
      case 'environment-proxy': return '代理开关已开启，VS Code 继续使用已有的 HTTP(S) 环境代理。';
      case 'proxy-support-off': return '代理开关已开启，VS Code 的 http.proxySupport 已设为 off。';
    }
  }
  return updateProxy(read(targets.settingsPath), saved, plan).action;
}
export function hasVsCodeManagedProxy(store: Pick<VsCodeHistoryStore, 'getManagedState'>, appData: string): boolean {
  const { modelsPath, settingsPath } = vsCodeConfigTargets(appData);
  return !!history(store.getManagedState(vsCodeHistoryKey(modelsPath), null), modelsPath, settingsPath)?.proxy;
}
export function recoverVsCodeConfig(store: VsCodeHistoryStore, appData: string): void {
  const { modelsPath, settingsPath } = vsCodeConfigTargets(appData), key = vsCodeHistoryKey(modelsPath);
  const value = store.getManagedState<unknown>(key, null);
  let paths = [modelsPath, settingsPath];
  if (object(value) && value.modeldockPending === 1 && Array.isArray(value.files) && value.files.length === 1) {
    paths = [value.files[0]?.path === settingsPath ? settingsPath : modelsPath];
  }
  recoverConfigJournal(store, key, paths, value => history(value, modelsPath, settingsPath), read, replacePrivateFile);
}
/** Model JSONC has already been merged and validated by the existing adapter. */
export function applyVsCodeFiles(store: VsCodeHistoryStore, appData: string, originalModels: string | null, outputModels: string | null, options: VsCodeConfigOptions = {}): string {
  const { modelsPath } = vsCodeConfigTargets(appData);
  commitVsCodeConfig(store, appData, options, { path: modelsPath, before: originalModels, after: outputModels });
  return modelsPath;
}
/** An isolated switch change leaves existing model groups and credentials alone. */
export function applyVsCodeProxyOnly(store: VsCodeHistoryStore, appData: string, plan?: VsCodeProxyPlan): string {
  recoverVsCodeConfig(store, appData);
  commitVsCodeConfig(store, appData, { proxy: plan, release: plan === undefined });
  return vsCodeConfigTargets(appData).settingsPath;
}
function commitVsCodeConfig(store: VsCodeHistoryStore, appData: string, options: VsCodeConfigOptions, modelFile?: ConfigFileChange): void {
  const { modelsPath, settingsPath } = vsCodeConfigTargets(appData), key = vsCodeHistoryKey(modelsPath);
  const saved = history(store.getManagedState(key, null), modelsPath, settingsPath);
  if (!saved?.proxy && (options.release || !options.proxy?.proxyUrl || saved?.proxyOverride)) {
    if (saved && options.release) {
      // Release the manual-override marker without inspecting editor preferences.
      if (!modelFile) { store.setManagedState(key, null); return; }
      transactConfigFiles({ store, key, kind: 'vscode-config', before: saved, after: null, files: [modelFile],
        read, write: replacePrivateFile, beforeCommit: options.beforeCommit });
    } else if (modelFile) {
      writeVsCodeModelFile(store, modelsPath, modelFile.before, modelFile.after, options.beforeCommit);
    }
    return;
  }
  const originalSettings = read(settingsPath), next = updateProxy(originalSettings, saved, options.release ? undefined : options.proxy);
  settings(next.output);
  const after: History | null = next.proxy ? { version: 1, modelsPath, settingsPath, settingsCreated: saved?.settingsCreated ?? originalSettings === null, proxy: next.proxy }
    : next.overridden && !options.release ? { version: 1, modelsPath, settingsPath, proxyOverride: true } : null;
  const settingsFile = { path: settingsPath, before: originalSettings, after: next.output };
  transactConfigFiles({ store, key, kind: 'vscode-config', before: saved, after,
    files: modelFile ? [modelFile, settingsFile] : [settingsFile],
    read, write: replacePrivateFile, beforeCommit: options.beforeCommit, afterFileCommit: options.afterFileCommit });
}
