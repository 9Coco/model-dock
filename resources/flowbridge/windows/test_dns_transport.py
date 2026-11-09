"""Real pinned-core DNS/SOCKS tests using loopback only, never a TUN.

The production builder is used, with the TUN replaced by a loopback SOCKS
inbound and its DoH service replaced by a deterministic DNS-over-TCP fixture.
The latter is reachable only through the fake upstream SOCKS server, which
records requests without opening any external connection.
"""

from contextlib import contextmanager
import io
import ipaddress
import json
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest

from windows.proxy import parse_global_address
from windows.tun_config import CORE_VERSION, DNS_TAG, FAKEIP_RANGE, OUTBOUND_TAG, build_config


SECRET = "test_only_generated_secret_0123456789abcdef"
DNS_FIXTURE_ADDRESS = "203.0.113.53"
REAL_ANSWER = "203.0.113.19"
UDP_REPLY_ADDRESS = "203.0.113.27"


def _read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        data = stream.recv(size - len(result))
        if not data:
            raise EOFError("unexpected fixture EOF")
        result.extend(data)
    return bytes(result)


def _read_address(read, kind):
    if kind == 1:
        host = socket.inet_ntop(socket.AF_INET, read(4))
    elif kind == 4:
        host = socket.inet_ntop(socket.AF_INET6, read(16))
    elif kind == 3:
        host = read(read(1)[0]).decode("ascii")
    else:
        raise ValueError(f"unexpected SOCKS address type {kind}")
    return host, struct.unpack("!H", read(2))[0]


def _ip_address(host, port):
    return b"\x01" + socket.inet_aton(host) + struct.pack("!H", port)


def _socks_open(port, command, host, destination_port):
    stream = socket.create_connection(("127.0.0.1", port), timeout=5)
    stream.settimeout(5)
    try:
        stream.sendall(b"\x05\x01\x00")
        if _read_exact(stream, 2) != b"\x05\x00":
            raise AssertionError("SOCKS method negotiation failed")
        stream.sendall(bytes((5, command, 0)) + _ip_address(host, destination_port))
        header = _read_exact(stream, 4)
        if header[:3] != b"\x05\x00\x00":
            raise AssertionError(f"SOCKS request failed: {header!r}")
        relay = _read_address(lambda size: _read_exact(stream, size), header[3])
        return stream, relay
    except BaseException:
        stream.close()
        raise


def _dns_question(domain, query_type=1, dnssec=False):
    name = b"".join(bytes((len(label),)) + label.encode("ascii") for label in domain.split(".")) + b"\0"
    header = struct.pack("!HHHHHH", 0x2468, 0x0100, 1, 0, 0, int(dnssec))
    question = name + struct.pack("!HH", query_type, 1)
    opt = b"\0" + struct.pack("!HHIH", 41, 1232, 0x8000, 0) if dnssec else b""
    return header + question + opt


def _question_end(packet):
    position = 12
    while packet[position]:
        position += 1 + packet[position]
    return position + 5


def _dns_answer(packet):
    end = _question_end(packet)
    query_type = struct.unpack("!H", packet[end - 4:end - 2])[0]
    if query_type == 1:
        data = socket.inet_aton(REAL_ANSWER)
    elif query_type == 16:
        data = b"\x07fixture"
    else:
        data = None
    header = packet[:2] + struct.pack("!HHHHH", 0x8180, 1, int(data is not None), 0, 0)
    answer = b"" if data is None else b"\xc0\x0c" + struct.pack("!HHIH", query_type, 1, 30, len(data)) + data
    return header + packet[12:end] + answer


