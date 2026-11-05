import type { Model, Provider } from '../shared/types';
import { presetById, providerCategory } from '../shared/presets';
import './connection-principles.css';

const wireLabels = { responses: 'Responses', 'chat-completions': 'Chat Completions', messages: 'Messages' };
const displayUrl = (value: string) => {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return '尚未配置'; }
};

/** Upstream transport details belong in an explicit explanation, away from local connection parameters. */
export function ConnectionPrinciples({ providers, models }: { providers: Provider[]; models: Model[] }) {
  const subscriptions = providers.filter(provider => providerCategory(provider) === 'subscription');
  const subscriptionModels = models.filter(model => subscriptions.some(provider => provider.id === model.providerId));
  return <section className="settings-section"><details className="panel connection-principles" data-connection-principles><summary>连接原理</summary><div className="connection-principles-body">
    <p>普通 API 可以按工具支持情况直接连接供应商。订阅通过 ModelDock 的本地接口调用，客户端使用本地 API Key 和本地模型名称；账号授权及续期留在 ModelDock 内。</p>
    <p>本地通用入口是同一个 <code>/v1</code> 地址，模型名称决定请求发往哪家供应商。接口与模型页控制此入口的发布范围；各工具的专用入口采用对应工具里的选择。</p>
    <dl className="connection-principles-flows"><div><dt>账号订阅</dt><dd>客户端 → ModelDock → 已授权的订阅服务。ModelDock 按模型的实际接口转发请求；Messages 工具可使用本机协议适配。</dd></div><div><dt>TRAE 中国版反代</dt><dd>客户端 → ModelDock → TRAE 反代 → TRAE 服务。托管模式由 ModelDock 启动本机 Docker 服务，也可以连接手动管理的反代。TRAE 账号在反代的授权页登录。</dd></div><div><dt>JetBrains AI 会员反代</dt><dd>客户端 → ModelDock → 独立 Pi 会话 → JetBrains Central CLI 已授权的模型服务。需要先完成 Central 登录；本机反代提供 Chat Completions。启动反代或获取模型列表不能证明账号有可用额度。</dd></div></dl>
    <h3>订阅上游连接</h3><p>这些地址供排查连接使用。客户端接入时，请复制供应商详情中的本地调用参数。</p>
    {subscriptions.length ? <div className="table-scroll"><table><thead><tr><th>订阅</th><th>上游地址</th><th>已配置模型接口</th></tr></thead><tbody>{subscriptions.map(provider => {
      const protocols = [...new Set(models.filter(model => model.providerId === provider.id).map(model => model.wireApi))];
      const fallback = presetById(provider.presetId)?.defaultWireApi;
      return <tr key={provider.id} data-principle-provider={provider.id}><td>{provider.name}</td><td><code>{provider.baseUrl ? displayUrl(provider.baseUrl) : '尚未配置'}</code></td><td>{protocols.length ? protocols.map(protocol => wireLabels[protocol]).join('、') : fallback ? `${wireLabels[fallback]}（默认，尚未配置模型）` : '尚未配置模型'}</td></tr>;
    })}</tbody></table></div> : <p className="connection-principles-empty">添加订阅后，这里会列出其上游连接。</p>}
    <details className="connection-model-mapping" data-connection-model-mapping><summary>模型映射<span className="count-tag">{subscriptionModels.length}</span></summary>{subscriptionModels.length ? <div className="table-scroll"><table><thead><tr><th>本地模型名称</th><th>上游模型 ID</th><th>所属订阅</th></tr></thead><tbody>{subscriptionModels.map(model => <tr key={model.id} data-principle-model={model.id}><td><code>{model.alias}</code></td><td><code>{model.upstreamId}</code></td><td>{subscriptions.find(provider => provider.id === model.providerId)?.name}</td></tr>)}</tbody></table></div> : <p>还没有订阅模型映射。</p>}</details>
  </div></details></section>;
}
