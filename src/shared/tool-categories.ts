import type { ToolId } from './types';

export type ToolCategory = 'editor' | 'tui' | 'desktop';
export const toolCategories: { id: ToolCategory; label: string }[] = [
  { id: 'editor', label: '编辑器' }, { id: 'tui', label: 'TUI' }, { id: 'desktop', label: '桌面 App' },
];
// Classify the configured product entry. Shared CLI/IDE integrations retain
// one binding; OpenCode has explicit Desktop and TUI targets.
const categories: Record<ToolId, ToolCategory> = {
  vscode: 'editor', webstorm: 'editor', 'intellij-idea': 'editor', rider: 'editor', pycharm: 'editor',
  'claude-code': 'tui', junie: 'tui', opencode: 'tui', 'copilot-cli': 'tui',
  codex: 'desktop', dsh: 'desktop', copilot: 'desktop', 'opencode-desktop': 'desktop',
};
export const toolCategoryFor = (tool: ToolId): ToolCategory => categories[tool];
