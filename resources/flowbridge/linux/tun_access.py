"""Restricted per-user system service transport for FlowBridge's TUN helper.

The root daemon accepts only the UID enabled during the one-time setup. It
launches one fixed installed helper and passes its private stream through;
all endpoint validation and route ownership remain in that helper. It never
accepts executable paths, shell text, or arbitrary systemd unit names.
"""
from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import pwd
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time

ACCESS_DIR = Path('/run/modeldock-network-access')
SETUP_DIR = Path('/var/lib/modeldock-network-access')
HELPER = Path('/usr/libexec/modeldock-network-tun-helper')
SOURCE = Path('/opt/modeldock-network/tun_access.py')
MAX_HANDSHAKE = 4096
_PEER = struct.Struct('3i')


class AccessError(RuntimeError):
    pass


class AccessUnavailable(AccessError):
    pass


def require_root_path(path, *, directory=False):
    path = Path(path)
    if not path.is_absolute():raise AccessError('系统服务路径必须是绝对路径。')
    for current in (*list(path.parents)[::-1], path):
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise AccessError('流桥系统服务路径权限异常，请重新安装完整软件包。')
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise AccessError('流桥系统服务路径无效。')
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise AccessError('流桥系统服务文件类型无效。')
    return path


def parse_uid(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{1,10}',value):
        raise AccessError('系统服务用户编号无效。')
    uid=int(value)
    if uid <= 0:raise AccessError('系统服务只允许已授权的普通用户。')
    try:entry=pwd.getpwuid(uid)
    except (KeyError,OverflowError) as error:raise AccessError('系统服务用户不存在。') from error
    if entry.pw_uid != uid:raise AccessError('系统服务用户无效。')
    return uid


def socket_path(uid):return ACCESS_DIR / (str(uid)+'.sock')
def setup_path(uid):return SETUP_DIR / (str(uid)+'.enabled')


def configured(uid):
    path=setup_path(uid)
    try:
        require_root_path(path)
        info=path.lstat()
    except FileNotFoundError:return False
    if stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1 or info.st_size>128:
        raise AccessError('流桥首次授权记录权限异常，请重新安装或修复系统服务。')
    return True


def validate_socket(uid):
    path=socket_path(uid)
    require_root_path(path.parent,directory=True)
    info=path.lstat()
    if (not stat.S_ISSOCK(info.st_mode) or info.st_uid!=uid
            or stat.S_IMODE(info.st_mode)!=0o600 or info.st_nlink!=1):
        raise AccessError('流桥权限服务套接字权限异常，未发送代理请求。')
    return path


def peer_uid(connection):
    pid,uid,_=_PEER.unpack(connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,_PEER.size))
    if pid<=0:raise AccessError('无法确认系统服务连接身份。')
    return uid


class _SocketWriter:
    def __init__(self,process):self.process=process;self.closed=False
    def write(self,value):
        if self.closed:raise ValueError('closed service stream')
        self.process.socket.sendall(value.encode('utf-8'))
        return len(value)
    def flush(self):pass
    def close(self):
        if self.closed:return
        self.closed=True
        try:self.process.socket.shutdown(socket.SHUT_WR)
        except OSError:pass


class _SocketReader:
    def __init__(self,process,stream):self.process=process;self.stream=stream
    def readline(self,limit=-1):
        try:raw=self.stream.readline(limit)
        except OSError:
            self.process._finish(1)
            raise
        if not raw:
            self.process._finish(1)
            return ''
        try:value=json.loads(raw)
        except (ValueError,TypeError):value=None
        if (isinstance(value,dict) and set(value)=={'event','returncode'}
                and value['event']=='access-ended' and type(value['returncode']) is int):
            self.process._finish(value['returncode'])
            return ''
        return raw.decode('utf-8',errors='replace')
    def close(self):
        self.stream.close()
        self.process.socket.close()


class SocketProcess:
    """The existing controller's narrow Popen interface over a verified socket."""
    def __init__(self,connection,stream):
        self.socket=connection;self.done=threading.Event();self.code=None
        self.stdin=_SocketWriter(self);self.stdout=_SocketReader(self,stream)
    def _finish(self,code):
        if not self.done.is_set():self.code=code;self.done.set()
    def poll(self):return self.code
    def wait(self,timeout=None):
        if not self.done.wait(timeout):raise subprocess.TimeoutExpired('flowbridge service',timeout)
        return self.code


