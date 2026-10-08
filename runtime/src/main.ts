// 运行基座入口：装配各模块。进程由外部守护者（runit、systemd……）负责拉起；本进程只负责熔断。
import fs from "node:fs";
import path from "node:path";
import { loadConfig, config, paths } from "./config.ts";
import { openStore, addTimeline, addMessage, ensureSession } from "./store.ts";
import { loadAdapter, startSenses, sample, adapter } from "./body/twin.ts";
import { startHeart, isFollower, nudge } from "./heart/heart.ts";
import { startReminders, when } from "./time/reminders.ts";
import { backfillChat } from "./memory/index.ts";
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
import { startMesh, wireMesh, registerSoulLink, meshStatus } from "./mesh/runtime.ts";
import { soulLink } from "./ops.ts";

/** 持心跳的身体还是 1.3.0 以前的版本（不认识提醒）：跟随者自己负责触发，免得一条也不响（几具新版本的跟随者可能各响一次；都升级后恢复只由持心跳的那具触发）。 */
function coordinatorLacksReminders(): boolean {
  try {
    const m = meshStatus() as { coordinator?: string; peers?: { body: string; version?: string }[] };
    const v = m.peers?.find((p) => p.body === m.coordinator)?.version;
    if (!v) return false;
    const [a, b] = v.split(".").map(Number);
    return a < 1 || (a === 1 && b < 3);
  } catch { return false; }
}

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
  // 同步抛出没人接的异常：进程状态已不可信，记下来以非零退出，由守护者（runit、systemd）重新拉起。
  // 网状层里由对方触发的回调都自己接住异常（见 mesh/mesh.ts、mesh/link.ts），不会走到这里。退出推迟一轮事件循环（不在原生回调里直接退出）
  process.on("uncaughtException", (e: any) => {
    log("main", `未接住的异常，进程退出：${e?.stack ?? e}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100);
  });

  await loadAdapter(config.adapter || process.env.QUETZAL_ADAPTER);
  startGateway(safeMode);
  wireFeishu();
  await startFeishu();
  bus.on("say", (text, to) => { // 主动消息：醒来时的 send_message 带着会话（她选的或新开的）；基座自己发的（提醒、安全模式）进「主动消息」会话
    const conv = to?.conv || "inbox";
    ensureSession(conv, to?.title || "主动消息", "主动");
    addMessage("agent", "主动", text, { session: conv });
    void adapter.notify?.(displayName(), text).catch(() => {});
  });
  // 提醒：答应了对方的事必须准点——不经模型，到点直接把她写好的话发出去（主动消息：控制台、飞书、系统通知），再轻轻告诉她。
  //   安全模式下也照常（不需要模型）；多具身体时只有持心跳的那具身体触发。
  startReminders(async (r, late, why) => {
    const tail = late > 120_000 ? `（原定 ${when(r.at + (r.span ?? 0), r.tz)}，晚了 ${Math.round(late / 60_000)} 分钟）` : why ? `（${why}）` : "";
    bus.emit("say", `${r.text}${r.step ? `——先做：${r.step}` : ""}${tail}`);
    addTimeline("reminder", `到点提醒了对方：${r.text}`, { id: r.id, late });
    nudge(`到点提醒了对方：${r.text}`, { social: 0.05 });
  }, () => !isFollower() || coordinatorLacksReminders(), 30_000);
  bus.on("reminders.missed", (r, late) => {
    bus.emit("say", `抱歉，错过了一个提醒：${r.text}（原定 ${when(r.at, config.timezone)}，那时我这边没在运行）`);
    addTimeline("reminder", `错过了提醒：${r.text}（晚了 ${Math.round(late / 3_600_000)} 小时）`, { id: r.id, late, missed: true });
  });
  backfillChat(); // 历史对话在后台补进检索索引

  if (safeMode) {
    addTimeline("safe", "反复崩溃，进入安全模式");
    bus.emit("say", "我好像反复崩溃了，现在处于安全模式。请看看日志，或者回滚版本。");
    return;
  }
  await ensureSoul().catch((e) => log("soul", `灵魂目录初始化失败：${e.message}`));
  wireMesh();
  registerSoulLink(soulLink); // 一个链接接入：绑定时带部署公钥，批准后采用链接好的灵魂仓库
  await startMesh().catch((e) => log("mesh", `网状层启动失败：${e.message}`)); // 没有绑定或缺组件时只是不启动，身体之间仍用 git 同步
  await sample().catch(() => {});
  addTimeline("boot", "苏醒：进程启动", { version: VERSION, body: config.body });
  ensureCatalogFresh(); // 模型目录缺少「能否看图」等信息时后台刷新（路由据此把图片只发给能看图的模型）
  startHeart(wake);
  startSenses();
}

main().catch((e) => { log("main", `启动失败：${e.stack ?? e}`); process.exit(1); });
