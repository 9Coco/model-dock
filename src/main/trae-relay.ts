import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TRAE_RELAY_BASE_URL } from '../shared/presets'
import { TraeClientImportError, type TraeClientCredentials } from './trae-client-import'
import { postTraeRelayAccount, type TraeRelayImportResult } from './trae-relay-import'

export { TRAE_RELAY_BASE_URL }
const relayUrl = new URL(TRAE_RELAY_BASE_URL)
const PORT = Number(relayUrl.port)
const ORIGIN = relayUrl.origin
export const TRAE_RELAY_LOGIN_URL = `${ORIGIN}/web/login`
export const TRAE_RELAY_IMAGE = 'ghcr.io/autumnsentiment/trae2api-cn:1.0.10'
const NAME = 'modeldock-trae-cn-relay'
const OWNER = 'local.modeldock.trae-relay.owner'
const PROFILE = 'trae-cn-relay'
const ID = /^[0-9a-f]{64}$/

export interface TraeRelayStatus {
  state: 'stopped' | 'running' | 'unavailable' | 'conflict' | 'unhealthy'
  message: string
}

class RelayFailure extends Error {
  constructor(readonly state: TraeRelayStatus['state'], message: string) { super(message) }
}
interface Profile { owner: string; keyHash: string; hostId?: string }
interface Container { id: string; running: boolean; exitCode: number; hostNetwork: boolean }

const unavailable = '请确认本机已安装 Docker、已启动 Linux 容器引擎，并允许当前用户访问。'
const stopped: TraeRelayStatus = { state: 'stopped', message: '中转已停止。' }
const running: TraeRelayStatus = { state: 'running', message: '本机中转已就绪，可以打开登录页面。' }
const profileConflict = () => new RelayFailure('conflict', '中转目录已有其他内容、权限不安全或配置不完整。已保留原文件。')
const nameConflict = () => new RelayFailure('conflict', '同名容器不属于当前中转配置，或端口映射已改变。已保留原容器。')
const portConflict = () => new RelayFailure('conflict', `本机端口 ${PORT} 已被占用或无法绑定。`)
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex')
const hasCode = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code

async function localEndpoint() {
  if (process.platform === 'win32') return 'npipe:////./pipe/docker_engine'
  const candidates = [
    '/var/run/docker.sock',
    ...(process.env.XDG_RUNTIME_DIR ? [join(process.env.XDG_RUNTIME_DIR, 'docker.sock')] : []),
    join(homedir(), '.docker', 'desktop', 'docker.sock'),
    join(homedir(), '.docker', 'run', 'docker.sock'),
  ]
  for (const path of candidates) {
    if (await lstat(path).then(st => st.isSocket() || st.isSymbolicLink(), () => false)) return `unix://${path}`
  }
  return 'unix:///var/run/docker.sock'
}

const runFile = promisify(execFile)
async function runDocker(args: string[], timeout = 12000): Promise<string> {
  const env = { ...process.env }
  // Do not inherit remote contexts or TLS settings when opening a local socket.
  for (const key of Object.keys(env)) {
    if (/^DOCKER_(?:HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH)$/i.test(key)) delete env[key]
  }
  const result = await runFile('docker', ['--host', await localEndpoint(), ...args], {
    env, windowsHide: true, timeout, maxBuffer: 256 * 1024,
  })
  return result.stdout.trim()
}

function portAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port: PORT, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

// Direct TCP, no redirects, no credentials, no proxy, and a hard body limit.
function probeHealth(): Promise<boolean> {
  return new Promise(resolve => {
    const req = get(`${ORIGIN}/healthz`, { agent: false, signal: AbortSignal.timeout(2000) }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
        if (body.length > 1024) req.destroy(new Error('health response too large'))
      })
      res.once('error', () => resolve(false))
      res.once('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).status === 'ok') }
        catch { resolve(false) }
      })
    })
    req.once('error', () => resolve(false))
  })
}

const defaults = {
  docker: runDocker, portAvailable, health: probeHealth,
  importAccount: postTraeRelayAccount,
  wait: () => new Promise<void>(resolve => setTimeout(resolve, 400)),
}

function startupCommand(hostNetwork: boolean) {
  return 'umask 077; test -w /app/.env && test -w /app/data || exit 73; ' +
    'IFS= read -r RELAY_API_KEYS < /run/modeldock-relay-key; test -n "$RELAY_API_KEYS"; export RELAY_API_KEYS; ' +
    'export TRAE_AUTH_SOURCE=web-login; exec uvicorn src.main:app --host ' +
    (hostNetwork ? `127.0.0.1 --port ${PORT}` : '0.0.0.0 --port 8000')
}

