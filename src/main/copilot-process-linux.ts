import { open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

interface LinuxPathIdentity {
  path: string;
  uid: number;
  mode: number;
  kind: 'file' | 'directory';
  device: string;
  inode: string;
  size: string;
  modified: string;
  changed: string;
}
export interface LinuxExecutableEvidence {
  realPath: string;
  elf: boolean;
  file: LinuxPathIdentity;
  parents: LinuxPathIdentity[];
}
export interface LinuxProcessIdentity {
  pid: number;
  parentPid: number;
  startTicks: string;
  uids: number[];
  executable: LinuxExecutableEvidence;
  networkNamespace: string;
}
export interface LinuxListener { pid: number; port: number; address: string; uid: number; inode: string }
export interface LinuxCopilotProcessEvidence {
  platform: 'linux';
  trustSource: 'system-administrator';
  currentUid: number;
  networkNamespace: string;
  published: LinuxProcessIdentity;
  listeners: LinuxListener[];
  socketInodes: string[];
  stable: boolean;
}

const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const namespace = (value: unknown): value is string => typeof value === 'string' && /^net:\[[1-9][0-9]*\]$/.test(value);

// 修改点：Linux 没有 Windows Authenticode。这里信任系统管理员安装的固定
// 系统路径，不声称已验证 GitHub 厂商签名；AppImage 和用户可写目录暂不放行。
const TRUSTED_EXECUTABLES = new Set(['/usr/bin/github']);
export function isTrustedLinuxCopilotExecutable(value: unknown): value is LinuxExecutableEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as LinuxExecutableEvidence;
  const protectedPath = (path: LinuxPathIdentity, expected: string, kind: 'file' | 'directory'): boolean => Boolean(path)
    && path.path === expected && path.kind === kind && path.uid === 0 && natural(path.mode) && (path.mode & 0o022) === 0
    && decimal(path.device) && decimal(path.inode) && typeof path.modified === 'string' && typeof path.changed === 'string';
  if (!TRUSTED_EXECUTABLES.has(item.realPath) || item.elf !== true || !protectedPath(item.file, item.realPath, 'file') || (item.file.mode & 0o111) === 0 || !Array.isArray(item.parents)) return false;
  const expectedParents: string[] = [];
  for (let parent = dirname(item.realPath); ; parent = dirname(parent)) { expectedParents.push(parent); if (parent === '/') break; }
  return item.parents.length === expectedParents.length && item.parents.every((parent, index) => protectedPath(parent, expectedParents[index], 'directory'));
}

/** Parse only identity fields; neither command lines nor environment are read. */
export function parseLinuxProcessIdentity(processStat: string, processStatus: string, pid: number): Pick<LinuxProcessIdentity, 'pid' | 'parentPid' | 'startTicks' | 'uids'> {
  // comm can contain spaces and parentheses. Field 22 is starttime in boot ticks.
  const close = processStat.lastIndexOf(')');
  const openParen = processStat.indexOf('(');
  const fields = processStat.slice(close + 1).trim().split(/\s+/);
  const uidLine = processStatus.split('\n').find(line => line.startsWith('Uid:'));
  const uids = uidLine?.slice(4).trim().split(/\s+/).map(Number) ?? [];
  const parentPid = Number(fields[1]);
  if (!positive(pid) || openParen < 1 || close < openParen || Number(processStat.slice(0, openParen).trim()) !== pid
    || !natural(parentPid) || !decimal(fields[19]) || uids.length !== 4 || !uids.every(natural)) throw new Error('invalid-process-identity');
  return { pid, parentPid, startTicks: fields[19], uids };
}

export function parseLinuxTcpListeners(table: string, port: number, ipv6 = false): Omit<LinuxListener, 'pid'>[] {
  const result: Omit<LinuxListener, 'pid'>[] = [];
  for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [rawAddress, rawPort] = (fields[1] ?? '').split(':');
    if (fields[3] !== '0A' || Number.parseInt(rawPort, 16) !== port) continue;
    const uid = Number(fields[7]), inode = fields[9];
    if (!natural(uid) || !decimal(inode)) throw new Error('invalid-listener');
    const address = ipv6 ? rawAddress === '00000000000000000000000001000000' ? '::1' : 'non-loopback'
      : rawAddress === '0100007F' ? '127.0.0.1' : 'non-loopback';
    result.push({ port, address, uid, inode });
  }
  return result;
}

