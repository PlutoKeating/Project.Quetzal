// 链接灵魂仓库：人批准一具带部署公钥的身体之后，在同一个标签页经 GitHub 跳一次，同步服务把这把公钥加到这个 agent 的灵魂仓库。
//   /soul/link?t=<票据>    批准时只发给批准者的一次性票据：生成 state 与 PKCE，去 GitHub 的用户授权
//   /soul/callback          GitHub 回来：换短时用户令牌 → 核对是同一个 GitHub 账户 → 没安装 App 就先去安装（装完 GitHub 带着新的授权码回来）
//                           → 在安装范围里找（或建）灵魂仓库 → 加这把部署密钥 → 吊销令牌 → 回到网页前端
// 以及管理员一键创建 GitHub App：/setup/github-app（配置清单）→ GitHub → /setup/github-app/done（换凭据，存进数据目录）。
//
// 安全：用户令牌只在这一次请求的内存里，用完立即吊销；只加码里登记的那把公钥（批准页给人看过它的指纹）；
// 只凭批准时发给批准者的一次性链接票据（网页与 App 都能用，不依赖浏览器里的登录会话）、只对「待链接」的码；
// GitHub 账户必须就是批准者的那个；state、PKCE 与票据都放在 10 分钟的 HttpOnly Cookie 里。
import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { generateCodeVerifier, generateState } from "arctic";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Sessions } from "./auth.ts";
import { exchangeCode } from "./auth.ts";
import { manifest, convertManifest, pickSoulRepo, soulRepoName, type AppInfo, type SoulGitHub } from "./github-app.ts";
import { log } from "./util.ts";

export interface SoulAuth { soul?: SoulGitHub; onApp(app: AppInfo): void; fetcher?: typeof fetch }

const cookieNames = (cfg: Config) => {
  const p = cfg.secure ? "__Host-" : "";
  return { state: `${p}quetzal_soul_state`, verifier: `${p}quetzal_soul_verifier`, ticket: `${p}quetzal_soul_ticket`, setup: `${p}quetzal_setup_state` };
};

