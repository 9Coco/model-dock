"""Reversible desktop HTTP proxy settings, with a crash-recovery journal.

KDE's kioslaverc is edited losslessly: unrelated lines and groups are retained.
GNOME uses gsettings. Explicit config_dir isolates KDE files and journals; it
also forces GNOME's keyfile backend, so tests cannot touch the live dconf DB.
The injected runner follows subprocess.run(args, **kwargs)'s interface.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import uuid


class ProxySettingsError(RuntimeError):
    pass


KDE_KEYS = (
    "ProxyType", "httpProxy", "httpsProxy", "ftpProxy", "socksProxy",
    "NoProxyFor", "ReversedException",
)
GNOME_KEYS = (
    ("org.gnome.system.proxy", "mode"),
    ("org.gnome.system.proxy", "ignore-hosts"),
    ("org.gnome.system.proxy.http", "host"),
    ("org.gnome.system.proxy.http", "port"),
    ("org.gnome.system.proxy.http", "use-authentication"),
    ("org.gnome.system.proxy.https", "host"),
    ("org.gnome.system.proxy.https", "port"),
    ("org.gnome.system.proxy.ftp", "host"),
    ("org.gnome.system.proxy.socks", "host"),
)


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _process_start(pid: int) -> str | None:
    try:
        # A process name can contain spaces and parentheses.
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def _owner_alive(journal: dict) -> bool:
    pid = journal.get("owner_pid", 0)
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        if state in {"Z", "X", "x"}:
            return False
    except (OSError, IndexError):
        pass
    recorded, current = journal.get("owner_start"), _process_start(pid)
    return not (recorded is not None and current is not None and recorded != current)


def _atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _kde_entries(data: bytes):
    """Return raw lines and unique managed entries without normalizing text."""
    lines = data.decode("utf-8", "surrogateescape").splitlines(keepends=True)
    entries, duplicates, locked = {}, set(), set()
    in_group = False
    group_locked = False
    global_locked = any(line.strip() == "[$i]" for line in lines)
    last_group = None
    for index, line in enumerate(lines):
        header = re.match(r"^\s*\[([^\]]+)\](.*?)(?:\r?\n)?$", line)
        if header:
            # KConfig supports nested groups, e.g. [Proxy Settings][Child].
            # Such a child is unrelated to the top-level proxy settings.
            nested = re.search(r"\[(?!\$)[^\]]+\]", header.group(2))
            in_group = header.group(1) == "Proxy Settings" and nested is None
            group_locked = in_group and "[$i]" in header.group(2)
            if in_group:
                last_group = index
                if group_locked or global_locked:
                    locked.update(KDE_KEYS)
            continue
        if not in_group or line.lstrip().startswith(("#", ";")) or "=" not in line:
            continue
        raw_key, raw_value = line.split("=", 1)
        key = raw_key.strip().split("[", 1)[0]
        if key not in KDE_KEYS:
            continue
        if key in entries:
            duplicates.add(key)
        if "[" in raw_key or group_locked or global_locked:
            locked.add(key)
        entries[key] = {"index": index, "raw": line, "value": raw_value.rstrip("\r\n").strip()}
    return lines, entries, duplicates, locked, last_group


def _kde_edit(data: bytes, values: dict[str, str | None], raw_restore=None) -> bytes:
    lines, entries, duplicates, locked, last_group = _kde_entries(data)
    if set(values) & (duplicates | locked):
        raise ProxySettingsError("KDE 代理配置包含重复或锁定的键，已停止修改。")
    replacements = {}
    missing = []
    for key, value in values.items():
        entry = entries.get(key)
        if entry is not None:
            if value is None:
                replacements[entry["index"]] = ""
            elif raw_restore is not None and raw_restore.get(key) is not None:
                replacements[entry["index"]] = raw_restore[key]
            else:
                old = entry["raw"]
                ending = "\r\n" if old.endswith("\r\n") else "\n" if old.endswith("\n") else ""
                replacements[entry["index"]] = old.split("=", 1)[0] + "=" + value + ending
        elif value is not None:
            missing.append(f"{key}={value}\n")
    for index, replacement in replacements.items():
        lines[index] = replacement
    if missing:
        if last_group is None:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            if lines and lines[-1].strip():
                lines.append("\n")
            lines.extend(["[Proxy Settings]\n", *missing])
        else:
            insertion = last_group + 1
            while insertion < len(lines) and not re.match(r"^\s*\[", lines[insertion]):
                insertion += 1
            if insertion and lines[insertion - 1] and not lines[insertion - 1].endswith("\n"):
                lines[insertion - 1] += "\n"
            lines[insertion:insertion] = missing
    # A restored original final line may have had no newline.  If another
    # program appended settings meanwhile, retain the necessary separator.
    last_nonempty = max((index for index, line in enumerate(lines) if line), default=-1)
    for index in range(last_nonempty):
        if lines[index] and not lines[index].endswith("\n"):
            lines[index] += "\n"
    return "".join(lines).encode("utf-8", "surrogateescape")


class DesktopProxyManager:
    def __init__(self, config_dir: Path | None = None, runner=None, *, state_dir: Path | None = None):
        self._isolated = config_dir is not None
        self.config_dir = Path(config_dir) if config_dir is not None else Path(
            os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
        )
        self.config_dir = self.config_dir.expanduser().absolute()
        self.state_dir = Path(state_dir) if state_dir is not None else self.config_dir / "modeldock-network"
        self.journal_path = self.state_dir / "system-proxy-recovery.json"
        self.kde_path = self.config_dir / "kioslaverc"
        self.runner = runner or subprocess.run
        self._token = uuid.uuid4().hex
        self.last_conflicts: tuple[str, ...] = ()
        self.last_warning = ""

    def detect_backend(self) -> str:
        desktop = (os.environ.get("XDG_CURRENT_DESKTOP", "") + ":" + os.environ.get("DESKTOP_SESSION", "")).lower()
        if "kde" in desktop or "plasma" in desktop:
            return "kde"
        if "gnome" in desktop or "unity" in desktop or "cinnamon" in desktop:
            return "gnome"
        return "unsupported"

    @property
    def describe(self) -> str:
        return {"kde": "KDE Plasma 系统 HTTP/HTTPS 代理", "gnome": "GNOME 系统 HTTP/HTTPS 代理"}.get(
            self.detect_backend(), "当前桌面不支持自动配置系统代理"
        )

    @property
    def is_applied(self) -> bool:
        try:
            journal = self._read_journal()
            return bool(journal and journal.get("owner_token") == self._token)
        except ProxySettingsError:
            return False

    @contextmanager
    def _locked(self):
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (self.state_dir / "system-proxy.lock").open("a+b") as stream:
            os.chmod(stream.name, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def _read_journal(self):
        if not self.journal_path.exists():
            return None
        try:
            journal = json.loads(self.journal_path.read_text(encoding="utf-8"))
            if not isinstance(journal, dict):
                raise ValueError("journal must be an object")
            if journal.get("version") != 1 or journal.get("backend") not in ("kde", "gnome"):
                raise ValueError("unknown journal format")
            allowed = set(KDE_KEYS) if journal["backend"] == "kde" else {"|".join(key) for key in GNOME_KEYS}
            if not isinstance(journal["expected"], dict) or not isinstance(journal["before"], dict):
                raise ValueError("invalid settings snapshot")
            if set(journal["expected"]) - allowed or set(journal["before"]) != set(journal["expected"]):
                raise ValueError("unexpected settings keys")
            if not all(isinstance(value, str) for value in journal["expected"].values()):
                raise ValueError("invalid applied values")
            if journal["backend"] == "kde":
                if any("\n" in value or "\r" in value for value in journal["expected"].values()):
                    raise ValueError("invalid KDE value")
                if not all(value is None or isinstance(value, str) for value in journal["before"].values()):
                    raise ValueError("invalid original KDE entries")
                base64.b64decode(journal["original_file"], validate=True)
                if not isinstance(journal["original_exists"], bool) or not isinstance(journal["original_mode"], int):
                    raise ValueError("invalid original file metadata")
                if not isinstance(journal["applied_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", journal["applied_sha256"]):
                    raise ValueError("invalid applied file digest")
            elif not all(isinstance(value, str) for value in journal["before"].values()):
                raise ValueError("invalid original GNOME values")
            return journal
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ProxySettingsError("代理恢复记录损坏，未覆盖现有系统设置。") from error

    def _save_journal(self, journal):
        _atomic_write(self.journal_path, json.dumps(journal, ensure_ascii=True, indent=2).encode("utf-8"))

    def _run(self, command):
        env = os.environ.copy()
        env["XDG_CONFIG_HOME"] = str(self.config_dir)
        if self._isolated:
            env["GSETTINGS_BACKEND"] = "keyfile"
        try:
            completed = self.runner(command, capture_output=True, text=True, timeout=8, check=False, env=env)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ProxySettingsError(f"无法执行桌面设置命令：{command[0]}") from error
        if completed.returncode:
            # Do not include values or stderr: existing settings may contain secrets.
            raise ProxySettingsError(f"桌面设置命令失败：{command[0]}（{completed.returncode}）")
        return completed.stdout.strip()

    def _gget(self, key):
        return self._run(["gsettings", "get", *key.split("|", 1)])

    def _gset(self, key, value):
        self._run(["gsettings", "set", *key.split("|", 1), value])

    def _notify_kde(self):
        try:
            self._run([
                "dbus-send", "--session", "--type=signal", "/KIO/Scheduler",
                "org.kde.KIO.Scheduler.reparseSlaveConfiguration", "string:",
            ])
        except ProxySettingsError:
            self.last_warning = "系统代理配置已写入，但桌面刷新通知未发送；部分程序可能需要重新打开。"

    @staticmethod
    def _validate_endpoint(host, port):
        host = str(host).strip()
        if host.lower() != "localhost":
            try:
                if not ipaddress.ip_address(host).is_loopback:
                    raise ValueError
            except ValueError as error:
                raise ProxySettingsError("系统代理只允许指向本机回环地址。") from error
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ProxySettingsError("本地代理端口必须为 1 到 65535。")
        return host, port

    def apply(self, host, port) -> None:
        host, port = self._validate_endpoint(host, port)
        self.last_conflicts, self.last_warning = (), ""
        with self._locked():
            pending = self._read_journal()
            if pending:
                if pending.get("owner_token") == self._token:
                    if pending.get("endpoint") == [host, port]:
                        return
                    raise ProxySettingsError("请先断开当前代理，再更改本地监听地址。")
                if _owner_alive(pending):
                    raise ProxySettingsError("另一个运行中的实例正在管理系统代理。")
                self._restore_journal(pending)
            backend = self.detect_backend()
            if backend == "unsupported":
                raise ProxySettingsError(self.describe)
            journal = {
                "version": 1, "backend": backend, "endpoint": [host, port],
                "owner_pid": os.getpid(), "owner_start": _process_start(os.getpid()),
                "owner_token": self._token,
            }
            if backend == "kde":
                self._apply_kde(journal, host, port)
            else:
                self._apply_gnome(journal, host, port)

    def _apply_kde(self, journal, host, port):
        if self.kde_path.is_symlink():
            raise ProxySettingsError("kioslaverc 是符号链接，请手动配置系统代理。")
        existed = self.kde_path.exists()
        original = self.kde_path.read_bytes() if existed else b""
        mode = stat.S_IMODE(self.kde_path.stat().st_mode) if existed else 0o600
        _, entries, _, _, _ = _kde_entries(original)
        url_host = f"[{host}]" if ":" in host else host
        expected = {
            "ProxyType": "1", "httpProxy": f"http://{url_host} {port}",
            "httpsProxy": f"http://{url_host} {port}", "ftpProxy": "", "socksProxy": "",
            "NoProxyFor": "localhost,127.0.0.1,::1", "ReversedException": "false",
        }
        updated = _kde_edit(original, expected)
        journal.update(
            expected=expected, before={key: entries[key]["raw"] if key in entries else None for key in expected},
            original_file=base64.b64encode(original).decode("ascii"), original_exists=existed,
            original_mode=mode, applied_sha256=_digest(updated),
        )
        self._save_journal(journal)  # Durable recovery data precedes settings changes.
        try:
            current = self.kde_path.read_bytes() if self.kde_path.exists() else b""
            if current != original:
                raise ProxySettingsError("KDE 设置正在被其他程序修改，请重试。")
            _atomic_write(self.kde_path, updated, mode)
        except Exception:
            self._restore_journal(journal)
            raise
        self._notify_kde()

    def _apply_gnome(self, journal, host, port):
        expected = {
            "org.gnome.system.proxy|mode": "'manual'",
            "org.gnome.system.proxy|ignore-hosts": "['localhost', '127.0.0.0/8', '::1']",
            "org.gnome.system.proxy.http|host": repr(host),
            "org.gnome.system.proxy.http|port": str(port),
            "org.gnome.system.proxy.http|use-authentication": "false",
            "org.gnome.system.proxy.https|host": repr(host),
            "org.gnome.system.proxy.https|port": str(port),
            "org.gnome.system.proxy.ftp|host": "''",
            "org.gnome.system.proxy.socks|host": "''",
        }
        before = {key: self._gget(key) for key in expected}
        journal.update(expected=expected, before=before)
        self._save_journal(journal)
        try:
            # Populate endpoints before enabling manual mode.
            for key in list(expected)[1:] + ["org.gnome.system.proxy|mode"]:
                self._gset(key, expected[key])
            if any(self._gget(key) != expected[key] for key in expected):
                raise ProxySettingsError("GNOME 未接受完整的代理设置。")
        except Exception:
            self._restore_journal(journal)
            raise

    def restore(self) -> None:
        with self._locked():
            journal = self._read_journal()
            if journal is None:
                return
            if journal.get("owner_token") != self._token and _owner_alive(journal):
                raise ProxySettingsError("另一个运行中的实例正在管理系统代理。")
            self._restore_journal(journal)

    def recover_pending(self) -> bool:
        with self._locked():
            journal = self._read_journal()
            if journal is None or (journal.get("owner_token") != self._token and _owner_alive(journal)):
                return False
            self._restore_journal(journal)
            return True

    def _restore_journal(self, journal):
        self.last_conflicts = ()
        if journal["backend"] == "kde":
            self._restore_kde(journal)
            self._notify_kde()
        else:
            self._restore_gnome(journal)
        self.journal_path.unlink(missing_ok=True)
        if self.last_conflicts:
            self.last_warning = "部分系统代理设置已被其他程序更改，已保留这些更改。"

    def _restore_kde(self, journal):
        if self.kde_path.is_symlink():
            raise ProxySettingsError("kioslaverc 已变为符号链接，恢复记录已保留。")
        current = self.kde_path.read_bytes() if self.kde_path.exists() else b""
        if _digest(current) == journal["applied_sha256"]:
            if journal["original_exists"]:
                _atomic_write(self.kde_path, base64.b64decode(journal["original_file"]), journal["original_mode"])
            else:
                self.kde_path.unlink(missing_ok=True)
            return
        _, entries, duplicates, locked, _ = _kde_entries(current)
        conflicts = {
            key for key, value in journal["expected"].items()
            if key not in entries or entries[key]["value"] != value or key in duplicates | locked
        }
        # A user changing an endpoint may intend to keep manual mode. Do not
        # switch their new proxy off merely because ProxyType still equals 1.
        if conflicts:
            conflicts.add("ProxyType")
        values = {}
        for key in journal["expected"]:
            if key in conflicts:
                continue
            original_line = journal["before"][key]
            values[key] = None if original_line is None else original_line.split("=", 1)[1].rstrip("\r\n").strip()
        restored = _kde_edit(current, values, journal["before"])
        if restored != current:
            mode = stat.S_IMODE(self.kde_path.stat().st_mode) if self.kde_path.exists() else journal["original_mode"]
            _atomic_write(self.kde_path, restored, mode)
        self.last_conflicts = tuple(sorted(conflicts))

    def _restore_gnome(self, journal):
        current = {key: self._gget(key) for key in journal["expected"]}
        conflicts = {key for key, value in journal["expected"].items() if current[key] != value}
        mode_key = "org.gnome.system.proxy|mode"
        if conflicts:
            conflicts.add(mode_key)
        # Disable/change the mode before replacing endpoints, unless a user has
        # taken over the configuration while the application was connected.
        keys = [mode_key] + [key for key in journal["expected"] if key != mode_key]
        for key in keys:
            if key not in conflicts:
                self._gset(key, journal["before"][key])
        self.last_conflicts = tuple(sorted(conflicts))
