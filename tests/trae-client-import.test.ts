import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { decryptTraeAuthValue, TraeClientImporter, TraeClientImportError, type TraeClientImportOptions } from '../src/main/trae-client-import';
import { postTraeRelayAccount, type TraeImportRequest } from '../src/main/trae-relay-import';

// Synthetic credentials; ciphertext generated with pinned upstream Python, not this implementation.
const GOLDEN = {"source": "Trae2api-cn v1.0.10 src/trae_decrypt.py", "auth": {"token": "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE4OTM0NTYwMDAsInVzZXJfaWQiOiJmaXh0dXJlLXVzZXIifQ.synthetic_signature", "refreshToken": "synthetic_refresh_only", "userId": "fixture-user", "host": "https://api.trae.cn", "expiredAt": "2030-01-01T00:00:00.000Z", "clientID": "fixture-client", "account": {"username": "Fixture User"}, "userRegion": {"region": "China-North", "_aiRegion": "China-North"}}, "encrypted": {"AES": "dGMFEAAAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh/DBQBngA8oKbl67NEcbtW+54bKqJm1FZEBST0/E/eA5BvzvxGC3lQXH04aE2342Bxi/MTugwxSSdvnHiPGR52+97Pud9DhV/iNUvGrMWHeGqH25hNNSTygZgF/h9wryWhzJ7Fi4KhgPfVSU+WP8zMQmN4kkUd8eOjFvLHQ4Iq0RRIKSasSiLx14Uo8/2bFCy1jlJPUyC2smFdoTUcMaAvws3pxIrtdn9EKrU7URMiAy++smdrzaxQV+0+OmSd9ARID0u4QO5VnDpM371OLsMRGnyuTi6HR32OzqyKVM1O7s+R9c3V+IMQCqBaPJdyHUuWpZb8LQ+lWD8WL6ORC0y3cPB/Bvld1ikYq2BBIKME572VxSCisnpM7VyqCo72wHFVxjuhskz4uBHbUQxQ4+cRe7u62M1gE+lsP/ea2mUm+A1x3cHhbXZGyAqZ2pGAevKVgSsT14DNzM0fdqI7KiyRmDYgxCC34FH4edZYy+DlHIiZDEueTnR7qDh2FDkX28b2y1LMfL9Zc+7TuCdbqK3kXItp6nTd2JwSTdkb+KoysVhI8mjFTRvW9rA6ktHJWZsvKVmTBWwty9USBxfC26TNK", "AES_PRIVATE": "EjkgIAIDAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh+d34i4oaIjOR9H/bzyXWqzaJBhEcQ0ebPtjVo0hgVhfowEegmUvl+f66Ec/r2MNm4l61KPxoGmHqCmfs4iH/X7mCmY/nkNYES/PQFQBL0I2QQxmp7BcC528CLGgDc6DIhnwXipjAtIb100YTn79KIUU6Oz360KElkaiAWgv83Gh2FiP6MhRJdn1LZL4gc8a3Bn8HFtC5JjN0wlrDv+sWoC53fpe91YRpmHhdc9qYYrNoK33AuIPKaHQyM8nmY7RSKdGBwEzd5XGXfX0ObD1W+xzYLwOdNXWIs00bl7m9vImltkU6QeQawIVJ5BP1wVbSgQsJjJjVFBJzkbPgJJ8IAw+JO1ojpTJeXAxVLnRsK5sFs4/W0j3DUAiumFoUQmHNwgTGYOlnV4z/gqSkeCTBUtmPqvDER6Q2ZiBjQPOHdS9KeuX6SLBjYvj/8LksOfRdwvR9I5rfo2YB54cllb+G7kLbeTb7yVtzeRIg8+n8IgK2SaJODVi8rafD0vfpbprN125I6rNn4CpC8EPYb21ID54Z/Z0Iq5y/wxEM9KilEbJJZZNVHfhmTGYsnU7gvNCeoI7LCP7QiOVf3vAU5RSyet"}};
const NOW = Date.parse('2026-11-05T08:00:00.000Z');
const temps: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(options: Partial<TraeClientImportOptions> = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'modeldock-trae-client-import-')); temps.push(homeDir);
  const root = options.platform === 'win32' ? join(homeDir, 'AppData', 'Roaming') : join(homeDir, '.config');
  const filename = join(root, 'Trae CN', 'User/globalStorage/storage.json');
  await mkdir(join(root, 'Trae CN/User/globalStorage'), { recursive: true });
  const settings = { homeDir, platform: 'linux' as NodeJS.Platform, env: {}, now: () => NOW, ...options };
  return { homeDir, root, filename, importer: new TraeClientImporter(settings), settings,
    write: (value: unknown) => writeFile(filename, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': value, unrelated: 'must remain unchanged', modelsCache: { unrelated: true } })),
  };
}

