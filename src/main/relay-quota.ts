import type { AuthAccount, SubscriptionUsage } from '../shared/auth-types';
import { quotaCacheExpired } from '../shared/quota-display';
import type { Provider } from '../shared/types';
import type { Store } from './store';
import { createHash } from 'node:crypto';
import { relayAccountView, relayConnectionFingerprint } from './relay-client-import';

export interface RelayQuotaResult { accountId: string; accountLabel?: string; plan?: string; usage: SubscriptionUsage }
export class RelayQuotaFailure extends Error {}
type QuotaStore = Pick<Store, 'getProvider' | 'getSecret' | 'getManagedState' | 'setManagedState'>;
interface CachedRelayQuota extends RelayQuotaResult { version: 1; connection: string }
const label = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;

/** Only the account proven active by the native relay's read-only query is
 * attached to quota. Import provenance never establishes that identity. */
export class RelayQuotaCenter {
  private readonly pending = new Map<string, { connection: string; promise: Promise<AuthAccount> }>();
  constructor(private readonly store: QuotaStore, private readonly queryTrae: (apiKey: string) => Promise<RelayQuotaResult>, private readonly now = Date.now) {}
  private context(providerId: string): { provider: Provider; key: string; connection: string } {
    const provider = this.store.getProvider(providerId);
    if (!provider || !relayAccountView(this.store, provider).canQueryUsage) throw new RelayQuotaFailure('此来源不支持本机托管反代额度查询。');
    const key = this.store.getSecret(providerId)?.apiKey;
    if (!key) throw new RelayQuotaFailure('请先配置本机反代密钥。');
    // A client import may switch the active native account while retaining the
    // same local URL/key. Its transaction revision also invalidates in-flight
    // queries, even if the import and query finish within one millisecond.
    const metadata = this.store.getManagedState<unknown>(`auth-metadata:${providerId}`, null);
    const connection = createHash('sha256').update(JSON.stringify([relayConnectionFingerprint(provider, key), metadata])).digest('hex');
    return { provider, key, connection };
  }
  decorate(account: AuthAccount): AuthAccount {
    if (account.source !== 'relay' || !account.canQueryUsage) return account;
    try {
      const { connection } = this.context(account.providerId);
      const cached = this.store.getManagedState<CachedRelayQuota | null>(`auth-usage:${account.providerId}`, null);
      if (cached?.version === 1 && cached.connection === connection && cached.usage && Array.isArray(cached.usage.windows)) {
        const usage = structuredClone(cached.usage);
        if (usage.status === 'ready' && quotaCacheExpired(usage, this.now())) { usage.status = 'stale'; usage.message = '显示上次查询时的反代活跃账号额度，请刷新确认。'; }
        return { ...account, ...(label(cached.accountId) ? { accountId: cached.accountId } : {}), ...(label(cached.accountLabel) ? { displayName: cached.accountLabel } : {}), ...(label(cached.plan, 80) ? { plan: cached.plan } : {}), usage };
      }
    } catch { /* A damaged cache must not hide the authorization center. */ }
    return { ...account, usage: { status: 'not-queried', windows: [], message: '尚未查询 TRAE 反代当前账号的官方额度。' } };
  }
  refresh(providerId: string): Promise<AuthAccount> {
    let context: ReturnType<RelayQuotaCenter['context']>;
    try { context = this.context(providerId); }
    catch { return Promise.reject(new RelayQuotaFailure('此来源无法查询 TRAE 额度，请检查托管反代和本机密钥。')); }
    const active = this.pending.get(providerId);
    if (active) return active.connection === context.connection ? active.promise : Promise.reject(new RelayQuotaFailure('额度查询期间连接已更改，请稍后重试。'));
    const promise = this.query(providerId, context);
    this.pending.set(providerId, { connection: context.connection, promise });
    void promise.finally(() => { if (this.pending.get(providerId)?.promise === promise) this.pending.delete(providerId); }).catch(() => {});
    return promise;
  }
  private async query(providerId: string, context: ReturnType<RelayQuotaCenter['context']>): Promise<AuthAccount> {
    let result: RelayQuotaResult;
    try {
      const queried = await this.queryTrae(context.key);
      if (!label(queried.accountId) || !queried.usage || !Array.isArray(queried.usage.windows)) throw new Error();
      result = { accountId: queried.accountId, ...(label(queried.accountLabel) ? { accountLabel: queried.accountLabel } : {}), ...(label(queried.plan, 80) ? { plan: queried.plan } : {}), usage: queried.usage };
    } catch (error) {
      // Never attribute an old balance to an account that may have switched.
      result = { accountId: '', usage: { status: 'unavailable', windows: [], queriedAt: new Date(this.now()).toISOString(), message: error instanceof RelayQuotaFailure ? error.message : 'TRAE 额度查询失败，请检查托管反代和账号登录后重试。' } };
    }
    let latest: ReturnType<RelayQuotaCenter['context']>;
    try { latest = this.context(providerId); }
    catch { throw new RelayQuotaFailure('额度查询期间供应商已移除或连接已更改，未保存查询结果。'); }
    if (latest.connection !== context.connection) throw new RelayQuotaFailure('额度查询期间连接已更改，未保存查询结果。');
    try { this.store.setManagedState(`auth-usage:${providerId}`, { ...result, version: 1, connection: context.connection } satisfies CachedRelayQuota); }
    catch { throw new RelayQuotaFailure('额度查询已结束，但本地缓存未能保存，请重试。'); }
    return this.decorate(relayAccountView(this.store, latest.provider));
  }
}
