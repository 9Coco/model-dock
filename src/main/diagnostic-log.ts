import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DIAGNOSTIC_MESSAGES, DIAGNOSTIC_OPERATIONS, type DiagnosticContext, type DiagnosticEntry, type DiagnosticErrorDescription, type DiagnosticEvent, type DiagnosticLevel, type DiagnosticMessage, type DiagnosticQuery, type DiagnosticSnapshot } from '../shared/diagnostic-types';

const LEVELS = ['info', 'warn', 'error'] as const;
const OUTCOMES = ['success', 'failure', 'cancelled', 'skipped', 'model-required', 'configuration', 'authentication', 'permission', 'model', 'rate-limit', 'upstream', 'network', 'timeout', 'invalid-response', 'missing-credentials', 'unsupported', 'invalid-provider', 'region', 'device-disabled', 'denied', 'expired', 'blocked', 'pending', 'complete', 'error', 'ready', 'stale', 'unavailable', 'not-queried', 'crashed', 'oom', 'killed', 'launch-failed', 'clean-exit'] as const;
const STAGES = ['startup', 'shutdown', 'store', 'vault', 'window', 'renderer', 'gateway', 'provider', 'account', 'model-list', 'inference', 'configuration', 'oauth', 'refresh', 'callback', 'mcp', 'skills', 'usage', 'diagnostics', 'device-code', 'device-poll', 'token-exchange', 'account-info', 'discovery', 'storage', 'preferences', 'proxy', 'managers', 'runtime', 'model-inference', 'model-catalog', 'github-profile', 'quota-query', 'token-refresh'] as const;
const ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'ReferenceError', 'AggregateError', 'AbortError', 'TimeoutError', 'FetchError'] as const;
// 修改点：Chromium 的网络失败常只写入 message；仅允许现有授权网络诊断的封闭错误码。
const CHROMIUM_NETWORK_CODES = ['ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_ABORTED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_FAILED', 'ERR_INVALID_RESPONSE', 'ERR_UNSAFE_REDIRECT', 'ERR_UNEXPECTED_PROXY_AUTH', 'ERR_PROXY_AUTH_UNSUPPORTED', 'ERR_NO_SUPPORTED_PROXIES', 'ERR_ADDRESS_UNREACHABLE'] as const;
const NETWORK_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK', 'ERR_ABORTED', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_CERT_AUTHORITY_INVALID', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EMFILE', 'ENOENT', ...CHROMIUM_NETWORK_CODES] as const;
const ROUTES = ['/copilot_internal/v2/token', '/login/device/code', '/login/oauth/access_token', '/oauth/token', '/oauth/authorize', '/chat/completions', '/responses', '/messages', '/models', '/health', '/readyz'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNAVAILABLE = '诊断日志暂不可用；请检查资料目录权限、可用磁盘空间或目录链接。';
const PROJECT_FRAME_FILES = new Set([
  'src/main/adapters.ts',
  'src/main/app-icon.ts',
  'src/main/auth-center.ts',
  'src/main/auth-network-smoke.ts',
  'src/main/auth-quota-fixtures.ts',
  'src/main/auth-quota-smoke.ts',
  'src/main/catalog.ts',
  'src/main/clipboard-text.ts',
  'src/main/codex-catalog-smoke.ts',
  'src/main/compact-ui-smoke.ts',
  'src/main/connection-test-smoke.ts',
  'src/main/connection-test.ts',
  'src/main/copilot-auth.ts',
  'src/main/copilot-credentials-linux.ts',
  'src/main/copilot-credentials.ts',
  'src/main/copilot-desktop-smoke.ts',
  'src/main/copilot-desktop.ts',
  'src/main/copilot-process-linux.ts',
  'src/main/copilot-process.ts',
  'src/main/copilot-provider.ts',
  'src/main/copilot-sync.ts',
  'src/main/credentials.ts',
  'src/main/diagnostic-log.ts',
  'src/main/diagnostic-operations.ts',
  'src/main/dsh-config-smoke.ts',
  'src/main/dsh-config.ts',
  'src/main/dsh-profile-worker.ts',
  'src/main/dsh-profile.ts',
  'src/main/dsh-runtime.ts',
  'src/main/gateway-startup-smoke.ts',
  'src/main/gateway.ts',
  'src/main/grok-login-smoke.ts',
  'src/main/main.ts',
  'src/main/mcp.ts',
  'src/main/model-names-smoke.ts',
  'src/main/network-diagnostic.ts',
  'src/main/network-proxy.ts',
  'src/main/oauth.ts',
  'src/main/opencode-paths.ts',
  'src/main/preload.ts',
  'src/main/provider-duplicate-smoke.ts',
  'src/main/provider-removal.ts',
  'src/main/runtime-mode.ts',
  'src/main/settings.ts',
  'src/main/sidebar-scroll-smoke.ts',
  'src/main/skills.ts',
  'src/main/store.ts',
  'src/main/system-network.ts',
  'src/main/tool-icons-smoke.ts',
  'src/main/tool-restore-binding.ts',
  'src/main/tool-restore-smoke.ts',
  'src/main/tool-restore.ts',
  'src/main/tool-selection-smoke.ts',
  'src/main/usage-analytics-smoke.ts',
  'src/main/usage-dashboard-smoke.ts',
  'src/main/usage-import.ts',
  'src/main/usage-opencode.ts',
  'src/main/usage-sync.ts',
  'src/main/usage.ts',
  'src/main/vault.ts',
  'src/renderer/AccountAvatar.tsx',
  'src/renderer/App.tsx',
  'src/renderer/AuthPanel.tsx',
  'src/renderer/DiagnosticsPanel.tsx',
  'src/renderer/MaterialIcon.tsx',
  'src/renderer/McpPanel.tsx',
  'src/renderer/ModelDiscovery.tsx',
  'src/renderer/ProviderDuplicates.tsx',
  'src/renderer/SettingsPanel.tsx',
  'src/renderer/SkillsPanel.tsx',
  'src/renderer/ToolIcon.tsx',
  'src/renderer/UsagePanel.tsx',
  'src/renderer/components.tsx',
  'src/renderer/main.tsx',
  'src/renderer/theme.ts',
  'src/shared/auth-avatar.ts',
  'src/shared/auth-types.ts',
  'src/shared/bindings.ts',
  'src/shared/catalog-types.ts',
  'src/shared/connection-types.ts',
  'src/shared/diagnostic-types.ts',
  'src/shared/mcp-types.ts',
  'src/shared/model-names.ts',
  'src/shared/network-types.ts',
  'src/shared/presets.ts',
  'src/shared/provider-duplicates.ts',
  'src/shared/quota-display.ts',
  'src/shared/settings-types.ts',
  'src/shared/skill-types.ts',
  'src/shared/types.ts',
  'src/shared/usage-display.ts',
  'src/shared/usage-import-types.ts',
  'src/shared/usage-report.ts',
  'src/shared/usage-types.ts',
  'dist-electron/main.cjs',
]);
const MAX_LINE_BYTES = 4096;
const MAX_SCAN_LINES = 50_000;
const plain = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : undefined;
function member<T extends string>(value: unknown, values: readonly T[]): T | undefined { return typeof value === 'string' && values.includes(value as T) ? value as T : undefined; }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined; }
function field(value: unknown, key: string): unknown { try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined; } catch { return undefined; } }

