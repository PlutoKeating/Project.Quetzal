import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { StdioSource, toolName, type StdioServer } from "../src/mcp/client.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mcp-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, saveConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore, listAudit } = await import("../src/store.ts");
openStore();
const { parseServers, startMcp, closeMcp, launchFor } = await import("../src/mcp/runtime.ts");
const { allTools, callTool } = await import("../src/mind/tools.ts");
const { level, approvals, decide, emergencyStop, releaseStop } = await import("../src/guard/guard.ts");
after(async () => { await closeMcp(); (await import("../src/store.ts")).db.close(); fs.rmSync(home, { recursive: true, force: true }); });

// 只使用合成协议服务，不读取真实账号、网络或部署者数据。
const fixture = path.join(home, "server.mjs");
fs.writeFileSync(fixture, `import readline from 'node:readline';
const modern=process.argv[2]==='modern';
const send=(m,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
const tools=['echo','fail','slow','structured','image','huge','wrong'].map(name=>({name,inputSchema:{type:'object',properties:{text:{type:'string'}}},...(name==='wrong'?{outputSchema:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}}}}:{})}));
const complete=r=>modern?{resultType:'complete',...r}:r;
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='server/discover'){if(modern)send(m,{supportedVersions:['2026-07-28'],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'fixture',version:'1'}}});else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unknown'}})+'\\n');}
else if(m.method==='initialize')send(m,{protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}});
else if(m.method==='tools/list')send(m,complete({tools,...(modern?{ttlMs:0,cacheScope:'private'}:{})}));
else if(m.method==='tools/call'){const n=m.params.name;
if(n==='slow')setTimeout(()=>send(m,complete({content:[{type:'text',text:'late'}]})),600);
else if(n==='structured')send(m,complete({content:[],structuredContent:{value:7}}));
else if(n==='wrong')send(m,complete({content:[],structuredContent:{ok:'bad'}}));
else if(n==='image')send(m,complete({content:[{type:'image',mimeType:'image/png',data:'AA=='}]}));
else send(m,complete({content:[{type:'text',text:n==='huge'?'x'.repeat(2000):m.params.arguments.text==='env?'?process.env.MCP_TEST_UNRELATED_SECRET||'unset':m.params.arguments.text||'echo'}],isError:n==='fail'}));
}});`);
const server = (id = "fixture", mode = "legacy"): StdioServer => ({ id, enabled: true, command: process.execPath, args: [fixture, mode],
  cwd: home, sandbox: false, env: {}, secrets: {}, timeoutMs: 2000, maxResultChars: 1000 });
const source = async (mode: string) => {
  const s = server("fixture", mode), c = new StdioSource(s, { command: s.command, args: s.args, cwd: home, env: {} });
  await c.connect(); return c;
};

for (const mode of ["legacy", "modern"]) test(`官方 SDK stdio ${mode}：发现、结构化输出、失败、取消不关闭其他调用`, async () => {
  const c = await source(mode);
  try {
    assert.equal(c.list().length, 7);
    assert.equal(c.protocolVersion, mode === "modern" ? "2026-07-28" : "2025-11-25");
    assert.equal((await c.call("echo", { text: "hello" })).text, "hello");
    assert.equal((await c.call("echo", { text: 7 })).failed, true);
    assert.equal((await c.call("fail", {})).failed, true);
    assert.equal((await c.call("structured", {})).text, '{"value":7}');
    assert.equal((await c.call("image", {})).failed, true);
    assert.ok((await c.call("huge", {})).text.endsWith("（MCP 结果已截断）"));
    await assert.rejects(c.call("wrong", {}));
    const ac = new AbortController();
    const slow = c.call("slow", {}, ac.signal);
    setTimeout(() => ac.abort(new Error("合成取消")), 30);
    await assert.rejects(slow);
    assert.equal((await c.call("echo", { text: "still alive" })).text, "still alive");
    c.server.timeoutMs = 50;
    await assert.rejects(c.call("slow", {}));
    c.server.timeoutMs = 2000;
    assert.equal((await c.call("echo", {})).failed, false);
  } finally { await c.close(); }
  assert.deepEqual(c.list(), []);
});

test("esbuild CJS 产物能通过官方 SDK 实际发现与调用 stdio", async () => {
  const outfile = path.join(home, "client.cjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/mcp/client.ts", import.meta.url))], bundle: true,
    platform: "node", target: "node22", format: "cjs", outfile, logLevel: "silent" });
  const bundled = createRequire(import.meta.url)(outfile) as typeof import("../src/mcp/client.ts");
  const s = server();
  const c = new bundled.StdioSource(s, { command: s.command, args: s.args, cwd: home, env: {} });
  try {
    await c.connect();
    assert.equal(c.list().length, 7);
    assert.equal((await c.call("echo", { text: "bundled" })).text, "bundled");
  } finally { await c.close(); }
});

