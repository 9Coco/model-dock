import { describe, expect, it, vi } from 'vitest';
import { finishLocalShutdown } from '../src/main/shutdown-cleanup';

describe('local cleanup after confirmed OS cleanup', () => {
  it.each(['accounts', 'oauth', 'store', 'tray'])('continues and finishes once when %s disposal throws', async broken => {
    const calls: string[] = [];
    const complete = vi.fn(() => { calls.push('complete'); });
    const failed = vi.fn(() => { throw new Error('Diagnostic storage unavailable'); });
    await finishLocalShutdown(['accounts', 'oauth', 'store', 'tray'].map(name => ({ name, dispose: () => {
      calls.push(name);
      if (name === broken) throw new Error('Synthetic disposal failure');
    } })), complete, failed);
    expect(calls).toEqual(['accounts', 'oauth', 'store', 'tray', 'complete']);
    expect(complete).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(broken);
  });

  it('waits for async disposal, handles rejection, and closes later resources', async () => {
    let reject!: (error: Error) => void;
    const later = vi.fn(), complete = vi.fn();
    const pending = finishLocalShutdown([
      { name: 'ide', dispose: () => new Promise((_resolve, failure) => { reject = failure; }) },
      { name: 'store', dispose: later },
    ], complete);
    expect(later).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    reject(new Error('Synthetic async cleanup failure'));
    await pending;
    expect(later).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
  });
});
