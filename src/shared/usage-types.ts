import type { ToolId } from './types';

export interface TokenUsage {
  /** Gross input including cached reads; do not add cachedInputTokens again. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Cache writes are another non-overlapping subset of gross input. */
  cacheCreationInputTokens?: number;
}
export interface UsageRecord {
  id: string; time: string; alias: string; providerName: string; endpoint: string;
  status: number; durationMs: number; tool?: ToolId; providerId?: string; modelId?: string;
  usage?: TokenUsage;
  source?: 'gateway' | 'client';
  sessionId?: string;
}
export interface ModelPrice {
  modelId: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheCreationUsdPerMillion?: number;
}
export interface UsageQuery {
  from: string; to: string;
  /** Includes historical generic gateway calls with no reliable tool attribution. */
  tool?: ToolId | 'unscoped'; providerId?: string; modelId?: string;
  source?: 'gateway' | 'client';
  status?: 'all' | 'success' | 'failed' | number;
  page?: number;
  pageSize?: number;
  granularity?: 'hour' | 'day';
  /** IANA calendar zone; independent of the execution host's local timezone. */
  timeZone?: string;
}
export interface UsageTotals {
  requests: number; succeeded: number; failed: number; reportedRequests: number;
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  newInputTokens: number; cacheCreationInputTokens: number; totalTokens: number; cacheHitPercent: number | null;
  costedRequests: number; estimatedCostUsd: number | null; averageDurationMs: number;
  latencyRecords: number;
  /** Whole-request output rate includes waiting; not decoder throughput. */
  averageOutputTokensPerSecond: number | null;
  speedRecords: number;
}
export interface UsageGroup extends UsageTotals { key: string; label: string }
export interface UsageFilterOption { key: string; label: string }
export interface UsageModelFilterOption extends UsageFilterOption { providerKey?: string }
export interface UsageCollection {
  unit: 'request' | 'usage-event';
  /** Client counter events do not establish HTTP success, failure, or latency. */
  requestMetricsAvailable: boolean;
  missingUsageRecords: number;
  unscopedRecords: number;
  /** Historical names alone cannot identify an individual configured account. */
  unidentifiedProviderRecords: number;
  unidentifiedModelRecords: number;
}
/** Metadata-only request/event row, never a prompt, response body or credential. */
export interface UsageDetail {
  id: string; time: string; source: 'gateway' | 'client';
  tool?: ToolId; toolKey: string; toolLabel: string;
  providerId?: string; providerKey: string; providerName: string;
  modelId?: string; modelKey: string; alias: string; modelLabel: string;
  endpoint: string; status: number | null; durationMs: number | null;
  usage?: TokenUsage; newInputTokens?: number; totalTokens?: number;
  cacheHitPercent: number | null; estimatedCostUsd: number | null;
  /** Derived only from reported output plus a measured gateway duration. */
  tokensPerSecond: number | null;
}
export interface UsageSnapshot extends UsageTotals {
  source: 'gateway' | 'client';
  from: string; to: string; byModel: UsageGroup[]; byProvider: UsageGroup[]; byTool: UsageGroup[];
  daily: UsageGroup[]; hourly: UsageGroup[]; trend: UsageGroup[]; prices: ModelPrice[];
  timeZone: string; granularity: 'hour' | 'day';
  logs: UsageDetail[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  appliedFilters: { tool?: ToolId | 'unscoped'; providerId?: string; modelId?: string; status: 'all' | 'success' | 'failed' | number };
  /** All observed options in this source/date range, before dimension filters. */
  filters: { providers: UsageFilterOption[]; tools: UsageFilterOption[]; models: UsageModelFilterOption[]; statusCodes: number[] };
  collection: UsageCollection;
}
