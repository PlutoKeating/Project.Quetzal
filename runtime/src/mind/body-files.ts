// 身体参数：读文件的工具（view_image、read_document、shell）带上 body（另一具身体的 uuid）时，参数里的路径指那具身体上的文件。
// 基座经网状层（file.read，端到端加密、节点密钥认证过的连接）把这些文件取到本机，再把本地路径交给工具；之后照常走本机的检查
// （view_image 的类型判断与缩图、read_document 的解析、shell 的沙箱）。跨身体读文件的安全检查都在这里，不在各个工具里：
//   - 那边（lendFile）：按它自己的闸门（「执行命令」类别，与 read_document 相同；急停拒绝），按真实路径挡住密钥目录、保密库
//     （protectedPath），只收普通文件（不收目录、设备文件、管道），大小有上限（FILE_MAX_BYTES），分段交出（每段 PIECE_BYTES），记审计；
//   - 这边（fetchFile）：按「跨身体操作」（body）过闸门，核对每段的长度与整个文件的大小和 sha256 一致才留下，文件名清洗后放进
//     data/from-bodies/<身体名>/（重名不覆盖：同一个文件再取直接复用，内容不同另起名字），记审计；
//   - 灵魂桥（只读成员）不能调用 file.read（网状层只让它调用登记为可读的方法）。
// body 用 uuid 而不是身体名：uuid 绑定到设备（body/uuid.ts），重装不变；它不是密码学身份，所以以灵魂仓库的身体登记为准，
// 再找网状层认证过的那条连接，并核对对方自报的一致（resolveBody）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { check } from "../guard/guard.ts";
import { audit } from "../store.ts";
import { protectedPath, workDir } from "../sandbox.ts";
import { config, paths } from "../config.ts";
import { remoteBodies, bodiesHooks, type RemoteBody } from "./bodies.ts";
import { BODY_NAME } from "../mesh/identity.ts";
import { bodyUuid, BODY_UUID } from "../body/uuid.ts";
import { log } from "../log.ts";

/**
 * 一个文件最大多少。依据：网状层单条消息重组后最多 32 MB（mesh/link.ts，base64 之后约合 24 MB 原始数据，和转发附件的 24 MB 一样），
 * 而且一条分块消息要在 60 秒内收齐——慢的中转连接上大消息会超时。所以文件分段传，每段 1 MB（base64 约 1.4 MB，几十个 SCTP 分块），
 * 每段单独一问一答；总量上限 64 MB，一次取文件最多占用连接几十次往返，手机上读一遍算 sha256 也不到一秒。
 */
export const FILE_MAX_BYTES = 64 << 20;
export const PIECE_BYTES = 1 << 20;
const TICKET_IDLE_MS = 2 * 60_000;  // 一次传输两段之间最多隔多久（过了就关掉文件，要从头再取）
const MAX_TICKETS = 8, MAX_TICKETS_PER_BODY = 4;
const FIRST_TIMEOUT_MS = 31 * 60_000; // 第一问：那边的闸门可能要等批准（最多 30 分钟）
const PIECE_TIMEOUT_MS = 2 * 60_000;

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

// ---------- 参数

/** 给读文件的工具加上可选的 body 参数（多具身体时才加）。 */
export function withBodyParam<T extends { parameters: unknown; bodyParams?: Record<string, unknown> }>(t: T): T {
  const p = t.parameters as { properties?: Record<string, unknown> };
  return { ...t, parameters: { ...p, properties: { ...(p.properties ?? {}), ...(t.bodyParams ?? {}), body: { type: "string", description: "可选：文件在你的另一具身体上时，填那具身体的 uuid（系统提示「其他身体」一节里有）。路径照那边的写，基座先把文件取到这具身体上再用" } } } };
}

export type BodyTarget = { local: true } | { remote: RemoteBody } | { error: string };
const online = () => remoteBodies().map((b) => `${b.body}（${b.uuid ?? "还没有登记 uuid"}）`).join("、");

