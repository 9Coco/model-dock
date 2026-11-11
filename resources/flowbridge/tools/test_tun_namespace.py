#!/usr/bin/env python3
"""Run real sing-box TUN checks inside disposable Linux namespaces only.

Invoke as a normal user: python3 tools/test_tun_namespace.py --launch --core PATH
The script refuses the host's network, user or mount namespace. It creates an isolated
underlay and a second isolated client namespace, never a host route or proxy.
All TCP targets, UDP echo endpoints and the TLS DoH server are local test
doubles, reached through a standard SOCKS5 CONNECT/UDP ASSOCIATE mock phone.
Production TLS verification stays enabled; the test trusts one temporary cert.
"""

import argparse
import base64
import ctypes
import http.client
import ipaddress
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import signal
import socket
import socketserver
import ssl
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "linux"))
from tun_config import (CORE_VERSION, DOH_SERVER_NAME, INTERFACE_NAME, ROUTE_TABLE,
                        RULE_INDEX, RULE_LAST, build_config, normalize_bypass_addresses)

HOST_INTERFACE = "fb-host"
CLIENT_INTERFACE = "fb-uplink"
HOST4, CLIENT4 = "10.77.0.1", "10.77.0.2"
HOST6, CLIENT6 = "fd77:73fb::1", "fd77:73fb::2"
TARGET4, TARGET6 = "198.51.100.7", "2001:db8::7"
DIRECT4, DIRECT6 = "198.51.100.8", "2001:db8::8"
UDP_PORT = 49273
ANSWER = "203.0.113.77"
PAYLOAD = b"flowbridge-netns-ok"
UDP_REPLY_PREFIX = b"from-phone-udp:"


def launch_isolated(core):
    if os.geteuid() == 0:
        raise RuntimeError("launch must run as a normal non-root user")
    origin = {name: os.readlink(f"/proc/self/ns/{name}") for name in ("net", "user", "mnt")}
    origin["uid"] = os.getuid()
    environment = os.environ.copy()
    environment["FLOWBRIDGE_TEST_ORIGIN_NS"] = json.dumps(origin)
    os.execvpe("unshare", ["unshare", "-Urnm", sys.executable, str(Path(__file__).resolve()),
                           "--core", str(core)], environment)


def ensure_isolated():
    if os.geteuid() != 0:
        raise RuntimeError("run this test as a normal user with --launch")
    try:
        origin = json.loads(os.environ["FLOWBRIDGE_TEST_ORIGIN_NS"])
        origin_uid = origin["uid"]
        if isinstance(origin_uid, bool) or not isinstance(origin_uid, int) or origin_uid <= 0:
            raise ValueError("invalid launching uid")
        mappings = [tuple(map(int, line.split())) for line in Path("/proc/self/uid_map").read_text().splitlines()]
        if mappings != [(0, origin_uid, 1)]:
            raise ValueError("expected a single uid mapping from the normal launching user")
        for name in ("net", "user", "mnt"):
            current = os.readlink(f"/proc/self/ns/{name}")
            if not isinstance(origin[name], str) or current == origin[name]:
                raise ValueError("namespace was not isolated: " + name)
            # User namespaces can deny access to PID 1's namespace descriptors.
            # In that case the mandatory pre-unshare origin and uid_map checks
            # above still prove isolation; this is not an unchecked fallback.
            try:
                pid1 = os.readlink(f"/proc/1/ns/{name}")
            except PermissionError:
                pid1 = None
            if pid1 == current:
                raise ValueError("still sharing PID 1's namespace: " + name)
    except (KeyError, TypeError, ValueError, OSError):
        raise RuntimeError("namespace safety checks failed; start as a normal user with --launch") from None


def ip(*args, allow_missing=False):
    completed = subprocess.run(["ip", *args], capture_output=True, text=True, timeout=5)
    if completed.returncode and not allow_missing:
        raise RuntimeError("isolated ip command failed: " + " ".join(args))
    return completed


def ip_json(*args, allow_missing=False):
    output = ip("-N", "-j", *args, allow_missing=allow_missing)
    if output.returncode and not output.stdout.strip():
        return []
    return json.loads(output.stdout or "[]")


def read_headers(sock):
    header = bytearray()
    while not header.endswith(b"\r\n\r\n"):
        part = sock.recv(1)
        if not part:
            raise EOFError("incomplete local test headers")
        header.extend(part)
        if len(header) > 16384:
            raise ValueError("local test headers exceed limit")
    return bytes(header)


def read_exact(sock, size):
    if not 0 <= size <= 65536:
        raise ValueError("local test body exceeds limit")
    result = bytearray()
    while len(result) < size:
        part = sock.recv(size - len(result))
        if not part:
            raise EOFError("incomplete local test body")
        result.extend(part)
    return bytes(result)


