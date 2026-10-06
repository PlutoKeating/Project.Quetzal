// 身体绑定：OAuth 2.0 设备授权（RFC 8628）的语义。身体（没有浏览器、可能没有键盘）申请一对码，
// 人在浏览器里登录后输入短码、核对 agent / 身体 / 节点公钥指纹并批准，身体轮询拿到只属于它自己的令牌。
// 同一套码也用于「控制台登录」（kind 为 console）：已绑定的身体代它的控制台（App）申请，人批准后拿到一个能管理整个账户的会话令牌。
// 只有绑定在批准者账户下的身体才能申请，所以别人骗你批准也拿不到你的账户。
import { z } from "zod";
import type { Db, DeviceCode, Body } from "./db.ts";
import type { Config } from "./config.ts";
import crypto from "node:crypto";
import { now, randomToken, userCode, checkWords } from "./util.ts";

export const CODE_TTL_S = 900;
export const POLL_INTERVAL_S = 5;
export const CONSOLE_SESSION_DAYS = 30;

/** 部署公钥：只收 ssh-ed25519（32 字节公钥的 SSH 编码固定 68 个 base64 字符），去掉注释。 */
const SoulKey = z.string().max(400).transform((k) => k.trim().split(/\s+/).slice(0, 2).join(" ")).pipe(z.string().regex(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/));

export const DeviceRequest = z.object({
  // id 可以不给：新装的灵魂桥还读不到灵魂仓库，不知道自己属于哪个 agent，由批准的人在网页上选（或新建）
  agent: z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(80) }),
  body: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  kind: z.enum(["runtime", "bridge"]),
  nodeKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // ed25519 公钥：32 字节的 base64url
  version: z.string().max(32).default(""),
  soulKey: SoulKey.optional(), // 这具身体的部署公钥：批准后经 GitHub App 加到灵魂仓库（只加这一把）
});
export type DeviceRequest = z.infer<typeof DeviceRequest>;

export function createCode(db: Db, cfg: Config, req: DeviceRequest) {
  const deviceCode = randomToken("qdc_");
  let code = userCode();
  for (let i = 0; db.codeByUser(code) && i < 5; i++) code = userCode();
  db.insertCode(deviceCode, code, { agent_id: (req.agent.id ?? "").toLowerCase(), agent_name: req.agent.name, body: req.body, kind: req.kind, node_key: req.nodeKey, version: req.version, soul_key: req.soulKey ?? "" }, now() + CODE_TTL_S * 1000);
  return {
    device_code: deviceCode, user_code: code,
    verification_uri: `${cfg.webUrl ?? cfg.publicUrl}/device`,
    verification_uri_complete: `${cfg.webUrl ?? cfg.publicUrl}/device?code=${code}`,
    expires_in: CODE_TTL_S, interval: POLL_INTERVAL_S,
    // 核对词：身体在发给人的消息里一起给出，批准页上显示同样的词，人一眼比对（防别人发来的钓鱼链接）
    check: checkWords(db.codeByDevice(deviceCode)!.id),
  };
}

/** 过期与不存在对外是同一个错误（bad_code），不让人借此探测码是否存在过。console 的 body 是发起控制台登录的那具已绑定的身体（给人核对它的指纹与绑定时间）。
 *  choose：身体没说自己属于哪个 agent，要人选（或新建）。 */
export type Decision = { ok: true; replaces: boolean; newAgent: boolean; body?: Body; choose?: boolean } | { ok: false; error: "bad_code" | "decided" | "too_many_agents" | "too_many_bodies" | "not_yours" | "bad_agent" };

/** 控制台登录：由一具已绑定的运行基座（Bearer 身体令牌）代它的控制台申请。码里记下这具身体、它的 agent 与它的节点公钥。 */
export function createConsoleCode(db: Db, cfg: Config, body: Body, version: string) {
  const agent = db.agent(body.agent)!;
  return createCode(db, cfg, { agent: { id: agent.agent_id, name: agent.name }, body: body.body, kind: "console", nodeKey: body.node_key, version } as unknown as DeviceRequest);
}

/** 控制台登录的码仍然指向发起它的那次绑定：身体还在、是运行基座、公钥没变、码是在这次绑定之后申请的（重新绑定过就作废）。 */
function consoleBody(db: Db, code: DeviceCode, agentId: number | undefined) {
  const b = agentId === undefined ? undefined : db.body(agentId, code.body);
  return b && b.kind === "runtime" && b.node_key === code.node_key && b.created <= code.created ? b : undefined;
}

/** 批准前的检查（确认页上提前告诉人会发生什么）。 */
export function check(db: Db, cfg: Config, code: DeviceCode, userId: number): Decision {
  if (code.expires < now()) return { ok: false, error: "bad_code" };
  if (code.status !== "pending") return { ok: false, error: "decided" };
  if (!code.agent_id) return { ok: true, replaces: false, newAgent: db.agentsOf(userId).length === 0, choose: true };
  const agent = db.agentOf(userId, code.agent_id);
  if (code.kind === "console") { const b = consoleBody(db, code, agent?.id); return b ? { ok: true, replaces: false, newAgent: false, body: b } : { ok: false, error: "not_yours" }; }
  if (!agent && db.countAgents(userId) >= cfg.maxAgents) return { ok: false, error: "too_many_agents" };
  const existing = agent ? db.body(agent.id, code.body) : undefined;
  if (agent && !existing && db.countBodies(agent.id) >= cfg.maxBodies) return { ok: false, error: "too_many_bodies" };
  return { ok: true, replaces: !!existing, newAgent: !agent };
}

