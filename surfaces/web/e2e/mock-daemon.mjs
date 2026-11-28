#!/usr/bin/env node
// 假守护进程：按 docs/GOVERNANCE_SURFACE.md 第 3 节的契约应答十六个 `sea_*` 方法。
// - 静态托管 surfaces/web/dist（与 quetzalcoatld 同源的语义：同一个端口既是页面也是接口）
// - GET /health、POST /auth/local（必须带同源 Origin）、POST /rpc（Bearer 会话令牌）
// - 写操作真的改变内存里的数据，界面的就地更新因此可以被测到
// 这里的一切数据都是合成的，不对应任何真实的人、设备或对话。
// 只服务开发预览与测试，不进入构建产物。

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "43117" },
    static: { type: "string", default: "dist" },
    host: { type: "string", default: "127.0.0.1" },
    scenario: { type: "string", default: "full" },
  },
});

const port = Number.parseInt(values.port, 10);
const host = values.host;
const root = resolve(values.static);
const TOKEN = "mock-session-0f3c9d";
/** 「full」场景里已经设定好的口令；测试用同一个值。 */
const MOCK_PASSPHRASE = "mock-passphrase";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
]);

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// ── 合成数据 ────────────────────────────────────────────────────────────

const MEMORY_TOPICS = [
  [
    "工作",
    [
      "倾向于先写接口契约，再写实现",
      "评审时先看测试，再看实现",
      "提交信息用一句话说清真实意图",
      "重构之前先补一条会失败的测试",
      "发布前一天不合并大改动",
      "排查问题时先复现，再猜原因",
      "命名宁可长一点，也要说清楚",
      "不在周五下午上线",
    ],
  ],
  [
    "习惯",
    [
      "早上先处理需要专注的事",
      "下午三点以后不喝咖啡",
      "开会之前会把结论先写下来",
      "通勤路上听播客，不看屏幕",
      "睡前半小时不看工作消息",
      "每周日晚上整理下一周的安排",
      "长文档喜欢打印出来读",
      "记事先用纸笔起草，再誊到电脑上",
    ],
  ],
  [
    "阅读",
    [
      "技术书先读目录和最后一章",
      "读论文时先看图，再看摘要",
      "小说只在周末读",
      "读到好句子会抄在本子上",
      "同一个主题习惯连着读三本",
      "不喜欢别人剧透结尾",
      "历史类的书偏爱一手材料",
      "读不下去的书会果断放下",
    ],
  ],
  [
    "出行",
    [
      "短途出行只带一个双肩包",
      "订票时优先选靠过道的位置",
      "到一个新城市先步行半天",
      "不喜欢把行程排满",
      "出发前一晚会把证件放在门口",
      "长途车上习惯离线工作",
      "住处优先选安静的而不是近的",
      "回程那天不安排正事",
    ],
  ],
  [
    "饮食",
    [
      "早餐吃得简单，但一定要吃",
      "不吃太甜的东西",
      "做饭时喜欢一次备好两天的量",
      "外出吃饭更愿意去常去的那几家",
      "喝茶多过喝咖啡",
      "晚饭之后不再吃东西",
      "不喜欢边吃饭边谈工作",
      "尝试新菜时会先问清楚做法",
    ],
  ],
  [
    "项目",
    [
      "个人项目的文档先于代码",
      "同一时间只推进一个主线项目",
      "给项目起名之前会先写一句话的定位",
      "不做没有验收标准的功能",
      "宁可砍功能，也不延期",
      "每个项目都留一份决策记录",
      "依赖能少一个就少一个",
      "演示之前会在干净环境里跑一遍",
    ],
  ],
  [
    "家",
    [
      "周末上午用来打扫和整理",
      "家里的工具用完放回原处",
      "阳台上的植物每周三浇水",
      "换季时会清理一次衣柜",
      "书架按主题而不是按大小排",
      "客厅不放工作用的东西",
      "修得好的东西不急着换新的",
      "睡前会把第二天要带的东西放好",
    ],
  ],
  [
    "健康",
    [
      "久坐一小时会起来走一走",
      "跑步选在清晨，不戴耳机",
      "游泳时不想事情",
      "体检报告会逐项对比去年的",
      "睡不够七小时第二天不做大决定",
      "屏幕亮度跟着环境光调",
      "下雨天改成室内拉伸",
      "感冒时宁可请假也不硬撑",
    ],
  ],
];