/** 修改点：UUID 允许作为资料标识；其他自由字符串拒绝常见凭据前缀及长随机串。 */
function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 96 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(value)) return;
  if (UUID.test(value)) return value.toLowerCase();
  if (/(?:^|[\W_])(?:sk-|gh[pousr]_|github_pat_|eyJ|bearer|basic|token|password|secret|api[_-]?key|authorization|cookie)/i.test(value)) return;
  for (const part of value.split(/[_.:/-]/)) {
    if (part.length > 32 || /^[a-f0-9]{24,}$/i.test(part) || part.length >= 24 && /[A-Z]/.test(part) && /[a-z]/.test(part) && /\d/.test(part)) return;
  }
  return value;
}

/** Keep only a host and a fixed known route; never retain userinfo/query/hash or arbitrary path text. */
export function sanitizeDiagnosticEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return;
  if (value.startsWith('/') && !value.startsWith('//')) {
    const path = value.split(/[?#]/, 1)[0];
    const route = ROUTES.find(candidate => path === candidate || path.endsWith(candidate));
    return route ?? '/[redacted]';
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hostname.length > 253) return;
    if (!url.hostname.startsWith('[') && !url.hostname.split('.').every(label => safeIdentifier(label))) return;
    const route = ROUTES.find(candidate => url.pathname === candidate || url.pathname.endsWith(candidate));
    return `${url.protocol}//${url.host}${route ?? '/[redacted]'}`;
  } catch { return; }
}

