// 会话列表增强（#30）：置顶、项目与归属、筛选与排序、旧库补列；复制来的会话行逐字段合并与校验（旧版本身体不带新字段）；
// 项目按条目合并（删除留墓碑）；按标题与内容搜索（片段与高亮）；控制台接口、project 工具与系统提示里的项目说明。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-organize-"));
// 一个升级前的旧库：会话表没有置顶与项目的列
{
  fs.mkdirSync(path.join(process.env.QUETZAL_HOME, "data"), { recursive: true });
  const db = new DatabaseSync(path.join(process.env.QUETZAL_HOME, "data", "quetzal.db"));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, channel TEXT, created INTEGER, updated INTEGER, archived INTEGER DEFAULT 0);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, ts INTEGER, role TEXT, channel TEXT, text TEXT, session TEXT, process TEXT, attachments TEXT, mode TEXT);`);
  db.prepare("INSERT INTO sessions VALUES('old','升级前的会话','控制台',?,?,0)").run(Date.now() - 86400_000, Date.now() - 86400_000);
  db.close();
}
const { loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
saveConfig({ brain: { memoryLearning: false, memorySemantic: false } });
const store = await import("../src/store.ts");
store.openStore();
const projects = await import("../src/mind/projects.ts");
const { searchSessions, snippetOf, markTerms } = await import("../src/mind/session-search.ts");
const { ops } = await import("../src/ops.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { Session } = await import("../src/mind/activity.ts");
const { bus } = await import("../src/bus.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = (l: { id: string }[]) => l.map((s) => s.id);

test("旧库补上置顶与项目的列，旧会话缺省没置顶、不属于项目", () => {
  const cols = (store.db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
  for (const c of ["pinned", "pin_changed", "project", "project_changed"]) assert.ok(cols.includes(c), `补了 ${c}`);
  const s = store.getSession("old")!;
  assert.deepEqual([s.pinned, s.project], [0, null]);
});

test("置顶：排在最前，置顶之间新置顶的在上；取消后回到按更新排序；改动发出复制事件", async () => {
  const rows: any[] = [];
  const on = (e: any) => { if (e.table === "sessions") rows.push(...e.rows); };
  bus.on("replica", on);
  for (const id of ["a", "b", "c"]) { store.ensureSession(id, `会话 ${id}`); await sleep(3); store.addMessage("user", "控制台", `${id} 的话`, { session: id }); }
  assert.deepEqual(ids(store.listSessions()).slice(0, 3), ["c", "b", "a"]);
  store.setSessionPinned("a", true); await sleep(3);
  store.setSessionPinned("b", true);
  assert.deepEqual(ids(store.listSessions()).slice(0, 3), ["b", "a", "c"], "置顶的在前，后置顶的 b 在上");
  assert.deepEqual(ids(store.listSessions({ pinned: true })), ["b", "a"]);
  store.setSessionPinned("b", false);
  assert.deepEqual(ids(store.listSessions()).slice(0, 3), ["a", "c", "b"]);
  const r = rows.findLast((x) => x.id === "b");
  assert.ok(r && r.pinned === 0 && r.pin_changed > 0, "复制的行带着置顶与它的修改时刻");
  assert.equal(store.setSessionPinned("没有", true), undefined);
  bus.off("replica", on);
});

test("筛选与排序：通道、子 agent 报告、时间范围、标题；按创建时间与标题排序", async () => {
  store.ensureSession("fs", "飞书上的", "飞书");
  store.ensureSession("sub", "派了子 agent 的");
  store.addMessage("ambient", store.SUBAGENT_CHANNEL, "子 agent 的报告", { session: "sub" });
  assert.deepEqual(ids(store.listSessions({ channel: "飞书" })), ["fs"]);
  assert.deepEqual(ids(store.listSessions({ channel: store.SUBAGENT_CHANNEL })), ["sub"]);
  const t = Date.now();
  assert.ok(!ids(store.listSessions({ from: t - 3_600_000 })).includes("old"), "一天前更新的不在最近一小时里");
  assert.deepEqual(ids(store.listSessions({ to: t - 3_600_000 })), ["old"]);
  assert.deepEqual(ids(store.listSessions({ title: "飞书" })), ["fs"]);
  assert.deepEqual(ids(store.listSessions({ title: "%" })), [], "LIKE 的通配符照字面");
  const byTitle = store.listSessions({ sort: "title" }).filter((s) => !s.pinned).map((s) => s.title);
  const lo = (x: string) => x.toLowerCase();
  assert.deepEqual(byTitle, [...byTitle].sort((x, y) => (lo(x) < lo(y) ? -1 : lo(x) > lo(y) ? 1 : 0)), "按标题排（SQLite NOCASE）");
  const created = store.listSessions({ sort: "created" }).filter((s) => !s.pinned).map((s) => s.created);
  assert.deepEqual(created, [...created].sort((x, y) => y - x));
  assert.equal(store.listSessions({ sort: "created" })[0].id, "a", "置顶的仍在最前");
});

test("项目：新建、改、重名、归档；会话归到项目，按项目筛选；删除项目只解除归属（留墓碑）", () => {
  const p = projects.create({ name: "搬家", description: "下个月搬家的事", instructions: "回答都用清单", color: "#AA3300", icon: "home" });
  assert.match(p.id, /^[0-9a-f]{16}$/);
  assert.equal(p.color, "#aa3300");
  assert.throws(() => projects.create({ name: "搬家" }), /已经有/);
  assert.throws(() => projects.create({ name: "  " }), /名字/);
  assert.throws(() => projects.update(p.id, { color: "red" }), /颜色/);
  store.setSessionProject("a", p.id); store.setSessionProject("c", p.id);
  assert.deepEqual(ids(store.listSessions({ project: p.id })).sort(), ["a", "c"]);
  assert.ok(!ids(store.listSessions({ project: "none", projects: projects.liveIds() })).includes("a"));
  const q = projects.update(p.id, { name: "新家", archived: true });
  assert.equal(q.name, "新家");
  assert.deepEqual(projects.list({ archived: false }).map((x) => x.id), []);
  assert.deepEqual(projects.list({ archived: true }).map((x) => x.id), [p.id]);
  projects.update(p.id, { archived: false });
  assert.equal(projects.find("新家")?.id, p.id, "按名字找");
  const n = projects.remove(p.id);
  assert.equal(n, 2);
  assert.equal(store.getSession("a")!.project, null, "会话还在，只是不属于项目了");
  assert.ok(projects.all().find((x) => x.id === p.id)?.deleted, "留了墓碑");
  assert.equal(projects.get(p.id), undefined);
});

test("项目按条目合并：较新的修改为准，墓碑压过旧的，不合格的不收", () => {
  const now = Date.now();
  const x = { id: "0123456789abcdef", name: "别处建的", description: "", instructions: "说明", created: now - 1000, updated: now - 1000 };
  assert.equal(projects.merge([x]), true);
  assert.equal(projects.get(x.id)?.name, "别处建的");
  assert.equal(projects.merge([{ ...x, name: "更旧的", updated: now - 2000 }]), false);
  assert.equal(projects.merge([{ ...x, name: "改过的", updated: now }]), true);
  assert.equal(projects.get(x.id)?.name, "改过的");
  assert.equal(projects.merge([{ ...x, deleted: true, updated: now + 1 }]), true);
  assert.equal(projects.get(x.id), undefined);
  assert.equal(projects.merge([{ ...x, name: "复活？", updated: now }]), false, "比墓碑旧的不能复活");
  // 不合格：编号格式、未来的时刻、超长的说明、坏颜色被丢掉而不是整条拒收
  assert.equal(projects.merge([{ ...x, id: "../x", updated: now + 10 }, { ...x, id: "1111111111111111", updated: now + 3_600_000 }, { ...x, id: "2222222222222222", instructions: "长".repeat(9000) }, "x", null]), false);
  assert.equal(projects.merge([{ ...x, id: "3333333333333333", color: "javascript:", icon: "<b>" }]), true);
  const y = projects.get("3333333333333333")!;
  assert.deepEqual([y.color, y.icon], [undefined, undefined]);
});

test("复制来的会话行：置顶与项目逐字段以较新的为准；旧版本身体的行不带新字段时不动本机；坏字段整行丢弃", () => {
  const p = projects.create({ name: "复制用" });
  store.ensureSession("r1", "复制的会话");
  store.setSessionPinned("r1", true);
  store.setSessionProject("r1", p.id);
  const cur = store.allSessions().find((s) => s.id === "r1");
  const from = { from: "pc" };
  // 旧版本身体：只有前七列，标题更新
  const r = store.applyRemote("sessions", [{ id: "r1", title: "旧身体改的标题", channel: "控制台", created: cur.created, updated: cur.updated, archived: 0, changed: Date.now() + 1 }], from);
  assert.equal(r.changed.length, 1);
  let s = store.getSession("r1")!;
  assert.equal(s.title, "旧身体改的标题");
  assert.ok(s.pinned > 0, "旧身体的行不带置顶：本机的置顶不动");
  assert.equal(s.project, p.id);
  // 较旧的取消置顶不采用，较新的采用；项目同理
  store.applyRemote("sessions", [{ ...cur, pinned: 0, pin_changed: cur.pin_changed - 1 }], from);
  assert.ok(store.getSession("r1")!.pinned > 0);
  store.applyRemote("sessions", [{ ...cur, pinned: 0, pin_changed: cur.pin_changed + 5, project: null, project_changed: cur.project_changed + 5 }], from);
  s = store.getSession("r1")!;
  assert.deepEqual([s.pinned, s.project], [0, null]);
  // 未来的修改时刻被钳到「现在 + 5 分钟」以内
  store.applyRemote("sessions", [{ ...cur, pinned: Date.now() + 365 * 86400_000, pin_changed: Date.now() + 365 * 86400_000 }], from);
  assert.ok(store.getSession("r1")!.pinned <= Date.now() + 5 * 60_000 + 1000);
  // 坏字段：项目编号格式不对、修改时刻不是数字 → 整行丢弃
  const bad = store.applyRemote("sessions", [
    { ...cur, id: "r2", project: "../../etc", project_changed: Date.now() },
    { ...cur, id: "r3", pinned: "yes", pin_changed: Date.now() },
    { ...cur, id: "r4", pin_changed: "soon" },
  ], from);
  assert.equal(bad.rejected, 3);
  assert.equal(store.getSession("r2"), undefined);
  // 新的会话：连同置顶与项目一起收下
  store.applyRemote("sessions", [{ id: "r5", title: "别处的新会话", channel: "飞书", created: Date.now(), updated: Date.now(), archived: 0, changed: 0, pinned: Date.now(), pin_changed: Date.now(), project: p.id, project_changed: Date.now() }], from);
  s = store.getSession("r5")!;
  assert.ok(s.pinned > 0);
  assert.equal(s.project, p.id);
});

test("搜索：标题命中在前，内容命中带片段与高亮位置，跳转用的消息编号；归档的也搜；她判断不是对她说的不算", () => {
  store.ensureSession("k1", "关于樱花的计划");
  store.ensureSession("k2", "随便聊聊");
  store.addMessage("user", "控制台", "很久很久以前的一段很长很长的开头，".repeat(4) + "我们周末去看樱花吧，顺便带上相机", { session: "k2" });
  const target = store.addMessage("agent", "控制台", "好呀，樱花季人多，早点出发", { session: "k2" });
  store.ensureSession("k3", "归档的");
  store.addMessage("user", "控制台", "去年的樱花照片", { session: "k3" });
  store.updateSession("k3", { archived: true });
  const ign = store.addMessage("ambient", "语音", "樱花樱花樱花", { session: "k4" });
  store.setMessageMode(ign, "ignored");
  const hits = searchSessions("樱花");
  assert.equal(hits[0].session.id, "k1", "标题命中的在前");
  assert.equal(hits[0].title, true);
  assert.deepEqual(hits[0].titleMarks, [[2, 4]]);
  const k2 = hits.find((h) => h.session.id === "k2")!;
  assert.ok(k2.hit && k2.matches === 2);
  assert.ok([target, k2.hit.message].includes(k2.hit.message));
  const [a, b] = k2.hit.marks[0];
  assert.equal(k2.hit.snippet.slice(a, b), "樱花");
  assert.ok(hits.some((h) => h.session.id === "k3" && h.session.archived), "归档的也搜到");
  assert.ok(!hits.some((h) => h.session.id === "k4"), "ignored 的环境声音不算");
  assert.deepEqual(searchSessions("  "), []);
  // 片段：长消息截出命中附近，前后加省略号
  const sn = snippetOf("前".repeat(200) + "目标词" + "后".repeat(200), markTerms("目标词"));
  assert.ok(sn.snippet.startsWith("…") && sn.snippet.endsWith("…"));
  assert.equal(sn.snippet.slice(sn.marks[0][0], sn.marks[0][1]), "目标词");
  // 定位：从命中的那条起到最新
  const from = store.sessionMessagesFrom("k2", target);
  assert.equal(from.at(-1)!.id, target);
  assert.equal(from.length, 2, "前面带上几条");
});

test("控制台接口：筛选参数、置顶、移到项目、新建时指定项目、项目增删改、搜索；都写审计", async () => {
  const p = ops["projects.create"]({ name: "工作", instructions: "用正式的语气" }, "控制台");
  const s = ops["sessions.create"]({ title: "周报", project: p.id }, "控制台");
  assert.equal(s.project, p.id);
  assert.throws(() => ops["sessions.create"]({ project: "ffffffffffffffff" }, "控制台"), /没有这个项目/);
  assert.equal(ops["sessions.pin"]({ id: s.id }, "控制台").pinned > 0, true);
  assert.equal(ops.sessions({ pinned: true }).some((x: any) => x.id === s.id), true);
  assert.deepEqual(ops.sessions({ project: p.id }).map((x: any) => x.id), [s.id]);
  assert.equal("pin_changed" in ops.sessions({})[0], false, "内部的修改时刻不给控制台");
  assert.equal(ops["sessions.move"]({ id: s.id, project: null }, "控制台").project, null);
  assert.ok(ops.sessions({ project: "none" }).some((x: any) => x.id === s.id));
  ops["sessions.move"]({ id: s.id, project: p.id }, "控制台");
  assert.throws(() => ops["sessions.pin"]({ id: "没有" }, "控制台"), /没有这个会话/);
  assert.equal(ops["projects.update"]({ id: p.id, name: "工作 2", created: 1 } as any, "控制台").created > 1, true, "不认得的字段不收");
  assert.deepEqual(ops.projects({}).map((x: any) => x.name).includes("工作 2"), true);
  assert.deepEqual(ops["projects.delete"]({ id: p.id }, "控制台"), { sessions: 1 });
  assert.equal(ops.sessions({}).find((x: any) => x.id === s.id)!.project, null);
  // 搜索与定位
  store.addMessage("user", "控制台", "这周的进度写在周报里", { session: s.id });
  const r = ops["sessions.search"]({ query: "周报" });
  assert.equal(r[0].session.id, s.id);
  const msgs = ops["sessions.messages"]({ id: s.id, from: r.find((h: any) => h.hit)!.hit!.message });
  assert.ok(msgs.length >= 1);
  // 进行中的一轮
  assert.deepEqual(ops.sessions({ live: true }), []);
  for (const a of ["sessions.pin", "sessions.move", "projects.create", "projects.update", "projects.delete"]) assert.ok(store.listAudit(200).some((x) => x.action === a), `审计里有 ${a}`);
});

test("project 工具：新建、列出、归类当前会话、查看、移出；系统提示里出现项目说明；新会话沿用当前会话的项目", async () => {
  store.ensureSession("t1", "她的会话");
  const s = new Session("chat", "控制台", undefined, "t1");
  assert.match((await callTool("project", { action: "create", name: "学钢琴", instructions: "每次练习后记下用了多久" }, "测试", { session: s })).text, /已新建项目「学钢琴」/);
  assert.match((await callTool("project", { action: "list" }, "测试", { session: s })).text, /学钢琴/);
  assert.match((await callTool("project", { action: "assign", project: "学钢琴" }, "测试", { session: s })).text, /已归到项目「学钢琴」/);
  const p = projects.find("学钢琴")!;
  assert.equal(store.getSession("t1")!.project, p.id);
  assert.match((await callTool("project", { action: "show" }, "测试", { session: s })).text, /每次练习后记下用了多久[\s\S]*她的会话/);
  assert.match(systemPrompt("", { conv: "t1", dynamic: true }), /## 项目「学钢琴」[\s\S]*每次练习后记下用了多久/);
  assert.doesNotMatch(systemPrompt("", { conv: "a", dynamic: true }), /## 项目「/);
  assert.match((await callTool("project", { action: "assign", project: "没有的" }, "测试", { session: s })).text, /没有项目/);
  // 新会话：不写 project 就跟着当前会话的项目
  const r = await callTool("session_new", { title: "第二课" }, "测试", { session: s });
  assert.match(r.text, /已切到新会话/);
  assert.equal(store.getSession(s.switchTo!)!.project, p.id);
  assert.match((await callTool("project", { action: "assign", project: "none" }, "测试", { session: s })).text, /已移出项目/);
  assert.equal(store.getSession("t1")!.project, null);
});