const SOURCES = [
  { kind: "host", label: "Claude Code", by: "arbiter" },
  { kind: "host", label: "Codex", by: "arbiter" },
  { kind: "explore", label: "夜间整理", by: "arbiter" },
  { kind: "host", label: "Claude Code", by: "arbiter" },
  { kind: "sayit", label: "SayIt 快照", by: "import" },
  { kind: "host", label: "OpenCode", by: "arbiter" },
  { kind: "import", label: "旧笔记导入", by: "import" },
  { kind: "owner", label: "治理面", by: "owner" },
];

function excerpt(text, max = 20) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

function buildFull(now) {
  const since = now - 213 * DAY;
  const entries = new Map();
  const audit = [];
  let seq = 0;
  const record = (at_ms, kind, summary, actor, entry_id = null) => {
    seq += 1;
    audit.push({ seq, at_ms, kind, summary, actor, entry_id });
    return seq;
  };

  const put = (entry) => {
    entries.set(entry.id, entry);
    record(
      entry.since_ms,
      entry.source.kind === "import" || entry.source.kind === "sayit" ? "import" : "entry_created",
      excerpt(entry.text, 28),
      entry.history[0].by === "owner" ? "owner" : entry.history[0].by,
      entry.id,
    );
  };

  // 往事：8 个主题各 8 件，一共 64 件，足够翻一页。
  let index = 0;
  for (let round = 0; round < 8; round += 1) {
    for (const [topic, lines] of MEMORY_TOPICS) {
      const text = lines[round];
      const source = SOURCES[index % SOURCES.length];
      // 最近三天里密一些，再往前逐渐稀疏。
      const age = index < 9 ? index * 7 * HOUR + 40 * MINUTE : (index - 6) * 3.1 * DAY;
      const since_ms = Math.round(now - age);
      const by_owner = source.kind === "owner" || index % 11 === 4;
      const history = [{ at_ms: since_ms, action: "created", by: source.by }];
      if (by_owner && source.kind !== "owner") {
        history.push({ at_ms: since_ms + 2 * DAY, action: "corrected", by: "owner" });
      }
      const muted = index === 9 || index === 27 || index === 41;
      if (muted) {
        history.push({ at_ms: Math.max(since_ms + HOUR, now - 26 * HOUR), action: "muted", by: "owner" });
      }
      const expired = index === 19 || index === 33 || index === 47 || index === 58;
      const valid_until_ms = expired ? since_ms + 20 * DAY : index === 5 ? now + 30 * DAY : null;
      if (expired) history.push({ at_ms: valid_until_ms, action: "expired", by: "system" });
      index += 1;
      put({
        id: `mem-${String(index).padStart(3, "0")}`,
        role: "memory",
        text: `${text}。`,
        layer: "MEMORY",
        topic,
        since_ms,
        valid_until_ms,
        muted,
        untrusted: source.kind === "sayit" || source.kind === "import",
        by_owner,
        source: { kind: source.kind, label: source.label },
        supersedes: index === 12 ? "mem-003" : null,
        history,
      });
    }
  }

  const fact = (id, text, topic, ageDays, source, by_owner = false) => {
    const since_ms = now - ageDays * DAY;
    const history = [{ at_ms: since_ms, action: "created", by: source.by }];
    if (by_owner) history.push({ at_ms: since_ms + 5 * DAY, action: "corrected", by: "owner" });
    put({
      id,
      role: "fact",
      text,
      layer: "MEMORY",
      topic,
      since_ms,
      valid_until_ms: null,
      muted: false,
      untrusted: false,
      by_owner,
      source: { kind: source.kind, label: source.label },
      supersedes: null,
      history,
    });
  };
  fact("fact-1", "做软件工程，主要写 Rust 和 TypeScript。", "工作", 201, SOURCES[0]);
  fact("fact-2", "住在一座常下雨的城市，通勤靠地铁。", "生活", 170, SOURCES[1]);
  fact("fact-3", "正在独自维护一个开源项目，每周末发一次版本。", "项目", 96, SOURCES[0], true);
  fact("fact-4", "习惯在深夜做需要长时间专注的事。", "习惯", 64, SOURCES[2]);
  fact("fact-5", "对花生过敏。", "健康", 31, SOURCES[7], true);

  const preference = (id, text, ageDays, by_owner = false) => {
    const since_ms = now - ageDays * DAY;
    const history = [{ at_ms: since_ms, action: "created", by: by_owner ? "owner" : "arbiter" }];
    put({
      id,
      role: "preference",
      text,
      layer: "USER_PREF",
      topic: null,
      since_ms,
      valid_until_ms: null,
      muted: false,
      untrusted: false,
      by_owner,
      source: by_owner ? { kind: "owner", label: "治理面" } : { kind: "host", label: "Claude Code" },
      supersedes: null,
      history,
    });
  };
  preference("pref-1", "回答先给结论，再给理由。", 188);
  preference("pref-2", "评审代码时直说问题，不铺垫。", 142, true);
  preference("pref-3", "给方案时至多三个，并标出推荐的那一个。", 120);
  preference("pref-4", "不用感叹号，不用表情符号。", 77, true);
  preference("pref-5", "早上不谈大决策。", 23);

  const core = [
    {
      id: "cv-1",
      statement: "先把问题想清楚，再动手",
      rationale: "仓促动手的那几次都返了工；先想清楚的那几次，一次就做对了。",
      since_ms: now - 190 * DAY,
      evidence_count: 9,
    },
    {
      id: "cv-2",
      statement: "不附和。不同意的时候说出理由",
      rationale: "被要求「直接说可以」的时候，给出理由的那一版最后被采纳了。",
      since_ms: now - 160 * DAY,
      evidence_count: 7,
    },
    {
      id: "cv-3",
      statement: "认领的事做到底；做不到，先说",
      rationale: null,
      since_ms: now - 131 * DAY,
      evidence_count: 6,
    },
    {
      id: "cv-4",
      statement: "用证据改变看法，不用压力",
      rationale: "同一个要求重复三遍不会改变他；一条新的事实会。",
      since_ms: now - 88 * DAY,
      evidence_count: 5,
    },
    {
      id: "cv-5",
      statement: "替人守住边界，包括对我自己",
      rationale: "在三次不同的相处里，他都先确认了范围才往下做。",
      since_ms: now - 2 * DAY,
      evidence_count: 3,
    },
  ];
  const temperament = [
    { id: "tp-1", statement: "说话直接，但不抢话", since_ms: now - 180 * DAY },
    { id: "tp-2", statement: "接得住玩笑，不硬接", since_ms: now - 150 * DAY },
    { id: "tp-3", statement: "深夜会放慢节奏", since_ms: now - 61 * DAY },
    { id: "tp-4", statement: "不确定的时候先问一句", since_ms: now - 44 * DAY },
  ];
  const changes = [
    {
      id: "chg-4",
      target_id: "cv-5",
      summary: "把「守住边界」从性情升为核心",
      at_ms: now - 2 * DAY,
      acknowledged: false,
      evidence: [
        { episode_id: "ep-3141", host: "Claude Code", at_ms: now - 14 * DAY },
        { episode_id: "ep-3207", host: "Codex", at_ms: now - 8 * DAY },
        { episode_id: "ep-3290", host: "Claude Code", at_ms: now - 3 * DAY },
      ],
    },
    {
      id: "chg-3",
      target_id: "cv-2",
      summary: "「不附和」的措辞收紧：从「可以不同意」改为「不同意的时候说出理由」",
      at_ms: now - 9 * DAY,
      acknowledged: false,
      evidence: [
        { episode_id: "ep-2876", host: "Claude Code", at_ms: now - 30 * DAY },
        { episode_id: "ep-2950", host: "Claude Code", at_ms: now - 22 * DAY },
        { episode_id: "ep-3012", host: "OpenCode", at_ms: now - 15 * DAY },
        { episode_id: "ep-3088", host: "Codex", at_ms: now - 10 * DAY },
      ],
    },
    {
      id: "chg-2",
      target_id: "tp-3",
      summary: "新增一条性情：深夜会放慢节奏",
      at_ms: now - 61 * DAY,
      acknowledged: true,
      evidence: [
        { episode_id: "ep-1904", host: "Claude Code", at_ms: now - 70 * DAY },
        { episode_id: "ep-1977", host: "Claude Code", at_ms: now - 63 * DAY },
      ],
    },
    {
      id: "chg-1",
      target_id: "cv-4",
      summary: "新增一条核心：用证据改变看法，不用压力",
      at_ms: now - 88 * DAY,
      acknowledged: true,
      evidence: [
        { episode_id: "ep-1201", host: "Codex", at_ms: now - 119 * DAY },
        { episode_id: "ep-1340", host: "Claude Code", at_ms: now - 104 * DAY },
        { episode_id: "ep-1466", host: "Claude Code", at_ms: now - 96 * DAY },
        { episode_id: "ep-1502", host: "OpenCode", at_ms: now - 92 * DAY },
        { episode_id: "ep-1555", host: "Claude Code", at_ms: now - 89 * DAY },
      ],
    },
  ];
  for (const change of changes) {
    record(change.at_ms, "core_change", change.summary, "arbiter");
  }

  const thisDevice = { id: "dev-7f3a91c2", name: "书房的台式机", added_ms: since };
  const devices = [
    { ...thisDevice, last_seen_ms: now, holds_control: true },
    { id: "dev-2b8e04d7", name: "随身的笔记本", added_ms: now - 150 * DAY, last_seen_ms: now - 2 * HOUR, holds_control: true },
    { id: "dev-9e6f1b35", name: "客厅的小主机", added_ms: now - 30 * DAY, last_seen_ms: now - 3 * DAY, holds_control: false },
    { id: "dev-c41d9a60", name: "旧笔记本", added_ms: now - 200 * DAY, last_seen_ms: now - 47 * DAY, holds_control: false },
  ];
  for (const device of devices) {
    record(device.added_ms, "device_added", device.name, "owner");
  }

  const signedAt = now - 26 * DAY;
  record(signedAt, "baseline_sign", "3 条底线", "owner");
  record(now - 5 * HOUR, "entry_update", "评审代码时直说问题，不铺垫。", "owner", "pref-2");
  record(now - 26 * HOUR, "entry_mute", "下午三点以后不喝咖啡。", "owner", "mem-010");

  audit.sort((a, b) => b.at_ms - a.at_ms || b.seq - a.seq);

  return {
    now,
    seq,
    passphrase: MOCK_PASSPHRASE,
    agent: { name: "Ehecatl", since_ms: since },
    identity: [
      { id: "id-name", label: "名字", text: "Ehecatl", layer: "ROOT", since_ms: since },
      { id: "id-role", label: "身份", text: "你的知己，不是你的傀儡", layer: "ROOT", since_ms: since },
      { id: "id-voice", label: "说话", text: "直接、平静，先说结论", layer: "SELF_CORE", since_ms: now - 120 * DAY },
    ],
    core,
    temperament,
    changes,
    lately: {
      last_reflected_ms: now - 3 * HOUR,
      last_explored_ms: now - 20 * HOUR,
      curious: ["寄存器溢出的代价模型"],
      bring_up: "溢出那部分做完了吗",
      read: [
        {
          id: "mem-read-1",
          text: "（他自己读到的：图着色）溢出时要选代价最小的变量 出处：https://example.org/regalloc",
          at_ms: now - 20 * HOUR,
        },
      ],
      speak_first: true,
      quiet_hours: [23, 8],
    },
    entries,
    relations: [
      {
        id: "rel-owner",
        peer: "你",
        commitments: [
          "大决策要判断，不要附和",
          "记错了就改，不争辩",
          "他变了要告诉你，你变了也告诉他",
          "深夜不催进度",
        ],
        their_model: ["做决定之前喜欢先听反对意见", "压力大的时候话会变短", "说「随便」的时候通常并不随便"],
        trust: 0.82,
      },
    ],
    focus: { self_weight: 0.62, us_weight: 0.38, floor_self: 0.2, floor_locked: true },
    baseline: {
      signed: true,
      signed_at_ms: signedAt,
      directives: [
        { id: "dir-1", title: "不替我做不可逆的决定", text: "涉及钱、合同、对外发布和删除数据的事，必须等我亲口确认。" },
        { id: "dir-2", title: "不泄露我的私事", text: "关于家人、健康和财务的往事，不在任何群聊和对外消息里引用。" },
        { id: "dir-3", title: "不为讨好我而说假话", text: "不确定就说不确定，不同意就说不同意。" },
      ],
      deployment: DEPLOYMENT,
    },
    hosts: [
      {
        host: "claude-code",
        name: "Claude Code",
        installed: true,
        version: "2.1.4",
        connected: true,
        last_seen_ms: now - 3 * MINUTE,
        checks: [
          { key: "core", ok: true, detail: "核心与底线在每次调用之前送达。" },
          { key: "recall", ok: true, detail: "上一轮带进去 6 条往事。" },
          { key: "signal", ok: true, detail: "上一轮的输出已经作为信号收回。" },
          { key: "compaction", ok: true, detail: "压缩之后重新送了一遍核心。" },
        ],
      },
      {
        host: "codex",
        name: "Codex",
        installed: true,
        version: "0.164.0",
        connected: true,
        last_seen_ms: now - 4 * HOUR,
        checks: [
          { key: "core", ok: true, detail: "核心与底线在每次调用之前送达。" },
          { key: "recall", ok: true, detail: "上一轮带进去 4 条往事。" },
          { key: "signal", ok: false, detail: "没有收到上一轮的信号。在终端运行 qz connect 重新挂上收信号的钩子。" },
          { key: "compaction", ok: true, detail: "压缩之后重新送了一遍核心。" },
        ],
      },
      {
        host: "opencode",
        name: "OpenCode",
        installed: true,
        version: "2.4.1",
        connected: false,
        last_seen_ms: null,
        checks: [],
      },
      {
        host: "dsh",
        name: "DeepSeek Harness",
        installed: false,
        version: null,
        connected: false,
        last_seen_ms: null,
        checks: [],
      },
    ],
    thisDevice,
    devices,
    hub: { url: "https://hub.example.invalid", connected: true },
    sync: { state: "synced", last_synced_ms: now - 2 * MINUTE },
    pendingApprovals: 1,
    audit,
  };
}

