import { createNetworkSmokeEngine, verifyNetworkUi } from './network-smoke';
import { hotspotCandidates } from './flowbridge';
import { ModelDockRuntime } from './modeldock-runtime';
import { FlowBridgeEngine } from './flowbridge-engine';
import { NetworkMini } from './network-mini';
import { NETWORK_SITES, NETWORK_SITE_URLS, type NetworkSite, type SiteLatency } from '../shared/flowbridge-types';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DiagnosticsLog, describeError, sanitizeDiagnosticEndpoint } from './diagnostic-log';
import { diagnosticOperationContext, diagnosticOperationResult, ignoresDiagnosticOperation, isQuietDiagnosticOperation } from './diagnostic-operations';
import type { DiagnosticContext, DiagnosticEvent, DiagnosticLevel, DiagnosticQuery } from '../shared/diagnostic-types';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell, Tray } from 'electron';
import { getAppIcon } from './app-icon';
import { dirname, join, relative, resolve } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Store } from './store';
import { providerCategory } from '../shared/presets';
import { Gateway } from './gateway';
import { TraeApi, TraeApiError } from './trae-api';
import { parseTraeQuota } from './trae-relay-usage';
import { TraeNativeAccounts, TraeNativeAccountError } from './trae-native-account';
import { TraeGatewayAdapter } from './trae-gateway-adapter';
import { TraeClientImporter, TraeClientImportError } from './trae-client-import';
import { CentralApi, CentralApiError } from './central-api';
import { CentralClientSessionReader } from './central-client-session';
import { CentralGatewayAdapter } from './central-gateway-adapter';
import { CentralNativeAccounts, CentralNativeAccountError } from './central-native-account';
import { RelayClientImportManager, RelayClientImportError, type RelayImportAdapter } from './relay-client-import';
import { RelayQuotaCenter, RelayQuotaFailure } from './relay-quota';
import { OAuthManager } from './oauth';
import { AuthCenter } from './auth-center';
import { CopilotProviderManager } from './copilot-provider';
import { CopilotAuthCenter, isCopilotAccountId } from './copilot-auth';
import { authQuotaFixture } from './auth-quota-fixtures';
import { McpManager } from './mcp';
import { SkillManager } from './skills';
import { SettingsManager } from './settings';
import { ModelCatalog } from './catalog';
import { ConnectionTester } from './connection-test';
import { verifyProviderDuplicates } from './provider-duplicate-smoke';
import { verifyModelNames } from './model-names-smoke';
import { verifyCompactUi } from './compact-ui-smoke';
import { verifyConnectionTest } from './connection-test-smoke';
import { verifyModelMetadata } from './model-metadata-smoke';
import { createGatewayStartupSmokeVault, verifyGatewayStartup } from './gateway-startup-smoke';
import { verifyAuthNetwork, verifyPendingAuth } from './auth-network-smoke';
import { verifyAuthQuotas } from './auth-quota-smoke';
import { verifyCodexCatalog } from './codex-catalog-smoke';
import { verifyGrokLogin } from './grok-login-smoke';
import { verifyToolSelection } from './tool-selection-smoke';
import { verifyToolRestoreAndConnections } from './tool-restore-smoke';
import { verifyCopilotDesktop } from './copilot-desktop-smoke';
import { verifyToolIcons } from './tool-icons-smoke';
import { verifyJetBrainsPluginSwitch } from './jetbrains-plugin-smoke';
import { verifyProviderManagement } from './provider-management-smoke';
import { verifyRelaySubscriptions } from './relay-subscriptions-smoke';
import { verifyRelayClientImport } from './relay-client-import-smoke';
import { verifyRelayQuota } from './relay-quota-smoke';
import { verifyNavigationConsolidation } from './navigation-consolidation-smoke';
import { createHistoryModelsFixture, verifyHistoryModels } from './history-models-smoke';
import { verifySidebarScroll } from './sidebar-scroll-smoke';
import { verifySidebarLayout } from './sidebar-layout-smoke';
import { verifyDshConfiguration } from './dsh-config-smoke';
import { CopilotDesktopClient } from './copilot-desktop';
import { applyCopilotDesktop } from './copilot-sync';
import { ToolSyncUndoManager } from './tool-sync-undo';
import { verifyToolAutoSync } from './tool-auto-sync-smoke';
import { removeProviderAndSync } from './provider-removal';
import { restoreOfficialConfig } from './tool-restore';
import { jetBrainsStatus, type JetBrainsConfigOptions } from './jetbrains-config';
import { isJetBrainsTool } from '../shared/jetbrains';
import { verifyClaudeConfiguration } from './claude-config-smoke';
import { verifyJetBrainsConnections } from './jetbrains-smoke';
import { jetBrainsWindowsSmokeOptions, verifyJetBrainsWindowsProfiles } from './jetbrains-windows-smoke';
import { verifyAggregateModes } from './aggregate-modes-smoke';
import { restoreToolBinding } from './tool-restore-binding';
import { importOpenCodeGo } from './opencode-go-import';
import { measureProxySpeed, measureSiteLatency } from './proxy-speed-test';
import type { ProxySpeedMetric } from '../shared/flowbridge-types';
import { ApplicationNetworkSession } from './network-proxy';
import { inspectAuthNetwork } from './network-diagnostic';
import { createSystemNetworkFetch } from './system-network';
import { resolveRuntimeConfig } from './runtime-mode';
import { bindingConnectionPolicy } from '../shared/bindings';
import { writeClipboardText } from './clipboard-text';
import { localGatewayKey, providerApiKey } from './connection-keys';
import { createVault } from './vault';
import { buildConfig, buildCopilotDesktopPlan, buildDshPlan, applyConfig, connectionKey } from './adapters';
import { applyDshConfig } from './dsh-config';
import { resolveDshProfile } from './dsh-profile';
import type { ModelDockApi, ModelInput, Provider, ProviderInput, ToolBinding, ToolId } from '../shared/types';
import type { QuotaWindow, RelayAccountKind, SubscriptionKind } from '../shared/auth-types';
import type { McpServerInput } from '../shared/mcp-types';
import type { SkillRepositoryInput } from '../shared/skill-types';
import type { AppSettings } from '../shared/settings-types';
import type { ModelSelection } from '../shared/catalog-types';
import type { ConnectionTestInput } from '../shared/connection-types';
import { WindowPresentation } from './window-presentation';
import { observeWindowPresentation, type WindowPresentationProbe } from './window-presentation-smoke';
import { installEditContextMenu } from './edit-context-menu';
import { verifyContextMenus } from './context-menu-smoke';
import { acquireLinuxInstanceGuard } from './linux-instance-guard';
import { applyWaylandColorWorkaround } from './wayland-color';
import { JetBrainsIdeImporter, JetBrainsIdeImportError } from './jetbrains-ide-import';
import { JetBrainsIdeApi, JetBrainsIdeApiError } from './jetbrains-ide-api';
import { JetBrainsIdeAccounts } from './jetbrains-ide-account';
import { JetBrainsGatewayAdapter } from './jetbrains-gateway-adapter';
import { createJetBrainsIdeFixture, verifyJetBrainsIdeImport } from './jetbrains-ide-smoke';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Store;
let runtime: ModelDockRuntime;
let applicationNetwork: ApplicationNetworkSession;
let ideAccounts: JetBrainsIdeAccounts;
let ideGatewayAdapter: JetBrainsGatewayAdapter;
let centralNativeAccounts: CentralNativeAccounts;
let centralGatewayAdapter: CentralGatewayAdapter;
let traeNativeAccounts: TraeNativeAccounts;
let traeGatewayAdapter: TraeGatewayAdapter;
let oauth: OAuthManager;
let accounts: AuthCenter;
let copilotAccounts: CopilotAuthCenter;
let copilotProviders: CopilotProviderManager;
let mcp: McpManager;
let skills: SkillManager;
let preferences: SettingsManager;
let networkMini: NetworkMini;
let shutdownRunning = false;
let shutdownComplete = false;
let catalog: ModelCatalog;
let connectionTester: ConnectionTester;
let presentation: WindowPresentation | null = null;
let windowPresentationProbe: WindowPresentationProbe | undefined;
let explicitOpenRequested = false;
let quitting = false;
let dataDir = '';
let diagnostics: DiagnosticsLog | undefined;
const diagnosticScope = new AsyncLocalStorage<DiagnosticContext>();
const authDiagnosticStates = new Map<string, string>();
const authDiagnosticTraces = new Map<string, string>();
const pollingDiagnosticStates = new Map<string, string>();
let exitDiagnosticRecorded = false;
let startupStage: DiagnosticContext['stage'] = 'startup';
function networkResourceRoot() {
  if (app.isPackaged) return join(process.resourcesPath, 'flowbridge');
  // Development and smoke entries live under work/<mode>-runtime/dist-electron.
  const project = __MODELDOCK_RUNTIME_MODE__ === 'production' ? '..' : '../../..';
  return join(__dirname, project, 'resources/flowbridge');
}
function recordDiagnostic(level: DiagnosticLevel, event: DiagnosticEvent, context: DiagnosticContext = {}): void {
  try { diagnostics?.write(level, event, undefined, { ...diagnosticScope.getStore(), ...context }); }
  catch { /* 日志故障不得改变原操作或重复生成日志。 */ }
}
function recordOperationResult(name: keyof ModelDockApi, args: readonly unknown[], result: unknown, durationMs: number): void {
  const item = diagnosticOperationResult(name, args, result, durationMs);
  if (!item) return;
  if (item.event === 'auth.progress') {
    const key = item.context.providerId ?? name;
    const signature = JSON.stringify([item.context.stage, item.context.outcome, item.context.statusCode]);
    if (name === 'beginLogin' || name === 'beginCopilotLogin') {
      const traceId = diagnosticScope.getStore()?.traceId;
      if (traceId) authDiagnosticTraces.set(key, traceId);
      authDiagnosticStates.delete(key);
    }
    if (authDiagnosticStates.get(key) === signature) return;
    authDiagnosticStates.set(key, signature);
    const traceId = authDiagnosticTraces.get(key);
    if (traceId) item.context.traceId = traceId;
  }
  recordDiagnostic(item.level, item.event, item.context);
}
// 使用 monitor 保留 Node 原有致命异常行为，不把崩溃变成继续运行的隐藏故障。
process.on('uncaughtExceptionMonitor', (error, origin) => recordDiagnostic('error', origin === 'unhandledRejection' ? 'runtime.unhandled_rejection' : 'runtime.uncaught_exception', describeError(error)));

