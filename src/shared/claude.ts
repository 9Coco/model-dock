import type { Model, Provider } from './types';

/** 修改点：官方套餐的两种协议使用不同入口，但共享同一供应商与 API Key。
 * 只匹配明确的域名/完整路径，不能凭预设名把用户的自定义服务重定向到官方。
 */
const officialEndpoints: Record<string, readonly [string, string][]> = {
  deepseek: [
    ['https://api.deepseek.com', 'https://api.deepseek.com/anthropic'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/anthropic'],
  ],
  'volcengine-agent': [['https://ark.cn-beijing.volces.com/api/plan/v3', 'https://ark.cn-beijing.volces.com/api/plan']],
  'volcengine-token': [['https://ark.cn-beijing.volces.com/api/coding/v3', 'https://ark.cn-beijing.volces.com/api/coding']],
  'qwen-token': [
    ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'],
    ['https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic'],
    ['https://coding.dashscope.aliyuncs.com/v1', 'https://coding.dashscope.aliyuncs.com/apps/anthropic'],
    ['https://coding-intl.dashscope.aliyuncs.com/v1', 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic'],
  ],
};
function canonical(value: string): string | undefined {
  try { const url = new URL(value); if (url.username || url.password || url.search || url.hash) return; return url.href.replace(/\/+$/, ''); } catch { return; }
}
export function nativeClaudeBaseUrl(provider: Provider): string | undefined {
  if (provider.kind !== 'openai-compatible') return;
  if (provider.claudeBaseUrl?.trim()) return provider.claudeBaseUrl.trim();
  if (provider.presetId === 'anthropic') return provider.baseUrl;
  const source = canonical(provider.baseUrl);
  return officialEndpoints[provider.presetId ?? '']?.find(([base]) => canonical(base) === source)?.[1];
}
/** 已知官方双协议入口可复用现有模型；订阅与普通 OpenAI API 通过本机桥接。
 * 未知原生 Messages 来源仅发布其 Messages 模型，避免把混合协议当作兼容。
 */
export function claudeModelsForProvider(provider: Provider, models: readonly Model[]): Model[] {
  const enabled = models.filter(model => model.providerId === provider.id && model.enabled);
  if (provider.kind === 'openai-compatible' && nativeClaudeBaseUrl(provider)) return enabled;
  if (provider.kind === 'openai-compatible' && enabled.some(model => model.wireApi === 'messages')) return enabled.filter(model => model.wireApi === 'messages');
  return enabled.filter(model => model.wireApi !== 'messages');
}
export function claudeConnectionKind(provider: Provider, models: readonly Model[]): 'direct-api' | 'local-managed' {
  return provider.kind === 'openai-compatible' && (nativeClaudeBaseUrl(provider) || models.length > 0 && models.every(model => model.wireApi === 'messages')) ? 'direct-api' : 'local-managed';
}
