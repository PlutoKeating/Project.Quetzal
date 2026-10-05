// 运行基座入口：装配各模块。进程由外部守护者（runit、systemd……）负责拉起；本进程只负责熔断。
import fs from "node:fs";
import path from "node:path";
import { loadConfig, config, paths } from "./config.ts";
import { openStore, addTimeline, addMessage, ensureSession } from "./store.ts";
import { loadAdapter, startSenses, sample, adapter } from "./body/twin.ts";
import { startHeart } from "./heart/heart.ts";
import { wake } from "./mind/brain.ts";
import { ensureSoul } from "./memory/soul-sync.ts";
import { displayName } from "./memory/identity.ts";
import { startGateway } from "./gateway.ts";
import { ensureCatalogFresh } from "./providers/catalog.ts";
import { startFeishu, wireFeishu } from "./channels/feishu.ts";
import { bus } from "./bus.ts";
import { log } from "./log.ts";
import { VERSION } from "./version.ts";
import { restore as restoreAgents } from "./mind/agents.ts";
import { startMesh, wireMesh } from "./mesh/runtime.ts";

/** 熔断：10 分钟内启动超过 5 次（说明在反复崩溃）则进入安全模式——只开网关与飞书，不醒来、不调用模型。 */
function crashGuard(): boolean {
  const f = path.join(paths.state, "starts.json");
  let starts: number[] = [];
  try { starts = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  const now = Date.now();
  starts = [...starts.filter((t) => now - t < 10 * 60_000), now];
  fs.writeFileSync(f, JSON.stringify(starts));
  return starts.length > 5;
}

async function main() {
  loadConfig();
  openStore();
  restoreAgents(); // 上次还在跑的子 agent 已随进程消失，标为中断
  const safeMode = crashGuard();
  log("main", `运行基座 ${VERSION} 启动（身体：${config.body}，家目录：${paths.home}）${safeMode ? " —— 安全模式" : ""}`);
  process.on("unhandledRejection", (e: any) => log("main", `未处理的异常：${e?.stack ?? e}`));

  await loadAdapter(config.adapter || process.env.QUETZAL_ADAPTER);
  startGateway(safeMode);
  wireFeishu();
  await startFeishu();
  bus.on("say", (text) => { ensureSession("inbox", "主动消息", "主动"); addMessage("agent", "主动", text, { session: "inbox" }); void adapter.notify?.(displayName(), text).catch(() => {}); });

  if (safeMode) {
    addTimeline("safe", "反复崩溃，进入安全模式");
    bus.emit("say", "我好像反复崩溃了，现在处于安全模式。请看看日志，或者回滚版本。");
    return;
  }
  await ensureSoul().catch((e) => log("soul", `灵魂目录初始化失败：${e.message}`));
  wireMesh();
  await startMesh().catch((e) => log("mesh", `网状层启动失败：${e.message}`)); // 没有绑定或缺组件时只是不启动，身体之间仍用 git 同步
  await sample().catch(() => {});
  addTimeline("boot", "苏醒：进程启动", { version: VERSION, body: config.body });
  ensureCatalogFresh(); // 模型目录缺少「能否看图」等信息时后台刷新（路由据此把图片只发给能看图的模型）
  startHeart(wake);
  startSenses();
}

main().catch((e) => { log("main", `启动失败：${e.stack ?? e}`); process.exit(1); });
