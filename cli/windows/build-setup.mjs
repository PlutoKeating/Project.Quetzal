#!/usr/bin/env node
// 构建 Windows 安装包 quetzal-<版本>-windows-<x64|arm64>-setup.exe：把各部分放进暂存目录，再调用 makensis 编译 setup/quetzal.nsi。只用 Node 内置模块。
// 用法：node build-setup.mjs --version V --arch x64|arm64 --runtime <runtime/dist> --srt-win <srt-win.exe> --mesh <含 node_modules 的目录>
//         --web <网页控制台目录> --cli <quetzal.mjs> --console <解开的 Windows 控制台目录> --deps <fetch-deps.mjs 下载的目录>
//         --makensis <makensis 可执行文件> --out <输出目录> [--icon <.ico>] [--stage <暂存目录>] [--no-compile]
// 暂存目录的布局就是装到 %LOCALAPPDATA%\Quetzal 下的布局（docs/WINDOWS_DECISIONS.md 4.1）：
//   runtime\  main.cjs windows.mjs windows-body.mjs windows-supervise.mjs srt.mjs quetzal.mjs VERSION web\ srt-win\srt-win.exe node_modules\
//   console\  quetzal-console.exe 与 Flutter 的 dll、data\
//   bin\      quetzal.cmd quetzal-supervise.ps1     setup\  quetzal-setup.ps1 quetzal-machine.ps1
//   deps\     node.msi git.exe python.exe deps.json（文件名固定，deps.json 带锁定的 SHA-256，机器级步骤安装前再核对一次）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLock, entries, verified } from "./fetch-deps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_FILES = ["main.cjs", "windows.mjs", "windows-body.mjs", "windows-supervise.mjs", "srt.mjs", "mermaid.mjs"];
const DEP_NAMES = { node: "node.msi", git: "git.exe", python: "python.exe" };

/** 版本号 → VIProductVersion 要的四段数字（预发布后缀去掉）。 */
export function viVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
  if (!m) throw new Error(`版本号不对：${v}`);
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}

export const setupName = (version, arch) => `quetzal-${version}-windows-${arch}-setup.exe`;

/** 控制台压缩包解开后可能多一层顶层目录（quetzal-console\）：找到 quetzal-console.exe 所在的目录。 */
export function consoleRoot(dir) {
  if (fs.existsSync(path.join(dir, "quetzal-console.exe"))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (subs.length === 1 && fs.existsSync(path.join(dir, subs[0].name, "quetzal-console.exe"))) return path.join(dir, subs[0].name);
  throw new Error(`${dir} 里没有 quetzal-console.exe`);
}

function parse(argv) {
  const o = { compile: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-compile") { o.compile = false; continue; }
    if (!a.startsWith("--")) throw new Error(`多余的参数：${a}`);
    o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  for (const k of ["version", "arch", "runtime", "srtWin", "mesh", "web", "cli", "console", "deps", "out"]) if (!o[k]) throw new Error(`缺少 --${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
  if (o.compile && !o.makensis) throw new Error("缺少 --makensis（或用 --no-compile 只暂存）");
  if (!["x64", "arm64"].includes(o.arch)) throw new Error(`不认识的架构：${o.arch}`);
  viVersion(o.version);
  return o;
}

const need = (p, what) => { if (!fs.existsSync(p)) throw new Error(`缺少${what}：${p}`); return p; };

export function stage(o) {
  const st = path.resolve(o.stage ?? path.join(o.out, `stage-${o.arch}`));
  fs.rmSync(st, { recursive: true, force: true });
  const rt = path.join(st, "runtime");
  fs.mkdirSync(path.join(rt, "srt-win"), { recursive: true });
  for (const f of RUNTIME_FILES) fs.copyFileSync(need(path.join(o.runtime, f), "运行基座文件"), path.join(rt, f));
  fs.copyFileSync(need(o.cli, "命令行 quetzal.mjs"), path.join(rt, "quetzal.mjs"));
  fs.writeFileSync(path.join(rt, "VERSION"), o.version);
  fs.copyFileSync(need(o.srtWin, "srt-win.exe"), path.join(rt, "srt-win", "srt-win.exe"));
  fs.cpSync(need(path.join(o.web, "index.html"), "网页控制台") && o.web, path.join(rt, "web"), { recursive: true });
  fs.cpSync(need(path.join(o.mesh, "node_modules", "node-datachannel", "package.json"), "网状层原生组件") && path.join(o.mesh, "node_modules"), path.join(rt, "node_modules"), { recursive: true });
  fs.cpSync(consoleRoot(need(o.console, "Windows 控制台")), path.join(st, "console"), { recursive: true });
  fs.mkdirSync(path.join(st, "bin")); fs.mkdirSync(path.join(st, "setup")); fs.mkdirSync(path.join(st, "deps"));
  for (const f of ["quetzal.cmd", "quetzal-supervise.ps1"]) fs.copyFileSync(path.join(here, "setup", f), path.join(st, "bin", f));
  for (const f of ["quetzal-setup.ps1", "quetzal-machine.ps1"]) fs.copyFileSync(path.join(here, "setup", f), path.join(st, "setup", f));
  const lock = readLock(), manifest = {};
  for (const e of entries(lock, "embedded", o.arch)) {
    const from = path.join(o.deps, e.file);
    if (!verified(from, e)) throw new Error(`${from} 不存在或与锁定的 SHA-256 不符（先运行 fetch-deps.mjs ${o.arch}）`);
    fs.copyFileSync(from, path.join(st, "deps", DEP_NAMES[e.key]));
    manifest[e.key] = { file: DEP_NAMES[e.key], version: e.version, sha256: e.sha256, source: e.url };
  }
  fs.writeFileSync(path.join(st, "deps", "deps.json"), JSON.stringify(manifest, null, 2));
  return st;
}

function main() {
  const o = parse(process.argv.slice(2));
  const st = stage(o);
  console.log(`已暂存：${st}`);
  if (!o.compile) return;
  fs.mkdirSync(o.out, { recursive: true });
  const outFile = path.resolve(o.out, setupName(o.version, o.arch));
  const defs = [`-DVERSION=${o.version}`, `-DVIVERSION=${viVersion(o.version)}`, `-DARCH=${o.arch}`, `-DSTAGE=${st}`, `-DOUTFILE=${outFile}`];
  if (o.icon) defs.push(`-DICON=${path.resolve(need(o.icon, "图标"))}`);
  // makensis 在 Windows 上接受 / 与 - 两种开关前缀，Linux 版只认 -
  const r = spawnSync(o.makensis, ["-V3", "-INPUTCHARSET", "UTF8", ...defs, path.join(here, "setup", "quetzal.nsi")], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`makensis 失败（${r.status ?? r.error?.message}）`);
  console.log(`安装包：${outFile}（${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
