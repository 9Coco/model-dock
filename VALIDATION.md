# ModelDock 验证记录

## 2026-11-11 / 0.4.23 · 全局流量直连白名单

- 全局模式支持 32 个单独的 IPv4 或 IPv6 地址。新旧配置均可读取，空名单沿用旧助手通信格式。无效地址不会中断当前连接。已连接时保存会按既有顺序恢复路由再重连。HTTP 模式会保存但不使用名单。
- 真实 sing-box 1.14.4 在隔离 Linux 网络命名空间运行。内核查路由确认列出的 IPv4、IPv6 目的地址经物理侧网卡，未列出的相邻地址仍经 TUN。正常退出、核心和助手异常终止后的路由清理均通过。32 条地址也通过异常恢复测试。
- Electron 网络页面在 XWayland 验证了无效输入、IPv4/IPv6 保存、清空、跨模式保留和已连接时重连。原生 Wayland 截图阶段停滞。TypeScript 全量回归 2,860 项通过，3 项跳过。Python 网络回归共 393 项，17 项跳过。生产构建和资源校验通过。Windows 为模拟和静态包验证，未做原生系统路由验收。

## 2026-11-10 / 0.4.22 · 流式失败、私有配置写入与崩溃恢复

- 通用 Gateway 的流式错误、无效 JSON、上游截断及缺失结束事件均失败：输出前返回 502，输出后销毁连接；终止帧在完整验证后才发送。Chat 多 choice 需全部完成，其他 choice 的增量仍及时转发。非流式 Responses 汇总按累计事件限制约 32 MiB。逐字节 UTF-8/CRLF、超大网络块包含多小帧、单帧超限、命名 SSE 错误及超限后取消上游均有回归。
- 活跃流的非空数据刷新空闲计时器，持续超过原总时长仍可继续；无数据或客户端背压下到达空闲限额会取消原始上游 reader。超限请求体立即暂停并关闭连接，不再等待读完上传。测试使用本地回环与合成数据，没有真实推理调用。
- 系统网络清理失败仍保留重试退出的机会；确认系统清理后，本地资源逐项处置，某个 dispose 或诊断失败不阻止其余资源和最终退出。同步/异步抛错均经故障注入验证。
- 私有原子文件写入覆盖 Claude、Junie、Copilot CLI、DSH、JetBrains、统一撤销、还原及三种导出。写入秘密前设置私有权限；Windows 设置仅当前用户与 SYSTEM 的受保护 DACL，重命名遭短暂锁定时有界重试。现有宽松文件会收紧；符号链接、目录联接、硬链接目标拒绝写入。Windows ACL/重试为命令 mock 与写入时序验证，未做 Windows 原生文件系统验收。
- Claude、Junie、Copilot CLI 使用加密 pending 日志，记录实际提交顺序；显式同步、还原与撤销先恢复，外部修改保留并阻止覆盖。Junie 首次恢复写入前后再次失败的测试确认，先恢复默认模型再移除模型配置，保留可重试的事务。旧 Claude/JetBrains 明文备份仅在显式操作时转为加密备份，新操作不再生成明文 .bak。
- 自动连接失败只回退本 attempt 的地址，保护用户新端点与其他设置；数据库写盘失败恢复内存并保持原磁盘内容，临时库先 fsync 再替换；MCP 锁安全竞争接管已确认死亡的本机 owner，并限制恢复链长度。旧空锁、活 PID 或未知主机 owner 保守拒绝写入。清理与主操作同时失败时保留原始错误。
- 本地 Skill 导入 IPC 不接受路径参数，只使用系统选择对话框返回的目录；取消/空选择和直接传入路径均有回归。OAuth invalid_grant 仅对身份一致、已被新刷新凭据替换的账号重读并最多重试一次；跨账号、取消及迟到成功结果不覆盖新授权。
- 验证：`npm run typecheck`、`npm test`（129 文件、2,836 通过、3 跳过）、`npm run build`、`npm run verify:production`、`npm run network:verify` 全部通过；`npm run test:network` 共 384 项、17 跳过。network-only 与默认综合 Electron 验证通过，包含窄 preload、配置/Skill/MCP 集成与本地 mock 请求。未修改真实账号、工具配置或运行中的应用；未进行真实供应商、重启电脑或原生 Windows 验收。

## 2026-11-09 / 0.3.91 · TRAE 真实工具请求与本机代理排查

- 实际单变量测试确认，同一 TRAE CN 账号的 Kimi-K3 纯文字、文字加 high 推理强度都能生成；附加对象形式的 `function.parameters` 就返回空体 HTTP 400。只将该字段编码为 JSON 字符串后，上游接受请求并返回正常 SSE。此前引用的 TraeCode helper 与真实 Raw v2 工具 schema 存在差异，0.3.90 的模拟测试没有验证到这个接口约束。
- 修复函数 schema 字符串编码及 assistant 历史的原生 `function_call` 字段，完整保留 schema、参数文本、调用 ID 和结果关联。用相同生产 TS 适配器、只读客户端导入及合成提示完成真实 Kimi-K3 两轮验证：第一轮返回 `read_file` 调用及预期的合成路径，第二轮接收模拟工具结果并正常回答，四次目录/推理网络响应均为 HTTP 200。没有执行文件工具，未保存提示、回答或授权材料；报告为 `work/trae-live-tool-roundtrip-result.json`。该验证使用 Node 传输，不代表已操作 VS Code 窗口完成端到端验收。
- 真实上游还会在回答前发送非对象的 `progress_notice` 排队通知。现保留通知后的流，只有真实输出和结束事件齐全才标记成功；结构化错误、截断和取消继续失败。通过本机现有 `http://127.0.0.1:20081` 代理再次验证带工具定义的 Kimi-K3 请求成功，包含排队通知后正常输出与结束。
- 对正在运行的 ModelDock、当前 VS Code 已配置的工具专属入口做真实流式计时，没有另起网关。长中文合成请求：约 2.666 秒出现首段正文，19.223 秒最后正文，288 段正文分布于 52 个不同到达时刻；正常 finish 与 DONE 完整。短问候请求：正文 12 段、51 个字符，从 3.333 秒到 3.942 秒，约 0.609 秒完成。仅记录时间、段数和长度，未保存生成文本或密钥。报告为 `work/trae-stream-timing-long-result.json`、`work/trae-stream-timing-short-result.json`。本机 Copilot 0.73.0 的链接渲染器按空白分词；用安装版本原始类的隔离合成测试确认，中文逗号、句号不刷新，遇换行或最终 flush 才输出积累文本。项目与客户端配置均未关闭 streaming，本次没有为显示效果改写正文或增加人为延时。
- Windows PAC 对 JetBrains AI 和账号域返回 DIRECT。无凭据模型目录请求经当前环境代理返回空体 451，经用户现有本机 HTTP 代理 `127.0.0.1:20081` 返回正常未授权 401；官网根路径相应返回 404。不能仅凭 451 就断定账号或许可证失效。当前应用未暴露可用调试入口，因此没有修改真实应用代理；需在设置保存上述已有代理并刷新。未完成 JetBrains 真实账号目录、额度或推理验收。
- 四个 TRAE 专项文件 73 项全部通过。完整 Windows 回归 2728 项：2635 通过、38 失败、55 跳过；38 个失败名称与修复前 HEAD 的隔离基线完全相同，没有新增失败。结果与对照分别为 `work/trae-0.3.91-tests.json`、`work/trae-0.3.91-baseline-comparison.json`。类型检查、生产构建与去测试代码检查通过。
- 旧 `release/win-unpacked/ModelDock.exe` 被运行中的应用锁定，而受限进程枚举返回零；首次打包因此失败。打包脚本增加独占共享锁检查，不能确认旧包可替换时使用独立输出，不停止用户应用。最终 Windows 包位于 `release/windows-0.3.91-2026-11-09T05-10-48-355Z-33800/win-unpacked`，主进程、资源/许可、SQL WASM、图标、ASAR 完整性校验全部通过。此独立路径为本次有效的新包，常规目录未同步。生产 main SHA256 `2ee3c70bc2eeb9c01fad65324ec070afa9661ee1bf833974056f41d3dba52ea0`。

## 2026-11-09 / 0.3.90 · TRAE Copilot 请求与 JetBrains 网络错误

- 核查本机 VS Code 内置 Copilot 0.73.0：自定义 Chat 端点的 `thinking:true` 会自动发送 `max_completion_tokens`；`thinking:false` 会移除自动输出预算，推理强度选项独立保留。TRAE 原生连接仅向 VS Code 投影这项客户端设置，并用 `modelOptions` 的空采样值抑制默认采样；保存的全局模型、外部反代和其他来源不变。需要显式重新同步 VS Code 配置并重新加载窗口。
- 核查本机 TRAE CN 3.4.16 原生模块：Raw v2 没有输出预算与采样控制字段，继续拒绝显式的未支持参数，不把它们静默丢弃。新目录使用 `reasoning_effort_config` 原始选项及 `reasoning_effort_level`；旧目录使用原始 `reasoning_effort`，支持 `xhigh`、`max`，不虚构档位别名。兼容对象与有界 JSON 字符串形式的目录声明。现有 Gateway 回归覆盖 VS Code 请求形状、原生工具、首段流式输出、取消和截断错误。
- 只读本机诊断确认 JetBrains AI 的目录、额度和导入请求实际返回 HTTP 451；原账号异常包装令界面误显示 HTTP 401。API、账号、目录、连接测试和网关现在保留真实状态，提示检查应用网络代理。请求已接入统一 Electron session 代理；实际 451 连接仍需可访问该服务的网络来源。本轮未更改用户账号、代理或 VS Code 配置，未完成真实模型推理验收。
- 受影响的 9 个测试文件共 491 项全部通过；类型检查、生产构建和生产入口去测试代码检查通过。完整 Windows 回归共 2718 项：2625 通过、38 失败、55 跳过；失败明细保存在 `work/trae-jetbrains-fix-tests.json`。从修改前 HEAD `57adb62d562a811573d0fcd1c9c0a24c122db86a` 创建独立基线，复跑失败的全部 12 个文件，454 项中 401 通过、38 失败、15 跳过；失败测试全名与当前 38 项完全一致，未新增失败。对照记录为 `work/trae-baseline-57adb-comparison.json`，涉及文件链接权限、Linux 启动项 fixture 及旧 Central Pi 场景，不能记为全量通过。
- Windows x64 `npm run pack:win` 成功，更新 `release/win-unpacked`。主进程、资源、许可、SQL WASM、图标及嵌入 ASAR 完整性检查通过；生产 main SHA256 `6a3dea87f95131da5670d0bcb0e9b80232d12f5296edcebfa2b75b0c65708ee5`。原生 VS Code 界面与真实上游接受情况需在重新同步后单独验收。

## 2026-11-09 / 0.3.89 · 模型列表过期后的批量添加

- 0.3.88 本机诊断确认目录获取成功后 11 分钟首次提交，9 次添加都在主进程的 10 分钟目录有效期检查处被拒绝，未写入任何 TRAE 模型。
- 使用隔离的 Linux Electron、模拟供应商和注入的目录时钟，勾选 8 个模型并编辑名称和别名，模拟经过 11 分钟后点击添加。主进程自动获取一次新目录，实际 SQLite 保存且重开后显示同一批 8 项，编辑内容和原工具绑定验证通过。长列表底部的错误与成功提示均可见。
- 主进程回归覆盖刷新时模型失效、网络失败后重试、换号/改配置、并发提交和写入前的编辑锁。完整测试通过 2679 项，跳过 6 项。


## 2026-11-09 / 0.3.88 · TRAE 中国版模型目录与推理

- 在 Linux 上用同一 TRAE CN 账号核对官方目录。仅把两个协议版本头从 20260212 更新为客户端 3.4.16 实际使用的 20261029，官方返回的配置就从 44 条增至 61 条，本机 Chat 菜单 18 个内置模型的精确路由从 3 项增至 18 项。
- 官方目录与账号身份共同确认本账号可添加 17 项。Kimi-K3.1-Pro 受限，网关在推理前拒绝该请求。通过主进程适配器向普通 Kimi-K3 发送非流式短请求、向 Qwen3.8-Flash 发送流式短请求，两者都返回 OK，后者正常完成流。其他 15 项可添加模型核实至目录和账号权限。
- Electron 发现弹窗回归覆盖 18 项、17 个可选以及锁定原因。全量测试 2671 项通过、6 项跳过。生产构建和 Linux deb 已校验，Windows x64 目录包的 PE 资源、ASAR 完整性、主进程和界面内容已静态校验。


## 2026-11-08 / 0.3.87 · 移除独立终端功能

- 删除设置页的终端区块、终端选项类型/默认值、平台启动逻辑、preload/IPC 接口和诊断操作入口。实际 CLI 工具接入与模型的工具调用能力保留。旧版 `app.settings` 的 `terminal` 字段仅在读取时忽略，不在启动时重写；下次显式保存时剔除旧字段，其他设置和启动项所有权记录继续保留。
- 类型检查、`npm run build`、生产入口去测试代码检查通过。三种旧终端偏好的兼容用例、默认设置、偏好保存、退役字段拒绝和 Windows 启动项行为等受影响用例通过。完整 `npm test -- --maxWorkers=2` 实际执行：2661 项中 2296 通过、310 失败、55 跳过，不能记为全量通过；失败仍包含本机 HTTP 连接/文件链接权限限制、Linux 启动项 fixture 及其他已有场景，完整结果为 `work/terminal-removal-final-tests.json`，未将未逐项核验的失败统一归为环境问题。
- Windows x64 `npm run pack:win` 成功，更新 `release/win-unpacked`，未停止用户应用。生产入口、资源/许可、SQL WASM、图标和嵌入 ASAR 完整性校验全部通过。额外直接核对包内主进程、preload 和 renderer JS：不含 `openTerminal`、`terminalOptions`、首选终端或打开终端内容，包内主进程与本次构建逐字节相同；main SHA256 `038414052290b1f7e77e8a349d91557807e47348d94889f599c750f764bd9d51`。
- Electron 实际界面专项已尝试，但运行时退出前未生成 `electron-smoke.json` 或截图，因此未获得原生界面验收；日志 `work/terminal-removal-ui.log`。本轮未改真实账号/外部客户端设置，没有云端查询或模型生成，Linux 原生界面和真实供应商未重测。

## 2026-11-06 / 0.3.86 · Windows 适配补充检查

- 检查本轮 Linux 新增的当前/历史模型筛选、TRAE 客户端模型缓存和额度、JetBrains 多许可证及多厂商协议。TRAE 缓存在 Windows 使用 APPDATA，缺省回退到 AppData/Roaming，保持精确账号与 CN/SOLO 产品边界；JetBrains 仍走已有 Windows Registry64 只读账号导入和 APPDATA 许可证路径。未引入额外反代进程或监听端口。
- 补充 TRAE Windows 缓存回归：CN/SOLO 两种产品、中文及空格路径、忽略 Linux XDG 路径、漫游目录缺省值、无效/不存在 APPDATA 不回退、源数据库字节不变。文件符号链接用例复用实际权限探测；不具备权限时明确跳过，非绝对路径拒绝独立执行，不再被符号链接创建失败遮挡。
- 新功能专项 13 个测试文件通过：361 项通过、1 项因文件符号链接权限不足跳过，0 失败。覆盖新许可证目录/解码、授权生命周期、Grazie 桥和签名、TRAE 可见性/缓存/额度等；证据 `work/windows-review-focused.json`。类型检查、生产构建和生产入口去测试代码检查通过；最终再次用 TypeScript CLI 核验通过。
- 完整 `npm test` 已执行，但本轮不能记为通过。默认临时目录的 Vitest 缓存重命名先遇到 EPERM；将 TEMP/TMP 指向项目内隔离测试目录后，初次全量为 2290 通过、313 失败、54 跳过（118 文件）。可见阻碍包括本机 HTTP 连接 EACCES、junction/hardlink 创建 EPERM 和设置保存失败；完整日志保留在 `work/windows-review-tests.log`，不能将未逐项核验的失败都判为产品缺陷或全部归为环境问题。后续专项包含本次修复与新增用例，不能替代全量网关验收。
- Windows x64 `npm run pack:win` 成功，常用交付目录 `release/win-unpacked` 已更新。生产入口、许可证/图标资源、SQL WASM、可执行文件图标及嵌入 ASAR 完整性全部通过；生产 main SHA256 `71e981efac959bd0e310430d6c96cb6ab8e234108edcdf0816120c9cfbbc702f`，与本版 Linux 生产主进程构建一致。打包前未发现运行中的 ModelDock，没有停止用户应用。
- 实际 Electron 历史模型界面专项尝试未产出页面报告；独立运行本机 Electron 44.5.1 `--version`（未加载 ModelDock）也以 `0x80000003` 退出，未输出版本或错误正文，因此未获得 Windows 界面/预加载启动验收。当前权限不能读取 Windows Application 事件日志，尚不能确定该运行时退出的具体原因。未更改界面布局；没有使用真实账号凭据、云端查询或模型生成。本轮未重跑 Linux 原生验证。

## 2026-11-06 / 0.3.86 · 订阅当前 / 历史模型

- 五类订阅共用默认关闭的「显示历史模型」开关，关闭时只显示明确 current；历史与 unknown 只在勾选后显示，并采用不同标识。未知状态不冒称已与客户端完全一致；搜索、全选、批量参数和提交均受可见且可导入集合限制，不在切换时重新请求。重开/切换来源恢复默认；已有历史模型、参数、账号与绑定保留。
- Codex 采用官方 List / Hide / None 可见性或 app-server hidden；Grok 采用官方 hidden / _meta.hidden 默认值；Copilot 采用 Chat/Responses 能力和 model_picker_enabled，不将内部补全/工具模型作为当前聊天候选。OAuth 不误用 API-Key 专属 supported_in_api 筛选。本地用户隐藏和实验开关不冒称已同步。
- JetBrains 依据已安装 2026.2 官方 Junie ModelOption 非弃用的精确 jbaiId（不把 nativeId 当别名），与官方账号可用 Chat 档案对应。同名 Bedrock 等额外通道归为客户端未展示，仍保留完整真实路由；复合模式、专用 Agent 和没有通用接口的功能不伪造为可调用模型。
- TRAE 的 native 默认批量 fusion 目录实际仍复用 batch_get_detail_param，已从公开客户端序列化和 URL 结构确认。只读实测旧 GetDetail / BatchDetail 目录与客户端当前清单不同，不能仅按版本名或 is_invisible_to_user 声称完整同步。实现按已导入的精确 CN/SOLO 产品及账号，在固定只读 state.vscdb 内读取 chat_v3 内置模型快照；不枚举其他账号，不回退另一产品，不返回 ak/sk/base_url，不改源文件。
- 本机最终只读核对：当前18项与用户 TRAE 截图一致；其中3项有已核实的直连配置，15项仅作为客户端当前条目展示并明确「暂不支持添加」。历史19项，合计37项。2个个人 BYOK 不纳入订阅发现。不存在的 providerId 不猜测，未核实条目不进入真实路由；源授权与模型缓存哈希不变，模型生成0次。单模型列出不等于全部模型推理通过。
- 主进程才可设置可信可见性和不可添加标记；普通 HTTP 模型字段不能伪造该合同。添加不可用新模型的整个批次原子拒绝，已有模型跳过并保持不变；历史筛选不缩减完整路由缓存，不将显示状态写进 Store。
- 最终完整118个测试文件通过：2651项通过、6项按条件跳过。类型检查与生产构建通过；Linux原生专项13张截图覆盖五类来源、980深色/1180浅色、18当前/19历史/37总项的实际清单形状、15不可添加行、未知状态、搜索/批量/提交边界与旧模型绑定保留。生产入口额外检查并剔除新QA工厂、专用环境标记与合成密钥；最终main SHA256 `71e981efac959bd0e310430d6c96cb6ab8e234108edcdf0816120c9cfbbc702f`。
- Linux amd64 Deb的40个生产资源与构建一致，解包ASAR/WASM/ELF逐项相同、98项MD5通过；实际Wayland隔离启动、app.ready和单实例检查通过，启动错误0。ASAR SHA256 `dd029a82514b5451ed1a6380483e3ffed576e9112e5991e0d624271263928fa4`；Deb SHA256 `082ee803537a395a2dc0b2d40da4b7fc5bae73040d1474c24abbd664b5ac0a5f`。
- 本版的真实网络验证仅限 TRAE 只读目录，其余来源依据当前官方协议/本机公开 SDK 与模拟目录；没有重做真实模型生成，也没有验证 Windows 本机运行。未安装或停止用户应用。

## 2026-11-06 / 0.3.85 · 订阅额度重置提示

- 按用户澄清，“opencode”指 Codex。重置提示仅在 Codex / Grok 显示；Copilot、TRAE CN、JetBrains AI 的列表及详情隐藏相应倒计时、未知时间与次数提示，空时间列保留布局锚点且不暴露 tooltip / 可访问文本。
- 许可证到期日、TRAE 积分包到期日/分笔到期、余额、查询时间和手动查询按钮保留；未修改主进程解析、重置数据、查询调度、账号、模型或工具绑定。
- 完整116个测试文件通过：2605项通过、6项按条件跳过。类型检查、生产构建和去测试代码检查通过；Linux原生专项53张截图、1920/1180/980宽度与明暗主题均通过。验证列表和详情的重置显示规则，独立有效期、手动查询、后台原始时间戳与紧凑对齐合同保留。最终Deb内40个生产资源与构建一致，ASAR/WASM/ELF解包一致、98项MD5通过；实际Wayland隔离启动与单实例通过，启动错误0。main指纹`33b0ad0bdfcc4712e5689760a3570a3701bb74a132333f9f7064e1041d9285b1`，包SHA256`930b7dd398c2f6ab74ff8f0396944408315fae441dc5d1be7040da0096110e4f`。本轮不读取真实账号，也不发起供应商查询或模型生成；未安装或停止用户应用，Windows运行未验证。

## 2026-11-06 / 0.3.84 · JetBrains 全部个人许可证与套餐核验

