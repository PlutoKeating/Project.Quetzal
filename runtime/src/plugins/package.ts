// 插件包解析：兼容业界通行的格式，不自造一套。
//   - Claude Code 插件：.claude-plugin/plugin.json（name 必需，kebab-case），包内 skills/（Agent Skills）、.mcp.json 的 mcpServers（或 plugin.json 的 mcpServers）、
//     可选 commands/ 与 agents/（Markdown + YAML 头）；hooks/ 是 Claude Code 自己的生命周期命令，这里不执行，只在预览里说明；
//   - Agent Skills 目录：skills/<名>/SKILL.md，或根目录就是一个技能（SKILL.md）；
//   - 插件目录（插件市场）：.claude-plugin/marketplace.json（Claude Code 插件市场格式）。
// 只读文件、不执行包里的任何东西；不跟随符号链接；大小与数量有上限。
import fs from "node:fs";
import path from "node:path";
import { which } from "../platform.ts";
import { remoteUrl } from "../mcp/net.ts";
import { reservedName } from "../memory/portable-path.ts";
import { parseSkill } from "../mind/custom-tools.ts";
import type { CatalogInput } from "./catalog.ts";

export const PLUGIN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_JSON = 256 << 10, MAX_DOC = 1 << 20, MAX_SKILL_FILES = 64, MAX_ITEMS = 64;
/** 技能目录里可以进灵魂仓库的文件：只有文档与数据（规范 §3.12：不放可执行实现）。 */
const DOC_EXT = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".xml"]);

export interface PlanServer {
  name: string; // 包里的名字
  server: Record<string, unknown>; // 交给 mcp/runtime.ts 的 parseServer 的配置（不含凭据值；${VAR} 还没替换）
  inputs: CatalogInput[]; // 安装时要填的值
  problem?: string; // 这具身体上装不了的原因（找不到命令等）
}
export interface PlanSkill { name: string; description: string; dir: string; files: string[]; skipped: string[] }
export interface PlanDoc { name: string; description: string; file: string }
export interface ParsedPlugin {
  name: string; version: string; description: string; author: string; homepage: string; license: string; keywords: string[];
  format: "claude-plugin" | "skills";
  mcp: PlanServer[]; skills: PlanSkill[]; commands: PlanDoc[]; agents: PlanDoc[]; hooks: boolean; warnings: string[];
}

const str = (v: unknown, n = 500) => (typeof v === "string" ? v.slice(0, n) : "");
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** 包内的相对路径：解析后必须仍在包里，且不经过符号链接。 */
export function inside(root: string, rel: string): string | undefined {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel)) return undefined;
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return undefined;
  let p = root;
  for (const seg of path.relative(root, full).split(path.sep).filter(Boolean)) {
    p = path.join(p, seg);
    try { if (fs.lstatSync(p).isSymbolicLink()) return undefined; } catch { return undefined; }
  }
  return full;
}
function readJson(file: string): unknown {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.size > MAX_JSON) throw new Error(`${path.basename(file)} 不是普通文件或太大`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`${path.basename(file)} 不是合法的 JSON：${(e as Error).message}`); }
}
const isDir = (p: string) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
const list = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** YAML 头（Markdown 文档的 --- 段）：只取单行的 name / description。 */
function frontmatter(text: string): { name: string; description: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = { name: "", description: "" };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^(name|description):\s*(.*)$/);
    if (k) out[k[1] as "name" | "description"] = k[2].trim().replace(/^["'](.*)["']$/, "$1").slice(0, 500);
  }
  return out;
}