describe('TRAE CN exact storage.json credential reader', () => {
  it.each(['AES', 'AES_PRIVATE'] as const)('decrypts an independently generated pinned-upstream %s fixture', kind => {
    expect(decryptTraeAuthValue(GOLDEN.encrypted[kind])).toEqual(GOLDEN.auth);
  });
  it('rejects unrecognized headers, truncated ciphertext, noncanonical base64, wrong integrity and malformed JSON without secret errors', () => {
    const badHeader = Buffer.from(GOLDEN.encrypted.AES, 'base64'); badHeader[0] ^= 1;
    const tampered = Buffer.from(GOLDEN.encrypted.AES, 'base64'); tampered[tampered.length - 40] ^= 2;
    for (const value of [undefined, {}, '{' + GOLDEN.auth.token, GOLDEN.encrypted.AES + '\n', GOLDEN.encrypted.AES.slice(0, 40), badHeader.toString('base64'), tampered.toString('base64')]) {
      const error = (() => { try { decryptTraeAuthValue(value); } catch (error) { return error; } })();
      expect(error).toBeInstanceOf(TraeClientImportError); expect(String(error)).not.toContain(GOLDEN.auth.token);
    }
  });
  it('does no client work at construction, lists only safe account metadata and preserves all original bytes', async () => {
    const f = await fixture(); expect(await f.importer.listCandidates()).toEqual([]);
    await f.write(GOLDEN.encrypted.AES); const before = await readFile(f.filename);
    const candidates = await f.importer.listCandidates();
    expect(candidates).toEqual([{ id: 'trae-cn', label: 'TRAE 中国版 · Fixture User', displayName: 'Fixture User', accountId: 'fixture-user', expiresAt: Date.parse('2030-01-01T00:00:00Z'), expired: false }]);
    expect(JSON.stringify(candidates)).not.toMatch(/synthetic_refresh|synthetic_signature|token|clientID|modelsCache|storage\.json/i);
    expect(await readFile(f.filename)).toEqual(before);
  });
  it('reads only the verified auth slot and never accepts guessed SQLite/cache credentials', async () => {
    const f = await fixture(); await writeFile(f.filename, JSON.stringify({ token: GOLDEN.auth.token, stateVscdb: GOLDEN.auth, customModels: [GOLDEN.auth] }));
    await writeFile(join(f.root, 'Trae CN/User/globalStorage/state.vscdb'), GOLDEN.auth.token);
    expect(await f.importer.listCandidates()).toEqual([]);
    await expect(f.importer.readCredentials('trae-cn')).rejects.toThrow('尚未保存可导入');
    await f.write(GOLDEN.encrypted.AES);
    const credentials = await f.importer.readCredentials('trae-cn');
    expect(credentials).toMatchObject({ token: GOLDEN.auth.token, refreshToken: 'synthetic_refresh_only', userId: 'fixture-user', host: 'https://api.trae.cn', clientId: 'fixture-client', region: 'China-North', aiRegion: 'China-North', userRegion: 'China-North' });
    expect(await readFile(join(f.root, 'Trae CN/User/globalStorage/state.vscdb'), 'utf8')).toBe(GOLDEN.auth.token);
  });
  it('supports native Windows APPDATA paths and only CN / SOLO CN editions', async () => {
    const f = await fixture({ platform: 'win32' }); await f.write(GOLDEN.encrypted.AES_PRIVATE);
    const solo = join(f.root, 'TRAE SOLO CN/User/globalStorage/storage.json'); await mkdir(join(f.root, 'TRAE SOLO CN/User/globalStorage'), { recursive: true });
    await writeFile(solo, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify({ ...GOLDEN.auth, userId: 'fixture-solo' }) }));
    await mkdir(join(f.root, 'Trae/User/globalStorage'), { recursive: true }); await writeFile(join(f.root, 'Trae/User/globalStorage/storage.json'), GOLDEN.auth.token);
    expect((await f.importer.listCandidates()).map(value => [value.id, value.accountId])).toEqual([['trae-cn', 'fixture-user'], ['trae-solo-cn', 'fixture-solo']]);
    await expect(f.importer.readCredentials('trae-sg')).rejects.toThrow('请选择已列出');
    await expect(new TraeClientImporter({ ...f.settings, platform: 'darwin' }).listCandidates()).rejects.toThrow('路径尚未核实');
  });
  it('honors an explicitly configured XDG config directory without scanning other roots', async () => {
    const f = await fixture(); await f.write(GOLDEN.encrypted.AES);
    const different = new TraeClientImporter({ ...f.settings, env: { XDG_CONFIG_HOME: join(f.homeDir, 'empty-config') } });
    expect(await different.listCandidates()).toEqual([]);
    await expect(new TraeClientImporter({ ...f.settings, env: { XDG_CONFIG_HOME: '../relative' } }).listCandidates()).rejects.toThrow('格式无法识别');
  });
  it('lists expired accounts as expired but refuses to send an expired access credential or refresh the source', async () => {
    const f = await fixture(); await f.write(JSON.stringify({ ...GOLDEN.auth, expiredAt: '2020-01-01T00:00:00Z', refreshExpiredAt: '2030-01-01T00:00:00Z' }));
    const before = await readFile(f.filename); expect((await f.importer.listCandidates())[0].expired).toBe(true);
    await expect(f.importer.readCredentials('trae-cn')).rejects.toThrow('访问凭据已过期'); expect(await readFile(f.filename)).toEqual(before);
  });
  it('does not let empty or later native expiry fields hide an expired JWT', async () => {
    const f = await fixture();
    const expiredToken = GOLDEN.auth.token.split('.'); expiredToken[1] = Buffer.from(JSON.stringify({ exp: 1577836800 })).toString('base64url');
    for (const expiredAt of ['', GOLDEN.auth.expiredAt]) {
      await f.write(JSON.stringify({ ...GOLDEN.auth, token: expiredToken.join('.'), expiredAt }));
      expect((await f.importer.listCandidates())[0].expired).toBe(true);
      await expect(f.importer.readCredentials('trae-cn')).rejects.toThrow('访问凭据已过期');
    }
  });
  it('rejects absent account IDs instead of using a credential prefix as a public account identifier', async () => {
    const f = await fixture(); await f.write(JSON.stringify({ ...GOLDEN.auth, userId: undefined }));
    await expect(f.importer.listCandidates()).rejects.toThrow('尚未保存可导入');
  });
  it('rejects international or arbitrary hosts, malformed expiry, oversized files and path-like candidate IDs', async () => {
    const f = await fixture();
    for (const value of [{ ...GOLDEN.auth, host: 'https://evil.invalid' }, { ...GOLDEN.auth, host: 'https://core-normal.trae.ai' }, { ...GOLDEN.auth, expiredAt: 'unknown' }]) {
      await f.write(JSON.stringify(value)); await expect(f.importer.readCredentials('trae-cn')).rejects.toThrow('格式无法识别');
    }
    await writeFile(f.filename, 'x'.repeat(4 * 1024 * 1024 + 1)); await expect(f.importer.listCandidates()).rejects.toThrow('无法安全读取');
    await expect(f.importer.readCredentials('../../foreign')).rejects.toThrow('请选择已列出');
  });
  it('rejects symlinked client files when native file symlinks are permitted', async ({ skip }) => {
    const f = await fixture(), foreign = join(f.homeDir, 'foreign');
    const original = JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': GOLDEN.encrypted.AES });
    await writeFile(foreign, original);
    try { await symlink(foreign, f.filename, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') skip('Windows account cannot create file symlinks without Developer Mode or elevation.');
      throw error;
    }
    await expect(f.importer.listCandidates()).rejects.toThrow('无法安全读取');
    expect(await readFile(foreign, 'utf8')).toBe(original);
  });
});

