import { SUBSCRIPTION_NAMES } from './subscription-names';
import type { Provider, ProviderPreset } from './types';

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const TRAE_RELAY_BASE_URL = 'http://127.0.0.1:18080/v1';
export const JETBRAINS_RELAY_BASE_URL = 'http://127.0.0.1:18081/v1';
export const JETBRAINS_CENTRAL_SETUP_URL = 'https://www.jetbrains.com/help/central-cli/cli-setup.html';

export function isLocalTraeRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Provider templates set connection defaults, never entitlement or a fake catalog. */
export const providerPresets: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI 官方 API', category: 'api', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', defaultWireApi: 'responses',
    note: '使用 OpenAI 平台 API Key 和 API 额度；默认 Responses，也可为兼容模型选择 Chat Completions。获取模型列表后选择需要的模型，实际可用性以账号权限和调用结果为准。', docsUrl: 'https://developers.openai.com/api/docs/quickstart' },
  { id: 'anthropic', name: 'Anthropic / Claude 兼容 API', category: 'api', kind: 'openai-compatible', baseUrl: 'https://api.anthropic.com', defaultWireApi: 'messages',
    note: '使用 Anthropic Messages 接口；第三方中转请填写其兼容接口基址和 API Key，不能使用仅支持 OpenAI 的地址。', docsUrl: 'https://code.claude.com/docs/en/llm-gateway-connect' },
  { id: 'deepseek', name: 'DeepSeek', category: 'api', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com', defaultWireApi: 'responses',
    note: '使用 DeepSeek 开放平台 API Key。模型以账号实际权限和调用结果为准。', docsUrl: 'https://api-docs.deepseek.com/' },
  { id: 'volcengine-agent', name: '火山 Agent Plan', category: 'api', kind: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', defaultWireApi: 'responses',
    note: 'Agent Plan 专属地址及专属 Key；不要混用按量 API 或其他套餐地址。', docsUrl: 'https://docs.volcengine.com/docs/ark/agent-plan-personal-get-started' },
  { id: 'volcengine-token', name: '火山 Coding Plan', category: 'api', kind: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultWireApi: 'responses',
    note: '对应你所说的火山 Token 编程套餐，使用 Coding Plan 专属地址和套餐账号的方舟 API Key；不要混用 Agent Plan 的凭据或按量调用地址。', docsUrl: 'https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-other-tools?lang=zh' },
  { id: 'qwen-token', name: '千问 Token Plan', category: 'api', kind: 'openai-compatible', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', defaultWireApi: 'chat-completions',
    note: '默认中国北京 Token Plan 个人/团队端点，使用套餐专属 Key；国际地区需改为控制台对应地址。', docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start' },
  { id: 'trae-cn-relay', name: SUBSCRIPTION_NAMES['trae-cn-relay'], category: 'subscription', kind: 'openai-compatible', baseUrl: TRAE_RELAY_BASE_URL, defaultWireApi: 'chat-completions',
    note: '从本机 TRAE 中国版或 SOLO 中国版导入本人账号，由内置适配器接入 ModelDock 网关，再查询官方套餐、额度与实际模型。', docsUrl: '' },
  { id: 'jetbrains-central', name: SUBSCRIPTION_NAMES['jetbrains-central'], category: 'subscription', kind: 'openai-compatible', baseUrl: JETBRAINS_RELAY_BASE_URL, defaultWireApi: 'chat-completions',
    note: '从 IDE / Air 或 Central 的个人 AI 许可证导入授权，由内置适配器直接连接官方服务并接入现有网关。', docsUrl: JETBRAINS_CENTRAL_SETUP_URL },
  { id: 'custom', name: '自定义 API', category: 'api', kind: 'openai-compatible', baseUrl: '', defaultWireApi: 'chat-completions', note: '填写兼容接口地址、密钥，再发现或添加实际模型，并选择对应的调用协议。', docsUrl: '' },
  { id: 'codex-subscription', name: SUBSCRIPTION_NAMES.codex, category: 'subscription', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', defaultWireApi: 'responses',
    note: '使用本人 ChatGPT/Codex 账号授权，凭据由 ModelDock 管理续期。', docsUrl: 'https://developers.openai.com/codex/auth/' },
  { id: 'copilot-subscription', name: SUBSCRIPTION_NAMES.copilot, category: 'subscription', kind: 'copilot', baseUrl: 'https://api.githubcopilot.com', defaultWireApi: 'chat-completions',
    note: '使用本人 GitHub Copilot 订阅；可选择已登录账号或保存后登录，授权由本地入口管理，按模型实际支持的接口转发。', docsUrl: 'https://github.com/github/copilot-sdk' },
  { id: 'opencode-go', name: 'OpenCode Go 订阅', category: 'subscription', kind: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL, defaultWireApi: 'chat-completions',
    note: '填写已开通 Go 套餐的工作区 API Key，通过 ModelDock 网关调用订阅模型。', docsUrl: 'https://opencode.ai/docs/console/go/' },
  { id: 'grok-build', name: SUBSCRIPTION_NAMES.grok, category: 'subscription', kind: 'grok', baseUrl: 'https://cli-chat-proxy.grok.com/v1', defaultWireApi: 'responses',
    note: '使用本人 Grok Build 套餐账号授权，凭据由 ModelDock 管理续期。', docsUrl: 'https://x.ai/news/grok-opencode' },
];
export function presetById(id: string | undefined) { return providerPresets.find(preset => preset.id === id); }

/** Presentation category is independent of the transport used by a subscription relay. */
export function providerCategory(provider: Pick<Provider, 'kind' | 'presetId'>): ProviderPreset['category'] {
  if (provider.kind !== 'openai-compatible') return 'subscription';
  return presetById(provider.presetId)?.category ?? 'api';
}

export function isRelayProvider(provider: Pick<Provider, 'kind' | 'presetId'>): boolean {
  return provider.kind === 'openai-compatible' && (provider.presetId === 'trae-cn-relay' || provider.presetId === 'jetbrains-central');
}
