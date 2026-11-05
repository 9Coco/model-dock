import { JETBRAINS_CENTRAL_SETUP_URL, JETBRAINS_RELAY_BASE_URL } from '../shared/presets';
import { ArrowUpRight, Power, Server } from './MaterialIcon';

interface Props {
  pending: boolean;
  savedKey: boolean;
  keyFilled?: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpenVsCode?: () => void;
}

export function JetBrainsRelayGuide({ pending, savedKey, keyFilled, onStart, onStop, onOpenVsCode }: Props) {
  return <section className="form-info jetbrains-relay-guide" aria-label="JetBrains AI 会员反代">
    <Server size={18} />
    <div>
      <strong>用 JetBrains AI 额度调用模型</strong>
      <p>从授权中心导入 IDE 账号后，可按需启动本机中转并获取兼容模型，无需安装 Central CLI。访问授权与额度由官方服务校验。</p>
      <p>使用 Central 来源时，需单独安装 Central CLI 和 Pi CLI，并完成 <code>central login</code>。
        {' '}<a href={JETBRAINS_CENTRAL_SETUP_URL} target="_blank" rel="noopener noreferrer">Central 官方说明 <ArrowUpRight size={12} /></a>
      </p>
      <p>本机 Chat Completions 地址为 <code>{JETBRAINS_RELAY_BASE_URL}</code>。使用时保持 ModelDock 运行；实际兼容模型取决于所导入账号与 AI 许可证。</p>
      <div className="row-actions">
        <button type="button" className="button small primary" data-action="start-jetbrains-relay" disabled={pending} onClick={onStart}><Power size={14} />启动本机反代</button>
        <button type="button" className="button small secondary" data-action="stop-jetbrains-relay" disabled={pending} onClick={onStop}>停止反代</button>
      </div>
      <p role="status">{pending ? '正在操作本机反代…' : keyFilled ? '本机密钥已填入，保存供应商后生效。' : savedKey ? '已保存本机密钥。' : '启动后自动填入本机密钥。'}</p>
      {onOpenVsCode ? <>
        <p>获取模型列表，添加并启用要使用的模型，再测试连接。在 VS Code 工具页勾选此供应商。使用聚合接口时，还需勾选要提供给 VS Code 的模型。同步后在 Copilot Chat 中选择模型。</p>
        <button type="button" className="text-button" data-action="configure-jetbrains-vscode" onClick={onOpenVsCode}>打开 VS Code 工具配置 <ArrowUpRight size={12} /></button>
      </> : <p>保存后获取模型列表并测试连接。VS Code 通过 ModelDock 接入，实际可调用的模型由 JetBrains 许可决定。</p>}
    </div>
  </section>;
}
