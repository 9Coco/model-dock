import { createHash, randomUUID } from 'node:crypto';
import type { AuthAccount, RelayClientImportPreview, RelayClientImportProvenance, SubscriptionUsage } from '../shared/auth-types';
import { TRAE_RELAY_BASE_URL } from '../shared/presets';
import { quotaCacheExpired } from '../shared/quota-display';
import type { Provider, ProviderInput } from '../shared/types';
import type { Store } from './store';
import type { TraeClientCredentials, TraeClientImporter } from './trae-client-import';
import { relayAccountView, relayConnectionFingerprint } from './relay-client-import';

type NativeClient = 'trae-cn' | 'trae-solo-cn';
type NativeStore = Pick<Store, 'listProviders' | 'getProvider' | 'getSecret' | 'getManagedState' | 'setManagedState' | 'saveRelayClientImport'>;
type NativeReader = Pick<TraeClientImporter, 'listCandidates' | 'readCredentials'>;
export interface TraeNativeQuota { usage: SubscriptionUsage; plan?: string }
export interface TraeNativeApiPort { quota(credentials: TraeClientCredentials, signal?: AbortSignal): Promise<TraeNativeQuota> }
interface NativeMetadata {
  version: 1; connection: string; identity: string; revision: string; clientImport: RelayClientImportProvenance;
  nativeClient: { version: 1; client: NativeClient; credentials: TraeClientCredentials };
}
interface QuotaCache extends TraeNativeQuota { version: 3; revision: string }
interface Ticket { client: NativeClient; identity: string; expires: number }
export class TraeNativeAccountError extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const planName = (value: unknown): string | undefined => typeof value === 'string' && ['Free', 'Pro', 'Pro+', 'Ultra', 'Lite', 'Express'].includes(value) ? value : undefined;
const sourceIdentity = (client: NativeClient, accountId: string) => hash([client, accountId]);
const unavailable = 'TRAE 本机账号暂不可用，请在中国版客户端检查登录状态后重新导入。';

/** Encrypted native snapshots for direct main-process gateway dispatch. The
 * provider's compatibility URL/key are never upstream authorization and do
 * not represent an independently started local relay. No source-client write,
 * daemon, Docker/Python dependency, or import-time upstream request exists. */
