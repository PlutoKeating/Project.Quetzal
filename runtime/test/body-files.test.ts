// 身体参数（mind/body-files.ts）：读文件的工具带上 body（另一具身体的 uuid）时，经网状层的 file.read 把那边的文件取到本机。
// 这里在一个进程里把「那边」（lendFile）和「这边」（fetchFile）直接接起来，检查各项拒绝、分段传输、核对与落盘；两具身体真连起来的见 limbs.test.ts。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-bodyfiles-"));
const { loadConfig, paths, config } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const uuid = await import("../src/body/uuid.ts");
const bf = await import("../src/mind/body-files.ts");
const { setBodies } = await import("../src/mind/bodies.ts");
const { callTool, notePaths, substitutePaths, allTools } = await import("../src/mind/tools.ts");

const params = (n: string) => (allTools().find((t) => t.name === n)!.parameters as { properties: Record<string, unknown> }).properties;
const PC = uuid.deviceUuid("pc-machine-id-0001"), OTHER = uuid.deviceUuid("other-machine-id");
const SELF = (await uuid.ensureBodyUuid(async () => "self-machine-id-0001")).uuid;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bodyfiles-src-"));
const stop = () => fs.writeFileSync(paths.stop, "");
const resume = () => fs.rmSync(paths.stop, { force: true });
after(() => { setBodies(undefined); resume(); });

/** 「pc」这具身体就是本进程：file 直接交给 lendFile（tamper 可以改那边交回的东西）。registry 是灵魂仓库的身体登记，claimed 是 pc 自报的 uuid。 */
function loopback(tamper?: (r: any) => any, fileHook?: (p: any) => Promise<unknown>, o: { registry?: { body: string; uuid: string }[]; claimed?: string } = {}) {
  setBodies({
    list: () => [{ body: "pc", uuid: PC, claimed: "claimed" in o ? o.claimed : PC, describe: "", tools: [] }], call: async () => ({ text: "", status: "ok" }), move: async () => "",
    file: fileHook ?? (async (_b, p) => { const r = await bf.lendFile(JSON.parse(JSON.stringify(p)), "phone"); return tamper ? tamper(r) : r; }),
    registry: () => o.registry ?? [{ body: "pc", uuid: PC }, { body: config.body, uuid: SELF }],
  });
}