export function installSoulRoutes(app: Hono, deps: { db: Db; cfg: Config; sessions: Sessions; auth: SoulAuth }) {
  const { db, cfg, sessions, auth } = deps;
  const web = cfg.webUrl ?? cfg.publicUrl;
  const names = cookieNames(cfg);
  const opts = { httpOnly: true, secure: cfg.secure, sameSite: "Lax" as const, path: "/", maxAge: 600 };
  const back = (q: Record<string, string>) => `${web}/device?${new URLSearchParams(q)}`;
  const isAdmin = (login?: string) => !!login && cfg.admins.includes(login.toLowerCase());

  // ---------- 管理员：一键创建 GitHub App（已经有了就只显示它）
  app.get("/setup/github-app", (c) => {
    const u = sessions.user(c);
    if (!u) return c.redirect(`/login?return_to=${encodeURIComponent(`${cfg.publicUrl}/setup/github-app`)}`);
    if (!isAdmin(u.login)) return c.text("只有同步服务的管理员（SYNC_ADMINS）能创建 GitHub App", 403);
    if (auth.soul) return c.html(`<!doctype html><meta charset="utf-8"><title>Quetzal GitHub App</title><p>GitHub App 已经配置：<a href="${auth.soul.app.htmlUrl}">${auth.soul.app.slug}</a></p>`);
    const state = generateState();
    setCookie(c, names.setup, state, opts);
    const m = JSON.stringify(manifest(cfg)).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    // 表单要提交到 github.com：这一页的 form-action 在 app.ts 的安全头里单独放宽（其他页面仍只许本站）
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>创建 Quetzal 的 GitHub App</title>
<h1>创建 Quetzal 的 GitHub App</h1>
<p>点下面的按钮，GitHub 会打开一个已经填好的页面（名字、权限、回调地址都在里面），再点一次「Create GitHub App」就完成了。凭据由同步服务自动保存。</p>
<form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${m}"><button type="submit">去 GitHub 创建</button></form>`);
  });

  app.get("/setup/github-app/done", async (c) => {
    const u = sessions.user(c);
    const state = getCookie(c, names.setup);
    deleteCookie(c, names.setup, { path: "/", secure: cfg.secure });
    const code = c.req.query("code") ?? "";
    if (!u || !isAdmin(u.login) || !state || c.req.query("state") !== state || !/^[\w-]{1,100}$/.test(code)) return c.text("请求无效（只有管理员、并且要从 /setup/github-app 发起）", 400);
    try {
      const a = await convertManifest(code, auth.fetcher);
      auth.onApp(a);
      log("github-app", `已创建并保存 GitHub App ${a.slug}（id ${a.id}）`);
      return c.redirect(`${web}/account?github-app=ready`);
    } catch (e) {
      log("github-app", (e as Error).message);
      return c.text(`创建失败：${(e as Error).message}`, 502);
    }
  });

  // ---------- 链接灵魂仓库
  /** 凭链接票据找码：批准时只发给批准者的 256 位随机数（库里只存哈希），码要已批准、待链接、没过期。批准者就是码上记的账户。 */
  const linkable = (ticket: string | undefined) => {
    const code = ticket && /^qsl_[\w-]{43}$/.test(ticket) ? db.codeByTicket(ticket) : undefined;
    const u = code?.user_id != null ? db.user(code.user_id) : undefined;
    if (!u || !code || code.status !== "approved" || code.soul_status !== "pending" || code.expires < Date.now()) return undefined;
    return { u, code };
  };
  const fail = (codeId: string, user: string, why: string) => {
    db.setCodeSoul(codeId, "failed", "", why);
    log("soul", `链接失败：${why}`);
    return back({ code: user, soul: "failed", reason: why.slice(0, 200) });
  };

  const toGitHub = (c: Context, ticket: string) => {
    const state = generateState(), verifier = generateCodeVerifier();
    setCookie(c, names.state, state, opts); setCookie(c, names.verifier, verifier, opts); setCookie(c, names.ticket, ticket, opts);
    const u = new URL("https://github.com/login/oauth/authorize");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    for (const [k, v] of Object.entries({ client_id: auth.soul!.app.clientId, redirect_uri: `${cfg.publicUrl}/soul/callback`, state, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
    return c.redirect(u.toString());
  };

  app.get("/soul/link", (c) => {
    if (!auth.soul) return c.redirect(back({ soul: "unavailable" }));
    const t = c.req.query("t");
    if (!linkable(t)) return c.redirect(back({ soul: "expired" }));
    return toGitHub(c, t!);
  });

  app.get("/soul/callback", async (c) => {
    const soul = auth.soul;
    const state = getCookie(c, names.state), verifier = getCookie(c, names.verifier), ticket = getCookie(c, names.ticket);
    const l = linkable(ticket);
    if (!soul || !l) return c.redirect(back({ soul: "expired" }));
    const ghCode = c.req.query("code") ?? "";
    // 装完 App 回来时 GitHub 不一定带 state：带了就必须相符；没带时仍要求本人的会话与 Cookie 里的 PKCE（令牌之后还要核对是同一个 GitHub 账户）
    const gotState = c.req.query("state");
    if (!verifier || !state || (gotState !== undefined && gotState !== state) || !/^[\w-]{1,100}$/.test(ghCode)) return c.redirect(back({ soul: "expired" }));
    for (const n of [names.state, names.verifier]) deleteCookie(c, n, { path: "/", secure: cfg.secure });
    let token = "";
    try {
      token = await exchangeCode({ id: soul.app.clientId, secret: soul.app.clientSecret, code: ghCode, redirectUri: `${cfg.publicUrl}/soul/callback`, verifier, relay: cfg.githubRelay }, auth.fetcher);
      const gh = await soul.user(token);
      if (gh.id !== l.u.github_id) return c.redirect(fail(l.code.id, l.code.user_code, "GitHub 账户与登录 Quetzal 的账户不一致"));
      const inst = await soul.installation(token, gh.login);
      if (!inst) { // 还没安装：去安装页（安装时选灵魂仓库；装完 GitHub 带着新的授权码回到 /soul/callback）
        const next = generateState(), v2 = generateCodeVerifier();
        setCookie(c, names.state, next, opts); setCookie(c, names.verifier, v2, opts);
        return c.redirect(`https://github.com/apps/${soul.app.slug}/installations/new?state=${next}`);
      }
      const agent = db.agentOf(l.u.id, l.code.agent_id);
      if (!agent) return c.redirect(fail(l.code.id, l.code.user_code, "agent 已不存在"));
      let repo = pickSoulRepo(await soul.repos(token, inst.id), agent.soul_repo, agent.name);
      if (repo === "ambiguous") return c.redirect(fail(l.code.id, l.code.user_code, `安装范围里有几个 .soul 仓库，分不清哪个属于 ${agent.name}：在 GitHub 的 App 设置里只保留它的灵魂仓库，再重新批准`));
      if (!repo) {
        const made = await soul.createRepo(token, soulRepoName(agent.name));
        if ("error" in made) return c.redirect(fail(l.code.id, l.code.user_code, `没有找到灵魂仓库，也没能新建（${made.error}）：安装 App 时请选「All repositories」或选中灵魂仓库`));
        repo = made.fullName;
      }
      const added = await soul.addDeployKey(token, repo, `quetzal · ${l.code.body}`, l.code.soul_key);
      if (added !== true) return c.redirect(fail(l.code.id, l.code.user_code, `没能给 ${repo} 加部署密钥（${added.error}）`));
      db.tx(() => { db.setAgentSoulRepo(agent.id, repo as string); db.setCodeSoul(l.code.id, "done", repo as string); });
      deleteCookie(c, names.ticket, { path: "/", secure: cfg.secure });
      log("soul", `已为一具身体链接灵魂仓库`);
      return c.redirect(back({ code: l.code.user_code, soul: "linked", repo }));
    } catch (e) {
      return c.redirect(fail(l.code.id, l.code.user_code, (e as Error).message));
    } finally {
      if (token) void soul.revoke(token);
    }
  });
}
