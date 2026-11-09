import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelDockApi } from '../shared/types';

type RuntimeSnapshot = Awaited<ReturnType<ModelDockApi['runtimeSnapshot']>>;

export function useRuntimeSnapshot(api: ModelDockApi | undefined, active: boolean) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (!active || !api?.runtimeSnapshot) return;
    const request = ++revision.current;
    pending.current = true;
    try {
      const result = await api.runtimeSnapshot();
      if (request === revision.current) { setSnapshot(result); setError(''); }
    } catch {
      if (request === revision.current) setError('无法读取服务状态，请检查桌面连接。');
    } finally {
      if (request === revision.current) pending.current = false;
    }
  }, [api, active]);
  useEffect(() => {
    if (!active || !api?.runtimeSnapshot) return;
    void refresh();
    const timer = window.setInterval(() => { if (!pending.current) void refresh(); }, 1000);
    return () => { window.clearInterval(timer); ++revision.current; pending.current = false; };
  }, [api, active, refresh]);
  return { snapshot, error, refresh };
}
