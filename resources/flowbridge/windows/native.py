"""Windows process lifetime and narrowly scoped network state operations.

The core starts suspended and joins a kill-on-close Job before any code runs.
Normal stop sends Ctrl+C to its separate hidden console. The Job is only a
crash fallback. sing-tun also changes WeakHostSend, so the controller journals
and restores that setting; killing a process alone is not proof of cleanup.
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes as w
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

from windows import network_snapshot


def is_admin():
    return os.name == 'nt' and bool(ctypes.windll.shell32.IsUserAnAdmin())


def _kernel():
    if os.name != 'nt':
        raise OSError('此功能仅支持 Windows。')
    return ctypes.WinDLL('kernel32', use_last_error=True)


def powershell_json(script, timeout=20):
    """Only internal scripts are accepted; caller data is JSON/base64 encoded."""
    prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "
    command = base64.b64encode((prefix + script).encode('utf-16-le')).decode('ascii')
    executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    result = subprocess.run([str(executable), '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command],
                            capture_output=True, timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise OSError('无法读取或恢复 Windows 网络状态。请以管理员身份运行并确认网络管理组件可用。')
    return json.loads(result.stdout.decode('utf-8-sig').strip() or 'null')


def network_state(interface='modeldock-net'):
    return network_snapshot.network_state(interface)


def tun_state(interface='modeldock-net', timeout=20):
    """Read only readiness/cleanup evidence, retaining failures as failures."""
    return network_snapshot.tun_state(interface, timeout=timeout)


def capture_weak_host():
    return network_snapshot.capture_weak_host()


def restore_weak_host(rows):
    if not isinstance(rows, list) or len(rows) > 1024:
        raise ValueError('网络恢复记录无效。')
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'InterfaceIndex', 'InterfaceAlias', 'AddressFamily'}
                or type(row['InterfaceIndex']) is not int or not 1 <= row['InterfaceIndex'] <= 0xffffffff
                or not isinstance(row['InterfaceAlias'], str) or not row['InterfaceAlias']
                or row['AddressFamily'] not in ('IPv4', 'IPv6')):
            raise ValueError('网络恢复记录无效。')
    if not rows:
        return
    payload = base64.b64encode(json.dumps(rows).encode('utf-8')).decode('ascii')
    powershell_json("$rows=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "'))); "
                    "foreach($row in $rows) { $i=@(Get-NetIPInterface | Where-Object { $_.InterfaceIndex -eq $row.InterfaceIndex -and "
                    "[string]$_.AddressFamily -eq $row.AddressFamily -and $_.InterfaceAlias -eq $row.InterfaceAlias }); "
                    "foreach($entry in $i) { if($entry.WeakHostSend -ne 'Enabled') { "
                    "$entry | Set-NetIPInterface -WeakHostSend Enabled -ErrorAction Stop } } }; 'true'")


# Windows SDK DWORD is always 32 bits; explicit widths also let the ABI
# layout/decoder tests run on non-Windows development hosts.
_DWORD = ctypes.c_uint32


class _TcpRowOwnerPid(ctypes.Structure):
    _fields_ = [(name, _DWORD) for name in
                ('dwState', 'dwLocalAddr', 'dwLocalPort', 'dwRemoteAddr', 'dwRemotePort', 'dwOwningPid')]


class _Tcp6RowOwnerPid(ctypes.Structure):
    _fields_ = [('ucLocalAddr', ctypes.c_ubyte * 16), ('dwLocalScopeId', _DWORD),
                ('dwLocalPort', _DWORD), ('ucRemoteAddr', ctypes.c_ubyte * 16),
                ('dwRemoteScopeId', _DWORD), ('dwRemotePort', _DWORD),
                ('dwState', _DWORD), ('dwOwningPid', _DWORD)]


class _TcpTableOwnerPid(ctypes.Structure):
    _fields_ = [('dwNumEntries', _DWORD), ('table', _TcpRowOwnerPid * 1)]


class _Tcp6TableOwnerPid(ctypes.Structure):
    _fields_ = [('dwNumEntries', _DWORD), ('table', _Tcp6RowOwnerPid * 1)]


def _iphelper():
    if os.name != 'nt':
        raise OSError('此功能仅支持 Windows。')
    return ctypes.WinDLL('iphlpapi', use_last_error=True)


def _tcp_listeners(family):
    """One successful OWNER_PID_LISTENER snapshot per address family.

    SDK layout, alignment and port byte order:
    https://learn.microsoft.com/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable
    https://learn.microsoft.com/windows/win32/api/tcpmib/ns-tcpmib-mib_tcprow_owner_pid
    https://learn.microsoft.com/windows/win32/api/tcpmib/ns-tcpmib-mib_tcp6row_owner_pid
    """
    if family == socket.AF_INET:
        row_type, table_type = _TcpRowOwnerPid, _TcpTableOwnerPid
    elif family == socket.AF_INET6:
        row_type, table_type = _Tcp6RowOwnerPid, _Tcp6TableOwnerPid
    else:
        raise ValueError('invalid address family')
    query = _iphelper().GetExtendedTcpTable
    query.argtypes = [ctypes.c_void_p, ctypes.POINTER(_DWORD), w.BOOL, _DWORD, ctypes.c_int, _DWORD]
    query.restype = _DWORD
    capacity = 16384
    for _ in range(4):
        buffer = ctypes.create_string_buffer(capacity)
        size = _DWORD(capacity)
        status = query(buffer, ctypes.byref(size), False, family, 3, 0)  # OWNER_PID_LISTENER
        if status == 122:  # ERROR_INSUFFICIENT_BUFFER; table can grow between calls.
            capacity = max(size.value, capacity * 2)
            if capacity > 16 * 1024 * 1024:
                break
            continue
        if status:
            raise OSError(f'无法读取本机代理监听信息（Windows 错误 {status}）。')
        offset, stride = table_type.table.offset, ctypes.sizeof(row_type)
        if not offset <= size.value <= capacity:
            raise OSError('本机代理监听表长度无效。')
        count = _DWORD.from_buffer_copy(buffer).value
        if count > (size.value - offset) // stride:
            raise OSError('本机代理监听表记录不完整。')
        result = []
        for index in range(count):
            row = row_type.from_buffer_copy(buffer, offset + index * stride)
            if row.dwState != 2:  # MIB_TCP_STATE_LISTEN
                continue
            packed = bytes(_DWORD(row.dwLocalAddr)) if family == socket.AF_INET else bytes(row.ucLocalAddr)
            result.append({'address': str(ipaddress.ip_address(packed)),
                           'port': socket.ntohs(row.dwLocalPort & 0xffff), 'pid': row.dwOwningPid})
        return result
    raise OSError('本机代理监听表变化过快或过大，请稍后重试。')


def _process_image_path(pid):
    """Query a live owner's Win32 EXE path with only limited query rights.

    https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew
    No process or path failure is treated as an absent listener.
    """
    if type(pid) is not int or not 1 <= pid <= 0xffffffff:
        raise ValueError('本机代理进程标识无效。')
    kernel = _kernel()
    kernel.OpenProcess.argtypes = [_DWORD, w.BOOL, _DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, _DWORD, w.LPWSTR, ctypes.POINTER(_DWORD)]
    kernel.QueryFullProcessImageNameW.restype = w.BOOL
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(_DWORD)]
    kernel.GetExitCodeProcess.restype = w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.CloseHandle.restype = w.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        raise OSError('无法读取本机代理程序路径，请以管理员身份运行并确认代理程序仍在运行。')
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        size = _DWORD(len(buffer))
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            raise OSError('无法读取本机代理程序路径，请以管理员身份运行并确认代理程序仍在运行。')
        if not 0 < size.value < len(buffer):
            raise OSError('本机代理程序路径长度无效。')
        code = _DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
            raise OSError('本机代理程序已退出或状态无法确认，请重试连接。')
        return buffer[:size.value]
    finally:
        kernel.CloseHandle(handle)


def local_proxy_process(endpoint):
    """Return the exact executable owning a loopback listener, or refuse safely."""
    address = ipaddress.ip_address(endpoint.host)
    if not address.is_loopback:
        return None
    port = endpoint.port
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('代理端口无效。')
    rows = _tcp_listeners(socket.AF_INET) + _tcp_listeners(socket.AF_INET6)
    matching = []
    for row in rows:
        if row['port'] != port:
            continue
        listener = ipaddress.ip_address(row['address'])
        if isinstance(listener, ipaddress.IPv6Address) and listener.ipv4_mapped:
            listener = listener.ipv4_mapped
        if listener == address or listener.is_unspecified and (listener.version == address.version or listener.version == 6):
            matching.append(row)
    if not matching:
        raise ValueError('无法唯一识别本机代理程序，请先启动 VPN 的 SOCKS5 服务，或改用远程代理 IP。')
    owners = {row['pid'] for row in matching}
    if os.getpid() in owners:
        raise ValueError('不能把流桥自身作为上游代理。')
    # Query each owner once; any permission/exit error rejects the whole result.
    paths = {Path(_process_image_path(pid)) for pid in owners}
    if len(paths) != 1:
        raise ValueError('无法唯一识别本机代理程序，请先启动 VPN 的 SOCKS5 服务，或改用远程代理 IP。')
    path = paths.pop()
    if not path.is_absolute() or not path.is_file():
        raise ValueError('无法确认本机代理程序路径，未启动全局接管。')
    if path.name.lower() in ('flowbridge.exe', 'flowbridge-windows.exe', 'modeldock.exe'):
        raise ValueError('不能把流桥自身作为上游代理。')
    return str(path)


class SessionMutex:
    def __init__(self):
        kernel = _kernel()
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, w.BOOL, w.LPCWSTR]
        kernel.CreateMutexW.restype = w.HANDLE
        self.handle = kernel.CreateMutexW(None, False, 'Global\\FlowBridge.Windows.Tun.Session.v1')
        error = ctypes.get_last_error()
        if not self.handle:
            raise OSError('无法锁定 Windows 全局接管会话。')
        if error == 183:
            self.close()
            raise OSError('另一个流桥进程正在接管网络，请先断开它。')

    def close(self):
        if getattr(self, 'handle', None):
            kernel = _kernel()
            kernel.CloseHandle.argtypes = [w.HANDLE]
            kernel.CloseHandle(self.handle)
            self.handle = None


class _BasicLimits(ctypes.Structure):
    _fields_ = [('ProcessTime', ctypes.c_longlong), ('JobTime', ctypes.c_longlong),
                ('LimitFlags', w.DWORD), ('MinWorkingSet', ctypes.c_size_t), ('MaxWorkingSet', ctypes.c_size_t),
                ('ActiveProcessLimit', w.DWORD), ('Affinity', ctypes.c_size_t),
                ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes')]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [('Basic', _BasicLimits), ('IO', _IoCounters), ('ProcessMemory', ctypes.c_size_t),
                ('JobMemory', ctypes.c_size_t), ('PeakProcess', ctypes.c_size_t), ('PeakJob', ctypes.c_size_t)]


class _ThreadEntry(ctypes.Structure):
    _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ThreadID', w.DWORD),
                ('th32OwnerProcessID', w.DWORD), ('tpBasePri', w.LONG), ('tpDeltaPri', w.LONG), ('dwFlags', w.DWORD)]


def _resume_process(pid):
    kernel = _kernel()
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Thread32First.argtypes = kernel.Thread32Next.argtypes = [w.HANDLE, ctypes.POINTER(_ThreadEntry)]
    kernel.OpenThread.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenThread.restype = w.HANDLE
    kernel.ResumeThread.argtypes = [w.HANDLE]
    kernel.ResumeThread.restype = w.DWORD
    kernel.CloseHandle.argtypes = [w.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(4, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    resumed = False
    try:
        entry = _ThreadEntry()
        entry.dwSize = ctypes.sizeof(entry)
        found = kernel.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == pid:
                thread = kernel.OpenThread(2, False, entry.th32ThreadID)
                if not thread:
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    if kernel.ResumeThread(thread) == 0xffffffff:
                        raise ctypes.WinError(ctypes.get_last_error())
                    resumed = True
                finally:
                    kernel.CloseHandle(thread)
            found = kernel.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    if not resumed:
        raise OSError('无法启动网络内核线程。')


class CoreProcess:
    """Popen-shaped owned core process, with a non-inheritable Job handle."""
    def __init__(self, command, cwd):
        kernel = _kernel()
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        kernel.CreateJobObjectW.restype = w.HANDLE
        kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        kernel.CloseHandle.argtypes = [w.HANDLE]
        self.job = kernel.CreateJobObjectW(None, None)
        self.process = None
        if not self.job:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            limits = _ExtendedLimits()
            limits.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not kernel.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            self.process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            startupinfo=startup, close_fds=True,
                                            creationflags=subprocess.CREATE_NEW_CONSOLE | 4)
            if not kernel.AssignProcessToJobObject(self.job, int(self.process._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
            _resume_process(self.process.pid)
        except BaseException:
            if self.process is not None:
                self.process.kill()
                self.process.wait(timeout=5)
            self.close_job()
            raise

    @property
    def pid(self):
        return self.process.pid

    def poll(self):
        return self.process.poll()

    def wait(self, timeout=None):
        return self.process.wait(timeout=timeout)

    def request_stop(self):
        if getattr(sys, 'frozen', False):
            command = [sys.executable, '--signal-core', str(self.pid)]
        else:
            command = [sys.executable, '-I', '-B', str(Path(__file__).resolve().parent.parent / 'signal_core.py'), str(self.pid)]
        result = subprocess.run(command, cwd=Path(__file__).resolve().parent.parent,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=8, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise OSError('无法通知网络内核正常退出；请重试断开。')

    def close_job(self):
        if getattr(self, 'job', None):
            kernel = _kernel()
            kernel.CloseHandle.argtypes = [w.HANDLE]
            kernel.CloseHandle(self.job)
            self.job = None


def signal_core(pid):
    if type(pid) is not int or pid <= 0 or pid == os.getpid():
        raise ValueError('invalid core pid')
    kernel = _kernel()
    kernel.FreeConsole()
    if not kernel.AttachConsole(pid):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.SetConsoleCtrlHandler(None, True):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.GenerateConsoleCtrlEvent(0, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        time.sleep(.2)
    finally:
        kernel.FreeConsole()


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--signal-core':
        raise SystemExit(2)
    signal_core(int(sys.argv[2]))
