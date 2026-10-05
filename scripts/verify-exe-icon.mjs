import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';

// Verify real PE resources, beyond an Electron BrowserWindow's custom image.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/verify-exe-icon.mjs <ModelDock.exe>');
const resources = NtExecutableResource.from(NtExecutable.from(readFileSync(filename))).entries;
const expected = Data.IconFile.from(readFileSync(resolve(root, 'assets/modeldock.ico')));
const digest = value => createHash('sha256').update(Buffer.from(value)).digest('hex');
const binary = icon => typeof icon.generate === 'function' ? icon.generate() : icon.bin;
const wanted = expected.icons.map(icon => ({ width: icon.width || icon.data.width, height: icon.height || icon.data.height, hash: digest(binary(icon.data)) }));
const groups = Resource.IconGroupEntry.fromEntries(resources);
const matches = groups.filter(group => {
  const items = group.getIconItemsFromEntries(resources);
  return items.length === wanted.length && wanted.every(expectedIcon => items.some(item => (item.width || 256) === expectedIcon.width && (item.height || 256) === expectedIcon.height && digest(binary(item)) === expectedIcon.hash));
});
if (!matches.length || !matches.includes(groups[0])) throw new Error(`Executable primary icon mismatch: expected ModelDock ICO in ${filename}.`);
console.log(JSON.stringify({ executable: resolve(filename), iconVerified: true, primaryGroupId: groups[0].id, groupIds: matches.map(group => group.id), sizes: wanted.map(icon => icon.width), iconResources: resources.filter(entry => entry.type === 3).length }, null, 2));
