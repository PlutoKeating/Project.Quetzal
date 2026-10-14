# MCP stdio 工具来源

状态：首个可配置 stdio 接入切片，尚无 HTTP / OAuth / resources / prompts / 多模态接入。实现位于 [client.ts](../../runtime/src/mcp/client.ts)、[runtime.ts](../../runtime/src/mcp/runtime.ts)，通过 [工具注册与闸门](../../runtime/src/mind/tools.ts) 进入现有循环；`engine/` 不依赖 MCP SDK。

## 配置与启动

部署者在仓库外 `QUETZAL_HOME/config/mcp.json` 配置来源，重启运行基座后加载；无文件时不启动任何来源。配置不进灵魂，不通过 mesh 同步。示例为通用模板，路径必须换成部署者已安装的程序与服务：

```json
{
  "servers": [
    {
      "id": "research",
      "transport": "stdio",
      "enabled": true,
      "command": "/usr/bin/node",
      "args": ["/opt/quetzal-mcp/server.mjs"],
      "sandbox": true,
      "env": {},
      "secrets": {},
      "timeoutMs": 30000,
      "maxResultChars": 12000
    }
  ]
}
```

`command` 必须为绝对路径，`args` 为字符串数组，不经过 shell，不隐式安装、下载或执行 npm 包。`cwd` 可指定绝对工作目录，省略时沙箱使用既有默认工作目录；`sandbox:false` 直接启动时省略 cwd 使用运行时工作目录。来源 ID 为小写字母开头、最多 24 个小写字母/数字/下划线。

`enabled` 默认 false。启用后还需通过独立的启动能力 `mcp_start.<id>`，工具执行能力为 `mcp.<id>.<模型工具名>`；均由 [guard](../../runtime/src/guard/guard.ts) 处理，缺省 ask。优先取精确能力配置，再取来源级，再取 `mcp_start` / `mcp` 总类；部署者可以在 `quetzal.json` 的 permissions 内配置 allow / ask / deny，例如 `mcp_start.research` 与 `mcp.research`。启动 allow 不会自动允许工具调用。带点的来源 / 工具子类别不通过现有 mesh 权限过滤器同步；mcp / mcp_start 总类别仍属于既有全网权限分区，修改总类别会按原机制共享。

网关与审批界面先启动，MCP 来源再异步请求启动审批，避免阻塞其他来源、心脏与通道；启动失败写日志和审计，不使整个运行基座启动失败。当前没有 MCP 专属配置界面、状态 RPC、热更新或自动重连；修改文件、处理连接失败或改变工具集合需重启。安全模式不启动来源。

## 凭据与隔离范围

非敏感变量放 `env`；凭据用 `secrets` 的环境变量到文件名映射，例如 `{"SERVICE_TOKEN":"mcp_research_token"}`，真实值由宿主从 `QUETZAL_HOME/secrets/mcp_research_token` 读取。只接受 `mcp_` 前缀的普通文件，不收路径穿越或符号链接；凭据只注入该来源，模型看不到引用配置或值。不得把真实凭据写进 env、args、源码、公开文档或灵魂。

宿主只注入基础运行环境与明确配置的变量，不传整个 `process.env`。官方 SDK 另合并其固定基础变量白名单：POSIX 为 HOME、LOGNAME、PATH、SHELL、TERM、USER；Windows 为系统路径、用户目录与 TEMP 等基础变量，不包含任意 token。合成子进程测试验证无关秘密环境变量未继承。

`sandbox` 默认 true，POSIX 复用现有 `wrapArgv()`，由 SDK 对沙箱后的 command / args 建立双向 stdio。**隔离范围与现有 agent 命令完全相同**：保护基座密钥目录，但现有沙箱允许访问部分数据、灵魂与保密库；不是 MCP 独有的最小文件授权，也不保证第三方服务读不到私有灵魂。仅配置可信来源。缺沙箱时遵循既有 `sandbox.allowUnsandboxed` 策略，默认拒绝；如果部署者已显式允许全局无沙箱运行，MCP 也继承该放行。

首期 Windows 未验证沙箱启动器双向 stdio，默认 sandbox:true 明确拒绝。部署者可显式选择 sandbox:false 并批准启动，此时进程具有宿主用户文件权限，能读取密钥、灵魂与保密库；不能称为隔离。此次合成测试只在当前 POSIX 环境直接运行可信 fixture，未完成安卓、Windows或真实部署沙箱验证。

来源 stderr 不继承到运行时或终端，首期丢弃；协议 / 启动错误经已有保密值脱敏后记录。工具定义描述与 schema、返回文字 / JSON 在交给模型前脱敏，返回结果先脱敏再截断。来源恶意内容不会作为权限声明执行，工具 annotations 不自动放宽政策。授权和脱敏无法防止获授权的第三方程序主动读取、传送其有权限访问的数据。

