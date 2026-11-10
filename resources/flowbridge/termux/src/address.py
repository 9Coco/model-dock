#!/usr/bin/env python3
"""Best-effort local IPv4 candidates for a phone-hosted proxy.

Android may deny interface enumeration even though listening sockets work.
Candidates therefore never claim to identify the hotspot conclusively.  The
computer's IPv4 gateway after joining the hotspot is the source of truth.
This module only reads local interface information; it does not scan a network.
"""

import argparse
import ctypes
import ipaddress
import json
import re
import socket
import struct
import subprocess
import sys


GATEWAY_COMMAND = "nmcli -f GENERAL.CONNECTION,IP4.GATEWAY device show"
HINT = "手机接口候选或以前保存的 IP 不保证当前可用，请从连接热点的电脑验证。"
DESKTOP_HINT = "电脑连接手机热点后，打开 ModelDock 的“网络接管 → 查询热点地址”，选择热点对应的候选地址，然后点击“连接”验证。"
VPN_OR_NON_LAN = re.compile(
    r"^(lo\d*$|tun|tap|utun|wg|wireguard|ppp|ipsec|vpn|clat|v4-|"
    r"dummy|docker|veth|virbr|br-|rmnet|r_rmnet|ccmni|pdp|p2p)",
    re.IGNORECASE,
)
HOTSPOT_INTERFACE = re.compile(r"^(ap\d|swlan|softap)|hotspot|_ap", re.IGNORECASE)
WIRELESS_INTERFACE = re.compile(r"^(wlan|wlp|wlx|wifi)", re.IGNORECASE)


def usable_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        return False
    return not (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or str(address) == "255.255.255.255"
    )


def candidate(interface, address):
    if VPN_OR_NON_LAN.search(interface) or not usable_ipv4(address):
        return None
    if HOTSPOT_INTERFACE.search(interface):
        kind, priority = "hotspot", 0
    elif WIRELESS_INTERFACE.search(interface):
        kind, priority = "wireless", 1
    else:
        kind, priority = "other", 2
    return {"interface": interface, "address": address, "kind": kind, "priority": priority}


def via_getifaddrs():
    """Use the Linux/Android ABI; failures are normal on restricted Android."""
    if not sys.platform.startswith("linux"):
        raise OSError("当前平台不使用 Linux/Android getifaddrs 布局")

    class Ifaddrs(ctypes.Structure):
        pass

    Ifaddrs._fields_ = [
        ("next", ctypes.POINTER(Ifaddrs)),
        ("name", ctypes.c_char_p),
        ("flags", ctypes.c_uint),
        ("addr", ctypes.c_void_p),
        ("netmask", ctypes.c_void_p),
        ("ifu", ctypes.c_void_p),
        ("data", ctypes.c_void_p),
    ]
    libc = ctypes.CDLL(None, use_errno=True)
    libc.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(Ifaddrs))]
    libc.getifaddrs.restype = ctypes.c_int
    libc.freeifaddrs.argtypes = [ctypes.POINTER(Ifaddrs)]
    libc.freeifaddrs.restype = None
    head = ctypes.POINTER(Ifaddrs)()
    if libc.getifaddrs(ctypes.byref(head)) != 0:
        raise OSError(ctypes.get_errno(), "getifaddrs 不可用")
    result = []
    try:
        current = head
        while current:
            entry = current.contents
            if entry.addr and entry.name and entry.flags & 1:  # IFF_UP
                family = ctypes.c_ushort.from_address(entry.addr).value
                if family == socket.AF_INET:
                    # sockaddr_in: family(2), port(2), IPv4 address(4).
                    packed = ctypes.string_at(entry.addr + 4, 4)
                    result.append((entry.name.decode("utf-8", "replace"), socket.inet_ntoa(packed)))
            current = entry.next
    finally:
        libc.freeifaddrs(head)
    return result


def via_ip():
    process = subprocess.run(
        ["ip", "-4", "-o", "addr", "show", "up"],
        text=True, capture_output=True, timeout=2, check=False,
    )
    if process.returncode:
        raise OSError("ip 无法读取接口信息")
    result = []
    for line in process.stdout.splitlines():
        match = re.match(r"\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/", line)
        if match:
            result.append((match.group(1).split("@", 1)[0], match.group(2)))
    return result


def via_ioctl():
    """Read individual interfaces if netlink-based enumeration is denied."""
    import fcntl

    names = {"ap0", "ap1", "swlan0", "softap0", "wlan0", "wlan1", "wlan2", "eth0", "rndis0", "usb0"}
    try:
        names.update(name for _, name in socket.if_nameindex())
    except OSError:
        pass
    result = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as handle:
        for name in sorted(names):
            if VPN_OR_NON_LAN.search(name):
                continue
            request = struct.pack("256s", name.encode()[:15])
            try:
                flags = fcntl.ioctl(handle.fileno(), 0x8913, request)  # SIOCGIFFLAGS
                if not struct.unpack_from("H", flags, 16)[0] & 1:
                    continue
                response = fcntl.ioctl(handle.fileno(), 0x8915, request)  # SIOCGIFADDR
                result.append((name, socket.inet_ntoa(response[20:24])))
            except OSError:
                continue
    return result


def discover():
    found = {}
    methods = []
    errors = []
    for name, reader in (("getifaddrs", via_getifaddrs), ("ip", via_ip), ("ioctl", via_ioctl)):
        try:
            for interface, address in reader():
                item = candidate(interface, address)
                if item:
                    found[(interface, address)] = item
            methods.append(name)
        except (OSError, AttributeError, ImportError, subprocess.TimeoutExpired) as error:
            errors.append({"method": name, "reason": str(error)})
    return sorted(found.values(), key=lambda item: (item["priority"], item["interface"], int(ipaddress.IPv4Address(item["address"])))), methods, errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=38473)
    parser.add_argument("--manual", metavar="IP", help="手动指定电脑热点连接中显示的手机 IPv4 网关")
    parser.add_argument("--json", action="store_true", help="输出结构化结果")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口应为 1 到 65535")
    if args.manual is not None:
        if not usable_ipv4(args.manual):
            parser.error("--manual 应填写手机的可连接 IPv4 地址，不能填 0.0.0.0 或回环地址")
        items = [{"interface": "", "address": str(ipaddress.IPv4Address(args.manual)), "kind": "manual", "priority": -1}]
        methods, errors = [], []
    else:
        items, methods, errors = discover()
    for item in items:
        item["proxy_url"] = f"http://{item['address']}:{args.port}"
    result = {
        "port": args.port,
        "candidates": items,
        "manual": args.manual is not None,
        "hint": HINT,
        "desktop_hint": DESKTOP_HINT,
        "gateway_command": GATEWAY_COMMAND,
        "methods": methods,
        "errors": errors,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        labels = {"manual": "手动设置", "hotspot": "热点接口候选", "wireless": "无线接口候选", "other": "其他接口候选"}
        if items:
            print("已保存的手机代理地址（请从电脑确认当前仍可用）：" if args.manual is not None else "手机 HTTP / SOCKS5 共用代理地址候选（脚本尚未从电脑验证）：")
            for item in items:
                interface = f"，{item['interface']}" if item["interface"] else ""
                print(f"  {item['proxy_url']}  （{labels[item['kind']]}{interface}）")
        else:
            print(f"代理端口：{args.port}；未能读取可用的手机 IPv4 地址，可能受系统权限限制。")
        print(HINT)
        print(DESKTOP_HINT)
        print("电脑查询命令：" + GATEWAY_COMMAND)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
