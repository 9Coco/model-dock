import type { Model, ReasoningEffort, WireApi } from './types';

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
  /** Whether upstream supplied at least one usable context, tools or vision field. */
  metadataSource: 'upstream' | 'defaults';
  /** Fields with no usable upstream declaration or dictionary entry; their values are local defaults. */
  metadataDefaults?: ('contextWindow' | 'tools' | 'vision')[];
  /** Missing upstream fields filled from the maintained model dictionary. */
  metadataInferred?: ('contextWindow' | 'vision')[];
  metadataReference?: { sourceUrl: string; verifiedAt: string };
  /** Thinking levels declared by upstream; omitted when the catalog does not declare them. */
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
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
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}
export interface AddModelsResult {
  added: Model[];
  skipped: string[];
}
