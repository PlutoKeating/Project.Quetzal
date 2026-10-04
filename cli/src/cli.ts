// npm 包 windler 的命令行入口：npx windler 安装或升级；其余子命令只做部署运维，agent 的一切配置都在控制台 App 里完成。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { layout, defaultHome, versionOf, rollback } from "./layout.ts";
import * as svc from "./service.ts";
import { health } from "./health.ts";
import { install, placeRelease, bundled, gatewayPort, gatewayHost } from "./install.ts";

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
const say = (s: string) => console.log(s);
process.stdout.on("error", () => {}); // 输出被管道提前关闭（如 | head）时不报错

const HELP = `windler ${pkg.version} —— 把 Windler 运行基座装到这台 Linux 机器上

用法：npx windler [命令] [选项]

命令（不给命令 = install）：
  install            安装或升级到包里内置的版本，注册 systemd 用户服务并启动；失败自动切回上一版
  run                前台运行（没有 systemd 时用；Ctrl-C 退出）
  status             版本、服务与健康状态
  logs [-f] [-n N]   服务日志（journald）；-f 持续输出
  start | stop | restart
  rollback           切回上一个版本并重启
  uninstall [--purge] 移除服务；--purge 连家目录（配置、记忆、对话）一起删除
  version            包与内置运行基座的版本

选项：
  --home DIR         家目录（默认 $WINDLER_HOME 或 ~/windler）
  --lan | --no-lan   网关对局域网开放（手机上的 App 直接连这台机器）/ 只监听本机（默认不改）
  --force            已是同一版本也重新安装

装好之后的一切（模型、身份、授权、飞书、灵魂仓库）都在 Windler App 里完成：连接新的 agent → 填这台机器的地址 → 申请配对码。
配对码会以桌面通知弹出；没有桌面的机器从 windler logs 里看。`;

function parse(argv: string[]) {
  const o: { cmd?: string; home: string; lan?: boolean; force: boolean; purge: boolean; follow: boolean; lines: number } =
    { home: defaultHome(), force: false, purge: false, follow: false, lines: 80 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") o.home = path.resolve(argv[++i] ?? "");
    else if (a === "--lan") o.lan = true;
    else if (a === "--no-lan") o.lan = false;
    else if (a === "--force") o.force = true;
    else if (a === "--purge") o.purge = true;
    else if (a === "-f" || a === "--follow") o.follow = true;
    else if (a === "-n") o.lines = Number(argv[++i]) || 80;
    else if (a === "-h" || a === "--help") o.cmd = "help";
    else if (a.startsWith("-")) throw new Error(`不认识的选项：${a}`);
    else if (!o.cmd) o.cmd = a;
    else throw new Error(`多余的参数：${a}`);
  }
  return o;
}

function requireNode() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) throw new Error(`需要 Node.js 22.13 以上（内置 node:sqlite），当前 ${process.versions.node}`);
  if (process.platform !== "linux") throw new Error("这个包只支持 Linux；其他系统请看 https://windler.plutokeating.beer");
}

async function status(home: string) {
  const l = layout(home);
  const h = await health(gatewayPort(l));
  say(`家目录    ${l.home}`);
  say(`版本      ${versionOf(l.current) ?? "（未安装）"}${versionOf(l.previous) ? `（上一版 ${versionOf(l.previous)}）` : ""}`);
  say(`服务      ${svc.isInstalled() ? ((await svc.isActive()) ? "运行中（systemd 用户服务 windler）" : "已安装，未运行") : "未安装"}`);
  say(`运行基座  ${h ? `${h.version} ${h.safeMode ? "安全模式" : h.mode}` : "没有响应"}`);
  const host = gatewayHost(l);
  say(`网关      ${host}:${gatewayPort(l)}${host === "127.0.0.1" ? "（只监听本机；要让手机上的 App 直接连，执行 windler install --lan，或建 ssh 隧道）" : "（局域网可达）"}`);
}

/** 前台运行 current 版本：没有 systemd 的机器用，或者调试。 */
async function runForeground(home: string) {
  const l = layout(home);
  placeRelease(l);
  const child = spawn(process.execPath, ["--enable-source-maps", path.join(l.current, "main.cjs")], {
    cwd: l.current, stdio: "inherit", env: { ...process.env, WINDLER_HOME: l.home, WINDLER_ADAPTER: path.join(l.current, "linux.mjs") },
  });
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => child.kill(s));
  return new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)));
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o.cmd ?? "install";
  if (cmd === "help") return say(HELP);
  if (cmd === "version") return say(`windler ${pkg.version}（内置运行基座 ${bundled().version}）`);
  requireNode();
  const l = layout(o.home);
  switch (cmd) {
    case "install": await install({ home: o.home, lan: o.lan, force: o.force }, say); say(""); return status(o.home);
    case "run": process.exitCode = await runForeground(o.home); return;
    case "status": return status(o.home);
    case "logs": process.exitCode = await svc.logs(o.lines, o.follow); return;
    case "start": await svc.start(); return status(o.home);
    case "stop": await svc.stop(); return say("已停止");
    case "restart": await svc.restart(); return status(o.home);
    case "rollback": {
      const v = rollback(l);
      if (!v) throw new Error("没有可回滚的版本");
      if (svc.isInstalled()) await svc.restart();
      say(`已切回 ${v}`); return status(o.home);
    }
    case "uninstall": {
      if (svc.isInstalled()) await svc.uninstall();
      say("已移除 systemd 用户服务");
      if (o.purge) { fs.rmSync(l.home, { recursive: true, force: true }); say(`已删除家目录 ${l.home}（配置、记忆、对话都没有了；灵魂仓库里的内容仍在远端）`); }
      else say(`家目录 ${l.home} 保留（配置、记忆、对话）；要一起删除请加 --purge`);
      return;
    }
    default: throw new Error(`不认识的命令：${cmd}\n\n${HELP}`);
  }
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
