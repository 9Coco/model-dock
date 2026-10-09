/** Undo availability metadata only; configuration contents and credentials stay in the main process. */
export interface ToolSyncUndoStatus {
  available: boolean;
  reason?: string;
  syncedAt?: number;
}
