"""Restricted root helper for FlowBridge's fixed sing-box 全局接管configuration.

The installed launcher uses /usr/bin/python3 -I and a root-owned source tree.
Only a numeric phone endpoint and optional destination IPs cross stdin.
No shell commands, file paths, interface names or arbitrary sing-box
configuration are accepted from the GUI.
"""

from __future__ import annotations

import ctypes
from collections import Counter
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from types import ModuleType, SimpleNamespace
import urllib.request


SOURCE_DIR = Path("/opt/modeldock-network")
CORE_PATH = SOURCE_DIR / "core/sing-box"
LAUNCHER_PATH = Path("/usr/libexec/modeldock-network-tun-helper")
RUNTIME_DIR = Path("/run/modeldock-network")
CORE_VERSION = "1.14.4"
ROUTE_TABLE = 48273
RULE_INDEX = 18273
RULE_COUNT = 11
RULE_LAST = RULE_INDEX + RULE_COUNT - 1
INTERFACE_NAME = "modeldock0"
MAX_MESSAGE_BYTES = 4096
# Exact IPv6 exclusions can split a default route into up to 128 prefixes each.
MAX_JOURNAL_BYTES = 2 * 1024 * 1024
CHILD_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
EOF = object()


class HelperError(RuntimeError):
    pass


class StopRequested(Exception):
    pass


def validate_invoker(environment=None) -> int:
    if os.geteuid() != 0:
        raise HelperError("全局接管助手必须由系统授权工具以 root 运行。")
    environment = os.environ if environment is None else environment
    value = environment.get("PKEXEC_UID", "")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,10}", value):
        raise HelperError("缺少有效的系统授权用户。")
    uid = int(value)
    if uid <= 0:
        raise HelperError("系统授权用户必须是非 root 用户。")
    try:
        entry = pwd.getpwuid(uid)
    except (KeyError, OverflowError) as error:
        raise HelperError("系统授权用户不存在。") from error
    if entry.pw_uid != uid:
        raise HelperError("系统授权用户无效。")
    return uid


def require_root_path(path: Path, *, executable=False, directory=False) -> Path:
    """Reject symlinks and writable/non-root components in privileged paths."""
    path = Path(path)
    if not path.is_absolute():
        raise HelperError("特权程序路径必须为绝对路径。")
    for component in (Path(path.anchor), *list(path.parents)[::-1][1:], path):
        try:
            info = component.lstat()
        except OSError as error:
            raise HelperError("全局接管安装文件缺失或不可读取，请重新安装软件。") from error
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise HelperError("全局接管安装目录或文件的权限不安全，请重新安装软件。")
        if component != path and not stat.S_ISDIR(info.st_mode):
            raise HelperError("全局接管安装路径包含非目录组件。")
    info = path.lstat()
    if directory:
        valid = stat.S_ISDIR(info.st_mode)
    else:
        valid = stat.S_ISREG(info.st_mode) and (not executable or bool(info.st_mode & 0o111))
    if not valid:
        raise HelperError("全局接管安装文件类型或执行权限无效。")
    return path


def validate_installation():
    if Path(__file__).absolute() != SOURCE_DIR / "tun_helper.py":
        raise HelperError("全局接管助手只能从已安装的固定系统目录运行。")
    require_root_path(SOURCE_DIR, directory=True)
    require_root_path(SOURCE_DIR / "tun_helper.py")
    require_root_path(LAUNCHER_PATH, executable=True)
    require_root_path(CORE_PATH, executable=True)
    for source in SOURCE_DIR.glob("*.py"):
        require_root_path(source)
    require_root_path(SOURCE_DIR / "tun_config.py")


def validate_request(message, *, normalize_bypass=None) -> SimpleNamespace:
    fields = {"version", "host", "port"}
    if not isinstance(message, dict) or set(message) - {"bypassAddresses"} != fields:
        raise HelperError("全局接管启动请求格式无效。")
    if type(message["version"]) is not int or message["version"] != 2:
        raise HelperError("全局模式的通信版本不匹配。请更新 ModelDock 的 deb 安装包，再重新启动应用。")
    if type(message["port"]) is not int or not 1 <= message["port"] <= 65535:
        raise HelperError("手机代理端口无效。")
    host = message["host"]
    if not isinstance(host, str) or "%" in host:
        raise HelperError("全局接管模式需要填写手机的数字 IP 地址。")
    try:
        address = ipaddress.ip_address(host)
    except ValueError as error:
        raise HelperError("全局接管模式需要填写手机的数字 IP 地址。") from error
    if address.is_loopback or address.is_unspecified or address.is_multicast or str(address) == "255.255.255.255":
        raise HelperError("手机代理 IP 地址不能是回环、空地址或广播地址。")
    bypass_addresses = ()
    if "bypassAddresses" in message:
        if not isinstance(message["bypassAddresses"], list) or normalize_bypass is None:
            raise HelperError("全局接管直连白名单格式无效。")
        try:
            bypass_addresses = normalize_bypass(message["bypassAddresses"])
        except ValueError as error:
            raise HelperError(str(error)) from error
    return SimpleNamespace(host=str(address), port=message["port"], bypass_addresses=bypass_addresses)


