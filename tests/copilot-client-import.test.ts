import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { CopilotClientImporter, importedGithubToken, type CopilotClientImportOptions } from '../src/main/copilot-client-import';
import { linuxCopilotImportHelper } from '../src/main/copilot-import-keychain';
import { CopilotAuthCenter, type CopilotAuthStore } from '../src/main/copilot-auth';

const TOKEN = 'gho_SYNTHETIC_COPILOT_IMPORT_PRIVATE';
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture(options: Partial<CopilotClientImportOptions> = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'modeldock-copilot-import-')); folders.push(homeDir);
  const config = join(homeDir, '.copilot/config.json'), hosts = join(homeDir, '.config/gh/hosts.yml');
  await mkdir(join(homeDir, '.copilot'), { recursive: true }); await mkdir(join(homeDir, '.config/gh'), { recursive: true });
  const settings = { homeDir, env: {}, ...options };
  return { homeDir, config, hosts, importer: new CopilotClientImporter(settings), settings,
    write: (value: unknown) => writeFile(config, JSON.stringify(value)),
  };
}
class MemoryStore implements CopilotAuthStore {
  encrypted = new Map<string, string>(); fail = false;
  getManagedState<T>(key: string, fallback: T): T { return this.encrypted.has(key) ? JSON.parse(Buffer.from(this.encrypted.get(key)!, 'base64').toString()) : structuredClone(fallback); }
  setManagedState(key: string, value: unknown) { if (this.fail) throw new Error(TOKEN); this.encrypted.set(key, Buffer.from(JSON.stringify(value)).toString('base64')); }
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const user = { id: 42, login: 'fixture-user', name: 'Import Fixture' };
const quota = { copilot_plan: 'individual', quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 123 } } };

