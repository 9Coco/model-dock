import { request, type RequestOptions, type ClientRequest, type IncomingMessage } from 'node:http';
import { TraeClientImportError, type TraeClientCredentials } from './trae-client-import';

export interface TraeRelayImportResult {
  imported: true;
  accountId: string;
  upstreamVerified: false;
  message: string;
}
export type TraeImportRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
const failure = (message = '无法向本机托管反代导入 TRAE 账号，请检查反代状态后重试。') => new TraeClientImportError('relay', message);

/** Pinned v1.0.10 /api/web-auth only persists account credentials; its success
 * must not be presented as a successful upstream login, quota or inference.
 * This direct TCP transport cannot inherit fetch/Electron/system proxy or
 * redirect behavior. Ownership is checked by TraeRelayManager before use.
 */
export async function postTraeRelayAccount(apiKey: string, credentials: TraeClientCredentials, send: TraeImportRequest = request): Promise<TraeRelayImportResult> {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(apiKey) || !credentials || typeof credentials !== 'object' ||
      typeof credentials.token !== 'string' || !credentials.token || credentials.token.length > 32768 || /\s/.test(credentials.token) ||
      typeof credentials.userId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(credentials.userId) || credentials.host !== 'https://api.trae.cn') throw failure('TRAE 本机导入参数无效，未发送授权。');
  // Reconstruct a known native request shape. Never serialize arbitrary extra
  // object properties from another component into the credential transport.
  const payload: Record<string, string> = { token: credentials.token, userId: credentials.userId, host: credentials.host };
  for (const field of ['refreshToken', 'expiredAt', 'refreshExpiredAt', 'clientId', 'webId', 'bizUserId', 'userUniqueId', 'scope', 'tenant', 'region', 'aiRegion', 'appLanguage', 'userRegion', 'userIdentity', 'screenName', 'label'] as const) {
    const value = credentials[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > (field === 'refreshToken' ? 32768 : 256) || /[\x00-\x1f\x7f]/.test(value)) throw failure('TRAE 本机导入参数无效，未发送授权。');
    payload[field] = value;
  }
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > 128 * 1024) throw failure('TRAE 本机授权数据超出支持范围，未发送授权。');
  return new Promise<TraeRelayImportResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: TraeClientImportError, result?: TraeRelayImportResult) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => { req.destroy(); finish(failure('本机反代账号导入超时，请检查反代账号页后再重试。')); }, 15_000);
    let req: ClientRequest;
    try {
      req = send({ hostname: '127.0.0.1', port: 18080, path: '/api/web-auth', method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/json' } }, response => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          finish(failure(status >= 300 && status < 400 ? '本机反代返回了重定向，未向其他地址转发授权。' : `本机反代未接受账号导入（HTTP ${status || '未知'}）。`));
          req.destroy(); return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > 65536) { finish(failure('本机反代导入响应过大，无法确认导入结果。')); req.destroy(); return; }
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
          if (size > 65536) { finish(failure('本机反代导入响应过大，无法确认导入结果。')); req.destroy(); return; }
          chunks.push(bytes);
        });
        response.once('error', () => finish(failure()));
        response.once('aborted', () => finish(failure('本机反代导入响应中断，无法确认导入结果。')));
        response.once('end', () => {
          if (settled) return;
          try {
            const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.success !== true || parsed.has_token !== true || parsed.user_id !== credentials.userId) throw new Error();
            finish(undefined, { imported: true, accountId: credentials.userId, upstreamVerified: false,
              message: 'TRAE 本机账号已导入托管反代；上游授权和剩余额度尚未验证，请获取模型并测试连接。' });
          } catch { finish(failure('本机反代未返回匹配的账号确认，无法确认导入结果；请检查反代账号页。')); }
        });
      });
      req.once('error', () => finish(failure()));
      req.end(body);
    } catch { finish(failure()); }
  });
}
