// 保密传递（pass_secret）：对方在聊天框里直接发送密码、令牌、密钥等敏感信息，而 agent 始终看不到明文。任何通道通用。
//   协议：
//   1. agent 调用 pass_secret，说明用途与要哪几项（名字 + 给对方看的说明）。基座为这个会话开启「保密输入」，生成一次性的结束口令，
//      并发出 secret 事件（open），由通道提醒对方：要哪几项、怎么发、结束口令是什么。
//   2. 此后这个会话里对方发来的每一条消息都是一项的值，按顺序对应各项。消息在进入对话记录、上下文、审计之前被 converse 截走（intake），
//      只留在内存里；回执只说收到了第几项和字符数，不回显内容。
//   3. 对方发回结束口令：已收到的各项写入保密库，工具返回——只有名字、路径与字节数。「口令 重来」清空重填，「口令 取消」放弃；
//      SECRET_IDLE_MS 内没有动静自动放弃。放弃时已收到的值直接丢弃，不落盘。
//   保密库：QUETZAL_HOME/vault/（0700），每项一个文件（0600，文件名即名字，内容即值），index.json 记录说明、时间与来源通道（不含值）。
//   它只属于这具身体：不在灵魂仓库里，不会同步到别的身体。agent 在命令里用 "$(cat 路径)" 或 < 路径 引用。
//   兜底：所有工具输出在交给模型、写入审计之前经过 redactSecrets，出现的保密值替换为 ‹secret:名字›（只防无意泄露，挡不住刻意变换编码）；
//   基座自己的密钥（secrets/ 下的令牌、主密钥、私钥，模型供应商的 Key）同样替换。工具参数在写进审计、时间线、审批与过程记录之前经过 redactArgs。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "../config.ts";
import { bus, type SecretEvent } from "../bus.ts";
import { identity } from "../memory/identity.ts";
import { baseSecrets } from "../secret-values.ts";

export const SECRET_IDLE_MS = 10 * 60_000;
export const MAX_ITEMS = 20;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface SecretItem { name: string; hint: string }
export interface SecretInfo { name: string; hint: string; ts: number; channel: string; bytes: number; path: string }

// ---------- 保密库
type Index = Record<string, { hint: string; ts: number; channel: string }>;
const file = (name: string) => path.join(paths.vault, name);
const indexFile = () => path.join(paths.vault, "index.json");
const readIndex = (): Index => { try { return JSON.parse(fs.readFileSync(indexFile(), "utf8")); } catch { return {}; } };
function write(f: string, data: string) { fs.writeFileSync(f, data, { mode: 0o600 }); fs.chmodSync(f, 0o600); }
const names = (): string[] => { try { return fs.readdirSync(paths.vault).filter((n) => NAME.test(n) && fs.statSync(file(n)).isFile()).sort(); } catch { return []; } };

/** 保密库里有哪些（名字、说明、时间、大小、路径），不含值。 */
export function listSecrets(): SecretInfo[] {
  const idx = readIndex();
  return names().map((name) => {
    const st = fs.statSync(file(name));
    return { name, hint: idx[name]?.hint ?? "", ts: idx[name]?.ts ?? Math.round(st.mtimeMs), channel: idx[name]?.channel ?? "", bytes: st.size, path: file(name) };
  });
}

/** 写入一项（同名覆盖）。单行的值原样写入；多行的值（如私钥）以换行结尾。 */
export function saveSecret(name: string, value: string, hint = "", channel = ""): string {
  if (!NAME.test(name)) throw new Error(`名字不合规：${name}`);
  fs.mkdirSync(paths.vault, { recursive: true, mode: 0o700 });
  write(file(name), value.includes("\n") ? value + "\n" : value);
  write(indexFile(), JSON.stringify({ ...readIndex(), [name]: { hint, ts: Date.now(), channel } }, null, 2));
  cache = undefined;
  return file(name);
}

export function deleteSecret(name: string): boolean {
  if (!NAME.test(name) || !fs.existsSync(file(name))) return false;
  fs.rmSync(file(name));
  const { [name]: _, ...rest } = readIndex();
  write(indexFile(), JSON.stringify(rest, null, 2));
  cache = undefined;
  return true;
}

