// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { parseNetworkEndpoint, type NetworkMode } from '../shared/flowbridge-types';

const run = promisify(execFile);
const commandOptions = { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true };

export async function hotspotCandidates(platform: string = process.platform): Promise<string[]> {
  let gateways: string[];
  if (platform === 'win32') {
    const route = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'route.exe');
    const { stdout } = await run(route, ['PRINT', '-4'], commandOptions);
    // Only active default routes have the gateway, interface IP and metric columns.
    gateways = [...stdout.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)\s+[\d.]+\s+(\d+)[ \t]*\r?$/gm)]
      .sort((a, b) => Number(a[2]) - Number(b[2])).map(match => match[1]);
  } else if (platform === 'linux') {
    const ip = existsSync('/usr/sbin/ip') ? '/usr/sbin/ip' : '/usr/bin/ip';
    const { stdout } = await run(ip, ['-j', 'route', 'show', 'default'], commandOptions);
    const routes: { gateway?: string; metric?: number; nexthops?: { gateway?: string }[] }[] = JSON.parse(stdout);
    gateways = routes.sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))
      .flatMap(row => [row.gateway || '', ...(row.nexthops ?? []).map(hop => hop.gateway || '')]);
  } else return [];
  return [...new Set(gateways.filter(host => isIP(host) && !host.startsWith('127.') && host !== '0.0.0.0' && host !== '::' && host !== '::1'))];
}

function localHttpEndpoint(value: string, gatewayPort: number) {
  const match = /^(?:http:\/\/)?(localhost|127(?:\.[0-9]{1,3}){3}|\[::1\]):([0-9]+)\/?$/i.exec(value.trim());
  if (!match) return;
  const host = match[1].toLowerCase() === 'localhost' ? '127.0.0.1' : match[1];
  const port = Number(match[2]);
  if ((host !== '[::1]' && isIP(host) !== 4) || port < 1 || port > 65535 || port === gatewayPort) return;
  return `http://${host}:${port}`;
}

async function vpnListeners(): Promise<string[]> {
  const ss = existsSync('/usr/bin/ss') ? '/usr/bin/ss' : '/usr/sbin/ss';
  const { stdout } = await run(ss, ['-H', '-lntp'], commandOptions);
  const candidates: string[] = [];
  for (const line of stdout.split('\n')) {
    // ss exposes the owner of accessible sockets. Probe only known VPN cores.
    if (!/\("(?:clash(?:-[^"]+)?|mihomo(?:-[^"]+)?|sing-box|xray|v2ray|ss-local|WindmillVPN[^"]*)",pid=/i.test(line)) continue;
    const address = line.trim().split(/\s+/)[3];
    if (address) candidates.push(address.replace(/^(?:0\.0\.0\.0|\*)(?=:)/, '127.0.0.1').replace(/^\[::\](?=:)/, '[::1]'));
  }
  return candidates;
}

function acceptsHttpConnect(address: string): Promise<boolean> {
  const url = new URL(address);
  return new Promise(resolve => {
    const probe = request({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80),
      method: 'CONNECT', path: 'example.com:443', headers: { Host: 'example.com:443' },
      agent: false, maxHeaderSize: 16 * 1024, signal: AbortSignal.timeout(3000) });
    probe.on('connect', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode === 200);
    });
    probe.on('error', () => resolve(false));
    probe.end();
  });
}

async function acceptsSocksConnect(address: string): Promise<boolean> {
  const endpoint = parseNetworkEndpoint(address, 'global');
  if (!endpoint) return false;
  const socket = createConnection({ host: endpoint.host.replace(/^\[|\]$/g, ''), port: endpoint.port, signal: AbortSignal.timeout(3000) });
  const target = Buffer.from('example.com', 'ascii');
  let greeting = true;
  let pending = Buffer.alloc(0);
  try {
    socket.write(Buffer.from([5, 1, 0])); // SOCKS5, one method, no authentication.
    for await (const chunk of socket) {
      if (pending.length + chunk.length > 512) return false;
      pending = Buffer.concat([pending, chunk]);
      if (greeting) {
        if (pending.length < 2) continue;
        if (pending.length !== 2 || pending[0] !== 5 || pending[1] !== 0) return false;
        greeting = false;
        pending = Buffer.alloc(0);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, target.length]), target, Buffer.from([1, 187])])); // CONNECT example.com:443.
        continue;
      }
      if (pending.length < 5) continue;
      if (pending[0] !== 5 || pending[1] !== 0 || pending[2] !== 0) return false;
      const boundHostSize = pending[3] === 1 ? 4 : pending[3] === 4 ? 16 : pending[3] === 3 && pending[4] > 0 ? 1 + pending[4] : 0;
      if (!boundHostSize) return false;
      if (pending.length >= 4 + boundHostSize + 2) return true;
    }
    return false;
  } catch { return false; }
  finally { socket.destroy(); }
}

export type TermuxDiscovery = { mode: NetworkMode; port: number; savedAddress: string };
/** Probe only reported gateways and the user's saved endpoint. No credentials or OS configuration are involved. */
export async function discoverTermuxEndpoint(
  { mode, port, savedAddress }: TermuxDiscovery, gateways = hotspotCandidates,
  probe = (address: string) => address.startsWith('socks5://') ? acceptsSocksConnect(address) : acceptsHttpConnect(address),
): Promise<string | null> {
  const scheme = mode === 'http' ? 'http' : 'socks5';
  const hosts = await gateways().catch(() => [] as string[]);
  const current = [...new Set(hosts)].slice(0, 16).map(host => `${scheme}://${host.includes(':') ? '[' + host + ']' : host}:${port}`);
  // Probe in parallel but respect route priority, even when an unrelated listener replies faster.
  const attempts = current.map(address => probe(address).catch(() => false));
  for (const [index, attempt] of attempts.entries()) {
    if (await attempt) return current[index];
  }
  const previous = parseNetworkEndpoint(savedAddress, 'http') ?? parseNetworkEndpoint(savedAddress, 'global');
  if (!previous || previous.port !== port) return null;
  const fallback = `${scheme}://${previous.host}:${port}`;
  return !current.includes(fallback) && await probe(fallback) ? fallback : null;
}

export async function linuxLocalProxies(gatewayPort: number, resolveSystemProxy: () => Promise<string>, findListeners = vpnListeners): Promise<string[]> {
  // A desktop PAC can be unavailable. Keep configured environment and listener hints usable.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const desktop = Promise.race([resolveSystemProxy().catch(() => ''), new Promise<string>(resolve => {
    timer = setTimeout(() => resolve(''), 3000);
  })]).finally(() => clearTimeout(timer));
  const [rules, listeners] = await Promise.all([desktop, findListeners().catch(() => [])]);
  const hints = rules.split(';').flatMap(rule => /^\s*PROXY\s+(\S+)\s*$/i.exec(rule)?.slice(1) ?? []);
  for (const key of ['https_proxy', 'http_proxy', 'all_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    if (process.env[key]) hints.push(process.env[key]!);
  }
  const unique = new Set([...hints, ...listeners].map(hint => localHttpEndpoint(hint, gatewayPort)).filter((url): url is string => !!url));
  const candidates = [...unique].slice(0, 12);
  const verified = await Promise.all(candidates.map(acceptsHttpConnect));
  return candidates.filter((_, index) => verified[index]);
}
