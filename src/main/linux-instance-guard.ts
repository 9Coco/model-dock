import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';

const OPEN = Buffer.from('OPEN\n');
const ACK = Buffer.from('ACK\n');
const MAX_FRAME_BYTES = 16;
const MAX_CONNECTIONS = 8;
const SOCKET_TIMEOUT_MS = 500;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 40;

export interface LinuxInstanceGuard {
  /** 仅在初始化被取消或最终退出时释放；运行中不得主动放开互斥。 */
  close(): void;
}

function failure(): Error {
  // 修改点：不把系统异常中的资料路径、任意 IPC 输入写入错误或诊断日志。
  return new Error('无法确认 ModelDock 单实例状态，已阻止重复启动。');
}

function address(profileDir: string): string {
  if (process.platform !== 'linux' || !process.getuid || !isAbsolute(profileDir) || /[\x00-\x1f\x7f]/.test(profileDir)) throw failure();
  try {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(profileDir), info = statSync(canonical), uid = process.getuid();
    if (!info.isDirectory() || info.uid !== uid) throw failure();
    // 修改点：同一资料目录的链接别名共用互斥；地址不包含明文路径、PID 或版本。
    const digest = createHash('sha256').update(canonical).digest('hex');
    return `\0modeldock-${uid}-${digest}`;
  } catch { throw failure(); }
}

function acceptOpen(socket: Socket, onOpen: () => void, connections: Set<Socket>): void {
  connections.add(socket);
  const chunks: Buffer[] = [];
  let bytes = 0;
  // 绝对截止时间，不能被缓慢逐字节发送刷新成无限等待。
  const deadline = setTimeout(() => socket.destroy(), SOCKET_TIMEOUT_MS);
  deadline.unref();
  socket.on('error', () => socket.destroy());
  socket.once('close', () => { clearTimeout(deadline); connections.delete(socket); });
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_FRAME_BYTES) { socket.destroy(); return; }
    chunks.push(chunk);
  });
  socket.once('end', () => {
    // 固定半关闭帧；必须读完再确认，拒绝附带参数或尾随数据。
    if (socket.destroyed || !Buffer.concat(chunks, bytes).equals(OPEN)) { socket.destroy(); return; }
    try { onOpen(); socket.end(ACK); }
    catch { socket.destroy(); }
  });
}

function bind(name: string, onOpen: () => void): Promise<LinuxInstanceGuard | null> {
  return new Promise((resolve, reject) => {
    const connections = new Set<Socket>();
    const server: Server = createServer({ allowHalfOpen: true }, socket => acceptOpen(socket, onOpen, connections));
    server.maxConnections = MAX_CONNECTIONS;
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      server.close(() => {});
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(failure());
    };
    const onListening = () => {
      server.removeListener('error', onError);
      // 监听期间不记录任何 IPC 数据。套接字错误不触发第二份应用初始化。
      server.on('error', () => {});
      let disposed = false;
      resolve({ close() {
        if (disposed) return;
        disposed = true;
        for (const socket of connections) socket.destroy();
        server.close(() => {});
      } });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen({ path: name }); }
    catch { server.removeListener('listening', onListening); server.close(() => {}); reject(failure()); }
  });
}

function notify(name: string): Promise<'notified' | 'gone'> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let socket: Socket;
    try { socket = createConnection({ path: name }); }
    catch { reject(failure()); return; }
    const finish = (result?: 'notified' | 'gone') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (result) resolve(result); else reject(failure());
    };
    const deadline = setTimeout(() => finish(), SOCKET_TIMEOUT_MS);
    deadline.unref();
    socket.once('connect', () => socket.end(OPEN));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) { finish(); return; }
      chunks.push(chunk);
    });
    socket.once('end', () => { if (!settled) finish(Buffer.concat(chunks, bytes).equals(ACK) ? 'notified' : undefined); });
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'gone' : undefined));
    socket.once('close', () => { if (!settled) finish(); });
  });
}

/**
 * 修改点：Linux 使用内核原子绑定的抽象 Unix socket 阻止启动竞态。
 * 没有 PID 文件、文件系统锁或过期锁删除；崩溃由内核释放，Windows 不调用此函数。
 * null 表示已向现有实例确认唤醒，调用方必须退出，不能再申请 Electron 的锁。
 */
export async function acquireLinuxInstanceGuard(profileDir: string, onOpen: () => void): Promise<LinuxInstanceGuard | null> {
  const name = address(profileDir);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const guard = await bind(name, onOpen);
    if (guard) return guard;
    if (await notify(name) === 'notified') return null;
    // 只有连接明确表示持有者已经消失才重试原子绑定；不猜 PID、不抢活锁。
    if (attempt + 1 < MAX_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
  }
  throw failure();
}
