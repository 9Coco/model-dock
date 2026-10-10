import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { acquireLinuxInstanceGuard, type LinuxInstanceGuard } from '../src/main/linux-instance-guard';

const directories: string[] = [];
const guards: LinuxInstanceGuard[] = [];
const clients = new Set<Socket>();
const servers: Server[] = [];
const children = new Set<ChildProcess>();
let helper: string;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'modeldock-instance-guard-'));
  directories.push(directory); return directory;
}
function socketAddress(profile: string): string {
  return `\0modeldock-${process.getuid!()}-${createHash('sha256').update(realpathSync(profile)).digest('hex')}`;
}
async function own(profile: string, onOpen: () => void = () => {}): Promise<LinuxInstanceGuard> {
  const guard = await acquireLinuxInstanceGuard(profile, onOpen);
  expect(guard).not.toBeNull(); guards.push(guard!); return guard!;
}
function connect(name: string): Socket {
  const socket = createConnection({ path: name }); clients.add(socket);
  socket.once('close', () => clients.delete(socket)); return socket;
}
async function rawFrame(name: string, frame?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(name), received: Buffer[] = [];
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Private test socket timed out')); });
    socket.once('connect', () => { if (frame !== undefined) socket.end(frame); });
    socket.on('data', data => received.push(data));
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    socket.once('close', () => resolve(Buffer.concat(received)));
  });
}
async function fakeOwner(profile: string, handler: (socket: Socket) => void): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket); socket.on('error', () => {}); socket.once('close', () => clients.delete(socket)); handler(socket); socket.resume();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketAddress(profile), resolve); });
  return server;
}

interface ChildRecord {
  process: ChildProcess;
  events: Array<{ event: string; owned?: boolean; pid: number }>;
  exited: Promise<void>;
}
function child(profile: string): ChildRecord {
  const process = spawn(globalThis.process.execPath, [helper, profile], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(process);
  const events: ChildRecord['events'] = [];
  let pending = '';
  process.stdout!.on('data', data => {
    pending += data;
    for (;;) {
      const line = pending.indexOf('\n'); if (line < 0) break;
      events.push(JSON.parse(pending.slice(0, line))); pending = pending.slice(line + 1);
    }
  });
  const exited = new Promise<void>(resolve => process.once('exit', () => { children.delete(process); resolve(); }));
  return { process, events, exited };
}
async function waitEvent(record: ChildRecord, event: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = record.events.find(item => item.event === event);
    if (value) return value;
    if (record.process.exitCode !== null || record.process.signalCode !== null) throw new Error(`Private child exited before ${event}`);
    await pause(10);
  }
  throw new Error(`Private child did not report ${event}`);
}

