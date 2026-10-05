// 网状层的原生组件（node-datachannel）：按包里内置的锁定文件下载并核对 sha512，装进 <家目录>/mesh-modules/<版本>/（各版本共用），
// 当前版本目录的 node_modules 是指过去的相对软链接（家目录整体搬迁也不断）。失败不影响安装：只是暂时没有网状层，身体之间仍用 git 同步。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Layout } from "./layout.ts";

/** 这台机器对应的原生包平台：linux-<x64|arm64>-<gnu|musl>；不支持的返回 undefined。 */
export function meshPlatform(): string | undefined {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return undefined;
  const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  return `linux-${process.arch}-${glibc ? "gnu" : "musl"}`;
}

export async function installMeshModules(l: Layout, bundledDir: string, releaseDir: string, say: (s: string) => void): Promise<boolean> {
  const lockFile = path.join(bundledDir, "mesh-modules.lock.json"), script = path.join(bundledDir, "install-mesh-modules.mjs");
  if (!fs.existsSync(lockFile) || !fs.existsSync(script)) return false;
  const platform = meshPlatform();
  if (!platform) { say(`这台机器（${process.platform}-${process.arch}）没有网状层组件的预编译包：身体之间只用 git 同步`); return false; }
  const version = JSON.parse(fs.readFileSync(lockFile, "utf8")).common["node-datachannel"].version as string;
  const shared = path.join(l.home, "mesh-modules", version);
  const ready = () => fs.existsSync(path.join(shared, "node_modules", "node-datachannel", "package.json"));
  if (!ready()) {
    say("下载多具身体直连的组件（约 4 MB，逐个核对校验值）…");
    fs.mkdirSync(shared, { recursive: true });
    const code = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, [script, lockFile, shared, platform, "https://registry.npmjs.org", "https://registry.npmmirror.com"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; p.stderr.on("data", (d) => (err += d));
      p.on("close", (c) => { if (c) say(`组件没有装上（不影响使用，下次运行安装再试）：${err.trim().split("\n").pop()}`); resolve(c ?? 1); });
    });
    if (code !== 0 || !ready()) return false;
  }
  const link = path.join(releaseDir, "node_modules");
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(path.relative(releaseDir, path.join(shared, "node_modules")), link);
  // 只保留最近 2 个版本的组件
  const dirs = fs.readdirSync(path.join(l.home, "mesh-modules")).map((n) => ({ n, t: fs.statSync(path.join(l.home, "mesh-modules", n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const d of dirs.slice(2)) fs.rmSync(path.join(l.home, "mesh-modules", d.n), { recursive: true, force: true });
  return true;
}