def is_recovery_request(message) -> bool:
    return (isinstance(message, dict) and set(message) == {"version", "command"}
            and type(message["version"]) is int and message["version"] == 1
            and message["command"] == "recover")


def validate_reusable_request(message, *, command, session_id=None, normalize_bypass=None):
    """Accept only the fixed v3 endpoint/stop vocabulary on the private pipe."""
    fields = {"version", "command", "id"}
    if command == "start":
        fields |= {"host", "port"}
        if isinstance(message, dict) and "bypassAddresses" in message:
            fields.add("bypassAddresses")
    if (not isinstance(message, dict) or set(message) != fields
            or type(message["version"]) is not int or message["version"] != 3
            or message["command"] != command
            or type(message["id"]) is not int or not 1 <= message["id"] <= 2 ** 31 - 1
            or (session_id is not None and message["id"] != session_id)):
        raise HelperError("全局接管会话控制请求无效。")
    if command == "start":
        request = {name: message[name] for name in fields - {"version", "command", "id"}}
        return validate_request({"version": 2, **request}, normalize_bypass=normalize_bypass)
    if command != "stop":
        raise HelperError("全局接管会话控制命令无效。")
    return None


class _ReusableReader:
    """Narrow one active session to its own stop request or pipe EOF."""
    def __init__(self, reader, session_id):
        self.reader = reader
        self.session_id = session_id
        self.eof = False
        self.invalid = False

    def poll(self, timeout=0):
        try:
            message = self.reader.poll(timeout)
            if message is EOF:
                self.eof = True
                return EOF
            if message is not None:
                validate_reusable_request(message, command="stop", session_id=self.session_id)
                return {"command": "stop"}
            return None
        except HelperError:
            self.invalid = True
            raise


class _ReusableOutput:
    """Tag trusted helper status with the session that created its resources."""
    def __init__(self, output, session_id):
        self.output = output
        self.session_id = session_id

    def write(self, line):
        value = json.loads(line)
        value["id"] = self.session_id
        self.output.write(json.dumps(value, ensure_ascii=True) + "\n")
        return len(line)

    def flush(self):
        self.output.flush()


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def decode_message(raw: bytes):
    if not raw or len(raw) > MAX_MESSAGE_BYTES:
        raise HelperError("全局接管通信消息为空或超过长度限制。")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise HelperError("全局接管通信消息不是有效 JSON。") from error


class MessageReader:
    def __init__(self, fd: int):
        self.fd = fd
        self.pending = bytearray()
        self.selector = selectors.DefaultSelector()
        self.selector.register(fd, selectors.EVENT_READ)

    def poll(self, timeout=0):
        if b"\n" not in self.pending:
            if not self.selector.select(timeout):
                return None
            block = os.read(self.fd, MAX_MESSAGE_BYTES + 1)
            if not block:
                if self.pending:
                    raise HelperError("全局接管通信消息缺少换行结束符。")
                return EOF
            self.pending.extend(block)
        newline = self.pending.find(b"\n")
        if newline < 0:
            if len(self.pending) > MAX_MESSAGE_BYTES:
                raise HelperError("全局接管通信消息超过长度限制。")
            return None
        raw = bytes(self.pending[:newline])
        del self.pending[:newline + 1]
        return decode_message(raw.rstrip(b"\r"))

    def close(self):
        self.selector.close()


def run_command(command, *, timeout=6):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout,
                              check=False, env=CHILD_ENV, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HelperError("无法执行 全局接管网络检查或恢复命令。") from error


def find_ip_command() -> str:
    for candidate in (Path("/usr/sbin/ip"), Path("/usr/bin/ip")):
        if candidate.exists():
            resolved = candidate.resolve()
            require_root_path(resolved, executable=True)
            return str(resolved)
    raise HelperError("全局模式需要 iproute2，请使用系统包管理器安装。")


