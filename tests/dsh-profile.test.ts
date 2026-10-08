import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DshProfileError, resolveDshProfile, sanitizeDshBaselineProviders, validateDshProfileMetadata, type DshProfileMetadata } from '../src/main/dsh-profile';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temporary() { const path = mkdtempSync(join(tmpdir(), 'modeldock-dsh-profile-')); directories.push(path); return path; }
function file(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function profile(home: string, name = 'desktop') { file(join(home, 'profiles', name, 'package.json'), { name: `fixture-${name}`, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }); }
function anchor(root: string, version = '0.2.0-rc.2') { const path = join(root, '@deepseek-ai', 'dsh', 'package.json'); file(path, { name: '@deepseek-ai/dsh', version }); return path; }
const metadata = (): DshProfileMetadata => ({ version: 1, profileName: 'desktop', runtimeVersion: '0.2.0-rc.2',
  modelPlugins: [
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
    { id: 'nested-renamed-source', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
    { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
  ], baselineProviders: { old: { apiKeyEnv: 'OLD_API_KEY', api: 'openai-completions', baseURL: 'https://example.com/v1', models: [{ id: 'old-model', name: 'Old Model', input: ['text'] }], headers: null } } });

describe('DSH profile metadata boundary', () => {
  it('preserves named and nested source ids, lower models and credential refs without values', () => {
    expect(validateDshProfileMetadata(metadata())).toEqual(metadata());
  });
  it('rejects account authorization services from the model-only suppression list', () => {
    const value = metadata(); value.modelPlugins.push({ id: 'deepseek-account', name: '@deepseek-ai/dsh-deepseek-account-platform' });
    expect(() => validateDshProfileMetadata(value)).toThrow(DshProfileError);
  });
  it('rejects ambiguous duplicate ids rather than targeting another plugin', () => {
    const value = metadata(); value.modelPlugins.push({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-deepseek-account' });
    expect(() => validateDshProfileMetadata(value)).toThrow(DshProfileError);
  });
  it('rejects prototype-sensitive ids before they enter recovery dictionaries', () => {
    const value = metadata(); value.modelPlugins.push({ id: '__proto__', name: '@deepseek-ai/dsh-llm-deepseek-account' });
    expect(() => validateDshProfileMetadata(value)).toThrow(DshProfileError);
  });
  it('refuses missing canonical target and untrusted extra reply fields', () => {
    const value = metadata(); value.modelPlugins[0].id = 'renamed-pi-only';
    expect(() => validateDshProfileMetadata(value)).toThrow(DshProfileError);
    expect(() => validateDshProfileMetadata({ ...metadata(), credentials: {} })).toThrow(DshProfileError);
  });
  it.each([
    { apiKey: 'must-not-cross-boundary' },
    { headers: { Authorization: 'must-not-cross-boundary' } },
    { baseURL: 'https://account:credential@example.com/v1' },
    { baseURL: 'https://example.com/v1?api_key=credential' },
    { compat: { password: 'must-not-cross-boundary' } },
  ])('refuses secret or lossy baseline metadata %j', (config) => {
    expect(() => sanitizeDshBaselineProviders({ old: config })).toThrow(DshProfileError);
  });
  it('refuses executable expression objects and preserves safe null/default fields', () => {
    class Expression { source = 'not evaluated'; }
    expect(() => sanitizeDshBaselineProviders({ old: { baseURL: new Expression() } })).toThrow(DshProfileError);
    expect(sanitizeDshBaselineProviders({ old: { apiKeyEnv: null, models: null, compat: null, headers: {} } })).toEqual({ old: { apiKeyEnv: null, models: null, compat: null, headers: {} } });
  });
});

describe('read-only native profile resolver', () => {
  it.skipIf(process.platform === 'win32')('finds the PATH dsh link ahead of other nvm installations without executing it', async () => {
    const home = temporary(); profile(home);
    const selected = anchor(join(home, 'selected-runtime', 'lib', 'node_modules'));
    const bin = join(home, 'path-bin'); mkdirSync(bin);
    const entry = join(dirname(selected), 'entry.cjs'); writeFileSync(entry, "throw new Error('must never execute fixture binary');");
    symlinkSync(entry, join(bin, 'dsh'));
    anchor(join(home, '.nvm', 'versions', 'node', 'v99.0.0', 'lib', 'node_modules'));
    const calls: string[] = [];
    await resolveDshProfile(home, { platform: 'linux', homeDir: home, env: { PATH: bin }, runWorker: async request => { calls.push(request.installAnchor); return { ok: true, metadata: metadata() }; } });
    expect(calls).toEqual([selected]);
  });
  it('finds a custom NVM_BIN npm prefix even when the desktop PATH omits node', async () => {
    const home = temporary(); profile(home);
    const prefix = join(home, 'custom-nvm', 'versions', 'node', 'v25.9.0');
    const selected = anchor(join(prefix, 'lib', 'node_modules'));
    const calls: string[] = [];
    await resolveDshProfile(home, { platform: 'linux', homeDir: home, env: { PATH: '', NVM_BIN: join(prefix, 'bin') }, runWorker: async request => { calls.push(request.installAnchor); return { ok: true, metadata: metadata() }; } });
    expect(calls).toEqual([selected]);
  });
  it('discovers the newest valid native nvm runtime with an uninitialized desktop PATH', async () => {
    const home = temporary(); profile(home); const nvm = join(home, 'custom-nvm');
    anchor(join(nvm, 'versions', 'node', 'v9.0.0', 'lib', 'node_modules'));
    const selected = anchor(join(nvm, 'versions', 'node', 'v25.9.0', 'lib', 'node_modules'));
    file(join(nvm, 'versions', 'node', 'v99.0.0', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), { name: 'unrelated-lookalike', version: '99.0.0' });
    const calls: string[] = [];
    await resolveDshProfile(home, { platform: 'linux', homeDir: home, env: { PATH: '', NVM_DIR: nvm }, runWorker: async request => { calls.push(request.installAnchor); return { ok: true, metadata: metadata() }; } });
    expect(calls).toEqual([selected]);
  });
  it('uses existing desktop ahead of web and passes only locations to the worker', async () => {
    const home = temporary(); profile(home); profile(home, 'web'); const install = anchor(join(home, 'runtime'));
    const calls: unknown[] = [];
    const result = await resolveDshProfile(home, { installationAnchors: [install], runWorker: async (request) => { calls.push(request); return { ok: true, metadata: metadata() }; } });
    expect(result.runtimeVersion).toBe('0.2.0-rc.2');
    expect(calls).toEqual([{ home, profileName: 'desktop', installAnchor: install }]);
  });
  it('does not silently switch to web when the preferred desktop manifest is broken', async () => {
    const home = temporary(); file(join(home, 'profiles', 'desktop', 'package.json'), { invalid: true }); profile(home, 'web');
    await expect(resolveDshProfile(home, { installationAnchors: [] })).rejects.toMatchObject({ category: 'profile' });
  });
  it('rejects an uninitialized home without creating profiles', async () => {
    await expect(resolveDshProfile(temporary(), { installationAnchors: [] })).rejects.toMatchObject({ category: 'profile' });
  });
  it('prioritizes running desktop embedded runtime before an older global npm runtime', async () => {
    const home = temporary(); profile(home);
    const desktop = join(home, 'installed', 'DeepSeek Harness.exe');
    const embedded = anchor(join(dirname(desktop), 'resources', 'app.asar', 'dsh', 'node_modules'));
    const npm = anchor(join(home, 'appdata', 'npm', 'node_modules'), '0.1.7-rc.2');
    const calls: string[] = [];
    await resolveDshProfile(home, { platform: 'win32', env: { APPDATA: join(home, 'appdata') }, desktopExecutables: [desktop], runWorker: async (request) => { calls.push(request.installAnchor); return { ok: true, metadata: metadata() }; } });
    expect(calls).toEqual([embedded]); expect(npm).not.toBe(embedded);
  });
  it('tries another verified runtime after a partial incompatible composition', async () => {
    const home = temporary(); profile(home); const first = anchor(join(home, 'first')); const second = anchor(join(home, 'second'));
    const calls: string[] = [];
    await resolveDshProfile(home, { installationAnchors: [first, second], runWorker: async (request) => { calls.push(request.installAnchor); return request.installAnchor === first ? { ok: false, category: 'profile' } : { ok: true, metadata: metadata() }; } });
    expect(calls).toEqual([first, second]);
  });
  it('returns only controlled errors, never native output or thrown credential material', async () => {
    const home = temporary(); profile(home); const install = anchor(join(home, 'runtime'));
    try { await resolveDshProfile(home, { installationAnchors: [install], runWorker: async () => { throw new Error('secret-raw-native-diagnostic'); } }); throw new Error('unexpected'); }
    catch (error) { expect(error).toBeInstanceOf(DshProfileError); expect(String(error)).not.toContain('secret-raw-native'); }
  });
  it('rejects successful metadata for a different profile', async () => {
    const home = temporary(); profile(home); const install = anchor(join(home, 'runtime'));
    await expect(resolveDshProfile(home, { installationAnchors: [install], runWorker: async () => ({ ok: true, metadata: { ...metadata(), profileName: 'web' } }) })).rejects.toMatchObject({ category: 'protocol' });
  });
  it('scrubs credential environment and Node preloads from the real hidden worker process', async () => {
    const home = temporary(); profile(home); const install = anchor(join(home, 'runtime')); const worker = join(home, 'fixture-worker.cjs');
    writeFileSync(worker, `if(process.env.FIXTURE_API_KEY||process.env.NODE_OPTIONS)throw Error('unsafe environment');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, metadata: metadata() }))}));`);
    await expect(resolveDshProfile(home, { installationAnchors: [install], workerPath: worker, execPath: process.execPath, env: { FIXTURE_API_KEY: 'synthetic-private', NODE_OPTIONS: '--require missing-preload' } })).resolves.toEqual(metadata());
  });
  it('caps output and rejects oversized native replies', async () => {
    const home = temporary(); profile(home); const install = anchor(join(home, 'runtime')); const worker = join(home, 'fixture-worker.cjs');
    writeFileSync(worker, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(2*1024*1024)));`);
    await expect(resolveDshProfile(home, { installationAnchors: [install], workerPath: worker, execPath: process.execPath })).rejects.toBeInstanceOf(DshProfileError);
  });
});
