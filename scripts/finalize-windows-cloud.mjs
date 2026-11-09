// SPDX-License-Identifier: GPL-3.0-or-later
// Cloud cross-build resource editing without Wine. Not native Windows acceptance.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NtExecutable, NtExecutableResource, Resource, Data } from 'resedit';
if (process.platform !== 'linux') throw new Error('Use npm run pack:win on native Windows.');
const root = resolve('.'), directory = join(root, 'release/win-unpacked');
const executable = join(directory, 'ModelDock.exe');
const application = NtExecutable.from(readFileSync(executable));
const resources = NtExecutableResource.from(application);
const icon = Data.IconFile.from(readFileSync(join(root, 'assets/modeldock.ico')));
const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
if (!groups.length) throw new Error('Official Electron icon group missing.');
Resource.IconGroupEntry.replaceIconsForResource(resources.entries, groups[0].id, groups[0].lang, icon.icons.map(item => item.data));
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
for (const info of Resource.VersionInfo.fromEntries(resources.entries)) {
  info.setFileVersion(version); info.setProductVersion(version);
  info.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName:'ModelDock', FileDescription:'ModelDock', CompanyName:'ModelDock contributors', OriginalFilename:'ModelDock.exe', InternalName:'ModelDock', LegalCopyright:'Copyright © 2026 ModelDock contributors; see bundled licenses' });
  info.outputToResourceEntries(resources.entries);
}
resources.outputResource(application); writeFileSync(executable, Buffer.from(application.generate()));
execFileSync(process.execPath, ['scripts/verify-windows-package.mjs', directory], {stdio:'inherit'});