/** 批准或拒绝。agent：身体没说属于哪个 agent 时，人选的 agent id（或 "new" 新建）。soulLinkable：同步服务配置了 GitHub App——
 *  码里登记了部署公钥时，批准后进入「链接灵魂仓库」（人在同一个标签页经 GitHub 跳一次），身体要等它完成才拿到令牌。 */
export function decide(db: Db, cfg: Config, code: DeviceCode, userId: number, approve: boolean, o: { agent?: string; soulLinkable?: boolean } = {}): Decision {
  return db.tx(() => {
    if (approve && !code.agent_id) {
      const pick = o.agent && o.agent !== "new" ? db.agentOf(userId, o.agent.toLowerCase()) : undefined;
      if (o.agent && o.agent !== "new" && !pick) return { ok: false, error: "bad_agent" } as Decision;
      if (!pick && !o.agent && db.agentsOf(userId).length > 0) return { ok: false, error: "bad_agent" } as Decision; // 账户里已有 agent：必须明确选一个或选新建
      const id = pick?.agent_id ?? crypto.randomUUID();
      db.setCodeAgent(code.id, id, pick?.name ?? code.agent_name);
      code = { ...code, agent_id: id, agent_name: pick?.name ?? code.agent_name };
    }
    const d = check(db, cfg, code, userId);
    if (!d.ok) return d;
    if (approve && d.newAgent) db.insertAgent(userId, code.agent_id, code.agent_name);
    db.decideCode(code.id, approve ? "approved" : "denied", userId);
    if (approve && code.soul_key && o.soulLinkable) db.setCodeSoul(code.id, "pending", "", "", now() + CODE_TTL_S * 1000);
    return d;
  });
}

export type PollResult =
  | { status: 200; body: { access_token: string; token_type: "bearer"; agent: { id: string; name: string }; body: string; account: string; kind?: "console"; expires_in?: number; soul?: { repo: string; remote: string } | { error: string } } }
  | { status: 400; body: { error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" } };

/** 身体轮询。批准后在这一刻生成令牌并写入身体登记（库里只存哈希），设备码随即作废。onBound 用来踢掉同名身体的旧连接。 */
export function poll(db: Db, deviceCode: string, onBound: (agent: number, body: string) => void): PollResult {
  const code = db.codeByDevice(deviceCode);
  if (!code) return { status: 400, body: { error: "invalid_grant" } };
  if (code.expires < now()) { db.deleteCode(code.id); return { status: 400, body: { error: "expired_token" } }; }
  if (code.status === "denied") { db.deleteCode(code.id); return { status: 400, body: { error: "access_denied" } }; }
  if (code.status === "pending" || (code.status === "approved" && code.soul_status === "pending")) { // 批准了但灵魂仓库还在链接：继续等
    const tooFast = now() - code.last_poll < (POLL_INTERVAL_S - 1) * 1000;
    db.pollCode(code.id);
    return { status: 400, body: { error: tooFast ? "slow_down" : "authorization_pending" } };
  }
  if (code.kind === "console") return pollConsole(db, code);
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
  const soul = code.soul_status === "done" ? { repo: code.soul_repo, remote: `git@github.com:${code.soul_repo}.git` }
    : code.soul_status === "failed" ? { error: code.soul_error || "没能链接灵魂仓库" } : undefined;
  return { status: 200, body: { access_token: token, token_type: "bearer", agent: { id: agent.agent_id, name: agent.name }, body: code.body, account: db.user(agent.user_id)?.login ?? "", ...(soul ? { soul } : {}) } };
}

/** 控制台登录批准后：生成会话令牌（qsc_，库里只存哈希，按 CONSOLE_SESSION_DAYS 滑动续期），记下发起它的身体与 agent（解绑时一并作废），设备码作废。 */
function pollConsole(db: Db, code: DeviceCode): PollResult {
  db.deleteCode(code.id);
  const agent = code.user_id === null ? undefined : db.agentOf(code.user_id, code.agent_id);
  if (!agent || !consoleBody(db, code, agent.id)) return { status: 400, body: { error: "access_denied" } };
  const token = randomToken("qsc_");
  const life = CONSOLE_SESSION_DAYS * 86_400_000;
  db.createSession(token, agent.user_id, now() + life, "console", code.body, agent.id);
  return { status: 200, body: { access_token: token, token_type: "bearer", agent: { id: agent.agent_id, name: agent.name }, body: code.body, account: db.user(agent.user_id)?.login ?? "", kind: "console", expires_in: life / 1000 } };
}
