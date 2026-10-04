// 安装与升级：把包里内置的运行基座放进 releases/<版本>/ → 切换 current → 写入缺省配置 → systemd 用户服务 → 健康检查，失败切回上一版。
// 步骤与 Android 安装器（console/assets/install/install.sh）一一对应，只是守护者从 runit 换成 systemd。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Layout, layout, versionOf, putRelease, switchTo, rollback, prune, readConfig, patchConfig, defaultBody } from "./layout.ts";
import * as svc from "./service.ts";
import { waitHealthy } from "./health.ts";

export type Say = (line: string) => void;
export interface Options { home: string; lan?: boolean; force?: boolean }

/** 包里内置的运行基座（tool/bundle-runtime.sh 放进 dist/runtime/）。 */
export function bundled() {
  const dir = fileURLToPath(new URL("./runtime/", import.meta.url));
  const version = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
  return { dir, version, files: ["main.cjs", "linux.mjs"].map((name) => ({ name, from: path.join(dir, name) })) };
}

export const gatewayPort = (l: Layout) => Number(readConfig(l).gateway?.port) || 7788;
export const gatewayHost = (l: Layout) => String(readConfig(l).gateway?.host || "127.0.0.1");

/** 把内置版本放进家目录并切换 current（服务不动）。返回 {version, changed, before}。 */
export function placeRelease(l: Layout, force = false) {
  const b = bundled();
  const before = versionOf(l.current);
  if (before === b.version && !force) return { version: b.version, changed: false, before };
  const dir = putRelease(l, b.version, b.files);
  const size = fs.statSync(path.join(dir, "main.cjs")).size;
  if (size < 100_000) throw new Error("运行基座文件不完整");
  switchTo(l, dir);
  return { version: b.version, changed: true, before };
}

/** 缺省配置：身体名字（主机名）只在没有时写入；gateway.host 按 --lan / --no-lan 设置；其余由控制台管理。 */
export function writeDefaults(l: Layout, lan?: boolean) {
  return patchConfig(l, (c) => {
    if (!c.body || c.body === "default") c.body = defaultBody();
    if (lan != null) c.gateway = { ...(c.gateway ?? {}), host: lan ? "0.0.0.0" : "127.0.0.1" };
  });
}

export async function install(o: Options, say: Say): Promise<void> {
  const l = layout(o.home);
  fs.mkdirSync(l.releases, { recursive: true });
  const { version, changed, before } = placeRelease(l, o.force);
  say(!changed ? `运行基座 ${version} 已是内置版本` : before === version ? `重新安装 ${version}` : before ? `升级：${before} → ${version}` : `安装运行基座 ${version}`);
  writeDefaults(l, o.lan);

  if (!(await svc.available())) {
    say("没有可用的 systemd 用户实例（容器或未开启 systemd 的 WSL）：已放好文件，请用 `windler run` 前台运行，并交给你自己的进程守护者。");
    return;
  }
  await svc.install({ home: l.home, node: process.execPath });
  const linger = await svc.enableLinger();
  await svc.restart();
  say("服务已启动，等待运行基座响应…");
  const h = await waitHealthy(gatewayPort(l), version);
  if (!h) {
    const back = rollback(l);
    if (back) { await svc.restart().catch(() => {}); throw new Error(`新版本 40 秒内没有响应，已切回 ${back}。日志：windler logs`); }
    throw new Error("运行基座 40 秒内没有响应。日志：windler logs");
  }
  say(`运行基座 ${h.version} 正常${h.safeMode ? "（安全模式：反复崩溃，请看日志）" : ""}。`);
  const removed = prune(l);
  if (removed.length) say(`清理旧版本：${removed.join("、")}`);
  if (!linger) say("提示：loginctl enable-linger 未成功，这个用户没有登录会话时服务不会运行；服务器上可手动执行 `sudo loginctl enable-linger $USER`。");
}
