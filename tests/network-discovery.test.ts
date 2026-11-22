import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverTermuxEndpoint, linuxLocalProxies } from '../src/main/network-discovery';

const closeListeners: (() => void)[] = [];
afterEach(() => {
  for (const close of closeListeners.splice(0)) close();
  vi.unstubAllEnvs();
});

async function listener(reply?: string) {
  const requests: string[] = [];
  const server = createServer(socket => socket.once('data', data => {
    requests.push(data.toString());
    if (reply) socket.end(reply);
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closeListeners.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  return { port, endpoint: `127.0.0.1:${port}`, requests };
}

it('accepts only verified local HTTP proxies and excludes the gateway, credentials and non-loopback endpoints', async () => {
  const ok = await listener('HTTP/1.1 200 Connection established\r\n\r\n');
  const denied = await listener('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
  const stalled = await listener();
  const gateway = await listener();
  const ignored = await listener();
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) vi.stubEnv(key, undefined);
  vi.stubEnv('http_proxy', 'http://user:password@' + ignored.endpoint);
  vi.stubEnv('https_proxy', 'http://' + ok.endpoint);
  // Repeat the same endpoint as an env hint, desktop rule and native listener.
  const rules = 'PROXY ' + ok.endpoint + '; SOCKS ' + ignored.endpoint + '; PROXY ' + denied.endpoint + '; DIRECT';
  const hints = [gateway.endpoint, ok.endpoint, stalled.endpoint, ignored.endpoint + '/pac', '192.0.2.1:' + ignored.port, '[::ffff:127.0.0.1]:' + ignored.port];
  expect(await linuxLocalProxies(gateway.port, async () => rules, async () => hints)).toEqual(['http://' + ok.endpoint]);
  expect(ok.requests).toHaveLength(1);
  expect(ok.requests[0]).toMatch(/^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
  expect(denied.requests).toHaveLength(1);
  expect(stalled.requests).toHaveLength(1);
  expect(ignored.requests).toEqual([]);
  expect(gateway.requests).toEqual([]);
}, 10_000);

it('probes the current gateways in route priority order and verifies the saved fallback only if needed', async () => {
  const input = { mode: 'http', port: 41000, savedAddress: 'http://192.0.2.90:41000' } as const;
  const gateways = async () => ['192.0.2.1', '192.0.2.2', '192.0.2.1'];
  const second = 'http://192.0.2.2:41000';
  const probe = vi.fn(async (address: string) => address === second);
  expect(await discoverTermuxEndpoint(input, gateways, probe)).toBe(second);
  expect(probe.mock.calls.flat()).toEqual(['http://192.0.2.1:41000', second]);
  probe.mockClear().mockImplementation(async address => address === input.savedAddress);
  expect(await discoverTermuxEndpoint(input, gateways, probe)).toBe(input.savedAddress);
  expect(probe.mock.calls.flat()).toEqual(['http://192.0.2.1:41000', second, input.savedAddress]);
  probe.mockClear().mockResolvedValue(false);
  expect(await discoverTermuxEndpoint(input, async () => { throw new Error('no route table'); }, probe)).toBeNull();
  expect(probe.mock.calls.flat()).toEqual([input.savedAddress]);
  probe.mockClear();
  expect(await discoverTermuxEndpoint({ ...input, port: input.port + 1 }, async () => [], probe)).toBeNull();
  expect(probe).not.toHaveBeenCalled();
});

it('verifies a fragmented SOCKS5 connection reply and rejects denied, truncated or HTTP-only listeners', async () => {
  const requests: Buffer[] = [];
  let reply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
  const server = createServer(socket => socket.once('data', data => {
    requests.push(data);
    socket.write(Buffer.from([5]));
    setImmediate(() => socket.write(Buffer.from([0])));
    socket.once('data', connect => {
      requests.push(connect);
      socket.write(reply.subarray(0, 4));
      setImmediate(() => socket.end(reply.subarray(4)));
    });
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closeListeners.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const input = { mode: 'global', port, savedAddress: `socks5://127.0.0.1:${port}` } as const;
  expect(await discoverTermuxEndpoint(input, async () => [])).toBe(input.savedAddress);
  expect(requests).toEqual([Buffer.from([5, 1, 0]), Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from('example.com'), Buffer.from([1, 187])])]);
  reply = Buffer.from([5, 0, 0, 1, 127]);
  expect(await discoverTermuxEndpoint(input, async () => [])).toBeNull();
  reply = Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 0]);
  expect(await discoverTermuxEndpoint(input, async () => [])).toBeNull();
  const wrong = await listener('HTTP/1.1 200 OK\r\n\r\n');
  expect(await discoverTermuxEndpoint({ mode: 'global', port: wrong.port, savedAddress: 'socks5://' + wrong.endpoint }, async () => [])).toBeNull();
});
