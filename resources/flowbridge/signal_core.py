# SPDX-License-Identifier: GPL-3.0-or-later
"""Fixed native signal entry for isolated/embeddable CPython (no cwd imports)."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from windows.native import signal_core
if __name__=='__main__':
    if len(sys.argv)!=2 or not sys.argv[1].isdigit(): raise SystemExit('Invalid owned core PID')
    signal_core(int(sys.argv[1]))
