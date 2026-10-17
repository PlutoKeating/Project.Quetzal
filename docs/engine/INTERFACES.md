# 工具、模型协议与交互接口

当前有四种不同接口：模型工具、身体能力、控制网关、身体间 mesh。名称相似不代表协议相同；MCP / TUI 状态见 §5。初始基线见 [BASELINE.md](BASELINE.md)，独立引擎接口见 [DESIGN.md](DESIGN.md)，MCP / TUI 的阶段设计见 [ADAPTERS_PLAN.md](ADAPTERS_PLAN.md)，实际范围见 [MCP](MCP.md) 与 [CLI](../../cli/docs/README.md)。

## 1. 模型协议与路由

[engine 通用类型](../../engine/src/types.ts) 定义消息与工具协议，[runtime types.ts](../../runtime/src/providers/types.ts) 兼容重导出并保留供应商配置类型。通用协议包含 `Msg`、`ToolDef`、`ToolCall`、`ChatRequest` 与 `ChatResult`。消息包含 system / user / assistant / tool，user 可带 base64 图片；工具定义是名称、描述与 JSON Schema；结果包含文字、工具调用、input / output 用量、模型和可选 `truncated`。

[adapters.ts](../../runtime/src/providers/adapters.ts) 实现 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Generative AI 四种 HTTP 协议，负责消息变换、SSE 流与非流式 JSON、工具参数拼接和结果归一化。工具错误另映射为 Anthropic `is_error` / Gemini 错误内容，所有协议仍能看到失败文字标记。

[router.ts](../../runtime/src/providers/router.ts) 按启用模型的全局 sortOrder 顺序调用；quick 模型在内省 / 摘要时优先；每模型最多尝试两把启用 Key 并轮换。400 / 401 / 403 / 404 立即换模型，其他失败先尝试下一 Key；外部取消时不继续故障转移。成功记录 usage，未配置价格时费用按 0 记，不能据此证明调用免费。

[registry.ts](../../runtime/src/providers/registry.ts) 使用配置版本防覆盖，Key 由 AES-256-GCM 加密；[compat/](../../runtime/src/providers/compat/) 处理供应商特例。这里使用原生 HTTP 适配，不通过 MCP 或外部 Agent SDK。

## 2. 工具扩展点

`Tool` 在 [tools.ts](../../runtime/src/mind/tools.ts) 中包含 `permission`、可选 `also`、JSON Schema 与异步 handler；`allTools()` 拼接内置工具、适配器工具、可用 hands、自造工具、在线时的跨身体工具和已连接 MCP 来源工具（名称冲突拒绝）。

| 工具组 | 模型工具名 |
|---|---|
| 记忆 / 身份 | memory_records、memory_evolve、memory、note_save/read/list/move/delete、recall、open_loop、share_thought、rewrite_soul、edit_identity |
| 资料与观察 | web_search、web_fetch、view_image、read_document、recent_actions |
| 命令 / 进程 | shell、shell_jobs、processes、host_mode |
| 消息 / 提醒 / 语音 | send_message、reminder、voice_speak、voice_config、hearing_config、pass_secret |
| 自造工具 | tool_write、tool_read、tool_delete |
| 会话 / 协作 | session_new、session_compact、claim、agent_spawn/status/message/stop |
| 多身体 | body_call、move_to；view_image / read_document / shell 可带 body 借用远端文件 |
| 平台能力 | 由适配器声明；hands 接入后注册 screen_describe、screen_tap、screen_type、app_open |
| MCP | `mcp_<来源ID>_<原始名哈希>` 稳定别名，经宿主来源映射调用；资源与提示词各两个基座加的工具（列出 / 读取、列出 / 取用） |
| 插件 | plugin_search、plugin_recommend、plugin_prompt |
| 循环专用 | finish，由 brain.loop 直接处理，不经过普通 callTool |

hands 的 TypeScript 接口还包含截图和滑动方法，但工具注册不把每一个接口方法自动暴露为同名工具；是否能操作屏幕必须看适配器实际提供的能力。

