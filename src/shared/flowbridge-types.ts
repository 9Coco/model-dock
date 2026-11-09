// SPDX-License-Identifier: GPL-3.0-or-later
export type NetworkMode = 'http' | 'global';
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
export const NETWORK_SITES = ['Google', 'YouTube', 'GitHub', 'ChatGPT', 'Cloudflare'] as const;
export type NetworkSite = typeof NETWORK_SITES[number];
export interface WebsiteResult { name: string; url: string; status_code: number | null; elapsed_ms: number; ok: boolean; detail: string; reachable: boolean; browser_verification: boolean; attempts: number }
export interface NetworkCheck { system: WebsiteResult; proxy: WebsiteResult | null }
export interface FlowBridgeApi {
  networkSnapshot(): Promise<FlowBridgeSnapshot>;
  saveNetworkSettings(patch: Partial<FlowBridgeSettings>): Promise<FlowBridgeSnapshot>;
  connectNetwork(upstream?: Pick<FlowBridgeSettings, 'address' | 'mode'>): Promise<FlowBridgeSnapshot>;
  disconnectNetwork(): Promise<FlowBridgeSnapshot>;
  checkNetworkSite(site: NetworkSite): Promise<NetworkCheck>;
  networkHotspotCandidates(): Promise<string[]>;
  networkLocalProxies(): Promise<string[]>;
  exportPhoneProxy(): Promise<string | null>;
  showNetworkMini(): Promise<void>;
  openNetworkSite(site: NetworkSite): Promise<void>;
}
