import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !['--smoke', '--development'].includes(args[0])) throw new Error('Usage: node scripts/build-main.mjs [--smoke|--development]');
const mode = args[0] === '--smoke' ? 'smoke' : args[0] === '--development' ? 'development' : 'production';
const runtimeRoot = mode === 'production' ? root : join(root, 'work', `${mode === 'smoke' ? 'smoke' : 'dev'}-runtime`);
const entry = mode === 'smoke' ? 'main-smoke' : mode === 'development' ? 'main-dev' : 'main';
if (mode === 'production') for (const name of ['main-smoke.cjs', 'main-smoke.cjs.map', 'main-dev.cjs', 'main-dev.cjs.map', 'main.cjs.map', 'preload.cjs.map', 'dsh-profile-worker.cjs.map']) {
  const filename = join(root, 'dist-electron', name); if (existsSync(filename)) unlinkSync(filename);
}
await build({ absWorkingDir: root, entryPoints: { [entry]: 'src/main/main.ts', preload: 'src/main/preload.ts', 'dsh-profile-worker': 'src/main/dsh-profile-worker.ts' }, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', outdir: join(runtimeRoot, 'dist-electron'), outExtension: { '.js': '.cjs' },
  packages: 'external', external: ['electron', 'sql.js'], define: { 'import.meta.url': '__filename', '__MODELDOCK_RUNTIME_MODE__': JSON.stringify(mode), '__MODELDOCK_SMOKE_BUILD__': JSON.stringify(mode === 'smoke') },
  treeShaking: true, minifySyntax: true, sourcemap: mode !== 'production' });
writeFileSync(join(runtimeRoot, 'dist-electron/runtime-build.json'), JSON.stringify({ version: 1, mode, entry: `${entry}.cjs`,
  sha256: createHash('sha256').update(readFileSync(join(runtimeRoot, 'dist-electron', `${entry}.cjs`))).digest('hex') }, null, 2));
if (mode !== 'production') {
  mkdirSync(runtimeRoot, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({ ...manifest, name: `model-dock-${mode}`, main: `dist-electron/${entry}.cjs`, modeldockRuntimeMode: mode }, null, 2));
  cpSync(join(root, 'assets'), join(runtimeRoot, 'assets'), { recursive: true });
  if (mode === 'smoke') {
    if (!existsSync(join(root, 'dist/index.html'))) throw new Error('Smoke renderer is missing. Run npm run build first or use the smoke runner automatic build.');
    cpSync(join(root, 'dist'), join(runtimeRoot, 'dist'), { recursive: true });
  }
  console.log(JSON.stringify({ mode, application: runtimeRoot, entry: `dist-electron/${entry}.cjs` }));
}
