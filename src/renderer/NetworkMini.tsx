// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import type { NetworkSample } from '../shared/flowbridge-types';
import { NetworkChart, networkBytes } from './NetworkPanel';
import { applyTheme } from './theme';
type MiniSnapshot = { state: string; history: NetworkSample[]; theme: 'light' | 'dark'; expanded: boolean; locked: boolean };
declare global { interface Window { networkMonitor?: { snapshot(): Promise<MiniSnapshot>; action(action: string): Promise<void> } } }
export function NetworkMini() {
  const [value, setValue] = useState<MiniSnapshot>();
  useEffect(() => { let live = true; const poll = async () => { try { const next = await window.networkMonitor!.snapshot(); if (live) { setValue(next); applyTheme(next.theme); } } catch {} }; void poll(); const timer = setInterval(() => void poll(), 1000); return () => { live = false; clearInterval(timer); }; }, []);
  const sample = value?.state === 'connected' ? value.history.at(-1) : undefined;
  return <section className="network-mini" onDoubleClick={() => void window.networkMonitor?.action('open')}><header><strong>ModelDock · 网络</strong><button aria-label="锁定小窗" onClick={() => void window.networkMonitor?.action('lock')}>{value?.locked ? '解锁' : '锁定'}</button><button aria-label="展开曲线" onClick={() => void window.networkMonitor?.action('expand')}>{value?.expanded ? '收起' : '曲线'}</button><button aria-label="隐藏小窗" onClick={() => void window.networkMonitor?.action('hide')}>×</button></header><div className="network-metrics"><div data-direction="upload"><small>↑ 上传</small><strong>{networkBytes(sample?.uploadRate ?? 0)}/s</strong></div><div data-direction="download"><small>↓ 下载</small><strong>{networkBytes(sample?.downloadRate ?? 0)}/s</strong></div></div>{value?.expanded && <NetworkChart samples={value.history} />}</section>;
}