def connect_service(uid=None,timeout=5):
    uid=os.getuid() if uid is None else uid
    try:path=validate_socket(uid)
    except FileNotFoundError:raise AccessUnavailable('流桥权限服务尚未启动。') from None
    connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    stream=None
    try:
        connection.settimeout(timeout)
        connection.connect(str(path))
        if peer_uid(connection)!=0:raise AccessError('流桥权限服务不是系统管理员进程，未发送代理请求。')
        validate_socket(uid)
        stream=connection.makefile('rb')
        raw=stream.readline(MAX_HANDSHAKE+1)
        if len(raw)>MAX_HANDSHAKE or not raw.endswith(b'\n'):raise AccessError('流桥权限服务握手无效。')
        try:value=json.loads(raw)
        except (ValueError,TypeError):raise AccessError('流桥权限服务握手无效。') from None
        if (not isinstance(value,dict) or set(value)!={'event','uid'}
                or value['event']!='access-ready' or type(value['uid']) is not int or value['uid']!=uid):
            if isinstance(value,dict) and value.get('event')=='access-denied':
                raise AccessError('另一个流桥窗口正在使用权限服务，请先退出另一窗口。')
            raise AccessError('流桥权限服务握手无效。')
        connection.settimeout(None)
        return SocketProcess(connection,stream)
    except OSError as error:
        if stream is not None:stream.close()
        connection.close()
        if error.errno in (errno.ENOENT,errno.ECONNREFUSED):
            raise AccessUnavailable('流桥权限服务暂不可用。') from None
        raise AccessError('无法连接流桥权限服务。') from None
    except Exception:
        if stream is not None:stream.close()
        connection.close()
        raise


def _send(connection,message):
    try:connection.sendall((json.dumps(message,ensure_ascii=True)+'\n').encode())
    except OSError:return False
    return True


def inherited_listener(uid,environment=None):
    environment=os.environ if environment is None else environment
    if environment.get('LISTEN_PID')!=str(os.getpid()) or environment.get('LISTEN_FDS')!='1':
        raise AccessError('权限服务必须由固定系统套接字启动。')
    listener=socket.socket(fileno=3)
    if (listener.family!=socket.AF_UNIX or listener.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)!=socket.SOCK_STREAM
            or not listener.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN)
            or listener.getsockname()!=str(socket_path(uid))):
        listener.close();raise AccessError('权限服务继承了无效监听套接字。')
    validate_socket(uid)
    listener.settimeout(.2)
    return listener


def serve(listener,uid,*,stopping=None,popen=subprocess.Popen):
    stopping=stopping or threading.Event()
    active=None
    try:
        while not stopping.is_set():
            if active is not None and active[1].poll() is not None:
                connection,process=active
                _send(connection,{'event':'access-ended','returncode':process.poll()})
                connection.close();active=None
            try:connection,_=listener.accept()
            except socket.timeout:continue
            # Bounded writes also apply in the child sharing this socket. A
            # client that stops reading cannot block route cleanup indefinitely.
            connection.setsockopt(socket.SOL_SOCKET,socket.SO_SNDTIMEO,struct.pack('ll',5,0))
            try:
                if peer_uid(connection)!=uid:
                    connection.close();continue
                if active is not None:
                    _send(connection,{'event':'access-denied','reason':'busy'})
                    connection.close();continue
                if not _send(connection,{'event':'access-ready','uid':uid}):
                    connection.close();continue
                environment={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C','PKEXEC_UID':str(uid)}
                try:
                    process=popen([str(HELPER)],stdin=connection,stdout=connection,stderr=subprocess.DEVNULL,
                                  cwd='/',env=environment,close_fds=True)
                except OSError:
                    _send(connection,{'event':'access-ended','returncode':127})
                    connection.close();continue
                active=(connection,process)
            except Exception:
                connection.close();raise
    finally:
        listener.close()
        if active is not None:
            connection,process=active
            if process.poll() is None:
                # Only the exact child we just created receives a graceful
                # termination; its existing signal handler owns route cleanup.
                process.terminate()
            try:
                code=process.wait(timeout=25)
                _send(connection,{'event':'access-ended','returncode':code})
            except subprocess.TimeoutExpired:
                # Keep waiting instead of accepting another client or killing
                # a helper during cleanup. systemd owns the service timeout.
                process.wait()
            finally:connection.close()


def main():
    if os.geteuid()!=0:raise AccessError('流桥权限服务必须由系统管理器启动。')
    if len(sys.argv)!=3 or sys.argv[1]!='--daemon':raise AccessError('权限服务参数无效。')
    uid=parse_uid(sys.argv[2])
    if Path(__file__).absolute()!=SOURCE:raise AccessError('权限服务只能从固定系统目录运行。')
    require_root_path(SOURCE);require_root_path(HELPER)
    stopping=threading.Event()
    for signum in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(signum,lambda *_:stopping.set())
    serve(inherited_listener(uid),uid,stopping=stopping)
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except AccessError as error:
        print(str(error),file=sys.stderr);raise SystemExit(1)
