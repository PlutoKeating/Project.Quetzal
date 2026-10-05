// 灵魂仓库协议（与运行时配置无关）：运行基座与桥接模块共用同一套同步与冲突规则。
// 规范见 docs/SOUL_REPO_SPEC.md（目录树、固定内容、文件格式、SSH 私钥认证；内容不做任何检查），设计见 docs/SOUL_SYNC.md。
//   - 身份守卫：agent.json 的 id 不同的仓库拒绝合并（本地仍是种子身份时采用远端身份）
//   - 冲突自动解决，仓库不会卡住：memories/*.md 条目级三方合并；agent.json 字段级合并；
//     其他文件（SOUL.md、笔记……）先以提交时间较新的一方为准（本地为空或仍是种子人格时采用对方）；两边都真的改过的文本文件，
//     落选的一版另存为 *.incoming.md 副本（不入库），由调用方交给 agent 裁决。落选版本也完整保存在 git 历史中。
//     每次合入的内容与冲突处理结果都会返回给调用方，作为 agent 的知觉。
//   - 身体登记：bodies/<身体>.json
//   - 整理租约：locks/consolidation.json，git push 成功即取得（比较并交换）
//   - git 的安全边界（规范 v10 §5.2）：灵魂目录里的东西可能被 agent 改过，所以每次调用 git 都不执行钩子、不用 fsmonitor、不读系统与全局配置、
//     不跟 file:// 协议；.git/config 里白名单以外的键（url.*.insteadOf、core.sshCommand、filter.* 等）在操作前删掉；推送与拉取直接用配置里的地址，
//     不经 origin；不检出、不提交、不合并符号链接；提交前检查暂存的改动里有没有这具身体的密钥（secrets 选项），有就拒绝提交并提醒。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { mergeEntries } from "./entries.ts";

export interface SoulRepoOptions {
  statusFile?: string; // 同步状态的落盘位置（可选）：lastPull / lastPush / lastError
  dir: string; remote: string; branch: string; body: string;
  sshKey?: string; // 访问远端用的私钥（规范 §7）：本身体专属的部署私钥或使用者指定的私钥，必须存在且只用它；不给（undefined）= 交给系统的 ssh 配置与 ssh-agent
  seedIdentity?: () => object; // agent.json 缺失时生成的身份
  seedSoul?: (displayName: string) => string; // SOUL.md 缺失时生成的人格
  author: () => { name: string; email: string };
  isSeedSoul?: (text: string) => boolean; // 判断 SOUL.md 是否仍是种子人格
  bodyInfo?: () => Record<string, unknown>; // 写入 bodies/<身体>.json 的额外信息
  log?: (msg: string) => void;
  secrets?: () => string[]; // 这具身体的密钥值（令牌、私钥、Key……）：暂存的改动里出现任何一个就拒绝提交（规范 v10 §5.2）
  onSecret?: (files: string[]) => void; // 因为密钥拒绝提交时通知调用方（提醒 agent）
}

/** 私钥路径必须是绝对路径、不含控制字符（它会进入 GIT_SSH_COMMAND）。返回错误说明或 undefined。 */
export function checkKeyPath(p: string): string | undefined {
  if (!path.isAbsolute(p)) return `私钥路径必须是绝对路径：${p}`;
  if (/[\x00-\x1f\x7f]/.test(p)) return "私钥路径里有控制字符";
  return undefined;
}
/** 按 POSIX shell 规则加单引号（GIT_SSH_COMMAND 由 shell 解析）。 */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** .git/config 里允许保留的键（其余在操作前删掉：url.*.insteadOf / pushInsteadOf 会把推送改到别处，core.sshCommand、filter.*、diff.*.textconv 等会执行命令）。 */
const CONFIG_KEEP = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|user\.(name|email)|remote\.origin\.(url|fetch)|branch\.[^.]+\.(remote|merge)|extensions\.[a-z]+|init\.defaultbranch)$/i;