class RouteResources:
    """Own only the previously empty fixed table, rule range and 全局接管name.

    The fixed sing-tun version uses goto/nop/main-table rules within this range;
    matching only lookup=ROUTE_TABLE would leave routing changes behind.
    """

    def __init__(self, ip_command: str, runner=run_command):
        self.ip = ip_command
        self.runner = runner
        self.claimed = False
        self.core_started = False
        self.ifindex = None
        self.ownership = None

    def _json(self, arguments):
        # Numeric table IDs avoid user-defined rt_tables aliases hiding a collision.
        result = self.runner([self.ip, "-N", *arguments])
        if result.returncode:
            raise HelperError("无法读取系统路由状态；未尝试接管网络。")
        try:
            value = json.loads(result.stdout)
        except (ValueError, TypeError) as error:
            raise HelperError("系统路由检查返回了无效数据。") from error
        if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
            raise HelperError("系统路由检查返回了无效数据。")
        return value

    def rules(self, family):
        rows = self._json([f"-{family}", "-j", "rule", "show"])
        return [row for row in rows if type(row.get("priority")) is int
                and RULE_INDEX <= row["priority"] <= RULE_LAST]

    def routes(self, family):
        rows = self._json([f"-{family}", "-j", "route", "show", "table", "all"])
        return [row for row in rows if str(row.get("table", "")) == str(ROUTE_TABLE)]

    def links(self):
        return self._json(["-j", "-d", "link", "show"])

    def assert_available(self):
        for family in (4, 6):
            if self.rules(family) or self.routes(family):
                raise HelperError("全局接管专用路由表或规则段已被占用，未更改现有网络。")
        if any(row.get("ifname") == INTERFACE_NAME for row in self.links()):
            raise HelperError("全局接管专用接口名称已被占用，未更改现有网络。")
        self.claimed = True

    def upstream_interface(self, host: str) -> str:
        family = ipaddress.ip_address(host).version
        routes = self._json([f"-{family}", "-j", "route", "get", host])
        if not routes or routes[0].get("type") in ("local", "unreachable", "blackhole", "prohibit"):
            raise HelperError("手机代理当前没有可用的物理网络路由。")
        name = routes[0].get("dev", "")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", name):
            raise HelperError("无法确认手机代理使用的网络接口。")
        blocked_name = re.match(r"^(?:lo(?:\d|$)|tun|tap|utun|wg|vpn|tailscale|flowbridge)", name, re.I)
        link = next((row for row in self.links() if row.get("ifname") == name), None)
        kind = (link or {}).get("linkinfo", {}).get("info_kind", "")
        if blocked_name or link is None or link.get("link_type") == "loopback" or kind in {
            "tun", "tap", "wireguard", "ipip", "sit", "gre", "gretap", "ip6gre", "vti", "dummy",
        }:
            raise HelperError("手机代理当前经虚拟接口或 VPN 路由，请先连接手机热点。")
        return name

    def note_interface(self):
        link = next((row for row in self.links() if row.get("ifname") == INTERFACE_NAME), None)
        if link is None:
            return False
        if link.get("linkinfo", {}).get("info_kind") != "tun" or type(link.get("ifindex")) is not int:
            raise HelperError("全局接管接口类型或身份不符合预期。")
        self.ifindex = link["ifindex"]
        return True

    def snapshot(self):
        return {f"{kind}{family}": getattr(self, kind)(family)
                for family in (4, 6) for kind in ("rules", "routes")}

    @staticmethod
    def _fingerprints(rows):
        return Counter(json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows)

    @staticmethod
    def _normal_rule(raw, family):
        """Normalize iproute2's JSON spelling without losing snapshot identity."""
        row = dict(raw)
        for field in ("src", "dst"):
            length = row.pop(field + "len", None)
            if length is not None:
                if type(length) is not int or not 0 <= length <= (32 if family == 4 else 128):
                    raise ValueError("invalid prefix")
                row[field] = str(ipaddress.ip_network(f"{row[field]}/{length}", strict=False))
        if "not" in row:
            if row["not"] not in (None, True, False):
                raise ValueError("invalid negation")
            row["not"] = row["not"] is not False
        if "nop" in row:
            if row.pop("nop") is not None or "action" in row:
                raise ValueError("invalid nop")
            row["action"] = "nop"
        if "suppress_prefixlen" in row:
            if "suppress_prefixlength" in row:
                raise ValueError("duplicate prefix suppression")
            row["suppress_prefixlength"] = row.pop("suppress_prefixlen")
        if "dport_mask" in row:
            if str(row.pop("dport_mask")) not in ("0xffff", "65535") or "dport" not in row:
                raise ValueError("invalid destination port mask")
        if row.get("table") == "main":
            row["table"] = 254
        return row

    @classmethod
    def _known_rule(cls, raw, family):
        """Conservative signatures for this fixed core/config before readiness."""
        try:
            row = cls._normal_rule(raw, family)
        except (ValueError, TypeError, KeyError):
            return False
        priority = row.get("priority")
        table = str(row.get("table", ""))
        allowed = {"priority", "src", "dst", "table", "iif", "not", "dport",
                   "suppress_prefixlength", "goto", "action", "protocol"}
        if set(row) - allowed:
            return False
        source = row.get("src", "all")
        destination = row.get("dst", "all")
        if row.get("protocol") is not None and not re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", str(row["protocol"])):
            return False
        if "goto" in row:
            if (row["goto"] != RULE_LAST or table not in ("", "0")
                    or priority != RULE_INDEX + 2 or row.get("not") or "dport" in row
                    or "suppress_prefixlength" in row or destination != "all"):
                return False
            return (row.get("iif") == INTERFACE_NAME and source == "all") or (
                family == 6 and row.get("iif") == "lo" and source in ("::/1", "8000::/1")
            )
        if row.get("action") == "nop":
            return (priority == RULE_LAST and table in ("", "0") and source == destination == "all"
                    and not (set(row) - {"priority", "src", "dst", "table", "action", "protocol"}))
        if table == "254":
            return (priority == RULE_INDEX + (2 if family == 4 else 1)
                    and row.get("not") is True and str(row.get("dport")) in ("53", "53-53")
                    and row.get("suppress_prefixlength") == 0 and source == destination == "all"
                    and "iif" not in row and row.get("action") in (None, "to_tbl", "lookup"))
        if table != str(ROUTE_TABLE):
            return False
        if row.get("action") not in (None, "to_tbl", "lookup") or "dport" in row:
            return False
        if family == 4:
            return ((priority == RULE_INDEX and destination == "172.31.255.0/30"
                     and source == "all" and "iif" not in row and not row.get("not")
                     and "suppress_prefixlength" not in row)
                    or (priority == RULE_INDEX + 1 and source == destination == "all"
                        and row.get("suppress_prefixlength") == 0 and "iif" not in row and not row.get("not"))
                    or (priority == RULE_INDEX + 3 and destination == "all"
                        and row.get("iif") == "lo" and "suppress_prefixlength" not in row
                        and ((row.get("not") is True and source == "all")
                             or (not row.get("not") and source in ("0.0.0.0", "0.0.0.0/32", "172.31.255.0/30")))))
        return ((priority == RULE_INDEX and source == destination == "all"
                 and row.get("suppress_prefixlength") == 0 and "iif" not in row and not row.get("not"))
                or (priority == RULE_INDEX + 1 and source == "fd42:73fb:4827::/126"
                    and destination == "all" and row.get("iif") == "lo" and not row.get("not")
                    and "suppress_prefixlength" not in row)
                or (priority == RULE_INDEX + 3 and source == destination == "all"
                    and "iif" not in row and not row.get("not") and "suppress_prefixlength" not in row))

    @staticmethod
    def _known_route(row, family):
        allowed = {"dst", "table", "dev", "gateway", "protocol", "scope", "prefsrc", "metric", "pref", "flags", "type"}
        if set(row) - allowed or row.get("dev") != INTERFACE_NAME or row.get("type", "unicast") != "unicast":
            return False
        try:
            if row.get("dst", "default") != "default":
                if ipaddress.ip_network(row["dst"], strict=False).version != family:
                    return False
            for key in ("gateway", "prefsrc"):
                if key in row and ipaddress.ip_address(row[key]).version != family:
                    return False
        except (ValueError, TypeError):
            return False
        if "metric" in row and (type(row["metric"]) is not int or row["metric"] < 0):
            return False
        return (all(re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", str(row[key]))
                    for key in ("protocol", "scope", "pref") if key in row)
                and row.get("flags", []) == [])

    def _delete_rule(self, family, row):
        row = self._normal_rule(row, family)
        args = [self.ip, f"-{family}", "rule", "del", "pref", str(row["priority"])]
        if row.get("not"):
            args.append("not")
        args += ["from", row.get("src", "all"), "to", row.get("dst", "all")]
        for key, option in (("iif", "iif"), ("dport", "dport"),
                            ("suppress_prefixlength", "suppress_prefixlength"), ("protocol", "protocol")):
            if key in row:
                args += [option, str(row[key])]
        if "goto" in row:
            args += ["goto", str(row["goto"])]
        elif row.get("action") == "nop":
            args.append("nop")
        else:
            args += ["table", str(row["table"])]
        self.runner(args)

    def _delete_route(self, family, row):
        args = [self.ip, f"-{family}", "route", "del", "unicast", row.get("dst", "default"),
                "table", str(ROUTE_TABLE), "dev", INTERFACE_NAME]
        for key, option in (("gateway", "via"), ("protocol", "proto"), ("scope", "scope"),
                            ("prefsrc", "src"), ("metric", "metric"), ("pref", "pref")):
            if key in row:
                args += [option, str(row[key])]
        self.runner(args)

    def assert_owned(self):
        """Validate every object before any mutation or core graceful shutdown."""
        if not self.claimed:
            return {}
        link = next((row for row in self.links() if row.get("ifname") == INTERFACE_NAME), None)
        if link is not None:
            if self.ifindex is not None and link.get("ifindex") != self.ifindex:
                raise HelperError("全局接管接口已被其他程序替换；保留冲突资源，请检查后重试恢复。")
            if link.get("linkinfo", {}).get("info_kind") != "tun":
                raise HelperError("全局接管接口类型已改变；未删除该接口。")
        current = self.snapshot()
        canonical_rules = {}
        for family in (4, 6):
            canonical_rules[family] = []
            for row in current[f"rules{family}"]:
                identity = dict(row)
                if "iif_detached" in identity:
                    # Linux adds this marker to an existing IIFNAME rule when
                    # the 全局接管fd closes. It is not a changed routing selector.
                    # Accept it only after our fixed core was spawned (or a
                    # prior ready snapshot recorded its interface), and only
                    # while that interface is absent. Before ready, the strict
                    # pinned selector allowlist still limits partial startup.
                    if (identity.pop("iif_detached") is not None or link is not None
                            or not (self.core_started or (self.ifindex is not None and self.ownership is not None))
                            or identity.get("iif") != INTERFACE_NAME):
                        raise HelperError("全局接管接口规则的归属无法确认；保留恢复记录。")
                if not self._known_rule(identity, family):
                    raise HelperError("全局接管规则段出现外部规则；未删除冲突资源。")
                canonical_rules[family].append(self._normal_rule(identity, family))
            if any(not self._known_route(row, family) for row in current[f"routes{family}"]):
                raise HelperError("全局接管路由表出现外部路由；未删除冲突资源。")
        if self.ownership is not None:
            for key, rows in current.items():
                family = int(key[-1])
                baseline = self.ownership.get(key, [])
                if key.startswith("rules"):
                    rows = canonical_rules[family]
                    baseline = [self._normal_rule({name: value for name, value in row.items()
                                                   if name != "iif_detached"}, family) for row in baseline]
                if self._fingerprints(rows) - self._fingerprints(baseline):
                    raise HelperError("全局接管资源已被其他程序更改；保留冲突记录，请检查后重试恢复。")
        return current

    def capture_ownership(self):
        self.ownership = self.assert_owned()
        return self.ownership

    def cleanup(self):
        if not self.claimed:
            return
        # This preflight must precede all deletion: checking the interface only
        # after rules/routes have been removed can already damage foreign state.
        current = self.assert_owned()
        if self.ownership is None:
            self.ownership = current
        for family in (4, 6):
            # Full signatures avoid deleting a different object if another
            # administrator changes the reserved scope after our preflight.
            for row in current[f"rules{family}"]:
                self._delete_rule(family, row)
            for row in current[f"routes{family}"]:
                self._delete_route(family, row)
        self.assert_owned()
        link = next((row for row in self.links() if row.get("ifname") == INTERFACE_NAME), None)
        if link is not None:
            if self.ifindex is not None and link.get("ifindex") != self.ifindex:
                raise HelperError("全局接管接口已被其他程序替换，未删除该接口。")
            if link.get("linkinfo", {}).get("info_kind") != "tun":
                raise HelperError("全局接管接口类型已改变，未删除该接口。")
            self.runner([self.ip, "link", "delete", "dev", INTERFACE_NAME])
        for family in (4, 6):
            if self.rules(family) or self.routes(family):
                raise HelperError("全局接管路由恢复尚未完成，请保留当前会话并重试停止。")
        if any(row.get("ifname") == INTERFACE_NAME for row in self.links()):
            raise HelperError("全局接管接口清理尚未完成。")
        self.claimed = False
        self.core_started = False
        self.ifindex = None
        self.ownership = None