/** 一个技能目录：SKILL.md 与可以进灵魂仓库的文档（其余文件列为跳过）。 */
export function readSkillDir(dir: string, warnings: string[]): PlanSkill | undefined {
  const skill = path.join(dir, "SKILL.md");
  if (!isFile(skill)) return undefined;
  const text = fs.readFileSync(skill, "utf8");
  if (Buffer.byteLength(text) > MAX_DOC) { warnings.push(`${path.basename(dir)}：SKILL.md 超过 1 MiB，没有收`); return undefined; }
  const head = parseSkill(text);
  const name = (head.name || path.basename(dir)).trim();
  if (!PLUGIN_NAME.test(name) || name.length > 64 || reservedName(name)) { warnings.push(`技能名 ${name} 不符合 Agent Skills 规范（小写字母、数字与连字符，最长 64），没有收`); return undefined; }
  if (!head.description) warnings.push(`技能 ${name} 没有 description（Agent Skills 规范要求），仍然安装`);
  const files: string[] = [], skipped: string[] = [];
  let total = 0;
  const walk = (d: string, depth: number) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name), rel = path.relative(dir, full).split(path.sep).join("/");
      if (e.name.startsWith(".")) { skipped.push(rel); continue; }
      if (e.isSymbolicLink()) { skipped.push(rel); continue; }
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); else skipped.push(rel); continue; }
      if (!e.isFile()) { skipped.push(rel); continue; }
      const st = fs.statSync(full);
      const exec = process.platform !== "win32" && (st.mode & 0o111) !== 0;
      if (!DOC_EXT.has(path.extname(e.name).toLowerCase()) || exec || files.length >= MAX_SKILL_FILES || total + st.size > MAX_DOC * 2 || reservedName(e.name)) { skipped.push(rel); continue; }
      total += st.size;
      files.push(rel);
    }
  };
  walk(dir, 0);
  return { name, description: head.description.slice(0, 500), dir, files, skipped };
}

function docs(root: string, rels: string[], warnings: string[], what: string): PlanDoc[] {
  const out: PlanDoc[] = [];
  const add = (file: string) => {
    if (out.length >= MAX_ITEMS || !file.endsWith(".md") || !isFile(file) || fs.statSync(file).size > MAX_DOC) return;
    const fm = frontmatter(fs.readFileSync(file, "utf8"));
    const name = (fm.name || path.basename(file, ".md")).toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").slice(0, 64);
    if (name && !out.some((d) => d.name === name)) out.push({ name, description: fm.description, file });
  };
  for (const rel of rels) {
    const p = inside(root, rel);
    if (!p) { warnings.push(`${what} 路径 ${rel} 不在包里，忽略`); continue; }
    if (isFile(p)) add(p);
    else if (isDir(p)) for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isFile()) add(path.join(p, e.name));
      else if (e.isDirectory() && !e.isSymbolicLink()) for (const f of fs.readdirSync(path.join(p, e.name), { withFileTypes: true })) if (f.isFile()) add(path.join(p, e.name, f.name));
    }
  }
  return out;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const SECRETISH = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH/i;
/** ${CLAUDE_PLUGIN_ROOT} 换成安装目录；其余 ${VAR} 记为安装时要填的值。 */
function placeholders(v: string, root: string, inputs: CatalogInput[], target: CatalogInput["target"], name?: string): string {
  return v.replace(PLACEHOLDER, (all, key: string, dflt?: string) => {
    if (key === "CLAUDE_PLUGIN_ROOT") return root;
    if (!inputs.some((i) => i.key === key)) inputs.push({ key, label: key, target, ...(name ? { name } : {}), secret: SECRETISH.test(key), required: dflt === undefined, ...(dflt !== undefined ? { placeholder: dflt } : {}) });
    return all;
  });
}
/** 命令换成这具身体上的绝对路径；node / npm / npx 找不到时用运行基座自己的 Node（同一个目录里的）。 */
export function resolveCommand(cmd: string): string | undefined {
  if (path.isAbsolute(cmd)) return which(cmd);
  if (cmd.includes("/") || cmd.includes("\\")) return undefined;
  const found = which(cmd);
  if (found) return found;
  if (cmd === "node") return process.execPath;
  if (cmd === "npx" || cmd === "npm") return which(path.join(path.dirname(process.execPath), process.platform === "win32" ? `${cmd}.cmd` : cmd));
  return undefined;
}

