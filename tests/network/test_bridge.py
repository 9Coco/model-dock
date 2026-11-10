"""ModelDock-specific network adapter tests: all OS operations are injected."""
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import Mock, call, patch
ROOT=Path(__file__).resolve().parents[2]/'resources/flowbridge'
spec=importlib.util.spec_from_file_location('modeldock_bridge',ROOT/'bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix='modeldock-network-bridge-')
        self.addCleanup(self.directory.cleanup)
        self.session=bridge.NetworkSession(Path(self.directory.name))
        self.session.desktop=Mock(last_warning='',journal_path=Path(self.directory.name)/'proxy.json')
        self.session.ensure_guardian=Mock()
    @unittest.skipUnless(sys.platform.startswith('linux'),'Linux desktop fixture')
    def test_state_directory_does_not_select_isolated_desktop_backend(self):
        from linux.system_proxy import DesktopProxyManager
        root=Path(self.directory.name)
        with patch.dict(os.environ,{'XDG_CONFIG_HOME':str(root/'system')}):
            manager=DesktopProxyManager(state_dir=root/'modeldock')
        self.assertFalse(manager._isolated)
        self.assertEqual(manager.kde_path,root/'system/kioslaverc')
        self.assertEqual(manager.journal_path,root/'modeldock/system-proxy-recovery.json')
    def test_failed_restore_preserves_listener_for_retry(self):
        self.session.relay=Mock()
        self.session.relay.snapshot.return_value={}
        self.session.desktop.restore.side_effect=RuntimeError('owned settings conflict')
        with self.assertRaisesRegex(RuntimeError,'conflict'):self.session.disconnect()
        self.session.relay.stop.assert_not_called()
    @unittest.skipUnless(sys.platform == 'win32', 'Windows socket ownership')
    def test_active_http_relay_port_is_exclusive(self):
        relay = bridge.ProxyRelay(bridge.Endpoint('127.0.0.1', 1))
        port = relay.start()
        self.addCleanup(relay.stop)
        with socket.socket() as competing:
            competing.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            with self.assertRaises(OSError) as refused:
                competing.bind(('127.0.0.1', port))
            self.assertIn(refused.exception.winerror, (10013, 10048))
    def test_progress_and_errors_round_trip_through_a_legacy_windows_pipe(self):
        buffer = io.BytesIO()
        with io.TextIOWrapper(buffer, encoding='cp1252') as output, patch.object(sys, 'stdout', output):
            event = {'event': 'progress', 'message': '正在检查网络…'}
            error = {'id': 1, 'ok': False, 'message': '代理未就绪。'}
            bridge.emit(event)
            bridge.emit(error)
            self.assertEqual([json.loads(line.decode('utf-8')) for line in buffer.getvalue().splitlines()], [event, error])
    def test_failed_tun_stop_preserves_controller_and_lease(self):
        self.session.controller=Mock(cleanup_confirmed=False)
        self.session.controller.snapshot.return_value={}
        self.session.controller.close.side_effect=RuntimeError('route still present')
        marker=Path(self.directory.name)/'global-lease.json';marker.write_text('{}')
        with self.assertRaisesRegex(RuntimeError,'route'):self.session.disconnect()
        self.assertIsNotNone(self.session.controller);self.assertTrue(marker.exists())

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux service recovery')
    def test_exit_retries_stale_linux_lease_without_starting_a_tunnel(self):
        marker = Path(self.directory.name) / 'global-lease.json'
        with patch.object(bridge, 'TunController') as controller:
            self.assertTrue(self.session.disconnect()['cleanupConfirmed'])
            controller.assert_not_called()
            marker.write_text('{"version":1}')
            recovery = controller.return_value
            recovery.recover_previous.side_effect = [RuntimeError('service busy'), None]
            with self.assertRaisesRegex(RuntimeError, 'service busy'):
                self.session.disconnect()
            self.assertFalse(self.session.snapshot()['cleanupConfirmed'])
            self.assertTrue(marker.exists())
            self.assertTrue(self.session.disconnect()['cleanupConfirmed'])
            self.assertFalse(marker.exists())
            self.session.disconnect()  # EOF after a successful disconnect.
            controller.assert_called_once()
            self.assertEqual(recovery.recover_previous.call_count, 2)
            recovery.start.assert_not_called()
    def test_preflight_failure_never_changes_desktop_settings(self):
        with patch.object(bridge.connectivity,'probe_http_proxy',side_effect=OSError('HTTP refused')):
            with self.assertRaisesRegex(OSError,'refused'):
                self.session.connect({'address':'http://192.0.2.1:38473','mode':'http','dnsMode':'fast'})
        self.session.desktop.apply.assert_not_called();self.assertIsNone(self.session.relay)
    def test_cancel_after_probe_never_applies_proxy(self):
        with patch.object(bridge.connectivity,'probe_http_proxy',side_effect=lambda _:self.session.cancelled.set()):
            with self.assertRaisesRegex(RuntimeError,'取消'):
                self.session.connect({'address':'http://192.0.2.1:38473','mode':'http','dnsMode':'fast'})
        self.session.desktop.apply.assert_not_called()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux global route preflight')
    def test_flowbridge_route_to_endpoint_blocks_connect_before_tun_start(self):
        settings = {'mode': 'global', 'address': 'socks5://[2001:db8::1]:1080'}
        route = Mock(stdout=b'[{"dev":"flowbridge0","table":48273}]')
        with patch.object(bridge.shutil, 'which', return_value='/usr/bin/ip'), \
             patch.object(bridge.subprocess, 'run', return_value=route) as lookup, \
             patch.object(bridge.connectivity, 'probe_global_proxy') as probe, \
             patch.object(bridge, 'TunController') as controller:
            with self.assertRaisesRegex(RuntimeError, '先断开独立流桥'):
                self.session.connect(settings)
            self.assertEqual(lookup.call_args.args[0], [
                '/usr/bin/ip', '-N', '-j', 'route', 'get', '2001:db8::1', 'ipproto', 'tcp', 'dport', '1080'])
            probe.assert_not_called()
            controller.assert_not_called()
            self.assertFalse((self.session.directory / 'global-lease.json').exists())

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux global route preflight')
    def test_unrelated_or_unknown_route_still_uses_full_proxy_probe(self):
        endpoint = bridge.Endpoint('192.0.2.1', 38473)
        for route in (b'[{"dev":"wlan0"}]', b'[{"dev":"wg0","table":48273}]', b'[{"dev":"flowbridge0","table":"123"}]', b'[]', b'invalid',
                      FileNotFoundError(), bridge.subprocess.TimeoutExpired('ip', 2)):
            with self.subTest(route=route), patch.object(bridge.shutil, 'which', return_value='/usr/bin/ip'), \
                 patch.object(bridge.subprocess, 'run', side_effect=[route if isinstance(route, Exception) else Mock(stdout=route)]), \
                 patch.object(bridge.connectivity, 'probe_global_proxy') as probe:
                bridge.probe_global_proxy(endpoint, cancel_event=self.session.cancelled, progress=Mock())
                probe.assert_called_once_with(endpoint, tcp_target='example.com')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux SOCKS5 retries')
    def test_only_target_failures_switch_tcp_targets_and_retry_is_bounded(self):
        probe_api = bridge.connectivity
        endpoint = bridge.Endpoint('192.0.2.1', 38473)
        for failure, target in [
            (probe_api.GlobalProbeTargetRejected('example.com', 4), 'www.microsoft.com'),
            (probe_api.GlobalProbeTargetTimeout('target timed out'), 'www.microsoft.com'),
            (probe_api.GlobalProbeTimeout('upstream timed out'), 'example.com'),
            (probe_api.GlobalProbeTransient('UDP transport failed'), 'example.com'),
        ]:
            cancel = Mock()
            cancel.is_set.return_value = cancel.wait.return_value = False
            progress = Mock()
            with self.subTest(failure=failure), patch.object(bridge, 'check_global_upstream_route'), \
                 patch.object(probe_api, 'probe_global_proxy', side_effect=[failure, failure]) as probe:
                with self.assertRaisesRegex(OSError, r'192\.0\.2\.1:38473 已检测两次') as caught:
                    bridge.probe_global_proxy(endpoint, cancel_event=cancel, progress=progress)
                self.assertIn(str(failure), str(caught.exception))
                self.assertEqual(probe.call_args_list, [call(endpoint, tcp_target='example.com'),
                                                       call(endpoint, tcp_target=target)])
                progress.assert_called_once()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux SOCKS5 retries')
    def test_protocol_failure_and_cancel_during_retry_never_probe_again(self):
        endpoint = bridge.Endpoint('192.0.2.1', 38473)
        with patch.object(bridge, 'check_global_upstream_route'), \
             patch.object(bridge.connectivity, 'probe_global_proxy', side_effect=OSError('invalid SOCKS5')) as probe:
            progress = Mock()
            with self.assertRaisesRegex(OSError, 'invalid SOCKS5'):
                bridge.probe_global_proxy(endpoint, cancel_event=self.session.cancelled, progress=progress)
            probe.assert_called_once()
            progress.assert_not_called()
            probe.reset_mock()
            probe.side_effect = bridge.connectivity.GlobalProbeTimeout('upstream timed out')
            with self.assertRaisesRegex(InterruptedError, '取消'):
                bridge.probe_global_proxy(endpoint, cancel_event=self.session.cancelled,
                                          progress=lambda _: self.session.cancelled.set())
            probe.assert_called_once()
    @unittest.skipUnless(sys.platform == 'win32', 'Windows protected task')
    def test_task_authorization_precedes_lease_and_governs_global_recovery(self):
        settings = {'mode': 'global', 'address': 'socks5://127.0.0.1:1080', 'dnsMode': 'fast'}
        marker = Path(self.directory.name) / 'global-lease.json'
        self.session.access = Mock()
        def request(method, **args):
            self.assertEqual(json.loads(marker.read_text()), {'version': 2})
            if method == 'start': return 12345
            if method == 'snapshot': return {'running': True}
            self.assertEqual(method, 'stop')
            return True
        self.session.access.call.side_effect = request
        with patch.object(bridge, 'probe_global_proxy'):
            self.session.access.open.side_effect = RuntimeError('取消授权')
            with self.assertRaisesRegex(RuntimeError, '取消授权'):
                self.session.connect(settings, True)
            self.assertFalse(marker.exists())
            self.session.access.call.assert_not_called()
            self.session.access.open.side_effect = None
            result = self.session.connect(settings, False)
            self.session.access.open.assert_called_with(False)
            self.assertTrue(result['running'])
            self.assertEqual(result['localPort'], 12345)
            self.assertTrue(self.session.disconnect()['cleanupConfirmed'])
            self.assertFalse(marker.exists())
        # A fresh bridge has no controller and can only ask the protected task to recover.
        marker.write_text('{"version":2}')
        self.session.disconnect()
        self.session.access.call.assert_called_with('stop')
        self.assertFalse(marker.exists())
        marker.write_text('{"version":2}')
        self.session.disconnect(allow_install=True)
        self.session.access.open.assert_called_with(True, recovery=True)
        self.session.access.call.assert_called_with('stop')
        self.assertFalse(marker.exists())
    def test_successful_stop_clears_only_owned_marker(self):
        marker=Path(self.directory.name)/'global-lease.json';marker.write_text('{}')
        retained=Path(self.directory.name)/'preserved.txt';retained.write_text('unrelated')
        self.session.controller=Mock(cleanup_confirmed=True)
        self.session.controller.snapshot.return_value={}
        result=self.session.disconnect()
        self.assertTrue(result['cleanupConfirmed']);self.assertFalse(marker.exists());self.assertEqual(retained.read_text(),'unrelated')
    def test_embedded_windows_stop_uses_fixed_script_not_cwd_module_lookup(self):
        from windows import native
        process=native.CoreProcess.__new__(native.CoreProcess)
        process.process=Mock(pid=12345)
        process.job=None
        with patch.object(native.subprocess,'CREATE_NO_WINDOW',0,create=True), patch.object(native.subprocess,'run',return_value=Mock(returncode=0)) as run:
            process.request_stop()
        command=run.call_args.args[0]
        self.assertEqual(command[1:3],['-I','-B'])
        self.assertEqual(Path(command[3]),ROOT/'signal_core.py')
        self.assertEqual(command[-1],'12345')
        self.assertNotIn('-m',command)
    def test_unknown_websites_are_not_fetch_targets(self):
        with self.assertRaises(ValueError):self.session.check('http://127.0.0.1/private')
    def test_website_check_after_disconnect_uses_fresh_cancellation(self):
        self.session.disconnect()
        previous=self.session.check_cancel
        self.assertTrue(previous.is_set())
        def check(url, *, cancellation):
            self.assertIsNot(cancellation,previous)
            self.assertFalse(cancellation.is_set())
            return {'ok':True}
        with patch.object(bridge.connectivity,'test_system_website',side_effect=check), patch.object(bridge,'asdict',side_effect=lambda value:value):
            self.assertEqual(self.session.check(next(iter(bridge.connectivity.SITES))),{'system':{'ok':True},'proxy':None})
if __name__=='__main__':unittest.main()
