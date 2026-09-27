import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncMappings, fit } from "../src/engine.ts";
import { hermes } from "../src/frameworks/hermes.ts";
import { openclaw, readMarkdownEntries, renderMarkdownEntries } from "../src/frameworks/openclaw.ts";
import { parseEntries, joinEntries } from "../../runtime/src/memory/entries.ts";
import { parseGithub, sshUrl } from "../src/github.ts";

test("GitHub 仓库地址解析", () => {
  for (const s of ["alice/kaoru.soul", "git@github.com:alice/kaoru.soul.git", "https://github.com/alice/kaoru.soul", "https://github.com/alice/kaoru.soul.git"])
    assert.equal(sshUrl(parseGithub(s)!), "git@github.com:alice/kaoru.soul.git", s);
  assert.equal(parseGithub("/tmp/x/agent.soul.git"), undefined);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
const w = (f: string, s: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const r = (f: string) => fs.readFileSync(f, "utf8");

test("Hermes：首次接入取并集，之后双向传播新增与删除", () => {
  const home = tmp(), soul = tmp(), st = {};
  w(`${home}/memories/MEMORY.md`, joinEntries(["A", "B"]));
  w(`${soul}/memories/MEMORY.md`, joinEntries(["B", "C"]));
  const m = hermes.mappings(home, "h");
  syncMappings(m, soul, st);
  assert.deepEqual(parseEntries(r(`${soul}/memories/MEMORY.md`)), ["B", "C", "A"]);
  assert.deepEqual(parseEntries(r(`${home}/memories/MEMORY.md`)), ["B", "C", "A"]);
  w(`${home}/memories/MEMORY.md`, joinEntries(["C", "A", "D"])); // Hermes 删 B、加 D
  w(`${soul}/memories/MEMORY.md`, joinEntries(["B", "C", "A", "E"])); // 其他身体加 E
  syncMappings(m, soul, st);
  assert.deepEqual(parseEntries(r(`${soul}/memories/MEMORY.md`)), ["C", "A", "E", "D"]);
  assert.deepEqual(parseEntries(r(`${home}/memories/MEMORY.md`)), ["C", "A", "E", "D"]);
});

test("Hermes：超出字符上限的条目暂不写回，但不会被当作删除", () => {
  const home = tmp(), soul = tmp(), st = {};
  w(`${home}/config.yaml`, "memory:\n  memory_char_limit: 20\n");
  w(`${soul}/memories/MEMORY.md`, joinEntries(["一二三四五六七八九十", "甲乙丙丁戊己庚辛壬癸", "子丑寅卯"]));
  const m = hermes.mappings(home, "h");
  syncMappings(m, soul, st);
  assert.ok(r(`${home}/memories/MEMORY.md`).length <= 20);
  syncMappings(m, soul, st);
  assert.equal(parseEntries(r(`${soul}/memories/MEMORY.md`)).length, 3);
  assert.deepEqual(fit(["aaaa", "bbbb"], 6), ["aaaa"]);
});

test("文本冲突全自动：采用较新的一方，落选版本交给调用方存入历史", () => {
  const home = tmp(), soul = tmp(), st = {};
  w(`${home}/SOUL.md`, "# 我\n原始"); w(`${soul}/SOUL.md`, "# 我\n原始");
  const m = hermes.mappings(home, "h");
  syncMappings(m, soul, st);
  w(`${soul}/SOUL.md`, "# 我\n手机上改的");
  const t = Date.now() / 1000;
  fs.utimesSync(`${soul}/SOUL.md`, t - 10, t - 10);
  w(`${home}/SOUL.md`, "# 我\nHermes 里改的（更新）");
  const rep = syncMappings(m, soul, st);
  assert.equal(r(`${soul}/SOUL.md`), "# 我\nHermes 里改的（更新）");
  assert.equal(rep.conflicts[0].loser, "# 我\n手机上改的");
});

test("OpenClaw：自由 Markdown 与条目互转，agent 新写的段落被吸收", () => {
  const text = "# MEMORY\n\n## 喜好\n- 喜欢雨天\n- 在读《沙丘》\n  第二部\n\n用户每天早上跑步。\n";
  assert.deepEqual(readMarkdownEntries(text), ["喜欢雨天", "在读《沙丘》\n第二部", "用户每天早上跑步。"]);
  const out = renderMarkdownEntries("MEMORY")(["a", "b\nc"]);
  assert.deepEqual(readMarkdownEntries(out), ["a", "b\nc"]);
});

test("OpenClaw：日记导出、其他身体日记镜像、共享笔记双向与删除", () => {
  const home = tmp(), soul = tmp(), st = {};
  w(`${home}/memory/2026-09-28.md`, "今天");
  w(`${soul}/journal/honor9/2026-09-28.md`, "手机上的一天");
  w(`${soul}/notes/天文.md`, "猎户座");
  const m = openclaw.mappings(home, "claw");
  syncMappings(m, soul, st);
  assert.equal(r(`${soul}/journal/claw/2026-09-28.md`), "今天");
  assert.equal(r(`${home}/memory/bodies/honor9/2026-09-28.md`), "手机上的一天");
  assert.equal(r(`${home}/memory/notes/天文.md`), "猎户座");
  fs.rmSync(`${home}/memory/notes/天文.md`);
  syncMappings(m, soul, st);
  assert.ok(!fs.existsSync(`${soul}/notes/天文.md`));
});
