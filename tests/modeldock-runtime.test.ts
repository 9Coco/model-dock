import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Gateway } from '../src/main/gateway';
import { ModelDockRuntime } from '../src/main/modeldock-runtime';
import { Store } from '../src/main/store';
import type { NetworkEngineStatus } from '../src/shared/flowbridge-types';

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of dispose.splice(0)) await cleanup(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-services-'));
  const store = await Store.create(directory);
  const gateway = new Gateway(store, { port: 0 });
  let refuseCleanup = false;
  const setHttpRelay = vi.fn(async (_port: number | null) => {});
  const runtime = new ModelDockRuntime(gateway, store, {
    platform: 'linux', dataDir: join(directory, 'network'), setHttpRelay,
    engine: () => ({
      async request<T>(method: string) {
        if (method === 'disconnect' && refuseCleanup) throw new Error('temporary cleanup failure');
        const running = method === 'connect';
        const status: NetworkEngineStatus = {
          running, cleanupConfirmed: !running, localPort: running ? 30123 : null,
          uploadBytes: 0, downloadBytes: 0, connections: 0, message: '',
        };
        return status as T;
      },
      async close() {},
    }),
  });
  dispose.push(async () => {
    refuseCleanup = false;
    await runtime.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, setHttpRelay, refuseCleanup(value: boolean) { refuseCleanup = value; } };
}

it('uses the live gateway port in both directions and serializes starts from different entry points', async () => {
  const { runtime } = await fixture();
  const [first, second] = await Promise.all([runtime.startGateway(0), runtime.startGateway(0)]);
  expect(first.port).toBeGreaterThan(0);
  expect(second.port).toBe(first.port);
  await expect(runtime.network.save({ address: 'http://localhost:' + first.port })).rejects.toThrow('网关');
  await runtime.stopGateway();
  await runtime.network.save({ address: 'http://localhost:38111' });
  await expect(runtime.startGateway(38111)).rejects.toThrow('网关');
  expect(runtime.snapshot()).toMatchObject({ gateway: { running: false }, network: { state: 'idle' } });
});

it('refreshes the shared network session on changes and keeps the gateway available until network cleanup succeeds', async () => {
  const { runtime, setHttpRelay, refuseCleanup } = await fixture();
  await runtime.startGateway(0);
  await runtime.network.save({ address: 'http://192.0.2.8:38473' });
  expect(setHttpRelay).not.toHaveBeenCalled();
  await runtime.network.connect();
  expect(runtime.snapshot()).toMatchObject({ gateway: { running: true }, network: { state: 'connected' } });
  expect(setHttpRelay.mock.calls).toEqual([[30123]]);
  refuseCleanup(true);
  await expect(runtime.shutdown()).rejects.toThrow('cleanup failure');
  expect(runtime.snapshot()).toMatchObject({ gateway: { running: true }, network: { state: 'error' } });
  refuseCleanup(false);
  await runtime.shutdown();
  expect(setHttpRelay.mock.calls).toEqual([[30123], [null]]);
  expect(runtime.snapshot()).toMatchObject({ gateway: { running: false }, network: { state: 'idle' } });
  await expect(runtime.startGateway()).rejects.toThrow('正在退出');
});
