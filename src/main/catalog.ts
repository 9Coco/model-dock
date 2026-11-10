import { isCopilotUpstream } from './copilot-provider';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parameterRow } from './model-parameter-updates';
import type { ParameterPreview } from '../shared/catalog-types';
import type { Model, ModelInput, Provider, WireApi } from '../shared/types';
import { isReasoningEffort, MODEL_SPEC_FIELDS, modelSpecs, REASONING_EFFORTS, sanitizeReasoningEfforts } from '../shared/types';
import type { AddModelsResult, DiscoveredModel, DiscoveryErrorCategory, DiscoveryResult, ModelSelection } from '../shared/catalog-types';
import { catalogAccessMessages } from '../shared/catalog-types';
import { OPENCODE_GO_BASE_URL, presetById } from '../shared/presets';
import { isTraeRelayProvider } from '../shared/trae-relay-models';
import { modelLocalAlias, suggestModelAlias } from '../shared/model-names';
import { lookupModelMetadata, lookupModelReasoningDefaults } from '../shared/model-metadata';
import type { PreparedUpstream } from './oauth';
import { modelCatalogEndpoint } from './oauth';
import { anthropicEndpoint } from './anthropic-endpoint';
import { TraeNativeAccountError } from './trae-native-account';
import { CentralNativeAccountError } from './central-native-account';
import { JetBrainsIdeAccountError } from './jetbrains-ide-account';
import { JetBrainsIdeApiError } from './jetbrains-ide-api';

export interface CatalogStore {
  getProvider(id: string): Provider | undefined;
  listModels(): Model[];
  /** The entire batch must be committed or rolled back together. */
  saveModels(inputs: ModelInput[]): Model[];
}
export interface CatalogOAuth {
  prepareRequest(provider: Provider, path: string, body: Record<string, unknown>): Promise<PreparedUpstream>;
}
type RecordValue = Record<string, unknown>;
interface CachedDiscovery {
  fingerprint: string;
  expiresAt: number;
  models: Map<string, DiscoveredModel>;
  upstream: Map<string, Omit<DiscoveredModel, 'alias'>>;
  refresh?: Promise<DiscoveryResult>;
}
const staleCatalog = () => new Error('模型目录已过期或供应商配置已变化，请重新获取模型列表。');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_MODELS = 2000;
const CACHE_LIFETIME_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const queryKeys = new Set(['page', 'cursor', 'after', 'before', 'limit', 'offset']);

