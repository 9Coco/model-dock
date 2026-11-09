// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const root = resolve('resources/flowbridge');
const platform = process.argv[2] || process.platform;
const python = process.platform === 'win32' ? 'python' : 'python3';
if (!['linux', 'win32'].includes(platform)) throw new Error('Supported network targets: linux, win32');
execFileSync(python, [join(root, 'tools', platform === 'win32' ? 'fetch_windows_core.py' : 'fetch_tun_core.py')], { stdio: 'inherit' });
if (platform === 'win32') {
  // CPython official embeddable runtime; no PyQt or second GUI/runtime server.
  execFileSync(python, [join(root, 'tools/fetch_python.py')], { stdio: 'inherit' });
}
console.log(`Network resources prepared: ${platform}`);
