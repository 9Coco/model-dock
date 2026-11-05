import { createHash, randomUUID } from 'node:crypto';
import type { AuthAccount, RelayAccountKind, RelayClientImportPreview, RelayClientImportProvenance } from '../shared/auth-types';
import type { Provider, ProviderInput } from '../shared/types';
import { JETBRAINS_RELAY_BASE_URL, TRAE_RELAY_BASE_URL, presetById } from '../shared/presets';
import type { Store } from './store';

export class RelayClientImportError extends Error {}
export interface NativeRelayCandidate {
  sourceId: string;
  client: RelayClientImportProvenance['client'];
  clientName: string;
  accountId?: string;
  accountLabel?: string;
}
export interface RelayImportAdapter {
  inspect(): Promise<NativeRelayCandidate[]>;
  perform(candidate: NativeRelayCandidate, key: string): Promise<{ upstreamVerified: boolean }>;
}
export type RelayImportStore = Pick<Store, 'listProviders' | 'getProvider' | 'getSecret' | 'getManagedState' | 'saveRelayClientImport'>;
interface StoredImport { version: 1; connection: string; identity: string; clientImport: RelayClientImportProvenance }
const kinds = ['trae-cn-relay', 'jetbrains-central'] as const;
const clients = ['trae-cn', 'trae-solo-cn', 'jetbrains-central'] as const;
const label = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function connection(provider: Pick<Provider, 'kind' | 'presetId' | 'baseUrl' | 'relayMode' | 'claudeBaseUrl' | 'messagesAuth'>, key?: string): string {
  return digest(JSON.stringify([provider.kind, provider.presetId, provider.baseUrl, provider.relayMode ?? '', provider.claudeBaseUrl ?? '', provider.messagesAuth ?? 'bearer', key ?? '']));
}
function identity(candidate: NativeRelayCandidate): string { return digest(JSON.stringify([candidate.client, candidate.sourceId, candidate.accountId ?? 'current-client'])); }
function storedImport(store: Pick<Store, 'getManagedState'>, id: string): StoredImport | undefined {
  const value = store.getManagedState<StoredImport | null>(`auth-metadata:${id}`, null);
  return value?.version === 1 && typeof value.connection === 'string' && typeof value.identity === 'string' && value.clientImport ? value : undefined;
}
export function relayClientImportProvenance(store: Pick<Store, 'getManagedState' | 'getSecret'>, provider: Provider): RelayClientImportProvenance | undefined {
  const stored = storedImport(store, provider.id), value = stored?.clientImport;
  if (!stored || !value || !clients.includes(value.client) || typeof value.upstreamVerified !== 'boolean' || !Number.isFinite(Date.parse(value.importedAt)) || stored.connection !== connection(provider, store.getSecret(provider.id)?.apiKey)) return;
  return { client: value.client, importedAt: value.importedAt, upstreamVerified: value.upstreamVerified, ...(label(value.accountLabel) ? { accountLabel: label(value.accountLabel) } : {}) };
}
export function relayAccountView(store: Pick<Store, 'getManagedState' | 'getSecret'>, provider: Provider): AuthAccount {
  const relayKeyConfigured = Boolean(store.getSecret(provider.id)?.apiKey), clientImport = relayClientImportProvenance(store, provider);
  return { providerId: provider.id, providerName: provider.name, kind: provider.presetId as RelayAccountKind, source: 'relay', relayKeyConfigured,
    ...(clientImport ? { clientImport } : {}), authStatus: relayKeyConfigured ? 'ready' : 'missing', canRefresh: false,
    usage: { status: 'unavailable', windows: [], message: clientImport ? clientImport.upstreamVerified
      ? '已复用并校验 Central CLI 当前授权；模型权限与推理结果请通过测试连接确认。'
      : '客户端会话已交给本机反代；尚未验证云端授权、额度或模型推理。'
      : '上游授权与订阅额度由反代服务管理，请在反代完成账号登录。' } };
}

