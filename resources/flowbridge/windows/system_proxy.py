"""Transactional Windows user proxy settings through the WinINet LAN API.

TUN mode does not use this manager. An explicitly supplied config_dir selects
an isolated file backend, so GUI tests never change the machine's settings.
Reference: https://learn.microsoft.com/windows/win32/api/wininet/ns-wininet-internet_per_conn_optionw
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile
import uuid


class ProxySettingsError(RuntimeError):
    pass


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def file_lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            stream.seek(0, 2)
            if stream.tell() == 0:
                stream.write(b'\0'); stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def process_identity(pid):
    """Return a process creation timestamp, None if dead, '?' if inaccessible."""
    if os.name != 'nt':
        try:
            return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
        except OSError:
            return None
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None if ctypes.get_last_error() == 87 else '?'
    try:
        exit_code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return '?'
        if exit_code.value != 259:
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            return '?'
        return str(times[0].dwLowDateTime | (times[0].dwHighDateTime << 32))
    finally:
        kernel.CloseHandle(handle)


class WinInetBackend:
    KEYS = ('flags', 'server', 'bypass', 'autoconfig')

    def __init__(self):
        if os.name != 'nt':
            raise ProxySettingsError('Windows 系统代理仅可在 Windows 上使用。')
        class Value(ctypes.Union):
            _fields_ = [('number', wintypes.DWORD), ('text', ctypes.c_void_p), ('time', wintypes.FILETIME)]
        class Option(ctypes.Structure):
            _fields_ = [('option', wintypes.DWORD), ('value', Value)]
        class Options(ctypes.Structure):
            _fields_ = [('size', wintypes.DWORD), ('connection', wintypes.LPWSTR),
                        ('count', wintypes.DWORD), ('error', wintypes.DWORD),
                        ('options', ctypes.POINTER(Option))]
        self.Option, self.Options = Option, Options
        self.api = ctypes.WinDLL('wininet', use_last_error=True)
        self.api.InternetQueryOptionW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
        self.api.InternetQueryOptionW.restype = wintypes.BOOL
        self.api.InternetSetOptionW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        self.api.InternetSetOptionW.restype = wintypes.BOOL
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.GlobalFree.argtypes = [ctypes.c_void_p]
        self.kernel.GlobalFree.restype = ctypes.c_void_p

    def _options(self, querying=False):
        options = (self.Option * 4)()
        for option, code in zip(options, (10 if querying else 1, 2, 3, 4)):
            option.option = code
        request = self.Options(ctypes.sizeof(self.Options), None, 4, 0, options)
        return options, request

    def read(self):
        options, request = self._options(querying=True)
        size = wintypes.DWORD(ctypes.sizeof(request))
        if not self.api.InternetQueryOptionW(None, 75, ctypes.byref(request), ctypes.byref(size)):
            raise ProxySettingsError(f'无法读取 Windows 系统代理（错误 {ctypes.get_last_error()}）。')
        try:
            return {'flags': options[0].value.number, **{
                key: ctypes.wstring_at(option.value.text) if option.value.text else ''
                for key, option in zip(self.KEYS[1:], options[1:])}}
        finally:
            for option in options[1:]:
                if option.value.text:
                    self.kernel.GlobalFree(option.value.text)

    def write(self, value):
        options, request = self._options()
        options[0].value.number = value['flags']
        buffers = [ctypes.create_unicode_buffer(value[key]) for key in self.KEYS[1:]]
        for option, buffer in zip(options[1:], buffers):
            option.value.text = ctypes.cast(buffer, ctypes.c_void_p).value
        if not self.api.InternetSetOptionW(None, 75, ctypes.byref(request), ctypes.sizeof(request)):
            raise ProxySettingsError(f'无法保存 Windows 系统代理（错误 {ctypes.get_last_error()}）。')
        # Notify cached WinINet consumers after committing per-connection values.
        for option in (39, 37):
            if not self.api.InternetSetOptionW(None, option, None, 0):
                raise ProxySettingsError(f'Windows 代理已修改，但通知应用刷新失败（错误 {ctypes.get_last_error()}），请断开恢复。')


class IsolatedBackend:
    """File-only test backend; never touches registry or WinINet."""
    def __init__(self, path): self.path = Path(path)
    def read(self):
        if self.path.exists(): return json.loads(self.path.read_text(encoding='utf-8'))
        return {'flags': 1, 'server': '', 'bypass': '', 'autoconfig': ''}
    def write(self, value): atomic_json(self.path, value)


class DesktopProxyManager:
    def __init__(self, config_dir=None, runner=None, *, backend=None, state_dir=None):
        self.config_dir = Path(config_dir) if config_dir is not None else Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local'))
        self.state_dir = Path(state_dir) if state_dir is not None else self.config_dir / 'FlowBridge'
        self.journal_path = self.state_dir / 'windows-proxy-recovery.json'
        self.backend = backend or (IsolatedBackend(self.state_dir / 'isolated-proxy.json') if config_dir is not None else WinInetBackend())
        self._token = uuid.uuid4().hex
        self.last_warning = ''
        self.last_conflicts = ()

    def detect_backend(self): return 'windows'
    @property
    def describe(self): return 'Windows 当前用户 HTTP / HTTPS 代理'
    @property
    def is_applied(self):
        journal = self._read_journal()
        return bool(journal and journal['owner_token'] == self._token)

    @staticmethod
    def _valid_settings(value):
        return (isinstance(value, dict) and set(value) == set(WinInetBackend.KEYS)
                and type(value['flags']) is int and 0 <= value['flags'] <= 15
                and all(isinstance(value[key], str) and '\0' not in value[key] and len(value[key]) <= 32768 for key in WinInetBackend.KEYS[1:]))

    def _read_journal(self):
        try:
            value = json.loads(self.journal_path.read_text(encoding='utf-8'))
            if (value['version'] != 1 or value['backend'] != 'windows'
                    or not self._valid_settings(value['before']) or not self._valid_settings(value['expected'])
                    or type(value['owner_pid']) is not int or value['owner_pid'] <= 0
                    or not isinstance(value['owner_token'], str)):
                raise ValueError('invalid recovery journal')
            return value
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ProxySettingsError('代理恢复记录损坏，未覆盖现有 Windows 设置。') from error

    def apply(self, host, port):
        if host != '127.0.0.1' or type(port) is not int or not 1 <= port <= 65535:
            raise ProxySettingsError('系统代理仅可指向本机流桥转发端口。')
        with file_lock(self.state_dir / 'proxy.lock'):
            if self._read_journal():
                raise ProxySettingsError('已有待恢复的系统代理设置，请先断开或重启流桥完成恢复。')
            before = self.backend.read()
            expected = {'flags': 3, 'server': f'http={host}:{port};https={host}:{port}', 'bypass': 'localhost;127.*;[::1]', 'autoconfig': ''}
            atomic_json(self.journal_path, {'version': 1, 'backend': 'windows', 'owner_pid': os.getpid(),
                'owner_start': process_identity(os.getpid()), 'owner_token': self._token,
                'before': before, 'expected': expected})
            self.backend.write(expected)
            if self.backend.read() != expected:
                raise ProxySettingsError('Windows 未保留请求的代理设置，请断开恢复后重试。')

    def _restore(self, journal):
        current = self.backend.read()
        changed, conflicts = dict(current), []
        for key, expected in journal['expected'].items():
            if current[key] == expected:
                changed[key] = journal['before'][key]
            elif current[key] != journal['before'][key]:
                conflicts.append(key)
        if changed != current:
            self.backend.write(changed)
            if self.backend.read() != changed:
                raise ProxySettingsError('Windows 代理恢复未得到确认，请重试断开。')
        self.last_conflicts = tuple(conflicts)
        self.last_warning = '检测到其他程序修改了系统代理，已保留其更改。' if conflicts else ''
        self.journal_path.unlink(missing_ok=True)
        return True

    def restore(self):
        with file_lock(self.state_dir / 'proxy.lock'):
            journal = self._read_journal()
            if not journal: return False
            if journal['owner_token'] != self._token:
                raise ProxySettingsError('代理设置由另一流桥实例管理，未修改它。')
            return self._restore(journal)

    def recover_pending(self):
        with file_lock(self.state_dir / 'proxy.lock'):
            journal = self._read_journal()
            if not journal: return False
            identity = process_identity(journal['owner_pid'])
            if identity is not None and (identity == '?' or identity == journal.get('owner_start')):
                return False
            return self._restore(journal)
