# ModelDock · 模型坞

**配置一次，让模型连接你的工具。**

ModelDock 是跨平台本地模型管理台：全局维护模型来源与别名，为各工具选择供应商，按工具能力直连上游或使用本机统一接口。界面使用 Electron、React、TypeScript、Vite；Node.js 后台和 SQLite 数据存储独立于界面。

0.4.0 起包含 FlowBridge 的组合发行版采用 [GPL-3.0-or-later](LICENSE)；原 ModelDock 代码及原创应用标记保留 [MIT 授权](LICENSE-MIT)，第三方图标和依赖保留各自的 Apache-2.0、CC-BY-4.0、MIT 或其他许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。欢迎按 [贡献指南](CONTRIBUTING.md) 提交修复；敏感问题请遵循 [安全报告流程](SECURITY.md)。

## 0.3.91 · 修复 TRAE 原生函数工具请求

- 修复附带函数工具时 TRAE 返回空 HTTP 400 的问题。向 Raw v2 发送完整 JSON 字符串形式的函数 schema，工具历史使用原生 `function_call` 字段；保留调用 ID、函数参数和工具结果的对应关系。
- 兼容回答前的文本排队通知；通知不算回答，仍须收到真实输出和正常结束事件。保留流式增量、取消和错误处理。
- Windows 网络排查确认，系统 PAC 可能将 JetBrains AI 分为直连；可在设置中显式保存本人已有、能访问该服务的本机代理，再刷新额度与模型。没有自动改写代理或账号。

## 0.3.90 · TRAE 与 VS Code Copilot 兼容

- 修复 VS Code Copilot 为 TRAE 原生连接自动发送输出预算而导致普通文本请求被拒绝的问题。重新同步 VS Code 配置并重新加载窗口后，使用 TRAE 的原生输出与采样默认值；保留模型的推理强度选项，其他来源和已保存的模型参数不变。显式要求的未支持控制仍会指出具体参数。
- TRAE 根据模型目录声明使用新旧原生推理强度字段，保留 `xhigh`、`max` 等原始等级，不把它们改写成其他档位。
- JetBrains AI 的 HTTP 451 不再误报为账号授权失败或 HTTP 401。模型目录、额度与网关保留实际错误，并提示检查应用网络代理；此修改不能解除服务对当前网络来源的限制。

## 0.3.89 · 模型列表过期后可直接添加

在获取模型列表窗口停留超过 10 分钟后，点击「添加所选模型」会自动刷新同一供应商的目录，重新核对所选模型，再保存勾选项和已编辑的参数。提交结果显示在窗口底部的操作按钮旁。

## 0.3.88 · 修复 TRAE 中国版模型可用性

TRAE 订阅按当前客户端协议获取官方模型路由，并按账号权限标明可添加的模型。再次打开供应商的「获取模型列表」即可刷新。网关同时支持新版 TRAE 返回的流式回答与思考片段。

## 0.3.87 · 精简设置

移除首选终端与打开终端功能，以及对应的启动逻辑和桌面接口。升级时兼容读取旧设置，保留主题、代理、窗口与启动偏好；实际 Agent 的 CLI 模型接入继续保留。

## 0.3.86 · 按客户端清单显示订阅模型

- Codex、Grok、GitHub Copilot、TRAE CN、JetBrains IDE 订阅的获取模型窗口增加「显示历史模型」，每次打开默认关闭。默认只显示已确认属于对应客户端清单的模型；勾选后查看其他仍可读取的历史或额外通道，未核实展示状态的条目单独标明。
- 切换只影响发现窗口，不删除已有模型、不修改工具绑定。隐藏项不会被批量设置或随添加按钮提交；同名的不同官方通道保留各自原始标识。
- TRAE 按导入的 CN / SOLO 产品和账号，只读匹配本机最近的 Chat 模型缓存，不包含个人 BYOK。客户端存在而当前直连接口未返回调用配置的模型会显示「暂不支持添加」；不会编造调用路由。清单变化时先在 TRAE 刷新，再重新获取。
- JetBrains IDE 按已核实的 2026.2 / Junie 单模型清单与当前账号官方档案对应，不把 Junie Mixes、Lite 等复合模式伪装成通用接口。其他订阅依据官方默认可见性字段，本地实验或手动隐藏仍以客户端为准；没有可核实清单时明确提示，勾选后才显示未核实条目。

## 0.3.85 · 按订阅显示重置提示

- 授权中心仅为 Codex 和 Grok 显示额度重置提示；Copilot、TRAE CN 和 JetBrains AI 的账号行及详情隐藏重置倒计时、未知时间和重置次数提示。
- 保留许可证/积分有效期、额度数值、最近查询时间与查询按钮；不修改上游额度数据或自动查询行为。

## 0.3.84 · JetBrains 多许可证与准确套餐

- 修复只导入 IDE 当前所选许可证、套餐显示未知的问题。现在从官方四类 AI 产品目录读取当前账号已有的个人许可证；单一已确认账号一键导入全部可用许可证，同一许可证跨产品重复返回时只保留一个来源。
- 每张许可证独立显示官方套餐、脱敏标识、到期时间及额度，多个 AI Free 许可证也分别保留。重新导入精确复用对应账号与许可证，保留原来源、模型和工具绑定，不改绑另一许可证或已有 Central 来源。
- 多账号或工作区来源仍需明确选择；刷新额度可为已有许可证补充官方套餐，不创建其他来源。目录失败保留上次核验信息及时间，不按余额猜套餐，也不合并不同许可证的额度。
- 目录与授权适配全部在 Electron 主进程 TypeScript 内完成，不需要 JVM 或额外服务。无法确认新 JCP 目录令牌的账号归属时明确拒绝，不回退到个人目录；Junie Lite 和组织工作区不当作个人 AI 许可证。

## 0.3.83 · 授权中心统一账号行

- GitHub Copilot、Codex、Grok、TRAE CN、JetBrains AI 统一使用紧凑账号行：左侧头像、账号与套餐，中间横向额度，右侧查询时间、刷新与操作菜单。TRAE / JetBrains 不再把导入说明和账号设置按钮铺成大块卡片。
- TRAE 总可用积分与分组额度保留，详细积分包仍在账号详情查看。当前额度账号与历史导入来源分别展示，完整授权状态、来源和说明移入详情；额度未知、缓存过期与错误提示继续保留。
- 本版只调整展示和操作入口，不修改账号、授权、额度解析、余额、模型或工具配置。

## 0.3.82 · JetBrains 实际调用与连接测试预算

- Claude / Gemini 原生流式调用已通过本机账号实测；当前读取到59个兼容Chat档案。仅核验所测两款模型，不把目录数量当成全部模型推理通过。
- JetBrains 原生账号的「测试连接」采用256-token短请求预算，并遵守所选模型更低的输出上限。避免极小预算让带内部思考的模型没有可见回答而被误报失败；其他来源和不自动重试规则保留。
- 反代仍全部通过主进程TypeScript与现有Gateway；不增加外置服务、容器或账号监听端口。普通客户端请求预算由客户端明确控制，不因连接测试调整而被改写。

## 0.3.81 · JetBrains Claude / Gemini 原生模型

- IDE 账号导入的模型目录保留已授权、未弃用的 OpenAI / Azure OpenAI，以及 Anthropic、Google、Bedrock、xAI 等官方 Chat 档案。Claude / Gemini 等非 OpenAI 模型使用官方 Grazie V9 统一聊天接口与原始 profile ID；OpenAI 原有通道保持兼容。点击供应商的「获取模型列表」刷新后添加所需模型，无需重新导入账号。
- 全部适配在 Electron 主进程 TypeScript 中完成，复用现有账号授权和 Gateway，不启动容器、外置反代或额外监听端口。支持文本、内嵌图片、客户端函数工具及流式 / 非流式调用；工具与图片能力只采用官方档案明确声明的字段。
- 内容和工具参数增量即时输出，客户端取消向上游传递，错误、超时、提前断流和无效终态不能被包装成成功。Google 工具历史的不透明签名只保留在按账号、模型和历史范围隔离的有界内存缓存中，不进入界面、日志或外部配置；缺失的必需签名明确拒绝，不能伪造或借用另一会话的签名。
- V9 当前适配不接收扩展思考预算 / `reasoning_effort`、无法保留签名的思考历史、远程图片 URL 或多个停止词。图片使用内嵌 data URL；暂不支持的参数在推理请求前明确拒绝。官方 V9 的积分元数据不被伪造成 Token usage。模型可见性及离线协议验证不代表真实账号逐模型调用已通过。

## 0.3.80 · 订阅来源统一命名

- 五类订阅统一默认显示为 Grok 订阅、GitHub Copilot 订阅、Codex 订阅、TRAE CN 订阅和 JetBrains AI 订阅；添加预设和客户端导入采用同一名称。
- 已有的历史自动名称按对应订阅类型更新显示，保留数字后缀和自定义名称。订阅名称展示与账号身份、供应商 ID 及外部配置名称分开处理。

## 0.3.79 · JetBrains 一键从客户端导入

- 授权中心 JetBrains 入口改为「从客户端导入」，点击后默认从本机 IDE / Air 读取并导入当前账号；单一账号与许可证不再显示前置说明或确认弹框。
- 同一账号和许可证在多个 IDE 中出现时只导入一次，优先沿用已导入的来源。不同账号、许可证或不支持的授权来源需要明确选择；导入失败不会切换到其他来源或 Central。
- Central 保留在「其他连接方式」。启动和普通导航不触发导入，已处理的导入请求不会在再次进入授权中心时重放。

## 0.3.78 · TRAE 官方可用积分汇总

- 按已核实的 TRAE 中国版客户端规则，成功额度响应中省略的用量表示未使用；显式错误类型和未知余额仍保持未知。总可用积分按有效积分包合计，保留原始精度后统一显示两位小数。
- 授权中心显示总可用、官方来源分组和单笔明细；到期时间与额度重置分开处理，单笔到期后重新查询。请求次数与积分独立统计，不会把总额和分组重复相加。
- 经用户明确授权的一次只读官方额度查询及脱敏离线复验，确认 19 笔签到剩余 1313.8036、赠送剩余 500，合计显示 1813.80。未刷新令牌、修改客户端或发起模型生成。

## 0.3.77 · TRAE 多额度包显示修复

- 额度和套餐统一按官方状态及有效期筛选，排除未生效、过期和终止包；已耗尽、余额未知的有效额度仍保留，不把独立资源包随意合计。
- 授权中心列表最多显示两项额度，其他额度通过「查看全部 N 项额度」进入可滚动详情；扩宽额度标签，避免多项数据撑高账号行。旧版额度缓存会重新查询，已有账号、模型和工具配置保持不变。
- Linux 全量 2376 项测试通过、6 项按条件跳过；真实 Electron 的 40 项额度、明暗主题和窄/宽窗口验证通过。真实账号官方额度查询本轮未执行，模型推理范围不变。

## 0.3.76 · 统一网关适配器与及时流式转发

