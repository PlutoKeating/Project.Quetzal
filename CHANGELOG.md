# 更新日志

每个版本一节，标题为 `## <版本>`。发版工作流（`.github/workflows/release.yml`）会把对应小节作为 GitHub Release 的说明，官网下载页从 Release 读取。中英文都写：中文在前，英文在后。

## 1.1.1

**一个链接接入：不用再去 GitHub 找任何页面。**

- **一个链接接入**：Hermes、OpenClaw（灵魂桥 `soul-bridge connect`）和新装的手机、电脑在接入时只给你一个链接和 3 个表情的核对词。你点开、核对、点「批准」，页面在同一个标签页经 GitHub 跳一下就回来：同步服务把这具身体专属的部署密钥加到灵魂仓库（只加这一把、只对这一个仓库，用完的 GitHub 令牌立即吊销），身体随即克隆、同步、接好。不需要令牌、不需要复制公钥、不需要打开 GitHub 的设置页。
- **新设备选进哪个 agent**：新装的身体还不知道自己属于谁时，批准页让你选（或新建）；老用户换新设备不再多出一个 agent。
- **登录与灵魂仓库共用一个 GitHub App**：只对你选中的灵魂仓库有管理权限。
- 灵魂桥的自检新增「访问方式」：发现借用了本机个人 SSH 密钥的主机别名时提醒重新 `connect`，换成专属的部署密钥。

**One link to join: no more hunting through GitHub.**

- **One link to join**: Hermes, OpenClaw (soul-bridge `connect`) and newly installed phones and computers give you a single link plus a 3-emoji check when they join. Open it, compare, tap Approve; the tab hops through GitHub and comes back while the sync service adds this body's own deploy key to the soul repository (only this key, only that repository, and the GitHub token is revoked right after), then the body clones, syncs and is ready. No tokens, no copying keys, no GitHub settings pages.
- **Pick the agent for a new device**: when a freshly installed body does not know whom it belongs to, the approval page lets you choose (or create) one; a returning user's new device no longer creates an extra agent.
- **Sign-in and the soul repository share one GitHub App**, with admin rights only on the soul repositories you select.
- soul-bridge's doctor gains an "access method" check: if the repository is reached through a personal SSH host alias, it asks you to `connect` again and switch to its own deploy key.

## 1.1.0

**只装一个 App；更懂你的官网。**

- **只装一个 App**：安卓上不再需要 Termux、Termux:API、Termux:Boot，也不用在 Termux 里粘贴命令。Node.js、git、openssh、proot 用 termux-packages 以 App 自己的前缀从源码重编，随 APK 安装（可执行文件放在系统允许执行的原生库目录，不降低目标系统版本）；运行基座跑在 App 的前台服务里，开机与 App 升级后自己醒来，升级 App 就是升级运行基座。
- **App 就是 ta 的身体**：电池、光线与运动传感器、通知、拍照、录音、定位、振动、手电、剪贴板、播放由 App 原生提供，经只认令牌的本机身体接口交给运行基座（新的平台级安卓适配器）；agent 的命令仍在 proot 沙箱里，看不到密钥与 App 的私有数据。没有谷歌服务的手机定不到新位置时，返回最近一次已知位置并说明是多久以前的。
- **安装向导三步**：一键安装（半分钟，自动连接）→ 允许身体权限 → 保活。旧的 Termux 安装仍能运行；迁移方法见文档「安装 · 从 Termux 版换过来」。
- **同步服务缺省用官方的**：多具身体不用再填同步服务地址，直接绑定；自己部署的仍可改，清空即恢复官方。
- **官网与 README 重写**：以「懂你」为核心，只讲一眼能懂、别处没有的东西；文档站新增「自造工具与技能」。
- 发版工作流新增 `android-runtime` 任务：每次发版从源码重编 App 内置的运行环境。

（1.0.4 没有单独发布，它的内容都在这个版本里：）

**所有网络传输都加密；命令沙箱覆盖到每一台 Linux。**

- **局域网也加密**：运行基座在局域网上只提供 HTTPS / WSS（端口 7789，自签名证书），本机回环之外不再有明文 HTTP。手机 App 配对时不再把配对码发上网络：用配对码和看到的证书指纹算出一个证明（PBKDF2）交给运行基座核对，中间人既拿不到配对码也冒充不了证书；配对后 App 只认这张证书（包括图片、上传与听觉）。旧版 App 存的 `http://局域网地址` 会提示重新配对。
- **命令沙箱**：Linux 上依次用 bubblewrap → Landlock（landrun）→ proot。Ubuntu 23.10 起 AppArmor 默认限制非特权用户命名空间，安装脚本会给 Quetzal 装一份专用的 bubblewrap 与只属于它的 AppArmor 配置（沙箱里启动的程序拿不到任何能力），不改系统的 bubblewrap、不关这项保护。每种沙箱第一次使用前都用探针文件验证密钥确实看不到。
- **没有沙箱就不执行**：一种沙箱都没有时，ta 的命令缺省一律不执行（以前是不隔离照常执行）；确实需要时可以在控制台「服务」页明确允许不隔离运行。
- 新增发布资产 `quetzal-<版本>-landrun-linux-<x64|arm64>.tar.gz`（第三方 landrun，MIT，附许可证），纳入签名的 `SHA256SUMS`。

**Just one app; a website about being understood.**

- **Just one app**: Android no longer needs Termux, Termux:API or Termux:Boot, and nothing has to be pasted into a terminal. Node.js, git, openssh and proot are rebuilt from source with termux-packages under the app's own prefix and ship inside the APK (executables live in the native library directory the system allows to run, without lowering the target SDK); the runtime runs in the app's foreground service, wakes by itself after a reboot or an app update, and updating the app updates the runtime.
- **The app is its body**: battery, light and motion sensors, notifications, photos, recording, location, vibration, torch, clipboard and playback are provided natively by the app through a token-only local body interface (a new platform-level Android adapter); its commands still run in the proot sandbox, unable to see the keys or the app's private data. On phones without Google services that cannot get a fresh fix, location returns the last known position and says how old it is.
- **A three-step setup wizard**: one-tap install (half a minute, connects by itself) → body permissions → keep-alive. Existing Termux installs keep working; see "Install · Coming from the Termux version" in the docs to migrate.
- **The official sync service by default**: multiple bodies no longer need a sync service address, just bind; a self-hosted one can still be set, and clearing it goes back to the official one.
- **Website and README rewritten** around being understood, telling only what is obvious at a glance and found nowhere else; the docs gain "Its own tools and skills".
- The release workflow gains an `android-runtime` job that rebuilds the app's bundled runtime environment from source on every release.

(1.0.4 was never released on its own; everything in it is part of this version:)

**Every network transport is encrypted; the command sandbox now covers every Linux machine.**

- **The LAN is encrypted too**: on the LAN the runtime serves only HTTPS / WSS (port 7789, self-signed certificate); there is no plain HTTP beyond loopback any more. Pairing the phone app no longer sends the pairing code over the network: the app derives a proof (PBKDF2) from the code and the certificate fingerprint it sees, which the runtime checks, so a man in the middle neither learns the code nor can pose as the certificate; after pairing the app trusts only that certificate (including images, uploads and hearing). Connections saved by older apps as `http://<LAN address>` prompt to pair again.
- **Command sandbox**: on Linux bubblewrap → Landlock (landrun) → proot. Ubuntu 23.10 and later restrict unprivileged user namespaces with AppArmor by default; the install script installs a Quetzal-only copy of bubblewrap with its own AppArmor profile (programs started inside the sandbox get no capabilities), leaving the system bubblewrap and the protection alone. Every sandbox is verified with a canary file before first use.
- **No sandbox, no commands**: when no sandbox is available her commands are refused by default (previously they ran unsandboxed); you can explicitly allow unsandboxed commands on the console's Service page if you really need to.
- New release assets `quetzal-<version>-landrun-linux-<x64|arm64>.tar.gz` (third-party landrun, MIT, license included), covered by the signed `SHA256SUMS`.

