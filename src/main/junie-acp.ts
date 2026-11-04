import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { delimiter, isAbsolute, join } from 'node:path';

export const JUNIE_ACP_NAME = 'Junie · ModelDock';
export interface JunieCommand { command: string; args: string[]; env?: Record<string, string> }
export interface JunieAcpEntry { command: string; args: string[]; env: Record<string, string> }
export interface JunieAcpValue { present: boolean; value?: unknown }

export const junieAcpTarget = (home: string): string => join(home, '.jetbrains', 'acp.json');

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function document(original: string | null): Record<string, unknown> {
  if (original === null) return {};
  let value: unknown;
  try { value = JSON.parse(original.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Junie IDE 的 acp.json 不是有效 JSON，已保留原文件。'); }
  if (!object(value) || Object.hasOwn(value, 'agent_servers') && !object(value.agent_servers)) {
    throw new Error('Junie IDE 的 acp.json 格式不受支持，已保留原文件。');
  }
  return value;
}
export function readJunieAcpEntry(original: string | null): JunieAcpValue {
  const entries = document(original).agent_servers as Record<string, unknown> | undefined;
  return entries && Object.hasOwn(entries, JUNIE_ACP_NAME) ? { present: true, value: entries[JUNIE_ACP_NAME] } : { present: false };
}

/** Callers check ownership and commit this content with the model/config transaction. */
export function mergeJunieAcp(original: string | null, desired: JunieAcpEntry | null | undefined): string | null {
  const value = document(original);
  const entries = value.agent_servers as Record<string, unknown> | undefined;
  if (!desired) {
    if (!entries || !Object.hasOwn(entries, JUNIE_ACP_NAME)) return original;
    delete entries[JUNIE_ACP_NAME];
  } else {
    if (entries && Object.hasOwn(entries, JUNIE_ACP_NAME) && isDeepStrictEqual(entries[JUNIE_ACP_NAME], desired)) return original;
    value.agent_servers = { ...entries, [JUNIE_ACP_NAME]: desired };
  }
  return JSON.stringify(value, null, 2) + '\n';
}

function executable(filename: string, windows: boolean): boolean {
  try {
    if (!lstatSync(filename).isFile()) return false;
    accessSync(filename, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve an executable, never a Windows batch file that requires shell parsing. */
export function resolveJunieCommand(home: string, options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): JunieCommand | undefined {
  const windows = (options.platform ?? process.platform) === 'win32';
  const env = options.env ?? process.env;
  const pathValue = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  const dirs = [...pathValue.split(windows ? ';' : delimiter), join(home, '.local', 'bin')];
  const filename = windows ? 'junie.exe' : 'junie';
  for (const dir of new Set(dirs)) {
    if (!isAbsolute(dir)) continue;
    const command = join(dir, filename);
    if (executable(command, windows)) return { command, args: [] };
  }
  if (!windows) return;
  // The official Windows shim is ~/.local/bin/junie.bat. Its managed current
  // pointer resolves to the native binary; passing that binary to the IDE avoids
  // cmd.exe and keeps spaces, percent signs and ampersands literal.
  const data = env.JUNIE_DATA_DIR ?? env.JUNIE_DATA ?? join(home, '.local', 'share', 'junie');
  if (!isAbsolute(data)) return;
  try {
    const current = join(data, 'current');
    const info = lstatSync(current);
    if (!info.isFile() || info.size > 256) return;
    const version = readFileSync(current, 'utf8').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(version) || version === '.' || version === '..') return;
    const command = join(data, 'versions', version, 'junie', 'junie.exe');
    if (executable(command, true)) return { command, args: [] };
  } catch { /* Junie is not installed in the managed location. */ }
}

export function buildJunieAcpEntry(profile: string, junieHome: string, launch: JunieCommand): JunieAcpEntry {
  if (!/^custom:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) || !isAbsolute(junieHome)
    || !isAbsolute(launch.command) || /[\x00-\x1f\x7f]/.test(junieHome + launch.command)
    || launch.args.some(arg => typeof arg !== 'string' || /[\x00-\x1f\x7f]/.test(arg))) {
    throw new Error('Junie IDE 的启动参数无效。');
  }
  return { command: launch.command, args: [...launch.args, '--acp', 'true', '--model', profile], env: { ...launch.env, JUNIE_HOME: junieHome } };
}
