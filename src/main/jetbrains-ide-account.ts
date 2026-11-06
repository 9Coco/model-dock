import { SUBSCRIPTION_NAMES } from '../shared/subscription-names';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthAccount, JetBrainsIdeImportResult, RelayClientImportPreview, RelayClientImportProvenance, SubscriptionUsage } from '../shared/auth-types';
import { JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import { quotaCacheExpired } from '../shared/quota-display';
import type { Provider, ProviderInput } from '../shared/types';
import type { Store } from './store';
import type { JetBrainsIdeCredentials, JetBrainsIdeImportCandidate, JetBrainsIdeImporter } from './jetbrains-ide-import';
import type { JetBrainsIdeRelay } from './jetbrains-ide-relay';
import type { JetBrainsIdeLicense } from './jetbrains-ide-api';
import { relayAccountView, relayConnectionFingerprint } from './relay-client-import';

export interface JetBrainsIdeApiPort {
  exchange(credentials: { idToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }>;
  exchangeJcp?(credentials: { accessToken: string; licenseId: string }, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }>;
  licenses?(credentials: { idToken?: string; accessToken?: string; tokenType?: 'jba-id-token' | 'jcp-global-access-token'; accountId: string; sourceLicenseId?: string }, signal?: AbortSignal): Promise<JetBrainsIdeLicense[]>;
  quota(token: string, signal?: AbortSignal): Promise<SubscriptionUsage>;
  models(token: string, signal?: AbortSignal): Promise<{ data: { id: string; object: 'model' }[] }>;
  chat(token: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}
type NativeStore = Pick<Store, 'listProviders' | 'getProvider' | 'getSecret' | 'getManagedState' | 'setManagedState' | 'saveRelayClientImport'>;
interface NativeMetadata {
  version: 1; connection: string; identity: string; revision: string; clientImport: RelayClientImportProvenance;
  initialUsage?: SubscriptionUsage;
  license?: JetBrainsIdeLicense & { verifiedAt: string };
  nativeIde?: { tokenType?: 'jba-id-token' | 'jcp-global-access-token'; idToken?: string; accessToken?: string; accountId: string; accountLabel: string; licenseId: string; sourceLicenseId?: string; sourceIdentity: string; product: string; sourceTokenExpHint?: number; expiresAt?: number; email?: string };
}
interface Session { revision: string; token: string; until: number; expiresAt?: number }
interface Exchange { revision: string; epoch: number; controller: AbortController; waiters: number; settled: boolean; promise: Promise<Session> }
interface QuotaCache { version: 1; revision: string; usage: SubscriptionUsage; license?: (JetBrainsIdeLicense & { verifiedAt: string }) | null }
interface ImportOperation { controller: AbortController; providerId?: string }
type NativeReader = Pick<JetBrainsIdeImporter, 'listCandidates' | 'readCredentials'> & { renewCredentials?: (source: { product: JetBrainsIdeCredentials['product']; accountId: string; licenseId: string; sourceIdentity: string }) => Promise<JetBrainsIdeCredentials> };
export class JetBrainsIdeAccountError extends Error {}
const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PRODUCT_PRIORITY = ['intellij-idea', 'webstorm', 'rider', 'pycharm'] as const;

/** Imports a selected IDE snapshot into ModelDock's encrypted metadata. It
 * never exports the JBA or Grazie tokens as a provider API key. */
export class JetBrainsIdeAccounts {
  private readonly sessions = new Map<string, Session>();
  private readonly exchanging = new Map<string, Exchange>();
  private readonly querying = new Map<string, { revision: string; epoch: number; controller: AbortController; promise: Promise<AuthAccount> }>();
  private readonly epochs = new Map<string, number>();
  private readonly sourceChoices = new Map<string, { candidate: JetBrainsIdeImportCandidate; until: number }>();
  private closed = false;
  private importing = false;
  private importOperation?: ImportOperation;
  constructor(private readonly store: NativeStore, private readonly reader: NativeReader, private readonly api: JetBrainsIdeApiPort, _legacyRelay: JetBrainsIdeRelay | undefined,
    private readonly localKey: () => string, private readonly safeMessage: (error: unknown) => string | undefined = () => undefined, private readonly now = Date.now) {}
  private error(error: unknown, fallback = 'JetBrains IDE 授权暂不可用，请在 IDE 检查账号与 AI 许可证后重试。'): JetBrainsIdeAccountError {
    return error instanceof JetBrainsIdeAccountError ? error : new JetBrainsIdeAccountError(this.safeMessage(error) ?? fallback);
  }
  private assertActive(signal?: AbortSignal): void {
    if (this.closed) throw new JetBrainsIdeAccountError('JetBrains IDE 账号服务已停止。');
    if (signal?.aborted) throw new JetBrainsIdeAccountError('JetBrains 请求已取消。');
  }
  private epoch(id: string): number { return this.epochs.get(id) ?? 0; }
  private assertEpoch(id: string, epoch: number, signal?: AbortSignal): void { this.assertActive(signal); if (this.epoch(id) !== epoch) throw new JetBrainsIdeAccountError('JetBrains 账号在操作期间已变更，请重试。'); }
  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (action: () => void) => { if (done) return; done = true; signal.removeEventListener('abort', abort); action(); };
      const abort = () => finish(() => reject(new JetBrainsIdeAccountError('JetBrains 请求已取消。')));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal.aborted) abort();
    });
  }
  isIdeProvider(id: string): boolean {
    try { const value = this.store.getManagedState<Partial<NativeMetadata> | null>(`auth-metadata:${id}`, null); return value?.clientImport?.client === 'jetbrains-ide'; }
    catch { throw new JetBrainsIdeAccountError('无法读取已保存的 JetBrains 授权，请检查本机存储后重试。'); }
  }
  isNativeProvider(id: string): boolean { return this.store.getProvider(id)?.presetId === 'jetbrains-central' && this.isIdeProvider(id); }
  /** Main-process only. Credentials are dispatched through the existing
   * authenticated gateway; no independently bound relay is required. */
  async credentials(id: string, signal?: AbortSignal): Promise<{ token: string; expiresAt?: number }> {
    this.assertActive(signal);
    const revision = this.metadata(id).metadata.revision;
    const value = await this.session(id, signal);
    this.assertActive(signal);
    if (this.metadata(id).metadata.revision !== revision) throw new JetBrainsIdeAccountError('JetBrains 账号在授权期间已变更，请重试。');
    return { token: value.token, ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}) };
  }
  private metadata(id: string): { provider: Provider; key: string; metadata: NativeMetadata; auth: NonNullable<NativeMetadata['nativeIde']> } {
    this.assertActive();
    let provider: Provider | undefined, metadata: NativeMetadata | null, key: string | undefined;
    try { provider = this.store.getProvider(id); metadata = this.store.getManagedState<NativeMetadata | null>(`auth-metadata:${id}`, null); key = this.store.getSecret(id)?.apiKey; }
    catch { throw new JetBrainsIdeAccountError('无法读取本机保存的 JetBrains 授权，请检查存储后重试。'); }
    const auth = metadata?.nativeIde;
    if (auth?.sourceLicenseId !== undefined && !text(auth.sourceLicenseId, 256)) throw new JetBrainsIdeAccountError('已保存的 JetBrains 本机许可证来源无效，请重新导入。');
    const validToken = auth?.tokenType === 'jcp-global-access-token' ? !!text(auth.accessToken, 32768) && !/\s/.test(auth.accessToken!) && !auth.idToken : typeof auth?.idToken === 'string' && auth.idToken.length <= 32768 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth.idToken) && !auth.accessToken;
    if (!provider || provider.presetId !== 'jetbrains-central' || provider.kind !== 'openai-compatible' || provider.baseUrl !== JETBRAINS_RELAY_BASE_URL || provider.claudeBaseUrl || provider.messagesAuth !== 'bearer' || !key || metadata?.version !== 1 || metadata.clientImport?.client !== 'jetbrains-ide' || !text(metadata.revision) || metadata.connection !== relayConnectionFingerprint(provider, key) || !auth || !text(auth.accountId) || !text(auth.accountLabel) || !text(auth.licenseId, 256) || !text(auth.sourceIdentity) || !['rider', 'intellij-idea', 'webstorm', 'pycharm'].includes(auth.product) || ![undefined, 'jba-id-token', 'jcp-global-access-token'].includes(auth.tokenType) || !validToken) throw new JetBrainsIdeAccountError('已保存的 JetBrains IDE 授权或连接已变更，请重新从 IDE 导入。');
    if (auth.tokenType === 'jcp-global-access-token' && auth.expiresAt !== undefined && (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= this.now()) && !this.reader.renewCredentials) throw new JetBrainsIdeAccountError('JetBrains 本机账号服务的访问授权已到期，请重新导入。');
    return { provider, key, metadata, auth };
  }
  async preview(): Promise<RelayClientImportPreview> {
    this.assertActive();
    try {
      const candidates = await this.reader.listCandidates();
      this.assertActive();
      return this.previewCandidates(candidates);
    } catch (error) { throw this.error(error); }
  }
  private previewCandidates(candidates: JetBrainsIdeImportCandidate[]): RelayClientImportPreview {
    this.sourceChoices.clear();
    for (const candidate of candidates.slice(0, 32)) this.sourceChoices.set(candidate.id, { candidate: { ...candidate }, until: this.now() + 5 * 60_000 });
    return { kind: 'jetbrains-central', candidates: candidates.map(({ id, clientName, accountLabel }) => ({ id, clientName, accountLabel })), message: candidates.length ? '请选择已登录的 IDE 及其已选择的 AI 许可证。' : '未找到可导入的 IDE 账号与 AI 许可证，请在 IDE 登录并选择 AI 许可证后重试。' };
  }
  private async runImport<T>(action: (operation: ImportOperation) => Promise<T>): Promise<T> {
    this.assertActive();
    if (this.importing) throw new JetBrainsIdeAccountError('JetBrains IDE 账号正在导入，请等待当前操作完成。');
    this.importing = true;
    const operation: ImportOperation = { controller: new AbortController() }; this.importOperation = operation;
    try { return await action(operation); }
    catch (error) { throw this.error(error); }
    finally { operation.controller.abort(); if (this.importOperation === operation) this.importOperation = undefined; this.importing = false; }
  }
  private canonicalChoice(candidate: JetBrainsIdeImportCandidate): string | undefined {
    return text(candidate.accountId) && typeof candidate.accountLicenseIdentity === 'string' && /^[a-f0-9]{64}$/.test(candidate.accountLicenseIdentity)
      ? JSON.stringify([candidate.accountId, candidate.accountLicenseIdentity]) : undefined;
  }
  private representative(candidates: JetBrainsIdeImportCandidate[], preferSaved: boolean): JetBrainsIdeImportCandidate {
    const preferred = new Set<string>();
    if (preferSaved) for (const provider of this.store.listProviders()) {
      if (provider.presetId !== 'jetbrains-central') continue;
      const metadata = this.store.getManagedState<NativeMetadata | null>(`auth-metadata:${provider.id}`, null), auth = metadata?.nativeIde;
      if (metadata?.clientImport?.client !== 'jetbrains-ide' || !auth) continue;
      for (const candidate of candidates) if (candidate.accountId === auth.accountId && candidate.product === auth.product && candidate.sourceIdentity === auth.sourceIdentity
        && candidate.accountLicenseIdentity === hash([auth.accountId, auth.sourceLicenseId ?? auth.licenseId])) preferred.add(candidate.id);
    }
    return [...candidates].sort((left, right) => Number(preferred.has(right.id)) - Number(preferred.has(left.id))
      || PRODUCT_PRIORITY.indexOf(left.product) - PRODUCT_PRIORITY.indexOf(right.product) || left.id.localeCompare(right.id))[0];
  }
  async importDefault(candidateId?: string): Promise<JetBrainsIdeImportResult> {
    return this.runImport(async operation => {
      if (candidateId !== undefined) {
        const chosen = text(candidateId, 256) ? this.sourceChoices.get(candidateId) : undefined;
        if (!chosen || chosen.until <= this.now()) throw new JetBrainsIdeAccountError('JetBrains 账号来源选择已过期，请关闭后重新选择。');
        return this.importAll(chosen.candidate, operation);
      }
      const candidates = await this.abortable(this.reader.listCandidates(), operation.controller.signal);
      this.assertActive(operation.controller.signal);
      if (!candidates.length) throw new JetBrainsIdeAccountError(this.previewCandidates([]).message);
      if (candidates.length > 32) throw new JetBrainsIdeAccountError('本机 JetBrains 来源过多，请先整理 IDE 中的账号与许可证。');
      const groups = new Map<string, JetBrainsIdeImportCandidate[]>();
      let incompleteIdentity = false;
      for (const candidate of candidates) {
        const canonical = this.canonicalChoice(candidate);
        if (!canonical) incompleteIdentity = true;
        // Missing identity never establishes equivalence with another source.
        const key = canonical ? this.api.licenses ? candidate.accountId : canonical : `unverified:${groups.size}`;
        const group = groups.get(key) ?? []; group.push(candidate); groups.set(key, group);
      }
      const requiresSelection = candidates.some(candidate => candidate.defaultRequiresSelection);
      if (requiresSelection || candidates.length > 1 && (incompleteIdentity || groups.size !== 1)) {
        const choices = [...groups.values()].map(group => this.representative(group, false));
        const preview = this.previewCandidates(choices);
        if (requiresSelection) preview.message = '部分 IDE 当前选择的访问来源无法确认或暂不支持，请明确选择要导入的已支持 IDE 账号与个人 AI 许可证。';
        return { status: 'selection-required', preview };
      }
      const selected = candidates.length === 1 ? candidates[0] : this.representative(candidates, true);
      return this.importAll(selected, operation);
    });
  }
  private assertSource(source: JetBrainsIdeCredentials, selected: JetBrainsIdeImportCandidate): void {
    if (source.accountId !== selected.accountId || source.product !== selected.product || source.sourceIdentity !== selected.sourceIdentity
      || this.canonicalChoice(selected) && selected.accountLicenseIdentity !== hash([source.accountId, source.licenseId])) throw new JetBrainsIdeAccountError('JetBrains IDE 当前账号或 AI 许可证已切换，请重新导入。');
  }
  private sameSource(left: JetBrainsIdeCredentials, right: JetBrainsIdeCredentials): boolean {
    return left.accountId === right.accountId && left.licenseId === right.licenseId && left.product === right.product && left.sourceIdentity === right.sourceIdentity;
  }
  private async catalog(auth: NonNullable<NativeMetadata['nativeIde']>, signal: AbortSignal): Promise<NonNullable<NativeMetadata['license']>[]> {
    let source = auth;
    if (auth.tokenType === 'jcp-global-access-token' && auth.expiresAt !== undefined && auth.expiresAt <= this.now() + 30_000 && this.reader.renewCredentials) {
      const sourceLicenseId = auth.sourceLicenseId ?? auth.licenseId;
      const fresh = this.snapshot(await this.abortable(this.reader.renewCredentials({ product: auth.product as JetBrainsIdeCredentials['product'], accountId: auth.accountId, licenseId: sourceLicenseId, sourceIdentity: auth.sourceIdentity }), signal));
      if (fresh.tokenType !== auth.tokenType || fresh.accountId !== auth.accountId || fresh.licenseId !== sourceLicenseId || fresh.product !== auth.product || fresh.sourceIdentity !== auth.sourceIdentity) throw new JetBrainsIdeAccountError('本机 JetBrains 账号或许可证来源已切换，未读取其他账号目录。');
      source = fresh;
    }
    const rows = await this.abortable(this.api.licenses!({ accountId: source.accountId, sourceLicenseId: source.sourceLicenseId ?? source.licenseId, tokenType: source.tokenType ?? 'jba-id-token', ...(source.accessToken ? { accessToken: source.accessToken } : { idToken: source.idToken }) }, signal), signal);
    this.assertActive(signal);
    if (!Array.isArray(rows) || rows.length > 128) throw new JetBrainsIdeAccountError('官方 AI 许可证目录超出支持范围，未截取或猜测许可证。');
    const seen = new Set<string>(), verifiedAt = new Date(this.now()).toISOString();
    return rows.map(row => {
      if (!row || !text(row.id, 256) || !text(row.plan) || seen.has(row.id) || row.expiresAt !== undefined && !Number.isFinite(Date.parse(row.expiresAt))) throw new JetBrainsIdeAccountError('官方 AI 许可证目录存在无法确认的信息，请稍后重试。');
      if (row.verifiedAt !== undefined && !Number.isFinite(Date.parse(row.verifiedAt))) throw new JetBrainsIdeAccountError('官方 AI 许可证核验时间无法确认，请稍后重试。');
      seen.add(row.id); return { id: row.id, plan: row.plan, ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}), verifiedAt: row.verifiedAt ?? verifiedAt };
    });
  }
  private async importAll(selected: JetBrainsIdeImportCandidate, operation: ImportOperation): Promise<JetBrainsIdeImportResult> {
    if (!this.api.licenses) return { status: 'imported', account: await this.importSelected(selected.id, operation, selected) };
    const signal = operation.controller.signal, source = await this.abortable(this.reader.readCredentials(selected.id), signal);
    this.assertActive(signal); this.assertSource(source, selected);
    const licenses = await this.catalog(this.snapshot(source), signal);
    if (!licenses.length) throw new JetBrainsIdeAccountError('此账号没有可导入的个人 AI 许可证。未激活试用，也未切换到其他账号或工作区。');
    if (!licenses.some(license => license.id === source.licenseId)) throw new JetBrainsIdeAccountError('IDE 已选许可证不在此账号可用的个人 AI 许可证目录中，未改用其他许可证。');
    const existing = new Set<string>();
    for (const provider of this.store.listProviders()) {
      if (provider.presetId !== 'jetbrains-central') continue;
      const metadata = this.store.getManagedState<NativeMetadata | null>(`auth-metadata:${provider.id}`, null);
      if (metadata?.clientImport?.client === 'jetbrains-ide' && metadata.nativeIde?.accountId === source.accountId) existing.add(metadata.nativeIde.licenseId);
    }
    const priority = (license: JetBrainsIdeLicense) => Number(existing.has(license.id)) * 2 + Number(license.id === source.licenseId);
    licenses.sort((left, right) => priority(right) - priority(left));
    const accounts: AuthAccount[] = [], failures: { label: string; message: string }[] = [];
    for (const license of licenses) {
      this.assertActive(signal);
      try {
        const current = await this.abortable(this.reader.readCredentials(selected.id), signal);
        if (!this.sameSource(current, source)) throw new JetBrainsIdeAccountError('JetBrains IDE 当前账号或许可证来源已切换，未继续导入。');
        accounts.push(await this.saveLicense(selected.id, source, operation, license));
      } catch (error) {
        this.assertActive(signal);
        failures.push({ label: license.plan + ' · ' + this.licenseLabel(source.accountId, license.id), message: this.error(error).message });
      }
    }
    if (!accounts.length) throw new JetBrainsIdeAccountError(failures[0]?.message ?? '未能导入此账号的个人 AI 许可证。');
    return { status: 'imported', account: accounts[0], accounts, ...(failures.length ? { failures } : {}) };
  }
  private licenseLabel(accountId: string, licenseId: string): string {
    const suffix = hash([accountId, licenseId]);
    return licenseId.length >= 8 ? '许可证 ••••' + licenseId.slice(-4) + ' · ' + suffix.slice(0, 4) : '许可证 ' + suffix.slice(0, 8);
  }
  async import(id: string): Promise<AuthAccount> {
    return this.runImport(operation => this.importSelected(id, operation));
  }
  private importTarget(credentials: Pick<JetBrainsIdeCredentials, 'accountId' | 'licenseId'>, key: string): Provider | undefined {
    const related = this.store.listProviders().filter(provider => provider.presetId === 'jetbrains-central');
    const matching = related.filter(provider => provider.kind === 'openai-compatible' && provider.baseUrl === JETBRAINS_RELAY_BASE_URL && !provider.claudeBaseUrl && provider.messagesAuth === 'bearer' && (!provider.hasSecret || this.store.getSecret(provider.id)?.apiKey === key));
    const exact = matching.filter(provider => {
      const stored = this.store.getManagedState<NativeMetadata | null>(`auth-metadata:${provider.id}`, null);
      return stored?.clientImport?.client === 'jetbrains-ide' && stored.nativeIde?.accountId === credentials.accountId && stored.nativeIde.licenseId === credentials.licenseId
        && stored.connection === relayConnectionFingerprint(provider, this.store.getSecret(provider.id)?.apiKey);
    });
    if (exact.length > 1) throw new JetBrainsIdeAccountError('同一账号与 AI 许可证对应多个来源，请先整理重复来源后重新导入。');
    if (exact.length) return exact[0];
    // A shared local URL/key does not identify an account or a license. Never
    // rebind an existing IDE/Central account when another license is imported.
    const hasAccount = related.some(provider => provider.hasSecret || this.store.getManagedState(`auth-metadata:${provider.id}`, null) !== null);
    const empty = hasAccount ? [] : matching.filter(provider => !provider.hasSecret && this.store.getManagedState(`auth-metadata:${provider.id}`, null) === null);
    return empty.length === 1 ? empty[0] : undefined;
  }
  private async importSelected(id: string, operation: ImportOperation, selected?: JetBrainsIdeImportCandidate): Promise<AuthAccount> {
    const signal = operation.controller.signal;
    const credentials = await this.abortable(this.reader.readCredentials(id), signal); this.assertActive(signal);
    if (selected) this.assertSource(credentials, selected);
    const licenses = this.api.licenses ? await this.catalog(this.snapshot(credentials), signal) : undefined;
    const license = licenses?.find(value => value.id === credentials.licenseId);
    if (licenses && !license) throw new JetBrainsIdeAccountError('IDE 已选许可证不在此账号可用的个人 AI 许可证目录中，未改用其他许可证。');
    return this.saveLicense(id, credentials, operation, license);
  }
  private async saveLicense(id: string, source: JetBrainsIdeCredentials, operation: ImportOperation, license?: NonNullable<NativeMetadata['license']>): Promise<AuthAccount> {
    const signal = operation.controller.signal;
    const credentials = license ? { ...source, licenseId: license.id } : source;
    const key = this.localKey();
    const target = this.importTarget(credentials, key), expected = target ? { provider: target, apiKey: this.store.getSecret(target.id)?.apiKey } : undefined;
    operation.providerId = target?.id; const epoch = target ? this.epoch(target.id) : 0;
    const nativeIde = { ...this.snapshot(credentials), ...(license ? { sourceLicenseId: source.licenseId } : {}) };
    const session = await this.exchange(nativeIde, false, signal);
    const [usage] = await this.abortable(Promise.all([this.api.quota(session.token, signal), this.api.models(session.token, signal)]), signal);
    this.assertActive(signal); if (target) this.assertEpoch(target.id, epoch, signal);
    const latest = await this.abortable(this.reader.readCredentials(id), signal);
    this.assertActive(signal); if (target) this.assertEpoch(target.id, epoch, signal);
    if (!this.sameSource(latest, source)) throw new JetBrainsIdeAccountError('JetBrains IDE 当前账号或 AI 许可证在授权期间已切换，未保存，请重新导入。');
    let name = target?.name ?? SUBSCRIPTION_NAMES['jetbrains-central']; const base = name; let suffix = 2;
    while (!target && this.store.listProviders().some(provider => provider.name.toLowerCase() === name.toLowerCase())) name = `${base} ${suffix++}`;
    const input: ProviderInput = { ...target, ...(target ? { id: target.id } : {}), name, enabled: target?.enabled ?? true, note: target?.note ?? '', kind: 'openai-compatible', presetId: 'jetbrains-central', baseUrl: JETBRAINS_RELAY_BASE_URL, messagesAuth: 'bearer', claudeBaseUrl: '', apiKey: key };
    const metadata: NativeMetadata = { version: 1, revision: randomUUID(), connection: relayConnectionFingerprint(input, key), identity: hash([credentials.accountId, credentials.licenseId]), clientImport: { client: 'jetbrains-ide', accountLabel: credentials.accountLabel, importedAt: new Date(this.now()).toISOString(), upstreamVerified: true }, nativeIde, initialUsage: usage, ...(license ? { license } : {}) };
    let provider: Provider;
    try { provider = await this.store.saveRelayClientImport(input, metadata, expected); }
    catch { throw new JetBrainsIdeAccountError('JetBrains 授权已校验，但本地记录未能保存，原供应商保持不变，请重新导入。'); }
    this.assertActive(signal); this.invalidate(provider.id);
    this.sessions.set(provider.id, { revision: metadata.revision, token: session.token, until: Math.min(session.expiresAt ?? this.now() + 60_000, this.now() + 10 * 60_000), ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}) });
    return this.decorate(relayAccountView(this.store, provider));
  }
  decorate(account: AuthAccount): AuthAccount {
    if (account.kind !== 'jetbrains-central' || !this.isIdeProvider(account.providerId)) return account;
    // Quota amounts do not identify a plan. Only an exact account/license
    // catalog receipt supplies names; stale unrelated view labels are removed.
    const { plan: _oldPlan, license: _oldLicense, ...baseAccount } = account;
    try {
      const { auth, metadata } = this.metadata(account.providerId), cached = this.store.getManagedState<QuotaCache | null>(`auth-usage:${account.providerId}`, null);
      const license = cached?.version === 1 && cached.revision === metadata.revision && cached.license !== undefined ? cached.license : metadata.license;
      const verifiedLicense = license?.id === auth.licenseId && text(license.plan) && Number.isFinite(Date.parse(license.verifiedAt)) ? license : undefined;
      const usage = structuredClone(cached?.version === 1 && cached.revision === metadata.revision ? cached.usage : metadata.initialUsage ?? { status: 'not-queried' as const, windows: [], message: '尚未查询此 IDE 账号的官方 AI 额度。' });
      if (usage.status === 'ready' && quotaCacheExpired(usage, this.now())) { usage.status = 'stale'; usage.message = '显示此 IDE 账号上次的官方额度，请刷新确认。'; }
      // A JBA identity assertion's historical exp is not the expiry of the
      // service access token. Only native verify/v3 supplies that authority.
      const expiry = this.sessions.get(account.providerId)?.expiresAt;
      return { ...baseAccount, ...(verifiedLicense ? { plan: verifiedLicense.plan, license: { label: this.licenseLabel(auth.accountId, auth.licenseId), verifiedAt: verifiedLicense.verifiedAt, ...(verifiedLicense.expiresAt ? { expiresAt: verifiedLicense.expiresAt } : {}) } } : {}), accountId: auth.accountId, displayName: auth.accountLabel, ...(auth.email ? { email: auth.email } : {}), ...(expiry !== undefined ? { expiresAt: expiry } : {}), authStatus: 'ready', canRefresh: auth.tokenType !== 'jcp-global-access-token' || !!this.reader.renewCredentials, canQueryUsage: true, usage };
    } catch (error) { return { ...baseAccount, authStatus: 'expired', canQueryUsage: false, usage: { status: 'unavailable', windows: [], message: this.error(error).message } }; }
  }
  private snapshot(credentials: JetBrainsIdeCredentials): NonNullable<NativeMetadata['nativeIde']> {
    const value = credentials as JetBrainsIdeCredentials & { accessToken?: string; idToken?: string; sourceTokenExpHint?: number; expiresAt?: number };
    return { ...(value.accessToken ? { tokenType: 'jcp-global-access-token' as const, accessToken: value.accessToken } : { tokenType: 'jba-id-token' as const, idToken: value.idToken }), accountId: value.accountId, accountLabel: value.accountLabel, licenseId: value.licenseId, product: value.product, sourceIdentity: value.sourceIdentity,
      ...(value.accessToken && value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}), ...(!value.accessToken && (value.sourceTokenExpHint ?? value.expiresAt) !== undefined ? { sourceTokenExpHint: value.sourceTokenExpHint ?? value.expiresAt } : {}), ...(text(value.email) ? { email: value.email } : {}) };
  }
  private async exchange(auth: NonNullable<NativeMetadata['nativeIde']>, renew: boolean, signal: AbortSignal): Promise<{ token: string; expiresAt?: number }> {
    this.assertActive(signal);
    if (auth.tokenType === 'jcp-global-access-token') {
      if (!this.api.exchangeJcp) throw new JetBrainsIdeAccountError('此版本尚未接入 JetBrains 本机账号服务，请更新后重试。');
      const sourceLicenseId = auth.sourceLicenseId ?? auth.licenseId;
      const fresh = renew && this.reader.renewCredentials ? this.snapshot(await this.abortable(this.reader.renewCredentials({ product: auth.product as JetBrainsIdeCredentials['product'], accountId: auth.accountId, licenseId: sourceLicenseId, sourceIdentity: auth.sourceIdentity }), signal)) : auth;
      this.assertActive(signal);
      const expectedSourceLicense = renew && this.reader.renewCredentials ? sourceLicenseId : auth.licenseId;
      if (fresh.tokenType !== 'jcp-global-access-token' || fresh.accountId !== auth.accountId || fresh.licenseId !== expectedSourceLicense || fresh.product !== auth.product || fresh.sourceIdentity !== auth.sourceIdentity || !fresh.accessToken) throw new JetBrainsIdeAccountError('本机 JetBrains 账号或许可证已切换，请重新选择并导入。');
      return this.abortable(this.api.exchangeJcp({ accessToken: fresh.accessToken, licenseId: auth.licenseId }, signal), signal);
    }
    return this.abortable(this.api.exchange({ idToken: auth.idToken!, licenseId: auth.licenseId }, signal), signal);
  }
  private session(id: string, signal?: AbortSignal): Promise<Session> {
    this.assertActive(signal);
    const context = this.metadata(id), cached = this.sessions.get(id);
    if (cached?.revision === context.metadata.revision && cached.until > this.now() + 30_000) return Promise.resolve(cached);
    const epoch = this.epoch(id); let pending = this.exchanging.get(id);
    if (pending && (pending.revision !== context.metadata.revision || pending.epoch !== epoch || pending.controller.signal.aborted)) { pending.controller.abort(); this.exchanging.delete(id); pending = undefined; }
    if (!pending) {
      const state: Exchange = { revision: context.metadata.revision, epoch, controller: new AbortController(), waiters: 0, settled: false, promise: Promise.resolve(undefined as unknown as Session) };
      this.exchanging.set(id, state);
      state.promise = this.exchange(context.auth, true, state.controller.signal).then(value => {
        this.assertEpoch(id, epoch, state.controller.signal);
        if (this.metadata(id).metadata.revision !== context.metadata.revision) throw new JetBrainsIdeAccountError('JetBrains 账号在授权期间已变更，请重试。');
        const session = { token: value.token, revision: context.metadata.revision, until: Math.min(value.expiresAt ?? this.now() + 60_000, this.now() + 10 * 60_000), ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}) }; this.sessions.set(id, session); return session;
      }).catch(error => { if (this.exchanging.get(id) === state) this.sessions.delete(id); throw this.error(error); }).finally(() => { state.settled = true; if (this.exchanging.get(id) === state) this.exchanging.delete(id); });
      void state.promise.catch(() => {}); pending = state;
    }
    const state = pending; state.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (action: () => void) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort); state.controller.signal.removeEventListener('abort', abort); state.waiters--;
        if (state.waiters === 0 && !state.settled) state.controller.abort(); action();
      };
      const abort = () => finish(() => reject(new JetBrainsIdeAccountError('JetBrains 请求已取消。')));
      signal?.addEventListener('abort', abort, { once: true }); state.controller.signal.addEventListener('abort', abort, { once: true });
      state.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal?.aborted || state.controller.signal.aborted) abort();
    });
  }
  refreshUsage(id: string): Promise<AuthAccount> {
    const context = this.metadata(id), revision = context.metadata.revision, epoch = this.epoch(id), pending = this.querying.get(id); if (pending?.revision === revision && pending.epoch === epoch) return pending.promise;
    pending?.controller.abort(); const controller = new AbortController();
    const promise = (async () => {
      let usage: SubscriptionUsage;
      const previous = this.store.getManagedState<QuotaCache | null>(`auth-usage:${id}`, null);
      let license = previous?.version === 1 && previous.revision === revision && previous.license !== undefined ? previous.license : context.metadata.license;
      try {
        const token = (await this.session(id, controller.signal)).token;
        const result = await this.abortable(Promise.all([
          this.api.quota(token, controller.signal),
          this.api.licenses ? this.catalog(context.auth, controller.signal).then(rows => rows.find(row => row.id === context.auth.licenseId) ?? null).catch(() => undefined) : Promise.resolve(undefined),
        ]), controller.signal);
        usage = result[0];
        // A failed catalog keeps the last verified exact-license name and its
        // old verification date. A successful missing match clears that label.
        if (result[1] !== undefined) license = result[1];
      }
      catch (error) { if (this.epoch(id) === epoch) this.sessions.delete(id); usage = { status: 'unavailable', windows: [], queriedAt: new Date(this.now()).toISOString(), message: this.error(error).message }; }
      this.assertEpoch(id, epoch, controller.signal);
      if (this.metadata(id).metadata.revision !== revision) throw new JetBrainsIdeAccountError('JetBrains 账号在查询期间已变更，未保存旧账号额度。');
      try { this.store.setManagedState(`auth-usage:${id}`, { version: 1, revision, usage, ...(license !== undefined ? { license } : {}) } satisfies QuotaCache); }
      catch { throw new JetBrainsIdeAccountError('JetBrains 额度已查询，但本地缓存未能保存，请重试。'); }
      return this.decorate(relayAccountView(this.store, this.metadata(id).provider));
    })();
    this.querying.set(id, { revision, epoch, controller, promise }); void promise.finally(() => { if (this.querying.get(id)?.promise === promise) this.querying.delete(id); }).catch(() => {}); return promise;
  }
  async startRelay(id: string): Promise<void> {
    // Compatibility for old callers: validate authorization without opening
    // an 18081 listener or starting a sidecar process.
    await this.credentials(id);
  }
  async stopRelay(): Promise<void> {}
  private invalidate(id: string): void { this.epochs.set(id, this.epoch(id) + 1); this.sessions.delete(id); this.exchanging.get(id)?.controller.abort(); this.exchanging.delete(id); this.querying.get(id)?.controller.abort(); this.querying.delete(id); }
  async providerRemoved(id: string): Promise<void> { this.invalidate(id); if (this.importOperation?.providerId === id) this.importOperation.controller.abort(); }
  async dispose(): Promise<void> { this.closed = true; this.sourceChoices.clear(); this.importOperation?.controller.abort(); for (const state of this.exchanging.values()) state.controller.abort(); for (const state of this.querying.values()) state.controller.abort(); this.sessions.clear(); this.exchanging.clear(); this.querying.clear(); }
}
