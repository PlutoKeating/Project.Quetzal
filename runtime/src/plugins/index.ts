// 插件：安装、卸载、插件目录（marketplace）、推荐目录与她的推荐。
//   安装分两步：preview 把来源（本地目录、git 仓库、插件目录里的一项、推荐目录里的一项）取到暂存区并解析，列出将添加的 MCP 来源、技能、命令与子 agent；
//   人在控制台看过、填好要填的值、确认后 install 才真正写入——技能写进灵魂仓库 skills/（随灵魂同步），MCP 来源加入 config/mcp.json（启动仍经闸门 mcp_start.<id>）。
//   包本身留在这具身体的 QUETZAL_HOME/plugins/<名>/（命令、子 agent 定义与包里自带的程序在这里）；包里的任何东西在安装时都不执行。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "../config.ts";
import { run } from "../sh.ts";
import { which } from "../platform.ts";
import { audit, addTimeline } from "../store.ts";
import { bus } from "../bus.ts";
import { log } from "../log.ts";
import { checkUrl, guardedFetch } from "../mind/fetch-guard.ts";
import { exclusive, writeJournal } from "../memory/memory.ts";
import * as soul from "../memory/soul-sync.ts";
import * as mcp from "../mcp/runtime.ts";
import { CATALOG, catalogEntry, searchCatalog, type CatalogEntry, type CatalogInput } from "./catalog.ts";
import { parsePlugin, parseMarketplace, resolveCommand, inside, PLUGIN_NAME, type ParsedPlugin, type PlanServer, type Marketplace, type MarketSource } from "./package.ts";

const root = () => path.join(paths.home, "plugins");
const stateFile = () => path.join(root(), "installed.json");
const staging = () => path.join(root(), ".staging");
const marketDir = () => path.join(root(), ".marketplaces");
const MAX_COPY_BYTES = 64 << 20, MAX_COPY_FILES = 5000, PLAN_MS = 30 * 60_000;

export interface PluginDoc { name: string; description: string; file?: string }
export interface Installed { name: string; version: string; description: string; source: string; catalog?: string; marketplace?: string; commit?: string; installedAt: number; mcp: string[]; skills: string[]; commands: PluginDoc[]; agents: PluginDoc[] }
export interface MarketRecord { name: string; source: string; added: number; updated: number; error?: string }
export interface Recommendation { id: string; name: string; reason: string; conv: string; ts: number }
interface State { plugins: Installed[]; marketplaces: MarketRecord[]; recommendations: Recommendation[] }

function load(): State {
  try { const j = JSON.parse(fs.readFileSync(stateFile(), "utf8")); return { plugins: Array.isArray(j.plugins) ? j.plugins : [], marketplaces: Array.isArray(j.marketplaces) ? j.marketplaces : [], recommendations: Array.isArray(j.recommendations) ? j.recommendations : [] }; }
  catch { return { plugins: [], marketplaces: [], recommendations: [] }; }
}
function save(s: State) {
  fs.mkdirSync(root(), { recursive: true });
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile());
  bus.emit("plugins.changed");
}

// ---------- 取来源：本地目录复制、git 仓库浅克隆（只收 HTTPS 公网地址，不执行钩子、不拉子模块）

function copyTree(from: string, to: string) {
  let files = 0, bytes = 0;
  const walk = (src: string, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === ".git" || e.isSymbolicLink()) continue; // 不跟随、不复制符号链接
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d);
      else if (e.isFile()) {
        const st = fs.statSync(s);
        if (++files > MAX_COPY_FILES || (bytes += st.size) > MAX_COPY_BYTES) throw new Error("插件包太大（超过 5000 个文件或 64 MiB）");
        fs.copyFileSync(s, d);
        fs.chmodSync(d, st.mode & 0o755);
      }
    }
  };
  walk(from, to);
}

/** git 仓库地址：https 公网地址，或 GitHub 的 owner/repo 简写。 */
export async function gitUrl(raw: string): Promise<string> {
  const v = raw.trim();
  const url = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) ? `https://github.com/${v}.git` : v;
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("不是本地目录的绝对路径，也不是 git 仓库地址"); }
  if (u.protocol !== "https:") throw new Error("git 仓库只收 https 地址");
  if (u.username || u.password) throw new Error("地址里不能带用户名或密码");
  const bad = await checkUrl(u);
  if (bad) throw new Error(bad);
  return u.toString();
}