- 原因已定位：旧导入器只读取 IDE 当前选中的许可证，额度 DTO 本身又没有套餐名称，因此其他许可证没有独立来源、套餐保持未知。新实现查询官方 AIPU / AIP / AIPEAP / AIF 目录，先验证当前来源的所选许可证，再按账号与精确许可证 ID 去重；同一许可证跨产品重复返回采用官方 AIPU > AIP > AIPEAP > AIF 顺序，身份、类别或到期字段冲突时拒绝，不重复建立来源或计算额度，不按积分量推断套餐。
- 单一已确认账号一键导入全部可用个人许可证；每证独立保存授权、官方套餐、脱敏标识、到期时间与额度。已有对应来源精确复用，其他许可证、Central 来源、模型及工具绑定不被覆盖；多账号、身份不完整及工作区歧义继续要求选择。刷新只更新当前许可证，目录失败保留上次核验名称及时间，成功但无精确匹配时清除旧名称；迟到结果受修订和取消保护。
- 协议依据安装的官方公开 SDK。只读目录使用 `clientVersion=22`、产品版本 `2026200`、`buildDate=20260716`，调用方仍标识为 ModelDock。合成 RSA / XML 样本由官方 Z 解码器与 x 序列化器独立交叉验证，严格限制体积、XML 深度和节点；不移植 IDE 的离线激活运行时。生产路径仅使用主进程 TypeScript，无 JVM、外置反代或额外监听。
- 最终完整回归为116个测试文件，2605项通过、6项按条件跳过；包含 JCP 目录令牌归属未核实则明确不支持、不回退的回归。Linux 原生 Electron 许可证专项通过，21张截图覆盖一键五证、三个独立 Free、账号来源选择、部分失败、套餐/脱敏标识/到期、明暗宽窄布局及已有模型和绑定保留；共用额度布局专项53张截图、1920/1180/980宽度与明暗主题全部通过。新增许可证尾号与到期日合为额度下的一行，单额度账号行恢复58px，保留原64px上限及五类订阅的共同对齐锚点。
- 经用户授权，使用最终生产 API 完成只读官方查询，确认同一账号的五张个人许可证及各自额度；每证模型目录均返回59个兼容Chat档案，此项不代表全部模型推理已验证；以下为本次查询快照，保留官方原始金额精度：

  | 官方套餐 | 独立许可证数 | 每证剩余 / 总额（AI Credits） | 许可证到期日 |
  | --- | ---: | ---: | --- |
  | AI Ultimate | 1 | 3,074,611.8 / 3,500,000 | 2027-03-14 |
  | AI Pro | 1 | 979,411.88 / 1,000,000 | 2027-01-08 |
  | AI Free | 2 | 300,000 / 300,000 | 2027-08-15 |
  | AI Free | 1 | 300,000 / 300,000 | 2026-12-03 |

- 本轮真实查询模型生成次数为0，源客户端写入次数为0；未激活或领取试用。现场验证记录不含完整许可证 ID、账号身份、令牌、原始 XML 或资产正文。新 JCP 用户管理目录令牌的归属尚未核实时明确不支持，不将推理令牌冒充目录令牌，也不把 Junie Lite / 工作区当作个人许可证。Windows 未进行本版的本机运行验证；未安装或停止用户应用。类型检查、最终生产构建和去测试代码检查通过；生产 main 指纹`7183653d5d030c8f004bb401b4abe3f58f92bf9c44795e63d0a8319f0f14ab8a`。最终 Linux amd64 Deb 的40个生产资源与本次构建逐字节匹配，ASAR/WASM/ELF解包比对相同，98项MD5全过；ASAR SHA256为`ccb36a28e895c38df6db3f9679935517a9537583da7bb2cf35252a433f64752f`，Deb SHA256为`1740a896dc2f86ccb4e51eea6bd9f96f7df068ab74b0e822c26c15a71638f7f0`。最终包的实际Wayland隔离启动、app.ready及单实例检查通过，启动错误0；仅关闭测试实例。

## 2026-11-06 / 0.3.83 · 授权中心上下结构统一

- 按用户截图将TRAE CN / JetBrains AI的展开式卡片统一为与上方订阅相同的紧凑账号行；共享头像/账号/套餐、额度、时间/刷新/菜单的布局。去除正常账号行的大段导入说明，将完整来源、状态和当前额度身份保留在详情，账号设置可由操作菜单进入。
- 以总可用1813.80积分、两组额度和20笔详情的合成数据验证展示精度与未知/过期语义；不合并当前额度账号与历史导入账号，不改主进程查询或任何账号/模型/密钥/绑定记录。
- 验证使用隔离演示账号和本机模拟服务，检查五类订阅同时存在时的实际Electron布局、1920/1180/980窗口与浅深主题、菜单和详情、金额/来源语义、更新与错误状态、横向溢出和数据保留。完整114个测试文件全过，2538项通过、6项按条件跳过；类型检查、生产构建及去测试代码检查通过。五类订阅共同布局专项53张截图全过，JetBrains一键导入/来源详情专项15张截图全过，刷新、金额/明细、当前与历史身份分离、菜单设置及配置/密钥保留均通过。已查看1920深色、980深色与1180浅色截图。
- 旧compact综合脚本的账号相关浅深主题、两宽度、菜单、取消、重置及刷新阶段通过；后续设置页停在既有Material图标数量下限12的断言。本版未修改产品图标，该断言保持不变，不能把该综合脚本记为全部通过。既有12个工具品牌资源检查改为精确集合，仍验证所有品牌SVG/图片，不再把旧Junie分组顺序当成图标完整性要求。
- Linux amd64 Deb包内40个生产资源与构建一致，解包ASAR/WASM/ELF相同、98项MD5全部匹配；main生产指纹`15f474f2d0bc1359586c4b590ae785503b550cb4d971a134f5ed3943841e7c52`。包SHA256为`1bc55bf0ea62c5376da4409f618a5e67f3494c824e2e2ce48e906caab9facfdb`，最终包实际Wayland启动、app.ready及单实例检查通过，启动错误0；只关闭隔离测试实例，未安装或停止用户应用。
- 本轮没有读取真实客户端授权、访问官方额度或发起模型生成；真实模型调用验证沿用0.3.82独立记录。

## 2026-11-06 / 0.3.82 · 网络恢复后的完整验证与连接预算

- 网络恢复后，0.3.81完整host测试114文件、2523项通过、6项跳过；包括此前未能重跑的32项网关集成。类型检查、生产构建及去测试代码检查通过，main指纹仍为`2f7ef39d1c5df907cb9196085f3c7ab5aaabcb04ec5548fb85204142552dae10`。已将核验补丁写回原项目，保留用户其他记录与配置。
- 经用户继续测试的明确授权，只读当前同一账号/个人许可证，官方授权和目录均HTTP200，返回59个兼容Chat档案。Claude `anthropic-claude-4-5-haiku`以64-token上限实测通过，2字符可见输出、finish=stop、原生end与兼容DONE完整，首字节约868ms。
- Gemini `google-gemini-3-0-flash`的64-token小预算请求返回200及Content/Finish/Quota/end但未通过可见输出完整性校验；当次未保留原生content长度与finish reason，不把预算原因认作已证事实。随后仅对Gemini作一次256-token针对性极短验证，同一代码成功：2字符可见输出、原生finish=stop与end、兼容DONE完整，首增量约1598ms、总约1624ms；原生附带672字符思考签名，仅在内存中处理，证据只保存类型及长度。未保存提示/回复/令牌正文，未修改IDE、PasswordSafe或源令牌，也未发送真实工具调用。
- 为减少产品内连接测试的预算误判，JetBrains原生来源的测试预算由16提高到256，同时采用模型较低的明确输出上限；不更改普通客户端推理预算、不自动重试。新增15项预算回归，最终114个测试文件全部通过：2538项通过、6项按条件跳过。类型检查、生产构建与去测试代码检查均通过，最终main指纹为`bca6438133829e46455e1b251097e4c48b3d9e495bb0360306fa9a6d947df579`。
- 0.3.81最终包的实际Wayland生产启动与单实例验证已通过，无启动错误，ASAR生产指纹与已测源码匹配。0.3.82最终包已核对40个生产资源文件与源码构建一致，Deb解包ASAR/WASM/ELF相同、98项MD5全部匹配；实际Wayland生产启动与单实例验证通过，无启动错误。安装包SHA256为`c4f948774d6385fd105971efb377e965ceff5ca1c94e1160412c5b4617765b9a`，未安装或关闭用户应用。

## 2026-11-06 / 0.3.81 · JetBrains 多厂商模型主进程适配

- 修复 IDE 导入只发布 OpenAI / Azure 档案的问题。按已安装官方 2026.2 Grazie V9 Profile / Chat 的实际序列化契约，为 Anthropic、Google、Bedrock、xAI 等官方 Chat 档案接入统一 V9 API；保持 OpenAI 原路径与上游模型 ID 映射。新 V9 路由使用授权 profile ID，不将厂商模型 ID 冒充 profile ID，不按截图手工列出模型。
- 官方公开类 / serializer 合成样本依据保存在本次 work/jetbrains-vendors-evidence；协议研究和模拟测试不读取真实账号或发送官方推理；另经用户授权的现场查询与极短实测在下文单独记载。V9 tools 根据 tool role 与 toolConfig.tools 双重声明，图片根据明确 MIME 声明；参数未声明时保持未知。工具历史不透明签名只在主进程内按账号令牌、profile 和历史范围严格匹配，限制数量、体积与期限，并只在成功终态及 EOF 后保存。
- 新增测试覆盖多厂商目录、真实 V9 JSON / SSE、工具调用往返与签名隔离、增量及时性、取消、请求限制、无效终态及失败脱敏。首次完整运行114个测试文件全过，2507项通过、6项跳过；之后根据官方源码补齐 `data: end`、未知 metadata fallback、SDK nullable history、所有 Chat 厂商目录及回归测试，最新纯协议/缓存/API定向110项通过。最新32项本机网关集成测试的两次受控宿主执行均在自动审批阶段超时、未启动；普通权限执行被端口绑定限制挡在fixture初始化，不能记成业务断言通过。此前27项网关集成已通过，不能替代新增版本的最终宿主复跑。
- Linux Electron IDE专项通过（15张截图），Claude / Gemini候选与能力字段正常显示。发现窄窗模型表格的绝对定位辅助标签越过滚动容器，给表格滚动容器设置定位边界后复查，980/1180宽度无文档、主区或弹窗横向溢出；保留一键导入、错误保留、跨IDE同身份去重和真正多许可证选择验证。
- 经用户明确允许“目录和最小调用实测”，只读当前同一账号/许可证，官方授权校验成功。首次目录按当时子集返回46个兼容Chat档案（23 OpenAI、14 Anthropic、9 Google）；官方原目录还包含Bedrock、Xai、vLLM等，因此最终改为按Chat能力而非厂商白名单发布V9档案。每类仅一次64-token上限极短流调用，Haiku与Gemini都在读取流时失败；没有保存请求/回复正文或任何令牌。随后核对官方 `UtilsKt.isEnd`，确认遗漏的原生 `data: end` 结束帧并补回归，但首次未保留部分增量计数，不能断言这已解释全部现场失败。
- 用户再次明确允许各复测一次。两次执行尝试均在自动审批阶段超时、命令未运行；普通权限替代验证在授权网络请求阶段即被网络限制拒绝，未发出模型调用、未再消耗生成额度。故当轮真实Claude/Gemini生成尚未确认；网络恢复后的成功实测见0.3.82记录，不能把目录、模拟测试或配置写入记为真实推理通过。源IDE与源令牌均未修改或刷新。脱敏证据在本次work的 `live-jetbrains-vendors-result.json` / `live-jetbrains-vendors-retest-result.json`。
- 能力边界：V9 暂不适配独立 reasoning / thinking 事件，显式扩展思考预算与无法表达的历史会拒绝，不把展示思考伪造成原生签名；图片仅内嵌，不自动访问远程地址。不同来源的目录不等于真实套餐所有权限，配置写入也不等于 IDE 接受推理。

## 2026-11-06 / 0.3.80 · 订阅来源默认显示名称统一

- 按用户要求统一五类订阅：Grok 订阅、GitHub Copilot 订阅、Codex 订阅、TRAE CN 订阅、JetBrains AI 订阅。预设与新账号导入采用同一组默认名称，不再附加客户端/IDE/Central导入字样。
- 仅对对应订阅类型的已知历史自动名称提供显示别名，保留自动数字后缀和自定义名。侧栏title/文字、详情标题/说明、授权分组及名称展示一致；真实账号身份/email/displayName不改。Store/provider.name原值、去重身份、路由、网关owned_by和外部配置名称保持原语义，不进行数据库名称迁移。
- 类型检查、生产构建及去测试代码校验通过；111个完整测试文件全过，2424项中2418通过、6项按条件跳过、0失败。未增加仅复述字符串实现的单元测试；复用原生导航验证检查真实旧名、数字后缀、自定义名及API同名不被改动，并检查所有存储记录/凭据/模型/绑定保持原样。
- 实际Linux Electron导航专项通过（exit0/bridge，17张截图）：五个历史自动名、数字后缀、自定义名和API同名均符合显示规则，侧栏/详情/Auth标题/预设文字一致，所有原始记录与凭据保持原样。已查看980深色TRAE标题及自定义名截图。Linux amd64 deb交付至release和本次outputs；SHA256：`6819db72d511b18764b7eb8efc4a153890d6c5b72245af702473f14adcfec2ee`。包内40个生产文件匹配，Deb解包ASAR一致，正式包Wayland启动/单实例通过；未安装或关闭用户应用。
- 本次验证仅使用隔离合成账号和模拟服务，没有读取真实客户端凭据、发起真实官方请求或修改外部工具配置。证据为本次work下 `subscription-names-tests.log`、`subscription-names-build.log` 及 `subscription-names-native`。

## 2026-11-06 / 0.3.79 · JetBrains 默认一键从 IDE / Air 导入

- 按用户要求将 JetBrains 授权入口改为「从客户端导入」。显式单击即从 IDE / Air 扫描并导入唯一账号/许可证，成功直接更新账号，不显示前置说明框或成功确认框。无来源/服务器拒绝仅提示安全错误，保留现有记录，不尝试另一来源或 Central。
- 新主进程默认导入接口与旧选票导入共用导入锁、关闭/取消保护和票据核验。仅主进程增加账号/许可证指纹，同身份跨 IDE 去重并优先现有来源；不同身份、身份不完整或其他 IDE 有不支持/错配访问来源时要求用户明确选择，避免隐式改用另一份个人许可证。保存前再次读取本机来源，阻止云校验期间换号/换证。
- Central 和原手动预览/导入保留在独立「其他连接方式」。新接口经窄preload桥调用，诊断区分已导入与等待选择，不记录账号标签、候选内容或私有指纹。
- App在开始处理显式导入请求时消费并清除该请求，使用递增ID，离开授权中心清除待办；AuthPanel保留本地防重、busy和迟到结果校验。启动、普通导航、账号轮询均不扫描或导入，回到授权页不重放旧操作。
- 类型检查、生产构建及生产入口去测试代码校验通过。111个完整测试文件全过，2424项中2418通过、6项按条件跳过、0失败；覆盖默认去重、歧义无密钥/API/存储副作用、来源变更、取消/关闭及诊断脱敏。
- 实际 Linux Electron IDE 专项通过，验证单击无弹框、忙碌/重复点击只一次、来源复用、失败保留、真正多许可证才选择、App请求消费不重放及模拟目录/Chat调用。全程合成账号，不读取真实IDE凭据、不连接真实官方账号或发送云端推理。
- 最终IDE专项13张截图覆盖单击成功、忙碌及多许可证选择的明暗宽窄布局；通用Electron全链另通过（exit0/bridge、本机模拟请求200）。Linux amd64 deb交付至 `release/model-dock_0.3.79_amd64.deb` 和本次outputs，SHA256：`2031bed1ef0eb56c0e321d558f874e8461498756ebf51aea39e36d111359249a`。包内40个生产文件逐项匹配，Deb解包ASAR与目录包一致，打包后Wayland正式启动及单实例通过；未安装或关闭用户应用。
- 证据：本次work下 `jetbrains-one-click-tests.log`、`jetbrains-one-click-build.log`、`jetbrains-one-click-native-ide-final/jetbrains-ide-import-validation.json`。

## 2026-11-06 / 0.3.78 · TRAE 官方可用积分规则与真实额度核对

- 用户提供官方用量截图：每日签到1313.80/1900（19笔）、每月赠送500/500、总可用1813.80。经用户明确选择「允许只读查询官方额度」，执行一次只读账号/额度查询；不刷新令牌、不修改源客户端、不发送模型生成。持久化结果仅含允许的数值额度/状态/有效期字段和字段名，不含账号身份、令牌、原始请求或完整上游响应。
- 真实响应含21个权益包：1个Free功能包、20个积分包。其中19笔100积分共用586.1964，剩1313.8036；另500积分包usage为空。14个积分包省略credits_amount。官方本机3.4.15的ICubeUsageService.pRr及CNCommercialService.extractCreditsUsage均明确以usage?.credits_amount??0计算：这批省略值表示未消费，非未知，也不宣称是已证实的protobuf默认值。修复前将它们当未知导致与官网不一致。
- credits按每笔max(limit-used,0)合计，保留精度后格式化两位；真实脱敏字段离线回放确认total2400、remaining1813.8036、20笔明细、显示1,813.80。未再次请求账号。原始脱敏快照未保存group_name/group_type的值，因此真实来源名称不作为本轮现场核验结论；生产代码读取服务端分组名和分组标识，缺失时不按金额、包数或来源ID猜名称。
- 使用独立summary显示总可用，windows按已识别官方来源分组，details保留每笔；积分和快速请求分离，不平均百分比、不重复累加总计。显式null/错误用量、错误上限继续保持未知并向分组/总计传播；不因is_hide/is_last_period删余额。补齐按字段选择原生quota/订阅quota的回退，显式错误值不静默回退。
- 额度到期使用expiresAt并与resetAt分开，任意已知单笔到期触发重新查询且保留退避。TRAE缓存v1/v2升级v3只使旧额度重新查询，已有账号、模型和工具绑定不变。缓存过期的显著总数显示上次可用积分。
- 111个完整测试文件通过，2401项中2395通过、6项按条件跳过、0失败。类型检查、生产构建、生产去测试入口校验和真实脱敏数据离线验算通过。实际Linux Electron X11专项通过（45截图），包含真实parser接收合成21包后的1813.80总数、两组来源、20笔明细、到期文案、未知向总计传播、40项旧回归及980/1180明暗主题布局。最后的陈旧摘要文案/颜色调整经最终构建纳入，未重复整套原生场景。
- Linux amd64 deb交付至 `release/model-dock_0.3.78_amd64.deb` 及本次outputs；SHA256：`6fbffc1a07765f455ee6bb5a43777f904145dbdb2cfd46163610c20f97a1d40a`。包内40个生产入口/界面/许可/图标/WASM文件逐项匹配，Deb解包ASAR/可执行程序与目录包一致；打包后的Wayland正式启动及单实例检查通过。未安装到系统或关闭用户应用。
- 证据位于本次work：`live-trae-quota-shape.json`（脱敏、私有权限）、`trae-quota-observed-replay-verification.json`、`trae-quota-summary-tests.log`、`trae-quota-summary-build.log`、`trae-quota-summary-native-quota/relay-quota-validation.json`。真实模型推理不在本轮验证范围。

## 2026-11-06 / 0.3.77 · TRAE 多额度包解析与界面修复

- 用户真实截图复现授权中心多项积分撑高账号行、文字截断。代码审查确认额度 parser 原先只排除少数终态，没有应用套餐 parser 现有的状态1/3和生效/过期时段校验；界面也没有限制逐包显示数量。截图本身不能证明每个包均已过期，未按编号或金额删包，也未合并不同独立额度。
- 额度和套餐共用当前有效包筛选，查询时点只取一次；按筛选后有效包编号，保留有效的已耗尽、余额未知和不限量额度。TRAE 额度缓存升级v2，旧缓存刷新前显示未查询，不删除加密账号、模型或工具绑定。
- 账号列表仅显示前两项，其余由「查看全部 N 项额度」进入已有账号详情。详情完整显示每项名称/余额/重置信息，可滚动到最后；行内额度名称列扩宽，身份和操作按钮顶部对齐。
- 类型检查、生产构建及生产去测试入口校验通过。111个测试文件全过，2382项中2376通过、6项按条件跳过、0失败。新增包状态/有效期/查询时点/缓存迁移回归；原有网关流式回归保留。
- 实际Linux Electron X11额度专项通过，32张截图覆盖980/1180、明暗主题。40项独立额度仅展示2项且总数准确，零/未知/不限量保持区分，全部详情可读、无横向溢出、可滚动到第40项，刷新减少为2项后入口自动消失；合成资料的供应商、密钥、模型和工具配置不变。
- 一次拟议的本机TRAE授权只读官方额度查询被自动审批拒绝，原因是此请求没有明确授权真实凭据访问；该命令未执行，也未绕过。最终验收采用官方本机公共字段证据、合成账号及本机模拟上游，没有读取真实账号凭据或发起官方请求/模型生成。
- Linux amd64 deb 已交付到 `release/model-dock_0.3.77_amd64.deb` 及本次 outputs。SHA256：`ab0c3a249dd8344b83d5545343c7f280819057ea7a68d76deb9964ab090f3d22`；包内40个生产入口/资源文件逐项哈希匹配，Deb解包的ASAR/主程序与目录包一致。打包后的Wayland正式入口和单实例检查通过；未安装或关闭用户旧版程序。
- 证据：`/home/coco/Documents/Codex/2026-11-06/zu/work/trae-quota-fix-tests.log`、`trae-quota-fix-build.log`、`trae-quota-fix-native-quota/relay-quota-validation.json`。

## 2026-11-06 / 0.3.76 · Linux amd64 deb 交付

- 基于上节已验证构建打包，Electron 44.5.1 Linux x64；不覆盖已有 `release/linux-unpacked` 目录或终止用户应用。安装包同时位于 `release/model-dock_0.3.76_amd64.deb` 与 `/home/coco/Documents/Codex/2026-11-06/zu/outputs/model-dock_0.3.76_amd64.deb`。
- Deb SHA256：`e1ed99709f5c44637750a546560a43ae4f6c570cebd35be02d15776e00636034`。解包后 98 条 MD5 校验全部通过；amd64/version、ELF/权限、启动器、图标、安装维护脚本语法和依赖检查通过。
- ASAR 与当前构建的 40 个入口/界面/许可/图标/SQLite WASM 文件逐项哈希一致；正式入口指纹正确，无测试入口、账号数据或旧 Python/Pi/独立反代资源。ASAR SHA256：`422abaf3e15f1f152dc3af4e4d037cbfde8963e30e4d9203f93a278574b2260b`。
- 打包后的正式 Linux 程序使用空白隔离目录在本机 Wayland 实际启动，`app.ready`、无启动错误、同目录单实例检查通过；测试后仅关闭测试进程。未安装到系统，未执行安装/卸载脚本，未发起真实账号云端推理。
- 证据：`/home/coco/Documents/Codex/2026-11-06/zu/work/linux-package-0.3.76.log`、`linux-package-verification.json`、`linux-packaged-production-launch.json`、`linux-package-delivery.json`；校验文件在本次 outputs 中。

## 2026-11-06 / 0.3.76 · Linux 直接代理架构验证