- 所有托管账号使用 TypeScript 适配器接入现有网关。TRAE 和 JetBrains 不再启动 Docker、Python、Pi 或额外的本地反代监听；Codex、Grok、Copilot 沿用主进程的原生授权和请求转发。
- TRAE 在授权中心从中国版 / SOLO 中国版客户端导入，登录资料经主进程加密保存。模型目录与套餐、额度直接查询上游；套餐按官方有效权益显示，无法确认时显示「套餐未知」。
- 普通工具和 JetBrains 工具都及时转发内容、推理和工具调用增量，并传播取消请求与背压。只在最后校验终态后发送成功标志；已开始的流中途失败会明确终止，不伪造成功，也不重试推理。
- 原本的账号名称、模型映射和工具绑定继续保留。旧 TRAE / Central 中转未保存可导入的原生授权时，需在授权中心重新连接；自定义外部 API 连接仍按保存的地址使用。
- 协议能力必须符合账号原生接口。TRAE 当前 raw v2 只支持已核实的文本和函数工具历史；不静默丢弃输出预算、多模态或服务器会话等未验证参数，相关请求明确返回能力错误。Claude Messages 必需的输出预算尚未被该 raw 协议证实，暂不能宣称兼容。

## 0.3.75 · Windows 账号导入与验证修复

- Windows 可从已登录的 2026.2 IDE / 内置 Air 导入本人 JetBrains Account。只读原生 Java Preferences 的三个固定注册表值，按 JBR 的编码解码，并从 `%APPDATA%/JetBrains/<IDE2026.2>/options/other.xml` 核对当前个人 AI 许可证。确认导入时再次核对账号与许可证；不写入原客户端或 PasswordSafe。
- 账号导入入口按当前系统能力启用；独立 Air、macOS 暂不支持。只读本机账号选择、官方授权交换、额度和模型推理分别验证。
- 修正 Windows 测试中的 GitHub CLI 路径、PATH 分隔符、Linux UID 模拟和文件权限断言。安全检查保留；系统未授予文件符号链接权限时，仅跳过无法构造的链接场景。
- 界面检查跟随当前单入口供应商选择与导航；侧栏按实际页面宽度验证，避免将 Windows 外窗尺寸当作内容尺寸。

## 0.3.74 · 直接复用 IDE 的 JetBrains AI 账号

- 授权中心提供「从 IDE / Air 导入」，不再要求先安装 Central CLI。支持 Windows / Linux 2026.2 Rider、IntelliJ IDEA、WebStorm、PyCharm 的本人账号及 IDE 内 Air；Windows 原生读取自 0.3.75 接入。独立 Air、macOS 原生账号读取暂不支持。Central 保留为独立的另一种连接方式。
- 只读固定的 JetBrains Account 身份槽与已选个人 AI 许可证，确认后通过固定官方服务交换并验证授权，显示会员/加购 AI Credits。账号或许可证在预览后切换会拒绝导入；明确选择组织工作区时不回退到另一张旧许可证。
- JBA 身份断言的历史 `exp` 是提示，不等于服务访问授权到期。原生调用链由官方服务判断该断言；ModelDock 对派生服务令牌仍执行官方 verify 和有效期检查。已用本机当前 Rider 选择完成只读现场验证：授权、额度（2 个窗口）与兼容模型目录（23 个模型）均成功，未发送推理或注册/激活试用。
- 本机中转只接收独立的本地密钥，JBA/Grazie 授权留在主进程加密存储。模型目录与 Chat 请求通过已核实的原生 OpenAI/Azure 转发通道，使用授权档案对应的实际模型 ID；其他厂商档案暂不作为兼容模型发布。推理不自动重试；客户端断开会取消请求。
- 导入失败保持原有供应商；重复导入保留名称、备注、本地密钥、模型和工具绑定。读取及授权交换、官方额度、模型目录与实际推理分别验证，不把其中一步当成全部成功。

