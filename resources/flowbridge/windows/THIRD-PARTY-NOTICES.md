# FlowBridge Windows third-party components

FlowBridge 0.5.5 is GPL-3.0-or-later. The complete FlowBridge source snapshot is distributed as `FlowBridge-source-0.5.5.zip` alongside the Windows portable package.

## sing-box 1.14.4

The unmodified official Windows executable is used. Its archive checksum is pinned in `tools/windows-core.json` and checked before extraction. The included `LICENSE-sing-box.txt` is the upstream GPL license and copyright notice.

- Release: https://github.com/SagerNet/sing-box/releases/tag/v1.14.4
- Corresponding source: https://github.com/SagerNet/sing-box/tree/v1.14.4
- Source archive: https://github.com/SagerNet/sing-box/archive/refs/tags/v1.14.4.tar.gz
- Build instructions: https://sing-box.sagernet.org/installation/build-from-source/

## Wintun 0.14.1

The official signed `wintun.dll` is copied unchanged from the official archive. Its complete license is included as `LICENSE-wintun.txt`. The official archive hash is pinned in `tools/windows-core.json`. Wintun's prebuilt signed binaries use the license included in that archive; do not substitute a driver compiled or signed by a different party.

- Project and official download: https://www.wintun.net/
- Source: https://git.zx2c4.com/wintun/

## Python, PyQt6, Qt and PyInstaller

The Windows package includes a CPython runtime, PyQt6 6.12.0, Qt 6.12.0 and PyQt6-sip 13.13.0, and uses the PyInstaller 6.22.3 bootloader. Applicable notices available in the installed upstream distributions are copied into subdirectories of `licenses/`; the Python license is included separately. `build-info.json` records the actual runtime and component versions.

- Python source and licenses: https://www.python.org/downloads/source/
- PyQt6 source distributions: https://pypi.org/project/PyQt6/6.12.0/#files
- Qt source: https://download.qt.io/official_releases/qt/6.12/6.12.0/single/
- SIP source distributions: https://pypi.org/project/PyQt6-sip/13.13.0/#files
- PyInstaller license and bootloader exception: https://pyinstaller.org/en/stable/license.html

These are separate upstream projects. Their names identify dependencies and do not imply endorsement of FlowBridge.
