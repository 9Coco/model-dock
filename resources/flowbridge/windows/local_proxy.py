# SPDX-License-Identifier: GPL-3.0-or-later
"""Discover local proxy listeners on demand without changing Windows settings."""
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import os
from pathlib import Path
import socket
from urllib.parse import urlsplit

from linux.connectivity import probe_http_proxy
from linux.relay import Endpoint
from windows import native


def _loopback(host):
    if host == 'localhost':
        return '127.0.0.1'
    address = ipaddress.ip_address(host)
    return str(address) if address.is_loopback else None


def configured_endpoints(settings):
    values = []
    if settings['flags'] & 2:
        for field in settings['server'].split(';'):
            value = field.strip().split('=', 1)[-1].strip()
            values.append(value if '://' in value else '//' + value)
    if settings['flags'] & 4:
        values.append(settings['autoconfig'])
    endpoints = set()
    for value in values:
        try:
            url = urlsplit(value)
            host = _loopback(url.hostname)
            if host and url.port and url.username is None and url.password is None:
                endpoints.add((host, url.port))
        except ValueError:
            continue
    return endpoints


def _candidates(settings, gateway_port):
    configured = configured_endpoints(settings)
    listeners = []
    for family, wildcard, loopback in [(socket.AF_INET, '0.0.0.0', '127.0.0.1'), (socket.AF_INET6, '::', '::1')]:
        for row in native._tcp_listeners(family):
            pid, port, bound = row['pid'], row['port'], row['address']
            host = loopback if bound == wildcard else _loopback(bound.split('%')[0])
            if not host or port == gateway_port or pid in (0, os.getpid(), os.getppid()):
                continue
            listeners.append((host, port, pid, family))
    # A local PAC server can publish a proxy on a second port of the same process.
    configured_owners = {pid for host, port, pid, _ in listeners if (host, port) in configured}
    owners = {}
    candidates = []
    vendor = Path(__file__).resolve().parents[1] / 'vendor'
    for host, port, pid, family in listeners:
        if pid not in owners:
            try:
                owners[pid] = Path(native._process_image_path(pid))
            except (OSError, ValueError):
                owners[pid] = None
        path = owners[pid]
        if not path or path.is_relative_to(vendor):
            continue
        name = path.stem.lower()
        if name in ('modeldock', 'flowbridge', 'flowbridge-windows'):
            continue
        known = name in ('xray', 'v2ray', 'v2rayn', 'sing-box', 'mihomo', 'clash', 'shadowsocks', 'ss-local') or name.startswith(('windmillvpn', 'clash-', 'mihomo-'))
        if pid in configured_owners or known:
            candidates.append(((host, port) not in configured, family == socket.AF_INET6, port, host, pid))
    return sorted(set(candidates))[:12]


def _supports_proxy(endpoint, scheme):
    try:
        if scheme == 'http':
            probe_http_proxy(endpoint, timeout=3)
        else:
            with socket.create_connection((endpoint.host, endpoint.port), timeout=1) as sock:
                sock.sendall(b'\x05\x01\x00')
                with sock.makefile('rb') as stream:
                    return stream.read(2) == b'\x05\x00'
        return True
    except (OSError, ValueError):
        return False


def discover_local_proxies(settings, gateway_port):
    probes = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for _, _, port, host, pid in _candidates(settings, gateway_port):
            for scheme in ('http', 'socks5'):
                check = pool.submit(_supports_proxy, Endpoint(host, port), scheme)
                authority = f'[{host}]' if ':' in host else host
                probes.append(((pid, port, scheme), f'{scheme}://{authority}:{port}', check))
    # A dual-stack listener for the same process needs only one working address.
    found = {}
    for identity, url, check in probes:
        if check.result():
            found.setdefault(identity, url)
    return list(found.values())
