import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DIAGNOSTIC_MESSAGES, type DiagnosticContext, type DiagnosticEntry } from '../src/shared/diagnostic-types';
import { DiagnosticsLog, describeError, sanitizeDiagnosticEndpoint } from '../src/main/diagnostic-log';

const faults = vi.hoisted(() => ({ write: false, read: false, open: undefined as undefined | ((path: string, before: boolean) => void) }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => { if (faults.write) throw Object.assign(new Error('private-api-key-DO-NOT-LOG'), { code: 'ENOSPC' }); return (actual.writeSync as (...args: unknown[]) => number)(...args); },
    readSync: (...args: Parameters<typeof actual.readSync>) => { if (faults.read) throw Object.assign(new Error('private-network-response-DO-NOT-LOG'), { code: 'EIO' }); return (actual.readSync as (...args: unknown[]) => number)(...args); },
    openSync: (...args: Parameters<typeof actual.openSync>) => { faults.open?.(String(args[0]), true); const fd = actual.openSync(...args); faults.open?.(String(args[0]), false); return fd; },
  };
});
const roots: string[] = [];
afterEach(() => { faults.write = false; faults.read = false; faults.open = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(options: ConstructorParameters<typeof DiagnosticsLog>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-diagnostics-')); roots.push(root);
  return { root, log: new DiagnosticsLog(root, options), directory: join(root, 'logs'), file: join(root, 'logs', 'diagnostics.jsonl') };
}
function entry(context: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): DiagnosticEntry {
  return { timestamp: new Date().toISOString(), sessionId: randomUUID(), entryId: randomUUID(), level: 'info', event: 'provider.test', message: DIAGNOSTIC_MESSAGES['provider.test'], context, ...overrides } as DiagnosticEntry;
}

// 修改点：诊断日志的测试验证实际文件内容和安全边界，不依赖真实账号或客户端配置。
describe('persistent diagnostic metadata', () => {
  it('creates private logs, preserves sessions on restart and returns newest first', () => {
    const f = fixture();
    f.log.write('info', 'app.start', undefined, { version: '0.3.35', platform: 'linux', runtimeMode: 'production', stage: 'storage' });
    f.log.write('warn', 'provider.test', undefined, { outcome: 'network', statusCode: 503, durationMs: 12.5 });
    expect(statSync(f.directory).mode & 0o777).toBe(0o700);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    const restarted = new DiagnosticsLog(f.root);
    expect(restarted.sessionId).not.toBe(f.log.sessionId);
    expect(restarted.query().entries.map(item => item.event)).toEqual(['provider.test', 'app.start']);
    restarted.write('info', 'app.ready');
    const snapshot = restarted.query();
    expect(snapshot).toMatchObject({ available: true, message: '', retention: 5, maxFileBytes: 2 * 1024 * 1024 });
    expect(snapshot.entries[0].sessionId).toBe(restarted.sessionId);
    expect(snapshot.entries[1].sessionId).toBe(f.log.sessionId);
    expect(snapshot.entries[1].context.durationMs).toBe(13);
  });

  it('creates a missing data directory without exposing new folders', () => {
    const f = fixture(), data = join(f.root, 'new-data', 'profile');
    const log = new DiagnosticsLog(data); log.write('info', 'app.start');
    expect(log.query().available).toBe(true);
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(join(data, 'logs')).mode & 0o777).toBe(0o700);
  });

  it('rotates within a fixed total file budget and reads archived records after restart', () => {
    const f = fixture({ maxFileBytes: 768, retention: 3 });
    for (let index = 0; index < 35; index++) f.log.write('info', 'gateway.request', undefined, { statusCode: 200, durationMs: index, operation: 'request' });
    const files = readdirSync(f.directory);
    expect(files.sort()).toEqual(['diagnostics.1.jsonl', 'diagnostics.2.jsonl', 'diagnostics.jsonl']);
    for (const file of files) { expect(statSync(join(f.directory, file)).size).toBeLessThanOrEqual(768); expect(statSync(join(f.directory, file)).mode & 0o777).toBe(0o600); }
    const restarted = new DiagnosticsLog(f.root, { maxFileBytes: 768, retention: 3 });
    const durations = restarted.query().entries.map(item => item.context.durationMs);
    expect(durations.length).toBeGreaterThan(2);
    expect(durations[0]).toBe(34);
    expect(durations).toEqual([...durations].sort((a, b) => Number(b) - Number(a)));
    expect(durations).not.toContain(0);
  });

  it('supports one retained file without oversized entries or leftover archives', () => {
    const f = fixture({ maxFileBytes: 512, retention: 1 });
    for (let index = 0; index < 15; index++) f.log.write('info', 'provider.test', undefined, { endpoint: 'https://api.example.test/v1/responses', providerId: randomUUID(), traceId: randomUUID(), projectFrames: ['src/main/connection-test.ts:123:45'] });
    expect(readdirSync(f.directory)).toEqual(['diagnostics.jsonl']);
    expect(statSync(f.file).size).toBeLessThanOrEqual(512);
    expect(f.log.query().available).toBe(true);
    expect(f.log.query().entries.length).toBeGreaterThan(0);
  });

  it('limits query rows/search/level and read bytes including exported content', () => {
    const f = fixture({ maxFileBytes: 8192, maxReadBytes: 1000, maxEntries: 3 });
    for (let index = 0; index < 20; index++) f.log.write(index % 2 ? 'error' : 'info', 'provider.test', undefined, { durationMs: index });
    const query = f.log.query({ limit: 2 });
    expect(query.entries.map(item => item.context.durationMs)).toEqual([19, 18]);
    expect(f.log.query({ limit: 10000 }).entries.length).toBeLessThanOrEqual(3);
    expect(f.log.query({ level: 'error' }).entries.every(item => item.level === 'error')).toBe(true);
    expect(f.log.query({ search: 'provider.test' }).entries.length).toBeGreaterThan(0);
    expect(f.log.query({ search: 'does-not-exist' }).entries).toEqual([]);
    const exported = f.log.exportText({ limit: 2 });
    expect(exported.split('\n')).toHaveLength(2);
    expect(Buffer.byteLength(exported)).toBeLessThan(1000);
    const byteBound = new DiagnosticsLog(f.root, { maxReadBytes: 1 });
    expect(byteBound.query().entries).toEqual([]);
  });

  it('isolates a partial trailing record so a later successful write remains readable', () => {
    const f = fixture(); f.log.write('info', 'app.start');
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + '{"incomplete":"private-content');
    f.log.write('info', 'app.ready');
    expect(f.log.query().entries.map(item => item.event)).toEqual(['app.ready', 'app.start']);
    expect(f.log.exportText()).not.toContain('private-content');
  });

  it('does not require a directory file descriptor on the Windows fallback path', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      faults.open = (path, before) => { if (before && path.endsWith('/logs')) throw Object.assign(new Error('directory descriptors unsupported'), { code: 'EISDIR' }); };
      const f = fixture(); f.log.write('info', 'app.start');
      expect(f.log.query()).toMatchObject({ available: true, entries: [expect.objectContaining({ event: 'app.start' })] });
    } finally { Object.defineProperty(process, 'platform', descriptor); faults.open = undefined; }
  });

  it('is non-fatal on disk-full and read failures, reports unavailable status and recovers on a successful write', () => {
    const f = fixture(); faults.write = true;
    expect(() => f.log.write('error', 'app.error')).not.toThrow();
    const failed = f.log.query();
    expect(failed.available).toBe(false);
    expect(failed.message).not.toContain('private-api-key');
    faults.write = false; f.log.write('info', 'app.ready');
    expect(f.log.query().available).toBe(true);
    faults.read = true; const unreadable = f.log.query();
    expect(unreadable).toMatchObject({ entries: [], available: false });
    expect(unreadable.message).not.toContain('private-network');
    expect(() => f.log.exportText()).not.toThrow();
    faults.read = false; f.log.write('info', 'app.ready');
    expect(f.log.query().available).toBe(true);
  });
});

