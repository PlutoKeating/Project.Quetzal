#!/usr/bin/env node
// 纯 Node 实现的“脚本化守护进程”测试替身：
// - 静态托管 surfaces/web/dist（与 quetzalcoatld 同源语义）
// - GET /health、GET /auth/local、WebSocket /rpc（RFC 6455 握手与帧由本文件实现）
// - 按固定脚本推送 token / tool / patch / response 帧，供 Playwright E2E 断言语义
// 该文件只服务测试，不进入构建产物。

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "43117" },
    static: { type: "string", default: "dist" },
    host: { type: "string", default: "127.0.0.1" },
  },
});

const port = Number.parseInt(values.port, 10);
const host = values.host;
const root = resolve(values.static);
const TOKEN = "mock-token-7f3c9d";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function safePath(urlPath) {
  const raw = urlPath.split("?")[0] ?? "/";
  if (raw.includes("%") || raw.includes("\\") || raw.includes("\0")) return null;
  const normalized = normalize(raw).replace(/^([.]{2}[\\/])+/, "");
  const rel = normalized === "/" ? "index.html" : normalized.replace(/^[/]+/, "");
  if (rel.split("/").some((segment) => segment === "..")) return null;
  return join(root, rel);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let file = safePath(pathname);
  if (!file) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end();
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    // SPA 回退：无扩展名的路径一律交给 index.html
    if (extname(pathname) === "") {
      file = join(root, "index.html");
    } else {
      res.writeHead(404, SECURITY_HEADERS);
      res.end();
      return;
    }
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME.get(extname(file)) ?? "application/octet-stream",
      "content-length": String(body.length),
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch {
    res.writeHead(404, SECURITY_HEADERS);
    res.end();
  }
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function sendText(socket, value) {
  if (socket.destroyed) return;
  socket.write(encodeFrame(0x1, JSON.stringify(value)));
}

function sendClose(socket, code, reason = "") {
  if (socket.destroyed) return;
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  socket.write(encodeFrame(0x8, body));
  socket.end();
}

function readFrames(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(
        buffer.subarray(offset + maskLength, offset + maskLength + length),
      );
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      buffer = buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) {
        sendClose(socket, 1000);
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0x1) onMessage(payload.toString("utf8"));
    }
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function snapshot() {
  return {
    rev: 4,
    density: "workbench",
    rows: {
      "status/daemon": {
        key: "status/daemon",
        kind: "status",
        summary: "羽蛇神在线 · 数据只留在这台设备",
        detail: "脚本化守护进程 · 版本 0.1.0",
        raw_json: JSON.stringify({ pid: 4242, state: "ready", transport: "websocket" }),
        updated_rev: 1,
      },
      "artifact/roadmap": {
        key: "artifact/roadmap",
        kind: "artifact",
        summary: "共享产物 · 十一月路线图",
        detail: "群组「设计评审」3 位成员已确认，等待提交。",
        raw_json: JSON.stringify({ tree: "refs/qz/squad/design/roadmap", oid: "9f2c1a" }),
        updated_rev: 2,
      },
      "conscience/root": {
        key: "conscience/root",
        kind: "conscience",
        summary: "良知树 · 四个维度均衡",
        detail: "ROOT 100 / OPERATOR 80 / SELF_CORE 70",
        raw_json: JSON.stringify({ root: 100, operator: 80, self_core: 70, self_soft: 50 }),
        updated_rev: 3,
      },
    },
  };
}

function assistantRow(runId, reply) {
  return {
    key: `chat/${runId}`,
    kind: "assistant",
    summary: reply,
    detail: "脚本流式回放",
    raw_json: JSON.stringify({ run_id: runId, reply }),
    updated_rev: 9,
  };
}

