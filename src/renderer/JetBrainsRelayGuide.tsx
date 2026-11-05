import { ArrowDownToLine, ArrowUpRight, Server } from './MaterialIcon';

interface Props { pending: boolean; savedKey: boolean; keyFilled?: boolean; onImport: () => void; onOpenVsCode?: () => void }
export function JetBrainsRelayGuide({ pending, savedKey, onImport, onOpenVsCode }: Props) {
  return <section className="form-info jetbrains-relay-guide" aria-label="JetBrains AI 账号接入"><Server size={18} /><div>
    <strong>用 JetBrains AI 额度调用模型</strong>
    <p>在授权中心连接已登录的账号，按所选许可证校验授权与额度。模型请求通过 ModelDock 网关直接发送，生成内容会及时返回。</p>
    <p>使用时保持 ModelDock 和本地网关运行。可用模型以所导入账号和许可证为准，获取模型列表后请单独测试推理。</p>
    <button type="button" className="button small primary" data-action="import-jetbrains-account" disabled={pending} onClick={onImport}><ArrowDownToLine size={14} />连接 JetBrains 账号</button>
    <p role="status">{savedKey ? '已保存账号连接。可重新导入更新授权。' : '连接账号后自动保存，无需单独启动反代。'}</p>
    {onOpenVsCode && <button type="button" className="text-button" data-action="configure-jetbrains-vscode" onClick={onOpenVsCode}>打开 VS Code 工具配置 <ArrowUpRight size={12} /></button>}
  </div></section>;
}
