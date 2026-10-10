import type { ModelInput, ModelSpecs, WireApi } from './types';
import type { ModelMetadata } from './model-metadata';

/** 修改点：仅管理参数草稿，名称、接口和本地简称始终由用户控制。 */
export const MODEL_DRAFT_PARAMETER_FIELDS = [
  'contextWindow', 'maxInputTokens', 'maxOutputTokens', 'tools', 'vision', 'thinking',
  'reasoningEfforts', 'defaultReasoningEffort', 'reasoningEffortFormat', 'adaptiveThinking',
  'minThinkingBudget', 'maxThinkingBudget',
] as const;
export type ModelDraftParameterField = typeof MODEL_DRAFT_PARAMETER_FIELDS[number];
type DraftParameters = Pick<ModelInput, ModelDraftParameterField>;

const unknownParameters = (): DraftParameters => ({
  contextWindow: 0, maxInputTokens: 0, maxOutputTokens: 0,
  tools: false, vision: false, thinking: false, reasoningEfforts: [],
  defaultReasoningEffort: undefined, reasoningEffortFormat: undefined,
  adaptiveThinking: undefined, minThinkingBudget: undefined, maxThinkingBudget: undefined,
});

export function freshModelDraft(providerId = '', wireApi: WireApi = 'responses'): ModelInput {
  return { providerId, upstreamId: '', alias: '', displayName: '', wireApi, enabled: true, ...unknownParameters() };
}

function documentedParameters(metadata: ModelMetadata): Partial<DraftParameters> {
  const result: Partial<DraftParameters> = { vision: metadata.vision };
  if (metadata.contextWindow > 0) result.contextWindow = metadata.contextWindow;
  if (metadata.maxInputTokens !== undefined && metadata.maxInputTokens > 0) result.maxInputTokens = metadata.defaultInputTokens ?? metadata.maxInputTokens;
  if (metadata.maxOutputTokens !== undefined && metadata.maxOutputTokens > 0) {
    const recommended = metadata.defaultOutputTokens ?? metadata.maxOutputTokens;
    result.maxOutputTokens = Math.min(recommended, metadata.maxOutputTokens, metadata.contextWindow > 0 ? metadata.contextWindow : metadata.maxOutputTokens);
  }
  if (metadata.tools !== undefined) result.tools = metadata.tools;
  if (metadata.thinking !== undefined) result.thinking = metadata.thinking;
  if (metadata.reasoningEfforts !== undefined) result.reasoningEfforts = [...metadata.reasoningEfforts];
  if (metadata.defaultReasoningEffort !== undefined) result.defaultReasoningEffort = metadata.defaultReasoningEffort;
  const specificationKeys: (keyof ModelSpecs)[] = ['reasoningEffortFormat', 'adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget'];
  for (const key of specificationKeys) if (metadata[key] !== undefined) Object.assign(result, { [key]: metadata[key] });
  if (metadata.thinking === false) {
    result.adaptiveThinking = false;
    result.minThinkingBudget = undefined;
    result.maxThinkingBudget = undefined;
  }
  if (metadata.thinking === false || metadata.reasoningEfforts?.length === 0) {
    result.reasoningEfforts = [];
    result.defaultReasoningEffort = undefined;
    result.reasoningEffortFormat = undefined;
  }
  return result;
}

/** 新模型随 ID/来源/协议更新自动参数；用户改过的字段（含 0/false）优先。 */
export function autoFillModelDraft(draft: ModelInput, metadata: ModelMetadata | undefined, touched: ReadonlySet<ModelDraftParameterField>): ModelInput {
  if (draft.id) return draft; // 编辑已有模型必须显式应用，避免旧的自定义设置被覆盖。
  const automatic = { ...unknownParameters(), ...(metadata ? documentedParameters(metadata) : {}) };
  const next = { ...draft };
  for (const key of MODEL_DRAFT_PARAMETER_FIELDS) {
    if (!touched.has(key)) Object.assign(next, { [key]: automatic[key] });
  }
  return next;
}

export function officialModelParameterFields(metadata: ModelMetadata): ModelDraftParameterField[] {
  return Object.keys(documentedParameters(metadata)) as ModelDraftParameterField[];
}

/** 用户主动更新已有模型：只填已核实字段；未知上限、能力不写默认猜测。 */
export function applyOfficialModelParameters(draft: ModelInput, metadata: ModelMetadata | undefined): ModelInput {
  return metadata ? { ...draft, ...documentedParameters(metadata) } : draft;
}
