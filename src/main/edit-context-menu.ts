import { BrowserWindow, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';

type EditContext = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'formControlType' | 'editFlags'> & {
  /** Older Electron versions exposed this name instead of formControlType. */
  inputFieldType?: string;
};

/** Standard editing only. Never include selected text, keys, links or IPC actions. */
export function editContextMenuTemplate(params: EditContext): MenuItemConstructorOptions[] {
  const password = params.formControlType === 'input-password' || params.inputFieldType === 'password';
  if (!params.isEditable && !password && !params.selectionText) return [];
  const flags = params.editFlags;
  const copy: MenuItemConstructorOptions = { label: '复制', role: 'copy', enabled: !password && flags.canCopy };
  const selectAll: MenuItemConstructorOptions = { label: '全选', role: 'selectAll', enabled: flags.canSelectAll };
  if (!params.isEditable && !password) return [copy, { type: 'separator' }, selectAll];
  return [
    { label: '撤销', role: 'undo', enabled: params.isEditable && flags.canUndo },
    { label: '重做', role: 'redo', enabled: params.isEditable && flags.canRedo },
    { type: 'separator' },
    { label: '剪切', role: 'cut', enabled: params.isEditable && !password && flags.canCut },
    copy,
    { label: '粘贴', role: 'paste', enabled: params.isEditable && flags.canPaste },
    { type: 'separator' },
    selectAll,
  ];
}

/** Attach to the application's own window. Blank areas remain renderer-owned. */
export function installEditContextMenu(contents: WebContents): () => void {
  let active: Menu | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    contents.removeListener('context-menu', onContextMenu);
    contents.removeListener('destroyed', dispose);
    active?.closePopup();
    active = undefined;
  };
  const onContextMenu = (_event: Electron.Event, params: ContextMenuParams) => {
    if (disposed || contents.isDestroyed()) return;
    const template = editContextMenuTemplate(params);
    if (!template.length) return;
    const window = BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) return;
    active?.closePopup(window);
    const menu = Menu.buildFromTemplate(template);
    active = menu;
    menu.popup({ window, sourceType: params.menuSourceType, ...(params.frame ? { frame: params.frame } : {}),
      callback: () => { if (active === menu) active = undefined; } });
  };
  contents.on('context-menu', onContextMenu);
  contents.once('destroyed', dispose);
  return dispose;
}
