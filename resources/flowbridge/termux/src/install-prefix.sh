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
