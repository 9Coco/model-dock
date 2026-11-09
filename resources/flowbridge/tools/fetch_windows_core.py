"""Fetch pinned official Windows sing-box and signed Wintun distributions."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_MEMBER = 180 * 1024 * 1024


def write_if_changed(destination, data):
    """Leave running verified executables alone; replace changed files atomically."""
    if destination.is_file() and destination.read_bytes() == data:
        return
    descriptor, temporary = tempfile.mkstemp(prefix=destination.name + '.', suffix='.tmp', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def checked_archive(asset, cache, proxy=None):
    """Verify the complete archive before exposing any member to the caller."""
    if cache.is_file():
        data = cache.read_bytes()
    else:
        request = urllib.request.Request(asset['url'], headers={'User-Agent': 'FlowBridge-build'})
        handlers = [urllib.request.ProxyHandler({'http': proxy, 'https': proxy})] if proxy else []
        with urllib.request.build_opener(*handlers).open(request, timeout=90) as response:
            data = response.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise RuntimeError(f'Official archive checksum mismatch: {cache.name}; nothing extracted')
    cache.parent.mkdir(parents=True, exist_ok=True)
    write_if_changed(cache, data)
    return zipfile.ZipFile(io.BytesIO(data))


def member_bytes(bundle, name):
    # Only explicitly named members are read; never extract archive paths.
    entry = bundle.getinfo(name)
    if entry.is_dir() or not 0 < entry.file_size <= MAX_MEMBER:
        raise RuntimeError(f'Unexpected archive entry: {name}')
    return bundle.read(entry)


def fetch_core(arch='amd64', proxy=None):
    manifest = json.loads((ROOT / 'tools/windows-core.json').read_text(encoding='utf-8'))
    asset = manifest['assets'][arch]
    destination = ROOT / 'vendor' / f'sing-box-{manifest["version"]}-windows-{arch}'
    destination.mkdir(parents=True, exist_ok=True)
    with checked_archive(asset, destination / 'release.zip', proxy) as bundle:
        core_data = member_bytes(bundle, f'sing-box-{manifest["version"]}-windows-{arch}/sing-box.exe')
    with checked_archive(manifest['wintun'], ROOT / 'vendor' / f'wintun-{manifest["wintun"]["version"]}.zip', proxy) as bundle:
        driver_data = member_bytes(bundle, f'wintun/bin/{arch}/wintun.dll')
        driver_license = member_bytes(bundle, 'wintun/LICENSE.txt')
    write_if_changed(destination / 'sing-box.exe', core_data)
    write_if_changed(destination / 'wintun.dll', driver_data)
    write_if_changed(destination / 'LICENSE-wintun.txt', driver_license)
    verification = {
        'version': manifest['version'], 'arch': arch,
        'archive_sha256': asset['sha256'],
        'binary_sha256': hashlib.sha256(core_data).hexdigest(),
        'wintun_version': manifest['wintun']['version'],
        'wintun_archive_sha256': manifest['wintun']['sha256'],
        'wintun_sha256': hashlib.sha256(driver_data).hexdigest(),
        'wintun_license_sha256': hashlib.sha256(driver_license).hexdigest(),
    }
    write_if_changed(destination / 'verified.json', (json.dumps(verification, indent=2) + '\n').encode('utf-8'))
    print(destination)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch', choices=['amd64', 'arm64'], default={'ARM64': 'arm64', 'aarch64': 'arm64'}.get(platform.machine(), 'amd64'))
    parser.add_argument('--proxy', help='Optional explicit HTTP proxy URL for official downloads')
    args = parser.parse_args()
    fetch_core(args.arch, args.proxy)