调用链是 `callTool` → 取多能力类别最严格档位 → guard 检查 / 等审批 → 可选远端文件本地化 → handler → 输出脱敏 → 审计 → finally 触碰灵魂同步。返回 `ToolFailure` 或抛错标 error，闸门拒绝标 denied；只返回一段错误描述仍可被视为 ok。参数与输出在保存 / 广播前替换已知保密值。

工具 Schema 用于传给模型，并非统一服务端 Schema 验证器；不同 handler 自行检查参数。这里没有可任意加载第三方 npm 插件到内核进程的注册协议。

## 3. 自造工具与 Agent Skills

[custom-tools.ts](../../runtime/src/mind/custom-tools.ts) 管理 `QUETZAL_HOME/tools/<name>/tool.json` 和实现文件：sh、node，以及支持时的 ps1。manifest 包含描述、参数 Schema、能力类别、依赖命令、启用状态和无输出超时。写入时检查名字 / 保留名、Schema、源码大小与语法；新工具必须同时提供技能文档。

实现通过沙箱子进程运行，不在核心进程 import 用户写的 node 模块。参数通过 JSON、环境变量等传递；Windows 沙箱使用参数文件。缺命令依赖或被停用时不挂载；工具表下次生成时生效。

意图文档存在灵魂 `skills/<name>/SKILL.md`，列用途、参数、实现思路、依赖与验证方法。它随灵魂同步，其他身体根据文档重新实现本机工具。现实现读取简单的 frontmatter 元信息与正文，不是完整的通用技能执行 / 依赖编排框架，也不会因为同步了文档就自动运行代码。

## 4. 身体接口与执行权限

[BodyAdapter](../../runtime/src/body/adapter.ts) 默认导出一个平台能力对象，核心通过 `body/twin.ts` 加载；提供 `sample`、可选通知 / 播放、tools、hands、守护、升级 / 退出、设备身份与网络变化回调。适配器只 import 核心类型；平台实现位于 `runtime/adapters/`。加载失败可退回通用适配器。

[guard.ts](../../runtime/src/guard/guard.ts) 的能力档位为 allow / ask / deny，多类别采用最严格档位；普通未知类别默认 allow；`mcp` / `mcp_start` 及其来源 / 工具子类别缺省 ask，按工具级 → 来源级 → 类别级继承。相机、麦克风、定位、hands、tool_write 默认 ask，其余已配置类别默认 allow；审批 30 分钟未处理即拒绝。自造工具调用至少还检查 shell，tool_write 检查 self_modify 与 tool_write。

[sandbox.ts](../../runtime/src/sandbox.ts) 对命令提供 Linux bwrap / Landlock / proot、Android proot、Windows sandbox-runtime；缺沙箱默认拒绝执行，部署者可显式允许不隔离。shell 默认允许时其他工具类别不能禁止同等 shell 能力。读文件工具另经真实路径保护，web_fetch 另有公网出站检查。提示红线不能替代操作系统隔离。

[host-mode.ts](../../runtime/src/host-mode.ts) 为一个对话会话提供本机内存态真实环境：模型每次请求都审批，或用户从控制台直接开启；30 分钟无真实环境命令退出、重启清空。只影响该会话 shell，不影响子 agent、自造工具或远端 body_call。真实环境能使用宿主用户权限，不能描述为仍隔离基座密钥。

STOP 文件阻止新循环步骤 / 工具审批，拒绝待处理审批并退出真实环境；不应把它等同于对所有在途模型、设备工具、网络请求与后台子进程的通用即时回滚。对话的 `chat.stop` 是另一种明确取消轮次的入口。

## 5. 交互入口、MCP 与 TUI

