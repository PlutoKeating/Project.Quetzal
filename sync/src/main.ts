// 入口。TLS 由前面的 Caddy 终止，STUN / TURN 由 coturn 提供（见 compose.yaml）。
import { loadConfig } from "./config.ts";
import { createSyncServer } from "./server.ts";
import { VERSION } from "./app.ts";
import { log } from "./util.ts";

// 兜底：漏网的异常只记一行（不含请求内容）并继续服务——单条连接或单个请求的错误不该拖垮整个服务。
// 1 分钟内超过 10 次说明进程状态可能已经坏了，退出交给 Docker 重启（restart: unless-stopped）。
let crashes: number[] = [];
const fatal = (kind: string) => (e: unknown) => {
  log("main", `${kind}：${e instanceof Error ? e.message : String(e)}`);
  const t = Date.now();
  crashes = [...crashes.filter((x) => t - x < 60_000), t];
  if (crashes.length > 10) { log("main", "异常过于频繁，退出"); process.exit(1); }
};
process.on("uncaughtException", fatal("未捕获的异常"));
process.on("unhandledRejection", fatal("未处理的 Promise 拒绝"));

const cfg = loadConfig();
if (process.argv.includes("--check")) { console.log("配置正确"); process.exit(0); }

const s = createSyncServer(cfg);
await s.listen();
log("main", `Quetzal 同步服务 ${VERSION} 在 ${cfg.host}:${cfg.port} 监听，公开地址 ${cfg.publicUrl}`);
if (!s.github) log("main", "未配置 GitHub 登录（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）：网页无法登录，身体无法绑定");
if (!cfg.turn) log("main", "未配置 TURN_SECRET：只提供 STUN，打不通的身体之间无法中转");

const shutdown = () => {
  log("main", "收到退出信号，正在关闭");
  setTimeout(() => process.exit(0), 5000).unref();
  void s.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
