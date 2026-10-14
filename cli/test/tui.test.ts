import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { LocalGateway, TerminalChat, TerminalInputQueue, terminalText, type Gateway } from "../src/tui.ts";

class FakeGateway implements Gateway {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  connects = 0;
  pending: any[] = [];
  approvals = [{ id: "same", body: "body-b", action: "camera", reason: "拍照\x1b[2J", status: "pending", args: { secret: "不显示参数" } }];
  async connect() { this.connects++; }
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "sessions") return [{ id: "c1", title: "会话一" }, { id: "c2", title: "会话二" }];
    if (method === "sessions.create") return { id: "new", title: params.title };
    if (method === "sessions.messages") return [{ role: "agent", text: "历史\x1b[2J" }];
    if (method === "secrets.pending") return this.pending;
    if (method === "sessions.live") return [];
    if (method === "approvals") return this.approvals;
    if (method === "chat.send") return new Promise(() => {}); // 保持在途，验证停止和断线不重发。
    return true;
  }
  close() {}
}
function fixture() {
  const gateway = new FakeGateway(), output: string[] = [], muted: boolean[] = [];
  let quits = 0;
  const chat = new TerminalChat(gateway, (text) => output.push(text), (state) => muted.push(state), () => { quits++; });
  return { gateway, output, muted, chat, quits: () => quits };
}

test("终端控制字符、OSC 剪贴板/链接与双向标记不进入输出", () => {
  assert.equal(terminalText("前\x1b[2J后\x1b]52;c;secret\x07\u202e\x00"), "前后");
  assert.equal(terminalText("\x1b]8;;https://example.test\x1b\\文本\x1b]8;;\x1b\\"), "文本");
  assert.equal(terminalText("安全\x1b"), "安全");
});

test("同 agent 的会话选择、新建、发送、审批及停止通过真实方法契约", async () => {
  const f = fixture(); await f.chat.start();
  await f.chat.line("/sessions"); await f.chat.line("/use 2"); assert.equal(f.chat.conv, "c2");
  await f.chat.line("/new 研究"); assert.equal(f.chat.conv, "new");
  await f.chat.line("你好"); await f.chat.line("/stop"); await f.chat.line("/approvals"); await f.chat.line("/approve 1");
  const sent = f.gateway.calls.filter((c) => c.method === "chat.send");
  assert.equal(sent.length, 1); assert.equal(sent[0].params.conv, "new"); assert.equal(sent[0].params.mode, "steer");
  assert.deepEqual(f.gateway.calls.find((c) => c.method === "decide")?.params, { id: "same", body: "body-b", approve: true });
  assert.ok(f.gateway.calls.some((c) => c.method === "chat.stop" && c.params.conv === "new"));
  assert.ok(!f.output.join("").includes("不显示参数")); assert.ok(!f.output.join("").includes("\x1b"));
  await f.chat.line("/quit"); assert.equal(f.quits(), 1);
});

test("保密输入关闭回显且拒绝发送；已开启的其他会话不影响普通会话", async () => {
  const f = fixture(); await f.chat.start();
  f.chat.event("secret", { conv: "c2", status: "open" }); assert.equal(f.chat.secretBlocked, false);
  f.chat.event("secret", { conv: "c1", status: "open" }); assert.equal(f.muted.at(-1), true);
  await f.chat.line("这里是秘密"); assert.ok(!f.gateway.calls.some((c) => c.method === "chat.send"));
  assert.ok(!f.output.join("").includes("这里是秘密"));
  f.chat.event("secret", { conv: "c1", status: "done" }); assert.equal(f.chat.secretBlocked, false);
  f.gateway.pending = [{ conv: "c1" }]; // 服务端先打开、本地推送尚未到达。
  await f.chat.line("仍不发送"); assert.ok(!f.gateway.calls.some((c) => c.method === "chat.send"));
});

test("断线屏蔽回显，手动重连只恢复状态不重发在途 chat.send", async () => {
  const f = fixture(); await f.chat.start(); await f.chat.line("执行一次");
  f.chat.disconnected(); assert.equal(f.chat.secretBlocked, true);
  await f.chat.line("不能发送"); await f.chat.line("/reconnect");
  assert.equal(f.gateway.connects, 2); assert.equal(f.gateway.calls.filter((c) => c.method === "chat.send").length, 1);
  assert.equal(f.chat.secretBlocked, false);
});

