import { createHash, randomUUID } from 'node:crypto';
import { catalogAccessMessages } from '../shared/catalog-types';
import type { SubscriptionUsage } from '../shared/auth-types';
import type { TraeClientCredentials } from './trae-client-import';
import { parseTraeQuota, parseTraePlan } from './trae-relay-usage';
import { canUseTraeClientModel, readTraeClientModelCatalog, traeModelAccess, traeModelVision, type TraeClientModel, type TraeClientModelCatalog, type TraeClientModelOptions } from './trae-client-models';

/** TraeCode CN CustomModel / ChatMessageData protocol, fixed reference:
 * Trae2api-cn bb7b659 raw_client.build_traecode_chat_body/headers and installed
 * Trae CN3.4.16 ai-modules-chat LLMRawChatV2/GetConfigDetail. Native tool
 * FunctionDefinition/Toolcall fields were also checked with live inference;
 * the reference's object-shaped TraeCode helper is not the wire schema.
 * This is the current
 * llm_raw_chat contract, not legacy Work Extra/llm_utils_chat or Remote sessions.
 * Every request is independent and carries the caller's complete native history.
 * Live account/model acceptance remains separate from mock protocol verification.
 */
const GATEWAY = 'https://trae-api-cn.mchost.guru';
const ACCOUNT = 'https://api.trae.cn';
const FUNCTION = 'chat_v3';
// The gateway selects the model directory by protocol revision. TRAE CN
// 3.4.16 sends this value in both version-code headers for chat requests.
const CHAT_PROTOCOL_REVISION = '20261029';
const MAX_JSON = 4 * 1024 * 1024, MAX_EVENT = 1024 * 1024, MAX_OUTPUT = 32 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const text = (value: unknown, max = 256): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const name = (value: unknown): string | undefined => { const result = text(value); return result && /^[\w.\-:/@+]+$/.test(result) ? result : undefined; };
export type TraeApiErrorCode = 'account-access' | 'access-unknown' | 'credentials' | 'authorization' | 'network' | 'request' | 'response' | 'model' | 'cancelled' | 'limit' | 'upstream' | 'capability' | 'image-model' | 'image-format';
const errors: Record<TraeApiErrorCode, string> = {
  ...catalogAccessMessages,
  credentials: 'TRAE 本机账号信息无效，请回到原客户端重新登录并导入。',
  authorization: 'TRAE 未接受当前账号授权，请回原客户端重新登录后再导入。',
  network: 'TRAE 官方服务暂时无法连接，请检查应用网络后重试。',
  request: 'TRAE 连接需要有效的 Chat 消息、模型和函数工具参数。',
  response: 'TRAE 返回了无法识别或不完整的数据，本次响应未被标记为成功。',
  model: '所选模型不在当前 TRAE 账号的原生 IDE 模型目录中，请刷新模型列表。',
  cancelled: 'TRAE 请求已取消或超时。',
  limit: 'TRAE 请求或响应超过支持范围。',
  upstream: 'TRAE 原生接口拒绝本次请求，请检查账号、模型权限及客户端状态。',
  capability: '当前 TRAE 连接不支持所请求的输入或控制参数。',
  'image-model': '当前 TRAE 模型目录未确认此模型支持图片。请选择支持图片的模型，或移除对话中的图片。',
  'image-format': 'TRAE 图片输入需要用户消息中的内嵌 PNG、JPEG、WebP 或 GIF 图片。请直接粘贴或附加图片。',
};
export class TraeApiError extends Error {
  constructor(readonly code: TraeApiErrorCode, readonly status?: number, readonly parameter?: string) {
    super(errors[code] + (parameter ? ` 不支持的参数：${parameter}。` : '')); this.name = 'TraeApiError';
  }
}
const fail = (code: TraeApiErrorCode, status?: number, parameter?: string) => new TraeApiError(code, status, parameter);
export interface TraeApiModel {
  id: string; object: 'model'; owned_by: 'trae'; name?: string; context_length?: number;
  modeldock_catalog_visibility?: 'current' | 'historical';
  modeldock_catalog_importable?: false;
  modeldock_catalog_blocked_reason?: BlockedReason;
  reasoning_efforts?: string[];
  vision?: boolean;
  default_reasoning_effort?: string;
}
interface ReasoningConfig {
  field: 'reasoning_effort' | 'reasoning_effort_level';
  options: string[];
  defaultLevel?: string;
  pickerLabels?: ReadonlyMap<string, string>;
}
interface Route { model: TraeApiModel; providerId: string; configSource: number; reasoning?: ReasoningConfig }

const legacyReasoningEfforts = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
// ModelDock's client-facing picker uses standard effort names. Only translate
// the known TRAE CN two/three-tier profile; other native enums remain exact.
const cnPickerLabels = new Map([['light', 'low'], ['high', 'high'], ['extra_high', 'max']]);
const previousThreeTierLabels = new Map([['medium', 'high'], ['xhigh', 'max']]);

