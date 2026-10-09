import { contextBridge, ipcRenderer } from 'electron';
import type { ModelDockApi } from '../shared/types';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke('modeldock:' + method, ...args);
const rendererErrorNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError']);
const api: ModelDockApi = {
  jetBrainsStatus: (tool, refresh) => call('jetBrainsStatus', tool, refresh),
  reportRendererError: async input => {
    if (!input || (input.kind !== 'error' && input.kind !== 'unhandled-rejection')) return;
    ipcRenderer.send('modeldock:renderer-diagnostic', { kind: input.kind, errorName: typeof input.errorName === 'string' && rendererErrorNames.has(input.errorName) ? input.errorName : 'Error' });
  },
  queryDiagnostics: query => call('queryDiagnostics', query), diagnosticsText: query => call('diagnosticsText', query),
  exportDiagnostics: query => call('exportDiagnostics', query), openDiagnosticsDir: () => call('openDiagnosticsDir'),
  snapshot: () => call('snapshot'), saveProvider: input => call('saveProvider', input),
  listProviderDuplicates: () => call('listProviderDuplicates'), mergeProviderDuplicates: (ids, fingerprint) => call('mergeProviderDuplicates', ids, fingerprint),
  deleteProvider: id => call('deleteProvider', id), saveModel: input => call('saveModel', input),
  deleteModel: id => call('deleteModel', id), saveBinding: binding => call('saveBinding', binding),
  testProvider: (id, input) => call('testProvider', id, input), startGateway: port => call('startGateway', port),
  discoverModels: id => call('discoverModels', id), addDiscoveredModels: (id, selected) => call('addDiscoveredModels', id, selected),
  stopGateway: () => call('stopGateway'), copyText: text => call('copyText', text), copyGatewayKey: () => call('copyGatewayKey'),
  copyConnectionKey: tool => call('copyConnectionKey', tool),
  previewConfig: tool => call('previewConfig', tool), exportConfig: tool => call('exportConfig', tool),
  applyConfig: tool => call('applyConfig', tool), restoreOfficialConfig: tool => call('restoreOfficialConfig', tool),
  toolSyncUndoStatus: tool => call('toolSyncUndoStatus', tool), undoToolSync: tool => call('undoToolSync', tool),
  beginLogin: id => call('beginLogin', id),
  authProgress: id => call('authProgress', id), cancelLogin: id => call('cancelLogin', id),
  openDataDir: () => call('openDataDir'),
  authAccounts: () => call('authAccounts'), refreshAccountUsage: id => call('refreshAccountUsage', id),
  logoutAccount: id => call('logoutAccount', id), importLocalAccount: kind => call('importLocalAccount', kind),
  beginCopilotLogin: () => call('beginCopilotLogin'), copilotAuthProgress: () => call('copilotAuthProgress'),
  cancelCopilotLogin: () => call('cancelCopilotLogin'), copilotLogoutAccount: id => call('copilotLogoutAccount', id),
  mcpList: () => call('mcpList'), mcpSave: input => call('mcpSave', input), mcpDelete: id => call('mcpDelete', id),
  mcpSetTool: (id, tool, enabled) => call('mcpSetTool', id, tool, enabled), mcpImport: tool => call('mcpImport', tool),
  mcpPreview: tool => call('mcpPreview', tool), mcpApply: (tool, fingerprint) => call('mcpApply', tool, fingerprint),
  skillsList: () => call('skillsList'), skillsImportLocal: path => call('skillsImportLocal', path),
  skillsImportRepository: input => call('skillsImportRepository', input), skillsScan: tool => call('skillsScan', tool),
  skillsDeploy: (id, tool, enabled) => call('skillsDeploy', id, tool, enabled), skillsReadFile: (id, path) => call('skillsReadFile', id, path),
  skillsAdopt: (id, tool) => call('skillsAdopt', id, tool),
  skillsPreviewRemove: id => call('skillsPreviewRemove', id), skillsDelete: id => call('skillsDelete', id),
  getSettings: () => call('getSettings'), saveSettings: patch => call('saveSettings', patch),
  probeAuthNetwork: () => call('probeAuthNetwork'),
  openTerminal: () => call('openTerminal'), rendererReady: () => call('rendererReady'),
};
contextBridge.exposeInMainWorld('modelDock', Object.freeze(api));

// 修改点：界面异常只报告受控类型；不传异常正文、页面地址、堆栈或聊天内容。

window.addEventListener('error', event => {
  if (event.target !== window) return;
  ipcRenderer.send('modeldock:renderer-diagnostic', { kind: 'error', errorName: rendererErrorNames.has(event.error?.name) ? event.error.name : 'Error' });
});
window.addEventListener('unhandledrejection', event => {
  ipcRenderer.send('modeldock:renderer-diagnostic', { kind: 'unhandled-rejection', errorName: rendererErrorNames.has(event.reason?.name) ? event.reason.name : 'Error' });
});
