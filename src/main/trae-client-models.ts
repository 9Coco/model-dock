import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface TraeClientModel { id: string; name?: string }
export interface TraeClientModelCatalog { models: TraeClientModel[]; client: 'trae-cn' | 'trae-solo-cn' }
export interface TraeClientModelOptions {
  homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  client?: TraeClientModelCatalog['client'];
}
const MAX_DATABASE = 64 * 1024 * 1024, MAX_JSON = 4 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w.\-:/@+]{1,256}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Official IModelStore consumes native model_list_by_function snapshots.
 * Its CN chat picker uses chat_v3, excluding disabled/hard-offline/nonselectable
 * entries. Only built-in config_source=1 is part of this subscription catalog;
 * personal BYOK entries and their ak/sk/base_url are never returned. */
export function parseTraeClientModelCatalog(value: string): TraeClientModel[] | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_JSON) return;
  let data: Record<string, unknown> | undefined;
  try { data = object(JSON.parse(value)); } catch { return; }
  if (!Array.isArray(data?.chat_v3) || data.chat_v3.length > 1000) return;
  const models: TraeClientModel[] = [], seen = new Set<string>();
  for (const raw of data.chat_v3) {
    const model = object(raw); if (!model) return;
    if (model.config_source !== 1) continue;
    if (!id(model.name) || seen.has(model.name)) return;
    seen.add(model.name);
    if ([model.status, model.selectable].some(value => value !== undefined && typeof value !== 'boolean')
      || model.provider_offline_status !== undefined && !['', 'soft', 'hard'].includes(String(model.provider_offline_status))) return;
    if (model.status === false || model.selectable === false || model.provider_offline_status === 'hard') continue;
    models.push({ id: model.name, ...(label(model.display_name) ? { name: model.display_name } : {}) });
  }
  return models;
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
        const models = parseTraeClientModelCatalog(row.value);
        if (models) { matches.push({ models, client: candidate.client }); break; }
      }
    } catch { /* Missing/locked/unrecognized cache is not proof of visibility. */ }
    finally { try { db?.close(); } catch { /* No account state is changed. */ } }
  }
  if (!matches.length) return;
  const canonical = (value: TraeClientModelCatalog) => JSON.stringify(value.models.map(model => model.id).sort());
  if (matches.some(match => canonical(match) !== canonical(matches[0]))) return;
  return matches[0];
}