function nativeReasoningEffort(config: ReasoningConfig | undefined, level: string): string {
  if (config ? config.options.includes(level) : legacyReasoningEfforts.has(level)) return level;
  const labels = config?.pickerLabels;
  if (config && labels) {
    // Existing Qwen presets call the middle and top tiers medium and xhigh.
    const label = config.options.includes('extra_high') ? previousThreeTierLabels.get(level) ?? level : level;
    const native = config.options.find(option => labels.get(option) === label);
    if (native) return native;
  }
  throw fail('capability', undefined, 'reasoning_effort');
}

function reasoningConfig(row: ObjectValue): ReasoningConfig | undefined {
  // Native Raw v2 receives the exact declared spelling in its native field.
  if (row.reasoning_effort_config !== undefined) {
    let config = object(row.reasoning_effort_config);
    if (typeof row.reasoning_effort_config === 'string' && row.reasoning_effort_config.length <= 16384) {
      try { config = object(JSON.parse(row.reasoning_effort_config)); } catch { /* Invalid declarations expose no controllable levels. */ }
    }
    const raw = config?.options;
    const disabled: ReasoningConfig = { field: 'reasoning_effort_level', options: [] };
    if (config?.support_thinking !== true || !Array.isArray(raw) || !raw.length || raw.length > 32) return disabled;
    const options = raw.map(value => typeof value === 'string' ? value.trim() : '');
    const defaultLevel = typeof config.default_level === 'string' ? config.default_level.trim() : '';
    if (options.some(value => !name(value)) || new Set(options).size !== options.length || !options.includes(defaultLevel)) return disabled;
    const cnPicker = options.includes('light') && options.includes('high') && options.every(option => cnPickerLabels.has(option));
    return { field: 'reasoning_effort_level', options, defaultLevel, ...(cnPicker ? { pickerLabels: cnPickerLabels } : {}) };
  }
  if (row.reasoning_effort_options !== undefined) {
    const options = Array.isArray(row.reasoning_effort_options)
      ? [...new Set(row.reasoning_effort_options.flatMap(value => typeof value === 'string' && legacyReasoningEfforts.has(value.trim().toLowerCase()) ? [value.trim().toLowerCase()] : []))] : [];
    const defaultLevel = typeof row.default_reasoning_effort === 'string' ? row.default_reasoning_effort.trim().toLowerCase() : '';
    return { field: 'reasoning_effort', options, ...(options.includes(defaultLevel) ? { defaultLevel } : {}) };
  }
}
type BlockedReason = 'account-access' | 'access-unknown';
type Access = Pick<TraeClientModel, 'allowedIdentities' | 'locked'>;
interface Directory { revision: number; at: number; routes: Map<string, Route>; blocked: Map<string, BlockedReason> }

