// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('networkMonitor', Object.freeze({
  snapshot: () => ipcRenderer.invoke('modeldock:network-mini', 'snapshot'),
  action: (action: string) => ['hide', 'open', 'expand', 'lock'].includes(action) ? ipcRenderer.invoke('modeldock:network-mini', action) : Promise.reject(new Error('未知小窗操作。')),
}));
