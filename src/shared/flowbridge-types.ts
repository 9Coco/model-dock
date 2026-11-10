// SPDX-License-Identifier: GPL-3.0-or-later
export type NetworkMode = 'http' | 'global';
export function parseNetworkEndpoint(address: string, mode: NetworkMode) {
  const scheme = mode === 'global' ? 'socks5' : 'http';
  const value = address.includes('://') ? address : scheme + '://' + address;
  const match = /^(http|socks5):\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):([0-9]+)\/?$/.exec(value);
  if (!match || match[1] !== scheme) return;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return;
  const host = match[2].toLowerCase();
  return { host, port, address: `${scheme}://${host}:${port}` };
}
export interface FlowBridgeSettings {
  address: string;
  mode: NetworkMode;
  dnsMode: 'fast' | 'compatible';
  autoConnect: boolean;
  showMiniOnStart: boolean;
}
export const DEFAULT_FLOWBRIDGE: Readonly<FlowBridgeSettings> = Object.freeze({ address: '', mode: 'http', dnsMode: 'fast', autoConnect: false, showMiniOnStart: false });
export interface NetworkSample { time: number; uploadRate: number; downloadRate: number; uploadBytes: number; downloadBytes: number }
export interface NetworkEngineStatus { running: boolean; cleanupConfirmed: boolean; localPort: number | null; uploadBytes: number; downloadBytes: number; connections: number; message: string }
export interface FlowBridgeSnapshot {
  settings: FlowBridgeSettings;
  state: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';
  message: string;
  platform: string;
  status: NetworkEngineStatus;
  history: NetworkSample[];
}
export const NETWORK_SITES = ['Google', 'YouTube', 'X', 'ChatGPT', 'GitHub', 'Cloudflare'] as const;
export type NetworkSite = typeof NETWORK_SITES[number];
export const NETWORK_SITE_URLS: Record<NetworkSite, string> = {
  Google: 'https://www.google.com/', YouTube: 'https://www.youtube.com/', X: 'https://x.com/',
  ChatGPT: 'https://chatgpt.com/', GitHub: 'https://github.com/', Cloudflare: 'https://www.cloudflare.com/',
};
export type SiteLatency = { site: NetworkSite } & (
  { state: 'response'; ms: number; httpStatus: number | null } | { state: 'timeout' | 'unreachable' }
);
export interface WebsiteResult { name: string; url: string; status_code: number | null; elapsed_ms: number; ok: boolean; detail: string; reachable: boolean; browser_verification: boolean; attempts: number }
export interface NetworkCheck { system: WebsiteResult; proxy: WebsiteResult | null }
export type ProxySpeedMetric = 'latency' | 'download' | 'upload';
export interface FlowBridgeApi {
  measureNetworkSites(address: string, onResult: (result: SiteLatency) => void): Promise<void>;
  measureNetworkSpeed(address: string, metric: ProxySpeedMetric): Promise<number>;
  networkSnapshot(): Promise<FlowBridgeSnapshot>;
  saveNetworkSettings(patch: Partial<FlowBridgeSettings>, options?: { offlineOnly: boolean }): Promise<FlowBridgeSnapshot>;
  connectNetwork(upstream?: Pick<FlowBridgeSettings, 'address' | 'mode'>): Promise<FlowBridgeSnapshot>;
  disconnectNetwork(): Promise<FlowBridgeSnapshot>;
  checkNetworkSite(site: NetworkSite): Promise<NetworkCheck>;
  networkHotspotCandidates(): Promise<string[]>;
  networkLocalProxies(): Promise<string[]>;
  exportPhoneProxy(): Promise<string | null>;
  showNetworkMini(): Promise<void>;
  openNetworkSite(site: NetworkSite): Promise<void>;
}