| 入口 | 实现 | 当前用途 |
|---|---|---|
| 网关 | [gateway.ts](../../runtime/src/gateway.ts)、[ops.ts](../../runtime/src/ops.ts)、[web.ts](../../runtime/src/web.ts) | 自定义 HTTP / WebSocket RPC、状态 / 对话 / 控制、认证与页面托管 |
| Flutter 控制台 | [api.dart](../../console/lib/api.dart)、[chat.dart](../../console/lib/pages/chat.dart)、[process.dart](../../console/lib/process.dart) | Android / Web / Linux / Windows 共用 API；会话、流式过程、审批、停止与保密输入 |
| 飞书 | [feishu.ts](../../runtime/src/channels/feishu.ts)、feishu-progress / feishu-cards | 消息通道、实时卡片、默认插话；`/new` 切会话，`/sandbox` 退出真实环境 |
| 听觉 | [hearing.ts](../../runtime/src/voice/hearing.ts)、azure / player 与控制台采集 | 识别为 ambient 输入，由模型选择回应 / 沉默，语音合成可调用工具 |
| 运维 CLI | [cli.ts](../../cli/src/cli.ts)、[windows.ts](../../cli/src/windows.ts) | install、open、run、status、logs、start/stop/restart、rollback、uninstall；run 是服务前台运行 |
| 身体间 RPC | [mesh.ts](../../runtime/src/mesh/mesh.ts)、limbs / presence / placement | 认证身体之间的工具调用、文件借用、交接、在场与调度 |
| MCP 客户端 | [mcp/](../../runtime/src/mcp/) | stdio 与远程 Streamable HTTP / SSE、OAuth 2.1、启动授权、tools / resources / prompts 的发现和调用、取消、即时启停、多端同步标记；modern / legacy 兼容；没有自动列表刷新、自动重连与多模态结果 |
| 插件 | [plugins/](../../runtime/src/plugins/)、控制台 [plugins.dart](../../console/lib/pages/plugins.dart) | Claude Code 插件格式与 Agent Skills 目录的预览 / 安装 / 卸载、插件市场 marketplace.json、推荐目录与她的推荐工具 |
| MCP 服务端 | 未实现 | 网关和 mesh 没有提供 MCP 协议端点；`tool.list` 是内部身体协议方法 |
| 交互式 TUI / 终端聊天 | [tui.ts](../../cli/src/tui.ts) | `chat` / `tui` 通过同一回环网关支持会话、流式过程、审批、停止和手动恢复；无远程配对或终端保密值输入 |

状态基于实际生产入口、源码和依赖清单；MCP 与 TUI 的合成验证及未运行的平台 / 真实服务检查见 [后续切片](FOLLOWUP.md)。研究目录或外部框架能力不算 runtime 集成。

## 6. 网关与观测契约

HTTP 提供 `/health`、本机登录、配对、附件上传 / 下载、语音输入与音频下载；`/rpc` WebSocket 先认证，再使用 `{id,method,params}` 请求、`{id,result}` / error 响应和 `{event,data}` 推送。协议完整字段见 [API](../API.md)，本页不复制完整参数表。

新增 `context.status` 与 `memory.records/confirm/feedback/archive/rollback/evolve` 管理 RPC；确认和整体结果反馈只接受管理入口，不作为 Agent 可自行证明事实的工具。`task_state` 与 `context_read` 是工作状态及原文回查工具。模型请求新增 `prepareForModel`，路由用实际窗口调用；执行端口新增 `prepareContext`。

与引擎直接相关的方法有 chat.send/stop、sessions/messages/live、tool.detail、记忆读写 / 搜索、审批 / 急停、模型 / 预算配置。主要事件是 activity、state、timeline、approval、session.switch、secret、hearing、speak、mesh、replica；进行中快照用于断线恢复界面，完成过程写入 SQLite。

网关明文只监听回环，局域网另走 HTTPS / WSS；原生控制台钉证书指纹。控制台身份是持网关令牌的管理者，模型工具不能直接代替控制台调用账户管理 API。内部 mesh 与公网发现服务的边界详见 [分布式设计](../DISTRIBUTED.md)。
