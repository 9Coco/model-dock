import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
