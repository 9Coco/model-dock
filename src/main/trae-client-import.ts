import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const AUTH_SLOT = 'iCubeAuthInfo://icube.cloudide';
const MAX_FILE = 4 * 1024 * 1024;
const MAX_AUTH = 128 * 1024;
const CN_HOST = 'https://api.trae.cn';
const SALTS = [
  [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37],
  [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125],
  [191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209],
  [246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170],
];
const hash = (value: Uint8Array) => createHash('sha512').update(value).digest();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function scalar(value: unknown, max = 160): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
}
const identifier = (value: unknown) => { const text = scalar(value); return text && /^[a-zA-Z0-9_.:-]+$/.test(text) ? text : undefined; };
const secret = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;

export class TraeClientImportError extends Error {
  constructor(readonly code: 'missing' | 'expired' | 'format' | 'unsafe-file' | 'unsupported' | 'relay', message: string) { super(message); this.name = 'TraeClientImportError'; }
}
const invalid = () => new TraeClientImportError('format', 'TRAE 中国版的本机授权格式无法识别，未导入；请先在客户端重新登录或使用反代授权页。');
const notLoggedIn = () => new TraeClientImportError('missing', '此 TRAE 中国版客户端尚未保存可导入的账号，请先在客户端登录。');

export interface TraeClientImportCandidate {
  id: 'trae-cn' | 'trae-solo-cn';
  label: string;
  accountId: string;
  displayName?: string;
  expiresAt?: number;
  expired: boolean;
}
/** Main process only. Never return this object over the preload bridge. */
export interface TraeClientCredentials {
  token: string;
  userId: string;
  host: typeof CN_HOST;
  refreshToken?: string;
  expiredAt?: string;
  refreshExpiredAt?: string;
  clientId?: string;
  webId?: string;
  bizUserId?: string;
  userUniqueId?: string;
  scope?: string;
  tenant?: string;
  region?: string;
  aiRegion?: string;
  appLanguage?: string;
  userRegion?: string;
  userIdentity?: string;
  screenName?: string;
  label?: string;
}
export interface TraeClientImportOptions { homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; now?: () => number }

function expiry(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value), time = numeric < 1e12 ? numeric * 1000 : numeric;
    if (Number.isFinite(time) && time > 0 && time <= 253402300799000) return time;
    throw invalid();
  }
  const text = scalar(value, 80), time = text && /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  if (Number.isFinite(time)) return time as number;
  throw invalid();
}

/** Independently implements the bounded tc storage format documented by the
 * pinned Trae2api-cn v1.0.10 (MIT) src/trae_decrypt.py, commit bb7b659.
 * https://github.com/autumnsentiment/Trae2api-cn/blob/v1.0.10/src/trae_decrypt.py
 * The same AES and AES_PRIVATE formats are present in installed Trae CN 3.4.15.
 */
export function decryptTraeAuthValue(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== 'string' || !value || value.length > MAX_AUTH) throw invalid();
    let text: string;
    if (value.trimStart().startsWith('{')) text = value;
    else {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
      const bytes = Buffer.from(value, 'base64');
      if (bytes.toString('base64') !== value || bytes.length < 118 || (bytes.length - 38) % 16) throw invalid();
      const header = bytes.subarray(0, 6).toString('hex'), saltIndex = header === '746305100000' ? 0 : header === '123920200203' ? 2 : -1;
      if (saltIndex < 0) throw invalid();
      const salt = Buffer.from(SALTS[saltIndex].map((item, index) => item ^ SALTS[saltIndex + 1][index]));
      const derived = hash(Buffer.concat([hash(bytes.subarray(6, 38)), salt]));
      const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
      const plain = Buffer.concat([decipher.update(bytes.subarray(38)), decipher.final()]);
      if (plain.length <= 64 || !timingSafeEqual(plain.subarray(0, 64), hash(plain.subarray(64)))) throw invalid();
      text = new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(64));
    }
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid();
    return result;
  } catch { throw invalid(); }
}

/** Selected CN paths only; no SQLite/model cache, process scanning, client
 * writes, token refresh, session imports, or recursive directory discovery. */