def dns_reply(query):
    if len(query) < 17 or struct.unpack("!H", query[4:6])[0] != 1:
        raise ValueError("unexpected DNS test query")
    index = 12
    while query[index]:
        length = query[index]
        if length > 63 or index + 1 + length >= len(query):
            raise ValueError("invalid test DNS question")
        index += 1 + length
    end = index + 5
    qtype = struct.unpack("!H", query[index + 1:index + 3])[0]
    question = query[12:end]
    if qtype == 1:
        address, answer_type = ipaddress.IPv4Address(ANSWER).packed, 1
    elif qtype == 28:
        address, answer_type = ipaddress.IPv6Address("2001:db8::77").packed, 28
    else:
        return query[:2] + struct.pack("!HHHHH", 0x8180, 1, 0, 0, 0) + question
    header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, 1, 0, 0)
    answer = b"\xc0\x0c" + struct.pack("!HHIH", answer_type, 1, 30, len(address)) + address
    return header + question + answer


def socks_address(host, port):
    address = ipaddress.ip_address(host)
    return bytes([1 if address.version == 4 else 4]) + address.packed + struct.pack("!H", port)


def read_socks_address(sock, kind):
    if kind in (1, 4):
        host = str(ipaddress.ip_address(read_exact(sock, 4 if kind == 1 else 16)))
    elif kind == 3:
        host = read_exact(sock, read_exact(sock, 1)[0]).decode("ascii")
    else:
        raise ValueError("unexpected SOCKS address type")
    return host, struct.unpack("!H", read_exact(sock, 2))[0]


def decode_socks_udp(data):
    if len(data) < 7 or data[:3] != b"\0\0\0":
        raise ValueError("invalid or fragmented SOCKS5 UDP packet")
    kind, offset = data[3], 4
    if kind in (1, 4):
        size = 4 if kind == 1 else 16
        if len(data) < offset + size + 2:
            raise ValueError("truncated SOCKS UDP address")
        host = str(ipaddress.ip_address(data[offset:offset + size]))
        offset += size
    elif kind == 3:
        size, offset = data[offset], offset + 1
        if not size or len(data) < offset + size + 2:
            raise ValueError("truncated SOCKS UDP hostname")
        host = data[offset:offset + size].decode("ascii")
        offset += size
    else:
        raise ValueError("unexpected SOCKS UDP address type")
    port = struct.unpack("!H", data[offset:offset + 2])[0]
    return (host, port), data[offset + 2:]


def display_target(host, port):
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


class FakeProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, context):
        self.context = context
        self.lock = threading.Lock()
        self.targets = []
        self.udp_targets = []
        self.udp_associations = 0
        self.udp_forwarded_bytes = 0
        self.udp_reply_bytes = 0
        self.doh_requests = 0
        self.sni_names = []
        super().__init__((HOST4, 0), FakeProxyHandler)
        context.set_servername_callback(self.record_sni)
        self.thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def record_sni(self, sock, name, context):
        with self.lock:
            self.sni_names.append(name)

    def snapshot(self):
        with self.lock:
            return {"connect_targets": list(self.targets), "doh_requests": self.doh_requests,
                    "sni_names": list(self.sni_names), "udp_targets": list(self.udp_targets),
                    "udp_associations": self.udp_associations,
                    "udp_forwarded_bytes": self.udp_forwarded_bytes,
                    "udp_reply_bytes": self.udp_reply_bytes}

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=1)

    def handle_error(self, request, client_address):
        pass


class FakeProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            version, count = read_exact(self.request, 2)
            if version != 5 or 0 not in read_exact(self.request, count):
                raise ValueError("test proxy requires unauthenticated standard SOCKS5")
            self.request.sendall(b"\5\0")
            version, command, reserved, kind = read_exact(self.request, 4)
            if version != 5 or reserved != 0:
                raise ValueError("invalid SOCKS5 request")
            target = read_socks_address(self.request, kind)
            if command == 3:
                self.udp_associate()
                return
            if command != 1:
                raise ValueError("unexpected SOCKS5 command")
            with self.server.lock:
                self.server.targets.append(display_target(*target))
            if target not in ((TARGET4, 80), (TARGET6, 80), ("1.1.1.1", 443)):
                self.request.sendall(b"\5\2\0" + socks_address(HOST4, 0))
                return
            self.request.sendall(b"\5\0\0" + socks_address(HOST4, self.server.server_address[1]))
            if target == ("1.1.1.1", 443):
                with self.server.context.wrap_socket(self.request, server_side=True) as secured:
                    self.doh(secured)
            else:
                read_headers(self.request)
                self.request.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(PAYLOAD)).encode()
                    + b"\r\nConnection: close\r\n\r\n" + PAYLOAD
                )
        except (OSError, EOFError, ValueError):
            pass

    def udp_associate(self):
        # RFC 1928: keep the control TCP connection alive for this association,
        # accept UDP only from its peer IP, and return standard framed replies.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as relay:
            relay.bind((HOST4, 0))
            self.request.sendall(b"\5\0\0" + socks_address(HOST4, relay.getsockname()[1]))
            with self.server.lock:
                self.server.udp_associations += 1
            while True:
                ready, _, _ = select.select([self.request, relay], [], [], 0.2)
                if self.request in ready:
                    if not self.request.recv(1):
                        return
                    raise ValueError("unexpected SOCKS UDP control payload")
                if relay not in ready:
                    continue
                data, client = relay.recvfrom(65535)
                if client[0] != self.client_address[0]:
                    continue
                target, payload = decode_socks_udp(data)
                host, port = target
                if host not in (TARGET4, TARGET6, HOST4, HOST6) or port != UDP_PORT:
                    continue
                family = socket.AF_INET6 if ":" in host else socket.AF_INET
                backend_host = HOST6 if family == socket.AF_INET6 else HOST4
                with socket.socket(family, socket.SOCK_DGRAM) as forwarded:
                    forwarded.settimeout(2)
                    forwarded.bind((backend_host, 0))
                    forwarded.sendto(payload, (backend_host, UDP_PORT))
                    reply, _ = forwarded.recvfrom(65535)
                with self.server.lock:
                    self.server.udp_targets.append(display_target(*target))
                    self.server.udp_forwarded_bytes += len(payload)
                    self.server.udp_reply_bytes += len(reply)
                relay.sendto(b"\0\0\0" + socks_address(*target) + reply, client)

    def doh(self, sock):
        header = read_headers(sock).decode("iso-8859-1")
        lines = header.split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        headers = {line.partition(":")[0].lower(): line.partition(":")[2].strip()
                   for line in lines[1:] if ":" in line}
        if method == "POST":
            query = read_exact(sock, int(headers.get("content-length", "0")))
        elif method == "GET":
            encoded = parse_qs(urlsplit(path).query)["dns"][0]
            query = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        else:
            raise ValueError("unexpected DoH method")
        response = dns_reply(query)
        with self.server.lock:
            self.server.doh_requests += 1
        sock.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/dns-message\r\nContent-Length: "
            + str(len(response)).encode() + b"\r\nConnection: close\r\n\r\n" + response
        )


class UDPSpy:
    def __init__(self, host, port, *, echo=False):
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        self.sock = socket.socket(family, socket.SOCK_DGRAM)
        self.sock.bind((host, port))
        self.sock.settimeout(0.05)
        self.count = 0
        self.echo = echo
        self.host = host
        self.direct_count = 0
        self.sources = []
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self.receive, daemon=True)
        self.thread.start()

    def receive(self):
        while not self.stopping.is_set():
            try:
                data, source = self.sock.recvfrom(65535)
                self.count += 1
                self.sources.append(source[0])
                # Only the mock phone itself may reach the echo origin. A
                # client bypass would carry CLIENT4/6 as its underlay source.
                if not self.echo or source[0] != self.host:
                    self.direct_count += 1
                if self.echo:
                    self.sock.sendto(UDP_REPLY_PREFIX + data, source)
            except socket.timeout:
                pass
            except OSError:
                break

    def close(self):
        self.stopping.set()
        self.sock.close()
        self.thread.join(timeout=1)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def api_snapshot(port, secret):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.5)
    try:
        connection.request("GET", "/connections", headers={"Authorization": "Bearer " + secret})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError("core API did not accept the test secret")
        return json.loads(response.read(256 * 1024))
    finally:
        connection.close()


def assert_clean():
    links = ip_json("link", "show")
    if any(row.get("ifname") == INTERFACE_NAME for row in links):
        raise AssertionError("TUN interface remained after core exit")
    for family in ("-4", "-6"):
        rules = ip_json(family, "rule", "show")
        if any(RULE_INDEX <= row.get("priority", -1) <= RULE_LAST for row in rules):
            raise AssertionError("owned routing rules remained after core exit")
        if ip_json(family, "route", "show", "table", str(ROUTE_TABLE), allow_missing=True):
            raise AssertionError("owned route table remained after core exit")


def assert_allowlist_routes():
    devices = {}
    for family, direct, captured in (("-4", DIRECT4, TARGET4), ("-6", DIRECT6, TARGET6)):
        for target, expected in ((direct, CLIENT_INTERFACE), (captured, INTERFACE_NAME)):
            routes = ip_json(family, "route", "get", target)
            device = routes[0].get("dev") if routes else None
            if device != expected:
                raise AssertionError(f"{target} selected {device}; expected {expected}")
            devices[target] = device
    return devices


