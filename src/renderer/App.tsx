import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, BookOpen, Box, Check,
  CheckCheck, ChevronDown, CircleHelp, Copy, Database, Download,
  FileCode2, FolderOpen, Globe2, KeyRound, Layers3, LoaderCircle,
  Pencil, Plug2, Plus, Power, Radio, RefreshCw, RotateCcw, Search,
  Server, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, Unplug,
  Waypoints, X, Zap,
} from './MaterialIcon';
import type {
  AuthProgress, ConfigPreview, ConnectionResult, Model, ModelInput,
  Provider, ProviderInput, ProviderKind, ProviderPresetId, ReasoningEffort, Snapshot, ToolBinding, ToolId,
} from '../shared/types';
import { REASONING_EFFORTS } from '../shared/types';
import type { AuthAccount } from '../shared/auth-types';
import { providerPresets, presetById } from '../shared/presets';
import { bindingConnectionPolicy, resolveBindingModels } from '../shared/bindings';
import { nativeClaudeBaseUrl } from '../shared/claude';
import { isJetBrainsTool, jetBrainsConnectionParameters, JETBRAINS_TOOLS, type JetBrainsStatus } from '../shared/jetbrains';
import { JetBrainsPanel } from './JetBrainsPanel';
import { Toggle, Modal, EmptyState, BusyIcon } from './components';
import { AuthPanel } from './AuthPanel';
import { McpPanel } from './McpPanel';
import SkillsPanel from './SkillsPanel';
import { UsagePanel } from './UsagePanel';
import brandIcon from '../../assets/modeldock.svg?no-inline';
import { usageDateRange } from '../shared/usage-report';
import { usageRange } from '../shared/usage-display';
import type { UsageQuery, UsageSnapshot } from '../shared/usage-types';
import { SettingsPanel } from './SettingsPanel';
import { applyTheme } from './theme';
import { ToolIcon } from './ToolIcon';
import type { AppSettings, SettingsSnapshot } from '../shared/settings-types';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ModelDiscovery } from './ModelDiscovery';
import { ProviderDuplicates } from './ProviderDuplicates';
import type { DiscoveryResult } from '../shared/catalog-types';
import { providerIdentity } from '../shared/provider-duplicates';
import { modelDisplayLabel, modelLocalAlias, suggestModelAlias } from '../shared/model-names';
import { firstConnectionModel } from '../shared/connection-types';

