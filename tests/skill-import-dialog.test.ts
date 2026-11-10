import { describe, expect, it, vi } from 'vitest';
import { importSelectedLocalSkill } from '../src/main/skill-import-dialog';

describe('main-process local skill selection', () => {
  it.each(['/renderer/chosen-secret-folder', undefined, { path: '/private' }])('rejects supplied arguments before reading any directory', async input => {
    const select = vi.fn(), importLocal = vi.fn();
    await expect(importSelectedLocalSkill(select, importLocal, input)).rejects.toThrow('系统对话框');
    expect(select).not.toHaveBeenCalled(); expect(importLocal).not.toHaveBeenCalled();
  });
  it('imports only the directory returned by the native picker', async () => {
    const importLocal = vi.fn(path => ({ selected: path }));
    const result = await importSelectedLocalSkill(async () => ({ canceled: false, filePaths: ['/user/selected-skill'] }), importLocal);
    expect(result).toEqual({ selected: '/user/selected-skill' }); expect(importLocal).toHaveBeenCalledExactlyOnceWith('/user/selected-skill');
  });
  it.each([{ canceled: true, filePaths: ['/cancelled-selection'] }, { canceled: false, filePaths: [] }])('does not import after cancelling or receiving an empty selection', async selection => {
    const importLocal = vi.fn();
    expect(await importSelectedLocalSkill(async () => selection, importLocal)).toBeNull(); expect(importLocal).not.toHaveBeenCalled();
  });
});