beforeAll(async () => {
  if (process.platform !== 'linux') return;
  helper = join(fixture(), 'guard-child.cjs');
  // 真正子进程竞争生产模块；不向生产函数增加测试开关或替换 socket 实现。
  await build({ stdin: { contents: `
    import { acquireLinuxInstanceGuard } from './src/main/linux-instance-guard';
    const emit = (event, extra = {}) => process.stdout.write(JSON.stringify({ event, pid: process.pid, ...extra }) + '\\n');
    (async () => {
      emit('boot');
      await new Promise(resolve => process.stdin.once('data', resolve));
      const guard = await acquireLinuxInstanceGuard(process.argv[2], () => emit('open'));
      emit('result', { owned: guard !== null });
      if (!guard) process.exit(0);
      process.stdin.pause();
    })().catch(() => { emit('failed'); process.exit(1); });
  `, resolveDir: resolve('.') }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
});

afterEach(async () => {
  for (const socket of clients) socket.destroy();
  for (const guard of guards.splice(0)) guard.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  const active = [...children];
  await Promise.all(active.map(process => new Promise<void>(resolve => { process.once('exit', () => resolve()); process.kill('SIGKILL'); })));
  // helper 由 beforeAll 创建，需要一直保留至最后一项子进程测试。
  for (let index = directories.length - 1; index >= 0; index--) {
    if (helper?.startsWith(`${directories[index]}/`)) continue;
    rmSync(directories[index], { recursive: true, force: true }); directories.splice(index, 1);
  }
});
afterAll(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'linux')('Linux atomic profile instance guard', () => {
  it('confirms a second open without a second initialization or filesystem lock files', async () => {
    const profile = fixture(); let opens = 0;
    await own(profile, () => opens++);
    expect(await acquireLinuxInstanceGuard(profile, () => { throw new Error('Must not initialize'); })).toBeNull();
    expect(opens).toBe(1); expect(readdirSync(profile)).toEqual([]);
  });
  it('creates a fresh private profile and keeps distinct profiles independent', async () => {
    const base = fixture(), a = join(base, 'fresh-a'), b = join(base, 'fresh-b');
    let aOpens = 0, bOpens = 0;
    await own(a, () => aOpens++); await own(b, () => bOpens++);
    expect(await acquireLinuxInstanceGuard(a, () => {})).toBeNull();
    expect([aOpens, bOpens]).toEqual([1, 0]);
  });
  it('canonicalizes a directory symlink into the same profile without writing through a lock path', async () => {
    const base = fixture(), profile = join(base, 'real'), alias = join(base, 'alias');
    mkdirSync(profile); symlinkSync(profile, alias, 'dir'); let opens = 0;
    await own(profile, () => opens++);
    expect(await acquireLinuxInstanceGuard(alias, () => {})).toBeNull();
    expect(opens).toBe(1); expect(readdirSync(profile)).toEqual([]);
  });
  it('delivers an early open callback while window initialization is still pending', async () => {
    const profile = fixture(); let pendingOpen = false;
    await own(profile, () => { pendingOpen = true; });
    expect(await acquireLinuxInstanceGuard(profile, () => {})).toBeNull();
    expect(pendingOpen).toBe(true);
  });
  it('releases its kernel reservation on idempotent final disposal', async () => {
    const profile = fixture(), guard = await own(profile);
    guard.close(); guard.close();
    await own(profile);
  });
  it.each(['OPEN\nextra', 'EXEC\n', 'OPEN', 'ACK\n'])('rejects a non-fixed frame %j without invoking the open callback', async frame => {
    const profile = fixture(); let opens = 0;
    await own(profile, () => opens++);
    expect((await rawFrame(socketAddress(profile), frame)).length).toBe(0);
    expect(opens).toBe(0);
    expect(await acquireLinuxInstanceGuard(profile, () => {})).toBeNull(); expect(opens).toBe(1);
  });
  it('rejects an oversized message before accumulating it or accepting commands', async () => {
    const profile = fixture(); let opens = 0;
    await own(profile, () => opens++);
    expect((await rawFrame(socketAddress(profile), Buffer.alloc(65536, 88))).length).toBe(0);
    expect(opens).toBe(0);
  });
  it('times out an incomplete frame and remains available for a later valid open', async () => {
    const profile = fixture(); let opens = 0;
    await own(profile, () => opens++);
    const began = Date.now(); expect((await rawFrame(socketAddress(profile))).length).toBe(0);
    expect(Date.now() - began).toBeLessThan(1800); expect(opens).toBe(0);
    expect(await acquireLinuxInstanceGuard(profile, () => {})).toBeNull(); expect(opens).toBe(1);
  });
  it('uses an absolute incoming deadline instead of refreshing it for trickled OPEN bytes', async () => {
    const profile = fixture(); let opens = 0;
    await own(profile, () => opens++);
    const began = Date.now();
    const result = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(socketAddress(profile)), received: Buffer[] = [];
      let timer: ReturnType<typeof setInterval> | undefined;
      socket.on('data', chunk => received.push(chunk)); socket.on('error', reject);
      socket.once('connect', () => {
        const bytes = [...Buffer.from('OPEN\n')]; socket.write(Buffer.from([bytes.shift()!]));
        timer = setInterval(() => {
          const byte = bytes.shift(); if (byte !== undefined) socket.write(Buffer.from([byte]));
          if (bytes.length === 0) { clearInterval(timer); socket.end(); }
        }, 200);
      });
      socket.once('close', () => { clearInterval(timer); resolve(Buffer.concat(received)); });
    });
    expect(result.length).toBe(0); expect(opens).toBe(0); expect(Date.now() - began).toBeLessThan(1500);
  });
  it('fails closed on an occupied address that gives a wrong acknowledgement', async () => {
    const profile = fixture(); let callbacks = 0;
    await fakeOwner(profile, socket => socket.once('end', () => socket.end('WRONG\n')));
    await expect(acquireLinuxInstanceGuard(profile, () => callbacks++)).rejects.toThrow('已阻止重复启动');
    expect(callbacks).toBe(0);
  });
  it('fails closed when an owner accepts but never acknowledges', async () => {
    const profile = fixture(); await fakeOwner(profile, () => {});
    const began = Date.now();
    await expect(acquireLinuxInstanceGuard(profile, () => {})).rejects.toThrow('已阻止重复启动');
    expect(Date.now() - began).toBeLessThan(1800);
  });
  it('uses an absolute outgoing deadline even when an owner trickles a valid ACK', async () => {
    const profile = fixture();
    await fakeOwner(profile, socket => socket.once('end', () => {
      const bytes = [...Buffer.from('ACK\n')]; socket.write(Buffer.from([bytes.shift()!]));
      const timer = setInterval(() => {
        const byte = bytes.shift(); if (byte !== undefined) socket.write(Buffer.from([byte]));
        if (bytes.length === 0) { clearInterval(timer); socket.end(); }
      }, 200);
      socket.once('close', () => clearInterval(timer));
    }));
    const began = Date.now();
    await expect(acquireLinuxInstanceGuard(profile, () => {})).rejects.toThrow('已阻止重复启动');
    expect(Date.now() - began).toBeLessThan(1500);
  });
  it('sanitizes invalid profile and filesystem errors', async () => {
    const profile = fixture(), privateFile = join(profile, 'private-profile-file'); writeFileSync(privateFile, 'fixture');
    for (const invalid of ['relative-private-path', `${profile}\0private`, privateFile]) {
      const error = await acquireLinuxInstanceGuard(invalid, () => {}).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('无法确认 ModelDock 单实例状态，已阻止重复启动。');
      expect((error as Error).message).not.toContain(invalid);
    }
  });
  it('allows exactly one initialization when three actual processes compete together', async () => {
    const profile = fixture(), records = [child(profile), child(profile), child(profile)];
    await Promise.all(records.map(record => waitEvent(record, 'boot')));
    for (const record of records) record.process.stdin!.write('go\n');
    const results = await Promise.all(records.map(record => waitEvent(record, 'result')));
    expect(results.filter(result => result.owned)).toHaveLength(1);
    const winner = records.find((_, index) => results[index].owned)!;
    await expect.poll(() => winner.events.filter(event => event.event === 'open').length).toBe(2);
  });
  it('recovers after SIGKILL of its actual owning process without a stale-file or PID check', async () => {
    const profile = fixture(), record = child(profile);
    await waitEvent(record, 'boot'); record.process.stdin!.write('go\n');
    expect((await waitEvent(record, 'result')).owned).toBe(true);
    record.process.kill('SIGKILL'); await record.exited;
    await own(profile); expect(readdirSync(profile)).toEqual([]);
  });
});
