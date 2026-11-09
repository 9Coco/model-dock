# ModelDock 手机热点代理

电脑连接手机热点后，手机在 **同一端口**提供 HTTP 与标准 SOCKS5 TCP/UDP 代理。在电脑的 ModelDock 中选择 **“服务工作台 → 网络接管 → 全局流量”**，普通 TCP/UDP 应用无需逐个配置代理。手机 VPN 和热点仍须开启，VPN 须允许 Termux 使用对应 TCP/UDP 出口。

## 安装或从旧版更新

把新版 `termux-hotspot-proxy.sh` 传到手机 Download，在 Termux 执行：

```bash
# 首次访问 Download 需执行并完成 Android 存储授权
termux-setup-storage
bash ~/storage/downloads/termux-hotspot-proxy.sh
```

旧版仅 HTTP 的脚本必须更新。默认安装完成后只重启本脚本管理的 GOST，以应用新服务；保留已有代理端口、保存的手机 IP、自启动开关及其他设置，不结束其他程序。

新安装默认端口 **38473**，监控接口为手机本机 `127.0.0.1:19090`。已有配置保留端口，可用 `--port` 显式覆盖，例如：

```bash
bash ~/storage/downloads/termux-hotspot-proxy.sh --port 38473
bash ~/storage/downloads/termux-hotspot-proxy.sh --no-start
```

`--no-start` 不启动或重启服务；若旧进程仍运行，稍后执行 `hotspot-proxy restart`。`--extract 目录` 只解出源码，不安装或启动。

安装器按需通过 `pkg install` 获取 GOST3.x、Python、util-linux、coreutils。管理命令为 `$PREFIX/bin/hotspot-proxy`，配置和状态在 `~/.local/share/termux-hotspot-proxy/`。普通代理不需要 root，不建立第二个 Android VPN。

## 启动与管理

```bash
hotspot-proxy start
hotspot-proxy info
hotspot-proxy monitor
hotspot-proxy restart
hotspot-proxy stop
hotspot-proxy logs
hotspot-proxy autostart off
hotspot-proxy autostart on
```

新交互 Termux 会话按已保存偏好自动启动。监控中 Ctrl+C 只退出监控，代理继续运行。默认会申请 Termux wake lock；已有代理正常运行时，再执行 `hotspot-proxy start` 或新会话自动启动也会重新申请，保留原进程和连接。配置中 `WAKE_LOCK=0` 时不申请。命令缺失或申请失败会显示警告，代理继续运行；命令成功只表示已发出请求，不代表已验证唤醒锁持续有效。

唤醒锁不能替代手机系统允许 Termux 后台运行、关闭针对 Termux 的电池优化，以及手机 VPN 的后台和联网设置。若仅在切回 Termux 后恢复，应结合进程和网络状态检查这些设置；脚本仍不保证 Android 在锁屏、省电或清理后台后持续转发。停止代理不释放其他 Termux 任务共用的唤醒锁。

异常退出可能遗留 `state/gost-api.sock`，使旧脚本报 `bind: address already in use`。新版启动时会在管理锁内探测该接口，仅清理当前用户所有、明确拒绝连接且检查期间未变化的 socket；仍在使用的接口、普通文件、软链接或无法确认的错误均保留并提示。

## 找到正确手机地址

电脑连接手机热点后，打开 ModelDock 的 **“服务工作台 → 查询热点地址”**，选择热点的网关候选。若手机使用自定义端口，请修改上游代理地址中的端口并保存，再点击“连接”验证。

手机脚本列出的接口候选、历史手动 IP 不保证当前仍可连接。Android 可能限制接口查询；电脑连接普通路由器时查到的是路由器，不能当成手机地址。

手动显示地址只影响提示，不改变出站路由：

```bash
hotspot-proxy set-ip 10.15.60.93
hotspot-proxy set-ip auto
```

示例 IP 不保证当前可用。HTTP 与 SOCKS5 共用同一地址端口；全局模式需要 SOCKS5 TCP 与 UDP，旧 HTTP-only 服务不会被当作全局能力已就绪。

## 电脑使用

打开 ModelDock 首页的“网络接管”，选择“全局流量”，填写手机 IP 与代理端口并保存，然后点击“连接”。Linux 请使用 ModelDock 的 deb 版并在首次连接时完成系统授权，Windows 请以管理员身份运行。启用前会验证 TCP 及经手机中继的 UDP DNS 往返，失败时检查脚本版本、VPN UDP策略、热点及动态 UDP relay 端口是否被系统阻挡。

HTTP 模式可使用同一端口。在 ModelDock 首页的“网络接管”选择“HTTP 代理”，遵循系统代理设置的应用会通过手机连接。

## 上传与下载监控

电脑客户端从自身内核读取 TCP/UDP 上下行。手机端的 `hotspot-proxy monitor` 统计本脚本服务，口径不等于手机网卡、VPN封装后或运营商计费流量。

已实测 GOST3.3.0 的原始 Prometheus UDP方向与TCP相反。本脚本启用同服务的TCP基线，通过私有 `state/gost-api.sock` Unix API校正混合计数；无额外TCP管理端口或常驻采集进程。API位于权限700的应用目录内。

该方向校正仅在已验证的 GOST3.3.0 启用；其他版本暂不显示未经验证的上下行，明确提示，但不影响转发。可以在 ModelDock 首页的“网络工具”中查看电脑端计数。繁忙时 API 与 metrics 的读取不是原子的，监控会标记近似采样及误差界，不承诺每次采样逐字节一致。

## 访问与验证边界

代理未设置电脑 IP 白名单或认证；能访问手机该端口的设备可以使用服务，沿用原有本地热点用途。统计接口只监听手机回环，管理API只在私有Unix socket，不对热点公开。

真实 GOST3.3.0 的 HTTP、SOCKS TCP/UDP、混合计数及 Linux 内核互通已在本机回环/隔离网络验证；未在真实 Android 手机升级并验证 VPN UDP出口、锁屏保活、热点重开或省电策略。手机脚本的测试范围见随附的 [验证记录](验证记录.txt)。
