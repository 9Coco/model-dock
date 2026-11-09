"""Windows process cleanup tests use inert Python children, never a TUN."""

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import urllib.request
from unittest.mock import Mock, patch

from windows import native


class NativeNetworkMockTests(unittest.TestCase):
    def test_network_query_refuses_other_interfaces(self):
        with patch.object(native, "powershell_json") as run:
            with self.assertRaises(ValueError):
                native.network_state("Wi-Fi")
            run.assert_not_called()

    def test_weak_host_empty_snapshot_never_changes_settings(self):
        with patch.object(native, "powershell_json") as run:
            native.restore_weak_host([])
            run.assert_not_called()

    def test_weak_host_recovery_rejects_malformed_or_oversized_records(self):
        valid = {"InterfaceIndex": 42, "InterfaceAlias": "Ethernet", "AddressFamily": "IPv4"}
        for rows in (None, {}, [valid] * 1025, [dict(valid, InterfaceIndex=True)],
                     [dict(valid, InterfaceIndex=0)], [dict(valid, AddressFamily="other")],
                     [dict(valid, InterfaceAlias=None)], [dict(valid, unexpected="field")]):
            with self.subTest(rows=str(rows)[:90]), patch.object(native, "powershell_json") as run:
                with self.assertRaises(ValueError):
                    native.restore_weak_host(rows)
                run.assert_not_called()

    def test_recovery_encodes_names_as_data_not_powershell_source(self):
        alias = "Wi-Fi'; Write-Output 'must not run"
        rows = [{"InterfaceIndex": 42, "InterfaceAlias": alias, "AddressFamily": "IPv6"}]
        with patch.object(native, "powershell_json", return_value=True) as run:
            native.restore_weak_host(rows)
        script = run.call_args.args[0]
        self.assertNotIn(alias, script)
        encoded = script.split("FromBase64String('", 1)[1].split("'", 1)[0]
        self.assertEqual(json.loads(base64.b64decode(encoded)), rows)
        self.assertIn("$_.InterfaceAlias -eq $row.InterfaceAlias", script)
        self.assertIn("$_.InterfaceIndex -eq $row.InterfaceIndex", script)

    def test_remote_proxy_needs_no_local_process_bypass(self):
        with patch.object(native, "powershell_json") as run:
            self.assertIsNone(native.local_proxy_process(SimpleNamespace(host="192.168.1.8", port=1080)))
            run.assert_not_called()

    def test_ambiguous_local_listener_is_rejected(self):
        rows = [{"address": "127.0.0.1", "port": 1080, "pid": 42},
                {"address": "0.0.0.0", "port": 1080, "pid": 43}]
        with patch.object(native, "_tcp_listeners", side_effect=[rows, []]), \
                patch.object(native, "_process_image_path", side_effect=lambda pid: f"C:/proxy{pid}.exe"):
            with self.assertRaisesRegex(ValueError, "唯一识别"):
                native.local_proxy_process(SimpleNamespace(host="127.0.0.1", port=1080))

    def test_process_lookup_does_not_interpolate_invalid_port(self):
        with patch.object(native, "powershell_json") as run:
            with self.assertRaises(ValueError):
                native.local_proxy_process(SimpleNamespace(host="127.0.0.1", port="1; Write-Output x"))
            run.assert_not_called()


