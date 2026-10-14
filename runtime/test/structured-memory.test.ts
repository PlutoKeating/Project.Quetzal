import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryDraft, MemoryEvidence } from "../src/memory/structured.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-structured-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const { ensureSoul } = await import("../src/memory/soul-sync.ts");
await ensureSoul();
const mem = await import("../src/memory/memory.ts");
const host = await import("../src/memory/structured.ts");
const { createMemoryCandidate } = await import("../../engine/src/memory.ts");
const scope = { agentId: "synthetic-agent", userId: "one" };
const evidence = (id: string, text = "原文事实"): MemoryEvidence => ({ id, ref: `message:${id}`, origin: "user", observedAt: 1, summary: text, verified: true });
const draft = (id: string, text = "原文事实"): MemoryDraft => ({ id, kind: "fact", text, scope, conditions: { requiredTags: [], excludedTags: [], tools: [] }, stage: "any", zone: "golden", evidenceIds: [id] });
after(async () => { (await import("../src/store.ts")).db.close(); fs.rmSync(home, { recursive: true, force: true }); });

test("候选不能进入默认检索，独立验证后读取真实 Markdown 和引擎 record", async () => {
  const candidate = await host.recordMemory(draft("first"), [evidence("first")]);
  assert.equal(host.getMemoryCandidates("原文事实", scope, "any", { includeLegacy: false }).length, 0);
  const file = path.join(paths.soul, "notes", "QuetzalMemory", "first_v1.md");
  assert.match(fs.readFileSync(file, "utf8"), /^# fact.*\n\n> candidate/);
  const rejected = await host.reviewMemory("first@1", { accepted: true, independent: false, evaluator: "self-report", score: 1, evidence: [] });
  assert.equal(rejected.state, "candidate");
  const active = await host.reviewMemory("first@1", { accepted: true, independent: true, evaluator: "source-check", score: 1, evidence: [evidence("first")] });
  assert.equal(active.state, "active");
  assert.equal(host.getMemoryCandidates("原文事实", scope, "any", { includeLegacy: false })[0].id, candidate.id);
  assert.equal(host.getMemoryCandidates("原文事实", { ...scope, userId: "two" }, "any", { includeLegacy: false }).length, 0);
});

test("新事实先候选、验证后 supersede 保留旧版本，归档与恢复不删除历史", async () => {
  await host.recordMemory(draft("first", "新事实"), [evidence("first", "新事实")], { version: 2, parents: ["first@1"] });
  assert.equal(host.readStructuredRecords().find((r) => r.version === 1)!.state, "active");
  await host.reviewMemory("first@2", { accepted: true, independent: true, evaluator: "new-source", score: 1, evidence: [evidence("first", "新事实")] });
  assert.equal(host.readStructuredRecords().find((r) => r.version === 1)!.state, "superseded");
  await host.archiveRecord("first@2");
  assert.equal(host.getMemoryCandidates("新事实", scope, "any", { includeLegacy: false }).length, 0);
  await host.rollbackRecord("first@1");
  assert.ok(host.readStructuredRecords().some((r) => r.version === 3 && r.state === "active"));
  assert.ok(fs.existsSync(path.join(paths.soul, "notes", "QuetzalMemory", "first_v1.md")));
});

test("legacy只读映射未核实材料，损坏结构化文件不以legacy旁路注入", async () => {
  mem.editMemory("user", "add", "旧USER原文不改");
  mem.saveNote("旧材料", "旧笔记原文");
  const original = mem.readNote("旧材料");
  mem.saveNote("QuetzalMemory/broken", "候选内容不得旁路");
  const records = host.readLegacyRecords(scope);
  assert.ok(records.some((r) => r.text.includes("旧USER原文不改") && r.kind === "episode" && r.zone === "warning"));
  assert.ok(!records.some((r) => r.text.includes("候选内容不得旁路")));
  assert.equal(mem.readNote("旧材料"), original);
  assert.ok(host.getMemoryCandidates("旧笔记原文", scope, "any")[0].text.startsWith("【旧记忆未核实，仅参考】"));
});

test("私有灵魂包含已知secret仍原样保存读取；持久层不作隐私检查", async () => {
  const secret = "synthetic-private-memory-value";
  fs.writeFileSync(path.join(paths.secrets, "synthetic_secret"), secret);
  await host.recordMemory(draft("private", secret), [evidence("private", secret)]);
  assert.equal(host.readStructuredRecords().find((r) => r.id === "private")!.text, secret);
  assert.ok(fs.readFileSync(path.join(paths.soul, "notes", "QuetzalMemory", "private_v1.md"), "utf8").includes(secret));
});

test("无证据active拒绝、路径不可穿越、并发写入不丢记录", async () => {
  const invalid = createMemoryCandidate(draft("unverified"), [evidence("unverified")], Date.now());
  await assert.rejects(host.updateStructuredRecords((records) => [...records, { ...invalid, state: "active" }]));
  await assert.rejects(host.recordMemory(draft("../escape"), [evidence("../escape")]));
  await Promise.all([host.recordMemory(draft("parallel_a", "并发甲"), [evidence("parallel_a")]), host.recordMemory(draft("parallel_b", "并发乙"), [evidence("parallel_b")])]);
  const ids = host.readStructuredRecords().map((r) => r.id);
  assert.ok(ids.includes("parallel_a") && ids.includes("parallel_b"));
});

test("旧日记进入动态候选且只作为未核实材料保留", () => {
  mem.writeJournal("合成日记兼容观察", "纸鸢任务当天只做了观察，没有确认世界事实。");
  const record = host.readLegacyRecords(scope).find((r) => r.text.includes("纸鸢任务当天"));
  assert.ok(record);
  assert.equal(record.kind, "episode");
  assert.equal(record.zone, "warning");
  assert.equal(record.validation.evaluator, "legacy-material-exists");
  assert.match(record.text, /旧记忆未核实/);
});
