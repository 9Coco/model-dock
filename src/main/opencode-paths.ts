import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ToolId } from '../shared/types';

export function isOpenCodeTool(tool: ToolId): tool is 'opencode' | 'opencode-desktop' {
  return tool === 'opencode' || tool === 'opencode-desktop';
}
export interface OpenCodePathOptions {
  configHome?: string;
  openCodeConfigFile?: string;
  openCodeConfigDir?: string;
  openCodeConfigContent?: string;
}

function xdgHome(value: string | undefined, fallback: string): string {
  // 修改点：XDG 根必须是绝对路径；空值或相对路径使用客户端默认目录。
  const trimmed = value?.trim();
  return trimmed && isAbsolute(trimmed) ? trimmed : fallback;
}
/** Explicit homes isolate fixtures from the current desktop's XDG variables. */
export function openCodeConfigDirectory(homeDirectory?: string, configHome?: string): string {
  const home = homeDirectory ?? homedir();
  const root = configHome ?? (homeDirectory === undefined ? process.env.XDG_CONFIG_HOME : undefined);
  return join(resolve(xdgHome(root, join(home, '.config'))), 'opencode');
}

/** Desktop's default local server uses the global profile. Shell-only TUI
 * overrides must never redirect the Desktop button to another profile. */
export function openCodeConfigTargets(tool: ToolId, homeDirectory: string, options: OpenCodePathOptions = {}): { target: string; paths: string[] } {
  let directory = openCodeConfigDirectory(homeDirectory, options.configHome);
  if (tool === 'opencode') {
    if (options.openCodeConfigContent?.trim()) throw new Error('OpenCode TUI 设置了 OPENCODE_CONFIG_CONTENT，文件可能被内联配置覆盖。请清除该覆盖后同步，或导出并手动合并。');
    const absolute = (value: string | undefined, name: string) => {
      if (!value?.trim()) return undefined;
      if (!isAbsolute(value.trim())) throw new Error(`${name} 必须是绝对路径，未修改 OpenCode 配置。`);
      return resolve(value.trim());
    };
    const customDir = absolute(options.openCodeConfigDir, 'OPENCODE_CONFIG_DIR');
    const customFile = absolute(options.openCodeConfigFile, 'OPENCODE_CONFIG');
    if (customDir) directory = customDir;
    else if (customFile) return { target: customFile, paths: [customFile] };
  }
  const jsonc = join(directory, 'opencode.jsonc'), json = join(directory, 'opencode.json');
  return { target: existsSync(jsonc) ? jsonc : json, paths: [jsonc, json] };
}
