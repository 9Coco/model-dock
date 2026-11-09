"""Fetch a pinned official sing-box release, verifying its SHA-256 before use."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import platform
import tarfile
import urllib.request

ROOT=Path(__file__).resolve().parent.parent

def fetch_core(arch,proxy=None):
    manifest=json.loads((ROOT/'tools/tun-core.json').read_text())
    asset=manifest['assets'][arch]
    destination=ROOT/'vendor'/f'sing-box-{manifest["version"]}-{arch}'
    binary=destination/'sing-box'
    archive=destination/'release.tar.gz'
    destination.mkdir(parents=True,exist_ok=True)
    if archive.exists():data=archive.read_bytes()
    else:
        request=urllib.request.Request(asset['url'],headers={'User-Agent':'FlowBridge-build'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy,'http':proxy})) if proxy else urllib.request.build_opener()
        with opener.open(request,timeout=60) as response:data=response.read(80*1024*1024+1)
    if hashlib.sha256(data).hexdigest()!=asset['sha256']:
        raise RuntimeError('Official core archive checksum mismatch; nothing extracted')
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as bundle:
        entry=bundle.getmember(f'sing-box-{manifest["version"]}-linux-{arch}/sing-box')
        if not entry.isfile() or entry.size>160*1024*1024:raise RuntimeError('Unexpected core archive')
        binary.write_bytes(bundle.extractfile(entry).read())
    binary.chmod(0o755)
    archive.write_bytes(data)
    (destination/'verified.json').write_text(json.dumps({'version':manifest['version'],'arch':arch,'archive_sha256':asset['sha256'],'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest()},indent=2)+'\n')
    print(binary)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch',choices=['amd64','arm64'],default={'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine(),'amd64'))
    parser.add_argument('--proxy',help='Optional explicit HTTP proxy URL for the official download')
    args=parser.parse_args()
    fetch_core(args.arch,args.proxy)
