import type { ToolId } from './types';

export const MCP_SECRET_PLACEHOLDER = '__MODELDOCK_REDACTED__';

export type McpTransport = 'stdio' | 'http' | 'sse';
/** Env/Headers are blank; credential argument/query values use MCP_SECRET_PLACEHOLDER. */
export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  redactedEnvKeys: string[];
  redactedHeaderKeys: string[];
  enabledTools: ToolId[];
  description: string;
  importedFrom?: ToolId;
}
export interface McpServerInput {
  id?: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Blank/omitted values retain stored credentials; these keys explicitly remove them. */
  deleteEnvKeys?: string[];
  deleteHeaderKeys?: string[];
  enabledTools: ToolId[];
  description?: string;
}
export interface McpImportResult {
  tool: ToolId;
  filename: string;
  imported: number;
  skipped: number;
  warnings: string[];
}
export interface McpConfigPreview {
  tool: ToolId;
  filename: string;
  /** Only the MCP projection, never the rest of the client configuration. Secrets redacted. */
  content: string;
  instructions: string;
  canApply: boolean;
  fingerprint: string;
  additions: string[];
  updates: string[];
  removals: string[];
  conflicts: string[];
  warnings: string[];
}
export interface McpApplyResult {
  tool: ToolId;
  filename: string;
  backupPath?: string;
  changed: boolean;
  count: number;
}