function safeProjectFrame(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(.+):\d{1,7}:\d{1,7}$/);
  return !!match && PROJECT_FRAME_FILES.has(match[1]);
}

/** No error.message, arbitrary cause, function names or absolute stack paths cross the logging boundary. */
export function describeError(error: unknown): DiagnosticErrorDescription {
  const result: DiagnosticErrorDescription = {};
  const name = member(field(error, 'name'), ERROR_NAMES);
  if (name) result.errorName = name;
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++, current = field(current, 'cause')) {
    const code = member(field(current, 'code'), NETWORK_CODES);
    if (code) { result.networkCode = code; break; }
  }
  // Explicit .code/cause classifications take priority. Only a known enum is extracted from bounded native message text.
  if (!result.networkCode) for (let current: unknown = error, depth = 0; current && depth < 4; depth++, current = field(current, 'cause')) {
    const message = field(current, 'message');
    if (typeof message !== 'string') continue;
    const matches = message.slice(0, 16_384).match(/\bERR_[A-Z0-9_]+\b/g) ?? [];
    const code = matches.map(candidate => member(candidate, CHROMIUM_NETWORK_CODES)).find(candidate => candidate !== undefined);
    if (code) { result.networkCode = code; break; }
  }
  const stack = field(error, 'stack');
  if (typeof stack === 'string') {
    // The first stack line includes error.message; only actual V8 frame lines are considered.
    const frameLines = stack.slice(0, 32 * 1024).replace(/\\/g, '/').split('\n').slice(1).filter(line => /^\s+at\s/.test(line)).join('\n');
    const frames = frameLines.match(/(?:src\/(?:main|shared|renderer)\/[A-Za-z0-9_.-]+\.(?:tsx?|jsx?)|dist-electron\/main\.cjs):\d{1,7}:\d{1,7}/g) ?? [];
    const safe = [...new Set(frames.filter(safeProjectFrame))].slice(0, 6);
    if (safe.length) result.projectFrames = safe;
  }
  return result;
}

function sanitizeContext(value: unknown): DiagnosticContext {
  const source = plain(value); if (!source) return {};
  const result: Record<string, unknown> = {};
  const enums: Record<string, readonly string[]> = {
    operation: DIAGNOSTIC_OPERATIONS, outcome: OUTCOMES, stage: STAGES,
    platform: ['linux', 'win32', 'darwin'], runtimeMode: ['production', 'development', 'smoke'],
    toolId: ['codex', 'opencode', 'dsh', 'vscode', 'copilot', 'claude-code', 'webstorm', 'intellij-idea', 'rider', 'pycharm'], errorName: ERROR_NAMES, networkCode: NETWORK_CODES,
    wireApi: ['chat-completions', 'responses', 'anthropic-messages', 'messages'],
    responseStatus: ['completed', 'incomplete', 'failed', 'in_progress', 'unknown'],
    incompleteReason: ['max_output_tokens', 'content_filter', 'missing', 'unknown'],
    contentType: ['json', 'sse', 'html', 'other', 'unknown'],
  };
  for (const [key, values] of Object.entries(enums)) { const safe = member(field(source, key), values); if (safe !== undefined) result[key] = safe; }
  const traceId = field(source, 'traceId'); if (typeof traceId === 'string' && UUID.test(traceId)) result.traceId = traceId.toLowerCase();
  const version = field(source, 'version'); if (typeof version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:alpha|beta|rc)\.\d{1,5})?$/.test(version)) result.version = version;
  for (const key of ['providerId', 'modelId']) { const safe = safeIdentifier(field(source, key)); if (safe) result[key] = safe; }
  for (const [key, min, max] of [['modelCount', 0, 1_000_000], ['statusCode', 100, 599], ['port', 0, 65535], ['exitCode', -2147483648, 2147483647], ['responseBytes', 0, 1024 * 1024 * 1024], ['outputItems', 0, 1_000_000], ['outputTokens', 0, 1_000_000_000], ['reasoningTokens', 0, 1_000_000_000]] as const) {
    const safe = integer(field(source, key), min, max); if (safe !== undefined) result[key] = safe;
  }
  const duration = field(source, 'durationMs');
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 24 * 60 * 60 * 1000) result.durationMs = Math.round(duration);
  for (const key of ['autoStart', 'hasOutputText', 'hasReasoning']) if (typeof field(source, key) === 'boolean') result[key] = field(source, key);
  const endpoint = sanitizeDiagnosticEndpoint(field(source, 'endpoint')); if (endpoint) result.endpoint = endpoint;
  const frames = field(source, 'projectFrames');
  if (Array.isArray(frames)) {
    const safe = frames.filter(safeProjectFrame).slice(0, 6);
    if (safe.length) result.projectFrames = safe;
  }
  return result as DiagnosticContext;
}