/**
 * 解析 body 参数（身体的 uuid）。凡是她填写、指代一具身体的参数（读文件工具的 body、body_call / move_to 的 body、醒来时选的 where）都走这里：在灵魂仓库的身体登记里找到它对应的身体名，再找这个名字的、网状层认证过的连接；
 * 同时核对那具身体自报的 uuid 与登记一致。空或这具身体自己 → 本机。一个 uuid 被登记给多具身体（例如同一部手机上装了两份运行基座）时拒绝，不替人选。
 */
export function resolveBody(arg: unknown): BodyTarget {
  if (arg === undefined || arg === null || arg === "") return { local: true };
  const v = typeof arg === "string" ? arg.trim().toLowerCase() : "";
  const self = bodyUuid();
  const named = remoteBodies().find((b) => b.body === v) ?? (v === config.body ? { body: v, uuid: self } : undefined);
  if (named) return { error: `body 要填身体的 uuid，不是名字：${named.body} 的 uuid 是 ${named.uuid ?? "（还没有登记）"}` };
  if (!BODY_UUID.test(v)) return { error: `body 要填身体的 uuid（在线的：${online() || "没有"}）` };
  const owners = [...new Set((bodiesHooks()?.registry?.() ?? []).filter((r) => r.uuid === v).map((r) => r.body))];
  if (owners.length > 1) return { error: `这个 uuid 对应多具身体（${owners.join("、")}），没法确定是哪一具。通常是同一台设备上装了两份运行基座；请对方只留一份，或在其中一具身体上换一个 uuid（见文档「多具身体」）` };
  if (!owners.length) return v === self ? { local: true } : { error: `灵魂仓库里没有登记这个 uuid 的身体（在线的：${online() || "没有"}）` };
  if (owners[0] === config.body) return v === self ? { local: true } : { error: `登记里 ${config.body} 的 uuid 与这具身体现在的不一致，等下一次同步更新登记后再试` };
  const b = remoteBodies().find((x) => x.body === owners[0]);
  if (!b) return { error: `${owners[0]} 不在线（在线的：${online() || "没有"}）` };
  if (!b.claimed) return { error: `${b.body} 需要升级：它的版本还没有身体 uuid` };
  if (b.claimed !== v) {
    log("mesh", `${b.body} 自报的 uuid（${b.claimed.replace(/[^0-9a-z-]/g, "?")}）与灵魂仓库的登记（${v}）不一致，拒绝`);
    audit("agent", "body", "解析 body", { body: b.body, uuid: v }, `denied: ${b.body} 自报的 uuid 与登记不一致`);
    return { error: `${b.body} 自报的 uuid 与灵魂仓库的登记不一致，没有用它` };
  }
  return { remote: b };
}

// ---------- 那边：把一个文件交给另一具身体

interface Ticket { from: string; fh: fs.promises.FileHandle; size: number; sent: number; timer: NodeJS.Timeout }
const tickets = new Map<string, Ticket>();
const closeTicket = (id: string) => { const t = tickets.get(id); if (!t) return; tickets.delete(id); clearTimeout(t.timer); void t.fh.close().catch(() => {}); };
const arm = (id: string, t: Ticket) => { clearTimeout(t.timer); t.timer = setTimeout(() => closeTicket(id), TICKET_IDLE_MS); t.timer.unref?.(); };
const readPiece = async (fh: fs.promises.FileHandle, offset: number, size: number) => {
  const buf = Buffer.alloc(Math.min(PIECE_BYTES, size - offset));
  let got = 0;
  while (got < buf.length) { const { bytesRead } = await fh.read(buf, got, buf.length - got, offset + got); if (!bytesRead) break; got += bytesRead; }
  if (got !== buf.length) throw new Error("文件在传输中变短了");
  return buf;
};

export interface LendFirst { path: string; size: number; sha256: string; data: string; ticket?: string }

/**
 * 另一具身体（from，网状层认证过的名字）来取这里的一个文件。第一问 {path, reason}：检查后交回大小、sha256 与第一段；
 * 文件超过一段时另给 ticket，之后每问 {ticket, offset} 交回下一段（必须按顺序），{ticket, close: true} 提前结束。
 */
