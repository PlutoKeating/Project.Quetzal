# MCP 工具来源与 TUI 客户端接入计划

状态：2026-10-14 的分阶段设计。stdio MCP 与本机 TUI 第一切片已实施，实际范围以 [MCP 实现](MCP.md)、[CLI 文档](../../cli/docs/README.md) 和 [整合验证](FOLLOWUP.md) 为准。本文的 HTTP、动态来源刷新、完整结构化结果留存、远程 TUI 等仍属于待实施设计，不能据本文宣称已支持。

## 1. 已确认的边界

- `engine/` 承载通用模型—工具循环，通过宿主提供的 ports 取得模型、工具、轮次控制、记录与上下文；不反向 import `runtime/`，不读取全局配置、SQLite、灵魂或设备适配器。
- MCP 是 agent 的**工具来源**。MCP client 位于 host 一侧，连接提供工具的 server；不把 App、TUI、飞书通道转换成 MCP server。
- App 与 TUI 通过运行时网关使用同一份 agent、会话、权限、记忆与执行状态。通道接入运行时的会话入口，再由 runtime 调用 engine。客户端不自行创建第二份 engine 或模型循环。
- `runtime/src/mind/tools.ts` 当前的 `allTools()` / `callTool()` 是宿主工具装配与执行边界；`guard/guard.ts` 承担审批、急停与审计，`gateway.ts` / `ops.ts` 承担客户端控制。现有行为详见 [接口现状](INTERFACES.md)。

本文的通用 ToolSource port 与完整结构化结果留存仍为**后续提案**。首期已使用宿主 stdio 来源，通过稳定别名与现有 `ToolResult` 文本投影接入；没有统一改写所有工具来源，也没有改变网关协议。

## 2. 官方版本核对

