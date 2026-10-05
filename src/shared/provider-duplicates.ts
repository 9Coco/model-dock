import type { ProviderKind, ToolId } from './types';

export interface ProviderDuplicateMember {
  id: string;
  name: string;
  hasSecret: boolean;
  modelCount: number;
  enabled: boolean;
}

export interface ProviderDuplicateGroup {
  name: string;
  baseUrl: string;
  providerIds: string[];
  targetProviderId: string;
  totalModels: number;
  providers: ProviderDuplicateMember[];
  canMerge: boolean;
  message: string;
  fingerprint: string;
  affectedTools: { id: ToolId; name: string; beforeModels: number; afterModels: number }[];
}

export interface ProviderMergeResult {
  keptProviderId: string;
  removedProviderIds: string[];
  movedModels: number;
  backupPath: string;
}

/** URL parsing normalizes host casing/default ports; distinct API paths stay distinct. */
export function canonicalProviderUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try { return new URL(trimmed).toString().replace(/\/+$/, ''); }
  catch { return trimmed.replace(/\/+$/, ''); }
}

/** Names identify separately named accounts even when their API endpoints match. */
export function providerIdentity(provider: { kind: ProviderKind; name: string; baseUrl: string }): string {
  return JSON.stringify([provider.kind, provider.name.trim().toLowerCase(), canonicalProviderUrl(provider.baseUrl)]);
}
