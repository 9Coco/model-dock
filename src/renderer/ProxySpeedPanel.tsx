import { useEffect, useRef, useState } from 'react';
import { NETWORK_SITES, type FlowBridgeSnapshot, type NetworkCheck, type NetworkSite, type SiteLatency } from '../shared/flowbridge-types';
import type { ModelDockApi } from '../shared/types';

type Transfer = 'download' | 'upload';
type Stage = 'sites' | Transfer;
const transfers = ['download', 'upload'] as const;
const transferLabels = { download: '↓ 下载', upload: '↑ 上传' };

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
    <span className="site-mark" aria-hidden="true" />
    <span className="site-name">{site}</span>
    <strong className="site-latency" data-state={result?.state} aria-live="polite">{value}</strong>
    {status && <small className="site-http-status">{status}</small>}
  </button>;
}

export function ProxySpeedPanel({ api, address, networkState }: {
  api: ModelDockApi; address: string; networkState: FlowBridgeSnapshot['state'];
}) {
  const [sites, setSites] = useState<Partial<Record<NetworkSite, SiteLatency>>>({});
  const [rates, setRates] = useState<Partial<Record<Transfer, number>>>({});
  const [stage, setStage] = useState<Stage>();
  const [errors, setErrors] = useState<string[]>([]);
  const [details, setDetails] = useState<NetworkSite>();
  const active = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const disabled = networkState === 'connecting' || networkState === 'disconnecting';
  const measure = async () => {
    if (active.current) return;
    active.current = true;
    const run = ++generation.current;
    const current = () => generation.current === run;
    setSites({}); setRates({}); setErrors([]); setStage('sites');
    try {
      await api.measureNetworkSites(address, result => {
        if (current()) setSites(previous => ({ ...previous, [result.site]: result }));
      });
      for (const transfer of transfers) {
        if (!current()) return;
        setStage(transfer);
        try {
          const rate = await api.measureNetworkSpeed(address, transfer);
          if (current()) setRates(previous => ({ ...previous, [transfer]: rate }));
        } catch {
          if (current()) setErrors(previous => [...previous, transferLabels[transfer] + '测速失败']);
        }
      }
    } catch (error) {
      if (current()) setErrors([error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '代理测速失败。']);
    } finally {
      active.current = false;
      if (current()) setStage(undefined);
    }
  };
  return <section className="panel proxy-speed-panel" aria-label="代理测速">
    <div className="section-heading">
      <div><h2>代理测速</h2><p className="network-hint">{address ? '经 ' + address + ' 测量官网 HTTPS 响应延迟' : '请先填写并应用上游代理地址。'}</p></div>
      <button className="button primary small" data-action="measure-proxy-speed" disabled={!address || disabled || !!stage} onClick={() => void measure()}>{stage ? '测速中…' : '一键测速'}</button>
    </div>
    <div className="site-tiles" role="group" aria-label="网站延迟">
      {NETWORK_SITES.map(site => <SiteTile key={site} site={site} result={sites[site]} pending={stage === 'sites'}
        selected={details === site} onClick={() => setDetails(previous => previous === site ? undefined : site)} />)}
    </div>
    <div className="transfer-rates" aria-live="polite"><span>Cloudflare 测速</span>
      {transfers.map(key => <span key={key} data-direction={key}>{transferLabels[key]} <strong data-speed-result={key}>{rates[key] !== undefined ? rates[key].toFixed(1) + ' Mbps' : stage === key ? '测量中…' : '—'}</strong></span>)}
    </div>
    {errors.length > 0 && <p className="feature-error" role="alert">{errors.join(' · ')}</p>}
    {details && <SiteDetails key={details + networkState} site={details} api={api} disabled={disabled} />}
  </section>;
}
