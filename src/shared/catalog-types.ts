import type { Model, WireApi } from './types';

export type DiscoveryErrorCategory = 'missing-credentials' | 'authentication' | 'permission' | 'unsupported' | 'rate-limit' | 'network' | 'timeout' | 'invalid-response' | 'invalid-provider' | 'upstream';
export interface DiscoveredModel {
  upstreamId: string;
  displayName: string;
  /** Suggested unique name. Existing models keep their user-configured names. */
  alias: string;
  wireApi: WireApi;
  contextWindow: number;
  tools: boolean;
  vision: boolean;
  metadataSource: 'upstream' | 'defaults';
  /** Fields omitted by upstream; their current values are local defaults. */
  metadataDefaults?: ('contextWindow' | 'tools' | 'vision')[];
  existingModelId?: string;
}
export interface DiscoveryResult {
  ok: boolean;
  providerId: string;
  statusCode?: number;
  errorCategory?: DiscoveryErrorCategory;
  message: string;
  models: DiscoveredModel[];
}
/** Only IDs from the main process's most recent successful discovery are accepted. */
export interface ModelSelection {
  upstreamId: string;
  alias?: string;
  displayName?: string;
  wireApi?: WireApi;
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
}
export interface AddModelsResult {
  added: Model[];
  skipped: string[];
}
