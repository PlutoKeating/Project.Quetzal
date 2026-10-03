// 她自己造的工具：把做过多次、步骤稳定的流程沉淀为可直接调用的工具。
//   实现只在这具身体上：WINDLER_HOME/tools/<名>/tool.json（名字、描述、参数 JSON Schema、能力类别、超时、依赖）+ tool.sh 或 tool.mjs。
//   意图随灵魂同步：灵魂仓库 skills/<名>/SKILL.md，采用 Agent Skills 开放标准（YAML 头 name / description，正文自由）。
//   其他身体（运行基座、Hermes、OpenClaw……）读到技能文档后，可以按文档在自己那里实现；本机有文档没实现时，系统提示会提醒她。
//   热加载：每次组装工具表时按目录 mtime 重读，不用重启；缺依赖（requires 里的命令不存在）的工具不挂进工具表，只在提示里说明。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { paths } from "../config.ts";
import { PERMISSION_LABELS } from "../guard/guard.ts";
import { run } from "../sh.ts";

export interface ToolManifest {
  name: string; description: string; parameters: Record<string, unknown>;
  permission: string; runtime: "sh" | "node"; timeout: number; requires: string[]; enabled: boolean; updatedAt: string;
}
export interface CustomToolInfo extends ToolManifest { missing: string[]; hasSkill: boolean; skillSummary: string }
export interface SkillInfo { name: string; description: string; implemented: boolean }

export const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_FILE = 1 << 20;
const MAX_TIMEOUT = 600;
export const SKILL_SPEC_URL = "https://agentskills.io/specification";

const toolDir = (name: string) => path.join(paths.tools, name);
const manifestFile = (name: string) => path.join(toolDir(name), "tool.json");
const sourceFile = (name: string, runtime: "sh" | "node") => path.join(toolDir(name), runtime === "sh" ? "tool.sh" : "tool.mjs");
/** 技能目录名：规范只允许小写字母、数字与连字符，工具名里的下划线换成连字符。 */
export const skillName = (name: string) => name.replace(/_/g, "-");
const skillFile = (name: string) => path.join(paths.soul, "skills", skillName(name), "SKILL.md");

// ---------- 读取

function readManifest(name: string): ToolManifest | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(name), "utf8"));
    if (!NAME_RE.test(m.name) || m.name !== name) return undefined;
    return { timeout: 60, requires: [], enabled: true, permission: "shell", runtime: "sh", updatedAt: "", ...m };
  } catch { return undefined; }
}

export function listManifests(): ToolManifest[] {
  let names: string[] = [];
  try { names = fs.readdirSync(paths.tools); } catch { return []; }
  return names.sort().map(readManifest).filter((m): m is ToolManifest => !!m);
}

// 依赖检查结果缓存：命令是否存在（装了新软件后下一次 tool_write / 重启会重查；这里每 5 分钟过期）
const which = new Map<string, { ok: boolean; at: number }>();
export function missingRequires(req: string[]): string[] {
  const out: string[] = [];
  for (const r of req) {
    const c = which.get(r);
    if (c && Date.now() - c.at < 300_000) { if (!c.ok) out.push(r); continue; }
    const ok = (process.env.PATH ?? "").split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, r), fs.constants.X_OK); return true; } catch { return false; } });
    which.set(r, { ok, at: Date.now() });
    if (!ok) out.push(r);
  }
  return out;
}
export const forgetRequires = () => which.clear();

/** 技能文档的 YAML 头（只取 name / description，正文原样）。 */
export function parseSkill(text: string): { name: string; description: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: "", description: "", body: text };
  const head: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([a-zA-Z-]+):\s*(.*)$/); if (k) head[k[1]] = k[2].trim().replace(/^["'](.*)["']$/, "$1"); }
  return { name: head.name ?? "", description: head.description ?? "", body: m[2] };
}

export function readSkill(name: string): string { try { return fs.readFileSync(skillFile(name), "utf8"); } catch { return ""; } }

/** 灵魂仓库里的全部技能（含其他身体写的），标出本机有没有实现。 */
export function listSkills(): SkillInfo[] {
  const dir = path.join(paths.soul, "skills");
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "SKILL.md"))); } catch { return []; }
  const local = new Set(listManifests().map((m) => skillName(m.name)));
  return names.sort().map((d) => {
    const s = parseSkill(fs.readFileSync(path.join(dir, d, "SKILL.md"), "utf8"));
    return { name: s.name || d, description: s.description, implemented: local.has(d) };
  });
}

