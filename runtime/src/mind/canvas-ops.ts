// Canvas 的控制台操作（网关 canvas.* 方法，经 ops.ts 的 invoke，修改类操作写审计）。数据与规则在 canvas.ts。
//   - 对方在面板里的编辑、恢复、改名都是新版本 / 新的修改，她下一轮在系统提示里看到（canvasBlock 标出「对方改过」与改动的那一段）。
//   - 运行代码：按「执行命令」类别过闸门（询问时生成审批，等对方批准），在沙箱里执行，写审计；结果记在 canvas_runs，她下一轮看得到。
//   - 评论：缺省发给她（send 为假时只留在面板里）——作为对话里对方说的一条消息，带上被评论的片段与位置，她可以回复评论、标为已解决或直接改那一段。
import fs from "node:fs";
import * as cv from "./canvas.ts";
import { audit } from "../store.ts";
import { check } from "../guard/guard.ts";
import { log } from "../log.ts";

const id = (v: unknown) => String(v ?? "");
const quoteLines = (s: string, max = 1500) => { const t = s.length > max ? `${s.slice(0, max)}…（共 ${s.length} 字符）` : s; return t.split("\n").map((l) => `> ${l}`).join("\n"); };

/** 把一条评论（或回复）作为对方的话发给她：进对话、在那个会话里开一轮（或作为插话并入进行中的一轮）。不等她回复。 */
function sendToHer(doc: cv.CanvasDoc, text: string) {
  void import("./brain.ts").then((b) => b.converse("你", text, "控制台", { conv: doc.conv })).catch((e) => log("canvas", `评论没有送到她那里：${(e as Error).message}`));
}
export function commentMessage(doc: cv.CanvasDoc, t: cv.Thread, version: number): string {
  const where = t.quote ? `第 ${t.at.line}${t.at.endLine !== t.at.line ? `–${t.at.endLine}` : ""} 行选中了这段：\n${quoteLines(t.quote)}` : "整份文档";
  return `（Canvas 评论 [${t.id}]）我在 canvas「${doc.title}」（id: ${doc.id}，第 ${version} 版）${t.quote ? where : `对${where}`}\n评论：${t.text}`;
}

