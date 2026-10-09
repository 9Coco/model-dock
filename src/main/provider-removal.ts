import type { Store, ProviderRemovalCheckpoint } from './store';
import type { ToolId } from '../shared/types';

type RemovalStore = Pick<Store, 'beginProviderRemoval' | 'restoreProviderRemoval' | 'finishProviderRemoval'>;
const automaticTools = new Set<ToolId>(['vscode', 'opencode', 'codex', 'copilot', 'dsh', 'claude-code']);
const active = new WeakSet<object>();
const messages = {
  busy: '供应商正在删除，请等待本次操作完成。',
  preparation: '无法备份或删除供应商，原配置未更改。',
  restored: '删除未完成，供应商和模型已恢复，相关工具已恢复原配置。',
  external: '删除未完成，供应商和模型已恢复；部分工具尚未恢复，请重新同步。',
  recovery: '删除未完成，恢复时发现其他修改；已保留加密备份，请检查本地配置。',
};
export class ProviderRemovalError extends Error {
  constructor(readonly category: keyof typeof messages) { super(messages[category]); this.name = 'ProviderRemovalError'; }
}

/** One explicit global deletion; never leave its old models in bound clients. */
export async function removeProviderAndSync(store: RemovalStore, providerId: string, synchronize: (tool: ToolId) => Promise<unknown>): Promise<void> {
  if (active.has(store)) throw new ProviderRemovalError('busy');
  active.add(store);
  let checkpoint: ProviderRemovalCheckpoint | undefined;
  const attempted: ToolId[] = [];
  try {
    try { checkpoint = store.beginProviderRemoval(providerId); }
    catch { throw new ProviderRemovalError('preparation'); }
    try {
      for (const tool of checkpoint.affectedToolIds.filter(id => automaticTools.has(id))) {
        attempted.push(tool);
        await synchronize(tool);
      }
      store.finishProviderRemoval(checkpoint);
    } catch {
      try { store.restoreProviderRemoval(checkpoint); }
      catch { throw new ProviderRemovalError('recovery'); }
      let restored = true;
      for (const tool of attempted) try { await synchronize(tool); } catch { restored = false; }
      throw new ProviderRemovalError(restored ? 'restored' : 'external');
    }
  } finally { active.delete(store); }
}
