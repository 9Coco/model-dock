import type { Model, Provider, ToolBinding, ToolId, ToolConnectionChoices } from './types';
import { claudeModelsForProvider, nativeClaudeBaseUrl } from './claude';
import { isJetBrainsTool, nativeJetBrainsBaseUrl } from './jetbrains';

/** 修改点：这些客户端只消费一个入口，来源多选只属于聚合入口内部。 */
export function isSingleEntryTool(tool: ToolId): boolean { return tool === 'codex' || tool === 'claude-code' || isJetBrainsTool(tool); }
export function directModelsForProvider(tool: ToolId, provider: Provider, models: readonly Model[]): Model[] {
  if (!provider.enabled || provider.kind !== 'openai-compatible') return [];
  const available = models.filter(model => model.enabled && model.providerId === provider.id);
  if (tool === 'codex') return available.filter(model => model.wireApi === 'responses');
  if (tool === 'claude-code') return nativeClaudeBaseUrl(provider) ? claudeModelsForProvider(provider, available) : available.filter(model => model.wireApi === 'messages');
  if (isJetBrainsTool(tool)) return available.filter(model => model.wireApi === 'chat-completions' || nativeJetBrainsBaseUrl(provider) && model.wireApi === 'responses');
  return available.filter(model => model.wireApi !== 'messages');
}
export function nativeDirectBaseUrl(tool: ToolId, provider: Provider, models: readonly Model[]): string | undefined {
  if (provider.kind !== 'openai-compatible' || !provider.enabled || !models.length) return;
  const eligible = new Set(directModelsForProvider(tool, provider, models).map(model => model.id));
  if (models.some(model => !eligible.has(model.id))) return;
  if (tool === 'claude-code') return nativeClaudeBaseUrl(provider) ?? provider.baseUrl.replace(/\/+$/, '');
  if (isJetBrainsTool(tool)) return nativeJetBrainsBaseUrl(provider) ?? provider.baseUrl.replace(/\/+$/, '');
  return provider.baseUrl.replace(/\/+$/, '');
}
function capture(binding: ToolBinding): ToolConnectionChoices {
  const choices: ToolConnectionChoices = structuredClone(binding.connectionChoices ?? {});
  if (binding.mode === 'direct') choices.direct = { ...choices.direct, providerId: binding.providerIds?.[0] ?? '', defaultModelId: binding.defaultModelId };
  else choices.aggregate = { ...choices.aggregate, providerIds: [...(binding.providerIds ?? [])], modelIds: [...binding.modelIds], defaultModelId: binding.defaultModelId, ...(binding.modelSelection ? { modelSelection: binding.modelSelection } : {}) };
  return choices;
}
/** Keep both mode drafts; callers persist only the active flat fields as gateway permissions. */
export function switchSingleEntryMode(binding: ToolBinding, mode: 'direct' | 'aggregate', models: readonly Model[], providers: readonly Provider[]): ToolBinding {
  if (!isSingleEntryTool(binding.id)) return { ...binding, mode };
  const choices = capture(binding);
  if (mode === 'direct') {
    if (!choices.direct) {
      const defaultModel = models.find(model => model.id === binding.defaultModelId);
      const provider = providers.find(provider => provider.id === defaultModel?.providerId);
      const eligible = provider && directModelsForProvider(binding.id, provider, models);
      choices.direct = { providerId: eligible?.some(model => model.id === defaultModel?.id) ? provider!.id : '', defaultModelId: eligible?.some(model => model.id === defaultModel?.id) ? defaultModel!.id : '' };
    }
    const choice = choices.direct;
    const provider = providers.find(provider => provider.id === choice.providerId);
    const enabled = Boolean(provider && directModelsForProvider(binding.id, provider, models).some(model => model.id === choice.defaultModelId));
    return { ...binding, mode, providerIds: choice.providerId ? [choice.providerId] : [], modelIds: [], modelSelection: 'all', defaultModelId: choice.defaultModelId, enabled, connectionChoices: choices };
  }
  if (!choices.aggregate) choices.aggregate = { providerIds: [...(binding.providerIds ?? [])], modelIds: [...binding.modelIds], defaultModelId: binding.defaultModelId, modelSelection: binding.modelSelection ?? 'all' };
  const choice = choices.aggregate;
  const available = models.filter(model => model.enabled && (binding.id === 'claude-code' || model.wireApi !== 'messages') && choice.providerIds.includes(model.providerId) && providers.some(provider => provider.id === model.providerId && provider.enabled) && (choice.modelSelection === 'all' || choice.modelSelection === undefined && !choice.modelIds.length || choice.modelIds.includes(model.id)));
  const enabled = available.length > 0 && (!choice.defaultModelId || available.some(model => model.id === choice.defaultModelId));
  return { ...binding, mode, providerIds: [...choice.providerIds], modelIds: [...choice.modelIds], modelSelection: choice.modelSelection, defaultModelId: choice.defaultModelId, enabled, connectionChoices: choices };
}
export function updateSingleEntryBinding(binding: ToolBinding, update: Partial<ToolBinding>, models: readonly Model[], _providers: readonly Provider[]): ToolBinding {
  const next = { ...binding, ...update };
  if (!isSingleEntryTool(binding.id)) return next;
  const choices = capture(next);
  if (choices.direct?.completionModelId && !models.some(model => model.id === choices.direct!.completionModelId && model.providerId === choices.direct!.providerId)) delete choices.direct.completionModelId;
  if (choices.aggregate?.completionModelId && !models.some(model => model.id === choices.aggregate!.completionModelId && choices.aggregate!.providerIds.includes(model.providerId)
    && (choices.aggregate!.modelSelection !== 'selected' || choices.aggregate!.modelIds.includes(model.id)))) delete choices.aggregate.completionModelId;
  return { ...next, connectionChoices: choices };
}
