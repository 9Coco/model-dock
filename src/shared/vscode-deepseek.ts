import type { Model, Provider, ReasoningEffort } from './types';

const models = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']);
const efforts: ReasoningEffort[] = ['low', 'high', 'max'];
export const DEEPSEEK_MESSAGES_BASE = 'https://api.deepseek.com/anthropic';

function officialUrl(value: string, paths: string[]): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash
      && paths.includes(url.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}

/** Copilot's Responses implementation cannot replay DeepSeek plaintext reasoning.
 * Its native adaptive Messages implementation retains signed thinking across
 * tools AND earlier user turns. Project only the VS Code connection, never the
 * saved catalog or another tool's protocol. No unverified third-party endpoints.
 * https://api-docs.deepseek.com/guides/anthropic_api/ */
export function isVsCodeDeepSeekModel(model: Model, provider: Provider | undefined): boolean {
  return models.has(model.upstreamId) && provider?.id === model.providerId && provider.kind === 'openai-compatible' && !provider.nativeAdapter
    && officialUrl(provider.baseUrl, ['', '/v1', '/anthropic', '/anthropic/v1'])
    && (!provider.claudeBaseUrl || officialUrl(provider.claudeBaseUrl, ['/anthropic', '/anthropic/v1']));
}

export function vsCodeDeepSeekModel(model: Model, provider: Provider | undefined): Model {
  if (!isVsCodeDeepSeekModel(model, provider)) return model;
  const thinking = model.thinking !== false && model.defaultReasoningEffort !== 'none';
  // Copilot's adaptive Messages serializer cannot explicitly disable thinking.
  // Only an explicit user opt-out uses Responses none; ordinary thinking never
  // takes this path. `thinking` here advertises effort capability, not mode.
  if (!thinking) return { ...model, wireApi: 'responses', thinking: true, adaptiveThinking: false,
    reasoningEfforts: ['none'], defaultReasoningEffort: 'none', reasoningEffortFormat: 'responses' };
  const selected = model.reasoningEfforts?.filter(effort => efforts.includes(effort));
  const supported = selected?.length ? selected : efforts;
  const preferred = model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort : supported.includes('high') ? 'high' : supported[0];
  return { ...model, wireApi: 'messages', thinking: true, adaptiveThinking: true,
    reasoningEfforts: [...supported], defaultReasoningEffort: preferred,
    reasoningEffortFormat: 'messages' };
}

/** Only use after isVsCodeDeepSeekModel, inside the scoped VS Code route. */
export function vsCodeDeepSeekProvider(provider: Provider): Provider {
  return { ...provider, baseUrl: 'https://api.deepseek.com', claudeBaseUrl: DEEPSEEK_MESSAGES_BASE, messagesAuth: 'bearer' };
}
