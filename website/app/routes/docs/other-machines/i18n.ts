import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "服务器与无界面机器",
    doc: {
      title: "服务器与无界面机器",
      description: "在服务器、树莓派或 NAS 上只跑 qz 与 quetzalcoatld；自建 quetzalcoatl-hub 的端口与部署要求。",
      lead:
        "没有桌面也能做身体。`qz` 与 `quetzalcoatld` 不依赖图形会话，服务器、树莓派与 NAS 都能作为脊柱节点或纯算力节点加入你的扁平网络。",
      blocks: [
        { kind: "h2", id: "install", text: "最小安装" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --no-desktop

# 让 systemd 用户服务在未登录时也运行
sudo loginctl enable-linger "$USER"
systemctl --user enable --now quetzalcoatld
qz status`,
        },
        {
          kind: "note",
          text:
            "`loginctl enable-linger` 需要管理员权限，所以安装器不会替你执行；它只写单元文件并把命令打印出来。这一步不做，机器重启后守护进程不会自己起来。",
        },
        { kind: "h2", id: "pair", text: "加入你的网络" },
        {
          kind: "p",
          text:
            "在服务器上执行 `qz pair`，终端会显示一次性配对码；手机或桌面端确认后，这台机器成为算力节点。`qz nodes` 可以看到它的在线状态与能力标签，任务会按标签派发过来。",
        },
        {
          kind: "code",
          title: "shell",
          text: `qz pair
qz nodes
qz status`,
        },
        { kind: "h2", id: "hub", text: "自建 quetzalcoatl-hub（可选）" },
        {
          kind: "p",
          text:
            "`quetzalcoatl-hub` 是零算力、零明文的引导服：只做渲染会合、密文 Packfile 中转与节点发现，读不到任何消息内容。它是 Go 单静态二进制，部署在一台有公网地址的机器上即可。",
        },
        {
          kind: "table",
          head: ["端口", "协议", "用途"],
          rows: [
            ["443/tcp", "TLS + `iroh-relay-v2` 混合帧", "中继与发现；反代下 TLS Exporter 不匹配时会优雅退回 `ServerChallenge`"],
            ["7842/udp", "`/iroh-qad/0`", "公网反射地址发现（QAD）。iroh 1.x 已移除 STUN，缺这个端口只能走 relay"],
            ["443/tcp `GET /ping`", "HTTPS", "健康检查与存活探测"],
          ],
        },
        {
          kind: "code",
          title: "shell",
          text: `# 部署后先自检
curl -fsS https://hub.example.com/ping

# 客户端侧：把节点指向你的 hub（写入本机配置）
# 具体字段见 qz status / qz nodes 的输出与随包的 hub 部署说明`,
        },
        { kind: "h2", id: "no-systemd", text: "没有 systemd 的机器" },
        {
          kind: "p",
          text:
            "容器或精简系统里可以前台运行 `quetzalcoatld`，用你已有的进程管理器（s6、runit、supervisord）托管；也可以写一条 `crontab @reboot`。安装器不会假装已经托管成功：它明确告诉你单元文件写了但没有启用。",
        },
        { kind: "h2", id: "web", text: "用浏览器当界面" },
        {
          kind: "p",
          text:
            "无界面机器可以用同一账号在另一台设备的浏览器里打开 Web 端（`surfaces/web`，Web Worker 里的 WASM E2EE + OPFS 本地脊柱）。Web 端是薄客户端，脊柱仍然只由那台机器的 `quetzalcoatld` 持有。",
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "不要把 `quetzalcoatld` 的回环网关直接暴露到公网。跨机访问一律走 iroh 配对后的加密通道，或你自建 hub 的中继。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Servers and headless machines",
    doc: {
      title: "Servers and headless machines",
      description: "Run only qz and quetzalcoatld on a server, Raspberry Pi or NAS; ports and deployment notes for a self-hosted quetzalcoatl-hub.",
      lead:
        "A body does not need a desktop. `qz` and `quetzalcoatld` have no graphical dependency, so servers, Raspberry Pis and NAS boxes can join your flat network as spine hosts or pure compute nodes.",
      blocks: [
        { kind: "h2", id: "install", text: "Minimal install" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --no-desktop

# keep the systemd user service running without a login session
sudo loginctl enable-linger "$USER"
systemctl --user enable --now quetzalcoatld
qz status`,
        },
        {
          kind: "note",
          text:
            "`loginctl enable-linger` needs administrator rights, so the installer never runs it for you; it writes the unit and prints the command. Without this step the daemon will not come back after a reboot.",
        },
        { kind: "h2", id: "pair", text: "Join your network" },
        {
          kind: "p",
          text:
            "Run `qz pair` on the server; the terminal shows a one-time pairing code. Confirm it on your phone or desktop and this machine becomes a compute node. `qz nodes` shows its online state and capability tags, which is how subtasks are routed here.",
        },
        {
          kind: "code",
          title: "shell",
          text: `qz pair
qz nodes
qz status`,
        },
        { kind: "h2", id: "hub", text: "Self-host quetzalcoatl-hub (optional)" },
        {
          kind: "p",
          text:
            "`quetzalcoatl-hub` is a zero-compute, zero-plaintext rendezvous server: presence, encrypted packfile relay and node discovery only. It cannot read message content. It ships as a single static Go binary; put it on any machine with a public address.",
        },
        {
          kind: "table",
          head: ["Port", "Protocol", "Purpose"],
          rows: [
            ["443/tcp", "TLS + `iroh-relay-v2` mixed frames", "Relay and discovery; behind a reverse proxy a TLS Exporter mismatch degrades gracefully to `ServerChallenge`"],
            ["7842/udp", "`/iroh-qad/0`", "Public reflexive address discovery (QAD). iroh 1.x removed STUN, so without this port only relay works"],
            ["443/tcp `GET /ping`", "HTTPS", "Health and liveness probe"],
          ],
        },
        {
          kind: "code",
          title: "shell",
          text: `# after deploying, check it from outside
curl -fsS https://hub.example.com/ping

# client side: point your node at this hub (stored in local config)
# see the output of qz status / qz nodes and the hub deployment notes shipped alongside`,
        },
        { kind: "h2", id: "no-systemd", text: "Machines without systemd" },
        {
          kind: "p",
          text:
            "In a container or a minimal image you can run `quetzalcoatld` in the foreground under whatever supervisor you already use (s6, runit, supervisord), or add a `crontab @reboot` line. The installer never pretends it supervised anything: it says the unit was written but not enabled.",
        },
        { kind: "h2", id: "web", text: "Use a browser as the UI" },
        {
          kind: "p",
          text:
            "For a headless machine, open the web surface (`surfaces/web`, WASM E2EE in a Web Worker plus an OPFS local spine) from another device signed into the same account. The web surface is a thin client; the spine is still owned solely by that machine's `quetzalcoatld`.",
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "Never expose the `quetzalcoatld` loopback gateway to the public internet. Cross-machine access always goes through an iroh-paired encrypted channel or your own hub relay.",
        },
      ],
    },
  },
};
