// 身体绑定：OAuth 2.0 设备授权（RFC 8628）的语义。身体（没有浏览器、可能没有键盘）申请一对码，
// 人在浏览器里登录后输入短码、核对 agent / 身体 / 节点公钥指纹并批准，身体轮询拿到只属于它自己的令牌。
import { z } from "zod";
import type { Db, DeviceCode } from "./db.ts";
import type { Config } from "./config.ts";
import { now, randomToken, userCode } from "./util.ts";

export const CODE_TTL_S = 900;
export const POLL_INTERVAL_S = 5;

export const DeviceRequest = z.object({
  agent: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) }),
  body: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  kind: z.enum(["runtime", "bridge"]),
  nodeKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // ed25519 公钥：32 字节的 base64url
  version: z.string().max(32).default(""),
});
export type DeviceRequest = z.infer<typeof DeviceRequest>;

export function createCode(db: Db, cfg: Config, req: DeviceRequest) {
  const deviceCode = randomToken("qdc_");
  let code = userCode();
  for (let i = 0; db.codeByUser(code) && i < 5; i++) code = userCode();
  db.insertCode(deviceCode, code, { agent_id: req.agent.id.toLowerCase(), agent_name: req.agent.name, body: req.body, kind: req.kind, node_key: req.nodeKey, version: req.version }, now() + CODE_TTL_S * 1000);
  return {
    device_code: deviceCode, user_code: code,
    verification_uri: `${cfg.publicUrl}/device`,
    verification_uri_complete: `${cfg.publicUrl}/device?code=${code}`,
    expires_in: CODE_TTL_S, interval: POLL_INTERVAL_S,
  };
}

export type Decision = { ok: true; replaces: boolean; newAgent: boolean } | { ok: false; error: "expired" | "decided" | "too_many_agents" | "too_many_bodies" };

/** 批准前的检查（确认页上提前告诉人会发生什么）。 */
export function check(db: Db, cfg: Config, code: DeviceCode, userId: number): Decision {
  if (code.expires < now()) return { ok: false, error: "expired" };
  if (code.status !== "pending") return { ok: false, error: "decided" };
  const agent = db.agentOf(userId, code.agent_id);
  if (!agent && db.countAgents(userId) >= cfg.maxAgents) return { ok: false, error: "too_many_agents" };
  const existing = agent ? db.body(agent.id, code.body) : undefined;
  if (agent && !existing && db.countBodies(agent.id) >= cfg.maxBodies) return { ok: false, error: "too_many_bodies" };
  return { ok: true, replaces: !!existing, newAgent: !agent };
}

export function decide(db: Db, cfg: Config, code: DeviceCode, userId: number, approve: boolean): Decision {
  return db.tx(() => {
    const d = check(db, cfg, code, userId);
    if (!d.ok) return d;
    if (approve && d.newAgent) db.insertAgent(userId, code.agent_id, code.agent_name);
    db.decideCode(code.id, approve ? "approved" : "denied", userId);
    return d;
  });
}

export type PollResult =
  | { status: 200; body: { access_token: string; token_type: "bearer"; agent: { id: string; name: string }; body: string; account: string } }
  | { status: 400; body: { error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" } };

/** 身体轮询。批准后在这一刻生成令牌并写入身体登记（库里只存哈希），设备码随即作废。onBound 用来踢掉同名身体的旧连接。 */
export function poll(db: Db, deviceCode: string, onBound: (agent: number, body: string) => void): PollResult {
  const code = db.codeByDevice(deviceCode);
  if (!code) return { status: 400, body: { error: "invalid_grant" } };
  if (code.expires < now()) { db.deleteCode(code.id); return { status: 400, body: { error: "expired_token" } }; }
  if (code.status === "denied") { db.deleteCode(code.id); return { status: 400, body: { error: "access_denied" } }; }
  if (code.status === "pending") {
    const tooFast = now() - code.last_poll < (POLL_INTERVAL_S - 1) * 1000;
    db.pollCode(code.id);
    return { status: 400, body: { error: tooFast ? "slow_down" : "authorization_pending" } };
  }
  const token = randomToken("qsb_");
  const agent = db.tx(() => {
    const a = code.user_id === null ? undefined : db.agentOf(code.user_id, code.agent_id);
    if (!a) return undefined; // 批准之后 agent 被删除（或账户被删）
    db.putBody({ agent: a.id, body: code.body, kind: code.kind, node_key: code.node_key, version: code.version }, token);
    db.deleteCode(code.id);
    return a;
  });
  if (!agent) { db.deleteCode(code.id); return { status: 400, body: { error: "access_denied" } }; }
  onBound(agent.id, code.body);
  return { status: 200, body: { access_token: token, token_type: "bearer", agent: { id: agent.agent_id, name: agent.name }, body: code.body, account: db.user(agent.user_id)?.login ?? "" } };
}
