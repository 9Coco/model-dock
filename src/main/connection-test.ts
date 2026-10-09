import type { Model, Provider, WireApi } from '../shared/types';
import type { ConnectionOutcome, ConnectionResult, ConnectionTestInput } from '../shared/connection-types';
import { firstConnectionModel } from '../shared/connection-types';
import { presetById } from '../shared/presets';
import { upstreamEndpoint, type PreparedUpstream } from './oauth';
import { isCopilotUpstream } from './copilot-provider';
import { anthropicEndpoint } from './anthropic-endpoint';
import type { DiagnosticContext, DiagnosticEvent, DiagnosticLevel } from '../shared/diagnostic-types';

export interface ConnectionStore {
  getProvider(id: string): Provider | undefined;
  listModels(): Model[];
}
export interface ConnectionOAuth {
  prepareRequest(provider: Provider, path: string, body: Record<string, unknown>): Promise<PreparedUpstream>;
}

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const permittedHeaders = new Set(['content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version', 'user-agent', 'originator', 'chatgpt-account-id', 'x-xai-token-auth', 'x-grok-client-version', 'x-grok-client-identifier', 'x-authenticateresponse', 'x-grok-conv-id', 'copilot-integration-id', 'editor-version', 'editor-plugin-version', 'x-github-api-version', 'x-initiator', 'x-request-id']);
type Json = Record<string, unknown>;
type InferenceEvidence = 'completed' | 'processed' | 'limited';

