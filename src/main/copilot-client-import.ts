import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import type { CopilotImportCandidate } from '../shared/auth-types';
import { readCopilotCliKeychain } from './copilot-import-keychain';

const MAX_FILE = 256 * 1024;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Only literal GitHub user tokens, never a local Copilot API/session token. */
export function importedGithubToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 32_768 && /^(?:gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(value) ? value : undefined;
}
function login(value: unknown): string | undefined { return typeof value === 'string' && LOGIN.test(value) ? value : undefined; }
const safeId = (client: CopilotImportCandidate['client'], name: string) => createHash('sha256').update(client + ':' + name.toLowerCase()).digest('hex').slice(0, 24);

export interface CopilotClientImportOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readKeychain?: (accountKey: string) => Promise<string | undefined>;
  runGithubCli?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

/** Bounded exact client files only. No session/extension/VS Code databases or
 * home-directory traversal. Source files and system credentials are read-only.
 * Official contracts: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
 * https://cli.github.com/manual/gh_auth_token (use --no-refresh).
 * Copilot CLI 1.0.68's installed runtime generated the camelCase plaintext
 * fixture copilotTokens['https://github.com:login']; old snake_case is retained.
 */
export class CopilotClientImporter {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  constructor(private readonly options: CopilotClientImportOptions = {}) {
    this.home = options.homeDir ?? homedir();
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
  }
  private async read(filename: string): Promise<string | undefined> {
    let handle;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw new Error();
      handle = await open(filename, 'r');
      if (!(await handle.stat()).isFile()) throw new Error();
      const bytes = Buffer.alloc(MAX_FILE + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_FILE) throw new Error();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error('本机客户端配置无法安全读取，请检查文件权限或在 ModelDock 直接登录 GitHub。');
    } finally { await handle?.close(); }
  }
  private directory(value: string | undefined, fallback: string): string {
    if (value === undefined || value === '') return fallback;
    if (!isAbsolute(value) || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('本机客户端配置目录无效。');
    return value;
  }
  private async copilotConfig(): Promise<Record<string, unknown>> {
    const raw = await this.read(join(this.directory(this.env.COPILOT_HOME, join(this.home, '.copilot')), 'config.json'));
    if (raw === undefined) return {};
    const errors: ParseError[] = [], value = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Copilot CLI 配置格式无法识别，请更新客户端或在 ModelDock 直接登录。');
    return value;
  }
  private async githubConfig(): Promise<Record<string, unknown>> {
    const fallback = this.platform === 'win32' ? join(this.directory(this.env.APPDATA, join(this.home, 'AppData/Roaming')), 'GitHub CLI') : join(this.directory(this.env.XDG_CONFIG_HOME, join(this.home, '.config')), 'gh');
    const raw = await this.read(join(this.directory(this.env.GH_CONFIG_DIR, fallback), 'hosts.yml'));
    if (raw === undefined) return {};
    try {
      const doc = parseDocument(raw, { uniqueKeys: true });
      if (doc.errors.length) throw new Error();
      return object(object(doc.toJS({ maxAliasCount: 0 }))['github.com']);
    } catch { throw new Error('GitHub CLI 账号配置格式无法识别，请在 ModelDock 直接登录。'); }
  }
  private copilotNames(config: Record<string, unknown>): string[] {
    const names = new Map<string, string>();
    const add = (value: unknown) => { const name = login(value); if (name) names.set(name.toLowerCase(), name); };
    for (const value of [config.lastLoggedInUser, config.last_logged_in_user, ...(Array.isArray(config.loggedInUsers) ? config.loggedInUsers : []), ...(Array.isArray(config.logged_in_users) ? config.logged_in_users : [])]) {
      const user = object(value); if (user.host === 'https://github.com' || user.host === 'github.com') add(user.login);
    }
    for (const tokens of [config.copilotTokens, config.copilot_tokens]) for (const key of Object.keys(object(tokens))) {
      const match = /^https:\/\/github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,38})$/.exec(key); if (match) add(match[1]);
    }
    if (names.size > 100) throw new Error('Copilot CLI 账号数量超出可导入范围。');
    return [...names.values()];
  }
  private githubNames(config: Record<string, unknown>): string[] {
    const names = [...new Set([login(config.user), ...Object.keys(object(config.users)).map(login)].filter((value): value is string => !!value))];
    if (names.length > 100) throw new Error('GitHub CLI 账号数量超出可导入范围。');
    return names;
  }
  async listCandidates(): Promise<CopilotImportCandidate[]> {
    const configs = await Promise.all([this.copilotConfig(), this.githubConfig()]);
    return (['copilot-cli', 'github-cli'] as const).flatMap((client, index) => (index === 0 ? this.copilotNames(configs[0]) : this.githubNames(configs[1])).map(name => ({
      id: safeId(client, name), client, login: name, label: `${client === 'copilot-cli' ? 'Copilot CLI' : 'GitHub CLI (gh)'} · ${name}`,
    })));
  }
  private githubEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'GH_TRACE', 'GITHUB_DEBUG']) delete env[key];
    // Executables are resolved only through absolute PATH entries, never cwd.
    if (env.PATH) env.PATH = env.PATH.split(delimiter).filter(isAbsolute).join(delimiter);
    return env;
  }
  private async githubToken(name: string): Promise<string | undefined> {
    const args = ['auth', 'token', '--hostname', 'github.com', '--user', name, '--no-refresh'], env = this.githubEnvironment();
    let raw: string;
    try {
      raw = this.options.runGithubCli ? await this.options.runGithubCli(args, env) : await new Promise<string>((resolve, reject) => {
        execFile(this.platform === 'win32' ? 'gh.exe' : 'gh', args, { env, cwd: this.home, timeout: 10_000, maxBuffer: 40_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(new Error()) : resolve(stdout));
      });
    } catch { throw new Error('无法读取此 GitHub CLI 账号，请确认已登录、钥匙串可访问且 gh 支持 --no-refresh；也可在 ModelDock 直接登录。'); }
    return importedGithubToken(raw.trim());
  }
  async readCredential(id: string): Promise<{ candidate: CopilotImportCandidate; accessToken: string }> {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('请选择本机客户端账号。');
    const candidate = (await this.listCandidates()).find(item => item.id === id);
    if (!candidate) throw new Error('本机客户端账号已改变，请重新选择。');
    let accessToken: string | undefined;
    if (candidate.client === 'github-cli') accessToken = await this.githubToken(candidate.login);
    else {
      const config = await this.copilotConfig(), accountKey = 'https://github.com:' + candidate.login;
      const values = [object(config.copilotTokens)[accountKey], object(config.copilot_tokens)[accountKey]].filter(value => value !== undefined);
      if (values.length > 1 && values[0] !== values[1]) throw new Error('Copilot CLI 同一账号存在不同凭据，请先在客户端重新登录。');
      if (values.length) accessToken = importedGithubToken(values[0]);
      else accessToken = importedGithubToken(await (this.options.readKeychain ?? (key => readCopilotCliKeychain(key, this.platform)))(accountKey));
    }
    if (!accessToken) throw new Error('未找到受支持的 GitHub 用户凭据；不读取 VS Code 或编辑器的加密账号库，请在 ModelDock 直接登录。');
    return { candidate, accessToken };
  }
}
