// 灵魂仓库协议（与运行时配置无关）：运行基座与桥接模块共用同一套同步与冲突规则。
// 规范见 docs/SOUL_REPO_SPEC.md（目录树、固定内容、文件格式、禁止内容、SSH 私钥认证），设计见 docs/SOUL_SYNC.md。
//   - 身份守卫：agent.json 的 id 不同的仓库拒绝合并（本地仍是种子身份时采用远端身份）
//   - 全自动解决冲突，无需 agent 参与：memories/*.md 条目级三方合并；agent.json 字段级合并；
//     其他文件（SOUL.md、笔记……）以提交时间较新的一方为准（本地为空或仍是种子人格时采用对方）。
//     落选的版本仍完整保存在 git 历史中，可随时查看或撤销。每次合入的内容与冲突处理结果都会返回给调用方，作为 agent 的知觉。
//   - 身体登记：bodies/<身体>.json
//   - 整理租约：locks/consolidation.json，git push 成功即取得（比较并交换）
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mergeEntries } from "./entries.ts";

export interface SoulRepoOptions {
  dir: string; remote: string; branch: string; body: string;
  sshKey: string; // 本身体专属的部署私钥（规范 §7：必须存在，且只使用它）
  seedIdentity?: () => object; // agent.json 缺失时生成的身份
  seedSoul?: (displayName: string) => string; // SOUL.md 缺失时生成的人格
  author: () => { name: string; email: string };
  isSeedSoul?: (text: string) => boolean; // 判断 SOUL.md 是否仍是种子人格
  bodyInfo?: () => Record<string, unknown>; // 写入 bodies/<身体>.json 的额外信息
  log?: (msg: string) => void;
}

const LEASE_MS = 30 * 60_000;
export const SPEC = { spec: "soul-repo", version: 1 };
const MAX_FILE = 1 << 20;
const TOP_LEVEL = new Set([".git", ".soul-spec.json", ".gitattributes", ".gitignore", "README.md", "agent.json", "SOUL.md", "memories", "journal", "notes", "bodies", "locks"]);
export const FIXED_FILES: Record<string, string> = {
  ".soul-spec.json": JSON.stringify(SPEC, null, 2) + "\n",
  ".gitattributes": "* text=auto eol=lf\n*.md text diff=markdown\n*.json text\n",
  ".gitignore": "*.tmp\n*.swp\n.DS_Store\n*.incoming*.md\n",
};
export const README_TEMPLATE = (displayName: string) => `# ${displayName} · 灵魂仓库

这是 agent「${displayName}」的灵魂仓库：身份、人格与记忆。它的所有身体（运行基座、Hermes Agent、OpenClaw……）都通过这个仓库全自动同步。

- **必须保持私有。**
- 请不要手动修改：同步、合并与版本管理由基座自动完成；需要撤销时，使用控制台的「记忆历史」。
- 结构与格式遵循 Soul Repository Specification v1（Project.Amani 的 docs/SOUL_REPO_SPEC.md）。
`;

/** 规范 §7：远端必须是 SSH 地址（测试中可用 SOUL_ALLOW_LOCAL_REMOTE=1 放行本地路径）。返回错误说明或 undefined。 */
export function checkRemote(remote: string): string | undefined {
  if (!remote) return undefined;
  if (/^(git@[\w.-]+:[\w.-]+\/[\w.-]+|ssh:\/\/[\w.-]+@[\w.-]+(:\d+)?\/)/.test(remote)) return undefined;
  if (process.env.SOUL_ALLOW_LOCAL_REMOTE === "1" && (remote.startsWith("/") || remote.startsWith("file://"))) return undefined;
  return "灵魂仓库必须使用 SSH 地址（如 git@github.com:<用户>/<agent>.soul.git），并通过本身体专属的部署私钥访问；不允许 HTTPS、令牌或密码";
}
const isLocal = (remote: string) => remote.startsWith("/") || remote.startsWith("file://");

// 规范 §6：禁止内容
const FORBIDDEN: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub 令牌"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "API Key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS 访问密钥"],
  [/\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/, "MAC 地址"],
  [/(?<![\d.])(?!127\.0\.0\.1(?![\d.]))(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/, "IP 地址"],
  [/(?<!\d)\d{15}(?!\d)/, "疑似 IMEI"],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/, "疑似手机号"],
];

