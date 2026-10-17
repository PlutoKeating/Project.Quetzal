// Windows 的手：键名换成虚拟键码、PowerShell 脚本拼装（坐标取整、字符串转义）、UI Automation 与窗口输出解析；
// 运行基座不在桌面里（会话 0）时转交身体助手；只在 Windows 上跑的真机部分读一次屏幕。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { keyTokens, scripts, parseSnapshot, parseWindows, HELPER, handsOps } from "../adapters/windows/hands.ts";

const WIN = process.platform === "win32";

test("键：修饰键与功能键用虚拟键码，方向与翻页是扩展键，标点按键盘布局换算；手机的键说明换法", () => {
  assert.deepEqual(keyTokens(["ctrl", "shift", "t"]), ["v17", "v16", "v84"]);
  assert.deepEqual(keyTokens(["alt", "f4"]), ["v18", "v115"]);
  assert.deepEqual(keyTokens(["meta"]), ["v91"]);
  assert.deepEqual(keyTokens(["pagedown", "left", "delete"]), ["x34", "x37", "x46"]);
  assert.deepEqual(keyTokens(["ctrl", "/"]), ["v17", "c/"]);
  assert.deepEqual(keyTokens(["7"]), ["v55"]);
  assert.throws(() => keyTokens(["back"]), /手机的按键/);
  assert.throws(() => keyTokens(["launch"]), /按不出来/);
});

test("脚本：先编译一次输入帮手；坐标取整，文字按 PowerShell 单引号转义", () => {
  assert.ok(HELPER.includes("SendInput") && HELPER.includes("SetProcessDpiAwarenessContext") && HELPER.includes("'QuetzalHands' -as [type]"));
  assert.ok(scripts.click({ x: 10.6, y: 20.2, button: "right", count: 2 }).endsWith("[QuetzalHands]::Click(11, 20, 'right', 2, 0)"));
  assert.ok(scripts.click({ x: 1, y: 2, count: 9 }).endsWith("Click(1, 2, 'left', 3, 0)"), "最多三击");
  assert.ok(scripts.drag({ x1: 1, y1: 2, x2: 3, y2: 4, ms: 500 }).endsWith("Drag(1, 2, 3, 4, 500)"));
  assert.ok(scripts.scroll({ direction: "down", amount: 3 }).endsWith("[QuetzalHands]::Wheel(0, -3)"));
  assert.ok(scripts.scroll({ direction: "right", amount: 2, x: 5, y: 6 }).endsWith("[QuetzalHands]::Move(5, 6)\n[QuetzalHands]::Wheel(2, 0)"));
  assert.ok(scripts.type({ text: "它's $x `t" }).endsWith("[QuetzalHands]::Text('它''s $x `t')"));
  assert.match(scripts.type({ text: "a", x: 1, y: 2 }), /Click\(1, 2, 'left', 1, 0\)\nStart-Sleep -Milliseconds 150\n\[QuetzalHands\]::Text\('a'\)$/);
  assert.ok(scripts.key({ keys: ["ctrl", "c"] }).endsWith("Combo([string[]]@('v17', 'v67'))"));
  assert.match(scripts.focus({ id: "1234" }), /Focus\(\[long\]1234\)/);
  assert.match(scripts.screenshot({ file: "C:\\m\\s.jpg", maxEdge: 1280 }), /1280 \/ \[double\]\[Math\]::Max\(\$s\[2\], \$s\[3\]\)/);
  assert.match(scripts.screenshot({ file: "C:\\m\\s.jpg" }), /\[Math\]::Min\(1\.0, 1\.0\)/);
  assert.match(scripts.snapshot(), /CacheRequest[\s\S]*TreeScope\]::Subtree[\s\S]*ControlViewCondition/);
  assert.match(scripts.openApp("O'Neil"), /\$q = 'O''Neil'[\s\S]*Get-StartApps[\s\S]*shell:AppsFolder/);
});

