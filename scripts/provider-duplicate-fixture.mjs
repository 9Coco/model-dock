import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Seed a fresh smoke-test directory only. These credentials are synthetic. */
export async function seedProviderDuplicates(dataDir) {
  const filename = join(dataDir, 'modeldock.sqlite');
  const keyPath = join(dataDir, 'vault.key');
  if (existsSync(filename) || existsSync(keyPath)) throw new Error('Duplicate fixture requires a fresh data directory');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  const db = new SQL.Database();
  const key = randomBytes(32);
  function encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return 'local:' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  try {
    db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,base_url TEXT NOT NULL,enabled INTEGER NOT NULL,auth_status TEXT NOT NULL,note TEXT NOT NULL,preset_id TEXT NOT NULL DEFAULT 'custom');
      CREATE TABLE secrets(provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,ciphertext TEXT NOT NULL);
      CREATE TABLE models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,upstream_id TEXT NOT NULL,alias TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,wire_api TEXT NOT NULL,context_window INTEGER NOT NULL,tools INTEGER NOT NULL,vision INTEGER NOT NULL,enabled INTEGER NOT NULL);
      CREATE TABLE bindings(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,model_ids TEXT NOT NULL,default_model_id TEXT NOT NULL,note TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'aggregate',provider_ids TEXT);
      CREATE TABLE logs(id TEXT PRIMARY KEY,time TEXT NOT NULL,alias TEXT NOT NULL,provider_name TEXT NOT NULL,endpoint TEXT NOT NULL,status INTEGER NOT NULL,duration_ms INTEGER NOT NULL);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const presets = [
      ['deepseek', 'DeepSeek', 'openai-compatible', 'https://api.deepseek.com'],
      ['volcengine-agent', '火山 Agent Plan', 'openai-compatible', 'https://ark.cn-beijing.volces.com/api/plan/v3'],
      ['volcengine-token', '火山 Coding Plan', 'openai-compatible', 'https://ark.cn-beijing.volces.com/api/coding/v3'],
      ['qwen-token', '千问 Token Plan', 'openai-compatible', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'],
      ['codex-subscription', 'Codex 订阅', 'codex', 'https://chatgpt.com/backend-api/codex'],
      ['grok-build', 'Grok Build 订阅', 'grok', 'https://cli-chat-proxy.grok.com/v1'],
    ];
    for (const [id, name, kind, baseUrl] of presets) {
      db.run('INSERT INTO providers(id,name,kind,base_url,enabled,auth_status,note,preset_id) VALUES(?,?,?,?,?,?,?,?)', [id, name, kind, baseUrl, 1, 'missing', '', id]);
    }
    for (const suffix of ['a', 'b']) {
      const providerId = `duplicate-deepseek-${suffix}`;
      db.run('INSERT INTO providers(id,name,kind,base_url,enabled,auth_status,note,preset_id) VALUES(?,?,?,?,?,?,?,?)', [providerId, 'DeepSeek', 'openai-compatible', 'https://api.deepseek.com', 1, 'ready', '', 'deepseek']);
      db.run('INSERT INTO secrets(provider_id,ciphertext) VALUES(?,?)', [providerId, encrypt({ apiKey: 'synthetic-only' })]);
      db.run('INSERT INTO models(id,provider_id,upstream_id,alias,display_name,wire_api,context_window,tools,vision,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)', [`duplicate-model-${suffix}`, providerId, 'duplicate-model', `duplicate-${suffix}`, `旧别名 ${suffix.toUpperCase()}`, 'chat-completions', 64000, 1, 0, 1]);
    }
    db.run('INSERT INTO settings(key,value) VALUES(?,?)', ['initialized', '1']);
    writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
    writeFileSync(filename, db.export(), { flag: 'wx', mode: 0o600 });
  } finally {
    db.close();
    key.fill(0);
  }
}
