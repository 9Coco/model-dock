# ModelDock · FlowBridge 整合与验收

## 来源与许可证

基线：ModelDock `d320d9ce4e1284b075471a609ec1934f87b00593`，FlowBridge
`f80139e040ca51cd0e7036659b350e692b9c495c`（Linux 0.4.4 / Windows 0.5.5）。
整合前阅读了 ModelDock AGENTS.md、CONTRIBUTING.md、SECURITY.md，FlowBridge 根目录、
Linux、Windows、Termux README、Windows 验证/性能记录及第三方声明。FlowBridge 没有
单独的 AGENTS.md/CONTRIBUTING.md。

MIT 与 GPL-3.0-or-later 可以组合，但不能把 GPL 部分改标 MIT。组合发行版为
GPL-3.0-or-later；原 ModelDock 的 MIT 文本逐字保存在 LICENSE-MIT，原有图标的
Apache/MIT/CC-BY/品牌条款不变。没有打包 PyQt/Qt GUI。sing-box、Wintun、CPython
各自保留许可。固定来源、原始/修改后 SHA-256 和修改说明见
resources/flowbridge/manifest.json、THIRD_PARTY_NOTICES.md。

## 结构与数据保留

默认首页「服务工作台」提供模型网关、接口与模型和请求日志。侧栏的「网络接管」页提供代理配置、连接与恢复、流量统计和检测工具。前端通过窄 preload 的
`runtimeSnapshot()` 读取两个服务的运行状态。实时刷新仅取内存中的服务状态，供应商、
模型及日志沿用配置快照。切换菜单时复用同一网络会话。主进程管理
模型网关和网络设置、串行连接/模式切换/退出、自动连接和历史。GPL Python 标准库组件只处理 OS 网络事务、
TCP 字节转发和公开网站检测，没有账号/推理 API。所有账号仍使用原 TypeScript Gateway，
不会把账号 Token、模型请求参数、MCP 或工具配置交给网络组件。网络子进程仅继承 OS
必需环境，不继承 API Key 环境变量。转发监听和 core 管理 API 均为回环，管理密钥不进 UI。

账号授权、模型目录和网关上游请求共用主进程的 `ApplicationNetworkSession`。用户在设置中
显式填写的应用代理优先。留空且已连接 HTTP 代理时，新请求通过当前会话的本机转发
端口访问上游。全局模式或正常断开后使用系统网络规则。若转发意外中断，应用会阻止新请求
使用旧端口，直到恢复完成或用户指定了可用的应用代理。临时转发端口仅保存在内存中。

ModelDock appId、userData、SQLite schema、加密、供应商、模型、绑定、app.settings 和
历史表不变。新设置使用 `network.flowbridge.v1`；恢复门禁为 `network.flowbridge.lease`；
小窗状态为 `network.mini.v1`。网络文件在 ModelDock 数据目录的 `network/`，24 小时
历史最多 1440 个分钟样本，另有内存 60 秒样本，只记录字节/速率/时间。它不是模型 Token
用量功能。Windows 快速 DNS cache 另存域名与虚拟地址映射，正常断开保留映射。

不迁移、删除或覆盖独立 FlowBridge 的旧配置、历史、启动项。系统服务和恢复文件使用
ModelDock 独立命名，Linux 接口为 modeldock0、Windows 为 modeldock-net；Windows 的
sing-tun GUID 匹配值也按新接口名重新计算。路由保留区、Windows 会话互斥继续拒绝冲突，
不允许两个 TUN 客户端争用网络。

## 功能与平台边界

| 功能 | 整合行为 |
| --- | --- |
| HTTP 代理 | KDE/GNOME 系统设置或 Windows WinINet；回环字节转发、有限缓冲、半关闭和计数；按所有权恢复，保留外部并发修改 |
| 全局 TCP/UDP/DNS | 固定 sing-box 1.14.4；TCP 与标准 UDP/DNS 往返预检；Linux root-owned 固定协议服务、Windows Wintun/Job；无直接出口回退 |
| 模式/地址/解析切换 | 显式修改已连接会话时，先确认旧网络已恢复，再保存并连接新配置 |
| 自动连接 | 默认关闭，复用 ModelDock 登录启动，最多等待上游两分钟；遗留恢复门禁存在时不自动连接 |
| 网站检测 | Google/YouTube/GitHub/ChatGPT/Cloudflare，系统套接字与指定代理两条路径并行，每条最多 20 秒、有限重试、浏览器挑战独立标识 |
| 热点候选 | 只读默认网关供用户选择，不把网关发现当作代理可用性检测 |
| 流量小窗 | 同一 Electron 生命周期，拖动、锁定、展开曲线、隐藏、双击主窗口；保存位置并纠正离屏 |
| 手机端 | 随包保留 Termux 源码和安装器，UI 导出后在手机手动执行，保留原手机 HTTP/SOCKS5/UDP、地址查询、监控与启动功能 |

