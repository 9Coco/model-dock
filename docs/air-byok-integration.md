# JetBrains Air 原生 BYOK 接入边界

核实日期：2026-11-21。本文记录 ModelDock 的 Air 页面所依赖的原生账户契约，以及已经核实与尚未核实的边界。

## 目标与证据范围

目标是 JetBrains IDE 中 **Air 插件自己的 Settings → AI → Air → Accounts**，不是 AI Assistant 的 Providers & API keys，也不是 Air 托管的 Claude Code、Codex、Copilot CLI、OpenCode 或 Junie 的配置文件。

本机检查到的版本：

| 宿主 | Air 插件版本 | 检查范围 |
| --- | --- | --- |
| Rider 2026.3 | `263.7307.330-windows-x86_64` | 账户、供应商、URL、验证与存储类的实际字节码 |
| IntelliJ IDEA 2026.3 | `263.7307.291-windows-x86_64` | 插件版本及原生 Accounts 界面；本文的详细类实现以 Rider 版本为准 |

插件模块目录是 `%APPDATA%\JetBrains\<IDE版本>\plugins\air-plugin\lib\modules`。证据来自该目录的已安装 JAR，使用 `javap -p -c` 与 `javap -p -v` 只读检查；没有读取、导出或改写用户密钥。

官方说明确认：可在 Accounts 中通过 More Providers 添加 Anthropic、OpenAI、Gemini、OpenRouter，填写凭据并测试连接，保存后在支持相应 API 的 Agent 会话中选择账户。一个供应商账户并不代表所有 Agent 都支持该协议。

