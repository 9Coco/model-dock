import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DiagnosticsLog, describeError, sanitizeDiagnosticEndpoint } from './diagnostic-log';
import { diagnosticOperationContext, diagnosticOperationResult, ignoresDiagnosticOperation, isQuietDiagnosticOperation } from './diagnostic-operations';
import type { DiagnosticContext, DiagnosticEvent, DiagnosticLevel, DiagnosticQuery } from '../shared/diagnostic-types';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, session, shell, Tray } from 'electron';
import { getAppIcon } from './app-icon';
import { dirname, join, relative, resolve } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Store } from './store';
import { Gateway } from './gateway';
import { OAuthManager } from './oauth';
import { AuthCenter } from './auth-center';
import { CopilotProviderManager } from './copilot-provider';
import { CopilotAuthCenter, isCopilotAccountId } from './copilot-auth';
import { authQuotaFixture } from './auth-quota-fixtures';
import { McpManager } from './mcp';
import { SkillManager } from './skills';
import { UsageManager } from './usage';
import { SettingsManager } from './settings';
import { ModelCatalog } from './catalog';
import { ConnectionTester } from './connection-test';
import { verifyProviderDuplicates } from './provider-duplicate-smoke';
import { verifyModelNames } from './model-names-smoke';
import { verifyUsageDashboard } from './usage-dashboard-smoke';
import { verifyUsageAnalytics } from './usage-analytics-smoke';
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
import { verifySidebarScroll } from './sidebar-scroll-smoke';
import { verifyDshConfiguration } from './dsh-config-smoke';
import { CopilotDesktopClient } from './copilot-desktop';
import { applyCopilotDesktop } from './copilot-sync';
import { removeProviderAndSync } from './provider-removal';
import { restoreOfficialConfig } from './tool-restore';
import { jetBrainsStatus, type JetBrainsConfigOptions } from './jetbrains-config';
import { isJetBrainsTool } from '../shared/jetbrains';
import { verifyClaudeConfiguration } from './claude-config-smoke';
import { verifyJetBrainsConnections } from './jetbrains-smoke';
import { verifyAggregateModes } from './aggregate-modes-smoke';
import { restoreToolBinding } from './tool-restore-binding';
import { applyNetworkProxy } from './network-proxy';
import { inspectAuthNetwork } from './network-diagnostic';
import { createSystemNetworkFetch } from './system-network';
import { resolveRuntimeConfig } from './runtime-mode';
import { bindingConnectionPolicy } from '../shared/bindings';
import { writeClipboardText } from './clipboard-text';
import { importToolUsage } from './usage-import';
import { UsageSyncService } from './usage-sync';
import { createVault } from './vault';
import { buildConfig, buildCopilotDesktopPlan, buildDshPlan, applyConfig, connectionKey } from './adapters';
import { applyDshConfig } from './dsh-config';
import { resolveDshProfile } from './dsh-profile';
import { openCodeDataDirectory } from './opencode-paths';
import type { ModelDockApi, ModelInput, Provider, ProviderInput, ToolBinding, ToolId } from '../shared/types';
import type { SubscriptionKind } from '../shared/auth-types';
import type { McpServerInput } from '../shared/mcp-types';
import type { SkillRepositoryInput } from '../shared/skill-types';
import type { ModelPrice, UsageQuery } from '../shared/usage-types';
import type { AppSettings } from '../shared/settings-types';
import type { ModelSelection } from '../shared/catalog-types';
import type { ConnectionTestInput } from '../shared/connection-types';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Store;
let gateway: Gateway;
let oauth: OAuthManager;
let accounts: AuthCenter;
let copilotAccounts: CopilotAuthCenter;
let copilotProviders: CopilotProviderManager;
let mcp: McpManager;
let skills: SkillManager;
let usage: UsageManager;
let usageSync: UsageSyncService;
let preferences: SettingsManager;
let catalog: ModelCatalog;
let connectionTester: ConnectionTester;
let showWhenRendererReady = true;
let rendererHasLoaded = false;
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

