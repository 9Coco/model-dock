import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolId } from '../shared/types';
import type { ToolUsageImportResult, UsageDataSource, UsageSourcesSnapshot, UsageSyncResult } from '../shared/usage-import-types';
import { importToolUsage, type ClientUsageStore, type UsageImportOptions } from './usage-import';

interface UsageSyncStore extends ClientUsageStore {
  dataDir?: string;
  getManagedState?<T>(key: string, fallback: T): T;
  setManagedState?(key: string, value: unknown): void;
}
const TOOLS: ToolId[] = ['codex', 'opencode', 'dsh', 'vscode', 'copilot'];
const NAMES: Record<ToolId, string> = { codex: 'Codex', opencode: 'OpenCode', dsh: 'DSH', vscode: 'VS Code', copilot: 'Copilot app' };
const PRIVACY = '只读取本地会话的时间、模型标识及 Token 计数；不保存提示词、回复、工具输出、账户凭据，也不修改外部客户端文件。原生事件无法证明 HTTP 成功率或请求速度。';
const KEY = 'usage-sync:v1';

/** Timers are deliberately owned by the visible usage page. Construction and
 * source inspection never import native client data or start background work.
 */
export class UsageSyncService {
  private running?: Promise<UsageSyncResult>;
  private last?: UsageSyncResult;
  constructor(private readonly store: UsageSyncStore, private readonly options: UsageImportOptions & { now?: () => number } = {}) {
    try { const stored = store.getManagedState?.<UsageSyncResult | null>(KEY, null); if (stored && Array.isArray(stored.results) && typeof stored.completedAt === 'string') this.last = stored; }
    catch { /* Sources remain inspectable when previous sync metadata is unavailable. */ }
  }
  private now(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  sync(): Promise<UsageSyncResult> {
    if (this.running) return this.running;
    const promise = this.run(); this.running = promise;
    void promise.finally(() => { if (this.running === promise) this.running = undefined; }).catch(() => {});
    return promise;
  }
  private async run(): Promise<UsageSyncResult> {
    const startedAt = this.now(), results: ToolUsageImportResult[] = [];
    for (const tool of TOOLS) {
      try { results.push(await importToolUsage(tool, this.store, this.options)); }
      catch { results.push({ tool, status: 'error', imported: 0, skipped: 0, scannedFiles: 0, deferredFiles: 1, warnings: ['本地用量同步失败；后续可重试。'] }); }
    }
    const result: UsageSyncResult = {
      startedAt, completedAt: this.now(), imported: results.reduce((sum, row) => sum + row.imported, 0), skipped: results.reduce((sum, row) => sum + row.skipped, 0),
      scannedFiles: results.reduce((sum, row) => sum + row.scannedFiles, 0), deferredFiles: results.reduce((sum, row) => sum + row.deferredFiles, 0), results,
      warnings: results.flatMap(row => row.warnings.map(warning => `${NAMES[row.tool]}：${warning}`)),
    };
    this.last = result;
    try { this.store.setManagedState?.(KEY, result); }
    catch { result.warnings.push('同步结果已生成，但同步时间无法保存；导入记录仍按唯一标识去重。'); }
    return structuredClone(result);
  }
  async sources(): Promise<UsageSourcesSnapshot> {
    const home = this.options.homeDir ?? homedir();
    const codex = resolve(this.options.codexHome ?? (this.options.homeDir ? join(home, '.codex') : process.env.CODEX_HOME ?? join(home, '.codex')));
    const openCode = resolve(this.options.opencodeDataDir ?? join(this.options.homeDir ? join(home, '.local', 'share') : process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode'));
    const dsh = resolve(this.options.dshHome ?? (this.options.homeDir ? join(home, '.dsh') : process.env.DSH_HOME ?? join(home, '.dsh')));
    const copilot = resolve(this.options.copilotHome ?? (this.options.homeDir ? join(home, '.copilot') : process.env.COPILOT_HOME ?? join(home, '.copilot')));
    const appData = this.options.appDataDir ?? (this.options.homeDir ? join(home, 'AppData', 'Roaming') : process.env.APPDATA ?? join(home, '.config'));
    const sources: UsageDataSource[] = [{ id: 'gateway', source: 'gateway', name: 'ModelDock 网关', status: 'ready', supported: true,
      paths: this.store.dataDir ? [join(this.store.dataDir, 'modeldock.sqlite')] : [], format: '网关请求的最终上游用量',
      description: '自动记录经过本机网关的请求。直接连接供应商的客户端请求由下方原生会话来源提供。' }];
    const specs: { tool: ToolId; paths: string[]; format: string; supported: boolean; description: string }[] = [
      { tool: 'codex', paths: [join(codex, 'sessions'), join(codex, 'archived_sessions')], format: 'Codex rollout JSONL', supported: true, description: '读取 token_count 元数据；优先使用单次用量，处理累计计数、回放、归档与分支去重。' },
      { tool: 'opencode', paths: [join(openCode, 'opencode.db')], format: 'OpenCode SQLite V1 / V2 + WAL', supported: true, description: '只在内存中合并校验通过的已提交 WAL，读取已完成消息的模型和 Token 元数据；不创建客户端数据库旁的任何文件。' },
      { tool: 'dsh', paths: [dsh], format: '尚未核实可导入的原生会话格式', supported: false, description: 'DSH 的会话与 profile 布局未得到兼容验证；直接请求用量不能由会话数推算。' },
      { tool: 'vscode', paths: [join(appData, 'Code', 'User', 'workspaceStorage')], format: 'Copilot Chat 原生历史暂不支持', supported: false, description: '未核实稳定的本地逐请求 Token 格式；经过 ModelDock 网关的请求仍会自动记录。' },
      { tool: 'copilot', paths: [join(copilot, 'session-state')], format: '原生会话日志缺少持久用量事件', supported: false, description: '官方 SDK 的 assistant.usage 为临时事件，不写入会话历史日志；无法恢复历史逐请求 Token。经过网关的请求仍可统计。' },
    ];
    for (const spec of specs) {
      const lastResult = this.last?.results.find(row => row.tool === spec.tool);
      let status: UsageDataSource['status'] = spec.supported ? 'missing' : 'unsupported';
      if (spec.supported) {
        const checks = await Promise.all(spec.paths.map(async path => { try { const info = await lstat(path); return info.isSymbolicLink() ? 'error' : info.isFile() || info.isDirectory() ? 'ready' : 'error'; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error'; } }));
        status = checks.includes('ready') ? 'ready' : checks.includes('error') ? 'error' : 'missing';
        if (lastResult?.status === 'error' && status === 'ready') status = 'error';
        if (lastResult?.status === 'unsupported' && status === 'ready') status = 'unsupported';
      }
      sources.push({ id: `client:${spec.tool}`, source: 'client', tool: spec.tool, name: NAMES[spec.tool], paths: spec.paths, format: spec.format,
        supported: spec.supported, status, description: spec.description, lastSyncAt: lastResult ? this.last?.completedAt : undefined, lastResult: lastResult ? structuredClone(lastResult) : undefined });
    }
    return { queriedAt: this.now(), privacy: PRIVACY, sources, lastSync: this.last ? structuredClone(this.last) : undefined };
  }
}
