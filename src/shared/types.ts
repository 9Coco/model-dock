import type { TokenUsage, ModelPrice, UsageQuery, UsageSnapshot } from './usage-types';
import type { AuthAccount, SubscriptionKind } from './auth-types';
import type { McpServer, McpServerInput, McpImportResult, McpConfigPreview, McpApplyResult } from './mcp-types';
import type { ManagedSkill, SkillSnapshot, SkillRepositoryInput, SkillImportResult, SkillFilePreview, SkillRemovePreview } from './skill-types';
import type { ToolUsageImportResult } from './usage-import-types';
import type { AppSettings, SettingsSnapshot } from './settings-types';
import type { DiscoveryResult, ModelSelection, AddModelsResult } from './catalog-types';
import type { ConnectionResult, ConnectionTestInput } from './connection-types';
export type { ConnectionResult, ConnectionTestInput } from './connection-types';
export type ProviderKind = 'openai-compatible' | 'codex' | 'grok' | 'copilot';
export type ToolId = 'codex' | 'opencode' | 'dsh' | 'vscode' | 'copilot';
export type WireApi = 'chat-completions' | 'responses';
export type ToolMode = 'direct' | 'aggregate' | 'auto';
/** Thinking levels recognized by client tools (VS Code picker labels these; unknown levels are not written to client configs). */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}
/** Keep known levels in first-seen order; non-array or unknown input yields []. */
export function sanitizeReasoningEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const levels: ReasoningEffort[] = [];
  for (const entry of value) if (isReasoningEffort(entry) && !levels.includes(entry)) levels.push(entry);
  return levels;
}
export type ProviderPresetId = 'custom' | 'deepseek' | 'volcengine-agent' | 'volcengine-token' | 'qwen-token' | 'codex-subscription' | 'grok-build' | 'copilot-subscription';
export interface ProviderPreset {
  id: ProviderPresetId;
  name: string;
  category: 'api' | 'subscription';
  kind: ProviderKind;
  baseUrl: string;
  defaultWireApi: WireApi;
  note: string;
  docsUrl: string;
}
/** Main-process only. Never return token material in renderer snapshots. */
export interface ProviderSecret {
  apiKey?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  tokenEndpoint?: string;
  /** 修改点：仅引用主进程加密存储的 GitHub 账号，不复制 OAuth token。 */
  copilotAccountId?: string;
}

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  presetId?: ProviderPresetId;
  baseUrl: string;
  enabled: boolean;
  hasSecret: boolean;
  authStatus: 'ready' | 'missing' | 'signing-in' | 'error';
  note: string;
  /** Renderer-safe account reference; never a GitHub or Copilot token. */
  copilotAccountId?: string;
}
export interface ProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  presetId?: ProviderPresetId;
  baseUrl: string;
  enabled: boolean;
  apiKey?: string;
  note?: string;
  /** Explicitly choose an already authorized GitHub account, or leave empty to log in later. */
  copilotAccountId?: string;
}
export interface Model {
  id: string;
  providerId: string;
  upstreamId: string;
  alias: string;
  displayName: string;
  wireApi: WireApi;
  contextWindow: number;
  tools: boolean;
  vision: boolean;
  enabled: boolean;
  /** Thinking levels the model supports, synced to client configs. Empty = no Thinking Effort picker. */
  reasoningEfforts?: ReasoningEffort[];
  /** Level preselected by client tools; must be one of reasoningEfforts. */
  defaultReasoningEffort?: ReasoningEffort;
}
export type ModelInput = Omit<Model, 'id'> & { id?: string };
export interface ToolBinding {
  id: ToolId;
  name: string;
  enabled: boolean;
  mode?: ToolMode;
  providerIds?: string[];
  modelIds: string[];
  /** Explicit selected lists may be empty; omitted keeps legacy empty-means-all behavior. */
  modelSelection?: 'all' | 'selected';
  defaultModelId: string;
  note: string;
  /** VS Code custom endpoints only; other vendors are always preserved. */
  vscodeSyncScope?: 'managed' | 'selected';
  /** Copilot desktop custom sources only; GitHub accounts are never removed. */
  copilotSyncScope?: 'managed' | 'selected';
  /** DSH model sources only; platform account authorization is preserved. */
  dshSyncScope?: 'managed' | 'selected';
}
export interface GatewayStatus {
  running: boolean;
  host: string;
  port: number;
  baseUrl: string;
  requests: number;
  lastError: string;
}
export interface RequestLog {
  id: string;
  time: string;
  alias: string;
  providerName: string;
  endpoint: string;
  status: number;
  durationMs: number;
  tool?: ToolId;
  providerId?: string;
  modelId?: string;
  usage?: TokenUsage;
}
export interface Snapshot {
  providers: Provider[];
  models: Model[];
  bindings: ToolBinding[];
  gateway: GatewayStatus;
  logs: RequestLog[];
  dataDir: string;
  version: string;
}
export interface ConfigPreview { filename: string; content: string; instructions: string; canApply: boolean }
export type AuthStage = 'device-code' | 'device-poll' | 'token-exchange' | 'account-info' | 'refresh' | 'discovery';
export type AuthFailureCategory = 'network' | 'timeout' | 'region' | 'device-disabled' | 'denied' | 'expired' | 'rate-limit' | 'blocked' | 'invalid-response' | 'upstream';
export interface AuthProgress {
  errorCode?: import('./network-types').AuthNetworkErrorCode;
  providerId: string;
  state: 'pending' | 'complete' | 'error' | 'cancelled';
  userCode?: string;
  verificationUri?: string;
  message: string;
  stage?: AuthStage;
  statusCode?: number;
  category?: AuthFailureCategory;
}
export interface ModelDockApi {
  snapshot(): Promise<Snapshot>;
  saveProvider(input: ProviderInput): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  listProviderDuplicates(): Promise<import('./provider-duplicates').ProviderDuplicateGroup[]>;
  mergeProviderDuplicates(providerIds: string[], fingerprint: string): Promise<import('./provider-duplicates').ProviderMergeResult>;
  saveModel(input: ModelInput): Promise<Model>;
  deleteModel(id: string): Promise<void>;
  saveBinding(binding: ToolBinding): Promise<void>;
  testProvider(id: string, input?: ConnectionTestInput): Promise<ConnectionResult>;
  discoverModels(id: string): Promise<DiscoveryResult>;
  addDiscoveredModels(id: string, selections: ModelSelection[]): Promise<AddModelsResult>;
  startGateway(port?: number): Promise<GatewayStatus>;
  stopGateway(): Promise<GatewayStatus>;
  copyText(text: string): Promise<void>;
  copyGatewayKey(): Promise<void>;
  copyConnectionKey(tool: ToolId): Promise<void>;
  previewConfig(tool: ToolId): Promise<ConfigPreview>;
  exportConfig(tool: ToolId): Promise<string | null>;
  applyConfig(tool: ToolId): Promise<string>;
  restoreOfficialConfig(tool: ToolId): Promise<string>;
  beginLogin(id: string): Promise<AuthProgress>;
  authProgress(id: string): Promise<AuthProgress | null>;
  cancelLogin(id: string): Promise<void>;
  openDataDir(): Promise<void>;
  authAccounts(): Promise<AuthAccount[]>;
  refreshAccountUsage(id: string): Promise<AuthAccount>;
  logoutAccount(id: string): Promise<void>;
  importLocalAccount(kind: SubscriptionKind): Promise<AuthAccount>;
  beginCopilotLogin(): Promise<AuthProgress>;
  copilotAuthProgress(): Promise<AuthProgress | null>;
  cancelCopilotLogin(): Promise<void>;
  copilotLogoutAccount(id: string): Promise<void>;
  mcpList(): Promise<McpServer[]>;
  mcpSave(input: McpServerInput): Promise<McpServer>;
  mcpDelete(id: string): Promise<void>;
  mcpSetTool(id: string, tool: ToolId, enabled: boolean): Promise<McpServer>;
  mcpImport(tool: ToolId): Promise<McpImportResult>;
  mcpPreview(tool: ToolId): Promise<McpConfigPreview>;
  mcpApply(tool: ToolId, expectedFingerprint?: string): Promise<McpApplyResult>;
  skillsList(): Promise<SkillSnapshot>;
  skillsImportLocal(path?: string): Promise<ManagedSkill | null>;
  skillsImportRepository(input: SkillRepositoryInput): Promise<SkillImportResult>;
  skillsScan(tool: ToolId): Promise<SkillImportResult>;
  skillsDeploy(id: string, tool: ToolId, enabled: boolean): Promise<ManagedSkill>;
  skillsAdopt(id: string, tool: ToolId): Promise<ManagedSkill>;
  skillsReadFile(id: string, relativePath?: string): Promise<SkillFilePreview>;
  skillsPreviewRemove(id: string): Promise<SkillRemovePreview>;
  skillsDelete(id: string): Promise<void>;
  usageQuery(query: UsageQuery): Promise<UsageSnapshot>;
  usageSavePrice(price: ModelPrice): Promise<void>;
  usageDeletePrice(modelId: string): Promise<void>;
  usageImportTool(tool: ToolId): Promise<ToolUsageImportResult>;
  usageSyncTools(): Promise<import('./usage-import-types').UsageSyncResult>;
  usageSources(): Promise<import('./usage-import-types').UsageSourcesSnapshot>;
  getSettings(): Promise<SettingsSnapshot>;
  probeAuthNetwork(): Promise<import('./network-types').AuthNetworkDiagnostic>;
  saveSettings(patch: Partial<AppSettings>): Promise<SettingsSnapshot>;
  openTerminal(): Promise<void>;
  rendererReady(): Promise<void>;
}
declare global { interface Window { modelDock: ModelDockApi } }
