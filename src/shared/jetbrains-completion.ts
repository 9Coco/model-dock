import type { Model, Provider, ToolBinding } from './types';
import { resolveBindingModels } from './bindings';
import { isJetBrainsTool, jetBrainsBaseUrl } from './jetbrains';
import { nativeDirectBaseUrl } from './single-entry';

export interface NativeJetBrainsCompletion {
  baseUrl: string;
  schemaId: 'fim.generic';
  maxOutputTokens: number;
}
/** 修改点：补全是独立原生接口能力，不从 Chat/Responses 支持情况推测。 */
function officialCompletionBaseUrl(provider: Provider): string | undefined {
  if (provider.kind !== 'openai-compatible' || provider.presetId !== 'deepseek') return;
  try {
    const url = new URL(provider.baseUrl);
    if (url.username || url.password || url.search || url.hash) return;
    if (!['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(url.href.replace(/\/+$/, ''))) return;
    return 'https://api.deepseek.com/beta';
  } catch { return; }
}
export function nativeJetBrainsCompletion(model: Model, provider: Provider): NativeJetBrainsCompletion | undefined {
  if (model.providerId !== provider.id || !['deepseek-flash', 'deepseek-v4-pro'].includes(model.upstreamId)) return;
  const baseUrl = officialCompletionBaseUrl(provider);
  return baseUrl ? { baseUrl, schemaId: 'fim.generic', maxOutputTokens: 4096 } : undefined;
}

export interface JetBrainsCompletionParameters {
  configured: boolean;
  supported: boolean;
  mode: 'direct' | 'aggregate';
  requestedModelId: string;
  reason?: string;
  baseUrl?: string;
  model?: string;
  schemaId?: 'fim.generic';
  maxOutputTokens?: number;
  provider?: 'OpenAI-compatible';
  keyIdentity?: string;
}
export function jetBrainsCompletionCandidates(binding: ToolBinding, models: readonly Model[], providers: readonly Provider[]): Model[] {
  if (!isJetBrainsTool(binding.id) || !binding.enabled) return [];
  return resolveBindingModels(binding, [...models], [...providers]).filter(model => {
    const provider = providers.find(item => item.id === model.providerId);
    return !!provider && !!nativeJetBrainsCompletion(model, provider);
  });
}
/** 共用聊天来源/聚合授权范围，可选择范围内的独立补全模型；不跨直连供应商。 */
export function jetBrainsCompletionParameters(binding: ToolBinding, models: readonly Model[], providers: readonly Provider[], port: number): JetBrainsCompletionParameters {
  const mode = binding.mode === 'direct' ? 'direct' : 'aggregate';
  const requestedModelId = binding.connectionChoices?.[mode]?.completionModelId || binding.defaultModelId;
  const unsupported: JetBrainsCompletionParameters = { configured: false, supported: false, mode, requestedModelId,
    reason: '当前模型没有已确认的 AI 补全接口；请选择已映射的 DeepSeek Flash / Pro，或在 IDE 内手动配置补全。' };
  const scoped = resolveBindingModels(binding, [...models], [...providers]);
  const model = scoped.find(item => item.id === requestedModelId) ?? scoped.find(item => item.id === binding.defaultModelId) ?? scoped[0];
  const provider = model && providers.find(item => item.id === model.providerId);
  const native = model && provider && nativeJetBrainsCompletion(model, provider);
  if (!isJetBrainsTool(binding.id) || !model || !provider) return unsupported;
  const baseUrl = mode === 'aggregate' ? jetBrainsBaseUrl(binding.id, port) : native?.baseUrl ?? officialCompletionBaseUrl(provider) ?? nativeDirectBaseUrl(binding.id, provider, scoped);
  if (!baseUrl) return unsupported;
  // 用户切换任何供应商都会更新补全地址/模型；未知补全协议先不激活，不能留上一家的地址。
  return { configured: true, supported: !!native, mode, requestedModelId, provider: 'OpenAI-compatible', baseUrl,
    model: mode === 'direct' ? model.upstreamId : model.alias, schemaId: 'fim.generic', ...(native ? { maxOutputTokens: native.maxOutputTokens } : { reason: unsupported.reason }),
    keyIdentity: mode === 'direct' ? `supplier:${provider.id}` : 'modeldock-local' };
}
