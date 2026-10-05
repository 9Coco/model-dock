/** Write only explicitly supplied text; never expose clipboard reads to the renderer. */
export const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;

export async function writeClipboardText(value: unknown, writeText: (text: string) => void | Promise<void>): Promise<void> {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('无法复制：文本格式无效。');
  if (value.length > MAX_CLIPBOARD_TEXT_BYTES || Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) {
    throw new Error('无法复制：文本超过 1 MiB，请使用导出功能。');
  }
  try { await writeText(value); }
  catch { throw new Error('无法写入系统剪贴板，请稍后重试。'); }
}