/** .mcp.json 的一项 → 来源配置。root 为安装后的目录（替换 ${CLAUDE_PLUGIN_ROOT}）。 */
export function serverFrom(name: string, raw: unknown, root: string, plugin: string): PlanServer {
  const inputs: CatalogInput[] = [];
  const out: PlanServer = { name, server: {}, inputs };
  if (!plain(raw)) { out.problem = "配置不是对象"; return out; }
  const type = raw.type === "streamable-http" || raw.type === "streamableHttp" ? "http" : raw.type;
  const title = `${plugin}/${name}`.slice(0, 80);
  if (type === "http" || type === "sse" || (type === undefined && typeof raw.url === "string")) {
    const url = placeholders(str(raw.url, 2048), root, inputs, "header");
    const headers: Record<string, string> = {};
    if (plain(raw.headers)) for (const [k, v] of Object.entries(raw.headers).slice(0, 32)) if (typeof v === "string") headers[k] = placeholders(v, root, inputs, "header", k);
    out.server = { transport: type === "sse" ? "sse" : "http", url, headers, title, plugin };
    if (/\$\{/.test(url)) out.problem = "地址里有要填的变量，暂不支持";
    else try { remoteUrl(url); } catch (e) { out.problem = (e as Error).message; }
    return out;
  }
  if (type !== undefined && type !== "stdio") { out.problem = `不认识的传输方式 ${String(type)}`; return out; }
  const command = placeholders(str(raw.command, 1024), root, inputs, "arg");
  const args = list(raw.args).slice(0, 128).map((a) => placeholders(a, root, inputs, "arg"));
  const env: Record<string, string> = {};
  if (plain(raw.env)) for (const [k, v] of Object.entries(raw.env).slice(0, 64)) if (typeof v === "string") env[k] = placeholders(v, root, inputs, "env", k);
  const cwd = typeof raw.cwd === "string" ? placeholders(raw.cwd, root, inputs, "arg") : undefined;
  out.server = { transport: "stdio", command, args, env, ...(cwd ? { cwd } : {}), title, plugin };
  if (!command) { out.problem = "没有 command"; return out; }
  // 包里自带的程序（${CLAUDE_PLUGIN_ROOT}/…）安装后才在那里，这时只核对路径在包里
  if (command.startsWith(root + path.sep)) { out.server.command = command; return out; }
  const abs = resolveCommand(command);
  if (!abs) out.problem = `这具身体上找不到命令 ${command}`;
  else out.server.command = abs;
  return out;
}

/** 解析一个插件目录（Claude Code 插件、Agent Skills 目录或单个技能）。installRoot 为安装后的位置。 */
export function parsePlugin(dir: string, installRoot: string, fallbackName: string): ParsedPlugin {
  if (!isDir(dir)) throw new Error("插件来源不是目录");
  const warnings: string[] = [];
  const manifestFile = path.join(dir, ".claude-plugin", "plugin.json");
  const m: Record<string, unknown> = isFile(manifestFile) ? (() => { const j = readJson(manifestFile); if (!plain(j)) throw new Error("plugin.json 需为对象"); return j; })() : {};
  const claude = isFile(manifestFile);
  const name = claude ? str(m.name, 64) : fallbackName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!PLUGIN_NAME.test(name) || reservedName(name)) throw new Error(`插件名 ${name || "（空）"} 不合规（kebab-case：小写字母、数字与连字符）`);
  const author = plain(m.author) ? str(m.author.name, 100) : str(m.author, 100);
  const p: ParsedPlugin = {
    name, version: str(m.version, 40), description: str(m.description, 1000), author, homepage: str(m.homepage, 500) || str(m.repository, 500), license: str(m.license, 60),
    keywords: list(m.keywords).slice(0, 20).map((k) => k.slice(0, 40)), format: claude ? "claude-plugin" : "skills",
    mcp: [], skills: [], commands: [], agents: [], hooks: false, warnings,
  };
  // 技能：plugin.json 的 skills（路径或路径数组）与缺省的 skills/；根目录直接是技能也认
  const skillRoots = [...new Set([...list(m.skills), "skills"])];
  for (const rel of skillRoots) {
    const d = inside(dir, rel);
    if (!d || !isDir(d)) { if (rel !== "skills") warnings.push(`技能路径 ${rel} 不在包里或不是目录`); continue; }
    const own = readSkillDir(d, warnings);
    if (own) { p.skills.push(own); continue; }
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.isSymbolicLink() || p.skills.length >= MAX_ITEMS) continue;
      const s = readSkillDir(path.join(d, e.name), warnings);
      if (s && !p.skills.some((x) => x.name === s.name)) p.skills.push(s);
    }
  }
  if (!p.skills.length && isFile(path.join(dir, "SKILL.md"))) { const s = readSkillDir(dir, warnings); if (s) p.skills.push(s); }
  p.commands = docs(dir, [...new Set([...list(m.commands), ...(isDir(path.join(dir, "commands")) ? ["commands"] : [])])], warnings, "命令");
  p.agents = docs(dir, [...new Set([...list(m.agents), ...(isDir(path.join(dir, "agents")) ? ["agents"] : [])])], warnings, "子 agent");
  p.hooks = m.hooks !== undefined || isFile(path.join(dir, "hooks", "hooks.json"));
  if (p.hooks) warnings.push("包里有 hooks（Claude Code 的生命周期命令）：Quetzal 不执行它们");
  // MCP：plugin.json 的 mcpServers（对象，或指向 JSON 文件的路径）与根目录的 .mcp.json
  const servers: Record<string, unknown> = {};
  const take = (j: unknown) => { const o = plain(j) && plain(j.mcpServers) ? j.mcpServers : j; if (plain(o)) for (const [k, v] of Object.entries(o)) if (Object.keys(servers).length < 16) servers[k] ??= v; };
  if (plain(m.mcpServers)) take(m.mcpServers);
  for (const rel of [...list(m.mcpServers), ".mcp.json"]) {
    const f = inside(dir, rel);
    if (f && isFile(f)) try { take(readJson(f)); } catch (e) { warnings.push((e as Error).message); }
  }
  for (const [k, v] of Object.entries(servers)) p.mcp.push(serverFrom(k.slice(0, 64), v, installRoot, name));
  if (!p.mcp.length && !p.skills.length && !p.commands.length && !p.agents.length) throw new Error("没有找到可以安装的内容（.claude-plugin/plugin.json、skills/、SKILL.md、.mcp.json）");
  return p;
}

