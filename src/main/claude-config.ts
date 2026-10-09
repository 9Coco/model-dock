import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ConfigPreview, Model, Provider, ProviderSecret, ToolBinding } from '../shared/types';
import { bindingConnectionPolicy, resolveBindingModels } from '../shared/bindings';
import { claudeConnectionKind, nativeClaudeBaseUrl } from '../shared/claude';
import { modelDisplayLabel } from '../shared/model-names';
import { anthropicBaseUrl } from './anthropic-endpoint';

export interface ClaudeConfigStore {
  listModels(): Model[];
  listBindings(): ToolBinding[];
  listProviders?(): Provider[];
  getProvider?(id: string): Provider | undefined;
  getSecret?(id: string): ProviderSecret | undefined;
  gatewayKey(): string;
  getManagedState?<T>(key: string, fallback: T): T;
  setManagedState?(key: string, value: unknown): void;
}
export interface ClaudeConfigHistoryStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
}
export interface ClaudeConfigOptions {
  claudeConfigDir?: string;
  port?: number;
  /** 修改点：仅供主进程事务测试，不能由渲染进程传入。 */
  beforeCommit?: () => void;
}

const maximumFileSize = 2 * 1024 * 1024;
const telemetryKey = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const modelEnvKeys = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'] as const;
const competingEnvKeys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'] as const;
const envKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', ...modelEnvKeys, ...competingEnvKeys] as const;
const bridgeEnvKeys = ['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'CLAUDE_CODE_DISABLE_THINKING'] as const;
const stringRootKeys = ['model', 'apiKeyHelper'] as const;
const pickerRootKeys = ['availableModels', 'modelPicker'] as const;
const rootKeys = [...stringRootKeys, ...pickerRootKeys] as const;
const allowedFields = new Set([...envKeys.map(key => `env.${key}`), ...bridgeEnvKeys.map(key => `env.${key}`), ...rootKeys]);
type Settings = Record<string, unknown> & { env?: Record<string, string> };
interface ClaudeModelPicker { options: { model: string; label: string }[]; replaceBuiltInOptions: true }
interface Value { present: boolean; value?: unknown }
interface FieldHistory { before: Value; applied: Value }
interface ClaudeHistory { version: 1; target: string; envWasPresent: boolean; fields: Record<string, FieldHistory> }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function claudeConfigDirectory(homeDirectory = homedir(), override?: string): string {
  // 修改点：测试传入独立 home 时不读取真实用户的 CLAUDE_CONFIG_DIR。
  const configured = override ?? (homeDirectory === homedir() ? process.env.CLAUDE_CONFIG_DIR : undefined);
  return configured?.trim() ? resolve(configured.trim()) : join(homeDirectory, '.claude');
}
export function claudeHistoryKey(target: string): string {
  const normalized = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target);
  return `tool-config:claude-code:${createHash('sha256').update(normalized).digest('hex')}`;
}
function selection(store: ClaudeConfigStore, revealKey: boolean, port: number): { binding: ToolBinding; env: Record<string, string>; model: string; authMode: 'api-key' | 'bearer'; localManaged: boolean; disableThinking: boolean; aggregate: boolean; availableModels: string[]; modelPicker: ClaudeModelPicker } | null {
  const binding = store.listBindings().find(item => item.id === 'claude-code');
  if (!binding) throw new Error('找不到 Claude Code 的配置。');
  if (!binding.enabled) return null;
  const allModels = store.listModels();
  const providers = store.listProviders?.() ?? (store.getProvider ? [...new Set(binding.providerIds ?? allModels.map(model => model.providerId))].flatMap(id => { const provider = store.getProvider!(id); return provider ? [provider] : []; }) : undefined);
  const models = resolveBindingModels(binding, allModels, providers);
  const requestedProviderIds = [...new Set(binding.providerIds ?? models.map(model => model.providerId))];
  const aggregate = binding.mode === 'aggregate';
  if (!aggregate && requestedProviderIds.length !== 1) throw new Error('Claude Code 单一来源模式必须选择恰好一个模型来源。');
  // 修改点：聚合只发布实际解析出的启用模型；禁用来源或精确范围之外的来源不阻断其他模型。
  const resolvedProviderIds = new Set(models.map(model => model.providerId));
  const providerIds = aggregate ? requestedProviderIds.filter(id => resolvedProviderIds.has(id)) : requestedProviderIds;
  const selectedProviders = providerIds.map(id => store.getProvider?.(id) ?? providers?.find(item => item.id === id));
  if (selectedProviders.some(provider => !provider || !provider.enabled)) throw new Error('Claude Code 需要已启用的模型来源。');
  if (selectedProviders.some(provider => provider?.messagesAuth !== undefined && !['api-key', 'bearer'].includes(provider.messagesAuth))) throw new Error('Claude Code Messages 鉴权方式无效。');
  const provider = selectedProviders[0]!;
  if (!models.length) throw new Error('Claude Code 需要至少一个可用模型，请先添加并选择模型。');
  const policy = bindingConnectionPolicy(binding, allModels, providers);
  const localManaged = binding.mode === 'aggregate';
  if (!localManaged && policy.groups[0]?.connection !== 'direct-api') throw new Error('Claude Code 直连需要原生 Messages API；订阅或其他协议请使用聚合接口。');
  if (localManaged && selectedProviders.some(provider => models.some(model => model.providerId === provider!.id) && (!provider!.hasSecret || provider!.authStatus !== 'ready'))) throw new Error('Claude Code 所选来源的凭据尚未就绪，请先保存 API Key 或完成订阅授权。');
  if (localManaged && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('Claude Code 本机入口端口无效。');
  const authMode = !localManaged && provider.messagesAuth === 'api-key' ? 'api-key' : 'bearer';
  const chosen = binding.defaultModelId ? models.find(model => model.id === binding.defaultModelId) : models[0];
  if (!chosen) throw new Error('Claude Code 默认模型必须属于所选来源的可用模型。');
  const model = localManaged ? chosen.alias : chosen.upstreamId;
  if (!model.trim() || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Claude Code 模型标识无效。');
  const key = localManaged ? revealKey ? store.gatewayKey() : '__MODELDOCK_LOCAL_KEY__' : revealKey ? store.getSecret?.(provider.id)?.apiKey : '__PROVIDER_API_KEY__';
  if (!key || typeof key !== 'string') throw new Error(localManaged ? 'Claude Code 本机入口凭据无效。' : 'Claude Code 直连供应商尚未填写 API Key。');
  // 修改点：Claude 原生 SDK 会追加 /v1/messages；只剥离末尾 /v1，保留套餐专属路径。
  // 修改点：推理测试和客户端必须使用同一鉴权头，不同时写入两套凭据触发原生身份冲突。
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: localManaged ? `http://127.0.0.1:${port}/tool/claude-code` : anthropicBaseUrl(nativeClaudeBaseUrl(provider) ?? provider.baseUrl), [authMode === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN']: key };
  for (const name of modelEnvKeys) env[name] = model;
  // 修改点：全部为原生 Messages 的聚合保留 thinking；混合 OpenAI 模型不能保证签名格式，关闭客户端对应协议。
  const disableThinking = localManaged && models.some(model => {
    const source = selectedProviders.find(item => item?.id === model.providerId)!;
    return claudeConnectionKind(source, [model]) === 'local-managed';
  });
  if (disableThinking) { env.MAX_THINKING_TOKENS = '0'; env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'; env.CLAUDE_CODE_DISABLE_THINKING = '1'; }
  // 修改点：隐私选择独立保留，取消来源或还原模型配置时不重新开启遥测。
  // 该开关按“非空”判断，不能用字符串 0/false 关闭，取消勾选时必须删除。
  if (binding.claudeDisableTelemetry !== false) env[telemetryKey] = '1';
  // 修改点：直连也发布供应商的真实模型 ID，SDK 模型发现不能只依靠默认模型和角色映射。
  const modelId = (item: Model) => aggregate ? item.alias : item.upstreamId;
  const options = models.filter((item, index) => models.findIndex(other => modelId(other) === modelId(item)) === index)
    .map(item => ({ model: modelId(item), label: modelDisplayLabel(item, selectedProviders.find(source => source?.id === item.providerId)) }));
  if (options.some(item => !item.model.trim() || /[\x00-\x1f\x7f]/.test(item.model))) throw new Error('Claude Code 模型标识无效。');
  return { binding, env, model, authMode, localManaged, disableThinking, aggregate,
    availableModels: options.map(item => item.model), modelPicker: { options, replaceBuiltInOptions: true } };
}

export function buildClaudeConfig(store: ClaudeConfigStore, revealKey = false, port = 18181): ConfigPreview {
  const selected = selection(store, revealKey, port);
  return { filename: 'modeldock-claude-code.json', canApply: true,
    content: JSON.stringify(selected ? { model: selected.model, env: selected.env, availableModels: selected.availableModels, modelPicker: selected.modelPicker } : {}, null, 2),
    instructions: selected
      ? (selected.localManaged ? `Claude Code CLI 通过 ModelDock 本机入口使用所选${selected.aggregate ? '聚合模型' : '单一来源'}。原生 Messages 模型按原协议转发，其他模型在本机转换为 Chat Completions 或 Responses 协议；API 密钥与订阅 OAuth 凭据留在主进程，仅将固定本机密钥写入工具。使用时需保持 ModelDock 入口运行。${selected.disableThinking ? '兼容桥关闭客户端 thinking 协议，不限制上游模型自身的推理；原生 Anthropic 服务端工具等专属能力不能由此保证。' : '全部所选模型使用原生 Messages 转发，保留客户端 thinking 设置。'}` : 'Claude Code CLI 使用单个 API 供应商的 Anthropic Messages 原生兼容入口；千问、火山与 DeepSeek 使用各自协议专属地址并复用已保存的 API Key，其他工具的 OpenAI 地址保持原值。')
        + (selected.authMode === 'api-key' ? '鉴权使用 ANTHROPIC_API_KEY 对应的 x-api-key 请求头；原生交互模式可能要求首次确认 API Key。' : '鉴权使用 ANTHROPIC_AUTH_TOKEN 对应的 Authorization: Bearer 请求头。')
        + '服务地址标准化为 SDK 追加 /v1/messages 前的根地址；默认模型与 Sonnet、Opus、Haiku、子代理角色均使用所选' + (selected.localManaged ? '本机模型别名。' : '真实上游 ID。')
        + '已启用模型写入 availableModels 与 modelPicker，可用 /model 切换；直连使用真实上游 ID，聚合使用本机别名。模型选择器要求 Claude Code v2.1.242 或更高版本，旧版可用 /model <模型 ID> 或 --model 切换。'
        + '预览隐藏密钥，导出或应用才写入所用凭据。同步仅合并用户 settings.json，不修改登录、权限、Hooks、MCP 或插件。冲突的另一种鉴权变量、OAuth、云供应商开关及 apiKeyHelper 会暂时移除并保存恢复记录；取消来源会恢复此前未被外部修改的字段。'
        + (selected.binding.claudeDisableTelemetry === false ? '当前未启用非必要联网关闭总开关，其他独立隐私选项保留。' : '默认关闭遥测、错误上报、反馈等非必要联网，并关闭自动更新；这不停止供应商模型请求，也不改变 WebFetch 域名安全检查。')
        + '重启 Claude Code 后用 /status 核对地址、凭据来源和模型。VS Code 内置 Claude 智能体会缓存凭据和模型列表，同步后按 Ctrl+Shift+P，运行 Developer: Restart Local Agent Host 重启代理主机以重新读取配置；仅 Reload Window 不保证刷新共用代理主机。Anthropic 官方 VS Code 扩展还需在 claudeCode.environmentVariables 设置凭据，Claude Desktop 本机 Code 会话共用用户设置，远端会话需在执行端配置。项目、托管设置、命令行以及继承环境可能影响最终配置，JSON 合并不能保证所有运行环境。'
      : '取消来源会撤销仍属于 ModelDock 的路由与模型字段，恢复其原值；用户后续修改、登录、权限、Hooks、MCP 和隐私设置保留。没有管理记录时不修改现有配置。',
  };
}

function metadata(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function safeDirectory(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    const info = metadata(current);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Claude Code 配置目录或父目录是链接或非目录，未修改原文件。');
    if (dirname(current) === current) break;
  }
}
function readFile(path: string): string | null {
  safeDirectory(dirname(path));
  const info = metadata(path);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximumFileSize) throw new Error('Claude Code 配置文件类型或大小不受支持，未修改原文件。');
  return readFileSync(path, 'utf8');
}
function parseSettings(text: string | null): Settings {
  if (text !== null && Buffer.byteLength(text, 'utf8') > maximumFileSize) throw new Error('Claude Code 配置文件过大，未修改原文件。');
  let value: unknown;
  try { value = text === null ? {} : JSON.parse(text); }
  catch { throw new Error('Claude Code 配置不是有效的 JSON，未修改原文件。'); }
  if (!record(value) || value.env !== undefined && (!record(value.env) || Object.values(value.env).some(item => typeof item !== 'string'))
    || stringRootKeys.some(key => value[key] !== undefined && typeof value[key] !== 'string')
    || value.availableModels !== undefined && (!Array.isArray(value.availableModels) || value.availableModels.some(item => typeof item !== 'string'))
    || value.modelPicker !== undefined && !record(value.modelPicker)) throw new Error('Claude Code 模型或 env 配置格式有误，未修改原文件。');
  return value as Settings;
}
function validValue(value: unknown): value is Value {
  return record(value) && typeof value.present === 'boolean' && Object.keys(value).every(key => key === 'present' || key === 'value')
    && (value.present ? value.value !== undefined : value.value === undefined);
}
function readHistory(store: ClaudeConfigHistoryStore, target: string): ClaudeHistory | null {
  const value = store.getManagedState<unknown>(claudeHistoryKey(target), null);
  if (value === null) return null;
  if (!record(value) || value.version !== 1 || value.target !== target || typeof value.envWasPresent !== 'boolean' || !record(value.fields)
    || Object.entries(value.fields).some(([key, field]) => !allowedFields.has(key) || !record(field) || !validValue(field.before) || !validValue(field.applied)
      || [field.before, field.applied].some(entry => entry.present && (key === 'availableModels' ? !Array.isArray(entry.value) || entry.value.some(item => typeof item !== 'string') : key === 'modelPicker' ? !record(entry.value) : typeof entry.value !== 'string')))) throw new Error('Claude Code 配置恢复记录无效，未修改原文件。');
  return value as unknown as ClaudeHistory;
}
function fieldValue(settings: Settings, field: string): Value {
  const env = field.startsWith('env.'), key = env ? field.slice(4) : field;
  const source = env ? settings.env : settings;
  return source && Object.hasOwn(source, key) ? { present: true, value: structuredClone(source[key]) } : { present: false };
}
function equalValue(a: Value, b: Value): boolean { return a.present === b.present && JSON.stringify(a.value) === JSON.stringify(b.value); }
function writeField(settings: Settings, field: string, value: Value): void {
  const env = field.startsWith('env.'), key = env ? field.slice(4) : field;
  if (env && !settings.env && value.present) settings.env = {};
  const target = env ? settings.env : settings;
  if (!target) return;
  if (value.present) (target as Record<string, unknown>)[key] = structuredClone(value.value); else delete target[key];
}
function matches(path: string, original: string | null): boolean { return readFile(path) === original; }
function replaceFile(path: string, content: string | null): void {
  if (content === null) { if (metadata(path)) unlinkSync(path); return; }
  safeDirectory(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.modeldock-${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function transact(store: ClaudeConfigHistoryStore, target: string, backups: string, original: string | null, output: string | null,
  before: ClaudeHistory | null, after: ClaudeHistory | null, options: ClaudeConfigOptions, official: boolean): string {
  const key = claudeHistoryKey(target), fileChanged = original !== output, stateChanged = JSON.stringify(before) !== JSON.stringify(after);
  if (!fileChanged && !stateChanged) return target;
  if (fileChanged && original !== null) {
    safeDirectory(backups); mkdirSync(backups, { recursive: true, mode: 0o700 });
    const backup = join(backups, `claude-code-${official ? 'official-' : ''}${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
    // 修改点：备份含用户 API Key，直接写入 0600，不能继承原配置的宽松权限。
    writeFileSync(backup, original, { mode: 0o600, flag: 'wx' }); chmodSync(backup, 0o600);
    if (readFileSync(backup, 'utf8') !== original) throw new Error('Claude Code 原配置备份验证失败，未修改原文件。');
  }
  let stateTouched = false, fileWritten = false;
  try {
    options.beforeCommit?.();
    if (!matches(target, original) || JSON.stringify(readHistory(store, target)) !== JSON.stringify(before)) throw new Error('Claude Code 配置刚被其他程序修改，请重新预览后再同步。');
    if (stateChanged) { stateTouched = true; store.setManagedState(key, after); }
    if (fileChanged) { replaceFile(target, output); fileWritten = true; }
    if (!matches(target, output)) throw new Error('Claude Code 配置写入验证失败。');
    return target;
  } catch (error) {
    try {
      if (fileWritten) {
        if (!matches(target, output)) throw new Error('外部配置已经变化。');
        replaceFile(target, original);
      }
      if (stateTouched) store.setManagedState(key, before);
    } catch { throw new Error('Claude Code 同步未完成，回滚遇到外部修改或存储错误；原配置备份已保留。'); }
    throw error;
  }
}
function rollbackManaged(settings: Settings, history: ClaudeHistory | null, official: boolean): void {
  if (!history) return;
  for (const [field, saved] of Object.entries(history.fields)) {
    // 修改点：仅撤销仍等于上次托管值的字段；后续手工修改始终保留。
    if (equalValue(fieldValue(settings, field), saved.applied)) writeField(settings, field, official ? { present: false } : saved.before);
  }
  if (settings.env && !Object.keys(settings.env).length && !history.envWasPresent) delete settings.env;
}

export function applyClaudeConfig(store: ClaudeConfigStore, backups: string, homeDirectory = homedir(), options: ClaudeConfigOptions = {}): string {
  if (!store.getManagedState || !store.setManagedState) throw new Error('Claude Code 同步需要安全的配置恢复记录存储，未修改原文件。');
  const stateStore = store as ClaudeConfigStore & ClaudeConfigHistoryStore;
  const target = join(claudeConfigDirectory(homeDirectory, options.claudeConfigDir), 'settings.json');
  const selected = selection(store, true, options.port ?? 18181), original = readFile(target), settings = parseSettings(original), history = readHistory(stateStore, target);
  if (!selected) {
    if (!history) return target;
    rollbackManaged(settings, history, false);
    const output = original === null && !Object.keys(settings).length ? null : JSON.stringify(settings, null, 2) + '\n';
    parseSettings(output);
    return transact(stateStore, target, backups, original, output, history, null, options, false);
  }
  const next: ClaudeHistory = { version: 1, target, envWasPresent: history?.envWasPresent ?? Object.hasOwn(settings, 'env'), fields: {} };
  const desired = new Map<string, Value>([['model', { present: true, value: selected.model }], ['apiKeyHelper', { present: false }]]);
  // 修改点：两种模式都更新模型选择器，原有列表只在取消来源时按管理记录恢复。
  for (const field of pickerRootKeys) desired.set(field, { present: true, value: selected[field] });
  for (const key of envKeys) desired.set(`env.${key}`, Object.hasOwn(selected.env, key) ? { present: true, value: selected.env[key] } : { present: false });
  for (const key of bridgeEnvKeys) {
    const field = `env.${key}`;
    if (selected.disableThinking) desired.set(field, { present: true, value: selected.env[key] });
    else {
      // 修改点：从桥接切回原生兼容接口时恢复用户原 thinking 配置，不让桥接限制残留。
      const saved = history?.fields[field];
      if (saved && equalValue(fieldValue(settings, field), saved.applied)) writeField(settings, field, saved.before);
    }
  }
  for (const [field, applied] of desired) {
    const current = fieldValue(settings, field), previous = history?.fields[field];
    // 明确重新同步可更新托管值；外部更改成为新的恢复起点，不丢失用户当前选择。
    next.fields[field] = { before: previous && equalValue(current, previous.applied) ? previous.before : current, applied };
    writeField(settings, field, applied);
  }
  if (Object.hasOwn(selected.env, telemetryKey)) settings.env![telemetryKey] = selected.env[telemetryKey];
  else delete settings.env![telemetryKey];
  const output = JSON.stringify(settings, null, 2) + '\n';
  parseSettings(output);
  return transact(stateStore, target, backups, original, output, history, next, options, false);
}

export function restoreClaudeOfficialConfig(store: ClaudeConfigHistoryStore, backups: string, homeDirectory = homedir(), options: ClaudeConfigOptions = {}): string {
  const target = join(claudeConfigDirectory(homeDirectory, options.claudeConfigDir), 'settings.json');
  const original = readFile(target), settings = parseSettings(original), history = readHistory(store, target);
  if (!history) return target;
  // 修改点：官方还原清理仍托管的模型/路由，不重新激活历史第三方来源；隐私选择不变。
  rollbackManaged(settings, history, true);
  const output = original === null && !Object.keys(settings).length ? null : JSON.stringify(settings, null, 2) + '\n';
  parseSettings(output);
  return transact(store, target, backups, original, output, history, null, options, true);
}
