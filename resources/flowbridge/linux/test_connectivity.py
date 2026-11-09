"""Website checks against local mock HTTP proxies and verified TLS origins only."""

import contextlib
import errno
import http.client
import http.server
import io
import os
import select
from pathlib import Path
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from connectivity import SITES, CheckCancellation, lookup_site, probe_global_proxy, probe_http_proxy, test_website as check_website, test_system_website as check_system_website


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Deadline and failed-certificate tests deliberately abort connections.
        pass

    def start(self):
        self.thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=1)


class _Origin(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.server.requests.append((self.command, self.path))
        try:
            if self.path == "/slow-headers" or (self.path == "/disconnect-then-stall" and
                    len([request for request in self.server.requests if request[1] == self.path]) > 1):
                self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Slow: ")
                self.wfile.flush()
                for _ in range(100):
                    time.sleep(0.03)
                    self.wfile.write(b"a")
                    self.wfile.flush()
                return
            if self.path == "/close-always" or (self.path in ("/close-once", "/redirect-once", "/disconnect-then-stall") and
                    len([request for request in self.server.requests if request[1] == self.path]) ==
                    (2 if self.path == "/redirect-once" else 1)):
                self.close_connection = True
                return
            if self.path == "/stall" or (self.path == "/stall-once" and
                    len([request for request in self.server.requests if request[1] == self.path]) == 1):
                time.sleep(.35)
            status, location = 200, None
            if self.path.startswith("/status/"):
                status = int(self.path.rsplit("/", 1)[1])
            elif self.path.startswith("/redirect/"):
                status = 302
                location = "/redirect/" + str(int(self.path.rsplit("/", 1)[1]) + 1)
            elif self.path == "/redirect-loop":
                status, location = 301, "/redirect-loop"
            elif self.path.startswith("/delay/"):
                time.sleep(0.08)
                status = 302
                location = "/delay/" + str(int(self.path.rsplit("/", 1)[1]) + 1)
            elif self.path == "/to-tls":
                status = 302
                location = f"https://origin.test:{self.server.tls_port}/ok"
            elif self.path in ("/redirect-close", "/redirect-once"):
                status, location = 302, "/close-always"
            elif self.path == "/invalid-redirect":
                status, location = 302, "file:///etc/passwd"
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            for name, value in getattr(self.server, "response_headers", {}).items():
                self.send_header(name, value)
            self.send_header("Set-Cookie", "test-secret-cookie=must-not-be-logged")
            # A GET check must not try to read this advertised body.
            self.send_header("Content-Length", "1000000000")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.path == "/body-stall":
                self.connection.settimeout(1)
                if self.connection.recv(1) == b"":
                    self.server.client_closed.set()
            self.close_connection = True
        except (OSError, ssl.SSLError):
            pass

    def log_message(self, *args):
        pass


class _Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        target = urlsplit(self.path)
        self.server.requests.append(("GET", self.path))
        if target.hostname != "origin.test" or target.port not in self.server.origin_ports:
            self.send_error(502)
            return
        upstream = http.client.HTTPConnection("127.0.0.1", target.port, timeout=2)
        try:
            path = target.path or "/"
            if target.query:
                path += "?" + target.query
            upstream.request("GET", path, headers={"Host": target.netloc})
            response = upstream.getresponse()
            self.send_response(response.status)
            for name in ("Location", "Set-Cookie", "Content-Length"):
                if response.getheader(name) is not None:
                    self.send_header(name, response.getheader(name))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        except OSError:
            pass
        finally:
            upstream.close()

    def do_CONNECT(self):
        self.server.requests.append(("CONNECT", self.path))
        if self.server.reject_status:
            self.send_response(self.server.reject_status)
            for name, value in getattr(self.server, "connect_headers", {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.close_connection = True
            return
        parsed = urlsplit("//" + self.path)
        if parsed.hostname != "origin.test" or parsed.port not in self.server.origin_ports:
            self.send_error(502)
            return
        upstream = None
        try:
            self.send_response(200, "Connection established")
            self.end_headers()
            if self.server.stall_tls:
                time.sleep(1)
                return
            upstream = socket.create_connection(("127.0.0.1", parsed.port), timeout=2)
            self.connection.settimeout(2)

            def pump(source, destination):
                try:
                    while True:
                        data = source.recv(16384)
                        if not data:
                            break
                        destination.sendall(data)
                except OSError:
                    pass
                finally:
                    try:
                        destination.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass

            sending = threading.Thread(target=pump, args=(self.connection, upstream), daemon=True)
            sending.start()
            pump(upstream, self.connection)
            sending.join(timeout=0.1)
        except OSError:
            pass
        finally:
            self.close_connection = True
            if upstream:
                upstream.close()

    def log_message(self, *args):
        pass


class _ProbeProxy(http.server.BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.server.connections += 1

    def do_CONNECT(self):
        self.server.requests.append(self.path)
        try:
            for delay, chunk in self.server.chunks:
                if delay:
                    time.sleep(delay)
                self.wfile.write(chunk)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            self.close_connection = True

    def log_message(self, *args):
        pass


class _SocksProbeHandler(socketserver.BaseRequestHandler):
    def exact(self, count):
        result = bytearray()
        while len(result) < count:
            block = self.request.recv(count - len(result))
            if not block:
                raise OSError("closed test connection")
            result.extend(block)
        return bytes(result)

    def send(self, data):
        if self.server.delay: time.sleep(self.server.delay)
        self.request.sendall(data)

    def handle(self):
        self.server.connections += 1
        self.request.settimeout(2)
        owns_control = False
        try:
            if self.exact(3) != b"\x05\x01\x00": return
            if self.server.mode == "http_only":
                self.send(b"HTTP/1.1 400 Bad Request\r\n\r\n"); return
            if self.server.mode == "auth_required":
                self.send(b"\x05\x02"); return
            if self.server.mode == "trickle":
                self.request.sendall(b"\x05"); time.sleep(.2); self.request.sendall(b"\x00"); return
            self.send(b"\x05\x00")
            version, command, reserved, kind = self.exact(4)
            if (version, reserved) != (5, 0): return
            if kind == 3:
                address = self.exact(self.exact(1)[0]).decode("ascii")
            elif kind == 1:
                address = socket.inet_ntop(socket.AF_INET, self.exact(4))
            elif kind == 4:
                address = socket.inet_ntop(socket.AF_INET6, self.exact(16))
            else: return
            port = struct.unpack("!H", self.exact(2))[0]
            self.server.requests.append((command, address, port))
            if command == 1:
                if address == 'example.com' and self.server.mode == 'primary_silent':
                    self.request.recv(1)  # wait for the client to expire this attempt
                    return
                if address == 'example.com' and self.server.mode == 'primary_slow':
                    time.sleep(.6)
                code = 0
                if self.server.mode == "connect_rejected" or (address == 'example.com' and
                        self.server.mode in ('primary_rejected', 'primary_rejected_udp_silent')):
                    code = 5
                if self.server.mode == 'connect_unsupported':
                    code = 7
                self.send(bytes([5, code, 0, 1]) + b"\x00" * 6)
                return
            if command != 3: return
            if self.server.mode == "associate_rejected":
                self.send(b"\x05\x07\x00\x01" + b"\x00" * 6); return
            bound = self.server.bound
            if ":" in bound:
                encoded = b"\x04" + socket.inet_pton(socket.AF_INET6, bound)
            elif bound == "phone.invalid":
                encoded = b"\x03\x0dphone.invalid"
            else:
                encoded = b"\x01" + socket.inet_pton(socket.AF_INET, bound)
            self.server.control_open.set()
            owns_control = True
            self.send(b"\x05\x00\x00" + encoded + struct.pack("!H", self.server.udp.getsockname()[1]))
            if self.server.mode == "close_control": return
            self.request.recv(1)
        except OSError:
            pass
        finally:
            if owns_control: self.server.control_open.clear()


class _SocksProbeServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, *, mode="ok", bound="0.0.0.0", delay=0, host="127.0.0.1"):
        self.address_family = socket.AF_INET6 if ":" in host else socket.AF_INET
        super().__init__((host, 0), _SocksProbeHandler)
        self.mode, self.bound, self.delay = mode, bound, delay
        self.requests, self.queries, self.connections = [], [], 0
        self.control_open, self.stopping = threading.Event(), threading.Event()
        self.udp = socket.socket(self.address_family, socket.SOCK_DGRAM)
        self.udp.bind((host, 0)); self.udp.settimeout(.05)
        self.thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.udp_thread = threading.Thread(target=self.serve_udp, daemon=True)

    def handle_error(self, *args):
        pass

    def serve_udp(self):
        while not self.stopping.is_set():
            try: packet, peer = self.udp.recvfrom(8192)
            except socket.timeout: continue
            except OSError: return
            self.queries.append((packet, self.control_open.is_set()))
            if self.mode in ("udp_silent", "primary_rejected_udp_silent"): continue
            if self.mode == "udp_drop_two" and len(self.queries) <= 2: continue
            if len(packet) < 22: continue
            query = packet[10:]
            transaction = int.from_bytes(query[:2], "big")
            flags, count = 0x8180, 1
            if self.mode == "wrong_transaction": transaction ^= 1
            if self.mode == "dns_refused": flags |= 5
            if self.mode == "not_dns_reply": flags &= ~0x8000
            if self.mode == "dns_truncated": flags |= 0x0200
            if self.mode == "dns_empty": count = 0
            response = struct.pack("!6H", transaction, flags, 1, count, 0, 0) + query[12:]
            if count: response += b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04\xc0\x00\x02\x01"
            if self.mode == "dns_malformed": response = response[:12]
            header = bytearray(b"\x00\x00\x00\x01\x01\x01\x01\x01\x00\x35")
            if self.mode == "udp_fragment": header[2] = 1
            if self.mode == "wrong_dns_source": header[7] = 2
            if self.mode == "oversized": response += b"x" * 5000
            try: self.udp.sendto(bytes(header) + response, peer)
            except OSError: pass

    def __enter__(self):
        self.thread.start(); self.udp_thread.start()
        return self

    def __exit__(self, *args):
        self.stopping.set(); self.shutdown(); self.server_close(); self.udp.close()
        self.thread.join(1); self.udp_thread.join(1)

    @property
    def endpoint(self):
        return SimpleNamespace(host=self.server_address[0], port=self.server_address[1])


class GlobalProbeTests(unittest.TestCase):
    def test_tcp_and_actual_udp_dns_round_trip_keep_control_alive(self):
        original = socket.getaddrinfo
        looked_up = []
        def lookup(host, *args, **kwargs):
            looked_up.append(host)
            self.assertEqual(host, "127.0.0.1", "only the phone may be resolved/connected locally")
            return original(host, *args, **kwargs)
        with _SocksProbeServer() as server, patch("connectivity.socket.getaddrinfo", side_effect=lookup):
            self.assertIsNone(probe_global_proxy(server.endpoint, timeout=1))
            self.assertEqual(server.requests, [(1, "example.com", 443), (3, "0.0.0.0", 0)])
            self.assertEqual(len(server.queries), 1)
            self.assertEqual(server.queries[0][0][:10], b"\x00\x00\x00\x01\x01\x01\x01\x01\x00\x35")
            self.assertTrue(server.queries[0][1], "UDP TCP control must remain open until the reply")
        self.assertTrue(looked_up)

    def test_wildcard_literal_and_ipv4_mapped_same_phone_bind_addresses(self):
        for bound in ("0.0.0.0", "::", "127.0.0.1", "::ffff:127.0.0.1"):
            with self.subTest(bound=bound), _SocksProbeServer(bound=bound) as server:
                probe_global_proxy(server.endpoint, timeout=1)

    @unittest.skipUnless(socket.has_ipv6, "IPv6 is not available")
    def test_ipv6_phone_tcp_and_udp_transport(self):
        with _SocksProbeServer(host="::1", bound="::1") as server:
            probe_global_proxy(server.endpoint, timeout=1)
            self.assertEqual(len(server.queries), 1)

    def test_foreign_or_domain_relay_never_creates_a_udp_socket(self):
        original = socket.socket
        for bound in ("127.0.0.2", "192.0.2.1", "::ffff:127.0.0.2", "phone.invalid"):
            with self.subTest(bound=bound), _SocksProbeServer(bound=bound) as server:
                with patch("connectivity.socket.socket", wraps=original) as factory:
                    with self.assertRaisesRegex(OSError, "中继"):
                        probe_global_proxy(server.endpoint, timeout=1)
                    self.assertFalse(any(len(call.args) > 1 and call.args[1] == socket.SOCK_DGRAM for call in factory.call_args_list))
                self.assertEqual(server.queries, [])

    def test_old_http_auth_and_missing_udp_cannot_claim_global_support(self):
        for mode in ("http_only", "auth_required", "associate_rejected"):
            with self.subTest(mode=mode), _SocksProbeServer(mode=mode) as server:
                with self.assertRaisesRegex(OSError, "更新手机"):
                    probe_global_proxy(server.endpoint, timeout=1)

    def test_connect_failure_is_reported_without_attempting_udp(self):
        with _SocksProbeServer(mode="connect_rejected") as server:
            with self.assertRaisesRegex(OSError, "TCP") as error:
                probe_global_proxy(server.endpoint, timeout=1)
            self.assertIn("example.com:443", str(error.exception))
            self.assertIn("VPN 出口", str(error.exception))
            self.assertNotIn("更新手机", str(error.exception))
            self.assertEqual(server.requests, [(1, "example.com", 443)])
            self.assertEqual(server.queries, [])

    def test_udp_packet_loss_retries_same_transaction_through_same_phone(self):
        with _SocksProbeServer(mode="udp_drop_two") as server:
            self.assertIsNone(probe_global_proxy(server.endpoint, timeout=.3))
            self.assertEqual(server.connections, 2)
            self.assertEqual(len(server.queries), 3)
            self.assertEqual(len({packet for packet, _ in server.queries}), 1)
            self.assertTrue(all(control_open for _, control_open in server.queries))

    def test_dns_and_socks_udp_reply_validation(self):
        for mode in ("wrong_transaction", "dns_refused", "not_dns_reply", "dns_truncated", "dns_empty",
                     "dns_malformed", "udp_fragment", "wrong_dns_source", "oversized", "close_control"):
            with self.subTest(mode=mode), _SocksProbeServer(mode=mode) as server:
                with self.assertRaises(OSError): probe_global_proxy(server.endpoint, timeout=1)

    def test_udp_silence_has_a_total_deadline_and_no_direct_fallback(self):
        with _SocksProbeServer(mode="udp_silent") as server:
            started = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "UDP|全局") as error:
                probe_global_proxy(server.endpoint, timeout=.08)
            self.assertLess(time.monotonic() - started, .5)
            self.assertEqual(server.connections, 2)
            self.assertEqual(len(server.queries), 3)
            self.assertIn("VPN 的 UDP 策略", str(error.exception))
            self.assertIn("热点 UDP 中继", str(error.exception))
            self.assertNotIn("更新手机", str(error.exception))

    def test_one_deadline_covers_all_handshakes_and_partial_reads(self):
        for mode, delay in (("trickle", 0), ("ok", .04)):
            with self.subTest(mode=mode), _SocksProbeServer(mode=mode, delay=delay) as server:
                started = time.monotonic()
                with self.assertRaises(TimeoutError): probe_global_proxy(server.endpoint, timeout=.09)
                self.assertLess(time.monotonic() - started, .5)

    def test_late_proxy_dns_cannot_start_a_connection_after_timeout(self):
        release = threading.Event()
        with _SocksProbeServer() as server:
            def lookup(host, port, *args, **kwargs):
                if kwargs.get("flags", 0) & socket.AI_NUMERICHOST:
                    raise socket.gaierror("not numeric")
                release.wait(1)
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_address[1]))]
            endpoint = SimpleNamespace(host="phone.invalid", port=server.server_address[1])
            try:
                with patch("connectivity.socket.getaddrinfo", side_effect=lookup):
                    with self.assertRaises(TimeoutError): probe_global_proxy(endpoint, timeout=.04)
                    release.set(); time.sleep(.08)
                self.assertEqual(server.connections, 0)
            finally: release.set()

    def test_global_probe_validates_arguments_before_opening_a_socket(self):
        for endpoint, timeout in ((SimpleNamespace(host="bad host", port=1), 1),
                                  (SimpleNamespace(host="127.0.0.1", port=True), 1),
                                  (SimpleNamespace(host="127.0.0.1", port=1080), float("nan")),
                                  (SimpleNamespace(host="127.0.0.1", port=1080), 0)):
            with self.subTest(endpoint=endpoint, timeout=timeout), patch("connectivity.socket.socket") as factory:
                with self.assertRaises(ValueError): probe_global_proxy(endpoint, timeout)
                factory.assert_not_called()


class ConnectivityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("openssl"):
            raise unittest.SkipTest("TLS fixtures require the local openssl test utility")
        cls.temporary = tempfile.TemporaryDirectory(prefix="flowbridge-connectivity-test-")
        cls.cert = Path(cls.temporary.name) / "cert.pem"
        cls.key = Path(cls.temporary.name) / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-subj", "/CN=origin.test", "-addext", "subjectAltName=DNS:origin.test",
            "-keyout", str(cls.key), "-out", str(cls.cert),
        ], check=True, capture_output=True, timeout=10)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.http = _Server(("127.0.0.1", 0), _Origin)
        self.http.requests = []
        self.https = _Server(("127.0.0.1", 0), _Origin)
        self.https.requests = []
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert, self.key)
        self.https.socket = context.wrap_socket(self.https.socket, server_side=True)
        self.http.tls_port = self.https.server_port
        self.http.start()
        self.https.start()
        self.proxy = _Server(("127.0.0.1", 0), _Proxy)
        self.proxy.requests = []
        self.proxy.origin_ports = {self.http.server_port, self.https.server_port}
        self.proxy.reject_status = None
        self.proxy.stall_tls = False
        self.proxy.start()
        self.environment = patch.dict(os.environ, {
            "HTTP_PROXY": "http://wrong.invalid:1", "http_proxy": "http://wrong.invalid:1",
            "HTTPS_PROXY": "http://wrong.invalid:1", "ALL_PROXY": "http://wrong.invalid:1",
            "NO_PROXY": "*", "no_proxy": "*", "SSL_CERT_FILE": str(self.cert),
        })
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.proxy.stop()
        self.http.stop()
        self.https.stop()

    def check(self, path="/ok", *, secure=False, timeout=2):
        server = self.https if secure else self.http
        url = f"{'https' if secure else 'http'}://origin.test:{server.server_port}{path}"
        return check_website("127.0.0.1", self.proxy.server_port, url, timeout)

    def test_presets_and_name_lookup(self):
        self.assertEqual(list(SITES), ["Google", "YouTube", "X", "GitHub", "ChatGPT", "Cloudflare"])
        self.assertEqual(lookup_site("谷歌"), ("Google", SITES["Google"]))
        self.assertEqual(lookup_site("youtube"), ("YouTube", SITES["YouTube"]))
        self.assertEqual(lookup_site("https://github.com/some/path")[0], "GitHub")
        self.assertIsNone(lookup_site("https://other.invalid/"))

    def test_http_uses_absolute_uri_and_ignores_proxy_environment(self):
        result = self.check()
        self.assertTrue(result.ok, result)
        self.assertTrue(result.reachable)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.proxy.requests, [("GET", result.url)])
        self.assertEqual(self.http.requests, [("GET", "/ok")])

    def test_https_connect_uses_target_hostname_without_local_dns(self):
        original_lookup = socket.getaddrinfo
        looked_up = []

        def lookup(host, *args, **kwargs):
            looked_up.append(host)
            self.assertNotEqual(host, "origin.test", "target DNS leaked to the computer")
            return original_lookup(host, *args, **kwargs)

        with patch("connectivity.socket.getaddrinfo", side_effect=lookup):
            result = self.check(secure=True)
        self.assertTrue(result.ok, result)
        self.assertEqual(self.proxy.requests, [("CONNECT", f"origin.test:{self.https.server_port}")])
        self.assertEqual(self.https.requests, [("GET", "/ok")])
        self.assertTrue(looked_up)

    @contextlib.contextmanager
    def system_dns(self):
        original_lookup = socket.getaddrinfo
        looked_up = []
        def lookup(host, port, *args, **kwargs):
            if host == 'origin.test':
                if kwargs.get('flags') == socket.AI_NUMERICHOST:
                    raise socket.gaierror('hostname requires DNS')
                looked_up.append(host)
                host = '127.0.0.1'
            return original_lookup(host, port, *args, **kwargs)
        with patch('connectivity.socket.getaddrinfo', side_effect=lookup):
            yield looked_up

    def test_system_path_resolves_target_and_ignores_all_environment_proxies(self):
        for secure in (False, True):
            with self.subTest(secure=secure), self.system_dns() as looked_up:
                server = self.https if secure else self.http
                result = check_system_website(f"{'https' if secure else 'http'}://origin.test:{server.server_port}/ok")
                self.assertTrue(result.ok, result)
                self.assertEqual(looked_up, ['origin.test'])
                self.assertEqual(server.requests, [('GET', '/ok')])
        self.assertEqual(self.proxy.requests, [])

    def test_proxy_success_does_not_hide_failed_system_dns(self):
        original_lookup = socket.getaddrinfo
        def lookup(host, *args, **kwargs):
            if host == 'origin.test':raise socket.gaierror('test DNS unavailable')
            return original_lookup(host, *args, **kwargs)
        with patch('connectivity.socket.getaddrinfo', side_effect=lookup):
            system = check_system_website(f'https://origin.test:{self.https.server_port}/ok')
            proxy = self.check(secure=True)
        self.assertFalse(system.ok)
        self.assertFalse(system.reachable)
        self.assertEqual(system.detail, '系统 DNS 解析失败')
        self.assertTrue(proxy.ok, proxy)

    def test_system_path_tls_verification_remains_enabled(self):
        untrusted = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with self.system_dns(), patch('connectivity.ssl.create_default_context', return_value=untrusted):
            result = check_system_website(f'https://origin.test:{self.https.server_port}/ok')
        self.assertFalse(result.ok)
        self.assertEqual(result.detail, 'TLS 证书验证失败')
        self.assertEqual(result.attempts, 1)

    def test_system_path_redirect_and_challenge_use_the_same_safe_classification(self):
        with self.system_dns():
            result = check_system_website(f'http://origin.test:{self.http.server_port}/to-tls')
        self.assertTrue(result.ok, result)
        self.assertEqual(self.proxy.requests, [])
        self.assertEqual(self.https.requests, [('GET', '/ok')])
        self.https.response_headers = {'cf-mitigated': 'challenge'}
        with self.system_dns():
            result = check_system_website(f'https://origin.test:{self.https.server_port}/status/403')
        self.assertFalse(result.ok)
        self.assertTrue(result.reachable)
        self.assertTrue(result.browser_verification)

    def test_system_path_deadline_interrupts_trickled_response_and_redirects(self):
        for path in ('/slow-headers', '/delay/0'):
            with self.subTest(path=path), self.system_dns():
                started = time.monotonic()
                result = check_system_website(f'http://origin.test:{self.http.server_port}{path}', timeout=.12)
                self.assertFalse(result.ok)
                self.assertIn('测试超时', result.detail)
                self.assertEqual(result.reachable, path == '/delay/0')
                self.assertLess(time.monotonic()-started, .6)

    def test_system_path_dns_deadline_cannot_open_a_late_target_connection(self):
        original_lookup = socket.getaddrinfo
        def lookup(host, port, *args, **kwargs):
            if host == 'origin.test':
                if kwargs.get('flags') == socket.AI_NUMERICHOST:raise socket.gaierror('needs DNS')
                time.sleep(.15)
                host='127.0.0.1'
            return original_lookup(host, port, *args, **kwargs)
        with patch('connectivity.socket.getaddrinfo', side_effect=lookup):
            result = check_system_website(f'http://origin.test:{self.http.server_port}/ok', timeout=.03)
            self.assertEqual(result.detail, '测试超时')
            time.sleep(.18)
        self.assertEqual(self.http.requests, [])

    def test_system_cancellation_blocks_late_dns_and_late_worker_registration(self):
        cancellation=CheckCancellation()
        resolving,release=threading.Event(),threading.Event()
        original_lookup=socket.getaddrinfo
        results=[]
        def lookup(host,port,*args,**kwargs):
            if host=='origin.test':
                if kwargs.get('flags')==socket.AI_NUMERICHOST:raise socket.gaierror('needs DNS')
                resolving.set()
                if not release.wait(2):raise socket.gaierror('test resolver not released')
                host='127.0.0.1'
            return original_lookup(host,port,*args,**kwargs)
        with patch('connectivity.socket.getaddrinfo',side_effect=lookup), \
             patch('connectivity.socket.socket',wraps=socket.socket) as create_socket:
            worker=threading.Thread(target=lambda:results.append(check_system_website(
                f'http://origin.test:{self.http.server_port}/ok',cancellation=cancellation)))
            worker.start()
            try:
                self.assertTrue(resolving.wait(1))
                cancellation.cancel()  # The caller can now safely remove TUN routes.
                worker.join(.3)
                self.assertFalse(worker.is_alive(),'cancellation must not wait for OS DNS')
                release.set()
                late=check_system_website(f'http://127.0.0.1:{self.http.server_port}/ok',cancellation=cancellation)
                self.assertEqual(late.detail,'测试已取消')
                self.assertEqual(results[0].detail,'测试已取消')
                create_socket.assert_not_called()
            finally:
                release.set();worker.join(2)
        self.assertEqual(self.http.requests,[])

    def test_system_cancellation_closes_active_socket_before_returning(self):
        cancellation=CheckCancellation()
        results=[]
        with self.system_dns():
            worker=threading.Thread(target=lambda:results.append(check_system_website(
                f'http://origin.test:{self.http.server_port}/slow-headers',cancellation=cancellation)))
            worker.start()
            try:
                limit=time.monotonic()+1
                while not self.http.requests and time.monotonic()<limit:time.sleep(.002)
                self.assertTrue(self.http.requests)
                cancellation.cancel()
                worker.join(.5)
                self.assertFalse(worker.is_alive())
                self.assertEqual(results[0].detail,'测试已取消')
            finally:
                cancellation.cancel();worker.join(2)

    def test_system_cancellation_prevents_following_a_redirect(self):
        cancellation=CheckCancellation()
        original_getheader=http.client.HTTPResponse.getheader
        def getheader(response,name,*args):
            value=original_getheader(response,name,*args)
            if name=='Location':cancellation.cancel()
            return value
        with self.system_dns(),patch('connectivity.http.client.HTTPResponse.getheader',new=getheader):
            result=check_system_website(f'http://origin.test:{self.http.server_port}/to-tls',cancellation=cancellation)
        self.assertEqual(result.detail,'测试已取消')
        self.assertEqual(self.http.requests,[('GET','/to-tls')])
        self.assertEqual(self.https.requests,[])

    def test_tls_certificate_verification_cannot_be_bypassed(self):
        untrusted = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(untrusted.verify_mode, ssl.CERT_REQUIRED)
        with patch("connectivity.ssl.create_default_context", return_value=untrusted):
            result = self.check(secure=True)
        self.assertFalse(result.ok)
        self.assertFalse(result.reachable)
        self.assertEqual(result.detail, "TLS 证书验证失败")
        self.assertEqual(result.attempts, 1)
        self.assertEqual(len(self.proxy.requests), 1)
        self.assertEqual(self.https.requests, [])

    def test_site_rejection_is_reachable_not_a_network_failure(self):
        for status in (401, 403, 429, 500):
            with self.subTest(status=status):
                result = self.check(f"/status/{status}", secure=True)
                self.assertFalse(result.ok)
                self.assertTrue(result.reachable)
                self.assertEqual(result.status_code, status)
                self.assertIn("可到达", result.detail)
                self.assertFalse(result.browser_verification)
                self.assertEqual(result.attempts, 1)

    def test_tls_cloudflare_challenge_requires_browser_verification(self):
        self.https.response_headers = {"cf-mitigated": "challenge", "Server": "cloudflare"}
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = self.check("/status/403", secure=True)
        self.assertFalse(result.ok)
        self.assertTrue(result.reachable)
        self.assertTrue(result.browser_verification)
        self.assertEqual(result.status_code, 403)
        self.assertEqual(result.detail, "网站要求浏览器验证，自动测试无法确认使用情况")
        self.assertEqual(result.attempts, 1)
        self.assertEqual(self.https.requests, [("GET", "/status/403")])
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("test-secret-cookie", repr(result))

    def test_only_exact_challenge_marker_changes_a_normal_403(self):
        for marker in (None, "Challenge", "managed_challenge", "challenge-extra", "challenge, challenge"):
            self.https.response_headers = {"Server": "cloudflare"}
            if marker is not None:
                self.https.response_headers["cf-mitigated"] = marker
            with self.subTest(marker=marker):
                result = self.check("/status/403", secure=True)
                self.assertFalse(result.browser_verification)
                self.assertFalse(result.ok)
                self.assertTrue(result.reachable)
                self.assertIn("站点拒绝请求", result.detail)

    def test_challenge_marker_is_not_success_or_an_ordinary_redirect(self):
        self.https.response_headers = {"CF-Mitigated": "challenge"}
        for path, status in (("/ok", 200), ("/redirect/0", 302)):
            with self.subTest(path=path):
                before = len(self.https.requests)
                result = self.check(path, secure=True)
                self.assertTrue(result.browser_verification)
                self.assertTrue(result.reachable)
                self.assertFalse(result.ok)
                self.assertEqual(result.status_code, status)
                self.assertEqual(len(self.https.requests), before + 1)

    def test_proxy_connect_rejection_is_not_target_reachability(self):
        # An untrusted proxy response header does not prove a target challenge.
        self.proxy.connect_headers = {"cf-mitigated": "challenge"}
        for status in (403, 407, 502):
            self.proxy.reject_status = status
            with self.subTest(status=status):
                result = self.check(secure=True)
                self.assertFalse(result.ok)
                self.assertFalse(result.reachable)
                self.assertFalse(result.browser_verification)
                self.assertEqual(result.status_code, status)
                self.assertIn("代理", result.detail)
                self.assertEqual(result.attempts, 2 if status == 502 else 1)
        self.assertEqual(self.https.requests, [])

    def test_cross_scheme_redirect_still_uses_the_proxy(self):
        result = self.check("/to-tls")
        self.assertTrue(result.ok, result)
        self.assertEqual(len(self.proxy.requests), 2)
        self.assertEqual(self.proxy.requests[0][0], "GET")
        self.assertEqual(self.proxy.requests[1], ("CONNECT", f"origin.test:{self.https.server_port}"))
        self.assertEqual(self.https.requests, [("GET", "/ok")])

    def test_redirect_limit_is_three_follows(self):
        result = self.check("/redirect/0")
        self.assertFalse(result.ok)
        self.assertTrue(result.reachable)
        self.assertEqual(result.status_code, 302)
        self.assertEqual(len(self.proxy.requests), 4)
        self.assertIn("超过 3 次", result.detail)
        self.assertIn("已停止测试", result.detail)

    def test_301_redirect_loop_is_reachable_but_not_successful(self):
        result = self.check("/redirect-loop")
        self.assertFalse(result.ok)
        self.assertTrue(result.reachable)
        self.assertEqual(result.status_code, 301)
        self.assertEqual(len(self.proxy.requests), 4)
        self.assertEqual(len(set(self.proxy.requests)), 1)
        self.assertIn("超过 3 次", result.detail)
        self.assertIn("已停止测试", result.detail)

    def test_non_http_redirect_is_not_followed(self):
        result = self.check("/invalid-redirect")
        self.assertFalse(result.ok)
        self.assertTrue(result.reachable)
        self.assertEqual(result.status_code, 302)
        self.assertEqual(len(self.proxy.requests), 1)
        self.assertIn("地址不受支持", result.detail)
        self.assertIn("已停止测试", result.detail)

    def test_one_deadline_covers_all_redirects(self):
        started = time.monotonic()
        result = self.check("/delay/0", timeout=0.19)
        self.assertIn("测试超时", result.detail)
        self.assertTrue(result.reachable)
        self.assertEqual(result.status_code, 302)
        self.assertFalse(result.ok)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertLessEqual(len(self.proxy.requests), 3)

    def test_total_deadline_interrupts_trickled_headers(self):
        started = time.monotonic()
        result = self.check("/slow-headers", timeout=0.14)
        self.assertEqual(result.detail, "测试超时")
        self.assertLess(time.monotonic() - started, 0.8)

    def test_total_deadline_interrupts_tls_handshake(self):
        self.proxy.stall_tls = True
        started = time.monotonic()
        result = self.check(secure=True, timeout=0.14)
        self.assertEqual(result.detail, "测试超时")
        self.assertLess(time.monotonic() - started, 0.8)

    def test_proxy_dns_is_bounded_and_does_not_connect_late(self):
        original_lookup = socket.getaddrinfo
        release = threading.Event()

        def slow_lookup(host, port, *args, **kwargs):
            if host != "proxy.test":
                return original_lookup(host, port, *args, **kwargs)
            if kwargs.get("flags") == socket.AI_NUMERICHOST:
                raise socket.gaierror("not numeric")
            release.wait(2)
            return original_lookup("127.0.0.1", port, *args, **kwargs)

        try:
            with patch("connectivity.socket.getaddrinfo", side_effect=slow_lookup):
                started = time.monotonic()
                result = check_website("proxy.test", self.proxy.server_port, f"http://origin.test:{self.http.server_port}/ok", 0.1)
                self.assertEqual(result.detail, "测试超时")
                self.assertLess(time.monotonic() - started, 0.8)
        finally:
            release.set()
        time.sleep(0.05)
        self.assertEqual(self.proxy.requests, [])
        self.assertEqual(self.http.requests, [])

    def test_proxy_failure_never_falls_back_to_direct(self):
        reserved = socket.socket()
        try:
            reserved.bind(("127.0.0.1", 0))
            # This origin is directly reachable, but the explicit proxy refuses TCP.
            url = f"http://127.0.0.1:{self.http.server_port}/ok"
            result = check_website("127.0.0.1", reserved.getsockname()[1], url, 0.5)
        finally:
            reserved.close()
        self.assertFalse(result.ok)
        self.assertFalse(result.reachable)
        self.assertEqual(self.http.requests, [])

    def test_headers_cookies_and_body_are_not_logged(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = self.check(secure=True)
        self.assertTrue(result.ok, result)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("test-secret-cookie", repr(result))

    def test_get_stops_after_headers_and_closes_a_stalled_body(self):
        self.http.client_closed = threading.Event()
        with self.system_dns():
            started = time.monotonic()
            result = check_system_website(f'http://origin.test:{self.http.server_port}/body-stall', timeout=.6)
        self.assertTrue(result.ok, result)
        self.assertEqual(result.attempts, 1)
        self.assertLess(time.monotonic() - started, .3)
        self.assertEqual(self.http.requests, [('GET', '/body-stall')])
        self.assertTrue(self.http.client_closed.wait(.5), 'GET must close without waiting for the advertised body')

    def test_transient_disconnect_retries_once_on_each_original_path(self):
        for system in (False, True):
            with self.subTest(system=system):
                self.http.requests.clear()
                self.proxy.requests.clear()
                if system:
                    with self.system_dns():
                        result = check_system_website(f'http://origin.test:{self.http.server_port}/close-once', timeout=1)
                else:
                    result = self.check('/close-once', timeout=1)
                self.assertTrue(result.ok, result)
                self.assertEqual(result.attempts, 2)
                self.assertEqual(self.http.requests, [('GET', '/close-once')] * 2)
                self.assertEqual(len(self.proxy.requests), 0 if system else 2)

    def test_first_attempt_timeout_can_recover_within_total_budget(self):
        with self.system_dns(), patch('connectivity._WEBSITE_FIRST_ATTEMPT_TIMEOUT', .08):
            started = time.monotonic()
            result = check_system_website(f'http://origin.test:{self.http.server_port}/stall-once', timeout=.5)
        self.assertTrue(result.ok, result)
        self.assertEqual(result.attempts, 2)
        self.assertGreaterEqual(result.elapsed_ms, 70)
        self.assertLess(time.monotonic() - started, .3)
        self.assertEqual(self.http.requests, [('GET', '/stall-once')] * 2)

    def test_both_attempts_share_a_single_total_budget(self):
        with self.system_dns(), patch('connectivity._WEBSITE_FIRST_ATTEMPT_TIMEOUT', .08):
            started = time.monotonic()
            result = check_system_website(f'http://origin.test:{self.http.server_port}/stall', timeout=.22)
        elapsed = time.monotonic() - started
        self.assertFalse(result.ok)
        self.assertFalse(result.reachable)
        self.assertEqual(result.attempts, 2)
        self.assertEqual(result.detail, '测试超时')
        self.assertGreaterEqual(elapsed, .18)
        self.assertLess(elapsed, .4)
        self.assertEqual(self.http.requests, [('GET', '/stall')] * 2)

    def test_repeated_transient_failure_gets_only_one_retry(self):
        result = self.check('/close-always', timeout=1)
        self.assertFalse(result.ok)
        self.assertFalse(result.reachable)
        self.assertEqual(result.attempts, 2)
        self.assertEqual(len(self.proxy.requests), 2)
        self.assertEqual(self.http.requests, [('GET', '/close-always')] * 2)

    def test_redirect_failure_retains_http_evidence_across_a_failed_retry(self):
        result = self.check('/redirect-once', timeout=1)
        self.assertFalse(result.ok)
        self.assertTrue(result.reachable)
        self.assertEqual(result.status_code, 302)
        self.assertEqual(result.attempts, 2)
        self.assertIn('已收到 HTTP 302', result.detail)
        self.assertIn('复测未完成', result.detail)
        self.assertEqual(self.http.requests, [('GET', '/redirect-once'), ('GET', '/close-always'),
                                              ('GET', '/redirect-once')])

    def test_tls_failure_on_first_resolved_address_rotates_to_next_address(self):
        original_lookup = socket.getaddrinfo
        lookups = []
        def lookup(host, port, *args, **kwargs):
            if host != 'origin.test':
                return original_lookup(host, port, *args, **kwargs)
            if kwargs.get('flags') == socket.AI_NUMERICHOST:
                raise socket.gaierror('not numeric')
            lookups.append(host)
            # A real plaintext origin fails TLS; the next local origin has the
            # trusted certificate for the very same requested hostname.
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', candidate))
                    for candidate in (self.http.server_port, self.https.server_port)]
        with patch('connectivity.socket.getaddrinfo', side_effect=lookup):
            result = check_system_website(f'https://origin.test:{self.https.server_port}/ok', timeout=1)
        self.assertTrue(result.ok, result)
        self.assertEqual(result.attempts, 2)
        self.assertEqual(len(lookups), 2)
        self.assertEqual(self.https.requests, [('GET', '/ok')])
        self.assertEqual(self.proxy.requests, [])

    @contextlib.contextmanager
    def pending_addresses(self, *, all_pending=False):
        """Only fake TCP black holes; the successful fallback is a real socket."""
        original_socket, original_select, original_lookup = socket.socket, select.select, socket.getaddrinfo
        pending, created = [], []
        second_started = threading.Event()
        class PendingSocket:
            def __init__(self, *args, **kwargs):
                self.inner = original_socket(*args, **kwargs)
            def __getattr__(self, name):
                return getattr(self.inner, name)
            def connect_ex(self, address):
                pending.append(self)
                if len(pending) >= 2:
                    second_started.set()
                return errno.EINPROGRESS
        def factory(*args, **kwargs):
            if kwargs.get('fileno') is not None:
                return original_socket(*args, **kwargs)  # The local server's accepted connection.
            sock = PendingSocket(*args, **kwargs) if all_pending or not created else original_socket(*args, **kwargs)
            created.append(sock)
            return sock
        def select_ready(readable, writable, exceptional, delay):
            writable = [sock for sock in writable if not isinstance(sock, PendingSocket)]
            exceptional = [sock for sock in exceptional if not isinstance(sock, PendingSocket)]
            if not readable and not writable and not exceptional:
                time.sleep(delay)
                return [], [], []
            return original_select(readable, writable, exceptional, delay)
        def lookup(host, port, *args, **kwargs):
            if host != 'origin.test':
                return original_lookup(host, port, *args, **kwargs)
            if kwargs.get('flags') == socket.AI_NUMERICHOST:
                raise socket.gaierror('not numeric')
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', address)
                    for address in [('127.0.0.2', port), ('127.0.0.1', port)]]
        with patch('connectivity.socket.socket', side_effect=factory), \
             patch('connectivity.select.select', side_effect=select_ready), \
             patch('connectivity.socket.getaddrinfo', side_effect=lookup):
            yield created, pending, second_started

    def test_blackholed_first_address_does_not_block_a_real_fallback(self):
        with self.pending_addresses() as (created, pending, _):
            started = time.monotonic()
            result = check_system_website(f'http://origin.test:{self.http.server_port}/ok', timeout=1)
        self.assertTrue(result.ok, result)
        self.assertEqual(result.attempts, 1)
        self.assertGreaterEqual(time.monotonic() - started, .2)
        self.assertLess(time.monotonic() - started, .7)
        self.assertEqual(len(created), 2)
        self.assertEqual(len(pending), 1)
        self.assertTrue(all(sock.fileno() == -1 for sock in created))
        self.assertEqual(self.http.requests, [('GET', '/ok')])

    def test_cancelling_address_race_closes_every_candidate_without_retry(self):
        cancellation, results = CheckCancellation(), []
        with self.pending_addresses(all_pending=True) as (created, pending, second_started):
            worker = threading.Thread(target=lambda: results.append(check_system_website(
                f'http://origin.test:{self.http.server_port}/ok', timeout=2, cancellation=cancellation)))
            worker.start()
            try:
                self.assertTrue(second_started.wait(1))
                cancellation.cancel()
                self.assertTrue(all(sock.fileno() == -1 for sock in created))
                worker.join(.3)
                self.assertFalse(worker.is_alive())
            finally:
                cancellation.cancel()
                worker.join(2)
        self.assertEqual(len(pending), 2)
        self.assertEqual(results[0].detail, '测试已取消')
        self.assertEqual(results[0].attempts, 1)
        self.assertEqual(self.http.requests, [])

    def test_cancelling_second_attempt_closes_it_and_stops_further_requests(self):
        cancellation, results = CheckCancellation(), []
        with self.system_dns():
            worker = threading.Thread(target=lambda: results.append(check_system_website(
                f'http://origin.test:{self.http.server_port}/disconnect-then-stall', timeout=2,
                cancellation=cancellation)))
            worker.start()
            try:
                limit = time.monotonic() + 1
                while len(self.http.requests) < 2 and time.monotonic() < limit:
                    time.sleep(.002)
                self.assertEqual(len(self.http.requests), 2)
                cancellation.cancel()
                worker.join(.3)
                self.assertFalse(worker.is_alive())
            finally:
                cancellation.cancel()
                worker.join(2)
        self.assertEqual(results[0].detail, '测试已取消')
        self.assertEqual(results[0].attempts, 2)
        self.assertFalse(results[0].reachable)
        self.assertEqual(len(self.http.requests), 2)

    def test_invalid_arguments_return_short_results(self):
        for url in ("https://[bad", "file:///tmp/test", "https://u:p@origin.test/", "http://origin.test:0/", "https://origin.test/\nX:"):
            with self.subTest(url=url):
                result = check_website("127.0.0.1", self.proxy.server_port, url)
                self.assertFalse(result.ok)
                self.assertFalse(result.reachable)
                self.assertLess(len(result.detail), 80)
        self.assertFalse(check_website("127.0.0.1", 0, SITES["Google"]).ok)
        self.assertFalse(check_website("127.0.0.1", 1, SITES["Google"], float("inf")).ok)
        self.assertEqual(self.proxy.requests, [])


