import type { ToolId } from './types';

/** Both OpenCode clients support independent provider entries without aggregation. */
export function isOpenCodeTool(tool: ToolId): tool is 'opencode' | 'opencode-desktop' {
  return tool === 'opencode' || tool === 'opencode-desktop';
}