class NativeListenerTests(unittest.TestCase):
    def test_tcp_abi_layout_uses_sdk_offsets_and_padding(self):
        self.assertEqual(ctypes.sizeof(native._TcpRowOwnerPid), 24)
        self.assertEqual(ctypes.sizeof(native._Tcp6RowOwnerPid), 56)
        self.assertEqual(native._TcpRowOwnerPid.dwLocalPort.offset, 8)
        self.assertEqual(native._Tcp6RowOwnerPid.dwLocalPort.offset, 20)
        self.assertEqual(native._Tcp6RowOwnerPid.dwOwningPid.offset, 52)
        self.assertEqual(native._TcpTableOwnerPid.table.offset, 4)
        self.assertEqual(native._Tcp6TableOwnerPid.table.offset, 4)

    @staticmethod
    def row(address, port, pid=42, state=2):
        family = socket.AF_INET6 if ':' in address else socket.AF_INET
        packed = socket.inet_pton(family, address)
        if family == socket.AF_INET:
            row = native._TcpRowOwnerPid()
            row.dwLocalAddr = int.from_bytes(packed, sys.byteorder)
        else:
            row = native._Tcp6RowOwnerPid()
            row.ucLocalAddr[:] = packed
        row.dwLocalPort = 0xabcd0000 | socket.htons(port)
        row.dwOwningPid, row.dwState = pid, state
        return row

    def table_query(self, rows, *, grow=False):
        table_type = native._Tcp6TableOwnerPid if rows and isinstance(rows[0], native._Tcp6RowOwnerPid) else native._TcpTableOwnerPid
        payload = bytes(native._DWORD(len(rows)))
        payload += b'\0' * (table_type.table.offset - len(payload))
        payload += b''.join(bytes(row) for row in rows)
        calls = []

        def query(buffer, size_ptr, ordered, family, table_class, reserved):
            size = ctypes.cast(size_ptr, ctypes.POINTER(native._DWORD)).contents
            calls.append((size.value, family, table_class, ordered, reserved))
            if grow and len(calls) == 1:
                size.value *= 2
                return 122
            ctypes.memmove(buffer, payload, len(payload))
            size.value = len(payload)
            return 0

        return Mock(side_effect=query), calls

    def test_tcp_tables_decode_ipv4_ipv6_network_ports_and_listener_state(self):
        for family, addresses in ((socket.AF_INET, ('127.0.0.1', '0.0.0.0')),
                                  (socket.AF_INET6, ('::1', '::'))):
            with self.subTest(family=family):
                rows = [self.row(addresses[0], 20081), self.row(addresses[1], 65535, 43),
                        self.row(addresses[0], 80, 44, state=5)]
                query, calls = self.table_query(rows)
                with patch.object(native, '_iphelper', return_value=SimpleNamespace(GetExtendedTcpTable=query)):
                    self.assertEqual(native._tcp_listeners(family), [
                        {'address': addresses[0], 'port': 20081, 'pid': 42},
                        {'address': addresses[1], 'port': 65535, 'pid': 43}])
                self.assertEqual(calls, [(16384, family, 3, False, 0)])

    def test_listener_table_growth_retries_with_new_capacity(self):
        query, calls = self.table_query([self.row('127.0.0.1', 20081)], grow=True)
        with patch.object(native, '_iphelper', return_value=SimpleNamespace(GetExtendedTcpTable=query)):
            self.assertEqual(native._tcp_listeners(socket.AF_INET)[0]['port'], 20081)
        self.assertEqual([call[0] for call in calls], [16384, 32768])

    def test_listener_table_errors_or_endless_growth_never_return_empty_success(self):
        for status in (5, 87, 122):
            query = Mock(return_value=status)
            with self.subTest(status=status), patch.object(native, '_iphelper', return_value=SimpleNamespace(GetExtendedTcpTable=query)):
                with self.assertRaises(OSError):
                    native._tcp_listeners(socket.AF_INET)
                self.assertEqual(query.call_count, 4 if status == 122 else 1)

    def test_listener_table_truncated_count_and_oversized_length_are_rejected(self):
        for returned_size in (3, 16385, 4):
            def query(buffer, size_ptr, *_args):
                ctypes.memmove(buffer, bytes(native._DWORD(99999)), 4)
                ctypes.cast(size_ptr, ctypes.POINTER(native._DWORD)).contents.value = returned_size
                return 0
            with self.subTest(size=returned_size), patch.object(native, '_iphelper', return_value=SimpleNamespace(GetExtendedTcpTable=Mock(side_effect=query))):
                with self.assertRaises(OSError):
                    native._tcp_listeners(socket.AF_INET)

    def test_empty_listener_table_is_valid_but_missing_proxy_is_not(self):
        query, _ = self.table_query([])
        with patch.object(native, '_iphelper', return_value=SimpleNamespace(GetExtendedTcpTable=query)):
            self.assertEqual(native._tcp_listeners(socket.AF_INET), [])
        with patch.object(native, '_tcp_listeners', return_value=[]), patch.object(native, '_process_image_path') as image:
            with self.assertRaises(ValueError):
                native.local_proxy_process(SimpleNamespace(host='127.0.0.1', port=1080))
            image.assert_not_called()

    def test_matching_addresses_ports_and_unique_owner_path(self):
        cases = [('127.0.0.1', '127.0.0.1'), ('127.0.0.1', '0.0.0.0'),
                 ('127.0.0.1', '::'), ('127.0.0.1', '::ffff:127.0.0.1'),
                 ('::1', '::1'), ('::1', '::')]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'proxy.exe'
            path.touch()
            for target, bound in cases:
                rows = [{'address': bound, 'port': 20081, 'pid': 42},
                        {'address': bound, 'port': 20081, 'pid': 42},
                        {'address': bound, 'port': 20082, 'pid': 43},
                        {'address': '192.0.2.1', 'port': 20081, 'pid': 44}]
                with self.subTest(target=target, bound=bound), \
                        patch.object(native, '_tcp_listeners', side_effect=[rows, []]), \
                        patch.object(native, '_process_image_path', return_value=str(path)) as image, \
                        patch.object(native, 'powershell_json') as powershell:
                    self.assertEqual(native.local_proxy_process(SimpleNamespace(host=target, port=20081)), str(path))
                    image.assert_called_once_with(42)
                    powershell.assert_not_called()
            # The IPv4 wildcard cannot own an IPv6-only endpoint.
            with patch.object(native, '_tcp_listeners', side_effect=[[{'address': '0.0.0.0', 'port': 20081, 'pid': 42}], []]):
                with self.assertRaises(ValueError):
                    native.local_proxy_process(SimpleNamespace(host='::1', port=20081))

    def test_owner_permission_failure_cannot_be_ignored(self):
        rows = [{'address': '127.0.0.1', 'port': 1080, 'pid': 42}]
        with patch.object(native, '_tcp_listeners', side_effect=[rows, []]), \
                patch.object(native, '_process_image_path', side_effect=OSError('access denied')):
            with self.assertRaises(OSError):
                native.local_proxy_process(SimpleNamespace(host='127.0.0.1', port=1080))

    def test_current_process_and_flowbridge_binary_are_rejected(self):
        with patch.object(native, '_tcp_listeners', side_effect=[[{'address': '127.0.0.1', 'port': 1080, 'pid': os.getpid()}], []]), \
                patch.object(native, '_process_image_path') as image:
            with self.assertRaisesRegex(ValueError, '自身'):
                native.local_proxy_process(SimpleNamespace(host='127.0.0.1', port=1080))
            image.assert_not_called()
        with tempfile.TemporaryDirectory() as temp:
            for name in ('FlowBridge.exe', 'FlowBridge-Windows.exe', 'ModelDock.exe'):
                path = Path(temp) / name
                path.touch()
                with patch.object(native, '_tcp_listeners', side_effect=[[{'address': '127.0.0.1', 'port': 1080, 'pid': 42}], []]), \
                        patch.object(native, '_process_image_path', return_value=str(path)):
                    with self.assertRaisesRegex(ValueError, '自身'):
                        native.local_proxy_process(SimpleNamespace(host='127.0.0.1', port=1080))

    def test_owner_path_must_be_absolute_and_present(self):
        for path in ('proxy.exe', str(Path(tempfile.gettempdir()) / 'flowbridge-nonexistent-proxy-9275.exe')):
            with self.subTest(path=path), patch.object(native, '_tcp_listeners', side_effect=[[{'address': '127.0.0.1', 'port': 1080, 'pid': 42}], []]), \
                    patch.object(native, '_process_image_path', return_value=path):
                with self.assertRaises(ValueError):
                    native.local_proxy_process(SimpleNamespace(host='127.0.0.1', port=1080))

    @staticmethod
    def process_kernel(*, path='C:\\fixture\\proxy.exe', open_ok=True, query_ok=True, exit_ok=True, exit_code=259):
        def query(_handle, flags, buffer, size_ptr):
            if not query_ok:
                return False
            buffer.value = path
            ctypes.cast(size_ptr, ctypes.POINTER(native._DWORD)).contents.value = len(path)
            return True
        def exit_query(_handle, code_ptr):
            ctypes.cast(code_ptr, ctypes.POINTER(native._DWORD)).contents.value = exit_code
            return exit_ok
        return SimpleNamespace(OpenProcess=Mock(return_value=123 if open_ok else None),
                               QueryFullProcessImageNameW=Mock(side_effect=query),
                               GetExitCodeProcess=Mock(side_effect=exit_query), CloseHandle=Mock(return_value=True))

    def test_process_query_uses_limited_rights_unicode_win32_path_and_closes_handle(self):
        path = 'C:\\代理\\proxy.exe'
        kernel = self.process_kernel(path=path)
        with patch.object(native, '_kernel', return_value=kernel):
            self.assertEqual(native._process_image_path(42), path)
        kernel.OpenProcess.assert_called_once_with(0x1000, False, 42)
        self.assertEqual(kernel.QueryFullProcessImageNameW.call_args.args[1], 0)
        kernel.CloseHandle.assert_called_once_with(123)

    def test_process_access_denied_disappearance_and_query_failure_reject(self):
        for options in ({'open_ok': False}, {'query_ok': False}, {'exit_code': 0}, {'exit_ok': False}, {'path': ''}):
            kernel = self.process_kernel(**options)
            with self.subTest(options=options), patch.object(native, '_kernel', return_value=kernel):
                with self.assertRaises(OSError):
                    native._process_image_path(42)
            self.assertEqual(kernel.CloseHandle.call_count, 0 if options.get('open_ok') is False else 1)

    def test_light_state_uses_native_snapshot_and_forwards_timeout(self):
        expected = {'exists': True, 'up': True, 'routes': 4}
        with patch.object(native.network_snapshot, 'tun_state', return_value=expected) as run, \
                patch.object(native, 'powershell_json') as shell:
            self.assertEqual(native.tun_state(timeout=.75), expected)
            run.assert_called_once_with('modeldock-net', timeout=.75)
            shell.assert_not_called()
        with patch.object(native.network_snapshot, '_api') as run:
            with self.assertRaises(ValueError):
                native.tun_state('Wi-Fi')
            run.assert_not_called()

    def test_full_snapshot_and_recovery_capture_never_fall_back_to_shell_on_error(self):
        for name in ('network_state', 'tun_state', 'capture_weak_host'):
            with self.subTest(name=name), \
                    patch.object(native.network_snapshot, name, side_effect=OSError('read failed')), \
                    patch.object(native, 'powershell_json') as shell:
                with self.assertRaisesRegex(OSError, 'read failed'):
                    getattr(native, name)()
                shell.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows IP Helper integration')
    def test_real_loopback_listener_tables_and_process_path_without_external_traffic(self):
        self.assertTrue(Path(native._process_image_path(os.getpid())).is_file())
        for family, host in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
            with self.subTest(family=family), socket.socket(family, socket.SOCK_STREAM) as listener:
                try:
                    listener.bind((host, 0))
                except OSError as error:
                    if family == socket.AF_INET6:
                        self.skipTest(f'IPv6 loopback unavailable: {error}')
                    raise
                listener.listen()
                port = listener.getsockname()[1]
                self.assertIn({'address': host, 'port': port, 'pid': os.getpid()}, native._tcp_listeners(family))