class ProxyProbeTests(unittest.TestCase):
    def server(self, response=None, chunks=None):
        server = _Server(("127.0.0.1", 0), _ProbeProxy)
        server.requests = []
        server.connections = 0
        server.chunks = chunks or [(0, response or b"HTTP/1.1 200 Connection established\r\nServer: mock\r\n\r\n")]
        server.start()
        self.addCleanup(server.stop)
        return server, SimpleNamespace(host="127.0.0.1", port=server.server_port)

    def test_complete_200_connect_response_succeeds_without_target_dns(self):
        server, endpoint = self.server()
        original_lookup = socket.getaddrinfo

        def lookup(host, *args, **kwargs):
            self.assertNotEqual(host, "example.com")
            return original_lookup(host, *args, **kwargs)

        with patch("connectivity.socket.getaddrinfo", side_effect=lookup):
            self.assertIsNone(probe_http_proxy(endpoint, timeout=0.5))
        self.assertEqual(server.requests, ["example.com:443"])

    def test_truncated_200_is_not_a_success(self):
        for response in (b"HTTP/1.1 200 Connection established\r\n", b"HTTP/1.1 200 OK\r\nServer: incomplete\r\n"):
            server, endpoint = self.server(response=response)
            with self.subTest(response=response), self.assertRaisesRegex(ValueError, "响应头不完整"):
                probe_http_proxy(endpoint, timeout=0.5)
            self.assertEqual(server.requests, ["example.com:443"])

    def test_complete_rejection_is_an_error(self):
        for status in (403, 407, 502):
            server, endpoint = self.server(response=f"HTTP/1.1 {status} Rejected\r\n\r\n".encode())
            with self.subTest(status=status), self.assertRaisesRegex(OSError, str(status)):
                probe_http_proxy(endpoint, timeout=0.5)

    def test_slow_headers_share_one_deadline(self):
        chunks = [(0, b"HTTP/1.1 200 OK\r\nX-Slow: ")] + [(0.03, b"a")] * 20 + [(0, b"\r\n\r\n")]
        server, endpoint = self.server(chunks=chunks)
        started = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "测试超时"):
            probe_http_proxy(endpoint, timeout=0.11)
        self.assertLess(time.monotonic() - started, 0.6)
        self.assertEqual(server.requests, ["example.com:443"])

    def test_header_limit_is_16k_inclusive(self):
        prefix, suffix = b"HTTP/1.1 200 OK\r\nX-Pad: ", b"\r\n\r\n"
        response = prefix + b"a" * (16 * 1024 - len(prefix) - len(suffix)) + suffix
        self.assertEqual(len(response), 16 * 1024)
        _, endpoint = self.server(response=response)
        self.assertIsNone(probe_http_proxy(endpoint, timeout=0.5))
        _, endpoint = self.server(response=response.replace(b"X-Pad: ", b"X-Pad: aa", 1))
        with self.assertRaisesRegex(ValueError, "超过 16 KiB"):
            probe_http_proxy(endpoint, timeout=0.5)

    def test_dns_finishing_after_timeout_does_not_connect_or_send(self):
        server, endpoint = self.server()
        endpoint.host = "probe.invalid"
        original_lookup = socket.getaddrinfo
        release = threading.Event()
        resolver_done = threading.Event()

        def lookup(host, port, *args, **kwargs):
            if host != "probe.invalid":
                return original_lookup(host, port, *args, **kwargs)
            if kwargs.get("flags") == socket.AI_NUMERICHOST:
                raise socket.gaierror("not numeric")
            release.wait(2)
            result = original_lookup("127.0.0.1", port, *args, **kwargs)
            resolver_done.set()
            return result

        try:
            with patch("connectivity.socket.getaddrinfo", side_effect=lookup):
                with self.assertRaisesRegex(TimeoutError, "测试超时"):
                    probe_http_proxy(endpoint, timeout=0.08)
                release.set()
                self.assertTrue(resolver_done.wait(0.5))
                time.sleep(0.05)
        finally:
            release.set()
        self.assertEqual(server.connections, 0)
        self.assertEqual(server.requests, [])

    def test_invalid_arguments_fail_without_connecting(self):
        server, endpoint = self.server()
        for bad in (0, -1, float("nan"), True):
            with self.subTest(timeout=bad), self.assertRaisesRegex(ValueError, "超时"):
                probe_http_proxy(endpoint, timeout=bad)
        with self.assertRaisesRegex(ValueError, "地址"):
            probe_http_proxy(SimpleNamespace(host="bad host", port=8080))
        self.assertEqual(server.connections, 0)


if __name__ == "__main__":
    unittest.main()
