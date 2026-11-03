import { resolveBindingModels } from '../shared/bindings';
import { modelDisplayLabel } from '../shared/model-names';
import { nativeClaudeBaseUrl } from '../shared/claude';
import { TRAE_PROVIDER_IDS, traeBaseUrl, type TraeProviderId } from '../shared/trae';
import type { ConfigPreview, Model, Provider, ProviderSecret, ToolBinding } from '../shared/types';
import { anthropicEndpoint } from './anthropic-endpoint';
import { validateUpstreamUrl } from './store';

/** The native TRAE CN 3.4.14 add_custom_model contract. Credentials are kept
 * in the main process; the renderer receives only a redacted plan. */
export interface TraeModelConfiguration {
  provider: TraeProviderId;
  model_name: string;
  is_custom: boolean;
  ak: string;
  isAkFromServer: boolean;
  auth_type: 0;
  base_url: string;
  display_name: string;
  clearReasoningParam: boolean;
  config_detail: {
    multimodal: boolean;
    model_hyper_params: {
      max_tokens?: number;
      prompt_max_tokens?: number;
      thinking_enable?: 0 | 1 | 2;
      reasoning_param?: { parameter: string; values: string[] };
    };
  };
}
export interface TraePlan {
  version: 1;
  models: { sourceId: string; configuration: TraeModelConfiguration }[];
}
export interface TraePlanStore {
  listModels(): Model[];
  listBindings(): ToolBinding[];
  listProviders?(): Provider[];
  getProvider?(id: string): Provider | undefined;
  getSecret?(id: string): ProviderSecret | undefined;
  gatewayKey(): string;
}

function endpoint(base: string, model: Model): string {
  if (model.wireApi === 'messages') return anthropicEndpoint(base, '/messages');
  return `${base.replace(/\/+$/, '')}/${model.wireApi === 'responses' ? 'responses' : 'chat/completions'}`;
}

function positiveLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Trae distinguishes input and output limits. Do not invent specifications for
 * unknown models or assume its free-form reasoning parameter accepts dot paths. */
function modelParameters(model: Model): TraeModelConfiguration['config_detail']['model_hyper_params'] {
  const params: TraeModelConfiguration['config_detail']['model_hyper_params'] = {};
  const context = positiveLimit(model.contextWindow), output = positiveLimit(model.maxOutputTokens), input = positiveLimit(model.maxInputTokens);
  if (output) params.max_tokens = context ? Math.min(output, Math.max(1, context - 1)) : output;
  const remaining = context ? Math.max(1, context - (params.max_tokens ?? 0)) : undefined;
  if (input) params.prompt_max_tokens = remaining ? Math.min(input, remaining) : input;
  else if (remaining && params.max_tokens) params.prompt_max_tokens = remaining;
  if (model.thinking !== undefined) params.thinking_enable = model.thinking ? 1 : 2;
  return params;
}

export function buildTraePlan(store: TraePlanStore, port: number, revealKey = false): TraePlan {
  const binding = store.listBindings().find(value => value.id === 'trae');
  if (!binding) throw new Error('尚未创建 Trae 配置。');
  if (binding.mode !== 'direct' && binding.mode !== 'aggregate') throw new Error('Trae 只支持供应商直连或聚合接口。');
  if (!binding.enabled) return { version: 1, models: [] };
  const allModels = store.listModels();
  const providers = store.listProviders?.() ?? [...new Set(allModels.map(model => model.providerId))]
    .map(id => store.getProvider?.(id)).filter((value): value is Provider => !!value);
  const requestedIds = [...new Set(binding.providerIds ?? allModels.filter(model => binding.modelIds.includes(model.id)).map(model => model.providerId))];
  if (binding.mode === 'direct') {
    if (requestedIds.length > 1) throw new Error('Trae 直连只能选择一家 API 供应商。');
    const provider = providers.find(value => value.id === requestedIds[0]);
    if (requestedIds.length && (!provider?.enabled || provider.kind !== 'openai-compatible')) throw new Error('Trae 直连需要已启用的 API 供应商；账号订阅请使用聚合接口。');
  }
  const models = resolveBindingModels(binding, allModels, providers);
  if (binding.mode === 'aggregate' && models.length && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('Trae 本机入口端口无效。');
  const ordered = [...models].sort((left, right) => Number(right.id === binding.defaultModelId) - Number(left.id === binding.defaultModelId));
  return { version: 1, models: ordered.map(model => {
    const provider = providers.find(value => value.id === model.providerId);
    if (!provider) throw new Error('Trae 模型的供应商不可用。');
    const aggregate = binding.mode === 'aggregate';
    if (!aggregate && provider.kind !== 'openai-compatible') throw new Error('账号订阅只能通过 Trae 聚合接口使用。');
    const upstreamBase = model.wireApi === 'messages' ? nativeClaudeBaseUrl(provider) ?? provider.baseUrl : provider.baseUrl;
    const base = aggregate ? traeBaseUrl(port) : validateUpstreamUrl(upstreamBase, port);
    const key = revealKey ? aggregate ? store.gatewayKey() : store.getSecret?.(provider.id)?.apiKey : aggregate ? '__MODELDOCK_LOCAL_KEY__' : '__PROVIDER_API_KEY__';
    if (typeof key !== 'string' || !key.trim()) throw new Error(aggregate ? 'Trae 本机入口凭据无效。' : 'Trae 所选供应商尚未配置 API Key。');
    const modelName = aggregate ? model.alias : model.upstreamId;
    if (!modelName.trim() || /[\x00-\x1f\x7f]/.test(modelName)) throw new Error('Trae 模型标识无效。');
    return { sourceId: model.id, configuration: {
      provider: TRAE_PROVIDER_IDS[model.wireApi], model_name: modelName,
      is_custom: true, ak: key, isAkFromServer: false, auth_type: 0,
      base_url: endpoint(base, model), display_name: [...`ModelDock · ${modelDisplayLabel(model, provider)}`].slice(0, 64).join(''),
      clearReasoningParam: true, config_detail: { multimodal: model.vision, model_hyper_params: modelParameters(model) },
    } };
  }) };
}

export function buildTraeConfig(store: TraePlanStore, port: number, revealKey = false): ConfigPreview {
  return {
    filename: 'modeldock-trae.json', content: JSON.stringify(buildTraePlan(store, port, revealKey), null, 2), canApply: true,
    instructions: 'Trae CN 原生模型同步计划。同步时请保持 Trae CN 运行并登录。只管理本机 ModelDock 创建的模型，保留已有模型、账号、会话和其他设置。聚合模式仅写入本地连接密钥；直连模式在应用或导出时写入所选供应商 API Key，预览隐藏密钥。只写入已知的输入、输出预算，未知限制不补默认值；思考档位参数不自动映射。如需在 Trae 中自行调整这些参数，请另建手动模型；直接修改托管模型会阻止后续同步，以保留你的修改。同步后请在 Trae 模型选择器中选择对应模型；不会切换已打开会话。此 JSON 是同步计划，不能作为 Trae settings.json 导入。',
  };
}
