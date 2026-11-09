// SPDX-License-Identifier: GPL-3.0-or-later
import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import type { SettingsStore } from './settings';
import type { FlowBridgeManager } from './flowbridge';

function miniBounds(expanded: boolean, saved: { x?: unknown; y?: unknown }) {
  const width = expanded ? 320 : 240, height = expanded ? 160 : 96;
  const position = typeof saved.x === 'number' && Number.isFinite(saved.x)
    && typeof saved.y === 'number' && Number.isFinite(saved.y)
    ? { x: Math.round(saved.x), y: Math.round(saved.y) } : undefined;
  const display = position ? screen.getDisplayMatching({ ...position, width, height }) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const right = area.x + area.width - width, bottom = area.y + area.height - height;
  return { width, height,
    x: Math.max(area.x, Math.min(position?.x ?? right - 16, right)),
    y: Math.max(area.y, Math.min(position?.y ?? bottom - 16, bottom)),
  };
}

export class NetworkMini {
  private window?: BrowserWindow;
  private expanded = false;
  private locked = false;
  constructor(private manager: FlowBridgeManager, private store: SettingsStore, private reveal: () => void, private directory: string, private devUrl?: string) {
    ipcMain.handle('modeldock:network-mini', (event, action: string) => {
      if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error('未知小窗。');
      if (action === 'snapshot') { const value = this.manager.snapshot(); return { state: value.state, history: value.history.slice(-60), theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', expanded: this.expanded, locked: this.locked }; }
      if (action === 'hide') this.window.hide();
      else if (action === 'open') this.reveal();
      else if (action === 'expand') {
        this.expanded = !this.expanded;
        this.window.setBounds(miniBounds(this.expanded, this.window.getBounds()));
        this.persist();
      }
      else if (action === 'lock') { this.locked = !this.locked; this.window.setMovable(!this.locked); this.persist(); }
      else throw new Error('未知小窗操作。');
    });
  }
  private persist() { if (this.window) this.store.setManagedState('network.mini.v1', { ...this.window.getBounds(), expanded: this.expanded, locked: this.locked }); }
  async show() {
    if (this.window) { this.window.show(); return; }
    const saved = this.store.getManagedState<Record<string, unknown>>('network.mini.v1', {});
    this.expanded = saved.expanded === true; this.locked = saved.locked === true;
    const win = new BrowserWindow({ ...miniBounds(this.expanded, saved), frame: false, resizable: false, movable: !this.locked, alwaysOnTop: true, skipTaskbar: true, show: false, title: 'ModelDock 网络监控', webPreferences: { preload: join(this.directory, 'network-mini-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('moved', () => this.persist());
    win.on('closed', () => { this.window = undefined; });
    if (this.devUrl) await win.loadURL(this.devUrl + '#network-mini');
    else await win.loadFile(join(this.directory, '../dist/index.html'), { hash: 'network-mini' });
    win.showInactive();
  }
  close() { this.window?.destroy(); }
}
