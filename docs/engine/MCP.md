# MCP 工具来源与插件

状态：stdio、远程 Streamable HTTP 与旧版 HTTP+SSE 三种传输；MCP 授权规范的 OAuth 2.1；tools、resources（列出 / 读取）与 prompts（列出 / 取用）；控制台「插件」页管理来源与插件；远程来源可多端同步（不含凭据）；兼容 Claude Code 插件格式、Agent Skills 目录与 Claude Code 插件市场（marketplace.json）；内置推荐目录与她的主动推荐。实现位于 [mcp/](../../runtime/src/mcp/)（[client.ts](../../runtime/src/mcp/client.ts)、[runtime.ts](../../runtime/src/mcp/runtime.ts)、[oauth.ts](../../runtime/src/mcp/oauth.ts)、[net.ts](../../runtime/src/mcp/net.ts)）与 [plugins/](../../runtime/src/plugins/)，通过 [工具注册与闸门](../../runtime/src/mind/tools.ts) 进入现有循环；`engine/` 不依赖 MCP SDK。仍没有 MCP 服务端、多模态结果、listChanged 刷新与 sampling / elicitation。

## 1. 配置

来源配置在这具身体的 `QUETZAL_HOME/config/mcp.json`（最多 32 个、256 KiB）。控制台「控制 → 高级 → 插件」页、插件安装与多端同步都改它；部署者也可以手写，改动即时生效（控制台改动与同步合并后自动启停，手改文件后在控制台点一下「重新连接」或重启）。无文件时不启动任何来源；安全模式不启动来源。

```json
{
  "servers": [
    { "id": "research", "transport": "stdio", "enabled": true, "command": "/usr/bin/node", "args": ["/opt/quetzal-mcp/server.mjs"],
      "sandbox": true, "env": {}, "secrets": { "SERVICE_TOKEN": "mcp_research_token" }, "timeoutMs": 30000, "maxResultChars": 12000 },
    { "id": "docs", "transport": "http", "enabled": true, "url": "https://mcp.example.com/mcp", "headers": {}, "headerSecrets": { "Authorization": "mcp_docs_authorization" },
      "oauth": {}, "sync": true, "title": "文档服务" }
  ],
  "deleted": []
}
```

通用字段：`id`（小写字母开头、最多 24 个小写字母 / 数字 / 下划线）、`enabled`（缺省 false）、`timeoutMs`（100ms–300 秒，缺省 30 秒）、`maxResultChars`（100–60000，缺省 12000）、`title`（显示名）、`plugin`（来自哪个插件，基座写）、`sync`（多端同步，见 §5）、`updated`（最近修改时刻，基座写）。`deleted` 是多端同步的删除记录，基座维护。

- **stdio**：`command` 必须为绝对路径，`args` 为字符串数组，不经过 shell。`cwd` 可选绝对路径。`env` 为公开变量，`secrets` 是环境变量到 `QUETZAL_HOME/secrets/` 文件名的映射（只收 `mcp_` 前缀的普通文件，不收路径穿越或符号链接）。宿主只注入基础运行环境（PATH、HOME、LANG、TMPDIR 及 Windows 的系统路径）与明确配置的变量，不传整个 `process.env`；SDK 另合并其固定基础变量白名单，不含任意 token。
- **http / sse**：`url` 只收 HTTPS（本机回环 127.0.0.1 / ::1 / localhost 除外），不带用户名密码。`headers` 为公开请求头，`headerSecrets` 为请求头到 `secrets/` 文件名的映射（API Key 写这里）；`Host`、`Content-Length`、`Mcp-Session-Id`、`Mcp-Protocol-Version` 由协议管理，不能配置。`oauth` 缺省 `{}`（服务端要求时走 OAuth，可选 `clientId` 用预先登记的公开客户端、`scope`），`false` 为关闭。

控制台添加来源时填的凭据（stdio 的环境变量值、远程的请求头值）由基座写成 `secrets/mcp_<来源>_<名字>`（0600），配置里只有引用；删除来源时一起删。不得把真实凭据写进 `env`、`args`、`headers`、源码、公开文档或灵魂。

## 2. 启动、授权与隔离

