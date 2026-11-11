"""The reusable grant is tested without installing a task or changing any routes."""
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import uuid
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2] / 'resources/flowbridge'
sys.path.insert(0, str(ROOT))
from windows import network_access as access, network_worker as worker, network_pipe

SID = 'S-1-5-21-1-2-3-1001'


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        def replace(name, **kwargs):
            return self.stack.enter_context(patch.object(access, name, **kwargs))
        replace('user_sid', return_value=SID)
        self.state = replace('task_state', return_value='missing')
        self.install = replace('install')
        self.run_task = replace('run', return_value=Mock(returncode=0))
        self.pipe = replace('open_client', side_effect=lambda sid: Mock())

    def test_first_manual_grant_is_reused_after_disconnect_and_new_app_process(self):
        self.install.side_effect = lambda *_: setattr(self.state, 'return_value', 'ready')
        client = access.NetworkAccess(Mock())
        client.open(True)
        client.release()
        client.open(True)
        client.release()
        access.NetworkAccess(Mock()).open(False)
        self.install.assert_called_once_with(SID, access.PAYLOAD_SHA256)
        self.assertEqual(self.run_task.call_count, 3)
        self.assertEqual(self.run_task.call_args.args[0][-1], 'ModelDock.Network.' + SID)

    def test_cancellation_and_unattended_connect_never_start_a_task(self):
        client = access.NetworkAccess(Mock())
        self.install.side_effect = RuntimeError('已取消')
        with self.assertRaisesRegex(RuntimeError, '取消'):
            client.open(True)
        with self.assertRaises(access.AuthorizationRequired):
            client.open(False)
        self.install.assert_called_once()
        self.run_task.assert_not_called()
        self.pipe.assert_not_called()

    def test_recovery_reuses_only_the_known_compatible_protected_worker(self):
        previous = '9a094115e411455ebd48976ab1719e55008f97ef4116420db00e2c77156036f7'
        self.assertIn(previous, access.RECOVERY_PREDECESSORS)
        stream = self.pipe.return_value = Mock()
        self.pipe.side_effect = None
        stream.readline.return_value = b'{"result":true}\n'
        self.state.side_effect = lambda sid, digest: 'ready' if digest == previous else 'outdated'
        self.assertTrue(access.NetworkAccess(Mock()).call('stop'))
        stream.write.assert_called_once_with(b'{"method": "stop"}\n')
        with self.assertRaises(access.AuthorizationRequired):
            access.NetworkAccess(Mock()).open(False)
        self.state.side_effect = None
        self.state.return_value = 'outdated'
        with self.assertRaises(access.AuthorizationRequired):
            access.NetworkAccess(Mock()).call('stop')
        self.install.assert_not_called()
        self.run_task.assert_called_once()

    def test_recovery_accepts_recent_previous_payloads_only_for_stopping(self):
        stream = self.pipe.return_value = Mock()
        self.pipe.side_effect = None
        stream.readline.return_value = b'{"result":true}\n'
        for previous in ('5e6024be86dc8e951162936a9a8de7324bbb1c3231dcfcf1b300c9d10ea4f860',
                         '988ad9732df5efe0940552d71fd846716db3b6cc9d4a27edb94f0ac0a80121fd'):
            with self.subTest(previous=previous):
                self.assertIn(previous, access.RECOVERY_PREDECESSORS)
                stream.reset_mock()
                self.state.side_effect = lambda sid, digest: 'ready' if digest == previous else 'outdated'
                self.assertTrue(access.NetworkAccess(Mock()).call('stop'))
                stream.write.assert_called_once_with(b'{"method": "stop"}\n')
                with self.assertRaises(access.AuthorizationRequired):
                    access.NetworkAccess(Mock()).open(False)
        self.install.assert_not_called()

    def test_manual_repair_upgrades_the_old_pipe_before_recovery(self):
        self.state.return_value = 'outdated'
        access.NetworkAccess(Mock()).open(True, recovery=True)
        self.install.assert_called_once_with(SID, access.PAYLOAD_SHA256)

    def test_disabled_or_foreign_task_is_never_replaced(self):
        for state in ('disabled', 'conflict'):
            self.state.return_value = state
            with self.assertRaises(RuntimeError):
                access.NetworkAccess(Mock()).open(True)
        self.install.assert_not_called()
        self.run_task.assert_not_called()

    def test_payload_manifest_is_pinned(self):
        self.assertEqual(hashlib.sha256((ROOT / 'windows/install-network.ps1').read_bytes()).hexdigest(),
                         access.INSTALLER_SHA256)
        manifest = (ROOT / 'windows/network-payload.json').read_bytes()
        self.assertEqual(hashlib.sha256(manifest).hexdigest(), access.PAYLOAD_SHA256)
        for name, expected in json.loads(manifest).items():
            if name.startswith(('vendor/', 'python/')): continue  # also verified in each packaged Windows app
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), expected, name)


