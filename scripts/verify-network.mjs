// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('resources/flowbridge');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
for (const entry of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(root, entry.path))).digest('hex'), entry.sha256, entry.path);
for (const entry of manifest.integrationSources ?? []) assert.equal(createHash('sha256').update(readFileSync(resolve(entry.path))).digest('hex'), entry.sha256, entry.path);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.license, 'GPL-3.0-or-later');
assert.match(readFileSync('LICENSE-MIT', 'utf8'), /Copyright \(c\) 2026 ModelDock contributors/);
assert.match(readFileSync('LICENSE', 'utf8'), /GNU GENERAL PUBLIC LICENSE/);
const main = readFileSync('dist-electron/main.cjs', 'utf8');
assert.ok(main.includes('networkSnapshot')); assert.ok(!main.includes('verifyNetworkUi'));
const preload = readFileSync('dist-electron/network-mini-preload.cjs', 'utf8');
assert.ok(!preload.includes('copyProviderKey')); assert.ok(!preload.includes('saveProvider'));
console.log(JSON.stringify({ verified: true, sourceRevision: manifest.revision, files: manifest.files.length, miniCredentialAccess: false }));
