# 部署与运维

## 1. 准备

1. **服务器**：任意 Linux（x86_64 或 arm64），有公网 IPv4，1 核 1 GB 足够。80 / 443 / 3478 端口不能被别的程序（nginx、apache）占用。
2. **域名**：加一条 A 记录（有 IPv6 再加 AAAA）指向服务器。不要开 CDN 代理（Cloudflare 的橙色云朵要关掉）：WebSocket 可以过 CDN，但 TURN 必须直连。
3. **GitHub OAuth App**：在 <https://github.com/settings/applications/new> 创建：
   - Homepage URL：`https://<域名>`
   - Authorization callback URL：`https://<域名>/auth/github/callback`
   - 创建后记下 Client ID，再生成一个 Client secret。

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
| `.env` | 从 `.env.example` 复制，权限 600；自动生成 `TURN_SECRET`；询问域名与 GitHub OAuth App；检查域名是否解析到本机（只提醒）；探测 TURN 的中转地址 |
| 防火墙 | 本机的 ufw / firewalld 处于启用状态时放行所需端口；云安全组需要你在控制台放行 |
| 启动 | 构建同步服务镜像，`data/` 交给容器用户，`docker compose up -d` |
| 检查 | 等同步服务健康，再等 `https://<域名>/v1/health` 可用（证书第一次申请需要几十秒） |

## 3. 配置（`.env`）

| 键 | 说明 |
|---|---|
| `SYNC_DOMAIN` | 必填，域名 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub 登录；不填则网页不能登录、身体不能绑定 |
| `TURN_SECRET` | 自动生成；同步服务与 coturn 共用，用来签发有时效的 TURN 凭据 |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | TURN 中转端口段，默认 49160–49250 |
| `SYNC_MAX_AGENTS_PER_USER` / `SYNC_MAX_BODIES_PER_AGENT` | 每个账户的 agent 上限（20）、每个 agent 的身体上限（16） |
| `NODE_IMAGE` / `CADDY_IMAGE` / `COTURN_IMAGE` / `NPM_REGISTRY` | 镜像与 npm 源；服务器拉不动 Docker Hub 或 npm 时改成可用的镜像源 |
| `TURN_RELAY_IP` / `TURN_EXTERNAL_IP` | TURN 的中转地址。留空时由 `start.sh` 探测：主网卡（默认路由出口）的 IPv4 作为 `relay-ip`；它是内网地址时（云服务器常见的 1:1 NAT）再探测公网地址，写成 `公网/内网`。必须显式指定，否则 coturn 会把 Docker 网桥等所有网卡地址都当作中转地址。服务器换了地址就清空再运行 `./start.sh` |
| `TURN_ALLOWED_PEER_IP` | 放行中转到某个内网地址。默认禁止中转到一切私有地址（防止借 TURN 打进服务器所在的内网），只在确实需要时填写 |

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
| 网页登录后报错 | `./start.sh logs sync`；检查 OAuth App 的回调地址与 `.env` 的域名一致 |
| 身体绑定后连不上彼此 | 安全组是否放行了 UDP 3478 与中转端口段；`./start.sh logs coturn` |
| 镜像下载很慢或失败 | 在 `.env` 里把 `*_IMAGE` 改为镜像加速地址、`NPM_REGISTRY` 改为可用的源 |

## 6. 升级与停用

- 升级：`./start.sh update`（`git pull --ff-only`，然后重建、重启）。
- 停止：`./start.sh stop`。彻底删除：停止后删除 `data/` 与 `.env`，并在 GitHub 删除 OAuth App。
