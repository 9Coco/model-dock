import type { ModelDockApi } from '../shared/types';
import type { DiagnosticContext, DiagnosticEvent, DiagnosticLevel, DiagnosticOperation, DiagnosticOutcome } from '../shared/diagnostic-types';

// 修改点：只从操作结果挑选诊断字段，禁止把 IPC 参数、任意错误文案或返回正文交给日志。
const ignored = new Set(['reportRendererError', 'queryDiagnostics', 'diagnosticsText', 'exportDiagnostics', 'openDiagnosticsDir', 'copyText', 'copyGatewayKey', 'copyConnectionKey']);
const quiet = new Set(['jetBrainsStatus', 'snapshot', 'getSettings', 'rendererReady', 'authAccounts', 'authProgress', 'copilotAuthProgress', 'mcpList', 'skillsList', 'skillsReadFile', 'usageQuery', 'usageSources', 'listProviderDuplicates']);
const providerIdOperations = new Set(['deleteProvider', 'testProvider', 'discoverModels', 'addDiscoveredModels', 'beginLogin', 'authProgress', 'cancelLogin', 'refreshAccountUsage', 'logoutAccount', 'copilotLogoutAccount']);
const toolIdOperations = new Set(['previewConfig', 'exportConfig', 'applyConfig', 'restoreOfficialConfig', 'usageImportTool']);
const tools = new Set(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm']);
const outcomes = new Set(['success', 'failure', 'cancelled', 'skipped', 'model-required', 'configuration', 'authentication', 'permission', 'model', 'rate-limit', 'upstream', 'network', 'timeout', 'invalid-response', 'unsupported', 'invalid-provider', 'missing-credentials', 'region', 'device-disabled', 'denied', 'expired', 'blocked']);
const stages = new Set(['device-code', 'device-poll', 'token-exchange', 'account-info', 'refresh', 'discovery']);
const events: Partial<Record<keyof ModelDockApi, DiagnosticEvent>> = {
  saveProvider: 'provider.save', deleteProvider: 'provider.delete', testProvider: 'connection.result', discoverModels: 'models.discovery',
  beginLogin: 'account.login', beginCopilotLogin: 'account.login', logoutAccount: 'account.logout', copilotLogoutAccount: 'account.logout',
  refreshAccountUsage: 'account.refresh', previewConfig: 'config.preview', applyConfig: 'config.apply', restoreOfficialConfig: 'config.restore',
  mcpSave: 'mcp.operation', mcpDelete: 'mcp.operation', mcpSetTool: 'mcp.operation', mcpImport: 'mcp.operation', mcpApply: 'mcp.operation',
  skillsImportLocal: 'skills.operation', skillsImportRepository: 'skills.operation', skillsDeploy: 'skills.operation', skillsAdopt: 'skills.operation', skillsDelete: 'skills.operation',
  usageImportTool: 'usage.import', usageSyncTools: 'usage.import',
};
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function id(value: unknown): string | undefined { return typeof value === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|copilot:(?:[1-9]\d*|login)|deepseek|volcengine-agent|volcengine-token|qwen-token|codex-subscription|grok-build|copilot-subscription)$/i.test(value) ? value : undefined; }
function outcome(value: unknown): DiagnosticOutcome { return (typeof value === 'string' && outcomes.has(value) ? value : 'failure') as DiagnosticOutcome; }
export function ignoresDiagnosticOperation(name: string): boolean { return ignored.has(name); }
export function isQuietDiagnosticOperation(name: string): boolean { return quiet.has(name); }
export function diagnosticOperationContext(name: keyof ModelDockApi, args: readonly unknown[]): DiagnosticContext {
  const context: DiagnosticContext = { operation: name as DiagnosticOperation };
  if (providerIdOperations.has(name)) context.providerId = id(args[0]);
  if (toolIdOperations.has(name) && typeof args[0] === 'string' && tools.has(args[0])) context.toolId = args[0] as DiagnosticContext['toolId'];
  if (name === 'testProvider') context.modelId = id(object(args[1]).modelId);
  if (name === 'saveProvider') context.providerId = id(object(args[0]).id);
  if (name === 'saveModel') { context.providerId = id(object(args[0]).providerId); context.modelId = id(object(args[0]).id); }
  if (name === 'saveBinding' && tools.has(String(object(args[0]).id))) context.toolId = object(args[0]).id as DiagnosticContext['toolId'];
  return context;
}
export interface OperationDiagnostic { level: DiagnosticLevel; event: DiagnosticEvent; context: DiagnosticContext }
export function diagnosticOperationResult(name: keyof ModelDockApi, args: readonly unknown[], result: unknown, durationMs: number): OperationDiagnostic | undefined {
  if (ignored.has(name)) return;
  const data = object(result), usage = object(data.usage), context = diagnosticOperationContext(name, args);
  context.durationMs = Math.max(0, Math.round(durationMs));
  if (Number.isInteger(data.statusCode) && Number(data.statusCode) >= 100 && Number(data.statusCode) <= 599) context.statusCode = Number(data.statusCode);
  if (name === 'saveProvider') context.providerId = id(data.id);
  if (name === 'saveModel') context.modelId = id(data.id);
  if (name === 'testProvider') {
    if (data.wireApi === 'chat-completions' || data.wireApi === 'responses' || data.wireApi === 'messages') context.wireApi = data.wireApi;
    context.outcome = data.ok === true ? 'success' : outcome(data.outcome);
    return { level: data.ok === true ? 'info' : 'warn', event: 'connection.result', context };
  }
  if (name === 'discoverModels') {
    context.outcome = data.ok === true ? 'success' : outcome(data.errorCategory);
    if (Array.isArray(data.models)) context.modelCount = data.models.length;
    return { level: data.ok === true ? 'info' : 'warn', event: 'models.discovery', context };
  }
  if (['beginLogin', 'beginCopilotLogin', 'authProgress', 'copilotAuthProgress'].includes(name) && ['pending', 'complete', 'error', 'cancelled'].includes(String(data.state))) {
    context.providerId = id(data.providerId);
    if (typeof data.stage === 'string' && stages.has(data.stage)) context.stage = data.stage as DiagnosticContext['stage'];
    context.outcome = (data.state === 'error' ? outcome(data.category) : data.state === 'complete' ? 'success' : data.state === 'pending' ? 'pending' : 'cancelled') as DiagnosticOutcome;
    return { level: data.state === 'error' ? 'warn' : 'info', event: 'auth.progress', context };
  }
  if (name === 'cancelLogin' || name === 'cancelCopilotLogin') {
    if (name === 'cancelCopilotLogin') context.providerId = 'copilot:login';
    context.outcome = 'cancelled'; return { level: 'info', event: 'auth.progress', context };
  }
  if (name === 'refreshAccountUsage' && ['error', 'stale', 'unavailable'].includes(String(usage.status))) {
    context.outcome = (usage.status === 'error' ? 'failure' : usage.status) as DiagnosticOutcome;
    return { level: 'warn', event: 'account.refresh', context };
  }
  if (quiet.has(name)) return;
  const failed = data.ok === false || data.state === 'error';
  context.outcome = failed ? outcome(data.outcome ?? data.errorCategory ?? data.category) : 'success';
  return { level: failed ? 'warn' : 'info', event: events[name] ?? 'operation.succeeded', context };
}