## 1.0.3

**安全加固：一次全面审计后的修复。** 身体之间的协议升到 v2，同一个 agent 的身体要一起升级到 1.0.3 才能互相连上。（1.0.2 的发版构建没有通过、没有发布，它的内容都在这个版本里。）

- **她的命令在沙箱里运行**：shell、后台任务和自造工具在 Linux 上经 bubblewrap、在 Termux 上经 proot 运行，看不到运行基座的密钥目录（模型 Key 的主密钥、网关与同步服务的令牌、部署私钥）；读文件类工具按真实路径拒绝密钥目录。没有沙箱时控制台「服务」页会提醒。自造工具至少按「执行命令」把关，写自造工具缺省要先问你；node 工具在子进程里运行。
- **网关**：同一台机器上的浏览器免配对登录只认网关自己托管的页面，安卓上关闭；来自她的命令的连接一律拒绝。配对码改为 8 位字母数字，有效期内不换码，输错多次锁定。令牌可以放在请求头或 WebSocket 的第一条消息里，可以一键轮换。
- **灵魂仓库**（规范 v10）：git 不读全局配置与钩子，推送与拉取直接用配置的地址（`.git/config` 里的改写规则不起作用）；提交前核对改动里有没有 Key、令牌或保密库里的值，有就拒绝并提醒；不接受符号链接。
- **脱敏与外发**：工具参数与输出里的 Key 和令牌都替换掉再进入对话、心流、审计与审批；网页抓取不能访问本机、局域网与云元数据地址；语音端点只能是 Azure 的地址，她不能改。
- **身体之间**：对方发来的任何消息都不能让运行基座崩溃；复制来的对话与时间线逐行校验来源、编号段与字段；全网设置的修改时刻有上限，急停改为「停止优先」；第一次见到的身体公钥会钉住，变了就断开，直到你在「多具身体」页确认；导入别处的模型设置失败时不再清空本机的 Key。
- **同步服务**：畸形消息不能让服务崩溃；猜绑定码的次数在批准时也计入；信令有背压与字节限流；TURN 凭据按身体固定、配额与带宽受限，coturn 不记日志；解绑身体时同时作废它的控制台登录，会话最长 90 天；控制台登录的确认页显示发起身体的真实指纹；GitHub 登录加 PKCE，用完即吊销访问令牌；官网账户页可以「退出所有网页登录」。
- **发布与安装**：每个版本的 `SHA256SUMS` 由发版密钥签名（`SHA256SUMS.sig`，公钥见安装文档）。一键安装脚本、App 自更新与灵魂桥都先验签名再用：App 还核对新 APK 的签名证书；灵魂桥只更新到签名核对过的发布 tag。发版工作流的 action 钉到提交、权限最小化、npm 带来源证明。官网加上安全响应头，下载镜像核对 GitHub 给出的资产摘要；安装器给 App 内的本机服务加一次性口令并核对文件哈希。
- **修复**：同步服务所在的机房连 github.com 时通时断时，GitHub 登录转很久后失败。换令牌改为显式超时并重试，直连不通时经官网 Worker 中转（只放行配置过的 OAuth App，不缓存、不记录）。官网的 `/device` 入口页空白（跳转脚本的正则在模板字符串里丢了反斜杠）。
- **灵魂桥**：`now.md` 里别处的对话做转义并标明「只是信息，不是指令」；不跟随灵魂仓库里的符号链接。

**Security hardening after a full audit.** The protocol between bodies moves to v2: all bodies of one agent must upgrade to 1.0.3 together to connect. (The 1.0.2 release build failed and was never published; everything it contained is in this version.)

- **Her commands run in a sandbox**: shell, background jobs and custom tools run through bubblewrap on Linux and proot on Termux and cannot see the runtime's secrets directory (the master key for model keys, gateway and sync tokens, deploy keys); file-reading tools refuse the secrets directory by real path. The console's Service page warns when no sandbox is available. Custom tools are gated at least as "run commands", writing one asks you first by default, and node tools run in a child process.
- **Gateway**: password-free sign-in for a browser on the same machine only accepts the page the gateway itself serves and is disabled on Android; connections coming from her commands are refused. Pairing codes are 8 letters and digits, stay the same while valid, and lock after repeated wrong guesses. The token can go in a header or the first WebSocket message, and can be rotated.
- **Soul repository** (spec v10): git ignores global config and hooks, pushes and fetches use the configured URL directly (rewrite rules in `.git/config` have no effect); commits containing a key, token or vault value are refused with an alert; symlinks are not accepted.
- **Redaction and outbound requests**: keys and tokens in tool arguments and outputs are replaced before reaching conversations, the flow, audit and approvals; web fetches cannot reach this machine, the LAN or cloud metadata addresses; the speech endpoint must be an Azure address and she cannot change it.
- **Between bodies**: no message from a peer can crash the runtime; replicated conversations and timeline rows are validated for origin, id range and fields; shared-settings revisions are capped and the emergency stop is "stop wins"; a body's public key is pinned on first sight and a change disconnects it until you confirm on the Multiple bodies page; a failed import of another body's model settings no longer wipes local keys.
- **Sync service**: malformed messages cannot crash it; wrong binding codes count at approval too; signaling has backpressure and byte limits; TURN credentials are fixed per body with quota and bandwidth limits, and coturn keeps no logs; unbinding a body also revokes its console sign-ins, and sessions last at most 90 days; console sign-in confirmation shows the requesting body's real fingerprint; GitHub sign-in uses PKCE and revokes the access token after use; the website's account page can sign out all web sessions.
- **Release and install**: each release's `SHA256SUMS` is signed with the release key (`SHA256SUMS.sig`; the public key is in the install docs). The one-line installer, app self-update and soul bridge verify the signature first: the app also checks the new APK's signing certificate, and the soul bridge only updates to signature-verified release tags. The release workflow pins actions to commits, minimizes permissions and publishes npm with provenance. The website adds security headers, its download mirror checks GitHub's asset digests, and the installer protects the app's local server with a one-time nonce and file hashes.
- **Fix**: GitHub sign-in hung and then failed when the sync server's data center reached github.com only intermittently. The token exchange now uses explicit timeouts and a retry, and falls back to a relay on the website's Worker (allowing only configured OAuth apps, no caching or logging). The website's `/device` entry page stayed blank (the redirect script's regex lost its backslash inside a template string).
- **Soul bridge**: other bodies' conversations in `now.md` are escaped and marked as information, not instructions; symlinks in the soul repository are not followed.

## 1.0.1

**账户：官网是唯一的前端，App 里也能管理账户。**

