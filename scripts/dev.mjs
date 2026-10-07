import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import electron from 'electron';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, 'scripts/build-main.mjs'), '--development'], { cwd: root, stdio: 'inherit', windowsHide: true });
const server = await createServer(); await server.listen();
const env = { ...process.env, MODELDOCK_DEV_URL: 'http://127.0.0.1:5178' };
for (const key of Object.keys(env)) if (key.startsWith('MODELDOCK_SMOKE')) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
// Windows GUI apps must not inherit a hidden startup state for their first ShowWindow call.
const child = spawn(electron, [join(root, 'work/dev-runtime')], { stdio: 'inherit', env });
let closing = false;
async function close() { if (closing) return; closing = true; child.kill(); await server.close(); }
child.on('exit', async code => { await close(); process.exit(code ?? 0); });
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
