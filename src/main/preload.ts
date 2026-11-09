import { contextBridge, ipcRenderer } from 'electron';
import type { ModelDockApi } from '../shared/types';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke('modeldock:' + method, ...args);
const relayImportCall = async (method: 'relayClientImportCandidates' | 'importRelayClientAccount' | 'jetBrainsIdeImportCandidates' | 'importJetBrainsIdeAccount' | 'beginJetBrainsIdeImport', ...args: unknown[]) => {
  try { return await call(method, ...args); }
  catch (error) {
    // Main already restricts these failures to safe user messages. Remove
    // Electron's transport prefix before crossing the renderer bridge.
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method ['"]modeldock:(?:relayClientImportCandidates|importRelayClientAccount|jetBrainsIdeImportCandidates|importJetBrainsIdeAccount|beginJetBrainsIdeImport)['"]:\s*(?:Error:\s*)?/, '') : '';
    throw new Error(message || '客户端导入失败，请检查本机客户端登录后重试。');
  }
};
const rendererErrorNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError']);
const api: ModelDockApi = {
  runtimeSnapshot: () => call('runtimeSnapshot'),
  networkSnapshot: () => call('networkSnapshot'), saveNetworkSettings: patch => call('saveNetworkSettings', patch),
  connectNetwork: upstream => call('connectNetwork', upstream), disconnectNetwork: () => call('disconnectNetwork'),
  checkNetworkSite: site => call('checkNetworkSite', site), networkHotspotCandidates: () => call('networkHotspotCandidates'),
  measureNetworkSpeed: (address, metric) => call('measureNetworkSpeed', address, metric),
  networkLocalProxies: () => call('networkLocalProxies'),
  exportPhoneProxy: () => call('exportPhoneProxy'), showNetworkMini: () => call('showNetworkMini'), openNetworkSite: site => call('openNetworkSite', site),
  setJetBrainsPlugin: (tool, plugin) => call('setJetBrainsPlugin', tool, plugin),
  jetBrainsStatus: (tool, refresh) => call('jetBrainsStatus', tool, refresh),
  reportRendererError: async input => {
    if (!input || (input.kind !== 'error' && input.kind !== 'unhandled-rejection')) return;
    ipcRenderer.send('modeldock:renderer-diagnostic', { kind: input.kind, errorName: typeof input.errorName === 'string' && rendererErrorNames.has(input.errorName) ? input.errorName : 'Error' });
  },
  queryDiagnostics: query => call('queryDiagnostics', query), diagnosticsText: query => call('diagnosticsText', query),
  exportDiagnostics: query => call('exportDiagnostics', query), openDiagnosticsDir: () => call('openDiagnosticsDir'),
  startJetBrainsRelay: id => call('startJetBrainsRelay', id),
  stopJetBrainsRelay: () => call('stopJetBrainsRelay'),
  startTraeRelay: () => call('startTraeRelay'),
  openTraeRelayLogin: () => call('openTraeRelayLogin'),
  stopTraeRelay: () => call('stopTraeRelay'),
  importOpenCodeGo: input => call('importOpenCodeGo', input),
  snapshot: () => call('snapshot'), saveProvider: input => call('saveProvider', input),
  listProviderDuplicates: () => call('listProviderDuplicates'), mergeProviderDuplicates: (ids, fingerprint) => call('mergeProviderDuplicates', ids, fingerprint),
  deleteProvider: (id, scope) => call('deleteProvider', id, scope), saveModel: input => call('saveModel', input),
  deleteModel: id => call('deleteModel', id), saveBinding: binding => call('saveBinding', binding),
  testProvider: (id, input) => call('testProvider', id, input), startGateway: port => call('startGateway', port),
  discoverModels: id => call('discoverModels', id), addDiscoveredModels: (id, selected) => call('addDiscoveredModels', id, selected),
  stopGateway: () => call('stopGateway'), copyText: text => call('copyText', text), copyGatewayKey: () => call('copyGatewayKey'),
  setGatewayProviderEnabled: (id, enabled) => call('setGatewayProviderEnabled', id, enabled),
  setGatewayModelEnabled: (id, enabled) => call('setGatewayModelEnabled', id, enabled),
  copyProviderKey: id => call('copyProviderKey', id), revealProviderKey: id => call('revealProviderKey', id), revealGatewayKey: () => call('revealGatewayKey'),
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
  relayClientImportCandidates: kind => relayImportCall('relayClientImportCandidates', kind), importRelayClientAccount: (kind, id) => relayImportCall('importRelayClientAccount', kind, id),
  beginJetBrainsIdeImport: (candidateId?: string) => relayImportCall('beginJetBrainsIdeImport', ...(candidateId === undefined ? [] : [candidateId])),
  jetBrainsIdeImportCandidates: () => relayImportCall('jetBrainsIdeImportCandidates'), importJetBrainsIdeAccount: id => relayImportCall('importJetBrainsIdeAccount', id),
  openJetBrainsAccountHelp: topic => call('openJetBrainsAccountHelp', topic),
  copilotImportCandidates: () => call('copilotImportCandidates'), importCopilotClientAccount: id => call('importCopilotClientAccount', id),
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
  rendererReady: () => call('rendererReady'),
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