function directoryAccess(raw: unknown): Access | undefined {
  if (raw == null || raw === '') return {};
  try {
    const features = object(typeof raw === 'string' ? JSON.parse(raw) : raw);
    return features && traeModelAccess(features);
  } catch { return undefined; }
}
export interface TraeApiOptions {
  fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number;
  clientModels?: (accountId: string, client?: TraeClientModelCatalog['client']) => Promise<TraeClientModelCatalog | undefined>;
  clientModelOptions?: Omit<TraeClientModelOptions, 'client'>;
}
interface TraeModelsResult {
  object: 'list'; data: TraeApiModel[];
  modeldock_history: { source: 'trae-client'; currentVerified: boolean; message: string };
}
interface Lifetime { signal: AbortSignal; abort(): void; close(): void }
function lifetime(signal: AbortSignal | undefined, milliseconds: number): Lifetime {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, milliseconds); timer.unref?.();
  return { signal: controller.signal, abort, close: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
function credentials(value: TraeClientCredentials): void {
  if (!value || value.host !== ACCOUNT || typeof value.token !== 'string' || !value.token || value.token.length > 32768 || /\s/.test(value.token) || !name(value.userId)) throw fail('credentials');
}
function headers(value: TraeClientCredentials, accept = 'application/json'): Record<string, string> {
  const device = createHash('sha256').update('modeldock-trae-device:' + value.userId).digest('hex');
  return { 'Content-Type': 'application/json', Accept: accept, Authorization: 'Cloud-IDE-JWT ' + value.token,
    'X-Cloudide-Token': value.token, 'X-Ide-Token': value.token, 'X-Uid': value.userId,
    'X-App-Id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8', 'X-App-Version': '3.4.16',
    'X-Ide-Version': '3.4.16', 'X-Ide-Version-Code': CHAT_PROTOCOL_REVISION, 'X-App-Version-Code': CHAT_PROTOCOL_REVISION,
    'X-Ide-Version-Type': 'stable', 'X-Plugin-Channel': 'desktop', 'X-App-Function': FUNCTION, 'X-Ide-Function': FUNCTION,
    'X-Device-Id': device, 'X-Machine-Id': device, 'X-System-Type': 'Windows', 'X-Device-Type': 'windows',
    'X-Request-Id': randomUUID(), 'request-traffic-type': 'prod' };
}
async function readJson(response: Response, signal: AbortSignal): Promise<ObjectValue> {
  if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw fail('cancelled'); }
  if (!response.body) throw fail('response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { const item = await reader.read(); if (signal.aborted) throw fail('cancelled'); if (item.done) break; size += item.value.length; if (size > MAX_JSON) throw fail('limit'); chunks.push(item.value); }
    const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    if (!parsed || parsed.code !== undefined && parsed.code !== 0) throw fail('upstream'); return parsed;
  } catch (error) { throw error instanceof TraeApiError ? error : fail(signal.aborted ? 'cancelled' : 'response'); }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
function content(value: unknown, role: unknown): ObjectValue[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw fail('request');
  return value.map(part => {
    const item = object(part);
    if (item?.type === 'image_url') {
      const image = object(item.image_url), url = image?.url;
      if (role !== 'user' || typeof url !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) throw fail('image-format', 400);
      if (image?.detail !== undefined && image.detail !== 'auto') throw fail('capability', 400, 'image_url.detail');
      return { type: 'image_url', image_url: { url } };
    }
    if (!item || item.type !== 'text' && item.type !== 'input_text' || typeof item.text !== 'string') throw fail('capability');
    return { type: 'text', text: item.text };
  });
}
function messages(raw: unknown): ObjectValue[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 1000) throw fail('request');
  const pending = new Map<string, string>();
  return raw.map(value => {
    const item = object(value); if (!item || !['user', 'assistant', 'system', 'developer', 'tool'].includes(String(item.role))) throw fail('request');
    const role = item.role === 'developer' ? 'system' : item.role, blocks = content(item.content, role);
    const converted: ObjectValue = { role, ...(blocks.length ? { content: blocks } : {}) };
    if (role === 'assistant' && item.tool_calls !== undefined) {
      if (!Array.isArray(item.tool_calls) || item.tool_calls.length > 128) throw fail('request');
      converted.tool_calls = item.tool_calls.map(rawCall => {
        const call = object(rawCall), fn = object(call?.function), id = name(call?.id), fnName = name(fn?.name);
        if (!id || !fnName || typeof fn?.arguments !== 'string' || pending.has(id)) throw fail('request');
        try { if (!object(JSON.parse(fn.arguments))) throw fail('request'); } catch { throw fail('request'); }
        pending.set(id, fnName); return { id, type: 'function', function_call: { name: fnName, arguments: fn.arguments } };
      });
    }
    if (role === 'tool') {
      const id = name(item.tool_call_id), fnName = id && pending.get(id); if (!id || !fnName) throw fail('request');
      converted.tool_call_id = id; converted.name = fnName; pending.delete(id);
    }
    if ((role === 'system' || role === 'user') && !blocks.length) throw fail('request');
    return converted;
  });
}
function tools(value: unknown): ObjectValue[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128) throw fail('request');
  const names = new Set<string>();
  return value.map(raw => {
    const item = object(raw), fn = object(item?.function), fnName = name(fn?.name);
    if (item?.type !== 'function' || !fn || !fnName || names.has(fnName) || fn.parameters !== undefined && !object(fn.parameters)) throw fail('capability');
    // Raw v2's protobuf/JSON adapter requires FunctionDefinition.parameters
    // to contain JSON text. Preserve the caller's complete object schema.
    names.add(fnName); return { type: 'function', function: { name: fnName, description: typeof fn.description === 'string' ? fn.description : '', parameters: JSON.stringify(fn.parameters ?? {}), ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}) } };
  });
}
interface Frame { event: string; data: string }
async function* frames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Frame> {
  if (signal.aborted) { await body.cancel().catch(() => {}); throw fail('cancelled'); }
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', event = '', data: string[] = [], eventSize = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const next = await reader.read(); if (signal.aborted) throw fail('cancelled');
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      if (buffer.length > MAX_EVENT) throw fail('limit');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) { if (data.length || event) yield { event, data: data.join('\n') }; event = ''; data = []; eventSize = 0; }
        else if (line.startsWith('event:')) {
          // The fixed native tool fixtures also have adjacent event/data pairs
          // without blank separators. A new event starts the next native frame.
          if (data.length) { yield { event, data: data.join('\n') }; data = []; eventSize = 0; }
          event = line.slice(6).trim();
        }
        else if (line.startsWith('data:')) { const value = line.slice(5).replace(/^ /, ''); eventSize += value.length; if (eventSize > MAX_EVENT) throw fail('limit'); data.push(value); }
      }
      if (next.done) { if (buffer.trim()) throw fail('response'); if (data.length || event) yield { event, data: data.join('\n') }; break; }
    }
  } catch (error) { throw error instanceof TraeApiError ? error : fail(signal.aborted ? 'cancelled' : 'response'); }
  finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
