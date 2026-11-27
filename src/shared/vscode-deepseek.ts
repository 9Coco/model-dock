import { DEEPSEEK_OPENAI_BASE, openAiBaseUrl } from './openai-endpoint';
import type { Model, Provider, ReasoningEffort } from './types';

const officialEfforts: ReasoningEffort[] = ['low', 'high', 'max'];
const models = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']);
export function isVsCodeDeepSeekModel(model: Model, provider: Provider | undefined): boolean {
  if (!models.has(model.upstreamId) || provider?.id !== model.providerId || provider.kind !== 'openai-compatible' || provider.nativeAdapter) return false;
  try {
    const url = new URL(openAiBaseUrl(provider.baseUrl));
    return url.origin === DEEPSEEK_OPENAI_BASE && !url.username && !url.password && !url.search && !url.hash
      && ['', '/v1'].includes(url.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}

export function vsCodeDeepSeekModel(model: Model, provider: Provider | undefined): Model {
  if (!isVsCodeDeepSeekModel(model, provider)) return model;
  const disabled = model.thinking === false || model.defaultReasoningEffort === 'none';
  const efforts = model.reasoningEfforts?.filter(effort => officialEfforts.includes(effort));
  const supported = efforts?.length ? efforts : officialEfforts;
  const preferred = model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort : supported.includes('high') ? 'high' : supported[0];
  return { ...model, wireApi: 'chat-completions', thinking: true,
    reasoningEfforts: disabled ? ['none'] : [...supported],
    defaultReasoningEffort: disabled ? 'none' : preferred, reasoningEffortFormat: 'chat-completions' };
}