class ConnectionFailure extends Error {
  constructor(readonly outcome: ConnectionOutcome, message: string, readonly statusCode?: number) { super(message); }
}
function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function modelName(value: unknown): string {
  return typeof value === 'string' && value.trim().length <= 200 && !/[\x00-\x1f\x7f\u200b-\u200d\ufeff]/.test(value) ? value.trim() : '';
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ConnectionFailure('timeout', '推理测试超时（30 秒），请稍后重试或检查网络。');
}
function expectedEndpoint(provider: Provider, route: string): string {
  if (route === '/v1/messages') return anthropicEndpoint(provider.baseUrl, '/messages');
  return upstreamEndpoint(provider.baseUrl || (provider.kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : provider.kind === 'grok' ? 'https://cli-chat-proxy.grok.com/v1' : ''), route);
}
function httpFailure(status: number): ConnectionFailure {
  if (status === 401) return new ConnectionFailure('authentication', '推理接口返回 HTTP 401：凭据被拒绝，请检查 API Key 或重新授权。', status);
  if (status === 402) return new ConnectionFailure('permission', '推理接口返回 HTTP 402：余额不足或套餐支付状态受限。', status);
  if (status === 403) return new ConnectionFailure('permission', '推理接口返回 HTTP 403：当前账号或套餐没有调用此模型的权限。', status);
  if (status === 404 || status === 405) return new ConnectionFailure('model', `推理接口返回 HTTP ${status}：请检查模型 ID、调用协议和套餐专属 API 地址。`, status);
  if (status === 400 || status === 422) return new ConnectionFailure('model', `推理接口返回 HTTP ${status}：模型 ID、协议或测试参数不被上游接受，请检查模型配置。`, status);
  if (status === 429) return new ConnectionFailure('rate-limit', '推理接口返回 HTTP 429：请求频率或套餐额度受限，请稍后重试。', status);
  if (status === 426) return new ConnectionFailure('upstream', '推理接口返回 HTTP 426：上游要求更新客户端兼容版本。', status);
  if (status >= 300 && status < 400) return new ConnectionFailure('configuration', `推理接口返回 HTTP ${status} 重定向，已拒绝向重定向地址发送凭据。`, status);
  return new ConnectionFailure('upstream', `推理接口请求失败（HTTP ${status}），请稍后重试。`, status);
}
function rejectError(payload: Json): void {
  if (payload.error != null || payload.status === 'failed' || payload.type === 'error' || payload.type === 'response.failed' || payload.type === 'response.error') {
    throw new ConnectionFailure('upstream', '上游返回了推理失败结果，未通过测试。请检查模型、协议或套餐状态。');
  }
}
function assistantText(message: unknown): boolean {
  const item = record(message);
  if (item.role !== 'assistant') return false;
  if (typeof item.content === 'string') return item.content.trim().length > 0;
  return Array.isArray(item.content) && item.content.some(part => {
    const content = record(part);
    return ['text', 'output_text'].includes(String(content.type)) && typeof content.text === 'string' && content.text.trim().length > 0;
  });
}
function positiveCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function reasoningText(message: unknown): boolean {
  const item = record(message);
  return typeof item.reasoning_content === 'string' && item.reasoning_content.trim().length > 0;
}
function responsesText(payload: Json): boolean {
  return Array.isArray(payload.output) && payload.output.some(assistantText);
}
function responsesReasoning(payload: Json): boolean {
  return Array.isArray(payload.output) && payload.output.some(value => {
    const item = record(value);
    const content = Array.isArray(item.content) && item.content.some(part => {
      const data = record(part);
      return data.type === 'reasoning_text' && typeof data.text === 'string' && data.text.trim().length > 0;
    });
    // 修改点：Ark 的思维链可位于 reasoning.content 或 assistant message.content，不能只识别摘要。
    if (item.type === 'message' && item.role === 'assistant') return content;
    return item.type === 'reasoning' && (content || typeof item.encrypted_content === 'string' && item.encrypted_content.trim().length > 0 || Array.isArray(item.summary) && item.summary.some(part => {
      const data = record(part);
      return data.type === 'summary_text' && typeof data.text === 'string' && data.text.trim().length > 0;
    }));
  });
}
function messagesEnvelope(payload: Json): boolean {
  return payload.type === 'message' && payload.role === 'assistant' && typeof payload.id === 'string' && !!payload.id.trim() && Array.isArray(payload.content);
}
function messagesText(payload: Json): boolean {
  return Array.isArray(payload.content) && payload.content.some(part => {
    const block = record(part);
    return block.type === 'text' && typeof block.text === 'string' && !!block.text.trim();
  });
}
function messagesReasoning(payload: Json): boolean {
  return Array.isArray(payload.content) && payload.content.some(part => {
    const block = record(part);
    return block.type === 'thinking' && typeof block.thinking === 'string' && !!block.thinking.trim()
      || block.type === 'redacted_thinking' && typeof block.data === 'string' && !!block.data.trim();
  });
}
function messagesEvidence(stopReason: unknown, content: boolean, reasoning: boolean, countedOutput: boolean): InferenceEvidence {
  if (stopReason === 'refusal') throw new ConnectionFailure('upstream', '上游推理被拒绝，未通过测试。');
  if (stopReason === 'max_tokens' && (content || reasoning || countedOutput)) return 'limited';
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    if (content) return 'completed';
    if (reasoning || countedOutput) return 'processed';
  }
  throw new ConnectionFailure('invalid-response', '上游没有返回正常完成的 Messages 推理结果，未通过测试。');
}
/** 修改点：仅提取响应形状与计数，不保存正文、模型名称或上游任意字符串。 */
function responseMetadata(payload: unknown, wireApi: WireApi): DiagnosticContext {
  const data = record(payload), usage = record(data.usage), details = record(data.incomplete_details);
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const choices = Array.isArray(data.choices) ? data.choices.map(record) : [];
  const responseStatus = data.status === 'completed' || data.status === 'incomplete' || data.status === 'failed' || data.status === 'in_progress' ? data.status : 'unknown';
  const incompleteReason = details.reason === 'max_output_tokens' || details.reason === 'content_filter' ? details.reason
    : details.reason == null || typeof details.reason === 'string' && !details.reason.trim() ? 'missing' : 'unknown';
  if (wireApi === 'messages') return {
    responseStatus: data.stop_reason === 'max_tokens' ? 'incomplete' : ['end_turn', 'stop_sequence'].includes(String(data.stop_reason)) ? 'completed' : 'unknown',
    incompleteReason: data.stop_reason === 'max_tokens' ? 'max_output_tokens' : 'missing',
    outputItems: Array.isArray(data.content) ? data.content.length : 0,
    outputTokens: count(usage.output_tokens), reasoningTokens: count(record(usage.output_tokens_details).thinking_tokens),
    hasOutputText: messagesText(data), hasReasoning: messagesReasoning(data),
  };
  return { responseStatus, incompleteReason,
    outputItems: wireApi === 'responses' ? Array.isArray(data.output) ? data.output.length : 0 : choices.length,
    outputTokens: count(wireApi === 'responses' ? usage.output_tokens : usage.completion_tokens),
    reasoningTokens: count(record(wireApi === 'responses' ? usage.output_tokens_details : usage.completion_tokens_details).reasoning_tokens),
    hasOutputText: wireApi === 'responses' ? responsesText(data) : choices.some(choice => assistantText(choice.message)),
    hasReasoning: wireApi === 'responses' ? responsesReasoning(data) : choices.some(choice => reasoningText(choice.message)),
  };
}
function responseEnvelope(payload: Json): boolean {
  return payload.object === 'response' && typeof payload.id === 'string' && payload.id.trim().length > 0 && Array.isArray(payload.output);
}
function rejectResponseErrors(payload: Json): void {
  rejectError(payload);
  const details = record(payload.incomplete_details);
  if (details.reason === 'content_filter' || details.content_filter != null) throw new ConnectionFailure('upstream', '上游推理被内容过滤，未通过测试。');
  for (const item of Array.isArray(payload.output) ? payload.output : []) rejectError(record(item));
}
function limitedInference(payload: Json, outputBudget?: number, streamedOutput = false): boolean {
  if (payload.status !== 'incomplete' || !responseEnvelope(payload)) return false;
  const details = record(payload.incomplete_details), reason = details.reason;
  if (details.content_filter != null) return false;
  const used = record(payload.usage).output_tokens;
  if (reason === 'max_output_tokens') return streamedOutput || responsesText(payload) || responsesReasoning(payload) || positiveCount(used);
  // 修改点：仅在上游遗漏原因且实际输出用量达到本次请求预算时识别短测试截断；未知明确原因仍失败。
  const missingReason = reason == null || typeof reason === 'string' && !reason.trim();
  return missingReason && positiveCount(outputBudget) && positiveCount(used) && used >= outputBudget;
}
function completedResponse(payload: Json): boolean {
  return payload.status === 'completed' && responseEnvelope(payload);
}
function validateJson(payload: unknown, wireApi: WireApi, outputBudget?: number): InferenceEvidence {
  const data = record(payload);
  rejectError(data);
  if (wireApi === 'chat-completions') {
    const choices = Array.isArray(data.choices) ? data.choices.map(record) : [];
    if (choices.some(choice => assistantText(choice.message))) return choices.some(choice => choice.finish_reason === 'length') ? 'limited' : 'completed';
    if (choices.some(choice => choice.finish_reason === 'length' && record(choice.message).role === 'assistant' && (reasoningText(choice.message) || positiveCount(record(data.usage).completion_tokens)))) return 'limited';
  } else if (wireApi === 'messages') {
    if (record(data.stop_details).type === 'refusal') throw new ConnectionFailure('upstream', '上游推理被拒绝，未通过测试。');
    if (messagesEnvelope(data)) return messagesEvidence(data.stop_reason, messagesText(data), messagesReasoning(data), positiveCount(record(data.usage).output_tokens));
  } else {
    rejectResponseErrors(data);
    if (data.status === 'incomplete') {
      if (limitedInference(data, outputBudget)) return 'limited';
    } else if (completedResponse(data)) {
      if (responsesText(data)) return 'completed';
      if (responsesReasoning(data) || positiveCount(record(data.usage).output_tokens)) return 'processed';
    }
  }
  throw new ConnectionFailure('invalid-response', '上游没有返回有效的模型推理结果；仅 HTTP 成功不代表模型可用。');
}
function validateSse(raw: string, wireApi: WireApi, outputBudget?: number): InferenceEvidence {
  let content = false, reasoning = false, countedOutput = false, finished = false, limited = false, processed = false;
  let messageStarted = false, messageStopReason: unknown;
  const messageBlocks = new Map<number, unknown>();
  for (const block of raw.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    if (event === 'error' || event === 'response.failed' || event === 'response.error') throw new ConnectionFailure('upstream', '上游流式推理返回了失败事件，未通过测试。');
    const values = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
    if (!values.length) continue;
    const value = values.join('\n').trim();
    if (value === '[DONE]') { if (wireApi === 'chat-completions') finished = true; continue; }
    let data: Json;
    try { data = record(JSON.parse(value)); } catch { throw new ConnectionFailure('invalid-response', '上游流式响应包含无效 JSON，未通过测试。'); }
    rejectError(data);
    if (wireApi === 'chat-completions') {
      countedOutput ||= positiveCount(record(data.usage).completion_tokens);
      for (const choice of (Array.isArray(data.choices) ? data.choices : []).map(record)) {
        const delta = record(choice.delta);
        if (delta.role === undefined || delta.role === 'assistant') {
          if (typeof delta.content === 'string' && delta.content.trim()) content = true;
          reasoning ||= reasoningText(delta);
        }
        if (choice.finish_reason != null) { finished = true; limited ||= choice.finish_reason === 'length'; }
      }
    } else if (wireApi === 'messages') {
      const type = data.type || event;
      if (event && event !== type) throw new ConnectionFailure('invalid-response', 'Messages 流式事件与响应类型不一致。');
      if (type === 'message_start') {
        const message = record(data.message);
        if (messageStarted || !messagesEnvelope(message)) throw new ConnectionFailure('invalid-response', 'Messages 流式开始事件无效。');
        messageStarted = true;
        content ||= messagesText(message); reasoning ||= messagesReasoning(message);
        countedOutput ||= positiveCount(record(message.usage).output_tokens);
      } else if (type === 'content_block_start' || type === 'content_block_delta' || type === 'content_block_stop') {
        if (!messageStarted || finished || messageStopReason !== undefined || !Number.isSafeInteger(data.index) || Number(data.index) < 0) throw new ConnectionFailure('invalid-response', 'Messages 流式内容事件顺序无效。');
        const index = Number(data.index);
        if (type === 'content_block_start') {
          if (messageBlocks.has(index)) throw new ConnectionFailure('invalid-response', 'Messages 流式内容块重复。');
          const block = record(data.content_block);
          messageBlocks.set(index, block.type);
          content ||= messagesText({ content: [block] }); reasoning ||= messagesReasoning({ content: [block] });
        } else {
          if (!messageBlocks.has(index)) throw new ConnectionFailure('invalid-response', 'Messages 流式内容缺少开始事件。');
          if (type === 'content_block_stop') messageBlocks.delete(index);
          else {
            const delta = record(data.delta), blockType = messageBlocks.get(index);
            if (delta.type === 'text_delta' && blockType === 'text' && typeof delta.text === 'string' && delta.text.trim()) content = true;
            if (delta.type === 'thinking_delta' && blockType === 'thinking' && typeof delta.thinking === 'string' && delta.thinking.trim()) reasoning = true;
          }
        }
      } else if (type === 'message_delta') {
        if (!messageStarted || finished || messageBlocks.size) throw new ConnectionFailure('invalid-response', 'Messages 流式完成事件顺序无效。');
        const delta = record(data.delta);
        if (record(delta.stop_details).type === 'refusal') throw new ConnectionFailure('upstream', '上游推理被拒绝，未通过测试。');
        if (delta.stop_reason != null) messageStopReason = delta.stop_reason;
        countedOutput ||= positiveCount(record(data.usage).output_tokens);
      } else if (type === 'message_stop') {
        if (!messageStarted || finished || messageBlocks.size || messageStopReason === undefined) throw new ConnectionFailure('invalid-response', 'Messages 流式推理缺少正常完成信息。');
        const evidence = messagesEvidence(messageStopReason, content, reasoning, countedOutput);
        finished = true; limited = evidence === 'limited'; processed = evidence === 'processed';
      }
    } else {
      const embedded = record(data.response);
      rejectResponseErrors(embedded);
      const type = data.type || event;
      if (type === 'response.output_text.delta' && typeof data.delta === 'string' && data.delta.trim()) content = true;
      if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(String(type)) && typeof data.delta === 'string' && data.delta.trim()) reasoning = true;
      if (type === 'response.completed') {
        if (limitedInference(embedded, outputBudget, content || reasoning)) limited = true;
        else {
          if (!completedResponse(embedded) || !(content || reasoning || responsesText(embedded) || responsesReasoning(embedded) || positiveCount(record(embedded.usage).output_tokens))) throw new ConnectionFailure('invalid-response', '上游完成事件缺少有效的推理结果。');
          processed = !(content || responsesText(embedded));
        }
        finished = true;
      }
      if (type === 'response.incomplete') {
        if (!limitedInference(embedded, outputBudget, content || reasoning)) {
          throw new ConnectionFailure('invalid-response', '上游推理未完成且没有有效输出，未通过测试。');
        }
        finished = true; limited = true;
      }
    }
  }
  if (finished && (wireApi === 'responses' || wireApi === 'messages' || content || limited && (reasoning || countedOutput))) return limited ? 'limited' : processed ? 'processed' : 'completed';
  throw new ConnectionFailure('invalid-response', '上游流式推理没有正常完成，未通过测试。');
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { void response.body?.cancel().catch(() => undefined); throw new ConnectionFailure('invalid-response', '推理测试响应过大，已停止读取。'); }
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectionFailure('invalid-response', '推理接口响应为空。');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      assertActive(signal);
      const part = await reader.read();
      assertActive(signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => undefined); throw new ConnectionFailure('invalid-response', '推理测试响应过大，已停止读取。'); }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** A single small inference request; model discovery is a separate operation. */
