"""Controller failure/retry tests with simulated core and network state only."""

import io
import sys
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from windows.proxy import parse_global_address
from windows.tun_client import TunController, TunStartError, TunStopError


class FakeMutex:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakePlatform:
    def __init__(self):
        self.admin = True
        self.process = None
        self.mutex = None
        self.preexisting = False
        self.reusable_inactive = False
        self.forwarding = False
        self.leftover_routes = False
        self.fail_restore = False
        self.restore_calls = []
        self.weak_host = [{"InterfaceIndex": 42, "InterfaceAlias": "Ethernet", "AddressFamily": "IPv4"}]

    def is_admin(self):
        return self.admin

    def SessionMutex(self):
        self.mutex = FakeMutex()
        return self.mutex

    def network_state(self):
        running = self.process is not None and self.process.alive
        return {"exists": self.preexisting or running, "up": running,
                "routes": 4 if running or self.leftover_routes else 0, "forwarding": self.forwarding,
                "reusable_inactive": self.reusable_inactive and not running and not self.leftover_routes}

    def capture_weak_host(self):
        return self.weak_host

    def restore_weak_host(self, rows):
        self.restore_calls.append(rows)
        if self.fail_restore:
            raise OSError("simulated recovery failure")

    def local_proxy_process(self, endpoint):
        return None


class FakeProcess:
    def __init__(self, platform):
        self.alive = True
        self.stop_calls = self.close_calls = 0
        self.stop_error = self.wait_timeout = False
        platform.process = self

    def poll(self):
        return None if self.alive else 0

    def request_stop(self):
        self.stop_calls += 1
        if self.stop_error:
            raise OSError("simulated signal failure")

    def wait(self, timeout=None):
        if self.wait_timeout:
            raise subprocess.TimeoutExpired("inert core", timeout)
        self.alive = False
        return 0

    def close_job(self):
        self.close_calls += 1
        self.alive = False


class FakeAPI:
    def __init__(self):
        self.fail = False
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        if self.fail:
            raise OSError("simulated API not ready")
        return io.BytesIO(json.dumps({"uploadTotal": 128, "downloadTotal": 256, "connections": []}).encode())


