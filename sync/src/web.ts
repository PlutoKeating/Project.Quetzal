// 给网页前端（SYNC_WEB_URL，例如官网）用的 JSON 接口：/v1/web/*。
// 前端与同步服务是两个源但同一个站点（同一个可注册域名），会话仍是同步服务自己的 __Host- Cookie（HttpOnly、SameSite=Lax），
// 前端用 fetch(credentials: "include") 调用。防护：
//   - CORS 只对 SYNC_WEB_URL 与同步服务自己的源放行带凭据的请求，其他源读不到任何响应；
//   - 改动类请求（POST）必须带 Origin 且是上面两个源之一，并且是 application/json（跨源时一定先预检）；
//   - 只返回这个账户自己的数据，agent 与身体都按账户核对归属。
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { Sessions } from "./auth.ts";
import { check, decide } from "./device.ts";
import { normalizeUserCode, fingerprint, type RateLimiter } from "./util.ts";

const json = <T extends z.ZodType>(schema: T) => async (c: Context): Promise<z.infer<T> | undefined> => {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  return r.success ? r.data : undefined;
};
const CodeBody = json(z.object({ code: z.string().max(20) }));
const DecideBody = json(z.object({ code: z.string().max(20), approve: z.boolean() }));
const BodyRef = json(z.object({ agent: z.string().max(64), body: z.string().max(40) }));
const AgentRef = json(z.object({ agent: z.string().max(64) }));
const Confirm = json(z.object({ confirm: z.literal(true) }));
const ConsoleRef = json(z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }));

export function installWebApi(app: Hono, deps: { db: Db; cfg: Config; hub: Hub; sessions: Sessions; lookupLimit: RateLimiter; loginEnabled: boolean }) {
  const { db, cfg, hub, sessions, lookupLimit } = deps;
  const origins = new Set([cfg.publicUrl, ...(cfg.webUrl ? [cfg.webUrl] : [])]);

  app.use("/v1/web/*", cors({
    origin: (o) => (origins.has(o) ? o : null),
    credentials: true, allowMethods: ["GET", "POST"], allowHeaders: ["Content-Type"], maxAge: 600,
  }));
  app.use("/v1/web/*", async (c, next) => {
    if (c.req.method === "POST" && !sessions.consoleHandle(c)) { // 控制台的 Bearer 令牌不会被浏览器自动带上，没有 CSRF 问题
      const o = c.req.header("origin");
      if (!o || !origins.has(o)) return c.json({ error: "forbidden_origin" }, 403);
      if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "json_required" }, 415);
    }
    c.header("Cache-Control", "no-store");
    return next();
  });

  const user = (c: Context) => sessions.user(c, true);
  const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401);
  const agentOf = (userId: number, agentId: string) => db.agentsOf(userId).find((a) => a.agent_id === agentId);

  /** 登录状态：前端据此显示「用 GitHub 登录」或账户。 */
  app.get("/v1/web/session", (c) => {
    const u = user(c);
    return c.json({ loginEnabled: deps.loginEnabled, user: u ? { login: u.login, name: u.name } : null });
  });

  /** 账户：agent 与各自的身体（不含令牌，公钥只给指纹）。 */
  app.get("/v1/web/account", (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    return c.json({
      user: { login: u.login, name: u.name },
      limits: { agents: cfg.maxAgents, bodies: cfg.maxBodies },
      agents: db.agentsOf(u.id).map((a) => ({
        id: a.agent_id, name: a.name, created: a.created,
        bodies: db.bodiesOf(a.id).map((b) => ({
          body: b.body, kind: b.kind, version: b.version, created: b.created, lastSeen: b.last_seen,
          online: hub.online(a.id, b.body), fingerprint: fingerprint(b.node_key),
        })),
      })),
      // 控制台登录（各身体上的 App 经运行基座管理账户）：编号是令牌哈希的前 16 位，用来吊销
      consoles: db.consolesOf(u.id).map((x) => ({ id: x.id.slice(0, 16), body: x.label, created: x.created, lastUsed: x.last_used, current: x.id.slice(0, 16) === sessions.consoleHandle(c) })),
    });
  });

  /** 绑定码 → 待批准的身体（给人核对：agent、身体、类型、版本、公钥指纹）。输错有次数限制。 */
  app.post("/v1/web/device/lookup", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const p = await CodeBody(c);
    const text = p ? normalizeUserCode(p.code) : undefined;
    const code = text ? db.codeByUser(text) : undefined;
    if (!code || code.expires < Date.now()) {
      if (!lookupLimit.take(`u${u.id}`)) return c.json({ error: "too_many" }, 429);
      return c.json({ error: "bad_code" }, 404);
    }
    const d = check(db, cfg, code, u.id);
    if (!d.ok) return c.json({ error: d.error }, 409);
    return c.json({
      code: code.user_code, agent: { id: code.agent_id, name: code.agent_name },
      body: code.body, kind: code.kind, version: code.version, fingerprint: fingerprint(code.node_key),
      replaces: d.replaces, newAgent: d.newAgent, expires: code.expires,
    });
  });

  app.post("/v1/web/device/decide", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const p = await DecideBody(c);
    const text = p ? normalizeUserCode(p.code) : undefined;
    const code = text ? db.codeByUser(text) : undefined;
    if (!p || !code) return c.json({ error: "bad_code" }, 404);
    const d = decide(db, cfg, code, u.id, p.approve);
    if (!d.ok) return c.json({ error: d.error }, 409);
    return c.json({ ok: true, approved: p.approve });
  });

  app.post("/v1/web/bodies/remove", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const p = await BodyRef(c);
    const a = p ? agentOf(u.id, p.agent) : undefined;
    if (!p || !a || !db.deleteBody(a.id, p.body)) return c.json({ error: "not_found" }, 404);
    hub.kick(a.id, p.body);
    return c.json({ ok: true });
  });

  app.post("/v1/web/agents/remove", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const p = await AgentRef(c);
    const a = p ? agentOf(u.id, p.agent) : undefined;
    if (!a || !db.deleteAgent(a.id, u.id)) return c.json({ error: "not_found" }, 404);
    hub.kick(a.id);
    return c.json({ ok: true });
  });

  app.post("/v1/web/account/delete", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    if (!(await Confirm(c))) return c.json({ error: "confirm_required" }, 400);
    const agents = db.agentsOf(u.id);
    sessions.destroy(c);
    db.deleteUser(u.id); // 外键级联：会话、agent、身体、设备码一起删
    for (const a of agents) hub.kick(a.id);
    return c.json({ ok: true });
  });

  app.post("/v1/web/consoles/revoke", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const p = await ConsoleRef(c);
    if (!p || !db.revokeConsole(u.id, p.id)) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/web/logout", (c) => { sessions.destroy(c); return c.json({ ok: true }); });
}
