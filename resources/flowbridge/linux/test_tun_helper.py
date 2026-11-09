"""Privileged-helper checks with temporary files and fake network commands.

No test runs ip/pkexec/sing-box, changes routes, or signals a real process.
"""

import io
from contextlib import ExitStack
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import tun_helper as helper


class FakeIP:
    def __init__(self):
        self.calls = []
        self.rules = {4: [{"priority": 32766, "table": "main"}],
                      6: [{"priority": 32766, "table": "main"}]}
        self.routes = {4: [{"dst": "default", "table": "main", "dev": "eth0"}], 6: []}
        self.links = [{"ifindex": 2, "ifname": "eth0", "link_type": "ether"}]
        self.upstream = "eth0"
        self.reject_deletes = False

    def populate_owned(self):
        start, table, last = helper.RULE_INDEX, str(helper.ROUTE_TABLE), helper.RULE_LAST
        # These spellings are from iproute2 JSON captured with the pinned core
        # inside an isolated namespace, including null not/nop markers.
        self.rules[4] += [
            {"priority": start, "src": "all", "dst": "172.31.255.0", "dstlen": 30, "table": table},
            {"priority": start + 1, "src": "all", "table": table, "suppress_prefixlen": 0},
            {"priority": start + 2, "not": None, "src": "all", "dport": 53, "dport_mask": "0xffff", "table": "main", "suppress_prefixlen": 0},
            {"priority": start + 2, "src": "all", "iif": helper.INTERFACE_NAME, "goto": last},
            {"priority": start + 3, "not": None, "src": "all", "iif": "lo", "table": table},
            {"priority": start + 3, "src": "0.0.0.0", "iif": "lo", "table": table},
            {"priority": start + 3, "src": "172.31.255.0", "srclen": 30, "iif": "lo", "table": table},
            {"priority": last, "src": "all", "nop": None},
        ]
        self.rules[6] += [
            {"priority": start, "src": "all", "table": table, "suppress_prefixlen": 0},
            {"priority": start + 1, "not": None, "src": "all", "dport": 53, "dport_mask": "0xffff", "table": "main", "suppress_prefixlen": 0},
            {"priority": start + 1, "src": "fd42:73fb:4827::", "srclen": 126, "iif": "lo", "table": table},
            {"priority": start + 2, "src": "all", "iif": helper.INTERFACE_NAME, "goto": last},
            {"priority": start + 2, "src": "::", "srclen": 1, "iif": "lo", "goto": last},
            {"priority": start + 2, "src": "8000::", "srclen": 1, "iif": "lo", "goto": last},
            {"priority": start + 3, "src": "all", "table": table},
            {"priority": last, "src": "all", "nop": None},
        ]
        for family in (4, 6):
            self.routes[family].append({"dst": "default", "table": helper.ROUTE_TABLE, "dev": helper.INTERFACE_NAME})
        self.links.append({"ifindex": 7, "ifname": helper.INTERFACE_NAME, "link_type": "none",
                           "linkinfo": {"info_kind": "tun"}})

    def __call__(self, command):
        self.calls.append(command)
        args = [item for item in command[1:] if item != "-N"]
        family = 6 if "-6" in args else 4
        value = None
        code = 0
        if "-j" in args:
            if "rule" in args:
                value = self.rules[family]
            elif "link" in args:
                value = self.links
            elif "get" in args:
                value = [{"dev": self.upstream}]
            else:
                value = self.routes[family]
        elif self.reject_deletes:
            code = 2
        elif "rule" in args:
            priority = int(args[args.index("pref") + 1])
            def option(name, default=None): return args[args.index(name) + 1] if name in args else default
            for index, rule in enumerate(self.rules[family]):
                normal = helper.RouteResources._normal_rule(rule, family)
                if (rule["priority"] == priority
                        and normal.get("src", "all") == option("from", "all")
                        and normal.get("dst", "all") == option("to", "all")
                        and bool(normal.get("not")) == ("not" in args)
                        and normal.get("iif") == option("iif")
                        and str(normal.get("table")) == option("table", "None")
                        and str(normal.get("goto")) == option("goto", "None")
                        and (normal.get("action") == "nop") == ("nop" in args)
                        and str(normal.get("dport")) == option("dport", "None")
                        and str(normal.get("suppress_prefixlength")) == option("suppress_prefixlength", "None")):
                    self.rules[family].pop(index)
                    break
        elif "route" in args and "del" in args:
            table = args[args.index("table") + 1]
            device = args[args.index("dev") + 1]
            destination = args[args.index("unicast") + 1]
            for index, route in enumerate(self.routes[family]):
                if (str(route.get("table")) == table and route.get("dev") == device
                        and route.get("dst", "default") == destination):
                    self.routes[family].pop(index)
                    break
        elif "delete" in args:
            self.links = [row for row in self.links if row["ifname"] != args[-1]]
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, code, json.dumps(value) if value is not None else "", "")


