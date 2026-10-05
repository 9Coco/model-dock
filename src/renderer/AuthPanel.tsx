import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronDown, Clock3, Ellipsis, Info, KeyRound, LogOut, Plus, RefreshCw, Trash2, UserRound } from './MaterialIcon';
import type { ModelDockApi } from '../shared/types';
import type { AuthAccount, AuthAccountKind, SubscriptionKind, SubscriptionUsage } from '../shared/auth-types';
import { QUOTA_CACHE_TTL_MS, quotaAmountLabel, quotaCacheExpired, quotaDateLabel, quotaExpiryLabel, quotaPercent, quotaPercentLabel, quotaQueryAge, quotaRefreshDue, quotaResetLabel, quotaRetryAt, resetCreditsLabel } from '../shared/quota-display';
import { BusyIcon, Modal, type Notify } from './components';
import { ToolIcon } from './ToolIcon';
import { AccountAvatar } from './AccountAvatar';

const kinds: AuthAccountKind[] = ['copilot', 'codex', 'grok'];
const titles: Record<AuthAccountKind, string> = { copilot: 'GitHub Copilot', codex: 'ChatGPT / OpenAI', grok: 'xAI / Grok' };
const statuses: Record<AuthAccount['authStatus'], string> = { ready: '已授权', missing: '未授权', 'signing-in': '等待登录', error: '需重新授权', expired: '授权已过期' };

