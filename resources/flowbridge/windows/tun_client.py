"""Windows TUN controller; shared GUI/metrics contract, separate OS lifetime.

This portable edition runs elevated. It does not install a permanent network
service. A named mutex, Job lifetime, graceful interrupt, and recovery journal
keep ownership explicit. A live core or uncertain cleanup never reports stopped.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from linux.tun_client import TunController as _Metrics, TunStartError, TunStopError, _NoRedirect

from windows import native
from windows.proxy import validate_endpoint
from windows.system_proxy import atomic_json
from windows.tun_config import CORE_VERSION, INTERFACE_NAME, build_config


def core_path():
    if getattr(sys, 'frozen', False):
        directory = Path(sys._MEIPASS) / 'core'
    else:
        arch = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'amd64'
        directory = Path(__file__).resolve().parent.parent / 'vendor' / f'sing-box-{CORE_VERSION}-windows-{arch}'
    binary, driver = directory / 'sing-box.exe', directory / 'wintun.dll'
    try:
        record = json.loads((directory / 'verified.json').read_text(encoding='utf-8'))
        if (record['version'] != CORE_VERSION
                or hashlib.sha256(binary.read_bytes()).hexdigest() != record['binary_sha256']
                or hashlib.sha256(driver.read_bytes()).hexdigest() != record['wintun_sha256']):
            raise ValueError('checksum')
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError('网络内核或 Wintun 缺失/校验失败，请重新解压完整 Windows 包；源码请运行 tools/fetch_windows_core.py。') from None
    return binary


def free_ports():
    # Keep both reservations open until both distinct ports have been selected.
    with socket.socket() as first, socket.socket() as second:
        first.bind(('127.0.0.1', 0))
        second.bind(('127.0.0.1', 0))
        return first.getsockname()[1], second.getsockname()[1]


class TunController(_Metrics):
    """Reuse only the audited counter sampler from the Linux controller.

    No Linux normalizer, helper, pkexec, service, or stop path is used here.
    Dependencies are injected by lifecycle tests; production uses native APIs.
    """
    def __init__(self, endpoint, *, dns_mode='fast', progress=None, start_timeout=25.0, stop_timeout=15.0,
                 poll_interval=1.0, api_timeout=2.0, api_opener=None,
                 platform_api=None, core_provider=None, process_factory=None,
                 config_checker=None, state_dir=None):
        validate_endpoint(endpoint)
        if dns_mode not in ('fast', 'compatible'):
            raise ValueError('解析模式必须为快速解析或兼容解析。')
        for value in (start_timeout, stop_timeout, poll_interval, api_timeout):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError('超时与采样间隔必须为正数。')
        self.endpoint = endpoint
        self.dns_mode = dns_mode
        if progress is not None and not callable(progress):
            raise ValueError('progress must be callable')
        self._progress = progress
        self._startup_stages = []
        self._startup_report = None
        self._shutdown_stages = []
        self._shutdown_report = None
        self._platform = platform_api or native
        self._core_provider = core_provider or core_path
        self._process_factory = process_factory or self._platform.CoreProcess
        self._config_checker = config_checker or self._check_config
        self._opener = api_opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self._start_timeout, self._stop_timeout = start_timeout, stop_timeout
        self._poll_interval, self._api_timeout = poll_interval, api_timeout
        self._lock, self._lifecycle = threading.RLock(), threading.RLock()
        self._process = self._sampler = self._mutex = None
        self._directory = None
        self._journal_owned = False
        self._reset_state()
        self._state_dir = (Path(state_dir) if state_dir else Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'FlowBridge').resolve()
        self._journal = self._state_dir / 'tun-recovery.json'
        # This mapping must outlive a core session: browsers can retain a
        # synthetic address across reconnects or changes to the upstream.
        # It stores local domain/address mappings, not traffic payloads.
        self._dns_cache = self._state_dir / 'dns-cache.db'

    @contextmanager
    def _lifecycle_stage(self, stages, name, label):
        # Observers cannot weaken checks or turn a working session into a failure.
        if self._progress is not None:
            try:
                self._progress(label)
            except Exception:
                pass
        began, ok = time.perf_counter(), False
        try:
            yield
            ok = True
        finally:
            stages.append({'stage': name, 'seconds': round(time.perf_counter()-began, 4), 'ok': ok})

    def _startup_stage(self, name, label):
        return self._lifecycle_stage(self._startup_stages, name, label)

    def _shutdown_stage(self, name, label):
        return self._lifecycle_stage(self._shutdown_stages, name, label)

    def _record_startup(self, began, ok):
        # One small write per attempt; no endpoint, process path, DNS name,
        # secret, or browsing data is recorded. Probe time is reported by GUI.
        try:
            self._startup_report = {
                'schema': 1, 'recorded_utc': datetime.now(timezone.utc).isoformat(),
                'scope': 'controller_start_only_excludes_proxy_probe_and_failure_cleanup',
                'ok': ok, 'total_seconds': round(time.perf_counter()-began, 4),
                'stages': list(self._startup_stages),
            }
            if self._state_dir.is_dir():
                atomic_json(self._state_dir / 'last-startup.json', self._startup_report)
        except Exception:
            # Diagnostic failures must never prevent the mandatory stop path.
            pass

    def _record_shutdown(self, began, ok):
        try:
            self._shutdown_report = {
                'schema': 1, 'recorded_utc': datetime.now(timezone.utc).isoformat(),
                'scope': 'controller_stop_only_excludes_gui_shutdown',
                'ok': ok, 'total_seconds': round(time.perf_counter()-began, 4),
                'stages': list(self._shutdown_stages),
            }
            if self._state_dir.is_dir():
                atomic_json(self._state_dir / 'last-shutdown.json', self._shutdown_report)
        except Exception:
            pass

    def _tun_state(self, timeout):
        # Only the initial preflight needs forwarding and local address data.
        reader = getattr(self._platform, 'tun_state', None)
        if reader is not None:
            return reader(timeout=max(.01, timeout))
        return self._platform.network_state()

    def set_dns_mode(self, dns_mode):
        with self._lifecycle:
            if self.needs_cleanup or self.is_running:
                raise TunStartError('请先断开当前全局连接，再切换解析模式。', controller=self)
            if dns_mode not in ('fast', 'compatible'):
                raise ValueError('解析模式必须为快速解析或兼容解析。')
            self.dns_mode = dns_mode

    def set_endpoint(self, endpoint):
        with self._lifecycle:
            if self.needs_cleanup or self.is_running:
                raise TunStartError('请先断开当前全局连接。', controller=self)
            validate_endpoint(endpoint)
            self.endpoint = endpoint

    @property
    def needs_cleanup(self):
        with self._lock:
            return not self._cleanup_confirmed

    def snapshot(self):
        with self._lock:
            if self._process is not None and self._ready and self._process.poll() is not None and not self._cleanup_confirmed:
                self._ready = False
                self._state = 'error'
                self._helper_error = '网络内核已退出，请点击断开以恢复并确认网络设置。'
            result = dict(self._stats)
            result.update(running=self._ready and self._state == 'running', state=self._state,
                          last_error=self._helper_error or self._api_error,
                          cleanup_confirmed=self._cleanup_confirmed, needs_cleanup=not self._cleanup_confirmed)
            return result

    @staticmethod
    def _check_config(binary, config):
        result = subprocess.run([str(binary), 'check', '-c', str(config)], cwd=binary.parent,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise ValueError('Windows 网络配置未通过内核检查，未启用全局接管。')

    def _recover_previous(self):
        if not self._journal.exists():
            return
        if self._journal.stat().st_size > 128 * 1024:
            raise ValueError('网络恢复记录过大，未启动接管。')
        record = json.loads(self._journal.read_text(encoding='utf-8'))
        if not isinstance(record, dict) or set(record) != {'version', 'weak_host'} or record['version'] != 1:
            raise ValueError('网络恢复记录无效，未启动接管。')
        self._platform.restore_weak_host(record['weak_host'])
        self._journal.unlink()

    def _release_files(self):
        if self._directory is not None:
            shutil.rmtree(self._directory)
            self._directory = None

    def _release_mutex(self):
        if self._mutex is not None:
            self._mutex.close()
            self._mutex = None

    def start(self):
        with self._lifecycle:
            if self.is_running:
                return self
            if self.needs_cleanup:
                raise TunStartError('上次全局网络清理尚未确认，请先重试断开。', controller=self)
            self._reset_state()
            self._process = None
            self._startup_stages = []
            began = time.perf_counter()
            try:
                with self._startup_stage('verify_core', '正在校验网络内核…'):
                    if not self._platform.is_admin():
                        raise ValueError('全局接管需要管理员权限，请退出后右键以管理员身份运行 ModelDock。')
                    validate_endpoint(self.endpoint)
                    binary = self._core_provider()
                self._mutex = self._platform.SessionMutex()
                with self._startup_stage('network_preflight', '正在检查网卡和路由…'):
                    state = self._platform.network_state()
                    # IP Helper may retain our inactive adapter after reboot.
                    # Only a recognized, down, route-free sing-tun identity can
                    # be reused; the session mutex still excludes live peers.
                    # The core acquires its Wintun session before configuration.
                    if (state['up'] or state['routes']
                            or (state['exists'] and state.get('reusable_inactive') is not True)):
                        raise ValueError('检测到仍在使用、归属不明的 modeldock-net 网卡或残留路由，请先关闭其他接管程序；未覆盖现有网络。')
                    if state.get('forwarding'):
                        raise ValueError('默认上游网卡启用了 IP 转发，可能导致代理循环；请关闭网络共享/路由功能后重试。')
                    host, _ = validate_endpoint(self.endpoint)
                    if not ipaddress.ip_address(host).is_loopback and host in state.get('local_addresses', []):
                        raise ValueError('填写的是本机网卡 IP；本机 VPN 代理请改用 127.0.0.1 或 [::1]，以准确识别并排除上游程序。')
                self._state_dir.mkdir(parents=True, exist_ok=True)
                if self._journal.exists():
                    self._journal_owned = True
                    self._cleanup_confirmed = False
                with self._startup_stage('recover_previous', '正在确认上次网络状态已恢复…'):
                    self._recover_previous()
                self._journal_owned = False
                self._cleanup_confirmed = True
                with self._startup_stage('identify_upstream', '正在识别上游代理程序，防止流量循环…'):
                    bypass = self._platform.local_proxy_process(self.endpoint)
                self._api_port, self._proxy_port = free_ports()
                self._secret = secrets.token_urlsafe(32)
                self._interface = INTERFACE_NAME
                config = build_config(self.endpoint, self._api_port, self._secret,
                                      proxy_port=self._proxy_port, bypass_process_path=bypass,
                                      dns_mode=self.dns_mode, cache_path=str(self._dns_cache))
                self._directory = Path(tempfile.mkdtemp(prefix='tun-', dir=self._state_dir))
                config_path = self._directory / 'config.json'
                config_path.write_text(json.dumps(config), encoding='utf-8')
                with self._startup_stage('check_config', '正在验证全局代理配置…'):
                    self._config_checker(binary, config_path)
                with self._startup_stage('capture_recovery', '正在保存网络恢复信息…'):
                    weak_host = self._platform.capture_weak_host()
                # Exclusive write: never overwrite an unhandled recovery record.
                with self._journal.open('x', encoding='utf-8') as stream:
                    json.dump({'version': 1, 'weak_host': weak_host}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                self._journal_owned = True
                with self._lock:
                    self._cleanup_confirmed = False
                    self._state = 'starting'
                with self._startup_stage('launch_core', '正在启动全局代理内核…'):
                    self._process = self._process_factory([str(binary), 'run', '-c', str(config_path)], str(binary.parent))
                with self._startup_stage('wait_ready', '正在确认虚拟网卡、路由和统计接口已就绪…'):
                    self._wait_until_ready()
                self._record_startup(began, True)
                return self
            except Exception as error:
                self._record_startup(began, False)
                message = self._safe_message(str(error))
                try:
                    self.stop()
                except Exception:
                    message += ' 网络清理尚未确认，请重试断开。'
                with self._lock:
                    self._helper_error = message
                    self._state = 'error'
                raise TunStartError(message, cleanup_confirmed=self.cleanup_confirmed, controller=self) from None

    def _wait_until_ready(self):
        deadline = time.monotonic() + self._start_timeout
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                raise ValueError('网络内核启动失败，请检查管理员权限、Wintun 和其他 VPN 的网卡冲突。')
            try:
                self._sample_once()
            except Exception:
                time.sleep(.1)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            state = self._tun_state(remaining)
            if time.monotonic() < deadline and state['up'] and state['routes'] > 0:
                with self._lock:
                    self._ready = True
                    self._state = 'running'
                self._sampler = threading.Thread(target=self._sample_loop, args=(self._sampling_stop,),
                                                 name='modeldock-net-stats', daemon=True)
                self._sampler.start()
                return
            time.sleep(.1)
        raise ValueError('网络内核启动超时，未确认虚拟网卡和统计接口已就绪。')

    def stop(self):
        with self._lifecycle:
            # The GUI closes its controller again after a successful disconnect.
            # Keep that operation inert and preserve the actual stop timing.
            if (self._cleanup_confirmed and not self._journal_owned
                    and self._directory is None and self._mutex is None
                    and (self._process is None or self._process.poll() is not None)):
                return
            self._shutdown_stages = []
            began = time.perf_counter()
            self._sampling_stop.set()
            with self._lock:
                self._ready = False
                self._state = 'stopping'
            try:
                process = self._process
                if process is not None and process.poll() is None:
                    with self._shutdown_stage('signal_core', '正在通知代理内核退出…'):
                        process.request_stop()
                    with self._shutdown_stage('wait_core', '正在等待代理内核释放虚拟网卡…'):
                        process.wait(timeout=self._stop_timeout)
                if process is not None:
                    process.close_job()
                if self._journal_owned:
                    # Dynamic WFP filters end with the core; also verify route
                    # removal before restoring the core's WeakHostSend changes.
                    with self._shutdown_stage('confirm_routes', '正在确认虚拟网卡和接管路由已释放…'):
                        deadline = time.monotonic() + self._stop_timeout
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise OSError('虚拟网卡或接管路由尚未清理。')
                            state = self._tun_state(remaining)
                            if time.monotonic() < deadline and not state['up'] and state['routes'] == 0:
                                break
                            if time.monotonic() >= deadline:
                                raise OSError('虚拟网卡或接管路由尚未清理。')
                            time.sleep(.2)
                    with self._shutdown_stage('restore_network', '正在恢复连接前的网络状态…'):
                        self._recover_previous()
                    self._journal_owned = False
                with self._shutdown_stage('release_session', '正在完成会话清理…'):
                    self._release_files()
                    self._release_mutex()
                with self._lock:
                    self._cleanup_confirmed = True
                    self._state = 'stopped'
                    self._stats['active_connections'] = 0
                    self._secret = ''
                    self._exited.set()
                self._record_shutdown(began, True)
            except Exception:
                self._record_shutdown(began, False)
                with self._lock:
                    self._cleanup_confirmed = False
                    self._state = 'error'
                    self._helper_error = '尚未确认网络清理完成；请重试断开，不要直接结束程序。'
                raise TunStopError(self._helper_error, controller=self) from None

    def close(self):
        self.stop()


WinTunClient = TunController
