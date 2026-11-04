import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';

const native = vi.hoisted(() => ({ fromWebContents: vi.fn(), buildFromTemplate: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: native.fromWebContents }, Menu: { buildFromTemplate: native.buildFromTemplate } }));
import { editContextMenuTemplate, installEditContextMenu } from '../src/main/edit-context-menu';

function context(patch: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return { isEditable: true, selectionText: 'synthetic selected text', formControlType: 'input-text', menuSourceType: 'mouse', frame: null,
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: false, canDelete: true, canSelectAll: true, canEditRichly: false }, ...patch } as ContextMenuParams;
}
function actions(template: MenuItemConstructorOptions[]) { return template.filter(item => item.type !== 'separator'); }
beforeEach(() => { native.fromWebContents.mockReset(); native.buildFromTemplate.mockReset(); });

describe('native text editing context menu', () => {
  it('provides normal editor roles and follows Chromium edit flags without copying text into menu data', () => {
    const params = context();
    const menu = actions(editContextMenuTemplate(params));
    expect(menu.map(item => [item.label, item.role, item.enabled])).toEqual([
      ['撤销','undo',true], ['重做','redo',false], ['剪切','cut',true], ['复制','copy',true], ['粘贴','paste',false], ['全选','selectAll',true],
    ]);
    expect(menu.every(item => item.click === undefined)).toBe(true);
    expect(JSON.stringify(menu)).not.toContain(params.selectionText);
  });

  it('lets selected read-only text be copied while blank areas and bare links do not open a second menu', () => {
    expect(actions(editContextMenuTemplate(context({isEditable:false}))).map(item => item.role)).toEqual(['copy','selectAll']);
    expect(editContextMenuTemplate(context({isEditable:false,selectionText:''}))).toEqual([]);
    expect(editContextMenuTemplate(context({isEditable:false,selectionText:'',linkURL:'https://example.invalid'}))).toEqual([]);
  });

  it.each([true,false])('never cuts or copies password/obscured controls even when edit flags allow it (editable=%s)', isEditable => {
    const params = context({isEditable,formControlType:'input-password',selectionText:'synthetic-secret'});
    const menu = actions(editContextMenuTemplate(params));
    expect(menu.find(item => item.role==='copy')?.enabled).toBe(false);
    expect(menu.find(item => item.role==='cut')?.enabled).toBe(false);
    expect(menu.find(item => item.role==='paste')?.enabled).toBe(false);
    expect(menu.find(item => item.role==='selectAll')?.enabled).toBe(true);
    expect(JSON.stringify(menu)).not.toContain('synthetic-secret');
    const paste = actions(editContextMenuTemplate({...params,editFlags:{...params.editFlags,canPaste:true}})).find(item=>item.role==='paste');
    expect(paste?.enabled).toBe(isEditable);
  });

  it('opens the native menu only for its living owner and removes listeners plus active popup on cleanup', () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(()=>false) });
    const owner = { isDestroyed: vi.fn(()=>false) }, popup = vi.fn(), closePopup = vi.fn();
    native.fromWebContents.mockReturnValue(owner); native.buildFromTemplate.mockReturnValue({popup,closePopup});
    const dispose = installEditContextMenu(contents as unknown as WebContents);
    contents.emit('context-menu',{},context({isEditable:false,selectionText:''})); expect(popup).not.toHaveBeenCalled();
    contents.emit('context-menu',{},context({menuSourceType:'keyboard'}));
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({window:owner,sourceType:'keyboard'}));
    contents.emit('context-menu',{},context()); expect(closePopup).toHaveBeenCalledWith(owner);
    dispose(); dispose();
    expect(contents.listenerCount('context-menu')).toBe(0); expect(contents.listenerCount('destroyed')).toBe(0);
    const callCount = popup.mock.calls.length; contents.emit('context-menu',{},context()); expect(popup).toHaveBeenCalledTimes(callCount);
  });

  it('cleans up on webContents destruction and refuses a destroyed or missing window', () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(()=>false) });
    const popup = vi.fn(), closePopup = vi.fn(); native.buildFromTemplate.mockReturnValue({popup,closePopup});
    native.fromWebContents.mockReturnValue(null); installEditContextMenu(contents as unknown as WebContents);
    contents.emit('context-menu',{},context()); expect(popup).not.toHaveBeenCalled();
    native.fromWebContents.mockReturnValue({isDestroyed:()=>true}); contents.emit('context-menu',{},context()); expect(popup).not.toHaveBeenCalled();
    contents.emit('destroyed'); expect(contents.listenerCount('context-menu')).toBe(0);
  });
});
