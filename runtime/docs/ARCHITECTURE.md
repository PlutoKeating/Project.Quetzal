# runtime 模块地图

整体原理见仓库根目录的 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。本文列出每个文件的职责与约定。

```
src/
├── main.ts               装配各模块；熔断（安全模式）
├── config.ts             家目录布局、配置读写、密钥文件
├── bus.ts                进程内事件总线（sense / message / timeline / state / approval / say / notice / activity）
├── store.ts              SQLite：kv、timeline、sessions、messages（会话、执行过程、附件、插话方式）、audit、usage
├── log.ts                日志（stdout，写出前脱敏）
├── sh.ts                 外部命令执行（超时、输出上限）；后台任务（可随时停止整个进程组）
├── voice/azure.ts        语音：Azure 文本转语音（SSML、合成、音色列表、配置与密钥）
├── crypto.ts             供应商 Key 的 AES-256-GCM 加密
├── version.ts            版本号
├── ops.ts                统一操作层：网关与飞书共用，修改类操作全部审计
├── gateway.ts            本地网关：/health、配对、WebSocket RPC 与推送
├── body/
│   ├── adapter.ts        身体适配器接口（与设备仓库的唯一边界）+ 通用适配器
│   └── twin.ts           身体数字孪生：采样、身体感受、sense 事件、感官循环
├── heart/
│   ├── model.ts          纯数学：驱动力、双过程生物钟、醒来率、指数抽样（无副作用）
│   └── heart.ts          状态机与稀疏化抽样调度；抑制；有界的性格修改
├── mind/
│   ├── prompt.ts         系统提示组装
│   ├── tools.ts          内置工具 + 适配器工具 + 预留 hands 工具；经闸门调用
│   ├── activity.ts       一轮的进展广播（activity 事件）与快照（liveTurns）、会话时间墙（120 秒无进展）、心跳、插话收件箱与打断
│   ├── images.ts         图片：识别类型、较大图片缩小（ffmpeg / ImageMagick），供附件与 view_image 使用
│   ├── attachments.ts    附件：分类、保存（data/uploads）、组装带附件的消息（图片 / 文本内联 / 路径）
│   ├── search.ts         网页搜索：真实浏览器请求头；360 搜索 / 百度 / 必应结果页解析，识别验证码页，按关键词覆盖率判断相关性并换引擎
│   ├── documents.ts      文档抽取：内置 zip 读取，docx / pptx / xlsx / ODF / EPUB / HTML / RTF，PDF 与旧版 Office 调用外部命令
│   └── brain.ts          醒来（内省 → 工具循环 → finish）、做梦、对话
├── memory/
│   ├── memory.ts         灵魂目录：人格、§ 条目记忆、日记、笔记目录树、未完成念头
│   ├── retrieval.ts      记忆检索（文本结构 RAG）：分词与打分、常驻记忆按预算展开、自动检索块
│   └── soul-sync.ts      git 同步与条目级三方合并
├── guard/guard.ts        能力授权、审批队列、急停、审计
├── providers/
│   ├── types.ts          统一消息/工具/结果类型
│   ├── adapters.ts       四种协议的 HTTP 适配（流式 SSE；模型调用时间墙：90 秒无数据）
│   ├── catalog.ts        models.dev 公共目录
│   ├── registry.ts       草稿保存、版本号、Key 加密
│   ├── router.ts         全局顺序路由、Key 轮换、故障转移、连通性测试
│   └── compat/           供应商兼容层（仅对匹配的供应商自动生效）：index.ts 登记，opencode-go.ts
└── channels/
    ├── feishu.ts         飞书长连接、消息（处理函数立即返回以支持插话；/new 开启新会话）、菜单与单聊事件、卡片回调、一键接入
    └── feishu-cards.ts   卡片 JSON 2.0：此刻 / 心流 / 记忆 / 控制 / 模型 / 权限 / 预算 / 审批
```

约定：

- 设备相关逻辑一律不进入本目录，只能通过 `body/adapter.ts` 的接口。
- 新增的控制能力先加到 `ops.ts`，控制台与飞书再各自接入。
- 纯数学与状态转换放在无副作用的函数里（如 `heart/model.ts`），便于测试。
- TypeScript 只使用可擦除语法（`erasableSyntaxOnly`），测试直接用 Node 运行源码。
