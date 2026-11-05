import { execFileSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type TestContext } from 'vitest';

type SymlinkKind = 'file' | 'dir';
const symlinkFailures = new Map<SymlinkKind, string | null>();

/** Junctions exercise the same directory reparse-point boundary without Windows symlink privilege. */
export function createDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Probe the actual filesystem privilege; unexpected fixture failures still fail the test. */
export function requireSymlinkCapability(context: TestContext, kind: SymlinkKind): void {
  if (!symlinkFailures.has(kind)) {
    const root = mkdtempSync(join(tmpdir(), 'modeldock-symlink-capability-'));
    try {
      const target = join(root, 'target'), link = join(root, 'link');
      if (kind === 'dir') mkdirSync(target); else writeFileSync(target, 'capability probe');
      try {
        if (kind === 'dir') createDirectoryLink(target, link); else symlinkSync(target, link, 'file');
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        symlinkFailures.set(kind, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error;
        symlinkFailures.set(kind, `${kind === 'dir' && process.platform === 'win32' ? 'directory junction' : `${kind} symlink`} capability unavailable on ${process.platform}: ${code}${kind === 'file' && process.platform === 'win32' ? '; requires Developer Mode or the symlink privilege' : ''}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const reason = symlinkFailures.get(kind);
  if (reason) context.skip(reason);
}

/** Some Windows filesystems refuse renaming a directory containing an open file. */
export function requireOpenFileDirectoryRenameCapability(context: TestContext): void {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-directory-race-capability-'));
  let fd: number | undefined;
  try {
    const directory = join(root, 'logs'); mkdirSync(directory);
    const file = join(directory, 'held.jsonl'); writeFileSync(file, 'capability probe');
    fd = openSync(file, constants.O_RDWR | constants.O_APPEND);
    try { renameSync(directory, join(root, 'moved-logs')); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
      context.skip(`Directory-swap race cannot be constructed on this Windows filesystem while a log file is open: ${code}`);
    }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(root, { recursive: true, force: true }); }
}

interface WindowsPermissions {
  owner: string;
  dacl: string;
  grants: { sid: string; rights: number }[];
}
const aclScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$paths=ConvertFrom-Json $env:MODELDOCK_TEST_ACL_PATHS
$items=@($paths | ForEach-Object {
  $acl=if([System.IO.Directory]::Exists($_)){[System.IO.Directory]::GetAccessControl($_)}else{[System.IO.File]::GetAccessControl($_)}
  @{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    dacl=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access);
    grants=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights}})}
})
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Depth 5 -Compress))
`;
function windowsPermissions(paths: string[]): WindowsPermissions[] {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const raw = execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclScript], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), MODELDOCK_TEST_ACL_PATHS: JSON.stringify(paths) },
  });
  const permissions: WindowsPermissions[] = JSON.parse(raw.replace(/^\uFEFF/, ''));
  expect(permissions).toHaveLength(paths.length);
  for (const item of permissions) {
    expect(item.owner).toMatch(/^S-\d-/); expect(item.dacl).toMatch(/^D:/); expect(Array.isArray(item.grants)).toBe(true);
  }
  return permissions;
}

/** Windows uses inherited DACLs, so a POSIX stat.mode value cannot prove privacy there. */
export function expectModeOrInheritedWindowsAcl(paths: string[], posixMode: number, parent: string): void {
  if (process.platform !== 'win32') {
    for (const path of paths) expect(statSync(path).mode & 0o777).toBe(posixMode);
    return;
  }
  const [baseline, ...created] = windowsPermissions([parent, ...paths]);
  const allowed = new Map<string, number>();
  for (const grant of baseline.grants) allowed.set(grant.sid, (allowed.get(grant.sid) ?? 0) | grant.rights);
  for (const item of created) {
    expect(item.owner).toBe(baseline.owner);
    expect(item.grants.length).toBeGreaterThan(0);
    for (const grant of item.grants) {
      expect(allowed.has(grant.sid), `New ACL trustee ${grant.sid}`).toBe(true);
      expect(grant.rights & ~(allowed.get(grant.sid) ?? 0), `Broader ACL rights for ${grant.sid}`).toBe(0);
    }
  }
}

/** Includes the real Windows DACL, so blocked writes must preserve more than file bytes. */
export function filesystemPermissions(path: string): number | WindowsPermissions {
  return process.platform === 'win32' ? windowsPermissions([path])[0] : statSync(path).mode & 0o777;
}
