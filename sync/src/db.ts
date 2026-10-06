// 存储：node:sqlite（内置）。只存账户、agent、身体登记与短期的会话 / 设备码；不存 IP、不存端点、不存任何业务内容。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { now, sha256 } from "./util.ts";

export interface User { id: number; github_id: number; login: string; name: string; created: number; last_login: number }
/** agent 登记按账户隔离：(账户, agent id) 唯一。agent id 不是秘密，若全局唯一，别人知道了就能抢先占住。id 是内部行号。 */
export interface Agent { id: number; user_id: number; agent_id: string; name: string; created: number; soul_repo: string }
export interface Body { agent: number; body: string; kind: string; node_key: string; version: string; created: number; last_seen: number }
/** 会话：网页登录（Cookie）或控制台登录（运行基座代 App 持有的 Bearer 令牌；label 为发起它的身体，agent 为那具身体所属 agent 的内部编号，
 *  1.0.1 建的旧行为 null）。id 是令牌的 SHA-256。created 用来限制绝对寿命（MAX_SESSION_DAYS），不随续期改变。 */
export interface Session { id: string; user_id: number; expires: number; kind: "web" | "console"; label: string; agent: number | null; created: number; last_used: number }
export interface DeviceCode {
  id: string; user_code: string; agent_id: string; agent_name: string; body: string; kind: string; node_key: string; version: string;
  created: number; expires: number; last_poll: number; status: "pending" | "approved" | "denied"; user_id: number | null;
  /** 1.1：身体申请时登记的部署公钥（ssh-ed25519，可为空）；批准后链接灵魂仓库的进展（'' | pending | done | failed）、仓库与失败原因。
   *  agent_id 为空表示身体还不知道自己属于哪个 agent（新装的灵魂桥），由批准的人选。 */
  soul_key: string; soul_status: "" | "pending" | "done" | "failed"; soul_repo: string; soul_error: string;
  /** 链接票据的 SHA-256：批准时发给批准者（网页或 App），凭它走 /soul/link，不依赖浏览器里的登录会话。 */
  soul_ticket: string;
}

/** 会话无论怎么续期，自创建起最长有效天数。 */
export const MAX_SESSION_DAYS = 90;
const DAY = 86_400_000;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL, last_login INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, name TEXT NOT NULL,
  created INTEGER NOT NULL, UNIQUE (user_id, agent_id));
CREATE TABLE IF NOT EXISTS bodies (
  agent INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE, body TEXT NOT NULL, kind TEXT NOT NULL, node_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, version TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (agent, body));
CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, body TEXT NOT NULL,
  kind TEXT NOT NULL, node_key TEXT NOT NULL, version TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
  last_poll INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
