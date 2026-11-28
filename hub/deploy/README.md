# 部署 quetzalcoatl-hub

`quetzalcoatl-hub` 是一个静态二进制：它保管密文、给设备之间的连接做中继、告诉设备各自的公网地址。
它看不到任何内容，也不调用任何模型。本目录是把它跑起来所需的全部东西。

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 多阶段构建，产出只含一个二进制的镜像，以非 root 用户（UID 65532）运行 |
| `compose.yaml` | 单服务编排：具名卷存数据，HTTP 只绑本机，UDP 直接对外 |
| `hub.env.example` | 全部环境变量的说明、默认值，以及改了会影响谁 |
| `quetzalcoatl-hub.service` | 不用容器时的 systemd 单元 |

## 它监听什么

| 端口 | 协议 | 承载 | 谁要够得着 |
| --- | --- | --- | --- |
| 8443（可改） | TCP，HTTP 或 HTTPS | 登录、密文同步、中继（WebSocket，路径 `/relay`）、`/healthz`、`/v1/meta`、`/metrics` | 所有设备，可以经隧道或反向代理 |
| 7842（可改） | UDP，QUIC | 地址发现：设备问「我的公网地址是什么」 | 所有设备，**必须直连** |

## 先选入口

三种入口的差别只在「TLS 由谁终结」和「地址发现还能不能用」。