## 协议与工具映射

2026-10-14 读取 npm 官方 registry，锁定官方 `@modelcontextprotocol/client@2.3.1`，Node 要求 >=20，与项目 Node >=22 兼容；该包内置其 AJV 实现，未另引通用 Agent SDK、服务端 Web 框架或向量库。协议资料见 [官方 current 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)、[SDK 协商指南](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)。

Client 显式启用 auto，探测现代 `server/discover` 或回退 legacy initialize。使用 SDK stdio 的薄子类，让探测在同一个已获授权的进程中进行，避免基类 auto 的额外探测进程；因此遇到收到探测就退出的旧服务时，本切片会报告连接失败，不自动再启动。日志和启动审计记录 SDK 返回的真实协议版本。合成测试分别协商为 2025-11-25 与 2026-07-28，不据此保证所有 MCP 服务兼容。

只接受声明 tools 能力的 server。来源启动时完成工具发现与 schema 编译，再发布工具；输入通过 AJV 校验，输出结构由 SDK 根据工具输出 schema 验证。当前没有 listChanged / subscription / TTL 刷新，也不自动注入 server instructions。

模型工具名固定为 `mcp_<来源ID>_<原名SHA256前24位>`，使用映射保存原名，最长 53 个 ASCII 字符；来源相同、原名相同则跨重启稳定，大小写不同则不同。保留原名供描述和远端调用。来源内原名重复、别名冲突或不符合 MCP 推荐字符集时拒绝该来源；与已注册的内置 / 适配器 / 自造工具冲突时不展示 MCP 同名定义，调用该冲突名明确失败，不能靠 `.find()` 顺序选择实现。

工具不进入跨身体 `limbTools()`，首期只在执行身体本机可用。工具列表保持启动时快照；连接关闭立即不再发布工具，同一轮旧工具调用得到不可用错误，而不悄悄接入另一个来源。

## 输出、取消与生命周期

- 支持 text 与 structuredContent JSON，避免完全相同 JSON 文本重复注入；图片、音频、资源等返回明确未支持说明，并标工具失败，不自动下载 URL 或把远端 file URI 当本机路径。
- `isError:true`、无效输出 schema、协议错误、断连或未支持的额外输入 / task 结果标失败，经现有工具记录与失败前缀进入循环；本地能力拒绝标 denied。
- 每调用接收当前 Session.signal；SDK 负责调用级取消，取消后不接收迟到成功结果。单次取消不关闭来源，不影响其他并发调用。急停通过 state 事件取消该来源的全部在途调用，新调用仍由 guard 拦截。取消不保证撤销远端已产生的副作用。
- 调用总超时默认 30 秒，可配 100ms–300 秒，不由 progress 延长。超时不自动重放 tools/call。
- 配置最多 16 来源、128 KiB；每来源最多 128 工具、256 KiB 定义、8 页；stdio 单条接收消息最多 1 MiB。最终文本默认 12000 字符，可配 100–60000；截断时明确提示。SDK 默认分页聚合也受 8 页上限，不能无限汇总。
- SIGINT/SIGTERM 时停止新启动并关闭正在连接 / 已连接的自有来源，最多等待 3 秒；现有运维直接 process.exit 时 exit 钩子终止已跟踪的 server。SDK 清理直接子进程；POSIX SDK 启动未建立独立进程组，首期**不保证任意孙进程树全部清理**。不应配置会自建守护进程的来源。

## 验证与后续

[mcp.test.ts](../../runtime/test/mcp.test.ts) 使用临时目录中的 Node 合成 stdio server，验证 modern / legacy、真实协商版本、发现、参数 / 输出 schema、文本 / JSON、失败、截断、取消 / 超时后另一个调用正常、基础环境与秘密隔离、默认无沙箱拒绝启动、生产注册入口的启动 deny / ask与幂等、别名与本机工具冲突拒绝、工具 ask / deny、输出脱敏、审计和新调用 / 在途急停。另将 client.ts 用 esbuild 打成临时 CJS 产物，实际发现并调用同一个合成 server，验证 SDK 的打包执行路径。全部数据为合成数据，不访问外部账号或真实 MCP 服务。

实施检查使用 `node --experimental-strip-types --test test/mcp.test.ts`、runtime 类型检查与构建。通过合成协议测试不等于真实 server、部署沙箱或真机验证。HTTP/OAuth、多模态、来源状态界面、工具动态刷新、更严格文件隔离和完整进程树清理按独立切片继续，范围详见 [适配器计划](ADAPTERS_PLAN.md)。
