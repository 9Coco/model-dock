import { useLayoutEffect, useRef, useState } from 'react';
import { NETWORK_SITES, parseNetworkEndpoint, type FlowBridgeSnapshot, type NetworkCheck, type NetworkMode, type NetworkSite, type SiteLatency } from '../shared/flowbridge-types';
import type { ModelDockApi } from '../shared/types';
import jetBrainsAi from './assets/model-series-icons/jetbrains-ai.svg?no-inline';

type Stage = 'sites' | 'finishing';

function SiteDetails({ site, api, disabled }: { site: NetworkSite; api: ModelDockApi; disabled: boolean }) {
  const [check, setCheck] = useState<NetworkCheck>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const diagnose = async () => {
    setChecking(true);
    setError('');
    try { setCheck(await api.checkNetworkSite(site)); }
    catch { setError('检测失败，请稍后重试。'); }
    finally { setChecking(false); }
  };
  return <div className="site-details" data-site-details={site}>
    <div className="network-actions"><strong>{site}</strong>
      <button className="button secondary small" disabled={checking || disabled} onClick={() => void diagnose()}>{checking ? '检测中…' : '对比系统与代理'}</button>
      <button className="text-button" onClick={() => void api.openNetworkSite(site).catch(() => setError('无法打开浏览器。'))}>浏览器验证</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {check && <div className="network-checks">{(['system', 'proxy'] as const).map(path => {
      const result = check[path];
      return <div key={path}><strong>{path === 'system' ? '系统网络' : '代理出口'}</strong>
        {result ? <><span>{result.browser_verification ? '需浏览器验证' : result.ok ? '检测通过' : '自动检测未确认'}</span>
          <small>{result.detail} · {result.elapsed_ms} ms{result.status_code ? ' · HTTP ' + result.status_code : ''}</small></> : <span>请先连接代理</span>}
      </div>;
    })}</div>}
  </div>;
}

function SiteTile({ site, result, pending, selected, onClick }: {
  site: NetworkSite; result?: SiteLatency; pending: boolean; selected: boolean; onClick: () => void;
}) {
  let value = pending ? '测量中…' : '—';
  let status = '';
  if (result?.state === 'response') {
    value = result.ms + ' ms';
    if (result.httpStatus && result.httpStatus >= 400) status = 'HTTP ' + result.httpStatus;
  } else if (result) {
    value = result.state === 'timeout' ? '超时' : '连接失败';
  }
  return <button type="button" className="site-tile" data-site={site} aria-expanded={selected}
    aria-label={site + '，' + value + (status ? '，' + status : '') + '，网站详情'} onClick={onClick}>
    <span className="site-mark" aria-hidden="true">{site === 'JetBrains AI' && <img src={jetBrainsAi} alt="" draggable={false} />}</span>
    <span className="site-name">{site}</span>
    <strong className="site-latency" data-state={result?.state} aria-live="polite">{value}</strong>
    {status && <small className="site-http-status">{status}</small>}
  </button>;
}

export function ProxySpeedPanel({ api, address, mode, networkState, prepareAddress, needsRecovery }: {
  api: ModelDockApi; address: string; mode: NetworkMode; networkState: FlowBridgeSnapshot['state'];
  prepareAddress?: () => Promise<string>; needsRecovery?: boolean;
}) {
  const [sites, setSites] = useState<Partial<Record<NetworkSite, SiteLatency>>>({});
  const [stage, setStage] = useState<Stage>();
  const [errors, setErrors] = useState<string[]>([]);
  const [details, setDetails] = useState<NetworkSite>();
  const active = useRef(false);
  const generation = useRef(0);
  const disabled = needsRecovery || networkState === 'connecting' || networkState === 'disconnecting';
  const target = parseNetworkEndpoint(address, mode)?.address ?? address;
  const route = disabled ? 'switching' : networkState === 'connected' ? 'session' : 'direct';
  useLayoutEffect(() => {
    setSites({}); setErrors([]); setDetails(undefined);
    setStage(active.current ? 'finishing' : undefined);
    return () => { generation.current++; };
  }, [target, mode, route]);
  const measure = async () => {
    if (active.current) return;
    active.current = true;
    const run = ++generation.current;
    const current = () => generation.current === run;
    setSites({}); setErrors([]); setStage('sites');
    try {
      const proxy = prepareAddress ? await prepareAddress() : address;
      if (!current()) return;
      await api.measureNetworkSites(proxy, result => {
        if (current()) setSites(previous => ({ ...previous, [result.site]: result }));
      });
    } catch (error) {
      if (current()) setErrors([error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '代理测速失败。']);
    } finally {
      active.current = false;
      setStage(undefined);
    }
  };
  return <section className="panel proxy-speed-panel" aria-label="代理测速">
    <div className="section-heading">
      <div><h2>代理测速</h2><p className="network-hint">{address.trim() ? '经 ' + address + ' 测量官网 HTTPS 响应延迟' : '填写上游代理地址即可测速。'}</p></div>
      <button className="button primary small" data-action="measure-proxy-speed" disabled={!address.trim() || disabled || !!stage} onClick={() => void measure()}>{stage === 'finishing' ? '等待上次测速…' : stage ? '测速中…' : '一键测速'}</button>
    </div>
    <div className="site-tiles" role="group" aria-label="网站延迟">
      {NETWORK_SITES.map(site => <SiteTile key={site} site={site} result={sites[site]} pending={stage === 'sites'}
        selected={details === site} onClick={() => setDetails(previous => previous === site ? undefined : site)} />)}
    </div>
    {errors.length > 0 && <p className="feature-error" role="alert">{errors.join(' · ')}</p>}
    {details && <SiteDetails key={details + networkState} site={details} api={api} disabled={disabled} />}
  </section>;
}
