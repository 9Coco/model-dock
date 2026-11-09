"""Local-only protocol and lifecycle checks; no external proxy or website needed."""

import socket
import socketserver
import threading
import time
import unittest
from unittest.mock import patch

from relay import Endpoint, ProxyRelay, parse_proxy_address


def receive_all(sock):
    chunks = []
    while True:
        chunk = sock.recv(8192)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def receive_headers(sock):
    data = bytearray()
    while not data.endswith(b"\r\n\r\n"):
        chunk = sock.recv(1)
        if not chunk:
            raise EOFError("response ended before headers")
        data.extend(chunk)
    return bytes(data)


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached before timeout")


class _ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            header = receive_headers(self.request)
            if header.startswith(b"CONNECT "):
                self.request.sendall(self.server.connect_response)
                payload = receive_all(self.request)
                with self.server.records_lock:
                    self.server.records.append(header + payload)
                # Responding only after EOF proves that the relay preserves the
                # client's half-close while keeping the download side open.
                self.request.sendall(payload)
                self.request.shutdown(socket.SHUT_WR)
            else:
                length = 0
                for line in header.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.partition(b":")[2])
                body = bytearray()
                while len(body) < length:
                    chunk = self.request.recv(min(8192, length - len(body)))
                    if not chunk:
                        raise EOFError("request body ended early")
                    body.extend(chunk)
                with self.server.records_lock:
                    self.server.records.append(header + body)
                self.request.sendall(self.server.http_response)
                self.request.shutdown(socket.SHUT_WR)
        except (OSError, EOFError):
            # Clients deliberately disconnect in stop/limit/timeout tests.
            pass


class _LocalProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _ProxyHandler)
        self.records = []
        self.records_lock = threading.Lock()
        body = b"local proxy test response\n"
        self.http_response = (
            b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n" + body
        )
        self.connect_response = b"HTTP/1.1 200 Connection established\r\n\r\n"
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return Endpoint("127.0.0.1", self.server_address[1])

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


