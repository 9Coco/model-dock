import type { ToolId } from '../shared/types';
import codex from './assets/tool-icons/codex.svg?no-inline';
import opencode from './assets/tool-icons/opencode.svg?no-inline';
import dsh from './assets/tool-icons/dsh.svg?no-inline';
import vscode from './assets/tool-icons/vscode.svg?no-inline';
import copilot from './assets/tool-icons/copilot.svg?no-inline';
import claudeCode from './assets/tool-icons/claude-code.svg?no-inline';

import webstorm from './assets/tool-icons/webstorm.svg?no-inline';
import intellijIdea from './assets/tool-icons/intellij-idea.svg?no-inline';
import rider from './assets/tool-icons/rider.svg?no-inline';
import pycharm from './assets/tool-icons/pycharm.svg?no-inline';

const icons: Record<ToolId, string> = { codex, opencode, dsh, vscode, copilot, 'claude-code': claudeCode, webstorm, 'intellij-idea': intellijIdea, rider, pycharm };

/** Decorative tool identity; the adjacent tool name supplies the accessible label. */
export function ToolIcon({ tool }: { tool: ToolId }) {
  return <span className={`tool-logo ${tool}`} data-tool-icon={tool} aria-hidden="true">
    <span className="tool-logo-mark" style={{ maskImage: `url("${icons[tool]}")`, WebkitMaskImage: `url("${icons[tool]}")` }} />
  </span>;
}
