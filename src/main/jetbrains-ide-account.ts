import { createHash, randomUUID } from 'node:crypto';
import type { AuthAccount, RelayClientImportPreview, RelayClientImportProvenance, SubscriptionUsage } from '../shared/auth-types';
import { JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import { quotaCacheExpired } from '../shared/quota-display';
import type { Provider, ProviderInput } from '../shared/types';
import type { Store } from './store';
import type { JetBrainsIdeCredentials, JetBrainsIdeImporter } from './jetbrains-ide-import';
import { JetBrainsIdeRelay, JetBrainsIdeRelayFailure } from './jetbrains-ide-relay';
import { relayAccountView, relayConnectionFingerprint } from './relay-client-import';

export interface JetBrainsIdeApiPort {
  exchange(credentials: { idToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }>;
  exchangeJcp?(credentials: { accessToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }>;
  quota(token: string, signal?: AbortSignal): Promise<SubscriptionUsage>;
  models(token: string, signal?: AbortSignal): Promise<{ data: { id: string; object: 'model' }[] }>;
  chat(token: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}
type NativeStore = Pick<Store, 'listProviders' | 'getProvider' | 'getSecret' | 'getManagedState' | 'setManagedState' | 'saveRelayClientImport'>;
interface NativeMetadata {
  version: 1; connection: string; identity: string; revision: string; clientImport: RelayClientImportProvenance;
  initialUsage?: SubscriptionUsage;
  nativeIde?: { tokenType?: 'jba-id-token' | 'jcp-global-access-token'; idToken?: string; accessToken?: string; accountId: string; accountLabel: string; licenseId: string; sourceIdentity: string; product: string; sourceTokenExpHint?: number; expiresAt?: number; email?: string };
}
interface Session { revision: string; token: string; until: number; expiresAt?: number }
interface QuotaCache { version: 1; revision: string; usage: SubscriptionUsage }
type NativeReader = Pick<JetBrainsIdeImporter, 'listCandidates' | 'readCredentials'> & { renewCredentials?: (source: { product: JetBrainsIdeCredentials['product']; accountId: string; licenseId: string; sourceIdentity: string }) => Promise<JetBrainsIdeCredentials> };
export class JetBrainsIdeAccountError extends Error {}
const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Imports a selected IDE snapshot into ModelDock's encrypted metadata. It
 * never exports the JBA or Grazie tokens as a provider API key. */
export class JetBrainsIdeAccounts {
  private readonly sessions = new Map<string, Session>();
  private readonly exchanging = new Map<string, { revision: string; promise: Promise<Session> }>();
  private readonly querying = new Map<string, { revision: string; promise: Promise<AuthAccount> }>();
  private importing = false;
  private running?: { providerId: string; revision: string; key: string };
  constructor(private readonly store: NativeStore, private readonly reader: NativeReader, private readonly api: JetBrainsIdeApiPort, private readonly relay: JetBrainsIdeRelay,
    private readonly localKey: () => string, private readonly safeMessage: (error: unknown) => string | undefined = () => undefined, private readonly now = Date.now) {}
  private error(error: unknown, fallback = 'JetBrains IDE 授权暂不可用，请在 IDE 检查账号与 AI 许可证后重试。'): JetBrainsIdeAccountError {
    return error instanceof JetBrainsIdeAccountError ? error : new JetBrainsIdeAccountError(this.safeMessage(error) ?? fallback);
  }
  isIdeProvider(id: string): boolean {
    try { const value = this.store.getManagedState<Partial<NativeMetadata> | null>(`auth-metadata:${id}`, null); return value?.clientImport?.client === 'jetbrains-ide'; }
    catch { throw new JetBrainsIdeAccountError('无法读取已保存的 JetBrains 授权，请检查本机存储后重试。'); }
  }
  private metadata(id: string): { provider: Provider; key: string; metadata: NativeMetadata; auth: NonNullable<NativeMetadata['nativeIde']> } {
    let provider: Provider | undefined, metadata: NativeMetadata | null, key: string | undefined;
    try { provider = this.store.getProvider(id); metadata = this.store.getManagedState<NativeMetadata | null>(`auth-metadata:${id}`, null); key = this.store.getSecret(id)?.apiKey; }
    catch { throw new JetBrainsIdeAccountError('无法读取本机保存的 JetBrains 授权，请检查存储后重试。'); }
    const auth = metadata?.nativeIde;
    const validToken = auth?.tokenType === 'jcp-global-access-token' ? !!text(auth.accessToken, 32768) && !/\s/.test(auth.accessToken!) && !auth.idToken : typeof auth?.idToken === 'string' && auth.idToken.length <= 32768 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth.idToken) && !auth.accessToken;
    if (!provider || provider.presetId !== 'jetbrains-central' || provider.kind !== 'openai-compatible' || provider.baseUrl !== JETBRAINS_RELAY_BASE_URL || provider.claudeBaseUrl || provider.messagesAuth !== 'bearer' || !key || metadata?.version !== 1 || metadata.clientImport?.client !== 'jetbrains-ide' || !text(metadata.revision) || metadata.connection !== relayConnectionFingerprint(provider, key) || !auth || !text(auth.accountId) || !text(auth.accountLabel) || !text(auth.licenseId, 256) || !text(auth.sourceIdentity) || !['rider', 'intellij-idea', 'webstorm', 'pycharm'].includes(auth.product) || ![undefined, 'jba-id-token', 'jcp-global-access-token'].includes(auth.tokenType) || !validToken) throw new JetBrainsIdeAccountError('已保存的 JetBrains IDE 授权或连接已变更，请重新从 IDE 导入。');
    if (auth.tokenType === 'jcp-global-access-token' && auth.expiresAt !== undefined && (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= this.now()) && !this.reader.renewCredentials) throw new JetBrainsIdeAccountError('JetBrains 本机账号服务的访问授权已到期，请重新导入。');
    return { provider, key, metadata, auth };
  }
  async preview(): Promise<RelayClientImportPreview> {
    try {
      const candidates = await this.reader.listCandidates();
      return { kind: 'jetbrains-central', candidates: candidates.map(({ id, clientName, accountLabel }) => ({ id, clientName, accountLabel })), message: candidates.length ? '请选择已登录的 IDE 及其已选择的 AI 许可证。' : '未找到可导入的 IDE 账号与 AI 许可证，请在 IDE 登录并选择 AI 许可证后重试。' };
    } catch (error) { throw this.error(error); }
  }
  async import(id: string): Promise<AuthAccount> {
    if (this.importing) throw new JetBrainsIdeAccountError('JetBrains IDE 账号正在导入，请等待当前操作完成。');
    this.importing = true;
    try {
      const credentials = await this.reader.readCredentials(id), key = this.localKey();
      const matching = this.store.listProviders().filter(provider => provider.kind === 'openai-compatible' && provider.presetId === 'jetbrains-central' && provider.baseUrl === JETBRAINS_RELAY_BASE_URL && !provider.claudeBaseUrl && provider.messagesAuth === 'bearer' && (!provider.hasSecret || this.store.getSecret(provider.id)?.apiKey === key));
      if (matching.length > 1) throw new JetBrainsIdeAccountError('已有多个使用此本机入口的 JetBrains 连接，请先在供应商中整理后再导入。');
      const target = matching[0], expected = target ? { provider: target, apiKey: this.store.getSecret(target.id)?.apiKey } : undefined;
      const nativeIde = this.snapshot(credentials);
      const session = await this.exchange(nativeIde, false);
      const [usage] = await Promise.all([this.api.quota(session.token), this.api.models(session.token)]);
      let name = target?.name ?? 'JetBrains AI · IDE 导入'; const base = name; let suffix = 2;
      while (!target && this.store.listProviders().some(provider => provider.name.toLowerCase() === name.toLowerCase())) name = `${base} ${suffix++}`;
      const input: ProviderInput = { ...target, ...(target ? { id: target.id } : {}), name, enabled: target?.enabled ?? true, note: target?.note ?? '', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, messagesAuth: 'bearer', claudeBaseUrl: '', apiKey: key };
      const metadata: NativeMetadata = { version: 1, revision: randomUUID(), connection: relayConnectionFingerprint(input, key), identity: hash([credentials.accountId, credentials.sourceIdentity]), clientImport: { client: 'jetbrains-ide', accountLabel: credentials.accountLabel, importedAt: new Date(this.now()).toISOString(), upstreamVerified: true }, nativeIde, initialUsage: usage };
      let provider: Provider;
      try { provider = await this.store.saveRelayClientImport(input, metadata, expected); }
      catch { throw new JetBrainsIdeAccountError('JetBrains 授权已校验，但本地记录未能保存，原供应商保持不变，请重新导入。'); }
      this.sessions.set(provider.id, { revision: metadata.revision, token: session.token, until: Math.min(session.expiresAt ?? this.now() + 60_000, this.now() + 10 * 60_000), ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}) });
      return this.decorate(relayAccountView(this.store, provider));
    } catch (error) { throw this.error(error); }
    finally { this.importing = false; }
  }
  decorate(account: AuthAccount): AuthAccount {
    if (account.kind !== 'jetbrains-central' || !this.isIdeProvider(account.providerId)) return account;
    try {
      const { auth, metadata } = this.metadata(account.providerId), cached = this.store.getManagedState<QuotaCache | null>(`auth-usage:${account.providerId}`, null);
      const usage = structuredClone(cached?.version === 1 && cached.revision === metadata.revision ? cached.usage : metadata.initialUsage ?? { status: 'not-queried' as const, windows: [], message: '尚未查询此 IDE 账号的官方 AI 额度。' });
      if (usage.status === 'ready' && quotaCacheExpired(usage, this.now())) { usage.status = 'stale'; usage.message = '显示此 IDE 账号上次的官方额度，请刷新确认。'; }
      // A JBA identity assertion's historical exp is not the expiry of the
      // service access token. Only native verify/v3 supplies that authority.
      const expiry = this.sessions.get(account.providerId)?.expiresAt;
      return { ...account, accountId: auth.accountId, displayName: auth.accountLabel, ...(auth.email ? { email: auth.email } : {}), ...(expiry !== undefined ? { expiresAt: expiry } : {}), authStatus: 'ready', canRefresh: auth.tokenType !== 'jcp-global-access-token' || !!this.reader.renewCredentials, canQueryUsage: true, usage };
    } catch (error) { return { ...account, authStatus: 'expired', canQueryUsage: false, usage: { status: 'unavailable', windows: [], message: this.error(error).message } }; }
  }
  private snapshot(credentials: JetBrainsIdeCredentials): NonNullable<NativeMetadata['nativeIde']> {
    const value = credentials as JetBrainsIdeCredentials & { accessToken?: string; idToken?: string; sourceTokenExpHint?: number; expiresAt?: number };
    return { ...(value.accessToken ? { tokenType: 'jcp-global-access-token' as const, accessToken: value.accessToken } : { tokenType: 'jba-id-token' as const, idToken: value.idToken }), accountId: value.accountId, accountLabel: value.accountLabel, licenseId: value.licenseId, product: value.product, sourceIdentity: value.sourceIdentity,
      ...(value.accessToken && value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}), ...(!value.accessToken && (value.sourceTokenExpHint ?? value.expiresAt) !== undefined ? { sourceTokenExpHint: value.sourceTokenExpHint ?? value.expiresAt } : {}), ...(text(value.email) ? { email: value.email } : {}) };
  }
  private async exchange(auth: NonNullable<NativeMetadata['nativeIde']>, renew: boolean): Promise<{ token: string; expiresAt?: number }> {
    if (auth.tokenType === 'jcp-global-access-token') {
      if (!this.api.exchangeJcp) throw new JetBrainsIdeAccountError('此版本尚未接入 JetBrains 本机账号服务，请更新后重试。');
      const fresh = renew && this.reader.renewCredentials ? this.snapshot(await this.reader.renewCredentials({ product: auth.product as JetBrainsIdeCredentials['product'], accountId: auth.accountId, licenseId: auth.licenseId, sourceIdentity: auth.sourceIdentity })) : auth;
      if (fresh.tokenType !== 'jcp-global-access-token' || fresh.accountId !== auth.accountId || fresh.licenseId !== auth.licenseId || fresh.sourceIdentity !== auth.sourceIdentity || !fresh.accessToken) throw new JetBrainsIdeAccountError('本机 JetBrains 账号或许可证已切换，请重新选择并导入。');
      return this.api.exchangeJcp({ accessToken: fresh.accessToken, licenseId: auth.licenseId });
    }
    return this.api.exchange({ idToken: auth.idToken!, licenseId: auth.licenseId });
  }
  private session(id: string): Promise<Session> {
    const context = this.metadata(id), cached = this.sessions.get(id);
    if (cached?.revision === context.metadata.revision && cached.until > this.now() + 30_000) return Promise.resolve(cached);
    const pending = this.exchanging.get(id); if (pending?.revision === context.metadata.revision) return pending.promise;
    const promise = this.exchange(context.auth, true).then(value => {
      if (this.metadata(id).metadata.revision !== context.metadata.revision) throw new JetBrainsIdeAccountError('JetBrains 账号在授权期间已变更，请重试。');
      const session = { token: value.token, revision: context.metadata.revision, until: Math.min(value.expiresAt ?? this.now() + 60_000, this.now() + 10 * 60_000), ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}) }; this.sessions.set(id, session); return session;
    }).catch(error => { this.sessions.delete(id); throw this.error(error); });
    this.exchanging.set(id, { revision: context.metadata.revision, promise });
    void promise.finally(() => { if (this.exchanging.get(id)?.promise === promise) this.exchanging.delete(id); }).catch(() => {}); return promise;
  }
  refreshUsage(id: string): Promise<AuthAccount> {
    const revision = this.metadata(id).metadata.revision, pending = this.querying.get(id); if (pending?.revision === revision) return pending.promise;
    const promise = (async () => {
      let usage: SubscriptionUsage;
      try { usage = await this.api.quota((await this.session(id)).token); }
      catch (error) { this.sessions.delete(id); usage = { status: 'unavailable', windows: [], queriedAt: new Date(this.now()).toISOString(), message: this.error(error).message }; }
      if (this.metadata(id).metadata.revision !== revision) throw new JetBrainsIdeAccountError('JetBrains 账号在查询期间已变更，未保存旧账号额度。');
      try { this.store.setManagedState(`auth-usage:${id}`, { version: 1, revision, usage } satisfies QuotaCache); }
      catch { throw new JetBrainsIdeAccountError('JetBrains 额度已查询，但本地缓存未能保存，请重试。'); }
      return this.decorate(relayAccountView(this.store, this.metadata(id).provider));
    })();
    this.querying.set(id, { revision, promise }); void promise.finally(() => { if (this.querying.get(id)?.promise === promise) this.querying.delete(id); }).catch(() => {}); return promise;
  }
  async startRelay(id: string): Promise<void> {
    const { key, metadata } = this.metadata(id), owner = `${id}:${metadata.revision}`;
    if (this.relay.isRunning(key, owner)) return;
    await this.session(id);
    if (this.running) { await this.relay.stop(); this.running = undefined; }
    const wrap = async <T,>(action: () => Promise<T>): Promise<T> => { try { return await action(); } catch (error) { throw new JetBrainsIdeRelayFailure(this.error(error).message); } };
    await this.relay.start(key, owner, { models: signal => wrap(async () => this.api.models((await this.session(id)).token, signal)), chat: (body, signal) => wrap(async () => this.api.chat((await this.session(id)).token, body, signal)) });
    this.running = { providerId: id, key, revision: metadata.revision };
  }
  async stopRelay(): Promise<void> { await this.relay.stop(); this.running = undefined; }
  async providerRemoved(id: string): Promise<void> { this.sessions.delete(id); if (this.running?.providerId === id) await this.stopRelay(); }
  async dispose(): Promise<void> { this.sessions.clear(); await this.stopRelay(); }
}
