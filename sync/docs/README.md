# sync · 开发说明

TypeScript（只用可擦除语法），由 Node 直接运行源码，没有构建步骤。Node ≥ 22.18（类型擦除默认开启；容器里是 Node 24）。

| 命令 | 作用 |
|---|---|
| `npm ci` | 安装依赖 |
| `npm test` | 端到端测试：登录、设备码绑定、WebSocket 信令与在场、账户隔离、CSRF、开放重定向、限流、请求体上限、TURN 凭据算法 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | 以 `./.dev` 为数据目录、`http://localhost:8080` 为公开地址运行（`--watch`）；登录需要 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 环境变量，回调地址填 `http://localhost:8080/auth/github/callback` |

依赖：`hono`、`@hono/node-server`、`ws`、`arctic`、`zod`（理由见 [ARCHITECTURE.md](ARCHITECTURE.md)）。开发依赖：`typescript`、`@types/node`、`@types/ws`。

环境变量（`src/config.ts`；部署时由 compose 从 `.env` 注入）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SYNC_PUBLIC_URL` | 必填 | 对外地址（`https://<域名>`）；Cookie 的 `Secure`、CSRF 的来源、TURN 主机名都由它推出 |
| `SYNC_HOST` / `SYNC_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `SYNC_DATA_DIR` | `/data` | 数据库目录 |
| `SYNC_TRUST_PROXY` | 否 | 前面有反向代理时为 `1`：客户端地址取 `X-Forwarded-For` 的最右一项 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 空 | GitHub 登录 |
| `TURN_SECRET` | 空 | 至少 32 个字符；空则只给 STUN |
| `TURN_URLS` / `STUN_URLS` | 由公开地址推出 | 逗号分隔，覆盖缺省的 `turn:<主机>:3478?transport=udp|tcp`、`stun:<主机>:3478` |
| `TURN_TTL_SECONDS` | 3600 | TURN 凭据有效期 |
| `SYNC_SESSION_DAYS` | 30 | 网页会话有效期 |
| `SYNC_MAX_AGENTS_PER_USER` / `SYNC_MAX_BODIES_PER_AGENT` | 20 / 16 | 上限 |

约定：

- 与仓库的其他部分没有代码依赖（不 import `runtime/` 等），协议以 [PROTOCOL.md](PROTOCOL.md) 为准；修改协议要同步修改身体端（`runtime/src/mesh/`）并在不兼容时提升版本号。
- 所有外部输入先过 zod；新增的表单 POST 自动受 CSRF 中间件保护；新增的 `/v1/*` 接口不得依赖 Cookie。
- 网页文案中英两份放在 `src/pages.ts`；中文里 agent 的代词写作 ta。
