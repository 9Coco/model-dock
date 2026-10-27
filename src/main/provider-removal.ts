import type { Store, ProviderRemovalCheckpoint } from './store';
import { isDeepStrictEqual } from 'node:util';
import type { ToolBinding, ToolId } from '../shared/types';

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
  constructor(readonly category: keyof typeof messages, readonly toolId?: ToolId) {
    const names: Partial<Record<ToolId, string>> = { vscode: 'VS Code', opencode: 'OpenCode', codex: 'Codex', copilot: 'GitHub Copilot', dsh: 'DeepSeek Harness', 'claude-code': 'Claude Code' };
    super(messages[category] + (toolId && names[toolId] ? ` 同步失败的工具：${names[toolId]}。` : ''));
    this.name = 'ProviderRemovalError';
  }
}

function synchronizationTargets(checkpoint: ProviderRemovalCheckpoint): ToolId[] {
  // A removal also prunes disabled selections and the inactive mode's draft.
  // Keep those rows in the checkpoint for restoration, without applying them.
  const selection = ({ enabled, mode, providerIds, modelIds, modelSelection, defaultModelId }: ToolBinding) => ({ enabled, mode, providerIds, modelIds, modelSelection, defaultModelId });
  return checkpoint.affectedToolIds.filter(id => {
    if (!automaticTools.has(id)) return false;
    const before = checkpoint.beforeBindings.find(binding => binding.id === id);
    const after = checkpoint.afterBindings.find(binding => binding.id === id);
    if (!before || !after) throw new Error('供应商删除缺少工具选择恢复记录。');
    return (before.enabled || after.enabled) && !isDeepStrictEqual(selection(before), selection(after));
  });
}

/** One explicit global deletion; never leave its old models in bound clients. */
export async function removeProviderAndSync(store: RemovalStore, providerId: string, synchronize: (tool: ToolId) => Promise<unknown>): Promise<void> {
  if (active.has(store)) throw new ProviderRemovalError('busy');
  active.add(store);
  let checkpoint: ProviderRemovalCheckpoint | undefined;
  let failedTool: ToolId | undefined;
  const attempted: ToolId[] = [];
  try {
    try { checkpoint = store.beginProviderRemoval(providerId); }
    catch { throw new ProviderRemovalError('preparation'); }
    try {
      for (const tool of synchronizationTargets(checkpoint)) {
        failedTool = tool;
        attempted.push(tool);
        await synchronize(tool);
      }
      failedTool = undefined;
      store.finishProviderRemoval(checkpoint);
    } catch {
      try { store.restoreProviderRemoval(checkpoint); }
      catch { throw new ProviderRemovalError('recovery', failedTool); }
      let restored = true;
      for (const tool of attempted) try { await synchronize(tool); } catch { restored = false; }
      throw new ProviderRemovalError(restored ? 'restored' : 'external', failedTool);
    }
  } finally { active.delete(store); }
}
