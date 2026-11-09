import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowBridgeManager, validateNetworkSettings } from '../src/main/flowbridge';
import { FlowBridgeEngine, type NetworkEngine } from '../src/main/flowbridge-engine';
import { DEFAULT_FLOWBRIDGE, type NetworkEngineStatus } from '../src/shared/flowbridge-types';
import { Store } from '../src/main/store';
const folders: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'modeldock-network-test-')); folders.push(path); return path; };
afterEach(() => { vi.useRealTimers(); for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const stopped = (): NetworkEngineStatus => ({ running: false, cleanupConfirmed: true, localPort: null, uploadBytes: 0, downloadBytes: 0, connections: 0, message: '' });
function fixture() {
  const values = new Map<string, unknown>(), calls: string[] = [];
  const memory = { getManagedState<T>(k: string, v: T): T { return structuredClone(values.get(k) ?? v) as T; }, setManagedState(k: string, v: unknown) { values.set(k, structuredClone(v)); } };
  let stopFails = false, connectFails = false, failExit: () => void = () => {}, release: (() => void) | undefined;
  const engine: NetworkEngine = { async request<T>(method: string) {
    calls.push(method);
    if (method === 'disconnect' && stopFails) throw new Error('cleanup failed');
    if (method === 'connect') { if (connectFails) throw new Error('UDP preflight rejected'); if (release) await new Promise<void>(resolve => { release = resolve; }); return { ...stopped(), running: true, cleanupConfirmed: false, localPort: 30000 } as T; }
    return stopped() as T;
  }, async close() { calls.push('close'); } };
  const manager = new FlowBridgeManager(memory, { platform: 'linux', dataDir: temporary(), gatewayPort: () => 18181, engine: (_progress, exit) => { failExit = exit; return engine; } });
  return { manager, memory, values, calls, failStop(value = true) { stopFails = value; }, failConnect() { connectFails = true; }, crash() { failExit(); }, hold() { release = () => {}; }, release() { release?.(); } };
}
describe('FlowBridge integration', () => {
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
  it('switches mode only after acknowledged restoration and keeps the same app preferences', async () => {
    const f = fixture(); f.values.set('app.settings', { preserved: true });
    await f.manager.save({ address: '192.0.2.20:38473' }); await f.manager.connect();
    await f.manager.save({ mode: 'global' });
    expect(f.calls).toEqual(['connect','disconnect','connect']);
    expect(f.manager.snapshot().settings.address).toBe('socks5://192.0.2.20:38473');
    expect(f.values.get('app.settings')).toEqual({ preserved: true }); await f.manager.shutdown();
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
  it.skipIf(process.platform !== 'linux')('runs the real stdio boundary in an isolated directory without touching OS proxy settings', async () => {
    const directory = temporary(); const engine = new FlowBridgeEngine(join(process.cwd(),'resources/flowbridge'), directory, () => {}, () => {});
    try { const value = await engine.request<NetworkEngineStatus>('snapshot'); expect(value).toEqual(stopped()); await expect(engine.request('not-a-network-command')).rejects.toThrow('未知'); await expect(engine.request('disconnect')).resolves.toMatchObject({cleanupConfirmed:true}); }
    finally { await engine.close(); }
  });
});
