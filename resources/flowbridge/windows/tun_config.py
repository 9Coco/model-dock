"""Pure sing-box 1.14.4 Windows TUN configuration, with no system changes.

The controller owns privilege checks, local listener identity and process
lifetime. A local upstream requires its verified executable path so its own
remote connections cannot loop back through the proxy it serves.

Pinned implementation references:
https://github.com/SagerNet/sing-box/blob/v1.14.4/common/dialer/default.go
https://github.com/SagerNet/sing-box/blob/v1.14.4/docs/configuration/inbound/tun.md
https://github.com/SagerNet/sing-tun/blob/040db71fcd33/tun_windows.go
"""

from __future__ import annotations

import ipaddress
from pathlib import PureWindowsPath
import re

from windows.proxy import validate_endpoint


CORE_VERSION = "1.14.4"
INTERFACE_NAME = "modeldock-net"
TUN_INTERFACE = INTERFACE_NAME
TUN_ADDRESSES = ("172.31.255.1/30", "fd42:73fb:4827::1/126")
TUN_DNS_ADDRESSES = ("172.31.255.2", "fd42:73fb:4827::2")
ROUTE_ADDRESSES = ("0.0.0.0/1", "128.0.0.0/1", "::/1", "8000::/1")
LOOPBACK_EXCLUDES = ("127.0.0.0/8", "::1/128")
OUTBOUND_TAG = "upstream-proxy"
BYPASS_TAG = "upstream-process"
DNS_TAG = "proxy-doh"
DNS_MODE_COMPATIBLE = "compatible"
DNS_MODE_FAST = "fast"
DNS_MODES = (DNS_MODE_FAST, DNS_MODE_COMPATIBLE)
FAKEIP_TAG = "proxy-fakeip"
FAKEIP_RANGE = "198.18.0.0/15"
FAKEIP_CACHE_ID = "flowbridge-fast-v1"
DOH_ADDRESS = "1.1.1.1"
DOH_SERVER_NAME = "cloudflare-dns.com"
_SECRET = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")


