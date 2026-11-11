import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Revalidate the maintained snapshot and real generated requests against the
// installed official serializers. Never start the IDE or read account files.
const [ideHome, assistantHome, junieHome, ...extra] = process.argv.slice(2);
if (!ideHome || !assistantHome || !junieHome || extra.length) throw new Error('Usage: node scripts/verify-jetbrains-reasoning.mjs <IDE-home> <AI-Assistant-plugin> <Junie-plugin>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const java = join(resolve(ideHome), 'jbr', 'bin', `java${suffix}`), javac = join(resolve(ideHome), 'jbr', 'bin', `javac${suffix}`);
const classpath = [join(resolve(junieHome), 'lib', '*'), join(resolve(assistantHome), 'lib', 'modules', '*'), join(resolve(ideHome), 'lib', '*')].join(delimiter);
const output = mkdtempSync(join(tmpdir(), 'modeldock-jb-reasoning-'));
try {
  execFileSync(javac, ['-cp', classpath, '-d', output, join(root, 'tests/fixtures/jetbrains-reasoning/ReasoningSchemaProbe.java')], { stdio: 'pipe', timeout: 30000, windowsHide: true });
  const run = args => execFileSync(java, ['-cp', output + delimiter + classpath, 'ReasoningSchemaProbe', ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const bundled = await build({ stdin: { contents: "export { jetBrainsReasoning } from './src/main/jetbrains-reasoning'; export { prepareJetBrainsGrazieChat } from './src/main/jetbrains-grazie-bridge';", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false });
  const modulePath = join(output, 'adapter.cjs'); writeFileSync(modulePath, bundled.outputFiles[0].contents);
  const { jetBrainsReasoning, prepareJetBrainsGrazieChat } = createRequire(import.meta.url)(modulePath);
  const requests = [], seen = new Set();
  for (const row of run([]).trim().split(/\r?\n/)) {
    const [id, family, levels, defaultLevel] = row.split('\t');
    if (seen.has(id)) continue; seen.add(id);
    const provider = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic', GOOGLE: 'Google', XAI: 'Xai' }[family.toUpperCase()];
    const reasoning = jetBrainsReasoning(id, provider, ['reasoningEffort']);
    if (!reasoning) continue;
    assert.deepEqual(reasoning, { levels: levels.split(','), defaultLevel }, id);
    for (const level of reasoning.levels) requests.push(level + '\t' + JSON.stringify(prepareJetBrainsGrazieChat({ messages: [{ role: 'user', content: 'synthetic serializer fixture' }], reasoning_effort: level }, { profileId: id, reasoningEfforts: reasoning.levels })));
  }
  assert.ok(requests.length >= 100, 'The installed model snapshot must exercise all supported families');
  const input = join(output, 'requests.tsv'); writeFileSync(input, requests.join('\n'));
  assert.equal(run([input]).trim(), `JETBRAINS_REASONING_SCHEMA_OK ${requests.length}`);
  console.log(JSON.stringify({ installedEffortSnapshotVerified: true, nativeV9SerializerRoundTrips: requests.length, liveInference: false }));
} finally {
  assert.equal(dirname(resolve(output)), resolve(tmpdir()));
  rmSync(output, { recursive: true, force: true });
}
