# SPDX-License-Identifier: GPL-3.0-or-later
"""Fetch the fixed official CPython embeddable runtime for Windows x64."""
import hashlib, io, json, urllib.request, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
manifest=json.loads((ROOT/'tools/python-runtime.json').read_text())
cache=ROOT/'vendor/python-embed.zip'; cache.parent.mkdir(parents=True,exist_ok=True)
if cache.exists(): data=cache.read_bytes()
else:
    with urllib.request.urlopen(manifest['url'],timeout=90) as response: data=response.read(32*1024*1024+1)
if hashlib.sha256(data).hexdigest()!=manifest['sha256']: raise RuntimeError('Official Python archive checksum mismatch')
cache.write_bytes(data)
destination=ROOT/'python';destination.mkdir(exist_ok=True)
with zipfile.ZipFile(io.BytesIO(data)) as bundle:
    for entry in bundle.infolist():
        if '/' in entry.filename or '\\' in entry.filename or entry.filename in ('.','..') or entry.file_size>32*1024*1024: raise RuntimeError('Unexpected Python archive')
        (destination/entry.filename).write_bytes(bundle.read(entry))
print(destination)