function usage(raw: unknown): ObjectValue | undefined {
  const value = object(raw); if (!value) return;
  const number = (...keys: string[]) => { for (const key of keys) if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) return Number(value[key]); return undefined; };
  const input = number('input_token', 'input_tokens', 'prompt_tokens'), output = number('output_token', 'output_tokens', 'completion_tokens');
  if (input === undefined && output === undefined) return;
  return { ...(input !== undefined ? { prompt_tokens: input } : {}), ...(output !== undefined ? { completion_tokens: output } : {}),
    ...(input !== undefined && output !== undefined ? { total_tokens: input + output } : {}),
    ...(number('cache_read_tokens') !== undefined ? { prompt_tokens_details: { cached_tokens: number('cache_read_tokens') } } : {}) };
}
interface ToolState { id: string; name: string; arguments: string; emitted: boolean }
function canonicalArguments(value: string): string | undefined {
  const ordered = (raw: unknown): unknown => Array.isArray(raw) ? raw.map(ordered) : object(raw) ? Object.fromEntries(Object.entries(raw as ObjectValue).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, ordered(value)])) : raw;
  try { const parsed = object(JSON.parse(value)); if (parsed) return JSON.stringify(ordered(parsed)); } catch { /* Incomplete argument fragments are not yet JSON. */ }
}
function eventName(raw: string): string {
  const value = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  return ({ responsedone: 'done', streamdone: 'done', tokenusage: 'token_usage' } as Record<string, string>)[value.replace(/_/g, '')] ?? value;
}
function deltaText(value: unknown, depth = 0): string | undefined {
  const item = object(value); if (!item || depth > 4) return;
  for (const key of ['delta', 'text_delta', 'textDelta', 'text', 'content', 'response']) {
    if (typeof item[key] === 'string') return item[key];
    const nested = deltaText(item[key], depth + 1); if (nested !== undefined) return nested;
  }
  return deltaText(item.data ?? item.message, depth + 1);
}
async function* translate(body: ReadableStream<Uint8Array>, model: string, allowed: Set<string>, now: number, signal: AbortSignal, requiredTool = false, parallelTools = true): AsyncGenerator<ObjectValue> {
  const id = 'chatcmpl-' + randomUUID(), created = Math.floor(now / 1000), calls = new Map<number, ToolState>();
  let previous = '', previousReasoning = '', terminal = false, seen = false, finished = 'stop', finalUsage: ObjectValue | undefined, total = 0;
  const chunk = (delta: ObjectValue, finish: string | null = null): ObjectValue => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  yield chunk({ role: 'assistant' });
  for await (const frame of frames(body, signal)) {
    if (frame.data === '[DONE]') { terminal = true; break; }
    if (!frame.data && frame.event === 'done') { terminal = true; break; }
    if (!frame.data) continue;
    // The live queue may send a text progress_notice before any JSON output.
    // It conveys no answer or successful completion. Keep normal error checks
    // for object-shaped notices, and still require visible output plus done.
    const progressNotice = eventName(frame.event) === 'progress_notice';
    let value: ObjectValue | undefined;
    try { value = object(JSON.parse(frame.data)); } catch { if (progressNotice) continue; throw fail('response'); }
    if (!value) { if (progressNotice) continue; throw fail('response'); }
    const event = eventName(frame.event || String(value.event ?? value.event_type ?? value.eventType ?? value.type ?? ''));
    if (event === 'error' || value.error || value.code !== undefined && value.code !== 0) throw fail('upstream');
    if (event === 'token_usage') { finalUsage = usage(value.usage ?? value); continue; }
    if (value.usage) finalUsage = usage(value.usage) ?? finalUsage;
    // Raw v2 output frames carry token fragments and include the inactive
    // channel as null. Legacy response-only output frames are snapshots.
    const outputDelta = event === 'output' && (
      'reasoning_content' in value || 'tool_calls' in value || 'phase' in value || 'multimodal_contents' in value
    );
    const emitText = (raw: unknown, kind: 'content' | 'reasoning_content', incremental: boolean): ObjectValue | undefined => {
      if (raw === undefined || raw === '') return; if (typeof raw !== 'string') throw fail('response');
      const last = kind === 'content' ? previous : previousReasoning;
      let delta: string;
      if (incremental) delta = raw;
      else if (raw.startsWith(last)) delta = raw.slice(last.length);
      else if (last.startsWith(raw)) delta = '';
      else throw fail('response');
      // Current output events are pure deltas and can be forwarded without
      // retaining a second copy of the assembled answer in streaming mode.
      if (!outputDelta) {
        if (kind === 'content') previous = incremental ? last + raw : raw.length >= last.length ? raw : last;
        else previousReasoning = incremental ? last + raw : raw.length >= last.length ? raw : last;
      }
      total += Buffer.byteLength(delta); if (total > MAX_OUTPUT) throw fail('limit');
      if (delta) { seen = true; return chunk({ [kind]: delta }); }
    };
    const incremental = outputDelta || ['text_delta', 'translated_text', 'reasoning_delta'].includes(event);
    const delta = deltaText(value);
    const contentChunk = emitText(value.response ?? (event === 'text_delta' || event === 'translated_text' ? delta : undefined), 'content', incremental);
    if (contentChunk) yield contentChunk;
    const reasoningChunk = emitText(value.reasoning_content ?? (event === 'reasoning_delta' ? delta : undefined), 'reasoning_content', outputDelta || event === 'reasoning_delta');
    if (reasoningChunk) yield reasoningChunk;
    const rawCalls = value.tool_calls ?? (object(value.function_call) ? [{ id: value.id, index: 0, function_call: value.function_call }] : []);
    if (!Array.isArray(rawCalls)) throw fail('response');
    for (const [position, raw] of rawCalls.entries()) {
      const call = object(raw), fn = object(call?.function_call) ?? object(call?.function); if (!call || !fn) throw fail('response');
      const index = call.index === undefined ? position : call.index; if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= 128) throw fail('response');
      let state = calls.get(index); const callId = text(call.id), fnName = text(fn.name);
      if (!state) { state = { id: callId ?? '', name: fnName ?? '', arguments: '', emitted: false }; calls.set(index, state); }
      if (callId && state.id && state.id !== callId || fnName && state.name && state.name !== fnName) throw fail('response');
      if (callId) state.id = callId;
      if (fnName) state.name = fnName;
      if (state.name && !allowed.has(state.name)) throw fail('response');
      const rawArgs = fn.arguments ?? ''; if (typeof rawArgs !== 'string' && !object(rawArgs)) throw fail('response');
      const arguments_ = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
      let added = arguments_;
      if (canonicalArguments(state.arguments) && canonicalArguments(state.arguments) === canonicalArguments(arguments_)) added = '';
      else if (!call.function_call && state.arguments && arguments_.startsWith(state.arguments)) added = arguments_.slice(state.arguments.length);
      state.arguments += added; total += Buffer.byteLength(added); if (total > MAX_OUTPUT) throw fail('limit');
      if (state.id && state.name) {
        const first = !state.emitted; state.emitted = true; seen = true;
        yield chunk({ tool_calls: [{ index, ...(first ? { id: state.id, type: 'function' } : {}), function: { ...(first ? { name: state.name } : {}), arguments: first ? state.arguments : added } }] });
      }
    }
    if (typeof value.finish_reason === 'string') finished = value.finish_reason;
    if (event === 'done') { terminal = true; break; }
  }
  if (!terminal || !seen) throw fail('response');
  const ids = new Set<string>();
  for (const call of calls.values()) { if (!call.id || !call.name || !canonicalArguments(call.arguments) || ids.has(call.id)) throw fail('response'); ids.add(call.id); }
  if (requiredTool && !calls.size || !parallelTools && calls.size > 1) throw fail('response');
  const reason = calls.size ? 'tool_calls' : ['length', 'max_tokens', 'model_context_window_exceeded'].includes(finished) ? 'length' : 'stop';
  yield { ...chunk({}, reason), ...(finalUsage ? { usage: finalUsage } : {}) };
}

