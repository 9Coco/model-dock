import type { ModelDockApi } from '../shared/types';
import { airProviderLabel, airSettingsPath, type AirProvider } from '../shared/air';
import { ArrowDownToLine, Copy, FileCode2, KeyRound, Plug2 } from './MaterialIcon';
import { BusyIcon } from './components';
import './jetbrains.css';

interface AirPanelProps {
  api?: ModelDockApi;
  provider: AirProvider;
  description: string;
  baseUrl: string;
  modelId?: string;
  aggregate: boolean;
  running: boolean;
  disabled: boolean;
  starting: boolean;
  onCopy: (value: string, message: string) => Promise<void>;
  onProviderChange: (provider: AirProvider) => Promise<void>;
  onCopyKey: () => Promise<void>;
  onStart: () => Promise<void>;
  onPreview: () => Promise<void> | undefined;
  onExport: () => Promise<void>;
}

export function AirPanel({ api, provider, description, baseUrl, modelId, aggregate, running, disabled, starting,
  onCopy, onProviderChange, onCopyKey, onStart, onPreview, onExport }: AirPanelProps) {
  const unavailable = !api || disabled || !modelId || !baseUrl;
  return <section className="panel jetbrains-connection" data-air-connection="air" aria-labelledby="air-connection-title">
    <div className="section-heading"><h2 id="air-connection-title">Air Accounts 供应商</h2><span className="badge neutral">在 Air 中保存账号</span></div>
    <p className="jetbrains-scope-note">为 Air 自己的 BYOK 账号准备参数。选择会保存在 ModelDock，填写后请在 Air 的账户设置中测试并保存。</p>
    <label className="air-provider-picker">Air 供应商类型<select data-action="air-provider-type" value={provider} disabled={!api || disabled}
      onChange={event => void onProviderChange(event.target.value as AirProvider)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
    <dl className="jetbrains-parameters">
      <div className="jetbrains-parameter"><dt>Description（描述）</dt><dd>
        <code>{description}</code>
        <button type="button" className="text-button" data-action="air-copy-description" aria-label="复制 Air 描述" disabled={unavailable}
          onClick={() => void onCopy(description, 'Air 描述已复制。')}><Copy size={14} />复制</button>
      </dd></div>
      <div className="jetbrains-parameter"><dt>Base URL</dt><dd>
        <code>{baseUrl || '请选择直连供应商'}</code>
        <button type="button" className="text-button" data-action="air-copy-url" aria-label="复制 Air URL" disabled={unavailable}
          onClick={() => void onCopy(baseUrl, 'Air URL 已复制。')}><Copy size={14} />复制</button>
      </dd></div>
      <div className="jetbrains-parameter"><dt>API Key</dt><dd>
        <span>{aggregate ? 'ModelDock 本机连接密钥' : '所选供应商的 API Key'}</span>
        <button type="button" className="text-button" data-action="air-copy-key" disabled={unavailable}
          onClick={() => void onCopyKey()}><KeyRound size={14} />复制 Key</button>
      </dd></div>
      <div className="jetbrains-parameter"><dt>参考模型 ID</dt><dd>
        <code>{modelId || '请选择模型'}</code>
        <button type="button" className="text-button" data-action="air-copy-model" aria-label="复制 Air 模型 ID" disabled={unavailable}
          onClick={() => modelId && void onCopy(modelId, '模型 ID 已复制。')}><Copy size={14} />复制</button>
      </dd></div>
    </dl>
    <ol className="jetbrains-air-setup" data-air-manual-setup>
      <li>打开「{airSettingsPath(provider)}」，选择 {airProviderLabel(provider)} 入口。</li>
      <li>填写 API Key 和 Description，展开「高级选项」填写 Base URL，测试连接后保存。</li>
      <li>在 Air 会话中选择已保存的账号和兼容的 Agent，再选择模型；参考模型 ID 用于核对模型列表。</li>
    </ol>
    <div className="jetbrains-actions">
      {aggregate && !running && <button type="button" className="button small secondary" data-action="air-start-gateway"
        disabled={unavailable || starting} onClick={() => void onStart()}><BusyIcon active={starting}><Plug2 size={14} /></BusyIcon>启动本机服务</button>}
      <button type="button" className="button small secondary" data-action="preview-tool-config" disabled={unavailable}
        onClick={() => void onPreview()}><FileCode2 size={14} />预览接入参数</button>
      <button type="button" className="button small secondary" data-action="export-tool-config" disabled={unavailable}
        onClick={() => void onExport()}><ArrowDownToLine size={14} />导出参考参数</button>
    </div>
    <p className="jetbrains-scope-note" data-air-manual-boundary>这里提供可复制的账户参数；ModelDock 不会自动写入 Air Accounts。导出的 JSON 仅供参考，不能直接导入 Air。</p>
    <p className="jetbrains-scope-note" data-air-provider-scope>兼容服务按其支持的 OpenAI 或 Anthropic 接口选择类型，例如 OpenRouter。Air 的 Copilot 默认入口使用独立的 GitHub 授权，在 Air 中管理。</p>
    {provider === 'anthropic' && !aggregate && <p className="jetbrains-scope-note">Air 的 Anthropic 入口使用 x-api-key 认证；仅接受 Bearer 认证的来源请使用聚合接口。</p>}
    {aggregate && <p className="jetbrains-scope-note">使用聚合接口时请保持 ModelDock 本机服务运行。</p>}
  </section>;
}
