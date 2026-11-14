import type { ToolId } from './types';

/** The configured product surface, not the number of defaults it exposes.
 * Codex's active model_provider, Claude's active gateway and the JetBrains
 * AI Assistant OpenAI-compatible slot each consume one endpoint. Air accounts
 * are managed manually in Air; this slot only prepares one account's parameters.
 * Registries and Junie's discovered model profiles support multiple sources.
 */
export const TOOL_CONNECTION_CAPABILITIES = {
  codex: 'single-endpoint',
  'claude-code': 'single-endpoint',
  webstorm: 'single-endpoint',
  'intellij-idea': 'single-endpoint',
  rider: 'single-endpoint',
  pycharm: 'single-endpoint',
  opencode: 'provider-registry',
  'opencode-desktop': 'provider-registry',
  vscode: 'provider-registry',
  copilot: 'provider-registry',
  'copilot-cli': 'provider-registry',
  dsh: 'provider-registry',
  junie: 'model-profiles',
} as const satisfies Record<ToolId, 'single-endpoint' | 'provider-registry' | 'model-profiles'>;

export function supportsMultipleSources(tool: ToolId): boolean {
  return TOOL_CONNECTION_CAPABILITIES[tool] !== 'single-endpoint';
}
