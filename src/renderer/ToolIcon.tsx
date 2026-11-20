import type { ToolId } from '../shared/types';
import codex from './assets/tool-icons/codex.svg?no-inline';
import opencode from './assets/tool-icons/opencode.svg?no-inline';
import dsh from './assets/tool-icons/dsh.svg?no-inline';
import vscode from './assets/tool-icons/vscode.svg?no-inline';
import copilot from './assets/tool-icons/copilot.svg?no-inline';
import claudeCode from './assets/tool-icons/claude-code.svg?no-inline';
import junie from './assets/tool-icons/junie.svg?no-inline';
import air from './assets/tool-icons/air.svg?no-inline';

const icons: Partial<Record<ToolId, string>> = {
  codex, opencode, 'opencode-desktop': opencode, dsh, vscode, copilot, 'copilot-cli': copilot, 'claude-code': claudeCode, junie, air,
};

/** Decorative tool identity; the adjacent tool name supplies the accessible label. */
export function ToolIcon({ tool }: { tool: ToolId }) {
  const source = icons[tool];
  if (!source) return null;
  return <span className={`tool-logo ${tool === 'copilot-cli' ? 'copilot ' : ''}${tool}`} data-tool-icon={tool} aria-hidden="true">
    <span className="tool-logo-mark" style={{ maskImage: `url("${source}")`, WebkitMaskImage: `url("${source}")` }} />
  </span>;
}
