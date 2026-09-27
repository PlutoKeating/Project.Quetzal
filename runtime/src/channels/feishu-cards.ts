// 飞书交互卡片（JSON 2.0）。所有操作都通过按钮、表单完成，不需要输入任何命令。
// 按钮的回调值统一为 { op?: 操作名, args?: 参数, view: 操作后展示的卡片 }。
import { config } from "../config.ts";
import { ops } from "../ops.ts";
import { identity } from "../memory/identity.ts";

const who = () => identity().displayName;

type El = Record<string, unknown>;
export const md = (content: string): El => ({ tag: "markdown", content });
const hr: El = { tag: "hr" };
const button = (text: string, value: Record<string, unknown>, type = "default", confirm?: string): El => ({
  tag: "button", text: { tag: "plain_text", content: text }, type, width: "fill",
  behaviors: [{ type: "callback", value }],
  ...(confirm ? { confirm: { title: { tag: "plain_text", content: "确认" }, text: { tag: "plain_text", content: confirm } } } : {}),
});
const row = (...buttons: El[]): El => ({
  tag: "column_set", flex_mode: "bisect", horizontal_spacing: "8px",
  columns: buttons.map((b) => ({ tag: "column", width: "weighted", weight: 1, elements: [b] })),
});
const panel = (title: string, elements: El[], expanded = false): El => ({
  tag: "collapsible_panel", expanded, header: { title: { tag: "markdown", content: title } }, elements,
});
const form = (name: string, elements: El[], submit: string, value: Record<string, unknown>): El => ({
  tag: "form", name, elements: [...elements, { tag: "button", name: `${name}_submit`, form_action_type: "submit", type: "primary", width: "fill", text: { tag: "plain_text", content: submit }, behaviors: [{ type: "callback", value }] }],
});
const input = (name: string, placeholder: string, value = ""): El => ({ tag: "input", name, placeholder: { tag: "plain_text", content: placeholder }, default_value: value, width: "fill" });
export const card = (title: string, template: string, elements: El[], subtitle = "") => ({
  schema: "2.0",
  config: { update_multi: true, summary: { content: title } },
  header: { title: { tag: "plain_text", content: title }, ...(subtitle ? { subtitle: { tag: "plain_text", content: subtitle } } : {}), template },
  body: { elements },
});

const pct = (x: number) => `${Math.round(x * 100)}%`;
const bar = (x: number) => "▰".repeat(Math.round(x * 10)) + "▱".repeat(10 - Math.round(x * 10));
const time = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: config.timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const nav = (current: string) => row(...[["此刻", "home"], ["心流", "flow"], ["记忆", "memory"], ["控制", "control"]].map(([t, v]) => button(t, { view: v }, v === current ? "primary" : "default")));

