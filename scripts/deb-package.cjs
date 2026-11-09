// SPDX-License-Identifier: GPL-3.0-or-later
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { toLinuxArchString } = require('builder-util');

module.exports = ({ projectDir }) => {
  const scratch = mkdtempSync(join(tmpdir(), 'modeldock-deb-'));
  process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
  const payload = join(scratch, 'root');
  const scripts = join(projectDir, 'scripts');
  const templates = join(projectDir, 'node_modules/app-builder-lib/templates/linux');

  // FPM reads these templates as it initializes the target, before packing.
  // Keep electron-builder's own sandbox, AppArmor and desktop setup intact.
  function extendTemplate(name, actions) {
    const original = readFileSync(join(templates, name), 'utf8');
    const endOfShebang = original.indexOf('\n') + 1;
    // dpkg runs postinst after the old helper's prerm in offline migrations.
    // Run the reconciliation in its own shell to keep its exit and set -eu local.
    const reconcile = name === 'after-install.tpl'
      ? `\n/bin/sh -s -- "$1" <<'MODELDOCK_NETWORK_MAINTENANCE' || exit $?\n${readFileSync(join(scripts, 'deb-network-prerm.sh'), 'utf8')}MODELDOCK_NETWORK_MAINTENANCE\n`
      : '';
    const reload = `\ncase "$1" in
    ${actions})
        if [ -d /run/systemd/system ]; then
            /usr/bin/systemctl daemon-reload || exit $?
        fi
        ;;
esac
`;
    const path = join(scratch, name);
    writeFileSync(path, original.slice(0, endOfShebang) + reconcile + reload + original.slice(endOfShebang));
    return path;
  }

  let preparedArch;
  return {
    deb: {
      afterInstall: extendTemplate('after-install.tpl', 'configure'),
      afterRemove: extendTemplate('after-remove.tpl', 'remove|purge'),
      fpm: [
        '--conflicts', 'modeldock-network (<= 0.4.0)',
        '--replaces', 'modeldock-network (<= 0.4.0)',
        '--before-remove', join(scripts, 'deb-network-prerm.sh'),
        `${payload}/=/`,
      ],
    },
    artifactBuildStarted({ targetPresentableName, arch }) {
      if (targetPresentableName !== 'deb') return;
      const debArch = toLinuxArchString(arch, 'deb');
      if (preparedArch === debArch) return;
      if (preparedArch) throw new Error('Build each ModelDock Debian architecture in a separate electron-builder invocation.');
      execFileSync('python3', [join(scripts, 'build-network-helper.py'), '--arch', debArch, '--payload', payload], { stdio: 'inherit' });
      preparedArch = debArch;
    },
    artifactBuildCompleted({ target, file }) {
      if (target?.name === 'deb') {
        execFileSync('python3', [join(scripts, 'verify-linux-deb.py'), resolve(file)], { stdio: 'inherit' });
      }
    },
  };
};
