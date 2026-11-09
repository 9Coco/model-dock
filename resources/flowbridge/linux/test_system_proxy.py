"""Isolated settings tests: no calls touch the host's desktop settings."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from system_proxy import DesktopProxyManager, GNOME_KEYS, ProxySettingsError


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.values = {"|".join(key): "''" for key in GNOME_KEYS}
        self.values.update({
            "org.gnome.system.proxy|mode": "'auto'",
            "org.gnome.system.proxy|ignore-hosts": "['localhost', '*.local']",
            "org.gnome.system.proxy.http|host": "'old-http'",
            "org.gnome.system.proxy.http|port": "3128",
            "org.gnome.system.proxy.http|use-authentication": "true",
            "org.gnome.system.proxy.https|host": "'old-https'",
            "org.gnome.system.proxy.https|port": "4443",
            "org.gnome.system.proxy.socks|host": "'old-socks'",
        })
        self.fail_once = None
        self.fail_notify = False

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command[0] == "dbus-send":
            return subprocess.CompletedProcess(command, int(self.fail_notify), "", "")
        if command[0] != "gsettings":
            raise AssertionError(f"unexpected command: {command}")
        key = "|".join(command[2:4])
        if command[1] == "get":
            return subprocess.CompletedProcess(command, 0, self.values[key] + "\n", "")
        if self.fail_once == key:
            self.fail_once = None
            return subprocess.CompletedProcess(command, 1, "", "simulated failure")
        self.values[key] = command[4]
        return subprocess.CompletedProcess(command, 0, "", "")


class DesktopProxyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.config_dir = Path(self.temporary.name)
        self.runner = FakeRunner()
        self.desktop = patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": "KDE", "DESKTOP_SESSION": "plasma"})
        self.desktop.start()
        self.addCleanup(self.desktop.stop)
        self.manager = DesktopProxyManager(self.config_dir, self.runner)
        self.path = self.config_dir / "kioslaverc"

    def make_gnome(self):
        os.environ["XDG_CURRENT_DESKTOP"] = "GNOME"
        os.environ["DESKTOP_SESSION"] = "gnome"
        return DesktopProxyManager(self.config_dir, self.runner)

    def test_kde_exact_restore_preserves_original_bytes_and_mode(self):
        original = (
            b"# keep this comment\r\n[Other]\r\nkey=abc=def\r\n\r\n"
            b"[Proxy Settings]\r\nProxyType=2\r\nhttpProxy=http://old 8080\r\n"
            b"httpsProxy=http://old-https 8443\r\nNoProxyFor=example.org\r\n"
            b"ReversedException=true\r\n[Last]\r\nraw=last-without-newline"
        )
        self.path.write_bytes(original)
        self.path.chmod(0o640)
        self.manager.apply("127.0.0.1", 38473)
        applied = self.path.read_bytes()
        self.assertIn(b"httpProxy=http://127.0.0.1 38473\r\n", applied)
        self.assertIn(b"[Other]\r\nkey=abc=def\r\n\r\n", applied)
        self.assertIn(b"ReversedException=false\r\n", applied)
        self.assertTrue(self.manager.is_applied)
        self.manager.restore()
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o640)
        self.assertFalse(self.manager.is_applied)
        self.assertFalse(self.manager.journal_path.exists())

    def test_originally_absent_kde_file_is_removed_on_restore(self):
        self.manager.apply("localhost", 38473)
        self.assertTrue(self.path.exists())
        self.manager.restore()
        self.assertFalse(self.path.exists())

    def test_nested_kconfig_group_is_not_treated_as_proxy_group(self):
        original = b"[Proxy Settings][Child]\nhttpProxy=unrelated\nProxyType=77\n"
        self.path.write_bytes(original)
        self.manager.apply("127.0.0.1", 38473)
        self.assertTrue(self.path.read_bytes().startswith(original))
        self.manager.restore()
        self.assertEqual(self.path.read_bytes(), original)

    def test_unrelated_concurrent_edit_is_retained(self):
        original = b"[Other]\nx=old\n[Proxy Settings]\nProxyType=0\nhttpProxy=old\n"
        self.path.write_bytes(original)
        self.manager.apply("127.0.0.1", 38473)
        self.path.write_bytes(self.path.read_bytes().replace(b"x=old", b"x=user-new"))
        self.manager.restore()
        restored = self.path.read_bytes()
        self.assertIn(b"x=user-new\n", restored)
        self.assertIn(b"httpProxy=old\n", restored)
        self.assertIn(b"ProxyType=0\n", restored)
        self.assertNotIn(b"127.0.0.1 38473", restored)
        self.assertEqual(self.manager.last_conflicts, ())

    def test_user_endpoint_edit_preserves_new_endpoint_and_manual_mode(self):
        self.path.write_text("[Proxy Settings]\nProxyType=0\nhttpProxy=old\nhttpsProxy=old-https\n")
        self.manager.apply("127.0.0.1", 38473)
        self.path.write_text(self.path.read_text().replace("httpProxy=http://127.0.0.1 38473", "httpProxy=http://user-proxy 8888"))
        self.manager.restore()
        restored = self.path.read_text()
        self.assertIn("httpProxy=http://user-proxy 8888\n", restored)
        self.assertIn("httpsProxy=old-https\n", restored)
        self.assertIn("ProxyType=1\n", restored)
        self.assertIn("httpProxy", self.manager.last_conflicts)
        self.assertIn("ProxyType", self.manager.last_conflicts)

    def test_restore_final_line_without_newline_does_not_merge_user_added_keys(self):
        self.path.write_bytes(b"[Proxy Settings]\nProxyType=0\nhttpProxy=old")
        self.manager.apply("127.0.0.1", 38473)
        with self.path.open("ab") as stream:
            stream.write(b"UserAdded=keep-me\n")
        self.manager.restore()
        restored = self.path.read_bytes()
        self.assertIn(b"httpProxy=old\nUserAdded=keep-me\n", restored)
        self.assertNotIn(b"oldUserAdded", restored)

    def test_immutable_or_duplicate_keys_are_not_changed(self):
        for original in (
            b"[Proxy Settings][$i]\nProxyType=0\n",
            b"[Proxy Settings]\nProxyType[$i]=0\n",
            b"[Proxy Settings]\nProxyType=0\nProxyType=2\n",
        ):
            with self.subTest(original=original):
                self.path.write_bytes(original)
                with self.assertRaises(ProxySettingsError):
                    self.manager.apply("127.0.0.1", 38473)
                self.assertEqual(self.path.read_bytes(), original)
                self.assertFalse(self.manager.journal_path.exists())

    def test_symlink_is_not_replaced(self):
        target = self.config_dir / "managed-dotfile"
        target.write_text("[Proxy Settings]\nProxyType=0\n")
        self.path.symlink_to(target)
        with self.assertRaises(ProxySettingsError):
            self.manager.apply("127.0.0.1", 38473)
        self.assertTrue(self.path.is_symlink())

    def test_crash_recovery_works_with_a_new_manager(self):
        original = b"[Proxy Settings]\nProxyType=2\nhttpProxy=old\n"
        self.path.write_bytes(original)
        self.manager.apply("127.0.0.1", 38473)
        journal = json.loads(self.manager.journal_path.read_text())
        journal["owner_pid"] = 99999999
        self.manager.journal_path.write_text(json.dumps(journal))
        successor = DesktopProxyManager(self.config_dir, self.runner)
        self.assertTrue(successor.recover_pending())
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse(successor.recover_pending())

    @unittest.skipUnless(sys.platform.startswith("linux") and hasattr(os, "waitid") and hasattr(os, "WNOWAIT"), "requires Linux zombie process observation")
    def test_zombie_owner_is_recovered_without_waiting_for_reaping(self):
        original = b"[Proxy Settings]\nProxyType=0\nhttpProxy=old-proxy\n"
        self.path.write_bytes(original)
        self.manager.apply("127.0.0.1", 38473)
        owner = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            # Observe exit but deliberately do not reap yet. kill(pid, 0)
            # still succeeds in this state, which previously blocked recovery.
            os.waitid(os.P_PID, owner.pid, os.WEXITED | os.WNOWAIT)
            state = Path(f"/proc/{owner.pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            self.assertEqual(state, "Z")
            os.kill(owner.pid, 0)
            journal = json.loads(self.manager.journal_path.read_text())
            journal["owner_pid"] = owner.pid
            journal["owner_start"] = None
            self.manager.journal_path.write_text(json.dumps(journal))
            successor = DesktopProxyManager(self.config_dir, self.runner)
            self.assertTrue(successor.recover_pending())
            self.assertEqual(self.path.read_bytes(), original)
            self.assertFalse(successor.journal_path.exists())
        finally:
            owner.wait(timeout=5)

    def test_recovery_does_not_touch_another_live_instance(self):
        self.manager.apply("127.0.0.1", 38473)
        applied = self.path.read_bytes()
        successor = DesktopProxyManager(self.config_dir, self.runner)
        self.assertFalse(successor.recover_pending())
        with self.assertRaises(ProxySettingsError):
            successor.apply("127.0.0.1", 38473)
        self.assertEqual(self.path.read_bytes(), applied)
        self.manager.restore()

    def test_idempotent_apply_keeps_the_original_recovery_snapshot(self):
        original = b"[Proxy Settings]\nProxyType=0\n"
        self.path.write_bytes(original)
        self.manager.apply("127.0.0.1", 38473)
        first_journal = self.manager.journal_path.read_bytes()
        self.manager.apply("127.0.0.1", 38473)
        self.assertEqual(self.manager.journal_path.read_bytes(), first_journal)
        with self.assertRaises(ProxySettingsError):
            self.manager.apply("127.0.0.1", 38474)
        self.manager.restore()
        self.assertEqual(self.path.read_bytes(), original)

    def test_gnome_apply_restore_and_explicit_isolation(self):
        manager = self.make_gnome()
        original = self.runner.values.copy()
        manager.apply("127.0.0.1", 38473)
        self.assertEqual(self.runner.values["org.gnome.system.proxy|mode"], "'manual'")
        self.assertEqual(self.runner.values["org.gnome.system.proxy.http|port"], "38473")
        self.assertEqual(self.runner.values["org.gnome.system.proxy.http|use-authentication"], "false")
        for _, kwargs in self.runner.calls:
            self.assertEqual(kwargs["env"]["XDG_CONFIG_HOME"], str(self.config_dir))
            self.assertEqual(kwargs["env"]["GSETTINGS_BACKEND"], "keyfile")
        manager.restore()
        self.assertEqual(self.runner.values, original)

    def test_gnome_partial_failure_rolls_back_already_written_keys(self):
        manager = self.make_gnome()
        original = self.runner.values.copy()
        self.runner.fail_once = "org.gnome.system.proxy.https|port"
        with self.assertRaises(ProxySettingsError):
            manager.apply("127.0.0.1", 38473)
        self.assertEqual(self.runner.values, original)
        self.assertFalse(manager.journal_path.exists())

    def test_gnome_concurrent_change_preserves_user_mode_and_endpoint(self):
        manager = self.make_gnome()
        original = self.runner.values.copy()
        manager.apply("127.0.0.1", 38473)
        self.runner.values["org.gnome.system.proxy.http|host"] = "'user-proxy'"
        manager.restore()
        self.assertEqual(self.runner.values["org.gnome.system.proxy|mode"], "'manual'")
        self.assertEqual(self.runner.values["org.gnome.system.proxy.http|host"], "'user-proxy'")
        self.assertEqual(self.runner.values["org.gnome.system.proxy.https|host"], original["org.gnome.system.proxy.https|host"])

    def test_invalid_endpoint_is_rejected_before_writing(self):
        for host, port in (("phone.example", 38473), ("10.15.60.93", 38473), ("127.0.0.1", 0), ("127.0.0.1", True)):
            with self.subTest(host=host, port=port), self.assertRaises(ProxySettingsError):
                self.manager.apply(host, port)
        self.assertFalse(self.path.exists())
        self.assertFalse(self.manager.journal_path.exists())

    def test_notify_failure_is_reported_without_losing_recovery(self):
        self.runner.fail_notify = True
        self.manager.apply("127.0.0.1", 38473)
        self.assertTrue(self.manager.is_applied)
        self.assertIn("刷新通知", self.manager.last_warning)
        self.manager.restore()
        self.assertFalse(self.path.exists())

    def test_corrupt_journal_does_not_change_settings(self):
        self.manager.state_dir.mkdir(parents=True)
        self.manager.journal_path.write_text('{"version": 987}')
        self.path.write_bytes(b"untouched")
        with self.assertRaises(ProxySettingsError):
            self.manager.recover_pending()
        self.assertEqual(self.path.read_bytes(), b"untouched")


if __name__ == "__main__":
    unittest.main()
