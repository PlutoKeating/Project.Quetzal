// TURN 凭据：coturn 的 use-auth-secret 机制（TURN REST API 草案，draft-uberti-behave-turn-rest）。
// 用户名 = "<到期 Unix 秒>:<标识>"，密码 = base64(HMAC-SHA1(共享密钥, 用户名))。coturn 用同一个密钥校验，凭据到期自动失效，服务端不需要存任何东西。
import crypto from "node:crypto";

export interface IceServer { urls: string[]; username?: string; credential?: string }

export function turnCredential(secret: string, id: string, ttlSeconds: number, nowMs = Date.now()) {
  const username = `${Math.floor(nowMs / 1000) + ttlSeconds}:${id}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

/** 给一具身体的 ICE 服务器列表：STUN 总是有；配置了 TURN 才附带有时效的凭据。 */
export function iceServers(cfg: { stun: string[]; turn?: { secret: string; urls: string[]; ttl: number } }, id: string): { iceServers: IceServer[]; ttl: number } {
  const list: IceServer[] = [{ urls: cfg.stun }];
  if (cfg.turn) list.push({ urls: cfg.turn.urls, ...turnCredential(cfg.turn.secret, id, cfg.turn.ttl) });
  return { iceServers: list, ttl: cfg.turn?.ttl ?? 0 };
}
