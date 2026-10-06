# 部署与运维

## 1. 准备

1. **服务器**：任意 Linux（x86_64 或 arm64），有公网 IPv4，1 核 1 GB 足够。80 / 443 / 3478 端口不能被别的程序（nginx、apache）占用。
2. **域名**：加一条 A 记录（有 IPv6 再加 AAAA）指向服务器。不要开 CDN 代理（Cloudflare 的橙色云朵要关掉）：WebSocket 可以过 CDN，但 TURN 必须直连。
3. **OpenID Connect 身份服务**：账号由它提供（自建的 Rauthy、Keycloak、Authelia 等都行）。在里面建一个机密客户端：
   - 回调地址：`https://<域名>/auth/oidc/callback`
   - scope：`openid profile email`；授权码 + PKCE（S256）
   - 记下 Issuer 地址、Client ID 与 Client secret。

## 2. 启动

```bash
git clone https://github.com/PlutoKeating/Project.Quetzal.git
cd Project.Quetzal/sync
./start.sh
```

`start.sh` 做的事（重复运行是安全的）：

| 步骤 | 内容 |
|---|---|
| Docker | 需要 Docker 与 Compose 插件 2.23.1 以上。没有时询问后用官方脚本 `get.docker.com` 安装（`download.docker.com` 不通时加 `--mirror Aliyun`）。当前用户没有 Docker 权限时自动用 `sudo` |
| `.env` | 从 `.env.example` 复制，权限 600（脚本以 `umask 077` 运行，改 `.env` 时用同目录的临时文件替换、退出时清理）；自动生成 `TURN_SECRET`；询问域名与 OIDC 登录（Issuer、Client ID、Client secret，secret 输入时不回显；旧的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 自动删掉）；检查域名是否解析到本机（只提醒）；探测 TURN 的中转地址并写好 `TURN_PUBLIC_IP`；检查 TURN 配额与端口段；官方镜像跟到当前固定的摘要 |
| 防火墙 | 本机的 ufw / firewalld 处于启用状态时放行所需端口；云安全组需要你在控制台放行 |
| 启动 | 构建同步服务镜像，`data/` 交给容器用户，`docker compose up -d` |
| 检查 | 等同步服务健康，再等 `https://<域名>/v1/health` 可用（证书第一次申请需要几十秒） |

### 2.1 隧道模式（不用 80 / 443）

80 / 443 被别的服务占着，或者服务器在中国大陆机房而域名没有备案（未备案的域名在 80 / 443 上会被机房拦截，证书也申请不下来）时，把网页与信令交给服务器上已有的反向隧道，STUN / TURN 仍然直连：

1. `.env` 里设 `SYNC_FRONT=tunnel`，`SYNC_LOCAL_PORT`（默认 8788，同步服务只监听 `127.0.0.1` 上的这个端口），`TURN_HOST`（一个**直连本机**的主机名或公网 IP；用主机名时 DNS 记录指向本机、**不开代理**）。
2. 在隧道里加一条 public hostname：`<SYNC_DOMAIN>` → `http://localhost:<SYNC_LOCAL_PORT>`（Cloudflare：Zero Trust → Networks → Tunnels → 你的隧道 → Public Hostname）。证书由隧道那一端提供；用二级以下的子域名（如 `sync.a.example.com`）时，确认边缘证书覆盖它。
3. 运行 `./start.sh`：只启动 `sync` 与 `coturn`，`.env` 里自动写好 `COMPOSE_FILE=compose.yaml:compose.tunnel.yaml` 与空的 `COMPOSE_PROFILES`（手动运行 `docker compose` 时也是同一套服务）；从 caddy 模式换过来时会停掉 Caddy。
4. 安全组只需放行 TCP 3478、UDP 3478 与中转端口段。

客户端地址（只用于内存里的限流）先取 `CF-Connecting-IP`（Cloudflare 边缘设置，访客伪造不了），没有时取 `X-Forwarded-For` 最右一项；同步服务只监听回环地址，别人绕不过隧道直接连。用的不是 Cloudflare Tunnel 时，让隧道删掉或覆盖访客自带的 `CF-Connecting-IP`，否则按地址的限流可以被绕过。

## 3. 配置（`.env`）

