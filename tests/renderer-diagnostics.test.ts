import { describe, expect, it, vi } from 'vitest';
import { installRendererDiagnostics } from '../src/renderer/renderer-diagnostics';

const secret = 'PRIVATE_RENDERER_ERROR_BODY_TOKEN';
function event(type: string, key: 'error' | 'reason', value: unknown) { const e = new Event(type); Object.defineProperty(e, key, { value }); return e; }
describe('renderer diagnostic bridge only reports controlled exception classifications', () => {
  it('reports main-world errors and rejections without their contents and supports cleanup', () => {
    const target = new EventTarget(), reportRendererError = vi.fn(async (_report: { kind: 'error' | 'unhandled-rejection'; errorName?: string }) => {});
    const cleanup = installRendererDiagnostics(target, { reportRendererError });
    target.dispatchEvent(event('error', 'error', new TypeError(secret)));
    target.dispatchEvent(event('unhandledrejection', 'reason', new Error(secret)));
    expect(reportRendererError.mock.calls).toEqual([[{ kind: 'error', errorName: 'TypeError' }], [{ kind: 'unhandled-rejection', errorName: 'Error' }]]);
    expect(JSON.stringify(reportRendererError.mock.calls)).not.toContain(secret);
    cleanup(); target.dispatchEvent(event('error', 'error', new Error(secret))); expect(reportRendererError).toHaveBeenCalledTimes(2);
  });
  it('drops arbitrary names, stack frames, object bodies and dangerous getters', () => {
    const target = new EventTarget(), reportRendererError = vi.fn(async (_report: { kind: 'error' | 'unhandled-rejection'; errorName?: string }) => {});
    installRendererDiagnostics(target, { reportRendererError });
    target.dispatchEvent(event('error', 'error', { name: secret, stack: secret, token: secret }));
    target.dispatchEvent(event('unhandledrejection', 'reason', { get name() { throw new Error(secret); } }));
    expect(reportRendererError.mock.calls.every(([report]) => report.errorName === 'Error')).toBe(true);
    expect(JSON.stringify(reportRendererError.mock.calls)).not.toContain(secret);
  });
  it('does not change rejection handling or throw when the bridge is absent or fails', async () => {
    for (const bridge of [undefined, { reportRendererError: vi.fn(() => { throw new Error(secret); }) }, { reportRendererError: vi.fn(async () => { throw new Error(secret); }) }]) {
      const target = new EventTarget(); installRendererDiagnostics(target, bridge);
      const e = event('unhandledrejection', 'reason', new Error(secret));
      expect(() => target.dispatchEvent(e)).not.toThrow(); expect(e.defaultPrevented).toBe(false);
    }
    await Promise.resolve();
  });
});
