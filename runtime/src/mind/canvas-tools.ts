// 她操作 Canvas 的工具（数据与规则在 canvas.ts）：canvas_create / canvas_read / canvas_edit / canvas_list / canvas_run / canvas_comment。
//   读写归「会话与子 agent」类别（缺省允许，与 session_new 同类：都是她在这个会话里的工作区）；canvas_run 执行代码，归「执行命令」，
//   经闸门与审计（callTool），在与 shell 同一个沙箱里执行。
import { failed, type Tool, type ToolContext, type ToolFailure } from "./tools.ts";
import * as cv from "./canvas.ts";
import { config } from "../config.ts";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });
const READ_LIMIT = 20_000;

/** 这一轮所在的会话（session_new 之后是新会话）。醒来时没有会话。 */
const convOf = (ctx: ToolContext) => ctx.session?.switchTo ?? ctx.session?.conv ?? "";
const when = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: config.timezone });
const kindText = (s: cv.CanvasSummary) => (s.kind === "code" ? `代码 ${s.lang || "未标语言"}` : "Markdown 文档");
const wrap = async (f: () => Promise<string | ToolFailure> | string | ToolFailure): Promise<string | ToolFailure> => { try { return await f(); } catch (e) { if (e instanceof cv.CanvasError) return failed(e.message); throw e; } };

function threadText(t: cv.Thread): string {
  const where = t.quote ? `第 ${t.at.line}${t.at.endLine !== t.at.line ? `–${t.at.endLine}` : ""} 行「${t.quote.slice(0, 120)}${t.quote.length > 120 ? "…" : ""}」${t.at.status === "stale" ? "（原文已改掉，过时）" : t.at.status === "moved" ? "（内容变了，已重新定位）" : ""}` : "整份文档";
  const who = (a: cv.Author) => (a === "agent" ? "你" : "对方");
  return `[${t.id}] ${t.resolved ? "已解决 · " : ""}${who(t.author)}评论 ${where}：${t.text}${t.suggestion !== null ? `\n  编辑建议：改为「${t.suggestion.slice(0, 300)}」` : ""}${t.replies.map((r) => `\n  ↳ ${who(r.author)}（${when(r.ts)}）：${r.text}`).join("")}`;
}

