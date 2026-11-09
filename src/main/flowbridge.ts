// SPDX-License-Identifier: GPL-3.0-or-later
import { isIP } from 'node:net';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_FLOWBRIDGE, NETWORK_SITES, type FlowBridgeSettings, type FlowBridgeSnapshot, type NetworkEngineStatus, type NetworkSample, type NetworkSite, type NetworkCheck } from '../shared/flowbridge-types';
import type { SettingsStore } from './settings';
import { NetworkEngineUnavailableError, type NetworkEngine } from './flowbridge-engine';
const KEY = 'network.flowbridge.v1', LEASE = 'network.flowbridge.lease';
const idleStatus = (): NetworkEngineStatus => ({ running: false, cleanupConfirmed: true, localPort: null, uploadBytes: 0, downloadBytes: 0, connections: 0, message: '' });
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function validateNetworkSettings(raw: unknown, previous: FlowBridgeSettings, platform: string, gatewayPort: number): FlowBridgeSettings {
  if (!plain(raw) || Object.keys(raw).some(key => !Object.hasOwn(DEFAULT_FLOWBRIDGE, key))) throw new Error('网络设置字段无效。');
  const next = { ...previous, ...raw };
  if (!['http', 'global'].includes(next.mode) || !['fast', 'compatible'].includes(next.dnsMode) || typeof next.autoConnect !== 'boolean' || typeof next.showMiniOnStart !== 'boolean') throw new Error('网络设置选项无效。');
  if (typeof next.address !== 'string' || next.address.length > 512 || /[\s\x00-\x1f\x7f\\]/.test(next.address)) throw new Error('请填写不含凭据的代理地址和端口。');
  if (!next.address) { if (next.autoConnect) throw new Error('自动连接需要先保存代理地址。'); return next; }
  const scheme = next.mode === 'global' ? 'socks5' : 'http';
  let address = next.address;
  if (next.mode !== previous.mode && !Object.hasOwn(raw, 'address')) address = address.replace(/^(?:http|socks5):\/\//, scheme + '://');
  if (!address.includes('://')) address = scheme + '://' + address;
  const match = /^(http|socks5):\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):([0-9]+)\/?$/.exec(address);
  if (!match || match[1] !== scheme || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new Error(`此模式需要 ${scheme}://主机:端口，不接受订阅链接或用户名密码。`);
  const host = match[2].replace(/^\[|\]$/g, ''), port = Number(match[3]);
  const canonical = new URL(`http://${match[2]}:${port}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const local = /^(?:127\.|localhost$|::1$)/i.test(canonical);
  if (canonical !== host.toLowerCase().replace(/\.$/, '') && !isIP(host)) throw new Error('请使用标准代理主机名或数值 IP。');
  if (local && port === gatewayPort) throw new Error('网络上游不能指向 ModelDock 模型网关。');
  if (next.mode === 'global' && (!isIP(host) || ['0.0.0.0', '::', '255.255.255.255'].includes(host) || host.includes('%') || /^(?:22[4-9]|23\d)\./.test(host) || /^ff/i.test(host))) throw new Error('全局模式需要有效的数值 IPv4/IPv6 地址。');
  if (next.mode === 'global' && platform === 'linux' && local) throw new Error('Linux 全局模式需要手机或局域网代理 IP；本机回环上游暂不支持。');
  next.address = `${scheme}://${match[2].toLowerCase()}:${port}`;
  return next;
}
function status(value: NetworkEngineStatus): NetworkEngineStatus {
  if (!plain(value) || typeof value.running !== 'boolean' || typeof value.cleanupConfirmed !== 'boolean' || typeof value.message !== 'string' || ![value.uploadBytes, value.downloadBytes, value.connections].every(v => Number.isSafeInteger(v) && v >= 0) || value.localPort !== null && (!Number.isInteger(value.localPort) || value.localPort < 1 || value.localPort > 65535)) throw new Error('网络组件状态无效，清理状态未知。');
  return { ...value, message: value.message.slice(0, 500) };
}
export class FlowBridgeManager {
  private settings: FlowBridgeSettings = { ...DEFAULT_FLOWBRIDGE };
  private state: FlowBridgeSnapshot['state'] = 'idle';
  private message = '';
  private current = idleStatus();
  private engine?: NetworkEngine;
  private serial: Promise<unknown> = Promise.resolve();
  private busy = false;
  private closing = false;
  private cancel = false;
  private active = false;
  private history: NetworkSample[] = [];
  private live: NetworkSample[] = [];
  private previous?: NetworkSample;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private checking = false;
  constructor(private store: SettingsStore, private options: { platform: string; dataDir: string; gatewayPort: () => number; engine: (progress: (message: string) => void, exit: () => void) => NetworkEngine; now?: () => number }) {
    try { this.settings = validateNetworkSettings(store.getManagedState(KEY, {}), this.settings, options.platform, options.gatewayPort()); }
    catch { this.state = 'error'; this.message = '已保留无法读取的网络设置，请重新保存网络配置；原有模型数据未改动。'; }
    this.active = store.getManagedState(LEASE, false);
    if (this.active) { this.current.cleanupConfirmed = false; this.state = 'error'; this.message = '上次网络会话未确认清理，请点击断开恢复；不会自动重连。'; }
    try {
      const file = join(options.dataDir, 'history.json');
      if (existsSync(file) && statSync(file).size <= 512 * 1024) {
        const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(value)) this.history = value.filter((v): v is NetworkSample => plain(v) && Object.keys(v).length === 5 && ['time', 'uploadRate', 'downloadRate', 'uploadBytes', 'downloadBytes'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0)).slice(-1440);
      }
    } catch { /* Optional traffic history never prevents existing ModelDock data opening. */ }
    this.prune();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private prune() { this.history = this.history.filter(v => v.time > this.now() - 86_400_000 && v.time <= this.now()); }
  snapshot(): FlowBridgeSnapshot {
    this.prune();
    return { settings: { ...this.settings }, state: this.state, message: this.message, platform: this.options.platform, status: { ...this.current }, history: [...this.history, ...this.live].map(v => ({ ...v })) };
  }
  private getEngine() {
    return this.engine ??= this.options.engine(message => { this.message = message; }, () => {
      if (this.active) { this.current = { ...this.current, running: false, cleanupConfirmed: false }; this.state = 'error'; this.message = '网络组件意外退出，请点击断开检查恢复记录。'; }
    });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.catch(() => {});
    return result;
  }
  async save(patch: Partial<FlowBridgeSettings>): Promise<FlowBridgeSnapshot> {
    if (this.busy || this.closing) throw new Error('网络正在切换，请完成或取消后再保存。');
    const next = validateNetworkSettings(patch, this.settings, this.options.platform, this.options.gatewayPort());
    const reconnect = this.state === 'connected' && ['address', 'mode', 'dnsMode'].some(k => next[k as keyof FlowBridgeSettings] !== this.settings[k as keyof FlowBridgeSettings]);
    if (this.active && this.state !== 'connected') throw new Error('请先断开并确认恢复完成，再修改网络设置。');
    this.busy = true;
    return this.enqueue(async () => {
      try {
        if (reconnect) await this.stop();
        // Only new namespaced metadata: never migrate/reset providers or app.settings.
        this.store.setManagedState(KEY, next); this.settings = next;
        if (reconnect) { this.cancel = false; await this.start(); }
        return this.snapshot();
      } finally { this.busy = false; }
    });
  }
  connect(): Promise<FlowBridgeSnapshot> {
    if (this.busy || this.closing) return Promise.reject(new Error('网络操作仍在进行。'));
    this.busy = true; this.cancel = false;
    return this.enqueue(async () => { try { await this.start(); return this.snapshot(); } finally { this.busy = false; } });
  }
  private async start() {
    if (this.state === 'connected') return;
    if (this.active) throw new Error('上次网络清理未确认，请先断开恢复。');
    if (!this.settings.address) throw new Error('请先保存代理地址。');
    if (!['linux', 'win32'].includes(this.options.platform)) throw new Error('网络接管仅支持 Windows 和 Linux。');
    this.settings = validateNetworkSettings(this.settings, this.settings, this.options.platform, this.options.gatewayPort());
    this.state = 'connecting'; this.message = '正在连接代理…'; this.previous = undefined;
    this.store.setManagedState(LEASE, true); this.active = true;
    try {
      this.current = status(await this.getEngine().request<NetworkEngineStatus>('connect', { settings: this.settings }));
      if (!this.current.running || this.cancel) { await this.stop(); if (this.cancel) return; throw new Error('未确认网络连接就绪。'); }
      this.state = 'connected'; this.message = '已连接';
      this.timer ??= setInterval(() => { void this.sample(); }, 1000);
      this.timer.unref();
    } catch (error) {
      // Request a confirmed rollback even when setup/probes failed. Unknown
      // cleanup retains the durable lease and blocks another connection.
      if (error instanceof NetworkEngineUnavailableError) {
        this.store.setManagedState(LEASE, false); this.active = false; this.current = idleStatus(); this.engine = undefined;
      } else { try { await this.stop(); } catch { /* state remains uncertain */ } }
      this.state = 'error'; this.message = error instanceof Error ? error.message : '网络连接失败。';
      throw new Error(this.message);
    }
  }
  disconnect(): Promise<FlowBridgeSnapshot> {
    this.cancel = true;
    if (this.engine) void this.engine.request('cancel').catch(() => {});
    return this.enqueue(async () => { this.busy = true; try { await this.stop(); return this.snapshot(); } finally { this.busy = false; } });
  }
  private async stop() {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (!this.active) { this.state = 'idle'; this.message = ''; return; }
    this.state = 'disconnecting'; this.message = '正在恢复网络设置…';
    try {
      this.current = status(await this.getEngine().request<NetworkEngineStatus>('disconnect', { recover: this.active, settings: this.settings }));
      if (!this.current.cleanupConfirmed || this.current.running) throw new Error('清理尚未确认，请重试断开。');
      this.store.setManagedState(LEASE, false); this.active = false;
      this.state = 'idle'; this.message = this.current.message || '已断开，网络设置已恢复'; this.previous = undefined;
      this.persistHistory();
    } catch (error) { this.state = 'error'; this.current.cleanupConfirmed = false; this.message = error instanceof Error ? error.message : '网络恢复失败。'; throw error; }
  }
  private async sample() {
    if (this.polling || this.checking || this.busy || this.state !== 'connected') return;
    this.polling = true;
    try {
      const value = status(await this.getEngine().request<NetworkEngineStatus>('snapshot'));
      if (this.state !== 'connected') return;
      this.current = value;
      if (!value.running) { this.state = 'error'; this.message = value.message || '网络内核已停止，请点击断开恢复。'; return; }
      const time = this.now(), delta = this.previous ? (time - this.previous.time) / 1000 : 0;
      const sample = { time, uploadBytes: value.uploadBytes, downloadBytes: value.downloadBytes, uploadRate: delta > 0 ? Math.max(0, value.uploadBytes - this.previous!.uploadBytes) / delta : 0, downloadRate: delta > 0 ? Math.max(0, value.downloadBytes - this.previous!.downloadBytes) / delta : 0 };
      this.previous = sample; this.live.push(sample); this.live = this.live.slice(-60);
      if (!this.history.length || time - this.history.at(-1)!.time >= 60_000) { this.history.push(sample); this.prune(); this.persistHistory(); }
    } catch (error) { this.state = 'error'; this.message = error instanceof Error ? error.message : '无法读取网络状态。'; }
    finally { this.polling = false; }
  }
  private persistHistory() {
    try { mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 }); const file = join(this.options.dataDir, 'history.json'); writeFileSync(file + '.tmp', JSON.stringify(this.history.slice(-1440)), { mode: 0o600 }); renameSync(file + '.tmp', file); }
    catch { this.message += '（流量历史保存失败）'; }
  }
  async check(site: NetworkSite): Promise<NetworkCheck> {
    if (!NETWORK_SITES.includes(site) || this.busy || this.closing || this.checking) throw new Error('网站无效或网络操作仍在进行。');
    this.checking = true;
    try { return await this.getEngine().request('check', { site }); }
    finally { this.checking = false; }
  }
  async autoConnect() {
    if (!this.settings.autoConnect || this.active) return;
    const deadline = this.now() + 120_000;
    do {
      try { await this.connect(); return; } catch { if (this.active || this.cancel || this.closing) return; }
      if (this.now() >= deadline) return;
      this.message = '上游尚未就绪，等待自动重试（最多两分钟）…';
      await new Promise<void>(resolve => setTimeout(resolve, 3000));
    } while (!this.cancel && !this.closing);
  }
  async shutdown() {
    this.closing = true;
    try { await this.disconnect(); await this.engine?.close(); }
    catch (error) { this.closing = false; throw error; }
  }
}
export async function hotspotCandidates(platform = process.platform): Promise<string[]> {
  const run = promisify(execFile);
  if (platform === 'linux') {
    const { stdout } = await run('/usr/sbin/ip', ['-j', 'route', 'show', 'default'], { timeout: 5000, maxBuffer: 64 * 1024 });
    return [...new Set((JSON.parse(stdout) as { gateway?: string }[]).map(r => r.gateway).filter((v): v is string => !!v && isIP(v) !== 0))];
  }
  if (platform === 'win32') {
    const { stdout } = await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -ExpandProperty NextHop'], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
    return [...new Set(stdout.trim().split(/\s+/).filter(v => isIP(v) !== 0 && v !== '0.0.0.0'))];
  }
  return [];
}