export const canvasOps = {
  "canvas.list": (a: { conv?: string }) => cv.listCanvases(a?.conv ? id(a.conv) : undefined),
  "canvas.get": (a: { id: string; version?: number | string }) => cv.getCanvas(id(a?.id), { version: a?.version }),
  "canvas.versions": (a: { id: string }) => cv.versions(id(a?.id)).map((v, i) => ({ n: i + 1, id: v.id, ts: v.ts, author: v.author, body: v.body, note: v.note, size: v.content.length })),
  "canvas.create": (a: { conv: string; title?: string; kind?: string; lang?: string; content?: string }, actor: string) => {
    const v = cv.createCanvas({ conv: id(a?.conv), title: a?.title ?? "", kind: a?.kind, lang: a?.lang, content: typeof a?.content === "string" ? a.content : "", author: "user" });
    audit(actor, "canvas.create", "", { id: v.id, conv: v.conv, title: v.title, kind: v.kind }, "ok");
    return v;
  },
  "canvas.edit": (a: { id: string; content: string; base?: string; note?: string }, actor: string) => {
    if (typeof a?.content !== "string") throw new cv.CanvasError("没有内容");
    const r = cv.editCanvas(id(a.id), { content: a.content, base: typeof a.base === "string" ? a.base : undefined, author: "user", note: typeof a.note === "string" ? a.note : "对方编辑" });
    if (r.changed) audit(actor, "canvas.edit", "", { id: a.id, version: r.view.version, size: r.view.size }, r.conflict ? "ok（她也改过，两版都在历史里）" : "ok");
    return { canvas: r.view, conflict: r.conflict, changed: r.changed };
  },
  "canvas.update": (a: { id: string; title?: string; lang?: string; kind?: string }, actor: string) => {
    const d = cv.updateCanvas(id(a?.id), { title: a?.title, lang: a?.lang, kind: a?.kind });
    audit(actor, "canvas.update", "", { id: d.id, title: d.title, kind: d.kind, lang: d.lang }, "ok");
    return cv.getCanvas(d.id);
  },
  "canvas.delete": (a: { id: string }, actor: string) => { const d = cv.updateCanvas(id(a?.id), { deleted: true }); audit(actor, "canvas.delete", "", { id: d.id, title: d.title }, "ok"); return true; },
  "canvas.restore": (a: { id: string; version: number | string }, actor: string) => {
    const v = cv.restoreCanvas(id(a?.id), a?.version, "user");
    audit(actor, "canvas.restore", "", { id: v.id, from: a?.version, version: v.version }, "ok");
    return v;
  },
  /** 运行代码：按「执行命令」过闸门（询问时等对方批准），沙箱里执行，写审计。 */
  "canvas.run": async (a: { id: string; version?: number | string; timeout?: number }, actor: string) => {
    const d = cv.getDoc(id(a?.id));
    if (!d || d.deleted) throw new cv.CanvasError(`没有这份 canvas：${a?.id}`);
    const args = { canvas: d.id, title: d.title, lang: d.lang, version: a?.version ?? "当前" };
    if (!(await check("shell", "canvas_run", `${actor}在 Canvas 面板里运行代码`, args))) { audit(actor, "canvas.run", "", args, "denied"); throw new cv.CanvasError("这个动作没有被允许（「执行命令」被禁止，或在急停中）"); }
    const r = await cv.runCanvas(d.id, { version: a?.version, by: "user", timeoutSec: a?.timeout });
    audit(actor, "canvas.run", "", args, `exit ${r.code}${r.note ? `（${r.note}）` : ""}`);
    return r;
  },
  /** 一次运行生成的图片（base64）；图片在别的身体上（运行发生在那里）时为 null。 */
  "canvas.runImage": (a: { run: string; name: string }) => {
    const f = cv.runImagePath(id(a?.run), id(a?.name));
    if (!f) return null;
    const ext = f.toLowerCase().split(".").pop() ?? "";
    return { mime: ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" } as Record<string, string>)[ext] ?? "application/octet-stream", data: fs.readFileSync(f).toString("base64") };
  },
  /** 对方选中一段加评论（start / end 为当前版本里的位置；都不给是评论整份文档）。send 缺省为真：发给她。 */
  "canvas.comment": (a: { id: string; text: string; start?: number; end?: number; send?: boolean }, actor: string) => {
    const t = cv.addComment({ doc: id(a?.id), text: String(a?.text ?? ""), author: "user", start: a?.start, end: a?.end });
    const d = cv.getDoc(t.doc)!;
    audit(actor, "canvas.comment", "", { id: t.id, canvas: d.id, quote: t.quote.slice(0, 200) }, a?.send === false ? "ok（只留在面板里）" : "ok（发给她）");
    if (a?.send !== false) sendToHer(d, commentMessage(d, t, cv.versions(d.id).length));
    return t;
  },
  "canvas.reply": (a: { thread: string; text: string; send?: boolean }, actor: string) => {
    const c = cv.replyComment(id(a?.thread), String(a?.text ?? ""), "user");
    const d = cv.getDoc(c.doc)!;
    const root = cv.threads(d.id).find((t) => t.id === c.thread);
    audit(actor, "canvas.reply", "", { thread: c.thread }, "ok");
    if (a?.send !== false && root) sendToHer(d, `（Canvas 评论回复 [${root.id}]）关于 canvas「${d.title}」（id: ${d.id}）${root.quote ? `第 ${root.at.line} 行「${root.quote.slice(0, 80)}${root.quote.length > 80 ? "…" : ""}」` : "整份文档"}的那条评论，我回复：${c.text}`);
    return c;
  },
  "canvas.resolve": (a: { thread: string; resolved?: boolean }, actor: string) => { const c = cv.resolveComment(id(a?.thread), a?.resolved !== false, "user"); audit(actor, "canvas.resolve", "", { thread: c.id, resolved: c.resolved }, "ok"); return c; },
  /** 采纳她的一条编辑建议：换掉那段原文（新版本），评论标为已解决。 */
  "canvas.apply": (a: { thread: string }, actor: string) => { const v = cv.applySuggestion(id(a?.thread), "user"); audit(actor, "canvas.apply", "", { thread: a?.thread, version: v.version }, "ok"); return v; },
};
