// SPDX-License-Identifier: GPL-3.0-or-later
import { isIP } from 'node:net';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_FLOWBRIDGE, NETWORK_SITES, parseNetworkEndpoint, type FlowBridgeSettings, type FlowBridgeSnapshot, type NetworkEngineStatus, type NetworkSample, type NetworkSite, type NetworkCheck } from '../shared/flowbridge-types';
import type { SettingsStore } from './settings';
import { NetworkAuthorizationRequired, NetworkEngineUnavailableError, type NetworkEngine } from './flowbridge-engine';
const KEY = 'network.flowbridge.v1', LEASE = 'network.flowbridge.lease';
const idleStatus = (): NetworkEngineStatus => ({ running: false, cleanupConfirmed: true, localPort: null, uploadBytes: 0, downloadBytes: 0, connections: 0, message: '' });
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function validateNetworkSettings(raw: unknown, previous: FlowBridgeSettings, platform: string, gatewayPort: number): FlowBridgeSettings {
  if (!plain(raw) || Object.keys(raw).some(key => !Object.hasOwn(DEFAULT_FLOWBRIDGE, key))) throw new Error('网络设置字段无效。');
  const next = { ...previous, ...raw };
  if (!['http', 'global'].includes(next.mode) || !['fast', 'compatible'].includes(next.dnsMode) || typeof next.autoConnect !== 'boolean' || typeof next.autoDiscover !== 'boolean' || typeof next.showMiniOnStart !== 'boolean') throw new Error('网络设置选项无效。');
  if (typeof next.address !== 'string' || next.address.length > 512 || /[\s\x00-\x1f\x7f\\]/.test(next.address)) throw new Error('请填写不含凭据的代理地址和端口。');
  if (!next.address) { if (next.autoConnect && !next.autoDiscover) throw new Error('自动连接需要代理地址或启动时自动查找。'); return next; }
  const scheme = next.mode === 'global' ? 'socks5' : 'http';
  let address = next.address;
  if (next.mode !== previous.mode && !Object.hasOwn(raw, 'address')) address = address.replace(/^(?:http|socks5):\/\//, scheme + '://');
  const endpoint = parseNetworkEndpoint(address, next.mode);
  if (!endpoint) throw new Error(`此模式需要 ${scheme}://主机:端口，不接受订阅链接或用户名密码。`);
  const host = endpoint.host.replace(/^\[|\]$/g, ''), port = endpoint.port;
  const canonical = new URL(`http://${endpoint.host}:${port}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const local = /^(?:127\.|localhost$|::1$)/i.test(canonical);
  if (canonical !== host.toLowerCase().replace(/\.$/, '') && !isIP(host)) throw new Error('请使用标准代理主机名或数值 IP。');
  if (local && port === gatewayPort) throw new Error('网络上游不能指向 ModelDock 模型网关。');
  if (next.mode === 'global' && (!isIP(host) || ['0.0.0.0', '::', '255.255.255.255'].includes(host) || host.includes('%') || /^(?:22[4-9]|23\d)\./.test(host) || /^ff/i.test(host))) throw new Error('全局模式需要有效的数值 IPv4/IPv6 地址。');
  if (next.mode === 'global' && platform === 'linux' && local) throw new Error('Linux 全局模式需要手机或局域网代理 IP；本机回环上游暂不支持。');
  next.address = endpoint.address;
  return next;
}
function status(value: NetworkEngineStatus): NetworkEngineStatus {
  if (!plain(value) || typeof value.running !== 'boolean' || typeof value.cleanupConfirmed !== 'boolean' || typeof value.message !== 'string' || ![value.uploadBytes, value.downloadBytes, value.connections].every(v => Number.isSafeInteger(v) && v >= 0) || value.localPort !== null && (!Number.isInteger(value.localPort) || value.localPort < 1 || value.localPort > 65535)) throw new Error('网络组件状态无效，清理状态未知。');
  return { ...value, message: value.message.slice(0, 500) };
}
export interface FlowBridgeOptions {
  platform: string;
  dataDir: string;
  gatewayPort: () => number;
  engine: (progress: (message: string) => void, exit: () => void) => NetworkEngine;
  setHttpRelay?: (port: number | null) => Promise<void>;
  suspendHttpRelay?: () => void;
  now?: () => number;
  discoverCandidates?: (settings: Readonly<FlowBridgeSettings>) => Promise<string[]>;
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
  private persistedAt = 0;
  private previous?: NetworkSample;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private checking = false;
  private automaticGeneration = 0;
  private endpointRevision = 0;
  private automaticRun?: Promise<void>;
  private wakeAutomatic?: () => void;
  constructor(private store: SettingsStore, private options: FlowBridgeOptions) {
    try {
      const saved = store.getManagedState<unknown>(KEY, {});
      // Older explicit autoconnect settings retain their fixed upstream until discovery is enabled.
      const patch = plain(saved) && Object.hasOwn(saved, 'autoConnect') && !Object.hasOwn(saved, 'autoDiscover') ? { ...saved, autoDiscover: false } : saved;
      this.settings = validateNetworkSettings(patch, this.settings, options.platform, options.gatewayPort());
    }
    catch { this.state = 'error'; this.message = '无法读取网络设置，请重新填写代理地址并连接。'; }
    this.active = store.getManagedState(LEASE, false);
    if (this.active) { this.current.cleanupConfirmed = false; this.state = 'error'; this.message = '上次网络会话的清理尚未确认。请点击「恢复网络」。'; }
    try {
      const file = join(options.dataDir, 'history.json');
      if (existsSync(file) && statSync(file).size <= 2 * 1024 * 1024) {
        const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(value)) this.history = value.filter((v): v is NetworkSample => plain(v) && Object.keys(v).length === 5 && ['time', 'uploadRate', 'downloadRate', 'uploadBytes', 'downloadBytes'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0)).sort((a, b) => a.time - b.time).slice(-3600);
      }
    } catch { /* Optional traffic history never prevents existing ModelDock data opening. */ }
    this.prune();
  }
  validateGatewayPort(port: number) {
    validateNetworkSettings({}, this.settings, this.options.platform, port);
  }
  latencyTestProxy(address: string): string {
    if (!address || address !== this.settings.address) throw new Error('请先应用要测试的代理地址。');
    if (this.busy || this.closing) throw new Error('请在网络切换完成后再测速。');
    if (!this.active) return address;
    if (this.state !== 'connected' || !this.current.running || this.current.localPort === null) {
      throw new Error('请等待连接就绪或完成网络恢复后再测速。');
    }
    // Connecting to the phone directly while a TUN is active can send the
    // probe back through the tunnel. Its local HTTP listener uses the same
    // outbound and physical interface as the active connection.
    return `http://127.0.0.1:${this.current.localPort}`;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private prune() { this.history = this.history.filter(v => v.time > this.now() - 3_600_000 && v.time <= this.now()).slice(-3600); }
  snapshot(): FlowBridgeSnapshot {
    this.prune();
    const status = { ...this.current, cleanupConfirmed: !this.active && this.current.cleanupConfirmed };
    return { settings: { ...this.settings }, state: this.state, message: this.message, platform: this.options.platform, status, history: this.history.map(v => ({ ...v })) };
  }
  private getEngine() {
    return this.engine ??= this.options.engine(message => { this.message = message; }, () => {
      if (this.active) { this.options.suspendHttpRelay?.(); this.current = { ...this.current, running: false, cleanupConfirmed: false }; this.state = 'error'; this.message = '网络组件意外退出。请点击「恢复网络」。'; }
    });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.catch(() => {});
    return result;
  }
  async save(patch: Partial<FlowBridgeSettings>, options?: { offlineOnly: boolean }): Promise<FlowBridgeSnapshot> {
    this.cancelAutomatic();
    if (this.busy || this.closing) throw new Error('网络正在切换，请完成或取消后再保存。');
    this.busy = true;
    return this.enqueue(async () => {
      try {
        if (options?.offlineOnly && this.active) throw new Error('网络连接状态已变化。请断开并完成恢复后再修改代理地址。');
        const next = validateNetworkSettings(patch, this.settings, this.options.platform, this.options.gatewayPort());
        const reconnect = this.state === 'connected' && ['address', 'mode', 'dnsMode'].some(k => next[k as keyof FlowBridgeSettings] !== this.settings[k as keyof FlowBridgeSettings]);
        if (reconnect && !next.address) throw new Error('请先断开当前连接，再清除上游代理地址。');
        if (this.active && this.state !== 'connected') throw new Error('请先点击「恢复网络」，完成后再修改网络设置。');
        if (reconnect) await this.stop();
        // Only new namespaced metadata: never migrate/reset providers or app.settings.
        this.store.setManagedState(KEY, next); this.settings = next;
        if (Object.hasOwn(patch, 'address') || Object.hasOwn(patch, 'mode')) this.endpointRevision++;
        if (reconnect) await this.start();
        return this.snapshot();
      } finally { this.busy = false; }
    });
  }
  connect(upstream?: Pick<FlowBridgeSettings, 'address' | 'mode'>): Promise<FlowBridgeSnapshot> {
    this.cancelAutomatic();
    return this.queueConnection(upstream, true);
  }
  private queueConnection(upstream: Pick<FlowBridgeSettings, 'address' | 'mode'> | undefined, allowInstall: boolean) {
    if (this.busy || this.closing) return Promise.reject(new Error('网络操作仍在进行。'));
    this.busy = true; this.cancel = false;
    return this.enqueue(async () => { try { await this.start(upstream, allowInstall); return this.snapshot(); } finally { this.busy = false; } });
  }
  private async start(upstream?: Pick<FlowBridgeSettings, 'address' | 'mode'>, allowInstall = true) {
    // A disconnect or quit can arrive while this start waits in the queue or for the previous session to stop.
    if (this.cancel || this.closing) return;
    if (this.state === 'connected') {
      if (upstream !== undefined) throw new Error('请先断开当前连接再连接新地址。');
      return;
    }
    if (this.active) throw new Error('上次网络清理尚未确认。请点击「恢复网络」。');
    if (!['linux', 'win32'].includes(this.options.platform)) throw new Error('网络接管仅支持 Windows 和 Linux。');
    const patch = upstream === undefined ? {} : { address: upstream?.address, mode: upstream?.mode };
    const next = validateNetworkSettings(patch, this.settings, this.options.platform, this.options.gatewayPort());
    if (!next.address) throw new Error('请填写上游代理地址。');
    if (next.address !== this.settings.address || next.mode !== this.settings.mode) this.store.setManagedState(KEY, next);
    this.settings = next;
    this.state = 'connecting'; this.message = '正在连接代理…'; this.previous = undefined;
    this.store.setManagedState(LEASE, true); this.active = true;
    try {
      this.current = status(await this.getEngine().request<NetworkEngineStatus>('connect', { settings: this.settings, allowInstall: allowInstall && this.settings.mode === 'global' }));
      if (!this.current.running || this.cancel) { await this.stop(); if (this.cancel) return; throw new Error('未确认网络连接就绪。'); }
      if (this.settings.mode === 'http' && this.current.localPort === null) throw new Error('未确认 HTTP 代理监听端口。');
      await this.options.setHttpRelay?.(this.settings.mode === 'http' ? this.current.localPort : null);
      if (this.cancel) { await this.stop(); return; }
      if (!this.current.running) throw new Error('网络组件在连接期间退出。');
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
      throw error instanceof Error ? error : new Error(this.message);
    }
  }
  disconnect(manualRecovery = false): Promise<FlowBridgeSnapshot> {
    this.cancelAutomatic();
    const repair = manualRecovery && this.options.platform === 'win32' && this.active && this.state === 'error';
    this.cancel = true;
    if (this.engine) void this.engine.request('cancel').catch(() => {});
    return this.enqueue(async () => { this.busy = true; try { await this.stop(repair); return this.snapshot(); } finally { this.busy = false; } });
  }
  private async stop(allowInstall = false) {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (!this.active) { this.state = 'idle'; this.message = ''; return; }
    this.options.suspendHttpRelay?.();
    this.state = 'disconnecting'; this.message = '正在恢复网络设置…';
    try {
      this.current = status(await this.getEngine().request<NetworkEngineStatus>('disconnect', { recover: this.active, settings: this.settings, allowInstall }));
      if (!this.current.cleanupConfirmed || this.current.running) throw new Error('网络清理尚未确认。请再次点击「恢复网络」。');
      await this.options.setHttpRelay?.(null);
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
      if (!value.running) { this.options.suspendHttpRelay?.(); this.state = 'error'; this.message = value.message || '网络内核已停止。请点击「恢复网络」。'; return; }
      const time = this.now(), delta = this.previous ? (time - this.previous.time) / 1000 : 0;
      const sample = { time, uploadBytes: value.uploadBytes, downloadBytes: value.downloadBytes, uploadRate: delta > 0 ? Math.max(0, value.uploadBytes - this.previous!.uploadBytes) / delta : 0, downloadRate: delta > 0 ? Math.max(0, value.downloadBytes - this.previous!.downloadBytes) / delta : 0 };
      this.previous = sample;
      this.history.push(sample);
      this.prune();
      if (time - this.persistedAt >= 60_000) this.persistHistory();
    } catch (error) { this.options.suspendHttpRelay?.(); this.state = 'error'; this.message = error instanceof Error ? error.message : '无法读取网络状态。'; }
    finally { this.polling = false; }
  }
  private persistHistory() {
    try { mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 }); const file = join(this.options.dataDir, 'history.json'); writeFileSync(file + '.tmp', JSON.stringify(this.history.slice(-3600)), { mode: 0o600 }); renameSync(file + '.tmp', file); this.persistedAt = this.now(); }
    catch { this.message += '（流量历史保存失败）'; }
  }
  async localProxies(): Promise<string[]> {
    if (this.options.platform !== 'win32' || this.active || this.closing || this.busy || this.checking) {
      throw new Error('请在 Windows 网络断开后查找本机代理。');
    }
    this.busy = true;
    return this.enqueue(async () => {
      try { return await this.getEngine().request<string[]>('localProxies', { gatewayPort: this.options.gatewayPort() }); }
      finally { this.busy = false; }
    });
  }
  async check(site: NetworkSite): Promise<NetworkCheck> {
    if (!NETWORK_SITES.includes(site) || this.busy || this.closing || this.checking) throw new Error('网站无效或网络操作仍在进行。');
    this.checking = true;
    try { return await this.getEngine().request('check', { site }); }
    finally { this.checking = false; }
  }
  private cancelAutomatic() {
    this.automaticGeneration++;
    this.wakeAutomatic?.();
    this.wakeAutomatic = undefined;
  }
  private async automaticCandidates(): Promise<string[]> {
    const saved = this.settings.address;
    if (!this.settings.autoDiscover) return saved ? [saved] : [];
    let found: string[] = [];
    try {
      if (this.options.discoverCandidates) found = await this.options.discoverCandidates({ ...this.settings });
      else if (this.options.platform === 'win32') found = await this.localProxies();
      else {
        const port = parseNetworkEndpoint(saved, this.settings.mode)?.port ?? 38473;
        const scheme = this.settings.mode === 'global' ? 'socks5' : 'http';
        found = (await hotspotCandidates(this.options.platform)).map(host => `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`);
      }
    } catch { /* Saved upstream remains a fallback when network discovery is not ready. */ }
    const valid = Array.isArray(found) ? found.filter(address => typeof address === 'string' && !!parseNetworkEndpoint(address, this.settings.mode)) : [];
    if (saved && valid.includes(saved)) valid.unshift(saved);
    if (saved) valid.push(saved);
    return [...new Set(valid)].slice(0, 16);
  }
  autoConnect(): Promise<void> {
    if (this.automaticRun) return this.automaticRun;
    if (!this.settings.autoConnect || this.active || this.cancel || this.closing) return Promise.resolve();
    const generation = ++this.automaticGeneration;
    const run = this.runAutomatic(generation).catch(error => {
      this.state = 'error'; this.message = error instanceof Error ? error.message : '自动连接失败，请手动重试。';
    });
    this.automaticRun = run;
    void run.finally(() => { if (this.automaticRun === run) this.automaticRun = undefined; });
    return run;
  }
  private async runAutomatic(generation: number) {
    const current = () => generation === this.automaticGeneration && this.settings.autoConnect && !this.cancel && !this.closing;
    const deadline = this.now() + 120_000;
    let expired = false;
    const timeout = setTimeout(() => {
      if (!current()) return;
      expired = true;
      this.cancel = true;
      this.wakeAutomatic?.(); this.wakeAutomatic = undefined;
      if (this.engine) void this.engine.request('cancel').catch(() => {});
    }, 120_000);
    timeout.unref();
    try {
      for (let round = 0; current() && round < 41; round++) {
        this.message = this.settings.autoDiscover ? '正在查找可用代理地址…' : '正在自动连接代理…';
        const candidates = await this.automaticCandidates();
        for (const address of candidates) {
          if (!current() || this.active || this.busy) return;
          if (this.now() >= deadline) { expired = true; return; }
          const previous = { address: this.settings.address, mode: this.settings.mode };
          const attempted = { address: parseNetworkEndpoint(address, previous.mode)!.address, mode: previous.mode };
          const endpointRevision = this.endpointRevision;
          try { await this.queueConnection(attempted, false); return; }
          catch (error) {
            if (this.active) return;
            // An attempt owns only its endpoint change. Keep newer preferences
            // and never restore over a manual endpoint or a cancelled run.
            await this.enqueue(async () => {
              if (!this.active && this.endpointRevision === endpointRevision && this.settings.address === attempted.address && this.settings.mode === attempted.mode && attempted.address !== previous.address) {
                const restored = { ...this.settings, address: previous.address };
                this.store.setManagedState(KEY, restored); this.settings = restored;
              }
            });
            if (!current()) return;
            if (error instanceof NetworkAuthorizationRequired) return;
          }
        }
        if (!current()) return;
        if (this.now() >= deadline || round === 40) { expired = true; return; }
        this.message = '代理地址或上游尚未就绪，等待自动重试（最多两分钟）…';
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.wakeAutomatic = undefined; resolve(); }, 3000);
          timer.unref();
          this.wakeAutomatic = () => { clearTimeout(timer); resolve(); };
        });
      }
    } finally {
      clearTimeout(timeout);
      if (expired && !this.active && !this.closing) this.message = '自动连接等待已结束，请在网络接管页检查代理后重试。';
    }
  }
  async shutdown() {
    this.closing = true;
    try { await this.disconnect(); await this.engine?.close(); }
    catch (error) { this.closing = false; throw error; }
  }
}
export async function hotspotCandidates(platform: string = process.platform): Promise<string[]> {
  const run = promisify(execFile);
  if (platform === 'linux') {
    const { stdout } = await run('/usr/sbin/ip', ['-j', 'route', 'show', 'default'], { timeout: 5000, maxBuffer: 64 * 1024 });
    return [...new Set((JSON.parse(stdout) as { gateway?: string }[]).map(r => r.gateway).filter((v): v is string => !!v && isIP(v) !== 0))];
  }
  return [];
}