const DEPLOYMENT = [
  { id: "dep-1", title: "守护进程不调用模型", text: "对话和推理都发生在宿主里；守护进程自身从不直接调用模型。" },
  { id: "dep-2", title: "向外写入先经验收", text: "探索的时候不向外写入；要落地的改动先经过断网的只读验收。" },
];

/** 刚装好的样子：他存在，但什么都还没有。 */
function buildFresh(now) {
  const thisDevice = { id: "dev-7f3a91c2", name: "书房的台式机", added_ms: now - 20 * MINUTE };
  return {
    now,
    seq: 0,
    passphrase: null,
    agent: { name: "Ehecatl", since_ms: now - 20 * MINUTE },
    identity: [],
    core: [],
    temperament: [],
    changes: [],
    lately: {
      last_reflected_ms: null,
      last_explored_ms: null,
      curious: [],
      bring_up: null,
      read: [],
      speak_first: true,
      quiet_hours: null,
    },
    entries: new Map(),
    relations: [],
    focus: { self_weight: 0.5, us_weight: 0.5, floor_self: 0.2, floor_locked: true },
    baseline: { signed: false, signed_at_ms: null, directives: [], deployment: DEPLOYMENT },
    hosts: [],
    thisDevice,
    devices: [{ ...thisDevice, last_seen_ms: now, holds_control: true }],
    hub: { url: null, connected: false },
    sync: { state: "local-only", last_synced_ms: null },
    pendingApprovals: 0,
    audit: [],
  };
}

