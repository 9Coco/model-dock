/** 修改点：诊断日志只接受固定事件、固定文案及明确的安全元数据。 */
export const DIAGNOSTIC_MESSAGES = {
  'app.start_failed': '应用启动失败。',
  'app.exit': '应用正在退出。',
  'renderer.load_failed': '界面加载失败。',
  'renderer.crashed': '界面进程意外退出。',
  'renderer.unresponsive': '界面暂时没有响应。',
  'renderer.recovered': '界面已恢复响应。',
  'operation.started': '操作开始执行。',
  'operation.succeeded': '操作执行完成。',
  'operation.failed': '操作执行失败。',
  'auth.progress': '账号授权状态已更新。',
  'network.response': '上游网络请求收到响应。',
  'network.failed': '上游网络请求失败。',
  'connection.response': '模型测试收到上游响应。',
  'connection.result': '模型连通性测试完成。',
  'models.discovery': '模型发现操作完成。',
  'gateway.started': '本地 API 服务启动。',
  'gateway.stopped': '本地 API 服务停止。',
  'gateway.start_failed': '本地 API 服务启动失败。',
  'gateway.runtime_error': '本地 API 服务发生运行错误。',
  'runtime.uncaught_exception': '应用发生未捕获异常。',
  'runtime.unhandled_rejection': '应用发生未处理异步错误。',
  'diagnostics.exported': '诊断日志导出完成。',
  'app.start': '应用开始启动。',
  'app.ready': '应用启动完成。',
  'app.stop': '应用正在退出。',
  'app.error': '应用发生运行错误。',
  'renderer.error': '界面发生运行错误。',
  'gateway.start': '本地 API 服务启动。',
  'gateway.stop': '本地 API 服务停止。',
  'gateway.request': '本地 API 请求处理完成。',
  'provider.save': '供应商配置已保存。',
  'provider.delete': '供应商配置已删除。',
  'provider.test': '供应商连通性测试完成。',
  'provider.models': '供应商模型列表获取完成。',
  'account.login': '订阅账号登录操作完成。',
  'account.logout': '订阅账号退出操作完成。',
  'account.refresh': '订阅账号凭据刷新完成。',
  'config.preview': '工具配置预览完成。',
  'config.apply': '工具配置应用完成。',
  'config.restore': '工具配置恢复完成。',
  'mcp.operation': 'MCP 管理操作完成。',
  'skills.operation': '技能管理操作完成。',
  'usage.import': '工具用量导入完成。',
  'diagnostics.export': '诊断日志导出完成。',
} as const;
export type DiagnosticEvent = keyof typeof DIAGNOSTIC_MESSAGES;
export type DiagnosticMessage = (typeof DIAGNOSTIC_MESSAGES)[DiagnosticEvent];
export type DiagnosticLevel = 'info' | 'warn' | 'error';
export const DIAGNOSTIC_OPERATIONS = ["start", "stop", "save", "delete", "test", "fetch-models", "login", "logout", "refresh", "preview", "export", "apply", "restore", "import", "scan", "deploy", "adopt", "toggle", "request", "read", "open", "snapshot", "jetBrainsStatus", "saveProvider", "deleteProvider", "listProviderDuplicates", "mergeProviderDuplicates", "saveModel", "deleteModel", "saveBinding", "testProvider", "discoverModels", "addDiscoveredModels", "startGateway", "stopGateway", "copyText", "copyGatewayKey", "copyConnectionKey", "previewConfig", "exportConfig", "applyConfig", "restoreOfficialConfig", "beginLogin", "authProgress", "cancelLogin", "openDataDir", "authAccounts", "refreshAccountUsage", "logoutAccount", "importLocalAccount", "beginCopilotLogin", "copilotAuthProgress", "cancelCopilotLogin", "copilotLogoutAccount", "mcpList", "mcpSave", "mcpDelete", "mcpSetTool", "mcpImport", "mcpPreview", "mcpApply", "skillsList", "skillsImportLocal", "skillsImportRepository", "skillsScan", "skillsDeploy", "skillsAdopt", "skillsReadFile", "skillsPreviewRemove", "skillsDelete", "usageQuery", "usageSavePrice", "usageDeletePrice", "usageImportTool", "usageSyncTools", "usageSources", "getSettings", "probeAuthNetwork", "saveSettings", "openTerminal", "rendererReady", "queryDiagnostics", "diagnosticsText", "exportDiagnostics", "openDiagnosticsDir"] as const;
export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number];
export type DiagnosticOutcome = 'success' | 'failure' | 'cancelled' | 'skipped' | 'model-required' | 'configuration' | 'authentication' | 'permission' | 'model' | 'rate-limit' | 'upstream' | 'network' | 'timeout' | 'invalid-response' | 'missing-credentials' | 'unsupported' | 'invalid-provider' | 'region' | 'device-disabled' | 'denied' | 'expired' | 'blocked' | 'pending' | 'complete' | 'error' | 'ready' | 'stale' | 'unavailable' | 'not-queried' | 'crashed' | 'oom' | 'killed' | 'launch-failed' | 'clean-exit';
export type DiagnosticStage = 'startup' | 'shutdown' | 'store' | 'vault' | 'window' | 'renderer' | 'gateway' | 'provider' | 'account' | 'model-list' | 'inference' | 'configuration' | 'oauth' | 'refresh' | 'callback' | 'mcp' | 'skills' | 'usage' | 'diagnostics' | 'device-code' | 'device-poll' | 'token-exchange' | 'account-info' | 'discovery' | 'storage' | 'preferences' | 'proxy' | 'managers' | 'runtime' | 'model-inference' | 'model-catalog' | 'github-profile' | 'quota-query' | 'token-refresh';
export interface DiagnosticErrorDescription { errorName?: string; networkCode?: string; projectFrames?: string[] }
export interface DiagnosticContext extends DiagnosticErrorDescription {
  operation?: DiagnosticOperation;
  traceId?: string;
  version?: string;
  platform?: 'linux' | 'win32' | 'darwin';
  runtimeMode?: 'production' | 'development' | 'smoke';
  modelCount?: number;
  providerId?: string;
  modelId?: string;
  toolId?: 'codex' | 'opencode' | 'dsh' | 'vscode' | 'copilot' | 'claude-code' | 'webstorm' | 'intellij-idea' | 'rider' | 'pycharm';
  statusCode?: number;
  durationMs?: number;
  outcome?: DiagnosticOutcome;
  stage?: DiagnosticStage;
  endpoint?: string;
  port?: number;
  autoStart?: boolean;
  exitCode?: number;
  wireApi?: 'chat-completions' | 'responses' | 'anthropic-messages' | 'messages';
  responseStatus?: 'completed' | 'incomplete' | 'failed' | 'in_progress' | 'unknown';
  incompleteReason?: 'max_output_tokens' | 'content_filter' | 'missing' | 'unknown';
  contentType?: 'json' | 'sse' | 'html' | 'other' | 'unknown';
  responseBytes?: number;
  outputItems?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  hasOutputText?: boolean;
  hasReasoning?: boolean;
}
export interface DiagnosticEntry {
  timestamp: string;
  sessionId: string;
  entryId: string;
  level: DiagnosticLevel;
  event: DiagnosticEvent;
  message: DiagnosticMessage;
  context: DiagnosticContext;
}
export interface DiagnosticQuery { level?: DiagnosticLevel; search?: string; limit?: number }
export interface DiagnosticSnapshot {
  entries: DiagnosticEntry[];
  directory: string;
  available: boolean;
  message: string;
  /** 文件总数，包含当前 diagnostics.jsonl。 */
  retention: number;
  maxFileBytes: number;
}
