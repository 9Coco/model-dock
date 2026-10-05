/** Use the desktop's configured networking without inheriting browser cookies.
 * Native Electron fetch has unreliable Response.url/type metadata. Requests in
 * this app do not follow redirects, so expose a fresh standard response while
 * preserving status, headers and the streaming body. Upstream URL validation
 * remains the responsibility of each protocol adapter before sending secrets.
 */
export function createSystemNetworkFetch(nativeFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const policy = init?.redirect ?? (typeof Request !== 'undefined' && input instanceof Request ? input.redirect : 'error');
    const manual = policy === 'manual';
    const native = await nativeFetch(input, { ...init, credentials: 'omit', redirect: 'manual' });
    if (!manual && native.status >= 300 && native.status < 400) {
      await native.body?.cancel();
      throw new TypeError('网络请求返回重定向，已停止请求。');
    }
    return new Response(native.body, { status: native.status, statusText: native.statusText, headers: native.headers });
  };
}
