"""Separate system-path/explicit-proxy website checks and SOCKS5 probes.

For explicit proxy checks, HTTPS target names are sent in CONNECT and SNI;
only the proxy host can be resolved locally. System-path checks deliberately
use OS target DNS and ordinary sockets without reading proxy settings.
TLS verification stays enabled. A single wall-clock deadline
covers proxy DNS, TCP, CONNECT, TLS, response headers and up to three redirects.
GET requests read only response headers, then close the connection. Transient
failures get one retry within the total budget. No headers, cookies or bodies
are logged or included in user-facing errors; there is no direct fallback.
The global-mode probe additionally verifies SOCKS5 CONNECT and a UDP DNS round
trip, sending local traffic only to the verified phone proxy address.
"""

from dataclasses import dataclass, replace
import errno
import http.client
import ipaddress
import math
import queue
import secrets
import select
import socket
import ssl
import struct
import threading
import time
from urllib.parse import urljoin, urlsplit, urlunsplit


SITES = {
    "Google": "https://www.google.com/",
    "YouTube": "https://www.youtube.com/",
    "X": "https://x.com/",
    "GitHub": "https://github.com/",
    "ChatGPT": "https://chatgpt.com/",
    "Cloudflare": "https://www.cloudflare.com/",
}
_ALIASES = {"谷歌": "Google", "油管": "YouTube", "github": "GitHub", "chatgpt": "ChatGPT"}
_REDIRECTS = {301, 302, 303, 307, 308}
WEBSITE_TIMEOUT = 20
_WEBSITE_FIRST_ATTEMPT_TIMEOUT = 8


@dataclass(frozen=True)
class Result:
    name: str
    url: str
    status_code: int | None
    elapsed_ms: int
    ok: bool
    detail: str
    reachable: bool = False
    browser_verification: bool = False
    attempts: int = 1


def lookup_site(name_or_url: str) -> tuple[str, str] | None:
    """Look up a preset by name/alias or URL hostname, without doing DNS."""
    value = str(name_or_url).strip()
    for name, url in SITES.items():
        if value.casefold() == name.casefold() or _ALIASES.get(value.casefold()) == name:
            return name, url
    try:
        hostname = urlsplit(value).hostname
    except ValueError:
        return None
    if hostname:
        for name, url in SITES.items():
            if hostname.lower().removeprefix("www.") == urlsplit(url).hostname.removeprefix("www."):
                return name, url
    return None


class _URLProblem(ValueError):
    pass


def _parse_url(url: str):
    if not isinstance(url, str) or any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise _URLProblem("网站地址格式无效")
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise _URLProblem("网站地址须以 http:// 或 https:// 开头")
        if parsed.username is not None or parsed.password is not None:
            raise _URLProblem("测试地址不能包含用户名或密码")
        host = parsed.hostname
        if any(c in host for c in "\\@%"):
            raise _URLProblem("网站主机名格式无效")
        host = host.encode("idna").decode("ascii") if ":" not in host else host
        parsed_port = parsed.port
        port = parsed_port if parsed_port is not None else (443 if parsed.scheme == "https" else 80)
        if not 1 <= port <= 65535:
            raise _URLProblem("网站端口格式无效")
        authority = f"[{host}]" if ":" in host else host
        default_port = 443 if parsed.scheme == "https" else 80
        if port != default_port:
            authority += f":{port}"
        normalized = urlunsplit((parsed.scheme, authority, parsed.path or "/", parsed.query, ""))
        path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        return parsed.scheme, host, port, authority, normalized, path
    except (ValueError, UnicodeError) as exc:
        if isinstance(exc, _URLProblem):
            raise
        raise _URLProblem("网站地址或端口格式无效") from exc


class _TunnelError(OSError):
    def __init__(self, status):
        self.status = status
        super().__init__("proxy tunnel rejected")


class _CheckCancelled(Exception):
    pass


