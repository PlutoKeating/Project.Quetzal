// Canvas（#33 / #34）：存储与版本、按片段修改、评论的锚定与重新定位、工具与闸门、系统提示里的 canvas、运行代码（沙箱、超时、没有解释器）、
//   复制来的行的检查与补齐摘要、控制台操作（评论发给她、编辑冲突、运行的闸门）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-canvas-"));
process.env.QUETZAL_CANVAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-canvas-runs-"));
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const cv = await import("../src/mind/canvas.ts");
const { callTool, allTools, builtinNames } = await import("../src/mind/tools.ts");
const { Session } = await import("../src/mind/activity.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { canvasOps } = await import("../src/mind/canvas-ops.ts");
const guard = await import("../src/guard/guard.ts");
const { sandboxStatus, prepareSandbox } = await import("../src/sandbox.ts");
const { bus } = await import("../src/bus.ts");
const { wanted } = await import("../src/mesh/canvas.ts");
const { which } = await import("../src/platform.ts");

after(() => { store.db.close(); fs.rmSync(paths.home, { recursive: true, force: true }); fs.rmSync(process.env.QUETZAL_CANVAS_DIR!, { recursive: true, force: true }); });
const chat = (conv: string) => { store.ensureSession(conv, "测试", "控制台"); const s = new Session("chat", "控制台", undefined, conv); s.close(); return s; };
const WIN = process.platform === "win32";

test("新建、按片段修改、整体替换、版本历史与恢复、改名与删除、按会话列出", () => {
  const v = cv.createCanvas({ conv: "c1", title: "  方案  ", content: "# 标题\n第一段\n第二段\n", author: "agent" });
  assert.match(v.id, /^cv-[0-9a-f]{12}$/);
  assert.deepEqual([v.title, v.kind, v.lang, v.version, v.versions], ["方案", "markdown", "", 1, 1]);
  const code = cv.createCanvas({ conv: "c1", title: "脚本", kind: "code", lang: "py", content: "print(1)", author: "user" });
  assert.deepEqual([code.kind, code.lang], ["code", "python"], "语言别名合一");
  assert.equal(cv.createCanvas({ conv: "c1", title: "x", lang: "javascript", content: "", author: "user" }).kind, "code", "给了代码语言就是代码");

  const e1 = cv.editCanvas(v.id, { edits: [{ find: "第一段", replace: "第一段（改）" }], author: "agent" });
  assert.equal(e1.view.content, "# 标题\n第一段（改）\n第二段\n");
  assert.equal(e1.view.version, 2);
  assert.throws(() => cv.editCanvas(v.id, { edits: [{ find: "不存在", replace: "x" }], author: "agent" }), /没有找到/);
  assert.throws(() => cv.editCanvas(v.id, { edits: [{ find: "段", replace: "节" }], author: "agent" }), /出现了 2 次/);
  assert.equal(cv.editCanvas(v.id, { edits: [{ find: "段", replace: "节", all: true }], author: "agent" }).view.content, "# 标题\n第一节（改）\n第二节\n");
  const same = cv.editCanvas(v.id, { content: "# 标题\n第一节（改）\n第二节\n", author: "user" });
  assert.equal(same.changed, false, "内容没变不生成新版本");
  cv.editCanvas(v.id, { content: "全新", author: "user" });
  const hist = cv.versions(v.id);
  assert.deepEqual(hist.map((h) => h.author), ["agent", "agent", "agent", "user"]);
  assert.ok(hist.every((h, i) => i === 0 || h.ts > hist[i - 1].ts), "版本时刻严格递增");
  assert.equal(cv.getCanvas(v.id, { version: 1 }).content, "# 标题\n第一段\n第二段\n", "回看历史版本");
  const r = cv.restoreCanvas(v.id, 1, "user");
  assert.deepEqual([r.version, r.content], [5, "# 标题\n第一段\n第二段\n"]);
  assert.match(cv.versions(v.id).at(-1)!.note, /恢复到第 1 版/);
  assert.throws(() => cv.getCanvas(v.id, { version: 99 }), /没有这个版本/);
  assert.throws(() => cv.editCanvas(v.id, { content: "x".repeat(cv.MAX_CONTENT + 1), author: "user" }), /太长/);

  cv.updateCanvas(code.id, { title: "新名字", lang: "js" });
  assert.deepEqual([cv.getCanvas(code.id).title, cv.getCanvas(code.id).lang], ["新名字", "javascript"]);
  cv.updateCanvas(code.id, { deleted: true });
  assert.ok(!cv.listCanvases("c1").some((s) => s.id === code.id), "删除了的不列");
  assert.throws(() => cv.getCanvas(code.id), /已删除/);
  assert.ok(cv.listCanvases("c1").length >= 2 && !cv.listCanvases("other").length);
});

test("锚点：原位置、内容前面插入后重新定位、多处出现取前后文最吻合的、原文改掉标为过时", () => {
  const text = "苹果很好吃。\n香蕉也不错。\n苹果很好吃。\n结尾";
  const second = text.lastIndexOf("苹果很好吃");
  const a = cv.anchorAt(text, second, second + 5);
  assert.equal(a.quote, "苹果很好吃");
  assert.deepEqual(cv.locate(text, a), { start: second, end: second + 5, status: "exact", line: 3, endLine: 3 });
  const inserted = "新的一行\n" + text;
  const moved = cv.locate(inserted, a);
  assert.equal(moved.status, "moved");
  assert.equal(moved.start, second + 5, "按前后文选中第二处，而不是第一处");
  assert.equal(moved.line, 4);
  const gone = cv.locate(text.replace(/苹果很好吃/g, "梨"), a);
  assert.equal(gone.status, "stale");
  assert.equal(cv.locate("任何内容", { quote: "", start: 0, end: 0, prefix: "", suffix: "" }).status, "exact", "评论整份文档总能定位");
});

test("评论：选中范围或原文加评论、回复、解决与重开、编辑建议的采纳、过时的建议不采纳", () => {
  const v = cv.createCanvas({ conv: "c2", title: "文", content: "第一行\n要改的句子\n第三行", author: "agent" });
  const start = v.content.indexOf("要改的句子");
  const t = cv.addComment({ doc: v.id, text: "这句太长", author: "user", start, end: start + 5 });
  assert.deepEqual([t.quote, t.at.line, t.at.status], ["要改的句子", 2, "exact"]);
  assert.throws(() => cv.addComment({ doc: v.id, text: "", author: "user" }), /空的/);
  assert.throws(() => cv.addComment({ doc: v.id, text: "x", quote: "没有的话", author: "agent" }), /没有找到/);
  const whole = cv.addComment({ doc: v.id, text: "整体不错", author: "user" });
  assert.equal(whole.quote, "");

  cv.resolveComment(t.id, true, "agent");
  assert.equal(cv.threads(v.id).find((x) => x.id === t.id)!.resolved, true);
  const rep = cv.replyComment(t.id, "其实还是有点长", "user");
  const th = cv.threads(v.id).find((x) => x.id === t.id)!;
  assert.equal(th.resolved, false, "已解决的串里又有人说话就重新打开");
  assert.deepEqual(th.replies.map((r) => r.id), [rep.id]);
  assert.equal(cv.replyComment(rep.id, "回复的回复也挂在根上", "agent").thread, t.id);

  // 她主动加的编辑建议：对方一键采纳 → 新版本、评论已解决；内容前面插了字也能定位
  const sug = cv.addComment({ doc: v.id, text: "建议简短些", author: "agent", quote: "要改的句子", suggestion: "短句" });
  cv.editCanvas(v.id, { content: "新开头\n" + cv.getCanvas(v.id).content, author: "user" });
  const after1 = cv.applySuggestion(sug.id, "user");
  assert.equal(after1.content, "新开头\n第一行\n短句\n第三行");
  assert.equal(cv.threads(v.id).find((x) => x.id === sug.id)!.resolved, true);
  // 第一条评论的原文已经改掉：过时
  assert.equal(cv.threads(v.id).find((x) => x.id === t.id)!.at.status, "stale");
  const old = cv.addComment({ doc: v.id, text: "换个词", author: "agent", quote: "第三行", suggestion: "末行" });
  cv.editCanvas(v.id, { edits: [{ find: "第三行", replace: "最后" }], author: "user" });
  assert.throws(() => cv.applySuggestion(old.id, "user"), /对不上/);
});

test("工具：经闸门、属于当前会话、失败标红；工具名进了内置名单（自造工具不能重名）", async () => {
  for (const n of ["canvas_create", "canvas_read", "canvas_edit", "canvas_list", "canvas_run", "canvas_comment"]) {
    assert.ok(allTools().some((t) => t.name === n), n);
    assert.ok(builtinNames().includes(n));
  }
  assert.equal(allTools().find((t) => t.name === "canvas_run")!.permission, "shell");
  const s = chat("c3");
  const made = await callTool("canvas_create", { title: "报告", content: "# 报告\n正文" }, "测试", { session: s });
  assert.equal(made.status, "ok");
  const id = /id: (cv-[0-9a-f]+)/.exec(made.text)![1];
  assert.equal(cv.getDoc(id)!.conv, "c3");
  assert.equal((await callTool("canvas_create", { title: "x", content: "" }, "测试", { session: new Session("think") })).status, "error", "醒来时没有会话");
  const bad = await callTool("canvas_edit", { id, edits: [{ find: "不在里面", replace: "x" }] }, "测试", { session: s });
  assert.equal(bad.status, "error");
  assert.match(bad.text, /没有找到/);
  const ok = await callTool("canvas_edit", { id, edits: [{ find: "正文", replace: "正文第二版" }], note: "补充" }, "测试", { session: s });
  assert.match(ok.text, /第 2 版/);
  const read = await callTool("canvas_read", { id, offset: 0, limit: 4 }, "测试", { session: s });
  assert.match(read.text, /还有 .* 个字符：offset=4 继续读/);
  const list = await callTool("canvas_list", {}, "测试", { session: s });
  assert.match(list.text, /「报告」/);
  const add = await callTool("canvas_comment", { action: "add", id, quote: "正文第二版", text: "这里要加数据", suggestion: "正文第二版（附数据）" }, "测试", { session: s });
  assert.match(add.text, /已加评论 \[cm-/);
  const listC = await callTool("canvas_comment", { action: "list", id }, "测试", { session: s });
  assert.match(listC.text, /编辑建议/);
  assert.ok(store.listAudit(20).some((a) => a.action === "canvas_edit"), "工具调用写审计");
  guard.setLevel("session", "deny", "测试");
  try { assert.equal((await callTool("canvas_list", {}, "测试", { session: s })).status, "denied"); }
  finally { guard.setLevel("session", "allow", "测试"); }
});

test("系统提示：这个会话的 canvas、对方改过的地方与未解决的评论；大文档只给概要", () => {
  store.ensureSession("c4", "测试", "控制台");
  const v = cv.createCanvas({ conv: "c4", title: "小文档", content: "甲\n乙\n丙", author: "agent" });
  let p = systemPrompt("", { conv: "c4", dynamic: true });
  assert.match(p, /## Canvas/);
  assert.match(p, /「小文档」/);
  assert.match(p, /甲\n乙\n丙/);
  assert.doesNotMatch(p, /对方在你上次看过之后改过/);
  cv.editCanvas(v.id, { content: "甲\n乙（对方改的）\n丙", author: "user" });
  cv.addComment({ doc: v.id, text: "乙这里再想想", author: "user", quote: "乙（对方改的）" });
  p = systemPrompt("", { conv: "c4", dynamic: true });
  assert.match(p, /对方在你上次看过之后改过/);
  assert.match(p, /- 乙\n\+ 乙（对方改的）/);
  assert.match(p, /乙这里再想想/);
  assert.doesNotMatch(systemPrompt("", { conv: "c4", dynamic: true }), /对方在你上次看过之后改过/, "看过一次就不再标");
  cv.createCanvas({ conv: "c4", title: "长文", content: "# 一章\n" + "很长的内容。\n".repeat(2000) + "## 二节\n", author: "agent" });
  p = systemPrompt("", { conv: "c4", dynamic: true });
  assert.match(p, /内容较长（\d+ 字符），这里只给概要，用 canvas_read 分页读/);
  assert.match(p, /第 2002 行 ## 二节/);
  assert.doesNotMatch(systemPrompt("", { conv: "no-canvas", dynamic: true }), /## Canvas/, "没有 canvas 的会话不出现这一节");
});

test("运行：没有解释器时如实说明、不执行；文档不能运行", async () => {
  const v = cv.createCanvas({ conv: "c5", title: "py", kind: "code", lang: "python", content: "print('hi')", author: "agent" });
  const r = await cv.runCanvas(v.id, { by: "user", find: () => undefined });
  assert.equal(r.code, 127);
  assert.match(r.err, /没有 Python 3/);
  assert.equal(r.dir, "", "没有建运行目录");
  assert.match(cv.describeRun(r), /退出码 127/);
  const doc = cv.createCanvas({ conv: "c5", title: "文", content: "x", author: "agent" });
  await assert.rejects(cv.runCanvas(doc.id, { by: "user" }), /只有代码 canvas 能运行/);
  const shellWin = cv.interpreter("shell", "", () => "/bin/sh");
  if (WIN) assert.ok("missing" in shellWin); else assert.ok(!("missing" in shellWin));
  assert.ok("missing" in cv.interpreter("rust", ""), "不能运行的语言说明原因");
});

await prepareSandbox().catch(() => {});
const sandboxed = sandboxStatus().kind !== "none";
const py = WIN ? which("python") : which("python3") ?? which("python");

test("运行 JavaScript：在沙箱里执行（读不到密钥目录），输出与退出码、工具经闸门与审计", async () => {
  fs.writeFileSync(path.join(paths.secrets, "canvas-canary"), "SECRET-CANARY");
  const v = cv.createCanvas({ conv: "c6", title: "js", kind: "code", lang: "javascript", author: "agent",
    content: `const fs = require("fs");\nlet seen = "no";\ntry { seen = fs.readFileSync(${JSON.stringify(path.join(paths.secrets, "canvas-canary"))}, "utf8"); } catch {}\nconsole.log("canary:" + seen);\nconsole.error("to-stderr");\nprocess.exit(3);` });
  const r = await cv.runCanvas(v.id, { by: "user" });
  if (!sandboxed) { assert.equal(r.code, 126); assert.match(r.err, /没有可用的命令沙箱/); return; } // 没有沙箱：不执行（fail-closed）
  assert.equal(r.code, 3);
  assert.match(r.out, /canary:no/, "沙箱里读不到密钥目录");
  assert.doesNotMatch(r.out + r.err, /SECRET-CANARY/);
  assert.match(r.err, /to-stderr/);
  assert.ok(fs.existsSync(path.join(r.dir, "main.cjs")) && r.dir.startsWith(process.env.QUETZAL_CANVAS_DIR!));
  const s = chat("c6");
  const t = await callTool("canvas_run", { id: v.id }, "测试", { session: s });
  assert.equal(t.status, "error", "非零退出算失败");
  assert.match(t.text, /退出码 3/);
  assert.ok(store.listAudit(20).some((a) => a.action === "canvas_run"));
  guard.setLevel("shell", "deny", "测试");
  try {
    assert.equal((await callTool("canvas_run", { id: v.id }, "测试", { session: s })).status, "denied", "运行归「执行命令」类别");
    await assert.rejects(canvasOps["canvas.run"]({ id: v.id }, "控制台"), /没有被允许/, "控制台的运行同样过闸门");
  } finally { guard.setLevel("shell", "allow", "测试"); }
  const viaOps = await canvasOps["canvas.run"]({ id: v.id }, "控制台");
  assert.equal(viaOps.by, "user");
  assert.ok(store.listAudit(20).some((a) => a.action === "canvas.run" && a.actor === "控制台"));
  assert.equal(cv.runs(v.id, 10).length, 3);
});

test("运行超时：多久没有输出就结束", { skip: !sandboxed && "没有沙箱" }, async () => {
  const v = cv.createCanvas({ conv: "c7", title: "慢", kind: "code", lang: "javascript", content: "setTimeout(() => console.log('done'), 30000);", author: "agent" });
  const t0 = Date.now();
  const r = await cv.runCanvas(v.id, { by: "agent", timeoutSec: 1 });
  assert.ok(Date.now() - t0 < 15_000);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /1 秒没有任何输出，已结束/);
  assert.equal(r.note, "超时");
});

test("运行 Python：输出、生成的图片（只收真的图片文件，不跟随符号链接）可以取回", { skip: (!sandboxed && "没有沙箱") || (!py && "这台机器没有 Python 3") }, async () => {
  const code = [
    "import base64, os",
    "png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')",
    "open('plot.png', 'wb').write(png)",
    "open('fake.png', 'w').write('not a png')",
    WIN ? "" : "os.symlink('/etc/hostname', 'link.png')",
    "print('中文输出', os.environ.get('MPLBACKEND'))",
  ].join("\n");
  const v = cv.createCanvas({ conv: "c8", title: "画图", kind: "code", lang: "python", content: code, author: "agent" });
  const r = await cv.runCanvas(v.id, { by: "agent" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /中文输出 Agg/);
  assert.deepEqual(r.images.map((i) => i.name), ["plot.png"]);
  const f = cv.runImagePath(r.id, "plot.png")!;
  assert.ok(f.startsWith(path.join(paths.data, "canvas-runs")));
  assert.equal(cv.runImagePath(r.id, "../plot.png"), undefined);
  const img = canvasOps["canvas.runImage"]({ run: r.id, name: "plot.png" })!;
  assert.equal(img.mime, "image/png");
  assert.ok(Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG");
  assert.match(cv.describeRun(r), /view_image/);
});

test("复制来的行：逐字段检查、实时只收发来的身体自己写的、版本不可变、评论按较新的修改为准；补齐摘要", () => {
  const now = Date.now();
  const doc = { id: "cv-aaaaaaaaaaaa", conv: "c9", title: "别处建的", kind: "code", lang: "python", created: now - 1000, changed: now - 1000, deleted: 0, body: "pc" };
  const ver = { id: "v-aaaaaaaaaaaaaaaa", doc: doc.id, ts: now - 900, author: "agent", body: "pc", content: "print(2)", note: "新建", parent: null };
  const events: any[] = [];
  const on = (e: any) => events.push(e);
  bus.on("canvas.changed", on);
  assert.deepEqual(cv.applyCanvasRemote({ docs: [doc], versions: [ver] }, { from: "pc" }), { changed: 2, rejected: 0 });
  assert.equal(cv.getCanvas(doc.id).content, "print(2)");
  assert.ok(events.some((e) => e.doc === doc.id && e.kind === "replica" && e.conv === "c9"), "控制台据此刷新");
  bus.off("canvas.changed", on as any);
  // 实时：只能是发来的那具身体写的；补齐时可以带别的身体的
  const other = { ...ver, id: "v-bbbbbbbbbbbbbbbb", ts: now - 800, body: "laptop", content: "print(3)" };
  assert.equal(cv.applyCanvasRemote({ versions: [other] }, { from: "pc" }).rejected, 1);
  assert.equal(cv.applyCanvasRemote({ versions: [other] }, { from: "pc", catchUp: true }).changed, 1);
  // 不合格的：编号、类型、长度、时间、作者
  const bad = [
    { ...ver, id: "v-1" }, { ...ver, id: "v-cccccccccccccccc", author: "root" }, { ...ver, id: "v-dddddddddddddddd", ts: now + 3_600_000 },
    { ...ver, id: "v-eeeeeeeeeeeeeeee", content: "x".repeat(cv.MAX_CONTENT + 1) }, { ...ver, id: "v-ffffffffffffffff", body: "Bad Body" },
  ];
  assert.equal(cv.applyCanvasRemote({ versions: bad }, { from: "pc", catchUp: true }).rejected, bad.length);
  assert.equal(cv.applyCanvasRemote({ docs: [{ ...doc, id: "cv-bbbbbbbbbbbb", kind: "exe" }] }, { from: "pc" }).rejected, 1);
  // 版本不可变：同一个 id 再来一次内容不同也不改
  assert.equal(cv.applyCanvasRemote({ versions: [{ ...ver, content: "篡改" }] }, { from: "pc" }).changed, 0);
  assert.equal(cv.versions(doc.id)[0].content, "print(2)");
  // canvas 的标题：较新的修改为准
  assert.equal(cv.applyCanvasRemote({ docs: [{ ...doc, title: "旧标题", changed: now - 5000 }] }, { from: "pc" }).changed, 0);
  cv.applyCanvasRemote({ docs: [{ ...doc, title: "新标题", changed: now - 10 }] }, { from: "pc" });
  assert.equal(cv.getDoc(doc.id)!.title, "新标题");
  // 评论：解决状态按较新的修改为准；运行的图片清单要合规
  const c = { id: "cm-aaaaaaaaaaaa", doc: doc.id, thread: null, ts: now - 500, author: "user", body: "pc", text: "看这里", quote: "print", start: 0, end: 5, version: ver.id, prefix: "", suffix: "(2)", resolved: 0, changed: now - 500, suggestion: null };
  assert.equal(cv.applyCanvasRemote({ comments: [c] }, { from: "pc" }).changed, 1);
  cv.applyCanvasRemote({ comments: [{ ...c, resolved: 1, changed: now - 100 }] }, { from: "pc" });
  assert.equal(cv.threads(doc.id)[0].resolved, true);
  cv.applyCanvasRemote({ comments: [{ ...c, resolved: 0, changed: now - 400 }] }, { from: "pc" });
  assert.equal(cv.threads(doc.id)[0].resolved, true, "较旧的修改不采用");
  const run = { id: "run-aaaaaaaaaaaa", doc: doc.id, version: ver.id, ts: now - 50, by: "user", body: "pc", lang: "python", code: 0, out: "2\n", err: "", images: JSON.stringify([{ name: "a.png", size: 10, mime: "image/png" }]), ms: 12, dir: "/x", note: "" };
  assert.equal(cv.applyCanvasRemote({ runs: [run, { ...run, id: "run-bbbbbbbbbbbb", images: JSON.stringify([{ name: "../a.png", size: 1, mime: "image/png" }]) }] }, { from: "pc" }).rejected, 1);
  assert.equal(cv.runImagePath(run.id, "a.png"), undefined, "图片在别的身体上");
  // 补齐摘要：对方有而我没有、或对方较新的
  const d = cv.canvasDigest();
  assert.ok(d.versions.includes(ver.id) && d.docs[doc.id] && d.runs.includes(run.id));
  const w = wanted({ docs: { [doc.id]: d.docs[doc.id] + 1, "cv-cccccccccccc": now, "bad": now }, versions: [ver.id, "v-9999999999999999", 5], comments: { [c.id]: 0 }, runs: [] });
  assert.deepEqual(w, { docs: [doc.id, "cv-cccccccccccc"], versions: ["v-9999999999999999"], comments: [], runs: [] });
  const rows = cv.canvasRows({ docs: [doc.id], versions: [ver.id, "nope"], comments: [c.id], runs: [run.id] });
  assert.deepEqual([rows.docs!.length, rows.versions!.length, rows.comments!.length, rows.runs!.length], [1, 1, 1, 1]);
});

test("本机写入时发出复制事件（网状层据此广播）", () => {
  const got: any[] = [];
  const on = (e: any) => got.push(e);
  bus.on("canvas.replica", on);
  const v = cv.createCanvas({ conv: "c10", title: "x", content: "a", author: "agent" });
  cv.editCanvas(v.id, { content: "b", author: "user" });
  cv.addComment({ doc: v.id, text: "嗯", author: "user" });
  bus.off("canvas.replica", on as any);
  assert.equal(got[0].docs[0].id, v.id);
  assert.equal(got[0].versions.length, 1);
  assert.equal(got[1].versions[0].content, "b");
  assert.equal(got[2].comments[0].text, "嗯");
});

test("控制台操作：编辑基于旧版本时如实返回冲突、评论缺省发给她（带片段与位置）、只留面板的不发", async () => {
  store.ensureSession("c11", "测试", "控制台");
  const v = canvasOps["canvas.create"]({ conv: "c11", title: "一起写", content: "第一行\n第二行" }, "控制台");
  const base = v.versionId;
  cv.editCanvas(v.id, { content: "第一行\n第二行\n她加的", author: "agent" });
  const r = canvasOps["canvas.edit"]({ id: v.id, content: "我的改动", base }, "控制台");
  assert.deepEqual([r.conflict, r.changed, r.canvas.content], [true, true, "我的改动"]);
  assert.ok(cv.versions(v.id).some((x) => x.content === "第一行\n第二行\n她加的"), "她的那版在历史里");
  const hist = canvasOps["canvas.versions"]({ id: v.id });
  assert.deepEqual(hist.map((h) => h.n), [1, 2, 3]);

  const before = store.sessionMessages("c11", 50).length;
  canvasOps["canvas.comment"]({ id: v.id, text: "只是给自己记一笔", send: false }, "控制台");
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(store.sessionMessages("c11", 50).length, before, "send=false 不发");
  const t = cv.addComment({ doc: v.id, text: "这里换个说法", author: "user", start: 0, end: 2 });
  const msg = (await import("../src/mind/canvas-ops.ts")).commentMessage(cv.getDoc(v.id)!, t, 3);
  assert.match(msg, /Canvas 评论 \[cm-[0-9a-f]+\]/);
  assert.match(msg, /第 1 行选中了这段：\n> 我的/);
  assert.match(msg, /评论：这里换个说法/);
});
