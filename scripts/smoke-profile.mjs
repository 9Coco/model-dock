import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { seedProviderDuplicates } from './provider-duplicate-fixture.mjs';

/** Never follow a link when creating a test-owned application/profile directory. */
export function safeTestDirectory(value, create = false) {
  if (typeof value !== 'string' || !value || value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('Test directory must not contain path traversal.');
  const absolute = resolve(value);
  for (let current = absolute; ; current = dirname(current)) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Test directory ancestors must be ordinary directories.');
    }
    if (dirname(current) === current) break;
  }
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export async function createSmokeProfile(output) {
  const outputDir = safeTestDirectory(output, true), parent = safeTestDirectory(join(outputDir, 'data'), true);
  const dataDir = join(parent, randomUUID());
  mkdirSync(dataDir, { mode: 0o700 });
  await seedProviderDuplicates(dataDir);
  safeTestDirectory(dataDir);
  const files = Object.fromEntries(['modeldock.sqlite', 'vault.key'].map(name => {
    const path = join(dataDir, name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Fresh fixture file must be an ordinary file.');
    return [name, { size: info.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }];
  }));
  const nonce = randomBytes(32).toString('hex');
  writeFileSync(join(dataDir, 'modeldock-smoke-profile.json'), JSON.stringify({ version: 1, fixture: 'modeldock-provider-duplicates-v1', nonce,
    runnerPid: process.pid, createdAt: new Date().toISOString(), outputDir, dataDir, files }, null, 2), { flag: 'wx', mode: 0o600 });
  return { outputDir, dataDir, nonce };
}
