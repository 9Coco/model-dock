import { useEffect, useState } from 'react';
import type { NetworkDiscoveryInput, NetworkDiscoveryResult } from '../shared/flowbridge-types';
import type { ModelDockApi } from '../shared/types';

type Probe = NetworkDiscoveryResult & { key: string; state: 'searching' | 'found' | 'empty' | 'error' };
const empty = { address: null, alternatives: [] };

export function useNetworkDiscovery(api: ModelDockApi, active: boolean, { source, mode, port }: NetworkDiscoveryInput) {
  const key = JSON.stringify([source, mode, port]);
  const [result, setResult] = useState<Probe>();
  useEffect(() => {
    setResult(undefined);
    if (!active) return;
    let disposed = false;
    let inFlight = false;
    let generation = 0;
    let rescanAfter = false;
    let timer: number | undefined;
    function schedule(delay: number) {
      window.clearTimeout(timer);
      if (!disposed && !document.hidden) timer = window.setTimeout(scan, delay);
    }
    async function scan() {
      if (disposed || document.hidden) return;
      if (inFlight) { rescanAfter = true; return; }
      inFlight = true;
      const attempt = generation;
      // Keep a usable address in the field while refreshing it on focus.
      setResult(previous => previous?.key === key && previous.address ? previous : { ...empty, key, state: 'searching' });
      let next: Probe;
      try {
        const found = await api.discoverNetworkUpstream({ source, mode, port });
        next = { ...found, key, state: found.address ? 'found' : 'empty' };
      } catch {
        next = { ...empty, key, state: 'error' };
      }
      inFlight = false;
      if (disposed || document.hidden) return;
      if (generation === attempt) setResult(next);
      if (rescanAfter || generation !== attempt) {
        rescanAfter = false;
        schedule(150);
      } else if (!next.address && !next.alternatives.length) schedule(15_000);
    }
    const wake = () => schedule(150);
    const visibilityChanged = () => {
      if (document.hidden) { ++generation; window.clearTimeout(timer); }
      else wake();
    };
    schedule(0);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [api, active, source, mode, port, key]);
  return active && result?.key === key ? result : undefined;
}
