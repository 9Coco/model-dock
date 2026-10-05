import { describe, expect, it, vi } from 'vitest';
import { MAX_CLIPBOARD_TEXT_BYTES, writeClipboardText } from '../src/main/clipboard-text';

describe('explicit clipboard text writes', () => {
  it('preserves a device code and multiline Unicode configuration exactly', async () => {
    const write = vi.fn(async (_text: string) => {});
    for (const text of ['MOCK-00000', '{\n  "模型": "套餐 - 模型",\n  "emoji": "🚀"\n}\n', '']) {
      await writeClipboardText(text, write);
      expect(write).toHaveBeenLastCalledWith(text);
    }
  });
  it.each([null, undefined, 1, {}, ['code'], 'code\0hidden'])('rejects invalid text without touching the clipboard', async value => {
    const write = vi.fn();
    await expect(writeClipboardText(value, write)).rejects.toThrow('文本格式无效');
    expect(write).not.toHaveBeenCalled();
  });
  it('bounds encoded bytes, including multibyte Unicode', async () => {
    const write = vi.fn();
    await writeClipboardText('a'.repeat(MAX_CLIPBOARD_TEXT_BYTES), write);
    write.mockClear();
    for (const oversized of ['a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1), '模'.repeat(Math.ceil(MAX_CLIPBOARD_TEXT_BYTES / 3))]) {
      await expect(writeClipboardText(oversized, write)).rejects.toThrow('超过 1 MiB');
      expect(write).not.toHaveBeenCalled();
    }
  });
  it('waits for the native write to finish before reporting success', async () => {
    let finish!: () => void;
    let completed = false;
    const pending = writeClipboardText('MOCK-00000', () => new Promise<void>(done => { finish = done; })).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await pending;
    expect(completed).toBe(true);
  });
  it('reports asynchronous native failures without leaking copied text or error details', async () => {
    const write = vi.fn(async () => { throw new Error('PRIVATE_TEXT_NATIVE_FAILURE'); });
    await expect(writeClipboardText('PRIVATE_TEXT', write)).rejects.toThrow(/^无法写入系统剪贴板，请稍后重试。$/);
  });
});