- [Air in IDEs：Configure agent authorization](https://www.jetbrains.com/help/air/air-in-ides-authorization.html)
- [Air in IDEs settings](https://www.jetbrains.com/help/air/air-in-ides-settings.html)

## ModelDock 提供的参数

ModelDock 准备一个原生 **OpenAI** 或 **Anthropic** 账户的参数，由用户在 Air 的对应原生对话框中保存。

- API 直连：一个待填账户对应一个协议兼容的 API 供应商，使用原生 URL、上游模型 ID 和该供应商的 API Key。用户可以重复此流程，在 Air 中添加多个账户。
- 聚合：一个待填账户使用现有 ModelDock Gateway 的工具作用域地址和本地连接密钥，模型范围由 Air 绑定中的供应商及模型选择决定。上游订阅/OAuth 凭据仍留在 ModelDock 主进程。
- 预览需要隐藏密钥；只有显式复制或导出动作可提供待填 API Key。导出的 JSON 是参数参考，不应称为 Air 可导入的配置文件。
- 保存 ModelDock 绑定与在 Air 中保存账户是两个动作。没有经过 Air 原生保存，不能显示“已同步到 Air”或声称账户已生效。

## 原生字段与协议

| 字段或行为 | OpenAI | Anthropic |
| --- | --- | --- |
| 原生 provider ID | `openai` | `anthropic` |
| 基本账户字段 | 名称、API Key、Base URL、自定义 headers | 名称、API Key、Base URL、自定义 headers |
| 供应商附加字段 | 可选 organization、project | 本次所查版本无对应附加字段 |
| 默认 Base URL | `https://api.openai.com` | `https://api.anthropic.com` |
| 请求认证 | `Authorization: Bearer <key>` | `x-api-key: <key>` |
| 额外原生 header | 按需 `OpenAI-Organization`、`OpenAI-Project` | `anthropic-version: 2023-06-01` |
| 连接测试 | `GET <规范化地址>/models` | `GET <规范化地址>/v1/models` |

相关类：

- `intellij.air.frontend.llm.byok.openai.jar`：`com.intellij.air.frontend.llm.providers.openai.OpenAiByokProvider`、`OpenAiByokConfiguration`。
- `intellij.air.frontend.llm.byok.anthropic.jar`：`com.intellij.air.frontend.llm.providers.anthropic.AnthropicByokProvider`、`AnthropicByokConfiguration`。
- `intellij.air.frontend.llm.byok.api.jar`：`com.intellij.air.frontend.llm.api.AirByokConfigurationData`、`AirByokConfiguration`、`AirByokConnection`、`AirByokUrls`。

两种 provider 的资源字符串都明确包含 Base URL 字段，说明留空时使用默认地址。`OpenAiByokProvider.connection` 和 `AnthropicByokProvider.connection` 分别构造上述认证 headers 与 probe URL。

## Base URL 的路径规则

原生 `AirByokUrls` 先移除地址结尾的 `/`，再检查 URI 路径。不能只按“通常 API 地址带 `/v1`”统一生成参数。

**OpenAI** 使用 `appendPathToRoot(baseUrl, "/v1")`：只有 URI 路径为空时才追加 `/v1`；已有非空路径原样保留。随后连接测试追加 `/models`。

**Anthropic** 使用 `removeExactPath(baseUrl, "/v1")`：只有整个 URI 路径恰好等于 `/v1` 才去掉该路径；它不会剥离任意路径末尾的 `/v1`。随后连接测试追加 `/v1/models`。

| 待填账户 | 应提供的 Base URL | Air 生成的连接测试地址 |
| --- | --- | --- |
| OpenAI 官方 | `https://api.openai.com/v1` | `https://api.openai.com/v1/models` |
| ModelDock OpenAI 聚合 | `http://127.0.0.1:<port>/tool/air/v1` | `http://127.0.0.1:<port>/tool/air/v1/models` |
| Anthropic 官方 | `https://api.anthropic.com` | `https://api.anthropic.com/v1/models` |
| DeepSeek Anthropic 兼容入口 | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/anthropic/v1/models` |
| ModelDock Anthropic 聚合 | `http://127.0.0.1:<port>/tool/air` | `http://127.0.0.1:<port>/tool/air/v1/models` |

例如，给 Anthropic 对话框填写 `/anthropic/v1` 或 `/tool/air/v1` 会保留这个完整路径，并在测试时再次追加 `/v1/models`。ModelDock 应提供协议对应的根地址，避免重复 `/v1`。上表是依据客户端实现推导的 URL，不代表对这些地址完成了实时请求验证。

## 模型选择的边界

通用的 `AirByokConfigurationData`、`StoredAirByok` 和 `AirByokConnection` 都存在 `selectedModels` 字段。但本次所查的 OpenAI / Anthropic 具体 configuration 没有这个字段，也不从 `ConfigurationData.selectedModels` 读取它；它们继承 `AirByokConfiguration.getSelectedModels()` 的默认实现，返回 `null`。

因此，不应将 ModelDock 的模型选择描述为已经写入 Air 原生账户的模型列表或默认模型。聚合模式可以通过工具作用域模型目录限制 Gateway 暴露的模型；直连模式可以列出待使用的上游模型 ID。Agent 最终可用哪些模型以及会话当前选型，仍受 Air、Agent 与供应商支持范围约束。

## 持久化与保存边界

以下类位于 `intellij.air.frontend.llm.jar` 的 `com.intellij.air.frontend.llm.impl.byok` 包：

- `AirByokMetadataStoreImpl` 继承 `SerializablePersistentStateComponent`，`@State` 名称为 `AirByokConfigurations`，`Storage` 为 `other.xml`。
- `StoredAirByok` 包含 `id`、`type`、`name`、`baseUrl`、`organization`、`project`、`region`、`settings`、`headers`、`selectedModels` 等资料；不能把它当作包含完整凭据的账户文件。
- `AirByokSecretStoreImpl` 使用 JetBrains `PasswordSafe`；其写入流程调用 `PasswordSafe.setPassword`，CredentialAttributes 的服务名称由 `generateServiceName("Air BYOK", key)` 生成。
- `AirByokRepositoryImpl.save` 协调账户资料与密钥的保存。它是 IDE 进程内部的服务方法，不是已验证可供外部程序调用的导入 API。

截至本次核实，没有验证到可让 ModelDock 完整保存 Air 账户的受支持外部导入 API、CLI 命令或文件协议。这不等于断言未来或其他版本不存在相关能力。当前可靠方案是准备参数并由 Air 原生 UI 保存，不手工构造不完整 XML 账户，不直接操作 PasswordSafe，不把 Windows Credential Manager 当作可互换的写入接口。

原生保存路径：**Settings → AI → Air → Accounts → More Providers → OpenAI / Anthropic → 填写参数 → Test Connection → OK**。之后在支持相应 API 的 Agent 会话中选择该账户。

## 验证不能混同

`AirByokValidatorImpl` 从 `AirByokConnection.probeUrl` 构造探测请求，`KtorAirByokProbe.execute` 明确使用 HTTP GET。其 `probeConnection` 对 HTTP 200–299 返回 `AirByokReadiness.READY`，不会通过解析模型列表结构来决定该成功分支。后续目录获取是另一条流程：`intellij.air.backend.acp.jar` 中的 `AirProviderCatalogServiceImpl` 使用 ACP `_providers/models` 操作，具体上游模型目录处理仍依赖所选 Agent。

因此原生 Test Connection 成功，只说明该连接测试通过；不能证明 Agent 模型目录、聊天、流式返回、思考内容、工具调用或多轮历史已经正确工作。Gateway 为 Air Anthropic 账户提供模型目录时仍应兼容 Anthropic 的模型条目与分页字段，不能以探测只检查状态码为由省略协议结构。

需分别记录以下证据：

1. ModelDock 参数生成与作用域路由测试。
2. Air 原生账户保存及 GET 连接测试。
3. 实际 Agent 会话中的模型选择与真实推理，包括所需的工具调用和多轮历史。

本文完成的是安装版实现的只读核实，没有创建或修改用户 Air 账户，没有执行认证，也没有完成上述真实推理验收。
