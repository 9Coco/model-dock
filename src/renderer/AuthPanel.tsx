import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronDown, Clock3, Ellipsis, Info, KeyRound, LogOut, Plus, RefreshCw, Trash2, UserRound } from './MaterialIcon';
import type { ModelDockApi, Provider } from '../shared/types';
import type { SettingsSnapshot } from '../shared/settings-types';
import type { AuthAccount, AuthAccountKind, CopilotImportCandidate, JetBrainsIdeImportResult, QuotaWindow, RelayAccountKind, RelayClientImportCandidate, RelayClientImportProvenance, SubscriptionKind, SubscriptionUsage } from '../shared/auth-types';
import { SUBSCRIPTION_NAMES, subscriptionDisplayName } from '../shared/subscription-names';
import { QUOTA_CACHE_TTL_MS, quotaAmountLabel, quotaCacheExpired, quotaDateLabel, quotaExpiryLabel, quotaPercent, quotaPercentLabel, quotaQueryAge, quotaRefreshDue, quotaResetLabel, quotaRetryAt, resetCreditsLabel } from '../shared/quota-display';
import { BusyIcon, Modal, type Notify } from './components';
import { ToolIcon } from './ToolIcon';
import { AccountAvatar } from './AccountAvatar';
import { useContextMenu, type ContextMenuItem, type ContextMenuOpenEvent } from './ContextMenu';

const kinds: AuthAccountKind[] = ['copilot', 'codex', 'grok', 'trae-cn-relay', 'jetbrains-central'];
const titles = SUBSCRIPTION_NAMES;
const statuses: Record<AuthAccount['authStatus'], string> = { ready: '已授权', missing: '未授权', 'signing-in': '等待登录', error: '需重新授权', expired: '授权已过期' };
const relayStatus = (account: AuthAccount): string => account.clientImport
  ? account.authStatus !== 'ready' ? statuses[account.authStatus] : account.clientImport.upstreamVerified ? '账号授权已校验' : '本机账号已导入'
  : account.relayKeyConfigured ? '请重新导入账号' : '待连接账号';
const relayClientNames: Record<RelayClientImportProvenance['client'], string> = { 'trae-cn': 'TRAE 中国版', 'trae-solo-cn': 'TRAE SOLO 中国版', 'jetbrains-central': 'Central CLI', 'jetbrains-ide': 'JetBrains IDE / Air' };
const accountProviderName = (account: AuthAccount): string => subscriptionDisplayName({
  name: account.providerName,
  kind: account.kind === 'trae-cn-relay' || account.kind === 'jetbrains-central' ? 'openai-compatible' : account.kind,
  presetId: account.kind === 'codex' ? 'codex-subscription' : account.kind === 'grok' ? 'grok-build' : account.kind === 'copilot' ? 'copilot-subscription' : account.kind,
});
type RelayImportDialog = { mode?: 'selection'; source?: 'ide' | 'central'; kind: RelayAccountKind; candidates: RelayClientImportCandidate[]; loading: boolean; checked: boolean; message: string; error?: string };
const licenseDate = (value: string | undefined): string => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : value ? quotaDateLabel(value) : '到期日未知';
const showsQuotaResets = (kind: AuthAccountKind): boolean => kind === 'codex' || kind === 'grok';

function AccountBrand({ kind }: { kind: AuthAccountKind }) {
  if (kind === 'trae-cn-relay' || kind === 'jetbrains-central') return <KeyRound size={18} />;
  return kind === 'grok' ? <span className="auth-brand-xai" aria-hidden="true">xAI</span> : <ToolIcon tool={kind === 'copilot' ? 'copilot' : 'codex'} />;
}

function measurementNote(window: QuotaWindow): string {
  return window.measurement === 'official-default' ? '按官方客户端规则解析未使用额度' : window.measurement === 'protobuf-default' ? '按协议默认值解析' : '';
}

/** TRAE credit balances retain the official two decimal places; other sources
 * keep their established integer/percentage presentation. */
function creditAmount(window: QuotaWindow, fixedCredits = false): string | undefined {
  if (!fixedCredits || window.unit !== '积分' || window.unlimited) return quotaAmountLabel(window);
  const known = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const number = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (known(window.remaining) && known(window.total)) return `${number(window.remaining)} / ${number(window.total)} 积分`;
  if (known(window.remaining)) return `剩余 ${number(window.remaining)} 积分`;
  if (known(window.total)) return `剩余未知 / 总额 ${number(window.total)} 积分`;
  return undefined;
}

function QuotaSummary({ usage, now }: { usage: SubscriptionUsage; now: number }) {
  const summary = usage.summary;
  if (!summary) return null;
  const stale = quotaCacheExpired(usage, now);
  const remaining = typeof summary.remaining === 'number' && Number.isFinite(summary.remaining) && summary.remaining >= 0 ? summary.remaining : undefined;
  const value = summary.unlimited ? '不限量' : remaining === undefined ? '未知' : remaining.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (summary.unit ? ' ' + summary.unit : '');
  return <div className={'auth-quota-summary' + (stale ? ' auth-quota-summary-stale' : '')} data-quota-summary={summary.id} data-remaining={remaining ?? ''} title={[stale ? usage.message : '', measurementNote(summary)].filter(Boolean).join(' · ') || undefined}><span>{stale ? '上次可用积分' : summary.label}</span><strong data-quota-summary-amount>{value}</strong></div>;
}

function quotaTiming(window: QuotaWindow, usage: SubscriptionUsage, now: number, showResetTiming: boolean): string | undefined {
  if (window.expiresAt) return quotaExpiryLabel(window.expiresAt, now);
  if (usage.summary) return window.grantCount && window.grantCount > 1 ? '分笔到期，见明细' : '到期时间未返回';
  return showResetTiming ? quotaResetLabel(window.resetAt, now) : undefined;
}

