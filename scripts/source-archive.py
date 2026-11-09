# SPDX-License-Identifier: GPL-3.0-or-later
"""Archive tracked/current source, never local profiles, dependencies or cores."""
from pathlib import Path
import hashlib,json,subprocess,zipfile
root=Path(__file__).resolve().parent.parent
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
output=root/'release'/f'ModelDock-source-{version}.zip';output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as bundle:
    for name in sorted(set(paths)):
        if not name:continue
        path=root/name
        if not path.is_file() or path.is_symlink():continue
        if name.startswith(('work/','release/','node_modules/','.git/')):raise RuntimeError('Unexpected source file')
        bundle.write(path,'model-dock/'+name)
print(output,hashlib.sha256(output.read_bytes()).hexdigest())
