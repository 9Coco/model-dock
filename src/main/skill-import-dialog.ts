interface DirectorySelection { canceled: boolean; filePaths: string[] }

/** Renderer arguments cannot grant access to local paths. */
export async function importSelectedLocalSkill<T>(
  select: () => Promise<DirectorySelection>,
  importLocal: (path: string) => T | Promise<T>,
  ...untrustedArguments: unknown[]
): Promise<T | null> {
  if (untrustedArguments.length) throw new Error('请通过系统对话框选择技能目录。');
  const result = await select();
  if (result.canceled || !result.filePaths[0]) return null;
  return importLocal(result.filePaths[0]);
}
