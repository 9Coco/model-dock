import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { CentralCommandRunner } from './central-client-import';
import { parseCentralTransfer, type CentralTransfer } from './central-api';

export interface CentralSessionReaderOptions { homeDir?: string; resolveExecutable?: () => Promise<string | undefined>; run?: CentralCommandRunner }
const failed = () => new Error('无法安全导出 Central 当前会话，请更新 Central CLI、完成 central login 后重新连接；ModelDock 不会启动 Central 或 Pi 反代。');
const MAX_OUTPUT = 65536;

// This is a one-shot, explicitly requested account operation. It never runs an
// agent, proxy, status/limit inference probe, shell, or background CLI process.
export class CentralClientSessionReader {
  constructor(private readonly options: CentralSessionReaderOptions = {}) {}
  private async executable(home: string): Promise<string | undefined> {
    const paths = [...new Set([...(process.env.PATH ?? '').split(delimiter), join(home, '.local', 'bin')].filter(value => value && isAbsolute(value)))];
    for (const dir of paths) {
      const path = join(dir, process.platform === 'win32' ? 'central.exe' : 'central');
      try { if (!(await stat(path)).isFile()) continue; await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return path; } catch { /* Next installed official launcher. */ }
    }
  }
  async read(): Promise<CentralTransfer> {
    const home = this.options.homeDir ?? homedir();
    let executable: string | undefined;
    try { executable = await (this.options.resolveExecutable ? this.options.resolveExecutable() : this.executable(home)); } catch { throw failed(); }
    if (!executable || !isAbsolute(executable)) throw failed();
    const allowed = /^(PATH|HOME|USER|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|TMP|TEMP|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR)|DBUS_SESSION_BUS_ADDRESS|GNOME_KEYRING_CONTROL|LANG|LC_[A-Z_]+)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.test(key))) as NodeJS.ProcessEnv;
    env.HOME = home; if (process.platform === 'win32') env.USERPROFILE = home;
    const run: CentralCommandRunner = this.options.run ?? ((path, args, options) => new Promise((resolve, reject) => {
      const child = spawn(path, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let done = false, size = 0; const out: Buffer[] = [], err: Buffer[] = [];
      const fail = () => { if (done) return; done = true; clearTimeout(timer); child.kill(); reject(failed()); };
      const timer = setTimeout(fail, options.timeoutMs); timer.unref?.();
      const collect = (target: Buffer[]) => (part: Buffer) => { size += part.length; if (size > options.maxOutputBytes) fail(); else target.push(part); };
      child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
      child.once('error', fail); child.once('close', exitCode => { clearTimeout(timer); if (!done) { done = true; resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); } });
    }));
    let stdout: string;
    try { const result = await run(executable, ['login', 'export'], { cwd: home, env, timeoutMs: 10000, maxOutputBytes: MAX_OUTPUT }); if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT) throw failed(); stdout = result.stdout; }
    catch { throw failed(); }
    // Native errors are deliberately not forwarded: their output is credential material.
    return parseCentralTransfer(stdout);
  }
}
