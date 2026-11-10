# SPDX-License-Identifier: GPL-3.0-or-later
"""Network-only stdio adapter. Electron owns UI/preferences; EOF requests cleanup.
Never receives ModelDock account credentials, inference payloads or tool config.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time
ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT), str(ROOT / 'linux')]
from linux.relay import ProxyRelay, Endpoint, parse_proxy_address
from linux import connectivity


class NetworkAuthorizationRequired(RuntimeError):
    code = 'NETWORK_AUTH_REQUIRED'


def require_automatic_network_access(mode, allow_install):
    if sys.platform == 'win32' or mode != 'global' or allow_install:
        return
    from linux.tun_access import configured
    try:
        ready = configured(os.getuid())
    except (OSError, RuntimeError):
        raise NetworkAuthorizationRequired('无法验证全局模式授权，请在网络接管页手动连接以检查系统服务。') from None
    if not ready:
        raise NetworkAuthorizationRequired('全局模式需要首次授权，请在网络接管页手动连接一次。')

if sys.platform == 'win32':
    from windows.network_access import NetworkAccess, TaskTunController
    from windows.system_proxy import DesktopProxyManager
    from windows.tun_client import TunController
    from windows.proxy import parse_global_address, probe_global_proxy
else:
    from linux.system_proxy import DesktopProxyManager
    from linux.tun_client import ReusableTunController as TunController
    from linux.tun_config import ROUTE_TABLE, validate_endpoint
    def parse_global_address(value):
        endpoint = parse_proxy_address(value.replace('socks5://', 'http://', 1))
        validate_endpoint(endpoint)
        return endpoint

    def check_global_upstream_route(endpoint):
        # Ask the kernel which interface a TCP connection from this user and to
        # this address/port would use. Other VPN interfaces can coexist.
        ip = shutil.which('ip', path='/usr/sbin:/usr/bin:/sbin:/bin')
        if not ip:
            return
        try:
            result = subprocess.run([ip, '-N', '-j', 'route', 'get', endpoint.host,
                                     'ipproto', 'tcp', 'dport', str(endpoint.port)],
                                    capture_output=True, timeout=2, check=True)
            routes = json.loads(result.stdout)
        except (OSError, subprocess.SubprocessError, ValueError):
            return  # The actual SOCKS5 preflight can still establish reachability.
        route = routes[0] if isinstance(routes, list) and routes else None
        if isinstance(route, dict) and route.get('dev') == 'flowbridge0' and str(route.get('table')) == str(ROUTE_TABLE):
            raise RuntimeError(f"到 {endpoint.display.removeprefix('http://')} 的连接当前经过流桥的 flowbridge0 接口。"
                               '请先断开独立流桥的全局接管，再连接 ModelDock。')

    def probe_global_proxy(endpoint, *, cancel_event, progress):
        check_global_upstream_route(endpoint)
        if cancel_event.is_set():
            raise InterruptedError('连接已取消。')
        target = 'example.com'
        address = endpoint.display.removeprefix('http://')
        try:
            connectivity.probe_global_proxy(endpoint, tcp_target=target)
            return
        except (connectivity.GlobalProbeTargetTimeout, connectivity.GlobalProbeTargetRejected) as error:
            target = 'www.microsoft.com'
            message = f'{error}。正在通过同一代理验证备用目标 {target}…'
        except (connectivity.GlobalProbeTimeout, connectivity.GlobalProbeTransient) as error:
            message = f'{error}。正在重试 {address}…'
        if cancel_event.is_set():
            raise InterruptedError('连接已取消。')
        progress(message)
        if cancel_event.wait(.5):
            raise InterruptedError('连接已取消。')
        try:
            connectivity.probe_global_proxy(endpoint, tcp_target=target)
        except (connectivity.GlobalProbeTransient, connectivity.GlobalProbeTimeout) as error:
            if cancel_event.is_set():
                raise InterruptedError('连接已取消。') from None
            raise OSError(f'{address} 已检测两次。{error}') from None

output_lock = threading.Lock()
def emit(value):
    # Electron reads UTF-8, while redirected Windows stdout uses the local code page.
    with output_lock:
        print(json.dumps(value, ensure_ascii=True, allow_nan=False), flush=True)

def guardian(directory):
    manager = DesktopProxyManager(state_dir=directory)
    print('ready', flush=True)
    sys.stdin.buffer.read()
    for _ in range(50):
        if not manager.journal_path.exists(): return
        try:
            if manager.recover_pending(): return
        except Exception: pass
        time.sleep(.2)

class NetworkSession:
    def __init__(self, directory):
        self.directory = directory
        self.desktop = DesktopProxyManager(state_dir=directory)
        self.controller = self.relay = self.port = self.mode = self.guard = None
        self._linux_recovery = None
        self.last_stats = {}
        self.cancelled = threading.Event()
        self.check_cancel = connectivity.CheckCancellation()
        self.access = NetworkAccess(lambda message: emit({'event': 'progress', 'message': message})) if sys.platform == 'win32' else None
    def ensure_guardian(self):
        if self.guard is not None and self.guard.poll() is None: return
        self.guard = subprocess.Popen([sys.executable, '-I', '-B', str(ROOT / 'bridge.py'),
            '--data-dir', str(self.directory), '--guardian'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(self.guard.stdout.readline()), daemon=True).start()
        try:
            if ready.get(timeout=5).strip() != b'ready': raise RuntimeError()
        except Exception:
            self.guard.stdin.close()
            raise RuntimeError('无法启动网络恢复守护程序，未更改系统网络。') from None
    def snapshot(self):
        raw = self.controller.snapshot() if self.controller else self.relay.snapshot() if self.relay else self.last_stats
        return {'running':bool(raw.get('running', self.relay is not None)),
            'cleanupConfirmed':not self.desktop.journal_path.exists() and not (self.directory / 'global-lease.json').exists() and (self.controller is None or self.controller.cleanup_confirmed),
            'localPort':self.port, 'uploadBytes':raw.get('upload_bytes',0),
            'downloadBytes':raw.get('download_bytes',0), 'connections':raw.get('active_connections',0),
            'message':(raw.get('last_error','') or self.desktop.last_warning)[:500]}
    def recover_global(self, allow_install=False):
        marker = self.directory / 'global-lease.json'
        if not marker.exists() or self.controller is not None: return
        if sys.platform == 'win32':
            record = json.loads(marker.read_text('utf-8'))
            if record == {'version': 2}:
                if allow_install:
                    self.access.open(True, recovery=True)
                if self.access.call('stop') is not True:
                    raise RuntimeError('尚未确认上次网络会话已恢复。')
                marker.unlink()
                return
            if record != {'version': 1}:
                raise RuntimeError('无法识别全局会话的恢复记录。')
            from windows import native
            if not native.is_admin():
                # Older versions wrote the weak-host journal before launching the core.
                # Never pass this user-writable journal to the privileged task.
                state = native.tun_state()
                if state['up'] or state['routes'] or (self.directory / 'tun-recovery.json').exists():
                    raise RuntimeError('旧版本留下了网络恢复记录。请以管理员身份打开一次 ModelDock，点击「恢复网络」。')
                marker.unlink()
                return
            mutex = native.SessionMutex()
            try:
                state = native.tun_state()
                if state['up'] or state['routes']: raise RuntimeError('接管网卡或路由仍在使用，未覆盖其他会话。')
                recovery = TunController(Endpoint('127.0.0.1',1080),state_dir=self.directory)
                recovery._recover_previous()
            finally: mutex.close()
        else:
            # A previous bridge lost its control pipe. Only the authorized
            # service can confirm the root journal is clean. Keep a timed-out
            # recovery around so a retry can collect its acknowledgement.
            if self._linux_recovery is None:
                self._linux_recovery = TunController(Endpoint('192.0.2.1', 38473))
            self._linux_recovery.recover_previous()
        marker.unlink()
        self._linux_recovery = None
    def disconnect(self, allow_install=False):
        self.check_cancel.cancel()
        if self.controller is not None:
            # A lost metrics pipe must not block the separate stop/recovery command.
            try: self.last_stats = self.controller.snapshot()
            except (RuntimeError, OSError): pass
        elif self.relay is not None: self.last_stats = self.relay.snapshot()
        self.last_stats = {k:v for k,v in self.last_stats.items() if k in ('upload_bytes','download_bytes','errors','total_connections')}
        # Restore desktop settings before removing the listener. Keep ownership
        # and resources for retry if any part of cleanup cannot be confirmed.
        self.desktop.recover_pending()
        self.desktop.restore()
        self.recover_global(allow_install)
        if self.controller is not None:
            self.controller.close()
            if not self.controller.cleanup_confirmed: raise RuntimeError('尚未确认路由清理完成，请重试断开。')
            self.controller = None
            (self.directory / 'global-lease.json').unlink(missing_ok=True)
        if self.relay is not None:
            self.relay.stop()
            self.relay = None
        if self.access is not None:
            self.access.release()
        self.port = self.mode = None
        return self.snapshot()
    def connect(self, settings, allow_install=False):
        self.disconnect()
        if self.cancelled.is_set(): raise RuntimeError('连接已取消。')
        self.check_cancel = connectivity.CheckCancellation()
        mode, address = settings['mode'], settings['address']
        require_automatic_network_access(mode, allow_install)
        endpoint = parse_global_address(address) if mode == 'global' else parse_proxy_address(address)
        self.ensure_guardian()
        emit({'event':'progress','message':'正在验证代理 TCP 与 UDP/DNS…' if mode == 'global' else '正在验证 HTTP 代理…'})
        if mode == 'global':
            probe_global_proxy(endpoint, cancel_event=self.cancelled,
                               progress=lambda message: emit({'event': 'progress', 'message': message}))
        else: connectivity.probe_http_proxy(endpoint)
        if self.cancelled.is_set(): raise RuntimeError('连接已取消。')
        try:
            self.last_stats = {}
            self.mode = mode
            if mode == 'global':
                if self.access is not None:
                    self.access.open(allow_install)
                    if self.cancelled.is_set(): raise RuntimeError('连接已取消。')
                    self.controller = TaskTunController(self.access, endpoint, settings['dnsMode'])
                else:
                    self.controller = TunController(endpoint)
                marker = self.directory / 'global-lease.json'
                with marker.open('x') as stream:
                    json.dump({'version':2 if self.access is not None else 1},stream); stream.flush(); os.fsync(stream.fileno())
                self.controller.start()
                self.port = self.controller.info['proxy_port']
            else:
                self.relay = ProxyRelay(endpoint)
                self.port = self.relay.start()
                self.desktop.apply('127.0.0.1', self.port)
            if self.cancelled.is_set(): raise RuntimeError('连接已取消。')
            return self.snapshot()
        except Exception:
            self.disconnect()
            raise
    def check(self, site):
        if site not in connectivity.SITES: raise ValueError('未知网站。')
        # Each run owns fresh deadlines; disconnect cancels the previous group.
        self.check_cancel = connectivity.CheckCancellation()
        url = connectivity.SITES[site]
        with ThreadPoolExecutor(max_workers=2) as pool:
            system = pool.submit(connectivity.test_system_website,url,cancellation=self.check_cancel)
            proxy = pool.submit(connectivity.test_website,'127.0.0.1',self.port,url,cancellation=self.check_cancel) if self.port else None
            return {'system':asdict(system.result()),'proxy':asdict(proxy.result()) if proxy else None}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir',type=Path,required=True)
    parser.add_argument('--guardian',action='store_true')
    args = parser.parse_args()
    if not args.data_dir.is_absolute(): raise ValueError('绝对数据路径必需。')
    args.data_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    if args.guardian:
        guardian(args.data_dir)
        return
    network = NetworkSession(args.data_dir)
    commands = queue.Queue(maxsize=16)
    closed = threading.Event()
    def read():
        try:
            while True:
                line = sys.stdin.buffer.readline(8193)
                if not line or len(line)>8192: break
                request = json.loads(line)
                if not isinstance(request,dict) or type(request.get('id')) is not int: break
                if request.get('method')=='cancel':
                    network.cancelled.set(); network.check_cancel.cancel()
                    emit({'id':request['id'],'ok':True,'result':None})
                else:
                    if request.get('method')=='connect': network.cancelled.clear()
                    commands.put_nowait(request)
        except Exception: pass
        finally:
            closed.set(); network.cancelled.set(); network.check_cancel.cancel()
    threading.Thread(target=read,daemon=True).start()
    # Read-only requests have no OS state to restore on EOF.
    cleanup_on_exit = False
    try:
        while not closed.is_set():
            try: request = commands.get(timeout=.1)
            except queue.Empty: continue
            try:
                method = request.get('method')
                if method in ('connect', 'disconnect'):
                    cleanup_on_exit = True
                if method=='connect':
                    result = network.connect(request['settings'], request.get('allowInstall') is True)
                elif method=='disconnect': result = network.disconnect(request.get('allowInstall') is True)
                elif method=='snapshot': result = network.snapshot()
                elif method=='localProxies' and sys.platform == 'win32':
                    from windows.local_proxy import discover_local_proxies
                    result = discover_local_proxies(network.desktop.backend.read(), request['gatewayPort'])
                elif method=='check': result = network.check(request.get('site'))
                else: raise ValueError('未知网络操作。')
                emit({'id':request['id'],'ok':True,'result':result})
            except Exception as error:
                message = str(error)[:500] if isinstance(error,(ValueError,RuntimeError,OSError)) else '网络操作失败，请检查配置与权限。'
                # Older helpers refer to the former combined disconnect/recover control.
                message = message.replace('点击断开 / 恢复', '点击「恢复网络」').replace('重试断开', '重试「恢复网络」')
                emit({'id':request['id'],'ok':False,'message':message,'code':getattr(error, 'code', None)})
    finally:
        if cleanup_on_exit:
            try: network.disconnect()
            except Exception: pass  # Durable journal + guardian retain crash recovery.
        if network.guard is not None: network.guard.stdin.close()
if __name__=='__main__': main()
