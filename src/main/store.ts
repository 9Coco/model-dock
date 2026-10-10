import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Provider, ProviderInput, ProviderSecret, Model, ModelInput, ToolBinding, ToolId, RequestLog } from '../shared/types';
import { isReasoningEffort, MODEL_SPEC_FIELDS, modelSpecs, sanitizeReasoningEfforts } from '../shared/types';
import { providerPresets, presetById } from '../shared/presets';
import { resolveBindingModels } from '../shared/bindings';
import { directModelsForProvider, isSingleEntryTool, updateSingleEntryBinding } from '../shared/single-entry';
import { isJetBrainsTool } from '../shared/jetbrains';
import { normalizeApiKey } from './credentials';
import { providerIdentity, type ProviderDuplicateGroup, type ProviderMergeResult } from '../shared/provider-duplicates';
import { suggestModelAlias } from '../shared/model-names';

export interface SecretCodec { encrypt(text: string): string; decrypt(text: string): string }
/** Main-only opaque rollback handle; raw encrypted rows remain inside Store. */
export interface ProviderRemovalCheckpoint {
  id: string;
  providerId: string;
  backupPath: string;
  affectedToolIds: ToolId[];
  beforeBindings: ToolBinding[];
  afterBindings: ToolBinding[];
}
interface ProviderRemovalData {
  checkpoint: ProviderRemovalCheckpoint;
  provider: Record<string, unknown>;
  secret?: Record<string, unknown>;
  models: Record<string, unknown>[];
  authKeys: string[];
  authRows: Record<string, unknown>[];
  bindingsBefore: Record<string, unknown>[];
  bindingsAfter: Record<string, unknown>[];
}
const TOOL_NAMES: Record<ToolId, string> = { codex: 'Codex', opencode: 'OpenCode', dsh: 'DeepSeek Harness', vscode: 'VS Code', copilot: 'GitHub Copilot', 'claude-code': 'Claude Code', webstorm: 'WebStorm', 'intellij-idea': 'IntelliJ IDEA', rider: 'Rider', pycharm: 'PyCharm' };
const kinds = new Set(['openai-compatible', 'codex', 'grok', 'copilot']);
let sqlPromise: Promise<SqlJsStatic> | undefined;

/** HTTP is allowed only for a local upstream; credentials never belong in a URL. */
export function validateUpstreamUrl(value: string, gatewayPort = 18181): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('上游地址不是有效 URL。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('上游地址不能包含凭据、查询参数或片段。');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('上游必须使用 HTTPS，或本机回环 HTTP 地址。');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (loopback && port === gatewayPort) throw new Error('上游地址指向 ModelDock 自身，会造成请求循环。');
  return url.toString().replace(/\/+$/, '');
}

