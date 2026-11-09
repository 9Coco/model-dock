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
