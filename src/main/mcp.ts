import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { parse as parseJsonc, modify, applyEdits, type ParseError } from 'jsonc-parser';
import type { ToolId } from '../shared/types';
import type { McpServer, McpServerInput, McpTransport, McpImportResult, McpConfigPreview, McpApplyResult } from '../shared/mcp-types';
import { MCP_SECRET_PLACEHOLDER } from '../shared/mcp-types';
import { openCodeConfigDirectory } from './opencode-paths';

/** The store encrypts this JSON. No native credential values cross the preload bridge. */
export interface McpStore {
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
}
interface StoredServer extends Omit<McpServer, 'redactedEnvKeys' | 'redactedHeaderKeys'> {
  nativeConfigs?: Partial<Record<ToolId, Record<string, unknown>>>;
}
interface McpState {
  revision: number;
  servers: StoredServer[];
  managed: Partial<Record<ToolId, Record<string, string>>>;
}
export interface McpOptions {
  homeDir?: string;
  codexHome?: string;
  appDataDir?: string;
  backupDir?: string;
  platform?: NodeJS.Platform;
  configHome?: string;
}
const TOOL_IDS: ToolId[] = ['codex', 'opencode', 'dsh', 'vscode', 'copilot'];
const STATE_KEY = 'mcp-v1';
const DEFAULT_STATE: McpState = { revision: 0, servers: [], managed: {} };
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function record(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value) || Object.entries(value).some(([key, entry]) => !key || typeof entry !== 'string')) throw new Error(`${label}必须是字符串键值对象。`);
  return { ...value } as Record<string, string>;
}
const normalizedKey = (value: string): string => value.toLowerCase().replace(/^--?/, '').replace(/[-_]/g, '');
const sensitiveKey = (value: string): boolean => /^(?:key|auth|signature|sig|subscriptionkey|sessionkey|authcode|oauthcode|header|headers)$/.test(normalizedKey(value)) || /(?:token|apikey|password|passwd|secret|authorization|credentials?)$/.test(normalizedKey(value));
function hasPlaceholder(value: string): boolean {
  const present = (text: string) => text.includes(MCP_SECRET_PLACEHOLDER) || text.includes('__REDACTED__');
  if (present(value)) return true; try { return present(decodeURIComponent(value)); } catch { return false; }
}
function asHttpUrl(value: string): URL | undefined { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url : undefined; } catch { return undefined; } }
function redactUrl(value: string): string {
  const url = asHttpUrl(value); if (!url) return value;
  let changed = false;
  if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
  for (const key of [...new Set(url.searchParams.keys())]) if (sensitiveKey(key)) {
    const values = url.searchParams.getAll(key); url.searchParams.delete(key); values.forEach(() => url.searchParams.append(key, MCP_SECRET_PLACEHOLDER)); changed = true;
  }
  return changed ? url.toString() : value;
}
interface SecretArgument { index: number; key: string; occurrence: number; prefix: string; value: string }
function secretArguments(args: string[]): SecretArgument[] {
  const result: SecretArgument[] = []; const occurrences = new Map<string, number>();
  const add = (index: number, rawKey: string, prefix: string, value: string) => {
    const key = normalizedKey(rawKey); const occurrence = occurrences.get(key) ?? 0; occurrences.set(key, occurrence + 1);
    result.push({ index, key, occurrence, prefix, value });
  };
  for (let index = 0; index < args.length; index++) {
    const inline = args[index].match(/^([^=]+)=(.*)$/s);
    if (inline && sensitiveKey(inline[1])) add(index, inline[1], inline[1] + '=', inline[2]);
    else if (/^--?[^=]+$/.test(args[index]) && sensitiveKey(args[index]) && index + 1 < args.length) { add(index + 1, args[index], '', args[index + 1]); index++; }
  }
  return result;
}
function redactArgs(args: string[]): string[] {
  const safe = [...args];
  for (const part of secretArguments(args)) safe[part.index] = part.prefix + MCP_SECRET_PLACEHOLDER;
  return safe.map(value => { const inlineUrl = value.match(/^([^=]+=)(https?:\/\/.*)$/s); return inlineUrl ? inlineUrl[1] + redactUrl(inlineUrl[2]) : redactUrl(value); });
}
function restoreUrl(input: string, previous = ''): string {
  if (!hasPlaceholder(input)) return input;
  const url = asHttpUrl(input); const prior = asHttpUrl(previous);
  if (!url || !prior || url.origin !== prior.origin || url.pathname !== prior.pathname) throw new Error('隐藏的 URL 凭据只能保留同一地址中的原参数；新地址请填写新凭据。');
  for (const key of [...new Set(url.searchParams.keys())]) {
    const values = url.searchParams.getAll(key); const oldValues = prior.searchParams.getAll(key);
    if (!values.some(hasPlaceholder)) continue;
    if (!sensitiveKey(key)) throw new Error('隐藏凭据占位符不能用于其他 URL 参数。');
    url.searchParams.delete(key);
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (hasPlaceholder(value)) {
        if (value !== MCP_SECRET_PLACEHOLDER || oldValues[index] === undefined || hasPlaceholder(oldValues[index])) throw new Error('没有对应的已保存 URL 凭据，请填写真实新值。');
        url.searchParams.append(key, oldValues[index]);
      } else url.searchParams.append(key, value);
    }
  }
  if (hasPlaceholder(url.toString())) throw new Error('隐藏凭据占位符不能作为新配置值保存。');
  return url.toString();
}
function restoreArgs(input: string[], previous: string[] = []): string[] {
  const args = [...input]; const prior = secretArguments(previous);
  for (const part of secretArguments(input)) {
    if (!hasPlaceholder(part.value)) continue;
    const old = prior.find(value => value.key === part.key && value.occurrence === part.occurrence);
    if (part.value !== MCP_SECRET_PLACEHOLDER || !old || hasPlaceholder(old.value)) throw new Error('隐藏参数凭据只能保留同名已保存参数；新参数请填写真实值。');
    args[part.index] = part.prefix + old.value;
  }
  for (let index = 0; index < args.length; index++) if (hasPlaceholder(args[index])) {
    const inlineUrl = args[index].match(/^([^=]+=)(https?:\/\/.*)$/s); const previousUrl = previous[index]?.match(/^([^=]+=)(https?:\/\/.*)$/s);
    if (inlineUrl) {
      if (!previousUrl || normalizedKey(inlineUrl[1]) !== normalizedKey(previousUrl[1])) throw new Error('隐藏 URL 参数凭据只能保留同名已保存参数。');
      args[index] = inlineUrl[1] + restoreUrl(inlineUrl[2], previousUrl[2]);
    } else args[index] = restoreUrl(args[index], previous[index]);
  }
  return args;
}
function inlineCommandCredentials(command: string): boolean {
  for (const match of command.matchAll(/(?:^|\s)(--?[A-Za-z][A-Za-z0-9_-]*)(?=\s|=|$)/g)) if (sensitiveKey(match[1])) return true;
  for (const match of command.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)=/g)) if (sensitiveKey(match[1])) return true;
  for (const match of command.matchAll(/https?:\/\/[^\s"']+/g)) if (redactUrl(match[0]) !== match[0]) return true;
  return false;
}
function safeServer(server: StoredServer): McpServer {
  const { nativeConfigs: _native, ...rest } = server;
  return { ...clone(rest), command: inlineCommandCredentials(server.command) ? MCP_SECRET_PLACEHOLDER : server.command,
    args: redactArgs(server.args), url: redactUrl(server.url), env: Object.fromEntries(Object.keys(server.env).map(key => [key, ''])),
    headers: Object.fromEntries(Object.keys(server.headers).map(key => [key, ''])),
    redactedEnvKeys: Object.keys(server.env), redactedHeaderKeys: Object.keys(server.headers) };
}
function redact(value: unknown, key = ''): unknown {
  if (['env', 'environment', 'headers', 'http_headers', 'env_http_headers'].includes(key) && isObject(value)) {
    return Object.fromEntries(Object.keys(value).map(name => [name, MCP_SECRET_PLACEHOLDER]));
  }
  if (/secret|token|password|api.?key|authorization/i.test(key)) return MCP_SECRET_PLACEHOLDER;
  if (key === 'args' && Array.isArray(value) && value.every(entry => typeof entry === 'string')) return redactArgs(value as string[]);
  if ((key === 'command' || key.endsWith('_helper')) && Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    const [command, ...args] = value as string[];
    return [inlineCommandCredentials(command) ? MCP_SECRET_PLACEHOLDER : command, ...redactArgs(args)];
  }
  if (typeof value === 'string') {
    if (key === 'url' || asHttpUrl(value)) return redactUrl(value);
    if ((key === 'command' || key.endsWith('_helper')) && inlineCommandCredentials(value)) return MCP_SECRET_PLACEHOLDER;
  }
  if (Array.isArray(value)) return value.map(entry => redact(entry));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  return value;
}
function validateTool(tool: ToolId): void {
  // 修改点：Claude Code MCP 尚未适配，不能进入其他客户端的路径或序列化分支。
  if (tool === 'claude-code') throw new Error('Claude Code MCP 导入、预览和应用暂不支持；未读取或修改任何工具配置。');
  if (!TOOL_IDS.includes(tool)) throw new Error('未知工具。');
}
function validateServer(input: McpServerInput): void {
  if (typeof input.name !== 'string' || !/^[\p{L}\p{N}_.-]{1,100}$/u.test(input.name) || ['__proto__', 'prototype', 'constructor'].includes(input.name)) throw new Error('MCP 名称请使用字母、数字、点、下划线或连字符（最多 100 字）。');
  if (!['stdio', 'http', 'sse'].includes(input.transport)) throw new Error('未知 MCP 传输类型。');
  if (Array.isArray(input.enabledTools) && input.enabledTools.includes('claude-code')) throw new Error('Claude Code MCP 暂不支持，请在 Claude Code 中独立配置。');
  if (!Array.isArray(input.enabledTools) || input.enabledTools.some(tool => !TOOL_IDS.includes(tool))) throw new Error('工具选择有误。');
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string'))) throw new Error('参数必须是字符串数组。');
  for (const field of ['command', 'cwd', 'url', 'description'] as const) if (input[field] !== undefined && typeof input[field] !== 'string') throw new Error('MCP 字段必须是字符串。');
  record(input.env, '环境变量'); record(input.headers, 'HTTP Headers');
  for (const field of ['deleteEnvKeys', 'deleteHeaderKeys'] as const) if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field]!.some(key => typeof key !== 'string'))) throw new Error('待删除键必须是字符串数组。');
  if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('stdio MCP 需要启动命令。');
  if (input.command && (input.command.includes(MCP_SECRET_PLACEHOLDER) || inlineCommandCredentials(input.command))) throw new Error('启动命令包含内联凭据，请将命令和参数分开，并在参数或 Env/Headers 中保存凭据。');
  if (input.transport !== 'stdio') {
    try { const url = new URL(input.url ?? ''); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { throw new Error('远程 MCP 需要 HTTP(S) 地址，凭据请放在 Headers 中。'); }
  }
}
function retainSecrets(previous: Record<string, string>, input: Record<string, string> | undefined, removals: string[] | undefined): Record<string, string> {
  const next = { ...previous };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (hasPlaceholder(value)) throw new Error('Env/Headers 请留空以保留原值，不能保存隐藏凭据占位符。');
    if (value !== '' || !(key in previous)) next[key] = value;
  }
  for (const key of removals ?? []) delete next[key];
  return next;
}

