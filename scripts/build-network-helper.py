# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the root-owned Linux network helper package; never installs it."""
from pathlib import Path
import hashlib
import json
import platform
import shutil
import subprocess
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'resources/flowbridge'
version = json.loads((ROOT/'package.json').read_text())['version']
arch = {'x86_64':'amd64','aarch64':'arm64'}[platform.machine()]
core = SOURCE/'vendor'/f'sing-box-1.14.4-{arch}'
verification = json.loads((core/'verified.json').read_text())
if hashlib.sha256((core/'sing-box').read_bytes()).hexdigest()!=verification['binary_sha256']: raise RuntimeError('Network core checksum mismatch')
staging = ROOT/'work/network-debian'
if staging.exists(): shutil.rmtree(staging)
appdir = staging/'opt/modeldock-network'; appdir.mkdir(parents=True)
for name in ['tun_helper.py','tun_config.py','tun_access.py','tun_setup.py']:
    shutil.copyfile(SOURCE/'linux'/name, appdir/name)
(appdir/'core').mkdir(); shutil.copyfile(core/'sing-box',appdir/'core/sing-box')
helperdir=staging/'usr/libexec'; helperdir.mkdir(parents=True)
for executable,module in [('modeldock-network-tun-helper','tun_helper.py'),('modeldock-network-accessd','tun_access.py'),('modeldock-network-setup','tun_setup.py')]:
    (helperdir/executable).write_text('''#!/usr/bin/python3 -IS
from pathlib import Path
import runpy, stat
source=Path('/opt/modeldock-network/'''+module+''"""')
for path in (source,*source.parents):
    info=path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:
        raise SystemExit('Unsafe ModelDock network installation')
    if not (stat.S_ISREG(info.st_mode) if path==source else stat.S_ISDIR(info.st_mode)):
        raise SystemExit('Invalid ModelDock network installation')
runpy.run_path(str(source),run_name='__main__')
""")
units=staging/'usr/lib/systemd/system';units.mkdir(parents=True)
for name in ['modeldock-network-access@.socket','modeldock-network-access@.service']: shutil.copyfile(SOURCE/'linux'/name,units/name)
policies=staging/'usr/share/polkit-1/actions';policies.mkdir(parents=True)
for name in ['tun','setup']: shutil.copyfile(SOURCE/'linux'/f'modeldock-network-{name}.policy',policies/f'local.modeldock.network.{name}.policy')
docs=staging/'usr/share/doc/modeldock-network';docs.mkdir(parents=True)
for path in [SOURCE/'LICENSE',SOURCE/'linux/NOTICE-sing-box.md',SOURCE/'linux/THIRD-PARTY-LICENSE-sing-box.txt']:
    shutil.copyfile(path,docs/path.name)
control=staging/'DEBIAN';control.mkdir()
(control/'control').write_text(f'''Package: modeldock-network
Version: {version}
Section: net
Priority: optional
Architecture: {arch}
Maintainer: ModelDock contributors <116045250+9Coco@users.noreply.github.com>
Depends: python3 (>= 3.10), iproute2, polkitd, pkexec, systemd
Description: ModelDock restricted FlowBridge network helper
 Root-owned fixed-protocol TCP/UDP/DNS takeover with per-user authorization.
''')
(control/'postinst').write_text('''#!/bin/sh
set -eu
if [ "$1" = configure ] && [ -d /run/systemd/system ]; then /usr/bin/systemctl daemon-reload; fi
''')
(control/'prerm').write_text('''#!/bin/sh
set -eu
if [ "$1" = remove ] || [ "$1" = deconfigure ]; then
 for marker in /var/lib/modeldock-network-access/*.enabled; do
  [ -f "$marker" ] || continue
  uid=${marker##*/}; uid=${uid%.enabled}
  case "$uid" in ''|*[!0-9]*) continue ;; esac
  if [ -d /run/systemd/system ]; then
   /usr/bin/systemctl disable --now "modeldock-network-access@$uid.socket"
   /usr/bin/systemctl stop "modeldock-network-access@$uid.service"
  fi
  rm -f -- "$marker"
 done
fi
''')
staging.chmod(0o755)
for path in staging.rglob('*'):
    path.chmod(0o755 if path.is_dir() or path.parent==helperdir or path.name in ['sing-box','postinst','prerm'] else 0o644)
release=ROOT/'release';release.mkdir(exist_ok=True)
output=release/f'modeldock-network_{version}_{arch}.deb'
subprocess.run(['dpkg-deb','--root-owner-group','--build',str(staging),str(output)],check=True)
print(output)