从 0.4.1 起，ModelDock 的 deb 同时安装桌面应用、sing-box、固定路径的权限助手、
systemd 单元及 Polkit 策略。全局模式使用 root 所有的系统组件，首次连接经系统授权
启用当前用户的 systemd socket。服务同时校验连接者的 UID 和 root 所有的授权记录，撤销授权后会结束已有会话并清理网络。单独运行 AppImage 可使用 HTTP 模式，需要全局模式时
请使用 deb 版。Linux 全局上游需填写远端数值 IP。Windows x64 包附 CPython、core 和官方签名 Wintun；
全局需管理员启动，HTTP 可普通用户运行。本机 SOCKS5 必须通过监听者/进程路径防循环
检查，拒绝 ModelDock 自身、未知/活跃接口、转发网卡等冲突。

保留 ModelDock 原普通用户登录启动方式，未自动替换成管理员计划任务，所以 Windows
登录后的全局自动连接需要目标系统权限验收。小窗是统一 Electron 悬浮窗，并非 Explorer
内嵌工具栏；本次未移植 FlowBridge Windows 独有的任务栏自动隐藏/全屏避让逻辑。
用户名密码代理、订阅链接、ICMP、独立网络空间/虚拟机、第三方 VPN 更具体路由和特殊
绑定设备不保证支持。系统路径成功、代理出口成功、真实模型推理是不同的验证结论。

## 退出与恢复

连接前写恢复门禁，取消在同一队列中执行恢复。原生 TUN 启动或系统授权还在等待时，
取消也需等受控清理；不会杀特权助手。桌面代理先恢复再关闭监听，TUN 必须确认清理。
失败保留会话/恢复记录，阻止新连接；退出失败保留主窗口、Gateway、数据库供重试。

Electron EOF 请求网络组件清理；独立管道守护恢复桌面代理，Linux root helper 与
Windows Job 保留原崩溃保护。全局另有 marker，异常重启后显式“断开 / 恢复”调用
仅恢复协议，不启动新 TUN。未知/损坏所有权记录拒绝覆盖。强杀、断电后的真实路由、
DNS/WeakHostSend 恢复必须在目标系统验收，不能只以进程退出为证据。

## 0.4.0 云端验证（2026-11-09）

全部操作在 Codex Cloud Linux 完成，没有连接或依赖用户本机。npm ci 使用公开锁文件。
官方 release 下载超时后通过同一官方 release asset API 取回相同文件并验证原固定
SHA-256，没有跳过校验。Electron UI 使用临时合成资料和 QA 入口；云端 QA 的显式
`--ci-no-sandbox` 不改变生产应用沙箱。最终检查结果如下（跳过项不计为通过）：

| 检查 | 结果 |
| --- | --- |
| `npm run build` / TypeScript / Vite / Electron 主进程 | 通过；Vite 仅提示现有大 chunk |
| `npm test` | 121 个文件，2732 通过、6 跳过 |
| `npm run test:network` | Linux 210、Windows fixture 86、工具 31、整合 9 通过；14 跳过（Windows 原生 API、可选真实 GOST） |
| `npm run verify:production` | 通过；QA/开发入口未混入生产包 |
| `npm run network:verify` | 53 个来源文件哈希、GPL/MIT 声明、小窗账号 API 隔离通过 |
| Electron 云端 GUI | 亮/暗主题网络页、小窗、模式保存、布局、原资料保留通过；QA 引擎阻止 OS 网络修改 |
| Linux x64 | 主程序 deb、同版权限助手 deb、目录包构建并核对内容；未安装权限助手 |
| Windows x64 | 跨平台目录包构建；原有包验证器确认图标、版本、生产入口、ASAR integrity；Python/core/Wintun 字节与已校验来源一致 |
| 对应源码归档 | `npm run source:archive` 生成当前源码包；不含依赖、核心二进制、配置、凭据或数据库 |

总计 **3068 个自动化测试通过，20 个跳过**。数据保留回归使用真实 SQLite 存储接口，
比较已有供应商、密钥与绑定；退出失败回归确认保留会话和恢复门禁。网站检测覆盖断开后
重新检查时使用新的取消状态，避免上一次取消污染下一次检测。GUI 的合成数据与图片
保存在构建工作目录，不包含用户数据。

