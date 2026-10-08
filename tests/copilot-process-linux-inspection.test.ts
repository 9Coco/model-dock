import * as filesystem from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectLinuxCopilotProcessEvidence, isVerifiedLinuxCopilotProcess } from '../src/main/copilot-process-linux';

// Kernel/file fixtures exercise the collector's before/after checks rather than
// merely setting a precomputed `stable` boolean in the pure verifier.
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), readlink: vi.fn(), readdir: vi.fn(), realpath: vi.fn(), stat: vi.fn(), open: vi.fn() }));
const pid = 3187, port = 34265, currentUid = process.getuid?.() ?? 1000;
let statReads = 0, executableReads = 0, tcpReads = 0;
let reusePid = false, replaceExecutable = false, replaceListener = false;
const processStat = (ticks: string) => `${pid} (github) ${['S', '2000', ...Array(17).fill('0'), ticks, '0'].join(' ')}`;
const tcp = (inode: string) => ` sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n 0: 0100007F:85D9 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${currentUid} 0 ${inode} 1`;
beforeEach(() => {
  vi.resetAllMocks(); statReads = 0; executableReads = 0; tcpReads = 0;
  reusePid = false; replaceExecutable = false; replaceListener = false;
  vi.mocked(filesystem.readFile).mockImplementation(async (value: unknown) => {
    const path = String(value);
    if (path.endsWith('/stat')) return processStat(++statReads === 1 || !reusePid ? '2270' : '9999');
    if (path.endsWith('/status')) return `Name:\tgithub\nUid:\t${currentUid}\t${currentUid}\t${currentUid}\t${currentUid}\n`;
    if (path.endsWith('/tcp')) return tcp(++tcpReads === 1 || !replaceListener ? '29459' : '29500');
    if (path.endsWith('/tcp6')) return ' sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
    throw new Error('unexpected-read');
  });
  vi.mocked(filesystem.readlink).mockImplementation(async (value: unknown) => {
    const path = String(value);
    if (path.endsWith('/exe')) return '/usr/bin/github';
    if (path.endsWith('/ns/net')) return 'net:[4026531840]';
    if (path.endsWith('/fd/7')) return 'socket:[29459]';
    throw new Error('unexpected-link');
  });
  vi.mocked(filesystem.readdir).mockResolvedValue(['7'] as never);
  vi.mocked(filesystem.realpath).mockImplementation(async (path: unknown) => String(path));
  vi.mocked(filesystem.stat).mockImplementation(async (value: unknown) => {
    const path = String(value), file = path === '/usr/bin/github' || path.endsWith('/exe');
    if (path === '/usr/bin/github') executableReads++;
    return { uid: 0n, mode: 0o755n, dev: 2049n, ino: file ? replaceExecutable && executableReads >= 2 ? 1002n : 1001n : 1003n,
      size: 100n, mtimeNs: 10n, ctimeNs: 10n, isFile: () => file, isDirectory: () => !file } as never;
  });
  vi.mocked(filesystem.open).mockResolvedValue({ read: async (buffer: Buffer) => { buffer.set([0x7f, 0x45, 0x4c, 0x46]); return { bytesRead: 4 }; }, close: vi.fn() } as never);
});
describe('Linux Copilot read-only evidence collection', () => {
  it('collects a stable executable, kernel UID, and socket owned by the published PID', async () => {
    const proof = await collectLinuxCopilotProcessEvidence(pid, port);
    expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(true);
    expect(filesystem.readFile).not.toHaveBeenCalledWith(expect.stringContaining('/environ'), expect.anything());
    expect(filesystem.readFile).not.toHaveBeenCalledWith(expect.stringContaining('/cmdline'), expect.anything());
  });
  it('rejects PID reuse even when the reused PID has the same executable path and UID', async () => {
    reusePid = true;
    const proof = await collectLinuxCopilotProcessEvidence(pid, port);
    expect(proof).toMatchObject({ stable: false });
    expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(false);
  });
  it('rejects an executable replaced at the same path between inspections', async () => {
    replaceExecutable = true;
    const proof = await collectLinuxCopilotProcessEvidence(pid, port);
    expect(proof).toMatchObject({ stable: false });
    expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(false);
  });
  it('rejects a listener rebound to a different socket inode between inspections', async () => {
    replaceListener = true;
    const proof = await collectLinuxCopilotProcessEvidence(pid, port);
    expect(proof).toMatchObject({ stable: false });
    expect(isVerifiedLinuxCopilotProcess(proof, pid, port)).toBe(false);
  });
  it('fails closed when process fd permissions cannot be inspected', async () => {
    vi.mocked(filesystem.readdir).mockRejectedValue(Object.assign(new Error('private OS detail'), { code: 'EACCES' }));
    expect(await collectLinuxCopilotProcessEvidence(pid, port)).toEqual({ failedStage: 'listeners' });
  });
});