/** 检查文件内容是否违反规范 §2/§6。返回问题列表。 */
export function lintContent(file: string, buf: Buffer): string[] {
  const out: string[] = [];
  if (buf.length > MAX_FILE) out.push(`${file}：超过 1 MiB`);
  if (buf.includes(0)) { out.push(`${file}：二进制文件`); return out; }
  const text = buf.toString("utf8");
  for (const [re, what] of FORBIDDEN) if (re.test(text)) out.push(`${file}：包含${what}`);
  return out;
}


export interface PullResult {
  merged: boolean;
  incoming: { body: string; subject: string }[]; // 合入的其他身体的提交
  resolved: { file: string; kept: "local" | "remote"; how: string }[]; // 自动解决的冲突
}

export class SoulRepo {
  status = { lastPull: 0, lastPush: 0, lastError: "" };
  o: SoulRepoOptions;
  constructor(o: SoulRepoOptions) { this.o = o; }

  private p = (...a: string[]) => path.join(this.o.dir, ...a);
  private ref = () => `origin/${this.o.branch}`;
  git(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const env = { ...process.env };
    // 规范 §7：只使用本身体专属的部署私钥，不回退到 ssh-agent 或默认密钥
    env.GIT_SSH_COMMAND = `ssh -i ${this.o.sshKey} -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new`;
    delete env.SSH_AUTH_SOCK;
    env.GIT_TERMINAL_PROMPT = "0";
    return new Promise((resolve) => execFile("git", ["-C", this.o.dir, ...args], { env, timeout: 120_000, maxBuffer: 16 << 20 }, (e: any, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err || e?.message || "") })));
  }

  get exists() { return fs.existsSync(this.p(".git")); }

  /** 访问远端前的检查：SSH 地址 + 私钥存在。 */
  private remoteReady(): boolean {
    if (!this.o.remote) return false;
    const bad = checkRemote(this.o.remote);
    if (bad) { this.status.lastError = bad; return false; }
    if (!isLocal(this.o.remote) && !fs.existsSync(this.o.sshKey)) { this.status.lastError = `缺少部署私钥 ${this.o.sshKey}，拒绝访问远端`; return false; }
    return true;
  }

  /** 规范 §4：补齐固定与必需的条目。返回是否有改动。 */
  scaffold(): boolean {
    let changed = false;
    const put = (rel: string, text: string, overwrite = false) => {
      const f = this.p(rel);
      if (fs.existsSync(f) && (!overwrite || fs.readFileSync(f, "utf8") === text)) return;
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); changed = true;
    };
    for (const [rel, text] of Object.entries(FIXED_FILES)) put(rel, text, true);
    if (!fs.existsSync(this.p("agent.json")) && this.o.seedIdentity) put("agent.json", JSON.stringify(this.o.seedIdentity(), null, 2) + "\n");
    const name = (this.readJson("agent.json")?.displayName as string) ?? "agent";
    put("README.md", README_TEMPLATE(name), true);
    if (this.o.seedSoul) put("SOUL.md", this.o.seedSoul(name));
    put("memories/MEMORY.md", ""); put("memories/USER.md", "");
    for (const d of ["journal", "notes", "bodies"]) if (!fs.existsSync(this.p(d)) || !fs.readdirSync(this.p(d)).length) put(`${d}/.gitkeep`, "");
    return changed;
  }

  /** 规范检查：顶层条目（警告）与暂存区文件内容（错误，阻止提交）。 */
  async lint(): Promise<{ errors: string[]; warnings: string[] }> {
    const warnings = fs.readdirSync(this.o.dir).filter((e) => !TOP_LEVEL.has(e)).map((e) => `顶层出现规范外的条目：${e}`);
    const staged = (await this.git("diff", "--cached", "--name-only", "-z", "--diff-filter=AM")).out.split("\0").filter(Boolean); // -z：保留中文等非 ASCII 文件名
    const errors = staged.flatMap((f) => { try { return lintContent(f, fs.readFileSync(this.p(f))); } catch { return []; } });
    return { errors, warnings };
  }


  /** 克隆远端；远端不可用或未配置时本地初始化。 */
  async ensure(): Promise<"cloned" | "initialized" | "existing"> {
    if (this.exists) { await this.configure(); if (this.scaffold()) await this.commit("补齐灵魂仓库规范结构"); return "existing"; }
    fs.mkdirSync(path.dirname(this.o.dir), { recursive: true });
    if (this.remoteReady()) {
      fs.rmSync(this.o.dir, { recursive: true, force: true });
      const r = await new SoulRepo({ ...this.o, dir: path.dirname(this.o.dir) }).git("clone", "-b", this.o.branch, this.o.remote, this.o.dir);
      if (r.code === 0) { await this.configure(); if (this.scaffold()) await this.commit("补齐灵魂仓库规范结构"); return "cloned"; }
      // 空仓库没有分支时 clone -b 会失败：改为不指定分支再试
      const r2 = await new SoulRepo({ ...this.o, dir: path.dirname(this.o.dir) }).git("clone", this.o.remote, this.o.dir);
      if (r2.code === 0) { await this.git("checkout", "-B", this.o.branch); await this.configure(); if (this.scaffold()) await this.commit("补齐灵魂仓库规范结构"); return "cloned"; }
      this.o.log?.(`克隆失败，改为本地初始化：${r2.err.slice(0, 200)}`);
    }
    fs.mkdirSync(this.o.dir, { recursive: true });
    await this.git("init", "-b", this.o.branch);
    await this.configure();
    this.scaffold();
    await this.commit("补齐灵魂仓库规范结构");
    return "initialized";
  }

  async configure() {
    const a = this.o.author();
    await this.git("config", "user.name", a.name);
    await this.git("config", "user.email", a.email);
    await this.git("remote", "remove", "origin");
    if (this.o.remote) await this.git("remote", "add", "origin", this.o.remote);
  }

  touchBody() {
    const f = this.p("bodies", `${this.o.body}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ body: this.o.body, ...this.o.bodyInfo?.(), lastSeen: new Date().toISOString() }, null, 2) + "\n");
  }

  /** 提交前按规范 §6 检查；命中禁止内容时拒绝提交（撤回暂存，工作区保持不变以便修正）。 */
  async commit(msg: string) {
    await this.git("add", "-A");
    const { errors, warnings } = await this.lint();
    for (const w of warnings) this.o.log?.(w);
    if (errors.length) {
      await this.git("reset", "-q");
      this.status.lastError = `拒绝提交（规范 §6 禁止内容）：${errors.join("；")}`;
      this.o.log?.(this.status.lastError);
      return false;
    }
    return (await this.git("commit", "-m", `${msg}（${this.o.body}）`)).code === 0;
  }

  private readJson(rel: string): any { try { return JSON.parse(fs.readFileSync(this.p(rel), "utf8")); } catch { return undefined; } }

  private async guardIdentity(): Promise<boolean> {
    const r = await this.git("show", `${this.ref()}:agent.json`);
    if (r.code !== 0) return true;
    let theirs: { id?: string };
    try { theirs = JSON.parse(r.out); } catch { return true; }
    const mine = this.readJson("agent.json");
    if (!mine?.id || !theirs.id || theirs.id === mine.id) return true;
    if (mine.seed) { fs.writeFileSync(this.p("agent.json"), r.out); await this.commit("采用灵魂仓库中的身份"); return true; }
    this.status.lastError = `灵魂仓库属于另一个 agent（${theirs.id.slice(0, 8)}），与本地（${String(mine.id).slice(0, 8)}）不同，已拒绝同步`;
    this.o.log?.(this.status.lastError);
    return false;
  }

  /** 拉取并合并远端，冲突全自动解决。 */
  async pull(): Promise<PullResult> {
    const none: PullResult = { merged: false, incoming: [], resolved: [] };
    if (!this.remoteReady()) return none;
    await this.configure();
    const f = await this.git("fetch", "origin", this.o.branch);
    if (f.code !== 0) {
      if (/couldn't find remote ref/i.test(f.err)) return none; // 远端还是空仓库
      this.status.lastError = f.err.slice(0, 300); return none;
    }
    const behind = await this.git("rev-list", "--count", `HEAD..${this.ref()}`);
    if (behind.code === 0 && behind.out.trim() === "0") { this.status.lastPull = Date.now(); this.status.lastError = ""; return none; }
    await this.commit("拉取前保存");
    if (!(await this.guardIdentity())) return none;
    const incoming = (await this.git("log", "--pretty=format:%an%x1f%s", `HEAD..${this.ref()}`)).out.split("\n").filter(Boolean)
      .map((l) => { const [a, s] = l.split("\x1f"); return { body: a.match(/\(([^)]+)\)\s*$/)?.[1] ?? a, subject: s }; });
    const resolved: PullResult["resolved"] = [];
    const m = await this.git("merge", "--no-edit", "--allow-unrelated-histories", this.ref());
    if (m.code !== 0) {
      const time = async (rev: string, file: string) => Number((await this.git("log", "-1", "--format=%ct", rev, "--", file)).out.trim() || 0);
      const conflicted = (await this.git("diff", "--name-only", "-z", "--diff-filter=U")).out.split("\0").filter(Boolean);
      for (const file of conflicted) {
        const show = async (stage: number) => (await this.git("show", `:${stage}:${file}`)).out;
        const abs = this.p(file);
        const ours = await show(2), theirs = await show(3);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (file.startsWith("memories/")) {
          fs.writeFileSync(abs, mergeEntries(await show(1), ours, theirs));
          resolved.push({ file, kept: "local", how: "条目合并：双方新增都保留" });
        } else if (file === "agent.json") {
          const j = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
          fs.writeFileSync(abs, JSON.stringify({ ...j(theirs), ...j(ours) }, null, 2) + "\n");
          resolved.push({ file, kept: "local", how: "字段合并" });
        } else {
          const remoteNewer = !ours.trim() || (file === "SOUL.md" && this.o.isSeedSoul?.(ours)) || (await time(this.ref(), file)) > (await time("HEAD", file));
          fs.writeFileSync(abs, remoteNewer ? theirs : ours);
          resolved.push({ file, kept: remoteNewer ? "remote" : "local", how: "采用较新的版本，另一版本保留在历史中" });
        }
      }
      await this.commit("合并来自其他身体的记忆");
    }
    this.status.lastPull = Date.now(); this.status.lastError = "";
    return { merged: true, incoming, resolved };
  }

  async push(msg: string) {
    this.touchBody();
    const changed = await this.commit(msg);
    if (!this.remoteReady() || this.status.lastError.startsWith("拒绝提交")) return;
    let r = await this.git("push", "origin", `HEAD:${this.o.branch}`);
    if (r.code !== 0 && (await this.pull()).merged) r = await this.git("push", "origin", `HEAD:${this.o.branch}`);
    if (r.code !== 0) this.status.lastError = r.err.slice(0, 300);
    else if (changed) { this.status.lastPush = Date.now(); this.status.lastError = ""; }
  }

  // ---------- 整理租约
  private lease = () => this.readJson("locks/consolidation.json") as { body: string; until: number } | undefined;
  async acquireLease(): Promise<boolean> {
    if (!this.remoteReady()) return true;
    for (let i = 0; i < 2; i++) {
      await this.pull();
      const cur = this.lease();
      if (cur && cur.body !== this.o.body && cur.until > Date.now()) return false;
      fs.mkdirSync(this.p("locks"), { recursive: true });
      fs.writeFileSync(this.p("locks", "consolidation.json"), JSON.stringify({ body: this.o.body, until: Date.now() + LEASE_MS }) + "\n");
      await this.commit("取得整理记忆的租约");
      if ((await this.git("push", "origin", `HEAD:${this.o.branch}`)).code === 0) return true;
    }
    return false;
  }
  async releaseLease() { if (this.lease()?.body === this.o.body) fs.rmSync(this.p("locks", "consolidation.json"), { force: true }); }

  // ---------- 历史
  async history(limit = 50) {
    const r = await this.git("log", `-${limit}`, "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s", "--shortstat");
    const out: { hash: string; short: string; author: string; ts: number; subject: string; stat: string }[] = [];
    for (const block of r.out.split(/\n(?=[0-9a-f]{40}\x1f)/)) {
      const [head, stat = ""] = block.split("\n").filter(Boolean);
      if (!head) continue;
      const [hash, short, author, at, subject] = head.split("\x1f");
      out.push({ hash, short, author, ts: Number(at) * 1000, subject, stat: stat.trim() });
    }
    return out;
  }
  async show(hash: string) {
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("提交号无效");
    return (await this.git("show", "--stat", "--patch", "--no-color", hash)).out.slice(0, 20000);
  }
  async revert(hash: string) {
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("提交号无效");
    const r = await this.git("revert", "--no-edit", hash);
    if (r.code !== 0) { await this.git("revert", "--abort"); throw new Error(`无法自动撤销：${r.err.slice(0, 200)}`); }
    await this.push(`撤销 ${hash.slice(0, 7)}`);
  }
}