class CheckCancellation:
    """Cancel a group of checks synchronously, with no watcher thread.

    Registration and cancellation are serialized so a worker that starts late
    receives an already-cancelled deadline. Cancellation closes every active
    socket before returning; delayed OS DNS answers cannot open new sockets.
    A cancelled group is never reset or reused for a new test run.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._cancelled = threading.Event()
        self._deadlines = set()

    def is_set(self):
        return self._cancelled.is_set()

    def register(self, deadline):
        with self._lock:
            if self._cancelled.is_set():
                deadline.cancel()
            else:
                self._deadlines.add(deadline)

    def discard(self, deadline):
        with self._lock:
            self._deadlines.discard(deadline)

    def cancel(self):
        with self._lock:
            self._cancelled.set()
            deadlines = list(self._deadlines)
        for deadline in deadlines:
            deadline.cancel()


class _Deadline:
    def __init__(self, timeout: float):
        self.end = time.monotonic() + timeout
        self.expired = threading.Event()
        self.cancelled = threading.Event()
        self._lock = threading.Lock()
        self._sockets = set()
        self._finished = False
        self._timer = threading.Timer(timeout, self._expire)
        self._timer.daemon = True
        self._timer.start()

    @staticmethod
    def _close(sock):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()

    def _expire(self):
        with self._lock:
            if self._finished:
                return
            self.expired.set()
            sockets = list(self._sockets)
        for sock in sockets:
            self._close(sock)

    def remaining(self):
        if self.cancelled.is_set():
            raise _CheckCancelled()
        remaining = self.end - time.monotonic()
        if remaining <= 0 or self.expired.is_set():
            raise TimeoutError("total deadline expired")
        return remaining

    def track(self, sock):
        with self._lock:
            if self.cancelled.is_set():
                self._close(sock)
                raise _CheckCancelled()
            if self._finished or self.expired.is_set():
                self._close(sock)
                raise TimeoutError("total deadline expired")
            self._sockets.add(sock)
        return sock

    def _addresses(self, host, port):
        self.remaining()
        try:
            return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, flags=socket.AI_NUMERICHOST)
        except socket.gaierror:
            pass
        answer = queue.Queue(maxsize=1)

        def resolve():
            try:
                answer.put((socket.getaddrinfo(host, port, type=socket.SOCK_STREAM), None))
            except OSError as exc:
                answer.put((None, exc))

        # The OS resolver itself is not cancellable, but it owns no sockets and
        # cannot start a connection after the caller has timed out or cancelled.
        threading.Thread(target=resolve, name="flowbridge-check-dns", daemon=True).start()
        while True:
            try:
                addresses, error = answer.get(timeout=min(.05, self.remaining()))
                break
            except queue.Empty:
                self.remaining()
        self.remaining()
        if error:
            raise error
        return addresses

    def open_socket(self, address, timeout=None, source_address=None):
        self.remaining()
        host, port = address
        last_error = OSError("proxy has no usable address")
        for family, socktype, protocol, _, target in self._addresses(host, port):
            self.remaining()
            sock = self.track(socket.socket(family, socktype, protocol))
            try:
                sock.settimeout(self.remaining())
                if source_address:
                    sock.bind(source_address)
                sock.connect(target)
                self.remaining()
                return sock
            except OSError as exc:
                last_error = exc
                self._close(sock)
        raise last_error

    def cancel(self):
        self.cancelled.set()
        self.close()

    def close(self):
        with self._lock:
            self._finished = True
            sockets = list(self._sockets)
            self._sockets.clear()
        self._timer.cancel()
        for sock in sockets:
            self._close(sock)


class _WebsiteDeadline(_Deadline):
    """Race website TCP addresses without changing the global startup probes."""

    def __init__(self, timeout, address_offset=0):
        super().__init__(timeout)
        self.address_offset = address_offset

    def open_socket(self, address, timeout=None, source_address=None):
        addresses = list(dict.fromkeys(self._addresses(*address)))
        # Alternate address families, preserving the resolver's first choice.
        ordered = []
        while addresses:
            item = addresses.pop(0)
            ordered.append(item)
            other = next((i for i, candidate in enumerate(addresses) if candidate[0] != item[0]), None)
            if other is not None:
                ordered.append(addresses.pop(other))
        if self.address_offset and ordered:
            offset = self.address_offset % len(ordered)
            ordered = ordered[offset:] + ordered[:offset]
        pending = set()
        next_address = 0
        next_start = 0
        last_error = OSError('no usable address')
        in_progress = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR,
                       getattr(errno, 'WSAEWOULDBLOCK', 10035), getattr(errno, 'WSAEINPROGRESS', 10036)}
        try:
            while next_address < len(ordered) or pending:
                self.remaining()
                if next_address < len(ordered) and (not pending or time.monotonic() >= next_start):
                    family, socktype, protocol, _, target = ordered[next_address]
                    next_address += 1
                    sock = self.track(socket.socket(family, socktype, protocol))
                    pending.add(sock)
                    try:
                        sock.setblocking(False)
                        if source_address:
                            sock.bind(source_address)
                        code = sock.connect_ex(target)
                        if code == 0:
                            sock.settimeout(self.remaining())
                            pending.remove(sock)
                            return sock
                        if code not in in_progress:
                            raise OSError(code, 'connection failed')
                    except OSError as exc:
                        last_error = exc
                        pending.remove(sock)
                        self._close(sock)
                    next_start = time.monotonic() + .25
                if not pending:
                    continue
                delay = min(.05, self.remaining())
                if next_address < len(ordered):
                    delay = min(delay, max(0, next_start - time.monotonic()))
                _, writable, exceptional = select.select([], list(pending), list(pending), delay)
                self.remaining()
                for sock in set(writable + exceptional):
                    code = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                    if code == 0:
                        sock.settimeout(self.remaining())
                        pending.remove(sock)
                        return sock
                    last_error = OSError(code, 'connection failed')
                    pending.remove(sock)
                    self._close(sock)
            raise last_error
        finally:
            for sock in pending:
                self._close(sock)


class _ProxyHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, deadline):
        super().__init__(host, port, timeout=deadline.remaining())
        self._create_connection = deadline.open_socket


class _ProxyHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, target_host, target_port, deadline):
        super().__init__(host, port, timeout=deadline.remaining(), context=ssl.create_default_context())
        self._deadline = deadline
        self._target_host = target_host
        self._create_connection = deadline.open_socket
        self.set_tunnel(target_host, target_port)

    def _tunnel(self):
        # An explicit authority avoids unbracketed IPv6 CONNECT targets on older
        # Python versions. The hostname is sent to the proxy, never looked up here.
        host = f"[{self._tunnel_host}]" if ":" in self._tunnel_host else self._tunnel_host
        authority = f"{host}:{self._tunnel_port}"
        self.send(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode("ascii"))
        response = http.client.HTTPResponse(self.sock, method="CONNECT")
        try:
            response.begin()
            status = response.status
        finally:
            response.close()
        if status != 200:
            raise _TunnelError(status)

    def connect(self):
        # HTTPConnection creates the proxy socket and invokes our CONNECT method.
        http.client.HTTPConnection.connect(self)
        self.sock = self._context.wrap_socket(
            self.sock, server_hostname=self._target_host, do_handshake_on_connect=False
        )
        self._deadline.track(self.sock)
        self.sock.settimeout(self._deadline.remaining())
        self.sock.do_handshake()
        self._deadline.remaining()


class _SystemHTTPSConnection(http.client.HTTPSConnection):
    """Ordinary system DNS/TCP path, without any application proxy setting."""

    def __init__(self, host, port, deadline):
        super().__init__(host, port, timeout=deadline.remaining(), context=ssl.create_default_context())
        self._deadline = deadline
        self._create_connection = deadline.open_socket

    def connect(self):
        http.client.HTTPConnection.connect(self)
        self.sock = self._context.wrap_socket(
            self.sock, server_hostname=self.host, do_handshake_on_connect=False
        )
        self._deadline.track(self.sock)
        self.sock.settimeout(self._deadline.remaining())
        self.sock.do_handshake()
        self._deadline.remaining()


def _status_detail(status):
    if 200 <= status <= 399:
        return True, "连接正常"
    if status == 401:
        return False, "可到达，但站点要求登录（HTTP 401）"
    if status == 403:
        return False, "可到达，但站点拒绝请求（HTTP 403）"
    if status == 429:
        return False, "可到达，但站点正在限流（HTTP 429）"
    return False, f"可到达，但站点返回 HTTP {status}"


class _GlobalProbeError(OSError):
    pass


class GlobalProbeTransient(OSError):
    """Transport or target failure for which waiting for the upstream can help."""


class GlobalProbeTimeout(TimeoutError):
    """A global probe exhausted its transport or target deadline."""


class GlobalProbeTargetTimeout(GlobalProbeTimeout):
    """The SOCKS handshake succeeded but CONNECT to one specific target timed out."""


class GlobalProbeTargetRejected(GlobalProbeTransient):
    def __init__(self, target, reply):
        self.reply = reply
        super().__init__(f"手机 SOCKS5 无法连接 TCP 测试目标 {target}:443（状态 {reply}）；请检查手机 VPN 出口和目标可达性")


_GLOBAL_UPDATE = "请更新手机流桥代理脚本，启用 SOCKS5 和 UDP；旧版仅 HTTP 代理不能用于全局模式"


def _global_recv(sock, count, deadline):
    data = bytearray()
    while len(data) < count:
        sock.settimeout(deadline.remaining())
        block = sock.recv(count - len(data))
        if not block:
            raise _GlobalProbeError("手机 SOCKS5 响应不完整")
        data.extend(block)
    return bytes(data)


def _global_noauth(sock, deadline):
    sock.settimeout(deadline.remaining())
    sock.sendall(b"\x05\x01\x00")
    try:
        response = _global_recv(sock, 2, deadline)
    except _GlobalProbeError:
        raise _GlobalProbeError("手机代理未完成 SOCKS5 握手；" + _GLOBAL_UPDATE) from None
    if response != b"\x05\x00":
        raise _GlobalProbeError("手机代理未提供无认证 SOCKS5；" + _GLOBAL_UPDATE)


def _global_socks_reply(sock, deadline, *, udp=False, target="example.com"):
    version, reply, reserved, kind = _global_recv(sock, 4, deadline)
    if version != 5 or reserved != 0:
        raise _GlobalProbeError("手机 SOCKS5 响应格式无效；" + _GLOBAL_UPDATE)
    if reply:
        if udp:
            raise _GlobalProbeError("手机代理拒绝 UDP ASSOCIATE，不能开启全局模式；" + _GLOBAL_UPDATE)
        if 1 <= reply <= 6:
            raise GlobalProbeTargetRejected(target, reply)
        raise _GlobalProbeError(f"手机 SOCKS5 不支持所需的 TCP CONNECT 命令或地址类型，或返回未知状态（状态 {reply}）")
    if kind == 1:
        host = str(ipaddress.IPv4Address(_global_recv(sock, 4, deadline)))
    elif kind == 4:
        host = str(ipaddress.IPv6Address(_global_recv(sock, 16, deadline)))
    elif kind == 3:
        size = _global_recv(sock, 1, deadline)[0]
        if not size:
            raise _GlobalProbeError("手机 SOCKS5 返回空地址")
        try:
            host = _global_recv(sock, size, deadline).decode("ascii")
        except UnicodeError:
            raise _GlobalProbeError("手机 SOCKS5 返回无效地址") from None
    else:
        raise _GlobalProbeError("手机 SOCKS5 返回不支持的地址类型")
    port = struct.unpack("!H", _global_recv(sock, 2, deadline))[0]
    return host, port


def _global_ip(host):
    address = ipaddress.ip_address(host)
    return address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped else address


def _global_dns_name(packet, position):
    """Decode a bounded DNS name, rejecting pointer loops and truncation."""
    labels, seen, end = [], set(), None
    for _ in range(128):
        if position >= len(packet) or position in seen:
            raise ValueError("invalid DNS name")
        seen.add(position)
        size = packet[position]
        if size & 0xC0 == 0xC0:
            if position + 1 >= len(packet):
                raise ValueError("truncated DNS pointer")
            if end is None:
                end = position + 2
            position = ((size & 0x3F) << 8) | packet[position + 1]
        elif size & 0xC0:
            raise ValueError("invalid DNS label")
        else:
            position += 1
            if not size:
                return b".".join(labels).lower(), position if end is None else end
            if position + size > len(packet) or sum(map(len, labels)) + size > 253:
                raise ValueError("invalid DNS label length")
            labels.append(packet[position:position + size])
            position += size
    raise ValueError("too many DNS labels")


def _global_dns_reply(packet, transaction):
    if len(packet) < 12:
        return False
    identity, flags, questions, answers, _, _ = struct.unpack("!6H", packet[:12])
    if (identity != transaction or not flags & 0x8000 or flags & 0x7800
            or flags & 0x0200 or flags & 15 or questions != 1 or not 1 <= answers <= 128):
        return False
    try:
        name, position = _global_dns_name(packet, 12)
        if name != b"example.com" or packet[position:position + 4] != b"\x00\x01\x00\x01":
            return False
        position += 4
        found_address = False
        for _ in range(answers):
            _, position = _global_dns_name(packet, position)
            if position + 10 > len(packet):
                return False
            kind, group, _, size = struct.unpack("!HHIH", packet[position:position + 10])
            position += 10
            if position + size > len(packet):
                return False
            if kind == 1 and group == 1 and size == 4:
                found_address = True
            position += size
        return found_address
    except (ValueError, struct.error):
        return False


def _global_unwrap_dns(packet):
    if len(packet) < 4 or packet[:3] != b"\x00\x00\x00":
        raise _GlobalProbeError("手机 UDP 转发响应格式无效或使用了不支持的分片")
    kind, position = packet[3], 4
    try:
        if kind == 1:
            host = str(ipaddress.IPv4Address(packet[position:position + 4])); position += 4
        elif kind == 4:
            host = str(ipaddress.IPv6Address(packet[position:position + 16])); position += 16
        else:
            raise ValueError("unexpected DNS source type")
        port = struct.unpack("!H", packet[position:position + 2])[0]
    except (ValueError, struct.error):
        raise _GlobalProbeError("手机 UDP 转发响应地址无效") from None
    if _global_ip(host) != ipaddress.IPv4Address("1.1.1.1") or port != 53:
        raise _GlobalProbeError("手机 UDP 转发返回了非测试 DNS 目标的响应")
    return packet[position + 2:]


def _global_failure_message(stage, *, timed_out, target="example.com"):
    failure = "超时" if timed_out else "失败"
    if stage == "TCP":
        return f"手机 SOCKS5 连接 TCP 测试目标 {target}:443 {failure}；请检查手机 VPN 出口和目标可达性"
    if stage == "UDP":
        return f"手机 SOCKS5 UDP / DNS 测试{failure}，不能开启全局模式；请检查手机 VPN 的 UDP 策略、热点 UDP 中继及 1.1.1.1:53 可达性"
    if stage == "SOCKS5":
        return f"手机 SOCKS5 握手{failure}；" + _GLOBAL_UPDATE
    return f"连接手机代理{failure}；请检查手机地址、热点连接和代理服务是否已启动"


def _global_timeout(stage, target):
    error_type = GlobalProbeTargetTimeout if stage == "TCP" else GlobalProbeTimeout
    return error_type(_global_failure_message(stage, timed_out=True, target=target))


def probe_global_proxy(endpoint, timeout=8, *, tcp_target="example.com") -> None:
    """Verify SOCKS5 TCP plus a real UDP/DNS round trip, without direct fallback.

    RFC 1928 NOAUTH/CONNECT and UDP ASSOCIATE share one total deadline,
    including proxy DNS. All local TCP/UDP sockets target the selected proxy
    IP. A relay cannot redirect this check to another host via its BND.ADDR;
    a wildcard bind is replaced by that already verified proxy IP. Only the
    relay sends the encapsulated DNS query to 1.1.1.1:53. Up to three identical
    UDP requests tolerate packet loss within the same total deadline.
    """
    host, port = getattr(endpoint, "host", None), getattr(endpoint, "port", None)
    if not isinstance(host, str) or not host or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in host):
        raise ValueError("代理地址无效")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("代理端口无效")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("连接测试超时时间无效")
    if (not isinstance(tcp_target, str) or not tcp_target.isascii() or not 1 <= len(tcp_target) <= 253
            or not all(label and len(label) <= 63 and label.replace("-", "").isalnum() for label in tcp_target.split("."))):
        raise ValueError("TCP 测试目标无效")
    deadline, stage = _Deadline(timeout), "连接手机"
    try:
        tcp = deadline.open_socket((host, port))
        peer = tcp.getpeername()
        peer_ip = _global_ip(peer[0])
        stage = "SOCKS5"
        _global_noauth(tcp, deadline)
        stage = "TCP"
        name = tcp_target.encode("ascii")
        tcp.settimeout(deadline.remaining())
        tcp.sendall(b"\x05\x01\x00\x03" + bytes([len(name)]) + name + b"\x01\xbb")
        _global_socks_reply(tcp, deadline, target=tcp_target)
        deadline._close(tcp)

        stage = "UDP"
        control = deadline.open_socket((peer[0], port))
        if _global_ip(control.getpeername()[0]) != peer_ip:
            raise _GlobalProbeError("手机代理地址在测试中发生变化")
        _global_noauth(control, deadline)
        control.settimeout(deadline.remaining())
        # RFC 1928 permits all zeros when the UDP source endpoint is unknown.
        control.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
        bound_host, bound_port = _global_socks_reply(control, deadline, udp=True)
        try:
            bound_ip = _global_ip(bound_host)
        except ValueError:
            raise _GlobalProbeError("手机 UDP 中继必须返回手机本身的数字 IP 地址；未连接其他目标") from None
        if not 1 <= bound_port <= 65535 or (not bound_ip.is_unspecified and bound_ip != peer_ip):
            raise _GlobalProbeError("手机 UDP 中继地址与已验证的手机 IP 不一致；未连接其他目标")
        udp = deadline.track(socket.socket(control.family, socket.SOCK_DGRAM))
        udp.settimeout(deadline.remaining())
        udp_target = list(control.getpeername())
        udp_target[1] = bound_port
        udp.connect(tuple(udp_target))
        transaction = secrets.randbits(16)
        query = struct.pack("!6H", transaction, 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\x00\x00\x01\x00\x01"
        datagram = b"\x00\x00\x00\x01\x01\x01\x01\x01\x00\x35" + query
        retry_interval = min(1.0, deadline.remaining() / 3)
        for attempt in range(3):
            udp.settimeout(deadline.remaining())
            udp.send(datagram)
            udp.settimeout(deadline.remaining() if attempt == 2 else min(retry_interval, deadline.remaining()))
            try:
                packet = udp.recv(4097)
                break
            except socket.timeout:
                deadline.remaining()
                if attempt == 2:
                    raise
        deadline.remaining()
        if len(packet) > 4096 or not _global_dns_reply(_global_unwrap_dns(packet), transaction):
            raise _GlobalProbeError("手机 UDP / DNS 往返验证失败，不能开启全局模式")
        # The control connection is the UDP association's lifetime lease.
        readable, _, _ = select.select([control], [], [], 0)
        if readable:
            raise _GlobalProbeError("手机 UDP 控制连接提前关闭或返回了异常数据")
        deadline.remaining()
    except GlobalProbeTargetRejected:
        raise
    except (TimeoutError, socket.timeout):
        raise _global_timeout(stage, tcp_target) from None
    except socket.gaierror:
        raise OSError("手机代理地址解析失败") from None
    except (OSError, ValueError) as error:
        if deadline.expired.is_set():
            raise _global_timeout(stage, tcp_target) from None
        if isinstance(error, _GlobalProbeError):
            raise
        raise GlobalProbeTransient(_global_failure_message(stage, timed_out=False, target=tcp_target)) from None
    finally:
        deadline.close()


def probe_http_proxy(endpoint, timeout=6) -> None:
    """Require a complete HTTP 200 CONNECT response within one total deadline.

    endpoint supplies ``host`` and ``port``. This sends only CONNECT for
    example.com:443; it does not begin TLS or download a page. Success returns
    None. Failures raise short Chinese TimeoutError/ValueError/OSError messages.
    A 200 status line alone is insufficient: the entire header terminator must
    arrive, with at most 16 KiB of response headers.
    """
    host, port = getattr(endpoint, "host", None), getattr(endpoint, "port", None)
    if not isinstance(host, str) or not host or any(c.isspace() or ord(c) < 32 for c in host):
        raise ValueError("代理地址无效")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("代理端口无效")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("连接测试超时时间无效")
    deadline = _Deadline(timeout)
    try:
        sock = deadline.open_socket((host, port))
        sock.settimeout(deadline.remaining())
        sock.sendall(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        header = bytearray()
        limit = 16 * 1024
        while b"\r\n\r\n" not in header:
            if len(header) == limit:
                raise ValueError("代理响应头超过 16 KiB，无法确认代理可用")
            deadline.remaining()
            chunk = sock.recv(min(4096, limit - len(header)))
            if not chunk:
                raise ValueError("代理响应头不完整，无法确认代理可用")
            header.extend(chunk)
        deadline.remaining()
        status_line = bytes(header).split(b"\r\n", 1)[0]
        pieces = status_line.split(b" ", 2)
        if len(pieces) < 2 or pieces[0] not in (b"HTTP/1.0", b"HTTP/1.1") or len(pieces[1]) != 3 or not pieces[1].isdigit():
            raise ValueError("代理返回的 HTTP 状态行无效")
        status = int(pieces[1])
    except (TimeoutError, socket.timeout):
        raise TimeoutError("代理连接测试超时") from None
    except socket.gaierror:
        raise OSError("代理地址解析失败") from None
    except (OSError, ValueError) as exc:
        if deadline.expired.is_set():
            raise TimeoutError("代理连接测试超时") from None
        if isinstance(exc, ValueError):
            raise
        raise OSError("无法连接代理，请检查上游代理的地址、端口和运行状态") from None
    finally:
        deadline.close()
    if status == 407:
        raise OSError("代理要求身份验证（HTTP 407）")
    if status == 403:
        raise OSError("代理拒绝连接测试目标（HTTP 403）")
    if status != 200:
        raise OSError(f"代理未允许 HTTPS 隧道（HTTP {status}）")


def test_website(proxy_host, proxy_port, url, timeout=WEBSITE_TIMEOUT, *, cancellation=None) -> Result:
    """Check one URL/preset through the given proxy; always return a safe result."""
    return _test_website(proxy_host, proxy_port, url, timeout, system_path=False, cancellation=cancellation)


def test_system_website(url, timeout=WEBSITE_TIMEOUT, *, cancellation=None) -> Result:
    """Check the OS DNS and ordinary TCP/TLS path, ignoring environment proxies.

    During global mode this exercises the TUN entry path as an ordinary app
    would. It does not inspect browser-specific proxy, DNS or extension settings.
    The caller must label this path separately from the explicit proxy probe.
    Cancel its CheckCancellation group before removing the TUN routes.
    """
    return _test_website(None, None, url, timeout, system_path=True, cancellation=cancellation)


def _test_website(proxy_host, proxy_port, url, timeout, *, system_path, cancellation) -> Result:
    started = time.monotonic()
    valid_timeout = (not isinstance(timeout, bool) and isinstance(timeout, (int, float))
                     and math.isfinite(timeout) and timeout > 0)
    end = started + timeout if valid_timeout else started
    evidence = None
    for attempt in (1, 2):
        remaining = end - time.monotonic() if valid_timeout else timeout
        budget = min(_WEBSITE_FIRST_ATTEMPT_TIMEOUT, remaining) if valid_timeout and attempt == 1 else remaining
        outcome, retryable = _test_website_once(proxy_host, proxy_port, url, budget,
            system_path=system_path, cancellation=cancellation, address_offset=attempt - 1)
        if outcome.reachable:
            evidence = outcome
        elif evidence and not (cancellation is not None and cancellation.is_set()):
            outcome = replace(outcome, reachable=True, status_code=evidence.status_code,
                              detail=f'已收到 HTTP {evidence.status_code}，但复测未完成：{outcome.detail}')
        if (attempt == 2 or not retryable or not valid_timeout or end - time.monotonic() < .05
                or cancellation is not None and cancellation.is_set()):
            return replace(outcome, elapsed_ms=round((time.monotonic() - started) * 1000), attempts=attempt)


def _test_website_once(proxy_host, proxy_port, url, timeout, *, system_path, cancellation, address_offset):
    started = time.monotonic()
    original = str(url).strip()
    preset = lookup_site(original)
    if preset and "://" not in original:
        original = preset[1]
    try:
        name = preset[0] if preset else (urlsplit(original).hostname if "://" in original else original)
    except ValueError:
        name = "网站"
    name = name or "网站"
    deadline = None
    last_status = None

    def result(status, ok, detail, reachable=False, browser_verification=False, *, retryable=False):
        if last_status is not None and not reachable:
            status, reachable = last_status, True
            detail = f'已收到 HTTP {status}，但后续请求未完成：{detail}'
        if cancellation is not None and cancellation.is_set():
            status, ok, detail, reachable, browser_verification = None, False, '测试已取消', False, False
            retryable = False
        return Result(name, original, status, round((time.monotonic() - started) * 1000), ok, detail, reachable, browser_verification), retryable

    try:
        if not system_path and (not isinstance(proxy_host, str) or not proxy_host or any(c.isspace() for c in proxy_host)):
            return result(None, False, "本地代理地址无效")
        if not system_path and (isinstance(proxy_port, bool) or not isinstance(proxy_port, int) or not 1 <= proxy_port <= 65535):
            return result(None, False, "本地代理端口无效")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            return result(None, False, "测试超时时间无效")
        deadline = _WebsiteDeadline(timeout, address_offset)
        if cancellation is not None:
            cancellation.register(deadline)
        current = original
        for hop in range(4):
            scheme, host, port, authority, normalized, path = _parse_url(current)
            deadline.remaining()
            if system_path:
                connection = (_SystemHTTPSConnection if scheme == "https" else _ProxyHTTPConnection)(host, port, deadline)
                target = path
            elif scheme == "https":
                connection = _ProxyHTTPSConnection(proxy_host, proxy_port, host, port, deadline)
                target = path
            else:
                connection = _ProxyHTTPConnection(proxy_host, proxy_port, deadline)
                target = normalized
            response = None
            try:
                connection.request("GET", target, headers={
                    "Host": authority, "User-Agent": "FlowBridge connectivity-check",
                    "Accept": "*/*", "Connection": "close",
                })
                response = connection.getresponse()
                deadline.remaining()
                status = response.status
                last_status = status
                location = response.getheader("Location")
                browser_verification = response.getheader("cf-mitigated") == "challenge"
                # Read no body and retain no cookies. GET also supports origins
                # that reject HEAD or treat it differently from page requests.
            finally:
                if response is not None:
                    response.close()
                connection.close()
            if browser_verification:
                return result(status, False, "网站要求浏览器验证，自动测试无法确认使用情况", True, True)
            if status in _REDIRECTS and location:
                if hop == 3:
                    return result(status, False, "可到达，但重定向超过 3 次，已停止测试", True)
                try:
                    next_url = urljoin(normalized, location)
                    _parse_url(next_url)
                except ValueError:
                    return result(status, False, "可到达，但重定向地址不受支持，已停止测试", True)
                current = next_url
                continue
            ok, detail = _status_detail(status)
            return result(status, ok, detail, True)
    except _CheckCancelled:
        return result(None, False, '测试已取消')
    except _TunnelError as exc:
        if exc.status == 407:
            return result(exc.status, False, "代理要求身份验证")
        if exc.status == 403:
            return result(exc.status, False, "代理拒绝连接目标（HTTP 403）")
        return result(exc.status, False, f"代理无法连接目标（HTTP {exc.status}）", retryable=exc.status in (502, 503, 504))
    except (TimeoutError, socket.timeout):
        return result(None, False, "测试超时", retryable=True)
    except ssl.SSLCertVerificationError:
        return result(None, False, "TLS 证书验证失败")
    except ssl.SSLError:
        return result(None, False, "测试超时" if deadline and deadline.expired.is_set() else "TLS 握手失败", retryable=True)
    except _URLProblem as exc:
        return result(None, False, str(exc))
    except socket.gaierror:
        return result(None, False, "系统 DNS 解析失败" if system_path else "代理地址解析失败", retryable=True)
    except (ConnectionRefusedError, ConnectionResetError, BrokenPipeError, http.client.RemoteDisconnected) as exc:
        if deadline and deadline.expired.is_set():
            return result(None, False, "测试超时", retryable=True)
        if system_path:
            return result(None, False, "系统网络连接被拒绝" if isinstance(exc, ConnectionRefusedError) else "系统网络连接被中断", retryable=True)
        return result(None, False, "本地代理未启动或端口不可用" if isinstance(exc, ConnectionRefusedError) else "连接被代理或站点中断", retryable=True)
    except (OSError, http.client.HTTPException, ValueError):
        return result(None, False, "测试超时" if deadline and deadline.expired.is_set() else "系统网络或站点连接异常" if system_path else "代理或站点连接异常", retryable=True)
    finally:
        if deadline:
            deadline.close()
            if cancellation is not None:
                cancellation.discard(deadline)
