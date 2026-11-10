// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export class NetworkEngineUnavailableError extends Error {}
export class NetworkAuthorizationRequired extends Error {}
export interface NetworkEngine {
  request<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}
/** Fixed network-only entry point, private stdio, bounded messages. */
export class FlowBridgeEngine implements NetworkEngine {
  private child?: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private root: string, private dataDir: string, private progress: (message: string) => void, private exited: () => void) {}
  private start() {
    if (this.child) return this.child;
    const executable = process.platform === 'win32' ? join(this.root, 'python', 'python.exe') : '/usr/bin/python3';
    if (!existsSync(executable) || !existsSync(join(this.root, 'bridge.py'))) throw new NetworkEngineUnavailableError('缺少网络组件，请安装完整 ModelDock 包（Linux 需要 Python 3.10+）。');
    const env: NodeJS.ProcessEnv = {};
    // Network subprocesses do not inherit provider API keys or app-specific secrets.
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(executable, ['-I', '-B', join(this.root, 'bridge.py'), '--data-dir', this.dataDir], { stdio: 'pipe', windowsHide: true, env });
    this.child = child;
    let buffer = '';
    const fail = () => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(child.pid ? new Error('网络组件已退出；请重试断开以检查恢复记录。') : new NetworkEngineUnavailableError('无法启动网络组件；系统网络未更改。')); }
      this.pending.clear(); this.exited();
    };
    child.on('error', fail); child.on('exit', fail);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 128 * 1024) { child.stdin.end(); fail(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value.event === 'progress' && typeof value.message === 'string') { this.progress(value.message.slice(0, 500)); continue; }
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(value.id);
          if (value.ok === true) pending.resolve(value.result);
          else {
            const message = typeof value.message === 'string' ? value.message.slice(0, 500) : '网络操作失败。';
            pending.reject(value.code === 'WINDOWS_NETWORK_AUTH_REQUIRED' ? new NetworkAuthorizationRequired(message) : new Error(message));
          }
        } catch { child.stdin.end(); fail(); return; }
      }
    });
    return child;
  }
  async request<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const child = this.start(), id = ++this.id;
    if (this.pending.size >= 16) return Promise.reject(new Error('网络操作仍在进行，请稍后重试。'));
    return new Promise<T>((resolve, reject) => {
      const connectTimeout = args.allowInstall === true ? 300_000 : 150_000;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('网络操作超时，清理状态未知；请重试断开。')); }, method === 'connect' || args.allowInstall === true ? connectTimeout : 65_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, ...args }) + '\n');
    });
  }
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('网络组件尚未退出，请重试退出。')), 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