export async function lendFile(p: unknown, from: string): Promise<LendFirst | { data: string } | Record<string, never>> {
  const q = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  if (typeof q.ticket === "string") {
    const t = tickets.get(q.ticket);
    if (!t || t.from !== from) throw new Error("这次传输已经结束或过期，从头再取");
    if (q.close === true) { closeTicket(q.ticket); return {}; }
    if (fs.existsSync(paths.stop)) { closeTicket(q.ticket); audit("agent", "file.read", `来自 ${from}`, { ticket: q.ticket }, "denied: 急停，传输中止"); throw new Error(`${config.body} 在急停中`); }
    if (q.offset !== t.sent) { closeTicket(q.ticket); throw new Error("分段顺序不对，从头再取"); }
    const buf = await readPiece(t.fh, t.sent, t.size).catch((e) => { closeTicket(q.ticket as string); throw e; });
    t.sent += buf.length;
    if (t.sent >= t.size) closeTicket(q.ticket); else arm(q.ticket, t);
    return { data: buf.toString("base64") };
  }

  const file = q.path;
  if (typeof file !== "string" || !file.trim() || file.length > 4096 || file.includes("\0")) throw new Error("路径不对");
  const abs = path.resolve(workDir(), file.replace(/^file:\/\//, ""));
  const why = `来自 ${from}：${String(q.reason ?? "").slice(0, 200)}`;
  const deny = (msg: string): never => { audit("agent", "file.read", why, { path: abs }, `denied: ${msg}`); throw new Error(msg); };
  if (!(await check("shell", "file.read", why, { path: abs }))) deny(`${config.body} 的闸门没有允许（或急停中）`);
  const blocked = protectedPath(abs); // 按真实路径（跟随符号链接）比较
  if (blocked) deny(blocked);
  let real: string, st: fs.Stats;
  try { real = fs.realpathSync(abs); st = fs.statSync(real); } catch { return deny(`${config.body} 上没有这个文件`); }
  const blocked2 = protectedPath(real);
  if (blocked2) deny(blocked2);
  if (!st.isFile()) deny("不是普通文件（目录、设备文件、管道都不给）");
  if (st.size > FILE_MAX_BYTES) deny(`文件太大（${mb(st.size)}，跨身体最多 ${FILE_MAX_BYTES >> 20} MB）`);
  if (tickets.size >= MAX_TICKETS || [...tickets.values()].filter((t) => t.from === from).length >= MAX_TICKETS_PER_BODY) deny(`${config.body} 同时在传的文件太多，稍后再取`);
  const c = fs.constants;
  let fh: fs.promises.FileHandle;
  // 不跟随最后一级的符号链接、不因管道阻塞：检查之后路径被换掉也打不开别的东西
  try { fh = await fs.promises.open(real, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0)); } catch (e) { return deny(`打不开（${(e as Error).message.slice(0, 100)}）`); }
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) deny("文件在检查时被换掉了");
    if (fst.size > FILE_MAX_BYTES) deny(`文件太大（${mb(fst.size)}，跨身体最多 ${FILE_MAX_BYTES >> 20} MB）`);
    const size = fst.size, hash = crypto.createHash("sha256");
    for (let off = 0; off < size; off += PIECE_BYTES) hash.update(await readPiece(fh, off, size));
    const sha256 = hash.digest("hex"), first = await readPiece(fh, 0, size);
    audit("agent", "file.read", why, { path: real }, `✓ 交出 ${size} 字节，sha256 ${sha256.slice(0, 16)}…`);
    if (first.length >= size) { await fh.close().catch(() => {}); return { path: real, size, sha256, data: first.toString("base64") }; }
    const id = crypto.randomBytes(12).toString("hex"), t: Ticket = { from, fh, size, sent: first.length, timer: setTimeout(() => {}, 0) };
    tickets.set(id, t); arm(id, t);
    return { path: real, size, sha256, data: first.toString("base64"), ticket: id };
  } catch (e) { await fh.close().catch(() => {}); throw e; }
}

