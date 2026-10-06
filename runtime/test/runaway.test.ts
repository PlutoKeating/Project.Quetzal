// 重复输出检测：判据只拦复读，不误伤正常的文字、代码、表格与相似的文件路径；对话中流式输出陷入复读时截停并提醒她换个思路。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-runaway-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const { converse } = await import("../src/mind/brain.ts");
const { isRunaway } = await import("../src/mind/runaway.ts");

test("判据：复读会被识别，正常输出不会", () => {
  // 2026-10-06 的真实形态：模型自己编的过程记录，路径一层层变长
  let p = "~/Project.X/raw/recordings/2026-09-28/2026-09-28-14-30-00", deg = "";
  for (let k = 0; k < 14; k++) { deg += `shell(du -sh ${p}// 2>/dev/null | sort -rh) ✓ → exit 0；`; p += "/2026-09-28-14-30-00" + "-001".repeat(k + 1); }
  assert.ok(isRunaway(deg));
  assert.ok(isRunaway("好的，".repeat(1000)));
  assert.ok(!isRunaway(fs.readFileSync(new URL("../src/mind/brain.ts", import.meta.url), "utf8").slice(0, 6000)), "代码");
  assert.ok(!isRunaway(fs.readFileSync(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8").slice(0, 6000)), "文字");
  let table = "| 文件 | 大小 | 说明 |\n|---|---|---|\n"; for (let i = 0; i < 80; i++) table += `| video-${i}.mp4 | ${(i * 37) % 900} MB | 第 ${i} 段录屏 |\n`;
  assert.ok(!isRunaway(table), "表格");
  let paths = ""; for (let i = 0; i < 80; i++) paths += `- ~/Project.X/third_party/test_documents/ground_truth/pdf/sample-${i}.pdf  ${(i * 13) % 97}K\n`;
  assert.ok(!isRunaway(paths), "相似的文件路径");
  assert.ok(!isRunaway("哈".repeat(1999)), "不到一个窗口不判");
});

test("对话中流式输出陷入复读：截停、丢掉那段输出、提醒后正常回复", async () => {
  const seen: any[] = [];
  let aborted = false;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = JSON.parse(body); seen.push(j);
      if (seen.length > 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "换个思路：结论是 A。" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        return;
      }
      // 第一次：流式地一直复读，直到被截停（客户端断开）
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        if (++n > 400) { clearInterval(timer); res.end("data: [DONE]\n\n"); return; }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "/2026-09-28-14-30-00-001" } }] })}\n\n`);
      }, 2);
      res.on("close", () => { clearInterval(timer); aborted = n <= 400; });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: base, protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
  try {
    assert.equal(await converse("测试者", "看看目录", "控制台", { conv: "rw" }), "换个思路：结论是 A。");
    assert.ok(aborted, "复读在流里就被截停了");
    const last = seen.at(-1).messages;
    assert.match(last.at(-1).content, /陷入了重复/);
    assert.ok(!last.some((m: any) => m.role === "assistant" && String(m.content ?? "").includes("-001-001")), "复读的输出不进上下文");
    const proc = store.sessionMessages("rw").at(-1)!.process as any[];
    assert.ok(proc.some((x) => x.type === "text" && /已截停/.test(x.text)));
    assert.ok(!JSON.stringify(proc).includes("-001/2026"), "过程记录里也不留复读的文字");
  } finally { server.close(); }
});
