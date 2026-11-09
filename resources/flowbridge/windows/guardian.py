"""Recover Windows user proxy settings after the GUI's lifetime pipe closes."""
import argparse
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import sys
import time

from windows.system_proxy import DesktopProxyManager


def _pipe_stream(stream, standard_handle, mode):
    """PyInstaller windowed builds can leave sys.stdin/stdout as None."""
    if stream is not None:
        return stream.buffer, False
    if os.name != 'nt':
        raise RuntimeError('Missing guardian lifetime pipe')
    import msvcrt
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
        ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.DuplicateHandle.restype = wintypes.BOOL
    original = kernel.GetStdHandle(standard_handle & 0xffffffff)
    duplicate = wintypes.HANDLE()
    process = kernel.GetCurrentProcess()
    if not original or original == ctypes.c_void_p(-1).value or not kernel.DuplicateHandle(process, original, process, ctypes.byref(duplicate), 0, False, 2):
        raise RuntimeError('Missing guardian lifetime pipe')
    descriptor = msvcrt.open_osfhandle(duplicate.value, os.O_BINARY | (os.O_RDONLY if mode == 'rb' else os.O_WRONLY))
    return os.fdopen(descriptor, mode), True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config-dir', type=Path)
    args = parser.parse_args()
    manager = DesktopProxyManager(config_dir=args.config_dir)
    incoming, own_incoming = _pipe_stream(sys.stdin, -10, 'rb')
    outgoing, own_outgoing = _pipe_stream(sys.stdout, -11, 'wb')
    outgoing.write(b'ready\n'); outgoing.flush()
    try:
        while incoming.read(64):
            pass
    except OSError:
        pass
    finally:
        if own_incoming: incoming.close()
        if own_outgoing: outgoing.close()
    for _ in range(50):
        if not manager.journal_path.exists(): return 0
        try:
            if manager.recover_pending(): return 0
        except Exception:
            pass  # Keep the recovery journal for the next application launch.
        time.sleep(.2)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
