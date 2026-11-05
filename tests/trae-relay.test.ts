import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TRAE_RELAY_BASE_URL, TRAE_RELAY_IMAGE, TRAE_RELAY_LOGIN_URL, TraeRelayManager } from '../src/main/trae-relay';
import type { TraeClientCredentials } from '../src/main/trae-client-import';

const key = 'a'.repeat(64);
const containerId = 'b'.repeat(64);
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

async function fixture(prefix = 'modeldock-relay-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  const state = { id: '', owner: '', running: false, host: '127.0.0.1', image: TRAE_RELAY_IMAGE, os: 'linux', rootless: false,
    system: 'Docker Desktop', kernel: release(), network: 'bridge', hostStartup: true, listener: 'owned' };
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'info') return JSON.stringify({ os: state.os, system: state.system, kernel: state.kernel,
      security: state.rootless ? ['name=rootless'] : [] });
    switch (args[1]) {
      case 'ls': return state.id;
      case 'inspect':
        expect(args.at(-1)).toBe(state.id);
        return JSON.stringify({ owner: state.owner, image: state.image, running: state.running,
          network: state.network, hostStartup: state.hostStartup,
          ports: state.network === 'host' ? null : { '8000/tcp': [{ HostIp: state.host, HostPort: '18080' }] } });
      case 'create':
        state.owner = args[args.indexOf('--label') + 1].split('=')[1];
        state.network = args[args.indexOf('--network') + 1];
        state.id = containerId;
        return containerId;
      case 'exec': return state.listener;
      case 'start': state.running = true; return containerId;
      case 'stop': state.running = false; return containerId;
      default: throw Error('unexpected docker command');
    }
  });
  const io = { docker, health: vi.fn(async () => true), portAvailable: vi.fn(async () => true), wait: async () => {},
    importAccount: vi.fn(async (_apiKey: string, credentials: TraeClientCredentials) => ({ imported: true as const, accountId: credentials.userId, upstreamVerified: false as const, message: 'fixture imported without upstream validation' })),
    queryUsage: vi.fn(async (_apiKey: string) => ({ accountId: 'currently-active', usage: { status: 'ready' as const, windows: [{ id: 'fixture-credits', label: '通用积分', total: 100, remaining: 75, unit: '积分' }], message: 'fixture official balance' } })),
  };
  const root = join(dir, 'trae-cn-relay');
  const manager = new TraeRelayManager(dir, io);
  return { dir, root, manager, state, io, calls: () => docker.mock.calls.map(([args]) => args) };
}