class ValidationTests(unittest.TestCase):
    def test_requires_root_and_real_nonroot_authorization_identity(self):
        with patch.object(helper.os, "geteuid", return_value=1000), self.assertRaises(helper.HelperError):
            helper.validate_invoker({"PKEXEC_UID": "1000"})
        with patch.object(helper.os, "geteuid", return_value=0):
            for value in (None, "", "0", "-1", "1; true", "99999999999"):
                with self.subTest(value=value), self.assertRaises(helper.HelperError):
                    helper.validate_invoker({"PKEXEC_UID": value})
            with patch.object(helper.pwd, "getpwuid", side_effect=KeyError), self.assertRaises(helper.HelperError):
                helper.validate_invoker({"PKEXEC_UID": "1234"})
            with patch.object(helper.pwd, "getpwuid", return_value=SimpleNamespace(pw_uid=1234)):
                self.assertEqual(helper.validate_invoker({"PKEXEC_UID": "1234"}), 1234)

    def test_endpoint_whitelist(self):
        for host in ("192.0.2.1", "2001:db8::1"):
            result = helper.validate_request({"version": 2, "host": host, "port": 38473})
            self.assertEqual((result.host, result.port), (host, 38473))
        bad = [
            {"version": True, "host": "192.0.2.1", "port": 38473},
            {"version": 2, "host": "example.org", "port": 38473},
            {"version": 2, "host": "127.0.0.1", "port": 38473},
            {"version": 2, "host": "::1", "port": 38473},
            {"version": 2, "host": "fe80::1%eth0", "port": 38473},
            {"version": 2, "host": "0.0.0.0", "port": 38473},
            {"version": 2, "host": "224.0.0.1", "port": 38473},
            {"version": 2, "host": "255.255.255.255", "port": 38473},
            {"version": 2, "host": "192.0.2.1", "port": True},
            {"version": 2, "host": "192.0.2.1", "port": "38473"},
            {"version": 2, "host": "192.0.2.1", "port": 0},
            {"version": 2, "host": "192.0.2.1", "port": 65536},
            {"version": 2, "host": "192.0.2.1", "port": 38473, "config": "/tmp/unsafe"},
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(helper.HelperError):
                helper.validate_request(value)

    def test_root_path_checks_every_parent_and_file(self):
        target = Path("/opt/modeldock-network/tun_helper.py")
        def metadata(path):
            return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFREG | 0o644) if path == target else (stat.S_IFDIR | 0o755))
        with patch.object(Path, "lstat", autospec=True, side_effect=metadata):
            self.assertEqual(helper.require_root_path(target), target)
        for unsafe_path, mode, uid in ((target, stat.S_IFREG | 0o664, 0),
                                       (Path("/opt"), stat.S_IFDIR | 0o777, 0),
                                       (Path("/opt/modeldock-network"), stat.S_IFLNK | 0o777, 0),
                                       (target, stat.S_IFREG | 0o644, 1000)):
            def bad_metadata(path):
                return SimpleNamespace(st_uid=uid, st_mode=mode) if path == unsafe_path else metadata(path)
            with self.subTest(path=unsafe_path, mode=mode), patch.object(Path, "lstat", autospec=True, side_effect=bad_metadata):
                with self.assertRaises(helper.HelperError):
                    helper.require_root_path(target)

    def test_bounded_json_rejects_duplicates_and_invalid_encoding(self):
        for data in (b"", b"x" * 4097, b'{"port":1,"port":2}', b"\xff", b"not json"):
            with self.subTest(data=data[:40]), self.assertRaises(helper.HelperError):
                helper.decode_message(data)

    def test_pipe_messages_stop_eof_and_overlong_input(self):
        read_fd, write_fd = os.pipe()
        reader = helper.MessageReader(read_fd)
        try:
            os.write(write_fd, b'{"version":2,"host":"192.0.2.1","port":38473}\n{"command":"stop"}\n')
            self.assertEqual(reader.poll(.1)["version"], 2)
            self.assertEqual(reader.poll(.1), {"command": "stop"})
            os.close(write_fd)
            write_fd = None
            self.assertIs(reader.poll(.1), helper.EOF)
        finally:
            reader.close()
            os.close(read_fd)
            if write_fd is not None: os.close(write_fd)

        read_fd, write_fd = os.pipe()
        reader = helper.MessageReader(read_fd)
        try:
            os.write(write_fd, b"x" * (helper.MAX_MESSAGE_BYTES + 1))
            with self.assertRaises(helper.HelperError): reader.poll(.1)
        finally:
            reader.close(); os.close(read_fd); os.close(write_fd)

    def test_config_load_uses_validated_source_instead_of_bytecode(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source = "\n".join(f"{key} = {getattr(helper, key)!r}" for key in (
                "CORE_VERSION", "ROUTE_TABLE", "RULE_INDEX", "RULE_COUNT", "INTERFACE_NAME"))
            (root / "tun_config.py").write_text(source + "\ndef build_config(*args, **kwargs): return 'source'\n")
            cache = root / "__pycache__"
            cache.mkdir()
            (cache / "tun_config.cpython-310.pyc").write_bytes(b"not trusted bytecode")
            with patch.object(helper, "SOURCE_DIR", root), patch.object(helper, "require_root_path") as safety:
                self.assertEqual(helper._load_config_builder()(), "source")
                safety.assert_called_once_with(root / "tun_config.py")

    def test_preflight_error_acknowledges_that_no_changes_were_made(self):
        output = io.StringIO()
        with patch.object(helper.os, "umask"), patch.object(helper.sys, "argv", ["helper"]), \
             patch.object(helper.sys, "stdout", output), \
             patch.object(helper, "validate_invoker", side_effect=helper.HelperError("test denied")), \
             patch.object(helper, "run_command") as command:
            self.assertEqual(helper.main(), 0)
            self.assertEqual([json.loads(line)["event"] for line in output.getvalue().splitlines()], ["error", "stopped"])
            command.assert_not_called()

    def test_process_identity_ignores_zombie_dead_and_malformed_stat(self):
        for state in ("S", "Z", "X", "x"):
            data = "42 (helper with ) bracket) " + " ".join([state, *(["0"] * 18), "123456"])
            with self.subTest(state=state), patch.object(Path, "read_text", return_value=data):
                self.assertEqual(helper.process_start_time(42), 123456 if state == "S" else None)
        with patch.object(Path, "read_text", return_value="malformed"):
            self.assertIsNone(helper.process_start_time(42))


class RouteResourcesTests(unittest.TestCase):
    def setUp(self):
        self.ip = FakeIP()
        self.resources = helper.RouteResources("/fake/ip", self.ip)

    def test_preflight_refuses_all_reserved_collisions_without_mutations(self):
        for collision in ("v4rule", "v6rule", "v4table", "v6table", "interface"):
            with self.subTest(collision=collision):
                self.ip = FakeIP()
                self.resources = helper.RouteResources("/fake/ip", self.ip)
                if collision.endswith("rule"):
                    self.ip.rules[6 if collision.startswith("v6") else 4].append({"priority": helper.RULE_LAST, "action": "nop"})
                elif collision.endswith("table"):
                    self.ip.routes[6 if collision.startswith("v6") else 4].append({"table": helper.ROUTE_TABLE, "dev": "other0"})
                else:
                    self.ip.links.append({"ifname": helper.INTERFACE_NAME})
                with self.assertRaises(helper.HelperError): self.resources.assert_available()
                self.resources.cleanup()
                self.assertTrue(all("-j" in command for command in self.ip.calls))

    def test_killed_core_cleanup_removes_only_previously_empty_reserved_resources(self):
        self.resources.assert_available()
        self.ip.populate_owned()
        self.resources.note_interface()
        self.resources.cleanup()
        self.assertFalse(self.resources.claimed)
        for family in (4, 6):
            self.assertEqual(self.ip.rules[family], [{"priority": 32766, "table": "main"}])
            self.assertFalse(any(row.get("table") == helper.ROUTE_TABLE for row in self.ip.routes[family]))
        self.assertEqual([row["ifname"] for row in self.ip.links], ["eth0"])
        self.assertTrue(all("-N" in command for command in self.ip.calls if "-j" in command))
        self.assertFalse(any("nft" in command for command in self.ip.calls))

    def test_cleanup_is_idempotent(self):
        self.resources.assert_available()
        self.ip.populate_owned()
        self.resources.cleanup()
        initial = list(self.ip.calls)
        self.resources.cleanup()
        self.assertEqual(self.ip.calls, initial)

    def test_successful_recovery_does_not_reuse_old_interface_identity_for_new_session(self):
        self.resources.assert_available(); self.ip.populate_owned(); self.resources.note_interface()
        self.resources.capture_ownership(); self.resources.core_started = True
        self.resources.cleanup()
        self.assertIsNone(self.resources.ifindex)
        self.assertIsNone(self.resources.ownership)
        self.assertFalse(self.resources.core_started)
        self.resources.assert_available(); self.ip.populate_owned()
        self.ip.links[-1]["ifindex"] = 99
        self.resources.note_interface(); self.resources.capture_ownership()
        self.resources.cleanup()
        self.assertFalse(self.resources.claimed)

    def test_cleanup_failure_cannot_claim_success(self):
        self.resources.assert_available()
        self.ip.populate_owned()
        self.ip.reject_deletes = True
        with self.assertRaises(helper.HelperError): self.resources.cleanup()
        self.assertTrue(self.resources.claimed)

    def test_replaced_interface_is_not_deleted(self):
        self.resources.assert_available()
        self.ip.populate_owned()
        self.resources.note_interface()
        self.ip.links[-1]["ifindex"] = 99
        foreign_rule = {"priority": helper.RULE_INDEX, "table": 99999}
        foreign_route = {"dst": "default", "table": helper.ROUTE_TABLE, "dev": "eth0"}
        self.ip.rules[4] = [foreign_rule]
        self.ip.routes[4] = [foreign_route]
        with self.assertRaises(helper.HelperError): self.resources.cleanup()
        self.assertTrue(any(row["ifname"] == helper.INTERFACE_NAME for row in self.ip.links))
        self.assertTrue(all("-j" in command for command in self.ip.calls))
        self.assertEqual(self.ip.rules[4], [foreign_rule])
        self.assertEqual(self.ip.routes[4], [foreign_route])

    def test_foreign_rule_or_route_prevents_every_cleanup_mutation(self):
        for kind in ("rule", "route", "changed_known_rule"):
            with self.subTest(kind=kind):
                ip = FakeIP(); resources = helper.RouteResources("/fake/ip", ip)
                resources.assert_available(); ip.populate_owned(); resources.note_interface(); resources.capture_ownership()
                if kind == "rule":
                    ip.rules[6].append({"priority": helper.RULE_INDEX + 4, "table": 99999})
                elif kind == "route":
                    ip.routes[4].append({"table": helper.ROUTE_TABLE, "dst": "192.0.2.0/24", "dev": "eth0"})
                else:
                    # Signature is one of ours, but an extra duplicate was not in
                    # the readiness snapshot. Multiset comparison detects it.
                    ip.rules[4].append(dict(ip.rules[4][1]))
                before = json.dumps([ip.rules, ip.routes, ip.links], sort_keys=True)
                with self.assertRaises(helper.HelperError): resources.cleanup()
                self.assertEqual(json.dumps([ip.rules, ip.routes, ip.links], sort_keys=True), before)
                self.assertTrue(all("-j" in command for command in ip.calls))

    def test_partial_core_cleanup_is_allowed_but_new_objects_are_not(self):
        self.resources.assert_available(); self.ip.populate_owned(); self.resources.note_interface()
        self.resources.capture_ownership()
        self.ip.rules[4].pop()
        self.ip.routes[6] = []
        self.resources.cleanup()
        self.assertFalse(self.resources.claimed)
        self.assertFalse(any("flush" in call for call in self.ip.calls))
        deleted = [call for call in self.ip.calls if "rule" in call and "del" in call]
        self.assertTrue(all("from" in call and "to" in call for call in deleted))
        self.assertTrue(any("not" in call and "dport" in call for call in deleted))

    def test_detached_kernel_marker_matches_only_the_recorded_missing_tun(self):
        self.resources.assert_available(); self.ip.populate_owned(); self.resources.note_interface()
        self.resources.capture_ownership()
        self.ip.links = [row for row in self.ip.links if row["ifname"] != helper.INTERFACE_NAME]
        for family in (4, 6):
            self.ip.routes[family] = [row for row in self.ip.routes[family] if row.get("dev") != helper.INTERFACE_NAME]
            for row in self.ip.rules[family]:
                if row.get("iif") == helper.INTERFACE_NAME: row["iif_detached"] = None
        self.resources.cleanup()
        self.assertFalse(self.resources.claimed)
        self.assertEqual(self.ip.rules[4], [{"priority": 32766, "table": "main"}])

    def test_detached_marker_does_not_hide_foreign_or_live_interface_changes(self):
        for conflict in ("live_interface", "other_iif", "changed_goto", "no_snapshot"):
            with self.subTest(conflict=conflict):
                ip = FakeIP(); resources = helper.RouteResources("/fake/ip", ip)
                resources.assert_available(); ip.populate_owned(); resources.note_interface(); resources.capture_ownership()
                rule = next(row for row in ip.rules[4] if row.get("iif") == helper.INTERFACE_NAME)
                rule["iif_detached"] = None
                if conflict != "live_interface": ip.links.pop()
                if conflict == "other_iif": rule["iif"] = "eth0"
                if conflict == "changed_goto": rule["goto"] = helper.RULE_LAST + 1
                if conflict == "no_snapshot": resources.ownership = None
                with self.assertRaises(helper.HelperError): resources.cleanup()
                self.assertTrue(all("-j" in command for command in ip.calls))

    def test_failed_startup_detached_rules_recover_with_fixed_core_spawn_evidence(self):
        self.resources.assert_available(); self.ip.populate_owned()
        self.resources.core_started = True
        self.ip.links.pop()
        for family in (4, 6):
            self.ip.routes[family] = [row for row in self.ip.routes[family] if row.get("dev") != helper.INTERFACE_NAME]
            for row in self.ip.rules[family]:
                if row.get("iif") == helper.INTERFACE_NAME: row["iif_detached"] = None
        self.assertIsNone(self.resources.ifindex)
        self.assertIsNone(self.resources.ownership)
        self.resources.cleanup()
        self.assertFalse(self.resources.claimed)

    def test_upstream_route_rejects_tun_and_loopback(self):
        self.assertEqual(self.resources.upstream_interface("192.0.2.1"), "eth0")
        for name, kind, link_type in (("tun0", "tun", "none"), ("vpn0", "", "none"),
                                      ("lo", "", "loopback"), ("masked0", "wireguard", "none")):
            with self.subTest(name=name):
                self.ip.upstream = name
                self.ip.links = [{"ifname": name, "link_type": link_type, "linkinfo": {"info_kind": kind}}]
                with self.assertRaises(helper.HelperError): self.resources.upstream_interface("192.0.2.1")


class FakeCore:
    pid = 99999
    def __init__(self): self.returncode = None; self.actions = []
    def poll(self): return self.returncode
    def terminate(self): self.actions.append("term"); self.returncode = 0
    def kill(self): self.actions.append("kill"); self.returncode = -9
    def wait(self, timeout=None): return self.returncode


class FakeResources:
    def __init__(self, fail_cleanup=False): self.calls = []; self.fail_cleanup = fail_cleanup; self.ifindex = 7
    def assert_available(self): self.calls.append("claim")
    def upstream_interface(self, host): self.calls.append("interface"); return "eth0"
    def assert_owned(self): self.calls.append("owned")
    def cleanup(self):
        self.calls.append("cleanup")
        if self.fail_cleanup: raise helper.HelperError("fake cleanup incomplete")


class FakeReader:
    def __init__(self, messages): self.messages = iter(messages)
    def poll(self, timeout=0): return next(self.messages, None)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = patch.object(helper, "RUNTIME_DIR", Path(self.temp.name))
        self.runtime.start(); self.addCleanup(self.runtime.stop)
        self.ports = patch.object(helper, "_reserve_ports", return_value=[40001, 40002])
        self.ports.start(); self.addCleanup(self.ports.stop)

    def session(self, messages, fail_cleanup=False):
        output = io.StringIO()
        resources = FakeResources(fail_cleanup)
        process = FakeCore()
        popen_calls = []
        def popen(*args, **kwargs): popen_calls.append((args, kwargs)); return process
        def command(args): return subprocess.CompletedProcess(args, 0, "sing-box version 1.14.4\n", "")
        session = helper.HelperSession(resources, FakeReader(messages), output, threading.Event(),
                                       lambda *args, **kwargs: {"log": {"disabled": True}},
                                       popen=popen, command=command)
        return session, resources, process, output, popen_calls

    def test_eof_stops_core_and_acknowledges_after_cleanup(self):
        session, resources, process, output, calls = self.session([None, helper.EOF])
        with patch.object(session, "wait_ready"):
            self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events], ["ready", "stopped"])
        self.assertEqual(events[0]["proxy_port"], 40002)
        self.assertEqual(process.actions, ["term"])
        self.assertEqual(resources.calls[-1], "cleanup")
        self.assertNotIn("LD_PRELOAD", calls[0][1]["env"])
        self.assertTrue(calls[0][1]["close_fds"])
        self.assertFalse(session.work_dir.exists())

    def test_stop_command_and_signal_share_cleanup(self):
        for signal_stop in (False, True):
            with self.subTest(signal_stop=signal_stop):
                session, resources, process, output, _ = self.session([None, {"command": "stop"}])
                def ready(*args):
                    if signal_stop: session.stop_event.set()
                with patch.object(session, "wait_ready", side_effect=ready):
                    self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 0)
                self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["event"], "stopped")
                self.assertEqual(resources.calls[-1], "cleanup")

    def test_core_sigkill_reports_error_then_cleanup_ack(self):
        session, resources, process, output, _ = self.session([None, None])
        def ready(*args): process.returncode = -9
        with patch.object(session, "wait_ready", side_effect=ready):
            self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 0)
        self.assertEqual([json.loads(line)["event"] for line in output.getvalue().splitlines()], ["ready", "error", "stopped"])
        self.assertEqual(process.actions, [])
        self.assertEqual(resources.calls[-1], "cleanup")

    def test_failed_cleanup_has_no_stopped_and_retains_workspace(self):
        session, _, _, output, _ = self.session([None, helper.EOF], fail_cleanup=True)
        with patch.object(session, "wait_ready"):
            self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 1)
        self.assertNotIn("stopped", [json.loads(line)["event"] for line in output.getvalue().splitlines()])
        self.assertTrue(session.work_dir.exists())

    def test_start_failure_is_cleaned_before_ack(self):
        session, resources, _, output, _ = self.session([None])
        with patch.object(session, "wait_ready", side_effect=helper.HelperError("fake startup failure")):
            self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 0)
        self.assertEqual([json.loads(line)["event"] for line in output.getvalue().splitlines()], ["error", "stopped"])
        self.assertEqual(resources.calls[-1], "cleanup")

    def test_core_dies_before_ready_snapshot_cleans_detached_partial_startup(self):
        session, _, process, output, _ = self.session([None])
        ip = FakeIP(); session.resources = helper.RouteResources("/fake/ip", ip)
        def failed_ready(*args):
            ip.populate_owned(); ip.links.pop()
            for family in (4, 6):
                ip.routes[family] = [row for row in ip.routes[family] if row.get("dev") != helper.INTERFACE_NAME]
                for row in ip.rules[family]:
                    if row.get("iif") == helper.INTERFACE_NAME: row["iif_detached"] = None
            process.returncode = -9
            raise helper.HelperError("core died before readiness")
        with patch.object(session, "wait_ready", side_effect=failed_ready):
            self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 0)
        self.assertEqual([json.loads(line)["event"] for line in output.getvalue().splitlines()], ["error", "stopped"])
        self.assertTrue(all(len(ip.rules[family]) == 1 for family in (4, 6)))

    def test_ownership_conflict_preserves_foreign_resources_and_never_sends_term(self):
        for dead_core in (False, True):
            with self.subTest(dead_core=dead_core):
                session, _, process, output, _ = self.session([None, {"command": "stop"}])
                ip = FakeIP(); session.resources = helper.RouteResources("/fake/ip", ip)
                def ready(*args):
                    ip.populate_owned(); session.resources.note_interface(); session.resources.capture_ownership()
                    ip.links[-1]["ifindex"] = 99
                    ip.rules[4] = [{"priority": helper.RULE_INDEX, "table": 99999}]
                    ip.routes[4] = [{"dst": "default", "table": helper.ROUTE_TABLE, "dev": "eth0"}]
                    if dead_core: process.returncode = -9
                with patch.object(session, "wait_ready", side_effect=ready):
                    self.assertEqual(session.run(SimpleNamespace(host="192.0.2.1", port=38473)), 1)
                self.assertEqual(process.actions, [] if dead_core else ["kill"])
                self.assertTrue(all("-j" in call for call in ip.calls))
                self.assertEqual(ip.rules[4][0]["table"], 99999)
                self.assertEqual(ip.routes[4][0]["dev"], "eth0")
                self.assertTrue(session.work_dir.exists())
                self.assertNotIn("stopped", [json.loads(line)["event"] for line in output.getvalue().splitlines()])

    def test_stop_escalates_only_its_process_after_timeout(self):
        process = FakeCore()
        process.terminate = lambda: process.actions.append("term")
        answers = iter((subprocess.TimeoutExpired("core", 5), 0))
        def wait(timeout=None):
            answer = next(answers)
            if isinstance(answer, Exception): raise answer
            return answer
        process.wait = wait
        helper.stop_core(process)
        self.assertEqual(process.actions, ["term", "kill"])


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = patch.object(helper, "RUNTIME_DIR", self.root)
        self.runtime.start(); self.addCleanup(self.runtime.stop)
        # Ownership checks are tested separately; files here belong to the test user.
        self.safety = patch.object(helper, "require_root_path")
        self.safety.start(); self.addCleanup(self.safety.stop)
        self.journal = helper.SessionJournal(1000, self.root / "session.json")
        self.journal.begin()
        self.journal.value.update(helper_pid=987654321, helper_start=1)
        self.journal._write()

    def test_stale_journal_recovers_reserved_resources_and_clears_record(self):
        ip = FakeIP(); ip.populate_owned()
        resources = helper.RouteResources("/fake/ip", ip)
        self.assertTrue(self.journal.recover(resources))
        self.assertFalse(self.journal.path.exists())
        self.assertFalse(resources.claimed)
        self.assertEqual(ip.rules[4], [{"priority": 32766, "table": "main"}])

    def test_stale_partial_startup_journal_recovers_before_any_ready_snapshot(self):
        self.journal.spawn_attempt()
        ip = FakeIP(); ip.populate_owned(); ip.links.pop()
        for family in (4, 6):
            ip.routes[family] = [row for row in ip.routes[family] if row.get("dev") != helper.INTERFACE_NAME]
            for row in ip.rules[family]:
                if row.get("iif") == helper.INTERFACE_NAME: row["iif_detached"] = None
        resources = helper.RouteResources("/fake/ip", ip)
        self.assertTrue(self.journal.recover(resources))
        self.assertFalse(self.journal.path.exists())
        self.assertTrue(all(len(ip.rules[family]) == 1 for family in (4, 6)))

    def test_foreign_uid_or_live_owner_cannot_be_recovered(self):
        resources = FakeResources()
        self.journal.value["uid"] = 1001
        self.journal._write()
        with self.assertRaises(helper.HelperError): self.journal.recover(resources)
        self.assertEqual(resources.calls, [])
        self.journal.value["uid"] = 1000
        self.journal._write()
        with patch.object(helper, "process_start_time", return_value=1), self.assertRaises(helper.HelperError):
            self.journal.recover(resources)
        self.assertEqual(resources.calls, [])

    def test_stale_core_is_signalled_only_after_identity_match(self):
        work = self.root / "session-test"
        work.mkdir()
        self.journal.workspace(work)
        self.journal.value.update(core_pid=12345, core_start=99)
        self.journal._write()
        alive = True
        def matches(pid, value): return pid == 12345 and alive
        def fake_kill(pid, sig):
            nonlocal alive
            self.assertEqual((pid, sig), (12345, signal.SIGTERM))
            alive = False
        resources = FakeResources()
        with patch.object(Path, "iterdir", return_value=iter([Path("/proc/12345")])), \
             patch.object(helper.SessionJournal, "_matches_core", side_effect=matches), \
             patch.object(helper, "process_start_time", side_effect=lambda pid: 99 if pid == 12345 else None), \
             patch.object(helper.os, "kill", side_effect=fake_kill) as kill:
            self.assertTrue(self.journal.recover(resources))
            self.assertEqual(kill.call_count, 1)
        self.assertFalse(work.exists())

    def test_stale_recovery_conflict_kills_core_but_preserves_foreign_state_and_journal(self):
        work = self.root / "session-conflict"; work.mkdir()
        self.journal.workspace(work)
        ip = FakeIP(); resources = helper.RouteResources("/fake/ip", ip)
        resources.assert_available(); ip.populate_owned(); resources.note_interface()
        ownership = resources.capture_ownership()
        self.journal.interface(7, ownership)
        ip.rules[4].append({"priority": helper.RULE_INDEX + 4, "table": 99999})
        alive = True
        def matches(pid, value): return pid == 12345 and alive
        def kill(pid, signum):
            nonlocal alive
            self.assertEqual((pid, signum), (12345, signal.SIGKILL)); alive = False
        with patch.object(Path, "iterdir", return_value=iter([Path("/proc/12345")])), \
             patch.object(helper.SessionJournal, "_matches_core", side_effect=matches), \
             patch.object(helper, "process_start_time", side_effect=lambda pid: 99 if pid == 12345 else None), \
             patch.object(helper.os, "kill", side_effect=kill):
            with self.assertRaises(helper.HelperError): self.journal.recover(resources)
        self.assertTrue(self.journal.path.exists())
        self.assertTrue(work.exists())
        self.assertEqual(ip.rules[4][-1]["table"], 99999)
        self.assertTrue(all("-j" in call for call in ip.calls))

    def test_journal_accepts_bounded_realistic_large_route_snapshot(self):
        ownership = {"rules4": [], "rules6": [], "routes4": [], "routes6": [
            {"dst": f"2001:db8::{index:x}/128", "table": helper.ROUTE_TABLE,
             "gateway": "fd42:73fb:4827::2", "dev": helper.INTERFACE_NAME,
             "metric": 1024, "flags": [], "pref": "medium"}
            for index in range(128)
        ]}
        self.journal.interface(7, ownership)
        self.assertGreater(self.journal.path.stat().st_size, 8192)
        self.assertEqual(self.journal._read()["ownership"], ownership)
        self.journal.path.write_bytes(b"x" * 262145)
        with self.assertRaises(helper.HelperError): self.journal._read()

    def test_core_identity_checks_starttime_executable_uid_and_exact_args(self):
        work = str(self.root / "session-test")
        value = {"work_dir": work, "core_pid": 12345, "core_start": 99}
        command = b"\0".join([os.fsencode(helper.CORE_PATH), b"run", b"-c", os.fsencode(Path(work) / "config.json")]) + b"\0"
        with patch.object(helper, "process_start_time", return_value=99), \
             patch.object(Path, "resolve", return_value=helper.CORE_PATH), \
             patch.object(Path, "read_text", return_value="Uid:\t0\t0\t0\t0\n"), \
             patch.object(Path, "read_bytes", return_value=command):
            self.assertTrue(self.journal._matches_core(12345, value))
            with patch.object(helper, "process_start_time", return_value=100):
                self.assertFalse(self.journal._matches_core(12345, value))
            with patch.object(Path, "resolve", return_value=Path("/usr/bin/other")):
                self.assertFalse(self.journal._matches_core(12345, value))
            with patch.object(Path, "read_text", return_value="Uid:\t1000\t1000\t1000\t1000\n"):
                self.assertFalse(self.journal._matches_core(12345, value))
            with patch.object(Path, "read_bytes", return_value=b"unrelated\0"):
                self.assertFalse(self.journal._matches_core(12345, value))


