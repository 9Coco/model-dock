"""Routing invariants and optional real-core schema checks; never starts a TUN."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

from windows.proxy import parse_global_address
from windows.tun_config import (
    BYPASS_TAG, CORE_VERSION, DNS_TAG, DOH_ADDRESS, FAKEIP_CACHE_ID, FAKEIP_RANGE,
    FAKEIP_TAG, INTERFACE_NAME,
    LOOPBACK_EXCLUDES, OUTBOUND_TAG, TUN_ADDRESSES, build_config,
)


SECRET = "test_only_generated_secret_0123456789abcdef"
PROXY_PATH = r"C:\Program Files\VPN client\proxy-core.exe"
CACHE_PATH = r"C:\Users\test\AppData\Local\FlowBridge\dns-cache.db"


class WindowsTunConfigTests(unittest.TestCase):
    def config(self, address="192.168.1.5:38473", **kwargs):
        values = dict(api_port=39090, api_secret=SECRET, proxy_port=39091)
        values.update(kwargs)
        return build_config(parse_global_address(address), **values)

    def test_remote_proxy_has_no_direct_fallback_or_linux_routing_fields(self):
        config = self.config()
        self.assertEqual([x["type"] for x in config["outbounds"]], ["socks"])
        self.assertTrue(config["route"]["auto_detect_interface"])
        self.assertEqual(config["route"]["final"], OUTBOUND_TAG)
        inbound = config["inbounds"][0]
        self.assertEqual(inbound["interface_name"], INTERFACE_NAME)
        self.assertEqual(inbound["address"], list(TUN_ADDRESSES))
        self.assertTrue(inbound["auto_route"])
        self.assertTrue(inbound["strict_route"])
        self.assertEqual(inbound["route_exclude_address"], list(LOOPBACK_EXCLUDES))
        for linux_field in ("auto_redirect", "iproute2_table_index", "iproute2_rule_index"):
            self.assertNotIn(linux_field, inbound)

    def test_dns_is_proxied_encrypted_and_before_general_traffic(self):
        config = self.config()
        self.assertEqual(config["inbounds"][0]["dns_mode"], "hijack")
        rules = config["route"]["rules"]
        self.assertEqual(rules[0], {"port": 53, "action": "hijack-dns"})
        self.assertEqual(rules[-1], {"action": "reject"})
        self.assertEqual(rules[-2], {"network": ["tcp", "udp"], "action": "route", "outbound": OUTBOUND_TAG})
        server, = config["dns"]["servers"]
        self.assertEqual(server["type"], "https")
        self.assertEqual(server["server"], DOH_ADDRESS)
        self.assertEqual(server["detour"], OUTBOUND_TAG)
        self.assertTrue(server["tls"]["enabled"])
        self.assertNotIn("insecure", server["tls"])
        self.assertEqual(config["dns"]["final"], DNS_TAG)

    def test_fast_dns_preserves_proxy_routing_and_real_dns_fallback(self):
        config = self.config(dns_mode="fast", cache_path=CACHE_PATH)
        original = self.config()
        for key in ("inbounds", "outbounds"):
            self.assertEqual(config[key], original[key])
        self.assertEqual(config["route"]["rules"], original["route"]["rules"])
        self.assertEqual(config["route"]["final"], original["route"]["final"])
        self.assertEqual(config["route"]["default_domain_resolver"], {"server": DNS_TAG, "strategy": "ipv4_only"})
        doh, fake = config["dns"]["servers"]
        self.assertEqual(doh, original["dns"]["servers"][0])
        self.assertEqual(fake, {"type": "fakeip", "tag": FAKEIP_TAG, "inet4_range": FAKEIP_RANGE})
        self.assertEqual(config["dns"]["final"], DNS_TAG)
        self.assertEqual(config["dns"]["strategy"], "ipv4_only")
        self.assertNotIn("reverse_mapping", config["dns"])
        secure, stun, address = config["dns"]["rules"]
        self.assertTrue(secure["query_dnssec"])
        self.assertEqual(secure["server"], DNS_TAG)
        for domain in ("stun.example.com", "stun1.example.com", "global.turn.example.com"):
            self.assertRegex(domain, stun["domain_regex"][0])
        self.assertIsNone(re.search(stun["domain_regex"][0], "www.example.com"))
        self.assertEqual(stun["server"], DNS_TAG)
        self.assertEqual(address["query_type"], ["A", "AAAA"])
        self.assertEqual(address["server"], FAKEIP_TAG)
        cache = config["experimental"]["cache_file"]
        self.assertEqual(cache, {"enabled": True, "path": CACHE_PATH,
                                "cache_id": FAKEIP_CACHE_ID, "store_fakeip": True})

    def test_compatible_mode_accepts_previous_fake_addresses_without_issuing_new_ones(self):
        compatible = self.config(dns_mode="compatible", cache_path=CACHE_PATH)
        fast = self.config(dns_mode="fast", cache_path=CACHE_PATH)
        self.assertEqual(compatible["dns"]["servers"], fast["dns"]["servers"])
        self.assertEqual(compatible["experimental"]["cache_file"], fast["experimental"]["cache_file"])
        self.assertNotIn("rules", compatible["dns"])
        self.assertEqual(compatible["dns"]["final"], DNS_TAG)
        self.assertNotIn("cache_file", self.config()["experimental"])

    def test_rejects_unknown_mode_or_nonlocal_nonpersistent_cache_path(self):
        for values in ({"dns_mode": "direct"}, {"dns_mode": "fast"},
                       *({"cache_path": path} for path in (
                           "", "cache.db", r"C:cache.db", r"\\server\share\cache.db",
                           r"C:\cache\..\cache.db", "C:\\cache\\", "C:\\cache.db\n"))):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.config(**values)

    def test_local_vpn_requires_verified_program_to_prevent_loop(self):
        for address in ("127.0.0.1:1080", "[::1]:1080"):
            with self.subTest(address=address), self.assertRaisesRegex(ValueError, "所属程序"):
                self.config(address)

    def test_only_local_proxy_program_bypasses_tun_and_local_socket_avoids_nic_binding(self):
        for address, bind_field, bind_address in (
            ("127.0.0.1:1080", "inet4_bind_address", "127.0.0.1"),
            ("[::1]:1080", "inet6_bind_address", "::1"),
        ):
            with self.subTest(address=address):
                config = self.config(address, bypass_process_path=PROXY_PATH)
                upstream, direct = config["outbounds"]
                self.assertEqual(upstream[bind_field], bind_address)
                self.assertEqual(direct["type"], "direct")
                self.assertNotIn("bind_interface", direct)
                self.assertNotIn("inet4_bind_address", direct)
                bypass = config["route"]["rules"][0]
                self.assertEqual(bypass["inbound"], ["tun-in"])
                pattern, = bypass["process_path_regex"]
                self.assertRegex(PROXY_PATH, pattern)
                self.assertRegex(PROXY_PATH.lower(), pattern)
                for wrong in (PROXY_PATH + ".evil.exe", "D:" + PROXY_PATH[2:], PROXY_PATH.replace("VPN client", "VPN-client")):
                    self.assertIsNone(re.search(pattern, wrong))
                self.assertEqual(bypass["network"], ["tcp", "udp"])
                self.assertEqual(bypass["outbound"], BYPASS_TAG)
                self.assertEqual(config["route"]["final"], OUTBOUND_TAG)

    def test_rejects_nonlocal_relative_or_wildcard_executable_paths(self):
        for path in ("", "proxy.exe", r"C:proxy.exe", r"\\server\proxy.exe", "/usr/bin/proxy",
                     r"C:\vpn\*.exe", r"C:\vpn\..\proxy.exe", r"C:\vpn\proxy.cmd", "C:\\vpn\\proxy.exe\n"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.config("127.0.0.1:1080", bypass_process_path=path)

    def test_statistics_and_test_proxy_stay_local_and_protected(self):
        config = self.config()
        api = config["experimental"]["clash_api"]
        self.assertEqual(api["external_controller"], "127.0.0.1:39090")
        self.assertEqual(api["secret"], SECRET)
        self.assertEqual(api["access_control_allow_origin"], [])
        self.assertFalse(api["access_control_allow_private_network"])
        self.assertEqual(config["inbounds"][1]["listen"], "127.0.0.1")
        self.assertEqual(config["inbounds"][1]["listen_port"], 39091)
        self.assertTrue(config["log"]["disabled"])

    def test_rejects_colliding_ports_and_weak_secrets(self):
        for values in ({"api_port": True}, {"api_port": 0}, {"proxy_port": 65536},
                       {"proxy_port": 39090}, {"api_secret": "a" * 31},
                       {"api_secret": "a" * 32 + "\n"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.config(**values)

    def test_mutating_one_config_does_not_change_next_session(self):
        first = self.config("127.0.0.1:1080", bypass_process_path=PROXY_PATH)
        first["route"]["rules"].clear()
        first["inbounds"][0]["route_exclude_address"].append("0.0.0.0/0")
        second = self.config()
        self.assertEqual(len(second["route"]["rules"]), 3)
        self.assertEqual(second["inbounds"][0]["route_exclude_address"], list(LOOPBACK_EXCLUDES))


class PinnedWindowsCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured = os.environ.get("FLOWBRIDGE_WINDOWS_SING_BOX")
        cls.binary = Path(configured) if configured else Path(__file__).resolve().parents[1] / "vendor" / f"sing-box-{CORE_VERSION}-windows-amd64" / "sing-box.exe"
        if not cls.binary.is_file() or os.name != "nt":
            raise unittest.SkipTest("Windows pinned core not available; set FLOWBRIDGE_WINDOWS_SING_BOX")
        version = subprocess.run([str(cls.binary), "version"], capture_output=True, text=True, timeout=10, check=True)
        if f"sing-box version {CORE_VERSION}\n" not in version.stdout:
            raise AssertionError("configuration validation needs pinned sing-box")

    def test_real_core_accepts_remote_ipv4_and_local_ipv4_ipv6(self):
        for address, bypass in (("192.168.1.5:38473", None), ("127.0.0.1:1080", PROXY_PATH), ("[::1]:1080", PROXY_PATH)):
            with self.subTest(address=address), tempfile.TemporaryDirectory() as temp:
                config = build_config(parse_global_address(address), 39090, SECRET,
                                      proxy_port=39091, bypass_process_path=bypass)
                path = Path(temp) / "config.json"
                path.write_text(json.dumps(config), encoding="utf-8")
                checked = subprocess.run([str(self.binary), "check", "-c", str(path)], capture_output=True, text=True, timeout=15)
                self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_real_core_accepts_fast_and_compatible_persistent_dns(self):
        for mode in ("fast", "compatible"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                config = build_config(parse_global_address("127.0.0.1:1080"), 39090, SECRET,
                                      proxy_port=39091, bypass_process_path=PROXY_PATH,
                                      dns_mode=mode, cache_path=str(Path(temp) / "dns-cache.db"))
                path = Path(temp) / "config.json"
                path.write_text(json.dumps(config), encoding="utf-8")
                checked = subprocess.run([str(self.binary), "check", "-c", str(path)], capture_output=True, text=True, timeout=15)
                self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
