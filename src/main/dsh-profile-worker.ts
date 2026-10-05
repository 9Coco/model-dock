import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DshProfileError, sanitizeDshBaselineProviders, validateDshProfileMetadata, type DshProfileModelPlugin, type DshProfileWorkerRequest } from './dsh-profile';

const maxBytes = 1024 * 1024;
const sourceNames = new Set(['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek-account']);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new DshProfileError('profile'); }

function flatten(entries: unknown[], output: Record<string, any>[] = [], depth = 0): Record<string, any>[] {
  if (depth > 30 || entries.length > 10000 || output.length > 10000) fail();
  for (const row of entries) {
    if (!object(row)) fail(); output.push(row);
    if (row.group && Array.isArray(row.config)) flatten(row.config, output, depth + 1);
  }
  return output;
}

function request(value: unknown): DshProfileWorkerRequest {
  if (!object(value) || Object.keys(value).some((key) => !['home', 'profileName', 'installAnchor'].includes(key))
    || typeof value.home !== 'string' || !isAbsolute(value.home) || typeof value.installAnchor !== 'string' || !isAbsolute(value.installAnchor)
    || !['desktop', 'web', 'acp'].includes(value.profileName) || [value.home, value.installAnchor].some((path) => path.length > 4096 || /[\x00-\x1f]/.test(path))) fail();
  return value as DshProfileWorkerRequest;
}

async function inspect(value: DshProfileWorkerRequest) {
  const anchor = statSync(value.installAnchor);
  if (!anchor.isFile() || anchor.size > maxBytes) fail();
  const manifest = JSON.parse(readFileSync(value.installAnchor, 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') fail();
  // Import the installed official composition library, never user plugin
  // entrypoints. loadProfileDirectory resolves package manifests and YAML
  // bundles; composeEntries does not evaluate native !!js expressions.
  const nativeRequire = createRequire(value.installAnchor);
  const location = nativeRequire.resolve('@deepseek-ai/dsh-app-boot');
  const native = await import(pathToFileURL(location).href);
  if (!['loadProfileDirectory', 'loadOptionalPatches', 'composeEntries'].every((name) => typeof native[name] === 'function')) fail();
  const profile = native.loadProfileDirectory('dsh', join(value.home, 'profiles', value.profileName), value.installAnchor);
  // Skipped layers could hide another model adapter. A partial composition
  // must never be reported as successful selected-only synchronization.
  if (!Array.isArray(profile.layers) || !Array.isArray(profile.patches) || profile.skippedBundles?.length) fail();
  const layers = [profile.layers.flatMap((layer: any) => layer.patches), profile.patches];
  const lower = flatten(native.composeEntries(layers));
  const homePatches = native.loadOptionalPatches('dsh', join(value.home, 'cordis.patch.yml')) ?? [];
  const effective = flatten(native.composeEntries([...layers, homePatches]));
  const ids = new Set<string>();
  for (const row of effective) {
    if (typeof row.id === 'string' && row.id.length) { if (ids.has(row.id)) fail(); ids.add(row.id); }
  }
  const pi = lower.find((row) => row.id === 'llm-pi-ai');
  const currentPi = effective.find((row) => row.id === 'llm-pi-ai');
  const modelDefault = effective.find((row) => row.id === 'agent-default-model');
  if (pi?.name !== '@deepseek-ai/dsh-llm-pi-ai' || currentPi?.name !== '@deepseek-ai/dsh-llm-pi-ai' || modelDefault?.name !== '@deepseek-ai/dsh-agent-default-model') fail();
  const modelPlugins: DshProfileModelPlugin[] = effective.filter((row) => sourceNames.has(row.name)).map((row) => {
    if (typeof row.id !== 'string' || !row.id) fail(); return { id: row.id, name: row.name };
  });
  const metadata = validateDshProfileMetadata({ version: 1, profileName: value.profileName, runtimeVersion: manifest.version,
    modelPlugins, baselineProviders: sanitizeDshBaselineProviders(pi.config?.providers) });
  return metadata;
}

// An isolated short-lived worker gets no credential document or user session.
// Suppress dependency diagnostics; stdout is one bounded metadata envelope.
console.log = console.info = console.warn = console.error = () => {};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 16384) { process.stdout.write(JSON.stringify({ ok: false, category: 'protocol' })); process.exit(0); }
});
process.stdin.on('end', () => {
  void (async () => {
    try { const metadata = await inspect(request(JSON.parse(input))); process.stdout.write(JSON.stringify({ ok: true, metadata })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, category: error instanceof DshProfileError ? error.category : 'profile' })); }
  })();
});
