# ModelDock · 模型坞

**配置一次，让模型连接你的工具。**

ModelDock 是跨平台本地模型管理台：全局维护模型来源与别名，为各工具选择供应商，按工具能力直连上游或使用本机统一接口。界面使用 Electron、React、TypeScript、Vite；Node.js 后台和 SQLite 数据存储独立于界面。

自有代码及原创应用标记采用 [MIT 许可](LICENSE)，第三方图标和依赖保留各自的 Apache-2.0、CC-BY-4.0、MIT 或其他许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。欢迎按 [贡献指南](CONTRIBUTING.md) 提交修复；敏感问题请遵循 [安全报告流程](SECURITY.md)。

## 供应商与工具

- API 供应商：DeepSeek、火山 Agent Plan、火山 Coding Plan（用户所说的 Token 编程套餐）、千问 Token Plan，以及自定义 API。预设填入对应地址，密钥仍需用户配置。
- 订阅供应商：Codex 和 Grok Build，以本人账号完成设备码授权，由本机管理续期。
- 授权等待框点击外侧保持打开，验证码和等待状态保留；关闭按钮、取消登录或 Escape 可结束本次登录。验证码、API 入口和配置内容通过 Electron 主进程复制，写入成功后才提示，不依赖浏览器剪贴板权限。
- 桌面网络：授权、额度、模型目录和推理请求使用 Electron 系统网络栈，遵循现有系统代理和网络设置；请求不继承浏览器 Cookie。不会自动跟随携带凭据的上游重定向。
- 授权生命周期对照 CC Switch 的设备码实现：xAI 校验 OIDC issuer，续期显式携带原权限 scope；ID Token 只保存在主进程加密凭据中，界面取得账号元数据。临时续期网络失败保留原授权状态；明确拒绝或过期停止轮询。导入凭据前取消旧登录、刷新和额度查询，提交刷新前检查原凭据，防止晚回复覆盖新授权。
- 模型：填写 API Key 后从供应商获取真实模型列表，搜索、勾选并批量添加。不同供应商可用相同模型简称及显示名称，列表和工具中按「套餐名 - 模型名」展示；系统维护唯一的聚合接口 ID。支持真实上游 ID、协议、上下文、工具与视觉能力。默认来源未授权、模型列表为空，能力由实际配置确定。
- Codex 兼容模型目录带独立的 `client_version` 和对应版本请求头，使用原生 `slug` 作为上游 ID，解析显示名称、上下文和明确的能力字段。默认候选隐藏 `hide / none` 条目，已保存和手动添加的模型保留；目录可见性不代表实际模型权限。API / Grok 来源不携带 Codex 目录版本参数。
- 工具：Codex、OpenCode、DSH、VS Code Copilot Chat、Copilot app；工具页直接勾选供应商并选择模型偏好。五种工具会自动保存并同步勾选、取消及模型偏好变更；Copilot app 需运行。Codex 支持单供应商直连和逐模型选择的聚合接口，其他工具可同时直连多家供应商。各工具均可还原官方配置。模型或来源参数改动后可点击「重新同步」。DSH 的模型与密钥一同同步，无需再次手工配置。
- 本地网关：固定监听 `127.0.0.1`，默认 `18181`；本地 Key 鉴权、标准模型目录、Chat Completions/Responses、流式转发、请求日志。
- SQLite：保存来源、模型、绑定与日志；敏感凭据由主进程加密，预览和快照不包含上游密钥。
- 配置接入：五类工具均支持预览 / 导出，并在用户修改勾选或模型偏好后自动同步，写入前备份。VS Code 默认只保留所选自定义供应商，可关闭此选项来保留原有自定义来源；其他 vendor 与 JSONC 注释保留。OpenCode 保留其他供应商、MCP 和非受管 JSONC 注释；Codex 的 TOML 重写保留配置字段，但不保证原注释。Copilot app 通过运行实例的原生接口同步来源、模型和凭据，预览是同步计划参考，不需要再手工导入。DSH 写入 home 插件覆盖与凭据 refs，同步前保存加密恢复记录，清空后恢复原覆盖。
- 托盘：关闭主窗口可留在后台运行；退出应用会停止网关。

## 授权、MCP、Skills 和用量

授权中心使用紧凑行布局：平台标题、账号身份、横向额度条和重置时间集中显示，账号详情、重新授权、注销与删除放入「…」菜单。空账号组使用简短提示；重置到期明细以浮层展开，不再撑高整张卡片。保留所有账号操作及键盘菜单控制。

账号左侧显示 32px 圆形头像。GitHub 使用账号接口返回的 `avatar_url`，既有账号在刷新额度时补取缺失头像，无需再次登录；ChatGPT / xAI 只使用现有授权资料提供的头像字段。头像缺失或加载失败时显示姓名、邮箱或来源名称的首字母，授权状态点保持独立。图片匿名加载，不发送登录凭据或页面来源，只允许已知公共头像地址；头像获取失败不影响账号授权和额度结果。

深色主题采用黑灰背景、蓝色强调，覆盖侧栏、卡片、菜单、设置、表单和弹窗。品牌图标统一为深灰白色 M 与蓝色连接标记；窗口、托盘、网页图标和 Windows EXE 使用同一套素材。`npm run build` 会生成七档 ICO 与 PNG / SVG；打包保留 Windows 图标资源编辑并关闭签名。