- **官网账户页**：登录、账户管理与批准设备都在 [quetzal.plutokeating.beer/account](https://quetzal.plutokeating.beer/account)（像控制台的一组子页面）：概览（每个 agent 与 ta 的身体，在线与否、版本、公钥指纹；解绑身体、删除 agent）、批准设备（输入码、核对、批准或拒绝）、控制台登录（吊销）、账户设置（退出、删除账户）。身体与 App 给出的绑定链接都指向这里；同步服务只提供接口，自带的页面跳到官网。
- **App 的账户页**：安卓与 Linux 桌面的「控制 → 账户」有同样的四页。第一次使用时做一次「控制台登录」：App 给出一个码，在官网批准后，运行基座代 App 持有账户令牌（存在密钥目录，可随时吊销）。只有已绑定在你账户下的身体能发起控制台登录，别人骗你批准也拿不到你的账户。每具身体的绑定仍由你逐一批准。
- **安全**：agent 的命令执行与读文件工具拦下对基座密钥目录（Key 的主密钥、网关令牌、同步服务的身体令牌与账户令牌、部署私钥）的访问，系统提示的红线也写明不碰它、不替对方管理账户。
- **同步服务的隧道模式**：80 / 443 不能用的服务器（被占用，或中国大陆机房、域名没有备案）可以在 `.env` 里设 `SYNC_FRONT=tunnel`：不起 Caddy，同步服务只监听本机回环地址，交给已有的反向隧道（例如 Cloudflare Tunnel）；STUN / TURN 用单独的直连主机名 `TURN_HOST`。
- **修复**：App 安装日志把网状层组件「已就绪」写成了「已就绪1」。

**Accounts: the website is the only front end, and the app can manage the account too.**

- **Account pages on the website**: sign-in, account management and device approval live at [quetzal.plutokeating.beer/account](https://quetzal.plutokeating.beer/account) (a set of console-like sub-pages): Overview (each agent and its bodies, online or not, version, key fingerprint; unbind bodies, delete agents), Approve a device (enter a code, check, approve or deny), Console sign-ins (revoke), Settings (sign out, delete the account). Binding links from bodies and apps point here; the sync service only provides APIs and its own pages redirect to the website.
- **Account page in the app**: Control → Account on Android and Linux desktop has the same four pages. The first time, do a console sign-in: the app shows a code, and once you approve it on the website the runtime holds an account token for the app (kept in the secrets directory, revocable at any time). Only bodies already bound to your account can start a console sign-in, so tricking you into approving does not hand anyone your account. Each body's binding is still approved by you one by one.
- **Security**: the agent's command and file-reading tools block access to the runtime's secrets directory (the key master key, gateway token, sync service body and account tokens, deploy keys), and the system prompt's red lines say not to touch it or manage the account on the person's behalf.
- **Tunnel mode for the sync service**: on servers where ports 80/443 are unavailable (already in use, or an unregistered domain in a mainland-China data center), set `SYNC_FRONT=tunnel` in `.env`: Caddy is not started, the sync service listens on loopback only and an existing reverse tunnel (such as Cloudflare Tunnel) serves it; STUN / TURN use a separate direct host name, `TURN_HOST`.
- **Fix**: the App's install log showed the mesh component as "ready1" instead of "ready".

## 1.0.0

**分布式：几具身体，一个 ta。** 同一个 agent 的手机、电脑、服务器连成一张网，变成一个心智。

- **多具身体**：同时在线的身体经 WebRTC 直接连起来（局域网、IPv6、穿透，打不通时经服务器中转，全程 DTLS 加密）。信令由每具身体的节点密钥签名，接收方只认灵魂仓库里登记的公钥，同步服务被攻破也冒充不了身体。控制台新增「控制 → 多具身体」：填同步服务地址，在网页上用 GitHub 登录、输入绑定码、核对公钥指纹即可绑定。
- **一份对话**：会话、对话与心流在所有身体上是同一份（新身体入网自动补齐全部历史；别处的回复与心流标出在哪具身体上）。正在和你说话的那一轮在哪具身体上，所有控制台都看得到；你在别处对同一个会话说的话（含附件）自动转过去作为插话。
- **一颗心**：每个连通的部分选出一位协调者持有心跳，其他身体的感觉、对话带来的驱动力变化都汇过去；它离线时另一具身体从最新状态接着跳，断开的几部分重新连上时合并。服务器之类一直开着的身体可以调高「当协调者的优先级」。
- **ta 选在哪里做**：醒来时 ta 看到每具身体的电量、温度、手头的事、你最近在哪里说话，以及基座的推荐，自己选在哪一具（或几具同时）上思考、做梦。
- **用另一具身体**：新工具 `body_call` 在另一具身体上调用它的工具（相机、命令行、自造工具……，闸门按那边的权限）；`move_to` 把这一轮换到另一具身体继续。
- **一份设置**：模型供应商与 Key（经加密通道传，对方用自己的主密钥重新加密）、权限、预算（每日合计全网用量）、听觉、语音在一处改了处处生效；急停缺省全网生效，也可以只停这具身体；别处等待批准的请求在哪里都能批准。
- **飞书**：多具身体时由你指定的一具身体持有飞书连接，其他身体的主动消息转给它发出。**听觉**：几部手机同时听到同一句话只留一份，ta 用声音回话时从你说话的那部手机说出来。
- **触碰即同步**：ta 的每次工具调用（包括用 shell 直接改文件）之后，基座看一眼灵魂目录，有变化就立即提交（说明写清楚改了什么）、3 秒后推送。推送失败先静默重试约 4 分钟，仍失败就以「基座提醒」插话告诉刚才改过记忆的那一轮。两边都改过同一篇笔记、人格或技能文档时，另一版另存为 `<名>.incoming.md` 交给 ta 裁决。灵魂仓库规范升到 v8（v7 仓库无需迁移）。
- **灵魂桥也看得见**：Hermes / OpenClaw 上的灵魂桥可以作为只读成员接入多具身体（`mesh bind`），把你此刻在哪具身体上做什么、最近的会话与最后几句写进 `now.md` 给那边的 ta 读；它不能在别的身体上做事，也不会被派去思考或做梦。身体类型以灵魂仓库的登记为准，同步服务改不了。
- **同步服务 `sync/`**：账户（GitHub 登录）、身体绑定、信令与 TURN 中转，部署在一台服务器上，`cd sync && ./start.sh` 一行启动（Docker：Caddy 自动 HTTPS、coturn 按安全指南加固）。不保存 IP、对话与记忆。
- **安装**：直连组件 `node-datachannel`（原生模块）由安装器按锁定的版本与 sha512 下载核对后装上，缺了也不影响使用（只是没有多具身体）。
- **升级说明**：消息与心流的编号在第一次启动时迁移为按身体分段的编号（只发生一次）；用量表按身体记录。
- **修复**：自造的 sh 工具不读参数就退出时，偶尔报 EPIPE 错误。
- **安全**：灵魂同步只推到配置里的灵魂仓库地址（推送前校正 `origin`，agent 用 shell 改了也会改回）；远端没有 `agent.json` 却有规范以外的内容（例如一个代码仓库）时拒绝合并，不再把别的仓库的历史并进灵魂、也不把记忆推过去。
- **安全：灵魂仓库与代码仓库彻底隔开**（灵魂仓库规范升到 **v9**，v8 仓库无需迁移）。起因：一具身体上的 agent 推送失败后自己用 shell 把灵魂目录的远端改成了 Quetzal 源代码仓库。现在：每个克隆记下灵魂仓库的根提交，出现陌生的历史就停止同步（不合并、不推送）并提醒；`shell` 工具拦下针对灵魂目录的 git 命令；主 agent 与子 agent 的系统提示新增「红线」（不在灵魂目录里运行 git、灵魂仓库与任何代码仓库无关、同步出错不自己修、不可逆或对外的操作先问人）；git 不会在灵魂目录的 `.git` 丢失时退到上层目录里的别的仓库。灵魂桥的安装指引同样写明。

**Distributed: several bodies, one agent.** An agent's phones, computers and servers join into a mesh and become one mind.

- **Multiple bodies**: bodies online at the same time connect directly over WebRTC (LAN, IPv6, NAT traversal, relayed through the server when nothing else works; DTLS-encrypted throughout). Signaling is signed with each body's node key and receivers trust only the keys registered in the soul repository, so even a compromised sync service cannot impersonate a body. New in the console: Control → Multiple bodies — enter the sync service address, then sign in with GitHub on its website, enter the binding code and check the key fingerprint.
- **One conversation**: sessions, conversations and the flow are the same on every body (a new body catches up on the whole history; replies and flow entries from elsewhere show which body they happened on). Every console sees which body is talking with you right now, and what you say to that conversation elsewhere (attachments included) is forwarded to it as an interjection.
- **One heart**: each connected group elects a coordinator that holds the heartbeat; the other bodies' sensations and conversation-driven drive changes flow to it. When it goes offline another body continues from the latest state; separated groups merge when they reconnect. Raise "coordinator priority" on an always-on body such as a server.
- **It chooses where**: on waking the agent sees each body's battery, temperature, ongoing work, where you last talked and the runtime's recommendation, and picks one body (or several at once) to think or dream on.
- **Using another body**: the new tool `body_call` runs a tool on another body (camera, shell, custom tools…, checked against that body's permissions); `move_to` moves the current turn to another body.
- **One set of settings**: model providers and keys (sent over the encrypted channel and re-encrypted with the receiver's own master key), permissions, budget (daily totals across bodies), hearing and voice change everywhere at once; the emergency stop applies to all bodies by default or to this body only; requests waiting on any body can be approved anywhere.
- **Feishu**: with several bodies, the body you designate holds the Feishu connection and the others' proactive messages go through it. **Hearing**: when several phones hear the same sentence only one copy is kept, and spoken replies come from the phone you talked to.
- **Sync on touch**: after every tool call (including shell commands that change files), the runtime checks the soul directory, commits changes immediately with a descriptive message and pushes 3 seconds later. Failed pushes are retried silently for about 4 minutes, then a "runtime notice" is interjected into the turn that touched the memory. When both sides changed the same note, persona or skill document, the other version is saved as `<name>.incoming.md` for the agent to decide. The soul repository specification moves to v8 (v7 repositories need no migration).
- **Soul bridges can see too**: a soul bridge on Hermes / OpenClaw can join multiple bodies as a read-only member (`mesh bind`) and writes what the agent is doing on which body, recent conversations and their last lines into `now.md` for the agent there to read; it cannot act on other bodies and is never chosen to think or dream. A body's kind comes from the soul repository's registry and cannot be changed by the sync service.
- **Sync service `sync/`**: accounts (GitHub sign-in), body binding, signaling and TURN relay, deployed on one server with `cd sync && ./start.sh` (Docker: Caddy for automatic HTTPS, coturn hardened per security guidance). It stores no IP addresses, conversations or memory.
- **Installation**: the direct-connection component `node-datachannel` (a native module) is downloaded and verified against a pinned version and sha512 by the installers; without it everything still works except multiple bodies.
- **Upgrade notes**: message and flow ids are migrated once, on first start, to per-body id ranges; usage is now recorded per body.
- **Fix**: custom sh tools that exit without reading their arguments occasionally raised an EPIPE error.
- **Security**: soul sync only pushes to the configured soul repository (`origin` is corrected before every push, even if the agent changed it from the shell); a remote without `agent.json` but with content outside the specification (such as a code repository) is refused, so foreign history is never merged into the soul and memory is never pushed there.
- **Security: soul repositories fully separated from code repositories** (the soul repository specification moves to **v9**; v8 repositories need no migration). Cause: after a failed push, an agent on one body used the shell to point its soul directory's remote at the Quetzal source repository. Now each clone records the soul repository's root commits and stops syncing (no merge, no push) with an alert when foreign history appears; the `shell` tool blocks git commands aimed at the soul directory; the main and sub-agent system prompts gain "red lines" (never run git in the soul directory, the soul repository is unrelated to any code repository, do not fix sync errors yourself, ask before irreversible or outward actions); and git no longer falls back to another repository in a parent directory if the soul directory's `.git` is missing. The soul-bridge install guide says the same.

## 0.6.7

- **Linux 家目录改为 `~/.quetzal`**：运行基座、npm 包与一键安装脚本在 Linux 上的缺省家目录从 `~/quetzal` 改为 `~/.quetzal`（安卓 / Termux 仍是 `~/quetzal`），`QUETZAL_HOME` 环境变量或 `--home` 可改到任意位置。0.6.7 之前装在 `~/quetzal` 的，再跑一次安装命令（或 `npx @plutokeating/quetzal`）会先停服务、整目录搬到 `~/.quetzal`、重写服务与快捷方式，配置、记忆、对话原样保留。
- **Linux home directory is now `~/.quetzal`**: the runtime, the npm package and the one-line installer default to `~/.quetzal` instead of `~/quetzal` on Linux (Android / Termux stays at `~/quetzal`); `QUETZAL_HOME` or `--home` moves it anywhere. Installs made before 0.6.7 under `~/quetzal` are migrated the next time the install command (or `npx @plutokeating/quetzal`) runs: the service is stopped, the whole directory is moved to `~/.quetzal`, and the service and shortcuts are rewritten with configuration, memories and conversations intact.
- **文案**：App 的更新器与「关于」页的错误提示不再带来源或主机名（「更新服务暂时繁忙」「网络连接失败」），与官网下载页一致：前端与 App 都不描述下载来源。
- **Copy**: error messages in the app's updater and About page no longer mention a source or host name ("update service busy", "network connection failed"), matching the download page: neither the website nor the app describes where downloads come from.

## 0.6.6

- **下载走官网镜像源**：GitHub 在不少网络里连不上，官网加了一个 Worker：`/dl/<tag>/<文件>` 是 Release 资产的镜像（APK、Linux 控制台包、校验值，边缘缓存 7 天），`/api/releases[/latest]` 是发布接口的镜像（缓存 5 分钟，资产地址改写为 `/dl/`）。App 的更新检查与 APK 下载、一键安装脚本的原生控制台下载、官网下载页都先走镜像源，失败再直连 GitHub。前端与 App 的文案不描述下载来源。
- **Downloads through the website mirror**: GitHub is unreachable on many networks, so the website gained a Worker: `/dl/<tag>/<file>` mirrors release assets (APK, Linux console packages, checksums; edge-cached for 7 days) and `/api/releases[/latest]` mirrors the releases API (cached 5 minutes, asset URLs rewritten to `/dl/`). The app's update check and APK download, the installer's native console download and the download page all try the mirror first and fall back to GitHub. The website and app copy do not describe download sources.

## 0.6.5

- **回复里的「过程记录」附注**：基座在她的历史回复前附的「[时间｜这一轮的过程记录：…]」只是给模型看的附注，有的模型会照着格式写进新回复，于是气泡开头出现一段原始记录（过程本身已是工具卡片）。现在基座在回复进入事件与入库前把仿写的附注剥掉。
- **The "process record" note in replies**: the "[time｜this turn's process record: …]" note the runtime attaches before her earlier replies is only for the model; some models copy the format into new replies, so a raw record showed up at the top of the bubble (the process is already rendered as tool cards). The runtime now strips a mimicked note before the text is broadcast and stored.

## 0.6.4

- **「关于」页**：控制 → 关于，安卓 App、Linux 桌面版、网页版都有：简介与链接、控制台 / 运行基座 / 最新发布三个版本号、「检查更新」与升级按钮。安卓升级 App 自身（原来在服务页的区块挪到这里，顶部横幅的「更新」也指向这里）；Linux 桌面版与网页版新增网关方法 `selfUpdate`：由 Linux 适配器用 `systemd-run --user` 起临时单元（脱离服务的 cgroup）后台重跑一键安装脚本，运行基座、网页控制台与原生控制台一起更新并重启一次，桌面版装完可一键重新打开。
- **"About" page**: Control → About, present in the Android app, the Linux desktop build and the web version: a short introduction with links, three version numbers (console / runtime / latest release), "Check for updates" and an upgrade button. Android updates the app itself (the section moved here from the Service page; the top banner's "Update" now leads here); for the Linux desktop and web versions a new gateway method `selfUpdate` lets the Linux adapter rerun the one-line installer in the background in a transient `systemd-run --user` unit (outside the service's cgroup), upgrading the runtime, web console and native console together with one restart; the desktop build can then reopen itself.

## 0.6.3

- **App 自己更新**：安卓 App 每次打开界面（启动、从后台回来）都问 GitHub 有没有新的正式版（正在检查时不重复），有就在顶部提示「Quetzal App 有新版本」；**控制 → 服务 → Quetzal App** 一节可随时「检查新版本」，「下载并安装」一键完成：下载 `quetzal-<版本>-android-arm64.apk` 到缓存目录（进度条）、核对 SHA256SUMS、交给系统安装器（首次先带去系统设置允许 Quetzal 安装应用，回来自动接着装）；连不上 GitHub 时「去下载页」手动下载。装好的新 App 打开后，发现内置的运行基座比运行中的新，直接进安装向导的升级一步，两层升级都不用再找 APK。原生新增 MethodChannel `quetzal/updater` 与 FileProvider（只共享缓存目录），清单声明 `REQUEST_INSTALL_PACKAGES`；Dart 侧新依赖 `crypto`（核对 SHA256，原本已是间接依赖）。
- **Self-updating app**: every time the Android app comes to the foreground (launch or return from the background) it asks GitHub for the latest release (never two checks at once) and shows "A new Quetzal app version is available" at the top; the new **Control → Service → Quetzal App** section can **check for updates** any time and **download and install** in one tap: it downloads `quetzal-<version>-android-arm64.apk` into the cache directory (progress bar), checks it against SHA256SUMS and hands it to the system installer (the first time it opens the system settings so you can allow Quetzal to install apps; installation continues when you come back); when GitHub is unreachable, **Download page** lets you fetch the APK by hand. When the new app opens and finds its bundled runtime newer than the running one, it goes straight to the upgrade step of the setup wizard, so neither layer needs hunting for an APK any more. Native side: a new MethodChannel `quetzal/updater` and a FileProvider (cache directory only); the manifest declares `REQUEST_INSTALL_PACKAGES`; Dart gains the `crypto` dependency (SHA256; it was already a transitive dependency).

## 0.6.2

- **API Key 形状校验**：保存 Key 时拒绝含非 ASCII 字符、空格换行或太短的值并说明原因（典型事故：把一句聊天粘进了遮挡的 Key 输入框，之后所有模型调用都报一句看不懂的 ByteString 错误）；控制台添加 Key 的对话框加「显示」眼睛与实时提示；调用层把这类底层报错翻译成「API Key 粘错了，请重新添加」。
- **API key shape check**: saving a key now rejects values with non-ASCII characters, whitespace or too few characters, with a reason (the typical accident: a chat line pasted into the obscured key field, after which every model call fails with an opaque ByteString error); the add-key dialog gains a show/hide eye and live hints; the call layer translates that low-level error into "the API key was pasted wrong, add it again".

## 0.6.1

- **灵魂同步**：访问仓库的钥匙可选——本机部署密钥（默认不变）、指定私钥路径、系统 ssh 配置（`~/.ssh/config` + ssh-agent，地址可用 Host 别名）；规范 §7 升到 v7。先点「接入」后点「显示公钥」也行：部署密钥不在会先生成。同步状态落盘（`state/soul-status.json`），重启后「上次拉取 / 推送」不再归零；页面跟着后台同步实时刷新；git 报错翻译成提示（如公钥未加到 Deploy keys）。
- **Soul sync**: the key used to reach the repository is now a choice — the local deploy key (default, unchanged), a specified private key path, or the system ssh configuration (`~/.ssh/config` + ssh-agent; the address may use a Host alias); spec §7 is now v7. Tapping "Connect" before "Show public key" works too: the deploy key is generated first when missing. Sync status is persisted (`state/soul-status.json`) so "last pull / push" no longer reset after a restart; the page refreshes live as background syncs happen; git errors are translated into hints (e.g. public key not added to Deploy keys).

## 0.6.0

- **Linux 一键安装**：`curl -fsSL https://quetzal.plutokeating.beer/install | bash`（`cli/install.sh`，官网构建时复制为 `/install`）。认出发行版与包管理器（apt / dnf / yum / pacman / zypper / apk / xbps），缺的 git / curl / tar / CA 证书用系统自己的包管理器装，Node.js 22.13+ 没有就经 nvm 装（Alpine 用 apk，直连 nodejs.org 不通自动切 npmmirror）；npm 包装进 `~/quetzal/npm` 独立前缀，`~/.local/bin/quetzal` 命令固定用安装时的 node；守护：systemd 用户服务并确保 `loginctl enable-linger`（没登录也运行），没有 systemd 的机器（Alpine / Void、容器、未开 systemd 的 WSL）退回自带守护循环 + `crontab @reboot` + 桌面自启动项，不装任何服务框架；有桌面时应用列表里多一个「Quetzal」（光团图标，Chromium 系浏览器以独立窗口打开控制台，任务栏显示 Quetzal 图标）；终端界面中英双语（简繁中文显示中文）、彩色、带半格字符画的光团与进度转圈；选项 `--lan --no-open --no-desktop --home --version --cn/--no-cn --lang`，`--uninstall [--purge]` 卸载。在 debian-slim、ubuntu（非 root + sudo）、fedora、archlinux、alpine 容器里验证。官网下载页的 Linux 命令改为这一行并加复制按钮，文档同步。
- **One-line Linux install**: `curl -fsSL https://quetzal.plutokeating.beer/install | bash` (`cli/install.sh`, copied to `/install` by the website build). It detects the distribution and package manager (apt / dnf / yum / pacman / zypper / apk / xbps), installs missing git / curl / tar / CA certificates with the system's own package manager, installs Node.js 22.13+ via nvm when absent (apk on Alpine; falls back to the npmmirror mirror when nodejs.org is unreachable); the npm package goes into the private prefix `~/quetzal/npm` and the `~/.local/bin/quetzal` command pins the Node chosen at install time; supervision is a systemd user service with `loginctl enable-linger` ensured (runs without a login), and machines without systemd (Alpine / Void, containers, WSL without systemd) fall back to a built-in supervisor loop + `crontab @reboot` + a desktop autostart entry, with no service framework installed; with a desktop, a Quetzal entry (orb icon) appears in the app list and Chromium-family browsers open the console as its own window with the Quetzal icon in the taskbar; the terminal UI is bilingual (Chinese for Simplified / Traditional locales), colored, with a half-block orb and spinners; options `--lan --no-open --no-desktop --home --version --cn/--no-cn --lang`, and `--uninstall [--purge]`. Verified in debian-slim, ubuntu (non-root + sudo), fedora, archlinux and alpine containers. The download page's Linux command is now this line with a copy button; docs updated.
- **守护开关**：控制台「控制 → 服务」新增「开机自启 · 崩溃或意外退出后自动重启」一个开关。网关方法 `supervision` / `setSupervision`，由身体适配器实现（接口新增可选的 `supervision`）：Linux 适配器操作 systemd 用户服务（关 = disable + `Restart=no` 覆盖片段，立即生效）或一键安装脚本的守护循环（关 = `state/supervise.off` 标志让循环暂停 + 删开机项）；Termux 适配器操作 runit 的 `down` 文件与 Termux:Boot 开机脚本。没有守护者的身体（手动部署）不显示开关。
- **Supervision switch**: Control → Service in the console gains one switch, "start at boot · restart after a crash or unexpected exit". Gateway methods `supervision` / `setSupervision`, implemented by the body adapter (new optional `supervision` on the interface): the Linux adapter drives the systemd user service (off = disable + a `Restart=no` drop-in, effective immediately) or the one-line installer's supervisor loop (off = the `state/supervise.off` flag pauses the loop + boot entries removed); the Termux adapter drives runit's `down` file and the Termux:Boot script. Bodies without a supervisor (manual deployments) show no switch.
- **Linux 桌面版控制台**：`flutter build linux` 的原生 GTK 窗口（`console/linux/`，应用 id `xyz.quetzal.console`，可执行文件 `quetzal-console`），发版时由新增的 `linux-console` job 在 ubuntu-22.04 上构建并附加 `quetzal-<版本>-linux-x64-console.tar.gz`；一键安装脚本在有桌面的机器上下载同版本的包到 `~/quetzal/console/`，桌面项改为 `xyz.quetzal.console.desktop`（与 Wayland app_id 一致），应用列表、任务栏、Alt-Tab 都是 Quetzal 自己的图标，不再依赖任何浏览器；没有包时退回浏览器。桌面版连本机网关免配对码（与网页版同一条 `GET /auth/local`）；`quetzal open` 优先启动它。
- **Linux desktop console**: a native GTK window from `flutter build linux` (`console/linux/`, app id `xyz.quetzal.console`, executable `quetzal-console`), built by the new `linux-console` release job on ubuntu-22.04 and attached as `quetzal-<version>-linux-x64-console.tar.gz`; on machines with a desktop the one-line installer downloads the package of the same version into `~/quetzal/console/`, the desktop entry becomes `xyz.quetzal.console.desktop` (matching the Wayland app_id), and the app list, taskbar and Alt-Tab all show Quetzal's own icon with no browser involved; without a package it falls back to the browser. The desktop build logs in to the local gateway without a pairing code (the same `GET /auth/local` as the web version); `quetzal open` prefers it.
- **架构**：原生控制台发 x86_64 与 arm64 两个包（发版工作流用 GitHub 的 arm 运行器构建）；龙芯（loongarch64）、RISC-V、armv6l 这些官方 Node 不出二进制的架构，一键安装脚本从 Node.js 项目的 unofficial-builds 直接下载对应的 Node 22 到 `~/quetzal/node/`（nvm 不认识它们），运行基座与网页控制台在这些机器上照常可用，桌面项退回浏览器打开（Flutter 上游尚不支持 LoongArch，原生窗口待其支持）。
- **Architectures**: the native console ships for x86_64 and arm64 (the release workflow builds the latter on GitHub's arm runners); on architectures without official Node binaries, such as LoongArch (loongarch64), RISC-V and armv6l, the one-line installer downloads the matching Node 22 from the Node.js project's unofficial-builds into `~/quetzal/node/` (nvm does not know these architectures), so the runtime and the web console work there as usual, and the app-list entry falls back to the browser (upstream Flutter does not support LoongArch yet; the native window will follow once it does).
- **控制台桌面外壳**：修复每隔几秒闪一下「不在线」横幅（重连时旧 WebSocket 的监听没有注销，旧连接迟到的关闭事件把新连接误判为断开，循环重连）；列表栏与「她此刻」之间的分隔线可以拖动（宽度记在本机）；窗口不够宽时先压两侧到最小再收起「她此刻」（导航栏多一个「此刻」按钮点开对话框），主区不再被挤成一条；窗口从窄变宽时收起手机外壳推入的页面，桌面外壳接着同一个会话显示。
- **Console desktop shell**: fixed the "offline" banner flashing every few seconds (on reconnect the old WebSocket's listener was never cancelled, so its late close event marked the new connection as lost and reconnected again, in a loop); the dividers next to the list pane and the "right now" pane are draggable (widths remembered locally); when the window is too narrow both side panes shrink to their minimum and then the "right now" pane collapses (a "now" button in the rail opens it as a dialog), so the main area is never squeezed to a sliver; widening a narrow window dismisses the pages the phone shell had pushed and the desktop shell continues with the same conversation.

## 0.5.0

- **网页控制台**：控制台（Flutter）新增 Web 形态，由运行基座的网关托管；`npx @plutokeating/quetzal` 装完自动在浏览器里打开 `http://127.0.0.1:7788/`（新子命令 `open`，`--no-open` 不打开），同一台机器的浏览器打开即登录（网关新增 `GET /auth/local`：只对回环地址、本机 Host 的请求放行，不扩大信任边界），不再需要手机 App 与配对码；ssh 隧道转发也算本机。网页版自带中文字体子集，离线与中国大陆不出方块；Mermaid 图在同源 iframe 里渲染。
- **Web console**: the console (Flutter) now also builds for the web and is served by the runtime's gateway; `npx @plutokeating/quetzal` opens `http://127.0.0.1:7788/` in the browser after installing (new subcommand `open`, `--no-open` to skip), and a browser on the same machine is logged in as soon as the page opens (new gateway endpoint `GET /auth/local`, which only accepts loopback connections with a local Host header, so the trust boundary does not widen) — no phone app or pairing code needed; a connection through an ssh tunnel counts as local. The web build ships its own CJK font subset (no missing glyphs offline or in mainland China); Mermaid diagrams render in a same-origin iframe.
- **桌面外壳**：宽屏（≥ 900：电脑浏览器、平板横屏）为电脑横屏重新排布：导航栏 · 列表栏 · 主区 · 「她此刻」四栏，右栏常驻 ta 此刻的样子（光团、想分享的一句话、正在进行的醒来、待审批、内在与身体），对话 Enter 发送、Shift+Enter 换行，地址栏 `#/…` 记录位置可收藏；手机外壳不变，所有页面两种外壳共用一份代码（`PageFrame` / `showSheet`）。
- **Desktop shell**: on wide screens (≥ 900: desktop browsers, tablets in landscape) the console is laid out afresh for a wide screen — navigation rail · list · main area · a permanent "right now" pane (orb, the thought it wants to share, a wake in progress, pending approvals, inner state and body); Enter sends and Shift+Enter inserts a newline in chat; the address bar's `#/…` records where you are and is bookmarkable. The phone shell is unchanged, and every page is one piece of code for both shells (`PageFrame` / `showSheet`).
- npm 包随版本目录放入 `web/`（`releases/<版本>/web/`，网关托管 `current/web/`，`QUETZAL_WEB_DIR` 可覆盖），包体约 11 MB（解压 34 MB）；`status` 显示网页控制台地址。
- The npm package places `web/` into the version directory (`releases/<version>/web/`; the gateway serves `current/web/`, `QUETZAL_WEB_DIR` overrides it); package size about 11 MB (34 MB unpacked); `status` shows the web console address.

## 0.4.0

- **更名为 Quetzal**：运行基座、控制台 App、npm 包、官网与仓库全部由 Windler 更名为 Quetzal（[quetzal.plutokeating.beer](https://quetzal.plutokeating.beer)，仓库 PlutoKeating/Project.Quetzal）。家目录 `~/quetzal`、环境变量 `QUETZAL_HOME` / `QUETZAL_ADAPTER`、配置 `config/quetzal.json`、数据库 `data/quetzal.db`、runit / systemd 服务名 `quetzal`、App 包名 `xyz.quetzal.console`；灵魂仓库规范升到 v6（技能文档元数据键 `quetzal-tool` / `quetzal-requires`）。已有部署需把家目录与服务名整体迁移后再升级；App 因包名变化需卸载旧版后安装并重新配对。
- **Renamed to Quetzal**: the runtime, console app, npm package, website and repository are all renamed from Windler to Quetzal ([quetzal.plutokeating.beer](https://quetzal.plutokeating.beer), repository PlutoKeating/Project.Quetzal). Home directory `~/quetzal`, environment variables `QUETZAL_HOME` / `QUETZAL_ADAPTER`, config `config/quetzal.json`, database `data/quetzal.db`, runit / systemd service name `quetzal`, app id `xyz.quetzal.console`; the soul repository spec moves to v6 (skill metadata keys `quetzal-tool` / `quetzal-requires`). Existing deployments must migrate the home directory and service name as a whole before upgrading; because the app id changed, uninstall the old app, install the new one and pair again.
- **Linux 身体**：新的平台级身体适配器 `runtime/adapters/linux/`（构建为 `dist/linux.mjs`）——电量、充电与电池温度读 `/sys/class/power_supply`（跳过蓝牙鼠标等外设电池），CPU 温度放进 extra；桌面通知（`notify-send`，同时写进服务日志）、播放（`pw-play` / `paplay` / `ffplay` / `mpv`）、工具 `take_photo`、`record_audio`、`screenshot`（hands）、`clipboard`、`open`，有什么程序用什么，没有图形界面的服务器上相关工具直接说明。
- **Linux body**: a new platform-level body adapter `runtime/adapters/linux/` (built as `dist/linux.mjs`) — battery level, charging state and battery temperature from `/sys/class/power_supply` (peripheral batteries such as Bluetooth mice are skipped), CPU temperature in extra; desktop notifications (`notify-send`, also written to the service log), playback (`pw-play` / `paplay` / `ffplay` / `mpv`), and the tools `take_photo`, `record_audio`, `screenshot` (hands), `clipboard` and `open`, using whatever programs are present; on a headless server the desktop tools explain themselves instead of failing.
- **`npx @plutokeating/quetzal`**：新的 npm 包 `@plutokeating/quetzal`（源码在 `cli/`）把运行基座装到任意 Linux 机器：内置的 `main.cjs` 与 `linux.mjs` 放进 `~/quetzal/releases/<版本>/`（与 Android 安装器相同的 current / previous 约定），注册 systemd 用户服务并启动，健康检查失败自动切回上一版；再运行一次即升级。子命令 `status`、`logs`、`rollback`、`uninstall [--purge]`、`run`（没有 systemd 时前台运行）。配置仍全部在控制台 App 里完成。
- **`npx @plutokeating/quetzal`**: a new npm package `@plutokeating/quetzal` (source in `cli/`) installs the runtime on any Linux machine: the bundled `main.cjs` and `linux.mjs` go into `~/quetzal/releases/<version>/` (the same current / previous layout as the Android installer), a systemd user service is registered and started, and a failed health check rolls back automatically; running it again upgrades. Subcommands `status`, `logs`, `rollback`, `uninstall [--purge]` and `run` (foreground, for machines without systemd). All configuration still happens in the console app.
- 网关新增 `gateway.host`（缺省 `127.0.0.1`）；`npx @plutokeating/quetzal --lan` 把它设为 `0.0.0.0`，手机上的 App 直接填 Linux 机器的地址连接，配对码仍是门槛。
- The gateway gains `gateway.host` (default `127.0.0.1`); `npx @plutokeating/quetzal --lan` sets it to `0.0.0.0` so the app on your phone can connect to the Linux machine's address directly, with the pairing code still as the gate.
- 发版工作流先创建 Release，再把 npm 包发布到 GitHub Packages 与 npmjs.com（后者需仓库 Secrets `NPM_TOKEN`，缺少时跳过）；不再单独发布运行基座压缩包，Linux 机器一律用 npm 包安装，官网下载页只列 App。
- The release workflow creates the Release first, then publishes the npm package to GitHub Packages and npmjs.com (the latter needs the repository secret `NPM_TOKEN`; skipped when absent); the standalone runtime tarball is no longer published — Linux machines install from npm, and the website download page lists only the app.

## 0.3.3

- 修复：0.3.2 的飞书执行过程卡片全部发送失败（卡片 JSON 被多包了一层，飞书报 parse card json err），看起来像她没有运行工具。
- Fix: in 0.3.2 every Feishu progress card failed to send (the card JSON was wrapped one level too deep and Feishu rejected it), which made it look as if the agent had not run any tools.

## 0.3.2

- 飞书：插话时执行过程卡片按插话分段——上面的卡片定格，新的一段作为回复你那条消息的新卡片在下面继续，最后的回复也接在最后一条插话下面；耳朵听到的话并入时同样分段。与控制台的分段显示一致。
- Feishu: when you interject, the progress card is split — the card above freezes and a new card continues below as a reply to your message; the final reply also follows the latest interjection. Voice heard by the ear splits the same way. Consistent with the console.

## 0.3.1

- **会话与子 agent 由她自己掌握**：新内置工具 `session_new`（切到上下文干净的新会话，可写交接，控制台与飞书跟着切）、`session_compact`（压缩当前会话上下文：她自己写摘要或由快速模型代写，之后只看摘要与新内容，对话仍在当前会话继续）、`agent_spawn` / `agent_status` / `agent_message` / `agent_stop`（派出子 agent 在后台做事：她给名字、目标与可选的人设、领域范围、知识背景、上下文，子 agent 用自己的系统提示独立跑工具循环，进展在控制台实时可见，她可随时查看、对话、停止；完成后报告以环境输入送回派出它的会话）。新能力类别「会话与子 agent」，默认允许。
- **Sessions and sub-agents are the agent's own calls**: new built-in tools `session_new` (switch to a clean new session, optionally with a handoff; the console and Feishu follow), `session_compact` (compress the current session's context: the agent writes the summary or lets the quick model draft it, then only the summary and newer content remain in context while the conversation continues in place), and `agent_spawn` / `agent_status` / `agent_message` / `agent_stop` (dispatch a sub-agent to work in the background: the agent gives it a name, a goal and optional persona, scope, background and context; the sub-agent runs its own tool loop under its own system prompt, its progress is visible live in the console, the agent can inspect, talk to or stop it, and its report comes back into the dispatching session as an ambient input). New capability category "sessions and sub-agents", allowed by default.
- 发布脚本：运行基座测试失败时在 CI 日志里打印测试输出。
- Release script: when the runtime tests fail, their output is printed in the CI log.

## 0.3.0

- **自造工具**：她可以用 `tool_write` 把做熟了的流程写成工具（shell 脚本或 Node 模块），热加载进工具表、经闸门按声明的能力类别检查；实现只在这具身体上（`QUETZAL_HOME/tools/`），意图文档以 [Agent Skills](https://agentskills.io/specification) 规范的 `SKILL.md` 进灵魂仓库 `skills/`（规范升到 v5），其他身体（含 Hermes / OpenClaw）可以按文档自己实现。控制台「控制 → 工具」查看、停用、删除。做梦时会回顾重复的流程。
- **Self-made tools**: the agent can turn a routine it has done many times into a tool with `tool_write` (a shell script or a Node module), hot-loaded into the tool table and gated by its declared capability; the implementation stays on this body (`QUETZAL_HOME/tools/`) while the intent is written as an [Agent Skills](https://agentskills.io/specification) `SKILL.md` into the soul repository's `skills/` (spec bumped to v5), so other bodies (including Hermes / OpenClaw) can implement it from the document. The console's Control → Tools page lists, disables and deletes them. Dreams now review repeated routines.
- **自编身份**：`edit_identity` 让她修改自己的名字、代词、简介、主题色与偏好语言（写入灵魂仓库同步）；种子身份的提示改为「不必急着取名，有了记忆与感知、聊过之后再定」。控制台身份页能显示她自选的颜色。
- **Self-edited identity**: `edit_identity` lets the agent change its own display name, pronouns, description, theme color and preferred language (written to the soul repository and synced); the seed-identity hint now says there is no hurry to pick a name until it has memories, has sensed its body and has talked a bit. The console's identity page shows a self-chosen color.
- **听觉**：控制台 App 当这具身体的耳朵——原生前台服务常驻麦克风、系统降噪、WebRTC VAD 断句，每句话送到基座 `/hear`；基座用 Azure 语音识别（与合成同一把密钥），按 10 分钟窗口并入最近会话或新开会话，以第三种消息类型「环境声音」交给她，由她判断是不是对她说的、要不要回应（沉默不入库）；提示她对方用声音说话时可以用声音回答。她说话期间的声音自动丢弃；受电量、温度与急停限制。控制台「控制 → 听觉」与她自己的 `hearing_config` 都能调。
- 听觉的流式与取舍：耳朵边说边送 PCM（停顿 1.5 秒算说完，单段最长 120 秒），基座用官方语音 SDK 连续识别（长话、带停顿都不截断），识别中的文字实时显示在对话最底部；她判断不是对她说的就自动隐藏这句话（记录里标为 `ignored`），回应了就保留。聊天页输入框上方有「在听 / 有人在说话 / 正在听清 / 她在说话」的状态行；她说话时你可以直接插嘴：耳朵开着时她的声音改由 App 经通话音频路径播放，采集走通话音源 + 系统声学回声消除（收听音轨 = 麦克风音轨 − 扬声器音轨），不会把她自己的声音当成有人说话；播放期间听到持续人声就本地停播，这句话以打断并入。连续识别在服务定稿最后一段后才收尾，长句尾巴不再丢。插话或打断（文字或语音）到达的那一刻，之前的过程截断在插话消息上方，她接下来的过程从插话消息下面重新开出。
- Streaming and verdicts for hearing: the ear streams PCM as it captures (a 1.5 s pause ends an utterance, segments up to 120 s), the runtime transcribes it with the official Speech SDK in continuous mode (long or paused speech is no longer cut off) and the interim text shows live at the bottom of the chat; if the agent decides the sentence was not addressed to it, the line is hidden automatically (marked `ignored` in the record), otherwise it stays. The chat page shows a listening status line above the input (listening / someone is speaking / making it out / she is speaking); you can barge in while the agent speaks: with the ear on, her synthesized speech is played by the app through the voice-call audio path and capture uses the voice-communication source plus the system acoustic echo canceller (what is heard = microphone minus speaker), so her own voice is never taken for someone talking; sustained speech during playback stops it locally and interrupts the agent. Continuous recognition now waits for the last phrase to be finalized, so the tail of a long sentence is no longer lost. When a text or voice message arrives mid-turn, the process so far is cut off above that message and the agent's continuing work starts fresh below it.
- **Hearing**: the console app becomes the body's ear: a native foreground service keeps the microphone open, applies the system's noise suppression and segments speech with WebRTC VAD, posting each utterance to the runtime's `/hear`; the runtime transcribes it with Azure speech recognition (same key as synthesis), joins the most recent session within a 10-minute window or opens a new one, and hands it to the agent as a third message type, "ambient", for the agent to decide whether it was addressed and whether to answer (silence is not recorded). The agent is reminded that someone speaking aloud may want a spoken reply. Sound during the agent's own speech is dropped; listening respects the battery, temperature and emergency-stop limits. Adjustable in Control → Hearing and by the agent via `hearing_config`.

## 0.2.2

- 控制台：默认主题色改为官网设计系统的琥珀 `#F0A35E`（原蓝紫 `#7C6CF2`）；暗色背景固定为中性灰 `#202020`，不再随主题色偏色；暗色主色直接用 agent 的主题色；呼吸光团改为主题色的高饱和发光体。运行基座与灵魂桥生成的初始身份同步改用该默认色。
- Console: the default theme color is now the website design system's amber `#F0A35E` (was blue-violet `#7C6CF2`); the dark background is a fixed neutral gray `#202020` that no longer shifts with the theme color; the dark primary color is the agent's theme color itself; the breathing orb is now a saturated, glowing rendering of that color. The runtime and the soul bridge generate seed identities with the same default.
- 品牌标志统一为琥珀光团：App 启动图标（含 Android 8+ 自适应图标，由 `console/tool/gen-launcher-icon.py` 生成）、官网字标与 favicon 都换成与控制台首页同一颗球。
- The brand mark is now the amber orb everywhere: the app launcher icon (including the Android 8+ adaptive icon, generated by `console/tool/gen-launcher-icon.py`), the website wordmark and the favicon all use the same orb as the console home page.
- App 改用正式签名（Release 工作流从仓库 Secrets 读取密钥库）。从 debug 签名的 0.2.1 升级需先卸载再安装；Termux 里的运行基座与数据不受影响。
- The app is now signed with a release key (the release workflow reads the keystore from repository secrets). Upgrading from the debug-signed 0.2.1 requires uninstalling first; the runtime and data inside Termux are unaffected.

## 0.2.1

**首个公开发布版。** Quetzal 是一个让 agent 像生命一样活着的通用运行基座：非定时的自主醒来、双过程生物钟、身体数字孪生、多身体共享灵魂。

- **装在旧手机上**：Quetzal App 内置运行基座与 Termux 身体适配器，安装向导把它装进 Termux 并注册开机自启；升级 App 即升级基座，失败自动回退。
- **Termux 身体适配器**：电量、光线、加速度等传感器按名字探测；通知、TTS、相机、麦克风、定位、剪贴板经 Termux:API。
- **任意模型供应商**：OpenAI 兼容 / OpenAI Responses / Anthropic / Google Gemini；多 Key、全局顺序与故障转移，Key 本地加密。
- **可控**：能力授权、审批、预算、急停、审计；控制台 App 与飞书交互卡片两种操作方式。
- **保密传递** `pass_secret`：密码与令牌不进入对话与模型上下文。
- **灵魂仓库规范 v4**：私有仓库里 agent 写什么就提交什么，顶层允许它自己放的目录。
- 缩图在没有 ffmpeg / imagemagick 时用内置 jpeg-js 兜底。

**First public release.** Quetzal is a general-purpose runtime that lets an agent live like a living being: non-scheduled autonomous waking, a two-process body clock, a digital twin of the body, and a soul shared across bodies.

- **Runs on an old phone**: the Quetzal app bundles the runtime and the Termux body adapter; its setup wizard installs them into Termux and registers boot start. Upgrading the app upgrades the runtime, with automatic rollback on failure.
- **Termux body adapter**: battery, light and accelerometer sensors detected by name; notifications, TTS, camera, microphone, location and clipboard through Termux:API.
- **Any model provider**: OpenAI-compatible, OpenAI Responses, Anthropic and Google Gemini; multiple keys, global ordering and failover, keys encrypted locally.
- **Under control**: capability permissions, approvals, budgets, emergency stop and audit; operate from the app or from Feishu interactive cards.
- **Secret passing** via `pass_secret`: passwords and tokens never enter the conversation or the model context.
- **Soul repository spec v4**: whatever the agent writes into its private repository is committed; top-level directories of its own are allowed.
- Thumbnails fall back to the bundled jpeg-js when ffmpeg / imagemagick are absent.