const LEASE_MS = 30 * 60_000;
/** 灵魂仓库里允许出现的顶层条目（规范 §2 的固定与必需条目，加上新建仓库常见的 README、LICENSE）。远端没有 agent.json 时据此判断它是不是灵魂仓库。 */
const SOUL_TOP = new Set([".soul-spec.json", ".gitattributes", ".gitignore", "README.md", "README", "LICENSE", "agent.json", "SOUL.md", "memories", "journal", "notes", "bodies", "skills", "locks", ".gitkeep"]);
export const SPEC = { spec: "soul-repo", version: 10 };
const MAX_FILE = 1 << 20;
export const FIXED_FILES: Record<string, string> = {
  ".soul-spec.json": JSON.stringify(SPEC, null, 2) + "\n",
  ".gitattributes": "* text=auto eol=lf\n*.md text diff=markdown\n*.json text\n",
  ".gitignore": "*.tmp\n*.swp\n.DS_Store\n*.incoming*.md\n",
};
export const README_TEMPLATE = (displayName: string) => `# ${displayName} · 灵魂仓库

这是 agent「${displayName}」的灵魂仓库：身份、人格与记忆。它的所有身体（运行基座、Hermes Agent、OpenClaw……）都通过这个仓库全自动同步。

- **必须保持私有。** 这个仓库由部署者自己创建，只属于这一个 agent，只存放它的灵魂。
- 它与任何代码仓库都没有关系，包括运行 agent 的程序（Quetzal）的源代码仓库：不要把程序代码放进来，也不要把这里的内容推到别处。
- 请不要手动修改，也不要在它的克隆里手动运行 git：同步、合并与版本管理由基座自动完成；需要撤销时，使用控制台的「记忆历史」。
- 结构与格式遵循灵魂仓库规范 v${SPEC.version}（https://quetzal.plutokeating.beer/zh/docs/reference/soul-repo-spec）。
`;

/** 规范 §7：远端必须是 SSH 地址（测试中可用 SOUL_ALLOW_LOCAL_REMOTE=1 放行本地路径）。返回错误说明或 undefined。 */
export function checkRemote(remote: string): string | undefined {
  if (!remote) return undefined;
  if (/^(git@[\w.-]+:[\w.-]+\/[\w.-]+|ssh:\/\/[\w.-]+@[\w.-]+(:\d+)?\/)/.test(remote)) return undefined;
  if (process.env.SOUL_ALLOW_LOCAL_REMOTE === "1" && (remote.startsWith("/") || remote.startsWith("file://"))) return undefined;
  return "灵魂仓库必须使用 SSH 地址（如 git@github.com:<用户>/<agent>.soul.git），并通过本身体专属的部署私钥访问；不允许 HTTPS、令牌或密码";
}
const isLocal = (remote: string) => remote.startsWith("/") || remote.startsWith("file://");

/** 规范 §6：灵魂仓库是私有仓库，内容不做任何脱敏或隐私检查，不会因内容拒绝提交。只对会拖慢 git 的东西提醒（不拦）。 */
export function lintContent(file: string, buf: Buffer): string[] {
  const out: string[] = [];
  if (buf.length > MAX_FILE) out.push(`${file}：超过 1 MiB，建议改放别处`);
  if (buf.includes(0)) out.push(`${file}：二进制文件，git 不擅长保存`);
  return out;
}

export interface PullResult {
  merged: boolean;
  incoming: { body: string; subject: string }[]; // 合入的其他身体的提交
  // 自动解决的冲突。incoming：两边都改过的文本文件，落选的那一版另存的副本（相对路径，*.incoming.md，不入库），留给 agent 裁决
  resolved: { file: string; kept: "local" | "remote"; how: string; incoming?: string }[];
}

/** 推送的结果。kind：失败的类别——network（网络，值得静默重试）、auth（部署密钥被拒）、hostkey、notfound、identity（远端属于另一个 agent）、config（地址或私钥配置有误）、rejected（拉取合并后仍被拒）、other。 */
export interface PushResult { ok: boolean; pushed: boolean; kind?: "network" | "auth" | "hostkey" | "notfound" | "identity" | "config" | "rejected" | "other"; error?: string }

