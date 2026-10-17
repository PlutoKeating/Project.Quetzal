// 远程 MCP：本地合成的 Streamable HTTP / 旧版 SSE 服务、假的 OAuth 授权服务器、resources / prompts、出站检查、多端同步标记。
// 全部是本机回环上的合成服务，不访问外部网络或真实账号。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mcp-remote-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, saveConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const rt = await import("../src/mcp/runtime.ts");
const { RemoteSource, toolName, metaName } = await import("../src/mcp/client.ts");
const { mcpFetch, remoteUrl, allowed } = await import("../src/mcp/net.ts");
const { allTools, callTool } = await import("../src/mind/tools.ts");
const { baseSecrets } = await import("../src/secret-values.ts");

// ---------- 合成 MCP 服务：JSON-RPC over HTTP（Streamable HTTP 的 JSON 应答形式）与旧版 HTTP+SSE
const TOKEN = "synthetic-access-token-0123456789";
let requireAuth = false;
const seen: string[] = [];
function handleRpc(m: any): any {
  seen.push(m.method);
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return ok({ protocolVersion: "2025-11-25", serverInfo: { name: "remote-fixture", version: "1" }, capabilities: { tools: {}, resources: {}, prompts: {} } });
    case "tools/list": return ok({ tools: [{ name: "echo", description: "原样返回", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
    case "tools/call": return ok({ content: [{ type: "text", text: `remote:${m.params.arguments?.text ?? ""}` }, { type: "resource_link", uri: "memo://one", name: "一号备忘" }] });
    case "resources/list": return ok({ resources: [{ uri: "memo://one", name: "一号备忘", mimeType: "text/plain" }, { uri: "memo://bin", name: "二进制" }] });
    case "resources/templates/list": return ok({ resourceTemplates: [{ uriTemplate: "memo://{name}", name: "按名字的备忘" }] });
    case "resources/read": return m.params.uri === "memo://bin" ? ok({ contents: [{ uri: "memo://bin", blob: "AAAA", mimeType: "application/octet-stream" }] }) : ok({ contents: [{ uri: m.params.uri, text: `备忘内容 ${m.params.uri}` }] });
    case "prompts/list": return ok({ prompts: [{ name: "summarize", description: "总结一段话", arguments: [{ name: "text", required: true }] }] });
    case "prompts/get": return ok({ description: "总结", messages: [{ role: "user", content: { type: "text", text: `请总结：${m.params.arguments?.text}` } }] });
    case "ping": return ok({});
    default: return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } };
  }
}
const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

// 假的授权服务器（同一个回环服务上）：受保护资源元数据、授权服务器元数据、动态注册、授权（直接 302 回调）、换令牌（核对 PKCE S256）
const codes = new Map<string, { challenge: string; client: string }>();
let base = "";
const sseClients = new Map<string, http.ServerResponse>();
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", base);
  const json = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/.well-known/oauth-protected-resource/mcp" || u.pathname === "/.well-known/oauth-protected-resource") return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
  if (u.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (u.pathname === "/register" && req.method === "POST") { const meta = JSON.parse(await readBody(req)); return json(201, { ...meta, client_id: "synthetic-client" }); }
  if (u.pathname === "/authorize") {
    const code = crypto.randomBytes(8).toString("hex");
    codes.set(code, { challenge: u.searchParams.get("code_challenge")!, client: u.searchParams.get("client_id")! });
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code); back.searchParams.set("state", u.searchParams.get("state")!);
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (u.pathname === "/token" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    const c = codes.get(p.get("code") ?? "");
    const verifier = p.get("code_verifier") ?? "";
    if (!c || crypto.createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
    codes.delete(p.get("code")!);
    return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: "synthetic-refresh-token-abcdef" });
  }
  if (u.pathname === "/mcp") {
    if (requireAuth && req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    const m = JSON.parse(await readBody(req));
    if (Array.isArray(m) || m.id === undefined) { res.writeHead(202).end(); return; }
    if (m.method === "server/discover") return json(200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    return json(200, handleRpc(m), { "mcp-session-id": "s1" });
  }
  // 旧版 HTTP+SSE：GET /sse 开流，第一条 endpoint 事件给出 POST 地址；应答经 SSE 的 message 事件送回
  if (u.pathname === "/sse" && req.method === "GET") {
    const id = crypto.randomBytes(4).toString("hex");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
    sseClients.set(id, res);
    req.on("close", () => sseClients.delete(id));
    return;
  }
  if (u.pathname === "/messages" && req.method === "POST") {
    const stream = sseClients.get(u.searchParams.get("sessionId") ?? "");
    const m = JSON.parse(await readBody(req));
    res.writeHead(202).end();
    if (stream && m.id !== undefined) stream.write(`event: message\ndata: ${JSON.stringify(m.method === "server/discover" ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } } : handleRpc(m))}\n\n`);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
base = `http://127.0.0.1:${(server.address() as any).port}`;
after(async () => {
  await rt.closeMcp();
  for (const s of sseClients.values()) s.end();
  server.closeAllConnections(); server.close();
  (await import("../src/store.ts")).db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const remote = (id: string, transport: "http" | "sse", extra: Record<string, unknown> = {}) => rt.parseServer({ id, transport, url: `${base}/${transport === "http" ? "mcp" : "sse"}`, enabled: true, timeoutMs: 3000, oauth: false, ...extra }) as import("../src/mcp/client.ts").RemoteServer;

for (const transport of ["http", "sse"] as const) test(`远程 ${transport}：发现工具、资源与提示词，调用、读取、取用`, async () => {
  const s = remote(`r_${transport}`, transport);
  const c = new RemoteSource(s, { headers: { "x-test": "1" }, fetch: mcpFetch(new URL(s.url)) });
  await c.connect();
  try {
    const names = c.list().map((b) => b.kind).sort();
    assert.deepEqual(names, ["prompt_get", "prompt_list", "resource_list", "resource_read", "tool"]);
    const r = await c.call("echo", { text: "hi" });
    assert.match(r.text, /remote:hi/);
    assert.match(r.text, /资源链接 memo:\/\/one/);
    assert.equal(r.failed, false);
    const list = await c.meta("resource_list", {});
    assert.match(list.text, /memo:\/\/one/);
    assert.match(list.text, /memo:\/\/\{name\}/);
    assert.equal((await c.meta("resource_read", { uri: "memo://one" })).text, "备忘内容 memo://one");
    const bin = await c.meta("resource_read", { uri: "memo://bin" });
    assert.match(bin.text, /二进制/);
    assert.equal(bin.failed, true);
    assert.match((await c.meta("prompt_list", {})).text, /summarize/);
    assert.match((await c.meta("prompt_get", { name: "summarize", arguments: { text: "天气" } })).text, /请总结：天气/);
    assert.equal((await c.meta("prompt_get", { name: "nope" })).failed, true);
    assert.equal(c.contents().resources.length, 2);
    assert.equal(c.contents().templates.length, 1);
  } finally { await c.close(); }
});

test("esbuild CJS 产物能经官方 SDK 走 Streamable HTTP 发现与调用", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const outfile = path.join(home, "remote-client.cjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/mcp/client.ts", import.meta.url))], bundle: true, platform: "node", target: "node22", format: "cjs", outfile, logLevel: "silent" });
  const bundled = createRequire(import.meta.url)(outfile) as typeof import("../src/mcp/client.ts");
  const s = remote("bundled", "http");
  const c = new bundled.RemoteSource(s, { headers: {}, fetch: mcpFetch(new URL(s.url)) });
  try { await c.connect(); assert.match((await c.call("echo", { text: "cjs" })).text, /remote:cjs/); } finally { await c.close(); }
});

test("地址规则：只收 HTTPS，回环例外；远程来源访问不了回环与内网", async () => {
  assert.throws(() => remoteUrl("http://example.com/mcp"), /HTTPS/);
  assert.throws(() => remoteUrl("https://user:pw@example.com/mcp"), /用户名/);
  assert.equal(remoteUrl("http://127.0.0.1:9/mcp").hostname, "127.0.0.1");
  assert.equal(remoteUrl("http://[::1]:9/mcp").hostname, "[::1]");
  const pub = new URL("https://mcp.example.com/mcp");
  assert.match(String(await allowed(new URL("http://127.0.0.1:7788/rpc"), pub)), /回环/);
  assert.match(String(await allowed(new URL("https://10.0.0.1/token"), pub)), /内网/);
  assert.match(String(await allowed(new URL("https://169.254.169.254/latest"), pub)), /内网/);
  assert.match(String(await allowed(new URL("http://93.184.216.34/x"), pub)), /HTTPS/);
  assert.equal(await allowed(new URL(`${base}/token`), new URL(`${base}/mcp`)), undefined);
  assert.throws(() => rt.parseServer({ id: "bad", transport: "http", url: "http://example.com/mcp" }));
  assert.throws(() => rt.parseServer({ id: "bad", transport: "http", url: "https://example.com/mcp", headers: { "mcp-session-id": "x" } }));
  assert.throws(() => rt.parseServer({ id: "bad", transport: "http", url: "https://example.com/mcp", headerSecrets: { Authorization: "../gateway.token" } }));
  assert.equal((rt.parseServer({ id: "ok", transport: "http", url: "https://example.com/mcp" }) as any).sync, true, "远程来源缺省多端同步");
  assert.equal((rt.parseServer({ id: "ok", command: process.execPath, args: [] }) as any).sync, false, "stdio 缺省仅本机");
});

test("OAuth 2.1：未登录时状态为需要登录；登录走发现、动态注册、PKCE、回调换令牌，令牌只在 secrets/ 并被脱敏", async () => {
  requireAuth = true;
  saveConfig({ permissions: { mcp_start: "allow", mcp: "allow" } });
  await rt.startMcp();
  const added = rt.addSource({ id: "oauthy", transport: "http", url: `${base}/mcp`, enabled: true, timeoutMs: 3000 }, "测试");
  assert.equal(added.oauth, true);
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f()); };
  await until(() => rt.listSources().sources.find((s) => s.id === "oauthy")?.state === "auth");
  const { url } = await rt.login("oauthy", "测试");
  assert.ok(url);
  const authorize = new URL(url!);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("client_id"), "synthetic-client");
  assert.equal(authorize.searchParams.get("resource"), `${base}/mcp`);
  assert.match(authorize.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/oauth\/callback$/);
  // 浏览器：授权服务器 302 回到回调地址；这里直接把回调的查询参数交给运行时（与网关 /mcp/oauth/callback、控制台粘贴地址同一个入口）
  const res = await fetch(url!, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  await assert.rejects(rt.finishLogin(new URLSearchParams({ state: "forged", code: "x" }), "测试"), /过期|不是从这里发起/);
  assert.equal(await rt.finishLogin(back.searchParams, "测试"), "oauthy");
  await assert.rejects(rt.finishLogin(back.searchParams, "测试"), /过期|不是从这里发起/, "state 一次有效");
  await until(() => rt.listSources().sources.find((s) => s.id === "oauthy")?.state === "online");
  const view = rt.listSources().sources.find((s) => s.id === "oauthy")!;
  assert.equal(view.loggedIn, true);
  assert.equal(view.tools, 1);
  const stored = path.join(paths.secrets, "mcp-oauth-oauthy.json");
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  assert.ok(baseSecrets().some(([v]) => v === TOKEN), "令牌进脱敏名单");
  assert.ok(!fs.readFileSync(path.join(paths.config, "mcp.json"), "utf8").includes(TOKEN), "令牌不进配置");
  assert.ok(!JSON.stringify(rt.exportMcp()).includes(TOKEN), "令牌不进同步");
  // 生产工具链：工具、资源、提示词都以工具交给她，经闸门
  const echo = toolName("oauthy", "echo"), read = metaName("oauthy", "resources/read");
  assert.ok(allTools().some((t) => t.name === echo));
  assert.ok(allTools().some((t) => t.name === read && t.permission === `mcp.oauthy.${read}`));
  const r = await callTool(read, { uri: "memo://one" }, "合成读取");
  assert.equal(r.status, "ok");
  assert.equal(r.text, "备忘内容 memo://one");
  await rt.logout("oauthy", "测试");
  assert.ok(!fs.existsSync(stored));
  await until(() => rt.listSources().sources.find((s) => s.id === "oauthy")?.state === "auth");
  assert.equal(rt.listSources().sources.find((s) => s.id === "oauthy")?.loggedIn, false);
  rt.removeSource("oauthy", "测试");
  requireAuth = false;
});