def _load_tun_config():
    path = SOURCE_DIR / "tun_config.py"
    require_root_path(path)
    module = ModuleType("flowbridge_privileged_tun_config")
    module.__file__ = str(path)
    sys.modules[module.__name__] = module
    # Never let an import loader consume a possibly stale/user-writable .pyc.
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    expected = {"CORE_VERSION": CORE_VERSION, "ROUTE_TABLE": ROUTE_TABLE,
                "RULE_INDEX": RULE_INDEX, "RULE_COUNT": RULE_COUNT, "INTERFACE_NAME": INTERFACE_NAME}
    if any(getattr(module, key, None) != value for key, value in expected.items()):
        raise HelperError("全局接管配置与助手版本不一致，请重新安装软件。")
    return module


def _prepare_runtime() -> int:
    require_root_path(RUNTIME_DIR.parent, directory=True)
    RUNTIME_DIR.mkdir(mode=0o700, exist_ok=True)
    require_root_path(RUNTIME_DIR, directory=True)
    if stat.S_IMODE(RUNTIME_DIR.stat().st_mode) != 0o700:
        raise HelperError("全局接管运行目录权限不安全。")
    fd = os.open(RUNTIME_DIR / "session.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise HelperError("全局接管运行锁权限不安全。")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise HelperError("已有 全局接管会话正在运行。") from error
    except BaseException:
        os.close(fd)
        raise
    return fd


def _reserve_ports():
    handles = []
    try:
        for _ in range(2):
            handle = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            handle.bind(("127.0.0.1", 0))
            handles.append(handle)
        return [handle.getsockname()[1] for handle in handles]
    finally:
        for handle in handles:
            handle.close()


def _child_parent_watch(parent_pid):
    def prepare():
        libc = ctypes.CDLL(None, use_errno=True)
        # Unexpected helper death must not trigger the core's broad unsetRules;
        # the root journal lets the next authorized helper recover exact scope.
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
            raise OSError(ctypes.get_errno(), "cannot register parent death signal")
        if os.getppid() != parent_pid:
            os.kill(os.getpid(), signal.SIGKILL)
    return prepare


def stop_core(process, *, graceful=True):
    if process is None or process.poll() is not None:
        return
    if graceful:
        process.terminate()
    else:
        process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired as error:
            raise HelperError("全局接管核心尚未退出，未报告恢复完成。") from error


def process_start_time(pid: int) -> int | None:
    try:
        data = Path(f"/proc/{pid}/stat").read_text()
        fields = data[data.rfind(")") + 2:].split()
        # A dead helper may remain as a zombie until its desktop parent reaps
        # it. It no longer owns a lock or network session and must not block
        # the next authorized recovery merely because /proc still exists.
        if fields[0] in ("Z", "X", "x"):
            return None
        return int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


class SessionJournal:
    """Root-private evidence for recovering a helper killed without cleanup."""

    def __init__(self, uid: int, path: Path | None = None):
        self.uid = uid
        self.path = path if path is not None else RUNTIME_DIR / "session.json"
        self.value = None

    def _write(self):
        fd, temporary = tempfile.mkstemp(prefix=".journal-", dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.value, stream, allow_nan=False)
                if stream.tell() > MAX_JOURNAL_BYTES:
                    raise HelperError("全局接管恢复记录超过大小限制。")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def begin(self):
        self.value = {
            "version": 1, "uid": self.uid,
            "table": ROUTE_TABLE, "rule_index": RULE_INDEX, "rule_count": RULE_COUNT,
            "interface": INTERFACE_NAME, "ifindex": None,
            "helper_pid": os.getpid(), "helper_start": process_start_time(os.getpid()),
            "core_pid": None, "core_start": None, "work_dir": None,
            "ownership": None, "core_spawn_attempted": False,
        }
        if self.value["helper_start"] is None:
            raise HelperError("无法确认 全局接管助手进程身份，未启动核心。")
        self._write()

    def workspace(self, path):
        self.value["work_dir"] = str(path)
        self._write()

    def core(self, pid):
        self.value["core_pid"] = pid
        self.value["core_start"] = process_start_time(pid)
        self._write()

    def spawn_attempt(self):
        # Persist intent immediately before Popen: a helper crash between exec
        # and recording the returned PID must still recover partial 全局接管rules.
        self.value["core_spawn_attempted"] = True
        self._write()

    def interface(self, ifindex, ownership):
        self.value["ifindex"] = ifindex
        self.value["ownership"] = ownership
        self._write()

    def clear(self):
        self.path.unlink(missing_ok=True)
        self.value = None

    def _read(self):
        if not self.path.exists():
            return None
        require_root_path(self.path)
        info = self.path.stat()
        if info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > MAX_JOURNAL_BYTES:
            raise HelperError("全局接管恢复记录权限或大小异常，未更改现有网络。")
        try:
            value = json.loads(self.path.read_text())
            expected = {"version": 1, "uid": self.uid, "table": ROUTE_TABLE,
                        "rule_index": RULE_INDEX, "rule_count": RULE_COUNT, "interface": INTERFACE_NAME}
            if not isinstance(value, dict) or any(value.get(key) != item for key, item in expected.items()):
                raise ValueError("foreign session")
            for name in ("helper_pid", "helper_start"):
                if type(value.get(name)) is not int or value[name] <= 0:
                    raise ValueError("invalid identity")
            for name in ("core_pid", "core_start", "ifindex"):
                if value.get(name) is not None and (type(value[name]) is not int or value[name] <= 0):
                    raise ValueError("invalid optional identity")
            if type(value.get("core_spawn_attempted", False)) is not bool:
                raise ValueError("invalid core launch evidence")
            ownership = value.get("ownership")
            if ownership is not None and (not isinstance(ownership, dict)
                    or set(ownership) != {"rules4", "rules6", "routes4", "routes6"}
                    or any(not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows)
                           for rows in ownership.values())):
                raise ValueError("invalid ownership snapshot")
            work_dir = value.get("work_dir")
            if work_dir is not None:
                work = Path(work_dir)
                if work.parent != RUNTIME_DIR or not re.fullmatch(r"session-[A-Za-z0-9_-]+", work.name):
                    raise ValueError("invalid workspace")
        except (OSError, ValueError, TypeError) as error:
            raise HelperError("全局接管恢复记录无效或属于其他用户，未更改现有网络。") from error
        return value

    @staticmethod
    def _matches_core(pid, value):
        work = value.get("work_dir")
        if not work:
            return False
        try:
            start = process_start_time(pid)
            if start is None or (pid == value.get("core_pid") and value.get("core_start") is not None
                                 and start != value["core_start"]):
                return False
            if Path(f"/proc/{pid}/exe").resolve() != CORE_PATH:
                return False
            info = Path(f"/proc/{pid}/status").read_text()
            match = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", info, re.M)
            if not match or any(int(item) != 0 for item in match.groups()):
                return False
            args = Path(f"/proc/{pid}/cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            return args == [os.fsencode(CORE_PATH), b"run", b"-c", os.fsencode(Path(work) / "config.json")]
        except OSError:
            return False

    def recover(self, resources):
        value = self._read()
        if value is None:
            return False
        if process_start_time(value["helper_pid"]) == value["helper_start"]:
            raise HelperError("上一 全局接管助手仍在运行，未接管其资源。")
        resources.claimed = True
        resources.core_started = value.get("core_spawn_attempted", False) or value.get("core_pid") is not None
        resources.ifindex = value.get("ifindex")
        resources.ownership = value.get("ownership")
        conflict = None
        try:
            resources.assert_owned()
        except HelperError as error:
            conflict = error
        # The workspace is recorded before spawn, so even the narrow crash gap
        # before recording core_pid can be recovered without signalling a reused PID.
        candidates = []
        if value.get("work_dir"):
            for item in Path("/proc").iterdir():
                if item.name.isdecimal() and self._matches_core(int(item.name), value):
                    candidates.append(int(item.name))
        for pid in candidates:
            start = process_start_time(pid)
            if self._matches_core(pid, value) and process_start_time(pid) == start:
                os.kill(pid, signal.SIGKILL if conflict else signal.SIGTERM)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and self._matches_core(pid, value):
                time.sleep(0.1)
            if self._matches_core(pid, value) and process_start_time(pid) == start:
                os.kill(pid, signal.SIGKILL)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and self._matches_core(pid, value):
                time.sleep(0.1)
            if self._matches_core(pid, value):
                raise HelperError("上一 全局接管核心尚未退出，未开始新的接管。")
        if conflict is not None:
            raise conflict
        resources.cleanup()
        if value.get("work_dir"):
            shutil.rmtree(value["work_dir"], ignore_errors=True)
        self.clear()
        return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class HelperSession:
    def __init__(self, resources, reader, output, stop_event, build_config,
                 *, popen=subprocess.Popen, command=run_command, journal=None):
        self.resources = resources
        self.reader = reader
        self.output = output
        self.stop_event = stop_event
        self.build_config = build_config
        self.popen = popen
        self.command = command
        self.journal = journal
        self.process = None
        self.work_dir = None
        self.log = None

    def emit(self, event, **fields):
        try:
            self.output.write(json.dumps({"event": event, **fields}, ensure_ascii=True) + "\n")
            self.output.flush()
            return True
        except (OSError, ValueError):
            self.stop_event.set()
            return False

    def check_stop(self):
        if self.stop_event.is_set():
            raise StopRequested()
        message = self.reader.poll(0)
        if message is EOF:
            raise StopRequested()
        if message is not None:
            if message != {"command": "stop"}:
                raise HelperError("全局接管控制命令无效。")
            raise StopRequested()

    def wait_ready(self, api_port, api_secret, proxy_port):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        deadline = time.monotonic() + 18
        while time.monotonic() < deadline:
            self.check_stop()
            if self.process.poll() is not None:
                raise HelperError("全局接管核心启动失败或已退出。")
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{api_port}/connections",
                    headers={"Authorization": "Bearer " + api_secret},
                )
                with opener.open(request, timeout=0.4) as response:
                    body = response.read(1_000_001)
                    value = json.loads(body)
                if len(body) > 1_000_000 or not isinstance(value, dict) or not isinstance(value.get("connections"), list):
                    raise ValueError("invalid local API response")
                with socket.create_connection(("127.0.0.1", proxy_port), timeout=0.3):
                    pass
                if not self.resources.note_interface():
                    raise ValueError("全局接管interface is not ready")
                if any(not self.resources.rules(family) or not self.resources.routes(family) for family in (4, 6)):
                    raise ValueError("全局接管routes are not ready")
                ownership = self.resources.capture_ownership()
                if self.journal is not None:
                    self.journal.interface(self.resources.ifindex, ownership)
                return
            except (OSError, ValueError):
                self.stop_event.wait(0.1)
        raise HelperError("全局接管核心未能在限定时间内准备完成。")

    def run(self, endpoint):
        failed = False
        try:
            self.resources.assert_available()
            if self.journal is not None:
                self.journal.begin()
            physical = self.resources.upstream_interface(endpoint.host)
            version = self.command([str(CORE_PATH), "version"])
            if version.returncode or not re.search(r"^sing-box version 1\.14\.4(?:\s|$)", version.stdout):
                raise HelperError("全局接管核心版本不匹配，请重新安装软件。")
            self.check_stop()
            api_port, proxy_port = _reserve_ports()
            api_secret = secrets.token_urlsafe(32)
            config = self.build_config(endpoint, physical, api_port, api_secret,
                                       interface_name=INTERFACE_NAME, proxy_port=proxy_port,
                                       bypass_addresses=getattr(endpoint, "bypass_addresses", ()))
            self.work_dir = Path(tempfile.mkdtemp(prefix="session-", dir=RUNTIME_DIR))
            if self.journal is not None:
                self.journal.workspace(self.work_dir)
            config_path = self.work_dir / "config.json"
            fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(config, stream, ensure_ascii=True, allow_nan=False)
            self.log = (self.work_dir / "core.log").open("wb")
            if self.journal is not None:
                self.journal.spawn_attempt()
            self.resources.core_started = True
            self.process = self.popen(
                [str(CORE_PATH), "run", "-c", str(config_path)], cwd=self.work_dir,
                stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT,
                env=CHILD_ENV, close_fds=True, start_new_session=True,
                preexec_fn=_child_parent_watch(os.getpid()),
            )
            if self.journal is not None:
                self.journal.core(self.process.pid)
            self.wait_ready(api_port, api_secret, proxy_port)
            if not self.emit("ready", api_port=api_port, proxy_port=proxy_port,
                             api_secret=api_secret, interface=INTERFACE_NAME):
                raise StopRequested()
            while True:
                self.check_stop()
                if self.process.poll() is not None:
                    raise HelperError("全局接管核心意外退出，正在恢复网络。")
                self.stop_event.wait(0.1)
        except StopRequested:
            pass
        except Exception as error:
            self.emit("error", message=str(error) if isinstance(error, HelperError)
                      else "全局接管启动或运行失败，正在恢复网络。")
        finally:
            try:
                try:
                    self.resources.assert_owned()
                except HelperError:
                    stop_core(self.process, graceful=False)
                    raise
                stop_core(self.process)
                self.resources.cleanup()
                if self.journal is not None:
                    self.journal.clear()
            except Exception as error:
                failed = True
                self.emit("error", message=str(error) if isinstance(error, HelperError)
                          else "全局接管网络恢复未完成。")
            if self.log is not None:
                self.log.close()
            if self.work_dir is not None and not failed:
                shutil.rmtree(self.work_dir, ignore_errors=True)
        if not failed:
            self.emit("stopped")
        return 1 if failed else 0