test("配置校验、稳定名称与凭据环境白名单", async () => {
  assert.equal(toolName("one", "search"), toolName("one", "search"));
  assert.notEqual(toolName("one", "search"), toolName("two", "search"));
  assert.notEqual(toolName("one", "search"), toolName("one", "SEARCH"));
  assert.ok(toolName("a".repeat(24), "x".repeat(128)).length <= 64);
  assert.throws(() => parseServers({ servers: [{ id: "bad", transport: "http", command: "node", args: [] }] }));
  assert.throws(() => parseServers({ servers: [{ id: "bad", transport: "stdio", command: process.execPath, args: [], secrets: { TOKEN: "../gateway.token" } }] }));
  process.env.MCP_TEST_UNRELATED_SECRET = "must-not-inherit";
  const launch = await launchFor(server());
  assert.equal(launch.env.MCP_TEST_UNRELATED_SECRET, undefined);
  const c = new StdioSource(server(), launch);
  await c.connect();
  try { assert.equal((await c.call("echo", { text: "env?" })).text, "unset"); }
  finally { await c.close(); }
  delete process.env.MCP_TEST_UNRELATED_SECRET;
});

test("默认沙箱不可用时不启动 MCP server", async () => {
  const { resetSandbox } = await import("../src/sandbox.ts");
  const previous = process.env.QUETZAL_SANDBOX;
  process.env.QUETZAL_SANDBOX = "none";
  resetSandbox();
  saveConfig({ sandbox: { allowUnsandboxed: false } });
  try { await assert.rejects(launchFor({ ...server(), sandbox: true })); }
  finally {
    if (previous === undefined) delete process.env.QUETZAL_SANDBOX; else process.env.QUETZAL_SANDBOX = previous;
    resetSandbox();
  }
});

test("生产工具注册经独立启动授权、ask/deny/STOP、结果脱敏及审计", async () => {
  assert.equal(level("mcp.unconfigured.tool"), "ask");
  assert.equal(level("mcp_start.unconfigured"), "ask");
  fs.writeFileSync(path.join(paths.config, "mcp.json"), JSON.stringify({ servers: [{ ...server(), transport: "stdio" }] }));
  saveConfig({ permissions: { mcp_start: "deny", mcp: "allow" } });
  await startMcp();
  assert.ok(!allTools().some((t) => t.name === toolName("fixture", "echo")));
  saveConfig({ permissions: { mcp_start: "ask", mcp: "ask" } });
  const starting = startMcp();
  await new Promise((r) => setImmediate(r));
  assert.equal(approvals().length, 1);
  assert.ok(!allTools().some((t) => t.name === toolName("fixture", "echo")));
  decide(approvals()[0].id, true, "test");
  await starting;
  await startMcp(); // 同一来源重复启动不注册第二份别名
  assert.equal(allTools().filter((t) => t.name === toolName("fixture", "echo")).length, 1);
  const tool = allTools().find((t) => t.name === toolName("fixture", "echo"));
  assert.ok(tool);
  const { adapter } = await import("../src/body/twin.ts");
  const previousTools = adapter.tools;
  adapter.tools = [{ name: tool.name, description: "合成冲突", parameters: { type: "object" }, permission: "memory", handler: async () => "不可误调用" }];
  try { assert.equal((await callTool(tool.name, {}, "合成名称冲突")).status, "error"); }
  finally { adapter.tools = previousTools; }
  const pending = callTool(tool.name, { text: "approved" }, "合成测试");
  await new Promise((r) => setImmediate(r));
  assert.equal(approvals().length, 1);
  decide(approvals()[0].id, true, "test");
  assert.equal((await pending).text, "approved");
  saveConfig({ permissions: { mcp: "deny" } });
  assert.equal((await callTool(tool.name, {}, "合成拒绝")).status, "denied");
  saveConfig({ permissions: { mcp: "allow" } });
  fs.writeFileSync(path.join(paths.secrets, "mcp_test"), "synthetic-secret-value");
  const result = await callTool(tool.name, { text: "synthetic-secret-value" }, "合成脱敏");
  assert.equal(result.status, "ok");
  assert.ok(!result.text.includes("synthetic-secret-value"));
  const slow = callTool(toolName("fixture", "slow"), {}, "合成在途急停");
  await new Promise((r) => setTimeout(r, 25));
  emergencyStop("test");
  assert.equal((await slow).status, "error");
  assert.equal((await callTool(tool.name, {}, "合成急停")).status, "denied");
  releaseStop("test");
  assert.ok(listAudit(20).some((a) => a.action === tool.name));
  await closeMcp();
});
