# 实现基线、证据与已知边界

## 1. 基线

- 记录日期：2026-10-13。
- 检查起点：源码提交 `dba3c618553ed6eb704991e48bfa13cd6db8094c`，runtime package 版本 `1.9.4`。
- 本轮环境：Linux，Node.js `v24.16.0`。
- 开始检查时 Git 工作区干净。本次只增加内核文档、更新全局与 runtime 文档入口，不修改运行时代码、依赖、配置或编译 / 部署脚本。
- 结论依据：现有全局 / 模块文档、生产入口与源码调用链、package / tsconfig、现有测试。未读取部署者的真实家目录、灵魂内容或凭据。

源码记录与测试通过只证明这里描述的实现及对应本地场景，不能推出跨平台真机、真实模型服务、云端部署或发布状态。

后续跨平台 CI 的测试门禁包括资源清理：新增上下文、记忆和 MCP 夹具先关闭服务及 SQLite 连接，再删除临时家目录。Windows x64 / ARM64 上业务断言通过但 after 钩子出现 EPERM，也必须判为失败；Linux 能删除打开的文件不能证明 Windows 生命周期正确。

## 2. 本轮验证

在 `runtime/` 执行：

```bash
node --experimental-strip-types --test \
  test/context.test.ts test/retrieval.test.ts test/recall.test.ts \
  test/memory.test.ts test/sessions.test.ts test/agents.test.ts \
  test/walls.test.ts test/providers.test.ts
```

结果：54 项通过，0 失败，0 跳过。模型行为由本地模拟服务验证，不调用真实供应商。

| 测试文件 | 本轮支持的结论 |
|---|---|
| [context.test.ts](../../runtime/test/context.test.ts) | 历史时间 / 附注 / 过程、附件路径、图片去重、审计检索、消息身体来源 |
| [retrieval.test.ts](../../runtime/test/retrieval.test.ts) | 分词、笔记树、相关性检索、常驻预算展开、自动检索预算 |
| [recall.test.ts](../../runtime/test/recall.test.ts) | 本环境 FTS5 可用、对话增量索引、时间过滤、日记小节、相邻消息 |
| [memory.test.ts](../../runtime/test/memory.test.ts) | 条目编辑 / 合并、日记、thought 写入和合并 |
| [sessions.test.ts](../../runtime/test/sessions.test.ts) | 会话并发 / 串行、插话 / 打断 / 排队、命令无输出超时、后台停止、失败标记、对话停止、主动消息 |
| [agents.test.ts](../../runtime/test/agents.test.ts) | 会话切换、压缩摘要、子 agent 独立提示词与报告、停止 |
| [walls.test.ts](../../runtime/test/walls.test.ts) | 模型流解析、取消与不再重试、轮次时间墙 / 暂停、进展广播 |
| [providers.test.ts](../../runtime/test/providers.test.ts) | 配置版本、Key 加密 / 校验、模型故障转移与工具解析 |

文档检查结果：12 个新增 / 修改文档的 180 个本地链接目标全部存在，代码围栏闭合；新增内容未发现真实本机路径、私钥块或具体身份 / 机型示例。源码标识与常数经人工核对，`git diff --check` 通过，提交范围仅文档。本轮未构建应用：没有源码 / 依赖 / 构建输入变更，不生成发布产物；未验证 Markdown 渲染器对 Mermaid 的实际显示。

## 3. 文档 / 注释与源码差异

| 观察 | 当前事实与处理 |
|---|---|
| 总架构与 main 注释将安全模式概括为“不调用模型” | `main()` 提前返回，跳过灵魂初始化、mesh、心脏与感知启动；但 gateway 的 chat.send 仍直接调用 converse，模型层没有统一 safeMode 门禁。全局架构同步改为准确边界；未修执行逻辑 |
| FTS5 注释称标题重复用于加权 | `syncDocs()` 拼标题两次，但 `toks()` 用 Set 去重；实际不能由重复增加标题词频。逐篇 `rank()` 有显式标题奖励。此处记录差异，不修改算法 |
| 子 agent 工具描述“没有你的记忆” | 不自动继承人格 / 历史，但有共享记忆工具，使用相同闸门；不能理解为记忆不可访问 |
| session_new / session_compact 描述“干净 / 压缩” | 后续历史读取才生效，不缩短当前 `messages`；入口文档已有提示，本目录展开具体时机 |
| 旧 CLI 文档以 App 装进 Termux / runit 类比 Linux 安装 | 当前 Android App 自带运行环境，由 RuntimeService 启动；旧 Termux 部署是兼容路径。本文采用当前全局架构与源码边界，未展开整理 CLI 历史文档 |

