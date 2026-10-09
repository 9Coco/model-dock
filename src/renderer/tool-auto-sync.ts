import type { ToolBinding, ToolId } from '../shared/types';

export type ToolAutoSyncState = { signature: string; phase: 'waiting' | 'applying' | 'error'; message: string };
export interface ToolAutoSyncOptions {
  apply(tool: ToolId, binding: ToolBinding, automatic: boolean): Promise<void>;
  signature?(tool: ToolId, binding: ToolBinding): string;
  available?(tool: ToolId, automatic: boolean): boolean;
  state?(tool: ToolId, state?: ToolAutoSyncState): void;
  debounceMs?: number;
}

/** Match the main-process write lock using only operations that have actually started, never queued choices. */
export function canStartToolSync(tool: ToolId, automatic: boolean, pendingActions: ReadonlySet<string>): boolean {
  for (const key of pendingActions) {
    if (key === 'delete') return false;
    if (/^(apply-tool-|restore-tool-|undo-tool-)/.test(key)) {
      // App.run owns the manual request's apply lock before it flushes the coordinator.
      if (!automatic && key === `apply-tool-${tool}`) continue;
      return false;
    }
    if ([`tool-binding-${tool}`, `preview-${tool}`, `export-tool-${tool}`].includes(key)) return false;
  }
  return true;
}

interface Waiter { resolve(): void; reject(error: unknown): void }
interface Request {
  binding: ToolBinding;
  signature: string;
  automatic: boolean;
  readyAt: number;
  waiters: Waiter[];
}
interface Active { request: Request; completion: Promise<void>; cancelled: boolean }
interface Slot { pending?: Request; active?: Active; timer?: ReturnType<typeof setTimeout> }

/** Only explicit interactions enqueue writes; each tool applies its latest selection after a quiet interval. */
export class ToolAutoSync {
  private slots = new Map<ToolId, Slot>();
  private disposed = false;
  private readonly debounceMs: number;

  constructor(private options: ToolAutoSyncOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 400);
  }

  pending(): ToolId[] {
    return [...this.slots].filter(([, slot]) => slot.pending || slot.active).map(([tool]) => tool);
  }

  request(tool: ToolId, binding: ToolBinding): void {
    if (this.disposed) return;
    const slot = this.slot(tool), request = this.selection(tool, binding, true);
    this.replace(tool, slot, request);
    if (slot.pending) this.schedule(tool, slot);
  }

  /** Manual sync consumes the queued selection immediately and shares an identical in-flight write. */
  flush(tool: ToolId, binding?: ToolBinding): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const slot = this.slot(tool);
    if (binding) this.replace(tool, slot, this.selection(tool, binding, false));
    if (slot.pending) {
      slot.pending.automatic = false;
      slot.pending.readyAt = Date.now();
      this.clearTimer(slot);
      const completion = new Promise<void>((resolve, reject) => { slot.pending!.waiters.push({ resolve, reject }); });
      this.attempt(tool, slot);
      return completion;
    }
    return slot.active?.completion ?? Promise.resolve();
  }

  /** Cancel deferred work and wait for an already-started write before undo or restoration. */
  cancel(tool: ToolId): Promise<void> {
    const slot = this.slots.get(tool);
    if (!slot) return Promise.resolve();
    this.clearTimer(slot);
    if (slot.pending) { for (const waiter of slot.pending.waiters) waiter.resolve(); slot.pending = undefined; }
    if (slot.active) slot.active.cancelled = true;
    if (!this.disposed) this.options.state?.(tool);
    return slot.active?.completion.catch(() => {}) ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    for (const tool of this.slots.keys()) void this.cancel(tool);
    this.slots.clear();
  }

  private slot(tool: ToolId): Slot {
    let slot = this.slots.get(tool);
    if (!slot) { slot = {}; this.slots.set(tool, slot); }
    return slot;
  }

  private selection(tool: ToolId, binding: ToolBinding, automatic: boolean): Request {
    const copy = structuredClone(binding);
    return { binding: copy, signature: this.options.signature?.(tool, copy) ?? JSON.stringify(copy), automatic,
      readyAt: Date.now() + (automatic ? this.debounceMs : 0), waiters: [] };
  }

  private replace(tool: ToolId, slot: Slot, request: Request): void {
    this.clearTimer(slot);
    request.waiters.push(...(slot.pending?.waiters ?? []));
    // Choosing the value already being written also cancels any superseded deferred choice.
    if (slot.active && slot.active.request.signature === request.signature) {
      slot.active.request.waiters.push(...request.waiters);
      slot.pending = undefined;
      this.options.state?.(tool, { signature: request.signature, phase: 'applying', message: '正在备份并同步配置。' });
      return;
    }
    slot.pending = request;
    this.options.state?.(tool, { signature: request.signature, phase: 'waiting', message: '选择已保存，稍后自动同步最新配置。' });
  }

  private clearTimer(slot: Slot): void {
    if (slot.timer !== undefined) { clearTimeout(slot.timer); slot.timer = undefined; }
  }

  private schedule(tool: ToolId, slot: Slot): void {
    this.clearTimer(slot);
    if (this.disposed || !slot.pending || slot.active) return;
    const delay = slot.pending.readyAt - Date.now();
    if (delay <= 0) { this.attempt(tool, slot); return; }
    slot.timer = setTimeout(() => { slot.timer = undefined; this.attempt(tool, slot); }, delay);
  }

  private attempt(tool: ToolId, slot: Slot): void {
    if (this.disposed || slot.active || !slot.pending) return;
    if (slot.pending.readyAt > Date.now()) { this.schedule(tool, slot); return; }
    if (this.options.available?.(tool, slot.pending.automatic) === false) {
      this.clearTimer(slot);
      slot.timer = setTimeout(() => { slot.timer = undefined; this.attempt(tool, slot); }, 25);
      return;
    }
    this.clearTimer(slot);
    const request = slot.pending;
    slot.pending = undefined;
    const active: Active = { request, completion: Promise.resolve(), cancelled: false };
    slot.active = active;
    this.options.state?.(tool, { signature: request.signature, phase: 'applying', message: '正在备份并同步配置。' });
    active.completion = this.apply(tool, slot, active);
    // Automatic writes report failures through state; their promises have no external caller.
    void active.completion.catch(() => {});
  }

  private async apply(tool: ToolId, slot: Slot, active: Active): Promise<void> {
    let failed = false, failure: unknown;
    try {
      await this.options.apply(tool, active.request.binding, active.request.automatic);
    } catch (error) {
      failed = true; failure = error;
    }
    slot.active = undefined;
    if (!this.disposed) {
      if (slot.pending) this.schedule(tool, slot);
      else if (!active.cancelled) this.options.state?.(tool, failed ? { signature: active.request.signature, phase: 'error',
        message: `选择已保存，同步未完成：${failure instanceof Error ? failure.message : String(failure)}` } : undefined);
    }
    for (const waiter of active.request.waiters) { if (failed) waiter.reject(failure); else waiter.resolve(); }
    if (failed) throw failure;
  }
}
