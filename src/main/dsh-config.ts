import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument, Document, YAMLSeq, type YAMLMap, type Node } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { DSH_LEGACY_PLUGIN_ID, DSH_LEGACY_SCRIPT, DSH_LEGACY_PLUGIN_SOURCE, dshLegacyPluginEntry, validateDshLegacyDispatch, type DshLegacyDispatchPlan } from './dsh-runtime';
import { isReasoningEffort } from '../shared/types';

export interface DshProviderProfile {
  displayName: string; baseURL: string; apiKeyEnv: string;
  api: 'openai-completions' | 'openai-responses';
  models: { id: string; name: string; contextWindow: number; maxTokens: number; input: ('text' | 'image')[]; reasoningEfforts?: string[] }[];
}
export interface DshPlan {
  syncScope?: 'managed' | 'selected';
  providers: Record<string, DshProviderProfile>;
  credentials: Record<string, string>;
  defaultModel?: { provider: string; model: string };
  legacyDispatch?: DshLegacyDispatchPlan;
}
export interface DshConfigStore {
  dataDir: string;
  getManagedState<T>(key: string, fallback: T): T;
  setManagedState(key: string, value: unknown): void;
  createManagedBackup(kind: string, value: unknown): string;
}
export interface DshApplyOptions {
  /** Pure native profile composition supplies model-only plugin entries. */
  modelPlugins?: DshModelPlugin[];
  /** Providers from native profile layers before ModelDock's home override. */
  baselineProviders?: Record<string, unknown>;
  /** Tests inject a failing replacement without changing the production path. */
  replaceFile?: (path: string, content: string | null) => void;
  beforeCommit?: () => void;
}
export interface DshModelPlugin { id: string; name: string }
type PluginId = 'llm-pi-ai' | 'agent-default-model';
interface RowSnapshot { index: number; yaml: string }
interface FileSnapshot { path: string; before: string | null; after: string | null }
interface History {
  version: 3; target: string; syncScope: 'managed' | 'selected';
  originalRows: Partial<Record<PluginId, RowSnapshot | null>>;
  installedRows: Partial<Record<PluginId, unknown>>;
  originalRefs: Record<string, string | null>;
  installedRefs: Record<string, string>;
  suppressedRows: Record<string, { original: RowSnapshot | null; installed: unknown; name: string }>;
  baselineProviders: Record<string, unknown>;
  runtime?: { scriptHash: string; installedPlugin?: unknown };
  pending?: { files: FileSnapshot[]; previous: History; complete: History; backupPath: string };
}
const pluginIds: PluginId[] = ['llm-pi-ai', 'agent-default-model'];
const sourcePluginNames = new Set(['@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account', '@deepseek-ai/dsh-llm-pi-ai']);
const shippedSources: DshModelPlugin[] = [
  { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
  { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
];
const refPattern = /^MODELDOCK_DSH_[A-F0-9]{20}_API_KEY$/;
const maximumFileSize = 2 * 1024 * 1024;
type PatchDocument = Document<YAMLSeq> & { contents: YAMLSeq };
type CredentialDocument = Document<YAMLMap> & { contents: YAMLMap };
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fail(message: string): never { throw new Error(message); }
function copy<T>(value: T): T { return structuredClone(value); }
function safeDirectoryTree(directory: string) {
  // DSH_HOME can be customized, but reparse-point aliases must not bypass
  // target ownership and cause native credentials to be written elsewhere.
  for (let path = directory; ; path = dirname(path)) {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('DSH 数据目录或父目录是链接或非目录，未修改配置。');
    }
    if (dirname(path) === path) break;
  }
}
function normalizedHome(home: string): string {
  if (typeof home !== 'string' || !home.trim() || !isAbsolute(home) || /[\0\r\n]/.test(home)) fail('DSH 数据目录无效，未修改配置。');
  const target = resolve(home); safeDirectoryTree(target); return target;
}
function safeFile(path: string): string | null {
  safeDirectoryTree(dirname(path));
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumFileSize) fail('DSH 配置文件类型或大小不受支持，未修改配置。');
  return readFileSync(path, 'utf8');
}
function parsed(text: string | null, label: string): Document {
  // Native DSH's !!js values are expressions, not JavaScript to execute here.
  // Keep the tagged scalar intact so disabling/restoring a source is reversible.
  const document = parseDocument(text ?? '', { uniqueKeys: true, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (document.errors.length || document.warnings.length) fail(`DSH ${label} YAML 格式有误，未修改原文件。`);
  return document as unknown as Document;
}
function patchDocument(text: string | null) {
  const document = parsed(text, '插件配置');
  if (document.contents === null) document.contents = new YAMLSeq();
  if (!isSeq(document.contents)) fail('DSH 插件配置必须是数组，未修改原文件。');
  for (const id of pluginIds) findSourceRow(document as PatchDocument, id);
  return document as PatchDocument;
}
function findRow(document: PatchDocument, id: PluginId): { node: YAMLMap; index: number; sequence: YAMLSeq } | undefined {
  return findSourceRow(document, id);
}
function findSourceRow(document: PatchDocument, id: string): { node: YAMLMap; index: number; sequence: YAMLSeq } | undefined {
  const found: { node: YAMLMap; index: number; sequence: YAMLSeq }[] = [];
  function visit(sequence: YAMLSeq) {
    sequence.items.forEach((node, index) => {
      if (!isMap(node)) return;
      if (node.get('id') === id) found.push({ node, index, sequence });
      const inserted = node.get('insert', true); if (isSeq(inserted)) visit(inserted);
      const children = node.get('config', true); if (node.get('group') === true && isSeq(children)) visit(children);
    });
  }
  visit(document.contents);
  if (found.length > 1) fail('DSH 模型来源插件 ID 重复，未修改原文件。');
  return found[0];
}
function suppressiblePlugins(value: DshModelPlugin[] | undefined): DshModelPlugin[] {
  const plugins = value ?? shippedSources;
  if (!Array.isArray(plugins) || plugins.some(plugin => !record(plugin) || typeof plugin.id !== 'string' || !plugin.id || /[\0\r\n]/.test(plugin.id) || typeof plugin.name !== 'string' || !sourcePluginNames.has(plugin.name))) fail('DSH 本机模型来源解析无效，未修改原文件。');
  const ids = new Map<string, string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id) && ids.get(plugin.id) !== plugin.name) fail('DSH profile 的模型来源 ID 存在冲突，未修改原文件。');
    ids.set(plugin.id, plugin.name);
  }
  return [...ids].filter(([id]) => id !== 'llm-pi-ai').map(([id, name]) => ({ id, name }));
}
function snapshotNode(snapshot: RowSnapshot): YAMLMap {
  const document = patchDocument(snapshot.yaml);
  if (document.contents.items.length !== 1 || !isMap(document.contents.items[0])) fail('DSH 模型来源恢复记录无效。');
  return document.contents.items[0];
}
function restoreSuppressed(document: PatchDocument, id: string, state: History['suppressedRows'][string]) {
  const current = findSourceRow(document, id); if (!current) return;
  const disabled = current.node.get('disabled', true);
  // A changed enable flag or explicit plugin name belongs to the user.
  if (!disabled || typeof disabled !== 'object' || !('value' in disabled) || disabled.value !== true || disabled.tag
    || current.node.has('name') && current.node.get('name') !== state.name) return;
  if (state.original === null) {
    if (isDeepStrictEqual(current.node.toJSON(), state.installed)) current.sequence.items.splice(current.index, 1);
    else current.node.delete('disabled');
  } else {
    const original = snapshotNode(state.original);
    if (original.has('disabled')) current.node.set('disabled', (original.get('disabled', true) as Node).clone());
    else current.node.delete('disabled');
  }
}
function originalProviders(history: History): Record<string, unknown> {
  const snapshot = history.originalRows['llm-pi-ai'];
  if (!snapshot) return {};
  const config = snapshotNode(snapshot).get('config', true), providers = isMap(config) ? config.get('providers', true) : undefined;
  if (providers === undefined || providers === null) return {};
  if (!isMap(providers)) fail('DSH 原模型来源配置格式有误，未修改原文件。');
  const value = providers.toJSON(); if (!record(value)) fail('DSH 原模型来源配置格式有误，未修改原文件。');
  return value;
}
function serializeRow(node: YAMLMap, index: number): RowSnapshot {
  const document = new Document(); document.contents = new YAMLSeq();
  document.contents.add(node.clone());
  return { index, yaml: document.toString() };
}
function restoreRow(document: PatchDocument, id: PluginId, original: RowSnapshot | null) {
  const existing = findRow(document, id);
  if (original === null) { if (existing) existing.sequence.items.splice(existing.index, 1); return; }
  const source = patchDocument(original.yaml);
  if (source.contents.items.length !== 1 || !findRow(source, id)) fail('DSH 配置恢复记录无效。');
  const node = (source.contents.items[0] as Node).clone();
  if (existing) existing.sequence.items.splice(existing.index, 1, node);
  else document.contents.items.splice(Math.min(original.index, document.contents.items.length), 0, node);
}
function credentialDocument(text: string | null) {
  const document = parsed(text, '凭据配置');
  if (document.contents === null) document.contents = document.createNode({ version: 1, refs: {}, records: {} });
  if (!isMap(document.contents)) fail('DSH 凭据配置必须是对象，未修改原文件。');
  let value: unknown;
  try { value = document.toJS(); } catch { fail('DSH 凭据 YAML 无法安全解析，未修改原文件。'); }
  if (!record(value) || Object.keys(value).some(key => !['version', 'refs', 'records'].includes(key)) || value.version !== 1 || !record(value.refs) || !record(value.records)
    || Object.entries(value.refs).some(([key, secret]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof secret !== 'string' || !secret)) fail('DSH 凭据配置格式有误，未修改原文件。');
  if (!isMap(document.get('refs', true))) fail('DSH 凭据 refs 必须是对象，未修改原文件。');
  return document as CredentialDocument;
}
export function validateDshPlan(value: DshPlan): DshPlan {
  if (!record(value) || Object.keys(value).some(key => !['syncScope', 'providers', 'credentials', 'defaultModel', 'legacyDispatch'].includes(key)) || value.syncScope !== undefined && !['managed', 'selected'].includes(value.syncScope) || !record(value.providers) || !record(value.credentials)) fail('DSH 同步配置无效。');
  const references = new Set<string>();
  for (const [id, provider] of Object.entries(value.providers)) {
    if (!/^modeldock(?:-[a-zA-Z0-9_.%~-]+)?$/.test(id) || !record(provider) || Object.keys(provider).some(key => !['displayName', 'baseURL', 'apiKeyEnv', 'api', 'models'].includes(key)) || typeof provider.displayName !== 'string' || !provider.displayName || typeof provider.baseURL !== 'string'
      || !['openai-completions', 'openai-responses'].includes(provider.api) || !refPattern.test(provider.apiKeyEnv) || !Array.isArray(provider.models) || !provider.models.length) fail('DSH 同步供应商配置无效。');
    let url: URL; try { url = new URL(provider.baseURL); } catch { fail('DSH 同步地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('DSH 同步地址无效。');
    references.add(provider.apiKeyEnv);
    const seen = new Set<string>();
    for (const model of provider.models) {
      if (!record(model) || Object.keys(model).some(key => !['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].includes(key)) || typeof model.id !== 'string' || !model.id || /[\0\r\n]/.test(model.id) || seen.has(model.id) || typeof model.name !== 'string' || !model.name
        || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow
        || !Array.isArray(model.input) || !model.input.includes('text') || model.input.some(input => input !== 'text' && input !== 'image')
        || model.reasoningEfforts !== undefined && (!Array.isArray(model.reasoningEfforts) || !model.reasoningEfforts.length || model.reasoningEfforts.length > 7 || new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length || model.reasoningEfforts.some((level: unknown) => !isReasoningEffort(level)))) fail('DSH 同步模型配置无效。');
      seen.add(model.id);
    }
  }
  if (Object.entries(value.credentials).some(([key, secret]) => !references.has(key) || typeof secret !== 'string' || !secret || /[\0\r\n]/.test(secret)) || [...references].some(key => !value.credentials[key])) fail('DSH 同步凭据配置无效。');
  if (Object.keys(value.providers).length) {
    if (!record(value.defaultModel) || Object.keys(value.defaultModel).some(key => !['provider', 'model'].includes(key)) || !value.providers[value.defaultModel.provider]?.models.some(model => model.id === value.defaultModel!.model)) fail('DSH 默认模型配置无效。');
  } else if (value.defaultModel !== undefined) fail('DSH 默认模型配置无效。');
  if (value.legacyDispatch !== undefined) {
    if ((value.syncScope ?? 'selected') !== 'selected') fail('DSH 旧会话兼容仅用于所选来源范围。');
    validateDshLegacyDispatch(value.legacyDispatch, value.providers);
  }
  return copy(value);
}
/** Native home override fragment. Credential values live only in .credentials.yaml. */
export function dshPatchPreview(plan: DshPlan): string {
  const selected = (plan.syncScope ?? 'selected') === 'selected';
  const rows: unknown[] = Object.keys(plan.providers).length || selected ? [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: false, config: { providers: plan.providers } }] : [];
  if (plan.defaultModel) rows.push({ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: plan.defaultModel });
  if (selected) rows.push(...shippedSources.map(plugin => ({ id: plugin.id, disabled: true })));
  if (plan.legacyDispatch) rows.push({ insert: [{ id: DSH_LEGACY_PLUGIN_ID, name: '<DSH_HOME>/.modeldock/legacy-dispatch.cjs', config: plan.legacyDispatch }] });
  return new Document(rows).toString();
}
function replaceAtomic(path: string, content: string | null) {
  safeDirectoryTree(dirname(path));
  if (content === null) { if (existsSync(path)) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.modeldock-${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function readHistory(value: unknown, target: string): History {
  if (value === null) return { version: 3, target, syncScope: 'managed', originalRows: {}, installedRows: {}, originalRefs: {}, installedRefs: {}, suppressedRows: {}, baselineProviders: {} };
  if (!record(value) || ![1, 2, 3].includes(value.version) || value.target !== target || !record(value.originalRows) || !record(value.installedRows) || !record(value.originalRefs) || !record(value.installedRefs)
    || Object.keys(value.originalRows).some(key => !pluginIds.includes(key as PluginId)) || Object.keys(value.installedRows).some(key => !pluginIds.includes(key as PluginId))) fail('DSH 配置恢复记录无效，未修改原文件。');
  for (const id of pluginIds) {
    const row = value.originalRows[id];
    if (row !== undefined && row !== null && (!record(row) || !Number.isSafeInteger(row.index) || row.index < 0 || typeof row.yaml !== 'string' || !findRow(patchDocument(row.yaml), id))) fail('DSH 配置恢复记录无效，未修改原文件。');
  }
  if (Object.entries(value.originalRefs).some(([key, secret]) => !refPattern.test(key) || secret !== null && typeof secret !== 'string')
    || Object.entries(value.installedRefs).some(([key, secret]) => !refPattern.test(key) || typeof secret !== 'string' || !secret || !Object.hasOwn(value.originalRefs, key))) fail('DSH 配置恢复记录无效，未修改原文件。');
  const upgraded: Record<string, any> = value.version === 1 ? { ...value, version: 3, syncScope: 'managed', suppressedRows: {}, baselineProviders: {} } : { ...copy(value), version: 3 };
  if (!['managed', 'selected'].includes(upgraded.syncScope) || !record(upgraded.suppressedRows) || !record(upgraded.baselineProviders)) fail('DSH 配置恢复记录无效，未修改原文件。');
  for (const [id, state] of Object.entries(upgraded.suppressedRows)) {
    if (!id || /[\0\r\n]/.test(id) || !record(state) || !sourcePluginNames.has(state.name) || !record(state.installed) || state.installed.id !== id || state.installed.disabled !== true
      || state.original !== null && (!record(state.original) || !Number.isSafeInteger(state.original.index) || state.original.index < 0 || typeof state.original.yaml !== 'string' || snapshotNode(state.original as RowSnapshot).get('id') !== id)) fail('DSH 模型来源恢复记录无效，未修改原文件。');
  }
  if (upgraded.runtime !== undefined && (!record(upgraded.runtime) || !/^[a-f0-9]{64}$/.test(upgraded.runtime.scriptHash)
    || upgraded.runtime.installedPlugin !== undefined && (!record(upgraded.runtime.installedPlugin) || upgraded.runtime.installedPlugin.id !== DSH_LEGACY_PLUGIN_ID
      || upgraded.runtime.installedPlugin.name !== dshLegacyPluginEntry(join(target, DSH_LEGACY_SCRIPT), { version: 1, mappings: [] }).name))) fail('DSH 旧会话兼容恢复记录无效，未修改原文件。');
  if (value.pending) {
    const pending = value.pending;
    if (!record(pending) || typeof pending.backupPath !== 'string' || !Array.isArray(pending.files) || ![2, 3].includes(pending.files.length)) fail('DSH 配置恢复记录无效，未修改原文件。');
    const paths = pending.files.length === 3 ? [join(target, '.credentials.yaml'), join(target, DSH_LEGACY_SCRIPT), join(target, 'cordis.patch.yml')] : [join(target, '.credentials.yaml'), join(target, 'cordis.patch.yml')];
    if (pending.files.some((file: any, index: number) => !record(file) || file.path !== paths[index] || file.before !== null && typeof file.before !== 'string' || file.after !== null && typeof file.after !== 'string')) fail('DSH 配置恢复记录无效，未修改原文件。');
    if (pending.previous?.pending || pending.complete?.pending) fail('DSH 配置恢复记录无效，未修改原文件。');
    upgraded.pending = { ...pending, previous: readHistory(pending.previous, target), complete: readHistory(pending.complete, target) };
  }
  return copy(upgraded) as History;
}
function sameFile(path: string, contents: string | null): boolean { return safeFile(path) === contents; }
function scriptHash(contents: string): string { return createHash('sha256').update(contents).digest('hex'); }
function synchronizeCompatibility(document: PatchDocument, next: History, plan: DshPlan, scriptPath: string, original: string | null): string | null {
  const current = findSourceRow(document, DSH_LEGACY_PLUGIN_ID);
  if (plan.legacyDispatch) {
    if (original !== null && (next.runtime ? scriptHash(original) !== next.runtime.scriptHash : original !== DSH_LEGACY_PLUGIN_SOURCE)) fail('DSH 旧会话兼容脚本已被其他程序修改，未覆盖原文件。');
    if (current && (!next.runtime?.installedPlugin || !isDeepStrictEqual(current.node.toJSON(), next.runtime.installedPlugin))) fail('DSH 旧会话兼容插件已有其他配置，未覆盖原文件。');
    const entry = dshLegacyPluginEntry(scriptPath, plan.legacyDispatch);
    if (current) { current.node.set('name', entry.name); current.node.set('config', document.createNode(entry.config)); }
    else document.contents.add(document.createNode({ insert: [entry] }));
    next.runtime = { scriptHash: scriptHash(DSH_LEGACY_PLUGIN_SOURCE), installedPlugin: entry };
    return DSH_LEGACY_PLUGIN_SOURCE;
  }
  if (next.runtime?.installedPlugin) {
    if (current && !isDeepStrictEqual(current.node.toJSON(), next.runtime.installedPlugin)) fail('DSH 旧会话兼容插件刚被其他程序修改，未覆盖原配置。');
    if (current) {
      current.sequence.items.splice(current.index, 1);
      // The only insertion wrapper we create contains this one plugin. Keep
      // unrelated insertions added by the user instead of removing the wrapper.
      for (let index = document.contents.items.length - 1; index >= 0; index--) {
        const row = document.contents.items[index];
        const inserted: unknown = isMap(row) ? row.get('insert', true) : undefined;
        if (isMap(row) && isSeq(inserted) && inserted === current.sequence && !inserted.items.length && Object.keys(row.toJSON()).every(key => key === 'insert')) document.contents.items.splice(index, 1);
      }
    }
    delete next.runtime.installedPlugin;
  }
  // Leave the inactive, credential-free trusted code artifact in place. HMR
  // disposes the removed native plugin; deleting its module before HMR finishes
  // could interrupt an in-flight same-model call. No future code is overwritten
  // without comparing its recorded hash.
  return original;
}
function restoreFiles(files: FileSnapshot[], writer: (path: string, value: string | null) => void) {
  // Do not overwrite a concurrent edit: every partial file must be either its
  // captured input or the exact attempted output before restoring any of them.
  if (files.some(file => !sameFile(file.path, file.before) && !sameFile(file.path, file.after))) fail('DSH 配置被其他程序修改，自动恢复未覆盖新修改；请保留加密恢复记录。');
  for (const file of [...files].reverse()) if (!sameFile(file.path, file.before)) writer(file.path, file.before);
}
/** Native DSH 0.1.7-rc.2 home patch + credential refs. No session data is read. */
function synchronizeDshConfig(store: DshConfigStore, rawPlan: DshPlan, dshHome: string, options: DshApplyOptions = {}, officialRestore = false): string {
  const target = normalizedHome(dshHome), plan = validateDshPlan(rawPlan);
  // Native plain entry patches update existing canonical entries; adding a
  // name does not insert a missing plugin. Production metadata must prove the
  // canonical pi-ai target exists before backups, recovery or file writes.
  if (!officialRestore && options.modelPlugins !== undefined && (!Array.isArray(options.modelPlugins) || !options.modelPlugins.some(plugin => plugin?.id === 'llm-pi-ai' && plugin.name === '@deepseek-ai/dsh-llm-pi-ai'))) fail('DSH 当前 profile 缺少标准模型插件，未修改配置；请检查原生 profile。');
  const scope = plan.syncScope ?? 'selected';
  const key = `dsh-sync:${createHash('sha256').update(process.platform === 'win32' ? target.toLowerCase() : target).digest('hex')}`;
  const patchPath = join(target, 'cordis.patch.yml'), credentialPath = join(target, '.credentials.yaml');
  const runtimePath = join(target, DSH_LEGACY_SCRIPT);
  let history = readHistory(store.getManagedState<unknown>(key, null), target);
  if (history.pending) {
    try { restoreFiles(history.pending.files, replaceAtomic); store.setManagedState(key, history.pending.previous); history = history.pending.previous; }
    catch { fail('DSH 上次同步的恢复尚未完成，请检查配置文件与加密恢复记录。'); }
  }
  if (!officialRestore && scope === 'managed' && !Object.keys(plan.providers).length && !Object.keys(history.originalRows).length && !Object.keys(history.installedRefs).length && !Object.keys(history.suppressedRows).length && !history.runtime?.installedPlugin) return patchPath;
  const patchBefore = safeFile(patchPath), credentialsBefore = safeFile(credentialPath);
  const patch = patchDocument(patchBefore), credentials = credentialDocument(credentialsBefore);
  const refs = credentials.get('refs', true) as YAMLMap;
  const next = copy(history), hasProviders = Object.keys(plan.providers).length > 0;
  next.syncScope = scope;
  if (options.baselineProviders !== undefined) {
    if (!record(options.baselineProviders)) fail('DSH 原 profile 模型来源解析无效，未修改原文件。');
    next.baselineProviders = copy(options.baselineProviders);
  }
  for (const id of pluginIds) {
    const current = findRow(patch, id);
    if (hasProviders || scope === 'selected' && id === 'llm-pi-ai') {
      if (!Object.hasOwn(next.originalRows, id)) next.originalRows[id] = current ? serializeRow(current.node, current.index) : null;
      let publishedProviders: Record<string, unknown> = plan.providers;
      if (id === 'llm-pi-ai' && scope === 'managed') {
        const config = current?.node.get('config', true), native = isMap(config) ? config.get('providers', true) : undefined;
        const nativeProviders = isMap(native) ? native.toJSON() : {};
        const previousOwned = Object.keys((next.installedRows[id] as any)?.config?.providers ?? {}).filter(key => key === 'modeldock' || key.startsWith('modeldock-'));
        const foreign = record(nativeProviders) ? Object.fromEntries(Object.entries(nativeProviders).filter(([key]) => !previousOwned.includes(key))) : {};
        publishedProviders = { ...next.baselineProviders, ...originalProviders(next), ...foreign, ...plan.providers };
      }
      if (current) {
        if (id === 'llm-pi-ai') {
          if (current.node.has('name') && current.node.get('name') !== '@deepseek-ai/dsh-llm-pi-ai') fail('DSH 模型插件 ID 与其他插件冲突，未修改原文件。');
          if (!current.node.has('name')) current.node.set('name', '@deepseek-ai/dsh-llm-pi-ai');
          const config = current.node.get('config', true);
          if (config === undefined || config === null) current.node.set('config', patch.createNode({ providers: publishedProviders }));
          else if (isMap(config)) config.set('providers', patch.createNode(publishedProviders));
          else fail('DSH llm-pi-ai 插件配置格式有误，未修改原文件。');
          current.node.set('disabled', patch.createNode(false));
        } else {
          if (current.node.has('name') && current.node.get('name') !== '@deepseek-ai/dsh-agent-default-model') fail('DSH 默认模型插件 ID 与其他插件冲突，未修改原文件。');
          if (!current.node.has('name')) current.node.set('name', '@deepseek-ai/dsh-agent-default-model');
          current.node.set('config', patch.createNode(plan.defaultModel));
        }
      } else patch.contents.add(patch.createNode({ id, name: id === 'llm-pi-ai' ? '@deepseek-ai/dsh-llm-pi-ai' : '@deepseek-ai/dsh-agent-default-model', ...(id === 'llm-pi-ai' ? { disabled: false } : {}), config: id === 'llm-pi-ai' ? { providers: publishedProviders } : plan.defaultModel }));
      next.installedRows[id] = findRow(patch, id)!.node.toJSON();
    } else if (Object.hasOwn(next.originalRows, id)) {
      if (current && isDeepStrictEqual(current.node.toJSON(), next.installedRows[id])) restoreRow(patch, id, next.originalRows[id]!);
      // A user changed this row after synchronization. Remove only our routes,
      // preserving new choices instead of restoring an older entire row.
      else if (current && id === 'llm-pi-ai') {
        const config = current.node.get('config', true), providers = isMap(config) ? config.get('providers', true) : undefined;
        if (isMap(providers)) {
          const installed = (next.installedRows[id] as any)?.config?.providers ?? {}, original = originalProviders(next);
          for (const route of Object.keys(installed).filter(key => key === 'modeldock' || key.startsWith('modeldock-'))) {
            const value = providers.get(route, true);
            if (!value || !isDeepStrictEqual(value.toJSON(), installed[route])) continue;
            if (Object.hasOwn(original, route)) providers.set(route, patch.createNode(original[route])); else providers.delete(route);
          }
        }
      }
      delete next.originalRows[id]; delete next.installedRows[id];
    }
  }
  const sources = scope === 'selected' ? suppressiblePlugins(options.modelPlugins) : [];
  for (const [id, state] of Object.entries(next.suppressedRows)) if (!sources.some(source => source.id === id && source.name === state.name)) {
    restoreSuppressed(patch, id, state); delete next.suppressedRows[id];
  }
  for (const source of sources) {
    let current = findSourceRow(patch, source.id);
    if (current?.node.has('name') && current.node.get('name') !== source.name) fail('DSH 模型来源 ID 与其他插件冲突，未修改原文件。');
    if (!Object.hasOwn(next.suppressedRows, source.id)) Object.defineProperty(next.suppressedRows, source.id, { value: { original: current ? serializeRow(current.node, current.index) : null, installed: {}, name: source.name }, enumerable: true, writable: true, configurable: true });
    if (current) current.node.set('disabled', patch.createNode(true));
    else { patch.contents.add(patch.createNode({ id: source.id, disabled: true })); current = findSourceRow(patch, source.id)!; }
    next.suppressedRows[source.id].installed = current.node.toJSON();
  }
  if (officialRestore) {
    // Clearing ModelDock selection normally restores the user's prior custom
    // routes. Official restore explicitly removes model-source home overrides
    // so DSH can inherit its bundled/profile model defaults instead.
    const nativeSources = [...shippedSources, ...(options.modelPlugins ?? [])];
    function clearModelOverrides(sequence: YAMLSeq) {
      for (const node of sequence.items) {
        if (!isMap(node)) continue;
        const id = node.get('id'), name = node.get('name');
        if (id === 'llm-pi-ai' && name !== undefined && name !== '@deepseek-ai/dsh-llm-pi-ai'
          || id === 'agent-default-model' && name !== undefined && name !== '@deepseek-ai/dsh-agent-default-model') fail('DSH 模型插件 ID 与其他插件冲突，未还原原文件。');
        const isPiAi = id === 'llm-pi-ai' || name === '@deepseek-ai/dsh-llm-pi-ai';
        const isDefault = id === 'agent-default-model' || name === '@deepseek-ai/dsh-agent-default-model';
        if (isPiAi || isDefault) {
          const config = node.get('config', true);
          if (config !== undefined && config !== null && !isMap(config)) fail('DSH 模型插件配置格式有误，未还原原文件。');
          if (isMap(config)) {
            for (const field of isPiAi ? ['providers'] : ['provider', 'model']) config.delete(field);
            if (!config.items.length) node.delete('config');
          }
        }
        if (isPiAi || isDefault || nativeSources.some(source => source.id === id && (!name || name === source.name))
          || name === '@deepseek-ai/dsh-llm-deepseek-api-key' || name === '@deepseek-ai/dsh-llm-deepseek-account') node.delete('disabled');
        const inserted = node.get('insert', true); if (isSeq(inserted)) clearModelOverrides(inserted);
        const children = node.get('config', true); if (node.get('group') === true && isSeq(children)) clearModelOverrides(children);
      }
    }
    clearModelOverrides(patch.contents);
    next.baselineProviders = {};
  }
  for (const name of Object.keys(next.installedRefs)) if (!Object.hasOwn(plan.credentials, name)) {
    if (refs.get(name) === next.installedRefs[name]) {
      const original = next.originalRefs[name]; if (original === null) refs.delete(name); else refs.set(name, original);
    }
    delete next.originalRefs[name]; delete next.installedRefs[name];
  }
  for (const [name, secret] of Object.entries(plan.credentials)) {
    if (!Object.hasOwn(next.originalRefs, name)) next.originalRefs[name] = typeof refs.get(name) === 'string' ? refs.get(name) as string : null;
    refs.set(name, secret); next.installedRefs[name] = secret;
  }
  if (officialRestore) for (const entry of [...refs.items]) {
    if (typeof entry.key === 'object' && entry.key && 'value' in entry.key && typeof entry.key.value === 'string' && refPattern.test(entry.key.value)) refs.delete(entry.key.value);
  }
  const runtimeBefore = plan.legacyDispatch || next.runtime ? safeFile(runtimePath) : null;
  const runtimeAfter = synchronizeCompatibility(patch, next, plan, runtimePath, runtimeBefore);
  // New empty files are unnecessary when clearing untouched DSH configuration.
  const patchAfter = !patch.contents.items.length && patchBefore === null ? null : patch.toString();
  const credentialAfter = credentialsBefore === null && !refs.items.length ? null : credentials.toString();
  const files: FileSnapshot[] = [{ path: credentialPath, before: credentialsBefore, after: credentialAfter },
    ...(plan.legacyDispatch || next.runtime ? [{ path: runtimePath, before: runtimeBefore, after: runtimeAfter }] : []),
    { path: patchPath, before: patchBefore, after: patchAfter }];
  if (files.some(file => file.after !== null && Buffer.byteLength(file.after, 'utf8') > maximumFileSize)) fail('DSH 同步配置过大，未修改原文件。');
  if (files.every(file => file.before === file.after) && isDeepStrictEqual(next, history)) return patchPath;
  let backupPath: string;
  try { backupPath = store.createManagedBackup('dsh-sync', { version: 1, target, history, files }); }
  catch { fail('无法创建 DSH 加密备份，尚未修改外部配置。'); }
  const pending: History = { ...history, pending: { files, previous: copy(history), complete: next, backupPath } };
  try { store.setManagedState(key, pending); }
  catch { fail('无法保存 DSH 恢复记录，尚未修改外部配置。'); }
  let mutationStarted = false;
  try {
    options.beforeCommit?.();
    if (files.some(file => !sameFile(file.path, file.before))) fail('DSH 配置刚被其他程序修改，请重新同步。');
    for (const file of files) if (file.before !== file.after) {
      // Another application can save the patch after the credential file has
      // committed. Recheck each file before replacing it, not only the batch.
      if (!sameFile(file.path, file.before)) fail('DSH 配置刚被其他程序修改，请重新同步。');
      mutationStarted = true; (options.replaceFile ?? replaceAtomic)(file.path, file.after);
    }
    if (files.some(file => !sameFile(file.path, file.after))) fail('DSH 配置写入验证失败。');
    store.setManagedState(key, next);
    return patchPath;
  } catch {
    if (!mutationStarted) { try { store.setManagedState(key, history); } catch { /* Recovery remains encrypted. */ } fail('DSH 同步未执行，配置已变化或写入前检查失败，请重试。'); }
    try { restoreFiles(files, replaceAtomic); store.setManagedState(key, history); }
    catch { fail('DSH 同步失败，自动恢复未完成；已保留加密备份与恢复记录。'); }
    fail('DSH 同步失败，已恢复原配置与凭据。');
  }
}
export function applyDshConfig(store: DshConfigStore, plan: DshPlan, dshHome: string, options: DshApplyOptions = {}): string {
  return synchronizeDshConfig(store, plan, dshHome, options);
}
/** Return to native profile model sources without touching account records,
 * other plugins or non-ModelDock credential references. */
export function restoreDshOfficialConfig(store: DshConfigStore, dshHome: string, options: DshApplyOptions = {}): string {
  return synchronizeDshConfig(store, { syncScope: 'managed', providers: {}, credentials: {} }, dshHome, options, true);
}
