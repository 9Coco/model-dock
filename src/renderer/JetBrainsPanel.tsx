import type { GatewayStatus, Model, ModelDockApi, ToolId } from '../shared/types';
import { isJetBrainsTool, jetBrainsConnectionParameters, JETBRAINS_TOOLS, type JetBrainsStatus } from '../shared/jetbrains';
import { Copy, KeyRound, Plug2, RefreshCw, FileCode2, ArrowDownToLine, CheckCheck } from './MaterialIcon';
import { BusyIcon, type Notify } from './components';
import { useState } from 'react';
import type { JetBrainsAutoSyncState } from './jetbrains-auto-sync';
import './jetbrains.css';

interface Props {
  tool: ToolId;
  aggregate: boolean;
  api?: ModelDockApi;
  models: Model[];
  defaultModel?: Model;
  gateway: GatewayStatus;
  connection?: ReturnType<typeof jetBrainsConnectionParameters>;
  status?: JetBrainsStatus;
  autoSync?: JetBrainsAutoSyncState;
  busy: boolean;
  notify: Notify;
  onRefresh(): Promise<void>;
  onStatusRefresh(): Promise<JetBrainsStatus | undefined>;
  onPreview(): Promise<void> | undefined;
  onExport(): Promise<void>;
  onApply(): Promise<void>;
}