// ---------- 兜底：工具输出里出现的保密值一律替换。目录变化（增删文件）或经由本模块写入后重新读取。
const MIN_REDACT = 4, MIN_LINE = 12; // 太短的值不替换，否则会把无关输出改得面目全非；多行的值另外逐行替换（防止只输出其中几行）
let cache: { stamp: number; list: [value: string, name: string][] } | undefined;
function needles(): [string, string][] {
  let stamp: number;
  try { stamp = fs.statSync(paths.vault).mtimeMs; } catch { return []; }
  if (cache?.stamp !== stamp) {
    const list: [string, string][] = [];
    for (const name of names()) {
      const v = fs.readFileSync(file(name), "utf8").trim();
      if (v.length >= MIN_REDACT) list.push([v, name]);
      if (v.includes("\n")) for (const l of v.split("\n").map((x) => x.trim())) if (l.length >= MIN_LINE) list.push([l, name]);
    }
    cache = { stamp, list: list.sort((a, b) => b[0].length - a[0].length) };
  }
  return cache.list;
}
/** 保密库的值与基座自己的密钥（见 secret-values.ts），按长度从长到短。 */
export const allSecretValues = (): [string, string][] => [...needles(), ...baseSecrets()].sort((a, b) => b[0].length - a[0].length);
export function redactSecrets(text: string): string {
  for (const [v, name] of allSecretValues()) if (text.includes(v)) text = text.split(v).join(`‹secret:${name}›`);
  return text;
}
/** 工具参数里的保密值同样替换（参数会写进审计、时间线、审批与过程记录）。返回替换后的副本，原参数不变。 */
export function redactArgs<T>(args: T): T {
  const s = JSON.stringify(args ?? null);
  const r = redactSecrets(s);
  if (r === s) return args;
  try { return JSON.parse(r); } catch { return { redacted: r } as T; }
}

// ---------- 保密输入：每个会话同时最多一次
interface Capture {
  id: string; conv: string; channel: string; purpose: string; items: SecretItem[]; values: string[];
  spell: string; idle: number; expires: number; timer?: NodeJS.Timeout; resolve: (result: string) => void;
}
const captures = new Map<string, Capture>(); // 会话 → 进行中的保密输入

const view = (c: Capture, status: SecretEvent["status"], got = c.values.length): SecretEvent =>
  ({ id: c.id, conv: c.conv, channel: c.channel, status, purpose: c.purpose, items: c.items, got, spell: c.spell, expires: c.expires });
/** 这个会话此刻是否在保密输入中（通道据此跳过附件下载、表情、引用回复等会带出内容的处理）。 */
export const capturing = (conv: string) => captures.has(conv);
/** 进行中的保密输入（客户端断线重连后据此恢复提示）。 */
export const pendingSecrets = (): SecretEvent[] => [...captures.values()].map((c) => view(c, c.values.length ? "progress" : "open"));

/** 结束口令：done- 加 6 个不易看错的字符。只用来标记「输入完毕」，本身不是秘密。 */
function newSpell(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  return "done-" + Array.from({ length: 6 }, () => abc[crypto.randomInt(abc.length)]).join("");
}

function parseItems(raw: unknown): SecretItem[] {
  const items = (Array.isArray(raw) ? raw : []).map((x) => typeof x === "string" ? { name: x.trim(), hint: "" } : { name: String(x?.name ?? "").trim(), hint: String(x?.hint ?? "").replace(/\s+/g, " ").trim().slice(0, 200) });
  if (!items.length || items.length > MAX_ITEMS) throw new Error(`items 需要 1–${MAX_ITEMS} 项`);
  for (const it of items) if (!NAME.test(it.name)) throw new Error(`名字不合规：「${it.name}」。只能用字母、数字、下划线、连字符（以字母或数字开头，最多 64 个字符），如 github_token`);
  if (new Set(items.map((x) => x.name)).size !== items.length) throw new Error("items 里有重复的名字");
  return items;
}

function arm(c: Capture) {
  clearTimeout(c.timer);
  c.expires = Date.now() + c.idle;
  c.timer = setTimeout(() => end(c, "expired"), c.idle);
}

/**
 * 开始一次保密输入，等到对方输入完毕、取消或超时。返回给 agent 的结果：只有名字、路径与字节数，没有明文。
 * idleMs：多久没有动静就放弃（每收到一条消息重新计时）。
 */
export async function requestSecrets(conv: string, channel: string, purpose: string, rawItems: unknown, idleMs = SECRET_IDLE_MS): Promise<string> {
  const items = parseItems(rawItems);
  if (captures.has(conv)) throw new Error("这个对话里已经有一次保密输入在进行，等它结束再发起");
  return new Promise<string>((resolve) => {
    const c: Capture = { id: crypto.randomBytes(4).toString("hex"), conv, channel, purpose: purpose.replace(/\s+/g, " ").trim().slice(0, 200), items, values: [], spell: newSpell(), idle: idleMs, expires: 0, resolve };
    captures.set(conv, c);
    arm(c);
    bus.emit("secret", view(c, "open"));
  });
}

const label = (it: SecretItem) => `「${it.name}」${it.hint ? `（${it.hint}）` : ""}`;