- 本机 Linux x86_64、Node.js 25.9.0、Electron 44.5.1 验证当前 `da18156` 源码。TRAE / JetBrains IDE / Central 均在现有主进程 Gateway 内运行 TypeScript 适配器；Linux 保留 XDG / Java Preferences / Central 原生程序发现路径，未发现确定的 Linux 生产阻断。
- 修复两处跨平台测试夹具：Central 导出用例改用当前平台绝对路径，并确认失败分支确实调用模拟 runner；三个日志安全竞态用例兼容 Linux `/proc/self/fd` 固定目录路径，保留真实路径边界、竞态已执行及外部文件不被修改的断言。没有修改生产代理逻辑。
- 修复后完整回归：111 个文件全部通过；2368 项中 2362 通过、6 项按条件跳过、0 失败。类型检查、生产构建和生产入口去测试代码校验通过；在原项目再次执行相同检查，更新本机 `dist` / `dist-electron`。
- 实际 Linux Electron 通用全链使用 X11 隔离窗口通过：exitCode=0、bridge=true、本机模拟代理请求 HTTP 200，覆盖工具配置、直连/聚合选择、授权、模型目录、自动同步、撤销和恢复。JetBrains IDE 原生导入、TRAE / Central 客户端导入、套餐/额度三个专项分别通过，保存 12 / 20 / 19 张合成截图；验证失败保留、重复导入、身份切换与凭据脱敏。
- 当前 Wayland 桌面可见窗口的启动、页面就绪与像素读取通过；另直接启动正式生产入口，空白隔离资料目录产生 `app.ready` 且无启动错误，同目录二次启动退出 0、没有重复初始化 Store。截图来自 Electron 内部位图，不能替代 KDE 合成器截图或全部焦点/托盘交互验收。
- 通用 smoke 的隐藏窗口在原生 Wayland `capturePage()` 等待无返回，本次停止该隔离测试并使用 `--x11` 完成全链；生产可见窗口及专用 Wayland 显示探针均通过。该限制属于当前截图验证方式，不据此宣称生产窗口卡死，也未修改桌面或 Chromium 生产配置。
- 所有流程使用合成账号、隔离数据库和本机模拟上游，没有导入用户真实凭据、写入真实客户端配置或发起云端生成。真实 TRAE / Central / JetBrains 授权、模型推理与实际 IDE 对流结束的接受仍需单独验收。旧反代记录缺少原生会话时需重新导入或连接账号；不会自动启动历史反代。
- 本次证据位于 `/home/coco/Documents/Codex/2026-11-06/zu/work/`：`linux-repository-validation.log`、`linux-production-launch.json`、`linux-native-wayland`、`linux-native-general-x11`、`linux-native-ide`、`linux-native-client-import`、`linux-native-quota`。未安装、替换或生成 Linux 发行包。

## 2026-11-05 / 0.3.76 · 所有托管反代统一 TypeScript 网关

- TRAE、JetBrains IDE / Air 与 Central 个人 AI 许可证通过主进程 TypeScript 适配器接入现有 Gateway；Codex / Grok / Copilot 保留原生主进程授权转发。生产入口不再导入或实例化 Docker/Python/Pi/独立 IDE 反代，不再监听 18080/18081；两个历史值仅供账号连接身份兼容，模型调用、目录与连接测试都走适配器。打包不再复制 Pi 扩展或 Python 资源，生产校验拒绝旧实现进入产物。
- Native provider 标记由 Store 私有元数据/预设导出，不能由 renderer ProviderInput 伪造。原生凭据加密保存在主进程，不进入账号视图、API Key reveal、直连配置或日志；工具使用现有网关 URL、别名与本地 Key。旧记录没有原生会话时明确需重新导入，不启动历史服务，也不回退 HTTP 占位地址。
- TRAE 官方 CN 固定 origin 由已安装 3.4.15 的 product.json/公共 JS bundle 确认；模型目录使用当前 GetConfigDetail GET，推理为 LLMRawChatV2 POST。真实 Windows 客户端仅只读查询：发现两个本机来源，所选账号返回 24 个模型、Free 套餐、可识别额度窗口；没有发送模型生成请求。输出证据 `work/native-trae-readonly-result.json` 仅含计数、套餐及状态，不含身份或凭据。
- TRAE 套餐按官方有效 entitlement product_type 解析；未知/过期/查询失败不保留旧套餐。当前 Raw v2 DTO 没有已证实的输出预算字段，未支持的预算、多模态及控制参数会明确拒绝，不默默删除；标准 Claude Messages 必需的预算暂不能宣称兼容。
- Central 依据官方 2.2.0 的一次性 login export/TokenTransfer、OAuth refresh 和原生 wire 协议实现个人许可证接入。只在用户显式预览/连接时读取源 CLI；显式连接派生并保存有期限 Grazie 会话，不保留全账号 refresh token，推理不运行 CLI 或自动重试。工作区/企业/Bedrock/Vertex 未完整核实，明确拒绝且不改用个人身份；到期需重新连接。模型目录保存实际 OpenAI/Anthropic 原生协议。
- 所有工具（含 JetBrains）即时转发正文、推理、函数参数增量及取消，保留背压。JetBrains 原 32 MiB 整段缓存改为计数限制，仅保留有界终态尾帧。首块前的错误返回 HTTP；首块后截断/迟到错误会终止连接且不发布 stop/DONE，不自动重放推理。旧 Koog 对 EOF 的实际 UI 行为仍需原生 IDE 推理验收。
- Windows 实际 Electron：订阅入口 26 张、客户端导入 20 张、套餐/额度 19 张、IDE 12 张功能截图均通过；亮暗980/1180、Pro/套餐未知、自定义名称、重复导入、旧19091外部接口、模型/绑定/密钥保留和脱敏断言通过。证据分别为 `work/windows-native-subscriptions-final3-0.3.76`、`work/windows-native-client-import-final-0.3.76`、`work/windows-native-quota-final-0.3.76`、`work/windows-native-ide-final-0.3.76`。IDE 目录和连接测试直接到合成API，不创建独立listener。
- Windows 通用 Electron 全链通过：`work/windows-native-general-final-0.3.76`，exitCode=0、bridge=true、本机模拟请求200；包括工具接入、授权、模型发现、直连/聚合、自动同步与恢复。真实 TRAE 生成、Central OAuth/推理、JetBrains 原生 IDE 客户端推理和 Linux 原生运行仍未验收；模拟协议和目录成功不等同这些验收。
- 最终完整回归：111 个测试文件，110 通过、1 跳过；2368 项中 2317 通过、51 按平台/能力跳过、0 失败。`work/windows-native-gateway-tests-final-0.3.76.log`；typecheck/build/生产去测试代码校验/Windows x64 资源图标及ASAR校验通过。补齐按provider取消活跃流、native占位URL与网关端口重合、IDE共享授权交换的单/多等待者取消、退出/删除/重导入拒绝迟到写入。IDE生命周期后再次实际Electron专项通过：`work/windows-native-ide-lifecycle-final-0.3.76`。
- 运行中的0.3.75未退出或覆盖；新正式构建为 `C:\Users\Coco\Documents\GitHub\model-dock\release\windows-0.3.76-2026-11-05T15-57-51-208Z-11256\win-unpacked`。交付ZIP含93个文件，每个SHA256与构建一致，ZIP SHA256 `587c4d78906c708b9a8e12f636eb185702304a39246a9d91609560eac8bbca6d`；记录 `work/native-gateway-delivery-0.3.76.json`。完整目录无Python运行库或Pi扩展，生产入口不含历史托管反代实现。


## 2026-11-05 / 0.3.75 · Windows 账号导入与回归修复

- Windows 账号导入改为只读 Registry64 的 HKCU Java Preferences 固定节点及 `idtoken` / `userlogin` / `userid` 三个值，按安装的 IntelliJ IDEA 2026.2.4 build 262.11879.100 / JBR 25.0.4.1 的转换规则解码，再读取 APPDATA 下固定 2026.2 IDE 的当前个人 AI 许可证。保留选择票据、账号/许可证指纹、确认前双重读取、注销/组织工作区拒绝，不修改源注册表、客户端文件或 PasswordSafe。
- 原生固定源只读探测已确认本机账号可预览并重新读取确认许可证，输出仅为状态布尔。独立 JBR 纯转换方法生成包含中文、emoji、大小写、斜线和换行的 golden；合成测试覆盖大小、类型、错误脱敏、路径、换号/换证/注销及 Windows junction。未执行真实官方授权交换、额度查询或付费推理；本地读取成功仍标记为未验证身份断言。
- 授权中心使用主进程已有的系统信息启用 Windows / Linux IDE 导入，其他平台禁用并说明。Windows Electron 专项完整验证空账号、预览、官方服务模拟拒绝、失败保留、重复导入、独立本地密钥、模拟额度/模型/推理与脱敏；12 张合成截图覆盖明暗主题和窄/宽窗口，已人工查看窄窗入口。
- 修复 GitHub CLI 测试目录、PATH 分隔符和 Linux UID 模拟。POSIX 模式断言在 Windows 改查实际 DACL；目录链接使用 junction，静态硬链接与打开后的硬链接替换均实际执行。符号链接权限和打开文件时目录重命名能力独立探测，不能构造的安全场景明确跳过。全量 102 文件：101 通过、1 跳过；2155 项中 2104 通过、51 按平台/能力跳过、0 失败。未把跳过用例称为已验收。
- Windows 侧栏完整原生输入验证通过：拖动、取消、键盘步进、边界、窄窗限制、宽窗恢复、刷新后偏好保留、分类切换和双击重置；16 张截图覆盖两种主题/尺寸及宽度上下界。窗口缩小时按实际页面宽度计算，避免将含 Windows 边框的外窗宽度当作内容尺寸。
- Windows 通用 Electron 全链最终通过（exitCode=0、bridge=true、localhost 请求 HTTP 200）：当前工具入口/导航、明暗主题、布局/弹窗、来源重复提交、模型发现及 401 清理、供应商独立测试模型、授权错误/待确认/取消、剪贴板恢复、Codex 原生目录协议、Grok 授权/网络设置、自动同步、直连与聚合独立选择、精确模型权限、配置备份还原及 DSH 兼容均保留验证。旧测试入口、模式/命名假设和轮询时序已修正；等待基于真实测试计数，未放宽授权/脱敏/备份断言。证据为 `work/windows-fix-general-final-0.3.75`；另有独立 `work/windows-fix-tools-0.3.75` 与 `work/windows-fix-connection-0.3.75` 定向通过。
- 正式包的独立 QA 副本通过相同 IDE 导入专项，生产产物保持原样，证据为 `work/windows-fix-packaged-ide-0.3.75`。ZIP 内 94 个文件逐项 SHA256 与正式构建一致；最终生产 main/preload/renderer 入口与包内内容一致。
- 生产构建/类型检查及 Windows x64 包入口、资源、Pi 扩展、图标和内嵌 ASAR 完整性通过。新构建为 `release/windows-0.3.75-2026-11-05T14-48-02-183Z-5500/win-unpacked`；运行中的 D:\ModelDock-0.3.55 保持运行，未覆盖该目录。
- 证据目录：`work/windows-fix-tests-0.3.75.log`、`work/windows-fix-ide-import-0.3.75`、`work/windows-fix-sidebar-0.3.75`、`work/windows-fix-package-0.3.75.log`。Windows Docker Desktop 的真实容器/授权流程、真实账号云端推理及 Linux 原生回归仍需分别验收。


## 2026-11-04 / 0.3.67 · Copilot CLI 独立接入

- 新增独立 Copilot CLI strict 直连/聚合绑定，与 Copilot app、VS Code 分开。按官方命名来源格式合并 providers.json 的 modeldock-chat / modeldock-responses 和所有当前选定模型，仅修改 JSONC settings.json 的 model；支持 COPILOT_HOME / COPILOT_PROVIDERS_CONFIG。保留其他来源、设置注释、config.json 内部状态、账号、权限、MCP、Skills 与会话。两文件采用私有权限、加密备份/所有权历史、事务回滚、统一撤销与还原。
- 配置模块 19 项与真实 Store/Gateway/撤销集成 5 项全通过；包含两次同步后撤销的 Windows 私有 ACL 检查。6 个定向文件合计 136 项通过，覆盖全部工具聚合、源删除/持久化、退役工具隔离及 Copilot Codex Responses 边界。
- 本机官方 Windows Copilot CLI 1.0.99-2 实际读取核心 apply 生成的 providers/settings，直连/聚合 × Chat/Responses 四组及 Codex 空终态的标准 SSE / octet-stream 两组全通过；每组 2 次模拟上游请求、一次只读内存工具及第二轮结果回传，最终精确 OK、退出 0、stderr 为空。共 12 次 localhost 模拟上游请求，其中 8 次经真实 /tool/copilot-cli/v1。没有真实账号、付费供应商请求、shell 或文件工具执行。
- 修复前，CLI 在 Codex 的 completed.output=[] 两种 MIME 场景都报 No response was returned，未执行工具。修复后，仅对 Copilot app / CLI 的 Codex Responses 入口复用已完成项补齐，保留流式增量；新增 CLI 流式/非流式回归和两组官方原生复验通过，其他工具范围不扩展。
- Windows 实际 Electron 通过 12 工具导航、8 常规/4 IDE、亮暗两种主题的 6 组布局、CLI 指南、真实 React 预览与密钥隐藏、完整默认名称及右键导航验证；已人工查看 CLI 浅色/深色和预览截图。界面 smoke 只保存隔离合成选择并预览，不同步真实外部配置。
- 类型检查、生产构建、测试入口剔除和 Windows x64 资源/图标/内嵌 ASAR 完整性检查通过。最终全套 87 文件：1843 通过、36 跳过、20 个已有平台条件失败，失败名称与 0.3.66 完全相同（Linux UID、POSIX 权限、Windows 符号链接），不宣称全套通过。
- 用户运行中的旧版保持原样。独立构建为 release/windows-0.3.67-2026-11-04T14-05-10-286Z-24392/win-unpacked。证据目录：work/copilot-cli、work/copilot-cli-ui-windows-final、work/copilot-cli-context-windows。未验证 Linux 原生 CLI、新版包安装替换或真实计费供应商推理。

## 2026-11-04 / 0.3.66 · 右键快捷菜单

- 供应商侧栏/卡片、模型、工具导航/详情、本地聚合接口、请求日志、授权账号、诊断日志和链接加入右键操作，复用原有业务动作与删除/清除授权确认。API Key 只通过明确复制动作读取，订阅没有复制令牌入口；Air 不显示文件应用、撤销、还原。输入框和选中的正文交给原生编辑菜单，密码控件禁用剪切/复制。
- Windows 实际 Electron 隔离窗口通过完整交互验证：精确系统剪贴板内容、编辑和详情打开、危险操作确认取消后数据/凭据保留、账号令牌不暴露、诊断 JSON 脱敏、Shift+F10/方向键/End/Esc 和焦点恢复、页面外点击关闭、5.3 秒快照轮询保持菜单、真实页面滚动关闭。全部使用合成资料，没有真实供应商推理、登录或外部客户端配置写入。
- 980×680 浅色/深色窗口边缘定位与横向溢出检查通过，实际查看模型、账号和页面底部诊断菜单截图。修复菜单聚焦可能引发外层滚动和无位移延迟 scroll 通知误关闭问题，保留截图后点击及真实滚动关闭回归。
- 右键边界 3 项、原生菜单模板/生命周期 6 项全通过；原生编辑项通过 Electron role 与模板验证，未逐项人工点击操作系统弹出菜单。类型检查、生产构建、测试入口剔除和 Windows x64 资源/图标/ASAR 完整性检查通过。最终全套 85 文件：1815 通过、36 跳过、20 个已有平台条件失败（Linux UID、POSIX 权限、Windows 符号链接），失败项目与本轮修改前记录一致，不宣称全套通过。
- 用户运行中的 D:\ModelDock-0.3.55\ModelDock.exe 保持原样。独立构建为 release/windows-0.3.66-2026-11-04T13-48-29-103Z-22392/win-unpacked。证据：work/context-menu、work/context-menu-windows-verified。

## 2026-11-04 / 0.3.65 · Junie CLI 与 IDE ACP

- 新增独立 Junie 工具与 strict 直连/聚合选择。当前默认模型以完整 Chat Completions / Responses 推理端点和原生 apiType 写入 JUNIE_HOME/models/modeldock.json，仅合并 config.json 的 model 字段，同时在 ~/.jetbrains/acp.json 合并自有「Junie · ModelDock」代理；保留其他代理、MCP、Hooks、模型、账号及设置。内置 Junie 只接受官方 OpenAI/Anthropic Key 的 BYOK 授权，仍由 IDE 手工管理，不冒充其原生配置。
- 新增 Junie 配置 17 项、ACP helper 4 项和真实网关/统一撤销集成 4 项，全通过。覆盖 Windows managed 原生程序发现、中文/特殊字符路径、完整 URL 与协议、Key 与模型别名边界、精确模型权限、外部修改拒绝、三文件备份/事务回滚/恢复、JUNIE_HOME、UTF-8 BOM、目录链接/硬链接拒绝和 Windows 私有 ACL。同步撤销复用私有文件写入器，第二次同步后的撤销仍验证当前用户/SYSTEM 权限。包含其他工具撤销的 4 文件 43 项定向通过。
- Windows 实际 Electron：11 个工具导航、7 个普通 Agent、4 个 IDE 的图标与 6 组亮暗布局通过；实际点击 Junie 配置预览，完整端点、apiType 和 Key 占位正确。隔离 fake home 不安装启动器，因此如实记录 canApply=false，没有将界面预览当作应用或推理。
- 本机官方 Junie 3893.6 通过核心模块生成的完整 profile，经真实 ModelDock Gateway 的 /tool/junie/v1/responses 调用严格 localhost 模拟上游：initialize、session/new、session/prompt 全部成功，返回 OK、stopReason=end_turn，关闭输入后退出码 0。3 次模拟上游请求鉴权及 alias→上游ID正确，无 shell/文件/外部工具动作；只使用 Junie 内部 answer 控制流完成答复。该测试没有真实供应商调用或费用，不等同于 IDE 实际加载 ACP 文件、真实模型或计费验收。
- 类型检查、生产构建、生产入口、Windows x64 资源/图标/ASAR 完整性检查通过。最终全套 83 文件：1806 项通过、36 跳过、20 个已有平台条件失败（Linux UID、POSIX 权限、Windows 符号链接），没有新增持久失败，不宣称全套通过。
- 用户运行中的 D:\ModelDock-0.3.55\ModelDock.exe 保持原样。独立构建为 release/windows-0.3.65-2026-11-04T13-23-33-620Z-38296/win-unpacked。证据目录：work/junie、work/junie-ui-windows、work/junie-native-acp。Windows ACP 引用当前安装版本原生程序，若 Junie 升级后清理旧版本，在 ModelDock 重新同步刷新路径。

## 2026-11-04 / 0.3.63 · Windows 会员反代专项复核

- 修复 Windows 官方 Pi 安装目录发现：ModelDock 已运行时再安装 Pi，旧 PATH 不含 `%USERPROFILE%\.pi\agent\bin`，原来会误报未安装；新增该目录回退并用修复前失败、修复后通过的隔离用例验证。
- Central 生命周期不再整组跳过 Windows。8 项原生测试以临时 .NET EXE → `pi.cmd` → Node 子进程验证中文、空格、`&` 路径、隔离参数、身份 nonce、端口占用、并发启动/停止、stdin EOF、强制进程树关闭和退出后重启。Central/Pi 管理器、扩展与供应商共 16 项通过；这是本机合成进程和模拟协议验证，未调用真实账号。
- 官方 Central Windows x64 2.2.0 在空白账号目录中确认版本、run 参数和未登录拒绝。官方 Pi 1.5.0 经真实 npm `pi.cmd` 在 Windows 接受管理器参数、加载 ModelDock 扩展，在随机本机端口返回健康身份及 61 项目录，stdin EOF 后退出码为 0。测试只增加合成 Central provider 并替换扩展监听端口，没有发送推理。已登录的官方 Central → Pi 分派、真实账号授权、模型推理与计费未验收。
- TRAE 的 2 个相关测试文件为 15 项通过、3 项 Linux/POSIX 专属跳过。新增真实 Windows ACL 检查，确认当前用户/SYSTEM 私有权限及凭据文件继承；中文、空格、逗号目录的 bind-mount 参数、Linux 容器用户和 Desktop 回环端口检查通过。当前机器未找到 Docker CLI，没有实际容器启动、Docker Desktop 文件共享、网页登录或真实 TRAE 推理验收。
- `npm run typecheck`、生产构建、生产入口检查、Windows x64 打包及资源/图标/PE 内嵌 ASAR 完整性检查通过。新增校验要求 Pi 扩展真实解包且与源码一致；独立缺失/陈旧扩展负例被拒绝，恢复后的包再次通过。
- 最终全套单 worker：80 文件，1779 项通过、36 跳过、20 失败。20 项涉及已有 Linux UID、POSIX 权限和 Windows 符号链接条件，与此前记录的失败项目一致。本轮早期双 worker 额外遇到 14 项 SQLite `EPERM rename`，数据库单独 58 项及后续两轮单 worker 未再出现，未宣称全套通过。
- 用户运行中的 `D:\ModelDock-0.3.55\ModelDock.exe` 保持运行。独立构建位于 `release/windows-0.3.63-2026-11-04T12-02-37-215Z-55356/win-unpacked`；没有覆盖常规运行交付目录。证据位于 `work/windows-relay-review/`。

## 2026-11-04 / 0.3.63 · JetBrains AI 会员与 VS Code

- 在隔离的 Linux VS Code 1.145.0 中加载内置 Copilot Chat 0.73.0。VS Code 通过 Custom Endpoint 选中 ModelDock 导出的模型并发送消息，经实际 ModelDock 网关、实际 Pi 1.5.0 与 Anthropic SDK 转发，收到了本机模拟 Central 上游的完整流式回复。测试使用扩展接口，没有人工点击聊天面板。
- 使用真实 Pi 和两个本机模拟上游验证 OpenAI Responses、Anthropic Messages 的工具调用及结果回传。模型目录只包含当前 Pi 会话中经 Central 路由的候选。首次使用、已连接 Pi、已有配置遇到新的会话策略均在隔离目录验过。
- Central CLI 2.2.0 在隔离的空账号环境中按预期提示登录。没有取用个人订阅、发送付费推理或验证扣费。Windows 只做发行包静态核验。
- 类型检查、生产构建、生产入口隔离检查通过。80 个测试文件、1832 项测试通过。

## 2026-11-04 / 0.3.62 · TRAE 中国版反代

- 本机原生 Linux Docker 29.1.3 使用固定的 Trae2api-cn 1.0.10 镜像。以专用空白目录运行实际启动器，检查授权页、助手配置、未登录状态、错误密钥拒绝和停机后再次启动。测试容器已移除。
- Linux Electron 隔离窗口完成 11 项表单交互检查，覆盖启动后回填、授权入口、取消重开、两种连接方式的保存以及手动反代使用相同端口。控件验证使用模拟的管理操作。
- 通过真实 HTTP 回环测试服务器验证模型发现、备用目录过滤、密钥转发、原生 Chat / Responses / Messages 和工具回传。类型检查、生产入口检查和 77 个测试文件中的 1818 项测试通过。
- 真实 TRAE 账号授权、个人模型可用性和积分扣费尚待实测。Windows 包在 Linux 上进行静态检查，Windows 原生 Docker 启动与授权流程尚待实测。

## 2026-11-04 / 0.3.61：JetBrains AI Assistant / Air 切换

