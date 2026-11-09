// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
execFileSync(process.platform === 'win32' ? 'python' : 'python3', process.argv.slice(2), {
  stdio: 'inherit', windowsHide: true,
});
