import { ModelListViewport } from './ModelListViewport';
import type { ModelDockApi, Provider, Snapshot } from '../shared/types';
import { subscriptionDisplayName } from '../shared/subscription-names';
import { isPublishedGatewayModel, localGatewayBaseUrl, localModelStatus } from '../shared/local-connection';
import { CopyValue, SecretField } from './ConnectionFields';
import { Copy, Layers3, Settings2 } from './MaterialIcon';
import { EmptyState, type Notify } from './components';
import './subscription-connection.css';

const protocolLabels = { responses: 'Responses', 'chat-completions': 'Chat Completions', messages: 'Messages' };
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function SubscriptionConnection({ data, provider, api, secretRevision, copy, notify, onService }: {
  data: Snapshot; provider: Provider; api?: ModelDockApi; secretRevision: number;
  copy: (value: string, message: string) => Promise<void>; notify: Notify; onService: () => void;
}) {
  const baseUrl = localGatewayBaseUrl(data);
  const models = data.models.filter(model => model.providerId === provider.id);
  const published = models.filter(model => isPublishedGatewayModel(data, provider, model));
  const example = published[0];
  const endpoint = example?.wireApi === 'responses' ? 'responses' : example?.wireApi === 'messages' ? 'messages' : 'chat/completions';
  const body = example ? JSON.stringify({ model: example.alias, ...(example.wireApi === 'responses' ? { input: '你好' } : { messages: [{ role: 'user', content: '你好' }], ...(example.wireApi === 'messages' ? { max_tokens: 1024 } : {}) }) }) : '';
  const command = example ? [`curl ${shellQuote(`${baseUrl}/${endpoint}`)}`, ' -H "Authorization: Bearer ${MODELDOCK_API_KEY}"', " -H 'Content-Type: application/json'", ...(provider.kind === 'opencode-go' ? [' -H "x-opencode-session: ${OPENCODE_SESSION_ID}"'] : []), ` -d ${shellQuote(body)}`].join(' ') : '';
  return <section className="subscription-connection" data-subscription-connection={provider.id}>
    <div className="section-heading"><h2>本地调用方式<span className={`badge ${data.gateway.running ? 'positive' : 'neutral'}`}>{data.gateway.running ? '服务运行中' : '服务未启动'}</span></h2><button type="button" className="button small secondary" onClick={onService}><Settings2 size={14} />接口与模型</button></div>
    <div className="connection-fields"><div><h3>URL</h3><CopyValue value={baseUrl} label="本地订阅接口 URL" onCopy={copy} /></div><div><h3>API Key</h3><SecretField key={`${provider.id}:${secretRevision}`} label="本地 API Key" available={!!api} reveal={() => api!.revealGatewayKey()} copy={() => api!.copyGatewayKey()} notify={notify} /></div></div>
    <p className="subscription-connection-note">在客户端填写上方本地 URL 和本地 API Key，再选择下方模型名称。{subscriptionDisplayName(provider)} 与其他来源共用此入口，模型名称决定使用哪个来源；授权由 ModelDock 管理。发布后可发起调用，连接结果可用“测试连接”确认。</p>
    <div className="subscription-local-models"><div className="section-heading"><h3>本地模型名称<span className="count-tag">{published.length} 个已发布</span></h3><button type="button" className="button small secondary" disabled={!published.length} onClick={() => void copy(published.map(model => model.alias).join('\n'), '本地模型名称已复制。')}><Copy size={14} />复制模型列表</button></div>
      {models.length ? <ModelListViewport key={provider.id} models={models}>{visible => <table><thead><tr><th>调用时使用的模型名称</th><th>接口</th><th>状态</th></tr></thead><tbody>{visible.map(model => <tr key={model.id} data-subscription-model={model.id}><td><CopyValue value={model.alias} label={`本地模型名称 ${model.alias}`} onCopy={copy} /></td><td>{protocolLabels[model.wireApi]}</td><td><span data-local-model-status className={`badge ${data.gateway.running && isPublishedGatewayModel(data, provider, model) ? 'positive' : 'neutral'}`}>{localModelStatus(data, provider, model)}</span></td></tr>)}</tbody></table>}</ModelListViewport> : <EmptyState compact icon={<Layers3 size={22} />} title="还没有可调用的模型" description="完成授权后获取模型，并在接口与模型中发布。" />}
    </div>
    {command && <details className="subscription-call-example"><summary>调用示例</summary><p>在 Bash 或 WSL 中，把上方本地 API Key 设为环境变量 <code>MODELDOCK_API_KEY</code>，保持 ModelDock 本地服务运行，再执行此示例。{provider.kind === 'opencode-go' && <>为本次对话设置 <code>OPENCODE_SESSION_ID</code>，同一对话复用该值。</>}</p><pre data-subscription-curl>{command}</pre><button type="button" className="button small secondary" onClick={() => void copy(command, '调用示例已复制。')}><Copy size={14} />复制示例</button></details>}
  </section>;
}