/** 通道提醒对方用的说明（Markdown）：要哪几项、怎么发、结束口令。 */
export function secretNotice(e: SecretEvent): string {
  const who = identity().displayName;
  return `${who} 需要你提供下面 ${e.items.length} 项${e.purpose ? `，用于：${e.purpose}` : ""}。
从现在起，你在这个对话里发的**每一条消息都是一项的值**（按下面的顺序，一条消息一项）。它们不进入对话，直接存进这具身体的保密库，${who} 看不到明文。

${e.items.map((it, i) => `${i + 1}. **${it.name}**${it.hint ? ` — ${it.hint}` : ""}`).join("\n")}

全部发完后，发送结束口令：\`${e.spell}\`
填错了发 \`${e.spell} 重来\`，不想给了发 \`${e.spell} 取消\`。${Math.round((e.expires - Date.now()) / 60_000)} 分钟没有动静会自动取消。`;
}

function end(c: Capture, status: "done" | "cancelled" | "expired"): SecretEvent {
  clearTimeout(c.timer);
  captures.delete(c.conv);
  const got = c.values.length;
  const saved = status === "done" ? c.values.map((v, i) => ({ ...c.items[i], path: saveSecret(c.items[i].name, v, c.items[i].hint, c.channel), bytes: Buffer.byteLength(v) })) : [];
  c.values.length = 0;
  const missing = c.items.slice(saved.length).map((x) => x.name);
  c.resolve(status === "cancelled" ? "对方取消了这次保密输入，没有保存任何内容。"
    : status === "expired" ? `${Math.round(c.idle / 60_000)} 分钟内没有等到对方输入完毕，已放弃，没有保存任何内容${got ? `（已收到的 ${got} 项也已丢弃）` : ""}。等对方方便时再发起一次。`
    : !saved.length ? "对方发回了结束口令，但没有提供任何内容，保密库没有变化。问问对方是不是遇到了问题。"
    : `已存入保密库 ${saved.length} 项（你看不到明文，也不要设法把它们输出出来）：
${saved.map((s) => `- ${s.name} → ${s.path}（${s.bytes} 字节）`).join("\n")}${missing.length ? `\n对方没有提供：${missing.join("、")}` : ""}
用法：在 shell 命令里用 "$(cat 路径)" 或 < 路径 引用，例如 gh auth login --with-token < 路径、export TOKEN="$(cat 路径)"。工具输出里出现的保密值会被基座替换成 ‹secret:名字›。`);
  const e = view(c, status, saved.length);
  bus.emit("secret", e);
  return e;
}

/** 由按钮结束（控制台的「完成 / 取消」、飞书卡片）：与发回结束口令等价。找不到（已结束）时返回 undefined。 */
export function endCapture(id: string, status: "done" | "cancelled"): SecretEvent | undefined {
  const c = [...captures.values()].find((x) => x.id === id);
  return c && end(c, status);
}

/**
 * 截走保密输入期间对方发来的消息。会话不在保密输入中时返回 undefined（消息照常处理）；
 * 否则这条消息被当作一项的值或口令消费掉，返回给对方的回执（不含值）。
 */
export function intake(conv: string, text: string): string | undefined {
  const c = captures.get(conv);
  if (!c) return undefined;
  const t = text.trim(), n = c.items.length;
  const hint = `确认无误请发送结束口令 \`${c.spell}\`；填错了发 \`${c.spell} 重来\`。`;
  if (t.toLowerCase().startsWith(c.spell)) {
    const cmd = t.slice(c.spell.length).trim().toLowerCase();
    if (!cmd) {
      const e = end(c, "done"), saved = e.items.slice(0, e.got).map((x) => x.name), missing = e.items.slice(e.got).map((x) => x.name);
      if (!saved.length) return "已结束，没有保存任何内容。";
      return `✅ 已存入保密库 ${saved.length} 项：${saved.join("、")}。${identity().displayName} 看不到明文，只能在命令里引用。${missing.length ? `没有提供：${missing.join("、")}。` : ""}${c.channel === "控制台" ? "" : "\n这几条消息还留在聊天记录里，建议现在把它们撤回或删除。"}`;
    }
    if (cmd === "取消" || cmd === "cancel") { end(c, "cancelled"); return "已取消，没有保存任何内容。"; }
    if (cmd === "重来" || cmd === "redo") {
      c.values.length = 0; arm(c);
      bus.emit("secret", view(c, "progress"));
      return `已清空，重新开始。第 1 项：${label(c.items[0])}`;
    }
    return `没有认出这条口令。结束发 \`${c.spell}\`，重填发 \`${c.spell} 重来\`，放弃发 \`${c.spell} 取消\`。`;
  }
  arm(c);
  if (!t) return "保密输入期间只接收文字消息，这一条没有保存。";
  if (c.values.length >= n) return `${n} 项已经收齐，这一条没有保存。${hint}`;
  c.values.push(t);
  const i = c.values.length;
  bus.emit("secret", view(c, "progress"));
  return `🔒 已收到第 ${i}/${n} 项「${c.items[i - 1].name}」（${[...t].length} 个字符，没有进入对话）。${i < n ? `下一项：${label(c.items[i])}。发完了随时可以发结束口令 \`${c.spell}\`。` : `已收齐。${hint}`}`;
}