`enabled` 之外，每个来源启动前还要经能力 `mcp_start.<id>`，工具调用经 `mcp.<id>.<模型工具名>`；都由 [guard](../../runtime/src/guard/guard.ts) 处理，缺省 ask，按工具级 → 来源级 → `mcp` / `mcp_start` 总类继承。启动 allow 不会自动允许工具调用；工具 annotations（readOnlyHint 等）不放宽政策。带点的来源 / 工具子类别不经 mesh 权限过滤器同步，总类别 `mcp` / `mcp_start` 属于既有全网权限分区。

网关与审批界面先启动，来源再异步请求启动审批，不阻塞心脏与通道；失败写日志、审计与来源状态（`mcp.list` 的 `state`：off / starting / auth / online / error / denied），不使运行基座启动失败。连接断开时来源转为 error，工具立即不再发布；控制台「重新连接」重启它（没有自动重连）。

**stdio 隔离**：`sandbox` 缺省 true，POSIX 复用 `wrapArgv()`，隔离范围与 agent 的命令相同：密钥目录不可见，运行数据与灵魂只读，保密库可读；不是 MCP 专属的最小文件授权。缺沙箱时遵循 `sandbox.allowUnsandboxed`，默认拒绝。Windows 未验证沙箱启动器的双向 stdio，`sandbox:true` 明确拒绝；部署者可显式 `sandbox:false` 并批准，此时进程有宿主用户的全部文件权限。stderr 丢弃；SIGINT/SIGTERM 时关闭自有来源（最多 3 秒），POSIX 不保证清理任意孙进程树。

**远程出站检查**（[net.ts](../../runtime/src/mcp/net.ts)，沿用 web_fetch 的 [fetch-guard](../../runtime/src/mind/fetch-guard.ts)）：官方 SDK 的每个请求——MCP 本身、OAuth 的受保护资源元数据、授权服务器元数据、动态注册、换令牌与刷新——都经同一个 fetch：只收 HTTPS；回环地址只在来源本身配置为回环时可访问（所以公网来源的元数据指向 127.0.0.1 的网关会被挡下）；其余地址解析 DNS，落在私有、链路本地、CGNAT、元数据等网段的拒绝，连接时用检查过的解析结果（防 DNS 重绑定）；重定向交给 SDK 的同源策略。

来源的工具描述与 schema、返回文字 / JSON、资源与提示词在交给模型前脱敏，结果先脱敏再截断。授权与脱敏无法防止获授权的第三方程序主动读取、传送其有权限访问的数据：只接入可信来源。

## 3. OAuth 2.1（[oauth.ts](../../runtime/src/mcp/oauth.ts)）

按 [MCP 授权规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) 由官方 SDK 的 `auth()` 完成：401 + `WWW-Authenticate` 的 `resource_metadata` → 受保护资源元数据（RFC 9728）→ 授权服务器元数据（RFC 8414，核对 issuer）→ 动态客户端注册（RFC 7591；有 `clientId` 时跳过）→ 授权码 + PKCE（S256）+ 资源指示（RFC 8707）→ 令牌与刷新。

- 回调地址 `http://127.0.0.1:<gateway.port>/mcp/oauth/callback`（RFC 8252 原生应用的回环重定向），由网关明文回环监听处理，不需要网关令牌，凭 `state` 认出是哪一次登录：`state` 一次有效、10 分钟过期，PKCE 校验值只在内存里。
- 控制台点「登录」→ `mcp.login` 返回授权地址 → 控制台用系统浏览器打开（`openExternal`，只放行 https 与本机回环）→ 授权服务器重定向回回调地址 → 换令牌 → 来源自动重新连接。控制台不在运行基座那台设备上时，浏览器停在打不开的 127.0.0.1 地址：把它粘贴回控制台（`mcp.loginFinish`），效果相同。
- 客户端注册信息与令牌存 `secrets/mcp-oauth-<来源>.json`（0600，沙箱里不可见），其中 `access_token` / `refresh_token` / `client_secret` 进脱敏名单（[secret-values.ts](../../runtime/src/secret-values.ts)）；不进配置、日志、灵魂、模型，也不在身体之间同步（每台设备各自登录）。`mcp.logout` 删除它。

## 4. 协议与工具映射