function QuotaWindows({ usage, now, showAmounts = false, showResetTiming = false, onShowAll }: { usage: SubscriptionUsage; now: number; showAmounts?: boolean; showResetTiming?: boolean; onShowAll?: () => void }) {
  const stale = quotaCacheExpired(usage, now);
  const visibleWindows = onShowAll ? usage.windows.slice(0, 2) : usage.windows;
  const detailsCount = (usage.details ?? usage.windows).length;
  return <><QuotaSummary usage={usage} now={now} />{visibleWindows.map(window => {
    const remaining = quotaPercent(window.remainingPercent), amount = creditAmount(window, !!usage.summary), note = measurementNote(window);
    const remainingLabel = window.unlimited ? '不限量' : remaining === undefined ? '未知' : quotaPercentLabel(remaining);
    const label = window.label + (window.grantCount !== undefined ? ` · ${window.grantCount} 笔` : '');
    const timing = quotaTiming(window, usage, now, showResetTiming);
    return <div className={'quota-window' + (showAmounts ? ' quota-show-amounts' : '') + (usage.summary ? ' quota-group-window' : '') + (remaining !== undefined && remaining <= 20 ? ' quota-low' : '') + (remaining === undefined && !window.unlimited ? ' quota-unknown' : '')} key={window.id} data-quota-window-id={window.id} data-remaining-percent={remaining ?? ''}>
      <span className="auth-window-label" title={label + (note ? ' · ' + note : '')}><span className="auth-window-name">{window.label}</span>{window.grantCount !== undefined && <span className="auth-window-count"> · {window.grantCount} 笔</span>}{note && <sup title={note}>＊</sup>}</span>
      {!window.unlimited ? <progress value={remaining ?? 0} max={100} aria-label={window.label + (stale ? '上次剩余 ' : '剩余 ') + remainingLabel} /> : <span className="auth-window-unlimited" aria-hidden="true" />}
      <strong data-quota-amount={amount} title={amount ?? (remaining === undefined ? '上游未返回剩余额度' : '剩余额度')}>{showAmounts ? amount ?? remainingLabel : remainingLabel}</strong>
      <small className="auth-window-reset" aria-hidden={!timing || undefined} title={!timing ? undefined : window.expiresAt ? '到期时间：' + quotaDateLabel(window.expiresAt) + '（香港时间）' : !usage.summary && window.resetAt ? quotaDateLabel(window.resetAt) + '（香港时间）' : timing}>{timing}</small>
    </div>;
  })}{onShowAll && (usage.details !== undefined ? detailsCount > 0 : usage.windows.length > visibleWindows.length) && <button type="button" className="text-button auth-quota-details-button" data-action="show-all-quotas" onClick={onShowAll}>查看全部 {detailsCount} 项额度</button>}</>;
}

function QuotaDetails({ usage, now, showResetTiming = false }: { usage: SubscriptionUsage; now: number; showResetTiming?: boolean }) {
  return <><QuotaSummary usage={usage} now={now} />{(usage.details ?? usage.windows).map(window => {
    const timing = quotaTiming(window, usage, now, showResetTiming);
    return <section className="auth-quota-detail" data-quota-detail-id={window.id} key={window.id}>
      <strong>{window.label}</strong><p>{creditAmount(window, !!usage.summary) ?? '剩余 ' + quotaPercentLabel(window.remainingPercent)}{timing && <> · <span data-quota-detail-timing>{timing}</span></>}{measurementNote(window) && <> · {measurementNote(window)}</>}</p>
    </section>;
  })}</>;
}


function ResetCredits({ usage, now }: { usage: SubscriptionUsage; now: number }) {
  const display = resetCreditsLabel(usage, now), expiries = display.known ? usage.resetCredits?.expiresAt ?? [] : [];
  const message = usage.resetCreditsMessage ?? (!display.known ? '上游未返回可用次数，无法判断剩余重置额度。' : undefined);
  return <div className={'quota-credit' + (display.stale ? ' quota-credit-stale' : '')} data-reset-credits={display.available ?? ''} data-reset-credit-known={display.known} title={message}>
    {expiries.length ? <details className="quota-credit-list" data-reset-expiries>
      <summary><Clock3 size={12} /><span>{display.label}</span><ChevronDown size={12} /></summary>
      <ul>{expiries.map((expiry, index) => <li key={(expiry ?? 'unknown') + '-' + index}><span>重置额度 {index + 1}</span><span>{quotaExpiryLabel(expiry, now)}</span></li>)}</ul>
    </details> : <strong>{display.label}</strong>}
  </div>;
}

