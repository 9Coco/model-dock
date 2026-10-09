import { describe, expect, it, vi } from 'vitest';
import { JetBrainsAutoSync, type JetBrainsAutoSyncState } from '../src/renderer/jetbrains-auto-sync';
import type { JetBrainsStatus } from '../src/shared/jetbrains';

const status = (running: JetBrainsStatus['running'] = 'stopped'): JetBrainsStatus => ({ tool: 'rider', configDir: '/synthetic/Rider2026.2', version: '2026.2', foundProfile: true, running, canApply: running === 'stopped', message: 'Synthetic status' });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let current = status(), eligible = true, available = true;
  const applied: string[] = [], states: (JetBrainsAutoSyncState | undefined)[] = [];
  const options = { status: vi.fn(async () => current), eligible: () => eligible, available: () => available,
    apply: vi.fn(async (_tool: string, signature: string) => { applied.push(signature); }), state: (_tool: string, state?: JetBrainsAutoSyncState) => { states.push(state); } };
  const coordinator = new JetBrainsAutoSync(options);
  return { coordinator, options, applied, states, running: (running: JetBrainsStatus['running']) => { current = status(running); }, valid: (value: boolean) => { eligible = value; }, available: (value: boolean) => { available = value; } };
}

describe('interaction-triggered JetBrains settings sync', () => {
  it('never creates writes when constructed or checked without a user request', async () => {
    const f = fixture(); await f.coordinator.attempt('rider');
    expect(f.options.status).not.toHaveBeenCalled(); expect(f.options.apply).not.toHaveBeenCalled(); expect(f.coordinator.pending()).toEqual([]);
  });
  it.each(['running', 'unknown'] as const)('retains only the latest choice while IDE is %s and applies it after confirmed exit', async running => {
    const f = fixture(); f.running(running); f.coordinator.request('rider', 'aggregate-A'); await f.coordinator.attempt('rider');
    f.coordinator.request('rider', 'direct-B'); await f.coordinator.attempt('rider');
    expect(f.applied).toEqual([]); expect(f.states.at(-1)?.phase).toBe('waiting');
    f.running('stopped'); await f.coordinator.attempt('rider');
    expect(f.applied).toEqual(['direct-B']); expect(f.coordinator.pending()).toEqual([]);
  });
  it('does not apply a stale selection when the user changes it during status inspection', async () => {
    const f = fixture(), check = deferred<JetBrainsStatus>();
    f.options.status.mockImplementationOnce(() => check.promise);
    f.coordinator.request('rider', 'aggregate-A'); const pending = f.coordinator.attempt('rider');
    f.coordinator.request('rider', 'direct-B'); await f.coordinator.attempt('rider'); check.resolve(status()); await pending;
    expect(f.applied).toEqual(['direct-B']); expect(f.options.status).toHaveBeenCalledTimes(2);
  });
  it('waits for existing save/apply/restore locks and serializes repeated poll attempts', async () => {
    const f = fixture(); f.available(false); f.coordinator.request('rider', 'latest'); await f.coordinator.attempt('rider');
    expect(f.options.status).not.toHaveBeenCalled(); f.available(true);
    const write = deferred<void>(); f.options.apply.mockImplementationOnce(async () => { await write.promise; f.applied.push('latest'); });
    const first = f.coordinator.attempt('rider'); await Promise.resolve(); await Promise.resolve();
    await f.coordinator.attempt('rider'); write.resolve(); await first;
    expect(f.options.apply).toHaveBeenCalledTimes(1); expect(f.applied).toEqual(['latest']);
  });
  it('cancels an invalid or empty latest binding without modifying the IDE', async () => {
    const f = fixture(); f.running('running'); f.coordinator.request('rider', 'selected'); await f.coordinator.attempt('rider');
    f.valid(false); f.running('stopped'); await f.coordinator.attempt('rider');
    expect(f.applied).toEqual([]); expect(f.coordinator.pending()).toEqual([]);
  });
  it('does not retry a stopped-IDE file failure until a new user action', async () => {
    const f = fixture(); f.options.apply.mockRejectedValueOnce(new Error('Synthetic write conflict'));
    f.coordinator.request('rider', 'selected'); await f.coordinator.attempt('rider'); await f.coordinator.attempt('rider');
    expect(f.options.apply).toHaveBeenCalledTimes(1); expect(f.states.at(-1)).toMatchObject({ phase: 'error', message: expect.stringContaining('Synthetic write conflict') });
    f.coordinator.request('rider', 'revised'); await f.coordinator.attempt('rider'); expect(f.applied).toEqual(['revised']);
  });
  it('keeps pending work when the main process refuses because the IDE restarted before writing', async () => {
    const f = fixture(); f.options.apply.mockImplementationOnce(async () => { f.running('running'); throw new Error('IDE restarted'); });
    f.coordinator.request('rider', 'selected'); await f.coordinator.attempt('rider');
    expect(f.states.at(-1)?.phase).toBe('waiting'); expect(f.coordinator.pending()).toEqual(['rider']);
    f.running('stopped'); await f.coordinator.attempt('rider'); expect(f.applied).toEqual(['selected']);
  });
  it('cancels pending checks for manual sync/restore or unmount and never writes after disposal', async () => {
    const f = fixture(), check = deferred<JetBrainsStatus>(); f.options.status.mockImplementationOnce(() => check.promise);
    f.coordinator.request('rider', 'selected'); const pending = f.coordinator.attempt('rider');
    f.coordinator.cancel('rider'); check.resolve(status()); await pending; expect(f.applied).toEqual([]);
    const other = deferred<JetBrainsStatus>(); f.options.status.mockImplementationOnce(() => other.promise);
    f.coordinator.request('rider', 'next'); const second = f.coordinator.attempt('rider'); f.coordinator.dispose(); other.resolve(status()); await second;
    expect(f.applied).toEqual([]); expect(f.coordinator.pending()).toEqual([]);
  });
});