test("UI Automation 输出：通用角色、坐标、状态与引用", () => {
  const out = [
    "WARNING: 无关", "SCREEN\t3840\t1080\tnotepad\t无标题 - 记事本",
    "Window\t无标题 - 记事本\t\t0\t0\t1200\t800\t42.1\t",
    "Button\t关闭\t\t1150\t0\t50\t30\t42.2\tc",
    "Document\t文本编辑器\t你好\t0\t60\t1200\t700\t42.3\tecsf",
    "CheckBox\t自动换行\t\t10\t10\t20\t20\t42.4\tcK",
    "MenuItem\t文件\t\t0\t30\t40\t20\t\tcd",
    "坏的一行",
  ].join("\r\n");
  const s = parseSnapshot(out);
  assert.equal(s.width, 3840); assert.equal(s.height, 1080); assert.equal(s.app, "notepad"); assert.equal(s.window, "无标题 - 记事本");
  assert.deepEqual(s.elements.map((e) => e.role), ["window", "button", "input", "checkbox", "menuitem"]);
  assert.deepEqual(s.elements[2], { role: "input", name: "文本编辑器", value: "你好", x: 0, y: 60, w: 1200, h: 700, ref: "uia:42.3", clickable: true, editable: true, scrollable: true, enabled: true, focused: true, selected: undefined, checked: undefined });
  assert.equal(s.elements[3].checked, true);
  assert.equal(s.elements[4].enabled, false); assert.equal(s.elements[4].ref, undefined);
  assert.equal(parseSnapshot("SCREEN\t1920\t1080\t\t").note, "前台没有窗口");
  assert.throws(() => parseSnapshot("什么都没有"), /读不到前台窗口/);
});

test("窗口列表：没有标题的跳过，标出前台", () => {
  const out = "65552\texplorer\t0\t\t0\t0\t1920\t40\r\n131234\tnotepad\t1\t无标题 - 记事本\t100\t100\t800\t600\r\n";
  assert.deepEqual(parseWindows(out), [{ id: "131234", title: "无标题 - 记事本", app: "notepad", focused: true, x: 100, y: 100, w: 800, h: 600 }]);
});

test("操作表：身体助手与适配器共用同一组 hands.* 操作", () => {
  assert.deepEqual(Object.keys(handsOps).sort(), ["hands.click", "hands.drag", "hands.focus", "hands.key", "hands.openApp", "hands.screenshot", "hands.scroll", "hands.snapshot", "hands.status", "hands.type", "hands.windows"]);
});

test("不在桌面里：手的操作转交身体助手（带令牌）；助手不在时 status 如实说明", { skip: WIN && "Windows 上初始化会判断真实会话" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-winhands-"));
  process.env.QUETZAL_HOME = home;
  const { default: adapter } = await import("../adapters/windows/index.ts");
  await adapter.init!(); // 没有 PowerShell：当作不在桌面里
  const st = await adapter.hands!.status();
  assert.equal(st.ready, false);
  assert.match(st.reason!, /没有人登录桌面/);
  const seen: { auth?: string; body: any }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ auth: req.headers.authorization, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body.op === "hands.openApp" ? { ok: true, result: "已打开 设置（windows.immersivecontrolpanel）" } : body.op === "hands.key" ? { ok: false, error: "系统没有接受模拟的输入" } : { ok: true, result: null }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(home, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(home, "secrets", "desktop-body.json"), JSON.stringify({ port: (server.address() as { port: number }).port, token: "k".repeat(64), pid: 1 }));
  await adapter.hands!.click({ x: 10, y: 20, ref: "uia:1" }, { button: "right" });
  assert.deepEqual(seen.at(-1), { auth: `Bearer ${"k".repeat(64)}`, body: { op: "hands.click", args: { x: 10, y: 20, button: "right" } } });
  await adapter.hands!.type("你好", { x: 1, y: 2 });
  assert.deepEqual(seen.at(-1)!.body, { op: "hands.type", args: { text: "你好", x: 1, y: 2 } });
  assert.equal(await adapter.hands!.openApp("设置"), "已打开 设置（windows.immersivecontrolpanel）");
  await assert.rejects(adapter.hands!.key(["ctrl", "c"]), /没有接受模拟的输入/);
  server.close();
});

test("Windows：读一次前台窗口与窗口列表", { skip: !WIN && "只在 Windows 上跑" }, async () => {
  const snap = await handsOps["hands.snapshot"]({}) as { width: number; height: number };
  assert.ok(snap.width > 0 && snap.height > 0);
  assert.ok(Array.isArray(await handsOps["hands.windows"]({})));
  const { ps } = await import("../adapters/windows/desktop.ts");
  ps.stop();
});
