import { createHash, randomUUID } from 'node:crypto';
import type { AuthAccount, RelayClientImportPreview, RelayClientImportProvenance, SubscriptionUsage } from '../shared/auth-types';
import { JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import { quotaCacheExpired } from '../shared/quota-display';
import type { Provider, ProviderInput } from '../shared/types';
import type { Store } from './store';
import type { CentralCredentials, CentralTransfer } from './central-api';
import { relayAccountView, relayConnectionFingerprint } from './relay-client-import';

type NativeStore = Pick<Store, 'listProviders' | 'getProvider' | 'getSecret' | 'getManagedState' | 'setManagedState' | 'saveRelayClientImport'>;
interface Reader { read(): Promise<CentralTransfer> }
interface Api { connect(transfer: CentralTransfer, signal?: AbortSignal): Promise<CentralCredentials>; quota(credentials: CentralCredentials, signal?: AbortSignal): Promise<SubscriptionUsage> }
interface Metadata { version: 1; revision: string; connection: string; identity: string; clientImport: RelayClientImportProvenance; nativeCentral: { version: 1; credentials: CentralCredentials } }
interface Cache { version: 1; revision: string; usage: SubscriptionUsage }
export class CentralNativeAccountError extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const identity = (value: CentralCredentials) => hash([value.accountId, value.licenseId]);

/** Explicit Central account import into the existing gateway. The source CLI
 * is consulted only by preview/import; inference uses the encrypted verified
 * snapshot without CLI/Pi processes, sidecar listeners or automatic OAuth. */
export class CentralNativeAccounts {
  private readonly tickets = new Map<string, { fingerprint: string; until: number }>();
  private readonly pending = new Map<string, { revision: string; controller: AbortController; promise: Promise<AuthAccount> }>();
  private importing?: AbortController;
  private closed = false;
  constructor(private readonly store: NativeStore, private readonly reader: Reader, private readonly api: Api, private readonly localKey: () => string,
    private readonly safeMessage: (error: unknown) => string | undefined = () => undefined, private readonly now = Date.now) {}
  private error(error: unknown, fallback = 'Central 当前账号暂不可用，请在客户端登录后重新连接。'): CentralNativeAccountError { return error instanceof CentralNativeAccountError ? error : new CentralNativeAccountError(this.safeMessage(error) ?? fallback); }
  private open(): void { if (this.closed) throw new CentralNativeAccountError('Central 账号服务已停止。'); }
  private transfer(value: CentralTransfer): CentralTransfer {
    if (!value || value.version !== 1 || value.environment !== 'prod' || !text(value.refreshToken, 32768) || /\s/.test(value.refreshToken) || !text(value.licenseId) || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value.licenseId)) throw new CentralNativeAccountError('Central 当前会话不是已核实的个人许可证授权，请重新连接受支持的账号。');
    return { version: 1, environment: 'prod', refreshToken: value.refreshToken, licenseId: value.licenseId };
  }
  private snapshot(value: CentralCredentials): CentralCredentials {
    if (!value || !text(value.token, 65536) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token) || !text(value.accountId, 160) || !text(value.accountLabel, 160) || !text(value.licenseId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) throw new CentralNativeAccountError('Central 已保存的授权无效或已过期，请重新连接账号。');
    let expiresAt = value.expiresAt;
    try { const claims = JSON.parse(Buffer.from(value.token.split('.')[1], 'base64url').toString('utf8')); if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= this.now()) throw new Error(); expiresAt = Math.min(expiresAt, claims.exp * 1000); }
    catch { throw new CentralNativeAccountError('Central 已保存的授权无效或已过期，请重新连接账号。'); }
    return { token: value.token, accountId: value.accountId, accountLabel: value.accountLabel, licenseId: value.licenseId, expiresAt };
  }
  isNativeProvider(id: string): boolean {
    try { return this.store.getProvider(id)?.presetId === 'jetbrains-central' && this.store.getManagedState<Partial<Metadata> | null>(`auth-metadata:${id}`, null)?.nativeCentral !== undefined; }
    catch { throw new CentralNativeAccountError('无法读取已保存的 Central 授权，请检查本机存储后重试。'); }
  }
  private context(id: string): { provider: Provider; metadata: Metadata; credentials: CentralCredentials } {
    this.open();
    try {
      const provider = this.store.getProvider(id), metadata = this.store.getManagedState<Metadata | null>(`auth-metadata:${id}`, null), key = this.store.getSecret(id)?.apiKey;
      if (!provider || provider.presetId !== 'jetbrains-central' || provider.kind !== 'openai-compatible' || provider.baseUrl !== JETBRAINS_RELAY_BASE_URL || provider.claudeBaseUrl || provider.messagesAuth !== 'bearer' || !key || metadata?.version !== 1 || !text(metadata.revision, 160) || metadata.connection !== relayConnectionFingerprint(provider, key) || metadata.clientImport?.client !== 'jetbrains-central' || metadata.nativeCentral?.version !== 1) throw new CentralNativeAccountError('Central 账号或连接已变更，请重新连接；不会启动旧 Pi 反代。');
      const credentials = this.snapshot(metadata.nativeCentral.credentials);
      if (metadata.identity !== identity(credentials)) throw new CentralNativeAccountError('Central 账号身份不一致，请重新连接。');
      return { provider, metadata, credentials };
    } catch (error) { throw this.error(error); }
  }
  /** Main-process only; the returned copy never belongs in preload or exports. */
  credentials(id: string): CentralCredentials { return structuredClone(this.context(id).credentials); }
  async preview(): Promise<RelayClientImportPreview> {
    this.open();
    try {
      const value = this.transfer(await this.reader.read()); this.open(); const now = this.now();
      for (const [id, ticket] of this.tickets) if (ticket.until <= now) this.tickets.delete(id);
      const id = randomUUID(); this.tickets.set(id, { fingerprint: hash(value), until: now + 5 * 60_000 });
      return { kind: 'jetbrains-central', candidates: [{ id, clientName: 'Central CLI · 当前个人 AI 许可证' }], message: '确认后校验当前 Central 账号，并由现有 ModelDock 网关直接连接官方服务；不启动 Central/Pi 反代。' };
    } catch (error) { throw this.error(error); }
  }
  async import(id: string): Promise<AuthAccount> {
    this.open(); if (this.importing) throw new CentralNativeAccountError('Central 账号正在连接，请等待当前操作完成。');
    const ticket = this.tickets.get(id); if (!ticket || ticket.until <= this.now()) throw new CentralNativeAccountError('Central 客户端选择已过期，请重新选择。');
    const controller = new AbortController(); this.importing = controller;
    try {
      const source = this.transfer(await this.reader.read()); if (hash(source) !== ticket.fingerprint) throw new CentralNativeAccountError('Central 当前账号或许可证已切换，请重新选择。');
      this.open(); const key = this.localKey();
      const eligibleProviders = () => this.store.listProviders().filter(provider => provider.kind === 'openai-compatible' && provider.presetId === 'jetbrains-central' && provider.baseUrl === JETBRAINS_RELAY_BASE_URL && !provider.claudeBaseUrl && provider.messagesAuth === 'bearer' && (!provider.hasSecret || this.store.getSecret(provider.id)?.apiKey === key));
      const eligible = eligibleProviders(), eligibleBefore = hash(eligible);
      if (eligible.length > 1) throw new CentralNativeAccountError('已有多个使用此本机入口的 JetBrains 连接，请先整理后重新连接。');
      const target = eligible[0], expected = target ? { provider: target, apiKey: this.store.getSecret(target.id)?.apiKey } : undefined;
      const metadataBefore = target ? hash(this.store.getManagedState(`auth-metadata:${target.id}`, null)) : undefined;
      const credentials = this.snapshot(await this.api.connect(source, controller.signal));
      if (credentials.licenseId !== source.licenseId) throw new CentralNativeAccountError('官方授权返回的许可证与所选来源不一致，未保存。');
      if (hash(this.transfer(await this.reader.read())) !== ticket.fingerprint) throw new CentralNativeAccountError('Central 账号在授权期间已切换，未保存旧账号授权，请重新选择。');
      this.open();
      if (controller.signal.aborted || ticket.until <= this.now() || eligibleBefore !== hash(eligibleProviders()) || target && metadataBefore !== hash(this.store.getManagedState(`auth-metadata:${target.id}`, null))) throw new CentralNativeAccountError('Central 连接在授权期间已变更，请重新选择。');
      let name = target?.name ?? 'JetBrains AI · Central 导入'; const base = name; let suffix = 2;
      while (!target && this.store.listProviders().some(provider => provider.name.toLowerCase() === name.toLowerCase())) name = `${base} ${suffix++}`;
      const input: ProviderInput = { ...target, ...(target ? { id: target.id } : {}), name, note: target?.note ?? '', enabled: target?.enabled ?? true, kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, messagesAuth: 'bearer', claudeBaseUrl: '', apiKey: key };
      const metadata: Metadata = { version: 1, revision: randomUUID(), connection: relayConnectionFingerprint(input, key), identity: identity(credentials), clientImport: { client: 'jetbrains-central', accountLabel: credentials.accountLabel, importedAt: new Date(this.now()).toISOString(), upstreamVerified: true }, nativeCentral: { version: 1, credentials } };
      let saved: Provider;
      try { saved = await this.store.saveRelayClientImport(input, metadata, expected); }
      catch { throw new CentralNativeAccountError('Central 授权已校验，但本地记录未能保存，原供应商和模型保持不变，请重试。'); }
      this.tickets.delete(id); return this.decorate(relayAccountView(this.store, saved));
    } catch (error) { throw this.error(error); }
    finally { if (this.importing === controller) this.importing = undefined; }
  }
  decorate(account: AuthAccount): AuthAccount {
    if (account.kind !== 'jetbrains-central' || !this.isNativeProvider(account.providerId)) return account;
    const { plan: _oldPlan, accountId: _oldId, displayName: _oldName, expiresAt: _oldExpiry, ...base } = account;
    try {
      const { credentials, metadata } = this.context(account.providerId), cached = this.store.getManagedState<Cache | null>(`auth-usage:${account.providerId}`, null);
      const usage = structuredClone(cached?.version === 1 && cached.revision === metadata.revision ? cached.usage : { status: 'not-queried' as const, windows: [], message: 'Central 官方授权已校验；尚未查询此账号额度，套餐类型未知。' });
      if (usage.status === 'ready' && quotaCacheExpired(usage, this.now())) { usage.status = 'stale'; usage.message = '显示此 Central 账号上次的官方额度，请刷新确认。'; }
      return { ...base, accountId: credentials.accountId, displayName: credentials.accountLabel, expiresAt: credentials.expiresAt, authStatus: 'ready', canRefresh: false, canQueryUsage: true, usage };
    } catch (error) { return { ...base, authStatus: 'expired', canRefresh: false, canQueryUsage: false, usage: { status: 'unavailable', windows: [], message: this.error(error).message } }; }
  }
  refreshUsage(id: string): Promise<AuthAccount> {
    const context = this.context(id), active = this.pending.get(id); if (active?.revision === context.metadata.revision) return active.promise;
    const controller = new AbortController();
    const promise = (async () => {
      let usage: SubscriptionUsage;
      try { usage = await this.api.quota(structuredClone(context.credentials), controller.signal); if (!usage || !Array.isArray(usage.windows)) throw new Error(); }
      catch (error) { usage = { status: 'unavailable', windows: [], queriedAt: new Date(this.now()).toISOString(), message: this.error(error, 'Central 官方额度查询失败，请检查账号授权或网络后重试。').message }; }
      if (this.context(id).metadata.revision !== context.metadata.revision) throw new CentralNativeAccountError('Central 账号在查询期间已变更，未保存旧账号额度。');
      try { this.store.setManagedState(`auth-usage:${id}`, { version: 1, revision: context.metadata.revision, usage } satisfies Cache); }
      catch { throw new CentralNativeAccountError('Central 额度已查询，但本地缓存未能保存，请重试。'); }
      return this.decorate(relayAccountView(this.store, this.context(id).provider));
    })();
    this.pending.set(id, { revision: context.metadata.revision, controller, promise }); void promise.finally(() => { if (this.pending.get(id)?.promise === promise) this.pending.delete(id); }).catch(() => {}); return promise;
  }
  providerRemoved(id: string): void { this.pending.get(id)?.controller.abort(); this.pending.delete(id); }
  dispose(): void { this.closed = true; this.importing?.abort(); this.tickets.clear(); for (const active of this.pending.values()) active.controller.abort(); this.pending.clear(); }
}