- 四个 JetBrains IDE 各自保存目标插件，默认 AI Assistant。切换目标取消旧的自动同步待办，仅保存选择，不立即修改 IDE；来源、直连 / 聚合模式及模型范围沿用当前 IDE。
- Assistant 保留已验证的聊天和独立补全界面与原同步流程；Air 页面提供「More Providers → OpenAI」原生账户创建步骤、URL / Key / 参考模型复制以及预览和导出，不显示文件同步、恢复、核心 / 轻量模型或 FIM 控件。
- 通过本机 Air 原生实现确认，Accounts 列表会过滤没有 PasswordSafe 密钥的元数据项，因此没有交付此前的元数据写入实验。Air 模式不写账户文件、密码库或 Agent 登录状态，账户由 Air 自身管理。
- 类型检查、生产构建和生产入口隔离检查通过；完整回归 75 个文件、1798 项测试通过。本机 Air 真实序列化类和 OpenAI 提供商 Key 必填规则已核验；四个 IDE 对应实现 JAR 哈希一致。Air 不提供任何原生文件应用/还原入口，旧 Assistant 同步保留。隔离 Electron 验证四个 IDE 的目标保存、导航、参数复制，以及 Air 源/模型修改不写原生文件、Air 应用/还原 API 拒绝、原 Assistant 同步及还原保持；明暗两种主题、两种尺寸、两种插件共 8 种布局通过。Linux deb 内容与最终生产构建一致；Windows 目录和 ZIP 内 92 个文件的静态完整性、CRC 与逐项哈希检查通过。Windows 原生运行与真实 Air Agent 推理未验收。

## 2026-11-04 / 0.3.60：移除 Trae 接入

- 移除 Trae 工具导航、接入选择、配置同步、连接助手和专用本地协议入口。原有供应商、模型和其他工具接入继续保留；不会修改 Trae 客户端配置、账号或自定义模型。
- 工具分类保留「常规 Agent」与「JetBrains」，分别包含 6 个工具和 4 个 IDE；供应商复制、本地聚合接口管理及密钥显示交互保留。
- 完整回归通过：73 个测试文件、1779 项测试；类型检查、生产构建和 `verify:production` 通过。新增回归确认旧工具绑定保留但不参与运行、旧专用入口返回 404、供应商删除不再同步旧工具，其他工具仍可列出和调用模型。
- 隔离 Electron 验证通过：10 个工具在浅/深色共 6 种布局下图标、分类及导航正常；供应商 URL/模型/密钥复制、密钥显示隐藏、本地聚合开关和持久化通过。界面确认不再提供已移除工具入口，未触碰真实客户端配置或真实供应商推理。
- 下方 0.3.58 的 Trae 验收是历史记录，不代表当前版本继续提供此功能。Linux deb 内容与最终生产构建一致，确认不含已移除的连接助手；Windows 目录包通过生产入口、资源、图标及内嵌 ASAR 完整性校验，ZIP 内 92 个文件 CRC 和逐项哈希检查通过。常规 Windows 目录已更新至 0.3.60，Windows 未做原生运行验收。

## 2026-11-03 / 0.3.58：Trae CN 一键适配（历史记录，功能已在 0.3.60 移除）

- 新增 Windows Trae CN 3.4.14 默认 profile 的原生模型同步。ModelDock 连接助手 0.2.1 通过正常 CLI 安装；主进程核验签名、进程、监听端口、profile、版本和扩展内容后连接，每次写入前再次核验。应用启动和页面导航不安装或写入模型，不直接读写 Trae 数据库，不向 ModelDock 导出 Trae 登录凭据。
- 真实已登录 Trae 上完成生产客户端身份链、Chat Completions / Responses / Messages 三协议创建、相同计划无变化、原 ID 更新、精确删除自有 ID。未知预算的 Responses 模型读回为空参数；已有预算从 1234 更新为 2345。验收前后均为原有 9 项模型，其安全元数据摘要完全一致；所有 QA ID 确认不存在。事务验收使用隔离的加密内存 journal，真实 SQLite 存储另由集成测试覆盖。证据：`work/trae-native-research/main-transaction-result.json`。
- 上述原生验收没有发送模型推理请求，localhost mock 请求数为 0。另有网关模拟上游测试覆盖三协议鉴权、精确模型范围、流式、取消、工具历史与 Codex Responses 终态修复；这些不替代 Trae 编辑器实际聊天、工具使用或计费供应商验收。同步不主动切换现有会话；必要时重新打开 Trae 模型设置刷新列表。
- 原生接口没有可验证的密钥修改 revision，自动撤销明确禁用，保留加密恢复记录。受管模型可见参数被外部修改时拒绝覆盖；仅换密钥的外部操作无法可靠检测。未知写入结果保留 pending 并停止后续写入，已确认的部分失败才执行回滚。
- 完整回归一次运行结果为 1759 通过、33 跳过、20 失败；20 个失败名称与修改前基线一致。后续最终 Trae 定向回归 87 项中 85 通过、2 失败：临时 SQLite 文件替换遭遇 Windows `EPERM / rename / -4048`。重跑其中 1 项通过，另 1 项仍由同一底层 OS 异常引起；集成文件此前有两轮 10/10 通过，原生客户端 16/16、桥边界 6/6、配置 10/10、同步事务及错误边界 32/32 均独立通过。保留失败记录，不声称全套通过，也没有证据将文件占用归因于 360。证据在 `work/trae-integration/`。
- 类型检查、生产构建通过。Electron 两种主题、六种布局和 11 个工具导航检查通过，人工查看 Trae 页面浅色与深色截图。最终 Windows x64 包版本为 0.3.58，含连接助手 0.2.1；生产入口、资源、图标、ASAR 内嵌完整性验证通过，ZIP 内 95 个文件逐一 SHA256 对照通过。常规 `release/win-unpacked` 已更新，运行中的用户旧版未被终止或替换。
- 原生验收新增的六个空白 Trae 窗口已通过界面逐一关闭，原用户窗口保留。该原窗口未被强制重载，使用新助手前正常重开 Trae 一次即可。

## 2026-11-02 / 0.3.55　Copilot 使用 Codex 订阅时工具调用后空回复

- 在 Windows 上通过已安装的 Copilot 1.1.34 原生 SDK、0.3.53 网关和真实 Codex 订阅复现。Sol / Max 第二轮发出 23 个正文增量及包含 124 个字符的最终消息，随后发出 `response.completed`，其中 `response.output` 为空。SDK 将该轮记成 0 字符并正常结束。两段历史会话也记录了工具调用成功后的空消息，但没有保存当时的原始上游事件。
- 修复仅用于 Copilot 的 Codex 订阅 Responses 入口。实测该后端能以 `application/octet-stream` 传输事件流。网关按输出序号和原始 ID 将缺失的已完成项补回最后的响应，保留推理项、消息阶段、调用参数和使用量。正文增量仍即时发出。真正只有推理、缺少终态或流损坏时返回协议错误。
- 两轮真实订阅验收使用隔离的 Copilot 会话和两个只读内存工具。两个工具各执行一次，第二轮上游再次给出空的终态数组，修复后的网关补齐推理与最终消息，SDK 显示 `RED_42/BLUE_73`。另使用本地模拟上游验证了实际 SDK 的流式和非流式请求，包括残缺工具调用不执行，以及持续的无正文响应最终显示错误。未对 Copilot 桌面界面做人工验收。
- 24 项定向回归、类型检查、生产构建、Windows x64 包的资源和 ASAR 完整性检查通过。完整测试为 1665 项通过、33 项跳过、20 项失败。修改前有相同的 20 个失败用例，涉及 Linux 进程检查和 Windows 文件权限或符号链接。运行中的旧版保持原样。已验证的构建目录为 `release/windows-0.3.55-2026-11-02T10-44-03-166Z-15208/win-unpacked`。

## 2026-10-11 / 0.3.53：Claude 火山 MiniMax M3 工具调用修复

- 原生火山 Coding Plan Messages 流在工具调用开始后返回 `BadRequest / InvalidParameter / messages.tool_calls.type`，此前被误映射成可重试服务器错误。Claude 聚合入口现在对精确官方火山 Agent/Coding 地址、`minimax-m3`、保存为 Responses 且无自定义 Claude 覆盖的模型，使用原有 `/responses` 协议。直连、全局 Messages、自定义覆盖及其他模型保持原路由。
- 聚合配置复用既有关闭 Claude thinking 字段的环境设置与恢复记录，`output_config.effort` 仍转换为上游推理强度。旧原生签名思考及服务端工具历史明确返回 400、提示新建聊天，不删除或过滤内容；普通客户端工具调用和工具结果完整转换。原生错误采用闭集分类与固定安全提示，保留参数错误 400、过载 529 等语义，不暴露上游正文或凭据。
- 6 个定向测试文件通过 155 项、跳过 1 项。完整单 worker 测试运行 69 个文件：1632 项通过、33 项跳过、20 项失败；相同 20 个失败名称在未合入修复的原源码复现，涉及 Linux UID、POSIX 文件权限、Windows 符号链接与安全诊断的平台断言，未声称全套通过。独立只读源码审查通过，差异空白检查通过。
- 使用本机 VS Code 所安装 Claude SDK 0.3.281，经修复后真实网关与现有 Coding Plan `minimax-m3`，完成一次内存固定文本 MCP 工具调用及第二轮最终答案：两个 Responses 请求均 HTTP 200 和 response.completed，SDK success、2 turns、1 tool invocation、最终标记匹配。凭据仅在无窗口、关闭 GPU 的隔离进程内读取；不写真实 SQLite、Claude 配置或 VS Code 配置，未执行 shell、浏览器或文件工具。
- 本轮不进行编辑器界面验收、长任务验收或直连工具兼容验收；此前异常重启原因未确定。修复代码与包单独生成，不停止用户应用，不自动替换运行中的安装版，也不更改系统设置。
- 额外以本地合成错误流验证真实 SDK：一次流式请求收到参数拒绝，SDK 按自身机制回退一次非流式请求，两次网关记录均为 400，随后错误结束；未将这种回退描述为完全零重试。没有真实上游调用或工具执行。
- 最终类型检查、生产构建、测试入口剔除，以及 Windows x64 ASAR 内嵌完整性、资源、图标静态验证通过。版本目录为 `release/windows-0.3.53-2026-10-11T07-08-23-735Z-30192/win-unpacked`；独立副本交付到本次任务 outputs。未启动最终包或替换 `D:\ModelDock`。

## 2026-10-10 / 0.3.50：思考等级回退与手动编辑修复

- 修复 0.3.49 将未核实的接口档位置空、并据此隐藏编辑控件的问题。有效上游档位优先；缺少信息时回退内置维护建议，优先沿用同精确型号的档位，没有专用档位的已知思考模型采用软件通用 low/medium/high 建议。界面区分内置建议与官方声明，不将这些建议标记为新增的供应商支持证明。火山 Kimi K3 补回 low/high/max 与默认 max，实际导出格式跟随所选协议；长度等套餐参数保持独立。
- 勾选「支持思考」后，手动添加、已有模型编辑和获取模型列表的逐项编辑均呈现全部七种合法档位；维护默认仅决定勾选项，不再限制手工选择。用户自定义档位、默认强度以及「由工具选择」可以保存、重开和导出；删除当前默认档位时清除默认，切换接口同步格式。
- 上游明确不支持思考、明确 false 或空档位列表继续优先；用户手动清空也保留。订阅来源缺少档位时仅补思考字段，不搬入公开 API 的上下文、输出、图片或工具能力。旧模型不在启动或发现时被静默覆写，空档位可通过「应用维护参数」明确更新。
- 66 个文件、1631 项完整测试通过，类型检查、构建和生产入口隔离检查通过。回归包含临时真实 Store 保存重开及 VS Code/Copilot 配置序列化、缺省与负能力、用户自定义和默认清空；没有写入真实工具配置。
- 源码和最终 deb 解包后的独立 QA 程序均在 Linux XWayland 实际窗口验证：火山 Kimi 内置默认、七档手工编辑、保存重开、未知模型手工设置、旧空列表显式应用、目录默认强度经实际 IPC 清空并再次发现、订阅只更新思考字段。1320×880/980×680 和补充深色 980 窗口无横向溢出，档位和保存按钮可见，已人工查看截图；深色验证通过真实设置操作并恢复原偏好。所有凭据、目录及上游为隔离合成资料。
- 最终 deb 的 20 个 dist/dist-electron 文件匹配构建，正式包没有 smoke/dev 入口。Windows 目录刷新版本、ASAR 完整性资源及应用内容，静态验证通过；运行时代码段、fuse 和其他二进制保持不变。未做 Windows 原生运行、真实计费供应商推理、实际 VS Code UI、系统安装或重启验收。
- main SHA256：`ed42c5bb1bfd71830c390e41b3ecd25f9554cde8156768648598c7242c0d0fa8`；deb SHA256：`afed03ceb7e0e88996665bc284bca13d2629c35c709d7f8cca9974fcce73c31e`；ASAR SHA256：`c8e5155d2bb6840d0711c5a0c64d68d6bf24f0d8988c5c327b0d3eddb5416a27`。证据：`/home/coco/Documents/Codex/2026-10-09/za/work/reasoning-package-research/`、`reasoning-ui/`、`reasoning-ui-packaged/`。运行中的安装版未关闭或修改。

## 2026-10-10 / 0.3.49：官方模型参数与添加默认值更新

- 联网核对 94 组精确型号／供应商参数，覆盖 OpenAI、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi、MiniMax、Grok 及火山 Agent/Coding Plan。数据集中保存官方来源、日期、上下文口径、输入／输出上限、图片／工具／思考能力及已证实的思考档位；无法独立核实的最大值保持未知。火山 Kimi K3 使用当前官方客户端示例的 1,024,000 上下文和 131,072 输出参考值，不再沿用 128K；示例间差异与套餐限制在界面说明，未用原生 API 规格代替套餐规格。
- 新增模型按精确 ID、实际供应商地址和协议自动填未修改字段，模型发现优先保留有效上游声明。未知模型不猜测工具／图片能力；手动 0／false、原有模型和订阅目录保持优先。已有模型可点击「应用官方参数」更新草稿，保存后再明确同步工具，不在启动或发现时改写外部配置。
- 思考能力与思考档位分开保存；同型号在未证实接口上不写强度格式。不支持的协议不自动启用工具或思考档位。Google 独立输入／输出上限保留，客户端上下文采用二者合计；Qwen 思考开关对应的输入条件也保留。新增 specs_json 的旧库迁移、非法字段过滤和失败回滚通过测试，旧数据不自动升级为新默认值。
- 输出预算不再统一截断为 16K。已配置预算按实际上下文预留输入空间，未知值保留保守预算；发布输出上限达到整段上下文时，首次添加采用较小首选预算，避免只留一个输入 token。Windows 包检查补充 PE 内嵌 ASAR 头部散列核验，正确包通过，故意损坏记录的独立负例被拒绝。
- 最终完整测试 66 个文件、1605 项通过；类型检查、生产构建和测试入口剔除通过。源码与最终 deb 解包后的独立 QA 副本，均在 Linux XWayland 实际 Electron 窗口验证：上游优先、字典补全、未知型号、0／false 覆盖、添加／重新获取保留、已有模型显式更新；1320×880 与 980×680 无横向溢出，保存按钮可见，已人工查看截图。所有资料目录和凭据为隔离合成数据，未调用真实模型或修改真实客户端配置。
- deb 中 20 个 dist／dist-electron 文件逐字节匹配最终构建，生产包不含 smoke/dev 入口。Windows 目录基于本机既有 Electron 运行时刷新生产资源、PE 版本与 ASAR 完整性记录；运行时代码段及其余二进制不变，静态资源／图标／WASM／许可证检查通过。未做 Windows 原生运行、原生 Wayland、本机安装升级或各供应商实际推理验收。
- 版本 0.3.49；main SHA256：`2079d6d8cb27bac29358f279098350630d33bdbd77089865873bffef2c3de950`；deb SHA256：`3318a06dae57a5df5c76fb35e3a99afe8fb7cc57613d73679c5c90b21b214cce`；ASAR SHA256：`8353eadcc46a7fdba4e777bc448e2dd7557c48d81148d019ba33eda9a9d76049`。本轮证据目录：`/home/coco/Documents/Codex/2026-10-09/za/work/model-parameter-research/`。运行中的旧应用保持运行，交付包不自动安装。

## 2026-10-09 / 0.3.48：Rider 火山 GLM 思考流 502 修复

- 真实火山 Responses 流的 `response.reasoning_summary_part.added` 可以只有 `part.type`，不含初始 `text`。旧桥接器把合法空起始事件判为错误，导致上游 HTTP 200、正常完成时 Rider 仍收到 502。现在仅对 added 事件中缺失的 text/refusal 初始化为空；显式无效值、done 缺字段、上游错误、截断与 32 MiB 缓冲上限仍严格检查。
- 使用当前实际配置的火山 Agent Plan `glm-5.3`，固定合成提示 Reply exactly OK、输出上限 1024，完成真实调用。旧网关流式返回 502，直接上游正常完成；修复网关非流式及流式均为 200、回复 OK，流式具有 stop 和唯一 DONE。
- 使用本机 Rider 2026.2 安装中的 Koog/Ktor 客户端库，再经修复网关发出真实短请求，得到 OK、完整结束、无客户端异常。另以实际 Koog 反序列化器验证保存的合成响应流及思考/工具调用模拟序列。本轮没有操作 Rider 原生界面，没有逐一验证另外 13 个聊天模型，也没有将模拟工具调用当成真实工具执行。
- Codex MSIX 的 Roaming 虚拟化副本与运行中的 ModelDock 数据不同；真实资料经未打包只读进程确认。凭据仅在隔离 Electron 进程内解密并用于本次授权测试，未输出原始密钥或请求头，没有更改真实数据库、IDE XML 或 PasswordSafe。
- 定向回归 114 项通过；完整测试 1483 项通过、15 项跳过，17 项已重现的 Windows 平台基线失败保持原状。类型检查、构建、生产入口、Windows x64 资源及图标、差异检查通过。
- 独立包位于 `release/windows-0.3.48-2026-10-09T14-41-49-406Z-29144/win-unpacked`；app.asar SHA-256：`73496033EA842C78B58AC047A08FB09A3602D258A0FDA5FA1D6F40DD475AF7D4`。运行中的旧版保留。通过托盘退出旧 ModelDock，再从资源管理器打开新版；Rider 现有地址与密钥可以保留。

## 2026-10-09 / 0.3.47：Windows Rider 同步与补全列表说明

- 修复 Windows 上旧新 IDE 配置共存导致目标不确定的拒绝同步路径。通过当前安装的 `product-info.json`、`.home` 指针、2026.2/build 262 元数据定位正确目录；不按 mtime 猜测、不删除旧档。CIM 仅输出公开进程身份，使用 UTF-8；残留 PID、Toolbox 以及可识别的普通 JBR 构建 daemon 不代表 IDE 运行，身份不完整则禁止写入。事务写入前重新读取进程证据，显式刷新和待办检查绕过短缓存。
- 自动同步区分真实运行的 waiting 与配置/身份未确认的 blocked，不再统一提示退出。检查状态后立即尝试本次交互的已有待办；启动和导航仍不创建外部写入。
- AI 补全与聊天分开标注数量：14 个聊天映射、两个已确认 DeepSeek FIM 候选和跟随默认对应三项。跟随尚未确认 FIM 的模型会保持停用，不把 Chat/Responses 推断为 FIM，也不把未知能力写成已证实不支持。
- 本机默认 Windows 只读检测确认 WebStorm、IDEA、Rider、PyCharm 当前均定位各自 2026.2 目录且 `stopped/canApply=true`。真实 Rider 2026.2.3.1 的启动日志与安装元数据一致；此轮未修改真实 IDE 配置、PasswordSafe 或实际密钥，未进行真实 Rider UI 或推理验收。
- 原生 Electron 隔离验证通过：新旧 Rider 目录共存、陈旧 PID 复用时自动写入当前 2026.2；旧档散列与 PasswordSafe 哨兵字节不变。运行时保存待办、不写 XML，退出后点击刷新立即同步；不完整进程证据显示 blocked 且无写入。14 个网关模型别名与 14 个聊天下拉项匹配，补全为三项。12 张亮暗、1320/980 的同步、数量说明及 blocked 区域截图均无横向溢出；只请求本机模型目录，上游请求数为零。
- Windows 专项 38 项通过；完整测试 1474 项通过、15 项跳过，17 项既有 Windows 平台失败保持原状。类型检查、构建、生产入口隔离、Windows x64 资源/ASAR/图标与差异检查通过。
- 独立包位于 `release/windows-0.3.47-2026-10-09T13-47-35-086Z-29496/win-unpacked`；`app.asar` SHA-256：`319050D6844358FEBCBCC50C0225BBF3A6097A99D16D1D6450ED259C05DF7322`。退出旧版 ModelDock、打开新版并保持 Rider 退出后，明确点击一次「同步 IDE 设置」；聊天及补全各自的 Key 仍需在 IDE 中确认。

## 2026-10-09 / 0.3.46：JetBrains 图标一致性

- WebStorm、IntelliJ IDEA、Rider、PyCharm 改用 JetBrains 官方品牌页直接提供的 WS / IJ / RD / PC 彩色 SVG；保留原始字节、颜色和比例。侧栏与详情共用相同本地资源，取消单色 mask 和多余背景框。来源、SHA-256、归属及品牌指南记录同步更新，资源不再标注为 ModelDock 原创 MIT 图标。
- 隔离原生 Windows Electron 检查 10 个工具、亮/暗主题及 1320×1440、1320×880、980×680 六组布局。四个彩色图片完整解码、无滤镜、保持方形比例；侧栏和详情来源一致，全部图标资源唯一。检查后恢复原主题、导航、窗口大小与滚动位置，工具选择和已保存设置不变，没有调用配置同步。
- 类型检查、构建、生产入口隔离和 Windows x64 包验证通过；四份包内 SVG 与 manifest 的原始官方文件 SHA-256 一致。完整测试 1432 项通过、15 项跳过，17 项既有 Windows 平台失败保持原状，未报告全套通过。
- 旧运行实例保留。独立包位于 `release/windows-0.3.46-2026-10-09T12-58-12-822Z-11936/win-unpacked`；`app.asar` SHA-256：`A08184F95A24C9E7A99B13CC5ABD2BCAF4AA47F63066B0B7694E6B922F07C607`。

## 2026-10-09 / 0.3.45：防抖同步、撤销和功能精简

