"""Windows proxy discovery fixtures use local sockets and an injected listener table."""
from pathlib import Path
import socket
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'resources/flowbridge'))
from windows import local_proxy


class LocalProxyTests(unittest.TestCase):
    def test_only_enabled_local_hints_are_used(self):
        settings = dict(flags=6, server='http=localhost:8080;https=remote.invalid:443;socks=[::1]:1080',
                        autoconfig='http://127.0.0.1:3128/proxy.pac?private=opaque')
        self.assertEqual(local_proxy.configured_endpoints(settings),
                         {('127.0.0.1', 8080), ('::1', 1080), ('127.0.0.1', 3128)})
        settings.update(flags=0)
        self.assertEqual(local_proxy.configured_endpoints(settings), set())
        settings.update(flags=2, server='http://name:password@localhost:80;http://localhost:65536')
        self.assertEqual(local_proxy.configured_endpoints(settings), set())

    def test_discovery_checks_protocol_and_excludes_unrelated_listeners_and_gateway(self):
        settings = dict(flags=4, server='', autoconfig='http://127.0.0.1:2222/proxy.pac')
        listeners = [
            ('127.0.0.1', 2222, 100), ('127.0.0.1', 2223, 100), ('0.0.0.0', 3333, 101), ('::', 3333, 101),
            ('127.0.0.1', 8181, 101), ('127.0.0.1', 5555, 102), ('192.0.2.1', 4444, 101),
        ]
        def table(family):
            return [dict(address=host, port=port, pid=pid) for host, port, pid in listeners
                    if (':' in host) == (family == socket.AF_INET6)]
        def handshake(endpoint, scheme):
            return (endpoint.port, scheme) in ((2223, 'http'), (3333, 'socks5'))
        paths = {100: 'pac-server.exe', 101: 'WindmillVPN_fixture.exe', 102: 'unrelated.exe'}
        with patch.object(local_proxy.native, '_tcp_listeners', side_effect=table), \
             patch.object(local_proxy.native, '_process_image_path', side_effect=paths.__getitem__), \
             patch.object(local_proxy, '_supports_proxy', side_effect=handshake) as probe:
            self.assertEqual(local_proxy.discover_local_proxies(settings, 8181), ['http://127.0.0.1:2223', 'socks5://127.0.0.1:3333'])
            self.assertEqual({call.args[0].port for call in probe.call_args_list}, {2222, 2223, 3333})

    def test_protocol_probes_against_local_fixtures(self):
        for scheme, reply, expected in [('socks5', b'\x05\x00', True), ('socks5', b'\x05\xff', False),
                                        ('http', b'HTTP/1.1 200 Connection established\r\n\r\n', True),
                                        ('http', b'HTTP/1.1 405 Method Not Allowed\r\n\r\n', False)]:
            with self.subTest(scheme=scheme, reply=reply), socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                listener.listen()
                listener.settimeout(5)
                def serve():
                    client, _ = listener.accept()
                    with client:
                        client.settimeout(5)
                        client.recv(1024)
                        client.sendall(reply)
                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                endpoint = local_proxy.Endpoint(*listener.getsockname())
                self.assertEqual(local_proxy._supports_proxy(endpoint, scheme), expected)
                thread.join(5)
                self.assertFalse(thread.is_alive())
