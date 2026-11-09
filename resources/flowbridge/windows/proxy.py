"""Windows global-proxy input and capability checks without network changes."""

from __future__ import annotations

import ipaddress
import math
import time
from urllib.parse import urlsplit

try:  # Shared desktop modules are on sys.path in the installed application.
    from relay import Endpoint
    from connectivity import (GlobalProbeTargetRejected, GlobalProbeTargetTimeout, GlobalProbeTimeout,
                              GlobalProbeTransient, probe_global_proxy as _probe_global_proxy)
except ModuleNotFoundError:
    from linux.relay import Endpoint
    from linux.connectivity import (GlobalProbeTargetRejected, GlobalProbeTargetTimeout, GlobalProbeTimeout,
                                    GlobalProbeTransient, probe_global_proxy as _probe_global_proxy)


_TCP_TARGETS = ("example.com", "www.microsoft.com")
_STARTUP_WINDOW = 120


def validate_endpoint(endpoint) -> tuple[str, int]:
    """Require a numeric IP, allowing local VPN listeners but no DNS bootstrap."""
    host, port = getattr(endpoint, "host", None), getattr(endpoint, "port", None)
    if not isinstance(host, str) or not host or host != host.strip() or "%" in host:
        raise ValueError("全局模式请填写数值 IPv4/IPv6 地址，不支持域名或 IPv6 作用域")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError("全局模式请填写数值 IPv4/IPv6 地址，例如 127.0.0.1:1080") from None
    # Normalize mapped IPv4 so local listener detection and socket family agree.
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if address.is_unspecified or address.is_multicast or str(address) == "255.255.255.255":
        raise ValueError("代理地址不能是未指定、组播或广播地址")
    if address.is_link_local:
        raise ValueError("全局模式不支持链路本地代理地址，请使用普通 IPv4/IPv6 或回环地址")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("代理端口必须是 1–65535 的整数")
    return str(address), port


def parse_global_address(text: str) -> Endpoint:
    """Accept bare IP:port or socks5://IP:port, with no credentials or paths."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("请填写 SOCKS5 代理地址，例如 socks5://127.0.0.1:1080")
    value = text.strip()
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("代理地址中不能包含空白或控制字符")
    try:
        parts = urlsplit(value if "://" in value else "//" + value)
        if parts.scheme and parts.scheme.lower() != "socks5":
            raise ValueError("全局 TCP/UDP 模式需要 SOCKS5 代理；HTTP 代理请使用 HTTP 代理模式")
        if parts.username is not None or parts.password is not None or "@" in parts.netloc:
            raise ValueError("当前全局模式不支持带用户名或密码的代理")
        if parts.path not in ("", "/") or parts.query or parts.fragment:
            raise ValueError("代理地址不能包含路径、查询参数或片段")
        if not parts.hostname or parts.port is None:
            raise ValueError("请明确填写代理 IP 和端口；IPv6 请使用 [地址]:端口")
        authority = parts.netloc
        if authority.startswith("["):
            suffix = authority.partition("]")[2]
            if not suffix.startswith(":") or not suffix[1:].isdigit():
                raise ValueError("IPv6 请使用 [地址]:端口")
        elif authority.count(":") != 1:
            raise ValueError("请填写 IP:端口；IPv6 请使用 [地址]:端口")
        endpoint = Endpoint(parts.hostname, parts.port)
        host, port = validate_endpoint(endpoint)
        return Endpoint(host, port)
    except ValueError as error:
        if str(error).startswith(("Port ", "Invalid ", "'", "Unmatched ")):
            raise ValueError("代理地址或端口格式无效；IPv6 请使用 [地址]:端口") from None
        raise


def display_global_address(endpoint) -> str:
    host, port = validate_endpoint(endpoint)
    return f"socks5://{'[' + host + ']' if ':' in host else host}:{port}"


def _upstream_message(error):
    return (str(error)
            .replace("请更新手机流桥代理脚本，启用 SOCKS5 和 UDP；旧版仅 HTTP 代理不能用于全局模式",
                     "请确认上游提供无认证 SOCKS5 和 UDP 转发，且端口填写正确")
            .replace("手机地址、热点连接和代理服务是否已启动", "上游地址、端口及代理程序是否已就绪")
            .replace("手机 VPN 出口", "上游代理出口")
            .replace("手机 VPN 的 UDP 策略、热点 UDP 中继", "上游代理的 UDP 策略、中继")
            .replace("手机代理", "上游代理").replace("手机", "上游代理"))


def _probe_windows_targets(endpoint, timeout, end, check_cancelled, progress):
    failures = []
    for target in _TCP_TARGETS:
        check_cancelled()
        attempt_timeout = min(timeout, end - time.monotonic()) if end is not None else timeout
        if attempt_timeout <= 0:
            raise GlobalProbeTimeout("启动等待时间已用完")
        try:
            _probe_global_proxy(endpoint, timeout=attempt_timeout, tcp_target=target)
            return
        except (GlobalProbeTargetTimeout, GlobalProbeTargetRejected) as error:
            check_cancelled()
            detail = "超时" if isinstance(error, TimeoutError) else f"SOCKS5 状态 {error.reply}"
            failures.append(f"{target}:443（{detail}）")
            if len(failures) == len(_TCP_TARGETS):
                message = "上游 SOCKS5 的两个 TCP 测试目标均未连通：" + "、".join(failures)
                error_type = GlobalProbeTimeout if isinstance(error, TimeoutError) else GlobalProbeTransient
                raise error_type(message) from None
            if end is not None and end <= time.monotonic():
                raise
            if progress is not None:
                progress(f"{failures[-1]}，正在通过同一代理检测 {_TCP_TARGETS[1]}:443…")


def probe_global_proxy(endpoint, timeout=8, *, startup=False, progress=None, cancel_event=None) -> None:
    """Allow one extra target attempt manually, and bounded retries during startup.

    Each attempt shares `timeout` across its handshake, TCP and UDP/DNS check.
    Switching targets requires a target-specific timeout or SOCKS rejection.
    """
    host, port = validate_endpoint(endpoint)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("连接测试超时时间无效")
    endpoint = Endpoint(host, port)

    def check_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("已取消代理检测。")

    end = time.monotonic() + _STARTUP_WINDOW if startup else None
    backoff = 2
    last_error = None
    while True:
        check_cancelled()
        if end is not None and time.monotonic() >= end:
            detail = "；最近一次检测：" + _upstream_message(last_error) if last_error is not None else ""
            raise TimeoutError(f"启动时等待上游代理就绪已达 {_STARTUP_WINDOW} 秒{detail}")
        try:
            _probe_windows_targets(endpoint, timeout, end, check_cancelled, progress)
        except (OSError, ValueError) as error:
            check_cancelled()
            if not startup or not isinstance(error, (GlobalProbeTransient, GlobalProbeTimeout)):
                message = _upstream_message(error)
                if isinstance(error, TimeoutError):
                    raise TimeoutError(message) from None
                if isinstance(error, ValueError):
                    raise ValueError(message) from None
                raise OSError(message) from None
            last_error = error
        else:
            check_cancelled()
            return

        pause = min(backoff, end - time.monotonic())
        if pause > 0:
            if progress is not None:
                progress(f"启动时上游代理尚未就绪，等待 {pause:.0f} 秒：{_upstream_message(last_error)}")
            if cancel_event is None:
                time.sleep(pause)
            else:
                cancel_event.wait(pause)
        backoff = min(backoff * 2, 8)