describe('explicit scoped Copilot client credential import', () => {
  it('lists only github.com client/account identities without reading keychain or returning credentials', async () => {
    const readKeychain = vi.fn(), runGithubCli = vi.fn(), f = await fixture({ readKeychain, runGithubCli });
    expect(readKeychain).not.toHaveBeenCalled(); expect(runGithubCli).not.toHaveBeenCalled();
    await f.write({ loggedInUsers: [{ host: 'https://github.com', login: 'first-user' }, { host: 'https://enterprise.invalid', login: 'private-enterprise' }], lastLoggedInUser: { host: 'https://github.com', login: 'second-user' }, copilotTokens: { 'https://github.com:third-user': TOKEN, 'https://evilgithub.com:private': TOKEN } });
    await writeFile(f.hosts, 'github.com:\n  user: gh-user\n  users:\n    gh-user:\n      oauth_token: ' + TOKEN + '\n    second-gh: {}\nenterprise.invalid:\n  user: private-enterprise\n');
    const candidates = await f.importer.listCandidates();
    expect(candidates.map(item => [item.client, item.login])).toEqual([['copilot-cli', 'second-user'], ['copilot-cli', 'first-user'], ['copilot-cli', 'third-user'], ['github-cli', 'gh-user'], ['github-cli', 'second-gh']]);
    expect(candidates.every(item => /^[a-f0-9]{24}$/.test(item.id))).toBe(true);
    expect(JSON.stringify(candidates)).not.toMatch(/PRIVATE|private-enterprise|evilgithub|oauth_token|copilotTokens/);
    expect(readKeychain).not.toHaveBeenCalled(); expect(runGithubCli).not.toHaveBeenCalled();
  });
  it.each(['copilotTokens', 'copilot_tokens'])('imports the exact %s plaintext account slot and preserves the client file', async field => {
    const f = await fixture(); await writeFile(f.config, '// client-owned comment\n' + JSON.stringify({ [field]: { 'https://github.com:fixture-user': TOKEN }, trustedFolders: ['unchanged'], unrelated: true }));
    const before = await readFile(f.config), [candidate] = await f.importer.listCandidates();
    expect(await f.importer.readCredential(candidate.id)).toMatchObject({ accessToken: TOKEN, candidate: { client: 'copilot-cli', login: 'fixture-user' } });
    expect(await readFile(f.config)).toEqual(before);
  });
  it('defers the exact keychain slot until the user chooses an account', async () => {
    const readKeychain = vi.fn(async () => TOKEN), f = await fixture({ readKeychain });
    await f.write({ logged_in_users: [{ host: 'https://github.com', login: 'fixture-user' }] });
    const [candidate] = await f.importer.listCandidates(); expect(readKeychain).not.toHaveBeenCalled();
    expect((await f.importer.readCredential(candidate.id)).accessToken).toBe(TOKEN);
    expect(readKeychain).toHaveBeenCalledExactlyOnceWith('https://github.com:fixture-user');
  });
  it('uses the selected gh account with no refresh, no environment-token override and no source writes', async () => {
    const runGithubCli = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => TOKEN + '\n'), f = await fixture({ runGithubCli, env: { GH_TOKEN: 'PRIVATE_OVERRIDE', GITHUB_TOKEN: 'PRIVATE_OVERRIDE_2', GH_DEBUG: 'api', PATH: '.:/usr/bin:relative' } });
    await writeFile(f.hosts, 'github.com:\n  user: fixture-user\n'); const before = await readFile(f.hosts);
    const [candidate] = await f.importer.listCandidates(); expect((await f.importer.readCredential(candidate.id)).accessToken).toBe(TOKEN);
    const [args, env] = runGithubCli.mock.calls[0];
    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'fixture-user', '--no-refresh']);
    expect(env).toMatchObject({ GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin' });
    expect(env.GH_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined(); expect(env.GH_DEBUG).toBeUndefined();
    expect(await readFile(f.hosts)).toEqual(before);
  });
  it('refuses unknown, removed, enterprise and path-like candidate identifiers', async () => {
    const readKeychain = vi.fn(), f = await fixture({ readKeychain }); await f.write({ copilotTokens: { 'https://github.com:fixture-user': TOKEN } });
    const [candidate] = await f.importer.listCandidates(); await f.write({});
    await expect(f.importer.readCredential(candidate.id)).rejects.toThrow('账号已改变');
    for (const value of ['../../secrets', 'https://evil.invalid', '', 'a'.repeat(24)]) await expect(f.importer.readCredential(value)).rejects.toThrow();
    expect(readKeychain).not.toHaveBeenCalled();
  });
  it('rejects malformed, oversized, symlinked and conflicting client files without printing their contents', async () => {
    const f = await fixture(); await writeFile(f.config, TOKEN + '{invalid');
    await expect(f.importer.listCandidates()).rejects.toThrow('配置格式无法识别');
    await writeFile(f.config, TOKEN.repeat(10000)); await expect(f.importer.listCandidates()).rejects.toThrow('无法安全读取');
    await rm(f.config); const foreign = join(f.homeDir, 'foreign'); await writeFile(foreign, TOKEN); await symlink(foreign, f.config);
    await expect(f.importer.listCandidates()).rejects.toThrow('无法安全读取');
    await rm(f.config); await f.write({ copilotTokens: { 'https://github.com:fixture-user': TOKEN }, copilot_tokens: { 'https://github.com:fixture-user': 'gho_OTHER' } });
    const [candidate] = await f.importer.listCandidates(); await expect(f.importer.readCredential(candidate.id)).rejects.toThrow('存在不同凭据');
  });
  it('accepts only literal supported GitHub user-token families', () => {
    for (const value of [TOKEN, 'ghu_fixture', 'github_pat_fixture']) expect(importedGithubToken(value)).toBe(value);
    for (const value of ['ghp_classic', 'Bearer ' + TOKEN, TOKEN + '\n', 'v1=local-session', '', null, {}, TOKEN + '; host=evil']) expect(importedGithubToken(value)).toBeUndefined();
  });
});

