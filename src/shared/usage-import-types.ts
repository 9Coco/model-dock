import type { ToolId } from './types';

export interface ToolUsageImportResult {
  tool: ToolId;
  scannedFiles: number;
  imported: number;
  skipped: number;
  deferredFiles: number;
  warnings: string[];
  unsupported?: string;
  status?: 'ready' | 'missing' | 'unsupported' | 'error';
}

export interface UsageSyncResult {
  startedAt: string;
  completedAt: string;
  imported: number;
  skipped: number;
  scannedFiles: number;
  deferredFiles: number;
  results: ToolUsageImportResult[];
  warnings: string[];
}
export interface UsageDataSource {
  id: string;
  source: 'gateway' | 'client';
  tool?: ToolId;
  name: string;
  status: 'ready' | 'missing' | 'unsupported' | 'error';
  supported: boolean;
  paths: string[];
  format: string;
  description: string;
  lastSyncAt?: string;
  lastResult?: ToolUsageImportResult;
}
export interface UsageSourcesSnapshot {
  queriedAt: string;
  privacy: string;
  sources: UsageDataSource[];
  lastSync?: UsageSyncResult;
}
