import { replacePrivateFile } from './private-file';
import { recoverConfigJournal, transactConfigFiles } from './config-journal';
import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ConfigPreview, Model, Provider, ProviderSecret, ToolBinding } from '../shared/types';
import { resolveBindingModels } from '../shared/bindings';
import { upstreamEndpoint } from './oauth';
import { buildJunieAcpEntry, junieAcpTarget, mergeJunieAcp, readJunieAcpEntry, resolveJunieCommand, type JunieCommand } from './junie-acp';

export interface JunieConfigStore {
  listModels(): Model[];
  listBindings(): ToolBinding[];
  listProviders?(): Provider[];
  getProvider?(id: string): Provider | undefined;
  getSecret?(id: string): ProviderSecret | undefined;
  gatewayKey(): string;
  getManagedState?<T>(key: string, fallback: T): T;
  setManagedState?(key: string, value: unknown): void;
  createManagedBackup?(kind: string, value: unknown): string;
}
export interface JunieHistoryStore {
  getManagedState?<T>(key: string, fallback: T): T;
  setManagedState?(key: string, value: unknown): void;
  createManagedBackup?(kind: string, value: unknown): string;
}
export interface JunieConfigOptions {
  junieHome?: string;
  port?: number;
  /** Verified launcher injection for native adapters and isolated tests only. */
  junieCommand?: JunieCommand;
  /** Main-process transaction test seams, never accepted from renderer IPC. */
  beforeCommit?: () => void;
  afterFileCommit?: (index: number, path: string) => void;
}
interface HistoryStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
interface Value { present: boolean; value?: string }
interface History {
  version: 1; configPath: string; profilePath: string; configWasPresent: boolean;
  beforeModel: Value; appliedModel: Value; beforeProfile: string | null; appliedProfile: string;
  acpPath: string; acpWasPresent: boolean; acpAgentsWasPresent: boolean; beforeAcpEntry: EntryValue; appliedAcpEntry: EntryValue;
}
interface EntryValue { present: boolean; value?: unknown }
interface FileState { path: string; content: string | null }
export interface JunieModelProfile {
  id: string; baseUrl: string; apiType: 'OpenAIResponses' | 'OpenAICompletion'; apiKey: string;
  displayName: string; providerName: string; maxContextLength?: number;
}
const profileId = 'custom:modeldock';
const maximumFileSize = 2 * 1024 * 1024;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An explicitly supplied test home never picks up the real user's JUNIE_HOME. */
export function junieConfigDirectory(homeDirectory = homedir(), override?: string): string {
  const configured = override ?? (homeDirectory === homedir() ? process.env.JUNIE_HOME : undefined);
  if (configured !== undefined && (!configured.trim() || !isAbsolute(configured.trim()) || /[\x00-\x1f\x7f]/.test(configured))) {
    throw new Error('JUNIE_HOME 必须是有效的绝对目录。');
  }
  return configured ? resolve(configured.trim()) : join(homeDirectory, '.junie');
}
export function junieConfigTargets(homeDirectory = homedir(), options: JunieConfigOptions = {}): { configPath: string; profilePath: string; acpPath: string } {
  const root = junieConfigDirectory(homeDirectory, options.junieHome);
  return { configPath: join(root, 'config.json'), profilePath: join(root, 'models', 'modeldock.json'), acpPath: junieAcpTarget(homeDirectory) };
}
export function junieHistoryKey(configPath: string): string {
  const path = process.platform === 'win32' ? resolve(configPath).toLowerCase() : resolve(configPath);
  return `tool-config:junie:${createHash('sha256').update(path).digest('hex')}`;
}
function modelValue(config: Record<string, unknown>): Value {
  return Object.hasOwn(config, 'model') ? { present: true, value: config.model as string } : { present: false };
}
function assertId(value: string): void {
  if (!value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Junie 模型标识无效。');
}
function selection(store: JunieConfigStore, revealKey: boolean, port: number): JunieModelProfile | null {
  const binding = store.listBindings().find(item => String(item.id) === 'junie');
  if (!binding) throw new Error('找不到 Junie 的配置。');
  if (!binding.enabled) return null;
  const allModels = store.listModels();
  const providerIds = [...new Set(binding.providerIds ?? allModels.filter(model => binding.modelIds.includes(model.id)).map(model => model.providerId))];
  const providers = store.listProviders?.() ?? providerIds.flatMap(id => { const provider = store.getProvider?.(id); return provider ? [provider] : []; });
  const models = resolveBindingModels(binding, allModels, providers).filter(model => model.wireApi === 'responses' || model.wireApi === 'chat-completions');
  if (!models.length) return null;
  const chosen = models.find(model => model.id === binding.defaultModelId) ?? models[0];
  const aggregate = binding.mode === 'aggregate';
  if (!aggregate && providerIds.length !== 1) throw new Error('Junie 直连必须选择恰好一个 API 供应商。');
  const provider = providers.find(source => source.id === chosen.providerId);
  if (!provider?.enabled || !provider.hasSecret || provider.authStatus !== 'ready') throw new Error('Junie 所选来源的凭据尚未就绪。');
  if (!aggregate && provider.kind !== 'openai-compatible') throw new Error('Junie 订阅来源必须使用聚合接口。');
  if (aggregate && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('Junie 本机入口端口无效。');
  const id = aggregate ? chosen.alias : chosen.upstreamId;
  assertId(id);
  const key = revealKey ? aggregate ? store.gatewayKey() : store.getSecret?.(provider.id)?.apiKey : aggregate ? '__MODELDOCK_LOCAL_KEY__' : '__PROVIDER_API_KEY__';
  if (!key || /[\x00-\x1f\x7f]/.test(key) || key.includes('${')) throw new Error('Junie 所选来源缺少有效的 API Key。');
  const route = chosen.wireApi === 'responses' ? '/responses' : '/chat/completions';
  const base = aggregate ? `http://127.0.0.1:${port}/tool/junie/v1` : provider.baseUrl;
  return { id, baseUrl: upstreamEndpoint(base, route), apiType: chosen.wireApi === 'responses' ? 'OpenAIResponses' : 'OpenAICompletion', apiKey: key,
    displayName: chosen.displayName || chosen.upstreamId, providerName: aggregate ? 'ModelDock' : provider.name,
    ...(Number.isSafeInteger(chosen.contextWindow) && chosen.contextWindow > 0 ? { maxContextLength: chosen.contextWindow } : {}) };
}
export function buildJunieConfig(store: JunieConfigStore, revealKey = false, port = 18181, homeDirectory = homedir(), options: JunieConfigOptions = {}): ConfigPreview {
  const targets = junieConfigTargets(homeDirectory, options), profile = selection(store, revealKey, port);
  const command = profile ? options.junieCommand ?? resolveJunieCommand(homeDirectory) : undefined;
  const acp = profile && command ? buildJunieAcpEntry(profileId, junieConfigDirectory(homeDirectory, options.junieHome), command) : undefined;
  return { filename: 'modeldock-junie.json', canApply: !profile || !!command,
    content: profile ? json({ config: { model: profileId }, profile, ...(acp ? { acp } : {}) }) : '',
    instructions: profile
      ? `将默认模型写入 ${targets.profilePath}，只合并 ${targets.configPath} 的 model 字段；在 ${targets.acpPath} 添加独立的 Junie · ModelDock 代理，保留 IDE 其他代理和 MCP 设置。Junie 的 baseUrl 使用完整推理端点，Responses 与 Chat Completions 保持所选协议。当前仅同步默认模型，其余聚合映射保留在 ModelDock 网关权限中。预览隐藏密钥，导出或应用时才写入所用 API Key；订阅令牌留在 ModelDock。终端使用 junie --model custom:modeldock 或在 /model 的 Custom 标签选择；IDE 在 AI Chat 选择 Junie · ModelDock 代理。项目 config.json、命令行和 Junie settings.json 可能影响最终选择；配置写入不代表实际推理已通过。${command ? '' : '未找到支持的 Junie CLI 启动程序，请先安装 Junie CLI 后重新预览。'}`
      : '移除仍属于 ModelDock 的 Junie 配置并恢复原有默认模型；保留其他模型、账号、MCP、Hooks 与用户设置。没有管理记录时不修改文件。',
  };
}

function info(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function safeDirectory(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    const entry = info(current);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error('Junie 配置目录含链接或非目录，未修改原文件。');
    if (dirname(current) === current) return;
  }
}
function read(path: string): string | null {
  safeDirectory(dirname(path));
  const entry = info(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maximumFileSize) throw new Error('Junie 配置文件类型或大小无效，未修改原文件。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
  catch { throw new Error('Junie 配置必须是有效的 UTF-8，未修改原文件。'); }
}
function parseConfig(content: string | null): Record<string, unknown> {
  let value: unknown;
  try { value = content === null ? {} : JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new Error('Junie config.json 不是有效的 JSON，未修改原文件。'); }
  if (!object(value) || Object.hasOwn(value, 'model') && typeof value.model !== 'string') throw new Error('Junie config.json 的 model 格式无效，未修改原文件。');
  return value;
}
function valueValid(value: unknown): value is Value {
  return object(value) && typeof value.present === 'boolean' && Object.keys(value).every(key => key === 'present' || key === 'value')
    && (value.present ? typeof value.value === 'string' : value.value === undefined);
}
function entryValid(value: unknown): value is EntryValue {
  return object(value) && typeof value.present === 'boolean' && Object.keys(value).every(key => key === 'present' || key === 'value')
    && (value.present ? object(value.value) : value.value === undefined);
}
function validateHistory(value: unknown, configPath: string, profilePath: string, acpPath: string): History | null {
  if (value === null) return null;
  if (!object(value) || value.version !== 1 || value.configPath !== configPath || value.profilePath !== profilePath || value.acpPath !== acpPath || typeof value.configWasPresent !== 'boolean' || typeof value.acpWasPresent !== 'boolean' || typeof value.acpAgentsWasPresent !== 'boolean'
    || !valueValid(value.beforeModel) || !valueValid(value.appliedModel) || value.appliedModel.value !== profileId || value.appliedModel.present !== true
    || !entryValid(value.beforeAcpEntry) || !entryValid(value.appliedAcpEntry) || value.appliedAcpEntry.present !== true
    || value.beforeProfile !== null && typeof value.beforeProfile !== 'string' || typeof value.appliedProfile !== 'string'
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 6 * 1024 * 1024) throw new Error('Junie 配置恢复记录无效，未修改原文件。');
  return value as unknown as History;
}
function historyStore(store: JunieHistoryStore): HistoryStore {
  if (!store.getManagedState || !store.setManagedState || !store.createManagedBackup) throw new Error('Junie 同步需要安全的配置恢复记录和加密备份，未修改原文件。');
  return store as HistoryStore;
}
function replace(path: string, content: string | null): void {
  safeDirectory(dirname(path));
  replacePrivateFile(path, content);
}
/** Unified undo preserves the same private credential-file permissions. */
export function replaceJunieConfigFile(path: string, content: string | null): void { read(path); replace(path, content); }
function history(store: HistoryStore, configPath: string, profilePath: string, acpPath: string): History | null {
  return recoverConfigJournal(store, junieHistoryKey(configPath), [configPath, profilePath, acpPath], value => validateHistory(value, configPath, profilePath, acpPath), read, replace);
}
export function recoverJunieConfig(store: JunieHistoryStore, homeDirectory = homedir(), options: JunieConfigOptions = {}): void {
  const { configPath, profilePath, acpPath } = junieConfigTargets(homeDirectory, options);
  history(historyStore(store), configPath, profilePath, acpPath);
}
function transact(store: HistoryStore, beforeFiles: FileState[], afterFiles: FileState[], before: History | null, after: History | null, options: JunieConfigOptions): string {
  const target = beforeFiles[0].path;
  transactConfigFiles({ store, key: junieHistoryKey(target), kind: 'junie-config', before, after,
    files: beforeFiles.map((file, index) => ({ path: file.path, before: file.content, after: afterFiles[index].content })),
    read, write: replace, order: [1, 2, 0], beforeCommit: options.beforeCommit, afterFileCommit: options.afterFileCommit });
  return target;
}
function restore(store: HistoryStore, homeDirectory: string, options: JunieConfigOptions): string {
  const { configPath, profilePath, acpPath } = junieConfigTargets(homeDirectory, options);
  const before = history(store, configPath, profilePath, acpPath);
  if (!before) return configPath;
  const original = read(configPath), profile = read(profilePath), acp = read(acpPath), config = parseConfig(original);
  if (profile !== before.appliedProfile) throw new Error('Junie 受管模型已被外部修改，未覆盖新修改。');
  if (!equal(readJunieAcpEntry(acp), before.appliedAcpEntry)) throw new Error('Junie 受管 IDE 代理已被外部修改，未覆盖新修改。');
  if (equal(modelValue(config), before.appliedModel)) {
    if (before.beforeModel.present) config.model = before.beforeModel.value; else delete config.model;
  }
  const output = !before.configWasPresent && !Object.keys(config).length ? null : json(config);
  let outputAcp = mergeJunieAcp(acp, before.beforeAcpEntry.present ? before.beforeAcpEntry.value as Parameters<typeof mergeJunieAcp>[1] : null);
  if (!before.acpAgentsWasPresent && outputAcp !== null) {
    const value = JSON.parse(outputAcp);
    if (object(value.agent_servers) && !Object.keys(value.agent_servers).length) { delete value.agent_servers; outputAcp = json(value); }
  }
  if (!before.acpWasPresent && outputAcp !== null && !Object.keys(JSON.parse(outputAcp)).length) outputAcp = null;
  return transact(store, [{ path: configPath, content: original }, { path: profilePath, content: profile }, { path: acpPath, content: acp }],
    [{ path: configPath, content: output }, { path: profilePath, content: before.beforeProfile }, { path: acpPath, content: outputAcp }], before, null, options);
}
export function applyJunieConfig(store: JunieConfigStore, _backups: string, homeDirectory = homedir(), options: JunieConfigOptions = {}): string {
  const state = historyStore(store), profile = selection(store, true, options.port ?? 18181);
  if (!profile) return restore(state, homeDirectory, options);
  const command = options.junieCommand ?? resolveJunieCommand(homeDirectory);
  if (!command) throw new Error('未找到支持的 Junie CLI 启动程序，请先安装 Junie CLI，再同步终端和 IDE 配置。');
  const { configPath, profilePath, acpPath } = junieConfigTargets(homeDirectory, options);
  const before = history(state, configPath, profilePath, acpPath);
  const original = read(configPath), oldProfile = read(profilePath), acp = read(acpPath), config = parseConfig(original);
  if (oldProfile !== null && !before) throw new Error('Junie 的 modeldock.json 已存在且不属于 ModelDock，未覆盖原文件。');
  if (before && oldProfile !== before.appliedProfile) throw new Error('Junie 受管模型已被外部修改，未覆盖新修改。');
  const currentAcp = readJunieAcpEntry(acp);
  if (!before && currentAcp.present) throw new Error('Junie · ModelDock IDE 代理已存在且不属于 ModelDock，未覆盖原配置。');
  if (before && !equal(currentAcp, before.appliedAcpEntry)) throw new Error('Junie 受管 IDE 代理已被外部修改，未覆盖新修改。');
  const desiredAcp = buildJunieAcpEntry(profileId, junieConfigDirectory(homeDirectory, options.junieHome), command);
  const outputAcp = mergeJunieAcp(acp, desiredAcp);
  const currentModel = modelValue(config), outputProfile = json(profile);
  const next: History = { version: 1, configPath, profilePath, configWasPresent: before?.configWasPresent ?? original !== null,
    beforeModel: before && equal(currentModel, before.appliedModel) ? before.beforeModel : currentModel,
    appliedModel: { present: true, value: profileId }, beforeProfile: before ? before.beforeProfile : oldProfile, appliedProfile: outputProfile,
    acpPath, acpWasPresent: before?.acpWasPresent ?? acp !== null,
    acpAgentsWasPresent: before?.acpAgentsWasPresent ?? (acp !== null && Object.hasOwn(JSON.parse(acp.replace(/^\uFEFF/, '')), 'agent_servers')),
    beforeAcpEntry: before?.beforeAcpEntry ?? currentAcp, appliedAcpEntry: { present: true, value: desiredAcp } };
  config.model = profileId;
  return transact(state, [{ path: configPath, content: original }, { path: profilePath, content: oldProfile }, { path: acpPath, content: acp }],
    [{ path: configPath, content: json(config) }, { path: profilePath, content: outputProfile }, { path: acpPath, content: outputAcp }], before, next, options);
}
export function restoreJunieOfficialConfig(store: JunieHistoryStore, _backups: string, homeDirectory = homedir(), options: JunieConfigOptions = {}): string {
  return restore(historyStore(store), homeDirectory, options);
}
