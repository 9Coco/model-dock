/** OS network cleanup must succeed before calling this best-effort local cleanup. */
export async function finishLocalShutdown(
  resources: readonly { name: string; dispose: () => unknown | Promise<unknown> }[],
  complete: () => void,
  failed?: (name: string) => void,
): Promise<void> {
  try {
    for (const resource of resources) {
      try { await resource.dispose(); }
      catch {
        // Diagnostics must not stop the remaining disposals or the final quit.
        try { failed?.(resource.name); } catch { /* Continue closing. */ }
      }
    }
  } finally { complete(); }
}
