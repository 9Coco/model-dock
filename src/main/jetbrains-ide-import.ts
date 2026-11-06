import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readWindowsJetBrainsPreferences, type JetBrainsPreferenceValues } from './jetbrains-ide-windows';

const MAX_FILE = 1024 * 1024, MAX_WRAPPED = 64 * 1024, MAX_TOKEN = 32 * 1024;
const NODE_PARTS = ['.java', '.userPrefs', 'jetbrains', 'jetprofile'] as const;
const WRAP_MASK = Buffer.from('The Drive to Develop.', 'utf8');
const KNOWN_KEYS = new Set(['idtoken', 'userlogin', 'userid']);
const PROFILES = { 'intellij-idea': ['IntelliJIdea2026.2', 'IntelliJ IDEA 2026.2'], webstorm: ['WebStorm2026.2', 'WebStorm 2026.2'], rider: ['Rider2026.2', 'Rider 2026.2'], pycharm: ['PyCharm2026.2', 'PyCharm 2026.2'] } as const;
type IdeProduct = keyof typeof PROFILES;
function label(value: unknown, max = 160): string | undefined { return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined; }
function identifier(value: unknown): string | undefined { const valueLabel = label(value); return valueLabel && /^[A-Za-z0-9_.:@-]+$/.test(valueLabel) && !valueLabel.startsWith('eyJ') ? valueLabel : undefined; }

export class JetBrainsIdeImportError extends Error {
  constructor(readonly code: 'missing' | 'format' | 'expired' | 'unsafe-file' | 'unsupported' | 'selection', message: string) { super(message); this.name = 'JetBrainsIdeImportError'; }
}
const format = () => new JetBrainsIdeImportError('format', 'JetBrains IDE 本机账号格式无法识别，请在 IDE 重新登录后再试。');
const missing = () => new JetBrainsIdeImportError('missing', '未找到 JetBrains IDE 已保存的账号会话，请先在 IDE 登录本人 JetBrains Account。');
export interface JetBrainsIdeImportOptions {
  homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; now?: () => number;
  /** Main-process test port. Production reads only the fixed native JBR preference node. */
  readWindowsPreferences?: () => Promise<JetBrainsPreferenceValues>;
}
export interface JetBrainsIdeImportCandidate {
  id: string;
  client: 'jetbrains-ide';
  clientName: string;
  product: IdeProduct;
  /** Stable product/license identity for provider reuse; contains no token or raw license ID. */
  sourceIdentity: string;
  /** Main-process only: equivalent account/license choices across IDEs. Never
   * include this private fingerprint in the renderer-safe import preview. */
  accountLicenseIdentity?: string;
  /** Another IDE has an unsupported or mismatched selected access source.
   * Manual selection remains available, but default import must not fall back. */
  defaultRequiresSelection?: boolean;
  accountId: string;
  accountLabel: string;
  /** Source assertion metadata only, never an access-authorization deadline. */
  sourceTokenExpHint?: number;
}
/** Main process only. This is an unverified JBA identity token, never a
 * Central CLI OAuth bundle, Grazie JWT, or proof of AI access. A caller must
 * validate/exchange it with a fixed official service before saving auth. */
export interface JetBrainsIdeCredentials {
  tokenType: 'jba-id-token';
  authorization: 'unverified';
  idToken: string;
  accountId: string;
  accountLabel: string;
  sourceTokenExpHint?: number;
  issuer?: string;
  subject?: string;
  email?: string;
  login?: string;
  licenseId: string;
  product: IdeProduct;
  sourceIdentity: string;
}
type JbaCredentials = Omit<JetBrainsIdeCredentials, 'licenseId' | 'product' | 'sourceIdentity'>;