// Apply before Chromium initializes its native Wayland display. Explicit QA
// comparisons can still exercise the unchanged baseline and individual flags.
if (!__MODELDOCK_SMOKE_BUILD__ || !['baseline', 'disable-wayland-color', 'force-srgb'].includes(process.env.MODELDOCK_SMOKE_WINDOW_COLOR_EXPERIMENT ?? '')) {
  applyWaylandColorWorkaround(app.commandLine, process.platform, process.env);
}
const runtimeConfig = resolveRuntimeConfig(__MODELDOCK_RUNTIME_MODE__, process.env);
const modelHistoryOnly = __MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_MODEL_HISTORY_ONLY === '1' && process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1';
const devUrl = __MODELDOCK_RUNTIME_MODE__ === 'development' ? runtimeConfig.devUrl : undefined;
if (runtimeConfig.dataDir) {
  mkdirSync(runtimeConfig.dataDir, { recursive: true });
  app.setPath('userData', runtimeConfig.dataDir);
  app.setPath('sessionData', runtimeConfig.dataDir);
}
const toolIds = new Set(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'copilot-cli', 'claude-code', 'junie', 'webstorm', 'intellij-idea', 'rider', 'pycharm']);
function toolId(value: unknown): ToolId {
  if (typeof value !== 'string' || !toolIds.has(value)) throw new Error('无法识别的工具。');
  return value as ToolId;
}
function appIcon() {
  return getAppIcon();
}
function revealWindow() {
  explicitOpenRequested = true;
  presentation?.requestOpen();
}
async function createWindow(forceShow = false) {
  const mark = appIcon();
  const presentationSmoke = __MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_WINDOW_PRESENTATION_ONLY === '1';
  window = new BrowserWindow({ width: 1080, height: 720, minWidth: 980, minHeight: 680, show: false,
    title: 'ModelDock · 模型坞', backgroundColor: nativeTheme.shouldUseDarkColors ? '#19191c' : '#f8f9fb', icon: mark,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: !__MODELDOCK_SMOKE_BUILD__ || presentationSmoke },
  });
  const currentWindow = window;
  windowPresentationProbe = __MODELDOCK_SMOKE_BUILD__ && presentationSmoke ? observeWindowPresentation(currentWindow, runtimeConfig.smoke!.outputDir, { hidden: preferences.get().settings.startHidden, theme: preferences.get().settings.theme }) : undefined;
  installEditContextMenu(currentWindow.webContents);
  const currentPresentation = new WindowPresentation(
    forceShow || explicitOpenRequested || !preferences.get().settings.startHidden,
    focus => {
      if (__MODELDOCK_SMOKE_BUILD__ && !presentationSmoke || currentWindow.isDestroyed() || window !== currentWindow) return;
      if (__MODELDOCK_SMOKE_BUILD__) windowPresentationProbe?.beforePresent(focus);
      if (currentWindow.isMinimized()) currentWindow.restore();
      currentWindow.show();
      if (focus) {
        currentWindow.focus();
        currentWindow.webContents.focus();
      }
      // Commit a fresh visible frame after native/page activation. A cached
      // hidden-window frame must not need the first mouse click to repaint.
      currentWindow.webContents.invalidate();
    },
  );
  presentation = currentPresentation;
  currentWindow.once('ready-to-show', () => currentPresentation.windowDidPaint());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const docs = ['api-docs.deepseek.com', 'docs.volcengine.com', 'help.aliyun.com', 'developers.openai.com', 'platform.claude.com', 'ai.google.dev', 'docs.z.ai', 'platform.kimi.ai', 'platform.minimax.io', 'docs.x.ai', 'x.ai', 'opencode.ai', 'github.com', 'docs.github.com', 'code.visualstudio.com', 'www.jetbrains.com'];
      const authPage = target.hostname === 'auth.openai.com' || target.hostname === 'auth.x.ai' || target.hostname.endsWith('.x.ai') || target.hostname === 'grok.com' || target.hostname.endsWith('.grok.com');
      if (target.protocol === 'https:' && (docs.includes(target.hostname) || authPage && (!target.port || target.port === '443')) && !target.username && !target.password) void shell.openExternal(url);
    } catch { /* malformed links are denied */ }
    return { action: 'deny' };
  });
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) recordDiagnostic('error', 'renderer.load_failed', { stage: 'renderer', exitCode: errorCode });
  });
  window.webContents.on('render-process-gone', (_event, details) => recordDiagnostic('error', 'renderer.crashed', {
    stage: 'renderer', exitCode: details.exitCode, outcome: ['crashed', 'oom', 'killed', 'launch-failed', 'clean-exit'].includes(details.reason) ? details.reason as DiagnosticContext['outcome'] : 'failure',
  }));
  window.on('unresponsive', () => recordDiagnostic('warn', 'renderer.unresponsive', { stage: 'renderer' }));
  window.on('responsive', () => recordDiagnostic('info', 'renderer.recovered', { stage: 'renderer' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== window?.webContents.getURL()) event.preventDefault(); });
  window.on('close', event => {
    if (shutdownComplete || __MODELDOCK_SMOKE_BUILD__) return;
    event.preventDefault();
    if (quitting) return;
    if (preferences.get().settings.closeToTray && tray) window?.hide();
    else {
      // Finish handling Windows' cancelled WM_CLOSE before requesting a new quit.
      quitting = true;
      setImmediate(() => app.quit());
    }
  });
  window.on('closed', () => { if (window === currentWindow) { window = null; presentation = null; } });
  if (__MODELDOCK_RUNTIME_MODE__ === 'development' && devUrl) {
    const url = new URL(devUrl);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('开发界面只允许本机地址。');
    await window.loadURL(devUrl);
  } else await window.loadFile(join(__dirname, '../dist/index.html'));
  if (__MODELDOCK_SMOKE_BUILD__) {
    if (!presentationSmoke) await window.webContents.executeJavaScript(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';document.head.appendChild(style);})()`);
    const outputDir = runtimeConfig.smoke!.outputDir;
    mkdirSync(outputDir, { recursive: true });
    // Hidden windows can return the previous compositor frame on the first capture.
    async function captureUi() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await window!.webContents.capturePage();
          await new Promise(resolve => setTimeout(resolve, 150));
          return (await window!.webContents.capturePage()).toPNG();
        } catch (error) {
          if (attempt === 2 || !(error instanceof Error) || !error.message.includes('UnknownVizError')) throw error;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      throw new Error('无法获取 Electron 验证截图。');
    }
    setTimeout(async () => {
      try {
        if (windowPresentationProbe) {
          await windowPresentationProbe.complete();
          quitting = true; app.quit(); return;
        }
        const result = await window!.webContents.executeJavaScript(`({title:document.title, text:document.body.innerText, bridge:!!window.modelDock})`);
        writeFileSync(join(outputDir, 'electron-smoke.json'), JSON.stringify({ ...result, dataDir, windowSize: window!.getSize(), contentSize: window!.getContentSize() }, null, 2));
        writeFileSync(join(outputDir, 'electron-smoke.png'), await captureUi());
        if (process.env.MODELDOCK_SMOKE_NETWORK_ONLY === '1') { await verifyNetworkUi(window!, store, outputDir, captureUi); quitting = true; app.quit(); return; }
        if (!modelHistoryOnly && process.env.MODELDOCK_SMOKE_JETBRAINS_IDE_ONLY !== '1' && process.env.MODELDOCK_SMOKE_PROVIDER_MANAGEMENT_ONLY !== '1' && process.env.MODELDOCK_SMOKE_RELAY_QUOTA_ONLY !== '1' && process.env.MODELDOCK_SMOKE_RELAY_CLIENT_IMPORT_ONLY !== '1' && process.env.MODELDOCK_SMOKE_SIDEBAR_LAYOUT_ONLY !== '1' && process.env.MODELDOCK_SMOKE_NAVIGATION_CONSOLIDATION_ONLY !== '1' && process.env.MODELDOCK_SMOKE_RELAY_SUBSCRIPTIONS_ONLY !== '1' && process.env.MODELDOCK_SMOKE_JETBRAINS_PLUGIN_ONLY !== '1' && process.env.MODELDOCK_SMOKE_CONTEXT_MENU_ONLY !== '1') await verifyToolIcons(window!, outputDir, captureUi);
        if (modelHistoryOnly) {
          await verifyHistoryModels(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_CONTEXT_MENU_ONLY === '1') {
          await verifyContextMenus(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_JETBRAINS_PLUGIN_ONLY === '1') {
          await verifyJetBrainsPluginSwitch(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_PROVIDER_MANAGEMENT_ONLY === '1') {
          await verifyProviderManagement(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_RELAY_SUBSCRIPTIONS_ONLY === '1') {
          await verifyRelaySubscriptions(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_RELAY_CLIENT_IMPORT_ONLY === '1') {
          await verifyRelayClientImport(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_JETBRAINS_IDE_ONLY === '1') {
          await verifyJetBrainsIdeImport(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_RELAY_QUOTA_ONLY === '1') {
          await verifyRelayQuota(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_NAVIGATION_CONSOLIDATION_ONLY === '1') {
          await verifyNavigationConsolidation(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_SIDEBAR_LAYOUT_ONLY === '1') {
          await verifySidebarLayout(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_TOOL_ICONS_ONLY === '1') {
          // Icon validation above uses navigation only and never applies tool configuration.
        } else if (process.env.MODELDOCK_SMOKE_AGGREGATE_ONLY === '1') {
          await verifyAggregateModes(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_JETBRAINS_WINDOWS_ONLY === '1') {
          await verifyJetBrainsWindowsProfiles(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_JETBRAINS_ONLY === '1') {
          await verifyJetBrainsConnections(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_TOOL_SYNC_ONLY === '1') {
          await verifyToolAutoSync(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_CLAUDE_ONLY === '1') {
          await verifyClaudeConfiguration(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_METADATA_ONLY === '1') {
          await verifyModelMetadata(window!, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_SIDEBAR_ONLY === '1') {
          await verifySidebarScroll(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_COMPACT_ONLY === '1') {
          await verifyCompactUi(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_CONNECTION_ONLY === '1') {
          await verifyConnectionTest(window!, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_GATEWAY_STARTUP === '1') {
          await verifyGatewayStartup(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_AUTH_QUOTAS_ONLY === '1') {
          await verifyAuthQuotas(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_UPSTREAM) {
          const upstream = process.env.MODELDOCK_SMOKE_UPSTREAM;
          if (new URL(upstream).hostname !== '127.0.0.1') throw new Error('Smoke upstream must be loopback');
          const outcome = await window!.webContents.executeJavaScript(`(async()=>{
            const api=window.modelDock;
            const before=await api.snapshot();
            const provider=await api.saveProvider({id:before.providers.find(p=>p.name==='本地验证来源')?.id,name:'本地验证来源',kind:'openai-compatible',baseUrl:${JSON.stringify(upstream)},enabled:true,apiKey:'synthetic-only'});
            const model=await api.saveModel({id:before.models.find(m=>m.alias==='dock-smoke')?.id,providerId:provider.id,alias:'dock-smoke',upstreamId:'mock-model',displayName:'验证模型',wireApi:'chat-completions',contextWindow:64000,tools:true,vision:false,enabled:true});
            await api.saveBinding({id:'dsh',name:'DSH',enabled:true,mode:'aggregate',providerIds:[provider.id],modelIds:[],defaultModelId:model.id,note:''});
            const gateway=await api.startGateway(0);
            const preview=await api.previewConfig('dsh');
            const snapshot=await api.snapshot();
            return {gateway,providerId:provider.id,modelId:model.id,models:snapshot.models.length,binding:snapshot.bindings.find(b=>b.id==='dsh').enabled,previewHasSecret:preview.content.includes('synthetic-only')};
          })()`);
          const live = await fetch(`${outcome.gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${store.gatewayKey()}` }, body: JSON.stringify({model:'dock-smoke',messages:[{role:'user',content:'OK'}]}) });
          const reply = await live.json() as any;
          if (live.status !== 200 || reply.choices?.[0]?.message?.content !== 'OK' || !outcome.binding || outcome.previewHasSecret) throw new Error('Electron gateway integration failed');
          writeFileSync(join(outputDir,'electron-integration.json'), JSON.stringify({...outcome,replyStatus:live.status,reply:'OK'},null,2));
          if (process.env.MODELDOCK_SMOKE_TOOLS_ONLY === '1') {
            const subscription = store.saveProvider({ name: '等待授权回归测试', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
            store.setSecret(subscription.id, { accessToken: 'MOCK_ACCESS_AUTH_NETWORK', refreshToken: 'MOCK_REFRESH_AUTH_NETWORK', accountId: 'mock-auth-workspace', expiresAt: Date.now() + 3_600_000 });
            store.saveModel({ providerId: subscription.id, upstreamId: 'mock-codex', alias: 'mock-codex', displayName: 'Native Codex', wireApi: 'responses', contextWindow: 272000, tools: true, vision: true, enabled: true });
            await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
            await new Promise(resolve => setTimeout(resolve, 200));
            await verifyToolSelection(window!, store, outputDir, captureUi);
            await verifyToolRestoreAndConnections(window!, store, outputDir, captureUi);
            await verifyDshConfiguration(window!, store, outputDir, captureUi);
          } else {
          const direct = await window!.webContents.executeJavaScript(`(async()=>{
            const api=window.modelDock;
            await api.saveBinding({id:'opencode',name:'OpenCode',enabled:true,mode:'direct',providerIds:[${JSON.stringify(outcome.providerId)}],modelIds:[],defaultModelId:${JSON.stringify(outcome.modelId)},note:''});
            const preview=await api.previewConfig('opencode');
            return {content:preview.content,instructions:preview.instructions};
          })()`);
          const directConfig = JSON.parse(direct.content);
          if (directConfig.provider.modeldock.options.baseURL !== upstream || directConfig.model !== 'modeldock/mock-model') throw new Error('Direct provider binding failed');
          writeFileSync(join(outputDir,'direct-mode-validation.json'),JSON.stringify({ok:true,tool:'opencode',mode:'direct',upstreamId:'mock-model',keyRedacted:!direct.content.includes('synthetic-only')},null,2));
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="刷新本机配置"]').click()`);
          await new Promise(resolve => setTimeout(resolve,500));
          for (const name of ['auth','tools','service'] as const) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${name}"]').click()`);
            await new Promise(resolve => setTimeout(resolve,200));
            writeFileSync(join(outputDir,`electron-${name}.png`),await captureUi());
          }
          await window!.webContents.executeJavaScript(`document.querySelector('[data-page="service"]').click()`);
          await new Promise(resolve => setTimeout(resolve,200));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="add-api-provider"]').click()`);
          await new Promise(resolve => setTimeout(resolve,500));
          const presetUi = await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');return {title:dialog?.querySelector('h2')?.textContent,text:dialog?.textContent||'',buttons:Array.from(document.querySelectorAll('button')).map(button=>button.textContent),rect:dialog?.getBoundingClientRect().toJSON()};})()`);
          writeFileSync(join(outputDir,'preset-ui-debug.json'),JSON.stringify(presetUi,null,2));
          if (!presetUi.text.includes('DeepSeek') || !presetUi.text.includes('千问 Token Plan')) throw new Error('Provider presets unavailable');
          writeFileSync(join(outputDir,'preset-ui-validation.json'),JSON.stringify({ok:true,title:presetUi.title},null,2));
          writeFileSync(join(outputDir,'electron-provider-presets.png'),await captureUi());
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click()`);
          await new Promise(resolve => setTimeout(resolve,200));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-tool-id="codex"]').click()`);
          await new Promise(resolve => setTimeout(resolve,500));
          const modeUi = await window!.webContents.executeJavaScript(`(()=>({title:document.querySelector('.breadcrumbs')?.textContent,hasModal:!!document.querySelector('[role="dialog"]'),hasLegacyTabs:!!document.querySelector('.route-tabs'),directProvider:!!document.querySelector('select[data-action="single-entry-direct-provider"][data-tool-id="codex"]'),aggregateProviders:!!document.querySelector('[data-aggregate-internal-sources="codex"] [data-action="select-tool-provider"]'),defaultInline:!!document.querySelector('[data-action="tool-default-model"]')}))()`);
          writeFileSync(join(outputDir,'mode-ui-debug.json'),JSON.stringify(modeUi,null,2));
          if (modeUi.hasModal || modeUi.hasLegacyTabs || !(modeUi.directProvider || modeUi.aggregateProviders) || !modeUi.defaultInline) throw new Error('Inline tool provider selection unavailable');
          writeFileSync(join(outputDir,'mode-ui-validation.json'),JSON.stringify({ok:true,title:modeUi.title},null,2));
          writeFileSync(join(outputDir,'electron-tool-modes.png'),await captureUi());
          const navigation = await window!.webContents.executeJavaScript(`(async()=>{
            const before=await window.modelDock.snapshot();
            const tools=[];
            for(const id of ['codex','opencode','dsh','vscode','copilot']){
              document.querySelector('[data-tool-id="'+id+'"]').click();
              await new Promise(resolve=>setTimeout(resolve,80));
              tools.push({id,title:document.querySelector('.breadcrumbs').textContent,inline:!!document.querySelector('[data-tool-workspace="'+id+'"] [data-action="select-tool-provider"],[data-tool-workspace="'+id+'"] [data-action="single-entry-direct-provider"]'),active:document.querySelector('.sidebar [data-tool-id="'+id+'"]')?.getAttribute('aria-current')==='page'});
            }
            document.querySelector('[data-source-id="'+${JSON.stringify(outcome.providerId)}+'"]').click();
            await new Promise(resolve=>setTimeout(resolve,100));
            const providerDetail={title:document.querySelector('.breadcrumbs').textContent,hasModel:document.querySelector('.provider-models').textContent.includes('dock-smoke')};
            const after=await window.modelDock.snapshot();
            return {tools,providerDetail,bindingsUnchanged:JSON.stringify(before.bindings)===JSON.stringify(after.bindings)};
          })()`);
          if (!navigation.bindingsUnchanged || !navigation.providerDetail.hasModel || !navigation.tools.every((tool: any)=>tool.inline && tool.active && tool.title.trim())) throw new Error('Detail navigation changed bindings or lost provider models');
          writeFileSync(join(outputDir,'navigation-validation.json'),JSON.stringify(navigation,null,2));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-tool-id="codex"]').click();document.querySelector('.sidebar-scroll').scrollTop=0`);
          await new Promise(resolve=>setTimeout(resolve,150));
          writeFileSync(join(outputDir,'electron-compact-tools.png'),await captureUi());
          const layouts=[];
          for (const [width,height] of [[1320,880],[980,680]]) {
            window!.setSize(width,height);
            await new Promise(resolve=>setTimeout(resolve,150));
            const layout=await window!.webContents.executeJavaScript(`(()=>{
              const main=document.querySelector('.main-content'),sidebar=document.querySelector('.sidebar'),functions=document.querySelector('.sidebar-functions'),topbar=document.querySelector('.topbar');
              const actions=Array.from(topbar.querySelectorAll('button')).map(button=>button.getBoundingClientRect());
              const rows=Array.from(document.querySelectorAll('.provider-row')).map(row=>row.getBoundingClientRect());
              return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,documentOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:main.scrollWidth>main.clientWidth,sidebarWidth:sidebar.getBoundingClientRect().width,functionsVisible:functions.getBoundingClientRect().bottom<=innerHeight,actionsVisible:actions.every(rect=>rect.left>=sidebar.getBoundingClientRect().right&&rect.right<=innerWidth),providerRows:rows.length,maxProviderRowHeight:Math.max(...rows.map(rect=>rect.height)),legacyHero:!!document.querySelector('.welcome-card,.stats-grid,.setup-rail')};
            })()`);
            layouts.push(layout);
            writeFileSync(join(outputDir,`electron-compact-${width}.png`),await captureUi());
            if(layout.documentOverflow||layout.mainOverflow||!layout.functionsVisible||!layout.actionsVisible||layout.legacyHero||layout.maxProviderRowHeight>110) throw new Error('Compact layout overflow: '+JSON.stringify(layout));
          }
          writeFileSync(join(outputDir,'layout-validation.json'),JSON.stringify(layouts,null,2));
          const dialogs=[];
          for (const name of ['provider','binding']) {
            await window!.webContents.executeJavaScript(name === 'provider' ? `document.querySelector('[data-action="add-api-provider"]').click()` : `document.querySelector('[data-tool-id="dsh"]').click();document.querySelector('[data-action="preview-tool-config"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            const dialog=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]'),footer=dialog.querySelector('.modal-footer'),rect=dialog.getBoundingClientRect(),buttons=Array.from(footer.querySelectorAll('button')).map(button=>button.getBoundingClientRect());return {title:dialog.querySelector('h2').textContent,inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,footerVisible:buttons.every(rect=>rect.bottom<=innerHeight&&rect.top>=0)};})()`);
            if(!dialog.inViewport||!dialog.footerVisible) throw new Error('Dialog actions outside minimum window');
            dialogs.push(dialog);
            writeFileSync(join(outputDir,`electron-compact-${name}-980.png`),await captureUi());
            await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click()`);
          }
          writeFileSync(join(outputDir,'dialog-layout-validation.json'),JSON.stringify(dialogs,null,2));
          const testHome = join(dataDir, 'test-home');
          mkdirSync(join(testHome, '.codex'), { recursive: true });
          writeFileSync(join(testHome, '.codex', 'config.toml'), '# existing client config\nmodel = "preserved-model"\n[mcp_servers.existing]\ncommand = "preserve-me"\n');
          const fixtureSkill = join(dataDir, 'fixture-skill');
          mkdirSync(fixtureSkill, { recursive: true });
          writeFileSync(join(fixtureSkill, 'SKILL.md'), '---\nname: native-fixture\ndescription: A local fixture for desktop verification\n---\n# Fixture\nNo scripts are executed.\n');
          const featureOutcome = await window!.webContents.executeJavaScript(`(async()=>{
            const api=window.modelDock;
            const server=await api.mcpSave({name:'fixture-mcp',transport:'stdio',command:'fixture-mcp-command',args:[],env:{PRIVATE_TOKEN:'synthetic-mcp-secret'},enabledTools:['codex']});
            const preview=await api.mcpPreview('codex');
            const applied=await api.mcpApply('codex',preview.fingerprint);
            const skill=await api.skillsImportLocal(${JSON.stringify(fixtureSkill)});
            await api.skillsDeploy(skill.id,'codex',true);
            await api.skillsDeploy(skill.id,'vscode',true);
            const library=await api.skillsList();
            const file=await api.skillsReadFile(skill.id,'SKILL.md');
            return {mcpApplied:applied.changed,mcpRedacted:!JSON.stringify(server).includes('synthetic-mcp-secret')&&!preview.content.includes('synthetic-mcp-secret'),skillRead:file.content.includes('# Fixture'),skillTools:library.skills.find(s=>s.id===skill.id).deployments.filter(d=>d.state==='deployed').map(d=>d.tool),accountsSafe:!(await api.authAccounts()).some(a=>'accessToken' in a||'refreshToken' in a)};
          })()`);
          const clientConfig = readFileSync(join(testHome, '.codex', 'config.toml'), 'utf8');
          if (!featureOutcome.mcpApplied || !featureOutcome.mcpRedacted || !clientConfig.includes('preserve-me') || !clientConfig.includes('preserved-model') || !clientConfig.includes('synthetic-mcp-secret') || !featureOutcome.skillRead || !featureOutcome.skillTools.includes('copilot') || !featureOutcome.accountsSafe) throw new Error('Feature integration validation failed: '+JSON.stringify(featureOutcome));
          writeFileSync(join(outputDir,'feature-integration.json'),JSON.stringify(featureOutcome,null,2));
          // MCP/Skills retain the isolated main-process integration above;
          // their retired pages are replaced by the current supported routes.
          const featurePageSelectors = { auth: '.auth-panel', service: '[data-gateway-panel]', settings: '.settings-panel' } as const;
          const featureLayouts=[];
          for (const [width,height] of [[1320,880],[980,680]]) {
            window!.setSize(width,height);
            for (const page of ['auth','service','settings'] as const) {
              await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
              await new Promise(resolve=>setTimeout(resolve,200));
              const layout=await window!.webContents.executeJavaScript(`(()=>{const main=document.querySelector('.main-content'),functions=document.querySelector('.sidebar-functions');return {title:document.querySelector('.breadcrumbs').textContent,active:document.querySelector('.sidebar [data-page="${page}"]')?.getAttribute('aria-current')==='page',pageReady:!!main.querySelector(${JSON.stringify(featurePageSelectors[page])}),retiredPagesAbsent:!document.querySelector('[data-page="mcp"],[data-page="skills"]'),documentOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:main.scrollWidth>main.clientWidth,functionsVisible:functions.getBoundingClientRect().bottom<=innerHeight,hasError:!!document.querySelector('[role="alert"]')};})()`);
              featureLayouts.push({width,height,page,...layout});
              writeFileSync(join(outputDir,`electron-feature-${page}-${width}.png`),await captureUi());
              if(!layout.active||!layout.pageReady||!layout.retiredPagesAbsent||layout.documentOverflow||layout.mainOverflow||!layout.functionsVisible||layout.hasError) throw new Error('Feature page overflow/error: '+JSON.stringify(layout));
            }
          }
          writeFileSync(join(outputDir,'feature-layout-validation.json'),JSON.stringify(featureLayouts,null,2));
          const featureDialogs=[];
          for (const [scenario,page,selector,title] of [
            ['auth-account','auth','[data-auth-add-account="codex"]','添加 Codex 订阅 账号'],
            ['auth-jetbrains','auth','[data-action="jetbrains-import-options"]','连接JetBrains账号'],
            ['service-provider','service','[data-action="add-api-provider"]','添加 API 供应商'],
          ] as const) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            await window!.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            const dialog=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]'),rect=dialog.getBoundingClientRect(),buttons=Array.from(dialog.querySelector('.modal-footer,.modal-actions').querySelectorAll('button')).map(button=>button.getBoundingClientRect());return {title:dialog.querySelector('h2').textContent,inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,footerVisible:buttons.length>0&&buttons.every(rect=>rect.bottom<=innerHeight&&rect.right<=innerWidth&&rect.top>=0),hasError:!!dialog.querySelector('[role="alert"]')};})()`);
            if(dialog.title!==title||!dialog.inViewport||!dialog.footerVisible||dialog.hasError) throw new Error('Feature dialog unavailable or actions outside minimum window: '+JSON.stringify(dialog));
            featureDialogs.push({scenario,page,...dialog});
            writeFileSync(join(outputDir,`electron-feature-${scenario}-dialog-980.png`),await captureUi());
            await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click()`);
          }
          writeFileSync(join(outputDir,'feature-dialog-validation.json'),JSON.stringify(featureDialogs,null,2));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-page="settings"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,200));
          const themes=[];
          for (const theme of ['light','dark','system']) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            const result=await window!.webContents.executeJavaScript(`(async()=>{const settings=await window.modelDock.getSettings(),footer=document.querySelector('.sidebar-bottom'),main=document.querySelector('.main-content');return {saved:settings.settings.theme,resolved:document.documentElement.dataset.theme,rootBackground:getComputedStyle(document.documentElement).backgroundColor,localEntry:footer.textContent.includes('本地工作空间')&&!!footer.querySelector('[aria-label="打开数据目录"]'),settingsMenu:!!document.querySelector('[data-page="settings"]'),documentOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:main.scrollWidth>main.clientWidth,footerBottom:footer.getBoundingClientRect().bottom,viewportHeight:innerHeight,footerVisible:footer.getBoundingClientRect().bottom<=innerHeight+1};})()`);
            if(result.saved!==theme||!result.localEntry||!result.settingsMenu||result.documentOverflow||result.mainOverflow||!result.footerVisible) throw new Error('Settings navigation/theme failed: '+JSON.stringify(result));
            themes.push({theme,...result});
            writeFileSync(join(outputDir,`electron-settings-${theme}-980.png`),await captureUi());
          }
          nativeTheme.themeSource='dark';
          await new Promise(resolve=>setTimeout(resolve,150));
          const followsDark=await window!.webContents.executeJavaScript(`document.documentElement.dataset.theme==='dark'`);
          nativeTheme.themeSource='light';
          await new Promise(resolve=>setTimeout(resolve,150));
          const followsLight=await window!.webContents.executeJavaScript(`document.documentElement.dataset.theme==='light'`);
          if(!followsDark||!followsLight) throw new Error('System theme did not follow native color scheme changes');
          await window!.webContents.executeJavaScript(`document.querySelector('[data-theme-choice="dark"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await window!.webContents.executeJavaScript(`window.modelDock.saveSettings({startHidden:true,closeToTray:false})`);
          await new Promise<void>(resolve=>{window!.webContents.once('did-finish-load',()=>resolve());window!.webContents.reload();});
          await new Promise(resolve=>setTimeout(resolve,400));
          await window!.webContents.executeJavaScript(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.appendChild(style);})()`);
          const reloaded=await window!.webContents.executeJavaScript(`(async()=>{const value=await window.modelDock.getSettings();return {settings:value.settings,resolved:document.documentElement.dataset.theme,ready:!!document.querySelector('.app-shell')};})()`);
          if(!reloaded.ready||reloaded.resolved!=='dark'||!reloaded.settings.startHidden||reloaded.settings.closeToTray) throw new Error('Settings did not survive renderer reload');
          writeFileSync(join(outputDir,'settings-validation.json'),JSON.stringify({themes,followsDark,followsLight,reloaded},null,2));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-page="settings"]').click()`);
          window!.setSize(1320,880);
          await new Promise(resolve=>setTimeout(resolve,200));
          writeFileSync(join(outputDir,'electron-settings-dark-1320.png'),await captureUi());
          for (const page of ['tools','auth','service','settings']) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            writeFileSync(join(outputDir,`electron-theme-dark-${page}.png`),await captureUi());
          }
          await window!.webContents.executeJavaScript(`document.querySelector('[data-tool-id="codex"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="add-api-provider"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          const darkDialog=await window!.webContents.executeJavaScript(`(()=>{const modal=document.querySelector('[role="dialog"]'),probe=document.createElement('div');probe.style.backgroundColor='var(--surface)';probe.style.display='none';document.body.appendChild(probe);const surface=getComputedStyle(probe).backgroundColor;probe.remove();const background=modal?getComputedStyle(modal).backgroundColor:null;return {visible:!!modal,title:modal?.querySelector('h2')?.textContent,theme:document.documentElement.dataset.theme,background,surface,dark:!!background&&/^rgb\\(/.test(background)&&background.match(/\\d+/g).slice(0,3).every(value=>Number(value)<128)};})()`);
          if(!darkDialog.visible||darkDialog.theme!=='dark'||!darkDialog.dark||darkDialog.background!==darkDialog.surface) throw new Error('Dark modal did not render with the current dark surface: '+JSON.stringify(darkDialog));
          writeFileSync(join(outputDir,'dark-dialog-validation.json'),JSON.stringify(darkDialog,null,2));
          writeFileSync(join(outputDir,'electron-theme-dark-modal.png'),await captureUi());
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click();document.querySelector('[data-source-id="'+${JSON.stringify(outcome.providerId)}+'"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,200));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="discover-models"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,300));
          const discoveredUi=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]'),rows=Array.from(dialog.querySelectorAll('.discovery-model'));return {title:dialog.querySelector('h2').textContent,models:rows.length,alreadyAdded:rows.filter(row=>row.classList.contains('existing')).length,selected:rows.filter(row=>row.querySelector('input[type="checkbox"]').checked&&!row.classList.contains('existing')).length,hasError:!!dialog.querySelector('[role="alert"]')};})()`);
          if(discoveredUi.models!==3||discoveredUi.alreadyAdded!==1||discoveredUi.selected!==2||discoveredUi.hasError) throw new Error('Real model discovery UI did not populate from mock upstream');
          writeFileSync(join(outputDir,'electron-discovery-dark-1320.png'),await captureUi());
          window!.setSize(980,680);
          await new Promise(resolve=>setTimeout(resolve,150));
          const discoveryLayout=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]'),rect=dialog.getBoundingClientRect(),footer=dialog.querySelector('.modal-footer').getBoundingClientRect();return {inViewport:rect.left>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1,footerVisible:footer.bottom<=innerHeight+1,mainOverflow:document.querySelector('.main-content').scrollWidth>document.querySelector('.main-content').clientWidth};})()`);
          if(!discoveryLayout.inViewport||!discoveryLayout.footerVisible||discoveryLayout.mainOverflow) throw new Error('Model discovery dialog overflow');
          writeFileSync(join(outputDir,'electron-discovery-dark-980.png'),await captureUi());
          await window!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent.includes('添加所选')).click()`);
          await new Promise(resolve=>setTimeout(resolve,250));
          const addedUi=await window!.webContents.executeJavaScript(`(async()=>{const snapshot=await window.modelDock.snapshot(),models=snapshot.models.filter(model=>model.providerId===${JSON.stringify(outcome.providerId)});return {models:models.map(model=>({upstreamId:model.upstreamId,alias:model.alias,contextWindow:model.contextWindow,tools:model.tools})),success:!!document.querySelector('.discovery-success'),alreadyAdded:document.querySelectorAll('.discovery-model.existing').length};})()`);
          if(!addedUi.success||addedUi.models.length!==3||addedUi.alreadyAdded!==3||!addedUi.models.some((model:any)=>model.upstreamId==='mock-reasoner'&&model.contextWindow===0&&model.tools===false)) throw new Error('Model discovery batch add did not preserve selected models and unknown capabilities');
          const repeated=await window!.webContents.executeJavaScript(`window.modelDock.addDiscoveredModels(${JSON.stringify(outcome.providerId)},[{upstreamId:'mock-fast'},{upstreamId:'mock-reasoner'}])`);
          if(repeated.added.length!==0||repeated.skipped.length!==2) throw new Error('Discovery duplicate add did not skip models');
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="编辑 '+document.querySelectorAll('.provider-models .model-name code')[2].textContent+'"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,100));
          const unknownEditable=await window!.webContents.executeJavaScript(`(()=>{const form=document.querySelector('[role="dialog"] form');const input=form.querySelector('input[type="number"]');return {zeroAllowed:input.value==='0'&&input.min==='0'&&form.checkValidity()};})()`);
          if(!unknownEditable.zeroAllowed) throw new Error('Imported unknown-context model cannot be edited');
          await window!.webContents.executeJavaScript(`document.querySelector('[role="dialog"] button[type="submit"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="编辑 本地验证来源"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await window!.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[role="dialog"] input[type="password"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Bearer synthetic-only');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
          await new Promise(resolve=>setTimeout(resolve,100));
          await window!.webContents.executeJavaScript(`document.querySelector('[role="dialog"] form').requestSubmit()`);
          await new Promise(resolve=>setTimeout(resolve,300));
          const savedProvider=await window!.webContents.executeJavaScript(`(async()=>{const snapshot=await window.modelDock.snapshot(),provider=snapshot.providers.find(p=>p.id===${JSON.stringify(outcome.providerId)}),discover=document.querySelector('[data-action="discover-models"]');return {noDialog:!document.querySelector('[role="dialog"]'),hasSecret:provider?.hasSecret,models:snapshot.models.filter(model=>model.providerId===provider?.id).length,canDiscover:!!discover&&!discover.disabled};})()`);
          if(!savedProvider.noDialog||!savedProvider.hasSecret||savedProvider.models!==3||!savedProvider.canDiscover) throw new Error('Saving API key did not preserve models and explicit discovery: '+JSON.stringify(savedProvider));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="discover-models"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,300));
          const manualAfterKey=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');return {title:dialog?.querySelector('h2')?.textContent,models:dialog?.querySelectorAll('.discovery-model').length,hasError:!!dialog?.querySelector('[role="alert"]')};})()`);
          if(manualAfterKey.title!=='获取模型列表'||manualAfterKey.models!==3||manualAfterKey.hasError) throw new Error('Explicit model discovery after saving API key did not populate');
          writeFileSync(join(outputDir,'electron-discovery-after-key-980.png'),await captureUi());
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click()`);
          await window!.webContents.executeJavaScript(`(async()=>{const api=window.modelDock,snapshot=await api.snapshot(),provider=snapshot.providers.find(p=>p.id===${JSON.stringify(outcome.providerId)});await api.saveProvider({...provider,apiKey:'synthetic-invalid'});})()`);
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="discover-models"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,250));
          const failedDiscovery=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');return {authError:dialog.textContent.includes('HTTP 401'),models:dialog.querySelectorAll('.discovery-model').length,addDisabled:Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent.includes('添加所选')).disabled};})()`);
          if(!failedDiscovery.authError||failedDiscovery.models!==0||!failedDiscovery.addDisabled) throw new Error('Discovery auth failure displayed stale models');
          writeFileSync(join(outputDir,'electron-discovery-auth-error-980.png'),await captureUi());
          writeFileSync(join(outputDir,'discovery-validation.json'),JSON.stringify({discoveredUi,discoveryLayout,addedUi,repeated:{added:repeated.added.length,skipped:repeated.skipped.length},unknownEditable,savedProvider,manualAfterKey,failedDiscovery},null,2));
          await verifyProviderDuplicates(window!, outputDir, captureUi);
          await verifyModelNames(window!, outputDir, captureUi);
          await verifyConnectionTest(window!, outputDir, captureUi);
          await verifyAuthNetwork(window!, store, outputDir, captureUi);
          process.env.MODELDOCK_SMOKE_AUTH_PENDING = '1'; process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS = '0';
          await verifyPendingAuth(window!, store, outputDir, captureUi);
          await verifyCodexCatalog(window!, store, outputDir, captureUi);
          await verifyGrokLogin(window!, store, outputDir, captureUi);
          await verifyToolSelection(window!, store, outputDir, captureUi);
          await verifyToolRestoreAndConnections(window!, store, outputDir, captureUi);
          await verifyDshConfiguration(window!, store, outputDir, captureUi);
          if (process.env.MODELDOCK_SMOKE_COPILOT_HOME) await verifyCopilotDesktop(window!, store, outputDir, captureUi, copilotTarget().home);
          }
        }
      } catch (error) { writeFileSync(join(outputDir, 'electron-smoke-error.txt'), String(error)); }
      quitting = true; app.quit();
    }, 1200);
  }
}
function copilotTarget() {
  const requested = process.env.MODELDOCK_SMOKE_COPILOT_HOME;
  if (__MODELDOCK_SMOKE_BUILD__ && requested) {
    const work = realpathSync(dirname(runtimeConfig.smoke!.outputDir));
    const home = realpathSync(resolve(requested));
    if (!/^copilot-native-profile-[0-9a-f-]{36}$/i.test(relative(work, home))) throw new Error('Copilot 原生验证必须使用独立资料目录。');
    const marker = JSON.parse(readFileSync(join(home, 'modeldock-isolation.json'), 'utf8'));
    if (marker.version !== 1 || !Number.isSafeInteger(marker.pid) || marker.pid < 1) throw new Error('Copilot 原生验证资料标记无效。');
    return { home, openClient: (target: string) => CopilotDesktopClient.open(target, { verifyProcess: async pid => pid === marker.pid }) };
  }
  if (__MODELDOCK_SMOKE_BUILD__) return { home: join(dataDir, 'feature-home', '.copilot'), openClient: undefined };
  return { home: process.env.COPILOT_HOME ? resolve(process.env.COPILOT_HOME) : join(app.getPath('home'), '.copilot'), openClient: undefined };
}

// 修改点：IDE 文件状态只读查询；测试使用隔离目录和受控进程探针。
function jetBrainsOptions(): JetBrainsConfigOptions {
  if (__MODELDOCK_SMOKE_BUILD__) {
    if (process.env.MODELDOCK_SMOKE_JETBRAINS_WINDOWS_ONLY === '1') return jetBrainsWindowsSmokeOptions(dataDir);
    const home = join(dataDir, 'feature-home');
    return { profileRoot: join(home, '.config', 'JetBrains'), cacheRoot: join(home, '.cache', 'JetBrains'), platform: 'linux', processProbe: pid => pid === process.pid ? 'running' : 'stopped' };
  }
  return process.platform === 'linux' ? {
    profileRoot: join(process.env.XDG_CONFIG_HOME?.trim() || join(app.getPath('home'), '.config'), 'JetBrains'),
    cacheRoot: join(process.env.XDG_CACHE_HOME?.trim() || join(app.getPath('home'), '.cache'), 'JetBrains'),
  } : {};
}

// Per-service local keys survive restarts. Upstream account tokens stay with the respective relay.
function relayKey(setting: string): string {
  let apiKey = store.getManagedState<string | null>(setting, null);
  if (apiKey === null) {
    apiKey = randomBytes(32).toString('hex');
    store.setManagedState(setting, apiKey);
  }
  return apiKey;
}

function registerIpc() {
  const { gateway, network } = runtime;
  let providerRemovalPending = false;
  let jetBrainsImportPending = false;
  let toolRestorePending = false;
  const toolConfigPending = new Set<ToolId>();
  const beforeToolSelections = new Map<ToolId, ToolBinding>();
  const featureHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home');
  const junieHome = __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.junie') : process.env.JUNIE_HOME;
  const copilotCliHome = __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.copilot-cli') : process.env.COPILOT_HOME;
  const copilotCliProvidersConfig = __MODELDOCK_SMOKE_BUILD__ ? join(copilotCliHome!, 'providers.json') : process.env.COPILOT_PROVIDERS_CONFIG;
  const copilot = copilotTarget();
  const relayQuotas = new RelayQuotaCenter(store, async apiKey => {
    if (__MODELDOCK_SMOKE_BUILD__) {
      const mode = store.getManagedState<string>('qa-relay-quota-mode', 'unavailable');
      if (mode === 'failure') throw new Error('PRIVATE_RELAY_QUOTA_TOKEN_RAW_BODY');
      if (mode === 'unavailable') throw new RelayQuotaFailure('TRAE 当前账号额度暂不可查询，请检查反代登录。');
      const manyWindows: QuotaWindow[] = mode === 'many' ? Array.from({ length: 40 }, (_, index) => ({
        id: `many-${index + 1}`, label: `高级模型快速请求与独立订阅额度包完整名称 ${index + 1}`,
        unit: index % 2 ? '次' : '积分', measurement: 'reported',
        ...(index === 1 ? {} : index === 2 ? { unlimited: true } : {
          total: 1000 + index, remaining: index === 0 ? 0 : 625 + index,
          remainingPercent: index === 0 ? 0 : (625 + index) / (1000 + index) * 100,
        }),
        ...(index % 2 ? { resetAt: '2099-01-01T00:00:00.000Z' } : {}),
      })) : [];
      if (mode === 'official-balance' || mode === 'official-unknown') {
        const now = Date.now(), start = Math.floor(now / 1000) - 86400;
        const pack = (id: string, quota: Record<string, number>, usage: Record<string, unknown>, groupName?: string, expiryDays = 30) => ({
          status: 1, source_id: id, expire_time: Math.floor(now / 1000) + expiryDays * 86400,
          ...(groupName ? { group_name: groupName, group_type: groupName === '每日签到' ? 'checkin' : 'monthly-login' } : {}),
          entitlement_base_info: { entitlement_id: id, product_type: groupName ? 2 : 0, start_time: start, end_time: Math.floor(now / 1000) + expiryDays * 86400, quota }, usage,
        });
        const parsed = parseTraeQuota({ code: 0, user_entitlement_pack_list: [
          pack('qa-free', {}, {}), pack('qa-monthly', { credits_limit: 500 }, mode === 'official-unknown' ? { credits_amount: null } : {}, '每月登录赠送'),
          ...Array.from({ length: 19 }, (_, index) => pack(`qa-checkin-${index + 1}`, { credits_limit: 100 }, index < 5 ? { credits_amount: 100 } : index === 5 ? { credits_amount: 86.1964 } : {}, '每日签到', index + 1)),
        ] }, now);
        return { accountId: 'qa-active-a', accountLabel: '反代当前账号 A', plan: 'Free', usage: { ...parsed, status: 'ready' as const, queriedAt: new Date(now).toISOString(), message: '当前 TRAE 账号的官方套餐与额度。' } };
      }
      return { accountId: mode === 'switched' ? 'qa-active-b' : 'qa-active-a', accountLabel: mode === 'switched' ? '反代当前账号 B' : '反代当前账号 A', plan: 'Pro', usage: {
        status: 'ready' as const, queriedAt: new Date().toISOString(), message: '官方额度；账号为查询时反代的活跃账号。',
        windows: mode === 'many' ? manyWindows : mode === 'unknown' ? [{ id: 'credits', label: '订阅积分', unit: '积分' }] : [{ id: 'credits', label: '订阅积分', total: 1000, remaining: 625, remainingPercent: 62.5, usedPercent: 37.5, unit: '积分' }, { id: 'fast', label: '快速请求', total: 500, remaining: 300, remainingPercent: 60, usedPercent: 40, unit: '次' }],
      } };
    }
    throw new RelayQuotaFailure('请从客户端重新导入 TRAE 账号，再通过内置适配器查询套餐与额度。');
  });
  const undoManager = new ToolSyncUndoManager(store, {
    appData: __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-appdata') : app.getPath('appData'),
    homeDirectory: featureHome,
    junieHome,
    copilotCliHome, copilotCliProvidersConfig,
    codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME?.trim() ? resolve(process.env.CODEX_HOME.trim()) : undefined,
    configHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.config') : process.env.XDG_CONFIG_HOME,
    claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.claude') : process.env.CLAUDE_CONFIG_DIR,
    dshHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.dsh') : process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME.trim()) : join(featureHome, '.dsh'),
    copilotHome: copilot.home, copilotOptions: { openClient: copilot.openClient },
  });
  const assertEditable = () => {
    if (jetBrainsImportPending) throw new Error('JetBrains 账号正在导入，请等待当前操作完成。');
    if (providerRemovalPending) throw new Error('供应商正在删除并同步，请稍后修改配置。');
    if (toolRestorePending) throw new Error('正在还原官方配置，请稍后修改配置。');
    if (toolConfigPending.size) throw new Error('工具配置正在同步，请稍后修改配置。');
  };
  async function synchronizeTool(id: ToolId): Promise<string> {
    if (toolRestorePending || toolConfigPending.has(id)) throw new Error('此工具配置正在更新，请稍后再试。');
    toolConfigPending.add(id);
    let synchronized = false;
    try {
    const binding = store.listBindings().find(item => item.id === id);
    if (isJetBrainsTool(id) && store.getJetBrainsPlugin(id) === 'air') throw new Error('请在 Air Accounts 的 More Providers → OpenAI 中添加提供商并填写 URL 和 Key；Air 不支持无密钥的离线账户同步。');
    const preview = buildConfig(store, id, gateway.status().port, true, __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home'), { jetBrainsOptions: jetBrainsOptions(), junieHome, copilotCliHome, copilotCliProvidersConfig });
    if (!preview.canApply) throw new Error('此工具使用导出配置入口。');
    const usesGateway = binding && bindingConnectionPolicy(binding, store.listModels(), store.listProviders()).groups.some(group => group.connection === 'local-managed' && group.modelIds.length > 0);
    if (usesGateway && !gateway.status().running) {
      const status = await runtime.startGateway();
      if (!status.running) throw new Error('本地入口未能启动，尚未写入工具配置。');
    }
    let operation: () => string | Promise<string>;
    if (id === 'copilot') {
      const target = copilotTarget();
      operation = () => applyCopilotDesktop(store, buildCopilotDesktopPlan(store, gateway.status().port, true), target.home, { openClient: target.openClient, syncScope: binding?.copilotSyncScope ?? 'selected', recordUndo: !providerRemovalPending });
    } else if (id === 'dsh') {
      const configuredDshHome = process.env.DSH_HOME?.trim();
      const dshHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home', '.dsh')
        : configuredDshHome ? resolve(configuredDshHome) : join(app.getPath('home'), '.dsh');
      const profile = __MODELDOCK_SMOKE_BUILD__ ? { modelPlugins: [
        { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
        { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
        { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
      ], baselineProviders: {} } : await resolveDshProfile(dshHome);
      operation = () => applyDshConfig(store, buildDshPlan(store, gateway.status().port, true), dshHome, profile);
    } else {
    const featureHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : undefined;
    const appData = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-appdata') : app.getPath('appData');
    operation = () => applyConfig(store, id, gateway.status().port, appData, join(dataDir, 'backups'), featureHome, {
      codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome!, '.codex') : process.env.CODEX_HOME?.trim() ? resolve(process.env.CODEX_HOME.trim()) : undefined,
      configHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome!, '.config') : process.env.XDG_CONFIG_HOME,
      claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome!, '.claude') : process.env.CLAUDE_CONFIG_DIR,
      junieHome,
      copilotCliHome, copilotCliProvidersConfig,
      jetBrainsOptions: jetBrainsOptions(),
    });
    }
    // Global deletion has its own recovery transaction; its removed references cannot be reintroduced by a tool undo.
    const result = providerRemovalPending ? await operation() : await undoManager.run(id, beforeToolSelections.get(id), operation);
    if (providerRemovalPending) undoManager.clear(id);
    synchronized = true;
    return result;
    } catch (error) {
      recordDiagnostic('error', 'config.apply', { operation: 'applyConfig', toolId: id, stage: 'configuration', outcome: 'failure', ...describeError(error) });
      throw error;
    } finally { if (synchronized) beforeToolSelections.delete(id); toolConfigPending.delete(id); }
  }
  function handle(name: keyof ModelDockApi, fn: (...args: any[]) => unknown) {
    ipcMain.handle('modeldock:' + name, async (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝未知页面调用。');
      if (ignoresDiagnosticOperation(name)) return await fn(...args);
      const startedAt = Date.now(), context = { ...diagnosticOperationContext(name, args), traceId: randomUUID() };
      return await diagnosticScope.run(context, async () => {
        if (!isQuietDiagnosticOperation(name)) recordDiagnostic('info', 'operation.started', context);
        try {
          const result = await fn(...args);
          recordOperationResult(name, args, result, Date.now() - startedAt);
          return result;
        } catch (error) {
          recordDiagnostic('error', 'operation.failed', { ...context, ...describeError(error), durationMs: Date.now() - startedAt, outcome: 'failure' });
          throw error;
        }
      });
    });
  }
  // 只接收受信页面的固定异常类型，不提供任意写入诊断日志的 renderer API。
  let lastRendererReport = 0;
  ipcMain.on('modeldock:renderer-diagnostic', (event, input: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || Date.now() - lastRendererReport < 1000) return;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const value = input as Record<string, unknown>;
    if (value.kind !== 'error' && value.kind !== 'unhandled-rejection') return;
    lastRendererReport = Date.now();
    recordDiagnostic('error', 'renderer.error', { stage: 'renderer', errorName: typeof value.errorName === 'string' ? value.errorName : undefined, outcome: 'failure' });
  });
  handle('queryDiagnostics', (query?: DiagnosticQuery) => diagnostics!.query(query));
  handle('diagnosticsText', (query?: DiagnosticQuery) => diagnostics!.exportText(query));
  handle('openDiagnosticsDir', async () => {
    const snapshot = diagnostics!.query({ limit: 1 });
    if (!snapshot.available) throw new Error(snapshot.message);
    const error = await shell.openPath(snapshot.directory); if (error) throw new Error('无法打开诊断日志目录。');
  });
  handle('exportDiagnostics', async (query?: DiagnosticQuery) => {
    const snapshot = diagnostics!.query({ limit: 1 });
    if (!snapshot.available) throw new Error(snapshot.message);
    const content = diagnostics!.exportText(query);
    const result = await dialog.showSaveDialog(window!, { title: '导出诊断日志', defaultPath: `modeldock-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, filters: [{ name: '诊断日志', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, content, { mode: 0o600 });
    recordDiagnostic('info', 'diagnostics.exported', { operation: 'exportDiagnostics' });
    return result.filePath;
  });
  handle('snapshot', () => ({ providers: store.listProviders(), models: store.listModels(), bindings: store.listBindings(),
    gateway: gateway.status(), gatewayExposure: store.gatewayExposure(), logs: store.logs(100), dataDir, version: app.getVersion() }));
  handle('runtimeSnapshot', () => runtime.snapshot());
  handle('networkSnapshot', () => network.snapshot());
  handle('saveNetworkSettings', patch => network.save(patch));
  handle('connectNetwork', upstream => network.connect(upstream));
  handle('disconnectNetwork', () => network.disconnect());
  let measuringSpeed = false;
  let speedProxy = '';
  async function withSpeedProbe<T>(address: string, run: (probe: Electron.Session) => Promise<T>): Promise<T> {
    if (!address || address !== network.snapshot().settings.address) throw new Error('请先应用要测试的代理地址。');
    if (measuringSpeed) throw new Error('代理测速正在进行。');
    measuringSpeed = true;
    try {
      const probe = session.fromPartition('modeldock-speed-test', { cache: false });
      if (speedProxy !== address) {
        await probe.closeAllConnections();
        await probe.setProxy({ mode: 'fixed_servers', proxyRules: address });
        speedProxy = address;
      }
      return await run(probe);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('测速')) throw error;
      throw new Error('通过上游代理访问测速节点失败或超时，请检查代理地址和连接。');
    } finally { measuringSpeed = false; }
  }
  handle('measureNetworkSpeed', (address: string, metric: ProxySpeedMetric) => {
    if (!['latency', 'download', 'upload'].includes(metric)) throw new Error('未知测速项目。');
    return withSpeedProbe(address, async probe => {
      if (__MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_NETWORK_ONLY === '1') return { latency: 42, download: 80, upload: 20 }[metric];
      return measureProxySpeed(metric, (url, init) => probe.fetch(url, init));
    });
  });
  handle('measureNetworkSites', (address: string, id: string) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('测速请求无效。');
    const target = window?.webContents;
    return withSpeedProbe(address, async probe => {
      await Promise.all(NETWORK_SITES.map(async (site, index) => {
        let result: SiteLatency;
        if (__MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_NETWORK_ONLY === '1') {
          result = site === 'X' ? { site, state: 'timeout' } : { site, state: 'response', ms: 42 + index, httpStatus: site === 'ChatGPT' ? 403 : 200 };
        } else {
          result = await measureSiteLatency(site, (url, init) => probe.fetch(url, init));
        }
        if (target && !target.isDestroyed()) target.send('modeldock:site-latency-result', id, result);
      }));
    });
  });
  handle('checkNetworkSite', site => network.check(site));
  handle('networkHotspotCandidates', () => hotspotCandidates());
  handle('networkLocalProxies', () => network.localProxies());
  handle('showNetworkMini', () => networkMini.show());
  handle('openNetworkSite', async (site: NetworkSite) => {
    if (!NETWORK_SITES.includes(site)) throw new Error('未知网站。');
    await shell.openExternal(NETWORK_SITE_URLS[site]);
  });
  handle('exportPhoneProxy', async () => {
    const selected = await dialog.showSaveDialog(window!, { title: '导出手机 Termux 代理', defaultPath: 'termux-hotspot-proxy.sh', filters: [{ name: 'Shell 脚本', extensions: ['sh'] }] });
    if (selected.canceled || !selected.filePath) return null;
    writeFileSync(selected.filePath, readFileSync(join(networkResourceRoot(), 'termux/termux-hotspot-proxy.sh')), { mode: 0o600 });
    return selected.filePath;
  });
  handle('getSettings', () => preferences.get());
  handle('probeAuthNetwork', () => inspectAuthNetwork(session.defaultSession, preferences.get().settings.proxyUrl,
    __MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1'
      ? async () => {
        if (process.env.MODELDOCK_SMOKE_GROK_MODE === 'network-error') throw Object.assign(new TypeError('PRIVATE_NETWORK_DIAGNOSTIC'), { cause: { code: 'ERR_CONNECTION_RESET' } });
        return new Response(JSON.stringify({ issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code', token_endpoint: 'https://auth.x.ai/oauth2/token' }), { headers: { 'content-type': 'application/json' } });
      }
      : createSystemNetworkFetch((input, init) => applicationNetwork.fetch(input, init))));
  handle('saveSettings', async (patch: Partial<AppSettings>) => {
    const previous = preferences.get().settings;
    if (Object.hasOwn(patch, 'gatewayPort') && gateway.status().running && patch.gatewayPort !== gateway.status().port) throw new Error('请先停止本地服务，再修改服务端口。');
    if (patch.gatewayPort !== undefined) network.validateGatewayPort(patch.gatewayPort);
    const result = preferences.save(patch);
    if (Object.hasOwn(patch, 'proxyUrl')) {
      try { await applicationNetwork.setConfiguredProxy(result.settings.proxyUrl); }
      catch (error) {
        const rollback = Object.fromEntries(Object.keys(patch).map(key => [key, previous[key as keyof AppSettings]])) as Partial<AppSettings>;
        preferences.save(rollback); await applicationNetwork.setConfiguredProxy(previous.proxyUrl); throw error;
      }
    }
    if (Object.hasOwn(patch, 'gatewayPort')) gateway.configurePort(result.settings.gatewayPort);
    nativeTheme.themeSource = result.settings.theme;
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#19191c' : '#f8f9fb');
    return result;
  });
  handle('rendererReady', () => {
    if (__MODELDOCK_SMOKE_BUILD__) windowPresentationProbe?.rendererPrepared();
    presentation?.rendererDidPrepare();
  });
  handle('importOpenCodeGo', input => {
    assertEditable();
    const provider = importOpenCodeGo(store, input, featureHome, __MODELDOCK_SMOKE_BUILD__ ? {} : process.env);
    catalog.invalidate(provider.id);
    return provider;
  });
  handle('saveProvider', (input: ProviderInput) => {
    assertEditable();
    if (input?.copilotAccountId !== undefined && (input.kind !== 'copilot' || typeof input.copilotAccountId !== 'string')) throw new Error('Copilot 账号选择无效。');
    if (input?.copilotAccountId) copilotAccounts.getInferenceAuthorization(input.copilotAccountId);
    let provider = store.saveProvider(input);
    if (provider.kind === 'copilot' && input.copilotAccountId !== undefined) {
      if (input.copilotAccountId) provider = copilotProviders.linkAccount(provider.id, input.copilotAccountId);
      else { copilotProviders.unlinkProvider(provider.id); provider = store.getProvider(provider.id)!; }
    }
    catalog.invalidate(provider.id); return provider;
  });
  handle('listProviderDuplicates', () => store.listProviderDuplicates());
  handle('mergeProviderDuplicates', (ids: string[], fingerprint: string) => {
    assertEditable();
    if (gateway.status().running) throw new Error('请先停止本地服务，再合并供应商。');
    const result = store.mergeProviderDuplicates(ids, fingerprint);
    for (const id of [result.keptProviderId, ...result.removedProviderIds]) catalog.invalidate(id);
    return result;
  });
  handle('deleteProvider', async (id: string, scope?: 'local-subscription') => {
    const provider = store.getProvider(id);
    if (!provider || scope !== undefined && (scope !== 'local-subscription' || providerCategory(provider) !== 'subscription')) throw new Error('订阅来源不存在或删除范围无效。');
    assertEditable(); providerRemovalPending = true;
    try {
      catalog.invalidate(id); gateway.cancelProvider(id); accounts.cancelProviderOperations(id); copilotProviders.cancel(id);
      traeNativeAccounts.providerRemoved(id); centralNativeAccounts.providerRemoved(id);
      await ideAccounts.providerRemoved(id);
      if (scope === 'local-subscription') {
        const checkpoint = store.beginProviderRemoval(id);
        try {
          for (const tool of checkpoint.affectedToolIds) {
            undoManager.clear(tool);
            beforeToolSelections.delete(tool);
          }
        } catch (error) { store.restoreProviderRemoval(checkpoint); throw error; }
        store.finishProviderRemoval(checkpoint);
      } else await removeProviderAndSync(store, id, synchronizeTool);
    } finally { catalog.invalidate(id); providerRemovalPending = false; }
  });
  handle('saveModel', (input: ModelInput) => { assertEditable(); return store.saveModel(input); });
  handle('deleteModel', (id: string) => { assertEditable(); return store.deleteModel(id); });
  handle('saveBinding', (binding: ToolBinding) => {
    assertEditable();
    const id = toolId(binding.id), before = store.listBindings().find(value => value.id === id);
    store.saveBinding({ ...binding, id });
    if (!isJetBrainsTool(id) && before && !beforeToolSelections.has(id)) beforeToolSelections.set(id, structuredClone(before));
  });
  handle('setJetBrainsPlugin', (value: ToolId, plugin: unknown) => {
    assertEditable();
    const id = toolId(value);
    if (!isJetBrainsTool(id) || plugin !== 'ai-assistant' && plugin !== 'air') throw new Error('JetBrains 插件选择无效。');
    store.setJetBrainsPlugin(id, plugin);
  });
  handle('toolSyncUndoStatus', (value: ToolId) => undoManager.status(toolId(value)));
  handle('undoToolSync', async (value: ToolId) => {
    assertEditable();
    const id = toolId(value);
    toolRestorePending = true;
    const current = store.listBindings().find(binding => binding.id === id);
    const draftBefore = beforeToolSelections.get(id);
    let restoredDraft = false;
    try {
      // Pending choices have been saved, but their external write was cancelled by the renderer.
      if (draftBefore) { restoredDraft = true; store.restoreBindingSelection(draftBefore); }
      const target = await undoManager.undo(id); beforeToolSelections.delete(id); return target;
    } catch (error) {
      if (restoredDraft && current) {
        const latest = store.listBindings().find(binding => binding.id === id);
        const fields = ['enabled', 'mode', 'providerIds', 'modelIds', 'modelSelection', 'defaultModelId', 'connectionChoices', 'vscodeSyncScope', 'copilotSyncScope', 'dshSyncScope', 'claudeDisableTelemetry'] as const;
        const selection = (binding: ToolBinding) => Object.fromEntries(fields.map(field => [field, binding[field]]));
        if (latest && draftBefore && isDeepStrictEqual(selection(latest), selection(draftBefore))) store.restoreBindingSelection(current);
      }
      throw error;
    }
    finally { toolRestorePending = false; }
  });
  let relayImportAdapters: Record<RelayAccountKind, RelayImportAdapter> = {
    'trae-cn-relay': { inspect: async () => [], perform: async () => { throw new RelayClientImportError('请重新选择本机 TRAE 账号。'); } },
    'jetbrains-central': { inspect: async () => [], perform: async () => { throw new RelayClientImportError('请重新连接 Central 账号。'); } },
  };
  if (__MODELDOCK_SMOKE_BUILD__) {
    // Isolated QA adapters never read native client credentials or launch relays.
    const qaAdapter = (kind: RelayAccountKind): RelayImportAdapter => ({
      inspect: async () => store.getManagedState<string>('qa-relay-client-import-stage', 'empty') === 'empty' ? [] : [{
        sourceId: kind === 'trae-cn-relay' ? 'trae-cn' : 'central-current', client: kind === 'trae-cn-relay' ? 'trae-cn' : 'jetbrains-central',
        clientName: kind === 'trae-cn-relay' ? 'TRAE 中国版客户端' : 'JetBrains Central CLI（当前已登录账号）',
        ...(kind === 'trae-cn-relay' ? { accountId: 'qa-native-account', accountLabel: '本机测试账号' } : {}),
      }],
      perform: async () => {
        if (store.getManagedState<string>('qa-relay-client-import-stage', 'empty') === 'failure') throw new Error('PRIVATE_RELAY_IMPORT qa-private-relay-token qa-private-relay-stderr qa-private-relay-path');
        return { upstreamVerified: kind === 'jetbrains-central' };
      },
    });
    relayImportAdapters = { 'trae-cn-relay': qaAdapter('trae-cn-relay'), 'jetbrains-central': qaAdapter('jetbrains-central') };
  }
  const relayClientImports = new RelayClientImportManager(store, relayImportAdapters, kind => relayKey(kind === 'trae-cn-relay' ? 'trae-relay-api-key' : 'jetbrains-central-relay-key'));
  handle('relayClientImportCandidates', (kind: RelayAccountKind) => { assertEditable(); return !__MODELDOCK_SMOKE_BUILD__ ? kind === 'trae-cn-relay' ? traeNativeAccounts.preview() : kind === 'jetbrains-central' ? centralNativeAccounts.preview() : Promise.reject(new Error('未知的账号来源。')) : relayClientImports.preview(kind); });
  const importJetBrains = async <T,>(action: () => Promise<T>): Promise<T> => {
    assertEditable(); jetBrainsImportPending = true;
    try { return await action(); } finally { jetBrainsImportPending = false; }
  };
  handle('importRelayClientAccount', async (kind: RelayAccountKind, id: string) => {
    assertEditable();
    const account = kind === 'jetbrains-central' ? await importJetBrains(() => !__MODELDOCK_SMOKE_BUILD__ ? centralNativeAccounts.import(id) : relayClientImports.import(kind, id))
      : kind === 'trae-cn-relay' ? !__MODELDOCK_SMOKE_BUILD__ ? await traeNativeAccounts.import(id) : await relayClientImports.import(kind, id) : (() => { throw new Error('未知的账号来源。'); })();
    gateway.cancelProvider(account.providerId); catalog.invalidate(account.providerId); return account;
  });
  handle('openJetBrainsAccountHelp', async (topic: unknown) => {
    if (topic !== 'ide' && topic !== 'central') throw new Error('未知的账号帮助页面。');
    await shell.openExternal(topic === 'ide' ? 'https://www.jetbrains.com/help/air/air-in-ides-authorization.html' : 'https://www.jetbrains.com/help/central-cli/cli-setup.html');
  });
  handle('beginJetBrainsIdeImport', (candidateId?: unknown) => importJetBrains(async () => {
    if (candidateId !== undefined && (typeof candidateId !== 'string' || candidateId.length > 256)) throw new Error('客户端来源选择无效，请重新导入。');
    const result = await ideAccounts.importDefault(candidateId as string | undefined);
    if (result.status === 'imported') for (const account of result.accounts ?? [result.account]) { gateway.cancelProvider(account.providerId); catalog.invalidate(account.providerId); }
    return result;
  }));
  handle('jetBrainsIdeImportCandidates', () => { assertEditable(); return ideAccounts.preview(); });
  handle('importJetBrainsIdeAccount', (id: string) => importJetBrains(async () => { const account = await ideAccounts.import(id); gateway.cancelProvider(account.providerId); catalog.invalidate(account.providerId); return account; }));
  handle('startJetBrainsRelay', async () => { throw new Error('JetBrains 已通过内置适配器接入网关，请在授权中心连接账号。'); });
  handle('stopJetBrainsRelay', async () => { /* No independent JetBrains relay process exists. */ });
  handle('startTraeRelay', async () => { throw new Error('TRAE 已通过内置适配器接入网关，请在授权中心从客户端导入账号。'); });
  handle('openTraeRelayLogin', async () => { throw new Error('请在 TRAE 中国版客户端完成登录，再到授权中心导入。'); });
  handle('stopTraeRelay', async () => { /* No independent TRAE relay process exists. */ });
  handle('startGateway', async (port?: number) => {
    const status = await runtime.startGateway(port ?? preferences.get().settings.gatewayPort);
    if (status.running) preferences.save({ gatewayPort: status.port });
    return status;
  });
  handle('stopGateway', () => runtime.stopGateway());
  handle('setGatewayProviderEnabled', (id: string, enabled: boolean) => store.setGatewayProviderEnabled(id, enabled));
  handle('setGatewayModelEnabled', (id: string, enabled: boolean) => store.setGatewayModelEnabled(id, enabled));
  handle('copyText', (value: unknown) => writeClipboardText(value, text => clipboard.writeText(text)));
  handle('copyGatewayKey', () => writeClipboardText(store.gatewayKey(), text => clipboard.writeText(text)));
  handle('copyProviderKey', (id: unknown) => writeClipboardText(providerApiKey(store, id), text => clipboard.writeText(text)));
  handle('revealProviderKey', (id: unknown) => providerApiKey(store, id));
  handle('revealGatewayKey', () => localGatewayKey(store));
  handle('copyConnectionKey', (tool: ToolId) => writeClipboardText(connectionKey(store, toolId(tool)), text => clipboard.writeText(text)));
  handle('jetBrainsStatus', (value: unknown, refresh?: unknown) => {
    if (!isJetBrainsTool(value)) throw new Error('不是支持的 JetBrains 工具。');
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new Error('IDE 状态刷新参数无效。');
    const home = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home');
    return jetBrainsStatus(value, home, { ...jetBrainsOptions(), plugin: store.getJetBrainsPlugin(value), refreshProcessEvidence: refresh === true });
  });
  handle('previewConfig', (tool: ToolId) => buildConfig(store, toolId(tool), gateway.status().port, false, __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home'), { jetBrainsOptions: jetBrainsOptions(), junieHome, copilotCliHome, copilotCliProvidersConfig }));
  handle('exportConfig', async (tool: ToolId) => {
    const config = buildConfig(store, toolId(tool), gateway.status().port, true, __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home'), { jetBrainsOptions: jetBrainsOptions(), junieHome, copilotCliHome, copilotCliProvidersConfig });
    const result = await dialog.showSaveDialog(window!, { defaultPath: config.filename });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, config.content, { mode: 0o600 }); return result.filePath;
  });
  handle('applyConfig', async (tool: ToolId) => { assertEditable(); return synchronizeTool(toolId(tool)); });
  handle('restoreOfficialConfig', async (value: ToolId) => {
    assertEditable();
    const id = toolId(value);
    toolRestorePending = true;
    try {
      const featureHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home');
      const appData = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-appdata') : app.getPath('appData');
      const dshHome = __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.dsh')
        : process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME.trim()) : join(featureHome, '.dsh');
      const target = copilotTarget();
      const dshOptions = id === 'dsh' ? __MODELDOCK_SMOKE_BUILD__ ? { modelPlugins: [
        { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
        { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
        { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
      ], baselineProviders: {} } : await resolveDshProfile(dshHome) : undefined;
      const location = await restoreToolBinding(store, id, () => restoreOfficialConfig(store, id, appData, join(dataDir, 'backups'), featureHome, {
        codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME?.trim() ? resolve(process.env.CODEX_HOME.trim()) : join(featureHome, '.codex'),
        configHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.config') : process.env.XDG_CONFIG_HOME,
        claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.claude') : process.env.CLAUDE_CONFIG_DIR,
        junieHome,
        copilotCliHome, copilotCliProvidersConfig,
        jetBrainsOptions: jetBrainsOptions(),
        dshHome, dshOptions, copilotHome: target.home, copilotOptions: { openClient: target.openClient },
      }));
      undoManager.clear(id); beforeToolSelections.delete(id);
      return location;
    } finally { toolRestorePending = false; }
  });
  handle('openDataDir', async () => { const error = await shell.openPath(dataDir); if (error) throw new Error(error); });
  handle('beginLogin', (id: string) => { assertEditable(); catalog.invalidate(id); return store.getProvider(id)?.kind === 'copilot' ? copilotProviders.beginLogin(id) : oauth.beginLogin(id); });
  handle('authProgress', (id: string) => store.getProvider(id)?.kind === 'copilot' ? copilotProviders.progress(id) : oauth.progress(id));
  handle('cancelLogin', (id: string) => store.getProvider(id)?.kind === 'copilot' ? copilotProviders.cancel(id) : oauth.cancel(id));
  handle('authAccounts', () => [...accounts.listAccounts().map(account => traeNativeAccounts.decorate(centralNativeAccounts.decorate(ideAccounts.decorate(relayQuotas.decorate(account))))), ...copilotAccounts.listAccounts()]);
  handle('refreshAccountUsage', (id: string) => {
    if (ideAccounts.isIdeProvider(id)) return ideAccounts.refreshUsage(id);
    if (traeNativeAccounts.isNativeProvider(id)) return traeNativeAccounts.refreshUsage(id);
    if (centralNativeAccounts.isNativeProvider(id)) return centralNativeAccounts.refreshUsage(id);
    if (store.getProvider(id)?.presetId === 'trae-cn-relay') return relayQuotas.refresh(id);
    if (isCopilotAccountId(id)) return copilotAccounts.refreshUsage(id);
    if (store.getProvider(id)?.kind === 'copilot') {
      const accountId = store.getSecret(id)?.copilotAccountId;
      if (!accountId) throw new Error('请先关联或登录 GitHub 账号。');
      return copilotAccounts.refreshUsage(accountId);
    }
    return accounts.refreshUsage(id);
  });
  handle('beginCopilotLogin', () => { assertEditable(); return copilotAccounts.beginLogin(); });
  handle('copilotImportCandidates', () => { assertEditable(); return copilotAccounts.clientImportCandidates(); });
  handle('importCopilotClientAccount', (id: string) => { assertEditable(); return copilotAccounts.importClientAccount(id); });
  handle('copilotAuthProgress', () => copilotAccounts.progress());
  handle('cancelCopilotLogin', () => copilotAccounts.cancel());
  handle('copilotLogoutAccount', (id: string) => { assertEditable(); copilotAccounts.logout(id); copilotProviders.unlinkAccount(id);
    for (const provider of store.listProviders().filter(item => item.kind === 'copilot')) catalog.invalidate(provider.id);
  });
  handle('logoutAccount', (id: string) => { assertEditable(); if (store.getProvider(id)?.kind === 'copilot') { copilotProviders.unlinkProvider(id); catalog.invalidate(id); return; }
    return accounts.logout(id); });
  handle('importLocalAccount', (kind: SubscriptionKind) => {
    assertEditable();
    if (!['codex', 'grok'].includes(kind)) throw new Error('不支持的订阅类型。');
    return accounts.importAccount(kind);
  });
  handle('mcpList', () => mcp.list());
  handle('mcpSave', (input: McpServerInput) => mcp.save(input));
  handle('mcpDelete', (id: string) => mcp.remove(id));
  handle('mcpSetTool', (id: string, tool: ToolId, enabled: boolean) => mcp.setToolEnabled(id, toolId(tool), enabled));
  handle('mcpImport', (tool: ToolId) => mcp.importFromTool(toolId(tool)));
  handle('mcpPreview', (tool: ToolId) => mcp.preview(toolId(tool)));
  handle('mcpApply', (tool: ToolId, fingerprint?: string) => mcp.apply(toolId(tool), fingerprint));
  handle('skillsList', () => skills.list());
  handle('skillsImportLocal', async (path?: string) => {
    if (path !== undefined && typeof path !== 'string') throw new Error('技能目录无效。');
    if (!path) {
      const result = await dialog.showOpenDialog(window!, { title: '选择包含 SKILL.md 的技能目录', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      path = result.filePaths[0];
    }
    return skills.importLocal(path);
  });
  handle('skillsImportRepository', (input: SkillRepositoryInput) => skills.importRepository(input));
  handle('skillsScan', (tool: ToolId) => skills.scanFromTool(toolId(tool)));
  handle('skillsDeploy', (id: string, tool: ToolId, enabled: boolean) => skills.deploy(id, toolId(tool), enabled));
  handle('skillsAdopt', (id: string, tool: ToolId) => skills.adopt(id, toolId(tool)));
  handle('skillsReadFile', (id: string, path?: string) => skills.readFile(id, path));
  handle('skillsPreviewRemove', (id: string) => skills.previewRemove(id));
  handle('skillsDelete', (id: string) => skills.remove(id));
  handle('testProvider', (id: string, input?: ConnectionTestInput) => connectionTester.test(id, input));
  handle('discoverModels', (id: string) => catalog.discover(id));
  handle('addDiscoveredModels', (id: string, selected: ModelSelection[]) => catalog.addSelectedWithRefresh(id, selected, assertEditable));
}

function initializeApplication() {
  app.on('second-instance', revealWindow);
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('local.modeldock.desktop');
    dataDir = runtimeConfig.dataDir ?? app.getPath('userData');
    diagnostics = new DiagnosticsLog(dataDir);
    recordDiagnostic('info', 'app.start', { version: app.getVersion(), platform: process.platform as DiagnosticContext['platform'], runtimeMode: __MODELDOCK_RUNTIME_MODE__, stage: 'startup' });
    startupStage = 'store';
    store = await Store.create(dataDir, __MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_GATEWAY_STARTUP === '1'
      ? createGatewayStartupSmokeVault(dataDir) : createVault(dataDir));
    startupStage = 'managers';
    applicationNetwork = new ApplicationNetworkSession({
      setProxy: config => session.defaultSession.setProxy(config),
      fetch: (input, init) => session.defaultSession.fetch(input instanceof URL ? input.href : input, init),
    });
    const systemFetch = createSystemNetworkFetch(async (input, init) => {
      const startedAt = Date.now(), target = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const context: DiagnosticContext = { endpoint: target };
      try {
        const response = await applicationNetwork.fetch(input, init);
        const type = response.headers.get('content-type')?.toLowerCase();
        context.statusCode = response.status; context.durationMs = Date.now() - startedAt;
        context.contentType = type?.includes('json') ? 'json' : type?.includes('event-stream') ? 'sse' : type?.includes('html') ? 'html' : type ? 'other' : 'unknown';
        // 正常设备授权等待只记最终阶段；不把 pending HTTP 状态当成授权失败。
        const path = new URL(target).pathname;
        const tokenRoute = /\/(?:access_token|token)$/.test(path);
        const deviceGrant = tokenRoute && typeof init?.body === 'string' && init.body.length <= 16384 && new URLSearchParams(init.body).get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code';
        const polling = /\/deviceauth\/token$/.test(path) || deviceGrant && /\/(?:access_token|token)$/.test(path);
        if (polling) {
          const key = `${diagnosticScope.getStore()?.traceId ?? 'background'}|${sanitizeDiagnosticEndpoint(target) ?? 'unknown'}`;
          const signature = `${response.status}|${context.contentType}`;
          if (pollingDiagnosticStates.get(key) !== signature) {
            if (pollingDiagnosticStates.size > 1000) pollingDiagnosticStates.delete(pollingDiagnosticStates.keys().next().value!);
            pollingDiagnosticStates.set(key, signature);
            const expectedPending = context.contentType === 'json' && [200, 400, 403, 404].includes(response.status);
            recordDiagnostic(expectedPending ? 'info' : 'warn', 'network.response', context);
          }
        } else recordDiagnostic(response.ok ? 'info' : 'warn', 'network.response', context);
        return response;
      } catch (error) {
        recordDiagnostic('warn', 'network.failed', { ...context, ...describeError(error), durationMs: Date.now() - startedAt, outcome: 'network' });
        throw error;
      }
    });
    const runtimeFetch: typeof fetch = __MODELDOCK_SMOKE_BUILD__ ? async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      const quotaFixture = await authQuotaFixture(target, init);
      if (quotaFixture) return quotaFixture;
      if (process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1' && target.origin === 'https://chatgpt.com' && target.pathname === '/backend-api/codex/models') {
        const fixtureUrl = new URL(process.env.MODELDOCK_SMOKE_UPSTREAM!);
        if (fixtureUrl.protocol !== 'http:' || fixtureUrl.hostname !== '127.0.0.1') throw new Error('模型目录验证要求本机模拟上游。');
        fixtureUrl.pathname = '/codex-native/models'; fixtureUrl.search = target.search;
        return fetch(fixtureUrl.href, init);
      }
      return fetch(input, init);
    } : systemFetch;
    const authFetch: typeof fetch = __MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1'
      ? async input => {
        const mockResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        const grokMode = process.env.MODELDOCK_SMOKE_GROK_MODE;
        if (grokMode && String(input).startsWith('https://auth.x.ai/')) {
          const path = new URL(String(input)).pathname;
          if (path === '/.well-known/openid-configuration') {
            if (grokMode === 'network-error') throw new TypeError('PRIVATE_GROK_NETWORK_FIXTURE');
            if (grokMode === 'delayed') await new Promise(done => setTimeout(done, 3500));
            return mockResponse({ issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code', token_endpoint: 'https://auth.x.ai/oauth2/token' });
          }
          if (path === '/oauth2/device/code') {
            process.env.MODELDOCK_SMOKE_GROK_POLLS = '0';
            return mockResponse({ device_code: 'mock-grok-device', user_code: 'MOCK-GROK', verification_uri: 'https://auth.x.ai/activate', interval: 1, expires_in: 30 });
          }
          if (path === '/oauth2/token') { process.env.MODELDOCK_SMOKE_GROK_POLLS = String(Number(process.env.MODELDOCK_SMOKE_GROK_POLLS ?? 0) + 1); return mockResponse({ error: 'authorization_pending' }, 400); }
          throw new Error('Unexpected mock Grok endpoint');
        }
        if (process.env.MODELDOCK_SMOKE_AUTH_PENDING === '1') {
          const path = String(input);
          if (path.endsWith('/deviceauth/usercode')) {
            process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS = '0';
            return mockResponse({ device_auth_id: 'pending-smoke-device', user_code: 'MOCK-00000', interval: 1 });
          }
          if (path.endsWith('/deviceauth/token')) {
            const polls = Number(process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS ?? 0) + 1; process.env.MODELDOCK_SMOKE_AUTH_PENDING_POLLS = String(polls);
            return polls <= 3 ? mockResponse({ error: { code: 'deviceauth_authorization_pending', type: 'invalid_request_error', message: 'PRIVATE_PENDING_AUTH_BODY' } }, 403) : mockResponse({ authorization_code: 'MOCK_AUTH_CODE', code_verifier: 'MOCK_VERIFIER' });
          }
          if (path.endsWith('/oauth/token')) {
            const idToken = `mock.${Buffer.from(JSON.stringify({ sub: 'mock-auth-user', email: 'mock-auth@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'mock-auth-workspace' } })).toString('base64url')}.mock`;
            return mockResponse({ access_token: 'MOCK_ACCESS_AUTH_NETWORK', id_token: idToken, refresh_token: 'MOCK_REFRESH_AUTH_NETWORK', expires_in: 3600, token_type: 'Bearer' });
          }
          throw new Error('Unexpected synthetic authorization endpoint');
        }
        return mockResponse({ error: { code: 'unsupported_country_region_territory', message: 'Synthetic only: PRIVATE_AUTH_BODY must not reach the renderer' } }, 403);
      } : runtimeFetch;
    oauth = new OAuthManager(store, { openExternal: async url => {
      if (__MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1') return;
      const target = new URL(url);
      if (target.protocol !== 'https:' || !['openai.com', 'x.ai', 'grok.com'].some(domain => target.hostname === domain || target.hostname.endsWith('.' + domain))) throw new Error('拒绝未知授权地址。');
      await shell.openExternal(url);
    }, fetch: authFetch });
    const featureHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'test-home') : app.getPath('home');
    const featureAppData = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'test-appdata') : app.getPath('appData');
    let simulatedStartup = false;
    startupStage = 'preferences';
    preferences = new SettingsManager(store, { platform: process.platform, homeDir: featureHome,
      configHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.config') : process.env.XDG_CONFIG_HOME,
      execPath: __MODELDOCK_SMOKE_BUILD__ ? process.execPath : process.platform === 'linux' && process.env.APPIMAGE ? resolve(process.env.APPIMAGE) : process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE ? resolve(process.env.PORTABLE_EXECUTABLE_FILE) : process.execPath,
      isPackaged: app.isPackaged,
      login: __MODELDOCK_SMOKE_BUILD__ ? { getLoginItemSettings: () => ({ openAtLogin: simulatedStartup }), setLoginItemSettings: value => { simulatedStartup = value.openAtLogin; } } : { getLoginItemSettings: value => app.getLoginItemSettings(value), setLoginItemSettings: value => app.setLoginItemSettings({ ...value, enabled: value.enabled ?? value.openAtLogin }) },
    });
    // 修改点：只迁移应用自己登记且未被修改的旧自启动项，不重放外部工具配置。
    try { preferences.migrateLinuxAutostart(); }
    catch { recordDiagnostic('warn', 'app.error', { stage: 'preferences', outcome: 'configuration' }); }
    if (__MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_WINDOW_PRESENTATION_ONLY === '1') {
      const requestedTheme = process.env.MODELDOCK_SMOKE_WINDOW_THEME;
      preferences.save({ ...(requestedTheme === 'light' || requestedTheme === 'dark' || requestedTheme === 'system' ? { theme: requestedTheme } : {}), startHidden: process.env.MODELDOCK_SMOKE_WINDOW_HIDDEN === '1' });
    }
    nativeTheme.themeSource = preferences.get().settings.theme;
    nativeTheme.on('updated', () => { if (window && !window.isDestroyed()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#19191c' : '#f8f9fb'); });
    startupStage = 'proxy';
    await applicationNetwork.setConfiguredProxy(preferences.get().settings.proxyUrl);
    startupStage = 'managers';
    accounts = new AuthCenter(store, oauth, { homeDir: featureHome, codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME, fetch: runtimeFetch });
    copilotAccounts = new CopilotAuthCenter(store, { fetch: runtimeFetch, clientImport: __MODELDOCK_SMOKE_BUILD__ ? { homeDir: featureHome, env: {}, readKeychain: async () => undefined, runGithubCli: async () => { throw new Error('Smoke import uses isolated plaintext fixtures only.'); } } : undefined, onAuthorized: (accountId, providerId) => {
      if (providerId) { copilotProviders.linkAccount(providerId, accountId); catalog.invalidate(providerId); }
    }, openExternal: async url => {
      if (__MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1') return;
      const target = new URL(url);
      if (target.origin !== 'https://github.com' || target.pathname !== '/login/device' || target.search || target.hash || target.username || target.password) throw new Error('拒绝未知 GitHub 授权地址。');
      await shell.openExternal(url);
    } });
    copilotProviders = new CopilotProviderManager(store, copilotAccounts, { fetch: runtimeFetch });
    // 修改点：显式传递生产 XDG 根，homeDir 同时用于其他工具，不能让它掩盖 OpenCode 环境配置。
    const openCodeConfigHome = __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.config') : process.env.XDG_CONFIG_HOME;
    mcp = new McpManager(store, { homeDir: featureHome, appDataDir: featureAppData, backupDir: join(dataDir, 'backups', 'mcp'), configHome: openCodeConfigHome, codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME });
    skills = new SkillManager(store, { homeDir: featureHome, appDataDir: featureAppData, libraryDir: join(dataDir, 'skill-library'), backupDir: join(dataDir, 'backups', 'skills'), configHome: openCodeConfigHome, claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.claude') : process.env.CLAUDE_CONFIG_DIR, ...(!__MODELDOCK_SMOKE_BUILD__ ? { codexHome: process.env.CODEX_HOME, dshHome: process.env.DSH_HOME } : {}) });
    // 修改点：Copilot 订阅与其他来源共享目录、连通性及本地网关，凭据准备在主进程分派。
    const nativeFixture = __MODELDOCK_SMOKE_BUILD__ ? createJetBrainsIdeFixture(store) : undefined;
    const historyModelsFixture = __MODELDOCK_SMOKE_BUILD__ && modelHistoryOnly ? createHistoryModelsFixture(store) : undefined;
    const ideApi = nativeFixture?.api ?? new JetBrainsIdeApi({ fetch: runtimeFetch });
    ideAccounts = new JetBrainsIdeAccounts(store, nativeFixture?.reader ?? new JetBrainsIdeImporter({ homeDir: featureHome }), ideApi, undefined, () => relayKey('jetbrains-central-relay-key'), error => error instanceof JetBrainsIdeImportError || error instanceof JetBrainsIdeApiError ? error.message : undefined);
    ideGatewayAdapter = new JetBrainsGatewayAdapter(ideAccounts, ideApi);
    const centralApi = new CentralApi({ fetch: runtimeFetch });
    centralNativeAccounts = new CentralNativeAccounts(store, new CentralClientSessionReader({ homeDir: featureHome }), centralApi, () => relayKey('jetbrains-central-relay-key'), error => error instanceof CentralApiError || error instanceof CentralNativeAccountError ? error.message : undefined);
    centralGatewayAdapter = new CentralGatewayAdapter(centralNativeAccounts, centralApi);
    const traeApi = new TraeApi({ fetch: runtimeFetch, clientModelOptions: { homeDir: featureHome, ...(__MODELDOCK_SMOKE_BUILD__ ? { env: {} } : {}) } });
    traeNativeAccounts = new TraeNativeAccounts(store, new TraeClientImporter({ homeDir: featureHome, ...(__MODELDOCK_SMOKE_BUILD__ ? { env: {} } : {}) }), traeApi, () => relayKey('trae-relay-api-key'), error => error instanceof TraeClientImportError || error instanceof TraeApiError || error instanceof TraeNativeAccountError ? error.message : undefined);
    traeGatewayAdapter = new TraeGatewayAdapter(traeNativeAccounts, traeApi);
    const upstream = { prepareRequest: async (provider: Provider, path: string, body: Record<string, unknown>) => {
      if (provider.nativeAdapter) throw new Error('账号来源必须经内置网关适配器调用。');
      return provider.kind === 'copilot' ? copilotProviders.prepareRequest(provider, path, body) : oauth.prepareRequest(provider, path, body);
    } };
    const nativeAdapter = (provider: Provider) => provider.nativeAdapter === 'trae' ? traeGatewayAdapter : provider.nativeAdapter === 'jetbrains-ide' ? ideGatewayAdapter : provider.nativeAdapter === 'jetbrains-central' ? centralGatewayAdapter : undefined;
    const nativeModels = (provider: Provider, signal: AbortSignal) => {
      if (historyModelsFixture) {
        // This dedicated fixture must never fall through to real account auth or HTTP.
        return Promise.resolve(historyModelsFixture.models(provider, signal) ?? new Response(JSON.stringify({ error: { code: 'smoke-provider-out-of-scope' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
      }
      return nativeAdapter(provider)?.models(provider, signal) ?? Promise.resolve(undefined);
    };
    const nativeRequest = (provider: Provider, path: string, body: Record<string, unknown>, signal: AbortSignal) => nativeAdapter(provider)?.request(provider, path, body, signal) ?? Promise.resolve(undefined);
    catalog = new ModelCatalog(store, upstream, { fetch: runtimeFetch, nativeModels, now: historyModelsFixture?.now });
    connectionTester = new ConnectionTester(store, upstream, { fetch: runtimeFetch, nativeRequest, diagnostics: recordDiagnostic });
    const serviceSettings = preferences.get().settings;
    const gateway = new Gateway(store, { diagnostics: recordDiagnostic, runWithDiagnostics: (context, action) => diagnosticScope.run(context, action), port: serviceSettings.gatewayPort, prepareRequest: (provider, _secret, path, body) => upstream.prepareRequest(provider, path, body), nativeRequest, fetch: runtimeFetch });
    runtime = new ModelDockRuntime(gateway, store, {
      platform: process.platform,
      dataDir: join(dataDir, 'network'),
      engine: (progress, exit) => {
        if (__MODELDOCK_SMOKE_BUILD__) {
          if (process.env.MODELDOCK_SMOKE_NETWORK_ONLY === '1') return createNetworkSmokeEngine();
          throw new Error('隔离 UI 验证不允许操作系统网络。');
        }
        return new FlowBridgeEngine(networkResourceRoot(), join(dataDir, 'network'), progress, exit);
      },
      setHttpRelay: port => applicationNetwork.setHttpRelay(port),
      suspendHttpRelay: () => applicationNetwork.suspendHttpRelay(),
    });
    const { network } = runtime;
    networkMini = new NetworkMini(network, store, revealWindow, __dirname, __MODELDOCK_RUNTIME_MODE__ === 'development' ? devUrl : undefined);
    startupStage = 'gateway';
    if (serviceSettings.autoStartGateway) {
      try { await runtime.startGateway(); }
      catch { /* Keep the application available; the service page displays the gateway failure. */ }
    }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    registerIpc();
    Menu.setApplicationMenu(null);
    if (!__MODELDOCK_SMOKE_BUILD__) {
      tray = new Tray(getAppIcon(true));
      tray.setToolTip('ModelDock · 模型坞');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 ModelDock', click: revealWindow },
        { label: '网速小窗', click: () => { void networkMini.show(); } },
        { label: '断开网络代理', click: () => { void network.disconnect().catch(error => dialog.showErrorBox('网络恢复未完成', error.message)); } },
        { label: '停止本地网关', click: () => { void runtime.stopGateway().catch(error => dialog.showErrorBox('网关停止失败', error.message)); } },
        { type: 'separator' }, { label: '退出', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', revealWindow);
    }
    startupStage = 'window';
    await createWindow();
    if (!__MODELDOCK_SMOKE_BUILD__) {
      if (network.snapshot().settings.showMiniOnStart) await networkMini.show();
      void network.autoConnect();
    }
    recordDiagnostic('info', 'app.ready', { version: app.getVersion(), stage: 'window', port: gateway.status().port, autoStart: serviceSettings.autoStartGateway });
  }).catch(error => {
    recordDiagnostic('error', 'app.start_failed', { ...describeError(error), stage: startupStage, outcome: 'failure' });
    if (__MODELDOCK_SMOKE_BUILD__) writeFileSync(join(runtimeConfig.smoke!.outputDir, 'electron-smoke-error.txt'), String(error));
    else dialog.showErrorBox('ModelDock 启动失败', String(error));
    quitting = true; app.quit();
  });
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownRunning) return;
    shutdownRunning = true; quitting = true;
    void (async () => {
      // Keep the window, store and gateway alive if OS cleanup needs a retry.
      try { await runtime?.shutdown(); }
      catch (error) {
        shutdownRunning = false; quitting = false; revealWindow();
        dialog.showErrorBox('服务尚未退出', error instanceof Error ? error.message : '请重试断开后退出。');
        return;
      }
      if (!exitDiagnosticRecorded) { exitDiagnosticRecorded = true; recordDiagnostic('info', 'app.exit', { stage: 'shutdown' }); }
      accounts?.dispose(); copilotProviders?.dispose(); copilotAccounts?.dispose(); oauth?.dispose(); traeNativeAccounts?.dispose(); centralNativeAccounts?.dispose();
      try { await ideAccounts?.dispose(); } catch { /* Continue closing local resources. */ }
      networkMini?.close(); store?.close(); tray?.destroy();
      shutdownComplete = true;
      // Issue the final quit outside the cancelled before-quit callback.
      setImmediate(() => app.quit());
    })();
  });
  app.on('activate', () => { if (window) revealWindow(); else if (store) void createWindow(true); });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}

// 修改点：Linux 先取得内核级启动守卫，再进入原生锁和数据库/托盘初始化。
// 二次启动只向已有实例请求显示窗口，不能在原生锁尚未就绪时创建第二份应用。
void (async () => {
  const guard = !__MODELDOCK_SMOKE_BUILD__ && process.platform === 'linux'
    ? await acquireLinuxInstanceGuard(app.getPath('userData'), revealWindow) : undefined;
  if (guard === null) { app.quit(); return; }
  if (!__MODELDOCK_SMOKE_BUILD__ && !app.requestSingleInstanceLock()) {
    guard?.close(); app.quit(); return;
  }
  // 网关和 Store 完成 before-quit 清理后才释放；异常退出由内核自动回收。
  app.once('will-quit', () => guard?.close());
  initializeApplication();
})().catch(() => {
  dialog.showErrorBox('ModelDock 启动失败', '无法确认应用实例状态，请稍后重新启动 ModelDock。');
  app.exit(1);
});
