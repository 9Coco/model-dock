import { describe, expect, it, vi } from 'vitest';
import { localGatewayKey, providerApiKey } from '../src/main/connection-keys';
import { writeClipboardText } from '../src/main/clipboard-text';
import type { Provider, ProviderKind, ProviderSecret } from '../src/shared/types';

function source(kind: ProviderKind = 'openai-compatible'): Provider {
  return { id: 'source', name: 'Source', kind, baseUrl: 'https://example.test/v1', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
}
function fixture(kind: ProviderKind = 'openai-compatible', secret: ProviderSecret | undefined = { apiKey: 'synthetic-key', refreshToken: 'synthetic-refresh' }) {
  return { getProvider: vi.fn((id: string) => id === 'source' ? source(kind) : undefined), getSecret: vi.fn((_id: string) => secret) };
}

describe('explicit connection key reveal and copy', () => {
  it('returns and copies only an API key, without exposing other saved credential fields', async () => {
    const store = fixture(), write = vi.fn();
    const key = providerApiKey(store, 'source');
    expect(key).toBe('synthetic-key');
    await writeClipboardText(key, write);
    expect(write).toHaveBeenCalledExactlyOnceWith('synthetic-key');
  });
  it.each(['codex', 'copilot', 'grok'] as const)('refuses %s authorization before reading its secrets', kind => {
    const store = fixture(kind, { apiKey: 'synthetic-non-api-key', accessToken: 'synthetic-oauth' });
    expect(() => providerApiKey(store, 'source')).toThrow('订阅来源使用账号授权');
    expect(store.getSecret).not.toHaveBeenCalled();
  });
  it.each([null, undefined, {}, 123, '', '\0', 'a\nb', 'a'.repeat(201)])('rejects invalid identifiers before reading a provider', id => {
    const store = fixture();
    expect(() => providerApiKey(store, id)).toThrow('供应商标识无效');
    expect(store.getProvider).not.toHaveBeenCalled();
    expect(store.getSecret).not.toHaveBeenCalled();
  });
  it('rejects missing sources and never falls back to another credential', () => {
    const store = fixture();
    expect(() => providerApiKey(store, 'missing')).toThrow('供应商不存在');
    expect(store.getSecret).not.toHaveBeenCalled();
    expect(() => providerApiKey(fixture('openai-compatible', { accessToken: 'synthetic-oauth' }), 'source')).toThrow('尚未保存 API Key');
  });
  it('sanitizes credential backend failures for reveal as well as copy', () => {
    const store = fixture();
    store.getSecret.mockImplementation(() => { throw new Error('PRIVATE_CREDENTIAL_BACKEND_ERROR'); });
    expect(() => providerApiKey(store, 'source')).toThrow(/^无法读取已保存的 API Key。$/);
    expect(() => localGatewayKey({ gatewayKey: () => { throw new Error('PRIVATE_CREDENTIAL_BACKEND_ERROR'); } })).toThrow(/^无法读取本地聚合接口的 API Key。$/);
  });
  it('returns the dedicated local key for explicit local interface reveal', () => {
    expect(localGatewayKey({ gatewayKey: () => 'synthetic-local-key' })).toBe('synthetic-local-key');
  });
});
