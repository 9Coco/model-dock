import type { Model, Provider, ToolBinding } from './types';
import { resolveBindingModels, bindingConnectionPolicy } from './bindings';
export const JETBRAINS_TOOLS = {
  webstorm: { name: 'WebStorm', selectorPrefix: 'WebStorm' },
  'intellij-idea': { name: 'IntelliJ IDEA', selectorPrefix: 'IntelliJIdea' },
  rider: { name: 'Rider', selectorPrefix: 'Rider' },
  pycharm: { name: 'PyCharm', selectorPrefix: 'PyCharm' },
} as const;
export type JetBrainsToolId = keyof typeof JETBRAINS_TOOLS;
export const JETBRAINS_TOOL_IDS = Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[];
export function isJetBrainsTool(value: unknown): value is JetBrainsToolId {
  return typeof value === 'string' && Object.hasOwn(JETBRAINS_TOOLS, value);
}
/** 修改点：未确认 IDE 退出时只提供接入参数，不写正在运行的设置文件。 */
export interface JetBrainsStatus {
  tool: JetBrainsToolId;
  configDir: string | null;
  version: string | null;
  foundProfile: boolean;
  running: 'running' | 'stopped' | 'unknown';
  canApply: boolean;
  message: string;
}
export const JETBRAINS_SETTINGS_PATH = '设置 → 工具 → AI Assistant → 提供商与 API 密钥';
/** Separate tool-scoped permissions even though the IDEs share an Assistant schema. */
export function jetBrainsBaseUrl(tool: JetBrainsToolId, port: number): string {
  return `http://127.0.0.1:${port}/tool/${tool}/v1`;
}

/** 修改点：同一连接规则用于参数页面和配置文件；返回值从不含凭据。 */
export function jetBrainsConnectionParameters(binding: ToolBinding, models: readonly Model[], providers: readonly Provider[], port: number): {
  kind: 'direct-api' | 'local-managed'; baseUrl: string; modelId: string; modelIds: string[];
} {
  const scoped = resolveBindingModels(binding, [...models], [...providers]);
  const policy = bindingConnectionPolicy(binding, [...models], [...providers]);
  const nativeReady = policy.groups[0]?.connection === 'direct-api';
  const direct = binding.mode === 'direct' || nativeReady;
  const provider = providers.find(item => item.id === binding.providerIds?.[0]);
  const chosen = scoped.find(model => model.id === binding.defaultModelId) ?? scoped[0];
  return { kind: direct ? 'direct-api' : 'local-managed', baseUrl: nativeReady && provider ? nativeJetBrainsBaseUrl(provider) ?? provider.baseUrl.replace(/\/+$/, '') : direct ? '' : jetBrainsBaseUrl(binding.id as JetBrainsToolId, port),
    modelId: chosen ? direct ? chosen.upstreamId : chosen.alias : '', modelIds: scoped.map(model => direct ? model.upstreamId : model.alias) };
}
/** Official dual-protocol endpoints only; custom Responses endpoints are never guessed. */
export function nativeJetBrainsBaseUrl(provider: Provider): string | undefined {
  if (provider.kind !== 'openai-compatible') return;
  const endpoints: Record<string, readonly string[]> = {
    deepseek: ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
    'volcengine-agent': ['https://ark.cn-beijing.volces.com/api/plan/v3'],
    'volcengine-token': ['https://ark.cn-beijing.volces.com/api/coding/v3'],
    'qwen-token': ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://coding.dashscope.aliyuncs.com/v1'],
  };
  try {
    const url = new URL(provider.baseUrl);
    if (url.username || url.password || url.search || url.hash) return;
    const canonical = url.href.replace(/\/+$/, '');
    return endpoints[provider.presetId ?? '']?.find(endpoint => endpoint === canonical);
  } catch { return; }
}
