---
title: 术语表
description: Windler 文档里反复出现的名词：运行基座、身体、适配器、心脏、内驱力、灵魂仓库、灵魂桥、闸门、保密库……
---

## 术语

| 术语 | 英文 | 含义 |
|---|---|---|
| 运行基座 | runtime | Windler 的核心程序（单文件 `main.cjs`），让 agent 活在一具身体里 |
| agent | agent | 住在运行基座里的那个"她 / 他 / 它"；身份来自灵魂仓库的 `agent.json` |
| 身体 | body | 运行着一个运行基座（或灵魂桥）的设备；同一个 agent 可以有多具身体 |
| 身体适配器 | body adapter | 设备与核心之间唯一的边界：采样、通知、播放、设备工具 |
| 身体数字孪生 | body twin | 把物理采样镜像为内部模型，派生精力、冷热、明暗、被拿起等身体感受 |
| sense 事件 | sense event | 身体状态的显著变化（插电、光线、被拿起、过热…），会调整驱动力 |
| 心脏 | heart | 决定何时醒来的模块：内驱力、生物钟、醒来抽样 |
| 内驱力 | drives | 好奇心、表达欲、想念、牵挂，0–1，随时间趋向饱和 |
| 生物钟 | body clock | 睡眠压力 S 与昼夜节律 C 的双过程模型；困意 = S − C |
| 醒来率 | wake rate (hazard) | 瞬时醒来概率密度（次 / 小时），由驱动力、清醒度与抑制决定 |
| 抑制 | inhibition | 急停、暂停、无模型、过热、低电、离线、预算用尽对醒来率的乘法系数 |
| 大脑 | mind | 一次醒来或对话的执行：内省 → 工具循环 → 反思（finish） |
| 内省模型 | quick model | 醒来时用于"想不想动"轻量判断的便宜模型 |
| 做梦 | dream | 睡眠中的醒来：整理记忆（把细节从常驻记忆移进笔记） |
| 会话 | session | 一组对话的容器；同一会话顺序处理，不同会话并行，彼此可见 |
| 插话 / 排队 / 打断 | steer / queue / interrupt | 她工作时你发消息的三种处理方式 |
| 时间墙 | idle wall | 按「无进展」计时的保护：模型调用 90 秒、会话 120 秒 |
| 灵魂 | soul | agent 的人格与记忆（`SOUL.md`、常驻记忆、日记、笔记、身份） |
| 灵魂目录 | soul directory | 本机 `WINDLER_HOME/soul/`，一个 git 仓库 |
| 灵魂仓库 | soul repository | 多具身体共享的私有 git 仓库，`<agent>.soul` |
| 灵魂同步 | soul sync | 基座全自动的拉取、合并、推送；她只感知到它发生了 |
| 灵魂桥 | soul-bridge | 装在 Hermes / OpenClaw 机器上的可插拔同步守护进程 |
| 身份守卫 | identity guard | 拒绝合并 `agent.json.id` 不同的仓库 |
| 种子身份 / 种子人格 | seed identity / seed soul | 自动生成、尚未修改的身份与人格；遇到远端已有的会让位 |
| 整理租约 | consolidation lease | 做梦前在仓库里取得的 30 分钟锁，避免两具身体同时整理记忆 |
| 常驻记忆 | resident memory | `memories/MEMORY.md` 与 `USER.md`，§ 分隔的条目，不限长 |
| 笔记 | notes | 共享的长期笔记，最多 4 层的目录树 |
| 日记 | journal | 情节记忆，每具身体每天一个文件 |
| 记忆目录 | memory index | 放进上下文的笔记索引（分类、篇数、标题与摘要） |
| 闸门 | guard | 能力授权（允许 / 询问 / 禁止）、审批、预算、急停、审计 |
| 能力类别 | permission category | 联网、执行命令、设备、相机、麦克风、定位、主动发消息、改参数、改记忆、操作屏幕、索取保密信息 |
| 审批 | approval | 「询问」类能力的请求，30 分钟未处理视为拒绝 |
| 急停 | emergency stop | 家目录里的 `STOP` 文件，存在即冻结一切行动 |
| 审计 | audit | 工具调用、配置修改、记忆修改、审批决定的记录 |
| 保密传递 | pass_secret | 她索取凭据的协议：你在聊天框里发，内容不进对话与上下文 |
| 保密库 | vault | `WINDLER_HOME/vault/`，保密值的本地存放处，不同步 |
| 结束口令 | done spell | 保密输入时标记"输入完毕"的随机短语 `done-xxxxxx` |
| 网关 | gateway | 运行基座的本地接口 `127.0.0.1:7788`：HTTP + WebSocket RPC |
| 配对码 | pairing code | 6 位、5 分钟有效，用于另一台设备上的 App 连接网关 |
| 点火 | ignite | 基座离线时 App 通过 Termux 重新执行开机脚本 |
| 安全模式 | safe mode | 10 分钟内启动超过 5 次后的保护状态：只开网关与飞书 |
| 此刻 | Now | App 首页：状态、驱动力、她想分享的一句话 |
| 心流 | Flow | App 的时间线页：醒来、做梦、对话的记录 |
| 主动消息 | proactive message | 她自己醒来时用 `send_message` 发出的消息 |
| hands | hands | 预留的屏幕与应用操作接口（尚未实现） |
| Termux 三件套 | Termux trio | Termux、Termux:API、Termux:Boot，必须来自同一来源 |
| 家目录 | WINDLER_HOME | 运行基座的全部数据所在，默认 `~/windler` |
