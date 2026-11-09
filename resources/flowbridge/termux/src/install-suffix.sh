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
echo '手机同一入口支持 HTTP / SOCKS5 TCP+UDP；电脑在流桥中选择“接管全局流量”。'
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