test("身体的 uuid：由设备标识派生，稳定、RFC 9562 version 8 格式、不含原始标识；存过的为准；取不到标识时随机生成", async () => {
  const raw = "0123456789abcdef0123456789abcdef";
  assert.equal(uuid.deviceUuid(raw), uuid.deviceUuid(raw));
  assert.match(uuid.deviceUuid(raw), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(uuid.deviceUuid(raw), uuid.BODY_UUID);
  assert.ok(!uuid.deviceUuid(raw).replace(/-/g, "").includes(raw.slice(0, 12)), "不含原始标识");
  assert.notEqual(uuid.deviceUuid(raw), uuid.deviceUuid(raw.replace("0", "1")));
  const h = crypto.createHash("sha256").update("quetzal-body-uuid/1\n" + raw).digest("hex");
  assert.equal(uuid.deviceUuid(raw).slice(0, 8), h.slice(0, 8), "sha256(命名空间 + 标识) 的前几个字节");

  // 启动时已经定下的：存在 state/body-uuid，不含原始标识
  const file = path.join(paths.state, "body-uuid");
  assert.equal(fs.readFileSync(file, "utf8").trim(), uuid.deviceUuid("self-machine-id-0001"));
  // 存过的为准：设备标识变了（或者能取到了）也不换
  uuid.resetBodyUuid();
  assert.deepEqual(await uuid.ensureBodyUuid(async () => "another-device-id-xyz"), { uuid: SELF, source: "stored" });
  // 家目录没了（重装）：从同一个设备标识重新算出同一个值
  fs.rmSync(file); uuid.resetBodyUuid();
  assert.deepEqual(await uuid.ensureBodyUuid(async () => "self-machine-id-0001"), { uuid: SELF, source: "device" });
  // 取不到标识（没有、抛错、全 0、太短）：随机 v4，存起来之后不变
  for (const get of [undefined, async () => undefined, async () => { throw new Error("x"); }, async () => "00000000000000000000", async () => "abc"]) {
    fs.rmSync(file); uuid.resetBodyUuid();
    const r = await uuid.ensureBodyUuid(get as any);
    assert.equal(r.source, "random"); assert.match(r.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    uuid.resetBodyUuid(); assert.equal(uuid.bodyUuid(), r.uuid);
  }
  fs.writeFileSync(file, SELF + "\n"); uuid.resetBodyUuid();
  assert.equal(uuid.bodyUuid(), SELF);
});

test("body 参数的解析：空或自己 → 本机；登记过、在线、自报一致的 uuid → 那具身体；名字、乱写、没登记、多具身体共用、自报不一致、没升级 → 说明", () => {
  loopback();
  try {
    assert.deepEqual(bf.resolveBody(undefined), { local: true });
    assert.deepEqual(bf.resolveBody(SELF), { local: true });
    assert.equal((bf.resolveBody(PC.toUpperCase()) as any).remote.body, "pc");
    assert.match((bf.resolveBody("pc") as any).error, new RegExp(`不是名字：pc 的 uuid 是 ${PC}`));
    assert.match((bf.resolveBody("xyz") as any).error, /要填身体的 uuid/);
    assert.match((bf.resolveBody(OTHER) as any).error, /没有登记这个 uuid/);
    loopback(undefined, undefined, { registry: [{ body: "pc", uuid: PC }, { body: "pc-termux", uuid: PC }] });
    assert.match((bf.resolveBody(PC) as any).error, /这个 uuid 对应多具身体（pc、pc-termux）/);
    loopback(undefined, undefined, { claimed: OTHER });
    assert.match((bf.resolveBody(PC) as any).error, /pc 自报的 uuid 与灵魂仓库的登记不一致/);
    assert.ok(store.listAudit(5, { action: "body" }).some((a) => a.result.includes("自报的 uuid 与登记不一致")), "记一笔");
    loopback(undefined, undefined, { claimed: undefined });
    assert.match((bf.resolveBody(PC) as any).error, /pc 需要升级/);
    loopback(undefined, undefined, { registry: [{ body: "tablet", uuid: PC }] });
    assert.match((bf.resolveBody(PC) as any).error, /tablet 不在线/);
  } finally { setBodies(undefined); }
});

test("文件名清洗：只取最后一段、只留安全字符、不以点或减号开头、避开 Windows 保留名", () => {
  assert.equal(bf.safeFileName("/etc/../../passwd"), "passwd");
  assert.equal(bf.safeFileName("C:\\Users\\x\\con.txt"), "_con.txt");
  assert.equal(bf.safeFileName(".."), "file");
  assert.equal(bf.safeFileName("/x/.bashrc"), "bashrc");
  assert.equal(bf.safeFileName("/x/-rf"), "rf");
  assert.equal(bf.safeFileName("/x/a b;rm $(id).txt"), "a_b_rm_id_.txt");
  assert.equal(bf.safeFileName("/x/照片 1.jpg"), "照片_1.jpg");
  assert.ok(bf.safeFileName(`/x/${"a".repeat(300)}.pdf`).endsWith(".pdf"));
  assert.ok(bf.safeFileName(`/x/${"a".repeat(300)}.pdf`).length <= 120);
});

test("那边交出文件（lendFile）：密钥目录、保密库、指进密钥目录的符号链接、目录、超限、不存在、急停一律拒绝，每次都记审计", async () => {
  fs.mkdirSync(paths.secrets, { recursive: true }); fs.writeFileSync(path.join(paths.secrets, "gateway.token"), "t");
  fs.mkdirSync(paths.vault, { recursive: true }); fs.writeFileSync(path.join(paths.vault, "k"), "v");
  await assert.rejects(bf.lendFile({ path: path.join(paths.secrets, "gateway.token") }, "pc"), /密钥目录/);
  await assert.rejects(bf.lendFile({ path: path.join(paths.vault, "k") }, "pc"), /保密库/);
  if (process.platform !== "win32") {
    const link = path.join(dir, "innocent.txt"); fs.symlinkSync(path.join(paths.secrets, "gateway.token"), link);
    await assert.rejects(bf.lendFile({ path: link }, "pc"), /密钥目录/);
  }
  await assert.rejects(bf.lendFile({ path: dir }, "pc"), /不是普通文件/);
  const big = path.join(dir, "big.bin"); fs.writeFileSync(big, ""); fs.truncateSync(big, bf.FILE_MAX_BYTES + 1);
  await assert.rejects(bf.lendFile({ path: big }, "pc"), /文件太大（64\.0 MB，跨身体最多 64 MB）/);
  await assert.rejects(bf.lendFile({ path: path.join(dir, "nope") }, "pc"), /没有这个文件/);
  const ok = path.join(dir, "ok.txt"); fs.writeFileSync(ok, "hi");
  stop();
  try { await assert.rejects(bf.lendFile({ path: ok }, "pc"), /闸门没有允许（或急停中）/); } finally { resume(); }
  await assert.rejects(bf.lendFile({ path: 42 }, "pc"), /路径不对/);
  await assert.rejects(bf.lendFile({ ticket: "nope", offset: 0 }, "pc"), /已经结束或过期/);
  const r = await bf.lendFile({ path: ok, reason: "看看" }, "pc") as any;
  assert.equal(Buffer.from(r.data, "base64").toString(), "hi"); assert.equal(r.size, 2); assert.equal(r.ticket, undefined);
  assert.equal(r.sha256, crypto.createHash("sha256").update("hi").digest("hex"));
  const rows = store.listAudit(50, { action: "file.read" }).filter((a) => a.reason.startsWith("来自 pc"));
  const denied = rows.filter((a) => a.result.startsWith("denied")).length;
  assert.equal(denied, process.platform === "win32" ? 6 : 7);
  assert.equal(rows.filter((a) => a.result.startsWith("✓")).length, 1);
  assert.ok(rows.every((a) => !a.args.includes("hi\"") && !a.result.includes("gateway.token\"")), "审计只记路径、大小与结果，不记内容");
});

test("这边取回（fetchFile）：分段传输后字节一致、同一个文件再取复用、同名不同内容另起名字；被改过的数据不落盘；老版本的身体提示升级", async (t) => {
  t.after(() => setBodies(undefined));
  loopback();
  const bin = crypto.randomBytes(bf.PIECE_BYTES * 2 + 12345), src = path.join(dir, "blob.bin");
  fs.writeFileSync(src, bin);
  const b = { body: "pc", uuid: PC, describe: "", tools: [] };
  const r = await bf.fetchFile(b, src, "测试");
  assert.equal(path.dirname(r.local), bf.fetchedDir("pc"));
  assert.ok(fs.readFileSync(r.local).equals(bin), "取回的二进制字节一致");
  const again = await bf.fetchFile(b, src, "测试");
  assert.equal(again.local, r.local); assert.ok(again.reused);
  fs.writeFileSync(src, crypto.randomBytes(100));
  const other = await bf.fetchFile(b, src, "测试");
  assert.equal(path.basename(other.local), "blob-2.bin"); assert.ok(fs.readFileSync(r.local).equals(bin), "原来的没有被覆盖");

  // 那边交回的数据被改过：sha256 / 长度对不上，不留下文件（换个名字：同名同内容的会直接复用、不传）
  const src2 = path.join(dir, "fresh.bin"); fs.writeFileSync(src2, bin);
  loopback((x) => (x.data && x.size === undefined ? { data: Buffer.from(Buffer.from(x.data, "base64").map((c) => c ^ 1)).toString("base64") } : x));
  const before = fs.readdirSync(bf.fetchedDir("pc")).length;
  await assert.rejects(bf.fetchFile(b, src2, "测试"), /sha256 不一致/);
  loopback((x) => (x.size !== undefined ? { ...x, data: x.data.slice(0, 8) } : x));
  await assert.rejects(bf.fetchFile(b, src2, "测试"), /长度不对/);
  loopback((x) => ({ ...x, sha256: "x" }));
  await assert.rejects(bf.fetchFile(b, src2, "测试"), /格式不对/);
  assert.equal(fs.readdirSync(bf.fetchedDir("pc")).length, before, "没对上的不落盘");

  // 1.6.0 的身体没有 file.read
  loopback(undefined, async () => { throw new Error("没有这个方法：file.read"); });
  await assert.rejects(bf.fetchFile(b, src, "测试"), /pc 需要升级/);
  const mine = store.listAudit(50, { action: "file.read" }).filter((a) => a.reason === "测试");
  assert.ok(mine.some((a) => a.result.startsWith("✓")) && mine.some((a) => a.result.startsWith("error")), "这边也记审计");
  setBodies(undefined);
});

test("接到工具上：多具身体时读文件的工具多一个 body 参数；read_document 带 body 读那边的文件；急停时不取；shell 的路径替换", async () => {
  assert.ok(!params("read_document").body && !params("shell").files, "只有一具身体时没有 body 参数");
  loopback();
  try {
    for (const n of ["view_image", "read_document", "shell"]) assert.ok(params(n).body, n);
    assert.ok(params("shell").files, "shell 的 files 也只在多具身体时出现");
    const doc = path.join(dir, "note.md"); fs.writeFileSync(doc, "电脑上的笔记");
    const r = await callTool("read_document", { path: doc, body: PC }, "测试");
    assert.equal(r.status, "ok", r.text);
    assert.match(r.text, /^从 pc 取来的文件：\n✓ pc:.*note\.md → .*from-bodies/);
    assert.match(r.text, /电脑上的笔记/);
    assert.match((await callTool("read_document", { path: doc, body: "pc" }, "测试")).text, /不是名字/);
    assert.match((await callTool("shell", { command: "ls", body: PC }, "测试")).text, /要在 files 里列出.*body_call/);
    stop();
    try { assert.equal((await callTool("read_document", { path: doc, body: PC }, "测试")).status, "denied"); } finally { resume(); }

    assert.equal(substitutePaths("wc -c /a/b.txt /a/b.txt.bak '/a/b.txt' x/a/b.txt", [{ remote: "/a/b.txt", local: "/L/b.txt" }]), "wc -c /L/b.txt /a/b.txt.bak '/L/b.txt' x/a/b.txt");
    assert.equal(substitutePaths("cat b /a/b", [{ remote: "b", local: "/L/b" }, { remote: "/a/b", local: "/L/b-2" }]), "cat /L/b /L/b-2");

    const said = "已拍摄：/sdcard/DCIM/a.jpg（1 KB）";
    assert.match(notePaths(said), new RegExp(`（以上文件在 ${config.body} 这具身体上（body: ${SELF}），别的身体上没有这个路径；在别的身体上用 view_image、read_document、shell 读它时带上 body: "${SELF}"）$`));
    assert.equal(notePaths("电量 80%"), "电量 80%");
  } finally { setBodies(undefined); }
  assert.equal(notePaths("已拍摄：/sdcard/a.jpg"), "已拍摄：/sdcard/a.jpg", "只有一具身体时不加");
});

test("网状层：file.read 只读成员（灵魂桥）不能调用；body 的 uuid 以灵魂仓库的登记为准、对方自报的另行核对；别处调来的工具去掉 body", async () => {
  const { installLimbs, soulRegistry } = await import("../src/mesh/limbs.ts");
  // 灵魂仓库的身体登记（规范 v14）：只认运行基座、文件名与 body 一致、格式合法的 uuid
  const reg = path.join(paths.soul, "bodies"); fs.mkdirSync(reg, { recursive: true });
  const put = (f: string, j: unknown) => fs.writeFileSync(path.join(reg, f), JSON.stringify(j));
  put("pc.json", { body: "pc", kind: "runtime", uuid: PC.toUpperCase() });
  put("old.json", { body: "old", kind: "runtime" });
  put("liar.json", { body: "pc", kind: "runtime", uuid: OTHER });
  put("bad.json", { body: "bad", kind: "runtime", uuid: "not-a-uuid" });
  put("hermes.json", { body: "hermes", kind: "bridge", uuid: OTHER });
  assert.deepEqual(soulRegistry(), [{ body: "pc", uuid: PC }]);
  const { remoteBodies } = await import("../src/mind/bodies.ts");
  const handlers = new Map<string, { fn: Function; readable: boolean }>();
  const PCU = uuid.deviceUuid("pc-real-device");
  const fake: any = {
    handle: (m: string, fn: Function, readable = false) => handlers.set(m, { fn, readable }),
    on: (ev: string, fn: Function) => { if (ev === "peer") fn({ body: "pc", link: "open" }); }, off() {}, connected: () => ["pc"],
    request: async (_b: string, m: string) => { if (m === "tool.list") return { body: "pc", uuid: PCU.toUpperCase(), describe: "", tools: [] }; throw new Error(`没有这个方法：${m}`); },
  };
  const off = installLimbs(fake, () => [{ body: "pc", uuid: PCU }]);
  try {
    assert.equal(handlers.get("file.read")?.readable, false, "灵魂桥调用不到");
    assert.ok(!handlers.has("image.read"), "旧的看图专用方法已经去掉");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(remoteBodies()[0].uuid, PCU, "uuid 以登记为准");
    assert.equal(remoteBodies()[0].claimed, PCU, "自报的另放");
    assert.equal((bf.resolveBody(PCU) as any).remote.body, "pc");
    await assert.rejects(bf.fetchFile(remoteBodies()[0], "/x", "测试"), /pc 需要升级/);
    const doc = path.join(dir, "here.md"); fs.writeFileSync(doc, "本机的笔记");
    const r = await handlers.get("tool.call")!.fn({ tool: "read_document", args: { path: doc, body: PCU }, reason: "x" }, "pc");
    assert.match(r.text, /本机的笔记/); assert.doesNotMatch(r.text, /取来/, "别处调来的工具不带 body 转到第三具身体");
  } finally { off(); }
});
