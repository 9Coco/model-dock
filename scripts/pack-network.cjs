// SPDX-License-Identifier: GPL-3.0-or-later
const { cpSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
module.exports = async context => {
  const root = join(context.packager.projectDir, 'resources/flowbridge');
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== 1) throw new Error('ModelDock network Windows bundle currently requires x64.');
  const source = join(root, 'vendor/sing-box-1.14.4-windows-amd64');
  const record = JSON.parse(readFileSync(join(source, 'verified.json'), 'utf8'));
  for (const [file, key] of [['sing-box.exe','binary_sha256'], ['wintun.dll','wintun_sha256'], ['LICENSE-wintun.txt','wintun_license_sha256']]) {
    if (createHash('sha256').update(readFileSync(join(source, file))).digest('hex') !== record[key]) throw new Error(`Network component checksum mismatch: ${file}`);
  }
  if (!existsSync(join(root, 'python/python.exe'))) throw new Error('Run npm run network:prepare -- win32 before Windows packaging.');
  const output = join(context.appOutDir, 'resources/flowbridge');
  const core = join(output, 'vendor/sing-box-1.14.4-windows-amd64'); mkdirSync(core, {recursive:true});
  for (const name of ['sing-box.exe','wintun.dll','LICENSE-wintun.txt','verified.json']) cpSync(join(source,name),join(core,name));
  cpSync(join(root,'python'),join(output,'python'),{recursive:true});
};
