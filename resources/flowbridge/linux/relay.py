"""A bounded, local TCP bridge for a phone's HTTP proxy.

The bridge does not parse or alter HTTP, CONNECT, TLS, or their payloads. Upload
bytes are counted only after a successful write to the upstream phone proxy;
download bytes only after a successful write back to the local client. Counts
therefore include HTTP proxy headers, but not TCP/IP or Wi-Fi overhead.

Each connection has bounded buffers and a small nonblocking selector loop.
Half-close is forwarded only after buffered bytes have drained. All shared
state is protected by a lock; each start owns a separate run, so late cleanup
from an earlier run cannot change a restarted relay's counters.
"""

from dataclasses import dataclass, field
import errno
import ipaddress
import math
import selectors
import socket
import threading
import time
from urllib.parse import unquote, urlsplit


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int

    def __post_init__(self):
        if not isinstance(self.host, str) or not self.host or any(c.isspace() for c in self.host):
            raise ValueError("代理主机名不能为空，也不能含空白字符")
        if any(c in self.host for c in "/\\@?#[]") or any(ord(c) < 32 or ord(c) == 127 for c in self.host):
            raise ValueError("代理主机名格式无效")
        if ":" in self.host:
            try:
                ipaddress.IPv6Address(self.host)
            except ValueError as exc:
                raise ValueError("IPv6 代理地址格式无效") from exc
        elif "%" in self.host:
            raise ValueError("代理主机名不应包含百分号编码")
        if isinstance(self.port, bool) or not isinstance(self.port, int) or not 1 <= self.port <= 65535:
            raise ValueError("代理端口必须在 1–65535 之间")

    @property
    def display(self) -> str:
        """An HTTP proxy URL without credentials, with bracketed IPv6 literals."""
        host = f"[{self.host.replace('%', '%25')}]" if ":" in self.host else self.host
        return f"http://{host}:{self.port}"