## 4. 已实现与未实现矩阵

| 能力 | 当前状态与限制 | 源码证据 |
|---|---|---|
| 自建工具循环 | 已实现；模型决定结束，无强制步数上限 | brain.loop |
| 多模型 / 协议 / 流式 | 已实现四种协议与路由；故障转移不做输入重预算 | providers/types、adapters、router |
| 当前会话上下文 | 已实现最近 80 条 / 字符预算 / 过程附注 | brain.history |
| 自动记忆注入 | 已实现文本 RAG，自动只取笔记 / 日记 | retrieval.recallBlock、prompt |
| 分层文件记忆 / 对话搜索 | 已实现 Markdown + SQLite FTS5 / 降级检索 | memory、index、retrieval |
| 会话摘要 / 交接 | 已实现模型主动工具；下一轮生效 | tools.session_compact / session_new |
| 本轮自动压缩 / 统一 token 预算 | 未实现；窗口过长仍可能失败 | brain.loop、ProviderModel.context |
| 向量 / embedding / 知识图谱 | 未实现；没有对应后端调用链 | memory 模块与 package 清单 |
| 后台子 agent | 已实现；同进程、共享权限、maxSteps 为提示要求 | agents、brain.spawnAgent |
| 任务检查点 / 重启继续执行 | 未实现；恢复元数据并标中断 | agents.restore、Session |
| 消费硬门禁 | 未实现；每日预算只抑制自主率 | heart.inhibition、router.chat |
| MCP 客户端 / 服务端 | 未实现 | 生产入口、工具注册、网关与依赖清单 |
| 交互式 TUI / 终端聊天 | 未实现 | cli 子命令与控制台源码 |
| 自造工具 / 技能 | 已实现本地沙箱子进程和意图文档同步；本轮工具定义是快照 | custom-tools、tools、brain.loop |
| 多身体协作 | 已实现复制、协调、运行位置、工具与文件借用；分区可多协调者 | mesh 模块 |
| 外部副作用恰好一次 | 未实现；claim 是主动使用的字面认领，分区本地决定 | claims、tools.callTool |
| 通用即时取消 / 回滚 | 未实现；对话取消、子 agent 停止、急停有不同边界 | activity、brain.untilStopped、guard、host-mode |

这里列出能力缺口作为现状，不自动把它们变成本次开发承诺。未来选择开发方向时，先明确要改变的行为与验收条件。

## 5. 未验证范围与后续取证入口

本轮没有执行完整 npm test、打包构建、Flutter 检查、Android / Windows 真机、真实模型和语音服务、远端 Git 或 WebRTC 多设备测试。上述实现存在可由源码确认，但对应部署行为没有本轮证据。

若后续改动涉及这些边界，可选择相应现有测试，再补缺失场景：

| 边界 | 现有取证入口（本轮未执行） |
|---|---|
| 自主调度 / 提醒 | heart.test.ts、reminders.test.ts |
| Git 同步 / 冲突 / 租约 / 路径 | soul-sync、soul-concurrent、soul-touch、soul-hardening、soul-roots、spec、portable-path 等测试 |
| 自造工具 / 权限 / 保密 / 真实环境 | custom-tools、security、secrets、host-mode、windows-sandbox 测试 |
| 多身体 | mesh、replica、presence、coordinator、placement、shared、claims、limbs、body-files 等测试 |
| 网关与 TLS / 本机登录 | gateway-tls、web 测试 |
| 图片 / 文档 / 听觉 | images、documents、hearing、voice 测试 |

新增能力应附可复现的证据；尤其不能用局部预算测试证明整体窗口安全，用模拟报告证明权限隔离，用单机同步测试证明分区恰好一次，或用文档声明证明 MCP / TUI 已接入。
