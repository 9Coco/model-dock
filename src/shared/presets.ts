import type { ProviderPreset } from './types';

/** Provider templates set connection defaults, never entitlement or a fake catalog. */
export const providerPresets: ProviderPreset[] = [
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
  { id: 'custom', name: '自定义 API', category: 'api', kind: 'openai-compatible', baseUrl: '', defaultWireApi: 'chat-completions', note: '填写兼容接口地址、密钥，再发现或添加实际模型，并选择对应的调用协议。', docsUrl: '' },
  { id: 'codex-subscription', name: 'Codex 订阅', category: 'subscription', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', defaultWireApi: 'responses',
    note: '使用本人 ChatGPT/Codex 账号授权，凭据由 ModelDock 管理续期。', docsUrl: 'https://developers.openai.com/codex/auth/' },
  { id: 'copilot-subscription', name: 'GitHub Copilot 订阅', category: 'subscription', kind: 'copilot', baseUrl: 'https://api.githubcopilot.com', defaultWireApi: 'chat-completions',
    note: '使用本人 GitHub Copilot 订阅；可选择已登录账号或保存后登录，授权由本地入口管理，按模型实际支持的接口转发。', docsUrl: 'https://github.com/github/copilot-sdk' },
  { id: 'grok-build', name: 'Grok Build 订阅', category: 'subscription', kind: 'grok', baseUrl: 'https://cli-chat-proxy.grok.com/v1', defaultWireApi: 'responses',
    note: '使用本人 Grok Build 套餐账号授权，凭据由 ModelDock 管理续期。', docsUrl: 'https://x.ai/news/grok-opencode' },
];
export function presetById(id: string | undefined) { return providerPresets.find(preset => preset.id === id); }