// ---------- 这边：取回

/** 文件名清洗：只取最后一段，只留字母、数字与 . _ + -，不以点或减号开头（不会成为 ..、隐藏文件或命令选项），避开 Windows 的保留名，最长 120 个字符。 */
export function safeFileName(remote: string): string {
  let n = (remote.split(/[\\/]/).pop() ?? "").normalize("NFC").replace(/[^\p{L}\p{N}._+-]+/gu, "_").replace(/^[.-]+/, "").replace(/[.]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 120) { const ext = path.extname(n).slice(0, 20); n = n.slice(0, 120 - ext.length) + ext; }
  return n || "file";
}

/** 从另一具身体取来的文件放在哪里：data/from-bodies/<身体名>/（沙箱里她的命令也能读写 data）。 */
export const fetchedDir = (body: string) => path.join(paths.data, "from-bodies", body);

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const sha256Of = async (f: string) => { const h = crypto.createHash("sha256"); for await (const c of fs.createReadStream(f)) h.update(c as Buffer); return h.digest("hex"); };

/** 把那具身体上的一个文件取到本机，返回本地路径。同名的文件内容相同就直接复用，不同就另起名字（name-2.ext），不覆盖。 */
export async function fetchFile(b: RemoteBody, file: string, reason: string): Promise<{ local: string; remote: string; size: number; reused: boolean }> {
  const h = bodiesHooks();
  const args = { body: b.body, uuid: b.uuid, path: file };
  const fail = (msg: string): never => { audit("agent", "file.read", reason, args, `error: ${msg}`); throw new Error(msg); };
  if (!h?.file) return fail(`${b.body} 不在线`);
  const ask = (params: Record<string, unknown>, ms: number) => h.file!(b.body, params, ms).catch((e: Error) => {
    if (/没有这个方法：file\.read/.test(e.message)) throw new Error(`${b.body} 需要升级：它的版本还不能把文件交给别的身体`);
    throw e;
  });
  let r: any;
  try { r = await ask({ path: file, reason }, FIRST_TIMEOUT_MS); } catch (e) { return fail((e as Error).message); }
  // 那边交回的也要核对
  if (!r || typeof r !== "object" || !Number.isSafeInteger(r.size) || r.size < 0 || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256) || typeof r.data !== "string" || typeof r.path !== "string" || r.path.length > 4096 || (r.ticket !== undefined && (typeof r.ticket !== "string" || r.ticket.length > 64))) return fail(`${b.body} 交回的数据格式不对`);
  if (r.size > FILE_MAX_BYTES) return fail(`文件太大（${mb(r.size)}，跨身体最多 ${FILE_MAX_BYTES >> 20} MB）`);
  const close = () => { if (r.ticket) void ask({ ticket: r.ticket, close: true }, PIECE_TIMEOUT_MS).catch(() => {}); };
  const dir = fetchedDir(BODY_NAME.test(b.body) ? b.body : (b.uuid ?? "unknown"));
  fs.mkdirSync(dir, { recursive: true });
  const name = safeFileName(r.path), ext = path.extname(name), stem = name.slice(0, name.length - ext.length) || "file";
  let dest = "", fh: fs.promises.FileHandle | undefined;
  for (let i = 1; i <= 1000 && !fh; i++) {
    dest = path.join(dir, i === 1 ? name : `${stem}-${i}${ext}`);
    if (path.dirname(dest) !== dir) return fail("文件名不对");
    try { fh = await fs.promises.open(dest, "wx"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fail(`没法在这里保存（${(e as Error).message.slice(0, 100)}）`);
      const st = fs.lstatSync(dest);
      if (st.isFile() && st.size === r.size && (await sha256Of(dest)) === r.sha256) { close(); audit("agent", "file.read", reason, args, `✓ 已有相同的文件 ${dest}`); return { local: dest, remote: r.path, size: r.size, reused: true }; }
    }
  }
  if (!fh) { close(); return fail("同名的文件太多"); }
  const hash = crypto.createHash("sha256");
  let got = 0;
  try {
    for (let data: unknown = r.data; ;) {
      const want = Math.min(PIECE_BYTES, r.size - got);
      if (typeof data !== "string" || data.length > Math.ceil(PIECE_BYTES / 3) * 4 || !B64.test(data)) throw new Error(`${b.body} 交回的数据格式不对`);
      const buf = Buffer.from(data, "base64");
      if (buf.length !== want) throw new Error(`${b.body} 交回的一段长度不对`);
      hash.update(buf); await fh.write(buf, 0, buf.length); got += buf.length;
      if (got >= r.size) break;
      if (!r.ticket) throw new Error(`${b.body} 交回的数据不完整`);
      if (fs.existsSync(paths.stop)) throw new Error("急停中，传输中止");
      const next: any = await ask({ ticket: r.ticket, offset: got }, PIECE_TIMEOUT_MS);
      data = next?.data;
    }
    if (hash.digest("hex") !== r.sha256) throw new Error("取来的内容与那边的 sha256 不一致，没有保存");
    await fh.close();
  } catch (e) {
    close();
    await fh.close().catch(() => {});
    fs.rmSync(dest, { force: true });
    return fail((e as Error).message);
  }
  audit("agent", "file.read", reason, args, `✓ ${r.size} 字节，sha256 一致 → ${dest}`);
  return { local: dest, remote: r.path, size: r.size, reused: false };
}

