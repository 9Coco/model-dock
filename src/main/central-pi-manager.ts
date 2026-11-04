import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const host = '127.0.0.1';
const port = 18081;
const windows = process.platform === 'win32';
const unavailable = 'JetBrains 中转未就绪。请先在终端执行 central login，确认 central run pi 可用后重试。';

async function executable(dirs: string[], names: string[]) {
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (!(await stat(path)).isFile()) continue;
        await access(path, windows ? constants.F_OK : constants.X_OK);
        return path;
      } catch { /* try the next installed executable */ }
    }
  }
}

// Preserve Central's normal account/keychain and network environment. Do not pass
// model-vendor tokens, alternate Pi configurations, NODE_OPTIONS or shell hooks.
function launchEnvironment(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = /^(HOME|USER|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|TMP|TEMP|TMPDIR|XDG_(?:CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR)|DBUS_SESSION_BUS_ADDRESS|GNOME_KEYRING_CONTROL|DISPLAY|WAYLAND_DISPLAY|LANG|LC_[A-Z_]+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (allowed.test(name) && value !== undefined) env[name] = value;
  }
  return { ...env, PATH: path, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
}

// Central 2.2 omits its one-off provider extension when Pi is already wired.
// Reproduce only Central's registered loopback routes, never the user's JS or API keys.
async function smallHomeFile(home: string, parts: string[]): Promise<string | undefined> {
  const path = join(home, ...parts);
  try {
    if (await realpath(path) !== join(await realpath(home), ...parts)) return;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 128 * 1024) return;
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead === info.size) return buffer.toString('utf8', 0, bytesRead);
    } finally { await file.close(); }
  } catch { /* Fresh installs and unsupported configurations use Central's own run extension. */ }
}

async function connectedRoutes(home: string): Promise<Record<string, string> | undefined> {
  const source = await smallHomeFile(home, ['.pi', 'agent', 'extensions', 'jetbrains-central.ts']);
  if (!source) return;
  const config = await smallHomeFile(home, ['.jetbrains-central', 'config.json']);
  if (!config) return;
  let connection;
  try { connection = JSON.parse(config); } catch { return; }
  const port = connection?.proxy_port;
  const secret = connection?.proxy_secret;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof secret !== 'string' || !/^[a-f0-9]{32}$/.test(secret)) return;
  const routes: Record<string, string> = {};
  const template = /^\s*pi\.registerProvider\("(openai|anthropic)", \{ baseUrl: "([^"\\\s]+)", apiKey: "[^"\\\r\n]*" \}\);\s*$/;
  for (const line of source.split(/\r?\n/)) {
    const match = template.exec(line);
    if (!match) continue;
    const [, name, url] = match;
    const expected = `http://127.0.0.1:${port}/wire/${secret}/pi/${name}`;
    if (![expected, expected + '/', expected + '/v1', expected + '/v1/'].includes(url) || routes[name]) return;
    routes[name] = url;
  }
  return Object.keys(routes).length ? routes : undefined;
}

// Controlled bootstrap stored in the private agent directory. Prefer anything
// Central supplies for this run, including a policy that enables only Bedrock.
const connectedBootstrap = `export default function (pi) {
  const routes = JSON.parse(process.env.MODELDOCK_JB_CONNECTED_ROUTES || '{}');
  delete process.env.MODELDOCK_JB_CONNECTED_ROUTES;
  const cliExtensions = process.argv.filter(arg => arg === '-e' || arg === '--extension' || arg.startsWith('--extension='));
  if (cliExtensions.length !== 1) return;
  pi.on('session_start', (_event, ctx) => {
    const providers = ['openai', 'anthropic', 'google-vertex', 'amazon-bedrock'];
    if (providers.some(id => ctx.modelRegistry.getRegisteredProviderConfig(id) || ctx.modelRegistry.getRegisteredNativeProvider?.(id))) return;
    for (const [name, baseUrl] of Object.entries(routes)) {
      pi.registerProvider(name, { baseUrl, apiKey: 'modeldock-local-placeholder' });
    }
  });
}
`;