源码协议依据安装的官方 2026.2 账号与 AI 客户端及[公开 AI 平台配置](https://www.jetbrains.com/config/JetBrainsAIPlatform.json)。这属于内部协议适配，后续客户端/服务更新可能需要跟进。没有读取 PasswordSafe、浏览器 Cookie 或 IDE 会话历史；没有改写原 IDE 配置。已有 Wayland 首显颜色和 TRAE 官方额度修复继续保留。

## 0.3.73 · Wayland 首显颜色与 TRAE 官方额度

- Linux 原生 Wayland 的首次窗口发灰已在宿主原生截图中复现，DOM 与内部位图均正常，且窗口没有无响应或不透明度变化。五组单变量对比中，仅关闭 Chromium `WaylandWpColorManagerV1` 后两轮原生截图与内部位图像素一致；单独强制 sRGB 无效。现在在 Chromium 初始化前应用这一限定兼容项，保留 GPU、已有参数和显式 X11 / 用户覆盖，不修改 KDE、ICC、HDR 或桌面效果。
- TRAE 托管反代现在查询原生账号专属官方权益接口，按积分包与快速请求次数分别显示已测得的剩余/总量，并提供刷新。查询前后均核对反代当前活跃账号，独立显示额度所属账号，历史导入来源不当作当前身份。缺字段显示未知，不能把反代本地待结算预估或签到奖励当成官方余额；模型推理仍需单独测试。
- 同连接重新导入也会更新私有版本并清理额度缓存；旧查询不能在导入或账号切换后覆盖新状态。手动反代与自定义地址不使用此托管额度查询。
- JetBrains 入口更正为「连接 JetBrains 账号」：先明确 IDE/Air 当前会话暂未实现直接导入，再由用户选择检查独立 Central CLI 登录；不再把缺少 Central CLI 误呈现为 IDE 导入失败。IDE/Air 的原生账号/额度入口与官方 Central 准备说明分别提供。没有读取 PasswordSafe、浏览器 Cookie 或真实 IDE 会话；Central 不是 IDE 会话导出。

Linux 颜色兼容项有真实 Wayland 窗口与同进程位图对比；额度协议使用合成账号与模拟服务验证，没有领取积分或发起模型推理。Windows 包做静态验证，未原生运行。

## 0.3.72 · TRAE 与 JetBrains 客户端授权导入

- 授权中心的「TRAE 中国版反代」「JetBrains AI 会员反代」均增加「从客户端导入」，先列出本机来源，再由用户确认。成功后立即刷新订阅供应商与最近导入来源。
- TRAE 只读已核实的 CN / SOLO CN 客户端授权槽，经加密导入主进程，由现有网关直接连接上游。客户端凭据过期时需先回客户端重新登录，再重新导入。
- JetBrains 复用 **Central CLI 当前已登录账号**，由原生 CLI 检查登录与会员额度权限，再启动本机 Central / Pi 桥。不复制 Central 凭据，不读取 IDE / Air 的 PasswordSafe；IDE 登录状态不能自动迁移为 Central 登录。
- 重复导入复用同一托管反代的连接，保留名称、备注、模型、密钥和工具绑定；手动 TRAE、其他地址或不同密钥的记录保持原样。来源记录随连接变化失效。导入等待期间的用户编辑不会被覆盖；本地保存失败会保留原供应商，并明确提示检查反代的实际账号状态。

TRAE 实现依据固定 [Trae2api-cn v1.0.10 授权格式](https://github.com/autumnsentiment/Trae2api-cn/blob/v1.0.10/src/trae_decrypt.py) 与其原生 `/api/web-auth` 接口；Central 使用 [官方 CLI 命令](https://www.jetbrains.com/help/central-cli/cli-commands.html)。源客户端不被改写，令牌不经过界面或诊断日志。TRAE 的保存成功不代表云端授权、额度或模型推理已验证；Central 的授权校验也不能代替模型测试。

Linux 使用合成授权、模拟反代与真实 Electron 界面验证，没有导入用户账号或发起真实模型推理。TRAE Windows 路径与格式有固定源码证据和模拟测试，Windows 原生运行仍未验证；macOS 的 TRAE 路径未核实，界面明确引导使用反代授权页。

## 0.3.71 · 侧栏调宽与横向分类

- 拖动侧栏右边缘调整宽度；松开后保存本机显示偏好，重新打开仍保留。窗口变窄时临时限制侧栏宽度，扩大后恢复偏好，避免挤压主要内容。
- 双击分隔条恢复默认宽度；分隔条聚焦后可用左右方向键、Home/End 调整，Esc 取消当前拖动。
- 模型供应商改为 API / 订阅横向标签，与上方工具分类一样，一次显示一类；标题和分类保持可见，供应商列表独立滚动。
- 分类切换只切换侧栏列表。打开供应商时自动显示其所属分类；订阅仍从授权中心添加。

## 0.3.70 · 首次显示激活与重绘

- 可见启动继续等待页面布局与原生首帧就绪，再显式激活窗口、聚焦页面，并请求一次完整重绘，避免依赖首次鼠标操作更新画面。
- 隐藏启动保持不显示、不激活；托盘和再次打开才展示窗口，不新增持续抢焦点或重绘定时器。
- 新增使用真实窗口展示流程及生产后台节流的隔离启动验证，记录点击前的原生/页面焦点、主题、计算样式与渲染像素。原有隐藏窗口界面检查不能替代这项验证。
- 本机 X11 与默认后端的隔离基线未复现用户截图中的持续灰化；首显加固仍需在原有工作空间复测。页面截图验证只覆盖 Electron 渲染表面，不代表验证了桌面合成层。未修改 KDE 配置或关闭 GPU。

## 0.3.69 · 统一服务入口与客户端授权导入

- 侧栏模型供应商按 API、订阅两组展示。添加 API 位于 API 分组旁；添加订阅集中在授权中心。
- 当时的「服务与日志」页统一了本地接口、接口内供应商与模型管理、服务启停和请求日志。从 0.4.1 起，这些功能在首页「服务工作台」中使用。
- 订阅与反代详情提供 ModelDock 本地 URL、本地密钥、已发布模型名称和调用方式。底层上游地址与模型映射移到设置中的连接原理；本地调用使用实际通用 `/v1` 入口及已发布的模型别名，不额外创建供应商专用路由。
- GitHub Copilot 在授权中心增加「从客户端导入」，仅在用户点击并选择来源后读取受支持的本机客户端授权，导入到 ModelDock 的加密账号存储，保持原客户端配置不变。

Copilot 导入目前支持 **Copilot CLI** 与 **GitHub CLI (`gh`)** 已登录的 GitHub.com 账号。点击后只从它们的固定配置位置列出账号；选择账号并确认导入后，读取对应的 CLI 明文授权槽或系统凭据，向 GitHub 官方接口校验账号身份和 Copilot 额度。同一 GitHub 账号复用已有记录；身份不符、授权失效或订阅权限被拒绝时不保存。缺少额度字段会明确显示未知，账号导入不代表模型推理已验证。

Copilot CLI 支持 `COPILOT_HOME`，读取 `config.json` 中已登记账号对应的 `copilot-cli` 钥匙串条目或明文备用槽；Linux 钥匙串锁定、同账号凭据重复或无法建立加密会话时停止导入。GitHub CLI 支持 `GH_CONFIG_DIR` 和标准配置目录，通过 `gh auth token --hostname github.com --user <所选账号> --no-refresh` 读取，避免刷新或更改原客户端授权，且不接受环境变量覆盖成另一账号。[Copilot CLI 官方认证与凭据说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) · [GitHub CLI 账号令牌命令](https://cli.github.com/manual/gh_auth_token)

本版不读取 Copilot 桌面端独立账号库、VS Code/JetBrains 编辑器加密凭据库或 GitHub Enterprise 授权；这些账号可使用「登录 GitHub」在 ModelDock 中独立添加。导入不修改源客户端，不修改系统钥匙串，不读取会话、MCP 或 Skills。Linux 验证使用隔离的合成授权与模拟上游；Windows/macOS 系统凭据读取及真实账号推理仍需在对应平台验证。

## 0.3.68 · 订阅反代与界面整理

- TRAE 中国版反代和 JetBrains AI 会员反代统一放在「添加订阅」和订阅供应商分类；已有记录按预设自动归类，连接、密钥和模型绑定保持原样。
- 授权中心列出这两类反代，可添加订阅、进入反代设置和账号授权指引。反代密钥状态与上游账号授权分开显示，未查询的额度不显示为零。
- Junie 导航归入 JetBrains 标签，其独立 CLI / IDE ACP 配置流程保持原样。
- 请求日志使用独立滚动区域和固定表头，可使用键盘滚动，避免长日志推远后续内容。

## 0.3.67 · Copilot CLI 独立接入

在「常规 Agent → Copilot CLI」选择一家 API 直连，或打开「使用聚合接口」并选择来源、模型和默认模型。支持 Chat Completions 与 Responses：直连使用供应商真实 URL、模型 ID 和 API Key；聚合使用独立的 `/tool/copilot-cli/v1` 本机入口、模型别名和本机 Key，订阅令牌不写入 CLI。

同步合并官方 `providers.json` 的 ModelDock 来源和模型，只更新 `settings.json` 的默认 `model`，保留其他来源、GitHub 内置模型、账号、权限、MCP、Skills、会话和设置注释。两种协议分别显示在 `modeldock-chat` / `modeldock-responses` 下，预览可查看完整默认名称。重启 `copilot` 后通过 `/model` 选择，也可使用 `copilot --model <预览中的默认名称>`；命令行、环境变量或项目设置可能覆盖全局默认值。CLI 使用独立配置，不要求 Copilot app 运行。[官方添加模型说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-llm-models) · [配置目录与格式](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)

默认目录为 `~/.copilot`，支持 `COPILOT_HOME` 和 `COPILOT_PROVIDERS_CONFIG`。预览隐藏密钥，应用和导出才包含所需 API Key；CLI 原生配置需要明文 Key，ModelDock 写入时限制本机文件权限，备份与恢复记录加密保存。同步支持两文件事务回滚、撤销上次同步及还原同步前设置；受管来源或模型被外部修改时拒绝覆盖。需要支持命名来源文件的新版 Copilot CLI；模型还需支持工具调用和流式响应。模型配置不包含 MCP、Skills 或会话导入。

## 0.3.66 · 右键快捷操作

供应商侧栏和卡片、模型列表、工具导航和详情、本地聚合接口、请求日志、授权账号及诊断日志都支持右键菜单。可直接复制地址、模型名称和 API Key，打开编辑或详情，获取模型列表、测试连接、同步/撤销/还原工具配置；删除和清除授权仍先确认。聚合列表中的发布操作只改变本地通用入口，工具专用映射仍在对应工具内管理。

输入框使用原生撤销、重做、剪切、复制、粘贴和全选菜单；密码输入不允许通过原生剪切/复制取得遮罩或密钥，API Key 通过明确的复制操作读取。订阅来源没有复制授权令牌的菜单项，Air 不提供文件应用/撤销/还原。选中的普通文字保留原生复制，文档链接可右键打开或复制地址。

键盘可用 `Shift+F10` 或菜单键打开当前对象菜单，再用方向键、Home/End 和 Enter 选择，Esc 关闭并返回原焦点。菜单适配亮暗主题和窗口边缘，点击外部、滚动页面或切换页面时关闭；打开菜单本身不执行操作。

## 0.3.65 · Junie 终端与 IDE 配置

在「常规 Agent → Junie」选择直连供应商，或开启「使用聚合接口」，再选择默认模型。更改后会按现有同步流程备份并更新 Junie 的终端配置，以及 IDE 中独立的「Junie · ModelDock」ACP 入口。支持 Chat Completions 和 Responses，使用所选模型的原生协议；直连仅使用一家 API 的真实地址、模型 ID 和 Key，聚合使用 ModelDock 本机入口、模型别名和本地 Key。

- **终端**：安装 Junie CLI 后，运行 `junie --model custom:modeldock`，也可在 `/model` 的 Custom 标签选择。只把当前默认模型写入 `$JUNIE_HOME/models/modeldock.json`（默认 `~/.junie`），并合并 `config.json` 的默认选择；其他模型、账号、MCP、Hooks、项目配置及已有设置保留。项目配置、命令行与 Junie 自己保存的选择可能影响默认模型，以显式命令为准。[Junie 自定义模型](https://junie.jetbrains.com/docs/custom-llm-models.html) · [Junie 配置优先级](https://junie.jetbrains.com/docs/junie-cli-configuration.html)
- **IDE**：在支持 ACP 的 JetBrains IDE 中打开 AI Chat，选择「Junie · ModelDock」并开启新会话。ModelDock 仅在 `~/.jetbrains/acp.json` 合并自己的代理，保留其他代理和 MCP 设置；代理明确使用同一个 `custom:modeldock`。Windows 使用已安装 Junie 的原生程序路径，避免批处理转义；Junie 更新并删除旧程序后，重新同步即可刷新路径。[IDE ACP 接入](https://www.jetbrains.com/help/ai-assistant/acp.html) · [Junie ACP 模式](https://junie.jetbrains.com/docs/junie-cli-acp.html)
- **IDE 内置 Junie**：其 BYOK 激活目前仅接受 OpenAI 或 Anthropic 官方 Key，仍在 IDE 的「Settings → Tools → AI Assistant → Providers & API keys」中设置。ModelDock 的自定义模型通过上述独立 ACP 入口使用；不修改内置 Junie 的授权和 PasswordSafe。[内置 Agent 激活](https://www.jetbrains.com/help/ai-assistant/activate-agents.html)

预览隐藏密钥，导出和应用才写入所需 API Key；订阅授权令牌留在 ModelDock。同步包含加密备份、三文件事务回滚、撤销上次同步和还原同步前设置。受管模型或代理被外部修改时拒绝覆盖。使用聚合时保持 ModelDock 运行；切换默认模型后开启新会话。Junie 模型配置不包含 MCP、Skills 或会话导入。

## 0.3.63 · 在 VS Code 使用 JetBrains AI 额度

0.3.76 已用内置 TypeScript 适配器替换早期的 Central → Pi 独立会话中转。
在授权中心连接 IDE / Air 账号，或显式导入已登录 Central CLI 的个人 AI 许可证会话。
Central 的一次性会话导出仅用于用户主动连接，推理不运行 Central / Pi 进程；
工作区、企业和其他尚未核实的身份会明确拒绝，不改用个人账号。
账号连接后获取模型，再在 VS Code 或其他工具的聚合接口中选择实际兼容协议与模型。
使用现有网关地址和本地 Key；账号授权到期后重新连接。
[Central 原生协议说明](https://www.jetbrains.com/help/central-cli/cli-in-depth.html)

## 0.3.62 · TRAE 中国版本机反代

0.3.76 已将早期 Docker / 独立端口方案替换为 TypeScript 网关适配器。
在「授权中心 → TRAE 中国版反代 → 从客户端导入」选择本机已登录的本人账号，
再获取实际模型并测试连接。工具使用现有 ModelDock 网关的 URL、别名和本地 Key；
上游登录资料留在主进程的加密存储中。官方套餐和额度可从授权中心刷新。
旧容器资料不会自动迁入或被删除；重新导入后不再依赖旧服务。

## 0.3.61：JetBrains 插件切换

WebStorm、IntelliJ IDEA、Rider、PyCharm 的接入参数页分别提供「AI Assistant / Air」选择。默认保留 AI Assistant，每个 IDE 独立保存目标插件；供应商、直连 / 聚合模式及模型选择沿用该 IDE 已保存的范围。切换目标只保存选择并取消旧的待同步请求，不立即写入 IDE。

- AI Assistant：继续管理聊天地址、核心 / 轻量模型及独立 AI 补全。设置位置为「工具 → AI Assistant → 提供商与 API 密钥」；来源或模型变更仍按原流程等待 IDE 退出后自动同步，可手动同步和恢复。
- Air：显示「AI → Air → Accounts」的接入步骤，支持复制 URL、Key 和参考模型，以及预览和导出参考参数。请在 Air 的「More Providers → OpenAI」中创建提供商、填写名称与 URL / Key、测试连接并保存，再在会话中选择兼容的 Agent 和模型。
- 本机插件检查确认，Air 原生 Accounts 列表会过滤缺少 PasswordSafe 密钥的配置项。单独写入 `other.xml` 的账户元数据不能得到可编辑的完整账户，因此 ModelDock 不提供 Air 文件同步或恢复，也不写入密码库。Air 账户通过其原生界面创建、编辑和删除。
- Air 和 Assistant 的密钥分别保存。首次接入或切换来源后，请在 Air Accounts 中更新 Key。Air 页面不显示旧 Assistant 的核心 / 轻量模型及 AI 补全分配；ModelDock 的参考模型不会自动为 Agent 完成授权或模型选择。
- ModelDock 不直接修改 Air 账户文件、PasswordSafe 或 Agent 登录状态；参数复制、模型列表或连接测试不代表真实 Agent 推理已通过。

## 0.3.60 接入调整

- 移除 Trae 工具页、自动同步、连接助手和对应的本地接口。已有 Trae 客户端模型、账号和设置不做修改。

## 0.3.59 界面调整

- 工具侧栏分为「常规 Agent」和「JetBrains」两个标签，切换分类不会修改工具接入设置。
- 供应商详情提供 URL、上游模型名称、聚合模型名称和 API Key 复制按钮。API Key 默认隐藏，点击小眼睛显示，再次点击隐藏；订阅使用本地接口 Key 调用。
- 「本地接口与供应商」默认显示本地聚合接口，可复制 URL、Key、全部可用模型或单个模型名称，展开供应商查看模型。供应商加入开关与模型发布选择即时保存，控制通用 `/v1` 入口；各工具 `/tool/<id>` 专用入口仍在对应工具中管理，不改动直连设置。
- 移除 MCP 管理和 Skills 管理界面入口，保留已保存的数据和外部工具配置。

## 供应商与工具

- API 供应商：DeepSeek、火山 Agent Plan、火山 Coding Plan（用户所说的 Token 编程套餐）、千问 Token Plan，以及自定义 API。预设填入对应地址，密钥仍需用户配置。
- 订阅供应商：Codex 和 Grok Build，以本人账号完成设备码授权，由本机管理续期。
- 授权等待框点击外侧保持打开，验证码和等待状态保留；关闭按钮、取消登录或 Escape 可结束本次登录。验证码、API 入口和配置内容通过 Electron 主进程复制，写入成功后才提示，不依赖浏览器剪贴板权限。
- 桌面网络：授权、额度、模型目录和推理请求使用 Electron 系统网络栈，遵循现有系统代理和网络设置；请求不继承浏览器 Cookie。不会自动跟随携带凭据的上游重定向。
- 授权生命周期对照 CC Switch 的设备码实现：xAI 校验 OIDC issuer，续期显式携带原权限 scope；ID Token 只保存在主进程加密凭据中，界面取得账号元数据。临时续期网络失败保留原授权状态；明确拒绝或过期停止轮询。导入凭据前取消旧登录、刷新和额度查询，提交刷新前检查原凭据，防止晚回复覆盖新授权。
- 模型：填写 API Key 后从供应商获取真实模型列表，搜索、勾选并批量添加。不同供应商可用相同模型简称及显示名称，列表和工具中按「套餐名 - 模型名」展示；系统维护唯一的聚合接口 ID。支持真实上游 ID、协议、上下文、工具、视觉与思考强度能力。默认来源未授权、模型列表为空，能力由实际配置确定。
- Codex 兼容模型目录带独立的 `client_version` 和对应版本请求头，使用原生 `slug` 作为上游 ID，解析显示名称、上下文和明确的能力字段。默认候选隐藏 `hide / none` 条目，已保存和手动添加的模型保留；目录可见性不代表实际模型权限。API / Grok 来源不携带 Codex 目录版本参数。
- 工具：Codex、Claude Code、Junie CLI / IDE ACP、OpenCode、DSH、VS Code Copilot Chat、Copilot app、独立 Copilot CLI，以及 WebStorm、IntelliJ IDEA、Rider、PyCharm 的 AI Assistant / Air。Codex、Claude Code、Junie、Copilot CLI 与四个 JetBrains IDE 每次只配置一个入口：供应商直连只选择一家支持原生协议的 API，使用供应商地址、API Key 和真实模型 ID；使用聚合接口只连接一个 ModelDock 本机地址，来源与模型多选均在聚合接口内部配置，模型映射列表在右侧独立滚动。直连与聚合的选择分别保存，往返切换保留原聚合模型范围。订阅及不兼容的直连来源只能在兼容的聚合入口内使用，不会暗中退回单家本机协议桥。已有工具支持还原官方配置，Junie、Copilot CLI 和 JetBrains 可恢复同步前设置；工具交互触发自动同步并先备份，应用启动不会写外部客户端配置。OpenCode、DSH、VS Code 和 Copilot app 保留原有多入口与连接方式。
- 本地网关：固定监听 `127.0.0.1`，默认 `18181`；本地 Key 鉴权、标准模型目录、Chat Completions/Responses、流式转发、请求日志。
- SQLite：保存来源、模型、绑定与日志；敏感凭据由主进程加密，预览和快照不包含上游密钥。
- 配置接入：工具支持预览 / 导出，并按各自能力在用户修改勾选或模型偏好后自动同步，写入前备份。VS Code 默认只保留所选自定义供应商，可关闭此选项来保留原有自定义来源；其他 vendor 与 JSONC 注释保留。OpenCode 保留其他供应商、MCP 和非受管 JSONC 注释；Codex 的 TOML 重写保留配置字段，但不保证原注释。Copilot app 通过运行实例的原生接口同步来源、模型和凭据，预览是同步计划参考，不需要再手工导入；Copilot CLI 使用独立的官方来源注册表和设置文件。DSH 写入 home 插件覆盖与凭据 refs，同步前保存加密恢复记录，清空后恢复原覆盖。
- 托盘：关闭主窗口可留在后台运行；退出应用会停止网关。

## JetBrains AI Assistant 模型接入

WebStorm、IntelliJ IDEA、Rider、PyCharm 使用同一套 AI Assistant 设置格式，当前文件同步适配已核实的 2026.2 / build 262 profile。供应商直连只使用一家原生 Chat API，写入供应商 URL、真实模型 ID，并在 IDE 填写该供应商 API Key。官方 DeepSeek、火山及已确认千问入口可复用现有 Responses 模型条目进行原生 Chat 调用，不会更改全局模型协议或影响 Codex。仅支持 Responses 的未知自定义服务不能假设支持原生 Chat，应通过兼容的聚合入口使用。聚合模式只配置 `/tool/<工具 ID>/v1` 一个本机入口，使用固定本机 Key，供应商与映射模型在聚合接口内部管理。轮换 OAuth 凭据留在 ModelDock。

Windows 使用已安装 IDE 的 `product-info.json`、缓存中的 `.home` 指针和公开进程身份确认当前配置目录；旧 2026.1 与当前 2026.2 共存不会仅因目录数量而阻断同步，也不会根据更新时间猜测目标。残留或复用的 `.pid`、Toolbox 后台服务及普通构建 Java 进程不会当成运行中的 IDE。进程身份、权限或自定义路径无法确认时保持禁止写入，并明确显示「需确认 IDE 配置」，只有真实 IDE 进程运行才显示等待退出。点击「检查 IDE 状态」会立即尝试已有待办；写入前重新确认状态，旧档案和密码存储保持不变。

1. 在工具页选择供应商直连，使用单个供应商下拉和模型选项；或开启「使用聚合接口」，进入聚合接口内部配置，选择内部来源和精确映射模型。用户变更后在确认 IDE 已退出且 profile 兼容时自动备份同步；运行或状态未知时保留最新待办，每 15 秒检查。启动、导航不写文件。直连与聚合草稿独立保存，聚合全部停用保持精确空映射，切换不会重新启用未勾选模型。
2. 退出 IDE 后会自动同步本次交互的最新待办，也可点击接入参数顶部的「同步 IDE 设置」重新应用，可一次写入 聊天 URL、HTTP/1.1、核心 / 轻量模型，以及独立 AI 补全的地址、模型和提示架构，同步前自动备份。「准备本机连接」只启动 ModelDock 本地服务。无法同步时，在 IDE 的「设置 → 工具 → AI Assistant → 提供商与 API 密钥」选择「兼容 OpenAI」，复制页面参数手工填写；工具调用与上下文建议须以套餐实际能力和限制为准。
3. API Key 首次接入时需在每个 IDE 中手工粘贴一次；切换连接方式或来源后请更新密钥。ModelDock 不读取或写入 JetBrains PasswordSafe。点击 IDE 的「测试连接」后，再发送实际聊天 / 工具请求确认推理可用；模型目录返回成功不能代替推理验证。
4. 同步只处理已发现的配置 profile，备份后更新 AI Assistant 地址、HTTP 版本、工具调用及核心 / 轻量模型字段，保留其他设置。IDE 运行中、运行状态未知或未找到兼容 profile 时不写文件，待办期间继续检查，也可手工填写接入参数。同步写入失败时停止自动重试并显示原因，处理后可手动重新同步。关闭 ModelDock 会丢弃尚未应用的待办；下次打开保留本机选择，但不会自动重放写入。重新打开 IDE 后确认 API Key；「设置文件已同步」不表示登录或真实账号调用已通过。
5. 「还原同步前设置」同样要求 IDE 退出，恢复本次受管字段；IDE 凭据存储中的 Key 请在 IDE 内自行确认或更换。「导出参考参数」生成手工填写用 JSON，不能直接导入 IDE。

JetBrains 聚合接口支持将 Responses 的推理文本和工具调用转换为 Chat SSE，包括火山的 `reasoning_text` / `reasoning_raw_text`。0.3.76 起所有客户端都即时接收增量；JetBrains 只保留少量终态尾帧，校验完整结束后再发送成功标志。32 MiB 上限用流式计数实现，不再缓存整段。首块前的失败返回 HTTP 错误，首块后的失败会中断流且不发送成功终态；旧 Koog 客户端可能仍把中断显示为完成，真实 IDE 行为需单独验收。

Responses 的 `*.added` 开始事件允许仅包含类型、尚无文本；方舟的 `response.reasoning_summary_part.added` 会使用这种结构。开始事件按空内容初始化，后续增量和最终文本仍严格验证，避免把合法的流式开始错误转换为 502。完成事件缺失、错误帧、截断和超限仍拒绝；此兼容并不放宽终止判定。参考 [方舟流式输出](https://docs.volcengine.com/docs/ark/streaming-output?lang=zh)。

Koog 会将显示用的 `assistant.reasoning_content` 回传下一轮。Responses 转换仅保留回答与工具历史，省略这个显示字段，不将它伪造为原生推理项或指令；原生 Chat 来源保留该字段。此转换不承诺完整保留推理历史。

配置流程参考 JetBrains 官方 [自定义模型](https://www.jetbrains.com/help/ai-assistant/use-custom-models.html)及[提供商与 API 密钥设置](https://www.jetbrains.com/help/ai-assistant/settings-reference-providers-and-api-keys.html)。

此接入管理 AI Assistant 聊天、核心 / 轻量模型与独立 AI 补全参数。Junie、Claude Agent、Codex、Gemini CLI 及各自独立的账号 / 模型配置仍由 IDE 管理。ModelDock 本次不导入或部署 JetBrains MCP / Skills，也不读取 IDE 聊天记录；本机网关保留请求状态与耗时日志。协议转换、配置文件和隔离 Electron 验证，与真实 IDE 界面和上游账号调用分别记录。

### 独立 AI 补全

AI 补全使用独立的 `NextEditProviderSettings` 配置和独立 Key，不与聊天提供商共用设置槽。每次同步会更新补全地址、模型、明确的 `(fim) Generic` 提示架构，并清除指向旧聊天模型的关联。直连 DeepSeek Flash / Pro 使用 `https://api.deepseek.com/beta`；聚合补全使用同一个本机工具入口的 `/completions`，只路由已映射且确认支持原生补全的模型。两种模式分别记住补全模型，默认跟随聊天模型，也可在软件中选择当前范围内的兼容补全模型。

聊天映射数量与 AI 补全候选数量分别显示。即使聚合了 14 个聊天模型，下拉框仍只列已确认支持原生 FIM 的模型及「跟随聊天默认模型」；当前两个 DeepSeek 候选对应三项，不代表聊天映射丢失。跟随的模型若尚未确认 FIM，补全保持停用，并禁用补全密钥复制，避免把 Chat/Responses 能力推断为 FIM。参考 [JetBrains 自定义模型说明](https://www.jetbrains.com/help/ai-assistant/use-custom-models.html)及 [DeepSeek FIM 接口](https://api-docs.deepseek.com/api/create-completion/)。

切换其他供应商也会更新补全地址和模型；尚未确认补全协议的来源会明确提示，并保持补全停用，不保留上一家的地址，也不把聊天接口伪装成文本补全接口。目前自动确认的原生补全为官方 DeepSeek `deepseek-flash` / `deepseek-v4-pro`。

补全 Key 使用固定独立凭据槽。为避免换地址后自动携带上一家的 Key，地址、供应商账号或连接方式改变时，同步新参数并设为合法停用状态。重新打开 IDE 后，在 AI 补全区选择「兼容 OpenAI」、粘贴此模式对应的 Key，再启用。只改模型且已确认的补全地址/账号一致时，可保留启用状态。ModelDock 不读取或写入 PasswordSafe，也不伪造 Key 已确认标记。

保留现有补全上下文与其他参数，只有超过原生接口已确认限制的输出预算才降到 `4096`；原生设置中的预算以字符串保存。聊天及补全四文件统一备份和回滚，兼容升级前只有三文件的恢复记录。`(fim) Generic` 当前客户端使用前缀补全，不发送后缀；这里不宣称已验证完整 FIM 或下一处编辑预测。真实编辑器补全与供应商调用需另行确认。

## 授权、MCP 和 Skills

授权中心使用紧凑行布局：平台标题、账号身份、横向额度条和重置时间集中显示，账号详情、重新授权、注销与删除放入「…」菜单。空账号组使用简短提示；重置到期明细以浮层展开，不再撑高整张卡片。保留所有账号操作及键盘菜单控制。

账号左侧显示 32px 圆形头像。GitHub 使用账号接口返回的 `avatar_url`，既有账号在刷新额度时补取缺失头像，无需再次登录；ChatGPT / xAI 只使用现有授权资料提供的头像字段。头像缺失或加载失败时显示姓名、邮箱或来源名称的首字母，授权状态点保持独立。图片匿名加载，不发送登录凭据或页面来源，只允许已知公共头像地址；头像获取失败不影响账号授权和额度结果。

深色主题采用黑灰背景、蓝色强调，覆盖侧栏、卡片、菜单、设置、表单和弹窗。品牌图标统一为深灰白色 M 与蓝色连接标记；窗口、托盘、网页图标和 Windows EXE 使用同一套素材。`npm run build` 会生成七档 ICO 与 PNG / SVG；打包保留 Windows 图标资源编辑并关闭签名。

导航和常用操作采用 [Google Material Symbols Rounded](https://fonts.google.com/icons?icon.style=Rounded)：聚合节点、MCP 服务、Skills 书籍、授权钥匙、供应商模型及服务监控使用统一的圆角线条。图标使用本地 SVG 路径和主题颜色，离线可用，无需加载 Google 字体；各工具的品牌图标与 ModelDock 应用标记保留。素材来自 [Google 官方图标仓库](https://github.com/google/material-design-icons)，选取记录与 Apache 2.0 许可随源码及 Windows 包提供。

WebStorm、IntelliJ IDEA、Rider 和 PyCharm 使用 [JetBrains 官方品牌页](https://www.jetbrains.com/company/brand/)的彩色 SVG，与 Toolbox 的 WS / IJ / RD / PC 标识一致。侧栏与详情页共用同一份本地资源，等比例显示；亮暗主题均保留官方配色，不通过单色遮罩重绘。图标归属和来源哈希记录在工具图标 manifest / notice 中，不属于 ModelDock 原创 MIT 图标。

授权中心按 GitHub Copilot、ChatGPT / OpenAI、xAI / Grok 分组展示账号。已授权账号进入页面后自动查询额度，并显示剩余百分比、上游提供的实际单位、重置倒计时、查询时间和旧结果状态。列表每 5 秒只读取本机缓存；额度缓存默认 5 分钟，已知重置时间到达后可提前查询，失败按 5 / 10 / 20 / 30 分钟延后，也可手动刷新。

ChatGPT 的重置次数独立于主要额度查询，过滤已使用、重复和过期的记录；可展开查看全部到期时间。明细暂不可用时，若上游额度响应提供了明确次数，仍显示该次数并标注到期明细未知。Grok 和 Copilot 未提供手动重置次数时明确说明，未知额度不会显示成零或百分之百。

GitHub Copilot 新增 GitHub 设备码登录，使用固定官方授权与额度地址，凭据保存在主进程的加密管理状态中。支持账号实际返回的 AI Credits 或旧版高级请求额度，以及不限量额度；该登录用于 ModelDock 授权中心查询，不会修改 Copilot 桌面或 VS Code 的登录。已知授权到期时需重新登录；不声称自动续期。这里仅展示额度和重置次数，不消耗次数执行额度重置。

GitHub 账号身份查询使用公共 REST 请求头，Copilot 额度查询使用单独的接口版本和编辑器请求头，避免混用。设备码轮询兼容 HTTP 200 / 400 的 `authorization_pending` 与 `slow_down`，按官方间隔继续等待；明确拒绝、过期、HTML 和未知错误会停止。已拿到令牌后读取账号失败时，界面显示「读取 GitHub 账号信息」，身份校验和加密保存成功才显示登录完成。处理规则依据 [GitHub 设备码协议](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) 和 [公共 REST API 版本说明](https://docs.github.com/en/rest/about-the-rest-api/api-versions)。

协议对照 [CC Switch v4.0.0 Copilot](https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/proxy/providers/copilot_auth.rs)、[v4.0.0 ChatGPT](https://github.com/farion1231/cc-switch/blob/v4.0.0/src-tauri/src/services/subscription.rs) 和 [v4.0.3 Grok](https://github.com/farion1231/cc-switch/blob/v4.0.3/src-tauri/src/services/subscription_grok.rs)。xAI 未使用账号的已知 protobuf 缺省零值形状保留兼容解析，界面标注“按协议默认值解析”；缺少明确上下文或结构改变时仍显示未知。Copilot 当前/旧版额度类型依据 [GitHub 官方说明](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage) 与实际响应，额度读取不代表每个模型的推理权限。

左下功能区提供 MCP、Skills、授权中心及服务日志入口。工具与供应商列表共享剩余高度并分别滚动；窗口缩小时两组列表都可独立滚动，标题保持可见，底部功能入口和工作空间信息保持固定。

- **授权中心**：统一管理现有 Codex / Grok Build 订阅来源，一个来源对应一个账号。可新增、登录、重新授权、注销 ModelDock 本地授权、删除来源，或明确点击从本机客户端的 `auth.json` 只读导入。额度查询复用续期机制，只向对应官方域名发送凭据；未查询或格式不支持显示未知，网络失败时注明上次成功结果。访问凭据到期不代表套餐到期。GitHub Copilot 目前仍是接入工具，尚未新增为 ModelDock 的订阅来源。
- **MCP 管理**：全局目录支持 stdio、HTTP、SSE；勾选仅保存工具选择。先预览，再明确应用到工具，保留无关设置并备份原文件。Codex 支持 stdio / Streamable HTTP，SSE 会明确拒绝；OpenCode 使用 remote 协商；VS Code 与 Copilot CLI 使用各自用户配置。DSH 暂无已核实的统一 MCP 文件入口，只导出片段。Claude Code MCP 导入、预览和应用暂不支持，须在 Claude Code 中独立配置，不会复用其他客户端文件。目录、预览和导出隐藏环境变量、Headers、敏感参数及 URL 查询凭据；应用由主进程取出真实值。已被用户修改的受管项及非受管同名项会提示冲突，不会覆盖或删除。删除目录记录后，须再次预览 / 应用才清理客户端中未改过的受管项。
- **Skills 管理**：支持导入本地目录、GitHub 仓库或已有工具技能，查看技能文件，并按工具部署或停用。导入只复制到管理库，勾选才实际部署；使用文件清单和哈希保护用户修改，保留备份，不执行技能脚本。Codex 使用仍兼容的 `CODEX_HOME/skills`，Claude Code 使用 `CLAUDE_CONFIG_DIR/skills`（默认 `~/.claude/skills`），OpenCode 使用全局 `skills`，DSH 对应官方文件系统技能插件。VS Code 与 Copilot 共享 `~/.copilot/skills`，两列同步。现有外部同名技能只读导入后不会自动接管；内容完全一致时，可点击「接管」并确认，仅登记管理关系。不同内容、用户修改、链接或额外 Git 元数据会拒绝接管。更新仓库技能前需显式管理原库项，尚无自动更新。
MCP / Skills 的真实客户端加载、真实账号授权及额度查询仍需在对应工具和账号验证。配置写入成功不等于服务已经连接。

这些管理功能参考 [CC Switch 的 MCP 统一目录](https://github.com/farion1231/cc-switch/blob/d455dd85720a4e48a59d02396539b480d9767902/src-tauri/src/services/mcp.rs)、[Skills 管理库](https://github.com/farion1231/cc-switch/blob/d455dd85720a4e48a59d02396539b480d9767902/src-tauri/src/services/skill.rs) 与账号授权设计，使用独立 TypeScript 实现。参考仓库为 MIT 许可，源码仅放在被 Git 忽略的 `work/references/`，不随应用打包。各工具目录依据官方文档和源码，说明链接可从 Skills 页面查看。

这是按个人需求实现的初版，不是 CLIProxyAPI 的完整移植。项目源码无需 Go 或 Rust，不修改已有 CPA 安装。

## 设置

「设置」位于左下角「本地工作空间」旁的齿轮按钮，原本地信息和数据目录按钮保留。

默认主窗口为 1080×720 DIP，可手动调整或最大化；最小尺寸保持 980×680，工具和供应商列表独立滚动。

- 主题可选浅色、深色、跟随系统，覆盖全部页面、弹窗和表单；立即生效并保存在本机 SQLite。跟随系统会响应明暗变化，主窗口等前端读取主题后才显示。
- 窗口支持静默启动和关闭时留在托盘。静默启动下可通过托盘、再次启动程序或系统激活显示窗口；关闭托盘选项后，关闭窗口会退出并停止网关。
- 打包版支持登录系统后自动启动。Windows 使用系统启动项并报告实际启用状态；Linux 使用与应用启动器一致的 `model-dock.desktop`，升级时只迁移属于 ModelDock 且未被修改的旧启动项，保留外部修改。开发版不登记系统启动项。AppImage / Windows 便携程序使用稳定的外层可执行路径。
- Linux 在应用初始化前按用户和配置目录取得系统进程间守卫，防止登录自启动、会话恢复或连续点击创建两个主实例；再次启动只请求显示已有窗口。守卫仅传递固定的显示窗口信号，不传递命令行、配置或凭据，进程退出后由系统释放。
- 首页「服务工作台」和设置页可开启「随应用启动本地服务」，下次手动启动或登录自启时使用保存的端口自动监听 `127.0.0.1`。默认关闭；启动服务或开启此项会保存端口，手动停止服务不取消下次自动启动。端口被占用时保留应用并在服务页显示错误，不修改已有工具配置。
- 服务错误与请求错误分开展示。401 等失败请求显示为带时间和 HTTP 状态的「最近一次请求错误」；后续成功会标明「此后已有请求成功」，保留该条历史记录供排查，不将其视为服务故障。重新启动本地服务会清除本次服务的请求状态。
- 「应用网络代理」支持本机 HTTP、HTTPS 或 SOCKS5 地址。显式设置后，账号授权、模型目录和网关上游请求优先使用这个代理。留空时，工作台已连接的 HTTP 代理会承接这些新请求，全局模式或正常断开后则跟随系统。若 HTTP 转发意外中断，应用会暂时阻止新请求进入失效端口，回到工作台恢复网络后可重试。智能 / PAC 模式未代理 `auth.x.ai` 时，可填写代理软件提供的本机地址再登录。准备登录阶段立即显示进度并可取消，迟到的申请或轮询结果不会重新打开已关闭的窗口。
- 网络区的「检测连接」使用当前应用会话访问 Grok 的公开授权配置，显示实际解析路线、HTTP 状态、白名单网络错误码和耗时，不登录账号或读取凭据。代理地址未保存时先保存；同值再次保存也会重新应用配置。授权失败窗口也会显示可识别的网络错误码。

自动检查覆盖设置保存、主题切换、系统颜色响应和窗口渲染。本地服务自动启动另通过四次 Windows Electron 进程启动检查，验证端口持久化、原生监听归属、关闭配置和端口占用时的错误显示；实际 Windows 登录或电脑重启、Linux 原生托盘尚未实测。验证脚本隔离数据库、浏览器缓存及启动项适配器，不修改本机真实自启设置。


### Linux 工具路径与 Copilot 依赖

- OpenCode 配置同步、还原、MCP 和 Skills 统一使用有效的绝对 `XDG_CONFIG_HOME/opencode`；用量导入和显示使用 `XDG_DATA_HOME/opencode`，未设置时遵循默认用户目录。测试资料目录保持隔离，不继承真实桌面 XDG 路径。
- DSH 配置解析优先核对 PATH 中真实 `dsh` 的 npm 包，支持 `NVM_BIN`、`NVM_DIR` 和桌面 PATH 缺少 nvm 时的有限版本目录搜索；识别安装时不执行 shell 初始化脚本。
- Linux Copilot “仅保留所选供应商”需要系统 `/usr/bin/python3` 与 `python3-secretstorage`。deb 已声明依赖；AppImage 用户需自行安装该系统依赖。凭据只在主进程通过固定子进程的 stdin/stdout 处理，不进入命令参数、界面或普通日志。
- Copilot 私有目录 `~/.copilot(0700)` 内的 `run(0775)` 被正确接受；不允许外层可替换目录、链接、其他用户属主或公开的 token 文件。

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

## 单来源与聚合接口

十个工具页均提供「使用聚合接口」复选框。不同工具分别保存连接方式、来源与模型范围，开启后不会自动加入其他供应商或扩大已有的精确模型列表。

| 选项与来源 | 接入方式 |
| --- | --- |
| 关闭「使用聚合接口」 | 一次选择一家来源，勾选另一家会替换当前来源。API 优先使用客户端兼容的原生地址、Key 和真实模型 ID；订阅及需要协议转换的 API 经本机入口管理。 |
| 开启「使用聚合接口」 | 选择多家来源，并逐个勾选允许使用的模型。客户端使用一个 `http://127.0.0.1:<端口>/tool/<工具 ID>/v1` 入口、固定本机 Key 和唯一模型别名；未启用模型不开放。Claude Code 的基地址不含 `/v1`，客户端调用其 `/v1/messages`。 |
| Codex 聚合模型 | 仅提供 Responses 模型。 |
| Claude Code 聚合模型 | 提供 Messages 入口，复用所选 API / 订阅的已有模型；原生 Messages 来源按对应鉴权转发，Chat / Responses 来源通过协议桥调用。 |
| JetBrains 单来源 | 所选单 API 模型均使用 Chat Completions 时直连上游；Responses 或账号订阅使用仅包含该来源的本机入口。切换后会在确认 IDE 退出时自动更新 URL 和模型；Key 仍需在 IDE 手工更新。 |

关闭聚合时保留默认模型所在供应商；没有对应来源时保留首个已选来源。开启聚合时保留已有来源、默认模型及精确模型范围。聚合模型列表明确保存，新增模型不会自动加入已有选择。全部停用保持空列表，网关拒绝调用未启用模型，显式同步会清理对应客户端入口；JetBrains 全部停用只保存空绑定并取消自动同步待办，不自动清理 IDE 文件。

API 原生直连不依赖本地网关。预览隐藏 API Key；前六种工具在用户修改来源、默认模型或聚合选项后自动保存并同步，已有配置先备份。JetBrains 在用户更改来源、模式或默认模型后也会尝试自动同步；IDE 运行时只保存最新待办，确认退出后再应用，保留手动同步与还原。API Key 仍需在 IDE 手工更新。订阅访问及刷新令牌始终留在主进程，由本机入口续期；使用本机入口期间须保持 ModelDock 运行，自动同步会按需启动网关。

旧绑定加载时保留原直连 / 聚合 / 自动连接及部分模型范围，不会在启动或切换导航时同步客户端。旧的多供应商直连绑定保留来源与模型范围，并迁移为等价的自动连接元数据（`mode: "auto"`），外部配置保持原样，界面显示沿用已有连接；修改默认模型或来源不会自动迁移连接方式。明确切换聚合选项后采用新的单来源或聚合方式。DSH 同时写入模型与对应凭据；Copilot app 通过自身原生接口更新，不由 ModelDock 直接改写其数据库。

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

先启动 GitHub Copilot 桌面应用，再在 ModelDock 勾选来源或改变「ModelDock 首选模型」，会自动同步供应商与模型，无需退出或重启 Copilot。关闭聚合时只使用一家来源，API 直连上游并使用对应 API Key 和真实模型 ID；开启聚合时所有来源注册为一个本机供应商分组，使用本地连接密钥和模型别名。订阅授权经本机入口管理，OAuth 凭据留在 ModelDock。不同来源可注册相同模型 ID，每条模型独立配置 Chat Completions / Responses；稳定 UUID 用于识别本资料目录下的托管项。

Copilot 默认开启「仅保留所选供应商」，同步会先备份，再清理未选中的自定义来源，包括此前手工添加的套餐；全部清空会清理所有自定义来源。关闭这个选项则只更新 ModelDock 托管项，保留其他自定义来源。GitHub 内置模型、账号和 MCP 不删除；聊天正文保留，被删除来源与旧会话的关联可能由 Copilot 解除。首选模型是 ModelDock 的配置偏好，不主动切换已打开聊天；同步后请在 Copilot app 的模型选择器中选择。

连接使用当前 Copilot 资料目录（默认 `~/.copilot`，可由 `COPILOT_HOME` 指定）内的运行实例信息，只访问本机原生接口。ModelDock 不直接编辑 `data.db`，也不复制整个数据库或对话记录。Windows 清理旧来源前只按其明确 UUID 备份两个 Copilot 供应商凭据目标的原始字节，不解码、展示或枚举其他应用与账号凭据；备份立即加密保存。Linux 1.1.27 使用 Secret Service 精确备份两个 BYOK 项的原始字节、属性、标签、内容类型和集合，恢复时保留原先不存在的目标；备份由 ModelDock 加密保存。锁定的钥匙串、重复匹配或缺少系统 python3-secretstorage 时拒绝清理；恢复时发现凭据已移到其他集合会在写入前停止并保留恢复记录，错误给出具体原因。其他未适配平台仍拒绝清理。`modeldock-copilot-desktop.json` 预览 / 导出仅供检查同步计划。

每次写入前将原配置、凭据备份和恢复计划加密保存到 ModelDock 的管理记录与私有备份。部分写入失败会尝试恢复；恢复未完成时保留待恢复记录，下次同步先恢复再执行新计划。无法安全备份时先拒绝修改。同步串行发送写入，不盲目重试写请求；读取遇到原生凭据工作队列繁忙时有限退避，减少重复的全供应商凭据查询。Copilot 未运行时选择仍保存，打开应用后可重新同步。

聚合及旧版多来源连接的工具页提供「全选可用」，所有工具均有「清空选择」，覆盖搜索结果之外的来源，批量操作只保存并同步一次。未授权、停用或没有兼容模型的来源不加入全选。每张供应商卡片均提供删除入口：删除会影响全局供应商及模型，并同步关联的自动接入工具；失败会恢复本地记录并尝试修复工具配置。删除前保存加密备份，已有数据库历史记录保留。

## 自动同步与撤销

非 JetBrains 工具的来源、连接方式、默认模型和范围修改立即保存到 ModelDock，停止操作 400 毫秒后才合并写入外部配置并备份；连续点选只同步最后一次选择。各工具的待办独立保存，实际写入按主进程锁串行执行。切换页面不创建新的同步请求，应用启动不重放上次待办；同步失败后保留选择，等待新的用户操作或点击「重新同步」。

「重新同步」立即处理当前待办，不再追加延后的第二次写入。「撤销上次同步」取消尚未写入的新选择，恢复上次成功同步前的配置、管理记录和工具选择；原文件或凭据被外部修改时拒绝覆盖。每个工具仅保留最新一份撤销记录，内容在主进程加密保存，不传给界面。重复同步未变化的配置不会覆盖上一份有效记录。Copilot 通过原生接口恢复供应商注册表及精确备份的系统凭据；JetBrains 保留原有退出 IDE 后同步和同步前还原流程。

本版移除本地用量统计、Token 采集、价格估算和客户端历史导入，也不再提供全局模型目录页。模型在供应商详情中添加、获取和编辑；聚合映射与工具选择继续使用现有模型。旧数据库中的历史统计表不删除，也不再追加记录。账号授权中心的供应商额度信息及 API 响应本身的 usage 字段保留。

## 使用流程

界面按工具、供应商、功能三个区域组织：左侧上方选择十款工具，中间第一项是「聚合供应商」，其下是全局来源；下方进入 MCP、Skills、授权中心和服务日志。模型在各供应商详情中管理，不再提供全局模型目录页面。右侧直接显示所选对象的配置与模型，供应商使用紧凑列表。切换导航不会修改已有工具绑定。

1. 在左侧「模型供应商」标题下点击「添加 API」或「添加订阅」，填写地址和密钥，或点击 GPT/Grok 来源的登录按钮。API 密钥留空表示保留原凭据。保存来源不强制读取模型列表；供应商未提供目录接口时，可直接手动添加模型再测试连接。
2. 已有来源可在供应商详情点击「获取模型列表」，搜索并勾选模型，按需修改简称及显示名称，再批量加入该供应商。已添加的模型保持原接口 ID 并自动跳过；简称仅需在当前供应商内区分，跨供应商可重复。上游不提供模型目录时会显示具体错误，可改用「手动添加」。获取成功仅表示目录可读，模型是否可用须实际请求确认。
3. 在左侧选择工具，先选择是否「使用聚合接口」，在供应商行左侧勾选需要的来源，聚合时按需启用模型，并在顶部选择模型偏好（VS Code / Copilot app 显示为「ModelDock 首选模型」）。VS Code、OpenCode、Codex 和已运行的 Copilot app 会自动同步，状态显示「本次选择已同步」；取消勾选也会更新配置。VS Code 和 Copilot app 默认开启「仅保留所选供应商」，会先备份再清理未选中的历史自定义来源；如需保留，请关闭此项。同步失败时选择仍保存，可处理后点击「重新同步」。
4. 已有绑定可先点击「重新同步」应用现有选择，也可随时预览。修改来源地址、Key 或模型参数后，请再次同步；使用文件配置的工具可能需要重新加载。VS Code 默认写入 `Code/User/chatLanguageModels.json`，其他 profile 需要手工合并。Copilot app 使用正在运行的实例，不需要 JSON 导入。DSH 的原生热更新启用时会自动读取修改；未启用时重启 DSH。默认模型用于新会话，已有会话需切换模型或新建。
5. 在工具中选择模型并发出请求。VS Code / Copilot app 同步后还需在自己的模型选择器选择模型；ModelDock 的首选模型不会切换已打开聊天的当前模型。经过本地入口的请求可在服务日志查看状态、耗时和实际来源；API 直连请求不经过网关。

只有一个连接分组时，配置预览可复制对应连接密钥：API 直连复制来源 Key，本地托管复制本地 Key。多个独立 API 分组没有共用密钥，应按导出的分组分别配置；DSH 自动同步各组的本地凭据引用，不复制订阅 OAuth 令牌。DSH 预览 / 导出只含原生插件覆盖，密钥由一键应用另写凭据文件。

供应商卡片的「测试连接」与「获取模型列表」独立：点击测试图标直接使用当前供应商模型列表中的第一条模型（包括未启用的模型）发送一次短请求，不弹出选择框。默认模型显示在卡片右侧，状态、HTTP 和耗时在卡片内更新；删除第一条后自动使用下一条。没有模型时提示先添加，并禁用测试按钮。不会访问 `/models` 或自动新增模型，不提供目录的套餐仍可先手动添加模型再测试。订阅复用本机授权与续期，测试不改变来源或模型的启用状态。厂商只返回思考内容或短测试达到输出预算时，按实际推理证据确认连接，并区分完整回答与短测试截断；HTTP 200、空响应和任意用量 JSON 均不单独证明成功。测试仅说明此次所用模型的调用结果，不代表其他模型权限；需要少量上游调用用量。30 秒超时与响应大小限制会明确提示，达到短测试输出上限时不会假称已完成完整回答。生成正文及凭据不会展示或记录在测试结果中。

「添加订阅」支持 Codex、GitHub Copilot 和 Grok Build。Copilot 可选择授权中心已登录的 GitHub 账号，或保存后在官方 GitHub 页面完成设备授权。来源只保存账号引用，GitHub 长时凭据留在本机加密账户存储；推理时兑换短时 Copilot 凭据并在内存中续期。模型按官方目录实际声明选择 Chat Completions 或 Responses，本地网关提供对应接口，工具只获得本地连接密钥。移除账号会清除关联来源的授权引用，来源和模型配置保留。此功能独立于向 Copilot app 同步自定义供应商的工具接入功能。

例如火山 Agent Plan、火山 Coding Plan 都可添加 `glm-5.3`，显示为「火山 Agent Plan - glm-5.3」与「火山 Coding Plan - glm-5.3」。发生跨来源重名时，系统自动使用稳定的来源 ID 区分聚合路由，不要求手动改模型名；预览或导出的客户端配置使用正确的接口 ID。API 直连仍发送真实上游 ID。已有接口 ID 不会因为其他来源被添加、删除或改名而改变；无需迁移或重写旧模型及凭据。

模型列表可能只返回 ID。接口未提供有效的上下文长度或图片输入能力时，ModelDock 按准确的上游 ID 查询内置模型字典，逐项补全并显示补全字段、官方规格链接及核对日期；接口明确声明的值（包括不支持图片）优先。字典集中维护在 `src/shared/model-metadata.ts`，只收录已核对的型号及明确别名，不根据相似名称猜测未知模型能力。可展开单个模型的「参数设置」修正，也可使用高级设置批量修改或添加后编辑；手动设置为 0 或关闭图片输入均会保存，重新获取列表不会覆盖已保存的设置。字典也未覆盖的上下文保持「未设置」（数据库值为 0）。

上游声明的思考强度档位（如 `supported_reasoning_levels`）会随目录读入，可在模型编辑中勾选支持档位和默认档位，同步到 VS Code、Codex 目录、Copilot 桌面与 DSH；不勾选则 VS Code 不显示 Thinking Effort 选择器。未知工具能力的新增模型默认允许客户端尝试工具调用，不代表供应商已保证支持。导出 DSH、OpenCode、VS Code 配置时，未知上下文使用本地 32K / 4K 输出预算；Codex 则省略可选的上下文字段。这些是客户端配置预算，不是上游规格。字典中的官方规格也可能高于转接服务或套餐限制，请以实际服务文档为准并在界面调整。

API 来源按名称、类型和规范化地址防重复：添加预设时复用已有空记录，同一密钥重复保存返回原来源，双击提交也不会追加记录。若使用另一把 Key，请编辑已有记录或为不同账号设置不同名称；路径不同的套餐入口仍分别保留。

旧版本已有同名同地址记录时，「聚合供应商」会出现「整理重复供应商」。页面会比较本机凭据并展示模型数量；仅相同密钥或空预设可合并。启用状态、预设不一致，或凭据无法读取时会给出原因。合并需先停止本地服务，操作前自动备份数据库，保留所有模型 ID、别名、已有数据库历史记录和默认模型。只选择部分重复来源的工具会保持原模型范围；原本选择完整来源的工具继续自动包含新模型。整理不会自动运行，也不会删除同一上游模型的不同别名，以免破坏已有工具配置。

统一地址为 `http://127.0.0.1:18181/v1`。工具专用入口例如 `http://127.0.0.1:18181/tool/dsh/v1`，只发布该工具绑定的模型。聚合和订阅使用本地 Key；API 直连分组使用对应来源的 Key。

预设地址：DeepSeek `https://api.deepseek.com`；火山 Agent Plan `https://ark.cn-beijing.volces.com/api/plan/v3`；千问 Token Plan 默认中国站 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，国际站须按控制台调整。

火山 Coding Plan 的地址应为 `https://ark.cn-beijing.volces.com/api/coding/v3`；普通方舟 API 的 `/api/v3` 是另一个计费入口。使用对应套餐/用途和凭据。

## 接入边界

- ModelDock 独立于 OpenAI、GitHub、xAI 和各工具厂商。兼容接入使用现有公开客户端标识和已观察到的授权/额度/本机接口，不是 ModelDock 自注册的官方 OAuth 应用，也不代表官方背书。公开客户端 ID 不是秘密；不要删除它们来代替协议审查。提供账号访问、模型目录或额度数据不等于服务承诺稳定私有接口或授予每个模型的推理权限。使用这些服务仍须满足上游账号、权限和服务条款。
- GPT 登录目前是兼容 Codex 公开客户端的设备码流程，不是为 ModelDock 动态注册的新 SIWC 应用。授权、实际账号额度和模型权限需用户登录后验证。
- 授权错误按申请设备码、等待授权、兑换凭据和续期步骤显示安全诊断，区分地区限制、设备码未启用、明确拒绝、过期和网络超时。Codex 专属设备授权轮询中的 JSON 403 / 404、`deviceauth_authorization_pending` 均可表示尚未输入验证码，会保持等待、保留验证码和复制按钮，并提供官方授权页面链接；这些状态不表示已完成授权。HTML 拦截、明确拒绝及过期会停止轮询。已有有效账号再次登录失败时保留原授权。设备码的账号 / 工作空间权限条件及本机授权缓存方法参见 [OpenAI 官方授权说明](https://learn.chatgpt.com/docs/auth)；登录失败页可前往授权中心显式导入已登录客户端，导入按钮才读取本机授权文件。
- 原生上游按来源与模型已有的 Chat Completions / Responses 协议调用；现有其他工具会过滤 Messages 模型。四个 JetBrains IDE 的 Chat Completions 入口可转换到 Responses 来源；原生 Chat 模型保持原协议。Claude Code 可通过本机服务把 Messages 转换为来源已有协议，或连接官方 Anthropic 兼容入口；无需复制现有模型。跨协议转换的测试与真实供应商验收分别记录。
- 经过本机入口调用已核对的 Grok 4.7 系列时，通用最大思考强度 `max` 转换为 Grok 原生 `xhigh`，覆盖 Claude Messages、JetBrains Chat → Responses 和其他工具的 Responses 请求。其他已有效档位保持原样；未知型号、自定义转接服务及其他供应商不做此转换。规则依据 [Grok 推理强度说明](https://docs.x.ai/developers/model-capabilities/text/reasoning)，不修改模型设置、账号凭据或工具的独立选择。
- 订阅路径使用 `store:false`，需要发送完整会话历史；不能依赖 `previous_response_id` 或服务端持久化对话。原生 WebSocket 续接尚未实现。千问 Token Plan 的 Responses 支持也需按具体模型选择，不能以套餐名称一概认定。
- 火山 Agent/Coding Plan 的 `minimax-m3` 在 Claude 聚合模式下，若模型保存为 Responses 且没有自定义 Claude 接口覆盖，使用原有 Responses 地址完成工具调用，避免官方 Messages 兼容入口的 `messages.tool_calls.type` 参数错误。规则只匹配已知官方套餐地址与精确模型，直连继续使用供应商 Messages 地址。同步聚合配置时关闭 Claude 原生 thinking 协议字段，`effort` 仍传给上游推理配置；切回直连恢复原用户值。旧聊天含原生签名思考或服务端工具历史时提示新建聊天，保留原会话，不删除或过滤历史。上游明确参数错误按 `invalid_request_error` 返回，不再把参数拒绝误报成服务器故障。已通过现有 Claude SDK 的真实 Coding Plan 两轮无害工具往返；编辑器界面与长任务尚未重新验收。
- Claude Code 终端接入写入 `CLAUDE_CONFIG_DIR/settings.json`（默认 `~/.claude/settings.json`），关闭聚合时一次使用一个现有 API 或账号订阅来源，开启聚合时将多家已选模型发布到一个本机 Messages 入口。官方 API 单来源直连的 Claude 兼容入口使用同一 API Key；ChatGPT/Codex、GitHub Copilot、Grok Build 订阅通过 ModelDock 本机 Messages 服务调用其已有上游协议，OAuth 访问和刷新令牌留在主进程，客户端配置只使用本机 Key。需要本机入口时同步会按需启动服务；使用期间须保持 ModelDock 运行。
- API 表单的「Claude Code 接口地址」留空时按已知官方地址映射，未识别的 OpenAI 兼容来源可通过本机服务转换；填写时须是支持 Anthropic Messages 的服务地址。此字段不替换已有 OpenAI 地址。Messages 鉴权可选择 `API Key（x-api-key）` 或 `Bearer Token（Authorization）`；Anthropic 新模板默认 API Key，自定义及未设置此字段的历史来源默认 Bearer，仅影响原生 Messages 接口。
- Claude Code 原生直连的默认模型及 Haiku / Sonnet / Opus / 子代理角色使用所选默认模型的真实上游 ID；通过本机服务时使用 ModelDock 模型别名。直连与聚合都同步 `availableModels` 和 `modelPicker`：直连发布所选供应商去重后的真实模型 ID，聚合发布已启用的模型别名；模型选择器需要 Claude Code v2.1.242 或更高版本，旧版可使用 `/model <模型 ID>` 或 `--model`。两种模式共用备份与字段恢复记录，取消来源会恢复未被用户后续修改的原列表。已有无关设置保留，预览脱敏，应用前备份；应用或还原后重启 Claude Code 终端。源码与界面使用原创字母 C 标识，不使用 Claude 官方品牌图形。
- **VS Code 内置 Claude 代理**与 Claude Code CLI 共用用户 `settings.json`，与 Anthropic 官方 Claude Code 扩展是不同入口。Windows/Linux 均使用 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）；配置路径不会沿用另一台电脑的 home。VS Code 本机代理主机会缓存启动时的凭据与模型，ModelDock 写入外部文件后，新建聊天或重新打开窗口未必刷新缓存。同步或还原后，在 VS Code 按 `Ctrl+Shift+P`，运行 **Developer: Restart Local Agent Host**，再打开 Claude 会话。Anthropic 官方扩展仍需按其 `claudeCode.environmentVariables` 设置配置。配置同步、SDK 模型发现和真实推理分别验证，不能把文件已写入视为编辑器会话已验收。参考 [VS Code 代理接入说明](https://code.visualstudio.com/docs/agents/run/agent-harnesses)、[Claude 自定义模型配置](https://code.claude.com/docs/en/model-config#add-a-custom-model-option)。
- Claude Code 本机入口为 `http://127.0.0.1:18181/tool/claude-code`，客户端调用其 `/v1/messages`（端口随 ModelDock 服务设置）。桥接支持文本、图片、工具调用、工具结果及流式响应；Messages 的 `thinking` 输入当前不支持，客户端配置省略/关闭该协议功能，不代表上游模型不会自行思考。复杂视觉及模型特有扩展须另行验证。转换路径以 mock 上游核对为准，不代表真实 ChatGPT/Copilot/Grok 账号或供应商已经验收。
- 官方 API Claude 入口：DeepSeek `https://api.deepseek.com/anthropic`；火山 Agent Plan `https://ark.cn-beijing.volces.com/api/plan`；火山 Coding Plan `https://ark.cn-beijing.volces.com/api/coding`；国内千问 Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`，国际 Token Plan 为 `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`。千问 Coding Plan 国内/国际分别为 `https://coding.dashscope.aliyuncs.com/apps/anthropic` / `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic`。只匹配已知预设与完整官方地址，不会凭名称改写用户自定义来源；API Key 必须与对应地域及计费入口配套。阿里云 Anthropic 入口不提供 `/v1/models`，可复用现有模型或手工添加，目录 404 不代表推理失败。参考 [阿里云国内接入表](https://help.aliyun.com/zh/model-studio/more-tools)、[阿里云国际接入表](https://www.alibabacloud.com/help/en/model-studio/more-tools)、[Claude Code 配置](https://help.aliyun.com/zh/model-studio/claude-code)。
- Claude Code 默认开启「关闭遥测和非必要联网」，保存并同步后关闭遥测、错误报告及自动更新，模型请求继续使用所选 API 或订阅来源。WebFetch 仍可能进行安全检查；这不是本地文件或网络隔离，也不控制 MCP、插件和 hook 的网络行为。关闭自动更新后需用户自行更新 Claude Code。参考 [官方数据使用说明](https://code.claude.com/docs/en/data-usage)、[设置说明](https://code.claude.com/docs/en/settings)；配置序列化与模拟请求通过不代表真实供应商或客户端隐私行为已验收。
- Codex 的导出与目录只发布 Responses 模型。生成的目录含客户端要求的基本字段，但复杂工具、推理档位、视觉行为仍需逐模型验证。
- DSH 应用目标是 `DSH_HOME`（未设置时 `~/.dsh`）的 `cordis.patch.yml` 与 `.credentials.yaml`，适配已验证的 CLI 0.1.7-rc.2 / Desktop 0.2.0-rc.2 原生插件格式。默认开启「仅显示所选供应商」：发布所选 pi-ai 路由，停用原生 DeepSeek API / 账号模型适配器及其他已识别模型来源；保留独立平台账号授权服务、凭据和会话。全部取消仍保持模型来源为空；关闭此选项才恢复原模型适配器的启用标记，原配置来源可与 ModelDock 来源共存。不同接口拆分路由，默认模型用于新会话。同步前通过隐藏的只读进程解析实际 profile / 运行时，识别嵌套及改名适配器；解析不完整或缺少标准核心插件时明确拒绝写入。原 profile 文件不改写；两文件先加密备份，失败恢复，外部并发修改冲突时保留恢复记录并拒绝覆盖。配置写入不主动切换已有会话。
- DSH 旧 DeepSeek 会话仍可能引用 `deepseek-official` / `deepseek-account`。独占模式选择官方 DeepSeek API 来源时，ModelDock 会安装无凭据的受管同模型兼容插件，让这些旧引用调用所选来源中的同一上游模型；聊天日志、模型选择及原请求对象不改写。相似显示名、其他套餐、不同模型或无法确定的重复来源不自动映射。兼容路由没有可配置目录和模型枚举，模型设置页与新会话选择器仍只展示所选来源。插件源、配置及凭据一同纳入加密备份与失败恢复；关闭独占或清空选择会撤销插件，静态无凭据代码文件留在本地作为非活动文件。未包含旧模型时，请在 DSH 切换模型或新建会话。
- Copilot app 接入使用桌面应用的本机原生供应商接口，按 1.1.26 的协议实现，不把 CLI `providers.json` 或 SDK 会话参数当成桌面配置。预览只是原生同步计划参考，需要应用运行才能同步；版本接口变化会明确报错。Windows 隔离原生实例已核对。Linux 原生连接支持系统管理员安装的 /usr/bin/github：校验 root 文件和目录、UID、进程启动时间、执行文件身份及回环监听 socket，信任来源是本机系统安装，不是 GitHub 厂商签名；用户可写 AppImage 暂不支持。OpenCode 使用各模型的 npm SDK 配置选择 Chat/Responses 协议，保存时合并 JSON/JSONC。
- VS Code 接入目标是 Copilot Chat 的 Custom Endpoint，默认写入用户配置 `Code/User/chatLanguageModels.json`。默认范围会替换该文件中的全部 `customendpoint` 分组；关闭「仅保留所选供应商」后只更新 ModelDock 分组。应用不会自动识别其他 profile；使用其他 profile 时请预览 / 导出后手工合并到对应位置。同步只是注册模型来源，实际聊天模型须在 VS Code 选择器中选择；此接入不能据此宣称所有编辑器 AI 功能都被替换。
- 模型列表、上下文和工具/视觉声明不会授予上游权限；错误会明确返回，日志不记录请求正文与密钥。

### 适配与导入维护记录

| 接入 | 当前兼容目标 / 参考 | 验证范围 |
| --- | --- | --- |
| Codex 设备码、额度和目录 | 公开客户端兼容流程；目录 `client_version` 为 `0.159.0`；授权协议、CC Switch v4.0.0 / 固定参考提交见源码 | 模拟授权、续期、取消和目录解析；账号授权与各模型推理分别验收 |
| Grok / xAI | 公开 OIDC 设备码与已观察到的 Build 额度协议；客户端兼容版本 `1.0.44`；CC Switch v4.0.3 | issuer / scope 校验及额度解析 fixture；缺少明确结构时显示未知 |
| GitHub Copilot 账号 | GitHub 公开设备码、公共 `/user` 身份查询及已观察到的 Copilot 额度接口 | pending / slow_down、取消、身份校验和额度 fixture；不是 ModelDock 自注册应用 |
| Copilot app 配置 | 原生本机供应商接口：Windows `1.1.26` / Linux `1.1.27` | Windows 保留产品、GitHub 签名及端口验证；Linux 验证 root 管理的 `/usr/bin/github`、当前用户进程和真实回环 socket，使用 Secret Service 精确备份恢复 BYOK 凭据；不把 Linux 系统安装信任称为厂商签名 |
| DSH 配置 | CLI `0.1.7-rc.2` / Desktop `0.2.0-rc.2` 插件及凭据格式 | 原生 profile 解析、备份及只读/写入回归；未知布局拒绝覆盖 |

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

Linux 正式入口启动、Wayland 可见窗口及隔离模拟上游验证已通过；真实账号授权/云端推理仍需单独验收。具体范围与验证结果见 `VALIDATION.md`。


### 诊断日志

在首页「服务工作台」选择「请求与日志」查看诊断日志，可按信息／警告／错误筛选、搜索，查看单条元数据，并复制筛选结果、导出 JSONL 或打开日志目录。应用启动、授权阶段、模型测试、模型发现、网关启停与请求、配置同步、MCP／Skills 操作和运行错误会自动记录；正常授权等待按状态变化记录，不逐次刷屏。诊断查询自身不会生成更多日志。

日志保存在本地资料目录的 `logs/diagnostics.jsonl`，每次启动带独立会话 ID，同一次操作带关联 ID。重启后历史仍可查看；每份日志最多 2 MiB，包含当前文件共保留 5 份，最多约 10 MiB。复制和导出仅包含当前筛选的最近记录；需要更长历史时可打开日志目录查看轮转文件。

只保存固定事件和诊断元数据：状态码、耗时、网络错误码、协议、响应状态和计数等。不保存 API Key、OAuth Token、设备验证码、请求头、提示词、回答、上游错误正文或原始异常文本。地址参数与未知路径会移除。日志故障不会中断模型服务，日志面板会提示资料目录权限或磁盘问题。


## 网络 · FlowBridge

0.4.1 默认打开「服务工作台」。在同一页上，「本地模型服务」配置端口、复制接口和密钥、启停模型网关，「网络接管」配置代理地址、连接 HTTP 或全局 TCP/UDP/DNS、查询热点地址及恢复系统网络。点击左上角的 ModelDock 可从供应商、工具或设置页返回。

在工作台连接 HTTP 代理后，未单独指定应用代理的模型请求会经该连接访问上游。工作台下方的「接口与模型」管理发布范围，「网络工具」查看流量、检测网站或导出手机脚本，「请求与日志」查看请求和诊断记录。设置页管理自动连接、小窗启动和 Windows 解析方式。托盘支持断开网络，退出时先恢复系统网络，清理失败保留应用供重试。

默认不连接、不改系统代理。先填写 `http://手机IP:38473` 或全局模式的 `socks5://手机IP:38473` 并保存，再点击连接。已连接时切换模式会先恢复原会话，再启动新会话。全局模式要求标准 SOCKS5 UDP ASSOCIATE 及真实 DNS 往返，普通 HTTP 代理不具有任意 UDP 能力。Linux 全局上游必须是远端数值 IP；Windows 可使用经过防循环身份检查的本机 SOCKS5。网关回环端口不能作为网络上游。

从 0.4.1 起，Linux 的 ModelDock deb 同时安装桌面应用、全局网络服务和 sing-box。在下载目录执行以下命令，即可安装或升级 amd64 版本：

```sh
sudo apt install ./model-dock_0.4.1_amd64.deb
```

打开 ModelDock，在首页的“网络接管”中选择连接模式。首次连接全局模式时，系统会请求管理员授权，为当前用户启用网络服务。从 0.4.0 双包版升级的用户可能需要重新授权一次。单独运行 AppImage 可使用 HTTP 模式，需要全局模式时请使用 deb 版。

Windows x64 包附带 CPython、sing-box 和官方签名 Wintun；全局模式要求以管理员身份运行，普通用户可用 HTTP 模式。原 ModelDock 登录启动不会自动取得管理员权限，因此 Windows 登录后的全局自动连接仍需目标系统原生验收。

“导出手机脚本”仅保存 Termux 安装器，手机端由用户执行；不连接或控制手机。原 ModelDock 数据目录、账号、模型、绑定、MCP、Skills 和历史表不迁移、不清空。独立 FlowBridge 的旧数据与自启动不自动接管，使用整合版前应退出旧版的网络会话。

构建和验证：

```sh
npm ci
npm run build
npm test
npm run test:network
npm run verify:production
npm run network:verify
npm run dist:linux
# Windows x64 原生构建：npm run pack:win
# Linux 云端的独立 Electron QA（需要已授权的显示）：
CI=true MODELDOCK_SMOKE_NETWORK_ONLY=1 node scripts/smoke-electron.mjs work/network-qa --no-build --ci-no-sandbox --x11
npm run source:archive
```

[整合与许可证说明、验收边界](docs/flowbridge-integration.md)。全局不覆盖 ICMP、独立网络空间、第三方 VPN 等全部场景；系统路径与代理出口检测必须分别解读。小窗是独立悬浮窗，不是 Explorer 内嵌任务栏工具栏。