type Page = 'providers' | 'models' | 'tools' | 'service' | 'auth' | 'mcp' | 'skills' | 'usage' | 'settings';
type Toast = { id: number; message: string; tone: 'success' | 'error' | 'info' };
type ProviderDraft = ProviderInput & { apiKey: string; note: string };
type ModelDraft = ModelInput;
type ToolDelivery = { signature: string; kind: 'applied' | 'exported'; location: string; providerIds: string[] };
const pageMeta: Record<Page, { label: string }> = {
  providers: { label: '供应商管理' }, models: { label: '模型目录' },
  tools: { label: '工具接入' }, service: { label: '服务与日志' },
  auth: { label: '授权中心' }, mcp: { label: 'MCP 管理' }, skills: { label: 'Skills 管理' }, usage: { label: '用量统计' },
  settings: { label: '设置' },
};
const providerKinds: Record<ProviderKind, { title: string; short: string; description: string; symbol: string }> = {
  'openai-compatible': { title: '自定义 API', short: 'API', description: '用服务地址和 API 密钥连接', symbol: 'A' },
  codex: { title: 'Codex 订阅', short: 'CODEX', description: '使用自己的 ChatGPT 账号登录', symbol: 'C' },
  copilot: { title: 'GitHub Copilot 订阅', short: 'COPILOT', description: '使用自己的 GitHub Copilot 订阅', symbol: 'P' },
  grok: { title: 'Grok Build 订阅', short: 'GROK', description: '使用自己的 Grok Build 账号登录', symbol: 'G' },
};
const toolInfo: Record<ToolId, { name: string; subtitle: string; description: string; instruction: string }> = {
  'claude-code': { name: 'Claude Code', subtitle: '终端', description: '连接现有 API 供应商或账号订阅。', instruction: '可单独连接一家来源，或开启聚合接口使用多家模型。同步后重启 Claude Code 终端生效；VS Code 扩展需另配环境。' },
  dsh: { name: 'DeepSeek Harness', subtitle: 'DSH · 桌面与终端', description: '在 Harness 中使用同一份模型目录。', instruction: '勾选供应商后自动同步到 DSH 配置，已有文件自动备份。' },
  copilot: { name: 'GitHub Copilot', subtitle: '独立桌面应用', description: '将所选供应商同步到正在运行的 Copilot app。', instruction: '请先打开 Copilot app。勾选后自动同步到应用原生模型注册表，无需重启；在应用的模型选择器中选择导入的模型。' },
  vscode: { name: 'VS Code', subtitle: 'GitHub Copilot 扩展', description: '把本地模型加入编辑器的模型选择器。', instruction: '预览生成的设置，再保存到 VS Code。' },
  opencode: { name: 'OpenCode', subtitle: '桌面 / CLI', description: '连接供应商，在 OpenCode 中使用统一模型目录。', instruction: '选择供应商后预览配置，再按生成的说明应用到 OpenCode。' },
  ...Object.fromEntries(Object.entries(JETBRAINS_TOOLS).map(([id, info]) => [id, { name: info.name, subtitle: 'JetBrains AI Assistant', description: '将已有 API 和账号订阅用于 AI Assistant。', instruction: '选择来源只保存本机绑定。可手工填写连接参数，或在 IDE 退出后显式同步设置；API Key 需在 IDE 中粘贴确认。' }])) as Record<'webstorm' | 'intellij-idea' | 'rider' | 'pycharm', { name: string; subtitle: string; description: string; instruction: string }>,
  codex: { name: 'Codex', subtitle: '桌面 / CLI / IDE', description: '让 Codex 使用你的本地模型入口。', instruction: '预览后可应用到 Codex 配置，原有账号登录保留。' },
};
const toolIds: ToolId[] = ['codex', 'claude-code', 'opencode', 'dsh', 'vscode', 'copilot', 'webstorm', 'intellij-idea', 'rider', 'pycharm'];
const emptySnapshot: Snapshot = {
  providers: [], models: [], bindings: [], logs: [], dataDir: '', version: '',
  gateway: { running: false, host: '127.0.0.1', port: 18181, baseUrl: '', requests: 0, lastError: '' },
};
const freshProvider = (presetId: ProviderPresetId = 'deepseek'): ProviderDraft => {
  const preset = presetById(presetId)!;
  // 修改点：官方 Anthropic 模板使用 x-api-key；自定义及历史来源保留 Bearer 默认。
  return { name: preset.id === 'custom' ? '' : preset.name, kind: preset.kind, presetId: preset.id, baseUrl: preset.baseUrl, apiKey: '', enabled: true, note: '', ...(preset.kind === 'openai-compatible' ? { messagesAuth: preset.id === 'anthropic' ? 'api-key' : 'bearer' } : {}), ...(preset.kind === 'copilot' ? { copilotAccountId: '' } : {}) };
};
const freshModel = (providerId = '', wireApi: Model['wireApi'] = 'responses'): ModelDraft => ({ providerId, upstreamId: '', alias: '', displayName: '', wireApi, contextWindow: 128000, tools: true, vision: false, enabled: true });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const contextLabel = (value: number) => value === 0 ? '未设置' : value >= 1000000 ? `${(value / 1000000).toFixed(value % 1000000 ? 1 : 0)}M` : `${Math.round(value / 1000)}K`;
const protocolLabel = (model: Model) => model.wireApi === 'messages' ? 'Messages' : model.wireApi === 'responses' ? 'Responses' : 'Chat Completions';
const reasoningEffortLabels: Record<ReasoningEffort, string> = { none: '无', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
const testModelStorageKey = 'modeldock.connection-test-models';
function savedTestModelIds(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(testModelStorageKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}
const authStageLabels: Record<NonNullable<AuthProgress['stage']>, string> = { 'device-code': '申请设备验证码', 'device-poll': '等待设备授权', 'token-exchange': '兑换登录凭据', 'account-info': '读取 GitHub 账号信息', refresh: '续期授权', discovery: '获取授权服务信息' };

export default function App({ initialSettings }: { initialSettings?: SettingsSnapshot }) {
  const bridge = typeof window !== 'undefined' ? window.modelDock : undefined;
  const [preferences, setPreferences] = useState<SettingsSnapshot | null>(initialSettings ?? null);
  const [page, setPage] = useState<Page>('tools');
  const [selectedTool, setSelectedTool] = useState<ToolId>('codex');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pendingActions = useRef(new Set<string>());
  const testRevisions = useRef<Record<string, number>>({});
  const snapshotRevision = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [sourceCategory, setSourceCategory] = useState<'api' | 'subscription'>('api');
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [copilotAccountChoices, setCopilotAccountChoices] = useState<AuthAccount[]>([]);
  const [copilotAccountError, setCopilotAccountError] = useState('');
  useEffect(() => {
    if (providerDraft?.kind !== 'copilot' || !bridge) return;
    let cancelled = false;
    setCopilotAccountChoices([]); setCopilotAccountError('');
    void bridge.authAccounts().then(accounts => { if (!cancelled) setCopilotAccountChoices(accounts.filter(account => account.kind === 'copilot')); })
      .catch(() => { if (!cancelled) setCopilotAccountError('已登录账号暂时无法读取；可以保存后重新登录 GitHub。'); });
    return () => { cancelled = true; };
  }, [providerDraft?.kind, bridge]);
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [modelDiscovery, setModelDiscovery] = useState<{ provider: Provider; initialResult?: DiscoveryResult } | null>(null);
  const [showProviderDuplicates, setShowProviderDuplicates] = useState(false);
  const [pendingBindings, setPendingBindings] = useState<Partial<Record<ToolId, ToolBinding>>>({});
  const [toolDeliveries, setToolDeliveries] = useState<Partial<Record<ToolId, ToolDelivery>>>({});
  const [toolSyncErrors, setToolSyncErrors] = useState<Partial<Record<ToolId, string>>>({});
  const [jetBrainsStatuses, setJetBrainsStatuses] = useState<Partial<Record<ToolId, JetBrainsStatus>>>({});
  const [toolRestoreLocations, setToolRestoreLocations] = useState<Partial<Record<ToolId, string>>>({});
  const [preview, setPreview] = useState<{ tool: ToolId; data: ConfigPreview } | null>(null);
  const [auth, setAuth] = useState<AuthProgress | null>(null);
  const authGeneration = useRef(0);
  const activeAuth = useRef<AuthProgress | null>(null);
  const updateAuth = (progress: AuthProgress | null) => { activeAuth.current = progress; setAuth(progress); };
  const [tests, setTests] = useState<Record<string, ConnectionResult>>({});
  const [testModelIds, setTestModelIds] = useState(savedTestModelIds);
  const [runningTestModels, setRunningTestModels] = useState<Record<string, Model>>({});
  useEffect(() => {
    try { window.localStorage.setItem(testModelStorageKey, JSON.stringify(testModelIds)); }
    catch { /* The current selection remains usable when browser storage is unavailable. */ }
  }, [testModelIds]);
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: () => Promise<void>; actionKey?: string; actionLabel?: string } | null>(null);
  const [port, setPort] = useState('18181');
  const [todayUsage, setTodayUsage] = useState<{ day: string; cost: number | null; partial: boolean } | null>(null);
  const observeUsage = useCallback((value: UsageSnapshot, query: UsageQuery) => {
    if (value.source !== 'client' || query.tool || query.providerId || query.modelId || query.status && query.status !== 'all') return;
    const day = usageRange(1).to;
    const bounds = usageDateRange(day, day);
    if (value.from !== bounds.from || value.to !== bounds.to) return;
    setTodayUsage({ day, cost: value.estimatedCostUsd, partial: value.costedRequests < value.requests });
  }, []);
  const [logFilter, setLogFilter] = useState('all');
  const data = snapshot ?? emptySnapshot;
  const isConnected = !!bridge && !!snapshot && !loadError;
  const enabledModels = data.models.filter(model => model.enabled).length;
  const bindingFor = (id: ToolId): ToolBinding => pendingBindings[id] ?? data.bindings.find(binding => binding.id === id) ?? ({ id, name: toolInfo[id].name, enabled: false, mode: 'direct', providerIds: [], modelIds: [], defaultModelId: '', note: '', ...(id === 'claude-code' ? { claudeDisableTelemetry: true } : {}) });
  const sourceIdsFor = (binding: ToolBinding) => binding.providerIds ?? [...new Set(data.models.filter(model => binding.modelIds.includes(model.id)).map(model => model.providerId))];
  const toolModels = (binding: ToolBinding) => resolveBindingModels(binding, data.models, data.providers).filter(model => binding.id !== 'codex' || model.wireApi === 'responses');
  // 修改点：与主进程共用模型筛选；Claude Code 复用来源现有模型，无需复制成 Messages 模型。
  const providerToolModels = (provider: Provider, tool: ToolId) => resolveBindingModels({ ...bindingFor(tool), enabled: true, mode: 'direct', providerIds: [provider.id], modelSelection: 'all', modelIds: [] }, data.models, data.providers).filter(model => tool !== 'codex' || model.wireApi === 'responses');
  const providerUnavailableReason = (provider: Provider, tool: ToolId) => !provider.enabled ? '供应商已停用'
    : !provider.hasSecret ? provider.kind === 'openai-compatible' ? '请先配置 API Key' : '请先授权账号'
      : !provider.baseUrl && provider.kind === 'openai-compatible' && !(tool === 'claude-code' && nativeClaudeBaseUrl(provider)) ? '请先填写服务地址'
        : !providerToolModels(provider, tool).length ? tool === 'claude-code' ? '请先添加并启用此来源的兼容模型' : tool === 'codex' && data.models.some(model => model.providerId === provider.id && model.enabled) ? 'Codex 需要 Responses 模型' : data.models.some(model => model.providerId === provider.id && model.enabled && model.wireApi === 'messages') ? '此工具暂不支持 Messages 模型' : '请先添加并启用模型' : '';
  const toolSignature = (binding: ToolBinding) => JSON.stringify({ binding: Object.fromEntries(Object.entries(binding).sort(([left], [right]) => left.localeCompare(right))), models: toolModels(binding), providers: data.providers.filter(provider => sourceIdsFor(binding).includes(provider.id)), port: data.gateway.port });
  const toolOperationPending = (id: ToolId) => pendingActions.current.has('delete') || [`tool-binding-${id}`, `apply-tool-${id}`, `export-tool-${id}`, `preview-${id}`, `restore-tool-${id}`].some(key => pendingActions.current.has(key));
  const anyToolOperationPending = () => [...pendingActions.current].some(key => /^(tool-binding-|apply-tool-|export-tool-|preview-|restore-tool-)/.test(key));
  const canApplyTool = (id: ToolId) => isJetBrainsTool(id) ? jetBrainsStatuses[id]?.canApply === true : id === 'codex' || id === 'claude-code' || id === 'opencode' || id === 'dsh' || id === 'vscode' || id === 'copilot';
  const addModel = (providerId: string) => setModelDraft(freshModel(providerId, presetById(data.providers.find(provider => provider.id === providerId)?.presetId)?.defaultWireApi ?? 'responses'));
  const editModel = (model: Model) => setModelDraft({ ...model, alias: modelLocalAlias(model) });
  const modelLabel = (model: Model) => modelDisplayLabel(model, data.providers.find(provider => provider.id === model.providerId));
  const notify = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(previous => [...previous.slice(-3), { id, message, tone }]);
    window.setTimeout(() => setToasts(previous => previous.filter(item => item.id !== id)), 6500);
  }, []);
  useEffect(() => {
    if (!initialSettings && bridge?.getSettings) void bridge.getSettings().then(setPreferences).catch(error => notify(errorText(error), 'error'));
    if (bridge?.rendererReady) void bridge.rendererReady();
  }, [bridge, notify]);
  useEffect(() => {
    const theme = preferences?.settings.theme ?? 'light';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(theme);
    update();
    if (theme === 'system') media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preferences?.settings.theme]);
  const savePreferences = async (patch: Partial<AppSettings>) => {
    if (!bridge?.saveSettings) throw new Error('桌面设置尚未连接，请退出旧版后打开新版程序。');
    setPreferences(await bridge.saveSettings(patch));
  };
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const revision = ++snapshotRevision.current;
    try { const next = await bridge.snapshot(); if (revision === snapshotRevision.current) { setSnapshot(next); setLoadError(''); } }
    catch (error) { if (revision === snapshotRevision.current) setLoadError(errorText(error)); }
  }, [bridge]);
  const loadJetBrainsStatus = useCallback(async (tool: ToolId) => {
    if (!isJetBrainsTool(tool) || !bridge?.jetBrainsStatus) return undefined;
    try {
      const status = await bridge.jetBrainsStatus(tool);
      setJetBrainsStatuses(previous => ({ ...previous, [tool]: status }));
      return status;
    } catch {
      const status: JetBrainsStatus = { tool, configDir: null, version: null, foundProfile: false, running: 'unknown', canApply: false, message: '无法确认 IDE 配置和运行状态。请在 IDE 中手工填写连接参数。' };
      setJetBrainsStatuses(previous => ({ ...previous, [tool]: status }));
      return status;
    }
  }, [bridge]);
  useEffect(() => {
    if (page !== 'tools' || !isJetBrainsTool(selectedTool)) return;
    void loadJetBrainsStatus(selectedTool);
    const timer = window.setInterval(() => void loadJetBrainsStatus(selectedTool), 5000);
    return () => window.clearInterval(timer);
  }, [page, selectedTool, loadJetBrainsStatus]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { if (snapshot) setPort(String(snapshot.gateway.port)); }, [snapshot?.gateway.port]);
  useEffect(() => {
    if (!bridge || !auth || auth.state !== 'pending') return;
    let stopped = false;
    let polling = false;
    const providerId = auth.providerId;
    const isCurrent = (generation: number) => !stopped && generation === authGeneration.current && activeAuth.current?.providerId === providerId && activeAuth.current.state === 'pending' && !pendingActions.current.has(`cancel-auth-${providerId}`);
    const timer = window.setInterval(async () => {
      const generation = authGeneration.current;
      if (polling || !isCurrent(generation)) return;
      polling = true;
      try {
        const progress = providerId === 'copilot:login' ? await bridge.copilotAuthProgress() : await bridge.authProgress(providerId);
        if (!isCurrent(generation) || !progress || progress.providerId !== providerId) return;
        updateAuth(progress);
        if (progress.state === 'complete') {
          notify(progress.message || '账号授权已完成');
          if (providerId !== 'copilot:login') void bridge.refreshAccountUsage(providerId).catch(() => {});
          await refresh();
        }
      } catch (error) { if (isCurrent(generation)) updateAuth({ ...activeAuth.current!, state: 'error', message: `无法读取授权进度：${errorText(error)}` }); }
      finally { polling = false; }
    }, 1800);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [bridge, auth?.providerId, auth?.state, notify, refresh]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (!bridge) { notify('桌面桥未连接，请在 ModelDock 桌面应用中完成操作。', 'info'); return; }
    if (pendingActions.current.has(key)) return;
    pendingActions.current.add(key);
    setBusy(previous => ({ ...previous, [key]: true }));
    try { await action(); }
    catch (error) { notify(errorText(error), 'error'); }
    finally { pendingActions.current.delete(key); setBusy(previous => ({ ...previous, [key]: false })); }
  };
  const copy = async (text: string, message = '已复制') => {
    try {
      if (bridge) await bridge.copyText(text);
      else await navigator.clipboard.writeText(text);
      notify(message);
    } catch { notify('无法写入剪贴板，请稍后重试或选中文本手动复制。', 'error'); }
  };
  const navigate = (next: Page) => { setPage(next); setSearch(''); setProviderFilter('all'); setSelectedProviderId(null); if (next === 'settings' && bridge?.getSettings) void bridge.getSettings().then(setPreferences).catch(error => notify(errorText(error), 'error')); };
  const selectTool = (id: ToolId) => { navigate('tools'); setSelectedTool(id); };
  const selectProvider = (id: string | null) => { navigate('providers'); setSelectedProviderId(id); };
  useEffect(() => {
    if (snapshot && selectedProviderId && !snapshot.providers.some(provider => provider.id === selectedProviderId)) setSelectedProviderId(null);
  }, [snapshot, selectedProviderId]);
  const editProvider = (provider: Provider) => setProviderDraft({ id: provider.id, name: provider.name, kind: provider.kind, presetId: provider.presetId ?? (provider.kind === 'codex' ? 'codex-subscription' : provider.kind === 'grok' ? 'grok-build' : provider.kind === 'copilot' ? 'copilot-subscription' : 'custom'), baseUrl: provider.baseUrl, enabled: provider.enabled, note: provider.note, apiKey: '', ...(provider.kind === 'openai-compatible' ? { messagesAuth: provider.messagesAuth ?? 'bearer', claudeBaseUrl: provider.claudeBaseUrl ?? '' } : {}), ...(provider.kind === 'copilot' ? { copilotAccountId: provider.copilotAccountId ?? '' } : {}) });
  const saveProvider = async () => {
    if (!providerDraft) return;
    if (!providerDraft.name.trim()) { notify('请为供应商取一个名称。', 'error'); return; }
    await run('save-provider', async () => {
      const isNew = !providerDraft.id;
      const payload: ProviderInput = { ...providerDraft, name: providerDraft.name.trim(), baseUrl: providerDraft.baseUrl.trim(), apiKey: providerDraft.apiKey || undefined, ...(providerDraft.kind === 'openai-compatible' ? { claudeBaseUrl: providerDraft.claudeBaseUrl?.trim() ?? '' } : {}) };
      const provider = await bridge!.saveProvider(payload);
      setToolDeliveries(previous => Object.fromEntries(Object.entries(previous).filter(([, delivery]) => !delivery?.providerIds.includes(provider.id))));
      testRevisions.current[provider.id] = (testRevisions.current[provider.id] ?? 0) + 1;
      setTests(previous => { const next = { ...previous }; delete next[provider.id]; return next; });
      setProviderDraft(null); await refresh();
      if (isNew) { setSourceCategory(provider.kind === 'openai-compatible' ? 'api' : 'subscription'); selectProvider(provider.id); }
      // 修改点：保存来源不强制获取模型目录；没有目录接口的厂商也可手动添加后测试推理。
      notify(provider.kind === 'openai-compatible' ? provider.baseUrl ? 'API 供应商已保存。可获取模型列表或手动添加模型，再测试连接。' : '供应商草稿已保存。补全地址并添加模型后即可测试连接。'
        : provider.hasSecret ? '订阅供应商已关联账号。可获取模型列表或手动添加模型，再测试连接。' : '订阅供应商已保存。登录账号后，可获取模型列表或手动添加模型。');
    });
  };
  const saveModel = async () => {
    if (!modelDraft) return;
    if (!modelDraft.providerId || !modelDraft.upstreamId.trim() || !modelDraft.alias.trim()) { notify('请选择供应商，并填写上游模型和模型简称。', 'error'); return; }
    if (!Number.isSafeInteger(modelDraft.contextWindow) || modelDraft.contextWindow < 0) { notify('上下文长度需要是非负整数；0 表示未设置。', 'error'); return; }
    await run('save-model', async () => {
      await bridge!.saveModel({ ...modelDraft, upstreamId: modelDraft.upstreamId.trim(), alias: modelDraft.alias.trim(), displayName: modelDraft.displayName.trim() || modelDraft.alias.trim() });
      setModelDraft(null); await refresh(); notify('模型已加入统一目录。');
    });
  };
  const toggleModel = async (model: Model, enabled: boolean) => run(`model-${model.id}`, async () => { await bridge!.saveModel({ ...model, enabled }); await refresh(); });
  const connectionTestModel = (providerId: string) => data.models.find(model => model.providerId === providerId && model.id === testModelIds[providerId]) ?? firstConnectionModel(providerId, data.models);
  const selectTestModel = (providerId: string, modelId: string) => {
    if (pendingActions.current.has(`test-${providerId}`) || !data.models.some(model => model.providerId === providerId && model.id === modelId)) return;
    setTestModelIds(previous => ({ ...previous, [providerId]: modelId }));
    setTests(previous => { const next = { ...previous }; delete next[providerId]; return next; });
  };
  const testProvider = async (provider: Provider) => {
    const model = connectionTestModel(provider.id);
    if (!model) { notify('此供应商还没有模型，请先添加模型后再测试连接。', 'info'); return; }
    await run(`test-${provider.id}`, async () => {
      const revision = (testRevisions.current[provider.id] ?? 0) + 1;
      testRevisions.current[provider.id] = revision;
      setRunningTestModels(previous => ({ ...previous, [provider.id]: model }));
      setTests(previous => { const next = { ...previous }; delete next[provider.id]; return next; });
      try {
        const result = await bridge!.testProvider(provider.id, { modelId: model.id });
        if (testRevisions.current[provider.id] === revision) setTests(previous => ({ ...previous, [provider.id]: result }));
      } finally {
        setRunningTestModels(previous => { const next = { ...previous }; delete next[provider.id]; return next; });
      }
    });
  };
  const login = async (provider: Provider) => run(`login-${provider.id}`, async () => {
    const generation = ++authGeneration.current;
    const initial: AuthProgress = { providerId: provider.id, state: 'pending', stage: provider.kind === 'grok' ? 'discovery' : 'device-code', message: provider.kind === 'grok' ? '正在获取 Grok 授权服务信息，完成后会申请设备验证码。' : provider.kind === 'copilot' ? '正在申请 GitHub 设备验证码，完成后会显示官方授权入口。' : '正在申请 Codex 设备验证码，完成后会显示官方授权入口。' };
    updateAuth(initial);
    const isCurrent = () => generation === authGeneration.current && activeAuth.current?.providerId === provider.id && activeAuth.current.state === 'pending';
    try {
      const result = await bridge!.beginLogin(provider.id);
      if (isCurrent()) updateAuth(result.providerId === provider.id ? result : { ...initial, state: 'error', message: '登录结果与所选供应商不匹配，请重新登录。' });
      await refresh();
    } catch (error) {
      if (isCurrent()) updateAuth({ ...activeAuth.current!, state: 'error', message: `无法启动登录：${errorText(error)}` });
    }
  });
  const closeAuth = () => {
    const current = activeAuth.current;
    if (!current) return;
    if (current.state !== 'pending' || !bridge) { ++authGeneration.current; updateAuth(null); return; }
    void run(`cancel-auth-${current.providerId}`, async () => {
      const generation = ++authGeneration.current;
      updateAuth({ ...current, message: '正在取消登录…' });
      const isCurrent = () => generation === authGeneration.current && activeAuth.current?.providerId === current.providerId;
      try {
        if (current.providerId === 'copilot:login') await bridge.cancelCopilotLogin();
        else await bridge.cancelLogin(current.providerId);
        if (isCurrent()) updateAuth(null);
        await refresh();
      } catch (error) {
        if (isCurrent()) updateAuth({ ...current, state: 'error', message: `取消登录未完成：${errorText(error)}` });
      }
    });
  };
  const loginCopilot = async () => run('copilot-account-login', async () => {
    const generation = ++authGeneration.current;
    const initial: AuthProgress = { providerId: 'copilot:login', state: 'pending', stage: 'device-code', message: '正在申请 GitHub 设备验证码，完成后会显示官方授权入口。' };
    updateAuth(initial);
    const isCurrent = () => generation === authGeneration.current && activeAuth.current?.providerId === initial.providerId && activeAuth.current.state === 'pending';
    try {
      const result = await bridge!.beginCopilotLogin();
      if (isCurrent()) updateAuth(result.providerId === initial.providerId ? result : { ...initial, state: 'error', message: '登录结果与所选平台不匹配，请重新登录。' });
      await refresh();
    } catch (error) { if (isCurrent()) updateAuth({ ...initial, state: 'error', message: `无法启动登录：${errorText(error)}` }); }
  });
  const persistInlineBinding = async (tool: ToolId, next: ToolBinding) => {
    setPendingBindings(previous => ({ ...previous, [tool]: next }));
    setToolRestoreLocations(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; });
    try {
      await bridge!.saveBinding(next);
      setSnapshot(previous => previous ? { ...previous, bindings: [...previous.bindings.filter(binding => binding.id !== tool), next] } : previous);
      // 修改点：JetBrains 的来源选择只保存绑定，IDE 文件必须由用户显式同步。
      if (!isJetBrainsTool(tool) && canApplyTool(tool)) await syncToolConfig(tool, next, true);
      else setToolSyncErrors(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; });
      await refresh();
    } finally { setPendingBindings(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; }); }
  };
  const saveInlineBinding = async (tool: ToolId, providerIds: string[], requestedDefault?: string) => {
    if (toolOperationPending(tool)) return;
    await run(`tool-binding-${tool}`, async () => {
      const current = bindingFor(tool);
      // 修改点：默认模型变化不改连接拓扑，也不扩大已保存的精确模型范围。
      if (requestedDefault !== undefined) {
        const models = toolModels({ ...current, enabled: true });
        await persistInlineBinding(tool, { ...current, enabled: models.length > 0, defaultModelId: models.some(model => model.id === requestedDefault) ? requestedDefault : models[0]?.id ?? '' });
        return;
      }
      const selectedProviders = [...new Set(providerIds)].filter(id => data.providers.some(provider => provider.id === id && (sourceIdsFor(current).includes(id) || !providerUnavailableReason(provider, tool))));
      const mode = current.mode ?? 'direct';
      const singleSource = mode === 'direct' || tool === 'claude-code' && mode !== 'aggregate';
      const nextProviderIds = singleSource ? selectedProviders.slice(-1) : selectedProviders;
      const candidates = toolModels({ ...current, mode, enabled: true, providerIds: nextProviderIds, modelSelection: 'all', modelIds: [] });
      const previousModels = new Set(toolModels({ ...current, enabled: true }).map(model => model.id));
      const exactSelection = current.modelSelection === 'selected' || current.modelSelection !== 'all' && current.modelIds.length > 0 || mode === 'aggregate';
      const draft: ToolBinding = { ...current, mode, providerIds: nextProviderIds, modelSelection: exactSelection ? 'selected' : 'all',
        modelIds: exactSelection ? candidates.filter(model => !sourceIdsFor(current).includes(model.providerId) || previousModels.has(model.id)).map(model => model.id) : [], enabled: true };
      const models = toolModels(draft);
      await persistInlineBinding(tool, { ...draft, enabled: models.length > 0, defaultModelId: models.some(model => model.id === current.defaultModelId) ? current.defaultModelId : models[0]?.id ?? '' });
    });
  };
  const saveToolMode = async (tool: ToolId, mode: 'direct' | 'aggregate') => {
    if (toolOperationPending(tool)) return;
    await run(`tool-binding-${tool}`, async () => {
      const current = bindingFor(tool);
      const previousProviderIds = sourceIdsFor(current);
      const preferredProvider = data.models.find(model => model.id === current.defaultModelId)?.providerId;
      // 修改点：关闭聚合时优先保留默认模型所在来源；开启时保留来源与精确范围。
      const keepProviderId = previousProviderIds.find(id => id === preferredProvider) ?? previousProviderIds[0];
      const providerIds = mode === 'direct' ? keepProviderId ? [keepProviderId] : [] : previousProviderIds;
      const selected = toolModels({ ...current, enabled: true }).filter(model => providerIds.includes(model.providerId));
      const exactSelection = mode === 'aggregate' || current.modelSelection === 'selected' || current.modelSelection !== 'all' && current.modelIds.length > 0;
      const draft: ToolBinding = { ...current, mode, providerIds, modelSelection: exactSelection ? 'selected' : 'all', modelIds: exactSelection ? selected.map(model => model.id) : [], enabled: true };
      const models = toolModels(draft);
      await persistInlineBinding(tool, { ...draft, enabled: models.length > 0, defaultModelId: models.some(model => model.id === current.defaultModelId) ? current.defaultModelId : models[0]?.id ?? '' });
    });
  };
  const saveAggregateModels = async (tool: ToolId, modelIds: string[]) => {
    if (toolOperationPending(tool)) return;
    await run(`tool-binding-${tool}`, async () => {
      const current = bindingFor(tool);
      const allowed = new Set(toolModels({ ...current, enabled: true, mode: 'aggregate', modelSelection: 'all', modelIds: [] }).map(model => model.id));
      const selected = [...new Set(modelIds)].filter(id => allowed.has(id));
      await persistInlineBinding(tool, { ...current, mode: 'aggregate', modelSelection: 'selected', modelIds: selected, enabled: selected.length > 0, defaultModelId: selected.includes(current.defaultModelId) ? current.defaultModelId : selected[0] ?? '' });
    });
  };
  const restoreOfficialConfig = (tool: ToolId) => {
    if (toolOperationPending(tool) || isJetBrainsTool(tool) && !jetBrainsStatuses[tool]?.canApply) return;
    const description = isJetBrainsTool(tool) ? '将恢复本次 ModelDock 同步前的 AI Assistant 模型设置。API Key 保存在 IDE 凭据存储中，需要在 IDE 内自行确认或更换。' : tool === 'codex' ? '将切回 Codex 官方 OpenAI / ChatGPT 模型入口，关闭自定义模型连接与聚合入口。' : `将清理 ${toolInfo[tool].name} 的自定义模型来源并恢复官方模型入口。`;
    setConfirm({ title: isJetBrainsTool(tool) ? `还原 ${toolInfo[tool].name} 同步前设置？` : `还原 ${toolInfo[tool].name} 官方配置？`, description: `${description} 需要修改的现有配置会先备份，账号登录、MCP、Skills、会话和其他设置保留。此工具在 ModelDock 中的供应商与模型选择会清空，全局供应商和模型保留。`, actionKey: `restore-tool-${tool}`, actionLabel: '确认还原', action: async () => {
      if (pendingActions.current.has('delete') || [`tool-binding-${tool}`, `apply-tool-${tool}`, `export-tool-${tool}`, `preview-${tool}`].some(key => pendingActions.current.has(key))) throw new Error('工具配置正在同步，请稍候再还原。');
      if (isJetBrainsTool(tool) && !(await loadJetBrainsStatus(tool))?.canApply) throw new Error('请先退出 IDE，并确认配置状态后再还原。');
      const location = await bridge!.restoreOfficialConfig(tool);
      setToolDeliveries(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; });
      setToolSyncErrors(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; });
      setToolRestoreLocations(previous => ({ ...previous, [tool]: location }));
      setPreview(previous => previous?.tool === tool ? null : previous);
      await refresh();
      if (isJetBrainsTool(tool)) await loadJetBrainsStatus(tool);
      notify(`${toolInfo[tool].name} ${isJetBrainsTool(tool) ? '已恢复同步前的设置；API Key 请在 IDE 中确认' : '已还原官方配置'}。`);
    } });
  };
  const saveVscodeScope = async (vscodeSyncScope: 'managed' | 'selected') => {
    if (toolOperationPending('vscode')) return;
    await run('tool-binding-vscode', async () => { await persistInlineBinding('vscode', { ...bindingFor('vscode'), vscodeSyncScope }); });
  };
  const saveCopilotScope = async (copilotSyncScope: 'managed' | 'selected') => {
    if (toolOperationPending('copilot')) return;
    await run('tool-binding-copilot', async () => { await persistInlineBinding('copilot', { ...bindingFor('copilot'), copilotSyncScope }); });
  };
  const saveDshScope = async (dshSyncScope: 'managed' | 'selected') => {
    if (toolOperationPending('dsh')) return;
    await run('tool-binding-dsh', async () => { await persistInlineBinding('dsh', { ...bindingFor('dsh'), dshSyncScope }); });
  };
  const saveClaudePrivacy = async (claudeDisableTelemetry: boolean) => {
    if (toolOperationPending('claude-code')) return;
    // 修改点：隐私选项与来源选择使用同一显式保存、备份及同步流程。
    await run('tool-binding-claude-code', async () => { await persistInlineBinding('claude-code', { ...bindingFor('claude-code'), claudeDisableTelemetry }); });
  };
  const deleteProvider = (provider: Provider) => {
    if (pendingActions.current.has('delete') || anyToolOperationPending()) return;
    const affectedTools = data.bindings.filter(binding => sourceIdsFor(binding).includes(provider.id)).map(binding => binding.id);
    setConfirm({ title: `删除全局供应商「${provider.name}」？`, description: '此供应商及关联模型会从全部工具选择中移除。受影响的自动同步工具将更新配置并备份；手动导入的工具需要重新导出。其他供应商及模型保留。', action: async () => {
      if (anyToolOperationPending()) throw new Error('工具配置正在同步，请稍候再删除供应商。');
      await bridge!.deleteProvider(provider.id);
      setToolDeliveries(previous => Object.fromEntries(Object.entries(previous).filter(([, delivery]) => !delivery?.providerIds.includes(provider.id))));
      setToolSyncErrors(previous => { const next = { ...previous }; for (const tool of affectedTools) delete next[tool]; return next; });
      setTests(previous => { const next = { ...previous }; delete next[provider.id]; return next; });
      await refresh(); notify('全局供应商及关联模型已删除。', 'info');
    } });
  };
  const showPreview = (tool: ToolId) => {
    if (toolOperationPending(tool)) return;
    return run(`preview-${tool}`, async () => { await bindingForDelivery(tool); setPreview({ tool, data: await bridge!.previewConfig(tool) }); });
  };
  const bindingForDelivery = async (tool: ToolId) => {
    const binding = bindingFor(tool);
    if (!binding.enabled) return binding;
    const models = toolModels(binding);
    const next = { ...binding, defaultModelId: models.some(model => model.id === binding.defaultModelId) ? binding.defaultModelId : models[0]?.id ?? '' };
    if (next.defaultModelId !== binding.defaultModelId) {
      await bridge!.saveBinding(next);
      setSnapshot(previous => previous ? { ...previous, bindings: [...previous.bindings.filter(item => item.id !== tool), next] } : previous);
    }
    return next;
  };
  const syncToolConfig = async (tool: ToolId, binding: ToolBinding, automatic: boolean) => {
    setToolDeliveries(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; });
    setToolSyncErrors(previous => { const remaining = { ...previous }; delete remaining[tool]; return remaining; });
    if ((tool === 'codex' || tool === 'claude-code') && sourceIdsFor(binding).length > 0 && !toolModels(binding).length && binding.enabled) {
      setToolSyncErrors(previous => ({ ...previous, [tool]: tool === 'claude-code' ? '选择已保存，但所选来源没有启用的兼容模型，本次没有更改外部配置。请添加兼容模型后重新同步。' : '选择已保存，但所选供应商没有可用于 Codex 的 Responses 模型，本次没有更改外部配置。请添加并启用 Responses 模型后重新同步。' }));
      return;
    }
    try {
      if (isJetBrainsTool(tool) && !(await loadJetBrainsStatus(tool))?.canApply) throw new Error('请先退出 IDE；运行状态未知时请手工填写连接参数。');
      const signature = toolSignature(binding);
      const location = await bridge!.applyConfig(tool);
      setToolDeliveries(previous => ({ ...previous, [tool]: { signature, kind: 'applied', location, providerIds: sourceIdsFor(binding) } }));
    } catch (error) {
      // 修改点：原生接口已给出具体错误，不能把权限、安装或钥匙串失败一律解释成应用未打开。
      const message = `选择已保存，${automatic ? '自动同步' : '同步'}未完成：${errorText(error)}`;
      setToolSyncErrors(previous => ({ ...previous, [tool]: message }));
      notify(message, 'error');
    }
  };
  const applyTool = async (tool: ToolId) => {
    if (toolOperationPending(tool)) return;
    await run(`apply-tool-${tool}`, async () => {
      const binding = await bindingForDelivery(tool);
      await syncToolConfig(tool, binding, false);
      await refresh();
      if (isJetBrainsTool(tool)) await loadJetBrainsStatus(tool);
    });
  };
  const exportTool = async (tool: ToolId) => {
    if (toolOperationPending(tool)) return;
    await run(`export-tool-${tool}`, async () => {
      const binding = await bindingForDelivery(tool);
      const signature = toolSignature(binding);
      const location = await bridge!.exportConfig(tool);
      if (!location) return;
      setToolDeliveries(previous => ({ ...previous, [tool]: { signature, kind: 'exported', location, providerIds: sourceIdsFor(binding) } }));
      notify(isJetBrainsTool(tool) ? `参考参数已导出到 ${location}。请在 IDE 中逐项填写，此 JSON 不能直接导入 IDE。` : `配置已导出到 ${location}，请在 ${toolInfo[tool].name} 中导入。`);
    });
  };
  const startGateway = async () => {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) { notify('请使用 1024–65535 之间的端口。', 'error'); return; }
    await run('gateway', async () => { const status = await bridge!.startGateway(value); await refresh(); setPreferences(await bridge!.getSettings()); if (!status.running) throw new Error(status.lastError || '本地服务未能启动，请查看错误提示。'); notify('本地服务已启动。'); });
  };
  const stopGateway = () => run('gateway', async () => { await bridge!.stopGateway(); await refresh(); notify('本地服务已停止。', 'info'); });
  const changeGatewayAutostart = (autoStartGateway: boolean) => run('gateway-settings', async () => {
    const value = Number(port);
    if (autoStartGateway && (!Number.isInteger(value) || value < 1024 || value > 65535)) throw new Error('请使用 1024–65535 之间的端口。');
    await savePreferences(autoStartGateway ? { autoStartGateway, gatewayPort: value } : { autoStartGateway });
    await refresh(); notify(autoStartGateway ? '已开启随应用启动本地服务，下次启动生效。' : '已关闭本地服务自动启动。', 'info');
  });
  const filteredModels = useMemo(() => data.models.filter(model => {
    const provider = data.providers.find(item => item.id === model.providerId);
    return (providerFilter === 'all' || providerFilter === model.providerId) && `${model.alias} ${model.upstreamId} ${model.displayName} ${provider?.name ?? ''}`.toLowerCase().includes(search.toLowerCase());
  }), [data.models, data.providers, search, providerFilter]);
  const categoryProviders = data.providers.filter(provider => sourceCategory === 'api' ? provider.kind === 'openai-compatible' : provider.kind !== 'openai-compatible');
  const filteredProviders = categoryProviders.filter(provider => `${provider.name} ${provider.baseUrl}`.toLowerCase().includes(search.toLowerCase()));
  const selectedProvider = data.providers.find(provider => provider.id === selectedProviderId);
  const currentJetBrains = isJetBrainsTool(selectedTool);
  const currentJetBrainsStatus = jetBrainsStatuses[selectedTool];
  const currentBinding = bindingFor(selectedTool);
  const currentSourceIds = sourceIdsFor(currentBinding);
  const currentModels = toolModels(currentBinding);
  const currentPolicy = bindingConnectionPolicy({ ...currentBinding, enabled: true }, data.models, data.providers);
  const currentAggregate = currentBinding.mode === 'aggregate';
  const currentLegacyMode = currentBinding.mode === 'auto' || !currentBinding.mode || currentBinding.mode === 'direct' && currentSourceIds.length > 1;
  const currentClaudeProvider = selectedTool === 'claude-code' && !currentAggregate ? data.providers.find(provider => provider.id === currentSourceIds[0]) : undefined;
  const currentClaudeKind = selectedTool === 'claude-code' ? currentAggregate ? 'local-managed' : currentPolicy.groups[0]?.connection : undefined;
  const currentClaudeNativeUrl = currentClaudeProvider && currentClaudeKind === 'direct-api' ? nativeClaudeBaseUrl(currentClaudeProvider) ?? currentClaudeProvider.baseUrl : '';
  const currentClaudeLabel = currentAggregate ? '本机聚合 Messages 接口' : currentClaudeKind === 'direct-api' ? 'API Messages 接口直连' : currentClaudeProvider?.kind !== 'openai-compatible' && currentClaudeProvider ? '通过本机服务使用订阅' : currentClaudeProvider ? '通过本机服务连接 API' : 'API 或订阅来源';
  const currentDefault = currentModels.find(model => model.id === currentBinding.defaultModelId) ?? currentModels[0];
  const currentDelivery = toolDeliveries[selectedTool]?.signature === toolSignature(currentBinding) ? toolDeliveries[selectedTool] : undefined;
  const currentJetBrainsConnection = currentJetBrains ? jetBrainsConnectionParameters({ ...currentBinding, enabled: true }, data.models, data.providers, data.gateway.port) : undefined;
  const currentToolBusy = !!busy.delete || !!busy[`tool-binding-${selectedTool}`] || !!busy[`apply-tool-${selectedTool}`] || !!busy[`export-tool-${selectedTool}`] || !!busy[`preview-${selectedTool}`] || !!busy[`restore-tool-${selectedTool}`];
  const currentCanApply = canApplyTool(selectedTool);
  const currentCanClear = selectedTool !== 'codex' || currentSourceIds.length === 0 || currentBinding.modelSelection === 'selected' && !currentModels.length;
  const currentPreferenceLabel = currentJetBrains ? '核心与轻量功能模型' : selectedTool === 'vscode' || selectedTool === 'copilot' ? 'ModelDock 首选模型' : '默认模型';
  const currentCleared = currentDelivery?.kind === 'applied' && !currentModels.length;
  const currentRestored = !!toolRestoreLocations[selectedTool] && !currentBinding.enabled && !currentSourceIds.length;
  const aggregateCandidates = toolModels({ ...currentBinding, enabled: true, mode: 'aggregate', modelSelection: 'all', modelIds: [] });
  const currentSingleProvider = !currentAggregate && !currentLegacyMode || selectedTool === 'claude-code' && !currentAggregate;
  const currentOnlySelected = selectedTool === 'vscode' ? (currentBinding.vscodeSyncScope ?? 'selected') === 'selected' : selectedTool === 'dsh' ? (currentBinding.dshSyncScope ?? 'selected') === 'selected' : selectedTool === 'copilot' && (currentBinding.copilotSyncScope ?? 'selected') === 'selected';
  const availableToolProviderIds = data.providers.filter(provider => !providerUnavailableReason(provider, selectedTool)).map(provider => provider.id);
  const toolProviders = data.providers.filter(provider => `${provider.name} ${provider.baseUrl}`.toLowerCase().includes(search.toLowerCase()));
  const detailTitle = page === 'tools' ? `${toolInfo[selectedTool].name} 供应商` : page === 'providers' ? selectedProvider?.name ?? '聚合供应商' : pageMeta[page].label;
  const draftPreset = providerDraft ? presetById(providerDraft.presetId) : undefined;
  const duplicateProviderGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const provider of data.providers.filter(provider => provider.kind === 'openai-compatible')) {
      const identity = providerIdentity(provider); counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    return [...counts.values()].filter(count => count > 1).length;
  }, [data.providers]);
  const draftExistingProviders = providerDraft && !providerDraft.id && providerDraft.kind === 'openai-compatible' ? data.providers.filter(provider => provider.kind === 'openai-compatible' && providerIdentity(provider) === providerIdentity(providerDraft)) : [];
  const modelDraftProvider = modelDraft ? data.providers.find(provider => provider.id === modelDraft.providerId) : undefined;
  const modelRoutePreview = (() => {
    if (!modelDraft?.alias.trim() || !modelDraftProvider) return { alias: '', error: '' };
    try { return { alias: suggestModelAlias(modelDraft.providerId, modelDraft.alias, data.models, modelDraft.id), error: '' }; }
    catch (error) { return { alias: '', error: errorText(error) }; }
  })();
  const logs = data.logs.filter(log => logFilter === 'all' || (logFilter === 'error' ? log.status >= 400 || log.status === 0 : log.status >= 200 && log.status < 400));

  const addProviderActions = <div className="add-provider-actions" role="group" aria-label="添加模型供应商"><button data-action="add-api-provider" className="button small primary" onClick={() => setProviderDraft(freshProvider('deepseek'))}><Plus size={15} />添加 API</button><button data-action="add-subscription-provider" className="button small secondary" onClick={() => setProviderDraft(freshProvider('codex-subscription'))}><Sparkles size={15} />添加订阅</button></div>;
  const providerStatus = (provider: Provider) => !provider.enabled ? '已停用' : provider.kind === 'openai-compatible' && !provider.baseUrl ? '待填地址' : provider.authStatus === 'ready' ? '凭据已保存' : provider.authStatus === 'signing-in' ? '正在登录' : provider.authStatus === 'error' ? '需要检查' : '待授权';
  const providerRow = (provider: Provider, forTool = false) => {
    const selected = forTool && currentSourceIds.includes(provider.id);
    const providerModels = data.models.filter(model => model.providerId === provider.id);
    const defaultTestModel = connectionTestModel(provider.id);
    const testResult = tests[provider.id];
    const testing = !!busy[`test-${provider.id}`];
    const unavailableReason = providerUnavailableReason(provider, selectedTool);
    return <article className={`provider-row ${selected ? 'selected' : ''} ${!provider.enabled ? 'muted-card' : ''}`} key={provider.id} data-provider-id={provider.id}>
      {forTool && <label className="provider-inline-select" title={selected ? '取消选择此供应商' : unavailableReason || '选择此供应商'}><input type="checkbox" data-action="select-tool-provider" data-tool-id={selectedTool} data-provider-id={provider.id} checked={selected} disabled={!bridge || currentToolBusy || !selected && !!unavailableReason} aria-label={`为 ${toolInfo[selectedTool].name} 选择 ${provider.name}`} onChange={event => void saveInlineBinding(selectedTool, event.target.checked ? [...currentSourceIds, provider.id] : currentSourceIds.filter(id => id !== provider.id))} /><span className="sr-only">{provider.name}</span></label>}
      <span className={`provider-monogram ${provider.kind}`}>{providerKinds[provider.kind].symbol}</span>
      <div className="provider-row-main">
        <div className="provider-row-title"><h3>{provider.name}</h3><span className={`badge ${!provider.enabled || (provider.kind === 'openai-compatible' && !provider.baseUrl) ? 'neutral' : provider.authStatus === 'ready' ? 'positive' : provider.authStatus === 'error' ? 'negative' : 'warning'}`}><span className="status-dot" />{providerStatus(provider)}</span></div>
        <div className="provider-row-meta"><span className="provider-address" title={provider.baseUrl}>{provider.baseUrl || (provider.kind === 'openai-compatible' ? '服务地址待填写' : providerKinds[provider.kind].title)}</span><span>{data.models.filter(model => model.providerId === provider.id).length} 个模型</span></div>
        {forTool && provider.kind !== 'openai-compatible' && !unavailableReason && <div className="provider-selection-hint">订阅来源由本机入口管理授权</div>}{forTool && !!unavailableReason && <div className="provider-selection-hint">{unavailableReason}{selected ? '，已保存的选择可取消' : ''}</div>}
        {testing ? <div className="test-result testing" role="status"><span>正在测试：{runningTestModels[provider.id]?.upstreamId}…</span></div> : testResult && <div data-connection-result data-success={testResult.ok} data-outcome={testResult.outcome} data-status-code={testResult.statusCode} data-tested-model={testResult.testedModel} data-wire-api={testResult.wireApi} data-duration-ms={testResult.durationMs} className={`test-result ${testResult.ok ? 'ok' : 'failed'}`} role={testResult.ok ? 'status' : 'alert'}><span>上次测试：{testResult.testedModel ? `${testResult.testedModel} · ` : ''}{testResult.message}</span><small>{testResult.statusCode !== undefined && `HTTP ${testResult.statusCode}`}{testResult.statusCode !== undefined && testResult.durationMs !== undefined && ' · '}{testResult.durationMs !== undefined && `${Math.round(testResult.durationMs)} ms`}</small></div>}
      </div>
      <div className="provider-row-side">
      <div className="provider-row-actions">
        {provider.kind !== 'openai-compatible' && <button className="icon-button" disabled={busy[`login-${provider.id}`]} title={provider.hasSecret ? '重新登录' : '登录账号'} aria-label={`${provider.hasSecret ? '重新登录' : '登录'} ${provider.name}`} onClick={() => void login(provider)}><BusyIcon active={!!busy[`login-${provider.id}`]}><KeyRound size={16} /></BusyIcon></button>}
        <button data-action="test-provider" className="icon-button" disabled={testing || !defaultTestModel} title={defaultTestModel ? `测试连接：${defaultTestModel.upstreamId}` : '请先添加模型后再测试连接'} aria-label={`检测 ${provider.name} 连接`} onClick={() => void testProvider(provider)}><BusyIcon active={testing}><Activity size={16} /></BusyIcon></button>
        <button className="icon-button" aria-label={`编辑 ${provider.name}`} title="编辑供应商" onClick={() => editProvider(provider)}><Pencil size={16} /></button>
        <button className="icon-button danger-icon" data-action="delete-provider" disabled={!bridge || !!busy.delete || anyToolOperationPending()} title="删除全局供应商及关联模型" aria-label={`删除 ${provider.name}`} onClick={() => deleteProvider(provider)}><Trash2 size={15} /></button>
      </div>
      <label className={`provider-test-default ${testing || !defaultTestModel ? 'disabled' : ''}`} data-default-test-model data-model-id={defaultTestModel?.id} title={defaultTestModel ? `点击切换测试模型：${defaultTestModel.upstreamId}` : '此供应商尚未添加模型'}>
        <span>默认测试模型</span><code>{defaultTestModel?.upstreamId || '尚未添加模型'}</code><ChevronDown size={12} />
        <select data-action="select-test-model" aria-label={`选择 ${provider.name} 的测试模型`} value={defaultTestModel?.id ?? ''} disabled={testing || !defaultTestModel} onChange={event => selectTestModel(provider.id, event.target.value)}>
          {!providerModels.length && <option value="">尚未添加模型</option>}
          {providerModels.map(model => <option key={model.id} value={model.id}>{model.upstreamId} · {protocolLabel(model)}{!model.enabled ? '（已停用）' : ''}</option>)}
        </select>
      </label>
      </div>
    </article>;
  };
  const modelTable = (models: Model[]) => <div className="table-scroll"><table className="models-table">
    <thead><tr><th>模型 / 接口 ID</th><th>供应商 / 上游模型</th><th>接口</th><th>上下文</th><th>能力</th><th>启用</th><th><span className="sr-only">操作</span></th></tr></thead>
    <tbody>{models.map(model => <tr key={model.id} data-model-id={model.id}>
      <td><div className="model-name"><span className="model-icon"><Box size={17} /></span><div><strong>{modelLabel(model)}</strong><code title={model.alias}>{model.alias}</code></div></div></td>
      <td><div className="table-provider"><strong>{data.providers.find(provider => provider.id === model.providerId)?.name ?? '供应商已移除'}</strong><code title={model.upstreamId}>{model.upstreamId}</code></div></td>
      <td><span className="protocol-tag">{protocolLabel(model)}</span></td><td><span className="context-tag">{contextLabel(model.contextWindow)}</span></td>
      <td><div className="capability-tags">{model.tools && <span title="工具调用"><Terminal size={13} /></span>}{model.vision && <span title="图片输入"><Sparkles size={13} /></span>}{!model.tools && !model.vision && <span className="text-capability">文本</span>}</div></td>
      <td><Toggle checked={model.enabled} onChange={enabled => void toggleModel(model, enabled)} label={`${model.enabled ? '停用' : '启用'} ${model.alias}`} disabled={busy[`model-${model.id}`]} /></td>
      <td><div className="row-actions"><button data-action="edit-model" className="icon-button" aria-label={`编辑 ${model.alias}`} title="编辑模型" onClick={() => editModel(model)}><Pencil size={14} /></button><button className="icon-button danger-icon" aria-label={`删除 ${model.alias}`} title="删除模型" onClick={() => setConfirm({ title: `删除「${modelLabel(model)}」？`, description: '模型会从统一目录移除，使用它的工具配置需要重新保存。', action: async () => { await bridge!.deleteModel(model.id); await refresh(); notify('模型已删除。', 'info'); } })}><Trash2 size={14} /></button></div></td>
    </tr>)}</tbody>
  </table></div>;
  const modelEmpty = (providerId?: string) => <EmptyState compact icon={<Layers3 size={25} />} title="还没有模型" description="添加上游模型；聚合列表会按供应商区分同名模型。" action={<button className="button primary" onClick={() => providerId || data.providers.length ? addModel(providerId ?? data.providers[0].id) : selectProvider(null)}><Plus size={15} />{providerId || data.providers.length ? '添加模型' : '添加供应商'}</button>} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => selectTool('codex')} aria-label="ModelDock 首页"><span className="brand-mark"><img src={brandIcon} alt="" data-app-brand-icon /></span><span>ModelDock</span></button>
      <div className="sidebar-navigation" data-sidebar-navigation>
      <nav className="sidebar-group sidebar-tools" data-sidebar-scroll="tools" aria-label="工具导航"><div className="sidebar-group-label" data-sidebar-label="tools"><span>工具</span><span>{toolIds.length}</span></div>
          {toolIds.map(id => <button key={id} data-page="tools" data-tool-id={id} className={`nav-item agent-nav ${page === 'tools' && selectedTool === id ? 'active' : ''}`} aria-current={page === 'tools' && selectedTool === id ? 'page' : undefined} onClick={() => selectTool(id)}><ToolIcon tool={id} /><span>{id === 'dsh' ? 'DSH' : id === 'copilot' ? 'Copilot app' : toolInfo[id].name}</span>{bindingFor(id).enabled && <span className="status-dot green" />}</button>)}
      </nav>
        {/* 修改点：全局供应商的新增入口固定在左侧分组，不随详情页变化。 */}
        <nav className="sidebar-group sidebar-scroll sidebar-providers" data-sidebar-scroll="providers" aria-label="模型供应商导航"><div className="sidebar-group-label sidebar-provider-heading" data-sidebar-label="providers"><span>模型供应商</span>{addProviderActions}</div>
          <button data-page="providers" data-source="aggregate" className={`nav-item source-nav ${page === 'providers' && !selectedProviderId ? 'active' : ''}`} aria-current={page === 'providers' && !selectedProviderId ? 'page' : undefined} onClick={() => selectProvider(null)}><Waypoints size={18} /><span>聚合供应商</span><span className="nav-count">{data.providers.length}</span></button>
          {data.providers.map(provider => <button key={provider.id} data-source-id={provider.id} className={`nav-item source-nav ${page === 'providers' && selectedProviderId === provider.id ? 'active' : ''}`} aria-current={page === 'providers' && selectedProviderId === provider.id ? 'page' : undefined} title={provider.name} onClick={() => selectProvider(provider.id)}><span className={`nav-monogram ${provider.kind}`}>{providerKinds[provider.kind].symbol}</span><span>{provider.name}</span><span className={`status-dot ${provider.authStatus === 'ready' && provider.enabled ? 'green' : ''}`} /></button>)}
        </nav>
      </div>
      <nav className="sidebar-functions" aria-label="功能导航">
        <button data-page="mcp" className={`nav-item ${page === 'mcp' ? 'active' : ''}`} aria-current={page === 'mcp' ? 'page' : undefined} onClick={() => navigate('mcp')}><Server size={18} /><span>MCP 管理</span></button>
        <button data-page="skills" className={`nav-item ${page === 'skills' ? 'active' : ''}`} aria-current={page === 'skills' ? 'page' : undefined} onClick={() => navigate('skills')}><BookOpen size={18} /><span>Skills 管理</span></button>
        <button data-page="auth" className={`nav-item ${page === 'auth' ? 'active' : ''}`} aria-current={page === 'auth' ? 'page' : undefined} onClick={() => navigate('auth')}><KeyRound size={18} /><span>授权中心</span></button>
        <button data-page="usage" className={`nav-item ${page === 'usage' ? 'active' : ''}`} aria-current={page === 'usage' ? 'page' : undefined} onClick={() => navigate('usage')}><BarChart3 size={18} /><span>用量统计</span>{todayUsage && todayUsage.day === usageRange(1).to && <small className="usage-today-badge" title={`客户端会话 ${todayUsage.day} 的${todayUsage.partial ? '已知部分' : '全部'}估算费用，按当前设置单价计算；不代表账单`}>{todayUsage.cost === null ? '今日费用未知' : `今日≈$${todayUsage.cost.toFixed(todayUsage.cost < 0.01 ? 4 : 2)}`}</small>}</button>
        <button data-page="models" className={`nav-item ${page === 'models' ? 'active' : ''}`} aria-current={page === 'models' ? 'page' : undefined} onClick={() => navigate('models')}><Layers3 size={18} /><span>模型目录</span><span className="nav-count">{data.models.length}</span></button>
        <button data-page="service" className={`nav-item ${page === 'service' ? 'active' : ''}`} aria-current={page === 'service' ? 'page' : undefined} onClick={() => navigate('service')}><Activity size={18} /><span>服务与日志</span><span className={`status-dot ${data.gateway.running ? 'green' : ''}`} /></button>
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-local-info"><strong>本地工作空间</strong><small title={`${data.version ? `v${data.version}` : '桌面预览'} · 127.0.0.1`}>{data.version ? `v${data.version}` : '桌面预览'} · 127.0.0.1</small></div><div className="sidebar-bottom-actions"><button data-page="settings" className={`sidebar-icon sidebar-settings ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} title="设置" aria-label="打开设置" onClick={() => navigate('settings')}><Settings2 size={18} /></button><button className="sidebar-icon" title="打开数据目录" aria-label="打开数据目录" onClick={() => void run('open-dir', () => bridge!.openDataDir())}><FolderOpen size={17} /></button></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><strong>{detailTitle}</strong></div>{page === 'models' && <div className="topbar-actions"><button className="button small primary" onClick={() => data.providers.length ? addModel(data.providers[0].id) : selectProvider(null)}><Plus size={15} />添加模型</button></div>}<div className="topbar-right"><span className={`bridge-status ${isConnected ? 'connected' : ''}`} title={isConnected ? '桌面已连接' : loadError || '桌面未连接'}><span className="status-dot" />{!bridge ? '界面预览' : loadError ? '连接异常' : !snapshot ? '读取配置中' : '已连接'}</span><span className={`local-status ${data.gateway.running ? 'running' : ''}`}><Radio size={14} />{data.gateway.running ? '服务运行中' : '服务未启动'}</span><button className="icon-button" aria-label="刷新本机配置" title="刷新" onClick={() => void run('refresh', refresh)}><RefreshCw size={15} className={busy.refresh ? 'spin' : ''} /></button></div></header>
      <main className="main-content">
        {(!bridge || loadError) && <div className="bridge-banner"><Unplug size={17} /><span>{!bridge ? '当前为界面预览。桌面桥未连接，未读取任何本机账号或模型。' : `暂时无法读取本机配置：${loadError}`}</span>{!!bridge && <button onClick={() => void refresh()}>重试<RefreshCw size={13} /></button>}</div>}
        {page === 'mcp' && <McpPanel api={bridge} notify={notify} />}
        {page === 'skills' && <SkillsPanel api={bridge} notify={notify} />}
        {page === 'auth' && <AuthPanel api={bridge} notify={notify} onChanged={refresh} onCopilotLogin={loginCopilot} onLogin={id => run('auth-center-login', async () => { const latest = await bridge!.snapshot(); setSnapshot(latest); const provider = latest.providers.find(item => item.id === id); if (!provider) throw new Error('账号来源不存在，请刷新。'); await login(provider); })} />}
        {page === 'usage' && <UsagePanel api={bridge} notify={notify} models={data.models} providers={data.providers} onSnapshot={observeUsage} />}
        {page === 'settings' && <SettingsPanel api={bridge} snapshot={preferences} onSave={savePreferences} notify={notify} dataDir={data.dataDir} version={data.version} />}

        {page === 'tools' && <>
          <div className="tool-detail-summary tool-inline-summary" data-tool-binding={selectedTool} data-claude-connection-kind={currentClaudeKind} data-connection-mode={currentBinding.mode} data-selected-provider-count={currentSourceIds.length} data-selected-model-count={currentModels.length}>
            <div className="tool-connection-heading"><span className="eyebrow">{selectedTool === 'claude-code' ? currentClaudeLabel : currentAggregate ? '本机聚合模型入口' : currentLegacyMode ? '沿用已有连接方式' : currentJetBrainsConnection?.kind === 'local-managed' ? '单来源 · 本机协议桥' : '单来源连接'}</span><button className="button small secondary" data-action="restore-official-tool-config" disabled={!bridge || currentToolBusy || currentJetBrains && !currentJetBrainsStatus?.canApply} title={currentJetBrains ? currentJetBrainsStatus?.message ?? '正在确认 IDE 状态' : undefined} onClick={() => restoreOfficialConfig(selectedTool)}><BusyIcon active={!!busy[`restore-tool-${selectedTool}`]}><RotateCcw size={14} /></BusyIcon>{currentJetBrains ? '还原同步前设置' : '还原官方配置'}</button></div>
            <div className="connection-mode-controls tool-aggregate-option"><label><input type="checkbox" data-action="tool-use-aggregate" data-tool-id={selectedTool} checked={currentAggregate} disabled={!bridge || currentToolBusy} onChange={event => void saveToolMode(selectedTool, event.target.checked ? 'aggregate' : 'direct')} /><span>使用聚合接口</span></label><small>{currentAggregate ? '统一连接 ModelDock 本机入口，可选择多家来源并逐个启用模型。' : currentLegacyMode ? '当前保留已有连接；开启聚合后可使用一个本机入口，取消聚合后可单独连接一家来源。' : '单独连接一家来源，选择另一家会替换当前来源；API 优先直连，订阅由本机管理授权。'}</small>{currentLegacyMode && <small className="legacy-connection-note">当前沿用已有连接方式和模型范围；点击此选项后采用新的单来源或聚合方式。</small>}</div>
            <div className="tool-inline-heading"><ToolIcon tool={selectedTool} /><div><strong>{toolInfo[selectedTool].subtitle}</strong><span>{currentSourceIds.length} 家供应商 · {currentModels.length} 个可用模型</span></div><span className={`badge ${currentRestored || currentDelivery?.kind === 'applied' ? 'positive' : toolSyncErrors[selectedTool] || currentSourceIds.length ? 'warning' : 'neutral'}`} data-tool-application-status data-tool-application-state={currentRestored ? 'official' : currentCleared ? 'cleared' : currentDelivery?.kind === 'applied' ? 'synced' : toolSyncErrors[selectedTool] ? 'error' : 'saved'}>{busy[`restore-tool-${selectedTool}`] ? '正在还原官方配置' : currentRestored ? currentJetBrains ? '已恢复同步前设置' : '已还原官方配置' : busy[`tool-binding-${selectedTool}`] ? currentCanApply && !currentJetBrains ? '正在自动同步' : '正在保存选择' : busy[`apply-tool-${selectedTool}`] ? '正在同步' : toolSyncErrors[selectedTool] ? '选择已保存，同步未完成' : currentCleared ? '来源已清理' : currentDelivery?.kind === 'applied' ? currentJetBrains ? '设置文件已同步，API Key 需 IDE 确认' : '本次选择已同步' : currentDelivery?.kind === 'exported' ? currentJetBrains ? '参考参数已导出' : '已导出，待工具导入' : currentSourceIds.length ? currentJetBrains ? '选择已保存，待接入 IDE' : currentCanApply ? '已保存，可重新同步' : '选择已保存，待导出' : '未选择供应商'}</span></div>
            <div className="tool-inline-controls"><label>{currentPreferenceLabel}<select aria-label={`${toolInfo[selectedTool].name} ${currentPreferenceLabel}`} data-action="tool-default-model" disabled={!bridge || currentToolBusy || !currentModels.length} value={currentDefault?.id ?? ''} onChange={event => void saveInlineBinding(selectedTool, currentSourceIds, event.target.value)}>{!currentModels.length && <option value="">未设置</option>}{currentModels.map(model => <option key={model.id} value={model.id}>{selectedTool === 'claude-code' ? `${modelLabel(model)} · ${currentClaudeKind === 'direct-api' ? model.upstreamId : model.alias}` : modelLabel(model)}</option>)}</select></label>{!currentJetBrains && <div className="tool-inline-actions"><button className="button small secondary" data-action="preview-tool-config" disabled={!bridge || currentToolBusy || (!currentModels.length && !currentCanClear)} title="预览所选供应商的配置" onClick={() => void showPreview(selectedTool)}><BusyIcon active={!!busy[`preview-${selectedTool}`]}><FileCode2 size={14} /></BusyIcon>预览配置</button>{currentCanApply ? <button className="button small primary" data-action="apply-tool-config" disabled={!bridge || currentToolBusy || (!currentModels.length && !currentCanClear)} title={selectedTool === 'dsh' ? currentOnlySelected ? currentModels.length ? '同步所选供应商并隐藏 DSH 原有模型来源，保留账号授权并备份原文件' : '清空 DSH 显示的模型来源，保留账号授权；关闭仅显示选项可恢复原来源' : currentModels.length ? '同步 ModelDock 来源并恢复 DSH 原有模型来源，保留账号授权' : '清理 ModelDock 来源并恢复 DSH 原有模型来源' : selectedTool === 'copilot' ? currentOnlySelected ? '仅同步所选自定义模型来源，保留 GitHub 内置模型、账号、MCP 和会话历史' : currentModels.length ? '通过正在运行的 Copilot app 重新同步 ModelDock 来源' : '从 Copilot app 模型注册表移除 ModelDock 来源，保留其他来源' : currentModels.length ? '重新写入工具配置，保留其他设置并备份原文件' : selectedTool === 'vscode' && (currentBinding.vscodeSyncScope ?? 'selected') === 'selected' ? '清理此 VS Code 配置的自定义供应商，保留内置模型并备份原文件' : '从此工具配置中移除 ModelDock 管理的来源'} onClick={() => void applyTool(selectedTool)}><BusyIcon active={!!busy[`apply-tool-${selectedTool}`]}><CheckCheck size={14} /></BusyIcon>重新同步</button> : <button className="button small primary" data-action="export-tool-config" disabled={!bridge || currentToolBusy || !currentModels.length} onClick={() => void exportTool(selectedTool)}><BusyIcon active={!!busy[`export-tool-${selectedTool}`]}><ArrowDownToLine size={14} /></BusyIcon>导出配置</button>}</div>}</div>
            {selectedTool === 'claude-code' && <div className="vscode-scope-option claude-privacy-option"><label><input type="checkbox" data-action="claude-disable-telemetry" checked={currentBinding.claudeDisableTelemetry !== false} disabled={!bridge || currentToolBusy} onChange={event => void saveClaudePrivacy(event.target.checked)} /><span>关闭遥测和非必要联网</span></label><small>默认开启，关闭遥测、错误报告和自动更新；模型请求继续使用所选来源。WebFetch 仍可能进行安全检查；此选项不隔离本地文件，也不限制 MCP 或插件联网。同步后重启 Claude Code 生效。</small></div>}
            {selectedTool === 'vscode' && <div className="vscode-scope-option"><label><input type="checkbox" data-action="vscode-only-selected" checked={(currentBinding.vscodeSyncScope ?? 'selected') === 'selected'} disabled={!bridge || currentToolBusy} onChange={event => void saveVscodeScope(event.target.checked ? 'selected' : 'managed')} /><span>仅保留所选供应商</span></label><small>开启后清理其他自定义供应商；内置模型仍由 VS Code 控制。原文件会自动备份。</small></div>}
            {selectedTool === 'copilot' && <div className="vscode-scope-option"><label><input type="checkbox" data-action="copilot-only-selected" checked={(currentBinding.copilotSyncScope ?? 'selected') === 'selected'} disabled={!bridge || currentToolBusy} onChange={event => void saveCopilotScope(event.target.checked ? 'selected' : 'managed')} /><span>仅保留所选供应商</span></label><small>开启后清理未选中的自定义模型来源；保留 GitHub 内置模型、账号、MCP 和会话历史。同步前保存恢复记录。</small></div>}
            {selectedTool === 'dsh' && <div className="vscode-scope-option"><label><input type="checkbox" data-action="dsh-only-selected" checked={(currentBinding.dshSyncScope ?? 'selected') === 'selected'} disabled={!bridge || currentToolBusy} onChange={event => void saveDshScope(event.target.checked ? 'selected' : 'managed')} /><span>仅显示所选供应商</span></label><small>开启后停用并隐藏 DSH 原有模型来源，保留账号授权；关闭此选项可恢复原来源。同步前自动备份。</small></div>}
            {!currentJetBrains && <p className="tool-inline-explanation">{selectedTool === 'copilot' ? '勾选、更改连接方式或首选模型后自动同步到正在运行的 Copilot app，无需重启。同步前保存恢复记录。' : currentCanApply ? '勾选、更改连接方式或默认模型后自动写入工具配置，已有文件自动备份。' : '勾选后保存来源，需要导出配置并在工具中导入。'}{currentAggregate ? ` ${toolInfo[selectedTool].name} 使用一个本机聚合入口，按模型别名调用所选来源；未启用模型不会对该工具开放。` : currentLegacyMode ? ' 当前沿用已有连接方式；点击「使用聚合接口」可切换为聚合，再取消可切换为单来源。' : ' 一次使用一家 API 或账号订阅来源；勾选另一家会替换当前来源。API 使用上游地址和真实模型 ID，订阅及需要协议转换的来源使用本机入口和模型别名。'}{selectedTool === 'claude-code' && <> {currentClaudeKind === 'direct-api' ? 'API 使用官方或指定的 Messages 入口及原有 API Key。' : 'Messages 本机入口使用本机 Key，账号令牌保留在 ModelDock。'} 默认模型及角色映射使用对应连接的模型 ID。{currentAggregate ? ' 聚合模式同步已启用模型列表，可在 Claude Code 中切换模型。' : ' 单来源模式同步所选默认模型及角色映射。'} 同步后重启 Claude Code 终端；VS Code 扩展需另配环境。</>}{currentPolicy.groups.some(group => group.connection === 'local-managed') && ' 使用本机入口期间请保持 ModelDock 运行；同步时会按需启动本地服务。'}{selectedTool === 'codex' && ' Codex 仅提供 Responses 模型。'}{selectedTool === 'dsh' && <> 默认模型用于新会话。{currentOnlySelected ? ' 仅显示当前所选来源，原有授权仍保留。选择 DeepSeek 官方 API 时，同步为旧 DeepSeek 会话保留同模型的兼容调用，不更改聊天内容或模型选择。旧模型未包含在所选 DeepSeek 来源时，请在 DSH 中切换模型或新建会话。' : ' 原有来源和 ModelDock 来源一起显示；已有会话保留原模型选择。'}</>}{selectedTool === 'vscode' && ' 同步来源后，请在 VS Code 的模型选择器中选择；不会替换已打开聊天的当前模型。'}{selectedTool === 'copilot' && <> 请在 Copilot app 的模型选择器中选择导入的模型；不会替换已打开聊天的当前模型。{currentOnlySelected ? ' 仅保留所选自定义来源。' : ' 只更新 ModelDock 来源，保留其他供应商。'}</>}</p>}
            {selectedTool === 'claude-code' && !!currentSourceIds.length && <p className="tool-inline-delivery" data-claude-endpoint><span>{currentClaudeLabel}：</span><code>{currentClaudeNativeUrl || `http://127.0.0.1:${data.gateway.port}/tool/claude-code`}</code></p>}
            {toolSyncErrors[selectedTool] && <p className="tool-inline-sync-error" role="alert" data-tool-sync-error>{toolSyncErrors[selectedTool]}</p>}
            {currentRestored && <p className="tool-inline-delivery" role="status" data-tool-official-restored>{currentJetBrains ? '已恢复同步前设置：' : '已恢复官方模型入口：'}<code>{toolRestoreLocations[selectedTool]}</code></p>}
            {currentDelivery && <p className="tool-inline-delivery" role="status">{currentCleared ? selectedTool === 'dsh' ? currentOnlySelected ? '已清理 DSH 显示来源：' : '已恢复 DSH 原来源：' : currentOnlySelected ? '已清理自定义来源：' : '已清理 ModelDock 来源：' : currentDelivery.kind === 'applied' ? selectedTool === 'copilot' ? 'Copilot 模型注册表：' : '已写入：' : '已导出：'}<code>{currentDelivery.location}</code></p>}
          </div>
          {currentJetBrains && <JetBrainsPanel tool={selectedTool} api={bridge} models={currentModels} defaultModel={currentDefault} gateway={data.gateway} connection={currentJetBrainsConnection} status={currentJetBrainsStatus} busy={currentToolBusy} notify={notify} onRefresh={refresh} onStatusRefresh={() => loadJetBrainsStatus(selectedTool)} onPreview={() => showPreview(selectedTool)} onExport={() => exportTool(selectedTool)} onApply={() => applyTool(selectedTool)} />}
          {currentAggregate && <section className="panel codex-aggregate-models" data-tool-aggregate-models={selectedTool} data-codex-aggregate-models={selectedTool === 'codex' ? true : undefined}><div className="section-heading"><h2>聚合接口启用模型<span className="count-tag">{currentModels.length} / {aggregateCandidates.length}</span></h2><div className="tool-source-batch-actions"><button className="button small secondary" data-action={selectedTool === 'codex' ? 'select-all-codex-aggregate-models' : 'select-all-tool-aggregate-models'} disabled={!bridge || currentToolBusy || !aggregateCandidates.length} onClick={() => void saveAggregateModels(selectedTool, aggregateCandidates.map(model => model.id))}><CheckCheck size={14} />启用全部</button><button className="button small secondary" data-action={selectedTool === 'codex' ? 'clear-codex-aggregate-models' : 'clear-tool-aggregate-models'} disabled={!bridge || currentToolBusy || !currentModels.length} onClick={() => void saveAggregateModels(selectedTool, [])}><X size={14} />全部停用</button></div></div><p className="aggregate-model-note">先选择下方供应商，再勾选允许 {toolInfo[selectedTool].name} 使用的模型。{currentJetBrains ? '全部停用只保存空模型范围，退出 IDE 后需显式同步设置。' : '全部停用会清理该工具的模型入口。'}</p><code className="aggregate-model-endpoint">http://127.0.0.1:{data.gateway.port}/tool/{selectedTool}{selectedTool === 'claude-code' ? '' : '/v1'}</code>{aggregateCandidates.length ? <div className="aggregate-model-list">{aggregateCandidates.map(model => <label key={model.id} className={`aggregate-model-option ${currentModels.some(item => item.id === model.id) ? 'selected' : ''}`}><input type="checkbox" data-action={selectedTool === 'codex' ? 'select-codex-aggregate-model' : 'select-tool-aggregate-model'} data-model-id={model.id} checked={currentModels.some(item => item.id === model.id)} disabled={!bridge || currentToolBusy} onChange={event => void saveAggregateModels(selectedTool, event.target.checked ? [...currentModels.map(item => item.id), model.id] : currentModels.filter(item => item.id !== model.id).map(item => item.id))} /><span><strong>{modelLabel(model)}</strong><small>{data.providers.find(provider => provider.id === model.providerId)?.name} · {model.alias}</small></span>{model.id === currentDefault?.id && <span className="badge neutral">默认</span>}</label>)}</div> : <p className="aggregate-model-empty">选择有兼容模型的供应商后，可在这里逐个启用。</p>}</section>}
          <div className="section-heading tool-source-heading"><h2>可用供应商<span className="count-tag">{data.providers.length}</span></h2><div className="tool-source-batch-actions">{!currentSingleProvider && <button className="button small secondary" data-action="select-all-tool-providers" disabled={!bridge || currentToolBusy || !availableToolProviderIds.length} title="选择全部已启用、有凭据且有可用模型的来源，包含搜索结果外的来源" onClick={() => void saveInlineBinding(selectedTool, availableToolProviderIds)}><CheckCheck size={14} />全选可用</button>}<button className="button small secondary" data-action="clear-tool-providers" disabled={!bridge || currentToolBusy || (!currentSourceIds.length && !currentCanClear)} title="清空当前工具的选择及对应配置，包含搜索结果外的来源；保留全局供应商和模型" onClick={() => void saveInlineBinding(selectedTool, [])}><X size={14} />清空选择</button></div><label className="search-box"><Search size={15} /><input aria-label="搜索供应商" placeholder="搜索供应商" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
          <p className="tool-source-selection-note">{currentSingleProvider ? '一次选择一家 API 或账号订阅来源；勾选另一家会替换当前来源。开启「使用聚合接口」可同时使用多家模型。' : currentLegacyMode ? '当前沿用已有连接方式，修改来源仍保留原连接方式；点击上方聚合选项可切换。' : `可选择多家来源。全选覆盖全部 ${availableToolProviderIds.length} 家已启用、有凭据且有兼容模型的来源，包含搜索结果外的来源。`}{' 清空只移除当前工具选择，保留全局供应商和模型。'}</p>
          {toolProviders.length ? <div className="provider-list">{toolProviders.map(provider => providerRow(provider, true))}</div> : <EmptyState compact icon={data.providers.length ? <Search size={25} /> : <Plug2 size={25} />} title={data.providers.length ? '没有匹配的供应商' : '还没有供应商'} description={data.providers.length ? '试试其他名称或服务地址。' : '在左侧添加 API 或订阅供应商，再为这个工具选择模型来源。'} />}
          <div className="panel-footnote"><CircleHelp size={14} /><span>{currentJetBrains ? '勾选和模型变化只保存当前 IDE 的选择，不会改写 IDE 设置。使用上方接入参数，或退出 IDE 后点击“同步 IDE 设置”。' : currentCanApply ? '勾选和默认模型变化会自动同步，保留工具的其他配置。模型参数变化或同步失败时，可点击“重新同步”。' : '勾选会立即保存来源；导出后需要在工具中导入配置。模型或选择变化后，请再次导出并导入。'}</span></div>
        </>}

        {page === 'providers' && (selectedProvider ? <>
          <div className="provider-list">{providerRow(selectedProvider)}</div>
          <div className="provider-details"><div><span>接入方式</span><strong>{presetById(selectedProvider.presetId)?.name ?? providerKinds[selectedProvider.kind].title}</strong></div><div><span>可用模型</span><strong>{data.models.filter(model => model.providerId === selectedProvider.id && model.enabled).length} 个已启用</strong></div><div><span>备注</span><strong>{selectedProvider.note || '暂无备注'}</strong></div></div>
          <section className="panel provider-models"><div className="section-heading"><h2>供应商模型<span className="count-tag">{data.models.filter(model => model.providerId === selectedProvider.id).length}</span></h2><div className="row-actions"><button data-action="discover-models" className="button small primary" disabled={!selectedProvider.hasSecret || !selectedProvider.baseUrl} onClick={() => setModelDiscovery({ provider: selectedProvider })}><Download size={15} />获取模型列表</button><button data-action="manual-add-model" className="button small secondary" onClick={() => addModel(selectedProvider.id)}><Plus size={15} />手动添加</button></div></div>{data.models.some(model => model.providerId === selectedProvider.id) ? modelTable(data.models.filter(model => model.providerId === selectedProvider.id)) : <EmptyState compact icon={<Layers3 size={25} />} title="还没有模型" description="保存 API Key 或登录账号后，可获取模型列表或手动添加模型，再测试连接。" action={<button className="button primary" disabled={!selectedProvider.hasSecret || !selectedProvider.baseUrl} onClick={() => setModelDiscovery({ provider: selectedProvider })}><Download size={15} />获取模型列表</button>} />}</section>
        </> : <>
          <div className="aggregate-strip"><Waypoints size={21} /><div><strong>本地统一入口</strong><code>{data.gateway.baseUrl || `http://127.0.0.1:${data.gateway.port}/v1`}</code></div><span className={`badge ${data.gateway.running ? 'positive' : 'neutral'}`}>{data.gateway.running ? '运行中' : '未启动'}</span><button className="button small secondary" onClick={() => navigate('service')}><Settings2 size={14} />管理服务</button></div>
          {!!duplicateProviderGroups && <div className="provider-duplicate-banner"><Copy size={17} /><div><strong>发现 {duplicateProviderGroups} 组同名、同地址的供应商</strong><span>核对凭据后可合并重复记录，保留模型和工具选择。</span></div><button type="button" className="button small secondary" data-action="review-provider-duplicates" onClick={() => setShowProviderDuplicates(true)}>整理重复供应商</button></div>}
          <div className="source-category-tabs" role="tablist" aria-label="供应商分类"><button role="tab" aria-selected={sourceCategory === 'api'} className={sourceCategory === 'api' ? 'selected' : ''} onClick={() => { setSourceCategory('api'); setSearch(''); }}><KeyRound size={15} />API 供应商<span>{data.providers.filter(provider => provider.kind === 'openai-compatible').length}</span></button><button role="tab" aria-selected={sourceCategory === 'subscription'} className={sourceCategory === 'subscription' ? 'selected' : ''} onClick={() => { setSourceCategory('subscription'); setSearch(''); }}><Sparkles size={15} />订阅供应商<span>{data.providers.filter(provider => provider.kind !== 'openai-compatible').length}</span></button><label className="search-box"><Search size={15} /><input aria-label="搜索供应商" placeholder="搜索供应商" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
          {filteredProviders.length ? <div className="provider-list">{filteredProviders.map(provider => providerRow(provider))}</div> : <EmptyState compact icon={categoryProviders.length ? <Search size={25} /> : <Plug2 size={25} />} title={categoryProviders.length ? '没有匹配的供应商' : sourceCategory === 'api' ? '还没有 API 供应商' : '还没有订阅供应商'} description={categoryProviders.length ? '试试其他名称或服务地址。' : sourceCategory === 'api' ? '在左侧选择“添加 API”，填写自己的地址与 API Key。' : '在左侧选择“添加订阅”，使用本人的 Codex、GitHub Copilot 或 Grok Build 账号授权。'} />}
        </>)}

        {page === 'models' && <>
          <section className="panel catalog-panel"><div className="catalog-toolbar"><label className="search-box wide-search"><Search size={16} /><input aria-label="搜索模型" placeholder="搜索模型名称、上游 ID 或供应商…" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="filter-select"><select aria-label="筛选供应商" value={providerFilter} onChange={event => setProviderFilter(event.target.value)}><option value="all">所有供应商</option>{data.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><ChevronDown size={13} /></label><span className="catalog-result-count">{filteredModels.length} 个结果</span></div>
            {data.models.length ? <>{modelTable(filteredModels)}{!filteredModels.length && <EmptyState compact icon={<Search size={24} />} title="没有匹配的模型" description="调整供应商筛选，或试试其他关键词。" />}</> : modelEmpty()}
            <div className="panel-footnote"><CircleHelp size={14} /><span>模型按套餐名称区分，接口 ID 自动避免跨供应商重名；能力和可用性以实际调用为准。</span></div>
          </section>
        </>}
        {page === 'service' && <>
          <section className="gateway-panel">
            <div className="gateway-top"><span className={`gateway-icon ${data.gateway.running ? 'on' : ''}`}><Server size={26} /></span><div><h2>本地模型服务</h2><p>连接你的供应商，为工具提供一个统一入口。</p></div><span className={`badge ${data.gateway.running ? 'positive' : 'neutral'}`}><span className="status-dot" />{data.gateway.running ? '正在运行' : '已停止'}</span></div>
            <div className="gateway-body">
              <div className="gateway-entry"><label>本机 API 入口</label><div className="endpoint-field"><code>{data.gateway.baseUrl || '启动服务后显示入口'}</code><button className="icon-button" disabled={!data.gateway.baseUrl} title="复制 API 入口" aria-label="复制 API 入口" onClick={() => void copy(data.gateway.baseUrl, 'API 入口已复制。')}><Copy size={16} /></button></div><div className="entry-meta"><span><ShieldCheck size={13} />仅监听 127.0.0.1</span><span><KeyRound size={13} />使用本地密钥验证</span><button className="text-button" onClick={() => void run('copy-key', async () => { await bridge!.copyGatewayKey(); notify('本地密钥已复制，界面中不会显示密钥。'); })}>复制本地密钥<Copy size={12} /></button></div></div>
              <div className="gateway-control"><label htmlFor="service-port">服务端口</label><div className="port-control"><input id="service-port" aria-label="服务端口" type="number" min="1024" max="65535" disabled={data.gateway.running || !!busy.gateway || !!busy['gateway-settings']} value={port} onChange={event => setPort(event.target.value)} /><button className={`button ${data.gateway.running ? 'secondary' : 'primary'}`} disabled={!bridge || !!busy.gateway || !!busy['gateway-settings']} onClick={() => void (data.gateway.running ? stopGateway() : startGateway())}><BusyIcon active={!!busy.gateway}><Power size={16} /></BusyIcon>{data.gateway.running ? '停止服务' : '启动服务'}</button></div></div>
            </div>
            <div className="gateway-autostart settings-row" data-action="gateway-autostart"><div className="settings-row-copy"><strong>随应用启动本地服务</strong><small>每次启动 ModelDock 时自动开启服务，使用已保存端口 {preferences?.settings.gatewayPort ?? data.gateway.port}。下次应用启动时生效。</small></div><div className="settings-control"><Toggle label="随应用启动本地服务" checked={preferences?.settings.autoStartGateway ?? false} disabled={!bridge || !preferences || !!busy.gateway || !!busy['gateway-settings']} onChange={autoStartGateway => void changeGatewayAutostart(autoStartGateway)} /></div></div>
            {data.gateway.lastError && <div className="gateway-error"><Activity size={15} /><span>{data.gateway.lastError}</span></div>}
            <div className="gateway-footer"><span>供应商凭据留在本机，由 ModelDock 转发请求。</span><span><span className="tiny-dot" />{enabledModels} 个已启用模型</span></div>
          </section>
          <div className="service-metrics"><div><span>本次服务请求</span><strong>{number(data.gateway.requests)}</strong></div><div><span>已记录请求</span><strong>{number(data.logs.length)}</strong></div><div><span>当前错误记录</span><strong className={data.logs.some(log => log.status >= 400 || !log.status) ? 'orange-text' : ''}>{data.logs.filter(log => log.status >= 400 || !log.status).length}</strong></div><div><span>数据存储</span><strong className="storage-label"><Database size={17} />本机</strong></div></div>
          <section className="panel logs-panel"><div className="section-heading"><h2>请求日志<span className="count-tag">{data.logs.length}</span></h2><div className="log-tabs">{[{ id: 'all', label: '全部' }, { id: 'success', label: '成功' }, { id: 'error', label: '错误' }].map(item => <button key={item.id} className={logFilter === item.id ? 'selected' : ''} onClick={() => setLogFilter(item.id)}>{item.label}</button>)}</div></div>{logs.length ? <div className="table-scroll"><table className="logs-table"><thead><tr><th>时间</th><th>模型</th><th>供应商</th><th>接口</th><th>状态</th><th>耗时</th></tr></thead><tbody>{[...logs].reverse().map(log => <tr key={log.id}><td className="log-time">{new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false })}</td><td><strong>{log.alias}</strong></td><td>{log.providerName}</td><td><code>{log.endpoint}</code></td><td><span className={`log-status ${log.status >= 200 && log.status < 400 ? 'ok' : 'error'}`}><span className="status-dot" />{log.status || '失败'}</span></td><td className="log-duration">{number(log.durationMs)} ms</td></tr>)}</tbody></table></div> : <EmptyState compact icon={<Activity size={25} />} title={logFilter === 'all' ? '还没有请求记录' : '暂无这类请求'} description="通过工具向本地服务发起调用后，这里会显示模型、状态与耗时。" />}<div className="panel-footnote"><ShieldCheck size={13} /><span>仅展示请求元数据，不展示提示词、回答或供应商密钥。</span></div></section>
          <DiagnosticsPanel api={bridge} notify={notify} />
        </>}

      </main>
    </div>

    {modelDiscovery && <ModelDiscovery key={modelDiscovery.provider.id} api={bridge} provider={modelDiscovery.provider} initialResult={modelDiscovery.initialResult} notify={notify} onClose={() => setModelDiscovery(null)} onManualAdd={() => { const id = modelDiscovery.provider.id; setModelDiscovery(null); addModel(id); }} onAdded={refresh} />}
    {showProviderDuplicates && <ProviderDuplicates api={bridge} notify={notify} gatewayRunning={data.gateway.running} onClose={() => setShowProviderDuplicates(false)} onChanged={refresh} onEdit={id => { const provider = data.providers.find(item => item.id === id); if (provider) { setShowProviderDuplicates(false); editProvider(provider); } }} />}

    {providerDraft && <Modal title={providerDraft.id ? '编辑供应商' : providerDraft.kind === 'openai-compatible' ? '添加 API 供应商' : '添加订阅供应商'} subtitle={providerDraft.kind === 'openai-compatible' ? '选择服务，填写地址与 API Key。' : '选择订阅服务，保存后登录本人的账号。'} onClose={() => setProviderDraft(null)}>
      <form onSubmit={event => { event.preventDefault(); void saveProvider(); }}>
        <div className="modal-body">
          <div className="field-label">{providerDraft.kind === 'openai-compatible' ? 'API 服务预设' : '订阅服务'}{providerDraft.id && <span className="optional">保留原有接入方式</span>}</div>
          <div className={`provider-kind-picker preset-picker ${providerDraft.kind === 'openai-compatible' ? 'api-presets' : 'subscription-presets'}`}>
            {providerPresets.filter(preset => preset.category === (providerDraft.kind === 'openai-compatible' ? 'api' : 'subscription')).map(preset => <button type="button" key={preset.id} data-preset-id={preset.id} className={providerDraft.presetId === preset.id ? 'selected' : ''} disabled={!!providerDraft.id} onClick={() => setProviderDraft(freshProvider(preset.id))}>
              {preset.category === 'api' ? <KeyRound size={17} /> : preset.kind === 'codex' ? <Sparkles size={18} /> : preset.kind === 'copilot' ? <ToolIcon tool="copilot" /> : <Zap size={18} />}<strong>{preset.name}</strong>{providerDraft.presetId === preset.id && <Check size={14} className="kind-check" />}
            </button>)}
          </div>
          <label className="form-field">供应商名称<input required maxLength={80} placeholder="给这个服务或账号取一个名称" value={providerDraft.name} onChange={event => setProviderDraft({ ...providerDraft, name: event.target.value })} /></label>
          {providerDraft.kind === 'copilot' && <label className="form-field">GitHub 账号<select data-field="copilot-account" value={providerDraft.copilotAccountId ?? ''} onChange={event => setProviderDraft({ ...providerDraft, copilotAccountId: event.target.value })}><option value="">保存后登录 GitHub</option>{copilotAccountChoices.map(account => <option key={account.providerId} value={account.providerId} disabled={account.authStatus !== 'ready'}>{account.displayName || account.email || account.providerName}{account.authStatus !== 'ready' ? '（需重新登录）' : ''}</option>)}</select><small>{copilotAccountError || '选择授权中心已登录的 GitHub 账号，可直接复用订阅授权。'}</small></label>}
          {!!draftExistingProviders.length && <div className="provider-draft-existing"><CircleHelp size={17} /><div><strong>同名、同地址的供应商已存在</strong><p>相同密钥会复用已有记录。更换密钥请编辑原记录；不同账号请使用不同名称。</p></div><button type="button" className="button small secondary" onClick={() => draftExistingProviders.length > 1 ? (setProviderDraft(null), setShowProviderDuplicates(true)) : editProvider(draftExistingProviders[0])}>{draftExistingProviders.length > 1 ? '整理重复记录' : '编辑已有记录'}</button></div>}
          {providerDraft.kind === 'openai-compatible' ? <>
            <label className="form-field">API 服务地址<input type="url" placeholder="填写控制台提供的 API 根地址" value={providerDraft.baseUrl} onChange={event => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} /><small>{!providerDraft.baseUrl ? '地址可以稍后填写；当前可保存为草稿，补全后再检测连接。' : '预设地址可编辑，请使用与你的账号或套餐对应的入口。'}</small></label>
            <label className="form-field">Claude Code 接口地址（可选）<input data-field="claude-base-url" type="url" placeholder="留空使用官方对应入口或本机服务" value={providerDraft.claudeBaseUrl ?? ''} onChange={event => setProviderDraft({ ...providerDraft, claudeBaseUrl: event.target.value })} /><small>填写时须是支持 Anthropic Messages 的服务地址，使用同一 API Key。留空按已知官方入口映射，其他来源使用本机服务转换；上方已有 OpenAI 地址保留。</small></label>
            {draftPreset && <div className="preset-help"><CircleHelp size={16} /><div><p>{draftPreset.note}</p>{draftPreset.docsUrl && <a href={draftPreset.docsUrl} target="_blank" rel="noopener noreferrer">查看供应商说明<ArrowUpRight size={12} /></a>}</div></div>}
            <label className="form-field">API Key<span className="input-with-icon"><KeyRound size={15} /><input type="password" autoComplete="new-password" placeholder={providerDraft.id ? '留空保留已保存的 API Key' : '粘贴此服务的 API Key'} value={providerDraft.apiKey} onChange={event => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} /></span>{providerDraft.id && <small>已有密钥不回填；输入新密钥即可替换。</small>}</label>
            <label className="form-field">Messages 鉴权方式<select data-field="messages-auth" value={providerDraft.messagesAuth ?? 'bearer'} onChange={event => setProviderDraft({ ...providerDraft, messagesAuth: event.target.value as 'api-key' | 'bearer' })}><option value="api-key">API Key（x-api-key）</option><option value="bearer">Bearer Token（Authorization）</option></select><small>仅用于 Anthropic Messages 接口，请按供应商要求选择；其他 OpenAI 接口不受影响。Anthropic 新模板默认 API Key，自定义及未设置的历史来源默认 Bearer Token。</small></label>
          </> : <div className="form-info"><KeyRound size={19} /><div><strong>{draftPreset?.name ?? providerKinds[providerDraft.kind].title}</strong><p>{draftPreset?.note} {providerDraft.kind === 'copilot' && providerDraft.copilotAccountId ? '保存后即可使用此账号的订阅模型。' : '保存后点击「登录账号」，在官方页面完成授权。'}</p></div></div>}
          <label className="form-field">备注<input placeholder="可选，记录账号或服务的用途" maxLength={300} value={providerDraft.note} onChange={event => setProviderDraft({ ...providerDraft, note: event.target.value })} /></label>
          <div className="form-switch-row"><div><strong>启用供应商</strong><small>让工具可以选择此来源的模型。</small></div><Toggle checked={providerDraft.enabled} onChange={enabled => setProviderDraft({ ...providerDraft, enabled })} label="启用供应商" /></div>
        </div>
        <div className="modal-footer"><button type="button" className="button secondary" onClick={() => setProviderDraft(null)}>取消</button><button type="submit" className="button primary" disabled={busy['save-provider']}><BusyIcon active={!!busy['save-provider']}><Check size={16} /></BusyIcon>{providerDraft.kind === 'openai-compatible' && !providerDraft.baseUrl.trim() ? '保存草稿' : '保存供应商'}</button></div>
      </form>
    </Modal>}
    {modelDraft && <Modal title={modelDraft.id ? '编辑模型' : '添加模型'} subtitle="不同供应商可使用相同模型名，聚合列表按套餐区分。" onClose={() => setModelDraft(null)}>
      <form onSubmit={event => { event.preventDefault(); void saveModel(); }}><div className="modal-body">
        <label className="form-field">模型来源<select value={modelDraft.providerId} required onChange={event => setModelDraft({ ...modelDraft, providerId: event.target.value, wireApi: modelDraft.id ? modelDraft.wireApi : presetById(data.providers.find(provider => provider.id === event.target.value)?.presetId)?.defaultWireApi ?? 'responses' })}><option value="">选择供应商</option>{data.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {providerKinds[provider.kind].title}</option>)}</select></label>
        <label className="form-field">上游模型 ID<input data-field="upstream-id" required placeholder="例如：gpt-6.1-sol / glm-5.3" list="discovered-models" value={modelDraft.upstreamId} onChange={event => setModelDraft({ ...modelDraft, upstreamId: event.target.value, alias: !modelDraft.alias || modelDraft.alias === modelDraft.upstreamId ? event.target.value : modelDraft.alias, displayName: !modelDraft.displayName || modelDraft.displayName === modelDraft.upstreamId ? event.target.value : modelDraft.displayName })} /><datalist id="discovered-models">{[...new Set(data.models.filter(model => model.providerId === modelDraft.providerId).map(model => model.upstreamId))].map(id => <option key={id} value={id} />)}</datalist><small>填写供应商实际接受的模型 ID，也可通过获取模型列表批量添加。</small></label>
        <div className="form-columns"><label className="form-field">模型简称<input data-field="model-local-alias" required placeholder="例如：glm-5.3" value={modelDraft.alias} onChange={event => setModelDraft({ ...modelDraft, alias: event.target.value })} /><small>仅在当前供应商内区分；跨供应商可重名。</small></label><label className="form-field">显示名称<input data-field="model-display-name" placeholder="可与其他模型相同" value={modelDraft.displayName} onChange={event => setModelDraft({ ...modelDraft, displayName: event.target.value })} /><small>聚合时显示“套餐名 - 模型名”。</small></label></div>
        {modelDraftProvider && modelDraft.alias.trim() && <div className="model-route-preview">{modelRoutePreview.error ? <span role="alert">{modelRoutePreview.error}</span> : <><strong>{modelDisplayLabel({ ...modelDraft, displayName: modelDraft.displayName || modelDraft.alias }, modelDraftProvider)}</strong><small>聚合接口 ID：<code data-field="model-route-preview">{modelRoutePreview.alias}</code></small></>}</div>}
        <div className="form-columns"><label className="form-field">调用接口<select data-field="wire-api" value={modelDraft.wireApi} onChange={event => setModelDraft({ ...modelDraft, wireApi: event.target.value as Model['wireApi'] })}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option><option value="messages">Messages · Anthropic</option></select></label><label className="form-field">上下文长度（0 表示未设置）<input data-field="context-window" type="number" required min="0" step="1" value={modelDraft.contextWindow} onChange={event => setModelDraft({ ...modelDraft, contextWindow: Number(event.target.value) })} /></label></div>
        <div className="capability-field"><span className="field-label">模型能力</span><label><input type="checkbox" checked={modelDraft.tools} onChange={event => setModelDraft({ ...modelDraft, tools: event.target.checked })} /><Terminal size={16} />工具调用</label><label><input type="checkbox" checked={modelDraft.vision} onChange={event => setModelDraft({ ...modelDraft, vision: event.target.checked })} /><Sparkles size={16} />图片输入</label></div>
        <div className="capability-field reasoning-field"><span className="field-label">思考强度</span>{REASONING_EFFORTS.map(level => <label key={level}><input type="checkbox" data-field={`reasoning-effort-${level}`} checked={(modelDraft.reasoningEfforts ?? []).includes(level)} onChange={event => {
          const current = modelDraft.reasoningEfforts ?? [];
          const next = event.target.checked ? [...current, level] : current.filter(item => item !== level);
          setModelDraft({ ...modelDraft, reasoningEfforts: next, defaultReasoningEffort: modelDraft.defaultReasoningEffort && next.includes(modelDraft.defaultReasoningEffort) ? modelDraft.defaultReasoningEffort : undefined });
        }} />{reasoningEffortLabels[level]}</label>)}</div>
        {(modelDraft.reasoningEfforts ?? []).length > 0 && <label className="form-field">默认思考强度<select data-field="default-reasoning-effort" value={modelDraft.defaultReasoningEffort ?? ''} onChange={event => setModelDraft({ ...modelDraft, defaultReasoningEffort: (event.target.value || undefined) as ReasoningEffort | undefined })}><option value="">由工具选择</option>{(modelDraft.reasoningEfforts ?? []).map(level => <option key={level} value={level}>{reasoningEffortLabels[level]}（{level}）</option>)}</select><small>勾选级别后同步到 VS Code、Codex、Copilot 和 DSH 的思考强度配置；全部不勾选则不写入思考强度。</small></label>}
        <div className="form-switch-row"><div><strong>启用模型</strong><small>启用后可以为工具选择此模型。</small></div><Toggle checked={modelDraft.enabled} onChange={enabled => setModelDraft({ ...modelDraft, enabled })} label="启用模型" /></div>
      </div><div className="modal-footer"><button type="button" className="button secondary" onClick={() => setModelDraft(null)}>取消</button><button type="submit" className="button primary" disabled={busy['save-model'] || !!modelRoutePreview.error}><BusyIcon active={!!busy['save-model']}><Plus size={16} /></BusyIcon>{modelDraft.id ? '保存修改' : '添加模型'}</button></div></form>
    </Modal>}

    {preview && <Modal wide title={`${toolInfo[preview.tool].name} 配置预览`} subtitle="检查内容，选择适合此工具的保存方式。" onClose={() => setPreview(null)}><div className="modal-body config-preview-body"><div className="config-filename"><FileCode2 size={17} /><strong>{preview.data.filename}</strong><button className="text-button" onClick={() => void copy(preview.data.content, '配置内容已复制。')}><Copy size={14} />复制内容</button></div><pre className="config-code" tabIndex={0}>{preview.data.content}</pre><div className="config-instructions"><CircleHelp size={17} /><div><strong>如何使用</strong><p>{preview.data.instructions}</p></div></div></div><div className="modal-footer"><button className="button secondary" onClick={() => setPreview(null)}>关闭</button><div className="footer-actions">{toolModels(bindingFor(preview.tool)).length > 0 && bindingConnectionPolicy(bindingFor(preview.tool), data.models, data.providers).groups.length === 1 && <button className="button secondary" disabled={busy["copy-connection-key"]} onClick={() => void run("copy-connection-key", async () => { await bridge!.copyConnectionKey(preview.tool); notify("已复制此工具的连接密钥。"); })}><KeyRound size={16} />复制连接密钥</button>}<button className="button secondary" disabled={toolOperationPending(preview.tool)} onClick={() => void exportTool(preview.tool)}><BusyIcon active={!!busy[`export-tool-${preview.tool}`]}><ArrowDownToLine size={16} /></BusyIcon>导出文件</button>{preview.data.canApply && <button className="button primary" disabled={toolOperationPending(preview.tool) || isJetBrainsTool(preview.tool) && !jetBrainsStatuses[preview.tool]?.canApply} title={isJetBrainsTool(preview.tool) ? jetBrainsStatuses[preview.tool]?.message : undefined} onClick={() => void applyTool(preview.tool)}><BusyIcon active={!!busy[`apply-tool-${preview.tool}`]}><CheckCheck size={16} /></BusyIcon>{isJetBrainsTool(preview.tool) ? '同步 IDE 设置' : '应用到工具'}</button>}</div></div></Modal>}

    {auth && <Modal title={auth.state === 'complete' ? '账号授权已完成' : auth.state === 'error' ? '账号授权未完成' : auth.state === 'cancelled' ? '登录已取消' : !auth.userCode && !auth.verificationUri ? '正在准备登录' : '在浏览器中登录账号'} subtitle={data.providers.find(provider => provider.id === auth.providerId)?.name} onClose={closeAuth} closeOnBackdrop={auth.state !== 'pending'}>
      <div className="modal-body auth-body" data-auth-state={auth.state} data-auth-stage={auth.stage} data-auth-status={auth.statusCode} data-auth-category={auth.category}>
        <div className={`auth-symbol ${auth.state === 'complete' ? 'complete' : ''}`}>{auth.state === 'complete' ? <CheckCheck size={30} /> : auth.state === 'pending' ? <Globe2 size={30} /> : <KeyRound size={28} />}</div>
        <h3>{auth.state === 'pending' ? !auth.userCode && !auth.verificationUri ? '请稍候，准备完成后会显示官方授权入口。' : '完成官方授权，回到这里即可。' : auth.state === 'complete' ? '账号凭据已安全保存。' : auth.state === 'cancelled' ? '你可以随时重新登录。' : auth.stage === 'device-code' ? '未能申请到设备验证码。' : '授权未完成，请按提示处理。'}</h3>
        <p role={auth.state === 'error' ? 'alert' : undefined}>{auth.message}</p>
        {auth.state === 'error' && <div className="auth-failure-details"><span>失败步骤：{auth.stage ? authStageLabels[auth.stage] : '授权请求'}</span>{auth.statusCode !== undefined && <span>HTTP {auth.statusCode}</span>}{auth.errorCode && <span data-auth-error-code>{auth.errorCode}</span>}</div>}
        {auth.state === 'error' && auth.category === 'region' && <p className="auth-recovery-note">应用已使用系统网络设置。请确认电脑现有网络配置可访问 OpenAI 授权服务；若本机 Codex 已登录，也可到授权中心显式导入本机授权。</p>}
        {auth.userCode && <div className="auth-code" data-auth-code data-value={auth.userCode}><span>在官方页面输入此验证码</span><strong>{auth.userCode}</strong><button className="text-button" data-action="auth-copy-code" onClick={() => void copy(auth.userCode!, '验证码已复制。')}><Copy size={13} />复制验证码</button></div>}
        {auth.state === 'pending' && auth.verificationUri && <a className="auth-verification-link" data-action="auth-open-verification" href={auth.verificationUri} target="_blank" rel="noreferrer">打开官方授权页面<ArrowUpRight size={13} /></a>}
        {auth.state === 'pending' && <div className="auth-wait"><LoaderCircle size={15} className="spin" />{busy[`cancel-auth-${auth.providerId}`] ? '正在取消登录…' : !auth.userCode && !auth.verificationUri ? `${auth.stage ? authStageLabels[auth.stage] : '正在准备登录'}…` : auth.stage === 'token-exchange' ? '正在兑换登录凭据…' : auth.stage === 'account-info' ? '正在读取 GitHub 账号信息…' : '正在等待授权结果…'}</div>}
        <div className="auth-privacy"><ShieldCheck size={14} />密码只在官方页面输入，ModelDock 不会接收密码。</div>
      </div><div className="modal-footer"><button className="button secondary" disabled={busy[`cancel-auth-${auth.providerId}`]} onClick={closeAuth}>{auth.state === 'pending' ? '取消登录' : '完成'}</button>{auth.state === 'error' && <button className="button primary" data-action="auth-open-center" onClick={() => { ++authGeneration.current; updateAuth(null); navigate('auth'); }}>前往授权中心</button>}</div>
    </Modal>}

    {confirm && <Modal title={confirm.title} onClose={() => { if (!busy[confirm.actionKey ?? "delete"]) setConfirm(null); }}><div className="modal-body"><p className="confirm-description">{confirm.description}</p></div><div className="modal-footer"><button className="button secondary" data-action="cancel-tool-restore" disabled={busy[confirm.actionKey ?? "delete"]} onClick={() => setConfirm(null)}>{confirm.actionLabel ? "取消" : "保留"}</button><button className={confirm.actionLabel ? "button primary" : "button danger"} data-action={confirm.actionLabel ? "confirm-tool-restore" : "confirm-delete"} disabled={busy[confirm.actionKey ?? "delete"]} onClick={() => void run(confirm.actionKey ?? "delete", async () => { await confirm.action(); setConfirm(null); })}><BusyIcon active={!!busy[confirm.actionKey ?? "delete"]}>{confirm.actionLabel ? <RotateCcw size={16} /> : <Trash2 size={16} />}</BusyIcon>{confirm.actionLabel ?? "确认删除"}</button></div></Modal>}
    <div className="toast-stack" aria-live="polite">{toasts.map(toast => <div key={toast.id} className={`toast ${toast.tone}`}>{toast.tone === 'success' ? <Check size={17} /> : toast.tone === 'error' ? <Activity size={17} /> : <CircleHelp size={17} />}<span>{toast.message}</span><button aria-label="关闭提示" onClick={() => setToasts(previous => previous.filter(item => item.id !== toast.id))}><X size={14} /></button></div>)}</div>
  </div>;
}
