# SPDX-License-Identifier: GPL-3.0-or-later
"""Ordinary-user client for the protected ModelDock network task."""
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from windows.network_pipe import open_client, pipe_name
from windows.proxy import display_global_address

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD_SHA256 = 'f24621227afa878442356ac5dd274c78689e82e8556b6f59ee03b2ee035bd12d'
INSTALLER_SHA256 = '80222067c5547c43750f263434e3458c2c935e14e7a2b71918f48dab4cedaa59'
SYSTEM32 = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32'
POWERSHELL = SYSTEM32 / 'WindowsPowerShell/v1.0/powershell.exe'

class AuthorizationRequired(RuntimeError):
    code = 'WINDOWS_NETWORK_AUTH_REQUIRED'


def encoded(command):
    return base64.b64encode(command.encode('utf-16-le')).decode('ascii')


def run(command, *, input=None, timeout=15):
    return subprocess.run(command, input=input, capture_output=True, timeout=timeout,
                          creationflags=subprocess.CREATE_NO_WINDOW, cwd=SYSTEM32)


def powershell(command, **options):
    return run([POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand',
                encoded("$ErrorActionPreference='Stop'; " + command)], **options)


def user_sid():
    result = run([SYSTEM32 / 'whoami.exe', '/user', '/fo', 'csv', '/nh'])
    result.check_returncode()
    sid = next(csv.reader([result.stdout.decode('ascii', errors='replace').strip()]))[-1]
    pipe_name(sid)  # validate before putting the SID in a task name or script
    return sid


def task_state(sid, digest):
    result = powershell(
        "$s=New-Object -ComObject Schedule.Service; $s.Connect(); "
        "try { $t=$s.GetFolder('\\').GetTask('ModelDock.Network." + sid + "') } "
        "catch { if ($_.Exception.GetBaseException().HResult -eq -2147024894) { 'missing'; return }; throw }; "
        "if (!$t.Enabled) { 'disabled' } elseif ($t.Definition.RegistrationInfo.Description -eq 'ModelDock.Network/" + digest +
        "') { 'ready' } elseif ($t.Definition.RegistrationInfo.Description -match '^ModelDock\\.Network/[a-f0-9]{64}$') "
        "{ 'outdated' } else { 'conflict' }")
    if result.returncode:
        raise RuntimeError('无法读取 Windows 网络授权，请检查任务计划程序服务。')
    return result.stdout.decode('ascii').strip()


def install(sid, digest):
    installer = (ROOT / 'windows/install-network.ps1').read_bytes()
    if hashlib.sha256(installer).hexdigest() != INSTALLER_SHA256:
        raise RuntimeError('Windows 网络安装组件校验失败，请重新解压完整 Windows 包。')
    source = base64.b64encode(str(ROOT).encode('utf-8')).decode('ascii')
    script = (f"$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{source}')); "
              f"$sid='{sid}'; $digest='{digest}';\n" + installer.decode('utf-8'))
    # Elevate only the captured installer. Its task runs verified files in Program Files.
    # stdin avoids Windows' command-line limit from encoding the installer twice.
    result = powershell(
        "$args64=[Console]::In.ReadToEnd(); try { "
        "$p=Start-Process -FilePath ([IO.Path]::Combine($PSHOME,'powershell.exe')) -Verb RunAs "
        "-WindowStyle Hidden -WorkingDirectory ([Environment]::SystemDirectory) "
        "-ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$args64) -Wait -PassThru; exit $p.ExitCode "
        "} catch { if ($_.Exception.GetBaseException().NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }",
        input=encoded(script).encode('ascii'), timeout=110)
    if result.returncode == 1223:
        raise RuntimeError('已取消 Windows 全局网络授权。需要时可再次点击连接。')
    if result.returncode:
        raise RuntimeError('安装 Windows 网络组件失败，请检查完整 Windows 包和任务计划程序。')


class NetworkAccess:
    def __init__(self, progress):
        self.progress = progress
        self.stream = None
        self.sid = None

    def release(self):
        if self.stream is not None:
            self.stream.close()
            self.stream = None

    def open(self, allow_install=False):
        if self.stream is not None:
            return
        self.sid = self.sid or user_sid()
        state = task_state(self.sid, PAYLOAD_SHA256)
        if state in ('missing', 'outdated'):
            if not allow_install:
                raise AuthorizationRequired('请手动点击连接，完成 Windows 全局网络的一次性授权。')
            self.progress('请在 Windows 提示中授权安装全局网络组件…')
            install(self.sid, PAYLOAD_SHA256)
        elif state != 'ready':
            raise RuntimeError('Windows 网络任务已停用或存在同名冲突，请检查任务计划程序。')
        for attempt in range(2):
            # A previous instance may still be finishing EOF cleanup during a rapid app restart.
            result = run([SYSTEM32 / 'schtasks.exe', '/Run', '/TN', 'ModelDock.Network.' + self.sid])
            if result.returncode:
                raise RuntimeError('无法启动已授权的 Windows 网络任务，请检查任务计划程序。')
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                try:
                    self.stream = open_client(self.sid)
                    return
                except OSError as error:
                    if getattr(error, 'winerror', None) not in (2, 231):
                        raise
                    time.sleep(.1)
        raise RuntimeError('已授权的网络组件尚未就绪或仍由另一个会话使用，请稍后重试。')

    def call(self, method, **arguments):
        self.open()
        try:
            self.stream.write(json.dumps({'method': method, **arguments}).encode('ascii') + b'\n')
            while True:
                line = self.stream.readline(8193)
                if not line or len(line) > 8192 or not line.endswith(b'\n'):
                    raise OSError('网络组件连接中断，请重试断开恢复。')
                response = json.loads(line)
                if 'progress' in response:
                    self.progress(response['progress'])
                elif 'error' in response:
                    raise RuntimeError(response['error'])
                else:
                    return response['result']
        except (OSError, ValueError, KeyError):
            self.release()
            raise


class TaskTunController:
    def __init__(self, access, endpoint, dns_mode):
        self.access, self.address, self.dns_mode = access, display_global_address(endpoint), dns_mode
        self.cleanup_confirmed = False
        self.info = {}

    def start(self):
        self.info['proxy_port'] = self.access.call('start', address=self.address, dnsMode=self.dns_mode)

    def snapshot(self):
        return self.access.call('snapshot')

    def close(self):
        self.cleanup_confirmed = self.access.call('stop') is True