export class TraeClientImporter {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  constructor(options: TraeClientImportOptions = {}) {
    this.home = options.homeDir ?? homedir(); this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform; this.now = options.now ?? Date.now;
  }
  private filename(id: TraeClientImportCandidate['id']): string {
    let root: string;
    if (this.platform === 'linux') root = this.env.XDG_CONFIG_HOME || join(this.home, '.config');
    else if (this.platform === 'win32') root = this.env.APPDATA || join(this.home, 'AppData', 'Roaming');
    else throw new TraeClientImportError('unsupported', '当前系统的 TRAE 客户端授权路径尚未核实，请使用反代授权页登录。');
    if (!isAbsolute(root) || root.length > 4096 || /[\x00-\x1f]/.test(root)) throw invalid();
    return join(root, id === 'trae-cn' ? 'Trae CN' : 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json');
  }
  private async read(id: TraeClientImportCandidate['id']): Promise<Record<string, unknown> | undefined> {
    const filename = this.filename(id); let file;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw new Error();
      file = await open(filename, 'r');
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > MAX_FILE || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error();
      const buffer = Buffer.alloc(MAX_FILE + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE) throw new Error();
      const storage = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))));
      if (!Object.hasOwn(storage, AUTH_SLOT) || !storage[AUTH_SLOT]) return undefined;
      return decryptTraeAuthValue(storage[AUTH_SLOT]);
    } catch (error) {
      if (error instanceof TraeClientImportError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new TraeClientImportError('unsafe-file', '无法安全读取 TRAE 中国版的本机授权文件，请检查客户端是否已登录以及文件权限。');
    } finally { await file?.close(); }
  }
  private credentials(auth: Record<string, unknown>, allowExpired: boolean): TraeClientCredentials {
    const token = secret(auth.token), userId = identifier(auth.userId ?? auth.UserID);
    if (!token || !userId) throw notLoggedIn();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid();
    const rawHost = scalar(auth.host, 256);
    if (rawHost && ![CN_HOST, CN_HOST + '/', 'https://trae-api-cn.mchost.guru', 'https://trae-api-cn.mchost.guru/'].includes(rawHost)) throw invalid();
    let claims: Record<string, unknown> = {};
    try { claims = record(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))); } catch { throw invalid(); }
    // Empty native expiry strings must not hide an expired JWT. If multiple
    // recorded expiries disagree, the earliest known deadline is authoritative.
    const deadlines = [auth.expiredAt, auth.TokenExpireAt, claims.exp].filter(value => value !== undefined && value !== null && value !== '').map(value => expiry(value)!);
    const expires = deadlines.length ? Math.min(...deadlines) : undefined;
    if (!allowExpired && expires !== undefined && expires <= this.now()) throw new TraeClientImportError('expired', 'TRAE 本机账号的访问凭据已过期，请先在 TRAE 中国版客户端重新登录，再导入。');
    const refreshExpires = expiry(auth.refreshExpiredAt ?? auth.RefreshExpireAt);
    const account = record(auth.account), region = record(auth.userRegion);
    const fields: TraeClientCredentials = { token, userId, host: CN_HOST,
      ...(expires !== undefined ? { expiredAt: new Date(expires).toISOString() } : {}),
      ...(secret(auth.refreshToken) ? { refreshToken: secret(auth.refreshToken) } : {}),
      ...(refreshExpires !== undefined ? { refreshExpiredAt: new Date(refreshExpires).toISOString() } : {}),
      ...(identifier(auth.clientID ?? auth.ClientID ?? auth.clientId) ? { clientId: identifier(auth.clientID ?? auth.ClientID ?? auth.clientId) } : {}),
    };
    for (const [name, aliases] of Object.entries({ webId: ['webId', 'web_id', 'WebId'], bizUserId: ['bizUserId', 'biz_user_id', 'BizUserId'], userUniqueId: ['userUniqueId', 'user_unique_id', 'UserUniqueId'], scope: ['scope', 'Scope'], tenant: ['tenant', 'Tenant'], region: ['region', 'Region'], aiRegion: ['aiRegion', 'ai_region'], appLanguage: ['appLanguage', 'app_language'], userRegion: ['userRegion', 'user_region'], userIdentity: ['userIdentity', 'user_identity'] })) {
      for (const source of [auth, record(auth.providerSpecificData), record(auth.commonParams), record(auth.common_params)]) {
        const found = aliases.map(alias => scalar(source[alias], 256)).find(value => value !== undefined);
        if (found) { (fields as unknown as Record<string, unknown>)[name] = found; break; }
      }
    }
    fields.region ??= scalar(region.region); fields.aiRegion ??= scalar(region._aiRegion ?? region.region); fields.userRegion ??= scalar(region.region);
    const displayName = scalar(auth.screenName ?? account.username ?? account.name);
    if (displayName) { fields.screenName = displayName; fields.label = displayName; }
    return fields;
  }
  async listCandidates(): Promise<TraeClientImportCandidate[]> {
    const candidates: TraeClientImportCandidate[] = [];
    for (const id of ['trae-cn', 'trae-solo-cn'] as const) {
      const auth = await this.read(id); if (!auth) continue;
      const credentials = this.credentials(auth, true), expiresAt = expiry(credentials.expiredAt);
      const product = id === 'trae-cn' ? 'TRAE 中国版' : 'TRAE SOLO 中国版';
      candidates.push({ id, accountId: credentials.userId, label: product + ' · ' + (credentials.screenName || credentials.userId),
        ...(credentials.screenName ? { displayName: credentials.screenName } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), expired: expiresAt !== undefined && expiresAt <= this.now() });
    }
    return candidates;
  }
  async readCredentials(id: string): Promise<TraeClientCredentials> {
    if (id !== 'trae-cn' && id !== 'trae-solo-cn') throw new TraeClientImportError('unsupported', '请选择已列出的 TRAE 中国版客户端。');
    const auth = await this.read(id); if (!auth) throw notLoggedIn();
    return this.credentials(auth, false);
  }
}