导航和常用操作采用 [Google Material Symbols Rounded](https://fonts.google.com/icons?icon.style=Rounded)：聚合节点、MCP 服务、Skills 书籍、授权钥匙、用量统计、模型堆栈及服务监控使用统一的圆角线条。图标使用本地 SVG 路径和主题颜色，离线可用，无需加载 Google 字体；各工具的品牌图标与 ModelDock 应用标记保留。素材来自 [Google 官方图标仓库](https://github.com/google/material-design-icons)，选取记录与 Apache 2.0 许可随源码及 Windows 包提供。

授权中心按 GitHub Copilot、ChatGPT / OpenAI、xAI / Grok 分组展示账号。已授权账号进入页面后自动查询额度，并显示剩余百分比、上游提供的实际单位、重置倒计时、查询时间和旧结果状态。列表每 5 秒只读取本机缓存；额度缓存默认 5 分钟，已知重置时间到达后可提前查询，失败按 5 / 10 / 20 / 30 分钟延后，也可手动刷新。

ChatGPT 的重置次数独立于主要额度查询，过滤已使用、重复和过期的记录；可展开查看全部到期时间。明细暂不可用时，若上游额度响应提供了明确次数，仍显示该次数并标注到期明细未知。Grok 和 Copilot 未提供手动重置次数时明确说明，未知额度不会显示成零或百分之百。

GitHub Copilot 新增 GitHub 设备码登录，使用固定官方授权与额度地址，凭据保存在主进程的加密管理状态中。支持账号实际返回的 AI Credits 或旧版高级请求额度，以及不限量额度；该登录用于 ModelDock 授权中心查询，不会修改 Copilot 桌面或 VS Code 的登录。已知授权到期时需重新登录；不声称自动续期。这里仅展示额度和重置次数，不消耗次数执行额度重置。

GitHub 账号身份查询使用公共 REST 请求头，Copilot 额度查询使用单独的接口版本和编辑器请求头，避免混用。设备码轮询兼容 HTTP 200 / 400 的 `authorization_pending` 与 `slow_down`，按官方间隔继续等待；明确拒绝、过期、HTML 和未知错误会停止。已拿到令牌后读取账号失败时，界面显示「读取 GitHub 账号信息」，身份校验和加密保存成功才显示登录完成。处理规则依据 [GitHub 设备码协议](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) 和 [公共 REST API 版本说明](https://docs.github.com/en/rest/about-the-rest-api/api-versions)。

协议对照 [CC Switch v4.0.0 Copilot](https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/proxy/providers/copilot_auth.rs)、[v4.0.0 ChatGPT](https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/services/subscription.rs) 和 [v4.0.3 Grok](https://github.com/farion1231/cc-switch/blob/v4.0.3/src-tauri/src/services/subscription_grok.rs)。xAI 未使用账号的已知 protobuf 缺省零值形状保留兼容解析，界面标注“按协议默认值解析”；缺少明确上下文或结构改变时仍显示未知。Copilot 当前/旧版额度类型依据 [GitHub 官方说明](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage) 与实际响应，额度读取不代表每个模型的推理权限。

左下功能区提供四个管理页面。工具与供应商列表共享剩余高度并分别滚动；窗口缩小时两组列表都可独立滚动，标题保持可见，底部功能入口和工作空间信息保持固定。

- **授权中心**：统一管理现有 Codex / Grok Build 订阅来源，一个来源对应一个账号。可新增、登录、重新授权、注销 ModelDock 本地授权、删除来源，或明确点击从本机客户端的 `auth.json` 只读导入。额度查询复用续期机制，只向对应官方域名发送凭据；未查询或格式不支持显示未知，网络失败时注明上次成功结果。访问凭据到期不代表套餐到期。GitHub Copilot 目前仍是接入工具，尚未新增为 ModelDock 的订阅来源。
- **MCP 管理**：全局目录支持 stdio、HTTP、SSE；勾选仅保存工具选择。先预览，再明确应用到工具，保留无关设置并备份原文件。Codex 支持 stdio / Streamable HTTP，SSE 会明确拒绝；OpenCode 使用 remote 协商；VS Code 与 Copilot CLI 使用各自用户配置。DSH 暂无已核实的统一 MCP 文件入口，只导出片段。目录、预览和导出隐藏环境变量、Headers、敏感参数及 URL 查询凭据；应用由主进程取出真实值。已被用户修改的受管项及非受管同名项会提示冲突，不会覆盖或删除。删除目录记录后，须再次预览 / 应用才清理客户端中未改过的受管项。
- **Skills 管理**：支持导入本地目录、GitHub 仓库或已有工具技能，查看技能文件，并按工具部署或停用。导入只复制到管理库，勾选才实际部署；使用文件清单和哈希保护用户修改，保留备份，不执行技能脚本。Codex 使用仍兼容的 `CODEX_HOME/skills`，OpenCode 使用全局 `skills`，DSH 对应官方文件系统技能插件。VS Code 与 Copilot 共享 `~/.copilot/skills`，两列同步。现有外部同名技能只读导入后不会自动接管；内容完全一致时，可点击「接管」并确认，仅登记管理关系。不同内容、用户修改、链接或额外 Git 元数据会拒绝接管。更新仓库技能前需显式管理原库项，尚无自动更新。
- **用量统计**：提供「按供应商」「按工具」「按模型」三个视图，支持点击排行下钻及时间、工具、供应商、模型交叉筛选；总览、排行、每日趋势和 CSV / JSON 导出使用同一范围。展示请求数、成功率、输入 / 输出 / 缓存 Token、用量覆盖及估算费用，可按请求、Token、费用排序。默认今天，可选最近 7 / 30 / 90 / 365 天或最多 366 个香港自然日；没有记录的日期补 0。历史和已移除的来源仍可筛选；无法识别工具的调用单列为通用接口，不按当前绑定猜测归属。解析 Chat / Responses 的 JSON 与 SSE 实际 `usage`，缓存不会重复计价，推理 Token 不会重复计入输出。没返回计数的请求保持未知，手填模型 USD 单价后才估算费用；只覆盖部分记录时显示「部分估算」，不代表实际账单或订阅费。日志轮转不删除用量历史。

用量页默认查询今天的客户端会话，提供工具快捷筛选、立即同步、30 秒自动刷新（可关闭或改成 15 / 60 / 300 秒）、数据来源、四项总览、小时/每日趋势和分页明细。日志、供应商、模型和定价分别在页签中查看，来源和状态码可进一步筛选。仅在用量页面进入或刷新时同步，不在应用启动时导入外部客户端资料；隐藏窗口时暂停自动刷新。

本地会话目前支持 **Codex 和 OpenCode**。Codex 支持 `sessions` / `archived_sessions`、累计快照、重复额度事件、分支回放、截断文件和重复同步；OpenCode 支持 V1 / V2 SQLite，在内存中合并校验通过的已提交 WAL。读取不修改原数据库、WAL、SHM 或日志文件，只保存时间、模型和 Token 元数据。DSH、VS Code 和 Copilot 的原生历史暂未接入稳定可验证的格式，会在数据来源中明确说明；经过 ModelDock 网关的请求仍可统计。

总 Token 为总输入加输出，缓存读取和写入不重复相加；新输入排除缓存读取/写入，缓存命中率按输入量加权。模型定价支持已配置模型和实际观察到的历史模型；缓存写入单价缺失且记录含写入时，该条费用保持未知。费用按当前设置的 USD 单价估算，不代表订阅账单，也不猜测未设置的参考价格。客户端事件的 HTTP 状态和速率保持未知；网关速率由已报告输出和完整请求耗时计算，包含等待及网络时间。

界面与解析参考 [CC Switch 4.0 指标](https://github.com/farion1231/cc-switch/blob/v4.0.0/src/components/usage/UsageHero.tsx) 和 [OpenCode 会话读取](https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/services/session_usage_opencode.rs)。SQLite 快照采用 [官方 WAL 格式](https://sqlite.org/walformat.html)，始终保持原文件只读。

用量中点击某家供应商的「查看」，可在明细中继续筛选工具或模型。导出的报告含当前筛选、统计单位、香港日期/时区和计价覆盖；CSV 使用 UTF-8 并防止历史名称被表格软件当成公式执行，JSON 另含趋势及当前日志页。客户端事件与网关请求分别统计，避免同一调用被重复累计。

MCP / Skills 的真实客户端加载、真实账号授权及额度查询仍需在对应工具和账号验证。配置写入成功不等于服务已经连接。

这四项功能参考 [CC Switch 的 MCP 统一目录](https://github.com/farion1231/cc-switch/blob/d455dd85720a4e48a59d02396539b480d9767902/src-tauri/src/services/mcp.rs)、[Skills 管理库](https://github.com/farion1231/cc-switch/blob/d455dd85720a4e48a59d02396539b480d9767902/src-tauri/src/services/skill.rs) 与账号 / 会话用量设计，使用独立 TypeScript 实现。参考仓库为 MIT 许可，源码仅放在被 Git 忽略的 `work/references/`，不随应用打包。各工具目录依据官方文档和源码，说明链接可从 Skills 页面查看。

这是按个人需求实现的初版，不是 CLIProxyAPI 的完整移植。项目源码无需 Go 或 Rust，不修改已有 CPA 安装。

## 设置

「设置」位于左下角「本地工作空间」旁的齿轮按钮，原本地信息和数据目录按钮保留。

默认主窗口为 1080×720 DIP，可手动调整或最大化；最小尺寸保持 980×680，工具和供应商列表独立滚动。

- 主题可选浅色、深色、跟随系统，覆盖全部页面、弹窗和表单；立即生效并保存在本机 SQLite。跟随系统会响应明暗变化，主窗口等前端读取主题后才显示。
- 窗口支持静默启动和关闭时留在托盘。静默启动下可通过托盘、再次启动程序或系统激活显示窗口；关闭托盘选项后，关闭窗口会退出并停止网关。
- 打包版支持登录系统后自动启动。Windows 使用系统启动项并报告实际启用状态；Linux 使用属于 ModelDock 的 XDG autostart 文件，保留外部修改。开发版不登记系统启动项。AppImage / Windows 便携程序使用稳定的外层可执行路径。
- 「服务与日志」和设置页可开启「随应用启动本地服务」，下次手动启动或登录自启时使用保存的端口自动监听 `127.0.0.1`。默认关闭；启动服务或开启此项会保存端口，手动停止服务不取消下次自动启动。端口被占用时保留应用并在服务页显示错误，不修改已有工具配置。
- 首选终端按平台列出，点击「打开终端」在数据目录启动。未安装的终端会明确报错，配置保存不代表已启动终端。
- 网络支持应用内指定本机 HTTP、HTTPS 或 SOCKS5 代理，留空使用系统规则。该设置只影响 ModelDock 的授权、模型目录和聚合上游请求，不更改系统代理，也不强制断开正在进行的连接。智能 / PAC 模式未代理 `auth.x.ai` 时，可填写代理软件提供的本机地址再登录。准备登录阶段立即显示进度并可取消，迟到的申请或轮询结果不会重新打开已关闭的窗口。
- 网络区的「检测连接」使用当前应用会话访问 Grok 的公开授权配置，显示实际解析路线、HTTP 状态、白名单网络错误码和耗时，不登录账号或读取凭据。代理地址未保存时先保存；同值再次保存也会重新应用配置。授权失败窗口也会显示可识别的网络错误码。

自动检查覆盖设置保存、主题切换、系统颜色响应和窗口渲染。本地服务自动启动另通过四次 Windows Electron 进程启动检查，验证端口持久化、原生监听归属、关闭配置和端口占用时的错误显示；实际 Windows 登录或电脑重启、Linux 原生托盘和交互终端效果尚未实测。验证脚本隔离数据库、浏览器缓存及启动项适配器，不修改本机真实自启设置。

## 开发和运行

需要 Node.js 24.13+（本次开发用 Node.js 26）、npm；Windows 和 Linux 均需图形桌面。

```bash
npm ci
npm run dev
```

生产界面运行：

```bash
npm run build
npm start
```

验证：

```bash
npm run typecheck
npm test
npm run build
npm run verify:production
node scripts/smoke-electron.mjs
```

原生 smoke 使用单独的 QA 入口，默认先构建界面和该入口，再新建带 nonce / 进程标识的临时资料目录，仅使用明确的模拟上游与合成账号；不会导入真实客户端授权。已有生产界面构建时可使用 `node scripts/smoke-electron.mjs work/smoke-check --no-build`，该选项仍重新构建 QA 入口。Linux 无图形桌面时使用 `xvfb-run -a node scripts/smoke-electron.mjs work/smoke-check --no-build`。正式发行程序不包含该测试入口，也不接受 smoke 环境变量或任意开发界面地址。

GitHub Actions 的 Windows / Linux、Node.js 24.13 检查从干净 checkout 执行 `npm ci`、typecheck、单元/模拟上游测试和生产构建。原生图形 smoke 单独运行：在 CI 的手动触发中开启 `native_smoke`，只上传合成截图与验证摘要，不上传数据库、浏览器缓存或凭据状态。自动化结果不等于真实账号授权、推理或目标机器的系统启动项验收。

Linux CI 的虚拟桌面运行可显式使用 `--ci-no-sandbox`；该参数仅在 Linux、`CI=true` 且目标为独立验证的 smoke / QA 入口时生效，用于 CI 的 Chromium 启动限制。它不修改正式应用的沙箱配置，普通桌面运行不使用这个测试参数。

要验证打包后的资源，先生成正常目录包，再创建独立 QA 副本；不要把正式 EXE 当成测试入口：

```sh
npm run pack
node scripts/package-smoke.mjs release/win-unpacked
# 使用上一条命令输出的 executable 路径；副本始终位于 work/qa-packages/ 下
node scripts/smoke-electron.mjs work/packaged-smoke "<专用 QA executable 路径>" --no-build
```

Linux 对应目录包为 `release/linux-unpacked`，同样以专用 QA 路径运行，并按需要使用 `xvfb-run -a`。QA 副本有独立标记及 `main-smoke.cjs` 校验；脚本拒绝正式发布包、旧资料目录和符号链接。创建副本不会改动原发布产物。

快速打包（Windows）：

```bash
npm run pack:win
```

这条命令构建最新源码、校验生产入口，复用 `node_modules/electron/dist` 生成目录包，并检查包内入口、资源、许可与实际 EXE 图标。完成后运行 `release/win-unpacked/ModelDock.exe`；分发时复制整个文件夹。检测到 ModelDock 正在运行时，输出改为 `release/windows-版本-时间-进程号/win-unpacked`，终端会显示确切路径，不会结束旧程序。

首次拉取或依赖更新后先执行 `npm ci`；后续直接运行打包命令即可。项目的 `.codex/environments/environment.toml` 配置了「快速打包 Windows」「打包便携 EXE」「启动开发版」和「安装依赖」，可从 Codex 顶部运行菜单选择。新建 worktree 时会自动安装依赖。

其他发行格式：

```bash
npm run dist:win    # Windows 便携程序（在 Windows 构建）
npm run dist:linux  # AppImage / deb（在 Linux 构建）
```

若打包阶段无法访问 GitHub，可在完成 `npm run build` 后使用本机已安装的 Electron 运行时生成目录包：

```bash
npx electron-builder --dir --config.electronDist=node_modules/electron/dist --config.win.signExecutable=false
```

这个离线路径使用本机 Electron 和缓存的资源编辑工具，保留应用图标与版本资源，只跳过签名；可用 npm run icons:verify -- release/win-unpacked/ModelDock.exe 检查实际 EXE 图标。

若 npm 提示可信构建依赖的安装脚本被拦截，请先查看 `npm install-scripts ls`，按本机策略允许所需依赖。不要全局关闭检查。

## 直连与 Codex 聚合接口

| 工具与来源 | 接入方式 |
| --- | --- |
| VS Code、OpenCode、DSH、Copilot app，选择一个或多个来源 | 每个 API 来源使用独立的上游地址、Key 和真实模型 ID；每个订阅来源经本机入口管理授权。不同 API 的凭据不会混在同一分组。 |
| Codex，选择「直连供应商」 | 一次选择一家来源；选择另一家会替换当前来源。API 直接使用上游地址和真实模型 ID，订阅授权由本机入口管理。 |
| Codex，选择「聚合接口」 | 选择多家来源，并逐个勾选允许使用的 Responses 模型；统一连接 `http://127.0.0.1:<端口>/tool/codex/v1`，按唯一模型别名路由。 |

API 直连不依赖本地网关。预览隐藏 API Key；在支持自动同步的工具中，用户勾选来源、取消来源或改变默认模型会触发配置写入，其余工具通过明确导出取得所需配置。订阅的访问令牌和刷新令牌始终留在主进程，由本机入口续期；工具配置只使用本地连接密钥。需要本地入口时，自动同步会按需启动网关。

旧绑定加载时保留原直连 / 聚合 / 自动模式和部分模型范围，不会在启动或切换导航时同步客户端。可以先点击「重新同步」应用原有选择；其他工具修改供应商勾选后采用多供应商直连，Codex 可明确选择直连或聚合。聚合模型列表按已勾选模型保存；新增模型不会自动加入已有的选择。取消最后一个模型会保持空列表并清理 Codex 的托管模型入口，网关也拒绝调用未勾选模型。DSH 同时写入模型与对应凭据；Copilot app 通过自身原生接口更新，不由 ModelDock 直接改写其数据库。

取消来源后，OpenCode 会清理对应 ModelDock 分组；全部取消时清空托管分组，保留其他供应商、MCP 和非受管注释。VS Code 按下面的同步范围处理自定义来源。Codex 全部取消时移除 ModelDock 供应商，恢复首次接入前的模型、供应商和模型目录；旧版本没有恢复记录时回到原生默认选择。已经自行切换到其他供应商的配置保持当前选择，只清理受管内容。生成的 ModelDock 模型目录在确认属于应用且不再使用时删除，原目录保留。

## 还原官方配置

五个工具页面均提供「还原官方配置」。确认后先备份客户端配置和 ModelDock 的工具选择，再清空该工具的来源选择，保留全局供应商、模型、账号授权、MCP、Skills 和其他设置。失败时恢复原选择；损坏文件不会被覆盖。

- Codex：回到官方 OpenAI / ChatGPT 模型入口，清除自定义模型选择、目录和官方地址覆盖，移除 ModelDock 供应商及受管目录；其他未启用的供应商定义保留。目标遵循 `CODEX_HOME`，默认为 `~/.codex`。更改后需要重启 Codex CLI / 桌面服务。官方默认供应商与 Responses 配置依据 [OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-reference)。
- OpenCode：清理自定义供应商、默认模型和供应商启停过滤，保留授权文件与其他配置。
- VS Code：清理默认模型配置文件的所有 `customendpoint` 来源，保留其他 vendor 和 JSONC 注释；之后重新加载窗口。
- DSH：清理 home 中的自定义模型覆盖与 ModelDock 凭据引用，恢复内置模型适配器，保留账号凭据和其他插件。
- Copilot app：通过运行中的原生接口清理自定义来源，保留 GitHub 内置模型和账号；原配置及相关凭据先保存到加密备份。

还原操作不会把整份客户端配置替换成空文件。各工具其他资料目录、项目级覆盖以及运行中会话的模型选择仍由相应客户端管理。

## VS Code 同步范围

VS Code 工具页的「仅保留所选供应商」默认开启。同步会先备份 `Code/User/chatLanguageModels.json`，再将其中所有 `vendor: "customendpoint"` 分组替换为当前选择；因此未勾选的历史自定义来源也会被清除。全部取消时清空自定义来源。其他 vendor 的内容和 JSONC 注释保留，内置模型仍由 VS Code 管理。

关闭该选项后，只替换或清理 ModelDock 分组，保留文件中现有的其他自定义来源。这适合仍需在 VS Code 单独管理其他 API 的情况。关闭只改变后续同步范围，不会自动恢复已清除的分组；需要时可从写入前备份恢复所需来源。切换选项会立即保存并同步，但不改变已保存的模型过滤和接入模式。

新建 VS Code 绑定和缺少范围字段的旧数据使用 `vscodeSyncScope: "selected"`；显式关闭后保存为 `"managed"`。迁移只登记本机默认值，启动和切换导航不会自动写入 VS Code 文件。需要应用新范围时，修改勾选或点击「重新同步」。此范围只作用于默认目标文件，不删除 ModelDock 的全局供应商或模型；其他 profile 仍需手工合并。

## Copilot app 原生同步

先启动 GitHub Copilot 桌面应用，再在 ModelDock 勾选来源或改变「ModelDock 首选模型」，会自动同步供应商与模型，无需退出或重启 Copilot。API 来源独立直连上游，使用对应 API Key 和真实模型 ID；订阅来源只写入本地连接密钥和模型别名，OAuth 凭据留在 ModelDock。不同来源可注册相同模型 ID，每条模型独立配置 Chat Completions / Responses；稳定 UUID 用于识别本资料目录下的托管项。

Copilot 默认开启「仅保留所选供应商」，同步会先备份，再清理未选中的自定义来源，包括此前手工添加的套餐；全部清空会清理所有自定义来源。关闭这个选项则只更新 ModelDock 托管项，保留其他自定义来源。GitHub 内置模型、账号和 MCP 不删除；聊天正文保留，被删除来源与旧会话的关联可能由 Copilot 解除。首选模型是 ModelDock 的配置偏好，不主动切换已打开聊天；同步后请在 Copilot app 的模型选择器中选择。

连接使用当前 Copilot 资料目录（默认 `~/.copilot`，可由 `COPILOT_HOME` 指定）内的运行实例信息，只访问本机原生接口。ModelDock 不直接编辑 `data.db`，也不复制整个数据库或对话记录。Windows 清理旧来源前只按其明确 UUID 备份两个 Copilot 供应商凭据目标的原始字节，不解码、展示或枚举其他应用与账号凭据；备份立即加密保存。Linux 等平台没有已验证的安全凭据备份接口时会拒绝清理，不会冒称已恢复凭据。`modeldock-copilot-desktop.json` 预览 / 导出仅供检查同步计划。

每次写入前将原配置、凭据备份和恢复计划加密保存到 ModelDock 的管理记录与私有备份。部分写入失败会尝试恢复；恢复未完成时保留待恢复记录，下次同步先恢复再执行新计划。无法安全备份时先拒绝修改。同步串行发送写入，不盲目重试写请求；读取遇到原生凭据工作队列繁忙时有限退避，减少重复的全供应商凭据查询。Copilot 未运行时选择仍保存，打开应用后可重新同步。

工具页提供「全选可用」与「清空选择」，覆盖搜索结果之外的来源，批量操作只保存并同步一次。未授权、停用或没有兼容模型的来源不加入全选。每张供应商卡片均提供删除入口：删除会影响全局供应商及模型，并同步关联的自动接入工具；失败会恢复本地记录并尝试修复工具配置。删除前保存加密备份，历史用量保留。

## 使用流程

界面按工具、供应商、功能三个区域组织：左侧上方选择五款工具，中间第一项是「聚合供应商」，其下是全局来源；下方进入模型目录和服务日志。右侧直接显示所选对象的配置与模型，供应商使用紧凑列表。切换导航不会修改已有工具绑定。

1. 在左侧「模型供应商」标题下点击「添加 API」或「添加订阅」，填写地址和密钥，或点击 GPT/Grok 来源的登录按钮。API 密钥留空表示保留原凭据。保存来源不强制读取模型列表；供应商未提供目录接口时，可直接手动添加模型再测试连接。
2. 已有来源可在供应商详情点击「获取模型列表」，搜索并勾选模型，按需修改简称及显示名称，再批量加入目录。已添加的模型保持原接口 ID 并自动跳过；简称仅需在当前供应商内区分，跨供应商可重复。上游不提供模型目录时会显示具体错误，可改用「手动添加」。获取成功仅表示目录可读，模型是否可用须实际请求确认。
3. 在左侧选择工具，在供应商行左侧勾选需要的来源，并在顶部选择模型偏好（VS Code / Copilot app 显示为「ModelDock 首选模型」）。VS Code、OpenCode、Codex 和已运行的 Copilot app 会自动同步，状态显示「本次选择已同步」；取消勾选也会更新配置。VS Code 和 Copilot app 默认开启「仅保留所选供应商」，会先备份再清理未选中的历史自定义来源；如需保留，请关闭此项。同步失败时选择仍保存，可处理后点击「重新同步」。
4. 已有绑定可先点击「重新同步」应用现有选择，也可随时预览。修改来源地址、Key 或模型参数后，请再次同步；使用文件配置的工具可能需要重新加载。VS Code 默认写入 `Code/User/chatLanguageModels.json`，其他 profile 需要手工合并。Copilot app 使用正在运行的实例，不需要 JSON 导入。DSH 的原生热更新启用时会自动读取修改；未启用时重启 DSH。默认模型用于新会话，已有会话需切换模型或新建。
5. 在工具中选择模型并发出请求。VS Code / Copilot app 同步后还需在自己的模型选择器选择模型；ModelDock 的首选模型不会切换已打开聊天的当前模型。经过本地入口的请求可在服务日志查看状态、耗时和实际来源；API 直连请求不经过网关。

只有一个连接分组时，配置预览可复制对应连接密钥：API 直连复制来源 Key，本地托管复制本地 Key。多个独立 API 分组没有共用密钥，应按导出的分组分别配置；DSH 自动同步各组的本地凭据引用，不复制订阅 OAuth 令牌。DSH 预览 / 导出只含原生插件覆盖，密钥由一键应用另写凭据文件。

供应商卡片的「测试连接」与「获取模型列表」独立：点击测试图标直接使用当前供应商模型列表中的第一条模型（包括未启用的模型）发送一次短请求，不弹出选择框。默认模型显示在卡片右侧，状态、HTTP 和耗时在卡片内更新；删除第一条后自动使用下一条。没有模型时提示先添加，并禁用测试按钮。不会访问 `/models` 或自动新增模型，不提供目录的套餐仍可先手动添加模型再测试。订阅复用本机授权与续期，测试不改变来源或模型的启用状态。厂商只返回思考内容或短测试达到输出预算时，按实际推理证据确认连接，并区分完整回答与短测试截断；HTTP 200、空响应和任意用量 JSON 均不单独证明成功。测试仅说明此次所用模型的调用结果，不代表其他模型权限；需要少量上游调用用量。30 秒超时与响应大小限制会明确提示，达到短测试输出上限时不会假称已完成完整回答。生成正文及凭据不会展示或记录在测试结果中。

「添加订阅」支持 Codex、GitHub Copilot 和 Grok Build。Copilot 可选择授权中心已登录的 GitHub 账号，或保存后在官方 GitHub 页面完成设备授权。来源只保存账号引用，GitHub 长时凭据留在本机加密账户存储；推理时兑换短时 Copilot 凭据并在内存中续期。模型按官方目录实际声明选择 Chat Completions 或 Responses，本地网关提供对应接口，工具只获得本地连接密钥。移除账号会清除关联来源的授权引用，来源和模型配置保留。此功能独立于向 Copilot app 同步自定义供应商的工具接入功能。

例如火山 Agent Plan、火山 Coding Plan 都可添加 `glm-5.3`，显示为「火山 Agent Plan - glm-5.3」与「火山 Coding Plan - glm-5.3」。发生跨来源重名时，系统自动使用稳定的来源 ID 区分聚合路由，不要求手动改模型名；预览或导出的客户端配置使用正确的接口 ID。API 直连仍发送真实上游 ID。已有接口 ID 不会因为其他来源被添加、删除或改名而改变；无需迁移或重写旧模型及凭据。

模型列表可能只返回 ID。未返回的上下文保持「未设置」（数据库值为 0），工具和图片能力分别标明未提供；可在批量设置或添加后编辑。未知工具能力的新增模型默认允许客户端尝试工具调用，不代表供应商已保证支持。导出 DSH、OpenCode、VS Code 配置时，未知上下文使用本地 32K / 4K 输出预算；Codex 则省略可选的上下文字段。这些是客户端配置预算，不是上游规格。

API 来源按名称、类型和规范化地址防重复：添加预设时复用已有空记录，同一密钥重复保存返回原来源，双击提交也不会追加记录。若使用另一把 Key，请编辑已有记录或为不同账号设置不同名称；路径不同的套餐入口仍分别保留。

旧版本已有同名同地址记录时，「聚合供应商」会出现「整理重复供应商」。页面会比较本机凭据并展示模型数量；仅相同密钥或空预设可合并。启用状态、预设不一致，或凭据无法读取时会给出原因。合并需先停止本地服务，操作前自动备份数据库，保留所有模型 ID、别名、用量历史和默认模型。只选择部分重复来源的工具会保持原模型范围；原本选择完整来源的工具继续自动包含新模型。整理不会自动运行，也不会删除同一上游模型的不同别名，以免破坏已有工具配置。

统一地址为 `http://127.0.0.1:18181/v1`。工具专用入口例如 `http://127.0.0.1:18181/tool/dsh/v1`，只发布该工具绑定的模型。聚合和订阅使用本地 Key；API 直连分组使用对应来源的 Key。

预设地址：DeepSeek `https://api.deepseek.com`；火山 Agent Plan `https://ark.cn-beijing.volces.com/api/plan/v3`；千问 Token Plan 默认中国站 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，国际站须按控制台调整。

火山 Coding Plan 的地址应为 `https://ark.cn-beijing.volces.com/api/coding/v3`；普通方舟 API 的 `/api/v3` 是另一个计费入口。使用对应套餐/用途和凭据。

## 接入边界

- ModelDock 独立于 OpenAI、GitHub、xAI 和各工具厂商。兼容接入使用现有公开客户端标识和已观察到的授权/额度/本机接口，不是 ModelDock 自注册的官方 OAuth 应用，也不代表官方背书。公开客户端 ID 不是秘密；不要删除它们来代替协议审查。提供账号访问、模型目录或额度数据不等于服务承诺稳定私有接口或授予每个模型的推理权限。使用这些服务仍须满足上游账号、权限和服务条款。
- GPT 登录目前是兼容 Codex 公开客户端的设备码流程，不是为 ModelDock 动态注册的新 SIWC 应用。授权、实际账号额度和模型权限需用户登录后验证。
- 授权错误按申请设备码、等待授权、兑换凭据和续期步骤显示安全诊断，区分地区限制、设备码未启用、明确拒绝、过期和网络超时。Codex 专属设备授权轮询中的 JSON 403 / 404、`deviceauth_authorization_pending` 均可表示尚未输入验证码，会保持等待、保留验证码和复制按钮，并提供官方授权页面链接；这些状态不表示已完成授权。HTML 拦截、明确拒绝及过期会停止轮询。已有有效账号再次登录失败时保留原授权。设备码的账号 / 工作空间权限条件及本机授权缓存方法参见 [OpenAI 官方授权说明](https://learn.chatgpt.com/docs/auth)；登录失败页可前往授权中心显式导入已登录客户端，导入按钮才读取本机授权文件。
- 原生订阅仅支持 Responses；Chat Completions 与 Responses 按模型配置严格区分，不做未验证的跨协议转换。DSH/VS Code/Copilot 配置可以指定对应协议。
- 订阅路径使用 `store:false`，需要发送完整会话历史；不能依赖 `previous_response_id` 或服务端持久化对话。原生 WebSocket 续接尚未实现。千问 Token Plan 的 Responses 支持也需按具体模型选择，不能以套餐名称一概认定。
- Codex 的导出与目录只发布 Responses 模型。生成的目录含客户端要求的基本字段，但复杂工具、推理档位、视觉行为仍需逐模型验证。
- DSH 应用目标是 `DSH_HOME`（未设置时 `~/.dsh`）的 `cordis.patch.yml` 与 `.credentials.yaml`，适配已验证的 CLI 0.1.7-rc.2 / Desktop 0.2.0-rc.2 原生插件格式。默认开启「仅显示所选供应商」：发布所选 pi-ai 路由，停用原生 DeepSeek API / 账号模型适配器及其他已识别模型来源；保留独立平台账号授权服务、凭据和会话。全部取消仍保持模型来源为空；关闭此选项才恢复原模型适配器的启用标记，原配置来源可与 ModelDock 来源共存。不同接口拆分路由，默认模型用于新会话。同步前通过隐藏的只读进程解析实际 profile / 运行时，识别嵌套及改名适配器；解析不完整或缺少标准核心插件时明确拒绝写入。原 profile 文件不改写；两文件先加密备份，失败恢复，外部并发修改冲突时保留恢复记录并拒绝覆盖。配置写入不主动切换已有会话。
- DSH 旧 DeepSeek 会话仍可能引用 `deepseek-official` / `deepseek-account`。独占模式选择官方 DeepSeek API 来源时，ModelDock 会安装无凭据的受管同模型兼容插件，让这些旧引用调用所选来源中的同一上游模型；聊天日志、模型选择及原请求对象不改写。相似显示名、其他套餐、不同模型或无法确定的重复来源不自动映射。兼容路由没有可配置目录和模型枚举，模型设置页与新会话选择器仍只展示所选来源。插件源、配置及凭据一同纳入加密备份与失败恢复；关闭独占或清空选择会撤销插件，静态无凭据代码文件留在本地作为非活动文件。未包含旧模型时，请在 DSH 切换模型或新建会话。
- Copilot app 接入使用桌面应用的本机原生供应商接口，按 1.1.26 的协议实现，不把 CLI `providers.json` 或 SDK 会话参数当成桌面配置。预览只是原生同步计划参考，需要应用运行才能同步；版本接口变化会明确报错。Windows 隔离原生实例已核对，Linux 桌面与凭据存储效果仍需实测。OpenCode 使用各模型的 npm SDK 配置选择 Chat/Responses 协议，保存时合并 JSON/JSONC。
- VS Code 接入目标是 Copilot Chat 的 Custom Endpoint，默认写入用户配置 `Code/User/chatLanguageModels.json`。默认范围会替换该文件中的全部 `customendpoint` 分组；关闭「仅保留所选供应商」后只更新 ModelDock 分组。应用不会自动识别其他 profile；使用其他 profile 时请预览 / 导出后手工合并到对应位置。同步只是注册模型来源，实际聊天模型须在 VS Code 选择器中选择；此接入不能据此宣称所有编辑器 AI 功能都被替换。
- 模型列表、上下文和工具/视觉声明不会授予上游权限；错误会明确返回，日志不记录请求正文与密钥。

### 适配与导入维护记录

| 接入 | 当前兼容目标 / 参考 | 验证范围 |
| --- | --- | --- |
| Codex 设备码、额度和目录 | 公开客户端兼容流程；目录 `client_version` 为 `0.159.0`；授权协议、CC Switch v4.0.0 / 固定参考提交见源码 | 模拟授权、续期、取消和目录解析；账号授权与各模型推理分别验收 |
| Grok / xAI | 公开 OIDC 设备码与已观察到的 Build 额度协议；客户端兼容版本 `1.0.44`；CC Switch v4.0.3 | issuer / scope 校验及额度解析 fixture；缺少明确结构时显示未知 |
| GitHub Copilot 账号 | GitHub 公开设备码、公共 `/user` 身份查询及已观察到的 Copilot 额度接口 | pending / slow_down、取消、身份校验和额度 fixture；不是 ModelDock 自注册应用 |
| Copilot app 配置 | 原生本机供应商接口兼容目标 `1.1.26` | Windows 验证产品、GitHub 签名及端口归属；当前 Linux 生产入口因缺少已验证的厂商身份接口而拒绝连接，不发送凭据 |
| DSH 配置 | CLI `0.1.7-rc.2` / Desktop `0.2.0-rc.2` 插件及凭据格式 | 原生 profile 解析、备份及只读/写入回归；未知布局拒绝覆盖 |
| Codex 会话导入 | `sessions` / `archived_sessions` 的用量元数据，参考 CC Switch 会话实现 | 累计快照、回放、截断和幂等 fixture；仅提取用量字段，不保存聊天正文 |
| OpenCode 会话导入 | V1 / V2 SQLite 元数据与 SQLite 官方 WAL 格式 | 校验已提交 WAL 的内存快照、字节不变和幂等 fixture；未知 schema 明确报告 |

协议和私有接口可能变化。新增或升级适配时应一同更新固定参考版本、元数据 fixture、拒绝未知结构的行为，以及 README / VALIDATION 中的实际验收边界。单元测试、隔离原生渲染和真实工具 / 账号验收不能互相代替。

## 数据与跨平台

默认数据在 Electron 的 `userData` 目录：Windows `%APPDATA%/ModelDock`，Linux 的用户配置目录下 `ModelDock`（实际路径见界面）。开发版和便携版的确切目录由 Electron 应用名称决定，界面显示的是权威位置。

数据库是实际 SQLite，通过 sql.js 的 SQLite WebAssembly 引擎持久化到 `modeldock.sqlite`，不需要为不同 Electron ABI 编译数据库扩展。凭据优先使用系统加密；无可用 Linux keyring 时使用本机私有 AES 密钥文件。Windows/Linux 各自授权，不要把旋转中的 OAuth 凭据当作两台机器的同步配置。

`MODELDOCK_DATA_DIR` 可覆盖数据位置，用于隔离测试。源目录的 `work/`、构建产物和运行数据被 Git 忽略。

## 项目结构

```text
src/main/       Electron、SQLite、网关、OAuth、工具配置适配器
src/renderer/   React 图形界面
src/shared/     前后端类型与受控接口
tests/          本地模拟上游、持久化、OAuth、配置合并测试
scripts/        开发、构建和 Electron 原生渲染验证
```

真实账号授权/推理与 Linux 原生运行需另行验收；自动化验证的结果见 `VALIDATION.md`。
