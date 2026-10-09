import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { parse as parseJsonc, modify, applyEdits, createScanner, SyntaxKind, type Edit, type ParseError } from 'jsonc-parser';
import type { ConfigPreview, Model, Provider, ProviderSecret, ReasoningEffort, ToolBinding, ToolId } from '../shared/types';
import { bindingConnectionPolicy, resolveBindingModels } from '../shared/bindings';
import { modelDisplayLabel, modelLocalAlias } from '../shared/model-names';
import type { CopilotDesktopPlan } from './copilot-desktop';
import { dshPatchPreview, type DshPlan, type DshProviderProfile } from './dsh-config';
import { openCodeConfigDirectory } from './opencode-paths';
import { applyClaudeConfig, buildClaudeConfig } from './claude-config';
import { isJetBrainsTool } from '../shared/jetbrains';
import { applyJetBrainsConfig, buildJetBrainsConfig, type JetBrainsConfigOptions } from './jetbrains-config';

const PLACEHOLDER = '__MODELDOCK_LOCAL_KEY__';
// These are client request budgets, not inferred upstream model specifications.
const UNKNOWN_CONTEXT_BUDGET = 32768;
const UNKNOWN_OUTPUT_BUDGET = 4096;
function clientBudget(model: Model) {
  return model.contextWindow > 0
    ? { context: model.contextWindow, output: Math.max(1, Math.min(16384, Math.floor(model.contextWindow / 4))) }
    : { context: UNKNOWN_CONTEXT_BUDGET, output: UNKNOWN_OUTPUT_BUDGET };
}
function clientBudgetNotice(models: Model[]): string {
  return models.some(model => model.contextWindow === 0)
    ? '上下文未知的模型使用 32K（32768）上下文 / 4K（4096）输出的客户端配置预算；这不是上游模型规格或调用能力验证，可在模型编辑中填写实际上下文后重新生成配置。'
    : '';
}
interface AdapterStore {
  dataDir?: string;
  listModels(): Model[]; listBindings(): ToolBinding[]; gatewayKey(): string;
  listProviders?(): Provider[]; getProvider?(id: string): Provider | undefined; getSecret?(id: string): ProviderSecret | undefined;
  getManagedState?<T>(key: string, fallback: T): T; setManagedState?(key: string, value: unknown): void; createManagedBackup?(kind: string, value: unknown): string;
}
const selectionFields = ['model', 'model_provider', 'model_catalog_json'] as const;
type CodexSelectionFields = Partial<Record<typeof selectionFields[number], string>>;
interface CodexSelectionHistory { version: 1; target: string; fields: CodexSelectionFields }
export function codexHistoryKey(target: string): string { return `tool-config:codex:${createHash('sha256').update(process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target)).digest('hex')}`; }
function selectionFieldsFrom(value: Record<string, unknown>): CodexSelectionFields {
  const fields: CodexSelectionFields = {};
  for (const key of selectionFields) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string') throw new Error('Codex 模型选择字段格式有误，未修改原文件。');
    fields[key] = value[key] as string;
  }
  return fields;
}
function readCodexHistory(store: AdapterStore, target: string): CodexSelectionHistory | null {
  const value = store.getManagedState?.<unknown>(codexHistoryKey(target), null) ?? null;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex 配置恢复记录无效，未修改原文件。');
  const history = value as CodexSelectionHistory;
  if (history.version !== 1 || history.target !== target || !history.fields || typeof history.fields !== 'object' || Array.isArray(history.fields) || Object.keys(history.fields).some(key => !selectionFields.includes(key as typeof selectionFields[number]))) throw new Error('Codex 配置恢复记录无效，未修改原文件。');
  selectionFieldsFrom(history.fields);
  return history;
}
function ownsCodexCatalog(raw: string): boolean {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value.models) && value.models.every((model: any) => typeof model.description === 'string' && model.description.startsWith('ModelDock · '));
  } catch { return false; }
}
function clientModel(store: AdapterStore, model: Model, directApi = false): Model {
  const provider = store.getProvider?.(model.providerId) ?? store.listProviders?.().find(item => item.id === model.providerId);
  return { ...model, displayName: modelDisplayLabel(model, provider), alias: directApi ? model.upstreamId : model.alias };
}
function selected(store: AdapterStore, id: ToolId, allowEmpty = false) {
  const binding = store.listBindings().find(b => b.id === id);
  if (!binding || !binding.enabled && !allowEmpty) throw new Error('请先启用此工具并保存模型选择。');
  const models = resolveBindingModels(binding, store.listModels(), store.listProviders?.());
  if (id === 'codex' && binding.mode === 'direct' && binding.enabled && !models.length) throw new Error('Codex 直连需要原生 Responses API；订阅或其他协议请使用聚合接口。');
  if (!models.length && !allowEmpty) throw new Error('请至少选择一个模型。');
  return { binding, models };
}
interface ClientGroup { id: string; name: string; base: string; key: string; models: Model[]; directApi: boolean }
function connectionGroups(store: AdapterStore, tool: ToolId, binding: ToolBinding, port: number, revealKey: boolean): ClientGroup[] {
  const allModels = store.listModels();
  const providers = store.listProviders?.() ?? (store.getProvider ? [...new Set(allModels.map(model => model.providerId))].flatMap(id => { const p = store.getProvider!(id); return p ? [p] : []; }) : undefined);
  const policy = bindingConnectionPolicy(binding, allModels, providers);
  return policy.groups.filter(group => group.modelIds.length > 0).map(group => {
    const provider = providers?.find(item => item.id === group.providerIds[0]);
    const directApi = group.connection === 'direct-api';
    if (directApi && (!provider || group.providerIds.length !== 1)) throw new Error('供应商直连配置无效，请重新选择。');
    const id = policy.kind === 'native' ? `modeldock-${encodeURIComponent(group.providerIds[0])}` : 'modeldock';
    const name = policy.kind === 'native' ? `ModelDock · ${provider?.name ?? '订阅来源'}` : 'ModelDock';
    const base = directApi ? provider!.baseUrl.replace(/\/+$/, '') : `http://127.0.0.1:${port}/tool/${tool}/v1`;
    if (!base) throw new Error('请先为供应商填写套餐专属地址。');
    const apiKey = directApi && revealKey ? store.getSecret?.(provider!.id)?.apiKey : undefined;
    if (directApi && revealKey && !apiKey) throw new Error('直连供应商尚未填写 API Key。');
    return { id, name, base, directApi, key: directApi ? apiKey ?? '__PROVIDER_API_KEY__' : revealKey ? store.gatewayKey() : PLACEHOLDER,
      models: allModels.filter(model => group.modelIds.includes(model.id)).map(model => clientModel(store, model, directApi)) };
  });
}
function ownsOpenCodeProvider(id: string): boolean { return id === 'modeldock' || id.startsWith('modeldock-'); }
function ownsVsCodeProvider(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const provider = row as Record<string, unknown>;
  return provider.vendor === 'customendpoint' && typeof provider.name === 'string' && (provider.name === 'ModelDock' || provider.name.startsWith('ModelDock · '));
}
function jsoncComments(text: string): { text: string; offset: number; end: number }[] {
  const scanner = createScanner(text), comments: { text: string; offset: number; end: number }[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset(), end = offset + scanner.getTokenLength();
      comments.push({ text: text.slice(offset, end), offset, end });
    }
  }
  return comments;
}
/** jsonc-parser removes leading trivia when deleting a property. Keep user
 * comments at that edit position instead of discarding them with managed data. */
