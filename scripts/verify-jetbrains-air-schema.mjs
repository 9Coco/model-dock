import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Installed plugin classes only. This fixture has synthetic metadata, and never
// starts the IDE or accesses its credential services or configuration files.
const [ideHome, pluginHome, ...extra] = process.argv.slice(2);
if (!ideHome || !pluginHome || extra.length) throw new Error('Usage: node scripts/verify-jetbrains-air-schema.mjs <IDE-home> <Air-plugin-directory>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(resolve(ideHome), 'jbr', 'bin');
const suffix = process.platform === 'win32' ? '.exe' : '';
const javac = join(runtime, `javac${suffix}`), java = join(runtime, `java${suffix}`);
for (const file of [javac, java, join(resolve(pluginHome), 'lib', 'modules', 'intellij.air.frontend.llm.jar')]) {
  if (!existsSync(file)) throw new Error(`Installed runtime/plugin file unavailable: ${file}`);
}
const fixture = join(root, 'tests', 'fixtures', 'jetbrains-air', 'AirSchemaProbe.java');
const classpath = [join(resolve(ideHome), 'lib', '*'), join(resolve(pluginHome), 'lib', 'modules', '*')].join(delimiter);
const output = mkdtempSync(join(tmpdir(), 'modeldock-air-schema-'));
try {
  execFileSync(javac, ['-cp', classpath, '-d', output, fixture], { stdio: 'pipe', timeout: 30000, windowsHide: true });
  const result = execFileSync(java, ['-cp', output + delimiter + classpath, 'AirSchemaProbe'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (!result.startsWith('AIR_SCHEMA_OK ')) throw new Error('Installed Air schema validation did not report success.');
  console.log(JSON.stringify({ installedAirSerializerRoundTrip: true, nativeOpenAiProviderIdentity: true, nativeUuidValidation: true, nativeApiKeyRequired: true, metadataOnly: true, passwordSafeAccessed: false }));
} finally { rmSync(output, { recursive: true, force: true }); }