class WindowsTunLifecycleTests(unittest.TestCase):
    def setUp(self):
        # Only the injected fake core uses POSIX fixture paths on Linux.
        # Pure config tests separately exercise strict Windows path validation.
        if sys.platform != 'win32':
            path_patch = patch('windows.tun_config._cache_path', side_effect=lambda value: value)
            path_patch.start(); self.addCleanup(path_patch.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.platform = FakePlatform()
        self.api = FakeAPI()
        self.created = []

    def tearDown(self):
        for controller in self.created:
            if self.platform.process:
                self.platform.process.stop_error = False
                self.platform.process.wait_timeout = False
            self.platform.fail_restore = self.platform.leftover_routes = False
            try:
                controller.stop()
            except Exception:
                pass
        self.temp.cleanup()

    def controller(self, **overrides):
        values = dict(platform_api=self.platform, api_opener=self.api, core_provider=lambda: self.directory / "core.exe",
                      config_checker=lambda *_: None, state_dir=self.directory / "state", start_timeout=.05,
                      stop_timeout=.05, poll_interval=10,
                      process_factory=lambda *_: FakeProcess(self.platform))
        values.update(overrides)
        controller = TunController(parse_global_address("192.168.1.5:1080"), **values)
        self.created.append(controller)
        return controller

    def test_start_and_stop_restore_owned_state_and_keep_api_secret_private(self):
        controller = self.controller().start()
        self.assertTrue(controller.is_running)
        self.assertTrue(controller.needs_cleanup)
        self.assertTrue(controller._journal.exists())
        secret = controller._secret
        self.assertNotIn(secret, json.dumps(controller.info))
        self.assertNotIn(secret, json.dumps(controller.snapshot()))
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller.needs_cleanup)
        self.assertFalse(controller._journal.exists())
        self.assertTrue(self.platform.mutex.closed)
        self.assertEqual(self.platform.restore_calls, [self.platform.weak_host])
        self.assertEqual(self.platform.process.stop_calls, 1)

    def test_startup_progress_and_report_record_stages_without_sensitive_values(self):
        messages = []
        controller = self.controller(progress=messages.append).start()
        report = json.loads((controller._state_dir / 'last-startup.json').read_text())
        self.assertTrue(report['ok'])
        self.assertEqual(len(messages), len(report['stages']))
        self.assertEqual(report['stages'][-1]['stage'], 'wait_ready')
        self.assertTrue(all(stage['ok'] and stage['seconds'] >= 0 for stage in report['stages']))
        self.assertGreaterEqual(report['total_seconds'], 0)
        for private in (controller.endpoint.host, controller._secret, str(controller._directory)):
            self.assertNotIn(private, json.dumps(report))

    def test_progress_or_diagnostic_write_failure_does_not_break_connection(self):
        def broken_observer(_):
            raise RuntimeError('observer failed')
        for failure in (OSError, RuntimeError, TypeError):
            with self.subTest(failure=failure), patch('windows.tun_client.atomic_json', side_effect=failure('diagnostics failed')):
                controller = self.controller(progress=broken_observer).start()
                self.assertTrue(controller.is_running)
                self.assertTrue(controller._startup_report['ok'])
                controller.stop()

    def test_diagnostic_failure_cannot_skip_failed_start_cleanup(self):
        self.api.fail = True
        controller = self.controller()
        with patch('windows.tun_client.atomic_json', side_effect=RuntimeError('diagnostics failed')):
            with self.assertRaises(TunStartError):
                controller.start()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(self.platform.process.alive)
        self.assertEqual(self.platform.process.stop_calls, 1)

    def test_ready_and_cleanup_use_lightweight_state_with_remaining_budget(self):
        budgets = []
        def light_state(*, timeout):
            budgets.append(timeout)
            running = self.platform.process is not None and self.platform.process.alive
            return {'exists': running, 'up': running, 'routes': 4 if running else 0}
        self.platform.tun_state = light_state
        with patch.object(self.platform, 'network_state', wraps=self.platform.network_state) as complete_state:
            controller = self.controller().start()
            controller.stop()
            self.assertEqual(complete_state.call_count, 1)
        self.assertEqual(len(budgets), 2)
        self.assertTrue(all(0 < value <= .05 for value in budgets))

    def test_readiness_result_after_deadline_is_not_reported_successful(self):
        clock = [100.0]
        def advance(seconds):
            clock[0] += seconds
        def delayed_state(*, timeout):
            if self.platform.process and self.platform.process.alive:
                advance(timeout + 1)
                return {'exists': True, 'up': True, 'routes': 4}
            return {'exists': False, 'up': False, 'routes': 0}
        self.platform.tun_state = delayed_state
        controller = self.controller()
        # Python 3.12's Windows monotonic clock has ~15.6 ms resolution.
        # A private clock isolates this boundary test from OS timer rounding.
        clock_api = SimpleNamespace(monotonic=lambda: clock[0], perf_counter=lambda: clock[0], sleep=advance)
        with patch('windows.tun_client.time', clock_api):
            with self.assertRaises(TunStartError):
                controller.start()
        self.assertFalse(controller.is_running)
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller._startup_report['ok'])
        self.assertFalse(controller._startup_report['stages'][-1]['ok'])

    def test_shutdown_reports_real_cleanup_stages_and_repeated_close_is_inert(self):
        messages = []
        controller = self.controller(progress=messages.append).start()
        secret = controller._secret
        messages.clear()
        controller.stop()
        report_path = controller._state_dir / 'last-shutdown.json'
        saved = report_path.read_bytes()
        report = json.loads(saved)
        self.assertTrue(report['ok'])
        self.assertEqual([row['stage'] for row in report['stages']],
                         ['signal_core', 'wait_core', 'confirm_routes', 'restore_network', 'release_session'])
        self.assertEqual(len(messages), 5)
        self.assertNotIn(secret, saved.decode())
        self.assertNotIn(controller.endpoint.host, saved.decode())
        messages.clear()
        with patch('windows.tun_client.atomic_json') as write:
            controller.close()
            write.assert_not_called()
        self.assertEqual(messages, [])
        self.assertEqual(report_path.read_bytes(), saved)
        self.assertEqual(self.platform.process.stop_calls, 1)

    def test_shutdown_diagnostic_failure_keeps_success_and_failure_state_correct(self):
        controller = self.controller().start()
        self.platform.leftover_routes = True
        with patch('windows.tun_client.atomic_json', side_effect=RuntimeError('diagnostics failed')):
            with self.assertRaises(TunStopError):
                controller.stop()
        self.assertFalse(controller.cleanup_confirmed)
        self.assertFalse(controller._shutdown_report['ok'])
        self.assertEqual(controller._shutdown_report['stages'][-1]['stage'], 'confirm_routes')
        self.platform.leftover_routes = False
        with patch('windows.tun_client.atomic_json', side_effect=RuntimeError('diagnostics failed')):
            controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertTrue(controller._shutdown_report['ok'])

    def test_missing_admin_permission_never_opens_core_or_network_session(self):
        self.platform.admin = False
        controller = self.controller()
        with self.assertRaises(TunStartError) as caught:
            controller.start()
        self.assertTrue(caught.exception.cleanup_confirmed)
        self.assertIsNone(self.platform.process)
        self.assertIsNone(self.platform.mutex)

    def test_existing_interface_or_forwarding_rejected_without_changes(self):
        for flag in ("preexisting", "forwarding"):
            with self.subTest(flag=flag):
                setattr(self.platform, flag, True)
                controller = self.controller()
                with self.assertRaises(TunStartError):
                    controller.start()
                self.assertIsNone(self.platform.process)
                self.assertFalse(controller._journal.exists())
                self.assertTrue(self.platform.mutex.closed)
                setattr(self.platform, flag, False)

    def test_known_inactive_adapter_reconnects_and_recovers_previous_journal_first(self):
        self.platform.preexisting = self.platform.reusable_inactive = True
        previous = [{"InterfaceIndex": 7, "InterfaceAlias": "Wi-Fi", "AddressFamily": "IPv6"}]
        def launch(*_):
            self.assertEqual(self.platform.restore_calls, [previous])
            self.assertIsNotNone(self.platform.mutex)
            self.assertFalse(self.platform.mutex.closed)
            return FakeProcess(self.platform)
        controller = self.controller(process_factory=launch)
        controller._state_dir.mkdir(parents=True)
        controller._journal.write_text(json.dumps({"version": 1, "weak_host": previous}), encoding="utf-8")
        controller.start()
        self.assertTrue(controller.is_running)
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertEqual(self.platform.restore_calls, [previous, self.platform.weak_host])
        # A residual inactive row is also a valid stopped state, as before.
        self.assertTrue(self.platform.network_state()['exists'])
        self.assertFalse(controller._journal.exists())

    def test_active_or_unrecognized_adapter_is_blocked_even_with_previous_journal(self):
        states = [
            {'exists': True, 'up': True, 'routes': 0, 'reusable_inactive': True},
            {'exists': True, 'up': False, 'routes': 1, 'reusable_inactive': True},
            {'exists': True, 'up': False, 'routes': 0, 'reusable_inactive': False},
            {'exists': True, 'up': False, 'routes': 0},
            {'exists': True, 'up': False, 'routes': 0, 'reusable_inactive': 1},
        ]
        controller = self.controller()
        controller._state_dir.mkdir(parents=True)
        journal = json.dumps({"version": 1, "weak_host": self.platform.weak_host})
        controller._journal.write_text(journal, encoding="utf-8")
        for state in states:
            with self.subTest(state=state), patch.object(self.platform, 'network_state', return_value=state):
                with self.assertRaises(TunStartError): controller.start()
            self.assertIsNone(self.platform.process)
            self.assertEqual(self.platform.restore_calls, [])
            self.assertEqual(controller._journal.read_text(encoding="utf-8"), journal)
            self.assertTrue(self.platform.mutex.closed)

    def test_live_session_mutex_prevents_inactive_adapter_reuse_and_recovery(self):
        self.platform.preexisting = self.platform.reusable_inactive = True
        controller = self.controller()
        with patch.object(self.platform, 'SessionMutex', side_effect=OSError('another session owns the network')), \
                patch.object(self.platform, 'network_state') as state:
            with self.assertRaises(TunStartError): controller.start()
        state.assert_not_called()
        self.assertIsNone(self.platform.process)
        self.assertEqual(self.platform.restore_calls, [])
        self.assertFalse(controller._journal.exists())

    def test_config_failure_does_not_launch_core_or_leave_secret_file(self):
        def reject(*_):
            raise ValueError("invalid config")
        controller = self.controller(config_checker=reject)
        with self.assertRaises(TunStartError):
            controller.start()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertIsNone(self.platform.process)
        self.assertFalse(controller._journal.exists())
        self.assertEqual(list(controller._state_dir.glob("tun-*")), [])

    def test_process_creation_failure_restores_journal_before_reporting_clean(self):
        def fail(*_):
            raise OSError("simulated process creation failure")
        controller = self.controller(process_factory=fail)
        with self.assertRaises(TunStartError) as caught:
            controller.start()
        self.assertTrue(caught.exception.cleanup_confirmed)
        self.assertEqual(self.platform.restore_calls, [self.platform.weak_host])
        self.assertFalse(controller._journal.exists())

    def test_api_not_ready_timeout_stops_core_before_reporting_failure(self):
        self.api.fail = True
        controller = self.controller()
        with self.assertRaises(TunStartError):
            controller.start()
        self.assertFalse(self.platform.process.alive)
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller._journal.exists())

    def test_stop_timeout_keeps_live_core_journal_and_retry_control(self):
        controller = self.controller().start()
        process = self.platform.process
        process.wait_timeout = True
        with self.assertRaises(TunStopError) as caught:
            controller.stop()
        self.assertIs(caught.exception.controller, controller)
        self.assertTrue(process.alive)
        self.assertEqual(process.close_calls, 0)
        self.assertTrue(controller.needs_cleanup)
        self.assertTrue(controller._journal.exists())
        self.assertFalse(self.platform.mutex.closed)
        with self.assertRaises(TunStartError):
            controller.start()
        process.wait_timeout = False
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller._journal.exists())

    def test_signal_failure_does_not_kill_core_or_claim_clean(self):
        controller = self.controller().start()
        self.platform.process.stop_error = True
        with self.assertRaises(TunStopError):
            controller.stop()
        self.assertTrue(self.platform.process.alive)
        self.assertEqual(self.platform.process.close_calls, 0)
        self.assertTrue(controller.needs_cleanup)

    def test_crash_is_visible_and_requires_recovery_even_after_process_exit(self):
        controller = self.controller().start()
        self.platform.process.alive = False
        snapshot = controller.snapshot()
        self.assertFalse(snapshot["running"])
        self.assertEqual(snapshot["state"], "error")
        self.assertTrue(snapshot["needs_cleanup"])
        self.assertTrue(controller._journal.exists())
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertEqual(self.platform.process.stop_calls, 0)

    def test_leftover_routes_prevent_cleanup_confirmation_until_retry(self):
        controller = self.controller().start()
        self.platform.leftover_routes = True
        with self.assertRaises(TunStopError):
            controller.stop()
        self.assertFalse(controller.cleanup_confirmed)
        self.assertTrue(controller._journal.exists())
        self.assertEqual(self.platform.restore_calls, [])
        self.platform.leftover_routes = False
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)

    def test_restore_failure_preserves_journal_and_mutex_until_retry(self):
        controller = self.controller().start()
        self.platform.fail_restore = True
        with self.assertRaises(TunStopError):
            controller.stop()
        self.assertTrue(controller._journal.exists())
        self.assertFalse(controller.cleanup_confirmed)
        self.assertFalse(self.platform.mutex.closed)
        self.platform.fail_restore = False
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller._journal.exists())

    def test_previous_failed_recovery_is_retained_and_can_be_retried(self):
        controller = self.controller()
        controller._state_dir.mkdir(parents=True)
        controller._journal.write_text(json.dumps({"version": 1, "weak_host": self.platform.weak_host}), encoding="utf-8")
        self.platform.fail_restore = True
        with self.assertRaises(TunStartError) as caught:
            controller.start()
        self.assertFalse(caught.exception.cleanup_confirmed)
        self.assertIs(caught.exception.controller, controller)
        self.assertIsNone(self.platform.process)
        self.assertTrue(controller._journal.exists())
        self.assertFalse(self.platform.mutex.closed)
        self.platform.fail_restore = False
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller._journal.exists())

    def test_malformed_previous_journal_is_not_discarded_or_marked_clean(self):
        controller = self.controller()
        controller._state_dir.mkdir(parents=True)
        controller._journal.write_text("{incomplete", encoding="utf-8")
        with self.assertRaises(TunStartError) as caught:
            controller.start()
        self.assertFalse(caught.exception.cleanup_confirmed)
        self.assertTrue(controller.needs_cleanup)
        self.assertEqual(controller._journal.read_text(encoding="utf-8"), "{incomplete")
        self.assertIsNone(self.platform.process)
        # Fix only this simulated file so teardown can exercise normal recovery.
        controller._journal.write_text(json.dumps({"version": 1, "weak_host": []}), encoding="utf-8")

    def test_running_endpoint_cannot_change_and_stopped_controller_can_restart(self):
        controller = self.controller().start()
        with self.assertRaises(TunStartError):
            controller.set_endpoint(parse_global_address("192.168.1.6:1080"))
        first_secret = controller._secret
        controller.stop()
        controller.set_endpoint(parse_global_address("192.168.1.6:1080"))
        controller.start()
        self.assertNotEqual(controller._secret, first_secret)
        self.assertEqual(controller.endpoint.host, "192.168.1.6")

    def test_core_check_error_redacts_generated_secret(self):
        exposed = []
        def reject(binary, path):
            secret = json.loads(path.read_text(encoding="utf-8"))["experimental"]["clash_api"]["secret"]
            exposed.append(secret)
            raise ValueError("bad secret: " + secret)
        controller = self.controller(config_checker=reject)
        with self.assertRaises(TunStartError) as caught:
            controller.start()
        self.assertNotIn(exposed[0], str(caught.exception))
        self.assertNotIn(exposed[0], json.dumps(controller.snapshot()))

    def test_dns_mapping_survives_disconnect_mode_and_upstream_changes(self):
        configurations = []
        def capture(binary, path):
            configurations.append(json.loads(path.read_text(encoding='utf-8')))
        controller = self.controller(config_checker=capture).start()
        first = configurations[-1]
        self.assertEqual(controller.dns_mode, 'fast')
        cache_path = Path(first['experimental']['cache_file']['path'])
        self.assertTrue(cache_path.is_absolute())
        self.assertNotIn('tun-', cache_path.name)
        cache_path.write_bytes(b'simulated core mapping')
        with self.assertRaises(TunStartError):
            controller.set_dns_mode('compatible')
        controller.stop()
        self.assertEqual(cache_path.read_bytes(), b'simulated core mapping')
        controller.set_dns_mode('compatible')
        controller.set_endpoint(parse_global_address('192.168.1.6:1080'))
        controller.start()
        second = configurations[-1]
        self.assertEqual(second['experimental']['cache_file'], first['experimental']['cache_file'])
        self.assertEqual(controller.dns_mode, 'compatible')
        controller.stop()
        self.assertEqual(cache_path.read_bytes(), b'simulated core mapping')

    def test_invalid_dns_mode_never_starts_or_changes_a_session(self):
        with self.assertRaises(ValueError):
            self.controller(dns_mode='direct')
        controller = self.controller()
        with self.assertRaises(ValueError):
            controller.set_dns_mode('direct')
        self.assertEqual(controller.dns_mode, 'fast')
        self.assertIsNone(self.platform.process)


if __name__ == "__main__":
    unittest.main()
