# SPDX-License-Identifier: GPL-3.0-or-later
"""Stage system-owned FlowBridge files for the main ModelDock Debian package."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "resources/flowbridge"
DEFAULT_STAGING = ROOT / "work/network-debian"

LAUNCHER = """#!/usr/bin/python3 -IS
from pathlib import Path
import runpy
import stat

source = Path('/opt/modeldock-network/{module}')
for path in (source, *source.parents):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('Unsafe ModelDock network installation')
    if not (stat.S_ISREG(info.st_mode) if path == source else stat.S_ISDIR(info.st_mode)):
        raise SystemExit('Invalid ModelDock network installation')
runpy.run_path(str(source), run_name='__main__')
"""


def install_file(source, destination, *, mode=0o644):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(mode)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=("amd64", "arm64"),
                        default={"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine()))
    parser.add_argument("--payload", type=Path, help="New empty output directory for this build")
    args = parser.parse_args()
    if args.arch is None:
        parser.error("Specify a supported Debian architecture")
    arch = args.arch
    subprocess.run([sys.executable, SOURCE / "tools/fetch_tun_core.py", "--arch", arch], check=True)
    manifest = json.loads((SOURCE / "tools/tun-core.json").read_text())
    core = SOURCE / "vendor" / f"sing-box-{manifest['version']}-{arch}"
    record = json.loads((core / "verified.json").read_text())
    if (record["archive_sha256"] != manifest["assets"][arch]["sha256"]
            or record["binary_sha256"] != hashlib.sha256((core / "sing-box").read_bytes()).hexdigest()):
        raise RuntimeError("Network core checksum mismatch")

    if args.payload:
        payload = args.payload
    else:
        payload = DEFAULT_STAGING / "root"
        if payload.exists():
            shutil.rmtree(payload)
    payload.mkdir(parents=True, exist_ok=False)
    system_dir = payload / "opt/modeldock-network"
    for name in ("tun_helper.py", "tun_config.py", "tun_access.py", "tun_setup.py"):
        install_file(SOURCE / "linux" / name, system_dir / name)
    install_file(core / "sing-box", system_dir / "core/sing-box", mode=0o755)

    libexec = payload / "usr/libexec"
    libexec.mkdir(parents=True)
    for executable, module in (("tun-helper", "tun_helper.py"), ("accessd", "tun_access.py"),
                               ("setup", "tun_setup.py")):
        launcher = libexec / f"modeldock-network-{executable}"
        launcher.write_text(LAUNCHER.format(module=module))
        launcher.chmod(0o755)

    for suffix in ("socket", "service"):
        name = f"modeldock-network-access@.{suffix}"
        install_file(SOURCE / "linux" / name, (payload / "usr/lib/systemd/system") / name)
    for name in ("tun", "setup"):
        install_file(SOURCE / "linux" / f"modeldock-network-{name}.policy",
                     payload / f"usr/share/polkit-1/actions/local.modeldock.network.{name}.policy")
    for license_file in (SOURCE / "LICENSE", SOURCE / "linux/NOTICE-sing-box.md",
                         SOURCE / "linux/THIRD-PARTY-LICENSE-sing-box.txt"):
        install_file(license_file, (payload / "usr/share/doc/modeldock-network") / license_file.name)

    # FPM assigns root:root. Explicit modes keep privileged paths independent
    # of the builder's umask, including shared directories such as /usr.
    payload.chmod(0o755)
    for path in payload.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)
    print(f"Staged {arch} network components for the ModelDock Debian package.")


if __name__ == "__main__":
    main()