export function gitErrorKind(err: string): NonNullable<PushResult["kind"]> {
  if (/Permission denied \(publickey\)|Could not read from remote repository|Authentication failed|ERROR: .*(key|access)/i.test(err)) return "auth";
  if (/Could not resolve hostname|Network is unreachable|Connection timed out|Connection refused|Connection reset|Operation timed out|timed out|Temporary failure in name resolution|kex_exchange_identification|Connection closed by|early EOF|The remote end hung up/i.test(err)) return "network";
  if (/Host key verification failed/i.test(err)) return "hostkey";
  if (/Repository not found|does not appear to be a git repository/i.test(err)) return "notfound";
  if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i.test(err)) return "rejected";
  return "other";
}

/** 冲突时落选版本的副本路径：x.md → x.incoming.md（规范 §3.3 的 .gitignore 忽略 *.incoming*.md，不会被提交）。非 .md 文件不另存。 */
export const incomingPath = (file: string) => (file.endsWith(".md") ? `${file.slice(0, -3)}.incoming.md` : undefined);

/** 把 git / ssh 的原始报错翻译成使用者看得懂的一句话（原文截断附在后面，便于排查）。 */
export function friendlyGitError(err: string): string {
  const raw = err.trim().replace(/\s+/g, " ").slice(0, 200);
  if (/Permission denied \(publickey\)|Could not read from remote repository/i.test(err)) return `远端拒绝了本机的部署公钥：请把「本机的访问密钥」里的公钥添加到灵魂仓库的 Deploy keys（勾选允许写入）。原文：${raw}`;
  if (/Could not resolve hostname|Network is unreachable|Connection timed out|Connection refused/i.test(err)) return `连不上灵魂仓库所在的服务器（网络或地址问题）。原文：${raw}`;
  if (/Host key verification failed/i.test(err)) return `服务器的主机密钥与之前记录的不一致，已拒绝连接（known_hosts）。原文：${raw}`;
  if (/Repository not found|does not appear to be a git repository/i.test(err)) return `远端没有这个仓库，或这把部署密钥没有它的访问权。原文：${raw}`;
  return raw;
}

