import type { ModelDockApi } from '../shared/types';
import { ArrowDownToLine, Copy, FileCode2, KeyRound, Plug2 } from './MaterialIcon';
import { BusyIcon } from './components';
import './jetbrains.css';

interface AirPanelProps {
  api?: ModelDockApi;
  baseUrl: string;
  modelId?: string;
  aggregate: boolean;
  running: boolean;
  disabled: boolean;
  starting: boolean;
  onCopy: (value: string, message: string) => Promise<void>;
  onCopyKey: () => Promise<void>;
  onStart: () => Promise<void>;
  onPreview: () => Promise<void> | undefined;
  onExport: () => Promise<void>;
}

export function AirPanel({ api, baseUrl, modelId, aggregate, running, disabled, starting,
  onCopy, onCopyKey, onStart, onPreview, onExport }: AirPanelProps) {
  const unavailable = !api || disabled || !modelId || !baseUrl;
  return <section className="panel jetbrains-connection" data-air-connection="air" aria-labelledby="air-connection-title">
    <div className="section-heading"><h2 id="air-connection-title">Air BYOK 接入参数</h2></div>
    <dl className="jetbrains-parameters">
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
      <div className="jetbrains-parameter"><dt>模型 ID</dt><dd>
        <code>{modelId || '请选择模型'}</code>
        <button type="button" className="text-button" data-action="air-copy-model" aria-label="复制 Air 模型 ID" disabled={unavailable}
          onClick={() => modelId && void onCopy(modelId, '模型 ID 已复制。')}><Copy size={14} />复制</button>
      </dd></div>
    </dl>
    <ol className="jetbrains-air-setup" data-air-manual-setup>
      <li>在 IDE 中打开「设置 → AI → Air → Accounts → More Providers → OpenAI」。</li>
      <li>填写名称、Base URL 和 API Key，测试连接后保存。</li>
      <li>在 Air 会话中选择这个提供商和兼容的 Agent，再选择模型。</li>
    </ol>
    <div className="jetbrains-actions">
      {aggregate && !running && <button type="button" className="button small secondary" data-action="air-start-gateway"
        disabled={unavailable || starting} onClick={() => void onStart()}><BusyIcon active={starting}><Plug2 size={14} /></BusyIcon>启动本机服务</button>}
      <button type="button" className="button small secondary" data-action="preview-tool-config" disabled={unavailable}
        onClick={() => void onPreview()}><FileCode2 size={14} />预览接入参数</button>
      <button type="button" className="button small secondary" data-action="export-tool-config" disabled={unavailable}
        onClick={() => void onExport()}><ArrowDownToLine size={14} />导出参考参数</button>
    </div>
    {aggregate && <p className="jetbrains-scope-note">使用聚合接口时请保持 ModelDock 本机服务运行。</p>}
  </section>;
}
