"""Non-privileged controller for the installed FlowBridge 全局接管helper.

Call start/stop from GUI worker threads. Only a fixed, root-managed helper is
ever passed to pkexec. The pipe is also the helper's lifetime lease: closing it
requests cleanup. There is deliberately no terminate/kill fallback, because
killing a privileged helper could interrupt route cleanup.

Statistics come from the loopback Clash-compatible /connections API. They are
proxy-core counters, not NIC/ISP byte totals. total_connections counts distinct
connections observed by polling; connections shorter than an interval can be
missed. API credentials stay in memory and are never included in public info,
logs, or exception text.
"""

from __future__ import annotations

import ipaddress
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field


PKEXEC = "/usr/bin/pkexec"
HELPER = "/usr/libexec/modeldock-network-tun-helper"
SETUP_HELPER = "/usr/libexec/modeldock-network-setup"
MAX_PROTOCOL_LINE = 64 * 1024
MAX_API_BODY = 4 * 1024 * 1024


class TunError(RuntimeError):
    def __init__(self, message: str, *, cleanup_confirmed: bool = False, controller=None):
        super().__init__(message)
        self.cleanup_confirmed = cleanup_confirmed
        self.controller = controller if not cleanup_confirmed else None
        self.needs_cleanup = self.controller is not None


class TunStartError(TunError):
    pass


