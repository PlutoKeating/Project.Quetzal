# sync · Quetzal 同步服务

让同一个 agent 的几具身体（手机、电脑、服务器上的运行基座，以及灵魂桥）互相找到、直接连起来，连不上时替它们中转。服务包括：

- **账户与绑定**：账号来自一个 OpenID Connect 身份服务；身体用设备码绑定到账户（像电视登录那样：身体显示一个码，你在网页上输入并核对指纹）。
- **信令与在场**：身体在线时保持一条 WebSocket；同一 agent 的身体之间转发 WebRTC 的连接信息，告诉彼此谁在线。
- **STUN 与 TURN 中转**（coturn）：帮身体发现自己的公网地址；两边都打不通时中转（流量是端对端加密的）。
- **HTTPS**（Caddy）：自动申请并续期证书。80 / 443 不能用的服务器（已被占用，或中国大陆机房、域名没有备案）可以改用**隧道模式**：不起 Caddy，交给服务器上已有的反向隧道（例如 Cloudflare Tunnel），见 [docs/QUICK_START.md](docs/QUICK_START.md) §2.1。

这个目录与仓库的其他部分没有任何代码依赖，可以单独部署在一台有公网地址的 Linux 服务器上。

## 部署

需要：一台 Linux 服务器（有公网 IPv4），一个指向它的域名，一个 OpenID Connect 身份服务（自建的 Rauthy、Keycloak、Authelia 等都行）里的机密客户端。

```bash
git clone https://github.com/PlutoKeating/Project.Quetzal.git
cd Project.Quetzal/sync
./start.sh
```

第一次运行会：检查 Docker（没有就询问后用官方脚本安装）→ 生成 `.env` 并引导你填写域名与 OIDC 登录（Issuer、Client ID、Client secret）→ 放行本机防火墙（ufw / firewalld）→ 构建并启动三个容器 → 等待健康检查与 HTTPS 就绪。之后再运行就是按当前配置重新启动。

云服务器还要在**安全组**里放行：TCP 80、443、3478；UDP 443、3478、49160–49250（TURN 中转端口段，可在 `.env` 里改）。隧道模式只需要 TCP 3478 与 UDP 3478、49160–49250。

| 命令 | 作用 |
|---|---|
| `./start.sh` | 启动，或改了 `.env` 之后重启 |
| `./start.sh status` | 容器状态与健康检查 |
| `./start.sh logs [sync｜caddy]` | 跟踪日志（coturn 不记日志：日志里会有访客 IP） |
| `./start.sh update` | `git pull` 后重建并重启 |
| `./start.sh stop` | 停止（数据保留在 `data/`） |

更多：[部署与运维](docs/QUICK_START.md) · [架构与安全](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [开发](docs/README.md)
