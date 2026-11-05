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
  source?: 'client-import' | 'relay';
  clientImport?: RelayClientImportProvenance;
  /** Local relay credential presence only; never establishes upstream login. */
  relayKeyConfigured?: boolean;
  usage: SubscriptionUsage;
}

export interface RelayClientImportProvenance {
  client: 'trae-cn' | 'trae-solo-cn' | 'jetbrains-central';
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
