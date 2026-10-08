import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = join(root, 'dist-electron');
const marker = JSON.parse(readFileSync(join(folder, 'runtime-build.json'), 'utf8'));
const main = readFileSync(join(folder, 'main.cjs'));
if (marker.mode !== 'production' || marker.entry !== 'main.cjs' || marker.sha256 !== createHash('sha256').update(main).digest('hex')) throw new Error('Production entry or build fingerprint is invalid.');
for (const name of readdirSync(folder)) if (/^main-(?:smoke|dev)\.cjs(?:\.map)?$/.test(name) || name.endsWith('.cjs.map')) throw new Error('Development/test entry or source map is present in the release directory.');
for (const symbol of ['verifyModelMetadata', 'model-metadata-validation.json', 'verifyCompactUi', 'verifySidebarScroll', 'verifyGatewayStartup', 'createGatewayStartupSmokeVault', 'gateway-startup-ready.json', 'authQuotaFixture', 'SYNTHETIC_COPILOT_QUOTA_TOKEN', 'MOCK_ACCESS_AUTH_NETWORK']) if (main.toString('utf8').includes(symbol)) throw new Error(`Test implementation is present in production: ${symbol}`);
for (const filename of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) if (!existsSync(join(root, filename))) throw new Error(`Release notice is missing: ${filename}`);
console.log(JSON.stringify({ productionEntryVerified: true, testCodeRemoved: true, mode: marker.mode, sha256: marker.sha256 }));