test("流式过程仅显示选中会话的文字/工具状态，不打印工具参数，切会话跟随宿主", async () => {
  const f = fixture(); await f.chat.start(); f.output.length = 0;
  f.chat.event("activity", { session: "t", conv: "c2", kind: "delta", text: "别处" });
  f.chat.event("activity", { session: "t", conv: "c1", kind: "delta", text: "流式\x1b[2J" });
  f.chat.event("activity", { session: "t", conv: "c1", kind: "tool", name: "shell", status: "running", summary: "隐藏命令", args: { secret: "隐藏密钥" }, result: "隐藏输出" });
  f.chat.event("activity", { session: "t", conv: "c1", kind: "done", reply: "流式" });
  assert.equal(f.output.join("|").split("流式").length - 1, 1);
  assert.ok(!/别处|隐藏/.test(f.output.join("")));
  f.chat.event("session.switch", { from: "c1", to: "new" }); assert.equal(f.chat.conv, "new");
});

// Node 内置 HTTP/crypto 实现最小合成 WebSocket 服务，只服务测试数据，不依赖 runtime。
async function syntheticGateway() {
  const token = "synthetic-token", requests: any[] = [], sockets = new Set<Duplex>(); let localAuth = 0;
  const frame = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value));
    const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    return Buffer.concat([head, payload]);
  };
  const server = http.createServer((req, res) => { assert.equal(req.url, "/auth/local"); localAuth++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, token })); });
  server.on("upgrade", (req, socket) => {
    assert.equal(req.url, "/rpc"); sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const accept = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0), authenticated = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let len = buffer[1] & 127, offset = 2;
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = !!(buffer[1] & 128); const size = offset + (masked ? 4 : 0) + len;
        if (buffer.length < size) return;
        const mask = buffer.subarray(offset, offset + 4); offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + len)); buffer = buffer.subarray(size);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(); return; } if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString()); requests.push(message);
        if (!authenticated) { assert.deepEqual(message, { auth: token }); authenticated = true; socket.write(frame({ event: "hello", data: {} })); }
        else if (message.method === "disconnect") socket.destroy();
        else socket.write(frame({ id: message.id, result: message.method === "status" ? { ok: true } : [] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { token, requests, port: address.port, localAuth: () => localAuth, async close() { for (const s of sockets) s.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("真实本机 WebSocket 首帧认证/RPC、断线失败与令牌隐藏；不重发", async () => {
  const server = await syntheticGateway(), home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-tui-"));
  fs.mkdirSync(path.join(home, "secrets")); fs.writeFileSync(path.join(home, "secrets", "gateway.token"), server.token);
  let disconnected = 0; const gateway = new LocalGateway(home, server.port, () => {}, () => { disconnected++; });
  try {
    await gateway.connect(); assert.deepEqual(await gateway.request("status"), { ok: true });
    assert.equal(server.localAuth(), 0); assert.equal(gateway.safe(server.token), "[凭据]");
    await assert.rejects(gateway.request("disconnect"), /不会自动重发/);
    assert.equal(disconnected, 1); assert.equal(server.requests.filter((r) => r.method === "disconnect").length, 1);
  } finally { gateway.close(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("读不到本机令牌时经 /auth/local 获取；端口拒绝非法配置", async () => {
  const server = await syntheticGateway(), home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-tui-auth-"));
  const gateway = new LocalGateway(home, server.port, () => {}, () => {});
  try { await gateway.connect(); assert.equal(server.localAuth(), 1); assert.deepEqual(await gateway.request("status"), { ok: true }); }
  finally { gateway.close(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
  await assert.rejects(new LocalGateway(home, 0, () => {}, () => {}).connect(), /端口无效/);
});

test("启动或重连时已有保密输入，始终拒绝普通输入并保持静音", async () => {
  const f = fixture(); f.gateway.pending = [{ conv: "c1" }];
  await f.chat.start(); assert.equal(f.chat.secretBlocked, true); assert.equal(f.muted.at(-1), true);
  await f.chat.line("秘密不能发送"); await f.chat.line("/reconnect");
  assert.equal(f.chat.secretBlocked, true); assert.ok(!f.gateway.calls.some((c) => c.method === "chat.send"));
});

test("恢复快照期间收到 secret/open 时回放增量，旧空快照不能重新开启回显", async () => {
  const f = fixture(), original = f.gateway.request.bind(f.gateway);
  f.gateway.request = async (method, params) => {
    if (method === "secrets.pending") { f.chat.event("secret", { conv: "c1", status: "open" }); return []; }
    return original(method, params);
  };
  await f.chat.start(); assert.equal(f.chat.secretBlocked, true); assert.equal(f.muted.at(-1), true);
  await f.chat.line("不发送的秘密"); assert.ok(!f.gateway.calls.some((c) => c.method === "chat.send"));
  await f.chat.line("/new 也不能作为标题发送的秘密"); assert.ok(!f.gateway.calls.some((c) => c.method === "sessions.create"));
});

test("发送前检查期间切会话、开启保密或断线均拒绝发送原输入", async () => {
  for (const change of ["switch", "secret", "disconnect"]) {
    const f = fixture(); await f.chat.start(); const original = f.gateway.request.bind(f.gateway);
    f.gateway.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "secrets.pending") {
        if (change === "switch") f.chat.event("session.switch", { from: "c1", to: "c2" });
        if (change === "secret") f.chat.event("secret", { conv: "c1", status: "open" });
        if (change === "disconnect") f.chat.disconnected();
      }
      return result;
    };
    await f.chat.line("不能发错会话或当秘密发送");
    assert.ok(!f.gateway.calls.some((c) => c.method === "chat.send"), change);
  }
});

test("sessions.live 使用 turn 字段恢复在途状态；恢复期间断线保持静音", async () => {
  const f = fixture(), original = f.gateway.request.bind(f.gateway);
  f.gateway.request = async (method, params) => method === "sessions.live" ? [{ turn: "existing", conv: "c1" }] : original(method, params);
  await f.chat.start(); assert.ok(f.output.some((text) => text.includes("有进行中的轮次")));
  const interrupted = fixture(), request = interrupted.gateway.request.bind(interrupted.gateway);
  interrupted.gateway.request = async (method, params) => { if (method === "sessions.live") interrupted.chat.disconnected(); return request(method, params); };
  await assert.rejects(interrupted.chat.start(), /连接已断开/); assert.equal(interrupted.chat.secretBlocked, true);
});

test("真实输入队列：前一历史请求挂起期间的保密正文立即拒绝，保密结束后不补发", async () => {
  for (const input of ["保密正文不能发到模型", "/new 保密正文不能成为标题"]) {
    const f = fixture(); await f.chat.start();
    const original = f.gateway.request.bind(f.gateway);
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.gateway.request = async (method, params) => { if (method === "sessions.messages") { started(); await barrier; } return original(method, params); };
    const queue = new TerminalInputQueue(f.chat);
    const history = queue.enqueue("/history"); await entered;
    f.chat.event("secret", { conv: "c1", status: "open" });
    const protectedInput = queue.enqueue(input);
    await protectedInput; // 即使 history 仍挂起，正文也已拒绝，没有存进待执行队列。
    f.chat.event("secret", { conv: "c1", status: "done" });
    release(); await history;
    assert.ok(!f.gateway.calls.some((c) => c.method === "chat.send" || c.method === "sessions.create"));
    assert.ok(!f.output.join("").includes(input));
  }
});

test("非当前会话的 done/error 同样清理全局在途轮次，不显示其他会话回复", async () => {
  const f = fixture(); await f.chat.start(); f.output.length = 0;
  for (const kind of ["done", "error"]) {
    f.chat.event("activity", { session: kind, conv: "c2", kind: "start" });
    const active = Reflect.get(f.chat, "active"); assert.equal(active.has(kind), true);
    f.chat.event("activity", { session: kind, conv: "c2", kind, reply: "其他会话的回复" });
    assert.equal(active.has(kind), false);
  }
  assert.equal(f.output.length, 0);
});
