from pathlib import Path
import hashlib

root = Path(__file__).resolve().parent.parent
phone = root / 'termux'
source = phone / 'src'
output = phone / 'termux-hotspot-proxy.sh'
parts = [(source/'install-prefix.sh').read_text()]
for name in ('proxy.sh', 'monitor.py', 'address.py', 'README.md', '验证记录.txt'):
    content = ((phone if name in ('README.md', '验证记录.txt') else source)/name).read_text()
    marker = '__HOTSPOT_PROXY_' + name.replace('.', '_').replace('-', '_').upper() + '__'
    assert marker not in content
    parts.append(f'cat > "$DESTINATION/{name}" <<\'{marker}\'\n{content.rstrip()}\n{marker}\n')
parts.append((source/'install-suffix.sh').read_text())
output.write_text('\n'.join(parts))
output.chmod(0o755)
print(f'{output.name}: {output.stat().st_size} bytes, SHA256 {hashlib.sha256(output.read_bytes()).hexdigest()}')