function xmlValue(value: string): string {
  if (/[<>]/.test(value) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) throw format();
  return value.replace(/&([^;]+);/g, (_match, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity];
    const number = /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) throw format();
    return String.fromCodePoint(number);
  });
}
function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const expression = /\s+([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  let end = 0;
  while (end < value.length && value.slice(end).trim()) {
    expression.lastIndex = end; const match = expression.exec(value);
    if (!match || Object.hasOwn(result, match[1])) throw format();
    result[match[1]] = xmlValue(match[2] ?? match[3]); end = expression.lastIndex;
  }
  return result;
}
/** The native Java Preferences map format only. The known external DTD is
 * recognized as syntax and is never fetched; custom DTD/entities are refused. */
export function parseJetBrainsPreferences(xml: string): Partial<Record<'idtoken' | 'userlogin' | 'userid', string>> {
  if (Buffer.byteLength(xml) > MAX_FILE) throw format();
  let content = xml.replace(/^\uFEFF/, '').trim();
  content = content.replace(/^<\?xml\s+version=(?:"1\.0"|'1\.0')\s+encoding=(?:"UTF-8"|'UTF-8')(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>\s*/i, '');
  content = content.replace(/^<!DOCTYPE\s+map\s+SYSTEM\s+(?:"http:\/\/java\.sun\.com\/dtd\/preferences\.dtd"|'http:\/\/java\.sun\.com\/dtd\/preferences\.dtd')\s*>\s*/, '');
  if (/<!|<\?/.test(content)) throw format();
  const root = /^<map([^>]*?)\/>\s*$/.exec(content) ?? /^<map([^>]*)>([\s\S]*)<\/map>\s*$/.exec(content);
  if (!root) throw format();
  const mapAttributes = attributes(root[1]);
  if (Object.keys(mapAttributes).some(name => name !== 'MAP_XML_VERSION') || mapAttributes.MAP_XML_VERSION !== '1.0') throw format();
  const result: Partial<Record<'idtoken' | 'userlogin' | 'userid', string>> = {};
  const body = root[2] ?? '', entryPattern = /\s*<entry\b([^<>]*)\/>/gy;
  let position = 0, entries = 0;
  while (position < body.length) {
    entryPattern.lastIndex = position; const entry = entryPattern.exec(body);
    if (!entry) { if (body.slice(position).trim()) throw format(); break; }
    if (++entries > 1024) throw format();
    const fields = attributes(entry[1]);
    if (Object.keys(fields).length !== 2 || fields.key === undefined || fields.value === undefined || Object.keys(fields).some(name => name !== 'key' && name !== 'value')) throw format();
    if (KNOWN_KEYS.has(fields.key)) {
      const key = fields.key as keyof typeof result;
      if (Object.hasOwn(result, key) || fields.value.length > MAX_WRAPPED) throw format();
      result[key] = fields.value;
    }
    position = entryPattern.lastIndex;
  }
  return result;
}

/** Verified against installed IntelliJ IDEA 2026.2.4 build 262.11879.100,
 * intellij.platform.cs.jar G7/Q9 public bytecode and resolved JDK references:
 * JetBrains.JetProfile.IdToken -> Base64.getMimeDecoder -> cyclic XOR of the
 * public constant "The Drive to Develop." -> UTF-8 JBA ID-token JWT.
 * GD validates the three JWT parts and requires payload.user_id. */
export function decodeJetBrainsPreferenceValue(wrapped: string): string {
  try {
    if (typeof wrapped !== 'string' || !wrapped || wrapped.length > MAX_WRAPPED || /[^A-Za-z0-9+/=\t\r\n ]/.test(wrapped)) throw format();
    const compact = wrapped.replace(/[\t\r\n ]/g, ''), bytes = Buffer.from(compact, 'base64');
    if (!bytes.length || bytes.length > MAX_TOKEN || bytes.toString('base64') !== compact) throw format();
    for (let index = 0; index < bytes.length; index++) bytes[index] ^= WRAP_MASK[index % WRAP_MASK.length];
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw format(); }
}
export function decodeJetBrainsIdToken(wrapped: string): string {
  const token = decodeJetBrainsPreferenceValue(wrapped);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw format();
  return token;
}
function jwtPart(part: string): Record<string, unknown> {
  try {
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) throw format();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw format();
    return parsed as Record<string, unknown>;
  } catch { throw format(); }
}
function credentials(values: Partial<Record<'idtoken' | 'userlogin' | 'userid', string>>): JbaCredentials | undefined {
  if (!values.idtoken) return;
  const idToken = decodeJetBrainsIdToken(values.idtoken), [head, body, signature] = idToken.split('.');
  const header = jwtPart(head), claims = jwtPart(body), accountId = identifier(claims.user_id);
  if (!['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'].includes(String(header.alg)) || !accountId || Buffer.from(signature, 'base64url').toString('base64url') !== signature) throw format();
  // The stored identity is a cross-check only, never a token-prefix fallback.
  if (values.userid && identifier(decodeJetBrainsPreferenceValue(values.userid)) !== accountId) throw new JetBrainsIdeImportError('selection', 'JetBrains IDE 保存的账号信息不一致，请重新登录后再导入。');
  // Native GD/JbaIdToken does not enforce source JWT time claims. The official
  // service has accepted an unchanged past-exp assertion and verified its
  // derived authorization. Only that service decides assertion usability;
  // a numeric source exp is an optional hint, never a local auth gate.
  const sourceTokenExpHint = typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) && claims.exp > 0 && claims.exp <= 253402300799 ? claims.exp * 1000 : undefined;
  const email = label(claims.email, 254), login = label(claims.jba_login) ?? (values.userlogin ? label(decodeJetBrainsPreferenceValue(values.userlogin)) : undefined), name = label(claims.full_name);
  return { tokenType: 'jba-id-token', authorization: 'unverified', idToken, accountId, ...(sourceTokenExpHint !== undefined ? { sourceTokenExpHint } : {}), accountLabel: name ?? login ?? email ?? accountId,
    ...(email ? { email } : {}), ...(login ? { login } : {}), ...(label(claims.iss, 256) ? { issuer: label(claims.iss, 256) } : {}), ...(label(claims.sub) ? { subject: label(claims.sub) } : {}) };
}
/** Static ml-llm.jar IjAipLicensePreferencesRepository declares
 * @State(name="AipLicense", @Storage("other.xml")) with licenseId and
 * forciblyLoggedOut options. Read exactly that application component. */