def run_reusable_sessions(request, *, uid, ip_command, reader, output, stop_event, build_config,
                          normalize_bypass=None):
    """Retain one authorization, while retaining no routes between sessions.

    The lifetime remains the inherited private pipe, not a public socket or a
    system daemon. A fresh ownership object and journal are used for each
    start. A cleanup failure ends the broker and prevents any later start.
    """
    last_id = 0
    while True:
        if stop_event.is_set() or request is EOF:
            return 0
        if request is None:
            request = reader.poll(0.1)
            continue
        if isinstance(request, dict) and request.get("command") == "stop":
            validate_reusable_request(request, command="stop", session_id=last_id)
            idle_output = _ReusableOutput(output, last_id)
            idle_output.write('{"event":"stopped"}\n')
            idle_output.flush()
            request = None
            continue
        endpoint = validate_reusable_request(request, command="start", normalize_bypass=normalize_bypass)
        session_id = request["id"]
        if session_id <= last_id:
            raise HelperError("全局接管启动会话编号已使用或顺序无效。")
        last_id = session_id
        session_reader = _ReusableReader(reader, session_id)
        session_output = _ReusableOutput(output, session_id)
        # Idle authorization retains no global network lock. Each activation
        # claims the lock before reading/recovering its root journal, and only
        # releases it after the session has finished its cleanup attempt.
        lock_fd = None
        try:
            lock_fd = _prepare_runtime()
            resources = RouteResources(ip_command)
            journal = SessionJournal(uid)
            journal.recover(resources)
            session = HelperSession(resources, session_reader, session_output,
                                    stop_event, build_config, journal=journal)
            result = session.run(endpoint)
        finally:
            if lock_fd is not None:
                os.close(lock_fd)
        if result:
            return result
        if session_reader.eof or session_reader.invalid or stop_event.is_set():
            return 0
        request = None


