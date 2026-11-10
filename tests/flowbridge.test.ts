import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowBridgeManager, validateNetworkSettings } from '../src/main/flowbridge';
import { FlowBridgeEngine, NetworkAuthorizationRequired, type NetworkEngine } from '../src/main/flowbridge-engine';
import { DEFAULT_FLOWBRIDGE, type NetworkEngineStatus } from '../src/shared/flowbridge-types';
import { Store } from '../src/main/store';
const folders: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'modeldock-network-test-')); folders.push(path); return path; };
afterEach(() => { vi.useRealTimers(); for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const stopped = (): NetworkEngineStatus => ({ running: false, cleanupConfirmed: true, localPort: null, uploadBytes: 0, downloadBytes: 0, connections: 0, message: '' });
function fixture(platform = 'linux') {
  const values = new Map<string, unknown>(), calls: string[] = [];
  const memory = { getManagedState<T>(k: string, v: T): T { return structuredClone(values.get(k) ?? v) as T; }, setManagedState(k: string, v: unknown) { values.set(k, structuredClone(v)); } };
  let stopFails = false, connectFails = false, failExit: () => void = () => {}, release: (() => void) | undefined;
  const engine: NetworkEngine = { async request<T>(method: string) {
    calls.push(method);
    if (method === 'disconnect' && stopFails) throw new Error('cleanup failed');
    if (method === 'connect') { if (connectFails) throw new Error('UDP preflight rejected'); if (release) await new Promise<void>(resolve => { release = resolve; }); return { ...stopped(), running: true, cleanupConfirmed: false, localPort: 30000 } as T; }
    return stopped() as T;
  }, async close() { calls.push('close'); } };
  const manager = new FlowBridgeManager(memory, { platform, dataDir: temporary(), gatewayPort: () => 18181, engine: (_progress, exit) => { failExit = exit; return engine; } });
  return { manager, memory, values, calls, failStop(value = true) { stopFails = value; }, failConnect() { connectFails = true; }, crash() { failExit(); }, hold() { release = () => {}; }, release() { release?.(); } };
}
describe('FlowBridge integration', () => {
  it('measures through the active listener and only uses the saved upstream directly after cleanup', async () => {
    const f = fixture();
    const address = 'socks5://192.0.2.30:38473';
    await f.manager.save({ address, mode: 'global' });
    expect(f.manager.latencyTestProxy(address)).toBe(address);
    expect(() => f.manager.latencyTestProxy('socks5://192.0.2.31:38473')).toThrow('应用');
    await f.manager.connect();
    expect(f.manager.latencyTestProxy(address)).toBe('http://127.0.0.1:30000');
    f.crash();
    expect(() => f.manager.latencyTestProxy(address)).toThrow('恢复');
    await f.manager.disconnect();
    expect(f.manager.latencyTestProxy(address)).toBe(address);
  });
  it('prepares a typed endpoint for offline testing without connecting or replacing an active session', async () => {
    const f = fixture();
    const saved = await f.manager.save({ address: '192.0.2.30:038473/', mode: 'global' }, { offlineOnly: true });
    expect(saved.state).toBe('idle');
    expect(f.manager.latencyTestProxy(saved.settings.address)).toBe('socks5://192.0.2.30:38473');
    expect(f.calls).toEqual([]);
    const other = { address: '192.0.2.31:38473' };
    const connecting = f.manager.connect();
    await expect(f.manager.save(other, { offlineOnly: true })).rejects.toThrow('正在切换');
    await connecting;
    await expect(f.manager.save(other, { offlineOnly: true })).rejects.toThrow('网络连接状态已变化');
    expect(f.manager.snapshot()).toMatchObject({ state: 'connected', settings: saved.settings });
    expect(f.calls).toEqual(['connect']);
    await f.manager.shutdown();
  });
  it('requires explicit restoration if a poll reports a stopped engine while the durable lease is still active', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.manager.connect({ address: '192.0.2.30:38473', mode: 'http' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.manager.snapshot()).toMatchObject({ state: 'error', status: { running: false, cleanupConfirmed: false } });
    expect(f.values.get('network.flowbridge.lease')).toBe(true);
    await expect(f.manager.connect()).rejects.toThrow('清理');
    const restored = await f.manager.disconnect();
    expect(restored).toMatchObject({ state: 'idle', status: { cleanupConfirmed: true } });
    await f.manager.shutdown();
  });
  it('requires a manual Windows global connection for the initial UAC, and releases the lease after a missing grant', async () => {
    const { memory, values } = fixture();
    const permissions: unknown[] = [];
    const manager = new FlowBridgeManager(memory, { platform: 'win32', dataDir: temporary(), gatewayPort: () => 18181,
      engine: () => ({ async request<T>(method: string, args?: Record<string, unknown>) {
        if (method !== 'connect') return stopped() as T;
        permissions.push(args?.allowInstall);
        if (!args?.allowInstall) throw new NetworkAuthorizationRequired('需要手动授权。');
        return { ...stopped(), running: true, cleanupConfirmed: false, localPort: 30000 } as T;
      }, async close() {} }) });
    await manager.save({ address: 'socks5://127.0.0.1:1080', mode: 'global', autoConnect: true });
    await manager.autoConnect();
    expect(manager.snapshot().message).toBe('需要手动授权。');
    expect(values.get('network.flowbridge.lease')).toBe(false);
    await manager.connect();
    expect(permissions).toEqual([false, true]);
    await manager.shutdown();
  });
  it('retains real one-second samples beyond one minute, persists them and prunes only the one-hour window', async () => {
    vi.useFakeTimers();
    const initial = Date.UTC(2026, 10, 10);
    vi.setSystemTime(initial);
    const directory = temporary(), values = new Map<string, unknown>();
    const memory = { getManagedState<T>(key: string, fallback: T): T { return (values.get(key) ?? fallback) as T; }, setManagedState(key: string, value: unknown) { values.set(key, value); } };
    let bytes = 0;
    const manager = new FlowBridgeManager(memory, { platform: 'linux', dataDir: directory, gatewayPort: () => 18181,
      engine: () => ({ async request<T>(method: string) {
        if (method === 'disconnect') return stopped() as T;
        if (method === 'snapshot') bytes += 100;
        return { ...stopped(), running: true, cleanupConfirmed: false, localPort: 30000, uploadBytes: bytes, downloadBytes: bytes * 2 } as T;
      }, async close() {} }) });
    await manager.connect({ address: '192.0.2.30:38473', mode: 'http' });
    await vi.advanceTimersByTimeAsync(300_000);
    const samples = manager.snapshot().history;
    expect(samples).toHaveLength(300);
    expect(samples[0].time).toBe(initial + 1000);
    expect(samples.at(-1)!.time).toBe(initial + 300_000);
    expect(samples.every((sample, index) => index === 0 || sample.time - samples[index - 1].time === 1000)).toBe(true);
    expect(samples.at(-1)).toMatchObject({ uploadRate: 100, downloadRate: 200 });
    await manager.shutdown();
    const persisted = JSON.parse(readFileSync(join(directory, 'history.json'), 'utf8'));
    expect(persisted).toEqual(samples);
    const reopened = new FlowBridgeManager(memory, { platform: 'linux', dataDir: directory, gatewayPort: () => 18181,
      engine: () => { throw new Error('Reading history must not launch a helper'); } });
    expect(reopened.snapshot().history).toEqual(samples);
    vi.setSystemTime(initial + 3_601_000);
    expect(reopened.snapshot().history).toEqual(samples.slice(1));
    vi.setSystemTime(initial + 3_900_000);
    expect(reopened.snapshot().history).toEqual([]);
    await reopened.shutdown();
  });
  it('keeps existing sparse minute samples at their original timestamps without fabricating second samples', () => {
    const directory = temporary(), now = Date.UTC(2026, 10, 10);
    const history = [90, 5, 4, 3].map(minutes => ({ time: now - minutes * 60_000, uploadRate: minutes, downloadRate: minutes * 2, uploadBytes: 100, downloadBytes: 200 }));
    writeFileSync(join(directory, 'history.json'), JSON.stringify(history));
    const store = { getManagedState<T>(_key: string, fallback: T): T { return fallback; }, setManagedState() {} };
    const manager = new FlowBridgeManager(store, { platform: 'linux', dataDir: directory, gatewayPort: () => 18181, now: () => now,
      engine: () => { throw new Error('Reading history must not launch a helper'); } });
    expect(manager.snapshot().history).toEqual(history.slice(1));
  });
  it('is inert by default and shutdown does not launch a helper or write legacy settings', async () => {
    const f = fixture(); expect(f.manager.snapshot().settings).toEqual(DEFAULT_FLOWBRIDGE);
    await f.manager.autoConnect(); await f.manager.shutdown(); expect(f.calls).toEqual([]); expect(f.values.size).toBe(0);
  });
  it('validates credential-free endpoints, gateway loops and platform capability boundaries', () => {
    for (const address of ['http://user:secret@localhost:80', 'http://host:1/path', 'http://host:0', 'http://127.0.0.1:18181', 'http://host:80\n']) expect(() => validateNetworkSettings({ address }, { ...DEFAULT_FLOWBRIDGE }, 'linux', 18181)).toThrow();
    expect(() => validateNetworkSettings({ mode: 'global', address: 'socks5://127.0.0.1:1080' }, { ...DEFAULT_FLOWBRIDGE }, 'linux', 18181)).toThrow('回环');
    expect(validateNetworkSettings({ mode: 'global', address: 'socks5://127.0.0.1:1080' }, { ...DEFAULT_FLOWBRIDGE }, 'win32', 18181).mode).toBe('global');
    expect(() => validateNetworkSettings({ mode: 'global', address: 'socks5://example.com:1080' }, { ...DEFAULT_FLOWBRIDGE }, 'linux', 18181)).toThrow('数值');
  });
  it.each(['linux', 'win32'])('connects a typed endpoint without a separate save on %s and validates reconnection before disconnecting', async platform => {
    const f = fixture(platform);
    const connected = await f.manager.connect({ address: '192.0.2.20:38473', mode: 'global' });
    expect(connected.state).toBe('connected');
    expect(connected.settings.address).toBe('socks5://192.0.2.20:38473');
    expect(f.values.get('network.flowbridge.v1')).toEqual(connected.settings);
    await expect(f.manager.save({ address: '192.0.2.21', mode: 'global' })).rejects.toThrow('端口');
    await expect(f.manager.save({ address: '', mode: 'global' })).rejects.toThrow('请先断开');
    expect(f.manager.snapshot().state).toBe('connected');
    expect(f.calls).toEqual(['connect']);
    const reconnected = await f.manager.save({ address: '192.0.2.21:38473', mode: 'global' });
    expect(reconnected.state).toBe('connected');
    expect(reconnected.settings.address).toBe('socks5://192.0.2.21:38473');
    expect(f.calls).toEqual(['connect', 'disconnect', 'connect']);
    await f.manager.shutdown();
  });
  it('remembers the new endpoint for retry when its connection fails after restoring the old one', async () => {
    const f = fixture();
    await f.manager.connect({ address: '192.0.2.20:38473', mode: 'http' });
    f.failConnect();
    await expect(f.manager.save({ address: '192.0.2.21:38473', mode: 'global' })).rejects.toThrow('UDP');
    expect(f.calls).toEqual(['connect', 'disconnect', 'connect', 'disconnect']);
    expect(f.manager.snapshot()).toMatchObject({
      state: 'error',
      settings: { address: 'socks5://192.0.2.21:38473', mode: 'global' },
      status: { cleanupConfirmed: true },
    });
    await f.manager.shutdown();
  });
  it('switches mode only after acknowledged restoration and keeps the same app preferences', async () => {
    const f = fixture(); f.values.set('app.settings', { preserved: true });
    await f.manager.save({ address: '192.0.2.20:38473' }); await f.manager.connect();
    await f.manager.save({ mode: 'global' });
    expect(f.calls).toEqual(['connect','disconnect','connect']);
    expect(f.manager.snapshot().settings.address).toBe('socks5://192.0.2.20:38473');
    expect(f.values.get('app.settings')).toEqual({ preserved: true }); await f.manager.shutdown();
  });
  it.each(['manual', 'automatic'])('does not start a queued %s global connection after quit', async mode => {
    const f = fixture();
    await f.manager.save({ address: '192.0.2.20:38473', mode: 'global', autoConnect: true });
    const connection = mode === 'manual' ? f.manager.connect() : f.manager.autoConnect();
    await Promise.all([connection, f.manager.shutdown()]);
    expect(f.calls).toEqual([]);
    expect(f.values.has('network.flowbridge.lease')).toBe(false);
  });
  it('saves the new mode without reconnecting if quit is requested while restoring the old session', async () => {
    const f = fixture();
    await f.manager.save({ address: '192.0.2.20:38473' });
    await f.manager.connect();
    const switchMode = f.manager.save({ mode: 'global' });
    await Promise.resolve();
    expect(f.calls).toEqual(['connect', 'disconnect']);
    await Promise.all([switchMode, f.manager.shutdown()]);
    expect(f.calls).toEqual(['connect', 'disconnect', 'cancel', 'close']);
    expect(f.manager.snapshot().settings.mode).toBe('global');
    expect(f.values.get('network.flowbridge.lease')).toBe(false);
  });
  it('keeps settings, ownership, gateway and helper available when cleanup fails', async () => {
    const f = fixture(); await f.manager.save({ address: '192.0.2.20:38473' }); await f.manager.connect(); f.failStop();
    await expect(f.manager.save({ mode: 'global' })).rejects.toThrow('cleanup');
    expect(f.manager.snapshot().settings.mode).toBe('http'); expect(f.values.get('network.flowbridge.lease')).toBe(true);
    await expect(f.manager.shutdown()).rejects.toThrow('cleanup'); expect(f.calls).not.toContain('close');
    f.failStop(false); await f.manager.shutdown(); expect(f.values.get('network.flowbridge.lease')).toBe(false);
  });
  it('rolls back rejected preflight and never reports connected', async () => {
    const f = fixture(); await f.manager.save({ address: '192.0.2.20:38473' }); f.failConnect();
    await expect(f.manager.connect()).rejects.toThrow('UDP'); expect(f.calls).toEqual(['connect','disconnect']);
    expect(f.manager.snapshot().state).toBe('error'); expect(f.values.get('network.flowbridge.lease')).toBe(false); await f.manager.shutdown();
  });
  it('serializes cancellation behind pending startup without losing cleanup', async () => {
    const f = fixture(); await f.manager.save({ address: '192.0.2.20:38473' }); f.hold();
    const connect = f.manager.connect(); await Promise.resolve(); await Promise.resolve();
    const stop = f.manager.disconnect(); expect(f.calls).toContain('cancel'); f.release();
    await Promise.all([connect, stop]); expect(f.manager.snapshot().state).toBe('idle'); expect(f.values.get('network.flowbridge.lease')).toBe(false); await f.manager.shutdown();
  });
  it('retains a durable recovery lease on crash and blocks unattended reconnect', async () => {
    const f = fixture(); await f.manager.save({ address: '192.0.2.20:38473', autoConnect: true }); await f.manager.connect(); f.crash();
    const manager = new FlowBridgeManager(f.memory, { platform:'linux', dataDir:temporary(), gatewayPort:()=>18181, engine:()=>{ throw new Error('must remain inert'); } });
    await manager.autoConnect(); expect(manager.snapshot().status.cleanupConfirmed).toBe(false); await expect(manager.connect()).rejects.toThrow('清理'); await f.manager.shutdown();
  });
  it('adds only namespaced state to an existing real ModelDock database', async () => {
    const dir = temporary(), store = await Store.create(dir);
    const provider = store.saveProvider({ name:'Synthetic preserved supplier', kind:'openai-compatible', enabled:true, baseUrl:'https://synthetic.example/v1', apiKey:'SYNTHETIC_PRESERVE_NETWORK_KEY' });
    const before = { providers:store.listProviders(), bindings:store.listBindings(), key:store.getSecret(provider.id) };
    const manager = new FlowBridgeManager(store, {platform:'linux',dataDir:join(dir,'network'),gatewayPort:()=>18181,engine:()=>{throw new Error('unexpected');}});
    await manager.save({ address:'192.0.2.20:38473' }); store.close();
    const reopened = await Store.create(dir);
    expect({providers:reopened.listProviders(),bindings:reopened.listBindings(),key:reopened.getSecret(provider.id)}).toEqual(before); reopened.close();
  });
  it('missing optional network components cannot trap an unchanged ModelDock at exit', async () => {
    const f = fixture();
    const manager = new FlowBridgeManager(f.memory, {platform:'linux',dataDir:temporary(),gatewayPort:()=>18181,
      engine:(progress,exit)=>new FlowBridgeEngine(join(temporary(),'missing-runtime'),temporary(),progress,exit)});
    await manager.save({address:'192.0.2.20:38473'});
    await expect(manager.connect()).rejects.toThrow('缺少网络组件');
    expect(manager.snapshot().status.cleanupConfirmed).toBe(true);
    expect(f.values.get('network.flowbridge.lease')).toBe(false);
    await expect(manager.check('ChatGPT')).rejects.toThrow('缺少网络组件');
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
  it.skipIf(process.platform !== 'linux' && !(process.platform === 'win32' && existsSync('resources/flowbridge/python/python.exe')))('runs the real stdio boundary in an isolated directory without touching OS proxy settings', async () => {
    const directory = temporary(); const engine = new FlowBridgeEngine(join(process.cwd(),'resources/flowbridge'), directory, () => {}, () => {});
    try { const value = await engine.request<NetworkEngineStatus>('snapshot'); expect(value).toEqual(stopped()); await expect(engine.request('not-a-network-command')).rejects.toThrow('未知'); await expect(engine.request('disconnect')).resolves.toMatchObject({cleanupConfirmed:true}); }
    finally { await engine.close(); }
  });
});