test("配置管理：新增、启停、凭据写进 secrets/、删除连同凭据；即时启停不必重启", async () => {
  saveConfig({ permissions: { mcp_start: "allow", mcp: "allow" } });
  const v = rt.addSource({ id: "keyed", transport: "http", url: `${base}/mcp`, enabled: true, oauth: false, timeoutMs: 3000, title: "带 Key 的" }, "测试", { Authorization: "Bearer synthetic-key-value-777" });
  assert.equal(v.title, "带 Key 的");
  const cfg = fs.readFileSync(path.join(paths.config, "mcp.json"), "utf8");
  assert.ok(!cfg.includes("synthetic-key-value-777"));
  assert.ok(cfg.includes("mcp_keyed_authorization"));
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f()); };
  await until(() => rt.listSources().sources.find((s) => s.id === "keyed")?.state === "online");
  assert.ok(allTools().some((t) => t.name === toolName("keyed", "echo")));
  rt.updateSource("keyed", { enabled: false }, "测试");
  await until(() => !allTools().some((t) => t.name === toolName("keyed", "echo")));
  assert.equal(rt.sourceDetail("keyed")?.state, "off");
  assert.deepEqual(rt.sourceDetail("keyed")?.permissions, { start: "allow", tools: "allow", perTool: [] }, "权限档位按来源继承总类别");
  assert.throws(() => rt.addSource({ id: "keyed", transport: "http", url: `${base}/mcp` }, "测试"), /已有/);
  assert.equal(rt.removeSource("keyed", "测试"), true);
  assert.ok(!fs.existsSync(path.join(paths.secrets, "mcp_keyed_authorization")));
  assert.equal(rt.freeId("GitHub MCP"), "github_mcp");
  assert.equal(rt.freeId("9lives", new Set()), "lives");
});

