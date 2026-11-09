"""Phone installer regressions; optional GOST tests use temporary loopback only.

Run normal checks: python3 -m unittest discover -s tools -p test_termux_proxy.py
Real protocol checks: FLOWBRIDGE_GOST_BIN=/absolute/path/gost python3 -m unittest
    discover -s tools -p test_termux_proxy.py
Socket cleanup checks use temporary Unix sockets. The latter additionally needs
permission to open temporary local TCP/UDP listening sockets.
"""
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'termux' / 'src'
SPEC = importlib.util.spec_from_file_location('flowbridge_phone_monitor_v04', SOURCE / 'monitor.py')
MONITOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MONITOR
SPEC.loader.exec_module(MONITOR)


def installer_text():
    parts = [(SOURCE / 'install-prefix.sh').read_text()]
    for index, name in enumerate(('proxy.sh', 'monitor.py', 'address.py')):
        marker = f'__TEST_PAYLOAD_{index}__'
        parts.append(f'cat > "$DESTINATION/{name}" <<\'{marker}\'\n' +
                     (SOURCE / name).read_text().rstrip() + '\n' + marker + '\n')
    parts.append((SOURCE / 'install-suffix.sh').read_text())
    return '\n'.join(parts)


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / 'home'
        self.home.mkdir()
        self.prefix = self.base / 'prefix'
        self.bin = self.prefix / 'bin'
        self.bin.mkdir(parents=True)
        self.app = self.home / '.local/share/termux-hotspot-proxy'
        self.env = os.environ.copy()
        self.env.update(HOME=str(self.home), PREFIX=str(self.prefix), SHELL='/bin/bash',
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        HOTSPOT_PROXY_ROOT=str(self.app), HOTSPOT_PROXY_PYTHON=sys.executable)
        self.env.pop('ZDOTDIR', None)
        for name, target in [('bash', shutil.which('bash')), ('python', sys.executable)]:
            (self.bin / name).symlink_to(target)
        for name, content in [('pkg', '#!/bin/sh\nexit 99\n'),
                              ('gost', '#!/bin/sh\nprintf "gost v3.3.0\\n"\n')]:
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o700)
        self.installer = self.base / 'installer.sh'
        self.installer.write_text(installer_text())

    def run_installer(self, *args):
        return subprocess.run(['bash', str(self.installer), *args], env=self.env,
                              capture_output=True, text=True, timeout=15)

    def run_proxy(self, *args):
        return subprocess.run(['bash', str(SOURCE / 'proxy.sh'), *args], env=self.env,
                              capture_output=True, text=True, timeout=15)

    def test_bash_syntax(self):
        for path in [self.installer, SOURCE / 'proxy.sh']:
            result = subprocess.run(['bash', '-n', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_extract_does_not_install_or_write_startup(self):
        destination = self.base / 'extracted source'
        result = self.run_installer('--extract', str(destination))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((destination / 'proxy.sh').read_text(), (SOURCE / 'proxy.sh').read_text())
        self.assertFalse((self.bin / 'hotspot-proxy').exists())
        self.assertFalse((self.home / '.bashrc').exists())
        self.assertFalse(self.app.exists())

    def test_reinstall_preserves_settings_ip_disabled_and_one_hook(self):
        (self.app / 'config').mkdir(parents=True)
        (self.app / 'state').mkdir()
        settings = '# custom settings\nPROXY_PORT=45678\nMETRICS_PORT=19876\nWAKE_LOCK=0\n'
        (self.app / 'config/settings.conf').write_text(settings)
        (self.app / 'config/phone-ip').write_text('10.15.60.93\n')
        (self.app / 'state/autostart-disabled').write_text('')
        (self.home / '.bashrc').write_text('export KEEP_ME=yes\n')
        for _ in range(2):
            result = self.run_installer('--no-start')
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.app / 'config/settings.conf').read_text(), settings)
        self.assertEqual((self.app / 'config/phone-ip').read_text(), '10.15.60.93\n')
        self.assertTrue((self.app / 'state/autostart-disabled').exists())
        hook = (self.home / '.bashrc').read_text()
        self.assertTrue(hook.startswith('export KEEP_ME=yes\n'))
        self.assertEqual(hook.count('# >>> termux-hotspot-proxy >>>'), 1)
        self.assertFalse((self.app / 'state/gost.pid').exists())
        self.assertIn('hotspot-proxy restart', result.stdout)

    def test_explicit_port_and_ip_override_with_no_start(self):
        result = self.run_installer('--no-start', '--port', '41573', '--ip', '192.168.9.1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PROXY_PORT=41573\n', (self.app / 'config/settings.conf').read_text())
        self.assertEqual((self.app / 'config/phone-ip').read_text(), '192.168.9.1\n')
        self.assertFalse((self.app / 'state/gost.pid').exists())

    def test_invalid_port_rejected_before_install(self):
        for port in ['0', '1023', '65536', '8080;echo x', '-1']:
            result = self.run_installer('--no-start', '--port', port)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.app.exists())
        self.assertFalse((self.home / '.bashrc').exists())

    def test_foreign_launcher_is_preserved(self):
        launcher = self.bin / 'hotspot-proxy'
        launcher.write_text('#!/bin/sh\necho foreign\n')
        result = self.run_installer('--no-start')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(launcher.read_text(), '#!/bin/sh\necho foreign\n')
        self.assertFalse(self.app.exists())

    def test_autostart_off_does_not_start_any_process(self):
        result = self.run_proxy('autostart', 'off')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.env['HOTSPOT_PROXY_GOST'] = 'missing-gost-test-command'
        result = self.run_proxy('auto')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.app / 'state/gost.pid').exists())

    def test_generated_shared_service_preserves_custom_port(self):
        (self.app / 'config').mkdir(parents=True)
        (self.app / 'config/settings.conf').write_text('PROXY_PORT=41573\nMETRICS_PORT=19876\nWAKE_LOCK=0\n')
        self.generate_config()
        config = (self.app / 'config/gost.yaml').read_text()
        for item in ['0.0.0.0:41573', '127.0.0.1:19876', 'type: auto', 'udp: true', 'udpBufferSize: 65535', 'type: tcp', 'enableStats: true', 'unix://']:
            self.assertIn(item, config)
        self.assertNotIn('udpOverTcp', config)
        self.assertNotIn('uot', config)

    def generate_config(self):
        # Evaluate the real functions without dispatching main/start (no sockets).
        script = (SOURCE / 'proxy.sh').read_text().rsplit('\nmain "$@"', 1)[0]
        result = subprocess.run(['bash', '-c', script + '\nload_settings\nwrite_config\n'],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_banner_names_shared_protocol_and_global_entry(self):
        (self.app / 'config').mkdir(parents=True)
        (self.app / 'config/phone-ip').write_text('192.168.9.1\n')
        shutil.copy2(SOURCE / 'address.py', self.app / 'address.py')
        result = self.run_proxy('info')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('192.168.9.1:38473', result.stdout)
        self.assertIn('SOCKS5', result.stdout)
        self.assertIn('TCP', result.stdout)
        self.assertIn('UDP', result.stdout)
        self.assertIn('ModelDock 首页的“网络接管”', result.stdout)
        self.assertIn('“全局流量”', result.stdout)

    def run_wake_lifecycle(self, *, existing, command='start', wake=1, outcome='success'):
        (self.app / 'config').mkdir(parents=True, exist_ok=True)
        (self.app / 'state').mkdir(parents=True, exist_ok=True)
        (self.app / 'config/settings.conf').write_text(
            f'PROXY_PORT=38473\nMETRICS_PORT=19090\nWAKE_LOCK={wake}\n')
        requests = self.app / 'state/wake-requests'
        requests.unlink(missing_ok=True)
        pid_file = self.app / 'state/gost.pid'
        if existing:
            pid_file.write_text('24680\n')
        else:
            pid_file.unlink(missing_ok=True)
        script = (SOURCE / 'proxy.sh').read_text().rsplit('\nmain "$@"', 1)[0]
        script += '''
ready() { return 0; }
banner() { :; }
termux-wake-lock() {
    echo requested >> "$STATE_DIR/wake-requests"
'''
        script += f'    return {7 if outcome == "failure" else 0}\n}}\n'
        if outcome == 'missing':
            # Make just this optional command unavailable regardless of host
            # packages; all required command lookups still use Bash's builtin.
            script += '''
command() {
    if [[ "$1" == -v && "${2:-}" == termux-wake-lock ]]; then return 1; fi
    builtin command "$@"
}
'''
        if existing:
            script += '''
owned_pid() { cat "$PID_FILE"; }
check_ports() { echo 'unexpected restart' >&2; return 99; }
'''
        else:
            # Exercise the production launch/readiness/PID path with a local
            # sleeping child. No network or Android service is used in this test.
            script += '''
owned_pid() { return 1; }
check_ports() { return 0; }
nohup() { exec sleep 30; }
cleanup_test_child() {
    if [[ -s "$PID_FILE" ]]; then
        test_child=$(cat "$PID_FILE")
        kill "$test_child" 2>/dev/null || true
        wait "$test_child" 2>/dev/null || true
    fi
}
trap cleanup_test_child EXIT
'''
        script += f'\nmain {command}\n'
        if not existing:
            script += 'kill -0 "$(cat "$PID_FILE")"\n'
        result = subprocess.run(['bash', '-c', script], env=self.env,
                                capture_output=True, text=True, timeout=5)
        return result, requests, pid_file

    def test_existing_ready_start_and_auto_request_wake_lock_without_restart(self):
        for command in ('start', 'auto'):
            with self.subTest(command=command):
                result, requests, pid_file = self.run_wake_lifecycle(existing=True, command=command)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(pid_file.read_text(), '24680\n')
                self.assertEqual(requests.read_text(), 'requested\n')
                self.assertIn('代理已在运行', result.stdout)
                self.assertNotIn('警告', result.stderr)

    def test_first_ready_start_requests_wake_lock(self):
        result, requests, pid_file = self.run_wake_lifecycle(existing=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreater(int(pid_file.read_text()), 1)
        self.assertEqual(requests.read_text(), 'requested\n')
        self.assertIn('代理已启动', result.stdout)
        self.assertNotIn('警告', result.stderr)

    def test_wake_lock_disabled_is_respected_for_new_and_existing_proxy(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                result, requests, _ = self.run_wake_lifecycle(existing=existing, wake=0)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(requests.exists())
                self.assertNotIn('警告', result.stderr)

    def test_wake_lock_failure_warns_without_failing_new_or_existing_proxy(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                result, requests, _ = self.run_wake_lifecycle(existing=existing, outcome='failure')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(requests.read_text(), 'requested\n')
                self.assertIn('申请 Termux 唤醒锁失败', result.stderr)
                self.assertIn('代理继续运行', result.stderr)

    def test_missing_wake_lock_command_warns_without_failing_proxy(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                result, requests, _ = self.run_wake_lifecycle(existing=existing, outcome='missing')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(requests.exists())
                self.assertIn('缺少 termux-wake-lock', result.stderr)
                self.assertIn('代理继续运行', result.stderr)



class ApiSocketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.app = self.base / 'app'
        (self.app / 'state').mkdir(parents=True)
        self.path = self.app / 'state/gost-api.sock'
        self.env = os.environ.copy()
        self.env.update(HOTSPOT_PROXY_ROOT=str(self.app), HOTSPOT_PROXY_PYTHON=sys.executable)
        self.functions = (SOURCE / 'proxy.sh').read_text().rsplit('\nmain "$@"', 1)[0]

    def prepare(self, patch_code=''):
        env = self.env.copy()
        if patch_code:
            # Inject failures into the Python process executing the production
            # helper, while retaining its real filesystem operations and checks.
            wrapper = self.base / 'python-with-fault'
            wrapper.write_text('#!' + sys.executable + '\n'
                               'import errno, os, socket, sys\n'
                               'sys.argv.pop(1)\n' + patch_code + '\n'
                               'exec(compile(sys.stdin.read(), "<proxy-helper>", "exec"))\n')
            wrapper.chmod(0o700)
            env['HOTSPOT_PROXY_PYTHON'] = str(wrapper)
        return subprocess.run(['bash', '-c', self.functions + '\nwith_lock prepare_api_socket\n'],
                              env=env, capture_output=True, text=True, timeout=5)

    def bind_socket(self, path=None):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(sock.close)
        sock.bind(str(path or self.path))
        return sock

    def test_missing_socket_is_idempotent(self):
        for _ in range(2):
            result = self.prepare()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(self.path.exists())

    def test_stale_socket_is_removed_and_can_be_rebound(self):
        self.bind_socket().close()
        self.assertTrue(self.path.is_socket())
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.path.exists())
        self.bind_socket().listen(1)

    def test_active_socket_is_preserved_and_rejected(self):
        server = self.bind_socket()
        server.listen(1)
        before = self.path.stat()
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('管理接口仍在使用', result.stderr)
        self.assertEqual(self.path.stat().st_ino, before.st_ino)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect(str(self.path))

    def test_regular_file_is_preserved_and_rejected(self):
        self.path.write_text('unrelated file\n')
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.path.read_text(), 'unrelated file\n')

    def test_symlink_to_socket_and_dangling_symlink_are_preserved(self):
        target = self.base / 'target.sock'
        self.bind_socket(target).close()
        self.path.symlink_to(target)
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(self.path.is_symlink())
        self.assertTrue(target.is_socket())
        target.unlink()
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(self.path.is_symlink())

    def test_unexpected_connect_errors_preserve_socket(self):
        self.bind_socket().close()
        before = self.path.stat()
        for error in ('EACCES', 'EPERM', 'ETIMEDOUT', 'ENOENT'):
            with self.subTest(error=error):
                result = self.prepare(
                    'def failed_connect(self, address):\n'
                    f'    raise OSError(errno.{error}, "injected connect failure")\n'
                    'socket.socket.connect = failed_connect\n')
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('injected connect failure', result.stderr)
                self.assertEqual(self.path.stat().st_ino, before.st_ino)

    def test_connect_timeout_without_errno_preserves_socket(self):
        self.bind_socket().close()
        before = self.path.stat()
        result = self.prepare(
            'def timed_out_connect(self, address):\n'
            '    raise socket.timeout("injected timeout")\n'
            'socket.socket.connect = timed_out_connect\n')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('injected timeout', result.stderr)
        self.assertEqual(self.path.stat().st_ino, before.st_ino)

    def test_socket_owned_by_another_uid_is_preserved(self):
        self.bind_socket().close()
        before = self.path.stat()
        # Simulate a different caller UID without changing real ownership.
        result = self.prepare(f'os.getuid = lambda: {os.getuid() + 1}\n')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('不是当前用户的 socket', result.stderr)
        self.assertEqual(self.path.stat().st_ino, before.st_ino)

    def test_socket_replaced_during_probe_is_preserved(self):
        self.bind_socket().close()
        replacement = self.base / 'replacement.sock'
        self.bind_socket(replacement).close()
        replacement_inode = replacement.stat().st_ino
        result = self.prepare(
            'def raced_connect(self, address):\n'
            f'    os.replace({str(replacement)!r}, address)\n'
            '    raise OSError(errno.ECONNREFUSED, "injected stale result")\n'
            'socket.socket.connect = raced_connect\n')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('检查期间发生变化', result.stderr)
        self.assertTrue(self.path.is_socket())
        self.assertEqual(self.path.stat().st_ino, replacement_inode)

    def test_regular_file_replacing_socket_during_probe_is_preserved(self):
        self.bind_socket().close()
        replacement = self.base / 'replacement.txt'
        replacement.write_text('keep replacement\n')
        result = self.prepare(
            'def raced_connect(self, address):\n'
            f'    os.replace({str(replacement)!r}, address)\n'
            '    raise OSError(errno.ECONNREFUSED, "injected stale result")\n'
            'socket.socket.connect = raced_connect\n')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('检查期间发生变化', result.stderr)
        self.assertEqual(self.path.read_text(), 'keep replacement\n')


class MonitorTests(unittest.TestCase):
    def test_correct_mixed_tcp_and_reversed_udp_exactly(self):
        mixed = MONITOR.Counters(5385, 4486, 1)
        result = MONITOR.correct_udp_directions(mixed, (385, 4086), (385, 4086))
        self.assertEqual((result.upload_bytes, result.download_bytes), (785, 9086))
        self.assertFalse(result.sample_approximate)
        self.assertEqual(result.error_bound_bytes, 0)

    def test_tcp_only_and_udp_only(self):
        tcp = MONITOR.correct_udp_directions(MONITOR.Counters(400, 5000, 1), (400, 5000), (400, 5000))
        self.assertEqual((tcp.upload_bytes, tcp.download_bytes), (400, 5000))
        udp = MONITOR.correct_udp_directions(MONITOR.Counters(5000, 400, 1), (0, 0), (0, 0))
        self.assertEqual((udp.upload_bytes, udp.download_bytes), (400, 5000))

    def test_busy_sample_reports_bounded_uncertainty(self):
        result = MONITOR.correct_udp_directions(MONITOR.Counters(212, 123, 1), (10, 20), (14, 26))
        self.assertEqual((result.upload_bytes, result.download_bytes), (112, 223))
        self.assertTrue(result.sample_approximate)
        self.assertEqual(result.error_bound_bytes, 5)
        sample = MONITOR.sample_data(result, 10, None)
        self.assertTrue(sample['sample_approximate'])
        self.assertEqual(sample['error_bound_bytes'], 5)

    def test_counter_reset_between_api_reads_rejected(self):
        with self.assertRaises(ValueError):
            MONITOR.correct_udp_directions(MONITOR.Counters(1, 1, 1), (10, 10), (1, 1))

    def test_unverified_versions_never_silently_reverse_udp(self):
        opener = Mock()
        for version in ['', 'gost v3.2.6', 'gost v3.3.1', 'gost v4.0.0', 'gost v3.3.0-rc1']:
            with self.assertRaisesRegex(ValueError, '尚未验证'):
                MONITOR.read_counters(opener, 'http://unused', 'hotspot-proxy', 1, '/unused.sock', version)
        opener.open.assert_not_called()

    def test_private_api_payload_not_exposed_in_error(self):
        connection = Mock()
        response = connection.getresponse.return_value
        response.status = 200
        response.read.return_value = b'{"secret":"must-never-leak","services":[{"name":"hotspot-proxy","status":{"stats":{"inputBytes":true,"outputBytes":3}}}]}'
        with patch.object(MONITOR, 'UnixHTTPConnection', return_value=connection):
            with self.assertRaises(ValueError) as error:
                MONITOR.read_tcp_counters('/private.sock', 'hotspot-proxy')
        self.assertNotIn('must-never-leak', str(error.exception))
        connection.close.assert_called_once()

    def test_all_client_labels_contribute_to_shared_service(self):
        body = '\n'.join([
            'gost_service_transfer_input_bytes_total{service="hotspot-proxy",client="10.0.0.2"} 30',
            'gost_service_transfer_input_bytes_total{service="hotspot-proxy",client="8.8.8.8"} 70',
            'gost_service_transfer_output_bytes_total{service="hotspot-proxy",client="10.0.0.2"} 200',
            'gost_service_transfer_output_bytes_total{service="other",client="10.0.0.2"} 999',
        ])
        counts = MONITOR.parse_metrics(body, 'hotspot-proxy')
        self.assertEqual((counts.upload_bytes, counts.download_bytes), (100, 200))


def exact(conn, size):
    data = b''
    while len(data) < size:
        part = conn.recv(size - len(data))
        if not part:
            raise AssertionError('unexpected SOCKS EOF')
        data += part
    return data


def read_socks_reply(conn):
    head = exact(conn, 4)
    if head[:3] != b'\x05\x00\x00':
        raise AssertionError(f'SOCKS request rejected: {head!r}')
    if head[3] == 1:
        host = socket.inet_ntoa(exact(conn, 4))
    elif head[3] == 4:
        host = socket.inet_ntop(socket.AF_INET6, exact(conn, 16))
    elif head[3] == 3:
        host = exact(conn, exact(conn, 1)[0]).decode()
    else:
        raise AssertionError('bad SOCKS address type')
    return host, struct.unpack('!H', exact(conn, 2))[0]


@unittest.skipUnless(os.environ.get('FLOWBRIDGE_GOST_BIN'), 'optional real GOST loopback checks')
class GostLoopbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.binary = Path(os.environ['FLOWBRIDGE_GOST_BIN']).resolve()
        self.assertTrue(self.binary.is_file())
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.metrics_port = s.getsockname()[1]
        self.config = self.base / 'gost.yaml'
        # Use the production write_config function; narrow only the listen IP to
        # loopback, so no temporary test proxy is exposed to the LAN.
        env = os.environ.copy()
        env.update(HOTSPOT_PROXY_ROOT=str(self.base / 'app'), HOTSPOT_PROXY_PYTHON=sys.executable)
        app = self.base / 'app'
        (app / 'config').mkdir(parents=True)
        (app / 'config/settings.conf').write_text(f'PROXY_PORT={self.port}\nMETRICS_PORT={self.metrics_port}\nWAKE_LOCK=0\n')
        script = (SOURCE / 'proxy.sh').read_text().rsplit('\nmain "$@"', 1)[0]
        self.script_env = env
        self.script_functions = script
        subprocess.run(['bash', '-c', script + '\nload_settings\nwrite_config\n'], env=env, check=True,
                       capture_output=True, text=True, timeout=5)
        self.config.write_text((app / 'config/gost.yaml').read_text().replace('0.0.0.0:', '127.0.0.1:'))
        self.log = (self.base / 'gost.log').open('w+')
        self.addCleanup(self.log.close)
        self.proc = subprocess.Popen([str(self.binary), '-C', str(self.config)],
                                     stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        self.addCleanup(self.stop_process)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            if self.proc.poll() is not None:
                self.fail('GOST failed to start: ' + self.config.read_text())
            try:
                self.metrics()
                break
            except OSError:
                time.sleep(.03)
        else:
            self.fail('GOST did not become ready')

    def stop_process(self):
        if self.proc.poll() is None:
            self.proc.terminate()
        self.proc.wait(timeout=5)

    def metrics(self):
        with self.opener.open(f'http://127.0.0.1:{self.metrics_port}/metrics', timeout=1) as reply:
            return reply.read().decode()

    def socks_control(self, command, target_port=0):
        conn = socket.create_connection(('127.0.0.1', self.port), timeout=3)
        conn.sendall(b'\x05\x01\x00')
        self.assertEqual(exact(conn, 2), b'\x05\x00')
        conn.sendall(bytes((5, command, 0, 1)) + socket.inet_aton('127.0.0.1') + struct.pack('!H', target_port))
        return conn, read_socks_reply(conn)

    @contextmanager
    def tcp_echo(self):
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                while data := self.request.recv(65535):
                    self.request.sendall(data)
        with socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler) as server:
            server.daemon_threads = True
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                yield server.server_address[1]
            finally:
                server.shutdown()
                thread.join(2)

    def test_http_connect_on_shared_port(self):
        with self.tcp_echo() as port, socket.create_connection(('127.0.0.1', self.port), timeout=3) as conn:
            conn.sendall(f'CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n'.encode())
            header = b''
            while not header.endswith(b'\r\n\r\n'):
                header += exact(conn, 1)
            self.assertIn(b' 200 ', header.split(b'\r\n')[0])
            payload = b'http-connect-' * 100
            conn.sendall(payload)
            self.assertEqual(exact(conn, len(payload)), payload)

    def test_socks_tcp_on_same_port(self):
        with self.tcp_echo() as port:
            conn, _ = self.socks_control(1, port)
            with conn:
                payload = b'socks-tcp-' * 100
                conn.sendall(payload)
                self.assertEqual(exact(conn, len(payload)), payload)

    def test_monitor_separates_tcp_and_udp_directions_and_keeps_closed_totals(self):
        api_socket = str(self.base / 'app/state/gost-api.sock')
        version = subprocess.check_output([str(self.binary), '-V'], text=True).strip()
        def sample():
            return MONITOR.read_counters(self.opener, f'http://127.0.0.1:{self.metrics_port}/metrics',
                                         'hotspot-proxy', 2, api_socket, version)
        with self.tcp_echo() as port:
            conn, _ = self.socks_control(1, port)
            with conn:
                conn.sendall(b'tcp-data' * 100)
                self.assertEqual(exact(conn, 800), b'tcp-data' * 100)
        control, relay = self.socks_control(3)
        with control, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as target, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            target.bind(('127.0.0.1', 0))
            target.settimeout(3)
            client.settimeout(3)
            before = sample()
            packet = b'\x00\x00\x00\x01' + socket.inet_aton('127.0.0.1') + struct.pack('!H', target.getsockname()[1]) + b'u' * 400
            client.sendto(packet, relay)
            data, sender = target.recvfrom(65535)
            self.assertEqual(data, b'u' * 400)
            target.sendto(b'd' * 5000, sender)
            reply, _ = client.recvfrom(65535)
            self.assertEqual(reply[10:], b'd' * 5000)
            after = sample()
            self.assertEqual(after.upload_bytes - before.upload_bytes, 400)
            self.assertEqual(after.download_bytes - before.download_bytes, 5000)
            self.assertFalse(after.sample_approximate)
        closed = sample()
        self.assertEqual((closed.upload_bytes, closed.download_bytes), (after.upload_bytes, after.download_bytes))
        result = subprocess.run([sys.executable, str(SOURCE / 'monitor.py'), '--once', '--json',
                                 '--url', f'http://127.0.0.1:{self.metrics_port}/metrics', '--api-socket',
                                 api_socket, '--gost-version', version], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertTrue(value['ok'])
        self.assertEqual(value['upload_bytes'], after.upload_bytes)
        self.assertEqual(value['download_bytes'], after.download_bytes)

    def test_ready_accepts_auto_and_rejects_old_http_only_service(self):
        def readiness():
            return subprocess.run(['bash', '-c', self.script_functions + '\nload_settings\nready\n'],
                                  env=self.script_env, capture_output=True, text=True, timeout=3)
        self.assertEqual(readiness().returncode, 0)
        self.stop_process()
        self.config.write_text(self.config.read_text().replace('type: auto', 'type: http'))
        self.proc = subprocess.Popen([str(self.binary), '-C', str(self.config)],
                                     stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        for _ in range(100):
            try:
                self.metrics()
                break
            except OSError:
                time.sleep(.03)
        self.assertNotEqual(readiness().returncode, 0)

    def test_standard_udp_associate_large_datagram(self):
        # Command 0x03 is RFC1928 UDP ASSOCIATE, never GOST's private 0xf3.
        control, relay = self.socks_control(3)
        with control, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as target, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            target.bind(('127.0.0.1', 0))
            target.settimeout(3)
            client.settimeout(3)
            payload = b'x' * 8192
            packet = b'\x00\x00\x00\x01' + socket.inet_aton('127.0.0.1') + struct.pack('!H', target.getsockname()[1]) + payload
            client.sendto(packet, relay)
            received, sender = target.recvfrom(65535)
            self.assertEqual(received, payload)
            response = b'y' * 12000
            target.sendto(response, sender)
            reply, _ = client.recvfrom(65535)
            self.assertEqual(reply[:4], b'\x00\x00\x00\x01')
            self.assertEqual(reply[10:], response)


if __name__ == '__main__':
    unittest.main()
