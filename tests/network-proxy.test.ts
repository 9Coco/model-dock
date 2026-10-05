import { describe, expect, it, vi } from 'vitest';
import { applyNetworkProxy, validateProxyUrl } from '../src/main/network-proxy';

describe('application-session proxy validation', () => {
  it.each([
    ['', ''], ['   ', ''],
    ['http://localhost:7890', 'http://localhost:7890'],
    ['HTTP://LOCALHOST:7890/', 'http://localhost:7890'],
    [' https://127.0.0.1:7890/ ', 'https://127.0.0.1:7890'],
    ['socks5://[::1]:1080', 'socks5://[::1]:1080'],
    ['SOCKS5://LOCALHOST:01080/', 'socks5://localhost:1080'],
    ['http://127.0.0.1:80/', 'http://127.0.0.1:80'],
    ['https://localhost:443', 'https://localhost:443'],
    ['http://[::1]:1', 'http://[::1]:1'],
    ['socks5://127.0.0.1:65535/', 'socks5://127.0.0.1:65535'],
  ])('normalizes %s deterministically to %s', (input, expected) => {
    expect(validateProxyUrl(input)).toBe(expected);
    expect(validateProxyUrl(expected)).toBe(expected);
  });

  it.each([
    undefined, null, false, 7890, {}, [], new URL('http://127.0.0.1:7890'),
    '127.0.0.1:7890', 'http://localhost', 'http://localhost:', 'https://localhost/',
    'http://localhost:0', 'http://localhost:65536', 'http://localhost:-1', 'http://localhost:1.5', 'http://localhost:+7890',
    'http://user:synthetic@localhost:7890', 'http://@localhost:7890',
    'http://localhost:7890?key=synthetic', 'http://localhost:7890?', 'http://localhost:7890#fragment', 'http://localhost:7890#',
    'http://localhost:7890/path', 'http://localhost:7890//', 'http://localhost:7890/.',
    'http://localhost:7890\n', '\thttp://localhost:7890', 'http://localhost:7890\0', 'http://local\u200bhost:7890',
    'http://localhost:7890\u0085', 'http://localhost:7890\u2060',
    'http://127.1:7890', 'http://2130706433:7890', 'http://0x7f000001:7890', 'http://0177.0.0.1:7890',
    'http://[0:0:0:0:0:0:0:1]:7890', 'http://localhost.:7890', 'http://%6cocalhost:7890',
    'http://192.168.1.1:7890', 'http://0.0.0.0:7890', 'http://example.test:7890', 'http://localhost.example.test:7890',
    'ftp://localhost:7890', 'socks4://localhost:7890', 'socks5h://localhost:7890',
    'http:\\localhost:7890', 'http://localhost:7890;https=example.test:443', 'x'.repeat(2049),
  ].map(value => ({ value })))('rejects invalid input before writing a session configuration %#', async ({ value }) => {
    const setProxy = vi.fn();
    expect(() => validateProxyUrl(value)).toThrow(/^代理地址格式无效/);
    await expect(applyNetworkProxy({ setProxy }, value)).rejects.toThrow(/^代理地址格式无效/);
    expect(setProxy).not.toHaveBeenCalled();
  });
});

describe('explicit per-application proxy updates', () => {
  it('selects system mode for empty text without writing custom rules', async () => {
    const setProxy = vi.fn(async () => {});
    await applyNetworkProxy({ setProxy }, '');
    expect(setProxy).toHaveBeenCalledOnce(); expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
  });

  it.each(['http://127.0.0.1:7890', 'https://localhost:7890', 'socks5://[::1]:1080'])('configures only the injected session for %s and preserves loopback bypasses', async url => {
    const setProxy = vi.fn(async () => {}), closeAllConnections = vi.fn(), setSystemProxy = vi.fn();
    const session = { setProxy, closeAllConnections, setSystemProxy };
    await applyNetworkProxy(session, url);
    expect(setProxy).toHaveBeenCalledOnce();
    expect(setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: url, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' });
    expect(closeAllConnections).not.toHaveBeenCalled(); expect(setSystemProxy).not.toHaveBeenCalled();
  });

  it('waits for native setProxy completion before reporting that settings were applied', async () => {
    let complete!: () => void, applied = false;
    const pending = applyNetworkProxy({ setProxy: () => new Promise<void>(resolve => { complete = resolve; }) }, 'http://localhost:7890').then(() => { applied = true; });
    await Promise.resolve(); expect(applied).toBe(false);
    complete(); await pending; expect(applied).toBe(true);
  });

  it.each(['sync', 'async'] as const)('reports %s native failures without leaking proxy addresses or raw exception text', async mode => {
    const fail = () => { throw new Error('PRIVATE_NATIVE_ERROR secret-user:secret-password@synthetic.invalid:1234'); };
    const setProxy = mode === 'sync' ? fail : async () => fail();
    const error = await applyNetworkProxy({ setProxy }, 'http://localhost:7890').catch(failure => failure as Error);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('无法应用应用内代理设置，请检查本机代理服务和端口后重试。');
    expect(String(error)).not.toMatch(/PRIVATE_|synthetic|secret-user|secret-password|localhost|7890/);
  });
});