/** Validate even records read from disk; a modified JSONL file is untrusted input. */
function sanitizeEntry(value: unknown): DiagnosticEntry | undefined {
  const entry = plain(value); if (!entry) return;
  const level = member(field(entry, 'level'), LEVELS), event = member(field(entry, 'event'), Object.keys(DIAGNOSTIC_MESSAGES) as DiagnosticEvent[]);
  const timestamp = field(entry, 'timestamp'), sessionId = field(entry, 'sessionId'), entryId = field(entry, 'entryId');
  if (!level || !event || typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))
    || typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof entryId !== 'string' || !UUID.test(entryId) || field(entry, 'message') !== DIAGNOSTIC_MESSAGES[event]) return;
  return { timestamp, sessionId: sessionId.toLowerCase(), entryId: entryId.toLowerCase(), level, event, message: DIAGNOSTIC_MESSAGES[event], context: sanitizeContext(field(entry, 'context')) };
}

export interface DiagnosticLogOptions { maxFileBytes?: number; retention?: number; maxReadBytes?: number; maxEntries?: number }
interface Identity { dev: number; ino: number }
interface DirectoryHandle { fd?: number; path: string; identity: Identity }
const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
const option = (value: unknown, fallback: number, min: number, max: number): number => integer(value, min, max) ?? fallback;
function fileExists(path: string): Stats | undefined { try { return lstatSync(path); } catch (error) { if (field(error, 'code') === 'ENOENT') return; throw error; } }
function safeFile(info: Stats): void { if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe-log-file'); }

/** Synchronous and deliberately non-fatal: an unavailable disk must not break an API/auth/config operation. */
export class DiagnosticsLog {
  readonly directory: string;
  readonly sessionId = randomUUID();
  readonly retention: number;
  readonly maxFileBytes: number;
  private readonly root: string;
  private readonly maxReadBytes: number;
  private readonly maxEntries: number;
  private rootIdentity?: Identity;
  private directoryIdentity?: Identity;
  private unavailable = false;

  constructor(dataDir: string, options: DiagnosticLogOptions = {}) {
    this.root = resolve(dataDir);
    this.directory = join(this.root, 'logs');
    this.maxFileBytes = option(options.maxFileBytes, 2 * 1024 * 1024, 512, 2 * 1024 * 1024);
    this.retention = option(options.retention, 5, 1, 5);
    this.maxReadBytes = option(options.maxReadBytes, this.maxFileBytes * this.retention, 1, 10 * 1024 * 1024);
    this.maxEntries = option(options.maxEntries, 1000, 1, 1000);
    try { const directory = this.prepare(); if (directory.fd !== undefined) closeSync(directory.fd); } catch { this.unavailable = true; }
  }

  /** Detect all replaced ancestors before opening any log bytes. New data directories are created with private permissions. */
  private inspectRoot(): void {
    const ancestors: string[] = [];
    for (let current = this.root; ; current = dirname(current)) { ancestors.unshift(current); if (dirname(current) === current) break; }
    for (const path of ancestors) {
      let info = fileExists(path);
      if (!info) { mkdirSync(path, { mode: 0o700 }); info = lstatSync(path); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe-log-directory');
      if (path === this.root) {
        if (this.rootIdentity && !same(this.rootIdentity, info)) throw new Error('replaced-data-directory');
        this.rootIdentity ??= { dev: info.dev, ino: info.ino };
      }
    }
    const physical = realpathSync(this.root);
    if (process.platform === 'win32' ? physical.toLowerCase() !== this.root.toLowerCase() : physical !== this.root) throw new Error('noncanonical-data-directory');
  }

  private prepare(): DirectoryHandle {
    this.inspectRoot();
    let directory = fileExists(this.directory);
    if (!directory) { mkdirSync(this.directory, { mode: 0o700 }); directory = lstatSync(this.directory); }
    if (!directory.isDirectory() || directory.isSymbolicLink() || this.directoryIdentity && !same(this.directoryIdentity, directory)) throw new Error('unsafe-log-directory');
    // Windows libuv may not offer a readable directory handle; regular log descriptors are still checked before every write.
    if (process.platform === 'win32') {
      this.inspectRoot(); const current = lstatSync(this.directory);
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, directory)) throw new Error('replaced-log-directory');
      this.directoryIdentity ??= { dev: current.dev, ino: current.ino };
      return { path: this.directory, identity: this.directoryIdentity };
    }
    const fd = openSync(this.directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isDirectory() || !same(opened, directory)) throw new Error('replaced-log-directory');
      this.inspectRoot();
      if (!same(lstatSync(this.directory), opened) || lstatSync(this.directory).isSymbolicLink()) throw new Error('replaced-log-directory');
      this.directoryIdentity ??= { dev: opened.dev, ino: opened.ino };
      fchmodSync(fd, 0o700);
      // Linux directory descriptors pin the destination across a rename/symlink race. Other platforms still verify the opened inode before writing it.
      return { fd, path: process.platform === 'linux' ? `/proc/self/fd/${fd}` : this.directory, identity: { dev: opened.dev, ino: opened.ino } };
    } catch (error) { closeSync(fd); throw error; }
  }

  private validateDirectory(handle: DirectoryHandle): void {
    this.inspectRoot();
    const current = lstatSync(this.directory), opened = handle.fd === undefined ? handle.identity : fstatSync(handle.fd);
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, opened)) throw new Error('replaced-log-directory');
  }

  private name(index: number): string { return index === 0 ? 'diagnostics.jsonl' : `diagnostics.${index}.jsonl`; }

  private openFile(handle: DirectoryHandle, index: number, write = false): number | undefined {
    this.validateDirectory(handle);
    const path = join(handle.path, this.name(index)), before = fileExists(path);
    if (!before && !write) return;
    if (before) safeFile(before);
    const flags = (write ? constants.O_RDWR | constants.O_APPEND | (!before ? constants.O_CREAT | constants.O_EXCL : 0) : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const fd = openSync(path, flags, 0o600);
    try {
      const opened = fstatSync(fd); safeFile(opened);
      if (before && !same(before, opened)) throw new Error('replaced-log-file');
      this.validateDirectory(handle);
      const current = lstatSync(path); safeFile(current);
      if (!same(current, opened)) throw new Error('replaced-log-file');
      if (write && process.platform !== 'win32') fchmodSync(fd, 0o600);
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }

  private rotate(handle: DirectoryHandle): void {
    this.validateDirectory(handle);
    for (let index = 0; index < this.retention; index++) { const info = fileExists(join(handle.path, this.name(index))); if (info) safeFile(info); }
    const oldest = join(handle.path, this.name(this.retention - 1));
    if (fileExists(oldest)) unlinkSync(oldest);
    for (let index = this.retention - 2; index >= 0; index--) {
      this.validateDirectory(handle);
      const source = join(handle.path, this.name(index));
      if (fileExists(source)) renameSync(source, join(handle.path, this.name(index + 1)));
    }
    this.validateDirectory(handle);
  }

  write(level: DiagnosticLevel, event: DiagnosticEvent, message: DiagnosticMessage | undefined = undefined, context: DiagnosticContext = {}): void {
    let handle: DirectoryHandle | undefined, fd: number | undefined;
    try {
      if (!member(level, LEVELS) || !Object.hasOwn(DIAGNOSTIC_MESSAGES, event) || message !== undefined && message !== DIAGNOSTIC_MESSAGES[event]) return;
      const entry = sanitizeEntry({ timestamp: new Date().toISOString(), sessionId: this.sessionId, entryId: randomUUID(), level, event, message: DIAGNOSTIC_MESSAGES[event], context });
      if (!entry) return;
      let text = JSON.stringify(entry) + '\n';
      // Small fixture limits may omit metadata, but never truncate JSON or write a record exceeding its file budget.
      if (Buffer.byteLength(text) > Math.min(this.maxFileBytes, MAX_LINE_BYTES)) { entry.context = {}; text = JSON.stringify(entry) + '\n'; }
      if (Buffer.byteLength(text) > this.maxFileBytes) return;
      handle = this.prepare(); fd = this.openFile(handle, 0, true);
      if (fd === undefined) throw new Error('unavailable-log-file');
      const currentSize = fstatSync(fd).size, tail = Buffer.alloc(1);
      const prefix = currentSize > 0 && readSync(fd, tail, 0, 1, currentSize - 1) === 1 && tail[0] !== 10 ? '\n' : '';
      if (currentSize + Buffer.byteLength(text) + prefix.length > this.maxFileBytes) { closeSync(fd); fd = undefined; this.rotate(handle); fd = this.openFile(handle, 0, true); }
      else text = prefix + text;
      if (fd === undefined) throw new Error('unavailable-log-file');
      this.validateDirectory(handle); safeFile(fstatSync(fd));
      const bytes = Buffer.from(text); let written = 0;
      while (written < bytes.length) { const count = writeSync(fd, bytes, written, bytes.length - written); if (count <= 0) throw new Error('unavailable-log-file'); written += count; }
      this.unavailable = false;
    } catch { this.unavailable = true; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 非致命日志清理。 */ } if (handle?.fd !== undefined) try { closeSync(handle.fd); } catch { /* 非致命日志清理。 */ } }
  }

  query(query: DiagnosticQuery = {}): DiagnosticSnapshot {
    const result: DiagnosticSnapshot = { entries: [], directory: this.directory, available: !this.unavailable, message: this.unavailable ? UNAVAILABLE : '', retention: this.retention, maxFileBytes: this.maxFileBytes };
    let handle: DirectoryHandle | undefined, fd: number | undefined;
    try {
      const level = member(field(query, 'level'), LEVELS);
      const limit = option(field(query, 'limit'), Math.min(200, this.maxEntries), 1, this.maxEntries);
      const rawSearch = field(query, 'search');
      const search = typeof rawSearch === 'string' ? rawSearch.slice(0, 128).toLocaleLowerCase() : '';
      handle = this.prepare(); let remainingBytes = this.maxReadBytes, scanned = 0, invalid = false;
      for (let index = 0; index < this.retention && remainingBytes > 0 && result.entries.length < limit && scanned < MAX_SCAN_LINES; index++) {
        fd = this.openFile(handle, index);
        if (fd === undefined) continue;
        const size = fstatSync(fd).size, count = Math.min(size, this.maxFileBytes, remainingBytes), offset = size - count;
        const bytes = Buffer.alloc(count); let read = 0;
        while (read < count) { const amount = readSync(fd, bytes, read, count - read, offset + read); if (amount <= 0) break; read += amount; }
        this.validateDirectory(handle); safeFile(fstatSync(fd));
        closeSync(fd); fd = undefined; remainingBytes -= count;
        const text = bytes.subarray(0, read).toString('utf8'); let end = text.lastIndexOf('\n');
        if (end < text.length - 1) invalid = true;
        while (end >= 0 && result.entries.length < limit && scanned++ < MAX_SCAN_LINES) {
          const start = end > 0 ? text.lastIndexOf('\n', end - 1) + 1 : 0;
          if (offset > 0 && start === 0) break; // The first line of a bounded tail may be partial.
          const line = text.slice(start, end); end = start - 1;
          if (!line.trim()) { if (start === 0) break; continue; }
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) { invalid = true; if (start === 0) break; continue; }
          let entry: DiagnosticEntry | undefined;
          try { entry = sanitizeEntry(JSON.parse(line)); } catch { /* 无效文件记录不返回。 */ }
          if (!entry) invalid = true;
          else if ((!level || entry.level === level) && (!search || JSON.stringify(entry).toLocaleLowerCase().includes(search))) result.entries.push(entry);
          if (start === 0) break;
        }
      }
      if (invalid && !this.unavailable) result.message = '部分日志记录无效，已跳过。';
      return result;
    } catch { this.unavailable = true; return { ...result, entries: [], available: false, message: UNAVAILABLE }; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 非致命日志清理。 */ } if (handle?.fd !== undefined) try { closeSync(handle.fd); } catch { /* 非致命日志清理。 */ } }
  }

  /** Export normalized, validated JSONL only; never copy the original file or prepend arbitrary paths/errors. */
  exportText(query: DiagnosticQuery = {}): string { return this.query(query).entries.map(entry => JSON.stringify(sanitizeEntry(entry))).join('\n'); }
}