const runtimeConfig = resolveRuntimeConfig(__MODELDOCK_RUNTIME_MODE__, process.env);
const devUrl = __MODELDOCK_RUNTIME_MODE__ === 'development' ? runtimeConfig.devUrl : undefined;
if (runtimeConfig.dataDir) {
  mkdirSync(runtimeConfig.dataDir, { recursive: true });
  app.setPath('userData', runtimeConfig.dataDir);
  app.setPath('sessionData', runtimeConfig.dataDir);
}
const toolIds = new Set(['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm']);
function toolId(value: unknown): ToolId {
  if (typeof value !== 'string' || !toolIds.has(value)) throw new Error('无法识别的工具。');
  return value as ToolId;
}
function appIcon() {
  return getAppIcon();
}
function revealWindow() {
  explicitOpenRequested = true;
  showWhenRendererReady = true;
  if (!window || !rendererHasLoaded) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
async function createWindow(forceShow = false) {
  const mark = appIcon();
  rendererHasLoaded = false;
  showWhenRendererReady = forceShow || explicitOpenRequested || !preferences.get().settings.startHidden;
  window = new BrowserWindow({ width: 1080, height: 720, minWidth: 980, minHeight: 680, show: false,
    title: 'ModelDock · 模型坞', backgroundColor: nativeTheme.shouldUseDarkColors ? '#19191c' : '#f8f9fb', icon: mark,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: !__MODELDOCK_SMOKE_BUILD__ },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const docs = ['api-docs.deepseek.com', 'docs.volcengine.com', 'help.aliyun.com', 'developers.openai.com', 'platform.claude.com', 'ai.google.dev', 'docs.z.ai', 'platform.kimi.ai', 'docs.x.ai', 'x.ai', 'opencode.ai', 'github.com', 'docs.github.com', 'code.visualstudio.com'];
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
    if (quitting || __MODELDOCK_SMOKE_BUILD__) return;
    event.preventDefault();
    if (preferences.get().settings.closeToTray && tray) window?.hide();
    else { quitting = true; app.quit(); }
  });
  window.on('closed', () => { window = null; });
  if (__MODELDOCK_RUNTIME_MODE__ === 'development' && devUrl) {
    const url = new URL(devUrl);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('开发界面只允许本机地址。');
    await window.loadURL(devUrl);
  } else await window.loadFile(join(__dirname, '../dist/index.html'));
  if (__MODELDOCK_SMOKE_BUILD__) {
    await window.webContents.executeJavaScript(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';document.head.appendChild(style);})()`);
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
        const result = await window!.webContents.executeJavaScript(`({title:document.title, text:document.body.innerText, bridge:!!window.modelDock})`);
        writeFileSync(join(outputDir, 'electron-smoke.json'), JSON.stringify({ ...result, dataDir, windowSize: window!.getSize(), contentSize: window!.getContentSize() }, null, 2));
        writeFileSync(join(outputDir, 'electron-smoke.png'), await captureUi());
        await verifyToolIcons(window!, outputDir, captureUi);
        if (process.env.MODELDOCK_SMOKE_AGGREGATE_ONLY === '1') {
          await verifyAggregateModes(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_JETBRAINS_ONLY === '1') {
          await verifyJetBrainsConnections(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_CLAUDE_ONLY === '1') {
          await verifyClaudeConfiguration(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_METADATA_ONLY === '1') {
          await verifyModelMetadata(window!, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_SIDEBAR_ONLY === '1') {
          await verifySidebarScroll(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_COMPACT_ONLY === '1') {
          await verifyCompactUi(window!, store, outputDir, captureUi);
        } else if (process.env.MODELDOCK_SMOKE_USAGE_ONLY === '1') {
          await verifyUsageAnalytics(window!, store, outputDir, captureUi);
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
          for (const name of ['models','tools','service'] as const) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${name}"]').click()`);
            await new Promise(resolve => setTimeout(resolve,200));
            writeFileSync(join(outputDir,`electron-${name}.png`),await captureUi());
          }
          await window!.webContents.executeJavaScript(`document.querySelector('[data-source="aggregate"]').click()`);
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
          const modeUi = await window!.webContents.executeJavaScript(`(()=>({title:document.querySelector('.breadcrumbs')?.textContent,hasModal:!!document.querySelector('[role="dialog"]'),hasLegacyTabs:!!document.querySelector('.route-tabs'),checkboxes:document.querySelectorAll('[data-action="select-tool-provider"]').length,defaultInline:!!document.querySelector('[data-action="tool-default-model"]')}))()`);
          writeFileSync(join(outputDir,'mode-ui-debug.json'),JSON.stringify(modeUi,null,2));
          if (modeUi.hasModal || modeUi.hasLegacyTabs || !modeUi.checkboxes || !modeUi.defaultInline) throw new Error('Inline tool provider selection unavailable');
          writeFileSync(join(outputDir,'mode-ui-validation.json'),JSON.stringify({ok:true,title:modeUi.title},null,2));
          writeFileSync(join(outputDir,'electron-tool-modes.png'),await captureUi());
          const navigation = await window!.webContents.executeJavaScript(`(async()=>{
            const before=await window.modelDock.snapshot();
            const tools=[];
            for(const id of ['codex','opencode','dsh','vscode','copilot']){
              document.querySelector('[data-tool-id="'+id+'"]').click();
              await new Promise(resolve=>setTimeout(resolve,80));
              tools.push({id,title:document.querySelector('.breadcrumbs').textContent,inline:!!document.querySelector('[data-action="select-tool-provider"]')});
            }
            document.querySelector('[data-source-id="'+${JSON.stringify(outcome.providerId)}+'"]').click();
            await new Promise(resolve=>setTimeout(resolve,100));
            const providerDetail={title:document.querySelector('.breadcrumbs').textContent,hasModel:document.querySelector('.provider-models').textContent.includes('dock-smoke')};
            const after=await window.modelDock.snapshot();
            return {tools,providerDetail,bindingsUnchanged:JSON.stringify(before.bindings)===JSON.stringify(after.bindings)};
          })()`);
          if (!navigation.bindingsUnchanged || !navigation.providerDetail.hasModel || !navigation.tools.every((tool: any)=>tool.title.includes('供应商'))) throw new Error('Detail navigation changed bindings or lost provider models');
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
            await api.usageSavePrice({modelId:${JSON.stringify(outcome.modelId)},inputUsdPerMillion:10,cachedInputUsdPerMillion:2,outputUsdPerMillion:20});
            const usage=await api.usageQuery({from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString(),source:'gateway'});
            const client=await api.usageQuery({from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString(),source:'client'});
            return {mcpApplied:applied.changed,mcpRedacted:!JSON.stringify(server).includes('synthetic-mcp-secret')&&!preview.content.includes('synthetic-mcp-secret'),skillRead:file.content.includes('# Fixture'),skillTools:library.skills.find(s=>s.id===skill.id).deployments.filter(d=>d.state==='deployed').map(d=>d.tool),usage:{requests:usage.requests,reported:usage.reportedRequests,input:usage.inputTokens,output:usage.outputTokens,cache:usage.cachedInputTokens,cost:usage.estimatedCostUsd},clientIndependent:client.requests===0,accountsSafe:!(await api.authAccounts()).some(a=>'accessToken' in a||'refreshToken' in a)};
          })()`);
          const clientConfig = readFileSync(join(testHome, '.codex', 'config.toml'), 'utf8');
          if (!featureOutcome.mcpApplied || !featureOutcome.mcpRedacted || !clientConfig.includes('preserve-me') || !clientConfig.includes('preserved-model') || !clientConfig.includes('synthetic-mcp-secret') || !featureOutcome.skillRead || !featureOutcome.skillTools.includes('copilot') || featureOutcome.usage.input!==7 || featureOutcome.usage.output!==3 || featureOutcome.usage.cache!==2 || Math.abs(featureOutcome.usage.cost-0.000114)>1e-9 || !featureOutcome.clientIndependent || !featureOutcome.accountsSafe) throw new Error('Feature integration validation failed: '+JSON.stringify(featureOutcome));
          writeFileSync(join(outputDir,'feature-integration.json'),JSON.stringify(featureOutcome,null,2));
          mkdirSync(join(testHome, '.codex', 'sessions'), { recursive: true });
          const clientTime = new Date().toISOString();
          writeFileSync(join(testHome, '.codex', 'sessions', 'rollout-native.jsonl'), [
            { timestamp: clientTime, type: 'session_meta', payload: { id: 'native-usage-fixture' } },
            { timestamp: clientTime, type: 'turn_context', payload: { model: 'smoke-client-model', turn_id: 'native-turn' } },
            { timestamp: clientTime, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 1, total_tokens: 8 }, last_token_usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 1, total_tokens: 8 } }, rate_limits: { limit_id: 'codex' } } },
          ].map(item=>JSON.stringify(item)).join('\n')+'\n');
          const clientUsage = await window!.webContents.executeJavaScript(`(async()=>{
            const api=window.modelDock, first=await api.usageImportTool('codex'), second=await api.usageImportTool('codex');
            const query={from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString()};
            const client=await api.usageQuery({...query,source:'client'}), gateway=await api.usageQuery({...query,source:'gateway'});
            return {first:first.imported,second:second.imported,client:client.requests,input:client.inputTokens,output:client.outputTokens,gateway:gateway.requests};
          })()`);
          if(clientUsage.first!==1||clientUsage.second!==0||clientUsage.client!==1||clientUsage.input!==7||clientUsage.output!==1||clientUsage.gateway!==1) throw new Error('Client usage IPC import or deduplication failed');
          writeFileSync(join(outputDir,'client-usage-integration.json'),JSON.stringify(clientUsage,null,2));
          const featureLayouts=[];
          for (const [width,height] of [[1320,880],[980,680]]) {
            window!.setSize(width,height);
            for (const page of ['auth','mcp','skills','usage']) {
              await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
              await new Promise(resolve=>setTimeout(resolve,200));
              const layout=await window!.webContents.executeJavaScript(`(()=>{const main=document.querySelector('.main-content'),functions=document.querySelector('.sidebar-functions');return {title:document.querySelector('.breadcrumbs').textContent,documentOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:main.scrollWidth>main.clientWidth,functionsVisible:functions.getBoundingClientRect().bottom<=innerHeight,hasError:!!document.querySelector('[role="alert"]')};})()`);
              featureLayouts.push({width,height,page,...layout});
              writeFileSync(join(outputDir,`electron-feature-${page}-${width}.png`),await captureUi());
              if(layout.documentOverflow||layout.mainOverflow||!layout.functionsVisible||layout.hasError) throw new Error('Feature page overflow/error: '+JSON.stringify(layout));
            }
          }
          writeFileSync(join(outputDir,'feature-layout-validation.json'),JSON.stringify(featureLayouts,null,2));
          const featureDialogs=[];
          for (const [page,label] of [['auth','添加账号'],['mcp','添加 MCP'],['skills','仓库导入'],['usage','模型单价']] as const) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            await window!.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify(label)})).click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            const dialog=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]'),rect=dialog.getBoundingClientRect(),buttons=Array.from(dialog.querySelector('.modal-footer,.modal-actions').querySelectorAll('button')).map(button=>button.getBoundingClientRect());return {title:dialog.querySelector('h2').textContent,inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,footerVisible:buttons.every(rect=>rect.bottom<=innerHeight&&rect.right<=innerWidth&&rect.top>=0)};})()`);
            if(!dialog.inViewport||!dialog.footerVisible) throw new Error('Feature dialog actions outside minimum window: '+JSON.stringify(dialog));
            featureDialogs.push({page,...dialog});
            writeFileSync(join(outputDir,`electron-feature-${page}-dialog-980.png`),await captureUi());
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
          await window!.webContents.executeJavaScript(`window.modelDock.saveSettings({startHidden:true,closeToTray:false,terminal:${JSON.stringify(process.platform === 'win32' ? 'cmd' : 'system')}})`);
          await new Promise<void>(resolve=>{window!.webContents.once('did-finish-load',()=>resolve());window!.webContents.reload();});
          await new Promise(resolve=>setTimeout(resolve,400));
          await window!.webContents.executeJavaScript(`(()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.appendChild(style);})()`);
          const reloaded=await window!.webContents.executeJavaScript(`(async()=>{const value=await window.modelDock.getSettings();return {settings:value.settings,resolved:document.documentElement.dataset.theme,ready:!!document.querySelector('.app-shell')};})()`);
          if(!reloaded.ready||reloaded.resolved!=='dark'||!reloaded.settings.startHidden||reloaded.settings.closeToTray||reloaded.settings.terminal!==(process.platform==='win32'?'cmd':'system')) throw new Error('Settings did not survive renderer reload');
          writeFileSync(join(outputDir,'settings-validation.json'),JSON.stringify({themes,followsDark,followsLight,reloaded},null,2));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-page="settings"]').click()`);
          window!.setSize(1320,880);
          await new Promise(resolve=>setTimeout(resolve,200));
          writeFileSync(join(outputDir,'electron-settings-dark-1320.png'),await captureUi());
          for (const page of ['tools','auth','mcp','skills','usage']) {
            await window!.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,150));
            writeFileSync(join(outputDir,`electron-theme-dark-${page}.png`),await captureUi());
          }
          await window!.webContents.executeJavaScript(`document.querySelector('[data-tool-id="codex"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="add-api-provider"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,150));
          const darkDialog=await window!.webContents.executeJavaScript(`(()=>{const modal=document.querySelector('[role="dialog"]');return {visible:!!modal,title:modal?.querySelector('h2')?.textContent,background:modal?getComputedStyle(modal).backgroundColor:null};})()`);
          if(!darkDialog.visible||darkDialog.background!=='rgb(32, 43, 48)') throw new Error('Dark modal did not render with dark surface');
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
          if(!addedUi.success||addedUi.models.length!==3||addedUi.alreadyAdded!==3||!addedUi.models.some((model:any)=>model.upstreamId==='mock-reasoner'&&model.contextWindow===0&&model.tools)) throw new Error('Model discovery batch add did not persist selected models');
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
          const automatic=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');return {title:dialog?.querySelector('h2')?.textContent,models:dialog?.querySelectorAll('.discovery-model').length,hasError:!!dialog?.querySelector('[role="alert"]')};})()`);
          if(automatic.title!=='获取模型列表'||automatic.models!==3||automatic.hasError) throw new Error('Saving API key did not automatically open populated model discovery');
          writeFileSync(join(outputDir,'electron-discovery-auto-key-980.png'),await captureUi());
          await window!.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭对话框"]').click()`);
          await window!.webContents.executeJavaScript(`(async()=>{const api=window.modelDock,snapshot=await api.snapshot(),provider=snapshot.providers.find(p=>p.id===${JSON.stringify(outcome.providerId)});await api.saveProvider({...provider,apiKey:'synthetic-invalid'});})()`);
          await window!.webContents.executeJavaScript(`document.querySelector('[data-action="discover-models"]').click()`);
          await new Promise(resolve=>setTimeout(resolve,250));
          const failedDiscovery=await window!.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('[role="dialog"]');return {authError:dialog.textContent.includes('HTTP 401'),models:dialog.querySelectorAll('.discovery-model').length,addDisabled:Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent.includes('添加所选')).disabled};})()`);
          if(!failedDiscovery.authError||failedDiscovery.models!==0||!failedDiscovery.addDisabled) throw new Error('Discovery auth failure displayed stale models');
          writeFileSync(join(outputDir,'electron-discovery-auth-error-980.png'),await captureUi());
          writeFileSync(join(outputDir,'discovery-validation.json'),JSON.stringify({discoveredUi,discoveryLayout,addedUi,repeated:{added:repeated.added.length,skipped:repeated.skipped.length},unknownEditable,automatic,failedDiscovery},null,2));
          await verifyProviderDuplicates(window!, outputDir, captureUi);
          await verifyModelNames(window!, outputDir, captureUi);
          await verifyUsageDashboard(window!, store, outputDir, captureUi);
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
    const home = join(dataDir, 'feature-home');
    return { profileRoot: join(home, '.config', 'JetBrains'), cacheRoot: join(home, '.cache', 'JetBrains'), platform: 'linux', processProbe: pid => pid === process.pid ? 'running' : 'stopped' };
  }
  return process.platform === 'linux' ? {
    profileRoot: join(process.env.XDG_CONFIG_HOME?.trim() || join(app.getPath('home'), '.config'), 'JetBrains'),
    cacheRoot: join(process.env.XDG_CACHE_HOME?.trim() || join(app.getPath('home'), '.cache'), 'JetBrains'),
  } : {};
}

function registerIpc() {
  let providerRemovalPending = false;
  let toolRestorePending = false;
  const toolConfigPending = new Set<ToolId>();
  const assertEditable = () => {
    if (providerRemovalPending) throw new Error('供应商正在删除并同步，请稍后修改配置。');
    if (toolRestorePending) throw new Error('正在还原官方配置，请稍后修改配置。');
    if (toolConfigPending.size) throw new Error('工具配置正在同步，请稍后修改配置。');
  };
  async function synchronizeTool(id: ToolId): Promise<string> {
    if (toolRestorePending || toolConfigPending.has(id)) throw new Error('此工具配置正在更新，请稍后再试。');
    toolConfigPending.add(id);
    try {
    const binding = store.listBindings().find(item => item.id === id);
    const preview = buildConfig(store, id, gateway.status().port, true, __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home'), { jetBrainsOptions: jetBrainsOptions() });
    if (!preview.canApply) throw new Error('此工具使用导出配置入口。');
    const usesGateway = binding && bindingConnectionPolicy(binding, store.listModels(), store.listProviders()).groups.some(group => group.connection === 'local-managed' && group.modelIds.length > 0);
    if (usesGateway && !gateway.status().running) {
      const status = await gateway.start(gateway.status().port);
      if (!status.running) throw new Error('本地入口未能启动，尚未写入工具配置。');
    }
    if (id === 'copilot') {
      const target = copilotTarget();
      return applyCopilotDesktop(store, buildCopilotDesktopPlan(store, gateway.status().port, true), target.home, { openClient: target.openClient, syncScope: binding?.copilotSyncScope ?? 'selected' });
    }
    if (id === 'dsh') {
      const configuredDshHome = process.env.DSH_HOME?.trim();
      const dshHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home', '.dsh')
        : configuredDshHome ? resolve(configuredDshHome) : join(app.getPath('home'), '.dsh');
      const profile = __MODELDOCK_SMOKE_BUILD__ ? { modelPlugins: [
        { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
        { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
        { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
      ], baselineProviders: {} } : await resolveDshProfile(dshHome);
      return applyDshConfig(store, buildDshPlan(store, gateway.status().port, true), dshHome, profile);
    }
    const featureHome = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : undefined;
    const appData = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-appdata') : app.getPath('appData');
    return applyConfig(store, id, gateway.status().port, appData, join(dataDir, 'backups'), featureHome, {
      codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome!, '.codex') : process.env.CODEX_HOME?.trim() ? resolve(process.env.CODEX_HOME.trim()) : undefined,
      configHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome!, '.config') : process.env.XDG_CONFIG_HOME,
      claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome!, '.claude') : process.env.CLAUDE_CONFIG_DIR,
      jetBrainsOptions: jetBrainsOptions(),
    });
    } finally { toolConfigPending.delete(id); }
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
    gateway: gateway.status(), logs: store.logs(100), dataDir, version: app.getVersion() }));
  handle('getSettings', () => preferences.get());
  handle('probeAuthNetwork', () => inspectAuthNetwork(session.defaultSession, preferences.get().settings.proxyUrl,
    __MODELDOCK_SMOKE_BUILD__ && process.env.MODELDOCK_SMOKE_AUTH_MOCK === '1'
      ? async () => {
        if (process.env.MODELDOCK_SMOKE_GROK_MODE === 'network-error') throw Object.assign(new TypeError('PRIVATE_NETWORK_DIAGNOSTIC'), { cause: { code: 'ERR_CONNECTION_RESET' } });
        return new Response(JSON.stringify({ issuer: 'https://auth.x.ai', device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code', token_endpoint: 'https://auth.x.ai/oauth2/token' }), { headers: { 'content-type': 'application/json' } });
      }
      : createSystemNetworkFetch((input, init) => session.defaultSession.fetch(input instanceof URL ? input.href : input, init))));
  handle('saveSettings', async (patch: Partial<AppSettings>) => {
    const previous = preferences.get().settings;
    if (Object.hasOwn(patch, 'gatewayPort') && gateway.status().running && patch.gatewayPort !== gateway.status().port) throw new Error('请先停止本地服务，再修改服务端口。');
    const result = preferences.save(patch);
    if (Object.hasOwn(patch, 'proxyUrl')) {
      try { await applyNetworkProxy(session.defaultSession, result.settings.proxyUrl); }
      catch (error) {
        const rollback = Object.fromEntries(Object.keys(patch).map(key => [key, previous[key as keyof AppSettings]])) as Partial<AppSettings>;
        preferences.save(rollback); await applyNetworkProxy(session.defaultSession, previous.proxyUrl); throw error;
      }
    }
    if (Object.hasOwn(patch, 'gatewayPort')) gateway.configurePort(result.settings.gatewayPort);
    nativeTheme.themeSource = result.settings.theme;
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#19191c' : '#f8f9fb');
    return result;
  });
  handle('openTerminal', () => preferences.openTerminal(dataDir));
  handle('rendererReady', () => {
    if (rendererHasLoaded) return;
    rendererHasLoaded = true;
    if (window && !__MODELDOCK_SMOKE_BUILD__ && showWhenRendererReady) {
      if (window.isMinimized()) window.restore();
      window.show();
      if (explicitOpenRequested) window.focus();
    }
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
  handle('deleteProvider', async (id: string) => {
    assertEditable(); providerRemovalPending = true;
    try {
      catalog.invalidate(id); accounts.cancelProviderOperations(id); copilotProviders.cancel(id);
      await removeProviderAndSync(store, id, synchronizeTool);
    } finally { catalog.invalidate(id); providerRemovalPending = false; }
  });
  handle('saveModel', (input: ModelInput) => { assertEditable(); return store.saveModel(input); });
  handle('deleteModel', (id: string) => { assertEditable(); return store.deleteModel(id); });
  handle('saveBinding', (binding: ToolBinding) => { assertEditable(); return store.saveBinding({ ...binding, id: toolId(binding.id) }); });
  handle('startGateway', async (port?: number) => {
    const status = await gateway.start(port ?? preferences.get().settings.gatewayPort);
    if (status.running) preferences.save({ gatewayPort: status.port });
    return status;
  });
  handle('stopGateway', async () => { await gateway.stop(); return gateway.status(); });
  handle('copyText', (value: unknown) => writeClipboardText(value, text => clipboard.writeText(text)));
  handle('copyGatewayKey', () => writeClipboardText(store.gatewayKey(), text => clipboard.writeText(text)));
  handle('copyConnectionKey', (tool: ToolId) => writeClipboardText(connectionKey(store, toolId(tool)), text => clipboard.writeText(text)));
  handle('jetBrainsStatus', (value: unknown) => {
    if (!isJetBrainsTool(value)) throw new Error('不是支持的 JetBrains 工具。');
    const home = __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home');
    return jetBrainsStatus(value, home, jetBrainsOptions());
  });
  handle('previewConfig', (tool: ToolId) => buildConfig(store, toolId(tool), gateway.status().port, false, __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home'), { jetBrainsOptions: jetBrainsOptions() }));
  handle('exportConfig', async (tool: ToolId) => {
    const config = buildConfig(store, toolId(tool), gateway.status().port, true, __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'feature-home') : app.getPath('home'), { jetBrainsOptions: jetBrainsOptions() });
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
      return await restoreToolBinding(store, id, () => restoreOfficialConfig(store, id, appData, join(dataDir, 'backups'), featureHome, {
        codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME?.trim() ? resolve(process.env.CODEX_HOME.trim()) : join(featureHome, '.codex'),
        configHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.config') : process.env.XDG_CONFIG_HOME,
        claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.claude') : process.env.CLAUDE_CONFIG_DIR,
        jetBrainsOptions: jetBrainsOptions(),
        dshHome, dshOptions, copilotHome: target.home, copilotOptions: { openClient: target.openClient },
      }));
    } finally { toolRestorePending = false; }
  });
  handle('openDataDir', async () => { const error = await shell.openPath(dataDir); if (error) throw new Error(error); });
  handle('beginLogin', (id: string) => { assertEditable(); catalog.invalidate(id); return store.getProvider(id)?.kind === 'copilot' ? copilotProviders.beginLogin(id) : oauth.beginLogin(id); });
  handle('authProgress', (id: string) => store.getProvider(id)?.kind === 'copilot' ? copilotProviders.progress(id) : oauth.progress(id));
  handle('cancelLogin', (id: string) => store.getProvider(id)?.kind === 'copilot' ? copilotProviders.cancel(id) : oauth.cancel(id));
  handle('authAccounts', () => [...accounts.listAccounts(), ...copilotAccounts.listAccounts()]);
  handle('refreshAccountUsage', (id: string) => {
    if (isCopilotAccountId(id)) return copilotAccounts.refreshUsage(id);
    if (store.getProvider(id)?.kind === 'copilot') {
      const accountId = store.getSecret(id)?.copilotAccountId;
      if (!accountId) throw new Error('请先关联或登录 GitHub 账号。');
      return copilotAccounts.refreshUsage(accountId);
    }
    return accounts.refreshUsage(id);
  });
  handle('beginCopilotLogin', () => { assertEditable(); return copilotAccounts.beginLogin(); });
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
  handle('usageQuery', (query: UsageQuery) => usage.query(query));
  handle('usageSyncTools', () => usageSync.sync());
  handle('usageSources', () => usageSync.sources());
  handle('usageSavePrice', (price: ModelPrice) => usage.savePrice(price));
  handle('usageDeletePrice', (id: string) => usage.removePrice(id));
  handle('usageImportTool', (tool: ToolId) => importToolUsage(toolId(tool), store, {
    homeDir: __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'test-home') : app.getPath('home'),
    codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(dataDir, 'test-home', '.codex') : process.env.CODEX_HOME,
  }));
  handle('testProvider', (id: string, input?: ConnectionTestInput) => connectionTester.test(id, input));
  handle('discoverModels', (id: string) => catalog.discover(id));
  handle('addDiscoveredModels', (id: string, selected: ModelSelection[]) => { assertEditable(); return catalog.addSelected(id, selected); });
}

if (!__MODELDOCK_SMOKE_BUILD__ && !app.requestSingleInstanceLock()) app.quit();
else {
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
    const systemFetch = createSystemNetworkFetch(async (input, init) => {
      const startedAt = Date.now(), target = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const context: DiagnosticContext = { endpoint: target };
      try {
        const response = await net.fetch(input instanceof URL ? input.href : input, init);
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
    nativeTheme.themeSource = preferences.get().settings.theme;
    nativeTheme.on('updated', () => { if (window && !window.isDestroyed()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#19191c' : '#f8f9fb'); });
    startupStage = 'proxy';
    await applyNetworkProxy(session.defaultSession, preferences.get().settings.proxyUrl);
    startupStage = 'managers';
    accounts = new AuthCenter(store, oauth, { homeDir: featureHome, codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME, fetch: runtimeFetch });
    copilotAccounts = new CopilotAuthCenter(store, { fetch: runtimeFetch, onAuthorized: (accountId, providerId) => {
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
    const openCodeDataDir = openCodeDataDirectory(__MODELDOCK_SMOKE_BUILD__ ? featureHome : undefined);
    mcp = new McpManager(store, { homeDir: featureHome, appDataDir: featureAppData, backupDir: join(dataDir, 'backups', 'mcp'), configHome: openCodeConfigHome, codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME });
    skills = new SkillManager(store, { homeDir: featureHome, appDataDir: featureAppData, libraryDir: join(dataDir, 'skill-library'), backupDir: join(dataDir, 'backups', 'skills'), configHome: openCodeConfigHome, claudeConfigDir: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.claude') : process.env.CLAUDE_CONFIG_DIR, ...(!__MODELDOCK_SMOKE_BUILD__ ? { codexHome: process.env.CODEX_HOME, dshHome: process.env.DSH_HOME } : {}) });
    usage = new UsageManager(store);
    usageSync = new UsageSyncService(store, {
      homeDir: featureHome,
      codexHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.codex') : process.env.CODEX_HOME,
      opencodeDataDir: openCodeDataDir,
      appDataDir: featureAppData,
      dshHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.dsh') : process.env.DSH_HOME,
      copilotHome: __MODELDOCK_SMOKE_BUILD__ ? join(featureHome, '.copilot') : process.env.COPILOT_HOME,
    });
    // 修改点：Copilot 订阅与其他来源共享目录、连通性及本地网关，凭据准备在主进程分派。
    const upstream = { prepareRequest: (provider: Provider, path: string, body: Record<string, unknown>) => provider.kind === 'copilot'
      ? copilotProviders.prepareRequest(provider, path, body) : oauth.prepareRequest(provider, path, body) };
    catalog = new ModelCatalog(store, upstream, { fetch: runtimeFetch });
    connectionTester = new ConnectionTester(store, upstream, { fetch: runtimeFetch, diagnostics: recordDiagnostic });
    const serviceSettings = preferences.get().settings;
    gateway = new Gateway(store, { diagnostics: recordDiagnostic, runWithDiagnostics: (context, action) => diagnosticScope.run(context, action), port: serviceSettings.gatewayPort, prepareRequest: (provider, _secret, path, body) => upstream.prepareRequest(provider, path, body), fetch: runtimeFetch });
    startupStage = 'gateway';
    if (serviceSettings.autoStartGateway) {
      try { await gateway.start(); }
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
        { label: '停止本地网关', click: () => { void gateway.stop(); } },
        { type: 'separator' }, { label: '退出', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', revealWindow);
    }
    startupStage = 'window';
    await createWindow();
    recordDiagnostic('info', 'app.ready', { version: app.getVersion(), stage: 'window', port: gateway.status().port, autoStart: serviceSettings.autoStartGateway });
  }).catch(error => {
    recordDiagnostic('error', 'app.start_failed', { ...describeError(error), stage: startupStage, outcome: 'failure' });
    if (__MODELDOCK_SMOKE_BUILD__) writeFileSync(join(runtimeConfig.smoke!.outputDir, 'electron-smoke-error.txt'), String(error));
    else dialog.showErrorBox('ModelDock 启动失败', String(error));
    quitting = true; app.quit();
  });
  app.on('before-quit', event => {
    if (!exitDiagnosticRecorded) { exitDiagnosticRecorded = true; recordDiagnostic('info', 'app.exit', { stage: 'shutdown' }); }
    if (!quitting) { event.preventDefault(); quitting = true; }
    if (gateway) { event.preventDefault(); const current = gateway; gateway = undefined as unknown as Gateway;
      accounts?.dispose(); copilotProviders?.dispose(); copilotAccounts?.dispose(); oauth?.dispose(); void current.stop().finally(() => { store?.close(); tray?.destroy(); app.quit(); }); }
  });
  app.on('activate', () => { if (window) revealWindow(); else if (store) void createWindow(true); });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}