export function canvasTools(): Tool[] {
  return [
    {
      name: "canvas_create", permission: "session",
      description: "在当前会话旁边新建一份 canvas（对方在控制台的 Canvas 面板里看得到、能直接编辑、运行代码、选中一段加评论）。写较长的文档、方案、代码时用它，比贴在回复里好：之后用 canvas_edit 一起改。kind=markdown 是文档；kind=code 是代码，lang 写语言（python、javascript、typescript、shell、powershell 可以直接运行，其他语言只编辑与高亮）。",
      parameters: obj({ title: str("标题"), kind: { type: "string", enum: ["markdown", "code"] }, lang: str("代码的语言，如 python"), content: str("初始内容") }, ["title", "content"]),
      handler: (a, ctx) => wrap(() => {
        const conv = convOf(ctx);
        if (!conv) return failed("canvas 属于一个会话：醒来思考时没有会话（可以先用 send_message 开一个会话，或在对话里再建）");
        const v = cv.createCanvas({ conv, title: String(a.title ?? ""), kind: a.kind, lang: a.lang, content: String(a.content ?? ""), author: "agent" });
        return `已新建 canvas「${v.title}」（id: ${v.id}，${kindText(v)}，第 1 版，${v.size} 字符）。对方在控制台的 Canvas 面板里看得到。`;
      }),
    },
    {
      name: "canvas_list", permission: "session",
      description: "列出当前会话的 canvas（all=true 列出所有会话的）：id、标题、类型、版本、最后修改、未解决的评论数。",
      parameters: obj({ all: { type: "boolean", description: "列出所有会话的" } }),
      handler: (a, ctx) => wrap(() => {
        const list = cv.listCanvases(a.all ? undefined : convOf(ctx) || undefined);
        if (!list.length) return a.all ? "还没有任何 canvas" : "这个会话还没有 canvas";
        return list.map((s) => `- 「${s.title}」 id: ${s.id}，${kindText(s)}，第 ${s.version} 版（${s.author === "agent" ? "你" : "对方"}改于 ${when(s.updated)}），${s.size} 字符${s.open ? `，${s.open} 条未解决的评论` : ""}${a.all ? `，会话 ${s.conv}` : ""}`).join("\n");
      }),
    },
    {
      name: "canvas_read", permission: "session",
      description: "读一份 canvas 的内容（缺省当前版本；version 填版本号读历史版本），长的分页：offset 为从第几个字符起，limit 为读多少（默认 20000）。同时列出评论与最近一次运行。",
      parameters: obj({ id: str("canvas 的 id"), version: { type: "integer", minimum: 1, description: "版本号（可选）" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100000 } }, ["id"]),
      handler: (a) => wrap(() => {
        const v = cv.getCanvas(String(a.id), { version: a.version });
        const off = Math.max(0, Math.floor(Number(a.offset) || 0)), lim = Math.min(100_000, Math.max(1, Math.floor(Number(a.limit) || READ_LIMIT)));
        const part = v.content.slice(off, off + lim), more = off + lim < v.content.length;
        if (off === 0 && !more) cv.noteRead(v.id, v.versionId);
        const head = `「${v.title}」（id: ${v.id}，${kindText(v)}，第 ${v.version} / ${v.versions} 版，${v.author === "agent" ? "你" : "对方"}写的，共 ${v.content.length} 字符${off || more ? `；这里是第 ${off}–${off + part.length} 个字符` : ""}）`;
        const th = v.threads.length ? `\n\n评论：\n${v.threads.map(threadText).join("\n")}` : "";
        const run = v.runs[0] ? `\n\n最近一次运行：${cv.describeRun(v.runs[0], 3000)}` : "";
        return `${head}\n${part}${more ? `\n…（还有 ${v.content.length - off - part.length} 个字符：offset=${off + part.length} 继续读）` : ""}${th}${run}`;
      }),
    },
    {
      name: "canvas_edit", permission: "session",
      description: "修改一份 canvas，每次修改是一个新版本（历史都在，可以恢复）。三选一：edits 按片段查找替换（推荐：每个 find 要与当前内容逐字一致、只出现一次；要全部替换同样的片段加 all=true）；content 整体替换；restore 填版本号恢复到那一版。也可以只改 title。note 是这次修改的说明（显示在版本历史里）。",
      parameters: obj({
        id: str("canvas 的 id"),
        edits: { type: "array", items: { type: "object", properties: { find: str("要替换的原文"), replace: str("换成"), all: { type: "boolean" } }, required: ["find", "replace"] } },
        content: str("整体替换的新内容"), restore: { type: "integer", minimum: 1, description: "恢复到第几版" }, title: str("新标题（可选）"), note: str("修改说明（可选）"),
      }, ["id"]),
      handler: (a) => wrap(() => {
        const id = String(a.id);
        if (typeof a.title === "string" && a.title.trim()) cv.updateCanvas(id, { title: a.title });
        let r: { view: cv.CanvasView; changed: boolean };
        if (a.restore !== undefined) r = { view: cv.restoreCanvas(id, Number(a.restore), "agent"), changed: true };
        else if (typeof a.content === "string" || Array.isArray(a.edits)) r = cv.editCanvas(id, { content: typeof a.content === "string" ? a.content : undefined, edits: Array.isArray(a.edits) ? a.edits : undefined, author: "agent", note: typeof a.note === "string" ? a.note : undefined });
        else if (typeof a.title === "string" && a.title.trim()) return `已改标题：「${cv.getCanvas(id).title}」`;
        else return failed("要给 edits、content、restore 或 title 之一");
        const v = r.view;
        const stale = v.threads.filter((t) => !t.resolved && t.at.status === "stale").length;
        return `${r.changed ? "已保存" : "内容没有变化，没有生成新版本"}：「${v.title}」第 ${v.version} 版（${v.size} 字符）。${stale ? `有 ${stale} 条未解决的评论对应的原文已经改掉了（过时），看过后可以用 canvas_comment 回复或标为已解决。` : ""}`;
      }),
    },
    {
      name: "canvas_run", permission: "shell",
      description: "运行一份代码 canvas（缺省当前版本）：Python、JavaScript（Node）、TypeScript、shell、PowerShell。在与 shell 同一个沙箱里执行，工作目录是一个新的运行目录（代码写的文件留在那里）；timeout 是多少秒没有任何输出就结束（默认 60，最多 600），总时长最多 15 分钟。返回退出码、stdout、stderr，以及代码保存的图片（matplotlib 用 savefig 存成 png，可以用 view_image 看）。对方在面板里也看得到结果。解释器不存在时如实说明。",
      parameters: obj({ id: str("canvas 的 id"), version: { type: "integer", minimum: 1, description: "版本号（可选）" }, timeout: { type: "number", description: "多少秒没有任何输出就结束" } }, ["id"]),
      handler: (a, ctx) => wrap(async () => {
        const r = await cv.runCanvas(String(a.id), { version: a.version, by: "agent", timeoutSec: a.timeout, signal: ctx.signal ?? ctx.session?.signal });
        const text = cv.describeRun(r);
        return r.code === 0 ? text : failed(text);
      }),
    },
    {
      name: "canvas_comment", permission: "session",
      description: "Canvas 的评论：对方选中一段加的评论会作为对话里的一条消息发给你（带着那一段与位置）。action=list 列出一份 canvas（id 填 canvas 的 id）的全部评论；reply 回复（id 填评论 id，text 为回复）；resolve 标为已解决、reopen 重新打开（id 填评论 id）；add 你主动对某段加评论或编辑建议（id 填 canvas 的 id，quote 为被评论的原文——与当前内容逐字一致，出现多次时 occurrence 指第几处——text 为评论，suggestion 为建议改成的文字，对方可以一键采纳；不给 quote 就是评论整份文档）。也可以不评论，直接用 canvas_edit 改那一段。",
      parameters: obj({
        action: { type: "string", enum: ["list", "add", "reply", "resolve", "reopen"] }, id: str("canvas 的 id（list / add）或评论的 id（reply / resolve / reopen）"),
        text: str("评论或回复"), quote: str("add：被评论的原文"), occurrence: { type: "integer", minimum: 1 }, suggestion: str("add：建议改成的文字（可选）"),
      }, ["action", "id"]),
      handler: (a) => wrap(() => {
        const id = String(a.id);
        switch (a.action) {
          case "list": { const v = cv.getCanvas(id); return v.threads.length ? v.threads.map(threadText).join("\n") : `「${v.title}」还没有评论`; }
          case "add": { const t = cv.addComment({ doc: id, text: String(a.text ?? ""), author: "agent", quote: typeof a.quote === "string" ? a.quote : undefined, occurrence: a.occurrence, suggestion: typeof a.suggestion === "string" ? a.suggestion : undefined }); return `已加评论 [${t.id}]（${t.quote ? `第 ${t.at.line} 行` : "整份文档"}）${t.suggestion !== null ? "，带编辑建议，对方可以一键采纳" : ""}`; }
          case "reply": { cv.replyComment(id, String(a.text ?? ""), "agent"); return "已回复"; }
          case "resolve": { cv.resolveComment(id, true, "agent"); return "已标为已解决"; }
          case "reopen": { cv.resolveComment(id, false, "agent"); return "已重新打开"; }
          default: return failed("action 只能是 list / add / reply / resolve / reopen");
        }
      }),
    },
  ];
}
