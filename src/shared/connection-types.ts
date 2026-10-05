import type { Model, WireApi } from './types';

/** Follow the supplier's saved list order, including disabled entries. */
export function firstConnectionModel(providerId: string, models: readonly Model[]): Model | undefined {
  return models.find(model => model.providerId === providerId);
}

/** A saved model takes precedence over manually supplied model/protocol fields. */
export interface ConnectionTestInput {
  modelId?: string;
  upstreamId?: string;
  wireApi?: WireApi;
}

export type ConnectionOutcome = 'success' | 'model-required' | 'configuration' | 'authentication' | 'permission' | 'model' | 'rate-limit' | 'upstream' | 'network' | 'timeout' | 'invalid-response';

/** Only test metadata is returned; never return credentials or generated content. */
export interface ConnectionResult {
  ok: boolean;
  message: string;
  outcome: ConnectionOutcome;
  statusCode?: number;
  durationMs?: number;
  testedModel?: string;
  wireApi?: WireApi;
}
