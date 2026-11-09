from pathlib import Path
import socket
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from windows.proxy import (
    GlobalProbeTimeout, GlobalProbeTransient, display_global_address,
    parse_global_address, probe_global_proxy, validate_endpoint,
)

# Reuse the shared probe's loopback SOCKS5/UDP fixture. The shared module also
# supports standalone Linux execution with its source directory on sys.path.
with patch.object(sys, "path", [str(Path(__file__).resolve().parents[1] / "linux"), *sys.path]):
    from linux.test_connectivity import _SocksProbeServer


class FakeClock:
    def __init__(self):
        self.now = 0
        self.pauses = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.pauses.append(seconds)
        self.now += seconds


class WindowsProxyTests(unittest.TestCase):
    def test_numeric_socks_and_bare_addresses_round_trip(self):
        for value, host, port in (
            ("127.0.0.1:1080", "127.0.0.1", 1080),
            ("SOCKS5://192.168.1.5:38473/", "192.168.1.5", 38473),
            ("socks5://[::1]:1080", "::1", 1080),
            ("[2001:db8::1]:65535", "2001:db8::1", 65535),
            ("[::ffff:127.0.0.1]:1080", "127.0.0.1", 1080),
        ):
            with self.subTest(value=value):
                endpoint = parse_global_address(value)
                self.assertEqual((endpoint.host, endpoint.port), (host, port))
                self.assertEqual(parse_global_address(display_global_address(endpoint)), endpoint)

    def test_rejects_non_socks_protocol_credentials_domains_and_ambiguous_input(self):
        for value in ("", "http://127.0.0.1:1080", "https://127.0.0.1:1080",
                      "socks4://127.0.0.1:1080", "socks5://u:p@127.0.0.1:1080",
                      "127.0.0.1", "localhost:1080", "vpn.example:1080", "127.0.0.1:0",
                      "127.0.0.1:65536", "127.0.0.1:-1", "127.0.0.1:abc",
                      "127.0.0.1:1080/path", "127.0.0.1:1080?x=1", "127.0.0.1:1080#x",
                      "127.0.0.1:\n1080", "socks5://[::1]junk:1080", "::1:1080",
                      "[fe80::1%12]:1080", "[::1%25lo]:1080", "0.0.0.0:1080",
                      "[::]:1080", "224.0.0.1:1080", "[ff02::1]:1080",
                      "255.255.255.255:1080", "[::ffff:0.0.0.0]:1080"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_global_address(value)

    def test_validates_duck_typed_endpoints_before_network_probe(self):
        for port in (True, 0, 65536, "1080", 1.2):
            with self.subTest(port=port), self.assertRaises(ValueError):
                validate_endpoint(SimpleNamespace(host="127.0.0.1", port=port))
        with patch("windows.proxy._probe_global_proxy") as probe:
            with self.assertRaises(ValueError):
                probe_global_proxy(SimpleNamespace(host="localhost", port=1080))
            probe.assert_not_called()

    def test_capability_probe_reuses_tcp_and_udp_preflight(self):
        endpoint = parse_global_address("127.0.0.1:1080")
        with patch("windows.proxy._probe_global_proxy") as probe:
            probe_global_proxy(endpoint, timeout=5)
            probe.assert_called_once_with(endpoint, timeout=5, tcp_target="example.com")

    def test_target_failure_uses_same_proxy_for_alternate_and_requires_real_udp(self):
        original_lookup = socket.getaddrinfo

        def lookup(host, *args, **kwargs):
            self.assertEqual(host, '127.0.0.1', 'no local fallback or lookup of a test target')
            return original_lookup(host, *args, **kwargs)

        for mode in ('primary_silent', 'primary_rejected'):
            with self.subTest(mode=mode), _SocksProbeServer(mode=mode) as server, patch.object(socket, 'getaddrinfo', side_effect=lookup):
                progress = Mock()
                probe_global_proxy(server.endpoint, timeout=.4, progress=progress)
                self.assertEqual(server.requests, [(1, 'example.com', 443), (1, 'www.microsoft.com', 443), (3, '0.0.0.0', 0)])
                self.assertEqual(len(server.queries), 1)
                self.assertTrue(server.queries[0][1])
                self.assertIn('www.microsoft.com:443', progress.call_args.args[0])

        with _SocksProbeServer(mode='primary_rejected_udp_silent') as server:
            with self.assertRaisesRegex(TimeoutError, 'UDP'):
                probe_global_proxy(server.endpoint, timeout=.4)
            self.assertEqual(len(server.queries), 3)

    def test_slow_healthy_primary_keeps_its_full_deadline(self):
        with _SocksProbeServer(mode='primary_slow') as server:
            probe_global_proxy(server.endpoint, timeout=1)
            self.assertEqual(server.requests, [(1, 'example.com', 443), (3, '0.0.0.0', 0)])

    def test_two_failed_targets_report_both_without_starting_udp(self):
        with _SocksProbeServer(mode='connect_rejected') as server:
            with self.assertRaisesRegex(OSError, 'example.com:443.*www.microsoft.com:443'):
                probe_global_proxy(server.endpoint, timeout=.4)
            self.assertEqual(server.requests, [(1, 'example.com', 443), (1, 'www.microsoft.com', 443)])
            self.assertFalse(server.queries)

    def test_protocol_and_security_errors_stop_startup_immediately(self):
        for mode, bound, expected in (('auth_required', '0.0.0.0', 1), ('connect_unsupported', '0.0.0.0', 1),
                                      ('associate_rejected', '0.0.0.0', 2), ('ok', '127.0.0.2', 2),
                                      ('wrong_transaction', '0.0.0.0', 2)):
            with self.subTest(mode=mode, bound=bound), _SocksProbeServer(mode=mode, bound=bound) as server, patch('windows.proxy.time.sleep') as sleep:
                with self.assertRaises(OSError):
                    probe_global_proxy(server.endpoint, timeout=1, startup=True)
                self.assertEqual(server.connections, expected)
                sleep.assert_not_called()

    def test_startup_rechecks_until_listener_ready_but_manual_does_not_back_off(self):
        for startup in (False, True):
            clock = FakeClock()
            failures = [GlobalProbeTransient('连接手机代理失败'), GlobalProbeTimeout('手机 SOCKS5 握手超时'), None]
            progress = Mock()
            with self.subTest(startup=startup), patch('windows.proxy.time', clock), patch('windows.proxy._probe_global_proxy', side_effect=failures) as probe:
                if startup:
                    probe_global_proxy(parse_global_address('127.0.0.1:1080'), startup=True, progress=progress)
                    self.assertEqual(clock.pauses, [2, 4])
                    self.assertEqual(probe.call_count, 3)
                    self.assertEqual(progress.call_count, 2)
                else:
                    with self.assertRaisesRegex(OSError, '连接上游代理失败'):
                        probe_global_proxy(parse_global_address('127.0.0.1:1080'))
                    self.assertFalse(clock.pauses)
                    probe.assert_called_once()

    def test_autostart_wall_clock_budget_clamps_final_attempt(self):
        clock = FakeClock()
        budgets = []

        def upstream_unready(endpoint, *, timeout, tcp_target):
            budgets.append(timeout)
            clock.now += timeout
            raise GlobalProbeTimeout('手机 SOCKS5 UDP / DNS 测试超时')

        with patch('windows.proxy.time', clock), patch('windows.proxy._probe_global_proxy', side_effect=upstream_unready):
            with self.assertRaisesRegex(TimeoutError, '120 秒.*UDP / DNS'):
                probe_global_proxy(parse_global_address('127.0.0.1:1080'), startup=True)
        self.assertEqual(clock.now, 120)
        self.assertEqual(clock.pauses[:3], [2, 4, 8])
        self.assertLess(max(clock.pauses), 9)
        self.assertEqual(budgets[-1], 2)

    def test_cancelling_backoff_or_completed_probe_never_reports_success(self):
        endpoint = parse_global_address('127.0.0.1:1080')
        event = threading.Event()
        with patch.object(event, 'wait', side_effect=lambda pause: event.set()), patch('windows.proxy._probe_global_proxy', side_effect=GlobalProbeTransient('上游连接失败')) as probe:
            with self.assertRaisesRegex(InterruptedError, '取消'):
                probe_global_proxy(endpoint, startup=True, cancel_event=event)
            probe.assert_called_once()

        event.clear()
        with patch('windows.proxy._probe_global_proxy', side_effect=lambda *args, **kwargs: event.set()):
            with self.assertRaisesRegex(InterruptedError, '取消'):
                probe_global_proxy(endpoint, startup=True, cancel_event=event)

    def test_probe_failures_remain_failures_with_platform_neutral_messages(self):
        endpoint = parse_global_address("127.0.0.1:1080")
        for failure in (TimeoutError("手机 UDP 测试超时"), OSError("手机不支持 UDP"),
                        ValueError("手机返回异常地址")):
            with self.subTest(failure=failure), patch("windows.proxy._probe_global_proxy", side_effect=failure):
                with self.assertRaises(type(failure)) as caught:
                    probe_global_proxy(endpoint)
                self.assertIn("上游代理", str(caught.exception))
                self.assertNotIn("手机", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