def main():
    os.umask(0o077)
    output = sys.stdout
    lock_fd = None
    reader = None
    may_have_changes = False
    try:
        if len(sys.argv) != 1:
            raise HelperError("全局接管助手不接受命令行参数。")
        uid = validate_invoker()
        validate_installation()
        config = _load_tun_config()
        normalize_bypass = config.normalize_bypass_addresses
        ip_command = find_ip_command()
        stop_event = threading.Event()
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, lambda *_: stop_event.set())
        reader = MessageReader(sys.stdin.fileno())
        deadline = time.monotonic() + 10
        request = None
        while request is None:
            if stop_event.is_set() or time.monotonic() >= deadline:
                raise HelperError("未收到有效的 全局接管启动请求。")
            request = reader.poll(0.1)
            if request is EOF:
                output.write('{"event":"stopped"}\n')
                output.flush()
                return 0
        recovery_only = is_recovery_request(request)
        reusable = (isinstance(request, dict) and type(request.get("version")) is int
                    and request["version"] == 3)
        if reusable:
            validate_reusable_request(request, command="start", normalize_bypass=normalize_bypass)
        endpoint = None if recovery_only or reusable else validate_request(request, normalize_bypass=normalize_bypass)
        if reusable:
            may_have_changes = True
            return run_reusable_sessions(request, uid=uid, ip_command=ip_command,
                                         reader=reader, output=output, stop_event=stop_event,
                                         build_config=config.build_config, normalize_bypass=normalize_bypass)
        lock_fd = _prepare_runtime()
        resources = RouteResources(ip_command)
        journal = SessionJournal(uid)
        may_have_changes = True
        journal.recover(resources)
        if recovery_only:
            output.write('{"event":"stopped"}\n')
            output.flush()
            return 0
        session = HelperSession(resources, reader, output, stop_event, config.build_config, journal=journal)
        return session.run(endpoint)
    except Exception as error:
        try:
            message = str(error) if isinstance(error, HelperError) else "全局接管助手检查失败，未接管网络。"
            output.write(json.dumps({"event": "error", "message": message}, ensure_ascii=True) + "\n")
            if not may_have_changes:
                output.write('{"event":"stopped"}\n')
            output.flush()
        except (OSError, ValueError):
            pass
        return 1 if may_have_changes else 0
    finally:
        if reader is not None:
            reader.close()
        if lock_fd is not None:
            os.close(lock_fd)


if __name__ == "__main__":
    raise SystemExit(main())