def parse_proxy_address(text: str) -> Endpoint:
    """Accept host:port or an HTTP proxy URL; reject unsupported details."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("请填写手机代理地址，例如 10.15.60.93:38473")
    value = text.strip()
    if any(c.isspace() for c in value) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("代理地址中不能包含空白或控制字符")
    try:
        parts = urlsplit(value if "://" in value else "//" + value)
        if parts.scheme and parts.scheme.lower() != "http":
            raise ValueError("目前仅支持 HTTP 代理，请使用 http://主机:端口")
        if parts.username is not None or parts.password is not None or "@" in parts.netloc:
            raise ValueError("目前不支持带用户名或密码的代理地址")
        if parts.path not in ("", "/") or parts.query or parts.fragment:
            raise ValueError("请只填写代理主机和端口，不要包含路径、查询参数或片段")
        authority = parts.netloc
        if authority.startswith("["):
            suffix = authority.partition("]")[2]
            if not suffix.startswith(":") or not suffix[1:].isdigit():
                raise ValueError("IPv6 请使用 [地址]:端口，方括号后不能包含其他内容")
        elif authority.count(":") != 1:
            raise ValueError("请填写主机:端口；IPv6 请使用 [地址]:端口")
        if not parts.hostname:
            raise ValueError("代理地址缺少主机名")
        if parts.port is None:
            raise ValueError("请明确填写代理端口，例如 10.15.60.93:38473")
        # RFC 6874 permits an encoded zone separator in bracketed IPv6 URLs.
        host = unquote(parts.hostname) if ":" in parts.hostname else parts.hostname
        return Endpoint(host, parts.port)
    except ValueError as exc:
        if str(exc).startswith(("Port ", "Invalid ", "'", "Unmatched ")):
            raise ValueError("代理地址或端口格式无效；IPv6 请使用 [地址]:端口") from exc
        raise


class _Cancelled(Exception):
    pass


def _empty_stats() -> dict:
    return {
        "upload_bytes": 0,
        "download_bytes": 0,
        "active_connections": 0,
        "total_connections": 0,
        "errors": 0,
    }


@dataclass
class _Resolution:
    done: threading.Event = field(default_factory=threading.Event)
    addresses: list | None = None
    error: OSError | None = None


@dataclass
class _Run:
    listener: socket.socket
    local_port: int
    stopping: threading.Event = field(default_factory=threading.Event)
    sockets: set = field(default_factory=set)
    workers: set = field(default_factory=set)
    stats: dict = field(default_factory=_empty_stats)
    accept_thread: threading.Thread | None = None
    resolution: _Resolution | None = None


class ProxyRelay:
    """Forward local proxy connections to an Endpoint.

    start() is idempotent while running. stop() retains the final counters;
    the next start() clears them. Active connections include connections still
    establishing their upstream socket. Total connections include accepted
    clients subsequently rejected by the connection limit or upstream failure.
    A failed/timed-out connection increments errors once; stop() cancellation
    does not. No system proxy setting or environment proxy is read or changed.
    """

    def __init__(
        self,
        endpoint: Endpoint,
        *,
        listen_host: str = "127.0.0.1",
        listen_port: int = 0,
        max_connections: int = 128,
        connect_timeout: float = 5.0,
        idle_timeout: float = 300.0,
        buffer_limit: int = 256 * 1024,
    ):
        if not isinstance(endpoint, Endpoint):
            raise TypeError("endpoint 必须是 Endpoint")
        if isinstance(listen_port, bool) or not isinstance(listen_port, int) or not 0 <= listen_port <= 65535:
            raise ValueError("本地监听端口必须在 0–65535 之间")
        if any(isinstance(v, bool) or not isinstance(v, int) or v < 1 for v in (max_connections, buffer_limit)):
            raise ValueError("连接上限和缓冲区大小必须是正整数")
        if any(not math.isfinite(v) or v <= 0 for v in (connect_timeout, idle_timeout)):
            raise ValueError("连接上限、缓冲区大小和超时时间必须大于 0")
        self.endpoint = endpoint
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.max_connections = max_connections
        self.connect_timeout = float(connect_timeout)
        self.idle_timeout = float(idle_timeout)
        self.buffer_limit = int(buffer_limit)
        self._lock = threading.RLock()
        self._lifecycle = threading.Lock()
        self._run = None
        self._last_stats = _empty_stats()

    def start(self) -> int:
        with self._lifecycle:
            with self._lock:
                if self._run is not None:
                    return self._run.local_port
            family = socket.AF_INET6 if ":" in self.listen_host else socket.AF_INET
            listener = socket.socket(family, socket.SOCK_STREAM)
            try:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind((self.listen_host, self.listen_port))
                listener.listen(self.max_connections)
                listener.settimeout(0.25)
                run = _Run(listener, listener.getsockname()[1])
                run.accept_thread = threading.Thread(
                    target=self._accept, args=(run,), name="phone-proxy-accept", daemon=True
                )
                with self._lock:
                    self._run = run
                    self._last_stats = _empty_stats()
                run.accept_thread.start()
                return run.local_port
            except BaseException:
                listener.close()
                with self._lock:
                    self._run = None
                raise

    def stop(self) -> None:
        with self._lifecycle:
            with self._lock:
                run = self._run
                if run is None:
                    return
                run.stopping.set()
                sockets = list(run.sockets)
            self._close(run.listener)
            for sock in sockets:
                self._close(sock)
            deadline = time.monotonic() + 2.0
            if run.accept_thread is not threading.current_thread():
                run.accept_thread.join(max(0, deadline - time.monotonic()))
            with self._lock:
                workers = list(run.workers)
            for worker in workers:
                if worker is not threading.current_thread():
                    worker.join(max(0, deadline - time.monotonic()))
            with self._lock:
                self._last_stats = dict(run.stats)
                self._last_stats["active_connections"] = 0
                self._run = None

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self._run.stats if self._run is not None else self._last_stats)

    @staticmethod
    def _close(sock: socket.socket) -> None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()

    def _add_socket(self, run: _Run, sock: socket.socket) -> None:
        with self._lock:
            if run.stopping.is_set():
                self._close(sock)
                raise _Cancelled()
            run.sockets.add(sock)

    def _remove_socket(self, run: _Run, sock: socket.socket) -> None:
        with self._lock:
            run.sockets.discard(sock)
        self._close(sock)

    def _accept(self, run: _Run) -> None:
        while not run.stopping.is_set():
            try:
                client, _ = run.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if not run.stopping.is_set():
                    with self._lock:
                        run.stats["errors"] += 1
                break
            with self._lock:
                if run.stopping.is_set():
                    self._close(client)
                    break
                run.stats["total_connections"] += 1
                if len(run.workers) >= self.max_connections:
                    run.stats["errors"] += 1
                    self._close(client)
                    continue
                run.sockets.add(client)
                worker = threading.Thread(
                    target=self._worker, args=(run, client), name="phone-proxy-connection", daemon=True
                )
                run.workers.add(worker)
                run.stats["active_connections"] = len(run.workers)
                # Starting under the lock prevents stop() seeing an unstarted thread.
                try:
                    worker.start()
                except RuntimeError:
                    run.workers.discard(worker)
                    run.sockets.discard(client)
                    run.stats["active_connections"] = len(run.workers)
                    run.stats["errors"] += 1
                    self._close(client)

    def _addresses(self, run: _Run, deadline: float) -> list:
        host, port = self.endpoint.host, self.endpoint.port
        try:
            # Numeric hotspot addresses need no resolver thread or DNS access.
            return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, flags=socket.AI_NUMERICHOST)
        except socket.gaierror:
            pass
        with self._lock:
            if run.resolution is None:
                resolution = run.resolution = _Resolution()

                def resolve():
                    try:
                        resolution.addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                    except OSError as exc:
                        resolution.error = exc
                    finally:
                        resolution.done.set()

                # A run shares one resolver and caches successful results. The OS
                # resolver cannot be interrupted, so it owns no sockets and never
                # blocks stop(); waiting connections still have their deadline.
                threading.Thread(target=resolve, name="phone-proxy-resolver", daemon=True).start()
            resolution = run.resolution
        while not run.stopping.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("代理主机名解析超时")
            if not resolution.done.wait(min(0.05, remaining)):
                continue
            if resolution.error:
                with self._lock:
                    if run.resolution is resolution:
                        run.resolution = None
                raise resolution.error
            return resolution.addresses
        raise _Cancelled()

    def _connect(self, run: _Run) -> socket.socket:
        deadline = time.monotonic() + self.connect_timeout
        addresses = self._addresses(run, deadline)
        last_error = OSError("代理主机没有可用地址")
        pending = {0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}
        for family, socktype, protocol, _, address in addresses:
            if run.stopping.is_set():
                raise _Cancelled()
            if time.monotonic() >= deadline:
                raise TimeoutError("连接手机代理超时")
            upstream = socket.socket(family, socktype, protocol)
            self._add_socket(run, upstream)
            connected = False
            try:
                upstream.setblocking(False)
                error = upstream.connect_ex(address)
                if error not in pending:
                    raise OSError(error, errno.errorcode.get(error, "连接失败"))
                if error:
                    with selectors.DefaultSelector() as selector:
                        selector.register(upstream, selectors.EVENT_WRITE)
                        while not run.stopping.is_set():
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise TimeoutError("连接手机代理超时")
                            if selector.select(min(0.25, remaining)):
                                error = upstream.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                                if error:
                                    raise OSError(error, errno.errorcode.get(error, "连接失败"))
                                break
                        else:
                            raise _Cancelled()
                if run.stopping.is_set():
                    raise _Cancelled()
                connected = True
                return upstream
            except OSError as exc:
                last_error = exc
            finally:
                if not connected:
                    self._remove_socket(run, upstream)
        raise last_error

    def _worker(self, run: _Run, client: socket.socket) -> None:
        upstream = None
        try:
            upstream = self._connect(run)
            self._bridge(run, client, upstream)
        except _Cancelled:
            pass
        except (OSError, ValueError):
            if not run.stopping.is_set():
                with self._lock:
                    run.stats["errors"] += 1
        finally:
            if upstream is not None:
                self._remove_socket(run, upstream)
            self._remove_socket(run, client)
            with self._lock:
                run.workers.discard(threading.current_thread())
                run.stats["active_connections"] = len(run.workers)

    def _bridge(self, run: _Run, client: socket.socket, upstream: socket.socket) -> None:
        client.setblocking(False)
        to_upstream, to_client = bytearray(), bytearray()
        read_open = {client: True, upstream: True}
        write_closed = {client: False, upstream: False}
        outgoing = {client: to_client, upstream: to_upstream}
        peer = {client: upstream, upstream: client}
        last_activity = time.monotonic()
        with selectors.DefaultSelector() as selector:
            while not run.stopping.is_set():
                for sock in (client, upstream):
                    if not read_open[peer[sock]] and not outgoing[sock] and not write_closed[sock]:
                        sock.shutdown(socket.SHUT_WR)
                        write_closed[sock] = True
                if not any(read_open.values()) and not to_upstream and not to_client:
                    return
                for sock in (client, upstream):
                    events = 0
                    if read_open[sock] and len(outgoing[peer[sock]]) < self.buffer_limit:
                        events |= selectors.EVENT_READ
                    if outgoing[sock] and not write_closed[sock]:
                        events |= selectors.EVENT_WRITE
                    try:
                        key = selector.get_key(sock)
                    except KeyError:
                        key = None
                    if not events and key:
                        selector.unregister(sock)
                    elif events and key is None:
                        selector.register(sock, events)
                    elif events and key.events != events:
                        selector.modify(sock, events)
                remaining = self.idle_timeout - (time.monotonic() - last_activity)
                if remaining <= 0:
                    raise TimeoutError("代理连接空闲超时")
                for key, events in selector.select(min(0.25, remaining)):
                    sock = key.fileobj
                    if events & selectors.EVENT_READ:
                        target = outgoing[peer[sock]]
                        try:
                            chunk = sock.recv(min(65536, self.buffer_limit - len(target)))
                        except (BlockingIOError, InterruptedError):
                            pass
                        else:
                            if chunk:
                                target.extend(chunk)
                                last_activity = time.monotonic()
                            else:
                                read_open[sock] = False
                    if events & selectors.EVENT_WRITE:
                        try:
                            count = sock.send(outgoing[sock])
                        except (BlockingIOError, InterruptedError):
                            pass
                        else:
                            if count:
                                del outgoing[sock][:count]
                                last_activity = time.monotonic()
                                name = "upload_bytes" if sock is upstream else "download_bytes"
                                with self._lock:
                                    run.stats[name] += count
