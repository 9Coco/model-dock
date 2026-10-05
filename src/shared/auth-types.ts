import type { Provider } from './types';

export type SubscriptionKind = 'codex' | 'grok';
export type AuthAccountKind = SubscriptionKind | 'copilot';

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  windowSeconds?: number;
  total?: number;
  remaining?: number;
  unit?: string;
  unlimited?: boolean;
  /** A recognized CC Switch-compatible proto3 zero default is labeled explicitly. */
  measurement?: 'reported' | 'protobuf-default';
}

/** Only measured quota values belong here. An unavailable query has no windows. */
export interface SubscriptionUsage {
  status: 'not-queried' | 'ready' | 'stale' | 'unavailable' | 'error';
  windows: QuotaWindow[];
  queriedAt?: string;
  message: string;
  resetCredits?: { available: number; expiresAt: (string | null)[] };
  resetCreditsStatus?: 'ready' | 'unavailable' | 'not-supported' | 'stale';
  resetCreditsMessage?: string;
}

/** Renderer-safe account view; never carries OAuth tokens or a raw upstream body. */
export interface AuthAccount {
  providerId: string;
  providerName: string;
  kind: AuthAccountKind;
  accountId?: string;
  email?: string;
  displayName?: string;
  /** Public, allowlisted HTTPS profile image; never a token-bearing URL. */
  avatarUrl?: string;
  plan?: string;
  authStatus: Provider['authStatus'] | 'expired';
  expiresAt?: number;
  canRefresh: boolean;
  source?: 'client-import';
  usage: SubscriptionUsage;
}
