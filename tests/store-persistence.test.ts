import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const directories: string[] = [], stores: Store[] = [];
const codec = { encrypt: (value: string) => `fixture:${Buffer.from(value).toString('base64')}`, decrypt: (value: string) => Buffer.from(value.slice(8), 'base64').toString() };
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-durable-store-')); directories.push(dir);
  const store = await Store.create(dir, codec); stores.push(store);
  const provider = store.saveProvider({ name: 'Synthetic fixture', kind: 'openai-compatible', baseUrl: 'https://fixture.example/v1', enabled: true, apiKey: 'synthetic-original-secret' });
  return { dir, store, provider };
}
function snapshot(store: Store, providerId: string) {
  return { providers: store.listProviders(), secret: store.getSecret(providerId), models: store.listModels(), bindings: store.listBindings(), logs: store.logs(), key: store.gatewayKey(), managed: store.getManagedState('durability', null) };
}
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(fsyncSync).mockReset(); vi.mocked(renameSync).mockReset(); vi.mocked(unlinkSync).mockReset();
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('durable store replacement', () => {
  it.each(['provider', 'secret', 'managed', 'model', 'binding', 'log', 'gateway-key'] as const)('restores memory and disk after a failed %s write, then remains writable', async kind => {
    const { dir, store, provider } = await setup(), filename = join(dir, 'modeldock.sqlite');
    const before = snapshot(store, provider.id), disk = readFileSync(filename);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('Synthetic disk failure'), { code: 'ENOSPC' }); });
    const operations = {
      provider: () => store.saveProvider({ ...provider, name: 'Uncommitted name' }),
      secret: () => store.setSecret(provider.id, { apiKey: 'synthetic-new-secret' }),
      managed: () => store.setManagedState('durability', { changed: true }),
      model: () => store.saveModel({ providerId: provider.id, alias: 'fixture-model', upstreamId: 'fixture-model', displayName: 'Fixture', wireApi: 'chat-completions', contextWindow: 1000, tools: false, vision: false, enabled: true }),
      binding: () => store.saveBinding({ ...store.listBindings()[0], note: 'Uncommitted note' }),
      log: () => store.addLog({ alias: 'fixture', providerName: 'Fixture', endpoint: '/v1/responses', status: 200, durationMs: 1 }),
      'gateway-key': () => store.rotateGatewayKey(),
    };
    expect(operations[kind]).toThrow('Synthetic disk failure');
    expect(snapshot(store, provider.id)).toEqual(before); expect(readFileSync(filename)).toEqual(disk);
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    store.setManagedState('recoverability', { retained: true });
    const reopened = await Store.create(dir, codec); stores.push(reopened);
    expect(snapshot(reopened, provider.id)).toEqual(before);
    expect(reopened.getManagedState('recoverability', null)).toEqual({ retained: true });
  });
  it('flushes the private temporary database before replacing the committed file', async () => {
    const { dir, store } = await setup(), filename = join(dir, 'modeldock.sqlite'), disk = readFileSync(filename);
    vi.mocked(fsyncSync).mockClear(); vi.mocked(renameSync).mockClear();
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('Synthetic flush failure'); });
    expect(() => store.setManagedState('durability', true)).toThrow('Synthetic flush failure');
    expect(readFileSync(filename)).toEqual(disk); expect(store.getManagedState('durability', null)).toBeNull();
    expect(renameSync).not.toHaveBeenCalled(); expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    store.setManagedState('durability', true);
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder.at(-1)!);
  });
  it('cleans failed initial and close-time persistence without returning an unusable store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeldock-initial-store-')); directories.push(dir);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('Synthetic initial flush failure'); });
    await expect(Store.create(dir, codec)).rejects.toThrow('Synthetic initial flush failure');
    expect(existsSync(join(dir, 'modeldock.sqlite'))).toBe(false); expect(readdirSync(dir)).toEqual([]);
    const store = await Store.create(dir, codec); stores.push(store);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('Synthetic close flush failure'); });
    expect(() => store.close()).toThrow('Synthetic close flush failure');
    expect(store.listProviders().length).toBeGreaterThan(0); expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    store.setManagedState('recoverability', true); store.close();
  });
  it.each(['fsync', 'rename'] as const)('preserves the original %s failure when unlink and old database close also fail', async phase => {
    const { dir, store, provider } = await setup(), filename = join(dir, 'modeldock.sqlite');
    const before = snapshot(store, provider.id), disk = readFileSync(filename), primary = new Error(`Synthetic ${phase} primary failure`);
    const old = (store as unknown as { db: { close(): void } }).db, close = old.close.bind(old);
    vi.spyOn(old, 'close').mockImplementationOnce(() => { throw new Error('Synthetic database cleanup failure'); });
    vi.mocked(phase === 'fsync' ? fsyncSync : renameSync).mockImplementationOnce(() => { throw primary; });
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error('Synthetic unlink cleanup failure'); });
    let failure: unknown;
    try { store.setSecret(provider.id, { apiKey: 'synthetic-uncommitted-secret' }); } catch (error) { failure = error; }
    expect(failure).toBe(primary); expect(snapshot(store, provider.id)).toEqual(before); expect(readFileSync(filename)).toEqual(disk);
    close(); store.setManagedState('recoverability', true);
  });
});
