// HTTP 路由（Hono）。/v1/* 是给身体用的 JSON 接口（无 Cookie，令牌在请求体或 Authorization 里）；/v1/web/* 是给网页前端与控制台的账户接口（web.ts）；
// 其余是给人用的网页。配置了 SYNC_WEB_URL（例如官网）时，给人看的页面都在那里：这里的网页入口一律跳过去，同步服务只提供接口。
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders, NONCE } from "hono/secure-headers";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { Sessions, beginLogin, finishLogin, type LoginClient } from "./auth.ts";
import { DeviceRequest, createCode, createConsoleCode, decide, check, poll } from "./device.ts";
import { installWebApi, type FindCode } from "./web.ts";
import { installSoulRoutes, type SoulAuth } from "./soul-link.ts";
import { layout, pickLang, t, ago, type Lang } from "./pages.ts";
import { RateLimiter, normalizeUserCode, fingerprint, log, clientIp as pickIp, ipKey } from "./util.ts";
import { PROTOCOL } from "./hub.ts";

export const VERSION = "1.4.0";

const TokenRequest = z.object({ device_code: z.string().min(1).max(200) });

/** 登录（OIDC 身份服务）与灵魂仓库（GitHub App；管理员创建 App 之后凭据会换）经这个可变的持有者取用（server.ts 负责更新）。 */
export interface Auth extends SoulAuth { login?: LoginClient }