class TunStopError(TunError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


@dataclass
class _RecoveryAttempt:
    process: object
    done: threading.Event = field(default_factory=threading.Event)
    input_lock: threading.Lock = field(default_factory=threading.Lock)
    acknowledged: bool = False
    error: str = ""
    returncode: int | None = None
    reader: threading.Thread | None = None


def _check_installed_helper() -> None:
    for name in (PKEXEC, HELPER):
        try:
            details = Path(name).lstat()
            trusted = (
                stat.S_ISREG(details.st_mode)
                and details.st_uid == 0
                and not details.st_mode & 0o022
                and bool(details.st_mode & 0o111)
            )
        except OSError:
            trusted = False
        if not trusted:
            raise TunStartError(
                "全局接管需要安装当前版本 ModelDock 网络权限包 及其管理员辅助程序；源码模式不会提权运行用户目录中的脚本。",
                cleanup_confirmed=True,
            )


def _empty_stats():
    return {"upload_bytes": 0, "download_bytes": 0, "active_connections": 0, "total_connections": 0, "errors": 0}


def _normalize_endpoint(endpoint):
    try:
        address = ipaddress.ip_address(endpoint.host)
        port = endpoint.port
        if address.is_unspecified or address.is_loopback or address.is_multicast or str(address) == "255.255.255.255" or getattr(address, "scope_id", None):
            raise ValueError
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("全局接管模式请填写手机的数值 IPv4/IPv6 地址和有效端口，不支持域名或本机回环地址。") from error
    return str(address), port


class TunController:
    def __init__(
        self, endpoint, *, popen_factory=None, api_opener=None,
        start_timeout: float = 90.0, stop_timeout: float = 20.0,
        poll_interval: float = 1.0, api_timeout: float = 3.0,
    ):
        host, port = _normalize_endpoint(endpoint)
        for value in (start_timeout, stop_timeout, poll_interval, api_timeout):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("超时与采样间隔必须为正数。")
        self.endpoint = endpoint
        self._host, self._port = host, port
        self._popen = popen_factory or subprocess.Popen
        self._opener = api_opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self._start_timeout, self._stop_timeout = start_timeout, stop_timeout
        self._poll_interval, self._api_timeout = poll_interval, api_timeout
        self._lock = threading.RLock()
        self._start_lock, self._stop_lock, self._stdin_lock = threading.Lock(), threading.Lock(), threading.Lock()
        self._process = None
        self._reader = self._sampler = None
        self._reset_state()

    def _reset_state(self):
        self._changed = threading.Event()
        self._exited = threading.Event()
        self._stop_requested = threading.Event()
        self._sampling_stop = threading.Event()
        self._cleanup_ack = False
        self._helper_event_seen = False
        self._cleanup_confirmed = True
        self._ready = False
        self._state = "idle"
        self._secret = ""
        self._api_port = None
        self._proxy_port = None
        self._interface = ""
        self._returncode = None
        self._helper_error = self._api_error = ""
        self._stats = _empty_stats()
        self._raw_totals = None
        self._observed_live_ids = set()
        self._recovery = None

    @property
    def info(self) -> dict:
        with self._lock:
            return {"interface": self._interface, "api_port": self._api_port, "proxy_port": self._proxy_port}

    @property
    def cleanup_confirmed(self) -> bool:
        with self._lock:
            return self._cleanup_confirmed

    @property
    def is_running(self) -> bool:
        return self.snapshot()["running"]

    @property
    def needs_cleanup(self) -> bool:
        with self._lock:
            return self._process is not None and not self._cleanup_confirmed

    def _safe_message(self, value) -> str:
        if not isinstance(value, str):
            return "管理员辅助程序报告了错误。"
        text = value
        with self._lock:
            if self._secret:
                text = text.replace(self._secret, "[已隐藏]")
        text = re.sub(r"(?i)Bearer\s+[^\s,;]+", "Bearer [已隐藏]", text)
        return " ".join(text.split())[:500] or "管理员辅助程序报告了错误。"

    def snapshot(self) -> dict:
        with self._lock:
            result = dict(self._stats)
            result.update(
                running=self._ready and self._state == "running" and not self._exited.is_set(),
                state=self._state,
                last_error=self._helper_error or self._api_error,
                cleanup_confirmed=self._cleanup_confirmed,
                needs_cleanup=self._process is not None and not self._cleanup_confirmed,
            )
            return result

    def start(self):
        with self._start_lock:
            with self._lock:
                if self._process is not None:
                    if self._ready and self._state == "running" and not self._exited.is_set():
                        return self
                    if not self._cleanup_confirmed:
                        raise TunStartError("上次 全局接管的网络清理尚未确认，请先重试断开。", controller=self)
                    if not self._exited.is_set():
                        raise TunStartError("管理员辅助程序仍在退出，请稍后重试。", controller=self)
                self._reset_state()
            _check_installed_helper()
            try:
                with self._stdin_lock:
                    process = self._popen(
                        [PKEXEC, "--disable-internal-agent", HELPER],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        text=True, encoding="utf-8", errors="replace", bufsize=1,
                        close_fds=True, cwd="/",
                    )
                    with self._lock:
                        self._process = process
                        self._cleanup_confirmed = False
                        self._state = "starting"
                    self._reader = threading.Thread(target=self._read_protocol, args=(process,), name="flowbridge-tun-helper", daemon=True)
                    self._reader.start()
                    if process.stdin is None:
                        raise OSError("missing helper stdin")
                    process.stdin.write(json.dumps({"version": 2, "host": self._host, "port": self._port}) + "\n")
                    process.stdin.flush()
            except (OSError, ValueError) as error:
                if self._process is None:
                    with self._lock:
                        self._cleanup_confirmed = True
                        self._state = "error"
                    raise TunStartError("无法启动管理员认证，请确认已安装 polkit 和当前版本 ModelDock 网络权限包。", cleanup_confirmed=True) from None
                self._abort_start("无法向管理员辅助程序发送启动请求。")
            deadline = time.monotonic() + self._start_timeout
            while True:
                with self._lock:
                    if self._helper_error:
                        failure = self._helper_error
                    elif self._ready and not self._stop_requested.is_set() and not self._exited.is_set():
                        self._sampler = threading.Thread(target=self._sample_loop, args=(self._sampling_stop,), name="flowbridge-tun-stats", daemon=True)
                        self._sampler.start()
                        return self
                    elif self._stop_requested.is_set():
                        failure = "全局接管启动已取消。"
                    elif self._exited.is_set():
                        failure = self._exit_description(self._returncode)
                    else:
                        failure = ""
                if failure:
                    self._abort_start(failure)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._abort_start("管理员认证或 全局接管启动超时。")
                self._changed.wait(min(.1, remaining))
                self._changed.clear()

    @staticmethod
    def _exit_description(code):
        if code == 126:
            return "已取消管理员认证，全局接管未完成启动。"
        if code == 127:
            return "管理员认证未获授权或辅助程序未能执行。"
        return "管理员辅助程序在 全局接管启动完成前退出。"

    def _abort_start(self, message):
        try:
            # A failed initial connection must not silently open a second
            # authentication dialog. Explicitly retrying Disconnect may recover.
            self._stop(allow_recover=False)
        except TunStopError:
            pass
        with self._lock:
            confirmed = self._cleanup_confirmed
            if self._returncode in (126, 127) and not self._helper_event_seen:
                message = self._exit_description(self._returncode)
            safe = self._safe_message(message)
            if not confirmed and "清理" not in safe:
                safe += " 已请求停止，但网络清理尚未确认。"
            self._helper_error = safe
        raise TunStartError(safe, cleanup_confirmed=confirmed, controller=self) from None

    def _read_protocol(self, process):
        try:
            if process.stdout is None:
                self._protocol_error("管理员辅助程序没有提供状态通道。")
            else:
                while True:
                    line = process.stdout.readline(MAX_PROTOCOL_LINE + 1)
                    if not line:
                        break
                    if len(line) > MAX_PROTOCOL_LINE or not line.endswith("\n"):
                        self._protocol_error("管理员辅助程序返回的状态数据无效。")
                        continue
                    try:
                        message = json.loads(line)
                    except (ValueError, TypeError):
                        self._protocol_error("管理员辅助程序返回的状态数据无效。")
                        continue
                    if not isinstance(message, dict):
                        self._protocol_error("管理员辅助程序返回的状态数据无效。")
                        continue
                    event = message.get("event")
                    if isinstance(event, str):
                        with self._lock:
                            self._helper_event_seen = True
                    if event == "ready":
                        self._accept_ready(message)
                    elif event == "error":
                        self._protocol_error(self._safe_message(message.get("message")))
                    elif event in ("stopped", "cleaned"):
                        with self._lock:
                            self._cleanup_ack = True
                            self._state = "stopping"
                        self._sampling_stop.set()
                        self._changed.set()
                    else:
                        self._protocol_error("管理员辅助程序返回了未知状态。")
        except (OSError, ValueError):
            self._protocol_error("与管理员辅助程序的状态通道已中断。")
        finally:
            # Losing stdout is not proof of cleanup; EOF on stdin asks the
            # helper to finish cleanup even if its status channel broke.
            self._send_stop_and_close()
            self._sampling_stop.set()
            try:
                code = process.wait()
            except (OSError, ValueError):
                code = process.poll()
            if process.stdout is not None and hasattr(process.stdout, "close"):
                try:
                    process.stdout.close()
                except (OSError, ValueError):
                    pass
            with self._lock:
                self._returncode = code
                auth_not_started = code in (126, 127) and not self._helper_event_seen
                self._cleanup_confirmed = (self._cleanup_ack and code == 0) or auth_not_started
                self._state = "stopped" if self._cleanup_confirmed else "error"
                self._stats["active_connections"] = 0
                if auth_not_started:
                    self._helper_error = self._exit_description(code)
                if not self._cleanup_confirmed and not self._helper_error:
                    description = "全局接管管理员辅助程序意外退出。" if self._ready else self._exit_description(code)
                    self._helper_error = description + " 网络清理尚未确认。"
                self._secret = ""
                self._exited.set()
            self._changed.set()

    def _accept_ready(self, message):
        port, proxy_port, secret, interface = message.get("api_port"), message.get("proxy_port"), message.get("api_secret"), message.get("interface")
        valid = (
            isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535
            and isinstance(proxy_port, int) and not isinstance(proxy_port, bool) and 1 <= proxy_port <= 65535 and proxy_port != port
            and isinstance(secret, str) and 16 <= len(secret) <= 4096
            and all(33 <= ord(character) <= 126 for character in secret)
            and isinstance(interface, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", interface)
        )
        with self._lock:
            duplicate = self._ready
            if valid and not duplicate:
                self._api_port, self._proxy_port, self._secret, self._interface = port, proxy_port, secret, interface
                self._ready = True
                self._state = "stopping" if self._stop_requested.is_set() else "running"
        if not valid or duplicate:
            self._protocol_error("管理员辅助程序返回的就绪状态无效。")
        self._changed.set()

    def _protocol_error(self, message):
        with self._lock:
            self._helper_error = self._safe_message(message)
            self._stats["errors"] += 1
            self._state = "error"
        self._changed.set()
        self._send_stop_and_close()

    def _send_stop_and_close(self):
        self._stop_requested.set()
        with self._stdin_lock:
            process = self._process
            stream = process.stdin if process is not None else None
            if stream is not None and not stream.closed:
                try:
                    stream.write('{"command":"stop"}\n')
                    stream.flush()
                except (OSError, ValueError):
                    pass
                finally:
                    try:
                        stream.close()
                    except (OSError, ValueError):
                        pass
        self._changed.set()

    def stop(self) -> None:
        self._stop(allow_recover=True)

    def _stop(self, *, allow_recover) -> None:
        with self._stop_lock:
            with self._lock:
                if self._process is None:
                    return
                if self._cleanup_confirmed and self._exited.is_set():
                    return
                needs_recovery = self._exited.is_set() and not self._cleanup_confirmed
                self._state = "stopping"
            if needs_recovery and allow_recover:
                self._recover_cleanup()
                return
            self._sampling_stop.set()
            self._send_stop_and_close()
            if not self._exited.wait(self._stop_timeout):
                with self._lock:
                    if self._cleanup_confirmed and self._exited.is_set():
                        return
                    self._state = "error"
                    self._helper_error = "已请求断开 全局接管，但尚未收到网络清理完成的确认；可重试断开。"
                raise TunStopError(self._helper_error, controller=self)
            with self._lock:
                if not self._cleanup_confirmed:
                    self._state = "error"
                    self._helper_error = self._helper_error or "辅助程序已退出，但网络清理尚未确认。"
                    raise TunStopError(self._helper_error, controller=self)
            sampler = self._sampler
            if sampler is not None and sampler is not threading.current_thread():
                sampler.join(self._api_timeout + .2)

    @staticmethod
    def _close_recovery_input(attempt):
        with attempt.input_lock:
            stream = attempt.process.stdin
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass

    def _finish_recovery(self, attempt, code):
        attempt.returncode = code
        success = attempt.acknowledged and not attempt.error and code == 0
        with self._lock:
            if self._recovery is attempt:
                self._cleanup_confirmed = success
                self._state = "stopped" if success else "error"
                self._stats["active_connections"] = 0
                if success:
                    self._helper_error = self._api_error = ""
                else:
                    if attempt.error:
                        message = attempt.error
                    elif code == 126:
                        message = "已取消网络恢复所需的管理员认证。"
                    elif code == 127:
                        message = "网络恢复未获管理员授权或辅助程序未能执行。"
                    else:
                        message = "网络恢复助手没有确认清理完成。"
                    self._helper_error = self._safe_message(message) + " 原 全局接管网络清理尚未确认，可重试断开。"
        attempt.done.set()
        self._changed.set()

    def _read_recovery(self, attempt):
        process = attempt.process
        try:
            if process.stdout is None:
                attempt.error = "网络恢复助手没有提供状态通道。"
            else:
                while True:
                    line = process.stdout.readline(MAX_PROTOCOL_LINE + 1)
                    if not line:
                        break
                    try:
                        if len(line) > MAX_PROTOCOL_LINE or not line.endswith("\n"):
                            raise ValueError
                        message = json.loads(line)
                        if not isinstance(message, dict):
                            raise ValueError
                        event = message.get("event")
                    except (ValueError, TypeError):
                        attempt.error = "网络恢复助手返回了无效状态。"
                        self._close_recovery_input(attempt)
                        continue
                    if event in ("stopped", "cleaned"):
                        attempt.acknowledged = True
                    elif event == "error":
                        attempt.error = self._safe_message(message.get("message"))
                        self._close_recovery_input(attempt)
                    else:
                        # In particular, a recover-only helper must never
                        # announce ready or return a fresh API credential.
                        attempt.error = "网络恢复助手返回了意外状态，未确认清理完成。"
                        self._close_recovery_input(attempt)
        except (OSError, ValueError):
            attempt.error = "网络恢复助手的状态通道已中断。"
        finally:
            self._close_recovery_input(attempt)
            try:
                code = process.wait()
            except (OSError, ValueError):
                code = process.poll()
            if process.stdout is not None and hasattr(process.stdout, "close"):
                try:
                    process.stdout.close()
                except (OSError, ValueError):
                    pass
            self._finish_recovery(attempt, code)

    def _recover_cleanup(self):
        """Retry only the old root journal's cleanup, never start a new 全局接管."""
        with self._lock:
            attempt = self._recovery
        if attempt is None or attempt.done.is_set():
            try:
                _check_installed_helper()
                process = self._popen(
                    [PKEXEC, "--disable-internal-agent", HELPER],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, encoding="utf-8", errors="replace", bufsize=1,
                    close_fds=True, cwd="/",
                )
            except Exception:
                with self._lock:
                    self._state = "error"
                    self._helper_error = "无法启动网络恢复，请确认当前版本 ModelDock 网络权限包 和管理员认证可用。原 全局接管网络清理尚未确认。"
                raise TunStopError(self._helper_error, controller=self) from None
            attempt = _RecoveryAttempt(process)
            with self._lock:
                self._recovery = attempt
                self._state = "recovering"
            attempt.reader = threading.Thread(target=self._read_recovery, args=(attempt,), name="flowbridge-tun-recovery", daemon=True)
            # A new Popen always owns fresh pipes. Reject broken test/custom
            # factories without hanging on an already-consumed stdout pipe.
            if process.stdin is None or process.stdin.closed:
                attempt.error = "网络恢复助手的输入通道不可用。"
                self._finish_recovery(attempt, process.poll())
            else:
                attempt.reader.start()
                try:
                    with attempt.input_lock:
                        process.stdin.write('{"version":1,"command":"recover"}\n')
                        process.stdin.flush()
                except (OSError, ValueError):
                    attempt.error = "无法向管理员辅助程序发送网络恢复请求。"
                    self._close_recovery_input(attempt)
        if not attempt.done.wait(self._start_timeout):
            self._close_recovery_input(attempt)
            if not attempt.done.wait(self._stop_timeout):
                with self._lock:
                    if self._cleanup_confirmed:
                        return
                    self._state = "error"
                    self._helper_error = "网络恢复认证或清理超时，原 全局接管网络清理尚未确认；可重试断开。"
                raise TunStopError(self._helper_error, controller=self)
        with self._lock:
            if not self._cleanup_confirmed:
                raise TunStopError(self._helper_error or "原 全局接管网络清理尚未确认。", controller=self)

    @staticmethod
    def _counter(value):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("invalid counter")
        return value

    def _sample_loop(self, stopping):
        while not stopping.is_set():
            try:
                self._sample_once(stopping)
            except Exception as error:
                # Never expose urllib exceptions: a custom opener or server
                # could put credentials/body content in its exception text.
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                with self._lock:
                    if not stopping.is_set() and stopping is self._sampling_stop:
                        self._stats["errors"] += 1
                        self._api_error = "暂时无法读取 全局接管流量统计。"
            if stopping.wait(self._poll_interval):
                break

    def _sample_once(self, stopping=None):
        stopping = self._sampling_stop if stopping is None else stopping
        with self._lock:
            port, secret = self._api_port, self._secret
        if not port or not secret:
            raise ValueError("statistics are not ready")
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/connections",
            headers={"Authorization": "Bearer " + secret, "Accept": "application/json"},
        )
        with self._opener.open(request, timeout=self._api_timeout) as response:
            body = response.read(MAX_API_BODY + 1)
        if len(body) > MAX_API_BODY:
            raise ValueError("statistics response is too large")
        data = json.loads(body)
        upload, download = self._counter(data["uploadTotal"]), self._counter(data["downloadTotal"])
        connections = data.get("connections")
        if connections is None:
            connections = []
        if not isinstance(connections, list):
            raise ValueError("invalid connections list")
        current_ids = {value["id"] for value in connections if isinstance(value, dict) and isinstance(value.get("id"), str)}
        with self._lock:
            if stopping.is_set() or stopping is not self._sampling_stop:
                return
            old = self._raw_totals
            self._stats["upload_bytes"] += upload if old is None or upload < old[0] else upload - old[0]
            self._stats["download_bytes"] += download if old is None or download < old[1] else download - old[1]
            self._raw_totals = (upload, download)
            self._stats["active_connections"] = len(connections)
            self._stats["total_connections"] += len(current_ids - self._observed_live_ids)
            self._observed_live_ids = current_ids
            self._api_error = ""


class ReusableTunController(TunController):
    """Persistently authorized per-user access, with many private TUN sessions.

    The one-time setup enables a restricted system socket. Each GUI connects
    to that verified root service; only the installed helper receives the v3
    start/stop protocol. Stop removes network state, close/EOF ends this GUI's
    helper, and the system socket remains enabled across program restarts.
    No password or reusable token is stored. The original one-shot v2
    controller remains available for compatibility and isolated tests.
    """

    def __init__(self, endpoint, *, service_connector=None, setup_runner=None, **kwargs):
        super().__init__(endpoint, **kwargs)
        self._request_id = 0
        self._idle = threading.Event()
        self._service_connector = service_connector
        self._setup_runner = setup_runner
        self._setup_process = None
        # Explicit Popen injection remains available for isolated protocol
        # tests. Production always uses the per-user, root-managed service.
        if kwargs.get('popen_factory') is None:
            self._popen = lambda *args, **options: self._open_service()

    def _run_initial_setup(self):
        import tun_access
        try:
            with self._lock:
                pending = self._setup_process
                if pending is not None:
                    code = pending.poll()
                    if code is None:
                        raise TunStartError('首次授权认证仍在等待，请完成或取消现有认证窗口后重试。', cleanup_confirmed=True)
                    self._setup_process = None
                    if code == 0:
                        return
                tun_access.require_root_path(Path(SETUP_HELPER))
                if not Path(SETUP_HELPER).stat().st_mode & 0o111:raise OSError()
                process = subprocess.Popen([PKEXEC, '--disable-internal-agent', SETUP_HELPER],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding='utf-8', errors='replace', close_fds=True, cwd='/')
                self._setup_process = process
        except (OSError, tun_access.AccessError):
            raise TunStartError('首次使用全局模式需要安装完整的ModelDock 网络权限服务。', cleanup_confirmed=True) from None
        try:
            process.communicate(timeout=self._start_timeout)
        except subprocess.TimeoutExpired:
            # Setup only enables the fixed socket; it never creates routes.
            # Do not kill a privileged installer while systemd is updating it.
            def collect():
                try:process.communicate()
                except (OSError, ValueError):pass
            threading.Thread(target=collect, name='flowbridge-setup-result', daemon=True).start()
            raise TunStartError('首次授权设置尚未完成，请完成或取消系统认证后重试。', cleanup_confirmed=True) from None
        with self._lock:
            if self._setup_process is process:self._setup_process = None
        if process.returncode == 126:
            raise TunStartError('已取消首次授权设置，全局模式未开启。', cleanup_confirmed=True)
        if process.returncode:
            raise TunStartError('首次授权设置未完成，请确认 systemd 权限服务已随新版完整安装。', cleanup_confirmed=True)

    def _open_service(self):
        import tun_access
        connector = self._service_connector or tun_access.connect_service
        try:
            return connector()
        except tun_access.AccessUnavailable:
            try:already_configured = tun_access.configured(os.getuid())
            except (OSError, tun_access.AccessError):
                raise TunStartError('已保存的流桥权限服务授权记录异常，未重新请求密码。', cleanup_confirmed=True) from None
            if already_configured:
                raise TunStartError('流桥权限服务暂不可用；首次授权已保存，无需再次输入密码，请检查系统服务或重启电脑。', cleanup_confirmed=True) from None
            (self._setup_runner or self._run_initial_setup)()
            deadline=time.monotonic()+5
            while True:
                try:return connector()
                except tun_access.AccessUnavailable:
                    if time.monotonic()>=deadline:
                        raise TunStartError('首次授权已完成，但权限服务尚未就绪，请稍后重试。', cleanup_confirmed=True) from None
                    time.sleep(.05)
                except (OSError,tun_access.AccessError):
                    raise TunStartError('无法验证流桥权限服务身份，未发送代理请求。', cleanup_confirmed=True) from None
        except (OSError,tun_access.AccessError):
            raise TunStartError('无法验证流桥权限服务身份，未发送代理请求。', cleanup_confirmed=True) from None

    def set_endpoint(self, endpoint):
        host, port = _normalize_endpoint(endpoint)
        with self._lock:
            if not self._cleanup_confirmed:
                raise TunStartError("当前全局会话尚未完成清理，不能更改手机地址。", controller=self)
            self.endpoint = endpoint
            self._host, self._port = host, port

    @property
    def authorization_open(self):
        with self._lock:
            return self._process is not None and not self._exited.is_set()

    def _begin_session(self):
        self._request_id += 1
        self._idle.clear()
        self._stop_requested = threading.Event()
        self._sampling_stop = threading.Event()
        self._cleanup_ack = self._cleanup_confirmed = self._ready = False
        self._state = "starting"
        self._secret = ""
        self._api_port = self._proxy_port = None
        self._interface = ""
        self._helper_error = self._api_error = ""
        self._stats = _empty_stats()
        self._raw_totals = None
        self._observed_live_ids = set()

    def start(self):
        with self._start_lock:
            with self._lock:
                if self._ready and self._state == "running" and not self._exited.is_set():
                    return self
                if self._process is not None and not self._cleanup_confirmed:
                    raise TunStartError("上次全局接管的网络清理尚未确认，请先重试断开。", controller=self)
                fresh = self._process is None or self._exited.is_set()
                if not fresh and self._state != "idle":
                    raise TunStartError("管理员辅助程序仍在退出，请稍后重试。", cleanup_confirmed=True)
                if fresh:
                    self._reset_state()
                    self._request_id = 0
                    self._process = None
                self._begin_session()
            if fresh:
                try:
                    _check_installed_helper()
                except Exception:
                    with self._lock:
                        self._cleanup_confirmed = True
                    raise
            try:
                with self._stdin_lock:
                    if fresh:
                        process = self._popen(
                            [PKEXEC, "--disable-internal-agent", HELPER],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, encoding="utf-8", errors="replace", bufsize=1,
                            close_fds=True, cwd="/",
                        )
                        with self._lock:
                            self._process = process
                        self._reader = threading.Thread(target=self._read_protocol, args=(process,), name="flowbridge-tun-lease", daemon=True)
                        self._reader.start()
                    process = self._process
                    if process.stdin is None or process.stdin.closed:
                        raise OSError("missing helper stdin")
                    process.stdin.write(json.dumps({"version": 3, "command": "start", "id": self._request_id,
                                                    "host": self._host, "port": self._port}) + "\n")
                    process.stdin.flush()
            except TunStartError:
                if self._process is None:
                    # Setup/handshake failed before a start request could be
                    # sent. Retrying this cached GUI controller is safe.
                    with self._lock:
                        self._cleanup_confirmed = True
                        self._state = "error"
                raise
            except (OSError, ValueError):
                if self._process is None:
                    with self._lock:
                        self._cleanup_confirmed = True
                        self._state = "error"
                    raise TunStartError("无法连接流桥权限服务，请确认已安装完整新版。", cleanup_confirmed=True) from None
                self._abort_start("无法向管理员辅助程序发送启动请求。")
            deadline = time.monotonic() + self._start_timeout
            while True:
                with self._lock:
                    if self._helper_error:
                        failure = self._helper_error
                    elif self._ready and not self._stop_requested.is_set() and not self._exited.is_set():
                        self._sampler = threading.Thread(target=self._sample_loop, args=(self._sampling_stop,), name="flowbridge-tun-stats", daemon=True)
                        self._sampler.start()
                        return self
                    elif self._stop_requested.is_set():
                        failure = "全局接管启动已取消。"
                    elif self._exited.is_set():
                        failure = self._exit_description(self._returncode)
                    else:
                        failure = ""
                if failure:
                    self._abort_start(failure)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._abort_start("管理员认证或全局接管启动超时。")
                self._changed.wait(min(.1, remaining))
                self._changed.clear()

    def _read_protocol(self, process):
        try:
            if process.stdout is None:
                self._protocol_error("管理员辅助程序没有提供状态通道。")
            else:
                while True:
                    line = process.stdout.readline(MAX_PROTOCOL_LINE + 1)
                    if not line:
                        break
                    try:
                        if len(line) > MAX_PROTOCOL_LINE or not line.endswith("\n"):
                            raise ValueError
                        message = json.loads(line)
                        if not isinstance(message, dict):
                            raise ValueError
                    except (ValueError, TypeError):
                        self._protocol_error("管理员辅助程序返回的状态数据无效。")
                        continue
                    event, identity = message.get("event"), message.get("id")
                    with self._lock:
                        current = self._request_id
                        self._helper_event_seen = True
                    # A stop racing with a session failure can produce a second
                    # old idle acknowledgement. It cannot acknowledge a new run.
                    if event == "stopped" and type(identity) is int and 0 < identity < current:
                        continue
                    if type(identity) is not int or identity != current:
                        self._protocol_error(self._safe_message(message.get("message")) if event == "error"
                                             else "管理员辅助程序返回了不匹配的会话状态。")
                        continue
                    if event == "ready":
                        self._accept_ready(message)
                    elif event == "error":
                        with self._lock:
                            self._helper_error = self._safe_message(message.get("message"))
                            self._state = "error"
                            self._stats["errors"] += 1
                        self._changed.set()
                    elif event == "stopped":
                        with self._lock:
                            self._cleanup_ack = self._cleanup_confirmed = True
                            self._ready = False
                            self._state = "idle"
                            self._secret = ""
                            self._api_port = self._proxy_port = None
                            self._stats["active_connections"] = 0
                        self._sampling_stop.set()
                        self._idle.set()
                        self._changed.set()
                    else:
                        self._protocol_error("管理员辅助程序返回了未知状态。")
        except (OSError, ValueError):
            self._protocol_error("与管理员辅助程序的状态通道已中断。")
        finally:
            self._send_stop_and_close()
            self._sampling_stop.set()
            try:
                code = process.wait()
            except (OSError, ValueError):
                code = process.poll()
            if process.stdout is not None and hasattr(process.stdout, "close"):
                try:process.stdout.close()
                except (OSError, ValueError):pass
            with self._lock:
                self._returncode = code
                auth_not_started = code in (126, 127) and not self._helper_event_seen
                self._cleanup_confirmed = (self._cleanup_ack and code == 0) or auth_not_started
                self._state = "stopped" if self._cleanup_confirmed else "error"
                self._ready = False
                self._stats["active_connections"] = 0
                if auth_not_started:self._helper_error = self._exit_description(code)
                if not self._cleanup_confirmed and not self._helper_error:
                    self._helper_error = "管理员辅助程序意外退出，网络清理尚未确认。"
                self._secret = ""
                self._exited.set()
            self._changed.set()

    def _send_stop_and_close(self):
        # EOF always releases the entire authorization lease; no unversioned
        # legacy stop request is sent to the persistent protocol.
        self._stop_requested.set()
        with self._stdin_lock:
            process = self._process
            stream = process.stdin if process is not None else None
            if stream is not None and not stream.closed:
                try:stream.close()
                except (OSError, ValueError):pass
        self._changed.set()

    def _stop(self, *, allow_recover):
        with self._stop_lock:
            with self._lock:
                if self._process is None or (self._cleanup_confirmed and
                        (self._state == "idle" or self._exited.is_set())):
                    return
                needs_recovery = self._exited.is_set() and not self._cleanup_confirmed
                self._state = "stopping"
            if needs_recovery:
                if allow_recover:
                    self._recover_cleanup()
                    return
                raise TunStopError("管理员辅助程序已退出，网络清理尚未确认。", controller=self)
            self._stop_requested.set()
            self._sampling_stop.set()
            with self._stdin_lock:
                stream = self._process.stdin
                if stream is not None and not stream.closed:
                    try:
                        stream.write(json.dumps({"version": 3, "command": "stop", "id": self._request_id}) + "\n")
                        stream.flush()
                    except (OSError, ValueError):
                        try:stream.close()
                        except (OSError, ValueError):pass
            deadline = time.monotonic() + self._stop_timeout
            while True:
                with self._lock:
                    if self._cleanup_confirmed:
                        break
                    if self._exited.is_set() or time.monotonic() >= deadline:
                        self._state = "error"
                        self._helper_error = self._helper_error or "已请求断开全局接管，但网络清理尚未确认；请重试断开。"
                        raise TunStopError(self._helper_error, controller=self)
                self._changed.wait(min(.1, max(.001, deadline-time.monotonic())))
                self._changed.clear()
            sampler = self._sampler
            if sampler is not None and sampler is not threading.current_thread():
                sampler.join(self._api_timeout + .2)

    def close(self):
        """Clean the active network session, then release this process's lease."""
        self._stop(allow_recover=True)
        if self._process is None:
            return
        self._send_stop_and_close()
        if not self._exited.wait(self._stop_timeout):
            raise TunStopError("网络已清理，但管理员辅助程序尚未确认退出。", cleanup_confirmed=self.cleanup_confirmed, controller=self)
        if not self.cleanup_confirmed:
            raise TunStopError("管理员辅助程序已退出，但网络清理尚未确认。", controller=self)