// ---------- 接到工具上

export interface Fetched { remote: string; local: string }

/**
 * 工具带 body 时：按「跨身体操作」过闸门，把 names 列出的路径参数（字符串或字符串数组）从那具身体取来，换成本地路径。
 * 返回换好的参数、取来的文件与给她看的说明；数组参数里取不到的项去掉，单个路径取不到、或一个都没取到时返回说明文字（不调用工具）。
 */
export async function localize(tool: string, names: string[], args: Record<string, any>, reason: string): Promise<{ args: Record<string, any>; fetched: Fetched[]; note: string } | string> {
  const target = resolveBody(args.body);
  const { body: _b, ...rest } = args;
  if ("local" in target) return { args: rest, fetched: [], note: "" };
  if ("error" in target) return target.error;
  const b = target.remote;
  const wanted = names.flatMap((n) => (Array.isArray(rest[n]) ? rest[n] : rest[n] === undefined || rest[n] === "" ? [] : [rest[n]]).map(String)).slice(0, 20);
  if (!wanted.length) return `带了 body 却没有给要从 ${b.body} 取的文件路径${tool === "shell" ? "（shell 带 body 时要在 files 里列出要取来的文件，命令仍在这里执行；要在那具身体上执行命令用 body_call）" : ""}`;
  if (!(await check("body", tool, `从 ${b.body} 取文件：${reason}`.slice(0, 300), { body: b.uuid, paths: wanted }))) return "这个动作没有被允许（闸门拒绝或急停中）";
  const map = new Map<string, string>(), lines: string[] = [];
  for (const p of [...new Set(wanted)]) {
    try { const r = await fetchFile(b, p, reason); map.set(p, r.local); lines.push(`✓ ${b.body}:${r.remote} → ${r.local}（${r.size < 10240 ? `${r.size} 字节` : `${Math.round(r.size / 1024)} KB`}${r.reused ? "，之前取过，直接用" : ""}）`); }
    catch (e) { lines.push(`✗ ${b.body}:${p}：${(e as Error).message}`); }
  }
  const note = `从 ${b.body} 取来的文件：\n${lines.join("\n")}`;
  if (!map.size) return note;
  const out = { ...rest };
  for (const n of names) {
    if (Array.isArray(out[n])) out[n] = out[n].map(String).filter((p: string) => map.has(p)).map((p: string) => map.get(p));
    else if (typeof out[n] === "string" && out[n]) { if (!map.has(out[n])) return note; out[n] = map.get(out[n]); }
  }
  return { args: out, fetched: [...map].map(([remote, local]) => ({ remote, local })), note };
}
