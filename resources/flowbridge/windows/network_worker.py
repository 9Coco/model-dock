# SPDX-License-Identifier: GPL-3.0-or-later
"""Demand-started Windows task. All executable paths and state belong to its protected install."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from windows import native
from windows.network_pipe import accept_client
from windows.proxy import parse_global_address
from windows.tun_client import TunController

_START_FIELDS = {'method', 'address', 'dnsMode'}

def recover(directory):
    if not (directory / 'tun-recovery.json').exists():
        return
    mutex = native.SessionMutex()
    try:
        state = native.tun_state()
        if state['up'] or state['routes']:
            raise RuntimeError('接管网卡或路由仍在使用，请稍后重试恢复。')
        TunController(parse_global_address('127.0.0.1:1080'), state_dir=directory)._recover_previous()
    finally:
        mutex.close()


def send(stream, value):
    stream.write(json.dumps(value, ensure_ascii=True, allow_nan=False).encode('ascii') + b'\n')


def serve(stream, directory):
    controller = None
    try:
        while line := stream.readline(4097):
            if len(line) > 4096 or not line.endswith(b'\n'):
                return
            request = json.loads(line)
            try:
                if not isinstance(request, dict):
                    raise ValueError('无效的网络命令。')
                if request.get('method') == 'start' and set(request) in (_START_FIELDS, _START_FIELDS | {'bypassAddresses'}):
                    if controller is not None:
                        raise ValueError('请先断开当前网络会话。')
                    controller = TunController(parse_global_address(request['address']), dns_mode=request['dnsMode'],
                        bypass_addresses=request.get('bypassAddresses', ()),
                        state_dir=directory, progress=lambda message: send(stream, {'progress': message}))
                    controller.start()
                    result = controller.info['proxy_port']
                elif request == {'method': 'snapshot'} and controller is not None:
                    raw = controller.snapshot()
                    result = {k: raw[k] for k in ('running', 'upload_bytes', 'download_bytes', 'active_connections', 'last_error')}
                elif request == {'method': 'stop'}:
                    if controller is None:
                        recover(directory)
                    else:
                        controller.close()
                        if not controller.cleanup_confirmed:
                            raise RuntimeError('尚未确认网络清理完成，请重试断开。')
                        controller = None
                    result = True
                else:
                    raise ValueError('无效的网络命令。')
                send(stream, {'result': result})
            except (ValueError, RuntimeError, OSError) as error:
                send(stream, {'error': str(error)[:500]})
    finally:
        if controller is not None:
            controller.close()


if __name__ == '__main__':
    # No caller-controlled paths or command-line arguments. root is .../<SID>/<bundle hash>/.
    owner = ROOT.parent
    with accept_client(owner.name) as connection:
        serve(connection, owner / 'state')