describe('Copilot account verification and encrypted save after client import', () => {
  async function service(handler?: (url: string) => Response | Promise<Response>) {
    const f = await fixture(); await f.write({ copilotTokens: { 'https://github.com:fixture-user': TOKEN } });
    const store = new MemoryStore(), fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('token ' + TOKEN); expect(init?.redirect).toBe('error');
      return handler ? handler(String(url)) : reply(String(url) === 'https://api.github.com/user' ? user : quota);
    });
    const manager = new CopilotAuthCenter(store, { openExternal: vi.fn(), fetch: fetcher as typeof fetch, clientImport: f.settings });
    const [candidate] = await manager.clientImportCandidates(); return { ...f, store, fetcher, manager, candidate };
  }
  it('validates exact account identity and entitlement before saving a renderer-safe imported account', async () => {
    const f = await service(), before = await readFile(f.config); expect(f.manager.listAccounts()).toEqual([]); expect(f.fetcher).not.toHaveBeenCalled();
    const account = await f.manager.importClientAccount(f.candidate.id);
    expect(f.fetcher.mock.calls.map(call => String(call[0]))).toEqual(['https://api.github.com/user', 'https://api.github.com/copilot_internal/user']);
    expect(account).toMatchObject({ providerId: 'copilot:42', kind: 'copilot', source: 'client-import', authStatus: 'ready', usage: { status: 'ready', windows: [{ remaining: 123 }] } });
    expect(JSON.stringify(account)).not.toContain(TOKEN); expect([...f.store.encrypted.values()].join()).not.toContain(TOKEN);
    expect(f.manager.getInferenceAuthorization('copilot:42').accessToken).toBe(TOKEN);
    expect(await readFile(f.config)).toEqual(before); f.manager.dispose();
  });
  it('replaces the same verified account once and retains other managed accounts', async () => {
    const f = await service(); await f.manager.importClientAccount(f.candidate.id);
    const state = f.store.getManagedState<any>('copilot-auth:v1', null); state.accounts.push({ ...state.accounts[0], id: 'copilot:43', login: 'other-user' }); f.store.setManagedState('copilot-auth:v1', state);
    await f.manager.importClientAccount(f.candidate.id);
    expect(f.manager.listAccounts().map(account => account.providerId).sort()).toEqual(['copilot:42', 'copilot:43']); f.manager.dispose();
  });
  it('does not equate missing quota data with a proven usable subscription', async () => {
    const f = await service(url => reply(url.endsWith('/user') && !url.includes('copilot_internal') ? user : {}));
    const account = await f.manager.importClientAccount(f.candidate.id);
    expect(account.usage).toMatchObject({ status: 'unavailable', windows: [] }); expect(account.usage.message).toContain('不能据此确认模型可用'); f.manager.dispose();
  });
  it.each([401, 403])('rejects a Copilot entitlement HTTP %s without saving a partially validated account', async status => {
    const f = await service(url => url.includes('copilot_internal') ? reply({ message: TOKEN }, status) : reply(user));
    const error = await f.manager.importClientAccount(f.candidate.id).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(TOKEN); expect(f.manager.listAccounts()).toEqual([]); f.manager.dispose();
  });
  it('rejects an identity mismatch before entitlement lookup and redacts storage/transport errors', async () => {
    const mismatch = await service(() => reply({ ...user, login: 'different-user' }));
    await expect(mismatch.manager.importClientAccount(mismatch.candidate.id)).rejects.toThrow('身份不符'); expect(mismatch.fetcher).toHaveBeenCalledTimes(1); expect(mismatch.manager.listAccounts()).toEqual([]); mismatch.manager.dispose();
    const failure = await service(); failure.store.fail = true;
    await expect(failure.manager.importClientAccount(failure.candidate.id)).rejects.toThrow('加密配置保存失败'); expect(failure.manager.listAccounts()).toEqual([]); failure.manager.dispose();
    const network = await service(() => { throw new Error(TOKEN); });
    const error = await network.manager.importClientAccount(network.candidate.id).catch(error => error as Error);
    expect(String(error)).toContain('网络请求失败'); expect(String(error)).not.toContain(TOKEN); expect(network.manager.listAccounts()).toEqual([]); network.manager.dispose();
  });
});

describe.skipIf(process.platform !== 'linux')('Linux exact keyring read helper without a real keyring', () => {
  it.each(['none', 'locked', 'duplicate'])('performs only the selected service/account search: %s', async mode => {
    const prelude = `import sys,types\nmodule=types.ModuleType('secretstorage')\nmodule.dbus_init=lambda: None\nutil=types.ModuleType('secretstorage.util')\nclass DBusAddressWrapper:\n def __init__(self,path,interface,connection):\n  assert path=='/org/freedesktop/secrets'\n def call(self,method,signature,attrs):\n  assert method=='SearchItems' and signature=='a{ss}' and attrs=={'service':'copilot-cli','username':'https://github.com:fixture-user'}\n  return ${mode === 'locked' ? "([],['locked'])" : mode === 'duplicate' ? "(['a','b'],[])" : '([],[])'}\nutil.DBusAddressWrapper=DBusAddressWrapper\nutil.open_session=lambda *args: (_ for _ in ()).throw(Exception('must not read secrets'))\nsys.modules['secretstorage']=module\nsys.modules['secretstorage.util']=util\n`;
    const result = await new Promise<string>((resolve, reject) => {
      const child = execFile('/usr/bin/python3', ['-c', prelude + linuxCopilotImportHelper], { timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(stdout)); child.stdin?.end('https://github.com:fixture-user');
    });
    expect(JSON.parse(result)).toEqual(mode === 'none' ? { ok: true } : { ok: false, code: mode === 'locked' ? 'locked' : 'ambiguous' });
  });
});
