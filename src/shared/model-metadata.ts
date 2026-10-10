import rawSpecs from './model-specs-data.json';
import type { Provider, ReasoningEffort, WireApi } from './types';

/** 修改点：参数表按精确模型与供应商接口核对，不把模型能力等同于套餐授权。 */
export interface ModelMetadata {
  /** 客户端统一口径：输入与输出合计。Google 独立输入上限另保留 maxInputTokens。 */
  contextWindow: number;
  maxInputTokens?: number;
  /** 思考模式条件不同的保守客户端输入预算，不替代上面的官方最大值。 */
  defaultInputTokens?: number;
  /** 官方支持上限；首选请求预算可能小于这个值。 */
  maxOutputTokens?: number;
  defaultOutputTokens?: number;
  vision: boolean;
  tools?: boolean;
  thinking?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  reasoningEffortFormat?: WireApi;
  adaptiveThinking?: boolean;
  minThinkingBudget?: number;
  maxThinkingBudget?: number;
  verifiedAt: string;
  sourceUrl: string;
  sourceUrls?: string[];
  notes?: string;
}
interface SpecRecord {
  ids: string[];
  vendor: string;
  providerScope?: { presetId?: string; baseUrl: string };
  contextWindow: number;
  contextLimitType: string;
  outputLimitApis?: WireApi[];
  maxInputTokens?: number;
  maxInputTokensThinking?: number;
  maxOutputTokens?: number;
  defaultOutputTokens?: number;
  vision: boolean;
  tools?: boolean;
  toolsByWireApi?: Partial<Record<WireApi, boolean>>;
  supportedWireApis?: WireApi[];
  thinking?: boolean;
  thinkingCanDisable?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  reasoningApis: WireApi[];
  adaptiveThinking?: boolean;
  minThinkingBudget?: number;
  maxThinkingBudget?: number;
  verifiedAt: string;
  sourceUrls: string[];
  notes: string[];
  uiNotes?: string[];
}
type MetadataProvider = Pick<Provider, 'kind' | 'baseUrl' | 'presetId'>;
const records = rawSpecs.records as unknown as SpecRecord[];
const namespaces: Record<string, string[]> = {
  openai: ['openai'], anthropic: ['anthropic'], google: ['google', 'models'],
  deepseek: ['deepseek'], qwen: ['qwen'], zai: ['z-ai'], moonshotai: ['moonshotai'], xai: ['x-ai'],
};
const generic = new Map<string, SpecRecord>();
for (const record of records) {
  if (record.vendor === 'volcengine') continue;
  for (const id of record.ids) {
    generic.set(id.toLowerCase(), record);
    for (const prefix of namespaces[record.vendor] ?? []) generic.set(`${prefix}/${id}`.toLowerCase(), record);
  }
}
function canonicalBase(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return undefined; }
}
function matchesScope(record: SpecRecord, base: string): boolean {
  const expected = record.providerScope && canonicalBase(record.providerScope.baseUrl);
  return expected === base || record.vendor === 'deepseek' && expected === 'https://api.deepseek.com' && base === `${expected}/v1`;
}
function officialVendor(record: SpecRecord, base?: string): boolean {
  if (!base) return false;
  if (record.providerScope) return matchesScope(record, base);
  const allowed: Record<string, string[]> = {
    openai: ['https://api.openai.com/v1'], anthropic: ['https://api.anthropic.com', 'https://api.anthropic.com/v1'],
    google: ['https://generativelanguage.googleapis.com/v1beta/openai'], xai: ['https://api.x.ai/v1'],
  };
  return allowed[record.vendor]?.includes(base) ?? false;
}
/**
 * 修改点：模型字典、供应商套餐覆盖和协议投影共用一个入口。
 * 订阅来源只相信实时目录，未知代理不自动写入厂商原生思考参数。
 * 返回副本，保留上游与用户配置的优先级；本函数不写数据库或外部配置。
 */