export class TraeNativeAccounts {
  private readonly tickets = new Map<string, Ticket>();
  private readonly pending = new Map<string, { revision: string; controller: AbortController; promise: Promise<AuthAccount> }>();
  private importing = false;
  private closed = false;
  constructor(private readonly store: NativeStore, private readonly reader: NativeReader, private readonly api: TraeNativeApiPort,
    private readonly localKey: () => string, private readonly safeMessage: (error: unknown) => string | undefined = () => undefined, private readonly now = Date.now) {}
  private error(error: unknown, fallback = unavailable): TraeNativeAccountError {
    return error instanceof TraeNativeAccountError ? error : new TraeNativeAccountError(this.safeMessage(error) ?? fallback);
  }
  private assertOpen(): void { if (this.closed) throw new TraeNativeAccountError('TRAE 账号服务已停止。'); }
  isNativeProvider(id: string): boolean {
    try { return this.store.getProvider(id)?.presetId === 'trae-cn-relay' && this.store.getManagedState<Partial<NativeMetadata> | null>(`auth-metadata:${id}`, null)?.nativeClient !== undefined; }
    catch { throw new TraeNativeAccountError('无法读取已保存的 TRAE 授权，请检查本机存储后重试。'); }
  }
  private snapshot(value: TraeClientCredentials): TraeClientCredentials {
    const secret = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 32768 && !/[\s\x00-\x1f\x7f]/.test(item);
    if (!value || value.host !== 'https://api.trae.cn' || !secret(value.token) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token) || !text(value.userId) || !/^[A-Za-z0-9_.:-]+$/.test(value.userId)) throw new TraeNativeAccountError('TRAE 本机账号格式无法识别，请重新登录后再导入。');
    const result: TraeClientCredentials = { token: value.token, userId: value.userId, host: 'https://api.trae.cn' };
    if (value.refreshToken !== undefined) { if (!secret(value.refreshToken)) throw new TraeNativeAccountError('TRAE 本机账号格式无法识别，请重新登录后再导入。'); result.refreshToken = value.refreshToken; }
    const deadlines: number[] = [];
    try {
      const claims: unknown = JSON.parse(Buffer.from(value.token.split('.')[1], 'base64url').toString('utf8'));
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error();
      const exp = (claims as Record<string, unknown>).exp;
      if (exp !== undefined) {
        if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0 || exp > 253402300799) throw new Error();
        deadlines.push(exp * 1000);
      }
    } catch { throw new TraeNativeAccountError('TRAE 本机账号格式无法识别，请重新登录后再导入。'); }
    for (const key of ['expiredAt', 'refreshExpiredAt'] as const) if (value[key] !== undefined) {
      const date = text(value[key], 80), time = date ? Date.parse(date) : NaN;
      if (!date || !/^\d{4}-\d{2}-\d{2}T/.test(date) || !Number.isFinite(time) || time <= 0) throw new TraeNativeAccountError('TRAE 本机账号期限无法识别，请重新登录后再导入。');
      if (key === 'expiredAt') deadlines.push(time); else result.refreshExpiredAt = new Date(time).toISOString();
    }
    if (deadlines.length) {
      const until = Math.min(...deadlines);
      if (until <= this.now()) throw new TraeNativeAccountError('TRAE 本机授权已过期，请先在客户端重新登录，再重新导入。');
      result.expiredAt = new Date(until).toISOString();
    }
    for (const key of ['clientId', 'webId', 'bizUserId', 'userUniqueId', 'scope', 'tenant', 'region', 'aiRegion', 'appLanguage', 'userRegion', 'userIdentity', 'screenName', 'label'] as const) if (value[key] !== undefined) {
      const clean = text(value[key], key === 'screenName' || key === 'label' ? 160 : 256);
      if (!clean) throw new TraeNativeAccountError('TRAE 本机账号格式无法识别，请重新登录后再导入。'); result[key] = clean;
    }
    return result;
  }
  private context(id: string): { provider: Provider; metadata: NativeMetadata; credentials: TraeClientCredentials } {
    this.assertOpen();
    try {
      const provider = this.store.getProvider(id), metadata = this.store.getManagedState<NativeMetadata | null>(`auth-metadata:${id}`, null), key = this.store.getSecret(id)?.apiKey;
      const native = metadata?.nativeClient;
      if (!provider || provider.presetId !== 'trae-cn-relay' || provider.kind !== 'openai-compatible' || provider.relayMode !== 'managed' || provider.baseUrl !== TRAE_RELAY_BASE_URL || provider.claudeBaseUrl || provider.messagesAuth !== 'bearer' || !key || metadata?.version !== 1 || !text(metadata.revision) || metadata.connection !== relayConnectionFingerprint(provider, key) || native?.version !== 1 || !['trae-cn', 'trae-solo-cn'].includes(native.client) || metadata.clientImport.client !== native.client) throw new TraeNativeAccountError('已保存的 TRAE 本机授权或连接已变更，请重新从客户端导入。');
      const credentials = this.snapshot(native.credentials);
      if (metadata.identity !== sourceIdentity(native.client, credentials.userId)) throw new TraeNativeAccountError('已保存的 TRAE 账号身份不一致，请重新导入。');
      return { provider, metadata, credentials };
    } catch (error) { throw this.error(error, '无法读取已保存的 TRAE 本机授权，请检查本机存储后重新导入。'); }
  }
  /** Main-process only: never expose through preload, config export or logs. */
  credentials(id: string): TraeClientCredentials { return structuredClone(this.context(id).credentials); }
  async preview(): Promise<RelayClientImportPreview> {
    this.assertOpen();
    try {
      const source = await this.reader.listCandidates(), now = this.now();
      this.assertOpen();
      for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
      if (source.length > 10) throw new TraeNativeAccountError('本机 TRAE 来源过多，请先整理客户端账号。');
      const candidates = source.map(candidate => {
        if (!['trae-cn', 'trae-solo-cn'].includes(candidate.id) || !text(candidate.accountId) || !text(candidate.label)) throw new TraeNativeAccountError('TRAE 本机客户端来源无效，请重新读取。');
        const id = randomUUID(); this.tickets.set(id, { client: candidate.id, identity: sourceIdentity(candidate.id, candidate.accountId), expires: now + 5 * 60_000 });
        return { id, clientName: candidate.id === 'trae-cn' ? 'TRAE 中国版' : 'TRAE SOLO 中国版', accountLabel: text(candidate.displayName) ?? text(candidate.label)! };
      });
      return { kind: 'trae-cn-relay', candidates, message: candidates.length ? '请选择本机 TRAE 账号。导入后由 ModelDock 网关直接连接上游，无需 Docker 或独立反代进程。' : '未找到已登录的 TRAE 中国版客户端，请先在客户端登录。' };
    } catch (error) { throw this.error(error); }
  }
  async import(id: string): Promise<AuthAccount> {
    this.assertOpen();
    if (this.importing) throw new TraeNativeAccountError('TRAE 账号正在导入，请等待当前操作完成。');
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.expires <= this.now()) throw new TraeNativeAccountError('客户端选择已过期，请关闭窗口后重新选择。');
    this.importing = true;
    try {
      const first = this.snapshot(await this.reader.readCredentials(ticket.client));
      if (sourceIdentity(ticket.client, first.userId) !== ticket.identity) throw new TraeNativeAccountError('TRAE 当前账号已切换，请关闭窗口后重新选择。');
      const key = this.localKey();
      const eligibleProviders = () => this.store.listProviders().filter(provider => provider.kind === 'openai-compatible' && provider.presetId === 'trae-cn-relay' && provider.relayMode === 'managed' && provider.baseUrl === TRAE_RELAY_BASE_URL && !provider.claudeBaseUrl && provider.messagesAuth === 'bearer' && (!provider.hasSecret || this.store.getSecret(provider.id)?.apiKey === key));
      const eligible = eligibleProviders(), eligibleFingerprint = hash(eligible);
      const matching = eligible.filter(provider => this.store.getManagedState<Partial<NativeMetadata> | null>(`auth-metadata:${provider.id}`, null)?.identity === ticket.identity);
      if (matching.length > 1 || matching.length === 0 && eligible.length > 1) throw new TraeNativeAccountError('已有多个使用此本机入口的 TRAE 连接，请先在供应商中整理后再导入。');
      const target = matching[0] ?? eligible[0], expected = target ? { provider: target, apiKey: this.store.getSecret(target.id)?.apiKey } : undefined;
      const beforeMetadata = target ? hash(this.store.getManagedState(`auth-metadata:${target.id}`, null)) : undefined;
      const latest = this.snapshot(await this.reader.readCredentials(ticket.client));
      if (sourceIdentity(ticket.client, latest.userId) !== ticket.identity) throw new TraeNativeAccountError('TRAE 当前账号在读取期间已切换，请关闭窗口后重新选择。');
      this.assertOpen();
      if (ticket.expires <= this.now() || eligibleFingerprint !== hash(eligibleProviders())) throw new TraeNativeAccountError('TRAE 连接或客户端选择在导入期间已变更，请重新选择。');
      if (target && beforeMetadata !== hash(this.store.getManagedState(`auth-metadata:${target.id}`, null))) throw new TraeNativeAccountError('TRAE 授权在导入期间已变更，请重新选择。');
      let name = target?.name ?? 'TRAE 中国版 · 客户端导入'; const base = name; let suffix = 2;
      while (!target && this.store.listProviders().some(provider => provider.name.toLowerCase() === name.toLowerCase())) name = `${base} ${suffix++}`;
      const input: ProviderInput = { ...target, ...(target ? { id: target.id } : {}), name, enabled: target?.enabled ?? true, note: target?.note ?? '', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'managed', baseUrl: TRAE_RELAY_BASE_URL, messagesAuth: 'bearer', claudeBaseUrl: '', apiKey: key };
      const metadata: NativeMetadata = { version: 1, revision: randomUUID(), connection: relayConnectionFingerprint(input, key), identity: ticket.identity,
        clientImport: { client: ticket.client, accountLabel: latest.screenName ?? latest.label ?? latest.userId, importedAt: new Date(this.now()).toISOString(), upstreamVerified: false }, nativeClient: { version: 1, client: ticket.client, credentials: latest } };
      let saved: Provider;
      try { saved = await this.store.saveRelayClientImport(input, metadata, expected); }
      catch { throw new TraeNativeAccountError('TRAE 本机账号未能保存，原供应商和模型保持不变，请重新导入。'); }
      this.tickets.delete(id);
      return this.decorate(relayAccountView(this.store, saved));
    } catch (error) { throw this.error(error); }
    finally { this.importing = false; }
  }
  decorate(account: AuthAccount): AuthAccount {
    if (account.kind !== 'trae-cn-relay' || !this.isNativeProvider(account.providerId)) return account;
    const { plan: _oldPlan, accountId: _oldId, displayName: _oldName, expiresAt: _oldExpiry, ...baseAccount } = account;
    try {
      const { credentials, metadata } = this.context(account.providerId), cached = this.store.getManagedState<QuotaCache | null>(`auth-usage:${account.providerId}`, null);
      // Earlier caches lack current validity/grouping or CN omission semantics.
      // Keep the encrypted account intact and require a fresh observation.
      const validCache = cached?.version === 3 && cached.revision === metadata.revision;
      const usage = structuredClone(validCache ? cached.usage : { status: 'not-queried' as const, windows: [], message: '本机账号已导入；尚未查询官方套餐和额度，云端授权与模型推理仍需确认。' });
      if (usage.status === 'ready' && quotaCacheExpired(usage, this.now())) { usage.status = 'stale'; usage.message = '显示此 TRAE 账号上次查询的官方额度，请刷新确认。'; }
      const plan = validCache ? planName(cached.plan) : undefined;
      return { ...baseAccount, accountId: credentials.userId, displayName: credentials.screenName ?? credentials.label ?? credentials.userId, ...(credentials.expiredAt ? { expiresAt: Date.parse(credentials.expiredAt) } : {}), ...(plan ? { plan } : {}), authStatus: 'ready', canRefresh: false, canQueryUsage: true, usage };
    } catch (error) { return { ...baseAccount, authStatus: 'expired', canRefresh: false, canQueryUsage: false, usage: { status: 'unavailable', windows: [], message: this.error(error).message } }; }
  }
  refreshUsage(id: string): Promise<AuthAccount> {
    const context = this.context(id), pending = this.pending.get(id);
    if (pending?.revision === context.metadata.revision) return pending.promise;
    const controller = new AbortController();
    const promise = (async () => {
      let result: TraeNativeQuota;
      try {
        const queried = await this.api.quota(structuredClone(context.credentials), controller.signal);
        if (!queried.usage || !Array.isArray(queried.usage.windows)) throw new Error();
        const plan = planName(queried.plan); result = { usage: queried.usage, ...(plan ? { plan } : {}) };
      } catch (error) { result = { usage: { status: 'unavailable', windows: [], queriedAt: new Date(this.now()).toISOString(), message: this.error(error, 'TRAE 官方套餐与额度查询失败，请检查账号登录或网络后重试。').message } }; }
      if (this.context(id).metadata.revision !== context.metadata.revision) throw new TraeNativeAccountError('TRAE 账号在查询期间已变更，未保存旧账号额度。');
      try { this.store.setManagedState(`auth-usage:${id}`, { ...result, version: 3, revision: context.metadata.revision } satisfies QuotaCache); }
      catch { throw new TraeNativeAccountError('TRAE 额度已查询，但本地缓存未能保存，请重试。'); }
      return this.decorate(relayAccountView(this.store, this.context(id).provider));
    })();
    this.pending.set(id, { revision: context.metadata.revision, controller, promise });
    void promise.finally(() => { if (this.pending.get(id)?.promise === promise) this.pending.delete(id); }).catch(() => {}); return promise;
  }
  providerRemoved(id: string): void { this.pending.get(id)?.controller.abort(); this.pending.delete(id); }
  dispose(): void { this.closed = true; this.tickets.clear(); for (const pending of this.pending.values()) pending.controller.abort(); this.pending.clear(); }
}
