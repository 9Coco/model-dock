# SPDX-License-Identifier: GPL-3.0-or-later
"""Fetch the fixed official CPython embeddable runtime for Windows x64."""
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

from fetch_windows_core import write_if_changed

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 32 * 1024 * 1024
manifest = json.loads((ROOT / 'tools/python-runtime.json').read_text(encoding='utf-8'))
cache = ROOT / 'vendor/python-embed.zip'
cache.parent.mkdir(parents=True, exist_ok=True)
if cache.exists():
    data = cache.read_bytes()
else:
    with urllib.request.urlopen(manifest['url'], timeout=90) as response:
        data = response.read(MAX_BYTES + 1)
if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != manifest['sha256']:
    raise RuntimeError('Official Python archive checksum mismatch')
write_if_changed(cache, data)
destination = ROOT / 'python'
destination.mkdir(exist_ok=True)
with zipfile.ZipFile(io.BytesIO(data)) as bundle:
    for entry in bundle.infolist():
        if '/' in entry.filename or '\\' in entry.filename or entry.filename in ('.', '..') or entry.file_size > MAX_BYTES:
            raise RuntimeError('Unexpected Python archive')
        write_if_changed(destination / entry.filename, bundle.read(entry))
print(destination)