class EndpointTests(unittest.TestCase):
    def test_address_forms_and_display(self):
        cases = {
            " 10.15.60.93:8080 ": Endpoint("10.15.60.93", 8080),
            "http://Phone.Example:3128/": Endpoint("phone.example", 3128),
            "HTTP://127.0.0.1:80": Endpoint("127.0.0.1", 80),
            "[::1]:8080": Endpoint("::1", 8080),
            "http://[2001:db8::1]:8080": Endpoint("2001:db8::1", 8080),
            "http://[fe80::1%25wlan0]:8080": Endpoint("fe80::1%wlan0", 8080),
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                endpoint = parse_proxy_address(value)
                self.assertEqual(endpoint, expected)
                self.assertEqual(parse_proxy_address(endpoint.display), endpoint)
        self.assertEqual(Endpoint("::1", 8080).display, "http://[::1]:8080")

    def test_rejects_unsupported_or_malformed_addresses(self):
        for value in (
            "", "http://host", "host:0", "host:65536", "host:no", "host:8080:9",
            "https://host:8080", "socks5://host:1080", "http://u:p@host:8080",
            "http://@host:8080", "http://u%40name@host:8080", "host:8080/path",
            "http://host:8080/?a=b", "host:8080#fragment", "::1:8080",
            "http://[::1]garbage:8080", "http://host name:8080", "http://host:8080\nBAD",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_proxy_address(value)


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.server = _LocalProxy()
        self.relays = []
        self.clients = []

    def tearDown(self):
        for relay in self.relays:
            relay.stop()
        for client in self.clients:
            client.close()
        self.server.close()

    def relay(self, endpoint=None, **kwargs):
        relay = ProxyRelay(endpoint or self.server.endpoint, **kwargs)
        self.relays.append(relay)
        return relay, relay.start()

    def client(self, port):
        client = socket.create_connection(("127.0.0.1", port), timeout=3)
        client.settimeout(5)
        self.clients.append(client)
        return client

    def assert_idle(self, relay):
        wait_for(lambda: relay.snapshot()["active_connections"] == 0)

    def test_absolute_http_is_unchanged_and_bytes_are_exact(self):
        relay, port = self.relay(buffer_limit=1024)
        body = bytes(range(256)) * 1024
        request = (
            b"POST http://example.invalid/upload HTTP/1.1\r\nHost: example.invalid\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        client = self.client(port)
        client.sendall(request)
        response = receive_all(client)
        client.close()
        self.assert_idle(relay)
        self.assertEqual(self.server.records, [request])
        self.assertEqual(response, self.server.http_response)
        self.assertEqual(relay.snapshot(), {
            "upload_bytes": len(request), "download_bytes": len(response),
            "active_connections": 0, "total_connections": 1, "errors": 0,
        })

    def test_connect_tunnel_half_close_and_backpressure(self):
        relay, port = self.relay(buffer_limit=1024)
        client = self.client(port)
        header = b"CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n"
        client.sendall(header)
        response_header = receive_headers(client)
        self.assertEqual(response_header, self.server.connect_response)
        payload = bytes(range(256)) * 2048
        client.sendall(payload)
        client.shutdown(socket.SHUT_WR)
        # A deliberately small receive size exercises pending download buffers.
        chunks = []
        while True:
            part = client.recv(513)
            if not part:
                break
            chunks.append(part)
        self.assertEqual(b"".join(chunks), payload)
        client.close()
        self.assert_idle(relay)
        self.assertEqual(self.server.records, [header + payload])
        stats = relay.snapshot()
        self.assertEqual(stats["upload_bytes"], len(header) + len(payload))
        self.assertEqual(stats["download_bytes"], len(response_header) + len(payload))
        self.assertEqual(stats["errors"], 0)

    def test_stop_cancels_concurrent_connections_and_restart_clears(self):
        relay, port = self.relay()
        self.assertEqual(relay.start(), port)
        header = b"CONNECT example.invalid:443 HTTP/1.1\r\n\r\n"
        clients = [self.client(port) for _ in range(8)]
        for client in clients:
            client.sendall(header)
            self.assertEqual(receive_headers(client), self.server.connect_response)
        wait_for(lambda: relay.snapshot()["active_connections"] == 8)
        before = relay.snapshot()
        snapshots = []
        reading = threading.Event()
        reading.set()

        def poll():
            while reading.is_set():
                snapshots.append(relay.snapshot())
                time.sleep(0.001)

        poller = threading.Thread(target=poll)
        poller.start()
        started = time.monotonic()
        try:
            relay.stop()
        finally:
            reading.clear()
            poller.join(timeout=2)
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertEqual(relay.snapshot()["active_connections"], 0)
        self.assertEqual(relay.snapshot()["errors"], 0)
        self.assertEqual(relay.snapshot()["total_connections"], 8)
        self.assertGreater(before["upload_bytes"], 0)
        self.assertTrue(snapshots)
        for client in clients:
            try:
                self.assertEqual(client.recv(1), b"")
            except ConnectionResetError:
                pass
        new_port = relay.start()
        self.assertGreater(new_port, 0)
        self.assertEqual(relay.snapshot(), {
            "upload_bytes": 0, "download_bytes": 0, "active_connections": 0,
            "total_connections": 0, "errors": 0,
        })
        client = self.client(new_port)
        request = b"GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n"
        client.sendall(request)
        self.assertEqual(receive_all(client), self.server.http_response)
        client.close()
        self.assert_idle(relay)
        self.assertEqual(relay.snapshot()["total_connections"], 1)

    def test_connection_limit_is_bounded_and_counted(self):
        relay, port = self.relay(max_connections=1)
        first = self.client(port)
        first.sendall(b"CONNECT example.invalid:443 HTTP/1.1\r\n\r\n")
        receive_headers(first)
        second = self.client(port)
        try:
            self.assertEqual(second.recv(1), b"")
        except ConnectionResetError:
            pass
        wait_for(lambda: relay.snapshot()["errors"] == 1)
        self.assertEqual(relay.snapshot()["active_connections"], 1)
        self.assertEqual(relay.snapshot()["total_connections"], 2)

    def test_upstream_failure_is_counted_once(self):
        reserved = socket.socket()
        self.addCleanup(reserved.close)
        reserved.bind(("127.0.0.1", 0))
        relay, port = self.relay(Endpoint("127.0.0.1", reserved.getsockname()[1]))
        client = self.client(port)
        try:
            self.assertEqual(client.recv(1), b"")
        except ConnectionResetError:
            pass
        wait_for(lambda: relay.snapshot()["errors"] == 1)
        self.assert_idle(relay)
        self.assertEqual(relay.snapshot()["total_connections"], 1)
        self.assertEqual(relay.snapshot()["upload_bytes"], 0)

    def test_idle_timeout_closes_connection(self):
        relay, port = self.relay(idle_timeout=0.15)
        client = self.client(port)
        self.assertEqual(client.recv(1), b"")
        wait_for(lambda: relay.snapshot()["errors"] == 1)
        self.assert_idle(relay)

    def test_slow_dns_is_shared_and_stop_cancels_waiting_clients(self):
        real_lookup = socket.getaddrinfo
        resolver_entered = threading.Event()
        release_resolver = threading.Event()
        lookup_count = []

        def lookup(host, port, *args, **kwargs):
            if host != "phone.invalid":
                return real_lookup(host, port, *args, **kwargs)
            if kwargs.get("flags") == socket.AI_NUMERICHOST:
                raise socket.gaierror("not a numeric address")
            lookup_count.append(1)
            resolver_entered.set()
            release_resolver.wait(5)
            return real_lookup("127.0.0.1", port, *args, **kwargs)

        try:
            with patch("relay.socket.getaddrinfo", side_effect=lookup):
                relay, port = self.relay(Endpoint("phone.invalid", self.server.endpoint.port))
                for _ in range(5):
                    self.client(port)
                self.assertTrue(resolver_entered.wait(2))
                wait_for(lambda: relay.snapshot()["active_connections"] == 5)
                started = time.monotonic()
                relay.stop()
                self.assertLess(time.monotonic() - started, 1)
                self.assertEqual(len(lookup_count), 1)
                self.assertEqual(relay.snapshot()["active_connections"], 0)
                self.assertEqual(relay.snapshot()["errors"], 0)
        finally:
            release_resolver.set()

    def test_connect_timeout_also_bounds_dns_wait(self):
        real_lookup = socket.getaddrinfo
        release_resolver = threading.Event()

        def lookup(host, port, *args, **kwargs):
            if host != "phone.invalid":
                return real_lookup(host, port, *args, **kwargs)
            if kwargs.get("flags") == socket.AI_NUMERICHOST:
                raise socket.gaierror("not a numeric address")
            release_resolver.wait(5)
            return real_lookup("127.0.0.1", port, *args, **kwargs)

        try:
            with patch("relay.socket.getaddrinfo", side_effect=lookup):
                relay, port = self.relay(Endpoint("phone.invalid", 8080), connect_timeout=0.1)
                client = self.client(port)
                self.assertEqual(client.recv(1), b"")
                wait_for(lambda: relay.snapshot()["errors"] == 1)
                self.assert_idle(relay)
        finally:
            release_resolver.set()

    def test_invalid_limits_are_rejected(self):
        for options in (
            {"max_connections": 0}, {"buffer_limit": 0.5}, {"listen_port": -1},
            {"connect_timeout": float("nan")}, {"idle_timeout": float("inf")},
        ):
            with self.subTest(options=options), self.assertRaises(ValueError):
                ProxyRelay(self.server.endpoint, **options)


if __name__ == "__main__":
    unittest.main()
