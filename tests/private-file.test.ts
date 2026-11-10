import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({ rename: vi.fn(), unlink: vi.fn(), write: vi.fn(), exec: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), renameSync: hooks.rename, unlinkSync: hooks.unlink, writeFileSync: hooks.write }));
vi.mock('node:child_process', () => ({ execFileSync: hooks.exec }));
const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const roots: string[] = [];
beforeEach(() => {
  vi.resetModules();
  hooks.rename.mockReset().mockImplementation(fs.renameSync);
  hooks.unlink.mockReset().mockImplementation(fs.unlinkSync);
  hooks.write.mockReset().mockImplementation(fs.writeFileSync);
  hooks.exec.mockReset().mockImplementation((command: string) => command === 'whoami.exe' ? '"fixture","S-1-5-21-100-200-300-1001"' : Buffer.alloc(0));
});
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(join(tmpdir(), 'modeldock-private-file-')); roots.push(root); return { root, path: join(root, 'secret.json') }; }
function windows() { vi.stubGlobal('process', { ...process, platform: 'win32' }); }

describe('private atomic files', () => {
  it('repairs permissive originals and writes buffers with private permissions', async () => {
    const f = fixture(), { replacePrivateFile } = await import('../src/main/private-file');
    fs.writeFileSync(f.path, 'old', { mode: 0o644 });
    replacePrivateFile(f.path, Buffer.from('SYNTHETIC_SECRET'));
    expect(fs.readFileSync(f.path, 'utf8')).toBe('SYNTHETIC_SECRET');
    if (process.platform !== 'win32') expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(f.root)).toEqual(['secret.json']);
  });
  it('rejects a file alias, multiple hard links, directory aliases and non-files before changing their target', async () => {
    const f = fixture(), { replacePrivateFile, protectPrivateFile } = await import('../src/main/private-file');
    const other = join(f.root, 'other'); fs.writeFileSync(other, 'keep');
    fs.linkSync(other, f.path);
    expect(() => replacePrivateFile(f.path, 'new')).toThrow(/链接/); expect(() => protectPrivateFile(f.path)).toThrow(/链接/);
    fs.unlinkSync(f.path);
    if (process.platform !== 'win32') {
      fs.symlinkSync(other, f.path); expect(() => replacePrivateFile(f.path, 'new')).toThrow(/链接/); fs.unlinkSync(f.path);
    }
    fs.mkdirSync(f.path); expect(() => replacePrivateFile(f.path, 'new')).toThrow(/普通文件/); fs.rmdirSync(f.path);
    const directory = join(f.root, 'dir'), alias = join(f.root, 'alias'); fs.mkdirSync(directory);
    fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => replacePrivateFile(join(alias, 'file'), 'new')).toThrow(/目录/);
    expect(fs.readFileSync(other, 'utf8')).toBe('keep'); expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('sets a complete protected Windows ACL on an empty temporary file before writing any secret bytes', async () => {
    const f = fixture(); windows();
    const { replacePrivateFile } = await import('../src/main/private-file');
    hooks.exec.mockImplementation((command: string, args: string[], options: { env: Record<string, string> }) => {
      if (command === 'whoami.exe') return '"fixture","S-1-5-21-100-200-300-1001"';
      expect(command).toBe('powershell.exe');
      const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
      expect(script).toContain('SetSecurityDescriptorSddlForm'); expect(script).toContain('D:P(A;;FA;;;{0})(A;;FA;;;SY)');
      expect(script).toContain('-LiteralPath $env:MODELDOCK_PRIVATE_FILE'); expect(script).not.toContain(f.root);
      expect(fs.readFileSync(options.env.MODELDOCK_PRIVATE_FILE, 'utf8')).toBe('');
      expect(hooks.write).not.toHaveBeenCalled(); return Buffer.alloc(0);
    });
    replacePrivateFile(f.path, 'SYNTHETIC_SECRET');
    expect(fs.readFileSync(f.path, 'utf8')).toBe('SYNTHETIC_SECRET');
  });
  it('replaces an existing Windows DACL and retries short antivirus locks within a fixed bound', async () => {
    const f = fixture(); fs.writeFileSync(f.path, 'old'); windows();
    const { replacePrivateFile } = await import('../src/main/private-file');
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' });
    hooks.rename.mockImplementationOnce(() => { throw locked; }).mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });
    replacePrivateFile(f.path, 'new');
    expect(hooks.rename).toHaveBeenCalledTimes(3); expect(fs.readFileSync(f.path, 'utf8')).toBe('new');
    const protectedPaths = hooks.exec.mock.calls.filter(([command]) => command === 'powershell.exe').map(([, , options]) => options.env.MODELDOCK_PRIVATE_FILE);
    expect(protectedPaths).toContain(f.path); expect(protectedPaths).toHaveLength(2);
    hooks.rename.mockReset().mockImplementation(() => { throw locked; });
    expect(() => replacePrivateFile(f.path, 'failed')).toThrow(locked); expect(hooks.rename).toHaveBeenCalledTimes(6);
    expect(fs.readFileSync(f.path, 'utf8')).toBe('new'); expect(fs.readdirSync(f.root)).toEqual(['secret.json']);
  });
  it('does not write secrets when ACL protection fails and preserves the primary failure if cleanup also fails', async () => {
    const f = fixture(); windows();
    const { replacePrivateFile } = await import('../src/main/private-file');
    const denied = Object.assign(new Error('SYNTHETIC_ACL_DENIED'), { code: 'EINVAL' });
    hooks.exec.mockImplementation((command: string) => { if (command === 'whoami.exe') return '"fixture","S-1-5-21-100-200-300-1001"'; throw denied; });
    hooks.unlink.mockImplementation(() => { throw Object.assign(new Error('SYNTHETIC_CLEANUP_FAILURE'), { code: 'EINVAL' }); });
    expect(() => replacePrivateFile(f.path, 'SECRET_MUST_NOT_REACH_DISK')).toThrow(denied);
    expect(hooks.write).not.toHaveBeenCalled(); expect(fs.existsSync(f.path)).toBe(false);
    const leftover = fs.readdirSync(f.root); expect(leftover).toHaveLength(1); expect(fs.readFileSync(join(f.root, leftover[0]), 'utf8')).toBe('');
  });
  it('does not retry unrelated failures and never lets a cleanup error hide the rename error', async () => {
    const f = fixture(), { replacePrivateFile } = await import('../src/main/private-file');
    const failure = Object.assign(new Error('SYNTHETIC_RENAME_FAILURE'), { code: 'ENOSPC' });
    hooks.rename.mockImplementation(() => { throw failure; }); hooks.unlink.mockImplementation(() => { throw new Error('cleanup'); });
    expect(() => replacePrivateFile(f.path, 'private')).toThrow(failure); expect(hooks.rename).toHaveBeenCalledTimes(1);
  });
});