export function createApp(deps: { db: Db; cfg: Config; hub: Hub; auth: Auth }) {
  const { db, cfg, hub, auth } = deps;
  const sessions = new Sessions(db, cfg);
  const limits = {
    code: new RateLimiter(10, 10 * 60_000),      // 每个地址 10 分钟最多申请 10 次绑定码
    token: new RateLimiter(240, 10 * 60_000),    // 轮询（每 5 秒一次；同一出口地址后面可能有几具身体在同时绑定）
    lookup: new RateLimiter(10, 10 * 60_000),    // 每个账户 10 分钟最多输错 10 次短码（短码约 34 位熵）
    guess: new RateLimiter(30, 10 * 60_000),     // 每个地址 10 分钟最多输错 30 次短码（不管用几个账户）
    login: new RateLimiter(30, 10 * 60_000),
  };
  /** 限流用的客户端地址键（IPv6 按 /64 聚合），只在内存里，不写库、不写日志。见 util.clientIp。 */
  const clientIp = (c: Context) => {
    let remote: string | undefined;
    try { remote = getConnInfo(c).remote.address; } catch { /* 测试里没有套接字 */ }
    return ipKey(pickIp((n) => c.req.header(n), remote, cfg.trustProxy));
  };
  /** 按短码找码：账户或地址的输错次数用完时一律 429（命中也不给，否则限流挡不住猜测）；找不到与已过期同为 bad_code，并计入两者。 */
  const findCode: FindCode = (c, userId, input) => {
    const ip = clientIp(c);
    if (limits.lookup.over(`u${userId}`) || limits.guess.over(ip)) return { error: "too_many" };
    const text = typeof input === "string" && input.length <= 20 ? normalizeUserCode(input) : undefined;
    const code = text ? db.codeByUser(text) : undefined;
    if (code && code.expires >= Date.now()) return { code };
    limits.lookup.take(`u${userId}`); limits.guess.take(ip);
    return { error: "bad_code" };
  };
  const lang = (c: Context): Lang => pickLang(c.req.query("lang"), c.req.header("accept-language"));
  const nonce = (c: Context) => (c.get("secureHeadersNonce" as never) as string | undefined) ?? "";
  const page = (c: Context, title: string, content: Parameters<typeof layout>[3], status = 200) =>
    c.html(layout(lang(c), nonce(c), title, content, { user: sessions.user(c)?.login }), status as 200);

  const app = new Hono();
  // 安全头：创建 GitHub App 的那一页要把配置清单提交到 github.com，只有它放宽 form-action；其他页面只许提交到本站
  const headers = (formAction: string[]) => secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"], styleSrc: [NONCE], imgSrc: ["'self'"], formAction,
      frameAncestors: ["'none'"], baseUri: ["'none'"],
    },
    strictTransportSecurity: cfg.secure ? "max-age=31536000; includeSubDomains" : false,
    referrerPolicy: "no-referrer",
    crossOriginResourcePolicy: "same-site", // 网页前端与同步服务同站不同源（/v1/web/* 经 CORS 读取）
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  });
  const normal = headers(["'self'"]), setup = headers(["https://github.com"]);
  app.use("*", (c, next) => (c.req.path === "/setup/github-app" ? setup(c, next) : normal(c, next)));
  // 网页表单的 POST 只接受来自本站的请求（Origin 与 Sec-Fetch-Site 二者之一通过即可）；配合 SameSite=Lax 的会话 Cookie。
  // /v1/* 不用 Cookie（令牌在请求体或 Authorization 头里），不存在 CSRF，身体的请求也不带 Origin
  const csrfCheck = csrf({ origin: cfg.publicUrl });
  app.use("*", (c, next) => (c.req.path.startsWith("/v1/") ? next() : csrfCheck(c, next)));
  app.use("*", bodyLimit({ maxSize: 16 * 1024 }));
  // 网页前端在别处时，这里给人看的入口都跳过去（登录与 GitHub 回调除外：会话 Cookie 属于同步服务自己）
  // 自带网页的表单 POST（/device、/device/decide、/account/*）也一并关掉，只剩网页前端经 /v1/web/* 这一条路
  if (cfg.webUrl) {
    const web = cfg.webUrl;
    app.get("/", (c) => c.redirect(web + "/"));
    app.get("/account", (c) => c.redirect(web + "/account"));
    app.get("/device", (c) => { const code = normalizeUserCode(c.req.query("code") ?? ""); return c.redirect(web + "/device" + (code ? `?code=${code}` : "")); });
    app.post("/device", (c) => c.redirect(web + "/device", 303));
    app.post("/device/decide", (c) => c.redirect(web + "/device", 303));
    app.post("/account/*", (c) => c.redirect(web + "/account", 303));
  }
  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse(); // CSRF 拒绝（403）、请求体过大（413）等
    log("http", `${c.req.method} ${c.req.path} 出错：${e.message}`);
    return c.json({ error: "server_error" }, 500);
  });

  // ---------- 给身体的接口
  app.get("/v1/health", (c) => c.json({ ok: true, service: "quetzal-sync", version: VERSION, protocol: PROTOCOL, login: !!auth.login, turn: !!cfg.turn, online: hub.count() }));

  app.post("/v1/device/code", async (c) => {
    if (!auth.login) return c.json({ error: "login_disabled" }, 503);
    if (!limits.code.take(clientIp(c))) return c.json({ error: "slow_down" }, 429);
    const r = DeviceRequest.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return c.json({ error: "invalid_request", issues: r.error.issues.map((i) => i.path.join(".")) }, 400);
    return c.json(createCode(db, cfg, r.data));
  });

  app.post("/v1/device/token", async (c) => {
    if (!limits.token.take(clientIp(c))) return c.json({ error: "slow_down" }, 429);
    const j = TokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!j.success) return c.json({ error: "invalid_request" }, 400);
    const r = poll(db, j.data.device_code, (agentId, body) => hub.kick(agentId, body));
    return c.json(r.body, r.status);
  });

  /** 身体用自己的令牌查询绑定信息，或者自己解绑。 */
  const bearer = (c: Context) => { const h = c.req.header("authorization") ?? ""; return h.startsWith("Bearer ") ? db.bodyByToken(h.slice(7).trim()) : undefined; };
  app.get("/v1/me", (c) => {
    const b = bearer(c);
    if (!b) return c.json({ error: "unauthorized" }, 401);
    const a = db.agent(b.agent)!;
    return c.json({ agent: { id: a.agent_id, name: a.name }, body: b.body, kind: b.kind, account: db.user(a.user_id)?.login ?? "" });
  });
  /** 控制台登录：已绑定的运行基座代它的控制台（App）申请一对码，人在网页上批准后，身体用设备码轮询（/v1/device/token）拿到账户会话令牌。
   *  灵魂桥是只读成员，没有控制台，不能申请（403）。 */
  app.post("/v1/console/code", (c) => {
    if (!auth.login) return c.json({ error: "login_disabled" }, 503);
    const b = bearer(c);
    if (!b) return c.json({ error: "unauthorized" }, 401);
    if (b.kind !== "runtime") return c.json({ error: "runtime_only" }, 403);
    if (!limits.code.take(clientIp(c))) return c.json({ error: "slow_down" }, 429);
    return c.json(createConsoleCode(db, cfg, b, String(c.req.header("x-quetzal-version") ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 32)));
  });
  app.delete("/v1/me", (c) => {
    const b = bearer(c);
    if (!b) return c.json({ error: "unauthorized" }, 401);
    db.deleteBody(b.agent, b.body);
    hub.kick(b.agent, b.body);
    return c.json({ ok: true });
  });

  installWebApi(app, { db, cfg, hub, sessions, findCode, auth });
  installSoulRoutes(app, { db, cfg, sessions, auth });

  // ---------- 给人的网页（没有配置 SYNC_WEB_URL 时；配置了时上面已跳走）
  app.get("/", (c) => {
    const s = t(lang(c)), user = sessions.user(c);
    return page(c, s.title, html`
      <h1>${s.title}</h1><p>${s.tagline}</p><p>${s.intro}</p>
      ${user ? html`<p><a class="btn primary" href="/account?lang=${lang(c)}">${s.account}</a></p>`
        : auth.login ? html`<p><a class="btn primary" href="/login?lang=${lang(c)}">${s.login}</a></p>`
        : html`<p class="note err">${s.loginDisabled}</p>`}
      <h2>${s.storesTitle}</h2><ul>${s.stores.map((x) => html`<li>${x}</li>`)}</ul>
      <h2>${s.notStoresTitle}</h2><ul>${s.notStores.map((x) => html`<li>${x}</li>`)}</ul>`);
  });

  app.get("/login", async (c) => {
    if (!auth.login) return c.redirect("/");
    if (!limits.login.take(clientIp(c))) return c.text("Too many requests", 429);
    try {
      return c.redirect((await beginLogin(c, cfg, auth.login, c.req.query("return_to") ?? (cfg.webUrl ? `${cfg.webUrl}/account` : `/account?lang=${lang(c)}`))).toString());
    } catch (e) {
      log("auth", (e as Error).message);
      return cfg.webUrl ? c.redirect(`${cfg.webUrl}/account?login=failed`) : page(c, t(lang(c)).login, html`<p class="note err">${(e as Error).message}</p><p><a href="/">${t(lang(c)).back}</a></p>`, 502);
    }
  });

  app.get("/auth/oidc/callback", async (c) => {
    if (!auth.login) return c.redirect("/");
    const { state, nonce, verifier, returnTo } = finishLogin(c, cfg);
    const code = c.req.query("code"), got = c.req.query("state");
    if (!state || !nonce || !verifier || !code || code.length > 512 || !got || got !== state) return c.redirect(cfg.webUrl ? `${cfg.webUrl}/account?login=failed` : "/?lang=" + lang(c)); // state 不符：可能是伪造的回调，什么都不做
    try {
      // 换令牌时的 redirect_uri 取自这个地址：用公开地址（反向代理后面 c.req.url 是内网的）
      const u = await auth.login.user(new URL(`/auth/oidc/callback?${new URL(c.req.url).searchParams}`, cfg.publicUrl), { state, nonce, codeVerifier: verifier });
      const user = db.upsertUser(u);
      sessions.create(c, user.id);
      return c.redirect(returnTo);
    } catch (e) {
      log("auth", (e as Error).message);
      if (cfg.webUrl) return c.redirect(`${cfg.webUrl}/account?login=failed`);
      return page(c, t(lang(c)).login, html`<p class="note err">${(e as Error).message}</p><p><a href="/">${t(lang(c)).back}</a></p>`, 502);
    }
  });

  app.post("/logout", (c) => { sessions.destroy(c); return c.redirect("/?lang=" + lang(c)); });

  /** 需要登录的页面：没登录就去登录，回来后回到这里。 */
  const requireUser = (c: Context) => sessions.user(c);
  const toLogin = (c: Context) => c.redirect(`/login?lang=${lang(c)}&return_to=${encodeURIComponent(c.req.path + (c.req.query("code") ? `?code=${c.req.query("code")}` : ""))}`);

  const deviceForm = (c: Context, prefill = "", error = "") => {
    const s = t(lang(c));
    return page(c, s.deviceTitle, html`
      <h1>${s.deviceTitle}</h1><p>${s.deviceHint}</p>
      ${error ? html`<p class="note err">${error}</p>` : ""}
      <form method="post" action="/device?lang=${lang(c)}" class="card">
        <label class="meta" for="code">${s.code}</label><br>
        <input id="code" name="code" type="text" value="${prefill}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" required autofocus>
        <p><button class="btn primary" type="submit">${s.next}</button></p>
      </form>`, error ? 400 : 200);
  };

  app.get("/device", (c) => (requireUser(c) ? deviceForm(c, normalizeUserCode(c.req.query("code") ?? "") ?? "") : toLogin(c)));

  app.post("/device", async (c) => {
    const user = requireUser(c);
    if (!user) return toLogin(c);
    const s = t(lang(c));
    const form = await c.req.parseBody();
    const f = findCode(c, user.id, typeof form.code === "string" ? form.code : "");
    if ("error" in f) return deviceForm(c, "", f.error === "too_many" ? s.tooMany : s.badCode);
    const code = f.code;
    const d = check(db, cfg, code, user.id);
    if (!d.ok) return d.error === "bad_code" ? deviceForm(c, "", s.badCode) : page(c, s.confirmTitle, html`<p class="note err">${s.errors[d.error]}</p><p><a href="/account?lang=${lang(c)}">${s.back}</a></p>`, 409);
    const fp = fingerprint(d.body?.node_key ?? code.node_key);
    return page(c, s.confirmTitle, html`
      <h1>${s.confirmTitle}</h1><p>${s.confirmHint}</p>
      <div class="card"><dl>
        <dt>${s.agent}</dt><dd>${code.agent_name} <span class="meta mono">${code.agent_id.slice(0, 8)}</span></dd>
        <dt>${s.body}</dt><dd>${code.body} <span class="meta">${s.kind[code.kind] ?? code.kind}${code.version ? ` · ${code.version}` : ""}</span></dd>
        <dt>${s.key}</dt><dd class="mono">${fp}</dd>
        ${d.body ? html`<dt>${s.boundAt}</dt><dd>${ago(lang(c), d.body.created)}</dd>` : ""}
      </dl></div>
      ${d.replaces || d.newAgent ? html`<p class="note">${d.replaces ? s.replaces : s.newAgent}</p>` : ""}
      <form method="post" action="/device/decide?lang=${lang(c)}" class="row">
        <input type="hidden" name="code" value="${code.user_code}">
        <button class="btn primary" name="approve" value="1" type="submit">${s.approve}</button>
        <button class="btn danger" name="approve" value="0" type="submit">${s.deny}</button>
      </form>`);
  });

  app.post("/device/decide", async (c) => {
    const user = requireUser(c);
    if (!user) return toLogin(c);
    const s = t(lang(c));
    const form = await c.req.parseBody();
    const f = findCode(c, user.id, typeof form.code === "string" ? form.code : "");
    if ("error" in f) return deviceForm(c, "", f.error === "too_many" ? s.tooMany : s.badCode);
    const approve = form.approve === "1";
    const d = decide(db, cfg, f.code, user.id, approve);
    if (!d.ok) return d.error === "bad_code" ? deviceForm(c, "", s.badCode) : page(c, s.confirmTitle, html`<p class="note err">${s.errors[d.error]}</p>`, 409);
    return page(c, s.confirmTitle, html`<h1>${s.confirmTitle}</h1><p class="note">${approve ? s.approved : s.denied}</p>
      <p><a class="btn" href="/account?lang=${lang(c)}">${s.account}</a></p>`);
  });

  app.get("/account", (c) => {
    const user = requireUser(c);
    if (!user) return toLogin(c);
    const L = lang(c), s = t(L);
    const agents = db.agentsOf(user.id);
    return page(c, s.account, html`
      <div class="row"><h1>${user.name || user.login}</h1>
        <form method="post" action="/logout?lang=${L}" class="inline"><button class="btn small" type="submit">${s.logout}</button></form></div>
      <p class="meta">${user.email || user.login}</p>
      <h2>${s.agents}</h2>
      ${agents.length ? "" : html`<p>${s.noAgents}</p>`}
      ${agents.map((a) => html`<section class="card">
        <div class="row"><strong>${a.name}</strong><span class="meta mono">${a.agent_id}</span></div>
        <h2>${s.bodies}</h2>
        ${db.bodiesOf(a.id).map((b) => html`<div class="row card">
          <div><span class="dot ${hub.online(a.id, b.body) ? "on" : ""}"></span><strong>${b.body}</strong>
            <span class="meta">· ${s.kind[b.kind] ?? b.kind}${b.version ? ` · ${b.version}` : ""} · ${hub.online(a.id, b.body) ? s.online : `${s.lastSeen} ${ago(L, b.last_seen)}`}</span><br>
            <span class="meta mono">${s.key} ${fingerprint(b.node_key)}</span></div>
          <form method="post" action="/account/bodies/remove?lang=${L}" class="inline">
            <input type="hidden" name="agent" value="${String(a.id)}"><input type="hidden" name="body" value="${b.body}">
            <button class="btn small danger" type="submit">${s.removeBody}</button></form>
        </div>`)}
        <form method="post" action="/account/agents/remove?lang=${L}">
          <input type="hidden" name="agent" value="${String(a.id)}">
          <label class="check"><input type="checkbox" name="confirm" value="1" required>${s.confirm}：${s.removeAgentHint}</label>
          <button class="btn small danger" type="submit">${s.removeAgent}</button></form>
      </section>`)}
      <h2>${s.deleteAccount}</h2>
      <form method="post" action="/account/delete?lang=${L}" class="card">
        <label class="check"><input type="checkbox" name="confirm" value="1" required>${s.confirm}：${s.deleteAccountHint}</label>
        <button class="btn danger" type="submit">${s.deleteAccount}</button></form>`);
  });

  app.post("/account/bodies/remove", async (c) => {
    const user = requireUser(c);
    if (!user) return toLogin(c);
    const f = await c.req.parseBody();
    const a = db.agent(Number(f.agent));
    if (a && a.user_id === user.id && db.deleteBody(a.id, String(f.body ?? ""))) hub.kick(a.id, String(f.body));
    return c.redirect(`/account?lang=${lang(c)}`);
  });

  app.post("/account/agents/remove", async (c) => {
    const user = requireUser(c);
    if (!user) return toLogin(c);
    const f = await c.req.parseBody();
    const id = Number(f.agent);
    if (f.confirm === "1" && Number.isInteger(id) && db.deleteAgent(id, user.id)) hub.kick(id);
    return c.redirect(`/account?lang=${lang(c)}`);
  });

  app.post("/account/delete", async (c) => {
    const user = requireUser(c);
    if (!user) return toLogin(c);
    const f = await c.req.parseBody();
    if (f.confirm !== "1") return c.redirect(`/account?lang=${lang(c)}`);
    const agents = db.agentsOf(user.id);
    sessions.destroy(c);
    db.deleteUser(user.id); // 外键级联：会话、agent、身体、设备码一起删
    for (const a of agents) hub.kick(a.id);
    return c.redirect(`/?lang=${lang(c)}`);
  });

  app.notFound((c) => c.req.path.startsWith("/v1/") ? c.json({ error: "not_found" }, 404) : page(c, "404", html`<h1>404</h1><p><a href="/">${t(lang(c)).back}</a></p>`, 404));
  return app;
}
