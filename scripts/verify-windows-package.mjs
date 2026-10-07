import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile } from '@electron/asar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const fixtureSymbols = [
  'verifyCompactUi', 'verifySidebarScroll', 'verifyGatewayStartup', 'createGatewayStartupSmokeVault', 'gateway-startup-ready.json', 'authQuotaFixture',
  'SYNTHETIC_COPILOT_QUOTA_TOKEN', 'MOCK_ACCESS_AUTH_NETWORK',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOrdinaryFile(filename) {
  const info = lstatSync(filename);
  assert(info.isFile() && !info.isSymbolicLink(), `Expected an ordinary package file: ${filename}`);
  assert(info.size > 0, `Package file is empty: ${filename}`);
}

function readOrdinaryFile(filename) {
  assertOrdinaryFile(filename);
  return readFileSync(filename);
}

function verifyCopiedFile(source, destination) {
  assert(digest(readOrdinaryFile(source)) === digest(readOrdinaryFile(destination)),
    `Package resource does not match the current source: ${destination}`);
}

function verifyPackage(directory) {
  const info = lstatSync(directory);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'The package must be an ordinary win-unpacked directory.');
  const resources = join(directory, 'resources');
  const archive = join(resources, 'app.asar');
  assertOrdinaryFile(archive);

  const names = listPackage(archive, {}).map(name => name.replaceAll('\\', '/').replace(/^\/+/, ''));
  const readPackedFile = name => {
    assert(names.includes(name), `Packaged file is missing: ${name}`);
    const nativeName = normalize(name);
    const entry = statFile(archive, nativeName, false);
    assert(!('link' in entry) && !('files' in entry) && !entry.unpacked,
      `Production entry must be a regular file inside ASAR: ${name}`);
    return extractFile(archive, nativeName, false);
  };
  const sourceManifest = JSON.parse(readOrdinaryFile(join(root, 'package.json')).toString('utf8'));
  const manifest = JSON.parse(readPackedFile('package.json').toString('utf8'));
  const marker = JSON.parse(readPackedFile('dist-electron/runtime-build.json').toString('utf8'));
  const main = readPackedFile('dist-electron/main.cjs');
  assert(manifest.version === sourceManifest.version, 'Packaged version does not match package.json.');
  assert(manifest.main === 'dist-electron/main.cjs', 'Packaged main must point to the production entry.');
  assert(manifest.modeldockRuntimeMode === undefined || manifest.modeldockRuntimeMode === 'production',
    'Packaged manifest contains a development or test runtime mode.');
  assert(marker.version === 1 && marker.mode === 'production' && marker.entry === 'main.cjs'
    && marker.sha256 === digest(main), 'Packaged production build fingerprint is invalid.');

  for (const name of names) {
    assert(!/(?:^|\/)main-(?:smoke|dev)\.cjs(?:\.map)?$/.test(name),
      `Development or test entry is present in the package: ${name}`);
    // Match the established production boundary: Electron runtime source maps
    // are forbidden; renderer maps currently remain enabled in vite.config.ts.
    assert(!(name.startsWith('dist-electron/') && name.endsWith('.map')),
      `Electron source map is present in the package: ${name}`);
    if (name.startsWith('dist-electron/') && name.endsWith('.cjs')) {
      const contents = readPackedFile(name).toString('utf8');
      for (const symbol of fixtureSymbols) assert(!contents.includes(symbol),
        `Test implementation is present in the package: ${symbol}`);
    }
  }
  readPackedFile('dist/index.html');

  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    verifyCopiedFile(join(root, name), join(resources, 'licenses/modeldock', name));
  }
  for (const category of ['tool-icons', 'material-symbols']) {
    const source = join(root, 'src/renderer/assets', category);
    const files = readdirSync(source).filter(name => /^LICENSE-.*\.txt$/.test(name)
      || name === 'NOTICE.md' || name === 'manifest.json');
    assert(files.some(name => name.startsWith('LICENSE-')), `Source license is missing for ${category}.`);
    for (const name of files) verifyCopiedFile(join(source, name), join(resources, 'licenses', category, name));
  }
  for (const name of ['modeldock.png', 'modeldock-tray.png', 'modeldock.ico', 'modeldock.svg']) {
    verifyCopiedFile(join(root, 'assets', name), join(resources, 'icons', name));
  }

  const wasmName = 'node_modules/sql.js/dist/sql-wasm.wasm';
  assert(names.includes(wasmName) && statFile(archive, normalize(wasmName), false).unpacked === true,
    'SQL WASM must be present in app.asar.unpacked.');
  verifyCopiedFile(join(root, wasmName), join(resources, 'app.asar.unpacked', wasmName));

  const executable = join(directory, 'ModelDock.exe');
  assertOrdinaryFile(executable);
  execFileSync(process.execPath, [join(root, 'scripts/verify-exe-icon.mjs'), executable],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(JSON.stringify({ windowsPackageVerified: true, version: manifest.version,
    directory, productionEntryVerified: true, resourcesVerified: true, iconVerified: true }));
}

try {
  assert(process.argv.length === 3 && process.argv[2],
    'Usage: node scripts/verify-windows-package.mjs <win-unpacked-directory>');
  verifyPackage(resolve(process.argv[2]));
} catch (error) {
  console.error(`Windows package verification failed: ${error.message}`);
  process.exitCode = 1;
}