def resource_snapshot():
    resources = {}
    for family in ("-4", "-6"):
        resources["rules" + family[-1]] = [row for row in ip_json(family, "rule", "show")
            if RULE_INDEX <= row.get("priority", -1) <= RULE_LAST]
        routes = ip_json(family, "route", "show", "table", str(ROUTE_TABLE), allow_missing=True)
        resources["routes" + family[-1]] = routes
        resources["route_summary" + family[-1]] = {
            "count": len(routes), "devices": sorted({row.get("dev", "") for row in routes}),
            "types": sorted({row.get("type", "unicast") for row in routes}),
            "sample": routes[:2],
        }
    resources["interface"] = [{key: row.get(key) for key in ("ifname", "ifindex")}
        for row in ip_json("link", "show") if row.get("ifname") == INTERFACE_NAME]
    return resources


def parent_death_signal():
    ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM)


def run_helper_sigkill(core, directory, initialization):
    """Exercise the production session/cleanup after an ungraceful core death.

    This bypasses installation/pkexec checks only: commands, ownership checks and
    cleanup all use the real helper. Forking the core happens in the main thread;
    the controller thread is created only after the ready event has been emitted.
    """
    import tun_helper

    runtime = directory / "helper-runtime"
    runtime.mkdir(mode=0o700)
    previous_core, previous_runtime = tun_helper.CORE_PATH, tun_helper.RUNTIME_DIR
    tun_helper.CORE_PATH, tun_helper.RUNTIME_DIR = core, runtime
    resources = tun_helper.RouteResources(shutil.which("ip") or "/usr/sbin/ip")
    stop_event = threading.Event()
    events, controller_result = [], {}
    controller = None
    session = None

    def test_config(*args, **kwargs):
        config = build_config(*args, **kwargs)
        config["dns"]["servers"][0]["tls"]["certificate_path"] = initialization["certificate"]
        return config

    class IdleReader:
        def poll(self, timeout):
            return None

    def control_after_ready():
        try:
            controller_result["active_resources"] = resource_snapshot()
            # Ordinary application traffic must reach the same mock proxy even
            # when the core is managed by the real privileged helper session.
            connection = http.client.HTTPConnection(TARGET4, 80, timeout=4)
            try:
                connection.request("GET", "/helper-lifecycle", headers={"Connection": "close"})
                response = connection.getresponse()
                if response.status != 200 or response.read(4096) != PAYLOAD:
                    raise AssertionError("helper-managed TUN payload mismatch")
            finally:
                connection.close()
            controller_result["ipv4_tcp"] = True
            session.process.kill()
            session.process.wait(timeout=4)
            controller_result["core_returncode"] = session.process.returncode
        except Exception as exc:
            controller_result["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            # Also release run() on a failed payload assertion without asking
            # the core to clean its own rules via graceful termination.
            if session.process is not None and session.process.poll() is None:
                session.process.kill()

    class ProtocolOutput:
        def write(self, line):
            nonlocal controller
            message = json.loads(line)
            # API secrets stay inside this process and are never test output.
            events.append({key: message[key] for key in ("event", "message") if key in message})
            if message.get("event") == "ready":
                if controller is not None:
                    raise AssertionError("helper emitted ready more than once")
                controller = threading.Thread(target=control_after_ready, name="helper-test-controller", daemon=True)
                controller.start()

        def flush(self):
            pass

    try:
        session = tun_helper.HelperSession(resources, IdleReader(), ProtocolOutput(),
                                          stop_event, test_config)
        status = session.run(SimpleNamespace(host=HOST4, port=initialization["proxy_port"]))
        if controller is not None:
            controller.join(timeout=5)
            if controller.is_alive():
                raise TimeoutError("helper test controller did not finish")
        if controller is None:
            raise AssertionError("real helper never became ready: " + json.dumps(events, ensure_ascii=False))
        if "error" in controller_result:
            raise AssertionError(controller_result["error"])
        if controller_result.get("core_returncode") != -signal.SIGKILL:
            raise AssertionError("helper test core was not killed with SIGKILL")
        if status != 0 or not events or events[-1]["event"] != "stopped":
            remaining = {f"rules{family}": resources.rules(family) for family in (4, 6)}
            raise AssertionError("helper did not confirm cleanup: " + json.dumps(
                {"events": events, "remaining_rules": remaining}, ensure_ascii=False))
        if not any(event.get("event") == "error" and "意外退出" in event.get("message", "") for event in events):
            raise AssertionError("helper did not report the unexpected core exit")
        assert_clean()
        if resources.claimed:
            raise AssertionError("helper still claimed routing resources after cleanup")
        return {"ready": True, **controller_result, "events": events,
                "helper_exit_status": status, "sigkill_cleanup": True}
    finally:
        stop_event.set()
        if session is not None and session.process is not None and session.process.poll() is None:
            session.process.kill()
            session.process.wait(timeout=4)
        tun_helper.CORE_PATH, tun_helper.RUNTIME_DIR = previous_core, previous_runtime


def run_journal_helper(core):
    """Test-only executable wrapper around the production fixed IPC entry point.

    The disposable namespace has no installed /opt application or pkexec caller.
    Substitute those two installation facts, but keep the actual IPC validation,
    runtime permissions/lock, journal persistence and recovery implementation.
    """
    ensure_isolated()
    import tun_helper

    certificate = os.environ["FLOWBRIDGE_TEST_CERTIFICATE"]
    uid = json.loads(os.environ["FLOWBRIDGE_TEST_ORIGIN_NS"])["uid"]

    def test_config(*args, **kwargs):
        config = build_config(*args, **kwargs)
        config["dns"]["servers"][0]["tls"]["certificate_path"] = certificate
        return config

    def private_run_path(path, *, executable=False, directory=False):
        # Host root is unmapped in this user namespace. Start at the root-owned
        # private tmpfs /run, preserving the production checks on every journal
        # component; never weaken the installed helper's actual path checker.
        path = Path(path)
        if not path.is_absolute() or not path.is_relative_to("/run") or ".." in path.parts:
            raise tun_helper.HelperError("test wrapper only permits private /run paths")
        components = [Path("/run")]
        for part in path.relative_to("/run").parts:
            components.append(components[-1] / part)
        for component in components:
            info = component.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise tun_helper.HelperError("private test runtime permissions are unsafe")
            if component != path and not stat.S_ISDIR(info.st_mode):
                raise tun_helper.HelperError("private test runtime contains a non-directory")
        info = path.lstat()
        valid = stat.S_ISDIR(info.st_mode) if directory else (
            stat.S_ISREG(info.st_mode) and (not executable or bool(info.st_mode & 0o111)))
        if not valid:
            raise tun_helper.HelperError("private test runtime file type is invalid")
        return path

    tun_helper.CORE_PATH = core
    tun_helper.validate_invoker = lambda: uid
    tun_helper.validate_installation = lambda: None
    tun_helper._load_tun_config = lambda: SimpleNamespace(build_config=test_config,
                                                         normalize_bypass_addresses=normalize_bypass_addresses)
    tun_helper.find_ip_command = lambda: shutil.which("ip") or "/usr/sbin/ip"
    tun_helper.require_root_path = private_run_path
    # Production main rejects all command-line arguments. The wrapper's flags
    # were already checked above and are never forwarded to that entry point.
    sys.argv = [sys.argv[0]]
    return tun_helper.main()


def run_journal_recovery(core, initialization):
    """Kill a real helper, then recover its root-private journal over fixed IPC."""
    import tun_helper

    if tun_helper.RUNTIME_DIR != Path("/run/modeldock-network"):
        raise AssertionError("journal test requires the production private /run path")
    if Path("/run/dbus/system_bus_socket").exists():
        raise AssertionError("journal test can see the host system bus")
    journal_path = tun_helper.RUNTIME_DIR / "session.json"
    if journal_path.exists():
        raise AssertionError("journal test must start without an existing session")
    environment = os.environ.copy()
    environment["FLOWBRIDGE_TEST_CERTIFICATE"] = initialization["certificate"]
    command = [sys.executable, str(Path(__file__).resolve()), "--journal-helper", "--core", str(core)]
    old_helper = None
    core_pid = None
    core_start = None
    try:
        old_helper = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, env=environment)
        old_helper.stdin.write(json.dumps({"version": 2, "host": HOST4,
                                          "port": initialization["proxy_port"],
                                          "bypassAddresses": [DIRECT4, DIRECT6]}) + "\n")
        old_helper.stdin.flush()
        ready = read_child_line(old_helper, 22)
        if ready.get("event") != "ready":
            raise AssertionError("journaled helper did not become ready: " + json.dumps(
                {key: ready[key] for key in ("event", "message") if key in ready}, ensure_ascii=False))
        allowlist_routes = assert_allowlist_routes()
        value = json.loads(journal_path.read_text())
        if value.get("ifindex") is None or not isinstance(value.get("ownership"), dict):
            raise AssertionError("ready journal did not persist interface ownership")
        core_pid = value["core_pid"]
        core_start = value["core_start"]
        work_dir = Path(value["work_dir"])
        if value["helper_pid"] != old_helper.pid or not tun_helper.process_start_time(core_pid):
            raise AssertionError("journal process identities do not match the live session")
        journal_counts = {key: len(rows) for key, rows in value["ownership"].items()}
        if any(not count for count in journal_counts.values()):
            raise AssertionError("ready journal has an empty ownership snapshot")
        if journal_path.stat().st_mode & 0o077 or tun_helper.RUNTIME_DIR.stat().st_mode & 0o077:
            raise AssertionError("production journal or runtime is not private")
        connection = http.client.HTTPConnection(TARGET4, 80, timeout=4)
        try:
            connection.request("GET", "/journal-session", headers={"Connection": "close"})
            response = connection.getresponse()
            if response.status != 200 or response.read(4096) != PAYLOAD:
                raise AssertionError("journaled helper-managed TUN payload mismatch")
        finally:
            connection.close()
        old_helper.kill()
        old_helper.wait(timeout=4)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            alive = tun_helper.process_start_time(core_pid) is not None
            links = ip_json("link", "show")
            if not alive and not any(row.get("ifname") == INTERFACE_NAME for row in links):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("core did not exit after its helper was killed")
        before = resource_snapshot()
        if not before["rules4"] or not before["rules6"] or not journal_path.exists():
            raise AssertionError("helper death did not leave the expected recoverable rules and journal")
        recovered = subprocess.run(command, input='{"version":1,"command":"recover"}\n',
                                   capture_output=True, text=True, env=environment, timeout=15)
        events = [json.loads(line) for line in recovered.stdout.splitlines() if line.strip()]
        if recovered.returncode != 0 or events != [{"event": "stopped"}]:
            safe_events = [{key: event[key] for key in ("event", "message") if key in event} for event in events]
            raise AssertionError("recovery-only IPC failed: " + json.dumps(safe_events, ensure_ascii=False))
        assert_clean()
        if journal_path.exists() or work_dir.exists():
            raise AssertionError("recovery left the journal or private session workspace behind")
        return {"ready": True, "ipv4_tcp": True, "helper_returncode": old_helper.returncode,
                "direct_allowlist_routes": allowlist_routes,
                "core_exited_on_helper_death": True, "journal_ownership_counts": journal_counts,
                "resources_before_recovery": before, "recovery_events": events,
                "journal_removed": True, "workspace_removed": True, "recovery_cleanup": True}
    finally:
        if old_helper is not None:
            if old_helper.poll() is None:
                old_helper.kill()
                old_helper.wait(timeout=4)
            for stream in (old_helper.stdin, old_helper.stdout, old_helper.stderr):
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
        # The real core's PDEATHSIG is SIGKILL. No core can be left alive if a
        # failing assertion interrupts the controller after helper termination.
        if core_pid is not None and core_start is not None and tun_helper.process_start_time(core_pid) == core_start:
            os.kill(core_pid, signal.SIGKILL)