export function listCustomTools(): CustomToolInfo[] {
  return listManifests().map((m) => {
    const skill = readSkill(m.name);
    return { ...m, missing: missingRequires(m.requires), hasSkill: !!skill, skillSummary: skill ? parseSkill(skill).description : "" };
  });
}

export function readTool(name: string): { manifest: ToolManifest; source: string; skill: string } | undefined {
  const manifest = readManifest(name);
  if (!manifest) return undefined;
  let source = "";
  try { source = fs.readFileSync(sourceFile(name, manifest.runtime), "utf8"); } catch {}
  return { manifest, source, skill: readSkill(name) };
}

// ---------- 写入与删除

export interface ToolSpec {
  name: string; description: string; parameters?: Record<string, unknown>; permission?: string;
  runtime: "sh" | "node"; source: string; timeout?: number; requires?: string[]; skill?: string; enabled?: boolean;
}

function checkSchema(p: unknown): Record<string, unknown> {
  if (p == null) return { type: "object", properties: {} };
  if (typeof p !== "object" || Array.isArray(p)) throw new Error("parameters 必须是 JSON Schema 的 object");
  const o = p as Record<string, unknown>;
  if (o.type !== undefined && o.type !== "object") throw new Error("parameters.type 必须是 object");
  if (o.properties !== undefined && (typeof o.properties !== "object" || Array.isArray(o.properties))) throw new Error("parameters.properties 必须是对象");
  return { ...o, type: "object", properties: o.properties ?? {} };
}

async function checkSyntax(runtime: "sh" | "node", file: string) {
  const r = runtime === "sh" ? await run("sh", ["-n", file], 10_000) : await run(process.execPath, ["--check", file], 15_000);
  if (r.code !== 0) throw new Error(`语法检查没通过：${(r.err || r.out).trim().slice(0, 400)}`);
}

/** 新建或改写一个工具（整体替换；没给的字段用原值）。返回给她看的说明。 */
export async function writeTool(spec: ToolSpec, reserved: Set<string>): Promise<string> {
  const name = String(spec.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new Error("name 只能用小写字母、数字、下划线、连字符，以字母开头，最长 40 个字符");
  if (reserved.has(name)) throw new Error(`「${name}」是内置工具的名字，换一个`);
  const prev = readManifest(name);
  const runtime = spec.runtime ?? prev?.runtime;
  if (runtime !== "sh" && runtime !== "node") throw new Error("runtime 必须是 sh 或 node");
  const source = spec.source ?? (prev ? (readTool(name)?.source ?? "") : "");
  if (!source.trim()) throw new Error("source 不能为空");
  if (Buffer.byteLength(source) > MAX_FILE) throw new Error("source 不能超过 1 MiB");
  if (source.includes("\0")) throw new Error("source 必须是文本");
  const description = String(spec.description ?? prev?.description ?? "").trim();
  if (!description) throw new Error("description 不能为空");
  const permission = String(spec.permission ?? prev?.permission ?? "shell");
  if (!(permission in PERMISSION_LABELS)) throw new Error(`permission 必须是：${Object.keys(PERMISSION_LABELS).join("、")}`);
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT, Number(spec.timeout ?? prev?.timeout ?? 60) || 60));
  const requires = (Array.isArray(spec.requires) ? spec.requires : prev?.requires ?? []).map(String).filter((x) => /^[\w.+-]+$/.test(x));
  const parameters = checkSchema(spec.parameters ?? prev?.parameters);
  const skill = typeof spec.skill === "string" ? spec.skill : "";
  if (!prev && !skill.trim()) throw new Error("新工具必须同时写技能文档 skill（意图说明，Markdown：用途、参数、实现思路、依赖、怎么验证），它会随灵魂同步到其他身体");

  const dir = toolDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = sourceFile(name, runtime);
  fs.writeFileSync(file, source.endsWith("\n") ? source : source + "\n", { mode: 0o700 });
  try { await checkSyntax(runtime, file); } catch (e) { if (!prev) fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  if (prev && prev.runtime !== runtime) fs.rmSync(sourceFile(name, prev.runtime), { force: true });
  const manifest: ToolManifest = { name, description, parameters, permission, runtime, timeout, requires, enabled: spec.enabled ?? prev?.enabled ?? true, updatedAt: new Date().toISOString() };
  fs.writeFileSync(manifestFile(name), JSON.stringify(manifest, null, 2) + "\n");
  if (skill.trim()) writeSkill(name, description, skill, requires);
  forgetRequires();
  const missing = missingRequires(requires);
  return `${prev ? "已更新" : "已创建"}工具 ${name}（${runtime}，${PERMISSION_LABELS[permission]}，超时 ${timeout} 秒）${skill.trim() ? "，技能文档已写入灵魂仓库" : ""}${missing.length ? `。注意：本机缺少 ${missing.join("、")}，装好前它不会出现在工具表里` : "。现在就可以调用它"}`;
}

