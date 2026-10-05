import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeApiKey } from '../src/main/credentials';
import { prepareUpstream } from '../src/main/oauth';
import { Store } from '../src/main/store';

let store: Store | undefined, dir: string | undefined;
afterEach(() => { store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); store = undefined; dir = undefined; });
describe('API credentials and batch persistence', () => {
  it('removes known pasted wrappers without guessing provider key shape', () => {
    for (const input of ['  sample-token  ', 'Bearer sample-token', '"sample-token"', "'Bearer sample-token'", 'bearer "sample-token"', 'Authorization: Bearer sample-token']) expect(normalizeApiKey(input)).toBe('sample-token');
    expect(normalizeApiKey('vendor:token.with-symbols')).toBe('vendor:token.with-symbols');
    expect(normalizeApiKey('   ')).toBe('');
  });
  it('rejects embedded whitespace and invisible characters without revealing key content', () => {
    for (const value of ['private token', 'private\nvalue', 'private\u200bvalue', 'Bearer Bearer private']) {
      try { normalizeApiKey(value); expect.fail('must reject'); } catch (error) { expect(String(error)).not.toContain('private'); expect(String(error)).toContain('API Key'); }
    }
  });
  it('uses exactly one Bearer prefix when preparing old saved credentials', () => {
    const provider = { id: 'deepseek', name: 'DeepSeek', presetId: 'deepseek' as const, kind: 'openai-compatible' as const, baseUrl: 'https://api.deepseek.com', enabled: true, hasSecret: true, authStatus: 'ready' as const, note: '' };
    expect(prepareUpstream(provider, { apiKey: 'Bearer "synthetic-token"' }, '/models', {}).headers.Authorization).toBe('Bearer synthetic-token');
  });
  it('normalizes saved keys and rolls back a complete model batch on alias conflicts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'modeldock-credentials-'));
    store = await Store.create(dir);
    store.saveProvider({ id: 'deepseek', name: 'DeepSeek', presetId: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', enabled: true, apiKey: 'Bearer synthetic-token' });
    expect(store.getSecret('deepseek')?.apiKey).toBe('synthetic-token');
    const model = { providerId: 'deepseek', upstreamId: 'one', alias: 'one', displayName: 'One', wireApi: 'responses' as const, contextWindow: 0, tools: true, vision: false, enabled: true };
    expect(() => store!.saveModels([model, { ...model, upstreamId: 'two' }])).toThrow('别名');
    expect(store.listModels()).toHaveLength(0);
    expect(store.saveModels([model, { ...model, upstreamId: 'two', alias: 'two' }])).toHaveLength(2);
    expect(store.listModels()).toHaveLength(2);
  });
});