export class SoulRepo {
  // 同步状态落在 statusFile（有的话），重启后页面上的「上次拉取 / 上次推送」不会归零；任何字段一改就写盘
  status: { lastPull: number; lastPush: number; lastError: string };
  o: SoulRepoOptions;
  constructor(o: SoulRepoOptions) {
    this.o = o;
    let init = { lastPull: 0, lastPush: 0, lastError: "" };
    if (o.statusFile) { try { init = { ...init, ...JSON.parse(fs.readFileSync(o.statusFile, "utf8")) }; } catch {} }
    this.status = this.tracked(init);
  }
  private tracked(s: { lastPull: number; lastPush: number; lastError: string }) {
    return new Proxy(s, { set: (t, k, v) => { (t as any)[k] = v; this.persistStatus(); return true; } });
  }
  private persistStatus() {
    const f = this.o.statusFile; if (!f) return;
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ lastPull: this.status.lastPull, lastPush: this.status.lastPush, lastError: this.status.lastError })); } catch {}
  }

  private p = (...a: string[]) => path.join(this.o.dir, ...a);
  private ref = () => `origin/${this.o.branch}`;
  git(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const env = { ...process.env };
    // 不读系统与全局配置（~/.gitconfig 里的 url.*.insteadOf 等也能改写地址）
    env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = "/dev/null";
    delete env.GIT_CONFIG_PARAMETERS; delete env.GIT_CONFIG_COUNT; delete env.GIT_DIR; delete env.GIT_WORK_TREE;
    if (this.o.sshKey) {
      // 规范 §7：只使用指定的这把私钥（本身体专属的部署私钥，或使用者指定的私钥），不回退到 ssh-agent 或默认密钥；~/.ssh/config 里的 Host 别名、HostName、Port 仍然生效
      const bad = checkKeyPath(this.o.sshKey);
      if (bad) return Promise.resolve({ code: 1, out: "", err: bad });
      env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(this.o.sshKey)} -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=accept-new`;
      delete env.SSH_AUTH_SOCK;
    } else {
      // 系统 ssh 配置：钥匙由 ~/.ssh/config（IdentityFile）与 ssh-agent 决定
      env.GIT_SSH_COMMAND = "ssh -o StrictHostKeyChecking=accept-new";
    }
    env.GIT_TERMINAL_PROMPT = "0";
    // 只在灵魂目录里找仓库：它的 .git 万一丢了，git 也不会往上层目录找、在外面某个代码仓库里提交和推送
    env.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(this.o.dir));
    // 不执行钩子、不用 fsmonitor（都能执行任意命令）、不跟 file:// 与 ext:: 协议、符号链接按普通文件检出（测试用本地路径做远端时放行 file）
    const safety = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.symlinks=false", "-c", "protocol.ext.allow=never",
      "-c", `protocol.file.allow=${process.env.SOUL_ALLOW_LOCAL_REMOTE === "1" ? "always" : "never"}`];
    return new Promise((resolve) => execFile("git", [...safety, "-C", this.o.dir, ...args], { env, timeout: 120_000, maxBuffer: 16 << 20 }, (e: any, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err || e?.message || "") })));
  }

  get exists() { return fs.existsSync(this.p(".git")); }

  /** 访问远端前的检查：SSH 地址 + 私钥存在。 */
  private remoteReady(): boolean {
    if (!this.o.remote) return false;
    const bad = checkRemote(this.o.remote);
    if (bad) { this.status.lastError = bad; return false; }
    if (!isLocal(this.o.remote) && this.o.sshKey && !fs.existsSync(this.o.sshKey)) { this.status.lastError = `私钥 ${this.o.sshKey} 不存在，拒绝访问远端（在「灵魂同步」页生成部署密钥、改用别的私钥，或改用系统 ssh 配置）`; return false; }
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

  /** 提交前的提醒（只记日志，从不阻止提交）：过大或二进制的文件。顶层多出的目录是她自己的（规范 §1），不提醒。 */
  async lint(): Promise<string[]> {
    const staged = (await this.git("diff", "--cached", "--name-only", "-z", "--diff-filter=AM")).out.split("\0").filter(Boolean); // -z：保留中文等非 ASCII 文件名
    return staged.flatMap((f) => { try { return lintContent(f, fs.readFileSync(this.p(f))); } catch { return []; } });
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

  /** 推送前确认 origin 仍是配置里的灵魂仓库地址：有人在灵魂目录里手动改了它（例如 agent 用 shell），就改回来并提醒。推送本身直接用配置里的地址，不依赖它。 */
  private async ensureOrigin() {
    const cur = (await this.git("remote", "get-url", "origin")).out.trim();
    if (cur === this.o.remote) return;
    if (cur) this.o.log?.(`灵魂目录的 origin 被改成了别的地址，已改回配置里的灵魂仓库（灵魂同步由基座管理，不要手动改）`);
    await this.configure();
  }

  async configure() {
    const a = this.o.author();
    await this.git("config", "user.name", a.name);
    await this.git("config", "user.email", a.email);
    await this.git("remote", "remove", "origin");
    if (this.o.remote) await this.git("remote", "add", "origin", this.o.remote);
  }

  /** 更新身体登记 bodies/<身体>.json。触碰即同步之后推送很频繁，所以只在登记内容变了或 lastSeen 超过 1 小时时才改写，免得每次推送都多一个提交（规范 v8 §3.10）。 */
  touchBody() {
    const f = this.p("bodies", `${this.o.body}.json`);
    const info = { body: this.o.body, ...this.o.bodyInfo?.() };
    const cur = this.readJson(`bodies/${this.o.body}.json`) as Record<string, unknown> | undefined;
    if (cur) {
      const { lastSeen, ...rest } = cur;
      const fresh = Date.now() - Date.parse(String(lastSeen)) < 3_600_000;
      if (fresh && JSON.stringify(rest) === JSON.stringify(info)) return false;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...info, lastSeen: new Date().toISOString() }, null, 2) + "\n");
    return true;
  }

  /** 工作区里有变化的文件（相对路径，含新增与删除；重命名取新路径）。被 .gitignore 忽略的不算。 */
  async changes(): Promise<string[]> {
    const r = await this.git("status", "--porcelain=v1", "-z", "--untracked-files=all");
    if (r.code !== 0) return [];
    const parts = r.out.split("\0"), out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]; if (e.length < 4) continue;
      out.push(e.slice(3));
      if (e[0] === "R" || e[0] === "C") i++; // 重命名 / 复制：下一项是原路径
    }
    return out;
  }

  /** 删掉 .git/config 里白名单以外的键（见 CONFIG_KEEP）。返回删掉的键。 */
  async sanitizeConfig(): Promise<string[]> {
    if (!this.exists) return [];
    const r = await this.git("config", "--local", "--no-includes", "--name-only", "--list");
    if (r.code !== 0) return [];
    const bad = [...new Set(r.out.split("\n").map((x) => x.trim()).filter((k) => k && !CONFIG_KEEP.test(k)))];
    for (const k of bad) await this.git("config", "--local", "--unset-all", k);
    if (bad.length) this.o.log?.(`灵魂目录的 .git/config 里有不该有的设置，已删除：${bad.slice(0, 5).join("、")}`);
    return bad;
  }

  /** 暂存区里的符号链接（mode 120000）：从暂存区拿掉，不提交（规范 v10 §5.2）。返回拿掉的路径。 */
  private async dropSymlinks(): Promise<string[]> {
    const r = await this.git("ls-files", "-s", "-z");
    const links = r.out.split("\0").filter((l) => l.startsWith("120000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
    if (links.length) { await this.git("rm", "--cached", "-q", "--", ...links); this.o.log?.(`灵魂仓库不收符号链接，没有提交：${links.slice(0, 5).join("、")}`); }
    return links;
  }

  /** 暂存的改动（新增的行）里出现的密钥：返回涉及的文件。 */
  async stagedSecrets(): Promise<string[]> {
    const values = (this.o.secrets?.() ?? []).filter((v) => v.length >= 12);
    if (!values.length) return [];
    const r = await this.git("diff", "--cached", "--text", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames");
    const hits = new Set<string>();
    let file = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, ""); continue; }
      if (line.startsWith("+") && values.some((v) => line.includes(v))) hits.add(file);
    }
    return [...hits];
  }

  /**
   * 提交全部变更。灵魂仓库是私有的，内容不做检查（规范 §6），只有一个例外：这具身体自己的密钥（令牌、私钥、Key）出现在暂存的改动里就拒绝整个提交，
   * 留在工作区等她删掉（规范 v10 §5.2）。scan=false 只用于合并提交（内容来自远端，本地改动在合并前已经单独提交并检查过）。
   */
  async commit(msg: string, o: { scan?: boolean } = {}) {
    await this.sanitizeConfig();
    await this.git("add", "-A");
    await this.dropSymlinks();
    if (o.scan !== false) {
      const leaked = await this.stagedSecrets();
      if (leaked.length) {
        if ((await this.git("reset", "-q")).code !== 0) await this.git("rm", "-r", "--cached", "-q", "--ignore-unmatch", "."); // 还没有任何提交时 reset 不了
        this.status.lastError = `没有提交：${leaked.slice(0, 3).join("、")} 里有这具身体的密钥（令牌、私钥或 Key），删掉后才会同步`;
        this.o.log?.(this.status.lastError);
        this.o.onSecret?.(leaked);
        return false;
      }
    }
    for (const w of await this.lint()) this.o.log?.(w);
    return (await this.git("commit", "-m", `${msg}（${this.o.body}）`)).code === 0;
  }

  private readJson(rel: string): any { try { return JSON.parse(fs.readFileSync(this.p(rel), "utf8")); } catch { return undefined; } }

  private async guardIdentity(): Promise<boolean> {
    const r = await this.git("show", `${this.ref()}:agent.json`);
    if (r.code !== 0) {
      // 远端没有 agent.json：刚建的空仓库（只有 README、LICENSE 之类）可以接入；有规范以外的顶层内容（例如一个代码仓库）就不是灵魂仓库，拒绝合并——
      // 否则会把别的仓库的历史并进灵魂，并把记忆推到那里（曾经发生过：agent 用 shell 把 origin 改成了代码仓库）
      const top = (await this.git("ls-tree", "--name-only", this.ref())).out.split("\n").filter(Boolean);
      const foreign = top.filter((n) => !SOUL_TOP.has(n));
      if (!foreign.length) return true;
      this.status.lastError = `远端不是灵魂仓库（没有 agent.json，却有 ${foreign.slice(0, 3).join("、")}${foreign.length > 3 ? " 等" : ""}），已拒绝合并：请检查灵魂仓库地址`;
      this.o.log?.(this.status.lastError);
      return false;
    }
    let theirs: { id?: string };
    try { theirs = JSON.parse(r.out); } catch { return true; }
    const mine = this.readJson("agent.json");
    if (!mine?.id || !theirs.id || theirs.id === mine.id) return true;
    if (mine.seed) { fs.writeFileSync(this.p("agent.json"), r.out); await this.commit("采用灵魂仓库中的身份"); return true; }
    this.status.lastError = `灵魂仓库属于另一个 agent（${theirs.id.slice(0, 8)}），与本地（${String(mine.id).slice(0, 8)}）不同，已拒绝同步`;
    this.o.log?.(this.status.lastError);
    return false;
  }

  // ---------- 历史完整性：灵魂仓库只能有它自己的历史
  // 每个克隆记下灵魂仓库已知的根提交（.git/quetzal-soul-roots.json，连同远端地址；身份与「是不是灵魂仓库」的检查通过后才记录）。
  // 之后本地或远端出现陌生的根提交，说明有别的仓库的历史混了进来（例如有人在灵魂目录里 reset 到一个代码仓库）：停止同步，不合并、不推送，等人处理。
  // 部署者换了灵魂仓库地址时重新记录（换到一个新建的仓库是正常的；填错成代码仓库由「不是灵魂仓库」的检查拦下）。
  private rootsFile = () => this.p(".git", "quetzal-soul-roots.json");
  private async rootsOf(rev: string): Promise<string[]> {
    const r = await this.git("rev-list", "--max-parents=0", rev);
    return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
  }
  private known(): string[] | undefined {
    try { const k = JSON.parse(fs.readFileSync(this.rootsFile(), "utf8")); return k.remote === this.o.remote && Array.isArray(k.roots) ? k.roots : undefined; } catch { return undefined; }
  }
  private async recordRoots(revs: string[]) {
    const roots = new Set([...(this.known() ?? []), ...(await Promise.all(revs.map((r) => this.rootsOf(r)))).flat()]);
    if (roots.size) fs.writeFileSync(this.rootsFile(), JSON.stringify({ remote: this.o.remote, roots: [...roots].sort(), at: new Date().toISOString() }, null, 2) + "\n");
  }
  /** 检查这些引用的历史里有没有陌生的根提交；返回错误说明，正常（或还没有记录）为 undefined。 */
  async foreignHistory(revs: string[]): Promise<string | undefined> {
    const known = this.known();
    if (!known) return undefined;
    const roots = [...new Set((await Promise.all(revs.map((r) => this.rootsOf(r)))).flat())];
    const foreign = roots.filter((r) => !known.includes(r));
    if (!foreign.length) return undefined;
    return `灵魂仓库的历史里混进了别的仓库（陌生的根提交 ${foreign.map((f) => f.slice(0, 7)).join("、")}），已停止同步：不合并、不推送。可能有人在灵魂目录里手动操作了 git，或远端被推入了别的历史；需要人检查（干净的做法是重新克隆灵魂仓库）`;
  }

  /** 拉取并合并远端，冲突全自动解决。 */
  async pull(): Promise<PullResult> {
    const none: PullResult = { merged: false, incoming: [], resolved: [] };
    if (!this.remoteReady()) return none;
    await this.configure();
    // 直接用配置里的地址，不经 origin（.git/config 被改过也不会从别处拉）
    const f = await this.git("fetch", "--no-tags", this.o.remote, `+refs/heads/${this.o.branch}:refs/remotes/origin/${this.o.branch}`);
    if (f.code !== 0) {
      if (/couldn't find remote ref/i.test(f.err)) return none; // 远端还是空仓库
      this.status.lastError = friendlyGitError(f.err); return none;
    }
    const foreign = await this.foreignHistory(["HEAD", this.ref()]);
    if (foreign) { this.status.lastError = foreign; this.o.log?.(foreign); return none; }
    const behind = await this.git("rev-list", "--count", `HEAD..${this.ref()}`);
    if (behind.code === 0 && behind.out.trim() === "0") {
      if (!this.known()) await this.recordRoots(["HEAD", this.ref()]);
      this.status.lastPull = Date.now(); this.status.lastError = ""; return none;
    }
    if (!(await this.commit("拉取前保存")) && /有这具身体的密钥/.test(this.status.lastError)) return none; // 本地有没提交的密钥：先不合并，免得混进合并提交
    const links = (await this.git("ls-tree", "-r", "-z", this.ref())).out.split("\0").filter((l) => l.startsWith("120000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
    if (links.length) { this.status.lastError = `远端的灵魂仓库里有符号链接（${links.slice(0, 3).join("、")}），已拒绝合并：灵魂仓库只放普通文件（规范 v10 §5.2）`; this.o.log?.(this.status.lastError); return none; }
    if (!(await this.guardIdentity())) return none;
    if (!this.known()) await this.recordRoots(["HEAD", this.ref()]); // 身份与「是不是灵魂仓库」都检查过了：记下这两段历史的根
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
          const seed = !ours.trim() || (file === "SOUL.md" && !!this.o.isSeedSoul?.(ours));
          const remoteNewer = seed || (await time(this.ref(), file)) > (await time("HEAD", file));
          fs.writeFileSync(abs, remoteNewer ? theirs : ours);
          // 两边都真的改过（不是本地还空着或仍是种子）：落选的一版另存为副本，留给 agent 裁决；仓库先按较新的一版继续，不会卡住
          const copy = seed || !ours.trim() || !theirs.trim() || ours === theirs ? undefined : incomingPath(file);
          if (copy) fs.writeFileSync(this.p(copy), remoteNewer ? ours : theirs);
          resolved.push({ file, kept: remoteNewer ? "remote" : "local", how: copy ? "暂时采用较新的版本，另一版另存为副本待裁决" : "采用较新的版本，另一版本保留在历史中", ...(copy ? { incoming: copy } : {}) });
        }
      }
      await this.commit("合并来自其他身体的记忆", { scan: false });
    }
    this.status.lastPull = Date.now(); this.status.lastError = "";
    return { merged: true, incoming, resolved };
  }

  /** 提交剩余的变更并推送。被拒（远端有新提交）时拉取合并后再推一次。没有配置远端时只在本地提交，算成功。 */
  async push(msg: string): Promise<PushResult> {
    this.touchBody();
    await this.commit(msg);
    if (!this.o.remote) return { ok: true, pushed: false };
    if (!this.remoteReady()) return { ok: false, pushed: false, kind: "config", error: this.status.lastError };
    await this.ensureOrigin();
    const foreign = await this.foreignHistory(["HEAD"]);
    if (foreign) { this.status.lastError = foreign; this.o.log?.(foreign); return { ok: false, pushed: false, kind: "identity", error: foreign }; }
    let r = await this.git("push", this.o.remote, `HEAD:refs/heads/${this.o.branch}`);
    if (r.code !== 0 && gitErrorKind(r.err) === "rejected") {
      const pulled = await this.pull();
      if (!pulled.merged && this.status.lastError) return { ok: false, pushed: false, kind: /另一个 agent|不是灵魂仓库|混进了别的仓库/.test(this.status.lastError) ? "identity" : gitErrorKind(this.status.lastError), error: this.status.lastError };
      r = await this.git("push", this.o.remote, `HEAD:refs/heads/${this.o.branch}`);
    }
    if (r.code !== 0) { this.status.lastError = friendlyGitError(r.err); return { ok: false, pushed: false, kind: gitErrorKind(r.err), error: this.status.lastError }; }
    await this.git("update-ref", `refs/remotes/${this.ref()}`, "HEAD"); // 直接按地址推送不会更新跟踪引用，手动记下远端现在的位置
    this.status.lastPush = Date.now(); this.status.lastError = "";
    return { ok: true, pushed: true };
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
      await this.ensureOrigin();
      if (await this.foreignHistory(["HEAD"])) return false;
      if ((await this.git("push", this.o.remote, `HEAD:refs/heads/${this.o.branch}`)).code === 0) return true;
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
    return (await this.git("show", "--stat", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", hash)).out.slice(0, 20000);
  }
  async revert(hash: string) {
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("提交号无效");
    const r = await this.git("revert", "--no-edit", hash);
    if (r.code !== 0) { await this.git("revert", "--abort"); throw new Error(`无法自动撤销：${r.err.slice(0, 200)}`); }
    await this.push(`撤销 ${hash.slice(0, 7)}`);
  }
}