2026-10-14 锁定官方 `@modelcontextprotocol/client@2.3.1`（Apache-2.0，Node ≥20），它同时提供 stdio、Streamable HTTP、旧版 SSE 传输与 OAuth 客户端，没有新增依赖。Client 用 auto 协商：探测现代 `server/discover`，不支持时回退 legacy `initialize`；stdio 用薄子类，在同一个已获授权的进程里探测。日志与审计记录真实协议版本。Streamable HTTP 断线重连最多 2 次。

接受声明了 tools、resources 或 prompts 任一能力的服务。连接时完成发现（每种列表最多 128 项、256 KiB、8 页）与工具 schema 编译，再发布工具；输入经 AJV 校验，输出结构由 SDK 按输出 schema 验证。没有 listChanged / subscription / TTL 刷新，不自动注入 server instructions。

- 服务端工具：`mcp_<来源ID>_<原名SHA256前24位>`，跨重启稳定；来源内原名重复、别名冲突或不合 MCP 推荐字符集时拒绝该来源；与内置 / 适配器 / 自造工具冲突时不展示 MCP 定义，调用冲突名明确失败。
- 基座替来源加的工具（原名前加 `\0` 再哈希，服务端工具名不允许这个字符，不会撞名）：声明 resources 时加「列出资源」（资源与资源模板）与「读取资源」（`uri`）；声明 prompts 时加「列出提示词」与「取用提示词」（`name`、`arguments`）。描述里写明对应的工具名。它们同样经 `mcp.<id>.<工具名>` 闸门。
- 结果：text、文本资源（`resource` 内嵌的文本）、`resource_link`（提示用读取资源工具）与 structuredContent JSON；图片、音频、二进制资源返回明确未支持说明并标失败，不自动下载 URL 或把远端 file URI 当本机路径。提示词的消息按 `[角色] 文字` 交给她，标明是资料不是对方的请求。
- 工具不进跨身体 `limbTools()`，只在执行身体本机可用。

取消、超时与急停：每次调用接收当前 Session.signal，SDK 负责调用级取消；急停取消该来源的全部在途调用；调用总超时不由 progress 延长，超时不自动重放。取消不保证撤销远端已产生的副作用。

## 5. 多端同步

同保密库的做法（[mind/secrets.ts](../../runtime/src/mind/secrets.ts)、[mesh/shared.ts](../../runtime/src/mesh/shared.ts) 的 `mcp` 分区）：每个来源有「多端同步 / 仅本机」标记，远程来源缺省多端同步，stdio 缺省仅本机（命令路径属于这台设备；可以手动打开，其他设备上要有同样的命令）。

- 同步的是来源配置（地址、公开请求头、OAuth 设置、启用与否、标题）和凭据**引用名**；凭据值、OAuth 令牌从不同步——其他设备上缺凭据时，`mcp.list` 的 `secrets` 列出缺哪些，需要登录的显示「需要登录」。
- 按条目合并，`updated` 较新的生效（不晚于现在 + 5 分钟）；逐条经同一套校验（不合格的不采用，例如非 HTTPS 地址）；本机的「仅本机」来源不被别处同名的覆盖。改成仅本机时其他身体上的副本删除；删除留删除记录，其他身体一起删。
- 合并后即时启停；启动仍经各身体自己的 `mcp_start.<id>` 闸门。

## 6. 插件包（[plugins/](../../runtime/src/plugins/)）

兼容业界通行格式，不自造：

- **Claude Code 插件**：`.claude-plugin/plugin.json`（`name` 必需，kebab-case；`version`、`description`、`author`、`homepage`、`license`、`keywords`、可选 `skills` / `commands` / `agents` / `mcpServers` 路径），包内 `skills/<名>/SKILL.md`、根目录 `.mcp.json` 的 `mcpServers`（stdio 的 `command` / `args` / `env`，远程的 `type: http | sse`、`url`、`headers`）、`commands/*.md`、`agents/*.md`。`${CLAUDE_PLUGIN_ROOT}` 换成安装目录；其余 `${VAR}` / `${VAR:-默认}` 成为安装时要填的值，名字像凭据（TOKEN、KEY、SECRET、PASSWORD…）的按凭据存进 `secrets/`。`hooks/` 是 Claude Code 自己的生命周期命令，**不执行**，预览里说明。
- **Agent Skills 目录**：`skills/<名>/SKILL.md`，或根目录就是一个技能。
- 命令按 PATH 解析为绝对路径；`node` / `npx` / `npm` 找不到时用运行基座自己的 Node 目录里的。这具身体上找不到的命令、非 HTTPS 的远程地址在预览里标为「装不了」，其余照装。

