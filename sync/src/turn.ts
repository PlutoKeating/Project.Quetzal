// TURN 凭据：coturn 的 use-auth-secret 机制（TURN REST API 草案，draft-uberti-behave-turn-rest）。
// 用户名 = "<到期 Unix 秒>:<标识>"，密码 = base64(HMAC-SHA1(共享密钥, 用户名))。coturn 用同一个密钥校验，凭据到期自动失效，服务端不需要存任何东西。
// 标识是每具身体固定的不透明值（由共享密钥派生的 HMAC，见 turnUser）：coturn 的 user-quota 按它计数（coturn 会去掉用户名里的时间戳部分），
// 别的账户用同一个 agent id 与身体名也撞不到你的配额；中转服务器上也看不出是哪个 agent、哪具身体。
import crypto from "node:crypto";

export interface IceServer { urls: string[]; username?: string; credential?: string }
type TurnCfg = { stun: string[]; turn?: { secret: string; urls: string[]; ttl: number } };

/** 一具身体的 TURN 用户标识：HMAC-SHA256(共享密钥, 上下文 + 身体的内部键) 的前 22 个 base64url 字符（132 位）。 */
export const turnUser = (secret: string, key: string) =>
  crypto.createHmac("sha256", secret).update(`quetzal-turn-user\0${key}`).digest("base64url").slice(0, 22);

export function turnCredential(secret: string, id: string, ttlSeconds: number, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expires}:${id}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expires: expires * 1000 };
}

/** 给一具身体的 ICE 服务器列表：STUN 总是有；配置了 TURN 才附带有时效的凭据。expires 为凭据到期的毫秒时间（没有 TURN 时为 0）。 */
export function iceServers(cfg: TurnCfg, id: string, nowMs = Date.now()): { iceServers: IceServer[]; ttl: number; expires: number } {
  const list: IceServer[] = [{ urls: cfg.stun }];
  if (!cfg.turn) return { iceServers: list, ttl: 0, expires: 0 };
  const { username, credential, expires } = turnCredential(cfg.turn.secret, id, cfg.turn.ttl, nowMs);
  list.push({ urls: cfg.turn.urls, username, credential });
  return { iceServers: list, ttl: cfg.turn.ttl, expires };
}
