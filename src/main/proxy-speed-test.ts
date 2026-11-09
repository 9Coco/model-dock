import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import type { ProxySpeedMetric } from '../shared/flowbridge-types';

const downloadBytes = 4 * 1024 * 1024;
const uploadBytes = 1024 * 1024;
const origin = 'https://speed.cloudflare.com';

/** Measure completed transfers through a session reserved for the selected upstream. */
export async function measureProxySpeed(metric: ProxySpeedMetric, fetcher: (url: string, init: RequestInit) => Promise<Response>, now = () => performance.now()): Promise<number> {
  const signal = AbortSignal.timeout(metric === 'latency' ? 10_000 : 15_000);
  const request = async (size: number, upload = false) => {
    const payload = upload ? new Uint8Array(randomBytes(size)) : undefined;
    const start = now();
    const reply = await fetcher(origin + (upload ? '/__up' : '/__down?bytes=' + size), {
      method: upload ? 'POST' : 'GET', body: payload, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
      ...(upload ? { headers: { 'Content-Type': 'application/octet-stream' } } : {}),
    });
    if (reply.status !== 200) {
      await reply.body?.cancel();
      throw new Error('测速节点返回 HTTP ' + reply.status + '。');
    }
    let count = 0;
    const reader = reply.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          count += value.byteLength;
          if (count > (upload ? 8192 : size)) {
            await reader.cancel();
            throw new Error('测速响应大小与请求不符。');
          }
        }
      } finally { reader.releaseLock(); }
    }
    if (!upload && count !== size) throw new Error('测速下载未完成。');
    return Math.max(0.01, now() - start);
  };
  if (metric === 'latency') {
    const samples = [];
    for (let i = 0; i < 3; i++) samples.push(await request(0));
    return samples.sort((a, b) => a - b)[1];
  }
  const size = metric === 'download' ? downloadBytes : uploadBytes;
  return size * 8 / (await request(size, metric === 'upload') * 1000);
}
