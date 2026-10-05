import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageWithOptions, extractAll, extractFile, getRawHeader, listPackage } from '@electron/asar';
import { NtExecutable, NtExecutableResource } from 'resedit';
import { safeTestDirectory } from './smoke-profile.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const asarJson = (archive, name) => JSON.parse(extractFile(archive, name).toString('utf8'));
function beneath(parent, child) { const value = relative(parent, child); return value && !value.startsWith('..') && !isAbsolute(value); }
function assertTree(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('QA packaging does not follow links.');
  if (info.isDirectory()) for (const name of readdirSync(path)) assertTree(join(path, name));
}
function ordinaryFile(filename) { const info = lstatSync(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error('QA artifact must be an ordinary file.'); }
function updateQaAsarIntegrity(executable, archive) {
  const application = NtExecutable.from(readFileSync(executable)), resource = NtExecutableResource.from(application);
  const entry = resource.entries.find(value => value.type === 'INTEGRITY' && value.id === 'ELECTRONASAR');
  if (!entry) throw new Error('QA copy is missing the production ASAR integrity resource.');
  const entries = JSON.parse(Buffer.from(entry.bin).toString('utf8')), expected = hash(getRawHeader(archive).headerString);
  let replaced = false;
  for (const value of entries) if (String(value.file).replaceAll('\\', '/') === 'resources/app.asar') { value.alg = 'SHA256'; value.value = expected; replaced = true; }
  if (!replaced) throw new Error('QA copy has an unexpected ASAR integrity contract.');
  entry.bin = Buffer.from(JSON.stringify(entries)); resource.outputResource(application);
  writeFileSync(executable, Buffer.from(application.generate()));
  const after = NtExecutableResource.from(NtExecutable.from(readFileSync(executable))).entries.find(value => value.type === 'INTEGRITY' && value.id === 'ELECTRONASAR');
  if (!after || !JSON.parse(Buffer.from(after.bin).toString('utf8')).some(value => String(value.file).replaceAll('\\', '/') === 'resources/app.asar' && value.alg === 'SHA256' && value.value === expected)) throw new Error('QA ASAR integrity resource verification failed.');
  return expected;
}

export function verifyQaExecutable(value) {
  const executable = resolve(value), folder = safeTestDirectory(dirname(executable));
  if (!beneath(safeTestDirectory(join(root, 'work')), folder) || !lstatSync(executable).isFile() || lstatSync(executable).isSymbolicLink()) throw new Error('Only a separate QA executable under work/ can run mock validation.');
  const markerPath = join(folder, 'modeldock-qa.json'); ordinaryFile(markerPath);
  if (lstatSync(markerPath).size > 16 * 1024) throw new Error('QA package marker is too large.');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  safeTestDirectory(join(folder, 'resources'));
  const archive = join(folder, 'resources/app.asar'); ordinaryFile(archive);
  const manifest = asarJson(archive, 'package.json'), build = asarJson(archive, 'dist-electron/runtime-build.json');
  if (marker.version !== 1 || marker.mode !== 'smoke' || marker.executable !== basename(executable) || marker.asarSha256 !== hash(readFileSync(archive))
    || manifest.modeldockRuntimeMode !== 'smoke' || manifest.main !== 'dist-electron/main-smoke.cjs' || build.mode !== 'smoke' || build.entry !== 'main-smoke.cjs'
    || build.sha256 !== hash(extractFile(archive, 'dist-electron/main-smoke.cjs'))) throw new Error('QA package marker or compiled smoke entry is invalid. Production executables are never test runners.');
  return executable;
}

/** Clone a production directory into a fresh workspace QA package. Never alter
 * the original artifact, launch an app, or touch any user profile. */
export async function packageSmoke(source, outputParent = join(root, 'work/qa-packages')) {
  const sourceDir = safeTestDirectory(source), releaseRoot = safeTestDirectory(join(root, 'release'));
  if (!beneath(releaseRoot, sourceDir) || existsSync(join(sourceDir, 'modeldock-qa.json'))) throw new Error('QA source must be a normal production directory under release/.');
  assertTree(sourceDir);
  const sourceArchive = join(sourceDir, 'resources/app.asar'), original = asarJson(sourceArchive, 'package.json'), originalBuild = asarJson(sourceArchive, 'dist-electron/runtime-build.json');
  if (original.main !== 'dist-electron/main.cjs' || original.modeldockRuntimeMode === 'smoke' || originalBuild.mode !== 'production'
    || originalBuild.sha256 !== hash(extractFile(sourceArchive, 'dist-electron/main.cjs'))) throw new Error('QA source must have a verified production entry.');
  if (listPackage(sourceArchive, {}).some(name => /(?:^|\/)main-(?:smoke|dev)\.cjs(?:\.map)?$/.test(name))) throw new Error('Production source archive must not contain test/development entries.');
  const parent = safeTestDirectory(outputParent, true);
  if (!beneath(safeTestDirectory(join(root, 'work')), parent)) throw new Error('QA output must stay under the workspace work/ directory.');
  const qaRoot = join(parent, randomUUID()); mkdirSync(qaRoot, { mode: 0o700 });
  const unpacked = join(qaRoot, 'application'), target = join(qaRoot, 'unpacked');
  cpSync(sourceDir, target, { recursive: true });
  extractAll(sourceArchive, unpacked);
  const smokeRoot = join(root, 'work/smoke-runtime'), smokeBuild = JSON.parse(readFileSync(join(smokeRoot, 'dist-electron/runtime-build.json'), 'utf8'));
  if (smokeBuild.mode !== 'smoke' || smokeBuild.sha256 !== hash(readFileSync(join(smokeRoot, 'dist-electron/main-smoke.cjs')))) throw new Error('Build the independent smoke entry before QA packaging.');
  cpSync(join(smokeRoot, 'dist-electron/main-smoke.cjs'), join(unpacked, 'dist-electron/main-smoke.cjs'));
  cpSync(join(smokeRoot, 'dist-electron/runtime-build.json'), join(unpacked, 'dist-electron/runtime-build.json'));
  unlinkSync(join(unpacked, 'dist-electron/main.cjs'));
  writeFileSync(join(unpacked, 'package.json'), JSON.stringify({ ...original, name: 'model-dock-smoke', main: 'dist-electron/main-smoke.cjs', modeldockRuntimeMode: 'smoke' }, null, 2));
  const archive = join(target, 'resources/app.asar');
  await createPackageWithOptions(unpacked, archive, { unpack: '**/*.node', unpackDir: 'node_modules/sql.js/dist' });
  const executable = process.platform === 'win32' ? 'ModelDock.exe' : ['model-dock', 'ModelDock'].find(name => existsSync(join(target, name)));
  if (!executable) throw new Error('QA directory does not contain the ModelDock executable.');
  if (!existsSync(join(target, executable))) throw new Error(`QA directory does not contain ${executable}.`);
  const embeddedAsarHeaderHash = process.platform === 'win32' ? updateQaAsarIntegrity(join(target, executable), archive) : undefined;
  writeFileSync(join(target, 'modeldock-qa.json'), JSON.stringify({ version: 1, mode: 'smoke', executable, productionSource: sourceDir,
    productionAsarSha256: hash(readFileSync(sourceArchive)), asarSha256: hash(readFileSync(archive)), embeddedAsarHeaderHash }, null, 2));
  const filename = verifyQaExecutable(join(target, executable));
  return { directory: target, executable: filename, mode: 'smoke', productionArtifactChanged: false };
}
