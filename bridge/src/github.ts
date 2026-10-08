// GitHub 自动化：创建私有灵魂仓库、添加可写部署密钥。依次尝试已登录的 gh CLI 与 GITHUB_TOKEN；都没有时返回 undefined，由调用方请人类帮忙。
import fs from "node:fs";
import { execFile } from "node:child_process";

const run = (cmd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((r) =>
  execFile(cmd, args, { timeout: 60_000 }, (e, out, err) => r({ ok: !e, out: String(out || err) })));

/** 解析 GitHub 仓库：支持 owner/name、git@github.com:owner/name.git、https://github.com/owner/name(.git)。 */
export function parseGithub(repo: string): { owner: string; name: string } | undefined {
  const m = repo.match(/^(?:git@github\.com:|https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2] } : undefined;
}
export const sshUrl = (r: { owner: string; name: string }) => `git@github.com:${r.owner}/${r.name}.git`;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any } | undefined> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return undefined;
  const res = await fetch(`https://api.github.com${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "soul-bridge" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export async function ghReady(): Promise<boolean> { return (await run("gh", ["auth", "status"])).ok; }

/** 当前 GitHub 用户名。 */
export async function whoami(): Promise<string | undefined> {
  if (await ghReady()) { const r = await run("gh", ["api", "user", "--jq", ".login"]); if (r.ok) return r.out.trim(); }
  const r = await api("GET", "/user");
  return r?.status === 200 ? r.json.login : undefined;
}

/** 确保仓库存在且为私有；不存在则创建。返回 "exists" | "created" | undefined（无凭据）。 */
export async function ensurePrivateRepo(owner: string, name: string): Promise<"exists" | "created" | undefined> {
  if (await ghReady()) {
    const v = await run("gh", ["repo", "view", `${owner}/${name}`, "--json", "visibility", "--jq", ".visibility"]);
    if (v.ok) {
      if (v.out.trim() !== "PRIVATE") throw new Error(`${owner}/${name} 不是私有仓库：灵魂仓库必须是私有的`);
      return "exists";
    }
    const c = await run("gh", ["repo", "create", `${owner}/${name}`, "--private", "--description", "agent 的灵魂仓库（人格与记忆），由 soul-bridge / 运行基座自动同步"]);
    if (!c.ok) throw new Error(`创建仓库失败：${c.out.slice(0, 200)}`);
    return "created";
  }
  const g = await api("GET", `/repos/${owner}/${name}`);
  if (!g) return undefined;
  if (g.status === 200) { if (!g.json.private) throw new Error(`${owner}/${name} 不是私有仓库`); return "exists"; }
  const me = await whoami();
  const c = await api("POST", me === owner ? "/user/repos" : `/orgs/${owner}/repos`, { name, private: true, description: "agent 的灵魂仓库（人格与记忆）" });
  if (!c || c.status >= 300) throw new Error(`创建仓库失败：${JSON.stringify(c?.json).slice(0, 200)}`);
  return "created";
}

/** 添加可写部署密钥（已存在同一把公钥时视为成功）。返回 true / false（失败）/ undefined（无凭据）。 */
export async function addDeployKey(owner: string, name: string, pubFile: string, title: string): Promise<boolean | undefined> {
  const key = fs.readFileSync(pubFile, "utf8").trim();
  if (await ghReady()) {
    const list = await run("gh", ["repo", "deploy-key", "list", "--repo", `${owner}/${name}`]);
    if (list.ok && list.out.includes(key.split(" ")[1])) return true;
    return (await run("gh", ["repo", "deploy-key", "add", pubFile, "--repo", `${owner}/${name}`, "--allow-write", "--title", title])).ok;
  }
  const r = await api("POST", `/repos/${owner}/${name}/keys`, { title, key, read_only: false });
  if (!r) return undefined;
  if (r.status < 300) return true;
  // 加不上：看这个仓库的部署密钥里是不是已经有这把（且可写）。GitHub 说「already in use」也可能是这把钥匙挂在别的仓库上，不能据此当成功
  const list = await api("GET", `/repos/${owner}/${name}/keys?per_page=100`);
  const body = key.split(/\s+/)[1];
  return !!list && list.status < 300 && Array.isArray(list.json) && list.json.some((k: any) => typeof k?.key === "string" && k.key.split(/\s+/)[1] === body && k.read_only === false);
}
