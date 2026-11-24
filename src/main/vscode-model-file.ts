import { existsSync, readFileSync } from 'node:fs';
import { replacePrivateFile } from './private-file';

export function writeVsCodeModelFile(
  store: { createManagedBackup?(kind: string, value: unknown): string },
  target: string, before: string | null, after: string | null, beforeCommit?: () => void,
): string {
  if (before === after) return target;
  if (before !== null) {
    if (!store.createManagedBackup) throw new Error('缺少加密备份服务，未修改 VS Code 模型文件。');
    store.createManagedBackup('vscode-models', { version: 1, path: target, content: before });
  }
  beforeCommit?.();
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current !== before) throw new Error('配置刚被其他程序修改，请重新预览后再应用。');
  replacePrivateFile(target, after);
  return target;
}
