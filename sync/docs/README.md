# sync · 开发说明

TypeScript（只用可擦除语法），由 Node 直接运行源码，没有构建步骤。Node ≥ 22.18（类型擦除默认开启；容器里是 Node 24）。

| 命令 | 作用 |
|---|---|
| `npm ci` | 安装依赖 |
| `npm test` | 端到端测试：登录（PKCE、`__Host-` 临时 Cookie、吊销 GitHub 令牌）、设备码绑定、WebSocket 信令与在场（深层嵌套、字节限流、慢消费者、按地址的连接上限）、账户隔离、CSRF、开放重定向、限流（短码按账户与地址、客户端地址、限流器上限）、请求体上限、TURN 凭据（算法、不透明标识、缓存）、数据库迁移；网页前端的账户接口（CORS 与 `Vary`、来源检查、批准身体、账户管理、全部退出）与控制台登录（指纹、随身体解绑作废、会话寿命） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | 以 `./.dev` 为数据目录、`http://localhost:8080` 为公开地址运行（`--watch`）；登录需要 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 环境变量，回调地址填 `http://localhost:8080/auth/github/callback` |

依赖：`hono`、`@hono/node-server`、`ws`、`arctic`（只用它生成 `state` 与 PKCE 的 `code_verifier`）、`zod`（理由见 [ARCHITECTURE.md](ARCHITECTURE.md)）。开发依赖：`typescript`、`@types/node`、`@types/ws`。

环境变量（`src/config.ts`；部署时由 compose 从 `.env` 注入）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SYNC_PUBLIC_URL` | 必填 | 对外地址（`https://<域名>`）；Cookie 的 `Secure`、CSRF 的来源、TURN 主机名都由它推出 |
| `SYNC_WEB_URL` | 空 | 网页前端（例如官网）：给人看的页面都在那里，自带的页面跳过去，账户接口只对它放行 CORS；必须与 `SYNC_PUBLIC_URL` 同站 |
| `TURN_HOST` | 空 | STUN / TURN 的主机名或 IP（缺省与公开地址相同） |
| `SYNC_HOST` / `SYNC_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `SYNC_DATA_DIR` | `/data` | 数据库目录 |
| `SYNC_TRUST_PROXY` | 否 | 前面有反向代理时为 `1`：客户端地址先取 `CF-Connecting-IP`，没有时取 `X-Forwarded-For` 的最右一项（代理必须删掉或覆盖客户端自带的这两个头；compose 里的 Caddy 与 Cloudflare Tunnel 都会） |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 空 | GitHub 登录 |
| `GITHUB_OAUTH_RELAY` | 空 | 换令牌的中转（HTTPS）：直连 `github.com` 两次都失败时经它转发授权码换令牌的请求（服务器连 GitHub 时通时断的机房用） |
| `TURN_SECRET` | 空 | 至少 32 个字符；空则只给 STUN |
| `TURN_URLS` / `STUN_URLS` | 由公开地址推出 | 逗号分隔，覆盖缺省的 `turn:<主机>:3478?transport=udp|tcp`、`stun:<主机>:3478` |
| `TURN_TTL_SECONDS` | 3600 | TURN 凭据有效期（同一具身体在剩余过半之前拿到的是同一个） |
| `SYNC_SESSION_DAYS` | 30 | 网页会话的滑动有效期（1–90）；控制台登录固定 30 天；任何会话自创建起最长 90 天 |
| `SYNC_MAX_AGENTS_PER_USER` / `SYNC_MAX_BODIES_PER_AGENT` | 20 / 16 | 上限 |

约定：

- 与仓库的其他部分没有代码依赖（不 import `runtime/` 等），协议以 [PROTOCOL.md](PROTOCOL.md) 为准；修改协议要同步修改身体端（`runtime/src/mesh/`）并在不兼容时提升版本号。
- 所有外部输入先过 zod；新增的表单 POST 自动受 CSRF 中间件保护，并在配置了 `SYNC_WEB_URL` 时跳到网页前端（`src/app.ts` 开头的跳转块）；新增的 `/v1/*` 接口不得依赖 Cookie（`/v1/web/*` 除外：它在 `src/web.ts` 里，有自己的 CORS 与来源检查）。
- 日志不记 IP、令牌、短码与请求内容；WebSocket 的每个事件处理都要兜住异常，只断开出错的那条连接。
- 网页文案中英两份放在 `src/pages.ts`；中文里 agent 的代词写作 ta。