export function parseJetBrainsAiLicense(xml: string, currentAccountId?: string): string | undefined {
  if (Buffer.byteLength(xml) > MAX_FILE || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw format();
  const stack: { name: string; attrs: Record<string, string> }[] = [];
  let position = 0, roots = 0, selectedComponents = 0, workspaceComponents = 0, selectedLicense: string | undefined, licenseOptions = 0, loggedOut = false;
  const logoutOptions = new Map<string, boolean>();
  const workspace: Record<string, string> = Object.create(null);
  while (position < xml.length) {
    const start = xml.indexOf('<', position);
    if (start < 0) { if (!stack.length && xml.slice(position).trim()) throw format(); break; }
    if (!stack.length && xml.slice(position, start).trim()) throw format();
    if (xml.startsWith('<!--', start)) { const end = xml.indexOf('-->', start + 4); if (end < 0) throw format(); position = end + 3; continue; }
    if (xml.startsWith('<![CDATA[', start)) { const end = xml.indexOf(']]>', start + 9); if (end < 0 || !stack.length) throw format(); position = end + 3; continue; }
    if (xml.startsWith('<?xml', start) && roots === 0) { const end = xml.indexOf('?>', start + 5); if (end < 0) throw format(); position = end + 2; continue; }
    let end = start + 1, quote = '';
    for (; end < xml.length; end++) { const char = xml[end]; if (quote) { if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break; }
    if (end >= xml.length || quote) throw format();
    const tag = xml.slice(start + 1, end), close = /^\/([A-Za-z_][\w.-]*)\s*$/.exec(tag);
    if (close) { if (stack.pop()?.name !== close[1]) throw format(); position = end + 1; continue; }
    const openTag = /^([A-Za-z_][\w.-]*)([\s\S]*?)(\/)?$/.exec(tag);
    if (!openTag) throw format();
    const node = { name: openTag[1], attrs: attributes(openTag[2]) }, parent = stack.at(-1);
    if (!stack.length) { if (++roots !== 1 || node.name !== 'application') throw format(); }
    if (stack.length === 1 && node.name === 'component' && node.attrs.name === 'AipLicense' && ++selectedComponents > 1) throw format();
    if (stack.length === 1 && node.name === 'component' && node.attrs.name === 'JcpWorkspaceSelection' && ++workspaceComponents > 1) throw format();
    if (stack.length === 2 && parent?.name === 'component' && parent.attrs.name === 'AipLicense' && node.name === 'option') {
      if (node.attrs.name === 'licenseId') { if (++licenseOptions > 1) throw format(); selectedLicense = identifier(node.attrs.value); if (node.attrs.value && !selectedLicense) throw format(); }
      // The native Kotlin property is isForciblyLoggedOut; its bean setter
      // also exposes forciblyLoggedOut. Honor either serializer spelling.
      if (['forciblyLoggedOut', 'isForciblyLoggedOut'].includes(node.attrs.name)) {
        if (logoutOptions.has(node.attrs.name) || !['true', 'false'].includes(node.attrs.value)) throw format();
        const value = node.attrs.value === 'true';
        if ([...logoutOptions.values()].some(previous => previous !== value)) throw format();
        logoutOptions.set(node.attrs.name, value); loggedOut ||= value;
      }
    }
    if (stack.length === 2 && parent?.name === 'component' && parent.attrs.name === 'JcpWorkspaceSelection' && node.name === 'option' && ['accessUserId', 'accessType', 'accessLicenseId', 'accessWorkspaceId'].includes(node.attrs.name)) {
      if (Object.hasOwn(workspace, node.attrs.name) || node.attrs.value === undefined) throw format();
      workspace[node.attrs.name] = node.attrs.value;
    }
    if (!openTag[3]) { stack.push(node); if (stack.length > 64) throw format(); }
    position = end + 1;
  }
  if (stack.length || roots !== 1) throw format();
  if (loggedOut) return;
  if (workspace.accessType?.trim()) {
    if (workspace.accessType !== 'license') throw new JetBrainsIdeImportError('unsupported', '此 IDE 当前选择了工作区或其他访问来源，暂不支持导入；不会改用旧的个人许可证。');
    const userId = identifier(workspace.accessUserId), licenseId = identifier(workspace.accessLicenseId);
    if (!currentAccountId || userId !== currentAccountId || !licenseId) throw new JetBrainsIdeImportError('selection', 'IDE 当前许可证的账号与本机 JetBrains Account 不一致，请重新选择本人账号和许可证。');
    return licenseId;
  }
  return selectedLicense;
}
const fingerprint = (value: JbaCredentials, sourceIdentity: string) => createHash('sha256').update(JSON.stringify([value.accountId, value.issuer ?? '', value.subject ?? '', sourceIdentity])).digest('hex');
const sourceIdentity = (product: IdeProduct, licenseId: string) => 'jetbrains-ide:' + product + ':' + createHash('sha256').update(licenseId).digest('hex');

export class JetBrainsIdeImporter {
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly readWindowsPreferences: () => Promise<JetBrainsPreferenceValues>;
  private readonly selections = new Map<string, { identity: string; product: IdeProduct; expires: number }>();
  constructor(options: JetBrainsIdeImportOptions = {}) { this.home = options.homeDir ?? homedir(); this.platform = options.platform ?? process.platform; this.env = options.env ?? process.env; this.now = options.now ?? Date.now; this.readWindowsPreferences = options.readWindowsPreferences ?? readWindowsJetBrainsPreferences; }
  private async readFile(base: string, parts: readonly string[]): Promise<string | undefined> {
    if (!['linux', 'win32'].includes(this.platform)) throw new JetBrainsIdeImportError('unsupported', '当前系统的 JetBrains IDE 账号导入尚未完成原生验证，请先使用独立账号登录。');
    if (!isAbsolute(base) || base.length > 4096 || /[\x00-\x1f\x7f]/.test(base)) throw format();
    let file;
    try {
      let directory = base;
      for (const part of ['', ...parts.slice(0, -1)]) { directory = join(directory, part); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw format(); }
      const filename = join(directory, parts.at(-1)!), original = await lstat(filename);
      if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.size > MAX_FILE) throw format();
      file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > MAX_FILE || original.dev !== opened.dev || original.ino !== opened.ino) throw format();
      const buffer = Buffer.alloc(MAX_FILE + 1); let size = 0;
      while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > MAX_FILE) throw format();
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } catch (error) {
      if (error instanceof JetBrainsIdeImportError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw new JetBrainsIdeImportError('unsafe-file', '无法安全读取 JetBrains IDE 本机账号，请检查客户端登录和本机文件权限。');
    } finally { await file?.close().catch(() => {}); }
  }
  private async readJba(): Promise<JbaCredentials | undefined> {
    if (this.platform === 'win32') {
      let values: JetBrainsPreferenceValues;
      try { values = await this.readWindowsPreferences(); }
      catch { throw new JetBrainsIdeImportError('unsafe-file', '无法安全读取 Windows 中的 JetBrains IDE 本机账号，请检查本机登录和注册表读取权限。'); }
      return credentials(values);
    }
    const xml = await this.readFile(this.home, [...NODE_PARTS, 'prefs.xml']);
    return xml === undefined ? undefined : credentials(parseJetBrainsPreferences(xml));
  }
  private async readLicense(product: IdeProduct, accountId: string): Promise<string | undefined> {
    const config = this.platform === 'win32' ? this.env.APPDATA || join(this.home, 'AppData', 'Roaming') : this.env.XDG_CONFIG_HOME || join(this.home, '.config');
    const xml = await this.readFile(config, ['JetBrains', PROFILES[product][0], 'options', 'other.xml']);
    return xml === undefined ? undefined : parseJetBrainsAiLicense(xml, accountId);
  }
  async listCandidates(): Promise<JetBrainsIdeImportCandidate[]> {
    const value = await this.readJba(); if (!value) return [];
    const now = this.now(); for (const [id, item] of this.selections) if (item.expires <= now) this.selections.delete(id);
    const candidates: JetBrainsIdeImportCandidate[] = []; let rejectedSelection: JetBrainsIdeImportError | undefined;
    for (const product of Object.keys(PROFILES) as IdeProduct[]) {
      let licenseId: string | undefined;
      try { licenseId = await this.readLicense(product, value.accountId); }
      catch (error) { if (error instanceof JetBrainsIdeImportError && ['unsupported', 'selection'].includes(error.code)) { rejectedSelection ??= error; continue; } throw error; }
      if (!licenseId) continue;
      const id = randomUUID(), source = sourceIdentity(product, licenseId);
      this.selections.set(id, { identity: fingerprint(value, source), product, expires: now + 5 * 60_000 });
      const accountLicenseIdentity = createHash('sha256').update(JSON.stringify([value.accountId, licenseId])).digest('hex');
      candidates.push({ id, client: 'jetbrains-ide', clientName: PROFILES[product][1] + ' · 已选 AI 许可证', product, sourceIdentity: source, accountLicenseIdentity, accountId: value.accountId, accountLabel: value.accountLabel, ...(value.sourceTokenExpHint !== undefined ? { sourceTokenExpHint: value.sourceTokenExpHint } : {}) });
    }
    if (!candidates.length && rejectedSelection) throw rejectedSelection;
    if (!candidates.length) throw new JetBrainsIdeImportError('missing', '未找到 IDE 已选择的 AI 许可证，请先在 JetBrains IDE 的 AI Assistant 中选择本人许可证，再导入。');
    if (rejectedSelection) for (const candidate of candidates) candidate.defaultRequiresSelection = true;
    return candidates;
  }
  async readCredentials(id: string): Promise<JetBrainsIdeCredentials> {
    const selection = this.selections.get(id);
    if (!selection || selection.expires <= this.now()) throw new JetBrainsIdeImportError('selection', '客户端选择已过期，请关闭窗口后重新选择 JetBrains IDE 账号。');
    const value = await this.readJba(); if (!value) throw missing();
    const licenseId = await this.readLicense(selection.product, value.accountId);
    if (!licenseId) throw new JetBrainsIdeImportError('selection', 'IDE 的 AI 许可证选择已变化，请先在 IDE 选择许可证，再重新导入。');
    const source = sourceIdentity(selection.product, licenseId);
    if (fingerprint(value, source) !== selection.identity) throw new JetBrainsIdeImportError('selection', 'JetBrains IDE 当前账号或 AI 许可证已切换，请关闭窗口后重新选择。');
    // Bracket both independent files. A current account/license switch during
    // the read must not return a credential for the previous selection.
    const latest = await this.readJba(), latestLicense = latest ? await this.readLicense(selection.product, latest.accountId) : undefined;
    if (!latest || !latestLicense || fingerprint(latest, sourceIdentity(selection.product, latestLicense)) !== selection.identity) throw new JetBrainsIdeImportError('selection', 'JetBrains IDE 当前账号或 AI 许可证已切换，请关闭窗口后重新选择。');
    return { ...latest, licenseId: latestLicense, product: selection.product, sourceIdentity: source };
  }
}
