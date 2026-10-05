# runtime 模块地图

整体原理见仓库根目录的 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。本文列出每个文件的职责与约定。

```
src/
├── main.ts               装配各模块；熔断（安全模式）
├── config.ts             家目录布局、配置读写、密钥文件
├── bus.ts                进程内事件总线（sense / message / timeline / state / approval / say / notice / activity / secret / soul.alert / soul.pushed / mesh / mesh.event）
├── store.ts              SQLite：kv、timeline、sessions、messages（会话、执行过程、附件、插话方式、来源身体；role 为 user / agent / ambient）、audit、usage；消息与时间线按身体编号段编号、按时间排序；复制用的版本向量、补齐分页与幂等写入（applyRemote）；1.0 前编号的一次性迁移
├── log.ts                日志（stdout，写出前脱敏）
├── sh.ts                 外部命令执行（超时、输出上限）；后台任务（可随时停止整个进程组）
├── voice/
│   ├── azure.ts          语音：Azure 文本转语音（SSML、合成、音色列表、配置与密钥）与语音识别（官方 SDK 推流的连续流式识别 recognizeStream，各段拼成一段话；短语音 REST 的 recognize 兜底，长音频分段）
│   ├── player.ts         她的声音从哪里出来：耳朵开着时交给控制台 App 经通话路径播放（speak 事件 / player.done 回报，回声消除的参考），否则交给身体适配器；/media 文件下发；插嘴标记
│   └── hearing.ts        听觉：/hear 送来的一句话（流式 PCM 或整句 WAV）→ 识别（中间结果经 hearing 事件推送）→ 挑会话（windowMin 窗口）→ 以环境声音交给 brain.converse，她的取舍（kept / ignored）推给控制台；她自己说话期间丢弃；听觉状态（开关、急停、电量、温度）
├── crypto.ts             供应商 Key 的 AES-256-GCM 加密
├── version.ts            版本号
├── ops.ts                统一操作层：网关与飞书共用，修改类操作全部审计
├── gateway.ts            本地网关：/health、配对、本机登录、WebSocket RPC 与推送、静态文件
├── web.ts                网页控制台：托管 current/web/（QUETZAL_WEB_DIR 可覆盖，单页回退、ETag）；判定「同一台机器上的浏览器」（回环地址 + 本机 Host + 本机 Origin）给 GET /auth/local
├── body/
│   ├── adapter.ts        身体适配器接口（与设备仓库的唯一边界）+ 通用适配器
│   └── twin.ts           身体数字孪生：采样、身体感受、sense 事件、感官循环；「身体」段落含她自己的进程 pid
├── heart/
│   ├── model.ts          纯数学：驱动力、双过程生物钟、醒来率、指数抽样（无副作用）
│   └── heart.ts          状态机与稀疏化抽样调度；抑制；有界的性格修改
├── mind/
│   ├── prompt.ts         系统提示组装
│   ├── tools.ts          内置工具（含 recent_actions 查审计、view_image 同一轮不重复发图、edit_identity、tool_write / tool_read / tool_delete、hearing_config）+ 适配器工具 + 预留 hands 工具 + 她自己造的工具；经闸门调用；每次调用结束后触发灵魂目录的触碰即同步
│   ├── agents.ts         子 agent：她派出的后台工作者（自己的系统提示、独立工具循环、进展广播、对话、停止、报告送回派出它的会话）
│   ├── custom-tools.ts   自造工具：QUETZAL_HOME/tools/<名>/（tool.json + tool.sh | tool.mjs）的校验、热加载、执行（stdin JSON + ARG_ 环境变量 / ES 模块）、依赖检查；技能文档（灵魂仓库 skills/<名>/SKILL.md，Agent Skills 规范）的读写
│   ├── activity.ts       一轮的进展广播（activity 事件）与快照（liveTurns）、会话时间墙（120 秒无进展）、心跳、插话收件箱与打断、本轮已在上下文里的图片（seen）
│   ├── images.ts         图片：识别类型、较大图片缩小（ffmpeg / ImageMagick），供附件与 view_image 使用
│   ├── attachments.ts    附件：分类、保存（data/uploads）、组装带附件的消息（图片 / 文本内联 / 路径）
│   ├── processes.ts      进程列表：直接读 /proc（不依赖 ps，也不读 Android 上被拒的 /proc/stat），标出她自己、父进程与后台任务
│   ├── search.ts         网页搜索：真实浏览器请求头；360 搜索 / 百度 / 必应结果页解析，识别验证码页，按关键词覆盖率判断相关性并换引擎
│   ├── documents.ts      文档抽取：内置 zip 读取，docx / pptx / xlsx / ODF / EPUB / HTML / RTF，PDF 与旧版 Office 调用外部命令
│   ├── secrets.ts        保密传递（pass_secret）：保密输入协议（结束口令、截走对话里的保密值）、保密库（QUETZAL_HOME/vault）、工具输出里的保密值替换
│   └── brain.ts          醒来（内省 → 工具循环 → finish）、做梦、对话（含环境输入：ambient 消息、「沉默」不入库）；会话历史带时间与每轮的过程记录（describeProcess），session_compact 的摘要之前不进上下文；session_new 把回复放进新会话；子 agent 的循环与报告送回；快速模型代写摘要；灵魂同步的提醒（soul.alert）：插话进碰过记忆的那一轮，已结束则在原会话 / 主动消息里开新的一轮（「基座提醒」的口吻，可回复沉默）
├── memory/
│   ├── memory.ts         灵魂目录：人格、§ 条目记忆、日记、笔记目录树、未完成念头
│   ├── retrieval.ts      记忆检索（文本结构 RAG）：分词与打分、常驻记忆按预算展开、自动检索块
│   ├── soul-repo.ts      灵魂仓库协议（与桥接共用）：克隆 / 补齐、提交、拉取合并（条目级三方合并、字段合并、冲突副本）、推送结果与失败分类、身份守卫、整理租约、历史与撤销
│   └── soul-sync.ts      运行基座一侧的同步：触碰即同步（工具调用后 git status → 立即提交，3 秒去抖推送）、网络类静默重试、推送失败与冲突副本的提醒（soul.alert 事件）、待裁决的副本
├── mesh/                 网状层：同一个 agent 的在线身体两两直连（设计见 docs/ARCHITECTURE.md §6.2、docs/DISTRIBUTED.md）
│   ├── identity.ts       节点密钥（secrets/mesh_ed25519）、指纹、规范化 JSON、签名信封与验证（收件人、时间窗、防重放、只认灵魂仓库登记的公钥）
│   ├── directory.ts      同步服务客户端（协议见 sync/docs/PROTOCOL.md）：只接受 HTTPS、设备码绑定、信令 WebSocket（在场、转发、TURN 凭据刷新、指数退避重连）
│   ├── link.ts           一条 WebRTC 连接（node-datachannel）：发起方由名字决定、签名信令、DTLS 指纹的挑战应答、心跳与重连、中转凭据到期前重建、大消息分块
│   ├── mesh.ts           全连接管理：按在场建立 / 停止连接、验签、请求 / 应答、事件、状态（不含地址）
│   ├── replica.ts        一份对话：对话、会话与时间线在身体之间复制（连上时按版本向量补齐、分页续传；平时实时广播；收到的幂等写入）
│   └── runtime.ts        绑定到运行时：配置、绑定令牌（secrets/sync.json）、原生组件的按需加载、身体登记的公钥、soul.pushed → 其他身体立即拉取；网关的 mesh.* 方法
├── guard/guard.ts        能力授权、审批队列、急停、审计
├── providers/
│   ├── types.ts          统一消息/工具/结果类型
│   ├── adapters.ts       四种协议的 HTTP 适配（流式 SSE；模型调用时间墙：90 秒无数据）
│   ├── catalog.ts        models.dev 公共目录
│   ├── registry.ts       草稿保存、版本号、Key 加密
│   ├── router.ts         全局顺序路由、Key 轮换、故障转移、连通性测试
│   └── compat/           供应商兼容层（仅对匹配的供应商自动生效）：index.ts 登记，opencode-go.ts
└── channels/
    ├── feishu.ts         飞书长连接、消息（处理函数立即返回以支持插话；/new 开启新会话；保密输入期间只回不含内容的回执）、菜单与单聊事件、卡片回调、一键接入
    ├── feishu-progress.ts 执行过程卡片：按插话分段——插话那一刻上面的卡片定格，新的一段回复插话消息在下面重新开出；发送 / 更新经注入的 sender，可测试
    └── feishu-cards.ts   卡片 JSON 2.0：此刻 / 心流 / 记忆 / 控制 / 模型 / 权限 / 预算 / 审批 / 保密输入
```

约定：

- 设备相关逻辑一律不进入本目录，只能通过 `body/adapter.ts` 的接口。
- 所有通道的消息都经 `brain.ts` 的 `converse` 进入：保密输入的截取（`secrets.intake`）在那里，新通道不需要也不应该自己处理保密值，只需订阅 `secret` 事件提醒对方、把回执发回去。
- 新增的控制能力先加到 `ops.ts`，控制台与飞书再各自接入。
- 纯数学与状态转换放在无副作用的函数里（如 `heart/model.ts`），便于测试。
- TypeScript 只使用可擦除语法（`erasableSyntaxOnly`），测试直接用 Node 运行源码。