class _Upstream:
    """Minimal SOCKS5 fixture: TCP echo, DNS-over-TCP and UDP echo."""

    def __enter__(self):
        self.tcp = socket.socket()
        self.tcp.bind(("127.0.0.1", 0))
        self.tcp.listen()
        self.tcp.settimeout(.1)
        self.port = self.tcp.getsockname()[1]
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("127.0.0.1", 0))
        self.udp.settimeout(.1)
        self.stop = threading.Event()
        self.tcp_requests = queue.Queue()
        self.udp_requests = queue.Queue()
        self.dns_requests = queue.Queue()
        self.errors = queue.Queue()
        self.threads = []
        self._thread(self._accept)
        self._thread(self._relay)
        return self

    def _thread(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True)
        self.threads.append(thread)
        thread.start()

    def _accept(self):
        while not self.stop.is_set():
            try:
                stream, _ = self.tcp.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self._thread(self._handle, stream)

    def _handle(self, stream):
        with stream:
            stream.settimeout(.2)
            try:
                greeting = _read_exact(stream, 2)
                _read_exact(stream, greeting[1])
                stream.sendall(b"\x05\x00")
                header = _read_exact(stream, 4)
                host, port = _read_address(lambda size: _read_exact(stream, size), header[3])
                if header[1] == 3:
                    stream.sendall(b"\x05\x00\x00" + _ip_address("127.0.0.1", self.udp.getsockname()[1]))
                    while not self.stop.is_set():
                        try:
                            if not stream.recv(1):
                                return
                        except socket.timeout:
                            continue
                    return
                if header[1] != 1:
                    raise AssertionError(f"unexpected SOCKS command {header[1]}")
                self.tcp_requests.put((header[3], host, port))
                stream.sendall(b"\x05\x00\x00" + _ip_address("127.0.0.1", 1))
                stream.settimeout(5)
                if host == DNS_FIXTURE_ADDRESS and port == 53:
                    length = struct.unpack("!H", _read_exact(stream, 2))[0]
                    packet = _read_exact(stream, length)
                    self.dns_requests.put(packet)
                    answer = _dns_answer(packet)
                    stream.sendall(struct.pack("!H", len(answer)) + answer)
                else:
                    stream.sendall(stream.recv(4096))
            except (EOFError, ConnectionError):
                pass
            except BaseException as error:
                if not self.stop.is_set():
                    self.errors.put(error)

    def _relay(self):
        while not self.stop.is_set():
            try:
                packet, source = self.udp.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                if packet[:3] != b"\0\0\0":
                    raise AssertionError("unexpected UDP fragmentation")
                reader = io.BytesIO(packet[4:])
                host, port = _read_address(reader.read, packet[3])
                payload = reader.read()
                self.udp_requests.put((packet[3], host, port, payload))
                self.udp.sendto(b"\0\0\0" + _ip_address(UDP_REPLY_ADDRESS, port) + payload, source)
            except BaseException as error:
                self.errors.put(error)

    def __exit__(self, exc_type, exc, traceback):
        self.stop.set()
        self.tcp.close()
        self.udp.close()
        for thread in self.threads:
            thread.join(timeout=1)
        if exc is None and not self.errors.empty():
            raise self.errors.get()


@contextmanager
def _udp_session(core_port):
    control, relay = _socks_open(core_port, 3, "0.0.0.0", 0)
    with control, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as stream:
        stream.bind(("127.0.0.1", 0))
        stream.settimeout(5)

        def exchange(host, port, payload):
            stream.sendto(b"\0\0\0" + _ip_address(host, port) + payload, relay)
            response, _ = stream.recvfrom(65535)
            reader = io.BytesIO(response[4:])
            origin = _read_address(reader.read, response[3])
            return origin, reader.read()

        yield exchange


class PinnedDnsTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured = os.environ.get("FLOWBRIDGE_WINDOWS_SING_BOX")
        cls.binary = Path(configured) if configured else Path(__file__).resolve().parents[1] / "vendor" / f"sing-box-{CORE_VERSION}-windows-amd64" / "sing-box.exe"
        if not cls.binary.is_file() or os.name != "nt":
            raise unittest.SkipTest("Windows pinned core not available; set FLOWBRIDGE_WINDOWS_SING_BOX")
        version = subprocess.run([str(cls.binary), "version"], capture_output=True, text=True, timeout=10, check=True,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if f"sing-box version {CORE_VERSION}\n" not in version.stdout:
            raise AssertionError("transport validation needs pinned sing-box")

    @contextmanager
    def core(self, upstream, directory, mode="fast"):
        from windows.native import CoreProcess
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        config = build_config(parse_global_address(f"127.0.0.1:{upstream.port}"), 39090, SECRET,
                              proxy_port=39091, bypass_process_path=r"C:\fixture\proxy.exe",
                              dns_mode=mode, cache_path=str(directory / "cache.db"))
        config["inbounds"] = [{"type": "socks", "tag": "fixture-in", "listen": "127.0.0.1", "listen_port": port}]
        config["dns"]["servers"][0] = {"type": "tcp", "tag": DNS_TAG, "server": DNS_FIXTURE_ADDRESS,
                                          "server_port": 53, "detour": OUTBOUND_TAG}
        config["route"]["auto_detect_interface"] = False
        config["experimental"].pop("clash_api")
        config["log"] = {"level": "debug", "output": str(directory / "core.log")}
        path = directory / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        core = CoreProcess([str(self.binary), "run", "-c", str(path)], str(directory))
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if core.poll() is not None:
                    self.fail((directory / "core.log").read_text(encoding="utf-8"))
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.02)
            else:
                self.fail("loopback-only core did not become ready")
            yield port
        finally:
            try:
                if core.poll() is None:
                    core.request_stop()
                    core.wait(timeout=5)
            finally:
                core.close_job()

    def lookup(self, port, domain, query_type=1, dnssec=False):
        with _udp_session(port) as exchange:
            _, packet = exchange("8.8.8.8", 53, _dns_question(domain, query_type, dnssec))
        self.assertEqual(struct.unpack("!H", packet[2:4])[0] & 0x000f, 0)
        return packet

    def connect_echo(self, core_port, fake_ip):
        stream, _ = _socks_open(core_port, 1, fake_ip, 443)
        with stream:
            stream.sendall(b"domain-preserved")
            self.assertEqual(_read_exact(stream, 16), b"domain-preserved")

    def test_fakeip_passes_hostname_for_tcp_udp_and_restores_udp_reply_source(self):
        with tempfile.TemporaryDirectory() as temp, _Upstream() as upstream:
            with self.core(upstream, Path(temp)) as port:
                reply = self.lookup(port, "flowbridge-test.invalid")
                fake_ip = socket.inet_ntoa(reply[-4:])
                self.assertIn(ipaddress.ip_address(fake_ip), ipaddress.ip_network(FAKEIP_RANGE))
                self.assertTrue(upstream.tcp_requests.empty(), "address lookup unexpectedly reached upstream DNS")
                self.connect_echo(port, fake_ip)
                self.assertEqual(upstream.tcp_requests.get(timeout=2), (3, "flowbridge-test.invalid", 443))
                with _udp_session(port) as exchange:
                    origin, data = exchange(fake_ip, 3478, b"udp-domain-preserved")
                self.assertEqual(upstream.udp_requests.get(timeout=2), (3, "flowbridge-test.invalid", 3478, b"udp-domain-preserved"))
                self.assertEqual(origin, (fake_ip, 3478))
                self.assertEqual(data, b"udp-domain-preserved")
                self.assertTrue(upstream.dns_requests.empty(), "SOCKS5 destination was resolved locally")

    def test_dnssec_stun_and_nonaddress_queries_still_use_the_upstream_proxy(self):
        for domain, query_type, dnssec in (("secure.invalid", 1, True), ("stun1.example.invalid", 1, False),
                                          ("text.invalid", 16, False), ("https.invalid", 65, False)):
            with self.subTest(domain=domain):
                # The fixture's TCP transport probes connection reuse in the
                # background. Isolate cases and inspect after fixture shutdown
                # so a late probe cannot contaminate the next case's queue.
                with tempfile.TemporaryDirectory() as temp, _Upstream() as upstream:
                    with self.core(upstream, Path(temp)) as port:
                        reply = self.lookup(port, domain, query_type, dnssec)
                        if query_type == 1:
                            self.assertEqual(socket.inet_ntoa(reply[-4:]), REAL_ANSWER)
                self.assertFalse(upstream.dns_requests.empty())
                questions = []
                while not upstream.dns_requests.empty():
                    questions.append(upstream.dns_requests.get_nowait())
                connections = []
                while not upstream.tcp_requests.empty():
                    connections.append(upstream.tcp_requests.get_nowait())
                self.assertGreaterEqual(len(connections), len(questions))
                for connection in connections:
                    self.assertEqual(connection, (1, DNS_FIXTURE_ADDRESS, 53))
                original_questions = []
                for question in questions:
                    if question[:2] == b"\x00\x01":
                        # Pinned multiplexer.executeReuseProbe sends ID 1/A,
                        # then ID 2/AAAA; this one-request fixture closes after
                        # the first. Validate the entire known probe packet.
                        # https://github.com/SagerNet/sing-box/blob/v1.14.4/dns/transport/multiplexer.go
                        self.assertEqual(question, b"\x00\x01" + _dns_question(domain)[2:])
                    else:
                        self.assertEqual(question[:2], b"\x24\x68")
                        self.assertEqual(question[12:_question_end(question)], _dns_question(domain, query_type)[12:])
                        original_questions.append(question)
                self.assertTrue(original_questions, "original DNS query never reached the upstream proxy")
                if dnssec:
                    for question in original_questions:
                        self.assertTrue(question.endswith(_dns_question(domain, dnssec=True)[-11:]),
                                        "DNSSEC request lost its DO flag")
        with tempfile.TemporaryDirectory() as temp, _Upstream() as upstream:
            with self.core(upstream, Path(temp)) as port:
                reply = self.lookup(port, "ipv6.invalid", 28)
                self.assertEqual(struct.unpack("!H", reply[6:8])[0], 0)
        self.assertTrue(upstream.tcp_requests.empty(), "IPv4-only mode unexpectedly queried AAAA")
        self.assertTrue(upstream.dns_requests.empty(), "IPv4-only mode unexpectedly queried AAAA")

    def test_cached_fakeip_survives_normal_restart_into_compatible_mode(self):
        with tempfile.TemporaryDirectory() as temp, _Upstream() as upstream:
            directory = Path(temp)
            with self.core(upstream, directory) as port:
                fake_ip = socket.inet_ntoa(self.lookup(port, "cached.invalid")[-4:])
            with self.core(upstream, directory, "compatible") as port:
                self.connect_echo(port, fake_ip)
                self.assertEqual(upstream.tcp_requests.get(timeout=2), (3, "cached.invalid", 443))
                reply = self.lookup(port, "cached.invalid")
                self.assertEqual(socket.inet_ntoa(reply[-4:]), REAL_ANSWER)
                self.assertEqual(upstream.tcp_requests.get(timeout=2), (1, DNS_FIXTURE_ADDRESS, 53))


if __name__ == "__main__":
    unittest.main()