const server = createServer(async (req, res) => {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";

  if (pathname === "/health") {
    sendJson(res, 200, { status: "ok", version: "0.1.0-mock", web: true });
    return;
  }
  if (pathname === "/auth/local") {
    const origin = req.headers.origin;
    const hostHeader = req.headers.host;
    if (origin && hostHeader) {
      try {
        if (new URL(origin).host !== hostHeader) {
          sendJson(res, 403, { error: "cross-origin" });
          return;
        }
      } catch {
        sendJson(res, 403, { error: "bad-origin" });
        return;
      }
    }
    sendJson(res, 200, { token: TOKEN, expires_in_secs: 3600 });
    return;
  }
  if (pathname === "/rpc" && req.method === "POST") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "bad-json" });
      return;
    }
    const method = parsed?.method ?? "unknown";
    if (method === "status") {
      sendJson(res, 200, {
        kind: "status",
        data: { pid: 4242, sleep_phase: "awake", group_rooms: 1 },
      });
      return;
    }
    if (method === "chat") {
      sendJson(res, 200, {
        kind: "chat",
        data: { reply: "HTTP 通道回执", run_id: "http-run", delegated_to_worker: false },
      });
      return;
    }
    sendJson(res, 200, { kind: "ack", data: { detail: method } });
    return;
  }
  if (pathname === "/rpc/snapshot") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, snapshot());
    return;
  }

  if (pathname === "/rpc") {
    sendJson(res, 400, { error: "websocket-required" });
    return;
  }

  await serveStatic(req, res, pathname);
});

function handleUpgrade(req, socket) {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (pathname !== "/rpc") {
  socket.destroy();
  return;
  }
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string") {
  socket.destroy();
  return;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
  `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const state = { authed: false, busy: false };

  readFrames(socket, (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendClose(socket, 1003, "bad-json");
      return;
    }
    if (!state.authed) {
      if (message?.auth !== TOKEN) {
        sendClose(socket, 4401, "unauthorized");
        return;
      }
      state.authed = true;
      sendText(socket, { type: "ready", transport: "websocket" });
      sendText(socket, { type: "snapshot", state: snapshot() });
      return;
    }
    if (message?.type === "ping") {
      sendText(socket, { type: "pong" });
      return;
    }
    if (message?.id === undefined || message?.request === undefined) {
      sendText(socket, { type: "error", detail: "malformed-envelope" });
      return;
    }
    const id = message.id;
    const method = message.request.method;
    if (method === "chat") {
      if (state.busy) {
        sendText(socket, { type: "error", detail: "busy" });
        return;
      }
      state.busy = true;
      const runId = `run-${id}`;
      const reply = "已为你整理：上午整理共享产物，下午评审路线图。";
      void (async () => {
        let seq = 0;
        for (const piece of ["已为你整理：", "上午整理共享产物，", "下午评审路线图。"]) {
          await sleep(25);
          sendText(socket, { type: "token", messageId: runId, seq, text: piece });
          seq += 1;
        }
        sendText(socket, {
          type: "patch",
          patch: {
            from_rev: 4,
            to_rev: 5,
            density: "workbench",
            ops: [{ op: "upsert", row: assistantRow(runId, reply) }],
          },
        });
        sendText(socket, {
          type: "tool",
          id: "tool-1",
          kind: "tool",
          title: "已整理 1 个日程",
          detail: "写入本地日程草稿，未外发。",
        });
        sendText(socket, {
          type: "approval",
          id: "appr-1",
          kind: "approval",
          title: "是否允许读取共享产物？",
          detail: "仅本机读取，不外发。",
        });
        sendText(socket, {
          type: "response",
          id,
          response: {
            kind: "chat",
            data: { reply, run_id: runId, delegated_to_worker: false },
          },
        });
        state.busy = false;
      })();
      return;
    }
    if (method === "status") {
      sendText(socket, {
        type: "response",
        id,
        response: { kind: "status", data: { pid: 4242, sleep_phase: "awake" } },
      });
      return;
    }
    sendText(socket, {
      type: "response",
      id,
      response: { kind: "ack", data: { detail: String(method) } },
    });
  });
}

server.on("upgrade", handleUpgrade);

server.listen(port, host, () => {
  console.log(`mock-daemon listening on http://${host}:${port} (static: ${root})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