test("多端同步：远程来源（不含凭据）按条目合并，较新的生效；仅本机的不外传也不被覆盖；删除跟着走", async () => {
  rt.addSource({ id: "shared_a", transport: "http", url: `${base}/mcp`, oauth: false }, "测试", { Authorization: "Bearer never-synced-555" });
  rt.addSource({ id: "local_b", command: process.execPath, args: ["x.mjs"] }, "测试");
  const out = rt.exportMcp();
  const a = out.find((x) => x.id === "shared_a")!;
  assert.equal(a.sync, true);
  assert.equal((a.server as any).url, `${base}/mcp`);
  assert.ok(!JSON.stringify(out).includes("never-synced-555"), "凭据值不同步");
  assert.deepEqual(Object.keys(out.find((x) => x.id === "local_b")!).sort(), ["id", "sync", "updated"], "仅本机的只留标记");
  const later = Date.now() + 1000;
  // 别处的较新版本：改了标题；别处新增一个；别处同名的去覆盖本机仅本机的：不采用；时间在未来太远的不收
  assert.equal(rt.mergeMcp([
    { id: "shared_a", updated: later, sync: true, server: { ...(a.server as object), title: "别处改的" } },
    { id: "from_peer", updated: later, sync: true, server: { transport: "sse", url: `${base}/sse`, enabled: false } },
    { id: "local_b", updated: later, sync: true, server: { transport: "http", url: `${base}/mcp` } },
    { id: "future", updated: Date.now() + 3600_000, sync: true, server: { transport: "http", url: `${base}/mcp` } },
    { id: "bad_one", updated: later, sync: true, server: { transport: "http", url: "http://example.com/mcp" } },
  ]), true);
  const list = rt.listSources().sources;
  assert.equal(list.find((s) => s.id === "shared_a")?.title, "别处改的");
  assert.equal(list.find((s) => s.id === "from_peer")?.transport, "sse");
  assert.equal(list.find((s) => s.id === "local_b")?.transport, "stdio");
  assert.ok(!list.some((s) => s.id === "future" || s.id === "bad_one"));
  assert.equal(rt.mergeMcp([{ id: "shared_a", updated: later - 5000, sync: true, server: { transport: "http", url: `${base}/mcp`, title: "旧的" } }]), false, "较旧的不采用");
  // 别处改成仅本机：这里的副本删除；别处删除：这里也删，留删除记录
  assert.equal(rt.mergeMcp([{ id: "from_peer", updated: later + 1, sync: false }, { id: "shared_a", updated: later + 1, deleted: true }]), true);
  assert.ok(!rt.listSources().sources.some((s) => s.id === "from_peer" || s.id === "shared_a"));
  assert.ok(rt.exportMcp().some((x) => x.id === "shared_a" && x.deleted));
  rt.removeSource("local_b", "测试");
});
