// 存储：node:sqlite（内置）。只存账户、agent、身体登记与短期的会话 / 设备码；不存 IP、不存端点、不存任何业务内容。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { now, sha256 } from "./util.ts";

export interface User { id: number; github_id: number; login: string; name: string; created: number; last_login: number }
/** agent 登记按账户隔离：(账户, agent id) 唯一。agent id 不是秘密，若全局唯一，别人知道了就能抢先占住。id 是内部行号。 */
export interface Agent { id: number; user_id: number; agent_id: string; name: string; created: number }
export interface Body { agent: number; body: string; kind: string; node_key: string; version: string; created: number; last_seen: number }
export interface DeviceCode {
  id: string; user_code: string; agent_id: string; agent_name: string; body: string; kind: string; node_key: string; version: string;
  created: number; expires: number; last_poll: number; status: "pending" | "approved" | "denied"; user_id: number | null;
}

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
  const q = <T>(sql: string) => { const s = db.prepare(sql); return { get: (...a: any[]) => s.get(...a) as T | undefined, all: (...a: any[]) => s.all(...a) as T[], run: (...a: any[]) => s.run(...a) }; };

  const s = {
    upsertUser: q<User>(`INSERT INTO users (github_id, login, name, created, last_login) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name, last_login = excluded.last_login RETURNING *`),
    user: q<User>("SELECT * FROM users WHERE id = ?"),
    deleteUser: q("DELETE FROM users WHERE id = ?"),
    insertSession: q("INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)"),
    session: q<{ id: string; user_id: number; expires: number }>("SELECT * FROM sessions WHERE id = ?"),
    touchSession: q("UPDATE sessions SET expires = ? WHERE id = ?"),
    deleteSession: q("DELETE FROM sessions WHERE id = ?"),
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
    insertCode: q(`INSERT INTO device_codes (id, user_code, agent_id, agent_name, body, kind, node_key, version, created, expires)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    codeById: q<DeviceCode>("SELECT * FROM device_codes WHERE id = ?"),
    codeByUser: q<DeviceCode>("SELECT * FROM device_codes WHERE user_code = ?"),
    pollCode: q("UPDATE device_codes SET last_poll = ? WHERE id = ?"),
    decideCode: q("UPDATE device_codes SET status = ?, user_id = ? WHERE id = ? AND status = 'pending'"),
    deleteCode: q("DELETE FROM device_codes WHERE id = ?"),
    purge: { sessions: q("DELETE FROM sessions WHERE expires < ?"), codes: q("DELETE FROM device_codes WHERE expires < ?") },
  };

  return {
    raw: db,
    close: () => db.close(),
    upsertUser: (githubId: number, login: string, name: string) => s.upsertUser.get(githubId, login, name, now(), now())!,
    user: (id: number) => s.user.get(id),
    deleteUser: (id: number) => s.deleteUser.run(id),

    /** 会话：库里只存令牌的 SHA-256。 */
    createSession: (token: string, userId: number, expires: number) => s.insertSession.run(sha256(token), userId, expires),
    session: (token: string) => s.session.get(sha256(token)),
    touchSession: (token: string, expires: number) => s.touchSession.run(expires, sha256(token)),
    deleteSession: (token: string) => s.deleteSession.run(sha256(token)),

    agent: (id: number) => s.agent.get(id),
    agentOf: (userId: number, agentId: string) => s.agentOf.get(userId, agentId),
    agentsOf: (userId: number) => s.agentsOf.all(userId),
    countAgents: (userId: number) => s.countAgents.get(userId)!.n,
    insertAgent: (userId: number, agentId: string, name: string) => s.insertAgent.get(userId, agentId, name, now())!,
    renameAgent: (id: number, name: string) => s.renameAgent.run(name, id),
    deleteAgent: (id: number, userId: number) => Number(s.deleteAgent.run(id, userId).changes) > 0,

    bodiesOf: (agent: number) => s.bodiesOf.all(agent),
    body: (agent: number, body: string) => s.body.get(agent, body),
    bodyByToken: (token: string) => s.bodyByToken.get(sha256(token)),
    countBodies: (agent: number) => s.countBodies.get(agent)!.n,
    /** 绑定（或重新绑定）一具身体：新令牌立即生效，旧令牌随之失效。 */
    putBody: (b: Omit<Body, "created" | "last_seen">, token: string) =>
      s.upsertBody.run(b.agent, b.body, b.kind, b.node_key, sha256(token), b.version, now(), now()),
    seenBody: (agent: number, body: string, version: string) => s.seenBody.run(now(), version, agent, body),
    deleteBody: (agent: number, body: string) => Number(s.deleteBody.run(agent, body).changes) > 0,

    /** 设备码：库里只存设备码的 SHA-256；短码要给人看，明文存，有效期 15 分钟。 */
    insertCode: (deviceCode: string, user: string, c: Pick<DeviceCode, "agent_id" | "agent_name" | "body" | "kind" | "node_key" | "version">, expires: number) =>
      s.insertCode.run(sha256(deviceCode), user, c.agent_id, c.agent_name, c.body, c.kind, c.node_key, c.version, now(), expires),
    codeByDevice: (deviceCode: string) => s.codeById.get(sha256(deviceCode)),
    codeByUser: (user: string) => s.codeByUser.get(user),
    pollCode: (id: string) => s.pollCode.run(now(), id),
    decideCode: (id: string, status: "approved" | "denied", userId: number) => Number(s.decideCode.run(status, userId, id).changes) > 0,
    deleteCode: (id: string) => s.deleteCode.run(id),
    purge: () => { s.purge.sessions.run(now()); s.purge.codes.run(now()); },
    /** 把一组操作放进一个事务。 */
    tx<T>(f: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try { const r = f(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
