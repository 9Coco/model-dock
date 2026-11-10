import type { Model, ModelSpecs, ReasoningEffort, WireApi } from './types';
export type ModelMetadataField = 'contextWindow' | 'tools' | 'vision' | 'reasoningEfforts' | 'defaultReasoningEffort' | keyof ModelSpecs;

export type DiscoveryErrorCategory = 'missing-credentials' | 'authentication' | 'permission' | 'unsupported' | 'rate-limit' | 'network' | 'timeout' | 'invalid-response' | 'invalid-provider' | 'upstream';
export const catalogAccessMessages = {
  'account-access': '当前 TRAE 账号没有此模型的使用权限。',
  'access-unknown': '未能确认当前 TRAE 账号是否有权使用此模型，请重新获取模型列表。',
} as const;
export interface DiscoveredModel extends ModelSpecs {
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
  metadataDefaults?: ModelMetadataField[];
  /** Missing upstream fields filled from the maintained model dictionary. */
  metadataInferred?: ModelMetadataField[];
  metadataReference?: { sourceUrl: string; verifiedAt: string };
  /** Upstream levels take precedence, including explicit []; missing values may use official metadata. */
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  existingModelId?: string;
  /** Explicitly offered only for a saved model missing levels that this upstream actually advertised. */
  availableReasoning?: { levels: ReasoningEffort[]; defaultLevel?: ReasoningEffort };
  /** Display scope verified by the native client catalog; never changes routing. */
  catalogVisibility?: 'current' | 'historical';
  /** Main-process directory metadata only. Enforced again when adding the selection. */
  catalogImportable?: false;
  catalogBlockedReason?: keyof typeof catalogAccessMessages;
}
export interface DiscoveryResult {
  ok: boolean;
  providerId: string;
  statusCode?: number;
  errorCategory?: DiscoveryErrorCategory;
  message: string;
  models: DiscoveredModel[];
  /** Verified client-default visibility; not a claim of inference acceptance. */
  history?: { source: 'trae-client' | 'jetbrains-client' | 'codex-client' | 'grok-client' | 'copilot-client'; currentVerified: boolean; message?: string };
}
/** Only IDs from the main process's most recent successful discovery are accepted. */
export interface ModelSelection extends ModelSpecs {
  upstreamId: string;
  fillMissingReasoningFor?: string;
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
  updated?: Model[];
  skipped: string[];
}
