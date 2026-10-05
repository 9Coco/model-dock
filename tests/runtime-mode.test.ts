import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRuntimeConfig, SMOKE_PROFILE_MARKER, verifySmokeProfile } from '../src/main/runtime-mode';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const output = mkdtempSync(join(tmpdir(), 'modeldock-runtime-')); directories.push(output);
  const data = join(output, 'data', randomUUID()); mkdirSync(data, { recursive: true });
  const values = { 'modeldock.sqlite': Buffer.from('synthetic fixture database only'), 'vault.key': randomBytes(32) };
  for (const [name, value] of Object.entries(values)) writeFileSync(join(data, name), value);
  const nonce = randomBytes(32).toString('hex'), now = Date.parse('2026-10-07T00:00:00Z'), parentPid = 321;
  const marker = { version: 1, fixture: 'modeldock-provider-duplicates-v1', nonce, runnerPid: parentPid, createdAt: new Date(now).toISOString(), outputDir: output, dataDir: data,
    files: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { size: value.length, sha256: createHash('sha256').update(value).digest('hex') }])) };
  const path = join(data, SMOKE_PROFILE_MARKER); writeFileSync(path, JSON.stringify(marker));
  const env: Record<string, string | undefined> = { MODELDOCK_SMOKE: output, MODELDOCK_DATA_DIR: data, MODELDOCK_SMOKE_NONCE: nonce };
  return { output, data, marker, path, env, options: { parentPid, now }, put: () => writeFileSync(path, JSON.stringify(marker)) };
}

describe('compile-time runtime modes and fresh smoke profiles', () => {
  it('production scrubs every mock/development flag while retaining a normal explicit profile', () => {
    const profile = resolve(tmpdir(), 'normal-explicit-modeldock-profile');
    const env = { MODELDOCK_DATA_DIR: profile, MODELDOCK_DEV_URL: 'http://127.0.0.1:9000/foreign', MODELDOCK_SMOKE: '1', MODELDOCK_SMOKE_AUTH_MOCK: '1', MODELDOCK_SMOKE_COMPACT_ONLY: '1', MODELDOCK_SMOKE_NONCE: 'private-test-nonce' };
    expect(resolveRuntimeConfig('production', env)).toEqual({ mode: 'production', dataDir: profile });
    expect(env).toEqual({ MODELDOCK_DATA_DIR: profile });
  });
  it('only the development build accepts an explicit loopback renderer', () => {
    const env = { MODELDOCK_DEV_URL: 'http://127.0.0.1:5178', MODELDOCK_SMOKE: '/ignored', MODELDOCK_SMOKE_AUTH_MOCK: '1' };
    expect(resolveRuntimeConfig('development', env)).toEqual({ mode: 'development', dataDir: undefined, devUrl: 'http://127.0.0.1:5178/' });
    expect(Object.keys(env)).toEqual(['MODELDOCK_DEV_URL']);
    for (const url of ['https://127.0.0.1:5178', 'http://localhost:5178', 'http://example.test/', 'http://user:password@127.0.0.1/', 'http://127.0.0.1/?x=1']) expect(() => resolveRuntimeConfig('development', { MODELDOCK_DEV_URL: url })).toThrow();
    expect(() => resolveRuntimeConfig('development', {})).toThrow();
  });
  it('accepts only the driver nonce, parent PID, canonical child and unchanged known fixture files', () => {
    const f = fixture(); f.env.MODELDOCK_DEV_URL = 'http://127.0.0.1:9000/';
    expect(resolveRuntimeConfig('smoke', f.env, f.options)).toMatchObject({ mode: 'smoke', dataDir: f.data, smoke: { outputDir: f.output, dataDir: f.data } });
    expect(f.env.MODELDOCK_DEV_URL).toBeUndefined();
    expect(readFileSync(join(f.data, 'modeldock.sqlite')).toString()).toBe('synthetic fixture database only');
  });
  it('rejects a normal existing profile before requiring any database bytes', () => {
    const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'modeldock-existing-')); directories.push(outside);
    writeFileSync(join(outside, 'modeldock.sqlite'), 'never open this existing profile');
    expect(() => verifySmokeProfile({ ...f.env, MODELDOCK_DATA_DIR: outside }, f.options)).toThrow(/隔离/);
    expect(readFileSync(join(outside, 'modeldock.sqlite'), 'utf8')).toBe('never open this existing profile');
  });
  it.each(['nonce', 'parent', 'stale', 'extra', 'changed', 'marker-path', 'dot-path'])('rejects %s without mutating the fixture database', kind => {
    const f = fixture();
    if (kind === 'nonce') f.env.MODELDOCK_SMOKE_NONCE = '0'.repeat(64);
    if (kind === 'parent') f.marker.runnerPid++;
    if (kind === 'stale') f.marker.createdAt = new Date(f.options.now - 31 * 60_000).toISOString();
    if (kind === 'extra') writeFileSync(join(f.data, 'unrelated-user-file'), 'existing browser profile');
    if (kind === 'changed') writeFileSync(join(f.data, 'modeldock.sqlite'), 'changed database contents');
    if (kind === 'marker-path') f.marker.dataDir = f.output;
    if (kind === 'dot-path') f.env.MODELDOCK_DATA_DIR = join(f.output, 'data') + '/placeholder/../' + f.data.split(/[\\/]/).pop();
    f.put(); const before = readFileSync(join(f.data, 'modeldock.sqlite'));
    expect(() => verifySmokeProfile(f.env, f.options)).toThrow(/隔离/);
    expect(readFileSync(join(f.data, 'modeldock.sqlite'))).toEqual(before);
  });
  it('rejects linked profile parents including Windows junctions', () => {
    const f = fixture(), link = join(f.output, 'linked');
    symlinkSync(join(f.output, 'data'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => verifySmokeProfile({ ...f.env, MODELDOCK_DATA_DIR: join(link, f.data.split(/[\\/]/).pop()!) }, f.options)).toThrow();
  });
  it.skipIf(process.platform === 'win32')('rejects linked marker files without reading their contents', () => {
    const f = fixture();
    const originalMarker = join(f.output, 'copy-marker.json'); writeFileSync(originalMarker, JSON.stringify(f.marker));
    rmSync(f.path); symlinkSync(originalMarker, f.path, 'file');
    expect(() => verifySmokeProfile(f.env, f.options)).toThrow();
  });
  it.each([SMOKE_PROFILE_MARKER, 'modeldock.sqlite', 'vault.key'])('rejects hardlinked %s even when its nonce and fingerprint match', name => {
    const f = fixture(), filename = join(f.data, name), alias = join(f.output, `hardlink-${name}`);
    const before = readFileSync(filename); linkSync(filename, alias);
    expect(() => verifySmokeProfile(f.env, f.options)).toThrow(/隔离/);
    expect(readFileSync(filename)).toEqual(before); expect(readFileSync(alias)).toEqual(before);
  });
  it('rejects invalid ordinary profile overrides without activating any test mode', () => {
    for (const value of ['', 'relative-profile', 'bad\0profile']) expect(() => resolveRuntimeConfig('production', { MODELDOCK_DATA_DIR: value, MODELDOCK_SMOKE: '1' })).toThrow();
    expect(() => resolveRuntimeConfig('unknown' as never, {})).toThrow();
  });
});