// Do not ask Docker for Config.Env or container logs, which can contain secrets.
// Evaluate the command/entrypoint and port-related settings inside the template.
const inspectFormat = `{{$port := false}}{{$host := false}}{{range .Config.Env}}{{if eq . "PORT=${PORT}"}}{{$port = true}}{{end}}` +
  '{{if eq . "HOST=127.0.0.1"}}{{$host = true}}{{end}}{{end}}' +
  `{"owner":{{json (index .Config.Labels "${OWNER}")}},"image":{{json .Config.Image}},"network":{{json .HostConfig.NetworkMode}},` +
  '"hostStartup":{{and $port $host (not .Config.Entrypoint) (eq .Config.WorkingDir "/app") (not .HostConfig.Privileged) ' +
  '(not .HostConfig.PidMode) (not .HostConfig.PublishAllPorts) (eq (len .Config.Cmd) 3) ' +
  `(eq (index .Config.Cmd 0) "sh") (eq (index .Config.Cmd 1) "-ec") (eq (index .Config.Cmd 2) ${JSON.stringify(startupCommand(true))})}},` +
  '"ports":{{json .HostConfig.PortBindings}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}'

// A host-network health response alone could come from a different process. Require
// this container's actual PID 1 to own the loopback listener and no other TCP listener.
const listenerCheck = [
  'import os',
  'fds = {os.readlink("/proc/1/fd/" + fd) for fd in os.listdir("/proc/1/fd")}',
  'listeners = []',
  'for table in ("/proc/net/tcp", "/proc/net/tcp6"):',
  '    if os.path.exists(table):',
  '        for row in open(table).read().splitlines()[1:]:',
  '            fields = row.split()',
  '            if fields[3] == "0A" and "socket:[" + fields[9] + "]" in fds: listeners.append(fields[1])',
  `print("owned" if listeners == ["0100007F:${PORT.toString(16).toUpperCase()}"] else "unverified")`,
].join('\n')

export class TraeRelayManager {
  private readonly root: string
  private readonly io: typeof defaults
  private queue: Promise<unknown> = Promise.resolve()

  constructor(userDataDir: string, deps: Partial<typeof defaults> = {}) {
    this.root = join(userDataDir, PROFILE)
    this.io = { ...defaults, ...deps }
  }

  private serialized(action: () => Promise<TraeRelayStatus>): Promise<TraeRelayStatus> {
    const result = this.queue.then(action).catch((err): TraeRelayStatus =>
      err instanceof RelayFailure ? { state: err.state, message: err.message } : { state: 'unavailable', message: unavailable })
    this.queue = result
    return result
  }

