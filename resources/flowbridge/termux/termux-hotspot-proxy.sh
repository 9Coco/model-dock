#!/usr/bin/env bash
# Self-contained installer; the build step appends the source payload below.
set -euo pipefail
umask 077

usage() {
    echo '用法：bash termux-hotspot-proxy.sh [--ip 手机热点网关IP] [--port 代理端口] [--no-start]'
    echo '只解出源码：bash termux-hotspot-proxy.sh --extract 目录'
}

MANUAL_IP=
PORT_OVERRIDE=
NO_START=0
EXTRACT_DIR=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ip) [[ $# -ge 2 ]] || { usage; exit 1; }; MANUAL_IP=$2; shift 2 ;;
        --port) [[ $# -ge 2 ]] || { usage; exit 1; }; PORT_OVERRIDE=$2; shift 2 ;;
        --no-start) NO_START=1; shift ;;
        --extract) [[ $# -eq 2 ]] || { usage; exit 1; }; EXTRACT_DIR=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

if [[ -n "$PORT_OVERRIDE" ]]; then
    if [[ ! "$PORT_OVERRIDE" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORT_OVERRIDE < 1024 || 10#$PORT_OVERRIDE > 65535 )); then
        echo '--port 必须为 1024–65535 的整数。' >&2
        exit 1
    fi
fi

if [[ -n "$EXTRACT_DIR" ]]; then
    mkdir -p "$EXTRACT_DIR"
    DESTINATION=$(cd "$EXTRACT_DIR" && pwd)
else
    if [[ -z "${PREFIX:-}" || ! -x "$PREFIX/bin/pkg" || ! -x "$PREFIX/bin/bash" ]]; then
        echo '请把此文件传到 Android 手机，在 Termux 中用 bash 执行。' >&2
        echo '在电脑上可以用 --extract 目录 查看源码，不会安装或修改启动设置。' >&2
        exit 1
    fi
    if [[ -e "$PREFIX/bin/hotspot-proxy" ]] && ! grep -q 'Managed by termux-hotspot-proxy' "$PREFIX/bin/hotspot-proxy"; then
        echo "已有不属于此安装器的 $PREFIX/bin/hotspot-proxy，未覆盖。" >&2
        exit 1
    fi
    packages=()
    command -v gost >/dev/null 2>&1 || packages+=(gost)
    command -v python >/dev/null 2>&1 || packages+=(python)
    command -v flock >/dev/null 2>&1 || packages+=(util-linux)
    command -v nohup >/dev/null 2>&1 || packages+=(coreutils)
    if (( ${#packages[@]} )); then
        echo "安装所需 Termux 软件包：${packages[*]}"
        pkg install -y "${packages[@]}"
    fi
    DESTINATION="$HOME/.local/share/termux-hotspot-proxy"
    mkdir -p "$DESTINATION"
fi

# __EMBEDDED_PAYLOAD__

cat > "$DESTINATION/proxy.sh" <<'__HOTSPOT_PROXY_PROXY_SH__'
#!/usr/bin/env bash
# Managed by termux-hotspot-proxy. Run through: hotspot-proxy COMMAND
set -euo pipefail
umask 077

APP_DIR=${HOTSPOT_PROXY_ROOT:-"$HOME/.local/share/termux-hotspot-proxy"}
CONFIG_DIR="$APP_DIR/config"
STATE_DIR="$APP_DIR/state"
SETTINGS="$CONFIG_DIR/settings.conf"
GOST_CONFIG="$CONFIG_DIR/gost.yaml"
PID_FILE="$STATE_DIR/gost.pid"
LOG_FILE="$STATE_DIR/gost.log"
API_SOCKET="$STATE_DIR/gost-api.sock"
VERSION_FILE="$STATE_DIR/gost.version"
DISABLED_FILE="$STATE_DIR/autostart-disabled"
PYTHON=${HOTSPOT_PROXY_PYTHON:-python}
GOST=${HOTSPOT_PROXY_GOST:-gost}
SERVICE=hotspot-proxy

mkdir -p "$CONFIG_DIR" "$STATE_DIR"

create_settings() {
    if [[ ! -e "$SETTINGS" ]]; then
        cat > "$SETTINGS" <<'EOF'
# Shared HTTP / SOCKS5 TCP+UDP proxy. Change ports while the proxy is stopped.
PROXY_PORT=38473
METRICS_PORT=19090
# 1: acquire Termux wake lock when starting; this is not an Android keep-alive guarantee.
WAKE_LOCK=1
EOF
    fi
}

load_settings() {
    create_settings
    PROXY_PORT=38473
    METRICS_PORT=19090
    WAKE_LOCK=1
    # This is a private, locally editable shell configuration file.
    # shellcheck source=/dev/null
    source "$SETTINGS"
    for value in "$PROXY_PORT" "$METRICS_PORT"; do
        if [[ ! "$value" =~ ^[0-9]{1,5}$ ]] || (( 10#$value < 1024 || 10#$value > 65535 )); then
            echo "端口必须为 1024–65535 的整数：$SETTINGS" >&2
            return 1
        fi
    done
    PROXY_PORT=$((10#$PROXY_PORT))
    METRICS_PORT=$((10#$METRICS_PORT))
    if [[ "$PROXY_PORT" == "$METRICS_PORT" ]]; then
        echo '代理和监控必须使用不同端口。' >&2
        return 1
    fi
    [[ "$WAKE_LOCK" == 0 || "$WAKE_LOCK" == 1 ]] || return 1
}

dependencies() {
    local missing=0 command_name
    for command_name in "$PYTHON" "$GOST" flock nohup; do
        if ! command -v "$command_name" >/dev/null 2>&1; then
            echo "缺少命令：$command_name。请在 Termux 执行 pkg install gost python util-linux coreutils" >&2
            missing=1
        fi
    done
    (( missing == 0 ))
}

# Check the command line before signalling a PID. Never kill another proxy or a reused PID.
owned_pid() {
    [[ -r "$PID_FILE" ]] || return 1
    "$PYTHON" - "$PID_FILE" "$GOST_CONFIG" <<'PY'
import os, pathlib, sys
try:
    pid = int(pathlib.Path(sys.argv[1]).read_text().strip())
    if pid <= 1:
        raise ValueError('invalid pid')
    os.kill(pid, 0)
    args = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    config = os.fsencode(sys.argv[2])
    if not any(args[i] in (b'-C', b'-c') and args[i+1] == config for i in range(len(args)-1)):
        raise ValueError('not our process')
    print(pid)
except (OSError, ValueError):
    sys.exit(1)
PY
}

ready() {
    "$PYTHON" - "$PROXY_PORT" "$METRICS_PORT" <<'PY'
import socket, sys, urllib.request
try:
    def exact(conn, size):
        data = b''
        while len(data) < size:
            chunk = conn.recv(size - len(data))
            if not chunk:
                raise ValueError('SOCKS5 handshake ended early')
            data += chunk
        return data
    # A listening old HTTP-only GOST is not ready for global TCP+UDP mode.
    # UDP ASSOCIATE allocates a local relay without contacting an outside host.
    with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=.4) as conn:
        conn.sendall(b'\x05\x01\x00')
        if exact(conn, 2) != b'\x05\x00':
            raise ValueError('SOCKS5 is not enabled')
        conn.sendall(b'\x05\x03\x00\x01' + b'\x00' * 6)
        reply = exact(conn, 4)
        if reply[:3] != b'\x05\x00\x00':
            raise ValueError('SOCKS5 UDP is not enabled')
        address_size = {1: 4, 4: 16}.get(reply[3])
        if reply[3] == 3:
            address_size = exact(conn, 1)[0]
        if address_size is None or not address_size:
            raise ValueError('invalid SOCKS5 UDP relay')
        bound = exact(conn, address_size + 2)
        if int.from_bytes(bound[-2:], 'big') == 0:
            raise ValueError('invalid SOCKS5 UDP relay port')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{sys.argv[2]}/metrics', timeout=.4) as reply:
        if reply.status != 200 or b'gost_services' not in reply.read(2_000_000):
            raise ValueError('not GOST metrics')
except (OSError, ValueError):
    sys.exit(1)
PY
}

check_ports() {
    "$PYTHON" - "$PROXY_PORT" "$METRICS_PORT" <<'PY'
import socket, sys
for host, port, label in [('0.0.0.0', int(sys.argv[1]), '代理'), ('127.0.0.1', int(sys.argv[2]), '监控')]:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError as error:
            print(f'{label}端口 {port} 已被占用或不可用：{error}', file=sys.stderr)
            if label == '代理':
                print('请检查是否有其他代理使用此端口；本脚本不会结束其他程序。', file=sys.stderr)
            sys.exit(1)
PY
}

# GOST can leave its Unix API socket behind after an abrupt exit. Only remove
# a confirmed inactive socket, under the same lock used to start/stop GOST.
prepare_api_socket() {
    "$PYTHON" - "$API_SOCKET" <<'PYSOCKET'
import errno, os, pathlib, socket, stat, sys

path = pathlib.Path(sys.argv[1])
try:
    previous = path.lstat()
except FileNotFoundError:
    sys.exit(0)
except OSError as error:
    sys.exit(f'无法检查管理接口，未清理：{error}')

if not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.getuid():
    sys.exit(f'管理接口路径不是当前用户的 socket，未清理：{path}')
try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(1)
        conn.connect(str(path))
except OSError as error:
    if error.errno != errno.ECONNREFUSED:
        sys.exit(f'无法确认管理接口已失效，未清理：{error}')
else:
    sys.exit(f'管理接口仍在使用，未清理：{path}')

try:
    current = path.lstat()
    if (current.st_dev, current.st_ino, current.st_mode, current.st_uid) != (
            previous.st_dev, previous.st_ino, previous.st_mode, previous.st_uid):
        sys.exit(f'管理接口在检查期间发生变化，未清理：{path}')
    path.unlink()
except OSError as error:
    sys.exit(f'无法清理失效的管理接口：{error}')
print('已清理上次退出遗留的管理接口。')
PYSOCKET
}

write_config() {
    local api_addr
    api_addr=$("$PYTHON" - "$API_SOCKET" <<'PYAPI'
import json, sys
print(json.dumps('unix://' + sys.argv[1]))
PYAPI
)
    cat > "$GOST_CONFIG" <<EOF
services:
  - name: $SERVICE
    addr: "0.0.0.0:$PROXY_PORT"
    handler:
      type: auto
      metadata:
        udp: true
        udpBufferSize: 65535
        notls: true
    listener:
      type: tcp
    metadata:
      enableStats: true
api:
  addr: $api_addr
metrics:
  addr: "127.0.0.1:$METRICS_PORT"
  path: /metrics
log:
  level: warn
  output: stderr
EOF
}

addresses() {
    local args=(--port "$PROXY_PORT")
    if [[ -s "$CONFIG_DIR/phone-ip" ]]; then
        args+=(--manual "$(cat "$CONFIG_DIR/phone-ip")")
    fi
    "$PYTHON" "$APP_DIR/address.py" "${args[@]}"
}

banner() {
    echo
    addresses
    echo "HTTP / HTTPS 和 SOCKS5 共用入口端口 $PROXY_PORT，支持 TCP 与标准 SOCKS5 UDP 转发。"
    echo '电脑打开 ModelDock 侧栏的“网络接管”，选择“全局流量”，查询并保存热点地址，再点击“连接”。'
    echo '全局模式由电脑接管普通 TCP、UDP 和 DNS；手机需先更新到本版代理。'
    echo '实时上传 / 下载：hotspot-proxy monitor'
    echo '重新查看地址：hotspot-proxy info'
    echo '停止代理：hotspot-proxy stop'
    echo '代理使用 Termux 当前的网络出口；VPN 和热点仍由你在手机上开启。'
    echo
}

request_wake_lock() {
    [[ "$WAKE_LOCK" == 1 ]] || return 0
    if ! command -v termux-wake-lock >/dev/null 2>&1; then
        echo '警告：缺少 termux-wake-lock，未能申请唤醒锁；代理继续运行，请在 Termux 通知中检查唤醒锁和系统后台权限。' >&2
    elif ! termux-wake-lock; then
        echo '警告：申请 Termux 唤醒锁失败；代理继续运行，请在 Termux 通知中检查唤醒锁和系统后台权限。' >&2
    fi
    # This requests Android service work; success does not verify that the lock
    # remains held or that battery/background restrictions have been removed.
    return 0
}

start_locked() {
    local pid i version
    if pid=$(owned_pid); then
        if ready; then
            request_wake_lock
            echo "代理已在运行（PID $pid），不重复启动。"
            return 0
        fi
        echo "已有受管理进程（PID $pid），但 SOCKS5 UDP 或统计接口尚未就绪（旧版 HTTP-only 服务也会出现此提示）。请执行 hotspot-proxy logs 查看原因，再执行 hotspot-proxy restart。" >&2
        return 1
    fi
    rm -f "$PID_FILE"
    check_ports || return 1
    version=$("$GOST" -V 2>&1) || { echo '无法读取 GOST 版本。' >&2; return 1; }
    if [[ ! "$version" =~ (^|[[:space:]])v?3\. ]]; then
        echo "需要 GOST 3.x；当前输出：$version" >&2
        return 1
    fi
    prepare_api_socket || return 1
    write_config
    printf '%s\n' "$version" > "$VERSION_FILE"
    if [[ -f "$LOG_FILE" ]] && [[ $(wc -c < "$LOG_FILE") -gt 1048576 ]]; then
        mv -f "$LOG_FILE" "$LOG_FILE.previous"
    fi
    nohup "$GOST" -C "$GOST_CONFIG" </dev/null >>"$LOG_FILE" 2>&1 9>&- &
    pid=$!
    printf '%s\n' "$pid" > "$PID_FILE"
    for ((i=0; i<15; i++)); do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo '代理未能启动，最近日志：' >&2
            tail -n 15 "$LOG_FILE" >&2
            rm -f "$PID_FILE"
            return 1
        fi
        if ready; then
            request_wake_lock
            echo "代理已启动（PID $pid）。"
            return 0
        fi
        sleep .2
    done
    echo '启动检查未通过；请执行 hotspot-proxy logs 查看日志。' >&2
    return 1
}

stop_locked() {
    local pid i
    if ! pid=$(owned_pid); then
        rm -f "$PID_FILE"
        echo '没有可确认属于此脚本的运行进程；未停止其他程序。'
        return 0
    fi
    kill "$pid"
    for ((i=0; i<30; i++)); do
        if ! owned_pid >/dev/null; then
            rm -f "$PID_FILE"
            echo '代理已停止。'
            return 0
        fi
        sleep .1
    done
    echo '进程尚未退出；请检查 hotspot-proxy logs。未强制终止。' >&2
    return 1
}

with_lock() {
    exec 9>"$STATE_DIR/control.lock"
    if ! flock -w 6 9; then
        echo '另一个会话正在操作代理，请稍后重试。' >&2
        return 1
    fi
    "$@"
}

restart_locked() { stop_locked && start_locked; }

set_port_locked() {
    local requested=$1
    if [[ ! "$requested" =~ ^[0-9]{1,5}$ ]] || (( 10#$requested < 1024 || 10#$requested > 65535 )); then
        echo '代理端口必须为 1024–65535 的整数。' >&2
        return 1
    fi
    requested=$((10#$requested))
    if [[ "$requested" == "$METRICS_PORT" ]]; then
        echo '代理端口不能与监控端口相同。' >&2
        return 1
    fi
    if owned_pid >/dev/null; then
        echo '请先执行 hotspot-proxy stop，再设置端口，然后 hotspot-proxy start。' >&2
        return 1
    fi
    "$PYTHON" - "$SETTINGS" "$requested" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1])
text = p.read_text()
if len(re.findall(r'^PROXY_PORT=.*$', text, re.M)) != 1:
    sys.exit('配置中 PROXY_PORT 必须恰好出现一次，未修改。')
updated = re.sub(r'^PROXY_PORT=.*$', 'PROXY_PORT=' + sys.argv[2], text, flags=re.M)
temp = p.with_name(p.name + '.new')
temp.write_text(updated)
temp.chmod(p.stat().st_mode & 0o777)
temp.replace(p)
PY
    PROXY_PORT=$requested
    echo "代理端口已设置为 $PROXY_PORT。执行 hotspot-proxy start 启动。"
}

usage() {
    cat <<'EOF'
hotspot-proxy start           启动并显示地址（重复执行不会重复启动）
hotspot-proxy info            显示运行状态、地址和监控命令
hotspot-proxy monitor         每秒显示电脑上传 / 下载；Ctrl+C 只退出监控
hotspot-proxy stop            停止本脚本启动的代理
hotspot-proxy restart         重启代理并重新读取配置
hotspot-proxy logs            查看最近的运行日志
hotspot-proxy set-ip IP       保存从电脑查到的手机热点网关 IP，仅用于显示
hotspot-proxy set-ip auto     恢复自动查找候选地址
hotspot-proxy set-port PORT   停止代理后修改端口，再执行 start 生效
hotspot-proxy autostart off   关闭新会话自动启动
hotspot-proxy autostart on    恢复新会话自动启动
hotspot-proxy config          显示配置文件路径
EOF
}

main() {
    local command=${1:-start} pid
    shift || true
    load_settings
    case "$command" in
        start|restart|auto)
            if [[ "$command" == auto && -e "$DISABLED_FILE" ]]; then return 0; fi
            dependencies || return 1
            if [[ "$command" == restart ]]; then
                with_lock restart_locked || return 1
            else
                with_lock start_locked || return 1
            fi
            banner
            ;;
        stop)
            dependencies || return 1
            with_lock stop_locked
            echo '如不再需要 Termux 的其他后台任务，可执行 termux-wake-unlock 释放唤醒锁。'
            ;;
        info|status)
            if pid=$(owned_pid); then echo "代理进程：运行中（PID $pid）。"; else echo '代理进程：未运行。'; fi
            banner
            ;;
        monitor)
            exec "$PYTHON" "$APP_DIR/monitor.py" --url "http://127.0.0.1:$METRICS_PORT/metrics" --service "$SERVICE" \
                --api-socket "$API_SOCKET" --gost-version "$(cat "$VERSION_FILE" 2>/dev/null || true)" "$@"
            ;;
        logs) tail -n 60 "$LOG_FILE" ;;
        config) printf '%s\n' "$SETTINGS" ;;
        set-ip)
            [[ $# == 1 ]] || { usage; return 1; }
            if [[ "$1" == auto ]]; then
                rm -f "$CONFIG_DIR/phone-ip"
            else
                "$PYTHON" - "$1" <<'PY'
import ipaddress, sys
try:
    ip = ipaddress.IPv4Address(sys.argv[1])
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_reserved or int(ip) == 0xffffffff:
        raise ValueError('not a hotspot address')
except ValueError:
    sys.exit('请输入电脑热点连接中的 IPv4 网关地址。')
PY
                printf '%s\n' "$1" > "$CONFIG_DIR/phone-ip"
            fi
            addresses
            ;;
        set-port)
            [[ $# == 1 ]] || { usage; return 1; }
            with_lock set_port_locked "$1"
            ;;
        autostart)
            case "${1:-}" in
                on) rm -f "$DISABLED_FILE"; echo '已启用新会话自动启动。' ;;
                off) : > "$DISABLED_FILE"; echo '已关闭新会话自动启动；当前进程需另执行 hotspot-proxy stop 停止。' ;;
                *) usage; return 1 ;;
            esac
            ;;
        help|-h|--help) usage ;;
        *) usage; return 1 ;;
    esac
}

main "$@"
__HOTSPOT_PROXY_PROXY_SH__

cat > "$DESTINATION/monitor.py" <<'__HOTSPOT_PROXY_MONITOR_PY__'
#!/usr/bin/env python3
"""Display traffic forwarded by one GOST service, without reading Android netdevs.

GOST 3.3.0 TCP metrics use the client perspective, while its standard SOCKS5
UDP metrics are collected at the upstream socket with the directions reversed.
For the shared service, the private Unix API's TCP-only service statistics let
us separate these contributions. The correction is version-gated; unknown
versions never silently inherit an assumption about the UDP metric direction.
These are proxy traffic counters, not the phone's total traffic or VPN bill.
Rates use counter differences divided by monotonic elapsed time. The first
sample and a counter reset have no valid rate yet. ``--once`` emits one snapshot;
``--json`` emits one JSON object per line, suitable for other tools.
"""

import argparse
import http.client
from dataclasses import dataclass
import json
import math
import re
import shutil
import socket
import sys
import time
import unicodedata
import urllib.error
import urllib.request


DEFAULT_URL = "http://127.0.0.1:19090/metrics"
METRICS = {
    "gost_service_transfer_input_bytes_total": "upload_bytes",
    "gost_service_transfer_output_bytes_total": "download_bytes",
    "gost_service_requests_in_flight": "active_requests",
}
SAMPLE_RE = re.compile(
    r'^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{(.*?)\})?\s+(\S+)(?:\s+\S+)?\s*$'
)
LABEL_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")')
GOST_DEFINITION_RE = re.compile(r'^#\s+(?:HELP|TYPE)\s+gost_[a-zA-Z0-9_:]+(?:\s|$)')


@dataclass(frozen=True)
class Counters:
    upload_bytes: int
    download_bytes: int
    active_requests: int | None
    sample_approximate: bool = False
    error_bound_bytes: int = 0


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__('localhost', timeout=timeout)
        self.path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self.path)
        except BaseException:
            sock.close()
            raise
        self.sock = sock


def read_tcp_counters(path: str, service: str, timeout: float = 3.0) -> tuple[int, int]:
    """Read only service TCP statistics, never return/print the full config."""
    conn = UnixHTTPConnection(path, timeout)
    try:
        conn.request('GET', '/config', headers={'Accept': 'application/json'})
        reply = conn.getresponse()
        if reply.status != 200:
            raise ValueError('私有统计接口尚未就绪，请重启手机代理')
        body = reply.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError('私有统计响应过大')
        config = json.loads(body)
        for item in config.get('services', []):
            if item.get('name') != service:
                continue
            stats = item.get('status', {}).get('stats', {})
            values = (stats.get('inputBytes'), stats.get('outputBytes'))
            if any(type(value) is not int or value < 0 for value in values):
                raise ValueError('请重启手机代理以启用 TCP / UDP 统计')
            return values
        raise ValueError('未找到本脚本的服务统计，请重启手机代理')
    except (json.JSONDecodeError, AttributeError, TypeError, http.client.HTTPException):
        raise ValueError('私有统计接口未返回有效服务统计') from None
    finally:
        conn.close()


def correct_udp_directions(mixed: Counters, before: tuple[int, int], after: tuple[int, int]) -> Counters:
    """M_in=TCP_up+UDP_down; M_out=TCP_down+UDP_up in GOST 3.3.0.

    API and metrics reads are not atomic. Bracketing the metrics read with the
    TCP stats gives an explicit uncertainty bound instead of permanently
    clamping cumulative counters upward when a TCP burst skews one sample.
    """
    if any(end < start for start, end in zip(before, after)):
        raise ValueError('代理计数在采样期间重置，正在重新采样')
    tcp_up, tcp_down = ((start + end) // 2 for start, end in zip(before, after))
    error_bound = (sum(end - start for start, end in zip(before, after)) + 1) // 2
    return Counters(
        max(0, tcp_up + mixed.download_bytes - tcp_down),
        max(0, tcp_down + mixed.upload_bytes - tcp_up),
        mixed.active_requests,
        error_bound != 0,
        error_bound,
    )


def read_counters(opener, url: str, service: str, timeout: float,
                  api_socket: str | None = None, gost_version: str = '') -> Counters:
    if api_socket and not re.search(r'\bgost\s+v?3\.3\.0(?:\s|\(|$)', gost_version):
        raise ValueError('当前 GOST 版本的 UDP 指标方向尚未验证，暂不显示上下行；转发仍在运行')
    before = read_tcp_counters(api_socket, service, timeout) if api_socket else None
    request = urllib.request.Request(url, headers={'Accept': 'text/plain'})
    with opener.open(request, timeout=timeout) as response:
        mixed = parse_metrics(response.read().decode('utf-8', errors='replace'), service)
    if mixed is None:
        raise ValueError('统计地址没有返回有效的 GOST 指标，请核对地址和代理服务')
    if api_socket:
        after = read_tcp_counters(api_socket, service, timeout)
        return correct_udp_directions(mixed, before, after)
    return mixed


def parse_metrics(body: str, service: str) -> Counters | None:
    """Sum matching series; an idle GOST endpoint may omit zero-valued series.

    Missing counters on a recognizable GOST metrics endpoint mean zero traffic.
    An unrelated page is still an error, and other services never enter totals.
    """
    values: dict[str, float] = {}
    is_gost = False
    for line in body.splitlines():
        line = line.strip()
        if GOST_DEFINITION_RE.match(line):
            is_gost = True
            continue
        match = SAMPLE_RE.fullmatch(line)
        if not match:
            continue
        try:
            value = float(match[3])
            if not math.isfinite(value) or value < 0:
                continue
            if match[1].startswith("gost_"):
                is_gost = True
            if match[1] not in METRICS:
                continue
            labels = {m[1]: json.loads(m[2]) for m in LABEL_RE.finditer(match[2] or "")}
            if labels.get("service") != service:
                continue
        except (ValueError, json.JSONDecodeError):
            continue
        key = METRICS[match[1]]
        values[key] = values.get(key, 0) + value
    if not is_gost:
        return None
    return Counters(
        int(values.get("upload_bytes", 0)),
        int(values.get("download_bytes", 0)),
        int(values["active_requests"]) if "active_requests" in values else None,
    )


def format_size(value: float | None, per_second: bool = False) -> str:
    if value is None:
        return "等待下一次采样" if per_second else "—"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            suffix = "/s" if per_second else ""
            return f"{value:.1f} {unit}{suffix}"
        value /= 1024
    raise AssertionError("unreachable")


def display_width(text: str) -> int:
    """Count terminal cells, treating Chinese/full-width characters as two."""
    return sum(
        0 if unicodedata.combining(char) or unicodedata.category(char) in ("Mn", "Me", "Cf")
        else 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
        for char in text
    )


def fit_line(text: str, columns: int) -> str:
    # Keep one terminal cell unused so writing a line cannot trigger auto-wrap.
    limit = max(0, columns - 1)
    text = "".join(" " if unicodedata.category(char) == "Cc" else char for char in text)
    if display_width(text) <= limit:
        return text
    if not limit:
        return ""
    result, used = [], 0
    for char in text:
        width = display_width(char)
        if used + width > limit - 1:
            break
        result.append(char)
        used += width
    return "".join(result) + "…"


def render_panel(data: dict, previous_rows: int) -> int:
    """Refresh a fixed seven-row panel; never rely on an overlong single line."""
    if data["ok"]:
        detail = (
            "计数已重置，重新采样" if data["counter_reset"] else
            f"近似采样，累计误差≤{format_size(data['error_bound_bytes'])}" if data["sample_approximate"] else
            f"活跃请求：{data['active_requests']}" if data["active_requests"] is not None else
            "只统计经过代理的数据"
        )
        lines = [
            "代理网速（电脑视角）",
            f"↑ 上传：{format_size(data['upload_bytes_per_second'], True)}",
            f"↓ 下载：{format_size(data['download_bytes_per_second'], True)}",
            f"累计上传：{format_size(data['upload_bytes'])}",
            f"累计下载：{format_size(data['download_bytes'])}",
            detail,
            "Ctrl+C 退出监控，代理继续运行",
        ]
    else:
        lines = [
            "代理网速（电脑视角）",
            "暂时读不到统计",
            data["error"],
            "请确认代理服务已启动",
            "", "",
            "Ctrl+C 退出监控，代理继续运行",
        ]
    columns = shutil.get_terminal_size(fallback=(80, 24)).columns
    if previous_rows:
        sys.stdout.write(f"\033[{previous_rows}F")
    for line in lines:
        sys.stdout.write("\033[2K" + fit_line(line, columns) + "\n")
    sys.stdout.flush()
    return len(lines)


def sample_data(current: Counters, now: float, previous: tuple[Counters, float] | None) -> dict:
    upload_rate = download_rate = None
    reset = False
    if previous is not None:
        old, old_time = previous
        reset = current.upload_bytes < old.upload_bytes or current.download_bytes < old.download_bytes
        elapsed = now - old_time
        if not reset and elapsed > 0:
            upload_rate = (current.upload_bytes - old.upload_bytes) / elapsed
            download_rate = (current.download_bytes - old.download_bytes) / elapsed
    return {
        "ok": True,
        "upload_bytes": current.upload_bytes,
        "download_bytes": current.download_bytes,
        "upload_bytes_per_second": upload_rate,
        "download_bytes_per_second": download_rate,
        "active_requests": current.active_requests,
        "counter_reset": reset,
        "sample_approximate": current.sample_approximate,
        "error_bound_bytes": current.error_bound_bytes,
    }


def positive_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("必须是大于 0 的有限数值")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description="实时查看 GOST 热点代理的电脑上传/下载速度")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"统计地址，默认 {DEFAULT_URL}")
    parser.add_argument("--service", default="hotspot-proxy", help="GOST 服务名")
    parser.add_argument("--interval", type=positive_float, default=1.0, help="采样间隔秒数，默认 1")
    parser.add_argument("--timeout", type=positive_float, default=3.0, help="单次请求超时秒数，默认 3")
    parser.add_argument("--api-socket", help="本脚本的私有 GOST API Unix socket，用于校正共享服务的 UDP 上下行")
    parser.add_argument("--gost-version", default="", help="受管理进程启动时的 GOST 版本输出")
    parser.add_argument("--once", action="store_true", help="只读取一次累计统计；首次速率为空")
    parser.add_argument("--json", action="store_true", help="每次采样输出一行 JSON")
    args = parser.parse_args()
    # A localhost metrics request must never go through the user's HTTP_PROXY.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    previous = None
    tty = sys.stdout.isatty() and not args.json
    panel_rows = 0
    if not args.json and not tty:
        print("电脑视角：↑ 上传到手机代理；↓ 从手机代理下载。Ctrl+C 只退出监控。", flush=True)
    try:
        while True:
            started = time.monotonic()
            try:
                counters = read_counters(opener, args.url, args.service, args.timeout,
                                         args.api_socket, args.gost_version)
                sampled_at = time.monotonic()
                data = sample_data(counters, sampled_at, previous)
                previous = (counters, sampled_at)
            except (OSError, urllib.error.URLError, ValueError) as exc:
                data = {"ok": False, "error": f"暂时读不到统计，请确认代理已启动：{exc}"}
            data["service"] = args.service
            if args.json:
                print(json.dumps(data, ensure_ascii=False), flush=True)
            elif tty:
                panel_rows = render_panel(data, panel_rows)
            else:
                if data["ok"]:
                    message = (
                        f"↑ 上传 {format_size(data['upload_bytes_per_second'], True)}"
                        f"  ↓ 下载 {format_size(data['download_bytes_per_second'], True)}"
                        f"  | 累计 ↑ {format_size(data['upload_bytes'])}"
                        f"  ↓ {format_size(data['download_bytes'])}"
                    )
                    if data["active_requests"] is not None:
                        message += f"  | 活跃请求 {data['active_requests']}"
                    if data["counter_reset"]:
                        message += "  [计数已重置，重新采样]"
                    if data["sample_approximate"]:
                        message += f"  [近似采样，累计误差≤{format_size(data['error_bound_bytes'])}]"
                else:
                    message = data["error"]
                print(message, flush=True)
            if args.once:
                return 0 if data["ok"] else 1
            time.sleep(max(0.0, args.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        print("\n监控已退出，代理继续运行。", file=sys.stderr)
        return 0
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
__HOTSPOT_PROXY_MONITOR_PY__

cat > "$DESTINATION/address.py" <<'__HOTSPOT_PROXY_ADDRESS_PY__'
#!/usr/bin/env python3
"""Best-effort local IPv4 candidates for a phone-hosted proxy.

Android may deny interface enumeration even though listening sockets work.
Candidates therefore never claim to identify the hotspot conclusively.  The
computer's IPv4 gateway after joining the hotspot is the source of truth.
This module only reads local interface information; it does not scan a network.
"""

import argparse
import ctypes
import ipaddress
import json
import re
import socket
import struct
import subprocess
import sys


GATEWAY_COMMAND = "nmcli -f GENERAL.CONNECTION,IP4.GATEWAY device show"
HINT = "手机接口候选或以前保存的 IP 不保证当前可用，请从连接热点的电脑验证。"
DESKTOP_HINT = "电脑连接手机热点后，打开 ModelDock 的“网络接管 → 查询热点地址”，选择网关候选并保存，然后点击“连接”验证。"
VPN_OR_NON_LAN = re.compile(
    r"^(lo\d*$|tun|tap|utun|wg|wireguard|ppp|ipsec|vpn|clat|v4-|"
    r"dummy|docker|veth|virbr|br-|rmnet|r_rmnet|ccmni|pdp|p2p)",
    re.IGNORECASE,
)
HOTSPOT_INTERFACE = re.compile(r"^(ap\d|swlan|softap)|hotspot|_ap", re.IGNORECASE)
WIRELESS_INTERFACE = re.compile(r"^(wlan|wlp|wlx|wifi)", re.IGNORECASE)


def usable_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        return False
    return not (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or str(address) == "255.255.255.255"
    )


def candidate(interface, address):
    if VPN_OR_NON_LAN.search(interface) or not usable_ipv4(address):
        return None
    if HOTSPOT_INTERFACE.search(interface):
        kind, priority = "hotspot", 0
    elif WIRELESS_INTERFACE.search(interface):
        kind, priority = "wireless", 1
    else:
        kind, priority = "other", 2
    return {"interface": interface, "address": address, "kind": kind, "priority": priority}


def via_getifaddrs():
    """Use the Linux/Android ABI; failures are normal on restricted Android."""
    if not sys.platform.startswith("linux"):
        raise OSError("当前平台不使用 Linux/Android getifaddrs 布局")

    class Ifaddrs(ctypes.Structure):
        pass

    Ifaddrs._fields_ = [
        ("next", ctypes.POINTER(Ifaddrs)),
        ("name", ctypes.c_char_p),
        ("flags", ctypes.c_uint),
        ("addr", ctypes.c_void_p),
        ("netmask", ctypes.c_void_p),
        ("ifu", ctypes.c_void_p),
        ("data", ctypes.c_void_p),
    ]
    libc = ctypes.CDLL(None, use_errno=True)
    libc.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(Ifaddrs))]
    libc.getifaddrs.restype = ctypes.c_int
    libc.freeifaddrs.argtypes = [ctypes.POINTER(Ifaddrs)]
    libc.freeifaddrs.restype = None
    head = ctypes.POINTER(Ifaddrs)()
    if libc.getifaddrs(ctypes.byref(head)) != 0:
        raise OSError(ctypes.get_errno(), "getifaddrs 不可用")
    result = []
    try:
        current = head
        while current:
            entry = current.contents
            if entry.addr and entry.name and entry.flags & 1:  # IFF_UP
                family = ctypes.c_ushort.from_address(entry.addr).value
                if family == socket.AF_INET:
                    # sockaddr_in: family(2), port(2), IPv4 address(4).
                    packed = ctypes.string_at(entry.addr + 4, 4)
                    result.append((entry.name.decode("utf-8", "replace"), socket.inet_ntoa(packed)))
            current = entry.next
    finally:
        libc.freeifaddrs(head)
    return result


def via_ip():
    process = subprocess.run(
        ["ip", "-4", "-o", "addr", "show", "up"],
        text=True, capture_output=True, timeout=2, check=False,
    )
    if process.returncode:
        raise OSError("ip 无法读取接口信息")
    result = []
    for line in process.stdout.splitlines():
        match = re.match(r"\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/", line)
        if match:
            result.append((match.group(1).split("@", 1)[0], match.group(2)))
    return result


def via_ioctl():
    """Read individual interfaces if netlink-based enumeration is denied."""
    import fcntl

    names = {"ap0", "ap1", "swlan0", "softap0", "wlan0", "wlan1", "wlan2", "eth0", "rndis0", "usb0"}
    try:
        names.update(name for _, name in socket.if_nameindex())
    except OSError:
        pass
    result = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as handle:
        for name in sorted(names):
            if VPN_OR_NON_LAN.search(name):
                continue
            request = struct.pack("256s", name.encode()[:15])
            try:
                flags = fcntl.ioctl(handle.fileno(), 0x8913, request)  # SIOCGIFFLAGS
                if not struct.unpack_from("H", flags, 16)[0] & 1:
                    continue
                response = fcntl.ioctl(handle.fileno(), 0x8915, request)  # SIOCGIFADDR
                result.append((name, socket.inet_ntoa(response[20:24])))
            except OSError:
                continue
    return result


def discover():
    found = {}
    methods = []
    errors = []
    for name, reader in (("getifaddrs", via_getifaddrs), ("ip", via_ip), ("ioctl", via_ioctl)):
        try:
            for interface, address in reader():
                item = candidate(interface, address)
                if item:
                    found[(interface, address)] = item
            methods.append(name)
        except (OSError, AttributeError, ImportError, subprocess.TimeoutExpired) as error:
            errors.append({"method": name, "reason": str(error)})
    return sorted(found.values(), key=lambda item: (item["priority"], item["interface"], int(ipaddress.IPv4Address(item["address"])))), methods, errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=38473)
    parser.add_argument("--manual", metavar="IP", help="手动指定电脑热点连接中显示的手机 IPv4 网关")
    parser.add_argument("--json", action="store_true", help="输出结构化结果")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口应为 1 到 65535")
    if args.manual is not None:
        if not usable_ipv4(args.manual):
            parser.error("--manual 应填写手机的可连接 IPv4 地址，不能填 0.0.0.0 或回环地址")
        items = [{"interface": "", "address": str(ipaddress.IPv4Address(args.manual)), "kind": "manual", "priority": -1}]
        methods, errors = [], []
    else:
        items, methods, errors = discover()
    for item in items:
        item["proxy_url"] = f"http://{item['address']}:{args.port}"
    result = {
        "port": args.port,
        "candidates": items,
        "manual": args.manual is not None,
        "hint": HINT,
        "desktop_hint": DESKTOP_HINT,
        "gateway_command": GATEWAY_COMMAND,
        "methods": methods,
        "errors": errors,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        labels = {"manual": "手动设置", "hotspot": "热点接口候选", "wireless": "无线接口候选", "other": "其他接口候选"}
        if items:
            print("已保存的手机代理地址（请从电脑确认当前仍可用）：" if args.manual is not None else "手机 HTTP / SOCKS5 共用代理地址候选（脚本尚未从电脑验证）：")
            for item in items:
                interface = f"，{item['interface']}" if item["interface"] else ""
                print(f"  {item['proxy_url']}  （{labels[item['kind']]}{interface}）")
        else:
            print(f"代理端口：{args.port}；未能读取可用的手机 IPv4 地址，可能受系统权限限制。")
        print(HINT)
        print(DESKTOP_HINT)
        print("电脑查询命令：" + GATEWAY_COMMAND)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
__HOTSPOT_PROXY_ADDRESS_PY__

cat > "$DESTINATION/README.md" <<'__HOTSPOT_PROXY_README_MD__'
# ModelDock 手机热点代理

电脑连接手机热点后，手机在 **同一端口**提供 HTTP 与标准 SOCKS5 TCP/UDP 代理。在电脑的 ModelDock 中选择 **“网络接管 → 全局流量”**，普通 TCP/UDP 应用无需逐个配置代理。手机 VPN 和热点仍须开启，VPN 须允许 Termux 使用对应 TCP/UDP 出口。

## 安装或从旧版更新

把新版 `termux-hotspot-proxy.sh` 传到手机 Download，在 Termux 执行：

```bash
# 首次访问 Download 需执行并完成 Android 存储授权
termux-setup-storage
bash ~/storage/downloads/termux-hotspot-proxy.sh
```

旧版仅 HTTP 的脚本必须更新。默认安装完成后只重启本脚本管理的 GOST，以应用新服务；保留已有代理端口、保存的手机 IP、自启动开关及其他设置，不结束其他程序。

新安装默认端口 **38473**，监控接口为手机本机 `127.0.0.1:19090`。已有配置保留端口，可用 `--port` 显式覆盖，例如：

```bash
bash ~/storage/downloads/termux-hotspot-proxy.sh --port 38473
bash ~/storage/downloads/termux-hotspot-proxy.sh --no-start
```

`--no-start` 不启动或重启服务；若旧进程仍运行，稍后执行 `hotspot-proxy restart`。`--extract 目录` 只解出源码，不安装或启动。

安装器按需通过 `pkg install` 获取 GOST3.x、Python、util-linux、coreutils。管理命令为 `$PREFIX/bin/hotspot-proxy`，配置和状态在 `~/.local/share/termux-hotspot-proxy/`。普通代理不需要 root，不建立第二个 Android VPN。

## 启动与管理

```bash
hotspot-proxy start
hotspot-proxy info
hotspot-proxy monitor
hotspot-proxy restart
hotspot-proxy stop
hotspot-proxy logs
hotspot-proxy autostart off
hotspot-proxy autostart on
```

新交互 Termux 会话按已保存偏好自动启动。监控中 Ctrl+C 只退出监控，代理继续运行。默认会申请 Termux wake lock；已有代理正常运行时，再执行 `hotspot-proxy start` 或新会话自动启动也会重新申请，保留原进程和连接。配置中 `WAKE_LOCK=0` 时不申请。命令缺失或申请失败会显示警告，代理继续运行；命令成功只表示已发出请求，不代表已验证唤醒锁持续有效。

唤醒锁不能替代手机系统允许 Termux 后台运行、关闭针对 Termux 的电池优化，以及手机 VPN 的后台和联网设置。若仅在切回 Termux 后恢复，应结合进程和网络状态检查这些设置；脚本仍不保证 Android 在锁屏、省电或清理后台后持续转发。停止代理不释放其他 Termux 任务共用的唤醒锁。

异常退出可能遗留 `state/gost-api.sock`，使旧脚本报 `bind: address already in use`。新版启动时会在管理锁内探测该接口，仅清理当前用户所有、明确拒绝连接且检查期间未变化的 socket；仍在使用的接口、普通文件、软链接或无法确认的错误均保留并提示。

## 找到正确手机地址

电脑连接手机热点后，打开 ModelDock 的 **“网络接管 → 查询热点地址”**，选择热点的网关候选。若手机使用自定义端口，请修改上游代理地址中的端口并保存，再点击“连接”验证。

手机脚本列出的接口候选、历史手动 IP 不保证当前仍可连接。Android 可能限制接口查询；电脑连接普通路由器时查到的是路由器，不能当成手机地址。

手动显示地址只影响提示，不改变出站路由：

```bash
hotspot-proxy set-ip 10.15.60.93
hotspot-proxy set-ip auto
```

示例 IP 不保证当前可用。HTTP 与 SOCKS5 共用同一地址端口；全局模式需要 SOCKS5 TCP 与 UDP，旧 HTTP-only 服务不会被当作全局能力已就绪。

## 电脑使用

打开 ModelDock 侧栏的“网络接管”，选择“全局流量”，填写手机 IP 与代理端口并保存，然后点击“连接”。Linux 请使用 ModelDock 的 deb 版并在首次连接时完成系统授权，Windows 请以管理员身份运行。启用前会验证 TCP 及经手机中继的 UDP DNS 往返，失败时检查脚本版本、VPN UDP策略、热点及动态 UDP relay 端口是否被系统阻挡。

HTTP 模式可使用同一端口。在 ModelDock 侧栏的“网络接管”选择“HTTP 代理”，遵循系统代理设置的应用会通过手机连接。

## 上传与下载监控

电脑客户端从自身内核读取 TCP/UDP 上下行。手机端的 `hotspot-proxy monitor` 统计本脚本服务，口径不等于手机网卡、VPN封装后或运营商计费流量。

已实测 GOST3.3.0 的原始 Prometheus UDP方向与TCP相反。本脚本启用同服务的TCP基线，通过私有 `state/gost-api.sock` Unix API校正混合计数；无额外TCP管理端口或常驻采集进程。API位于权限700的应用目录内。

该方向校正仅在已验证的 GOST3.3.0 启用；其他版本暂不显示未经验证的上下行，明确提示，但不影响转发。可以在 ModelDock 的“网络接管 → 网络流量”中查看电脑端计数。繁忙时 API 与 metrics 的读取不是原子的，监控会标记近似采样及误差界，不承诺每次采样逐字节一致。

## 访问与验证边界

代理未设置电脑 IP 白名单或认证；能访问手机该端口的设备可以使用服务，沿用原有本地热点用途。统计接口只监听手机回环，管理API只在私有Unix socket，不对热点公开。

真实 GOST3.3.0 的 HTTP、SOCKS TCP/UDP、混合计数及 Linux 内核互通已在本机回环/隔离网络验证；未在真实 Android 手机升级并验证 VPN UDP出口、锁屏保活、热点重开或省电策略。手机脚本的测试范围见随附的 [验证记录](验证记录.txt)。
__HOTSPOT_PROXY_README_MD__

cat > "$DESTINATION/验证记录.txt" <<'__HOTSPOT_PROXY_验证记录_TXT__'
Termux 热点代理脚本验证记录
日期：2026-11-01（Asia/Hong_Kong）

已在本机 Linux 使用 GOST 官方 v3.3.0 便携程序完成独立回环网络检查。
GOST 版本：gost v3.3.0 (go1.26.7 linux/amd64)
测试没有修改系统代理、Wi-Fi、手机或 VPN 配置。

20 项本地检查通过：
1. 拒绝 0.0.0.0 等不能作为电脑连接目标的显示地址。
2. 可保存并显示用户指定的热点网关地址。
3. 三个并发启动仅创建一个 GOST 实例。
4. 其他启动复用已有实例。
5. 未有客户端流量时监控显示零计数。
6. 使用信息包含监控命令。
7. HTTP 上传代理保持请求体完整。
8. 电脑上传正确计入 input 指标。
9. 下载尚未完成时计数已增长。
10. HTTP 下载代理保持响应体完整。
11. HTTP CONNECT 隧道可双向传输。
12. 连续采样计算实时速率。
13. Ctrl+C 仅结束监控，代理继续运行。
14. 关闭自动启动后 auto 不重新启动已停止的进程。
15. 新进程的累计计数从零开始。
16. 管理命令 restart 正常。
17. 不向无关或失效 PID 发送停止信号。
18. 端口占用时明确报错，不结束占用进程。
19. 汇总目标服务所有客户端，不计入其他服务。
20. 计数归零后重建采样基准，不显示负速率。

其他检查：
- Bash 安装器与管理脚本语法检查通过。
- Python 程序编译检查通过。
- 自包含安装脚本解出的各源码与原文件一致。
- 启动配置添加保留原内容、权限和软链接，修改前备份，重复执行不重复追加。
- Bash/Zsh/Fish 启动钩子写入与不完整标记拒绝检查通过；Zsh/Fish 未在真实 shell 中运行验收。
- 统计解析器、重置、错误响应、本地读取绕过 HTTP_PROXY、地址识别失败时的降级检查通过。
- 手机窄屏监控采用固定多行面板，40/60 列、中文显示宽度、极窄窗口截断及非终端/JSON 输出检查通过。

默认端口改为 38473 后的针对性检查，使用真实 GOST 本地回环网络，4 项通过：
- 首次生成的配置与地址显示程序均默认使用 38473。
- 非法端口、低位端口、与监控端口相同的值均被拒绝，配置保持原样。
- 运行中的实例拒绝直接修改端口，配置与现有进程不受影响。
- 停止后修改端口，再启动可通过新端口转发 HTTP；旧监听关闭，地址提示与流量统计正常。

未验证：
- 用户 Android 手机上的 pkg 软件包安装和实际 shell 启动钩子执行。
- 该手机能否无 Root 读取热点接口地址。
- GOST 在该手机 VPN 下的 DNS、真实外网和电脑热点入站。
- 锁屏、省电、系统结束 Termux、重启手机后的生命周期。

此前用户已验证的是 Tinyproxy 路线；新 GOST 路线仍须在手机上执行安装后验证。
__HOTSPOT_PROXY_验证记录_TXT__

if [[ -n "$EXTRACT_DIR" ]]; then
    echo "源码已解出：$DESTINATION"
    exit 0
fi

chmod 700 "$DESTINATION/proxy.sh" "$DESTINATION/address.py" "$DESTINATION/monitor.py"
cat > "$PREFIX/bin/hotspot-proxy" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Managed by termux-hotspot-proxy
exec bash "$HOME/.local/share/termux-hotspot-proxy/proxy.sh" "$@"
EOF
# Use the actual installed Bash path, including supported alternate package names.
python - "$PREFIX/bin/hotspot-proxy" "$PREFIX/bin/bash" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = p.read_text().splitlines()
lines[0] = '#!' + sys.argv[2]
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o700)
PY

# One marker block per shell file, preserving unrelated startup content.
python - "$PREFIX/bin/hotspot-proxy" "${SHELL:-}" <<'PY'
import datetime
import os
from pathlib import Path
import shutil
import stat
import sys

start = '# >>> termux-hotspot-proxy >>>'
end = '# <<< termux-hotspot-proxy <<<'
home = Path.home()
hook = '''# >>> termux-hotspot-proxy >>>
case $- in
  *i*)
    if [ -x "$PREFIX/bin/hotspot-proxy" ]; then
      "$PREFIX/bin/hotspot-proxy" auto || true
    fi
    ;;
esac
# <<< termux-hotspot-proxy <<<'''
targets = [(home / '.bashrc', hook)]
shell = Path(sys.argv[2]).name
if shell == 'zsh':
    targets.append((Path(os.environ.get('ZDOTDIR', str(home))) / '.zshrc', hook))
elif shell == 'fish':
    targets.append((home / '.config/fish/conf.d/termux-hotspot-proxy.fish', '''# >>> termux-hotspot-proxy >>>
if status is-interactive
    if test -x "$PREFIX/bin/hotspot-proxy"
        "$PREFIX/bin/hotspot-proxy" auto
    end
end
# <<< termux-hotspot-proxy <<<'''))
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
for path, block in targets:
    # Keep an existing dotfile symlink rather than replacing the link itself.
    if path.is_symlink():
        path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.read_text(errors='surrogateescape') if path.exists() else ''
    if old.count(start) != old.count(end) or old.count(start) > 1:
        raise SystemExit(f'启动文件标记不完整，未改动：{path}')
    if start in old:
        before, rest = old.split(start, 1)
        _, after = rest.split(end, 1)
        new = before + block + after
    else:
        new = old + ('\n' if old and not old.endswith('\n') else '') + '\n' + block + '\n'
    if new == old:
        print(f'启动钩子已存在：{path}')
        continue
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    if path.exists():
        backup = path.with_name(path.name + '.hotspot-proxy.bak.' + stamp)
        shutil.copy2(path, backup)
        print(f'已备份原启动文件：{backup}')
    temp = path.with_name(path.name + '.hotspot-proxy.tmp')
    temp.write_text(new, errors='surrogateescape')
    temp.chmod(mode)
    temp.replace(path)
    print(f'已设置新交互会话启动：{path}')
if shell not in ('', 'bash', 'zsh', 'fish'):
    print(f'默认 shell 是 {shell}；已配置 Bash。其他 shell 请按说明添加启动命令。')
PY

if [[ -n "$MANUAL_IP" ]]; then
    "$PREFIX/bin/hotspot-proxy" set-ip "$MANUAL_IP"
fi
if [[ -n "$PORT_OVERRIDE" ]]; then
    "$PREFIX/bin/hotspot-proxy" stop
    "$PREFIX/bin/hotspot-proxy" set-port "$PORT_OVERRIDE"
fi
echo
echo '安装完成。以后新建 Termux 交互会话时会启动代理并打印地址、监控命令。'
echo '已有会话从后台切回前台不会重新执行 shell 启动文件，可手动执行 hotspot-proxy start。'
echo '新安装默认端口 38473；重装保留已有端口，可用 --port 显式修改。'
echo '手机的同一端口支持 HTTP 和 SOCKS5 TCP/UDP。电脑可在 ModelDock 侧栏的“网络接管”选择“HTTP 代理”或“全局流量”。'
echo '更新只重启本脚本管理的代理，不会结束其他程序；原端口、手动 IP 和自启动开关均保留。'
if [[ "$NO_START" == 0 ]]; then
    # Restart our managed process so a running old HTTP-only configuration is
    # replaced by the new shared HTTP/SOCKS5 TCP+UDP service.
    if ! "$PREFIX/bin/hotspot-proxy" restart; then
        echo '文件与启动钩子已安装；解决上面的启动问题后执行 hotspot-proxy start。' >&2
        exit 1
    fi
else
    echo '已按 --no-start 保留当前运行状态；更新前已启动旧代理时，请执行 hotspot-proxy restart 启用 TCP+UDP。'
fi
