import type { Model, Provider, ToolBinding } from './types';
import { claudeConnectionKind, claudeModelsForProvider } from './claude';
import { isJetBrainsTool } from './jetbrains';
import { directModelsForProvider, isSingleEntryTool, nativeDirectBaseUrl } from './single-entry';

export interface BindingConnectionGroup {
  /** Direct API groups contain exactly one provider, hence one credential. */
  connection: 'direct-api' | 'local-managed';
  providerIds: string[];
  modelIds: string[];
}
export interface BindingConnectionPolicy {
  kind: 'direct' | 'aggregate' | 'native';
  groups: BindingConnectionGroup[];
}

/** An exact selection stays exact when empty or when the source adds models.
 * Missing selection metadata preserves existing provider/all and model filters. */
export function resolveBindingModels(binding: ToolBinding, models: Model[], providers?: Provider[]): Model[] {
  if (!binding.enabled) return [];
  const providerIds = binding.providerIds;
  const claude = binding.id === 'claude-code';
  const singleSource = binding.mode === 'direct' || claude && binding.mode !== 'aggregate';
  // 修改点：Claude 使用官方 Messages 入口或本机协议桥，其他适配器仍不消费 Messages。
  const claudeIds = claude && providers ? new Set(providers.filter(provider => provider.enabled).flatMap(provider => binding.mode === 'aggregate'
    ? models.filter(model => model.providerId === provider.id && model.enabled)
    : claudeModelsForProvider(provider, models)).map(model => model.id)) : undefined;
  const nativeIds = binding.mode === 'direct' && isSingleEntryTool(binding.id) && providers ? new Set(providers.flatMap(provider => directModelsForProvider(binding.id, provider, models)).map(model => model.id)) : undefined;
  let result = models.filter(model => model.enabled && (claude ? !claudeIds || claudeIds.has(model.id) : model.wireApi !== 'messages')
    && (!providers || providers.some(p => p.id === model.providerId && p.enabled)) && (!nativeIds || nativeIds.has(model.id)));
  if (providerIds !== undefined) {
    const allowed = singleSource ? providerIds.slice(0, 1) : providerIds;
    result = result.filter(model => allowed.includes(model.providerId));
    if (binding.modelSelection === 'selected' || binding.modelSelection !== 'all' && binding.modelIds.length) result = result.filter(model => binding.modelIds.includes(model.id));
  } else {
    result = result.filter(model => binding.modelIds.includes(model.id));
    if (singleSource && result.length) result = result.filter(model => model.providerId === result[0].providerId);
  }
  return result;
}

/** Select connection topology without accessing or combining any credentials.
 * Existing explicit modes and model-scoped filters retain their meaning. */
export function bindingConnectionPolicy(binding: ToolBinding, models: Model[], providers?: Provider[]): BindingConnectionPolicy {
  const resolved = resolveBindingModels(binding, models, providers);
  const requestedIds = [...new Set(binding.providerIds ?? resolved.map(model => model.providerId))];
  const selectedIds = requestedIds.filter(providerId => !providers || providers.some(provider => provider.id === providerId && provider.enabled));
  const localGroup = (): BindingConnectionGroup => ({ connection: 'local-managed', providerIds: selectedIds, modelIds: resolved.map(model => model.id) });
  // 修改点：所有工具的显式聚合模式共用一个本机入口，凭据不写到客户端。
  if (binding.mode === 'aggregate') return { kind: 'aggregate', groups: binding.enabled && selectedIds.length ? [localGroup()] : [] };
  if (binding.mode === 'direct') {
    if (!binding.enabled || !requestedIds.length) return { kind: 'direct', groups: [] };
    if (requestedIds.length !== 1) throw new Error('单供应商模式必须只选择一个来源。');
    if (!selectedIds.length) return { kind: 'direct', groups: [] };
    const provider = providers?.find(item => item.id === selectedIds[0]);
    if (isSingleEntryTool(binding.id)) return { kind: 'direct', groups: provider && nativeDirectBaseUrl(binding.id, provider, resolved) ? [{ connection: 'direct-api', providerIds: selectedIds, modelIds: resolved.map(model => model.id) }] : [] };
    const native = provider?.kind === 'openai-compatible' && (binding.id === 'claude-code' ? claudeConnectionKind(provider, resolved) === 'direct-api'
      : isJetBrainsTool(binding.id) ? resolved.length > 0 && resolved.every(model => model.wireApi === 'chat-completions') : true);
    return { kind: 'direct', groups: [{ connection: native ? 'direct-api' : 'local-managed', providerIds: selectedIds, modelIds: resolved.map(model => model.id) }] };
  }
  if (isJetBrainsTool(binding.id)) {
    const providerIds = [...new Set(binding.providerIds ?? resolved.map(model => model.providerId))].filter(providerId => !providers || providers.some(provider => provider.id === providerId && provider.enabled));
    return { kind: 'aggregate', groups: binding.enabled && providerIds.length ? [{ connection: 'local-managed', providerIds, modelIds: resolved.map(model => model.id) }] : [] };
  }
  if (binding.id === 'claude-code') {
    const providerIds = [...new Set((binding.providerIds ?? resolved.map(model => model.providerId)))];
    if (!binding.enabled || !providerIds.length) return { kind: 'direct', groups: [] };
    if (providerIds.length !== 1) throw new Error('Claude Code 旧连接一次只使用一个来源，请选择聚合模式连接多家。');
    const provider = providers?.find(item => item.id === providerIds[0]);
    return { kind: 'direct', groups: [{ connection: provider ? claudeConnectionKind(provider, resolved) : 'local-managed', providerIds, modelIds: resolved.map(model => model.id) }] };
  }
  // 旧 auto 模式保持原先的原生多入口行为，直到用户明确切换。
  const auto = binding.mode === 'auto';
  const modeKind = auto && binding.id !== 'codex' ? 'native' : 'aggregate';
  if (!binding.enabled || !selectedIds.length) return { kind: modeKind, groups: [] };
  const singleApi = selectedIds.length === 1 && providers?.find(provider => provider.id === selectedIds[0])?.kind === 'openai-compatible';
  if (auto && binding.id === 'codex' && singleApi) return { kind: 'direct', groups: [{ connection: 'direct-api', providerIds: selectedIds, modelIds: resolved.map(model => model.id) }] };
  if (!auto || binding.id === 'codex') return { kind: 'aggregate', groups: [localGroup()] };
  return { kind: 'native', groups: selectedIds.map(providerId => ({
    connection: providers?.find(provider => provider.id === providerId)?.kind === 'openai-compatible' ? 'direct-api' : 'local-managed',
    providerIds: [providerId], modelIds: resolved.filter(model => model.providerId === providerId).map(model => model.id),
  })) };
}
