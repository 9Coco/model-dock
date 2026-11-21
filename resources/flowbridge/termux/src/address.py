#!/usr/bin/env python3
"""Best-effort local IPv4 candidates for a phone-hosted proxy.

Android may deny interface enumeration even though listening sockets work.
Candidates therefore never claim to identify the hotspot conclusively.  The
computer's IPv4 gateway after joining the hotspot is the source of truth.
This module only reads local interface information; it does not scan a network.
"""

import argparse
import ctypes
import getpass
import ipaddress
import json
import os
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
            except OSError:
                # Android may deny reading flags but allow reading the IPv4 address.
                flags = None
            if flags is not None and not struct.unpack_from("H", flags, 16)[0] & 1:
                continue
            try:
                response = fcntl.ioctl(handle.fileno(), 0x8915, request)  # SIOCGIFADDR
                result.append((name, socket.inet_ntoa(response[20:24])))
            except OSError:
                continue
    return result


def via_ifconfig():
    # Without -a, ifconfig lists active interfaces. Termux versions use either
    # "inet IP" or "inet addr:IP"; older ones print interface flags after the IP.
    process = subprocess.run(["ifconfig"], text=True, capture_output=True, timeout=2, check=False)
    result = []
    for section in re.split(r"(?=^\S)", process.stdout, flags=re.MULTILINE):
        if not section.strip():
            continue
        header = section.splitlines()[0]
        name = header.split()[0].rstrip(":")
        flags = re.search(r"\bflags=[^<\s]*<([^>]*)>", header)
        if flags and "UP" not in flags.group(1).split(","):
            continue
        legacy_flags = re.search(r"^\s*([A-Z0-9_ ]+)\s+MTU:", section, re.MULTILINE)
        if legacy_flags and "UP" not in legacy_flags.group(1).split():
            continue
        for address in re.findall(r"\binet\s+(?:addr:\s*)?([0-9.]+)(?=\s|$)", section):
            if usable_ipv4(address):
                result.append((name, address))
    if process.returncode and not result:
        raise OSError("ifconfig 无法读取接口信息")
    return result


def discover():
    found = {}
    methods = []
    errors = []
    for name, reader in (("getifaddrs", via_getifaddrs), ("ip", via_ip), ("ioctl", via_ioctl), ("ifconfig", via_ifconfig)):
        try:
            for interface, address in reader():
                item = candidate(interface, address)
                if item:
                    found[(interface, address)] = item
            methods.append(name)
        except (OSError, AttributeError, ImportError, subprocess.TimeoutExpired) as error:
            errors.append({"method": name, "reason": str(error)})
    return sorted(found.values(), key=lambda item: (item["priority"], item["interface"], int(ipaddress.IPv4Address(item["address"])))), methods, errors


def hotspot_address(items, manual):
    # Some Android devices expose a dedicated AP interface. The verified
    # phone uses wlan2 as its hotspot gateway and wlan0 for its upstream Wi-Fi.
    addresses = {item["address"] for item in items if item["kind"] == "hotspot"}
    if not addresses:
        addresses = {item["address"] for item in items if item["interface"] == "wlan2"}
    if manual in addresses:
        return manual
    return next(iter(addresses)) if len(addresses) == 1 else None


def ssh_destination():
    fields = os.environ.get("SSH_CONNECTION", "").split()
    if len(fields) == 4:
        try:
            address = ipaddress.ip_address(fields[2])
            port = int(fields[3])
            if not address.is_loopback and not address.is_unspecified and 0 < port <= 65535:
                return str(address), port
        except ValueError:
            pass
    return None, 8022


def print_connections(items, port, manual):
    hotspot = hotspot_address(items, manual)
    session, ssh_port = ssh_destination()
    user = getpass.getuser()

    def ssh_command(label, address):
        print(f"  {label}\n    ssh -p {ssh_port} {user}@{address}")

    print("【1. 从电脑用 SSH 登录手机】")
    if session:
        ssh_command("电脑保持当前网络，重新登录用：", session)
    else:
        wifi = next((item["address"] for item in items if item["interface"] == "wlan0"), None)
        if wifi and wifi != hotspot:
            ssh_command("电脑和手机连同一个 Wi-Fi 时用：", wifi)
        if hotspot:
            ssh_command("电脑连手机开的热点时用：", hotspot)
        if not wifi and not hotspot:
            print("  手机连上 Wi-Fi 或开启热点后，执行 hotspot-proxy info 查看地址。")

    print("\n【2. 电脑连手机热点，通过手机代理上网】")
    if hotspot:
        print(f"  电脑 Wi-Fi 连上手机热点后，代理填：{hotspot}:{port}（HTTP / SOCKS5 共用）")
        print("  如需核对，在 Windows 运行 ipconfig，查看无线网卡的 IPv4 默认网关。")
    else:
        print(f"  开启热点并让电脑连上后，代理服务器填无线网卡的 IPv4 默认网关，端口填 {port}（HTTP / SOCKS5 共用）。")
        print("  Windows 可运行 ipconfig，或在 ModelDock 中查询热点地址。")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=38473)
    parser.add_argument("--manual", metavar="IP", help="手动指定电脑热点连接中显示的手机 IPv4 网关")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", help="输出结构化结果")
    output.add_argument("--connections", action="store_true", help="按 SSH 登录和热点代理两种用途显示当前地址")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口应为 1 到 65535")
    if args.manual is not None and not usable_ipv4(args.manual):
        parser.error("--manual 应填写手机的可连接 IPv4 地址，不能填 0.0.0.0 或回环地址")
    if args.connections:
        items, _, _ = discover()
        print_connections(items, args.port, args.manual)
        return 0
    if args.manual is not None:
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
