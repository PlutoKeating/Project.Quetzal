import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "多身体与群组",
    doc: {
      title: "多身体与群组：一条脊柱，多具身体",
      description: "设备配对、flat 算力网、四种群组协同拓扑、断网租约与共享角色 Agent 的密码学边界。",
      lead:
        "一台机器是一具身体。脊柱只有一条，身体可以很多；多人协作用密码学隔离的独立 Agent 实例，而不是在一个实例里做分舱。",
      blocks: [
        { kind: "h2", id: "one-spine", text: "单主机唯一脊柱持有者" },
        {
          kind: "p",
          text:
            "只有后台 `quetzalcoatld` 直接打开 `spine.sqlite` 的 WAL 与 iroh 节点密钥。GTK4 / SwiftUI / WinUI 3 客户端与 `qz` CLI 检测到守护进程在线时一律走本地 IPC 薄客户端，从根上避免 `SQLITE_BUSY` 与两个节点互相踢下线。",
        },
        {
          kind: "code",
          title: "shell",
          text: `qz up                 # 启动守护进程（已在跑则无操作）
qz pair               # 扫码 5 秒配对另一台设备
qz nodes              # 列出已配对节点与在线状态
qz status             # 脊柱水位、Router 所在节点、连接质量`,
        },
        { kind: "h2", id: "fabric", text: "扁平算力网与无感接班" },
        {
          kind: "p",
          text:
            "配对后的设备组成端到端加密的扁平网络：子任务按能力标签派发到任意在线节点，由那台机器上的编码 Agent 执行。Router 所在节点离线时，另一台持有同一帐号密钥的在线节点会接管续跑；两端都断网时，任务留在本地 Outbox，不会假装成功。",
        },
        {
          kind: "note",
          text:
            "公网打洞依赖 iroh 1.5 的 QUIC 与 UDP `:7842` 的 QAD 响应器；只放行 443 的环境仍可经 relay 通信，但延迟更高。自建 `quetzalcoatl-hub` 的端口要求见「服务器与无界面机器」。",
        },
        { kind: "h2", id: "topologies", text: "四种原生协同拓扑" },
        {
          kind: "table",
          head: ["拓扑", "谁在群里", "边界"],
          rows: [
            [
              "① 联邦群",
              "多个人，各自带私人主权 Agent",
              "私人 Agent 只按 eWave `RELATION / Grant` 投射脱敏结论，例如「周二下午不可用」，绝不交出原始记忆",
            ],
            [
              "② 常驻岗位角色",
              "一个物理隔离的独立 Agent 实例，例如项目 Maintainer",
              "脊柱只放该群公共知识与规范；`AccountRootKey` 由主监护节点持有，托管经租约选举",
            ],
            [
              "③ 异构编码编队",
              "同一用户的多个编码 Agent，例如架构 + 主程 + 审查",
              "各自独立 worktree，未提交代码经 `ArtifactRef::GitTree` 零拷贝交接",
            ],
            [
              "④ 跨机构受限委托",
              "不同家庭 / 机构的 Agent 之间",
              "JWS 签名 `AgentCard` 发现能力，衰减 `Mandate` 授权单次任务；需要人类拍板时升级为 `AUTH_REQUIRED`",
            ],
          ],
        },
        { kind: "h2", id: "partition", text: "断网：租约与 Outbox" },
        {
          kind: "p",
          text:
            "联网并持有 `quetzalcoatl-hub` 的 `witness_epoch` 时才允许全量外部通道写入。断网超过宽限期进入 `Partition-Local Lease`：本地对话、探索与长辈紧急告警照常；非幂等的公网外发消息一律进 Outbox，等重新拿到 `witness_epoch` 后对账再发，避免公网双发脑裂。",
        },
        { kind: "h2", id: "watermark", text: "群组提交水位线：两层，先便宜后昂贵" },
        {
          kind: "ol",
          items: [
            "**hub 层**：校验 `mls_epoch`。纯密钥轮换导致的不匹配，直接用 `GroupEpochKey[e+1]` 重加密密文重发，不重跑大模型。",
            "**Router 层**：语义控场。只有增量里点名了本 Agent、`@agents`、同父话题追问或 `cancel/steer` 时才重读重算；无关闲聊与表情直接快进，附挂 `causal_parent_seq` 提交。",
          ],
        },
        {
          kind: "note",
          text:
            "这样活跃群不会因为一次 409 就无限重生成，也让「没叫我」的消息不消耗模型额度。",
        },
        { kind: "h2", id: "custody", text: "共享角色 Agent 的硬边界" },
        {
          kind: "ul",
          items: [
            "**1 实例 = 1 群信任域**：绝不把同一个共享角色 Agent 同时拉进保密等级不同的两个群。",
            "**可吊销托管**：协管员通过绑定 `openmls` 成员身份的 `StewardGrant` 行权；被踢出群即自动吊销管理权并轮换 `EpochKey[e+1]`。",
            "**密钥归属**：`AccountRootKey` 由主监护节点持有并有分片备份，托管节点只拿租约，不拿根密钥。",
            "**发言降权**：非主人消息一律 `authority=\"UNTRUSTED\"`，只计弱信号；`S1/S4` 级信号必须验本人设备签名。",
          ],
        },
        {
          kind: "p",
          text: "群的公开知识、成员名单与审计事件都在同一条脊柱上，`qz export` 可以按群导出，不会把私人记忆混进去。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Multi-body and groups",
    doc: {
      title: "Multi-body and groups: one spine, many bodies",
      description: "Device pairing, the flat compute fabric, the four group topologies, offline leases and the cryptographic boundaries of shared-role agents.",
      lead:
        "A machine is a body. There is one spine and there can be many bodies. Collaboration between people uses cryptographically isolated agent instances, never compartments inside one instance.",
      blocks: [
        { kind: "h2", id: "one-spine", text: "One spine owner per host" },
        {
          kind: "p",
          text:
            "Only the background `quetzalcoatld` opens the `spine.sqlite` WAL and the iroh node key. GTK4 / SwiftUI / WinUI 3 clients and the `qz` CLI become thin local-IPC clients when the daemon is online, which removes `SQLITE_BUSY` and the two-nodes-kicking-each-other failure mode at the root.",
        },
        {
          kind: "code",
          title: "shell",
          text: `qz up                 # start the daemon (no-op when already running)
qz pair               # pair another device by scanning a code (about 5 s)
qz nodes              # paired nodes and their online state
qz status             # spine watermark, Router host, connection quality`,
        },
        { kind: "h2", id: "fabric", text: "A flat fabric that hands over silently" },
        {
          kind: "p",
          text:
            "Paired devices form an end-to-end encrypted flat network: subtasks are dispatched by capability tag to any online node and run by the coding agent on that machine. If the node hosting the Router goes offline, another online node holding the same account key takes over. When both sides are offline the task stays in the local Outbox instead of pretending to have succeeded.",
        },
        {
          kind: "note",
          text:
            "NAT traversal relies on iroh 1.5 QUIC plus the UDP `:7842` QAD responder. Networks that only allow 443 still work through a relay, with higher latency. Port requirements for a self-hosted `quetzalcoatl-hub` are in “servers and headless machines”.",
        },
        { kind: "h2", id: "topologies", text: "Four native collaboration topologies" },
        {
          kind: "table",
          head: ["Topology", "Who is in the room", "Boundary"],
          rows: [
            [
              "① Federated group",
              "Several people, each with a private sovereign agent",
              "Each agent projects only de-identified conclusions through eWave `RELATION / Grant`, e.g. “not available Tuesday afternoon”; raw memory never leaves",
            ],
            [
              "② Standing role",
              "One physically isolated agent instance, e.g. a project maintainer",
              "Its spine holds only the group's public knowledge and rules; the `AccountRootKey` stays with the custodian node; hosting is lease-elected",
            ],
            [
              "③ Heterogeneous squad",
              "Several coding agents of one user, e.g. architect + implementer + reviewer",
              "Each has its own worktree; uncommitted work is handed over zero-copy as `ArtifactRef::GitTree`",
            ],
            [
              "④ Cross-organisation mandate",
              "Agents from different households or institutions",
              "A JWS-signed `AgentCard` advertises capabilities; a decaying `Mandate` authorises one task and escalates to `AUTH_REQUIRED` when a human must decide",
            ],
          ],
        },
        { kind: "h2", id: "partition", text: "Offline: leases and the Outbox" },
        {
          kind: "p",
          text:
            "Full outbound channel writes require a `witness_epoch` from `quetzalcoatl-hub`. Beyond the grace period the node enters a `Partition-Local Lease`: local chat, exploration and elderly emergency alerts keep working, while non-idempotent outbound messages queue in the Outbox and are reconciled once the epoch is regained, so the public network never sees a split-brain double send.",
        },
        { kind: "h2", id: "watermark", text: "Group commit watermark: cheap first, expensive second" },
        {
          kind: "ol",
          items: [
            "**hub layer**: validate `mls_epoch`. On a pure key rotation mismatch, re-encrypt with `GroupEpochKey[e+1]` and resend without re-running a model.",
            "**Router layer**: semantic floor control. Re-read and re-compute only when the delta mentions this agent, `@agents`, a follow-up in the same thread, or `cancel/steer`. Idle chatter and reactions are fast-forwarded with a `causal_parent_seq`.",
          ],
        },
        {
          kind: "note",
          text: "A busy group therefore never loops on a single 409, and messages that do not call on you cost no model tokens.",
        },
        { kind: "h2", id: "custody", text: "Hard boundaries for shared-role agents" },
        {
          kind: "ul",
          items: [
            "**One instance, one trust domain**: never invite the same shared-role agent into two groups with different secrecy levels.",
            "**Revocable custody**: co-managers act through a `StewardGrant` bound to their `openmls` membership; removal from the group revokes it and rotates `EpochKey[e+1]`.",
            "**Key ownership**: the `AccountRootKey` stays with the custodian node and has sharded backups; a hosting node holds a lease, not the root key.",
            "**Demoted speakers**: anything not from the owner is `authority=\"UNTRUSTED\"` and counts as a weak signal; `S1/S4`-level signals require the owner device's signature.",
          ],
        },
        {
          kind: "p",
          text: "Group knowledge, membership and audit events live on the same spine. `qz export` can export a single group without mixing in private memory.",
        },
      ],
    },
  },
};