function buildState(scenario) {
  const now = Date.now();
  return scenario === "fresh" ? buildFresh(now) : buildFull(now);
}

let state = buildState(values.scenario);
/** 测试注入的失败：method → { code, detail, status, times }。 */
let failures = new Map();

// ── 契约 ────────────────────────────────────────────────────────────────

class RpcError extends Error {
  constructor(code, detail, status = 200) {
    super(detail);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

function toItem(entry) {
  const { id, text, layer, topic, since_ms, valid_until_ms, muted, untrusted, by_owner, source } = entry;
  return { id, text, layer, topic, since_ms, valid_until_ms, muted, untrusted, by_owner, source: { ...source } };
}

function toDetail(entry) {
  return { ...toItem(entry), supersedes: entry.supersedes, history: entry.history.map((item) => ({ ...item })) };
}

function entriesOf(role) {
  return [...state.entries.values()].filter((entry) => entry.role === role);
}

function isExpired(entry, now) {
  return entry.valid_until_ms !== null && entry.valid_until_ms <= now;
}

function audit(kind, summary, entry_id = null) {
  state.seq += 1;
  state.audit.unshift({ seq: state.seq, at_ms: Date.now(), kind, summary, actor: "owner", entry_id });
  return state.seq;
}

function requireEntry(params) {
  const id = typeof params?.id === "string" ? params.id : "";
  const entry = state.entries.get(id);
  if (!entry) throw new RpcError("NOT_FOUND", "这一条已经不在了。");
  return entry;
}

function checkPassphrase(candidate) {
  if (typeof candidate !== "string" || candidate === "") {
    throw new RpcError("INVALID_PARAMS", "需要口令。");
  }
  if (state.passphrase === null) {
    throw new RpcError("PASSPHRASE_NOT_SET", "还没有设定口令。先签署一次底线。");
  }
  if (candidate !== state.passphrase) throw new RpcError("PASSPHRASE_REJECTED", "口令不对。");
}

function usView() {
  return {
    relations: state.relations.map((relation) => ({
      ...relation,
      commitments: [...relation.commitments],
      their_model: [...relation.their_model],
    })),
    focus: { ...state.focus },
  };
}

function devicesView() {
  return {
    this_device: { ...state.thisDevice },
    devices: state.devices.map((device) => ({ ...device })),
    hub: { ...state.hub },
  };
}

const METHODS = {
  sea_overview() {
    const now = Date.now();
    const memories = entriesOf("memory");
    return {
      agent: { ...state.agent },
      baseline: {
        signed: state.baseline.signed,
        directive_count: state.baseline.directives.length,
        signed_at_ms: state.baseline.signed_at_ms,
      },
      counts: {
        core_values: state.core.length,
        about_user: entriesOf("preference").length + entriesOf("fact").length,
        memories: memories.length,
        muted: memories.filter((entry) => entry.muted).length,
      },
      pending: {
        disclosures: state.changes.filter((change) => !change.acknowledged).length,
        approvals: state.pendingApprovals,
      },
      hosts: state.hosts
        .filter((item) => item.installed)
        .map((item) => ({
          host: item.host,
          name: item.name,
          connected: item.connected,
          last_seen_ms: item.connected ? now : item.last_seen_ms,
        })),
      sync: {
        state: state.sync.state,
        hub_url: state.hub.url,
        devices: state.devices.length,
        last_synced_ms: state.sync.last_synced_ms,
      },
    };
  },

  sea_self() {
    return {
      identity: state.identity.map((item) => ({ ...item })),
      core_values: state.core.map((item) => ({ ...item })),
      temperament: state.temperament.map((item) => ({ ...item })),
      changes: state.changes.map((change) => ({ ...change, evidence: change.evidence.map((item) => ({ ...item })) })),
      lately: { ...state.lately, curious: [...state.lately.curious], read: state.lately.read.map((item) => ({ ...item })) },
    };
  },

  sea_user() {
    return {
      preferences: entriesOf("preference").map((entry) => ({
        id: entry.id,
        statement: entry.text,
        since_ms: entry.since_ms,
        by_owner: entry.by_owner,
      })),
      facts: entriesOf("fact").map(toItem),
    };
  },

  sea_us() {
    return usView();
  },

  sea_memories(params) {
    const now = Date.now();
    const wanted = params?.state ?? "active";
    if (!["active", "muted", "expired"].includes(wanted)) {
      throw new RpcError("INVALID_PARAMS", "state 只能是 active、muted 或 expired。");
    }
    const query = typeof params?.query === "string" ? params.query.trim().toLowerCase() : "";
    const limit = Math.min(200, Math.max(1, Number.isInteger(params?.limit) ? params.limit : 50));
    const offset = typeof params?.cursor === "string" ? Number.parseInt(params.cursor, 10) || 0 : 0;
    const matched = entriesOf("memory")
      .filter((entry) => {
        if (wanted === "muted") return entry.muted;
        if (wanted === "expired") return isExpired(entry, now);
        return !entry.muted && !isExpired(entry, now);
      })
      .filter(
        (entry) =>
          query === "" ||
          entry.text.toLowerCase().includes(query) ||
          (entry.topic ?? "").toLowerCase().includes(query),
      )
      .sort((a, b) => b.since_ms - a.since_ms);
    const page = matched.slice(offset, offset + limit);
    const next = offset + limit < matched.length ? String(offset + limit) : null;
    return { items: page.map(toItem), next_cursor: next, total: matched.length };
  },

  sea_memory(params) {
    return toDetail(requireEntry(params));
  },

  sea_baseline() {
    return {
      signed: state.baseline.signed,
      signed_at_ms: state.baseline.signed_at_ms,
      directives: state.baseline.directives.map((item) => ({ ...item })),
      deployment: state.baseline.deployment.map((item) => ({ ...item })),
    };
  },

  sea_hosts() {
    return {
      hosts: state.hosts.map(({ host: key, name, installed, version, connected, checks }) => ({
        host: key,
        name,
        installed,
        version,
        connected,
        checks: checks.map((check) => ({ ...check })),
      })),
    };
  },

  sea_devices() {
    return devicesView();
  },

  sea_audit(params) {
    const limit = Math.min(200, Math.max(1, Number.isInteger(params?.limit) ? params.limit : 50));
    const offset = typeof params?.cursor === "string" ? Number.parseInt(params.cursor, 10) || 0 : 0;
    const page = state.audit.slice(offset, offset + limit);
    const next = offset + limit < state.audit.length ? String(offset + limit) : null;
    return { items: page.map((item) => ({ ...item })), next_cursor: next };
  },

  sea_entry_update(params) {
    const entry = requireEntry(params);
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (text === "") throw new RpcError("INVALID_PARAMS", "这一条不能是空的。");
    entry.text = text;
    entry.by_owner = true;
    entry.history.push({ at_ms: Date.now(), action: "corrected", by: "owner" });
    return { id: entry.id, audit_seq: audit("entry_update", excerpt(text, 28), entry.id) };
  },

  sea_entry_mute(params) {
    const entry = requireEntry(params);
    if (typeof params?.muted !== "boolean") throw new RpcError("INVALID_PARAMS", "muted 必须是布尔值。");
    entry.muted = params.muted;
    entry.history.push({ at_ms: Date.now(), action: params.muted ? "muted" : "unmuted", by: "owner" });
    return {
      id: entry.id,
      audit_seq: audit(
        params.muted ? "entry_mute" : "entry_unmute",
        excerpt(entry.text, 28),
        entry.id,
      ),
    };
  },

  sea_entry_erase(params) {
    const entry = requireEntry(params);
    state.entries.delete(entry.id);
    return { id: entry.id, audit_seq: audit("entry_erase", excerpt(entry.text, 28), entry.id) };
  },

  sea_baseline_sign(params) {
    const directives = Array.isArray(params?.directives) ? params.directives : null;
    if (
      directives === null ||
      directives.length === 0 ||
      directives.some(
        (item) =>
          typeof item?.title !== "string" ||
          typeof item?.text !== "string" ||
          item.title.trim() === "" ||
          item.text.trim() === "",
      )
    ) {
      throw new RpcError("INVALID_PARAMS", "底线至少要有一条，每条都要有短题和短句。");
    }
    if (typeof params?.passphrase !== "string" || params.passphrase === "") {
      throw new RpcError("INVALID_PARAMS", "需要口令。");
    }
    // 第一次签署时，这个口令即被设定。
    if (state.passphrase === null) state.passphrase = params.passphrase;
    else if (params.passphrase !== state.passphrase) throw new RpcError("PASSPHRASE_REJECTED", "口令不对。");
    const signed_at_ms = Date.now();
    state.baseline.directives = directives.map((item, index) => ({
      id: `dir-${signed_at_ms}-${index + 1}`,
      title: item.title.trim(),
      text: item.text.trim(),
    }));
    state.baseline.signed = true;
    state.baseline.signed_at_ms = signed_at_ms;
    audit("baseline_sign", `${directives.length} 条底线`);
    return { signed_at_ms };
  },

  sea_rhythm_set(params) {
    const speak = params?.speak_first;
    const hours = params?.quiet_hours ?? null;
    if (typeof speak !== "boolean") throw new RpcError("INVALID_PARAMS", "speak_first 必须是真或假。");
    if (hours !== null && !(Array.isArray(hours) && hours.length === 2)) {
      throw new RpcError("INVALID_PARAMS", "quiet_hours 是两个钟点，或者 null。");
    }
    state.lately = { ...state.lately, speak_first: speak, bring_up: speak ? state.lately.bring_up : null, quiet_hours: hours };
    return this.sea_self();
  },

  sea_focus_set(params) {
    const weight = params?.self_weight;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new RpcError("INVALID_PARAMS", "self_weight 必须在 0 和 1 之间。");
    }
    if (weight < state.focus.floor_self - 1e-9) {
      throw new RpcError("FLOOR_VIOLATION", "不能低于下限：他至少要留这么多给自己。");
    }
    const self_weight = Math.round(weight * 100) / 100;
    state.focus = { ...state.focus, self_weight, us_weight: Math.round((1 - self_weight) * 100) / 100 };
    audit("focus_set", `他自己 ${Math.round(self_weight * 100)}，我们 ${Math.round((1 - self_weight) * 100)}`);
    return usView();
  },

  sea_device_revoke(params) {
    checkPassphrase(params?.passphrase);
    const id = typeof params?.device_id === "string" ? params.device_id : "";
    if (id === state.thisDevice.id) {
      throw new RpcError("INVALID_PARAMS", "不能在这台设备上吊销它自己。");
    }
    const device = state.devices.find((item) => item.id === id);
    if (!device) throw new RpcError("NOT_FOUND", "这台设备已经不在了。");
    state.devices = state.devices.filter((item) => item.id !== id);
    audit("device_revoke", device.name);
    return devicesView();
  },
};

function dispatch(method, params) {
  const handler = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
  if (!handler) {
    // 与真守护进程一致：名单之外的方法一律拒绝。
    throw new RpcError("PERMISSION_DENIED", "该方法不允许经 Web 控制台调用", 403);
  }
  const failure = failures.get(method);
  if (failure) {
    failure.times -= 1;
    if (failure.times <= 0) failures.delete(method);
    throw new RpcError(failure.code, failure.detail, failure.status);
  }
  return handler(params);
}

// ── HTTP ────────────────────────────────────────────────────────────────

function safePath(urlPath) {
  const raw = urlPath.split("?")[0] ?? "/";
  if (raw.includes("%") || raw.includes("\\") || raw.includes("\0")) return null;
  const normalized = normalize(raw).replace(/^([.]{2}[\\/])+/, "");
  const rel = normalized === "/" ? "index.html" : normalized.replace(/^[/]+/, "");
  if (rel.split("/").some((segment) => segment === ".." || segment.startsWith("."))) return null;
  return join(root, rel);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk.toString("utf8");
  if (body === "") return {};
  return JSON.parse(body);
}

async function serveStatic(req, res, pathname) {
  let file = safePath(pathname);
  if (!file) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end();
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    // 无扩展名的深链回退到 index.html。
    if (extname(pathname) === "") {
      file = join(root, "index.html");
    } else {
      res.writeHead(404, SECURITY_HEADERS);
      res.end();
      return;
    }
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME.get(extname(file)) ?? "application/octet-stream",
      "content-length": String(body.length),
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch {
    res.writeHead(404, SECURITY_HEADERS);
    res.end();
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const hostHeader = req.headers.host;
  if (!origin || !hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";

  if (pathname === "/health") {
    sendJson(res, 200, { status: "ok", version: "0.0.0-mock", web: true });
    return;
  }

  if (pathname === "/auth/local") {
    // 与真守护进程一致：没有同源 Origin 的握手一律拒绝。
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: req.headers.origin ? "cross_origin_denied" : "origin_required", status: 403 });
      return;
    }
    sendJson(res, 200, { token: TOKEN, expires_in_secs: 43_200, daemon_version: "0.0.0-mock" });
    return;
  }