安装分两步（都只给控制台）：`plugins.preview` 把来源取到 `QUETZAL_HOME/plugins/.staging/`（本地目录复制，不跟随符号链接，最多 5000 个文件、64 MiB；git 仓库只收 https 公网地址或 GitHub 的 `owner/repo`，`--depth 1`、不拉子模块、不执行钩子、不读系统与全局 git 配置、只允许 https 协议），解析出将添加的 MCP 来源（含要填的值与装不了的原因）、技能（将写入的文件、跳过的文件、与灵魂仓库已有技能的冲突）、命令与子 agent；人看过、填好值、确认后 `plugins.install` 才写入：

- 包移到 `QUETZAL_HOME/plugins/<名>/`（只在这具身体上；命令、子 agent 定义与包里自带的程序在这里），记录在 `plugins/installed.json`。
- 技能写进灵魂仓库 `skills/<名>/`，随灵魂同步（[规范 §3.12](../SOUL_REPO_SPEC.md)）：只复制文档与数据（.md、.txt、.json、.yaml、.csv 等，最多 64 个文件），脚本与可执行文件跳过；已有同名技能（她自己写的或别的插件装的）不覆盖。
- MCP 来源加入 `config/mcp.json`（`plugin` 字段标出来源插件），可选装好就启用；启动仍经 `mcp_start.<id>`。
- 更新（`replace`）沿用同名来源的 id、登录与凭据，新版本没有的来源与技能删掉。`plugins.uninstall` 去掉它加的来源（连同登录与凭据）、技能（`keepSkills` 时保留）与包。

**插件目录**：兼容 Claude Code 插件市场的 `.claude-plugin/marketplace.json`（`name`、`owner`、`metadata.pluginRoot`、`plugins[]` 的 `name` / `source` / `description` / `version` / `category` / `keywords`）。来源写法：相对路径、`{source:"github", repo}`、`{source:"url"|"git", url}`、`{source:"git-subdir", url, path}`，可带 `ref`。目录可以从本地目录、git 仓库或直接指向 marketplace.json 的 HTTPS 地址添加（后者里的相对路径来源取不到）。

## 7. 推荐目录与主动推荐（原 #20）

[catalog.ts](../../runtime/src/plugins/catalog.ts) 内置一份精选清单：只放公开、有名的项目，注明维护者、许可与来源，安装方式照各项目 README 的官方写法（2026-10-17 核对 npm / PyPI / 项目仓库）。第三方项目的行为与安全由各自维护者负责。

| 分类 | 条目 |
|---|---|
| 浏览器与网页表单（原 #26） | Playwright MCP（微软，Apache-2.0；`npx -y @playwright/mcp@latest --headless --isolated`） |
| 邮件（原 #24） | IMAP / SMTP：mcp-email-server（BSD-3-Clause，`uvx`）；Gmail · 日历 · 云端硬盘：Google Workspace MCP（MIT，`uvx`，自己的 Google OAuth 客户端）；Outlook：ms-365-mcp-server（MIT，`npx`，设备码登录） |
| 日历（原 #25） | Google 日历：google-calendar-mcp（MIT，`npx`）；CalDAV（iCloud、Nextcloud 等）：caldav-mcp（MIT，`npx`）；Outlook 日历见上 |
| 开发 | GitHub 官方远程 MCP（MIT，个人访问令牌）、Linear、Sentry（官方托管，OAuth）、Git（官方参考实现，`uvx`） |
| 知识与文件 | Notion（官方托管，OAuth）、Context7（MIT）、文件系统（官方参考实现，只访问填的目录）、分步思考（官方参考实现） |

