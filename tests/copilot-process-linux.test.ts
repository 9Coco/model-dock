import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { verifyCopilotDesktopProcess } from '../src/main/copilot-process';
import { collectLinuxCopilotProcessEvidence, isTrustedLinuxCopilotExecutable, isVerifiedLinuxCopilotProcess,
  parseLinuxProcessIdentity, parseLinuxTcpListeners, type LinuxCopilotProcessEvidence } from '../src/main/copilot-process-linux';

const pid = 3187, port = 34265;
function evidence(): LinuxCopilotProcessEvidence {
  const path = (path: string, kind: 'file' | 'directory', inode: string) => ({ path, kind, uid: 0, mode: 0o755, device: '2049', inode, size: '100', modified: '1000000', changed: '1000000' });
  return { platform: 'linux', trustSource: 'system-administrator', currentUid: 1000, networkNamespace: 'net:[4026531840]', stable: true,
    published: { pid, parentPid: 2000, startTicks: '734291', uids: [1000, 1000, 1000, 1000], networkNamespace: 'net:[4026531840]',
      executable: { realPath: '/usr/bin/github', elf: true, file: path('/usr/bin/github', 'file', '1001'),
        parents: [path('/usr/bin', 'directory', '1002'), path('/usr', 'directory', '1003'), path('/', 'directory', '1004')] } },
    listeners: [{ pid, port, address: '127.0.0.1', uid: 1000, inode: '92973' }], socketInodes: ['92973'] };
}
describe('Linux Copilot system installation and socket evidence', () => {
  it('accepts root-managed executable and current-user process owning the actual loopback listener', async () => {
    const inspect = vi.fn(async () => evidence());
    expect(await verifyCopilotDesktopProcess(pid, port, { platform: 'linux', inspect })).toBe(true);
    expect(inspect).toHaveBeenCalledWith(pid, port);
    expect(isVerifiedLinuxCopilotProcess({ ...evidence(), trustSource: 'GitHub signature' }, pid, port)).toBe(false);
    expect(isVerifiedLinuxCopilotProcess({ ...evidence(), platform: 'win32' }, pid, port)).toBe(false);
  });
  it('rejects name-only spoofing, home/AppImage paths and user-writable installation files or ancestors', () => {
    for (const executable of ['/home/coco/github', '/tmp/.mount_copilot/github', '/usr/bin/copilot', '/usr/bin/node']) {
      const proof = evidence(); proof.published.executable.realPath = executable; proof.published.executable.file.path = executable;
      expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(false);
    }
    for (const index of [-1, 0, 1, 2]) {
      for (const change of [{ uid: 1000 }, { mode: 0o775 }, { mode: 0o757 }, { kind: 'file' as const }, { inode: '' }]) {
        const proof = evidence();
        const target = index === -1 ? proof.published.executable.file : proof.published.executable.parents[index];
        if (index === -1 && change.kind === 'file') continue;
        Object.assign(target, change); expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(false);
      }
    }
    const noParents = evidence(); noParents.published.executable.parents.pop(); expect(isVerifiedLinuxCopilotProcess(noParents, pid, port)).toBe(false);
    const reordered = evidence(); reordered.published.executable.parents.reverse(); expect(isVerifiedLinuxCopilotProcess(reordered, pid, port)).toBe(false);
    const shellScript = evidence(); shellScript.published.executable.elf = false; expect(isVerifiedLinuxCopilotProcess(shellScript, pid, port)).toBe(false);
    const notExecutable = evidence(); notExecutable.published.executable.file.mode = 0o644; expect(isVerifiedLinuxCopilotProcess(notExecutable, pid, port)).toBe(false);
    expect(isTrustedLinuxCopilotExecutable({})).toBe(false);
  });
  it('rejects different UID, network namespace, PID reuse and an unowned socket inode', () => {
    const mutate: ((proof: LinuxCopilotProcessEvidence) => void)[] = [
      proof => { proof.published.uids[1] = 0; }, proof => { proof.published.pid++; }, proof => { proof.published.startTicks = ''; },
      proof => { proof.published.networkNamespace = 'net:[4026531999]'; }, proof => { proof.networkNamespace = ''; },
      proof => { proof.stable = false; }, proof => { proof.socketInodes = ['92974']; }, proof => { proof.listeners[0].inode = '92974'; },
      proof => { proof.listeners[0].uid = 1001; }, proof => { proof.listeners[0].pid++; }, proof => { proof.listeners[0].port++; },
      proof => { proof.listeners = []; }, proof => { proof.listeners[0].address = '::1'; },
      proof => { proof.listeners.push({ pid, port, address: '0.0.0.0', uid: 1000, inode: '92973' }); },
      proof => { proof.listeners[0].address = '192.0.2.1'; },
    ];
    for (const change of mutate) { const proof = evidence(); change(proof); expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(false); }
    for (const value of [null, {}, [], { ...evidence(), published: {} }, { ...evidence(), listeners: [null] }]) expect(isVerifiedLinuxCopilotProcess(value, pid, port)).toBe(false);
  });
  it('parses kernel identity even when process comm contains parentheses and spaces', () => {
    const fields = ['S', '2000', ...Array(17).fill('0'), '734291', '0'];
    const processStat = `${pid} (github (app) worker) ${fields.join(' ')}`;
    expect(parseLinuxProcessIdentity(processStat, 'Name:\tgithub\nUid:\t1000\t1000\t1000\t1000\n', pid)).toEqual({ pid, parentPid: 2000, startTicks: '734291', uids: [1000, 1000, 1000, 1000] });
    expect(() => parseLinuxProcessIdentity(processStat, 'Uid:\t1000\t1000\n', pid)).toThrow();
    expect(() => parseLinuxProcessIdentity(processStat, 'Uid:\t1000\t1000\t1000\t1000\n', pid + 1)).toThrow();
    expect(() => parseLinuxProcessIdentity(`${pid} github 0`, 'Uid: 1000 1000 1000 1000', pid)).toThrow();
  });
  it('reads TCP LISTEN UID and inode and rejects IPv6 wildcard alongside IPv4 loopback', () => {
    const header = ' sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    const row = (address: string, state = '0A', localPort = '85D9', inode = '92973') => ` 0: ${address}:${localPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 0000000000000000`;
    expect(parseLinuxTcpListeners(`${header}\n${row('0100007F')}\n${row('00000000', '01')}\n${row('0100007F', '0A', '0001')}`, port))
      .toEqual([{ port, address: '127.0.0.1', uid: 1000, inode: '92973' }]);
    expect(parseLinuxTcpListeners(`${header}\n${row('00000000')}`, port)[0].address).toBe('non-loopback');
    expect(parseLinuxTcpListeners(`${header}\n${row('00000000000000000000000001000000')}`, port, true)[0].address).toBe('::1');
    expect(parseLinuxTcpListeners(`${header}\n${row('00000000000000000000000000000000')}`, port, true)[0].address).toBe('non-loopback');
    expect(() => parseLinuxTcpListeners(`${header}\n${row('0100007F', '0A', '85D9', '0')}`, port)).toThrow();
  });
  it.skipIf(process.platform !== 'linux')('refuses a real loopback server whose executable is unrelated to Copilot', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('no-address');
      expect(await collectLinuxCopilotProcessEvidence(process.pid, address.port)).toEqual({ failedStage: 'untrusted-installation' });
      expect(await verifyCopilotDesktopProcess(process.pid, address.port)).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
