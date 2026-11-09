# Bundled sing-box component

FlowBridge's Debian package includes the unmodified official sing-box 1.14.4 executable. FlowBridge itself provides the GUI, configuration generation, lifecycle management and monitoring.

- Upstream: https://github.com/SagerNet/sing-box
- Exact release: https://github.com/SagerNet/sing-box/releases/tag/v1.14.4
- Corresponding source: https://github.com/SagerNet/sing-box/tree/v1.14.4
- Source archive: https://github.com/SagerNet/sing-box/archive/refs/tags/v1.14.4.tar.gz
- License: GNU General Public License v3.0; see THIRD-PARTY-LICENSE-sing-box.txt, copied unchanged from the exact upstream source archive, including its copyright notice.
- Archive URLs and SHA-256 checksums are pinned in tools/tun-core.json in the FlowBridge source bundle. tools/fetch_tun_core.py verifies the official archive before extracting its executable.
- Build tags and dependency versions can be inspected with `sing-box version` and the upstream go.mod/go.sum for this release.

The FlowBridge release directory also provides the exact upstream source archive next to the binary package. No sing-box source modification is made by FlowBridge. A source build requires the upstream Go toolchain and dependencies documented by upstream.
