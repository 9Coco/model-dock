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
    echo '电脑端：打开流桥，点击“查询热点地址”，确认地址后选择“接管全局流量”。'
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