class CatalogFailure extends Error {
  constructor(readonly category: DiscoveryErrorCategory, message: string, readonly statusCode?: number) { super(message); }
}
function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function safeText(value: unknown, max = 200): string {
  return typeof value === 'string' && value.trim().length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
}
function catalogHistorySource(provider: Provider): NonNullable<DiscoveryResult['history']>['source'] | undefined {
  if (provider.nativeAdapter === 'trae') return 'trae-client';
  if (provider.nativeAdapter === 'jetbrains-ide') return 'jetbrains-client';
  if (provider.nativeAdapter) return undefined;
  return provider.kind === 'codex' ? 'codex-client' : provider.kind === 'grok' ? 'grok-client'
    : provider.kind === 'copilot' ? 'copilot-client' : undefined;
}
function nativeCatalogHistory(payload: unknown, provider: Provider, trusted: boolean): DiscoveryResult['history'] {
  // These fields are a main-process adapter contract, never upstream API metadata.
  if (!trusted) return undefined;
  const source = catalogHistorySource(provider);
  const data = object(object(payload).modeldock_history);
  if (!source || data.source !== source || typeof data.currentVerified !== 'boolean') return undefined;
  const message = safeText(data.message, 500);
  return { source, currentVerified: data.currentVerified, ...(message ? { message } : {}) };
}
function subscriptionCatalogVisibility(entry: unknown, provider: Provider): DiscoveredModel['catalogVisibility'] {
  const data = object(entry);
  if (provider.nativeAdapter) return undefined;
  if (provider.kind === 'codex') {
    // Official ModelInfo -> ModelPreset: only List is picker-visible. The
    // app-server's include_hidden projection uses the equivalent hidden boolean.
    if (data.visibility === 'list') return 'current';
    if (data.visibility === 'hide' || data.visibility === 'none') return 'historical';
    if (data.visibility === undefined && typeof data.hidden === 'boolean') return data.hidden ? 'historical' : 'current';
  } else if (provider.kind === 'grok' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    // Official Grok /models parser defaults hidden to false and consults _meta
    // only when the top-level field is absent. OAuth ignores supported_in_api.
    const hidden = Object.hasOwn(data, 'hidden') ? data.hidden : object(data._meta).hidden;
    return hidden === true ? 'historical' : 'current';
  } else if (provider.kind === 'copilot' && typeof data.model_picker_enabled === 'boolean') {
    return data.model_picker_enabled ? 'current' : 'historical';
  }
  return undefined;
}
function subscriptionCatalogHistory(provider: Provider, models: DiscoveredModel[]): DiscoveryResult['history'] {
  if (provider.nativeAdapter) return undefined;
  const source = catalogHistorySource(provider);
  if (!source) return undefined;
  const currentVerified = models.every(model => model.catalogVisibility !== undefined);
  return { source, currentVerified, message: '按官方客户端默认可见性筛选，本地实验/手动隐藏以客户端为准。'
    + (currentVerified ? '' : '部分模型缺少可核实的可见性字段，勾选后可查看未核实展示状态的条目。') };
}
function fingerprint(provider: Provider): string { return JSON.stringify([provider.id, provider.kind, provider.baseUrl, provider.presetId, provider.hasSecret, provider.copilotAccountId, provider.messagesAuth, provider.nativeAdapter]); }
function positiveContext(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}
function booleanValue(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}
function inputModalities(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const modalities = value.filter((modality): modality is string => typeof modality === 'string' && ['text', 'image', 'audio', 'video'].includes(modality));
    if (modalities.length) return modalities;
  }
  return [];
}
function discoveryAlias(base: string, providerId: string, models: Pick<Model, 'id' | 'providerId' | 'alias'>[]): string {
  const normal = base.replace(/[^a-zA-Z0-9._:/-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 180) || 'model';
  const localNames = new Set(models.filter(model => model.providerId === providerId).map(modelLocalAlias));
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? normal : `${normal}-${suffix}`;
    if (localNames.has(modelLocalAlias({ providerId, alias: candidate }))) continue;
    try { return suggestModelAlias(providerId, candidate, models); }
    catch { /* Distinct upstream IDs can sanitize to the same local name. Suggest a free local name. */ }
  }
}
function parseModel(entry: unknown, provider: Provider, messagesCatalog = false): Omit<DiscoveredModel, 'alias'> | undefined {
  const data = object(entry);
  const idFields = provider.kind === 'codex' ? [data.slug, data.id, data.model, data.model_id, data.name] : [data.id, data.slug, data.model_id, data.name];
  const upstreamId = typeof entry === 'string' ? safeText(entry) : idFields.map(value => safeText(value)).find(Boolean) ?? '';
  if (!upstreamId) return undefined;
  const capabilities = object(data.capabilities);
  const go = provider.kind === 'opencode-go';
  const goInput = object(data.modalities).input;
  const modalities = inputModalities(data.input_modalities, data.inputModalities, capabilities.input_modalities, object(data.architecture).input_modalities,
    go && Array.isArray(goInput) ? goInput.map(value => typeof value === 'string' && value.startsWith('image/') ? 'image' : value) : undefined);
  const goLimit = object(go ? data.limit : undefined), goReasoning = object(go ? capabilities.reasoning : undefined);
  const claudeThinking = object(messagesCatalog ? capabilities.thinking : undefined);
  const claudeEffort = object(messagesCatalog ? capabilities.effort : undefined);
  const claudeLevels = REASONING_EFFORTS.filter(level => object(claudeEffort[level]).supported === true);
  const effort = object(data.effort);
  const limits = object(capabilities.limits), supports = object(capabilities.supports);
  // Protocol and account identity constrain dictionary inference. Public API limits
  // must never overwrite a native subscription catalog with the same model name.
  const endpoints = data.supported_endpoints ?? capabilities.supported_endpoints;
  if (provider.kind === 'copilot' && Array.isArray(endpoints) && !endpoints.some(endpoint => endpoint === 'responses' || endpoint === '/responses' || endpoint === 'chat_completions' || endpoint === 'chat-completions' || endpoint === '/chat/completions')) return undefined;
  const nativeWire = provider.nativeAdapter && ['chat-completions', 'responses', 'messages'].includes(String(data.wire_api)) ? data.wire_api as WireApi : undefined;
  const wireApi: WireApi = nativeWire ?? (provider.kind === 'copilot' ? Array.isArray(endpoints) && (endpoints.includes('responses') || endpoints.includes('/responses')) ? 'responses' : 'chat-completions'
    : provider.kind === 'openai-compatible' || provider.kind === 'opencode-go' ? messagesCatalog ? 'messages' : presetById(provider.presetId)?.defaultWireApi ?? 'chat-completions' : 'responses');
  const knownMetadata = lookupModelMetadata(upstreamId, provider, wireApi);
  // 订阅目录只借用缺少的思考默认值，不能借用公共 API 的容量或模态。
  const reasoningMetadata = knownMetadata ?? lookupModelReasoningDefaults(upstreamId, provider, wireApi);
  const upstreamInput = positiveContext(data.max_input_tokens, data.maxInputTokens, limits.max_input_tokens, limits.max_prompt_tokens, goLimit.input);
  // The Anthropic Models API uses max_tokens for its published output limit.
  const upstreamOutput = positiveContext(data.max_output_tokens, data.maxOutputTokens, limits.max_output_tokens, limits.max_completion_tokens, goLimit.output,
    messagesCatalog ? data.max_tokens : undefined, object(data.top_provider).max_completion_tokens);
  const combined = upstreamInput !== undefined && upstreamOutput !== undefined && Number.isSafeInteger(upstreamInput + upstreamOutput) ? upstreamInput + upstreamOutput : undefined;
  const upstreamContext = positiveContext(data.context_window, data.contextWindow, data.context_length, data.max_context_length, limits.max_context_window_tokens, goLimit.context, messagesCatalog ? upstreamInput : undefined, combined);
  // A negative parallel-calls flag does not rule out ordinary function calls.
  const declaredTools = booleanValue(data.tools, data.supports_tools, data.supports_tool_calls, capabilities.tools, capabilities.tool_calling,
    object(go ? capabilities.tools : undefined).supported, Array.isArray(data.supported_parameters) && data.supported_parameters.includes('tools') ? true : undefined,
    provider.kind === 'copilot' ? supports.tool_calls : undefined, provider.kind === 'codex' && data.supports_parallel_tool_calls === true ? true : undefined);
  const upstreamVision = booleanValue(data.vision, data.supports_vision, capabilities.vision, provider.kind === 'copilot' ? supports.vision : undefined, messagesCatalog ? object(capabilities.image_input).supported : undefined)
    ?? (modalities.length ? modalities.includes('image') : undefined);
  const metadataInferred: NonNullable<DiscoveredModel['metadataInferred']> = [];
  const metadataDefaults: NonNullable<DiscoveredModel['metadataDefaults']> = [];
  const contextWindow = upstreamContext ?? knownMetadata?.contextWindow ?? 0;
  const tools = declaredTools ?? knownMetadata?.tools ?? false;
  const vision = upstreamVision ?? knownMetadata?.vision ?? false;
  for (const [key, upstream, dictionary] of [['contextWindow', upstreamContext, knownMetadata?.contextWindow], ['tools', declaredTools, knownMetadata?.tools], ['vision', upstreamVision, knownMetadata?.vision]] as const) {
    if (upstream === undefined) { if (dictionary !== undefined) metadataInferred.push(key); else metadataDefaults.push(key); }
  }
  const declaredReasoning = [data.supported_reasoning_levels, data.supportedReasoningEfforts, data.supported_reasoning_efforts, data.reasoning_efforts, data.supports_reasoning_effort, supports.reasoning_effort,
    effort.supported_levels, goReasoning.effort, claudeEffort.supported === false ? false : claudeLevels.length ? claudeLevels : undefined]
    .find(value => Array.isArray(value) || value === false);
  const declaredThinking = booleanValue(data.thinking, data.supports_thinking, capabilities.thinking, supports.thinking, supports.reasoning, claudeThinking.supported, goReasoning.supported);
  // 修改点：上游明确不支持思考时，也要收口字典推断的等级，不能导出
  // thinking:false 与非空等级的矛盾配置。缺少声明才使用内置维护参数。
  const declaredLevels = declaredThinking === false || declaredReasoning === false ? [] : Array.isArray(declaredReasoning) ? declaredReasoning : undefined;
  const reasoningEfforts = declaredLevels !== undefined
    ? sanitizeReasoningEfforts(declaredLevels.map(level => typeof level === 'string' ? level : object(level).effort ?? object(level).reasoningEffort))
    : reasoningMetadata?.reasoningEfforts;
  if (declaredLevels === undefined && reasoningEfforts !== undefined) metadataInferred.push('reasoningEfforts');
  const goDefault = object(goReasoning.default);
  const declaredDefaultLevel = data.default_reasoning_level ?? data.default_reasoning_effort ?? data.defaultReasoningEffort ?? effort.default_level ?? (goDefault.type === 'effort' ? goDefault.value : undefined);
  const preferredLevel = declaredDefaultLevel ?? reasoningMetadata?.defaultReasoningEffort;
  const defaultReasoningEffort = isReasoningEffort(preferredLevel) && reasoningEfforts?.includes(preferredLevel) ? preferredLevel : undefined;
  if (declaredDefaultLevel === undefined && defaultReasoningEffort !== undefined) metadataInferred.push('defaultReasoningEffort');
  const declaredFormat = data.reasoning_effort_format ?? data.reasoningEffortFormat;
  // 修改点：目录发布的是能力上限；接近完整上下文时不能直接充当
  // 初次添加的请求预算，否则客户端仅剩 1 token 输入空间。用户后续
  // 明确选择的预算、以及已经保存的模型，仍由 addSelected/rediscovery 保留。
  const preferredOutput = knownMetadata?.defaultOutputTokens;
  const upstreamOutputBudget = upstreamOutput !== undefined && contextWindow > 1 && upstreamOutput >= contextWindow
    ? Math.min(upstreamOutput, preferredOutput !== undefined && preferredOutput > 0 && preferredOutput < contextWindow
      ? preferredOutput : Math.max(1, Math.floor(contextWindow / 4)))
    : upstreamOutput;
  const upstreamSpecs = modelSpecs({
    maxInputTokens: upstreamInput, maxOutputTokens: upstreamOutputBudget,
    thinking: declaredThinking,
    reasoningEffortFormat: declaredFormat,
    adaptiveThinking: booleanValue(data.adaptive_thinking, data.adaptiveThinking, capabilities.adaptive_thinking, object(object(claudeThinking.types).adaptive).supported),
    minThinkingBudget: positiveContext(data.min_thinking_budget, data.minThinkingBudget),
    maxThinkingBudget: positiveContext(data.max_thinking_budget, data.maxThinkingBudget),
  });
  const inferredSpecs = modelSpecs(knownMetadata ? { ...knownMetadata, maxInputTokens: knownMetadata.defaultInputTokens ?? knownMetadata.maxInputTokens, maxOutputTokens: knownMetadata.defaultOutputTokens ?? knownMetadata.maxOutputTokens } : reasoningMetadata ?? {});
  const specs = { ...inferredSpecs, ...upstreamSpecs };
  if (!reasoningEfforts?.length) delete specs.reasoningEffortFormat;
  if (declaredThinking === false) {
    delete specs.adaptiveThinking;
    delete specs.minThinkingBudget;
    delete specs.maxThinkingBudget;
  }
  for (const key of MODEL_SPEC_FIELDS) if (upstreamSpecs[key] === undefined && specs[key] !== undefined && inferredSpecs[key] !== undefined) metadataInferred.push(key);
  const metadataSource = upstreamContext !== undefined || declaredTools !== undefined || upstreamVision !== undefined || declaredLevels !== undefined || Object.keys(upstreamSpecs).length ? 'upstream' : 'defaults';
  return { upstreamId, displayName: safeText(data.display_name ?? data.displayName ?? data.name) || upstreamId,
    wireApi, contextWindow, tools, vision, metadataSource, metadataDefaults, ...specs,
    ...(metadataInferred.length ? { metadataInferred } : {}),
    ...(metadataInferred.length && knownMetadata ? { metadataReference: { sourceUrl: knownMetadata.sourceUrl, verifiedAt: knownMetadata.verifiedAt } } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) } : {}) };
}
function httpFailure(status: number): CatalogFailure {
  if (status === 401) return new CatalogFailure('authentication', '模型目录返回 HTTP 401：上游拒绝了当前凭据。请确认 API Key 属于此供应商和套餐，并重新保存密钥。', status);
  if (status === 402) return new CatalogFailure('upstream', '模型目录返回 HTTP 402：余额不足或支付状态受限，请检查余额与套餐。', status);
  if (status === 403) return new CatalogFailure('permission', '模型目录返回 HTTP 403：当前账号或套餐没有读取此目录的权限。此结果不能单独判断模型能否调用。', status);
  if (status === 404 || status === 405) return new CatalogFailure('unsupported', `此地址没有可读取的模型目录（HTTP ${status}）。请核对套餐专属地址；不提供目录的供应商仍可手动添加模型。`, status);
  if (status === 429) return new CatalogFailure('rate-limit', '模型目录请求过于频繁或额度受限（HTTP 429），请稍后重试。', status);
  if (status >= 300 && status < 400) return new CatalogFailure('invalid-response', '模型目录返回重定向，已拒绝向其他地址发送凭据。', status);
  return new CatalogFailure('upstream', `模型目录请求失败（HTTP ${status}），请稍后重试。`, status);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<{ data: unknown; bytes: number }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new CatalogFailure('invalid-response', '模型目录响应过大，已停止读取。'); }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) {
    await response.body?.cancel(); throw new CatalogFailure('invalid-response', '模型目录未返回 JSON，请核对 API 基础地址。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CatalogFailure('invalid-response', '模型目录响应为空。');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new CatalogFailure('timeout', '读取模型目录超时，请检查网络后重试。');
      const part = await reader.read();
      if (signal.aborted) throw new CatalogFailure('timeout', '读取模型目录超时，请检查网络后重试。');
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new CatalogFailure('invalid-response', '模型目录响应过大，已停止读取。'); }
      chunks.push(part.value);
    }
    try { return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes }; }
    catch { throw new CatalogFailure('invalid-response', '模型目录返回了无效 JSON，请核对 API 地址。'); }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function hiddenModel(entry: unknown, provider: Provider): boolean {
  const data = object(entry);
  if (isTraeRelayProvider(provider)) {
    // v1.0.10 returns its offline model list even without an account. A live row may
    // also advertise a fallback route, so exclude only rows with no other endpoint.
    const endpoints = [data.endpoint, ...(Array.isArray(data.endpoints) ? data.endpoints : [])].filter(name => typeof name === 'string' && name);
    return endpoints.length > 0 && endpoints.every(name => name === 'fallback');
  }
  // Picker-hidden subscription models remain in the full discovery directory.
  // Explicit non-chat Copilot entries cannot be called through this gateway.
  return provider.kind === 'copilot' && typeof object(data.capabilities).type === 'string' && object(data.capabilities).type !== 'chat';
}
function modelEntries(payload: unknown, provider: Provider): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = object(payload);
  const array = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : provider.kind === 'codex' && Array.isArray(data.items) ? data.items : undefined;
  // Native Codex catalogs may use a map whose keys are model slugs. This is
  // deliberately separate from arbitrary objects returned by compatible APIs.
  if (provider.kind === 'codex' && data.models !== null && typeof data.models === 'object' && !Array.isArray(data.models)) {
    const mapped = Object.entries(object(data.models)).flatMap<unknown>(([key, entry]) => {
      if (typeof entry === 'string') return [entry];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const model = object(entry);
      return [{ ...model, id: safeText(model.id) || key }];
    });
    return [...(array ?? []), ...mapped];
  }
  if (array) return array;
  throw new CatalogFailure('invalid-response', '上游返回的内容不包含模型列表，请核对 API 地址。');
}
function nextPage(payload: unknown, current: string, initial: string, provider: Provider, messagesCatalog = false): string | undefined {
  const data = object(payload);
  const links = object(data.links);
  const next = data.next ?? data.next_page ?? data.nextPage ?? links.next;
  let target: URL | undefined;
  if (typeof next === 'string' && next.trim()) {
    if (next.length > 2000) throw new CatalogFailure('invalid-response', '模型目录分页地址无效。');
    try { target = new URL(next, current); } catch { throw new CatalogFailure('invalid-response', '模型目录分页地址无效。'); }
  } else if (typeof next === 'number' && Number.isSafeInteger(next) && next > 0) {
    target = new URL(current); target.searchParams.set('page', String(next));
  } else if (data.has_more === true) {
    const cursor = safeText(data.next_cursor ?? data.last_id, 1000);
    if (!cursor) throw new CatalogFailure('invalid-response', '模型目录声明仍有下一页，但没有提供分页信息。');
    target = new URL(current); target.searchParams.set(data.next_cursor ? 'cursor' : messagesCatalog ? 'after_id' : 'after', cursor);
  }
  if (!target) return undefined;
  const base = new URL(initial);
  const isCodex = provider.kind === 'codex';
  const allowedKeys = isCodex ? new Set([...queryKeys, 'client_version']) : messagesCatalog ? new Set([...queryKeys, 'after_id', 'before_id']) : queryKeys;
  const initialVersions = base.searchParams.getAll('client_version');
  const nextVersions = target.searchParams.getAll('client_version');
  const invalidVersion = isCodex && (initialVersions.length !== 1 || nextVersions.length !== 1 || nextVersions[0] !== initialVersions[0]);
  if (target.origin !== base.origin || target.pathname !== base.pathname || target.username || target.password || target.hash || invalidVersion || [...target.searchParams.keys()].some(key => !allowedKeys.has(key))) {
    throw new CatalogFailure('invalid-response', '模型目录分页离开了当前模型接口，已停止请求。');
  }
  return target.toString();
}

