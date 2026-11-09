"""全局接管client tests: fake pkexec/helper processes and optional loopback API.

No privileged helper, 全局接管device, routing command, or live proxy is executed.
"""

import http.server
import io
import json
import os
import queue
import stat
import subprocess
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from relay import Endpoint
import tun_client as client


TEST_SECRET = "only-a-unit-test-secret-1234567890"


def ready(api_port=19090, proxy_port=19091):
    return {"event": "ready", "api_port": api_port, "proxy_port": proxy_port, "api_secret": TEST_SECRET, "interface": "modeldock0"}


class FakeStdout:
    def __init__(self):
        self.lines = queue.Queue()

    def readline(self, limit=-1):
        return self.lines.get()


class FakeStdin:
    def __init__(self, process):
        self.process = process
        self.closed = False
        self.messages = []
        self.pending = ""

    def write(self, value):
        if self.closed:
            raise ValueError("closed")
        self.pending += value
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            message = json.loads(line)
            self.messages.append(message)
            if message.get("command") == "stop":
                self.process.request_stop()
            else:
                self.process.on_init(self.process)
        return len(value)

    def flush(self):
        pass

    def close(self):
        if not self.closed:
            self.closed = True
            self.process.request_stop()


class FakeProcess:
    def __init__(self, *, initial=None, on_init=None, ignore_stop=False, stop_ack=True, stop_code=0):
        self.stdout = FakeStdout()
        self.stdin = FakeStdin(self)
        self.code = None
        self.done = threading.Event()
        self.initial = ready() if initial is None else initial
        self.on_init = on_init or (lambda process: process.emit(process.initial))
        self.ignore_stop = ignore_stop
        self.stop_ack, self.stop_code = stop_ack, stop_code
        self.stop_requests = 0
        self.forced_signals = 0

    def emit(self, message):
        self.stdout.lines.put(json.dumps(message) + "\n")

    def finish(self, code):
        if self.code is None:
            self.code = code
            self.done.set()
            self.stdout.lines.put("")

    def request_stop(self):
        self.stop_requests += 1
        if self.code is not None or self.ignore_stop:
            return
        if self.stop_ack:
            self.emit({"event": "stopped"})
        self.finish(self.stop_code)

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        if not self.done.wait(timeout):
            raise subprocess.TimeoutExpired("fake-helper", timeout)
        return self.code

    def terminate(self):
        self.forced_signals += 1
        raise AssertionError("client must not terminate the privileged helper")

    kill = terminate


class FakeFactory:
    def __init__(self, process):
        self.process, self.calls = process, []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        return self.process


class FakeOpener:
    def __init__(self, payload=None):
        self.payload = payload or {"uploadTotal": 100, "downloadTotal": 200, "connections": [{"id": "one"}]}
        self.requests = []
        self.error = None

    def open(self, request, timeout=None):
        self.requests.append(request)
        if self.error:
            raise self.error
        return io.BytesIO(json.dumps(self.payload).encode())


class TunClientFixture(unittest.TestCase):
    def setUp(self):
        self.preflight = patch.object(client, "_check_installed_helper")
        self.preflight.start()
        self.controllers = []

    def tearDown(self):
        for controller, _ in self.controllers:
            recovery = controller._recovery
            if recovery is not None and recovery.process.poll() is None:
                recovery.process.emit({"event": "stopped"})
                recovery.process.finish(0)
        for controller, process in self.controllers:
            if process is not None and process.poll() is None:
                process.emit({"event": "stopped"})
                process.finish(0)
            try:
                controller._stop(allow_recover=False)
            except client.TunError:
                pass
            if controller._reader:
                controller._reader.join(.5)
            if controller._recovery and controller._recovery.reader and controller._recovery.reader.ident is not None:
                controller._recovery.reader.join(.5)
        self.preflight.stop()

    def make(self, process=None, opener=None, **kwargs):
        process = process or FakeProcess()
        factory = FakeFactory(process)
        values = dict(start_timeout=.3, stop_timeout=.1, poll_interval=.01, api_timeout=.1)
        values.update(kwargs)
        controller = client.TunController(Endpoint("10.15.60.93", 38473), popen_factory=factory, api_opener=opener or FakeOpener(), **values)
        self.controllers.append((controller, process))
        return controller, process, factory

    def wait_for(self, predicate, timeout=1):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.003)
        self.fail("controller did not reach the expected state")