def run_child(core):
    ensure_isolated()
    print(json.dumps({"event": "waiting", "pid": os.getpid()}), flush=True)
    initialization = json.loads(sys.stdin.readline())
    process = None
    checks = {}
    error = None
    with tempfile.TemporaryDirectory(prefix="flowbridge-tun-client-") as temporary:
        directory = Path(temporary)
        try:
            ip("link", "set", "lo", "up")
            ip("link", "set", CLIENT_INTERFACE, "up")
            ip("addr", "add", CLIENT4 + "/30", "dev", CLIENT_INTERFACE)
            ip("-6", "addr", "add", CLIENT6 + "/64", "dev", CLIENT_INTERFACE, "nodad")
            ip("route", "add", "default", "via", HOST4, "dev", CLIENT_INTERFACE)
            ip("-6", "route", "add", "default", "via", HOST6, "dev", CLIENT_INTERFACE)
            assert_clean()
            api_port, proxy_port = free_port(), free_port()
            while proxy_port == api_port:
                proxy_port = free_port()
            secret = secrets.token_urlsafe(32)
            config = build_config(SimpleNamespace(host=HOST4, port=initialization["proxy_port"]),
                                  CLIENT_INTERFACE, api_port, secret, proxy_port=proxy_port)
            config["dns"]["servers"][0]["tls"]["certificate_path"] = initialization["certificate"]
            config_path = directory / "config.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            config_path.chmod(0o600)
            environment = os.environ.copy()
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
                        "all_proxy", "no_proxy", "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS"):
                environment.pop(key, None)
            with (directory / "core.stderr").open("wb") as log:
                process = subprocess.Popen([str(core), "run", "-c", str(config_path)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                    env=environment, preexec_fn=parent_death_signal)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        detail = (directory / "core.stderr").read_text(encoding="utf-8", errors="replace")
                        detail = detail.replace(secret, "[redacted]").strip()[-1000:]
                        raise RuntimeError("real core exited before API became ready: " + detail)
                    try:
                        api_snapshot(api_port, secret)
                        break
                    except (OSError, ValueError, RuntimeError):
                        time.sleep(0.05)
                else:
                    raise TimeoutError("real core API did not become ready")
                links = ip_json("link", "show")
                if not any(row.get("ifname") == INTERFACE_NAME for row in links):
                    raise AssertionError("core API ready without a TUN interface")
                checks["real_tun_created"] = True
                checks["active_resources"] = resource_snapshot()
                for target, name in ((TARGET4, "ipv4_tcp"), (TARGET6, "ipv6_tcp")):
                    connection = http.client.HTTPConnection(target, 80, timeout=4)
                    try:
                        connection.request("GET", "/namespace-test", headers={"Connection": "close"})
                        response = connection.getresponse()
                        if response.status != 200 or response.read(4096) != PAYLOAD:
                            raise AssertionError(name + " payload mismatch")
                        checks[name] = True
                    finally:
                        connection.close()
                connection = http.client.HTTPConnection("127.0.0.1", proxy_port, timeout=4)
                try:
                    connection.request("HEAD", f"http://{TARGET4}/test-inbound", headers={"Connection": "close"})
                    response = connection.getresponse()
                    if response.status != 200:
                        raise AssertionError("loopback test HTTP inbound failed during TUN operation")
                    checks["loopback_test_inbound"] = True
                finally:
                    connection.close()
                question = b"".join(bytes([len(label)]) + label for label in (b"flowbridge-test", b"invalid")) + b"\0"
                query = struct.pack("!HHHHHH", 0x4827, 0x0100, 1, 0, 0, 0) + question + struct.pack("!HH", 1, 1)
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as dns:
                    dns.settimeout(4)
                    dns.sendto(query, (HOST4, 53))
                    reply, _ = dns.recvfrom(4096)
                if reply[:2] != query[:2] or not reply.endswith(ipaddress.IPv4Address(ANSWER).packed):
                    raise AssertionError("proxied DoH did not return the fake test A record")
                checks["dns53_through_verified_doh"] = True
                # The fake DoH server offers AAAA records. The real core must
                # suppress them for ordinary applications without disabling
                # the IPv6 literal TCP/UDP paths exercised above and below.
                query6 = struct.pack("!HHHHHH", 0x4828, 0x0100, 1, 0, 0, 0) + question + struct.pack("!HH", 28, 1)
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as dns:
                    dns.settimeout(4)
                    dns.sendto(query6, (HOST4, 53))
                    reply6, _ = dns.recvfrom(4096)
                if len(reply6) < 12:
                    raise AssertionError("AAAA suppression returned a truncated DNS header")
                response_id, flags, questions, answers, _, _ = struct.unpack("!HHHHHH", reply6[:12])
                if response_id != 0x4828 or not flags & 0x8000 or flags & 0x000f or questions != 1 or answers != 0:
                    raise AssertionError("session DNS must return NOERROR with no AAAA answers")
                checks["dns_aaaa_suppressed_with_ipv6_literal_forwarding_retained"] = True
                udp_results = {}
                for target in (TARGET4, HOST4, TARGET6, HOST6):
                    family = socket.AF_INET6 if ":" in target else socket.AF_INET
                    with socket.socket(family, socket.SOCK_DGRAM) as udp:
                        udp.settimeout(4)
                        udp.connect((target, UDP_PORT))
                        payload = b"udp-through-phone:" + target.encode("ascii")
                        udp.send(payload)
                        reply = udp.recv(4096)
                        if reply != UDP_REPLY_PREFIX + payload:
                            raise AssertionError("proxied UDP payload mismatch for " + target)
                        udp_results[target] = {"sent_bytes": len(payload), "received_bytes": len(reply)}
                checks["ipv4_ipv6_udp_through_socks5"] = udp_results
                stats = api_snapshot(api_port, secret)
                up, down = int(stats.get("uploadTotal", 0)), int(stats.get("downloadTotal", 0))
                if up <= 0 or down <= 0:
                    raise AssertionError("core API did not count both traffic directions")
                checks["api_traffic"] = {"upload_bytes": up, "download_bytes": down}
                process.terminate()
                process.wait(timeout=5)
                process = None
            assert_clean()
            checks["sigterm_cleanup"] = True
            checks["helper_lifecycle"] = run_helper_sigkill(core, directory, initialization)
            checks["journal_recovery"] = run_journal_recovery(core, initialization)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            try:
                assert_clean()
            except Exception as exc:
                error = (error + "; " if error else "") + "cleanup: " + str(exc)
    return {"ok": error is None, "checks": checks, "error": error}


def read_child_line(process, timeout):
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise TimeoutError("isolated child did not report in time")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("isolated child exited before reporting")
    return json.loads(line)


def run_parent(core):
    ensure_isolated()
    # AF_UNIX system-bus and resolved sockets are not isolated by netns alone.
    # Make mounts private before hiding /run so no mount can propagate to host.
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, capture_output=True, timeout=5)
    subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755", "tmpfs", "/run"],
                   check=True, capture_output=True, timeout=5)
    version = subprocess.run([str(core), "version"], capture_output=True, text=True, check=True, timeout=5)
    if f"sing-box version {CORE_VERSION}\n" not in version.stdout:
        raise RuntimeError("the namespace test requires the pinned core version")
    child = None
    proxy = None
    spies = []
    try:
        ip("link", "set", "lo", "up")
        ip("link", "add", HOST_INTERFACE, "type", "veth", "peer", "name", CLIENT_INTERFACE)
        ip("link", "set", HOST_INTERFACE, "up")
        ip("addr", "add", HOST4 + "/30", "dev", HOST_INTERFACE)
        ip("-6", "addr", "add", HOST6 + "/64", "dev", HOST_INTERFACE, "nodad")
        with tempfile.TemporaryDirectory(prefix="flowbridge-tun-test-ca-") as temporary:
            certificate, key = Path(temporary) / "cert.pem", Path(temporary) / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                            "-subj", "/CN=" + DOH_SERVER_NAME, "-addext", "subjectAltName=DNS:" + DOH_SERVER_NAME,
                            "-keyout", str(key), "-out", str(certificate)],
                           capture_output=True, check=True, timeout=15)
            key.chmod(0o600)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certificate, key)
            context.set_alpn_protocols(["http/1.1"])
            proxy = FakeProxy(context)
            for host in (HOST4, HOST6):
                for port in (53, UDP_PORT):
                    spies.append(UDPSpy(host, port, echo=port == UDP_PORT))
            child = subprocess.Popen(["unshare", "--net", sys.executable, str(Path(__file__).resolve()),
                                      "--child", "--core", str(core)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            waiting = read_child_line(child, 5)
            if waiting.get("event") != "waiting":
                raise RuntimeError("child did not enter its isolated network namespace")
            ip("link", "set", CLIENT_INTERFACE, "netns", str(child.pid))
            child.stdin.write(json.dumps({"proxy_port": proxy.server_address[1], "certificate": str(certificate)}) + "\n")
            child.stdin.flush()
            result = read_child_line(child, 60)
            child.stdin.close()
            child.wait(timeout=5)
            observations = proxy.snapshot()
            observations["direct_target_udp_packets"] = sum(spy.direct_count for spy in spies if spy.echo)
            observations["unproxied_dns_packets"] = sum(spy.count for spy in spies if not spy.echo)
            observations["udp_echo_packets"] = sum(spy.count for spy in spies if spy.echo)
            observations["udp_echo_sources"] = sorted({source for spy in spies if spy.echo for source in spy.sources})
            if observations["direct_target_udp_packets"] or observations["unproxied_dns_packets"]:
                result["ok"] = False
                result["error"] = "DNS or target UDP bypassed the SOCKS5 phone proxy"
            if result["ok"]:
                expected = {display_target(host, UDP_PORT) for host in (TARGET4, TARGET6, HOST4, HOST6)}
                if not expected.issubset(observations["udp_targets"]) or observations["udp_echo_packets"] < 4:
                    result["ok"] = False
                    result["error"] = "IPv4/IPv6 UDP did not traverse the standard SOCKS5 relay and echo origins"
            if result["ok"]:
                if observations["doh_requests"] < 1 or DOH_SERVER_NAME not in observations["sni_names"]:
                    result["ok"] = False
                    result["error"] = "DNS did not traverse the verified TLS mock DoH service"
            return {"ok": result["ok"], "core_version": CORE_VERSION,
                    "client": result, "underlay": observations}
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        for spy in spies:
            spy.close()
        if proxy is not None:
            proxy.close()
        ip("link", "delete", HOST_INTERFACE, allow_missing=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--launch", action="store_true", help="capture the normal user's namespaces, then enter unshare -Urnm")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--journal-helper", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        core = args.core.resolve(strict=True)
        if args.launch:
            if args.child or args.journal_helper:
                raise ValueError("--launch cannot be combined with internal child modes")
            launch_isolated(core)
        if args.journal_helper:
            if args.child:
                raise ValueError("internal child modes cannot be combined")
            return run_journal_helper(core)
        result = run_child(core) if args.child else run_parent(core)
    except Exception as exc:
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