def _port(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError(f"{label}必须是 1–65535 的整数")
    return value


def _process_path(value):
    if (not isinstance(value, str) or not value or len(value) > 32767
            or any(ord(c) < 32 or ord(c) == 127 or c in '*?"' for c in value)):
        raise ValueError("本机代理程序路径无效")
    path = PureWindowsPath(value)
    if not path.is_absolute() or not re.fullmatch(r"[A-Za-z]:", path.drive) or path.suffix.lower() != ".exe" or ".." in path.parts:
        raise ValueError("本机代理必须提供已验证的完整本地 EXE 路径")
    return str(path)


def _cache_path(value):
    if (not isinstance(value, str) or not value or len(value) > 32767
            or any(ord(c) < 32 or ord(c) == 127 or c in '*?"' for c in value)):
        raise ValueError("DNS 缓存文件路径无效")
    path = PureWindowsPath(value)
    if (not path.is_absolute() or not re.fullmatch(r"[A-Za-z]:", path.drive)
            or ".." in path.parts or len(path.parts) < 2 or value.endswith(("\\", "/"))):
        raise ValueError("DNS 缓存必须使用完整本地文件路径")
    return str(path)


def build_config(endpoint, api_port: int, api_secret: str, *, proxy_port: int,
                 bypass_process_path: str | None = None,
                 dns_mode: str = DNS_MODE_COMPATIBLE,
                 cache_path: str | None = None) -> dict:
    """Build either the existing DoH path or upstream hostname resolution.

    The controller supplies a persistent cache file for fast mode. Keeping that
    file and the fake-IP transport in compatible mode also accepts addresses
    applications cached before a mode switch; only new address answers change.
    SOCKS5 resolves these hostnames upstream, so its resolver, selected IP
    family and CDN choice follow the upstream proxy's policy. The IPv4-only
    setting below controls local DNS replies, not the upstream's connection.
    Fast mode removes a local DNS round trip; it cannot guarantee faster sites.
    """
    if dns_mode not in DNS_MODES:
        raise ValueError("DNS 模式必须为 fast 或 compatible")
    cache = _cache_path(cache_path) if cache_path is not None else None
    if dns_mode == DNS_MODE_FAST and cache is None:
        raise ValueError("快速解析需要持久 DNS 缓存文件路径")
    host, port = validate_endpoint(endpoint)
    address = ipaddress.ip_address(host)
    api_port = _port(api_port, "API 端口")
    proxy_port = _port(proxy_port, "本地测试代理端口")
    if api_port == proxy_port:
        raise ValueError("本地测试代理端口不能与 API 端口相同")
    if not isinstance(api_secret, str) or not _SECRET.fullmatch(api_secret):
        raise ValueError("API 密钥须为 32–128 位安全字符")
    if address.is_loopback and bypass_process_path is None:
        raise ValueError("本机代理需要先识别监听端口所属程序，避免全局流量循环")
    bypass = _process_path(bypass_process_path) if bypass_process_path is not None else None
    upstream = {
        "type": "socks", "tag": OUTBOUND_TAG, "version": "5",
        "server": host, "server_port": port,
        "udp_over_tcp": False, "connect_timeout": "8s",
    }
    if address.is_loopback:
        # Explicit local binding disables auto-detect only for this outbound.
        # Its UDP relay must remain on the same loopback IP (preflight checks it).
        upstream["inet4_bind_address" if address.version == 4 else "inet6_bind_address"] = host
    outbounds = [upstream]
    rules = []
    if bypass is not None:
        # Exact executable identity, never a global private-address exemption.
        # sing-box's plain process_path map is case sensitive, while Windows
        # executable paths are not. Anchor and escape the complete verified
        # path so a casing difference cannot break loop prevention.
        rules.append({"inbound": ["tun-in"], "process_path_regex": ["(?i)^" + re.escape(bypass) + "$"],
                      "network": ["tcp", "udp"], "action": "route", "outbound": BYPASS_TAG})
        outbounds.append({"type": "direct", "tag": BYPASS_TAG, "connect_timeout": "8s"})
    rules.extend([
        {"port": 53, "action": "hijack-dns"},
        {"network": ["tcp", "udp"], "action": "route", "outbound": OUTBOUND_TAG},
        {"action": "reject"},
    ])
    config = {
        "log": {"disabled": True},
        "dns": {
            "servers": [{"type": "https", "tag": DNS_TAG,
                         "server": DOH_ADDRESS, "server_port": 443, "path": "/dns-query",
                         "tls": {"enabled": True, "server_name": DOH_SERVER_NAME},
                         "detour": OUTBOUND_TAG}],
            "final": DNS_TAG, "strategy": "ipv4_only", "timeout": "8s",
        },
        "inbounds": [{
            "type": "tun", "tag": "tun-in", "interface_name": INTERFACE_NAME,
            "address": list(TUN_ADDRESSES), "mtu": 1500, "stack": "system",
            "auto_route": True, "strict_route": True, "dns_mode": "hijack",
            "dns_address": list(TUN_DNS_ADDRESSES),
            "route_address": list(ROUTE_ADDRESSES),
            "route_exclude_address": list(LOOPBACK_EXCLUDES),
        }, {
            "type": "http", "tag": "tests-in", "listen": "127.0.0.1", "listen_port": proxy_port,
        }],
        "outbounds": outbounds,
        "route": {"auto_detect_interface": True, "rules": rules, "final": OUTBOUND_TAG},
        "experimental": {"clash_api": {
            "external_controller": f"127.0.0.1:{api_port}", "secret": api_secret,
            "access_control_allow_origin": [], "access_control_allow_private_network": False,
        }},
    }
    if cache is not None:
        # A single namespace survives switching upstreams: mappings contain
        # domain names, not resolver answers or the selected proxy's exit IP.
        config["experimental"]["cache_file"] = {
            "enabled": True, "path": cache,
            "cache_id": FAKEIP_CACHE_ID, "store_fakeip": True,
        }
        config["dns"]["servers"].append({
            "type": "fakeip", "tag": FAKEIP_TAG, "inet4_range": FAKEIP_RANGE,
        })
        # Multiple DNS servers require an explicit resolver in sing-box 1.14.
        # SOCKS5 still passes destination hostnames unchanged to its server.
        config["route"]["default_domain_resolver"] = {"server": DNS_TAG, "strategy": "ipv4_only"}
    if dns_mode == DNS_MODE_FAST:
        # Do not synthesize DNSSEC answers or common STUN/TURN addresses, which
        # applications may inspect as data. Their real DNS still uses SOCKS.
        # All other record types also keep the original encrypted DoH fallback.
        config["dns"]["rules"] = [
            {"query_dnssec": True, "action": "route", "server": DNS_TAG},
            {"domain_regex": [r"(^|\.)(stun|turn)[0-9]*\."],
             "action": "route", "server": DNS_TAG},
            {"query_type": ["A", "AAAA"], "action": "route", "server": FAKEIP_TAG},
        ]
    return config
