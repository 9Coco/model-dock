"""Pure sing-box 1.14.4 configuration for FlowBridge's Linux TUN mode.

No command, DNS lookup, route change or secret generation happens here. The
privileged helper owns those actions and must reserve/check the whole routing
rule range before starting the pinned core. sing-tun 040db71fcd33 removes every
rule in [iproute2_rule_index, index+10], including goto/nop/main-table rules.

Pinned official sources:
https://github.com/SagerNet/sing-box/tree/v1.14.4/option
https://raw.githubusercontent.com/SagerNet/sing-tun/040db71fcd33/tun_linux.go
https://sing-box.sagernet.org/configuration/inbound/tun/
https://sing-box.sagernet.org/configuration/dns/server/https/
https://sing-box.sagernet.org/configuration/shared/dial/
https://sing-box.sagernet.org/configuration/outbound/socks/
https://raw.githubusercontent.com/SagerNet/sing-box/v1.14.4/option/simple.go

Only SOCKS5 control/TCP and standard UDP relay sockets leave via the selected
physical interface. TCP and UDP both use the phone proxy; DNS is intercepted
first and sent as verified DoH through the same SOCKS5 proxy. UDP-over-TCP is
disabled: GOST's extension is incompatible with sing-box's UoT protocol.
There is deliberately no direct outbound or direct DNS fallback.
Loopback stays local for the authenticated API and optional test HTTP inbound.
"""

import ipaddress
import re


CORE_VERSION = "1.14.4"
ROUTE_TABLE = 48273
RULE_INDEX = 18273
RULE_COUNT = 11
RULE_LAST = RULE_INDEX + RULE_COUNT - 1
INTERFACE_NAME = "modeldock0"
TUN_INTERFACE = INTERFACE_NAME

TUN_ADDRESSES = ("172.31.255.1/30", "fd42:73fb:4827::1/126")
TUN_DNS_ADDRESSES = ("172.31.255.2", "fd42:73fb:4827::2")
ROUTE_ADDRESSES = ("0.0.0.0/1", "128.0.0.0/1", "::/1", "8000::/1")
LOOPBACK_EXCLUDES = ("127.0.0.0/8", "::1/128")
DOH_ADDRESS = "1.1.1.1"
DOH_SERVER_NAME = "cloudflare-dns.com"
OUTBOUND_TAG = "phone-proxy"
DNS_TAG = "proxy-doh"

_INTERFACE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,14}\Z")
_SECRET = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")


def validate_endpoint(endpoint) -> tuple[str, int]:
    """Validate an object with host/port; TUN bootstrap requires a numeric IP."""
    host, port = getattr(endpoint, "host", None), getattr(endpoint, "port", None)
    if not isinstance(host, str) or not host or host != host.strip():
        raise ValueError("TUN 上游代理地址无效")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError("TUN 模式请填写手机的 IPv4 或 IPv6 地址，不能使用域名") from None
    effective = address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped else address
    if effective.is_unspecified or effective.is_loopback or effective.is_multicast:
        raise ValueError("TUN 上游不能使用回环、未指定或组播地址")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("TUN 上游代理端口必须是 1–65535 的整数")
    return str(address), port


def validate_physical_interface(value: str) -> str:
    if not isinstance(value, str) or not _INTERFACE.fullmatch(value):
        raise ValueError("物理网卡名称无效")
    if value in ("lo", INTERFACE_NAME):
        raise ValueError("上游网卡不能是回环或本软件的 TUN 网卡")
    return value


def _port(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError(f"{label}必须是 1–65535 的整数")
    return value


def build_config(
    endpoint,
    physical_interface: str,
    api_port: int,
    api_secret: str,
    interface_name: str = INTERFACE_NAME,
    *,
    proxy_port: int | None = None,
) -> dict:
    """Build a fresh config; helper-generated ports/secret are never persisted here.

    ``proxy_port`` optionally exposes a loopback-only HTTP inbound for website
    tests during TUN operation, so the GUI does not create another upstream
    socket that could be captured by the TUN. Its traffic is counted by the
    same core as TUN traffic.
    """
    host, port = validate_endpoint(endpoint)
    physical_interface = validate_physical_interface(physical_interface)
    if interface_name != INTERFACE_NAME:
        raise ValueError(f"TUN 网卡名称必须为 {INTERFACE_NAME}")
    api_port = _port(api_port, "API 端口")
    if not isinstance(api_secret, str) or not _SECRET.fullmatch(api_secret):
        raise ValueError("API 密钥须由特权助手生成，为 32–128 位安全字符")
    if proxy_port is not None:
        proxy_port = _port(proxy_port, "本地测试代理端口")
        if proxy_port == api_port:
            raise ValueError("本地测试代理端口不能与 API 端口相同")
    if "%" in host and host.rsplit("%", 1)[1] != physical_interface:
        raise ValueError("IPv6 地址的网卡作用域必须与上游物理网卡一致")

    inbounds = [{
        "type": "tun",
        "tag": "tun-in",
        "interface_name": INTERFACE_NAME,
        "address": list(TUN_ADDRESSES),
        "mtu": 1500,
        "stack": "system",
        "auto_route": True,
        "auto_redirect": False,
        "strict_route": True,
        "dns_mode": "hijack",
        "dns_address": list(TUN_DNS_ADDRESSES),
        "iproute2_table_index": ROUTE_TABLE,
        "iproute2_rule_index": RULE_INDEX,
        # Split defaults are intentional: Linux auto-route suppresses /0 when
        # checking this table before main's connected routes. More-specific
        # split defaults also capture LAN UDP instead of silently bypassing it.
        "route_address": list(ROUTE_ADDRESSES),
        "route_exclude_address": list(LOOPBACK_EXCLUDES),
    }]
    if proxy_port is not None:
        inbounds.append({
            "type": "http", "tag": "tests-in",
            "listen": "127.0.0.1", "listen_port": proxy_port,
        })
    return {
        "log": {"disabled": True},
        "dns": {
            "servers": [{
                "type": "https", "tag": DNS_TAG,
                "server": DOH_ADDRESS, "server_port": 443,
                "path": "/dns-query",
                "tls": {"enabled": True, "server_name": DOH_SERVER_NAME},
                "detour": OUTBOUND_TAG,
            }],
            "final": DNS_TAG,
            # A phone VPN without IPv6 egress makes TUN connections reset
            # during TLS. Filter AAAA answers for this TUN session so ordinary
            # applications use the working IPv4 path; literal IPv6 routing
            # stays available and no host IPv6 setting is changed.
            "strategy": "ipv4_only",
            "timeout": "8s",
        },
        "inbounds": inbounds,
        "outbounds": [{
            "type": "socks", "tag": OUTBOUND_TAG, "version": "5",
            "server": host, "server_port": port,
            "udp_over_tcp": False,
            "bind_interface": physical_interface,
            "connect_timeout": "8s",
        }],
        "route": {
            "auto_detect_interface": False,
            "default_interface": physical_interface,
            "rules": [
                {"port": 53, "action": "hijack-dns"},
                {"network": ["tcp", "udp"], "action": "route", "outbound": OUTBOUND_TAG},
                {"action": "reject"},
            ],
            "final": OUTBOUND_TAG,
        },
        "experimental": {
            "clash_api": {
                "external_controller": f"127.0.0.1:{api_port}",
                "secret": api_secret,
                "access_control_allow_origin": [],
                "access_control_allow_private_network": False,
            },
        },
    }