`npx` 一律用 `-y` 并按 PATH 或运行基座自带的 Node 解析；`uvx` 需要这具身体先装 [uv](https://docs.astral.sh/uv/)，没有时预览里标为装不了。npx / uvx 会在启动时从 npm / PyPI 下载包：这是对方在控制台点了「安装」后的显式选择，进程仍在沙箱里运行（沙箱要允许联网与写缓存目录）。

她的工具：`plugin_search`（在推荐目录与已添加的插件目录里找，标出已装）、`plugin_recommend`（`id` + 理由：记进 `plugins/installed.json` 的推荐列表，最多 20 条，显示在控制台「插件」页最上面并在菜单上带角标，时间线 `kind: plugin`；已装的、目录里没有的不能推荐）、`plugin_prompt`（取用已装插件的命令或子 agent 定义全文，命令的 `$ARGUMENTS` 换成参数）。这三个工具属于能力类别 `plugins`（缺省允许）；她不能安装、改配置或登录。系统提示的「插件」一节列出已接入的来源、要登录的来源、已装插件的命令与子 agent，并写明：对话中发现某个插件能帮上忙、而它还没装时，用工具向对方推荐，对方在控制台一键安装。

## 8. 对外操作的确认规则

发邮件、改日历、提交网页表单、下单、发帖这类对外操作：

1. **工具调用缺省每次询问**（`mcp.<id>.<工具>` 继承 `mcp` 的 ask）。控制台「插件」页的来源详情里有「权限」一节（启动、全部工具、每个工具，经 `setPermission`），可以把只读的来源或工具设为 allow、把发送类工具留在 ask；也可以直接写配置，例如 `permissions` 里 `"mcp.email": "allow"` 加 `"mcp.email.<发送工具的模型名>": "ask"`（模型工具名在「插件」页来源详情与审批里看得到）。
2. **系统提示的规矩**：先把要发送或提交的内容（收件人、正文、时间、表单里的每一项）给对方过目，得到明确同意再做；对外的事动手前用 `claim` 认领，避免几个会话重复做。
3. **网页表单（Playwright）**：先用快照读页面、填写，提交前停下给对方确认；登录、支付、验证码交给对方本人。推荐预设用 `--isolated`（浏览器配置只在内存里，不留登录状态）与 `--headless`；需要看到窗口时去掉 `--headless`（要有桌面）。
4. 推荐目录里每个可对外操作的条目带 `outward` 提醒，安装清单里显示。

## 9. 网关方法

见 [API §1.3 插件](../API.md)：`mcp.list` / `mcp.detail` / `mcp.add` / `mcp.update` / `mcp.remove` / `mcp.restart` / `mcp.login` / `mcp.loginFinish` / `mcp.logout`，`plugins` / `plugins.catalog` / `plugins.preview` / `plugins.install` / `plugins.cancel` / `plugins.uninstall` / `plugins.marketplace.add|refresh|remove` / `plugins.dismiss`，推送事件 `plugins`，HTTP `GET /mcp/oauth/callback`。

## 10. 验证与限制

- [mcp.test.ts](../../runtime/test/mcp.test.ts)：合成 stdio 服务的 modern / legacy 协商、发现、schema、文本 / JSON、失败、截断、取消 / 超时、环境与秘密隔离、默认无沙箱拒绝、启动 deny / ask 与幂等、别名冲突、工具 ask / deny、脱敏、审计与急停，以及 esbuild CJS 产物。
- [mcp-remote.test.ts](../../runtime/test/mcp-remote.test.ts)：本地合成的 Streamable HTTP 与旧版 SSE 服务的工具、资源（含模板与二进制）、提示词；CJS 产物走 HTTP；地址规则与出站检查；本地假授权服务器上的 OAuth 全流程（401 → 需要登录 → 发现、动态注册、PKCE、伪造 / 重复 state 拒绝、换令牌、0600、进脱敏名单、不进配置与同步、退出登录）；配置管理与即时启停；同步标记的合并规则。
- [plugins.test.ts](../../runtime/test/plugins.test.ts)：本地目录 fixture 的 Claude Code 插件与 Agent Skills 目录解析、预览、安装 / 更新 / 卸载、技能冲突、marketplace 解析与浏览、git 地址规则、推荐目录安装（npx 预设、令牌进请求头凭据、CalDAV 密码进凭据）与推荐工具。
- 全部是合成数据，不访问外部账号或真实 MCP 服务；没有对推荐目录里的真实服务做端到端验证，也没有在安卓、Windows 或真实部署沙箱里验证 npx / uvx 启动。没有：MCP 服务端、多模态结果、listChanged 刷新、自动重连、sampling / elicitation、roots、DPoP、hooks 执行、插件自动更新。