class WorkerTests(unittest.TestCase):
    def exchange(self, requests, controller):
        stream = Mock()
        stream.readline = io.BytesIO(b''.join(json.dumps(r).encode() + b'\n' for r in requests)).readline
        with patch.object(worker, 'TunController', return_value=controller) as factory:
            worker.serve(stream, Path('protected-fixture'))
        return [json.loads(call.args[0]) for call in stream.write.call_args_list], factory

    def test_rejects_command_and_path_injection_and_restores_on_eof(self):
        start = {'method': 'start', 'address': 'socks5://127.0.0.1:1080', 'dnsMode': 'fast'}
        controller = Mock(info={'proxy_port': 54321})
        replies, factory = self.exchange([{'method': 'exec'}, {**start, 'state_dir': 'other'}, start], controller)
        self.assertEqual([set(r) for r in replies], [{'error'}, {'error'}, {'result'}])
        self.assertEqual(replies[-1]['result'], 54321)
        self.assertEqual(factory.call_count, 1)
        self.assertEqual(factory.call_args.kwargs['state_dir'], Path('protected-fixture'))
        controller.start.assert_called_once()
        controller.close.assert_called_once()

    def test_cleanup_failure_can_be_retried_on_the_same_session(self):
        controller = Mock(info={'proxy_port': 54321}, cleanup_confirmed=True)
        controller.close.side_effect = [RuntimeError('route in use'), None]
        replies, _ = self.exchange([{'method': 'start', 'address': '127.0.0.1:1080', 'dnsMode': 'fast'},
                                    {'method': 'stop'}, {'method': 'stop'}], controller)
        self.assertEqual(replies[-2:], [{'error': 'route in use'}, {'result': True}])
        self.assertEqual(controller.close.call_count, 2)

    def test_allowlist_is_carried_from_task_client_to_protected_controller(self):
        endpoint = worker.parse_global_address('socks5://127.0.0.1:1080')
        destinations = ['192.0.2.42', '2001:db8::42']
        access_client = Mock()
        controller = access.TaskTunController(access_client, endpoint, 'fast', bypass_addresses=destinations)
        controller.start()
        method, = access_client.call.call_args.args
        request = {'method': method, **access_client.call.call_args.kwargs}
        replies, factory = self.exchange([request], Mock(info={'proxy_port': 54321}))
        self.assertEqual(replies, [{'result': 54321}])
        self.assertEqual(factory.call_args.kwargs['bypass_addresses'], destinations)

    def test_protected_controller_rejects_invalid_allowlist_before_start(self):
        stream = Mock()
        request = {'method': 'start', 'address': 'socks5://127.0.0.1:1080', 'dnsMode': 'fast',
                   'bypassAddresses': ['0.0.0.0/0']}
        stream.readline = io.BytesIO(json.dumps(request).encode() + b'\n').readline
        with patch.object(worker.TunController, 'start') as start:
            worker.serve(stream, Path('protected-fixture'))
        start.assert_not_called()
        reply = json.loads(stream.write.call_args.args[0])
        self.assertIn('直连白名单', reply['error'])


@unittest.skipUnless(sys.platform == 'win32', 'Windows native pipe')
class NativePipeTests(unittest.TestCase):
    def test_native_transport_and_rejection_of_a_user_owned_worker(self):
        # The synthetic server is owned by the test user. Only the positive transport
        # check substitutes peer identity. Production always requires LocalSystem ownership.
        name = '\\\\.\\pipe\\ModelDock.Test.' + uuid.uuid4().hex
        def open_test_pipe():
            for _ in range(100):
                try: return network_pipe.open_client(SID)
                except FileNotFoundError: time.sleep(.02)
            self.fail('pipe did not appear')
        with patch.object(network_pipe, 'pipe_name', return_value=name):
            for trusted in (True, False):
                received = []
                failures = []
                def server():
                    try:
                        # Full owner access masks CreateFileW's FILE_READ_ATTRIBUTES check.
                        user = access.user_sid()
                        with network_pipe._accept(name, f'D:P(A;;GA;;;SY)(A;;0x{network_pipe.CLIENT_ACCESS:x};;;{user})') as stream:
                            if trusted:
                                received.append(stream.readline(128))
                                stream.write(b'ack\n')
                    except BrokenPipeError as error:
                        if trusted: failures.append(error)
                    except Exception as error:
                        failures.append(error)
                thread = threading.Thread(target=server, daemon=True)
                thread.start()
                if trusted:
                    with patch.object(network_pipe, '_owner_is_system', return_value=True), open_test_pipe() as client:
                        client.write(b'hello\n')
                        self.assertEqual(client.readline(128), b'ack\n')
                    self.assertEqual(received, [b'hello\n'])
                else:
                    with self.assertRaisesRegex(PermissionError, '系统身份'):
                        open_test_pipe()
                thread.join(4)
                self.assertFalse(thread.is_alive())
                self.assertEqual(failures, [])
