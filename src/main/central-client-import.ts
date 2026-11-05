import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface CentralCommandResult { exitCode: number | null; stdout: string; stderr: string }
export interface CentralCommandOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }
export type CentralCommandRunner = (executable: string, args: readonly string[], options: CentralCommandOptions) => Promise<CentralCommandResult>;
export interface CentralClientVerification { client: 'central-cli'; authorization: 'verified'; verifiedAt: string }
export interface CentralClientImportOptions {
  homeDir?: string;
  run?: CentralCommandRunner;
  resolveExecutable?: () => Promise<string | undefined>;
  now?: () => number;
}

const messages = {
  'not-installed': '未找到 JetBrains Central CLI。请先安装 Central CLI，并在客户端执行 central login；不能从 IDE 登录状态直接导入。',
  'not-logged-in': 'JetBrains Central CLI 尚未登录或授权已过期。请先在客户端完成 central login，再重试导入。',
  'status-unavailable': '无法确认 Central CLI 的登录状态。请在客户端检查 central status 后重试。',
  'authorization-failed': 'Central CLI 当前授权未通过验证。请在客户端执行 central limit --json 检查登录、会员权限或网络，再重试。',
  'unsupported-response': '无法识别 Central CLI 返回的授权验证结果。请更新 Central CLI 后重试。',
} as const;
export class CentralClientImportError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'CentralClientImportError'; }
}

// Only Central reads its encrypted credential store and system keychain. Keep
// native network/keychain access, but exclude vendor tokens and shell hooks.
function commandEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|USER|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|TMP|TEMP|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR)|DBUS_SESSION_BUS_ADDRESS|GNOME_KEYRING_CONTROL|DISPLAY|WAYLAND_DISPLAY|LANG|LC_[A-Z_]+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i;
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && allowed.test(name)));
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  return env;
}

async function centralExecutable(home: string): Promise<string | undefined> {
  const dirs = [...new Set([...(process.env.PATH ?? '').split(delimiter), join(home, '.local', 'bin'), process.env.NVM_BIN].filter((value): value is string => !!value && isAbsolute(value)))];
  for (const dir of dirs) {
    const path = join(dir, process.platform === 'win32' ? 'central.exe' : 'central');
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return path;
    } catch { /* Try the next standard CLI location. */ }
  }
}

const nativeRun: CentralCommandRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, failed = false;
  const fail = () => { if (failed) return; failed = true; child.kill(); reject(new Error('Central command unavailable')); };
  const timer = setTimeout(fail, options.timeoutMs); timer.unref();
  const collect = (chunks: Buffer[]) => (part: Buffer) => {
    size += part.length;
    if (size > options.maxOutputBytes) { fail(); return; }
    chunks.push(part);
  };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  child.once('error', () => { clearTimeout(timer); fail(); });
  child.once('close', code => {
    clearTimeout(timer);
    if (!failed) resolve({ exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
});

function plain(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''); }
function loggedIn(output: string): boolean | undefined {
  const text = plain(output);
  if (/Authentication (?:can't|cannot|could not) be refreshed/i.test(text)) return false;
  const lines = [...text.matchAll(/(?:^|\n)[^\w\n]*Auth[ \t]+([^\n]*)/gi)];
  if (lines.length !== 1) return;
  const state = lines[0][1].trim();
  if (/^(?:not connected|not logged in|logged out|expired|error)\b/i.test(state)) return false;
  if (/^(?:logged in(?:\s|\(|$)|connected to\s+\S)/i.test(state)) return true;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function amount(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 80 && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}
function validAllowance(value: unknown): boolean {
  if (!object(value) || typeof value.managed !== 'boolean' || Object.hasOwn(value, 'error')) return false;
  // Central 2.2's own --json result, not a vendor token, config or model list.
  // License balances and workspace dollar limits use different fields.
  const bucket = (item: unknown) => object(item) && amount(item.current) && amount(item.maximum) && amount(item.available);
  return bucket(value.tariffQuota) || bucket(value.topUpQuota) || amount(value.usedDollars) && amount(value.maxDollars);
}

/** Explicitly verify the current Central CLI identity without importing tokens or changing its login/access source. */
export class CentralClientImporter {
  constructor(private readonly options: CentralClientImportOptions = {}) {}
  async verifyCurrent(): Promise<CentralClientVerification> {
    const home = this.options.homeDir ?? homedir();
    let executable: string | undefined;
    try { executable = await (this.options.resolveExecutable ? this.options.resolveExecutable() : centralExecutable(home)); }
    catch { throw new CentralClientImportError('not-installed'); }
    if (!executable || !isAbsolute(executable)) throw new CentralClientImportError('not-installed');
    const run = this.options.run ?? nativeRun;
    const command = async (args: readonly string[], timeoutMs: number, failure: keyof typeof messages) => {
      try {
        const result = await run(executable!, args, { cwd: home, env: commandEnvironment(home), timeoutMs, maxOutputBytes: 64 * 1024 });
        if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 64 * 1024) throw new Error('Command failed');
        return result.stdout;
      } catch { throw new CentralClientImportError(failure); }
    };
    const status = loggedIn(await command(['status'], 10_000, 'status-unavailable'));
    if (status === false) throw new CentralClientImportError('not-logged-in');
    if (status !== true) throw new CentralClientImportError('status-unavailable');
    const output = await command(['limit', '--json'], 25_000, 'authorization-failed');
    let allowance: unknown;
    try { allowance = JSON.parse(output); } catch { throw new CentralClientImportError('unsupported-response'); }
    if (!validAllowance(allowance)) throw new CentralClientImportError('unsupported-response');
    return { client: 'central-cli', authorization: 'verified', verifiedAt: new Date((this.options.now ?? Date.now)()).toISOString() };
  }
}