/** Preview tickets contain metadata only. Tokens never enter this map or IPC. */
export class RelayClientImportManager {
  private readonly tickets = new Map<string, { kind: RelayAccountKind; candidate: NativeRelayCandidate; expires: number }>();
  private readonly pending = new Set<RelayAccountKind>();
  constructor(private readonly store: RelayImportStore, private readonly adapters: Record<RelayAccountKind, RelayImportAdapter>, private readonly key: (kind: RelayAccountKind) => string, private readonly now = Date.now) {}
  private kind(value: unknown): RelayAccountKind {
    if (!kinds.includes(value as RelayAccountKind)) throw new RelayClientImportError('请选择受支持的反代订阅。');
    return value as RelayAccountKind;
  }
  async preview(value: unknown): Promise<RelayClientImportPreview> {
    const kind = this.kind(value), now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(id);
    let candidates: NativeRelayCandidate[];
    try { candidates = await this.adapters[kind].inspect(); }
    catch (error) {
      if (error instanceof RelayClientImportError) throw error;
      throw new RelayClientImportError('无法读取本机客户端授权，请在客户端检查登录状态后重试。');
    }
    if (candidates.length > 10) throw new RelayClientImportError('本机客户端来源过多，请先整理客户端账号。');
    return { kind, message: candidates.length ? '请选择要复用的本机客户端授权。' : kind === 'trae-cn-relay' ? '未找到已登录的 TRAE 中国版客户端，请先在客户端登录。' : '未找到可复用的 Central CLI 登录，请先在 Central CLI 登录。', candidates: candidates.map(candidate => {
      if (!clients.includes(candidate.client) || !label(candidate.clientName) || !label(candidate.sourceId)) throw new RelayClientImportError('客户端来源信息无效，请刷新后重试。');
      const id = randomUUID(); this.tickets.set(id, { kind, candidate, expires: now + 5 * 60_000 });
      return { id, clientName: candidate.clientName, ...(label(candidate.accountLabel) ? { accountLabel: label(candidate.accountLabel) } : {}) };
    }) };
  }
  async import(value: unknown, id: unknown): Promise<AuthAccount> {
    const kind = this.kind(value), ticket = typeof id === 'string' ? this.tickets.get(id) : undefined;
    if (!ticket || ticket.kind !== kind || ticket.expires < this.now()) throw new RelayClientImportError('客户端选择已过期，请关闭窗口后重新选择。');
    if (this.pending.has(kind)) throw new RelayClientImportError('此反代正在导入，请等待当前操作完成。');
    this.pending.add(kind);
    try {
      const key = this.key(kind), baseUrl = kind === 'trae-cn-relay' ? TRAE_RELAY_BASE_URL : JETBRAINS_RELAY_BASE_URL;
      const eligible = this.store.listProviders().filter(provider => provider.kind === 'openai-compatible' && provider.presetId === kind && provider.baseUrl === baseUrl && !provider.claudeBaseUrl && (provider.messagesAuth ?? 'bearer') === 'bearer' && (kind !== 'trae-cn-relay' || provider.relayMode === 'managed'));
      const matching = eligible.filter(provider => { try { return !provider.hasSecret || this.store.getSecret(provider.id)?.apiKey === key; } catch { return false; } });
      const imported = matching.filter(provider => { try { return storedImport(this.store, provider.id)?.identity === identity(ticket.candidate); } catch { return false; } });
      const target = imported.length === 1 ? imported[0] : matching.length === 1 ? matching[0] : undefined;
      const expected = target ? { provider: target, apiKey: this.store.getSecret(target.id)?.apiKey } : undefined;
      // The native adapter re-reads the selected account and owns its relay lifecycle.
      const receipt = await this.adapters[kind].perform(ticket.candidate, key);
      let name = target?.name ?? `${presetById(kind)!.name} · 客户端导入`;
      if (!target) {
        const existing = this.store.listProviders(), base = name; let suffix = 2;
        while (existing.some(provider => provider.name.toLowerCase() === name.toLowerCase())) name = `${base} ${suffix++}`;
      }
      const input: ProviderInput = { ...(target ?? {}), ...(target ? { id: target.id } : {}), name, kind: 'openai-compatible', presetId: kind,
        baseUrl, apiKey: key, enabled: target?.enabled ?? true, note: target?.note ?? '', ...(kind === 'trae-cn-relay' ? { relayMode: 'managed' as const } : {}), messagesAuth: 'bearer', claudeBaseUrl: '' };
      const clientImport: RelayClientImportProvenance = { client: ticket.candidate.client, ...(label(ticket.candidate.accountLabel) ? { accountLabel: label(ticket.candidate.accountLabel) } : {}), importedAt: new Date(this.now()).toISOString(), upstreamVerified: receipt.upstreamVerified };
      const stored: StoredImport = { version: 1, connection: connection(input, key), identity: identity(ticket.candidate), clientImport };
      let saved: Provider;
      try { saved = await this.store.saveRelayClientImport(input, stored, expected); }
      catch { throw new RelayClientImportError('反代已处理客户端授权，但本地记录未能保存；原供应商记录已保留，请检查反代账号后重试。'); }
      this.tickets.delete(id as string);
      return relayAccountView(this.store, saved);
    } catch (error) {
      if (error instanceof RelayClientImportError) throw error;
      throw new RelayClientImportError('客户端授权未能导入，请检查客户端登录和本机反代后重试。');
    } finally { this.pending.delete(kind); }
  }
}