export function isVerifiedLinuxCopilotProcess(value: unknown, pid: number, port: number): boolean {
  if (!positive(pid) || !Number.isInteger(port) || port < 1 || port > 65535 || !value || typeof value !== 'object') return false;
  const proof = value as LinuxCopilotProcessEvidence;
  const app = proof.published;
  if (proof.platform !== 'linux' || proof.trustSource !== 'system-administrator' || proof.stable !== true || !natural(proof.currentUid)
    || !app || app.pid !== pid || !natural(app.parentPid) || !decimal(app.startTicks) || !Array.isArray(app.uids) || app.uids.length !== 4
    || !app.uids.every(uid => uid === proof.currentUid) || !isTrustedLinuxCopilotExecutable(app.executable)
    || !namespace(proof.networkNamespace) || app.networkNamespace !== proof.networkNamespace) return false;
  if (!Array.isArray(proof.listeners) || proof.listeners.length < 1 || proof.listeners.length > 8 || !Array.isArray(proof.socketInodes)
    || !proof.socketInodes.every(decimal) || !proof.listeners.some(item => item?.address === '127.0.0.1')) return false;
  // 修改点：只接受公布 PID 自己持有的真实 socket。IPv4 回环是客户端实际连接地址；
  // 同端口存在任意通配/公网绑定、其他 UID、其他 inode，均拒绝发送凭据。
  return proof.listeners.every(item => item && item.pid === pid && item.port === port && item.uid === proof.currentUid
    && ['127.0.0.1', '::1'].includes(item.address) && decimal(item.inode) && proof.socketInodes.includes(item.inode));
}

async function pathIdentity(path: string, kind: 'file' | 'directory'): Promise<LinuxPathIdentity> {
  if (await realpath(path) !== path) throw new Error('unexpected-path-alias');
  const info = await stat(path, { bigint: true });
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error('invalid-path-kind');
  return { path, uid: Number(info.uid), mode: Number(info.mode & 0o7777n), kind, device: String(info.dev), inode: String(info.ino),
    size: String(info.size), modified: String(info.mtimeNs), changed: String(info.ctimeNs) };
}
async function executableIdentity(pid: number): Promise<LinuxExecutableEvidence> {
  const executable = await readlink(`/proc/${pid}/exe`);
  if (!TRUSTED_EXECUTABLES.has(executable)) throw new Error('untrusted-installation');
  const file = await pathIdentity(executable, 'file');
  const executing = await stat(`/proc/${pid}/exe`, { bigint: true });
  if (String(executing.dev) !== file.device || String(executing.ino) !== file.inode) throw new Error('executable-changed');
  const parents: LinuxPathIdentity[] = [];
  for (let parent = dirname(executable); ; parent = dirname(parent)) { parents.push(await pathIdentity(parent, 'directory')); if (parent === '/') break; }
  const handle = await open(executable, 'r');
  let elf = false;
  try { const header = Buffer.alloc(4); const { bytesRead } = await handle.read(header, 0, 4, 0); elf = bytesRead === 4 && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); }
  finally { await handle.close(); }
  const result = { realPath: executable, elf, file, parents };
  if (!isTrustedLinuxCopilotExecutable(result)) throw new Error('untrusted-installation');
  return result;
}
async function processIdentity(pid: number): Promise<LinuxProcessIdentity> {
  const [processStat, status, executable, networkNamespace] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8'), executableIdentity(pid), readlink(`/proc/${pid}/ns/net`),
  ]);
  return { ...parseLinuxProcessIdentity(processStat, status, pid), executable, networkNamespace };
}
async function targetListeners(port: number): Promise<Omit<LinuxListener, 'pid'>[]> {
  const tcp = await readFile('/proc/self/net/tcp', 'utf8');
  let tcp6: string | undefined;
  try { tcp6 = await readFile('/proc/self/net/tcp6', 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return [...parseLinuxTcpListeners(tcp, port), ...(tcp6 ? parseLinuxTcpListeners(tcp6, port, true) : [])].sort((a, b) => `${a.address}:${a.inode}`.localeCompare(`${b.address}:${b.inode}`));
}
async function ownedSocketInodes(pid: number): Promise<string[]> {
  const directory = `/proc/${pid}/fd`;
  const entries = await readdir(directory);
  const links = await Promise.all(entries.filter(entry => /^[0-9]+$/.test(entry)).map(async entry => {
    try { return await readlink(`${directory}/${entry}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }));
  return links.flatMap(link => { const inode = /^socket:\[([1-9][0-9]*)\]$/.exec(link)?.[1]; return inode ? [inode] : []; }).sort();
}

/** Read-only /proc and root-managed installation evidence, with no shell or credentials. */
export async function collectLinuxCopilotProcessEvidence(pid: number, port: number): Promise<unknown> {
  if (!positive(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return { failedStage: 'invalid-target' };
  let stage = 'process';
  try {
    const currentUid = process.getuid?.();
    if (!natural(currentUid)) return { failedStage: 'current-user' };
    const networkNamespace = await readlink('/proc/self/ns/net');
    const published = await processIdentity(pid);
    stage = 'listeners';
    const before = await targetListeners(port);
    const socketInodes = await ownedSocketInodes(pid);
    stage = 'recheck';
    const afterPublished = await processIdentity(pid);
    const after = await targetListeners(port);
    const afterSockets = await ownedSocketInodes(pid);
    const stable = JSON.stringify(published) === JSON.stringify(afterPublished) && JSON.stringify(before) === JSON.stringify(after)
      && before.every(item => socketInodes.includes(item.inode) && afterSockets.includes(item.inode));
    return { platform: 'linux', trustSource: 'system-administrator', currentUid, networkNamespace, published,
      listeners: before.map(item => ({ ...item, pid })), socketInodes, stable } satisfies LinuxCopilotProcessEvidence;
  } catch (error) { return { failedStage: error instanceof Error && error.message === 'untrusted-installation' ? 'untrusted-installation' : stage }; }
}
