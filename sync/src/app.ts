// HTTP 路由（Hono）。/v1/* 是给身体用的 JSON 接口（无 Cookie，令牌在请求体或 Authorization 里）；其余是给人用的网页。
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders, NONCE } from "hono/secure-headers";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import { Sessions, beginLogin, finishLogin, type GitHubClient } from "./auth.ts";
import { DeviceRequest, createCode, decide, check, poll } from "./device.ts";
import { layout, pickLang, t, ago, type Lang } from "./pages.ts";
import { RateLimiter, normalizeUserCode, fingerprint, log } from "./util.ts";
import { PROTOCOL } from "./hub.ts";

export const VERSION = "1.0.0";

export function createApp(deps: { db: Db; cfg: Config; hub: Hub; github?: GitHubClient }) {
  const { db, cfg, hub, github } = deps;
  const sessions = new Sessions(db, cfg);
  const limits = {
    code: new RateLimiter(10, 10 * 60_000),      // 每个地址 10 分钟最多申请 10 次绑定码
    token: new RateLimiter(120, 10 * 60_000),    // 轮询（每 5 秒一次，留余量）
    lookup: new RateLimiter(10, 10 * 60_000),    // 每个账户 10 分钟最多输错 10 次短码（短码约 34 位熵）
    login: new RateLimiter(30, 10 * 60_000),
  };
  /** 客户端地址只用于内存里的限流，不写库、不写日志。前面有反向代理时取 X-Forwarded-For 最右一项（由代理追加，客户端伪造不了）。 */
  const clientIp = (c: Context) => {
    if (cfg.trustProxy) { const xff = c.req.header("x-forwarded-for"); if (xff) return xff.split(",").pop()!.trim(); }
    try { return getConnInfo(c).remote.address ?? "?"; } catch { return "?"; }
  };
  const lang = (c: Context): Lang => pickLang(c.req.query("lang"), c.req.header("accept-language"));
  const nonce = (c: Context) => (c.get("secureHeadersNonce" as never) as string | undefined) ?? "";
  const page = (c: Context, title: string, content: Parameters<typeof layout>[3], status = 200) =>
    c.html(layout(lang(c), nonce(c), title, content, { user: sessions.user(c)?.login }), status as 200);

  const app = new Hono();
  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"], styleSrc: [NONCE], imgSrc: ["'self'"], formAction: ["'self'"],
      frameAncestors: ["'none'"], baseUri: ["'none'"],
    },
    strictTransportSecurity: cfg.secure ? "max-age=31536000; includeSubDomains" : false,
    referrerPolicy: "no-referrer",
    crossOriginResourcePolicy: "same-origin",
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  }));
  // 网页表单的 POST 只接受来自本站的请求（Origin 与 Sec-Fetch-Site 二者之一通过即可）；配合 SameSite=Lax 的会话 Cookie。
  // /v1/* 不用 Cookie（令牌在请求体或 Authorization 头里），不存在 CSRF，身体的请求也不带 Origin
  const csrfCheck = csrf({ origin: cfg.publicUrl });
  app.use("*", (c, next) => (c.req.path.startsWith("/v1/") ? next() : csrfCheck(c, next)));
  app.use("*", bodyLimit({ maxSize: 16 * 1024 }));
  app.onError((e, c) => {
    if (e instanceof HTTPException) return e.getResponse(); // CSRF 拒绝（403）、请求体过大（413）等
    log("http", `${c.req.method} ${c.req.path} 出错：${e.message}`);
    return c.json({ error: "server_error" }, 500);
  });

  // ---------- 给身体的接口
  app.get("/v1/health", (c) => c.json({ ok: true, service: "quetzal-sync", version: VERSION, protocol: PROTOCOL, login: !!github, turn: !!cfg.turn, online: hub.count() }));

  app.post("/v1/device/code", async (c) => {
    if (!github) return c.json({ error: "login_disabled" }, 503);
    if (!limits.code.take(clientIp(c))) return c.json({ error: "slow_down" }, 429);
    const r = DeviceRequest.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return c.json({ error: "invalid_request", issues: r.error.issues.map((i) => i.path.join(".")) }, 400);
    return c.json(createCode(db, cfg, r.data));
  });

  app.post("/v1/device/token", async (c) => {
    if (!limits.token.take(clientIp(c))) return c.json({ error: "slow_down" }, 429);
    const j = await c.req.json().catch(() => null) as { device_code?: unknown } | null;
    if (typeof j?.device_code !== "string" || j.device_code.length > 200) return c.json({ error: "invalid_request" }, 400);
    const r = poll(db, j.device_code, (agentId, body) => hub.kick(agentId, body));
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
  app.delete("/v1/me", (c) => {
    const b = bearer(c);
    if (!b) return c.json({ error: "unauthorized" }, 401);
    db.deleteBody(b.agent, b.body);
    hub.kick(b.agent, b.body);
    return c.json({ ok: true });
  });

  // ---------- 给人的网页
  app.get("/", (c) => {
    const s = t(lang(c)), user = sessions.user(c);
    return page(c, s.title, html`
      <h1>${s.title}</h1><p>${s.tagline}</p><p>${s.intro}</p>
      ${user ? html`<p><a class="btn primary" href="/account?lang=${lang(c)}">${s.account}</a></p>`
        : github ? html`<p><a class="btn primary" href="/login?lang=${lang(c)}">${s.login}</a></p>`
        : html`<p class="note err">${s.loginDisabled}</p>`}
      <h2>${s.storesTitle}</h2><ul>${s.stores.map((x) => html`<li>${x}</li>`)}</ul>
      <h2>${s.notStoresTitle}</h2><ul>${s.notStores.map((x) => html`<li>${x}</li>`)}</ul>`);
  });

  app.get("/login", (c) => {
    if (!github) return c.redirect("/");
    if (!limits.login.take(clientIp(c))) return c.text("Too many requests", 429);
    return c.redirect(beginLogin(c, cfg, github, c.req.query("return_to") ?? `/account?lang=${lang(c)}`).toString());
  });

  app.get("/auth/github/callback", async (c) => {
    if (!github) return c.redirect("/");
    const { state, returnTo } = finishLogin(c);
    const code = c.req.query("code"), got = c.req.query("state");
    if (!state || !code || !got || got !== state) return c.redirect("/?lang=" + lang(c)); // state 不符：可能是伪造的回调，什么都不做
    try {
      const u = await github.user(code);
      const user = db.upsertUser(u.id, u.login, u.name);
      sessions.create(c, user.id);
      return c.redirect(returnTo);
    } catch (e) {
      log("auth", (e as Error).message);
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
    const codeText = normalizeUserCode(String(form.code ?? ""));
    const code = codeText ? db.codeByUser(codeText) : undefined;
    if (!code || code.expires < Date.now()) {
      if (!limits.lookup.take(`u${user.id}`)) return deviceForm(c, "", s.tooMany);
      return deviceForm(c, "", s.badCode);
    }
    const d = check(db, cfg, code, user.id);
    if (!d.ok) return page(c, s.confirmTitle, html`<p class="note err">${s.errors[d.error]}</p><p><a href="/account?lang=${lang(c)}">${s.back}</a></p>`, 409);
    return page(c, s.confirmTitle, html`
      <h1>${s.confirmTitle}</h1><p>${s.confirmHint}</p>
      <div class="card"><dl>
        <dt>${s.agent}</dt><dd>${code.agent_name} <span class="meta mono">${code.agent_id.slice(0, 8)}</span></dd>
        <dt>${s.body}</dt><dd>${code.body} <span class="meta">${s.kind[code.kind] ?? code.kind}${code.version ? ` · ${code.version}` : ""}</span></dd>
        <dt>${s.key}</dt><dd class="mono">${fingerprint(code.node_key)}</dd>
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
    const codeText = normalizeUserCode(String(form.code ?? ""));
    const code = codeText ? db.codeByUser(codeText) : undefined;
    if (!code) return deviceForm(c, "", s.badCode);
    const approve = form.approve === "1";
    const d = decide(db, cfg, code, user.id, approve);
    if (!d.ok) return page(c, s.confirmTitle, html`<p class="note err">${s.errors[d.error]}</p>`, 409);
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
      <p class="meta">GitHub · ${user.login}</p>
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