/** 技能文档：Agent Skills 规范的 SKILL.md。她给的正文如果已带 YAML 头，以她的为准（只校正 name）。 */
export function writeSkill(name: string, description: string, body: string, requires: string[] = []) {
  const f = skillFile(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const parsed = parseSkill(body);
  const text = parsed.name || parsed.description ? body.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, head: string) => `---\n${head.replace(/^name:.*$/m, `name: ${skillName(name)}`)}\n---`) : [
    "---", `name: ${skillName(name)}`, `description: ${description.replace(/\s+/g, " ").slice(0, 1000)}`,
    ...(requires.length ? [`compatibility: 需要命令 ${requires.join("、")}`] : []),
    "metadata:", "  windler-tool: " + name, ...(requires.length ? [`  windler-requires: ${requires.join(",")}`] : []),
    "---", "", body.trim(), "",
  ].join("\n");
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error("技能文档不能超过 1 MiB");
  fs.writeFileSync(f, text);
}

export function deleteTool(name: string, alsoSkill = false): string {
  if (!NAME_RE.test(name)) throw new Error("没有这个工具");
  const had = fs.existsSync(toolDir(name));
  fs.rmSync(toolDir(name), { recursive: true, force: true });
  let s = had ? `已删除工具 ${name} 的实现` : `本机没有工具 ${name} 的实现`;
  if (alsoSkill) { const f = skillFile(name); const hadSkill = fs.existsSync(f); fs.rmSync(path.dirname(f), { recursive: true, force: true }); s += hadSkill ? "，技能文档也已从灵魂仓库删除（历史里仍可找回）" : ""; }
  else if (readSkill(name)) s += "；技能文档保留在灵魂仓库里（其他身体仍可按它实现；想一并删除传 skill=true）";
  return s;
}

export function setToolEnabled(name: string, enabled: boolean): boolean {
  const m = readManifest(name);
  if (!m) return false;
  fs.writeFileSync(manifestFile(name), JSON.stringify({ ...m, enabled }, null, 2) + "\n");
  return true;
}

// ---------- 执行

/** 运行一个工具。sh：参数以 JSON 写入 stdin，并展开为环境变量 ARG_<名>（非字符串值为 JSON）；node：默认导出 async (args) => string。 */
export async function runTool(m: ToolManifest, args: Record<string, any>): Promise<string> {
  const dir = toolDir(m.name);
  if (m.runtime === "node") {
    const file = sourceFile(m.name, "node");
    const mod = await import(`file://${file}?v=${fs.statSync(file).mtimeMs}`); // 带 mtime 让改写后的模块重新加载
    const f = mod.default ?? mod.handler;
    if (typeof f !== "function") throw new Error("tool.mjs 必须默认导出一个函数 async (args) => string");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`超过 ${m.timeout} 秒没有返回`)), m.timeout * 1000); });
    try { const out = await Promise.race([f(args, { dir, home: paths.home }), timeout]); return out == null ? "" : typeof out === "string" ? out : JSON.stringify(out, null, 2); }
    finally { clearTimeout(timer); }
  }
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const [k, v] of Object.entries(args ?? {})) if (/^[A-Za-z_]\w*$/.test(k)) env[`ARG_${k}`] = typeof v === "string" ? v : JSON.stringify(v);
  return new Promise((resolve, reject) => {
    const p = spawn("sh", [sourceFile(m.name, "sh")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const cap = (s: string, b: Buffer) => (s + b.toString()).slice(-(4 << 20));
    p.stdout.on("data", (b) => (out = cap(out, b))); p.stderr.on("data", (b) => (err = cap(err, b)));
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`超过 ${m.timeout} 秒没有结束，已终止`)); }, m.timeout * 1000);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out || err) : reject(new Error(`退出码 ${code}：${(err || out).trim().slice(0, 1500)}`)); });
    p.stdin.end(JSON.stringify(args ?? {}));
  });
}