/** 修改点：IDE 密钥始终经主进程复制到剪贴板，不进入 renderer 或 XML。 */
export function JetBrainsPanel({ tool, aggregate, api, models, defaultModel, gateway, connection, status, autoSync, busy, notify, onRefresh, onStatusRefresh, onPreview, onExport, onApply }: Props) {
  const [action, setAction] = useState('');
  if (!isJetBrainsTool(tool)) return null;
  const direct = !aggregate;
  const url = connection?.baseUrl || (direct ? '' : `http://127.0.0.1:${gateway.port}/tool/${tool}/v1`);
  const modelId = connection?.modelId || defaultModel?.alias || '先选择来源和默认模型';
  const ready = !!api && !!models.length && !!defaultModel && (!direct || connection?.kind === 'direct-api');
  const disabled = busy || !!action;
  const run = async (name: string, operation: () => Promise<void>) => {
    if (action || busy) return;
    setAction(name);
    try { await operation(); }
    catch (error) { notify(error instanceof Error ? error.message : '操作未完成，请重试。', 'error'); }
    finally { setAction(''); }
  };
  const copy = (value: string, label: string) => run(`copy-${label}`, async () => { await api!.copyText(value); notify(`${label}已复制。`); });
  const parameter = (label: string, value: string, buttonLabel?: string) => <div className="jetbrains-parameter"><dt>{label}</dt><dd><code>{value}</code>{buttonLabel && <button className="text-button" disabled={!api || disabled || !ready} onClick={() => void copy(value, label)} aria-label={buttonLabel}><Copy size={14} />复制</button>}</dd></div>;
  return <section className="panel jetbrains-connection" data-jetbrains-connection={tool} data-jetbrains-connection-kind={direct ? 'direct-api' : 'local-managed'} data-jetbrains-entry-count={ready ? 1 : 0}>
    <div className="section-heading"><h2>{JETBRAINS_TOOLS[tool].name} 接入参数</h2><div className="jetbrains-top-actions"><button className="button small primary" data-action="apply-tool-config" disabled={!api || disabled || !status?.canApply} title={status?.message ?? '正在确认 IDE 配置和运行状态'} onClick={() => void onApply()}><CheckCheck size={14} />同步 IDE 设置</button><button className="button small secondary" data-action="jetbrains-refresh-status" disabled={!api || disabled} onClick={() => void run('status', async () => { await onStatusRefresh(); })}><BusyIcon active={action === 'status'}><RefreshCw size={14} /></BusyIcon>检查 IDE 状态</button></div></div>
    <p className="jetbrains-intro">更改来源、连接方式或模型后，会自动备份并更新 URL、HTTP 版本和核心 / 轻量模型。IDE 运行时先保存最新选择，退出后自动同步；也可点击「同步 IDE 设置」重新应用。API Key 首次接入或切换来源时仍需在 IDE 手工更新。{direct ? '当前 API 直连所选供应商，使用该来源的 API Key 和真实模型 ID。' : '当前使用一个 ModelDock 聚合入口和映射模型别名，使用时保持 ModelDock 运行。「准备本机连接」只启动本地服务。'}</p>
    {autoSync && <p role="status" className="jetbrains-key-note" data-jetbrains-auto-sync={autoSync.phase}>{autoSync.message}</p>}
    <dl className="jetbrains-parameters">
      {parameter('提供商', '兼容 OpenAI / OpenAI-compatible')}
      {parameter('URL', url || '请先选择直连供应商', '复制 JetBrains URL')}
      <div className="jetbrains-parameter"><dt>API Key</dt><dd><span>{direct ? '所选供应商的 API Key' : '固定本机连接密钥'}</span><button className="text-button" data-action="jetbrains-copy-key" disabled={!ready || disabled} onClick={() => void run('key', async () => { await api!.copyConnectionKey(tool); notify(`${direct ? '供应商 API Key' : '本机 Key'}已复制，请在 IDE 的 API 密钥栏粘贴并确认。`); })}><KeyRound size={14} />复制 Key</button></dd></div>
      {parameter('HTTP 版本', 'HTTP/1.1')}
      {parameter('核心功能模型 ID', modelId, '复制核心模型 ID')}
      {parameter('轻量 / 快速功能模型 ID', modelId, '复制轻量模型 ID')}
      {parameter('工具调用', defaultModel?.tools ? '开启；仍需在 IDE 中测试实际模型支持' : '当前模型未声明工具支持，建议关闭')}
      {parameter('上下文', defaultModel?.contextWindow ? `${defaultModel.contextWindow.toLocaleString('zh-CN')} tokens；如 IDE 可设置，请以套餐实际限制为准` : '未设置；请查阅供应商规格后在模型目录填写')}
    </dl>
    <p className="jetbrains-key-note">API Key 首次接入时需在每个 IDE 手工粘贴一次；切换连接方式或来源后请更新密钥，ModelDock 不写入 IDE 的密码存储。点击 IDE 的「测试连接」后，再选择模型并发送一条消息确认推理可用。</p>
    <div className="jetbrains-actions">
      {!direct && <button className="button small secondary" data-action="jetbrains-prepare-connection" title="只启动本机服务；IDE 设置由上方同步按钮写入" disabled={!ready || disabled} onClick={() => void run('prepare', async () => { const result = await api!.startGateway(gateway.port); await onRefresh(); if (!result.running) throw new Error(result.lastError || '本机连接未能启动。'); notify('本机服务已启动；退出 IDE 后可同步设置，API Key 仍需在 IDE 中确认。'); })}><BusyIcon active={action === 'prepare'}><Plug2 size={14} /></BusyIcon>准备本机连接</button>}
      <button className="button small secondary" data-action="preview-tool-config" disabled={!api || disabled || !models.length} onClick={() => void onPreview()}><FileCode2 size={14} />预览接入参数</button>
      <button className="button small secondary" data-action="export-tool-config" disabled={!ready || disabled} onClick={() => void onExport()}><ArrowDownToLine size={14} />导出参考参数</button>
    </div>
    <div className="jetbrains-profile" data-jetbrains-running={status?.running ?? 'unknown'}>
      <strong>{status?.foundProfile ? `配置目录${status.version ? ` · ${status.version}` : ''}` : 'IDE 配置状态'}</strong>
      {status?.configDir && <code>{status.configDir}</code>}
      <p role="status">{status?.message ?? '正在检查配置目录及 IDE 运行状态；也可使用以上参数手工接入。'}</p>
    </div>
    <p className="jetbrains-scope-note">仅在确认 IDE 已退出且 profile 兼容时写入设置。等待期间保留最新选择；关闭 ModelDock 后不自动重放待办，下次可重新同步。API Key 仍需在 IDE 确认。导出的 JSON 是填写参考，不能直接导入 IDE。配置范围为 AI Assistant 聊天及模型核心功能；Junie、Claude Agent、Codex、Gemini CLI 与代码补全的独立配置请在 IDE 内管理。</p>
  </section>;
}