@unittest.skipUnless(os.name == "nt", "Windows API tests")
class NativeProcessTests(unittest.TestCase):
    def wait_file(self, path, process=None):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if path.exists():
                return path.read_text(encoding="utf-8")
            if process is not None and process.poll() is not None:
                self.fail(f"child exited before readiness: {process.poll()}")
            time.sleep(.03)
        self.fail("inert test child did not become ready")

    def test_native_structure_layout_matches_windows_sdk(self):
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            self.assertEqual(ctypes.sizeof(native._BasicLimits), 64)
            self.assertEqual(ctypes.sizeof(native._ExtendedLimits), 144)
        self.assertEqual(ctypes.sizeof(native._ThreadEntry), 28)

    def test_hidden_child_receives_graceful_console_interrupt(self):
        with tempfile.TemporaryDirectory() as temp:
            ready, stopped = Path(temp) / "ready", Path(temp) / "stopped"
            code = ("import signal,time,sys\nfrom pathlib import Path\n"
                    "def stop(*args):\n Path(sys.argv[2]).write_text('clean',encoding='utf-8')\n raise SystemExit(0)\n"
                    "signal.signal(signal.SIGINT,stop)\n"
                    "Path(sys.argv[1]).write_text('ready',encoding='utf-8')\n"
                    "while True: time.sleep(.1)\n")
            process = native.CoreProcess([sys.executable, "-c", code, str(ready), str(stopped)], cwd=temp)
            try:
                self.wait_file(ready, process)
                process.request_stop()
                self.assertEqual(process.wait(timeout=8), 0)
                self.assertEqual(stopped.read_text(encoding="utf-8"), "clean")
            finally:
                process.close_job()
                process.wait(timeout=8)

    def test_closing_job_terminates_live_child(self):
        with tempfile.TemporaryDirectory() as temp:
            ready = Path(temp) / "ready"
            code = "import time,sys; from pathlib import Path; Path(sys.argv[1]).write_text('ready'); time.sleep(60)"
            process = native.CoreProcess([sys.executable, "-c", code, str(ready)], cwd=temp)
            try:
                self.wait_file(ready, process)
                self.assertIsNone(process.poll())
                process.close_job()
                self.assertIsNotNone(process.wait(timeout=8))
            finally:
                process.close_job()
                process.wait(timeout=8)

    def test_parent_crash_closes_job_and_terminates_child(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp:
            ready, exit_parent = Path(temp) / "ready", Path(temp) / "exit-parent"
            child_code = "import time; time.sleep(60)"
            wrapper = (
                "import os,sys,time\nfrom pathlib import Path\nfrom windows.native import CoreProcess\n"
                "p=CoreProcess([sys.executable,'-c',sys.argv[3]],cwd=sys.argv[4])\n"
                "Path(sys.argv[1]).write_text(str(p.pid))\n"
                "while not Path(sys.argv[2]).exists(): time.sleep(.03)\n"
                "os._exit(0)\n"
            )
            parent = subprocess.Popen([sys.executable, "-c", wrapper, str(ready), str(exit_parent), child_code, temp],
                                      cwd=root, creationflags=subprocess.CREATE_NO_WINDOW)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = None
            try:
                child_pid = int(self.wait_file(ready, parent))
                handle = kernel.OpenProcess(0x100000, False, child_pid)
                self.assertTrue(handle, "hold child handle to avoid PID reuse ambiguity")
                self.assertEqual(kernel.WaitForSingleObject(handle, 0), 258)
                exit_parent.write_text("exit", encoding="utf-8")
                self.assertEqual(parent.wait(timeout=8), 0)
                self.assertEqual(kernel.WaitForSingleObject(handle, 8000), 0)
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=8)
                if handle:
                    kernel.CloseHandle(handle)

    def test_pinned_go_core_gracefully_exits_without_tun_or_external_traffic(self):
        binary = Path(__file__).resolve().parents[1] / "vendor" / "sing-box-1.14.4-windows-amd64" / "sing-box.exe"
        if not binary.is_file():
            self.skipTest("pinned Windows core unavailable")
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "config.json"
            # No inbounds, TUN, DNS configuration or upstream dial. The only
            # listener is the authenticated loopback statistics endpoint.
            config.write_text(json.dumps({"log": {"disabled": True},
                "experimental": {"clash_api": {"external_controller": f"127.0.0.1:{port}", "secret": "test-only"}}}), encoding="utf-8")
            process = native.CoreProcess([str(binary), "run", "-c", str(config)], cwd=binary.parent)
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                request = urllib.request.Request(f"http://127.0.0.1:{port}/version", headers={"Authorization": "Bearer test-only"})
                deadline = time.monotonic() + 8
                ready = False
                while time.monotonic() < deadline and process.poll() is None:
                    try:
                        with opener.open(request, timeout=.2) as response:
                            self.assertEqual(response.status, 200)
                            ready = True
                            break
                    except OSError:
                        time.sleep(.05)
                self.assertTrue(ready, "official core did not open its loopback control API")
                process.request_stop()
                self.assertEqual(process.wait(timeout=8), 0)
            finally:
                process.close_job()
                process.wait(timeout=8)


if __name__ == "__main__":
    unittest.main()
