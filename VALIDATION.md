# ModelDock 0.3.33 验证记录

日期：2026-10-07（Asia/Hong_Kong）。

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
