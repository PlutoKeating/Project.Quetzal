// 冒烟测试用：连上本机运行基座的网关（令牌读家目录的 secrets\gateway.token），取 status，等沙箱就绪，再让 ta 的命令真的在沙箱里跑一条。
// 用法：node windows-status.mjs <期望的版本>
import fs from "node:fs";
import path from "node:path";

const want = process.argv[2] ?? "";
const home = path.join(process.env.LOCALAPPDATA, "Quetzal", "home");
const token = fs.readFileSync(path.join(home, "secrets", "gateway.token"), "utf8").trim();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:7788/rpc");
    const t = setTimeout(() => { ws.close(); reject(new Error(`${method} 超时`)); }, 120_000);
    ws.onopen = () => ws.send(JSON.stringify({ auth: token }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.event === "hello") ws.send(JSON.stringify({ id: 1, method, params }));
      else if (m.id === 1) { clearTimeout(t); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error("连不上网关")); };
  });
}

let st;
for (let i = 0; i < 40; i++) {
  st = await rpc("status");
  if (st.sandbox?.kind !== "none" || !/正在准备/.test(st.sandbox?.note ?? "")) break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(JSON.stringify({ version: st.version, body: st.body, adapter: st.adapter, sandbox: st.sandbox }, null, 2));
let bad = 0;
if (want && st.version !== want) { console.error(`版本不对：${st.version}，期望 ${want}`); bad++; }
if (st.adapter !== "windows" && st.adapter?.name !== "windows") { console.error(`适配器不是 windows：${JSON.stringify(st.adapter)}`); bad++; }
if (st.sandbox?.kind !== "srt") { console.error(`沙箱没就绪：${st.sandbox?.kind}（${st.sandbox?.note}）`); bad++; }
process.exit(bad ? 1 : 0);
