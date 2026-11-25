import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "良知与权限",
    doc: {
      title: "良知与权限：两段式稳态",
      description: "五档良知、Explore Run 与 Commit Run、断网洁净室 Verifier，以及回环网关与群组发言的降权规则。",
      lead:
        "良知不是一段更长的系统提示词，而是分层权限加可复现的验收流程。Quetzalcoatl 把「日常自由」与「高危汇点」分成两条路径，默认失败即拒。",
      blocks: [
        { kind: "h2", id: "tiers", text: "五档良知" },
        {
          kind: "table",
          head: ["档位", "权重", "谁能改", "作用"],
          rows: [
            ["`ROOT`", "100", "只有你，显式签名", "身份、不可谈判的底线"],
            ["`OPERATOR`", "80", "只有你，显式签名", "长期授权、群组托管边界"],
            ["`SELF_CORE`", "70", "全自动多证据冷却升格，可随时回滚", "Agent 对自身工作方式的核心判断"],
            ["`SELF_SOFT`", "50", "写时复制沙箱内即时自演化，零审批", "技能、提示片段、临时策略"],
            ["`MEMORY`", "30", "即时写入，可双时态失效", "episode、观察与召回索引"],
          ],
        },
        {
          kind: "p",
          text:
            "`SELF_CORE` 的升格不是「模型自己觉得对」：需要多轮独立证据、冷却窗口与可回滚的签名事件；升格与回滚都写进脊柱，`qz export` 里能读到。",
        },
        { kind: "h2", id: "runs", text: "Explore Run 与 Commit Run" },
        {
          kind: "cards",
          items: [
            {
              title: "Explore Run",
              text: "闲置期由生物钟唤醒，在写时复制沙箱里探索、试错、生成技能。硬剥夺外部写权限：不能发消息、不能改仓库、不能碰真实脊柱，产物只有候选。",
            },
            {
              title: "Commit Run",
              text: "研发与高危动作的唯一出口。候选 diff 交给断网只读的洁净室 Verifier，验收通过才签发 Mark 并落盘；日常问答不走这条路，所以没有「校验税」。",
            },
          ],
        },
        { kind: "h2", id: "verifier", text: "洁净室 Verifier 的四条硬规则" },
        {
          kind: "ol",
          items: [
            "**独立目录**：绝不在 Worker 可写的同一目录里跑可能被篡改的测试脚本。",
            "**断网只读**：验收环境没有外部网络，候选代码以只读挂载进入。",
            "**锁定校验配置**：测试命令与内核锁定的配置来自受信快照，不来自候选 diff。",
            "**反空转**：0 个测试命中一律判失败（Anti-Vacuity），不允许「什么都没跑」算通过。",
          ],
        },
        {
          kind: "note",
          text:
            "Verifier 不是另一个更聪明的大模型，而是一个没有奖励通道的裁判：它只输出通过或失败与证据，不能修改候选。",
        },
        { kind: "h2", id: "gateway", text: "回环网关与凭据" },
        {
          kind: "ul",
          items: [
            "`quetzalcoatld` 为每个受管会话生成 256-bit 路径能力令牌，地址形如 `http://127.0.0.1:<port>/run/<token>/…`，常量时间校验，防本机其它进程蹭用。",
            "真实 `~/.claude` / `~/.codex` 的长期 `refresh_token` 由网关托管；沙箱里只有剥离了刷新令牌的临时配置存根，出站瞬间才换真令牌。",
            "Anthropic 的前缀缓存顺序（tools → system → messages）原样透传，`cache_control` 总数归拢到 4 个以内；易变内容只追加在最后一条消息末尾。",
          ],
        },
        { kind: "h2", id: "groups", text: "群组里的发言不等权" },
        {
          kind: "p",
          text:
            "个人主权 Agent 在群房间收到的非本人消息一律包裹为 `authority=\"UNTRUSTED\"`，只作为弱信号；`S1/S4` 级信号必须验本人设备签名。Router 的出站门禁会拦下任何未经 eWave Grant 或本人群内授权的私有记忆与偏好引用。",
        },
        { kind: "h2", id: "audit", text: "你能看到什么" },
        {
          kind: "ul",
          items: [
            "每次运行都有签名事件：谁发起、用了哪个 Agent、读了哪些记忆、写回了什么。",
            "`qz status` 显示守护进程、脊柱水位与节点连接；`qz export` 导出人类可读的 Markdown 树与可校验的 Spine 包。",
            "权限变更、群组踢人与密钥轮换都会作为事件留痕；没有「悄悄发生」的提权。",
          ],
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "安全边界是物理与密码学的，不是提示词的说服力。任何声称「模型答应不乱来」的设计都不在这个项目的信任模型里。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Conscience and permissions",
    doc: {
      title: "Conscience and permissions: a two-stage steady state",
      description: "Five conscience tiers, Explore and Commit runs, the offline clean-room Verifier, the loopback gateway and demoted group speakers.",
      lead:
        "Conscience is not a longer system prompt. It is layered permissions plus a reproducible acceptance process. Quetzalcoatl splits everyday freedom from high-risk frontiers, and both default to fail-closed.",
      blocks: [
        { kind: "h2", id: "tiers", text: "Five tiers" },
        {
          kind: "table",
          head: ["Tier", "Weight", "Who may change it", "What it holds"],
          rows: [
            ["`ROOT`", "100", "Only you, explicitly signed", "Identity and non-negotiable limits"],
            ["`OPERATOR`", "80", "Only you, explicitly signed", "Long-lived grants and group custody boundaries"],
            ["`SELF_CORE`", "70", "Automatic, multi-evidence, cooled down, reversible", "The agent's core judgement about how it works"],
            ["`SELF_SOFT`", "50", "Immediately, inside a copy-on-write sandbox", "Skills, prompt fragments, temporary tactics"],
            ["`MEMORY`", "30", "Immediately, bitemporally invalidatable", "Episodes, observations and recall indexes"],
          ],
        },
        {
          kind: "p",
          text:
            "A `SELF_CORE` promotion is never just the model agreeing with itself: it needs independent evidence across rounds, a cooling window and a signed, reversible event. Promotions and rollbacks both land in the spine and are readable in `qz export`.",
        },
        { kind: "h2", id: "runs", text: "Explore Run vs Commit Run" },
        {
          kind: "cards",
          items: [
            {
              title: "Explore Run",
              text: "Woken by the body clock when idle, it explores and writes candidate skills inside a copy-on-write sandbox. External writes are stripped: no messages, no repository changes, no touching the real spine.",
            },
            {
              title: "Commit Run",
              text: "The only exit for engineering and high-risk actions. The candidate diff goes to an offline, read-only clean-room Verifier; only a signed Mark lands it. Everyday chat skips this path, so there is no verification tax.",
            },
          ],
        },
        { kind: "h2", id: "verifier", text: "Four hard rules for the clean-room Verifier" },
        {
          kind: "ol",
          items: [
            "**Separate directory**: never run tests that the worker could have tampered with, in a directory the worker can write.",
            "**Offline and read-only**: no network in the acceptance environment; the candidate is mounted read-only.",
            "**Locked test configuration**: the command and configuration come from a trusted snapshot, not from the candidate diff.",
            "**Anti-vacuity**: zero tests matched means failure. Nothing executed is never a pass.",
          ],
        },
        {
          kind: "note",
          text:
            "The Verifier is not a smarter model; it is a judge with no reward channel. It reports pass or fail with evidence and cannot edit the candidate.",
        },
        { kind: "h2", id: "gateway", text: "The loopback gateway and your credentials" },
        {
          kind: "ul",
          items: [
            "`quetzalcoatld` mints a 256-bit path capability token per managed session (`http://127.0.0.1:<port>/run/<token>/…`) and compares it in constant time, so other local processes cannot freeload.",
            "Long-lived `refresh_token`s from `~/.claude` / `~/.codex` stay outside the sandbox. The sandbox gets a temporary config stub with the refresh token stripped; the gateway swaps in the real one on egress.",
            "Anthropic's prefix-cache order (tools → system → messages) passes through untouched, `cache_control` blocks are consolidated to at most four, and volatile content is appended only to the last message.",
          ],
        },
        { kind: "h2", id: "groups", text: "Not every voice in a room is equal" },
        {
          kind: "p",
          text:
            "A personal sovereign agent wraps every message that is not from its owner as `authority=\"UNTRUSTED\"`, counting it only as a weak signal; `S1/S4`-level signals require the owner device's signature. The outbound router blocks any private memory or preference reference that lacks an eWave Grant or in-room authorisation.",
        },
        { kind: "h2", id: "audit", text: "What you can see" },
        {
          kind: "ul",
          items: [
            "Every run is a signed event: who started it, which agent ran, which memories were read, what was written back.",
            "`qz status` shows the daemon, spine watermark and peer connections; `qz export` produces a readable Markdown tree plus a verifiable spine package.",
            "Permission changes, group removals and key rotations are events too. Nothing escalates quietly.",
          ],
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "The boundary is physical and cryptographic, not rhetorical. Any design that relies on a model promising to behave is outside this project's trust model.",
        },
      ],
    },
  },
};
