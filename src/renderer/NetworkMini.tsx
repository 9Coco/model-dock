// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { NetworkSample } from '../shared/flowbridge-types';
import { Activity, X } from './MaterialIcon';
import { NetworkChart, networkBytes } from './NetworkPanel';
import { applyTheme } from './theme';
import './NetworkMini.css';

type MiniSnapshot = { state: string; history: NetworkSample[]; theme: 'light' | 'dark'; expanded: boolean; locked: boolean };
type MiniAction = 'open' | 'lock' | 'expand' | 'hide';
declare global { interface Window { networkMonitor?: { snapshot(): Promise<MiniSnapshot>; action(action: MiniAction): Promise<void> } } }

export function NetworkMini() {
  const [value, setValue] = useState<MiniSnapshot>();
  useEffect(() => {
    let live = true;
    async function poll() {
      try {
        const next = await window.networkMonitor?.snapshot();
        if (live && next) {
          setValue(next);
          applyTheme(next.theme);
        }
      } catch { /* The next poll retries while the window is open. */ }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  async function toggle(action: 'lock' | 'expand') {
    const monitor = window.networkMonitor;
    if (!monitor) return;
    await monitor.action(action);
    setValue(await monitor.snapshot());
  }

  const lockLabel = value?.locked ? '解锁小窗' : '锁定小窗';
  const chartLabel = value?.expanded ? '收起曲线' : '展开曲线';
  const sample = value?.state === 'connected' ? value.history.at(-1) : undefined;
  const end = Date.now();
  return <section className="network-mini" onDoubleClick={() => void window.networkMonitor?.action('open')}>
    <header data-draggable={value?.locked === false}>
      <strong>ModelDock · 网速</strong>
      <div className="network-mini-controls" onDoubleClick={event => event.stopPropagation()}>
        <button type="button" aria-label={lockLabel} title={lockLabel} data-locked={Boolean(value?.locked)} onClick={() => void toggle('lock')}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <rect x="4" y="8.5" width="12" height="9" rx="2" />
            <path d={value?.locked ? 'M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5' : 'M6.5 8.5V6a3.5 3.5 0 0 1 6.8-1.2'} />
          </svg>
        </button>
        <button type="button" aria-label={chartLabel} title={chartLabel} aria-expanded={Boolean(value?.expanded)} onClick={() => void toggle('expand')}><Activity size={17} /></button>
        <button type="button" aria-label="隐藏小窗" title="隐藏小窗" onClick={() => void window.networkMonitor?.action('hide')}><X size={16} /></button>
      </div>
    </header>
    <div className="network-metrics">
      <div data-direction="upload"><small>↑ 上传</small><strong>{networkBytes(sample?.uploadRate ?? 0)}/s</strong></div>
      <div data-direction="download"><small>↓ 下载</small><strong>{networkBytes(sample?.downloadRate ?? 0)}/s</strong></div>
    </div>
    {value?.expanded && <NetworkChart samples={value.history} timeWindow={{ start: end - 60_000, end }} />}
  </section>;
}
