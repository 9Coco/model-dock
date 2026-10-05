import type { Model, Provider } from './types';

type ModelRoute = Pick<Model, 'id' | 'providerId' | 'alias'>;

/** Names shown to people are separate from the stable IDs used to route requests. */
export function modelDisplayLabel(model: Pick<Model, 'displayName' | 'upstreamId' | 'alias'>, provider?: Pick<Provider, 'name'>): string {
  const name = model.displayName || model.upstreamId || model.alias;
  return provider ? `${provider.name} - ${name}` : name;
}

/** Hide only this source's generated namespace when editing the local model name. */
export function modelLocalAlias(model: Pick<Model, 'providerId' | 'alias'>): string {
  const prefix = `${model.providerId}/`;
  return model.alias.startsWith(prefix) ? model.alias.slice(prefix.length) : model.alias;
}

/**
 * Keep existing route IDs stable. A name used by another source gets this source's
 * immutable ID as a namespace; a duplicate within the same source is an error.
 * Numeric suffixes are only used when another source already occupies that exact
 * namespace, never to silently create another same-source model.
 */
export function suggestModelAlias(providerId: string, requestedAlias: string, models: readonly ModelRoute[], currentModelId?: string): string {
  const requested = requestedAlias.trim();
  const current = models.find(model => model.id === currentModelId && model.providerId === providerId);
  const localName = modelLocalAlias({ providerId, alias: requested });
  if (current && (current.alias === requested || modelLocalAlias(current) === localName)) return current.alias;
  const others = models.filter(model => model.id !== currentModelId);
  const routes = new Map(others.map(model => [model.alias, model]));
  const duplicate = () => new Error('同一供应商的模型别名已被使用，请编辑已有模型或使用其他名称。');
  if (others.some(model => model.providerId === providerId && modelLocalAlias(model) === localName)) throw duplicate();
  if (!routes.has(requested)) return requested;
  const base = `${providerId}/${localName}`;
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    const occupant = routes.get(candidate);
    if (!occupant) return candidate;
    if (occupant.providerId === providerId) throw duplicate();
  }
}
