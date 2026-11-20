import type { ToolId } from './types';

/** An active Codex connection, Claude gateway, or prepared Air account each
 * consume one endpoint. The legacy JetBrains routes keep the same constraint.
 * Registries and Junie's discovered model profiles support multiple sources.
 */
export const TOOL_CONNECTION_CAPABILITIES = {
  codex: 'single-endpoint',
  'claude-code': 'single-endpoint',
  air: 'single-endpoint',
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