function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}无效。`);
  return value.trim();
}
function id(value: unknown): string { const result = text(value, 'ID', 100); if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('ID 无效。'); return result; }
const plainCodec: SecretCodec = { encrypt: s => s, decrypt: s => s };

export class Store {
  private gatewayPort = 18181;
  private closed = false;
  private readonly providerRemovals = new Map<string, ProviderRemovalData>();
  private constructor(private db: Database, readonly dataDir: string, private codec: SecretCodec) {}

  static async create(dataDir: string, codec: SecretCodec = plainCodec): Promise<Store> {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    sqlPromise ??= initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
    const SQL = await sqlPromise;
    const filename = join(dataDir, 'modeldock.sqlite');
    const db = existsSync(filename) ? new SQL.Database(readFileSync(filename)) : new SQL.Database();
    const store = new Store(db, dataDir, codec);
    db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,base_url TEXT NOT NULL,enabled INTEGER NOT NULL,auth_status TEXT NOT NULL,note TEXT NOT NULL,preset_id TEXT NOT NULL DEFAULT 'custom',messages_auth TEXT NOT NULL DEFAULT 'bearer',claude_base_url TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS secrets(provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,ciphertext TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,upstream_id TEXT NOT NULL,alias TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,wire_api TEXT NOT NULL,context_window INTEGER NOT NULL,tools INTEGER NOT NULL,vision INTEGER NOT NULL,enabled INTEGER NOT NULL,reasoning_efforts TEXT NOT NULL DEFAULT '[]',default_reasoning_effort TEXT,specs_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,model_ids TEXT NOT NULL,default_model_id TEXT NOT NULL,note TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'aggregate',provider_ids TEXT,model_selection TEXT,vscode_sync_scope TEXT NOT NULL DEFAULT 'managed',copilot_sync_scope TEXT NOT NULL DEFAULT 'managed',dsh_sync_scope TEXT NOT NULL DEFAULT 'managed',claude_disable_telemetry INTEGER NOT NULL DEFAULT 1,connection_choices TEXT);
      CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY,time TEXT NOT NULL,alias TEXT NOT NULL,provider_name TEXT NOT NULL,endpoint TEXT NOT NULL,status INTEGER NOT NULL,duration_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    store.migrateSchema();
    if (!store.one("SELECT value FROM settings WHERE key='initialized'")) {
      // Existing databases keep their accounts exactly as stored. Templates are
      // seeded only for an empty, never-initialized store.
      if (!store.one('SELECT id FROM providers LIMIT 1')) for (const preset of providerPresets.filter(p => p.id !== 'custom' && p.id !== 'copilot-subscription')) {
        db.run('INSERT INTO providers(id,name,kind,base_url,enabled,auth_status,note,preset_id,messages_auth) VALUES(?,?,?,?,?,?,?,?,?)', [preset.id, preset.name, preset.kind, preset.baseUrl, 1, 'missing', preset.note, preset.id, preset.id === 'anthropic' ? 'api-key' : 'bearer']);
      }
      db.run('INSERT INTO settings(key,value) VALUES(?,?)', ['initialized', '1']);
    }
    // 修改点：旧版其他工具允许 direct 多入口，转为等价的 auto 元数据；不改外部配置或所选来源。
    for (const row of store.rows("SELECT id,provider_ids FROM bindings WHERE mode='direct'")) {
      if (!Object.hasOwn(TOOL_NAMES, String(row.id)) || row.id === 'codex' || row.id === 'claude-code') continue;
      const ids = row.provider_ids === null ? [] : JSON.parse(String(row.provider_ids));
      if (Array.isArray(ids) && ids.length > 1) db.run("UPDATE bindings SET mode='auto' WHERE id=?", [String(row.id)]);
    }
    for (const [tool, name] of Object.entries(TOOL_NAMES)) db.run('INSERT OR IGNORE INTO bindings(id,name,enabled,model_ids,default_model_id,note,mode,provider_ids,vscode_sync_scope,copilot_sync_scope,dsh_sync_scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [tool, name, 0, '[]', '', '', isJetBrainsTool(tool) ? 'aggregate' : 'direct', '[]', tool === 'vscode' ? 'selected' : 'managed', tool === 'copilot' ? 'selected' : 'managed', tool === 'dsh' ? 'selected' : 'managed']);
    store.migrateSingleEntryBindings();
    if (!store.one("SELECT value FROM settings WHERE key='gateway_key'")) db.run('INSERT INTO settings(key,value) VALUES(?,?)', ['gateway_key', codec.encrypt(store.newKey())]);
    store.persist();
    return store;
  }

  private migrateSchema(): void {
    const providerColumns = this.rows('PRAGMA table_info(providers)').map(row => String(row.name));
    const bindingColumns = this.rows('PRAGMA table_info(bindings)').map(row => String(row.name));
    const modelColumns = this.rows('PRAGMA table_info(models)').map(row => String(row.name));
    this.db.run('BEGIN');
    try {
      // Model metadata only; client configs receive thinking levels on explicit sync.
      if (!modelColumns.includes('reasoning_efforts')) this.db.run("ALTER TABLE models ADD COLUMN reasoning_efforts TEXT NOT NULL DEFAULT '[]'");
      if (!modelColumns.includes('default_reasoning_effort')) this.db.run('ALTER TABLE models ADD COLUMN default_reasoning_effort TEXT');
      // 修改点：仅新增内部规格容器，不改旧上下文/能力，也不触发客户端配置同步。
      if (!modelColumns.includes('specs_json')) this.db.run("ALTER TABLE models ADD COLUMN specs_json TEXT NOT NULL DEFAULT '{}'");
      if (!providerColumns.includes('preset_id')) {
        this.db.run("ALTER TABLE providers ADD COLUMN preset_id TEXT NOT NULL DEFAULT 'custom'");
        for (const row of this.rows('SELECT id,kind,base_url FROM providers')) {
          const baseUrl = String(row.base_url).replace(/\/+$/, '');
          const preset = row.kind === 'codex' ? presetById('codex-subscription') : row.kind === 'grok' ? presetById('grok-build') : row.kind === 'copilot' ? presetById('copilot-subscription') : providerPresets.find(item => item.id !== 'custom' && item.baseUrl && item.kind === row.kind && item.baseUrl.replace(/\/+$/, '') === baseUrl);
          // Recognize confirmed presets without rewriting any endpoint or secret;
          // unmatched/custom connections retain the custom label.
          this.db.run('UPDATE providers SET preset_id=? WHERE id=?', [preset?.id ?? 'custom', String(row.id)]);
        }
      }
      if (!providerColumns.includes('messages_auth')) this.db.run("ALTER TABLE providers ADD COLUMN messages_auth TEXT NOT NULL DEFAULT 'bearer'");
      if (!providerColumns.includes('claude_base_url')) this.db.run("ALTER TABLE providers ADD COLUMN claude_base_url TEXT NOT NULL DEFAULT ''");
      if (!bindingColumns.includes('connection_choices')) this.db.run('ALTER TABLE bindings ADD COLUMN connection_choices TEXT');
      if (!bindingColumns.includes('mode')) this.db.run("ALTER TABLE bindings ADD COLUMN mode TEXT NOT NULL DEFAULT 'aggregate'");
      // 修改点：只迁移 ModelDock 内部选项，启动时不写入 Claude Code 配置。
      if (!bindingColumns.includes('claude_disable_telemetry')) this.db.run('ALTER TABLE bindings ADD COLUMN claude_disable_telemetry INTEGER NOT NULL DEFAULT 1');
      if (!bindingColumns.includes('provider_ids')) this.db.run('ALTER TABLE bindings ADD COLUMN provider_ids TEXT');
      // NULL retains legacy empty-all/nonempty-filter semantics. No external
      // configuration changes and no expansion of an existing model selection.
      if (!bindingColumns.includes('model_selection')) this.db.run('ALTER TABLE bindings ADD COLUMN model_selection TEXT');
      if (!bindingColumns.includes('vscode_sync_scope')) {
        this.db.run("ALTER TABLE bindings ADD COLUMN vscode_sync_scope TEXT NOT NULL DEFAULT 'managed'");
        // Internal metadata migration only. External client files are written
        // exclusively on a user selection or explicit synchronization action.
        this.db.run("UPDATE bindings SET vscode_sync_scope='selected' WHERE id='vscode'");
      }
      if (!bindingColumns.includes('copilot_sync_scope')) {
        this.db.run("ALTER TABLE bindings ADD COLUMN copilot_sync_scope TEXT NOT NULL DEFAULT 'managed'");
        // Register the new default only; no desktop API is called at startup.
        this.db.run("UPDATE bindings SET copilot_sync_scope='selected' WHERE id='copilot'");
      }
      if (!bindingColumns.includes('dsh_sync_scope')) {
        this.db.run("ALTER TABLE bindings ADD COLUMN dsh_sync_scope TEXT NOT NULL DEFAULT 'managed'");
        // Scope metadata only; DSH files change only after a user sync action.
        this.db.run("UPDATE bindings SET dsh_sync_scope='selected' WHERE id='dsh'");
      }
      for (const row of this.rows('SELECT id,model_ids FROM bindings WHERE provider_ids IS NULL')) {
        const modelIds = JSON.parse(String(row.model_ids)) as string[];
        const providerIds = [...new Set(modelIds.flatMap(modelId => {
          const model = this.one('SELECT provider_id FROM models WHERE id=?', [modelId]);
          return model ? [String(model.provider_id)] : [];
        }))];
        this.db.run('UPDATE bindings SET provider_ids=?,mode=? WHERE id=?', [JSON.stringify(providerIds), 'aggregate', String(row.id)]);
      }
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
  }

  private one(sql: string, params: (string | number)[] = []): Record<string, unknown> | undefined { return this.rows(sql, params)[0]; }
  private rows(sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
    if (this.closed) throw new Error('存储已关闭。');
    const statement = this.db.prepare(sql);
    try { statement.bind(params); const rows: Record<string, unknown>[] = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; } finally { statement.free(); }
  }
  private persist(): void {
    const filename = join(this.dataDir, 'modeldock.sqlite');
    const temp = `${filename}.${randomUUID()}.tmp`;
    // sql.js export closes/reopens the connection, which resets PRAGMA state.
    const bytes = this.db.export();
    this.db.run('PRAGMA foreign_keys=ON');
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, filename);
    if (process.platform !== 'win32') chmodSync(filename, 0o600);
  }
  private mutate<T>(action: () => T): T {
    if (this.closed) throw new Error('存储已关闭。');
    this.db.run('BEGIN');
    try { const result = action(); this.db.run('COMMIT'); this.persist(); return result; } catch (error) { try { this.db.run('ROLLBACK'); } catch { /* already committed */ } throw error; }
  }
  private provider(row: Record<string, unknown>): Provider {
    return { id: String(row.id), name: String(row.name), kind: row.kind as Provider['kind'], presetId: (row.preset_id || 'custom') as Provider['presetId'], baseUrl: String(row.base_url), enabled: Boolean(row.enabled), hasSecret: Boolean(this.one('SELECT provider_id FROM secrets WHERE provider_id=?', [String(row.id)])), authStatus: row.auth_status as Provider['authStatus'], note: String(row.note), ...(row.kind === 'openai-compatible' ? { messagesAuth: row.messages_auth === 'api-key' ? 'api-key' as const : 'bearer' as const, ...(row.claude_base_url ? { claudeBaseUrl: String(row.claude_base_url) } : {}) } : {}), ...(row.kind === 'copilot' ? { copilotAccountId: this.getSecret(String(row.id))?.copilotAccountId } : {}) };
  }
  listProviders(): Provider[] { return this.rows('SELECT * FROM providers ORDER BY rowid').map(row => this.provider(row)); }
  getProvider(providerId: string): Provider | undefined { const row = this.one('SELECT * FROM providers WHERE id=?', [providerId]); return row ? this.provider(row) : undefined; }
  setGatewayPort(port: number): void { this.gatewayPort = port; }
  getManagedState<T>(key: string, fallback: T): T {
    const name = this.managedKey(key);
    const row = this.one('SELECT value FROM settings WHERE key=?', [name]);
    if (!row) return structuredClone(fallback);
    try { return JSON.parse(this.codec.decrypt(String(row.value))) as T; }
    catch { throw new Error('管理配置无法读取，请检查本地数据库和加密环境。'); }
  }
  setManagedState(key: string, value: unknown): void {
    const name = this.managedKey(key);
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 8 * 1024 * 1024) throw new Error('管理配置过大或无效。');
    this.mutate(() => this.db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [name, this.codec.encrypt(encoded)]));
  }
  /** Back up only a managed payload through the same main-process secret codec. */
  createManagedBackup(kind: string, value: unknown): string {
    if (this.closed) throw new Error('存储已关闭。');
    if (typeof kind !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(kind)) throw new Error('管理备份类型无效。');
    try {
      const encoded = JSON.stringify(value);
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 8 * 1024 * 1024) throw new Error('Invalid backup');
      const encrypted = this.codec.encrypt(encoded);
      if (typeof encrypted !== 'string' || !encrypted || Buffer.byteLength(encrypted, 'utf8') > 16 * 1024 * 1024) throw new Error('Invalid ciphertext');
      const folder = join(this.dataDir, 'backups', `${kind}-${Date.now()}-${randomUUID()}`);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
        const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
        if (!sid) throw new Error('Identity unavailable');
        execFileSync('icacls.exe', [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
      } else chmodSync(folder, 0o700);
      const file = join(folder, 'managed-state.enc');
      writeFileSync(file, encrypted, { flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(file, 0o600);
      return file;
    } catch { throw new Error('无法创建加密管理备份，尚未修改外部应用。'); }
  }
  private managedKey(key: string): string {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(key)) throw new Error('管理配置名称无效。');
    return `managed:${key}`;
  }
  saveProvider(input: ProviderInput): Provider {
    let providerId = input.id ? id(input.id) : randomUUID();
    const name = text(input.name, '供应商名称', 120);
    if (!kinds.has(input.kind) || typeof input.enabled !== 'boolean') throw new Error('供应商类型或启用状态无效。');
    if (input.messagesAuth !== undefined && (!['api-key', 'bearer'].includes(input.messagesAuth) || input.kind !== 'openai-compatible')) throw new Error('Messages 鉴权方式无效。');
    let existing = this.getProvider(providerId);
    if (input.id && !existing) throw new Error('供应商不存在，请刷新后重试。');
    const preset = presetById(input.presetId ?? existing?.presetId ?? (input.kind === 'codex' ? 'codex-subscription' : input.kind === 'grok' ? 'grok-build' : input.kind === 'copilot' ? 'copilot-subscription' : 'custom'));
    if (!preset) throw new Error('供应商预设不存在。');
    if (preset.kind !== input.kind) throw new Error('供应商类型与预设不一致。');
    if (typeof input.baseUrl !== 'string') throw new Error('上游地址无效。');
    const baseUrl = input.baseUrl.trim() ? validateUpstreamUrl(input.baseUrl, this.gatewayPort) : '';
    if (input.kind === 'copilot' && baseUrl !== 'https://api.githubcopilot.com') throw new Error('Copilot 订阅只使用官方服务地址。');
    if (existing && existing.kind !== input.kind && existing.hasSecret) throw new Error('已有凭据的供应商不能直接改变类型，请新建供应商。');
    const note = typeof input.note === 'string' ? input.note.slice(0, 1000) : '';
    const apiKey = input.apiKey === undefined ? undefined : normalizeApiKey(input.apiKey);
    if (input.claudeBaseUrl !== undefined && (typeof input.claudeBaseUrl !== 'string' || input.kind !== 'openai-compatible')) throw new Error('Claude Code 接口地址无效。');
    const claudeBaseUrl = input.claudeBaseUrl === undefined ? existing?.claudeBaseUrl ?? '' : input.claudeBaseUrl.trim() ? validateUpstreamUrl(input.claudeBaseUrl, this.gatewayPort) : '';
    if (/\/v1\/messages\/?$/.test(claudeBaseUrl)) throw new Error('Claude Code 接口请填写基址，不包含 /v1/messages。');
    if (input.kind === 'openai-compatible') {
      const identity = providerIdentity({ kind: input.kind, name, baseUrl });
      const matches = this.listProviders().filter(provider => provider.kind === 'openai-compatible' && providerIdentity(provider) === identity && provider.id !== providerId);
      const duplicateMessage = '已存在同名同地址供应商，请编辑它；不同账号使用不同名称。';
      if (existing) {
        // Old duplicate groups remain editable, but an edit cannot create a new collision.
        if (matches.length && providerIdentity(existing) !== identity) throw new Error(duplicateMessage);
      } else if (matches.length) {
        if (input.id) throw new Error(duplicateMessage);
        const ranked = this.rankDuplicateProviders(matches);
        if (!apiKey) return ranked[0];
        const configured = ranked.filter(provider => provider.hasSecret || this.providerModelCount(provider.id) > 0);
        if (configured.length) {
          try {
            if (configured.every(provider => this.readDuplicateApiKey(provider.id) === apiKey)) return configured[0];
          } catch { /* A duplicate must never replace unreadable credentials. */ }
          throw new Error(duplicateMessage);
        }
        // Configure the existing empty preset rather than append another copy.
        existing = ranked[0];
        providerId = existing.id;
      }
    }
    return this.mutate(() => {
      this.db.run('INSERT INTO providers(id,name,kind,base_url,enabled,auth_status,note,preset_id,messages_auth,claude_base_url) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,enabled=excluded.enabled,note=excluded.note,preset_id=excluded.preset_id,messages_auth=excluded.messages_auth,claude_base_url=excluded.claude_base_url', [providerId, name, input.kind, baseUrl, Number(input.enabled), existing?.authStatus ?? 'missing', note, preset.id, input.messagesAuth ?? existing?.messagesAuth ?? (preset.id === 'anthropic' ? 'api-key' : 'bearer'), claudeBaseUrl]);
      if (apiKey) {
        if (input.kind !== 'openai-compatible') throw new Error('订阅供应商请使用 OAuth 登录。');
        this.putSecret(providerId, { apiKey });
      }
      return this.getProvider(providerId)!;
    });
  }
  private providerModelCount(providerId: string): number { return Number(this.one('SELECT COUNT(*) AS count FROM models WHERE provider_id=?', [providerId])?.count ?? 0); }
  private rankDuplicateProviders(providers: Provider[]): Provider[] {
    const keyScore = (provider: Provider) => { try { return this.readDuplicateApiKey(provider.id) ? 2 : 0; } catch { return 1; } };
    return [...providers].sort((a, b) => keyScore(b) - keyScore(a) || this.providerModelCount(b.id) - this.providerModelCount(a.id) || a.id.localeCompare(b.id));
  }
  private readDuplicateApiKey(providerId: string): string {
    const row = this.one('SELECT ciphertext FROM secrets WHERE provider_id=?', [providerId]);
    if (!row) return '';
    let decoded: unknown;
    try { decoded = JSON.parse(this.codec.decrypt(String(row.ciphertext))); }
    catch { throw new Error('存在无法读取的凭据，请先在供应商编辑页修复后再合并。'); }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).some(key => key !== 'apiKey')) throw new Error('存在异常凭据结构，无法安全合并，请先检查对应供应商。');
    const apiKey = (decoded as Record<string, unknown>).apiKey;
    if (apiKey === undefined) return '';
    if (typeof apiKey !== 'string') throw new Error('存在异常凭据结构，无法安全合并，请先检查对应供应商。');
    try { return normalizeApiKey(apiKey); }
    catch { throw new Error('存在无效 API Key，无法安全合并，请先编辑对应供应商。'); }
  }
  private duplicateFingerprint(providerIds: string[]): string {
    const group = new Set(providerIds);
    // Fingerprint ciphertext, never plaintext keys; edits to models or filters invalidate preview.
    const state = {
      providers: this.rows('SELECT * FROM providers ORDER BY id'),
      secrets: this.rows('SELECT * FROM secrets ORDER BY provider_id').filter(row => group.has(String(row.provider_id))),
      models: this.rows('SELECT * FROM models ORDER BY id'),
      bindings: this.rows('SELECT * FROM bindings ORDER BY id'),
    };
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  }
  private mergedProviderNote(providers: Provider[]): string {
    const note = [...new Set(providers.map(provider => provider.note.trim()).filter(Boolean))].join('\n\n');
    if (note.length > 1000) throw new Error('合并后的备注超过 1000 字，请先整理备注后再合并。');
    return note;
  }
  private mergedBindings(providerIds: string[], targetProviderId: string): ToolBinding[] {
    const group = new Set(providerIds), models = this.listModels();
    const updatedModels = models.map(model => group.has(model.providerId) ? { ...model, providerId: targetProviderId } : model);
    return this.allBindings().map(binding => {
      const choices = binding.connectionChoices ? structuredClone(binding.connectionChoices) : undefined;
      if (choices?.direct && group.has(choices.direct.providerId)) choices.direct.providerId = targetProviderId;
      if (choices?.aggregate && choices.aggregate.providerIds.some(providerId => group.has(providerId))) {
        const draft = choices.aggregate;
        const before = models.filter(model => draft.providerIds.includes(model.providerId) && (draft.modelSelection === 'all' || draft.modelSelection === undefined && !draft.modelIds.length || draft.modelIds.includes(model.id)));
        draft.providerIds = [...new Set(draft.providerIds.map(providerId => group.has(providerId) ? targetProviderId : providerId))];
        const after = updatedModels.filter(model => draft.providerIds.includes(model.providerId));
        if ((draft.modelSelection === 'all' || draft.modelSelection === undefined && !draft.modelIds.length) && after.some(model => !before.some(candidate => candidate.id === model.id))) { draft.modelSelection = 'selected'; draft.modelIds = before.map(model => model.id); }
      }
      if (!(binding.providerIds ?? []).some(providerId => group.has(providerId))) return { ...binding, ...(choices ? { connectionChoices: choices } : {}) };
      const selectedProviderIds = [...new Set((binding.providerIds ?? []).map(providerId => group.has(providerId) ? targetProviderId : providerId))];
      const selectedModels = resolveBindingModels({ ...binding, enabled: true }, models.map(model => ({ ...model, enabled: true })));
      const allAfter = resolveBindingModels({ ...binding, enabled: true, providerIds: selectedProviderIds }, updatedModels.map(model => ({ ...model, enabled: true })));
      const selectedIds = new Set(selectedModels.map(model => model.id));
      const expandsSelection = allAfter.some(model => !selectedIds.has(model.id));
      // Freeze implicit "all source models" when only part of the duplicate group was selected.
      // Empty filters mean all, so a previously empty selection must remain disabled.
      const freezeSelection = expandsSelection && (binding.modelSelection === 'all' || binding.modelSelection === undefined && !binding.modelIds.length);
      const modelIds = freezeSelection ? selectedModels.map(model => model.id) : binding.modelIds;
      const modelSelection = freezeSelection ? 'selected' as const : binding.modelSelection;
      return { ...binding, ...(choices ? { connectionChoices: choices } : {}), providerIds: selectedProviderIds, modelIds, modelSelection, enabled: binding.enabled && !(expandsSelection && modelIds.length === 0) };
    });
  }
  listProviderDuplicates(): ProviderDuplicateGroup[] {
    const grouped = new Map<string, Provider[]>();
    for (const provider of this.listProviders()) {
      if (provider.kind !== 'openai-compatible') continue;
      const identity = providerIdentity(provider);
      grouped.set(identity, [...(grouped.get(identity) ?? []), provider]);
    }
    const models = this.listModels(), bindings = this.allBindings(), providers = this.listProviders();
    return [...grouped.values()].filter(group => group.length > 1).map(group => {
      const ranked = this.rankDuplicateProviders(group), target = ranked[0];
      const providerIds = group.map(provider => provider.id).sort();
      let canMerge = true, message = '合并保留全部模型和别名；工具可用模型范围保持不变。';
      try {
        const keys = [...new Set(group.map(provider => this.readDuplicateApiKey(provider.id)).filter(Boolean))];
        if (keys.length > 1) throw new Error('这些供应商使用不同 API Key，请保留为不同账号并使用不同名称。');
        if (new Set(group.map(provider => provider.enabled)).size > 1) throw new Error('这些供应商的启用状态不同，请先统一启用状态后再合并。');
        if (new Set(group.map(provider => provider.presetId ?? 'custom')).size > 1) throw new Error('这些供应商的预设不同，请先统一预设后再合并。');
        if (new Set(group.map(provider => provider.messagesAuth ?? 'bearer')).size > 1) throw new Error('这些供应商的 Messages 鉴权方式不同，请先统一后再合并。');
        if (new Set(group.map(provider => provider.claudeBaseUrl ?? '')).size > 1) throw new Error('这些供应商的 Claude Code 接口不同，请先统一后再合并。');
        this.mergedProviderNote(ranked);
      } catch (error) { canMerge = false; message = error instanceof Error ? error.message : '当前重复供应商无法安全合并。'; }
      const proposed = this.mergedBindings(providerIds, target.id);
      const updatedModels = models.map(model => providerIds.includes(model.providerId) ? { ...model, providerId: target.id } : model);
      const affectedTools = bindings.flatMap((binding, index) => [...(binding.providerIds ?? []), ...(binding.connectionChoices?.aggregate?.providerIds ?? []), binding.connectionChoices?.direct?.providerId ?? ''].some(providerId => providerIds.includes(providerId)) ? [{ id: binding.id, name: binding.name, beforeModels: resolveBindingModels(binding, models, providers).length, afterModels: resolveBindingModels(proposed[index], updatedModels, providers).length }] : []);
      return { name: target.name, baseUrl: target.baseUrl, providerIds, targetProviderId: target.id, totalModels: group.reduce((count, provider) => count + this.providerModelCount(provider.id), 0), providers: group.map(provider => ({ id: provider.id, name: provider.name, hasSecret: provider.hasSecret, modelCount: this.providerModelCount(provider.id), enabled: provider.enabled })), canMerge, message, fingerprint: this.duplicateFingerprint(providerIds), affectedTools };
    });
  }
  private backupForProviderMerge(): string {
    const backupDir = join(this.dataDir, 'backups', `provider-merge-${Date.now()}-${randomUUID()}`);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    try {
      if (process.platform === 'win32') {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
        const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
        if (!sid) throw new Error('Windows 用户身份不可用。');
        execFileSync('icacls.exe', [backupDir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
      } else chmodSync(backupDir, 0o700);
      const path = join(backupDir, 'modeldock.sqlite');
      const bytes = this.db.export(); this.db.run('PRAGMA foreign_keys=ON');
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      return path;
    } catch { throw new Error('无法创建受限权限的数据库备份，合并已取消。'); }
  }
  mergeProviderDuplicates(providerIds: string[], fingerprint: string): ProviderMergeResult {
    if (!Array.isArray(providerIds) || providerIds.length < 2 || providerIds.some(providerId => typeof providerId !== 'string') || new Set(providerIds).size !== providerIds.length || typeof fingerprint !== 'string') throw new Error('重复供应商合并参数无效。');
    const requested = [...providerIds].sort();
    const group = this.listProviderDuplicates().find(candidate => candidate.providerIds.length === requested.length && candidate.providerIds.every((providerId, index) => providerId === requested[index]));
    if (!group || group.fingerprint !== fingerprint) throw new Error('供应商或模型配置已变化，请重新检查重复项后再合并。');
    if (!group.canMerge) throw new Error(group.message);
    const keptProviderId = group.targetProviderId, removedProviderIds = requested.filter(providerId => providerId !== keptProviderId);
    const members = this.rankDuplicateProviders(requested.map(providerId => this.getProvider(providerId)!));
    const note = this.mergedProviderNote(members), bindings = this.mergedBindings(requested, keptProviderId);
    const movedModels = removedProviderIds.reduce((count, providerId) => count + this.providerModelCount(providerId), 0);
    const keySource = members.find(provider => this.readDuplicateApiKey(provider.id));
    const sourceSecret = keySource ? this.one('SELECT ciphertext FROM secrets WHERE provider_id=?', [keySource.id]) : undefined;
    const backupPath = this.backupForProviderMerge();
    return this.mutate(() => {
      // Preserve the existing encrypted credential bytes rather than decrypt/re-encrypt.
      if (sourceSecret) this.db.run('INSERT INTO secrets(provider_id,ciphertext) VALUES(?,?) ON CONFLICT(provider_id) DO UPDATE SET ciphertext=excluded.ciphertext', [keptProviderId, String(sourceSecret.ciphertext)]);
      else this.db.run('DELETE FROM secrets WHERE provider_id=?', [keptProviderId]);
      this.db.run('UPDATE providers SET note=?,auth_status=? WHERE id=?', [note, sourceSecret ? 'ready' : 'missing', keptProviderId]);
      for (const providerId of removedProviderIds) {
        this.db.run('UPDATE models SET provider_id=? WHERE provider_id=?', [keptProviderId, providerId]);
      }
      for (const binding of bindings) this.db.run('UPDATE bindings SET enabled=?,provider_ids=?,model_ids=?,model_selection=?,default_model_id=?,connection_choices=? WHERE id=?', [Number(binding.enabled), binding.providerIds === undefined ? null : JSON.stringify(binding.providerIds), JSON.stringify(binding.modelIds), binding.modelSelection ?? null, binding.defaultModelId, binding.connectionChoices ? JSON.stringify(binding.connectionChoices) : null, binding.id]);
      for (const providerId of removedProviderIds) {
        this.db.run('DELETE FROM secrets WHERE provider_id=?', [providerId]);
        this.db.run('DELETE FROM providers WHERE id=?', [providerId]);
      }
      return { keptProviderId, removedProviderIds, movedModels, backupPath };
    });
  }
  deleteProvider(providerId: string): void { this.mutate(() => {
    // Explicit cleanup also repairs databases created by an older connection
    // with foreign key enforcement disabled.
    this.db.run('DELETE FROM models WHERE provider_id=?', [providerId]);
    this.db.run('DELETE FROM secrets WHERE provider_id=?', [providerId]);
    this.db.run('DELETE FROM providers WHERE id=?', [providerId]);
    this.pruneBindings();
  }); }
  /** The synchronous DB phase ends before the caller awaits external tool sync. */
  beginProviderRemoval(providerId: string): ProviderRemovalCheckpoint {
    const provider = this.one('SELECT rowid AS __removal_rowid,* FROM providers WHERE id=?', [providerId]);
    if (!provider) throw new Error('供应商不存在。');
    const secret = this.one('SELECT * FROM secrets WHERE provider_id=?', [providerId]);
    const models = this.rows('SELECT rowid AS __removal_rowid,* FROM models WHERE provider_id=? ORDER BY rowid', [providerId]);
    const bindingsBefore = this.rows('SELECT * FROM bindings ORDER BY id');
    const visibleBindings = this.listBindings();
    const authKeys = ['auth-metadata:', 'auth-usage:'].map(prefix => this.managedKey(prefix + providerId));
    const authRows = this.rows('SELECT * FROM settings WHERE key IN(?,?) ORDER BY key', authKeys);
    const backupPath = this.createManagedBackup('provider-remove', { version: 1, dataDir: this.dataDir, provider, secret, models, authRows, bindings: bindingsBefore });
    let bindingsAfter: Record<string, unknown>[];
    try {
      bindingsAfter = this.mutate(() => {
        this.db.run('DELETE FROM models WHERE provider_id=?', [providerId]);
        this.db.run('DELETE FROM secrets WHERE provider_id=?', [providerId]);
        this.db.run('DELETE FROM providers WHERE id=?', [providerId]);
        this.db.run('DELETE FROM settings WHERE key IN(?,?)', authKeys);
        this.pruneBindings();
        return this.rows('SELECT * FROM bindings ORDER BY id');
      });
    } catch {
      // A persistence failure can occur after COMMIT. With no asynchronous
      // work in this phase, restoring these exact rows cannot race user edits.
      if (!this.one('SELECT id FROM providers WHERE id=?', [providerId])) try {
        this.mutate(() => { this.insertRemovalRows('providers', [provider]); if (secret) this.insertRemovalRows('secrets', [secret]); this.insertRemovalRows('models', models); this.insertRemovalRows('settings', authRows); this.insertRemovalRows('bindings', bindingsBefore); });
      } catch { throw new Error('供应商删除未完成，自动恢复失败；已保留加密备份。'); }
      throw new Error('供应商删除未完成，尚未同步外部工具；已保留加密备份。');
    }
    const changedIds = new Set(bindingsBefore.filter(before => JSON.stringify(before) !== JSON.stringify(bindingsAfter.find(after => after.id === before.id))).map(row => String(row.id)));
    const affectedToolIds = Object.keys(TOOL_NAMES).filter(tool => changedIds.has(tool)) as ToolId[];
    const checkpoint: ProviderRemovalCheckpoint = { id: randomUUID(), providerId, backupPath, affectedToolIds, beforeBindings: visibleBindings.filter(binding => affectedToolIds.includes(binding.id)), afterBindings: this.listBindings().filter(binding => affectedToolIds.includes(binding.id)) };
    this.providerRemovals.set(checkpoint.id, { checkpoint: structuredClone(checkpoint), provider, secret, models, authKeys, authRows, bindingsBefore: bindingsBefore.filter(row => changedIds.has(String(row.id))), bindingsAfter: bindingsAfter.filter(row => changedIds.has(String(row.id))) });
    return structuredClone(checkpoint);
  }
  /** Restore only this removal, preserving request logs and unrelated edits. */
  restoreProviderRemoval(checkpoint: ProviderRemovalCheckpoint): void {
    const saved = this.providerRemoval(checkpoint);
    if (this.one('SELECT id FROM providers WHERE id=?', [checkpoint.providerId]) || this.one('SELECT id FROM models WHERE provider_id=?', [checkpoint.providerId]) || this.one('SELECT provider_id FROM secrets WHERE provider_id=?', [checkpoint.providerId]) || this.rows('SELECT * FROM settings WHERE key IN(?,?)', saved.authKeys).length) throw new Error('删除后的供应商数据已变化，未覆盖新内容；请使用保留的加密备份恢复。');
    for (const expected of saved.bindingsAfter) if (JSON.stringify(this.one('SELECT * FROM bindings WHERE id=?', [String(expected.id)])) !== JSON.stringify(expected)) throw new Error('受影响工具的选择已变化，未覆盖新选择；请使用保留的加密备份恢复。');
    if (this.one('SELECT id FROM providers WHERE rowid=?', [Number(saved.provider.__removal_rowid)])) throw new Error('供应商排序位置已被新来源使用，未覆盖新来源；请使用保留的加密备份恢复。');
    for (const model of saved.models) if (this.one('SELECT id FROM models WHERE id=? OR alias=? OR rowid=?', [String(model.id), String(model.alias), Number(model.__removal_rowid)])) throw new Error('模型 ID、接口别名或排序位置已被其他来源使用，未覆盖该模型；请使用保留的加密备份恢复。');
    try {
      this.mutate(() => {
        this.insertRemovalRows('providers', [saved.provider]);
        if (saved.secret) this.insertRemovalRows('secrets', [saved.secret]);
        this.insertRemovalRows('models', saved.models);
        this.insertRemovalRows('settings', saved.authRows);
        this.insertRemovalRows('bindings', saved.bindingsBefore);
      });
    } catch { throw new Error('无法恢复供应商数据，已保留加密备份。'); }
    this.providerRemovals.delete(checkpoint.id);
  }
  /** Release the in-memory handle after every affected tool has synchronized. */
  finishProviderRemoval(checkpoint: ProviderRemovalCheckpoint): void { this.providerRemoval(checkpoint); this.providerRemovals.delete(checkpoint.id); }
  private providerRemoval(checkpoint: ProviderRemovalCheckpoint): ProviderRemovalData {
    const saved = checkpoint && this.providerRemovals.get(checkpoint.id);
    if (!saved || checkpoint.providerId !== saved.checkpoint.providerId || checkpoint.backupPath !== saved.checkpoint.backupPath) throw new Error('供应商删除恢复记录无效或已结束。');
    return saved;
  }
  private insertRemovalRows(table: 'providers' | 'secrets' | 'models' | 'settings' | 'bindings', rows: Record<string, unknown>[]): void {
    const validColumns = new Set(this.rows(`PRAGMA table_info(${table})`).map(row => String(row.name)));
    for (const row of rows) {
      const columns = Object.keys(row);
      if (!columns.length || columns.some(column => !validColumns.has(column) && !(column === '__removal_rowid' && (table === 'providers' || table === 'models')))) throw new Error('恢复记录格式无效。');
      this.db.run(`INSERT OR REPLACE INTO ${table}(${columns.map(column => column === '__removal_rowid' ? 'rowid' : column).join(',')}) VALUES(${columns.map(() => '?').join(',')})`, columns.map(column => row[column]) as (string | number | null)[]);
    }
  }
  getSecret(providerId: string): ProviderSecret | undefined {
    const row = this.one('SELECT ciphertext FROM secrets WHERE provider_id=?', [providerId]);
    if (!row) return undefined;
    const secret = JSON.parse(this.codec.decrypt(String(row.ciphertext))) as ProviderSecret;
    return secret.apiKey ? { ...secret, apiKey: normalizeApiKey(secret.apiKey) } : secret;
  }
  private putSecret(providerId: string, secret: ProviderSecret): void {
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error('供应商不存在。');
    // 修改点：Copilot 来源只存账号引用；长时授权集中在账号加密存储，短时 token 只留内存。
    if (provider.kind === 'copilot' && Object.keys(secret).some(field => field !== 'copilotAccountId')) throw new Error('Copilot 订阅只允许关联 GitHub 账号。');
    if (secret.copilotAccountId !== undefined && (provider.kind !== 'copilot' || !/^copilot:[1-9]\d*$/.test(secret.copilotAccountId))) throw new Error('GitHub 账号引用无效。');
    const filtered: ProviderSecret = {};
    for (const field of ['apiKey', 'accessToken', 'idToken', 'refreshToken', 'accountId', 'tokenEndpoint', 'copilotAccountId'] as const) {
      const value = secret[field];
      if (value !== undefined) { if (typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new Error('凭据字段无效。'); filtered[field] = value; }
    }
    if (secret.expiresAt !== undefined) { if (!Number.isFinite(secret.expiresAt) || secret.expiresAt < 0) throw new Error('凭据过期时间无效。'); filtered.expiresAt = secret.expiresAt; }
    const ready = Boolean(filtered.apiKey || filtered.accessToken || filtered.refreshToken || filtered.copilotAccountId);
    if (ready) this.db.run('INSERT INTO secrets(provider_id,ciphertext) VALUES(?,?) ON CONFLICT(provider_id) DO UPDATE SET ciphertext=excluded.ciphertext', [providerId, this.codec.encrypt(JSON.stringify(filtered))]);
    else this.db.run('DELETE FROM secrets WHERE provider_id=?', [providerId]);
    this.db.run('UPDATE providers SET auth_status=? WHERE id=?', [ready ? 'ready' : 'missing', providerId]);
  }
  setSecret(providerId: string, secret: ProviderSecret): void { this.mutate(() => this.putSecret(providerId, secret)); }
  setAuthStatus(providerId: string, status: Provider['authStatus']): void {
    if (!['ready', 'missing', 'signing-in', 'error'].includes(status)) throw new Error('授权状态无效。');
    if (!this.getProvider(providerId)) throw new Error('供应商不存在。');
    this.mutate(() => this.db.run('UPDATE providers SET auth_status=? WHERE id=?', [status, providerId]));
  }
  private model(row: Record<string, unknown>): Model {
    const reasoningEfforts = sanitizeReasoningEfforts(JSON.parse(String(row.reasoning_efforts ?? '[]')));
    const defaultLevel = row.default_reasoning_effort;
    let specs = {};
    try { specs = modelSpecs(JSON.parse(String(row.specs_json ?? '{}'))); } catch { /* Malformed optional metadata cannot replace the model's existing fields. */ }
    return { id: String(row.id), providerId: String(row.provider_id), upstreamId: String(row.upstream_id), alias: String(row.alias), displayName: String(row.display_name), wireApi: row.wire_api as Model['wireApi'], contextWindow: Number(row.context_window), tools: Boolean(row.tools), vision: Boolean(row.vision), enabled: Boolean(row.enabled), reasoningEfforts, ...(isReasoningEffort(defaultLevel) && reasoningEfforts.includes(defaultLevel) ? { defaultReasoningEffort: defaultLevel } : {}), ...specs };
  }
  listModels(): Model[] { return this.rows('SELECT * FROM models ORDER BY rowid').map(row => this.model(row)); }
  saveModel(input: ModelInput): Model { return this.saveModels([input])[0]; }
  saveModels(inputs: ModelInput[]): Model[] {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 2000) throw new Error('模型批量数量无效。');
    return this.mutate(() => {
      const models = inputs.map(input => this.putModel(input));
      this.pruneBindings();
      return models;
    });
  }
  private putModel(input: ModelInput): Model {
    const modelId = input.id ? id(input.id) : randomUUID();
    if (!this.getProvider(input.providerId)) throw new Error('模型引用的供应商不存在。');
    const requestedAlias = text(input.alias, '模型别名', 400);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(requestedAlias)) throw new Error('模型别名只能包含字母、数字和 . _ : / -。');
    const alias = suggestModelAlias(input.providerId, requestedAlias, this.listModels(), modelId);
    if (alias.length > 400) throw new Error('模型别名过长。');
    if (!['chat-completions', 'responses', 'messages'].includes(input.wireApi)) throw new Error('模型协议无效。');
    if (input.wireApi === 'messages' && this.getProvider(input.providerId)?.kind !== 'openai-compatible') throw new Error('Messages 协议仅支持 API 供应商。');
    if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 0 || [input.tools, input.vision, input.enabled].some(v => typeof v !== 'boolean')) throw new Error('模型能力参数无效。');
    const reasoningEfforts = input.reasoningEfforts ?? [];
    if (!Array.isArray(reasoningEfforts) || reasoningEfforts.length > 7 || new Set(reasoningEfforts).size !== reasoningEfforts.length || reasoningEfforts.some(level => !isReasoningEffort(level))) throw new Error('思考强度级别无效。');
    const defaultReasoningEffort = input.defaultReasoningEffort;
    if (defaultReasoningEffort !== undefined && (!isReasoningEffort(defaultReasoningEffort) || !reasoningEfforts.includes(defaultReasoningEffort))) throw new Error('默认思考强度必须属于模型支持的级别。');
    const specs = modelSpecs(input, true);
    const baseModel = { ...input };
    for (const key of MODEL_SPEC_FIELDS) delete baseModel[key];
    const model: Model = { ...baseModel, ...specs, id: modelId, upstreamId: text(input.upstreamId, '上游模型 ID'), alias, displayName: text(input.displayName, '模型显示名称'), reasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) };
    this.db.run('INSERT INTO models(id,provider_id,upstream_id,alias,display_name,wire_api,context_window,tools,vision,enabled,reasoning_efforts,default_reasoning_effort,specs_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,upstream_id=excluded.upstream_id,alias=excluded.alias,display_name=excluded.display_name,wire_api=excluded.wire_api,context_window=excluded.context_window,tools=excluded.tools,vision=excluded.vision,enabled=excluded.enabled,reasoning_efforts=excluded.reasoning_efforts,default_reasoning_effort=excluded.default_reasoning_effort,specs_json=excluded.specs_json', [modelId, model.providerId, model.upstreamId, alias, model.displayName, model.wireApi, model.contextWindow, Number(model.tools), Number(model.vision), Number(model.enabled), JSON.stringify(reasoningEfforts), defaultReasoningEffort ?? null, JSON.stringify(specs)]); return model;
  }
  deleteModel(modelId: string): void { this.mutate(() => { this.db.run('DELETE FROM models WHERE id=?', [modelId]); this.pruneBindings(); }); }
  private validateConnectionChoices(choices: ToolBinding['connectionChoices'], models: Model[], providers: Provider[]): void {
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).some(key => !['direct', 'aggregate'].includes(key))) throw new Error('连接草稿无效。');
    const providerExists = (value: unknown) => typeof value === 'string' && (!value || providers.some(provider => provider.id === value));
    const validDefault = (value: unknown, providerIds: string[]) => typeof value === 'string' && (!value || models.some(model => model.id === value && providerIds.includes(model.providerId)));
    if (choices.direct && (typeof choices.direct !== 'object' || Object.keys(choices.direct).some(key => !['providerId', 'defaultModelId', 'completionModelId'].includes(key)) || !providerExists(choices.direct.providerId) || !validDefault(choices.direct.defaultModelId, [choices.direct.providerId]) || choices.direct.completionModelId !== undefined && !validDefault(choices.direct.completionModelId, [choices.direct.providerId]))) throw new Error('直连草稿引用了不存在的来源或模型。');
    if (choices.aggregate) {
      const choice = choices.aggregate;
      if (Object.keys(choice).some(key => !['providerIds', 'modelIds', 'defaultModelId', 'modelSelection', 'completionModelId'].includes(key)) || !Array.isArray(choice.providerIds) || choice.providerIds.some(value => !providerExists(value) || !value) || !Array.isArray(choice.modelIds) || choice.modelIds.some(value => !models.some(model => model.id === value && choice.providerIds.includes(model.providerId))) || !validDefault(choice.defaultModelId, choice.providerIds) || choice.completionModelId !== undefined && !validDefault(choice.completionModelId, choice.providerIds) || choice.modelSelection !== undefined && !['all', 'selected'].includes(choice.modelSelection)) throw new Error('聚合草稿引用了不存在的来源或模型。');
    }
  }
  /** Internal migration only; no client files, credentials or provider protocols change. */
  private migrateSingleEntryBindings(): void {
    const models = this.listModels(), providers = this.listProviders();
    for (const binding of this.allBindings()) {
      if (!isSingleEntryTool(binding.id) || binding.connectionChoices) continue;
      const ids = binding.providerIds ?? [];
      const provider = providers.find(provider => provider.id === ids[0]);
      const scoped = resolveBindingModels({ ...binding, mode: 'aggregate', enabled: true }, models, providers);
      const eligible = provider ? directModelsForProvider(binding.id, { ...provider, enabled: true }, models.map(model => ({ ...model, enabled: true }))) : [];
      const canDirect = ids.length === 1 && !!provider && provider.kind === 'openai-compatible' && scoped.length > 0 && scoped.every(model => eligible.some(candidate => candidate.id === model.id));
      const mode = binding.mode === 'aggregate' ? 'aggregate' : canDirect || !ids.length ? 'direct' : 'aggregate';
      const updated = updateSingleEntryBinding({ ...binding, mode }, {}, models, providers);
      this.db.run('UPDATE bindings SET mode=?,connection_choices=? WHERE id=?', [mode, JSON.stringify(updated.connectionChoices), binding.id]);
    }
  }
  private allBindings(): ToolBinding[] { return this.rows('SELECT * FROM bindings ORDER BY rowid').map(row => ({ id: row.id as ToolId, name: String(row.name), enabled: Boolean(row.enabled), mode: row.mode === 'direct' ? 'direct' : row.mode === 'auto' ? 'auto' : 'aggregate', providerIds: row.provider_ids === null ? undefined : JSON.parse(String(row.provider_ids)), modelIds: JSON.parse(String(row.model_ids)), ...(row.model_selection === 'selected' || row.model_selection === 'all' ? { modelSelection: row.model_selection } : {}), defaultModelId: String(row.default_model_id), ...(row.connection_choices ? { connectionChoices: JSON.parse(String(row.connection_choices)) } : {}), note: String(row.note), ...(row.id === 'vscode' ? { vscodeSyncScope: row.vscode_sync_scope === 'managed' ? 'managed' as const : 'selected' as const } : {}), ...(row.id === 'copilot' ? { copilotSyncScope: row.copilot_sync_scope === 'managed' ? 'managed' as const : 'selected' as const } : {}), ...(row.id === 'dsh' ? { dshSyncScope: row.dsh_sync_scope === 'managed' ? 'managed' as const : 'selected' as const } : {}), ...(row.id === 'claude-code' ? { claudeDisableTelemetry: row.claude_disable_telemetry !== 0 } : {}) })); }
  listBindings(): ToolBinding[] { const bindings = this.allBindings(); return Object.keys(TOOL_NAMES).flatMap(tool => bindings.filter(binding => binding.id === tool)); }
  /** Restore a captured sync choice exactly, without replacing unrelated tool metadata. */
  restoreBindingSelection(binding: ToolBinding): void {
    if (!Object.hasOwn(TOOL_NAMES, binding.id) || !this.one('SELECT id FROM bindings WHERE id=?', [binding.id]) || typeof binding.enabled !== 'boolean' || !Array.isArray(binding.modelIds) || typeof binding.defaultModelId !== 'string') throw new Error('工具绑定无效。');
    const models = this.listModels(), providers = this.listProviders();
    const providerIds = binding.providerIds;
    if (providerIds !== undefined && (!Array.isArray(providerIds) || providerIds.some(providerId => typeof providerId !== 'string' || !providers.some(provider => provider.id === providerId)))) throw new Error('撤销引用的来源已不存在。');
    if (binding.modelIds.some(modelId => typeof modelId !== 'string' || !models.some(model => model.id === modelId)) || binding.defaultModelId && !models.some(model => model.id === binding.defaultModelId)) throw new Error('撤销引用的模型已不存在。');
    if (binding.connectionChoices !== undefined) this.validateConnectionChoices(binding.connectionChoices, models, providers);
    const mode = binding.mode ?? (binding.id === 'claude-code' ? 'direct' : 'aggregate');
    if (!['direct', 'aggregate', 'auto'].includes(mode) || binding.modelSelection !== undefined && !['all', 'selected'].includes(binding.modelSelection)) throw new Error('工具选择方式无效。');
    if ([binding.vscodeSyncScope, binding.copilotSyncScope, binding.dshSyncScope].some(scope => scope !== undefined && !['managed', 'selected'].includes(scope)) || binding.claudeDisableTelemetry !== undefined && typeof binding.claudeDisableTelemetry !== 'boolean') throw new Error('工具同步选项无效。');
    this.mutate(() => this.db.run('UPDATE bindings SET enabled=?,model_ids=?,default_model_id=?,mode=?,provider_ids=?,model_selection=?,vscode_sync_scope=?,copilot_sync_scope=?,dsh_sync_scope=?,claude_disable_telemetry=?,connection_choices=? WHERE id=?', [
      Number(binding.enabled), JSON.stringify(binding.modelIds), binding.defaultModelId, mode, providerIds === undefined ? null : JSON.stringify(providerIds), binding.modelSelection ?? null,
      binding.vscodeSyncScope ?? (binding.id === 'vscode' ? 'selected' : 'managed'), binding.copilotSyncScope ?? (binding.id === 'copilot' ? 'selected' : 'managed'), binding.dshSyncScope ?? (binding.id === 'dsh' ? 'selected' : 'managed'), Number(binding.claudeDisableTelemetry ?? true), binding.connectionChoices === undefined ? null : JSON.stringify(binding.connectionChoices), binding.id,
    ]));
  }
  saveBinding(binding: ToolBinding): void {
    if (!Object.hasOwn(TOOL_NAMES, binding.id) || typeof binding.enabled !== 'boolean' || !Array.isArray(binding.modelIds) || typeof binding.defaultModelId !== 'string') throw new Error('工具绑定无效。');
    if (binding.modelSelection !== undefined && !['all', 'selected'].includes(binding.modelSelection)) throw new Error('模型选择方式无效。');
    const previousSelection = this.one('SELECT model_selection FROM bindings WHERE id=?', [binding.id])?.model_selection;
    const modelSelection = binding.modelSelection ?? (previousSelection === 'selected' || previousSelection === 'all' ? previousSelection : undefined);
    if (binding.vscodeSyncScope !== undefined && !['managed', 'selected'].includes(binding.vscodeSyncScope)) throw new Error('VS Code 同步范围无效。');
    if (binding.id !== 'vscode' && binding.vscodeSyncScope === 'selected') throw new Error('自定义供应商同步范围仅适用于 VS Code。');
    const previousScope = this.one('SELECT vscode_sync_scope FROM bindings WHERE id=?', [binding.id])?.vscode_sync_scope;
    const syncScope = binding.id === 'vscode' ? binding.vscodeSyncScope ?? (previousScope === 'managed' ? 'managed' : 'selected') : 'managed';
    if (binding.copilotSyncScope !== undefined && !['managed', 'selected'].includes(binding.copilotSyncScope)) throw new Error('Copilot 同步范围无效。');
    if (binding.id !== 'copilot' && binding.copilotSyncScope === 'selected') throw new Error('自定义供应商同步范围仅适用于 Copilot。');
    const previousCopilotScope = this.one('SELECT copilot_sync_scope FROM bindings WHERE id=?', [binding.id])?.copilot_sync_scope;
    const copilotScope = binding.id === 'copilot' ? binding.copilotSyncScope ?? (previousCopilotScope === 'managed' ? 'managed' : 'selected') : 'managed';
    if (binding.dshSyncScope !== undefined && !['managed', 'selected'].includes(binding.dshSyncScope)) throw new Error('DSH 同步范围无效。');
    if (binding.id !== 'dsh' && binding.dshSyncScope !== undefined) throw new Error('模型来源显示范围仅适用于 DSH。');
    const previousDshScope = this.one('SELECT dsh_sync_scope FROM bindings WHERE id=?', [binding.id])?.dsh_sync_scope;
    const dshScope = binding.id === 'dsh' ? binding.dshSyncScope ?? (previousDshScope === 'managed' ? 'managed' : 'selected') : 'managed';
    const allModels = this.listModels();
    const models = new Set(allModels.map(model => model.id));
    const modelIds = [...new Set(binding.modelIds)];
    if (modelIds.some(modelId => typeof modelId !== 'string' || !models.has(modelId))) throw new Error('工具绑定引用了不存在的模型。');
    const mode = binding.mode ?? (binding.id === 'claude-code' ? 'direct' : 'aggregate');
    if (isSingleEntryTool(binding.id) && mode === 'auto') throw new Error('此工具只支持直连或聚合接口。');
    if (!['direct', 'aggregate', 'auto'].includes(mode)) throw new Error('工具模式无效。');
    if (binding.providerIds !== undefined && !Array.isArray(binding.providerIds)) throw new Error('来源选择无效。');
    const providerIds = binding.providerIds === undefined ? [...new Set(allModels.filter(model => modelIds.includes(model.id)).map(model => model.providerId))] : [...new Set(binding.providerIds)];
    const providers = this.listProviders();
    if (providerIds.some(providerId => typeof providerId !== 'string' || !providers.some(provider => provider.id === providerId))) throw new Error('工具绑定引用了不存在的来源。');
    if (mode === 'direct' && (providerIds.length > 1 || binding.enabled && providerIds.length !== 1)) throw new Error('单供应商模式必须选择恰好一个来源。');
    if (binding.claudeDisableTelemetry !== undefined && (binding.id !== 'claude-code' || typeof binding.claudeDisableTelemetry !== 'boolean')) throw new Error('Claude Code 隐私选项无效。');
    const previousClaudePrivacy = this.one('SELECT claude_disable_telemetry FROM bindings WHERE id=?', [binding.id])?.claude_disable_telemetry;
    const claudePrivacy = binding.id === 'claude-code' ? binding.claudeDisableTelemetry ?? previousClaudePrivacy !== 0 : true;
    if (binding.id === 'claude-code') {
      if (mode !== 'aggregate' && (providerIds.length > 1 || binding.enabled && providerIds.length !== 1)) throw new Error('Claude Code 单供应商模式必须选择一个来源；多个来源请使用聚合接口。');
    }
    if (binding.enabled && !providerIds.length) throw new Error('工具配置至少需要选择一个来源。');
    if (modelIds.some(modelId => !providerIds.includes(allModels.find(model => model.id === modelId)!.providerId))) throw new Error('模型过滤必须属于所选来源。');
    const candidate = { ...binding, mode, providerIds, modelIds, modelSelection, enabled: true };
    const defaultModels = binding.enabled ? resolveBindingModels(candidate, allModels, providers) : allModels.filter(model => providerIds.includes(model.providerId) && (modelSelection === 'all' || modelSelection === undefined && !modelIds.length || modelIds.includes(model.id)));
    if (binding.defaultModelId && !defaultModels.some(model => model.id === binding.defaultModelId)) throw new Error('默认模型必须属于工具可用模型。');
    if (isSingleEntryTool(binding.id) && binding.enabled && mode === 'direct' && !resolveBindingModels(candidate, allModels, providers).length) throw new Error(mode === 'direct' ? '直连需要所选供应商的原生 API 模型；订阅和其他协议请使用聚合接口。' : '需要所选来源的可用模型。');
    const previous = this.allBindings().find(row => row.id === binding.id);
    const previousChoices = !(Object.hasOwn(binding, 'connectionChoices') && binding.connectionChoices === undefined) && previous && isSingleEntryTool(binding.id) ? updateSingleEntryBinding(previous, {}, allModels, providers).connectionChoices : undefined;
    const withChoices = updateSingleEntryBinding(candidate, { connectionChoices: { ...previousChoices, ...binding.connectionChoices } }, allModels, providers);
    if (isSingleEntryTool(binding.id)) this.validateConnectionChoices(withChoices.connectionChoices, allModels, providers);
    this.mutate(() => this.db.run('UPDATE bindings SET name=?,enabled=?,model_ids=?,default_model_id=?,note=?,mode=?,provider_ids=?,model_selection=?,vscode_sync_scope=?,copilot_sync_scope=?,dsh_sync_scope=?,claude_disable_telemetry=?,connection_choices=? WHERE id=?', [TOOL_NAMES[binding.id], Number(binding.enabled), JSON.stringify(modelIds), binding.defaultModelId, typeof binding.note === 'string' ? binding.note.slice(0, 1000) : '', mode, JSON.stringify(providerIds), modelSelection ?? null, syncScope, copilotScope, dshScope, Number(claudePrivacy), isSingleEntryTool(binding.id) ? JSON.stringify(withChoices.connectionChoices) : null, binding.id]));
  }
  private pruneBindings(): void {
    const models = this.listModels();
    const providers = this.listProviders();
    const existing = new Set(models.map(model => model.id));
    for (const binding of this.allBindings()) {
      const providerIds = (binding.providerIds ?? []).filter(providerId => providers.some(provider => provider.id === providerId));
      const modelIds = binding.modelIds.filter(modelId => existing.has(modelId) && providerIds.includes(models.find(model => model.id === modelId)!.providerId));
      const enabled = binding.enabled && providerIds.length > 0 && (binding.mode !== 'direct' || providerIds.length === 1) && (binding.modelSelection !== undefined || !binding.modelIds.length || modelIds.length > 0);
      const candidate = { ...binding, enabled, providerIds, modelIds };
      const defaultId = resolveBindingModels({ ...candidate, enabled: true }, models, providers).some(model => model.id === binding.defaultModelId) ? binding.defaultModelId : '';
      const choices = binding.connectionChoices ? structuredClone(binding.connectionChoices) : undefined;
      if (choices?.direct) {
        if (!providers.some(provider => provider.id === choices.direct!.providerId)) choices.direct = { providerId: '', defaultModelId: '' };
        else if (!models.some(model => model.id === choices.direct!.defaultModelId && model.providerId === choices.direct!.providerId)) choices.direct.defaultModelId = '';
        if (choices.direct.completionModelId && !models.some(model => model.id === choices.direct!.completionModelId && model.providerId === choices.direct!.providerId)) delete choices.direct.completionModelId;
      }
      if (choices?.aggregate) {
        const draft = choices.aggregate;
        draft.providerIds = draft.providerIds.filter(providerId => providers.some(provider => provider.id === providerId));
        draft.modelIds = draft.modelIds.filter(modelId => models.some(model => model.id === modelId && draft.providerIds.includes(model.providerId)));
        if (draft.completionModelId && !models.some(model => model.id === draft.completionModelId && draft.providerIds.includes(model.providerId))) delete draft.completionModelId;
        if (!models.some(model => model.id === draft.defaultModelId && draft.providerIds.includes(model.providerId))) draft.defaultModelId = '';
      }
      const updated = isSingleEntryTool(binding.id) ? updateSingleEntryBinding({ ...candidate, defaultModelId: defaultId, connectionChoices: choices }, {}, models, providers) : candidate;
      this.db.run('UPDATE bindings SET enabled=?,provider_ids=?,model_ids=?,default_model_id=?,connection_choices=? WHERE id=?', [Number(enabled), JSON.stringify(providerIds), JSON.stringify(modelIds), defaultId, updated.connectionChoices ? JSON.stringify(updated.connectionChoices) : null, binding.id]);
    }
  }
  addLog(log: Omit<RequestLog, 'id' | 'time'> & Partial<Pick<RequestLog, 'id' | 'time'>>): void {
    const logId = log.id ?? randomUUID(), time = log.time ?? new Date().toISOString();
    const fields = [logId, time, log.alias.slice(0, 200), log.providerName.slice(0, 120), log.endpoint.slice(0, 200), log.status, Math.max(0, Math.round(log.durationMs))];
    this.mutate(() => {
      this.db.run('INSERT OR REPLACE INTO logs(id,time,alias,provider_name,endpoint,status,duration_ms) VALUES(?,?,?,?,?,?,?)', fields);
      this.db.run('DELETE FROM logs WHERE id NOT IN(SELECT id FROM logs ORDER BY rowid DESC LIMIT 1000)');
    });
  }
  logs(limit = 100): RequestLog[] { const count = Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 100)); return this.rows('SELECT * FROM logs ORDER BY rowid DESC LIMIT ?', [count]).map(row => ({ id: String(row.id), time: String(row.time), alias: String(row.alias), providerName: String(row.provider_name), endpoint: String(row.endpoint), status: Number(row.status), durationMs: Number(row.duration_ms) })); }
  private newKey(): string { return `md_${randomBytes(32).toString('hex')}`; }
  gatewayKey(): string { return this.codec.decrypt(String(this.one("SELECT value FROM settings WHERE key='gateway_key'")!.value)); }
  rotateGatewayKey(): string { const key = this.newKey(); this.mutate(() => this.db.run('UPDATE settings SET value=? WHERE key=?', [this.codec.encrypt(key), 'gateway_key'])); return key; }
  close(): void { if (!this.closed) { this.persist(); this.db.close(); this.closed = true; } }
}