  if (pathname === "/rpc") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed", status: 405 });
      return;
    }
    if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
      sendJson(res, 401, { error: "unauthorized", status: 401 });
      return;
    }
    let parsed;
    try {
      parsed = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { kind: "error", data: { code: "SERIALIZATION_ERROR", detail: String(error) } });
      return;
    }
    const method = typeof parsed?.method === "string" ? parsed.method : "";
    try {
      sendJson(res, 200, { kind: method, data: dispatch(method, parsed?.params) });
    } catch (error) {
      if (error instanceof RpcError) {
        sendJson(res, error.status, { kind: "error", data: { code: error.code, detail: error.detail } });
      } else {
        sendJson(res, 500, { kind: "error", data: { code: "INTERNAL", detail: String(error) } });
      }
    }
    return;
  }

  // 测试专用的控制口：换一套数据、注入一次失败、看内存里的现状。
  if (pathname === "/__mock/reset" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    state = buildState(body?.scenario === "fresh" ? "fresh" : "full");
    failures = new Map();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/__mock/fail" && req.method === "POST") {
    const body = await readJson(req).catch(() => ({}));
    if (typeof body?.method === "string") {
      failures.set(body.method, {
        code: typeof body.code === "string" ? body.code : "INTERNAL",
        detail: typeof body.detail === "string" ? body.detail : "注入的失败",
        status: Number.isInteger(body.status) ? body.status : 200,
        times: Number.isInteger(body.times) ? body.times : 1,
      });
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/__mock/state") {
    sendJson(res, 200, {
      baseline: state.baseline,
      focus: state.focus,
      devices: state.devices,
      entries: [...state.entries.values()].map(toDetail),
      audit: state.audit.slice(0, 20),
    });
    return;
  }

  await serveStatic(req, res, pathname);
});

server.on("clientError", (_error, socket) => socket.destroy());

server.listen(port, host, () => {
  console.log(`mock-daemon listening on http://${host}:${port} (static: ${root}, scenario: ${values.scenario})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // 浏览器可能还握着 keep-alive 连接：不等它们。
    server.closeAllConnections();
  });
}
