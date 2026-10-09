import type { GatewayStatus, Model, ModelDockApi, ToolId } from '../shared/types';
import { isJetBrainsTool, jetBrainsConnectionParameters, JETBRAINS_TOOLS, type JetBrainsStatus } from '../shared/jetbrains';
import { Copy, KeyRound, Plug2, RefreshCw, FileCode2, ArrowDownToLine, CheckCheck } from './MaterialIcon';
import { BusyIcon, type Notify } from './components';
import { useState } from 'react';
import './jetbrains.css';

interface Props {
  tool: ToolId;
  api?: ModelDockApi;
  models: Model[];
  defaultModel?: Model;
  gateway: GatewayStatus;
  connection?: ReturnType<typeof jetBrainsConnectionParameters>;
  status?: JetBrainsStatus;
  busy: boolean;
  notify: Notify;
  onRefresh(): Promise<void>;
  onStatusRefresh(): Promise<JetBrainsStatus | undefined>;
  onPreview(): Promise<void> | undefined;
  onExport(): Promise<void>;
  onApply(): Promise<void>;
}

/** 修改点：IDE 密钥始终经主进程复制到剪贴板，不进入 renderer 或 XML。 */
export function JetBrainsPanel({ tool, api, models, defaultModel, gateway, connection, status, busy, notify, onRefresh, onStatusRefresh, onPreview, onExport, onApply }: Props) {
  const [action, setAction] = useState('');
  if (!isJetBrainsTool(tool)) return null;
  const direct = connection?.kind === 'direct-api';
  const url = connection?.baseUrl ?? `http://127.0.0.1:${gateway.port}/tool/${tool}/v1`;
  const modelId = connection?.modelId || defaultModel?.alias || '先选择来源和默认模型';
  const ready = !!api && !!models.length && !!defaultModel;
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
  return <section className="panel jetbrains-connection" data-jetbrains-connection={tool} data-jetbrains-connection-kind={connection?.kind}>
    <div className="section-heading"><h2>{JETBRAINS_TOOLS[tool].name} 接入参数</h2><button className="button small secondary" data-action="jetbrains-refresh-status" disabled={!api || disabled} onClick={() => void run('status', async () => { await onStatusRefresh(); })}><BusyIcon active={action === 'status'}><RefreshCw size={14} /></BusyIcon>检查 IDE 状态</button></div>
    <p className="jetbrains-intro">在 IDE 设置的「工具 → AI Assistant → 提供商与 API 密钥」中填写下方参数。{direct ? '当前 API 直连所选供应商，使用该来源的 API Key 和真实模型 ID。' : '当前连接使用 ModelDock 本机入口和模型别名，保持 ModelDock 运行。'}</p>
    <dl className="jetbrains-parameters">
      {parameter('提供商', '兼容 OpenAI / OpenAI-compatible')}
      {parameter('URL', url, '复制 JetBrains URL')}
      <div className="jetbrains-parameter"><dt>API Key</dt><dd><span>{direct ? '所选供应商的 API Key' : '固定本机连接密钥'}</span><button className="text-button" data-action="jetbrains-copy-key" disabled={!ready || disabled} onClick={() => void run('key', async () => { await api!.copyConnectionKey(tool); notify(`${direct ? '供应商 API Key' : '本机 Key'}已复制，请在 IDE 的 API 密钥栏粘贴并确认。`); })}><KeyRound size={14} />复制 Key</button></dd></div>
      {parameter('HTTP 版本', 'HTTP/1.1')}
      {parameter('核心功能模型 ID', modelId, '复制核心模型 ID')}
      {parameter('轻量 / 快速功能模型 ID', modelId, '复制轻量模型 ID')}
      {parameter('工具调用', defaultModel?.tools ? '开启；仍需在 IDE 中测试实际模型支持' : '当前模型未声明工具支持，建议关闭')}
      {parameter('上下文', defaultModel?.contextWindow ? `${defaultModel.contextWindow.toLocaleString('zh-CN')} tokens；如 IDE 可设置，请以套餐实际限制为准` : '未设置；请查阅供应商规格后在模型目录填写')}
    </dl>
    <p className="jetbrains-key-note">API Key 需要在 IDE 中手工粘贴；切换连接方式或来源后请更新密钥，ModelDock 不写入 IDE 的密码存储。点击 IDE 的「测试连接」后，再选择模型并发送一条消息确认推理可用。</p>
    <div className="jetbrains-actions">
      {!direct && <button className="button small primary" data-action="jetbrains-prepare-connection" disabled={!ready || disabled} onClick={() => void run('prepare', async () => { const result = await api!.startGateway(gateway.port); await onRefresh(); if (!result.running) throw new Error(result.lastError || '本机连接未能启动。'); notify('本机连接已准备好，请在 IDE 中确认 API Key 和模型。'); })}><BusyIcon active={action === 'prepare'}><Plug2 size={14} /></BusyIcon>准备本机连接</button>}
      <button className="button small secondary" data-action="preview-tool-config" disabled={!api || disabled || !models.length} onClick={() => void onPreview()}><FileCode2 size={14} />预览接入参数</button>
      <button className="button small secondary" data-action="export-tool-config" disabled={!ready || disabled} onClick={() => void onExport()}><ArrowDownToLine size={14} />导出参考参数</button>
      <button className="button small secondary" data-action="apply-tool-config" disabled={!api || disabled || !status?.canApply} title={status?.message ?? '正在确认 IDE 配置和运行状态'} onClick={() => void onApply()}><CheckCheck size={14} />同步 IDE 设置</button>
    </div>
    <div className="jetbrains-profile" data-jetbrains-running={status?.running ?? 'unknown'}>
      <strong>{status?.foundProfile ? `配置目录${status.version ? ` · ${status.version}` : ''}` : 'IDE 配置状态'}</strong>
      {status?.configDir && <code>{status.configDir}</code>}
      <p role="status">{status?.message ?? '正在检查配置目录及 IDE 运行状态；也可使用以上参数手工接入。'}</p>
    </div>
    <p className="jetbrains-scope-note">同步前请退出 IDE。此操作备份并更新已发现 profile 的 AI Assistant 地址、HTTP 版本、工具调用与核心 / 轻量模型设置；API Key 仍需在 IDE 确认。导出的 JSON 是填写参考，不能直接导入 IDE。配置范围为 AI Assistant 聊天及模型核心功能；Junie、Claude Agent、Codex、Gemini CLI 与代码补全的独立配置请在 IDE 内管理。</p>
  </section>;
}