class TunClientTests(TunClientFixture):
    def test_fixed_command_init_and_credential_free_public_info(self):
        opener = FakeOpener()
        controller, process, factory = self.make(opener=opener)
        self.assertIs(controller.start(), controller)
        self.assertEqual(factory.calls[0][0], [client.PKEXEC, "--disable-internal-agent", client.HELPER])
        self.assertEqual(factory.calls[0][1]["cwd"], "/")
        self.assertEqual(factory.calls[0][1]["stderr"], subprocess.DEVNULL)
        self.assertNotIn("shell", factory.calls[0][1])
        self.assertEqual(process.stdin.messages[0], {"version": 2, "host": "10.15.60.93", "port": 38473})
        self.assertEqual(controller.info, {"api_port": 19090, "proxy_port": 19091, "interface": "modeldock0"})
        self.assertNotIn(TEST_SECRET, str(controller.info))
        self.wait_for(lambda: bool(opener.requests))
        self.assertEqual(opener.requests[0].full_url, "http://127.0.0.1:19090/connections")
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer " + TEST_SECRET)
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller.needs_cleanup)
        self.assertFalse(controller.snapshot()["running"])
        self.assertTrue(process.stdin.closed)
        self.assertEqual(process.forced_signals, 0)

    def test_start_is_idempotent_while_running(self):
        controller, _, factory = self.make()
        controller.start()
        controller.start()
        self.assertEqual(len(factory.calls), 1)

    def test_old_blocked_sample_does_not_pollute_restarted_session(self):
        entered, release = threading.Event(), threading.Event()
        class SlowFirstOpener:
            count = 0
            def open(self, request, timeout=None):
                self.count += 1
                first = self.count == 1
                if first:
                    entered.set()
                    release.wait(2)
                payload = {"uploadTotal": 999999 if first else 3, "downloadTotal": 888888 if first else 4, "connections": []}
                return io.BytesIO(json.dumps(payload).encode())
        controller, _, _ = self.make(opener=SlowFirstOpener(), poll_interval=10, api_timeout=.01)
        try:
            controller.start()
            self.assertTrue(entered.wait(1))
            previous_sampler = controller._sampler
            controller.stop()
            replacement = FakeProcess()
            controller._popen = FakeFactory(replacement)
            self.controllers.append((controller, replacement))
            controller.start()
            self.wait_for(lambda: controller.snapshot()["upload_bytes"] == 3)
            release.set()
            previous_sampler.join(1)
            self.assertFalse(previous_sampler.is_alive())
            self.assertEqual(controller.snapshot()["upload_bytes"], 3)
            self.assertEqual(controller.snapshot()["download_bytes"], 4)
        finally:
            release.set()

    def test_sample_counters_active_and_observed_connections(self):
        opener = FakeOpener()
        controller, _, _ = self.make(opener=opener, poll_interval=10)
        controller.start()
        self.wait_for(lambda: controller.snapshot()["upload_bytes"] == 100)
        opener.payload = {"uploadTotal": 160, "downloadTotal": 900, "connections": [{"id": "one"}, {"id": "two"}]}
        controller._sample_once()
        snapshot = controller.snapshot()
        self.assertEqual((snapshot["upload_bytes"], snapshot["download_bytes"]), (160, 900))
        self.assertEqual((snapshot["active_connections"], snapshot["total_connections"]), (2, 2))
        # Core counter resets do not make the GUI's session totals decrease.
        opener.payload = {"uploadTotal": 5, "downloadTotal": 10, "connections": []}
        controller._sample_once()
        self.assertEqual(controller.snapshot()["upload_bytes"], 165)
        self.assertEqual(controller.snapshot()["download_bytes"], 910)

    def test_api_errors_do_not_expose_opener_exception_credentials(self):
        opener = FakeOpener()
        opener.error = RuntimeError("must not display " + TEST_SECRET)
        controller, _, _ = self.make(opener=opener)
        controller.start()
        self.wait_for(lambda: controller.snapshot()["errors"] > 0)
        self.assertNotIn(TEST_SECRET, controller.snapshot()["last_error"])
        self.assertIn("流量统计", controller.snapshot()["last_error"])
        self.assertTrue(controller.is_running)

    def test_late_helper_error_is_visible_and_redacts_secret(self):
        controller, process, _ = self.make()
        controller.start()
        process.emit({"event": "error", "message": "runtime failed with " + TEST_SECRET})
        self.wait_for(lambda: not controller.snapshot()["running"])
        self.assertIn("runtime failed", controller.snapshot()["last_error"])
        self.assertNotIn(TEST_SECRET, controller.snapshot()["last_error"])
        self.wait_for(lambda: controller.cleanup_confirmed)

    def test_helper_exit_without_cleanup_ack_is_not_success(self):
        controller, process, _ = self.make()
        controller.start()
        process.finish(1)
        self.wait_for(lambda: controller.snapshot()["state"] == "error")
        self.assertFalse(controller.cleanup_confirmed)
        self.assertIn("清理尚未确认", controller.snapshot()["last_error"])
        with self.assertRaises(client.TunStopError) as result:
            controller.stop()
        self.assertIs(result.exception.controller, controller)
        self.assertTrue(result.exception.needs_cleanup)

    def test_stopped_ack_with_nonzero_exit_is_not_cleanup_confirmation(self):
        controller, _, _ = self.make(FakeProcess(stop_code=1))
        controller.start()
        with self.assertRaises(client.TunStopError):
            controller.stop()
        self.assertFalse(controller.cleanup_confirmed)

    def test_stop_timeout_keeps_controller_for_retry_without_killing(self):
        controller, process, _ = self.make(FakeProcess(ignore_stop=True), stop_timeout=.02)
        controller.start()
        with self.assertRaises(client.TunStopError) as result:
            controller.stop()
        self.assertIs(result.exception.controller, controller)
        self.assertFalse(result.exception.cleanup_confirmed)
        self.assertTrue(controller.needs_cleanup)
        self.assertEqual(process.forced_signals, 0)
        process.emit({"event": "stopped"})
        process.finish(0)
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)

    def killed_controller(self):
        controller, process, _ = self.make()
        controller.start()
        process.finish(-9)
        self.wait_for(controller._exited.is_set)
        self.assertTrue(controller.needs_cleanup)
        return controller, process

    @staticmethod
    def successful_recovery(process):
        process.emit({"event": "stopped"})
        process.finish(0)

    def test_killed_helper_can_recover_cleanup_through_a_new_fixed_helper(self):
        controller, original_process = self.killed_controller()
        recovery = FakeProcess(on_init=self.successful_recovery)
        factory = FakeFactory(recovery)
        controller._popen = factory
        controller.stop()
        self.assertEqual(factory.calls[0][0], [client.PKEXEC, "--disable-internal-agent", client.HELPER])
        self.assertEqual(recovery.stdin.messages, [{"version": 1, "command": "recover"}])
        self.assertIs(controller._process, original_process)
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller.needs_cleanup)
        self.assertEqual(controller.snapshot()["state"], "stopped")
        self.assertEqual(recovery.forced_signals, 0)

    def test_recovery_authentication_cancel_or_denial_keeps_old_cleanup_pending(self):
        controller, _ = self.killed_controller()
        for code, text in ((126, "取消"), (127, "授权")):
            with self.subTest(code=code):
                recovery = FakeProcess(on_init=lambda process, c=code: process.finish(c))
                controller._popen = FakeFactory(recovery)
                with self.assertRaises(client.TunStopError) as result:
                    controller.stop()
                self.assertIs(result.exception.controller, controller)
                self.assertIn(text, str(result.exception))
                self.assertFalse(result.exception.cleanup_confirmed)
                self.assertTrue(controller.needs_cleanup)

    def test_recovery_error_without_ack_fails_and_can_be_retried(self):
        controller, _ = self.killed_controller()
        def fail(process):
            process.emit({"event": "error", "message": "reserved resource conflict"})
            process.finish(1)
        controller._popen = FakeFactory(FakeProcess(on_init=fail))
        with self.assertRaises(client.TunStopError) as result:
            controller.stop()
        self.assertIn("reserved resource conflict", str(result.exception))
        self.assertTrue(controller.needs_cleanup)
        controller._popen = FakeFactory(FakeProcess(on_init=self.successful_recovery))
        controller.stop()
        self.assertTrue(controller.cleanup_confirmed)

    def test_preflight_error_plus_stopped_is_not_old_cleanup_success(self):
        controller, _ = self.killed_controller()
        def preflight_failure(process):
            process.emit({"event": "error", "message": "unsafe installation"})
            process.emit({"event": "stopped"})
            process.finish(0)
        controller._popen = FakeFactory(FakeProcess(on_init=preflight_failure))
        with self.assertRaises(client.TunStopError):
            controller.stop()
        self.assertFalse(controller.cleanup_confirmed)
        self.assertTrue(controller.needs_cleanup)

    def test_recovery_timeout_reuses_pending_attempt_and_never_kills(self):
        controller, _ = self.killed_controller()
        controller._start_timeout = controller._stop_timeout = .02
        recovery = FakeProcess(on_init=lambda _: None, ignore_stop=True)
        factory = FakeFactory(recovery)
        controller._popen = factory
        for _ in range(2):
            with self.assertRaises(client.TunStopError):
                controller.stop()
        self.assertEqual(len(factory.calls), 1)
        self.assertTrue(controller.needs_cleanup)
        self.assertEqual(recovery.forced_signals, 0)
        recovery.emit({"event": "stopped"})
        recovery.finish(0)
        self.wait_for(lambda: controller.cleanup_confirmed)
        controller.stop()

    def test_recovery_ready_is_rejected_without_accepting_fresh_credentials(self):
        controller, _ = self.killed_controller()
        controller._popen = FakeFactory(FakeProcess())
        with self.assertRaises(client.TunStopError) as result:
            controller.stop()
        self.assertNotIn(TEST_SECRET, str(result.exception))
        self.assertIn("意外状态", str(result.exception))
        self.assertFalse(controller.cleanup_confirmed)

    def test_missing_recovery_installation_does_not_clear_old_cleanup_obligation(self):
        controller, _ = self.killed_controller()
        factory = FakeFactory(FakeProcess(on_init=self.successful_recovery))
        controller._popen = factory
        with patch.object(client, "_check_installed_helper", side_effect=client.TunStartError("missing package", cleanup_confirmed=True)):
            with self.assertRaises(client.TunStopError) as result:
                controller.stop()
        self.assertIs(result.exception.controller, controller)
        self.assertEqual(factory.calls, [])
        self.assertTrue(controller.needs_cleanup)

    def test_start_timeout_requests_eof_and_waits_for_cleanup(self):
        controller, process, _ = self.make(FakeProcess(on_init=lambda _: None), start_timeout=.02)
        with self.assertRaises(client.TunStartError) as result:
            controller.start()
        self.assertIn("超时", str(result.exception))
        self.assertTrue(result.exception.cleanup_confirmed)
        self.assertIsNone(result.exception.controller)
        self.assertTrue(process.stdin.closed)
        self.assertEqual(process.forced_signals, 0)

    def test_start_timeout_without_cleanup_confirmation_retains_controller(self):
        controller, process, _ = self.make(FakeProcess(on_init=lambda _: None, ignore_stop=True), start_timeout=.02, stop_timeout=.02)
        with self.assertRaises(client.TunStartError) as result:
            controller.start()
        self.assertIn("清理尚未确认", str(result.exception))
        self.assertIs(result.exception.controller, controller)
        self.assertTrue(result.exception.needs_cleanup)
        self.assertFalse(controller.cleanup_confirmed)
        self.assertEqual(process.forced_signals, 0)

    def test_pkexec_cancellation_or_denial_before_helper_has_no_network_changes(self):
        for code, text in ((126, "取消管理员认证"), (127, "未获授权")):
            with self.subTest(code=code):
                controller, _, _ = self.make(FakeProcess(on_init=lambda process, c=code: process.finish(c)))
                with self.assertRaises(client.TunStartError) as result:
                    controller.start()
                self.assertIn(text, str(result.exception))
                self.assertTrue(result.exception.cleanup_confirmed)
                self.assertIsNone(result.exception.controller)

    def test_helper_start_error_with_clean_stop_preserves_error_and_confirms_cleanup(self):
        def fail(process):
            process.emit({"event": "error", "message": "dependency unavailable"})
            process.emit({"event": "stopped"})
            process.finish(0)
        controller, _, _ = self.make(FakeProcess(on_init=fail))
        with self.assertRaises(client.TunStartError) as result:
            controller.start()
        self.assertIn("dependency unavailable", str(result.exception))
        self.assertTrue(result.exception.cleanup_confirmed)

    def test_protocol_event_before_127_keeps_cleanup_unconfirmed(self):
        def fail(process):
            process.emit({"event": "error", "message": "helper failed after launch"})
            process.finish(127)
        controller, _, _ = self.make(FakeProcess(on_init=fail))
        with self.assertRaises(client.TunStartError) as result:
            controller.start()
        self.assertFalse(result.exception.cleanup_confirmed)
        self.assertIs(result.exception.controller, controller)

    def test_invalid_ready_never_exposes_secret_or_accepts_shared_api_proxy_port(self):
        invalid = ready(proxy_port=19090)
        controller, _, _ = self.make(FakeProcess(initial=invalid))
        with self.assertRaises(client.TunStartError) as result:
            controller.start()
        self.assertIn("就绪状态无效", str(result.exception))
        self.assertNotIn(TEST_SECRET, str(result.exception))
        self.assertTrue(result.exception.cleanup_confirmed)

    def test_numeric_ip_and_port_validation(self):
        for host, port in (("example.com", 38473), ("127.0.0.1", 38473), ("0.0.0.0", 38473), ("224.0.0.1", 38473), ("255.255.255.255", 38473), ("fe80::1%wlan0", 38473), ("10.15.60.93", True), ("10.15.60.93", 0)):
            with self.subTest(host=host, port=port), self.assertRaises(ValueError):
                client.TunController(SimpleNamespace(host=host, port=port))
        ipv6 = client.TunController(Endpoint("2001:db8::123", 38473))
        self.assertEqual(ipv6._host, "2001:db8::123")

    def test_missing_installed_helper_does_not_invoke_pkexec(self):
        controller, _, factory = self.make()
        with patch.object(client, "_check_installed_helper", side_effect=client.TunStartError("请安装新版 deb", cleanup_confirmed=True)):
            with self.assertRaisesRegex(client.TunStartError, "新版 deb") as result:
                controller.start()
        self.assertEqual(factory.calls, [])
        self.assertTrue(result.exception.cleanup_confirmed)

    def test_spawn_error_is_sanitized_and_has_no_cleanup_obligation(self):
        controller, _, _ = self.make()
        controller._popen = lambda *args, **kwargs: (_ for _ in ()).throw(OSError(TEST_SECRET))
        with self.assertRaises(client.TunStartError) as result:
            controller.start()
        self.assertNotIn(TEST_SECRET, str(result.exception))
        self.assertTrue(result.exception.cleanup_confirmed)


