import type { ToolId } from '../shared/types';
import codex from './assets/tool-icons/codex.svg?no-inline';
import opencode from './assets/tool-icons/opencode.svg?no-inline';
import dsh from './assets/tool-icons/dsh.svg?no-inline';
import vscode from './assets/tool-icons/vscode.svg?no-inline';
import copilot from './assets/tool-icons/copilot.svg?no-inline';
import claudeCode from './assets/tool-icons/claude-code.svg?no-inline';

const icons: Record<ToolId, string> = { codex, opencode, dsh, vscode, copilot, 'claude-code': claudeCode };

/** Decorative tool identity; the adjacent tool name supplies the accessible label. */
export function ToolIcon({ tool }: { tool: ToolId }) {
  return <span className={`tool-logo ${tool}`} data-tool-icon={tool} aria-hidden="true">
    <span className="tool-logo-mark" style={{ maskImage: `url("${icons[tool]}")`, WebkitMaskImage: `url("${icons[tool]}")` }} />
  </span>;
}
