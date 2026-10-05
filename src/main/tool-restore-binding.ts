import type { ToolBinding, ToolId } from '../shared/types';

interface RestoreBindingStore {
  listBindings(): ToolBinding[];
  saveBinding(binding: ToolBinding): void;
  createManagedBackup(kind: string, value: unknown): string;
}

/** Disable the tool's gateway routes before restoration; roll the selection
 * back if the native operation cannot complete. Both selections are backed up. */
export async function restoreToolBinding(store: RestoreBindingStore, tool: ToolId, restoreNative: () => Promise<string>): Promise<string> {
  const previous = store.listBindings().find(binding => binding.id === tool);
  if (!previous) throw new Error('找不到此工具的配置。');
  store.createManagedBackup('tool-official-restore', { version: 1, tool, binding: previous });
  store.saveBinding({ ...previous, enabled: false, mode: 'direct', providerIds: [], modelIds: [], defaultModelId: '' });
  try { return await restoreNative(); }
  catch (error) {
    try { store.saveBinding(previous); }
    catch { throw new Error('官方配置还原未完成，工具选择恢复失败；原选择已保留在加密备份中，请检查本地配置。'); }
    throw error;
  }
}
