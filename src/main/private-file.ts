import { closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const wait = new Int32Array(new SharedArrayBuffer(4));
/** Antivirus/indexer locks on Windows are transient; other errors fail immediately. */
export function retryPrivateFileOperation<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) try { return operation(); }
  catch (error) {
    if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    Atomics.wait(wait, 0, 0, (attempt + 1) * 10);
  }
}
export function privatePathIdentity(path: string): string {
  const target = resolve(path);
  return process.platform === 'win32' ? target.toLowerCase() : target;
}
function info(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function safeTarget(path: string): void {
  for (let current = dirname(resolve(path)); ; current = dirname(current)) {
    const entry = info(current);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error('私有文件目录含链接或非目录，未写入文件。');
    if (dirname(current) === current) break;
  }
  const entry = info(path);
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw new Error('私有文件目标含链接或不是普通文件，未写入文件。');
}
let windowsSid: string | undefined;
/** Replace the complete DACL: /grant:r alone would retain explicit Everyone ACEs. */
export function protectPrivateFile(path: string): void {
  safeTarget(path);
  if (process.platform !== 'win32') { chmodSync(path, 0o600); return; }
  windowsSid ??= execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!windowsSid) throw new Error('无法确认私有文件的本机用户权限。');
  const script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:MODELDOCK_PRIVATE_FILE; $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;{0})(A;;FA;;;SY)' -f $env:MODELDOCK_PRIVATE_SID), [System.Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath $env:MODELDOCK_PRIVATE_FILE -AclObject $acl";
  retryPrivateFileOperation(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: 'pipe', env: { ...process.env, MODELDOCK_PRIVATE_FILE: resolve(path), MODELDOCK_PRIVATE_SID: windowsSid },
  }));
}
/** Caller validates content/ownership. This layer rejects aliases and secures bytes before writing them. */
export function replacePrivateFile(path: string, content: string | Uint8Array | null): void {
  safeTarget(path);
  if (content === null) { if (info(path)) retryPrivateFileOperation(() => unlinkSync(path)); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Repair an older permissive target before exposing any new credential bytes.
  if (info(path)) protectPrivateFile(path);
  const temporary = `${path}.modeldock-${randomUUID()}.tmp`;
  let fd: number | undefined, failed = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    protectPrivateFile(temporary);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    safeTarget(path);
    retryPrivateFileOperation(() => renameSync(temporary, path));
  } catch (error) { failed = true; throw error; }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch (error) { if (!failed) throw error; }
    try { retryPrivateFileOperation(() => unlinkSync(temporary)); }
    catch (error) { if (!failed && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
