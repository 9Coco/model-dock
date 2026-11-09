# SPDX-License-Identifier: GPL-3.0-or-later
"""Check a packaged ModelDock .deb without installing it or running its code."""
import argparse
import hashlib
import json
import re
import subprocess
import tarfile
from email.parser import Parser
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
FLOW = ROOT / "resources/flowbridge"
NETWORK = "modeldock-network"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(stream, prefix=b""):
    value = hashlib.sha256(prefix)
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def visit_archive(package, option, visit):
    # Stream large application/core binaries; never extract the package as root.
    with subprocess.Popen(["dpkg-deb", option, package], stdout=subprocess.PIPE) as unpack:
        try:
            with tarfile.open(fileobj=unpack.stdout, mode="r|") as archive:
                for member in archive:
                    visit(archive, member, member.name.removeprefix("./").rstrip("/"))
        finally:
            unpack.stdout.close()
        require(unpack.wait() == 0, f"Failed to read {option} for {package}")


def verify_control(package):
    fields = Parser().parsestr(subprocess.check_output(["dpkg-deb", "-f", package], text=True))
    version = json.loads((ROOT / "package.json").read_text())["version"]
    require(fields["Package"] == "model-dock" and fields["Version"] == version,
            f"Expected model-dock {version}, got {fields['Package']} {fields['Version']}")
    depends = fields.get("Depends", "") + ", " + fields.get("Pre-Depends", "")
    require(not re.search(r"\bmodeldock-network\b", depends), "Unexpected separate helper dependency")
    for name in ("python3", "iproute2", "polkitd", "pkexec", "systemd"):
        require(re.search(rf"(?:^|,\s*){name}(?=[ ,(]|$)", depends), f"Missing dependency: {name}")

    # These two fields let dpkg retire the split 0.4.0 package and take ownership of its files.
    for field in ("Conflicts", "Replaces"):
        require(re.search(r"(?:^|,\s*)modeldock-network\s*\(<=\s*0\.4\.0\)(?=\s*(,|$))",
                          fields.get(field, "")), f"{field} must cover the old 0.4.0 helper")

    required = {"postinst": ("daemon-reload", "update-alternatives"),
                "prerm": ("modeldock-network-access", ".enabled"),
                "postrm": ("daemon-reload",)}
    seen = set()

    def inspect(archive, member, name):
        if name not in required:
            return
        require(member.isfile() and member.uid == member.gid == 0 and member.mode == 0o755,
                f"Invalid maintainer script ownership, mode or type: {name}")
        script = archive.extractfile(member).read()
        shell = script.splitlines()[0]
        require(shell in (b"#!/bin/sh", b"#!/bin/bash"), f"Invalid maintainer script: {name}")
        subprocess.run([shell[2:].decode(), "-n"], input=script, check=True)
        for token in required[name]:
            require(token.encode() in script, f"Missing {token} in {name}")
        seen.add(name)

    visit_archive(package, "--ctrl-tarfile", inspect)
    require(seen == set(required), f"Missing maintainer scripts: {set(required) - seen}")
    return fields["Architecture"]


def expected_files(arch):
    linux = FLOW / "linux"
    expected = {}
    for module in ("tun_helper", "tun_config", "tun_access", "tun_setup"):
        expected[f"opt/{NETWORK}/{module}.py"] = linux / f"{module}.py"
    for kind in ("service", "socket"):
        unit = f"{NETWORK}-access@.{kind}"
        expected[f"usr/lib/systemd/system/{unit}"] = linux / unit
    for name in ("tun", "setup"):
        expected[f"usr/share/polkit-1/actions/local.modeldock.network.{name}.policy"] = (
            linux / f"{NETWORK}-{name}.policy")
    for path in (FLOW / "LICENSE", linux / "NOTICE-sing-box.md", linux / "THIRD-PARTY-LICENSE-sing-box.txt"):
        expected[f"usr/share/doc/{NETWORK}/{path.name}"] = path
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in expected.items()}

    manifest = json.loads((FLOW / "tools/tun-core.json").read_text())
    version = manifest["version"]
    require(arch in manifest["assets"], f"Unsupported Debian architecture: {arch}")
    vendor = FLOW / "vendor" / f"sing-box-{version}-{arch}"
    upstream = vendor / "release.tar.gz"
    with upstream.open("rb") as stream:
        require(digest(stream) == manifest["assets"][arch]["sha256"], "Unverified upstream core archive")
    with tarfile.open(upstream) as release:
        core = release.extractfile(f"sing-box-{version}-linux-{arch}/sing-box")
        hashes[f"opt/{NETWORK}/core/sing-box"] = digest(core)
    return hashes


def verify_payload(package, arch):
    hashes = expected_files(arch)
    wrappers = {f"usr/libexec/{NETWORK}-{name}": f"/opt/{NETWORK}/{module}.py" for name, module in
                (("tun-helper", "tun_helper"), ("accessd", "tun_access"), ("setup", "tun_setup"))}
    files = set(hashes) | set(wrappers)
    directories = {str(parent) for name in files for parent in PurePosixPath(name).parents if str(parent) != "."}
    seen = set()

    def inspect(archive, member, name):
        if name not in directories and name not in files:
            return
        require(name not in seen, f"Duplicate archive member: {name}")
        seen.add(name)
        require(member.uid == member.gid == 0, f"Non-root owner/group: {name}")
        if name in directories:
            require(member.isdir() and member.mode == 0o755, f"Unsafe installation directory: {name}")
            return
        executable = name in wrappers or name.endswith("/core/sing-box")
        require(member.isfile() and member.mode == (0o755 if executable else 0o644),
                f"Invalid installed file type or mode: {name}")
        stream = archive.extractfile(member)
        if name in hashes:
            header = b""
            if name.endswith("/core/sing-box"):
                header = stream.read(20)
                machine = int.from_bytes(header[18:20], "little")
                require(header.startswith(b"\x7fELF\x02\x01") and machine == {"amd64": 62, "arm64": 183}[arch],
                        f"ELF core does not match package architecture {arch}")
            require(digest(stream, header) == hashes[name], f"Payload differs from its verified source: {name}")
        else:
            code = stream.read()
            require(code.startswith(b"#!/usr/bin/python3 -IS\n") and wrappers[name].encode() in code,
                    f"Invalid privileged entry point: {name}")
            compile(code, name, "exec")

    visit_archive(package, "--fsys-tarfile", inspect)
    missing = (files | directories) - seen
    require(not missing, f"Missing payload entries: {', '.join(sorted(missing))}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="ModelDock Debian package to verify")
    package = parser.parse_args().package
    try:
        verify_payload(package, verify_control(package))
    except (ValueError, OSError, SyntaxError, subprocess.CalledProcessError, tarfile.TarError) as error:
        parser.exit(1, f"{package}: {error}\n")
    print(f"Verified single-package network payload and upgrade metadata: {package}")


if __name__ == "__main__":
    main()