class RecoveryProtocolTests(unittest.TestCase):
    def test_recovery_request_has_exact_fields_and_version_type(self):
        self.assertTrue(helper.is_recovery_request({"version": 1, "command": "recover"}))
        for message in ({"version": True, "command": "recover"}, {"version": 2, "command": "recover"},
                        {"version": 1, "command": "recover", "host": "192.0.2.1"},
                        {"version": 1, "command": "stop"}, [1, "recover"]):
            with self.subTest(message=message):
                self.assertFalse(helper.is_recovery_request(message))
                with self.assertRaises(helper.HelperError): helper.validate_request(message)

    def test_recovery_protocol_never_starts_a_new_core_and_acknowledges_only_success(self):
        for result in (False, True, helper.HelperError("foreign scope conflict")):
            with self.subTest(result=result):
                output = io.StringIO()
                journal = Mock()
                journal.recover.side_effect = result if isinstance(result, Exception) else None
                journal.recover.return_value = result
                reader = FakeReader([{"version": 1, "command": "recover"}])
                reader.close = Mock()
                with ExitStack() as stack:
                    for target, value in (("validate_invoker", lambda: 1000), ("validate_installation", lambda: None),
                                          ("_load_config_builder", Mock()), ("find_ip_command", lambda: "/fake/ip"),
                                          ("_prepare_runtime", lambda: None), ("MessageReader", lambda fd: reader),
                                          ("SessionJournal", lambda uid: journal)):
                        stack.enter_context(patch.object(helper, target, value))
                    stack.enter_context(patch.object(helper.os, "umask"))
                    stack.enter_context(patch.object(helper.signal, "signal"))
                    stack.enter_context(patch.object(helper.sys, "argv", ["helper"]))
                    stack.enter_context(patch.object(helper.sys, "stdin", SimpleNamespace(fileno=lambda: 123)))
                    stack.enter_context(patch.object(helper.sys, "stdout", output))
                    session = stack.enter_context(patch.object(helper, "HelperSession"))
                    self.assertEqual(helper.main(), 1 if isinstance(result, Exception) else 0)
                    session.assert_not_called()
                events = [json.loads(line)["event"] for line in output.getvalue().splitlines()]
                self.assertEqual(events, ["error"] if isinstance(result, Exception) else ["stopped"])
                journal.recover.assert_called_once()
                reader.close.assert_called_once()