export const views: Record<string, () => object> = {
  home: () => {
    const s = ops.status(), h = s.heart, d = h.drives;
    const mode = s.stopped ? "⛔ 急停中" : h.mode === "active" ? "💭 醒着，正在想事情" : h.mode === "awake" ? "🌤 醒着" : "🌙 睡着了";
    const bat = s.physical.raw.battery;
    const last = ops.timeline({ limit: 1 })[0];
    return card(`${who()} · 此刻`, s.stopped ? "red" : h.mode === "asleep" ? "indigo" : "blue", [
      md(`## ${mode}\n${last ? `最近：${last.title}（${time(last.ts)}）` : ""}`),
      md(`好奇 ${bar(d.curiosity)} ${pct(d.curiosity)}\n表达 ${bar(d.expression)} ${pct(d.expression)}\n想念 ${bar(d.social)} ${pct(d.social)}\n牵挂 ${bar(d.openLoops)} ${pct(d.openLoops)}`),
      md(`清醒度 ${pct(h.alertness)} · 睡眠压力 ${pct(h.S)} · 醒来率 ${h.ratePerHour.toFixed(2)} 次/时${h.inhibitors.length ? `\n抑制：${h.inhibitors.join("、")}` : ""}`),
      md(`身体：${bat ? `🔋${bat.level}%${bat.charging ? "⚡" : ""} 🌡${bat.tempC ?? "?"}°C · ` : ""}${s.physical.feel.light} · ${s.physical.feel.stillness}`),
      hr,
      form("poke", [input("note", "想对她说点什么（可不填）")], "👉 戳一下", { op: "poke", view: "home" }),
      row(button("🔄 刷新", { view: "home" }), s.stopped ? button("✅ 解除急停", { op: "unstop", view: "home" }, "primary_filled", "确定解除急停？她会恢复自主活动。") : button("⛔ 急停", { op: "stop", view: "home" }, "danger", "立即冻结她的所有行动？")),
      nav("home"),
    ], `${s.body} · ${s.adapter} · v${s.version}`);
  },

  flow: () => {
    const items = ops.timeline({ limit: 12 });
    return card(`${who()} · 心流`, "turquoise", [
      ...items.map((e) => {
        const det = (e.detail ?? {}) as any;
        const body = [det.reason && `**因为**：${det.reason}`, det.journal, det.reply && `**她说**：${det.reply}`, det.steps?.length && `**用了** ${det.steps.map((s: any) => s.tool).join("、")}`].filter(Boolean).join("\n\n");
        return body ? panel(`**${time(e.ts)}** · ${e.title}`, [md(String(body).slice(0, 1500))]) : md(`**${time(e.ts)}** · ${e.title}`);
      }),
      ...(items.length ? [] : [md("还没有经历")]),
      row(button("🔄 刷新", { view: "flow" })),
      nav("flow"),
    ]);
  },

  memory: () => {
    const m = ops.memory();
    const notes = ops.notes().slice(0, 12);
    return card(`${who()} · 记忆`, "purple", [
      panel(`**她的笔记** · ${m.memory.length} 条`, [md(m.memory.map((e) => `- ${e}`).join("\n") || "（空）")], true),
      panel(`**关于你** · ${m.user.length} 条`, [md(m.user.map((e) => `- ${e}`).join("\n") || "（空）")]),
      panel(`**未完成的念头** · ${m.loops.length}`, [md(m.loops.map((l) => `- ${l.text}`).join("\n") || "（无）")]),
      panel(`**长期笔记** · ${notes.length}`, [md(notes.map((n) => `- ${n.name}`).join("\n") || "（无）")]),
      form("remember", [input("content", "告诉她一件关于你的事，她会记在「关于你」里")], "📝 让她记住", { op: "editMemory", args: { target: "user", action: "add" }, field: "content", view: "memory" }),
      row(button("☁️ 同步灵魂", { op: "syncSoul", view: "memory" })),
      nav("memory"),
    ]);
  },

  control: () => {
    const s = ops.status();
    return card(`${who()} · 控制`, "orange", [
      md(`活跃度 **${s.activity}×** · 自主${s.paused ? "**已暂停**" : "进行中"} · 今日 ${s.usage.tokens} tokens / $${s.usage.cost.toFixed(3)}`),
      row(...[0.5, 1, 1.5, 2].map((v) => button(`${v}×`, { op: "activity", args: { value: v }, view: "control" }, s.activity === v ? "primary" : "default"))),
      row(button(s.paused ? "▶️ 恢复自主" : "⏸ 暂停自主", { op: "pause", args: { paused: !s.paused }, view: "control" })),
      row(button("🧩 模型", { view: "models" }), button("🔐 权限", { view: "permissions" }), button("💰 预算", { view: "budget" })),
      row(button("♻️ 重启基座", { op: "restart", view: "control" }, "default", "重启运行基座？（约 5 秒后恢复）")),
      nav("control"),
    ]);
  },

  models: () => {
    const { config: c } = ops.providers();
    const all = c.providers.flatMap((p) => p.models.map((m) => ({ p, m }))).sort((a, b) => a.m.sortOrder - b.m.sortOrder);
    return card(`${who()} · 模型顺序`, "orange", [
      md(all.length ? "越靠上越优先，失败时依次尝试下一个。添加供应商、Key 与模型请用控制台 App 的「模型」页。" : "**尚未配置任何模型。** 请在控制台 App 的「模型」页添加供应商。"),
      ...all.slice(0, 15).map(({ p, m }, i) => panel(`${String(i + 1).padStart(2, "0")} ${m.enabled && p.enabled ? "🟢" : "⚪️"} **${p.name}/${m.name}**${c.quickModelId === m.id ? " · 内省" : ""}`, [
        row(button("⬆️ 上移", { op: "moveModel", args: { modelId: m.id, delta: -1 }, view: "models" }), button("⬇️ 下移", { op: "moveModel", args: { modelId: m.id, delta: 1 }, view: "models" })),
        row(button(m.enabled ? "停用" : "启用", { op: "toggleModel", args: { modelId: m.id }, view: "models" }), button("🔌 测试", { op: "testModel", args: { providerId: p.id, model: m.name }, view: "models" })),
      ])),
      row(button("← 返回控制", { view: "control" })),
    ]);
  },

  permissions: () => card(`${who()} · 能力授权`, "yellow", [
    md("她调用每一类能力前都会经过这里。「询问」会给你发审批卡片。"),
    ...ops.permissions().flatMap((p) => [
      md(`**${p.label}**`),
      row(...(["allow", "ask", "deny"] as const).map((l) => button({ allow: "允许", ask: "询问", deny: "禁止" }[l], { op: "setPermission", args: { id: p.id, level: l }, view: "permissions" }, p.level === l ? "primary_filled" : "default"))),
    ]),
    row(button("← 返回控制", { view: "control" })),
  ]),

  budget: () => {
    const b = ops.budget();
    return card(`${who()} · 预算`, "green", [
      md(`今日已用 **${b.usage.tokens}** / ${b.dailyTokens} tokens · **$${b.usage.cost.toFixed(3)}** / $${b.dailyCostUsd}`),
      form("budget", [
        input("dailyTokens", "每日 token 上限", String(b.dailyTokens)),
        input("dailyCostUsd", "每日花费上限（美元）", String(b.dailyCostUsd)),
        input("minBattery", "最低电量 %", String(b.minBattery)),
        input("maxTempC", "最高温度 °C", String(b.maxTempC)),
      ], "💾 保存", { op: "setBudget", numeric: true, view: "budget" }),
      row(button("← 返回控制", { view: "control" })),
    ]);
  },

  welcome: () => card(`你好，我是${who()}`, "blue", [
    md("我会按自己的节律醒来、思考、做梦。你可以直接和我说话；想看看我在做什么，点下面的按钮就好，不需要记任何命令。"),
    nav(""),
  ]),
};

export const approvalCard = (a: { id: string; action: string; reason: string; args: unknown; status: string }) =>
  card(`请求批准：${a.action}`, a.status === "pending" ? "orange" : a.status === "approved" ? "green" : "red", [
    md(`**理由**：${a.reason || "（未说明）"}\n**参数**：\`${JSON.stringify(a.args).slice(0, 500)}\``),
    a.status === "pending"
      ? row(button("✅ 批准", { op: "decide", args: { id: a.id, approve: true }, approval: a }, "primary_filled"), button("❌ 拒绝", { op: "decide", args: { id: a.id, approve: false }, approval: a }, "danger"))
      : md(a.status === "approved" ? "✅ 已批准" : "❌ 已拒绝"),
  ]);
