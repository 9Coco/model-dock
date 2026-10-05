import { describe, expect, it, vi } from 'vitest';
import { isVerifiedCopilotProcess, verifyCopilotDesktopProcess, type CopilotProcessEvidence } from '../src/main/copilot-process';

const pid = 3100, port = 63000;
function evidence(): CopilotProcessEvidence {
  const app = { pid, parentPid: 100, startedAt: '2026-10-07T02:00:00Z', filename: 'github.exe', directoryHash: 'a'.repeat(64), productName: 'GitHub Copilot', companyName: 'GitHub Inc.', signatureStatus: 'Valid', signerName: 'GitHub, Inc.' };
  return { published: { ...app }, listener: { ...app }, ancestry: [{ ...app }], listeners: [{ pid, port, address: '127.0.0.1' }], stable: true };
}
describe('Copilot native process and listener identity', () => {
  it('accepts the signed official desktop process bound to the exact loopback port', async () => {
    const inspect = vi.fn(async (value, targetPort) => { expect([value, targetPort]).toEqual([pid, port]); return evidence(); });
    expect(await verifyCopilotDesktopProcess(pid, port, { platform: 'win32', inspect })).toBe(true); expect(inspect).toHaveBeenCalledOnce();
  });
  it('rejects spoofed product names, unsigned binaries, foreign publishers and other GitHub products', () => {
    for (const change of [
      { filename: 'node.exe' }, { filename: 'copilot.exe' }, { productName: 'GitHub Desktop' }, { productName: 'GitHub Copilot', signatureStatus: 'NotSigned' },
      { signatureStatus: 'HashMismatch' }, { signerName: 'Not GitHub, Inc.' }, { companyName: 'Other Inc.' }, { directoryHash: '' },
    ]) { const proof = evidence(); Object.assign(proof.published, change); expect(isVerifiedCopilotProcess(proof, pid, port)).toBe(false); }
  });
  it('rejects wrong listener ownership, wildcard/public bindings and stale or unstable evidence', () => {
    for (const change of [
      { listeners: [{ pid: pid + 1, port, address: '127.0.0.1' }] }, { listeners: [{ pid, port: port + 1, address: '127.0.0.1' }] },
      { listeners: [{ pid, port, address: '0.0.0.0' }] }, { listeners: [{ pid, port, address: '192.0.2.1' }] }, { listeners: [{ pid, port, address: '::1' }] },
      { listeners: [] }, { stable: false }, { published: undefined },
    ]) expect(isVerifiedCopilotProcess({ ...evidence(), ...change }, pid, port)).toBe(false);
    const reused = evidence(); reused.listener.startedAt = '2026-10-07T03:00:00Z'; expect(isVerifiedCopilotProcess(reused, pid, port)).toBe(false);
  });
  it('accepts a signed same-installation listener child only when its process ancestry is proved', () => {
    const proof = evidence(); proof.listener = { ...proof.listener, pid: pid + 1, parentPid: pid, startedAt: '2026-10-07T02:01:00Z' };
    proof.ancestry = [{ ...proof.listener }, { ...proof.published }]; proof.listeners[0].pid = pid + 1;
    expect(isVerifiedCopilotProcess(proof, pid, port)).toBe(true);
    const differentInstall = structuredClone(proof); differentInstall.listener.directoryHash = 'b'.repeat(64); expect(isVerifiedCopilotProcess(differentInstall, pid, port)).toBe(false);
    const unrelated = structuredClone(proof); unrelated.ancestry[0].parentPid = 999; expect(isVerifiedCopilotProcess(unrelated, pid, port)).toBe(false);
    const reusedParent = structuredClone(proof); reusedParent.published.startedAt = '2026-10-07T03:00:00Z'; reusedParent.ancestry[1].startedAt = reusedParent.published.startedAt; expect(isVerifiedCopilotProcess(reusedParent, pid, port)).toBe(false);
  });
  it('fails closed on permissions, unsupported platforms, malformed inspections and nonnumeric targets', async () => {
    const failed = vi.fn(async () => { throw new Error('PRIVATE_OS_ERROR'); });
    expect(await verifyCopilotDesktopProcess(pid, port, { platform: 'win32', inspect: failed })).toBe(false);
    for (const platform of ['linux', 'darwin'] as const) await expect(verifyCopilotDesktopProcess(pid, port, { platform, inspect: failed })).rejects.toMatchObject({ category: 'unsupported-platform' });
    for (const value of [null, {}, [], { ...evidence(), listeners: [null] }, { ...evidence(), ancestry: [null, {}], listener: { ...evidence().listener, pid: pid + 1 } }]) expect(await verifyCopilotDesktopProcess(pid, port, { platform: 'win32', inspect: async () => value })).toBe(false);
    const unused = vi.fn(); expect(await verifyCopilotDesktopProcess(NaN, port, { inspect: unused })).toBe(false); expect(await verifyCopilotDesktopProcess(pid, 65536, { inspect: unused })).toBe(false); expect(unused).not.toHaveBeenCalled();
  });
});
