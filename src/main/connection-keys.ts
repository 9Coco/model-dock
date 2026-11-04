import type { Store } from './store';

/** Explicit UI reveal/copy only. Never return subscription authorization material. */
export function providerApiKey(store: Pick<Store, 'getProvider' | 'getSecret'>, id: unknown): string {
  if (typeof id !== 'string' || !id || id.length > 200 || /[\r\n\0]/.test(id)) throw new Error('供应商标识无效。');
  const provider = store.getProvider(id);
  if (!provider) throw new Error('供应商不存在。');
  if (provider.kind !== 'openai-compatible') throw new Error('订阅来源使用账号授权；请复制本地聚合接口的 API Key。');
  let key: string | undefined;
  try { key = store.getSecret(id)?.apiKey; }
  catch { throw new Error('无法读取已保存的 API Key。'); }
  if (!key) throw new Error('此供应商尚未保存 API Key。');
  return key;
}

export function localGatewayKey(store: Pick<Store, 'gatewayKey'>): string {
  try { return store.gatewayKey(); }
  catch { throw new Error('无法读取本地聚合接口的 API Key。'); }
}
