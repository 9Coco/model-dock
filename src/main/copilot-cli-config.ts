import { replacePrivateFile } from './private-file';
import { recoverConfigJournal, transactConfigFiles } from './config-journal';
import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { applyEdits, createScanner, modify, parse as parseJsonc, SyntaxKind, type ParseError } from 'jsonc-parser';
import { isDeepStrictEqual } from 'node:util';
import type { ConfigPreview, Model, Provider, ProviderSecret, ToolBinding } from '../shared/types';
import { resolveBindingModels } from '../shared/bindings';

export interface CopilotCliConfigStore {
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
export interface CopilotCliHistoryStore {
  getManagedState?<T>(key: string, fallback: T): T;
  setManagedState?(key: string, value: unknown): void;
  createManagedBackup?(kind: string, value: unknown): string;
}
export interface CopilotCliConfigOptions {
  copilotHome?: string;
  providersConfig?: string;
  port?: number;
  /** Main-process test seams; never accepted from renderer IPC. */
  beforeCommit?: () => void;
  afterFileCommit?: (index: number, path: string) => void;
}
interface HistoryStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
interface Value { present: boolean; value?: unknown }
interface OwnedRegistry { providers: Record<string, unknown>[]; models: Record<string, unknown>[] }
interface History {
  version: 1; providersPath: string; settingsPath: string;
  providersWasPresent: boolean; settingsWasPresent: boolean;
  providersField: 'absent' | 'null' | 'array'; modelsField: 'absent' | 'null' | 'array';
  beforeModel: Value; appliedModel: Value; appliedRegistry: OwnedRegistry;
}
interface FileState { path: string; content: string | null }
interface Selection extends OwnedRegistry { model: string; unknownBudget: boolean }
const providerNames = ['modeldock-chat', 'modeldock-responses'] as const;
const maximumFileSize = 2 * 1024 * 1024;
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const owns = (value: unknown): boolean => typeof value === 'string' && ((providerNames as readonly string[]).includes(value) || /^modeldock-[a-f0-9]{24}-(chat|responses)$/.test(value));
const valueAt = (record: Record<string, unknown>, key: string): Value => Object.hasOwn(record, key) ? { present: true, value: record[key] } : { present: false };

function configuredPath(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || !isAbsolute(value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} 必须是有效的绝对路径。`);
  return resolve(value.trim());
}
/** Explicit fixture homes never borrow the user's environment overrides. */
export function copilotCliConfigDirectory(homeDirectory = homedir(), override?: string): string {
  return configuredPath(override ?? (homeDirectory === homedir() ? process.env.COPILOT_HOME : undefined), 'COPILOT_HOME') ?? join(homeDirectory, '.copilot');
}
export function copilotCliConfigTargets(homeDirectory = homedir(), options: CopilotCliConfigOptions = {}): { providersPath: string; settingsPath: string } {
  const directory = copilotCliConfigDirectory(homeDirectory, options.copilotHome);
  const providersPath = configuredPath(options.providersConfig ?? (homeDirectory === homedir() ? process.env.COPILOT_PROVIDERS_CONFIG : undefined), 'COPILOT_PROVIDERS_CONFIG') ?? join(directory, 'providers.json');
  const settingsPath = join(directory, 'settings.json');
  if ((process.platform === 'win32' ? providersPath.toLowerCase() : providersPath) === (process.platform === 'win32' ? settingsPath.toLowerCase() : settingsPath)) throw new Error('Copilot CLI 模型注册表不能与 settings.json 使用同一个文件。');
  return { providersPath, settingsPath };
}
export function copilotCliHistoryKey(providersPath: string): string {
  const path = process.platform === 'win32' ? resolve(providersPath).toLowerCase() : resolve(providersPath);
  return `tool-config:copilot-cli:${createHash('sha256').update(path).digest('hex')}`;
}
function assertId(value: string): void {
  if (!value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Copilot CLI 模型标识无效。');
}
function selection(store: CopilotCliConfigStore, revealKey: boolean, port: number): Selection | null {
  const binding = store.listBindings().find(item => String(item.id) === 'copilot-cli');
  if (!binding) throw new Error('找不到 Copilot CLI 的配置。');
  if (!binding.enabled) return null;
  const allModels = store.listModels();
  const providerIds = [...new Set(binding.providerIds ?? allModels.filter(model => binding.modelIds.includes(model.id)).map(model => model.providerId))];
  const providers = store.listProviders?.() ?? providerIds.flatMap(id => { const provider = store.getProvider?.(id); return provider ? [provider] : []; });
  const models = resolveBindingModels(binding, allModels, providers).filter(model => model.wireApi === 'responses' || model.wireApi === 'chat-completions');
  if (!models.length) return null;
  const aggregate = binding.mode === 'aggregate';
  if (models.some(model => { const provider = providers.find(source => source.id === model.providerId); return !provider?.enabled || !provider.hasSecret || provider.authStatus !== 'ready'; })) throw new Error('Copilot CLI 所选来源的凭据尚未就绪。');
  const source = (model: Model) => providers.find(provider => provider.id === model.providerId)!;
  const local = (model: Model) => aggregate || source(model).kind !== 'openai-compatible' || !!source(model).nativeAdapter;
  if (models.some(local) && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('Copilot CLI 本机入口端口无效。');
  const chosen = models.find(model => model.id === binding.defaultModelId) ?? models[0];
  const name = (model: Model) => aggregate ? (model.wireApi === 'responses' ? providerNames[1] : providerNames[0])
    : `modeldock-${createHash('sha256').update(model.providerId).digest('hex').slice(0, 24)}-${model.wireApi === 'responses' ? 'responses' : 'chat'}`;
  const id = (model: Model) => local(model) ? model.alias : model.upstreamId;
  const connections = models.filter((model, index) => models.findIndex(other => name(other) === name(model)) === index).map(model => {
    const key = revealKey ? local(model) ? store.gatewayKey() : store.getSecret?.(model.providerId)?.apiKey : local(model) ? '__MODELDOCK_LOCAL_KEY__' : '__PROVIDER_API_KEY__';
    if (!key || /[\x00-\x1f\x7f]/.test(key)) throw new Error('Copilot CLI 所选来源缺少有效的 API Key。');
    const baseUrl = local(model) ? `http://127.0.0.1:${port}/tool/copilot-cli/v1` : source(model).baseUrl.replace(/\/+$/, '');
    return { name: name(model), type: 'openai', baseUrl, wireApi: model.wireApi === 'responses' ? 'responses' : 'completions', apiKey: key };
  });
  const configuredModels = models.map(model => {
    assertId(id(model)); assertId(model.upstreamId);
    if (model.contextWindow === 1) throw new Error('Copilot CLI 上下文预算至少需要 2 个 token 才能同时分配输入和输出，请修正模型参数。');
    const context = model.contextWindow > 0 ? Math.min(model.contextWindow, 0xffffffff) : 32768;
    const requestedOutput = model.maxOutputTokens && model.maxOutputTokens > 0 ? model.maxOutputTokens : model.contextWindow > 0 ? Math.max(1, Math.min(16384, Math.floor(context / 4))) : 4096;
    const output = Math.max(1, Math.min(requestedOutput, Math.max(1, context - 1)));
    const input = model.maxInputTokens && model.maxInputTokens > 0 ? Math.min(model.maxInputTokens, Math.max(0, context - output)) : Math.max(0, context - output);
    return { id: id(model), provider: name(model), wireModel: id(model), modelId: model.upstreamId, name: model.displayName || id(model),
      maxPromptTokens: input, maxContextWindowTokens: context, maxOutputTokens: output,
      capabilities: { supports: { vision: model.vision, toolCalls: model.tools, streaming: true, ...(model.reasoningEfforts?.length ? { reasoning_effort: model.reasoningEfforts } : {}) } } };
  }).filter((model, index, all) => all.findIndex(other => other.provider === model.provider && other.id === model.id) === index);
  return { providers: connections, models: configuredModels, model: `${name(chosen)}/${id(chosen)}`, unknownBudget: models.some(model => !model.contextWindow) };
}
export function buildCopilotCliConfig(store: CopilotCliConfigStore, revealKey = false, port = 18181, homeDirectory = homedir(), options: CopilotCliConfigOptions = {}): ConfigPreview {
  const selected = selection(store, revealKey, port), targets = copilotCliConfigTargets(homeDirectory, options);
  return { filename: 'modeldock-copilot-cli.json', canApply: true,
    content: selected ? json({ providers: selected.providers, models: selected.models, settings: { model: selected.model } }) : '',
    instructions: selected ? `合并 ${targets.providersPath} 中的 ModelDock 专用来源和模型，并只更新 ${targets.settingsPath} 的 model；保留其他来源、模型、设置注释、账号、权限、MCP、Skills 与会话。按供应商和协议分别注册连接，各 API 使用独立地址与 Key；聚合模式使用 modeldock-chat / modeldock-responses，不改变上游模型协议。预览隐藏密钥，导出或应用才包含 API Key；订阅令牌留在 ModelDock。重启 Copilot CLI 后用 /model 选择，或执行 copilot --model ${selected.model}。命令行和项目设置可能覆盖默认模型。这是独立 CLI 配置，不会同步 Copilot app 或 VS Code。${selected.unknownBudget ? '上下文未知模型使用 32K（32768）上下文 / 4K（4096）输出的客户端预算，不代表上游模型规格。' : ''}配置写入不代表真实模型推理已通过。`
      : '移除仍属于 ModelDock 的 Copilot CLI 来源和模型，恢复此前默认选择；保留其他来源、账号、权限、MCP、Skills、会话及设置。没有管理记录时不修改文件。' };
}

