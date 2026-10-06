// 规范 v13 §3.13：哪里都放得下的路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentProblem, safeSegment, windowsUnfit, reservedName } from "../src/memory/portable-path.ts";

test("Windows 放不下的名字", () => {
  for (const s of ["CON", "con.md", "Nul.txt", "com1", "LPT9.log", "COM¹", "a.", "b ", "x:y", "a?b", "git~1", ".git.", ".git  "]) assert.ok(segmentProblem(s), s);
  for (const s of ["console.md", "connect", "notes", "身体", ".gitkeep", "a.b.md", "nul-ish"]) assert.equal(segmentProblem(s), undefined, s);
});

test("写入时改成放得下的写法", () => {
  assert.equal(safeSegment("con"), "con_");
  assert.equal(safeSegment("CON.md"), "CON_.md");
  assert.equal(safeSegment("笔记..."), "笔记");
  assert.equal(safeSegment("正常"), "正常");
  assert.equal(reservedName("aux"), true);
  assert.equal(reservedName("auxiliary"), false);
});

test("一组路径里放不下的：坏名字与只差大小写", () => {
  const bad = windowsUnfit(["notes/a.md", "Notes/b.md", "notes/con.md", "journal/pc/2026-10-07.md", "skills/x/SKILL.md", "skills/X/SKILL.md"]);
  const paths = bad.map((b) => b.path).sort();
  assert.deepEqual(paths, ["notes/a.md", "notes/con.md", "skills/x/SKILL.md"].sort());
  assert.match(bad.find((b) => b.path === "notes/con.md")!.why, /保留名/);
});
