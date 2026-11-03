import type { Model, Provider, WireApi } from './types';

/** Formats verified in the installed TRAE CN custom-provider form. */
export type TraeModelProtocol = WireApi;
export type TraeProviderId = 'custom_openai_compatible' | 'custom_anthropic_compatible' | 'custom_responses_compatible';
export const TRAE_PROVIDER_IDS: Record<TraeModelProtocol, TraeProviderId> = {
  'chat-completions': 'custom_openai_compatible',
  messages: 'custom_anthropic_compatible',
  responses: 'custom_responses_compatible',
};

export function traeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/tool/trae/v1`;
}

export function traeModelProtocol(model: Pick<Model, 'wireApi'>): TraeModelProtocol {
  return model.wireApi;
}

/** Native direct mode never exports subscriptions; each model keeps its protocol. */
export function traeModelsForProvider(provider: Provider, models: readonly Model[], aggregate: boolean): Model[] {
  if (!provider.enabled || !aggregate && provider.kind !== 'openai-compatible') return [];
  return models.filter(model => model.enabled && model.providerId === provider.id);
}
