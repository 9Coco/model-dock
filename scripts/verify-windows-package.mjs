import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, getRawHeader, listPackage, statFile } from '@electron/asar';
import { NtExecutable, NtExecutableResource } from 'resedit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const fixtureSymbols = [
  'verifyModelMetadata', 'model-metadata-validation.json',
  'verifyCompactUi', 'verifySidebarScroll', 'verifyGatewayStartup', 'createGatewayStartupSmokeVault', 'gateway-startup-ready.json', 'authQuotaFixture',
  'SYNTHETIC_COPILOT_QUOTA_TOKEN', 'MOCK_ACCESS_AUTH_NETWORK',
  'verifyContextMenus', 'context-menu-validation.json', 'synthetic-context-menu-key',
  'verifyOpenCodeDesktop', 'opencode-desktop-validation.json', 'synthetic-desktop-smoke-key', 'verifyRelaySubscriptions', 'relay-subscriptions-validation.json', 'synthetic-trae-relay-key', 'synthetic-jetbrains-relay-key',
  'verifyNavigationConsolidation', 'navigation-consolidation-validation.json', 'synthetic-navigation-api-key',
  'observeWindowPresentation', 'window-presentation-validation.json', 'probe-focus-request',
  'verifySidebarLayout', 'sidebar-layout-validation.json', 'synthetic-sidebar-layout-key', 'revealSmokeNavigationTarget',
  'verifyRelayClientImport', 'relay-client-import-validation.json', 'synthetic-relay-import-manual-key', 'qa-relay-client-import-stage', 'PRIVATE_RELAY_IMPORT', 'qa-relay-quota-mode', 'PRIVATE_RELAY_QUOTA_TOKEN_RAW_BODY', 'verifyRelayQuota', 'relay-quota-validation.json', 'PRIVATE_RELAY_QUOTA_MANUAL_KEY', 'createJetBrainsIdeFixture', 'verifyJetBrainsIdeImport', 'qa-jetbrains-ide-mode', 'PRIVATE_JETBRAINS_IDE_GRAZIE_TOKEN', 'jetbrains-ide-import-validation.json',
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

  for (const name of ['LICENSE', 'LICENSE-MIT', 'THIRD_PARTY_NOTICES.md']) {
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
  assert(!existsSync(join(resources, 'trae-bridge')), 'Removed client bridge is present in the package.');
  assert(!names.some(name => name.startsWith('assets/trae-bridge/')), 'Removed client bridge is present inside ASAR.');

  const networkSource = join(root, 'resources/flowbridge');
  const networkOutput = join(resources, 'flowbridge');
  const verifyNetworkFile = name => verifyCopiedFile(join(networkSource, name), join(networkOutput, name));
  for (const name of ['bridge.py', 'signal_core.py', 'manifest.json', 'LICENSE', 'windows/install-network.ps1', 'windows/network-payload.json',
    'termux/termux-hotspot-proxy.sh', 'windows/THIRD-PARTY-NOTICES.md',
    'linux/relay.py', 'linux/connectivity.py', 'linux/tun_client.py']) verifyNetworkFile(name);
  for (const name of readdirSync(join(networkSource, 'windows'))) {
    if (name.endsWith('.py') && !name.startsWith('test_')) verifyNetworkFile(join('windows', name));
  }
  assertOrdinaryFile(join(networkOutput, 'python/python.exe'));
  const payload = readOrdinaryFile(join(networkOutput, 'windows/network-payload.json'));
  assert(readOrdinaryFile(join(networkOutput, 'windows/network_access.py')).toString('utf8').includes("PAYLOAD_SHA256 = '" + digest(payload) + "'"), 'Network task payload manifest differs from the pinned version.');
  for (const [name, hash] of Object.entries(JSON.parse(payload))) {
    assert(digest(readOrdinaryFile(join(networkOutput, name))) === hash, 'Network task payload checksum mismatch: ' + name);
  }
  if (process.platform === 'win32') {
    const stage = mkdtempSync(join(tmpdir(), 'modeldock-install-check-'));
    try {
      const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        join(root, 'scripts/verify-windows-install.ps1'), networkOutput, stage], { stdio: 'inherit', windowsHide: true });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(join(networkSource, 'python'))) verifyNetworkFile(join('python', name));
  const core = JSON.parse(readOrdinaryFile(join(networkSource, 'tools/windows-core.json')).toString('utf8'));
  for (const name of ['sing-box.exe', 'wintun.dll', 'LICENSE-wintun.txt', 'verified.json']) {
    verifyNetworkFile(join('vendor', `sing-box-${core.version}-windows-amd64`, name));
  }
  readPackedFile('dist-electron/network-mini-preload.cjs');

  const wasmName = 'node_modules/sql.js/dist/sql-wasm.wasm';
  assert(names.includes(wasmName) && statFile(archive, normalize(wasmName), false).unpacked === true,
    'SQL WASM must be present in app.asar.unpacked.');
  verifyCopiedFile(join(root, wasmName), join(resources, 'app.asar.unpacked', wasmName));

  assert(!names.includes('dist-electron/central-pi-extension.mjs'), 'Removed external relay extension is present in the package.');
  assert(!existsSync(join(resources, 'trae-native-relay')), 'Removed Python relay runtime is present in the package.');

  const executable = join(directory, 'ModelDock.exe');
  assertOrdinaryFile(executable);
  // 修改点：资源刷新后同时校验 Windows PE 内嵌 ASAR header SHA，避免保留旧记录。
  const exeResources = NtExecutableResource.from(NtExecutable.from(readOrdinaryFile(executable)));
  const integrity = exeResources.entries.find(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  assert(integrity, 'Windows executable is missing the embedded ASAR integrity resource.');
  const integrityEntries = JSON.parse(Buffer.from(integrity.bin).toString('utf8'));
  const expectedHeaderHash = digest(getRawHeader(archive).headerString);
  const matchingEntries = integrityEntries.filter(entry => String(entry.file).split(String.fromCharCode(92)).join('/') === 'resources/app.asar');
  assert(matchingEntries.length === 1 && matchingEntries[0].alg === 'SHA256' && matchingEntries[0].value === expectedHeaderHash,
    'Embedded ASAR integrity does not match the packaged app.asar header.');
  execFileSync(process.execPath, [join(root, 'scripts/verify-exe-icon.mjs'), executable],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(JSON.stringify({ windowsPackageVerified: true, version: manifest.version,
    directory, productionEntryVerified: true, resourcesVerified: true, nativeGatewayAdaptersVerified: true,
    iconVerified: true, embeddedAsarIntegrityVerified: true }));
}

try {
  assert(process.argv.length === 3 && process.argv[2],
    'Usage: node scripts/verify-windows-package.mjs <win-unpacked-directory>');
  verifyPackage(resolve(process.argv[2]));
} catch (error) {
  console.error(`Windows package verification failed: ${error.message}`);
  process.exitCode = 1;
}
