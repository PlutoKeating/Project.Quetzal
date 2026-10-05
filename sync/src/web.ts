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
import type { DeviceCode } from "./db.ts";
import { check, decide } from "./device.ts";
import { fingerprint } from "./util.ts";

/** 按短码找待批准的码：先看次数限制，找不到（含已过期）计入输错次数。由 app.ts 提供（它持有限流器与客户端地址）。 */
export type FindCode = (c: Context, userId: number, input: unknown) => { code: DeviceCode } | { error: "too_many" | "bad_code" };

const json = <T extends z.ZodType>(schema: T) => async (c: Context): Promise<z.infer<T> | undefined> => {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  return r.success ? r.data : undefined;
};
const CodeBody = json(z.object({ code: z.string().max(20) }));
const DecideBody = json(z.object({ code: z.string().max(20), approve: z.boolean() }));
const BodyRef = json(z.object({ agent: z.string().max(64), body: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) }));
const AgentRef = json(z.object({ agent: z.string().max(64) }));
const Empty = json(z.object({}));
const Confirm = json(z.object({ confirm: z.literal(true) }));
const ConsoleRef = json(z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }));

export function installWebApi(app: Hono, deps: { db: Db; cfg: Config; hub: Hub; sessions: Sessions; findCode: FindCode; loginEnabled: boolean }) {
  const { db, cfg, hub, sessions, findCode } = deps;
  const origins = new Set([cfg.publicUrl, ...(cfg.webUrl ? [cfg.webUrl] : [])]);

  // hono 的 cors 给所有响应（含下面早退的 403 / 415 与 401）加 Vary: Origin：响应随 Origin 不同，缓存不能混用
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

  /** 绑定码 → 待批准的身体（给人核对：agent、身体、类型、版本、公钥指纹）。输错（含过期）有次数限制，账户与地址各计。
   *  控制台登录（kind 为 console）给的是发起它的那具已绑定身体的指纹与绑定时间。 */
  app.post("/v1/web/device/lookup", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const f = findCode(c, u.id, (await CodeBody(c))?.code);
    if ("error" in f) return c.json({ error: f.error }, f.error === "too_many" ? 429 : 404);
    const code = f.code;
    const d = check(db, cfg, code, u.id);
    if (!d.ok) return c.json({ error: d.error }, d.error === "bad_code" ? 404 : 409);
    const fp = fingerprint(d.body?.node_key ?? code.node_key);
    return c.json({
      code: code.user_code, agent: { id: code.agent_id, name: code.agent_name },
      body: code.body, kind: code.kind, version: code.version, fingerprint: fp,
      replaces: d.replaces, newAgent: d.newAgent, createdAt: code.created, expires: code.expires,
      ...(d.body ? { bodyFingerprint: fp, bodyBoundAt: d.body.created } : {}),
    });
  });

  app.post("/v1/web/device/decide", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    const p = await DecideBody(c);
    if (!p) return c.json({ error: "bad_request" }, 400);
    const f = findCode(c, u.id, p.code);
    if ("error" in f) return c.json({ error: f.error }, f.error === "too_many" ? 429 : 404);
    const d = decide(db, cfg, f.code, u.id, p.approve);
    if (!d.ok) return c.json({ error: d.error }, d.error === "bad_code" ? 404 : 409);
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

  /** 在所有设备上退出网页登录：作废这个账户的全部网页会话（包括这一个）；控制台登录不受影响（在上面逐个吊销）。 */
  app.post("/v1/web/sessions/revoke-all", async (c) => {
    const u = user(c);
    if (!u) return unauthorized(c);
    if (!(await Empty(c))) return c.json({ error: "bad_request" }, 400);
    const revoked = db.revokeWebSessions(u.id);
    if (!sessions.consoleHandle(c)) sessions.destroy(c); // 网页自己的 Cookie 一并清掉
    return c.json({ ok: true, revoked });
  });

  app.post("/v1/web/logout", (c) => { sessions.destroy(c); return c.json({ ok: true }); });
}