async function clone(url: string, dest: string, ref?: string): Promise<string> {
  const git = which("git");
  if (!git) throw new Error("这具身体上没有 git");
  if (ref && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) throw new Error("git 引用不合规");
  const env = { PATH: process.env.PATH ?? "", HOME: staging(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  const safe = ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "core.symlinks=false", "-c", "core.fsmonitor=false"];
  const r = await run(git, [...safe, "clone", "--depth", "1", "--no-recurse-submodules", "--single-branch", ...(ref ? ["--branch", ref] : []), "--", url, dest], 120_000, { env });
  if (r.code !== 0) throw new Error(`git clone 失败：${(r.err || r.out).trim().slice(-400)}`);
  const head = await run(git, [...safe, "-C", dest, "rev-parse", "HEAD"], 20_000, { env });
  return head.code === 0 ? head.out.trim().slice(0, 40) : "";
}

/** 把来源取到一个新的暂存目录：返回目录与（git 的）提交号。 */
async function fetchSource(source: MarketSource | { kind: "local"; path: string }): Promise<{ dir: string; commit?: string; tmp: string }> {
  fs.mkdirSync(staging(), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(staging(), "p-"));
  try {
    if (source.kind === "local" || source.kind === "path") {
      const p = source.path;
      if (!path.isAbsolute(p) || !fs.lstatSync(p).isDirectory()) throw new Error("本地来源需为目录的绝对路径");
      copyTree(fs.realpathSync(p), path.join(tmp, "pkg"));
      return { dir: path.join(tmp, "pkg"), tmp };
    }
    const url = await gitUrl(source.url);
    const commit = await clone(url, path.join(tmp, "repo"), source.ref);
    let dir = path.join(tmp, "repo");
    if (source.subdir) { const d = inside(dir, source.subdir); if (!d || !fs.lstatSync(d).isDirectory()) throw new Error(`仓库里没有目录 ${source.subdir}`); dir = d; }
    fs.rmSync(path.join(tmp, "repo", ".git"), { recursive: true, force: true });
    return { dir, commit, tmp };
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}

// ---------- 预览与安装

interface Plan {
  id: string; created: number; kind: "plugin" | "catalog"; name: string; source: string; tmp?: string; dir?: string; commit?: string;
  parsed?: ParsedPlugin; catalog?: CatalogEntry; marketplace?: string;
}
const plans = new Map<string, Plan>();
function sweep() { for (const [k, p] of plans) if (Date.now() - p.created > PLAN_MS) { plans.delete(k); if (p.tmp) fs.rmSync(p.tmp, { recursive: true, force: true }); } }

/** 推荐目录里的一项 → 来源配置与要填的值。 */
function catalogServer(e: CatalogEntry): PlanServer {
  const s = e.server;
  if (s.transport !== "stdio") return { name: e.id, server: { transport: s.transport, url: s.url, oauth: s.oauth ? {} : false, title: e.name }, inputs: e.inputs ?? [] };
  const command = resolveCommand(s.runner);
  const args = s.runner === "npx" ? ["-y", s.package, ...s.args] : [s.package, ...s.args];
  return { name: e.id, server: { transport: "stdio", command: command ?? s.runner, args, env: { ...(s.env ?? {}) }, title: e.name }, inputs: e.inputs ?? [],
    ...(command ? {} : { problem: s.runner === "uvx" ? "这具身体上没有 uvx：先装 uv（https://docs.astral.sh/uv/），再来安装" : `这具身体上找不到 ${s.runner}` }) };
}

export interface PreviewView {
  plan: string; kind: Plan["kind"]; name: string; version: string; description: string; author: string; homepage: string; license: string; source: string;
  mcp: { key: string; id: string; title: string; transport: string; command?: string; args?: string[]; url?: string; oauth: boolean; sync: boolean; inputs: CatalogInput[]; problem?: string }[];
  skills: { name: string; description: string; files: string[]; skipped: string[]; conflict?: string }[];
  commands: { name: string; description: string }[]; agents: { name: string; description: string }[];
  hooks: boolean; warnings: string[]; installed?: string; outward?: string; setup?: string;
}
function servers(plan: Plan): PlanServer[] { return plan.parsed ? plan.parsed.mcp : plan.catalog ? [catalogServer(plan.catalog)] : []; }
function previewOf(plan: Plan): PreviewView {
  const st = load();
  const taken = new Set(mcp.listSources().sources.map((s) => s.id));
  const existing = st.plugins.find((p) => p.name === plan.name);
  for (const id of existing?.mcp ?? []) taken.delete(id); // 更新：沿用原来的来源 id
  const mine = new Set(existing?.skills ?? []);
  const p = plan.parsed, c = plan.catalog;
  return {
    plan: plan.id, kind: plan.kind, name: plan.name, version: p?.version ?? "", description: p?.description ?? c?.description ?? "", author: p?.author ?? c?.maintainer ?? "",
    homepage: p?.homepage ?? c?.source ?? "", license: p?.license ?? c?.license ?? "", source: plan.source,
    mcp: servers(plan).map((s) => {
      const id = mcp.freeId(s.name, taken); taken.add(id);
      const remote = s.server.transport === "http" || s.server.transport === "sse";
      return { key: s.name, id, title: String(s.server.title ?? s.name), transport: String(s.server.transport), ...(remote ? { url: String(s.server.url) } : { command: String(s.server.command), args: s.server.args as string[] }),
        oauth: remote && s.server.oauth !== false, sync: remote, inputs: s.inputs, ...(s.problem ? { problem: s.problem } : {}) };
    }),
    skills: (p?.skills ?? []).map((s) => ({ name: s.name, description: s.description, files: s.files, skipped: s.skipped,
      ...(fs.existsSync(path.join(paths.soul, "skills", s.name)) && !mine.has(s.name) ? { conflict: "灵魂仓库里已有同名技能（她自己写的或别的插件装的），不会覆盖" } : {}) })),
    commands: (p?.commands ?? []).map(({ name, description }) => ({ name, description })), agents: (p?.agents ?? []).map(({ name, description }) => ({ name, description })),
    hooks: p?.hooks ?? false, warnings: p?.warnings ?? [], ...(existing ? { installed: existing.version || "已安装" } : {}),
    ...(c?.outward ? { outward: c.outward } : {}), ...(c?.setup ? { setup: c.setup } : {}),
  };
}

/** 预览：source 为本地目录绝对路径、git 地址或 owner/repo；或 catalog 为推荐目录的 id；或 marketplace + plugin 为插件目录里的一项。 */
export async function preview(a: { source?: string; catalog?: string; marketplace?: string; plugin?: string }): Promise<PreviewView> {
  sweep();
  const id = crypto.randomBytes(12).toString("hex");
  if (a.catalog) {
    const e = catalogEntry(a.catalog);
    if (!e) throw new Error(`推荐目录里没有 ${a.catalog}`);
    const plan: Plan = { id, created: Date.now(), kind: "catalog", name: e.id.replace(/_/g, "-"), source: `推荐目录：${e.name}`, catalog: e };
    plans.set(id, plan);
    return previewOf(plan);
  }
  let source: MarketSource | { kind: "local"; path: string };
  let label: string, market: string | undefined;
  if (a.marketplace) {
    const m = readMarket(a.marketplace);
    const item = m.plugins.find((p) => p.name === a.plugin);
    if (!item) throw new Error(`插件目录 ${a.marketplace} 里没有 ${a.plugin}`);
    market = a.marketplace;
    if (item.source.kind === "path") {
      const base = marketRoot(a.marketplace);
      if (!base) throw new Error("这个插件目录是直接从网址读的，里面的相对路径来源取不到；请改用它的 git 仓库添加");
      const d = inside(base, item.source.path.replace(/^\.\//, ""));
      if (!d) throw new Error(`插件 ${item.name} 的路径不在插件目录里`);
      source = { kind: "local", path: d };
    } else source = item.source;
    label = `${a.marketplace} / ${item.name}`;
  } else {
    const s = String(a.source ?? "").trim();
    if (!s) throw new Error("需要来源：本地目录的绝对路径、git 仓库地址，或 GitHub 的 owner/repo");
    source = path.isAbsolute(s) ? { kind: "local", path: s } : { kind: "git", url: s };
    label = s;
  }
  const got = await fetchSource(source);
  try {
    const installRoot = (name: string) => path.join(root(), name);
    const first = parsePlugin(got.dir, installRoot("pending"), path.basename(source.kind === "git" ? source.url.replace(/\.git$/, "") : source.path));
    const parsed = parsePlugin(got.dir, installRoot(first.name), first.name); // 以真实的安装目录替换 ${CLAUDE_PLUGIN_ROOT}
    const plan: Plan = { id, created: Date.now(), kind: "plugin", name: parsed.name, source: label, tmp: got.tmp, dir: got.dir, commit: got.commit, parsed, ...(market ? { marketplace: market } : {}) };
    plans.set(id, plan);
    return previewOf(plan);
  } catch (e) { fs.rmSync(got.tmp, { recursive: true, force: true }); throw e; }
}

export function cancel(planId: string): boolean {
  const p = plans.get(planId);
  if (!p) return false;
  plans.delete(planId);
  if (p.tmp) fs.rmSync(p.tmp, { recursive: true, force: true });
  return true;
}

/** 把填好的值放进来源配置：凭据（secret）进 secrets/，其余进 env / 请求头 / 参数。
 *  插件包里的值写成 ${VAR}（照 Claude Code 的 .mcp.json），就地替换；推荐目录的输入按 target 放。 */
export function finalize(s: PlanServer, values: Record<string, string>): { server: Record<string, unknown>; secrets: Record<string, string> } {
  const server = structuredClone(s.server) as Record<string, any>;
  const secrets: Record<string, string> = {};
  const missing = s.inputs.filter((i) => i.required && !values[i.key]?.trim());
  if (missing.length) throw new Error(`${s.name}：还没填 ${missing.map((i) => i.label).join("、")}`);
  const remote = server.transport === "http" || server.transport === "sse";
  if (/\$\{/.test(JSON.stringify(s.server))) {
    const fill = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k: string, d?: string) => values[k]?.trim() || d || "");
    const usesSecret = (v: string) => [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].some(([, k]) => s.inputs.find((i) => i.key === k)?.secret);
    const split = (o: Record<string, string>) => { const plainOut: Record<string, string> = {}; for (const [k, v] of Object.entries(o)) { const f = fill(v); if (usesSecret(v)) { if (f) secrets[k] = f; } else if (f || !remote) plainOut[k] = f; } return plainOut; };
    if (remote) server.headers = split(server.headers ?? {});
    else { server.env = split(server.env ?? {}); server.args = (server.args as string[]).map(fill); server.command = fill(String(server.command)); if (server.cwd) server.cwd = fill(String(server.cwd)); }
    return { server, secrets };
  }
  for (const i of s.inputs) {
    const v = values[i.key]?.trim();
    if (!v) continue;
    const val = i.format ? i.format.replace("{}", v) : v;
    if (i.target === "header" && i.name && remote) { if (i.secret) secrets[i.name] = val; else server.headers = { ...(server.headers ?? {}), [i.name]: val }; }
    else if (i.target === "env" && i.name && !remote) { if (i.secret) secrets[i.name] = val; else server.env = { ...(server.env ?? {}), [i.name]: val }; }
    else if (i.target === "arg" && !remote) server.args = [...server.args, ...(i.name ? [i.name, val] : [val])];
  }
  return { server, secrets };
}

/** 安装（人在控制台确认之后）。inputs：{来源名: {变量: 值}}；skip：不装的 MCP 来源名与技能名；enable：MCP 来源装好就启用（启动仍经闸门）；replace：更新已装的同名插件。 */
export async function install(a: { plan: string; inputs?: Record<string, Record<string, string>>; skip?: { mcp?: string[]; skills?: string[] }; enable?: boolean; replace?: boolean }, actor: string): Promise<Installed> {
  sweep();
  const plan = plans.get(String(a.plan));
  if (!plan) throw new Error("预览已过期，请重新预览");
  const st = load();
  const existing = st.plugins.find((p) => p.name === plan.name);
  if (existing && !a.replace) throw new Error(`插件 ${plan.name} 已安装（${existing.version || "当前版本"}）；要更新请选择替换`);
  const skipM = new Set(a.skip?.mcp ?? []), skipS = new Set(a.skip?.skills ?? []);
  // 先把每个来源的配置整理好（缺值就在写任何东西之前报错）
  const ready = servers(plan).filter((s) => !skipM.has(s.name) && !s.problem).map((s) => ({ s, ...finalize(s, a.inputs?.[s.name] ?? {}) }));
  plans.delete(plan.id);
  const dest = path.join(root(), plan.name);
  if (plan.dir) { fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(root(), { recursive: true }); fs.renameSync(plan.dir, dest); }
  if (plan.tmp) fs.rmSync(plan.tmp, { recursive: true, force: true });
  // MCP 来源：更新时同名（同标题）的沿用原来的 id、登录与凭据，原来有、新版本没有的删掉
  const ids: string[] = [];
  const old = new Set(existing?.mcp ?? []);
  for (const { s, server, secrets } of ready) {
    try {
      const reuse = [...old].find((x) => mcp.findServer(x)?.title === server.title);
      const raw = { ...server, enabled: a.enable !== false, plugin: plan.name };
      const v = reuse ? mcp.replaceSource(reuse, raw, actor, secrets) : mcp.addSource({ ...raw, id: mcp.freeId(s.name) }, actor, secrets);
      if (reuse) old.delete(reuse);
      ids.push(v.id);
    } catch (e) { log("plugins", `${plan.name}：来源 ${s.name} 没有加上：${(e as Error).message}`); }
  }
  for (const id of old) mcp.removeSource(id, actor);
  // 技能写进灵魂仓库：同名的已有技能（不是这个插件装的）不覆盖
  const mine = new Set(existing?.skills ?? []);
  const skills: string[] = [];
  const parsedSkills = (plan.parsed?.skills ?? []).filter((s) => !skipS.has(s.name));
  await exclusive(() => {
    for (const s of parsedSkills) {
      const target = path.join(paths.soul, "skills", s.name);
      if (fs.existsSync(target) && !mine.has(s.name)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      const from = path.join(dest, path.relative(plan.dir!, s.dir));
      for (const rel of s.files) {
        const out = path.join(target, ...rel.split("/"));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(path.join(from, ...rel.split("/")), out);
        fs.chmodSync(out, 0o644);
      }
      skills.push(s.name);
    }
    for (const gone of existing?.skills ?? []) if (!skills.includes(gone) && PLUGIN_NAME.test(gone)) fs.rmSync(path.join(paths.soul, "skills", gone), { recursive: true, force: true });
  });
  if (skills.length || existing?.skills.length) await soul.push(`${existing ? "更新" : "安装"}插件 ${plan.name} 的技能：${skills.join("、") || "（无）"}`).catch(() => {});
  const rel = (f: string) => path.join(dest, path.relative(plan.dir!, f));
  const rec: Installed = {
    name: plan.name, version: plan.parsed?.version ?? "", description: plan.parsed?.description ?? plan.catalog?.description ?? "", source: plan.source,
    ...(plan.catalog ? { catalog: plan.catalog.id } : {}), ...(plan.marketplace ? { marketplace: plan.marketplace } : {}), ...(plan.commit ? { commit: plan.commit } : {}),
    installedAt: Date.now(), mcp: ids, skills,
    commands: (plan.parsed?.commands ?? []).map((c) => ({ name: c.name, description: c.description, file: rel(c.file) })),
    agents: (plan.parsed?.agents ?? []).map((c) => ({ name: c.name, description: c.description, file: rel(c.file) })),
  };
  const now = load();
  now.plugins = [...now.plugins.filter((p) => p.name !== plan.name), rec];
  now.recommendations = now.recommendations.filter((r) => r.id !== plan.catalog?.id && r.id !== `${plan.marketplace}/${plan.name}`);
  save(now);
  audit(actor, "plugins.install", "", { name: plan.name, source: plan.source, mcp: ids, skills }, "ok");
  addTimeline("plugin", `${existing ? "更新" : "安装"}了插件 ${plan.name}`, { name: plan.name, mcp: ids, skills });
  writeJournal(`有人给我装了插件 ${plan.name}`, `${actor}：${[ids.length ? `工具来源 ${ids.join("、")}` : "", skills.length ? `技能 ${skills.join("、")}` : ""].filter(Boolean).join("；") || "命令与子 agent 定义"}`);
  return rec;
}

/** 卸载：去掉它加的 MCP 来源（连同令牌与凭据）、技能（keepSkills 时保留）与包。 */
export async function uninstall(a: { name: string; keepSkills?: boolean }, actor: string): Promise<boolean> {
  const st = load();
  const p = st.plugins.find((x) => x.name === a.name);
  if (!p) return false;
  for (const id of p.mcp) mcp.removeSource(id, actor);
  if (!a.keepSkills && p.skills.length) {
    await exclusive(() => { for (const s of p.skills) if (PLUGIN_NAME.test(s)) fs.rmSync(path.join(paths.soul, "skills", s), { recursive: true, force: true }); });
    await soul.push(`卸载插件 ${p.name} 的技能：${p.skills.join("、")}`).catch(() => {});
  }
  if (PLUGIN_NAME.test(p.name)) fs.rmSync(path.join(root(), p.name), { recursive: true, force: true });
  const now = load();
  now.plugins = now.plugins.filter((x) => x.name !== a.name);
  save(now);
  audit(actor, "plugins.uninstall", "", a, "ok");
  addTimeline("plugin", `卸载了插件 ${p.name}`, { name: p.name });
  return true;
}

// ---------- 插件目录（marketplace）

const marketFile = (name: string) => path.join(marketDir(), name, "marketplace.json");
/** 克隆来的插件目录的根（相对路径的插件从这里取）；从网址直接读的没有。 */
function marketRoot(name: string): string | undefined { const d = path.join(marketDir(), name, "repo"); return fs.existsSync(d) ? d : undefined; }
export function readMarket(name: string): Marketplace {
  if (!PLUGIN_NAME.test(name)) throw new Error("插件目录名不合规");
  try { return parseMarketplace(JSON.parse(fs.readFileSync(marketFile(name), "utf8"))); } catch { throw new Error(`没有插件目录 ${name}`); }
}

/** 添加插件目录：本地目录、git 仓库（.claude-plugin/marketplace.json），或直接指向 marketplace.json 的 HTTPS 地址。 */
export async function addMarketplace(sourceRaw: string, actor: string, refresh = false): Promise<Marketplace> {
  const source = sourceRaw.trim();
  if (!source) throw new Error("需要插件目录的来源");
  fs.mkdirSync(marketDir(), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(marketDir(), ".m-"));
  try {
    let json: unknown, repo: string | undefined;
    if (/^https:\/\/.+\.json(\?.*)?$/i.test(source)) {
      const r = await guardedFetch(source, { accept: "application/json" }, 30_000);
      if (r.status !== 200) throw new Error(`读取插件目录失败：HTTP ${r.status}`);
      json = JSON.parse(r.text);
    } else {
      const got = await fetchSource(path.isAbsolute(source) ? { kind: "local", path: source } : { kind: "git", url: source });
      repo = path.join(tmp, "repo");
      fs.renameSync(got.dir, repo);
      fs.rmSync(got.tmp, { recursive: true, force: true });
      const f = [path.join(repo, ".claude-plugin", "marketplace.json"), path.join(repo, "marketplace.json")].find((x) => { try { return fs.lstatSync(x).isFile(); } catch { return false; } });
      if (!f) throw new Error("仓库里没有 .claude-plugin/marketplace.json");
      json = JSON.parse(fs.readFileSync(f, "utf8"));
    }
    const m = parseMarketplace(json);
    const st = load();
    if (!refresh && st.marketplaces.some((x) => x.name === m.name)) throw new Error(`已有插件目录 ${m.name}`);
    fs.writeFileSync(path.join(tmp, "marketplace.json"), JSON.stringify(json));
    const dest = path.join(marketDir(), m.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    const now = load();
    const prev = now.marketplaces.find((x) => x.name === m.name);
    now.marketplaces = [...now.marketplaces.filter((x) => x.name !== m.name), { name: m.name, source, added: prev?.added ?? Date.now(), updated: Date.now() }];
    save(now);
    audit(actor, refresh ? "plugins.marketplace.refresh" : "plugins.marketplace.add", "", { name: m.name, source }, `ok: ${m.plugins.length} plugins`);
    return m;
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}
export async function refreshMarketplace(name: string, actor: string) {
  const rec = load().marketplaces.find((x) => x.name === name);
  if (!rec) throw new Error(`没有插件目录 ${name}`);
  return addMarketplace(rec.source, actor, true);
}
export function removeMarketplace(name: string, actor: string): boolean {
  const st = load();
  if (!st.marketplaces.some((x) => x.name === name)) return false;
  if (PLUGIN_NAME.test(name)) fs.rmSync(path.join(marketDir(), name), { recursive: true, force: true });
  st.marketplaces = st.marketplaces.filter((x) => x.name !== name);
  save(st);
  audit(actor, "plugins.marketplace.remove", "", { name }, "ok");
  return true;
}

// ---------- 总览、推荐

export function overview() {
  const st = load();
  const installed = new Set(st.plugins.map((p) => p.catalog).filter(Boolean));
  return {
    installed: st.plugins.map(({ commands, agents, ...p }) => ({ ...p, commands: commands.map(({ name, description }) => ({ name, description })), agents: agents.map(({ name, description }) => ({ name, description })) })),
    marketplaces: st.marketplaces.map((m) => { try { const x = readMarket(m.name); return { ...m, description: x.description, owner: x.owner, plugins: x.plugins.map((p) => ({ ...p, installed: st.plugins.some((i) => i.name === p.name && i.marketplace === m.name) })) }; } catch (e) { return { ...m, error: (e as Error).message, plugins: [] }; } }),
    recommendations: st.recommendations,
    catalog: CATALOG.map((e) => ({ id: e.id, name: e.name, description: e.description, category: e.category, license: e.license, source: e.source, maintainer: e.maintainer, transport: e.server.transport, installed: installed.has(e.id), ...(e.outward ? { outward: e.outward } : {}) })),
  };
}
export function dismiss(id: string): boolean {
  const st = load();
  const n = st.recommendations.length;
  st.recommendations = st.recommendations.filter((r) => r.id !== id);
  if (st.recommendations.length === n) return false;
  save(st);
  return true;
}
/** 她的推荐：id 为推荐目录的 id，或「插件目录/插件名」。 */
export function recommend(id: string, reason: string, conv: string): Recommendation {
  const st = load();
  const [market, plugin] = id.includes("/") ? id.split("/", 2) : [undefined, undefined];
  const name = market ? (() => { const m = readMarket(market); const p = m.plugins.find((x) => x.name === plugin); if (!p) throw new Error(`插件目录 ${market} 里没有 ${plugin}`); return p.name; })() : catalogEntry(id)?.name;
  if (!name) throw new Error(`推荐目录里没有 ${id}：先用 plugin_search 找`);
  if (market ? st.plugins.some((p) => p.name === plugin && p.marketplace === market) : st.plugins.some((p) => p.catalog === id)) throw new Error(`${name} 已经装了`);
  const rec: Recommendation = { id, name, reason: reason.replace(/\s+/g, " ").trim().slice(0, 500), conv: conv.slice(0, 80), ts: Date.now() };
  st.recommendations = [rec, ...st.recommendations.filter((r) => r.id !== id)].slice(0, 20);
  save(st);
  addTimeline("plugin", `推荐安装插件 ${name}`, { id, reason: rec.reason });
  return rec;
}

/** 已装插件里的命令与子 agent 定义（Claude Code 的 commands/、agents/）。 */
export function pluginDoc(plugin: string, name: string): { kind: "command" | "agent"; text: string } {
  const p = load().plugins.find((x) => x.name === plugin);
  if (!p) throw new Error(`没有装插件 ${plugin}`);
  const c = p.commands.find((x) => x.name === name), g = p.agents.find((x) => x.name === name);
  const file = (c ?? g)?.file;
  if (!file) throw new Error(`插件 ${plugin} 里没有 ${name}`);
  const base = path.join(root(), p.name);
  if (!path.resolve(file).startsWith(base + path.sep)) throw new Error("文件不在插件目录里");
  return { kind: c ? "command" : "agent", text: fs.readFileSync(file, "utf8").slice(0, 60_000) };
}

export const installedPlugins = () => load().plugins;
export const pendingRecommendations = () => load().recommendations.length;
export { searchCatalog };