export function AuthPanel({ api, configuredProviders = [], onRemoveSource, onConfirmRemoveSource, platform, notify, onLogin, onCopilotLogin, onChanged, onManageProvider, onAddRelay, onAddSubscription, refreshRevision = 0, importRequest, onImportRequestHandled }: {
  configuredProviders?: Provider[];
  onRemoveSource?: (provider: Provider) => void;
  onConfirmRemoveSource: (id: string) => Promise<void>;
  api?: ModelDockApi; notify: Notify;
  platform?: SettingsSnapshot['platform'];
  importRequest?: { kind: AuthAccountKind; id: number; options?: boolean };
  onImportRequestHandled?: (id: number) => void;
  onLogin: (providerId: string) => void | Promise<void>;
  onCopilotLogin?: () => void | Promise<void>;
  onChanged?: () => void | Promise<void>;
  onManageProvider?: (providerId: string) => void;
  onAddRelay?: (presetId: RelayAccountKind) => void;
  onAddSubscription?: () => void;
  /** Provider edits happen in App's modal; reload immediately after its save. */
  refreshRevision?: number;
}) {
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [draft, setDraft] = useState<{ kind: SubscriptionKind; name: string } | null>(null);
  const [confirm, setConfirm] = useState<{ account: AuthAccount; action: 'logout' | 'delete' } | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [detailAccount, setDetailAccount] = useState<AuthAccount | null>(null);
  const [copilotImport, setCopilotImport] = useState<CopilotImportCandidate[] | null>(null);
  const [copilotImportId, setCopilotImportId] = useState('');
  const [relayImport, setRelayImport] = useState<RelayImportDialog | null>(null);
  const [relayImportId, setRelayImportId] = useState('');
  const ideImportSupported = platform === 'win32' || platform === 'linux';
  const relayPreviewRequest = useRef(0);
  const contextMenu = useContextMenu({ onError: failure => notify(failure instanceof Error ? failure.message : '账号操作失败。', 'error') });
  useEffect(() => { contextMenu.close(); }, [draft, confirm, detailAccount, copilotImport, relayImport, contextMenu.close]);
  const menuRoot = useRef<HTMLDivElement | null>(null), menuTrigger = useRef<HTMLButtonElement | null>(null);
  const listRequest = useRef<Promise<void> | null>(null);
  const inFlight = useRef(new Set<string>());
  const retryAfter = useRef(new Map<string, number>());
  const failures = useRef(new Map<string, number>());
  const identities = useRef(new Map<string, string>());
  const actions = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    if (detailAccount && !accounts.some(account => account.providerId === detailAccount.providerId)) setDetailAccount(null);
    if (menuId && !accounts.some(account => account.providerId === menuId)) setMenuId(null);
  }, [accounts, detailAccount, menuId]);
  useEffect(() => {
    if (!menuId) return;
    menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenuId(null); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuId(null); menuTrigger.current?.focus(); }
      else if (event.key === 'Tab') setMenuId(null);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const items = [...(menuRoot.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        if (!items.length) return;
        event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
  }, [menuId]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { for (const details of document.querySelectorAll<HTMLDetailsElement>('.auth-compact details[data-reset-expiries][open]')) if (!details.contains(event.target as Node)) details.open = false; };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') for (const details of document.querySelectorAll<HTMLDetailsElement>('.auth-compact details[data-reset-expiries][open]')) { details.open = false; details.querySelector<HTMLElement>('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback((): Promise<void> => {
    if (!api) return Promise.resolve();
    if (listRequest.current) return listRequest.current;
    const request = (async () => {
      try { const result = await api.authAccounts(); if (mounted.current) { setAccounts(result); setError(''); } }
      catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '授权中心读取失败'); }
    })();
    listRequest.current = request;
    void request.finally(() => { if (listRequest.current === request) listRequest.current = null; });
    return request;
  }, [api]);
  useEffect(() => { const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => {
    let current = true;
    // A pre-save request can still be in flight. Follow it with a fresh read
    // rather than letting deduplication consume the explicit save revision.
    const active = listRequest.current;
    if (active) void active.then(() => { if (current) void load(); }); else void load();
    return () => { current = false; };
  }, [load, refreshRevision]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const refreshQuota = useCallback(async (account: AuthAccount, manual = false) => {
    if (!api || account.source === 'relay' && !account.canQueryUsage || inFlight.current.has(account.providerId)) return;
    const key = account.providerId, began = Date.now();
    if (!manual && !quotaRefreshDue(account.usage, account.authStatus === 'ready', began, retryAfter.current.get(key))) return;
    inFlight.current.add(key); retryAfter.current.set(key, began + QUOTA_CACHE_TTL_MS);
    if (mounted.current) setBusy(current => ({ ...current, ['usage-' + key]: true }));
    try {
      const result = await api.refreshAccountUsage(key);
      const count = result.usage.status === 'ready' ? 0 : (failures.current.get(key) ?? 0) + 1;
      const datedResult = Number.isFinite(Date.parse(result.usage.queriedAt ?? ''));
      failures.current.set(key, count); retryAfter.current.set(key, count ? quotaRetryAt(Date.now(), count) : datedResult ? 0 : Date.now() + QUOTA_CACHE_TTL_MS);
      if (mounted.current) {
        setAccounts(current => current.map(item => item.providerId === key ? result : item)); setNow(Date.now());
        if (manual && ['unavailable', 'error', 'stale'].includes(result.usage.status)) notify(result.usage.message, 'info');
      }
    } catch (failure) {
      const count = (failures.current.get(key) ?? 0) + 1; failures.current.set(key, count); retryAfter.current.set(key, quotaRetryAt(Date.now(), count));
      const message = failure instanceof Error ? failure.message : '额度查询失败';
      if (mounted.current) {
        setAccounts(current => current.map(item => item.providerId === key ? { ...item, usage: { ...item.usage, status: item.usage.windows.length ? 'stale' : 'error', message } } : item));
        if (manual) notify(message, 'error');
      }
    } finally {
      inFlight.current.delete(key); if (mounted.current) setBusy(current => ({ ...current, ['usage-' + key]: false }));
    }
  }, [api, notify]);
  useEffect(() => {
    for (const account of accounts) {
      if (account.source === 'relay' && !account.canQueryUsage) continue;
      const identity = (account.accountId ?? account.email ?? '') + '/' + (account.authStatus === 'ready');
      if (identities.current.has(account.providerId) && identities.current.get(account.providerId) !== identity) {
        retryAfter.current.delete(account.providerId); failures.current.delete(account.providerId);
      }
      identities.current.set(account.providerId, identity);
      if (quotaRefreshDue(account.usage, account.authStatus === 'ready', now, retryAfter.current.get(account.providerId))) void refreshQuota(account);
    }
  }, [accounts, now, refreshQuota]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (!api) { notify('请在 ModelDock 桌面应用中管理授权。', 'info'); return; }
    if (actions.current.has(key)) return;
    actions.current.add(key); setBusy(current => ({ ...current, [key]: true }));
    try {
      await action();
      // An earlier poll may have begun before this mutation. Follow it with
      // a fresh read so newly imported accounts appear without the next poll.
      if (listRequest.current) await listRequest.current;
      await load(); await onChanged?.();
    }
    catch (failure) { notify(failure instanceof Error ? failure.message : '操作失败', 'error'); }
    finally { actions.current.delete(key); if (mounted.current) setBusy(current => ({ ...current, [key]: false })); }
  };
  const loginCopilot = async () => {
    if (onCopilotLogin) await onCopilotLogin();
    else notify('GitHub Copilot 登录入口尚未就绪，请刷新应用。', 'info');
  };
  const add = async () => {
    if (!draft?.name.trim()) { notify('请填写账号名称。', 'error'); return; }
    await run('add-account', async () => {
      const provider = await api!.saveProvider({ name: draft.name.trim(), kind: draft.kind, presetId: draft.kind === 'codex' ? 'codex-subscription' : 'grok-build', baseUrl: draft.kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://cli-chat-proxy.grok.com/v1', enabled: true, note: '' });
      setDraft(null); await onLogin(provider.id);
    });
  };
  const importLocal = (kind: SubscriptionKind) => run('import-' + kind, async () => {
    await api!.importLocalAccount(kind); notify('客户端授权已导入 ModelDock，原客户端文件保持不变。');
  });
  const openCopilotImport = () => run('import-copilot-list', async () => {
    const candidates = await api!.copilotImportCandidates();
    setCopilotImport(candidates); setCopilotImportId(candidates[0]?.id ?? '');
  });
  const importCopilot = () => run('import-copilot-account', async () => {
    if (!copilotImportId || !copilotImport?.some(candidate => candidate.id === copilotImportId)) return;
    const account = await api!.importCopilotClientAccount(copilotImportId);
    setCopilotImport(null);
    notify(account.usage.status === 'ready' ? 'GitHub 账号授权与 Copilot 额度已导入，原客户端保持不变。' : 'GitHub 账号授权已导入。' + account.usage.message, account.usage.status === 'ready' ? 'success' : 'info');
  });
  const checkRelayImport = async (kind: RelayAccountKind) => {
    if (!api) { notify('请在 ModelDock 桌面应用中管理授权。', 'info'); return; }
    if (actions.current.has('import-relay-account')) return;
    const request = ++relayPreviewRequest.current;
    setRelayImport({ source: kind === 'jetbrains-central' ? 'central' : undefined, kind, candidates: [], loading: true, checked: true, message: '' }); setRelayImportId('');
    try {
      const preview = await api.relayClientImportCandidates(kind);
      if (mounted.current && relayPreviewRequest.current === request) {
        setRelayImport({ source: kind === 'jetbrains-central' ? 'central' : undefined, kind, candidates: preview.candidates, loading: false, checked: true, message: preview.message });
        setRelayImportId(preview.candidates[0]?.id ?? '');
      }
    } catch (failure) {
      if (mounted.current && relayPreviewRequest.current === request) setRelayImport({ source: kind === 'jetbrains-central' ? 'central' : undefined, kind, candidates: [], loading: false, checked: true, message: '', error: failure instanceof Error ? failure.message : '客户端账号读取失败，请检查客户端登录状态。' });
    }
  };
  const scanJetBrainsIde = async () => {
    if (!ideImportSupported || !api?.jetBrainsIdeImportCandidates || actions.current.has('import-relay-account')) return;
    const request = ++relayPreviewRequest.current;
    setRelayImport({ source: 'ide', kind: 'jetbrains-central', candidates: [], loading: true, checked: true, message: '' }); setRelayImportId('');
    try {
      const preview = await api.jetBrainsIdeImportCandidates();
      if (mounted.current && relayPreviewRequest.current === request) { setRelayImport({ ...preview, source: 'ide', loading: false, checked: true }); setRelayImportId(preview.candidates[0]?.id ?? ''); }
    } catch (failure) {
      if (mounted.current && relayPreviewRequest.current === request) setRelayImport({ source: 'ide', kind: 'jetbrains-central', candidates: [], loading: false, checked: true, message: '', error: failure instanceof Error ? failure.message : 'IDE 账号读取失败，请检查本机登录后重试。' });
    }
  };
  const acceptRelayAccount = (account: AuthAccount, request: number): boolean => {
    if (!mounted.current || relayPreviewRequest.current !== request) return false;
    setAccounts(current => current.some(item => item.providerId === account.providerId) ? current.map(item => item.providerId === account.providerId ? account : item) : [...current, account]);
    setNow(Date.now()); setRelayImport(null); setRelayImportId(''); return true;
  };
  const acceptJetBrainsImport = (result: JetBrainsIdeImportResult, request: number): void => {
    if (!mounted.current || relayPreviewRequest.current !== request) return;
    if (result.status === 'imported') {
      const imported = result.accounts ?? [result.account];
      setAccounts(current => { const next = new Map(current.map(account => [account.providerId, account])); for (const account of imported) next.set(account.providerId, account); return [...next.values()]; });
      setNow(Date.now()); setRelayImport(null); setRelayImportId('');
      if (result.failures?.length) notify(`已导入 ${imported.length} 项许可证，${result.failures.length} 项未完成。${[...new Set(result.failures.map(failure => failure.message))].slice(0, 2).join(' ')}`, 'info');
      return;
    }
    if (!result.preview.candidates.length) throw new Error('未找到可导入的 IDE 账号与 AI 许可证，请先在 IDE 登录并选择许可证。');
    setRelayImport({ mode: 'selection', source: 'ide', kind: 'jetbrains-central', candidates: result.preview.candidates, loading: false, checked: true, message: result.preview.message });
    setRelayImportId(result.preview.candidates[0]?.id ?? '');
  };
  const beginJetBrainsImport = () => run('import-relay-account', async () => {
    const request = ++relayPreviewRequest.current;
    setRelayImport(null); setRelayImportId('');
    if (!ideImportSupported) throw new Error(platform ? '当前系统暂不支持从 IDE / Air 导入，请使用其他连接方式。' : '正在确认系统支持范围，请稍后重试。');
    if (!api?.beginJetBrainsIdeImport) throw new Error('客户端导入尚未连接，请重启最新版本后重试。');
    try {
      const result = await api.beginJetBrainsIdeImport();
      acceptJetBrainsImport(result, request);
    } catch (failure) {
      if (mounted.current && relayPreviewRequest.current === request) throw failure;
    }
  });
  const openJetBrainsImportOptions = () => {
    if (actions.current.has('import-relay-account')) return;
    relayPreviewRequest.current++;
    setRelayImport({ kind: 'jetbrains-central', candidates: [], loading: false, checked: false, message: '' }); setRelayImportId('');
  };
  const openRelayImport = (kind: RelayAccountKind) => kind === 'jetbrains-central' ? beginJetBrainsImport() : checkRelayImport(kind);
  const openJetBrainsHelp = (topic: 'ide' | 'central') => run('jetbrains-help-' + topic, async () => {
    if (!api?.openJetBrainsAccountHelp) throw new Error('账号帮助尚未连接，请重启最新版本后重试。');
    await api.openJetBrainsAccountHelp(topic);
  });
  const openedImportRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!importRequest || openedImportRequest.current === importRequest.id) return;
    openedImportRequest.current = importRequest.id;
    // Consume the parent request before asynchronous work. This component is
    // recreated on navigation; its local ref alone cannot prevent a replay.
    onImportRequestHandled?.(importRequest.id);
    const { kind, options } = importRequest;
    if (kind === 'copilot') void openCopilotImport();
    else if (kind === 'codex' || kind === 'grok') void importLocal(kind);
    else if (kind === 'jetbrains-central' && options) openJetBrainsImportOptions();
    else void openRelayImport(kind);
  }, [importRequest, onImportRequestHandled]);
  const closeRelayImport = () => {
    if (actions.current.has('import-relay-account') || busy['import-relay-account']) return;
    relayPreviewRequest.current++; setRelayImport(null); setRelayImportId('');
  };
  const importRelay = () => run('import-relay-account', async () => {
    if (!relayImport || relayImport.loading || !relayImportId || !relayImport.candidates.some(candidate => candidate.id === relayImportId)) return;
    const request = ++relayPreviewRequest.current;
    try {
      if (relayImport.source === 'ide') { acceptJetBrainsImport(await api!.beginJetBrainsIdeImport(relayImportId), request); return; }
      const account = await api!.importRelayClientAccount(relayImport.kind, relayImportId);
      if (acceptRelayAccount(account, request)) notify(account.usage.message, 'info');
    } catch (failure) {
      if (mounted.current && relayPreviewRequest.current === request) throw failure;
    }
  });
  const confirmAction = () => confirm && run('confirm-' + confirm.account.providerId, async () => {
    const { account, action } = confirm;
    if (account.kind === 'copilot') await api!.copilotLogoutAccount(account.providerId);
    else if (action === 'logout') await api!.logoutAccount(account.providerId);
    else {
      await onConfirmRemoveSource(account.providerId);
      setAccounts(current => current.filter(row => row.providerId !== account.providerId));
    }
    notify(account.kind === 'copilot' ? '已移除 ModelDock 中的 GitHub 账号授权和额度缓存。' : action === 'logout' ? '已清除 ModelDock 中的本地授权。' : '账号来源及其模型已删除。'); setConfirm(null);
  });

  const closeAccountMenu = () => { setMenuId(null); menuTrigger.current?.focus(); };
  const reauthorizeAccount = (account: AuthAccount) => run('login-' + account.providerId, async () => {
    if (account.source === 'relay') onManageProvider?.(account.providerId);
    else if (account.kind === 'copilot') await loginCopilot(); else await onLogin(account.providerId);
  });
  const accountContextMenu = (event: ContextMenuOpenEvent, account: AuthAccount) => {
    const changing = !!busy['login-' + account.providerId] || !!busy['confirm-' + account.providerId];
    if (account.source === 'relay') {
      contextMenu.open(event, [
        { id: 'account-details', label: '订阅详情', icon: <Info size={14} />, onSelect: () => setDetailAccount(account) },
        { id: 'account-manage-relay', label: '账号设置', icon: <KeyRound size={14} />, disabled: !onManageProvider || changing, onSelect: () => onManageProvider?.(account.providerId) },
        { id: 'account-delete', label: '删除订阅来源', icon: <Trash2 size={14} />, danger: true, disabled: !api || changing, onSelect: () => setConfirm({ account, action: 'delete' }) },
      ], accountProviderName(account));
      return;
    }
    const items: ContextMenuItem[] = [
      { id: 'account-details', label: '账号详情', icon: <Info size={14} />, onSelect: () => setDetailAccount(account) },
      { id: 'account-refresh-quota', label: '刷新额度', icon: <RefreshCw size={14} />, disabled: !api || changing || !!busy['usage-' + account.providerId] || account.authStatus === 'missing' || account.authStatus === 'signing-in', onSelect: () => refreshQuota(account, true) },
      { id: 'account-reauth', label: account.authStatus === 'ready' ? '重新授权' : '登录', icon: <KeyRound size={14} />, disabled: !api || changing || account.authStatus === 'signing-in', onSelect: () => reauthorizeAccount(account) },
      { id: 'account-management', separator: true },
      { id: 'account-logout', label: '清除本地授权', icon: <LogOut size={14} />, disabled: !api || changing || account.authStatus === 'missing', onSelect: () => setConfirm({ account, action: 'logout' }) },
      { id: 'account-delete', label: account.kind === 'copilot' ? '移除账号' : '删除账号来源', icon: <Trash2 size={14} />, danger: true, disabled: !api || changing, onSelect: () => setConfirm({ account, action: 'delete' }) },
    ];
    if (contextMenu.open(event, items, account.email ?? account.displayName ?? accountProviderName(account))) setMenuId(null);
  };
  const renderSource = (provider: Provider) => <article className="account-row auth-source-row" key={provider.id} data-auth-source={provider.id}>
    <div className="account-identity"><KeyRound size={16} /><div><strong>{subscriptionDisplayName(provider)}</strong><small>{provider.kind === 'opencode-go' ? provider.hasSecret ? '已配置工作区 API Key' : '待填写工作区 API Key' : '本地供应商来源'}</small></div></div>
    <div className="account-actions"><button className="button small secondary" onClick={() => onManageProvider?.(provider.id)}>编辑</button><button className="icon-button" data-action="remove-local-source" aria-label={'移除 ' + subscriptionDisplayName(provider)} onClick={() => onRemoveSource?.(provider)}><Trash2 size={14} /></button></div>
  </article>;
  const goSources = configuredProviders.filter(provider => provider.kind === 'opencode-go');
  const inspectedAccount = detailAccount ? accounts.find(account => account.providerId === detailAccount.providerId) ?? null : null;
  return <section className="feature-panel auth-panel auth-compact">
    <div className="feature-toolbar auth-compact-toolbar"><p>订阅账号、反代与授权</p><div className="row-actions"><button className="button small primary" data-action="add-subscription-provider" disabled={!onAddSubscription} onClick={onAddSubscription}><Plus size={13} />添加订阅</button><button className="button small secondary" data-action="reload-auth-accounts" onClick={() => void run('reload', load)} disabled={busy.reload}><BusyIcon active={!!busy.reload}><RefreshCw size={13} /></BusyIcon>刷新列表</button></div></div>
    {error && <p className="feature-error" role="alert">{error}</p>}
    {kinds.map(kind => {
      const group = accounts.filter(account => account.kind === kind);
      const sources = kind === 'copilot' ? configuredProviders.filter(provider => provider.kind === 'copilot') : [];
      if (!group.length && !sources.length) return null;
      const relay = kind === 'trae-cn-relay' || kind === 'jetbrains-central';
      return <div className="account-group" key={kind} data-auth-kind={kind}>
        <div className="account-group-header"><h2><AccountBrand kind={kind} />{titles[kind]}<span className="count-tag">{group.length + sources.length}</span></h2><div className="row-actions">
          {relay ? <><button className="button small secondary" data-auth-import-account={kind} disabled={!!relayImport || busy['import-relay-account'] || kind === 'jetbrains-central' && !ideImportSupported} onClick={() => void openRelayImport(kind)} title={kind === 'trae-cn-relay' ? '读取本机已登录的 TRAE 中国版或 TRAE SOLO 中国版账号' : !ideImportSupported ? platform ? '当前系统暂不支持 IDE / Air 导入，请使用其他连接方式' : '正在确认系统支持范围' : '导入本机 IDE / Air 本人账号下的可用 AI 许可证'}><BusyIcon active={kind === 'jetbrains-central' && !!busy['import-relay-account']}><ArrowDownToLine size={13} /></BusyIcon>从客户端导入</button>{kind === 'jetbrains-central' && <button className="icon-button" data-action="jetbrains-import-options" aria-label="其他连接方式" title="其他连接方式" disabled={!!relayImport || busy['import-relay-account']} onClick={openJetBrainsImportOptions}><Ellipsis size={14} /></button>}<button className="button small secondary" data-auth-add-relay={kind} disabled={!onAddRelay || kind === 'jetbrains-central' && !!busy['import-relay-account']} onClick={() => onAddRelay?.(kind)}><Plus size={13} />添加订阅</button></> : kind === 'copilot' ? <><button className="button small secondary" data-auth-import-account="copilot" disabled={busy['import-copilot-list']} onClick={() => void openCopilotImport()} title="选择已登录的 Copilot CLI 或 GitHub CLI 账号"><BusyIcon active={!!busy['import-copilot-list']}><ArrowDownToLine size={13} /></BusyIcon>从客户端导入</button><button className="button small secondary" data-action="copilot-login" data-auth-add-account={kind} disabled={busy['login-copilot']} onClick={() => void run('login-copilot', loginCopilot)}><Plus size={13} />登录 GitHub</button></> : <>
            <button className="button small secondary" data-auth-import-account={kind} disabled={busy['import-' + kind]} onClick={() => void importLocal(kind)} title="仅在点击时导入本机客户端已有授权"><BusyIcon active={!!busy['import-' + kind]}><ArrowDownToLine size={13} /></BusyIcon>从客户端导入</button>
            <button className="button small secondary" data-auth-add-account={kind} onClick={() => setDraft({ kind, name: titles[kind] + ' ' + (group.length + 1) })}><Plus size={13} />添加账号</button>
          </>}
        </div></div>
        {sources.map(renderSource)}
        {group.map(account => {
          const isRelay = account.source === 'relay';
          const stale = quotaCacheExpired(account.usage, now), opened = menuId === account.providerId;
          const identity = isRelay ? account.accountId ? account.email ?? account.displayName ?? account.accountId : '当前账号未确认' : account.email ?? account.displayName ?? accountProviderName(account);
          const status = isRelay ? relayStatus(account) : statuses[account.authStatus];
          const canQuery = !isRelay || account.canQueryUsage;
          const quotaDisabled = !!busy['usage-' + account.providerId] || !canQuery || !isRelay && (account.authStatus === 'missing' || account.authStatus === 'signing-in');
          const changing = !!busy['login-' + account.providerId] || !!busy['confirm-' + account.providerId];
          const hasQuota = account.usage.windows.length > 0 || !!account.usage.summary;
          const showQuotaMessage = !canQuery || !hasQuota || account.usage.status !== 'ready' && !!account.usage.message;
          const queried = account.usage.queriedAt ? quotaQueryAge(account.usage.queriedAt, now).replace(/查询$/, '') : '未查询';
          return <article className={'account-row' + (isRelay ? ' auth-relay-row' : '')} key={account.providerId} tabIndex={0} onContextMenu={event => accountContextMenu(event, account)} aria-label={'账号 ' + identity} data-auth-account={account.providerId} data-account-id={account.providerId} data-auth-relay={isRelay ? account.kind : undefined} data-quota-status={stale ? 'stale' : account.usage.status}>
            <div className="account-identity" title={identity + ' · ' + accountProviderName(account)}>
              <AccountAvatar account={isRelay ? { ...account, displayName: identity, email: undefined, avatarUrl: account.accountId ? account.avatarUrl : undefined } : account} />
              <i className={'auth-identity-dot ' + account.authStatus} role="img" aria-label={status} title={status} />
              <div className={'auth-identity-content' + (account.license ? ' auth-license-identity' : '')}><strong data-relay-quota-account={isRelay ? '' : undefined} title={identity}>{identity}</strong>{(account.plan || isRelay) && <span className="account-plan" data-account-plan={account.plan ?? 'unknown'} title={account.plan ? '当前账号套餐：' + account.plan : '上游尚未返回可识别的套餐类型'}>{account.plan ?? '套餐未知'}</span>}{account.authStatus !== 'ready' && <small className="auth-identity-status" title={status}>{statuses[account.authStatus]}</small>}</div>
            </div>
            <div className="account-quotas">
              {canQuery && <QuotaWindows usage={account.usage} now={now} showAmounts={isRelay} showResetTiming={showsQuotaResets(kind)} onShowAll={isRelay ? () => setDetailAccount(account) : undefined} />}
              {account.license && <small className="auth-license-summary" data-account-license title={account.license.label + ' · ' + (account.license.expiresAt ? '有效期至 ' + licenseDate(account.license.expiresAt) : '到期日未知')}><span>{account.license.label}</span><span data-license-expires-at={account.license.expiresAt}>{account.license.expiresAt ? '至 ' + licenseDate(account.license.expiresAt) : '到期日未知'}</span></small>}
              {showQuotaMessage && <p className="quota-unavailable" data-quota-message title={account.usage.message}>{account.usage.message}</p>}
              {kind === 'codex' && <ResetCredits usage={account.usage} now={now} />}
            </div>
            <div className="account-actions">
              <small className={'auth-row-age' + (stale ? ' quota-stale' : '')} title={(stale ? '缓存结果 · ' : '') + (account.usage.queriedAt ? quotaDateLabel(account.usage.queriedAt) + '（香港时间）' : '尚未查询') + (stale ? ' · ' + account.usage.message : '')}>{busy['usage-' + account.providerId] ? '查询中' : canQuery ? queried : '不支持查询'}</small>
              <button className="icon-button" data-action="refresh-account-quota" data-account-id={account.providerId} aria-label={'刷新 ' + accountProviderName(account) + ' 额度'} title={canQuery ? '刷新账户额度' : '此来源不支持查询额度'} disabled={quotaDisabled} onClick={() => void refreshQuota(account, true)}><BusyIcon active={!!busy['usage-' + account.providerId]}><RefreshCw size={14} /></BusyIcon></button>
              <div className="auth-account-menu-root" ref={opened ? menuRoot : undefined}>
                <button className="icon-button" data-action="account-menu" data-account-id={account.providerId} aria-label={'账号操作 ' + accountProviderName(account)} aria-haspopup="menu" aria-expanded={opened} onClick={event => { contextMenu.close(); menuTrigger.current = event.currentTarget; setMenuId(opened ? null : account.providerId); }}><Ellipsis size={16} /></button>
                {opened && <div className="auth-account-menu" data-auth-account-menu={account.providerId} role="menu" aria-label={accountProviderName(account) + '操作'}>
                  <button role="menuitem" data-action={isRelay ? 'relay-account-details' : 'account-details'} onClick={() => { closeAccountMenu(); setDetailAccount(account); }}><Info size={14} />{isRelay ? '订阅详情' : '账号详情'}</button>
                  <button role="menuitem" data-action="account-refresh-quota" disabled={quotaDisabled || changing} onClick={() => { closeAccountMenu(); void refreshQuota(account, true); }}><RefreshCw size={14} />刷新额度</button>
                  {isRelay ? <button role="menuitem" data-action="manage-auth-relay" data-account-id={account.providerId} disabled={!onManageProvider || changing} onClick={() => { closeAccountMenu(); onManageProvider?.(account.providerId); }}><KeyRound size={14} />账号设置</button> : <>
                    <button role="menuitem" data-action="account-reauth" disabled={changing || account.authStatus === 'signing-in'} onClick={() => { closeAccountMenu(); void reauthorizeAccount(account); }}><KeyRound size={14} />{account.authStatus === 'ready' ? '重新授权' : '登录'}</button>
                    <button role="menuitem" data-action="account-logout" aria-label={'注销 ' + accountProviderName(account)} disabled={changing || account.authStatus === 'missing'} onClick={() => { closeAccountMenu(); setConfirm({ account, action: 'logout' }); }}><LogOut size={14} />清除本地授权</button>
                  </>}
                  <button role="menuitem" className="danger" data-action="account-delete" aria-label={'删除 ' + accountProviderName(account)} disabled={changing} onClick={() => { closeAccountMenu(); setConfirm({ account, action: 'delete' }); }}><Trash2 size={14} />{isRelay ? '删除订阅来源' : kind === 'copilot' ? '移除账号' : '删除账号来源'}</button>
                </div>}
              </div>
            </div>
          </article>;
        })}
      </div>;
    })}
    {goSources.length > 0 && <div className="account-group" data-auth-kind="opencode-go">
      <div className="account-group-header"><h2><ToolIcon tool="opencode" />OpenCode Go 订阅<span className="count-tag">{goSources.length}</span></h2></div>
      {goSources.map(renderSource)}
    </div>}
    {accounts.length > 0 && <p className="feature-footnote">账户额度包含其他客户端用量。访问凭据到期与套餐到期不同；反代密钥的保存状态不代表上游账号已登录。</p>}
    {inspectedAccount && <Modal title="账号详情" onClose={() => setDetailAccount(null)}><div className="modal-body auth-account-details" data-auth-account-details={inspectedAccount.providerId}><dl>
      <div><dt>账号</dt><dd>{inspectedAccount.source === 'relay' ? inspectedAccount.accountId ? inspectedAccount.email ?? inspectedAccount.displayName ?? inspectedAccount.accountId : '当前账号未确认' : inspectedAccount.email ?? inspectedAccount.displayName ?? accountProviderName(inspectedAccount)}</dd></div>
      <div><dt>账号名称</dt><dd>{accountProviderName(inspectedAccount)}</dd></div>
      <div><dt>平台 / 套餐</dt><dd>{titles[inspectedAccount.kind]}{inspectedAccount.plan ? ' · ' + inspectedAccount.plan : ''}</dd></div>
      {inspectedAccount.license && <><div data-license-details><dt>AI 许可证</dt><dd>{inspectedAccount.license.label}</dd></div><div><dt>许可证有效期</dt><dd>{licenseDate(inspectedAccount.license.expiresAt)}</dd></div>{inspectedAccount.license.verifiedAt && <div><dt>许可证核验</dt><dd>{quotaDateLabel(inspectedAccount.license.verifiedAt)}（香港时间）</dd></div>}</>}
      <div data-relay-key-configured={inspectedAccount.source === 'relay' ? !!inspectedAccount.relayKeyConfigured : undefined}><dt>{inspectedAccount.source === 'relay' ? '反代配置' : '授权状态'}</dt><dd>{inspectedAccount.source === 'relay' ? relayStatus(inspectedAccount) : statuses[inspectedAccount.authStatus]}</dd></div>
      {(inspectedAccount.source !== 'relay' || inspectedAccount.license) && <><div><dt>访问凭据到期</dt><dd>{quotaDateLabel(inspectedAccount.expiresAt)}</dd></div>
      <div><dt>自动续期</dt><dd>{inspectedAccount.canRefresh ? '支持' : '未提供续期凭据'}</dd></div></>}
      <div><dt>授权来源</dt><dd>{inspectedAccount.source === 'relay' ? 'ModelDock 管理账号授权' : inspectedAccount.source === 'client-import' ? '客户端导入' : 'ModelDock 登录'}</dd></div>
      {inspectedAccount.clientImport && <><div data-relay-client-source={inspectedAccount.clientImport.client}><dt>导入客户端</dt><dd>{relayClientNames[inspectedAccount.clientImport.client]}{inspectedAccount.clientImport.accountLabel ? ' · ' + inspectedAccount.clientImport.accountLabel : ''}</dd></div><div><dt>最近导入</dt><dd>{quotaDateLabel(inspectedAccount.clientImport.importedAt)}（香港时间）</dd></div><div><dt>导入确认</dt><dd>{inspectedAccount.clientImport.upstreamVerified ? inspectedAccount.clientImport.client === 'jetbrains-ide' ? '已校验 IDE 账号的 AI 服务授权与额度；模型推理仍需测试' : '已校验 Central CLI 当前会话；模型权限、额度和推理仍需确认' : '本机账号已保存；云端授权、套餐和推理尚未验证'}</dd></div></>}
      {inspectedAccount.source === 'relay' && inspectedAccount.canQueryUsage && <div><dt>额度账号</dt><dd>{inspectedAccount.accountId ? inspectedAccount.displayName ?? inspectedAccount.accountId : '当前账号未确认'}</dd></div>}
      <div><dt>额度查询</dt><dd>{inspectedAccount.source === 'relay' && !inspectedAccount.canQueryUsage ? '请在反代服务或官方客户端查看' : inspectedAccount.usage.queriedAt ? quotaDateLabel(inspectedAccount.usage.queriedAt) + '（香港时间）' : '尚未查询'}</dd></div>
    </dl><p>{inspectedAccount.usage.message}</p>{showsQuotaResets(inspectedAccount.kind) && inspectedAccount.usage.resetCreditsMessage && <p>{inspectedAccount.usage.resetCreditsMessage}</p>}<QuotaDetails usage={inspectedAccount.usage} now={now} showResetTiming={showsQuotaResets(inspectedAccount.kind)} /></div><div className="modal-footer"><button className="button secondary" onClick={() => setDetailAccount(null)}>关闭</button></div></Modal>}
    {draft && <Modal title={'添加 ' + titles[draft.kind] + ' 账号'} subtitle="创建独立订阅来源，然后在浏览器完成本人账号授权。" onClose={() => setDraft(null)}><div className="modal-body"><label className="form-field">账号名称<input value={draft.name} maxLength={120} autoFocus onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : null)} onKeyDown={event => { if (event.key === 'Enter') void add(); }} /></label></div><div className="modal-footer"><button className="button small secondary" onClick={() => setDraft(null)}>取消</button><button className="button small primary" disabled={busy['add-account']} onClick={() => void add()}><BusyIcon active={!!busy['add-account']}><KeyRound size={16} /></BusyIcon>创建并登录</button></div></Modal>}
    {copilotImport !== null && <Modal title="从客户端导入 GitHub Copilot" subtitle="选择已登录的 Copilot CLI 或 GitHub CLI 账号，导入本人 GitHub.com 授权。" onClose={() => { if (!busy['import-copilot-account']) setCopilotImport(null); }}><div className="modal-body" data-copilot-import>
      {copilotImport.length ? <label className="form-field">客户端与账号<select data-field="copilot-import-account" value={copilotImportId} disabled={busy['import-copilot-account']} onChange={event => setCopilotImportId(event.target.value)}>{copilotImport.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label> : <p data-copilot-import-empty>未找到可导入的 Copilot CLI 或 GitHub CLI 账号。</p>}
      <p className="feature-footnote">导入时验证账号身份和 Copilot 额度，原客户端保持不变。未列出的桌面端或编辑器账号可使用“登录 GitHub”添加。</p>
    </div><div className="modal-footer"><button className="button small secondary" disabled={busy['import-copilot-account']} onClick={() => setCopilotImport(null)}>取消</button><button className="button small primary" data-action="import-copilot-client-account" disabled={!copilotImportId || busy['import-copilot-account']} onClick={() => void importCopilot()}><BusyIcon active={!!busy['import-copilot-account']}><ArrowDownToLine size={14} /></BusyIcon>导入所选账号</button></div></Modal>}
    {relayImport && <Modal title={relayImport.mode === 'selection' ? '选择 JetBrains 账号来源' : relayImport.kind === 'jetbrains-central' ? '连接JetBrains账号' : '从客户端导入 ' + titles[relayImport.kind]} subtitle={relayImport.mode === 'selection' ? '选择本次导入的本人账号来源，将分别保存其可用的 AI 许可证。' : relayImport.kind === 'jetbrains-central' ? '查看现有登录的支持范围，再选择连接方式。' : '选择本机客户端已有账号，通过 ModelDock 网关连接。'} onClose={closeRelayImport}><div className="modal-body auth-relay-import" data-relay-client-import={relayImport.kind} aria-busy={relayImport.loading || !!busy['import-relay-account']}>
      {relayImport.kind === 'jetbrains-central' && relayImport.mode !== 'selection' && <><div data-jetbrains-ide-account-boundary><p>从本机 IDE / Air 的本人账号导入，分别保存官方可用的 AI 许可证、套餐与额度。原客户端登录和配置保持不变。</p><p>支持 Windows / Linux 上的 2026.2 IDE 及其内置 Air；独立 Air 和 macOS 暂不支持。</p>{!ideImportSupported && <p role="status">{platform ? "当前系统暂不支持从 IDE 导入，可使用下方 Central CLI 连接方式。" : "正在确认系统支持范围…"}</p>}<div className="row-actions"><button className="button small primary" data-action="scan-jetbrains-ide" disabled={!ideImportSupported || relayImport.loading || busy['import-relay-account']} onClick={() => void scanJetBrainsIde()}><ArrowDownToLine size={13} />从 IDE / Air 导入</button><button className="button small secondary" data-action="jetbrains-account-help-ide" disabled={!api || busy['jetbrains-help-ide']} onClick={() => void openJetBrainsHelp('ide')}>IDE / Air 账号与额度说明</button></div></div><div className="auth-relay-import-notes"><p>Central CLI 是另一种独立连接方式，仅在你使用该客户端时检查其登录。</p><div className="row-actions"><button className="button small secondary" data-action="check-central-login" disabled={relayImport.loading || busy['import-relay-account']} onClick={() => void checkRelayImport('jetbrains-central')}><BusyIcon active={relayImport.loading && relayImport.source === 'central'}><RefreshCw size={13} /></BusyIcon>检查Central CLI登录</button><button className="button small secondary" data-action="jetbrains-account-help-central" disabled={!api || busy['jetbrains-help-central']} onClick={() => void openJetBrainsHelp('central')}>Central 准备与登录步骤</button></div></div></>}
      {relayImport.loading ? <p className="auth-relay-import-loading" role="status"><BusyIcon active><ArrowDownToLine size={14} /></BusyIcon>正在检查本机客户端登录状态…</p> : relayImport.error ? <p className="feature-error" role="alert">{relayImport.error}</p> : relayImport.checked && <>
        {relayImport.candidates.length > 0 && <label className="form-field">客户端与账号<select data-field="relay-import-candidate" value={relayImportId} disabled={busy['import-relay-account']} onChange={event => setRelayImportId(event.target.value)}>{relayImport.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.clientName}{candidate.accountLabel ? ' · ' + candidate.accountLabel : ''}</option>)}</select></label>}
        <p className="feature-footnote" data-relay-import-message>{relayImport.message}</p>
      </>}
      <div className="auth-relay-import-notes">{relayImport.mode === 'selection' ? <p>每项许可证单独保存套餐、有效期与额度；已保存的同一许可证保留原有模型和工具绑定。</p> : relayImport.kind === 'trae-cn-relay' ? <><p>仅读取本机已登录的 TRAE 中国版 / TRAE SOLO 中国版账号，由内置适配器直接接入 ModelDock 网关。</p><p>导入会保存或更新所选账号的授权。原客户端保持不变；导入后可查询官方套餐与额度，模型推理仍需单独测试。</p></> : <p>{relayImport.source === 'ide' ? '确认后向官方服务校验当前账号和 AI 许可证，令牌留在本机。仅发布已核实的兼容模型；模型推理仍需单独测试。' : '检查成功后可连接 Central CLI 当前账号。原客户端保持不变；账号校验不代表模型权限或推理已通过。'}</p>}</div>
    </div><div className="modal-footer"><button className="button small secondary" disabled={busy['import-relay-account']} onClick={closeRelayImport}>取消</button><button className="button small primary" data-action="import-relay-client-account" disabled={relayImport.loading || !!relayImport.error || !relayImportId || !relayImport.candidates.some(candidate => candidate.id === relayImportId) || busy['import-relay-account']} onClick={() => void importRelay()}><BusyIcon active={!!busy['import-relay-account']}><ArrowDownToLine size={14} /></BusyIcon>{busy['import-relay-account'] ? relayImport.source === 'central' ? '正在连接…' : '正在导入…' : relayImport.source === 'central' ? '连接所选账号' : '导入所选账号'}</button></div></Modal>}
    {confirm && <Modal title={confirm.action === 'logout' ? '清除本地授权' : confirm.account.kind === 'copilot' ? '移除 GitHub 账号' : '删除账号来源'} onClose={() => setConfirm(null)}><div className="modal-body"><p>{confirm.account.kind === 'copilot' ? '移除“' + accountProviderName(confirm.account) + '”在 ModelDock 中的 GitHub 授权和额度缓存。GitHub 账号与原客户端的登录状态保持不变。' : confirm.action === 'logout' ? '清除“' + accountProviderName(confirm.account) + '”在 ModelDock 中的授权和额度缓存。原客户端登录状态不会改变，来源和模型配置保留。' : '删除“' + accountProviderName(confirm.account) + '”及其模型，工具中的相关来源引用也会移除。原客户端文件不会改变。'}</p></div><div className="modal-footer"><button className="button small secondary" onClick={() => setConfirm(null)}>取消</button><button className="button primary danger" disabled={busy['confirm-' + confirm.account.providerId]} onClick={() => void confirmAction()}>确认{confirm.action === 'logout' ? '注销' : '移除'}</button></div></Modal>}
    {contextMenu.menu}
  </section>;
}
