import type { AuthAccountKind } from './auth-types';
import type { Provider } from './types';

export const SUBSCRIPTION_NAMES: Record<AuthAccountKind, string> = {
  grok: 'Grok 订阅', copilot: 'GitHub Copilot 订阅', codex: 'Codex 订阅',
  'trae-cn-relay': 'TRAE CN 订阅', 'jetbrains-central': 'JetBrains AI 订阅',
};

const legacyNames: Record<AuthAccountKind, readonly string[]> = {
  codex: ['ChatGPT / OpenAI 账号', 'Codex 订阅', 'Codex订阅', 'Codex · 客户端导入'],
  grok: ['xAI / Grok 账号', 'Grok 订阅', 'Grok订阅', 'Grok Build 订阅', 'Grok Build订阅', 'Grok Build · 客户端导入'],
  copilot: ['GitHub Copilot 订阅', 'GitHub Copilot订阅', 'GitHub Copilot', 'GitHub Copilot · 客户端导入'],
  'trae-cn-relay': ['TRAE CN 订阅', 'TRAE CN订阅', 'TRAE 中国版反代', 'TRAE 中国版 · 客户端导入', 'TRAE 中国版反代 · 客户端导入'],
  'jetbrains-central': ['JetBrains AI 订阅', 'JetBrains AI订阅', 'JetBrains AI 会员反代', 'JetBrains AI · IDE 导入', 'JetBrains AI · Central 导入', 'JetBrains AI 会员反代 · 客户端导入'],
};

/** A display alias for exact historical defaults only. Stored names, custom
 * labels and API suppliers remain untouched, including names containing one
 * of these brand names as only part of a longer label. */
export function subscriptionDisplayName(provider: Pick<Provider, 'name' | 'kind' | 'presetId'>): string {
  const kind: AuthAccountKind | undefined = provider.kind === 'codex' && (!provider.presetId || provider.presetId === 'codex-subscription') ? 'codex'
    : provider.kind === 'grok' && (!provider.presetId || provider.presetId === 'grok-build') ? 'grok'
      : provider.kind === 'copilot' && (!provider.presetId || provider.presetId === 'copilot-subscription') ? 'copilot'
        : provider.kind === 'openai-compatible' && (provider.presetId === 'trae-cn-relay' || provider.presetId === 'jetbrains-central') ? provider.presetId : undefined;
  if (!kind) return provider.name;
  for (const legacy of legacyNames[kind]) {
    if (provider.name === legacy) return SUBSCRIPTION_NAMES[kind];
    if (provider.name.startsWith(legacy + ' ')) {
      const suffix = provider.name.slice(legacy.length + 1);
      if (/^[1-9]\d*$/.test(suffix)) return `${SUBSCRIPTION_NAMES[kind]} ${suffix}`;
    }
  }
  const accountPrefix = kind === 'codex' ? 'ChatGPT / OpenAI 账号 ' : kind === 'grok' ? 'xAI / Grok 账号 ' : undefined;
  if (accountPrefix && provider.name.startsWith(accountPrefix)) {
    const suffix = provider.name.slice(accountPrefix.length);
    if (/^[1-9]\d*$/.test(suffix)) return `${SUBSCRIPTION_NAMES[kind]} ${suffix}`;
  }
  return provider.name;
}
