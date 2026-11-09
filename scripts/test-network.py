# SPDX-License-Identifier: GPL-3.0-or-later
"""Run isolated protocol, OS-fixture, recovery and phone-script tests."""
import os
from pathlib import Path
import subprocess
import sys
root=Path(__file__).resolve().parent.parent/'resources/flowbridge'
env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1')
folders=['windows']
if sys.platform.startswith('linux'): folders=['linux','windows','tools']
for folder in folders:
    subprocess.run([sys.executable,'-m','unittest','discover','-s',folder,'-p','test_*.py'],cwd=root,env=env,check=True)
subprocess.run([sys.executable,'-m','unittest','discover','-s','tests/network','-p','test_*.py'],cwd=root.parent.parent,env=env,check=True)