function transport(options: { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean; fail?: boolean } = {}) {
  const calls: { options: RequestOptions; body?: string }[] = [];
  const send: TraeImportRequest = (requestOptions, callback) => {
    const captured = { options: requestOptions, body: undefined as string | undefined }; calls.push(captured);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => { queueMicrotask(() => req.emit('error', new Error(GOLDEN.auth.token))); return req; }) as ClientRequest['destroy'];
    req.end = ((body: Buffer) => {
      captured.body = body.toString();
      queueMicrotask(() => {
        if (options.fail) { req.emit('error', new Error(GOLDEN.auth.token)); return; }
        if (options.hang) return;
        const stream = new PassThrough(), response = stream as unknown as IncomingMessage;
        response.statusCode = options.status ?? 200; response.headers = options.headers ?? { 'content-type': 'application/json' };
        callback(response); stream.end(options.body ?? JSON.stringify({ success: true, has_token: true, user_id: 'fixture-user' }));
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { send, calls };
}
async function account() { const f = await fixture(); await f.write(GOLDEN.encrypted.AES); return f.importer.readCredentials('trae-cn'); }
describe('owned relay native account-import transport boundary', () => {
  it('uses one authenticated literal loopback POST without proxying or exposing account credentials in the result', async () => {
    const native = transport(), credentials = await account(), key = 'a'.repeat(64);
    const result = await postTraeRelayAccount(key, { ...credentials, unexpected: 'private extra property' } as typeof credentials, native.send);
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0].options).toMatchObject({ hostname: '127.0.0.1', port: 18080, path: '/api/web-auth', method: 'POST', agent: false, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    expect(JSON.parse(native.calls[0].body!)).toMatchObject({ token: GOLDEN.auth.token, refreshToken: 'synthetic_refresh_only', userId: 'fixture-user', host: 'https://api.trae.cn' });
    expect(native.calls[0].body).not.toContain('private extra property');
    expect(result).toMatchObject({ imported: true, accountId: 'fixture-user', upstreamVerified: false });
    expect(JSON.stringify(result)).not.toMatch(/synthetic_refresh|synthetic_signature|a{64}/); expect(result.message).toContain('尚未验证');
  });
  it.each([301, 302, 307, 308])('does not follow HTTP %s redirects with account credentials', async status => {
    const native = transport({ status, headers: { location: 'https://evil.invalid/' }, body: GOLDEN.auth.token });
    await expect(postTraeRelayAccount('a'.repeat(64), await account(), native.send)).rejects.toThrow('重定向'); expect(native.calls).toHaveLength(1);
  });
  it.each([401, 403, 500])('does not expose HTTP %s error bodies', async status => {
    const native = transport({ status, body: GOLDEN.auth.token });
    const error = await postTraeRelayAccount('a'.repeat(64), await account(), native.send).catch(error => error as Error);
    expect(String(error)).toContain(`HTTP ${status}`); expect(String(error)).not.toContain(GOLDEN.auth.token);
  });
  it.each(['malformed', 'failure', 'missing-token', 'wrong-account', 'oversized'])('rejects unconfirmed native import responses: %s', async kind => {
    const body = kind === 'malformed' ? '{' + GOLDEN.auth.token : kind === 'failure' ? JSON.stringify({ success: false, error: GOLDEN.auth.token })
      : kind === 'missing-token' ? JSON.stringify({ success: true, user_id: 'fixture-user' }) : kind === 'wrong-account' ? JSON.stringify({ success: true, has_token: true, user_id: 'another-user' }) : GOLDEN.auth.token.repeat(5000);
    const native = transport({ body });
    const error = await postTraeRelayAccount('a'.repeat(64), await account(), native.send).catch(error => error as Error);
    expect(error).toBeInstanceOf(TraeClientImportError); expect(String(error)).not.toContain(GOLDEN.auth.token);
  });
  it('bounds the deadline and redacts transport failures', async () => {
    const credentials = await account(); vi.useFakeTimers();
    const pending = postTraeRelayAccount('a'.repeat(64), credentials, transport({ hang: true }).send).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(15000); expect(String(await pending)).toContain('超时');
    const failed = await postTraeRelayAccount('a'.repeat(64), credentials, transport({ fail: true }).send).catch(error => error as Error);
    expect(String(failed)).not.toContain(GOLDEN.auth.token);
  });
  it('rejects invalid keys and identity/host parameters before any network action', async () => {
    const native = transport(), credentials = await account();
    for (const value of [{ key: 'invalid', credentials }, { key: 'a'.repeat(64), credentials: { ...credentials, host: 'https://evil.invalid' } }, { key: 'a'.repeat(64), credentials: { ...credentials, userId: '' } }]) {
      await expect(postTraeRelayAccount(value.key, value.credentials as typeof credentials, native.send)).rejects.toThrow('参数无效');
    }
    expect(native.calls).toHaveLength(0);
  });
});
