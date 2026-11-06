/** Versioned client-menu snapshot, not an inference allowlist.
 *
 * Source: JetBrains IDE 2026.2 / ej-262.2144.130.jar, public
 * ModelOption.Specific + LLM.jbaiId. JunieModelConfigurableKt's
 * pluginSelectableModels(null) keeps !isDeprecated; ModelRegistry.Limited
 * compares exact JBAIId values. Vendor nativeId and modelName are not aliases.
 *
 * Only intersect these IDs with the account's actual compatible Chat profiles.
 * Composite/agent-specific menu options do not represent a single Grazie Chat
 * profile. A different IDE/plugin release can have a different menu; updating
 * this snapshot requires checking that release's public menu and ID mapping.
 */
const currentClientProfileIds = new Set([
  'anthropic-claude-fable-5-1',
  'claude-opus-5',
  'anthropic-claude-opus-5-5',
  'anthropic-claude-sonnet-5',
  'anthropic-claude-sonnet-5-5',
  'anthropic-claude-haiku-5-5',
  'google-gemini-3-6-flash',
  'google-gemini-3-7-flash',
  'google-gemini-3-8-flash',
  'google-gemini-4-argon',
  'openai-gpt-5-6-luna',
  'openai-gpt-5-6-sol',
  'openai-gpt-5-6-terra',
  'openai-gpt-6-astra',
  'openai-gpt-6-sol',
  'openai-gpt-6-1-sol',
  'openai-gpt-6-luna',
  'xai-grok-4-6',
  'xai-grok-4-7',
]);

export const jetBrainsClientModelHistory = Object.freeze({
  source: 'jetbrains-client' as const,
  currentVerified: true as const,
  message: '按当前支持的 IDE 2026.2 / Junie 单模型菜单筛选；复合或专用 Agent 选项不在本通用接口中。其他可读取档案可勾选“显示历史模型”查看。',
});

export function jetBrainsClientModelVisibility(profileId: string): 'current' | 'historical' {
  return currentClientProfileIds.has(profileId) ? 'current' : 'historical';
}