class GlobalProtocolVersionTests(unittest.TestCase):
    def test_old_tcp_only_session_protocol_is_rejected(self):
        with self.assertRaises(helper.HelperError):
            helper.validate_request({"version": 1, "host": "192.0.2.1", "port": 38473})
        self.assertTrue(helper.is_recovery_request({"version": 1, "command": "recover"}))


class ReusableProtocolTests(unittest.TestCase):
    @staticmethod
    def start(session_id=1, host="192.0.2.1"):
        return {"version": 3, "command": "start", "id": session_id, "host": host, "port": 38473}

    @staticmethod
    def stop(session_id=1):
        return {"version": 3, "command": "stop", "id": session_id}

    def test_v3_start_and_stop_have_exact_fields_and_types(self):
        endpoint = helper.validate_reusable_request(self.start(), command="start")
        self.assertEqual((endpoint.host, endpoint.port), ("192.0.2.1", 38473))
        helper.validate_reusable_request(self.stop(), command="stop", session_id=1)
        bad_starts = [self.start(value) for value in (True, 0, -1, 1.0, 2 ** 31)]
        bad_starts += [{**self.start(), "version": True}, {**self.start(), "version": 2},
                       {**self.start(), "config": "/tmp/untrusted"},
                       {**self.start(), "command": "exec"}, self.start(host="example.org"),
                       self.start(host="127.0.0.1"), self.start(host="0.0.0.0")]
        for request in bad_starts:
            with self.subTest(request=request), self.assertRaises(helper.HelperError):
                helper.validate_reusable_request(request, command="start")
        for request in (self.stop(2), {**self.stop(), "host": "192.0.2.1"},
                        {"command": "stop"}, {**self.stop(), "id": True}):
            with self.subTest(request=request), self.assertRaises(helper.HelperError):
                helper.validate_reusable_request(request, command="stop", session_id=1)

    def broker(self, messages, *, result=0, stop_event=None):
        output = io.StringIO()
        calls = []
        stop_event = stop_event or threading.Event()
        def factory(resources, reader, tagged_output, event, build_config, journal):
            class Session:
                def run(self, endpoint):
                    calls.append((resources, journal, endpoint))
                    tagged_output.write('{"event":"ready"}\n')
                    request = reader.poll()
                    if request is not helper.EOF:
                        self.assert_stop(request)
                    if result == 0:
                        tagged_output.write('{"event":"stopped"}\n')
                    return result
                @staticmethod
                def assert_stop(request):
                    if request != {"command": "stop"}:
                        raise AssertionError("broker did not narrow active controls")
            return Session()
        with patch.object(helper, "HelperSession", side_effect=factory), \
             patch.object(helper, "RouteResources", side_effect=lambda ip: object()), \
             patch.object(helper, "SessionJournal", side_effect=lambda uid: Mock()), \
             patch.object(helper, "_prepare_runtime", side_effect=lambda: os.open(os.devnull, os.O_RDONLY)):
            result = helper.run_reusable_sessions(self.start(), uid=1000, ip_command="/fake/ip",
                reader=FakeReader(messages), output=output, stop_event=stop_event, build_config=Mock())
        return result, calls, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_two_start_stop_cycles_use_fresh_ownership_and_tag_all_status(self):
        result, calls, events = self.broker([self.stop(), self.start(2, "192.0.2.2"), self.stop(2), helper.EOF])
        self.assertEqual(result, 0)
        self.assertEqual([call[2].host for call in calls], ["192.0.2.1", "192.0.2.2"])
        self.assertIsNot(calls[0][0], calls[1][0])
        self.assertIsNot(calls[0][1], calls[1][1])
        self.assertEqual([(event["event"], event["id"]) for event in events],
                         [("ready", 1), ("stopped", 1), ("ready", 2), ("stopped", 2)])

    def test_idle_stop_is_idempotent_and_eof_releases_broker(self):
        result, calls, events = self.broker([self.stop(), self.stop(), helper.EOF])
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual([event["event"] for event in events], ["ready", "stopped", "stopped"])

    def test_replayed_start_and_invalid_idle_commands_are_rejected(self):
        for request in (self.start(), self.stop(2), {"version": 3, "command": "exec", "id": 2}):
            with self.subTest(request=request), self.assertRaises(helper.HelperError):
                self.broker([self.stop(), request, helper.EOF])

    def test_cleanup_failure_does_not_start_next_session(self):
        result, calls, events = self.broker([self.stop(), self.start(2), self.stop(2), helper.EOF], result=1)
        self.assertEqual(result, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual([event["event"] for event in events], ["ready"])

    def test_active_eof_and_bad_controls_cleanup_then_end_broker(self):
        with tempfile.TemporaryDirectory() as name, \
             patch.object(helper, "RUNTIME_DIR", Path(name)), \
             patch.object(helper, "_reserve_ports", return_value=[40001, 40002]):
            original_session = helper.HelperSession
            for request in (helper.EOF, self.stop(2), {"command": "stop"}):
                with self.subTest(request=request):
                    resources = FakeResources()
                    process = FakeCore()
                    output = io.StringIO()
                    readers = []
                    def factory(owned, reader, tagged_output, event, builder, journal):
                        readers.append(reader)
                        session = original_session(owned, reader, tagged_output, event, builder,
                            popen=lambda *args, **kwargs: process,
                            command=lambda args: subprocess.CompletedProcess(args, 0, "sing-box version 1.14.4\n", ""))
                        session.wait_ready = Mock()
                        return session
                    with patch.object(helper, "RouteResources", return_value=resources), \
                         patch.object(helper, "SessionJournal"), \
                         patch.object(helper, "_prepare_runtime", side_effect=lambda: os.open(os.devnull, os.O_RDONLY)), \
                         patch.object(helper, "HelperSession", side_effect=factory):
                        result = helper.run_reusable_sessions(self.start(), uid=1000,
                            ip_command="/fake/ip", reader=FakeReader([None, request, self.start(2)]),
                            output=output, stop_event=threading.Event(), build_config=lambda *a, **k: {})
                    self.assertEqual(result, 0)
                    self.assertEqual(len(readers), 1)
                    self.assertEqual(resources.calls[-1], "cleanup")
                    self.assertEqual(process.actions, ["term"])
                    self.assertTrue(readers[0].eof if request is helper.EOF else readers[0].invalid)
                    events = [json.loads(line) for line in output.getvalue().splitlines()]
                    self.assertEqual(events[-1], {"event": "stopped", "id": 1})

    def test_idle_has_no_global_lock_and_each_start_claims_and_releases_it(self):
        output = io.StringIO()
        acquired = []
        active_fd = []
        order = []
        def acquire():
            fd = os.open(os.devnull, os.O_RDONLY)
            acquired.append(fd)
            active_fd.append(fd)
            order.append("lock")
            return fd
        class Reader:
            messages = iter([self.stop(), self.start(2), self.stop(2), helper.EOF])
            def poll(inner, timeout=0):
                if not active_fd:
                    raise AssertionError("first activation lock missing")
                if order[-1] == "cleaned":
                    with self.assertRaises(OSError):
                        os.fstat(active_fd[-1])
                    order.append("idle-unlocked")
                return next(inner.messages)
        def factory(resources, reader, tagged_output, event, builder, journal):
            class Session:
                def run(inner, endpoint):
                    os.fstat(active_fd[-1])
                    self.assertEqual(reader.poll(), {"command": "stop"})
                    os.fstat(active_fd[-1])
                    order.append("cleaned")
                    tagged_output.write('{"event":"stopped"}\n')
                    return 0
            return Session()
        with patch.object(helper, "_prepare_runtime", side_effect=acquire), \
             patch.object(helper, "RouteResources"), patch.object(helper, "SessionJournal") as journal, \
             patch.object(helper, "HelperSession", side_effect=factory):
            self.assertEqual(helper.run_reusable_sessions(self.start(), uid=1000,
                ip_command="/fake/ip", reader=Reader(), output=output,
                stop_event=threading.Event(), build_config=Mock()), 0)
            self.assertEqual(journal.return_value.recover.call_count, 2)
        self.assertEqual(len(acquired), 2)
        self.assertEqual(order, ["lock", "cleaned", "idle-unlocked", "lock", "cleaned", "idle-unlocked"])
        for fd in acquired:
            with self.assertRaises(OSError): os.fstat(fd)

    def test_start_journal_recovery_failure_releases_lock_and_never_starts_core(self):
        fd = os.open(os.devnull, os.O_RDONLY)
        with patch.object(helper, "_prepare_runtime", return_value=fd), \
             patch.object(helper, "RouteResources"), patch.object(helper, "SessionJournal") as journal, \
             patch.object(helper, "HelperSession") as session:
            journal.return_value.recover.side_effect = helper.HelperError("foreign journal")
            with self.assertRaises(helper.HelperError):
                helper.run_reusable_sessions(self.start(), uid=1000, ip_command="/fake/ip",
                    reader=FakeReader([helper.EOF]), output=io.StringIO(),
                    stop_event=threading.Event(), build_config=Mock())
            session.assert_not_called()
        with self.assertRaises(OSError): os.fstat(fd)

if __name__ == "__main__":
    unittest.main()