describe('diagnostic privacy boundaries', () => {
  it('whitelists every field and strips request content, credentials and arbitrary raw errors', () => {
    const f = fixture();
    const secret = 'ghp_aB7fH9kL3mNp4QrS6tUv8WxY0zAbCdE';
    f.log.write('error', 'operation.failed', undefined, {
      operation: 'testProvider', providerId: randomUUID(), traceId: randomUUID(), modelId: secret,
      endpoint: 'https://username:password@api.example.test/customer/private-prompt/v1/responses?api_key=sk-private#private-content',
      outcome: 'authentication', stage: 'token-exchange', errorName: 'Error', networkCode: 'ECONNRESET',
      authorization: secret, body: { prompt: 'private user message' }, headers: { cookie: secret }, error: new Error(secret),
      unknown: 'request-secret', projectFrames: ['/home/user/private.ts:1:1', 'src/main/oauth.ts:22:7'],
    } as DiagnosticContext);
    const raw = readFileSync(f.file, 'utf8'), queried = f.log.query().entries[0];
    expect(queried.context).toMatchObject({ operation: 'testProvider', endpoint: 'https://api.example.test/responses', outcome: 'authentication', networkCode: 'ECONNRESET', projectFrames: ['src/main/oauth.ts:22:7'] });
    expect(queried.context.modelId).toBeUndefined();
    for (const value of [secret, 'username', 'password', 'private-prompt', 'private-content', 'private user message', 'request-secret']) { expect(raw).not.toContain(value); expect(f.log.exportText()).not.toContain(value); }
  });

  it('does not permit caller-controlled messages/events/enums or high entropy metadata identifiers', () => {
    const f = fixture();
    f.log.write('info', 'provider.test', 'arbitrary private output' as never);
    f.log.write('info', 'private-customer-message' as never);
    f.log.write('private-key' as never, 'app.error');
    expect(existsSync(f.file)).toBe(false);
    f.log.write('error', 'app.error', undefined, { operation: 'sk-private' as never, outcome: 'arbitrary message' as never, stage: 'token-value' as never, modelId: 'AB8cDe2FgHi3JkLm4NoP5qRs6TuVw7XyZ', providerId: 'abcdef0123456789abcdef0123456789', traceId: 'not-a-uuid', version: '1.2.3+sk-secret', platform: 'private-address' as never, runtimeMode: 'private-mode' as never });
    expect(f.log.query().entries[0].context).toEqual({});
  });

  it('revalidates records from modified log files and never exports untrusted extra fields', () => {
    const f = fixture();
    const safe = entry({ statusCode: 401, providerId: 'sk-dangerous', authorization: 'private-header', endpoint: 'https://user:private-password@api.example.test/private-response?key=private-key', operation: 'login', stage: 'oauth' }, { unexpected: 'private-field' });
    writeFileSync(f.file, JSON.stringify(safe) + '\n' + JSON.stringify(entry({}, { message: 'private model output' })) + '\n' + 'malformed-private-data\n' + JSON.stringify(entry({}, { event: 'private-event' })) + '\n', { mode: 0o600 });
    const snapshot = f.log.query();
    expect(snapshot.available).toBe(true);
    expect(snapshot.message).toContain('已跳过');
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].context).toEqual({ operation: 'login', stage: 'oauth', statusCode: 401, endpoint: 'https://api.example.test/[redacted]' });
    const exported = f.log.exportText();
    for (const secret of ['private-header', 'private-password', 'private-response', 'private-key', 'private-field', 'private model output', 'private-event', 'malformed-private-data', 'sk-dangerous']) expect(exported).not.toContain(secret);
  });

  it('ignores a file containing only blank lines without looping indefinitely', () => {
    const f = fixture(); writeFileSync(f.file, '\n\n\n', { mode: 0o600 });
    expect(f.log.query()).toMatchObject({ available: true, entries: [] });
  });

  it('handles malicious giant, partial, prototype and blank records within byte limits', () => {
    const f = fixture({ maxFileBytes: 8192, maxReadBytes: 8192 });
    writeFileSync(f.file, '\n' + JSON.stringify({ ...entry(), context: JSON.parse('{"__proto__":{"secret":"private"},"operation":"login"}') }) + '\n' + JSON.stringify({ ...entry(), message: 'X'.repeat(80_000) }) + '\n' + JSON.stringify(entry()) + '\npartial-private', { mode: 0o600 });
    const snapshot = f.log.query();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].context).toEqual({});
    expect(f.log.exportText()).not.toContain('partial-private');
    expect(f.log.exportText()).not.toContain('XXX');
  });

  it('extracts only standard error classifications and relative project frames', () => {
    const error = Object.assign(new TypeError('Bearer private-token with private response'), { code: 'private-secret', cause: { code: 'ECONNRESET', message: 'private-message' }, stack: 'TypeError: private-token src/main/main.ts:123:45\n at request (/home/customer/project/src/main/connection-test.ts:123:45)\n at unknown (/private/customer/file.ts:2:5)\n at secret (/home/customer/src/main/sk-private.ts:4:7)\n at bundled (/opt/ModelDock/dist-electron/main.cjs:55:9)' });
    expect(describeError(error)).toEqual({ errorName: 'TypeError', networkCode: 'ECONNRESET', projectFrames: ['src/main/connection-test.ts:123:45', 'dist-electron/main.cjs:55:9'] });
    expect(describeError('private-raw-string')).toEqual({});
    expect(describeError({ name: 'private-error', code: 'private-code', stack: 'private-stack', get cause() { throw new Error('private getter'); } })).toEqual({});
  });

  it.each(['ERR_PROXY_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT'])('retains only Chromium network code %s from a bounded message', code => {
    const f = fixture();
    const error = new Error(`net::${code} Synthetic APIkey sk-SYNTHETIC_PRIVATE_KEY response={"body":"SYNTHETIC_PRIVATE_BODY"} https://user:password@example.test/?token=SYNTHETIC_TOKEN`);
    const safe = describeError(error);
    expect(safe).toMatchObject({ errorName: 'Error', networkCode: code });
    f.log.write('error', 'network.failed', undefined, safe);
    const text = readFileSync(f.file, 'utf8') + f.log.exportText();
    for (const privateText of ['Synthetic APIkey', 'sk-SYNTHETIC_PRIVATE_KEY', 'SYNTHETIC_PRIVATE_BODY', 'SYNTHETIC_TOKEN', 'password', 'response=', 'net::']) expect(text).not.toContain(privateText);
    expect(f.log.query().entries[0].context.networkCode).toBe(code);
  });

  it('prioritizes explicit codes over message text, bounds fallback scans and omits unknown enum material', () => {
    expect(describeError({ name: 'Error', code: 'ECONNRESET', message: 'net::ERR_PROXY_CONNECTION_FAILED' }).networkCode).toBe('ECONNRESET');
    expect(describeError({ name: 'Error', message: 'net::ERR_PROXY_CONNECTION_FAILED', cause: { code: 'EADDRINUSE' } }).networkCode).toBe('EADDRINUSE');
    expect(describeError({ name: 'Error', cause: { message: 'net::ERR_NAME_NOT_RESOLVED' } }).networkCode).toBe('ERR_NAME_NOT_RESOLVED');
    expect(describeError({ name: 'Error', message: 'X'.repeat(16_384) + ' net::ERR_PROXY_CONNECTION_FAILED' })).toEqual({ errorName: 'Error' });
    const f = fixture();
    f.log.write('error', 'network.failed', undefined, describeError(new Error('ERR_PRIVATE_SECRET ERR_PROXY_CONNECTION_FAILED_PRIVATE_SYNTHETIC_APIKEY')));
    expect(f.log.query().entries[0].context.networkCode).toBeUndefined();
    expect(f.log.exportText()).not.toContain('ERR_PRIVATE_SECRET');
    expect(f.log.exportText()).not.toContain('SYNTHETIC_APIKEY');
  });

  it('does not throw or export values when native error getters fail', () => {
    const error = { get name() { throw new Error('PRIVATE_NAME'); }, get code() { throw new Error('PRIVATE_CODE'); }, get message() { throw new Error('PRIVATE_MESSAGE'); }, get cause() { throw new Error('PRIVATE_CAUSE'); }, get stack() { throw new Error('PRIVATE_STACK'); } };
    expect(() => describeError(error)).not.toThrow();
    expect(describeError(error)).toEqual({});
    const f = fixture(); expect(() => f.log.write('error', 'network.failed', undefined, describeError(error))).not.toThrow();
    expect(f.log.query().available).toBe(true);
    expect(f.log.exportText()).not.toContain('PRIVATE_');
  });

  it('redacts arbitrary endpoint paths/userinfo/query/hash and permits only recognized routes', () => {
    expect(sanitizeDiagnosticEndpoint('https://user:password@api.example.test/v1/responses?token=private#secret')).toBe('https://api.example.test/responses');
    expect(sanitizeDiagnosticEndpoint('https://api.example.test/private-request-and-token')).toBe('https://api.example.test/[redacted]');
    expect(sanitizeDiagnosticEndpoint('/v1/chat/completions?api_key=private#hash')).toBe('/chat/completions');
    expect(sanitizeDiagnosticEndpoint('https://github.com/login/device/code')).toBe('https://github.com/login/device/code');
    expect(sanitizeDiagnosticEndpoint('https://api.github.com/copilot_internal/v2/token')).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(sanitizeDiagnosticEndpoint('https://AB8cDe2FgHi3JkLm4NoP5qRs6TuVw7XyZ.example.test/responses')).toBeUndefined();
    expect(sanitizeDiagnosticEndpoint('file:///home/user/private')).toBeUndefined();
  });
});

