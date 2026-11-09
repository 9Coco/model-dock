import { KeyRound } from './MaterialIcon';

export function JetBrainsRelayGuide({ pending, savedKey, onImport, onOptions }: {
  pending: boolean; savedKey: boolean; onImport: () => void; onOptions: () => void;
}) {
  return <section className="form-info" aria-label="JetBrains AI 账号接入"><KeyRound size={19} /><div>
    <strong>JetBrains AI 订阅</strong>
    <p>{savedKey ? '可重新导入本机 IDE / Air 账号，更新许可证和授权。' : '从本机已登录的 JetBrains IDE 或 Air 导入账号和 AI 许可证。使用 Central CLI 可选择其他连接方式。'}</p>
    <div className="subscription-import-actions">
      <button type="button" className="button small secondary" data-action="import-jetbrains-account" disabled={pending} onClick={onImport}>从客户端导入</button>
      <button type="button" className="button small secondary" data-action="jetbrains-import-options" disabled={pending} onClick={onOptions}>其他连接方式</button>
    </div>
  </div></section>;
}
