import type { Provider } from './types';

export type SubscriptionKind = 'codex' | 'grok';
/** Relay-backed subscriptions keep their own upstream login flow. */
export type RelayAccountKind = 'trae-cn-relay' | 'jetbrains-central';
export type AuthAccountKind = SubscriptionKind | 'copilot' | RelayAccountKind;

/** Renderer-safe choices discovered only after an explicit import action. */
export interface CopilotImportCandidate {
  id: string;
  client: 'copilot-cli' | 'github-cli';
  login: string;
  label: string;
}

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  /** Entitlement expiry, independent of any quota reset. */
  expiresAt?: string;
  windowSeconds?: number;
  total?: number;
  remaining?: number;
  unit?: string;
  unlimited?: boolean;
  /** Number of independent entitlement grants represented by this window. */
  grantCount?: number;
  /** Distinguish reported values, recognized proto3 defaults and separately
   * verified official-client defaults; none applies to arbitrary missing data. */
  measurement?: 'reported' | 'protobuf-default' | 'official-default';
}

/** Only measured quota values belong here. An unavailable query has no windows. */
export interface SubscriptionUsage {
  status: 'not-queried' | 'ready' | 'stale' | 'unavailable' | 'error';
  windows: QuotaWindow[];
  /** An optional account-wide value, separate from source or time windows. */
  summary?: QuotaWindow;
  /** Independent grants underlying a grouped quota observation. */
  details?: QuotaWindow[];
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
  /** Read-only quota retrieval; independent of OAuth token refresh. */
  canQueryUsage?: boolean;
  source?: 'client-import' | 'relay';
  clientImport?: RelayClientImportProvenance;
  /** Local relay credential presence only; never establishes upstream login. */
  relayKeyConfigured?: boolean;
  usage: SubscriptionUsage;
}

export interface RelayClientImportProvenance {
  client: 'trae-cn' | 'trae-solo-cn' | 'jetbrains-central' | 'jetbrains-ide';
  accountLabel?: string;
  importedAt: string;
  /** Native account/session validation only; never model inference validation. */
  upstreamVerified: boolean;
}
export interface RelayClientImportCandidate {
  id: string;
  clientName: string;
  accountLabel?: string;
}
export interface RelayClientImportPreview {
  kind: RelayAccountKind;
  candidates: RelayClientImportCandidate[];
  message: string;
}

export type JetBrainsIdeImportResult = { status: 'imported'; account: AuthAccount }
  | { status: 'selection-required'; preview: RelayClientImportPreview };