/** Discover actual upstream models, enriching missing metadata without fabricating a model list or forwarding raw error bodies. */
export class ModelCatalog {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedDiscovery>();
  private readonly revisions = new Map<string, number>();
  private readonly parameterPreviews = new Map<string, { preview: ParameterPreview; originals: Map<string, Model>; fingerprint: string; expiresAt: number }>();
  constructor(private readonly store: CatalogStore, private readonly oauth: CatalogOAuth, private readonly options: { fetch?: typeof fetch; now?: () => number; nativeModels?: (provider: Provider, signal: AbortSignal) => Promise<Response | undefined> } = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
    this.parameterPreviews.delete(providerId);
    this.revisions.set(providerId, (this.revisions.get(providerId) ?? 0) + 1);
  }
  discover(providerId: string): Promise<DiscoveryResult> {
    this.invalidate(providerId);
    return this.readDirectory(providerId, this.revisions.get(providerId)!);
  }
  async previewParameters(providerId: string, includeManufacturer = false): Promise<ParameterPreview> {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw staleCatalog();
    const discovery = this.discover(providerId);
    const revision = this.revisions.get(providerId), identity = fingerprint(provider);
    const result = await discovery;
    const current = this.store.getProvider(providerId);
    if (!current || fingerprint(current) !== identity || this.revisions.get(providerId) !== revision) throw staleCatalog();
    const directory = result.ok ? this.cache.get(providerId)?.upstream : undefined;
    const models = this.store.listModels().filter(model => model.providerId === providerId);
    const rows = models.flatMap(model => parameterRow(provider, model, directory?.get(model.upstreamId), includeManufacturer === true) ?? []);
    const preview: ParameterPreview = { token: randomUUID(), total: models.length, rows, ...(!result.ok ? { catalogError: result.message } : {}) };
    this.parameterPreviews.set(providerId, { preview, originals: new Map(models.map(model => [model.id, model])), fingerprint: identity, expiresAt: this.now() + CACHE_LIFETIME_MS });
    return structuredClone(preview);
  }
  applyParameters(providerId: string, token: string, ids: string[], replace: boolean): number {
    const pending = this.parameterPreviews.get(providerId), provider = this.store.getProvider(providerId);
    if (!pending || pending.preview.token !== token || !provider || fingerprint(provider) !== pending.fingerprint || this.now() >= pending.expiresAt) throw staleCatalog();
    if (typeof replace !== 'boolean' || !Array.isArray(ids) || !ids.length || ids.length > pending.preview.rows.length || new Set(ids).size !== ids.length) throw new Error('请选择预览中的模型。');
    const saved = new Map(this.store.listModels().map(model => [model.id, model]));
    const rows = new Map(pending.preview.rows.map(row => [row.id, row]));
    const changes = ids.map(id => {
      const model = saved.get(id), row = rows.get(id);
      if (!model || !row || !isDeepStrictEqual(model, pending.originals.get(id))) throw new Error('模型已变化，请重新预览参数。');
      const fields = replace ? row.all : row.missing;
      if (!fields.length) throw new Error('所选模型没有可应用的参数。');
      return { ...model, ...Object.fromEntries(fields.map(field => [field.field, field.after ?? undefined])) };
    });
    this.store.saveModels(changes);
    this.parameterPreviews.delete(providerId);
    return changes.length;
  }
  private async readDirectory(providerId: string, revision: number): Promise<DiscoveryResult> {
    const provider = this.store.getProvider(providerId);
    const sourceFingerprint = provider && fingerprint(provider);
    let statusCode: number | undefined;
    try {
      if (!provider) throw new CatalogFailure('invalid-provider', '供应商不存在。');
      const publicGoCatalog = !provider.hasSecret && provider.kind === 'opencode-go' && provider.baseUrl === OPENCODE_GO_BASE_URL;
      if (!provider.hasSecret && !publicGoCatalog) throw new CatalogFailure('missing-credentials', (provider.kind === 'openai-compatible' || provider.kind === 'opencode-go') ? '请先保存 API Key，再获取模型列表。' : '请先完成订阅授权，再获取模型列表。');
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      // Resolve the narrow main-process port once. Ordinary providers return
      // undefined and continue through the authenticated HTTP catalog path.
      const nativeResponse = await this.options.nativeModels?.(provider, signal);
      const useNativeCatalog = Boolean(provider.nativeAdapter || nativeResponse);
      const messagesCatalog = !useNativeCatalog && provider.kind === 'openai-compatible' && (presetById(provider.presetId)?.defaultWireApi === 'messages'
        || !isTraeRelayProvider(provider) && this.store.listModels().some(model => model.providerId === providerId && model.wireApi === 'messages'));
      // Preparing the request also refreshes native subscription credentials.
      const expected = messagesCatalog ? anthropicEndpoint(provider.baseUrl, '/models') : modelCatalogEndpoint(provider);
      let request: PreparedUpstream;
      try { request = useNativeCatalog || publicGoCatalog ? { url: expected, headers: {}, body: {} } : await this.oauth.prepareRequest(provider, messagesCatalog ? '/v1/models' : '/models', {}); }
      catch {
        if (provider.presetId === 'jetbrains-central') throw new CatalogFailure('authentication', '请先在 JetBrains 供应商详情中启动本机反代，再获取模型列表。');
        throw new CatalogFailure('authentication', (provider.kind === 'openai-compatible' || provider.kind === 'opencode-go') ? '无法准备 API 凭据，请重新保存 API Key。' : '无法准备订阅授权，请在授权中心检查账号或重新登录。'); }
      if (provider.kind === 'copilot' ? !isCopilotUpstream(request.url, '/models') : request.url !== expected) throw new CatalogFailure('invalid-provider', '模型目录请求地址与当前供应商不一致。');
      if (messagesCatalog) {
        // 修改点：custom 来源已明确选择 Messages 时使用 Anthropic 目录合同。
        // 凭据只由主进程授权器提供，所选鉴权方式必须与 Claude 实际配置一致。
        const headers = new Headers(request.headers);
        const validAuth = provider.messagesAuth === 'api-key'
          ? /^\S+$/.test(headers.get('x-api-key') || '') && !headers.has('authorization')
          : /^Bearer \S+$/.test(headers.get('authorization') || '') && !headers.has('x-api-key');
        if (!validAuth || headers.get('anthropic-version') !== '2023-06-01') throw new CatalogFailure('authentication', 'Messages 模型目录鉴权方式与供应商配置不一致，请检查 API Key 和鉴权设置。');
      }
      let next: string | undefined = request.url;
      let totalBytes = 0;
      const visited = new Set<string>();
      const models = new Map<string, Omit<DiscoveredModel, 'alias'>>();
      let history: DiscoveryResult['history'];
      for (let page = 0; next; page++) {
        if (page >= MAX_PAGES || visited.has(next)) throw new CatalogFailure('invalid-response', '模型目录分页过多或重复，已停止请求；没有保存不完整的目录。');
        visited.add(next);
        const response = useNativeCatalog
          ? nativeResponse
          : await this.fetcher(next, { method: 'GET', headers: request.headers, redirect: 'error', signal });
        if (!response) throw new CatalogFailure('invalid-provider', '此账号的内置适配器不可用，请重新导入账号。');
        statusCode = response.status;
        if (!response.ok) { await response.body?.cancel(); throw httpFailure(response.status); }
        const result = await boundedJson(response, signal);
        history = nativeCatalogHistory(result.data, provider, useNativeCatalog);
        totalBytes += result.bytes;
        if (totalBytes > MAX_TOTAL_BYTES) throw new CatalogFailure('invalid-response', '模型目录累计响应过大，已停止读取。');
        const rawEntries = modelEntries(result.data, provider);
        if (rawEntries.length > MAX_MODELS) throw new CatalogFailure('invalid-response', '模型目录条目过多，已停止读取。');
        const entries = rawEntries.filter(entry => !hiddenModel(entry, provider));
        for (const entry of entries) {
          const model = parseModel(entry, provider, messagesCatalog);
          if (!model) continue;
          const row = object(entry), visibility = history ? row.modeldock_catalog_visibility : subscriptionCatalogVisibility(entry, provider);
          const candidate = models.get(model.upstreamId) ?? model;
          if (visibility === 'current' || (visibility === 'historical' && !candidate.catalogVisibility)) candidate.catalogVisibility = visibility;
          if (history && row.modeldock_catalog_importable === false) {
            candidate.catalogImportable = false;
            const reason = row.modeldock_catalog_blocked_reason;
            if (history.source === 'trae-client' && (reason === 'account-access' || reason === 'access-unknown') && candidate.catalogBlockedReason !== 'account-access') {
              candidate.catalogBlockedReason = reason;
            }
          }
          models.set(model.upstreamId, candidate);
          if (models.size > MAX_MODELS) throw new CatalogFailure('invalid-response', '模型目录条目过多，已停止读取。');
        }
        if (entries.length > 0 && models.size === 0) throw new CatalogFailure('invalid-response', '模型目录没有有效的模型 ID。');
        next = nextPage(result.data, next, request.url, provider, messagesCatalog);
        if (useNativeCatalog && next) throw new CatalogFailure('invalid-response', '内置适配器返回了无效的分页目录。');
      }
      const currentProvider = this.store.getProvider(providerId);
      if (!currentProvider || this.revisions.get(providerId) !== revision || fingerprint(currentProvider) !== sourceFingerprint) {
        throw new CatalogFailure('invalid-provider', '供应商配置已变化，请重新获取模型列表。');
      }
      const existingModels = this.store.listModels();
      const plannedModels: Pick<Model, 'id' | 'providerId' | 'alias'>[] = [...existingModels];
      const discovered: DiscoveredModel[] = [...models.values()].map(model => {
        const existing = existingModels.find(item => item.providerId === providerId && item.upstreamId === model.upstreamId);
        const alias = existing?.alias ?? discoveryAlias(model.upstreamId, providerId, plannedModels);
        if (!existing) plannedModels.push({ id: `discovered-${plannedModels.length}`, providerId, alias });
        if (!existing) return { ...model, alias };
        // Rediscovery must display the saved user settings and never attribute
        // them to newly inferred or upstream metadata.
        const { metadataInferred: _inferred, metadataReference: _reference, metadataDefaults: _defaults,
          reasoningEfforts: _levels, defaultReasoningEffort: _defaultLevel, ...discovered } = model;
        // An old saved row without new fields must stay unknown on rediscovery.
        for (const key of MODEL_SPEC_FIELDS) delete discovered[key];
        return { ...discovered, alias, existingModelId: existing.id, displayName: existing.displayName, wireApi: existing.wireApi,
          contextWindow: existing.contextWindow, tools: existing.tools, vision: existing.vision, ...modelSpecs(existing),
          ...(!existing.reasoningEfforts?.length && existing.thinking !== false && model.catalogImportable !== false && model.wireApi === existing.wireApi && model.reasoningEfforts?.length && !model.metadataInferred?.includes('reasoningEfforts')
            ? { availableReasoning: { levels: model.reasoningEfforts, defaultLevel: model.defaultReasoningEffort } } : {}),
          ...(existing.reasoningEfforts ? { reasoningEfforts: [...existing.reasoningEfforts] } : {}),
          ...(existing.defaultReasoningEffort ? { defaultReasoningEffort: existing.defaultReasoningEffort } : {}) };
      });
      history ??= subscriptionCatalogHistory(provider, discovered);
      this.cache.set(providerId, { fingerprint: fingerprint(provider), expiresAt: this.now() + CACHE_LIFETIME_MS, upstream: models, models: new Map(discovered.map(model => [model.upstreamId, structuredClone(model)])) });
      return { ok: true, providerId, statusCode, message: `已读取模型目录，发现 ${discovered.length} 个模型。目录可见性不代表模型调用已验证。`, models: discovered, ...(history ? { history } : {}) };
    } catch (error) {
      // Upstream bodies and arbitrary exception text can contain credentials.
      const failure = error instanceof CatalogFailure ? error : error instanceof JetBrainsIdeAccountError || error instanceof JetBrainsIdeApiError
        ? new CatalogFailure(error.status === 451 || error.status === 402 || error.status === 403 ? 'permission' : error.status === 401 ? 'authentication'
          : error.status === 429 ? 'rate-limit' : error.status === 504 ? 'timeout' : error.code === 'network' ? 'network' : 'upstream', error.message, error.status)
        : error instanceof TraeNativeAccountError || error instanceof CentralNativeAccountError
        ? new CatalogFailure('authentication', error.message, 401) : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? new CatalogFailure('timeout', '获取模型目录超时，请检查网络后重试。')
        : new CatalogFailure('network', '无法读取模型目录，请检查网络、API 地址或订阅授权状态后重试。');
      return { ok: false, providerId, statusCode: failure.statusCode ?? statusCode, errorCategory: failure.category, message: failure.message, models: [] };
    }
  }
  private selectedDirectory(providerId: string) {
    const provider = this.store.getProvider(providerId), cached = this.cache.get(providerId);
    if (!provider || !cached || cached.fingerprint !== fingerprint(provider)) throw staleCatalog();
    return { cached, provider };
  }
  async addSelectedWithRefresh(providerId: string, selections: ModelSelection[], assertEditable: () => void): Promise<AddModelsResult> {
    assertEditable();
    const { cached } = this.selectedDirectory(providerId);
    if (cached.expiresAt <= this.now()) {
      // Refresh only the same source. An invalidated or replaced directory cannot authorize a pending selection.
      const revision = this.revisions.get(providerId)!;
      if (!Array.isArray(selections) || !selections.length || selections.length > MAX_MODELS || selections.some(row => !cached.models.has(row?.upstreamId))) {
        throw new Error('所选模型不属于最近读取的模型目录，请重新获取。');
      }
      const refresh = cached.refresh ??= this.readDirectory(providerId, revision);
      try {
        const latest = await refresh;
        if (this.revisions.get(providerId) !== revision) throw staleCatalog();
        if (!latest.ok) throw new Error(`添加前重新获取模型列表失败：${latest.message}`);
      } finally {
        if (cached.refresh === refresh) delete cached.refresh;
      }
      assertEditable();
    }
    return this.addSelected(providerId, selections);
  }
  addSelected(providerId: string, selections: ModelSelection[]): AddModelsResult {
    const { cached, provider } = this.selectedDirectory(providerId);
    if (cached.expiresAt <= this.now()) throw staleCatalog();
    if (!Array.isArray(selections) || selections.length === 0 || selections.length > MAX_MODELS) throw new Error('请选择有效的模型。');
    const existing = this.store.listModels();
    const plannedModels: Pick<Model, 'id' | 'providerId' | 'alias'>[] = [...existing];
    const selectedIds = new Set<string>();
    const inputs: ModelInput[] = [];
    const updatedIds = new Set<string>();
    const skipped: string[] = [];
    for (const selection of selections) {
      if (!selection || typeof selection !== 'object' || !cached.models.has(selection.upstreamId)) throw new Error('所选模型不属于最近读取的模型目录，请重新获取。');
      if (selectedIds.has(selection.upstreamId)) continue;
      selectedIds.add(selection.upstreamId);
      const found = cached.models.get(selection.upstreamId)!;
      const saved = existing.find(model => model.providerId === providerId && model.upstreamId === selection.upstreamId);
      if (selection.fillMissingReasoningFor !== undefined) {
        const offer = found.availableReasoning;
        if (offer && saved && saved.id === selection.fillMissingReasoningFor && found.existingModelId === saved.id && saved.wireApi === found.wireApi && saved.thinking !== false && !saved.reasoningEfforts?.length) {
          inputs.push({ ...saved, thinking: true, reasoningEfforts: offer.levels, defaultReasoningEffort: offer.defaultLevel, reasoningEffortFormat: saved.wireApi });
          updatedIds.add(saved.id);
        } else skipped.push(selection.upstreamId);
        continue;
      }
      if (saved) { skipped.push(selection.upstreamId); continue; }
      if (found.catalogImportable === false) {
        const reason = found.catalogBlockedReason ? catalogAccessMessages[found.catalogBlockedReason] : '尚未核实可用的官方调用通道，暂不能添加。';
        throw new Error(`「${found.upstreamId}」${reason}`);
      }
      const requestedAlias = selection.alias === undefined ? undefined : safeText(selection.alias, 400);
      if (requestedAlias !== undefined && (!requestedAlias || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(requestedAlias))) throw new Error('模型别名只能包含字母、数字和 . _ : / -。');
      const alias = suggestModelAlias(providerId, requestedAlias || found.alias, plannedModels);
      if (alias.length > 400) throw new Error('模型别名过长。');
      plannedModels.push({ id: `selected-${plannedModels.length}`, providerId, alias });
      const displayName = selection.displayName === undefined ? found.displayName : safeText(selection.displayName);
      if (!displayName) throw new Error('模型显示名称无效。');
      const wireApi = selection.wireApi ?? found.wireApi;
      if (!['chat-completions', 'responses', 'messages'].includes(wireApi) || (provider.kind === 'codex' || provider.kind === 'grok') && wireApi !== 'responses'
        || (provider.kind === 'copilot' || provider.kind === 'opencode-go') && wireApi === 'messages') throw new Error('模型协议无效；Codex 和 Grok 订阅仅支持原生 Responses，Copilot 和 OpenCode Go 使用 Chat 或 Responses。');
      const contextWindow = selection.contextWindow ?? found.contextWindow;
      const tools = selection.tools ?? found.tools;
      const vision = selection.vision ?? found.vision;
      if (!Number.isSafeInteger(contextWindow) || contextWindow < 0 || typeof tools !== 'boolean' || typeof vision !== 'boolean') throw new Error('模型能力参数无效。');
      const reasoningEfforts = selection.reasoningEfforts === undefined ? found.reasoningEfforts ?? [] : sanitizeReasoningEfforts(selection.reasoningEfforts);
      // “由工具选择”会显式清空默认档位；只有未提供该字段才继承目录值。
      const defaultReasoningEffort = Object.hasOwn(selection, 'defaultReasoningEffort') ? selection.defaultReasoningEffort
        : found.defaultReasoningEffort && reasoningEfforts.includes(found.defaultReasoningEffort) ? found.defaultReasoningEffort : undefined;
      if (defaultReasoningEffort !== undefined && (!isReasoningEffort(defaultReasoningEffort) || !reasoningEfforts.includes(defaultReasoningEffort))) throw new Error('默认思考强度必须属于模型支持的级别。');
      const specs = modelSpecs({ ...found, ...Object.fromEntries(MODEL_SPEC_FIELDS.filter(key => selection[key] !== undefined).map(key => [key, selection[key]])) }, true);
      inputs.push({ providerId, upstreamId: found.upstreamId, alias, displayName, wireApi, contextWindow, tools, vision, enabled: true, ...specs, ...(selection.reasoningEfforts !== undefined || found.reasoningEfforts !== undefined ? { reasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) } : {}) });
    }
    const written = inputs.length ? this.store.saveModels(inputs) : [];
    if (!updatedIds.size) return { added: written, skipped };
    return { added: written.filter(model => !updatedIds.has(model.id)), updated: written.filter(model => updatedIds.has(model.id)), skipped };
  }
}
