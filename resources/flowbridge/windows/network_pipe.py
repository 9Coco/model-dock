# SPDX-License-Identifier: GPL-3.0-or-later
"""Local, single-client byte pipe shared by the TUN worker and its owner."""
import ctypes as c
from ctypes import wintypes as w
import os
import re
import time

# CreateFileW also checks FILE_READ_ATTRIBUTES when opening the client end.
# Exclude FILE_CREATE_PIPE_INSTANCE (0x4), WRITE_DAC and WRITE_OWNER.
CLIENT_ACCESS = 0x120083


def pipe_name(sid):
    if not re.fullmatch(r'S-1-(?:[0-9]+-){1,14}[0-9]+', sid):
        raise ValueError('Windows 用户标识无效。')
    return r'\\.\pipe\ModelDock.Network.' + sid


class SecurityAttributes(c.Structure):
    _fields_ = [('size', w.DWORD), ('descriptor', c.c_void_p), ('inherit', w.BOOL)]


def api(library, name, result, *arguments):
    fn = getattr(library, name)
    fn.restype, fn.argtypes = result, arguments
    return fn


def _libraries():
    return c.WinDLL('kernel32', use_last_error=True), c.WinDLL('advapi32', use_last_error=True)


def _file(handle):
    import msvcrt
    return os.fdopen(msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR), 'r+b', buffering=0)


def _owner_is_system(handle, kernel, security):
    owner, descriptor = c.c_void_p(), c.c_void_p()
    pointer = c.POINTER(c.c_void_p)
    get = api(security, 'GetSecurityInfo', w.DWORD, w.HANDLE, w.DWORD, w.DWORD,
              pointer, pointer, pointer, pointer, pointer)
    error = get(handle, 1, 1, c.byref(owner), None, None, None, c.byref(descriptor))
    if error:
        raise c.WinError(error)
    try:
        return bool(api(security, 'IsWellKnownSid', w.BOOL, c.c_void_p, w.DWORD)(owner, 22))  # LocalSystem
    finally:
        api(kernel, 'LocalFree', c.c_void_p, c.c_void_p)(descriptor)


def open_client(sid):
    kernel, security = _libraries()
    create = api(kernel, 'CreateFileW', w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p,
                 w.DWORD, w.DWORD, w.HANDLE)
    # Individual data rights, READ_CONTROL and SYNCHRONIZE. Never impersonate the client.
    handle = create(pipe_name(sid), CLIENT_ACCESS, 0, None, 3, 0x100000, None)
    if handle == c.c_void_p(-1).value:
        raise c.WinError(c.get_last_error())
    try:
        if not _owner_is_system(handle, kernel, security):
            raise PermissionError('无法确认 Windows 网络组件的系统身份。')
        return _file(handle)
    except BaseException:
        api(kernel, 'CloseHandle', w.BOOL, w.HANDLE)(handle)
        raise


def accept_client(sid):
    name = pipe_name(sid)
    # The user may exchange data but cannot create another pipe instance or change its ACL.
    # The explicit medium label permits writes from the ordinary desktop process.
    sddl = f'O:SYG:SYD:P(A;;GA;;;SY)(A;;0x{CLIENT_ACCESS:x};;;{sid})S:(ML;;NW;;;ME)'
    return _accept(name, sddl)


def _accept(name, sddl):
    kernel, security = _libraries()
    descriptor = c.c_void_p()
    convert = api(security, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', w.BOOL,
                  w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p)
    if not convert(sddl, 1, c.byref(descriptor), None):
        raise c.WinError(c.get_last_error())
    try:
        attrs = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor, False)
        create = api(kernel, 'CreateNamedPipeW', w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD,
                     w.DWORD, w.DWORD, w.DWORD, w.DWORD, c.POINTER(SecurityAttributes))
        handle = create(name, 0x80003, 9, 1, 8192, 8192, 0, c.byref(attrs))  # first instance, local only, NOWAIT
        if handle == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
    finally:
        api(kernel, 'LocalFree', c.c_void_p, c.c_void_p)(descriptor)
    try:
        connect = api(kernel, 'ConnectNamedPipe', w.BOOL, w.HANDLE, c.c_void_p)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if connect(handle, None):  # first NOWAIT call sets the instance listening
                continue
            error = c.get_last_error()
            if error == 535:  # ERROR_PIPE_CONNECTED
                break
            if error not in (0, 536):  # ERROR_PIPE_LISTENING
                raise c.WinError(error)
            time.sleep(.05)
        else:
            raise TimeoutError('等待 ModelDock 连接超时。')
        mode = w.DWORD(0)  # blocking byte stream after accepting the client
        if not api(kernel, 'SetNamedPipeHandleState', w.BOOL, w.HANDLE, c.POINTER(w.DWORD),
                   c.c_void_p, c.c_void_p)(handle, c.byref(mode), None, None):
            raise c.WinError(c.get_last_error())
        return _file(handle)
    except BaseException:
        api(kernel, 'CloseHandle', w.BOOL, w.HANDLE)(handle)
        raise
