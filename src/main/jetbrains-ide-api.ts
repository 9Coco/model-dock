import { createHash } from 'node:crypto';
import { version } from '../../package.json';
import type { QuotaWindow, SubscriptionUsage } from '../shared/auth-types';
import { JetBrainsGrazieBridgeError, JetBrainsGrazieSignatures, prepareJetBrainsGrazieChat, createJetBrainsGrazieChatStream, collectJetBrainsGrazieChat } from './jetbrains-grazie-bridge';
import { JetBrainsLicenseCatalogError, readJetBrainsIdeLicenseCatalog } from './jetbrains-license-catalog';
import { jetBrainsClientModelHistory, jetBrainsClientModelVisibility } from './jetbrains-client-models';
import { jetBrainsReasoning } from './jetbrains-reasoning';

/** Native personal-license API, independently of Central CLI. The wire contract
 * comes from the installed JetBrains AI Assistant 2026.2 public classes:
 * AuthAPIClient.getAccessV2/verifyV3, QuotaAPI.Get, LlmAPI.Profiles.V9 and
 * OpenAIProxyProvider/OpenAIAzureProxyProvider -> GrazieProxyProvider, and
 * ChatModels.Stream.V9 + LlmAPIClient.V9 for native Claude/Google Chat.
 * This is an internal upstream contract, not a public third-party API promise.
 * No source-client file, PasswordSafe, OAuth refresh token or diagnostics access.
 */
const ORIGIN = 'https://api.jetbrains.ai';
const JSON_LIMIT = 4 * 1024 * 1024;
const CHAT_LIMIT = 32 * 1024 * 1024;
const REQUEST_LIMIT = 2 * 1024 * 1024;
const DIRECTORY_TTL = 5 * 60_000;
const CALLER = JSON.stringify({ name: 'modeldock', version });
type JsonObject = Record<string, unknown>;
export type JetBrainsIdeApiErrorCode = 'credentials' | 'authorization' | 'entitlement' | 'region' | 'network' | 'response' | 'cancelled' | 'model' | 'request' | 'capability' | 'reasoning' | 'limit' | 'license-source';
const messages: Record<JetBrainsIdeApiErrorCode, string> = {
  credentials: 'JetBrains 账号授权或许可证信息无效，请在原生客户端重新登录后重试。',
  authorization: 'JetBrains 账号授权已失效，请在原生客户端重新登录后重试。',
  entitlement: 'JetBrains 未接受当前许可证，请检查账号的 AI 会员权限。',
  region: 'JetBrains AI 拒绝了当前网络来源（HTTP 451）。请检查 ModelDock 的应用网络代理，使用可正常访问 JetBrains AI 的网络后重试。',
  network: 'JetBrains AI 服务暂时无法连接，请稍后重试。',
  response: 'JetBrains AI 服务返回了无法识别的数据，未保存该结果。',
  cancelled: 'JetBrains AI 请求已取消或超时。',
  model: '此模型未在当前账号的兼容模型目录中，请刷新模型列表后重试。',
  request: '此 JetBrains 连接需要有效的 Chat Completions 请求。',
  capability: '此 JetBrains 模型暂不支持所请求的参数或工具历史。请关闭扩展思考、严格工具模式，或新建会话后重试。',
  reasoning: '此 JetBrains 模型当前不支持所选思考等级。请刷新供应商模型目录、补全思考档位并重新同步工具配置。',
  limit: 'JetBrains AI 请求或响应超出支持范围。',
  'license-source': '此 JetBrains 登录方式暂未支持账号许可证目录，请从已支持的 IDE 登录来源导入。原有账号保持不变。',
};
export class JetBrainsIdeApiError extends Error {
  readonly status: number;
  constructor(readonly code: JetBrainsIdeApiErrorCode, status?: number) {
    super(messages[code]); this.name = 'JetBrainsIdeApiError';
    this.status = status && Number.isInteger(status) && status >= 400 && status <= 599 ? status
      : code === 'region' ? 451 : ['credentials', 'authorization'].includes(code) ? 401 : code === 'entitlement' ? 403
        : ['request', 'model', 'capability', 'reasoning', 'license-source'].includes(code) ? 400 : code === 'cancelled' ? 504 : code === 'limit' ? 413 : 502;
  }
}
export interface JetBrainsIdeModel {
  id: string;
  object: 'model';
  owned_by: 'jetbrains';
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning_efforts?: string[];
  default_reasoning_effort?: string;
  thinking?: boolean;
  reasoning_effort_format?: 'chat-completions';
  modeldock_catalog_visibility: 'current' | 'historical';
}
export interface JetBrainsIdeModels { data: JetBrainsIdeModel[]; modeldock_history: typeof jetBrainsClientModelHistory }
export interface JetBrainsIdeApiOptions { fetch?: typeof globalThis.fetch; now?: () => number }
/** Main-process-only owned personal AI license, verified against its account. */
export interface JetBrainsIdeLicense { id: string; plan: string; expiresAt?: string; productCode?: string; kind?: string; verifiedAt?: string }
interface RouteModel { model: JetBrainsIdeModel; upstreamId: string; path: string; protocol: 'openai' | 'grazie'; requireToolSignatures: boolean }
interface Directory { fetchedAt: number; models: Map<string, RouteModel> }
interface LicenseDirectory { until: number; rows: JetBrainsIdeLicense[] }
interface LicenseRead { controller: AbortController; promise: Promise<JetBrainsIdeLicense[]>; waiters: number; settled: boolean }
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const safeText = (value: unknown, max = 256): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const identifier = (value: unknown): string | undefined => { const text = safeText(value); return text && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(text) ? text : undefined; };
const failure = (code: JetBrainsIdeApiErrorCode, status?: number) => new JetBrainsIdeApiError(code, status);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function jwt(value: unknown, now: number, expiry: 'enforce' | 'hint' = 'enforce'): { token: string; expiresAt?: number } {
  if (typeof value !== 'string' || value.length > 64 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw failure('credentials');
  try {
    const [headerPart, payloadPart] = value.split('.');
    const header = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(headerPart, 'base64url'))));
    const payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payloadPart, 'base64url'))));
    if (!header || !payload || typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') throw failure('credentials');
    const expiresAt = payload.exp === undefined ? undefined : typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > 0 ? payload.exp * 1000 : NaN;
    if (expiry === 'enforce' && expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) throw failure('authorization');
    return { token: value, ...(expiresAt !== undefined && Number.isSafeInteger(expiresAt) ? { expiresAt } : {}) };
  } catch (error) { throw error instanceof JetBrainsIdeApiError ? error : failure('credentials'); }
}

