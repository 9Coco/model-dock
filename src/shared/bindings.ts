import type { Model, Provider, ToolBinding } from './types';
import { claudeConnectionKind, claudeModelsForProvider } from './claude';

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
  const singleSource = claude || binding.mode === 'direct' && binding.id === 'codex';
  // 修改点：Claude 使用官方 Messages 入口或本机协议桥，其他适配器仍不消费 Messages。
  const claudeIds = claude && providers ? new Set(providers.filter(provider => provider.enabled).flatMap(provider => claudeModelsForProvider(provider, models).map(model => model.id))) : undefined;
  let result = models.filter(model => model.enabled && (claude ? !claudeIds || claudeIds.has(model.id) : model.wireApi !== 'messages')
    && (!providers || providers.some(p => p.id === model.providerId && p.enabled)));
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
  if (binding.id === 'claude-code') {
    const providerIds = [...new Set((binding.providerIds ?? resolved.map(model => model.providerId)))];
    if (!binding.enabled || !providerIds.length) return { kind: 'direct', groups: [] };
    if (binding.mode === 'aggregate' || providerIds.length !== 1) throw new Error('Claude Code 目前一次只支持一个供应商或订阅来源。');
    const provider = providers?.find(item => item.id === providerIds[0]);
    return { kind: 'direct', groups: [{ connection: provider ? claudeConnectionKind(provider, resolved) : 'local-managed', providerIds, modelIds: resolved.map(model => model.id) }] };
  }
  const direct = binding.mode === 'direct';
  const auto = binding.mode === 'auto';
  const modeKind = direct ? 'direct' : auto && binding.id !== 'codex' ? 'native' : 'aggregate';
  if (!binding.enabled) return { kind: modeKind, groups: [] };
  const selectedIds = binding.providerIds === undefined
    ? [...new Set(resolved.map(model => model.providerId))]
    : [...new Set((direct && binding.id === 'codex' ? binding.providerIds.slice(0, 1) : binding.providerIds).filter(providerId => !providers || providers.some(provider => provider.id === providerId && provider.enabled)))];
  if (!selectedIds.length) return { kind: modeKind, groups: [] };
  const singleApi = selectedIds.length === 1 && providers?.find(provider => provider.id === selectedIds[0])?.kind === 'openai-compatible';
  const localGroup = (): BindingConnectionGroup => ({ connection: 'local-managed', providerIds: selectedIds, modelIds: resolved.map(model => model.id) });
  if (direct && selectedIds.length === 1 || auto && binding.id === 'codex' && singleApi) {
    return { kind: 'direct', groups: [{ connection: singleApi ? 'direct-api' : 'local-managed', providerIds: selectedIds, modelIds: resolved.map(model => model.id) }] };
  }
  // Codex selects one active endpoint. Multiple sources and subscriptions stay
  // behind the gateway. Explicit legacy aggregate bindings retain that route.
  if (!auto && !direct || binding.id === 'codex') return { kind: 'aggregate', groups: [localGroup()] };
  // The other clients support multiple endpoints. Each API provider gets its
  // own credential group; subscriptions keep their rotating tokens local.
  return { kind: 'native', groups: selectedIds.map(providerId => ({
    connection: providers?.find(provider => provider.id === providerId)?.kind === 'openai-compatible' ? 'direct-api' : 'local-managed',
    providerIds: [providerId], modelIds: resolved.filter(model => model.providerId === providerId).map(model => model.id),
  })) };
}