export function editJsonc(text: string, edits: Edit[]): string {
  const before = jsoncComments(text), after = jsoncComments(applyEdits(text, edits));
  const deficit = new Map<string, number>();
  for (const comment of before) deficit.set(comment.text, (deficit.get(comment.text) ?? 0) + 1);
  for (const comment of after) deficit.set(comment.text, (deficit.get(comment.text) ?? 0) - 1);
  const preserved = edits.map(edit => ({ ...edit }));
  const prefixes = edits.map(() => [] as string[]);
  for (const comment of before) {
    if ((deficit.get(comment.text) ?? 0) <= 0) continue;
    const index = edits.findIndex(edit => edit.offset <= comment.offset && edit.offset + edit.length >= comment.end);
    if (index < 0) continue;
    prefixes[index].push(comment.text);
    deficit.set(comment.text, deficit.get(comment.text)! - 1);
  }
  preserved.forEach((edit, index) => { if (prefixes[index].length) edit.content = `${prefixes[index].join('\n')}\n${edit.content}`; });
  let result = applyEdits(text, preserved);
  // Formatting edits can occasionally intersect only part of a block comment.
  // Preserve any remaining lost token safely outside the JSON structure.
  const remaining = new Map<string, number>();
  for (const comment of jsoncComments(result)) remaining.set(comment.text, (remaining.get(comment.text) ?? 0) + 1);
  const missing: string[] = [];
  for (const comment of before) {
    const count = remaining.get(comment.text) ?? 0;
    if (count > 0) remaining.set(comment.text, count - 1); else missing.push(comment.text);
  }
  if (missing.length) result = `${missing.join('\n')}\n${result}`;
  return result;
}
/** Only call from a trusted main-process copy/export action. */
export function connectionKey(store: AdapterStore, tool: ToolId): string {
  const { binding } = selected(store, tool);
  const groups = connectionGroups(store, tool, binding, 18181, true);
  if (groups.length !== 1) throw new Error('此工具使用多个供应商的独立凭据，请导出配置；没有共用的单一连接密钥。');
  return groups[0].key;
}
/** Codex catalog entries need a label per level; VS Code supplies its own labels. */
const CODEX_REASONING_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  none: 'Disables reasoning', minimal: 'Minimal reasoning effort', low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth', high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems', max: 'Maximum reasoning depth for the hardest problems',
};
function vscode(groups: ClientGroup[]) {
  // VS Code 把 customendpoint 的 apiKey 当作其秘密存储的 ${input:...} 引用解析，chatLanguageModels.json
  // 里的明文会被解析为空；requestHeaders 原样透传且允许覆盖 authorization，凭据必须随模型放在这里。
  return groups.map(group => ({ name: group.name, vendor: 'customendpoint', apiKey: group.key, models: group.models.map(m => ({
    id: m.alias, name: m.displayName || m.alias, apiType: m.wireApi,
    url: group.base + (m.wireApi === 'responses' ? '/responses' : '/chat/completions'),
    toolCalling: m.tools, vision: m.vision, contextWindow: clientBudget(m).context,
    maxOutputTokens: clientBudget(m).output,
    requestHeaders: { authorization: `Bearer ${group.key}` },
    // Without supportsReasoningEffort VS Code shows no Thinking Effort picker.
    ...(m.reasoningEfforts?.length ? { supportsReasoningEffort: [...m.reasoningEfforts], ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}) } : {}),
  })) }));
}
function nativeCopilotId(namespace: string, kind: 'provider' | 'model', id: string): string {
  const value = createHash('sha1').update(`ModelDock/Copilot/v1/${namespace}/${kind}/${id}`).digest().subarray(0, 16);
  value[6] = (value[6] & 0x0f) | 0x50; value[8] = (value[8] & 0x3f) | 0x80;
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Only the main process requests revealed keys for native synchronization. */
export function buildCopilotDesktopPlan(store: AdapterStore, port: number, revealKey = false): CopilotDesktopPlan {
  const { binding } = selected(store, 'copilot', true);
  const groups = connectionGroups(store, 'copilot', binding, port, revealKey);
  const namespace = store.dataDir ? (process.platform === 'win32' ? resolve(store.dataDir).toLowerCase() : resolve(store.dataDir)) : 'adapter-fixture';
  const originals = store.listModels();
  return { providers: groups.map(group => {
    const id = nativeCopilotId(namespace, 'provider', group.id);
    const providerIds = [...new Set(group.models.map(model => model.providerId))];
    const name = group.name === 'ModelDock' ? providerIds.length === 1
      ? `ModelDock · ${store.getProvider?.(providerIds[0])?.name ?? store.listProviders?.().find(provider => provider.id === providerIds[0])?.name ?? '模型来源'}`
      : 'ModelDock · 聚合供应商' : group.name;
    return { id, name, baseUrl: group.base, apiKey: group.key, models: group.models.map(model => {
      const original = originals.find(value => value.id === model.id) ?? model;
      const budget = clientBudget(model);
      return { id: nativeCopilotId(namespace, 'model', `${group.id}/${model.id}`),
        modelId: group.directApi ? modelLocalAlias(original) : model.alias,
        wireModel: group.directApi ? model.upstreamId : model.alias,
        displayName: model.displayName || model.alias,
        wireApi: model.wireApi === 'responses' ? 'responses' as const : 'chat' as const,
        // Copilot stores an input budget, separately from the output budget.
        contextWindow: model.contextWindow > 0 ? budget.context - budget.output : 0,
        maxOutputTokens: budget.output,
        ...(model.reasoningEfforts?.length ? { supportedReasoningEfforts: [...model.reasoningEfforts] } : {}),
      };
    }) };
  }) };
}
/** Native DSH patch/credential plan; only the main process reveals API keys. */
export function buildDshPlan(store: AdapterStore, port: number, revealKey = false): DshPlan {
  const { binding } = selected(store, 'dsh', true);
  const syncScope = binding.dshSyncScope ?? 'selected';
  if (!['managed', 'selected'].includes(syncScope)) throw new Error('DSH 同步范围无效。');
  const groups = connectionGroups(store, 'dsh', binding, port, revealKey);
  const providers: Record<string, DshProviderProfile> = {}, credentials: Record<string, string> = {};
  const legacyCandidates: { model: string; targetProvider: string; targetModel: string }[] = [];
  let defaultModel: DshPlan['defaultModel'];
  for (const group of groups) {
    const protocols = [...new Set(group.models.map(model => model.wireApi))];
    const reference = `MODELDOCK_DSH_${createHash('sha256').update(group.id).digest('hex').slice(0, 20).toUpperCase()}_API_KEY`;
    credentials[reference] = group.key;
    for (const protocol of protocols) {
      const route = protocols.length > 1 ? `${group.id}-${protocol}` : group.id;
      const sourceModels = group.models.filter(model => model.wireApi === protocol);
      const distinctModels = sourceModels.filter((model, index) => sourceModels.findIndex(value => value.alias === model.alias) === index);
      providers[route] = { displayName: group.name, baseURL: group.base, apiKeyEnv: reference,
        api: protocol === 'responses' ? 'openai-responses' : 'openai-completions',
        models: distinctModels.map(model => ({ id: model.alias, name: model.displayName || model.alias,
          contextWindow: clientBudget(model).context, maxTokens: clientBudget(model).output, input: model.vision ? ['text', 'image'] as ('text' | 'image')[] : ['text'] as ('text' | 'image')[],
          ...(model.reasoningEfforts?.length ? { reasoningEfforts: [...model.reasoningEfforts] } : {}) })),
      };
      // Only the official DeepSeek API with the exact upstream ID can replace
      // a legacy DeepSeek dispatch. Similar display names or third-party plans
      // never authorize an automatic cross-model or cross-service fallback.
      let official = false;
      try { const url = new URL(group.base); official = group.directApi && url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash && ['', '/v1'].includes(url.pathname.replace(/\/+$/, '')); } catch { /* Not a verified official source. */ }
      if (syncScope === 'selected' && official) for (const model of distinctModels) if (model.alias === model.upstreamId) legacyCandidates.push({ model: model.upstreamId, targetProvider: route, targetModel: model.alias });
      const preferred = sourceModels.find(model => model.id === binding.defaultModelId);
      if (preferred) defaultModel = { provider: route, model: preferred.alias };
    }
  }
  if (!defaultModel && groups.length) {
    const route = Object.keys(providers)[0]; defaultModel = { provider: route, model: providers[route].models[0].id };
  }
  const mappings: NonNullable<DshPlan['legacyDispatch']>['mappings'] = [];
  for (const model of [...new Set(legacyCandidates.map(value => value.model))]) {
    const candidates = legacyCandidates.filter(value => value.model === model);
    const target = candidates.length === 1 ? candidates[0] : candidates.find(value => value.targetProvider === defaultModel?.provider && value.targetModel === defaultModel.model);
    if (target) for (const legacyProvider of ['deepseek-official', 'deepseek-account'] as const) mappings.push({ legacyProvider, ...target });
  }
  return { syncScope, providers, credentials, ...(defaultModel ? { defaultModel } : {}), ...(mappings.length ? { legacyDispatch: { version: 1 as const, mappings } } : {}) };
}
export function buildConfig(store: AdapterStore, tool: ToolId, port: number, revealKey = false, homeDirectory = homedir(), options: { jetBrainsOptions?: JetBrainsConfigOptions } = {}): ConfigPreview {
  if (isJetBrainsTool(tool)) return buildJetBrainsConfig(store, tool, port, revealKey, homeDirectory, options.jetBrainsOptions);
  // 修改点：Claude Code 按原生 Messages 入口或本机协议桥生成配置，不能落入其他工具适配分支。
  if (tool === 'claude-code') return buildClaudeConfig(store, revealKey, port);
  const selection = selected(store, tool, true);
  const { binding } = selection;
  if (binding.vscodeSyncScope !== undefined && !['managed', 'selected'].includes(binding.vscodeSyncScope)) throw new Error('VS Code 同步范围无效。');
  if (tool === 'codex' && selection.models.length && binding.mode === 'direct' && binding.providerIds?.length !== 1) throw new Error('Codex 直连模式请只选择一家供应商。');
  const groups = connectionGroups(store, tool, binding, port, revealKey);
  if (tool === 'codex' && binding.mode === 'direct' && binding.enabled && (!groups.length || groups.some(group => !group.directApi))) throw new Error('Codex 直连需要原生 Responses API；订阅或其他协议请使用聚合接口。');
  const models = groups.flatMap(group => group.models);
  const first = groups[0];
  const connection = !groups.length ? '没有选择供应商：应用将清理本工具中由 ModelDock 管理的分组，保留其他配置。'
    : groups.some(group => group.directApi) ? 'API 来源按供应商分别直连上游，使用真实模型 ID；订阅来源经本机入口管理授权续期。预览隐藏密钥，导出或应用才写入 API Key。'
      : binding.mode === 'direct' ? '订阅单源模式：只使用所选订阅，由本机入口管理授权续期，不把 OAuth 凭据写入工具。'
        : '通过本机入口按模型别名分发到所选供应商，不把 OAuth 凭据写入工具。';
  const defaultModel = models.find(m => m.id === binding.defaultModelId) ?? models[0];
  if (tool === 'vscode') return {
    filename: 'modeldock-vscode.json', content: JSON.stringify(vscode(groups), null, 2), canApply: true,
    instructions: connection + '使用 VS Code Copilot Chat 的 Custom Endpoint schema；凭据随每个模型的 requestHeaders 写入（apiKey 明文字段会被 VS Code 当作秘密存储引用忽略）。'
      + (binding.vscodeSyncScope === 'managed' ? '当前范围仅替换 ModelDock 分组，保留其他自定义来源。' : '当前范围仅保留所选自定义供应商：原文件先备份，所有 customendpoint 分组会替换为当前选择；保留其他 vendor 和注释。')
      + '默认仅写入 Code/User/chatLanguageModels.json；其他 profile 需在对应的模型配置文件中手动合并导出内容。同步后重新加载窗口。' + clientBudgetNotice(models),
  };
  if (tool === 'opencode') {
    const provider = Object.fromEntries(groups.map(group => [group.id, { name: group.name,
      npm: group.models[0].wireApi === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
      options: { baseURL: group.base, apiKey: group.key }, models: Object.fromEntries(group.models.map(model => [model.alias, {
      name: model.displayName || model.alias,
      provider: { npm: model.wireApi === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible' },
      limit: clientBudget(model),
      tool_call: model.tools, modalities: { input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] },
    }])) }]));
    const defaultGroup = defaultModel && groups.find(group => group.models.some(model => model.id === defaultModel.id));
    return { filename: 'modeldock-opencode.json', canApply: true,
      content: JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...(defaultGroup ? { model: `${defaultGroup.id}/${defaultModel.alias}` } : {}), provider }, null, 2),
      instructions: connection + '合并到 OpenCode 全局配置，保留其他供应商、MCP 和现有注释。各模型的 SDK 按其协议选择。' + clientBudgetNotice(models),
    };
  }
  if (tool === 'copilot') {
    return { filename: 'modeldock-copilot-desktop.json', canApply: true,
      content: JSON.stringify(buildCopilotDesktopPlan(store, port, revealKey), null, 2),
      instructions: connection + '请先运行 GitHub Copilot 桌面应用。同步通过原生接口管理供应商与模型，凭据由 Copilot 保存到系统凭据存储。'
        + (binding.copilotSyncScope === 'managed' ? '只更新 ModelDock 管理的来源，保留其他自定义来源。' : '只保留所选自定义供应商：清理旧自定义来源前，私有加密备份其原生配置和凭据；保留 GitHub 内置模型和账号。')
        + '此内容是原生同步计划，预览隐藏凭据；无需在 Copilot 中再次填写配置。同步后在模型选择器中选择模型，ModelDock 首选不会替换已经打开的聊天模型。清理来源不删除聊天正文，旧会话与被移除来源的关联可能由 Copilot 解除。',
    };
  }
  if (tool === 'dsh') return { filename: 'modeldock-dsh.patch.yml', canApply: true,
    content: dshPatchPreview(buildDshPlan(store, port, false)),
    instructions: connection + '自动同步到 DSH_HOME（未设置时为 ~/.dsh）的 cordis.patch.yml 与 .credentials.yaml；插件使用原生 llm-pi-ai 和 agent-default-model schema，凭据写入独立 refs。同步前保存加密备份。'
      + (binding.dshSyncScope === 'managed' ? '保留 DSH 原有模型来源并合并 ModelDock 来源；清空时恢复原 home 插件覆盖。' : '仅显示所选 ModelDock 模型来源，隐藏其他模型适配器；清空后保持无自定义模型来源，关闭此范围后恢复原来源。')
      + '原 profile、账号授权、其他插件与凭据保留。默认模型影响新会话，正在运行且启用原生热更新的 DSH 可自动加载；此预览不包含凭据值。' + clientBudgetNotice(models),
  };
  if (!models.length) return { filename: 'modeldock-codex.toml', content: '', canApply: true,
    instructions: '移除 ModelDock 供应商配置并保留原生授权、MCP 和其他供应商。仍使用 ModelDock 时恢复本机记录的原模型选择；旧版没有恢复记录时回到 Codex 原生默认配置。用户已切换其他供应商时保留当前选择。',
  };
  const responses = models.filter(m => m.wireApi === 'responses');
  if (!responses.length) throw new Error('Codex 接入需要 Responses 模型，请在模型目录设置协议后再选择。');
  const chosen = responses.find(m => m.id === binding.defaultModelId) ?? responses[0];
  return { filename: 'modeldock-codex.toml', canApply: true,
    content: stringifyToml({ model: chosen.alias, model_provider: 'modeldock', model_providers: { modeldock: {
      name: 'ModelDock', base_url: first.base, wire_api: 'responses', requires_openai_auth: false,
      experimental_bearer_token: first.key,
    } } }),
    instructions: connection + '应用会合并 ~/.codex/config.toml，保留 MCP 等其他设置并备份原文件，同时生成模型目录。此接入只发布 Responses 模型；更改后重启 Codex CLI/桌面服务。'
      + (responses.some(model => model.contextWindow === 0) ? '上下文未知的模型省略可选上下文字段；可在模型编辑中填写实际上下文后重新生成配置。' : ''),
  };
}
export function applyConfig(store: AdapterStore, tool: ToolId, port: number, appData: string, backups: string, homeDirectory = homedir(), options: { codexHome?: string; configHome?: string; claudeConfigDir?: string; jetBrainsOptions?: JetBrainsConfigOptions } = {}): string {
  if (isJetBrainsTool(tool)) return applyJetBrainsConfig(store, tool, backups, homeDirectory, { ...options.jetBrainsOptions, port });
  if (tool === 'claude-code') return applyClaudeConfig(store, backups, homeDirectory, { claudeConfigDir: options.claudeConfigDir, port });
  if (tool === 'copilot') throw new Error('Copilot 桌面配置需要通过运行中的原生接口同步。');
  if (tool === 'dsh') throw new Error('DSH 配置需要通过原生插件与凭据同步入口应用。');
  const config = buildConfig(store, tool, port, true);
  if (!config.canApply) throw new Error('此工具暂支持预览和导出，请通过其配置入口合并。');
  // 修改点：同步、还原、MCP/Skills 使用同一 XDG 配置根，避免写入未被 OpenCode 读取的默认目录。
  const openCodeDir = openCodeConfigDirectory(homeDirectory, options.configHome);
  const openCodeJsonc = join(openCodeDir, 'opencode.jsonc');
  const target = tool === 'vscode' ? join(appData, 'Code', 'User', 'chatLanguageModels.json')
    : tool === 'opencode' ? (existsSync(openCodeJsonc) ? openCodeJsonc : join(openCodeDir, 'opencode.json')) : join(options.codexHome ?? join(homeDirectory, '.codex'), 'config.toml');
  const original = existsSync(target) ? readFileSync(target, 'utf8') : null;
  let output: string;
  let companion: { path: string; content: string | null; original: string | null } | undefined;
  let historyChange: { key: string; before: CodexSelectionHistory | null; after: CodexSelectionHistory | null } | undefined;
  if (tool === 'opencode') {
    const errors: ParseError[] = [];
    const current = original ? parseJsonc(original, errors, { allowTrailingComma: true }) : {};
    if (errors.length || !current || typeof current !== 'object' || Array.isArray(current)) throw new Error('OpenCode 配置格式有误，未修改原文件。');
    if (current.provider !== undefined && (!current.provider || typeof current.provider !== 'object' || Array.isArray(current.provider))) throw new Error('OpenCode provider 配置格式有误。');
    const addition = JSON.parse(config.content);
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    output = original ?? '{}';
    for (const id of Object.keys(current.provider ?? {}).filter(ownsOpenCodeProvider)) {
      output = editJsonc(output, modify(output, ['provider', id], undefined, options));
    }
    for (const [id, provider] of Object.entries(addition.provider)) output = editJsonc(output, modify(output, ['provider', id], provider, options));
    if (addition.model) output = editJsonc(output, modify(output, ['model'], addition.model, options));
    else if (typeof current.model === 'string' && ownsOpenCodeProvider(current.model.split('/', 1)[0])) output = editJsonc(output, modify(output, ['model'], undefined, options));
  } else if (tool === 'vscode') {
    const parseErrors: ParseError[] = [];
    const rows = original ? parseJsonc(original, parseErrors, { allowTrailingComma: true }) : [];
    if (parseErrors.length) throw new Error('VS Code 模型文件格式有误，未修改原文件。');
    if (!Array.isArray(rows)) throw new Error('VS Code 模型文件不是数组，未修改原文件。');
    output = original ?? '[]';
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    const scope = store.listBindings().find(binding => binding.id === 'vscode')?.vscodeSyncScope ?? 'selected';
    for (let index = rows.length - 1; index >= 0; index--) {
      if (scope === 'selected' ? rows[index]?.vendor === 'customendpoint' : ownsVsCodeProvider(rows[index])) output = editJsonc(output, modify(output, [index], undefined, options));
    }
    const remaining = parseJsonc(output) as unknown[];
    const additions = JSON.parse(config.content) as unknown[];
    additions.forEach((row, index) => { output = editJsonc(output, modify(output, [remaining.length + index], row, { ...options, isArrayInsertion: true })); });
  } else {
    let existing: Record<string, any>;
    try { existing = original ? parseToml(original) : {}; }
    catch { throw new Error('Codex 配置格式有误，未修改原文件。'); }
    const addition = parseToml(config.content);
    const providers = (existing.model_providers ?? {}) as Record<string, unknown>;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error('Codex 供应商配置格式有误，未修改原文件。');
    const newProviders = addition.model_providers as Record<string, unknown>;
    const selectedModels = selected(store, 'codex', true);
    const models = connectionGroups(store, 'codex', selectedModels.binding, port, false).flatMap(group => group.models).filter(model => model.wireApi === 'responses');
    const catalogPath = join(dirname(target), 'modeldock-models.json');
    const history = readCodexHistory(store, target);
    if (!models.length) {
      const next = { ...existing }, remainingProviders = { ...providers };
      delete remainingProviders.modeldock;
      if (Object.keys(remainingProviders).length) next.model_providers = remainingProviders; else delete next.model_providers;
      if (existing.model_provider === 'modeldock') {
        for (const field of ['model', 'model_provider'] as const) {
          if (history?.fields[field] !== undefined) next[field] = history.fields[field]; else delete next[field];
        }
      }
      if (existing.model_catalog_json === catalogPath) {
        if (history?.fields.model_catalog_json !== undefined) next.model_catalog_json = history.fields.model_catalog_json; else delete next.model_catalog_json;
      }
      const catalogOriginal = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : null;
      if (catalogOriginal !== null && ownsCodexCatalog(catalogOriginal) && next.model_catalog_json !== catalogPath) companion = { path: catalogPath, original: catalogOriginal, content: null };
      if (store.getManagedState && store.setManagedState) historyChange = { key: codexHistoryKey(target), before: history, after: null };
      output = stringifyToml(next as Parameters<typeof stringifyToml>[0]);
    } else {
    if (existing.model_provider !== 'modeldock' && store.getManagedState && store.setManagedState) historyChange = {
      key: codexHistoryKey(target), before: history, after: { version: 1, target, fields: selectionFieldsFrom(existing) },
    };
    const catalog = { models: models.map(m => ({ slug: m.alias, display_name: m.displayName, description: `ModelDock · ${m.upstreamId}`,
      ...(m.contextWindow > 0 ? { context_window: m.contextWindow } : {}), supports_parallel_tool_calls: m.tools, input_modalities: m.vision ? ['text', 'image'] : ['text'],
      supported_reasoning_levels: (m.reasoningEfforts ?? []).map(level => ({ effort: level, description: CODEX_REASONING_DESCRIPTIONS[level] })), default_reasoning_level: m.defaultReasoningEffort ?? null, visibility: 'list', supported_in_api: true, priority: 100,
      shell_type: 'unified_exec', support_verbosity: false, supports_reasoning_summaries: false,
      truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
      base_instructions: 'You are a coding assistant. Follow the user’s instructions and use the available tools to complete their task.',
    })) };
    companion = { path: catalogPath, content: JSON.stringify(catalog, null, 2),
      original: existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : null };
    output = stringifyToml({ ...existing, ...addition, model_providers: { ...providers, ...newProviders }, model_catalog_json: catalogPath } as Parameters<typeof stringifyToml>[0]);
    }
  }
  if (tool === 'vscode' || tool === 'opencode') {
    const errors: ParseError[] = [];
    parseJsonc(output, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('配置合并未生成有效的 JSONC，未修改原文件。');
  }
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (original !== null) {
    const backupPath = join(backups, `${tool}-${stamp}.bak`);
    copyFileSync(target, backupPath);
    // Guard against another application changing the file while the backup is made.
    if (readFileSync(target, 'utf8') !== original) throw new Error('配置刚被其他程序修改，请重新预览后再应用。');
  }
  if (companion?.original !== null && companion?.original !== undefined) {
    copyFileSync(companion.path, join(backups, `${tool}-models-${stamp}.bak`));
  }
  const unchanged = (path: string, before: string | null) => before === null ? !existsSync(path) : existsSync(path) && readFileSync(path, 'utf8') === before;
  if (!unchanged(target, original) || (companion && !unchanged(companion.path, companion.original))) {
    throw new Error('配置刚被其他程序修改，请重新预览后再应用。');
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = target + '.modeldock.tmp';
  let companionWritten = false, historyWritten = false;
  try {
    if (historyChange) { store.setManagedState!(historyChange.key, historyChange.after); historyWritten = true; }
    writeFileSync(temporary, output, { mode: 0o600 });
    if (companion) {
      if (companion.content === null) unlinkSync(companion.path);
      else { writeFileSync(companion.path + '.modeldock.tmp', companion.content, { mode: 0o600 }); renameSync(companion.path + '.modeldock.tmp', companion.path); }
      companionWritten = true;
    }
    renameSync(temporary, target);
  } catch (error) {
    if (historyChange && historyWritten) store.setManagedState!(historyChange.key, historyChange.before);
    if (companion && companionWritten) {
      if (companion.original === null) unlinkSync(companion.path);
      else { writeFileSync(companion.path + '.modeldock.rollback', companion.original, { mode: 0o600 }); renameSync(companion.path + '.modeldock.rollback', companion.path); }
    }
    throw error;
  } finally {
    for (const path of [temporary, companion ? companion.path + '.modeldock.tmp' : '']) if (path && existsSync(path)) unlinkSync(path);
  }
  return target;
}