class InstalledHelperChecks(unittest.TestCase):
    def test_root_managed_regular_executable_is_required(self):
        good = SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=0)
        for details in (
            SimpleNamespace(st_mode=stat.S_IFREG | 0o777, st_uid=0),
            SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=1000),
            SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0),
        ):
            with self.subTest(details=details), patch.object(client.Path, "lstat", side_effect=[good, details]):
                with self.assertRaises(client.TunStartError) as result:
                    client._check_installed_helper()
                self.assertTrue(result.exception.cleanup_confirmed)
        with patch.object(client.Path, "lstat", return_value=good):
            client._check_installed_helper()


class LoopbackApiTests(TunClientFixture):

    def test_real_loopback_api_bypasses_environment_proxy(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            requests = []
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.requests.append((self.path, self.headers.get("Authorization")))
                body = json.dumps({"uploadTotal": 321, "downloadTotal": 654, "connections": []}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            process = FakeProcess(initial=ready(api_port=server.server_port, proxy_port=19091))
            with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "no_proxy": "", "NO_PROXY": ""}):
                controller, _, _ = self.make(process)
                controller._opener = client.urllib.request.build_opener(client.urllib.request.ProxyHandler({}), client._NoRedirect())
                controller.start()
                self.wait_for(lambda: controller.snapshot()["upload_bytes"] == 321)
            self.assertTrue(Handler.requests)
            self.assertEqual(Handler.requests[0], ("/connections", "Bearer " + TEST_SECRET))
            self.assertEqual(controller.snapshot()["download_bytes"], 654)
            controller.stop()
        finally:
            server.shutdown()
            server.server_close()

    def test_api_redirect_is_not_followed(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            paths = []
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.paths.append(self.path)
                self.send_response(302 if self.path == "/connections" else 200)
                if self.path == "/connections":
                    self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/must-not-follow")
                self.send_header("Content-Length", "0")
                self.end_headers()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            controller, _, _ = self.make(FakeProcess(initial=ready(api_port=server.server_port, proxy_port=19091)))
            controller._opener = client.urllib.request.build_opener(client.urllib.request.ProxyHandler({}), client._NoRedirect())
            controller.start()
            self.wait_for(lambda: controller.snapshot()["errors"] > 0)
            controller.stop()
            self.assertTrue(Handler.paths)
            self.assertEqual(set(Handler.paths), {"/connections"})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