export class ConnectionTester {
  private readonly fetcher: typeof fetch;
  constructor(private readonly store: ConnectionStore, private readonly oauth: ConnectionOAuth, private readonly options: { fetch?: typeof fetch; diagnostics?: (level: DiagnosticLevel, event: DiagnosticEvent, context?: DiagnosticContext) => void } = {}) { this.fetcher = options.fetch ?? fetch; }
  private diagnostic(context: DiagnosticContext): void {
    try { this.options.diagnostics?.('info', 'connection.response', context); } catch { /* Diagnostics cannot change the inference result. */ }
  }

  async test(providerId: string, input: ConnectionTestInput = {}): Promise<ConnectionResult> {
    const start = Date.now();
    let testedModel: string | undefined, wireApi: WireApi | undefined, statusCode: number | undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = this.store.getProvider(providerId);
      if (!provider) throw new ConnectionFailure('configuration', '供应商不存在，请重新选择。');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionFailure('configuration', '测试模型参数无效。');
      if (!provider.hasSecret) throw new ConnectionFailure('configuration', provider.kind === 'openai-compatible' ? '请先保存 API Key，再测试连接。' : '请先完成订阅授权，再测试连接。');
      if (input.modelId !== undefined || input.upstreamId === undefined) {
        const model = input.modelId !== undefined ? typeof input.modelId === 'string' ? this.store.listModels().find(item => item.id === input.modelId) : undefined : firstConnectionModel(providerId, this.store.listModels());
        if (!model && input.modelId === undefined) throw new ConnectionFailure('model-required', '此供应商还没有模型，请先获取模型列表或手动添加模型，再测试连接。');
        if (!model || model.providerId !== providerId) throw new ConnectionFailure('model', '所选模型不存在或不属于当前供应商，请重新选择。');
        testedModel = modelName(model.upstreamId);
        wireApi = model.wireApi;
      } else {
        testedModel = modelName(input.upstreamId);
        wireApi = input.wireApi ?? presetById(provider.presetId)?.defaultWireApi ?? 'chat-completions';
      }
      if (!testedModel) throw new ConnectionFailure('model-required', '请选择已添加的模型，或填写套餐支持的模型 ID，再发起推理测试。');
      if (provider.kind === 'codex' || provider.kind === 'grok') wireApi = 'responses';
      if (!['chat-completions', 'responses', 'messages'].includes(wireApi!)) throw new ConnectionFailure('configuration', '请选择 Chat Completions、Responses 或 Messages 调用协议。');
      if (wireApi === 'messages' && provider.kind !== 'openai-compatible') throw new ConnectionFailure('configuration', 'Messages 仅支持 API Key 来源。');
      const route = wireApi === 'responses' ? '/responses' : wireApi === 'messages' ? '/v1/messages' : '/chat/completions';
      let expected: string | undefined;
      try { if (provider.kind !== 'copilot') expected = expectedEndpoint(provider, route); }
      catch { throw new ConnectionFailure('configuration', 'API 地址无效，请填写 HTTPS 地址或本机 HTTP 回环地址；地址不能包含凭据、查询或片段。'); }
      // 修改点：Copilot 的实际地址来自官方账户授权，仍限定官方域名及所选模型的推理路由。
      const matchesEndpoint = (url: string) => provider.kind === 'copilot' ? isCopilotUpstream(url, route) : url === expected;
      const body: Record<string, unknown> = wireApi === 'responses'
        ? { model: testedModel, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }], stream: false, store: false, max_output_tokens: 64 }
        : { model: testedModel, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, max_tokens: 16 };
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ConnectionFailure('timeout', '推理测试超时（30 秒），请稍后重试或检查网络。')); }, TIMEOUT_MS); });
      const request = async () => {
        let prepared: PreparedUpstream;
        try { prepared = await this.oauth.prepareRequest(provider, route, body); }
        catch {
          assertActive(controller.signal);
          throw new ConnectionFailure('authentication', provider.kind === 'openai-compatible' ? '无法准备 API 凭据，请重新保存 API Key。' : '无法准备或续期订阅授权，请在授权中心检查账号或重新登录。');
        }
        assertActive(controller.signal);
        if (!matchesEndpoint(prepared.url)) throw new ConnectionFailure('configuration', '推理请求地址与当前供应商不一致，已停止发送凭据。');
        if (prepared.body.model !== testedModel) throw new ConnectionFailure('configuration', '推理请求模型与所选模型不一致，已停止测试。');
        if (!Object.entries(prepared.headers).every(([name, value]) => permittedHeaders.has(name.toLowerCase()) && typeof value === 'string' && !/[\r\n]/.test(value))) {
          throw new ConnectionFailure('configuration', '推理请求认证头无效，已停止发送请求。');
        }
        const headers = new Headers(prepared.headers);
        const bearer = /^Bearer \S+$/.test(headers.get('authorization') || '');
        const apiKey = /^\S+$/.test(headers.get('x-api-key') || '');
        const messagesAuth = provider.messagesAuth === 'api-key' ? apiKey && !headers.has('authorization') : bearer && !headers.has('x-api-key');
        const validAuth = wireApi === 'messages' ? messagesAuth && headers.get('anthropic-version') === '2023-06-01' : bearer;
        if (!validAuth) {
          throw new ConnectionFailure('configuration', '推理请求认证头无效，已停止发送请求。');
        }
        const response = await this.fetcher(prepared.url, { method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body), signal: controller.signal, redirect: 'manual' });
        statusCode = response.status;
        assertActive(controller.signal);
        if (response.redirected || response.url && !matchesEndpoint(response.url)) { void response.body?.cancel().catch(() => undefined); throw new ConnectionFailure('configuration', '推理接口离开了当前供应商地址，已停止测试。'); }
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw httpFailure(response.status); }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json') && contentType !== 'text/event-stream') { void response.body?.cancel().catch(() => undefined); throw new ConnectionFailure('invalid-response', '推理接口未返回 JSON 或事件流，请检查 API 地址与协议。'); }
        const raw = await boundedBody(response, controller.signal);
        const outputBudget = positiveCount(prepared.body.max_output_tokens) ? prepared.body.max_output_tokens : undefined;
        if (contentType === 'text/event-stream') {
          this.diagnostic({ stage: 'inference', providerId, wireApi, statusCode, contentType: 'sse', responseBytes: Buffer.byteLength(raw) });
          return validateSse(raw, wireApi!, outputBudget);
        }
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { throw new ConnectionFailure('invalid-response', '推理接口返回了无效 JSON，请检查 API 地址与协议。'); }
        this.diagnostic({ stage: 'inference', providerId, wireApi, statusCode, contentType: 'json', responseBytes: Buffer.byteLength(raw), ...responseMetadata(payload, wireApi!) });
        return validateJson(payload, wireApi!, outputBudget);
      };
      const evidence = await Promise.race([request(), timeout]);
      const message = evidence === 'limited' ? '模型已处理推理请求，连接通顺；本次短测试达到输出上限。' : evidence === 'processed' ? '模型已处理推理请求，连接通顺；本次测试未返回最终回答。' : '模型推理已成功完成，连接通顺。';
      return { ok: true, outcome: 'success', message, testedModel, wireApi, statusCode, durationMs: Date.now() - start };
    } catch (error) {
      const failure = error instanceof ConnectionFailure ? error : controller.signal.aborted ? new ConnectionFailure('timeout', '推理测试超时（30 秒），请稍后重试或检查网络。') : new ConnectionFailure('network', '无法连接推理接口，请检查网络与 API 地址后重试。');
      return { ok: false, outcome: failure.outcome, message: failure.message, statusCode: failure.statusCode ?? statusCode, durationMs: Date.now() - start, ...(testedModel ? { testedModel } : {}), ...(wireApi ? { wireApi } : {}) };
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
}