- 非 JetBrains 工具采用 400 毫秒尾部防抖，立即保存选择，外部写入等待主进程全局写锁。手动同步消耗待办，撤销与还原取消待办，失败不自动重试；启动与导航不创建同步任务。
- 每个工具仅保留上次成功且实际改变配置的加密撤销记录。撤销恢复受影响文件、配置管理状态和原选择；检测外部改动后拒绝覆盖，部分失败回滚。Copilot 使用原生注册表和系统凭据快照；其验证为模拟原生协议及凭据存储，未修改真实用户凭据。
- 用量统计页面、Token 累计、价格、客户端历史导入、后台同步及统计 IPC 已移除。新数据库不创建统计表，旧数据库历史保持不变；API 协议本身的 usage 转发和订阅账号额度信息保留。全局模型目录页已移除，供应商模型编辑、发现和工具路由继续保留。以下较早版本的统计页和全局目录验收属于当时功能。
- 原生 Windows Electron + preload + 主进程 + 隔离文件验证通过：三次来源点选的间隔为 44 / 45 毫秒，只产生一次外部配置写入和一次对应 Claude 原文件备份；手动立即同步后等待 650 毫秒无尾部补写。成功同步后再修改来源并立即撤销，精确恢复原文件及选择，等待中的新选择未补写。亮/暗主题、1320×880 / 980×680 无横向溢出，撤销按钮可见，供应商模型管理可用。
- Claude 回归的原生隔离验证通过：默认模型、隐私开关、聚合订阅及官方恢复等待实际写入完成；模拟 Messages 请求与四种窗口布局通过。本版没有使用真实计费模型或真实 Copilot 凭据；Linux 原生窗口与各工具实际推理没有在本轮验收。
- 类型检查、生产构建、生产入口隔离、Windows x64 包的资源/ASAR/图标及差异检查通过。完整测试 1432 项通过、15 项跳过；17 项失败来自之前已在 HEAD 隔离基线重现的 Windows 平台测试，集中于 Linux UID、POSIX 权限位、符号链接权限及测试路径分隔符，未报告全套通过。
- 运行中的旧程序保留，新包位于 `release/windows-0.3.45-2026-10-09T11-45-26-125Z-14664/win-unpacked`。最终 `app.asar` SHA-256：`7E363FCBFD39297E3E7BC99BB1DB193F97C9B8294CE77DC108361E12E2988CA8`。

## 2026-10-08 本地增量：模型能力字典

日期：2026-10-08（Asia/Hong_Kong）。

- 内置字典收录 116 个明确的模型 ID、官方别名与快照，覆盖 OpenAI、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi、Grok；每项保存上下文、图片输入、官方来源与核对日期。仅精确匹配型号及指定厂商命名空间。Gemini 按官方输入长度填写；Kimi 文档使用概数时采用保守的十进制默认值。
- 模型列表仍来自上游。上下文和图片能力逐字段按有效上游声明、内置字典、本地未知默认值依次处理；明确的 false 与仅 text 输入不会被字典覆盖。无效首选字段不会遮住其他有效元数据字段，兼容 OpenRouter 的 architecture.input_modalities。
- 模型列表增加逐项「参数设置」，显示字典补全及手动修改的来源，保留批量设置。上下文 0 与图片关闭能保存；重新获取时已添加项显示原保存值，导入跳过既有模型。没有数据库迁移或修改既有模型、授权及工具配置。
- 相关回归 2 个测试文件、91 项测试全部通过；类型检查、生产构建、生产入口隔离检查和 Windows 包的 ASAR／资源／图标检查通过。新增原生验证实现仅编入独立 smoke 入口，生产包不含该测试代码。
- Windows 原生 Electron 和最终包的独立 QA 副本均使用全新资料目录与本地合成上游，验证字典补全、上游优先、未知型号、逐项 0／false 覆盖、批量添加和重新获取保留。1320×880、980×680 实际截图及布局检查通过，底部按钮可见且无横向溢出；实际查看了渲染截图。
- 完整 npm test 在 Windows 未全部通过：Linux 进程 UID 检查与 POSIX 权限／链接诊断共 16 项失败，在未改动的 HEAD 6c42f770 隔离快照中重现相同失败名称；相关测试及源文件 SHA256 与工作目录一致。另外网关用例出现间歇性 SQLite rename EPERM，独立复跑失败位置改变，基线网关 21 项全部通过，未把该现象报告为已解决。
- 本轮没有调用真实计费模型，原生验证使用合成凭据。字典规格核对与模型列表／窗口验证不代表图片推理或实际套餐能力已经验收；Linux 原生窗口未在本轮验证。
- 证据：work/model-metadata-targeted-final.log、model-metadata-all-tests.log、model-metadata-baseline-tests.log、model-metadata-native/、model-metadata-packaged/、model-metadata-pack.log。运行中的旧程序保留；本轮独立 Windows 包位于 release/windows-0.3.36-2026-10-08T11-41-56-747Z-6648/win-unpacked，未替换标准 release/win-unpacked。



## 0.3.36 持久化诊断日志

日期：2026-10-08（Asia/Hong_Kong）。

- 「服务与日志」页新增诊断面板：按信息／警告／错误筛选、搜索、选择最近条数、查看结构化详情、刷新、复制筛选结果、导出 JSONL 和打开日志目录。原有网关请求日志保持。
- 日志在资料目录的 logs/diagnostics.jsonl 自动保存，重启后可读取；单文件最多 2 MiB，包含当前文件共保留 5 份，最多约 10 MiB。每次启动有会话 ID，每个关键操作及每个 HTTP 请求有独立关联 ID。查询／格式化／复制自身不生成日志，导出仅记录固定完成事件。
- 覆盖启动与启动失败（日志先于 Store/vault 初始化）、授权阶段与终态、网络响应与故障、模型测试结果和响应形状、模型发现、网关启停／启动失败／请求、工具配置同步与恢复、MCP／Skills／用量操作、界面错误与进程异常。正常授权等待按状态变化记录，不逐次刷屏；异常 401／429／5xx 等仍记录。全局使用 uncaughtExceptionMonitor 保留 Node 原有致命退出语义。
- 固定事件／文案与明确元数据白名单；不保存凭据、请求头、请求或响应正文、设备验证码、验证地址参数、上游错误正文或原始异常文本。网络错误保留 .code/cause 中的受控编码，并从有界 Chromium 文本只提取既有封闭 ERR_* 枚举。未知路径替换为 /[redacted]，地址参数和 userinfo 移除；错误堆栈只保留相对项目文件位置。
- 日志写入或读取失败不会中断服务；面板说明不可用。新增回归涵盖轮转／重启／断写恢复、读写限额、恶意记录白名单过滤、链接与读写期间替换、磁盘满、错误 getter、Chromium 代理／DNS／证书／超时脱敏，以及真实回环网关独立关联和诊断回调异常不会重复执行推理。
- 类型检查、生产构建、verify:production、git diff --check 通过。Linux 子进程 umask 022 下 48 个测试文件、935 项测试全部通过。现有 0.3.35 Linux 工具同步、凭据与自定义路径修复保持。
- 源生产窗口与从最终 deb 解包的实际程序均在 KDE Wayland 使用独立资料／客户端目录验证：dark/light × 1080×720 / 980×680，无横向溢出，级别筛选、搜索、条数、详情、复制、导出与目录按钮正常。401、ECONNRESET、Chromium ERR_PROXY_CONNECTION_FAILED、模型成功、IPC 失败、界面异常和两次设备码立即失败均实际经过应用调用链产生诊断；日志／复制／导出未出现合成的名称、密钥、模型上游 ID、正文或错误文案。两个失败登录有不同关联，重启保留旧会话。renderer sandbox/contextIsolation 仍启用。
- 所有上游为测试进程内模拟，没有读取真实账号／客户端资料，没有调用计费模型。剪贴板、目录打开与保存框使用隔离替身，最终 JSONL 实际写入并确认 Linux 私有权限。正常退出两个测试实例，未结束用户应用、安装系统包或同步真实客户端配置。
- Linux amd64 deb 与标准 Windows 目录均使用最终 dist 更新；包内 15 个生产文件逐字节匹配，生产入口、日志 UI、SQL WASM 和 Windows 图标／资源检查通过。Windows 为 Linux 宿主上的静态交付，没有 Windows 实机运行。缺失的 Electron 44.5.1 运行依赖从本机官方缓存离线恢复，没有修改锁定依赖版本。此次未生成 AppImage。
- 最终 main SHA256：210594781773ba6d3b0914cbb35cef24ad2b653d1ac4ab999a0758c0078bfe39；deb SHA256：fe4cea2727cbd868a505e8795256875abf36beff708a87cf64a41ea0dcabd34c。
- 本任务证据根：/home/coco/Documents/Codex/2026-10-07/zh/work/。包括 diagnostics-all-tests.log、diagnostic-core-chromium-tests.log、diagnostic-integration-tests.log、model-dock-diagnostics-ui-ciA0PL/、model-dock-diagnostics-deb-ZbSwVG/ 与 diagnostics-v0.3.36-package-validation-release-final.json；源最后一次复核的第二次启动因测试探针在 Electron Bootstrap 尚未就绪时访问 BrowserWindow 失败，第一实例和完整最终 deb 双启动通过，探针已增加 isReady 防护。没有把这个探针失败当成产品启动故障。

## 0.3.35 Linux 工具同步修复

日期：2026-10-08（Asia/Hong_Kong）。

- Copilot 桌面：私有祖先目录中的 run(0775) 正确接受，文件 0600、当前属主、链接与读期间身份检查保留。Linux 仅信任 root 管理且不可由普通用户替换的 `/usr/bin/github`，验证 ELF、执行文件 inode、当前 UID、同网络命名空间、启动时间及 PID 持有的 IPv4 loopback socket，并在读取和写配置前重新核实。此信任来源为系统管理员安装，不是厂商签名。Windows 原有签名规则保留；用户可写 AppImage 与 macOS 暂不放行。
- Linux 凭据：固定 `/usr/bin/python3 -I` + Secret Service 加密会话，精确处理所需 UUID 的 apiKey/bearerToken，保留原始字节、全部属性、标签、内容类型和集合，恢复时复核原始值及原先不存在的目标。旧 Windows version 1 日记仍兼容，Linux version 2 不允许跨平台恢复。锁定、歧义、缺依赖或恢复集合变化在写入前停止并保留记录；原生来源 hasSecret=true 而精确匹配为空时禁止清理。
- DSH：发现 PATH 中实际 dsh 的 npm 包、NVM_BIN 和桌面 PATH 缺失时的 nvm 版本；不运行 shell 初始化脚本。OpenCode：配置同步、还原、MCP、Skills、用量路径统一遵循有效绝对 XDG 根；QA 注入 home 时保持隔离。Codex CODEX_HOME 与 VS Code Code/User 路径核查没有发现本次同类缺陷，原有文件合并/备份保持。
- 44 个测试文件、888 项测试全部通过；typecheck、生产 build、verify:production、git diff --check 通过。新增安全反例覆盖可替换目录、公开秘密文件、PID/可执行文件/socket 变化、错误安装身份、错误凭据范围、重复或锁定项以及自定义 XDG/nvm。
- 本机真实 Copilot 1.1.27 只读连接成功（6 个供应商、17 个模型），未同步真实配置或调用推理。本机 Codex 原生 app-server 在独立资料目录解析合成模型目录成功；DSH 只读解析 0.1.7-rc.2 web profile 与 3 个模型插件成功。
- 真实 gnome-keyring 的两项随机 UUID 合成凭据完成创建、捕获、删除、恢复、字节与元数据精确比较，最后确认清理。系统缺少 python3-secretstorage；测试从本机 APT 下载并解包固定依赖目录，仅注入测试 transport，未安装系统依赖或读取真实账号。deb 已声明 python3-secretstorage；apt 模拟确认升级 ModelDock、安装 secretstorage/jeepney 两包，0 移除。
- XWayland 原生 Electron 的五工具专项 UI smoke 成功：真实渲染/preload、工具选择、合成网关 HTTP 200、工具还原、DSH 配置验证；独立数据库和客户端目录。通用历史 smoke 在旧“模型单价”按钮选择器处失败（当前已更换用量页面），Wayland 隐藏窗口截图停滞；专项检查已通过，不将这些脚本结果称为 Wayland 全流程或 Windows 实机验收。
- Linux amd64 deb 的 ASAR 内 15 个构建文件与最终 dist/dist-electron 字节一致，生产测试入口已剔除。包 SHA-256：`10f5f182f1cb02462480da927eb5b5b20c169d222c8b57c058210ac16b291f5f`。本轮不替换正在运行的 ModelDock，不执行真实客户端同步；Windows 可执行发行包需在 Windows 使用项目 pack:win 生成。
- 完整隔离实现及原生验证证据：`/home/coco/Documents/Codex/2026-10-08/zh/work/model-dock-linux-fix/`；deb 与源码 patch 交付于同任务 outputs。


历史记录：2026-10-07（Asia/Hong_Kong）。

## 0.3.33 Copilot 订阅来源与无目录模型推理

- 「添加订阅」新增 GitHub Copilot，三种服务同一行展示；可以复用授权中心已登录的 GitHub 账号，或保存来源后完成官方设备授权。来源加密凭据仅保存账号引用，GitHub 长时 token 仍由原加密账号存储集中管理，短时 Copilot token 仅在内存缓存、去重与续期。注销账号清除关联来源引用并取消在途兑换，保留全局模型与工具绑定。
- 主进程统一分派 Copilot 模型目录、连接测试和本地网关，动态 CAPI 地址严格限定官方 HTTPS 域与原生路由。目录按每个模型实际声明的 Chat Completions / Responses 能力选择协议，并映射上下文、工具与图片能力；工具只持有本地连接密钥。采用官方客户端 HTTP 兼容协议，没有安装或调用 Copilot SDK/CLI，不将向 Copilot app 同步配置视作订阅推理。
- 连通性始终发送已配置模型的推理 POST，不访问模型目录。补充 Ark 官方 reasoning.content.reasoning_text 输出识别；仅缺失未完成原因、具有完整推理响应并且实际用量达到本次请求预算时，识别短测试截断。空完成包、任意用量 JSON、明确失败、过滤及未知未完成原因仍不能通过；仅思考或用量证据显示请求已处理，不声称收到完整回答。截图中的真实厂商返包未采集，本轮定位为源码兼容盲点与模拟复现。
- 保存 API 来源不再强制弹出模型目录；无目录接口的错误提示给出「手动添加」入口，随后可直接测试连接。README 与空列表引导已同步。没有模型时不猜测模型 ID，也不自动生成目录。
- 类型检查、生产构建、生产入口与测试代码剔除检查通过；Linux 子进程 umask 022 下 40 个文件、840 项测试全通过。新增 Copilot 授权引用、官方端点/重定向、超时/晚返回、缓存/续期/注销、双协议网关/用量、账号切换时缓存与在途目录失效等回归；推理校验增加有/无目录、reasoning-only 和错误负例。
- KDE Wayland 的实际生产窗口及从最终 deb 解包的程序均验证：dark/light × 1080×720 / 980×680 中三种订阅选项和表单页脚可见、无横向溢出；真实指针点击完成 Copilot 创建、模拟 GitHub 设备授权、已登录账号选择、模型目录添加、Chat 和 Responses 推理，以及模型目录 HTTP 404 → 手动添加 → Ark 仅思考短测试成功的完整流程。renderer 保持 sandbox/contextIsolation，未使用 --no-sandbox，程序正常退出码 0。
- 以上授权和模型请求全部使用独立资料目录及测试进程内模拟上游，未访问真实 GitHub/供应商账号、未消耗真实订阅额度、未修改外部客户端配置。真实上游推理及账号权限尚未实测；本机安装脚本未执行。
- 标准 Windows 目录 release/win-unpacked 和 Linux amd64 deb 均更新到 0.3.33。两者 ASAR 全部 15 个构建文件与最终 dist/dist-electron 散列一致，生产入口、Copilot 实现标记、SQL WASM 通过；Windows EXE 七种图标资源通过，未做 Windows 实机运行。Linux 本轮生成 deb，未重新生成 AppImage。
- 证据位于 `/home/coco/Documents/Codex/2026-10-07/zh/work/`：`copilot-all-tests.log`、`connection-diagnosis/`、`copilot-provider-tests.log`、`copilot-subscription-tests.log`、`model-dock-copilot-ui-R6j9zY/`、`model-dock-copilot-deb-ogCAYt/` 和 `copilot-v0.3.33-*`。截图和 deb 位于同任务 outputs。