export function lookupModelMetadata(upstreamId: string, provider?: MetadataProvider, wireApi?: WireApi): ModelMetadata | undefined {
  const id = upstreamId.trim().toLowerCase();
  if (provider && provider.kind !== 'openai-compatible') return undefined;
  const base = provider && canonicalBase(provider.baseUrl);
  const scoped = base && records.find(record => record.ids.some(value => value.toLowerCase() === id) && matchesScope(record, base));
  const record = scoped || generic.get(id);
  if (!record) return undefined;
  const notes = [...record.uiNotes ?? []];
  const compatibleWire = !wireApi || !record.supportedWireApis || record.supportedWireApis.includes(wireApi);
  const verifiedOutputLimit = !record.outputLimitApis || !!wireApi && record.outputLimitApis.includes(wireApi);
  const inputOnly = record.contextLimitType === 'input';
  const contextWindow = inputOnly ? record.contextWindow + (record.maxOutputTokens ?? 0) : record.contextWindow;
  if (inputOnly) notes.unshift(`官方给出独立输入上限 ${record.contextWindow}；此处客户端上下文按输入与输出合计计算。`);
  if (record.thinkingCanDisable === false) notes.push('模型原生思考不可关闭；“支持思考”表示能力，不是关闭开关。');
  const result: ModelMetadata = {
    contextWindow, vision: record.vision, sourceUrl: record.sourceUrls[0], sourceUrls: [...record.sourceUrls], verifiedAt: record.verifiedAt,
    ...(record.maxInputTokens ? { maxInputTokens: record.maxInputTokens } : {}),
    ...(record.maxOutputTokens && verifiedOutputLimit ? { maxOutputTokens: record.maxOutputTokens } : {}),
    ...(record.defaultOutputTokens && verifiedOutputLimit ? { defaultOutputTokens: record.defaultOutputTokens } : {}),
    ...(!compatibleWire ? { tools: false } : typeof record.tools === 'boolean' ? { tools: wireApi && record.toolsByWireApi?.[wireApi] !== undefined ? record.toolsByWireApi[wireApi] : record.tools } : {}),
    ...(typeof record.thinking === 'boolean' ? { thinking: record.thinking } : {}),
  };
  if (record.maxInputTokensThinking && record.maxInputTokens) {
    result.defaultInputTokens = Math.min(record.maxInputTokensThinking, record.maxInputTokens);
    notes.push(`关闭思考时最大输入 ${record.maxInputTokens}，开启时 ${record.maxInputTokensThinking}；默认采用较小输入预算。`);
  }
  if (!compatibleWire) notes.push('所选接口不在此模型已公开支持的接口中，请先核对调用方式。');
  if (wireApi && record.toolsByWireApi?.[wireApi] === false && record.tools) notes.push('当前接口默认不支持此模型的工具调用；需要工具时请使用已支持的 Responses 接口。');
  if (!result.defaultOutputTokens && result.maxOutputTokens && result.maxOutputTokens >= contextWindow) {
    // 输出能力上限可接近完整上下文，但不能在客户端默认预算中挤掉所有输入空间。
    result.defaultOutputTokens = Math.min(131072, Math.max(1, Math.floor(contextWindow / 4)));
    notes.push(`最大输出与上下文共享空间；客户端首选输出预算为 ${result.defaultOutputTokens}，不是另一个模型上限。`);
  }
  // 原生厂商等级只有在已核对的接口中可导出；同模型在火山套餐上未证实的等级保持空。
  const verifiedEndpoint = !provider || officialVendor(record, base);
  const compatibleReasoning = verifiedEndpoint && compatibleWire && (!wireApi || record.reasoningApis.includes(wireApi));
  if (compatibleReasoning && record.reasoningEfforts !== undefined) {
    result.reasoningEfforts = [...record.reasoningEfforts];
    if (record.defaultReasoningEffort && result.reasoningEfforts.includes(record.defaultReasoningEffort)) result.defaultReasoningEffort = record.defaultReasoningEffort;
    if (wireApi && result.reasoningEfforts.length) result.reasoningEffortFormat = wireApi;
  } else if (record.thinking) {
    result.reasoningEfforts = [];
    notes.push('当前接口未证实可用的思考档位；保留思考能力，不自动写入强度参数。');
  }
  if (verifiedEndpoint && compatibleWire && (!wireApi || wireApi === 'messages')) {
    if (record.adaptiveThinking !== undefined) result.adaptiveThinking = record.adaptiveThinking;
    if (record.minThinkingBudget !== undefined) result.minThinkingBudget = record.minThinkingBudget;
    if (record.maxThinkingBudget !== undefined) result.maxThinkingBudget = record.maxThinkingBudget;
  }
  if (notes.length) result.notes = notes.join('\n');
  return result;
}
