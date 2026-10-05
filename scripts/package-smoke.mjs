import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageSmoke } from './smoke-package.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2] || process.argv.length > 4) throw new Error('Usage: node scripts/package-smoke.mjs <production-unpacked-directory> [workspace-work-output-parent]');
execFileSync(process.execPath, [join(root, 'scripts/build-main.mjs'), '--smoke'], { cwd: root, stdio: 'inherit', windowsHide: true });
console.log(JSON.stringify(await packageSmoke(resolve(process.argv[2]), process.argv[3] ? resolve(process.argv[3]) : undefined), null, 2));