/** Timestamp.Serializer is a LONG in milliseconds. Quota amount serializers
 * accept a decimal primitive or {amount: decimal}; do not guess zero defaults. */
function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 8_640_000_000_000_000 ? value : undefined;
}
function amount(value: unknown): number | undefined {
  const numberValue = object(value)?.amount ?? value;
  if (typeof numberValue !== 'number' && (typeof numberValue !== 'string' || !/^\d+(?:\.\d+)?$/.test(numberValue) || numberValue.length > 80)) return;
  const parsed = Number(numberValue);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : undefined;
}
function quotaWindow(id: string, label: string, raw: JsonObject, resetAt?: string): QuotaWindow | undefined {
  const total = amount(raw.maximum), used = amount(raw.current), reportedAvailable = amount(raw.available);
  if (total === undefined && used === undefined && reportedAvailable === undefined) return;
  const remaining = reportedAvailable ?? (total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
  const result: QuotaWindow = { id, label, unit: 'AI Credits', measurement: 'reported', ...(resetAt ? { resetAt } : {}), ...(total !== undefined ? { total } : {}), ...(remaining !== undefined ? { remaining } : {}) };
  // Native current is spent credit (the IDE's mock quota-spent adds to current).
  // A conflicting available/current pair stays an amount-only observation.
  if (total !== undefined && total > 0 && remaining !== undefined && remaining <= total && (used === undefined || reportedAvailable === undefined || Math.abs(total - used - remaining) < 0.000001)) {
    result.remainingPercent = remaining / total * 100;
    result.usedPercent = 100 - result.remainingPercent;
  }
  return result;
}

/** Every operation uses one fixed official origin and rejects redirects.
 * Derived JWTs and directory keys stay main-only. Inference is never retried. */
export class JetBrainsIdeApi {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly directories = new Map<string, Directory>();
  private readonly signatures = new JetBrainsGrazieSignatures();
  private readonly licenseDirectories = new Map<string, LicenseDirectory>();
  private readonly licenseReads = new Map<string, LicenseRead>();
  constructor(options: JetBrainsIdeApiOptions = {}) { this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now; }

  async licenses(input: { idToken?: string; accessToken?: string; tokenType?: 'jba-id-token' | 'jcp-global-access-token'; accountId: string; sourceLicenseId?: string }, signal?: AbortSignal): Promise<JetBrainsIdeLicense[]> {
    if (signal?.aborted) throw failure('cancelled');
    if (!identifier(input.accountId) || !identifier(input.sourceLicenseId)) throw failure('credentials');
    if (input.tokenType !== undefined && input.tokenType !== 'jba-id-token' && input.tokenType !== 'jcp-global-access-token') throw failure('credentials');
    // The inference-audience JCP token does not establish the owner of an
    // arbitrary legacy userId. Its future SDK reader must provide a verified
    // current-user binding or the dedicated user-management audience. Never
    // send that token to a guessed endpoint or query another owner by label.
    if (input.tokenType === 'jcp-global-access-token') throw failure('license-source');
    if (!input.idToken || input.accessToken) throw failure('credentials');
    const assertion = jwt(input.idToken, this.now(), 'hint');
    const claims = object(JSON.parse(Buffer.from(assertion.token.split('.')[1], 'base64url').toString('utf8')));
    if (claims?.user_id !== input.accountId) throw failure('credentials');
    const key = digest(JSON.stringify([input.accountId, input.sourceLicenseId, input.tokenType, input.idToken ?? input.accessToken]));
    const cached = this.licenseDirectories.get(key);
    if (cached && cached.until > this.now()) return structuredClone(cached.rows);
    let pending = this.licenseReads.get(key);
    if (pending?.controller.signal.aborted) { this.licenseReads.delete(key); pending = undefined; }
    if (!pending) {
      const read: LicenseRead = { controller: new AbortController(), waiters: 0, settled: false, promise: Promise.resolve([]) };
      this.licenseReads.set(key, read);
      read.promise = (async () => {
        const operation = this.operation(read.controller.signal, 30_000);
        try {
          // A parseable local JWT is not ownership proof. Authorize the exact
          // selected license before querying the legacy owner-keyed catalog.
          const source = await this.exchange({ idToken: input.idToken!, licenseId: input.sourceLicenseId! }, operation.signal);
          const rows = await readJetBrainsIdeLicenseCatalog({ fetch: this.fetcher, accountId: input.accountId, version, now: this.now, signal: operation.signal });
          if (operation.signal.aborted) throw failure('cancelled');
          const verifiedAt = new Date(this.now()).toISOString();
          const receipt = rows.map(row => ({ ...row, verifiedAt }));
          this.licenseDirectories.delete(key);
          while (this.licenseDirectories.size >= 16) this.licenseDirectories.delete(this.licenseDirectories.keys().next().value!);
          this.licenseDirectories.set(key, { until: Math.min(this.now() + DIRECTORY_TTL, source.expiresAt ?? this.now() + DIRECTORY_TTL), rows: receipt });
          return receipt;
        } catch (error) { throw error instanceof JetBrainsLicenseCatalogError ? failure(error.code) : error instanceof JetBrainsIdeApiError ? error : failure(operation.signal.aborted ? 'cancelled' : 'response'); }
        finally { read.settled = true; read.controller.abort(); operation.cleanup(); if (this.licenseReads.get(key) === read) this.licenseReads.delete(key); }
      })();
      pending = read;
    }
    const read = pending; read.waiters++;
    try {
      return structuredClone(await new Promise<JetBrainsIdeLicense[]>((resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); reject(failure('cancelled')); };
        signal?.addEventListener('abort', abort, { once: true });
        read.promise.then(value => { signal?.removeEventListener('abort', abort); resolve(value); }, error => { signal?.removeEventListener('abort', abort); reject(error); });
        if (signal?.aborted) abort();
      }));
    } finally { if (--read.waiters === 0 && !read.settled) read.controller.abort(); }
  }

  async exchange(input: { idToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }> {
    // Native JbaIdToken checks only a nonblank identity ticket; its legacy
    // exchange sends that exact ticket to the server without an exp gate.
    // An old source exp is therefore only a hint, not an authorization verdict.
    // The derived Grazie JWT and native verify/v3 expiry remain strict below.
    const source = jwt(input.idToken, this.now(), 'hint');
    const licenseId = identifier(input.licenseId);
    if (!licenseId) throw failure('credentials');
    const result = await this.json('/auth/jetbrains-jwt/provide-access/license/v2', 'POST', { Authorization: `Bearer ${source.token}` }, { licenseId }, signal);
    return this.verifyDerived(result.token, signal);
  }

  /** New native JCP personal-license flow. The OS Integration SDK must issue
   * this access token for the exact audience `jb-authn-service,ai-platform-auth`.
   * It is not an ID token, a Grazie JWT, or the separate `ai-access` token.
   * IjJbaiLicenseAuthClient uses this fixed POST + Bearer + {licenseId} wire.
   */
  async exchangeJcp(input: { accessToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }> {
    const licenseId = identifier(input.licenseId);
    if (!licenseId || typeof input.accessToken !== 'string' || !/^[\x21-\x7e]{16,65536}$/.test(input.accessToken)) throw failure('credentials');
    const result = await this.json('/auth/jcp/provide-access/global-access-token', 'POST', { Authorization: `Bearer ${input.accessToken}` }, { licenseId }, signal);
    return this.verifyDerived(result.token, signal);
  }

  private async verifyDerived(value: unknown, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }> {
    const derived = jwt(value, this.now());
    // Parsing claims does not authenticate a JWT. Ask the native verify endpoint
    // before the coordinator persists a local relay/account connection.
    const verified = await this.json('/user/v5/auth/jwt/verify/v3', 'POST', this.auth(derived.token), undefined, signal);
    const verifiedExpiry = timestamp(verified.expires);
    if (verifiedExpiry === undefined) throw failure('response');
    if (verifiedExpiry <= this.now()) throw failure('authorization');
    return { token: derived.token, expiresAt: Math.min(derived.expiresAt ?? verifiedExpiry, verifiedExpiry) };
  }

  async quota(token: string, signal?: AbortSignal): Promise<SubscriptionUsage> {
    jwt(token, this.now());
    const response = await this.json('/user/v5/quota/get', 'POST', this.auth(token), undefined, signal);
    const current = object(response.current);
    if (!current) throw failure('response');
    const until = timestamp(current.until);
    const resetAt = until ? new Date(until).toISOString() : undefined;
    const windows: QuotaWindow[] = [];
    const tariff = object(current.tariffQuota), topUp = object(current.topUpQuota);
    if (tariff) { const value = quotaWindow('jetbrains-tariff', '会员额度', tariff, resetAt); if (value) windows.push(value); }
    if (topUp) { const value = quotaWindow('jetbrains-top-up', '加购额度', topUp); if (value) windows.push(value); }
    if (!windows.length) { const value = quotaWindow('jetbrains-total', 'AI 额度', current, resetAt); if (value) windows.push(value); }
    if (!windows.length) throw failure('response');
    // Installed native Quota/Get and QuotaTariff DTOs provide amounts and a
    // period, not a named subscription product. Do not infer AI Pro/Ultimate
    // from a maximum, license identifier or undocumented extra response keys.
    return { status: 'ready', windows, queriedAt: new Date(this.now()).toISOString(), message: '当前 JetBrains IDE 账号的官方 AI 额度。' };
  }

  async models(token: string, signal?: AbortSignal): Promise<JetBrainsIdeModels> {
    jwt(token, this.now());
    const key = digest(token);
    // A failed refresh must not leave an old entitlement allowlist usable.
    this.directories.delete(key);
    const response = await this.json('/user/v5/llm/profiles/v9', 'GET', this.auth(token), undefined, signal);
    if (!Array.isArray(response.profiles) || response.profiles.length > 10_000) throw failure('response');
    const models = new Map<string, RouteModel>();
    const seen = new Set<string>();
    for (const value of response.profiles) {
      const profile = object(value); if (!profile) continue;
      const id = identifier(profile.id), upstreamId = identifier(profile.providerModelID);
      if (!id || !Array.isArray(profile.features) || !profile.features.includes('Chat') || !object(profile.chatDefinition) || object(profile.lifeCycle)?.deprecated === true) continue;
      // Keep the already-supported OpenAI wire unchanged. Other verified
      // native vendors use the official provider-neutral Grazie V9 contract,
      // addressed by profile ID, never an invented OpenAI model or endpoint.
      const nativeOpenAI = profile.provider === 'OpenAI' || profile.provider === 'AzureOpenAI';
      const nativeGrazie = !nativeOpenAI && !!safeText(profile.provider, 64);
      if ((!nativeGrazie && !nativeOpenAI) || (nativeOpenAI && !upstreamId)) continue;
      const protocol = nativeOpenAI ? 'openai' : 'grazie';
      const path = nativeOpenAI ? profile.provider === 'OpenAI' ? '/user/v5/llm/openai/v1/chat/completions' : '/user/v5/llm/azure/openai/v1/chat/completions' : '/user/v5/llm/chat/stream/v9';
      if (seen.has(id)) { models.delete(id); continue; }
      seen.add(id);
      const model: JetBrainsIdeModel = { id, object: 'model', owned_by: 'jetbrains', modeldock_catalog_visibility: jetBrainsClientModelVisibility(id) };
      const name = safeText(profile.modelName, 160); if (name) model.name = name;
      if (typeof profile.contextLimit === 'number' && Number.isSafeInteger(profile.contextLimit) && profile.contextLimit > 0) model.context_length = profile.contextLimit;
      if (typeof profile.maxOutputTokens === 'number' && Number.isSafeInteger(profile.maxOutputTokens) && profile.maxOutputTokens > 0) model.max_output_tokens = profile.maxOutputTokens;
      const definition = object(profile.chatDefinition)!;
      const reasoning = jetBrainsReasoning(id, String(profile.provider), definition.parameters);
      // Keep unknown profiles explicit, so generic vendor dictionaries cannot
      // invent controls which this native account adapter cannot translate.
      model.reasoning_efforts = reasoning?.levels ?? [];
      if (reasoning) { model.default_reasoning_effort = reasoning.defaultLevel; model.thinking = true; model.reasoning_effort_format = 'chat-completions'; }
      // Official V9 ProfileInfo projection requires both tool messages and the
      // toolConfig.tools parameter. Missing descriptors remain unknown.
      if (Array.isArray(definition.roles) && Array.isArray(definition.parameters)) model.tools = definition.roles.includes('tool') && definition.parameters.includes('toolConfig.tools');
      const media = object(definition.multimediaDataDefinition);
      if (Array.isArray(media?.supportedTypes)) model.vision = media.supportedTypes.some(value => typeof value === 'string' && /^image\/(?:\*|[a-z0-9.+-]+)$/i.test(value));
      models.set(id, { model, upstreamId: upstreamId ?? id, path, protocol, requireToolSignatures: nativeGrazie });
    }
    // No tokens/raw profiles in the cache; at most eight account directories.
    if (this.directories.size >= 8) this.directories.delete(this.directories.keys().next().value!);
    this.directories.set(key, { fetchedAt: this.now(), models });
    // Visibility is discovery metadata only. Retain every compatible route so
    // showing a narrower client menu never invalidates already-saved models.
    return { data: Array.from(models.values(), value => structuredClone(value.model)), modeldock_history: { ...jetBrainsClientModelHistory } };
  }

  async chat(token: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    jwt(token, this.now());
    const requestModel = identifier(body.model);
    if (!requestModel || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1024 || body.messages.some(value => !object(value)) || body.stream !== undefined && typeof body.stream !== 'boolean') throw failure('request');
    let directory = this.directories.get(digest(token));
    if (!directory || this.now() - directory.fetchedAt >= DIRECTORY_TTL) { await this.models(token, signal); directory = this.directories.get(digest(token)); }
    const route = directory?.models.get(requestModel);
    if (!route) throw failure('model');
    if (body.reasoning_effort !== undefined && (typeof body.reasoning_effort !== 'string'
      || (route.protocol === 'grazie' || !!route.model.reasoning_efforts?.length) && !route.model.reasoning_efforts?.includes(body.reasoning_effort))) throw failure('reasoning');
    const grazie = route.protocol === 'grazie';
    const bridgeOptions = {
      profileId: route.model.id, maxOutputTokens: route.model.max_output_tokens,
      reasoningEfforts: route.model.reasoning_efforts,
      signatureNamespace: `${digest(token)}:${route.model.id}`, signatures: this.signatures, signal,
      history: body.messages, requireToolSignatures: route.requireToolSignatures,
      toolNames: Array.isArray(body.tools) ? body.tools.map(value => object(object(value)?.function)?.name).filter((name): name is string => typeof name === 'string') : [],
    };
    let encoded: string;
    try { encoded = JSON.stringify(grazie ? prepareJetBrainsGrazieChat(body, bridgeOptions) : { ...body, model: route.upstreamId }); }
    catch (error) { throw failure(error instanceof JetBrainsGrazieBridgeError ? error.status === 502 ? 'response' : 'capability' : 'request'); }
    if (Buffer.byteLength(encoded) > REQUEST_LIMIT) throw failure('limit');
    // OpenAI keeps its native wire. Claude/Google use the official Grazie V9
    // provider-neutral contract, with exact profile IDs and main-only signed
    // history; client-visible requests and replies remain Chat-compatible.
    const operation = this.operation(signal, 180_000);
    try {
      const upstream = await this.send(route.path, 'POST', { ...this.auth(token), Accept: grazie || body.stream ? 'text/event-stream' : 'application/json', 'Content-Type': 'application/json' }, encoded, operation.signal);
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!upstream.body || !(grazie ? /^text\/event-stream(?:\s*;|$)/i.test(contentType) : /^(?:application\/json|text\/event-stream)(?:\s*;|$)/i.test(contentType))) { await upstream.body?.cancel(); throw failure('response'); }
      const declared = Number(upstream.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > CHAT_LIMIT) { await upstream.body.cancel(); throw failure('limit'); }
      const reader = upstream.body.getReader();
      let size = 0, done = false;
      const finish = () => { if (done) return; done = true; operation.cleanup(); };
      const abort = () => { void reader.cancel().catch(() => {}); };
      operation.signal.addEventListener('abort', abort, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            if (operation.signal.aborted) throw failure('cancelled');
            const part = await reader.read();
            if (operation.signal.aborted) throw failure('cancelled');
            if (part.done) { controller.close(); operation.signal.removeEventListener('abort', abort); reader.releaseLock(); finish(); return; }
            size += part.value.byteLength;
            if (size > CHAT_LIMIT) { await reader.cancel(); throw failure('limit'); }
            controller.enqueue(part.value);
          } catch (error) { operation.signal.removeEventListener('abort', abort); reader.releaseLock(); finish(); controller.error(error instanceof JetBrainsIdeApiError ? error : failure('network')); }
        },
        cancel: async () => { operation.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); finish(); },
      });
      if (grazie) {
        const options = { ...bridgeOptions, signal: operation.signal };
        if (body.stream === true) return new Response(stream.pipeThrough(createJetBrainsGrazieChatStream(requestModel, options), { signal: operation.signal }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
        return Response.json(await collectJetBrainsGrazieChat(stream, requestModel, options), { headers: { 'cache-control': 'no-store' } });
      }
      return new Response(stream, { status: 200, headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
    } catch (error) { operation.cleanup(); throw error instanceof JetBrainsIdeApiError ? error : failure(operation.signal.aborted ? 'cancelled' : error instanceof JetBrainsGrazieBridgeError ? error.status === 400 ? 'capability' : 'response' : 'network'); }
  }

  private auth(token: string): Record<string, string> {
    // Truthful caller identification; do not impersonate the IDE or Central.
    return { 'Grazie-Authenticate-JWT': token };
  }
  private operation(parent: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent?.aborted) controller.abort(); else parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs); timer.unref();
    return { signal: controller.signal, cleanup: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
  }
  private async send(path: string, method: 'GET' | 'POST', headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw failure('cancelled');
    let response: Response;
    try { response = await this.fetcher(`${ORIGIN}${path}`, { method, headers: { 'Grazie-Agent': CALLER, ...headers }, ...(body === undefined ? {} : { body }), signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }); }
    catch { throw failure(signal.aborted ? 'cancelled' : 'network'); }
    // Check again for injected transports; native fetch('error') rejects 3xx.
    if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== ORIGIN) {
      await response.body?.cancel().catch(() => {});
      throw failure(response.status === 451 ? 'region' : response.status === 401 ? 'authorization' : response.status === 402 || response.status === 403 ? 'entitlement' : 'network', response.status);
    }
    return response;
  }
  private async json(path: string, method: 'GET' | 'POST', headers: Record<string, string>, body: JsonObject | undefined, signal?: AbortSignal): Promise<JsonObject> {
    const operation = this.operation(signal, 30_000);
    try {
      const response = await this.send(path, method, { Accept: 'application/json', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body ? JSON.stringify(body) : undefined, operation.signal);
      const declared = Number(response.headers.get('content-length'));
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || Number.isFinite(declared) && declared > JSON_LIMIT) { await response.body?.cancel(); throw failure('response'); }
      if (!response.body) throw failure('response');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      operation.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > JSON_LIMIT) { await reader.cancel(); throw failure('limit'); }
          chunks.push(part.value);
        }
      } finally { operation.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
      if (operation.signal.aborted) throw failure('cancelled');
      const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (!value) throw failure('response');
      return value;
    } catch (error) { throw error instanceof JetBrainsIdeApiError ? error : failure(operation.signal.aborted ? 'cancelled' : 'response'); }
    finally { operation.cleanup(); }
  }
}
