import { createHash } from 'node:crypto';
import { version } from '../../package.json';
import type { QuotaWindow, SubscriptionUsage } from '../shared/auth-types';

/** Native personal-license API, independently of Central CLI. The wire contract
 * comes from the installed JetBrains AI Assistant 2026.2 public classes:
 * AuthAPIClient.getAccessV2/verifyV3, QuotaAPI.Get, LlmAPI.Profiles.V9 and
 * OpenAIProxyProvider/OpenAIAzureProxyProvider -> GrazieProxyProvider.
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
export type JetBrainsIdeApiErrorCode = 'credentials' | 'authorization' | 'entitlement' | 'network' | 'response' | 'cancelled' | 'model' | 'request' | 'limit';
const messages: Record<JetBrainsIdeApiErrorCode, string> = {
  credentials: 'JetBrains 账号授权或许可证信息无效，请在原生客户端重新登录后重试。',
  authorization: 'JetBrains 账号授权已失效，请在原生客户端重新登录后重试。',
  entitlement: 'JetBrains 未接受当前许可证，请检查账号的 AI 会员权限。',
  network: 'JetBrains AI 服务暂时无法连接，请稍后重试。',
  response: 'JetBrains AI 服务返回了无法识别的数据，未保存该结果。',
  cancelled: 'JetBrains AI 请求已取消或超时。',
  model: '此模型未在当前账号的兼容模型目录中，请刷新模型列表后重试。',
  request: '此 JetBrains 连接需要有效的 Chat Completions 请求。',
  limit: 'JetBrains AI 请求或响应超出支持范围。',
};
export class JetBrainsIdeApiError extends Error {
  constructor(readonly code: JetBrainsIdeApiErrorCode) { super(messages[code]); this.name = 'JetBrainsIdeApiError'; }
}
export interface JetBrainsIdeModel {
  id: string;
  object: 'model';
  owned_by: 'jetbrains';
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
}
export interface JetBrainsIdeApiOptions { fetch?: typeof globalThis.fetch; now?: () => number }
interface RouteModel { model: JetBrainsIdeModel; upstreamId: string; path: string }
interface Directory { fetchedAt: number; models: Map<string, RouteModel> }
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const safeText = (value: unknown, max = 256): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const identifier = (value: unknown): string | undefined => { const text = safeText(value); return text && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(text) ? text : undefined; };
const failure = (code: JetBrainsIdeApiErrorCode) => new JetBrainsIdeApiError(code);
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
  constructor(options: JetBrainsIdeApiOptions = {}) { this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now; }

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
    return { status: 'ready', windows, queriedAt: new Date(this.now()).toISOString(), message: '当前 JetBrains IDE 账号的官方 AI 额度。' };
  }

  async models(token: string, signal?: AbortSignal): Promise<{ data: JetBrainsIdeModel[] }> {
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
      if (!id || !upstreamId || !Array.isArray(profile.features) || !profile.features.includes('Chat') || !object(profile.chatDefinition) || object(profile.lifeCycle)?.deprecated === true) continue;
      // LLMType uses these exact enum values. Other native vendor APIs have
      // different bodies; never label their profiles as OpenAI-compatible.
      const path = profile.provider === 'OpenAI' ? '/user/v5/llm/openai/v1/chat/completions' : profile.provider === 'AzureOpenAI' ? '/user/v5/llm/azure/openai/v1/chat/completions' : undefined;
      if (!path) continue;
      if (seen.has(id)) { models.delete(id); continue; }
      seen.add(id);
      const model: JetBrainsIdeModel = { id, object: 'model', owned_by: 'jetbrains' };
      const name = safeText(profile.modelName, 160); if (name) model.name = name;
      if (typeof profile.contextLimit === 'number' && Number.isSafeInteger(profile.contextLimit) && profile.contextLimit > 0) model.context_length = profile.contextLimit;
      if (typeof profile.maxOutputTokens === 'number' && Number.isSafeInteger(profile.maxOutputTokens) && profile.maxOutputTokens > 0) model.max_output_tokens = profile.maxOutputTokens;
      models.set(id, { model, upstreamId, path });
    }
    // No tokens/raw profiles in the cache; at most eight account directories.
    if (this.directories.size >= 8) this.directories.delete(this.directories.keys().next().value!);
    this.directories.set(key, { fetchedAt: this.now(), models });
    return { data: Array.from(models.values(), value => ({ ...value.model })) };
  }

  async chat(token: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    jwt(token, this.now());
    const requestModel = identifier(body.model);
    if (!requestModel || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1024 || body.messages.some(value => !object(value)) || body.stream !== undefined && typeof body.stream !== 'boolean') throw failure('request');
    let directory = this.directories.get(digest(token));
    if (!directory || this.now() - directory.fetchedAt >= DIRECTORY_TTL) { await this.models(token, signal); directory = this.directories.get(digest(token)); }
    const route = directory?.models.get(requestModel);
    if (!route) throw failure('model');
    let encoded: string;
    try { encoded = JSON.stringify({ ...body, model: route.upstreamId }); } catch { throw failure('request'); }
    if (Buffer.byteLength(encoded) > REQUEST_LIMIT) throw failure('limit');
    // Native local-proxy forwarding preserves the OpenAI JSON body, including
    // tools, multimodal messages and stream. The selected model decides support.
    // Only model is translated from the authorized profile ID to its native ID.
    const operation = this.operation(signal, 180_000);
    try {
      const upstream = await this.send(route.path, 'POST', { ...this.auth(token), Accept: body.stream ? 'text/event-stream' : 'application/json', 'Content-Type': 'application/json' }, encoded, operation.signal);
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!upstream.body || !/^(?:application\/json|text\/event-stream)(?:\s*;|$)/i.test(contentType)) { await upstream.body?.cancel(); throw failure('response'); }
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
      return new Response(stream, { status: 200, headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
    } catch (error) { operation.cleanup(); throw error instanceof JetBrainsIdeApiError ? error : failure(operation.signal.aborted ? 'cancelled' : 'network'); }
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
      throw failure(response.status === 401 ? 'authorization' : response.status === 402 || response.status === 403 ? 'entitlement' : 'network');
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
