import { app, nativeImage, type NativeImage } from 'electron';
import { join } from 'node:path';

/** One brand source for native window, taskbar and tray. Packaged assets are
 * external resources, so native Windows image loading never depends on ASAR.
 */
export function getAppIcon(tray = false): NativeImage {
  const name = tray ? 'modeldock-tray.png' : 'modeldock.png';
  const path = app.isPackaged ? join(process.resourcesPath, 'icons', name) : join(app.getAppPath(), 'assets', name);
  const icon = nativeImage.createFromPath(path);
  if (icon.isEmpty()) throw new Error('ModelDock 应用图标资源缺失，请重新构建安装包。');
  return tray ? icon.resize({ width: process.platform === 'win32' ? 16 : 22, height: process.platform === 'win32' ? 16 : 22, quality: 'best' }) : icon;
}