| 键 | 说明 |
|---|---|
| `SYNC_DOMAIN` | 必填，域名 |
| `SYNC_WEB_URL` | 网页前端（可选）：登录、账户、批准设备的页面放在这个站点上（官方部署为 `https://quetzal.plutokeating.beer`，它的账户页调用的是官方同步服务）；自建时留空，用同步服务自带的页面 |
| `GITHUB_OAUTH_RELAY` | 服务器连 `github.com` 时通时断（中国大陆机房常见，表现为链接灵魂仓库时转很久后失败）时填写：链接灵魂仓库时直连失败才经它中转换令牌。官方部署用官网 Worker 的 `https://quetzal.plutokeating.beer/api/oauth/github/token`，它只放行 Worker 变量 `OAUTH_CLIENT_IDS` 里的 App |
| `SYNC_FRONT` | `caddy`（默认，本机 80 / 443，自动 HTTPS）或 `tunnel`（见 §2.1） |
| `SYNC_LOCAL_PORT` | 隧道模式下同步服务在 `127.0.0.1` 上的端口，默认 8788 |
| `TURN_HOST` | STUN / TURN 的主机名或 IP，写进发给身体的 `turn:` / `stun:` 地址；留空与 `SYNC_DOMAIN` 相同。隧道模式或域名开了 CDN 代理时必填，必须直连本机 |
| `COMPOSE_FILE` / `COMPOSE_PROFILES` | 由 `start.sh` 按 `SYNC_FRONT` 写入，不用手改 |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | 登录用的身份服务与客户端；不填则网页不能登录、身体不能绑定 |
| `SYNC_ADMINS` | 管理员的账号邮箱（逗号分隔，身份服务确认过的邮箱）。管理员登录后打开 `https://<域名>/setup/github-app` 一键创建 GitHub App，它只用来建灵魂仓库、加部署密钥 |
| `TURN_SECRET` | 自动生成；同步服务与 coturn 共用，用来签发有时效的 TURN 凭据 |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | TURN 中转端口段，默认 49160–49250 |
| `TURN_USER_QUOTA` / `TURN_TOTAL_QUOTA` | 每具身体同时最多几个中转分配（默认 4）、全服务器最多几个（默认 90；超过端口段的端口数时 `start.sh` 自动改小） |
| `TURN_MAX_BPS` / `TURN_BPS_CAPACITY` | 每个中转会话、全部会话合计的带宽上限（字节 / 秒，默认 625000 ≈ 5 Mbit/s 与 2500000 ≈ 20 Mbit/s；0 为不限），按服务器带宽调整 |
| `SYNC_MAX_AGENTS_PER_USER` / `SYNC_MAX_BODIES_PER_AGENT` | 每个账户的 agent 上限（20）、每个 agent 的身体上限（16） |
| `NODE_IMAGE` / `CADDY_IMAGE` / `COTURN_IMAGE` / `NPM_REGISTRY` | 镜像与 npm 源。镜像默认按 `tag@sha256:…` 固定；服务器拉不动 Docker Hub 或 npm 时改成可用的镜像源，镜像地址保留 `@sha256:…` 部分。仍是官方地址时 `start.sh` 会跟到本仓库当前固定的摘要 |
| `TURN_RELAY_IP` / `TURN_EXTERNAL_IP` | TURN 的中转地址。留空时由 `start.sh` 探测：主网卡（默认路由出口）的 IPv4 作为 `relay-ip`；它是内网地址时（云服务器常见的 1:1 NAT）再探测公网地址，写成 `公网/内网`。必须显式指定，否则 coturn 会把 Docker 网桥等所有网卡地址都当作中转地址；coturn 也只在这个地址上监听（不在 Docker 网桥、VPN、回环上开 3478）。服务器换了地址就清空再运行 `./start.sh` |
| `TURN_PUBLIC_IP` | 由 `start.sh` 每次写入（`TURN_EXTERNAL_IP` 的公网部分），不用手改：coturn 禁止中转到它与 `TURN_RELAY_IP`，同一台服务器上的其他服务不能借 TURN 从本机访问 |
| `TURN_ALLOWED_PEER_IP` | 放行中转到某个地址（优先于禁止列表）。默认禁止中转到一切私有地址与本机自己的地址（防止借 TURN 打进服务器所在的内网或本机的其他服务），只在确实需要时填写 |

改完 `.env` 后运行 `./start.sh` 生效。

## 4. 数据、备份与迁移

全部数据在 `data/`（不入库，权限 700）：

| 目录 | 内容 |
|---|---|
| `data/sync/sync.db` | 账户、agent 登记、身体登记（令牌只有哈希）、短期的会话与绑定码 |
| `data/caddy/` | 证书与 ACME 账户 |

备份：`./start.sh stop` 后复制 `data/` 与 `.env`。迁移到新服务器：复制这两样，改 DNS，运行 `./start.sh`。

## 5. 排障

| 现象 | 看哪里 |
|---|---|
| `https://<域名>` 打不开 | `./start.sh logs caddy`：证书申请失败多半是 DNS 没指过来或 80 端口没放行 |
| 网页登录后报错 | `./start.sh logs sync`；检查身份服务里客户端的回调地址与 `.env` 的域名一致、`OIDC_ISSUER` 从服务器能访问 |
| 身体绑定后连不上彼此 | 安全组是否放行了 UDP 3478 与中转端口段；`./start.sh status` 看 coturn 是否在运行。coturn 不记日志（日志里会有访客 IP）：要排查时临时把 `compose.yaml` 里 coturn 的配置改回 `log-file=stdout`、去掉 `logging: driver: none`，`./start.sh` 后看 `./start.sh logs coturn`，查完改回 |
| 镜像下载很慢或失败 | 在 `.env` 里把 `*_IMAGE` 改为镜像加速地址、`NPM_REGISTRY` 改为可用的源 |

## 6. 升级与停用

- 升级：`./start.sh update`（`git pull --ff-only`，然后重建、重启）。升级会刷新 `.env` 里官方镜像的摘要。
- 从 1.4 以前（GitHub 登录）升级：先配好 OIDC。老账户迁移后 `users.sub` 为 `github:<GitHub 数字 id>`，要把它改成身份服务里对应账号的 `sub`，那个人才能登回原来的账户；GitHub 上旧的 OAuth App 可以删掉。
- 停止：`./start.sh stop`。彻底删除：停止后删除 `data/` 与 `.env`，在身份服务里删掉客户端，在 GitHub 删除 GitHub App。