  private async readProfile(): Promise<Profile | undefined> {
    let root
    try { root = await lstat(this.root) }
    catch (err) { if (hasCode(err, 'ENOENT')) return undefined; throw profileConflict() }
    try {
      if (!root.isDirectory() || (process.platform !== 'win32' && (root.mode & 0o077))) throw profileConflict()
      for (const [name, directory] of [['owner.json', false], ['api-key', false], ['.env', false], ['data', true]] as const) {
        const stat = await lstat(join(this.root, name))
        if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) ||
          (process.platform !== 'win32' && (stat.mode & 0o077))) throw profileConflict()
        if (name === 'owner.json' && stat.size > 1024 || name === 'api-key' && stat.size > 129) throw profileConflict()
      }
      const value = JSON.parse(await readFile(join(this.root, 'owner.json'), 'utf8')) as Profile
      if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(value.owner) || !ID.test(value.keyHash)) throw profileConflict()
      if (value.hostId !== undefined && !ID.test(value.hostId)) throw profileConflict()
      const secret = await readFile(join(this.root, 'api-key'), 'utf8')
      if (!secret.endsWith('\n') || keyHash(secret.slice(0, -1)) !== value.keyHash) throw profileConflict()
      return value
    } catch { throw profileConflict() }
  }

  private async newProfile(apiKey: string): Promise<Profile> {
    const profile = { owner: randomUUID(), keyHash: keyHash(apiKey) }
    const undo: (() => Promise<void>)[] = []
    try {
      // Exclusive directory creation keeps pre-existing profiles untouched.
      await mkdir(this.root, { mode: 0o700 })
      undo.push(() => rmdir(this.root))
      if (process.platform === 'win32') {
        const identity = await runFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
        const sid = identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0]
        if (!sid) throw profileConflict()
        await runFile('icacls.exe', [this.root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`,
          '/grant:r', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true })
      }
      await mkdir(join(this.root, 'data'), { mode: 0o700 })
      undo.push(() => rmdir(join(this.root, 'data')))
      await writeFile(join(this.root, 'api-key'), apiKey + '\n', { flag: 'wx', mode: 0o600 })
      undo.push(() => unlink(join(this.root, 'api-key')))
      await writeFile(join(this.root, '.env'), [
        'TRAE_AUTH_SOURCE=web-login', 'TRAE_EDITION=cn', 'UPSTREAM_MODE=remote',
        'TRAE_TRUST_PROXY_HEADERS=0', `TRAE_PUBLIC_BASE_URL=${ORIGIN}`,
        'TRAE_AUTO_CHECKIN=0', 'TRAE_USAGE_SESSION_QUERY=false', '',
      ].join('\n'), { flag: 'wx', mode: 0o600 })
      undo.push(() => unlink(join(this.root, '.env')))
      await writeFile(join(this.root, 'owner.json'), JSON.stringify(profile), { flag: 'wx', mode: 0o600 })
      return profile
    } catch {
      for (const revert of undo.reverse()) await revert().catch(() => {})
      throw profileConflict()
    }
  }

  private async container(profile: Profile | undefined): Promise<Container | undefined> {
    const id = await this.io.docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${NAME}$`, '--format', '{{.ID}}'])
    if (!id) return undefined
    if (!profile || !ID.test(id)) throw nameConflict()
    const info = JSON.parse(await this.io.docker(['container', 'inspect', '--format', inspectFormat, id]))
    const bindings = info.ports?.['8000/tcp']
    if (info.owner !== profile.owner || info.image !== TRAE_RELAY_IMAGE) throw nameConflict()
    const hostNetwork = info.network === 'host'
    if (hostNetwork) {
      if (process.platform !== 'linux' || profile.hostId !== id || info.hostStartup !== true ||
        Object.keys(info.ports || {}).length) throw nameConflict()
    } else if (!['default', 'bridge'].includes(info.network) || Object.keys(info.ports || {}).length !== 1 ||
      bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== String(PORT)) throw nameConflict()
    return { id, running: info.running === true, exitCode: info.exitCode, hostNetwork }
  }

  private async create(profile: Profile): Promise<string> {
    const info = JSON.parse(await this.io.docker(['info', '--format',
      '{"os":{{json .OSType}},"system":{{json .OperatingSystem}},"kernel":{{json .KernelVersion}},"security":{{json .SecurityOptions}}}']))
    if (info.os !== 'linux') throw new RelayFailure('unavailable', '中转镜像需要 Docker 使用 Linux 容器引擎。')
    // Local private bind mounts must be writable by the process inside the container.
    // Rootless Docker maps container 0 to the host user. Rootful Linux uses host UID:GID.
    const rootless = (info.security || []).some((s: string) => s.includes('name=rootless'))
    const hostNetwork = process.platform === 'linux' && !rootless && !!info.system && info.kernel === release() &&
      !/docker desktop|linuxkit|microsoft|orbstack|rancher desktop|colima/i.test(`${info.system} ${info.kernel}`)
    const networking = hostNetwork
      ? ['--network', 'host', '--env', `PORT=${PORT}`, '--env', 'HOST=127.0.0.1']
      : ['--network', 'bridge', '--publish', `127.0.0.1:${PORT}:8000/tcp`]
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    const user = rootless ? '0:0' : uid !== undefined && gid !== undefined ? `${uid}:${gid}` : '999:999'
    const mount = (name: string, target: string) => `type=bind,"source=${join(this.root, name).replaceAll('"', '""')}",target=${target}`
    try {
      const id = await this.io.docker(['container', 'create', '--name', NAME, '--label', `${OWNER}=${profile.owner}`,
        '--restart', 'no', ...networking, '--user', user,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
        // /v1/status creates the reported CLI work directory even with no CLI installed.
        '--env', 'TRAE_CLI_WORKDIR=/tmp/modeldock-trae-cli',
        '--mount', mount('.env', '/app/.env'), '--mount', mount('data', '/app/data'),
        '--mount', mount('api-key', '/run/modeldock-relay-key') + ',readonly', TRAE_RELAY_IMAGE,
        // Upstream permits anonymous inference if RELAY_API_KEYS is empty. Keep the bootstrap
        // key independent of the writable login .env and out of Docker Config.Env and argv.
        'sh', '-ec', startupCommand(hostNetwork),
      ], 300000)
      if (ID.test(id)) {
        if (hostNetwork) {
          const temporary = join(this.root, 'owner-' + randomUUID() + '.tmp')
          try {
            await writeFile(temporary, JSON.stringify({ ...profile, hostId: id }), { flag: 'wx', mode: 0o600 })
            await rename(temporary, join(this.root, 'owner.json'))
            profile.hostId = id
          } finally { await unlink(temporary).catch(() => {}) }
        }
        return id
      }
    } catch {
      await this.container(profile) // diagnose a concurrent collision without adopting it
    }
    throw new RelayFailure('unavailable', '无法创建中转容器。请检查 Docker、数据目录共享权限及 GHCR 镜像下载连接。')
  }

  private async ready(id: string, profile: Profile, retry: boolean): Promise<TraeRelayStatus> {
    for (let i = 0; i < (retry ? 40 : 1); i++) {
      if (i) await this.io.wait()
      if (await this.io.health()) {
        const current = await this.container(profile)
        if (current?.id === id && current.running) {
          if (!current.hostNetwork || await this.io.docker(['container', 'exec', id, 'python', '-c', listenerCheck]).catch(() => '') === 'owned') return running
          return { state: 'unhealthy', message: '无法核实中转进程拥有本机回环监听端口。' }
        }
        break
      }
      if (retry && i % 4 === 0) {
        const current = await this.container(profile)
        if (current?.id !== id || !current.running) {
          return { state: 'unhealthy', message: current?.exitCode === 73
            ? '中转容器无法写入登录数据。请检查 Docker 对中转目录的读写权限。'
            : '中转容器在 HTTP 服务就绪前已经退出。请检查 Docker 和中转目录权限。' }
        }
      }
    }
    return { state: 'unhealthy', message: '中转未通过 /healthz 检查。请检查本机端口和 Docker 对中转目录的读写权限。' }
  }

  status(): Promise<TraeRelayStatus> {
    return this.serialized(async () => {
      const profile = await this.readProfile()
      const current = await this.container(profile)
      if (current?.running && profile) return this.ready(current.id, profile, false)
      if (!await this.io.portAvailable()) throw portConflict()
      return stopped
    })
  }

  start(apiKey: string): Promise<TraeRelayStatus> {
    return this.serialized(async () => {
      if (!/^[a-zA-Z0-9_-]{32,128}$/.test(apiKey)) throw new RelayFailure('conflict', '本机中转密钥无效。')
      let profile = await this.readProfile()
      const current = await this.container(profile)
      if (profile && profile.keyHash !== keyHash(apiKey)) {
        throw new RelayFailure('conflict', '本机中转密钥与已有配置不一致。已保留登录数据。')
      }
      if (current?.running && profile) return this.ready(current.id, profile, true)
      if (!await this.io.portAvailable()) throw portConflict()
      profile ??= await this.newProfile(apiKey)
      const id = current?.id ?? await this.create(profile)
      try { await this.io.docker(['container', 'start', id]) }
      catch {
        if (!await this.io.portAvailable()) throw portConflict()
        throw new RelayFailure('unavailable', 'Docker 无法启动中转容器。请检查数据目录共享权限。')
      }
      return this.ready(id, profile, true)
    })
  }

  stop(): Promise<TraeRelayStatus> {
    return this.serialized(async () => {
      const profile = await this.readProfile()
      const current = await this.container(profile)
      if (current?.running) {
        await this.io.docker(['container', 'stop', '--time', '10', current.id], 20000)
        if ((await this.container(profile))?.running) throw new RelayFailure('unavailable', 'Docker 尚未停止中转。')
      }
      return stopped
    })
  }

  /** Explicit import only, serialized against start/stop. Never send an
   * account credential to an arbitrary manually configured relay URL. */
  importAccount(apiKey: string, credentials: TraeClientCredentials): Promise<TraeRelayImportResult> {
    const result = this.queue.then(async () => {
      if (!/^[a-zA-Z0-9_-]{32,128}$/.test(apiKey)) throw new RelayFailure('conflict', '本机中转密钥无效。')
      const profile = await this.readProfile()
      if (!profile || profile.keyHash !== keyHash(apiKey)) throw new RelayFailure('conflict', '账号导入只支持当前 ModelDock 托管反代，请先启动匹配的本机反代。')
      const current = await this.container(profile)
      if (!current?.running) throw new RelayFailure('stopped', '请先启动 ModelDock 托管的 TRAE 本机反代，再导入客户端账号。')
      const status = await this.ready(current.id, profile, false)
      if (status.state !== 'running') throw new RelayFailure(status.state, status.message)
      return this.io.importAccount(apiKey, credentials)
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result.catch(error => {
      if (error instanceof TraeClientImportError) throw error
      throw new TraeClientImportError('relay', error instanceof RelayFailure ? error.message : 'TRAE 本机账号导入失败，请检查托管反代后重试。')
    })
  }
}
