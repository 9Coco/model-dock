"""Configuration invariants and optional pinned-core schema checks; no TUN start."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

from tun_config import (
    CORE_VERSION, DNS_TAG, DOH_ADDRESS, DOH_SERVER_NAME, INTERFACE_NAME,
    LOOPBACK_EXCLUDES, OUTBOUND_TAG, ROUTE_ADDRESSES, ROUTE_TABLE,
    RULE_COUNT, RULE_INDEX, RULE_LAST, TUN_ADDRESSES, TUN_DNS_ADDRESSES,
    build_config, validate_endpoint, validate_physical_interface,
)


SECRET = "test_only_generated_secret_0123456789abcdef"


def endpoint(host="10.15.60.93", port=38473):
    return SimpleNamespace(host=host, port=port)


class TunConfigTests(unittest.TestCase):
    def config(self, target=None, **kwargs):
        return build_config(target or endpoint(), "wlan0", 39090, SECRET, INTERFACE_NAME, **kwargs)

    def test_fixed_core_and_owned_resources(self):
        self.assertEqual(CORE_VERSION, "1.14.4")
        self.assertEqual(ROUTE_TABLE, 48273)
        self.assertEqual((RULE_INDEX, RULE_LAST, RULE_COUNT), (18273, 18283, 11))
        self.assertLess(RULE_LAST, 32766, "our rules must precede the default main lookup")
        inbound = self.config()["inbounds"][0]
        self.assertEqual(inbound["interface_name"], "modeldock0")
        self.assertEqual(inbound["iproute2_table_index"], ROUTE_TABLE)
        self.assertEqual(inbound["iproute2_rule_index"], RULE_INDEX)
        self.assertTrue(inbound["auto_route"])
        self.assertTrue(inbound["strict_route"])
        self.assertIs(inbound["auto_redirect"], False)

    def test_both_ip_families_are_captured_with_split_defaults(self):
        inbound = self.config()["inbounds"][0]
        self.assertEqual(inbound["address"], list(TUN_ADDRESSES))
        self.assertEqual(inbound["route_address"], list(ROUTE_ADDRESSES))
        self.assertEqual(inbound["route_exclude_address"], list(LOOPBACK_EXCLUDES))
        self.assertNotIn("10.15.60.93/32", inbound["route_exclude_address"])
        self.assertNotIn("10.0.0.0/8", inbound["route_exclude_address"])

    def test_direct_exclusions_are_exact_and_canonical(self):
        config = self.config(bypass_addresses=["172.30.238.94", "FD77:73FB:0:0::10", "fd77:73fb::10",
                                              "172.30.238.94", "127.0.0.2", "::1"])
        inbound = config["inbounds"][0]
        self.assertEqual(inbound["route_address"], list(ROUTE_ADDRESSES))
        self.assertEqual(inbound["route_exclude_address"], [*LOOPBACK_EXCLUDES, "172.30.238.94/32", "fd77:73fb::10/128"])
        self.assertEqual([outbound["tag"] for outbound in config["outbounds"]], [OUTBOUND_TAG])

    def test_rejects_broad_or_internal_exclusions(self):
        invalid = [None, "172.30.238.94", ["192.0.2.1"] * 33]
        invalid += [[item] for item in (None, 1, "172.30.238.0/24", "172.30.238.94:8022",
                    "host.local", "fe80::1%wlan0", "::ffff:192.0.2.1", "::", "0.0.0.0", "224.0.0.1",
                    "ff02::1", "255.255.255.255", "172.31.255.3", "fd42:73fb:4827::2", "198.19.1.1")]
        for entries in invalid:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                self.config(bypass_addresses=entries)

    def test_dns_is_hijacked_before_tcp_udp_routing_and_uses_verified_proxied_doh(self):
        config = self.config()
        inbound = config["inbounds"][0]
        self.assertEqual(inbound["dns_mode"], "hijack")
        self.assertEqual(inbound["dns_address"], list(TUN_DNS_ADDRESSES))
        self.assertEqual(config["route"]["rules"][0], {"port": 53, "action": "hijack-dns"})
        self.assertEqual(config["route"]["rules"][1], {
            "network": ["tcp", "udp"], "action": "route", "outbound": OUTBOUND_TAG,
        })
        self.assertEqual(config["route"]["rules"][-1], {"action": "reject"})
        self.assertEqual(config["dns"]["final"], DNS_TAG)
        self.assertEqual(config["dns"]["strategy"], "ipv4_only")
        self.assertEqual(len(config["dns"]["servers"]), 1)
        server = config["dns"]["servers"][0]
        self.assertEqual(server["type"], "https")
        self.assertEqual(server["server"], DOH_ADDRESS)
        self.assertEqual(server["detour"], OUTBOUND_TAG)
        self.assertEqual(server["tls"], {"enabled": True, "server_name": DOH_SERVER_NAME})
        self.assertNotIn("insecure", server["tls"])

    def test_only_standard_socks5_outbound_and_physical_binding_no_direct_fallback(self):
        config = self.config()
        self.assertEqual(len(config["outbounds"]), 1)
        outbound = config["outbounds"][0]
        self.assertEqual(outbound["type"], "socks")
        self.assertEqual(outbound["version"], "5")
        self.assertIs(outbound["udp_over_tcp"], False)
        self.assertNotIn("network", outbound, "SOCKS5 must enable both TCP and UDP")
        self.assertEqual(outbound["tag"], OUTBOUND_TAG)
        self.assertEqual(outbound["server"], "10.15.60.93")
        self.assertEqual(outbound["server_port"], 38473)
        self.assertEqual(outbound["bind_interface"], "wlan0")
        self.assertEqual(config["route"]["default_interface"], "wlan0")
        self.assertIs(config["route"]["auto_detect_interface"], False)
        self.assertEqual(config["route"]["final"], OUTBOUND_TAG)
        self.assertNotIn('"direct"', json.dumps(config))

    def test_api_is_authenticated_and_loopback_only(self):
        config = self.config()
        api = config["experimental"]["clash_api"]
        self.assertEqual(api["external_controller"], "127.0.0.1:39090")
        self.assertEqual(api["secret"], SECRET)
        self.assertEqual(api["access_control_allow_origin"], [])
        self.assertIs(api["access_control_allow_private_network"], False)
        self.assertNotIn("external_ui", api)
        self.assertEqual(config["log"], {"disabled": True})

    def test_optional_website_test_proxy_is_loopback_and_uses_same_outbound(self):
        self.assertEqual(len(self.config()["inbounds"]), 1)
        config = self.config(proxy_port=39091)
        self.assertEqual(config["inbounds"][1], {
            "type": "http", "tag": "tests-in", "listen": "127.0.0.1", "listen_port": 39091,
        })
        self.assertEqual(config["route"]["rules"][1], {
            "network": ["tcp", "udp"], "action": "route", "outbound": OUTBOUND_TAG,
        })

    def test_ipv6_and_matching_scope_do_not_require_dns(self):
        self.assertEqual(self.config(endpoint("fd00::123"))["outbounds"][0]["server"], "fd00::123")
        scoped = self.config(endpoint("fe80::1%wlan0"))
        self.assertEqual(scoped["outbounds"][0]["server"], "fe80::1%wlan0")
        with self.assertRaisesRegex(ValueError, "作用域"):
            self.config(endpoint("fe80::1%other0"))

    def test_rejects_non_numeric_or_unsafe_upstreams(self):
        for host in ("phone.example", "127.0.0.1", "::1", "0.0.0.0", "::", "224.0.0.1", "ff02::1", "::ffff:127.0.0.1", "::ffff:0.0.0.0", " 10.0.0.1", "10.0.0.1\n", "10.0.0.1/path"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                validate_endpoint(endpoint(host))
        for port in (0, 65536, True, "8080", 1.5):
            with self.subTest(port=port), self.assertRaises(ValueError):
                validate_endpoint(endpoint(port=port))

    def test_interface_and_api_inputs_are_restricted(self):
        for name in ("lo", INTERFACE_NAME, "", "../wlan0", "-i", "x;true", "a" * 16, "eth0\n"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_physical_interface(name)
        for values in (
            {"api_port": 0}, {"api_port": True}, {"api_secret": ""},
            {"api_secret": "s" * 31}, {"api_secret": "s" * 32 + "\n"},
            {"interface_name": "tun999"}, {"proxy_port": True}, {"proxy_port": 39090},
        ):
            args = dict(endpoint=endpoint(), physical_interface="wlan0", api_port=39090,
                        api_secret=SECRET, interface_name=INTERFACE_NAME)
            args.update(values)
            with self.subTest(values=values), self.assertRaises(ValueError):
                build_config(**args)

    def test_fresh_config_does_not_share_mutable_data(self):
        first = self.config()
        first["inbounds"][0]["route_exclude_address"].append("0.0.0.0/0")
        first["dns"]["servers"][0]["detour"] = "direct"
        second = self.config()
        self.assertEqual(second["inbounds"][0]["route_exclude_address"], list(LOOPBACK_EXCLUDES))
        self.assertEqual(second["dns"]["servers"][0]["detour"], OUTBOUND_TAG)


class PinnedCoreCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        default = Path(__file__).resolve().parents[1] / "vendor" / f"sing-box-{CORE_VERSION}-amd64" / "sing-box"
        cls.binary = Path(os.environ.get("FLOWBRIDGE_SING_BOX", str(default)))
        if not cls.binary.is_file():
            raise unittest.SkipTest("pinned sing-box binary not downloaded; set FLOWBRIDGE_SING_BOX")
        version = subprocess.run([str(cls.binary), "version"], check=True, capture_output=True, text=True, timeout=5)
        if f"sing-box version {CORE_VERSION}\n" not in version.stdout:
            raise AssertionError("schema check must use the pinned sing-box version")
        candidates = [path.name for path in Path("/sys/class/net").iterdir() if path.name != "lo"]
        cls.physical = os.environ.get("FLOWBRIDGE_TEST_PHYSICAL_INTERFACE") or next(
            (name for name in candidates if (Path("/sys/class/net") / name / "device").exists()),
            candidates[0] if candidates else "testuplink0",
        )

    def test_actual_core_accepts_ipv4_ipv6_and_test_inbound_configs(self):
        for target, proxy_port in ((endpoint(), None), (endpoint("fd00::123"), None), (endpoint(), 39091)):
            config = build_config(target, self.physical, 39090, SECRET, proxy_port=proxy_port,
                                  bypass_addresses=["172.30.238.94", "fd77:73fb::10"])
            with self.subTest(host=target.host, proxy_port=proxy_port), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.json"
                path.write_text(json.dumps(config), encoding="utf-8")
                checked = subprocess.run([str(self.binary), "check", "-c", str(path)], capture_output=True, text=True, timeout=10)
                self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
