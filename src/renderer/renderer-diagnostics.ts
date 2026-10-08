import type { ModelDockApi } from '../shared/types';

const errorNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError']);
type ReportBridge = Pick<ModelDockApi, 'reportRendererError'>;

/** 修改点：在界面主世界捕获异常，只传固定类型；预加载隔离世界不一定收到这些事件。 */
export function installRendererDiagnostics(target: EventTarget, bridge?: ReportBridge): () => void {
  const report = (kind: 'error' | 'unhandled-rejection', error: unknown) => {
    let errorName = 'Error';
    try { const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined; if (typeof name === 'string' && errorNames.has(name)) errorName = name; } catch { /* Never inspect an arbitrary error getter further. */ }
    try { void bridge?.reportRendererError({ kind, errorName }).catch(() => {}); } catch { /* Diagnostics cannot interrupt UI behavior. */ }
  };
  const onError = (event: Event) => { if (event.target === target) report('error', (event as ErrorEvent).error); };
  const onRejection = (event: Event) => report('unhandled-rejection', (event as PromiseRejectionEvent).reason);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => { target.removeEventListener('error', onError); target.removeEventListener('unhandledrejection', onRejection); };
}