function AccountBrand({ kind }: { kind: AuthAccountKind }) {
  return kind === 'grok' ? <span className="auth-brand-xai" aria-hidden="true">xAI</span> : <ToolIcon tool={kind === 'copilot' ? 'copilot' : 'codex'} />;
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

export function AuthPanel({ api, notify, onLogin, onCopilotLogin, onChanged }: {
  api?: ModelDockApi; notify: Notify;
  onLogin: (providerId: string) => void | Promise<void>;
  onCopilotLogin?: () => void | Promise<void>;
  onChanged?: () => void | Promise<void>;
}) {
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [draft, setDraft] = useState<{ kind: SubscriptionKind; name: string } | null>(null);
  const [confirm, setConfirm] = useState<{ account: AuthAccount; action: 'logout' | 'delete' } | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [detailAccount, setDetailAccount] = useState<AuthAccount | null>(null);
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
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const refreshQuota = useCallback(async (account: AuthAccount, manual = false) => {
    if (!api || inFlight.current.has(account.providerId)) return;
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
    try { await action(); await load(); await onChanged?.(); }
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
  const confirmAction = () => confirm && run('confirm-' + confirm.account.providerId, async () => {
    const { account, action } = confirm;
    if (account.kind === 'copilot') await api!.copilotLogoutAccount(account.providerId);
    else if (action === 'logout') await api!.logoutAccount(account.providerId);
    else await api!.deleteProvider(account.providerId);
    notify(account.kind === 'copilot' ? '已移除 ModelDock 中的 GitHub 账号授权和额度缓存。' : action === 'logout' ? '已清除 ModelDock 中的本地授权。' : '账号来源及其模型已删除。'); setConfirm(null);
  });

  const closeAccountMenu = () => { setMenuId(null); menuTrigger.current?.focus(); };
  const inspectedAccount = detailAccount ? accounts.find(account => account.providerId === detailAccount.providerId) ?? null : null;
  return <section className="feature-panel auth-panel auth-compact">
    <div className="feature-toolbar auth-compact-toolbar"><p>账户额度与授权</p><button className="button small secondary" data-action="reload-auth-accounts" onClick={() => void run('reload', load)} disabled={busy.reload}><BusyIcon active={!!busy.reload}><RefreshCw size={13} /></BusyIcon>刷新列表</button></div>
    {error && <p className="feature-error" role="alert">{error}</p>}
    {kinds.map(kind => {
      const group = accounts.filter(account => account.kind === kind);
      return <div className="account-group" key={kind} data-auth-kind={kind}>
        <div className="account-group-header"><h2><AccountBrand kind={kind} />{titles[kind]}<span className="count-tag">{group.length}</span></h2><div className="row-actions">
          {kind === 'copilot' ? <button className="button small secondary" data-action="copilot-login" data-auth-add-account={kind} disabled={busy['login-copilot']} onClick={() => void run('login-copilot', loginCopilot)}><Plus size={13} />登录 GitHub</button> : <>
            <button className="button small secondary" data-auth-import-account={kind} disabled={busy['import-' + kind]} onClick={() => void importLocal(kind)} title="仅在点击时导入本机客户端已有授权"><BusyIcon active={!!busy['import-' + kind]}><ArrowDownToLine size={13} /></BusyIcon>从客户端导入</button>
            <button className="button small secondary" data-auth-add-account={kind} onClick={() => setDraft({ kind, name: titles[kind] + ' 账号 ' + (group.length + 1) })}><Plus size={13} />添加账号</button>
          </>}
        </div></div>
        {group.length === 0 ? <div className="auth-empty-row" data-auth-empty={kind}><UserRound size={14} /><span>尚未添加账号</span><small>{kind === 'copilot' ? '登录 GitHub 后查看额度' : '登录或导入已有授权'}</small></div> : group.map(account => {
          const stale = quotaCacheExpired(account.usage, now), opened = menuId === account.providerId;
          const queried = account.usage.queriedAt ? quotaQueryAge(account.usage.queriedAt, now).replace(/查询$/, '') : '未查询';
          return <article className="account-row" key={account.providerId} data-auth-account={account.providerId} data-account-id={account.providerId} data-quota-status={stale ? 'stale' : account.usage.status}>
            <div className="account-identity" title={account.email ?? account.displayName ?? account.providerName}>
              <AccountAvatar account={account} />
              <i className={'auth-identity-dot ' + account.authStatus} role="img" aria-label={statuses[account.authStatus]} title={statuses[account.authStatus]} />
              <div className="auth-identity-content"><strong>{account.email ?? account.displayName ?? account.providerName}</strong>{account.plan && <span className="account-plan">{account.plan}</span>}{account.authStatus !== 'ready' && <small className="auth-identity-status">{statuses[account.authStatus]}</small>}</div>
            </div>
            <div className="account-quotas">
              {account.usage.windows.map(window => {
                const remaining = quotaPercent(window.remainingPercent), amount = quotaAmountLabel(window);
                const remainingLabel = window.unlimited ? '不限量' : remaining === undefined ? '未知' : quotaPercentLabel(remaining);
                return <div className={'quota-window' + (remaining !== undefined && remaining <= 20 ? ' quota-low' : '') + (remaining === undefined && !window.unlimited ? ' quota-unknown' : '')} key={window.id} data-quota-window-id={window.id} data-remaining-percent={remaining ?? ''}>
                  <span className="auth-window-label" title={window.label + (window.measurement === 'protobuf-default' ? ' · 按协议默认值解析' : '')}>{window.label}{window.measurement === 'protobuf-default' && <sup title="上游省略字段；根据该额度窗口的协议默认值解析">＊</sup>}</span>
                  {!window.unlimited ? <progress value={remaining ?? 0} max={100} aria-label={window.label + (stale ? '上次剩余 ' : '剩余 ') + remainingLabel} /> : <span className="auth-window-unlimited" aria-hidden="true" />}
                  <strong data-quota-amount={amount} title={amount ?? (remaining === undefined ? '上游未返回剩余额度' : '剩余额度')}>{remainingLabel}</strong>
                  <small className="auth-window-reset" title={window.resetAt ? quotaDateLabel(window.resetAt) + '（香港时间）' : '上游未返回重置时间'}>{quotaResetLabel(window.resetAt, now)}</small>
                </div>;
              })}
              {account.usage.windows.length === 0 && <p className="quota-unavailable" data-quota-message title={account.usage.message}>{account.usage.message}</p>}
              {kind === 'codex' && <ResetCredits usage={account.usage} now={now} />}
            </div>
            <div className="account-actions">
              <small className={'auth-row-age' + (stale ? ' quota-stale' : '')} title={(stale ? '缓存结果 · ' : '') + (account.usage.queriedAt ? quotaDateLabel(account.usage.queriedAt) + '（香港时间）' : '尚未查询') + (stale ? ' · ' + account.usage.message : '')}>{busy['usage-' + account.providerId] ? '查询中' : queried}</small>
              <button className="icon-button" data-action="refresh-account-quota" data-account-id={account.providerId} aria-label={'刷新 ' + account.providerName + ' 额度'} title="刷新账户额度" disabled={busy['usage-' + account.providerId] || account.authStatus === 'missing' || account.authStatus === 'signing-in'} onClick={() => void refreshQuota(account, true)}><BusyIcon active={!!busy['usage-' + account.providerId]}><RefreshCw size={14} /></BusyIcon></button>
              <div className="auth-account-menu-root" ref={opened ? menuRoot : undefined}>
                <button className="icon-button" data-action="account-menu" data-account-id={account.providerId} aria-label={'账号操作 ' + account.providerName} aria-haspopup="menu" aria-expanded={opened} onClick={event => { menuTrigger.current = event.currentTarget; setMenuId(opened ? null : account.providerId); }}><Ellipsis size={16} /></button>
                {opened && <div className="auth-account-menu" data-auth-account-menu={account.providerId} role="menu" aria-label={account.providerName + '操作'}>
                  <button role="menuitem" data-action="account-details" onClick={() => { closeAccountMenu(); setDetailAccount(account); }}><Info size={14} />账号详情</button>
                  <button role="menuitem" data-action="account-reauth" disabled={busy['login-' + account.providerId] || account.authStatus === 'signing-in'} onClick={() => { closeAccountMenu(); void run('login-' + account.providerId, async () => { if (kind === 'copilot') await loginCopilot(); else await onLogin(account.providerId); }); }}><KeyRound size={14} />{account.authStatus === 'ready' ? '重新授权' : '登录'}</button>
                  <button role="menuitem" data-action="account-logout" aria-label={'注销 ' + account.providerName} disabled={account.authStatus === 'missing'} onClick={() => { closeAccountMenu(); setConfirm({ account, action: 'logout' }); }}><LogOut size={14} />清除本地授权</button>
                  <button role="menuitem" className="danger" data-action="account-delete" aria-label={'删除 ' + account.providerName} onClick={() => { closeAccountMenu(); setConfirm({ account, action: 'delete' }); }}><Trash2 size={14} />{kind === 'copilot' ? '移除账号' : '删除账号来源'}</button>
                </div>}
              </div>
            </div>
          </article>;
        })}
      </div>;
    })}
    <p className="feature-footnote">账户额度包含其他客户端用量。访问凭据到期与套餐到期不同；账号详情可在 ⋯ 菜单查看。</p>
    {inspectedAccount && <Modal title="账号详情" onClose={() => setDetailAccount(null)}><div className="modal-body auth-account-details" data-auth-account-details={inspectedAccount.providerId}><dl>
      <div><dt>账号</dt><dd>{inspectedAccount.email ?? inspectedAccount.displayName ?? inspectedAccount.providerName}</dd></div>
      <div><dt>账号名称</dt><dd>{inspectedAccount.providerName}</dd></div>
      <div><dt>平台 / 套餐</dt><dd>{titles[inspectedAccount.kind]}{inspectedAccount.plan ? ' · ' + inspectedAccount.plan : ''}</dd></div>
      <div><dt>授权状态</dt><dd>{statuses[inspectedAccount.authStatus]}</dd></div>
      <div><dt>访问凭据到期</dt><dd>{quotaDateLabel(inspectedAccount.expiresAt)}</dd></div>
      <div><dt>自动续期</dt><dd>{inspectedAccount.canRefresh ? '支持' : '未提供续期凭据'}</dd></div>
      <div><dt>授权来源</dt><dd>{inspectedAccount.source === 'client-import' ? '客户端导入' : 'ModelDock 登录'}</dd></div>
      <div><dt>额度查询</dt><dd>{inspectedAccount.usage.queriedAt ? quotaDateLabel(inspectedAccount.usage.queriedAt) + '（香港时间）' : '尚未查询'}</dd></div>
    </dl><p>{inspectedAccount.usage.message}</p>{inspectedAccount.usage.resetCreditsMessage && <p>{inspectedAccount.usage.resetCreditsMessage}</p>}{inspectedAccount.usage.windows.map(window => <p key={window.id}>{window.label}：{quotaAmountLabel(window) ?? '剩余 ' + quotaPercentLabel(window.remainingPercent)} · {quotaResetLabel(window.resetAt, now)}{window.measurement === 'protobuf-default' ? ' · 按协议默认值解析' : ''}</p>)}</div><div className="modal-footer"><button className="button secondary" onClick={() => setDetailAccount(null)}>关闭</button></div></Modal>}
    {draft && <Modal title={'添加 ' + titles[draft.kind] + ' 账号'} subtitle="创建独立订阅来源，然后在浏览器完成本人账号授权。" onClose={() => setDraft(null)}><div className="modal-body"><label className="form-field">账号名称<input value={draft.name} maxLength={120} autoFocus onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : null)} onKeyDown={event => { if (event.key === 'Enter') void add(); }} /></label></div><div className="modal-footer"><button className="button small secondary" onClick={() => setDraft(null)}>取消</button><button className="button small primary" disabled={busy['add-account']} onClick={() => void add()}><BusyIcon active={!!busy['add-account']}><KeyRound size={16} /></BusyIcon>创建并登录</button></div></Modal>}
    {confirm && <Modal title={confirm.action === 'logout' ? '清除本地授权' : confirm.account.kind === 'copilot' ? '移除 GitHub 账号' : '删除账号来源'} onClose={() => setConfirm(null)}><div className="modal-body"><p>{confirm.account.kind === 'copilot' ? '移除“' + confirm.account.providerName + '”在 ModelDock 中的 GitHub 授权和额度缓存。GitHub 账号与原客户端的登录状态保持不变。' : confirm.action === 'logout' ? '清除“' + confirm.account.providerName + '”在 ModelDock 中的授权和额度缓存。原客户端登录状态不会改变，来源和模型配置保留。' : '删除“' + confirm.account.providerName + '”及其模型，工具中的相关来源引用也会移除。原客户端文件不会改变。'}</p></div><div className="modal-footer"><button className="button small secondary" onClick={() => setConfirm(null)}>取消</button><button className="button primary danger" disabled={busy['confirm-' + confirm.account.providerId]} onClick={() => void confirmAction()}>确认{confirm.action === 'logout' ? '注销' : '移除'}</button></div></Modal>}
  </section>;
}
