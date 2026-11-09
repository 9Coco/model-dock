"""One-time root-authorized installation of the calling user's fixed socket."""
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile

SOURCE=Path('/opt/modeldock-network/tun_setup.py')
SETUP_DIR=Path('/var/lib/modeldock-network-access')
SOCKET_DIR=Path('/run/modeldock-network-access')
SYSTEMCTL=Path('/usr/bin/systemctl')
UNIT_DIR=Path('/usr/lib/systemd/system')


def trusted(path,*,directory=False):
    path=Path(path)
    if not path.is_absolute():raise RuntimeError('系统安装路径无效。')
    for current in (*list(path.parents)[::-1],path):
        info=current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:
            raise RuntimeError('流桥系统安装权限异常，请重新安装完整软件包。')
        if current!=path and not stat.S_ISDIR(info.st_mode):raise RuntimeError('系统安装路径无效。')
    info=path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise RuntimeError('系统安装文件类型无效。')


def invoker(environment=None):
    if os.geteuid()!=0:raise RuntimeError('首次设置需要系统管理员授权。')
    environment=os.environ if environment is None else environment
    value=environment.get('PKEXEC_UID','')
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{1,10}',value):raise RuntimeError('未确认首次设置的用户。')
    uid=int(value)
    if uid<=0:raise RuntimeError('首次设置只允许普通用户。')
    try:entry=pwd.getpwuid(uid)
    except (KeyError,OverflowError) as error:raise RuntimeError('首次设置用户不存在。') from error
    if entry.pw_uid!=uid:raise RuntimeError('首次设置用户无效。')
    return uid


def enable_user(uid,*,run=subprocess.run):
    command=[str(SYSTEMCTL),'enable','--now',f'modeldock-network-access@{uid}.socket']
    completed=run(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                  env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},cwd='/',timeout=30,check=False)
    if completed.returncode:raise RuntimeError('无法启用流桥权限服务，请确认 systemd 系统服务可用。')
    trusted(SOCKET_DIR,directory=True)
    path=SOCKET_DIR/(str(uid)+'.sock');info=path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o600:
        raise RuntimeError('权限服务套接字创建结果异常，未记录首次授权成功。')
    trusted(SETUP_DIR.parent,directory=True)
    SETUP_DIR.mkdir(mode=0o755,exist_ok=True)
    trusted(SETUP_DIR,directory=True)
    # The root-private marker content stays 0600; users need to lstat their
    # own marker even under the installer's restrictive umask.
    SETUP_DIR.chmod(0o755)
    marker=SETUP_DIR/(str(uid)+'.enabled')
    if marker.exists() or marker.is_symlink():trusted(marker)
    fd,temporary=tempfile.mkstemp(prefix='.setup-',dir=SETUP_DIR)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as stream:
            stream.write('flowbridge-access-v1\n');stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,marker)
    finally:Path(temporary).unlink(missing_ok=True)


def main():
    os.umask(0o077)
    if len(sys.argv)!=1:raise RuntimeError('首次设置程序不接受参数。')
    uid=invoker()
    if Path(__file__).absolute()!=SOURCE:raise RuntimeError('首次设置只能从固定系统目录运行。')
    for path in (SOURCE,SYSTEMCTL,Path('/usr/libexec/modeldock-network-accessd'),
                 Path('/usr/libexec/modeldock-network-tun-helper'),UNIT_DIR/'modeldock-network-access@.socket',
                 UNIT_DIR/'modeldock-network-access@.service'):trusted(path)
    enable_user(uid)
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except (RuntimeError,OSError,subprocess.TimeoutExpired) as error:
        print(str(error),file=sys.stderr);raise SystemExit(1)
