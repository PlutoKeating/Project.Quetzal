// 灵魂仓库协议（与运行时配置无关）：运行基座与桥接模块共用同一套同步与冲突规则。设计见 docs/SOUL_SYNC.md。
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
  sshKey?: string; // 访问远端用的私钥路径（不存在则使用默认 ssh 配置）
  author: () => { name: string; email: string };
  isSeedSoul?: (text: string) => boolean; // 判断 SOUL.md 是否仍是种子人格
  bodyInfo?: () => Record<string, unknown>; // 写入 bodies/<身体>.json 的额外信息
  log?: (msg: string) => void;
}

const LEASE_MS = 30 * 60_000;

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
    if (this.o.sshKey && fs.existsSync(this.o.sshKey)) env.GIT_SSH_COMMAND = `ssh -i ${this.o.sshKey} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;
    return new Promise((resolve) => execFile("git", ["-C", this.o.dir, ...args], { env, timeout: 120_000, maxBuffer: 16 << 20 }, (e: any, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err || e?.message || "") })));
  }

  get exists() { return fs.existsSync(this.p(".git")); }

  /** 克隆远端；远端不可用或未配置时本地初始化。 */
  async ensure(): Promise<"cloned" | "initialized" | "existing"> {
    if (this.exists) { await this.configure(); return "existing"; }
    fs.mkdirSync(path.dirname(this.o.dir), { recursive: true });
    if (this.o.remote) {
      fs.rmSync(this.o.dir, { recursive: true, force: true });
      const r = await new SoulRepo({ ...this.o, dir: path.dirname(this.o.dir) }).git("clone", "-b", this.o.branch, this.o.remote, this.o.dir);
      if (r.code === 0) { await this.configure(); return "cloned"; }
      // 空仓库没有分支时 clone -b 会失败：改为不指定分支再试
      const r2 = await new SoulRepo({ ...this.o, dir: path.dirname(this.o.dir) }).git("clone", this.o.remote, this.o.dir);
      if (r2.code === 0) { await this.git("checkout", "-B", this.o.branch); await this.configure(); return "cloned"; }
      this.o.log?.(`克隆失败，改为本地初始化：${r2.err.slice(0, 200)}`);
    }
    fs.mkdirSync(this.o.dir, { recursive: true });
    await this.git("init", "-b", this.o.branch);
    await this.configure();
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

  async commit(msg: string) {
    await this.git("add", "-A");
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
    if (!this.o.remote) return none;
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
      const conflicted = (await this.git("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
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
    if (!this.o.remote) return;
    let r = await this.git("push", "origin", `HEAD:${this.o.branch}`);
    if (r.code !== 0 && (await this.pull()).merged) r = await this.git("push", "origin", `HEAD:${this.o.branch}`);
    if (r.code !== 0) this.status.lastError = r.err.slice(0, 300);
    else if (changed) { this.status.lastPush = Date.now(); this.status.lastError = ""; }
  }

  // ---------- 整理租约
  private lease = () => this.readJson("locks/consolidation.json") as { body: string; until: number } | undefined;
  async acquireLease(): Promise<boolean> {
    if (!this.o.remote) return true;
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