0.4.0 验收时使用的历史构建命令如下。当前版本构建 Linux deb 使用 `npm run dist:deb`。

```sh
npm run network:prepare -- linux
npm run network:prepare -- win32
npm run network:helper
npm run build
npm run verify:production
npm run network:verify
# Cloud 中使用已校验、解压的官方 Electron，避免重复下载
ELECTRON_BUILDER_CACHE=/tmp/modeldock-builder-cache npx electron-builder --linux deb -c.electronDist=node_modules/electron/dist --publish never
npx electron-builder --win dir --x64 -c.electronDist=work/electron-win -c.win.signAndEditExecutable=false --publish never
node scripts/finalize-windows-cloud.mjs
node scripts/verify-windows-package.mjs release/win-unpacked
npm run source:archive
```

Windows 目录包未签名，未制作/执行原生 Windows portable 安装包；AppImage 本轮未构建。
最终 Python 适配器修复后同步进两个目录包，再以 `--prepackaged release/linux-unpacked`
重建 deb，并核对 deb 内的清单与源文件。原有 `pack:win` 保留原生 Windows 构建路径。

明确未实测：

1. Linux systemd/Polkit 首次授权、拒绝/取消、真实 TUN/DNS/路由和崩溃恢复。已尝试
   隔离命名空间验收，启动即报 `unshare: cannot open /proc/self/uid_map: Read-only file system`。
   没有在宿主网络裸跑测试，也未改云端系统代理和默认路由。
2. Windows 原生 UAC、Wintun 驱动加载、WinINet、真实网卡、Job/WeakHostSend 恢复、
   管理员登录后的自动连接与实际应用出口。跨平台打包/注入 API 测试不证明这些行为。
3. 真实手机热点/VPN/Termux 的 TCP/UDP/DNS 全链路、Android 保活、公网网站可用性、
   长期吞吐稳定性、IPv6/局域网/其他 VPN 冲突。
4. 真实供应商账号授权/推理；原 ModelDock 回归使用合成上游。

## 0.4.2 Windows x64 原生复核（2026-11-09）

检查范围为本机从 `d320d9c` 拉取到 `7ea8d51` 的三个提交及本轮修复。系统为 Windows
build 26300，目录包使用 Electron 44.5.1、嵌入式 CPython 3.12.10 和 sing-box 1.14.4。

| 检查 | 本机结果 |
| --- | --- |
| 测试与构建 | TypeScript、Vite、主进程构建、生产入口检查及网络来源哈希通过。最终 Vitest 全量回归使用 4 个 worker，2690 通过、52 跳过。Windows 网络专项 110 通过，1 个 Linux 桌面用例跳过。 |
| 原生网络组件 | Windows IP Helper 读取、Job 子进程生命周期、固定内核的回环 SOCKS5 TCP/UDP 和 DNS 测试通过。WinINet 实际读取成功。包内 HTTP 转发验证了 CONNECT 预检、双向字节、半关闭和计数，代理写入与恢复使用临时文件后端。 |
| 管道与监听 | 包内 Python 返回的中文错误能经 UTF-8 解码。Windows 已占用的本地 HTTP 转发端口拒绝第二个监听者。 |
| 构建与运行库 | 已在嵌入式 Python 正运行时重新准备依赖。开发入口和正式包分别读取源码树与发行目录中的网络组件。正式包内 CPython 文件逐项匹配固定哈希的官方压缩包。 |
| 界面 | Windows Electron 的网络页通过亮暗主题和 780、980、1320 像素宽度检查。小窗在工作区右下角展开后仍完整可见。界面的连接、取消和恢复使用模拟引擎。 |
| 正式包退出 | 在隔离资料关闭「关闭到托盘」后，原实现在收到 Windows 原生关闭消息后记录了退出，但主进程等候 15 秒仍未结束。将退出请求移到关闭回调之后，复测主进程正常退出，退出码为 0。 |

本轮未改动主机的 WinINet 代理、默认路由或 DNS。管理员全局接管仍需验证实际 Wintun
加载、整机流量、异常后的路由恢复、重启自动连接及真实手机热点。多显示器摆放尚未实测。

## 当前版本分发

Linux 完整安装仅需一个 `model-dock` deb。Windows 完整目录保留 flowbridge/python、
core、Wintun 与许可证。源码包与二进制一同提供，构建不安装或启动系统网络服务。Windows
cloud 构建必须标为交叉目录构建，不宣称原生执行验证。
