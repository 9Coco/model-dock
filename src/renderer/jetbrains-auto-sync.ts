import type { JetBrainsStatus, JetBrainsToolId } from '../shared/jetbrains';

export type JetBrainsAutoSyncState = { signature: string; phase: 'waiting' | 'checking' | 'applying' | 'blocked' | 'error'; message: string };
export function jetBrainsAutoSyncLabel(state: JetBrainsAutoSyncState): string {
  switch (state.phase) {
    case 'checking': return '正在检查 IDE 配置和运行状态';
    case 'waiting': return '选择已保存，等待 IDE 退出';
    case 'blocked': return '选择已保存，需确认 IDE 配置';
    case 'applying': return '正在自动同步 IDE';
    case 'error': return '选择已保存，同步未完成';
  }
}
interface Request { signature: string; revision: number; failed: boolean }
interface Options {
  status(tool: JetBrainsToolId): Promise<JetBrainsStatus | undefined>;
  eligible(tool: JetBrainsToolId, signature: string): boolean;
  available(tool: JetBrainsToolId): boolean;
  apply(tool: JetBrainsToolId, signature: string): Promise<void>;
  state(tool: JetBrainsToolId, state?: JetBrainsAutoSyncState): void;
}

/** 修改点：只把用户交互产生的选择入队；空构造不触发配置写入，状态检查期间的新选择取代旧选择。 */
export class JetBrainsAutoSync {
  private requests = new Map<JetBrainsToolId, Request>();
  private running = new Set<JetBrainsToolId>();
  private revision = 0;
  private disposed = false;
  constructor(private options: Options) {}
  pending(): JetBrainsToolId[] { return [...this.requests].filter(([, value]) => !value.failed).map(([tool]) => tool); }
  request(tool: JetBrainsToolId, signature: string): void {
    if (this.disposed) return;
    this.requests.set(tool, { signature, revision: ++this.revision, failed: false });
    this.options.state(tool, { signature, phase: 'checking', message: '选择已保存，正在检查 IDE 配置和运行状态。' });
  }
  cancel(tool: JetBrainsToolId): void { this.requests.delete(tool); if (!this.disposed) this.options.state(tool); }
  dispose(): void { this.disposed = true; this.requests.clear(); }
  async attempt(tool: JetBrainsToolId): Promise<void> {
    if (this.disposed || this.running.has(tool)) return;
    this.running.add(tool);
    try {
      while (!this.disposed) {
        const request = this.requests.get(tool);
        if (!request || request.failed) return;
        if (!this.options.eligible(tool, request.signature)) { this.cancel(tool); return; }
        if (!this.options.available(tool)) return;
        this.options.state(tool, { signature: request.signature, phase: 'checking', message: '正在确认 IDE 退出状态。' });
        const status = await this.options.status(tool);
        if (this.disposed) return;
        if (this.requests.get(tool)?.revision !== request.revision) continue;
        if (!this.options.eligible(tool, request.signature)) { this.cancel(tool); return; }
        if (!status?.canApply || status.running !== 'stopped') {
          this.options.state(tool, { signature: request.signature, phase: status?.running === 'running' ? 'waiting' : 'blocked', message: status?.running === 'running'
            ? 'IDE 正在运行，选择已保存；退出后将自动同步最新配置。'
            : `选择已保存，暂不能确定安全的配置目标或运行状态。${status?.message ?? '暂时无法读取 IDE 状态。'}` });
          return;
        }
        if (!this.options.available(tool)) return;
        this.options.state(tool, { signature: request.signature, phase: 'applying', message: '正在备份并自动同步 IDE 设置。' });
        try {
          await this.options.apply(tool, request.signature);
          if (this.disposed) return;
          if (this.requests.get(tool)?.revision === request.revision) { this.cancel(tool); return; }
        } catch (error) {
          if (this.disposed) return;
          if (this.requests.get(tool)?.revision !== request.revision) continue;
          // 状态检查后 IDE 仍可重新启动；主进程再次拒绝写入时，保留最新待办。
          const latest = await this.options.status(tool);
          if (this.disposed) return;
          if (this.requests.get(tool)?.revision !== request.revision) continue;
          if (latest?.running !== 'stopped' || !latest.canApply) {
            this.options.state(tool, { signature: request.signature, phase: latest?.running === 'running' ? 'waiting' : 'blocked', message: latest?.running === 'running'
              ? 'IDE 已重新启动，选择已保存；退出后将自动同步最新配置。'
              : `选择已保存，配置或进程状态发生变化，待确认后自动同步。${latest?.message ?? ''}` });
            return;
          }
          request.failed = true;
          this.options.state(tool, { signature: request.signature, phase: 'error', message: `选择已保存，自动同步未完成：${error instanceof Error ? error.message : '请检查配置状态后手动重新同步。'}` });
          return;
        }
      }
    } finally { this.running.delete(tool); }
  }
}
