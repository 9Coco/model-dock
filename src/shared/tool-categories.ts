import type { ToolId } from './types';
import type { JetBrainsToolId } from './jetbrains';

export type ToolCategory = 'editor' | 'tui' | 'desktop';
export const toolCategories: { id: ToolCategory; label: string }[] = [
  { id: 'editor', label: '编辑器' }, { id: 'tui', label: 'TUI' }, { id: 'desktop', label: '桌面 App' },
];
const categories = {
  codex: 'desktop', 'claude-code': 'tui', junie: 'tui', opencode: 'tui',
  'opencode-desktop': 'desktop', dsh: 'desktop', vscode: 'editor', air: 'editor',
  copilot: 'desktop', 'copilot-cli': 'tui',
} as const satisfies Record<Exclude<ToolId, JetBrainsToolId>, ToolCategory>;
type ActiveToolId = keyof typeof categories;
export const activeToolIds = Object.keys(categories) as ActiveToolId[];
export function isActiveToolId(tool: unknown): tool is ActiveToolId {
  return typeof tool === 'string' && Object.hasOwn(categories, tool);
}
export const toolCategoryFor = (tool: ToolId): ToolCategory | undefined => isActiveToolId(tool) ? categories[tool] : undefined;
