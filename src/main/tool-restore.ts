import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { parse as parseJsonc, modify, type ParseError } from 'jsonc-parser';
import type { ToolId } from '../shared/types';
import { codexHistoryKey, editJsonc } from './adapters';
import { restoreDshOfficialConfig, type DshApplyOptions, type DshConfigStore } from './dsh-config';
import { applyCopilotDesktop, type CopilotSyncOptions } from './copilot-sync';
import { openCodeConfigDirectory } from './opencode-paths';

export interface ToolRestoreStore extends DshConfigStore {}
export interface ToolRestoreOptions {
  codexHome?: string;
  configHome?: string;
  dshHome?: string;
  copilotHome?: string;
  dshOptions?: DshApplyOptions;
  copilotOptions?: CopilotSyncOptions;
  /** Private transaction test seam; never supplied by a renderer. */
  beforeCommit?: () => void;
}
interface FileChange { path: string; original: string | null; content: string | null }
const maximumFileSize = 2 * 1024 * 1024;
const jsonOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safeDirectory(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('工具配置目录或父目录是链接或非目录，未还原配置。');
    }
    if (dirname(current) === current) break;
  }
}
function readConfig(path: string): string | null {
  safeDirectory(dirname(path));
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumFileSize) throw new Error('工具配置文件类型或大小不受支持，未还原配置。');
  return readFileSync(path, 'utf8');
}
function parseJson(text: string, label: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`${label} 配置格式有误，未修改原文件。`);
  return value;
}
function currentMatches(change: FileChange, content = change.original): boolean {
  return content === null ? !existsSync(change.path) : existsSync(change.path) && readConfig(change.path) === content;
}
function replaceFile(path: string, content: string | null) {
  if (content === null) { if (existsSync(path)) unlinkSync(path); return; }
  safeDirectory(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.modeldock-${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function ownsCatalog(text: string): boolean {
  try {
    const value = JSON.parse(text);
    return record(value) && Array.isArray(value.models) && value.models.every(model => record(model) && typeof model.description === 'string' && model.description.startsWith('ModelDock · '));
  } catch { return false; }
}
function clearCodexSelection(config: Record<string, any>) {
  for (const key of ['model', 'model_provider', 'model_catalog_json', 'openai_base_url', 'chatgpt_base_url']) delete config[key];
}
/** Explicitly restore native model sources, retaining account authorization and
 * unrelated settings. Calling this never requires an enabled ModelDock binding. */
export async function restoreOfficialConfig(store: ToolRestoreStore, tool: ToolId, appData: string, backups: string,
  homeDirectory = homedir(), options: ToolRestoreOptions = {}): Promise<string> {
  if (tool === 'copilot') return applyCopilotDesktop(store, { providers: [] }, options.copilotHome ?? join(homeDirectory, '.copilot'), { ...options.copilotOptions, syncScope: 'selected' });
  if (tool === 'dsh') return restoreDshOfficialConfig(store, options.dshHome ?? join(homeDirectory, '.dsh'), options.dshOptions);
  if (!['codex', 'opencode', 'vscode'].includes(tool)) throw new Error('不支持的工具，未还原配置。');
  const openCodeHome = openCodeConfigDirectory(homeDirectory, options.configHome);
  const jsoncPath = join(openCodeHome, 'opencode.jsonc');
  const target = tool === 'codex' ? join(options.codexHome ?? join(homeDirectory, '.codex'), 'config.toml')
    : tool === 'opencode' ? existsSync(jsoncPath) ? jsoncPath : join(openCodeHome, 'opencode.json')
      : join(appData, 'Code', 'User', 'chatLanguageModels.json');
  const original = readConfig(target);
  const changes: FileChange[] = [];
  let state: { key: string; original: unknown } | undefined;
  if (tool === 'codex') {
    state = { key: codexHistoryKey(target), original: store.getManagedState(codexHistoryKey(target), null) };
    if (original !== null) {
      let value: Record<string, any>;
      try { value = parseToml(original); } catch { throw new Error('Codex 配置格式有误，未修改原文件。'); }
      if (!record(value) || value.model_providers !== undefined && !record(value.model_providers)
        || value.profiles !== undefined && !record(value.profiles) || value.profile !== undefined && typeof value.profile !== 'string') throw new Error('Codex 模型配置格式有误，未修改原文件。');
      clearCodexSelection(value);
      if (value.profile && value.profiles?.[value.profile] !== undefined) {
        if (!record(value.profiles[value.profile])) throw new Error('Codex 当前 profile 配置格式有误，未修改原文件。');
        clearCodexSelection(value.profiles[value.profile]);
      }
      if (value.model_providers) {
        // A provider with the built-in id can override OpenAI's official URL.
        delete value.model_providers.modeldock; delete value.model_providers.openai;
        if (!Object.keys(value.model_providers).length) delete value.model_providers;
      }
      const output = stringifyToml(value as Parameters<typeof stringifyToml>[0]);
      parseToml(output);
      changes.push({ path: target, original, content: output });
    }
    const catalogPath = join(dirname(target), 'modeldock-models.json');
    const catalog = readConfig(catalogPath);
    if (catalog !== null && ownsCatalog(catalog)) changes.push({ path: catalogPath, original: catalog, content: null });
  } else if (original !== null) {
    let output = original;
    const value = parseJson(original, tool === 'opencode' ? 'OpenCode' : 'VS Code');
    if (tool === 'opencode') {
      if (!record(value) || value.provider !== undefined && !record(value.provider)) throw new Error('OpenCode provider 配置格式有误，未修改原文件。');
      for (const section of ['agent', 'command']) {
        if (value[section] === undefined) continue;
        if (!record(value[section]) || Object.values(value[section]).some(entry => !record(entry))) throw new Error('OpenCode 模型覆盖配置格式有误，未修改原文件。');
        for (const [name, entry] of Object.entries(value[section]) as [string, Record<string, unknown>][]) {
          if (Object.hasOwn(entry, 'model')) output = editJsonc(output, modify(output, [section, name, 'model'], undefined, jsonOptions));
        }
      }
      // These are model-source overrides only. Auth, MCP, agents and skills are
      // intentionally outside this file edit's scope.
      for (const key of ['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers']) {
        if (Object.hasOwn(value, key)) output = editJsonc(output, modify(output, [key], undefined, jsonOptions));
      }
    } else {
      if (!Array.isArray(value)) throw new Error('VS Code 模型文件不是数组，未修改原文件。');
      for (let index = value.length - 1; index >= 0; index--) if (record(value[index]) && value[index].vendor === 'customendpoint') output = editJsonc(output, modify(output, [index], undefined, jsonOptions));
    }
    parseJson(output, tool === 'opencode' ? 'OpenCode' : 'VS Code');
    changes.push({ path: target, original, content: output });
  }
  const changed = changes.filter(change => change.original !== change.content);
  if (!changed.length && (!state || state.original === null)) return target;
  safeDirectory(backups);
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  for (const [index, change] of changed.entries()) if (change.original !== null) {
    if (!currentMatches(change)) throw new Error('配置刚被其他程序修改，还原未执行，请重试。');
    const backupPath = join(backups, `${tool}-official-${stamp}${index ? `-${index}` : ''}.bak`);
    copyFileSync(change.path, backupPath); chmodSync(backupPath, 0o600);
    if (readFileSync(backupPath, 'utf8') !== change.original) throw new Error('配置备份验证失败，还原未执行。');
  }
  const committed: FileChange[] = [];
  let stateWritten = false;
  try {
    options.beforeCommit?.();
    if (changed.some(change => !currentMatches(change))) throw new Error('配置刚被其他程序修改，还原未执行，请重试。');
    if (state) { store.setManagedState(state.key, null); stateWritten = true; }
    for (const change of changed) {
      if (!currentMatches(change)) throw new Error('配置刚被其他程序修改，请重试。');
      replaceFile(change.path, change.content); committed.push(change);
    }
    if (changed.some(change => !currentMatches(change, change.content))) throw new Error('官方配置写入验证失败。');
    return target;
  } catch (error) {
    for (const change of committed.reverse()) {
      if (!currentMatches(change, change.content)) throw new Error('还原失败，配置又被其他程序修改；已保留原配置备份。');
      replaceFile(change.path, change.original);
    }
    if (state && stateWritten) store.setManagedState(state.key, state.original);
    throw error;
  }
}
