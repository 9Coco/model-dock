import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface TraeClientModel {
  id: string;
  name?: string;
  configName?: string;
  allowedIdentities?: number[];
  locked?: true;
}
export interface TraeClientModelCatalog {
  models: TraeClientModel[];
  client: 'trae-cn' | 'trae-solo-cn';
  excludedConfigIds?: string[];
}
export interface TraeClientModelOptions {
  homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  client?: TraeClientModelCatalog['client'];
}
const MAX_DATABASE = 64 * 1024 * 1024, MAX_JSON = 4 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w.\-:/@+]{1,256}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// The installed picker's default restriction rules only run enabled feature
// routes. access/download_work and access are distinct routes selected by subKey.
export function traeModelAccess(rawFeatures: unknown): Pick<TraeClientModel, 'allowedIdentities' | 'locked'> {
  const features = object(rawFeatures);
  const early = object(features?.early_access);
  if (early?.enable === true && early.subKey === undefined && object(early.data)?.enable_early_access === false) return { locked: true };
  const access = object(features?.access);
  if (access?.enable !== true) return {};
  if (access.subKey === 'download_work') return { locked: true };
  if (access.subKey !== undefined) return {};
  const identities = object(access.data)?.identity_list;
  if (identities === undefined || identities === null) return {};
  if (!Array.isArray(identities) || !identities.every(value => typeof value === 'number' && Number.isSafeInteger(value))) return { locked: true };
  return identities.length ? { allowedIdentities: [...new Set<number>(identities)].sort((a, b) => a - b) } : {};
}

export function canUseTraeClientModel(model: TraeClientModel, payIdentity: number | undefined): boolean {
  return !model.locked && (!model.allowedIdentities || (payIdentity !== undefined && model.allowedIdentities.includes(payIdentity)));
}

/** Official IModelStore consumes native model_list_by_function snapshots.
 * Its CN chat picker uses chat_v3, excluding disabled/hard-offline/nonselectable
 * entries. Only built-in config_source=1 is part of this subscription catalog;
 * personal BYOK entries and their ak/sk/base_url are never returned. */
function parseClientSnapshot(value: string): Omit<TraeClientModelCatalog, 'client'> | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_JSON) return;
  let data: Record<string, unknown> | undefined;
  try { data = object(JSON.parse(value)); } catch { return; }
  if (!Array.isArray(data?.chat_v3) || data.chat_v3.length > 1000) return;
  const models: TraeClientModel[] = [], seen = new Set<string>(), excluded = new Set<string>();
  for (const raw of data.chat_v3) {
    const model = object(raw); if (!model) return;
    if (model.config_source !== 1) continue;
    if (!id(model.name) || seen.has(model.name)) return;
    seen.add(model.name);
    if ([model.status, model.selectable].some(value => value !== undefined && typeof value !== 'boolean')
      || model.provider_offline_status !== undefined && !['', 'soft', 'hard'].includes(String(model.provider_offline_status))) return;
    const configName = model.config_name || model.name;
    if (model.status === false || model.selectable === false || model.provider_offline_status === 'hard') {
      excluded.add(model.name);
      if (id(configName)) excluded.add(configName);
      continue;
    }
    if (!id(configName)) return;
    models.push({
      id: model.name,
      ...(label(model.display_name) ? { name: model.display_name } : {}),
      ...(configName !== model.name ? { configName } : {}),
      ...traeModelAccess(model.features),
    });
  }
  return { models, ...(excluded.size ? { excludedConfigIds: [...excluded].sort() } : {}) };
}

export function parseTraeClientModelCatalog(value: string): TraeClientModel[] | undefined {
  return parseClientSnapshot(value)?.models;
}
function roots(options: TraeClientModelOptions): { path: string; client: TraeClientModelCatalog['client'] }[] {
  const home = options.homeDir ?? homedir(), platform = options.platform ?? process.platform, env = options.env ?? process.env;
  if (!isAbsolute(home)) return [];
  if (platform !== 'linux' && platform !== 'win32') return [];
  const base = platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || join(home, '.config');
  if (!base || !isAbsolute(base) || /\0/.test(base)) return [];
  return [{ name: 'Trae CN', client: 'trae-cn' as const }, { name: 'TRAE SOLO CN', client: 'trae-solo-cn' as const }]
    .filter(({ client }) => options.client === undefined || options.client === client)
    .map(({ name, client }) => ({ path: join(base, name, 'User', 'globalStorage', 'state.vscdb'), client }));
}
/** Fixed read-only model-cache lookup scoped to the imported account. Never
 * enumerate accounts, write a cache, read PasswordSafe, or return raw JSON. */
export async function readTraeClientModelCatalog(accountId: string, options: TraeClientModelOptions = {}): Promise<TraeClientModelCatalog | undefined> {
  if (!id(accountId)) return;
  const matches: TraeClientModelCatalog[] = [];
  for (const candidate of roots(options)) {
    let db: DatabaseSync | undefined;
    try {
      const info = await lstat(candidate.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DATABASE) continue;
      db = new DatabaseSync(candidate.path, { readOnly: true, timeout: 1000 });
      for (const separator of ['_', ':']) {
        const key = accountId + separator + 'AI.agent.model.model_list_map';
        const row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key);
        if (typeof row?.value !== 'string') continue;
        const snapshot = parseClientSnapshot(row.value);
        if (snapshot) { matches.push({ ...snapshot, client: candidate.client }); break; }
      }
    } catch { /* Missing/locked/unrecognized cache is not proof of visibility. */ }
    finally { try { db?.close(); } catch { /* No account state is changed. */ } }
  }
  if (!matches.length) return;
  const canonical = (value: TraeClientModelCatalog) => JSON.stringify([
    value.models.map(model => JSON.stringify([model.id, model.configName, model.allowedIdentities, model.locked])).sort(),
    value.excludedConfigIds ?? [],
  ]);
  if (matches.some(match => canonical(match) !== canonical(matches[0]))) return;
  return matches[0];
}
