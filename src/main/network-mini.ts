// SPDX-License-Identifier: GPL-3.0-or-later
import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import type { SettingsStore } from './settings';
import type { FlowBridgeManager } from './flowbridge';
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
      else if (action === 'expand') { this.expanded = !this.expanded; this.window.setSize(this.expanded ? 320 : 240, this.expanded ? 160 : 96); this.persist(); }
      else if (action === 'lock') { this.locked = !this.locked; this.window.setMovable(!this.locked); this.persist(); }
      else throw new Error('未知小窗操作。');
    });
  }
  private persist() { if (this.window) this.store.setManagedState('network.mini.v1', { ...this.window.getBounds(), expanded: this.expanded, locked: this.locked }); }
  async show() {
    if (this.window) { this.window.show(); return; }
    const saved = this.store.getManagedState<Record<string, unknown>>('network.mini.v1', {});
    this.expanded = saved.expanded === true; this.locked = saved.locked === true;
    const area = screen.getPrimaryDisplay().workArea;
    const width = this.expanded ? 320 : 240, height = this.expanded ? 160 : 96;
    const x = typeof saved.x === 'number' && Number.isFinite(saved.x) ? Math.min(Math.max(area.x, saved.x), area.x + area.width - width) : area.x + area.width - width - 16;
    const y = typeof saved.y === 'number' && Number.isFinite(saved.y) ? Math.min(Math.max(area.y, saved.y), area.y + area.height - height) : area.y + area.height - height - 16;
    const win = new BrowserWindow({ width, height, x, y, frame: false, resizable: false, movable: !this.locked, alwaysOnTop: true, skipTaskbar: true, show: false, title: 'ModelDock 网络监控', webPreferences: { preload: join(this.directory, 'network-mini-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
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