// ---------- 插件目录（Claude Code 插件市场 marketplace.json）

export type MarketSource = { kind: "path"; path: string } | { kind: "git"; url: string; ref?: string; subdir?: string };
export interface MarketPlugin { name: string; description: string; version: string; category: string; keywords: string[]; homepage: string; license: string; author: string; source: MarketSource }
export interface Marketplace { name: string; owner: string; description: string; plugins: MarketPlugin[]; warnings: string[] }

/** 插件的来源：相对路径（目录内）、{source:"github", repo}、{source:"url"|"git", url}、{source:"git-subdir", url, path}。 */
export function marketSource(v: unknown, pluginRoot = ""): MarketSource | undefined {
  if (typeof v === "string") {
    if (/^\.{0,2}\//.test(v) || !/[:@]/.test(v)) return { kind: "path", path: path.posix.normalize(path.posix.join(pluginRoot || ".", v)) };
    return undefined;
  }
  if (!plain(v)) return undefined;
  const ref = typeof v.ref === "string" ? v.ref.slice(0, 200) : undefined;
  if (v.source === "github" && typeof v.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo)) return { kind: "git", url: `https://github.com/${v.repo}.git`, ...(ref ? { ref } : {}) };
  if ((v.source === "url" || v.source === "git") && typeof v.url === "string") return { kind: "git", url: v.url, ...(ref ? { ref } : {}) };
  if (v.source === "git-subdir" && typeof v.url === "string" && typeof v.path === "string") return { kind: "git", url: v.url, subdir: v.path, ...(ref ? { ref } : {}) };
  return undefined;
}

export function parseMarketplace(j: unknown): Marketplace {
  if (!plain(j) || !Array.isArray(j.plugins)) throw new Error("marketplace.json 需要 plugins 数组");
  const name = str(j.name, 64);
  if (!PLUGIN_NAME.test(name)) throw new Error(`插件目录名 ${name || "（空）"} 不合规（kebab-case）`);
  const warnings: string[] = [];
  const meta = plain(j.metadata) ? j.metadata : {};
  const pluginRoot = str(meta.pluginRoot, 200);
  const plugins: MarketPlugin[] = [];
  for (const x of j.plugins.slice(0, 500)) {
    if (!plain(x) || !PLUGIN_NAME.test(str(x.name, 64))) { warnings.push(`跳过一项名字不合规的插件：${str(plain(x) ? x.name : "", 64)}`); continue; }
    const source = marketSource(x.source, pluginRoot);
    if (!source) { warnings.push(`${x.name}：不认识的来源，跳过`); continue; }
    if (plugins.some((p) => p.name === x.name)) continue;
    plugins.push({ name: x.name as string, description: str(x.description, 1000), version: str(x.version, 40), category: str(x.category, 40), keywords: list(x.keywords ?? x.tags).slice(0, 20).map((k) => k.slice(0, 40)),
      homepage: str(x.homepage, 500) || str(x.repository, 500), license: str(x.license, 60), author: plain(x.author) ? str(x.author.name, 100) : str(x.author, 100), source });
  }
  return { name, owner: plain(j.owner) ? str(j.owner.name, 100) : "", description: str(j.description, 1000) || str(meta.description, 1000), plugins, warnings };
}