function freePort(): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function health(key: string, nonce: string, signal: AbortSignal): Promise<boolean> {
  // A raced or foreign listener receives only a per-launch, health-only proof.
  const proof = createHmac('sha256', key).update(`health:${nonce}`).digest('hex');
  return new Promise(resolve => {
    const req = get({ host, port, path: '/health', agent: false, headers: { Authorization: `Bearer ${proof}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    }, res => {
      if (res.statusCode !== 200) { res.destroy(); resolve(false); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024) { res.destroy(); resolve(false); return; }
        chunks.push(chunk);
      });
      res.once('error', () => resolve(false));
      res.once('aborted', () => resolve(false));
      res.once('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve(body.id === 'modeldock-central-pi' && body.nonce === nonce);
        } catch { resolve(false); }
      });
    });
    req.once('error', () => resolve(false));
  });
}

async function terminateTree(child: ChildProcess) {
  if (!child.pid) return;
  const pid = child.pid;
  // Pi RPC explicitly shuts down its session on EOF. Give it time to release
  // sockets before forcing a tree kill, particularly when Central wraps Pi on Windows.
  child.stdin?.end();
  for (let i = 0; i < 8 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
  if (windows) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 4000 });
    await new Promise<void>(resolve => { killer.once('error', () => resolve()); killer.once('close', () => resolve()); });
    if (child.exitCode === null && child.signalCode === null) child.kill();
  } else {
    // Central and Pi are our own detached process group. The official Central
    // proxy has its own daemon lifecycle and is never stopped by name or CLI.
    try { process.kill(-pid, 'SIGTERM'); } catch { return; }
    for (let i = 0; i < 10; i++) {
      await delay(50);
      try { process.kill(-pid, 0); } catch { return; }
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* exited between checks */ }
  }
}

interface Session {
  key: string;
  nonce: string;
  controller: AbortController;
  child?: ChildProcess;
  dir?: string;
  running: boolean;
  started: Promise<void>;
  cleanup?: Promise<void>;
}

export class CentralPiManager {
  private current?: Session;
  constructor(private readonly userDataDir: string, private readonly extensionFile: string) {}

  isRunning(key: string): boolean {
    return this.current?.key === key && this.current.running && !this.current.controller.signal.aborted;
  }

  async ownsListener(key: string): Promise<boolean> {
    const state = this.current;
    if (!state || !this.isRunning(key)) return false;
    return await health(key, state.nonce, state.controller.signal) && this.current === state && this.isRunning(key);
  }

  start(key: string): Promise<void> {
    if (!/^[\x21-\x7e]{32,512}$/.test(key)) return Promise.reject(new Error('本地中转密钥格式无效。'));
    if (this.current) {
      if (this.current.controller.signal.aborted) return Promise.reject(new Error('中转正在停止，请稍后重试。'));
      if (this.current.key !== key) return Promise.reject(new Error('中转已使用另一把本地密钥，请先停止中转。'));
      return this.current.started;
    }
    const state: Session = { key, nonce: randomBytes(32).toString('hex'), controller: new AbortController(), running: false, started: Promise.resolve() };
    this.current = state;
    state.started = this.launch(state).catch(async (error: unknown) => {
      await this.cleanup(state);
      // Only our own specific messages are safe for UI. OS errors can contain private paths or arguments.
      if (error instanceof StartupFailure) throw error;
      throw new Error(unavailable);
    });
    return state.started;
  }

  async stop(): Promise<void> {
    const state = this.current;
    if (!state) return;
    state.controller.abort();
    await state.started.catch(() => {});
    await this.cleanup(state);
  }

  private async launch(state: Session) {
    const { signal } = state.controller;
    const inheritedPath = process.env.PATH ?? '';
    const candidates = [...inheritedPath.split(delimiter), join(homedir(), '.local', 'bin'), process.env.NVM_BIN];
    // Pi's official Windows installer now keeps its pinned launcher here.
    // An already-running desktop app can still have the pre-install PATH.
    if (windows) candidates.push(join(homedir(), '.pi', 'agent', 'bin'));
    if (windows && process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm'));
    const dirs = [...new Set(candidates.filter((p): p is string => !!p && isAbsolute(p)))];
    const central = await executable(dirs, windows ? ['central.exe'] : ['central']);
    const pi = await executable(dirs, windows ? ['pi.exe', 'pi.cmd'] : ['pi']);
    if (!central || !pi) throw new StartupFailure('请先安装 JetBrains Central CLI 和 Pi CLI，并确保 ModelDock 能在 PATH 中找到 central 和 pi。');
    if (!await freePort()) throw new StartupFailure(`本机端口 ${port} 已被占用或无法绑定。`);
    if (!isAbsolute(this.extensionFile) || !(await stat(this.extensionFile)).isFile()) throw new StartupFailure('未找到 ModelDock 自带的 Pi 扩展。');
    const base = join(this.userDataDir, 'central-pi');
    await mkdir(base, { recursive: true, mode: 0o700 });
    state.dir = await mkdtemp(join(base, 'run-'));
    const work = join(state.dir, 'work');
    const agent = join(state.dir, 'agent');
    await Promise.all([mkdir(work, { mode: 0o700 }), mkdir(agent, { mode: 0o700 })]);
    const routes = await connectedRoutes(homedir());
    if (routes) {
      const extensions = join(agent, 'extensions');
      await mkdir(extensions, { mode: 0o700 });
      await writeFile(join(extensions, 'modeldock-connected.js'), connectedBootstrap, { mode: 0o600, flag: 'wx' });
    }
    signal.throwIfAborted();
    const env = launchEnvironment([...new Set([dirname(pi), ...dirs])].join(delimiter));
    // Keep extension discovery in this fresh private agent directory so Central
    // can supply its provider either there or via an explicit -e argument.
    // No user Pi settings are copied in, and project resources are untrusted.
    const proc = spawn(central, ['run', 'pi', '--', '--mode', 'rpc', '--no-session', '--no-tools',
      '--no-approve', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--extension', this.extensionFile], {
      cwd: work, windowsHide: true, detached: !windows, shell: false, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...env, ...(routes ? { MODELDOCK_JB_CONNECTED_ROUTES: JSON.stringify(routes) } : {}),
        PI_CODING_AGENT_DIR: agent, MODELDOCK_JB_RELAY_KEY: state.key, MODELDOCK_JB_RELAY_NONCE: state.nonce },
    });
    state.child = proc;
    proc.stdin?.on('error', () => {});
    const ended = () => { state.controller.abort(); if (state.running) void this.cleanup(state); };
    proc.once('exit', ended);
    proc.once('error', ended);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !signal.aborted) {
      if (await health(state.key, state.nonce, signal) && !signal.aborted) { state.running = true; return; }
      await delay(180, undefined, { signal });
    }
    throw new StartupFailure(unavailable);
  }

  private cleanup(state: Session): Promise<void> {
    if (!state.cleanup) {
      state.controller.abort();
      state.running = false;
      state.cleanup = (async () => {
        try {
          if (state.child) {
            await terminateTree(state.child);
            state.child.stdin?.destroy();
          }
          if (state.dir) await rm(state.dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
        } finally { if (this.current === state) this.current = undefined; }
      })();
    }
    return state.cleanup;
  }
}

class StartupFailure extends Error {}