export class TraeApi {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly clientModels: NonNullable<TraeApiOptions['clientModels']>;
  private readonly directories = new Map<string, Directory>();
  private directoryRevision = 0;
  constructor(options: TraeApiOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now; this.timeout = options.timeoutMs ?? 300000;
    this.clientModels = options.clientModels ?? ((accountId, client) => client
      ? readTraeClientModelCatalog(accountId, { ...options.clientModelOptions, client }) : Promise.resolve(undefined));
  }
  private async send(url: string, value: TraeClientCredentials, body: unknown, life: Lifetime, accept = 'application/json', extraHeaders: Record<string, string> = {}, method: 'POST' | 'GET' = 'POST'): Promise<Response> {
    if (life.signal.aborted) throw fail('cancelled');
    try {
      const authHeaders = url === ACCOUNT + '/cloudide/api/v3/trae/GetUserInfo'
        ? { 'Content-Type': 'application/json', Accept: accept, 'x-cloudide-token': value.token }
        : headers(value, accept);
      const response = await this.fetch(url, { method, headers: { ...authHeaders, ...extraHeaders }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), redirect: 'error', credentials: 'omit', signal: life.signal });
      if (response.status !== 200 || response.redirected || response.url && new URL(response.url).origin !== new URL(url).origin) { await response.body?.cancel().catch(() => {}); throw fail(response.status === 401 || response.status === 403 ? 'authorization' : 'upstream', response.status); }
      return response;
    } catch (error) { throw error instanceof TraeApiError ? error : fail(life.signal.aborted ? 'cancelled' : 'network'); }
  }
  private key(value: TraeClientCredentials, client?: TraeClientModelCatalog['client']): string {
    return createHash('sha256').update([value.userId, value.token, client ?? ''].join('\0')).digest('hex');
  }
  async models(value: TraeClientCredentials, signal?: AbortSignal, clientSource?: TraeClientModelCatalog['client']): Promise<TraeModelsResult> {
    credentials(value); const life = lifetime(signal, Math.min(this.timeout, 30000));
    const key = this.key(value, clientSource), revision = ++this.directoryRevision;
    try {
      const query = new URLSearchParams({ function: FUNCTION, need_prompt: 'false', poly_prompt: 'true' });
      const response = await this.send(GATEWAY + '/api/ide/v1/get_detail_param?' + query, value, undefined, life, 'application/json', {}, 'GET');
      const raw = await readJson(response, life.signal), list = raw.config_info_list ?? object(raw.data)?.config_info_list;
      if (!Array.isArray(list) || list.length > 1000) throw fail('response');
      const routes = new Map<string, Route>(), access = new Map<string, Access | undefined>(), hidden = new Set<string>();
      for (const item of list) {
        const row = object(item);
        if (!row || row.usage !== undefined && row.usage !== '' && row.usage !== 'chat_completion' || row.custom_models) continue;
        if (row.raw_chat_function !== undefined && row.raw_chat_function !== FUNCTION) continue;
        if ((row.config_source ?? 1) !== 1 || row.status === false || row.selectable === false || row.provider_offline_status === 'hard') continue;
        const id = name(row.config_name ?? row.name), details = Array.isArray(row.model_detail_list) ? row.model_detail_list.map(object).filter((item): item is ObjectValue => !!item && !!name(item.model_name)) : [];
        const detail = details.find(item => String(item.model_name).endsWith('__dev')) ?? details[0], providerId = name(detail?.model_name ?? row.model_name);
        if (!id || !providerId) continue;
        if (routes.has(id)) throw fail('response');
        const display = text(row.display_name ?? object(row.display_config)?.display_name, 512);
        const reasoning = reasoningConfig(row);
        routes.set(id, { model: { id, object: 'model', owned_by: 'trae', vision: traeModelVision(row), ...(display ? { name: display } : {}),
          ...(reasoning ? { reasoning_efforts: reasoning.options.map(level => reasoning.pickerLabels?.get(level) ?? level),
            ...(reasoning.defaultLevel ? { default_reasoning_effort: reasoning.pickerLabels?.get(reasoning.defaultLevel) ?? reasoning.defaultLevel } : {}) } : {}) }, providerId, configSource: 1, ...(reasoning ? { reasoning } : {}) });
        access.set(id, directoryAccess(row.display_contact_config));
        if (row.is_invisible_to_user === true) hidden.add(id);
      }
      const client = await this.clientModels(value.userId, clientSource).catch(() => undefined);
      const excluded = new Set(client?.excludedConfigIds);
      for (const id of excluded) { routes.delete(id); access.delete(id); }
      const picker = (client?.models ?? []).filter(model => !excluded.has(model.id) && !excluded.has(model.configName ?? model.id));
      let identity: number | undefined;
      if ([...access.values(), ...picker].some(rule => rule?.allowedIdentities?.length)) {
        const pay = lifetime(life.signal, 6500);
        try {
          const status = await this.send(ACCOUNT + '/trae/api/v2/pay/ide_user_pay_status', value, { trae_client: clientSource === 'trae-solo-cn' ? 'Lite' : 'IDE' }, pay);
          const { user_pay_identity } = await readJson(status, pay.signal);
          if (typeof user_pay_identity === 'number' && Number.isSafeInteger(user_pay_identity)) identity = user_pay_identity;
        } catch { /* Unrestricted models do not depend on the pay-status service. */ }
        finally { pay.close(); }
      }
      if (life.signal.aborted) throw fail('cancelled');

      const blocked = new Map<string, BlockedReason>();
      function checkAccess(id: string, rule: Access | undefined) {
        if (rule && canUseTraeClientModel({ id, ...rule }, identity)) return;
        const reason = rule && (rule.locked || identity !== undefined) ? 'account-access' : 'access-unknown';
        if (blocked.get(id) !== 'account-access') blocked.set(id, reason);
      }
      for (const [id, rule] of access) checkAccess(id, rule);
      for (const model of picker) checkAccess(model.configName ?? model.id, model);

      const current = new Set<string>(), data: TraeApiModel[] = [], callable = new Map(routes);
      let missing = 0, denied = 0, unknown = 0;
      function entry(id: string, route: Route | undefined, visibility?: 'current' | 'historical', displayName?: string): TraeApiModel {
        const reason = blocked.get(id);
        return { ...(route?.model ?? { object: 'model' as const, owned_by: 'trae' as const }), id, vision: route?.model.vision === true,
          ...(displayName ? { name: displayName } : {}), ...(visibility ? { modeldock_catalog_visibility: visibility } : {}),
          ...(!route || reason ? { modeldock_catalog_importable: false as const } : {}),
          ...(reason ? { modeldock_catalog_blocked_reason: reason } : {}) };
      }
      for (const model of picker) {
        const config = model.configName ?? model.id, native = routes.get(config), reason = blocked.get(config);
        const route = native && { ...native, model: { ...native.model, vision: native.model.vision === false ? false : model.vision ?? native.model.vision } };
        current.add(config);
        if (config !== model.id) {
          if (routes.has(model.id)) throw fail('response');
          if (reason) blocked.set(model.id, reason);
        }
        if (route) callable.set(model.id, route);
        if (reason === 'account-access') denied++;
        else if (reason === 'access-unknown') unknown++;
        else if (!route) missing++;
        data.push(entry(model.id, route, 'current', model.name));
      }
      for (const [id, route] of routes) {
        if (!current.has(id)) data.push(entry(id, route, client || hidden.has(id) ? 'historical' : undefined));
      }
      // A slower refresh must not replace newer account permissions.
      if (revision > (this.directories.get(key)?.revision ?? 0)) {
        this.directories.set(key, { revision, at: this.now(), routes: callable, blocked });
        if (this.directories.size > 32) this.directories.delete(this.directories.keys().next().value!);
      }
      const message = client
        ? `本机同账号 ${client.client === 'trae-solo-cn' ? 'TRAE SOLO CN' : 'TRAE CN'} 的 Chat 清单共 ${picker.length} 项，可添加 ${picker.length - missing - denied - unknown} 项。`
          + (denied ? `其中 ${denied} 项受账号权限限制。` : '') + (unknown ? `${unknown} 项的账号权限待确认。` : '')
          + (missing ? `其中 ${missing} 项尚无已核实的官方直连配置。` : '')
        : '尚未读取到本机同账号 TRAE 客户端的 Chat 模型清单，无法核实当前展示状态。请先在 TRAE 刷新模型；勾选后可查看已识别的直连目录。';
      return { object: 'list', data, modeldock_history: { source: 'trae-client', currentVerified: !!client, message } };
    } finally { life.close(); }
  }
  async quota(value: TraeClientCredentials, signal?: AbortSignal): Promise<{ usage: SubscriptionUsage; plan?: string }> {
    credentials(value); const life = lifetime(signal, Math.min(this.timeout, 65000));
    try {
      const profile = await readJson(await this.send(ACCOUNT + '/cloudide/api/v3/trae/GetUserInfo', value, { ReqSource: 'IDE' }, life), life.signal);
      const result = object(profile.Result); if (!result || String(result.UserID) !== value.userId) throw fail('authorization');
      const raw = await readJson(await this.send(ACCOUNT + '/trae/api/v2/pay/ide_user_ent_usage', value, { require_usage: true, req_source: 1 }, life), life.signal);
      const queriedAt = this.now(), quota = parseTraeQuota(raw, queriedAt), plan = parseTraePlan(raw, queriedAt);
      return { ...(plan ? { plan } : {}), usage: { status: quota.windows.length ? 'ready' : 'unavailable', ...quota, queriedAt: new Date(queriedAt).toISOString(),
        message: quota.windows.length ? '当前 TRAE 账号的官方套餐与额度；省略的积分用量按官方客户端默认值计算。' : 'TRAE 未返回可识别的官方额度，余额保持未知。' } };
    } finally { life.close(); }
  }
  async chat(value: TraeClientCredentials, body: ObjectValue, signal?: AbortSignal, client?: TraeClientModelCatalog['client']): Promise<Response> {
    credentials(value); const model = name(body?.model); if (!model || body.stream !== undefined && typeof body.stream !== 'boolean') throw fail('request');
    const nativeMessages = messages(body.messages), nativeTools = tools(body.tools), allowed = new Set(nativeTools?.map(tool => String(object(tool.function)?.name)) ?? []);
    for (const field of ['response_format', 'audio', 'modalities', 'functions', 'function_call', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty']) if (body[field] !== undefined) throw fail('capability', undefined, field);
    if (body.n !== undefined && body.n !== 1) throw fail('capability');
    const requestedEffort = name(body.reasoning_effort);
    if (body.reasoning_effort !== undefined && !requestedEffort) throw fail('capability', undefined, 'reasoning_effort');
    if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(String(body.tool_choice))) {
      const choice = object(body.tool_choice), fn = object(choice?.function); if (choice?.type !== 'function' || !allowed.has(String(fn?.name))) throw fail('capability');
    }
    if (body.tool_choice === 'required' && !allowed.size) throw fail('request');
    if (body.tool_choice === 'none') allowed.clear();
    const forcedTool = object(object(body.tool_choice)?.function)?.name;
    if (typeof forcedTool === 'string') { allowed.clear(); allowed.add(forcedTool); }
    if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw fail('request');
    const key = this.key(value, client);
    let directory = this.directories.get(key);
    if (!directory || this.now() - directory.at > 300000) { await this.models(value, signal, client); directory = this.directories.get(key); }
    const reason = directory?.blocked.get(model); if (reason) throw fail(reason, reason === 'account-access' ? 403 : 503);
    const route = directory?.routes.get(model); if (!route) throw fail('model');
    if (!route.model.vision && nativeMessages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url'))) throw fail('image-model', 400);
    const effort = requestedEffort === undefined ? undefined : nativeReasoningEffort(route.reasoning, requestedEffort);
    const sid = randomUUID(), payload: ObjectValue = { config_name: route.model.id, model_name: route.providerId, config_source: route.configSource,
      conversation_id: sid, session_id: sid, stream: true, raw_chat_function: FUNCTION, messages: nativeMessages,
      ...(effort !== undefined ? { [route.reasoning?.field ?? 'reasoning_effort']: effort } : {}),
      ...(nativeTools?.length ? { tools: nativeTools, ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}), ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}) } : {}) };
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_JSON) throw fail('limit');
    const life = lifetime(signal, this.timeout);
    try {
      const upstream = await this.send(GATEWAY + '/api/ide/v2/llm_raw_chat', value, payload, life, 'text/event-stream');
      if (!upstream.body || !/^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type') ?? '')) { await upstream.body?.cancel().catch(() => {}); throw fail('response'); }
      const iterator = translate(upstream.body, model, allowed, this.now(), life.signal, body.tool_choice === 'required' || typeof forcedTool === 'string', body.parallel_tool_calls !== false);
      if (body.stream === true) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            try { const next = await iterator.next(); if (next.done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); life.close(); } else controller.enqueue(encoder.encode('data: ' + JSON.stringify(next.value) + '\n\n')); }
            catch (error) { controller.error(error instanceof TraeApiError ? error : fail(life.signal.aborted ? 'cancelled' : 'response')); life.abort(); life.close(); }
          },
          async cancel() {
            life.abort();
            // Cancelling before translate enters frames() must also close the
            // unread transport body; its reader/finally does not exist yet.
            if (!upstream.body!.locked) await upstream.body!.cancel().catch(() => {});
            await iterator.return(undefined).catch(() => {}); life.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
      }
      let result: ObjectValue | undefined, resultUsage: unknown; const message: ObjectValue = { role: 'assistant', content: '' }, toolCalls = new Map<number, ObjectValue>(); let finish = 'stop';
      for await (const chunk of iterator) {
        result ??= chunk; const choice = object((chunk.choices as unknown[])?.[0])!, delta = object(choice.delta)!;
        if (typeof delta.content === 'string') message.content = String(message.content) + delta.content;
        if (typeof delta.reasoning_content === 'string') message.reasoning_content = String(message.reasoning_content ?? '') + delta.reasoning_content;
        for (const raw of delta.tool_calls as ObjectValue[] ?? []) {
          const index = Number(raw.index), fn = object(raw.function)!, old = toolCalls.get(index) ?? { id: raw.id, type: 'function', function: { name: '', arguments: '' } };
          const current = object(old.function)!; current.name = String(current.name) + String(fn.name ?? ''); current.arguments = String(current.arguments) + String(fn.arguments ?? ''); toolCalls.set(index, old);
        }
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        if (chunk.usage) resultUsage = chunk.usage;
      }
      if (toolCalls.size) message.tool_calls = [...toolCalls.values()];
      return Response.json({ id: result?.id, object: 'chat.completion', created: result?.created, model, choices: [{ index: 0, message, finish_reason: finish }], ...(resultUsage ? { usage: resultUsage } : {}) });
    } catch (error) { const failure = error instanceof TraeApiError ? error : fail(life.signal.aborted ? 'cancelled' : 'response'); life.abort(); life.close(); throw failure; }
    finally { if (body.stream !== true) life.close(); }
  }
}