| 入口 | TLS 在哪里终结 | 服务器要开的入站端口 | 地址发现 |
| --- | --- | --- | --- |
| [Cloudflare Tunnel 在前](#方式一cloudflare-tunnel-在前) | Cloudflare | 无（想要地址发现则另开，见该节） | 默认不可用 |
| [反向代理在前](#方式二通用反向代理在前) | 反向代理 | 443/tcp 给代理，7842/udp 给 Hub | 把证书也交给 Hub 后可用 |
| [自带证书直出](#方式三自带证书直出) | Hub 自己 | 443/tcp、7842/udp | 可用 |

地址发现不可用时一切照常同步，只是不在同一个网络里的设备之间多半打不通直连，流量改经 Hub 中继：
更慢，也更占你的带宽。同一局域网内的设备不受影响。

## 地址发现端口必须直连公网

这是最容易配错的地方，三条都要满足：

1. **它是 UDP。** Cloudflare Tunnel、nginx、Caddy 的 HTTP 反向代理都只转发 HTTP，带不动它。
   必须在主机防火墙和云厂商安全组里放行入站 UDP 7842，直接到 Hub。
2. **设备按「中继地址的域名 + 7842」去找它。** 中继地址默认就是 Hub 地址。所以这个域名必须解析到
   服务器自己的公网 IP。走 Cloudflare 代理的域名解析到的是 Cloudflare，UDP 包到不了你的服务器。
3. **它用 Hub 的证书，设备会校验。** 证书要由公开 CA 签给上面那个域名，并通过
   `QUETZALCOATL_HUB_TLS_CERT_FILE` / `QUETZALCOATL_HUB_TLS_KEY_FILE` 交给 Hub。不给的话 Hub 用自动生成的
   自签名证书，设备默认不信任。

用容器时，Docker 默认的桥接网络会保留公网来包的源地址，回报给设备的地址是对的。但无根模式
（rootless）的 Docker 与 Docker Desktop 会把源地址改写成网桥地址，设备会拿到错误的结果；另外
`compose.yaml` 默认只在 IPv4 上发布这个端口。遇到这两种环境，或者需要 IPv6 的地址发现时，改用宿主机网络：
在 `compose.yaml` 里给服务加上 `network_mode: host`，删掉整段 `ports`，并把 `environment` 里的
`QUETZALCOATL_HUB_ADDR` 改成你要的绑定地址（有隧道或代理在前时用 `127.0.0.1:8443`）。

不打算提供地址发现时，在 `hub.env` 里写 `QUETZALCOATL_HUB_QAD_ADDR=off`，并删掉 `compose.yaml` 里那行
UDP 端口，免得留一个没人答得上话的端口。

## 通用步骤

以下命令都在本目录（`hub/deploy`）执行。

```sh
cp hub.env.example hub.env && chmod 600 hub.env
# 编辑 hub.env：至少改 QUETZALCOATL_HUB_PUBLIC_URL 与 QUETZALCOATL_HUB_RP_ID
HUB_VERSION=2.0.0 docker compose up -d --build
docker compose ps          # STATUS 一栏出现 healthy 即可
curl http://127.0.0.1:8443/healthz
```

`HUB_VERSION` 只是写进二进制的版本号，会显示在 `/v1/meta` 里；请填你实际检出的版本。

`hub.env` 里每个公网部署都要改的两项：

- `QUETZALCOATL_HUB_PUBLIC_URL`：设备访问 Hub 用的完整地址，例如 `https://hub.example.com`，不带结尾斜杠。
- `QUETZALCOATL_HUB_RP_ID`：通行密钥绑定的域名，例如 `hub.example.com`。**一旦有人注册了通行密钥就不要再改**，
  改了以后已注册的通行密钥全部失效。

放在 Hub 前面的任何隧道或代理都要满足：

- 原样透传 `Host` 请求头（上传下载链接的签名包含它）；
- 允许 `/relay` 上的 WebSocket 升级，且不要在一分钟内掐断空闲连接；
- 允许至少 32 MB 的请求体（单个密文包最大 16 MiB）；
- 不要把 `/metrics` 放出去（见[运行指标](#运行指标-metrics)）。

## 方式一：Cloudflare Tunnel 在前

服务器不开任何入站 TCP 端口，由 `cloudflared` 主动连出去。`compose.yaml` 默认把 HTTP 绑在
`127.0.0.1:8443`，正好给同机的 `cloudflared` 用。

`hub.env`：

```
QUETZALCOATL_HUB_PUBLIC_URL=https://hub.example.com
QUETZALCOATL_HUB_RP_ID=hub.example.com
QUETZALCOATL_HUB_QAD_ADDR=off
```

`cloudflared` 的入口规则（`/etc/cloudflared/config.yml`）：

```yaml
tunnel: <隧道 ID>
credentials-file: /etc/cloudflared/<隧道 ID>.json
ingress:
  - hostname: hub.example.com
    path: ^/metrics$
    service: http_status:404
  - hostname: hub.example.com
    service: http://127.0.0.1:8443
  - service: http_status:404
```

WebSocket 在 Cloudflare 上默认开启，不需要额外设置。

**想保留地址发现**：隧道域名解析到 Cloudflare，地址发现在这个域名上不可能工作。需要另外准备一个
「仅 DNS」（不经 Cloudflare 代理）的域名，例如 `relay.example.com`，解析到服务器公网 IP，然后：

1. 给 Hub 一张签给 `relay.example.com` 的证书（`QUETZALCOATL_HUB_TLS_CERT_FILE` / `_KEY_FILE`）。
   设置后 Hub 的 HTTP 端口改为 HTTPS，`cloudflared` 的 `service` 相应改成 `https://127.0.0.1:8443`，
   并在该规则下加 `originRequest: { originServerName: relay.example.com }`；
2. 把 HTTP 端口与 UDP 7842 都对公网放行（`HUB_HTTP_PUBLISH=443`），因为设备会直接连
   `relay.example.com` 做中继与地址发现；
3. 每台设备把中继地址指向它：`QUETZALCOATL_FABRIC_RELAY_URL=https://relay.example.com`。

这样登录与同步走隧道，地址发现走直连。这个组合依据的是客户端查找地址发现端口的方式，我们没有实地
部署验证过；既然已经要开入站端口，直接用方式三更简单。

## 方式二：通用反向代理在前

域名解析到服务器，反向代理（nginx、Caddy 等）占用 443 并终结 TLS，把请求转给 `127.0.0.1:8443`。

`hub.env`：

```
QUETZALCOATL_HUB_PUBLIC_URL=https://hub.example.com
QUETZALCOATL_HUB_RP_ID=hub.example.com
```

nginx：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name hub.example.com;
    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    client_max_body_size 32m;

    location = /metrics { return 404; }

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Caddy：

```
hub.example.com {
    @metrics path /metrics
    respond @metrics 404
    reverse_proxy 127.0.0.1:8443
}
```

**要让地址发现可用**，再做两件事：

1. 放行入站 UDP 7842（`compose.yaml` 默认已发布到 `0.0.0.0:7842`）；
2. 把同一张证书也交给 Hub：挂载证书目录（做法见方式三的第 1、2 步），在 `hub.env` 里设置
   `QUETZALCOATL_HUB_TLS_CERT_FILE` 与 `QUETZALCOATL_HUB_TLS_KEY_FILE`。设置后 Hub 的 HTTP 端口改为
   HTTPS，代理的上游要跟着改。nginx 把 `proxy_pass` 一行换成：

   ```nginx
   proxy_pass https://127.0.0.1:8443;
   proxy_ssl_server_name on;
   proxy_ssl_name hub.example.com;
   ```

   Caddy 把 `reverse_proxy` 一行换成：

   ```
   reverse_proxy https://127.0.0.1:8443 {
       transport http {
           tls_server_name hub.example.com
       }
   }
   ```

不需要地址发现时按[上文](#地址发现端口必须直连公网)把它关掉。

## 方式三：自带证书直出

域名解析到服务器，Hub 自己提供 HTTPS。三种方式里只有它不需要额外组件，地址发现也直接可用。

1. 准备证书，让容器里的运行用户（UID 65532）读得到：

   ```sh
   install -d -m 0750 -o 65532 -g 65532 /etc/quetzalcoatl-hub/certs
   install -m 0640 -o 65532 -g 65532 /etc/letsencrypt/live/hub.example.com/fullchain.pem /etc/quetzalcoatl-hub/certs/fullchain.pem
   install -m 0600 -o 65532 -g 65532 /etc/letsencrypt/live/hub.example.com/privkey.pem  /etc/quetzalcoatl-hub/certs/privkey.pem
   ```

2. 在 `compose.yaml` 里取消证书目录那行挂载的注释。

3. `hub.env`：

   ```
   QUETZALCOATL_HUB_PUBLIC_URL=https://hub.example.com
   QUETZALCOATL_HUB_RP_ID=hub.example.com
   QUETZALCOATL_HUB_TLS_CERT_FILE=/certs/fullchain.pem
   QUETZALCOATL_HUB_TLS_KEY_FILE=/certs/privkey.pem
   ```

4. 把 HTTP 端口发布到公网 443 并启动，然后放行 443/tcp 与 7842/udp：

   ```sh
   HUB_HTTP_PUBLISH=443 HUB_VERSION=2.0.0 docker compose up -d --build
   ```

   把 `HUB_HTTP_PUBLISH=443` 写进本目录的 `.env`，以后就不用每次带上。

Hub 只在启动时读证书。证书续期后要重新执行第 1 步并 `docker compose restart hub`，建议做成 ACME 客户端的
续期钩子。直出时没有代理替你挡 `/metrics`：不设令牌时它只对本机回环开放，公网读不到；要抓取就设令牌。

## 首次启动会生成什么，要备份什么

第一次启动时，Hub 在数据目录（容器里是具名卷 `quetzalcoatl-hub_hub-data`）里生成：

| 文件 | 内容 | 要备份吗 |
| --- | --- | --- |
| `hub_secrets.json` | 三把根密钥：链接签名密钥、口令登录的种子与服务端私钥 | **必须**。丢了以后所有用口令登录的账户都无法再登录，且无法恢复 |
| `hub.sqlite`（及 `-wal`、`-shm`） | 账户、设备、密钥信封、密文包索引、租约、群提交、来信队列 | **必须** |
| `blobs/` | 设备上传的密文包 | **必须**，并且要与数据库同一时刻备份 |
| `hub_tls_cert.pem`、`hub_tls_key.pem` | 自签名证书，有效期一年，临近到期时在启动时自动重签 | 不需要 |

改用 PostgreSQL 或对象存储时，数据库与密文包分别在那两处，按它们各自的办法备份；`hub_secrets.json`
仍在数据目录里，仍然必须备份。

Hub 里存的都是密文和加密过的密钥信封，但备份里仍有账户与设备的元数据和根密钥，请加密存放。

停机备份最省事，也最不会出错：

```sh
docker compose stop hub
docker run --rm -v quetzalcoatl-hub_hub-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/hub-data-$(date +%F).tar.gz -C /data .
docker compose start hub
```

恢复时先停服务，把压缩包解回同一个卷（以 root 解包，保留属主 65532），再启动：

```sh
docker compose stop hub
docker run --rm -v quetzalcoatl-hub_hub-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* && tar xzpf /backup/hub-data-2026-12-01.tar.gz -C /data'
docker compose start hub
```

## 升级与回滚

每个版本用自己的镜像标签，旧镜像留在本机，回滚才有东西可回。

```sh
# 升级前先按上一节做一次备份
git fetch --tags && git checkout v2.0.1
HUB_IMAGE=quetzalcoatl-hub:2.0.1 HUB_VERSION=2.0.1 docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8443/v1/meta    # server_version 应为 2.0.1
```

把 `HUB_IMAGE` 写进本目录的 `.env`，避免下次忘记带上而退回默认标签。

升级时数据库结构由 Hub 在启动时自动迁移，不需要手工执行脚本。重启期间设备会自动重试，无需通知用户。

回滚：

```sh
HUB_IMAGE=quetzalcoatl-hub:2.0.0 docker compose up -d
```

数据库结构的迁移只增不减，换回旧镜像通常可以直接启动，但旧版本不保证认得新版本写进去的数据。
发版说明注明「数据库结构不兼容」时，或者回滚后发现异常时，要同时恢复升级前的备份——升级之后新写入的
数据会丢失，所以升级前的那次备份不能省。

## 运行指标 `/metrics`

`GET /metrics` 以 Prometheus 文本格式输出运行状况。管理员看不到任何内容，这是设计；指标回答的是三件事：
活着吗、满了吗、流量如何。它不输出任何账户、Agent 或设备的标识，只有总量。

**谁能访问**

- 设置了 `QUETZALCOATL_HUB_METRICS_TOKEN`：任何来源都必须带 `Authorization: Bearer <令牌>`，否则 401。
- 没有设置：只接受本机回环地址的直连请求，其余一律 404，看起来和没有这个路径一样。
  带有 `X-Forwarded-For`、`Forwarded`、`Via`、`CF-Connecting-IP` 这类转发头的请求即使来自回环地址也会
  被拒绝，因为那说明它是同机的代理或隧道替别人转来的。

用容器部署时，从宿主机经端口映射进去的请求在容器看来不是回环地址，所以**容器部署要读指标就必须设置
令牌**。用 `openssl rand -hex 32` 生成一个，写进 `hub.env` 后重启。

```sh
curl -H "Authorization: Bearer <令牌>" http://127.0.0.1:8443/metrics
```

不用容器、也没设令牌时，在服务器本机直接 `curl http://127.0.0.1:8443/metrics` 即可。

Prometheus 抓取配置：

```yaml
scrape_configs:
  - job_name: quetzalcoatl-hub
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/quetzalcoatl-hub.token
    static_configs:
      - targets: ["127.0.0.1:8443"]
```

**指标清单**

| 指标 | 含义 |
| --- | --- |
| `quetzalcoatl_hub_build_info` | 恒为 1；标签 `version` 是 Hub 版本，`goversion` 是编译用的 Go 版本 |
| `quetzalcoatl_hub_start_time_seconds` | 进程启动时刻（Unix 秒） |
| `quetzalcoatl_hub_uptime_seconds` | 已运行秒数 |
| `quetzalcoatl_hub_store_up` | 数据库是否答得上话（1/0）。为 0 时下面八项不输出 |
| `quetzalcoatl_hub_accounts` | 账户数 |
| `quetzalcoatl_hub_agents` | Agent 数 |
| `quetzalcoatl_hub_agents_near_quota` | 已用空间达到自身配额 90% 的 Agent 数 |
| `quetzalcoatl_hub_spine_packs` | 已存储的密文包数量 |
| `quetzalcoatl_hub_spine_stored_bytes` | 已存储的密文包总字节数 |
| `quetzalcoatl_hub_spine_quota_bytes` | 全部 Agent 的配额之和 |
| `quetzalcoatl_hub_leases_active` | 当前持有未过期租约的 Agent 数，约等于此刻有设备在线写入的 Agent 数 |
| `quetzalcoatl_hub_webhook_ingress_queue_depth` | 来信队列里等待设备取走的密文行总数 |
| `quetzalcoatl_hub_agent_default_quota_bytes` | 新建 Agent 的默认配额 |
| `quetzalcoatl_hub_relay_connections` | 当前中继连接数 |
| `quetzalcoatl_hub_relay_connections_accepted_total` | 启动以来通过握手的中继连接数 |
| `quetzalcoatl_hub_relay_forwarded_frames_total` | 启动以来转发的数据报帧数 |
| `quetzalcoatl_hub_relay_forwarded_bytes_total` | 启动以来转发的数据报字节数 |
| `quetzalcoatl_hub_relay_dropped_frames_total` | 启动以来因接收方队列已满而丢弃的帧数 |
| `quetzalcoatl_hub_qad_enabled` | 地址发现是否开启（1/0）。为 0 时下面两项不输出 |
| `quetzalcoatl_hub_qad_requests_total` | 启动以来收到的地址发现请求数 |
| `quetzalcoatl_hub_qad_reports_total` | 启动以来成功回报了公网地址的请求数 |

数据库相关的几项最多每 5 秒重新统计一次；带 `_total` 的是计数器，重启后从 0 开始。

值得设告警的几处：

- `quetzalcoatl_hub_store_up == 0`：数据库不可用；
- `quetzalcoatl_hub_agents_near_quota > 0`：有人快存满了，存满后他的设备会同步失败；
- `quetzalcoatl_hub_relay_dropped_frames_total` 持续增长：中继带宽或对端网络跟不上；
- `quetzalcoatl_hub_qad_requests_total` 在涨而 `quetzalcoatl_hub_qad_reports_total` 不涨：UDP 包进得来但
  握手完不成，多半是证书不被设备信任，或回程 UDP 被拦；
- 两项都长期为 0 而设备不少：UDP 7842 根本没通，回头检查[地址发现](#地址发现端口必须直连公网)。

磁盘剩余空间、内存、CPU 不在其中，请用主机自身的监控。

## 最低客户端版本与公告 `/v1/meta`

`GET /v1/meta` 是公开接口，不需要登录：

```json
{"server_version":"2.0.1","min_client_version":"2.0.0","announcement":"本周六 02:00 至 03:00 维护，期间同步暂停","server_time_ms":1795822752092}
```

在 `hub.env` 里设置后重启即生效：

```
QUETZALCOATL_HUB_MIN_CLIENT_VERSION=2.0.0
QUETZALCOATL_HUB_ANNOUNCEMENT=本周六 02:00 至 03:00 维护，期间同步暂停
```

- **最低客户端版本**：写成 `2.0.0` 或 `2.0.0-alpha.4` 的形式，不带 `v` 前缀。不设就是空串，表示不设门槛。
  格式不对时 Hub 拒绝启动，避免门槛悄悄失效或把所有人挡在外面。
  门槛由客户端读到后自己执行：Hub 不会因此拒绝旧版本的请求，还不认识这个接口的旧客户端不受它约束。
  设之前先确认这个版本已经发布，用户升得上去。
- **公告**：一行纯文本，最多 500 字节（约 160 个汉字），不能有换行。超长或含控制字符时 Hub 拒绝启动。
  它是公开的，任何人都能读到。撤下公告就是把这一行删掉再重启。

响应允许缓存 60 秒，所以改动最多一分钟后才对所有客户端可见；`server_time_ms` 也可能因此滞后至多一分钟。

## 不用容器：systemd

```sh
# 二进制：发布页的 quetzalcoatl-<版本>-hub-linux-x64（或 arm64），也可以自己编译：
#   cd hub && CGO_ENABLED=0 go build -ldflags "-X main.version=2.0.0" ./cmd/quetzalcoatl-hub
install -m 0755 quetzalcoatl-hub /usr/local/bin/quetzalcoatl-hub
useradd --system --no-create-home --shell /usr/sbin/nologin quetzalcoatl-hub
install -d -m 0755 /etc/quetzalcoatl-hub
install -m 0600 hub.env.example /etc/quetzalcoatl-hub/hub.env    # 然后编辑它
install -m 0644 quetzalcoatl-hub.service /etc/systemd/system/quetzalcoatl-hub.service
systemctl daemon-reload
systemctl enable --now quetzalcoatl-hub
systemctl status quetzalcoatl-hub
```

数据在 `/var/lib/quetzalcoatl-hub`，备份的内容与上文相同，直接打包这个目录即可（先 `systemctl stop`）。
默认监听 `127.0.0.1:8443`，适合前面有隧道或反向代理；直出时在 `hub.env` 里把
`QUETZALCOATL_HUB_ADDR` 改成 `0.0.0.0:443`，并按单元文件里的注释放开绑定低位端口的权限。
证书文件要让 `quetzalcoatl-hub` 用户读得到。升级就是换二进制再 `systemctl restart quetzalcoatl-hub`，
回滚就是换回旧二进制。

二进制还带两个子命令：`quetzalcoatl-hub healthcheck` 按当前环境变量请求本机的 `/healthz`，成功退出码为 0
（容器的健康检查用的就是它）；`quetzalcoatl-hub version` 打印版本号。

## 排错

| 现象 | 多半是 |
| --- | --- |
| 容器反复重启，日志最后一行是 `quetzalcoatl-hub invalid …` 或 `failed to …` | `hub.env` 里某项格式不对，或占位符没换掉。那一行会点名是哪一项 |
| 设备上传密文包被拒（403，`INTEGRITY_VIOLATION`） | 代理改写了 `Host` 头，或 `QUETZALCOATL_HUB_PUBLIC_URL` 与设备实际访问的地址不一致 |
| 设备上传大一点的包就失败（413） | 代理的请求体上限小于 16 MiB |
| 中继连上几十秒就断 | 代理没有放行 WebSocket 升级，或空闲超时太短 |
| 通行密钥注册或登录报来源不被允许 | `QUETZALCOATL_HUB_RP_ID` / `QUETZALCOATL_HUB_ALLOWED_ORIGINS` 与设备访问的地址对不上 |
| `/metrics` 返回 404 | 没设令牌，而请求不是回环直连（经过了代理、隧道或容器端口映射） |
| 设备之间总是走中继、从不直连 | 地址发现没通，逐条对照[地址发现](#地址发现端口必须直连公网)的三个条件 |
