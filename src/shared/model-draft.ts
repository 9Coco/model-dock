import { REASONING_EFFORTS, type ModelInput, type ReasoningEffort, type WireApi } from './types';
import type { ModelMetadata } from './model-metadata';

/** 修改点：仅管理参数草稿，名称、接口和本地简称始终由用户控制。 */
export const MODEL_DRAFT_PARAMETER_FIELDS = [
  'contextWindow', 'maxInputTokens', 'maxOutputTokens', 'tools', 'vision', 'thinking',
  'reasoningEfforts', 'defaultReasoningEffort', 'reasoningEffortFormat', 'adaptiveThinking',
  'minThinkingBudget', 'maxThinkingBudget',
] as const;
export type ModelDraftParameterField = typeof MODEL_DRAFT_PARAMETER_FIELDS[number];
type DraftParameters = Pick<ModelInput, ModelDraftParameterField>;
type EffortParameters = Pick<ModelInput, 'wireApi' | 'reasoningEfforts' | 'defaultReasoningEffort' | 'reasoningEffortFormat'>;
export type ModelReasoningDefaults = Partial<Pick<ModelMetadata, 'thinking' | 'reasoningEfforts' | 'defaultReasoningEffort' | 'reasoningEffortFormat' | 'adaptiveThinking' | 'minThinkingBudget' | 'maxThinkingBudget'>>;

/** 修改点：七档均可手动配置；增删时保留其他选择，只清理被移除的默认档位。 */
export function reasoningSelectionPatch(draft: EffortParameters, level: ReasoningEffort, selected: boolean): Pick<ModelInput, 'reasoningEfforts' | 'defaultReasoningEffort' | 'reasoningEffortFormat'> {
  const current = draft.reasoningEfforts ?? [];
  const next = REASONING_EFFORTS.filter(item => item === level ? selected : current.includes(item));
  return {
    reasoningEfforts: next,
    reasoningEffortFormat: next.length ? draft.wireApi : undefined,
    defaultReasoningEffort: draft.defaultReasoningEffort && next.includes(draft.defaultReasoningEffort) ? draft.defaultReasoningEffort : undefined,
  };
}

/** 修改点：接口切换后已有手工档位仍保留，导出格式随当前接口更新。 */
export function withReasoningWireApi<T extends EffortParameters>(draft: T, wireApi: WireApi): T {
  return { ...draft, wireApi, reasoningEffortFormat: draft.reasoningEfforts?.length ? wireApi : undefined };
}

const unknownParameters = (): DraftParameters => ({
  contextWindow: 0, maxInputTokens: 0, maxOutputTokens: 0,
  tools: false, vision: false, thinking: false, reasoningEfforts: [],
  defaultReasoningEffort: undefined, reasoningEffortFormat: undefined,
  adaptiveThinking: undefined, minThinkingBudget: undefined, maxThinkingBudget: undefined,
});

export function freshModelDraft(providerId = '', wireApi: WireApi = 'responses'): ModelInput {
  return { providerId, upstreamId: '', alias: '', displayName: '', wireApi, enabled: true, ...unknownParameters() };
}

function documentedReasoningParameters(metadata: ModelReasoningDefaults): Partial<DraftParameters> {
  const result: Partial<DraftParameters> = {};
  if (metadata.thinking !== undefined) result.thinking = metadata.thinking;
  if (metadata.reasoningEfforts !== undefined) {
    result.reasoningEfforts = [...metadata.reasoningEfforts];
    result.defaultReasoningEffort = metadata.defaultReasoningEffort && metadata.reasoningEfforts.includes(metadata.defaultReasoningEffort) ? metadata.defaultReasoningEffort : undefined;
  } else if (metadata.defaultReasoningEffort !== undefined) result.defaultReasoningEffort = metadata.defaultReasoningEffort;
  const specificationKeys = ['reasoningEffortFormat', 'adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget'] as const;
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

function documentedParameters(metadata: ModelMetadata): Partial<DraftParameters> {
  const result: Partial<DraftParameters> = { vision: metadata.vision, ...documentedReasoningParameters(metadata) };
  if (metadata.contextWindow > 0) result.contextWindow = metadata.contextWindow;
  if (metadata.maxInputTokens !== undefined && metadata.maxInputTokens > 0) result.maxInputTokens = metadata.defaultInputTokens ?? metadata.maxInputTokens;
  if (metadata.maxOutputTokens !== undefined && metadata.maxOutputTokens > 0) {
    const recommended = metadata.defaultOutputTokens ?? metadata.maxOutputTokens;
    result.maxOutputTokens = Math.min(recommended, metadata.maxOutputTokens, metadata.contextWindow > 0 ? metadata.contextWindow : metadata.maxOutputTokens);
  }
  if (metadata.tools !== undefined) result.tools = metadata.tools;
  return result;
}

function maintainedParameters(metadata: ModelMetadata | undefined, reasoningDefaults?: ModelReasoningDefaults): Partial<DraftParameters> {
  return { ...(metadata ? documentedParameters(metadata) : {}), ...(reasoningDefaults ? documentedReasoningParameters(reasoningDefaults) : {}) };
}

/** 新模型随 ID/来源/协议更新自动参数；用户改过的字段（含 0/false）优先。 */
export function autoFillModelDraft(draft: ModelInput, metadata: ModelMetadata | undefined, touched: ReadonlySet<ModelDraftParameterField>, reasoningDefaults?: ModelReasoningDefaults): ModelInput {
  if (draft.id) return draft; // 编辑已有模型必须显式应用，避免旧的自定义设置被覆盖。
  const automatic = { ...unknownParameters(), ...maintainedParameters(metadata, reasoningDefaults) };
  const next = { ...draft };
  for (const key of MODEL_DRAFT_PARAMETER_FIELDS) {
    if (!touched.has(key)) Object.assign(next, { [key]: automatic[key] });
  }
  return next;
}

export function officialModelParameterFields(metadata: ModelMetadata | undefined, reasoningDefaults?: ModelReasoningDefaults): ModelDraftParameterField[] {
  return Object.keys(maintainedParameters(metadata, reasoningDefaults)) as ModelDraftParameterField[];
}

/** 用户主动更新已有模型：只填已核实字段；未知上限、能力不写默认猜测。 */
export function applyOfficialModelParameters<T extends DraftParameters>(draft: T, metadata: ModelMetadata | undefined, reasoningDefaults?: ModelReasoningDefaults): T {
  return metadata || reasoningDefaults ? { ...draft, ...maintainedParameters(metadata, reasoningDefaults) } : draft;
}