function info(path: string) { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
function safeDirectory(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    const entry = info(current);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error('Copilot CLI 配置目录含链接或非目录，未修改原文件。');
    if (dirname(current) === current) return;
  }
}
function read(path: string): string | null {
  safeDirectory(dirname(path)); const entry = info(path);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maximumFileSize) throw new Error('Copilot CLI 配置文件类型或大小无效，未修改原文件。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
  catch { throw new Error('Copilot CLI 配置必须是有效的 UTF-8，未修改原文件。'); }
}
function parse(content: string | null, settings = false): Record<string, unknown> {
  let value: unknown;
  try {
    if (content === null) return {};
    if (settings) { const errors: ParseError[] = []; value = parseJsonc(content.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true }); if (errors.length) throw new Error(); }
    else value = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch { throw new Error(`Copilot CLI ${settings ? 'settings.json' : 'providers.json'} 格式无效，未修改原文件。`); }
  if (!object(value)) throw new Error('Copilot CLI 配置顶层必须是 JSON 对象，未修改原文件。');
  if (!settings) for (const key of ['providers', 'models']) {
    if (value[key] !== undefined && value[key] !== null && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(object))) throw new Error('Copilot CLI 来源或模型注册表格式无效，未修改原文件。');
  }
  return value;
}
function rows(registry: Record<string, unknown>, key: 'providers' | 'models'): Record<string, unknown>[] { return Array.isArray(registry[key]) ? registry[key] as Record<string, unknown>[] : []; }
function owned(registry: Record<string, unknown>): OwnedRegistry { return { providers: rows(registry, 'providers').filter(row => owns(row.name)), models: rows(registry, 'models').filter(row => owns(row.provider)) }; }
function fieldKind(registry: Record<string, unknown>, key: string): History['providersField'] { return !Object.hasOwn(registry, key) ? 'absent' : registry[key] === null ? 'null' : 'array'; }
function mergeRegistry(registry: Record<string, unknown>, desired: OwnedRegistry, previous?: History): Record<string, unknown> {
  const result = { ...registry };
  for (const key of ['providers', 'models'] as const) {
    const entries = [...rows(registry, key).filter(row => !owns(key === 'providers' ? row.name : row.provider)), ...desired[key]];
    const originalKind = previous?.[key === 'providers' ? 'providersField' : 'modelsField'];
    if (!entries.length && originalKind === 'absent') delete result[key];
    else result[key] = !entries.length && originalKind === 'null' ? null : entries;
  }
  return result;
}
function settingsContent(content: string | null, model: Value): string {
  const original = content?.replace(/^\uFEFF/, '') ?? '{}\n';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const output = applyEdits(original, modify(original, ['model'], model.present ? model.value : undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
  // Removing a property can consume its leading JSONC trivia. Keep every user
  // comment even when its former property is no longer present.
  const comments = (text: string) => {
    const scanner = createScanner(text), found: string[] = [];
    for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) found.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    return found;
  };
  const available = new Map<string, number>();
  for (const comment of comments(output)) available.set(comment, (available.get(comment) ?? 0) + 1);
  const missing = comments(original).filter(comment => { const count = available.get(comment) ?? 0; if (count) { available.set(comment, count - 1); return false; } return true; });
  return missing.length ? missing.join(eol) + eol + output : output;
}
function valueValid(value: unknown): value is Value { return object(value) && typeof value.present === 'boolean' && Object.keys(value).every(key => key === 'present' || key === 'value') && (value.present ? Object.hasOwn(value, 'value') : !Object.hasOwn(value, 'value')); }
function historyStore(store: CopilotCliHistoryStore): HistoryStore {
  if (!store.getManagedState || !store.setManagedState || !store.createManagedBackup) throw new Error('Copilot CLI 同步需要安全恢复记录和加密备份，未修改原文件。');
  return store as HistoryStore;
}
function validateHistory(value: unknown, providersPath: string, settingsPath: string): History | null {
  if (value === null) return null;
  if (!object(value) || value.version !== 1 || value.providersPath !== providersPath || value.settingsPath !== settingsPath
    || typeof value.providersWasPresent !== 'boolean' || typeof value.settingsWasPresent !== 'boolean'
    || !['absent', 'null', 'array'].includes(String(value.providersField)) || !['absent', 'null', 'array'].includes(String(value.modelsField))
    || !valueValid(value.beforeModel) || !valueValid(value.appliedModel) || !value.appliedModel.present || typeof value.appliedModel.value !== 'string'
    || !object(value.appliedRegistry) || !Array.isArray(value.appliedRegistry.providers) || !Array.isArray(value.appliedRegistry.models)
    || !value.appliedRegistry.providers.every(row => object(row) && owns(row.name)) || !value.appliedRegistry.models.every(row => object(row) && owns(row.provider))
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 6 * 1024 * 1024) throw new Error('Copilot CLI 配置恢复记录无效，未修改原文件。');
  return value as unknown as History;
}
function replace(path: string, content: string | null): void {
  safeDirectory(dirname(path));
  replacePrivateFile(path, content);
}
/** Unified undo preserves the same private credential-file permissions. */
export function replaceCopilotCliConfigFile(path: string, content: string | null): void { read(path); replace(path, content); }
function history(store: HistoryStore, providersPath: string, settingsPath: string): History | null {
  return recoverConfigJournal(store, copilotCliHistoryKey(providersPath), [providersPath, settingsPath], value => validateHistory(value, providersPath, settingsPath), read, replace);
}
export function recoverCopilotCliConfig(store: CopilotCliHistoryStore, homeDirectory = homedir(), options: CopilotCliConfigOptions = {}): void {
  const { providersPath, settingsPath } = copilotCliConfigTargets(homeDirectory, options);
  history(historyStore(store), providersPath, settingsPath);
}
function transact(store: HistoryStore, beforeFiles: FileState[], afterFiles: FileState[], before: History | null, after: History | null, options: CopilotCliConfigOptions): string {
  const target = beforeFiles[0].path;
  transactConfigFiles({ store, key: copilotCliHistoryKey(target), kind: 'copilot-cli-config', before, after,
    files: beforeFiles.map((file, index) => ({ path: file.path, before: file.content, after: afterFiles[index].content })),
    read, write: replace, order: [0, 1], beforeCommit: options.beforeCommit, afterFileCommit: options.afterFileCommit });
  return target;
}
function restore(store: HistoryStore, homeDirectory: string, options: CopilotCliConfigOptions): string {
  const { providersPath, settingsPath } = copilotCliConfigTargets(homeDirectory, options), before = history(store, providersPath, settingsPath);
  if (!before) return providersPath;
  const original = read(providersPath), settings = read(settingsPath), registry = parse(original), config = parse(settings, true);
  if (!isDeepStrictEqual(owned(registry), before.appliedRegistry)) throw new Error('Copilot CLI 受管来源或模型已被外部修改，未覆盖新修改。');
  const outputRegistry = mergeRegistry(registry, { providers: [], models: [] }, before);
  const desiredModel = isDeepStrictEqual(valueAt(config, 'model'), before.appliedModel) ? before.beforeModel : valueAt(config, 'model');
  const outputSettings = settingsContent(settings, desiredModel);
  const providersContent = !before.providersWasPresent && !Object.keys(outputRegistry).length ? null : json(outputRegistry);
  const settingsOutput = (settings === null || !before.settingsWasPresent) && !Object.keys(parse(outputSettings, true)).length && !/\/\/|\/\*/.test(outputSettings) ? null : outputSettings;
  return transact(store, [{ path: providersPath, content: original }, { path: settingsPath, content: settings }], [{ path: providersPath, content: providersContent }, { path: settingsPath, content: settingsOutput }], before, null, options);
}
export function applyCopilotCliConfig(store: CopilotCliConfigStore, _backups: string, homeDirectory = homedir(), options: CopilotCliConfigOptions = {}): string {
  const state = historyStore(store), selected = selection(store, true, options.port ?? 18181);
  if (!selected) return restore(state, homeDirectory, options);
  const { providersPath, settingsPath } = copilotCliConfigTargets(homeDirectory, options);
  const before = history(state, providersPath, settingsPath);
  const original = read(providersPath), settings = read(settingsPath), registry = parse(original), config = parse(settings, true);
  const current = owned(registry);
  if (!before && (current.providers.length || current.models.length)) throw new Error('Copilot CLI 的 ModelDock 来源或模型已存在且不属于 ModelDock，未覆盖原配置。');
  if (before && !isDeepStrictEqual(current, before.appliedRegistry)) throw new Error('Copilot CLI 受管来源或模型已被外部修改，未覆盖新修改。');
  const currentModel = valueAt(config, 'model'), appliedRegistry = { providers: selected.providers, models: selected.models };
  const next: History = { version: 1, providersPath, settingsPath, providersWasPresent: before?.providersWasPresent ?? original !== null, settingsWasPresent: before?.settingsWasPresent ?? settings !== null,
    providersField: before?.providersField ?? fieldKind(registry, 'providers'), modelsField: before?.modelsField ?? fieldKind(registry, 'models'),
    beforeModel: before && isDeepStrictEqual(currentModel, before.appliedModel) ? before.beforeModel : currentModel, appliedModel: { present: true, value: selected.model }, appliedRegistry };
  return transact(state, [{ path: providersPath, content: original }, { path: settingsPath, content: settings }],
    [{ path: providersPath, content: json(mergeRegistry(registry, appliedRegistry)) }, { path: settingsPath, content: settingsContent(settings, next.appliedModel) }], before, next, options);
}
export function restoreCopilotCliOfficialConfig(store: CopilotCliHistoryStore, _backups: string, homeDirectory = homedir(), options: CopilotCliConfigOptions = {}): string {
  return restore(historyStore(store), homeDirectory, options);
}