官方依据：[Copilot 应用授权](https://github.com/github/copilot-sdk/blob/main/docs/setup/github-oauth.md)、[官方客户端 token 管理](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/authentication/node/copilotTokenManager.ts)、[模型端点与能力字段](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/common/endpointProvider.ts)、[Ark Responses 格式](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh)。

## 0.3.32 供应商新增入口移到左侧

- 「添加 API」「添加订阅」放在左侧「模型供应商」标题下，随分组标题固定；右侧顶部及空列表不再重复新增入口。保留原有创建弹窗与默认预设，空列表文案和 README 指向左侧。
- 类型检查、生产构建及生产入口剔除检查通过；在 Linux `umask 022` 下 38 个测试文件、787 项测试全部通过。该布局变更未增加镜像单元测试，以实际 Electron 交互验证。
- KDE Wayland 中运行最终生产构建，默认 1080×720 预览显示正常；dark/light × 1320×880 / 980×680 四种布局均验证无横向溢出、两组导航独立滚动、滚动到底后分组标题和两个按钮仍可见且可点击。使用真实 Electron 指针输入打开并取消 API、订阅弹窗，未保存弹窗或登录账号。
- 验证使用新建独立资料目录和 24 个无凭据、停用的合成供应商，模型及工具绑定保持，网关未启动；没有修改真实用户资料或客户端配置。既有侧栏专项 smoke 在 XWayland 中通过；未运行完整端到端 smoke 或实际模型请求。
- Windows 标准目录 `release/win-unpacked` 已用最终构建更新；ASAR 内 15 个构建文件散列与本地一致，生产入口及测试代码剔除检查、SQL WASM 解包、EXE 七档图标资源检查通过。仅完成 Windows 打包和内容检查，尚未执行 Windows 实机界面验证。
- 本轮证据保存在 `/home/coco/Documents/Codex/2026-10-07/zh/work/model-dock-sidebar-actions-xCtu6R/sidebar-provider-actions-validation.json`、`work/provider-actions-sidebar-smoke/` 及 `work/provider-actions-windows-*.json`；界面截图位于同任务 `outputs/ModelDock-sidebar-actions-*.png`。此次未重新发布 Linux AppImage/deb。

## 0.3.32 默认窗口缩小

- 主窗口默认从 1320×880 改为 1080×720 DIP，面积约减少 33%；保留手动调整、最大化及 980×680 最小尺寸。账号、客户端配置和侧栏布局保持。
- 786 项测试通过、1 项既有 Windows symlink 权限细项跳过，类型检查、生产构建、生产入口剔除检查通过。没有为两项尺寸常量增加镜像单元测试，以实际 Electron 创建窗口验证。
- 源码与独立 Windows QA 包的初始窗口（未执行测试 resize 前）均读取为 1081×721，内容为 1066×684；DPR 1.5 的原生取整在 ±1 DIP 范围内。初始工具页的添加来源、连接方式、默认模型、配置预览及同步等主要操作可见；右侧列表正常纵向滚动。
- 原有 dark/light × 1320×880 / 980×680 四项侧栏独立滚动矩阵仍通过，验证结束恢复初始窗口尺寸和 UI。记录在 `work/default-window-v0.3.32/`、`work/default-window-release-v0.3.32/`；未修改真实账号或客户端配置，Linux 原生窗口尚未实测。

## 0.3.31 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.31 工具与供应商侧栏独立滚动

- 两组导航放入共享剩余高度的区域。工具保持自然高度但最多占该区域 45%，供应商使用其余空间；各自有独立滚动条和滚动边界，标题 sticky，品牌、六个功能入口和底部工作空间保持可见。字号与行高未压缩。
- 786 项测试通过、1 项既有 Windows 文件 symlink 权限细项跳过；类型检查、生产构建与测试代码剔除检查通过。仅改变导航布局，配置选择和同步行为保持。
- 源码与独立 Windows QA 包均以 24 个无凭据的合成供应商，在 dark/light × 1320×880 / 980×680 四种布局验证。DPR 1.5 下最小实际内容区域为 966×644，工具视口约 134px、供应商视口约 155px；两组同时溢出时分别显示滚动条，行约 33px、字体 12px，无横向溢出。
- 程序化滚动与实际 Electron 原生滚轮分别验证，独立手势只改变目标列表。实际指针点击可到达 Copilot 及最后供应商；分组标题、功能入口和页脚保持可见。工具品牌检查逐项滚动到可见范围后再解码，并复原滚动位置。
- 导航验证结束清理 24 个合成供应商，原供应商／模型／绑定及 UI 状态保持；未访问真实账号或修改客户端配置。记录位于 `work/sidebar-scroll-v0.3.31/` 与 `work/sidebar-scroll-release-v0.3.31/`，包含 `sidebar-scroll-validation.json` 和窗口截图。正式包仍为 production 入口，七档 EXE 图标检查通过；Linux 原生滚动尚未实测。

专项复现：

```powershell
npm run build
npm run verify:production
$env:MODELDOCK_SMOKE_SIDEBAR_ONLY='1'
node scripts/smoke-electron.mjs work/sidebar-scroll --no-build
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
node scripts/package-smoke.mjs release/win-unpacked work/qa-packages
# 使用上一条返回的专用 QA executable
node scripts/smoke-electron.mjs work/sidebar-scroll-packaged <专用QA.exe> --no-build
```

## 0.3.30 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.30 开源许可、发布边界与 Copilot 身份校验

- 按维护者选择添加自有代码 MIT 许可、第三方声明、安全政策及贡献指南。工具图标和四份原许可补充固定官方提交及逐文件散列，现有素材几何与版权文本未改。正式包包含自有许可及第三方记录。
- 生产、开发与 smoke 使用独立编译模式。生产主入口直接编译关闭开发 URL 和测试分支，删除旧 QA 入口／主进程 source map；`verify:production` 检查构建指纹和测试代码剔除，并加入 CI。正式发行 EXE 不能被原生 smoke runner 当作 QA 入口。
- Smoke 在打开 Electron 资料目录或数据库前核对独立 UUID 目录、runner PID、nonce、新鲜时间及两份 fixture 文件的散列，拒绝链接／硬链接／已有缓存目录。打包验证只修改 `work/` 中的独立 QA 副本及其 ASAR integrity，正式产物不改。
- Copilot 默认连接核对官方 Windows 程序的产品信息、有效 GitHub 签名、存活 PID 和回环监听端口归属，读取描述文件、连接后及配置写入前后重复验证。无法验证时关闭连接，不发送配置凭据；Linux／其他平台当前明确拒绝未经验证的原生桌面连接。
- 786 项测试通过，1 项需要 Windows 文件 symlink 权限的 POSIX 细项在 Windows 跳过；junction 和三项 hardlink 验证正常。类型检查、生产构建、发布入口检查通过。源码 QA 与独立 Windows QA 包通过实际界面、额度、头像及取消操作验证，记录在 `work/open-source-runtime-source/`、`work/open-source-runtime-qa/`。
- 实际正式 EXE 在隔离哨兵资料中携带伪造 DEV_URL / SMOKE / AUTH_MOCK / UPSTREAM 启动，仍加载内置文件界面，HTTP 网页请求为 0，供应商／模型／DSH 绑定保持原样、网关未启动。该启动检查使用本任务的隐藏实例，未结束用户正在运行的 0.3.29；记录在 `work/production-boundary-v0.3.30/production-boundary-validation.json`。
- 只读实机身份校验认可官方 Copilot 1.1.26 的两个回环端口，并拒绝临时 Node 冒充服务；没有读取运行令牌、连接 Copilot WebSocket、发送实际 API Key 或更改用户 Copilot 配置。
- 锁文件改为官方 npm 下载地址，原运行依赖／Electron／electron-builder 的版本与 integrity 保持一致；构建依赖 esbuild 与 global-agent 安全更新后 `npm audit` 为 0。Windows 全新依赖目录的 `npm ci --ignore-scripts`、测试、类型检查和生产构建／剔除验证通过，记录在 `work/clean-ci-*/`；这个本地检查不覆盖 Electron 安装脚本下载。Windows/Linux Node 24.13 CI 已配置，远端 CI 和 Linux 原生界面尚未在本轮执行。
- 保留已经推送的旧历史，以语义明确的新本地提交记录修复；本轮不强推、不修改仓库可见性。

复现：

```powershell
npm ci
npm test
npm run build
npm run verify:production
$env:MODELDOCK_SMOKE_COMPACT_ONLY='1'
node scripts/smoke-electron.mjs work/runtime-source --no-build
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
node scripts/package-smoke.mjs release/win-unpacked work/qa-packages
# 使用上一条输出的专用 QA executable 路径
node scripts/smoke-electron.mjs work/runtime-qa <专用QA.exe> --no-build
```

以下是历史版本的验证记录；旧版本直接运行正式 EXE 的 smoke 用法不适用于 0.3.30。

## 0.3.29 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.29 授权中心账号头像

- GitHub 新登录保存官方返回的 `avatar_url`；旧账号刷新额度时补取缺失头像，身份匹配及账号代际检查保护注销／重新登录。头像查询失败保留账号与额度结果，不把头像失败视为授权失败。ChatGPT / xAI 只读取现有授权资料中的头像字段，未增加额外账号请求。
- 账号行增加 32px 圆形头像；加载中、无字段或加载失败时显示首个 Unicode 字符。图片匿名加载且不发送页面来源，独立授权状态点与菜单保留。短套餐徽章完整显示，账号全名仍可由提示和详情查看。
- 757 项测试通过（36 文件），类型检查、生产构建及 Windows 目录包通过。URL 策略限定公开 HTTPS 来源和展示参数；覆盖恶意 URL、缺失元数据、旧账号补取、身份不匹配、头像失败及迟到响应不会覆盖新账号。
- 源码和实际目录包通过 10 次头像布局读回：本机合成 PNG 正常解码，HTTP 404 和无头像字段分别回退首字母。明暗主题、1320 / 980 宽度保持约 91 / 122 / 91 CSS 像素的三组高度，正文最小 12px，无横向溢出。
- 7 次合成图片请求均无 Referer、Authorization 和 Cookie；同页面缓存列表轮询不重新请求失败 URL。CSP 使用明确头像来源，不开放任意 HTTPS 图片。图片代理只存在于已核对的隔离 Electron 验证会话，并在 finally 中解除；生产程序不注册图片代理。
- 验证记录：`work/account-avatars-v0.3.29/`、`work/account-avatars-release-v0.3.29/`，包含 `account-avatar-validation.json`。Windows EXE 七档主图标资源检查通过。没有查询真实账号或照片，没有改变真实客户端配置；公开 GitHub 示例头像 HEAD 请求确认正常返回图片及 CORS，用户自己的照片和 Linux 原生界面未实测。

专项复现（PowerShell）：

```powershell
npm test
npm run build
$env:MODELDOCK_SMOKE_COMPACT_ONLY='1'
node scripts/smoke-electron.mjs work/account-avatars
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
node scripts/smoke-electron.mjs work/account-avatars-packaged release/win-unpacked/ModelDock.exe
```

## 0.3.28 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.28 Copilot 登录 HTTP 400 兼容修正

- 修正 GitHub 公共账号信息请求复用 Copilot 内部接口版本的问题：`/user` 单独使用公共 REST 版本 `2022-11-28`；额度接口保留 `2025-10-01` 和编辑器请求头。拿到令牌后读取用户身份明确标记为 `account-info`，界面显示「读取 GitHub 账号信息」，区别于令牌兑换。
- 仅设备码令牌轮询接受带已知 OAuth 错误的 HTTP 400 JSON：`authorization_pending` 保持等待，`slow_down` 增加间隔。其他接口／状态、HTML、畸形、未知或同时夹带令牌的错误响应仍停止；拒绝、过期、取消、读取大小限制和超时保持明确、安全的错误处理。
- 746 项测试通过（35 文件），类型检查与生产构建通过。两个回归分别先复现旧实现失败，再验证修正；33 项 Copilot 测试覆盖版本头分离、HTTP 400 的等待／终止边界、错误正文隐藏和取消后的迟到响应。
- Windows Electron 源码及目录包专项验证：HTTP 400 等待 → HTTP 400 放慢轮询 → HTTP 200 令牌，等待阶段继续保留验证码、不提前保存账号。实际放慢间隔约 6 秒；公共身份请求与内部额度请求分别核对版本，随后成功保存合成账号并显示 82% 模拟额度。正常刷新、缓存、旧结果、重置次数及注销保留其他平台仍通过。
- 授权弹窗图标统一采用灰色底与蓝色主题强调。记录位于 `work/copilot-login-http400-v0.3.28/` 和 `work/copilot-login-http400-release-v0.3.28/`。
- 证据边界：本机无凭据公共探测得到 GitHub 设备码轮询 HTTP 200 `authorization_pending`；公共 REST 无凭据探测未复现截图的 HTTP 400。模拟版本校验用于保护分离后的请求契约，不声称已复现真实账号失败原因。未读取用户令牌、未修改既有账号或客户端资料，真实账号恢复须在新版重新登录确认。

专项复现（PowerShell）：

```powershell
npm test
npm run build
$env:MODELDOCK_SMOKE_AUTH_QUOTAS_ONLY='1'
node scripts/smoke-electron.mjs work/copilot-login-http400
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
node scripts/smoke-electron.mjs work/copilot-login-http400-packaged release/win-unpacked/ModelDock.exe
```

## 0.3.27 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.27 Google Material Symbols 图标

- 导航、授权、用量、MCP、Skills、设置及弹窗统一使用本地 Material Symbols Rounded。52 个常规 SVG 与 9 个填充 SVG 来自固定 Google 官方版本，53 个组件别名保持现有操作；八个功能导航的选中图标显示为填充版本。品牌图标保留。
- 61 个 SVG 的 SHA-256、路径数量、路径数组和 viewBox 与来源清单、生成代码一致。素材、Apache 2.0 许可与选取清单保存在源码中；许可与清单同时包含在 Windows 目录包中。应用及生产构建无需 Google 字体或图标网络请求，删除原 Lucide 依赖。
- 739 项测试通过，类型检查、生产构建和 Windows 目录包通过。原生界面读取确认 43 种实际显示的图标、装饰性 ARIA、控件名称、主题颜色、选中填充路径和可绘制 SVG。
- 源码及目录包通过 1320 / 980 宽度、明暗授权页、账号菜单及弹窗验证；在隔离 Electron 会话禁用网络后巡回八个页面，图标正常。三组额度、两次重置、菜单操作及紧凑高度保持，无横向溢出。
- 修正 MCP / Skills 和弹窗中未带通用 button 类的主按钮，深色使用统一蓝色；空状态图标边框采用灰色。再次检查各页可见主按钮颜色。
- 实际 Windows EXE 的七档主图标资源校验通过。验证仅使用隔离数据、合成账号和本地模拟上游，未操作真实账号或客户端资料；Linux 原生效果尚未实测。记录位于 `work/material-symbols-v0.3.27/` 和 `work/material-symbols-release-v0.3.27/`。

专项复现（PowerShell）：

```powershell
npm test
npm run build
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
node scripts/verify-exe-icon.mjs release/win-unpacked/ModelDock.exe
$env:MODELDOCK_SMOKE_COMPACT_ONLY='1'
node scripts/smoke-electron.mjs work/material-symbols release/win-unpacked/ModelDock.exe
```

## 0.3.26 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.26 紧凑授权中心、黑灰主题与品牌图标

- 739 项测试通过，类型检查和生产构建通过；交互、配色和密度采用实际 Windows Electron 隔离验证。
- 授权中心压缩为平台标题与横向账号行，空分组不再占据大块空白。账号详情、重新授权、注销与删除通过「…」菜单访问；菜单键盘、Esc、取消操作、忙状态和焦点恢复验证通过。
- 1320 / 980 宽度下三个账号组完整显示，组高约 91 / 122 / 91 CSS 像素，正文最小 12px；四个额度条和两次可用重置保留，到期浮层不增加卡片高度。长账号名不导致横向溢出。
- 实测侧栏、主内容、卡片、菜单、输入、设置与弹窗为黑灰背景，强调色为蓝色。覆盖明暗主题及账号为空/已授权的场景，旧绿色的界面底色与强调色已替换。
- 新品牌资产由代码生成：SVG、512 PNG、托盘 PNG、16 / 24 / 32 / 48 / 64 / 128 / 256 ICO。窗口、托盘、网页及侧栏使用统一素材；Windows EXE 保留资源编辑、关闭签名。`verify-exe-icon.mjs` 对实际目录包的主 RT_GROUP_ICON / 七个 RT_ICON 逐字节校验通过，Windows 原生图标提取与视觉检查通过。
- 源码与目录包记录：`work/compact-neutral-v0.3.26/`、`work/compact-neutral-packaged-v0.3.26/`、`work/compact-neutral-release-v0.3.26/`；既有账号配置未改动，正在运行的用户 0.3.25 未结束或覆盖。Linux 原生窗口/托盘与 Windows 现有固定快捷方式的图标缓存未实测。

专项复现（PowerShell）：

```powershell
npm run build
npm test
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
node scripts/verify-exe-icon.mjs release/win-unpacked/ModelDock.exe
$env:MODELDOCK_SMOKE_COMPACT_ONLY='1'
node scripts/smoke-electron.mjs work/compact-ui release/win-unpacked/ModelDock.exe
```

## 0.3.25 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.25 用量查询与本地会话同步

- 739 项测试通过（35 个文件），类型检查、生产构建通过。覆盖小时趋势、香港/跨 DST 日期、精确状态码、分页、筛选范围导出、加权缓存命中率、缓存写入计价、历史模型定价与持久化事务。
- Codex 支持元数据检查点、累计高水位、分支回放、重复/截断导入、近期目录优先和写入中的文件暂缓。OpenCode V1 / V2 在内存中合并校验过的已提交 WAL；使用真实 SQLite 模拟事务验证原数据库、WAL、SHM 和目录哈希均未变化，未生成客户端旁路文件。
- 来源服务提供六项路径/格式/能力/状态和上次同步结果，重叠同步请求合并；构造和查看来源不触发导入。DSH / VS Code / Copilot 原生历史的当前限制明确显示。
- Windows Electron 源码与最终 `release/win-unpacked/ModelDock.exe` 专项验证通过：初次打开同步 31 条原生事件，重复同步不增加，分页 20 / 11 条、工具筛选、供应商/模型/定价页签、来源弹窗、历史价格、四项总览和 24 小时趋势；网关精确 429 筛选及已测完整请求速率与客户端事件分开计算。
- 合成输入 3,200、输出 625、缓存读取 660、缓存写入 40，总 Token 3,825、新输入 2,500、缓存命中率 20.625%；手工测试单价得估算 USD 0.03906。模型及单价均为隔离验证数据，未作为真实默认价格。
- 原生 1320×880 / 980×680 明暗截图检查通过，窄窗口卡片换行，趋势位于日志上方，页面正常纵向滚动，无横向溢出。记录位于 `work/usage-analytics-complete-v0.3.25/` 和 `work/usage-analytics-release-v0.3.25/`。
- 仅使用模拟会话与隔离目录；未读取真实会话、未修改真实客户端资料，未验证 Linux 原生界面和所有客户端版本。

专项复现（PowerShell）：

```powershell
npm run typecheck
npm test
npm run build
$env:MODELDOCK_SMOKE_USAGE_ONLY='1'
node scripts/smoke-electron.mjs work/usage-analytics
node scripts/smoke-electron.mjs work/usage-analytics-packaged release/win-unpacked/ModelDock.exe
```

## 0.3.24 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.24 三平台订阅额度与重置次数

- 711 项测试通过（32 个文件），类型检查、生产构建和 Windows 目录包生成通过。新增 Copilot 登录/额度、独立重置次数、默认零值协议兼容、到期过滤和缓存刷新相关验证。
- 对照 CC Switch 4.0.0 / 4.0.3 源码实现协议接入，并核对 OpenAI 与 VS Code 的第一方解析。ChatGPT 额度和重置次数独立查询；支持附加模型额度、有效重置次数及所有到期明细。Grok 保留严格已知形状的 protobuf 缺省零值，并在界面标注，结构不明时显示未知。
- Copilot GitHub 设备码登录、固定域名请求、账号去重、取消、迟到响应、退出后的缓存保护、401/403、超时、限量/不限量、AI Credits/旧版高级请求等验证通过；不声称未实现的自动续期。凭据由主进程加密保存，进入渲染器的 DTO 和原始 SQLite 文件均未包含明文测试 Token。
- 实际 Windows Electron 和最终 `release/win-unpacked/ModelDock.exe` 在隔离数据目录中通过：进入授权中心自动查询、Copilot 登录成功自动查询、四个额度进度条、倒计时、两次可用重置及到期展开、重复请求合并、缓存读取不重复请求、失败保留旧数据、未知次数不变成零和退出账号保留其他平台。
- 明暗主题、1320×880 和 980×680 原生截图检查通过；额度标题和数值分列、窄窗口操作换行、页面可纵向滚动且没有横向溢出。验证记录位于 `work/auth-quotas-verified-v0.3.24/` 与 `work/auth-quotas-packaged-v0.3.24/`。
- 验证全部使用合成账号与模拟上游，未写入真实客户端配置，未查询真实账号额度，未验证 Linux 原生界面或真实供应商推理。协议接入验证与真实账号可用性分开记录。

复现（PowerShell）：

```powershell
npm run typecheck
npm test
npm run build
$env:MODELDOCK_SMOKE_AUTH_QUOTAS_ONLY='1'
node scripts/smoke-electron.mjs work/auth-quotas
node scripts/smoke-electron.mjs work/auth-quotas-packaged release/win-unpacked/ModelDock.exe
```

## 0.3.23 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

## 0.3.23 官方配置还原、直连与 Codex 聚合选择

- 661 项自动化测试通过（30 个文件），类型检查和生产构建通过。新回归覆盖多供应商直连、Codex 单来源限制、精确模型白名单、空选择、默认模型验证、来源删除/合并/回滚和旧数据库语义保护。
- 五个工具提供明确的官方配置还原。Codex 清理模型选择、目录和地址覆盖；OpenCode 清理自定义来源及 Agent/命令模型覆盖；VS Code 清理自定义 Endpoint；DSH 还原原生模型覆盖；Copilot 通过原生接口清理自定义来源。测试验证备份、格式错误拒绝、并发文件保护、授权/MCP/其他设置保留和工具选择失败恢复。
- Windows Electron 隔离流程通过 Codex 直连替换、显式聚合、逐模型启用、目录与请求白名单、空选择、默认回退、新增模型不自动加入。真实文件还原操作验证 Codex、OpenCode、VS Code 和 DSH；五个工具的还原确认取消均不写入配置。
- 最终 `release/win-unpacked/ModelDock.exe` 通过相同专项流程，预加载、SQLite、网关模拟请求和 DSH 原生配置操作正常。验证目录为 `work/official-restore-release-verified-v0.3.23/`。首次启动抓图出现 `UnknownVizError`；同一目录包重试通过，未修改程序。Windows 完整 ZIP 的可执行文件与 `resources/app.asar` 解压流哈希与目录包一致。
- DSH 隔离流程验证单/多来源原生配置、协议和独立凭据引用、模拟推理、原插件与账号记录保护，以及官方还原后模型覆盖/禁用标记清理和加密备份。
- 同步状态的配置比对不再依赖字段插入顺序。明暗主题、1320×880 和 980×680 的实际 Electron 截图检查通过：模式、模型选择和还原操作可见，无横向溢出，还原对话框可操作。
- 所有测试使用合成凭据、模拟上游及独立数据/客户端目录。Copilot 官方还原的原生同步验证使用模拟原生接口；本轮未在真实用户 Copilot 资料目录中执行。Linux、真实供应商逐模型推理和真实客户端完整会话尚未验证。

专项复现（PowerShell）：

```powershell
npm run typecheck
npm test
npm run build
$env:MODELDOCK_SMOKE_TOOLS_ONLY='1'
node scripts/smoke-electron.mjs work/official-restore-tools
node scripts/smoke-electron.mjs work/official-restore-release release/win-unpacked/ModelDock.exe
```

专项流程仍实际验证 Electron 预加载、SQLite、回环网关和模拟请求，不修改真实客户端资料目录。完整旧功能冒烟需先移除 `MODELDOCK_SMOKE_TOOLS_ONLY` 环境变量。

## 0.3.22 验证记录

日期：2026-10-06（Asia/Hong_Kong）。

## 0.3.22 DSH 旧会话同模型兼容

- 用户确认切到 ModelDock 来源后可回复。错误来自已加载旧会话仍引用停用的 `deepseek-official`，不是来源认证失败。官方桌面会话选择接口没有 CAS / 运行中保护，且授权通道为私有桌面代理，因此不通过外部批量切换会话或直接改写聊天文件。
- 在独占模式下，只为已选 HTTPS 官方 DeepSeek API 来源的精确上游模型 ID 生成兼容映射；同名其他套餐、模型改名和不明确重复来源不映射。标准 native `insert` 加载固定可信 CJS 插件，仅注册 dispatch 适配器：模型列表为空，没有 configurable provider 或 settings namespace；不读凭据、会话或写入模型选择事件，不改请求对象。低层 `listProviders()` 必然含兼容路由，用于旧引用调用；Models 配置页和新选择器仍只显示所选来源。
- 无凭据插件脚本 `.modeldock/legacy-dispatch.cjs` 纳入第三文件事务，恢复日志升级 v3 并兼容 v1 / v2 两文件 pending。部分写失败恢复，源文件外部修改不覆盖；退出独占或清空时撤 native 插入入口，静态无凭据文件非活动保留以避免 HMR 完成前删除模块。
- 629 项测试通过（28 个文件）、类型检查和生产构建通过。覆盖精确同模型及官方来源边界、不可变请求、取消、模型代次变化、插件生命周期、三文件恢复与旧恢复日志升级。
- 使用**当前产品实际插件字节**及本机桌面 embedded 0.2.0-rc.2 原生模块隔离验证，22 项检查通过：同一个已存在原生 Agent 第一轮走旧 Messages，第二轮走所选同模型 Responses 成功；旧事件前缀和当前模型选择不变；Models 配置与可选目录仅包含所选来源；账号服务与合成授权保留；取消信号关闭下游连接，配置代次变化时不发请求；managed HMR 恢复来源标记。5 次请求全部发往本地 mock。证据为 `work/dsh-native-v0.3.22/product-compat-validation.json`，插件 SHA-256 与当前产品源一致。未操作真实会话 / 凭据 / home；未宣称原生桌面选择器已做可视验证。
- Windows 常用目录 0.3.22 包完整 Electron smoke 退出码 0，证据为 `work/dsh22-final/dsh-auto-config-validation.json`。真实 UI 用合成官方来源验证 keyless 静态脚本 / native insert / 两条同模型映射 / 三文件恢复日志关闭，以及退出兼容后的来源恢复；实际安装脚本 SHA-256 与上述原生测试一致。此 UI 配置验证未发送外部请求，已检查界面截图。首次 smoke 遇到 SQLite 临时文件 rename EPERM，换全新隔离目录重跑通过，没有将第一次失败记录为成功。

## 0.3.21 DSH 原生来源独占显示

- 修正 0.3.20 验证遗漏：其最小原生 fixture 只包含 pi-ai，未加载两个独立内置 DeepSeek 模型适配器。原生 Models 页合并 `llm.listProviders` 与 `llm.listConfigurableProviders`，因此仅替换 pi-ai 模型无法隐藏 DeepSeek API / 账号来源。
- DSH 新增默认开启的「仅显示所选供应商」。原生 patch 对实际模型适配器入口设置 `disabled: true`，保留独立 `deepseek-account` 平台授权服务。清空仍保持独占零来源；关闭范围会恢复先前 omitted / false / true / `!!js` 启用标记，旧 home 和下层 profile 来源可与所选 ModelDock 路由共存。保存范围只改变范围字段，不扩大旧模式 / 模型过滤。
- 新增独立隐藏只读 worker，使用实际安装的官方纯 profile 解析器识别三类模型插件、嵌套和改名条目，并读取不含凭据值的下层模型元数据。桌面 profile 优先实际桌面运行时，严格拒绝跳过 bundle、动态 / 内联认证元数据、配置歧义和缺失 canonical 核心插件。普通 DSH patch 无法创建缺失插件：原生验证证明仅填 name 仍会被忽略，因此此场景在任何写入前拒绝。worker 不启动插件、不读取凭据文件和会话；输出与时限受限，错误不回显原始配置。
- 619 项测试通过（27 个文件），覆盖范围持久化及无外部写入的迁移、旧 v1 恢复记录升级、插件标记与表达式恢复、账号服务 / 凭据保留、嵌套 / 改名模型来源、metadata 校验和错误边界；主进程与生产构建通过。
- 全新隔离原生 fixture 实际加载官方内置 API / 账号模型、平台账号、settings/config-editor、Loader/HMR。15 项检查通过：原生 registry 与按官方 Models 页算法得到的配置行仅包含所选来源，平台账号服务未销毁，合成已存授权和凭据文件原字节保持；恢复原来源标记、profile 回退及两个本地短流式请求通过。证据为 `work/dsh-native-v0.3.21/validation.json`。未操作真实账号 / 会话 / 凭据，未宣称原生桌面 UI 已可视验证。
- 实际用户 DSH home 已通过只读解析验证：桌面运行时 0.2.0-rc.2、三个模型适配器、四个下层 profile 来源，配置文件不写入。证据为 `work/dsh-native-v0.3.21/real-profile-read-only.json`。
- Windows 常用目录 0.3.21 包完整 Electron smoke 退出码 0。真实 UI 的范围切换、原内置来源停用与恢复、清空保持零来源、账号服务和凭据保留、旧绑定过滤保留均通过；已检查 1320 / 980 界面截图。证据为 `work/dsh-exclusive-v0.3.21-packaged/dsh-auto-config-validation.json`。打包后的独立 worker 也只读解析真实 DSH home 成功（实际 desktop 0.2.0-rc.2），证据为 `work/dsh-native-v0.3.21/packaged-profile-read-only.json`。生产构建与开发启动均包含该 worker；未自动写入用户真实配置。

## 0.3.20 DSH 一键配置

- DSH 改为勾选 / 取消来源及更改默认模型后自动应用，复用全选、清空和重新同步。主进程单独写入 `DSH_HOME`（默认 `~/.dsh`）的 `cordis.patch.yml` 与 `.credentials.yaml`；通用适配器明确拒绝错误调用路径，避免写入 Codex 文件。全局删除供应商同时更新已关联的 DSH 配置。
- 原生覆盖使用 `llm-pi-ai` 的供应商路由及 `agent-default-model`，混合接口按路由拆分。API 来源使用上游 ID 和各自 Key，订阅仅发布本机入口与本地 Key。密钥存储为本地 refs，不出现在模型 YAML 或预览；不发布订阅 OAuth。
- 两文件在写入前加密备份与保存待恢复日志，部分失败按原字节恢复；外部并发修改冲突不覆盖，保留恢复记录。同步幂等；清空恢复原 home 插件覆盖和托管 refs，其他插件、profile 文件、凭据和会话保留。新建文件清空后可留空 YAML，不删除整个 DSH 资料目录。链接路径、损坏 YAML 与恢复记录在写入前拒绝，错误不回显凭据。
- 589 项测试通过（26 个文件），类型检查和生产构建通过。DSH 测试覆盖混协议、默认模型、订阅密钥边界、原配置 / refs / 注释保留、失败恢复、两文件提交之间的并发修改、崩溃恢复、幂等与链接路径保护；供应商删除的 DSH 修复路径也通过。
- 已使用本机官方 CLI / adapter 0.1.7-rc.2 的 Loader、HMR、credentials-local、llm-pi-ai 与默认模型插件进行隔离原生验证：实际 desktop / web / ACP 的配置行一致，refs 解析、所选路由和默认模型读取通过；本地回环 mock 的 Chat Completions / Responses 两次原生流式调用均返回 OK；热更新新增模型及默认选择生效，移除 home 覆盖恢复原 profile。证据位于 `work/dsh-native-v0.3.20/validation.json`。未更改真实 DSH 资料、读取用户会话或调用外部供应商；未宣称原生桌面模型选择器已可视验证。未启用 HMR 的 DSH 需重启，已有会话需切换或新建。
- Windows 常用目录 0.3.20 包完整 Electron smoke 退出码 0：真实界面勾选 / 默认模型 / 取消 / 清空各只写入一次，路由与 refs 回读一致，原覆盖和无关凭据恢复通过；1320 / 980 布局和重新同步控件可见、无横向溢出，已检查截图。证据位于 `work/dsh-v0.3.20-packaged/dsh-auto-config-validation.json`；从生成配置发出的本机 mock 请求返回 HTTP 200，此界面验证与上述原生 DSH 验证分开记录。

## 0.3.19 工具图标

- Codex、OpenCode、DSH、VS Code、Copilot app 的侧栏和工具页顶部改用本地 SVG 标志，替换字母占位；共享装饰图标组件，邻接工具名保留可访问标签。CSS 遮罩沿用主题色，不加载远程图片。素材来源和许可记录在 `src/renderer/assets/tool-icons/NOTICE.md`，许可文本随 Windows 包发布。
- 571 项现有测试、类型检查与生产构建通过。打包界面的五个侧栏图标和 Copilot 页头图标在浅色 / 深色、1320 / 980 两种窗口宽度下本地解码成功、尺寸可见且没有横向溢出，已检查截图；验证只临时切换测试窗口主题 / 导航，未保存设置或触发配置同步。Windows 恢复窗口尺寸允许每维 1px DPI 舍入。
- Windows 常用目录的 0.3.19 包完整桌面 smoke 退出码 0，renderer / preload 和本地模拟网关通过。证据位于 `work/tool-icons-v0.3.19-final/tool-icons-validation.json` 及同目录四张图标截图；许可文本确认发布在 `release/win-unpacked/resources/licenses/tool-icons`。

## 0.3.18 批量选择、全局删除与 Copilot 旧配置清理

- 工具页补齐删除入口、全选可用来源和清空选择。全选 / 清空覆盖搜索外来源，单次保存并同步；全选排除未授权、停用及无兼容模型的来源。删除是明确的全局操作，保存加密备份并同步关联工具；失败恢复该来源、模型、凭据与受影响绑定，不覆盖无关日志或并发编辑。
- Copilot 新增默认开启的「仅保留所选供应商」。原生同步清理旧自定义来源，保护 GitHub 内置模型与账号。Windows 仅捕获已核实供应商 UUID 的两个精确系统凭据目标，备份原始字节和恢复元数据，不解码或展示凭据；恢复原字节及原生供应商 / 模型配置。Linux 未验证对应备份接口，拒绝不安全清理。聊天正文不删除，来源被删除时旧会话的来源外键关联可能解除，配置恢复不等于整个应用状态回滚。
- 原生读取只在精确的凭据工作队列繁忙错误下有限退避；正常同步减少为前后各一次供应商列表查询，中间使用写入回执核对。写请求不盲重试，不将凭据读取错误当成凭据丢失。
- 已在独立 Copilot 1.1.26 实例使用随机 UUID / 合成凭据验证原始凭据字节捕获、删除、恢复及模型元数据回读；未读取真实用户凭据字节或操作真实配置。
- 571 项测试通过（25 个文件），类型检查和生产构建通过。覆盖批量操作相关绑定范围、删除 checkpoint 备份与冲突恢复、原生仅保留所选范围、opaque 凭据格式 / 目标限制 / 原字节恢复、凭据队列繁忙有限重试及写入不重试，以及无关大型会话广播的过滤。
- Windows 0.3.18 常用目录包通过完整原生流程，退出码 0。隔离 Copilot 1.1.26 实例实际验证：仅选一个来源并切换所选范围后，旧自定义哨兵被移除；搜索只显示一个来源时，全选仍包含全部 12 个可用来源且只同步一次；清空与零选择重试均通过。真实 React 删除确认流程验证无凭据 / 无模型来源可删除，以及全局删除已关联来源后 Copilot 原生注册表与 VS Code 文件都更新，其他来源和模型保留。1320 / 980 控件无横向溢出，窄窗口供应商列表可滚动，删除、全选、清空、范围选项均可见，已检查截图。证据位于 `work/copilot-controls-packaged-final-4/copilot-native-sync-validation.json`；未登录隔离资料没有 GitHub 账号，账号保护由模拟原生测试覆盖，不虚构登录账号。发布路径为 `release/win-unpacked/ModelDock.exe`。

## 0.3.17 Copilot app 原生自动同步

- Copilot app 从手工导出改为自动同步：应用运行时，勾选 / 取消来源或改变 ModelDock 首选模型，使用本机原生 WebSocket 接口更新供应商、模型及其系统凭据。API 来源独立直连，订阅只使用本地 Key 与别名，不复制 OAuth 令牌；同模型 ID 可分来源注册，逐模型支持 Chat Completions / Responses，稳定 UUID 标识本资料目录中的托管项。
- 同步只管理具备所有权记录的来源，保留 GitHub 账号、外部原生来源、MCP 与聊天历史，不主动切换已打开聊天。取消只清理托管供应商、模型和对应原生凭据，不执行 VS Code 的全 `customendpoint` 清理规则。未运行时选择仍保存并报告失败，启动后可重新同步；没有后台启动或排队机制。
- 预览 / 导出 `modeldock-copilot-desktop.json` 是原生同步计划参考，不是桌面 JSON 导入格式或 SDK 生产配置。运行实例信息来自 `COPILOT_HOME` 对应的资料目录；不直接写 Copilot `data.db`，不读取 OS secret 原值，也不复制整个数据库或对话历史。
- ModelDock 自身管理记录保存加密的上次成功计划与待恢复所有权；写入前创建加密私有备份，仅包含原托管元数据、已知旧密钥与恢复信息。部分同步失败尝试回滚；回滚失败保留恢复记录，下次先恢复。缺少旧密钥、资料目标 / 所有权 / 元数据校验失败时，原生写入前拒绝修改。回滚读取加密旧计划中的密钥，不猜测或读取外部系统凭据。
- 已只读核对本机 GitHub 签名的 1.1.26 二进制与原生协议，并在独立 Copilot 资料实例使用合成凭据完成供应商 / 模型创建、更新、清空和凭据删除检查；删除后同 UUID 无凭据重建回读 `hasSecret: false`，确认清理系统凭据。未改变真实用户 Copilot 配置、账号或聊天。
- 527 项测试通过（23 个文件），类型检查和生产构建通过。覆盖原生接口认证 / 元数据 / 超时 / 所有权 / 脱敏，计划稳定 UUID、同名模型与协议映射，加密备份、部分写入回滚和下次恢复。
- Windows 0.3.17 常用目录包通过完整原生流程，退出码 0、本地模拟请求 HTTP 200；实际 React 勾选逐步同步到运行中的隔离 Copilot 1.1.26 实例：三来源五模型、不同源同名 ID、Chat / Responses 逐模型协议、独立原生凭据与订阅本地别名均回读正确。首选偏好变化与重复同步保持配置语义；逐项取消至零只清理托管项，外部哨兵供应商保留，最后清理所有测试项。980 / 1320 原生截图控件可见且无横向溢出，已检查截图。证据位于 `work/copilot-auto-sync-packaged-final/copilot-native-sync-validation.json`；发布路径为 `release/win-unpacked/ModelDock.exe`。
- Linux 原生 Copilot 桌面 / 凭据存储未验证，真实用户 Copilot 尚未修改，真实上游推理未测试；模拟 WS 测试、隔离原生实例和实际账号调用分别记载，不据来源可见性宣称模型可用。

## 0.3.16 VS Code 仅保留所选自定义来源

- 用户文件中原有四个 `customendpoint` 分组，各含 7 / 9 / 5 / 5 个模型，共 26 个历史模型；另外还有所选的「ModelDock · 火山 Agent Plan」三个模型。0.3.15 只替换 ModelDock 前缀分组，因此取消 ModelDock 来源并不会移除那些独立配置的历史来源，这是仍显示未勾选模型的原因。
- 按用户明确选择的“仅保留所选”范围，已先备份真实 `Code/User/chatLanguageModels.json`，再仅保留火山 Agent Plan 的三个模型。保留分组的凭据和模型内容未改。备份为 `%APPDATA%/model-dock/backups/vscode-selected-sources-1791272991762-e9522fb0.bak`；此记录不包含密钥或原文件正文。这证明配置文件已修复，不代表 VS Code 已重新加载或真实模型推理通过。
- 新增 VS Code 绑定范围 `vscodeSyncScope`：`selected` 为新绑定和缺少该字段旧数据的默认值，数据库迁移只登记范围，启动不改客户端文件；`managed` 为显式保留其他自定义来源的选择。工具页「仅保留所选供应商」切换后保存并自动同步，不改变原模型过滤和接入模式。
- `selected` 先备份，再替换该文件全部 `vendor: "customendpoint"` 分组；全部取消时清空这些自定义来源。其他 vendor 与 JSONC 注释保留，内置模型仍由 VS Code 管理。`managed` 延续旧行为，只替换 / 清理 ModelDock 分组。OpenCode、Codex、DSH 和 Copilot app 的同步范围不变，不按此规则清除其非受管来源。
- 默认目标仍为 `Code/User/chatLanguageModels.json`，其他 VS Code profile 需手工合并。同步仅注册模型来源；ModelDock 首选模型不会切换已打开聊天的当前模型，实际模型仍须在 VS Code 选择器中选择。
- 464 项测试通过（21 个文件），类型检查和生产构建通过。新增同步范围默认值 / 迁移 / 持久化 / 非法值、明确保留旧分组、清理所有自定义分组、空选择、其他 vendor 同名项、注释与备份保护回归。
- Windows 0.3.16 常用目录包通过完整原生流程，退出码 0、本地模拟请求 HTTP 200。隔离文件复现四个旧自定义分组：明确 `managed` 时保留；界面开启「仅保留所选供应商」后自动仅发布一个所选来源，保留非 customendpoint 项、绑定范围、注释和备份；取消全部选择时清空自定义分组，重复同步保持幂等。浅深主题 980 / 1320 布局无横向溢出，已检查原生截图；旧绑定、Codex / OpenCode、授权 / 网络诊断、模型目录和设置流程亦通过。证据位于 `work/vscode-exclusive-packaged-final/`，专项记录 `vscode-exclusive-validation.json`；发布路径为 `release/win-unpacked/ModelDock.exe`。
- 真实用户文件修复、隔离配置场景与真实推理分别记录；本轮不据配置写入宣称真实客户端加载或火山套餐调用成功。Linux 原生运行未验证。

## 0.3.15 工具勾选与自动同步

- 工具页用供应商行左侧复选框和顶部默认模型选择替代接入模式 / 绑定弹窗。VS Code、OpenCode、Codex 的修改会自动保存并同步到客户端配置；取消勾选也会自动清理相应分组。旧绑定读取保留原模式与部分模型范围，可以先点击「重新同步」应用现有选择。DSH / Copilot app 仅保存选择并导出，不自动写入客户端文件。
- 自动连接策略按客户端能力分组：支持多端点的工具分别配置 API 来源的真实地址、独立凭据与上游模型 ID，订阅经本机入口管理授权；Codex 仅一家 API 时直连，多来源或订阅时自动使用单一聚合入口和唯一模型别名，仅发布 Responses 模型。必要时同步自动启动回环网关；预览 / 快照不返回上游凭据或旋转中的 OAuth 令牌。
- VS Code 默认目标是 `Code/User/chatLanguageModels.json`；其他 profile 需手工合并。同步只注册模型来源，不切换打开聊天的当前模型，实际模型须在 VS Code 选择器选择。VS Code / OpenCode 保留非受管供应商、MCP 与 JSONC 注释；Codex TOML 保留配置字段，不保证原注释。写入前保留备份，选择和同步状态分别显示；同步失败不会假称配置已写入，可通过「重新同步」重试。
- Codex 最后一个来源取消后，移除 ModelDock 供应商，恢复首次接入前的模型、供应商和目录；无恢复记录的旧接入退回原生默认。用户已切换其他供应商时不覆盖其当前选择。只删除确认属于 ModelDock 且不再使用的生成目录，原有目录、MCP 和其他供应商保留；重复清理保持幂等。
- 本版新增隔离原生场景：两个合成 API 来源共享上游模型名，验证勾选 / 默认模型即时同步、独立来源凭据、真实上游 ID、跨源别名、VS Code / OpenCode 撤选清理及注释保留；Codex 聚合五个模型后经单 API 再清空，核对恢复原始模型 / 供应商 / 目录、MCP 保留与生成目录删除。四张浅深主题 980 / 1320 截图及配置目标均位于隔离 `feature-home` / `feature-appdata`，不使用真实客户端 profile。
- 459 项测试通过（21 个文件），类型检查和生产构建通过。打包版额外验证旧部分模型绑定：只改默认值保留原模式与两模型过滤；删除旧范围最后一个模型后，预览和重新同步保持停用状态，不引入同来源的两个未选模型。
- Windows 0.3.15 常用目录包通过完整原生流程，退出码 0，本地模拟网关请求 HTTP 200。勾选 / 默认模型即时写入、撤选清理、Codex 原选择恢复及重复同步均通过；浅深主题 980 / 1320 布局控件可见、无横向溢出，截图已人工检查。模型发现、授权 / 网络诊断、用量、设置等既有流程也通过。证据位于 `work/tool-selection-packaged-final/`，主记录为 `tool-selection-validation.json`；发布路径为 `release/win-unpacked/ModelDock.exe`。
- 本轮未验证真实客户端加载、真实上游推理、DSH / Copilot app 手工导入或 Linux 原生运行；配置自动写入与模拟请求成功不能代替这些验证。

## 0.3.14 当前应用会话的授权网络诊断

- 用户新截图确认 0.3.13 仍出现 Grok discovery 网络错误，因此旧启动路径不能解释此次失败。新增 `probeAuthNetwork` 受主窗口 / 主框架验证的 IPC，从当前 `defaultSession.resolveProxy` 获取路线，并用同一 Session 的网络读取固定官方公开发现地址；代理同值保存也重新应用，不主动关闭现有连接。
- 诊断显示已保存的本机代理、直连 / 代理 / 未知路线、HTTP 状态、白名单错误码和耗时；完整 10 秒上限覆盖路由解析、响应头和正文，正文上限 64 KiB。验证 issuer 与官方 HTTPS 端点，拒绝重定向和无效响应。不会请求任意用户提供的地址，不读取账号凭据、Cookie 或原始错误正文。登录失败 DTO 也增加安全网络错误码。
- 423 项测试通过（20 个文件），类型检查和生产构建通过；新增 25 项诊断测试覆盖路由、Cookie / 凭据不发送、控制错误码、HTTP、严格发现文档、大小和不协作超时，登录错误码回归通过。
- 使用生产诊断函数、生产网络包装及原生 Session 在隔离资料中实测本机 Windmill HTTP 代理：路线 `proxy`，HTTP 200，有效官方发现文档，约 929 ms；结果位于 `work/auth-network-live/validation.json`。这是公开服务连接验证，没有实际账号登录，也不等同于用户原运行实例已使用该设置。
- 0.3.14 常用目录包通过完整原生流程，网络 UI 代理重复应用、成功 / 失败诊断替换、`ERR_CONNECTION_RESET` 展示、1320 / 980 无溢出，以及旧登录 / 模型 / 用量 / 设置回归通过。结果位于 `work/network-diagnostic-packaged/`；发布路径为 `release/win-unpacked/ModelDock.exe`。
- 仍需用户在实际运行实例点击「检测连接」取得当前路线和错误码，才能定位持续出现的登录失败。真实浏览器授权、令牌交换、模型权限和 Linux 原生运行没有在本轮验证。

## 0.3.13 Grok 服务发现网络与准备登录

- 同机公开发现地址 `https://auth.x.ai/.well-known/openid-configuration` 对照：系统会话解析为直连，原生网络约 12 秒超时，Node 直连失败，curl IPv4 也超时；使用用户正在运行的 WindmillVPN 本机 HTTP 代理 `http://127.0.0.1:20081` 后，原生请求约 810 ms 返回 HTTP 200，issuer 与官方设备授权 / token 地址均正确。只请求公开资料，未读取账号凭据或创建登录令牌，未修改系统代理或 VPN 模式。结果位于 `work/grok-network-check/validation.json`。
- 新增应用内代理设置，空值跟随系统；本机 HTTP / HTTPS / SOCKS5 地址严格限制字面回环主机与明确端口，拒绝远程地址、用户信息、查询、片段和路径。设置规范化保存、旧配置默认系统模式，原生应用失败回退旧设置。不会主动关闭现有连接；退出后重新打开继续读取本机设置。
- 点击登录立即显示 discovery / device-code 准备弹窗、进度和取消按钮；启动返回、轮询、取消均检查当前供应商与前端代次，避免旧返回复活窗口或覆盖新登录。申请阶段没有设备码时不提前显示官方验证链接。
- 397 项测试通过（19 个文件），类型检查和生产构建通过。代理校验 / 适配器 66 项，设置迁移、持久化、非法地址保留原状态及旧功能回归通过。
- Windows 最终目录包通过完整隔离 UI：代理保存 / 拒绝 / 清空、1320 / 980 布局；100 ms 后准备窗口可见、申请中取消及迟到响应忽略；服务发现网络错误正确显示；模拟 Grok 设备码、官方链接、点击外侧继续等待和显式取消停止轮询通过。测试只使用合成授权。初版 1 秒延迟夹具在截图期间进入轮询，延长为 3.5 秒并在取消前再次断言 discovery 状态，避免混淆测试阶段。
- 发布路径为 `release/0.3.13/win-unpacked/ModelDock.exe`，最终原生结果位于 `work/grok-login-packaged-final/`。真实账号浏览器授权与最终令牌交换、真实模型权限及 Linux 原生运行尚未在本轮验证。
- 再次报错后检查发布包：常用 `release/win-unpacked` 仍是 0.3.12，版本目录才是 0.3.13。已确认常用目录无运行进程后同步 0.3.13，避免旧入口缺少代理设置；同步后的包通过完整原生回归，结果位于 `work/grok-primary-path-final/`。这证明发布入口一致，不据此断定截图实际运行的是哪个版本。

## 0.3.12 Codex 已登录后模型目录 HTTP 400

- 对照 CC Switch `d455dd85720a4e48a59d02396539b480d9767902` 的 `services/codex_oauth_models.rs` 和 OpenAI Codex 的模型请求源码，原兼容目录请求缺少 `client_version`。现在使用独立兼容版本 `0.159.0`，query 与版本头一致，目录携带 `originator`、账号头，并保持透明的 ModelDock User-Agent。该版本是当前参考值，不作为永久最低版本说明；现有设备码授权保持原兼容路径，没有混换为新的 SIWC 公开 API 流程。
- 原生 Codex 目录解析优先安全的 `slug`，支持数组 / items / 模型映射；展示名称、上下文、输入模态及明确并行工具能力正常。`visibility: hide / none` 不进入新候选，既有模型保留；`supported_in_api: false` 不等同于订阅不可用，不据此删除候选。
- Codex 分页要求相同来源、模型路径和固定的唯一兼容版本，拒绝版本篡改、重复以及额外敏感查询。普通 API、Grok 目录和 Codex 推理请求不添加目录 query。获取失败清理旧缓存，不允许继续导入旧候选。
- 329 项测试通过（18 个文件），类型检查、生产构建和 Windows 0.3.12 打包通过。模拟 HTTP 服务复现无版本参数返回 400、正确请求返回 200；原生模型字段、隐藏项、分页和其他供应商回归均通过。
- 最终 Windows 包通过完整隔离 UI：已模拟登录的 Codex 来源发出正确 GET，显示 1 个原生候选并排除 hide / none；272K 上下文、工具 / 图片能力和 Responses 正确。UI 添加成功，第二次获取显示已添加并禁用重复操作；两次模拟 GET，未触发真实推理。980 / 1320 截图无溢出。结果位于 `work/codex-catalog-packaged/`。
- 尝试现有登录的只读检查，隔离进程无法解密应用的 OS 凭据，因此没有完成真实目录验证；随后通过应用桥的检查也未完成。没有导出令牌，没有更换用户凭据或添加真实模型，临时加密元数据副本已清理。真实账号目录、实际模型推理和 Linux 原生运行仍需分别验证。

## 0.3.11 对照 CC Switch 的 OpenAI / xAI 鉴权

- 参考 `work/references/cc-switch` 的 `d455dd85720a4e48a59d02396539b480d9767902` 提交：OpenAI 和 xAI 自管授权均采用设备码，OpenAI 在设备轮询后交换授权码及 PKCE verifier；ModelDock 已使用相同的公共客户端和端点。
- xAI 的 OIDC issuer 必填并核对官方地址，续期显式携带原 scope。scope 省略本身可按 OAuth 标准继承原范围，此项是参数对齐，不作为已证实的旧版故障原因。ID Token 经凭据 codec 保存，界面只读取安全账号元数据；Grok 的稳定身份优先来自 ID Token `sub`，OpenAI 继续使用 workspace 账号 ID。
- 续期网络错误、超时、429 和 5xx 保留原授权状态；明确失效的授权仍报错。设备轮询的拒绝、过期和无效令牌优先于 HTTP 重试，防止携带终止错误的 503 被继续轮询。
- 显式导入前取消旧登录、续期和额度查询，增加查询 epoch；续期响应提交前比对原 access / refresh 凭据，旧成功或旧 401 都不会覆盖、降低新账号状态。原客户端文件保持不变。
- 316 项测试通过（18 个文件），类型检查和生产构建通过。新增模拟覆盖两种供应商协议、缺少或错误 issuer、ID Token 元数据与持久化、令牌轮转、同身份导入、过时刷新成功 / 401、旧额度晚到 200 / 403、临时续期失败及终止错误。
- Windows 0.3.11 最终目录包通过完整隔离流程，包括真实 SQLite 保留合成 ID Token、安全账号 DTO、设备等待 / 完成 / 取消、剪贴板和遮罩回归及旧功能。结果位于 `work/auth-ccswitch-packaged/`，仅使用合成授权，不操作真实账号。
- 接入差异保持明确：此 CC Switch 的 xAI OAuth 推理与模型目录默认走 `https://api.x.ai/v1`；ModelDock 的 Grok Build 默认走官方 CLI 推理代理，保留原来源地址，没有自动迁移或混用两条链路。本轮未证明真实账号在任一路径上的模型权限，也未做 Linux 原生验证。

## 0.3.10 验证码复制与授权遮罩

- 287 项测试通过（18 个文件），类型检查、生产构建和 Windows 0.3.10 目录打包通过。新增复制边界覆盖 UTF-8 大小、非法类型、NUL、异步写入完成与脱敏失败信息。
- 普通复制通过受窗口和主框架验证的主进程 IPC；没有向界面开放剪贴板读取。验证码、API 入口、配置内容复用此接口；本地密钥复制也等待原生异步写入完成后再提示。
- Windows 最终包的完整隔离流程实际点击「复制验证码」，从原生剪贴板读回相同合成设备码；中文多行内容保持一致，8 种非法输入拒绝且不改剪贴板。原剪贴板可读格式只在内存中保存并原子恢复，期间外部新复制内容保留，不输出或记录原内容。
- 原生鼠标点击等待框外侧，验证码保持可见，轮询从 1 次继续到 3 次；第四次模拟授权完成正常。另一个无凭据测试来源点击「取消登录」后关闭窗口、停止轮询且没有晚到的凭据写入。关闭按钮和 Escape 保留显式取消语义。
- 980 / 1320 窗口截图检查通过，验证码、官方页面链接和取消按钮可见，无横向溢出；其他供应商、模型、连通性、用量和设置流程通过。结果位于 `work/auth-clipboard-packaged/`。
- 本轮只使用合成授权与隔离数据库，不发起真实账号登录。Linux 原生剪贴板和桌面运行尚未在本轮验证。

## 0.3.9 Codex 等待授权 403

- 同机公开设备码申请返回 200；未输入验证码的一次实际轮询返回 JSON 403，安全提取的错误码为 `deviceauth_authorization_pending`。只打印安全的响应结构和错误标识，没有输出或保存设备码、响应正文、账号凭据。
- 277 项测试通过（17 个文件），类型检查和生产构建通过。只在 Codex 的 JSON 403 / 404 设备令牌轮询中识别该具体等待状态；真正拒绝、地区限制、设备权限、HTML 拦截和过期保持终止行为，不扩展到设备码申请或 Grok。
- 本版授权管理器通过系统网络进行内存隔离实测：两次未授权轮询后仍是 `pending / device-poll`，同一验证码和官方验证页保留，凭据写入为 0，然后取消；未替用户完成浏览器授权。
- 隔离 Windows 原生流程复现三轮相同 JSON 403 后完成 PKCE 模拟授权：前两次观察保持同一模拟验证码、复制按钮和官方链接，不提前写凭据；第四次成功后才保存合成授权并显示完成。980 / 1320 窗口无溢出。
- Windows 0.3.9 最终目录包通过同一完整流程，结果位于 `work/auth-pending-packaged/`；旧授权诊断、供应商 / 模型管理、连通性、用量和设置检查均通过。
- 真实本人账号输入验证码与授权完成、所有模型实际权限以及 Linux 原生运行仍需分别验证。

## 0.3.8 Codex 授权 403 与系统网络

日期：2026-10-06（Asia/Hong_Kong）。

- 已在同机仅使用公开 client_id 对照设备码申请：Node 直连返回 JSON HTTP 403，错误码 `unsupported_country_region_territory`；Electron 遵循现有系统网络设置，返回 HTTP 200 并包含有效设备码字段。未输出或保存设备码，没有读取用户凭据，也没有完成本人账号登录。
- 进一步用本版 `OAuthManager` 和生产系统网络包装进行内存隔离检查，正常进入 `device-poll` 并收到设备码 / 官方验证页；立即取消，凭据写入为 0。该检查没有打开浏览器或替用户完成授权，输出仅保留布尔验证结果。
- 274 项测试通过（17 个文件），类型检查和生产构建通过。授权请求、额度查询、模型目录、测试与网关使用注入的系统网络实现；Cookie 不继承，重定向不自动跟随。Electron 响应的 URL 元数据经安全归一化，保留状态、响应头与流式正文，不改变适配器发送前的地址校验。
- Windows 原生本机 HTTP 验证：系统网络包装后的 JSON、Authorization 请求头、SSE 分块和重定向拒绝正常，未发送 Cookie，重定向没有第二次请求。
- 授权回归覆盖具体步骤、嵌套错误、地区限制、设备码权限、HTML 拦截、正常轮询 403 / 404、410 过期、PKCE 换令牌、原有效账号保护、大小限制和完整超时。错误正文及令牌不会进入前端诊断。
- 隔离 Electron 界面验证模拟申请设备码 403：准确显示 `device-code / region / HTTP 403`，无验证码、无凭据或模型写入；可前往授权中心，只检查导入入口而不读取客户端文件。980 / 1320 窗口无溢出。
- Windows 0.3.8 最终目录包通过完整原生流程，授权诊断及前往授权中心正常，旧供应商、模型、连通性、用量和设置流程通过；结果位于 `work/auth-network-packaged/`。
- 真实账号完成浏览器授权、所有真实供应商推理，以及 Linux 原生系统网络与桌面运行仍需分别验证。系统代理配置未被修改。

## 0.3.7 一键首模型连接测试

日期：2026-10-06（Asia/Hong_Kong）。

- 253 项测试通过（16 个文件），类型检查和生产构建通过。默认模型严格按当前供应商列表顺序取第一条，包括未启用的模型；测试不修改启用状态。
- 测试图标直接发起推理请求，卡片右侧显示默认模型，结果与 HTTP / 耗时在卡片内更新，不再打开选择弹窗。没有模型时按钮禁用并就地提示；删除第一条模型后标记和测试自动使用下一条。
- 隔离 Windows 原生流程验证供应商详情、聚合页、工具页的默认标记，首条停用模型、同 tick 双击、首模型协议修改、删除后回退、401 及重试。实际共 6 次推理 POST、0 次目录 GET；双击没有产生第二次调用，全程无弹窗。
- 1320 / 980 窗口截图检查通过：默认模型位于测试按钮下方右侧，标记、结果和操作按钮均在视口内，工作空间底部保留。未使用真实用户凭据或数据库；真实套餐与 Linux 原生运行未在本轮验证。
- Windows 0.3.7 目录包通过同一完整流程，默认首模型、删除回退及 401 重试均无弹窗；模拟网络计数精确为 6 次 POST / 0 次目录 GET。结果位于 `work/connection-inline-packaged/`。

## 0.3.6 独立模型调用连接测试

日期：2026-10-06（Asia/Hong_Kong）。

- 251 项测试通过（16 个文件），类型检查和生产构建通过。新增 31 项覆盖无目录供应商、手写模型、已有模型归属与协议、订阅适配、JSON / SSE、HTTP 错误、HTML 假成功、流式错误、输出上限、重定向、超时及响应边界。
- 「测试连接」不调用目录模块；对所选模型发出最小推理 POST，复用主进程凭据与订阅续期。只有获得有效推理结果才成功；未完成的输出预算情况单独说明。模型 ID、协议、状态和耗时可见，响应正文和凭据不返回前端。
- 原生 Windows 隔离测试使用 `/models` 恒 404 的本机模拟套餐：手写 Chat、手写 Responses、已有模型三次调用通过，错误密钥及重试均返回 401；共 5 次推理 POST，0 次模型目录 GET。没有模型时也可测试，调用不会自动新增模型。
- 1320 / 980 窗口测试弹窗检查通过，按钮、表单和结果无溢出，固定底部可见。未访问真实用户凭据或供应商；真实套餐权限与 Linux 原生运行未在本轮验证。
- Windows 0.3.6 最终目录包通过完整原生流程，`work/connection-test-final/connection-network-validation.json` 记录 5 次推理 POST / 0 次目录 GET；旧模型、供应商整理、设置和用量流程同样通过。

## 0.3.5 供应商与工具用量视图

日期：2026-10-05（Asia/Hong_Kong）。

- 220 项测试通过（15 个文件），类型检查和生产构建通过。新增回归覆盖供应商 / 工具 / 模型交叉筛选、历史和已移除来源、未识别工具、同名模型分组、未知 Token 与零 Token、零单价、缓存计价、客户端来源隔离、本地日历日和 DST 边界。
- CSV / JSON 复用当前筛选快照，包含范围、来源、单位与计价覆盖；测试验证导出没有混入另一供应商的数据，未知字段保持空 / null、客户端不声明网络成功或时延、CSV 中文与公式注入保护正常。
- 隔离 Windows 原生流程使用六条合成网关记录：供应商 A 的三条记录汇总 180 Token / 部分估算 USD 0.00178；供应商 A + Codex 为 120 Token / USD 0.00108；供应商 B + Codex 为 240 Token / 费用未知。供应商排行行内下钻、工具排行下钻、模型筛选和返回全部通过。
- 客户端会话没有混入网关统计，不显示网络成功率和时延；七天趋势包括六个无记录日期。1320 / 980 窗口及浅深主题截图检查无横向溢出，工作空间底部入口保留。
- Windows 0.3.5 目录包通过完整原生验证，使用隔离测试库和本地模拟上游；供应商 / 工具交叉下钻、模型筛选、未知费用、客户端分离及旧功能流程通过。结果位于 `work/usage-dashboard-packaged/`。
- 不读取真实用户凭据或修改真实数据库。实际工具发出的请求只在经过网关时归属到工具专用入口；API 直连的本地用量目前仅支持 Codex 会话导入。Linux 原生运行未在本轮验证。

## 0.3.4 跨套餐同名模型

日期：2026-10-05（Asia/Hong_Kong）。

- 206 项测试通过（14 个文件），类型检查和生产构建通过。显示名称与接口 ID 分离，跨供应商同名模型自动添加来源命名空间，同供应商内重复简称仍明确拒绝；无需数据库 schema 迁移，已有接口 ID 保持稳定。
- 两个本地模拟供应商同时使用 `glm-5.3`，通过各自聚合接口 ID 发出实际推理请求分别返回套餐 A / B 的内容，上游收到的模型 ID 均保持 `glm-5.3`；工具专用入口仍拒绝未授权来源。目录与五类客户端配置显示「套餐名 - 模型名」，API 直连使用真实上游 ID。
- 隔离 Windows 原生界面通过实际表单为两个测试套餐添加相同模型简称和显示名称；编辑第二个模型时回显本地简称，保存后接口 ID 不变。980×680 / 1320×880 模型目录均显示两条套餐名称，无横向溢出。批量获取同名模型采用相同规则并覆盖事务回滚。
- Windows 0.3.4 目录包通过完整原生流程：预加载、SQLite、本地网关请求、模型发现、旧供应商重复整理及同名模型表单均通过。测试结果位于 `work/model-names-packaged/`，未写入真实用户配置。
- 只使用合成凭据和本地上游；真实火山套餐推理及 Linux 原生运行未在本轮验证。

## 0.3.3 供应商防重复与旧记录合并

日期：2026-10-05（Asia/Hong_Kong）。

- 189 项测试通过（13 个文件），类型检查和生产构建通过；新增 29 项回归覆盖预设复用、连续保存幂等、不同密钥保护、失效编辑 ID、凭据不可读、配置指纹失效、备份与事务回滚。
- API 来源按名称、类型和规范化地址防重复，同一 Key 不会覆盖已有备注、启用状态、模型或工具绑定；不同名称和不同套餐路径仍分别保存。
- 旧重复项仅通过明确的界面操作合并。备份包含原加密数据；保留全部模型 ID、别名、默认模型和历史用量。部分来源的工具保持原模型范围，包括停用模型日后重新启用；完整来源选择继续自动包含新模型。
- 原生 Windows 隔离流程已复现 3 条 DeepSeek 合并为 1 条，两个旧模型的 ID 与别名保持不变；连续和并行保存返回同一来源，不同 Key 拒绝且原 Key 保留；实际 React 表单双提交不产生新记录，模型列表继续正常获取。验证只使用合成凭据和本地模拟上游，不修改真实用户数据库，也不请求真实供应商。
- Windows 0.3.3 目录包通过相同原生流程，预加载和模拟网关请求正常；1320×880 和 980×680 的整理界面检查通过，滚动后合并按钮及固定底部可见，无横向溢出。备份权限设置在 Windows 实际执行通过。
- Linux 原生备份权限、窗口和真实供应商逐模型推理尚未在本轮实测。

## 0.3.2 模型获取与批量添加

日期：2026-10-05（Asia/Hong_Kong）。

- 160 项自动化测试通过（12 个文件），类型检查、Vite 与 Electron 主进程构建通过。目录测试覆盖真实请求结构、认证处理、错误脱敏、分页边界、超时、缓存失效、并发回复、已有别名保留、重复跳过及批量回滚；工具适配器覆盖未知上下文预算及原配置保护。
- Windows Electron 原生界面在隔离数据目录和本地模拟上游中验证：点击获取模型、已有项禁选、新增两项、重复添加跳过、编辑上下文为 0 的模型，以及保存 API Key 后自动打开模型列表。
- 同一隔离流程模拟 401：界面清空候选模型并禁用添加，未沿用上一次成功列表。980×680 与 1320 窗口截图检查通过，弹窗按钮可见、列表独立滚动，无横向溢出。
- Windows 0.3.2 目录包生成成功，`release/win-unpacked/ModelDock.exe` 通过相同原生流程；预加载、SQLite、本地网关模拟请求返回 200，模型获取、自动弹窗、批量添加和主题设置均通过。打包使用本机 Electron，跳过资源编辑和签名。
- 本机用户已确认 DeepSeek 可以连接；模型目录成功不代表每个模型的真实推理已验证。测试只使用合成凭据，不写入用户数据库、OAuth 或现有 Agent 配置。
- Linux 原生界面、系统托盘和真实供应商逐模型推理仍未在本轮实测。

复现本轮原生流程：

```bash
npm test
npm run build
node scripts/smoke-electron.mjs work/discovery-ui-first
node scripts/smoke-electron.mjs work/discovery-packaged release/win-unpacked/ModelDock.exe
```

## 早期 0.2.0 验证记录

日期：2026-10-05（Asia/Hong_Kong）。

## 已通过

- TypeScript 类型检查：`npm run typecheck`。
- 45 项自动化测试：4 个测试文件，覆盖旧数据库迁移与凭据保留、供应商级绑定、直连单源限制、多来源路由、真实 SQLite 写入/重启、关联清理、别名唯一、回环自循环拒绝、本地 Key 鉴权、按模型和工具绑定路由、SSE/工具输出保留、上游状态保留、错误脱敏、断连/超时、OAuth 轮换与取消、配置合并与损坏文件保护。
- Vite 生产构建及 Electron 主进程/预加载构建：`npm run build`。
- Electron 原生对话框：供应商预设及工具直连/聚合选择可正常打开；验证弹窗内容、固定保存按钮和滚动区域，截图检查时关闭动画以获得稳定帧。
- Electron 实际渲染：用隔离数据目录启动，预加载桥可用；检查了供应商、模型、工具和服务页面截图。截图位于被 Git 忽略的 `work/` 下。
- Electron 主进程端到端：经预加载接口创建来源与模型、保存 DSH 绑定、启动回环网关；通过该网关向本地模拟上游发送请求，HTTP 200/OK；配置预览未包含上游测试密钥；OpenCode API 直连生成真实上游地址/模型 ID，订阅单源不导出 OAuth token。
- 本机原生 Codex Desktop CLI 0.160.0 的 app-server：在隔离 `CODEX_HOME` 中加载生成的模型目录，`model/list` 正常列出 `dock-native-test`。没有发起推理。
- Windows 打包：`npm run pack` 生成 `release/win-unpacked/ModelDock.exe`；同样通过了原生渲染、预加载、SQLite 和模拟上游请求检查。
- 本轮打包遇到 GitHub DNS 失败后，使用本机 Electron 的 `electronDist` 完成目录包，并跳过 Windows 资源编辑/签名；最终程序仍通过上述运行检查。

这些验证使用临时或 `work/` 数据，不会写入现有 CPA、DSH、Copilot、VS Code、Cursor 或真实 Codex 配置。

## 尚未验证

- 用户真实 GPT/Grok OAuth 登录、账号额度、可用模型与真实推理。
- DeepSeek、火山等实际 API Key 的请求。
- 每款 Agent 中的完整会话、复杂工具调用、视觉输入、模型切换。
- DSH 当前 profile 和 Copilot 桌面界面的实际导入；目前提供配置片段/SDK 配置导出。
- OpenCode 配置已按官方 schema 和协议 SDK 选择生成，并验证 JSONC 合并；原生真实推理尚未验收。
- Linux 原生窗口、托盘、系统加密与 AppImage/deb 安装运行。
- Windows 真实开机/登录自启动。第一版未添加自启动操作。

## 复现

```bash
npm run typecheck
npm test
npm run build
node scripts/smoke-electron.mjs
npm run pack
node scripts/smoke-electron.mjs work/packaged-smoke release/win-unpacked/ModelDock.exe
node scripts/check-codex-catalog.mjs <已安装的-codex-程序路径>
```

模型目录的成功解析不代表模型 entitlement 或推理成功。订阅路径只实现 Responses，要求完整历史；不支持 WebSocket 续接，详情见 README。

<a id="flowbridge-integration"></a>

## ModelDock · FlowBridge 整合与验收

### 来源与许可证

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

### 结构与数据保留

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

### 功能与平台边界

| 功能 | 整合行为 |
| --- | --- |
| HTTP 代理 | KDE/GNOME 系统设置或 Windows WinINet；回环字节转发、有限缓冲、半关闭和计数；按所有权恢复，保留外部并发修改 |
| 全局 TCP/UDP/DNS | 固定 sing-box 1.14.4；TCP 与标准 UDP/DNS 往返预检；Linux root-owned 固定协议服务、Windows Wintun/Job；无直接出口回退 |
| 模式/地址/解析切换 | 显式修改已连接会话时，先确认旧网络已恢复，再保存并连接新配置 |
| 自动连接 | 默认关闭，复用 ModelDock 登录启动，最多等待上游两分钟；遗留恢复门禁存在时不自动连接 |
| 网站检测 | Google/YouTube/GitHub/ChatGPT/Cloudflare，系统套接字与指定代理两条路径并行，每条最多 20 秒、有限重试、浏览器挑战独立标识 |
| 上游地址发现 | Windows 按需读取本机代理设置和监听端口，用 HTTP CONNECT 与 SOCKS5 握手筛选候选。SOCKS5 的 UDP 能力在全局连接时预检。Linux 提供默认网关作为热点候选。 |
| 流量小窗 | 同一 Electron 生命周期，拖动、锁定、展开曲线、隐藏、双击主窗口；保存位置并纠正离屏 |
| 手机端 | Linux 网络页可导出随包提供的 Termux 安装器，在手机手动执行，支持 HTTP、SOCKS5 和 UDP。 |

从 0.4.1 起，ModelDock 的 deb 同时安装桌面应用、sing-box、固定路径的权限助手、
systemd 单元及 Polkit 策略。全局模式使用 root 所有的系统组件，首次连接经系统授权
启用当前用户的 systemd socket。服务同时校验连接者的 UID 和 root 所有的授权记录，撤销授权后会结束已有会话并清理网络。单独运行 AppImage 可使用 HTTP 模式，需要全局模式时
请使用 deb 版。Linux 全局上游需填写远端数值 IP。Windows x64 包附 CPython、core 和官方签名 Wintun；
Windows 首次手动连接全局模式时，UAC 授权安装受保护的网络组件。当前账户随后可通过
按需计划任务启动它，重连、重新打开应用和重启电脑均可复用。组件版本需要更新时，
手动连接会再次请求安装授权。HTTP 模式与 ModelDock 主窗口使用普通用户权限。本机 SOCKS5 必须通过监听者/进程路径防循环
检查，拒绝 ModelDock 自身、未知/活跃接口、转发网卡等冲突。

Windows 网络任务仅运行 Program Files 内通过 SHA-256 校验的固定组件，恢复记录受系统 ACL 保护。
任务按当前用户 SID 授权。管理人员可在任务计划程序中禁用或删除对应的
`ModelDock.Network.<用户 SID>` 任务，阻止后续启动。登录后的全局自动连接仅使用已有授权。
小窗是统一 Electron 悬浮窗，并非 Explorer
内嵌工具栏；本次未移植 FlowBridge Windows 独有的任务栏自动隐藏/全屏避让逻辑。
用户名密码代理、订阅链接、ICMP、独立网络空间/虚拟机、第三方 VPN 更具体路由和特殊
绑定设备不保证支持。系统路径成功、代理出口成功、真实模型推理是不同的验证结论。

### 退出与恢复

连接前写恢复门禁，取消在同一队列中执行恢复。原生 TUN 启动或系统授权还在等待时，
取消也需等受控清理；不会杀特权助手。桌面代理先恢复再关闭监听，TUN 必须确认清理。
失败保留会话/恢复记录，阻止新连接；退出失败保留主窗口、Gateway、数据库供重试。

Electron EOF 请求网络组件清理；独立管道守护恢复桌面代理，Linux root helper 与
Windows Job 保留原崩溃保护。全局另有 marker，异常重启后点击“恢复网络”调用
仅恢复协议，不启动新 TUN。未知/损坏所有权记录拒绝覆盖。强杀、断电后的真实路由、
DNS/WeakHostSend 恢复必须在目标系统验收，不能只以进程退出为证据。

### 0.4.0 云端验证（2026-11-09）

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
## Cloud 中使用已校验、解压的官方 Electron，避免重复下载
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

### 0.4.2 Windows x64 原生复核（2026-11-09）

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

### 当前版本分发

Linux 完整安装仅需一个 `model-dock` deb。Windows 完整目录保留 flowbridge/python、
core、Wintun 与许可证。源码包与二进制一同提供，构建不安装或启动系统网络服务。Windows
cloud 构建必须标为交叉目录构建，不宣称原生执行验证。

### 0.4.15 Windows x64 原生验证（2026-11-10）

Windows 目录包使用嵌入式 Python 启动生产网络组件。真实本机 SOCKS5 上游通过了 TCP 和 UDP/DNS 预检。首次手动授权安装了当前账户的网络任务。更新控制管道权限后，普通用户进程成功验证任务的 SYSTEM 身份并收到了启动进度。

独立 FlowBridge 持有全局接管锁时，ModelDock 拒绝启动第二个 TUN。断开独立 FlowBridge 后，ModelDock 复用已安装的任务，启动 Wintun 和接管路由。系统 HTTPS 路径和会话本地代理路径访问 GitHub 均返回 HTTP 200。正常断开后，TUN 停止、接管路由归零，WeakHostSend 和当前用户 WinINET 代理设置均与连接前一致。

本轮未测重启后自动连接、强杀进程后的恢复、手机热点和 Linux 原生接管。
