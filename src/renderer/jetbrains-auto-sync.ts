import type { JetBrainsStatus, JetBrainsToolId } from '../shared/jetbrains';

export type JetBrainsAutoSyncState = { signature: string; phase: 'waiting' | 'checking' | 'applying' | 'error'; message: string };
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
    this.options.state(tool, { signature, phase: 'waiting', message: '选择已保存，正在确认 IDE 退出状态后自动同步。' });
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
          this.options.state(tool, { signature: request.signature, phase: 'waiting', message: status?.running === 'running'
            ? 'IDE 正在运行，选择已保存；退出后将自动同步最新配置。'
            : `选择已保存，待确认 IDE 退出及兼容配置后自动同步。${status?.message ?? '暂时无法读取 IDE 状态。'}` });
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
            this.options.state(tool, { signature: request.signature, phase: 'waiting', message: 'IDE 状态已变化，选择已保存；确认退出后将自动同步最新配置。' });
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