/** Keep comments and unrelated TOML sections for the conventional Codex table layout.
 * Unusual inline/table-array layouts safely fall back to a semantic round-trip.
 */
function mergeCodexToml(original: string | null, data: Record<string, unknown>, entries: Record<string, unknown>, touched: string[]): string {
  const fallback = () => stringifyToml({ ...data, mcp_servers: entries } as Parameters<typeof stringifyToml>[0]);
  if (!original) return fallback();
  const blocks = [...original.matchAll(/^\s*(\[.+\])\s*(?:#.*)?\r?$/gm)];
  const removed: { start: number; end: number }[] = [];
  const touchedSet = new Set(touched); const found = new Set<string>();
  for (let index = 0; index < blocks.length; index++) {
    const match = blocks[index]; const header = match[1];
    if (header.startsWith('[[')) { if (header.includes('mcp_servers')) return fallback(); continue; }
    let path: string[] = [];
    try {
      const probe = parseToml(header + '\n__modeldock_probe__ = true');
      const walk = (value: unknown, prefix: string[]): void => {
        if (!isObject(value)) return;
        if (value.__modeldock_probe__ === true) { path = prefix; return; }
        for (const [key, nested] of Object.entries(value)) walk(nested, [...prefix, key]);
      };
      walk(probe, []);
    } catch { return fallback(); }
    if (path[0] === 'mcp_servers' && path.length === 1) return fallback();
    if (path[0] === 'mcp_servers' && touchedSet.has(path[1])) {
      found.add(path[1]); removed.push({ start: match.index!, end: blocks[index + 1]?.index ?? original.length });
    }
  }
  const previous = isObject(data.mcp_servers) ? data.mcp_servers : {};
  if (touched.some(name => name in previous && !found.has(name))) return fallback();
  let output = original;
  for (const span of removed.reverse()) output = output.slice(0, span.start) + output.slice(span.end);
  const additions = Object.fromEntries(touched.filter(name => name in entries).map(name => [name, entries[name]]));
  if (Object.keys(additions).length) output = output.trimEnd() + '\n\n' + stringifyToml({ mcp_servers: additions } as Parameters<typeof stringifyToml>[0]);
  return output;
}

/** Global catalog -> client-specific projections, inspired by CC Switch's McpService.
 * Save/import never touch live files; only apply does. Commands are never executed here.
 */
export class McpManager {
  private readonly homeDir: string;
  private readonly codexHome: string;
  private readonly appDataDir: string;
  private readonly backupDir: string;
  private readonly openCodeConfigDir: string;
  constructor(private readonly store: McpStore, options: McpOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.codexHome = options.codexHome ?? join(this.homeDir, '.codex');
    const platform = options.platform ?? process.platform;
    this.appDataDir = options.appDataDir ?? (platform === 'win32' ? process.env.APPDATA ?? join(this.homeDir, 'AppData', 'Roaming')
      : platform === 'darwin' ? join(this.homeDir, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME ?? join(this.homeDir, '.config'));
    this.backupDir = options.backupDir ?? join(this.homeDir, '.modeldock', 'backups');
    this.openCodeConfigDir = openCodeConfigDirectory(options.homeDir, options.configHome);
  }
  private state(): McpState { return clone(this.store.getManagedState(STATE_KEY, DEFAULT_STATE)); }
  private put(state: McpState): void { state.revision++; this.store.setManagedState(STATE_KEY, state); }
  list(): McpServer[] { return this.state().servers.map(safeServer); }
  save(input: McpServerInput): McpServer {
    validateServer(input);
    const state = this.state();
    const previous = input.id ? state.servers.find(server => server.id === input.id) : undefined;
    if (input.id && !previous) throw new Error('MCP 已不存在，请刷新。');
    if (state.servers.some(server => server.name === input.name && server.id !== previous?.id)) throw new Error('已有同名 MCP，请编辑原记录。');
    const server: StoredServer = {
      id: previous?.id ?? randomUUID(), name: input.name, transport: input.transport,
      command: input.command?.trim() ?? '', args: restoreArgs(input.args ?? [], previous?.args), cwd: input.cwd ?? '', url: restoreUrl(input.url ?? '', previous?.url),
      env: retainSecrets(previous?.env ?? {}, input.env, input.deleteEnvKeys),
      headers: retainSecrets(previous?.headers ?? {}, input.headers, input.deleteHeaderKeys),
      enabledTools: [...new Set(input.enabledTools)], description: input.description ?? '', importedFrom: previous?.importedFrom,
      nativeConfigs: previous?.nativeConfigs,
    };
    if (previous) state.servers[state.servers.indexOf(previous)] = server; else state.servers.push(server);
    this.put(state); return safeServer(server);
  }
  remove(id: string): void {
    const state = this.state(); state.servers = state.servers.filter(server => server.id !== id); this.put(state);
    // Keep ownership hashes until a later explicit apply removes the managed projection.
  }
  setToolEnabled(id: string, tool: ToolId, enabled: boolean): McpServer {
    validateTool(tool); const state = this.state(); const server = state.servers.find(entry => entry.id === id);
    if (!server) throw new Error('MCP 已不存在，请刷新。');
    server.enabledTools = server.enabledTools.filter(entry => entry !== tool); if (enabled) server.enabledTools.push(tool);
    this.put(state); return safeServer(server);
  }
  private path(tool: ToolId): string {
    validateTool(tool);
    if (tool === 'codex') return join(this.codexHome, 'config.toml');
    if (tool === 'copilot') return join(this.homeDir, '.copilot', 'mcp-config.json');
    if (tool === 'vscode') return join(this.appDataDir, 'Code', 'User', 'mcp.json');
    if (tool === 'dsh') return 'modeldock-dsh-mcp.json';
    const configDir = this.openCodeConfigDir;
    return existsSync(join(configDir, 'opencode.jsonc')) ? join(configDir, 'opencode.jsonc') : join(configDir, 'opencode.json');
  }
  private key(tool: ToolId): string { return tool === 'codex' ? 'mcp_servers' : tool === 'vscode' ? 'servers' : tool === 'opencode' ? 'mcp' : 'mcpServers'; }
  private read(tool: ToolId): { filename: string; original: string | null; data: Record<string, unknown>; entries: Record<string, unknown> } {
    const filename = this.path(tool);
    let original: string | null = null;
    if (tool !== 'dsh' && existsSync(filename)) {
      if (lstatSync(filename).isSymbolicLink()) throw new Error('配置文件是符号链接，请通过客户端配置入口管理。');
      if (!statSync(filename).isFile() || statSync(filename).size > MAX_FILE_BYTES) throw new Error('配置文件不受支持或过大。');
      try { original = readFileSync(filename, 'utf8'); } catch { throw new Error('无法读取工具配置，请检查权限。'); }
    }
    let data: unknown;
    try {
      if (tool === 'codex') data = original ? parseToml(original) : {};
      else { const errors: ParseError[] = []; data = original ? parseJsonc(original, errors, { allowTrailingComma: true }) : {}; if (errors.length) throw new Error(); }
    } catch { throw new Error('工具配置格式有误，未修改原文件。'); }
    if (!isObject(data) || (data[this.key(tool)] !== undefined && !isObject(data[this.key(tool)]))) throw new Error('工具 MCP 配置必须是对象，未修改原文件。');
    return { filename, original, data, entries: (data[this.key(tool)] ?? {}) as Record<string, unknown> };
  }
  private decode(tool: ToolId, name: string, entry: unknown): StoredServer {
    if (!isObject(entry)) throw new Error('MCP 配置不是对象。');
    let transport: McpTransport = 'stdio';
    if (tool === 'codex') transport = typeof entry.url === 'string' ? 'http' : 'stdio';
    else if (tool === 'opencode') { if (entry.type === 'remote') transport = 'http'; else if (entry.type !== 'local') throw new Error('未知 OpenCode MCP 类型。'); }
    else if (entry.type === 'http' || entry.type === 'streamable-http') transport = 'http';
    else if (entry.type === 'sse') transport = 'sse';
    else if (entry.type !== undefined && entry.type !== 'local' && entry.type !== 'stdio') throw new Error('未知 MCP 类型。');
    let command = entry.command; let args = entry.args;
    if (tool === 'opencode' && Array.isArray(command)) { args = command.slice(1); command = command[0]; }
    const envValue = tool === 'opencode' ? entry.environment : entry.env;
    if (envValue !== undefined && (!isObject(envValue) || Object.values(envValue).some(value => typeof value !== 'string' && !(tool === 'vscode' && (value === null || typeof value === 'number'))))) throw new Error('环境变量格式不受支持。');
    // VS Code supports null/number env entries; retain native form separately and expose string values only.
    const env = isObject(envValue) ? Object.fromEntries(Object.entries(envValue).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {};
    const server: StoredServer = { id: randomUUID(), name, transport, command: typeof command === 'string' ? command : '',
      args: Array.isArray(args) ? args as string[] : [], cwd: typeof entry.cwd === 'string' ? entry.cwd : '', url: typeof entry.url === 'string' ? entry.url : '',
      env, headers: record(tool === 'codex' ? entry.http_headers : entry.headers, 'HTTP Headers'),
      enabledTools: entry.enabled === false ? [] : [tool], description: '', importedFrom: tool, nativeConfigs: { [tool]: clone(entry) } };
    if (server.args.some(hasPlaceholder) || hasPlaceholder(server.url) || [...Object.values(server.env), ...Object.values(server.headers)].some(hasPlaceholder)) throw new Error('导入的隐藏凭据占位符没有对应的真实值。');
    validateServer(server); return server;
  }
  importFromTool(tool: ToolId): McpImportResult {
    if (tool === 'dsh') return { tool, filename: this.path(tool), imported: 0, skipped: 0, warnings: ['DSH 尚无已核实的统一原生 MCP 配置路径，仅提供导出片段。'] };
    const file = this.read(tool); const state = this.state(); let imported = 0; let skipped = 0; const warnings: string[] = [];
    for (const [name, entry] of Object.entries(file.entries)) {
      try {
        const server = this.decode(tool, name, entry); const old = state.servers.find(existing => existing.name === name);
        if (old) {
          // Never replace catalog credentials/specification merely because another client has the same name.
          if (hash(this.encode(old, tool)) === hash(entry)) {
            if (server.enabledTools.includes(tool) && !old.enabledTools.includes(tool)) old.enabledTools.push(tool);
            old.nativeConfigs = { ...old.nativeConfigs, [tool]: clone(entry) as Record<string, unknown> };
          } else warnings.push(`${name} 与全局目录同名但配置不同，已保留原记录。`);
          skipped++;
        } else { state.servers.push(server); imported++; }
      } catch { skipped++; warnings.push(`${name} 配置不受支持，已跳过并保留原文件。`); }
    }
    if (imported || skipped) this.put(state);
    return { tool, filename: file.filename, imported, skipped, warnings };
  }
  private encode(server: StoredServer, tool: ToolId): Record<string, unknown> {
    const result = { ...(server.nativeConfigs?.[tool] ?? {}) };
    if (tool === 'codex' && server.transport === 'sse') throw new Error(`${server.name} 使用 SSE，Codex 原生配置仅支持 stdio / Streamable HTTP。`);
    // Remove core fields from a previous transport; retain client-specific options (timeouts, OAuth, inputs, tool policies).
    for (const key of ['command', 'args', 'url', 'env', 'environment', 'headers', 'http_headers', 'cwd']) delete result[key];
    if (tool === 'codex') { delete result.type; result.enabled = true; }
    else if (tool === 'opencode') { result.type = server.transport === 'stdio' ? 'local' : 'remote'; result.enabled = true; }
    else result.type = server.transport === 'stdio' ? (tool === 'copilot' ? 'local' : 'stdio') : server.transport;
    if (server.transport === 'stdio') {
      result.command = tool === 'opencode' ? [server.command, ...server.args] : server.command;
      if (tool !== 'opencode') result.args = server.args;
      // Keep native numeric/null env entries which are not editable in the normalized catalog.
      const nativeEnv = server.nativeConfigs?.[tool]?.[tool === 'opencode' ? 'environment' : 'env'];
      const otherEnv = isObject(nativeEnv) ? Object.fromEntries(Object.entries(nativeEnv).filter(([, value]) => typeof value !== 'string')) : {};
      const env = { ...otherEnv, ...server.env }; if (Object.keys(env).length) result[tool === 'opencode' ? 'environment' : 'env'] = env;
      if (server.cwd) result.cwd = server.cwd;
    } else {
      result.url = server.url;
      if (Object.keys(server.headers).length) result[tool === 'codex' ? 'http_headers' : 'headers'] = server.headers;
    }
    if (tool === 'copilot' && result.tools === undefined) result.tools = ['*'];
    return result;
  }
  private plan(tool: ToolId) {
    const file = this.read(tool); const state = this.state(); const desired: Record<string, unknown> = {};
    const conflicts: string[] = []; const warnings: string[] = []; const additions: string[] = []; const updates: string[] = []; const removals: string[] = [];
    const ownership = state.managed[tool] ?? {};
    for (const server of state.servers.filter(entry => entry.enabledTools.includes(tool))) {
      try { desired[server.name] = this.encode(server, tool); }
      catch { conflicts.push(`${server.name}：此工具不支持该传输方式，请取消勾选或更改类型。`); }
    }
    const entries = { ...file.entries };
    for (const [name, fingerprint] of Object.entries(ownership)) {
      if (name in desired || !(name in entries)) continue;
      if (hash(entries[name]) !== fingerprint) conflicts.push(`${name}：客户端中的受管配置已被修改，拒绝删除。`);
      else { delete entries[name]; removals.push(name); }
    }
    for (const [name, value] of Object.entries(desired)) {
      if (!(name in entries)) additions.push(name);
      else if (hash(entries[name]) !== hash(value)) {
        const imported = state.servers.find(server => server.name === name)?.nativeConfigs?.[tool];
        if (!ownership[name] && (!imported || hash(imported) !== hash(entries[name]))) conflicts.push(`${name}：已有同名非受管配置，请先导入并核对或更改名称。`);
        else if (ownership[name] && ownership[name] !== hash(entries[name])) conflicts.push(`${name}：客户端中的受管配置已被修改，拒绝覆盖。`);
        else updates.push(name);
      }
      entries[name] = value;
    }
    if (tool === 'dsh') warnings.push('DSH 原生 MCP 配置路径尚未核实，仅导出通用片段，不能标记为已接入。');
    if (tool === 'copilot') warnings.push('应用到 GitHub Copilot CLI 的共享用户配置；独立桌面应用是否加载此文件需在该版本实测。');
    if (tool === 'opencode' && state.servers.some(server => server.transport === 'sse' && server.enabledTools.includes(tool))) warnings.push('OpenCode 将 HTTP/SSE 配置为 remote，由客户端自动协商传输。');
    const fingerprint = hash({ original: file.original, revision: state.revision, filename: file.filename });
    return { file, state, entries, desired, additions, updates, removals, conflicts, warnings, fingerprint };
  }
  preview(tool: ToolId): McpConfigPreview {
    const plan = this.plan(tool);
    const projection = { [this.key(tool)]: redact(plan.desired) };
    return { tool, filename: plan.file.filename, content: tool === 'codex' ? stringifyToml(projection as Parameters<typeof stringifyToml>[0]) : JSON.stringify(projection, null, 2),
      instructions: '预览只显示所选 MCP 项；Env、Headers、敏感启动参数和 URL 查询凭据已隐藏。编辑保留占位符会保留原凭据，替换请填写新值。显式应用会备份并合并，保留其他配置。停用/删除仅移除未被手动修改的受管项。此操作不运行 MCP 命令。',
      canApply: tool !== 'dsh' && plan.conflicts.length === 0, fingerprint: plan.fingerprint,
      additions: plan.additions, updates: plan.updates, removals: plan.removals, conflicts: plan.conflicts, warnings: plan.warnings };
  }
  apply(tool: ToolId, expectedFingerprint?: string): McpApplyResult {
    if (tool === 'dsh') throw new Error('DSH 暂仅支持导出，未修改任何工具配置。');
    const filename = this.path(tool); mkdirSync(dirname(filename), { recursive: true });
    const lockPath = filename + '.modeldock.lock'; let lock: number;
    try { lock = openSync(lockPath, 'wx', 0o600); } catch { throw new Error('此配置正在由其他 ModelDock 操作写入，请稍后重试。'); }
    let temporary = ''; let backupPath: string | undefined;
    try {
      const plan = this.plan(tool);
      if (expectedFingerprint && expectedFingerprint !== plan.fingerprint) throw new Error('配置或全局目录在预览后发生变化，请重新预览。');
      if (plan.conflicts.length) throw new Error(plan.conflicts.join('\n'));
      const changed = plan.additions.length + plan.updates.length + plan.removals.length > 0;
      const previous = clone(plan.state.managed[tool] ?? {});
      plan.state.managed[tool] = Object.fromEntries(Object.entries(plan.desired).map(([name, value]) => [name, hash(value)]));
      if (!changed) { this.put(plan.state); return { tool, filename, changed: false, count: Object.keys(plan.desired).length }; }
      let output: string;
      if (tool === 'codex') output = mergeCodexToml(plan.file.original, plan.file.data, plan.entries, [...plan.additions, ...plan.updates, ...plan.removals]);
      else {
        output = plan.file.original ?? '{}'; const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
        for (const name of plan.removals) output = applyEdits(output, modify(output, [this.key(tool), name], undefined, options));
        for (const name of [...plan.additions, ...plan.updates]) output = applyEdits(output, modify(output, [this.key(tool), name], plan.desired[name], options));
      }
      if (existsSync(filename)) accessSync(filename, constants.W_OK); accessSync(dirname(filename), constants.W_OK);
      if (plan.file.original !== null) {
        mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
        backupPath = join(this.backupDir, `mcp-${tool}-${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
        copyFileSync(filename, backupPath); chmodSync(backupPath, 0o600);
      }
      const unchanged = () => plan.file.original === null ? !existsSync(filename) : existsSync(filename) && readFileSync(filename, 'utf8') === plan.file.original;
      if (!unchanged()) throw new Error('配置刚被其他程序修改，未覆盖，请重新预览。');
      temporary = filename + `.modeldock-${randomUUID()}.tmp`; writeFileSync(temporary, output, { mode: 0o600 });
      if (!unchanged()) throw new Error('配置刚被其他程序修改，未覆盖，请重新预览。');
      // Persist ownership first; roll it back if atomic replacement fails.
      this.put(plan.state);
      try { renameSync(temporary, filename); temporary = ''; }
      catch (error) { plan.state.managed[tool] = previous; this.put(plan.state); throw error; }
      return { tool, filename, backupPath, changed: true, count: Object.keys(plan.desired).length };
    } catch (error) {
      if (error instanceof Error && !('code' in error)) throw error;
      throw new Error('MCP 配置写入失败，请检查目录和文件权限；原配置已保留。');
    } finally { if (temporary && existsSync(temporary)) unlinkSync(temporary); closeSync(lock); if (existsSync(lockPath)) unlinkSync(lockPath); }
  }
}