官方 [Versioning](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning) 将 **2026-07-28** 标为当前协议；[规范](https://modelcontextprotocol.io/specification/2026-07-28) 的核心采用无状态、每请求版本与能力声明。旧版 `2025-11-25` 及以前使用 `initialize` 握手与连接会话，不能将旧握手流程写成所有版本的唯一实现。

[官方 TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md) 将 v2 标为稳定版本，客户端包为 `@modelcontextprotocol/client`；v1 的 `@modelcontextprotocol/sdk` 属于兼容维护版本。此次只读查询 npm 官方 registry 时，客户端 latest 为 `2.3.1`、Node 要求 `>=20`；该结果是调研快照，实际实施前须重新核对、锁定版本与依赖树，不使用浮动 latest。

关键实现约束来自 [SDK 协议版本指南](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html) 与 [连接指南](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)：v2 `Client` 的默认模式仍采用 legacy 握手；要探测现代与旧服务，应显式选择 `versionNegotiation: { mode: 'auto' }`。`connect()`、`listTools()`、`callTool()` 的底层差异交由 SDK 处理，engine 不判断协议日期或手写 JSON-RPC 握手。连接状态应保留实际协议版本及 server capabilities，不能因 SDK 版本较新就报告所有服务支持现代协议。

官方资料：

| 主题 | 一手来源 |
|---|---|
| 传输与兼容 | [Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)、[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) |
| 工具、schema、结果与错误 | [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[SDK 调用指南](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html) |
| 取消与绝对超时 | [Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation) |
| HTTP 授权与凭据 | [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) |
| 测试连接 | [SDK Testing](https://ts.sdk.modelcontextprotocol.io/v2/testing.html) |

## 3. 工具来源契约提案

不将 SDK 类型泄露到通用循环。未来增加一种宿主工具来源，其契约至少包含：

| 操作 / 数据 | 契约 |
|---|---|
| `ToolSource.id` | 部署者配置的稳定来源 ID，不使用 server 自报名称作为唯一标识 |
| `list({signal})` | 返回工具名称、描述、输入 schema、可选输出 schema及来源修订；发现有页数、数量、字节与时间上限 |
| `call({tool, arguments, signal, onProgress})` | 以原始工具名调用来源；接收调用级 AbortSignal；返回有来源标识的结构化结果 |
| `close()` | 幂等释放来源连接、监听器与自有子进程；未完成调用收到明确的关闭错误 |
| `ToolOutcome` | 区分成功、工具执行失败、协议 / 连接失败及本地拒绝；保留文本、多模态内容、`structuredContent` 和错误信息 |
| `ToolBinding` | 将模型可见名称映射到固定的来源 ID、原始工具名及定义修订，禁止拼字符串推测来源 |

调用链：`engine → 宿主 execute → 来源政策与 guard → MCP source.call → 校验 / 脱敏 / 输出预算 → 审计与工具记录 → engine`。来源实现本身不跳过宿主政策。第一版可将结构化结果转换为现有 `{text, status: ok|error|denied}`，详细结果由宿主另存；这只是兼容投影，不宣称现有模型协议已经支持全部 MCP 内容。

名称使用 `mcp_<配置ID>_<原始名>` 的受控别名；若长度或字符不兼容模型供应商，则使用可重复计算的短别名及映射表。冲突必须在注册阶段发现并拒绝，不能靠 `allTools().find()` 的排列顺序选中某个同名工具。别名不能覆盖 `finish`、内置工具、自造工具或其他来源。保留原始名称大小写，别名映射应跨重连稳定。

工具发现先完整校验再原子替换注册快照；同一轮仍使用它开始时的绑定。下轮刷新工具定义，与当前循环的工具快照习惯一致。工具消失或 schema 改变后不以旧批准直接执行新定义，返回明确的过时定义错误。支持 list-changed / modern subscriptions 时刷新，未支持时以有界 TTL 或显式刷新处理，不能只安装旧版通知监听就声称覆盖现代协议。

## 4. 权限、凭据与执行边界

### 4.1 默认权限

当前 `guard.level()` 对未知类别默认 allow。MCP 不直接继承这一默认值：注册时必须具备显式的 server / tool 策略，**缺省 ask**，可由部署者配置 allow / deny；叠加其他必要能力时取最严格档位。`readOnlyHint`、`destructiveHint`、`idempotentHint` 是服务自报信息，不作为自动授权或自动重试的依据。

启动 stdio server 已经执行了代码，因此“允许连接 / 启动”的策略与“允许调用工具”分开。连接不是无副作用的 tools/list 前置动作。部署者配置启用 server 后，按其明确的启动政策连接；agent 不能靠返回内容改变 command、args、endpoint 或权限。审批展示来源、工具与脱敏参数，复用现有审批事件，不另建一套绕过控制台的闸门。

### 4.2 stdio

首个连接切片优先 stdio：容易用本机合成 fixture 验证，也不需要先实现 OAuth。后续接 Streamable HTTP；HTTP 的旧 SSE fallback 仅在明确需要兼容时增加，不能在任何连接失败后盲目降级。

启动采用 command 与 args 数组，默认不经 shell，不把模型输出拼接成命令，也不隐式 `npx` 下载执行。启动器、工作目录、环境白名单与隔离策略由 runtime 提供；如果使用 SDK 的内置 spawn，须在适配层构造经过批准的沙箱启动命令。现有 `sh.run()` 的 stdin 为 ignore，不能原样当成 stdio MCP 双向传输。

只传递运行所需环境与该来源明确授权的凭据；不复制整个 `process.env`。凭据按来源引用，由宿主解析后注入，不进入模型 schema、灵魂仓库或控制台状态。默认不开放基座 secrets、vault、私有灵魂及未授权工作区给第三方进程。若 server 需要额外访问路径，由部署者显式配置，不能把工具声明 roots 当成操作系统隔离。

协议 stdout 只接收 MCP 消息；stderr 限量、脱敏记录，禁止透传到 TUI。进程死亡使其工具不可用；关闭按期限退出再强制清理自有进程树。SDK 关闭直接子进程不等于保证所有平台上的孙进程被清理，宿主需独立验证。

### 4.3 HTTP

Streamable HTTP 使用官方 SDK，支持 JSON 与请求级 SSE 响应。凭据只发送到配置的目标 server，不复用网关 token、模型 Key 或其他 server 的 token，不放 URI query；跨来源重定向不得携带 Authorization。默认公网 HTTPS，显式配置的本地 / 私网 server 是独立允许范围，不能直接套用仅允许公网的 `web_fetch` 政策，也不能因此开放任意模型提供的 URL。

初期仅覆盖未鉴权或部署者配置的凭据引用，不声称完成 OAuth 互操作。要求登录或扩大 scope 时，返回需要授权的状态，由客户端处理；OAuth metadata、PKCE、resource/audience、issuer 核对和 token 刷新作为单独切片实现。

## 5. 取消、生命周期与失败

- 将当前轮次 `TurnControl.signal` 传到宿主执行闭包，再传给 MCP 调用；只结束 engine 等待并不代表远端工作已取消。
- 现代 stdio 取消发送 `notifications/cancelled`；现代 HTTP 取消关闭**本请求**的响应流。legacy 差异由 SDK 处理。不因取消一个调用而关闭同源共享连接、影响别的会话。
- 调用设置无进展超时与总时长上限；progress 可续无进展计时，但不能突破总上限。取消后忽略迟到响应，不再写成成功结果。取消不保证撤销已经产生的外部副作用。
- 来源连接可复用，但每次调用、审批、取消信号与数据上下文独立。连接失败时移除来源的可用工具，记录真实状态，有限退避重连。
- 可以重试发现或连接；默认不重放未知是否完成的 tools/call。网络恢复不等于允许重复发送消息、付款或文件修改。
- `isError: true` 映射工具失败；JSON-RPC 错误、schema 不符、超时与断连保留不同原因；本地政策拒绝映射 denied。服务返还一段错误文字而未标记失败，不自动猜成成功任务。
- 第一版不宣告 sampling、elicitation、roots 或 Tasks 能力。现代 `input_required` 或未支持的返回类型必须明确报未支持，不能当空成功结果；后续用户交互请求接客户端审批 / 输入流程，绝不自动把凭据交给 server。

## 6. 输出与上下文

保留 MCP `content` 数组、`structuredContent` 与输出 schema；JSON 结果可包含任意 JSON 值，不能强制都当对象。验证结果后生成带来源的模型文本投影，避免把 text 与同内容 JSON 重复注入。远端 instructions、描述和结果属于工具资料，不升级为人格、系统红线或授权指令。

文本、图片、音频、内嵌资源分别设大小及上下文预算。第一连接切片可以只支持文本与结构化 JSON，但遇到其他类型要给明确说明，并保留受限的原始结果或附件引用；不默默丢弃后报告全类型支持。资源链接只展示或按独立授权读取，不自动下载任意 URI，也不把远端 `file://` 当成宿主文件路径。

结果在进入模型、记录、审计与事件前脱敏；原始详细结果若保留也使用脱敏版本并设置保留上限。TUI 渲染另清理远端 ANSI/OSC 控制序列，防止工具正文触发终端控制行为。

## 7. TUI 第一阶段契约

TUI 是网关客户端，建议作为 `cli/` 的显式 `chat` / `tui` 入口，不 import engine 或 runtime 的执行模块。首期可用 Node 内置 readline 完成聊天、状态、审批与停止；全屏布局作为后续界面切片，不先引入终端 UI 框架。

| 职责 | 使用现有契约 |
|---|---|
| 连接与认证 | `/rpc` 第一条消息 `{auth}`；本机令牌沿原生客户端方式读取并核验，或按配对流程取得；不打印令牌、不使用 query token |
| 聊天与插话 | `chat.send`：指定 conv、客户端 turn 与 steer / queue / interrupt；客户端不运行第二份模型循环 |
| 流式与工具过程 | `activity` 的 delta、text、tool、done / error；区分长期 conv 与执行 turn |
| 停止 | `chat.stop`；关闭 TUI 只关闭客户端，不能默认停止后台 agent |
| 审批 | `approvals` / `decide` 与 approval 事件；保留来源身体和审批 ID |
| 断线恢复 | 重连后取 `sessions.live`、会话及 messages，再接增量事件；恢复期间缓冲推送并避免重复渲染 |
| 保密输入 | 依据 secret 状态切换不回显输入；不写本机历史，不自动打印 secret 事件内的口令或敏感元信息 |

现网关的 `turn` 只用于过程关联，源码未提供按 turn 幂等去重。因此断线后**不自动重发 chat.send**，先查历史与进行中状态；客户端不能假设原消息没被接收。当前事件没有全局顺序游标，恢复视图需以快照及历史为准；跨设备并发与准确事件重放属于后续契约改进，不在首期承诺。

第一版可限定回环连接。若开放远端 TUI，须实现 HTTPS/WSS 配对与证书指纹核对，不能使用关闭 TLS 验证的快捷方案。CLI 读取网关令牌是新增的聊天客户端职责，需要同步更新现有“CLI 不经手令牌”的文档约定，但运维输出仍不得包含令牌。

## 8. 实施顺序、依赖与验收

1. **本轮：**提取 engine loop 与 types，验证原 runtime 行为；MCP/TUI 仅维护本计划。不给 engine 引入网关、设备、私有记忆或协议 SDK依赖。
2. **工具来源切片：**以假来源实现 list/call/close、稳定名称映射、显式权限与取消传递；旧内置工具通过宿主现有 execute 继续工作，不一次改写整个工具系统。
3. **stdio 切片：**重新核对官方 SDK 和锁文件后引入客户端依赖。优先官方 v2 分包，避免为了客户端功能引入 v1 的服务端框架依赖；锁定依赖，确认 Node、CJS打包、安卓与 Windows 子进程兼容性及许可证。使用 auto 协商，保留实际协议证据。
4. **TUI 切片：**在客户端实现聊天、审批、停止、恢复与无回显保密输入；runtime 和 engine 不因此复制状态或承担终端渲染。
5. **HTTP 切片：**Streamable HTTP、目标范围与凭据引用；OAuth、多模态结果、subscriptions、resources/prompts 按明确需要继续扩展。每项验证完成再更新已实现能力表。

首次真实 MCP 接入前，使用 SDK 的 InMemoryTransport 或注入假传输测试；生产连接实现后，再增加仓库内合成 stdio fixture和本机 HTTP fixture，不依赖真实账户、公网 server 或私有数据。建议验收：

- modern / legacy 协商均可发现并调用工具，报告实际版本；无共同版本明确失败。
- 两个 server 同名工具、超长 / 非法名及内置保留名不会误路由；多页发现有界。
- ask 之前不调用工具；deny / STOP 拦截；stdio 启动也受独立政策控制；annotations 不能放宽政策。
- 各种失败、结构化结果不符、未支持内容与 input_required 正确分类；脱敏覆盖结果、stderr、审批与异常信息。
- 一个会话取消不影响同源另一个调用；超时有总上限；迟到结果不入成功记录；重连不重放副作用调用。
- stdio 启动无 shell 注入、不继承无关秘密；关闭清理进程；HTTP 跨来源不转发凭据。
- TUI 使用同一 runtime 的历史与实时轮次；断线不重复发消息；审批、停止、终端转义与无回显输入有合成测试。

完成合成测试不等于真实服务、OAuth或跨平台验收；真实连接、平台运行和发布状态分别记录证据。新增依赖、配置、构建脚本、客户端命令与文档随各自实现切片更新。
