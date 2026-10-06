// 一个 GitHub App 同时管两件事（所有者的决定：只用一个 App）：
//   - 账户登录：GitHub App 的用户授权（授权码 + PKCE），读一次 /user 就吊销令牌——不需要任何权限；
//   - 灵魂仓库：App 只对用户安装时选中的仓库有「Administration 写」，用来给新身体加部署密钥（以及新用户没有仓库时建一个私有仓库）。
// 同步服务平时不持有任何能改用户仓库的权限：只有用户亲手批准一具身体之后，在同一个标签页经 GitHub 跳一次拿到的短时用户令牌，
// 只做「给这一个仓库加这一把已登记的公钥」，做完立即吊销。App 自己的私钥（安装令牌）根本不保存。
//
// App 由管理员在 /setup/github-app 用 GitHub 的「从配置清单创建」一键生成（权限、回调地址都预先填好），
// 凭据（id、slug、client_id、client_secret）存进数据目录的 github-app.json（0600），不经人手，不进 .env。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";

const UA = "quetzal-sync";
const API = "https://api.github.com";

export interface AppInfo { id: number; slug: string; clientId: string; clientSecret: string; htmlUrl: string }

const appFile = (dataDir: string) => path.join(dataDir, "github-app.json");

export function loadApp(dataDir: string): AppInfo | undefined {
  if (dataDir === ":memory:") return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(appFile(dataDir), "utf8")) as AppInfo;
    return Number.isInteger(j.id) && /^[a-z0-9-]{1,100}$/.test(j.slug) && j.clientId && j.clientSecret ? j : undefined;
  } catch { return undefined; }
}