`;

export type Db = ReturnType<typeof openDb>;

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = dataDir === ":memory:" ? ":memory:" : path.join(dataDir, "sync.db");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // 1.0.1：会话区分网页与控制台（账户页列出控制台登录、可吊销）
  const cols = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("kind")) db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'web';
    ALTER TABLE sessions ADD COLUMN label TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;`);
  // 1.0.2：控制台登录记下身体所属的 agent（解绑时一并作废）；旧行没有创建时间的，从升级这一刻起算绝对寿命
  if (!cols.has("agent")) db.exec("ALTER TABLE sessions ADD COLUMN agent INTEGER");
  // 1.1：身体申请时带上部署公钥，批准后经 GitHub App 链接灵魂仓库；agent 记下它的灵魂仓库
  const codeCols = new Set((db.prepare("PRAGMA table_info(device_codes)").all() as { name: string }[]).map((c) => c.name));
  if (!codeCols.has("soul_key")) db.exec(`ALTER TABLE device_codes ADD COLUMN soul_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE device_codes ADD COLUMN soul_status TEXT NOT NULL DEFAULT '';
    ALTER TABLE device_codes ADD COLUMN soul_repo TEXT NOT NULL DEFAULT '';
    ALTER TABLE device_codes ADD COLUMN soul_error TEXT NOT NULL DEFAULT '';
    ALTER TABLE device_codes ADD COLUMN soul_ticket TEXT NOT NULL DEFAULT '';`);
  const agentCols = new Set((db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name));
  if (!agentCols.has("soul_repo")) db.exec("ALTER TABLE agents ADD COLUMN soul_repo TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE sessions SET created = ? WHERE created = 0").run(now());
  const q = <T>(sql: string) => { const s = db.prepare(sql); return { get: (...a: any[]) => s.get(...a) as T | undefined, all: (...a: any[]) => s.all(...a) as T[], run: (...a: any[]) => s.run(...a) }; };

  const s = {
    upsertUser: q<User>(`INSERT INTO users (github_id, login, name, created, last_login) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name, last_login = excluded.last_login RETURNING *`),
    user: q<User>("SELECT * FROM users WHERE id = ?"),
    deleteUser: q("DELETE FROM users WHERE id = ?"),
    insertSession: q("INSERT INTO sessions (id, user_id, expires, kind, label, agent, created, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    session: q<Session>("SELECT * FROM sessions WHERE id = ?"),
    touchSession: q("UPDATE sessions SET expires = ? WHERE id = ?"),
    usedSession: q("UPDATE sessions SET last_used = ? WHERE id = ?"),
    consolesOf: q<Session>("SELECT * FROM sessions WHERE user_id = ? AND kind = 'console' AND expires > ? ORDER BY created"),
    revokeConsole: q("DELETE FROM sessions WHERE user_id = ? AND kind = 'console' AND substr(id, 1, 16) = ?"),
    deleteSession: q("DELETE FROM sessions WHERE id = ?"),
    revokeWebSessions: q("DELETE FROM sessions WHERE user_id = ? AND kind = 'web'"),
    // 解绑身体 / 删除 agent 时作废从它发起的控制台登录；1.0.1 的旧行没有 agent，按账户与身体名匹配（宁可多作废）
    dropConsolesOfBody: q("DELETE FROM sessions WHERE kind = 'console' AND label = ? AND (agent = ? OR (agent IS NULL AND user_id = ?))"),
    dropConsolesOfAgent: q(`DELETE FROM sessions WHERE kind = 'console' AND (agent = ? OR (agent IS NULL AND user_id = ?
      AND label IN (SELECT body FROM bodies WHERE agent = ?)))`),
    legacyConsoleAlive: q<{ n: number }>("SELECT count(*) AS n FROM bodies JOIN agents ON agents.id = bodies.agent WHERE agents.user_id = ? AND bodies.body = ?"),
    agent: q<Agent>("SELECT * FROM agents WHERE id = ?"),
    agentOf: q<Agent>("SELECT * FROM agents WHERE user_id = ? AND agent_id = ?"),
    agentsOf: q<Agent>("SELECT * FROM agents WHERE user_id = ? ORDER BY created"),
    insertAgent: q<Agent>("INSERT INTO agents (user_id, agent_id, name, created) VALUES (?, ?, ?, ?) RETURNING *"),
    renameAgent: q("UPDATE agents SET name = ? WHERE id = ?"),
    deleteAgent: q("DELETE FROM agents WHERE id = ? AND user_id = ?"),
    countAgents: q<{ n: number }>("SELECT count(*) AS n FROM agents WHERE user_id = ?"),
    bodiesOf: q<Body>("SELECT agent, body, kind, node_key, version, created, last_seen FROM bodies WHERE agent = ? ORDER BY body"),
    body: q<Body>("SELECT agent, body, kind, node_key, version, created, last_seen FROM bodies WHERE agent = ? AND body = ?"),
    bodyByToken: q<Body>("SELECT agent, body, kind, node_key, version, created, last_seen FROM bodies WHERE token_hash = ?"),
    countBodies: q<{ n: number }>("SELECT count(*) AS n FROM bodies WHERE agent = ?"),
    upsertBody: q(`INSERT INTO bodies (agent, body, kind, node_key, token_hash, version, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, body) DO UPDATE SET kind = excluded.kind, node_key = excluded.node_key, token_hash = excluded.token_hash,
      version = excluded.version, created = excluded.created, last_seen = excluded.last_seen`),
    seenBody: q("UPDATE bodies SET last_seen = ?, version = ? WHERE agent = ? AND body = ?"),
    deleteBody: q("DELETE FROM bodies WHERE agent = ? AND body = ?"),
    insertCode: q(`INSERT INTO device_codes (id, user_code, agent_id, agent_name, body, kind, node_key, version, created, expires, soul_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    codeAgent: q("UPDATE device_codes SET agent_id = ?, agent_name = ? WHERE id = ? AND status = 'pending'"),
    codeSoul: q("UPDATE device_codes SET soul_status = ?, soul_repo = ?, soul_error = ?, expires = max(expires, ?) WHERE id = ?"),
    agentSoulRepo: q("UPDATE agents SET soul_repo = ? WHERE id = ?"),
    codeTicket: q("UPDATE device_codes SET soul_ticket = ? WHERE id = ?"),
    codeByTicket: q<DeviceCode>("SELECT * FROM device_codes WHERE soul_ticket = ? AND soul_ticket != ''"),
    codeById: q<DeviceCode>("SELECT * FROM device_codes WHERE id = ?"),
    codeByUser: q<DeviceCode>("SELECT * FROM device_codes WHERE user_code = ?"),
    pollCode: q("UPDATE device_codes SET last_poll = ? WHERE id = ?"),
    decideCode: q("UPDATE device_codes SET status = ?, user_id = ? WHERE id = ? AND status = 'pending'"),
    deleteCode: q("DELETE FROM device_codes WHERE id = ?"),
    purge: { sessions: q("DELETE FROM sessions WHERE expires < ? OR created < ?"), codes: q("DELETE FROM device_codes WHERE expires < ?") },
  };

  let depth = 0;
  const tx = <T>(f: () => T): T => {
    if (depth) return f(); // 已在事务里：并入外层事务
    db.exec("BEGIN IMMEDIATE"); depth++;
    try { const r = f(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } finally { depth--; }
  };
  const dropConsolesOfBody = (agent: number, body: string) => {
    const a = s.agent.get(agent);
    if (a) s.dropConsolesOfBody.run(body, agent, a.user_id);
  };

  return {
    raw: db,
    close: () => db.close(),
    upsertUser: (githubId: number, login: string, name: string) => s.upsertUser.get(githubId, login, name, now(), now())!,
    user: (id: number) => s.user.get(id),
    deleteUser: (id: number) => s.deleteUser.run(id),

    /** 会话：库里只存令牌的 SHA-256。 */
    createSession: (token: string, userId: number, expires: number, kind: Session["kind"] = "web", label = "", agent: number | null = null) =>
      s.insertSession.run(sha256(token), userId, Math.min(expires, now() + MAX_SESSION_DAYS * DAY), kind, label, agent, now(), now()),
    session: (token: string) => s.session.get(sha256(token)),
    touchSession: (token: string, expires: number) => s.touchSession.run(expires, sha256(token)),
    deleteSession: (token: string) => s.deleteSession.run(sha256(token)),
    usedSession: (token: string) => s.usedSession.run(now(), sha256(token)),
    /** 作废这个账户的全部网页会话（「在所有设备上退出」）；控制台登录不受影响。返回作废的个数。 */
    revokeWebSessions: (userId: number) => Number(s.revokeWebSessions.run(userId).changes),
    /** 控制台登录发起它的那具身体是否还在（解绑后会话一并作废；这里再兜一层）。 */
    consoleBodyAlive: (x: Session) => x.agent !== null ? !!s.body.get(x.agent, x.label) : s.legacyConsoleAlive.get(x.user_id, x.label)!.n > 0,
    /** 控制台登录：对外只露出哈希的前 16 位作为编号（用来吊销），不是令牌本身。 */
    consolesOf: (userId: number) => s.consolesOf.all(userId, now()),
    revokeConsole: (userId: number, handle: string) => Number(s.revokeConsole.run(userId, handle).changes) > 0,

    agent: (id: number) => s.agent.get(id),
    agentOf: (userId: number, agentId: string) => s.agentOf.get(userId, agentId),
    agentsOf: (userId: number) => s.agentsOf.all(userId),
    countAgents: (userId: number) => s.countAgents.get(userId)!.n,
    insertAgent: (userId: number, agentId: string, name: string) => s.insertAgent.get(userId, agentId, name, now())!,
    renameAgent: (id: number, name: string) => s.renameAgent.run(name, id),
    /** 删除 agent（级联删除身体），并作废从它的身体发起的控制台登录。 */
    deleteAgent: (id: number, userId: number) => tx(() => {
      if (s.agent.get(id)?.user_id !== userId) return false;
      s.dropConsolesOfAgent.run(id, userId, id);
      return Number(s.deleteAgent.run(id, userId).changes) > 0;
    }),

    bodiesOf: (agent: number) => s.bodiesOf.all(agent),
    body: (agent: number, body: string) => s.body.get(agent, body),
    bodyByToken: (token: string) => s.bodyByToken.get(sha256(token)),
    countBodies: (agent: number) => s.countBodies.get(agent)!.n,
    /** 绑定（或重新绑定）一具身体：新令牌立即生效，旧令牌与从旧绑定发起的控制台登录随之失效。 */
    putBody: (b: Omit<Body, "created" | "last_seen">, token: string) => tx(() => {
      dropConsolesOfBody(b.agent, b.body);
      s.upsertBody.run(b.agent, b.body, b.kind, b.node_key, sha256(token), b.version, now(), now());
    }),
    seenBody: (agent: number, body: string, version: string) => s.seenBody.run(now(), version, agent, body),
    /** 解绑一具身体，并作废从它发起的控制台登录。 */
    deleteBody: (agent: number, body: string) => tx(() => {
      if (!s.body.get(agent, body)) return false;
      dropConsolesOfBody(agent, body);
      return Number(s.deleteBody.run(agent, body).changes) > 0;
    }),

    /** 设备码：库里只存设备码的 SHA-256；短码要给人看，明文存，有效期 15 分钟。 */
    insertCode: (deviceCode: string, user: string, c: Pick<DeviceCode, "agent_id" | "agent_name" | "body" | "kind" | "node_key" | "version"> & { soul_key?: string }, expires: number) =>
      s.insertCode.run(sha256(deviceCode), user, c.agent_id, c.agent_name, c.body, c.kind, c.node_key, c.version, now(), expires, c.soul_key ?? ""),
    /** 还没指定 agent 的码（新装的灵魂桥）：批准时由人选定。 */
    setCodeAgent: (id: string, agentId: string, name: string) => s.codeAgent.run(agentId, name, id),
    /** 链接灵魂仓库的进展；进行中时把码的有效期延到至少 extendTo（人在 GitHub 上授权、安装要一点时间）。 */
    setCodeSoul: (id: string, status: DeviceCode["soul_status"], repo = "", error = "", extendTo = 0) => s.codeSoul.run(status, repo, error.slice(0, 300), extendTo, id),
    setAgentSoulRepo: (id: number, repo: string) => s.agentSoulRepo.run(repo, id),
    setCodeTicket: (id: string, ticket: string) => s.codeTicket.run(sha256(ticket), id),
    codeByTicket: (ticket: string) => s.codeByTicket.get(sha256(ticket)),
    codeByDevice: (deviceCode: string) => s.codeById.get(sha256(deviceCode)),
    codeByUser: (user: string) => s.codeByUser.get(user),
    pollCode: (id: string) => s.pollCode.run(now(), id),
    decideCode: (id: string, status: "approved" | "denied", userId: number) => Number(s.decideCode.run(status, userId, id).changes) > 0,
    deleteCode: (id: string) => s.deleteCode.run(id),
    purge: () => { s.purge.sessions.run(now(), now() - MAX_SESSION_DAYS * DAY); s.purge.codes.run(now()); },
    /** 把一组操作放进一个事务（嵌套时并入外层）。 */
    tx,
  };
}
