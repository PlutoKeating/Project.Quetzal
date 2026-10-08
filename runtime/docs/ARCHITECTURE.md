# runtime 模块地图

整体原理见仓库根目录的 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)。本文列出每个文件的职责与约定。

```
src/
├── main.ts               装配各模块；主动消息（say）入库到它带的会话，没带的进「主动消息」会话，并发系统通知；熔断（安全模式）；没人接住的同步异常记下后以非零退出（由守护者拉起）
├── config.ts             家目录布局（Windows 为 %LOCALAPPDATA%\Quetzal\home）、配置读写、密钥文件（改名遇到占用时重试）；密钥目录与保密库：POSIX 0700，Windows 用 ACL 只留本用户与 SYSTEM
├── platform.ts           平台差异：命令查找（Windows 按 PATHEXT）、结束整棵进程树（POSIX 进程组 / Windows taskkill /T）、只给本用户的目录权限（chmod / icacls）、遇到占用时重试的改名
├── ssh-key.ts            OpenSSH 格式的 ed25519 部署密钥（Node 内置 crypto 生成，不依赖 ssh-keygen）
├── mermaid.ts            Mermaid 的兜底渲染（网关 mermaid.render，单独打包为 mermaid.mjs）：beautiful-mermaid 画 SVG，整理成 flutter_svg 能显示的静态 SVG
├── bus.ts                进程内事件总线（sense / message / timeline / state / approval / say / notice / activity / secret / soul.alert / soul.pushed / mesh / mesh.event / reminders.changed / claims.changed 等）
├── store.ts              SQLite：kv、timeline、sessions、tool_calls（每次工具调用的完整参数与完整结果，只在本机，不复制；控制台点开卡片时经 tool.detail 取）、messages（会话、执行过程、附件、插话方式、写入它的身体 body、对方的话经哪具身体进来 via；role 为 user / agent / ambient）、audit、usage；消息与时间线按身体编号段编号、按时间排序；复制用的版本向量、补齐分页与幂等写入（applyRemote：编号段与作者、实时只收对方自己的行、字段类型与长度、时间范围；段尾 2^24 不收，本机的下一个编号不会越段）；用量只收对方自己的行；1.0 前编号的一次性迁移
├── log.ts                日志（stdout，写出前脱敏）
├── sh.ts                 外部命令执行（超时按「多久没有任何输出」计、输出上限，子进程不弹窗口）；agent 的命令与后台任务经沙箱执行（Windows 上是 PowerShell，输出的 CRLF 统一成 LF）、工作目录为用户主目录（Windows 为工作区 %USERPROFILE%\Quetzal）；后台任务可随时停止整棵进程树；真实环境里的命令不经沙箱（hostScript），前台命令自成进程组，超时或退出真实环境时整棵结束
├── host-mode.ts          真实环境模式：某个对话会话里她的 shell 不经沙箱、以基座的系统用户直接在主机上执行。她用 host_mode 带理由请求（每次都生成审批，不看能力类别的档位，并发系统通知）或对方在控制台打开（ops host.enter）；按会话、只在这具身体上、只在内存里（重启即回到沙箱）；30 分钟没有真实环境命令、急停、退出（她自己、控制台、飞书 /sandbox）时结束进行中的真实环境命令与后台任务；进出写审计与时间线（kind host），每条命令的审计参数带 realEnv
├── sandbox.ts            agent 命令的沙箱：Linux 用 bwrap（密钥目录为空 tmpfs、QUETZAL_HOME 只读、浏览器配置与用户启动文件保护、独立 pid 命名空间）或 Landlock，安卓用 proot（遮住密钥、配置、版本目录、runit 与开机脚本，以及 `QUETZAL_HIDE_PATHS` 指定的目录），Windows 用 sandbox-runtime 的 srt-win（沙箱用户 srt-sandbox、按会话授权的 ACL、WFP 拦直连、代理拒绝连回本机；库单独打包为 srt.mjs），都没有时 kind=none 并提醒一次；包装接口 wrapScript / wrapArgv（异步）；真实环境用的 hostScript / hostEnv（不经沙箱；基座自己的 QUETZAL_* 不传，其余原样传）；读文件工具的真实路径检查（protectedPath：Windows 上取系统的真实路径、不分大小写，不收 UNC、设备路径与流名）
├── idle-fetch.ts         按「无进展」计时的 HTTP 请求：多久没收到任何东西才放弃（合成语音、模型目录的下载）
├── secret-values.ts      基座自己的密钥值，按结构认定、不按长短猜（私钥整段与正文每一行、JSON 文件只认凭据字段 token、其余文件整个内容、模型供应商的 Key；公钥与证书不算），按修改时间缓存：给脱敏用
├── voice/
│   ├── azure.ts          语音：Azure 文本转语音（SSML、合成、音色列表、配置与密钥）与语音识别（官方 SDK 推流的连续流式识别 recognizeStream，各段拼成一段话；短语音 REST 的 recognize 兜底，长音频分段）
│   ├── player.ts         她的声音从哪里出来：耳朵开着时交给控制台 App 经通话路径播放（speak 事件 / player.done 回报，回声消除的参考），否则交给身体适配器；/media 文件下发；插嘴标记
│   └── hearing.ts        听觉：/hear 送来的一句话（流式 PCM 或整句 WAV）→ 识别（中间结果经 hearing 事件推送；没识别出文字的不打扰她，不按字数、时长丢弃）→ 挑会话（windowMin 窗口）→ 以环境声音交给 brain.converse，她的取舍（kept / ignored）推给控制台；她自己说话期间丢弃；听觉状态（开关、急停、电量、温度）
├── crypto.ts             供应商 Key 的 AES-256-GCM 加密（主密钥存在却损坏时报错，不重新生成）
├── tls.ts                网关的自签名证书（ECDSA P-256，10 年，secrets/gateway-tls.key|crt；@peculiar/asn1-x509 编码、node:crypto 签名；损坏或过期重新生成）、指纹（SHA-256 DER）与短格式、配对证明（PBKDF2-HMAC-SHA256）
├── version.ts            版本号
├── ops.ts                统一操作层：网关与飞书共用，修改类操作全部审计
├── gateway.ts            网关：明文 HTTP 只监听本机回环（127.0.0.1 与 ::1），对局域网开放时另开 HTTPS / WSS（lanPort，同一套处理）；/health、/pair/info（证书指纹）、配对（8 位码、冷却、失败锁定与退避、Host 检查、请求体 16 KB 上限；HTTPS 上只收与证书指纹绑定的配对证明）、本机登录、令牌（Bearer / X-Quetzal-Token / WebSocket 第一条消息 / 旧的 ?token=）、gateway.rotateToken、WebSocket RPC 与推送、静态文件
├── web.ts                网页控制台：托管 current/web/（QUETZAL_WEB_DIR 可覆盖，单页回退、ETag）；判定「同一台机器上打开着网页控制台的浏览器」（回环地址 + 本机 Host + Origin 正好是网关自己的源 / QUETZAL_DEV_ORIGINS）与「发起连接的是不是运行基座的子孙进程」（Linux 读 /proc，Windows 用 netstat 与 Win32_Process 的父进程表，查不出按拒绝）给 GET /auth/local；配对接口的 Host 检查
├── body/
│   ├── adapter.ts        身体适配器接口（与设备仓库的唯一边界）+ 通用适配器
│   ├── twin.ts           身体数字孪生：采样、身体感受、sense 事件、感官循环；「身体」段落含她自己的进程 pid；加载适配器后定下身体 uuid
│   └── uuid.ts           身体的 uuid：绑定到设备（适配器的 deviceId() 经 sha256 派生为 RFC 9562 v8，原始标识不外露），存在 state/body-uuid（{uuid, source}），设备派生的不再变；取不到设备标识时先用随机 v4，之后每次启动与启动后隔一会儿再试（twin.ts 的 settleBodyUuid），取到就换成设备派生的值
├── heart/
│   ├── model.ts          纯数学：驱动力、双过程生物钟、醒来率、指数抽样（无副作用）
│   └── heart.ts          状态机与稀疏化抽样调度；抑制；有界的性格修改；跟随模式（不抽样，操作转给协调者）与状态的导出 / 采用
├── mind/
│   ├── prompt.ts         系统提示组装（其他会话的近况带会话 id）
│   ├── fetch-guard.ts    web_fetch 的出站检查：每一跳解析 DNS、拒绝回环 / 私有 / 链路本地 / CGNAT / 元数据地址，连接时再查（防 DNS 重绑定），手动跟随重定向
│   ├── tools.ts          内置工具（含 send_message：醒来时发到她选的已有会话或新开的会话，不指定则一次醒来一个新会话；recent_actions 查审计、view_image 同一轮不重复发图、edit_identity、tool_write / tool_read / tool_delete、hearing_config）+ 适配器工具 + 预留 hands 工具 + 她自己造的工具；经闸门调用（一个工具可属于几个类别，按最严的检查：自造工具加 shell，tool_write 加 tool_write）；参数脱敏后才进审批与审计；read_document / view_image 的真实路径检查；多具身体时读文件的工具（view_image、read_document、shell）多一个 body 参数，交给 body-files.ts；不按命令文字拦截，边界是 sandbox.ts；工具返回 ToolFailure（failed()）或抛错就是失败（命令非零退出、参数不对、那边出错），卡片红叉、上下文里写明失败；shell 的命令里有 ‹secret:…› 占位符就不执行；这一轮被停止时 shell 的命令随之结束；每次调用结束后触发灵魂目录的触碰即同步
│   ├── claims.ts         认领（claim 工具）：几个会话避免同时做同一件对外的事；按名字字面比较、带说明与期限；存 kv；多具身体时由协调者决定（setClaimRouter），记录按条目合并；系统提示「其他会话」里列出
│   ├── bodies.ts         其他身体的登记（多具身体时由 mesh/ 填入，带灵魂仓库登记的 uuid 与对方自报的 uuid）：工具表的 body_call / move_to 与系统提示的「其他身体」一节读它；可跨身体调用的内置工具名单
│   ├── body-files.ts     身体参数：解析 body（uuid → 登记里的身体名 → 认证过的连接，核对自报一致、拒绝一个 uuid 对多具身体）；file.read 的两端（那边 lendFile：闸门、真实路径挡密钥目录与保密库、只交普通文件、64 MB、分段；这边 fetchFile：闸门、核对大小与 sha256、文件名清洗、落到 data/from-bodies/<身体>/）；两边记审计
│   ├── agents.ts         子 agent：她派出的后台工作者（自己的系统提示、独立工具循环、进展广播、对话、停止、报告送回派出它的会话）
│   ├── custom-tools.ts   自造工具：QUETZAL_HOME/tools/<名>/（tool.json + tool.sh | tool.mjs）的校验、热加载、执行（一律在子进程里、经沙箱：stdin JSON + ARG_ 环境变量 / 子进程里加载 ES 模块，超时整组杀掉）、依赖检查；技能文档（灵魂仓库 skills/<名>/SKILL.md，Agent Skills 规范）的读写
│   ├── activity.ts       一轮的进展广播（activity 事件）与快照（liveTurns）、会话时间墙（120 秒无进展）、心跳、插话收件箱与打断、本轮已在上下文里的图片（seen）
│   ├── images.ts         图片：识别类型、较大图片缩小（ffmpeg / ImageMagick），供附件与 view_image 使用
│   ├── attachments.ts    附件：分类、保存（data/uploads）、组装带附件的消息（图片 / 文本内联 / 路径）
│   ├── processes.ts      进程列表：直接读 /proc（不依赖 ps，也不读 Android 上被拒的 /proc/stat），标出她自己、父进程与后台任务
│   ├── search.ts         网页搜索：真实浏览器请求头；360 搜索 / 百度 / 必应结果页解析，固定顺序、拿到结果即止（相不相关由她判断）；没有结果时照实说明，被转到别的网站就写出是哪里
│   ├── documents.ts      文档抽取：内置 zip 读取，docx / pptx / xlsx / ODF / EPUB / HTML / RTF，PDF 与旧版 Office 调用外部命令
│   ├── secrets.ts        保密传递（pass_secret）：保密输入协议（结束口令、截走对话里的保密值）、保密库（QUETZAL_HOME/vault）、工具输出与参数里的保密值替换（连同基座自己的密钥，见 secret-values.ts）
│   └── brain.ts          醒来（内省 → 多具身体时选在哪里做 → 工具循环 → finish）、做梦、对话（含环境输入：ambient 消息、「沉默」不入库）；会话历史带时间与每轮的过程记录（describeProcess；放在回复前一条单独的「基座附注」里，她的回复只留原文；主动消息的附注写明是她醒来时主动发的）；回复只取结束这一轮的那一步的文字，session_compact 的摘要之前不进上下文；session_new 把回复放进新会话；子 agent 的循环与报告送回；对话中模型空回的一步不算结束（提醒后重试最多两次，仍空则说明没能回复）；工具失败时上下文里写明失败，同样的调用第二次失败起提醒她不要原样重试；对方停止这一轮（stopTurn，网关 chat.stop）时中止模型输出、不再等工具，以一句说明结束；快速模型代写摘要；灵魂同步的提醒（soul.alert）：插话进碰过记忆的那一轮，已结束则在原会话 / 主动消息里开新的一轮（「基座提醒」的口吻，可回复沉默）
├── memory/
│   ├── memory.ts         灵魂目录：人格、§ 条目记忆、日记、笔记目录树、未完成念头；写灵魂目录的进程内写锁（exclusive，与合并互斥）
│   ├── retrieval.ts      记忆检索（文本结构 RAG）：分词与打分、常驻记忆按预算展开、自动检索块
│   ├── portable-path.ts  灵魂仓库里的路径在每一种身体上都放得下（规范 v13 §3.13）：Windows 的保留名、结尾的点与空格、非法字符、只差大小写的路径
│   ├── soul-repo.ts      灵魂仓库协议（与桥接共用）：克隆 / 补齐、提交、拉取合并（条目级三方合并、字段合并、冲突副本；改动工作区的那一段在调用方给的 exclusive 里执行）、推送结果（只按事实分：--porcelain 报告的被拒、基座自己拒绝同步 status.refused、配置不对、其余照 git 原文）、身份守卫、git 的执行安全（规范 v10 §5.2：不执行钩子、地址只来自配置、清理 .git/config、不收符号链接、提交前查密钥）、整理租约、历史与撤销
│   └── soul-sync.ts      运行基座一侧的同步：触碰即同步（工具调用后 git status → 立即提交，3 秒去抖推送）、git 失败静默重试（不按报错文字分类）、推送失败（附 git 原文）、冲突副本与「改动里有密钥」的提醒（soul.alert 事件）、待裁决的副本
├── mesh/                 网状层：同一个 agent 的在线身体两两直连（设计见 docs/ARCHITECTURE.md §6.2、docs/DISTRIBUTED.md）
│   ├── identity.ts       节点密钥（secrets/mesh_ed25519）、指纹、规范化 JSON、签名信封与验证（协议版本 MESH_PROTOCOL = 2 与 agent id、收件人、时间窗、防重放——含签于本次启动一分钟以前的一律不收、只认灵魂仓库登记的公钥）
│   ├── directory.ts      同步服务客户端（协议见 sync/docs/PROTOCOL.md）：只接受 HTTPS、设备码绑定、信令 WebSocket（在场、转发、TURN 凭据刷新、指数退避重连；网络变了且这条连接已经走不通时立即重连）；服务端每条消息按严格形状检查（身体名、长度、数量），不合格的丢弃
│   ├── link.ts           一条 WebRTC 连接（node-datachannel）：发起方由名字决定（应答方请对方发起，没回应按退避再请）、签名信令、DTLS 指纹（连同 agent id）的挑战应答、心跳与重连、网络变了时探一次（probe）、中转凭据到期前重建、大消息分块、连不上的诊断（失败次数、双方的候选类型）；对方违反协议（不是对象、认证前发分块、分块超限）就断开，原生回调里的异常一律接住
│   ├── netwatch.ts       网络变化：平台通知（适配器的 onNetworkChange）+ 每 5 秒比较本机地址与去往同步服务的路由用哪个本机地址（不发包），合并后通知网状层
│   ├── route.ts          经其他身体中转：签名的拓扑（rt，链路状态洪泛、30 秒刷新、90 秒作废）、最短路的下一跳、发出者签名的转发信封（fwd，最多 8 跳，收件人验签与防重放）；只读成员不参与
│   ├── mesh.ts           全连接管理：按在场建立 / 停止连接（同步服务说下线但直连通着就留着；停下的连接收到验过签名的连接请求就恢复；重新连上同步服务时没连上的立即重来）、网络变了时检查各条连接、直连不通时经中转收发、验签、请求 / 应答（回应只认被请求的身体）、事件、状态（不含地址）；只读成员（灵魂桥）只能调用可读的方法；钉住各身体的公钥与类型（TOFU，acceptPin 确认变更）、灵魂仓库更新后核对现有连接（reverify）；由对方触发的回调都接住异常
│   ├── replica.ts        一份对话：对话、会话与时间线在身体之间复制（连上时按版本向量补齐、分页续传，有总量上限；平时实时广播；收到的先经 store.applyRemote 逐字段检查再幂等写入）
│   ├── presence.ts       在场：进展事件转发给其他身体（控制台看得到别处进行中的一轮）、刚连上时取回对方的进行中轮次、断开时清掉；发给别处进行中会话的话（含附件）转过去（接收方只取白名单字段、就地处理，via 记为发来的那具身体）；给灵魂桥的近况（单行、截断、标明谁说的）
│   ├── coordinator.ts    协调者：交换候选条件（优先级、电源、启动时刻）选出持有心跳的身体；跟随者的心脏操作转给它，它广播心脏状态；分区重连时合并
│   ├── placement.ts      运行位置：各身体的概况（body.overview）、打分推荐、她在内省时选 where；在选中的身体上执行醒来（mind.wake）
│   ├── limbs.ts          肢体：可被调用的工具清单（tool.list）、在这里执行别处调来的工具（tool.call）、把这里的文件交给别处带 body 的工具（file.read，经 mind/body-files.ts 的 lendFile；灵魂桥调用不到）、灵魂仓库身体登记里的 uuid（soulRegistry）、接手换过来的对话（chat.continue）；填入 mind/bodies.ts
│   ├── shared.ts         全网共用：设置分区（较新的修改生效，修改时刻不能在未来、只留认得的键）、模型供应商连同 Key（接收方逐个校验、重新加密）、语音密钥、全网急停（停优先）、审批（在哪里批准都行，按「身体/编号」区分）、每日用量合计、提醒与认领（按条目合并；认领与放下经 claims.op 由协调者决定）、想分享的一句话（按写下的时刻后写胜）
│   ├── channels.ts       通道：飞书只由指定的身体持有（其他身体的主动消息转过去）；几只耳朵同时听到同一句话只留一只（起止时间重叠且识别出同样的字才算同一句，不按相似度猜）；记下哪只耳朵听到的（voice_speak 从那里说）
│   ├── node-key.ts       这具身体的节点密钥（灵魂同步写身体登记时用，不依赖整个网状层）
│   ├── account.ts        账户：控制台登录（身体令牌申请码 → 人在官网批准 → 账户令牌存 secrets/sync-account.json）与账户接口的代理；网关的 account.* 方法
│   └── runtime.ts        绑定到运行时：配置、绑定令牌（secrets/sync.json）、钉住记录（data/mesh-pins.json）、原生组件的按需加载、身体登记的公钥、soul.pushed → 其他身体立即拉取、拉取灵魂仓库后核对连接；网关的 mesh.* 方法（含 acceptPin）
├── guard/guard.ts        能力授权、审批队列（ask：不看档位、直接生成审批，真实环境的请求用它）、急停、审计
├── providers/
│   ├── types.ts          统一消息/工具/结果类型
│   ├── adapters.ts       四种协议的 HTTP 适配（流式 SSE；模型调用时间墙：90 秒无数据、180 秒无内容，没有绝对上限）
│   ├── catalog.ts        models.dev 公共目录
│   ├── registry.ts       草稿保存、版本号、Key 加密；从其他身体导入（逐个校验，API 地址只收 HTTPS 与本机回环，不合格的保留本机原来的，全部整理完才替换）
│   ├── router.ts         全局顺序路由、Key 轮换、故障转移（只看 HTTP 状态码）、连通性测试；能否看图只认手动设置与公共目录，查不到就当不能
│   └── compat/           供应商兼容层（仅对匹配的供应商自动生效）：index.ts 登记，opencode-go.ts
└── channels/
    ├── feishu.ts         飞书长连接、消息（处理函数立即返回以支持插话；/new 开启新会话；保密输入期间只回不含内容的回执）、主动消息（注明所在会话）、菜单与单聊事件、卡片回调、一键接入
    ├── feishu-progress.ts 执行过程卡片：按插话分段——插话那一刻上面的卡片定格，新的一段回复插话消息在下面重新开出；发送 / 更新经注入的 sender，可测试
    └── feishu-cards.ts   卡片 JSON 2.0：此刻 / 心流 / 记忆 / 控制 / 模型 / 权限 / 预算 / 审批 / 保密输入
```

约定：

- 设备相关逻辑一律不进入本目录，只能通过 `body/adapter.ts` 的接口。
- 所有通道的消息都经 `brain.ts` 的 `converse` 进入：保密输入的截取（`secrets.intake`）在那里，新通道不需要也不应该自己处理保密值，只需订阅 `secret` 事件提醒对方、把回执发回去。
- 新增的控制能力先加到 `ops.ts`，控制台与飞书再各自接入。
- 纯数学与状态转换放在无副作用的函数里（如 `heart/model.ts`），便于测试。
- TypeScript 只使用可擦除语法（`erasableSyntaxOnly`），测试直接用 Node 运行源码。