describe('diagnostic filesystem safety', () => {
  it('rejects symlinked directories and does not create or chmod their targets', () => {
    const f = fixture(), outside = join(f.root, 'outside'); mkdirSync(outside, { mode: 0o755 });
    rmSync(f.directory, { recursive: true }); symlinkSync(outside, f.directory, 'dir');
    const log = new DiagnosticsLog(f.root);
    expect(() => log.write('info', 'app.start')).not.toThrow();
    expect(log.query().available).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  });

  it('rejects symlinked ancestors before traversing or creating logs', () => {
    const f = fixture(), outside = join(f.root, 'outside'), alias = join(f.root, 'alias'); mkdirSync(outside); symlinkSync(outside, alias, 'dir');
    const log = new DiagnosticsLog(join(alias, 'new-profile'));
    log.write('info', 'app.start');
    expect(log.query().available).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each(['symlink', 'hardlink'] as const)('rejects %s log files without changing external contents or permissions', link => {
    const f = fixture(), target = join(f.root, 'external'); writeFileSync(target, 'private target', { mode: 0o644 });
    if (link === 'symlink') symlinkSync(target, f.file); else linkSync(target, f.file);
    f.log.write('error', 'app.error');
    expect(f.log.query().available).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('private target');
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(f.log.exportText()).toBe('');
  });

  it('rejects linked archives rather than deleting or reading them during rotation', () => {
    const f = fixture({ maxFileBytes: 512, retention: 3 }), outside = join(f.root, 'external'); writeFileSync(outside, 'private target');
    f.log.write('info', 'app.start'); symlinkSync(outside, join(f.directory, 'diagnostics.2.jsonl'));
    for (let index = 0; index < 3; index++) f.log.write('info', 'app.ready');
    expect(f.log.query({ search: 'app' }).available).toBe(false);
    expect(lstatSync(join(f.directory, 'diagnostics.2.jsonl')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('private target');
  });

  it('rejects a log replaced with a symlink between lstat and open', () => {
    const f = fixture(), outside = join(f.root, 'external'); writeFileSync(outside, 'private target', { mode: 0o644 }); f.log.write('info', 'app.start');
    faults.open = (path, before) => { if (before && path.endsWith('/diagnostics.jsonl')) { faults.open = undefined; unlinkSync(f.file); symlinkSync(outside, f.file); } };
    f.log.write('error', 'app.error');
    expect(f.log.query().available).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('private target');
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it('rejects a hardlink replacement after open and before write', () => {
    const f = fixture(), outside = join(f.root, 'external'); writeFileSync(outside, 'private target', { mode: 0o644 }); f.log.write('info', 'app.start');
    faults.open = (path, before) => { if (!before && path.endsWith('/diagnostics.jsonl')) { faults.open = undefined; unlinkSync(f.file); linkSync(outside, f.file); } };
    f.log.write('error', 'app.error');
    expect(f.log.query().available).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('private target');
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it('pins the log directory and rejects a directory symlink swap after file open', () => {
    const f = fixture(), outside = join(f.root, 'external-dir'); mkdirSync(outside); writeFileSync(join(outside, 'diagnostics.jsonl'), 'private target'); f.log.write('info', 'app.start');
    faults.open = (path, before) => { if (!before && path.endsWith('/diagnostics.jsonl')) { faults.open = undefined; renameSync(f.directory, join(f.root, 'old-logs')); symlinkSync(outside, f.directory, 'dir'); } };
    f.log.write('error', 'app.error');
    expect(f.log.query().available).toBe(false);
    expect(readFileSync(join(outside, 'diagnostics.jsonl'), 'utf8')).toBe('private target');
    expect(readFileSync(join(f.root, 'old-logs', 'diagnostics.jsonl'), 'utf8')).not.toContain('app.error');
  });
});