export function saveApp(dataDir: string, app: AppInfo) {
  const f = appFile(dataDir), tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(app, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}

/** 配置清单（https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest）。
 *  权限只有 administration:write（加部署密钥、建仓库）与默认的 metadata:read；不订阅任何事件，不开 webhook。 */
export function manifest(cfg: Config) {
  const web = cfg.webUrl ?? cfg.publicUrl;
  return {
    name: "Quetzal",
    url: web,
    description: "Let each new body of your agent reach its private soul repository with its own deploy key.",
    redirect_url: `${cfg.publicUrl}/setup/github-app/done`,
    callback_urls: [`${cfg.publicUrl}/soul/callback`],
    setup_url: `${cfg.publicUrl}/soul/callback`,
    setup_on_update: false,
    request_oauth_on_install: true,
    public: true,
    hook_attributes: { url: `${cfg.publicUrl}/v1/health`, active: false },
    default_permissions: { administration: "write", metadata: "read" },
    default_events: [] as string[],
  };
}

/** 清单换凭据：POST /app-manifests/{code}/conversions（不需要认证；code 一小时内有效、只能用一次）。私钥与 webhook 密钥不保存。 */
export async function convertManifest(code: string, fetcher: typeof fetch = fetch): Promise<AppInfo> {
  const r = await fetcher(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST", headers: { Accept: "application/vnd.github+json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({})) as { id?: number; slug?: string; client_id?: string; client_secret?: string; html_url?: string };
  if (!r.ok || !Number.isInteger(j.id) || !j.slug || !j.client_id || !j.client_secret) throw new Error(`GitHub 没有返回 App 的凭据（HTTP ${r.status}）`);
  return { id: j.id!, slug: j.slug, clientId: j.client_id, clientSecret: j.client_secret, htmlUrl: j.html_url ?? `https://github.com/apps/${j.slug}` };
}

/** 用户令牌能做的仓库操作（测试里注入假的）。 */
export interface SoulGitHub {
  app: AppInfo;
  user(token: string): Promise<{ id: number; login: string }>;
  /** 这个用户对本 App 的安装（只看安装在用户自己账户上的那一个）；没装为 undefined。 */
  installation(token: string, login: string): Promise<{ id: number; all: boolean } | undefined>;
  repos(token: string, installation: number): Promise<{ fullName: string; name: string; private: boolean }[]>;
  createRepo(token: string, name: string): Promise<{ fullName: string } | { error: string }>;
  /** 加一把可写部署密钥；同一把公钥已在这个仓库里也算成功。 */
  addDeployKey(token: string, fullName: string, title: string, key: string): Promise<true | { error: string }>;
  revoke(token: string): Promise<void>;
}

export function soulGitHub(app: AppInfo, fetcher: typeof fetch = fetch): SoulGitHub {
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const r = await fetcher(API + p, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const err = (r: { status: number; json: any }) => `HTTP ${r.status}${r.json?.message ? `：${String(r.json.message).slice(0, 200)}` : ""}`;
  return {
    app,
    async user(token) {
      const r = await call(token, "GET", "/user");
      if (r.status !== 200 || !Number.isInteger(r.json.id)) throw new Error(`读取 GitHub 资料失败（${err(r)}）`);
      return { id: r.json.id, login: String(r.json.login) };
    },
    async installation(token, login) {
      const r = await call(token, "GET", "/user/installations?per_page=100");
      if (r.status !== 200) throw new Error(`读取安装失败（${err(r)}）`);
      const i = (r.json.installations ?? []).find((x: any) => x.app_id === app.id && String(x.account?.login).toLowerCase() === login.toLowerCase());
      return i ? { id: i.id, all: i.repository_selection === "all" } : undefined;
    },
    async repos(token, installation) {
      const out: { fullName: string; name: string; private: boolean }[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await call(token, "GET", `/user/installations/${installation}/repositories?per_page=100&page=${page}`);
        if (r.status !== 200) throw new Error(`读取仓库列表失败（${err(r)}）`);
        const list = (r.json.repositories ?? []) as any[];
        out.push(...list.map((x) => ({ fullName: String(x.full_name), name: String(x.name), private: !!x.private })));
        if (list.length < 100) break;
      }
      return out;
    },
    async createRepo(token, name) {
      const r = await call(token, "POST", "/user/repos", { name, private: true, description: "agent 的灵魂仓库（人格与记忆），由 Quetzal 自动同步", auto_init: false });
      return r.status === 201 ? { fullName: String(r.json.full_name) } : { error: err(r) };
    },
    async addDeployKey(token, fullName, title, key) {
      const r = await call(token, "POST", `/repos/${fullName}/keys`, { title, key, read_only: false });
      if (r.status === 201) return true;
      if (r.status === 422) { // 这把公钥已经在用：在这个仓库里就算成功，在别处就不行（GitHub 一把部署密钥只能属于一个仓库）
        const l = await call(token, "GET", `/repos/${fullName}/keys?per_page=100`);
        const blob = key.split(/\s+/)[1];
        if (l.status === 200 && (l.json as any[]).some((k) => String(k.key).split(/\s+/)[1] === blob && !k.read_only)) return true;
      }
      return { error: err(r) };
    },
    async revoke(token) {
      try {
        await fetcher(`${API}/applications/${encodeURIComponent(app.clientId)}/token`, {
          method: "DELETE",
          headers: { Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" },
          body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(5_000),
        });
      } catch { /* 尽力而为：GitHub App 的用户令牌 8 小时后自己失效 */ }
    },
  };
}

/** 部署公钥（ssh-ed25519）的指纹，与 GitHub 设置页显示的一致：SHA256:<base64，无填充>。 */
export function sshFingerprint(key: string): string {
  const blob = Buffer.from(key.trim().split(/\s+/)[1] ?? "", "base64");
  return "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/** 灵魂仓库的名字：<agent 短名>.soul（规范 §2）。 */
export const soulRepoName = (agentName: string) =>
  (agentName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent") + ".soul";

/** 在安装范围内为 agent 挑灵魂仓库：已记下的 → 名字等于 <短名>.soul 的私有仓库 → 唯一的 *.soul 私有仓库；都没有返回 undefined；有几个分不清返回 "ambiguous"。 */
export function pickSoulRepo(repos: { fullName: string; name: string; private: boolean }[], known: string, agentName: string): string | "ambiguous" | undefined {
  if (known && repos.some((r) => r.fullName.toLowerCase() === known.toLowerCase())) return repos.find((r) => r.fullName.toLowerCase() === known.toLowerCase())!.fullName;
  const souls = repos.filter((r) => r.private && r.name.toLowerCase().endsWith(".soul"));
  const named = souls.find((r) => r.name.toLowerCase() === soulRepoName(agentName));
  if (named) return named.fullName;
  if (souls.length === 1) return souls[0].fullName;
  return souls.length ? "ambiguous" : undefined;
}
