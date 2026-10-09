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
export function jetBrainsConnectionParameters(binding: import('./types').ToolBinding, models: readonly import('./types').Model[], providers: readonly import('./types').Provider[], port: number): {
  kind: 'direct-api' | 'local-managed'; baseUrl: string; modelId: string; modelIds: string[];
} {
  let scoped = binding.enabled ? models.filter(model => model.enabled && model.wireApi !== 'messages'
    && providers.some(provider => provider.id === model.providerId && provider.enabled)
    && (binding.providerIds === undefined ? binding.modelIds.includes(model.id) : (binding.mode === 'direct' ? binding.providerIds.slice(0, 1) : binding.providerIds).includes(model.providerId))) : [];
  if (binding.modelSelection === 'selected' || binding.modelSelection !== 'all' && binding.modelIds.length) scoped = scoped.filter(model => binding.modelIds.includes(model.id));
  if (binding.mode === 'direct' && binding.providerIds === undefined && scoped.length) scoped = scoped.filter(model => model.providerId === scoped[0].providerId);
  const providerIds = [...new Set(binding.providerIds ?? scoped.map(model => model.providerId))];
  const provider = providers.find(item => item.id === providerIds[0]);
  const direct = binding.mode === 'direct' && providerIds.length === 1 && provider?.kind === 'openai-compatible' && scoped.length > 0 && scoped.every(model => model.wireApi === 'chat-completions');
  const chosen = scoped.find(model => model.id === binding.defaultModelId) ?? scoped[0];
  return { kind: direct ? 'direct-api' : 'local-managed', baseUrl: direct ? provider!.baseUrl.replace(/\/+$/, '') : jetBrainsBaseUrl(binding.id as JetBrainsToolId, port),
    modelId: chosen ? direct ? chosen.upstreamId : chosen.alias : '', modelIds: scoped.map(model => direct ? model.upstreamId : model.alias) };
}