describe('managed TRAE CN relay', () => {
  it('queries quota only after proving a running owned relay and does not implicitly start or use an imported account ID', async () => {
    const { manager, io, calls, state } = await fixture();
    await expect(manager.queryUsage(key)).rejects.toThrow('只支持'); expect(io.queryUsage).not.toHaveBeenCalled();
    expect(calls().some(args => args[1] === 'create' || args[1] === 'start')).toBe(false);
    await manager.start(key); await expect(manager.queryUsage('z'.repeat(64))).rejects.toThrow('只支持');
    const owner = state.owner; state.owner = 'foreign-owner'; await expect(manager.queryUsage(key)).rejects.toThrow('不属于'); state.owner = owner;
    io.health.mockResolvedValue(false); await expect(manager.queryUsage(key)).rejects.toThrow('healthz'); io.health.mockResolvedValue(true);
    expect(io.queryUsage).not.toHaveBeenCalled(); expect(await manager.queryUsage(key)).toMatchObject({ accountId: 'currently-active', usage: { status: 'ready' } });
    expect(io.queryUsage).toHaveBeenCalledExactlyOnceWith(key);
    await manager.stop(); await expect(manager.queryUsage(key)).rejects.toThrow('先启动');
  });

  it('serializes quota reads against stop, redacts arbitrary failures and keeps its queue usable', async () => {
    const { manager, io, calls } = await fixture(); await manager.start(key);
    let release!: (result: Awaited<ReturnType<typeof io.queryUsage>>) => void;
    io.queryUsage.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = manager.queryUsage(key); await vi.waitFor(() => expect(io.queryUsage).toHaveBeenCalledTimes(1));
    const stopped = manager.stop(); expect(calls().some(args => args[1] === 'stop')).toBe(false);
    release({ accountId: 'current-account', usage: { status: 'ready', windows: [], message: 'fixture' } }); await pending; await stopped;
    await manager.start(key); io.queryUsage.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_QUOTA_TOKEN'));
    const error = await manager.queryUsage(key).catch(error => error as Error); expect(String(error)).not.toContain('SYNTHETIC_PRIVATE');
    expect((await manager.stop()).state).toBe('stopped');
  });

  it('never imports into an absent, stopped or different-key relay and does not start one implicitly', async () => {
    const { manager, io, calls } = await fixture();
    const credentials: TraeClientCredentials = { token: 'synthetic.private.access', userId: 'fixture-user', host: 'https://api.trae.cn' };
    await expect(manager.importAccount(key, credentials)).rejects.toThrow('先启动');
    expect(calls().some(args => args[1] === 'create' || args[1] === 'start')).toBe(false);
    await manager.start(key);
    await expect(manager.importAccount('z'.repeat(64), credentials)).rejects.toThrow('匹配');
    await manager.stop();
    await expect(manager.importAccount(key, credentials)).rejects.toThrow('先启动');
    expect(io.importAccount).not.toHaveBeenCalled();
  });

  it('checks the exact managed container and health before authenticated account import', async () => {
    const { manager, io, state, calls } = await fixture(); await manager.start(key);
    const credentials: TraeClientCredentials = { token: 'synthetic.private.access', refreshToken: 'synthetic.private.refresh', userId: 'fixture-user', host: 'https://api.trae.cn' };
    const owner = state.owner; state.owner = 'foreign-owner';
    await expect(manager.importAccount(key, credentials)).rejects.toThrow('不属于');
    state.owner = owner; io.health.mockResolvedValue(false);
    await expect(manager.importAccount(key, credentials)).rejects.toThrow('healthz');
    expect(io.importAccount).not.toHaveBeenCalled(); io.health.mockResolvedValue(true);
    expect(await manager.importAccount(key, credentials)).toMatchObject({ imported: true, accountId: 'fixture-user', upstreamVerified: false });
    expect(io.importAccount).toHaveBeenCalledExactlyOnceWith(key, credentials);
    expect(JSON.stringify(calls())).not.toMatch(/synthetic\.private|a{64}/);
  });

  it('serializes an in-progress import against stop and redacts arbitrary import failures', async () => {
    const { manager, io, calls } = await fixture(); await manager.start(key);
    const credentials: TraeClientCredentials = { token: 'synthetic.private.access', userId: 'fixture-user', host: 'https://api.trae.cn' };
    let release!: (value: Awaited<ReturnType<typeof io.importAccount>>) => void;
    io.importAccount.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const imported = manager.importAccount(key, credentials);
    await vi.waitFor(() => expect(io.importAccount).toHaveBeenCalledTimes(1));
    const stopped = manager.stop(); expect(calls().filter(args => args[1] === 'stop')).toHaveLength(0);
    release({ imported: true, accountId: 'fixture-user', upstreamVerified: false, message: 'saved' });
    await imported; expect((await stopped).state).toBe('stopped');
    await manager.start(key); io.importAccount.mockRejectedValueOnce(new Error(credentials.token));
    const error = await manager.importAccount(key, credentials).catch(error => error as Error);
    expect(String(error)).toContain('导入失败'); expect(String(error)).not.toContain(credentials.token);
    expect((await manager.stop()).state).toBe('stopped');
  });

  it.skipIf(process.platform !== 'win32')('protects Windows login files with a private inherited ACL and preserves CSV bind-mount paths', async () => {
    const { root, manager, calls } = await fixture('modeldock 空格, relay-');
    expect((await manager.start(key)).state).toBe('running');
    const create = calls().find(args => args[1] === 'create')!;
    const mounts = create.flatMap((arg, index, args) => arg === '--mount' ? [args[index + 1]] : []);
    expect(mounts).toEqual([
      ...['.env', 'data'].map(name => `type=bind,"source=${join(root, name)}",target=/app/${name}`),
      `type=bind,"source=${join(root, 'api-key')}",target=/run/modeldock-relay-key,readonly`,
    ]);
    expect(create[create.indexOf('--user') + 1]).toBe('999:999');
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      '$paths = @($env:MODELDOC_TEST_ROOT, (Join-Path $env:MODELDOC_TEST_ROOT "api-key"), (Join-Path $env:MODELDOC_TEST_ROOT ".env"), (Join-Path $env:MODELDOC_TEST_ROOT "data"))',
      '$result = foreach ($path in $paths) {',
      '  $acl = [IO.File]::GetAccessControl($path)',
      '  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
      '  if ($rules.Count -ne 2 -or @($rules | Where-Object { $_.IdentityReference.Value -notin @($sid, "S-1-5-18") -or $_.AccessControlType -ne "Allow" -or $_.FileSystemRights -ne "FullControl" }).Count) { throw "Unexpected relay ACL" }',
      '  [PSCustomObject]@{ protected = $acl.AreAccessRulesProtected; inherited = @($rules | Where-Object IsInherited).Count }',
      '}',
      'ConvertTo-Json -Compress -InputObject @($result)',
    ].join('\n');
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, env: { ...process.env, MODELDOC_TEST_ROOT: root },
    });
    expect(JSON.parse(result.stdout)).toEqual([
      { protected: true, inherited: 0 },
      { protected: false, inherited: 2 },
      { protected: false, inherited: 2 },
      { protected: false, inherited: 2 },
    ]);
  }, 15000);

  it.skipIf(process.platform === 'win32')('overrides remote Docker contexts and hosts on the actual CLI boundary', async () => {
    const { dir } = await fixture();
    const executable = join(dir, 'docker');
    const trace = join(dir, 'observed');
    await writeFile(executable, [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$MODELDOC_TEST_TRACE"',
      'printf "%s" "$DOCKER_HOST$DOCKER_CONTEXT$DOCKER_TLS_VERIFY" >> "$MODELDOC_TEST_TRACE"',
    ].join('\n'), { mode: 0o700 });
    vi.stubEnv('PATH', dir);
    vi.stubEnv('MODELDOC_TEST_TRACE', trace);
    vi.stubEnv('DOCKER_CONTEXT', 'wrong-context');
    vi.stubEnv('DOCKER_HOST', 'tcp://remote.example:2375');
    vi.stubEnv('DOCKER_TLS_VERIFY', 'remote-tls');
    try {
      const manager = new TraeRelayManager(dir, { portAvailable: async () => true });
      expect((await manager.status()).state).toBe('stopped');
      const args = await readFile(trace, 'utf8');
      expect(args).toMatch(/^--host\nunix:\/\/\/[^\n]+\.sock\ncontainer\nls\n/);
      expect(args).not.toMatch(/wrong-context|remote\.example|remote-tls/);
    } finally { vi.unstubAllEnvs(); }
  });

  it('starts only on request, uses the fixed image, private mounts and loopback health, and preserves login across stop and restart', async () => {
    const { dir, root, manager, state, io, calls } = await fixture();
    expect((await manager.status()).state).toBe('stopped');
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls().map(a => a[1])).toEqual(['ls']);
    state.rootless = true;
    const statuses = await Promise.all([manager.start(key), manager.start(key)]);
    expect(statuses.map(s => s.state)).toEqual(['running', 'running']);
    expect(TRAE_RELAY_BASE_URL).toBe('http://127.0.0.1:18080/v1');
    expect(TRAE_RELAY_LOGIN_URL).toBe('http://127.0.0.1:18080/web/login');
    const creates = calls().filter(a => a[1] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('ghcr.io/autumnsentiment/trae2api-cn:1.0.10');
    expect(creates[0]).toContain('127.0.0.1:18080:8000/tcp');
    expect(creates[0]).toContain('TRAE_CLI_WORKDIR=/tmp/modeldock-trae-cli');
    expect(creates[0][creates[0].indexOf('--user') + 1]).toBe('0:0');
    const mounts = creates[0].flatMap((arg, i, args) => arg === '--mount' ? [args[i + 1]] : []);
    expect(mounts).toEqual([
      ...['.env', 'data'].map(name => `type=bind,"source=${join(root, name)}",target=/app/${name}`),
      `type=bind,"source=${join(root, 'api-key')}",target=/run/modeldock-relay-key,readonly`,
    ]);
    expect(creates[0]).not.toContain('--env-file');
    expect(JSON.stringify([statuses, calls()])).not.toContain(key);
    const env = await readFile(join(root, '.env'), 'utf8');
    expect(env).toContain('TRAE_AUTH_SOURCE=web-login\n');
    expect(env).toContain('TRAE_AUTO_CHECKIN=0\n');
    expect(env).not.toContain(key);
    expect(await readFile(join(root, 'api-key'), 'utf8')).toBe(key + '\n');
    if (process.platform !== 'win32') {
      for (const path of [root, join(root, '.env'), join(root, 'api-key'), join(root, 'data'), join(root, 'owner.json')]) {
        expect((await lstat(path)).mode & 0o077).toBe(0);
      }
    }
    await appendFile(join(root, '.env'), 'TRAE_TOKEN=fixture-only\n');
    await writeFile(join(root, 'data', 'accounts.json'), 'fixture account');
    expect((await manager.stop()).state).toBe('stopped');
    expect((await new TraeRelayManager(dir, io).start(key)).state).toBe('running');
    expect(calls().filter(a => a[1] === 'create')).toHaveLength(1);
    expect(calls().filter(a => a[1] === 'start' || a[1] === 'stop').every(a => a.at(-1) === containerId)).toBe(true);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(env + 'TRAE_TOKEN=fixture-only\n');
    expect(await readFile(join(root, 'data', 'accounts.json'), 'utf8')).toBe('fixture account');
    expect(JSON.stringify(calls())).not.toContain('fixture-only');
  });

  it('serializes overlapping start and stop, leaves the container and profile for an explicit restart', async () => {
    const { manager, calls } = await fixture();
    const result = await Promise.all([manager.start(key), manager.stop(), manager.status()]);
    expect(result.map(s => s.state)).toEqual(['running', 'stopped', 'stopped']);
    expect(calls().filter(a => ['start', 'stop', 'rm', 'create'].includes(a[1])).map(a => a[1])).toEqual(['create', 'start', 'stop']);
  });

  it.skipIf(process.platform !== 'linux')('binds native Linux directly and verifies the recorded ID, exact startup and PID 1 socket', async () => {
    const { manager, state, calls, root } = await fixture();
    state.system = 'Ubuntu';
    expect((await manager.start(key)).state).toBe('running');
    const create = calls().find(a => a[1] === 'create')!;
    expect(create).not.toContain('--publish');
    expect(create).toContain('PORT=18080');
    expect(create).toContain('HOST=127.0.0.1');
    expect(create.at(-1)).toMatch(/--host 127\.0\.0\.1 --port 18080$/);
    expect(JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')).hostId).toBe(containerId);
    expect(calls().filter(a => a[1] === 'exec')).toHaveLength(1);
    state.listener = 'unverified';
    expect((await manager.status()).state).toBe('unhealthy');
    state.hostStartup = false;
    expect((await manager.stop()).state).toBe('conflict');
    state.hostStartup = true;
    state.id = 'e'.repeat(64);
    expect((await manager.status()).state).toBe('conflict');
    expect((await manager.stop()).state).toBe('conflict');
    expect(calls().some(a => a[1] === 'stop')).toBe(false);
  });

  it('uses published loopback for Desktop, rootless or unverified kernel and refuses unexpected network replacements', async () => {
    for (const daemon of [{ system: 'Docker Desktop' }, { system: 'Ubuntu', rootless: true }, { system: 'Ubuntu', kernel: 'other' }]) {
      const { manager, state, calls } = await fixture();
      Object.assign(state, daemon);
      expect((await manager.start(key)).state).toBe('running');
      const create = calls().find(a => a[1] === 'create')!;
      expect(create).toContain('127.0.0.1:18080:8000/tcp');
      expect(create.at(-1)).toMatch(/--host 0\.0\.0\.0 --port 8000$/);
      state.network = 'host';
      expect((await manager.status()).state).toBe('conflict');
      state.network = 'external';
      expect((await manager.status()).state).toBe('conflict');
    }
  });

  it.skipIf(process.platform === 'win32')('exports the dedicated secret for the relay process, and fails closed if it is empty', async () => {
    const { dir, root, manager, calls } = await fixture();
    await manager.start(key);
    const create = calls().find(a => a[1] === 'create')!;
    const command = create.at(-1)!.replaceAll('/app/.env', '"$MOCK_ROOT/.env"')
      .replaceAll('/app/data', '"$MOCK_ROOT/data"').replaceAll('/run/modeldock-relay-key', '"$MOCK_ROOT/api-key"');
    const fakeServer = join(dir, 'uvicorn');
    await writeFile(fakeServer, [
      '#!/bin/sh',
      '[ "$RELAY_API_KEYS" = "$EXPECTED" ] && [ "$TRAE_AUTH_SOURCE" = "web-login" ] || exit 77',
      'printf started',
    ].join('\n'), { mode: 0o700 });
    const launch = () => promisify(execFile)('/bin/sh', ['-ec', command], {
      env: { MOCK_ROOT: root, EXPECTED: key, PATH: dir },
    });
    expect((await launch()).stdout).toBe('started');
    await writeFile(join(root, 'api-key'), '\n');
    await expect(launch()).rejects.toThrow();
    expect((await manager.start(key)).state).toBe('conflict');
  });

  it('checks the bound port and the owner before probing HTTP or mutating anything', async () => {
    const { root, manager, io, state, calls } = await fixture();
    io.portAvailable.mockResolvedValue(false);
    expect((await manager.start(key)).state).toBe('conflict');
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(io.health).not.toHaveBeenCalled();
    state.id = containerId;
    for (const result of [await manager.start(key), await manager.stop(), await manager.status()]) expect(result.state).toBe('conflict');
    expect(calls().every(a => a[1] === 'ls')).toBe(true);
  });

  it('refuses stale keys, replaced containers, and changed port bindings', async () => {
    const { root, manager, io, state, calls } = await fixture();
    await manager.start(key);
    await manager.stop();
    const env = await readFile(join(root, '.env'), 'utf8');
    io.health.mockClear();
    expect((await manager.start('c'.repeat(64))).state).toBe('conflict');
    state.running = true;
    state.host = '0.0.0.0';
    expect((await manager.status()).state).toBe('conflict');
    expect((await manager.stop()).state).toBe('conflict');
    state.host = '127.0.0.1'; state.owner = 'not-this-profile';
    expect((await manager.start(key)).state).toBe('conflict');
    expect((await manager.stop()).state).toBe('conflict');
    expect(io.health).not.toHaveBeenCalled();
    expect(calls().filter(a => a[1] === 'stop')).toHaveLength(1);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(env);
  });

  it('preserves foreign files and rejects unsafe directories and symlinks', async () => {
    const { root, manager, io } = await fixture();
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, '.env'), 'FOREIGN_CONFIGURATION');
    expect((await manager.start(key)).state).toBe('conflict');
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FOREIGN_CONFIGURATION');
    expect(io.docker).not.toHaveBeenCalled();
    if (process.platform !== 'win32') {
      const second = await fixture();
      await symlink(root, second.root, 'dir');
      expect((await second.manager.start(key)).state).toBe('conflict');
      expect(await readFile(join(root, '.env'), 'utf8')).toBe('FOREIGN_CONFIGURATION');
      const third = await fixture();
      await third.manager.start(key);
      await chmod(join(third.root, '.env'), 0o644);
      expect((await third.manager.start(key)).state).toBe('conflict');
    }
  });

  it('does not report ready on HTTP failure or if the container disappears during a successful probe', async () => {
    const { manager, io, state } = await fixture();
    io.health.mockResolvedValue(false);
    expect((await manager.start(key)).state).toBe('unhealthy');
    expect((await manager.status()).state).toBe('unhealthy');
    io.health.mockImplementation(async () => { state.id = ''; return true; });
    expect((await manager.status()).state).toBe('unhealthy');
  });

  it('stops waiting as soon as the container exits during startup', async () => {
    const { manager, io, state } = await fixture();
    io.health.mockImplementation(async () => { state.running = false; return false; });
    expect((await manager.start(key)).state).toBe('unhealthy');
    expect(io.health).toHaveBeenCalledTimes(1);
  });

  it('does not disclose Docker diagnostics or accept multiline credentials', async () => {
    const { manager, io, root } = await fixture();
    expect((await manager.start(key + '\nTRAE_TOKEN=unexpected')).state).toBe('conflict');
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    io.docker.mockRejectedValue(Error('irrelevant-private-value ' + key));
    const result = await manager.start(key);
    expect(result.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toMatch(/irrelevant-private-value|a{64}/);
  });

  it('keeps a failed create retriable using the same profile, and rejects Windows-container engines', async () => {
    const { manager, root, state, calls } = await fixture();
    state.os = 'windows';
    expect((await manager.start(key)).state).toBe('unavailable');
    const marker = await readFile(join(root, 'owner.json'), 'utf8');
    expect(calls().some(a => a[1] === 'create')).toBe(false);
    state.os = 'linux';
    expect((await manager.start(key)).state).toBe('running');
    expect(await readFile(join(root, 'owner.json'), 'utf8')).toBe(marker);
  });
});
