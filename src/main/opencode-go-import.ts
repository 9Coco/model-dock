import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OPENCODE_GO_BASE_URL } from '../shared/presets';
import type { Provider } from '../shared/types';
import { normalizeApiKey } from './credentials';
import type { Store } from './store';

type Draft = Pick<Provider, 'name' | 'enabled' | 'note'> & { id?: string };
const missing = '未找到 OpenCode Go 的本地密钥。请先在 OpenCode 的 /connect 中连接 OpenCode Go，再重试。';

function readClientKey(home: string, env: NodeJS.ProcessEnv): string {
  const directory = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
  const database = env.OPENCODE_DB || join(directory, 'opencode.db');
  if (!isAbsolute(database)) throw new Error('请为 OpenCode 客户端指定绝对数据库路径。');
  let entry: { type?: unknown; key?: unknown } | undefined;
  let usesDatabase = false;
  if (existsSync(database)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(database, { readOnly: true, timeout: 1000 });
      const columns = new Set(db.prepare('PRAGMA table_info(credential)').all().map(row => row.name));
      if (columns.size) {
        usesDatabase = true;
        const providerColumn = columns.has('integration_id') ? 'integration_id' : 'connector_id';
        const order = columns.has('active') ? 'active DESC, time_created DESC, id DESC' : 'time_created DESC, id DESC';
        const row = db.prepare('SELECT value FROM credential WHERE ' + providerColumn + ' = ? ORDER BY ' + order + ' LIMIT 1').get('opencode-go');
        if (typeof row?.value === 'string' && row.value.length <= 64 * 1024) entry = JSON.parse(row.value);
      }
    } catch { throw new Error('无法读取 OpenCode 客户端凭据数据库，请检查文件权限或稍后重试。'); }
    finally { db?.close(); }
  } else if (env.OPENCODE_DB) throw new Error('未找到 OpenCode 指定的客户端数据库。');
  if (!usesDatabase) {
    const file = join(directory, 'auth.json');
    if (!existsSync(file)) throw new Error(missing);
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
      entry = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))?.['opencode-go'];
    } catch { throw new Error('无法读取 OpenCode 的 auth.json，请在客户端重新保存 Go 密钥。'); }
  }
  if (!entry) throw new Error(missing);
  if (entry.type !== (usesDatabase ? 'key' : 'api') || typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > 8192) {
    throw new Error('当前 OpenCode Go 账号未保存工作区 API Key。请在客户端选择密钥登录，或在此手动填写。');
  }
  const key = normalizeApiKey(entry.key);
  if (!key) throw new Error(missing);
  return key;
}

/** Invoked only by an explicit import. Only the renderer-safe Provider leaves this module. */
export function importOpenCodeGo(store: Store, draft: Draft, home: string, env: NodeJS.ProcessEnv): Provider {
  const existing = draft?.id ? store.getProvider(draft.id) : undefined;
  if (!draft || (draft.id !== undefined && existing?.kind !== 'opencode-go')) throw new Error('请选择要更新的 OpenCode Go 订阅。');
  const apiKey = readClientKey(home, env);
  if (!existing) {
    const same = store.listProviders().find(p => p.kind === 'opencode-go' && store.getSecret(p.id)?.apiKey === apiKey);
    if (same) return same;
  }
  return store.saveProvider({ id: existing?.id, name: draft.name, enabled: draft.enabled, note: draft.note, kind: 'opencode-go', presetId: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL, apiKey });
}
