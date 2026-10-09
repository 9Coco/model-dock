import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const execute = vi.mocked(execFileSync);
beforeEach(() => { vi.resetModules(); execute.mockReset(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('Windows JetBrains OS evidence boundary', () => {
  it('shares one complete OS snapshot for display status and bypasses the cache for write checks', async () => {
    execute.mockReturnValue('{"complete":true,"processes":[]}');
    const { collectWindowsJetBrainsProcesses } = await import('../src/main/jetbrains-windows');
    expect(collectWindowsJetBrainsProcesses().complete).toBe(true); expect(collectWindowsJetBrainsProcesses().complete).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    collectWindowsJetBrainsProcesses(true); expect(execute).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1501); collectWindowsJetBrainsProcesses(); expect(execute).toHaveBeenCalledTimes(3);
    const options = execute.mock.calls[0][2]; expect(options).toMatchObject({ windowsHide: true, timeout: 4500, stdio: ['ignore', 'pipe', 'ignore'] });
  });
  it.each(['denied', 'partial', 'invalid-json', 'invalid-identity'] as const)('never turns %s OS evidence into a stopped IDE', async scenario => {
    if (scenario === 'denied') execute.mockImplementation(() => { throw new Error('AccessDenied'); });
    if (scenario === 'partial') execute.mockReturnValue('{"complete":false,"processes":[]}');
    if (scenario === 'invalid-json') execute.mockReturnValue('truncated output');
    if (scenario === 'invalid-identity') execute.mockReturnValue('{"complete":true,"processes":[{"pid":12345,"name":"rider64.exe"}]}');
    const { collectWindowsJetBrainsProcesses } = await import('../src/main/jetbrains-windows');
    expect(collectWindowsJetBrainsProcesses()).toEqual({ complete: false, processes: [] });
    execute.mockReturnValue('{"complete":true,"processes":[]}'); expect(collectWindowsJetBrainsProcesses(true)).toEqual({ complete: true, processes: [] });
  });
});
